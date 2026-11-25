import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ApprovalRequest, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun, WorkItem } from '../domain';
import type { AiProvider, Logger, PlatformAdapter, StorageProvider } from '../ports';
import { QuokyCore } from './orchestrator';
import { ApprovalManager } from './approval-manager';
import type { ApprovalPolicy } from './approval-policy';
import { ContextBuilder } from './context-builder';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import type { MemoryManager } from './memory-manager';
import type { MemoryRetriever } from './memory-retriever';
import type { MemoryWriter } from './memory-writer';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { ConsentPendingStore, summaryConsentPending } from './consent-answer/consent-pending';
import { ConsentTurnGate } from './consent-answer/consent-turn-gate';
import type { ConsentClassifierSwitch } from './consent-answer/consent-answer';

// CS-2: the consent gate on a REAL ConversationRuntime (and QuokyCore for the rerun). Only storage, the provider, the Task bookkeeping and
// the continuation are fakes. Without the gate option the turn is routed exactly as before (the rest of the runtime test folder pins that).

const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
const DM2: ConversationContext = { platform: 'test', channelId: 'dm-2', userId: 'owner-user', direct: true };
const CHANNEL: ConversationContext = { platform: 'test', spaceId: 'g-1', channelId: 'chan-1', userId: 'owner-user', direct: false };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-10-08T01:00:00.000Z';
const SUMMARY_TEXT = 'SUMMARY-OF-THE-CONFIRMED-ITEMS';
const EXPIRED = '요약 확인 시간이 지났어요. 다시 요청해 주세요.';
const CANCELLED = '요약을 취소했어요. 원문은 보내지 않았어요.';
const keyOf = (context: ConversationContext): string => ConsentTurnGate.conversationKeyOf(context);
const bad = (name: string) => () => {
  throw new Error(`${name} must not be called`);
};

interface Options {
  readonly gate?: boolean;
  readonly classifier?: ConsentClassifierSwitch;
  readonly selectionQuestionOpen?: boolean;
}

