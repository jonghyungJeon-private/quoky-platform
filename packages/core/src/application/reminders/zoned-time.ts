import type { IsoTimestamp, ReminderWeekday } from '../../domain';

/**
 * IANA wall-clock ⇄ UTC conversion with the built-in `Intl` only (ADR-0101 D3; no new dependency). Pure: the
 * instant to convert is always an input; nothing here reads a clock.
 *
 * Local → UTC resolves DST like the `compatible` disambiguation of Temporal: an ambiguous wall-clock time
 * (fall-back overlap) maps to the EARLIER instant, a nonexistent one (spring-forward gap) maps forward by the gap
 * length, and the result reports which case applied so a caller can refuse a nonexistent one-time reminder.
 */

/** Owner time zone used when none is configured (`QUOKY_TIMEZONE` default, ADR-0101 D3). */
export const REMINDER_DEFAULT_TIME_ZONE = 'Asia/Seoul';

/** A calendar date in some zone. `month` is 1..12. */
export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A wall-clock date-time in some zone (seconds are dropped; reminders are minute-precise). */
export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

/** A zoned reading of an instant, with its weekday. */
export interface ZonedDateTime extends LocalDateTime {
  readonly second: number;
  readonly weekday: ReminderWeekday;
}

/** `EXACT` = one instant; `AMBIGUOUS` = overlap, earlier chosen; `NONEXISTENT` = gap, shifted forward. */
export type LocalResolution = 'EXACT' | 'AMBIGUOUS' | 'NONEXISTENT';

export interface ResolvedInstant {
  readonly epochMs: number;
  readonly resolution: LocalResolution;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is a zone `Intl` accepts. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function toEpochMs(instant: IsoTimestamp | number | Date): number {
  if (typeof instant === 'number') return instant;
  if (instant instanceof Date) return instant.getTime();
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError('Invalid instant');
  return ms;
}

/** Weekday of a calendar date (proleptic Gregorian), independent of any zone. */
export function weekdayOf(date: LocalDate): ReminderWeekday {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() as ReminderWeekday;
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function toZonedDateTime(instant: IsoTimestamp | number | Date, timeZone: string): ZonedDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(toEpochMs(instant)));
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const date = { year: value('year'), month: value('month'), day: value('day') };
  const hour = value('hour') % 24; // some runtimes print midnight as 24 even with h23
  return { ...date, hour, minute: value('minute'), second: value('second'), weekday: weekdayOf(date) };
}

/** The zone's UTC offset at `epochMs`, in minutes (Asia/Seoul: +540). */
export function offsetMinutesAt(epochMs: number, timeZone: string): number {
  const z = toZonedDateTime(epochMs, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  const truncated = Math.floor(epochMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / MS_PER_MINUTE);
}

function sameLocal(a: LocalDateTime, b: LocalDateTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/** Days in `month` (1..12) of `year`, leap years included. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether the calendar date exists (e.g. 2월 30일 never does; 2월 29일 only in leap years). */
export function isValidLocalDate(date: LocalDate): boolean {
  return (
    Number.isInteger(date.year) &&
    Number.isInteger(date.month) &&
    Number.isInteger(date.day) &&
    date.year >= 1970 &&
    date.year <= 9999 &&
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= daysInMonth(date.year, date.month)
  );
}

/** `date` shifted by `days` calendar days (month/year rollover and leap days handled by `Date.UTC`). */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Compare two calendar dates: negative if `a` is earlier, 0 if equal, positive if later. */
export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

/**
 * The instant of wall-clock `local` in `timeZone`. Two-pass offset resolution: every distinct offset in force
 * around the wall-clock time yields a candidate, a candidate counts when it reads back as `local`, the earliest
 * matching candidate wins (AMBIGUOUS when two match); with none (a DST gap) the pre-transition offset is used,
 * which lands the gap length later (NONEXISTENT).
 */
export function zonedToUtc(local: LocalDateTime, timeZone: string): ResolvedInstant {
  const wallAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>([
    offsetMinutesAt(wallAsUtc - MS_PER_DAY, timeZone),
    offsetMinutesAt(wallAsUtc, timeZone),
    offsetMinutesAt(wallAsUtc + MS_PER_DAY, timeZone),
  ]);
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = wallAsUtc - offset * MS_PER_MINUTE;
    if (sameLocal(toZonedDateTime(candidate, timeZone), local)) matches.push(candidate);
  }
  matches.sort((a, b) => a - b);
  const earliest = matches[0];
  if (earliest !== undefined) {
    return { epochMs: earliest, resolution: matches.length > 1 ? 'AMBIGUOUS' : 'EXACT' };
  }
  const before = offsetMinutesAt(wallAsUtc - MS_PER_DAY, timeZone);
  return { epochMs: wallAsUtc - before * MS_PER_MINUTE, resolution: 'NONEXISTENT' };
}

/** `zonedToUtc` as an ISO timestamp (resolution dropped). */
export function zonedToUtcIso(local: LocalDateTime, timeZone: string): IsoTimestamp {
  return new Date(zonedToUtc(local, timeZone).epochMs).toISOString();
}

/** The calendar date of `instant` in `timeZone`. */
export function localDateOf(instant: IsoTimestamp | number | Date, timeZone: string): LocalDate {
  const z = toZonedDateTime(instant, timeZone);
  return { year: z.year, month: z.month, day: z.day };
}
