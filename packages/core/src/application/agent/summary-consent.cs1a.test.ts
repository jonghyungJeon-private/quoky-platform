import { afterEach, describe, expect, it } from 'vitest';
import { Capability, type Actor } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import { CONSENT_COUNT_PLACEHOLDER_EN, CONSENT_COUNT_PLACEHOLDER_KO, consentClassifierQuestion } from '../consent-answer/consent-classifier';
import { ConsentPendingStore, topicConsentPending } from '../consent-answer/consent-pending';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry, type NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { AgentRunService, type AgentActiveTurn } from './agent-run-service';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadRequest, type AgentReadResponse } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import {
  deriveM2Localities,
  mintSummaryConsentToken,
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  quarantinedSummarize,
  setSummaryGrantsForTest,
  summaryReadinessDetailed,
  type AgentSourceDocument,
  type QuarantinedSummarizerRoute,
  type SummaryConsentScope,
  type SummaryRunToken,
} from './quarantined-summary';
import { assembleAgentReply } from './reply-assembler';
import { boundConsentFor, consentTokenFor } from './summary-consent.test-support';
import { renderSummaryConsentQuestion, SUMMARY_CONSENT_QUESTION_VERSION } from './summary-consent-question';

// ADR-0121 SR-1 rule ① (confirm slice CS-1a, guard and ask): REMOTE only with a bound consent token (every egress label, with the
// dispatch re-check); the ask mode (`consent-needed`) behind the route flag; the pending step and the continuation record in the
// run service. There is no allow-all seam: no suite here may reach REMOTE without a real token (a bound consent from a store, minted by `mintSummaryConsentToken`).

const RUN = newSummaryRunToken();
const PERMISSIVE: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
const LABELS: Record<string, string> = { 'remote-a': 'Claude', 'remote-b': 'Codex' };

