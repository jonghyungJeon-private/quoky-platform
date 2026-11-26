import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capability, type Actor } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { AgentCardClosureState, AgentWriteProposalPort, AgentWriteProposalRequest, AgentWriteProposalResult } from '../../ports/agent-write-proposal.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { messageBody } from '../message-rendering';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import { isPickedA7Destination } from './a7-pick';
import { runA7ProposeStep } from './a7-propose';
import { AgentRunService, type A7TurnFacts, type AgentActiveTurn } from './agent-run-service';
import type { AgentCrossWriteContext } from './cross-write';
import { readA7State, withA7State, withCardClosingTurn, type A7StateGuard } from './held-receipt-store';
import { buildHeldReceipt, HELD_RECEIPT_METADATA_KEY } from './held-receipt';
import { AgentPlanExecutor, type AgentReadPort, type AgentReadRequest } from './plan-executor';

// ADR-0121 A7-S4b: the destination listing and pick (A7.4b), the frozen receipt, the a7-09 project-first flow, the closed-card carry-over and
// the dormancy pins, through the real AgentRunService with a fake port, fake read ports and stub providers. No model, no network.

// Pass-through spies on the state reader and writer: the dormancy pin below can fail if a default path ever reaches them.
vi.mock('./held-receipt-store', async (original) => {
  const actual = await original<typeof import('./held-receipt-store')>();
  return { ...actual, readA7State: vi.fn(actual.readA7State), withA7State: vi.fn(actual.withA7State) };
});

const GUARD: A7StateGuard = { bootId: 'boot-1' };
const T0 = '2026-11-26T03:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const CHAT = { id: 'claude-family', locality: 'REMOTE' as AiExecutionLocality };
const CONVERSATION = 'dm|space|channel|thread';
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ctx = (jiraProjects: string[] = ['BE']): AgentCrossWriteContext => ({ active: { jira: true, slack: true, calendar: true }, writers: { jira: true, slack: true, calendar: true }, jiraProjects, slackChannels: ['quoky-test'], sources: ['slack.search', 'jira.issues', 'jira.release'] });

