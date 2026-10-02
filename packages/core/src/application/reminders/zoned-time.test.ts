import { describe, expect, it } from 'vitest';
import {
  REMINDER_DEFAULT_TIME_ZONE,
  addLocalDays,
  compareLocalDates,
  daysInMonth,
  isValidLocalDate,
  isValidTimeZone,
  localDateOf,
  offsetMinutesAt,
  toZonedDateTime,
  weekdayOf,
  zonedToUtc,
  zonedToUtcIso,
} from './zoned-time';

const SEOUL = 'Asia/Seoul';
const NEW_YORK = 'America/New_York';

describe('zoned-time — zone validation and defaults', () => {
  it('defaults to Asia/Seoul', () => {
    expect(REMINDER_DEFAULT_TIME_ZONE).toBe('Asia/Seoul');
  });

  it.each([
    ['Asia/Seoul', true],
    ['America/New_York', true],
    ['UTC', true],
    ['Not/AZone', false],
    ['', false],
  ])('isValidTimeZone(%j) = %s', (zone, expected) => {
    expect(isValidTimeZone(zone)).toBe(expected);
  });
});

describe('zoned-time — instant → wall clock', () => {
  it.each([
    // [instant, zone, y, m, d, h, min, weekday]
    ['2026-10-02T05:00:00.000Z', SEOUL, 2026, 10, 2, 14, 0, 5],
    ['2026-10-02T15:00:00.000Z', SEOUL, 2026, 10, 3, 0, 0, 6], // KST midnight reads as hour 0, never 24
    ['2026-12-31T15:00:00.000Z', SEOUL, 2027, 1, 1, 0, 0, 5], // year rollover at KST midnight
    ['2026-12-31T14:59:00.000Z', SEOUL, 2026, 12, 31, 23, 59, 4],
    ['2028-02-28T15:00:00.000Z', SEOUL, 2028, 2, 29, 0, 0, 2], // leap day
    ['2026-07-01T12:00:00.000Z', NEW_YORK, 2026, 7, 1, 8, 0, 3], // EDT
    ['2026-01-15T12:00:00.000Z', NEW_YORK, 2026, 1, 15, 7, 0, 4], // EST
  ] as const)('%s in %s', (instant, zone, year, month, day, hour, minute, weekday) => {
    expect(toZonedDateTime(instant, zone)).toEqual({ year, month, day, hour, minute, second: 0, weekday });
    expect(localDateOf(instant, zone)).toEqual({ year, month, day });
  });

  it('reports the UTC offset in minutes', () => {
    expect(offsetMinutesAt(Date.parse('2026-10-02T05:00:00Z'), SEOUL)).toBe(540);
    expect(offsetMinutesAt(Date.parse('2026-07-01T12:00:00Z'), NEW_YORK)).toBe(-240);
    expect(offsetMinutesAt(Date.parse('2026-01-15T12:00:00Z'), NEW_YORK)).toBe(-300);
  });

  it('rejects an unparseable instant', () => {
    expect(() => toZonedDateTime('not a date', SEOUL)).toThrow(RangeError);
  });
});

describe('zoned-time — wall clock → instant', () => {
  it.each([
    [{ year: 2026, month: 10, day: 3, hour: 9, minute: 0 }, '2026-10-03T00:00:00.000Z'],
    [{ year: 2026, month: 10, day: 3, hour: 0, minute: 0 }, '2026-10-02T15:00:00.000Z'],
    [{ year: 2027, month: 1, day: 1, hour: 0, minute: 0 }, '2026-12-31T15:00:00.000Z'],
    [{ year: 2028, month: 2, day: 29, hour: 12, minute: 30 }, '2028-02-29T03:30:00.000Z'],
  ])('Asia/Seoul %j (no DST: always EXACT)', (local, iso) => {
    expect(zonedToUtc(local, SEOUL)).toEqual({ epochMs: Date.parse(iso), resolution: 'EXACT' });
    expect(zonedToUtcIso(local, SEOUL)).toBe(iso);
  });

  it('America/New_York spring-forward: a gap time is NONEXISTENT and shifts forward by the gap', () => {
    // 2026-03-08: 02:00 EST → 03:00 EDT.
    expect(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK)).toEqual({
      epochMs: Date.parse('2026-03-08T07:30:00Z'), // 03:30 EDT
      resolution: 'NONEXISTENT',
    });
    expect(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, NEW_YORK)).toEqual({
      epochMs: Date.parse('2026-03-08T06:59:00Z'),
      resolution: 'EXACT',
    });
    expect(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, NEW_YORK)).toEqual({
      epochMs: Date.parse('2026-03-08T07:00:00Z'),
      resolution: 'EXACT',
    });
  });

  it('America/New_York fall-back: an overlap time is AMBIGUOUS and resolves to the earlier instant', () => {
    // 2026-11-01: 02:00 EDT → 01:00 EST; 01:30 happens twice.
    expect(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NEW_YORK)).toEqual({
      epochMs: Date.parse('2026-11-01T05:30:00Z'), // 01:30 EDT
      resolution: 'AMBIGUOUS',
    });
    expect(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 2, minute: 30 }, NEW_YORK)).toEqual({
      epochMs: Date.parse('2026-11-01T07:30:00Z'),
      resolution: 'EXACT',
    });
  });
});

describe('zoned-time — calendar arithmetic', () => {
  it.each([
    [{ year: 2026, month: 12, day: 31 }, 1, { year: 2027, month: 1, day: 1 }],
    [{ year: 2026, month: 10, day: 31 }, 1, { year: 2026, month: 11, day: 1 }],
    [{ year: 2028, month: 2, day: 28 }, 1, { year: 2028, month: 2, day: 29 }],
    [{ year: 2027, month: 2, day: 28 }, 1, { year: 2027, month: 3, day: 1 }],
    [{ year: 2026, month: 3, day: 1 }, -1, { year: 2026, month: 2, day: 28 }],
    [{ year: 2026, month: 10, day: 2 }, 366, { year: 2027, month: 10, day: 3 }],
  ])('addLocalDays(%j, %i)', (date, days, expected) => {
    expect(addLocalDays(date, days)).toEqual(expected);
  });

  it.each([
    [{ year: 2028, month: 2, day: 29 }, true],
    [{ year: 2027, month: 2, day: 29 }, false],
    [{ year: 2100, month: 2, day: 29 }, false],
    [{ year: 2000, month: 2, day: 29 }, true],
    [{ year: 2026, month: 2, day: 30 }, false],
    [{ year: 2026, month: 4, day: 31 }, false],
    [{ year: 2026, month: 13, day: 1 }, false],
    [{ year: 2026, month: 0, day: 1 }, false],
    [{ year: 2026, month: 12, day: 31 }, true],
  ])('isValidLocalDate(%j) = %s', (date, expected) => {
    expect(isValidLocalDate(date)).toBe(expected);
  });

  it('daysInMonth, weekdayOf and compareLocalDates', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(weekdayOf({ year: 2026, month: 10, day: 2 })).toBe(5); // Friday
    expect(weekdayOf({ year: 2026, month: 10, day: 4 })).toBe(0); // Sunday
    expect(compareLocalDates({ year: 2026, month: 12, day: 31 }, { year: 2027, month: 1, day: 1 })).toBeLessThan(0);
    expect(compareLocalDates({ year: 2026, month: 1, day: 1 }, { year: 2026, month: 1, day: 1 })).toBe(0);
  });
});