interface Fake extends AiProvider {
  readonly requests: AiRequest[];
}
function fake(id: string, locality: AiExecutionLocality | undefined, priority = 10, extra: { readonly dataUse?: 'no-training' } = {}): Fake {
  const requests: AiRequest[] = [];
  return {
    requests,
    id,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority }],
    ...(locality !== undefined ? { executionLocality: locality } : {}),
    ...(extra.dataUse !== undefined ? { dataUse: extra.dataUse } : {}),
    isAvailable: async () => true,
    async execute(request: AiRequest) {
      requests.push(request);
      return { text: '{"items":[{"n":1,"summary":"A short summary."}]}' };
    },
  };
}
function route(providers: AiProvider[], extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute {
  return { selector: new CapabilityRouter(new AiProviderManager(providers), PERMISSIVE), ...extra };
}
const label = (provider: AiProvider): string | undefined => LABELS[provider.id];

const doc = (position: number): AgentSourceDocument => ({ id: `m${position}`, position, title: `t${position}`, author: 'a', date: '', body: `body ${position}` });
const mailSource = (...documents: AgentSourceDocument[]) => ({ entryId: 'mail.list' as const, documents, asked: documents.length, grant: mintSummaryEgressGrantForTest(1, 'mail.list', RUN) });
const base = { schema: 'digest.v1' as const, summaryStep: 1, run: RUN, reserve: () => true };
// A token the real way: a bound consent from a store, minted by `mintSummaryConsentToken` (no test-only maker exists).
const tokenFor = (recipient: string, ids = ['m1'], extra: { run?: SummaryRunToken; step?: number; entryId?: NlWave1EntryId } = {}) =>
  consentTokenFor(extra.run ?? RUN, extra.step ?? 1, { recipient, reads: [{ entryId: extra.entryId ?? 'mail.list', itemIds: ids }] });
const SCOPE: SummaryConsentScope = { run: RUN, step: 1, covered: [{ entryId: 'mail.list', itemIds: ['m1'] }] };

afterEach(() => setSummaryGrantsForTest());

describe('CS-1a guard: REMOTE only with a bound consent token, for every egress label', () => {
  const labels = [
    { egress: 'REMOTE_ON_SUMMARY_REQUEST' as const, needsGrant: true, granted: true },
    { egress: 'REMOTE_OK' as const, needsGrant: false, granted: false },
    { egress: 'REMOTE_OK' as const, needsGrant: true, granted: true },
  ];

  it.each(labels)('$egress (needsGrant $needsGrant): no token is LOCAL only; a matching token keeps REMOTE', (label) => {
    expect(deriveM2Localities({ ...label, askedItems: 1, consent: undefined, consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ ...label, askedItems: 1, consent: tokenFor('Claude'), consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
  });

  it('the token must match this run, this step, every covered source and its ids; a forged or foreign value is no token', () => {
    const label = labels[0] as (typeof labels)[number];
    const derive = (consent: unknown, scope: SummaryConsentScope = SCOPE) => deriveM2Localities({ ...label, askedItems: 1, consent: consent as never, consentScope: scope });
    expect(derive(tokenFor('Claude', ['m1']))).toMatchObject({ localities: ['LOCAL', 'REMOTE'] });
    // Another run, another step, another source, an id the owner was not asked about.
    expect(derive(tokenFor('Claude', ['m1'], { run: newSummaryRunToken() }))).toMatchObject({ localities: ['LOCAL'] });
    expect(derive(tokenFor('Claude', ['m1'], { step: 2 }))).toMatchObject({ localities: ['LOCAL'] });
    expect(derive(tokenFor('Claude', ['m1'], { entryId: 'drive.files' }))).toMatchObject({ localities: ['LOCAL'] });
    expect(derive(tokenFor('Claude', ['m2']))).toMatchObject({ localities: ['LOCAL'] });
    expect(derive(tokenFor('Claude', ['m1']), { ...SCOPE, covered: [{ entryId: 'mail.list', itemIds: ['m1', 'm2'] }] })).toMatchObject({ localities: ['LOCAL'] });
    expect(derive(tokenFor('Claude', ['m1']), { ...SCOPE, covered: [{ entryId: 'mail.list' }, { entryId: 'drive.files' }] })).toMatchObject({ localities: ['LOCAL'] });
    // A structural copy, a plain object, a primitive.
    expect(derive({ ...tokenFor('Claude') })).toMatchObject({ localities: ['LOCAL'] });
    expect(derive({})).toMatchObject({ localities: ['LOCAL'] });
    expect(derive('token')).toMatchObject({ localities: ['LOCAL'] });
  });

  it('the guard only narrows: no grant, host-only, local-only and an unverifiable count are unchanged', () => {
    expect(deriveM2Localities({ egress: 'REMOTE_ON_SUMMARY_REQUEST', needsGrant: true, granted: false, askedItems: 1, consent: tokenFor('Claude'), consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-summary-grant' });
    expect(deriveM2Localities({ egress: 'HOST_ONLY', needsGrant: true, granted: true, askedItems: 1, consent: tokenFor('Claude'), consentScope: SCOPE })).toEqual({ ok: false, reason: 'host-only' });
    expect(deriveM2Localities({ egress: 'LOCAL_MODEL_ONLY', needsGrant: false, granted: false, askedItems: 1, consent: tokenFor('Claude'), consentScope: SCOPE })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ egress: 'REMOTE_OK', needsGrant: false, granted: false, askedItems: 0, consent: tokenFor('Claude'), consentScope: SCOPE })).toEqual({ ok: false, reason: 'no-model' });
  });
});

describe('CS-1a guard through the summariser: selection and the dispatch re-check', () => {
  it('a REMOTE-only route with the grant and no token selects nothing and sends nothing (no-model)', async () => {
    const remote = fake('remote-a', 'REMOTE');
    const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: route([remote], { recipientLabel: label }) });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('LOCAL needs no token (W4): it runs under the grant alone', async () => {
    const local = fake('local-a', 'LOCAL');
    const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: route([local]) });
    expect(outcome.kind).toBe('summary');
    expect(local.requests).toHaveLength(1);
  });

  it('a matching token and the matching recipient label send exactly once to REMOTE', async () => {
    const remote = fake('remote-a', 'REMOTE');
    const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: route([remote], { recipientLabel: label }), consent: tokenFor('Claude') });
    expect(outcome).toMatchObject({ kind: 'summary', audits: [{ locality: 'REMOTE', auditId: 'remote-a' }] });
    expect(remote.requests).toHaveLength(1);
  });

  it.each([
    ['another recipient than the one asked about', route([fake('remote-b', 'REMOTE')], { recipientLabel: label })],
    ['no label for the provider (undefined excludes REMOTE)', route([fake('remote-x', 'REMOTE')], { recipientLabel: label })],
    ['no label function at all', route([fake('remote-a', 'REMOTE')])],
    ['a label function that throws', route([fake('remote-a', 'REMOTE')], { recipientLabel: () => { throw new Error('x'); } })],
    ['a blank label', route([fake('remote-a', 'REMOTE')], { recipientLabel: () => '  ' })],
  ])('REMOTE is refused with a token when there is %s', async (_name, refused) => {
    const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: refused, consent: tokenFor('Claude') });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
  });

  it('a token for another run, another step, another source or fewer ids is refused', async () => {
    for (const consent of [
      tokenFor('Claude', ['m1'], { run: newSummaryRunToken() }),
      tokenFor('Claude', ['m1'], { step: 2 }),
      tokenFor('Claude', ['m1'], { entryId: 'drive.files' }),
      tokenFor('Claude', ['m9']),
    ]) {
      const remote = fake('remote-a', 'REMOTE');
      const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: route([remote], { recipientLabel: label }), consent });
      expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
      expect(remote.requests).toHaveLength(0);
    }
  });

  it('the dispatch re-check reads the recipient label again: a provider that stops being the recipient is not called', async () => {
    const remote = fake('remote-a', 'REMOTE');
    let reads = 0;
    const flipping = route([remote], { recipientLabel: () => (++reads <= 2 ? 'Claude' : 'Other') });
    const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: flipping, consent: tokenFor('Claude') });
    expect(outcome.kind).toBe('listing-only');
    expect(remote.requests).toHaveLength(0);
  });

  it('every work source is guarded like mail: a granted work source never reaches REMOTE without a token, and does with one', async () => {
    for (const entryId of ['calendar.events', 'jira.issues', 'slack.search', 'confluence.search', 'github.items'] as const) {
      const remote = fake('remote-a', 'REMOTE', 10, { dataUse: 'no-training' });
      const work = { entryId, documents: [{ ...doc(1), id: 'x1' }], asked: 1, grant: mintSummaryEgressGrantForTest(1, entryId, RUN) };
      const r = route([remote], { recipientLabel: label, workSummarySources: ['calendar', 'jira', 'slack', 'confluence', 'github'] });
      const schema = 'digest.v1' as const;
      expect(await quarantinedSummarize({ ...base, schema, sources: [work], route: r }), entryId).toEqual({ kind: 'listing-only', reason: 'no-model' });
      expect(remote.requests, entryId).toHaveLength(0);
      const token = tokenFor('Claude', ['x1'], { entryId });
      expect((await quarantinedSummarize({ ...base, schema, sources: [work], route: r, consent: token })).kind, entryId).toBe('summary');
      expect(remote.requests, entryId).toHaveLength(1);
    }
  });
});

// ── the ask mode in the executor ───────────────────────────────────────────────────────────────────────────────────────

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const wideRead = (entryId: NlWave1EntryId, limit: number): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit }, provenance: {} });
const summarize = (from: number[], schema: 'digest.v1' | 'meeting-digest.v1' = 'digest.v1'): ValidatedAgentStep => ({ kind: 'summarize', from, schema });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });

