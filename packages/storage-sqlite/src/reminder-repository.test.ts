import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { REMINDER_LIMITS, ReminderStatus, createReminderDraft, planFiringCompletion } from '@quoky/core';
import type { Reminder, ReminderDraft, ReminderFiringResult, ReminderRepository, ReminderSchedule } from '@quoky/core';
import { SqliteReminderRepository } from './reminder-repository';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from './migrations';
import { SqliteStorageProvider } from './index';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-reminders-'));
  dirs.push(dir);
  return join(dir, 'chunsik.db');
}

function repo(): { db: Database.Database; repository: SqliteReminderRepository } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, repository: new SqliteReminderRepository(db) };
}

const ORIGIN = { platform: 'discord', spaceId: 'g1', channelId: 'c1', userId: 'u1' };
const T0 = '2026-10-02T00:00:00.000Z';

function draft(
  id: string,
  options: { actorId?: string; firstFireAt?: string; schedule?: ReminderSchedule; body?: string } = {},
): ReminderDraft {
  const firstFireAt = options.firstFireAt ?? '2026-10-02T09:00:00.000Z';
  return createReminderDraft({
    id,
    actorId: options.actorId ?? 'actor-1',
    kind: 'TEXT',
    body: options.body ?? `body ${id}`,
    schedule: options.schedule ?? { type: 'ONCE', at: firstFireAt },
    timeZone: 'Asia/Seoul',
    origin: ORIGIN,
    firstFireAt,
    createdAt: T0,
  });
}

async function created(repository: ReminderRepository, value: ReminderDraft): Promise<Reminder> {
  const result = await repository.createWithinLimit(value, REMINDER_LIMITS.maxActivePerActor);
  if (result.status !== 'CREATED') throw new Error(`expected CREATED, got ${result.status}`);
  return result.reminder;
}

type RawRow = { id: string; actor_id: string; display_no: number; status: string; next_fire_at: string | null; data: string };
function rows(db: Database.Database): RawRow[] {
  return db.prepare('SELECT * FROM reminders ORDER BY id').all() as RawRow[];
}

/** Every mirror column equals the JSON `data` (next_fire_at in canonical UTC, NULL once terminal). */
function expectMirrorsConsistent(db: Database.Database): void {
  for (const row of rows(db)) {
    const data = JSON.parse(row.data) as Reminder;
    expect(row.id).toBe(data.id);
    expect(row.actor_id).toBe(data.actorId);
    expect(row.display_no).toBe(data.displayNo);
    expect(row.status).toBe(data.status);
    const active = data.status === ReminderStatus.SCHEDULED || data.status === ReminderStatus.FIRING;
    expect(row.next_fire_at).toBe(
      active && data.nextFireAt !== undefined ? new Date(Date.parse(data.nextFireAt)).toISOString() : null,
    );
  }
}

async function complete(
  repository: SqliteReminderRepository,
  reminder: Reminder,
  result: ReminderFiringResult,
  at: string,
  nextOccurrenceAt?: string,
) {
  const completion = planFiringCompletion(reminder, result, {
    at,
    ...(nextOccurrenceAt === undefined ? {} : { nextOccurrenceAt }),
  });
  return repository.completeFiring(reminder.id, reminder.firingAttemptId!, completion);
}