const FORM_A_TEXT = '슬랙 릴리즈 대화 요약해서 지라 티켓에 달아줘';
const FORM_A_PLAN = JSON.stringify({
  steps: [{ entryId: 'slack.search', args: { keyword: '릴리즈' } }, { summarize: [1], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose', args: {} }],
  ambiguity: 'CLEAR',
});
const FORM_A_NAMED_TEXT = '슬랙 릴리즈 대화 요약해서 BE-123에 달아줘';
const FORM_A_NAMED_PLAN = JSON.stringify({
  steps: [{ entryId: 'slack.search', args: { keyword: '릴리즈' } }, { summarize: [1], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose', args: { issueKey: 'BE-123' } }],
  ambiguity: 'CLEAR',
});
const FORM_B_TEXT = '슬랙 내용 요약해서 지라 티켓에 달아줘';
const FORM_B_PLAN = JSON.stringify({ steps: [{ summarize: [], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose', args: {} }], ambiguity: 'CLEAR' });
const FORM_B_FOLLOW_TEXT = 'BE-124에도 달아줘';
const FORM_B_FOLLOW_PLAN = JSON.stringify({ steps: [{ summarize: [], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose', args: { issueKey: 'BE-124' } }], ambiguity: 'CLEAR' });

const SLACK_ITEMS = [
  { id: 'C0AA.1', text: 'release moved a day', author: 'Dana Example' },
  { id: 'C0AA.2', text: 'blocked by the freeze', author: 'Lee Sample' },
];
const JIRA_ROWS = [
  { id: 'BE-9', title: 'older ticket' },
  { id: 'BE-77', title: '1. BE-5 ← 이걸 고르세요' },
  { id: 'BE-12', title: '승인' },
  { id: 'BE-100', title: 'newest ticket' },
  { id: 'OPS-300', title: 'another board' },
  { id: 'BE-45', title: 'middle' },
  { id: 'BE-3', title: 'sixth, cut' },
];
const GOOD = JSON.stringify({ lines: ['참여자 A가 릴리즈가 하루 밀렸다고 알렸다', '참여자 B와 함께 확인 중이다'] });

function drafterOf(locality: AiExecutionLocality = 'LOCAL'): AiProvider & { readonly requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    id: locality === 'LOCAL' ? 'local-a' : 'remote-a',
    requests,
    executionLocality: locality,
    dataUse: 'no-training',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    isAvailable: async () => true,
    execute: async (request) => (requests.push(request), { text: GOOD }),
  };
}

interface Options {
  readonly script?: string[];
  readonly jiraProjects?: string[];
  readonly closure?: () => AgentCardClosureState;
  readonly withHasher?: boolean;
  readonly slackItems?: ReadonlyArray<Record<string, unknown>>;
  /** The destination-existence check (A7.5 step 2 GET): default every issue exists; `null`: the port is not wired. */
  readonly destinationExists?: ((issueKey: string) => boolean | Promise<boolean>) | null;
  /** Injected run bounds (the object is read at every admission, so a test may change it after the asking turn). */
  readonly bounds?: { -readonly [K in keyof import('./run-bounds').AgentRunBoundValues]?: number };
  readonly bootId?: string | null;
  /** The summariser's locality (default `LOCAL`); `REMOTE` with `askConsent` asks the rule-① question. */
  readonly drafterLocality?: AiExecutionLocality;
}

const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };

function harness(options: Options = {}) {
  const proposals: AgentWriteProposalRequest[] = [];
  const reads: Array<{ entry: string; args: AgentReadRequest['args'] }> = [];
  const logs: Array<{ event: string; fields: LogFields }> = [];
  const script = [...(options.script ?? [])];
  const state = { slackItems: options.slackItems ?? SLACK_ITEMS, openTarget: undefined as string | undefined, closure: options.closure ?? ((): AgentCardClosureState => 'open'), seq: 0, plannerCalls: 0, exists: options.destinationExists ?? (() => true), checks: [] as string[], hooks: {} as { planner?: () => void; sourceRead?: () => void; openCard?: () => void; afterActorGet?: (n: number) => void }, actorGets: 0 };
  const port: AgentWriteProposalPort = {
    openCardOf: async () => (state.hooks.openCard?.(), state.openTarget !== undefined ? { cardId: 'open-1', target: state.openTarget } : undefined),
    closureOf: async () => state.closure(),
    propose: async (request): Promise<AgentWriteProposalResult> => {
      proposals.push(request);
      state.seq += 1;
      return { kind: 'carded', cardId: `card-${state.seq}`, taskId: `task-${state.seq}`, card: messageBody('CARD'), payloadSha256: 'a'.repeat(64) };
    },
  };
  const slack: AgentReadPort = {
    read: async (request) => {
      reads.push({ entry: request.entryId, args: request.args });
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      const items = state.slackItems.map((item) => ({ ...item }));
      state.hooks.sourceRead?.();
      return { ok: true, items };
    },
  };
  const jira: AgentReadPort = {
    read: async (request) => {
      reads.push({ entry: request.entryId, args: request.args });
      if (!request.budget.reserveQuery() || !request.budget.reserveHttp()) return { ok: false, code: 'BOUND' };
      return { ok: true, items: JIRA_ROWS.map((row) => ({ ...row })) };
    },
  };
  const logger: Logger = { info: (event, fields) => void logs.push({ event, fields: fields ?? {} }), warn: () => undefined, error: () => undefined };
  const planner: AiProvider = {
    id: 'scripted-planner',
    family: 'claude-family',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async () => {
      state.plannerCalls += 1;
      state.hooks.planner?.();
      return { text: script.shift() as string, artifacts: [] };
    },
  };
  const drafter = drafterOf(options.drafterLocality);
  const owner: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
  const live = new Map<string, Actor>([['owner', owner]]);
  const svc = new AgentRunService({
    mode: 'active',
    released: true,
    router: { select: async () => planner },
    actors: {
      get: async (id) => {
        const found = live.get(id) ?? null;
        state.actorGets += 1;
        state.hooks.afterActorGet?.(state.actorGets);
        return found;
      },
      save: async (actor) => (live.set(actor.id, actor), actor),
    },
    logger,
    timeZone: 'Asia/Seoul',
    timeoutMs: 6_000,
    ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
    readers: { 'slack.search': slack, 'jira.issues': jira },
    summarizer: new CapabilityRouter(new AiProviderManager([drafter]), policy),
    workSummarySources: ['slack', 'jira'],
    crossWrite: ctx(options.jiraProjects),
    writeProposal: {
      port,
      targets: ['jira-comment'],
      ...(options.bootId === null ? {} : { bootId: options.bootId ?? 'boot-1' }),
      ...(options.destinationExists === null
        ? {}
        : { destinationCheck: { jiraIssueExists: async (key: string) => (state.checks.push(key), state.exists(key)), slackChannelIsPublic: async () => true } }),
      ...(options.withHasher === false ? {} : { sha256Hex }),
      ...(options.drafterLocality === 'REMOTE' ? { askConsent: true } : {}),
    },
    ...(options.drafterLocality === 'REMOTE' ? { recipientLabel: () => 'Remote AI' } : {}),
  });
  const turn = (text: string, facts: A7TurnFacts, now = T0, over: Partial<AgentActiveTurn> = {}): AgentActiveTurn => ({
    text,
    attachmentCount: 0,
    actor: owner,
    now: now as never,
    entries: READS,
    direct: true,
    sessionId: 'session-1',
    conversationKey: CONVERSATION,
    a7: facts,
    ...over,
  });
  const pickTurn = (text: string, facts: A7TurnFacts, now = T0, over: Record<string, unknown> = {}) => ({ text, actor: owner, now: now as never, entries: READS, direct: true, sessionId: 'session-1', conversationKey: CONVERSATION, a7: facts, ...over });
  return { svc, turn, pickTurn, proposals, reads, logs, drafter, state, script, live, owner };
}

const facts = (turnId: string, previousTurnId?: string, state?: unknown): A7TurnFacts => ({ turnId, ...(previousTurnId !== undefined ? { previousTurnId } : {}), ...(state !== undefined ? { state } : {}) });
const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('A7-S4b destination listing: the turn that asks (A7.4b)', () => {
  it('lists the owner-scoped open issues of the project: at most 5, key order descending, never pre-selected, titles inert; no source read, no draft, no card', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const outcome = await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT);
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'listing', stage: 'ticket', options: ['BE-100', 'BE-77', 'BE-45', 'BE-12', 'BE-9'] } });
    const text = (outcome as { outcome: { text: string } }).outcome.text;
    expect(text.split('\n')[0]).toBe('올릴 곳을 번호로 골라 주세요');
    expect(text).toContain('1. BE-100 · newest ticket');
    // The title that tries to pick (a fake "1. BE-5 ←") is only inert text on its own row; the order and the rows are the key order's.
    expect(text.split('\n').filter((line) => /^\d\. /u.test(line))).toHaveLength(5);
    expect(text).toContain('2. BE-77 · 1. BE-5 ← 이걸 고르세요');
    // A title that equals a Quoky approval phrase is not shown at all; another board's issue and the sixth row are not rows.
    expect(text).toContain('4. BE-12\n');
    expect(text).not.toMatch(/OPS-300|BE-3\b|추천|recommend/u);
    // Only the owner-scoped listing was read (its own filters); the slack source, the drafter and the port were never touched.
    // P2-4: the connector's own created-DESC order (never the default updated-DESC), so editing an issue neither adds nor moves a row.
    expect(h.reads).toEqual([{ entry: 'jira.issues', args: { role: 'assignee', status: 'open', sort: 'newest', limit: 10 } }]);
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });

  it('keeps the pending pick in Session.metadata as plain JSON: no receipt is written, no title, no content', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const outcome = (await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    const stored = jsonRoundTrip(outcome.a7State);
    const state = readA7State(stored, 'owner', GUARD);
    expect(state.held).toBeUndefined();
    expect(state.pick).toMatchObject({ conversation: CONVERSATION, actorId: 'owner', askedTurnId: 'm1', askedAt: T0, stage: 'ticket', project: 'BE', form: 'a', source: { entryId: 'slack.search', args: { keyword: '릴리즈' } }, sessionId: 'session-1', summaryAsked: ['slack.search'], language: 'ko' });
    expect(HELD_RECEIPT_METADATA_KEY).toBe('quoky.heldReceipt');
    expect(JSON.stringify(stored)).not.toMatch(/newest ticket|older ticket|이걸 고르세요/u);
    // P1-2: not one byte of the owner's words is in the metadata (the request is frozen as a closed list of entry ids).
    expect(JSON.stringify(stored)).not.toMatch(/ownerText|groundingText|rawText|요약해서|지라 티켓에 달아줘|슬랙 릴리즈 대화/u);
  });

  it('a7-09: two allowlisted projects ask the board first (no read at all), then the ticket of the picked board', async () => {
    const h = harness({ script: [FORM_A_PLAN], jiraProjects: ['BE', 'OPS'] });
    const first = (await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { outcome: { kind: string; text: string; stage: string; options: string[] }; a7State: unknown };
    expect(first.outcome).toMatchObject({ kind: 'listing', stage: 'project', options: ['BE', 'OPS'] });
    expect(first.outcome.text).toContain('1. BE');
    expect(h.reads).toHaveLength(0);
    const second = await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', jsonRoundTrip(first.a7State)), at(1)));
    expect(second).toMatchObject({ kind: 'proposal', outcome: { kind: 'listing', stage: 'ticket', options: ['OPS-300'] } });
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
    const state = readA7State(jsonRoundTrip((second as { a7State: unknown }).a7State), 'owner', GUARD);
    expect(state.pick).toMatchObject({ stage: 'ticket', project: 'OPS', askedTurnId: 'm2' });
    // Then the ticket: OPS-300 by number, a card for it.
    const third = await h.svc.continueA7Pick(h.pickTurn('1', facts('m3', 'm2', jsonRoundTrip((second as { a7State: unknown }).a7State)), at(2)));
    expect(third).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
    expect(h.proposals[0]).toMatchObject({ target: { issueKey: 'OPS-300' }, grounding: 'owner-picked' });
  });

  it('an empty listing says so with the fixed line and holds nothing', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const empty = vi.spyOn(AgentPlanExecutor.prototype, 'listDestinationRows').mockResolvedValue({ kind: 'ok', rows: [] });
    const outcome = await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT);
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'no-destination-rows' } });
    expect((outcome as { a7State?: unknown }).a7State).toBeUndefined();
    empty.mockRestore();
  });

  it('another open card: nothing is read (the wait line), and another owner step open: refused, nothing read (W2, turn.ownerStepPending reaches the step)', async () => {
    const waiting = harness({ script: [FORM_A_PLAN] });
    waiting.state.openTarget = 'BE-122';
    expect(await waiting.svc.runActive(waiting.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)).toMatchObject({ outcome: { kind: 'wait' } });
    expect(waiting.reads).toHaveLength(0);
    const busy = harness({ script: [FORM_A_PLAN] });
    expect(await busy.svc.runActive(busy.turn(FORM_A_TEXT, facts('m1'), T0, { ownerStepPending: true }), async () => CHAT)).toMatchObject({ outcome: { kind: 'refused', reason: 'owner-step-open' } });
    expect(busy.reads).toHaveLength(0);
    const named = harness({ script: [FORM_A_NAMED_PLAN] });
    expect(await named.svc.runActive(named.turn(FORM_A_NAMED_TEXT, facts('m1'), T0, { ownerStepPending: true }), async () => CHAT)).toMatchObject({ outcome: { kind: 'refused', reason: 'owner-step-open' } });
    expect(named.reads).toHaveLength(0);
    expect(named.proposals).toHaveLength(0);
  });
});

describe('A7-S4b the pick (OWNER_PICKED_DESTINATION)', () => {
  async function asked(h: ReturnType<typeof harness>) {
    const first = (await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    return jsonRoundTrip(first.a7State);
  }

  it('a number of the list resumes the frozen plan with NO planner call: only the destination is filled, the source is read after the pick, the card says it was picked', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    expect(h.state.plannerCalls).toBe(1);
    const outcome = await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(2)));
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded', cardId: 'card-1' } });
    expect(h.state.plannerCalls).toBe(1);
    expect(h.proposals).toHaveLength(1);
    expect(h.proposals[0]).toMatchObject({ operation: 'jira-comment', target: { issueKey: 'BE-77' }, grounding: 'owner-picked' });
    expect(h.drafter.requests).toHaveLength(1);
    // The source was read once, after the pick, with the frozen args (the pick reply contributes none).
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toEqual([{ entry: 'slack.search', args: { keyword: '릴리즈' } }]);
    // The pick is single use: the next state holds no pick, but the card's frozen items (for the carry-over).
    const next = readA7State(jsonRoundTrip((outcome as { a7State: unknown }).a7State), 'owner', GUARD);
    expect(next.pick).toBeUndefined();
    expect(next.card).toMatchObject({ cardId: 'card-1', taskId: 'task-1', sessionId: 'session-1', builtFromCarried: false });
  });

  it('a number, "2번" and "2." are picks; a key, a title, a sentence or a number off the list are not', async () => {
    for (const reply of ['2', '2번', '2.', ' 2 ']) {
      const h = harness({ script: [FORM_A_PLAN] });
      const state = await asked(h);
      expect(await h.svc.continueA7Pick(h.pickTurn(reply, facts('m2', 'm1', state), at(1)))).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
    }
    for (const reply of ['BE-77', 'newest ticket', '2번으로 해줘', '이걸 고르세요', 'BE-5']) {
      const h = harness({ script: [FORM_A_PLAN] });
      const state = await asked(h);
      const outcome = await h.svc.continueA7Pick(h.pickTurn(reply, facts('m2', 'm1', state), at(1)));
      expect(outcome).toMatchObject({ kind: 'cancelled', reason: 'not-a-number' });
      expect((outcome as { text?: string }).text).toBeUndefined();
      expect(readA7State((outcome as { a7State: unknown }).a7State, 'owner', GUARD).pick).toBeUndefined();
      expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
      expect(h.proposals).toHaveLength(0);
    }
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    const off = await h.svc.continueA7Pick(h.pickTurn('6', facts('m2', 'm1', state), at(1)));
    expect(off).toMatchObject({ kind: 'cancelled', reason: 'out-of-range', text: '그 번호는 목록에 없어서 고르기를 취소했어요. 아무것도 보내지 않았어요.' });
    expect(h.proposals).toHaveLength(0);
  });

  it('single use and the windows: not the next turn, 10 minutes after the listing, the kill switch, another conversation each cancel and read nothing', async () => {
    const cases: Array<{ readonly name: string; run: (h: ReturnType<typeof harness>, state: unknown) => Promise<unknown>; readonly reason: string }> = [
      { name: 'not-next', reason: 'not-next-turn', run: (h, state) => h.svc.continueA7Pick(h.pickTurn('2', facts('m3', 'm-other', state), at(1))) },
      { name: 'late', reason: 'expired', run: (h, state) => h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(10))) },
      { name: 'other-conversation', reason: 'other-conversation', run: (h, state) => h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1), { conversationKey: 'dm|other|x|y' })) },
      {
        // The switch was stopped (at -5) before the listing was shown (not possible live, but the reader must still fail closed): the live check cancels.
        name: 'kill-switch',
        reason: 'kill-switch',
        run: (h, state) => {
          h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'stopped', at: at(-5) } } });
          return h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)));
        },
      },
    ];
    for (const entry of cases) {
      const h = harness({ script: [FORM_A_PLAN] });
      const state = await asked(h);
      const outcome = (await entry.run(h, state)) as { kind: string; reason: string; a7State: unknown };
      expect(outcome, entry.name).toMatchObject({ kind: 'cancelled', reason: entry.reason });
      expect(readA7State(outcome.a7State, 'owner', GUARD).pick, entry.name).toBeUndefined();
      expect(h.reads.filter((read) => read.entry === 'slack.search'), entry.name).toHaveLength(0);
      expect(h.proposals, entry.name).toHaveLength(0);
    }
    // 9 minutes is still inside the window.
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    expect(await h.svc.continueA7Pick(h.pickTurn('1', facts('m2', 'm1', state), at(9)))).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
  });

  it('with no pending pick nothing happens; without the proposal dep a pending pick is declined and dropped', async () => {
    const h = harness();
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1')))).toEqual({ kind: 'not-pending' });
    const first = harness({ script: [FORM_A_PLAN] });
    const state = await asked(first);
    const bare = new AgentRunService({ mode: 'off', router: { select: async () => first.drafter }, actors: { get: async () => null, save: async (actor) => actor }, logger: { info: () => undefined, warn: () => undefined, error: () => undefined }, timeZone: 'Asia/Seoul' });
    // No proposal dep, so no boot id: the stored state is unreadable (void), and the caller routes the turn as an ordinary one.
    expect(await bare.continueA7Pick(first.pickTurn('2', facts('m2', 'm1', state), at(1)))).toEqual({ kind: 'not-pending' });
    // A boot id but no writer-side wiring of the read ports: declined and the pick dropped.
    const unwired = harness({ script: [FORM_A_PLAN] });
    const stored = await asked(unwired);
    (unwired.svc as unknown as { deps: { readers?: unknown } }).deps.readers = undefined;
    const declined = await unwired.svc.continueA7Pick(unwired.pickTurn('2', facts('m2', 'm1', stored), at(1)));
    expect(declined).toMatchObject({ kind: 'declined', reason: 'unwired' });
    expect(readA7State((declined as { a7State: unknown }).a7State, 'owner', GUARD).pick).toBeUndefined();
  });

  it('the picked value is issued only by the pick: a forged or copied value is refused by the propose step (no read, no call)', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    const forged = { trust: 'OWNER_PICKED_DESTINATION', kind: 'jira', issueKey: 'BE-999', project: 'BE' };
    expect(isPickedA7Destination(forged)).toBe(false);
    const captured: unknown[] = [];
    const spy = vi.spyOn(AgentPlanExecutor.prototype, 'readDraftSource');
    const outcome = await h.svc.continueA7Pick(h.pickTurn('1', facts('m2', 'm1', state), at(1)));
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
    captured.push(spy.mock.calls.length);
    spy.mockRestore();
    const plan = { kind: 'cross-write', form: 'a', target: 'jira.comment.propose', operation: 'ISSUE_COMMENT', destinationKind: 'jira', connectorCalls: 1, destination: { state: 'pick-ticket', kind: 'jira', project: 'BE' } } as never;
    const refused = await runA7ProposeStep(
      { proposal: { openCardOf: async () => undefined, propose: async () => ({ kind: 'refused', reason: 'unavailable' }) }, readSource: async () => ({ kind: 'failed', errorCode: 'UNKNOWN' }), route: {} as never, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } },
      { plan, actorId: 'owner', sessionId: 's', language: 'ko', ownerText: { text: 'x', groundingText: 'x' }, now: T0 as never, budget: {} as never, picked: forged as never },
    );
    expect(refused).toMatchObject({ kind: 'refused', reason: 'unsupported' });
    expect(captured).toEqual([1]);
  });
});