interface SpyPort extends AgentReadPort {
  readonly requests: AgentReadRequest[];
}
function port(itemIds: readonly string[]): SpyPort {
  const requests: AgentReadRequest[] = [];
  return {
    requests,
    read: async (request) => {
      requests.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      const response: AgentReadResponse = { ok: true, items: itemIds.map((id) => ({ id })), documents: itemIds.map((id, i) => ({ id, position: i + 1, title: 't', author: 'a', date: '', body: 'RAW-BODY-CANARY' })) };
      return response;
    },
  };
}
const ask = (providers: AiProvider[], extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute => route(providers, { recipientLabel: label, askSummaryConsent: true, ...extra });

describe('CS-1a ask mode: consent-needed in the executor', () => {
  it('a REMOTE pick asks: no withDocuments, no M2 call, the listing runs, the ids are the first asked usable slots', async () => {
    setSummaryGrantsForTest(() => true);
    const remote = fake('remote-a', 'REMOTE');
    const mail = port(['m1', 'bad id', 'm3', 'm4']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: ask([remote]) }).execute(plan([wideRead('mail.list', 3), summarize([1])]));
    expect(mail.requests).toHaveLength(1);
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
    expect(remote.requests).toHaveLength(0);
    expect(result.usage.m2Calls).toBe(0);
    expect(result.steps[0]).toMatchObject({ kind: 'read', status: 'ok' });
    // Positions 1..3: the unusable slot 2 is skipped and never shifts m4 in.
    expect(result.steps[1]).toEqual({ step: 2, kind: 'summarize', status: 'consent-needed', from: [1], schema: 'digest.v1', recipient: 'Claude', sources: [{ source: 'mail', itemIds: ['m1', 'm3'], reads: [{ step: 1, entryId: 'mail.list', itemIds: ['m1', 'm3'] }] }] });
    expect(result.outcome).toBe('partial');
    expect(JSON.stringify(result)).not.toContain('RAW-BODY-CANARY');
  });

  it('with the switch off (no ask mode) REMOTE is dropped: listing-only, no question, no call', async () => {
    setSummaryGrantsForTest(() => true);
    const remote = fake('remote-a', 'REMOTE');
    const mail = port(['m1']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: route([remote], { recipientLabel: label }) }).execute(plan([wideRead('mail.list', 1), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
    expect(remote.requests).toHaveLength(0);
  });

  it('W4: a LOCAL pick runs with no question, even in ask mode (and a REMOTE ranked below it is never used)', async () => {
    setSummaryGrantsForTest(() => true);
    const local = fake('local-a', 'LOCAL', 20);
    const remote = fake('remote-a', 'REMOTE', 10);
    const mail = port(['m1']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: ask([local, remote]) }).execute(plan([wideRead('mail.list', 1), summarize([1])]));
    expect(mail.requests[0]?.withDocuments).toBe(true);
    expect(result.steps[1]).toMatchObject({ status: 'ok', audits: [{ locality: 'LOCAL' }] });
    expect(local.requests).toHaveLength(1);
    expect(remote.requests).toHaveLength(0);
  });

  it('a REMOTE provider without a recipient label cannot be asked about: no-model, nothing fetched', async () => {
    setSummaryGrantsForTest(() => true);
    const mail = port(['m1']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: ask([fake('remote-x', 'REMOTE')]) }).execute(plan([wideRead('mail.list', 1), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-model' });
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
  });

  it('a missing summary grant stays no-summary-grant (no question for something the owner did not ask)', async () => {
    const mail = port(['m1']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: ask([fake('remote-a', 'REMOTE')]) }).execute(plan([wideRead('mail.list', 1), summarize([1])]));
    expect(result.steps[1]).toMatchObject({ status: 'listing-only', reason: 'no-summary-grant' });
  });

  it('mail and Drive in one step share one question: both sources, in plan order', async () => {
    setSummaryGrantsForTest(() => true);
    const mail = port(['m1', 'm2', 'm3']);
    const drive = port(['file-aaaa1', 'file-aaaa2']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail, 'drive.files': drive }, summarizer: ask([fake('remote-a', 'REMOTE')]) }).execute(
      plan([wideRead('mail.list', 3), wideRead('drive.files', 2), summarize([1, 2])]),
    );
    expect(result.steps[2]).toMatchObject({
      status: 'consent-needed',
      recipient: 'Claude',
      sources: [
        { source: 'mail', itemIds: ['m1', 'm2', 'm3'] },
        { source: 'drive', itemIds: ['file-aaaa1', 'file-aaaa2'] },
      ],
    });
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
    expect(drive.requests[0]?.withDocuments).toBeUndefined();
  });

  it('W5 mixed: a switched-off source keeps its own reason and never joins the question', async () => {
    setSummaryGrantsForTest(() => true);
    const jira = port(['AB-1']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1']), 'jira.issues': jira }, summarizer: ask([fake('remote-a', 'REMOTE', 10, { dataUse: 'no-training' })]) }).execute(
      plan([wideRead('mail.list', 1), wideRead('jira.issues', 1), summarize([1, 2])]),
    );
    expect(result.steps[2]).toMatchObject({ status: 'consent-needed', sources: [{ source: 'mail', itemIds: ['m1'] }] });
    expect(result.steps[1]).toMatchObject({ kind: 'read', status: 'ok' });
    expect(jira.requests[0]?.withDocuments).toBeUndefined();
    expect(jira.requests[0]?.agentSummaryFieldMask).toBeUndefined();
  });

  it('a switched-on work source asks like mail: no body and no calendar field mask are requested', async () => {
    setSummaryGrantsForTest(() => true);
    const calendar = port(['e1', 'e2']);
    const jira = port(['AB-1']);
    const remote = fake('remote-a', 'REMOTE', 10, { dataUse: 'no-training' });
    const result = await new AgentPlanExecutor({ readers: { 'calendar.events': calendar, 'jira.issues': jira }, summarizer: ask([remote], { workSummarySources: ['calendar', 'jira'] }) }).execute(
      plan([wideRead('calendar.events', 2), summarize([1], 'meeting-digest.v1')]),
    );
    expect(result.steps[1]).toMatchObject({ status: 'consent-needed', sources: [{ source: 'calendar', itemIds: ['e1', 'e2'], reads: [{ step: 1, entryId: 'calendar.events', itemIds: ['e1', 'e2'] }] }] });
    expect(calendar.requests[0]?.agentSummaryFieldMask).toBeUndefined();
    expect(calendar.requests[0]?.withDocuments).toBeUndefined();
    const second = await new AgentPlanExecutor({ readers: { 'jira.issues': jira }, summarizer: ask([remote], { workSummarySources: ['jira'] }) }).execute(plan([wideRead('jira.issues', 1), summarize([1])]));
    expect(second.steps[1]).toMatchObject({ status: 'consent-needed', sources: [{ source: 'jira', itemIds: ['AB-1'] }] });
    expect(remote.requests).toHaveLength(0);
  });

  it('two summarize steps that both need consent: only the first asks (W2), the later one is listing-only consent-one-pending', async () => {
    setSummaryGrantsForTest(() => true);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1']), 'drive.files': port(['file-aaaa1']) }, summarizer: ask([fake('remote-a', 'REMOTE')]) }).execute(
      plan([wideRead('mail.list', 1), summarize([1]), wideRead('drive.files', 1), summarize([3])]),
    );
    expect(result.steps[1]).toMatchObject({ status: 'consent-needed', sources: [{ source: 'mail' }] });
    expect(result.steps[3]).toMatchObject({ status: 'listing-only', reason: 'consent-one-pending' });
  });

  it('sources of one step that pick different recipients: listing-only consent-recipient-split, nothing asked', async () => {
    setSummaryGrantsForTest(() => true);
    const alpha = fake('remote-a', 'REMOTE', 10, { dataUse: 'no-training' });
    const beta = fake('remote-b', 'REMOTE', 10, { dataUse: 'no-training' });
    const selector = {
      // Work text goes to Beta, everything else to Alpha: two sources, two recipients.
      select: async (_capability: Capability, context?: { workText?: boolean }) => (context?.workText === true ? beta : alpha),
      isStillEligible: () => true,
    };
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1']), 'jira.issues': port(['AB-1']) }, summarizer: { selector, recipientLabel: label, askSummaryConsent: true, workSummarySources: ['jira'] } }).execute(
      plan([wideRead('mail.list', 1), wideRead('jira.issues', 1), summarize([1, 2])]),
    );
    expect(result.steps[2]).toMatchObject({ status: 'listing-only', reason: 'consent-recipient-split' });
  });

  it('readiness: a REMOTE pick under the full set is consent-needed with the recipient; a token (CS-1b) turns it into ready', async () => {
    const grant = mintSummaryEgressGrantForTest(1, 'mail.list', RUN);
    const input = { entryId: 'mail.list' as const, schema: 'digest.v1' as const, summaryStep: 1, grant, run: RUN, askedItems: 1, route: ask([fake('remote-a', 'REMOTE')]) };
    expect(await summaryReadinessDetailed(input)).toEqual({ reason: 'consent-needed', recipient: 'Claude' });
    expect(await summaryReadinessDetailed({ ...input, consent: tokenFor('Claude') })).toEqual({ reason: undefined });
    expect(await summaryReadinessDetailed({ ...input, consent: tokenFor('Codex') })).toEqual({ reason: 'no-model' });
  });

  it('the assembler shows the listing, then the question as the last part, and no "not read" note', async () => {
    setSummaryGrantsForTest(() => true);
    const planned = plan([wideRead('mail.list', 3), summarize([1])]);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': port(['m1', 'm2']) }, summarizer: ask([fake('remote-a', 'REMOTE')]) }).execute(planned);
    const ko = assembleAgentReply({ plan: planned, result, language: 'ko', destinationIsOwnerDm: true });
    expect(ko.parts.at(-1)).toEqual({ kind: 'consent', text: '메일 2건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)' });
    expect(ko.parts.filter((part) => part.kind === 'consent')).toHaveLength(1);
    expect(ko.parts[0]).toMatchObject({ kind: 'fact' });
    expect(ko.text).not.toContain('목록만 보여드려요');
    const en = assembleAgentReply({ plan: planned, result, language: 'en', destinationIsOwnerDm: true });
    expect(en.parts.at(-1)).toEqual({ kind: 'consent', text: "I'll send 2 mails to Claude to summarise them. Shall I send them? (yes/no)" });
    // The question is Core-built fixed text: no item content and no id in it.
    expect(JSON.stringify(ko.parts)).not.toMatch(/m1|m2|RAW-BODY/u);
  });
});

