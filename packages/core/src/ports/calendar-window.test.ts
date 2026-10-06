import { describe, expect, it } from 'vitest';
import { calendarWindowForDate, calendarWindowForDays, resolveCalendarWindow } from './calendar-window';

describe('calendar windows in QUOKY_TIMEZONE (ADR-0110 D3)', () => {
  // 2026-10-06 is a Tuesday. 23:30 UTC on the 5th is already 08:30 on the 6th in Seoul (zone-boundary case).
  const nowUtcLateEvening = '2026-10-05T23:30:00.000Z';

  it('today and tomorrow are local midnight to local midnight in Asia/Seoul', () => {
    expect(resolveCalendarWindow('today', nowUtcLateEvening, 'Asia/Seoul')).toEqual({
      from: '2026-10-05T15:00:00.000Z',
      to: '2026-10-06T15:00:00.000Z',
    });
    expect(resolveCalendarWindow('tomorrow', nowUtcLateEvening, 'Asia/Seoul')).toEqual({
      from: '2026-10-06T15:00:00.000Z',
      to: '2026-10-07T15:00:00.000Z',
    });
  });

  it('the same instant is a different local day in UTC', () => {
    expect(resolveCalendarWindow('today', nowUtcLateEvening, 'UTC')).toEqual({
      from: '2026-10-05T00:00:00.000Z',
      to: '2026-10-06T00:00:00.000Z',
    });
  });

  it('this week runs Monday 00:00 to the next Monday 00:00, including from a Sunday', () => {
    expect(resolveCalendarWindow('this-week', nowUtcLateEvening, 'Asia/Seoul')).toEqual({
      from: '2026-10-04T15:00:00.000Z', // Monday 2026-10-05 00:00 KST
      to: '2026-10-11T15:00:00.000Z', // Monday 2026-10-12 00:00 KST
    });
    // Sunday 2026-10-11 22:00 KST still belongs to the week that started on Monday the 5th.
    expect(resolveCalendarWindow('this-week', '2026-10-11T13:00:00.000Z', 'Asia/Seoul').from).toBe('2026-10-04T15:00:00.000Z');
    // Monday 2026-10-12 00:30 KST starts a new week.
    expect(resolveCalendarWindow('this-week', '2026-10-11T15:30:00.000Z', 'Asia/Seoul').from).toBe('2026-10-11T15:00:00.000Z');
  });

  it('a day across a DST change is 23 or 25 hours long', () => {
    // America/New_York: spring forward on 2026-03-08, fall back on 2026-11-01.
    const spring = calendarWindowForDate({ year: 2026, month: 3, day: 8 }, 'America/New_York');
    expect(spring).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * 3_600_000);
    const fall = calendarWindowForDate({ year: 2026, month: 11, day: 1 }, 'America/New_York');
    expect(Date.parse(fall.to) - Date.parse(fall.from)).toBe(25 * 3_600_000);
  });

  it('crosses month and year ends', () => {
    expect(resolveCalendarWindow('tomorrow', '2026-12-31T03:00:00.000Z', 'Asia/Seoul')).toEqual({
      from: '2026-12-31T15:00:00.000Z',
      to: '2027-01-01T15:00:00.000Z',
    });
    expect(calendarWindowForDays({ year: 2028, month: 2, day: 28 }, 2, 'UTC')).toEqual({
      from: '2028-02-28T00:00:00.000Z',
      to: '2028-03-01T00:00:00.000Z',
    });
  });

  it('refuses an invalid zone, date or day count', () => {
    expect(() => resolveCalendarWindow('today', nowUtcLateEvening, 'Mars/Olympus')).toThrow(RangeError);
    expect(() => calendarWindowForDate({ year: 2026, month: 2, day: 30 }, 'Asia/Seoul')).toThrow(RangeError);
    expect(() => calendarWindowForDays({ year: 2026, month: 2, day: 1 }, 0, 'Asia/Seoul')).toThrow(RangeError);
  });
});
