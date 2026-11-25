import { describe, expect, it } from 'vitest';
import { AiFailureKind, Capability } from '../../domain';
import { AiProviderError } from '../../errors';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderPreference, ProviderSelectionContext, ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import {
  deriveM2Localities,
  m2SelectionContext,
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  quarantinedSummarize,
  type AgentSourceDocument,
  type AgentSummarySource,
  type SummaryEgressGrant,
} from './quarantined-summary';
import { consentTokenFor } from './summary-consent.test-support';

// Rule ① (CS-1a): a REMOTE call needs a real consent token (a bound consent from a store, minted by `mintSummaryConsentToken`); the rule itself is tested in summary-consent.cs1a.test.ts.

// ADR-0121 D12 (amended, ratified 2026-11-16): M2 routes through the existing ProviderSelector / AiProvider. Core derives the
// allowed localities (labels, a valid grant, the asked-for count) and passes them as `allowedExecutionLocalities`; candidates
// are capability ∩ owner policy ∩ locality ∩ workText; an unmet or unverifiable constraint is listing-only; policy and
// locality are re-checked immediately before dispatch; a sent request is never re-sent. Adversarial cases below.

const RUN = newSummaryRunToken();
const doc = (position: number): AgentSourceDocument => ({ id: `m${position}`, position, title: `t${position}`, author: 'a', date: '', body: `body ${position}` });
const mail = (grant: SummaryEgressGrant | undefined, ...documents: AgentSourceDocument[]): AgentSummarySource => ({ entryId: 'mail.list', documents, ...(grant !== undefined ? { grant } : {}) });
const SCOPE = { run: RUN, step: 1, covered: [{ entryId: 'mail.list' as const, itemIds: ['m1'] }] };
const CONSENT = consentTokenFor(RUN, 1, { recipient: 'Test', reads: [{ entryId: 'mail.list', itemIds: ['m1', 'm2'] }] });
/** Every REMOTE dispatch here names its recipient ('Test') and carries the real token above. */
const TEST_RECIPIENT = { recipientLabel: (): string => 'Test' };
const GRANT = (): SummaryEgressGrant => mintSummaryEgressGrantForTest(1, 'mail.list', RUN);
const ANSWER = '{"items":[{"n":1,"summary":"A short summary."}]}';
/** An owner policy that prefers nothing and answers explicitly at dispatch (D12 needs an explicit verdict). */
const PERMISSIVE: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };

interface Spy extends AiProvider {
  readonly requests: AiRequest[];
}
function spy(id: string, locality: AiExecutionLocality | undefined, priority: number, execute?: (request: AiRequest) => Promise<{ text: string }>): Spy {
  const requests: AiRequest[] = [];
  return {
    id,
    requests,
    ...(locality !== undefined ? { executionLocality: locality } : {}),
    capabilities: [{ capability: Capability.SUMMARIZATION, priority }],
    isAvailable: async () => true,
    execute: async (request) => {
      requests.push(request);
      return execute !== undefined ? execute(request) : { text: ANSWER };
    },
  };
}

/** A selector that records every call and answers `provider`. */
function recording(provider: AiProvider, eligible: () => boolean = () => true) {
  const selects: ProviderSelectionContext[] = [];
  const checks: ProviderSelectionContext[] = [];
  const selector: ProviderSelector = {
    select: async (_capability, context) => (selects.push(context ?? {}), provider),
    isStillEligible: (_capability, context) => (checks.push(context), eligible()),
  };
  return { selector, selects, checks };
}

const base = { schema: 'digest.v1' as const, summaryStep: 1, reserve: (): boolean => true, run: RUN };

