import { describe, expect, it } from 'vitest';
import type { ReminderSchedule } from '../../domain';
import { decideMissedOccurrence, latestOccurrenceAtOrBefore, nextOccurrenceAfter } from './reminder-schedule';

const SEOUL = 'Asia/Seoul';
const NEW_YORK = 'America/New_York';

const daily = (hour: number, minute = 0): ReminderSchedule => ({ type: 'DAILY', time: { hour, minute } });
const weekly = (weekdays: Array<0 | 1 | 2 | 3 | 4 | 5 | 6>, hour: number, minute = 0): ReminderSchedule => ({
  type: 'WEEKLY',
  time: { hour, minute },
  weekdays,
});

describe('nextOccurrenceAfter', () => {
  it.each([
    // [schedule, zone, after, expected]
    [{ type: 'ONCE', at: '2026-10-03T00:00:00.000Z' }, SEOUL, '2026-10-02T05:00:00.000Z', '2026-10-03T00:00:00.000Z'],
    [{ type: 'ONCE', at: '2026-10-03T00:00:00.000Z' }, SEOUL, '2026-10-03T00:00:00.000Z', null], // strictly after
    [{ type: 'ONCE', at: '2026-10-01T00:00:00.000Z' }, SEOUL, '2026-10-02T05:00:00.000Z', null],
    // DAILY 08:00 KST (= 23:00Z the previous UTC day)
    [daily(8), SEOUL, '2026-10-02T05:00:00.000Z', '2026-10-02T23:00:00.000Z'],
    [daily(8), SEOUL, '2026-10-02T23:00:00.000Z', '2026-10-03T23:00:00.000Z'],
    [daily(8), SEOUL, '2026-10-02T22:59:59.000Z', '2026-10-02T23:00:00.000Z'],
    // DAILY 00:00 KST (자정) across a month end
    [daily(0), SEOUL, '2026-10-31T14:00:00.000Z', '2026-10-31T15:00:00.000Z'],
    // year rollover: 2026-12-31 22:00Z = 2027-01-01 07:00 KST
    [daily(8), SEOUL, '2026-12-31T22:00:00.000Z', '2026-12-31T23:00:00.000Z'],
    [daily(23, 59), SEOUL, '2026-12-31T15:00:00.000Z', '2027-01-01T14:59:00.000Z'],
    // WEEKLY weekdays 09:00 from Friday 14:00 KST → Monday
    [weekly([1, 2, 3, 4, 5], 9), SEOUL, '2026-10-02T05:00:00.000Z', '2026-10-05T00:00:00.000Z'],
    // WEEKLY Sunday 10:00 from Friday
    [weekly([0], 10), SEOUL, '2026-10-02T05:00:00.000Z', '2026-10-04T01:00:00.000Z'],
    // WEEKLY Friday 15:00 from Friday 14:00 → today
    [weekly([5], 15), SEOUL, '2026-10-02T05:00:00.000Z', '2026-10-02T06:00:00.000Z'],
    // WEEKLY Friday 13:00 from Friday 14:00 → next Friday
    [weekly([5], 13), SEOUL, '2026-10-02T05:00:00.000Z', '2026-10-09T04:00:00.000Z'],
    // leap day is an ordinary Tuesday occurrence
    [weekly([2], 9), SEOUL, '2028-02-27T00:00:00.000Z', '2028-02-29T00:00:00.000Z'],
  ] as const)('%j in %s after %s', (schedule, zone, after, expected) => {
    expect(nextOccurrenceAfter(schedule as ReminderSchedule, zone, after)).toBe(expected);
  });

  it('DST spring-forward: a gap wall-clock time fires the gap length later, once that day', () => {
    const s = daily(2, 30);
    const first = nextOccurrenceAfter(s, NEW_YORK, '2026-03-07T12:00:00.000Z');
    expect(first).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    expect(nextOccurrenceAfter(s, NEW_YORK, first ?? '')).toBe('2026-03-09T06:30:00.000Z'); // 02:30 EDT
  });

  it('DST fall-back: an overlap wall-clock time fires once, at the earlier instant', () => {
    const s = daily(1, 30);
    const first = nextOccurrenceAfter(s, NEW_YORK, '2026-10-31T12:00:00.000Z');
    expect(first).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(nextOccurrenceAfter(s, NEW_YORK, first ?? '')).toBe('2026-11-02T06:30:00.000Z'); // 01:30 EST next day
  });
});

