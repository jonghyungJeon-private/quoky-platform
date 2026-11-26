import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capability, type Actor } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { AgentWriteProposalPort, AgentWriteProposalRequest, AgentWriteProposalResult } from '../../ports/agent-write-proposal.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_ACTION_ENTRIES } from '../nl-routing/action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { messageBody } from '../message-rendering';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { A7_DRAFT_STEP, AGENT_A7_AUDIT_EVENT, renderA7WaitLine, runA7ProposeStep } from './a7-propose';
import { AgentRunService, type AgentActiveTurn } from './agent-run-service';
import type { AgentCrossWriteContext } from './cross-write';
import type { ValidatedCrossWritePlan } from './cross-write-validator';
import { renderDraftConsentQuestion, DRAFT_CONSENT_QUESTION_VERSION } from './draft-consent-question';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadRequest } from './plan-executor';
import { parseAgentPlanOutput } from './plan-schema';
import { validateAgentPlan } from './plan-validator';
import type { QuarantinedSummarizerRoute } from './quarantined-summary';
import { AgentRunBudget } from './run-bounds';
import { consentTokenFor } from './summary-consent.test-support';
import { renderSummaryConsentQuestion, SUMMARY_CONSENT_QUESTION_VERSION } from './summary-consent-question';

// ADR-0121 A7-S4a: the A7 propose step (READ -> consent -> quarantined draft -> the proposal port) with a fake port, a fake read port and
// stub providers. No model, no network. The card itself is the port implementation's (agent-write-proposal.test.ts).

