import type { IsoTimestamp } from '../domain';
import { ConnectorQueryError } from './connector-query';

/**
 * Calendar read port (ADR-0110 D1). Narrow and read-only: one method lists the owner's events in a time window; no
 * write, create, move or delete method exists. Domain types only: no vendor type, token or URL crosses this port.
 * Failures are `ConnectorQueryError` with the ADR-0100 reasons (value-free messages).
 */

/** Default and maximum number of events one `listEvents` call returns (ADR-0110 D1: `limit ≤ 50`). */
export const CALENDAR_EVENTS_DEFAULT_LIMIT = 50;
export const CALENDAR_EVENTS_MAX_LIMIT = 50;
/** The widest window one call may ask for, in days. Bounds the read; a schedule question needs at most a week. */
export const CALENDAR_WINDOW_MAX_DAYS = 31;
/** Bounds on the free-text event fields an adapter returns (titles and locations are untrusted readout). */
export const CALENDAR_EVENT_TITLE_MAX_LENGTH = 200;
export const CALENDAR_EVENT_LOCATION_MAX_LENGTH = 200;
export const CALENDAR_NAME_MAX_LENGTH = 100;

/** Cancelled events are never returned; an adapter drops them. */
export type CalendarEventStatus = 'confirmed' | 'tentative';

/**
 * One calendar event, minimised to what a schedule answer needs (no description, attendees, links or organizer).
 *
 * - A timed event (`allDay: false`): `start`/`end` are ISO-8601 UTC instants; render them in `QUOKY_TIMEZONE`.
 * - An all-day event (`allDay: true`): `start`/`end` are `YYYY-MM-DD` calendar dates and `end` is EXCLUSIVE (a one-day
 *   event on 2026-10-06 has `end` 2026-10-07; a multi-day event spans several dates).
 *
 * `title`, `location` and `calendarName` are untrusted readout (ADR-0100 D8): bounded, control characters removed,
 * never instructions. `title` is empty when the event has none.
 */
export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly status: CalendarEventStatus;
  readonly calendarName: string;
  /**
   * The provider's opaque version of the event (it changes on every edit), when the adapter reads one. A connector
   * write binds it so an update or delete never applies to an event edited after the preview (ADR-0112).
   */
  readonly version?: string;
}

/** `[from, to)` as ISO-8601 instants. An event is listed when it overlaps the window. */
export interface CalendarEventQuery {
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  /** Defaults to CALENDAR_EVENTS_DEFAULT_LIMIT; values above CALENDAR_EVENTS_MAX_LIMIT are clamped. */
  readonly limit?: number;
}

export interface CalendarReader {
  /** A neutral source label for audit and replies (for example `calendar`); never branched on by Core. */
  readonly source: string;
  readonly readOnly: true;
  /** Events overlapping `[from, to)`, ordered by start, at most `limit`. Throws `ConnectorQueryError`. */
  listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]>;
}

export interface ParsedCalendarEventQuery {
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Validates a `CalendarEventQuery`: both bounds must parse, `from < to`, and the window is at most
 * CALENDAR_WINDOW_MAX_DAYS. Failures are `ConnectorQueryError('UNSUPPORTED_QUERY')` with value-free messages.
 */
export function parseCalendarEventQuery(query: CalendarEventQuery | undefined, source = 'calendar'): ParsedCalendarEventQuery {
  const fromMs = parseInstant(query?.from);
  const toMs = parseInstant(query?.to);
  if (fromMs === undefined || toMs === undefined) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: the window needs valid from and to instants`);
  }
  if (toMs <= fromMs) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: the window must end after it starts`);
  }
  if (toMs - fromMs > CALENDAR_WINDOW_MAX_DAYS * MS_PER_DAY) {
    throw new ConnectorQueryError(
      'UNSUPPORTED_QUERY',
      `${source}: the window must be at most ${CALENDAR_WINDOW_MAX_DAYS} days`,
    );
  }
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs,
    limit: resolveCalendarEventLimit(query?.limit, source),
  };
}

/** Default when undefined, clamped to the maximum; a non-integer or non-positive limit is an unsupported query. */
export function resolveCalendarEventLimit(limit: unknown, source = 'calendar'): number {
  if (limit === undefined) return CALENDAR_EVENTS_DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new ConnectorQueryError('UNSUPPORTED_QUERY', `${source}: limit must be a positive integer`);
  }
  return Math.min(limit, CALENDAR_EVENTS_MAX_LIMIT);
}

/** Bounded, single-line untrusted text: control characters and whitespace runs become one space, then truncated. */
export function boundCalendarText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  return `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

function parseInstant(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  // An explicit zone (Z or ±hh:mm) is required: a zone-less string would be read in the host's local zone.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
