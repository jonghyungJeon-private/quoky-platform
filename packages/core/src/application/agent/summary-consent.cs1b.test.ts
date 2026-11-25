import { describe, expect, it } from 'vitest';
import { Capability, type Actor } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import { ConsentPendingStore } from '../consent-answer/consent-pending';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentRunService, type AgentActiveTurn, type AgentContinuationOutcome } from './agent-run-service';
import type { AgentReadPort, AgentReadRequest } from './plan-executor';
import { AgentPlanExecutor } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { newSummaryRunToken, setSummaryGrantsForTest, type AgentSourceDocument, type QuarantinedSummarizerRoute } from './quarantined-summary';
import { assembleAgentReply } from './reply-assembler';
import { consentTokenFor, yesBound } from './summary-consent.test-support';

// ADR-0121 SR-1 rule ① (confirm slice CS-1b, the continuation): the owner's bound yes re-runs exactly one asked summarize step.
// Every token here is minted by the production continuation from a bound consent the real answer pipeline recorded as a yes.

const PERMISSIVE: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
const T0 = '2026-11-16T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const CHAT = { id: 'claude-family', locality: 'REMOTE' as AiExecutionLocality };
const OWNER_SCOPE = { actorId: 'owner', conversationKey: 'discord|space|dm-1|none' };
const MAIL_SUMMARY_PLAN = JSON.stringify({ steps: [{ entryId: 'mail.list', args: {} }, { summarize: [1], schema: 'digest.v1' }], ambiguity: 'CLEAR' });
const BODY = (id: string): string => `RAW-BODY-CANARY-${id}`;

interface Harness {
  readonly service: AgentRunService;
  readonly store: ConsentPendingStore;
  readonly actors: Map<string, Actor>;
  readonly remoteRequests: AiRequest[];
  readonly localRequests: AiRequest[];
  readonly plannerCalls: { count: number };
  readonly reads: AgentReadRequest[];
  readonly logs: Array<{ event: string; fields?: LogFields }>;
  /** The ids and the bodies the mail listing answers right now (mutable: the drift tests change them between the ask and the yes). */
  readonly listing: { ids: string[]; bodies: Record<string, string> };
  /** The recipient label of the REMOTE provider right now. */
  readonly recipient: { current: string | undefined };
  /** The LOCAL provider is available (it is off while the question is asked, in the tests that need REMOTE first). */
  readonly localOn: { current: boolean };
  readonly onRead: { current: (() => Promise<void>) | undefined };
}

function harness(options: { readonly caps?: { perHour?: number } } = {}): Harness {
  const remoteRequests: AiRequest[] = [];
  const localRequests: AiRequest[] = [];
  const plannerCalls = { count: 0 };
  const reads: AgentReadRequest[] = [];
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const actors = new Map<string, Actor>([['owner', { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 }]]);
  const listing = { ids: ['m1', 'm2', 'm3'], bodies: {} as Record<string, string> };
  const recipient: { current: string | undefined } = { current: 'Claude' };
  const localOn = { current: false };
  const onRead: { current: (() => Promise<void>) | undefined } = { current: undefined };
  const planner: AiProvider = {
    id: 'scripted-planner',
    family: 'claude-family',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    async execute() {
      plannerCalls.count += 1;
      return { text: MAIL_SUMMARY_PLAN, artifacts: [] };
    },
  };
  const answer = (request: AiRequest, sink: AiRequest[]) => {
    sink.push(request);
    // One summary per ITEM the prompt carries (a model that answers for an item it never saw is a schema failure).
    const count = (request.prompt.match(/^ITEM \d+$/gmu) ?? []).length;
    return { text: JSON.stringify({ items: Array.from({ length: count }, (_, index) => ({ n: index + 1, summary: `S ${index + 1}` })) }) };
  };
  const remote: AiProvider = {
    id: 'remote-a',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    executionLocality: 'REMOTE',
    isAvailable: async () => true,
    execute: async (request) => answer(request, remoteRequests),
  };
  const local: AiProvider = {
    id: 'local-a',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 20 }],
    executionLocality: 'LOCAL',
    isAvailable: async () => localOn.current,
    execute: async (request) => answer(request, localRequests),
  };
  const store = new ConsentPendingStore();
  const logger: Logger = { info: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }), warn: () => undefined, error: () => undefined };
  const mail: AgentReadPort = {
    read: async (request) => {
      reads.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      await onRead.current?.();
      const documents = listing.ids.map((id, index) => ({ id, position: index + 1, title: 't', author: 'a', date: '', body: listing.bodies[id] ?? BODY(id) }));
      return { ok: true, items: listing.ids.map((id) => ({ id })), ...(request.withDocuments === true ? { documents } : {}) };
    },
  };
  return {
    service: new AgentRunService({
      mode: 'active',
      router: { select: async () => planner },
      actors: { get: async (id) => actors.get(id) ?? null, save: async (actor) => (actors.set(actor.id, actor), actor) },
      logger,
      timeZone: 'Asia/Seoul',
      timeoutMs: 6_000,
      readers: { 'mail.list': mail },
      summarizer: new CapabilityRouter(new AiProviderManager([remote, local], { uncached: () => true }), PERMISSIVE),
      released: true,
      consentStore: store,
      recipientLabel: (provider) => (provider.id === 'remote-a' ? recipient.current : undefined),
      ...(options.caps !== undefined ? { caps: options.caps } : {}),
    }),
    store,
    actors,
    remoteRequests,
    localRequests,
    plannerCalls,
    reads,
    logs,
    listing,
    recipient,
    localOn,
    onRead,
  };
}

