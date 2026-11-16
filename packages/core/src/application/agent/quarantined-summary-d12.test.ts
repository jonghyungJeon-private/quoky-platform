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

// ADR-0121 D12 (amended, ratified 2026-11-16): M2 routes through the existing ProviderSelector / AiProvider. Core derives the
// allowed localities (labels, a valid grant, the asked-for count) and passes them as `allowedExecutionLocalities`; candidates
// are capability ∩ owner policy ∩ locality ∩ workText; an unmet or unverifiable constraint is listing-only; policy and
// locality are re-checked immediately before dispatch; a sent request is never re-sent. Adversarial cases below.

const RUN = newSummaryRunToken();
const doc = (position: number): AgentSourceDocument => ({ id: `m${position}`, position, title: `t${position}`, author: 'a', date: '', body: `body ${position}` });
const mail = (grant: SummaryEgressGrant | undefined, ...documents: AgentSourceDocument[]): AgentSummarySource => ({ entryId: 'mail.list', documents, ...(grant !== undefined ? { grant } : {}) });
const GRANT = (): SummaryEgressGrant => mintSummaryEgressGrantForTest(1, 'mail.list', RUN);
const ANSWER = '{"items":[{"n":1,"summary":"A short summary."}]}';

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
    expect(deriveM2Localities({ egress: 'HOST_ONLY', needsGrant: false, granted: false, askedItems: 1 })).toEqual({ ok: false, reason: 'host-only' });
    // HOST_ONLY gets no model even with a grant and a local provider in sight (P3-3b #5).
    expect(deriveM2Localities({ egress: 'HOST_ONLY', needsGrant: true, granted: true, askedItems: 1 })).toEqual({ ok: false, reason: 'host-only' });
    expect(deriveM2Localities({ egress: 'LOCAL_MODEL_ONLY', needsGrant: false, granted: false, askedItems: 5 })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: false, askedItems: 1 })).toEqual({ ok: false, reason: 'no-summary-grant' });
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: true, askedItems: 1 })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: true, askedItems: 2 })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ egress: 'REMOTE_OK', needsGrant: false, granted: false, askedItems: 3 })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
  });

  it('a grant-needing input without its grant is listing-only even when the joined label is stricter (no local fallback, P3-3b #4)', () => {
    expect(deriveM2Localities({ egress: 'LOCAL_MODEL_ONLY', needsGrant: true, granted: false, askedItems: 1 })).toEqual({ ok: false, reason: 'no-summary-grant' });
  });

  it('an unverifiable input admits nothing: an unknown label, a count that is not a positive integer, a RoSR label with no grant need', () => {
    expect(deriveM2Localities({ egress: 'SOMETHING' as never, needsGrant: false, granted: false, askedItems: 1 })).toEqual({ ok: false, reason: 'no-model' });
    for (const askedItems of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveM2Localities({ egress: 'REMOTE_OK', needsGrant: false, granted: false, askedItems }), String(askedItems)).toEqual({ ok: false, reason: 'no-model' });
    }
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: false, granted: true, askedItems: 1 })).toEqual({ ok: false, reason: 'no-summary-grant' });
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
  it('one granted item: the selector gets SUMMARIZATION with LOCAL and REMOTE; a batch gets LOCAL only', async () => {
    const local = spy('p-local', 'LOCAL', 1);
    const one = recording(local);
    await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: one.selector, selectionContext: { sessionId: 's', actorId: 'a' } } });
    expect(one.selects).toEqual([{ sessionId: 's', actorId: 'a', allowedExecutionLocalities: ['LOCAL', 'REMOTE'] }]);
    const batch = recording(local);
    await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], route: { selector: batch.selector } });
    expect(batch.selects).toEqual([{ allowedExecutionLocalities: ['LOCAL'] }]);
    // The dispatch re-check runs on the SAME constrained context.
    expect(batch.checks).toEqual(batch.selects);
  });

  it('a selector that ignores the constraint (answers REMOTE for a batch) is not trusted: listing-only, no call', async () => {
    const remote = spy('p-remote', 'REMOTE', 1);
    const undeclared = spy('p-undeclared', undefined, 1);
    for (const answer of [remote, undeclared]) {
      const { selector } = recording(answer);
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], route: { selector } })).toEqual({ kind: 'listing-only', reason: 'no-model' });
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
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: recording(remote) });
    expect(outcome).toMatchObject({ kind: 'summary', audit: { locality: 'REMOTE', auditId: 'p-remote' } });
    expect(Object.keys(remote.requests[0] as AiRequest).sort()).toEqual(['capability', 'prompt']);
    expect((remote.requests[0] as AiRequest).capability).toBe(Capability.SUMMARIZATION);
  });
});

describe('D12: the mandatory dispatch-time re-check', () => {
  it('a policy flip between selection and dispatch (real router): no call, no reservation, a closed reason', async () => {
    let eligible = ['p-local'];
    const policy: ProviderSelectionPolicy = {
      preferenceFor: async (): Promise<ProviderPreference> => ({ eligible: [...eligible], order: 'listed' }),
      isEligible: (_capability, _context, key) => eligible.includes(key),
    };
    // The owner switches the summary model off while the selector awaits readiness (after the policy answered).
    const local: Spy = { ...spy('p-local', 'LOCAL', 1), isAvailable: async () => ((eligible = []), true) };
    const router = new CapabilityRouter(new AiProviderManager([local]), policy);
    const reserved: number[] = [];
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: router }, reserve: (tokens) => (reserved.push(tokens), true) });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'dispatch-refused' });
    expect(local.requests).toHaveLength(0);
    expect(reserved).toEqual([]);
  });

  it('a check that throws or answers anything but true is a refusal', async () => {
    for (const answer of [() => false, () => 'yes' as unknown as boolean, (): boolean => { throw new Error('x'); }]) {
      const local = spy('p-local', 'LOCAL', 1);
      const { selector } = recording(local, answer);
      expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector } })).toEqual({ kind: 'listing-only', reason: 'dispatch-refused' });
      expect(local.requests).toHaveLength(0);
    }
  });

  it('a locality that leaves the allowed set at dispatch (real router, batch on LOCAL): no call', async () => {
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
    const router = new CapabilityRouter(new AiProviderManager([flipping]));
    const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1), doc(2))], route: { selector: router } });
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
      const router = new CapabilityRouter(new AiProviderManager([first, second]));
      let selects = 0;
      const counting: ProviderSelector = {
        select: (capability, context) => ((selects += 1), router.select(capability, context)),
        isStillEligible: (capability, context, provider) => router.isStillEligible(capability, context as ProviderSelectionContext, provider),
      };
      const outcome = await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: counting } });
      expect(outcome).toMatchObject({ kind: 'failed', reason: 'model', audit: { auditId: 'p-first', locality: 'LOCAL' } });
      expect([first.requests.length, second.requests.length, selects]).toEqual([1, 0, 1]);
    }
  });

  it('a schema failure after send is not retried either', async () => {
    const first = spy('p-first', 'REMOTE', 90, async () => ({ text: 'not json' }));
    const second = spy('p-second', 'LOCAL', 10);
    const router = new CapabilityRouter(new AiProviderManager([first, second]));
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: router } })).toMatchObject({ kind: 'failed', reason: 'schema' });
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
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: router } })).toMatchObject({ audit: { auditId: 'p-vendor' } });
    // With workText the vendor is out by policy even though REMOTE is allowed: the local one serves.
    expect(await quarantinedSummarize({ ...base, sources: [mail(GRANT(), doc(1))], route: { selector: router, selectionContext: { workText: true } } })).toMatchObject({ audit: { auditId: 'p-local' } });
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
