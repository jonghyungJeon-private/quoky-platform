import type Database from 'better-sqlite3';
import {
  ReminderStatus,
  applyFiringCompletion,
  cancelReminder,
  claimReminder,
  isActiveReminderStatus,
} from '@quoky/core';
import type {
  CancelReminderResult,
  CompleteFiringResult,
  CreateReminderResult,
  Id,
  IsoTimestamp,
  Reminder,
  ReminderDraft,
  ReminderFiringCompletion,
  ReminderRepository,
} from '@quoky/core';

type Db = Database.Database;

type ReminderRow = {
  id: string;
  actor_id: string;
  display_no: number;
  status: string;
  next_fire_at: string | null;
  data: string;
};

/** Adapter-owned driver translation (ADR-0089): Core never sees driver codes, classes or messages. */
function isLockContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/**
 * The indexed `next_fire_at` column holds the canonical UTC form (`toISOString`), so lexical order is time order
 * whatever offset the domain value was written with. Throws on an unparseable instant.
 */
function canonicalInstant(value: IsoTimestamp): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('REMINDER_INSTANT_INVALID');
  return new Date(ms).toISOString();
}

function toReminder(row: ReminderRow): Reminder {
  return JSON.parse(row.data) as Reminder;
}

/**
 * SQLite owner reminder store (ADR-0101 D4/D9, schema v13). The JSON `data` column is the domain mapping source;
 * `actor_id`, `display_no`, `status` and `next_fire_at` mirror it on every write (one write helper) and serve the
 * `reminders_due` / `reminders_actor` indexes and the CAS predicates. `createWithinLimit`, `cancel`, `claimDue`
 * and `completeFiring` are each one IMMEDIATE transaction; transitions are computed by the pure domain functions.
 * Lock contention beyond the configured bounded wait (`busyTimeoutMs`) surfaces as `REMINDER_STORAGE_BUSY`; there
 * is no retry here. Not part of `StorageProvider`.
 */
export class SqliteReminderRepository implements ReminderRepository {
  constructor(private readonly db: Db) {}

