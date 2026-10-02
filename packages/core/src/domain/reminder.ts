import type { Id, IsoTimestamp } from './common';
import type { ConversationContext } from './messaging';

/**
 * Owner reminder domain model (ADR-0101 D1/D4, PRO-1).
 *
 * A Reminder is an owner-created, actor-owned durable record whose only effect is bounded plain text delivered
 * to that owner at a computed time. It never creates a Task, TaskRun, WorkItem, WorkHandoff, ExecutionPlan or
 * ApprovalRequest and never reaches a provider, tool, connector, workspace or git. Everything here is pure: the
 * time of every transition is an input, and no function reads a clock or generates an id.
 */

/** Closed lifecycle (ADR-0101 D4). COMPLETED, CANCELED, FAILED and DELIVERY_UNCERTAIN are terminal. */
export enum ReminderStatus {
  SCHEDULED = 'SCHEDULED',
  FIRING = 'FIRING',
  COMPLETED = 'COMPLETED',
  CANCELED = 'CANCELED',
  FAILED = 'FAILED',
  DELIVERY_UNCERTAIN = 'DELIVERY_UNCERTAIN',
}

/** `BRIEF` is the local-only daily brief (ADR-0101 D7); every other body is plain `TEXT`. */
export type ReminderBodyKind = 'TEXT' | 'BRIEF';

/** Day of the week in the reminder's zone: 0 = Sunday … 6 = Saturday (the `Date#getUTCDay` convention). */
export type ReminderWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A wall-clock time of day in the reminder's zone (24-hour). */
export interface ReminderLocalTime {
  readonly hour: number;
  readonly minute: number;
}

/** ONCE at an absolute instant, or a daily/weekly wall-clock recurrence (≤1 fire per day, ADR-0101 D10). */
export type ReminderSchedule =
  | { readonly type: 'ONCE'; readonly at: IsoTimestamp }
  | { readonly type: 'DAILY'; readonly time: ReminderLocalTime }
  | { readonly type: 'WEEKLY'; readonly time: ReminderLocalTime; readonly weekdays: readonly ReminderWeekday[] };

/** Final outcome of one occurrence, recorded in `lastOutcome` and shown by `알림 목록` (ADR-0101 D4). */
export type ReminderOccurrenceOutcome = 'SENT' | 'FAILED' | 'DELIVERY_UNCERTAIN' | 'SKIPPED_MISSED';

/** Where a confirmed delivery landed (ADR-0101 D8: owner DM by default, origin channel only by opt-in). */
export type NotificationDeliveryVia = 'dm' | 'channel';

/**
 * Reasons a delivery was confirmed NOT transmitted (ADR-0101 D4). Pre-send validation and platform refusals that
 * create no message are not retryable; a rate-limit rejection or a disconnected client is.
 */
export type NotificationNotSentReason =
  | 'TEXT_TOO_LONG'
  | 'NOT_OWNER'
  | 'TARGET_NOT_ADMITTED'
  | 'MISSING_ACCESS'
  | 'UNKNOWN_TARGET'
  | 'RATE_LIMITED'
  | 'NOT_CONNECTED';

/** Reasons the request may have been transmitted (ADR-0101 D4). `INTERRUPTED` is a FIRING row found at startup. */
export type NotificationUncertainReason =
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'ABORTED'
  | 'PLATFORM_ERROR'
  | 'UNCLASSIFIED'
  | 'INTERRUPTED';

/**
 * Delivery-outcome contract of `NotificationSink.deliver` (ADR-0101 D4). Lives in the domain because the
 * reminder transitions consume it; the port re-uses it unchanged. Only `NOT_SENT{retryable: true}` is retried.
 */
export type NotificationDeliveryOutcome =
  | { readonly status: 'SENT'; readonly via: NotificationDeliveryVia }
  | { readonly status: 'NOT_SENT'; readonly reason: NotificationNotSentReason; readonly retryable: boolean }
  | { readonly status: 'UNCERTAIN'; readonly reason: NotificationUncertainReason };

/** What ended a claimed occurrence: a delivery outcome, or (recurring only) a miss beyond the catch-up grace. */
export type ReminderFiringResult =
  | NotificationDeliveryOutcome
  | { readonly status: 'SKIPPED_MISSED'; readonly skippedOccurrenceAt: IsoTimestamp };

export interface ReminderLastOutcome {
  readonly outcome: ReminderOccurrenceOutcome;
  /** The scheduled time of the occurrence this outcome belongs to. */
  readonly occurrenceAt: IsoTimestamp;
  /** When the outcome was recorded. */
  readonly recordedAt: IsoTimestamp;
  readonly via?: NotificationDeliveryVia;
  readonly reason?: NotificationNotSentReason | NotificationUncertainReason;
}

