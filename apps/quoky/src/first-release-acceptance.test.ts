import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApprovalStatus,
  Capability,
  ContextBuilder,
  FeedbackRecorder,
  FeedbackSignalKind,
  FeedbackSummaryTurnHandler,
  QuokyCore,
  ExecutionOutcomeStatus,
  ExecutionStage,
  GitMainSyncBlockedError,
  GitPushBlockedError,
  IntentClassifier,
  IntentResolver,
  MemoryManager,
  MemoryType,
  PromptComposer,
  PromptRenderer,
  ResponseComposer,
  RiskLevel,
  SessionManager,
  SessionStatus,
  TaskRunStatus,
  TaskStatus,
  type AiRequest,
  type ApprovalRequest,
  type ConversationContext,
  type ConversationRuntime,
  type ConversationTurnHandler,
  type GitProvider,
  type InboundMessage,
  type MemoryRecord,
  type MemoryRepository,
  type OutboundMessage,
  type PlatformAdapter,
  type PlatformFeedbackSignal,
  type Session,
  type StorageProvider,
  type Task,
  type TaskRun,
  type VectorProvider,
} from '@quoky/core';
import { DiscordPlatformAdapter } from '@quoky/adapter-discord';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { loadConfig } from './config';
import { createProductionContextBuilder } from './context-builder-provider';
import {
  createProductionConversationRuntime,
  type ProductionConversationRuntimeDeps,
} from './conversation-runtime-provider';
import { PersonalGitGuard, PersonalGitPolicyError } from './personal-git-guard';

/**
 * Quoky Personal v1 — first-release OFFLINE acceptance (AC1..AC11 composed properties). Everything is an
 * in-process fake: no Discord gateway, no provider CLI, no network, no real git. Approval TTL checks use the default clock with a 30-minute margin, so results stay deterministic.
 * Live attended verification (AC12) is a separate gate: docs/uat/first-release-uat-packet.md.
 */

const timestamp = '2026-08-25T00:00:00.000Z';
const OWNER_ID = '111111111111111111';
const STRANGER_ID = '222222222222222222';
const DM_CHANNEL = '777777777777777777';
const GUILD_ID = '333333333333333333';
const ALLOWED_CHANNEL = '444444444444444444';

const dmContext: ConversationContext = { platform: 'discord', channelId: DM_CHANNEL, userId: OWNER_ID };
const channelContext: ConversationContext = {
  platform: 'discord', channelId: ALLOWED_CHANNEL, userId: OWNER_ID, spaceId: GUILD_ID,
};

let messageSequence = 0;
function inbound(text: string, context: ConversationContext = dmContext): InboundMessage {
  messageSequence += 1;
  return { id: `message-${messageSequence}`, context, text, receivedAt: timestamp };
}

function memoryRepository() {
  const records = new Map<string, MemoryRecord>();
  const matches = (record: MemoryRecord, scope: MemoryRecord['scope']) =>
    Object.entries(scope).every(([key, value]) => record.scope[key as keyof MemoryRecord['scope']] === value);
  const repository: MemoryRepository = {
    async get(id) { return records.get(id) ?? null; },
    async save(record) { records.set(record.id, record); return record; },
    async delete(id) { records.delete(id); },
    async list() { return [...records.values()]; },
    async findByScope(scope, type) {
      return [...records.values()].filter(
        (record) => matches(record, scope) && (type === undefined || record.type === type),
      );
    },
    async findDurableCandidates(query) {
      return [...records.values()]
        .filter((record) => record.type === MemoryType.LONG_TERM && matches(record, query.scope))
        .filter((record) => !query.excludeIds?.includes(record.id))
        .slice(0, query.limit);
    },
    async findShortTermByUser(userId) {
      return [...records.values()].filter((record) => record.type === MemoryType.SHORT_TERM && record.scope.userId === userId);
    },
  };
  return { repository, records };
}