  async createWithinLimit(draft: ReminderDraft, maxActive: number): Promise<CreateReminderResult> {
    if (!Number.isSafeInteger(maxActive) || maxActive < 0) throw new Error('REMINDER_LIMIT_INVALID');
    if (draft.status !== ReminderStatus.SCHEDULED || draft.nextFireAt === undefined) {
      throw new Error('REMINDER_DRAFT_INVALID');
    }
    const nextFireAt = canonicalInstant(draft.nextFireAt);
    return this.immediate((): CreateReminderResult => {
      const activeCount = this.countActive(draft.actorId);
      if (activeCount >= maxActive) return { status: 'LIMIT_REACHED', activeCount };
      const { max } = this.db.prepare('SELECT MAX(display_no) AS max FROM reminders WHERE actor_id = ?')
        .get(draft.actorId) as { max: number | null };
      const reminder: Reminder = { ...draft, displayNo: (max ?? 0) + 1 };
      this.db.prepare(
        `INSERT INTO reminders (id, actor_id, display_no, status, next_fire_at, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(reminder.id, reminder.actorId, reminder.displayNo, reminder.status, nextFireAt, JSON.stringify(reminder));
      return { status: 'CREATED', reminder };
    });
  }

  async listActiveByActor(actorId: Id): Promise<Reminder[]> {
    const rows = this.db.prepare(
      `SELECT * FROM reminders WHERE actor_id = ? AND status IN (?, ?) ORDER BY display_no ASC`,
    ).all(actorId, ReminderStatus.SCHEDULED, ReminderStatus.FIRING) as ReminderRow[];
    return rows.map(toReminder);
  }

  async getByDisplayNo(actorId: Id, displayNo: number): Promise<Reminder | null> {
    const row = this.findByDisplayNo(actorId, displayNo);
    return row ? toReminder(row) : null;
  }

  async cancel(actorId: Id, displayNo: number, at: IsoTimestamp): Promise<CancelReminderResult> {
    return this.immediate((): CancelReminderResult => {
      const row = this.findByDisplayNo(actorId, displayNo);
      if (!row) return { status: 'NOT_FOUND' };
      const current = toReminder(row);
      if (row.status === ReminderStatus.FIRING) return { status: 'IN_FLIGHT', reminder: current };
      if (row.status !== ReminderStatus.SCHEDULED) return { status: 'ALREADY_FINAL', reminder: current };
      const canceled = cancelReminder(current, at);
      this.write(canceled, ReminderStatus.SCHEDULED);
      return { status: 'CANCELED', reminder: canceled };
    });
  }

  async claimDue(now: IsoTimestamp, limit: number, attemptId: Id): Promise<Reminder[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('REMINDER_LIMIT_INVALID');
    if (limit === 0) return [];
    const dueBy = canonicalInstant(now);
    return this.immediate((): Reminder[] => {
      const rows = this.db.prepare(
        `SELECT * FROM reminders WHERE status = ? AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at ASC, id ASC LIMIT ?`,
      ).all(ReminderStatus.SCHEDULED, dueBy, limit) as ReminderRow[];
      return rows.map((row) => {
        const claimed = claimReminder(toReminder(row), attemptId, now);
        this.write(claimed, ReminderStatus.SCHEDULED);
        return claimed;
      });
    });
  }

  async completeFiring(
    id: Id, attemptId: Id, completion: ReminderFiringCompletion,
  ): Promise<CompleteFiringResult> {
    return this.immediate((): CompleteFiringResult => {
      const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
      if (!row || row.status !== ReminderStatus.FIRING) return { status: 'CONFLICT' };
      const current = toReminder(row);
      if (current.firingAttemptId !== attemptId) return { status: 'CONFLICT' };
      const next = applyFiringCompletion(current, attemptId, completion);
      this.write(next, ReminderStatus.FIRING, attemptId);
      return { status: 'COMPLETED', reminder: next };
    });
  }

  async listFiring(): Promise<Reminder[]> {
    const rows = this.db.prepare(
      `SELECT * FROM reminders WHERE status = ? ORDER BY next_fire_at ASC, id ASC`,
    ).all(ReminderStatus.FIRING) as ReminderRow[];
    return rows.map(toReminder);
  }

  private countActive(actorId: Id): number {
    const { count } = this.db.prepare(
      'SELECT COUNT(*) AS count FROM reminders WHERE actor_id = ? AND status IN (?, ?)',
    ).get(actorId, ReminderStatus.SCHEDULED, ReminderStatus.FIRING) as { count: number };
    return count;
  }

  private findByDisplayNo(actorId: Id, displayNo: number): ReminderRow | undefined {
    if (!Number.isSafeInteger(displayNo) || displayNo < 1) return undefined;
    return this.db.prepare('SELECT * FROM reminders WHERE actor_id = ? AND display_no = ?')
      .get(actorId, displayNo) as ReminderRow | undefined;
  }

  /**
   * The single update path: rewrites `data` and its mirror columns together, conditional on the stored status
   * (and, for a FIRING row, the attempt id). Runs inside the caller's IMMEDIATE transaction, so a lost CAS means
   * the row changed under that lock — an invariant breach, never a silent no-op.
   */
  private write(reminder: Reminder, expectedStatus: ReminderStatus, expectedAttemptId?: Id): void {
    const nextFireAt = isActiveReminderStatus(reminder.status) && reminder.nextFireAt !== undefined
      ? canonicalInstant(reminder.nextFireAt)
      : null;
    const attemptPredicate = expectedAttemptId === undefined
      ? ''
      : ` AND json_extract(data, '$.firingAttemptId') = @expectedAttemptId`;
    const result = this.db.prepare(
      `UPDATE reminders SET status = @status, next_fire_at = @nextFireAt, data = @data
       WHERE id = @id AND status = @expectedStatus${attemptPredicate}`,
    ).run({
      id: reminder.id,
      status: reminder.status,
      nextFireAt,
      data: JSON.stringify(reminder),
      expectedStatus,
      ...(expectedAttemptId === undefined ? {} : { expectedAttemptId }),
    });
    if (result.changes !== 1) throw new Error('REMINDER_CAS_LOST');
  }

  private immediate<T>(operation: () => T): T {
    try {
      return this.db.transaction(operation).immediate();
    } catch (error) {
      if (isLockContention(error)) throw new Error('REMINDER_STORAGE_BUSY');
      throw error;
    }
  }
}