describe('SqliteReminderRepository — create, list, get (ADR-0101 D4/D9)', () => {
  it('assigns a monotonic display number per actor, independent across actors, never reused', async () => {
    const { db, repository } = repo();
    expect((await created(repository, draft('r1'))).displayNo).toBe(1);
    expect((await created(repository, draft('r2'))).displayNo).toBe(2);
    expect((await created(repository, draft('o1', { actorId: 'actor-2' }))).displayNo).toBe(1);
    expect(await repository.cancel('actor-1', 2, T0)).toMatchObject({ status: 'CANCELED' });
    // The highest number ever assigned is 2 (now CANCELED); the next is 3, never a reused 2.
    expect((await created(repository, draft('r3'))).displayNo).toBe(3);
    expect((await created(repository, draft('o2', { actorId: 'actor-2' }))).displayNo).toBe(2);
    expectMirrorsConsistent(db);
    db.close();
  });

  it('returns LIMIT_REACHED at 50 active reminders and writes nothing; FIRING counts, terminal does not', async () => {
    const { db, repository } = repo();
    for (let i = 1; i <= 50; i += 1) await created(repository, draft(`r${i}`));
    expect(await repository.createWithinLimit(draft('r51'), REMINDER_LIMITS.maxActivePerActor))
      .toEqual({ status: 'LIMIT_REACHED', activeCount: 50 });
    expect(rows(db)).toHaveLength(50);
    // Another actor is unaffected.
    expect(await repository.createWithinLimit(draft('o1', { actorId: 'actor-2' }), 50))
      .toMatchObject({ status: 'CREATED' });
    // A FIRING reminder still counts toward the limit.
    await repository.claimDue('2026-10-02T09:00:00.000Z', 1, 'attempt-1');
    expect(await repository.createWithinLimit(draft('r51'), 50)).toEqual({ status: 'LIMIT_REACHED', activeCount: 50 });
    // A terminal (CANCELED) reminder frees a slot.
    await repository.cancel('actor-1', 50, T0);
    const result = await repository.createWithinLimit(draft('r51'), 50);
    expect(result).toMatchObject({ status: 'CREATED', reminder: { displayNo: 51 } });
    db.close();
  });

  it('rejects an invalid limit or a non-SCHEDULED draft without writing', async () => {
    const { db, repository } = repo();
    await expect(repository.createWithinLimit(draft('r1'), -1)).rejects.toThrow('REMINDER_LIMIT_INVALID');
    await expect(repository.createWithinLimit(draft('r1'), 1.5)).rejects.toThrow('REMINDER_LIMIT_INVALID');
    await expect(repository.createWithinLimit({ ...draft('r1'), status: ReminderStatus.FIRING }, 50))
      .rejects.toThrow('REMINDER_DRAFT_INVALID');
    expect(rows(db)).toEqual([]);
    db.close();
  });

  it('round-trips the domain JSON and lists only the actor\'s active reminders ordered by number', async () => {
    const { db, repository } = repo();
    const first = await created(repository, draft('r1', { firstFireAt: '2026-10-05T00:00:00.000Z' }));
    await created(repository, draft('r2', { firstFireAt: '2026-10-03T00:00:00.000Z' }));
    await created(repository, draft('r3', { firstFireAt: '2026-10-04T00:00:00.000Z' }));
    await created(repository, draft('o1', { actorId: 'actor-2' }));
    await repository.cancel('actor-1', 3, T0);
    expect(await repository.getByDisplayNo('actor-1', 1)).toEqual(first);
    expect((await repository.listActiveByActor('actor-1')).map((r) => r.displayNo)).toEqual([1, 2]);
    expect((await repository.listActiveByActor('actor-2')).map((r) => r.id)).toEqual(['o1']);
    expect(await repository.listActiveByActor('nobody')).toEqual([]);
    db.close();
  });

  it('gets a reminder by number in any status, owner-scoped', async () => {
    const { db, repository } = repo();
    await created(repository, draft('r1'));
    await repository.cancel('actor-1', 1, T0);
    expect(await repository.getByDisplayNo('actor-1', 1)).toMatchObject({ id: 'r1', status: ReminderStatus.CANCELED });
    expect(await repository.getByDisplayNo('actor-2', 1)).toBeNull();
    expect(await repository.getByDisplayNo('actor-1', 2)).toBeNull();
    expect(await repository.getByDisplayNo('actor-1', 0)).toBeNull();
    db.close();
  });
});

