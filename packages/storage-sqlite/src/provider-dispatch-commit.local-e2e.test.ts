import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Capability, IntentType, ProviderDispatchCommitCoordinator, ProviderDispatchState,
  TaskManager, TaskRunStatus, TaskStatus } from '@quoky/core';
import { SqliteStorageProvider } from './index';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-dispatch-'));
  const dbPath = join(dir, 'test.db');
  const storage = new SqliteStorageProvider({ dbPath });
  await storage.init();
  const tasks = new TaskManager(storage);
  let task = await tasks.createTask({ type: IntentType.CHAT, capability: Capability.GENERAL_CHAT,
    confidence: 1, requiresWork: true, summary: 'test' },
  { platform: 'test', channelId: 'channel', userId: 'user' }, { requestText: 'test' });
  task = await tasks.transition(task, TaskStatus.PLANNING);
  task = await tasks.transition(task, TaskStatus.RUNNING);
  const close = async () => { await storage.close(); rmSync(dir, { recursive: true, force: true }); };
  return { storage, tasks, task, dbPath, close };
}

describe('R3-C2B-I2-1 durable first dispatch boundary', () => {
  it('starts ordinary runs PRE_DISPATCH and admits exactly one concurrent commit', async () => {
    const f = await fixture();
    try {
      const run = await f.tasks.startRun(f.task, Capability.GENERAL_CHAT);
      expect(run.dispatchState).toBe(ProviderDispatchState.PRE_DISPATCH);
      expect((await f.storage.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.PRE_DISPATCH);
      const coordinator = new ProviderDispatchCommitCoordinator(f.storage.taskRuns);
      const competing = new SqliteStorageProvider({ dbPath: f.dbPath });
      await competing.init();
      let attempts;
      try {
        attempts = await Promise.allSettled([coordinator.commit(run.id, run.id),
          new ProviderDispatchCommitCoordinator(competing.taskRuns).commit(run.id, run.id)]);
      } finally { await competing.close(); }
      expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
      expect((await f.storage.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.DISPATCH_COMMITTED);
      // A stale lifecycle snapshot cannot erase the durable marker.
      await f.tasks.completeRun(run, { artifactIds: [] });
      expect((await f.storage.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.DISPATCH_COMMITTED);
    } finally { await f.close(); }
  });

  it('rejects wrong identity, terminal state and independent re-entry before any effect', async () => {
    const f = await fixture();
    try {
      const run = await f.tasks.startRun(f.task, Capability.GENERAL_CHAT);
      const coordinator = new ProviderDispatchCommitCoordinator(f.storage.taskRuns);
      let effects = 0;
      const dispatch = async (id: string, executionId = id) => {
        await coordinator.commit(id, executionId);
        effects++;
      };
      await expect(dispatch(run.id, 'wrong')).rejects.toThrow();
      expect(effects).toBe(0);
      await dispatch(run.id);
      expect(effects).toBe(1);
      await expect(dispatch(run.id)).rejects.toThrow();
      expect(effects).toBe(1);
      const persisted = await f.storage.taskRuns.get(run.id);
      expect(persisted?.status).toBe(TaskRunStatus.STARTED);
      expect(persisted?.dispatchState).toBe(ProviderDispatchState.DISPATCH_COMMITTED);
      await f.tasks.completeRun(run, { artifactIds: [] });
      await expect(dispatch(run.id)).rejects.toThrow();
    } finally { await f.close(); }
  });

  it('rejects a terminal PRE_DISPATCH run', async () => {
    const f = await fixture();
    try {
      const run = await f.tasks.startRun(f.task, Capability.GENERAL_CHAT);
      await f.tasks.failRun(run, 'pre-dispatch failure');
      expect((await f.storage.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.PRE_DISPATCH);
      await expect(new ProviderDispatchCommitCoordinator(f.storage.taskRuns).commit(run.id, run.id)).rejects.toThrow();
    } finally { await f.close(); }
  });

  it('decodes ambiguous history as LEGACY_UNKNOWN and provider-associated history as committed', async () => {
    const f = await fixture();
    try {
      const run = await f.tasks.startRun(f.task, Capability.GENERAL_CHAT);
      const raw = new Database(f.dbPath);
      try {
        const ambiguous = { ...run } as Partial<typeof run>;
        delete ambiguous.dispatchState;
        raw.prepare('UPDATE task_runs SET data = ? WHERE id = ?').run(JSON.stringify(ambiguous), run.id);
      } finally { raw.close(); }
      expect((await f.storage.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.LEGACY_UNKNOWN);
      expect((await f.storage.taskRuns.listByTask(f.task.id))[0]?.dispatchState).toBe(ProviderDispatchState.LEGACY_UNKNOWN);
      await expect(new ProviderDispatchCommitCoordinator(f.storage.taskRuns).commit(run.id, run.id)).rejects.toThrow();
      const associated = new Database(f.dbPath);
      try {
        const row = associated.prepare('SELECT data FROM task_runs WHERE id = ?').get(run.id) as { data: string };
        associated.prepare('UPDATE task_runs SET data = ? WHERE id = ?')
          .run(JSON.stringify({ ...JSON.parse(row.data), providerId: 'historical-provider' }), run.id);
      } finally { associated.close(); }
      expect((await f.storage.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.DISPATCH_COMMITTED);
    } finally { await f.close(); }
  });

  it('commits before effect with no transaction held across the effect', async () => {
    const f = await fixture();
    try {
      const run = await f.tasks.startRun(f.task, Capability.GENERAL_CHAT);
      const coordinator = new ProviderDispatchCommitCoordinator(f.storage.taskRuns);
      await coordinator.commit(run.id, run.id);
      // Simulate a crash window after durable commit and before any Provider effect.
      await f.storage.close();
      const second = new SqliteStorageProvider({ dbPath: f.dbPath, busyTimeoutMs: 0 });
      await second.init();
      try {
        expect((await second.taskRuns.get(run.id))?.dispatchState).toBe(ProviderDispatchState.DISPATCH_COMMITTED);
        await second.taskRuns.save({ ...(await second.taskRuns.get(run.id))!, metadata: { observed: true } });
      } finally { await second.close(); }
    } finally { await f.close(); }
  });
});