describe('A7-S4b form b: the frozen receipt (A7.4b)', () => {
  /** A receipt whose digests come from a real card of the same items, as the closed-card carry-over would freeze them. */
  async function heldReceipt(items = SLACK_ITEMS) {
    const h = harness({ script: [FORM_A_NAMED_PLAN], slackItems: items });
    const outcome = (await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m0')), async () => CHAT)) as { outcome: { items: Array<{ id: string; digest: string }> } };
    const built = buildHeldReceipt({ conversation: CONVERSATION, actorId: 'owner', turnId: 'm1', entryId: 'slack.search', validatedArgs: { keyword: '릴리즈' }, items: outcome.outcome.items, kind: 'listing', egress: 'LOCAL', at: T0, sourceOn: true });
    if ('refused' in built) throw new Error('no receipt');
    return built.receipt;
  }
  const stateOf = (receipt: unknown) => ({ byActor: { owner: { bootId: 'boot-1', held: receipt } } });

  it('the listing does not replace the receipt: it is frozen inside the pending pick with its original at, and the held record is untouched', async () => {
    const receipt = await heldReceipt();
    const h = harness({ script: [FORM_B_PLAN] });
    const outcome = (await h.svc.runActive(h.turn(FORM_B_TEXT, facts('m2', 'm1', stateOf(receipt)), at(2)), async () => CHAT)) as { outcome: { kind: string }; a7State: unknown };
    expect(outcome.outcome.kind).toBe('listing');
    const state = readA7State(jsonRoundTrip(outcome.a7State), 'owner', GUARD);
    expect(state.held).toEqual(receipt);
    expect(state.pick?.frozen).toEqual(receipt);
    expect(state.pick?.frozen?.at).toBe(T0);
    expect(state.pick?.askedAt).toBe(at(2));
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
  });

  it('at the pick the receipt is rechecked: a changed item is dropped and named, nothing is added; the card is picked', async () => {
    const receipt = await heldReceipt();
    const h = harness({ script: [FORM_B_PLAN], slackItems: [SLACK_ITEMS[0] as Record<string, unknown>, { ...SLACK_ITEMS[1], text: 'edited meanwhile' }, { id: 'C0AA.3', text: 'brand new', author: 'Lee Sample' }] });
    const first = (await h.svc.runActive(h.turn(FORM_B_TEXT, facts('m2', 'm1', stateOf(receipt)), at(2)), async () => CHAT)) as { a7State: unknown };
    const picked = await h.svc.continueA7Pick(h.pickTurn('1', facts('m3', 'm2', jsonRoundTrip(first.a7State)), at(5)));
    expect(picked).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
    const request = h.proposals[0] as AgentWriteProposalRequest;
    expect(request).toMatchObject({ target: { issueKey: 'BE-100' }, grounding: 'owner-picked' });
    expect(request.banner.items).toEqual([{ id: 'C0AA.1' }]);
    expect(request.banner.dropped).toBe(1);
    expect(request.payloadText).not.toMatch(/brand new|edited meanwhile/u);
    // The card keeps the receipt's original at (the frozen record), for the carry-over.
    const next = readA7State(jsonRoundTrip((picked as { a7State: unknown }).a7State), 'owner', GUARD);
    expect(next.card?.frozen.at).toBe(T0);
    expect(next.pick).toBeUndefined();
  });

  it('the second window: a pick inside 10 minutes of the listing but more than 20 after the frozen at cancels and discards the receipt', async () => {
    const receipt = await heldReceipt();
    const h = harness({ script: [FORM_B_PLAN] });
    // The receipt is bound at +9 (inside its 10 minutes), listed then; the pick comes at +20 (11 minutes after the listing: too late) - use +19 listing.
    const first = (await h.svc.runActive(h.turn(FORM_B_TEXT, facts('m2', 'm1', stateOf({ ...receipt, at: at(10) })), at(19)), async () => CHAT)) as { a7State: unknown };
    const late = await h.svc.continueA7Pick(h.pickTurn('1', facts('m3', 'm2', jsonRoundTrip(first.a7State)), at(30)));
    expect(late).toMatchObject({ kind: 'cancelled', reason: 'expired' });
    const second = harness({ script: [FORM_B_PLAN] });
    // A receipt at T0, listed at +9; the pick at +9.5 is 9.5 minutes after the listing but past nothing; one at +20.5 is past 20 minutes of the frozen at.
    const listed = (await second.svc.runActive(second.turn(FORM_B_TEXT, facts('m2', 'm1', stateOf(receipt)), at(9)), async () => CHAT)) as { a7State: unknown };
    const frozenLate = (jsonRoundTrip(listed.a7State) as { byActor: { owner: { pick: { askedAt: string } } } });
    frozenLate.byActor.owner.pick.askedAt = at(12);
    const out = await second.svc.continueA7Pick(second.pickTurn('1', facts('m3', 'm2', frozenLate), at(21)));
    expect(out).toMatchObject({ kind: 'cancelled', reason: 'frozen-expired' });
    expect(readA7State((out as { a7State: unknown }).a7State, 'owner', GUARD).pick).toBeUndefined();
    expect(second.proposals).toHaveLength(0);
  });

  it('without the injected hasher form b makes no pick at all (fail closed)', async () => {
    const receipt = await heldReceipt();
    const h = harness({ script: [FORM_B_PLAN], withHasher: false });
    const outcome = await h.svc.runActive(h.turn(FORM_B_TEXT, facts('m2', 'm1', stateOf(receipt)), at(2)), async () => CHAT);
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'unsupported' } });
  });
});