describe('SqliteReminderRepository — cancel', () => {
  it('returns each cancel state and never touches another actor\'s reminder', async () => {
    const { db, repository } = repo();
    await created(repository, draft('r1'));
    await created(repository, draft('r2', { firstFireAt: '2026-10-02T08:00:00.000Z' }));
    await created(repository, draft('o1', { actorId: 'actor-2' }));

    const canceled = await repository.cancel('actor-1', 1, '2026-10-02T01:00:00.000Z');
    expect(canceled).toMatchObject({ status: 'CANCELED', reminder: { id: 'r1', status: ReminderStatus.CANCELED } });
    if (canceled.status === 'CANCELED') {
      expect(canceled.reminder.nextFireAt).toBeUndefined();
      expect(canceled.reminder.updatedAt).toBe('2026-10-02T01:00:00.000Z');
      expect(await repository.getByDisplayNo('actor-1', 1)).toEqual(canceled.reminder);
    }
    expect(await repository.cancel('actor-1', 1, T0)).toMatchObject({ status: 'ALREADY_FINAL', reminder: { id: 'r1' } });

    await repository.claimDue('2026-10-02T08:00:00.000Z', 10, 'attempt-1');
    expect(await repository.cancel('actor-1', 2, T0))
      .toMatchObject({ status: 'IN_FLIGHT', reminder: { id: 'r2', status: ReminderStatus.FIRING } });
    expect((await repository.getByDisplayNo('actor-1', 2))?.status).toBe(ReminderStatus.FIRING);

    expect(await repository.cancel('actor-1', 99, T0)).toEqual({ status: 'NOT_FOUND' });
    // actor-2's #1 exists, but actor-1 cannot reach it; and actor-2 cannot reach actor-1's #2.
    expect(await repository.cancel('actor-3', 1, T0)).toEqual({ status: 'NOT_FOUND' });
    expect(await repository.cancel('actor-2', 2, T0)).toEqual({ status: 'NOT_FOUND' });
    expect((await repository.getByDisplayNo('actor-2', 1))?.status).toBe(ReminderStatus.SCHEDULED);
    expectMirrorsConsistent(db);
    db.close();
  });
});

