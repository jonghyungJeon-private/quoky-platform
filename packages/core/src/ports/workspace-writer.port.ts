import type { ChangeSetApplyResult, FileChangeResult, PatchOperation, WorkspaceRef } from '../domain';

/**
 * PORT: applies ONE patch operation to the workspace filesystem (CAP-006,
 * ADR-0027), or a bounded change set all-or-nothing (`applyChangeSet`, ADR-0099).
 * For `applyOperation` the **atomic unit = file** (a PatchSet is not a transaction). The
 * implementation lives adapter-side (`node:fs` only — no git, no child_process)
 * and **encodes apply failures in the returned `FileChangeResult`** rather than
 * throwing, so the manager can record best-effort results for every operation.
 */
export interface WorkspaceWriter {
  readonly kind: string;
  applyOperation(ref: WorkspaceRef, op: PatchOperation): Promise<FileChangeResult>;
  /**
   * Apply a bounded change set all-or-nothing (ADR-0099): `update` of existing text
   * files and `add` of absent paths only (delete/binary reject the whole set), at
   * most 5 operations, 64 KiB per file, 256 KiB in total. Nothing is written until
   * every operation has been checked and computed; on the first write failure every
   * promoted file is restored and every created file/directory removed. Like
   * `applyOperation`, failures are encoded in the result, never thrown.
   */
  applyChangeSet(ref: WorkspaceRef, ops: PatchOperation[]): Promise<ChangeSetApplyResult>;
}
