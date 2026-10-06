import {
  CALENDAR_EVENT_LOCATION_MAX_LENGTH,
  CALENDAR_EVENT_TITLE_MAX_LENGTH,
  CALENDAR_NAME_MAX_LENGTH,
  boundCalendarText,
  isValidTimeZone,
  parseCalendarEventQuery,
  resolveConnectorQueryTimeoutMs,
  toConnectorDueDate,
  zonedToUtc,
  type CalendarEvent,
  type CalendarEventQuery,
  type CalendarReader,
  type ConnectorQueryErrorReason,
} from '@quoky/core';
import { GoogleCalendarHttpError, GoogleCalendarRequestError, GoogleCalendarResponseError } from './errors';
import { refreshGoogleAccessToken, type GoogleAccessToken } from './oauth';

/** Every Calendar API call goes to this origin (ADR-0110 D2: egress to googleapis.com / oauth2.googleapis.com only). */
export const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com';
/** The minimised partial response (ADR-0110 D1): no description, attendees, organizer, links or conference data. */
export const GOOGLE_CALENDAR_EVENT_FIELDS =
  'summary,nextPageToken,items(id,status,summary,location,start(date,dateTime),end(date,dateTime))';
export const GOOGLE_CALENDAR_MAX_CALENDARS = 10;
/** Pages followed per calendar per call; with `limit ≤ 50` events per page this bounds one read. */
const MAX_PAGES_PER_CALENDAR = 5;
/** An access token is refreshed this long before Google says it expires. */
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const CALENDAR_ID_MAX_LENGTH = 256;
const EVENT_ID_MAX_LENGTH = 1024;
const PAGE_TOKEN_MAX_LENGTH = 2048;

export interface GoogleCalendarReaderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** IANA zone (`QUOKY_TIMEZONE`): all-day dates are placed in it when a window is checked. */
  readonly timeZone: string;
  /** Calendar ids to read (default `['primary']`, at most 10). */
  readonly calendarIds?: readonly string[];
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000), applied to every token and Calendar call. */
  readonly timeoutMs?: number;
  /** Injectable clock for the access-token expiry. */
  readonly nowMs?: () => number;
}

interface GoogleEventTime {
  date?: unknown;
  dateTime?: unknown;
}

interface MappedEvent {
  readonly event: CalendarEvent;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Read-only Google Calendar adapter for the `CalendarReader` port (ADR-0110 D1/D2). GET requests only; the grant must
 * hold `calendar.readonly` and nothing broader than `calendar.events` (ADR-0110 amendment D1 — that scope is for the
 * wave-5 writer, never used here); a timeout on every call, redirects refused. The access token lives in memory only; the
 * refresh token, client secret and access token are never logged and never appear in an error.
 */
export class GoogleCalendarReader implements CalendarReader {
  readonly source = 'calendar';
  readonly readOnly = true as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly timeZone: string;
  private readonly calendarIds: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;
  private accessToken: GoogleAccessToken | undefined;
  private pendingRefresh: Promise<GoogleAccessToken> | undefined;

  constructor(config: GoogleCalendarReaderConfig) {
    this.clientId = requireNonEmpty(config?.clientId, 'client id');
    this.clientSecret = requireNonEmpty(config?.clientSecret, 'client secret');
    this.refreshToken = requireNonEmpty(config?.refreshToken, 'refresh token');
    if (typeof config.timeZone !== 'string' || !isValidTimeZone(config.timeZone)) {
      throw new Error('google calendar: a valid IANA time zone is required');
    }
    this.timeZone = config.timeZone;
    this.calendarIds = normalizeCalendarIds(config.calendarIds);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'google calendar');
    this.nowMs = config.nowMs ?? Date.now;
  }

