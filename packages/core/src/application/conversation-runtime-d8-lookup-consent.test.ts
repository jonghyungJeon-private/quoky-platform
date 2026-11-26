import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun } from '../domain';
import type { AiProvider, AiRequest, ConnectorItem, ConnectorProvider, ConversationTurnHandler, LogFields, Logger, StorageProvider } from '../ports';
import { ConsentPendingStore } from './consent-answer/consent-pending';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import { ItemSummaryConsent, type ItemSummaryConsentToken } from './consent-answer/item-summary-consent';
import { ContextBuilder } from './context-builder';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import { workLookupRefsKey } from './item-summary-consent-descriptor';
import { renderItemSummaryChangedLine } from './item-summary/item-summary-continuation';
import { renderItemSummaryNotSentLine } from './item-summary/summary-recipient-guard';
import type { MemoryManager } from './memory-manager';
import type { MemoryRetriever } from './memory-retriever';
import type { MemoryWriter } from './memory-writer';
import type { NlSelectedCommand } from './nl-routing/catalog';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { WorkChatService, type WorkChatServiceDeps } from './work-chat/work-chat-service';
import { WORK_CHAT_LOOKUP_TURN_HANDLER_ID, createWorkChatTurnHandlers } from './work-chat/work-chat-turn-handler';

/**
 * ADR-0121 amendment A8.6, slice OQ1-4 (= A5-S6): rule ① for the ADR-0100 D8 work-lookup summary, through the REAL
 * ConversationRuntime, the REAL WorkChatService and work-chat turn handlers, PromptComposer and PromptRenderer. Only storage, the
 * Jira connector, the providers, the router and Task bookkeeping are fakes. The router answers like the composition root.
 */

const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
const CHANNEL: ConversationContext = { platform: 'test', spaceId: 'g-1', channelId: 'chan-1', userId: 'owner-user', direct: false };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [{ platform: 'jira', externalId: 'jira-owner' }], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-11-26T01:00:00.000Z';
/** In every item title: it must never reach a log line. */
const CANARY = ['zq', 'canary', 'vxw'].join('');
const SUMMARY = '요약 본문이에요.';
const LINE = '· Remote로 요약';
const ASK = '내 Jira 이슈 보여줘';
const QUESTION = '지라 이슈 2건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)';
const UNAVAILABLE = '지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.';
const SCOPE = { actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(DM) };

const item = (id: string): ConnectorItem => ({ id, title: `일 ${id} ${CANARY}`, url: `https://example.atlassian.net/browse/${id}`, status: 'To Do' });

type ProviderName = 'remote' | 'other' | 'local' | 'anon';

interface HarnessOptions {
  /** `absent`: no gate; `gate`: QUOKY_SUMMARY_CONSENT=on only; `items`: both switches on (QUOKY_ITEM_SUMMARY_CONSENT=on). */
  readonly consent?: 'absent' | 'gate' | 'items';
  readonly selected?: ProviderName;
  readonly expectedKey?: string;
  /** Adds a kill-switch path (`에이전트 중지`) through the agent switch. */
  readonly stop?: boolean;
  /** Adds a handler that answers `선택한 지라 조회` through the real lookup handler's `handleSelected` (the NL-selection outcome). */
  readonly selectionProbe?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const events: string[] = [];
  const executed: { provider: string; request: AiRequest }[] = [];
  const recordAssistant: string[] = [];
  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const runs: { kind: 'complete' | 'fail'; summary?: string }[] = [];
  const counts = { select: 0, expected: 0, queries: 0, handleSelected: 0 };
  /** The message each `handleSelected` call saw (review round 1: the re-run keeps the asking message's marks). */
  const selectedMessages: InboundMessage[] = [];
  const state = {
    selected: opts.selected ?? 'remote',
    expectedKey: 'expectedKey' in opts ? opts.expectedKey : 'fake-remote',
    items: [item('A-1'), item('A-2')],
    selectGate: undefined as Promise<void> | undefined,
    selectEntered: undefined as (() => void) | undefined,
  };
  const hooks: { onQuery?: (n: number) => void; afterSelect?: (n: number) => void } = {};

