import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  Capability,
  IntentType,
  RiskLevel,
  TaskRunStatus,
  TaskStatus,
} from '@quoky/core';
import type { Task } from '@quoky/core';
import { SqliteStorageProvider } from './index';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from './migrations';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-taskrun-start-'));
  dirs.push(dir);
  return join(dir, 'chunsik.db');
}

async function freshStore(): Promise<{ store: SqliteStorageProvider; dbPath: string }> {
  const dbPath = tempDbPath();
  const store = new SqliteStorageProvider({ dbPath });
  await store.init();
  return { store, dbPath };
}

function runningTask(overrides: Partial<Task> = {}): Task {
  const timestamp = '2026-09-21T00:00:00.000Z';
  return {
    id: 'task-1',
    title: 'atomic start',
    description: 'atomic start',
    status: TaskStatus.RUNNING,
    intent: {
      type: IntentType.CHAT,
      capability: Capability.GENERAL_CHAT,
      confidence: 1,
      requiresWork: true,
      summary: 'atomic start',
    },
    riskLevel: RiskLevel.LOW,
    context: { platform: 'discord', channelId: 'channel', userId: 'user' },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('M3E-5 atomic TaskRun start — disposable SQLite', () => {
  it('starts the first attempt with a canonical STARTED run', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);

    const run = await store.taskRuns.start(task, Capability.GENERAL_CHAT);

    expect(run.taskId).toBe(task.id);
    expect(run.attempt).toBe(1);
    expect(run.status).toBe(TaskRunStatus.STARTED);
    expect(run.capability).toBe(Capability.GENERAL_CHAT);
    expect(run.artifactIds).toEqual([]);
    expect(typeof run.startedAt).toBe('string');
    expect(run.id).toMatch(/.+/);
    expect(run.finishedAt).toBeUndefined();

    expect(await store.taskRuns.get(run.id)).toEqual(run);
    await store.close();
  });

  it('allocates the next ordinal from the greatest persisted attempt, not the row count', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);

    const first = await store.taskRuns.start(task, Capability.GENERAL_CHAT);
    const second = await store.taskRuns.start(task, Capability.CODE_IMPLEMENTATION);

    expect([first.attempt, second.attempt]).toEqual([1, 2]);
    expect(first.id).not.toBe(second.id);

    // Delete the earliest run — the next attempt must still advance beyond the max, never reuse gaps.
    await store.taskRuns.delete(first.id);
    const third = await store.taskRuns.start(task, Capability.GENERAL_CHAT);
    expect(third.attempt).toBe(3);
    await store.close();
  });

  it('fails closed on a missing canonical Task and writes nothing', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    // Task is NOT persisted.
    await expect(store.taskRuns.start(task, Capability.GENERAL_CHAT)).rejects.toThrow(
      'TASK_RUN_START_INVALID_OR_STALE_TASK',
    );
    expect(await store.taskRuns.listByTask(task.id)).toEqual([]);
    await store.close();
  });

  it('fails closed on a non-RUNNING Task', async () => {
    const { store } = await freshStore();
    const task = runningTask({ status: TaskStatus.PENDING });
    await store.tasks.save(task);
    await expect(store.taskRuns.start(task, Capability.GENERAL_CHAT)).rejects.toThrow(
      'TASK_RUN_START_INVALID_OR_STALE_TASK',
    );
    expect(await store.taskRuns.listByTask(task.id)).toEqual([]);
    await store.close();
  });

  it('fails closed on a stale Task snapshot that no longer matches persisted state', async () => {
    const { store } = await freshStore();
    const persisted = runningTask();
    await store.tasks.save(persisted);
    // Caller holds a divergent snapshot (different title) of the same id.
    const stale = runningTask({ title: 'divergent' });
    await expect(store.taskRuns.start(stale, Capability.GENERAL_CHAT)).rejects.toThrow(
      'TASK_RUN_START_INVALID_OR_STALE_TASK',
    );
    expect(await store.taskRuns.listByTask(persisted.id)).toEqual([]);
    await store.close();
  });

  it('fails closed on an unknown capability', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);
    await expect(
      store.taskRuns.start(task, 'NOT_A_CAPABILITY' as Capability),
    ).rejects.toThrow('TASK_RUN_START_INVALID_OR_STALE_TASK');
    expect(await store.taskRuns.listByTask(task.id)).toEqual([]);
    await store.close();
  });

  it('preserves completeRun/failRun update semantics after an atomic start', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);
    const run = await store.taskRuns.start(task, Capability.GENERAL_CHAT);

    const completed = { ...run, status: TaskRunStatus.SUCCEEDED, finishedAt: '2026-09-21T00:00:01.000Z', durationMs: 1000 };
    await store.taskRuns.save(completed);
    expect(await store.taskRuns.get(run.id)).toEqual(completed);
    await store.close();
  });

  it('rejects mutating the immutable start identity on update', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);
    const run = await store.taskRuns.start(task, Capability.GENERAL_CHAT);

    // Attempt to overwrite the immutable attempt ordinal via a save().
    await expect(
      store.taskRuns.save({ ...run, attempt: 99 }),
    ).rejects.toThrow(/TASK_RUN_START_IDENTITY_IMMUTABLE/);
    // Original row is intact.
    expect((await store.taskRuns.get(run.id))?.attempt).toBe(1);
    await store.close();
  });

  it('enforces (task_id, attempt) uniqueness at the storage layer', async () => {
    const { store } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);
    const run = await store.taskRuns.start(task, Capability.GENERAL_CHAT);

    // A second, distinct run id claiming the same ordinal must be rejected by the unique index.
    await expect(
      store.taskRuns.save({ ...run, id: 'duplicate-ordinal' }),
    ).rejects.toThrow();
    await store.close();
  });

  it('allocates distinct ordinals across independent SQLite connections (real concurrency)', async () => {
    const { store, dbPath } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);

    // Two independent providers over the same file — the model that will exist under multiple processes.
    const storeB = new SqliteStorageProvider({ dbPath });
    await storeB.init();

    const a = await store.taskRuns.start(task, Capability.GENERAL_CHAT);
    const b = await storeB.taskRuns.start(task, Capability.CODE_IMPLEMENTATION);

    expect(new Set([a.attempt, b.attempt])).toEqual(new Set([1, 2]));
    expect(a.id).not.toBe(b.id);

    const reloaded = await store.taskRuns.listByTask(task.id);
    expect(reloaded.map((r) => r.attempt)).toEqual([1, 2]);
    expect(new Set(reloaded.map((r) => r.id)).size).toBe(2);

    await storeB.close();
    await store.close();
  });

  it('appends unique ordinals after existing runs across connections', async () => {
    const { store, dbPath } = await freshStore();
    const task = runningTask();
    await store.tasks.save(task);
    await store.taskRuns.start(task, Capability.GENERAL_CHAT); // attempt 1
    await store.taskRuns.start(task, Capability.GENERAL_CHAT); // attempt 2

    const storeB = new SqliteStorageProvider({ dbPath });
    await storeB.init();
    const next = await storeB.taskRuns.start(task, Capability.GENERAL_CHAT);
    const nextB = await store.taskRuns.start(task, Capability.GENERAL_CHAT);

    expect(new Set([next.attempt, nextB.attempt])).toEqual(new Set([3, 4]));
    const all = await store.taskRuns.listByTask(task.id);
    expect(all.map((r) => r.attempt)).toEqual([1, 2, 3, 4]);
    await storeB.close();
    await store.close();
  });
});