describe('D12: the derived localities (pure)', () => {
  it('derives from the label, the grant and the asked-for count', () => {
    expect(deriveM2Localities({ egress: 'HOST_ONLY', needsGrant: false, granted: false, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'host-only' });
    // HOST_ONLY gets no model even with a grant and a local provider in sight (P3-3b #5).
    expect(deriveM2Localities({ egress: 'HOST_ONLY', needsGrant: true, granted: true, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'host-only' });
    expect(deriveM2Localities({ egress: 'LOCAL_MODEL_ONLY', needsGrant: false, granted: false, askedItems: 5, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: false, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-summary-grant' });
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: true, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
    // A granted batch may go REMOTE too (owner 2026-11-03 answer 3, built 2026-11-16; supersedes the single-item rule).
    for (const askedItems of [2, 10, 20]) {
      expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: true, askedItems, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
      expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: false, askedItems, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-summary-grant' });
      expect(deriveM2Localities({ egress: 'HOST_ONLY', needsGrant: true, granted: true, askedItems, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'host-only' });
      expect(deriveM2Localities({ egress: 'LOCAL_MODEL_ONLY', needsGrant: false, granted: false, askedItems, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL'] });
    }
    expect(deriveM2Localities({ egress: 'REMOTE_OK', needsGrant: false, granted: false, askedItems: 3, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
  });

  it('a grant-needing input without its grant is listing-only even when the joined label is stricter (no local fallback, P3-3b #4)', () => {
    expect(deriveM2Localities({ egress: 'LOCAL_MODEL_ONLY', needsGrant: true, granted: false, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-summary-grant' });
  });

  it('an unverifiable input admits nothing: an unknown label, a count that is not a positive integer, a RoSR label with no grant need', () => {
    expect(deriveM2Localities({ egress: 'SOMETHING' as never, needsGrant: false, granted: false, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-model' });
    for (const askedItems of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveM2Localities({ egress: 'REMOTE_OK', needsGrant: false, granted: false, askedItems, consent: CONSENT, consentScope: SCOPE }), String(askedItems)).toEqual({ ok: false, reason: 'no-model' });
    }
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: false, granted: true, askedItems: 1, consent: CONSENT, consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-summary-grant' });
  });

  it('the selection context keeps the base, narrows by a base constraint, and keeps or sets workText', () => {
    const plain = m2SelectionContext({ sessionId: 's1', actorId: 'a1' }, ['LOCAL', 'REMOTE'], ['mail.list']);
    expect(plain).toEqual({ sessionId: 's1', actorId: 'a1', allowedExecutionLocalities: ['LOCAL', 'REMOTE'] });
    expect(Object.isFrozen(plain)).toBe(true);
    // A caller's constraint can only narrow Core's, never widen it.
    expect(m2SelectionContext({ allowedExecutionLocalities: ['REMOTE'] }, ['LOCAL'], ['mail.list']).allowedExecutionLocalities).toEqual([]);
    expect(m2SelectionContext({ allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }, ['LOCAL'], ['mail.list']).allowedExecutionLocalities).toEqual(['LOCAL']);
    expect(m2SelectionContext({ requiredLocality: 'LOCAL' }, ['LOCAL', 'REMOTE'], ['mail.list'])).toMatchObject({ requiredLocality: 'LOCAL' });
    expect(m2SelectionContext({ workText: true }, ['LOCAL'], ['mail.list']).workText).toBe(true);
    expect(m2SelectionContext(undefined, ['LOCAL'], ['jira.issues']).workText).toBe(true);
    expect(m2SelectionContext(undefined, ['LOCAL'], ['mail.list', 'drive.files']).workText).toBeUndefined();
    // An unreadable base context is unverifiable: nothing is allowed.
    const unreadable = { get sessionId(): string { throw new Error('x'); } } as ProviderSelectionContext;
    expect(m2SelectionContext(unreadable, ['LOCAL', 'REMOTE'], ['mail.list'])).toEqual({ allowedExecutionLocalities: [] });
  });
});

describe('D12: forged and absent grants never reach the selector', () => {
  it('absent, forged, other-step, other-source and other-run grants: no selection, no call', async () => {
    const local = spy('p-local', 'LOCAL', 1);
    const forged = [
      undefined,
      {} as unknown as SummaryEgressGrant,
      Object.freeze({}) as unknown as SummaryEgressGrant,
      mintSummaryEgressGrantForTest(2, 'mail.list', RUN),
      mintSummaryEgressGrantForTest(1, 'drive.files', RUN),
      mintSummaryEgressGrantForTest(1, 'mail.list', newSummaryRunToken()),
    ];
    for (const grant of forged) {
      const { selector, selects } = recording(local);
      expect(await quarantinedSummarize({ ...base, sources: [mail(grant, doc(1))], route: { selector } })).toEqual({ kind: 'listing-only', reason: 'no-summary-grant' });
      expect(selects).toHaveLength(0);
    }
    expect(local.requests).toHaveLength(0);
  });
});

describe('D12: the selector is asked under the derived constraint, and its answer is re-read', () => {
  it('one granted item and a granted batch: the selector gets SUMMARIZATION with LOCAL and REMOTE', async () => {
    const local = spy('p-local', 'LOCAL', 1);
    const one = recording(local);
    await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], consent: CONSENT, route: { selector: one.selector, ...TEST_RECIPIENT, selectionContext: { sessionId: 's', actorId: 'a' } } });
    expect(one.selects).toEqual([{ sessionId: 's', actorId: 'a', allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }]);
    const batch = recording(local);
    await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], consent: CONSENT, route: { selector: batch.selector, ...TEST_RECIPIENT } });
    expect(batch.selects).toEqual([{ allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }]);
    // The selection-time verdict and both dispatch re-checks (before the reservation, and right before execute) run on the
    // SAME constrained context.
    expect(batch.checks).toHaveLength(3);
    for (const check of batch.checks) expect(check).toEqual(batch.selects[0]);
  });

  it('a selector that ignores the constraint (answers REMOTE under a caller\'s LOCAL-only set) is not trusted: listing-only, no call', async () => {
    const remote = spy('p-remote', 'REMOTE', 1);
    const undeclared = spy('p-undeclared', undefined, 1);
    for (const answer of [remote, undeclared]) {
      const { selector } = recording(answer);
      const route = { selector, selectionContext: { allowedExecutionLocalities: ['LOCAL' as const] } };
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], route })).toEqual({ kind: 'listing-only', reason: 'no-model' });
      expect(answer.requests).toHaveLength(0);
    }
  });

  it('a selector that cannot re-check at dispatch is unverifiable: listing-only, never selected or called', async () => {
    const local = spy('p-local', 'LOCAL', 1);
    let selects = 0;
    const selector: ProviderSelector = { select: async () => (selects += 1, local) };
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector } })).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect([selects, local.requests.length]).toEqual([0, 0]);
  });

  it('a provider that does not advertise SUMMARIZATION, a throwing selector, or no provider at all: listing-only', async () => {
    const chatOnly: AiProvider = { ...spy('p-chat', 'LOCAL', 1), capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }] };
    const throwing: ProviderSelector = { select: async () => Promise.reject(new Error('none')), isStillEligible: () => true };
    const nullish: ProviderSelector = { select: async () => null as unknown as AiProvider, isStillEligible: () => true };
    for (const selector of [recording(chatOnly).selector, throwing, nullish]) {
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector } })).toEqual({ kind: 'listing-only', reason: 'no-model' });
    }
  });

  it('the request is sealed and the audit names the provider id with its snapshot locality', async () => {
    const remote = spy('p-remote', 'REMOTE', 1);
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], consent: CONSENT, route: { ...recording(remote), ...TEST_RECIPIENT } });
    expect(outcome).toMatchObject({ kind: 'summary', audits: [{ locality: 'REMOTE', auditId: 'p-remote' }] });
    expect(Object.keys(remote.requests[0] as AiRequest).sort()).toEqual(['capability', 'prompt']);
    expect((remote.requests[0] as AiRequest).capability).toBe(Capability.SUMMARIZATION);
  });
});

