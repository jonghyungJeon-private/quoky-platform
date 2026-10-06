import { createHash } from 'node:crypto';
import {
  CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH,
  CALENDAR_EVENT_LOCATION_MAX_LENGTH,
  CALENDAR_EVENT_TITLE_MAX_LENGTH,
  CALENDAR_WINDOW_MAX_DAYS,
  ConnectorQueryError,
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  isValidConnectorWriteText,
  isValidTimeZone,
  resolveConnectorQueryTimeoutMs,
  type CalendarEventChanges,
  type CalendarEventCreateRequest,
  type CalendarEventDeleteRequest,
  type CalendarEventExpectation,
  type CalendarEventTime,
  type CalendarEventUpdateRequest,
  type CalendarEventWriter,
  type ConnectorWriteNotSentReason,
  type ConnectorWriteOutcome,
} from '@quoky/core';
import { GoogleCalendarScopeError } from './errors';
import { GOOGLE_CALENDAR_EVENTS_SCOPE, refreshGoogleAccessToken, type GoogleAccessToken } from './oauth';

/**
 * Google Calendar WRITE adapter for the `CalendarEventWriter` port (ADR-0110 amendment). A separate class from the
 * read-only `GoogleCalendarReader`; it needs a grant that includes `calendar.events` (and nothing outside
 * `calendar.readonly` + `calendar.events`).
 *
 * - Target: the owner's `primary` calendar only — the calendar id is a constant, never caller input.
 * - Every write passes `sendUpdates=none`, and no request ever sets attendees, conferencing or reminders.
 * - Update and delete first read the event and refuse a recurring series (single instances are allowed), and refuse an
 *   event that no longer matches the approved one (its entity tag, start, end, all-day shape):
 *   `NOT_SENT('TARGET_CHANGED')`. The bound entity tag is required — without a valid one nothing is read or written
 *   (`TARGET_CHANGED`) — and the write itself always carries `If-Match` with it, so an edit racing the pre-check is
 *   refused by Google (412) instead of overwritten.
 * - Create derives the provider event id from the idempotency key, so a repeated create cannot add a second event.
 * - One write request per call, with a timeout and redirects refused; no retry of the write. Nothing is logged, and no
 *   outcome or error carries a token, a secret, the payload or a response body.
 */

const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com';
const PRIMARY = 'primary';
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
/** A Google entity tag (quoted, printable ASCII). */
const ETAG = /^[\x21-\x7e]{1,200}$/;
const HTML_LINK = /^https:\/\/(?:www\.google\.com\/calendar\/|calendar\.google\.com\/)[\x21-\x7e]{1,1500}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MS_PER_DAY = 86_400_000;
/** Google event ids use base32hex (`0-9a-v`), 5..1024 characters. */
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
const EVENT_ID_DIGEST_DOMAIN = 'quoky.calendar.event-id.v1';

export interface GoogleCalendarWriterConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** A refresh token whose grant includes `calendar.events`. */
  readonly refreshToken: string;
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000), applied to every token and Calendar call. */
  readonly timeoutMs?: number;
  /** Injectable clock for the access-token expiry. */
  readonly nowMs?: () => number;
}

/** A write step failed before the write request left; carries the NOT_SENT reason. */
class NotSentError extends Error {
  constructor(readonly reason: ConnectorWriteNotSentReason) {
    super(`google calendar: write not sent (${reason.toLowerCase()})`);
  }
}

export class GoogleCalendarWriter implements CalendarEventWriter {
  readonly source = 'calendar';
  readonly target = PRIMARY;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nowMs: () => number;
  private accessToken: GoogleAccessToken | undefined;
  private pendingRefresh: Promise<GoogleAccessToken> | undefined;