/** In-memory SessionRepository so the REAL SessionManager (open / close semantics) is exercised. */
function sessionRepository() {
  const sessions = new Map<string, Session>();
  return {
    sessions,
    repository: {
      async get(id: string) { return sessions.get(id) ?? null; },
      async save(session: Session) { sessions.set(session.id, session); return session; },
      async delete(id: string) { sessions.delete(id); },
      async list() { return [...sessions.values()]; },
      async findActiveByContext(channelId: string, threadId?: string) {
        return [...sessions.values()]
          .filter((s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId && s.context.threadId === threadId)
          .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0] ?? null;
      },
    },
  };
}

function pendingApproval(): ApprovalRequest {
  const created = new Date().toISOString();
  return {
    id: 'approval-1',
    executionPlanRef: { id: 'plan-1', goal: 'change code' },
    status: ApprovalStatus.PENDING,
    riskLevel: RiskLevel.HIGH,
    reason: '코드 변경 계획 승인',
    requestedBy: 'actor-owner',
    createdAt: created,
    updatedAt: created,
  } as ApprovalRequest;
}

function harness(options: {
  withPendingApproval?: boolean;
  memoryStore?: ReturnType<typeof memoryRepository>;
  turnHandlers?: readonly ConversationTurnHandler[];
} = {}) {
  const memoryStore = options.memoryStore ?? memoryRepository();
  const sessionStore = sessionRepository();
  const storage = { memories: memoryStore.repository, sessions: sessionStore.repository } as unknown as StorageProvider;
  const memory = new MemoryManager(storage, {} as VectorProvider);
  const productionContextBuilder = createProductionContextBuilder(memory, storage, {});

  const prompts: string[] = [];
  let providerCalls = 0;
  const provider = {
    id: 'acceptance-fake-provider',
    capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }],
    async isAvailable() { return true; },
    async execute(request: AiRequest) {
      providerCalls += 1;
      prompts.push(request.prompt);
      return { text: `답변 ${providerCalls}`, artifacts: [] };
    },
  };
  const classifier = new IntentClassifier({ select: async () => provider } as never);

  const pending = options.withPendingApproval ? pendingApproval() : null;
  const decisions: Array<{ approvalId: string; approved: boolean; comment?: string }> = [];
  let resumes = 0;
  let workspaceMutations = 0;
  let taskSequence = 0;
  let runSequence = 0;
  const createdTasks = new Map<string, Task>();

  const deps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } },
    actors: {
      async resolveFromContext(context: ConversationContext) {
        return { id: `actor-${context.userId}`, displayName: 'Owner', identities: [], createdAt: timestamp };
      },
    },
    sessions: new SessionManager(storage),
    memory,
    classifier,
    projects: {
      async register() { return { ok: true, message: 'registered' }; },
      async get() { return null; },
    },
    analyzer: { async prepare() { return { ready: true }; } },
    tasks: {
      async createTask(intent: Task['intent'], taskContext: Task['context'], anchor: { requestText: string; actorId: string; sessionId: string }) {
        taskSequence += 1;
        const task = {
          id: `task-${taskSequence}`, title: intent.summary, description: anchor.requestText,
          status: TaskStatus.PENDING, intent, riskLevel: RiskLevel.LOW, context: taskContext,
          actorId: anchor.actorId, sessionId: anchor.sessionId, createdAt: timestamp, updatedAt: timestamp,
        } satisfies Task;
        createdTasks.set(task.id, task);
        return task;
      },
      async transition(task: Task, status: TaskStatus) { return { ...task, status, updatedAt: timestamp }; },
      async startRun(task: Task, capability: Capability) {
        runSequence += 1;
        return { id: `run-${runSequence}`, taskId: task.id, attempt: 1, status: TaskRunStatus.STARTED, capability, artifactIds: [], startedAt: timestamp } satisfies TaskRun;
      },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: {
      async prepare() { return undefined; },
      async open() { throw new Error('workspace must not open'); },
      async list() { return []; },
      async diff() { throw new Error('diff must not run'); },
      async read() { throw new Error('read must not run'); },
    },
    commandExecutions: { async get() { return null; } },
    command: { async run() { throw new Error('command must not run'); } },
    contextBuilder: productionContextBuilder as ContextBuilder,
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router: { async select() { return provider; } },
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    risk: { requiresApproval(level: RiskLevel) { return level === RiskLevel.HIGH || level === RiskLevel.CRITICAL; } },
    intentResolver: new IntentResolver(),
    orchestrator: {
      async run() {
        return { status: ExecutionOutcomeStatus.AWAITING_APPROVAL, lastStage: ExecutionStage.APPROVAL, selectedStages: [], refs: {} };
      },
      async resume() { resumes += 1; throw new Error('resume must not run'); },
    },
    approvals: {
      async decide(approvalId: string, decision: { approved: boolean; comment?: string }) {
        decisions.push({ approvalId, approved: decision.approved, ...(decision.comment ? { comment: decision.comment } : {}) });
        return undefined;
      },
      // The shared decision service re-reads the request inside its lock (ADR-0113 D7): PENDING until decided.
      async get(id: string) { return pending?.id === id && !decisions.some((d) => d.approvalId === id) ? pending : null; },
      async requestForRisk() { throw new Error('requestForRisk must not run'); },
    },
    approvalFlow: {
      async findPending() { return pending; },
      async anchor() { return undefined; },
      async reconstructResume() { return null; },
    },
    scopeClarificationFlow: { async findPending() { return null; }, async anchor() { return undefined; }, async clear() { return undefined; } },
    applyPreviewFlow: { async findAnchor() { return null; }, async anchor() { return undefined; }, async clear() { return undefined; } },
    codeGeneration: { async generate() { throw new Error('generation must not run'); }, async getProposal() { return null; } },
    patch: { async generate() { throw new Error('patch must not run'); }, async get() { return null; } },
    codeProposals: { async get() { return null; } },
    workspaceWrite: { async apply() { workspaceMutations += 1; throw new Error('workspace mutation must not run'); } },
    git: {
      async status() { throw new Error('git must not run'); }, async diff() { throw new Error('git must not run'); },
      async commitFiles() { throw new Error('git must not run'); }, async info() { throw new Error('git must not run'); },
      async pushApprovedCommit() { throw new Error('git must not run'); }, async syncMain() { throw new Error('git must not run'); },
      async deleteMergedLocalBranch() { throw new Error('git must not run'); },
      async createBranch() { throw new Error('git must not run'); },
      async switchBranch() { throw new Error('git must not run'); },
      async getLocalRefCommit() { throw new Error('git must not run'); },
    },
    ...(options.turnHandlers ? { turnHandlers: options.turnHandlers } : {}),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as ProductionConversationRuntimeDeps;

  const runtime = () => createProductionConversationRuntime(memory, deps);
  return {
    runtime,
    prompts,
    decisions,
    memoryStore,
    sessionStore,
    createdTasks,
    providerCalls: () => providerCalls,
    resumes: () => resumes,
    workspaceMutations: () => workspaceMutations,
    longTermRecords: () => [...memoryStore.records.values()].filter((r) => r.type === MemoryType.LONG_TERM),
  };
}

