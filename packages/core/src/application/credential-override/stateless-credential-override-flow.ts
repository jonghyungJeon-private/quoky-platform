import { newId } from '../../util/id';
import { now } from '../../util/clock';
import { Capability, IntentType, RiskLevel, SessionStatus, TaskStatus } from '../../domain';
import type {
  ApprovalRequest,
  ExecutionPlanRef,
  Id,
  IsoTimestamp,
  Session,
  Task,
  WorkspaceRef,
} from '../../domain';
import type { CredentialOverrideGrant } from '../code-generation-context';
import { classifyCredentialFileContent } from '../credential-guard';
import { normalizeRelativePath } from '../target-scope';
import {
  CREDENTIAL_OVERRIDE_ANCHOR_KIND,
  MAX_CREDENTIAL_OVERRIDE_GRANTS,
  type CredentialOverrideAnchor,
  type CredentialOverrideAnchorStatus,
  type CredentialOverrideApprovalRequester,
  type CredentialOverrideDispatchAuthorization,
  type CredentialOverrideDispatchInput,
  type CredentialOverrideDispatchResult,
  type CredentialOverrideFlow,
  type CredentialOverrideGrantRecord,
  type CredentialOverrideGrantResult,
  type CredentialOverrideInvalidationReason,
  type CredentialOverrideInvalidationResult,
  type CredentialOverrideLookup,
  type CredentialOverrideRequestInput,
  type CredentialOverrideRequestResult,
  assessCredentialOverrideAnchor,
  credentialOverrideApprovalReason,
  credentialOverrideContentSha256,
  invalidateCredentialOverrideAnchor,
} from './credential-override';

/** Narrow storage the flow needs — satisfied by the real `StorageProvider` (and by test fakes). */
export interface CredentialOverrideFlowStore {
  readonly sessions: { get(id: Id): Promise<Session | null>; save(session: Session): Promise<Session> };
  readonly tasks: { get(id: Id): Promise<Task | null>; save(task: Task): Promise<Task> };
  /** Read-only: ApprovalRequests stay Approval-owned (`ApprovalManager` is their only mutator). */
  readonly approvals: { get(id: Id): Promise<ApprovalRequest | null> };
}

export interface StatelessCredentialOverrideFlowOptions {
  /** The shared clock for the ADR-0093 TTL re-checks (ADR-0095 §5). Omitted → `util/clock` `now`. */
  readonly clock?: () => IsoTimestamp;
}

/** `Task.metadata` key holding the anchored {@link CredentialOverrideAnchor} (ADR-0097 D5). */
const ANCHOR_KEY = 'conversationCredentialOverrideAnchor';
const SYSTEM = 'system';

const TASK_STATUS_OF: Record<CredentialOverrideAnchorStatus, TaskStatus> = {
  PENDING: TaskStatus.WAITING_APPROVAL, // a real CRITICAL ApprovalRequest is PENDING
  GRANTED: TaskStatus.PENDING, // every grant granted; waits for the single dispatch
  CONSUMED: TaskStatus.COMPLETED,
  INVALIDATED: TaskStatus.CANCELED,
};

const sameWorkspace = (a: WorkspaceRef | undefined, b: WorkspaceRef | undefined): boolean =>
  !!a && !!b && a.id === b.id && a.rootPath === b.rootPath && a.kind === b.kind;