// ── the pending step and the continuation record in AgentRunService ─────────────────────────────────────────────────────

const T0 = '2026-11-16T03:00:00.000Z';
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const CHAT = { id: 'claude-family', locality: 'REMOTE' as AiExecutionLocality };
const OWNER_SCOPE = { actorId: 'owner', conversationKey: 'discord|space|dm-1|none' };
const MAIL_SUMMARY_PLAN = JSON.stringify({ steps: [{ entryId: 'mail.list', args: {} }, { summarize: [1], schema: 'digest.v1' }], ambiguity: 'CLEAR' });
const MAIL_SUMMARY_TEXT = '메일 요약해줘';

interface Service {
  readonly service: AgentRunService;
  readonly store: ConsentPendingStore;
  readonly actors: Map<string, Actor>;
  readonly m2: AiRequest[];
  readonly reads: AgentReadRequest[];
  readonly logs: Array<{ event: string; fields?: LogFields }>;
}
function service(options: { readonly locality?: AiExecutionLocality; readonly withStore?: boolean; readonly withLabel?: boolean } = {}): Service {
  const m2: AiRequest[] = [];
  const reads: AgentReadRequest[] = [];
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const actors = new Map<string, Actor>([['owner', { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 }]]);
  const script = [MAIL_SUMMARY_PLAN];
  const planner: AiProvider = {
    id: 'scripted-planner',
    family: 'claude-family',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    async execute() {
      return { text: script.shift() ?? '', artifacts: [] };
    },
  };
  const summarizer: AiProvider = {
    id: 'remote-a',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    executionLocality: options.locality ?? 'REMOTE',
    isAvailable: async () => true,
    async execute(request) {
      m2.push(request);
      return { text: JSON.stringify({ items: [1, 2, 3].map((n) => ({ n, summary: `S ${n}` })) }) };
    },
  };
  const store = new ConsentPendingStore();
  const logger: Logger = { info: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }), warn: () => undefined, error: () => undefined };
  const mail: AgentReadPort = {
    read: async (request) => {
      reads.push(request);
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      return { ok: true, items: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], ...(request.withDocuments === true ? { documents: [1, 2, 3].map((n) => ({ id: `m${n}`, position: n, title: 't', author: 'a', date: '', body: 'RAW-BODY-CANARY' })) } : {}) };
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
      summarizer: new CapabilityRouter(new AiProviderManager([summarizer]), PERMISSIVE),
      released: true,
      ...(options.withStore !== false ? { consentStore: store } : {}),
      ...(options.withLabel !== false ? { recipientLabel: label } : {}),
    }),
    store,
    actors,
    m2,
    reads,
    logs,
  };
}
const turn = (s: Service, overrides: Partial<AgentActiveTurn> = {}): AgentActiveTurn => ({
  text: MAIL_SUMMARY_TEXT,
  attachmentCount: 0,
  actor: s.actors.get('owner') as Actor,
  now: T0,
  entries: READS,
  direct: true,
  sessionId: 'session-1',
  conversationKey: OWNER_SCOPE.conversationKey,
  ...overrides,
});
const replyOf = (outcome: Awaited<ReturnType<AgentRunService['runActive']>>) => {
  if (outcome.kind !== 'reply') throw new Error(`expected a reply, got ${JSON.stringify(outcome)}`);
  return outcome.reply;
};
const claim = (s: Service) => {
  const claimed = s.store.claim(OWNER_SCOPE, Date.now());
  if (!claimed.ok) throw new Error('no pending step');
  return claimed.claim.pending;
};