function harness(opts: Options = {}) {
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, ApprovalRequest>();
  const tasks = new Map<string, Task>();
  const workItems = new Map<string, WorkItem>();
  const calls = { classify: 0, recordAssistant: [] as string[], recordUser: [] as string[], continued: 0, voided: 0, prompts: 0 };
  const storage = {
    sessions: {
      async save(s: Session) { sessions.set(s.id, { ...s }); return s; },
      async get(id: string) { return sessions.get(id) ?? null; },
      async findActiveByContext(platform: string, channelId: string, threadId?: string) {
        return [...sessions.values()].find((s) => s.status === SessionStatus.ACTIVE && s.context.platform === platform && s.context.channelId === channelId && s.context.threadId === threadId) ?? null;
      },
    },
    approvals: {
      async save(a: ApprovalRequest) { approvals.set(a.id, { ...a }); return a; },
      async get(id: string) { return approvals.get(id) ?? null; },
      async findByExecutionPlan() { return []; },
    },
    tasks: {
      async get(id: string) { return tasks.get(id) ?? null; },
      async save(t: Task) { tasks.set(t.id, t); return t; },
    },
    workItems: {
      async get(id: string) { return workItems.get(id) ?? null; },
      async save(item: WorkItem) { workItems.set(item.id, item); return item; },
      async delete() { throw new Error('never'); },
      async list() { return [...workItems.values()]; },
      async listByActor() { return [...workItems.values()]; },
      async listByResource() { return []; },
    },
  };
  const sessionManager = new SessionManager(storage as unknown as StorageProvider);
  const approvalManager = new ApprovalManager(storage as unknown as StorageProvider, {} as ApprovalPolicy);
  const provider: AiProvider = {
    id: 'fake-chat',
    capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }],
    async isAvailable() { return true; },
    async execute() { calls.prompts += 1; return { text: '일반 대화 답변', artifacts: [] }; },
  };
  const shortTerm: MemoryRecord[] = [];
  const remember = (role: 'user' | 'assistant', content: string, sessionId?: string) => {
    const n = shortTerm.length + 1;
    const at = `2026-10-08T01:00:${String(n % 60).padStart(2, '0')}.000Z`;
    shortTerm.push({ id: `mem-${n}`, type: MemoryType.SHORT_TERM, scope: sessionId ? { sessionId } : {}, content, metadata: { role }, createdAt: at, updatedAt: at });
    return { id: `mem-${n}` };
  };
  const contextBuilder = new ContextBuilder(
    { async recentShortTerm(scope: { sessionId?: string }, limit: number) { return shortTerm.filter((r) => r.scope.sessionId === scope.sessionId).slice(-limit); }, async projectMemory() { return undefined; } } as unknown as MemoryManager,
    {},
    { async retrieve() { return []; } } as unknown as MemoryRetriever,
  );
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

  const store = new ConsentPendingStore();
  const clock = { now: 1_000_000 };
  const gate = new ConsentTurnGate({
    store,
    classifier: opts.classifier ?? { mode: 'off' },
    continueSummary: async () => {
      calls.continued += 1;
      return { kind: 'reply', reply: { text: SUMMARY_TEXT } };
    },
    voidContinuations: () => { calls.voided += 1; },
    now: () => clock.now,
  });
  const open = (context: ConversationContext = DM) =>
    store.open(summaryConsentPending({ scope: { actorId: OWNER.id, conversationKey: keyOf(context) }, language: 'ko', createdAtMs: clock.now, recipient: 'Claude', sources: [{ source: 'mail', itemIds: ['m1'] }], runRef: 'run-1' }));

  let taskSeq = 0;
  let stopHandled = 0;
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm(message: InboundMessage, sessionId?: string) { calls.recordUser.push(message.text); return remember('user', message.text, sessionId); },
      async recordAssistant(text: string, _context: ConversationContext, sessionId?: string) { calls.recordAssistant.push(text); remember('assistant', text, sessionId); return undefined; },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('createCandidate'), promote: bad('promote'), forget: bad('forget') } as unknown as MemoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        calls.classify++;
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
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: { prepare: async () => undefined, open: bad('workspace.open'), list: bad('list'), diff: bad('diff'), read: bad('read') },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: (task, exclude) => contextBuilder.build(task, exclude) },
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router: { async select() { return provider; } },
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: { decide: (id, d) => approvalManager.decide(id, d), get: (id) => approvalManager.get(id), requestForRisk: bad('approvals.requestForRisk') },
    approvalFlow: new StatelessApprovalFlow(storage),
    scopeClarificationFlow: { findPending: async () => null, anchor: bad('scope.anchor'), clear: async () => undefined },
    applyPreviewFlow: { findAnchor: async () => null, anchor: bad('applyPreview.anchor'), clear: async () => undefined },
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('getProposal') },
    patch: { generate: bad('patch.generate'), get: bad('patch.get') },
    codeProposals: { get: bad('codeProposals.get') },
    workspaceWrite: { apply: bad('workspaceWrite.apply') },
    git: { status: bad('git.status'), diff: bad('git.diff'), commitFiles: bad('git.commitFiles'), info: bad('git.info'), pushApprovedCommit: bad('git.pushApprovedCommit'), syncMain: bad('git.syncMain'), deleteMergedLocalBranch: bad('git.deleteMergedLocalBranch') },
    turnHandlers: [],
    // The agent kill-switch seam: only the stop phrase is handled (the A6 actions are absent), exactly the production shape in `shadow`.
    agentRuns: {
      mode: 'shadow',
      shadowAdmits: () => false,
      runShadow: bad('runShadow'),
      handleSwitchPhrase: async (_actor: Actor, text: string) => (text.trim() === '에이전트 중지' ? ((stopHandled += 1), '에이전트를 멈췄어요.') : undefined),
      switchSuffix: () => undefined,
    } as unknown as ConversationRuntimeDeps['agentRuns'],
    ...(opts.selectionQuestionOpen === true
      ? { nlSelection: { mode: 'off', takePending: async () => ({ kind: 'entry' }) } as unknown as ConversationRuntimeDeps['nlSelection'] }
      : {}),
    logger,
  };
  const runtime = new ConversationRuntime(deps, { clock: () => T0, ...(opts.gate === false ? {} : { consentTurnGate: gate }) });
  let seq = 0;
  const messageOf = (text: string, context: ConversationContext = DM): InboundMessage => ({ id: `msg-${++seq}`, context, text, receivedAt: T0 });
  const send = (text: string, context: ConversationContext = DM) => runtime.handle(messageOf(text, context));
  return { send, messageOf, runtime, calls, store, open, clock, shortTerm, deps, stopHandled: () => stopHandled, logger };
}