/**
 * The production `CredentialOverrideFlow` (ADR-0097 D4/D5). Mirrors `StatelessApplyPreviewFlow`: the Task it writes
 * is an INERT CONVERSATION ANCHOR TASK whose `planId` is ALWAYS `undefined`, so `StatelessApprovalFlow.findPending`
 * (which correlates purely via `Task.planId → approvals.findByExecutionPlan`) can never mistake the CRITICAL
 * override request — which shares the original request's `executionPlanRef` — for the plan approval. It never
 * enters Planning, the orchestrator, Patch, WorkspaceWrite or CommandExecution.
 *
 * One anchor Task per original request, updated in place (same Task id) so the row is the audit record: the
 * per-grant binding and the final status `CONSUMED` or `INVALIDATED{reason}`. Nothing in memory is
 * authoritative. The only in-memory state (Personal is a single process, ADR-0091) is
 * - the per-anchor single-flight dispatch claim, which only ever REFUSES a second dispatch, and
 * - the per-anchor serialization queue, which only ever ORDERS reads-and-writes: every mutator (and the whole
 *   revalidate-and-consume of a dispatch, from its first read through the consume save) runs alone on its anchor,
 *   so an invalidation can never be overwritten by a dispatch that read the anchor before it.
 *
 * Session writes are POINTER-ONLY on a freshly re-read canonical session: this flow never saves a caller's turn copy
 * of the Session, so it can never revert a project switch or a reset close that landed while it awaited. The
 * dispatch path re-loads the canonical session after its content reads and again after the consume save, and
 * requires it to be ACTIVE and still bound to the grant (owner, session, project — the active workspace is
 * resolved from the active project). Remaining assumption (documented, not enforceable here): the storage port
 * has no compare-and-set, so a session writer OUTSIDE this flow (e.g. `SessionManager.close`/`setActiveProject`
 * from another process, or one that bypasses `invalidate`) can still interleave with the few-microsecond
 * read-to-save window of a pointer write, and between the last session re-load and the provider call. Personal is a
 * single process (ADR-0091); the runtime routes reset/project changes through `invalidate` first (serialized with
 * the consume), so only a bypassing writer is left to the re-load checks.
 *
 * Holds the LIVE storage seam (ADR-0062): repositories are resolved at call time, never in the constructor.
 */
export class StatelessCredentialOverrideFlow implements CredentialOverrideFlow {
  private readonly clock: () => IsoTimestamp;
  /** Anchor Task ids whose consume/dispatch is in flight in this process, each with its dispatch's claim token. */
  private readonly claims = new Map<Id, object>();
  /** Per-anchor (keyed by the session pointer) tail of the serialized read-and-write queue. */
  private readonly queues = new Map<Id, Promise<void>>();

  constructor(
    private readonly store: CredentialOverrideFlowStore,
    options: StatelessCredentialOverrideFlowOptions = {},
  ) {
    this.clock = options.clock ?? now;
  }

