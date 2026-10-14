import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { REMINDER_LIMITS, ReminderStatus, createReminderDraft, reactivateReminder } from '@quoky/core';
import type { Reminder, ReminderDraft, ReminderRepository } from '@quoky/core';
import { SqliteReminderRepository } from './reminder-repository';
import { runMigrations } from './migrations';

// ADR-0120 amendment A6, ratification record B: the one additive CAS method (undo of a cancel), no migration.

const ORIGIN = { platform: 'discord', channelId: 'c1', userId: 'u1' };
const T0 = '2026-10-14T00:00:00.000Z';
const LATER = '2026-10-14T01:00:00.000Z';

function repo(): { db: Database.Database; repository: SqliteReminderRepository } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, repository: new SqliteReminderRepository(db) };
}

function draft(id: string, actorId = 'actor-1'): ReminderDraft {
  const at = '2026-10-15T00:00:00.000Z';
  return createReminderDraft({ id, actorId, kind: 'TEXT', body: `body ${id}`, schedule: { type: 'ONCE', at }, timeZone: 'Asia/Seoul', origin: ORIGIN, firstFireAt: at, createdAt: T0 });
}

async function canceledReminder(repository: ReminderRepository, id: string, actorId = 'actor-1'): Promise<Reminder> {
  const created = await repository.createWithinLimit(draft(id, actorId), REMINDER_LIMITS.maxActivePerActor);
  if (created.status !== 'CREATED') throw new Error('not created');
  const canceled = await repository.cancel(actorId, created.reminder.displayNo, T0);
  if (canceled.status !== 'CANCELED') throw new Error('not canceled');
  return canceled.reminder;
}

describe('SqliteReminderRepository.reactivate (A6 undo path only)', () => {
  it('reactivates the SAME row (same id and #N) with a compare-and-set on CANCELED and the version', async () => {
    const { db, repository } = repo();
    const canceled = await canceledReminder(repository, 'r1');
    const next = reactivateReminder(canceled, LATER, '2026-10-15T00:00:00.000Z');
    const result = await repository.reactivate('actor-1', next, canceled.updatedAt, REMINDER_LIMITS.maxActivePerActor);
    expect(result).toMatchObject({ status: 'REACTIVATED', reminder: { id: 'r1', displayNo: 1, status: ReminderStatus.SCHEDULED } });
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get('r1') as { status: string; display_no: number; next_fire_at: string };
    expect(row).toMatchObject({ status: 'SCHEDULED', display_no: 1, next_fire_at: '2026-10-15T00:00:00.000Z' });
    expect(await repository.listActiveByActor('actor-1')).toHaveLength(1);
  });

  it('loses the CAS to a concurrent change (another version) and to a row that is no longer CANCELED; writes nothing', async () => {
    const { repository } = repo();
    const canceled = await canceledReminder(repository, 'r1');
    const next = reactivateReminder(canceled, LATER, '2026-10-15T00:00:00.000Z');
    expect(await repository.reactivate('actor-1', next, '2026-10-13T00:00:00.000Z', 50)).toMatchObject({ status: 'CHANGED' });
    expect(await repository.reactivate('actor-1', next, canceled.updatedAt, 50)).toMatchObject({ status: 'REACTIVATED' });
    expect(await repository.reactivate('actor-1', next, canceled.updatedAt, 50)).toMatchObject({ status: 'CHANGED' });
  });

  it('is owner-scoped and keeps the active limit', async () => {
    const { repository } = repo();
    const canceled = await canceledReminder(repository, 'r1');
    const next = reactivateReminder(canceled, LATER, '2026-10-15T00:00:00.000Z');
    expect(await repository.reactivate('actor-2', { ...next, actorId: 'actor-2' }, canceled.updatedAt, 50)).toMatchObject({ status: 'NOT_FOUND' });
    await repository.createWithinLimit(draft('r2'), 50);
    expect(await repository.reactivate('actor-1', next, canceled.updatedAt, 1)).toEqual({ status: 'LIMIT_REACHED', activeCount: 1 });
  });

  it('refuses a value that is not a SCHEDULED reactivation of that actor', async () => {
    const { repository } = repo();
    const canceled = await canceledReminder(repository, 'r1');
    await expect(repository.reactivate('actor-1', canceled, canceled.updatedAt, 50)).rejects.toThrow('REMINDER_REACTIVATION_INVALID');
  });
});