const turn = (h: Harness): AgentActiveTurn => ({
  text: '메일 요약해줘',
  attachmentCount: 0,
  actor: h.actors.get('owner') as Actor,
  now: T0,
  entries: READS,
  direct: true,
  sessionId: 'session-1',
  conversationKey: OWNER_SCOPE.conversationKey,
});
const owner = (h: Harness, direct = true) => ({ actor: h.actors.get('owner') as Actor, direct });

/** Ask (REMOTE only) and answer a closed yes through the real pipeline; returns the bound yes. */
async function askAndYes(h: Harness) {
  const asked = await h.service.runActive(turn(h), async () => CHAT);
  if (asked.kind !== 'reply') throw new Error(`not asked: ${JSON.stringify(asked)}`);
  return yesBound(h.store, OWNER_SCOPE, '응', Date.now());
}
const replyOf = (outcome: AgentContinuationOutcome) => {
  if (outcome.kind !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(outcome)}`);
  return outcome.reply;
};
const consentLog = (h: Harness) => h.logs.filter((log) => log.event === 'agent_run.consent').map((log) => log.fields);

describe('CS-1b continueSummaryConsent: the happy path', () => {
  it('re-reads the listing, sends ONE REMOTE M2 call to the asked recipient, and replies with the summary only (no listing, no question)', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    expect(h.remoteRequests).toHaveLength(0);
    const readsBefore = h.reads.length;
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    const reply = replyOf(outcome);
    expect(h.remoteRequests).toHaveLength(1);
    expect(h.localRequests).toHaveLength(0);
    // The covered listing read re-ran, now with documents; the planner was never called again (no M1, no M1').
    expect(h.reads.length).toBe(readsBefore + 1);
    expect(h.reads.at(-1)?.withDocuments).toBe(true);
    expect(h.plannerCalls.count).toBe(1);
    const kinds = new Set(reply.parts.map((part) => part.kind));
    expect(kinds.has('fact')).toBe(false);
    expect(kinds.has('note')).toBe(false);
    expect(kinds.has('consent')).toBe(false);
    expect(reply.summaryLines).toBe(3);
    expect(reply.text).toContain('이 요약을 만들려고 원문 일부를 외부 모델로 보냈어요.');
    expect(reply.text).not.toContain('• 메일');
    expect(outcome).toMatchObject({ outcome: 'complete' });
  });

  it('the log line is content-free and the reply never carries the bodies', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    expect(consentLog(h).at(-1)).toEqual({ outcome: 'continued', reason: 'ok', sources: 1, items: 3 });
    expect(JSON.stringify(h.logs)).not.toContain('RAW-BODY-CANARY');
    expect(replyOf(outcome).text).not.toContain('RAW-BODY-CANARY');
  });
});

describe('CS-1b W3: the re-read is filtered to the asked ids', () => {
  it('an item that left is not replaced and a new item is not added: only the asked bodies are sent, in listing order', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.listing.ids.splice(0, h.listing.ids.length, 'm9', 'm3', 'm1');
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    const reply = replyOf(outcome);
    expect(h.remoteRequests).toHaveLength(1);
    const prompt = h.remoteRequests[0]?.prompt ?? '';
    expect(prompt).toContain(BODY('m1'));
    expect(prompt).toContain(BODY('m3'));
    expect(prompt).not.toContain(BODY('m2'));
    expect(prompt).not.toContain(BODY('m9'));
    // Listing order: m3 (position 2) before m1 (position 3).
    expect(prompt.indexOf(BODY('m3'))).toBeLessThan(prompt.indexOf(BODY('m1')));
    // One of the three asked items is gone: it is reported as left out, never replaced.
    expect(reply.text).toContain('1건은 제외했어요.');
  });

  it('every asked item gone: no M2 call and the fixed nothing-left note', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.listing.ids.splice(0, h.listing.ids.length, 'm7', 'm8');
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    const reply = replyOf(outcome);
    expect(h.remoteRequests).toHaveLength(0);
    expect(reply.text).toBe('그 사이 목록이 바뀌어서 요약할 항목이 남지 않았어요. 아무것도 보내지 않았어요.');
    expect(reply.summaryLines).toBe(0);
    expect(consentLog(h).at(-1)).toEqual({ outcome: 'continued', reason: 'listing-only', sources: 1, items: 3 });
  });

  it('a credential-bearing asked item is still withheld by the existing guards', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.listing.bodies.m2 = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    await h.service.continueSummaryConsent(bound, owner(h));
    // The other two asked items are still summarised; the credential-bearing one never reaches the model.
    expect(h.remoteRequests).toHaveLength(1);
    const prompt = h.remoteRequests.map((request) => request.prompt).join('\n');
    expect(prompt).toContain(BODY('m1'));
    expect(prompt).toContain(BODY('m3'));
    expect(prompt).not.toContain('BEGIN PRIVATE KEY');
    expect(prompt).not.toContain('MIIEvQIBADANBgkq');
  });
});

describe('CS-1b recipient: REMOTE only to the asked recipient, LOCAL always allowed (W4)', () => {
  it('the recipient label changed after the yes: REMOTE is refused at selection and dispatch, nothing is sent', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.recipient.current = 'Codex';
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    expect(h.remoteRequests).toHaveLength(0);
    expect(replyOf(outcome).text).toBe('요약을 만들지 못해서 아무것도 보내지 않았어요.');
    expect(consentLog(h).at(-1)).toMatchObject({ outcome: 'continued', reason: 'listing-only' });
  });

  it('a LOCAL provider that became available runs even though the recipient changed', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.recipient.current = 'Codex';
    h.localOn.current = true;
    const reply = replyOf(await h.service.continueSummaryConsent(bound, owner(h)));
    expect(h.remoteRequests).toHaveLength(0);
    expect(h.localRequests).toHaveLength(1);
    expect(reply.summaryLines).toBe(3);
    expect(reply.text).not.toContain('외부 모델');
  });
});

describe('CS-1b single use, expiry, admission and the kill switch', () => {
  it('the same bound yes runs once: a second call sends nothing', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    expect(replyOf(await h.service.continueSummaryConsent(bound, owner(h))).summaryLines).toBe(3);
    const second = await h.service.continueSummaryConsent(bound, owner(h));
    expect(second).toEqual({ kind: 'declined', reason: 'spent', text: '요약 확인 시간이 지났어요. 다시 요청해 주세요.' });
    expect(h.remoteRequests).toHaveLength(1);
  });

  it('a missing record (taken, dropped or voided) is the fixed expired line and nothing is read or sent', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.service.takeSummaryContinuation((bound.pending as { runRef: string }).runRef, Date.now());
    const readsBefore = h.reads.length;
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    expect(outcome).toEqual({ kind: 'declined', reason: 'expired', text: '요약 확인 시간이 지났어요. 다시 요청해 주세요.' });
    expect(h.reads.length).toBe(readsBefore);
    expect(h.remoteRequests).toHaveLength(0);
    expect(consentLog(h).at(-1)).toEqual({ outcome: 'declined', reason: 'expired', sources: 1, items: 3 });
  });

  it('a bound consent the pipeline did not record as a yes mints no token: nothing is sent', async () => {
    const h = harness();
    await h.service.runActive(turn(h), async () => CHAT);
    const claimed = h.store.claim(OWNER_SCOPE, Date.now());
    if (!claimed.ok) throw new Error('claim');
    const bound = h.store.bind(claimed.claim, Date.now());
    if (bound === undefined) throw new Error('bind');
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'no-consent' });
    expect(h.remoteRequests).toHaveLength(0);
    // Review round 1 (P3): the brand is checked before the record is taken, so the real pending's record is still there.
    expect(h.service.takeSummaryContinuation(bound.pending.runRef, Date.now())).toBeDefined();
  });

  it('a value that is not a bound summary consent is refused without throwing', async () => {
    const h = harness();
    for (const value of [undefined, null, {}, { pending: { kind: 'topic-consent' } }]) {
      const outcome = await h.service.continueSummaryConsent(value as never, owner(h));
      expect(outcome.kind).toBe('declined');
    }
    expect(h.remoteRequests).toHaveLength(0);
  });

  it('not the owner of the record, or not the owner DM: declined, nothing sent', async () => {
    const other = harness();
    const boundOther = await askAndYes(other);
    other.actors.set('intruder', { id: 'intruder', displayName: 'X', identities: [], createdAt: T0 });
    expect(await other.service.continueSummaryConsent(boundOther, { actor: other.actors.get('intruder') as Actor, direct: true })).toMatchObject({ reason: 'actor' });
    const dm = harness();
    const bound = await askAndYes(dm);
    expect(await dm.service.continueSummaryConsent(bound, owner(dm, false))).toMatchObject({ kind: 'declined', reason: 'not-dm' });
    expect(other.remoteRequests).toHaveLength(0);
    expect(dm.remoteRequests).toHaveLength(0);
  });

  it('the per-actor caps are checked: a capped actor sends nothing', async () => {
    const h = harness({ caps: { perHour: 1 } });
    const bound = await askAndYes(h);
    // The asking run used the one run of the hour.
    expect(await h.service.continueSummaryConsent(bound, owner(h))).toMatchObject({ kind: 'declined', reason: 'hourly-cap' });
    expect(h.remoteRequests).toHaveLength(0);
  });

  it('a stopped kill switch declines before anything is read', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    await h.service.handleSwitchPhrase(h.actors.get('owner') as Actor, '에이전트 중지', T0);
    const readsBefore = h.reads.length;
    expect(await h.service.continueSummaryConsent(bound, owner(h))).toMatchObject({ kind: 'declined', reason: 'kill-switch' });
    expect(h.reads.length).toBe(readsBefore);
    expect(h.remoteRequests).toHaveLength(0);
  });

  it('a stop during the re-read: the summarize step is not run and nothing is sent', async () => {
    const h = harness();
    const bound = await askAndYes(h);
    h.onRead.current = async () => {
      await h.service.handleSwitchPhrase(h.actors.get('owner') as Actor, '에이전트 중지', T0);
    };
    const outcome = await h.service.continueSummaryConsent(bound, owner(h));
    expect(h.remoteRequests).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: 'reply', outcome: 'partial', stopped: true });
    expect(replyOf(outcome).text).toContain('에이전트 중지로 남은 단계는 실행하지 않았어요.');
  });

  it('the continuation signature takes no run, step or token from the caller', () => {
    expect(harness().service.continueSummaryConsent.length).toBe(2);
  });
});

// ── the executor `continuation` option ─────────────────────────────────────────────────────────────────────────────────

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const wideRead = (entryId: 'mail.list' | 'drive.files', limit: number): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId], args: { limit }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

function remoteProvider(id = 'remote-a'): AiProvider & { readonly requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    id,
    requests,
    executionLocality: 'REMOTE',
    dataUse: 'no-training',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    isAvailable: async () => true,
    execute: async (request) => (requests.push(request), { text: '{"items":[{"n":1,"summary":"A short summary."},{"n":2,"summary":"Another."}]}' }),
  };
}
function listingPort(entry: 'mail' | 'drive', ids: readonly string[]): AgentReadPort & { readonly requests: AgentReadRequest[] } {
  const requests: AgentReadRequest[] = [];
  return {
    requests,
    read: async (request) => {
      requests.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      const documents: AgentSourceDocument[] = ids.map((id, index) => ({ id, position: index + 1, title: `${entry} ${index + 1}`, author: 'a', date: '', body: `${entry} body ${id}` }));
      return { ok: true, items: ids.map((id) => ({ id })), ...(request.withDocuments === true ? { documents } : {}) };
    },
  };
}
const route = (provider: AiProvider, extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute => ({
  selector: new CapabilityRouter(new AiProviderManager([provider]), PERMISSIVE),
  recipientLabel: () => 'Claude',
  askSummaryConsent: true,
  ...extra,
});

describe('CS-1b executor continuation: REMOTE end to end through the executor (restored from LOCAL)', () => {
  it('only the continuation steps run; the rest is not-run (continuation); mail and Drive go REMOTE in parallel under the token', async () => {
    setSummaryGrantsForTest(() => true);
    try {
      const provider = remoteProvider();
      const mail = listingPort('mail', ['m1', 'm2']);
      const drive = listingPort('drive', ['file-aaaa1']);
      const other = listingPort('mail', ['x1']);
      const p = plan([wideRead('mail.list', 2), wideRead('drive.files', 1), summarize([1, 2]), wideRead('mail.list', 1), summarize([4])]);
      const run = newSummaryRunToken();
      const reads = [
        { step: 1, entryId: 'mail.list' as const, itemIds: ['m1', 'm2'] },
        { step: 2, entryId: 'drive.files' as const, itemIds: ['file-aaaa1'] },
      ];
      const consent = consentTokenFor(run, 3, { recipient: 'Claude', reads });
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail, 'drive.files': drive }, summarizer: route(provider) }).execute(p, {
        continuation: { steps: [1, 2, 3], summaryStep: 3, run, consent, reads },
      });
      expect(other.requests).toHaveLength(0);
      expect(result.steps[3]).toMatchObject({ kind: 'read', status: 'not-run', reason: 'continuation' });
      expect(result.steps[4]).toMatchObject({ kind: 'summarize', status: 'not-run', reason: 'continuation' });
      expect(result.steps[2]).toMatchObject({ kind: 'summarize', status: 'ok' });
      expect(provider.requests).toHaveLength(2);
      const third = result.steps[2];
      expect(third?.kind === 'summarize' && third.status === 'ok' ? third.audits.map((audit) => audit.locality) : []).toEqual(['REMOTE', 'REMOTE']);
      expect(mail.requests[0]?.withDocuments).toBe(true);
      expect(drive.requests[0]?.withDocuments).toBe(true);
    } finally {
      setSummaryGrantsForTest();
    }
  });

  it('a token keyed to another step never sends REMOTE through the executor', async () => {
    setSummaryGrantsForTest(() => true);
    try {
      const provider = remoteProvider();
      const mail = listingPort('mail', ['m1']);
      const p = plan([wideRead('mail.list', 1), summarize([1])]);
      const run = newSummaryRunToken();
      const reads = [{ step: 1, entryId: 'mail.list' as const, itemIds: ['m1'] }];
      const wrongStep = consentTokenFor(run, 1, { recipient: 'Claude', reads });
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: route(provider) }).execute(p, {
        continuation: { steps: [1, 2], summaryStep: 2, run, consent: wrongStep, reads },
      });
      expect(provider.requests).toHaveLength(0);
      // The wrong step's token is no consent for step 2: the step asks again, and nothing is sent.
      expect(result.steps[1]).toMatchObject({ status: 'consent-needed' });
    } finally {
      setSummaryGrantsForTest();
    }
  });
});

describe('CS-1b review round 1: summary inputs come only from the recorded reads', () => {
  const runWith = async (p: RunPlan, readers: Record<string, AgentReadPort>, reads: { step: number; entryId: 'mail.list' | 'drive.files'; itemIds: string[] }[], summaryStep: number, provider: AiProvider) => {
    const run = newSummaryRunToken();
    const consent = consentTokenFor(run, summaryStep, { recipient: 'Claude', reads });
    return new AgentPlanExecutor({ readers: readers as never, summarizer: route(provider) }).execute(p, {
      continuation: { steps: p.steps.map((_, index) => index + 1), summaryStep, run, consent, reads },
    });
  };

  it('a sibling read that was empty when asked and is populated now adds nothing: no withDocuments, not in the prompt', async () => {
    setSummaryGrantsForTest(() => true);
    try {
      const provider = remoteProvider();
      let calls = 0;
      const requests: AgentReadRequest[] = [];
      const mail: AgentReadPort = {
        read: async (request) => {
          requests.push(request);
          calls += 1;
          const ids = calls === 1 ? ['m1', 'm2'] : ['n1'];
          const documents: AgentSourceDocument[] = ids.map((id, index) => ({ id, position: index + 1, title: 't', author: 'a', date: '', body: `BODY-${id}` }));
          return { ok: true, items: ids.map((id) => ({ id })), ...(request.withDocuments === true ? { documents } : {}) };
        },
      };
      const p = plan([wideRead('mail.list', 2), wideRead('mail.list', 1), summarize([1, 2])]);
      const result = await runWith(p, { 'mail.list': mail }, [{ step: 1, entryId: 'mail.list', itemIds: ['m1', 'm2'] }], 3, provider);
      expect(requests[1]?.withDocuments).not.toBe(true);
      const prompt = provider.requests.map((request) => request.prompt).join('\n');
      expect(prompt).toContain('BODY-m1');
      expect(prompt).not.toContain('BODY-n1');
      expect(result.steps[2]).toMatchObject({ kind: 'summarize', status: 'ok' });
    } finally {
      setSummaryGrantsForTest();
    }
  });

  it('mail asked + Drive unasked, every asked mail item gone: no M2 call, nothing summarised, Drive fetches no body', async () => {
    setSummaryGrantsForTest(() => true);
    try {
      const provider = remoteProvider();
      const mail = listingPort('mail', ['m9']);
      const drive = listingPort('drive', ['file-aaaa1']);
      const p = plan([wideRead('mail.list', 1), wideRead('drive.files', 1), summarize([1, 2])]);
      const result = await runWith(p, { 'mail.list': mail, 'drive.files': drive }, [{ step: 1, entryId: 'mail.list', itemIds: ['m1'] }], 3, provider);
      expect(provider.requests).toHaveLength(0);
      expect(drive.requests[0]?.withDocuments).not.toBe(true);
      expect(result.steps[2]).toMatchObject({ kind: 'summarize', status: 'listing-only', reason: 'consent-nothing-left' });
    } finally {
      setSummaryGrantsForTest();
    }
  });

  it('a continuation reply is never blank: a consent-needed summary maps to the fixed not-sent line', async () => {
    setSummaryGrantsForTest(() => true);
    try {
      const provider = remoteProvider();
      const mail = listingPort('mail', ['m1']);
      const p = plan([wideRead('mail.list', 1), summarize([1])]);
      const run = newSummaryRunToken();
      const reads = [{ step: 1, entryId: 'mail.list' as const, itemIds: ['m1'] }];
      const wrongStep = consentTokenFor(run, 1, { recipient: 'Claude', reads });
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: route(provider) }).execute(p, { continuation: { steps: [1, 2], summaryStep: 2, run, consent: wrongStep, reads } });
      expect(result.steps[1]).toMatchObject({ status: 'consent-needed' });
      const reply = assembleAgentReply({ plan: p as never, result, language: 'en', destinationIsOwnerDm: true, mode: 'continuation', summaryStep: 2 });
      expect(reply.text).toBe('A summary could not be made, so nothing was sent.');
    } finally {
      setSummaryGrantsForTest();
    }
  });
});

describe('CS-1b assembler continuation mode', () => {
  it('shows only the step summary, the omitted note and the REMOTE disclosure: no listing, no notes, no question', async () => {
    setSummaryGrantsForTest(() => true);
    try {
      const provider = remoteProvider();
      const p = plan([wideRead('mail.list', 3), summarize([1])]);
      const run = newSummaryRunToken();
      const reads = [{ step: 1, entryId: 'mail.list' as const, itemIds: ['m1', 'm2', 'm3'] }];
      const consent = consentTokenFor(run, 2, { recipient: 'Claude', reads });
      const result = await new AgentPlanExecutor({ readers: { 'mail.list': listingPort('mail', ['m1', 'm2', 'm3']) }, summarizer: route(provider) }).execute(p, {
        continuation: { steps: [1, 2], summaryStep: 2, run, consent, reads },
      });
      const input = { plan: p as never, result, language: 'en' as const, destinationIsOwnerDm: true };
      const listed = assembleAgentReply(input);
      const continued = assembleAgentReply({ ...input, mode: 'continuation', summaryStep: 2 });
      expect(listed.parts.some((part) => part.kind === 'fact')).toBe(true);
      const kinds = continued.parts.map((part) => part.kind);
      expect(kinds).not.toContain('fact');
      expect(kinds).not.toContain('note');
      expect(kinds).not.toContain('consent');
      expect(continued.text).toContain('Part of the original text was sent to an outside model to make this summary.');
      expect(continued.text).toContain('1 item was left out of the summary.');
    } finally {
      setSummaryGrantsForTest();
    }
  });
});
