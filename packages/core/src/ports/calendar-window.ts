import type { IsoTimestamp } from '../domain';
import {
  addLocalDays,
  isValidLocalDate,
  isValidTimeZone,
  localDateOf,
  weekdayOf,
  zonedToUtcIso,
  type LocalDate,
} from '../application/reminders/zoned-time';
import type { CalendarEventQuery } from './calendar-reader.port';

/**
 * Named calendar windows in the owner's zone (`QUOKY_TIMEZONE`, ADR-0110 D3). Pure: the current instant is always an
 * input; nothing here reads a clock. A day runs from local midnight to the next local midnight (23 or 25 hours across
 * a DST change); a week runs Monday 00:00 to the next Monday 00:00. The CAL-2 grammar maps phrases to these windows.
 */
export type CalendarNamedWindow = 'today' | 'tomorrow' | 'this-week';

/** `[from, to)` covering the local calendar dates `[firstDay, firstDay + days)` in `timeZone`. */
export function calendarWindowForDays(firstDay: LocalDate, days: number, timeZone: string): CalendarEventQuery {
  if (!isValidLocalDate(firstDay)) throw new RangeError('Invalid calendar date');
  if (!Number.isInteger(days) || days < 1) throw new RangeError('Invalid day count');
  assertTimeZone(timeZone);
  return { from: startOfLocalDay(firstDay, timeZone), to: startOfLocalDay(addLocalDays(firstDay, days), timeZone) };
}

/** The window for one local calendar date (a date or a weekday the owner named). */
export function calendarWindowForDate(date: LocalDate, timeZone: string): CalendarEventQuery {
  return calendarWindowForDays(date, 1, timeZone);
}

/** Today, tomorrow, or this Monday-to-Sunday week, as seen from `now` in `timeZone`. */
export function resolveCalendarWindow(
  name: CalendarNamedWindow,
  now: IsoTimestamp | number | Date,
  timeZone: string,
): CalendarEventQuery {
  assertTimeZone(timeZone);
  const today = localDateOf(now, timeZone);
  switch (name) {
    case 'today':
      return calendarWindowForDays(today, 1, timeZone);
    case 'tomorrow':
      return calendarWindowForDays(addLocalDays(today, 1), 1, timeZone);
    case 'this-week': {
      const daysSinceMonday = (weekdayOf(today) + 6) % 7;
      return calendarWindowForDays(addLocalDays(today, -daysSinceMonday), 7, timeZone);
    }
    default:
      throw new RangeError('Unknown calendar window');
  }
}

function startOfLocalDay(date: LocalDate, timeZone: string): IsoTimestamp {
  // A zone whose DST change skips midnight resolves forward to the first existing minute of the day.
  return zonedToUtcIso({ ...date, hour: 0, minute: 0 }, timeZone);
}

function assertTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) throw new RangeError('Invalid time zone');
}
