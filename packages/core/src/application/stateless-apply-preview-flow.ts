import { newId } from '../util/id';
import { now } from '../util/clock';
import { Capability, IntentType, RiskLevel, TaskStatus } from '../domain';
import type { Id, Session, Task } from '../domain';
import type { ApplyPreviewAnchor, ApplyPreviewAnchorIdentity, ApplyPreviewFlow } from './conversation-runtime';

/** Narrow storage the flow needs — satisfied by the real `StorageProvider` (and by test fakes). */
export interface ApplyPreviewFlowStore {
  /** `get` re-reads the live session for {@link StatelessApplyPreviewFlow.clearIfCurrent}; without it that method
   *  fails closed (clears nothing). */
  readonly sessions: { save(session: Session): Promise<Session>; get?(id: Id): Promise<Session | null> };
  readonly tasks: { get(id: Id): Promise<Task | null>; save(task: Task): Promise<Task> };
}

/** `Task.metadata` key holding the anchored `ApplyPreviewAnchor` (Sprint 2s, ADR-0040). */
const ANCHOR_KEY = 'conversationApplyPreviewAnchor';
const ANCHOR_DISCRIMINATOR = 'code-preview-apply' as const;

/**
 * The production `ApplyPreviewFlow` (Sprint 2s, ADR-0040). Mirrors `StatelessScopeClarificationFlow`
 * exactly: the Task it creates is an INERT CONVERSATION ANCHOR TASK — never an execution task, and its
 * `planId` is always `undefined` so `StatelessApprovalFlow.findPending` (which correlates purely via
 * `Task.planId → approvals.findByExecutionPlan`) can never mistake the second (apply) ApprovalRequest
 * for the first (preview) one it is actually tracking.
 */
export class StatelessApplyPreviewFlow implements ApplyPreviewFlow {
  constructor(private readonly store: ApplyPreviewFlowStore) {}

  /**
   * The anchor Task for this session, ONLY if it is genuinely an apply-preview anchor — never an
   * approval anchor (`planId` present) and never a plan-less Task lacking our discriminator. Both
   * `findAnchor` and `clear` route through this so "is this our anchor?" is answered exactly once.
   */
  private async anchorTask(session: Session): Promise<{ task: Task; anchor: ApplyPreviewAnchor } | null> {
    if (!session.activeTaskId) return null;
    const task = await this.store.tasks.get(session.activeTaskId);
    if (!task || task.planId) return null; // an approval-anchor Task always has planId; ours never does
    const anchor = task.metadata?.[ANCHOR_KEY] as ApplyPreviewAnchor | undefined;
    if (anchor?.kind !== ANCHOR_DISCRIMINATOR) return null; // explicit discriminator, not just !planId
    return { task, anchor };
  }

  async findAnchor(session: Session): Promise<ApplyPreviewAnchor | null> {
    const found = await this.anchorTask(session);
    if (!found) return null;
    // Active project changed since anchor time — none of the three states remain valid against a
    // workspace validated for a different project. Safe to auto-clear.
    if (found.anchor.projectId !== session.activeProjectId) {
      await this.clear(session);
      return null;
    }
    return found.anchor;
  }

  async anchor(session: Session, anchor: ApplyPreviewAnchor): Promise<void> {
    const ts = now();
    const task: Task = {
      id: newId(),
      title: 'code-change apply approval',
      description: anchor.instruction,
      // An inert conversation anchor, never advanced through the real work pipeline (mirrors
      // ScopeClarificationFlow's Task) — WAITING_APPROVAL only while a real ApprovalRequest is PENDING:
      // AWAITING_APPROVAL (apply, 2s) and COMMIT_APPROVAL_PENDING (commit, 2x). The task stays plan-less,
      // so StatelessApprovalFlow's plan-scoped findPending never returns these approvals (they are handled
      // via the anchor-status interception in ConversationRuntime).
      status:
        anchor.status === 'AWAITING_APPROVAL' || anchor.status === 'COMMIT_APPROVAL_PENDING'
          ? TaskStatus.WAITING_APPROVAL
          : TaskStatus.PENDING,
      intent: {
        type: IntentType.IMPLEMENT_CODE,
        capability: Capability.CODE_IMPLEMENTATION,
        confidence: 1,
        requiresWork: true,
        summary: anchor.instruction,
      },
      riskLevel: RiskLevel.HIGH,
      context: session.context,
      ...(session.actorId ? { actorId: session.actorId } : {}),
      sessionId: session.id,
      ...(anchor.projectId ? { projectId: anchor.projectId } : {}),
      createdAt: ts,
      updatedAt: ts,
      metadata: { [ANCHOR_KEY]: anchor },
    };
    await this.store.tasks.save(task);
    await this.store.sessions.save({ ...session, activeTaskId: task.id, lastActivityAt: ts });
  }

  /**
   * Conditional clear (QA-V2-CL-03): re-reads the LIVE session (the caller's copy may be stale — another turn may have
   * re-anchored ELIGIBLE → AWAITING_APPROVAL → APPROVED meanwhile, each on a fresh anchor Task) and clears only while
   * its current anchor is our discriminated anchor for the same code generation, in the same status and the same
   * project. The save is built from the live session, never the stale one. Returns whether it cleared.
   */
  async clearIfCurrent(session: Session, expected: ApplyPreviewAnchorIdentity): Promise<boolean> {
    if (!this.store.sessions.get) return false;
    const live = await this.store.sessions.get(session.id);
    if (!live) return false;
    const found = await this.anchorTask(live);
    if (!found) return false;
    const { anchor } = found;
    if (anchor.status !== expected.status) return false;
    if (anchor.codeGenerationRef?.id !== expected.codeGenerationId) return false;
    if (anchor.projectId !== live.activeProjectId) return false;
    await this.store.sessions.save({ ...live, activeTaskId: undefined, lastActivityAt: now() });
    return true;
  }

  async clear(session: Session): Promise<void> {
    // Never clear activeTaskId unless it still points at OUR anchor — an approval anchor (or
    // anything else) sharing the same pointer slot must be left untouched.
    const found = await this.anchorTask(session);
    if (!found) return;
    await this.store.sessions.save({ ...session, activeTaskId: undefined, lastActivityAt: now() });
  }
}
