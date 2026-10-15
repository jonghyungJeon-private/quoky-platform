import {
  REMINDER_LIMITS,
  isRecurringSchedule,
  planEventCanceledCompletion,
  planEventRescheduleCompletion,
  planFiringCompletion,
  type ConversationContext,
  type Id,
  type IsoTimestamp,
  type MessageBody,
  type NotificationDeliveryOutcome,
  type Reminder,
  type ReminderEventRef,
  type ReminderFiringResult,
  type WorkItem,
} from '../../domain';
import type { Logger } from '../../ports/logger.port';
import type { ChannelRecheckResult, NotificationSink, OwnerNotification } from '../../ports/notification-sink.port';
import type { ReminderRepository } from '../../ports/reminder-repository.port';
import { newId } from '../../util/id';
import { isDirectConversation, messageBody, messageFields } from '../message-rendering';
import type { SurfaceGroupId } from '../surface-grants/surface-groups';
import { decideMissedOccurrence, nextOccurrenceAfter } from './reminder-schedule';
import type { DailyBriefSources } from './daily-brief-sources';
import type { EventReminderCalendar, EventReminderRecheck } from './event-reminder-calendar';
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
 * WorkItem lister for the local brief, a logger and — only when configured — the brief's read-only sources
 * (ADR-0117: today's calendar and the opt-in assigned work, `DailyBriefSources`, read for a BRIEF only). There is no
 * provider, tool, Task, WorkItem write or runtime dependency, so none can be called. The only side effects are
 * repository writes and `sink.deliver`.
 */

export interface ReminderDispatchDeps {
  readonly repository: ReminderRepository;
  readonly sink: NotificationSink;
  readonly composer: ReminderReplyComposer;
  /** Local, read-only WorkItem identities for the daily brief. */
  readonly workItems: { listByActor(actorId: Id): Promise<readonly WorkItem[]> };
  readonly logger: Logger;
  /**
   * ADR-0117 (BRF-1): the brief's bounded calendar / assigned-work reads. Absent: no calendar and no opted-in work
   * source, and the brief is the local-only brief, byte for byte.
   */
  readonly briefSources?: Pick<DailyBriefSources, 'read'>;
  /**
   * ADR-0117 D6 (BRF-2): the read-only re-check of an event-relative reminder's event at fire time. Absent (no calendar
   * configured): such a reminder is delivered as scheduled with the "could not re-check" note.
   */
  readonly eventCalendar?: Pick<EventReminderCalendar, 'recheck'>;
  /** Firing-attempt id source; defaults to the shared `newId`. */
  readonly idGenerator?: () => Id;
  /**
   * ADR-0122 D2.6 (P2): the send-time channel check, wired by the composition root only while
   * `QUOKY_CHANNEL_GRANTS=enforce` AND `QUOKY_REMINDERS_CHANNEL_DELIVERY=true`. A TEXT reminder created in a channel is
   * delivered there only when `allows` says the channel still holds its groups (`reminder`, and `calendar` for an
   * event-relative one) on the live grants; otherwise it goes to the owner DM with a note. A failed check is a refusal
   * (fail closed). Absent: delivery exactly as before.
   */
  readonly surfaceDelivery?: {
    allows(origin: ConversationContext, actorId: Id, groups: readonly SurfaceGroupId[]): Promise<boolean>;
    /**
     * The last-moment form (Codex P1): check the live grants and run `send` while holding the per-actor metadata lock, so
     * a revoke or a kill switch waits until the channel send returns; `{sent: false}` when refused.
     */
    sendIfAllowed<T>(origin: ConversationContext, actorId: Id, groups: readonly SurfaceGroupId[], send: () => Promise<T>): Promise<ChannelRecheckResult<T>>;
  };
}

/** D2.6: the note on a channel reminder delivered to the owner DM because the channel no longer holds its groups. */
export const REMINDER_CHANNEL_WITHHELD_NOTE = '(이 알림을 만든 채널에 지금 알림 권한이 없어 DM으로 보냈어요.)';

export interface ReminderDispatchOptions {
  /** Checked before each reminder of the batch; `false` stops starting new deliveries (the active one finishes). */
  readonly shouldContinue?: () => boolean;
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
  /** ADR-0117 D6: event-relative reminders whose event moved later; rescheduled, nothing sent. */
  readonly eventRescheduled: number;
  /** ADR-0117 D6: event-relative reminders canceled because the event is gone or became all-day (the note is sent). */
  readonly eventCanceled: number;
  /** ADR-0117 D6: event-relative reminders delivered without a re-check (the calendar could not be read). */
  readonly eventUnverified: number;
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
    eventRescheduled: 0,
    eventCanceled: 0,
    eventUnverified: 0,
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
  async dispatchDue(now: IsoTimestamp, options: ReminderDispatchOptions = {}): Promise<ReminderDispatchSummary> {
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
    for (const [index, reminder] of batch.entries()) {
      // Cooperative cancellation (shutdown): never START another delivery once asked to stop. The unstarted rest of
      // the batch stays FIRING, which the next startup turns into DELIVERY_UNCERTAIN (at-most-once, never resent).
      if (options.shouldContinue !== undefined && !options.shouldContinue()) {
        this.deps.logger.warn('reminder.dispatch.cancelled', { unstarted: batch.length - index });
        break;
      }
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

    if (reminder.event !== undefined && reminder.kind === 'TEXT' && reminder.schedule.type === 'ONCE') {
      await this.dispatchEventReminder(reminder, reminder.event, attemptId, now, decision, summary);
      return;
    }

    const text = await this.composeText(reminder, decision.occurrenceAt, decision.late, now);
    const outcome = await this.deliverOnce(reminder, decision.occurrenceAt, text);
    this.count(outcome, reminder, decision.late, summary);
    const completion = planFiringCompletion(reminder, outcome, {
      at: now,
      ...(isRecurringSchedule(reminder.schedule) ? { deliveredOccurrenceAt: decision.occurrenceAt } : {}),
      ...this.nextOccurrenceContext(reminder, laterOf(now, decision.occurrenceAt)),
    });
    await this.complete(reminder, attemptId, completion, summary);
  }

  /**
   * ADR-0117 D6: the fire-time re-check of an event-relative reminder. The event is re-read by its id:
   *
   * - unchanged → delivered (late label as for any ONCE reminder), with the event's current title;
   * - moved later → rescheduled to the new start minus the offset, nothing sent (never at the stale time);
   * - moved earlier (its new due time has passed) → delivered now, saying the event moved;
   * - gone (deleted or cancelled), or now all-day → canceled, with one note to the owner;
   * - unreadable (failure, timeout, an incomplete read, or no calendar configured) → delivered as scheduled with the
   *   "could not re-check" note.
   *
   * Every send is the single `deliverOnce` of this claim: at most once, as ADR-0101 D6 (an interrupted re-check leaves
   * the row FIRING, which startup recovery records DELIVERY_UNCERTAIN, never resent).
   */
  private async dispatchEventReminder(
    reminder: Reminder,
    ref: ReminderEventRef,
    attemptId: Id,
    now: IsoTimestamp,
    decision: { occurrenceAt: IsoTimestamp; late: boolean },
    summary: MutableDispatchSummary,
  ): Promise<void> {
    const occurrenceMs = Date.parse(decision.occurrenceAt);
    const offsetMs = ref.offsetMinutes * 60_000;
    const expectedStart = new Date(occurrenceMs + offsetMs).toISOString();
    const check: EventReminderRecheck =
      this.deps.eventCalendar === undefined
        ? { kind: 'unreadable' }
        : await this.deps.eventCalendar.recheck(ref, expectedStart, now);

    if (check.kind === 'gone' || (check.kind === 'found' && check.event.allDay)) {
      const text = this.deps.composer.eventCanceledDelivery({
        displayNo: reminder.displayNo,
        title: check.kind === 'found' ? check.event.title : reminder.body,
        reason: check.kind === 'gone' ? 'gone' : 'all-day',
      });
      const outcome = await this.deliverOnce(reminder, decision.occurrenceAt, text);
      this.count(outcome, reminder, false, summary);
      const completion = planEventCanceledCompletion(reminder, outcome, { at: now });
      if (completion.status !== 'SCHEDULED') summary.eventCanceled += 1;
      await this.complete(reminder, attemptId, completion, summary);
      return;
    }

    let title = reminder.body;
    let startAt = expectedStart;
    let note: 'none' | 'unverified' | 'moved-earlier' = 'unverified';
    let late = decision.late;
    if (check.kind === 'found') {
      const startMs = Date.parse(check.event.start);
      if (!Number.isFinite(startMs)) {
        summary.eventUnverified += 1;
      } else {
        const dueMs = startMs - offsetMs;
        title = check.event.title;
        startAt = new Date(startMs).toISOString();
        if (dueMs === occurrenceMs) {
          note = 'none';
        } else if (dueMs > Date.parse(now)) {
          // Moved later: the reminder moves with it and nothing is sent at the stale time.
          const completion = planEventRescheduleCompletion(reminder, { at: now, occurrenceAt: new Date(dueMs).toISOString() });
          summary.eventRescheduled += 1;
          await this.complete(reminder, attemptId, completion, summary);
          return;
        } else {
          note = 'moved-earlier';
          late = false;
        }
      }
    } else {
      summary.eventUnverified += 1;
    }

    const text = this.deps.composer.eventDelivery({
      displayNo: reminder.displayNo,
      title,
      startAt,
      offsetMinutes: ref.offsetMinutes,
      note,
      occurrenceAt: decision.occurrenceAt,
      late,
      timeZone: reminder.timeZone,
      deliveredAt: now,
    });
    const outcome = await this.deliverOnce(reminder, decision.occurrenceAt, text);
    this.count(outcome, reminder, late, summary);
    await this.complete(reminder, attemptId, planFiringCompletion(reminder, outcome, { at: now }), summary);
  }

  private count(
    outcome: NotificationDeliveryOutcome,
    reminder: Reminder,
    late: boolean,
    summary: MutableDispatchSummary,
  ): void {
    switch (outcome.status) {
      case 'SENT':
        summary.delivered += 1;
        if (late) summary.deliveredLate += 1;
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
  }

  /** `deliver` exactly once. A throw is `UNCERTAIN` (the request may have been issued), never a retry. */
  private async deliverOnce(
    reminder: Reminder,
    occurrenceAt: IsoTimestamp,
    text: MessageBody,
  ): Promise<NotificationDeliveryOutcome> {
    const routed = await this.surfaceRoute(reminder, text);
    try {
      return await this.deps.sink.deliver({
        correlationId: `${reminder.id}:${occurrenceAt}:${reminder.attempt}`,
        target: routed.target,
        kind: reminder.kind,
        ...messageFields(routed.text),
        ...(routed.channelRecheck !== undefined ? { channelRecheck: routed.channelRecheck } : {}),
      });
    } catch (error) {
      this.logFailure('reminder.dispatch.sink_threw', error);
      return { status: 'UNCERTAIN', reason: 'UNCLASSIFIED' };
    }
  }

  /**
   * ADR-0122 D2.6: where a channel reminder goes at send time. Only a TEXT reminder whose origin is a channel (not direct,
   * with a space — the only target the sink would deliver to a channel) is checked; a refused (or failed) check sends it
   * to the owner DM — the same owner, the origin's space and thread dropped — with the fixed note. Content-free log.
   */
  private async surfaceRoute(
    reminder: Reminder,
    text: MessageBody,
  ): Promise<{ readonly target: ConversationContext; readonly text: MessageBody; readonly channelRecheck?: OwnerNotification['channelRecheck'] }> {
    const check = this.deps.surfaceDelivery;
    const origin = reminder.origin;
    if (check === undefined || reminder.kind !== 'TEXT' || isDirectConversation(origin) || origin.spaceId === undefined) return { target: origin, text };
    const groups: readonly SurfaceGroupId[] = reminder.event !== undefined ? ['reminder', 'calendar'] : ['reminder'];
    let allowed = false;
    try {
      allowed = await check.allows(origin, reminder.actorId, groups);
    } catch {
      allowed = false;
    }
    const dmText = messageBody(text, '\n', REMINDER_CHANNEL_WITHHELD_NOTE);
    if (allowed) {
      // Codex P1: the sink re-asks the live grants as the last step before the channel send (after resolving the channel);
      // a revoke or kill switch that landed meanwhile sends the DM text instead.
      const logger = this.deps.logger;
      return {
        target: origin,
        text,
        channelRecheck: {
          async sendIfAllowed<T>(send: () => Promise<T>): Promise<ChannelRecheckResult<T>> {
            const result = await check.sendIfAllowed(origin, reminder.actorId, groups, send);
            if (!result.sent) logger.info('reminder.dispatch.channel_withheld', { platform: origin.platform, channelId: origin.channelId, groups: groups.join(','), at: 'send' });
            return result;
          },
          dm: messageFields(dmText),
        },
      };
    }
    this.deps.logger.info('reminder.dispatch.channel_withheld', { platform: origin.platform, channelId: origin.channelId, groups: groups.join(',') });
    const { spaceId: _space, threadId: _thread, ...rest } = origin;
    return { target: { ...rest, direct: true }, text: dmText };
  }

  private async composeText(
    reminder: Reminder,
    occurrenceAt: IsoTimestamp,
    late: boolean,
    now: IsoTimestamp,
  ): Promise<MessageBody> {
    if (reminder.kind === 'TEXT') {
      return this.deps.composer.delivery({
        displayNo: reminder.displayNo,
        body: reminder.body,
        occurrenceAt,
        late,
        timeZone: reminder.timeZone,
        deliveredAt: now,
      });
    }
    // BRIEF: local reads, plus the configured read-only sources (ADR-0117), concurrently. A failed read degrades the
    // brief instead of blocking the owner's reminder; the sources bound their own read time and never throw.
    const [reminders, workItems, sources] = await Promise.all([
      this.readOrNull(() => this.deps.repository.listActiveByActor(reminder.actorId)),
      this.readOrNull(() => this.deps.workItems.listByActor(reminder.actorId)),
      this.deps.briefSources?.read({ actorId: reminder.actorId, now, timeZone: reminder.timeZone }),
    ]);
    return this.deps.composer.brief({
      now,
      timeZone: reminder.timeZone,
      reminders,
      workItems,
      occurrenceAt,
      late,
      ...(sources ?? {}),
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