describe('SqliteReminderRepository — claimDue (due query, atomic SCHEDULED → FIRING)', () => {
  it('claims only due SCHEDULED reminders, earliest first, within the limit, and a second claim gets nothing', async () => {
    const { db, repository } = repo();
    await created(repository, draft('late', { firstFireAt: '2026-10-02T09:00:30.000Z' }));
    await created(repository, draft('b', { firstFireAt: '2026-10-02T08:00:00.000Z' }));
    await created(repository, draft('a', { firstFireAt: '2026-10-02T08:00:00.000Z' }));
    await created(repository, draft('first', { firstFireAt: '2026-10-02T07:00:00.000Z' }));
    await created(repository, draft('gone', { firstFireAt: '2026-10-02T06:00:00.000Z' }));
    await repository.cancel('actor-1', 5, T0);

    const now = '2026-10-02T09:00:00.000Z';
    const claimed = await repository.claimDue(now, 2, 'attempt-1');
    expect(claimed.map((r) => r.id)).toEqual(['first', 'a']);
    for (const reminder of claimed) {
      expect(reminder).toMatchObject({
        status: ReminderStatus.FIRING, firingAttemptId: 'attempt-1', firingStartedAt: now, updatedAt: now,
      });
      expect(await repository.getByDisplayNo('actor-1', reminder.displayNo)).toEqual(reminder);
    }
    expect((await repository.claimDue(now, 10, 'attempt-2')).map((r) => r.id)).toEqual(['b']);
    expect(await repository.claimDue(now, 10, 'attempt-3')).toEqual([]);
    expect(await repository.claimDue(now, 0, 'attempt-4')).toEqual([]);
    expect((await repository.listFiring()).map((r) => r.id).sort()).toEqual(['a', 'b', 'first']);
    expectMirrorsConsistent(db);
    db.close();
  });

  it('orders and compares due times by instant, whatever offset the domain value carries', async () => {
    const { db, repository } = repo();
    // 08:30+09:00 is 23:30Z the previous day: due before 2026-10-02T00:00Z.
    await created(repository, draft('offset', { firstFireAt: '2026-10-02T08:30:00+09:00' }));
    await created(repository, draft('utc', { firstFireAt: '2026-10-01T23:45:00.000Z' }));
    expect(rows(db).find((r) => r.id === 'offset')?.next_fire_at).toBe('2026-10-01T23:30:00.000Z');
    expect(await repository.claimDue('2026-10-01T23:00:00.000Z', 10, 'x')).toEqual([]);
    expect((await repository.claimDue('2026-10-02T09:00:00+09:00', 10, 'y')).map((r) => r.id)).toEqual(['offset', 'utc']);
    await expect(repository.claimDue('not-a-time', 10, 'z')).rejects.toThrow('REMINDER_INSTANT_INVALID');
    await expect(repository.claimDue(T0, -1, 'z')).rejects.toThrow('REMINDER_LIMIT_INVALID');
    expectMirrorsConsistent(db);
    db.close();
  });

  it('two connections on one database file: each due reminder is claimed by exactly one of them', async () => {
    const dbPath = tempDbPath();
    const dbA = new Database(dbPath, { timeout: 2000 });
    dbA.pragma('journal_mode = WAL');
    runMigrations(dbA);
    const dbB = new Database(dbPath, { timeout: 2000 });
    const a = new SqliteReminderRepository(dbA);
    const b = new SqliteReminderRepository(dbB);
    for (let i = 1; i <= 6; i += 1) await created(a, draft(`r${i}`, { firstFireAt: `2026-10-02T08:0${i}:00.000Z` }));

    const now = '2026-10-02T09:00:00.000Z';
    const [fromA, fromB] = await Promise.all([a.claimDue(now, 4, 'attempt-A'), b.claimDue(now, 4, 'attempt-B')]);
    const claimedIds = [...fromA, ...fromB].map((r) => r.id);
    expect(claimedIds.sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(new Set(claimedIds).size).toBe(6);
    const owner = new Map(rows(dbA).map((row) => [row.id, (JSON.parse(row.data) as Reminder).firingAttemptId]));
    for (const r of fromA) expect(owner.get(r.id)).toBe('attempt-A');
    for (const r of fromB) expect(owner.get(r.id)).toBe('attempt-B');
    expect(await a.claimDue(now, 10, 'attempt-C')).toEqual([]);
    expect(await b.claimDue(now, 10, 'attempt-D')).toEqual([]);
    dbA.close();
    dbB.close();
  });

  it('maps lock contention beyond the bounded wait to REMINDER_STORAGE_BUSY and writes nothing', async () => {
    const dbPath = tempDbPath();
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    runMigrations(holder);
    const holderRepo = new SqliteReminderRepository(holder);
    await created(holderRepo, draft('r1'));
    const contenderDb = new Database(dbPath, { timeout: 0 });
    const contender = new SqliteReminderRepository(contenderDb);
    holder.exec('BEGIN IMMEDIATE');
    try {
      await expect(contender.claimDue('2026-10-02T09:00:00.000Z', 10, 'attempt-1')).rejects.toThrow('REMINDER_STORAGE_BUSY');
      await expect(contender.createWithinLimit(draft('r2'), 50)).rejects.toThrow('REMINDER_STORAGE_BUSY');
      await expect(contender.cancel('actor-1', 1, T0)).rejects.toThrow('REMINDER_STORAGE_BUSY');
    } finally {
      holder.exec('ROLLBACK');
      contenderDb.close();
    }
    expect(rows(holder).map((r) => [r.id, r.status])).toEqual([['r1', ReminderStatus.SCHEDULED]]);
    holder.close();
  });
});

describe('SqliteReminderRepository — completeFiring (outcome recording, CAS)', () => {
  const NOW = '2026-10-02T09:00:00.000Z';

  async function firing(repository: SqliteReminderRepository, value: ReminderDraft, attemptId = 'attempt-1') {
    await created(repository, value);
    const [claimed] = await repository.claimDue(NOW, 10, attemptId);
    if (!claimed) throw new Error('expected a claim');
    return claimed;
  }

  it('SENT completes a ONCE reminder: terminal, out of the due index, never claimed again', async () => {
    const { db, repository } = repo();
    const reminder = await firing(repository, draft('r1'));
    const result = await complete(repository, reminder, { status: 'SENT', via: 'dm' }, '2026-10-02T09:00:05.000Z');
    expect(result).toMatchObject({
      status: 'COMPLETED',
      reminder: {
        status: ReminderStatus.COMPLETED,
        lastOutcome: { outcome: 'SENT', via: 'dm', occurrenceAt: '2026-10-02T09:00:00.000Z' },
      },
    });
    if (result.status === 'COMPLETED') {
      expect(result.reminder.firingAttemptId).toBeUndefined();
      expect(result.reminder.nextFireAt).toBeUndefined();
      expect(await repository.getByDisplayNo('actor-1', 1)).toEqual(result.reminder);
    }
    expect(await repository.listActiveByActor('actor-1')).toEqual([]);
    expect(await repository.claimDue('2027-01-01T00:00:00.000Z', 10, 'attempt-2')).toEqual([]);
    expectMirrorsConsistent(db);
    db.close();
  });

  it('rejects a stale attempt id, a non-FIRING reminder and an unknown id with CONFLICT, writing nothing', async () => {
    const { db, repository } = repo();
    const reminder = await firing(repository, draft('r1'));
    const completion = planFiringCompletion(reminder, { status: 'SENT', via: 'dm' }, { at: NOW });
    const before = rows(db);
    expect(await repository.completeFiring('r1', 'stale-attempt', completion)).toEqual({ status: 'CONFLICT' });
    expect(await repository.completeFiring('missing', 'attempt-1', completion)).toEqual({ status: 'CONFLICT' });
    expect(rows(db)).toEqual(before);
    expect(await repository.completeFiring('r1', 'attempt-1', completion)).toMatchObject({ status: 'COMPLETED' });
    // Completing twice: the reminder is no longer FIRING.
    expect(await repository.completeFiring('r1', 'attempt-1', completion)).toEqual({ status: 'CONFLICT' });
    await created(repository, draft('r2', { firstFireAt: '2026-10-03T00:00:00.000Z' }));
    expect(await repository.completeFiring('r2', 'attempt-1', completion)).toEqual({ status: 'CONFLICT' });
    db.close();
  });

  it('NOT_SENT{retryable} reschedules the same occurrence with 1/5/15-minute backoff, then FAILED', async () => {
    const { db, repository } = repo();
    let reminder = await firing(repository, draft('r1'));
    const notSent: ReminderFiringResult = { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true };
    let at = NOW;
    for (const [index, backoff] of [1, 5, 15].entries()) {
      const result = await complete(repository, reminder, notSent, at);
      const nextFireAt = new Date(Date.parse(at) + backoff * 60_000).toISOString();
      expect(result).toMatchObject({
        status: 'COMPLETED',
        reminder: {
          status: ReminderStatus.SCHEDULED, attempt: index + 1, occurrenceAt: '2026-10-02T09:00:00.000Z', nextFireAt,
        },
      });
      expect(rows(db)[0]?.next_fire_at).toBe(nextFireAt);
      // Not due before the backoff elapses; due exactly at it.
      expect(await repository.claimDue(new Date(Date.parse(nextFireAt) - 1).toISOString(), 10, 'early')).toEqual([]);
      const [again] = await repository.claimDue(nextFireAt, 10, `retry-${index + 1}`);
      if (!again) throw new Error('expected a retry claim');
      reminder = again;
      at = nextFireAt;
    }
    const final = await complete(repository, reminder, notSent, at);
    expect(final).toMatchObject({
      status: 'COMPLETED',
      reminder: { status: ReminderStatus.FAILED, attempt: 3, lastOutcome: { outcome: 'FAILED', reason: 'RATE_LIMITED' } },
    });
    expect(await repository.claimDue('2027-01-01T00:00:00.000Z', 10, 'never')).toEqual([]);
    expectMirrorsConsistent(db);
    db.close();
  });

  it('NOT_SENT{retryable: false} fails a ONCE reminder immediately', async () => {
    const { db, repository } = repo();
    const reminder = await firing(repository, draft('r1'));
    expect(await complete(repository, reminder, { status: 'NOT_SENT', reason: 'NOT_OWNER', retryable: false }, NOW))
      .toMatchObject({ status: 'COMPLETED', reminder: { status: ReminderStatus.FAILED } });
    expectMirrorsConsistent(db);
    db.close();
  });

  it('UNCERTAIN is terminal DELIVERY_UNCERTAIN for a ONCE reminder and is never claimed or resent', async () => {
    const { db, repository } = repo();
    const reminder = await firing(repository, draft('r1'));
    expect(await complete(repository, reminder, { status: 'UNCERTAIN', reason: 'TIMEOUT' }, NOW)).toMatchObject({
      status: 'COMPLETED',
      reminder: {
        status: ReminderStatus.DELIVERY_UNCERTAIN,
        lastOutcome: { outcome: 'DELIVERY_UNCERTAIN', reason: 'TIMEOUT' },
      },
    });
    expect(await repository.claimDue('2027-01-01T00:00:00.000Z', 10, 'never')).toEqual([]);
    expect(await repository.cancel('actor-1', 1, NOW)).toMatchObject({ status: 'ALREADY_FINAL' });
    expectMirrorsConsistent(db);
    db.close();
  });

  it('a recurring reminder moves to its next occurrence with the outcome recorded and stays active', async () => {
    const { db, repository } = repo();
    const reminder = await firing(
      repository, draft('daily', { schedule: { type: 'DAILY', time: { hour: 18, minute: 0 } } }),
    );
    const next = '2026-10-03T09:00:00.000Z';
    const result = await complete(repository, reminder, { status: 'UNCERTAIN', reason: 'NETWORK_ERROR' }, NOW, next);
    expect(result).toMatchObject({
      status: 'COMPLETED',
      reminder: {
        status: ReminderStatus.SCHEDULED, occurrenceAt: next, nextFireAt: next, attempt: 0,
        lastOutcome: { outcome: 'DELIVERY_UNCERTAIN', occurrenceAt: '2026-10-02T09:00:00.000Z' },
      },
    });
    expect(await repository.claimDue('2026-10-03T08:59:59.999Z', 10, 'early')).toEqual([]);
    expect((await repository.claimDue(next, 10, 'next-day')).map((r) => r.id)).toEqual(['daily']);
    expectMirrorsConsistent(db);
    db.close();
  });
});

describe('SqliteReminderRepository — startup recovery of FIRING rows', () => {
  it('a FIRING row survives a crash, is listed at startup and is recorded DELIVERY_UNCERTAIN, never resent', async () => {
    const dbPath = tempDbPath();
    const before = new SqliteStorageProvider({ dbPath });
    await before.init();
    await created(before.reminders, draft('r1'));
    await created(before.reminders, draft('r2', { firstFireAt: '2026-10-03T00:00:00.000Z' }));
    const [claimed] = await before.reminders.claimDue('2026-10-02T09:00:00.000Z', 10, 'attempt-before-crash');
    expect(claimed?.id).toBe('r1');
    await before.close(); // the process dies before completeFiring

    const after = new SqliteStorageProvider({ dbPath });
    await after.init();
    const firingAtStartup = await after.reminders.listFiring();
    expect(firingAtStartup.map((r) => [r.id, r.status, r.firingAttemptId]))
      .toEqual([['r1', ReminderStatus.FIRING, 'attempt-before-crash']]);
    const recoveredAt = '2026-10-02T09:30:00.000Z';
    for (const reminder of firingAtStartup) {
      const completion = planFiringCompletion(reminder, { status: 'UNCERTAIN', reason: 'INTERRUPTED' }, { at: recoveredAt });
      expect(await after.reminders.completeFiring(reminder.id, reminder.firingAttemptId!, completion)).toMatchObject({
        status: 'COMPLETED',
        reminder: {
          status: ReminderStatus.DELIVERY_UNCERTAIN,
          lastOutcome: { outcome: 'DELIVERY_UNCERTAIN', reason: 'INTERRUPTED', recordedAt: recoveredAt },
        },
      });
    }
    expect(await after.reminders.listFiring()).toEqual([]);
    expect(await after.reminders.claimDue('2027-01-01T00:00:00.000Z', 10, 'after')).toEqual([
      expect.objectContaining({ id: 'r2' }),
    ]);
    await after.close();
  });

  it('a SqliteStorageProvider opened on a v12 database migrates to the latest version (13+) and exposes a working reminders store', async () => {
    const dbPath = tempDbPath();
    const seed = new Database(dbPath);
    runMigrations(seed, MIGRATIONS.slice(0, 12));
    seed.prepare(`INSERT INTO sessions (id, channel_id, status, data) VALUES ('s1', 'c1', 'ACTIVE', '{}')`).run();
    seed.close();

    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    expect(storage.reminders).toBeInstanceOf(SqliteReminderRepository);
    expect(await storage.reminders.createWithinLimit(draft('r1'), 50)).toMatchObject({
      status: 'CREATED', reminder: { displayNo: 1 },
    });
    await storage.close();

    const check = new Database(dbPath, { readonly: true });
    expect(Number(check.pragma('user_version', { simple: true }))).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
    expect(check.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's1' }]);
    expect(check.prepare('SELECT id, display_no FROM reminders').all()).toEqual([{ id: 'r1', display_no: 1 }]);
    check.close();
  });
});
