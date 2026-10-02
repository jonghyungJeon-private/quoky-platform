import { REMINDER_LIMITS, type IsoTimestamp, type ReminderSchedule } from '../../domain';
import { addLocalDays, localDateOf, weekdayOf, zonedToUtc, type LocalDate } from './zoned-time';

/**
 * Reminder occurrence arithmetic and the missed-reminder policy (ADR-0101 D3/D6). Pure: every instant is an input.
 *
 * Recurrences are wall-clock: a DAILY 08:00 reminder fires at 08:00 local time every day, across DST changes (a
 * wall-clock time inside a spring-forward gap fires the gap length later; one inside a fall-back overlap fires at
 * the earlier instant). A recurrence fires at most once per local day.
 */

/** Recurrences repeat at least weekly, so a search window of 8 local days always finds an occurrence. */
const SEARCH_DAYS = 8;

function occursOn(schedule: Exclude<ReminderSchedule, { type: 'ONCE' }>, date: LocalDate): boolean {
  return schedule.type === 'DAILY' || schedule.weekdays.includes(weekdayOf(date));
}

function occurrenceOn(schedule: Exclude<ReminderSchedule, { type: 'ONCE' }>, date: LocalDate, timeZone: string): number {
  return zonedToUtc({ ...date, hour: schedule.time.hour, minute: schedule.time.minute }, timeZone).epochMs;
}

/** The first occurrence strictly after `after`, or null (a ONCE reminder whose instant is not after it). */
export function nextOccurrenceAfter(
  schedule: ReminderSchedule,
  timeZone: string,
  after: IsoTimestamp,
): IsoTimestamp | null {
  const afterMs = Date.parse(after);
  if (schedule.type === 'ONCE') {
    return Date.parse(schedule.at) > afterMs ? new Date(Date.parse(schedule.at)).toISOString() : null;
  }
  // Start one local day early: a DST overlap can make yesterday's wall-clock occurrence later than `after`'s date.
  const start = addLocalDays(localDateOf(afterMs, timeZone), -1);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const date = addLocalDays(start, i);
    if (!occursOn(schedule, date)) continue;
    const at = occurrenceOn(schedule, date, timeZone);
    if (at > afterMs) return new Date(at).toISOString();
  }
  return null;
}

/** The latest occurrence at or before `atOrBefore`, or null (none yet: a future ONCE instant). */
export function latestOccurrenceAtOrBefore(
  schedule: ReminderSchedule,
  timeZone: string,
  atOrBefore: IsoTimestamp,
): IsoTimestamp | null {
  const limitMs = Date.parse(atOrBefore);
  if (schedule.type === 'ONCE') {
    return Date.parse(schedule.at) <= limitMs ? new Date(Date.parse(schedule.at)).toISOString() : null;
  }
  const start = addLocalDays(localDateOf(limitMs, timeZone), 1);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const date = addLocalDays(start, -i);
    if (!occursOn(schedule, date)) continue;
    const at = occurrenceOn(schedule, date, timeZone);
    if (at <= limitMs) return new Date(at).toISOString();
  }
  return null;
}

/**
 * What the dispatcher does with a claimed occurrence at `now` (ADR-0101 D6):
 * - ONCE: always deliver once, `late` when `now` is past the occurrence by more than the late-label threshold;
 * - recurring: deliver the latest due occurrence only within the 60-minute catch-up grace (one catch-up, never a
 *   replay of older ones); otherwise skip it (`SKIPPED_MISSED`, never sent) and move to the next future one.
 * A DELIVER of a later occurrence than the claimed one is passed to `planFiringCompletion` as
 * `deliveredOccurrenceAt`, so the recorded outcome and the next occurrence follow the occurrence actually sent.
 */
export type MissedOccurrenceDecision =
  | { readonly action: 'DELIVER'; readonly occurrenceAt: IsoTimestamp; readonly late: boolean }
  | { readonly action: 'SKIP'; readonly skippedOccurrenceAt: IsoTimestamp; readonly nextOccurrenceAt: IsoTimestamp };

export function decideMissedOccurrence(
  input: { schedule: ReminderSchedule; timeZone: string; occurrenceAt: IsoTimestamp },
  now: IsoTimestamp,
): MissedOccurrenceDecision {
  const nowMs = Date.parse(now);
  const isLate = (occurrenceMs: number): boolean => nowMs - occurrenceMs > REMINDER_LIMITS.lateLabelAfterMs;
  const occurrenceMs = Date.parse(input.occurrenceAt);
  if (input.schedule.type === 'ONCE') {
    return { action: 'DELIVER', occurrenceAt: new Date(occurrenceMs).toISOString(), late: isLate(occurrenceMs) };
  }
  const latest = latestOccurrenceAtOrBefore(input.schedule, input.timeZone, now);
  // The current occurrence (possibly a retry of it) is the latest one due unless later occurrences also passed.
  const dueMs = latest === null ? occurrenceMs : Math.max(occurrenceMs, Date.parse(latest));
  if (nowMs - dueMs <= REMINDER_LIMITS.recurringCatchUpGraceMs) {
    return { action: 'DELIVER', occurrenceAt: new Date(dueMs).toISOString(), late: isLate(dueMs) };
  }
  const next = nextOccurrenceAfter(input.schedule, input.timeZone, now);
  if (next === null) throw new RangeError('A recurring schedule always has a next occurrence');
  return { action: 'SKIP', skippedOccurrenceAt: new Date(dueMs).toISOString(), nextOccurrenceAt: next };
}
