import { describe, expect, it, vi } from 'vitest';
import { WorkspaceWriteManager } from './workspace-write-manager';
import { ApprovalStatus, PatchStatus, WorkspaceChangeStatus } from '../domain';
import type {
  ApplyInput,
  ApprovalRef,
  ChangeSetApplyResult,
  FileChangeResult,
  PatchOperation,
  PatchSet,
  WorkspaceChange,
  WorkspaceRef,
} from '../domain';
import type { StorageProvider, WorkspaceWriter } from '../ports';

const planRef = { id: 'plan-1', goal: 'do x' };
const integrity = { kind: 'profile-application', contractVersion: 'v1', digest: 'sha256:plan-1' };
const approved: ApprovalRef = { id: 'appr-1', status: ApprovalStatus.APPROVED, executionPlanRef: planRef };
const workspaceRef: WorkspaceRef = { id: 'w1', rootPath: '/tmp/ws', kind: 'local-clone' };

function patchSet(...operations: PatchOperation[]): PatchSet {
  return {
    id: 'patch-1',
    executionPlanRef: planRef,
    approvalRef: approved,
    operations: operations.length
      ? operations
      : [
          { path: 'a.ts', operation: 'update', diff: '@@\n-1\n+2' },
          { path: 'b.ts', operation: 'add', diff: '@@\n+new' },
        ],
    status: PatchStatus.GENERATED,
    createdAt: '2026-06-30T00:00:00.000Z',
  };
}

/** In-memory storage + a writer whose per-path result (and change-set outcome) is configurable. */
function harness(
  writerFor: (op: PatchOperation) => FileChangeResult['status'] = () => 'applied',
  changeSetFor: (ops: PatchOperation[]) => ChangeSetApplyResult = (ops) => ({
    outcome: 'applied',
    results: ops.map((op) => ({
      path: op.path,
      operation: op.operation,
      status: 'applied',
      message: 'ok',
      durationMs: 1,
    })),
  }),
) {
  const rows = new Map<string, WorkspaceChange>();
  const storage = {
    workspaceChanges: {
      async get(id: string) {
        return rows.get(id) ?? null;
      },
      async save(c: WorkspaceChange) {
        rows.set(c.id, c);
        return c;
      },
      async delete(id: string) {
        rows.delete(id);
      },
      async list() {
        return [...rows.values()];
      },
      async findByPatchSet(patchSetId: string) {
        return [...rows.values()].filter((c) => c.patchRef.id === patchSetId);
      },
    },
  } as unknown as StorageProvider;
  const applyOperation = vi.fn(async (_ref: WorkspaceRef, op: PatchOperation): Promise<FileChangeResult> => ({
    path: op.path,
    operation: op.operation,
    status: writerFor(op),
    message: writerFor(op),
    durationMs: 1,
  }));
  const applyChangeSet = vi.fn(async (_ref: WorkspaceRef, ops: PatchOperation[]) => changeSetFor(ops));
  const writer: WorkspaceWriter = { kind: 'fake', applyOperation, applyChangeSet };
  return { storage, writer, applyOperation, applyChangeSet, rows };
}

function input(over: Partial<ApplyInput> = {}): ApplyInput {
  return { patchSet: patchSet(), approvalRef: approved, workspaceRef, ...over };
}

