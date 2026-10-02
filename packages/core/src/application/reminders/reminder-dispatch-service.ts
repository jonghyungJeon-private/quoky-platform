import {
  REMINDER_LIMITS,
  isRecurringSchedule,
  planFiringCompletion,
  type Id,
  type IsoTimestamp,
  type NotificationDeliveryOutcome,
  type Reminder,
  type ReminderFiringResult,
  type WorkItem,
} from '../../domain';
import type { Logger } from '../../ports/logger.port';
import type { NotificationSink } from '../../ports/notification-sink.port';
import type { ReminderRepository } from '../../ports/reminder-repository.port';
import { newId } from '../../util/id';
import { decideMissedOccurrence, nextOccurrenceAfter } from './reminder-schedule';
import type { ReminderReplyComposer } from './reminder-reply-composer';

/**
 * Bounded local reminder dispatch (ADR-0101 D4/D6). At most once per occurrence:
 *
 * - `SENT` completes (ONCE) or advances (recurring);
 * - only a confirmed `NOT_SENT{retryable: true}` is retried (at most 3 times, +1/+5/+15 minutes);
 * - `UNCERTAIN` — and a sink that throws, and a FIRING row found at startup — is terminal `DELIVERY_UNCERTAIN`:
 *   never retried, never re-sent, never routed to another target;
 * - a missed ONCE reminder is delivered once, labelled late; a recurring one gets one catch-up only within 60
 *   minutes, otherwise `SKIPPED_MISSED` (nothing is sent).
 *
 * The constructor deps are the whole reachable surface: a repository, the owner sink, the composer, a read-only
 * WorkItem lister for the local brief, and a logger. There is no provider, connector, tool, Task, WorkItem write
 * or runtime dependency, so none can be called. The only side effects are repository writes and `sink.deliver`.
 */

export interface ReminderDispatchDeps {
  readonly repository: ReminderRepository;
  readonly sink: NotificationSink;
  readonly composer: ReminderReplyComposer;
  /** Local, read-only WorkItem identities for the daily brief. */
  readonly workItems: { listByActor(actorId: Id): Promise<readonly WorkItem[]> };
  readonly logger: Logger;
  /** Firing-attempt id source; defaults to the shared `newId`. */
  readonly idGenerator?: () => Id;
}

/** Counts only; never a body, a title or an id. */
export interface ReminderDispatchSummary {
  /** Reminders claimed by this call (≤ `maxDeliveriesPerTick`). */
  readonly claimed: number;
  /** Delivered on time or late (`SENT`). */
  readonly delivered: number;
  /** Of `delivered`, those carrying the late label. */
  readonly deliveredLate: number;
  /** Of `delivered`, those confirmed through the owner DM / the origin channel. */
  readonly viaDm: number;
  readonly viaChannel: number;
  /** Confirmed not sent and rescheduled with backoff. */
  readonly retried: number;
  /** Confirmed not sent with no retry left (or not retryable): the occurrence ended FAILED. */
  readonly failed: number;
  /** `UNCERTAIN` (including a sink exception): the occurrence ended DELIVERY_UNCERTAIN. */
  readonly uncertain: number;
  /** Recurring occurrences skipped beyond the 60-minute catch-up (nothing sent). */
  readonly skippedMissed: number;
  /** `completeFiring` found the reminder no longer FIRING under this attempt (nothing written). */
  readonly staleCompletions: number;
  /** Reminders whose processing failed unexpectedly (left FIRING; startup recovery marks them uncertain). */
  readonly errors: number;
}

export interface ReminderRecoverySummary {
  /** FIRING rows moved to DELIVERY_UNCERTAIN (a recurring one also advanced to its next occurrence). */
  readonly recovered: number;
  readonly staleCompletions: number;
  readonly errors: number;
}

type MutableDispatchSummary = { -readonly [K in keyof ReminderDispatchSummary]: ReminderDispatchSummary[K] };

function emptySummary(): MutableDispatchSummary {
  return {
    claimed: 0,
    delivered: 0,
    deliveredLate: 0,
    viaDm: 0,
    viaChannel: 0,
    retried: 0,
    failed: 0,
    uncertain: 0,
    skippedMissed: 0,
    staleCompletions: 0,
    errors: 0,
  };
}

