import { newId } from '../util/id';
import { now } from '../util/clock';
import { Capability, IntentType, RiskLevel, TaskStatus } from '../domain';
import type { Id, Session, Task } from '../domain';
import type { PendingScopeClarification, ScopeClarificationFlow } from './conversation-runtime';
import { SESSION_WRITE_LOCK, type SessionLockHold, type SessionWriteLock } from './session-write-lock';

/** Narrow storage the flow needs — satisfied by the real `StorageProvider` (and by test fakes). */
export interface ScopeClarificationFlowStore {
  /** `get` (optional) re-reads the live session so pointer saves are field-scoped (ADR-0113 D7). */
  readonly sessions: { save(session: Session): Promise<Session>; get?(id: Id): Promise<Session | null> };
  readonly tasks: { get(id: Id): Promise<Task | null>; save(task: Task): Promise<Task> };
}

/** `Task.metadata` key holding the anchored `PendingScopeClarification` (ADR-0037). */
const ANCHOR_KEY = 'conversationScopeClarificationAnchor';
const ANCHOR_DISCRIMINATOR = 'code-scope-clarification' as const;

/**
 * The production `ScopeClarificationFlow` (Sprint 2p, ADR-0037). The Task it creates is an INERT
 * CONVERSATION ANCHOR TASK — never an execution task. It must never enter Planning,
 * ExecutionOrchestrator, Patch, WorkspaceWrite, or CommandExecution by itself; it exists solely to
 * hold `PendingScopeClarification` facts across exactly one follow-up turn, and is never
 * transitioned past `TaskStatus.PENDING`.
 */
export class StatelessScopeClarificationFlow implements ScopeClarificationFlow {
  /** Session pointer writes run under the shared session write lock (ADR-0113 D7). */
  constructor(
    private readonly store: ScopeClarificationFlowStore,
    private readonly sessionLock: SessionWriteLock = SESSION_WRITE_LOCK,
  ) {}

  /**
   * The anchor Task for this session, ONLY if it is genuinely a scope-clarification anchor — never
   * an approval anchor (`planId` present) and never a plan-less Task lacking our discriminator. Both
   * `findPending` and `clear` route through this so "is this our anchor?" is answered exactly once.
   */
  private async anchorTask(
    session: Session,
  ): Promise<{ task: Task; pending: PendingScopeClarification } | null> {
    if (!session.activeTaskId) return null;
    const task = await this.store.tasks.get(session.activeTaskId);
    if (!task || task.planId) return null; // an approval-anchor Task always has planId; ours never does
    const pending = task.metadata?.[ANCHOR_KEY] as PendingScopeClarification | undefined;
    if (pending?.kind !== ANCHOR_DISCRIMINATOR) return null; // explicit discriminator, not just !planId
    return { task, pending };
  }

  async findPending(session: Session, held?: SessionLockHold): Promise<PendingScopeClarification | null> {
    const found = await this.anchorTask(session);
    if (!found) return null;
    // Q5: active project changed since anchor time — the anchor no longer applies to the workspace
    // it was validated against. Safe to auto-clear: anchorTask() already proved this IS our anchor.
    if (found.pending.projectId !== session.activeProjectId) {
      await this.clear(session, held);
      return null;
    }
    return found.pending;
  }

  async anchor(session: Session, pending: PendingScopeClarification, held?: SessionLockHold): Promise<void> {
    const ts = now();
    const task: Task = {
      id: newId(),
      title: 'code-change scope clarification',
      description: pending.summary,
      status: TaskStatus.PENDING, // never advanced — this Task never enters the work-turn pipeline
      intent: {
        type: IntentType.IMPLEMENT_CODE,
        capability: Capability.CODE_IMPLEMENTATION,
        confidence: 1,
        requiresWork: true,
        summary: pending.summary,
        ...(pending.rawKind ? { raw: { kind: pending.rawKind } } : {}),
      },
      riskLevel: RiskLevel.HIGH,
      context: session.context,
      ...(session.actorId ? { actorId: session.actorId } : {}),
      sessionId: session.id,
      ...(pending.projectId ? { projectId: pending.projectId } : {}),
      createdAt: ts,
      updatedAt: ts,
      metadata: { [ANCHOR_KEY]: pending },
    };
    await this.store.tasks.save(task);
    await this.sessionLock.saveFields(this.store.sessions, session, { activeTaskId: task.id, lastActivityAt: ts }, held);
  }

  async clear(session: Session, held?: SessionLockHold): Promise<void> {
    // Never clear activeTaskId unless it still points at OUR anchor — an approval anchor (or
    // anything else) sharing the same pointer slot must be left untouched.
    const found = await this.anchorTask(session);
    if (!found) return;
    // Only while the LIVE pointer is still this anchor (ADR-0113 D7): a stale copy never releases a newer pointer.
    await this.sessionLock.releasePointer(this.store.sessions, session, found.task.id, { lastActivityAt: now() }, held);
  }
}