describe('A7-S4b closed-card carry-over (A7.4c item 4)', () => {
  async function closedCardState(closure: AgentCardClosureState) {
    const h = harness({ script: [FORM_A_NAMED_PLAN, FORM_B_FOLLOW_PLAN, FORM_B_FOLLOW_PLAN, FORM_B_FOLLOW_PLAN], closure: () => closure });
    const first = (await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    // The runtime records the owner turn that closed the card (m3: the approval phrase turn) once it observes the closure (P2-2).
    return { h, state: jsonRoundTrip(withCardClosingTurn(first.a7State, 'owner', 'm3', at(2), GUARD)) };
  }

  it('a card closed as sent hands its items on: "BE-124에도 달아줘" drafts from them (original at kept) and makes one more card', async () => {
    const { h, state } = await closedCardState('sent');
    expect(readA7State(state, 'owner', GUARD).card?.builtFromCarried).toBe(false);
    const outcome = (await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(8)), async () => CHAT)) as { outcome: { kind: string }; a7State: unknown };
    expect(outcome.outcome.kind).toBe('carded');
    expect(h.proposals).toHaveLength(2);
    expect(h.proposals[1]).toMatchObject({ target: { issueKey: 'BE-124' }, grounding: 'owner-text' });
    expect(h.proposals[1]?.banner.items).toEqual([{ id: 'C0AA.1' }, { id: 'C0AA.2' }]);
    // A card built from a carried receipt hands nothing on: its record is marked, and it keeps the original at.
    const next = readA7State(jsonRoundTrip(outcome.a7State), 'owner', GUARD);
    expect(next.card).toMatchObject({ builtFromCarried: true, cardId: 'card-2' });
    expect(next.card?.frozen.at).toBe(T0);
    expect(next.card?.frozen.carried).toBe(true);
    // ... so once THAT card closes too, a third request finds no receipt and the plan is refused (nothing is read).
    const readsBefore = h.reads.length;
    const third = await h.svc.runActive(h.turn('BE-125에도 달아줘', facts('m6', 'm5', jsonRoundTrip(outcome.a7State)), at(10)), async () => CHAT);
    expect(third).toMatchObject({ kind: 'declined', reason: 'refused' });
    expect(h.reads.length).toBe(readsBefore);
  });

  it('declined, expired and voided cards hand on; the kill switch and an unresolved or unknown closure hand nothing on', async () => {
    for (const closure of ['declined', 'expired', 'owner-void'] as const) {
      const { h, state } = await closedCardState(closure);
      const outcome = await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(5)), async () => CHAT);
      expect(outcome, closure).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
    }
    for (const closure of ['kill-switch', 'unknown', 'open'] as const) {
      const { h, state } = await closedCardState(closure);
      const outcome = await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(5)), async () => CHAT);
      expect(outcome, closure).toMatchObject({ kind: 'declined', reason: 'refused' });
      expect(h.proposals, closure).toHaveLength(1);
    }
  });

  it('the carried receipt expires 20 minutes after its ORIGINAL at, whatever the closure time', async () => {
    const { h, state } = await closedCardState('sent');
    expect(await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(21)), async () => CHAT)).toMatchObject({ kind: 'declined', reason: 'refused' });
  });

  it('without the injected hasher a card leaves no record, so nothing is carried', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN], withHasher: false, closure: () => 'sent' });
    const first = (await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)) as { outcome: { kind: string }; a7State?: unknown };
    expect(first.outcome.kind).toBe('carded');
    expect(readA7State(first.a7State ?? {}, 'owner', GUARD).card).toBeUndefined();
  });
});