describe('M3E-5 migration v11 — attempt identity enforcement', () => {
  it('migrates a v10 DB with valid history additively to v11', () => {
    const db = new Database(':memory:');
    try {
      for (const m of MIGRATIONS.filter((m) => m.version <= 10)) m.up(db);
      db.pragma('user_version = 10');
      db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)').run(
        'run-1',
        'task-1',
        JSON.stringify({ id: 'run-1', taskId: 'task-1', attempt: 1 }),
      );
      db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)').run(
        'run-2',
        'task-1',
        JSON.stringify({ id: 'run-2', taskId: 'task-1', attempt: 2 }),
      );
      expect(runMigrations(db)).toEqual({
        from: 10, to: LATEST_SCHEMA_VERSION, applied: MIGRATIONS.filter((m) => m.version > 10).map((m) => m.version),
      });
      expect(runMigrations(db).applied).toEqual([]);
      const indexes = (db.pragma('index_list(task_runs)') as { name: string }[]).map((x) => x.name);
      expect(indexes).toContain('task_runs_task_attempt');
      // Historical rows preserved unchanged (ids and ordinals intact).
      expect(db.prepare("SELECT json_extract(data,'$.attempt') a FROM task_runs ORDER BY a").all())
        .toEqual([{ a: 1 }, { a: 2 }]);
    } finally {
      db.close();
    }
  });

  it('fails closed on malformed historical attempt values without renumbering', () => {
    const db = new Database(':memory:');
    try {
      for (const m of MIGRATIONS.filter((m) => m.version <= 10)) m.up(db);
      db.pragma('user_version = 10');
      db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)').run(
        'run-1',
        'task-1',
        JSON.stringify({ id: 'run-1', taskId: 'task-1', attempt: 0 }),
      );
      expect(() => runMigrations(db)).toThrow('TASK_RUN_MIGRATION_INVALID_HISTORY');
      // Migration aborted transactionally at v10; no unique index installed.
      const indexes = (db.pragma('index_list(task_runs)') as { name: string }[]).map((x) => x.name);
      expect(indexes).not.toContain('task_runs_task_attempt');
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(10);
    } finally {
      db.close();
    }
  });

  it('fails closed on duplicate historical (task_id, attempt) ordinals', () => {
    const db = new Database(':memory:');
    try {
      for (const m of MIGRATIONS.filter((m) => m.version <= 10)) m.up(db);
      db.pragma('user_version = 10');
      db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)').run(
        'run-1',
        'task-1',
        JSON.stringify({ id: 'run-1', taskId: 'task-1', attempt: 1 }),
      );
      db.prepare('INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)').run(
        'run-2',
        'task-1',
        JSON.stringify({ id: 'run-2', taskId: 'task-1', attempt: 1 }),
      );
      expect(() => runMigrations(db)).toThrow();
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(10);
    } finally {
      db.close();
    }
  });
});
