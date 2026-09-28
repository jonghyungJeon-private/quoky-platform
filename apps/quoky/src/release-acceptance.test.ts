import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  ContextBuilder,
  ExecutionOutcomeStatus,
  ExecutionStage,
  IntentClassifier,
  IntentResolver,
  MemoryManager,
  MemoryType,
  PromptComposer,
  PromptRenderer,
  ResponseComposer,
  RiskLevel,
  SessionStatus,
  TaskRunStatus,
  TaskStatus,
  type ContextBundle,
  type InboundMessage,
  type MemoryRecord,
  type MemoryRepository,
  type Session,
  type StorageProvider,
  type Task,
  type TaskRun,
  type VectorProvider,
} from '@quoky/core';
import { createProductionContextBuilder } from './context-builder-provider';
import {
  createProductionConversationRuntime,
  type ProductionConversationRuntimeDeps,
} from './conversation-runtime-provider';

const timestamp = '2026-08-25T00:00:00.000Z';
const context = { platform: 'test', channelId: 'channel-1', userId: 'user-1' };

function inbound(text: string): InboundMessage {
  return { id: `message-${text}`, context, text, receivedAt: timestamp };
}

function memoryRepository() {
  const records = new Map<string, MemoryRecord>();
  let failDurableRecall = false;
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
      if (failDurableRecall) throw new Error('durable repository unavailable');
      return [...records.values()]
        .filter((record) => record.type === MemoryType.LONG_TERM && matches(record, query.scope))
        .filter((record) => !query.excludeIds?.includes(record.id))
        .slice(0, query.limit);
    },
  };
  return {
    repository,
    records,
    failDurableRecall(value: boolean) { failDurableRecall = value; },
  };
}

function acceptanceHarness() {
  const memoryStore = memoryRepository();
  const storage = { memories: memoryStore.repository } as StorageProvider;
  const memory = new MemoryManager(storage, {} as VectorProvider);
  const productionContextBuilder = createProductionContextBuilder(memory, storage, {});
  const bundles: ContextBundle[] = [];
  const contextBuilder = {
    async build(task: Task, excludeMemoryIds: string[]) {
      const bundle = await productionContextBuilder.build(task, excludeMemoryIds);
      bundles.push(bundle);
      return bundle;
    },
  };
  const assistantReplies = ['첫 번째 답변', '두 번째 답변', '기억을 반영한 답변', '장애 중 답변'];
  const provider = {
    id: 'acceptance-fake-provider',
    capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }],
    async isAvailable() { return true; },
    async execute() { return { text: assistantReplies.shift() ?? '기본 답변', artifacts: [] }; },
  };
  const classifier = new IntentClassifier({ select: async () => provider } as never);
  const session: Session = {
    id: 'session-1', actorId: 'actor-1', context, status: SessionStatus.ACTIVE,
    createdAt: timestamp, lastActivityAt: timestamp,
  };
  let taskSequence = 0;
  let runSequence = 0;
  let workspaceMutations = 0;
  let orchestratorRuns = 0;
  const approvalAnchors: unknown[] = [];
  const deps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } },
    actors: { async resolveFromContext() { return { id: 'actor-1', displayName: 'User', identities: [], createdAt: timestamp }; } },
    sessions: { async openForContext() { return session; }, async touch() { return session; } },
    memory,
    classifier,
    projects: {
      async register() { return { ok: true, message: 'registered' }; },
      async get() { return { id: 'project-1', name: 'Project', rootPath: '/test/project', createdAt: timestamp }; },
    },
    analyzer: { async prepare() { return { ready: true }; } },
    tasks: {
      async createTask(intent: Task['intent'], taskContext: Task['context'], anchor: { requestText: string; actorId: string; sessionId: string; projectId?: string }) {
        taskSequence += 1;
        return {
          id: `task-${taskSequence}`, title: intent.summary, description: anchor.requestText,
          status: TaskStatus.PENDING, intent, riskLevel: RiskLevel.LOW, context: taskContext,
          actorId: anchor.actorId, sessionId: anchor.sessionId, ...(anchor.projectId ? { projectId: anchor.projectId } : {}),
          createdAt: timestamp, updatedAt: timestamp,
        } satisfies Task;
      },
      async transition(task: Task, status: TaskStatus) { return { ...task, status, updatedAt: timestamp }; },
      async startRun(task: Task, capability: Capability) {
        runSequence += 1;
        return { id: `run-${runSequence}`, taskId: task.id, attempt: 1, status: TaskRunStatus.RUNNING, capability, artifactIds: [], startedAt: timestamp } satisfies TaskRun;
      },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: {
      async prepare() { return undefined; },
      async open() { return { id: 'workspace-1', projectId: 'project-1', rootPath: '/test/project', createdAt: timestamp }; },
      async list(_workspace: unknown, glob?: string) { return glob === 'src/target.ts' ? ['src/target.ts'] : []; },
      async diff() { throw new Error('diff must not run before approval'); },
    },
    commandExecutions: { async get() { return null; } },
    command: { async run() { throw new Error('command must not run'); } },
    contextBuilder,
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router: { async select() { return provider; } },
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    risk: { requiresApproval(level: RiskLevel) { return level === RiskLevel.HIGH || level === RiskLevel.CRITICAL; } },
    intentResolver: new IntentResolver(),
    orchestrator: {
      async run() {
        orchestratorRuns += 1;
        return { status: ExecutionOutcomeStatus.AWAITING_APPROVAL, lastStage: ExecutionStage.APPROVAL, selectedStages: [ExecutionStage.PLANNING, ExecutionStage.APPROVAL], refs: { executionPlanRef: { id: 'plan-1', goal: 'change code' } } };
      },
      async resume() { throw new Error('resume must not run'); },
    },
    approvals: { async decide() { throw new Error('decide must not run'); }, async get() { return null; }, async requestForRisk() { throw new Error('requestForRisk must not run'); } },
    approvalFlow: { async findPending() { return null; }, async anchor(_session: unknown, request: unknown) { approvalAnchors.push(request); }, async reconstructResume() { return null; } },
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
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as ProductionConversationRuntimeDeps;
  const runtime = () => createProductionConversationRuntime(memory, deps);
  return {
    runtime, bundles, memoryStore, approvalAnchors,
    enableProject() { session.activeProjectId = 'project-1'; },
    workspaceMutations: () => workspaceMutations,
    orchestratorRuns: () => orchestratorRuns,
  };
}