  constructor(config: GoogleCalendarWriterConfig) {
    this.clientId = requireNonEmpty(config?.clientId, 'client id');
    this.clientSecret = requireNonEmpty(config?.clientSecret, 'client secret');
    this.refreshToken = requireNonEmpty(config?.refreshToken, 'refresh token');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'google calendar writer');
    this.nowMs = config.nowMs ?? Date.now;
  }

  async createEvent(request: CalendarEventCreateRequest): Promise<ConnectorWriteOutcome> {
    const draft = request?.draft;
    if (typeof request?.idempotencyKey !== 'string' || request.idempotencyKey.length < 8 || request.idempotencyKey.length > 200) {
      return connectorWriteNotSent('INVALID_REQUEST');
    }
    if (draft === undefined || !isValidTitle(draft.title) || !isValidTime(draft.time) || !optionalFieldsValid(draft)) {
      return connectorWriteNotSent('INVALID_REQUEST');
    }
    const body: Record<string, unknown> = {
      id: googleCalendarEventIdFor(request.idempotencyKey),
      summary: draft.title,
      ...timeBody(draft.time),
      ...(draft.location !== undefined ? { location: draft.location } : {}),
      ...(draft.description !== undefined ? { description: draft.description } : {}),
    };
    return this.write('POST', eventsUrl(), body, 'create');
  }

  async updateEvent(request: CalendarEventUpdateRequest): Promise<ConnectorWriteOutcome> {
    const changes = request?.changes;
    if (!isValidEventId(request?.eventId) || !isValidExpectation(request.expected) || changes === undefined || !changesValid(changes)) {
      return connectorWriteNotSent('INVALID_REQUEST');
    }
    // Never an unconditional write: without the approved version the event cannot be proven unchanged.
    if (!isValidVersion(request.expected.version)) return connectorWriteNotSent('TARGET_CHANGED');
    const refused = await this.precheckSingleEvent(request.eventId, request.expected);
    if (refused !== undefined) return refused;
    const body: Record<string, unknown> = {
      ...(changes.title !== undefined ? { summary: changes.title } : {}),
      ...(changes.time !== undefined ? timeBody(changes.time, true) : {}),
      ...(changes.location !== undefined ? { location: changes.location } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
    };
    return this.write('PATCH', eventsUrl(request.eventId), body, 'update', undefined, request.expected.version);
  }

  async deleteEvent(request: CalendarEventDeleteRequest): Promise<ConnectorWriteOutcome> {
    if (!isValidEventId(request?.eventId) || !isValidExpectation(request.expected)) return connectorWriteNotSent('INVALID_REQUEST');
    if (!isValidVersion(request.expected.version)) return connectorWriteNotSent('TARGET_CHANGED');
    const refused = await this.precheckSingleEvent(request.eventId, request.expected);
    if (refused !== undefined) return refused;
    return this.write('DELETE', eventsUrl(request.eventId), undefined, 'delete', request.eventId, request.expected.version);
  }

  /**
   * Reads the event before an update or delete: it must exist on the primary calendar, not be cancelled, not be a
   * recurring series (`recurrence` set), and still be the approved event (`expected`). Any failure here is NOT_SENT —
   * the write has not been sent.
   */
  private async precheckSingleEvent(eventId: string, expected: CalendarEventExpectation): Promise<ConnectorWriteOutcome | undefined> {
    const url = eventsUrl(eventId);
    url.searchParams.set('fields', 'id,etag,status,recurrence,recurringEventId,start(date,dateTime),end(date,dateTime)');
    let response: Response;
    try {
      response = await this.send('GET', url, undefined, await this.currentAccessToken());
      if (response.status === 401) {
        await discardBody(response);
        this.accessToken = undefined;
        response = await this.send('GET', url, undefined, await this.currentAccessToken());
      }
    } catch (error) {
      return connectorWriteNotSent(error instanceof NotSentError ? error.reason : 'UNAVAILABLE');
    }
    if (!response.ok) {
      await discardBody(response);
      return connectorWriteNotSent(precheckReason(response.status));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return connectorWriteNotSent('UNAVAILABLE');
    }
    if (!isRecord(payload) || typeof payload.id !== 'string') return connectorWriteNotSent('UNAVAILABLE');
    if (payload.status === 'cancelled') return connectorWriteNotSent('NOT_FOUND');
    if (Array.isArray(payload.recurrence) && payload.recurrence.length > 0) {
      return connectorWriteNotSent('RECURRING_SERIES_REFUSED');
    }
    if (payload.id !== eventId || !matchesExpectation(payload, expected)) return connectorWriteNotSent('TARGET_CHANGED');
    return undefined;
  }

  /** Exactly one write request. Before it leaves → NOT_SENT; after → by the response (when in doubt UNCERTAIN). */
  private async write(
    method: 'POST' | 'PATCH' | 'DELETE',
    url: URL,
    body: Record<string, unknown> | undefined,
    kind: 'create' | 'update' | 'delete',
    deletedId?: string,
    ifMatch?: string,
  ): Promise<ConnectorWriteOutcome> {
    url.searchParams.set('sendUpdates', 'none');
    let token: string;
    try {
      token = await this.currentAccessToken();
    } catch (error) {
      return connectorWriteNotSent(error instanceof NotSentError ? error.reason : 'UNAVAILABLE');
    }
    let response: Response;
    try {
      response = await this.send(method, url, body, token, ifMatch);
    } catch {
      return connectorWriteUncertain('TRANSPORT');
    }
    if (!response.ok) {
      await discardBody(response);
      if (response.status === 401) this.accessToken = undefined;
      return failedWrite(response.status, kind);
    }
    if (kind === 'delete') {
      await discardBody(response);
      return connectorWriteSent(deletedId as string);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return connectorWriteUncertain('INVALID_RESPONSE');
    }
    if (!isRecord(payload) || typeof payload.id !== 'string' || !EVENT_ID.test(payload.id)) {
      return connectorWriteUncertain('INVALID_RESPONSE');
    }
    const link = typeof payload.htmlLink === 'string' && HTML_LINK.test(payload.htmlLink) ? payload.htmlLink : undefined;
    return connectorWriteSent(payload.id, link);
  }

  private async send(
    method: string,
    url: URL,
    body: Record<string, unknown> | undefined,
    accessToken: string,
    ifMatch?: string,
  ): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(ifMatch !== undefined ? { 'If-Match': ifMatch } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** The cached access token, or one refresh that must grant `calendar.events`. Failures are `NotSentError`. */
  private async currentAccessToken(): Promise<string> {
    const cached = this.accessToken;
    if (cached !== undefined && cached.expiresAtMs - ACCESS_TOKEN_EXPIRY_SKEW_MS > this.nowMs()) return cached.token;
    if (this.pendingRefresh === undefined) {
      this.pendingRefresh = refreshGoogleAccessToken(
        { clientId: this.clientId, clientSecret: this.clientSecret },
        this.refreshToken,
        {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          nowMs: this.nowMs(),
          requiredScopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
        },
      ).finally(() => {
        this.pendingRefresh = undefined;
      });
    }
    try {
      const fresh = await this.pendingRefresh;
      this.accessToken = fresh;
      return fresh.token;
    } catch (error) {
      throw new NotSentError(tokenFailureReason(error));
    }
  }
}

/**
 * The provider event id for a create (base32hex of a domain-separated SHA-256 of the idempotency key, 32 characters).
 * Deterministic: the same key always names the same event, so Google refuses a second create with 409.
 */
export function googleCalendarEventIdFor(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${EVENT_ID_DIGEST_DOMAIN}:${idempotencyKey}`, 'utf8').digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 32) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

function eventsUrl(eventId?: string): URL {
  const base = `/calendar/v3/calendars/${PRIMARY}/events`;
  return new URL(eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`, GOOGLE_CALENDAR_API_ORIGIN);
}

