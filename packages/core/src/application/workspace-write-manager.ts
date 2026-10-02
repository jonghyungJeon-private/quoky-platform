import { newId } from '../util/id';
import { now } from '../util/clock';
import { contentHash } from '../util/hash';
import { ApprovalStatus, WorkspaceChangeStatus, patchRef } from '../domain';
import type {
  ApplyInput,
  ChangeSetApplyResult,
  ExecutionPlanRef,
  FileChangeResult,
  Id,
  PatchOperation,
  WorkspaceChange,
} from '../domain';
import type { StorageProvider, WorkspaceWriter } from '../ports';

/** ADR-0068 plan identity: legacy refs match only when both omit integrity. */
function sameExecutionPlanRef(left: ExecutionPlanRef, right: ExecutionPlanRef): boolean {
  if (left.id !== right.id) return false;
  if (!left.integrity || !right.integrity) return left.integrity === right.integrity;
  return (
    left.integrity.kind === right.integrity.kind &&
    left.integrity.contractVersion === right.integrity.contractVersion &&
    left.integrity.digest === right.integrity.digest
  );
}

/** Derive the aggregate status from best-effort per-file results. */
function deriveStatus(results: FileChangeResult[]): WorkspaceChangeStatus {
  const applied = results.filter((r) => r.status === 'applied').length;
  if (applied === results.length) return WorkspaceChangeStatus.APPLIED; // incl. empty → APPLIED
  if (applied === 0) return WorkspaceChangeStatus.FAILED;
  return WorkspaceChangeStatus.PARTIALLY_APPLIED;
}

/** Change-set re-attempt rule (ADR-0099): only when the workspace is known unchanged. */
function isChangeSetRetryable(status: WorkspaceChangeStatus): boolean {
  return status === WorkspaceChangeStatus.FAILED || status === WorkspaceChangeStatus.ROLLED_BACK;
}

/**
 * Map an all-or-nothing change-set outcome (ADR-0099) to the aggregate status.
 * APPLIED additionally requires one `applied` result per operation, in order; a
 * writer that claims `applied` without that match is treated as "may have applied".
 */
function deriveChangeSetStatus(
  ops: PatchOperation[],
  result: ChangeSetApplyResult,
): WorkspaceChangeStatus {
  if (result.outcome === 'rolled_back') return WorkspaceChangeStatus.ROLLED_BACK;
  if (result.outcome === 'rollback_failed') return WorkspaceChangeStatus.PARTIALLY_APPLIED;
  const oneToOne =
    result.results.length === ops.length &&
    ops.every((op, i) => {
      const r = result.results[i];
      return r !== undefined && r.status === 'applied' && r.path === op.path && r.operation === op.operation;
    });
  return oneToOne ? WorkspaceChangeStatus.APPLIED : WorkspaceChangeStatus.PARTIALLY_APPLIED;
}

/**
 * CAP-006 Workspace Write (ADR-0027). Owns the `WorkspaceChange` aggregate — the
 * Execution History of applying a `PatchSet` — and is the ONLY capability that
 * mutates it. It READS the immutable `PatchSet` and references the plan/approval
 * via Refs; it never mutates PatchSet/ExecutionPlan/ApprovalRequest, never calls
 * git, never generates patches. File application is delegated to the
 * `WorkspaceWriter` adapter (atomic unit = file, best-effort across files), or —
 * via `applyChangeSet` (ADR-0099) — to its all-or-nothing change-set mode.
 */
export class WorkspaceWriteManager {
  constructor(
    private readonly storage: StorageProvider,
    private readonly writer: WorkspaceWriter,
  ) {}

  /**
   * Apply an approved PatchSet to its workspace. Best-effort: every operation is
   * attempted and recorded. Idempotency is `WorkspaceChange.status`-based: an
   * already-APPLIED PatchSet is a no-op; FAILED/PARTIALLY_APPLIED/APPLYING (and a
   * change-set ROLLED_BACK) are re-attempted on the same aggregate.
   */
  async apply(input: ApplyInput): Promise<WorkspaceChange> {
    const { patchSet, workspaceRef } = input;
    const begun = await this.begin(input, () => true);
    if (begun.done) return begun.change;

    // (4) Best-effort: attempt every operation; the writer encodes failures.
    const results: FileChangeResult[] = [];
    for (const op of patchSet.operations) {
      results.push(await this.writer.applyOperation(workspaceRef, op));
    }

    // (5) Derive final status and persist the Execution History.
    return this.finish(begun.change, input, deriveStatus(results), results);
  }