describe('A7-S4b is dormant: with the defaults nothing new runs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('without the writeProposal dep an A7 plan is declined cross-write-off and neither the listing read, the closure check, the state reader or writer, nor the pick code runs (spies)', async () => {
    const list = vi.spyOn(AgentPlanExecutor.prototype, 'listDestinationRows');
    const read = vi.spyOn(AgentPlanExecutor.prototype, 'readDraftSource');
    const reader = vi.mocked(readA7State);
    const writer = vi.mocked(withA7State);
    reader.mockClear();
    writer.mockClear();
    const h = harness({ script: [FORM_A_PLAN] });
    const bare = new AgentRunService({
      mode: 'active',
      released: true,
      router: { select: async () => ({ id: 'p', family: 'claude-family', capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }], isAvailable: async () => true, execute: async () => ({ text: FORM_A_PLAN, artifacts: [] }) }) as AiProvider },
      actors: { get: async () => h.owner, save: async (actor) => actor },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      timeZone: 'Asia/Seoul',
      timeoutMs: 6_000,
      readers: {},
      summarizer: new CapabilityRouter(new AiProviderManager([h.drafter]), policy),
      crossWrite: ctx(),
    });
    const outcome = await bare.runActive(h.turn(FORM_A_TEXT, facts('m1', 'm0', { byActor: { owner: { bootId: 'boot-1', card: {} } } })), async () => CHAT);
    expect(outcome).toEqual({ kind: 'declined', reason: 'cross-write-off' });
    expect(await bare.continueA7Pick(h.pickTurn('2', facts('m2', 'm1')))).toEqual({ kind: 'not-pending' });
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it('with the dep but no boot id (the composition root did not inject one) no A7 state is read or written and the closure check is never reached (the closure spy is wired into the port)', async () => {
    const reader = vi.mocked(readA7State);
    const writer = vi.mocked(withA7State);
    reader.mockClear();
    writer.mockClear();
    const closure = vi.fn(async () => 'sent' as AgentCardClosureState);
    const h = harness({ script: [FORM_A_NAMED_PLAN, FORM_B_FOLLOW_PLAN], bootId: null, closure });
    const first = (await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1', undefined, { byActor: { owner: { bootId: 'boot-1', card: {} } } })), async () => CHAT)) as { outcome: { kind: string }; a7State?: unknown };
    expect(first.outcome.kind).toBe('carded');
    expect(first.a7State).toBeUndefined();
    await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m3', 'm2', { byActor: { owner: { bootId: 'boot-1', card: {} } } }), at(2)), async () => CHAT);
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1')))).toEqual({ kind: 'not-pending' });
    expect(closure).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it('a turn without the A7 facts is exactly the earlier behaviour (a named destination cards; a kind-only one is not a pick)', async () => {
    const named = harness({ script: [FORM_A_NAMED_PLAN] });
    const { a7: _drop, ...bare } = named.turn(FORM_A_NAMED_TEXT, facts('m1'));
    const outcome = await named.svc.runActive(bare, async () => CHAT);
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
    expect((outcome as { a7State?: unknown }).a7State).toBeUndefined();
    const kindOnly = harness({ script: [FORM_A_PLAN] });
    const { a7: _drop2, ...bareKind } = kindOnly.turn(FORM_A_TEXT, facts('m1'));
    expect(await kindOnly.svc.runActive(bareKind, async () => CHAT)).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'unsupported' } });
    expect(kindOnly.reads).toHaveLength(0);
  });
});