/** Bounds fixed by ADR-0101 (D2, D6, D10 and owner decision 3). */
export const REMINDER_LIMITS = {
  /** Reminder body length, in Unicode code points (1..200). */
  maxBodyChars: 200,
  /** Active (SCHEDULED or FIRING) reminders per owner. */
  maxActivePerActor: 50,
  /** A first fire more than this many days ahead is refused (clarify). */
  horizonDays: 366,
  /** A first fire less than this far ahead is refused (clarify). */
  minLeadMs: 60_000,
  /** Retries of one occurrence after `NOT_SENT{retryable: true}`. */
  maxRetries: 3,
  /** Backoff of retry 1, 2 and 3, in minutes. */
  retryBackoffMinutes: [1, 5, 15] as const,
  /** A recurring occurrence older than this when it is dispatched is skipped (`SKIPPED_MISSED`), never sent. */
  recurringCatchUpGraceMs: 60 * 60_000,
  /** A delivery this long after its occurrence is labelled late (the tick is ≈15 s). */
  lateLabelAfterMs: 2 * 60_000,
  /** Reminders claimed and delivered per dispatch tick. */
  maxDeliveriesPerTick: 10,
  /** Delivered text length (one Discord message). */
  maxDeliveredTextChars: 1_800,
} as const;

/**
 * The durable reminder aggregate. `occurrenceAt` is the scheduled time of the current occurrence and is not moved
 * by retries; `nextFireAt` is when the dispatcher may next claim it (equal to `occurrenceAt` unless a retry backoff
 * moved it). Both are absent once the reminder is terminal. `attempt` counts retries already used for the current
 * occurrence. `firingAttemptId`/`firingStartedAt` are set only while FIRING (the `completeFiring` CAS token).
 */