describe('release acceptance — production composition boundary', () => {
  it('responds to normal chat and carries the immediate previous assistant turn as SHORT_TERM context', async () => {
    const harness = acceptanceHarness();
    const runtime = harness.runtime();

    const first = await runtime.handle(inbound('안녕'));
    const second = await runtime.handle(inbound('방금 답을 이어서 설명해줘'));

    expect(first.status).toBe('RESPONDED');
    expect(first.reply.text).not.toHaveLength(0);
    expect(second.status).toBe('RESPONDED');
    expect(harness.bundles[1]?.conversationTranscript).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: '첫 번째 답변', role: 'assistant' })]),
    );
  });

  it('pins current writer/retriever scope asymmetry while ADR-0073 durable recall remains a known open gap', async () => {
    const harness = acceptanceHarness();
    const firstRuntime = harness.runtime();

    const remembered = await firstRuntime.handle(inbound('기억해: 내 배포 창은 화요일이야'));
    const durable = [...harness.memoryStore.records.values()].filter((record) => record.type === MemoryType.LONG_TERM);
    const resumed = await harness.runtime().handle(inbound('내 배포 창을 알려줘'));

    expect(remembered.status).toBe('RESPONDED');
    expect(durable).toHaveLength(1);
    expect(durable[0]?.content).toBe('내 배포 창은 화요일이야');
    expect(durable[0]?.scope).toEqual({ sessionId: 'session-1', userId: 'actor-1' });
    expect(resumed.status).toBe('RESPONDED');
    // Pins current behavior only: the writer persists userId=actorId, while ContextBuilder omits actorId
    // from retrieval, so scopeMatches rejects the record. ADR-0073 durable recall remains a known gap
    // for a separately approved scope-reconciliation task, not a ratified release-accepted behavior.
    expect(harness.bundles.at(-1)?.durableRecall).toBeUndefined();
  });

  it('never promotes ordinary chat and keeps SHORT_TERM transcript separate from LONG_TERM recall', async () => {
    const harness = acceptanceHarness();
    const runtime = harness.runtime();
    await runtime.handle(inbound('평범한 대화야'));
    expect([...harness.memoryStore.records.values()].filter((record) => record.type === MemoryType.LONG_TERM)).toHaveLength(0);

    await runtime.handle(inbound('기억해: 장기 사실'));
    await runtime.handle(inbound('장기 사실을 회상해줘'));
    const bundle = harness.bundles.at(-1)!;

    expect(bundle.conversationTranscript.some((entry) => entry.content === '장기 사실')).toBe(false);
    // Pins current behavior only: writer userId=actorId and actorId-free ContextBuilder retrieval cannot
    // scope-match. This known ADR-0073 durable-recall gap requires a separately approved reconciliation task.
    expect(bundle.durableRecall).toBeUndefined();
    expect(bundle.conversationTranscript.every((entry) => entry.provenance !== 'DURABLE_MEMORY')).toBe(true);
  });

  it('degrades durable recall failure without displacing transcript or failing the turn', async () => {
    const harness = acceptanceHarness();
    const runtime = harness.runtime();
    await runtime.handle(inbound('기억해: 장애에도 남는 사실'));
    await runtime.handle(inbound('직전 대화를 만든다'));
    harness.memoryStore.failDurableRecall(true);

    const result = await runtime.handle(inbound('장애 중에도 답해줘'));
    const bundle = harness.bundles.at(-1)!;

    expect(result.status).toBe('RESPONDED');
    expect(bundle.durableRecall).toBeUndefined();
    expect(bundle.conversationTranscript.length).toBeGreaterThan(0);
  });

  it('fails closed at CODE_IMPLEMENTATION approval and never reaches workspace mutation', async () => {
    const harness = acceptanceHarness();
    harness.enableProject();

    const result = await harness.runtime().handle(inbound('/preview src/target.ts 파일을 수정해줘'));

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(harness.orchestratorRuns()).toBe(1);
    expect(harness.approvalAnchors).toHaveLength(1);
    expect(harness.workspaceMutations()).toBe(0);
  });
});