describe('latestOccurrenceAtOrBefore', () => {
  it.each([
    [daily(8), '2026-10-02T05:00:00.000Z', '2026-10-01T23:00:00.000Z'],
    [daily(8), '2026-10-01T23:00:00.000Z', '2026-10-01T23:00:00.000Z'], // at-or-before is inclusive
    [weekly([1], 9), '2026-10-02T05:00:00.000Z', '2026-09-28T00:00:00.000Z'],
    [{ type: 'ONCE', at: '2026-10-01T00:00:00.000Z' }, '2026-10-02T05:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    [{ type: 'ONCE', at: '2026-10-03T00:00:00.000Z' }, '2026-10-02T05:00:00.000Z', null],
    [daily(23, 59), '2027-01-01T00:30:00.000Z', '2026-12-31T14:59:00.000Z'], // previous year
  ] as const)('%j at or before %s', (schedule, at, expected) => {
    expect(latestOccurrenceAtOrBefore(schedule as ReminderSchedule, SEOUL, at)).toBe(expected);
  });
});

describe('decideMissedOccurrence (ADR-0101 D6 missed-reminder policy)', () => {
  const once = (at: string): ReminderSchedule => ({ type: 'ONCE', at });

  it('a ONCE reminder is always delivered once; late beyond the label threshold', () => {
    const at = '2026-10-02T05:00:00.000Z';
    expect(decideMissedOccurrence({ schedule: once(at), timeZone: SEOUL, occurrenceAt: at }, '2026-10-02T05:00:15.000Z')).toEqual({
      action: 'DELIVER',
      occurrenceAt: at,
      late: false,
    });
    expect(decideMissedOccurrence({ schedule: once(at), timeZone: SEOUL, occurrenceAt: at }, '2026-10-02T05:10:00.000Z')).toEqual({
      action: 'DELIVER',
      occurrenceAt: at,
      late: true,
    });
    // down for three days: still delivered exactly once, labelled late
    expect(decideMissedOccurrence({ schedule: once(at), timeZone: SEOUL, occurrenceAt: at }, '2026-10-05T05:00:00.000Z')).toEqual({
      action: 'DELIVER',
      occurrenceAt: at,
      late: true,
    });
  });

  const occurrence = '2026-10-01T23:00:00.000Z'; // DAILY 08:00 KST on 10-02

  it.each([
    ['on time', '2026-10-01T23:00:10.000Z', { action: 'DELIVER', occurrenceAt: occurrence, late: false }],
    ['30 minutes late (catch-up)', '2026-10-01T23:30:00.000Z', { action: 'DELIVER', occurrenceAt: occurrence, late: true }],
    ['exactly 60 minutes late (catch-up boundary)', '2026-10-02T00:00:00.000Z', { action: 'DELIVER', occurrenceAt: occurrence, late: true }],
    [
      '61 minutes late (skipped)',
      '2026-10-02T00:01:00.000Z',
      { action: 'SKIP', skippedOccurrenceAt: occurrence, nextOccurrenceAt: '2026-10-02T23:00:00.000Z' },
    ],
  ] as const)('recurring %s', (_label, now, expected) => {
    expect(decideMissedOccurrence({ schedule: daily(8), timeZone: SEOUL, occurrenceAt: occurrence }, now)).toEqual(expected);
  });

  it('recurring after a long outage: one catch-up of the latest occurrence only, never a replay', () => {
    const stale = '2026-09-28T23:00:00.000Z'; // 3 days earlier
    expect(decideMissedOccurrence({ schedule: daily(8), timeZone: SEOUL, occurrenceAt: stale }, '2026-10-01T23:20:00.000Z')).toEqual({
      action: 'DELIVER',
      occurrenceAt: '2026-10-01T23:00:00.000Z',
      late: true,
    });
    expect(decideMissedOccurrence({ schedule: daily(8), timeZone: SEOUL, occurrenceAt: stale }, '2026-10-02T01:00:00.000Z')).toEqual({
      action: 'SKIP',
      skippedOccurrenceAt: '2026-10-01T23:00:00.000Z',
      nextOccurrenceAt: '2026-10-02T23:00:00.000Z',
    });
  });

  it('a retry of the current recurring occurrence stays within its catch-up window', () => {
    // retry fired at +21 minutes (1 + 5 + 15)
    expect(decideMissedOccurrence({ schedule: daily(8), timeZone: SEOUL, occurrenceAt: occurrence }, '2026-10-01T23:21:00.000Z')).toEqual({
      action: 'DELIVER',
      occurrenceAt: occurrence,
      late: true,
    });
  });
});