describe('D12: the mandatory dispatch-time re-check', () => {
  it('a policy flip between selection and dispatch (real router): no call, no reservation, a closed reason', async () => {
    let eligible = ['p-local'];
    const policy: ProviderSelectionPolicy = {
      preferenceFor: async (): Promise<ProviderPreference> => ({ eligible: [...eligible], order: 'listed' }),
      // The owner switches the summary model off right after the selection-time verdict.
      isEligible: (_capability, _context, key) => {
        const verdict = eligible.includes(key);
        eligible = [];
        return verdict;
      },
    };
    const local = spy('p-local', 'LOCAL', 1);
    const router = new CapabilityRouter(new AiProviderManager([local]), policy);
    const reserved: number[] = [];
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: router }, reserve: (tokens) => (reserved.push(tokens), true) });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'dispatch-refused' });
    expect(local.requests).toHaveLength(0);
    expect(reserved).toEqual([]);
  });

  it('a check that throws or answers anything but true is a refusal', async () => {
    for (const answer of [() => false, () => 'yes' as unknown as boolean, (): boolean => { throw new Error('x'); }]) {
      // At selection the verdict refuses: no-model (no body would be fetched). After a passing selection verdict: dispatch-refused.
      const local = spy('p-local', 'LOCAL', 1);
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: recording(local, answer).selector } })).toEqual({ kind: 'listing-only', reason: 'no-model' });
      let calls = 0;
      const { selector } = recording(local, () => ((calls += 1) === 1 ? true : answer()));
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector } })).toEqual({ kind: 'listing-only', reason: 'dispatch-refused' });
      expect(local.requests).toHaveLength(0);
    }
  });

  it('a locality that leaves the allowed set at dispatch (real router, a caller\'s LOCAL-only set): no call', async () => {
    let flipped = false;
    const requests: AiRequest[] = [];
    const flipping: AiProvider = {
      id: 'p-flip',
      get executionLocality(): AiExecutionLocality {
        return flipped ? 'REMOTE' : 'LOCAL';
      },
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
      // The adapter's declaration changes after readiness answered (as if its model were re-pointed to a cloud tag).
      isAvailable: async () => {
        queueMicrotask(() => (flipped = true));
        return true;
      },
      execute: async (request) => (requests.push(request), { text: ANSWER }),
    };
    const router = new CapabilityRouter(new AiProviderManager([flipping]), PERMISSIVE);
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], route: { selector: router, selectionContext: { allowedExecutionLocalities: ['LOCAL'] } } });
    expect(outcome.kind).toBe('listing-only');
    expect(['dispatch-refused', 'no-model']).toContain((outcome as { reason: string }).reason);
    expect(requests).toHaveLength(0);
  });
});

