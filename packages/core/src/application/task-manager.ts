import { InvalidTaskTransitionError } from '../errors';
import { newId } from '../util/id';
import { now } from '../util/clock';
import { Capability, RiskLevel, TaskRunStatus, TaskStatus } from '../domain';
import type { ConversationContext, Id, Intent, Metadata, RunUsageRecord, Task, TaskRun } from '../domain';
import type {
  ContinuationContainmentAudit,
  ContinuationContainmentEvidenceSink,
  GuardedTaskRunStartFacts,
  StorageProvider,
} from '../ports';

/**
 * Owns Task / TaskRun lifecycle and persistence. The status state machine is
 * deterministic policy, so it is implemented in v1; the cognition that decides
 * WHICH transition to make lives in the orchestrator and planner.
 *
 * R3-A: TaskManager is also the owner-side implementation of ContinuationContainmentEvidenceSink; the
 * narrow sink port is what the continuation composition receives, delegating here.
 */
export class TaskManager implements ContinuationContainmentEvidenceSink {
  /** Allowed status transitions. Terminal states map to []. */
  private static readonly TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
    [TaskStatus.PENDING]: [TaskStatus.PLANNING, TaskStatus.CANCELED],
    [TaskStatus.PLANNING]: [
      TaskStatus.WAITING_APPROVAL,
      TaskStatus.RUNNING,
      TaskStatus.FAILED,
      TaskStatus.CANCELED,
    ],
    [TaskStatus.WAITING_APPROVAL]: [TaskStatus.RUNNING, TaskStatus.CANCELED],
    [TaskStatus.RUNNING]: [
      TaskStatus.TESTING,
      TaskStatus.NEEDS_REVIEW,
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.CANCELED,
    ],
    [TaskStatus.TESTING]: [TaskStatus.COMPLETED, TaskStatus.NEEDS_REVIEW, TaskStatus.FAILED],
    [TaskStatus.NEEDS_REVIEW]: [TaskStatus.RUNNING, TaskStatus.COMPLETED, TaskStatus.CANCELED],
    [TaskStatus.FAILED]: [TaskStatus.PLANNING], // allow retry by re-planning
    [TaskStatus.CANCELED]: [],
    [TaskStatus.COMPLETED]: [],
  };

  constructor(private readonly storage: StorageProvider) {}

  async createTask(
    intent: Intent,
    context: ConversationContext,
    opts: { requestText: string; actorId?: Id; sessionId?: Id; projectId?: Id },
  ): Promise<Task> {
    const ts = now();
    const task: Task = {
      id: newId(),
      title: intent.summary.slice(0, 80),
      description: opts.requestText,
      status: TaskStatus.PENDING,
      intent,
      // Provisional; the Planner sets the real risk once the plan is known.
      riskLevel: RiskLevel.LOW,
      context,
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    return this.storage.tasks.save(task);
  }

  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return TaskManager.TRANSITIONS[from].includes(to);
  }

  async transition(task: Task, to: TaskStatus): Promise<Task> {
    if (!this.canTransition(task.status, to)) {
      throw new InvalidTaskTransitionError(task.status, to);
    }
    const updated: Task = { ...task, status: to, updatedAt: now() };
    return this.storage.tasks.save(updated);
  }

  async startRun(task: Task, capability: Capability): Promise<TaskRun> {
    return this.storage.taskRuns.start(task, capability);
  }

  /** Canonical continuation attempt start owner; no lifecycle transition or receiver invocation. */
  async guardedStartRun(expected: GuardedTaskRunStartFacts, capability: Capability): Promise<TaskRun> {
    return this.storage.taskRuns.guardedStart(expected, capability);
  }

  async completeRun(
    run: TaskRun,
    result: { artifactIds: Id[]; providerId?: string; metadata?: Metadata; usage?: RunUsageRecord },
  ): Promise<TaskRun> {
    const finishedAt = now();
    const updated: TaskRun = {
      ...run,
      status: TaskRunStatus.SUCCEEDED,
      artifactIds: result.artifactIds,
      finishedAt,
      durationMs: TaskManager.elapsed(run.startedAt, finishedAt),
      ...(result.providerId ? { providerId: result.providerId } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    return this.storage.taskRuns.save(updated);
  }

  async failRun(
    run: TaskRun,
    error: string,
    info: { providerId?: string; metadata?: Metadata } = {},
  ): Promise<TaskRun> {
    const finishedAt = now();
    const updated: TaskRun = {
      ...run,
      status: TaskRunStatus.FAILED,
      error,
      finishedAt,
      durationMs: TaskManager.elapsed(run.startedAt, finishedAt),
      ...(info.providerId ? { providerId: info.providerId } : {}),
      ...(info.metadata ? { metadata: info.metadata } : {}),
    };
    return this.storage.taskRuns.save(updated);
  }

  private static elapsed(startedAt: string, finishedAt: string): number {
    return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  }

  /**
   * R3-A: record immutable containment binding evidence on the exact STARTED run. TaskManager remains
   * the lifecycle owner; it delegates the atomic insert-once compare-and-set to the repository. No
   * lifecycle transition and no Provider attempt occur here.
   */
  async recordContainmentBindingIfAbsent(
    exactTaskRunId: Id,
    containmentAudit: ContinuationContainmentAudit,
  ): Promise<TaskRun> {
    return this.storage.taskRuns.recordContainmentBindingIfAbsent(exactTaskRunId, containmentAudit);
  }

  /** R3-A: append optional post-attempt evidence; delegates to the repository append-once CAS. */
  async recordContainmentPostEvidenceIfAbsent(
    exactTaskRunId: Id,
    containmentAudit: ContinuationContainmentAudit,
  ): Promise<TaskRun> {
    return this.storage.taskRuns.recordContainmentPostEvidenceIfAbsent(exactTaskRunId, containmentAudit);
  }

  /**
   * R3-A current-row terminal merge. Terminalizes the exact STARTED run from the CURRENT persisted row
   * (never a stale caller snapshot), preserving durable containment evidence and merging the routing
   * audit + terminal metadata atomically. Use this instead of completeRun/failRun for continuation runs
   * that may carry containment evidence. Current post-attempt uncertainty returns STARTED (UNRESOLVED)
   * without a terminal write; callers must inspect the returned status.
   */
  async terminalizePreservingSecurityEvidence(
    exactTaskRunId: Id,
    request: {
      terminalStatus: TaskRunStatus.SUCCEEDED | TaskRunStatus.FAILED;
      artifactIds?: Id[];
      providerId?: string;
      error?: string;
      metadata?: Metadata;
    },
  ): Promise<TaskRun> {
    return this.storage.taskRuns.terminalizePreservingSecurityEvidence(exactTaskRunId, {
      terminalStatus: request.terminalStatus,
      finishedAt: now(),
      ...(request.artifactIds ? { artifactIds: request.artifactIds } : {}),
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.error ? { error: request.error } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    });
  }
}