export interface Reminder {
  readonly id: Id;
  readonly actorId: Id;
  /** Stable per-owner number shown as `#N` and used by `알림 N 취소`; assigned by the repository. */
  readonly displayNo: number;
  readonly status: ReminderStatus;
  readonly kind: ReminderBodyKind;
  readonly body: string;
  readonly schedule: ReminderSchedule;
  /** IANA zone the reminder was created in (`QUOKY_TIMEZONE`); recurrences are computed in it. */
  readonly timeZone: string;
  /** Where the reminder was created; delivery addresses this owner only (ADR-0101 D8). */
  readonly origin: ConversationContext;
  readonly occurrenceAt?: IsoTimestamp;
  readonly nextFireAt?: IsoTimestamp;
  readonly attempt: number;
  readonly firingAttemptId?: Id;
  readonly firingStartedAt?: IsoTimestamp;
  readonly lastOutcome?: ReminderLastOutcome;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** A reminder before the repository assigned its `displayNo` (input of `createWithinLimit`). */
export type ReminderDraft = Omit<Reminder, 'displayNo'>;

/**
 * The state a FIRING reminder moves to, computed by {@link planFiringCompletion} and applied atomically by the
 * repository's CAS `completeFiring` (or in memory by {@link applyFiringCompletion}).
 */
export interface ReminderFiringCompletion {
  readonly status:
    | ReminderStatus.SCHEDULED
    | ReminderStatus.COMPLETED
    | ReminderStatus.FAILED
    | ReminderStatus.DELIVERY_UNCERTAIN;
  readonly occurrenceAt?: IsoTimestamp;
  readonly nextFireAt?: IsoTimestamp;
  readonly attempt: number;
  /** Absent only for a retry of the same occurrence (the occurrence has no final outcome yet). */
  readonly lastOutcome?: ReminderLastOutcome;
  readonly updatedAt: IsoTimestamp;
}

/** An illegal reminder transition or an invalid reminder value was attempted. */
export class InvalidReminderTransitionError extends Error {
  constructor(from: string, to: string, detail?: string) {
    super(`Illegal reminder transition: ${from} -> ${to}${detail === undefined ? '' : ` (${detail})`}`);
    this.name = 'InvalidReminderTransitionError';
  }
}

export class InvalidReminderError extends Error {
  constructor(readonly code: 'BODY_EMPTY' | 'BODY_TOO_LONG' | 'SCHEDULE_INVALID' | 'FIRE_TIME_INVALID') {
    super(code);
    this.name = 'InvalidReminderError';
  }
}

/** The closed transition table of ADR-0101 D4. */
const TRANSITIONS: Readonly<Record<ReminderStatus, readonly ReminderStatus[]>> = {
  [ReminderStatus.SCHEDULED]: [ReminderStatus.FIRING, ReminderStatus.CANCELED, ReminderStatus.SCHEDULED],
  [ReminderStatus.FIRING]: [
    ReminderStatus.COMPLETED,
    ReminderStatus.SCHEDULED,
    ReminderStatus.FAILED,
    ReminderStatus.DELIVERY_UNCERTAIN,
  ],
  [ReminderStatus.COMPLETED]: [],
  [ReminderStatus.CANCELED]: [],
  [ReminderStatus.FAILED]: [],
  [ReminderStatus.DELIVERY_UNCERTAIN]: [],
};

export const TERMINAL_REMINDER_STATUSES: readonly ReminderStatus[] = [
  ReminderStatus.COMPLETED,
  ReminderStatus.CANCELED,
  ReminderStatus.FAILED,
  ReminderStatus.DELIVERY_UNCERTAIN,
];

export function canTransitionReminder(from: ReminderStatus, to: ReminderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalReminderStatus(status: ReminderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Active reminders count toward the per-owner limit and are listed by `알림 목록`. */
export function isActiveReminderStatus(status: ReminderStatus): boolean {
  return status === ReminderStatus.SCHEDULED || status === ReminderStatus.FIRING;
}

export function isRecurringSchedule(schedule: ReminderSchedule): boolean {
  return schedule.type !== 'ONCE';
}

/** Body length in Unicode code points (a surrogate pair is one character). */
export function reminderBodyLength(body: string): number {
  return Array.from(body).length;
}

function isValidLocalTime(time: ReminderLocalTime): boolean {
  return (
    Number.isInteger(time.hour) &&
    Number.isInteger(time.minute) &&
    time.hour >= 0 &&
    time.hour <= 23 &&
    time.minute >= 0 &&
    time.minute <= 59
  );
}

function isIsoInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** Whether a schedule is well-formed: a parseable ONCE instant, a valid local time, distinct weekdays 0..6. */
export function isValidReminderSchedule(schedule: ReminderSchedule): boolean {
  switch (schedule.type) {
    case 'ONCE':
      return isIsoInstant(schedule.at);
    case 'DAILY':
      return isValidLocalTime(schedule.time);
    case 'WEEKLY': {
      if (!isValidLocalTime(schedule.time) || schedule.weekdays.length === 0) return false;
      const seen = new Set<number>();
      for (const day of schedule.weekdays) {
        if (!Number.isInteger(day) || day < 0 || day > 6 || seen.has(day)) return false;
        seen.add(day);
      }
      return true;
    }
  }
}

export interface NewReminderInput {
  id: Id;
  actorId: Id;
  kind: ReminderBodyKind;
  body: string;
  schedule: ReminderSchedule;
  timeZone: string;
  origin: ConversationContext;
  /** The first occurrence (computed by the grammar / schedule). */
  firstFireAt: IsoTimestamp;
  createdAt: IsoTimestamp;
}

/** A new SCHEDULED reminder draft. Validates the body bounds and the schedule; never reads a clock. */
export function createReminderDraft(input: NewReminderInput): ReminderDraft {
  const length = reminderBodyLength(input.body);
  if (length === 0 || input.body.trim().length === 0) throw new InvalidReminderError('BODY_EMPTY');
  if (length > REMINDER_LIMITS.maxBodyChars) throw new InvalidReminderError('BODY_TOO_LONG');
  if (!isValidReminderSchedule(input.schedule)) throw new InvalidReminderError('SCHEDULE_INVALID');
  if (!isIsoInstant(input.firstFireAt)) throw new InvalidReminderError('FIRE_TIME_INVALID');
  return {
    id: input.id,
    actorId: input.actorId,
    status: ReminderStatus.SCHEDULED,
    kind: input.kind,
    body: input.body,
    schedule: input.schedule,
    timeZone: input.timeZone,
    origin: input.origin,
    occurrenceAt: input.firstFireAt,
    nextFireAt: input.firstFireAt,
    attempt: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function assertTransition(from: ReminderStatus, to: ReminderStatus, detail?: string): void {
  if (!canTransitionReminder(from, to)) throw new InvalidReminderTransitionError(from, to, detail);
}

/** Copy without the given optional keys (exactOptionalPropertyTypes-safe; never mutates the input). */
function withoutKeys<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

/** SCHEDULED → FIRING (`claimDue`). The attempt id is the CAS token `completeFiring` must present. */
export function claimReminder(reminder: Reminder, attemptId: Id, at: IsoTimestamp): Reminder {
  assertTransition(reminder.status, ReminderStatus.FIRING);
  return { ...reminder, status: ReminderStatus.FIRING, firingAttemptId: attemptId, firingStartedAt: at, updatedAt: at };
}

/** SCHEDULED → CANCELED (owner cancel). A FIRING reminder cannot be canceled (it is being sent). */
export function cancelReminder(reminder: Reminder, at: IsoTimestamp): Reminder {
  if (reminder.status !== ReminderStatus.SCHEDULED) {
    throw new InvalidReminderTransitionError(reminder.status, ReminderStatus.CANCELED);
  }
  return {
    ...withoutKeys(reminder, ['occurrenceAt', 'nextFireAt', 'firingAttemptId', 'firingStartedAt']),
    status: ReminderStatus.CANCELED,
    updatedAt: at,
  };
}

/**
 * SCHEDULED → SCHEDULED: a recurring occurrence missed beyond the 60-minute catch-up is skipped (never sent) and
 * the reminder moves to its next occurrence with `lastOutcome = SKIPPED_MISSED`.
 */
export function skipMissedOccurrence(
  reminder: Reminder,
  input: { skippedOccurrenceAt: IsoTimestamp; nextOccurrenceAt: IsoTimestamp; at: IsoTimestamp },
): Reminder {
  if (reminder.status !== ReminderStatus.SCHEDULED || !isRecurringSchedule(reminder.schedule)) {
    throw new InvalidReminderTransitionError(reminder.status, ReminderStatus.SCHEDULED, 'skip requires a recurring SCHEDULED reminder');
  }
  return {
    ...reminder,
    occurrenceAt: input.nextOccurrenceAt,
    nextFireAt: input.nextOccurrenceAt,
    attempt: 0,
    lastOutcome: { outcome: 'SKIPPED_MISSED', occurrenceAt: input.skippedOccurrenceAt, recordedAt: input.at },
    updatedAt: input.at,
  };
}

export interface FiringCompletionContext {
  /** When the outcome is recorded. */
  at: IsoTimestamp;
  /**
   * Next occurrence strictly after the current one (required for a recurring reminder that leaves this
   * occurrence; ignored for ONCE). Computed by `nextOccurrenceAfter` in the application layer.
   */
  nextOccurrenceAt?: IsoTimestamp;
  /**
   * The occurrence this attempt actually delivered, when the missed-reminder policy (`decideMissedOccurrence`)
   * caught up to a later occurrence than the claimed `occurrenceAt` (recurring only; never earlier than it). It is
   * recorded in `lastOutcome`, kept by a retry, and the next occurrence must be strictly after it. Defaults to the
   * claimed occurrence.
   */
  deliveredOccurrenceAt?: IsoTimestamp;
}

function addMinutes(iso: IsoTimestamp, minutes: number): IsoTimestamp {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** Terminal status of a ONCE reminder per final occurrence outcome (a ONCE occurrence is never skipped). */
const ONCE_FINAL_STATUS: Readonly<Record<ReminderOccurrenceOutcome, ReminderFiringCompletion['status']>> = {
  SENT: ReminderStatus.COMPLETED,
  FAILED: ReminderStatus.FAILED,
  DELIVERY_UNCERTAIN: ReminderStatus.DELIVERY_UNCERTAIN,
  SKIPPED_MISSED: ReminderStatus.FAILED, // unreachable: planFiringCompletion refuses SKIPPED_MISSED for ONCE
};

function finalOccurrenceOutcome(
  result: ReminderFiringResult,
  occurrenceAt: IsoTimestamp,
  recordedAt: IsoTimestamp,
): ReminderLastOutcome {
  switch (result.status) {
    case 'SENT':
      return { outcome: 'SENT', occurrenceAt, recordedAt, via: result.via };
    case 'NOT_SENT':
      return { outcome: 'FAILED', occurrenceAt, recordedAt, reason: result.reason };
    case 'UNCERTAIN':
      return { outcome: 'DELIVERY_UNCERTAIN', occurrenceAt, recordedAt, reason: result.reason };
    case 'SKIPPED_MISSED':
      return { outcome: 'SKIPPED_MISSED', occurrenceAt: result.skippedOccurrenceAt, recordedAt };
  }
}

/**
 * Decide where a FIRING reminder goes for a firing result (ADR-0101 D4/D6, at most once per occurrence):
 * - `SENT` → COMPLETED (ONCE) or the next occurrence (recurring);
 * - `NOT_SENT{retryable: true}` with retries left → SCHEDULED, same occurrence, `nextFireAt` + 1/5/15 min;
 * - `NOT_SENT` otherwise → FAILED (ONCE) or the next occurrence with outcome FAILED (recurring);
 * - `UNCERTAIN` (incl. a startup-recovered FIRING row) → DELIVERY_UNCERTAIN (ONCE) or the next occurrence with
 *   outcome DELIVERY_UNCERTAIN (recurring) — never retried, never re-sent;
 * - `SKIPPED_MISSED` → the next occurrence (recurring only; a missed ONCE is delivered late instead).
 */
export function planFiringCompletion(
  reminder: Reminder,
  result: ReminderFiringResult,
  context: FiringCompletionContext,
): ReminderFiringCompletion {
  if (reminder.status !== ReminderStatus.FIRING) {
    throw new InvalidReminderTransitionError(reminder.status, 'completion', 'reminder is not FIRING');
  }
  const claimedOccurrenceAt = reminder.occurrenceAt ?? reminder.nextFireAt ?? reminder.firingStartedAt ?? context.at;
  const recurring = isRecurringSchedule(reminder.schedule);
  const delivered = context.deliveredOccurrenceAt;
  if (
    delivered !== undefined &&
    (!recurring || !isIsoInstant(delivered) || Date.parse(delivered) < Date.parse(claimedOccurrenceAt))
  ) {
    throw new InvalidReminderTransitionError(
      reminder.status,
      'completion',
      'a delivered occurrence is a recurring occurrence at or after the claimed one',
    );
  }
  const occurrenceAt = delivered === undefined ? claimedOccurrenceAt : new Date(Date.parse(delivered)).toISOString();

  if (result.status === 'NOT_SENT' && result.retryable && reminder.attempt < REMINDER_LIMITS.maxRetries) {
    const backoff = REMINDER_LIMITS.retryBackoffMinutes[reminder.attempt] ?? REMINDER_LIMITS.retryBackoffMinutes[2];
    return {
      status: ReminderStatus.SCHEDULED,
      occurrenceAt,
      nextFireAt: addMinutes(context.at, backoff),
      attempt: reminder.attempt + 1,
      updatedAt: context.at,
    };
  }

  if (result.status === 'SKIPPED_MISSED' && !recurring) {
    throw new InvalidReminderTransitionError(reminder.status, ReminderStatus.SCHEDULED, 'a ONCE reminder is never skipped');
  }
  const outcome = finalOccurrenceOutcome(result, occurrenceAt, context.at);
  if (!recurring) {
    return {
      status: ONCE_FINAL_STATUS[outcome.outcome],
      attempt: reminder.attempt,
      lastOutcome: outcome,
      updatedAt: context.at,
    };
  }
  const next = context.nextOccurrenceAt;
  if (next === undefined || !isIsoInstant(next) || Date.parse(next) <= Date.parse(occurrenceAt)) {
    throw new InvalidReminderTransitionError(reminder.status, ReminderStatus.SCHEDULED, 'recurring completion needs a later next occurrence');
  }
  return {
    status: ReminderStatus.SCHEDULED,
    occurrenceAt: next,
    nextFireAt: next,
    attempt: 0,
    lastOutcome: outcome,
    updatedAt: context.at,
  };
}

/**
 * Apply a planned completion to a FIRING reminder holding `attemptId` (the in-memory form of the repository's
 * CAS `completeFiring`). A stale attempt id or a non-FIRING reminder throws.
 */
export function applyFiringCompletion(
  reminder: Reminder,
  attemptId: Id,
  completion: ReminderFiringCompletion,
): Reminder {
  assertTransition(reminder.status, completion.status);
  if (reminder.status !== ReminderStatus.FIRING || reminder.firingAttemptId !== attemptId) {
    throw new InvalidReminderTransitionError(reminder.status, completion.status, 'stale firing attempt');
  }
  if (completion.status === ReminderStatus.COMPLETED && isRecurringSchedule(reminder.schedule)) {
    throw new InvalidReminderTransitionError(reminder.status, completion.status, 'a recurring reminder never completes by delivery');
  }
  const base = withoutKeys(reminder, ['occurrenceAt', 'nextFireAt', 'firingAttemptId', 'firingStartedAt', 'lastOutcome']);
  const lastOutcome = completion.lastOutcome ?? reminder.lastOutcome;
  return {
    ...base,
    status: completion.status,
    attempt: completion.attempt,
    updatedAt: completion.updatedAt,
    ...(completion.status === ReminderStatus.SCHEDULED && completion.occurrenceAt !== undefined
      ? { occurrenceAt: completion.occurrenceAt }
      : {}),
    ...(completion.status === ReminderStatus.SCHEDULED && completion.nextFireAt !== undefined
      ? { nextFireAt: completion.nextFireAt }
      : {}),
    ...(lastOutcome !== undefined ? { lastOutcome } : {}),
  };
}