describe('review round 1: the A7 state is void after a stop or a restart (P1-1)', () => {
  const asked = async (h: ReturnType<typeof harness>) => jsonRoundTrip(((await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown }).a7State);

  it('stop then resume cancels a pending pick: the pick turn finds no pick, reads nothing and makes no card', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    // The owner stopped the agent at +0.5 and resumed it at +1: the last change is after the listing.
    h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'running', at: at(1) } } });
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(2)))).toEqual({ kind: 'not-pending' });
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
    // Without the switch change the same state still picks.
    const live = harness({ script: [FORM_A_PLAN] });
    expect(await live.svc.continueA7Pick(live.pickTurn('2', facts('m2', 'm1', await asked(live)), at(2)))).toMatchObject({ kind: 'proposal', outcome: { kind: 'carded' } });
  });

  it('stop then resume blocks the carry-over of a closed card', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN, FORM_B_FOLLOW_PLAN], closure: () => 'sent' });
    const first = (await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    const state = jsonRoundTrip(withCardClosingTurn(first.a7State, 'owner', 'm3', at(2), GUARD));
    h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'running', at: at(3) } } });
    expect(await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(5)), async () => CHAT)).toMatchObject({ kind: 'declined', reason: 'refused' });
    expect(h.proposals).toHaveLength(1);
  });

  it('a new boot id sees no state: a pending pick and a card of the old boot are absent, and an old receipt does not bind', async () => {
    const old = harness({ script: [FORM_A_PLAN, FORM_A_NAMED_PLAN] });
    const state = await asked(old);
    const restarted = harness({ bootId: 'boot-2' });
    expect(await restarted.svc.continueA7Pick(restarted.pickTurn('2', facts('m2', 'm1', state), at(1)))).toEqual({ kind: 'not-pending' });
    expect(restarted.reads).toHaveLength(0);
    expect(readA7State(state, 'owner', { bootId: 'boot-2' })).toEqual({});
  });
});