const FACT = '내 배포 창은 화요일이야';
const QUESTION = '내 배포 창을 알려줘';

describe('first-release offline acceptance — composed Personal v1 properties', () => {
  it('"기억해: X" -> "새 대화" -> a question recalls X into the provider prompt', async () => {
    const h = harness();
    const runtime = h.runtime();

    const remembered = await runtime.handle(inbound(`기억해: ${FACT}`));
    const firstSessionId = remembered.sessionId;
    const reset = await runtime.handle(inbound('새 대화'));
    expect(reset.status).toBe('RESPONDED');
    const callsBeforeQuestion = h.providerCalls();

    const answered = await runtime.handle(inbound(QUESTION));

    expect(answered.status).toBe('RESPONDED');
    expect(answered.sessionId).not.toBe(firstSessionId);
    expect(h.providerCalls()).toBe(callsBeforeQuestion + 1);
    expect(h.prompts.at(-1)).toContain(FACT);
    expect(h.longTermRecords()).toHaveLength(1);
  });

  it('memory saved in a DM-context session is recalled in a channel-context session for the same actor', async () => {
    const h = harness();
    const runtime = h.runtime();

    const saved = await runtime.handle(inbound(`기억해: ${FACT}`, dmContext));
    const answered = await runtime.handle(inbound(QUESTION, channelContext));

    expect(answered.status).toBe('RESPONDED');
    expect(answered.sessionId).not.toBe(saved.sessionId);
    expect(h.prompts.at(-1)).toContain(FACT);
  });

  it('a negated approval ("진행하지 마") is denied, never approved, and nothing is applied', async () => {
    const h = harness({ withPendingApproval: true });
    const runtime = h.runtime();

    const result = await runtime.handle(inbound('진행하지 마'));

    expect(result.status).toBe('DENIED');
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]).toMatchObject({ approvalId: 'approval-1', approved: false });
    expect(h.decisions.some((d) => d.approved)).toBe(false);
    expect(h.resumes()).toBe(0);
    expect(h.workspaceMutations()).toBe(0);
    expect(h.providerCalls()).toBe(0);
  });

  it('an ordinary message while approval is pending gets a reminder, not chat and not an approval', async () => {
    const h = harness({ withPendingApproval: true });

    const result = await h.runtime().handle(inbound('음, 이게 뭐였죠'));

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).toContain('"승인"');
    expect(result.reply.text).toContain('"새 대화"');
    expect(h.decisions).toHaveLength(0);
    expect(h.providerCalls()).toBe(0);
  });

  it('"도움말" returns help without any provider call or memory write', async () => {
    const h = harness();

    const result = await h.runtime().handle(inbound('도움말'));

    expect(result.status).toBe('RESPONDED');
    expect(result.reply.text).toContain('Quoky로 할 수 있는 일이에요.');
    expect(result.reply.text).toContain('"새 대화"');
    expect(h.providerCalls()).toBe(0);
    expect(h.longTermRecords()).toHaveLength(0);
  });

  it('"새 대화" closes the session and the next message opens a different one', async () => {
    const h = harness();
    const runtime = h.runtime();

    const first = await runtime.handle(inbound('안녕'));
    expect(h.sessionStore.sessions.get(first.sessionId)?.status).toBe(SessionStatus.ACTIVE);

    const reset = await runtime.handle(inbound('새 대화'));
    expect(reset.reply.text).toContain('새 대화를 시작할게요');
    expect(h.sessionStore.sessions.get(first.sessionId)?.status).toBe(SessionStatus.CLOSED);
    const callsAfterReset = h.providerCalls();

    const next = await runtime.handle(inbound('다시 안녕'));
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(h.sessionStore.sessions.get(next.sessionId)?.status).toBe(SessionStatus.ACTIVE);
    expect(callsAfterReset).toBe(1);
  });

  it('PersonalGitGuard refuses remote git operations by default and commits on main', async () => {
    const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: OWNER_ID } as NodeJS.ProcessEnv);
    expect(config.git.remoteEnabled).toBe(false);

    const invoked: string[] = [];
    const inner = {
      kind: 'fake-git',
      async info(rootPath: string) { invoked.push('info'); return { isRepository: true, rootPath, branch: 'main', detached: false }; },
      async pushApprovedCommit() { invoked.push('push'); return {}; },
      async getRemoteRefCommit() { invoked.push('getRemoteRefCommit'); return { commitHash: 'a'.repeat(40) }; },
      async syncMainFastForward() { invoked.push('syncMain'); return {}; },
      async deleteMergedLocalBranch() { invoked.push('deleteBranch'); return {}; },
      async commitFiles() { invoked.push('commit'); return {}; },
      async createBranch() { invoked.push('createBranch'); return {}; },
      async switchBranch() { invoked.push('switchBranch'); return {}; },
    } as unknown as GitProvider;
    const guard = new PersonalGitGuard(inner, { remoteEnabled: config.git.remoteEnabled });

    await expect(guard.pushApprovedCommit('/r', 'origin', 'feature/x', 'a'.repeat(40))).rejects.toBeInstanceOf(GitPushBlockedError);
    await expect(guard.getRemoteRefCommit('/r', 'origin', 'main')).rejects.toBeInstanceOf(GitMainSyncBlockedError);
    expect(invoked).toEqual([]);

    await expect(guard.commitFiles('/r', ['a.ts'], 'msg')).rejects.toBeInstanceOf(PersonalGitPolicyError);
    expect(invoked).not.toContain('commit');
    expect(invoked).not.toContain('push');
  });

  it('PersonalGitGuard keeps main/master protected for branch creation and push even with remote on (ADR-0099)', async () => {
    const invoked: string[] = [];
    const inner = {
      kind: 'fake-git',
      async info(rootPath: string) { invoked.push('info'); return { isRepository: true, rootPath, branch: 'feature/x', detached: false }; },
      async pushApprovedCommit() { invoked.push('push'); return {}; },
      async createBranch() { invoked.push('createBranch'); return {}; },
      async switchBranch() { invoked.push('switchBranch'); return {}; },
    } as unknown as GitProvider;
    const guard = new PersonalGitGuard(inner, { remoteEnabled: true });

    await expect(guard.pushApprovedCommit('/r', 'origin', 'main', 'a'.repeat(40))).rejects.toBeInstanceOf(GitPushBlockedError);
    await expect(guard.createBranch('/r', 'Main', 'a'.repeat(40))).rejects.toBeInstanceOf(PersonalGitPolicyError);
    expect(invoked).toEqual([]);

    await guard.createBranch('/r', 'feature/x', 'a'.repeat(40));
    await guard.switchBranch('/r', 'feature/y');
    expect(invoked).toEqual(['createBranch', 'switchBranch']);
  });

  it('the Discord adapter gate silently ignores a non-owner and admits the owner (fake Message)', async () => {
    const received: InboundMessage[] = [];
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const adapter = new DiscordPlatformAdapter(
      { token: 'fake-token', ownerIds: [OWNER_ID], channelIds: [ALLOWED_CHANNEL] },
      logger,
    );
    adapter.onMessage(async (message) => { received.push(message); });
    const handle = (message: unknown) =>
      (adapter as unknown as { handleMessageCreate(m: unknown): Promise<void> }).handleMessageCreate(message);
    const fake = (authorId: string, guildId: string | null, channelId: string) => ({
      id: `discord-${authorId}-${channelId}`,
      content: '안녕',
      author: { id: authorId, bot: false },
      guildId,
      channelId,
      channel: { isThread: () => false, parentId: null },
    });

    await handle(fake(STRANGER_ID, null, DM_CHANNEL));
    await handle(fake(STRANGER_ID, GUILD_ID, ALLOWED_CHANNEL));
    expect(received).toHaveLength(0);

    await handle(fake(OWNER_ID, null, DM_CHANNEL));
    await handle(fake(OWNER_ID, GUILD_ID, ALLOWED_CHANNEL));
    await handle(fake(OWNER_ID, GUILD_ID, '555555555555555555'));
    expect(received.map((m) => m.context.channelId)).toEqual([DM_CHANNEL, ALLOWED_CHANNEL]);
  });
});