describe('D12: a sent request is never re-sent', () => {
  it('a provider failure after send is the closed model failure; the next eligible provider is never called and nothing is re-selected', async () => {
    for (const failure of [new Error('boom'), new AiProviderError(AiFailureKind.UNAVAILABLE, 'down')]) {
      const first = spy('p-first', 'LOCAL', 90, () => Promise.reject(failure));
      const second = spy('p-second', 'LOCAL', 10);
      const router = new CapabilityRouter(new AiProviderManager([first, second]), PERMISSIVE);
      let selects = 0;
      const counting: ProviderSelector = {
        select: (capability, context) => ((selects += 1), router.select(capability, context)),
        isStillEligible: (capability, context, provider) => router.isStillEligible(capability, context as ProviderSelectionContext, provider),
      };
      const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: counting } });
      expect(outcome).toMatchObject({ kind: 'failed', reason: 'model', audits: [{ auditId: 'p-first', locality: 'LOCAL' }] });
      expect([first.requests.length, second.requests.length, selects]).toEqual([1, 0, 1]);
    }
  });

  it('a schema failure after send is not retried either', async () => {
    const first = spy('p-first', 'REMOTE', 90, async () => ({ text: 'not json' }));
    const second = spy('p-second', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([first, second]), PERMISSIVE);
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], consent: CONSENT, route: { selector: router, ...TEST_RECIPIENT } })).toMatchObject({ kind: 'failed', reason: 'schema' });
    expect([first.requests.length, second.requests.length]).toEqual([1, 0]);
  });
});