  const storage = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, { ...s });
        return s;
      },
      async get(id: string) {
        return sessions.get(id) ?? null;
      },
      async findActiveByContext(platform: string, channelId: string, threadId?: string) {
        return [...sessions.values()].find((s) => s.status === SessionStatus.ACTIVE && s.context.platform === platform && s.context.channelId === channelId && s.context.threadId === threadId) ?? null;
      },
    },
  };
  const sessionManager = new SessionManager(storage as unknown as StorageProvider);

  const jira: ConnectorProvider = {
    source: 'jira',
    readOnly: true,
    async isAvailable() {
      return true;
    },
    async query() {
      counts.queries += 1;
      hooks.onQuery?.(counts.queries);
      return { source: 'jira', items: state.items };
    },
  };
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, ...(fields !== undefined ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ level: 'warn', message, ...(fields !== undefined ? { fields } : {}) }),
    error: (message, fields) => logs.push({ level: 'error', message, ...(fields !== undefined ? { fields } : {}) }),
  };
  const desk = new WorkChatService(
    { workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) }, connectors: { list: () => [jira] }, work: {} as WorkChatServiceDeps['work'] },
    { summaryEnabled: true },
  );
  const [todoHandler, lookupHandler] = createWorkChatTurnHandlers({ desk, summaryEnabled: true, logger });
  const realSelected = lookupHandler.handleSelected.bind(lookupHandler);
  lookupHandler.handleSelected = async (selected, ctx) => {
    counts.handleSelected += 1;
    selectedMessages.push(ctx.message);
    return realSelected(selected, ctx);
  };
  const SELECTED: NlSelectedCommand = { entryId: 'jira.issues', args: {}, language: 'ko' };
  const selectionProbe: ConversationTurnHandler = {
    id: 'selection-probe',
    stage: 'pre-classify',
    order: 1,
    async handle(ctx) {
      if (ctx.message.text === '선택한 지라 개수') return lookupHandler.handleSelected({ ...SELECTED, args: { count: true } }, ctx);
      return ctx.message.text === '선택한 지라 조회' ? lookupHandler.handleSelected(SELECTED, ctx) : null;
    },
  };

  let executeCount = 0;
  const provider = (id: string, executionLocality: 'LOCAL' | 'REMOTE'): AiProvider => ({
    id,
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 50 }],
    executionLocality,
    async isAvailable() {
      return true;
    },
    async execute(request: AiRequest) {
      events.push('execute');
      executed.push({ provider: id, request });
      executeCount += 1;
      return { text: SUMMARY, artifacts: [], usage: { label: 'fake-usage', inputTokens: 7, outputTokens: 3 } };
    },
  });
  const providers: Record<ProviderName, AiProvider> = {
    remote: provider('fake-remote', 'REMOTE'),
    other: provider('fake-other', 'REMOTE'),
    local: provider('fake-local', 'LOCAL'),
    anon: provider('fake-anon', 'REMOTE'),
  };
  const labels: Record<string, string> = { 'fake-remote': 'Remote', 'fake-other': 'Other' };
  const recipientLabel = (p: AiProvider): string | undefined => labels[p.id];

  const shortTerm: MemoryRecord[] = [];
  const contextBuilder = new ContextBuilder(
    {
      async recentShortTerm(scope: { sessionId?: string }, limit: number) {
        return shortTerm.filter((r) => r.scope.sessionId === scope.sessionId).slice(-limit);
      },
      async projectMemory() {
        return undefined;
      },
    } as unknown as MemoryManager,
    {},
    { async retrieve() { return []; } } as unknown as MemoryRetriever,
  );
  const bad = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  let taskSeq = 0;
  const router: ConversationRuntimeDeps['router'] = {
    async select() {
      const wait = state.selectGate;
      if (wait !== undefined) {
        state.selectGate = undefined;
        state.selectEntered?.();
        await wait;
      }
      counts.select += 1;
      const chosen = providers[state.selected];
      hooks.afterSelect?.(counts.select);
      return chosen;
    },
    expectedRecipientKey: () => {
      counts.expected += 1;
      return state.expectedKey;
    },
    isStillEligible: (_capability: Capability, _context: unknown, p: AiProvider) => {
      events.push('guard');
      return p === providers[state.selected];
    },
  };
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: {
      async commit() {
        events.push('commit');
        return {} as TaskRun;
      },
    } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm(message: InboundMessage, sessionId?: string) {
        const n = shortTerm.length + 1;
        shortTerm.push({ id: `mem-${n}`, type: MemoryType.SHORT_TERM, scope: sessionId ? { sessionId } : {}, content: message.text, metadata: { role: 'user' }, createdAt: T0, updatedAt: T0 });
        return { id: `mem-${n}` };
      },
      async recordAssistant(text: string) {
        recordAssistant.push(text);
        return undefined;
      },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('createCandidate'), promote: bad('promote'), forget: bad('forget') } as unknown as MemoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' };
      },
    },
    projects: { register: bad('projects.register'), get: async () => null } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      async createTask(intent, context, anchor) {
        return { id: `task-${++taskSeq}`, title: intent.summary, description: anchor.requestText, status: TaskStatus.PENDING, intent, riskLevel: RiskLevel.LOW, context, actorId: anchor.actorId, sessionId: anchor.sessionId, createdAt: T0, updatedAt: T0 } as Task;
      },
      async transition(task, to) { return { ...task, status: to }; },
      async startRun(task, capability) { return { id: `run-${task.id}`, taskId: task.id, capability } as TaskRun; },
      async completeRun() {
        runs.push({ kind: 'complete' });
        return undefined;
      },
      async failRun(_run, summary) {
        runs.push({ kind: 'fail', summary });
        return undefined;
      },
    },
    workspace: { prepare: async () => undefined, open: bad('workspace.open'), list: bad('list'), diff: bad('diff'), read: bad('read') },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: (task, exclude) => contextBuilder.build(task, exclude) },
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router,
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: { decide: bad('approvals.decide'), get: bad('approvals.get'), requestForRisk: bad('approvals.requestForRisk') } as unknown as ConversationRuntimeDeps['approvals'],
    approvalFlow: new StatelessApprovalFlow(storage as never),
    scopeClarificationFlow: { findPending: async () => null, anchor: bad('scope.anchor'), clear: async () => undefined },
    applyPreviewFlow: { findAnchor: async () => null, anchor: bad('applyPreview.anchor'), clear: async () => undefined },
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('getProposal') },
    patch: { generate: bad('patch.generate'), get: bad('patch.get') },
    codeProposals: { get: bad('codeProposals.get') },
    workspaceWrite: { apply: bad('workspaceWrite.apply') },
    git: {
      status: bad('git.status'),
      diff: bad('git.diff'),
      commitFiles: bad('git.commitFiles'),
      info: bad('git.info'),
      pushApprovedCommit: bad('git.pushApprovedCommit'),
      syncMain: bad('git.syncMain'),
      deleteMergedLocalBranch: bad('git.deleteMergedLocalBranch'),
    },
    turnHandlers: [...(opts.selectionProbe === true ? [selectionProbe] : []), todoHandler, lookupHandler],
    logger,
    ...(opts.stop === true
      ? {
          agentRuns: {
            mode: 'shadow',
            shadowAdmits: () => false,
            runShadow: bad('runShadow'),
            handleSwitchPhrase: async (_actor: Actor, text: string) => (text.trim() === '에이전트 중지' ? '멈춤(에이전트)' : undefined),
            switchSuffix: () => undefined,
          } as unknown as ConversationRuntimeDeps['agentRuns'],
        }
      : {}),
  };

  const consent = opts.consent ?? 'items';
  const clock = { now: 1_000_000 };
  const store = new ConsentPendingStore();
  const items = consent === 'items' ? new ItemSummaryConsent({ store, now: () => clock.now, logger, recipientLabel }) : undefined;
  const gate =
    consent === 'absent'
      ? undefined
      : new ConsentTurnGate({
          store,
          classifier: { mode: 'off' },
          chargeModelCall: () => true,
          continueSummary: async () => ({ kind: 'reply', reply: { text: 'AGENT CONTINUATION' } }),
          ...(items !== undefined ? { items } : {}),
          now: () => clock.now,
          logger,
        });
  const runtime = new ConversationRuntime(deps, { clock: () => T0, ...(gate !== undefined ? { consentTurnGate: gate } : {}) });
  let seq = 0;
  const send = (text: string, context: ConversationContext = DM, marks: Pick<InboundMessage, 'quotedRanges' | 'formatting'> = {}) =>
    runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0, ...marks } satisfies InboundMessage);
  return { send, state, hooks, events, executed, recordAssistant, logs, runs, counts, items, store, gate, clock, labels, lookupHandler, selectedMessages };
}

