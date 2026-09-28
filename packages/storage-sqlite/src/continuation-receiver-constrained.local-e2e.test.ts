import { describe, expect, it, vi } from 'vitest';
import { AgentProfileRegistry, agentProfileId, ApprovalManager, ApprovalPolicy, Capability,
  ContinuationExecutionEntryService, ContinuationExecutionService, ContinuationReceiverExecutionService, ProviderDispatchCommitCoordinator,
  createWorkHandoff, ExecutionStatus, IntentType, RiskLevel, RiskPolicy, TaskManager, TaskRunStatus,
  WorkHandoffContinuationService, WorkItemStatus } from '@quoky/core';
import type { ContinuationExecutionRequestContext, ContinuationReceiverInput, ContinuationReceiverOutcome,
  ExecutionPlan, Task } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const ts = '2026-09-22T00:00:00.000Z';

/**
 * R1 adversarial contract (ADR-0089 amendment §30 TOCTOU, §31 Family-A constrained-only,
 * §32 canonical intent binding). These use the real 6J → Entry → guarded-start chain over SQLite,
 * proving effect-time capability rechecks close the receiver-support TOCTOU and that the receiver
 * observes intent facts bound to the exact guarded-start Task snapshot.
 */
async function harness(options: {
  supportedCapabilities?: readonly Capability[];
  planCapabilities?: readonly Capability[];
  taskCapability?: Capability;
  taskIntentType?: IntentType;
} = {}) {
  const supportedCapabilities = options.supportedCapabilities ?? [Capability.GENERAL_CHAT];
  const planCapabilities = options.planCapabilities ?? [Capability.GENERAL_CHAT];
  const taskCapability = options.taskCapability ?? Capability.GENERAL_CHAT;
  const taskIntentType = options.taskIntentType ?? IntentType.CHAT;
  const storage = new SqliteStorageProvider({ dbPath: ':memory:' });
  await storage.init();
  await storage.workItems.save({ id: 'work', actorId: 'actor', projectId: 'project', status: WorkItemStatus.ACTIVE,
    origin: 'conversation', resourceRefs: [], createdAt: ts, updatedAt: ts });
  await storage.workHandoffs.insert(createWorkHandoff({ id: 'handoff', workItemId: 'work',
    fromAgentProfileId: agentProfileId('source'), toAgentProfileId: agentProfileId('receiver'), objective: 'continue',
    resourceRefs: [], artifactIds: [], executionReceiptIds: [], createdAt: ts }));
  const profiles = new AgentProfileRegistry(['source', 'receiver'].map(id => ({ id: agentProfileId(id), displayName: id,
    role: id, purpose: id, instructions: id })));
  const tasks = new TaskManager(storage);
  const approvals = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  let task = await tasks.createTask({ type: taskIntentType, capability: taskCapability, confidence: 1,
    requiresWork: true, summary: 'continue' }, { platform: 'test', channelId: 'channel', userId: 'user' },
  { actorId: 'actor', projectId: 'project', requestText: 'continue' });
  const plan: ExecutionPlan = { id: 'plan', goal: 'continue', summary: 'continue', projectId: 'project', steps: [],
    requiredCapabilities: [...planCapabilities], requiredResources: [], estimatedChanges: { fileCount: 0, scope: 'none' },
    approvalRequired: false, overallRisk: RiskLevel.LOW,
    expectedArtifacts: [], status: ExecutionStatus.PENDING, createdAt: ts };
  task = await storage.tasks.save({ ...task, planId: plan.id });
  const preparation = new WorkHandoffContinuationService(storage, profiles, storage.continuationBindings, { tasks, approvals });
  await preparation.admit('handoff', task.id);
  const entry = new ContinuationExecutionEntryService(storage, profiles, storage.continuationBindings, tasks);
  const continuation = new ContinuationExecutionService(storage, profiles, storage.continuationBindings, preparation, entry);
  const receiver = { supportedCapabilities: Object.freeze([...supportedCapabilities]),
    receive: vi.fn(async (_input: ContinuationReceiverInput): Promise<ContinuationReceiverOutcome> =>
      ({ disposition: 'SUCCEEDED', artifactIds: ['artifact-1'] })) };
  const execution = new ContinuationReceiverExecutionService(storage, profiles, continuation, tasks, receiver);
  const request: ContinuationExecutionRequestContext = { trigger: 'EXPLICIT_CONTINUATION_EXECUTION_REQUEST',
    handoffId: 'handoff', taskId: task.id, actorId: 'actor', projectId: 'project', plan };
  const guarded = vi.spyOn(storage.taskRuns, 'guardedStart');
  return { storage, task, plan, profiles, tasks, entry, continuation, execution, receiver, request, guarded };
}