  async listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]> {
    const window = parseCalendarEventQuery(query, 'google calendar');
    const collected: MappedEvent[] = [];
    for (const calendarId of this.calendarIds) {
      collected.push(...(await this.listCalendar(calendarId, window)));
    }
    collected.sort(compareMappedEvents);
    return collected.slice(0, window.limit).map((entry) => entry.event);
  }

  private async listCalendar(
    calendarId: string,
    window: { from: string; to: string; fromMs: number; toMs: number; limit: number },
  ): Promise<MappedEvent[]> {
    const events: MappedEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_CALENDAR; page += 1) {
      const url = new URL(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, GOOGLE_CALENDAR_API_ORIGIN);
      url.searchParams.set('timeMin', window.from);
      url.searchParams.set('timeMax', window.to);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('showDeleted', 'false');
      url.searchParams.set('maxResults', String(window.limit));
      url.searchParams.set('timeZone', this.timeZone);
      url.searchParams.set('fields', GOOGLE_CALENDAR_EVENT_FIELDS);
      if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);

      const payload = await this.getJson(url);
      const calendarName = boundCalendarText(payload.summary, CALENDAR_NAME_MAX_LENGTH) || 'calendar';
      // A partial response omits an empty `items` array.
      const items = payload.items === undefined ? [] : payload.items;
      if (!Array.isArray(items)) throw new GoogleCalendarResponseError('calendar');
      for (const item of items) {
        const mapped = this.mapEvent(item, calendarName);
        if (mapped !== undefined && mapped.endMs > window.fromMs && mapped.startMs < window.toMs) events.push(mapped);
      }

      const next = payload.nextPageToken;
      if (next === undefined || events.length >= window.limit) break;
      if (typeof next !== 'string' || next.length === 0 || next.length > PAGE_TOKEN_MAX_LENGTH) {
        throw new GoogleCalendarResponseError('calendar');
      }
      pageToken = next;
    }
    return events.slice(0, window.limit);
  }

  /** One GET with the cached access token; a 401 refreshes once and retries once. */
  private async getJson(url: URL): Promise<Record<string, unknown>> {
    let response = await this.get(url, await this.currentAccessToken());
    if (response.status === 401) {
      await discardBody(response);
      this.accessToken = undefined;
      response = await this.get(url, await this.currentAccessToken());
    }
    if (!response.ok) {
      throw new GoogleCalendarHttpError(await calendarErrorReason(response), 'calendar', response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GoogleCalendarResponseError('calendar');
    }
    if (!isRecord(payload)) throw new GoogleCalendarResponseError('calendar');
    return payload;
  }

  private async get(url: URL, accessToken: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GoogleCalendarRequestError('calendar');
    }
  }

  private async currentAccessToken(): Promise<string> {
    const cached = this.accessToken;
    if (cached !== undefined && cached.expiresAtMs - ACCESS_TOKEN_EXPIRY_SKEW_MS > this.nowMs()) return cached.token;
    // Concurrent calls share one refresh.
    if (this.pendingRefresh === undefined) {
      this.pendingRefresh = refreshGoogleAccessToken(
        { clientId: this.clientId, clientSecret: this.clientSecret },
        this.refreshToken,
        { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, nowMs: this.nowMs() },
      ).finally(() => {
        this.pendingRefresh = undefined;
      });
    }
    const fresh = await this.pendingRefresh;
    this.accessToken = fresh;
    return fresh.token;
  }

  private mapEvent(value: unknown, calendarName: string): MappedEvent | undefined {
    if (!isRecord(value)) throw new GoogleCalendarResponseError('calendar');
    if (value.status === 'cancelled') return undefined;
    const id = value.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > EVENT_ID_MAX_LENGTH) {
      throw new GoogleCalendarResponseError('calendar');
    }
    const start = isRecord(value.start) ? (value.start as GoogleEventTime) : undefined;
    const end = isRecord(value.end) ? (value.end as GoogleEventTime) : undefined;
    if (start === undefined || end === undefined) throw new GoogleCalendarResponseError('calendar');

    const allDay = start.date !== undefined;
    let startText: string;
    let endText: string;
    let startMs: number;
    let endMs: number;
    if (allDay) {
      const startDate = toConnectorDueDate(start.date);
      const endDate = toConnectorDueDate(end.date);
      if (startDate === undefined || endDate === undefined || endDate <= startDate) {
        throw new GoogleCalendarResponseError('calendar');
      }
      startText = startDate;
      endText = endDate;
      startMs = this.localMidnightMs(startDate);
      endMs = this.localMidnightMs(endDate);
    } else {
      startMs = parseDateTime(start.dateTime);
      endMs = parseDateTime(end.dateTime);
      if (endMs < startMs) throw new GoogleCalendarResponseError('calendar');
      startText = new Date(startMs).toISOString();
      endText = new Date(endMs).toISOString();
    }

    const location = boundCalendarText(value.location, CALENDAR_EVENT_LOCATION_MAX_LENGTH);
    const event: CalendarEvent = {
      id,
      title: boundCalendarText(value.summary, CALENDAR_EVENT_TITLE_MAX_LENGTH),
      start: startText,
      end: endText,
      allDay,
      ...(location.length > 0 ? { location } : {}),
      status: value.status === 'tentative' ? 'tentative' : 'confirmed',
      calendarName,
    };
    // A zero-length timed event still occupies its start instant.
    return { event, startMs, endMs: endMs === startMs ? endMs + 1 : endMs };
  }

  private localMidnightMs(date: string): number {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    return zonedToUtc({ year, month, day, hour: 0, minute: 0 }, this.timeZone).epochMs;
  }
}