/** Google start/end objects. On an update, the other representation is cleared so a timed/all-day switch is exact. */
function timeBody(time: CalendarEventTime, clearOther = false): Record<string, unknown> {
  if (time.allDay) {
    const clear = clearOther ? { dateTime: null, timeZone: null } : {};
    return { start: { date: time.startDate, ...clear }, end: { date: time.endDate, ...clear } };
  }
  const clear = clearOther ? { date: null } : {};
  return {
    start: { dateTime: time.start, timeZone: time.timeZone, ...clear },
    end: { dateTime: time.end, timeZone: time.timeZone, ...clear },
  };
}

function isValidTitle(value: unknown): value is string {
  return isValidConnectorWriteText(value, CALENDAR_EVENT_TITLE_MAX_LENGTH) && !/[\r\n]/.test(value);
}

function isValidLocation(value: unknown): boolean {
  return isValidConnectorWriteText(value, CALENDAR_EVENT_LOCATION_MAX_LENGTH) && !/[\r\n]/.test(value as string);
}

function optionalFieldsValid(fields: { location?: unknown; description?: unknown }): boolean {
  if (fields.location !== undefined && !isValidLocation(fields.location)) return false;
  if (fields.description !== undefined && !isValidConnectorWriteText(fields.description, CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH)) {
    return false;
  }
  return true;
}

function changesValid(changes: CalendarEventChanges): boolean {
  const any = changes.title !== undefined || changes.time !== undefined || changes.location !== undefined ||
    changes.description !== undefined;
  if (!any) return false;
  if (changes.title !== undefined && !isValidTitle(changes.title)) return false;
  if (changes.time !== undefined && !isValidTime(changes.time)) return false;
  return optionalFieldsValid(changes);
}

