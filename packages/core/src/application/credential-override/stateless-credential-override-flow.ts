import { newId } from '../../util/id';
import { now } from '../../util/clock';
import { Capability, IntentType, RiskLevel, TaskStatus } from '../../domain';
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
 * Holds the LIVE storage seam (ADR-0062): repositories are resolved at call time, never in the constructor.
 */
export class StatelessCredentialOverrideFlow implements CredentialOverrideFlow {
  private readonly clock: () => IsoTimestamp;
  /** Anchor Task ids whose consume/dispatch is in flight in this process. */
  private readonly claims = new Set<Id>();
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

  /** Release `session.activeTaskId` — the caller has already proven it points at `taskId` (our anchor). */
  private async releasePointer(session: Session, taskId: Id, at: IsoTimestamp): Promise<void> {
    if (session.activeTaskId !== taskId) return;
    await this.store.sessions.save({ ...session, activeTaskId: undefined, lastActivityAt: at });
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
    await this.releasePointer(session, found.task.id, at);
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
      await this.store.sessions.save({ ...session, activeTaskId: task.id, lastActivityAt: at });
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
    dispatch: (grants: readonly CredentialOverrideGrant[]) => Promise<T>,
  ): Promise<CredentialOverrideDispatchResult<T>> {
    const claimId = session.activeTaskId;
    if (!claimId) return { ok: false, reason: 'not-found' };
    // Claimed synchronously, before any await: a concurrent turn on the same anchor is refused, never queued.
    if (this.claims.has(claimId)) return { ok: false, reason: 'already-used' };
    this.claims.add(claimId);
    try {
      // Revalidate and consume under the anchor's serialization (first read through the consume save), so no
      // reset/denial/supersession can land between them; the provider call itself runs outside it.
      const consumed = await this.serialized(claimId, () => this.consume(session, claimId, input));
      if (!consumed.ok) return consumed;
      return { ok: true, value: await dispatch(consumed.grants) };
    } finally {
      this.claims.delete(claimId);
    }
  }

  /** Revalidate every grant and consume the whole set in ONE save; callers hold the anchor's serialization. */
  private async consume(
    session: Session,
    claimId: Id,
    input: CredentialOverrideDispatchInput,
  ): Promise<
    | { readonly ok: true; readonly grants: CredentialOverrideGrant[] }
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
    const liveSession = await this.store.sessions.get(session.id);
    if (liveSession?.activeTaskId !== claimId) {
      // The pointer moved on without us: write the audit row only, never touch a pointer that is no longer ours.
      await this.saveAnchor(latestTask, invalidateCredentialOverrideAnchor(anchor, 'superseded', SYSTEM, this.clock()));
      return { ok: false, reason: 'superseded' };
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
    // Release the pointer so later turns never keep hitting a consumed anchor. Best effort: the CONSUMED row is
    // authoritative, and a pointer left on it only ever yields "already used".
    await this.releasePointer(session, task.id, at).catch(() => undefined);
    return {
      ok: true,
      grants: consumed.grants.map((g) => ({
        path: g.path, contentSha256: g.contentSha256, detector: g.detector, line: g.line, state: 'CONSUMED',
      })),
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