/** All-day events first within the same start, then by start, end and title. */
function compareMappedEvents(a: MappedEvent, b: MappedEvent): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
  if (a.endMs !== b.endMs) return a.endMs - b.endMs;
  return a.event.title < b.event.title ? -1 : a.event.title > b.event.title ? 1 : 0;
}

/** A timed event's RFC 3339 `dateTime`, which always carries an offset. */
function parseDateTime(value: unknown): number {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new GoogleCalendarResponseError('calendar');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new GoogleCalendarResponseError('calendar');
  return ms;
}

/**
 * Calendar API errors: 401 → `UNAUTHORIZED`, 404 → `NOT_FOUND` (an unknown calendar id), 429 → `RATE_LIMITED`,
 * 5xx → `UNAVAILABLE`. A 403 is read for its fixed `reason` token only: rate and quota reasons → `RATE_LIMITED`,
 * insufficient permissions or scope → `INSUFFICIENT_SCOPE`, anything else → `FORBIDDEN`.
 */
async function calendarErrorReason(response: Response): Promise<ConnectorQueryErrorReason> {
  const status = response.status;
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status !== 403) return 'UNAVAILABLE';
  const reasons = await readGoogleErrorReasons(response);
  if (reasons.some((reason) => /^(?:rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RATE_LIMIT_EXCEEDED)$/.test(reason))) {
    return 'RATE_LIMITED';
  }
  if (reasons.some((reason) => /^(?:insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT)$/.test(reason))) {
    return 'INSUFFICIENT_SCOPE';
  }
  return 'FORBIDDEN';
}

/** The `reason` tokens of a Google error body (`error.errors[].reason`, `error.details[].reason`); nothing else. */
async function readGoogleErrorReasons(response: Response): Promise<string[]> {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    if (error === undefined) return [];
    const entries = [
      ...(Array.isArray(error.errors) ? error.errors : []),
      ...(Array.isArray(error.details) ? error.details : []),
    ];
    return entries
      .map((entry) => (isRecord(entry) ? entry.reason : undefined))
      .filter((reason): reason is string => typeof reason === 'string' && /^[A-Za-z_]{1,64}$/.test(reason));
  } catch {
    return [];
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore: the body is never read
  }
}

function normalizeCalendarIds(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return ['primary'];
  if (!Array.isArray(value) || value.length === 0 || value.length > GOOGLE_CALENDAR_MAX_CALENDARS) {
    throw new Error(`google calendar: 1 to ${GOOGLE_CALENDAR_MAX_CALENDARS} calendar ids are required`);
  }
  const ids = value.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (ids.some((id) => !isValidCalendarId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('google calendar: calendar ids must be distinct, non-empty and printable');
  }
  return ids;
}

/** `primary` or a calendar id such as an address or `…@group.calendar.google.com`: printable, no spaces or slashes. */
export function isValidCalendarId(id: string): boolean {
  return id.length > 0 && id.length <= CALENDAR_ID_MAX_LENGTH && /^[A-Za-z0-9._%+@#-]+$/.test(id);
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`google calendar: a non-empty ${label} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