  /**
   * Apply an approved PatchSet as ONE all-or-nothing change set (ADR-0099). Same
   * approval Ref gate, plan-identity check and patchHash idempotency as `apply`;
   * the writer's `applyChangeSet` does the two-phase write and rollback. Outcome →
   * status: `applied` → APPLIED, `rolled_back` → ROLLED_BACK, `rollback_failed` →
   * PARTIALLY_APPLIED ("may have applied").
   *
   * Re-attempts: only a FAILED or ROLLED_BACK change (workspace known unchanged) is
   * re-attempted on the same aggregate. APPLIED is an idempotent no-op, and a
   * PARTIALLY_APPLIED or APPLYING change is returned unchanged — its workspace state
   * is unknown, and a re-run must never overwrite that record with a clean status.
   */
  async applyChangeSet(input: ApplyInput): Promise<WorkspaceChange> {
    const { patchSet, workspaceRef } = input;
    const begun = await this.begin(input, isChangeSetRetryable);
    if (begun.done) return begun.change;

    const ops = patchSet.operations;
    const result = await this.writer.applyChangeSet(workspaceRef, ops);
    return this.finish(begun.change, input, deriveChangeSetStatus(ops, result), result.results);
  }

  /**
   * Steps (1)–(3) shared by both apply modes: the approval Ref gate, the revision
   * contract with status-based idempotency, then create-or-reuse the aggregate and
   * mark it APPLYING. Returns `done` with the existing change when it must not be
   * re-attempted (APPLIED, or a status `retryable` rejects).
   */
  private async begin(
    input: ApplyInput,
    retryable: (status: WorkspaceChangeStatus) => boolean,
  ): Promise<{ done: boolean; change: WorkspaceChange }> {
    const { patchSet, approvalRef, workspaceRef } = input;

    // (1) Approval gate — Ref only (no ApprovalManager query). Plan-scoped (CAP-005).
    if (approvalRef.status !== ApprovalStatus.APPROVED) {
      throw new Error(`workspace write requires an APPROVED approval (got ${approvalRef.status})`);
    }
    if (!sameExecutionPlanRef(approvalRef.executionPlanRef, patchSet.executionPlanRef)) {
      throw new Error(
        `approval ${approvalRef.id} is scoped to a different ExecutionPlan ` +
          `(${approvalRef.executionPlanRef.id}, expected ${patchSet.executionPlanRef.id})`,
      );
    }

    // (2) Revision contract + status-based idempotency. The applied patch revision is a
    // content hash of the PatchSet's operations, persisted on the WorkspaceChange.
    const patchHash = contentHash(JSON.stringify(patchSet.operations));
    const existing = (await this.storage.workspaceChanges.findByPatchSet(patchSet.id))[0];
    if (existing) {
      if (existing.patchHash !== patchHash) {
        // Same PatchSet id, different revision/content — refuse to reuse the change.
        throw new Error(
          `workspace change ${existing.id} already applied patch revision ${existing.patchHash}; ` +
            `refusing to reuse it for a different revision (${patchHash})`,
        );
      }
      // APPLIED is an idempotent no-op; a status the mode does not re-attempt is returned as is.
      if (existing.status === WorkspaceChangeStatus.APPLIED || !retryable(existing.status)) {
        return { done: true, change: existing };
      }
    }

    // (3) Create or reuse the aggregate, mark APPLYING.
    const ts = now();
    const base: WorkspaceChange = existing ?? {
      id: newId(),
      patchRef: patchRef(patchSet),
      patchHash,
      executionPlanRef: patchSet.executionPlanRef,
      approvalRef,
      workspaceRef,
      status: WorkspaceChangeStatus.PENDING,
      results: [],
      createdAt: ts,
      updatedAt: ts,
    };
    await this.storage.workspaceChanges.save({
      ...base,
      status: WorkspaceChangeStatus.APPLYING,
      updatedAt: ts,
    });
    return { done: false, change: base };
  }

  /** Persist the final status + per-file results (the Execution History). */
  private async finish(
    base: WorkspaceChange,
    input: ApplyInput,
    status: WorkspaceChangeStatus,
    results: FileChangeResult[],
  ): Promise<WorkspaceChange> {
    const change: WorkspaceChange = {
      ...base,
      approvalRef: input.approvalRef,
      workspaceRef: input.workspaceRef,
      status,
      results,
      updatedAt: now(),
    };
    return this.storage.workspaceChanges.save(change);
  }

  async get(id: Id): Promise<WorkspaceChange | null> {
    return this.storage.workspaceChanges.get(id);
  }

  /** Execution history for a given PatchSet. */
  async findByPatchSet(patchSetId: Id): Promise<WorkspaceChange[]> {
    return this.storage.workspaceChanges.findByPatchSet(patchSetId);
  }
}
