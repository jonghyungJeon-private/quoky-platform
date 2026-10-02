import type { Id, IsoTimestamp } from './common';
import type { WorkspaceChangeStatus } from './enums';
import type { PatchOperationKind, PatchRef, PatchSet } from './patch';
import type { ExecutionPlanRef } from './execution-plan';
import type { ApprovalRef } from './approval';
import type { WorkspaceRef } from './workspace';

/**
 * Per-file outcome of applying one PatchOperation (CAP-006, ADR-0027). `rolled_back`
 * (ADR-0099): the file was written by a change set and then restored to its
 * pre-apply state (an added file was removed) after another file in the set failed.
 */
export type FileChangeStatus = 'applied' | 'failed' | 'skipped' | 'rolled_back';

/**
 * The record of what happened to ONE file. The file is the atomic unit of a
 * Workspace Write — a PatchSet is not a transaction.
 */
export interface FileChangeResult {
  path: string;
  operation: PatchOperationKind;
  status: FileChangeStatus;
  /** Human-readable outcome / sanitized error detail. */
  message: string;
  /** Wall-clock duration of this file's apply, in ms. */
  durationMs: number;
}

/**
 * Workspace Write's aggregate — the **Execution History** of applying a `PatchSet`
 * to a workspace (CAP-006, ADR-0027). Owned & mutated ONLY by Workspace Write; it
 * references the patch/plan/approval/workspace via Refs and never mutates them.
 * Best-effort: every operation is attempted; per-file results are all recorded.
 */
export interface WorkspaceChange {
  id: Id;
  patchRef: PatchRef;
  /**
   * Content revision of the PatchSet that was applied (a deterministic hash of its
   * operations). Persisted so the Execution History records EXACTLY which patch
   * revision produced this change — the basis for conflict detection / resume /
   * rollback / audit, and for refusing to reuse a change for a different revision
   * (CAP-006 review, ADR-0027).
   */
  patchHash: string;
  executionPlanRef: ExecutionPlanRef;
  approvalRef: ApprovalRef;
  workspaceRef: WorkspaceRef;
  status: WorkspaceChangeStatus;
  /** One result per PatchOperation attempted (applied/failed/skipped). */
  results: FileChangeResult[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * Outcome of applying a whole change set all-or-nothing (ADR-0099,
 * `WorkspaceWriter.applyChangeSet`):
 * - `applied` — every operation was written;
 * - `rolled_back` — an operation failed and nothing the set wrote remains (either
 *   nothing was written, or every written file was restored / removed);
 * - `rollback_failed` — an operation failed and at least one restore step failed,
 *   so the workspace may hold part of the set ("may have applied").
 * Atomic-ish only: guards against Quoky's own failures, not external writers or a
 * crash mid-rollback. `results` holds one entry per operation, in operation order.
 */
export interface ChangeSetApplyResult {
  outcome: 'applied' | 'rolled_back' | 'rollback_failed';
  results: FileChangeResult[];
}

/** Lightweight handle (V2 Ref model). */
export interface WorkspaceChangeRef {
  id: Id;
  status: WorkspaceChangeStatus;
}

/** Pure derivation of a WorkspaceChangeRef from the aggregate. */
export function workspaceChangeRef(change: WorkspaceChange): WorkspaceChangeRef {
  return { id: change.id, status: change.status };
}

/**
 * Input to applying a patch (CAP-006). The caller composes these (load the
 * immutable PatchSet, supply the plan-scoped ApprovalRef and the resolved
 * WorkspaceRef); Workspace Write imports no other capability manager.
 */
export interface ApplyInput {
  patchSet: PatchSet;
  approvalRef: ApprovalRef;
  workspaceRef: WorkspaceRef;
}