type Harness = ReturnType<typeof harness>;
const view = (result: { readonly status: string; readonly reply: OutboundMessage }) => ({ status: result.status, reply: result.reply });

const noContentInLogs = (h: Harness) => {
  const text = JSON.stringify(h.logs);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(SUMMARY);
  expect(text).not.toContain(ASK);
  expect(text).not.toContain('jira:A-');
};

/** The listing the D8 lookup shows for these items (the summary-off desk renders the same deterministic list). */
async function listingOf(items: readonly ConnectorItem[]): Promise<string> {
  const desk = new WorkChatService(
    {
      workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) },
      connectors: { list: () => [{ source: 'jira', readOnly: true, isAvailable: async () => true, query: async () => ({ source: 'jira', items: [...items] }) }] },
      work: {} as WorkChatServiceDeps['work'],
    },
    { summaryEnabled: false },
  );
  const out = await desk.handle({ kind: 'lookup', source: 'jira', query: 'my-items' }, OWNER);
  return out.kind === 'reply' ? out.text : '';
}

describe('OQ1-4 dormancy: flag off is byte-identical for the D8 lookup summary', () => {
  it('no gate vs QUOKY_SUMMARY_CONSENT=on alone: same reply, prompt, history and runs; no pre-resolve, no question', async () => {
    const results = [];
    for (const consent of ['absent', 'gate'] as const) {
      const h = harness({ consent });
      const result = await h.send(ASK);
      results.push({ reply: view(result), requests: h.executed.map((entry) => entry.request), history: h.recordAssistant, runs: h.runs, select: h.counts.select });
      expect(h.counts.expected).toBe(0);
      expect(h.events.filter((event) => event === 'guard')).toEqual([]);
      expect(result.reply.text).toContain(SUMMARY);
      expect(result.reply.text).not.toContain(LINE);
      expect(result.reply.text).not.toContain('보낼까요');
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.requests).toHaveLength(1);
  });
});