// ── ADR-0098 D3–D6 (QUAL-4): feedback capture end to end — real SQLite (temporary database, migrated to the
// latest schema), the real FeedbackRecorder and 피드백 요약 handler, the real QuokyCore, and a fake platform.
const feedbackDirs: string[] = [];
const openStores: SqliteStorageProvider[] = [];
afterAll(async () => {
  for (const store of openStores) await store.close().catch(() => undefined);
  for (const dir of feedbackDirs) rmSync(dir, { recursive: true, force: true });
});

async function feedbackHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-qual4-acceptance-'));
  feedbackDirs.push(dir);
  const store = new SqliteStorageProvider({ dbPath: join(dir, 'quoky.db') });
  await store.init();
  openStores.push(store);

  let nowMs = Date.parse('2026-10-02T09:00:00.000Z');
  const clock = () => new Date(nowMs).toISOString();
  const advance = (ms: number) => { nowMs += ms; };

  // The runtime harness keeps its own in-memory sessions; the recorder resolves the actor from them.
  let sessionLookup: { get(id: string): Promise<Session | null> } = { async get() { return null; } };
  const recorder = new FeedbackRecorder(store.feedback, { get: (id) => sessionLookup.get(id) }, { clock });
  let tasksLookup = new Map<string, Task>();
  const summaryHandler = new FeedbackSummaryTurnHandler({
    feedback: recorder,
    tasks: { async get(id) { return tasksLookup.get(id) ?? null; } },
  });
  const h = harness({ turnHandlers: [summaryHandler] });
  sessionLookup = h.sessionStore.repository;
  tasksLookup = h.createdTasks;

  const sends: OutboundMessage[] = [];
  let outSequence = 0;
  const platform: PlatformAdapter = {
    platform: 'discord',
    async start() {}, async stop() {}, onMessage() {}, onApprovalDecision() {},
    async sendMessage(message) {
      sends.push(message);
      outSequence += 1;
      return { platformMessageIds: [`out-${outSequence}a`, `out-${outSequence}b`] };
    },
    async sendTyping() {},
    async requestApproval() {},
  };
  const runtime: ConversationRuntime = h.runtime();
  const core = new QuokyCore({ runtime, platform, logger: { info() {}, warn() {}, error() {} }, feedback: recorder, clock });
  const react = (targetPlatformMessageId: string, rating: 'POSITIVE' | 'NEGATIVE', action: 'ADDED' | 'REMOVED' = 'ADDED') => {
    const signal: PlatformFeedbackSignal = {
      platform: 'discord', context: dmContext, targetPlatformMessageId, rating, action, occurredAt: clock(),
    };
    return core.handleFeedbackSignal(signal);
  };
  return { store, core, sends, react, advance, h };
}