function laterOf(a: IsoTimestamp, b: IsoTimestamp): IsoTimestamp {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export class ReminderDispatchService {
  private readonly newAttemptId: () => Id;

  constructor(private readonly deps: ReminderDispatchDeps) {
    this.newAttemptId = deps.idGenerator ?? newId;
  }

  /**
   * Startup recovery: every FIRING row (the process stopped between claim and completion) may or may not have
   * been delivered, so it becomes `DELIVERY_UNCERTAIN` without a send. ONCE → terminal; recurring → next occurrence.
   */
  async recoverInterrupted(now: IsoTimestamp): Promise<ReminderRecoverySummary> {
    let recovered = 0;
    let staleCompletions = 0;
    let errors = 0;
    let firing: Reminder[];
    try {
      firing = await this.deps.repository.listFiring();
    } catch (error) {
      this.logFailure('reminder.recover.list_failed', error);
      return { recovered, staleCompletions, errors: 1 };
    }
    for (const reminder of firing) {
      try {
        const attemptId = reminder.firingAttemptId;
        if (attemptId === undefined) {
          errors += 1;
          this.deps.logger.warn('reminder.recover.no_attempt');
          continue;
        }
        const result: ReminderFiringResult = { status: 'UNCERTAIN', reason: 'INTERRUPTED' };
        const completion = planFiringCompletion(reminder, result, {
          at: now,
          ...this.nextOccurrenceContext(reminder, now),
        });
        const completed = await this.deps.repository.completeFiring(reminder.id, attemptId, completion);
        if (completed.status === 'COMPLETED') recovered += 1;
        else staleCompletions += 1;
      } catch (error) {
        errors += 1;
        this.logFailure('reminder.recover.failed', error);
      }
    }
    if (firing.length > 0) {
      this.deps.logger.info('reminder.recover.done', { found: firing.length, recovered, staleCompletions, errors });
    }
    return { recovered, staleCompletions, errors };
  }

  /** One bounded tick: claim ≤10 due reminders, deliver each at most once, record each outcome. */
  async dispatchDue(now: IsoTimestamp): Promise<ReminderDispatchSummary> {
    const summary = emptySummary();
    const attemptId = this.newAttemptId();
    let claimed: Reminder[];
    try {
      claimed = await this.deps.repository.claimDue(now, REMINDER_LIMITS.maxDeliveriesPerTick, attemptId);
    } catch (error) {
      this.logFailure('reminder.dispatch.claim_failed', error);
      summary.errors += 1;
      return summary;
    }
    // The repository is asked for at most 10; the slice keeps the bound even if an implementation over-returns.
    const batch = claimed.slice(0, REMINDER_LIMITS.maxDeliveriesPerTick);
    summary.claimed = batch.length;
    for (const reminder of batch) {
      try {
        await this.dispatchOne(reminder, attemptId, now, summary);
      } catch (error) {
        // Isolated: the reminder stays FIRING (startup recovery treats it as uncertain); the batch continues.
        summary.errors += 1;
        this.logFailure('reminder.dispatch.failed', error);
      }
    }
    if (summary.claimed > 0 || summary.errors > 0) this.deps.logger.info('reminder.dispatch.tick', { ...summary });
    return summary;
  }

  private async dispatchOne(
    reminder: Reminder,
    attemptId: Id,
    now: IsoTimestamp,
    summary: MutableDispatchSummary,
  ): Promise<void> {
    const claimedOccurrenceAt = reminder.occurrenceAt ?? reminder.nextFireAt ?? reminder.firingStartedAt ?? now;
    const decision = decideMissedOccurrence(
      { schedule: reminder.schedule, timeZone: reminder.timeZone, occurrenceAt: claimedOccurrenceAt },
      now,
    );

    if (decision.action === 'SKIP') {
      const completion = planFiringCompletion(
        reminder,
        { status: 'SKIPPED_MISSED', skippedOccurrenceAt: decision.skippedOccurrenceAt },
        { at: now, nextOccurrenceAt: decision.nextOccurrenceAt },
      );
      summary.skippedMissed += 1;
      await this.complete(reminder, attemptId, completion, summary);
      return;
    }

    const text = await this.composeText(reminder, decision.occurrenceAt, decision.late, now);
    const outcome = await this.deliverOnce(reminder, decision.occurrenceAt, text);
    const completion = planFiringCompletion(reminder, outcome, {
      at: now,
      ...(isRecurringSchedule(reminder.schedule) ? { deliveredOccurrenceAt: decision.occurrenceAt } : {}),
      ...this.nextOccurrenceContext(reminder, laterOf(now, decision.occurrenceAt)),
    });

    switch (outcome.status) {
      case 'SENT':
        summary.delivered += 1;
        if (decision.late) summary.deliveredLate += 1;
        if (outcome.via === 'dm') summary.viaDm += 1;
        else summary.viaChannel += 1;
        break;
      case 'NOT_SENT':
        if (outcome.retryable && reminder.attempt < REMINDER_LIMITS.maxRetries) summary.retried += 1;
        else summary.failed += 1;
        break;
      case 'UNCERTAIN':
        summary.uncertain += 1;
        break;
    }
    await this.complete(reminder, attemptId, completion, summary);
  }

  /** `deliver` exactly once. A throw is `UNCERTAIN` (the request may have been issued), never a retry. */
  private async deliverOnce(
    reminder: Reminder,
    occurrenceAt: IsoTimestamp,
    text: string,
  ): Promise<NotificationDeliveryOutcome> {
    try {
      return await this.deps.sink.deliver({
        correlationId: `${reminder.id}:${occurrenceAt}:${reminder.attempt}`,
        target: reminder.origin,
        kind: reminder.kind,
        text,
      });
    } catch (error) {
      this.logFailure('reminder.dispatch.sink_threw', error);
      return { status: 'UNCERTAIN', reason: 'UNCLASSIFIED' };
    }
  }

  private async composeText(
    reminder: Reminder,
    occurrenceAt: IsoTimestamp,
    late: boolean,
    now: IsoTimestamp,
  ): Promise<string> {
    if (reminder.kind === 'TEXT') {
      return this.deps.composer.delivery({
        displayNo: reminder.displayNo,
        body: reminder.body,
        occurrenceAt,
        late,
        timeZone: reminder.timeZone,
      });
    }
    // BRIEF: local reads only. A failed read degrades the brief instead of blocking the owner's reminder.
    const reminders = await this.readOrNull(() => this.deps.repository.listActiveByActor(reminder.actorId));
    const workItems = await this.readOrNull(() => this.deps.workItems.listByActor(reminder.actorId));
    return this.deps.composer.brief({
      now,
      timeZone: reminder.timeZone,
      reminders,
      workItems,
      occurrenceAt,
      late,
    });
  }

  private async readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.logFailure('reminder.brief.read_failed', error);
      return null;
    }
  }

  /** The next occurrence strictly after `after`, only for a recurring reminder (ONCE has none). */
  private nextOccurrenceContext(reminder: Reminder, after: IsoTimestamp): { nextOccurrenceAt?: IsoTimestamp } {
    if (!isRecurringSchedule(reminder.schedule)) return {};
    const occurrence = reminder.occurrenceAt ?? reminder.nextFireAt;
    const from = occurrence === undefined ? after : laterOf(after, occurrence);
    const next = nextOccurrenceAfter(reminder.schedule, reminder.timeZone, from);
    return next === null ? {} : { nextOccurrenceAt: next };
  }

  private async complete(
    reminder: Reminder,
    attemptId: Id,
    completion: ReturnType<typeof planFiringCompletion>,
    summary: MutableDispatchSummary,
  ): Promise<void> {
    const result = await this.deps.repository.completeFiring(reminder.id, attemptId, completion);
    if (result.status === 'CONFLICT') {
      summary.staleCompletions += 1;
      this.deps.logger.warn('reminder.dispatch.stale_completion');
    }
  }

  private logFailure(message: string, error: unknown): void {
    // Failure class only: never a reminder body, a message text or the underlying error's own message.
    this.deps.logger.error(message, { errorName: error instanceof Error ? error.name : 'unknown' });
  }
}