describe('CS-1a: AgentRunService opens the pending step and keeps the continuation record', () => {
  it('asks: the question is the last part, the step is open for the owner in this conversation, nothing was sent or fetched', async () => {
    const s = service();
    const reply = replyOf(await s.service.runActive(turn(s), async () => CHAT));
    expect(reply.parts.at(-1)).toEqual({ kind: 'consent', text: '메일 3건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)' });
    expect(s.m2).toHaveLength(0);
    expect(s.reads[0]?.withDocuments).toBeUndefined();
    expect(s.store.stateOf(OWNER_SCOPE)).toBe('open');
    expect(s.logs.find((log) => log.event === 'agent_run.consent')?.fields).toEqual({ outcome: 'asked', sources: 1, items: 3 });
  });

  it('the pending step is content-free and per source; the continuation record keeps the validated plan, the steps and the owner', async () => {
    const s = service();
    await s.service.runActive(turn(s), async () => CHAT);
    const pending = claim(s);
    if (pending.kind !== 'summary-consent') throw new Error('kind');
    expect(pending).toMatchObject({ recipient: 'Claude', language: 'ko', scope: OWNER_SCOPE, reasked: false, sources: [{ source: 'mail', itemIds: ['m1', 'm2', 'm3'] }] });
    expect(pending.runRef).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(pending)).not.toContain('RAW-BODY-CANARY');
    const record = s.service.takeSummaryContinuation(pending.runRef, Date.now());
    expect(record).toMatchObject({ summaryStep: 2, steps: [1, 2], actorId: 'owner', sessionId: 'session-1' });
    expect(record?.plan.steps).toHaveLength(2);
    // Single use.
    expect(s.service.takeSummaryContinuation(pending.runRef, Date.now())).toBeUndefined();
  });

  it('runRef survives the one fixed re-ask', async () => {
    const s = service();
    await s.service.runActive(turn(s), async () => CHAT);
    const claimed = s.store.claim(OWNER_SCOPE, Date.now());
    if (!claimed.ok) throw new Error('no pending step');
    const next = s.store.reask(claimed.claim, Date.now());
    expect(next).toMatchObject({ kind: 'summary-consent', reasked: true, runRef: (claimed.claim.pending as { runRef: string }).runRef });
  });

  it('with a LOCAL provider there is no question and no pending step (W4)', async () => {
    const s = service({ locality: 'LOCAL' });
    const reply = replyOf(await s.service.runActive(turn(s), async () => CHAT));
    expect(reply.parts.some((part) => part.kind === 'consent')).toBe(false);
    expect(s.m2).toHaveLength(1);
    expect(s.store.stateOf(OWNER_SCOPE)).toBeUndefined();
  });

  it('without a consent store the flag is off: REMOTE is never reached, no question, no pending step', async () => {
    const s = service({ withStore: false });
    const reply = replyOf(await s.service.runActive(turn(s), async () => CHAT));
    expect(reply.parts.some((part) => part.kind === 'consent')).toBe(false);
    expect(reply.text).toContain('목록만 보여드려요');
    expect(s.m2).toHaveLength(0);
    expect(s.reads[0]?.withDocuments).toBeUndefined();
    expect(s.store.stateOf(OWNER_SCOPE)).toBeUndefined();
  });

  it('without a recipient label map no REMOTE provider can be asked about (fail closed)', async () => {
    const s = service({ withLabel: false });
    const reply = replyOf(await s.service.runActive(turn(s), async () => CHAT));
    expect(reply.parts.some((part) => part.kind === 'consent')).toBe(false);
    expect(s.m2).toHaveLength(0);
    expect(s.store.stateOf(OWNER_SCOPE)).toBeUndefined();
  });

  it.each([
    ['another owner step is pending (W2)', { ownerStepPending: true }, 'owner-step-open', '먼저 답해 주실 일이 남아 있어서'],
    ['the turn has no conversation key', { conversationKey: undefined }, 'no-conversation', '여쭤볼 수 없어서'],
  ])('%s: the step is listing-only with the true fixed note, no question, no pending step', async (_name, overrides, reason, line) => {
    const s = service();
    const reply = replyOf(await s.service.runActive(turn(s, overrides as Partial<AgentActiveTurn>), async () => CHAT));
    expect(reply.parts.some((part) => part.kind === 'consent')).toBe(false);
    expect(reply.text).toContain(line);
    // The "another step is waiting" line is shown only when one is.
    expect(reply.text.includes('먼저 답해 주실 일이 남아 있어서')).toBe(reason === 'owner-step-open');
    expect(s.store.stateOf(OWNER_SCOPE)).toBeUndefined();
    expect(s.m2).toHaveLength(0);
    expect(s.logs.find((log) => log.event === 'agent_run.consent')?.fields).toMatchObject({ outcome: 'declined', reason });
  });

  it('a newer question in the same conversation supersedes the older one, and the records stay bounded (64, 600 s)', async () => {
    const s = service();
    const internal = s.service as unknown as { rememberContinuation(runRef: string, record: Record<string, unknown>): void; continuations: Map<string, unknown> };
    const record = (createdAtMs: number) => ({ plan: { kind: 'run', steps: [], connectorCalls: 0 }, basis: {}, summaryStep: 2, steps: [1, 2], actorId: 'owner', createdAtMs });
    for (let i = 0; i < 70; i += 1) internal.rememberContinuation(`r${i}`, record(1_000 + i));
    expect(internal.continuations.size).toBe(64);
    expect(internal.continuations.has('r0')).toBe(false);
    expect(internal.continuations.has('r69')).toBe(true);
    // 600 s: a record older than the window is dropped when the next one is stored, and is never handed out.
    internal.rememberContinuation('late', record(1_069 + 600_000));
    expect(internal.continuations.has('r69')).toBe(false);
    expect(s.service.takeSummaryContinuation('late', 1_069 + 600_000 + 599_999)).toBeDefined();
    internal.rememberContinuation('stale', record(5_000_000));
    expect(s.service.takeSummaryContinuation('stale', 5_000_000 + 600_000)).toBeUndefined();
    expect(s.service.takeSummaryContinuation('stale', 5_000_000)).toBeUndefined();
  });

  it('voidAllSummaryConsents drops the records and voids the open step', async () => {
    const s = service();
    await s.service.runActive(turn(s), async () => CHAT);
    expect(s.store.stateOf(OWNER_SCOPE)).toBe('open');
    const internal = s.service as unknown as { continuations: Map<string, unknown> };
    expect(internal.continuations.size).toBe(1);
    s.service.voidAllSummaryConsents();
    expect(internal.continuations.size).toBe(0);
    expect(s.store.stateOf(OWNER_SCOPE)).toBe('voided');
  });
});