  /**
   * Run `work` alone on the anchor `key` names: it starts only after every earlier serialized call on the same key
   * has settled (fulfilled or rejected). Never refuses, never reorders; the entry is dropped once the queue drains.
   */
  private async serialized<R>(key: Id, work: () => Promise<R>): Promise<R> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }

  /**
   * The anchor Task for this session, ONLY if it is genuinely a credential-override anchor — never an approval
   * anchor (`planId` present) and never a plan-less Task lacking our discriminator. Every method routes through
   * this so "is this our anchor?" is answered exactly once.
   */
  private async anchorTask(session: Session): Promise<{ task: Task; anchor: CredentialOverrideAnchor } | null> {
    if (!session.activeTaskId) return null;
    const task = await this.store.tasks.get(session.activeTaskId);
    if (!task || task.planId) return null; // an approval-anchor Task always has planId; ours never does
    const anchor = task.metadata?.[ANCHOR_KEY] as CredentialOverrideAnchor | undefined;
    if (anchor?.kind !== CREDENTIAL_OVERRIDE_ANCHOR_KIND) return null; // explicit discriminator, not just !planId
    return { task, anchor };
  }

  private async approvalsOf(anchor: CredentialOverrideAnchor): Promise<Map<Id, ApprovalRequest | null>> {
    const map = new Map<Id, ApprovalRequest | null>();
    for (const grant of Array.isArray(anchor.grants) ? anchor.grants : []) {
      if (grant?.approvalRequestId && !map.has(grant.approvalRequestId)) {
        map.set(grant.approvalRequestId, await this.store.approvals.get(grant.approvalRequestId));
      }
    }
    return map;
  }

  /** Persist the anchor in place on its own Task row (never a new Task, never a planId). */
  private async saveAnchor(task: Task, anchor: CredentialOverrideAnchor): Promise<Task> {
    const saved: Task = {
      ...task,
      status: TASK_STATUS_OF[anchor.status],
      updatedAt: anchor.updatedAt,
      metadata: { ...task.metadata, [ANCHOR_KEY]: anchor },
    };
    delete saved.planId;
    return this.store.tasks.save(saved);
  }

  /**
   * Release the canonical session's `activeTaskId` iff it still points at `taskId` (our anchor). The session is
   * RE-READ and only the pointer field this flow owns is cleared on that fresh copy — a caller's (possibly stale)
   * Session object is never written back, so a project switch or reset close that landed meanwhile is kept.
   */
  private async releasePointer(sessionId: Id, taskId: Id): Promise<void> {
    const live = await this.store.sessions.get(sessionId);
    if (live?.activeTaskId !== taskId) return;
    await this.store.sessions.save({ ...live, activeTaskId: undefined });
  }

  /**
   * Invalidate `found` (unless already terminal) and release the pointer. Callers hold the anchor's serialization,
   * so `found` is the current row: a dispatch can no longer overwrite this with `CONSUMED`.
   */
  private async invalidateFound(
    session: Session,
    found: { task: Task; anchor: CredentialOverrideAnchor },
    reason: CredentialOverrideInvalidationReason,
    invalidatedBy: string,
  ): Promise<CredentialOverrideInvalidationResult> {
    const at = this.clock();
    const terminal = found.anchor.status === 'INVALIDATED' || found.anchor.status === 'CONSUMED';
    const anchor = terminal ? found.anchor : invalidateCredentialOverrideAnchor(found.anchor, reason, invalidatedBy, at);
    if (!terminal) await this.saveAnchor(found.task, anchor);
    await this.releasePointer(session.id, found.task.id);
    return anchor.status === 'CONSUMED' ? { state: 'consumed', anchor } : { state: 'invalidated', anchor };
  }

  async findPending(session: Session): Promise<CredentialOverrideLookup | null> {
    if (!session.activeTaskId) return null;
    return this.serialized(session.activeTaskId, () => this.lookup(session));
  }

  /** `findPending` body; callers hold the anchor's serialization. */
  private async lookup(session: Session): Promise<CredentialOverrideLookup | null> {
    const found = await this.anchorTask(session);
    if (!found) return null;
    const { task, anchor } = found;
    if (this.claims.has(task.id)) return { state: 'consumed', anchor };
    const approvals = await this.approvalsOf(anchor);
    const assessment = assessCredentialOverrideAnchor(anchor, approvals, this.clock());
    if (assessment.kind === 'consumed') return { state: 'consumed', anchor };
    if (assessment.kind === 'invalid') {
      const { anchor: invalidated } = await this.invalidateFound(session, found, assessment.reason, SYSTEM);
      return {
        state: 'invalidated',
        anchor: invalidated,
        reason: assessment.reason,
        pendingApproval: assessment.pendingApproval,
      };
    }
    // The set is otherwise valid; a project/owner/session drift since anchor time still voids it.
    const drift = this.sessionDrift(session, anchor);
    if (drift) {
      const pendingApproval = assessment.kind === 'awaiting-decision' ? assessment.approval : null;
      const { anchor: invalidated } = await this.invalidateFound(session, found, drift, SYSTEM);
      return { state: 'invalidated', anchor: invalidated, reason: drift, pendingApproval };
    }
    if (assessment.kind === 'awaiting-decision') {
      return {
        state: 'awaiting-decision', anchor, grant: assessment.grant, approval: assessment.approval,
        remainingMs: assessment.remainingMs,
      };
    }
    return { state: 'ready', anchor, remainingMs: assessment.remainingMs };
  }

  /** The invalidation a session no longer matching the anchor's binding implies, if any. */
  private sessionDrift(
    session: Session,
    anchor: CredentialOverrideAnchor,
  ): CredentialOverrideInvalidationReason | null {
    if (anchor.projectId !== session.activeProjectId) return 'project-changed';
    if (anchor.sessionId !== session.id || anchor.ownerActorId !== session.actorId) return 'superseded';
    return null;
  }

  /**
   * Why the CANONICAL session (just re-loaded from storage) no longer admits this anchor's dispatch, if it does not:
   * missing → `inconsistent`; not ACTIVE (closed by a reset) → `reset`; pointer no longer `pointer` → `superseded`
   * (`pointer` null skips this, once the flow has released the pointer itself); then project/owner/session drift.
   */
  private liveSessionFailure(
    live: Session | null,
    anchor: CredentialOverrideAnchor,
    pointer: Id | null,
  ): CredentialOverrideInvalidationReason | null {
    if (!live) return 'inconsistent';
    if (live.status !== SessionStatus.ACTIVE) return 'reset';
    if (pointer !== null && live.activeTaskId !== pointer) return 'superseded';
    return this.sessionDrift(live, anchor);
  }

  async requestOverride(
    session: Session,
    input: CredentialOverrideRequestInput,
    approvals: CredentialOverrideApprovalRequester,
  ): Promise<CredentialOverrideRequestResult> {
    const { request, outcome, ownerActorId, refusal } = input;
    const planRef = outcome.refs.executionPlanRef;
    const workspaceRef = request.workspaceRef;
    const pointer = session.activeTaskId;
    if (!planRef?.id || !workspaceRef || !ownerActorId || ownerActorId !== session.actorId || !pointer) {
      return { ok: false, reason: 'unbound' };
    }
    if (
      !refusal.targetPath || !/^[0-9a-f]{64}$/.test(refusal.contentSha256) ||
      !Number.isInteger(refusal.line) || refusal.line < 1 ||
      !Number.isInteger(refusal.targetIndex) || refusal.targetIndex < 0
    ) {
      return { ok: false, reason: 'invalid-refusal' };
    }
    const bound = { pointer, planRef, workspaceRef };
    return this.serialized(pointer, () => this.raise(session, bound, input, approvals));
  }

  /** `requestOverride` body; callers hold the serialization of the session pointer `bound.pointer`. */
  private async raise(
    session: Session,
    bound: { pointer: Id; planRef: ExecutionPlanRef; workspaceRef: WorkspaceRef },
    input: CredentialOverrideRequestInput,
    approvals: CredentialOverrideApprovalRequester,
  ): Promise<CredentialOverrideRequestResult> {
    const { request, outcome, ownerActorId, refusal } = input;
    const { pointer, planRef, workspaceRef } = bound;

    // Extend this request's own anchor (the next refused target of the same set), or start a new one bound to
    // the CODE_IMPLEMENTATION request the session pointer holds right now (its approval-anchor Task).
    const own = await this.anchorTask(session);
    let base: { task: Task; anchor: CredentialOverrideAnchor } | null = null;
    let requestTaskId: Id;
    if (own) {
      // Only a fully GRANTED set of THIS request may take another target; anything else is not this chain.
      const lookup = await this.lookup(session);
      const sameRequest =
        own.anchor.executionPlanId === planRef.id && sameWorkspace(own.anchor.workspaceRef, workspaceRef);
      if (lookup?.state !== 'ready' || !sameRequest) {
        let pendingApproval: ApprovalRequest | null = null;
        if (lookup?.state === 'invalidated') pendingApproval = lookup.pendingApproval;
        if (lookup?.state === 'awaiting-decision' || lookup?.state === 'ready') {
          pendingApproval = lookup.state === 'awaiting-decision' ? lookup.approval : null;
          await this.invalidateFound(session, own, 'superseded', SYSTEM);
        }
        return { ok: false, reason: 'chain-invalid', pendingApproval };
      }
      if (own.anchor.grants.length >= MAX_CREDENTIAL_OVERRIDE_GRANTS) return { ok: false, reason: 'too-many-targets' };
      const norm = normalizeRelativePath(refusal.targetPath);
      if (own.anchor.grants.some((g) => normalizeRelativePath(g.path) === norm)) {
        return { ok: false, reason: 'duplicate-target' };
      }
      base = { task: own.task, anchor: lookup.anchor };
      requestTaskId = own.anchor.requestTaskId;
    } else {
      const requestTask = await this.store.tasks.get(pointer);
      if (!requestTask || requestTask.planId !== planRef.id) return { ok: false, reason: 'unbound' };
      requestTaskId = requestTask.id;
    }

    const approval = await approvals.requestForRisk({
      executionPlanRef: planRef,
      riskLevel: RiskLevel.CRITICAL, // secret access (ARCHITECTURE §10); requestForRisk never auto-approves
      reason: credentialOverrideApprovalReason(refusal),
      requestedBy: ownerActorId,
    });
    const at = this.clock();
    const binding = {
      ownerActorId,
      sessionId: session.id,
      workspaceRef,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
      requestTaskId,
      executionPlanId: planRef.id,
    };
    const grant: CredentialOverrideGrantRecord = {
      ...binding,
      approvalRequestId: approval.id,
      targetIndex: refusal.targetIndex,
      path: refusal.targetPath,
      contentSha256: refusal.contentSha256,
      detector: 'credential-assignment',
      line: refusal.line,
      state: 'PENDING',
      createdAt: at,
    };

    if (base) {
      const anchor: CredentialOverrideAnchor = {
        ...base.anchor, status: 'PENDING', grants: [...base.anchor.grants, grant], updatedAt: at,
      };
      try {
        await this.saveAnchor(base.task, anchor);
      } catch {
        // The GRANTED set is untouched; the just-created request is handed back for the caller to close.
        return { ok: false, reason: 'anchor-failed', pendingApproval: approval };
      }
      return { ok: true, anchor, approval };
    }

    const anchor: CredentialOverrideAnchor = {
      kind: CREDENTIAL_OVERRIDE_ANCHOR_KIND,
      status: 'PENDING',
      ...binding,
      request,
      outcome,
      newFileTargets: [...(request.newFileTargets ?? [])],
      grants: [grant],
      createdAt: at,
      updatedAt: at,
    };
    const task: Task = {
      id: newId(),
      title: 'code-change credential override',
      description: request.goal,
      status: TASK_STATUS_OF.PENDING,
      intent: {
        type: IntentType.IMPLEMENT_CODE,
        capability: Capability.CODE_IMPLEMENTATION,
        confidence: 1,
        requiresWork: true,
        summary: request.goal,
      },
      riskLevel: RiskLevel.CRITICAL,
      context: session.context,
      actorId: ownerActorId,
      sessionId: session.id,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
      workspaceRefId: workspaceRef.id,
      createdAt: at,
      updatedAt: at,
      metadata: { [ANCHOR_KEY]: anchor },
    };
    // The CRITICAL request already exists and shares the plan ref: if the anchor Task or the pointer move fails,
    // the pointer still holds the plan-approval Task, so the caller must close the request (never leave it PENDING).
    try {
      await this.store.tasks.save(task);
    } catch {
      return { ok: false, reason: 'anchor-failed', pendingApproval: approval };
    }
    try {
      // Pointer-only write onto the re-read canonical session (never the turn's copy), and only if the pointer still
      // holds the request this anchor is bound to.
      const live = await this.store.sessions.get(session.id);
      if (!live || live.activeTaskId !== pointer) throw new Error('session pointer moved');
      await this.store.sessions.save({ ...live, activeTaskId: task.id });
    } catch {
      // Best effort: the unreachable row must not stay a live PENDING audit record.
      await this.saveAnchor(task, invalidateCredentialOverrideAnchor(anchor, 'inconsistent', SYSTEM, at)).catch(
        () => undefined,
      );
      return { ok: false, reason: 'anchor-failed', pendingApproval: approval };
    }
    return { ok: true, anchor, approval };
  }

  async recordGrant(session: Session, approvalId: Id): Promise<CredentialOverrideGrantResult> {
    if (!session.activeTaskId) return { ok: false, reason: 'not-found' };
    return this.serialized(session.activeTaskId, () => this.grant(session, approvalId));
  }

  /** `recordGrant` body; callers hold the anchor's serialization. */
  private async grant(session: Session, approvalId: Id): Promise<CredentialOverrideGrantResult> {
    const found = await this.anchorTask(session);
    if (!found) return { ok: false, reason: 'not-found' };
    const { anchor } = found;
    const index = Array.isArray(anchor.grants)
      ? anchor.grants.findIndex((g) => g?.approvalRequestId === approvalId && g.state === 'PENDING')
      : -1;
    if (anchor.status !== 'PENDING' || index < 0) return { ok: false, reason: 'not-pending' };
    // Never trust the caller's copy: re-read the decision, then judge the WHOLE set as if this grant were granted.
    const approval = await this.store.approvals.get(approvalId);
    const at = this.clock();
    // The PENDING grant is always the newest (well-formedness), so granting it grants the whole set. An
    // undecided request leaves the grant PENDING under a GRANTED anchor, which the assessment rejects.
    const tentative: CredentialOverrideAnchor = {
      ...anchor,
      status: 'GRANTED',
      updatedAt: at,
      grants: anchor.grants.map((g, i) =>
        i === index && approval?.decidedBy
          ? { ...g, state: 'GRANTED' as const, grantedAt: approval.decidedAt ?? at, grantedBy: approval.decidedBy }
          : g,
      ),
    };
    const approvals = await this.approvalsOf(tentative);
    const assessment = assessCredentialOverrideAnchor(tentative, approvals, this.clock());
    const drift = this.sessionDrift(session, anchor);
    if (assessment.kind !== 'ready' || drift) {
      const reason = drift ?? (assessment.kind === 'invalid' ? assessment.reason : 'inconsistent');
      const pendingApproval = assessment.kind === 'invalid' ? assessment.pendingApproval : null;
      await this.invalidateFound(session, found, reason, SYSTEM);
      return { ok: false, reason, pendingApproval };
    }
    await this.saveAnchor(found.task, tentative);
    return { ok: true, anchor: tentative };
  }

  async consumeAndDispatch<T>(
    session: Session,
    input: CredentialOverrideDispatchInput,
    dispatch: (
      grants: readonly CredentialOverrideGrant[],
      authorization: CredentialOverrideDispatchAuthorization,
    ) => Promise<T>,
  ): Promise<CredentialOverrideDispatchResult<T>> {
    const claimId = session.activeTaskId;
    if (!claimId) return { ok: false, reason: 'not-found' };
    // Claimed synchronously, before any await: a concurrent turn on the same anchor is refused, never queued.
    if (this.claims.has(claimId)) return { ok: false, reason: 'already-used' };
    const token = {};
    this.claims.set(claimId, token);
    try {
      // Revalidate and consume under the anchor's serialization (first read through the post-consume session
      // re-load), so no reset/denial/supersession routed through this flow can land between them; the provider call
      // itself runs outside it.
      const consumed = await this.serialized(claimId, () => this.consume(session, claimId, input));
      if (!consumed.ok) return consumed;
      const authorization = this.dispatchAuthorization(session.id, claimId, token, consumed);
      // ADR-0095 §5: the LAST flow-side check runs synchronously with the injected clock, after every persistence
      // await (consume save, pointer release, session re-load) and immediately before `dispatch`. Past the TTL (or
      // with the last canonical load no longer admitting the set) nothing is sent; the set stays CONSUMED (one-time,
      // never replayable) and the caller replies nothing-sent. `dispatch` repeats `recheck()` right before the
      // provider call itself.
      const denied = authorization.recheck();
      if (denied) return { ok: false, reason: denied };
      return { ok: true, value: await dispatch(consumed.grants, authorization) };
    } finally {
      this.claims.delete(claimId);
    }
  }

  /** The {@link CredentialOverrideDispatchAuthorization} of one consumed dispatch (see the interface for semantics). */
  private dispatchAuthorization(
    sessionId: Id,
    claimId: Id,
    token: object,
    consumed: {
      readonly consumed: CredentialOverrideAnchor;
      readonly granted: CredentialOverrideAnchor;
      readonly approvals: ReadonlyMap<Id, ApprovalRequest | null>;
      readonly session: Session;
    },
  ): CredentialOverrideDispatchAuthorization {
    return {
      anchorTaskId: claimId,
      recheck: () => {
        // Still THIS dispatch's claim on a set THIS dispatch consumed.
        if (this.claims.get(claimId) !== token || consumed.consumed.status !== 'CONSUMED') return 'inconsistent';
        const expiry = assessCredentialOverrideAnchor(consumed.granted, consumed.approvals, this.clock());
        if (expiry.kind !== 'ready') return expiry.kind === 'invalid' ? expiry.reason : 'inconsistent';
        // Per the last canonical load (pointer already released by the consume, so not checked).
        return this.liveSessionFailure(consumed.session, consumed.granted, null);
      },
      reloadSession: async () => {
        const live = await this.store.sessions.get(sessionId).catch(() => null);
        const failure = this.liveSessionFailure(live, consumed.granted, null);
        if (failure || !live) return { ok: false, reason: failure ?? 'inconsistent' };
        // The consume released the pointer (best effort): anything else on it now is a newer request.
        if (live.activeTaskId !== undefined && live.activeTaskId !== claimId) return { ok: false, reason: 'superseded' };
        return { ok: true, session: live };
      },
    };
  }

  /** Revalidate every grant and consume the whole set in ONE save; callers hold the anchor's serialization. */
  private async consume(
    session: Session,
    claimId: Id,
    input: CredentialOverrideDispatchInput,
  ): Promise<
    | {
        readonly ok: true;
        readonly grants: CredentialOverrideGrant[];
        /** The GRANTED set as revalidated (pre-consume) and its requests, for the final pre-dispatch expiry check. */
        readonly granted: CredentialOverrideAnchor;
        readonly approvals: ReadonlyMap<Id, ApprovalRequest | null>;
        /** The set exactly as this dispatch saved it `CONSUMED`. */
        readonly consumed: CredentialOverrideAnchor;
        /** The last canonical session load (after the pointer release), for the synchronous pre-dispatch re-check. */
        readonly session: Session;
      }
    | Extract<CredentialOverrideDispatchResult<never>, { ok: false }>
  > {
    type Failure = Extract<CredentialOverrideDispatchResult<never>, { ok: false }>;
    const found = await this.anchorTask(session);
    if (!found) return { ok: false, reason: 'not-found' };
    const { task, anchor } = found;
    const approvals = await this.approvalsOf(anchor);
    const assessment = assessCredentialOverrideAnchor(anchor, approvals, this.clock());
    if (assessment.kind === 'consumed') return { ok: false, reason: 'already-used' };
    if (assessment.kind === 'awaiting-decision') return { ok: false, reason: 'not-granted' };
    const fail = async (reason: CredentialOverrideInvalidationReason): Promise<Failure> => {
      const result = await this.invalidateFound(session, found, reason, SYSTEM);
      return result.state === 'consumed' ? { ok: false, reason: 'already-used' } : { ok: false, reason };
    };
    if (assessment.kind === 'invalid') return fail(assessment.reason);

    // Binding: actor, session, workspace/project and request id equal the current turn.
    const drift = this.sessionDrift(session, anchor);
    if (drift) return fail(drift);
    if (input.actorId !== anchor.ownerActorId) return fail('superseded');
    if (input.executionPlanId !== anchor.executionPlanId) return fail('superseded');
    if (input.projectId !== anchor.projectId) return fail('project-changed');
    if (!sameWorkspace(input.workspaceRef, anchor.workspaceRef)) return fail('project-changed');

    // Content: re-read every granted target; hash and classification must equal the grant.
    for (const grant of anchor.grants) {
      let content: string;
      try {
        content = await input.reader.read(anchor.workspaceRef, grant.path);
      } catch {
        return fail('changed');
      }
      const finding = classifyCredentialFileContent(content);
      if (finding.kind !== 'credential-assignment' || finding.line !== grant.line) return fail('changed');
      if (credentialOverrideContentSha256(content) !== grant.contentSha256) return fail('changed');
    }

    // Defense in depth against writers outside this flow's serialization (e.g. a runtime reset that moves the
    // session pointer itself): the row must be exactly the one revalidated, and the pointer must still hold it.
    const latestTask = await this.store.tasks.get(task.id);
    const latest = latestTask?.metadata?.[ANCHOR_KEY] as CredentialOverrideAnchor | undefined;
    if (latest?.status === 'CONSUMED') return { ok: false, reason: 'already-used' };
    if (!latestTask || latest?.status !== 'GRANTED' || latestTask.updatedAt !== task.updatedAt) {
      const reason = latest?.status === 'INVALIDATED' ? latest.invalidationReason : undefined;
      return { ok: false, reason: reason ?? 'inconsistent' }; // never overwrite a row we did not revalidate
    }
    // The CANONICAL session, re-loaded after every await (never the turn's copy): a reset close, a project switch or
    // a moved pointer that landed while the content was re-read voids the set before anything is consumed.
    const live = await this.store.sessions.get(session.id);
    const liveFailure = this.liveSessionFailure(live, anchor, claimId);
    if (liveFailure) {
      await this.saveAnchor(latestTask, invalidateCredentialOverrideAnchor(anchor, liveFailure, SYSTEM, this.clock()));
      await this.releasePointer(session.id, task.id); // pointer-only, and only if it is still ours
      return { ok: false, reason: liveFailure };
    }

    // ADR-0095 §5: the expiry re-check sits after every await, immediately before the consume save.
    const at = this.clock();
    const fresh = assessCredentialOverrideAnchor(anchor, approvals, at);
    if (fresh.kind !== 'ready') return fail(fresh.kind === 'invalid' ? fresh.reason : 'inconsistent');
    const consumed: CredentialOverrideAnchor = {
      ...anchor,
      status: 'CONSUMED',
      consumedAt: at,
      updatedAt: at,
      grants: anchor.grants.map((g) => ({ ...g, state: 'CONSUMED' as const, consumedAt: at })),
    };
    try {
      await this.saveAnchor(task, consumed); // ONE save: every grant and the anchor flip together
    } catch {
      return { ok: false, reason: 'consume-failed' }; // nothing sent
    }
    // The consume save was an await: re-load the canonical session (fail closed if unreadable). From here on the set
    // is CONSUMED — terminal and never replayable — so a failure sends nothing and leaves the row CONSUMED.
    const afterConsume = await this.store.sessions.get(session.id).catch(() => null);
    const afterFailure = this.liveSessionFailure(afterConsume, anchor, claimId);
    // Release the pointer so later turns never keep hitting a consumed anchor. Best effort: the CONSUMED row is
    // authoritative, and a pointer left on it only ever yields "already used".
    await this.releasePointer(session.id, task.id).catch(() => undefined);
    if (afterFailure) return { ok: false, reason: afterFailure };
    // ... and the release was an await too: one last re-load (pointer already released by us, so not checked).
    const final = await this.store.sessions.get(session.id).catch(() => null);
    const finalFailure = this.liveSessionFailure(final, anchor, null);
    if (finalFailure || !final) return { ok: false, reason: finalFailure ?? 'inconsistent' };
    return {
      ok: true,
      grants: consumed.grants.map((g) => ({
        path: g.path, contentSha256: g.contentSha256, detector: g.detector, line: g.line, state: 'CONSUMED',
      })),
      granted: anchor,
      approvals,
      consumed,
      session: final,
    };
  }

  async invalidate(
    session: Session,
    reason: CredentialOverrideInvalidationReason,
    invalidatedBy: string,
  ): Promise<CredentialOverrideInvalidationResult | null> {
    if (!session.activeTaskId) return null;
    return this.serialized(session.activeTaskId, async () => {
      const found = await this.anchorTask(session);
      if (!found) return null;
      return this.invalidateFound(session, found, reason, invalidatedBy);
    });
  }

  async clear(session: Session): Promise<void> {
    // Never clear activeTaskId unless it still points at OUR anchor — an approval anchor (or anything else)
    // sharing the same pointer slot must be left untouched.
    if (!session.activeTaskId) return;
    await this.serialized(session.activeTaskId, async () => {
      const found = await this.anchorTask(session);
      if (!found) return;
      await this.invalidateFound(session, found, 'superseded', SYSTEM);
    });
  }
}
