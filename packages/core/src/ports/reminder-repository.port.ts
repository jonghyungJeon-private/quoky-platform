import type { Id, IsoTimestamp, Reminder, ReminderDraft, ReminderFiringCompletion } from '../domain';

/**
 * PORT: owner reminder persistence (ADR-0101 D4/D9; DI token `REMINDER_REPOSITORY`).
 *
 * Named methods only; deliberately NOT part of `StorageProvider`. Domain types only: no driver, row or
 * statement type crosses this port. Implementations make `cancel`, `claimDue` and `completeFiring` single
 * atomic operations with compare-and-set on the stored status (and attempt id), so a reminder is claimed by at
 * most one dispatcher and an occurrence is delivered at most once.
 */

export type CreateReminderResult =
  | { status: 'CREATED'; reminder: Reminder }
  /** The owner already has `maxActive` SCHEDULED/FIRING reminders; nothing was written. */
  | { status: 'LIMIT_REACHED'; activeCount: number };

export type CancelReminderResult =
  | { status: 'CANCELED'; reminder: Reminder }
  | { status: 'NOT_FOUND' }
  /** Already COMPLETED, CANCELED, FAILED or DELIVERY_UNCERTAIN; unchanged. */
  | { status: 'ALREADY_FINAL'; reminder: Reminder }
  /** FIRING: it is being sent right now and cannot be canceled. */
  | { status: 'IN_FLIGHT'; reminder: Reminder };

export type CompleteFiringResult =
  | { status: 'COMPLETED'; reminder: Reminder }
  /** The reminder is no longer FIRING under this attempt id; nothing was written. */
  | { status: 'CONFLICT' };

/** ADR-0120 amendment A6 (ratification record B): the outcome of the undo-only reactivation. */
export type ReactivateReminderResult =
  | { status: 'REACTIVATED'; reminder: Reminder }
  | { status: 'NOT_FOUND' }
  /** No longer CANCELED, or changed since the cancel being undone (the version differs); nothing was written. */
  | { status: 'CHANGED'; reminder: Reminder }
  /** The owner already has `maxActive` SCHEDULED/FIRING reminders; nothing was written. */
  | { status: 'LIMIT_REACHED'; activeCount: number };

export interface ReminderRepository {
  /**
   * Atomically count the actor's active reminders and, below `maxActive`, store the draft with the next stable
   * per-actor `displayNo` (one more than the highest ever assigned to that actor; numbers are never reused).
   */
  createWithinLimit(draft: ReminderDraft, maxActive: number): Promise<CreateReminderResult>;
  /** The actor's SCHEDULED and FIRING reminders, ordered by `displayNo` ascending. */
  listActiveByActor(actorId: Id): Promise<Reminder[]>;
  /** The actor's reminder with that number in any status, or null. Owner-scoped: never another actor's. */
  getByDisplayNo(actorId: Id, displayNo: number): Promise<Reminder | null>;
  /** Conditional SCHEDULED → CANCELED for the actor's reminder `displayNo`. */
  cancel(actorId: Id, displayNo: number, at: IsoTimestamp): Promise<CancelReminderResult>;
  /**
   * Atomically move at most `limit` SCHEDULED reminders with `nextFireAt <= now` (earliest first) to FIRING,
   * stamping `attemptId` and `firingStartedAt = now`; returns the claimed reminders.
   */
  claimDue(now: IsoTimestamp, limit: number, attemptId: Id): Promise<Reminder[]>;
  /** CAS: apply `completion` only while the reminder is FIRING under `attemptId`. */
  completeFiring(id: Id, attemptId: Id, completion: ReminderFiringCompletion): Promise<CompleteFiringResult>;
  /** Every FIRING reminder (startup recovery treats each as `UNCERTAIN`, never resends). */
  listFiring(): Promise<Reminder[]>;
  /**
   * ADR-0120 amendment A6 (record B), the A6 undo path ONLY: atomically replace the actor's CANCELED reminder `next.id`
   * with `next` (a SCHEDULED value computed by `reactivateReminder`), compare-and-set on status `CANCELED` and the stored
   * `updatedAt` equal to `expectedUpdatedAt`, and only while the actor has fewer than `maxActive` active reminders (the
   * `createWithinLimit` rule). The row keeps its `displayNo`.
   */
  reactivate(actorId: Id, next: Reminder, expectedUpdatedAt: IsoTimestamp, maxActive: number): Promise<ReactivateReminderResult>;
}