describe('OQ1-4 flag on: the D8 lookup asks before a REMOTE summary (A8.6)', () => {
  it('LOCAL: summarised as built, held to LOCAL by the guard, no question and no line', async () => {
    const h = harness({ selected: 'local' });
    const result = await h.send(ASK);
    expect(result.reply.text).toContain(SUMMARY);
    expect(result.reply.text).not.toContain(LINE);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
  });

  it.each([
    ['unexpected', 'fake-other'],
    ['expected (A8.6: D8 asks even for the expected recipient)', 'fake-remote'],
  ] as const)('REMOTE %s in the DM: the listing, then ONE fixed question naming the recipient and the count; zero execute calls', async (_name, expectedKey) => {
    const h = harness({ expectedKey });
    const before = h.recordAssistant.length;
    const result = await h.send(ASK);
    const listing = await listingOf(h.state.items);
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(`${listing}\n${QUESTION}`);
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.runs).toEqual([]);
    // The step holds the asked refs as its item ids (ids only), the history keeps the listing and the question.
    expect(h.store.stateOf(SCOPE)).toBe('open');
    expect(h.recordAssistant.slice(before)).toEqual([`${listing}\n${QUESTION}`]);
    noContentInLogs(h);
  });

  it('a channel never asks: the listing only, no step, zero execute calls (W2)', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    const result = await h.send(ASK, CHANNEL);
    expect(result.reply.text).toBe(await listingOf(h.state.items));
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(CHANNEL) })).toBeUndefined();
    expect(h.executed).toEqual([]);
  });

  it('an unnamed REMOTE recipient: the listing plus the fixed not-sent line, no question, nothing sent', async () => {
    const h = harness({ selected: 'anon', expectedKey: 'fake-other' });
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${await listingOf(h.state.items)}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
  });

  it('another turn instead of a yes ends the question (A8.5 "the NEXT DM turn"): a new lookup asks anew, one yes is one call', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    await h.send(ASK);
    h.state.items = [item('A-1')];
    const second = await h.send(ASK);
    expect(second.reply.text.endsWith('지라 이슈 1건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)')).toBe(true);
    expect(h.executed).toEqual([]);
    await h.send('응');
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0]?.request.prompt).not.toContain('jira:A-2');
  });

  it('a stop while the lookup is in its pre-resolve: no question, no step, zero calls; a later yes sends nothing', async () => {
    const h = harness({ expectedKey: 'fake-other', stop: true });
    let release!: () => void;
    h.state.selectGate = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (h.state.selectEntered = resolve));
    const request = h.send(ASK);
    await entered;
    const stop = await h.send('에이전트 중지');
    expect(stop.reply.text).toContain('멈춤');
    release();
    const reply = await request;
    expect(reply.reply.text).toBe(await listingOf(h.state.items));
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    // No step is open, so the yes is ordinary chat: no item ever reaches a provider and no recipient line appears.
    const yes = await h.send('응');
    expect(yes.reply.text).not.toContain(LINE);
    expect(h.executed.filter((entry) => entry.request.prompt.includes(CANARY))).toEqual([]);
  });
});

