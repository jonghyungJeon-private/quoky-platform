import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentProfileRegistry, agentProfileId, ApprovalManager, ApprovalPolicy, Capability,
  ContinuationExecutionEntryService, createWorkHandoff, IntentType, RiskPolicy, TaskManager,
  TaskRunStatus, TaskStatus, WorkHandoffContinuationService, WorkItemStatus } from '@quoky/core';
import type { GuardedTaskRunStartFacts, Task, TaskRun, WorkItem } from '@quoky/core';
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS, SqliteStorageProvider } from './index';

const ts = '2026-09-22T00:00:00.000Z';
const stores: SqliteStorageProvider[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Disposable test-owned SQLite with a real continuation-bound RUNNING Task (no approval path). */
async function fixture(busyTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-taskrun-safety-')); dirs.push(dir);
  const dbPath = join(dir, 'test.db');
  const storage = new SqliteStorageProvider(busyTimeoutMs === undefined ? { dbPath } : { dbPath, busyTimeoutMs });
  await storage.init(); stores.push(storage);
  const work: WorkItem = { id: 'work', actorId: 'actor', projectId: 'project', status: WorkItemStatus.ACTIVE,
    origin: 'conversation', resourceRefs: [], createdAt: ts, updatedAt: ts };
  await storage.workItems.save(work);
  const handoff = createWorkHandoff({ id: 'handoff', workItemId: work.id,
    fromAgentProfileId: agentProfileId('source'), toAgentProfileId: agentProfileId('receiver'),
    objective: 'continue', resourceRefs: [], artifactIds: [], executionReceiptIds: [], createdAt: ts });
  await storage.workHandoffs.insert(handoff);
  const profiles = new AgentProfileRegistry(['source', 'receiver'].map(id =>
    ({ id: agentProfileId(id), displayName: id, role: id, purpose: id, instructions: id })));
  const tasks = new TaskManager(storage);
  const approvals = new ApprovalManager(storage, new ApprovalPolicy(new RiskPolicy()));
  const created = await tasks.createTask(
    { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'continue' },
    { platform: 'test', channelId: 'channel', userId: 'user' },
    { actorId: work.actorId, projectId: work.projectId, requestText: 'continue' });
  const lifecycle = new WorkHandoffContinuationService(storage, profiles, storage.continuationBindings, { tasks, approvals });
  await lifecycle.admit(handoff.id, created.id);
  const input = { handoffId: handoff.id, taskId: created.id };
  await lifecycle.prepare(input);
  const task = (await storage.tasks.get(created.id))!;
  const binding = (await storage.continuationBindings.get(handoff.id))!;
  const expected: GuardedTaskRunStartFacts = { handoff, binding, workItem: work, task, approval: { kind: 'NOT_REQUIRED' } };
  const entry = new ContinuationExecutionEntryService(storage, profiles, storage.continuationBindings, tasks);
  return { storage, dbPath, work, handoff, task, binding, expected, input, tasks, entry };
}

/** Ordinary (unbound) RUNNING Task in the same disposable database. */
async function unboundTask(f: { storage: SqliteStorageProvider; tasks: TaskManager }): Promise<Task> {
  const created = await f.tasks.createTask(
    { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'ordinary' },
    { platform: 'test', channelId: 'other', userId: 'user' },
    { actorId: 'actor', projectId: 'project', requestText: 'ordinary' });
  const planning = await f.tasks.transition(created, TaskStatus.PLANNING);
  return f.tasks.transition(planning, TaskStatus.RUNNING);
}

function raw(f: { dbPath: string }, action: (db: Database.Database) => void) {
  const db = new Database(f.dbPath);
  try { action(db); } finally { db.close(); }
}
function startedRows(f: { dbPath: string }, taskId: string): number {
  let count = 0;
  raw(f, db => {
    count = (db.prepare("SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ? AND json_extract(data, '$.status') = ?")
      .get(taskId, TaskRunStatus.STARTED) as { n: number }).n;
  });
  return count;
}

describe('ADR-0089 M3E-6G — continuation-bound TaskRun delete prohibition (real SQLite)', () => {
  it('refuses deletion of a bound STARTED run and preserves the exact row', async () => {
    const f = await fixture();
    const run = await f.entry.start(f.input);
    await expect(f.storage.taskRuns.delete(run.id)).rejects.toMatchObject({
      name: 'GuardedTaskRunStartError', code: 'CONTINUATION_RUN_DELETE_FORBIDDEN',
    });
    expect(await f.storage.taskRuns.get(run.id)).toEqual(run);
    expect(startedRows(f, f.task.id)).toBe(1);
  });

  it.each([TaskRunStatus.SUCCEEDED, TaskRunStatus.FAILED, TaskRunStatus.CANCELED])(
    'refuses deletion of bound terminal history: %s', async status => {
      const f = await fixture();
      const run = await f.entry.start(f.input);
      // R3-B3 (Item 3): a bound run's SUCCEEDED/FAILED terminalization must go through the secure path;
      // CANCELED remains a generic-save cancellation lifecycle. Both produce protected terminal history.
      const terminal = status === TaskRunStatus.CANCELED
        ? await f.storage.taskRuns.save({ ...run, status, finishedAt: ts })
        : await f.storage.taskRuns.terminalizePreservingSecurityEvidence(run.id, {
            terminalStatus: status === TaskRunStatus.SUCCEEDED ? 'SUCCEEDED' : 'FAILED', finishedAt: ts,
            ...(status === TaskRunStatus.FAILED ? { error: 'test failure' } : {}),
          });
      await expect(f.storage.taskRuns.delete(terminal.id)).rejects.toMatchObject({
        code: 'CONTINUATION_RUN_DELETE_FORBIDDEN',
      });
      // Terminal provenance is protected, not merely the unresolved STARTED attempt.
      expect(await f.storage.taskRuns.get(terminal.id)).toEqual(terminal);
    });

  it('preserves deletion of an unbound TaskRun and missing-id no-op semantics', async () => {
    const f = await fixture();
    const bound = await f.entry.start(f.input);
    const ordinary = await unboundTask(f);
    const run = await f.storage.taskRuns.start(ordinary, Capability.GENERAL_CHAT);
    await expect(f.storage.taskRuns.delete(run.id)).resolves.toBeUndefined();
    expect(await f.storage.taskRuns.get(run.id)).toBeNull();
    // Missing id stays a no-op for both an unknown id and an already-deleted unbound run.
    await expect(f.storage.taskRuns.delete('does-not-exist')).resolves.toBeUndefined();
    await expect(f.storage.taskRuns.delete(run.id)).resolves.toBeUndefined();
    expect(await f.storage.taskRuns.get(bound.id)).toEqual(bound);
  });

  it('cannot be evaded by re-parenting a bound run to an unbound Task through save', async () => {
    const f = await fixture();
    const run = await f.entry.start(f.input);
    const ordinary = await unboundTask(f);
    // The v11 immutable-start trigger owns identity; delete protection is not duplicated in SQL.
    await expect(f.storage.taskRuns.save({ ...run, taskId: ordinary.id }))
      .rejects.toThrow(/TASK_RUN_START_IDENTITY_IMMUTABLE/);
    await expect(f.storage.taskRuns.delete(run.id)).rejects.toMatchObject({
      code: 'CONTINUATION_RUN_DELETE_FORBIDDEN',
    });
    expect(await f.storage.taskRuns.get(run.id)).toEqual(run);
  });

  it('keeps attempt ordinals monotonic across bound terminal history; no repository path reuses one', async () => {
    const f = await fixture();
    const first = await f.entry.start(f.input);
    expect(first.attempt).toBe(1);
    await f.storage.taskRuns.terminalizePreservingSecurityEvidence(first.id, { terminalStatus: 'FAILED', finishedAt: ts, error: 'test failure' });
    await expect(f.storage.taskRuns.delete(first.id)).rejects.toMatchObject({
      code: 'CONTINUATION_RUN_DELETE_FORBIDDEN',
    });
    const second = await f.entry.start(f.input);
    expect(second.attempt).toBe(2);
    expect((await f.storage.taskRuns.listByTask(f.task.id)).map(run => run.attempt)).toEqual([1, 2]);
  });

  it('closes the repository-port delete bypass while claiming no raw-SQL immunity', async () => {
    const f = await fixture();
    const run = await f.entry.start(f.input);
    await expect(f.storage.taskRuns.delete(run.id)).rejects.toMatchObject({
      code: 'CONTINUATION_RUN_DELETE_FORBIDDEN',
    });
    // Explicit trusted-admin carve-out: direct SQL remains outside adapter-contract protection.
    raw(f, db => db.prepare('DELETE FROM task_runs WHERE id = ?').run(run.id));
    expect(await f.storage.taskRuns.get(run.id)).toBeNull();
  });
});

describe('ADR-0089 M3E-6G — delete vs guarded start concurrency (real child processes)', () => {
  it('rejects every concurrent delete and admits no replacement attempt for the bound Task', async () => {
    const f = await fixture();
    const existing = await f.entry.start(f.input);
    const worker = fileURLToPath(new URL('./test-support/guarded-start-worker.cjs', import.meta.url));
    const plan: Array<'delete' | 'start'> = ['delete', 'start', 'delete', 'start', 'delete', 'start'];
    const children = plan.map(() => fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    try {
      const finished = children.map(child => new Promise<{ run?: TaskRun; deleted?: boolean; code?: string }>((resolve, reject) => {
        child.on('message', (message: { type: string; error?: string; run?: TaskRun; deleted?: boolean; code?: string }) => {
          if (message.type === 'result') resolve(message);
          if (message.type === 'fatal') reject(new Error(message.error));
        });
        child.on('error', reject);
        child.on('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
      }));
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.on('message', (message: { type: string; error?: string }) => {
          if (message.type === 'ready') resolve();
          if (message.type === 'fatal') reject(new Error(message.error));
        });
        child.on('error', reject);
        child.on('exit', code => { if (code !== 0) reject(new Error(`worker init exit ${code}`)); });
        child.send({ type: 'init', dbPath: f.dbPath });
      })));
      // Barrier: every independent connection is open before any operation is dispatched.
      children.forEach((child, index) => child.send(plan[index] === 'delete'
        ? { type: 'delete', runId: existing.id }
        : { type: 'start', expected: f.expected, capability: Capability.GENERAL_CHAT }));
      const results = await Promise.all(finished);
      expect(results.filter(result => result.deleted)).toHaveLength(0);
      expect(results.filter(result => result.run)).toHaveLength(0);
      for (const [index, result] of results.entries()) {
        expect(result.code).toBe(plan[index] === 'delete'
          ? 'CONTINUATION_RUN_DELETE_FORBIDDEN'
          : 'UNRESOLVED_STARTED_RUN');
      }
      expect(await f.storage.taskRuns.list()).toEqual([existing]);
      expect(startedRows(f, f.task.id)).toBe(1);
    } finally {
      for (const child of children) if (child.connected) child.kill();
    }
  }, 30_000);
});