// ── review round 1 fixes ────────────────────────────────────────────────────────────────────────────────────────────────

/** A selector that answers the given providers in call order (the readiness of the covered reads is asked once per read, in plan order). */
function inOrder(...providers: AiProvider[]): ProviderSelector {
  let calls = 0;
  return { select: async () => providers[Math.min(calls++, providers.length - 1)] as AiProvider, isStillEligible: () => true };
}
const askWith = (selector: ProviderSelector, extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute => ({ selector, recipientLabel: label, askSummaryConsent: true, ...extra });

describe('review fix: the consent token has one maker and it takes only a genuine bound consent for exactly its scope', () => {
  const fixture = { recipient: 'Claude', reads: [{ entryId: 'mail.list' as const, itemIds: ['m1', 'm2'] }] };
  const mint = (overrides: Partial<Parameters<typeof mintSummaryConsentToken>[0]> = {}, bound = boundConsentFor(fixture)) =>
    mintSummaryConsentToken({ bound: bound.bound, runRef: bound.runRef, run: RUN, step: 1, reads: fixture.reads, ...overrides });
  const SC: SummaryConsentScope = { run: RUN, step: 1, covered: [{ entryId: 'mail.list', itemIds: ['m1', 'm2'] }] };
  const label1 = { egress: 'REMOTE_ON_SUMMARY_REQUEST' as const, needsGrant: true, granted: true, askedItems: 2 };

  it('a bound yes of the store mints a token that admits REMOTE for exactly that run, step and ids', () => {
    const token = mint();
    expect(token).toBeDefined();
    expect(deriveM2Localities({ ...label1, consent: token, consentScope: SC })).toEqual({ ok: true, localities: ['LOCAL', 'REMOTE'] });
    expect(deriveM2Localities({ ...label1, consent: token, consentScope: { ...SC, step: 2 } })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ ...label1, consent: token, consentScope: { ...SC, run: newSummaryRunToken() } })).toEqual({ ok: true, localities: ['LOCAL'] });
    expect(deriveM2Localities({ ...label1, consent: token, consentScope: { ...SC, covered: [{ entryId: 'mail.list', itemIds: ['m1', 'm2', 'm3'] }] } })).toEqual({ ok: true, localities: ['LOCAL'] });
  });

  it('a forged or copied bound consent, a claim, an open step and a non-bound value mint nothing', () => {
    const real = boundConsentFor(fixture);
    expect(mint({}, { bound: { ...real.bound }, runRef: real.runRef })).toBeUndefined();
    expect(mint({}, { bound: { pending: real.bound.pending, boundAtMs: 1 } as never, runRef: real.runRef })).toBeUndefined();
    expect(mint({}, { bound: real.bound.pending as never, runRef: real.runRef })).toBeUndefined();
    for (const bound of [undefined, null, 'yes', {}] as const) expect(mint({}, { bound: bound as never, runRef: real.runRef })).toBeUndefined();
  });

  it('single use: the same bound consent mints once', () => {
    const bound = boundConsentFor(fixture);
    expect(mint({}, bound)).toBeDefined();
    expect(mint({}, bound)).toBeUndefined();
  });

  it('a topic consent mints nothing', () => {
    const store = new ConsentPendingStore();
    const scope = { actorId: 'a', conversationKey: 'c' };
    store.open(topicConsentPending({ scope, language: 'en', createdAtMs: 0, recipient: 'Claude', topic: 'x' }));
    const claimed = store.claim(scope, 1);
    if (!claimed.ok) throw new Error('claim');
    const bound = store.bind(claimed.claim, 2);
    expect(mint({}, { bound: bound as never, runRef: 'x' })).toBeUndefined();
  });

  it('the scope must be exactly what was asked: another runRef, a missing, extra or unknown id, a missing or extra source, a bad step', () => {
    expect(mint({ runRef: 'other-run' })).toBeUndefined();
    expect(mint({ reads: [{ entryId: 'mail.list', itemIds: ['m1'] }] })).toBeUndefined();
    expect(mint({ reads: [{ entryId: 'mail.list', itemIds: ['m1', 'm2', 'm3'] }] })).toBeUndefined();
    expect(mint({ reads: [{ entryId: 'mail.list', itemIds: ['m1', 'm9'] }] })).toBeUndefined();
    expect(mint({ reads: [{ entryId: 'drive.files', itemIds: ['m1', 'm2'] }] })).toBeUndefined();
    expect(mint({ reads: [...fixture.reads, { entryId: 'drive.files', itemIds: ['f1'] }] })).toBeUndefined();
    expect(mint({ reads: [] })).toBeUndefined();
    expect(mint({ step: 0 })).toBeUndefined();
  });

  it('two reads of one source union to the recorded ids (jira.issues and jira.release share the source jira)', () => {
    const jira = { recipient: 'Claude', reads: [{ entryId: 'jira.issues' as const, itemIds: ['AB-1', 'AB-2'] }, { entryId: 'jira.release' as const, itemIds: ['AB-2', 'AB-3'] }] };
    const bound = boundConsentFor(jira);
    expect(mintSummaryConsentToken({ bound: bound.bound, runRef: bound.runRef, run: RUN, step: 1, reads: [jira.reads[0] as (typeof jira.reads)[number]] })).toBeUndefined();
    const again = boundConsentFor(jira);
    expect(mintSummaryConsentToken({ bound: again.bound, runRef: again.runRef, run: RUN, step: 1, reads: jira.reads })).toBeDefined();
  });

  it('the recipient is re-checked at dispatch: a token of the asked recipient does not send to another one', async () => {
    const remote = fake('remote-b', 'REMOTE');
    const outcome = await quarantinedSummarize({ ...base, sources: [mailSource(doc(1))], route: route([remote], { recipientLabel: label }), consent: tokenFor('Claude') });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('no allow-all or test-only token maker exists: the module exports neither', async () => {
    const exported = await import('./quarantined-summary');
    expect(Object.keys(exported).filter((name) => /AllowAll|ConsentTokenForTest/u.test(name))).toEqual([]);
    expect(typeof exported.mintSummaryConsentToken).toBe('function');
  });
});

describe('review fix: no body is fetched before the question when any covered read of the step asks', () => {
  const local = (): Fake => fake('local-a', 'LOCAL', 20);
  const remote = (): Fake => fake('remote-a', 'REMOTE', 10);
  const plan2 = () => plan([wideRead('mail.list', 2), wideRead('drive.files', 2), summarize([1, 2])]);

  it.each([
    ['a LOCAL-ready read first, then a REMOTE one', () => inOrder(local(), remote())],
    ['a REMOTE read first, then a LOCAL-ready one', () => inOrder(remote(), local())],
  ])('%s: neither read requests withDocuments, no M2 call, and the question counts only the asking read', async (_name, selector) => {
    setSummaryGrantsForTest(() => true);
    const mail = port(['m1', 'm2']);
    const drive = port(['file-aaaa1', 'file-aaaa2']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail, 'drive.files': drive }, summarizer: askWith(selector()) }).execute(plan2());
    expect(mail.requests[0]?.withDocuments).toBeUndefined();
    expect(drive.requests[0]?.withDocuments).toBeUndefined();
    expect(result.usage.m2Calls).toBe(0);
    const step = result.steps[2];
    expect(step).toMatchObject({ status: 'consent-needed', recipient: 'Claude' });
    if (step?.kind !== 'summarize' || step.status !== 'consent-needed') throw new Error('status');
    expect(step.sources).toHaveLength(1);
  });

  it('a step whose reads all resolve LOCAL still fetches bodies (flag on loses no LOCAL summary)', async () => {
    setSummaryGrantsForTest(() => true);
    const mail = port(['m1', 'm2']);
    const drive = port(['file-aaaa1', 'file-aaaa2']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail, 'drive.files': drive }, summarizer: askWith(inOrder(local())) }).execute(plan2());
    expect(mail.requests[0]?.withDocuments).toBe(true);
    expect(drive.requests[0]?.withDocuments).toBe(true);
    expect(result.steps[2]?.status).not.toBe('consent-needed');
  });
});