describe('OQ1-4 continuation: the owner says yes to the D8 question (A8.6)', () => {
  async function asked(opts: HarnessOptions = {}, text = ASK) {
    const h = harness({ expectedKey: 'fake-other', ...opts });
    const question = await h.send(text);
    expect(question.reply.text.endsWith(QUESTION)).toBe(true);
    expect(h.executed).toEqual([]);
    return h;
  }

  it('a yes: the lookup re-runs, exactly one REMOTE call over exactly the asked refs, the reply ends with the recipient line', async () => {
    const h = await asked();
    const yes = await h.send('응');
    expect(yes.status).toBe('RESPONDED');
    expect(yes.reply.text).toContain(SUMMARY);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(h.events).toEqual(['commit', 'guard', 'execute']);
    expect(h.counts.queries).toBe(2);
    const prompt = h.executed[0]?.request.prompt ?? '';
    expect(prompt).toContain('[jira:A-1]');
    expect(prompt).toContain('[jira:A-2]');
    noContentInLogs(h);
  });

  it('the summarization request is byte-identical to the one the D8 path sends without a question', async () => {
    const consented = await asked();
    await consented.send('응');
    const direct = harness({ consent: 'absent' });
    await direct.send(ASK);
    expect(consented.executed).toHaveLength(1);
    expect(direct.executed).toHaveLength(1);
    expect(consented.executed[0]?.request).toEqual(direct.executed[0]?.request);
  });

  it('W3: an item the owner was not asked about is dropped; the call carries only the asked refs', async () => {
    const h = await asked();
    h.state.items = [item('A-0'), ...h.state.items];
    const yes = await h.send('응');
    expect(h.executed).toHaveLength(1);
    const prompt = h.executed[0]?.request.prompt ?? '';
    expect(prompt).not.toContain('jira:A-0');
    expect(prompt).toContain('[jira:A-1]');
    expect(prompt).toContain('[jira:A-2]');
    expect(yes.reply.text).toContain('외부 항목 2건을 요약에 사용했어요.');
    expect(yes.reply.text).not.toContain('browse/A-0');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
  });

  it('a changed set (an asked ref missing on the re-run): the fixed "changed" line, nothing sent', async () => {
    const h = await asked();
    h.state.items = [item('A-1'), item('A-3')];
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(renderItemSummaryChangedLine('ko'));
    expect(h.executed).toEqual([]);
  });

  it('a recipient flip after the yes (another REMOTE, expected or not): refused, the listing plus the not-sent line, nothing sent', async () => {
    for (const expectedKey of [undefined, 'fake-other']) {
      const h = await asked();
      h.state.selected = 'other';
      h.state.expectedKey = expectedKey;
      const yes = await h.send('응');
      expect(yes.reply.text).toBe(`${await listingOf(h.state.items)}\n${renderItemSummaryNotSentLine('ko')}`);
      expect(h.executed).toEqual([]);
    }
  });

  it('a flip between the continuation pre-resolve and hook 1: hook 1 refuses, zero calls, the listing without a line', async () => {
    const h = await asked();
    h.hooks.afterSelect = (n) => {
      if (n === 2) h.state.selected = 'other';
    };
    const yes = await h.send('응');
    expect(h.executed).toEqual([]);
    expect(yes.reply.text).toBe(await listingOf(h.state.items));
  });

  it('LOCAL after the yes: proceeds without the token, no line', async () => {
    const h = await asked();
    h.state.selected = 'local';
    const yes = await h.send('응');
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-local']);
    expect(yes.reply.text).not.toContain(LINE);
  });

  it('single use: the token is retired after the call and a second yes is no second summary', async () => {
    const h = await asked();
    const spent: ItemSummaryConsentToken[] = [];
    const spend = h.items!.spend.bind(h.items);
    h.items!.spend = (token) => {
      spent.push(token);
      spend(token);
    };
    await h.send('응');
    expect(spent).toHaveLength(1);
    const use = { phase: 'call' as const, actorId: OWNER.id, conversationKey: SCOPE.conversationKey, source: 'jira' as const, itemId: workLookupRefsKey(['jira:A-1', 'jira:A-2']), kind: 'work-lookup' as const };
    expect(h.items!.allowsContinuation(spent[0], { kind: 'unexpected', key: 'fake-remote', label: 'Remote' }, use)).toBe(false);
    const again = await h.send('응');
    expect(again.reply.text).not.toContain(LINE);
    expect(h.executed).toHaveLength(1);
  });

  it('expiry: a yes more than 600 s after the question is the expired line, nothing sent', async () => {
    const h = await asked();
    h.clock.now += 601_000;
    const yes = await h.send('응');
    expect(yes.reply.text).toBe('요약 확인 시간이 지났어요. 다시 요청해 주세요.');
    expect(h.executed).toEqual([]);
  });

  it('expiry during the re-run (more than 600 s from the mint): hook 1 refuses, nothing sent', async () => {
    const h = await asked();
    h.hooks.onQuery = (n) => {
      if (n === 2) h.clock.now += 601_000;
    };
    await h.send('응');
    expect(h.executed).toEqual([]);
  });

  it('a stop (voidAll) before the yes: the yes summarises nothing', async () => {
    const h = await asked();
    h.gate?.voidAll();
    const yes = await h.send('응');
    expect(yes.reply.text).not.toContain(SUMMARY);
    expect(h.executed).toEqual([]);
  });

  it('a no sends nothing', async () => {
    const h = await asked();
    await h.send('아니');
    expect(h.executed).toEqual([]);
    expect(h.counts.queries).toBe(1);
  });

  it('a refused re-run (the connector fails): the unavailable line, nothing sent', async () => {
    const h = await asked();
    h.hooks.onQuery = (n) => {
      if (n === 2) throw new Error('connector down');
    };
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(UNAVAILABLE);
    expect(h.executed).toEqual([]);
  });

  it('a lookup that came through selection re-runs through handleSelected with the same selection, never the selector', async () => {
    const h = await asked({ selectionProbe: true }, '선택한 지라 조회');
    expect(h.counts.handleSelected).toBe(1);
    const yes = await h.send('응');
    expect(h.counts.handleSelected).toBe(2);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.lookupHandler.id).toBe(WORK_CHAT_LOOKUP_TURN_HANDLER_ID);
  });
});