describe('D12: workText interplay', () => {
  it('the policy sees the base workText and the derived localities; its exclusion holds with the locality filter', async () => {
    const seen: ProviderSelectionContext[] = [];
    // A policy's work-text rule (as the composition root's): with workText the vendor key is not eligible.
    const policy: ProviderSelectionPolicy = {
      preferenceFor: async (_capability, context): Promise<ProviderPreference> => {
        seen.push(context);
        return { eligible: context.workText === true ? ['p-local'] : ['p-vendor', 'p-local'], order: 'listed' };
      },
      isEligible: (_capability, context, key) => (context.workText === true ? key === 'p-local' : true),
    };
    const vendor = spy('p-vendor', 'REMOTE', 90);
    const local = spy('p-local', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([vendor, local]), policy);

    // Without workText, one granted item may go to the remote vendor (the owner's listed first choice).
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], consent: CONSENT, route: { selector: router, ...TEST_RECIPIENT } })).toMatchObject({ audits: [{ auditId: 'p-vendor' }] });
    // With workText the vendor is out by policy even though REMOTE is allowed: the local one serves.
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], consent: CONSENT, route: { selector: router, ...TEST_RECIPIENT, selectionContext: { workText: true } } })).toMatchObject({ audits: [{ auditId: 'p-local' }] });
    expect(seen.at(-1)).toEqual({ workText: true, allowedExecutionLocalities: ['LOCAL', 'REMOTE'] });

    // workText and a LOCAL-only constraint with no local provider registered: nothing is eligible, listing-only, no call.
    const vendorOnly = spy('p-vendor', 'REMOTE', 90);
    const lonely = new CapabilityRouter(new AiProviderManager([vendorOnly]), policy);
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: lonely, selectionContext: { workText: true } } })).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(vendorOnly.requests).toHaveLength(0);
  });

  it('Jira and Slack work text still stops before selection (controls not built)', async () => {
    const local = spy('p-local', 'LOCAL', 1);
    const { selector, selects } = recording(local);
    const outcome = await quarantinedSummarize({ ...base, sources: [{ entryId: 'jira.issues', documents: [doc(1)] }], route: { selector } });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'work-text-controls-not-built' });
    expect([selects.length, local.requests.length]).toEqual([0, 0]);
  });
});