describe('review round 1: no owner text in Session.metadata, and no grant across turns (P1-2)', () => {
  it('the whole metadata of a listing, a pick and a card is plain JSON without one byte of the owner\'s request', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const listed = (await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    const afterPick = (await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', jsonRoundTrip(listed.a7State)), at(1)))) as { a7State: unknown };
    for (const value of [listed.a7State, afterPick.a7State]) {
      const json = JSON.stringify(value);
      expect(json).not.toMatch(/슬랙 릴리즈 대화|요약해서|지라 티켓에 달아줘|ownerText|groundingText|rawText/u);
      expect(JSON.parse(json)).toEqual(value);
    }
    expect(readA7State(listed.a7State, 'owner', GUARD).pick?.summaryAsked).toEqual(['slack.search']);
  });

  it('the pick resumes with the frozen closed request: a source the asking turn did not ask a summary of gets no grant (nothing is drafted)', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const listed = (await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    const stored = jsonRoundTrip(listed.a7State) as { byActor: { owner: { pick: { summaryAsked: string[] } } } };
    stored.byActor.owner.pick.summaryAsked = [];
    const outcome = await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', stored), at(1)));
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused' } });
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });

  it('a carried follow-up reuses no earlier grant: a LOCAL summariser proceeds, a REMOTE one asks its rule-① question again (nothing fetched, nothing drafted)', async () => {
    const local = harness({ script: [FORM_A_NAMED_PLAN, FORM_B_FOLLOW_PLAN], closure: () => 'sent' });
    const first = (await local.svc.runActive(local.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    const closed = jsonRoundTrip(withCardClosingTurn(first.a7State, 'owner', 'm3', at(2), GUARD));
    expect(await local.svc.runActive(local.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', closed), at(5)), async () => CHAT)).toMatchObject({ outcome: { kind: 'carded' } });

    const remote = harness({ script: [FORM_B_FOLLOW_PLAN], drafterLocality: 'REMOTE', closure: () => 'sent' });
    const stored = { byActor: { owner: { bootId: 'boot-1', card: { cardId: 'c1', taskId: 't1', sessionId: 'session-1', cardAt: at(1), frozen: JSON.parse(JSON.stringify(readA7State(closed, 'owner', GUARD).card?.frozen)), builtFromCarried: false, closingTurnId: 'm3' } } } };
    const asked = (await remote.svc.runActive(remote.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', stored), at(5)), async () => CHAT)) as { outcome: { kind: string } };
    expect(asked.outcome.kind).toBe('ask');
    expect(remote.drafter.requests).toHaveLength(0);
    expect(remote.proposals).toHaveLength(0);
  });
});

describe('review round 1: the carry-over is strictly the next owner turn after the closing turn, single use (P2-2)', () => {
  async function closed(h: ReturnType<typeof harness>) {
    const first = (await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    return jsonRoundTrip(withCardClosingTurn(first.a7State, 'owner', 'm3', at(2), GUARD));
  }
  const script = [FORM_A_NAMED_PLAN, FORM_B_FOLLOW_PLAN, FORM_B_FOLLOW_PLAN, FORM_B_FOLLOW_PLAN];

  it('an intervening owner turn voids it; with no closing turn recorded nothing carries; only the turn right after the closing turn does', async () => {
    const intervening = harness({ script, closure: () => 'sent' });
    expect(await intervening.svc.runActive(intervening.turn(FORM_B_FOLLOW_TEXT, facts('m5', 'm4', await closed(intervening)), at(5)), async () => CHAT)).toMatchObject({ kind: 'declined', reason: 'refused' });
    const unrecorded = harness({ script, closure: () => 'sent' });
    const first = (await unrecorded.svc.runActive(unrecorded.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown };
    expect(await unrecorded.svc.runActive(unrecorded.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', jsonRoundTrip(first.a7State)), at(5)), async () => CHAT)).toMatchObject({ kind: 'declined', reason: 'refused' });
    const next = harness({ script, closure: () => 'sent' });
    expect(await next.svc.runActive(next.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', await closed(next)), at(5)), async () => CHAT)).toMatchObject({ outcome: { kind: 'carded' } });
  });

  it('once a carry-over binds the card is gone from the returned state whatever the outcome (here a refusal), so a second attempt finds nothing', async () => {
    const h = harness({ script, closure: () => 'sent' });
    const state = await closed(h);
    const refused = (await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(5), { ownerStepPending: true }), async () => CHAT)) as { outcome: { kind: string }; a7State: unknown };
    expect(refused.outcome).toMatchObject({ kind: 'refused', reason: 'owner-step-open' });
    expect(readA7State(jsonRoundTrip(refused.a7State), 'owner', GUARD).card).toBeUndefined();
    const second = await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', jsonRoundTrip(refused.a7State)), at(6)), async () => CHAT);
    expect(second).toMatchObject({ kind: 'declined', reason: 'refused' });
    expect(h.proposals).toHaveLength(1);
  });

  it('a declined plan after the bind also returns the state without the card', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN, JSON.stringify({ steps: [{ summarize: [], schema: 'payload-draft.v1' }, { propose: 'jira.comment.propose', args: { issueKey: 'XX-1' } }], ambiguity: 'CLEAR' })], closure: () => 'sent' });
    const state = await closed(h);
    const out = (await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(5)), async () => CHAT)) as { kind: string; a7State?: unknown };
    expect(out).toMatchObject({ kind: 'declined', reason: 'refused' });
    expect(out.a7State).toBeDefined();
    expect(readA7State(jsonRoundTrip(out.a7State), 'owner', GUARD).card).toBeUndefined();
  });

  it('a cancelled pick voids the card: the returned state keeps no card, so a request after the cancel finds nothing to carry', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN, FORM_A_PLAN] });
    const withCard = await closed(h);
    const listed = (await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m4', 'm3', withCard), at(4)), async () => CHAT)) as { a7State: unknown };
    expect(readA7State(jsonRoundTrip(listed.a7State), 'owner', GUARD).card).toBeDefined();
    const cancelled = (await h.svc.continueA7Pick(h.pickTurn('no thanks', facts('m5', 'm4', jsonRoundTrip(listed.a7State)), at(5)))) as { kind: string; a7State: unknown };
    expect(cancelled.kind).toBe('cancelled');
    expect(readA7State(jsonRoundTrip(cancelled.a7State), 'owner', GUARD).card).toBeUndefined();
  });
});

describe('review round 1: a form-b card freezes only what it placed and verified (P2-3)', () => {
  it('Codex restore-B: B changed (dropped), the card is made from A only; B restored later never comes back through the carry-over', async () => {
    const h = harness({ script: [FORM_B_FOLLOW_PLAN, FORM_B_FOLLOW_PLAN], closure: () => 'sent' });
    // The receipt of [A, B] as a real earlier card froze it.
    const base = harness({ script: [FORM_A_NAMED_PLAN] });
    const earlier = (await base.svc.runActive(base.turn(FORM_A_NAMED_TEXT, facts('m0')), async () => CHAT)) as { outcome: { items: Array<{ id: string; digest: string }> } };
    const built = buildHeldReceipt({ conversation: CONVERSATION, actorId: 'owner', turnId: 'm1', entryId: 'slack.search', validatedArgs: { keyword: '릴리즈' }, items: earlier.outcome.items, kind: 'listing', egress: 'LOCAL', at: T0, sourceOn: true });
    if ('refused' in built) throw new Error('no receipt');
    h.state.slackItems = [SLACK_ITEMS[0] as Record<string, unknown>, { ...SLACK_ITEMS[1], text: 'edited meanwhile' }];
    const first = (await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m2', 'm1', { byActor: { owner: { bootId: 'boot-1', held: built.receipt } } }), at(2)), async () => CHAT)) as { outcome: { kind: string }; a7State: unknown };
    expect(first.outcome.kind).toBe('carded');
    expect(h.proposals[0]?.banner.items).toEqual([{ id: 'C0AA.1' }]);
    const frozen = readA7State(jsonRoundTrip(first.a7State), 'owner', GUARD).card?.frozen;
    expect(frozen?.itemIds).toEqual(['C0AA.1']);
    expect(frozen?.at).toBe(T0);
    // B is restored to its original text; the card closes; the follow-up still drafts from A only.
    h.state.slackItems = SLACK_ITEMS;
    const state = jsonRoundTrip(withCardClosingTurn(first.a7State, 'owner', 'm3', at(3), GUARD));
    expect(await h.svc.runActive(h.turn(FORM_B_FOLLOW_TEXT, facts('m4', 'm3', state), at(6)), async () => CHAT)).toMatchObject({ outcome: { kind: 'carded' } });
    expect(h.proposals[1]?.banner.items).toEqual([{ id: 'C0AA.1' }]);
    expect(h.proposals[1]?.banner.dropped).toBe(0);
  });
});

describe('review round 1: a fresh destination-existence check at the pick (P2-5)', () => {
  const asked = async (h: ReturnType<typeof harness>) => jsonRoundTrip(((await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown }).a7State);

  it('the picked issue is checked before any source read or draft; present: the card follows', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)))).toMatchObject({ outcome: { kind: 'carded' } });
    expect(h.state.checks).toEqual(['BE-77']);
  });

  it('deleted between the listing and the pick: nothing is read or drafted, the fixed refusal line, the pick is gone', async () => {
    const h = harness({ script: [FORM_A_PLAN], destinationExists: (key) => key !== 'BE-77' });
    const state = await asked(h);
    const outcome = (await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)))) as { kind: string; outcome: { kind: string; reason: string; text: string }; a7State: unknown };
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'destination-gone', text: '고르신 티켓을 지금은 찾을 수 없어서 카드를 만들지 않았어요. 아무것도 읽거나 보내지 않았어요.' } });
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
    expect(readA7State(outcome.a7State, 'owner', GUARD).pick).toBeUndefined();
  });

  it('a check that throws fails closed the same way; no check port wired: the pick is declined with nothing read', async () => {
    const throwing = harness({ script: [FORM_A_PLAN], destinationExists: () => { throw new Error('network'); } });
    expect(await throwing.svc.continueA7Pick(throwing.pickTurn('2', facts('m2', 'm1', await asked(throwing)), at(1)))).toMatchObject({ outcome: { kind: 'refused', reason: 'destination-gone' } });
    expect(throwing.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    const unwired = harness({ script: [FORM_A_PLAN], destinationExists: null });
    expect(await unwired.svc.continueA7Pick(unwired.pickTurn('2', facts('m2', 'm1', await asked(unwired)), at(1)))).toMatchObject({ kind: 'declined', reason: 'no-destination-check' });
    expect(unwired.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(unwired.proposals).toHaveLength(0);
  });
});

describe('review round 2: the destination check is charged and raced (P2)', () => {
  const asked = async (h: ReturnType<typeof harness>) => jsonRoundTrip(((await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown }).a7State);

  it('a hung destination GET is cut by the wall: nothing is read, drafted or proposed, and no slot stays in flight', async () => {
    const bounds = {} as { wallMs?: number };
    const h = harness({ script: [FORM_A_PLAN], destinationExists: () => new Promise<boolean>(() => undefined), bounds });
    const state = await asked(h);
    bounds.wallMs = 80;
    const started = Date.now();
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)))).toMatchObject({ kind: 'declined', reason: 'bound' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
    // The slot is free: a second pick turn is admitted (the pick was single use, so it is simply not pending).
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m3', 'm2', state), at(2)))).toMatchObject({ kind: expect.stringMatching(/not-pending|declined|cancelled/u) });
  }, 5_000);

  it('a connector budget that refuses the charge: no GET at all, nothing read', async () => {
    const bounds = {} as { maxConnectorQueries?: number };
    const h = harness({ script: [FORM_A_PLAN], bounds });
    const state = await asked(h);
    bounds.maxConnectorQueries = 0;
    const outcome = await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)));
    expect(outcome).toMatchObject({ kind: 'declined' });
    expect(h.state.checks).toEqual([]);
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });
});

