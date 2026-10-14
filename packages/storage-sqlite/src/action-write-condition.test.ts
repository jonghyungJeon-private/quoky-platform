import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { REMINDER_LIMITS, WorkItemStatus, createReminderDraft, reactivateReminder, type WorkItem } from '@quoky/core';
import { SqliteReminderRepository } from './reminder-repository';
import { runMigrations } from './migrations';
import { SqliteStorageProvider } from './index';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-0120 amendment A6-D3: the action switch is read from the actor row INSIDE the write's IMMEDIATE transaction, for
// every A6 store write (work items and reminders). A stopped switch (or a missing actor) writes nothing.

const T0 = '2026-10-14T00:00:00.000Z';
const condition = { actionSwitchOf: 'actor-1' };

function setSwitch(db: Database.Database, state: 'running' | 'stopped' | null): void {
  const metadata = state === null ? {} : { 'quoky.actionSwitch': { state, at: T0 } };
  db.prepare('INSERT INTO actors (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run('actor-1', JSON.stringify({ id: 'actor-1', displayName: 'Owner', identities: [], createdAt: T0, metadata }));
}

describe('reminder writes with a condition', () => {
  it('create, cancel and reactivate write nothing while stopped and proceed while running', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repository = new SqliteReminderRepository(db);
    const at = '2026-10-15T00:00:00.000Z';
    const draft = createReminderDraft({ id: 'r1', actorId: 'actor-1', kind: 'TEXT', body: '물', schedule: { type: 'ONCE', at }, timeZone: 'Asia/Seoul', origin: { platform: 'p', channelId: 'c' }, firstFireAt: at, createdAt: T0 });
    setSwitch(db, 'stopped');
    expect(await repository.createWithinLimit(draft, REMINDER_LIMITS.maxActivePerActor, condition)).toEqual({ status: 'STOPPED' });
    expect(await repository.listActiveByActor('actor-1')).toHaveLength(0);
    setSwitch(db, null);
    expect(await repository.createWithinLimit(draft, REMINDER_LIMITS.maxActivePerActor, condition)).toMatchObject({ status: 'CREATED' });
    setSwitch(db, 'stopped');
    expect(await repository.cancel('actor-1', 1, T0, condition)).toEqual({ status: 'STOPPED' });
    expect(await repository.cancel('actor-1', 1, T0)).toMatchObject({ status: 'CANCELED' });
    const canceled = (await repository.getByDisplayNo('actor-1', 1))!;
    const next = reactivateReminder(canceled, '2026-10-14T01:00:00.000Z', at);
    expect(await repository.reactivate('actor-1', next, canceled.updatedAt, 50, condition)).toEqual({ status: 'STOPPED' });
    setSwitch(db, 'running');
    expect(await repository.reactivate('actor-1', next, canceled.updatedAt, 50, condition)).toMatchObject({ status: 'REACTIVATED' });
    db.prepare('DELETE FROM actors').run();
    expect(await repository.cancel('actor-1', 1, T0, condition)).toEqual({ status: 'STOPPED' });
  });
});

describe('work item saveIf', () => {
  it('saves only while the actor switch runs, in one transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-a6-cond-'));
    try {
      const storage = new SqliteStorageProvider({ dbPath: join(dir, 'db.sqlite') });
      await storage.init();
      const db = (storage as unknown as { db: Database.Database }).db;
      const item: WorkItem = { id: 'w1', actorId: 'actor-1', title: '보고서', resourceRefs: [], status: WorkItemStatus.ACTIVE, origin: 'conversation', createdAt: T0, updatedAt: T0 };
      setSwitch(db, 'stopped');
      expect(await storage.workItems.saveIf?.(item, condition)).toBeNull();
      expect(await storage.workItems.get('w1')).toBeNull();
      setSwitch(db, 'running');
      expect(await storage.workItems.saveIf?.(item, condition)).toEqual(item);
      expect(await storage.workItems.get('w1')).toMatchObject({ id: 'w1' });
      await storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