describe('D12 review round 1 (Chief Architect and Codex)', () => {
  it('CA-1: a base requiredLocality LOCAL is honoured when the answer is re-read: a selector answering REMOTE is no-model', async () => {
    const remote = spy('p-remote', 'REMOTE', 1);
    const { selector, selects } = recording(remote);
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector, selectionContext: { requiredLocality: 'LOCAL' } } });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(selects[0]).toMatchObject({ requiredLocality: 'LOCAL', allowedExecutionLocalities: ['LOCAL'] });
    expect(remote.requests).toHaveLength(0);
  });

  it('Codex-5: a malformed caller list is rejected whole, never sanitised to its known members', async () => {
    expect(m2SelectionContext({ allowedExecutionLocalities: ['REMOTE', 'CLOUD'] as never }, ['LOCAL', 'REMOTE'], ['mail.list']).allowedExecutionLocalities).toEqual([]);
    const remote = spy('p-remote', 'REMOTE', 1);
    const { selector } = recording(remote);
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector, selectionContext: { allowedExecutionLocalities: ['REMOTE', 'CLOUD'] as never } } });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('Codex-6: a router with no explicit policy verdict cannot pass the mandatory re-check: no-model, no body, no call', async () => {
    const noVerdict: ProviderSelectionPolicy = { preferenceFor: async () => null };
    for (const policy of [undefined, noVerdict]) {
      const local = spy('p-local', 'LOCAL', 1);
      const router = new CapabilityRouter(new AiProviderManager([local]), policy);
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: router } })).toEqual({ kind: 'listing-only', reason: 'no-model' });
      expect(local.requests).toHaveLength(0);
      // The legacy answer is unchanged for a request without the D12 field.
      expect(router.isStillEligible(Capability.SUMMARIZATION, {}, local)).toBe(true);
      expect(router.isStillEligible(Capability.SUMMARIZATION, { requiredLocality: 'LOCAL' }, local)).toBe(true);
      expect(router.isStillEligible(Capability.SUMMARIZATION, { allowedExecutionLocalities: ['LOCAL'] }, local)).toBe(false);
    }
  });

  it('review round 2 (Codex P2): a policy verdict that switches the locality while answering true is caught (locality re-read after the verdict)', async () => {
    let remoteNow = false;
    const requests: AiRequest[] = [];
    const flipping: AiProvider = {
      id: 'p-verdict-flip',
      get executionLocality(): AiExecutionLocality {
        return remoteNow ? 'REMOTE' : 'LOCAL';
      },
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
      isAvailable: async () => true,
      execute: async (request) => (requests.push(request), { text: ANSWER }),
    };
    let armed = false;
    const selector: ProviderSelector = {
      select: async () => flipping,
      // Every verdict before the call is honest; the final verdict (after onCallStart, right before execute) switches the
      // adapter to REMOTE and still answers true.
      isStillEligible: () => {
        if (armed) remoteNow = true;
        return true;
      },
    };
    const audits: string[] = [];
    const outcome = await quarantinedSummarize({
      ...base,
      sources: [mail(GRANT(), doc(1), doc(2))],
      route: { selector },
      onCallStart: (audit) => {
        armed = true;
        audits.push(audit()?.locality ?? 'none');
      },
    });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'dispatch-refused' });
    expect(requests).toHaveLength(0);
    expect(audits).not.toContain('REMOTE');
  });

  it('Codex-7: a callback that switches the locality before the call is caught by the final check right before execute', async () => {
    let remoteNow = false;
    const requests: AiRequest[] = [];
    const flipping: AiProvider = {
      id: 'p-flip',
      get executionLocality(): AiExecutionLocality {
        return remoteNow ? 'REMOTE' : 'LOCAL';
      },
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
      isAvailable: async () => true,
      execute: async (request) => (requests.push(request), { text: ANSWER }),
    };
    const { selector } = recording(flipping);
    // The provider was selected LOCAL; the callback switches the adapter to REMOTE after the first check (a changed locality is
    // refused even though a granted batch may go REMOTE: the dispatch must be the selected one).
    for (const hook of ['reserve', 'onCallStart'] as const) {
      remoteNow = false;
      const flip = (): void => void (remoteNow = true);
      const outcome = await quarantinedSummarize({
        ...base,
        sources: [mail(GRANT(), doc(1), doc(2))],
        route: { selector },
        ...(hook === 'reserve' ? { reserve: () => (flip(), true) } : { onCallStart: flip }),
      });
      expect(outcome, hook).toEqual({ kind: 'listing-only', reason: 'dispatch-refused' });
    }
    expect(requests).toHaveLength(0);
    // Unchanged, the call goes out and the audit carries the locality the final check verified.
    remoteNow = false;
    const audits: string[] = [];
    const ok = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], route: { selector }, onCallStart: (audit) => void audits.push(audit()?.locality ?? 'none') });
    expect(ok).toMatchObject({ kind: 'summary', audits: [{ locality: 'LOCAL', auditId: 'p-flip' }] });
    expect(requests).toHaveLength(1);
    expect(audits).toEqual(['LOCAL']);
  });
});

// The A5-S3 work-source stopgap tests that stood here are superseded by the rule-① token guard (CS-1a): see
// `summary-consent.cs1a.test.ts` (every egress label, every source, the dispatch re-check).