describe('OQ1-4 review round 1', () => {
  async function asked(opts: HarnessOptions = {}, text = ASK, marks: Pick<InboundMessage, 'quotedRanges' | 'formatting'> = {}) {
    const h = harness({ expectedKey: 'fake-other', ...opts });
    const question = await h.send(text, DM, marks);
    expect(question.reply.text.endsWith(QUESTION)).toBe(true);
    expect(h.executed).toEqual([]);
    return h;
  }

  it('item 2: every asked item gone on the re-run (a successful empty lookup): the fixed "changed" line, nothing sent', async () => {
    const h = await asked();
    h.state.items = [];
    const yes = await h.send('응');
    expect(yes.reply.text).toBe(renderItemSummaryChangedLine('ko'));
    expect(yes.reply.text).not.toBe(UNAVAILABLE);
    expect(h.counts.queries).toBe(2);
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('item 3: items overflowing the prompt budget: the listing shows more rows than the prompt carries, so no question; the listing plus the fixed not-sent line, nothing sent', async () => {
    const long = (id: string): ConnectorItem => ({ ...item(id), title: `${'긴 제목 '.repeat(30)}${id}`, summary: `${'본문 내용 '.repeat(70)}${id}` });
    const h = harness({ expectedKey: 'fake-other' });
    h.state.items = Array.from({ length: 10 }, (_, index) => long(`A-${index + 1}`));
    const listing = await listingOf(h.state.items);
    // The listing names all ten rows; the prompt budget fits fewer (the precondition of the finding).
    expect(listing).toContain('browse/A-10');
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${listing}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    noContentInLogs(h);
  });

  it('item 4: the re-run keeps the ASKING message\'s quoted ranges and formatting (offsets and flags only), stored with the request text', async () => {
    const marks = { quotedRanges: [{ start: 0, end: 2 }], formatting: { code: true as const } };
    const h = await asked({ selectionProbe: true }, '선택한 지라 조회', marks);
    // The yes itself carries no marks: the marks the re-run reads are the ones stored with the request text.
    const yes = await h.send('응');
    expect(h.counts.handleSelected).toBe(2);
    const rerun = h.selectedMessages[1];
    expect(rerun?.id.endsWith(':consent')).toBe(true);
    expect(rerun?.text).toBe('선택한 지라 조회');
    expect(rerun?.quotedRanges).toEqual(marks.quotedRanges);
    expect(rerun?.formatting).toEqual(marks.formatting);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
  });

  it('item 5: the EXPECTED REMOTE recipient: asked, yes, exactly one call, the reply ends with the A8.4 recipient line', async () => {
    const h = await asked({ expectedKey: 'fake-remote' });
    const yes = await h.send('응');
    expect(yes.status).toBe('RESPONDED');
    expect(yes.reply.text).toContain(SUMMARY);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    expect(h.events.filter((event) => event === 'execute')).toHaveLength(1);
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    noContentInLogs(h);
  });
});

describe('OQ1-4 review round 2: the question counts exactly the rows the listing displays', () => {
  /** A long URL: the prompt never carries URLs, so ten such items all fit the prompt while the listing's own budget drops rows. */
  const longUrlItem = (id: string): ConnectorItem => ({ ...item(id), url: `https://example.atlassian.net/browse/${id}/${'segment/'.repeat(30)}end` });
  const longItems = () => Array.from({ length: 10 }, (_, index) => longUrlItem(`A-${index + 1}`));

  it('reproduction: ten items fit the prompt but the listing displays fewer rows: no question, the not-sent line, zero calls', async () => {
    const items = longItems();
    // Precondition (the finding): the summary readout carries all ten; the listing's renderer reports fewer displayed rows.
    const desk = new WorkChatService(
      {
        workSurface: { forActor: async () => ({ status: 'COMPLETE', items: [], sources: [] }) },
        connectors: { list: () => [{ source: 'jira', readOnly: true, isAvailable: async () => true, query: async () => ({ source: 'jira', items }) }] },
        work: {} as WorkChatServiceDeps['work'],
      },
      { summaryEnabled: true },
    );
    const outcome = await desk.handle({ kind: 'lookup', source: 'jira', query: 'my-items' }, OWNER);
    expect(outcome.kind).toBe('summarize');
    if (outcome.kind !== 'summarize') return;
    expect(outcome.readout.items).toHaveLength(10);
    expect(outcome.listedRefs?.length).toBeGreaterThan(0);
    expect(outcome.listedRefs?.length).toBeLessThan(10);
    const listing = await listingOf(items);
    expect(listing).not.toContain('[jira:A-10]');

    const h = harness({ expectedKey: 'fake-other' });
    h.state.items = items;
    const result = await h.send(ASK);
    expect(result.reply.text).toBe(`${listing}\n${renderItemSummaryNotSentLine('ko')}`);
    expect(result.reply.text).not.toContain('보낼까요');
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
    // A later yes sends no item: there is no question to answer (it is an ordinary chat turn, no lookup re-run).
    await h.send('응');
    expect(h.counts.queries).toBe(1);
    expect(h.executed.filter((entry) => entry.request.capability === Capability.SUMMARIZATION)).toEqual([]);
    expect(JSON.stringify(h.executed)).not.toContain('jira:A-');
    noContentInLogs(h);
  });

  it('the count preview (a cut list of a count question) never asks: zero calls, no step', async () => {
    const h = harness({ expectedKey: 'fake-other', selectionProbe: true });
    h.state.items = Array.from({ length: 8 }, (_, index) => item(`A-${index + 1}`));
    const result = await h.send('선택한 지라 개수');
    expect(result.reply.text).toContain('[jira:A-1]');
    expect(result.reply.text).not.toContain('[jira:A-8]');
    expect(result.reply.text).not.toContain('보낼까요');
    expect(result.reply.text).not.toContain(renderItemSummaryNotSentLine('ko'));
    expect(h.store.stateOf(SCOPE)).toBeUndefined();
    expect(h.executed).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('the normal case: the listing displays every asked ref, so it asks, and a yes sends exactly those refs', async () => {
    const h = harness({ expectedKey: 'fake-other' });
    h.state.items = Array.from({ length: 10 }, (_, index) => item(`A-${index + 1}`));
    const listing = await listingOf(h.state.items);
    expect(listing).toContain('[jira:A-10]');
    const question = await h.send(ASK);
    expect(question.reply.text).toBe(`${listing}\n지라 이슈 10건을 Remote에 보내 요약할게요. 보낼까요? (응/아니)`);
    expect(h.executed).toEqual([]);
    const yes = await h.send('응');
    expect(yes.reply.text.endsWith(`\n${LINE}`)).toBe(true);
    expect(h.executed.map((entry) => entry.provider)).toEqual(['fake-remote']);
    const prompt = h.executed[0]?.request.prompt ?? '';
    for (let n = 1; n <= 10; n += 1) expect(prompt).toContain(`[jira:A-${n}]`);
    noContentInLogs(h);
  });

  it('flag off: the long-URL lookup is byte-identical with or without QUOKY_SUMMARY_CONSENT alone (summarised as built, no question)', async () => {
    const results = [];
    for (const consent of ['absent', 'gate'] as const) {
      const h = harness({ consent });
      h.state.items = longItems();
      const result = await h.send(ASK);
      results.push({ reply: view(result), requests: h.executed.map((entry) => entry.request), history: h.recordAssistant, runs: h.runs });
      expect(result.reply.text).toContain(SUMMARY);
      expect(result.reply.text).not.toContain('보낼까요');
      expect(h.counts.expected).toBe(0);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.requests).toHaveLength(1);
  });
});