describe('WorkspaceWriteManager (CAP-006, ADR-0027)', () => {
  it('applies an approved PatchSet → APPLIED, records a result per operation', async () => {
    const { storage, writer, applyOperation } = harness();
    const change = await new WorkspaceWriteManager(storage, writer).apply(input());
    expect(change.status).toBe(WorkspaceChangeStatus.APPLIED);
    expect(change.results).toHaveLength(2);
    expect(change.patchRef.id).toBe('patch-1');
    expect(applyOperation).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-APPROVED approval', async () => {
    const { storage, writer } = harness();
    await expect(
      new WorkspaceWriteManager(storage, writer).apply(
        input({ approvalRef: { id: 'a', status: ApprovalStatus.PENDING, executionPlanRef: planRef } }),
      ),
    ).rejects.toThrow(/APPROVED/);
  });

  it('rejects an approval scoped to a different ExecutionPlan (referential integrity)', async () => {
    const { storage, writer } = harness();
    await expect(
      new WorkspaceWriteManager(storage, writer).apply(
        input({
          approvalRef: { id: 'a', status: ApprovalStatus.APPROVED, executionPlanRef: { id: 'OTHER', goal: 'z' } },
        }),
      ),
    ).rejects.toThrow(/different ExecutionPlan/);
  });

  it('accepts matching full integrity and preserves legacy-compatible omission', async () => {
    const integrityPlanRef = { ...planRef, integrity };
    const integrityPatch = { ...patchSet(), executionPlanRef: integrityPlanRef };
    const { storage, writer } = harness();
    await expect(
      new WorkspaceWriteManager(storage, writer).apply(
        input({
          patchSet: integrityPatch,
          approvalRef: {
            id: 'appr-integrity',
            status: ApprovalStatus.APPROVED,
            executionPlanRef: integrityPlanRef,
          },
        }),
      ),
    ).resolves.toBeDefined();
    const legacy = harness();
    await expect(
      new WorkspaceWriteManager(legacy.storage, legacy.writer).apply(input()),
    ).resolves.toBeDefined();
  });

  it.each([
    ['kind', { ...integrity, kind: 'other-kind' }],
    ['contract version', { ...integrity, contractVersion: 'v2' }],
    ['digest', { ...integrity, digest: 'sha256:other' }],
  ])('rejects an integrity %s mismatch for the same plan id', async (_field, approvalIntegrity) => {
    const { storage, writer } = harness();
    await expect(
      new WorkspaceWriteManager(storage, writer).apply(
        input({
          patchSet: { ...patchSet(), executionPlanRef: { ...planRef, integrity } },
          approvalRef: {
            id: 'appr-mismatch',
            status: ApprovalStatus.APPROVED,
            executionPlanRef: { ...planRef, integrity: approvalIntegrity },
          },
        }),
      ),
    ).rejects.toThrow(/different ExecutionPlan/);
  });

  it.each([
    ['approval only', planRef, { ...planRef, integrity }],
    ['patch only', { ...planRef, integrity }, planRef],
  ])('rejects integrity presence mismatch: %s', async (_case, patchPlanRef, approvalPlanRef) => {
    const { storage, writer } = harness();
    await expect(
      new WorkspaceWriteManager(storage, writer).apply(
        input({
          patchSet: { ...patchSet(), executionPlanRef: patchPlanRef },
          approvalRef: {
            id: 'appr-presence',
            status: ApprovalStatus.APPROVED,
            executionPlanRef: approvalPlanRef,
          },
        }),
      ),
    ).rejects.toThrow(/different ExecutionPlan/);
  });

  it('is best-effort: attempts EVERY operation and derives PARTIALLY_APPLIED', async () => {
    const { storage, writer, applyOperation } = harness((op) => (op.path === 'b.ts' ? 'failed' : 'applied'));
    const change = await new WorkspaceWriteManager(storage, writer).apply(input());
    expect(applyOperation).toHaveBeenCalledTimes(2); // did NOT stop at the failure
    expect(change.status).toBe(WorkspaceChangeStatus.PARTIALLY_APPLIED);
  });

  it('derives FAILED when no operation applies', async () => {
    const { storage, writer } = harness(() => 'failed');
    const change = await new WorkspaceWriteManager(storage, writer).apply(input());
    expect(change.status).toBe(WorkspaceChangeStatus.FAILED);
  });

  it('is idempotent: an already-APPLIED PatchSet is a no-op (writer not called)', async () => {
    const { storage, writer, applyOperation } = harness();
    const mgr = new WorkspaceWriteManager(storage, writer);
    const first = await mgr.apply(input());
    expect(first.status).toBe(WorkspaceChangeStatus.APPLIED);
    applyOperation.mockClear();
    const second = await mgr.apply(input());
    expect(second.id).toBe(first.id);
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('same patch revision re-run stays idempotent (no-op, same WorkspaceChange)', async () => {
    const { storage, writer, applyOperation } = harness();
    const mgr = new WorkspaceWriteManager(storage, writer);
    const ps = patchSet({ path: 'a.ts', operation: 'update', diff: '@@\n-1\n+2' });
    const first = await mgr.apply(input({ patchSet: ps }));
    applyOperation.mockClear();
    const second = await mgr.apply(input({ patchSet: ps })); // identical revision
    expect(second.id).toBe(first.id);
    expect(second.patchHash).toBe(first.patchHash);
    expect(applyOperation).not.toHaveBeenCalled();
  });

  it('refuses to reuse a WorkspaceChange for a DIFFERENT patch revision (same PatchSet id)', async () => {
    const { storage, writer } = harness();
    const mgr = new WorkspaceWriteManager(storage, writer);
    // Both PatchSets share id 'patch-1' (from the helper) but carry different operations.
    await mgr.apply(input({ patchSet: patchSet({ path: 'one.ts', operation: 'add', diff: '@@\n+1' }) }));
    await expect(
      mgr.apply(input({ patchSet: patchSet({ path: 'two.ts', operation: 'add', diff: '@@\n+2' }) })),
    ).rejects.toThrow(/different revision|refusing to reuse/);
  });

  it('never mutates the PatchSet (aggregate ownership)', async () => {
    const { storage, writer } = harness();
    const ps = Object.freeze(patchSet());
    const snapshot = JSON.stringify(ps);
    await new WorkspaceWriteManager(storage, writer).apply(input({ patchSet: ps }));
    expect(JSON.stringify(ps)).toBe(snapshot);
  });
});

describe('WorkspaceWriteManager.applyChangeSet (ADR-0099)', () => {
  const rolledBack = (ops: PatchOperation[]): ChangeSetApplyResult => ({
    outcome: 'rolled_back',
    results: ops.map((op, i) => ({
      path: op.path,
      operation: op.operation,
      status: i === 0 ? 'failed' : 'skipped',
      message: 'stale',
      durationMs: 1,
    })),
  });

  it('delegates the whole set to writer.applyChangeSet once → APPLIED, persisting every result', async () => {
    const { storage, writer, applyOperation, applyChangeSet, rows } = harness();
    const change = await new WorkspaceWriteManager(storage, writer).applyChangeSet(input());
    expect(change.status).toBe(WorkspaceChangeStatus.APPLIED);
    expect(change.results.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
    expect(applyChangeSet).toHaveBeenCalledTimes(1);
    expect(applyChangeSet).toHaveBeenCalledWith(workspaceRef, patchSet().operations);
    expect(applyOperation).not.toHaveBeenCalled();
    expect(rows.get(change.id)?.status).toBe(WorkspaceChangeStatus.APPLIED);
  });

  it('maps rolled_back → ROLLED_BACK and rollback_failed → PARTIALLY_APPLIED', async () => {
    const rb = harness(undefined, rolledBack);
    expect((await new WorkspaceWriteManager(rb.storage, rb.writer).applyChangeSet(input())).status).toBe(
      WorkspaceChangeStatus.ROLLED_BACK,
    );
    const rf = harness(undefined, (ops) => ({ ...rolledBack(ops), outcome: 'rollback_failed' }));
    expect((await new WorkspaceWriteManager(rf.storage, rf.writer).applyChangeSet(input())).status).toBe(
      WorkspaceChangeStatus.PARTIALLY_APPLIED,
    );
  });

  const resultOf = (op: PatchOperation, status: FileChangeResult['status'] = 'applied'): FileChangeResult => ({
    path: op.path,
    operation: op.operation,
    status,
    message: '',
    durationMs: 1,
  });
  it.each([
    ['a missing result', (ops: PatchOperation[]) => ops.slice(1).map((op) => resultOf(op))],
    ['a non-applied result', (ops: PatchOperation[]) => ops.map((op, i) => resultOf(op, i ? 'skipped' : 'applied'))],
    ['a reordered result', (ops: PatchOperation[]) => [...ops].reverse().map((op) => resultOf(op))],
  ])('a claimed `applied` with %s is PARTIALLY_APPLIED, never APPLIED', async (_case, results) => {
    const { storage, writer } = harness(undefined, (ops) => ({ outcome: 'applied', results: results(ops) }));
    const change = await new WorkspaceWriteManager(storage, writer).applyChangeSet(input());
    expect(change.status).toBe(WorkspaceChangeStatus.PARTIALLY_APPLIED);
  });

  it('keeps the approval Ref gate and plan-identity check (writer never called)', async () => {
    const { storage, writer, applyChangeSet } = harness();
    const mgr = new WorkspaceWriteManager(storage, writer);
    await expect(
      mgr.applyChangeSet(
        input({ approvalRef: { id: 'a', status: ApprovalStatus.PENDING, executionPlanRef: planRef } }),
      ),
    ).rejects.toThrow(/APPROVED/);
    await expect(
      mgr.applyChangeSet(
        input({
          approvalRef: { id: 'a', status: ApprovalStatus.APPROVED, executionPlanRef: { id: 'OTHER', goal: 'z' } },
        }),
      ),
    ).rejects.toThrow(/different ExecutionPlan/);
    expect(applyChangeSet).not.toHaveBeenCalled();
  });

  it('is idempotent on APPLIED and refuses a different revision of the same PatchSet', async () => {
    const { storage, writer, applyChangeSet } = harness();
    const mgr = new WorkspaceWriteManager(storage, writer);
    const first = await mgr.applyChangeSet(input());
    applyChangeSet.mockClear();
    const second = await mgr.applyChangeSet(input());
    expect(second.id).toBe(first.id);
    expect(applyChangeSet).not.toHaveBeenCalled();
    await expect(
      mgr.applyChangeSet(input({ patchSet: patchSet({ path: 'c.ts', operation: 'add', diff: '@@\n+c' }) })),
    ).rejects.toThrow(/different revision|refusing to reuse/);
  });

  it('re-attempts a ROLLED_BACK change for the same patchHash on the same aggregate', async () => {
    let outcome: 'rolled_back' | 'applied' = 'rolled_back';
    const { storage, writer, applyChangeSet } = harness(undefined, (ops) =>
      outcome === 'rolled_back'
        ? rolledBack(ops)
        : { outcome: 'applied', results: ops.map((op) => resultOf(op)) },
    );
    const mgr = new WorkspaceWriteManager(storage, writer);
    const first = await mgr.applyChangeSet(input());
    expect(first.status).toBe(WorkspaceChangeStatus.ROLLED_BACK);
    outcome = 'applied';
    const second = await mgr.applyChangeSet(input());
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(WorkspaceChangeStatus.APPLIED);
    expect(applyChangeSet).toHaveBeenCalledTimes(2);
  });

  it('re-attempts a FAILED change, but returns a PARTIALLY_APPLIED one unchanged (may have applied)', async () => {
    const failed = harness(() => 'failed');
    const mgrF = new WorkspaceWriteManager(failed.storage, failed.writer);
    expect((await mgrF.apply(input())).status).toBe(WorkspaceChangeStatus.FAILED);
    expect((await mgrF.applyChangeSet(input())).status).toBe(WorkspaceChangeStatus.APPLIED);
    expect(failed.applyChangeSet).toHaveBeenCalledTimes(1);

    const partial = harness(undefined, (ops) => ({ ...rolledBack(ops), outcome: 'rollback_failed' }));
    const mgrP = new WorkspaceWriteManager(partial.storage, partial.writer);
    const first = await mgrP.applyChangeSet(input());
    expect(first.status).toBe(WorkspaceChangeStatus.PARTIALLY_APPLIED);
    const second = await mgrP.applyChangeSet(input());
    expect(second).toEqual(first);
    expect(partial.applyChangeSet).toHaveBeenCalledTimes(1);
  });

  it('never mutates the PatchSet', async () => {
    const { storage, writer } = harness();
    const ps = Object.freeze(patchSet());
    const snapshot = JSON.stringify(ps);
    await new WorkspaceWriteManager(storage, writer).applyChangeSet(input({ patchSet: ps }));
    expect(JSON.stringify(ps)).toBe(snapshot);
  });
});