describe('ADR-0089 M3E-6G — explicit lock wait and typed storage contention (real SQLite)', () => {
  it('exposes the previously implicit driver default as the explicit adapter default', () => {
    expect(DEFAULT_SQLITE_BUSY_TIMEOUT_MS).toBe(5000);
  });

  it.each([-1, 1.5, Number.NaN])('rejects an invalid configured lock wait: %s', async value => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-taskrun-busy-cfg-')); dirs.push(dir);
    const store = new SqliteStorageProvider({ dbPath: join(dir, 'test.db'), busyTimeoutMs: value });
    await expect(store.init()).rejects.toThrow('SQLITE_BUSY_TIMEOUT_INVALID');
  });

  it('maps real lock contention to the typed outcome and commits no TaskRun', async () => {
    // Bounded wait shortened so the configured timeout deterministically expires; still a real lock.
    const f = await fixture(50);
    const blocker = new Database(f.dbPath);
    try {
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('INSERT INTO projects (id, data) VALUES (?, ?)').run('lock', JSON.stringify({ id: 'lock' }));
      const started = Date.now();
      await expect(f.storage.taskRuns.guardedStart(f.expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({
        name: 'GuardedTaskRunStartError', code: 'TASK_RUN_STORAGE_BUSY',
      });
      // The bounded driver wait elapsed inside one call; no Application retry loop ran.
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
      // Contention is not a live-attempt conflict: no attempt identity was fabricated.
      expect(await f.storage.taskRuns.list()).toEqual([]);
      expect(startedRows(f, f.task.id)).toBe(0);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  }, 20_000);

  it('distinguishes storage contention from an unresolved live attempt', async () => {
    const f = await fixture(50);
    const existing = await f.entry.start(f.input);
    await expect(f.storage.taskRuns.guardedStart(f.expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({
      code: 'UNRESOLVED_STARTED_RUN',
    });
    expect(await f.storage.taskRuns.list()).toEqual([existing]);
  });

  it('succeeds normally once contention clears, without creating a replacement attempt', async () => {
    // better-sqlite3 is synchronous, so the lock must be released before the next call, not on a timer.
    const f = await fixture(50);
    const blocker = new Database(f.dbPath);
    blocker.exec('BEGIN IMMEDIATE');
    await expect(f.storage.taskRuns.guardedStart(f.expected, Capability.GENERAL_CHAT)).rejects.toMatchObject({
      code: 'TASK_RUN_STORAGE_BUSY',
    });
    blocker.exec('ROLLBACK');
    blocker.close();
    // The busy failure produced no attempt identity, so the next explicit call is attempt 1, not 2.
    const run = await f.storage.taskRuns.guardedStart(f.expected, Capability.GENERAL_CHAT);
    expect(run.attempt).toBe(1);
    expect(await f.storage.taskRuns.list()).toEqual([run]);
  }, 20_000);
});

describe('ADR-0089 M3E-6G — CANCELED coverage and ordinary TaskRun regression (real SQLite)', () => {
  it('persists STARTED → CANCELED for a bound run and denies CANCELED → STARTED revival', async () => {
    const f = await fixture();
    const run = await f.entry.start(f.input);
    const canceled = await f.storage.taskRuns.save({ ...run, status: TaskRunStatus.CANCELED, finishedAt: ts });
    expect(canceled.status).toBe(TaskRunStatus.CANCELED);
    expect(await f.storage.taskRuns.get(run.id)).toEqual(canceled);
    await expect(f.storage.taskRuns.save({ ...canceled, status: TaskRunStatus.STARTED }))
      .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
    expect(await f.storage.taskRuns.get(run.id)).toEqual(canceled);
    // CANCELED is terminal for the unresolved predicate, so a later guarded start is admitted as a new
    // ordinal — never as a revival of the canceled attempt, and never via deletion.
    await expect(f.storage.taskRuns.delete(canceled.id)).rejects.toMatchObject({
      code: 'CONTINUATION_RUN_DELETE_FORBIDDEN',
    });
    const next = await f.entry.start(f.input);
    expect(next.id).not.toBe(canceled.id);
    expect(next.attempt).toBe(2);
  });

  it('leaves ordinary start, terminal update and delete semantics unchanged for unbound Tasks', async () => {
    const f = await fixture();
    const ordinary = await unboundTask(f);
    const first = await f.storage.taskRuns.start(ordinary, Capability.GENERAL_CHAT);
    expect(first.attempt).toBe(1);
    const terminal = await f.storage.taskRuns.save({ ...first, status: TaskRunStatus.SUCCEEDED, finishedAt: ts });
    expect(await f.storage.taskRuns.get(first.id)).toEqual(terminal);
    const second = await f.storage.taskRuns.start(ordinary, Capability.GENERAL_CHAT);
    expect(second.attempt).toBe(2);
    await expect(f.storage.taskRuns.delete(second.id)).resolves.toBeUndefined();
    await expect(f.storage.taskRuns.delete(terminal.id)).resolves.toBeUndefined();
    expect(await f.storage.taskRuns.listByTask(ordinary.id)).toEqual([]);
    // No continuation policy leaked into unbound semantics; the bound Task is still guarded.
    await expect(f.storage.taskRuns.start(f.task, Capability.GENERAL_CHAT))
      .rejects.toMatchObject({ code: 'CONTINUATION_GUARD_REQUIRED' });
  });
});