/** A timed span needs explicit-offset instants, end after start, a valid IANA zone; an all-day span valid dates. */
function isValidTime(time: CalendarEventTime | undefined): boolean {
  if (time === undefined || typeof time !== 'object') return false;
  let startMs: number;
  let endMs: number;
  if (time.allDay === true) {
    if (typeof time.startDate !== 'string' || typeof time.endDate !== 'string') return false;
    if (!DATE.test(time.startDate) || !DATE.test(time.endDate)) return false;
    startMs = dateMs(time.startDate);
    endMs = dateMs(time.endDate);
  } else if (time.allDay === false) {
    if (typeof time.start !== 'string' || typeof time.end !== 'string') return false;
    if (!INSTANT_WITH_ZONE.test(time.start) || !INSTANT_WITH_ZONE.test(time.end)) return false;
    if (typeof time.timeZone !== 'string' || !isValidTimeZone(time.timeZone)) return false;
    startMs = Date.parse(time.start);
    endMs = Date.parse(time.end);
  } else {
    return false;
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs &&
    endMs - startMs <= CALENDAR_WINDOW_MAX_DAYS * MS_PER_DAY;
}

/** UTC midnight of a real calendar date (`2026-02-30` is rejected), else NaN. */
function dateMs(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

function isValidEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID.test(value);
}

/** The shape of the bound expectation (its version is checked separately: missing or malformed = TARGET_CHANGED). */
function isValidExpectation(value: CalendarEventExpectation | undefined): value is CalendarEventExpectation {
  if (!isRecord(value) || typeof value.allDay !== 'boolean') return false;
  if (typeof value.start !== 'string' || typeof value.end !== 'string') return false;
  if (value.allDay) return DATE.test(value.start) && DATE.test(value.end);
  return Number.isFinite(Date.parse(value.start)) && Number.isFinite(Date.parse(value.end));
}

function isValidVersion(value: unknown): value is string {
  return typeof value === 'string' && ETAG.test(value);
}

/** The live event (pre-check read) is still the approved one: same entity tag, all-day shape, start and end. */
function matchesExpectation(event: Record<string, unknown>, expected: CalendarEventExpectation): boolean {
  if (typeof event.etag !== 'string' || event.etag !== expected.version) return false;
  const start = isRecord(event.start) ? event.start : undefined;
  const end = isRecord(event.end) ? event.end : undefined;
  if (start === undefined || end === undefined) return false;
  if (expected.allDay) return start.date === expected.start && end.date === expected.end && start.dateTime === undefined;
  if (typeof start.dateTime !== 'string' || typeof end.dateTime !== 'string') return false;
  return Date.parse(start.dateTime) === Date.parse(expected.start) && Date.parse(end.dateTime) === Date.parse(expected.end);
}

function precheckReason(status: number): ConnectorWriteNotSentReason {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

/** A non-2xx answer to the write: 5xx (and anything unexpected) may have been applied; a 4xx certainly was not. */
function failedWrite(status: number, kind: 'create' | 'update' | 'delete'): ConnectorWriteOutcome {
  if (status >= 500 || status < 400) return connectorWriteUncertain('SERVER_ERROR');
  if (status === 401) return connectorWriteNotSent('UNAUTHORIZED');
  if (status === 403) return connectorWriteNotSent('FORBIDDEN');
  if (status === 404 || status === 410) return connectorWriteNotSent('NOT_FOUND');
  if (status === 409 && kind === 'create') return connectorWriteNotSent('ALREADY_EXISTS');
  // `If-Match` failed: the event was edited after the pre-check; Google applied nothing.
  if (status === 412 && kind !== 'create') return connectorWriteNotSent('TARGET_CHANGED');
  if (status === 429) return connectorWriteNotSent('RATE_LIMITED');
  return connectorWriteNotSent('REJECTED');
}

function tokenFailureReason(error: unknown): ConnectorWriteNotSentReason {
  if (error instanceof GoogleCalendarScopeError) return error.kind === 'MISSING' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN';
  if (error instanceof ConnectorQueryError) {
    switch (error.reason) {
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
      case 'INSUFFICIENT_SCOPE':
      case 'RATE_LIMITED':
        return error.reason;
      default:
        return 'UNAVAILABLE';
    }
  }
  return 'UNAVAILABLE';
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore: the body is never read
  }
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`google calendar writer: a non-empty ${label} is required`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