const T0 = '2026-11-25T03:00:00.000Z';
const OWNER_TEXT = '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘';
const PLAN_JSON = JSON.stringify({
  steps: [{ entryId: 'slack.search', args: { keyword: '릴리즈' } }, { summarize: [1], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose', args: { issueKey: 'BE-123' } }],
  ambiguity: 'CLEAR',
});
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const OFFERED = new Map([...READS, ...Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined)].map((entry) => [entry.id, entry] as const));
const CONTEXT: AgentCrossWriteContext = { active: { jira: true, slack: true, calendar: true }, writers: { jira: true, slack: true, calendar: true }, jiraProjects: ['BE'], slackChannels: ['quoky-test'], sources: ['slack.search', 'jira.issues', 'jira.release'] };

function validatedPlan(text = OWNER_TEXT, json = PLAN_JSON): ValidatedCrossWritePlan {
  const parsed = parseAgentPlanOutput(json);
  if (parsed === null || parsed.kind !== 'steps') throw new Error('plan does not parse');
  const verdict = validateAgentPlan(parsed, { offered: OFFERED, groundingText: prepareSelectionInput(text).groundingText, now: T0 as never, timeZone: 'Asia/Seoul', direct: true, crossWrite: CONTEXT });
  if (!verdict.ok || verdict.plan.kind !== 'cross-write') throw new Error(`plan is not a cross-write plan: ${JSON.stringify(verdict)}`);
  return verdict.plan;
}

const AUTHORS = ['Dana Example', 'Lee Sample'];
const ITEMS = [
  { id: 'C0AA.1', text: 'release moved a day', author: AUTHORS[0] },
  { id: 'C0AA.2', text: 'BE-999 is blocked', author: AUTHORS[1] },
];
const GOOD = JSON.stringify({ lines: ['참여자 A가 릴리즈가 하루 밀렸다고 알렸다', 'BE-999 표기가 초안에 들어 있다', '참여자 B와 함께 확인 중이다'] });

interface Spy extends AiProvider {
  readonly requests: AiRequest[];
}
function spy(id: string, locality: AiExecutionLocality, text: string = GOOD): Spy {
  const requests: AiRequest[] = [];
  return {
    id,
    requests,
    executionLocality: locality,
    dataUse: 'no-training',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    isAvailable: async () => true,
    execute: async (request) => {
      requests.push(request);
      return { text };
    },
  };
}
const selectorOf = (...providers: Spy[]): ProviderSelector => ({
  select: async (_capability, context) => providers.find((provider) => (context?.allowedExecutionLocalities ?? []).includes(provider.executionLocality as AiExecutionLocality)),
  isStillEligible: () => true,
});

interface Parts {
  readonly requests: AgentWriteProposalRequest[];
  readonly reads: AgentReadRequest[];
  readonly logs: Array<{ event: string; fields: LogFields }>;
  readonly port: AgentWriteProposalPort;
  readonly opened: { target?: string };
  readonly logger: Logger;
  readonly readers: { 'slack.search': AgentReadPort };
}
function parts(result: AgentWriteProposalResult = { kind: 'carded', cardId: 'card-1', card: messageBody('CARD'), payloadSha256: 'a'.repeat(64) }): Parts {
  const requests: AgentWriteProposalRequest[] = [];
  const reads: AgentReadRequest[] = [];
  const logs: Array<{ event: string; fields: LogFields }> = [];
  const opened: { target?: string } = {};
  return {
    requests,
    reads,
    logs,
    opened,
    port: {
      openCardOf: async () => (opened.target !== undefined ? { cardId: 'open-1', target: opened.target } : undefined),
      propose: async (request) => {
        requests.push(request);
        return result;
      },
    },
    logger: { info: (event, fields) => void logs.push({ event, fields: fields ?? {} }), warn: () => undefined, error: () => undefined },
    readers: {
      'slack.search': {
        read: async (request) => {
          reads.push(request);
          if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
          return { ok: true, items: ITEMS.map((item) => ({ ...item })) };
        },
      },
    },
  };
}

function partsWith(items: ReadonlyArray<Record<string, unknown>>): Parts {
  const p = parts();
  return { ...p, readers: { 'slack.search': { read: async (request) => (p.reads.push(request), request.budget.reserveQuery() && request.budget.reserveHttp() ? { ok: true as const, items: items.map((item) => ({ ...item })) } : { ok: false as const, code: 'BOUND' as const }) } } };
}

function run(p: Parts, route: QuarantinedSummarizerRoute, over: Partial<Parameters<typeof runA7ProposeStep>[1]> = {}) {
  const executor = new AgentPlanExecutor({ readers: p.readers, logger: p.logger, summarizer: route });
  return runA7ProposeStep(
    { proposal: p.port, readSource: (step, options) => executor.readDraftSource(step, options), route, logger: p.logger },
    { plan: validatedPlan(), actorId: 'owner', sessionId: 'sess-1', language: 'ko', ownerText: { ...prepareSelectionInput(OWNER_TEXT), rawText: OWNER_TEXT }, now: T0 as never, budget: new AgentRunBudget(Date.now), alive: async () => true, ...over },
  );
}
const localRoute = (provider: Spy, extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute => ({ selector: selectorOf(provider), workSummarySources: ['slack'], ...extra });

describe('A7-S4a propose step, form a, LOCAL drafter', () => {
  it('reads, drafts once and hands the port ONE proposal: the owner-literal destination, the exact payload, content-free banner', async () => {
    const p = parts();
    const local = spy('local-a', 'LOCAL');
    const outcome = await run(p, localRoute(local));
    expect(outcome).toEqual({ kind: 'carded', card: messageBody('CARD'), cardId: 'card-1' });
    expect(local.requests).toHaveLength(1);
    expect(p.reads).toHaveLength(1);
    expect(p.requests).toHaveLength(1);
    const request = p.requests[0] as AgentWriteProposalRequest;
    expect(request).toMatchObject({ operation: 'jira-comment', target: { issueKey: 'BE-123' }, actorId: 'owner', sessionId: 'sess-1', grounding: 'owner-text', now: T0 });
    // The payload: the fixed provenance line, then the drafter's remapped, neutralised lines. The model never saw the real names.
    expect(request.payloadText.split('\n')).toEqual(['[Quoky 요약] 출처: Slack 메시지 2건', 'Dana Example가 릴리즈가 하루 밀렸다고 알렸다', 'BE-999 표기가 초안에 들어 있다', 'Lee Sample와 함께 확인 중이다']);
    expect((local.requests[0] as AiRequest).prompt).not.toMatch(/Dana|Lee Sample/u);
    expect(request.named).toBe(2);
    expect(request.nonTargets).toEqual(['BE-999']);
    expect(request.banner).toEqual({ source: { entryId: 'slack.search', query: '릴리즈' }, items: [{ id: 'C0AA.1' }, { id: 'C0AA.2' }], dropped: 0, omitted: 0, drafter: { locality: 'LOCAL' } });
    // The banner and the audit hold no content: no body, no name, no draft line.
    const text = JSON.stringify([request.banner, p.logs]);
    expect(text).not.toMatch(/Dana|Lee Sample|release moved|하루 밀렸/u);
  });

  it('writes one content-free audit record: plan kind, form, source entry, item count, dropped count, locality, consent, card id, decision, outcome', async () => {
    const p = parts();
    await run(p, localRoute(spy('local-a', 'LOCAL')));
    const lines = p.logs.filter((log) => log.event === AGENT_A7_AUDIT_EVENT);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toEqual({ planKind: 'cross-write', form: 'a', decision: 'pending', grounding: 'owner-text', sourceEntry: 'slack.search', items: 2, dropped: 0, omitted: 0, drafterLocality: 'LOCAL', consent: 'not-needed', cardId: 'card-1', outcome: 'carded' });
    expect(JSON.stringify(lines)).not.toMatch(/BE-123|BE-999/u);
  });

  it('one open A7 card: nothing is read or drafted, and the fixed wait line names both real keys', async () => {
    const p = parts();
    p.opened.target = 'BE-122';
    const local = spy('local-a', 'LOCAL');
    const outcome = await run(p, localRoute(local));
    expect(outcome).toEqual({ kind: 'wait', text: "BE-122 카드를 먼저 승인하거나 취소해 주세요. 그다음 'BE-123에도 달아줘'라고 하시면 같은 내용으로 새 초안을 만들게요" });
    expect(renderA7WaitLine('ko', 'BE-122', 'BE-123')).toBe((outcome as { text: string }).text);
    expect(p.reads).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('a wait answered by the port itself (a card opened meanwhile) is the same wait line', async () => {
    const p = parts({ kind: 'wait-open-card', openTarget: 'BE-100' });
    const outcome = await run(p, localRoute(spy('local-a', 'LOCAL')));
    expect(outcome).toMatchObject({ kind: 'wait', text: expect.stringContaining('BE-100 카드를 먼저') });
  });

  it('the kill switch: stopped before the read makes no read and no call; stopped during the draft makes no card', async () => {
    const before = parts();
    const local = spy('local-a', 'LOCAL');
    expect(await run(before, localRoute(local), { alive: async () => false })).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(before.reads).toHaveLength(0);
    expect(local.requests).toHaveLength(0);

    const during = parts();
    let probes = 0;
    // Probes of a full LOCAL run: open-card (2), before the read (1), the read's own (2: entry and after readiness), after the read (1), then
    // after the draft (1): the threshold stops exactly after the draft, so one draft was made and no proposal.
    const out = await run(during, localRoute(local), { alive: async () => (probes += 1) < 7 });
    expect(out).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(probes).toBe(7);
    expect(local.requests).toHaveLength(1);
    expect(during.requests).toHaveLength(0);
  });

  it('review round 5: stop then resume during the source read refuses stopped before the REMOTE consent question (no ask)', async () => {
    const p = parts();
    const remote = spy('remote-a', 'REMOTE');
    let probes = 0;
    // Probes 1-5 (open-card x2, before the read, the read's two) run; the sixth (right after the read) is the one that sees the epoch gone.
    const out = await run(p, localRoute(remote, { askSummaryConsent: true, recipientLabel: () => 'Remote Co' }), { alive: async () => (probes += 1) < 6 });
    expect(out).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(out.kind).not.toBe('ask');
    expect(probes).toBe(6);
    expect(remote.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('review round 5: a stop during the provider readiness await refuses stopped before the port read', async () => {
    const p = parts();
    const local = spy('local-a', 'LOCAL');
    let probes = 0;
    // The fifth probe is the one right after the readiness await, before the port read.
    const out = await run(p, localRoute(local), { alive: async () => (probes += 1) < 5 });
    expect(out).toMatchObject({ kind: 'refused', reason: 'stopped' });
    expect(p.reads).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('a refused draft (schema, credential, participants, link) makes no card; the owner gets the fixed not-made line', async () => {
    for (const text of ['not json', JSON.stringify({ lines: ['참여자 Z가 말했다'] }), JSON.stringify({ lines: [`키 ${'sk-' + 'b'.repeat(30)}`] })]) {
      const p = parts();
      const outcome = await run(p, localRoute(spy('local-a', 'LOCAL', text)));
      expect(outcome).toMatchObject({ kind: 'refused', reason: 'draft-refused', text: '초안으로 카드를 만들 수 없어서 만들지 않았어요. 아무것도 보내지 않았어요.' });
      expect(p.requests).toHaveLength(0);
    }
  });

  it('with the Slack summary switch off, no model is asked and nothing is carded', async () => {
    const p = parts();
    const local = spy('local-a', 'LOCAL');
    expect(await run(p, { selector: selectorOf(local) })).toMatchObject({ kind: 'refused', reason: 'work-text-controls-not-built' });
    expect(local.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('a port refusal (a payload that cannot be shown whole) is told with its fixed line; the model call is spent, nothing sent', async () => {
    const p = parts({ kind: 'refused', reason: 'payload-too-large' });
    const outcome = await run(p, localRoute(spy('local-a', 'LOCAL')));
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'payload-too-large', text: '초안이 한 장의 카드에 통째로 보여 드릴 수 없는 길이라서 카드를 만들지 않았어요. 아무것도 보내지 않았어요.' });
  });

  it('the M2 and model-call bounds of the run apply to the draft (no call left: nothing sent)', async () => {
    const p = parts();
    const local = spy('local-a', 'LOCAL');
    const budget = new AgentRunBudget(Date.now, { maxM2Calls: 0 });
    const outcome = await run(p, localRoute(local), { budget });
    expect(outcome.kind).toBe('refused');
    expect(local.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('only form a with an owner-literal Jira destination is runnable here (a Slack target, or a picked or missing destination, is unsupported)', async () => {
    const p = parts();
    const local = spy('local-a', 'LOCAL');
    const slack = validatedPlan('지라 이슈 요약해서 #quoky-test에 올려줘', JSON.stringify({ steps: [{ entryId: 'jira.issues', args: {} }, { summarize: [1], schema: 'payload-draft.v1' }, { propose: 'slack.post.propose', args: { channel: 'quoky-test' } }], ambiguity: 'CLEAR' }));
    expect(await run(p, localRoute(local), { plan: slack })).toMatchObject({ kind: 'refused', reason: 'unsupported' });
    const pick = validatedPlan('슬랙 릴리즈 요약해서 지라 티켓에 달아줘', JSON.stringify({ steps: [{ entryId: 'slack.search', args: { keyword: '릴리즈' } }, { summarize: [1], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose' }], ambiguity: 'CLEAR' }));
    expect(pick.destination.state).not.toBe('named');
    expect(await run(p, localRoute(local), { plan: pick })).toMatchObject({ kind: 'refused', reason: 'unsupported' });
    expect(p.reads).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
  });
});

describe('review round 1: the banner and the count are what was placed in the prompt', () => {
  const four = [1, 2, 3, 4].map((n) => ({ id: `C0AA.${n}`, text: `message number ${n}`, author: AUTHORS[0] }));

  it('a position gap (an item with no usable id) shifts nothing: the banner names the placed ids, the count is the placed count', async () => {
    const p = partsWith([four[0], { text: 'no id here', author: AUTHORS[1] }, four[2], four[3]] as never);
    const out = await run(p, localRoute(spy('local-a', 'LOCAL')));
    expect(out.kind).toBe('carded');
    const request = p.requests[0] as AgentWriteProposalRequest;
    expect(request.banner.items.map((item) => item.id)).toEqual(['C0AA.1', 'C0AA.3', 'C0AA.4']);
    expect(request.payloadText.split('\n')[0]).toBe('[Quoky 요약] 출처: Slack 메시지 3건');
  });

  it('a middle drop (an empty or credential-shaped readout) is not in the banner or the count, and the last item is not blamed', async () => {
    for (const middle of [{ id: 'C0AA.2', text: '', author: AUTHORS[1] }, { id: 'C0AA.2', text: `key ${'sk-' + 'c'.repeat(30)}`, author: AUTHORS[1] }]) {
      const p = partsWith([four[0], middle, four[2], four[3]] as never);
      const out = await run(p, localRoute(spy('local-a', 'LOCAL')));
      expect(out.kind).toBe('carded');
      const request = p.requests[0] as AgentWriteProposalRequest;
      expect(request.banner.items.map((item) => item.id)).toEqual(['C0AA.1', 'C0AA.3', 'C0AA.4']);
      expect(request.payloadText.split('\n')[0]).toBe('[Quoky 요약] 출처: Slack 메시지 3건');
      expect(request.banner).toMatchObject({ dropped: 0, omitted: 1 });
    }
  });
});

describe('A7-S4a rule ①: the destination clause (A7.5 step 4)', () => {
  const recipient = (): Partial<QuarantinedSummarizerRoute> => ({ askSummaryConsent: true, recipientLabel: () => 'Remote Co' });

  it('a REMOTE draft asks first, names the count, the recipient and the destination, and nothing is fetched, drafted or carded', async () => {
    const p = parts();
    const remote = spy('remote-a', 'REMOTE');
    const outcome = await run(p, localRoute(remote, recipient()));
    expect(outcome).toMatchObject({ kind: 'ask', question: 'Slack 메시지 2건을 Remote Co에 보내 BE-123 댓글 초안을 만들게요. 보낼까요? (응/아니)', recipient: 'Remote Co' });
    expect(remote.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
    expect(p.logs.find((log) => log.event === AGENT_A7_AUDIT_EVENT)?.fields).toMatchObject({ consent: 'asked', outcome: 'consent-asked', items: 2 });
  });

  it('after the owner\'s bound yes the same step drafts on the recipient asked about, and the card names that operator', async () => {
    const p = parts();
    const remote = spy('remote-a', 'REMOTE');
    const route = localRoute(remote, recipient());
    const asked = await run(p, route);
    if (asked.kind !== 'ask') throw new Error('not asked');
    const consent = consentTokenFor(asked.run, A7_DRAFT_STEP, { recipient: 'Remote Co', reads: [{ entryId: 'slack.search', itemIds: [...asked.itemIds] }] });
    const outcome = await run(p, route, { resume: { run: asked.run, consent, recorded: asked.itemIds, recipient: 'Remote Co', destination: asked.destination } });
    expect(outcome.kind).toBe('carded');
    expect(remote.requests).toHaveLength(1);
    expect(p.requests[0]?.banner.drafter).toEqual({ locality: 'REMOTE', operator: 'Remote Co' });
    expect(p.logs.filter((log) => log.event === AGENT_A7_AUDIT_EVENT).at(-1)?.fields).toMatchObject({ consent: 'granted', drafterLocality: 'REMOTE' });
  });

  it('review round 1 (Codex P2): a consent asked for BE-123 is refused for a BE-124 plan: no read, no call, no card', async () => {
    const p = parts();
    const remote = spy('remote-a', 'REMOTE');
    const route = localRoute(remote, recipient());
    const asked = await run(p, route);
    if (asked.kind !== 'ask') throw new Error('not asked');
    expect(asked.destination).toEqual({ operation: 'jira-comment', target: 'BE-123' });
    const consent = consentTokenFor(asked.run, A7_DRAFT_STEP, { recipient: 'Remote Co', reads: [{ entryId: 'slack.search', itemIds: [...asked.itemIds] }] });
    const other = validatedPlan('슬랙 릴리즈 대화 요약해서 BE-124에 달아줘', PLAN_JSON.replace('BE-123', 'BE-124'));
    const readsBefore = p.reads.length;
    const out = await run(p, route, { plan: other, resume: { run: asked.run, consent, recorded: asked.itemIds, recipient: 'Remote Co', destination: asked.destination } });
    expect(out).toMatchObject({ kind: 'refused', reason: 'consent-mismatch' });
    expect(p.reads).toHaveLength(readsBefore);
    expect(remote.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('review round 1 (a7-06): items that left between the ask and the draft are the drift line; the rest are the other cuts', async () => {
    const p = parts();
    const remote = spy('remote-a', 'REMOTE');
    const route = localRoute(remote, recipient());
    const asked = await run(p, route);
    if (asked.kind !== 'ask') throw new Error('not asked');
    const consent = consentTokenFor(asked.run, A7_DRAFT_STEP, { recipient: 'Remote Co', reads: [{ entryId: 'slack.search', itemIds: [...asked.itemIds] }] });
    const recorded = [...asked.itemIds, 'C0AA.gone'];
    const out = await run(p, route, { resume: { run: asked.run, consent, recorded, recipient: 'Remote Co', destination: asked.destination } });
    expect(out.kind).toBe('carded');
    expect(p.requests[0]?.banner).toMatchObject({ dropped: 1, omitted: 0 });
  });

  it('review round 2 (CA P3): an item still in the listing but dropped by validation is counted once (omitted), never also as drift', async () => {
    const full = [1, 2, 3].map((n) => ({ id: `C0AA.${n}`, text: `message number ${n}`, author: AUTHORS[n === 2 ? 1 : 0] }));
    const p = partsWith(full as never);
    const remote = spy('remote-a', 'REMOTE');
    const route = localRoute(remote, recipient());
    const asked = await run(p, route);
    if (asked.kind !== 'ask') throw new Error('not asked');
    const consent = consentTokenFor(asked.run, A7_DRAFT_STEP, { recipient: 'Remote Co', reads: [{ entryId: 'slack.search', itemIds: [...asked.itemIds] }] });
    // The same three ids are listed on the re-read, but the second row is credential-shaped now: the projection withholds it (it is not a validated document).
    const p2 = partsWith([full[0], { id: 'C0AA.2', text: `key ${'sk-' + 'c'.repeat(30)}`, author: AUTHORS[1] }, full[2]] as never);
    const out = await run(p2, route, { resume: { run: asked.run, consent, recorded: asked.itemIds, recipient: 'Remote Co', destination: asked.destination } });
    expect(JSON.stringify(out)).toContain('carded');
    expect(p2.requests[0]?.banner.items.map((item) => item.id)).toEqual(['C0AA.1', 'C0AA.3']);
    expect(p2.requests[0]?.banner).toMatchObject({ dropped: 0, omitted: 1 });
  });

  it('review round 1 (W2): another open owner step (a pending consent step, an approval) means no card and no read', async () => {
    const p = parts();
    const local = spy('local-a', 'LOCAL');
    expect(await run(p, localRoute(local), { ownerStepPending: true })).toMatchObject({ kind: 'refused', reason: 'owner-step-open' });
    expect(p.reads).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
  });

  it('a REMOTE provider without the ask mode is never used (LOCAL only): nothing is drafted', async () => {
    const p = parts();
    const remote = spy('remote-a', 'REMOTE');
    expect(await run(p, localRoute(remote, { recipientLabel: () => 'Remote Co' }))).toMatchObject({ kind: 'refused', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('is a new fixed version for the A7 draft only; summary-consent-question.v2 is unchanged', () => {
    expect(DRAFT_CONSENT_QUESTION_VERSION).toBe('draft-consent-question.v1');
    expect(SUMMARY_CONSENT_QUESTION_VERSION).toBe('summary-consent-question.v2');
    expect(renderSummaryConsentQuestion({ language: 'ko', recipient: 'Remote Co', sources: [{ source: 'slack', count: 3 }] })).toBe('슬랙 메시지 3건을 Remote Co에 보내 요약할게요. 보낼까요? (응/아니)');
    expect(renderDraftConsentQuestion({ language: 'ko', recipient: 'Remote Co', source: 'slack', count: 3, destination: 'BE-123' })).toBe('Slack 메시지 3건을 Remote Co에 보내 BE-123 댓글 초안을 만들게요. 보낼까요? (응/아니)');
    expect(renderDraftConsentQuestion({ language: 'en', recipient: 'Remote Co', source: 'jira', count: 1, destination: 'BE-123' })).toBe("I'll send 1 Jira issue to Remote Co to draft a comment for BE-123. Shall I send it? (yes/no)");
    // Closed input only: a free-text destination, an unknown source, a bad count or an empty recipient renders no question.
    for (const bad of [{ destination: 'be-123' }, { destination: 'BE-123 근데 이것도' }, { source: 'mail' as const }, { count: 0 }, { recipient: ' ' }]) {
      expect(renderDraftConsentQuestion({ language: 'ko', recipient: 'Remote Co', source: 'slack', count: 3, destination: 'BE-123', ...bad })).toBe('');
    }
  });
});

describe('A7-S4a is dormant: with the defaults nothing new runs', () => {
  afterEach(() => vi.restoreAllMocks());

  const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  const CHAT = { id: 'claude-family', locality: 'REMOTE' as AiExecutionLocality };
  function service(options: { readonly writeProposal?: AgentRunServiceProposal; readonly script: string[] }) {
    const planner: AiProvider = {
      id: 'scripted-planner',
      family: 'claude-family',
      capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
      isAvailable: async () => true,
      execute: async () => ({ text: options.script.shift() as string, artifacts: [] }),
    };
    const drafter = spy('local-a', 'LOCAL');
    const p = parts();
    const owner: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
    const live = new Map<string, Actor>([['owner', owner]]);
    const svc = new AgentRunService({
      mode: 'active',
      released: true,
      router: { select: async () => planner },
      actors: { get: async (id) => live.get(id) ?? null, save: async (actor) => (live.set(actor.id, actor), actor) },
      logger: p.logger,
      timeZone: 'Asia/Seoul',
      timeoutMs: 6_000,
      readers: p.readers,
      summarizer: new CapabilityRouter(new AiProviderManager([drafter]), policy),
      workSummarySources: ['slack'],
      crossWrite: CONTEXT,
      ...(options.writeProposal !== undefined ? { writeProposal: { port: p.port, targets: options.writeProposal.targets } } : {}),
    });
    const turn: AgentActiveTurn = { text: OWNER_TEXT, attachmentCount: 0, actor: owner, now: T0 as never, entries: READS, direct: true, sessionId: 'session-1' };
    return { svc, turn, drafter, p, live };
  }
  type AgentRunServiceProposal = { readonly targets: readonly 'jira-comment'[] };

  it('without the writeProposal dep a validated A7 plan is declined cross-write-off, and none of the new code runs (spy)', async () => {
    const read = vi.spyOn(AgentPlanExecutor.prototype, 'readDraftSource');
    const { svc, turn, drafter, p } = service({ script: [PLAN_JSON] });
    expect(await svc.runActive(turn, async () => CHAT)).toEqual({ kind: 'declined', reason: 'cross-write-off' });
    expect(read).not.toHaveBeenCalled();
    expect(p.reads).toHaveLength(0);
    expect(drafter.requests).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  it('an empty target list is the same refusal', async () => {
    const read = vi.spyOn(AgentPlanExecutor.prototype, 'readDraftSource');
    const { svc, turn } = service({ script: [PLAN_JSON], writeProposal: { targets: [] } });
    expect(await svc.runActive(turn, async () => CHAT)).toEqual({ kind: 'declined', reason: 'cross-write-off' });
    expect(read).not.toHaveBeenCalled();
  });

  it('with the dep and the target switched on (only a test can build it) the active run ends in a proposal outcome', async () => {
    const { svc, turn, drafter, p } = service({ script: [PLAN_JSON], writeProposal: { targets: ['jira-comment'] } });
    const outcome = await svc.runActive(turn, async () => CHAT);
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded', cardId: 'card-1' } });
    expect(drafter.requests).toHaveLength(1);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]?.target).toEqual({ issueKey: 'BE-123' });
  });

  it('the kill switch stops the run before any read', async () => {
    const { svc, turn, p, live } = service({ script: [PLAN_JSON], writeProposal: { targets: ['jira-comment'] } });
    live.set('owner', { ...turn.actor, metadata: { 'quoky.actionSwitch': { state: 'stopped', at: T0 } } });
    expect(await svc.runActive(turn, async () => CHAT)).toEqual({ kind: 'declined', reason: 'kill-switch' });
    expect(p.reads).toHaveLength(0);
  });
});
