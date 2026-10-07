import { newId } from '../util/id';
import { now } from '../util/clock';
import { ApprovalStatus, Capability, IntentType, RiskLevel, TaskStatus } from '../domain';
import type { ApprovalRequest, Id, Session, Task } from '../domain';
import type { ApprovalFlow } from './conversation-runtime';
import type { ExecutionOutcome, ExecutionRequest } from './execution-orchestrator';
import { SESSION_WRITE_LOCK, type SessionLockHold, type SessionWriteLock } from './session-write-lock';

/** Narrow storage the flow needs — satisfied by the real `StorageProvider` (and by test fakes). */
export interface ApprovalFlowStore {
  /** `get` (optional) re-reads the live session so pointer saves are field-scoped (ADR-0113 D7). */
  readonly sessions: { save(session: Session): Promise<Session>; get?(id: Id): Promise<Session | null> };
  readonly tasks: { get(id: Id): Promise<Task | null>; save(task: Task): Promise<Task> };
  readonly approvals: { findByExecutionPlan(executionPlanId: Id): Promise<ApprovalRequest[]> };
}

/** `Task.metadata` key holding the anchored `{request, prior}` needed to resume (ADR-0032). */
const ANCHOR_KEY = 'conversationExecutionAnchor';

interface ExecutionAnchor {
  request: ExecutionRequest;
  prior: ExecutionOutcome;
}

/**
 * The production `ApprovalFlow` (ADR-0032). Stateless: it stores NOTHING of its own and writes NO
 * snapshot to `Session` — it derives/anchors using only EXISTING aggregates and the fixed
 * correlation source `Session.activeTaskId → Task.planId → approvals.findByExecutionPlan → PENDING`.
 * On halt it anchors the in-flight `{request, prior}` on the in-focus `Task` (its own `metadata`,
 * owned by the Task capability) and points `Session.activeTaskId` at it; on the next turn it reads
 * that back to reconstruct a resumable context. No new aggregate/repository/migration.
 */
export class StatelessApprovalFlow implements ApprovalFlow {
  /** Session pointer writes run under the shared session write lock (ADR-0113 D7). */
  constructor(
    private readonly store: ApprovalFlowStore,
    private readonly sessionLock: SessionWriteLock = SESSION_WRITE_LOCK,
  ) {}

  async findPending(session: Session): Promise<ApprovalRequest | null> {
    if (!session.activeTaskId) return null;
    const task = await this.store.tasks.get(session.activeTaskId);
    if (!task?.planId) return null;
    const requests = await this.store.approvals.findByExecutionPlan(task.planId);
    return requests.find((r) => r.status === ApprovalStatus.PENDING) ?? null;
  }

  async anchor(session: Session, request: ExecutionRequest, outcome: ExecutionOutcome, held?: SessionLockHold): Promise<void> {
    const planId = outcome.refs.executionPlanRef?.id;
    if (!planId) return; // nothing to correlate; skip anchoring
    const ts = now();
    const anchor: ExecutionAnchor = { request, prior: outcome };
    const task: Task = {
      id: newId(),
      title: request.goal,
      description: request.instruction,
      status: TaskStatus.WAITING_APPROVAL,
      intent: {
        type: IntentType.IMPLEMENT_CODE,
        capability: request.requiredCapabilities[0] ?? Capability.CODE_IMPLEMENTATION,
        confidence: 1,
        requiresWork: true,
        summary: request.goal,
      },
      riskLevel: RiskLevel.HIGH,
      context: session.context,
      ...(session.actorId ? { actorId: session.actorId } : {}),
      sessionId: session.id,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
      planId,
      createdAt: ts,
      updatedAt: ts,
      metadata: { [ANCHOR_KEY]: anchor },
    };
    await this.store.tasks.save(task);
    // `activeTaskId` is a legitimate Session lifecycle pointer — NOT a runtime snapshot (ADR-0032).
    await this.sessionLock.saveFields(this.store.sessions, session, { activeTaskId: task.id, lastActivityAt: ts }, held);
  }

  async reconstructResume(
    session: Session,
    approval: ApprovalRequest,
  ): Promise<{ request: ExecutionRequest; prior: ExecutionOutcome } | null> {
    if (!session.activeTaskId) return null;
    const task = await this.store.tasks.get(session.activeTaskId);
    // Referential integrity: the anchored task must belong to the plan this approval governs.
    if (!task?.planId || task.planId !== approval.executionPlanRef.id) return null;
    const anchor = task.metadata?.[ANCHOR_KEY] as ExecutionAnchor | undefined;
    if (!anchor?.request || !anchor?.prior) return null;
    return { request: anchor.request, prior: anchor.prior };
  }
}