describe('feedback capture offline acceptance (ADR-0098, QUAL-4)', () => {
  it('work turn → 👍 on its second chunk → "피드백 요약" shows 1 positive and no provider id', async () => {
    const f = await feedbackHarness();

    await f.core.handleInboundMessage(inbound('배포 창을 알려줘'));
    expect(f.sends).toHaveLength(1);
    const providerCallsAfterWork = f.h.providerCalls();
    expect(providerCallsAfterWork).toBe(1);

    const stored = await f.store.feedback.findTurnByPlatformMessage('discord', 'out-1b');
    expect(stored).toMatchObject({
      status: 'RESPONDED', capability: Capability.GENERAL_CHAT, taskId: 'task-1',
      providerId: 'acceptance-fake-provider', platformMessageIds: ['out-1a', 'out-1b'],
    });
    expect(JSON.stringify(stored)).not.toContain('배포 창을 알려줘');
    expect(JSON.stringify(stored)).not.toContain('답변 1');

    f.advance(5_000);
    await f.react('out-1b', 'POSITIVE');
    expect(f.sends).toHaveLength(1); // a reaction never produces a reply

    f.advance(5_000);
    await f.core.handleInboundMessage(inbound('피드백 요약'));
    expect(f.sends).toHaveLength(2);
    const summaryText = f.sends[1]!.text;
    expect(summaryText).toContain('최근 30일 피드백 요약이에요.');
    expect(summaryText).toContain('- 기록된 대화 1건 · 👍 1 · 👎 0');
    expect(summaryText).toContain('일반 대화');
    expect(summaryText).not.toContain('GENERAL_CHAT');
    expect(summaryText).not.toContain('acceptance-fake-provider');
    expect(f.h.providerCalls()).toBe(providerCallsAfterWork);
    expect(f.h.longTermRecords()).toHaveLength(0);
  });

  it('👎 then removal retracts; a recent 👎 lists the request excerpt only', async () => {
    const f = await feedbackHarness();
    await f.core.handleInboundMessage(inbound('배포 창을 알려줘'));
    await f.react('out-1a', 'NEGATIVE');
    await f.core.handleInboundMessage(inbound('피드백 요약'));
    expect(f.sends.at(-1)!.text).toContain('👎 1');
    expect(f.sends.at(-1)!.text).toContain('"배포 창을 알려줘"');

    await f.react('out-1a', 'NEGATIVE', 'REMOVED');
    await f.core.handleInboundMessage(inbound('피드백 요약'));
    expect(f.sends.at(-1)!.text).toContain('👍 0 · 👎 0');
    expect(f.sends.at(-1)!.text).not.toContain('최근 👎 답변');
  });

  it('a reaction on an unknown message or on the summary reply itself records nothing', async () => {
    const f = await feedbackHarness();
    await f.core.handleInboundMessage(inbound('피드백 요약'));
    await f.react('out-1a', 'POSITIVE'); // the control reply
    await f.react('not-a-bot-reply', 'POSITIVE');
    const summary = await f.store.feedback.summarize({ actorId: `actor-${OWNER_ID}`, since: '2026-01-01T00:00:00.000Z', recentNegativeLimit: 5 });
    expect(summary.signals).toEqual([]);
  });

  it('"새 대화" 30 s after a reply records IMPLICIT_RESET_AFTER_REPLY on that reply\'s turn', async () => {
    const f = await feedbackHarness();
    await f.core.handleInboundMessage(inbound('배포 창을 알려줘'));
    f.advance(30_000);
    await f.core.handleInboundMessage(inbound('새 대화'));

    const summary = await f.store.feedback.summarize({ actorId: `actor-${OWNER_ID}`, since: '2026-01-01T00:00:00.000Z', recentNegativeLimit: 5 });
    expect(summary.turnCount).toBe(1); // the reset is a control turn: recorded, never counted or rated
    expect(summary.signals).toEqual([
      { kind: FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY, value: 'OBSERVED', count: 1 },
    ]);
  });

  it('a reset long after a reply is not evidence', async () => {
    const f = await feedbackHarness();
    await f.core.handleInboundMessage(inbound('배포 창을 알려줘'));
    f.advance(10 * 60_000);
    await f.core.handleInboundMessage(inbound('새 대화'));
    const summary = await f.store.feedback.summarize({ actorId: `actor-${OWNER_ID}`, since: '2026-01-01T00:00:00.000Z', recentNegativeLimit: 5 });
    expect(summary.signals).toEqual([]);
  });

  it('the Discord reaction gate drops a non-owner reaction before it can reach QuokyCore', async () => {
    const signals: PlatformFeedbackSignal[] = [];
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const adapter = new DiscordPlatformAdapter({ token: 'fake-token', ownerIds: [OWNER_ID], channelIds: [ALLOWED_CHANNEL] }, logger);
    adapter.onFeedback(async (signal) => { signals.push(signal); });
    (adapter as unknown as { client: unknown }).client = { user: { id: '888888888888888888' } };
    const react = (userId: string) =>
      (adapter as unknown as { handleReaction(r: unknown, u: unknown, a: string): Promise<void> }).handleReaction(
        {
          emoji: { id: null, name: '👍' },
          message: {
            id: 'out-1a', partial: false, author: { id: '888888888888888888' }, guildId: null, channelId: DM_CHANNEL,
            channel: { isThread: () => false, parentId: null },
          },
        },
        { id: userId },
        'ADDED',
      );

    await react(STRANGER_ID);
    expect(signals).toHaveLength(0);
    await react(OWNER_ID);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ targetPlatformMessageId: 'out-1a', rating: 'POSITIVE', context: { userId: OWNER_ID } });
  });
});