describe('R1 constrained-path adversarial contract (§30/§31/§32)', () => {
  it('§30 TOCTOU: early capability supported, Entry fresh read unsupported → no guarded start, no receiver', async () => {
    // Plan declares both Family-A capabilities so plan-structure proof passes on either Task snapshot.
    const f = await harness({ supportedCapabilities: [Capability.GENERAL_CHAT],
      planCapabilities: [Capability.GENERAL_CHAT, Capability.SUMMARIZATION] });
    // The early 6J read and Product policy see the supported capability; only the Entry fresh re-read
    // observes a capability the receiver does not support. Mutate exactly at the Entry fresh boundary.
    // 6J's early canonical read + Product policy observe the supported capability; only the Entry
    // fresh admission re-read (and everything downstream of it) flips to the unsupported capability.
    // Delegate to the real repository so the lifecycle RUNNING transition is honored on every read.
    const realGet = f.storage.tasks.get.bind(f.storage.tasks);
    let earlyReadDone = false;
    vi.spyOn(f.storage.tasks, 'get').mockImplementation(async (id: string) => {
      const current = await realGet(id);
      if (!earlyReadDone) { earlyReadDone = true; return current; }
      return current ? ({ ...current, intent: { ...current.intent, capability: Capability.SUMMARIZATION } } as Task) : current;
    });
    // Entry re-reads the fresh canonical Task and its effect-time capability recheck rejects the
    // now-unsupported capability, throwing a typed pre-start error before any guarded commit.
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toMatchObject({
      name: 'ContinuationExecutionEntryError', reason: 'INVALID_REQUEST' });
    expect(f.guarded).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
    await f.storage.close();
  });

  it('§30 guarded-start deep-equality closes the post-Entry-snapshot race → receiver never runs', async () => {
    const f = await harness();
    // Entry captures a fresh Task snapshot and builds guardedStart expected.task from it. We mutate the
    // stored Task immediately before the guarded transaction; the SQLite deep-equality re-read then
    // mismatches expected.task and rejects, so no run is committed and the receiver never dispatches.
    f.guarded.mockRestore();
    const realGuarded = f.storage.taskRuns.guardedStart.bind(f.storage.taskRuns);
    const raced = vi.spyOn(f.storage.taskRuns, 'guardedStart').mockImplementation(async (...args: Parameters<typeof realGuarded>) => {
      const stored = await f.storage.tasks.get(f.task.id);
      if (stored) await f.storage.tasks.save({ ...stored, title: 'raced-after-entry-snapshot' });
      return realGuarded(...args);
    });
    // The mutated stored Task no longer deep-equals the Entry snapshot captured as expected.task, so
    // the guarded transaction rejects with the specific typed error before committing any run.
    await expect(f.execution.executeExplicitContinuation(f.request)).rejects.toMatchObject({
      name: 'GuardedTaskRunStartError', code: 'TASK_NOT_EXECUTABLE' });
    expect(raced).toHaveBeenCalledTimes(1);
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
    await f.storage.close();
  });

  it('§31 Family-A constrained-only: constrained Entry enforces Family-A predicate at effect time', async () => {
    // A non-Family-A capability (CODE_IMPLEMENTATION) is denied on the constrained path before start.
    const f = await harness({ supportedCapabilities: [Capability.CODE_IMPLEMENTATION],
      planCapabilities: [Capability.CODE_IMPLEMENTATION], taskCapability: Capability.CODE_IMPLEMENTATION });
    const result = await f.execution.executeExplicitContinuation(f.request);
    // Product policy denies non-Family-A first; the constraint path never starts a run.
    expect(result.disposition).toBe('DENY');
    if (result.disposition === 'DENY') expect(result.reason).toBe('UNSUPPORTED_RECEIVER_CAPABILITY');
    expect(f.guarded).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    await f.storage.close();
  });

  it('§31 constraint-absent generic Entry.start remains unchanged (no Family-A globalization)', async () => {
    // The public generic Entry.start must not apply the constrained Family-A recheck. Because a
    // production non-Family-A path may exist later, generic start must not reject on Family-A grounds.
    const f = await harness({ taskCapability: Capability.GENERAL_CHAT });
    // Generic public path: no constraint supplied. Starts the exact run without a receiver-support gate.
    const started = await f.continuation.startExplicitContinuation(f.request);
    expect(started.disposition).toBe('ATTEMPT_STARTED');
    if (started.disposition !== 'ATTEMPT_STARTED') throw new Error('expected start');
    expect(started.taskRun.status).toBe(TaskRunStatus.STARTED);
    // The generic result exposes no boundTaskFacts (that is the constrained path's internal extension).
    expect((started as Record<string, unknown>).boundTaskFacts).toBeUndefined();
    await f.storage.close();
  });

  it('N-a canonical Task with missing intent yields a typed CANONICAL TASK_MISMATCH, not a raw TypeError', async () => {
    // A canonical Task exists but its intent is missing/malformed. The constrained 6J path must fail
    // through the typed canonical contract (stage CANONICAL, reason TASK_MISMATCH) rather than throwing
    // a raw TypeError when it would otherwise read task.intent.capability.
    const f = await harness();
    const realGet = f.storage.tasks.get.bind(f.storage.tasks);
    vi.spyOn(f.storage.tasks, 'get').mockImplementation(async (id: string) => {
      const current = await realGet(id);
      if (!current) return current;
      const { intent: _intent, ...withoutIntent } = current as Task;
      return withoutIntent as unknown as Task;
    });
    let result: Awaited<ReturnType<typeof f.execution.executeExplicitContinuation>> | undefined;
    let threw: unknown;
    try { result = await f.execution.executeExplicitContinuation(f.request); }
    catch (e) { threw = e; }
    // Must be a typed/bounded DENY, never a raw TypeError from reading intent.capability.
    expect(threw).toBeUndefined();
    expect(result!.disposition).toBe('DENY');
    if (result!.disposition !== 'DENY') throw new Error('expected deny');
    expect(result!.stage).toBe('CANONICAL');
    expect(result!.reason).toBe('TASK_MISMATCH');
    expect(f.guarded).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
    expect(await f.storage.taskRuns.listByTask(f.task.id)).toEqual([]);
    await f.storage.close();
  });

  it('§32 canonical intent binding: receiver observes the guarded-start-bound Task IntentType', async () => {
    // Use a distinctive IntentType so binding provenance is unambiguous. It must come from Entry's
    // fresh Task snapshot that becomes the guarded-start expected Task, not any earlier representation.
    const f = await harness({ supportedCapabilities: [Capability.PROJECT_ANALYSIS],
      planCapabilities: [Capability.PROJECT_ANALYSIS], taskCapability: Capability.PROJECT_ANALYSIS,
      taskIntentType: IntentType.PROJECT_ANALYSIS });
    const result = await f.execution.executeExplicitContinuation(f.request);
    expect(result.disposition).toBe('ATTEMPT_SUCCEEDED');
    expect(f.receiver.receive).toHaveBeenCalledTimes(1);
    const input = f.receiver.receive.mock.calls[0]![0];
    expect(input.boundTaskFacts).toEqual({ capability: Capability.PROJECT_ANALYSIS, intentType: IntentType.PROJECT_ANALYSIS });
    expect(input.boundTaskFacts.capability).toBe(input.taskRun.capability);
    expect(Object.isFrozen(input.boundTaskFacts)).toBe(true);
    await f.storage.close();
  });
});