describe('the consent gate on the real runtime (CS-2)', () => {
  it('without a pending step the gate changes nothing: the turn is routed as chat, with and without the gate', async () => {
    for (const gate of [false, true]) {
      const h = harness({ gate });
      const result = await h.send('응');
      expect(result.reply.text).toBe('일반 대화 답변');
      expect([h.calls.classify, h.calls.continued]).toEqual([1, 0]);
      expect(result.rerun).toBeUndefined();
    }
  });

  it('a closed yes in the owner DM runs the continuation: no classifier, no chat; the history keeps the fixed note only', async () => {
    const h = harness();
    h.open();
    const result = await h.send('응');
    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toBe(SUMMARY_TEXT);
    expect([h.calls.classify, h.calls.prompts, h.calls.continued]).toEqual([0, 0, 1]);
    expect(h.calls.recordUser).toEqual(['응']);
    expect(h.calls.recordAssistant).toEqual(['(확인한 항목의 요약을 전달했어요.)']);
    expect(h.shortTerm.some((record) => record.content.includes(SUMMARY_TEXT))).toBe(false);
  });

  it('without the gate a pending step is never answered (flag off is the plain path)', async () => {
    const h = harness({ gate: false });
    h.open();
    const result = await h.send('응');
    expect(result.reply.text).toBe('일반 대화 답변');
    expect(h.calls.continued).toBe(0);
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM) })).toBe('open');
  });

  it('a closed no gets the fixed cancel line and no routing; ㅇㅇ cancels silently and routes; a late 응 is then told it lapsed', async () => {
    const no = harness();
    no.open();
    expect((await no.send('아니')).reply.text).toBe(CANCELLED);
    expect(no.calls.classify).toBe(0);

    const silent = harness();
    silent.open();
    const routed = await silent.send('ㅇㅇ');
    expect(routed.reply.text).toBe('일반 대화 답변');
    expect(silent.calls.classify).toBe(1);
    expect(silent.calls.continued).toBe(0);
    const late = await silent.send('응');
    expect(late.reply.text).toBe(EXPIRED);
    expect(silent.calls.classify).toBe(1);
  });

  it('a channel turn leaves the step open; another DM conversation does not claim it', async () => {
    const h = harness();
    h.open();
    expect((await h.send('응', CHANNEL)).reply.text).toBe('일반 대화 답변');
    expect((await h.send('응', DM2)).reply.text).toBe('일반 대화 답변');
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM) })).toBe('open');
    expect(h.calls.continued).toBe(0);
    expect((await h.send('응')).reply.text).toBe(SUMMARY_TEXT);
  });

  it('a control phrase forfeits the step without a claim and routes normally (도움말), so a later yes finds nothing', async () => {
    const h = harness();
    h.open();
    const help = await h.send('도움말');
    expect(help.reply.text).not.toBe(SUMMARY_TEXT);
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM) })).toBeUndefined();
    expect((await h.send('응')).reply.text).toBe('일반 대화 답변');
    expect(h.calls.continued).toBe(0);
  });

  it('another owner step (an open selection question) forfeits the step; the yes is the question\'s, never the consent\'s', async () => {
    const h = harness({ selectionQuestionOpen: true });
    h.open();
    await h.send('응');
    expect(h.calls.continued).toBe(0);
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM) })).toBeUndefined();
  });

  it('the kill-switch phrase voids every pending step (other conversations too) and drops the continuation records, then saves the stop', async () => {
    const h = harness();
    h.open(DM2);
    h.open(DM);
    const stopped = await h.send('에이전트 중지');
    expect(stopped.reply.text).toContain('에이전트를 멈췄어요.');
    expect(h.stopHandled()).toBe(1);
    expect(h.calls.voided).toBe(1);
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM2) })).toBe('voided');
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM) })).toBeUndefined();
    expect(h.calls.continued).toBe(0);
  });

  it('the resume phrase does not void', async () => {
    const h = harness();
    h.open(DM2);
    await h.send('에이전트 재개');
    expect(h.calls.voided).toBe(0);
    expect(h.store.stateOf({ actorId: OWNER.id, conversationKey: keyOf(DM2) })).toBe('open');
  });

  it('agent consent facts: the runtime supplies the conversation key and the owner-step flag', () => {
    const h = harness();
    const facts = (h.runtime as unknown as { agentConsentFacts(message: InboundMessage, pending: boolean): unknown }).agentConsentFacts(h.messageOf('x', DM), true);
    expect(facts).toEqual({ conversationKey: keyOf(DM), ownerStepPending: true });
  });

  describe('yes-and-more (classifier stub on, unit only)', () => {
    const on: ConsentClassifierSwitch = { mode: 'on', classify: async () => 'yes-and-more' };

    it('the result carries the rerun message (r-01 whole text; r-02 the lines after a closed yes); the rerun never reaches the gate', async () => {
      const h = harness({ classifier: on });
      h.open();
      const first = await h.send('좋아 드라이브도 같이');
      expect(first.reply.text).toBe(SUMMARY_TEXT);
      expect(first.rerun).toMatchObject({ text: '좋아 드라이브도 같이', context: DM });
      expect(first.rerun?.id.endsWith(':rerun')).toBe(true);
      expect(first.rerun?.attachments).toBeUndefined();
      expect(first.rerun?.quotedRanges).toBeUndefined();
      // The rerun is an ordinary turn: the step is used, so even a closed yes text cannot answer, widen or revive it.
      const second = await h.runtime.handle(first.rerun as InboundMessage);
      expect(second.reply.text).toBe('일반 대화 답변');
      expect(second.rerun).toBeUndefined();
      expect(h.calls.continued).toBe(1);

      const cut = harness({ classifier: on });
      cut.open();
      const two = await cut.send('응\n드라이브도 같이');
      expect(two.rerun?.text).toBe('드라이브도 같이');
    });

    it('QuokyCore delivers the first reply, then the rerun once as a new turn (two messages, depth 1)', async () => {
      const h = harness({ classifier: on });
      h.open();
      const sent: OutboundMessage[] = [];
      const platform = { platform: 'test', async start() {}, async stop() {}, onMessage() {}, onApprovalDecision() {}, async sendMessage(m: OutboundMessage) { sent.push(m); }, async sendTyping() {}, async requestApproval() {} } as unknown as PlatformAdapter;
      const core = new QuokyCore({ runtime: h.runtime, platform, logger: h.logger });
      await core.handleInboundMessage(h.messageOf('좋아 드라이브도 같이'));
      expect(sent.map((m) => m.text)).toEqual([SUMMARY_TEXT, '일반 대화 답변']);
      expect(h.calls.continued).toBe(1);
      expect(h.calls.classify).toBe(1);
    });
  });
});