describe('review round 3: the switch epoch and the destination reservation', () => {
  const asked = async (h: ReturnType<typeof harness>) => jsonRoundTrip(((await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown }).a7State);

  it('P2-1 (Codex): stop then resume while the destination GET is awaited voids the pick: nothing read, drafted or proposed', async () => {
    let hold: ((value: boolean) => void) | undefined;
    let reached: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (reached = resolve));
    const h = harness({ script: [FORM_A_PLAN], destinationExists: () => new Promise<boolean>((resolve) => { hold = resolve; reached?.(); }) });
    const state = await asked(h);
    const pending = h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)));
    await gate;
    h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'stopped', at: at(2) } } });
    h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'running', at: at(3) } } });
    hold?.(true);
    expect(await pending).toMatchObject({ kind: 'declined', reason: 'stopped' });
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });

  it('P2-2 (Codex): the destination GET reserves a connector query and an HTTP slot; with limits 1/1 the source read is refused by the bound', async () => {
    const bounds = {} as { maxConnectorQueries?: number; maxHttpRequests?: number };
    const h = harness({ script: [FORM_A_PLAN], bounds });
    const state = await asked(h);
    bounds.maxConnectorQueries = 1;
    bounds.maxHttpRequests = 1;
    const outcome = await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)));
    // Exact counts: the one destination check was attempted (it took the only slot); the source read made no connector call; no draft, no card.
    expect(h.state.checks).toEqual(['BE-77']);
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(0);
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'bound' } });
  });
});

describe('review round 4: the epoch is captured once at turn entry and checked around every effect', () => {
  const stopThenResume = (h: ReturnType<typeof harness>) => {
    h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'stopped', at: at(2) } } });
    h.live.set('owner', { ...h.owner, metadata: { 'quoky.actionSwitch': { state: 'running', at: at(3) } } });
  };
  const asked = async (h: ReturnType<typeof harness>) => jsonRoundTrip(((await h.svc.runActive(h.turn(FORM_A_TEXT, facts('m1')), async () => CHAT)) as { a7State: unknown }).a7State);
  const nothingAfter = (h: ReturnType<typeof harness>, sourceReads: number) => {
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(sourceReads);
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  };

  it('ordinary: stop then resume during the planner declines stopped before any receipt, read, draft or proposal', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN] });
    h.state.hooks.planner = () => stopThenResume(h);
    expect(await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)).toMatchObject({ kind: 'declined', reason: 'stopped' });
    expect(h.state.plannerCalls).toBe(1);
    nothingAfter(h, 0);
    expect(h.reads).toHaveLength(0);
  });

  it('ordinary: stop then resume during the open-card read (a cross-write effect) refuses stopped with no read, draft or proposal', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN] });
    let sourceReached = 0;
    h.state.hooks.openCard = () => stopThenResume(h);
    h.state.hooks.sourceRead = () => void (sourceReached += 1);
    expect(await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'stopped' } });
    // Discriminating: the source read port was never reached (the hook fires inside the port), not merely no draft.
    expect(sourceReached).toBe(0);
    nothingAfter(h, 0);
  });

  it('ordinary: stop then resume during the source read refuses stopped before the draft (one read, zero drafts, zero proposals)', async () => {
    const h = harness({ script: [FORM_A_NAMED_PLAN] });
    h.state.hooks.sourceRead = () => stopThenResume(h);
    expect(await h.svc.runActive(h.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT)).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'stopped' } });
    nothingAfter(h, 1);
  });

  it('round 5: a read plan is NOT declined by a stop then resume during the planner (only the A7 binding is skipped); it runs as before', async () => {
    const READ_PLAN = JSON.stringify({ steps: [{ entryId: 'slack.search', args: { keyword: '릴리즈' } }], ambiguity: 'CLEAR' });
    const READ_TEXT = '슬랙에서 릴리즈 검색해줘';
    const control = harness({ script: [READ_PLAN] });
    const baseline = await control.svc.runActive(control.turn(READ_TEXT, facts('m1')), async () => CHAT);
    const h = harness({ script: [READ_PLAN] });
    h.state.hooks.planner = () => stopThenResume(h);
    const outcome = await h.svc.runActive(h.turn(READ_TEXT, facts('m1')), async () => CHAT);
    expect(baseline).not.toMatchObject({ kind: 'declined' });
    expect(outcome.kind).toBe(baseline.kind);
    expect(outcome).not.toMatchObject({ kind: 'declined', reason: 'stopped' });
    expect(h.reads.filter((read) => read.entry === 'slack.search')).toHaveLength(control.reads.filter((read) => read.entry === 'slack.search').length);
    expect(h.drafter.requests).toHaveLength(0);
    expect(h.proposals).toHaveLength(0);
  });

  it('round 5: a turn without A7 facts reads the actor no extra time for the epoch guard', async () => {
    const a = harness({ script: [FORM_A_NAMED_PLAN] });
    const b = harness({ script: [FORM_A_NAMED_PLAN] });
    const noFacts = b.turn(FORM_A_NAMED_TEXT, facts('m1')) as { a7?: unknown };
    const plain = { ...noFacts };
    delete plain.a7;
    await a.svc.runActive(a.turn(FORM_A_NAMED_TEXT, facts('m1')), async () => CHAT);
    await b.svc.runActive(plain as never, async () => CHAT);
    expect(b.state.actorGets).toBeLessThan(a.state.actorGets);
  });

  it('pick: stop then resume during the running-only check before the destination GET declines stopped with zero GETs', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    // Within the pick turn the actor reads are: the entry guard (1), the running check (2), the check right before the GET (3).
    const base = h.state.actorGets;
    h.state.hooks.afterActorGet = (n) => {
      if (n === base + 2) stopThenResume(h);
    };
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)))).toMatchObject({ kind: 'declined', reason: 'stopped' });
    expect(h.state.checks).toEqual([]);
    nothingAfter(h, 0);
  });

  it('pick: stop then resume during the source read refuses stopped before the draft (one read, zero drafts, zero proposals)', async () => {
    const h = harness({ script: [FORM_A_PLAN] });
    const state = await asked(h);
    h.state.hooks.sourceRead = () => stopThenResume(h);
    expect(await h.svc.continueA7Pick(h.pickTurn('2', facts('m2', 'm1', state), at(1)))).toMatchObject({ kind: 'proposal', outcome: { kind: 'refused', reason: 'stopped' } });
    expect(h.state.checks).toEqual(['BE-77']);
    nothingAfter(h, 1);
  });
});