describe('review fix: reads are grouped by source, not by entry', () => {
  const remote = (): Fake => fake('remote-a', 'REMOTE', 10, { dataUse: 'no-training' });

  it('jira.issues and jira.release (one source) make one question with the merged ids in plan order, and keep the reads', async () => {
    setSummaryGrantsForTest(() => true);
    const issues = port(['AB-1', 'AB-2']);
    const release = port(['AB-2', 'AB-3']);
    const result = await new AgentPlanExecutor({ readers: { 'jira.issues': issues, 'jira.release': release }, summarizer: askWith(inOrder(remote()), { workSummarySources: ['jira'] }) }).execute(
      plan([wideRead('jira.issues', 2), wideRead('jira.release', 2), summarize([1, 2])]),
    );
    expect(result.steps[2]).toEqual({
      step: 3,
      kind: 'summarize',
      status: 'consent-needed',
      from: [1, 2],
      schema: 'digest.v1',
      recipient: 'Claude',
      sources: [
        {
          source: 'jira',
          itemIds: ['AB-1', 'AB-2', 'AB-3'],
          reads: [
            { step: 1, entryId: 'jira.issues', itemIds: ['AB-1', 'AB-2'] },
            { step: 2, entryId: 'jira.release', itemIds: ['AB-2', 'AB-3'] },
          ],
        },
      ],
    });
    expect(issues.requests[0]?.withDocuments).toBeUndefined();
    expect(release.requests[0]?.withDocuments).toBeUndefined();
  });

  it('a second mail.list read is not dropped: the question counts both reads', async () => {
    setSummaryGrantsForTest(() => true);
    const first = port(['m1', 'm2']);
    const second = port(['m3', 'm4', 'm5']);
    let call = 0;
    const router: Partial<Record<NlWave1EntryId, AgentReadPort>> = { 'mail.list': { read: async (request) => (call++ === 0 ? first : second).read(request) } };
    const result = await new AgentPlanExecutor({ readers: router, summarizer: askWith(inOrder(fake('remote-a', 'REMOTE'))) }).execute(
      plan([wideRead('mail.list', 2), wideRead('mail.list', 3), summarize([1, 2])]),
    );
    const step = result.steps[2];
    if (step?.kind !== 'summarize' || step.status !== 'consent-needed') throw new Error(`status ${JSON.stringify(step)}`);
    expect(step.sources).toEqual([
      { source: 'mail', itemIds: ['m1', 'm2', 'm3', 'm4', 'm5'], reads: [{ step: 1, entryId: 'mail.list', itemIds: ['m1', 'm2'] }, { step: 2, entryId: 'mail.list', itemIds: ['m3', 'm4', 'm5'] }] },
    ]);
    expect(renderSummaryConsentQuestion({ language: 'ko', recipient: step.recipient, sources: step.sources.map((entry) => ({ source: entry.source, count: entry.itemIds.length })) })).toContain('메일 5건');
  });

  it('past the item cap of one question the step is listing-only with its own reason, nothing fetched', async () => {
    setSummaryGrantsForTest(() => true);
    const ids = (from: number) => Array.from({ length: 10 }, (_, i) => `m${from + i}`);
    let call = 0;
    const ports = [port(ids(1)), port(ids(11))];
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': { read: async (request) => (ports[call++] as SpyPort).read(request) } }, summarizer: askWith(inOrder(fake('remote-a', 'REMOTE'))) }).execute(
      plan([wideRead('mail.list', 10), wideRead('mail.list', 10), summarize([1, 2])]),
    );
    expect(result.steps[2]).toMatchObject({ status: 'listing-only', reason: 'consent-too-many-items' });
    for (const spyPort of ports) expect(spyPort.requests[0]?.withDocuments).toBeUndefined();
  });

  it('the recipient split considers every read, also a second read of the same source', async () => {
    setSummaryGrantsForTest(() => true);
    let call = 0;
    const ports = [port(['m1']), port(['m2'])];
    const result = await new AgentPlanExecutor({
      readers: { 'mail.list': { read: async (request) => (ports[call++] as SpyPort).read(request) } },
      summarizer: askWith(inOrder(fake('remote-a', 'REMOTE'), fake('remote-b', 'REMOTE'))),
    }).execute(plan([wideRead('mail.list', 1), wideRead('mail.list', 1), summarize([1, 2])]));
    expect(result.steps[2]).toMatchObject({ status: 'listing-only', reason: 'consent-recipient-split' });
  });
});

