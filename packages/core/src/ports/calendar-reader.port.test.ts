import { describe, expect, it } from 'vitest';
import {
  CALENDAR_EVENTS_DEFAULT_LIMIT,
  CALENDAR_EVENTS_MAX_LIMIT,
  boundCalendarText,
  parseCalendarEventQuery,
} from './calendar-reader.port';
import { ConnectorQueryError } from './connector-query';
import { CALENDAR_READER } from './tokens';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConnectorQueryError ? error.reason : 'not-a-connector-error';
  }
  return undefined;
}

describe('CalendarReader port (ADR-0110 D1)', () => {
  it('exposes a dedicated DI token', () => {
    expect(typeof CALENDAR_READER).toBe('symbol');
    expect(CALENDAR_READER.description).toBe('CalendarReader');
  });

  it('normalizes a valid window to UTC instants with the default limit', () => {
    const parsed = parseCalendarEventQuery({ from: '2026-10-06T00:00:00+09:00', to: '2026-10-07T00:00:00+09:00' });
    expect(parsed).toEqual({
      from: '2026-10-05T15:00:00.000Z',
      to: '2026-10-06T15:00:00.000Z',
      fromMs: Date.parse('2026-10-05T15:00:00.000Z'),
      toMs: Date.parse('2026-10-06T15:00:00.000Z'),
      limit: CALENDAR_EVENTS_DEFAULT_LIMIT,
    });
  });

  it('clamps the limit to 50 and refuses a non-positive or fractional limit', () => {
    const window = { from: '2026-10-06T00:00:00Z', to: '2026-10-07T00:00:00Z' };
    expect(parseCalendarEventQuery({ ...window, limit: 500 }).limit).toBe(CALENDAR_EVENTS_MAX_LIMIT);
    expect(parseCalendarEventQuery({ ...window, limit: 3 }).limit).toBe(3);
    expect(reasonOf(() => parseCalendarEventQuery({ ...window, limit: 0 }))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseCalendarEventQuery({ ...window, limit: 1.5 }))).toBe('UNSUPPORTED_QUERY');
  });

  it('refuses missing, zone-less, reversed, empty and over-long windows as UNSUPPORTED_QUERY', () => {
    expect(reasonOf(() => parseCalendarEventQuery(undefined))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseCalendarEventQuery({ from: 'tomorrow', to: '2026-10-07T00:00:00Z' }))).toBe('UNSUPPORTED_QUERY');
    expect(reasonOf(() => parseCalendarEventQuery({ from: '2026-10-06T00:00:00', to: '2026-10-07T00:00:00' }))).toBe(
      'UNSUPPORTED_QUERY',
    );
    expect(reasonOf(() => parseCalendarEventQuery({ from: '2026-10-07T00:00:00Z', to: '2026-10-06T00:00:00Z' }))).toBe(
      'UNSUPPORTED_QUERY',
    );
    expect(reasonOf(() => parseCalendarEventQuery({ from: '2026-10-06T00:00:00Z', to: '2026-10-06T00:00:00Z' }))).toBe(
      'UNSUPPORTED_QUERY',
    );
    expect(reasonOf(() => parseCalendarEventQuery({ from: '2026-10-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }))).toBe(
      'UNSUPPORTED_QUERY',
    );
    expect(parseCalendarEventQuery({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }).limit).toBe(50);
  });

  it('keeps failure messages value-free', () => {
    try {
      parseCalendarEventQuery({ from: 'secret-looking-value', to: '2026-10-07T00:00:00Z' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-looking-value');
    }
  });

  it('bounds untrusted text to one line and a maximum length', () => {
    expect(boundCalendarText('  팀\n회의\t\u0007 ', 50)).toBe('팀 회의');
    expect(boundCalendarText('a b', 50)).toBe('a b');
    expect(boundCalendarText(undefined, 50)).toBe('');
    expect(boundCalendarText(42, 50)).toBe('');
    const long = boundCalendarText('가'.repeat(300), 200);
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