describe('review fix: a REMOTE provider with no recipient name falls back to the guarded LOCAL selection', () => {
  it('ask mode keeps the LOCAL summary the switch-off behaviour would give', async () => {
    setSummaryGrantsForTest(() => true);
    const unnamed = fake('remote-x', 'REMOTE', 30);
    const local = fake('local-a', 'LOCAL', 10);
    const mail = port(['m1']);
    const result = await new AgentPlanExecutor({ readers: { 'mail.list': mail }, summarizer: ask([unnamed, local]) }).execute(plan([wideRead('mail.list', 1), summarize([1])]));
    expect(mail.requests[0]?.withDocuments).toBe(true);
    expect(result.steps[1]).toMatchObject({ status: 'ok', audits: [{ locality: 'LOCAL' }] });
    expect(unnamed.requests).toHaveLength(0);
    expect(local.requests).toHaveLength(1);
  });
});

describe('review fix: the continuation record never outlives a step that did not open', () => {
  it('a store that throws on open: listing-only (consent-unavailable), no record, no question', async () => {
    const s = service();
    s.store.open = () => {
      throw new Error('store');
    };
    const reply = replyOf(await s.service.runActive(turn(s), async () => CHAT));
    expect(reply.parts.some((part) => part.kind === 'consent')).toBe(false);
    expect(reply.text).toContain('여쭤볼 수 없어서');
    expect((s.service as unknown as { continuations: Map<string, unknown> }).continuations.size).toBe(0);
    expect(s.logs.find((log) => log.event === 'agent_run.consent')?.fields).toMatchObject({ outcome: 'declined', reason: 'failed' });
  });
});

describe('review fix: the question version and the classifier placeholders', () => {
  it('the question carries a version (bumped by any wording change; A6-S4 binds it) and both count placeholders are exported', () => {
    expect(SUMMARY_CONSENT_QUESTION_VERSION).toBe('summary-consent-question.v1');
    expect(CONSENT_COUNT_PLACEHOLDER_KO).toBe('{개수}');
    expect(CONSENT_COUNT_PLACEHOLDER_EN).toBe('{count}');
    const sources = [{ source: 'mail' as const }];
    expect(consentClassifierQuestion({ kind: 'summary-consent', language: 'ko', recipient: 'Claude', sources })).toContain(CONSENT_COUNT_PLACEHOLDER_KO);
    expect(consentClassifierQuestion({ kind: 'summary-consent', language: 'en', recipient: 'Claude', sources })).toContain(CONSENT_COUNT_PLACEHOLDER_EN);
  });
});
