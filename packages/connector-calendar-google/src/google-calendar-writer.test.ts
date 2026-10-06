import { describe, expect, it } from 'vitest';
import type { CalendarEventDraft, CalendarEventExpectation } from '@quoky/core';
import { GOOGLE_CALENDAR_READONLY_SCOPE, GOOGLE_CALENDAR_READ_WRITE_SCOPE, GOOGLE_OAUTH_TOKEN_URL } from './oauth';
import { GoogleCalendarWriter, googleCalendarEventIdFor, type GoogleCalendarWriterConfig } from './google-calendar-writer';

const CLIENT_SECRET = 'client-secret-value';
const REFRESH_TOKEN = '1//refresh-token-value';
const ACCESS_TOKEN = 'access-' + 'token-value';
const KEY = 'approval:0001-abcd';
const EVENT_LINK = 'https://www.google.com/calendar/event?eid=abc123';

interface Call {
  url: URL;
  init: RequestInit | undefined;
}
type Reply = Response | Error;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function tokenOk(scope: string = GOOGLE_CALENDAR_READ_WRITE_SCOPE): Response {
  return json(200, { access_token: ACCESS_TOKEN, expires_in: 3599, scope, token_type: 'Bearer' });
}

/** Token calls get `token` (default ok); Calendar calls consume `calendar` replies in order. */
function fakeGoogle(calendar: Reply[], token: () => Reply = () => tokenOk()): {
  fetchImpl: typeof fetch;
  calendarCalls: Call[];
  tokenCalls: Call[];
} {
  const calendarCalls: Call[] = [];
  const tokenCalls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init };
    const reply = call.url.toString() === GOOGLE_OAUTH_TOKEN_URL ? (tokenCalls.push(call), token()) : (calendarCalls.push(call), calendar.shift());
    if (reply === undefined) throw new Error('unexpected call');
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { fetchImpl, calendarCalls, tokenCalls };
}

function writer(fetchImpl: typeof fetch, config: Partial<GoogleCalendarWriterConfig> = {}): GoogleCalendarWriter {
  return new GoogleCalendarWriter({
    clientId: 'client-id.apps.googleusercontent.com',
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
    fetchImpl,
    nowMs: () => 0,
    ...config,
  });
}

const DRAFT: CalendarEventDraft = {
  title: '팀 회의',
  time: { allDay: false, start: '2026-10-07T10:00:00+09:00', end: '2026-10-07T11:00:00+09:00', timeZone: 'Asia/Seoul' },
  location: '3층 회의실',
  description: '안건: 배포',
};

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) expect(text).not.toContain(secret);
}

describe('GoogleCalendarWriter — create (ADR-0110 amendment D2-D5)', () => {
  it('creates on the primary calendar with sendUpdates=none, no attendees, and an idempotency-derived event id', async () => {
    const id = googleCalendarEventIdFor(KEY);
    const google = fakeGoogle([json(200, { id, htmlLink: EVENT_LINK, status: 'confirmed' })]);
    const outcome = await writer(google.fetchImpl).createEvent({ draft: DRAFT, idempotencyKey: KEY });
    expect(outcome).toEqual({ status: 'SENT', externalRef: id, url: EVENT_LINK });
    expect(google.calendarCalls).toHaveLength(1);
    const call = google.calendarCalls[0]!;
    expect(call.init?.method).toBe('POST');
    expect(call.url.origin + call.url.pathname).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ sendUpdates: 'none' });
    expect(call.init?.redirect).toBe('error');
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(bodyOf(call)).toEqual({
      id,
      summary: '팀 회의',
      start: { dateTime: '2026-10-07T10:00:00+09:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-10-07T11:00:00+09:00', timeZone: 'Asia/Seoul' },
      location: '3층 회의실',
      description: '안건: 배포',
    });
    expect(Object.keys(bodyOf(call))).not.toContain('attendees');
    // The token refresh asked Google for nothing but the refresh grant.
    expect(new URLSearchParams(String(google.tokenCalls[0]!.init?.body)).get('grant_type')).toBe('refresh_token');
  });

  it('derives a stable base32hex event id per idempotency key', () => {
    const id = googleCalendarEventIdFor(KEY);
    expect(id).toMatch(/^[0-9a-v]{32}$/);
    expect(googleCalendarEventIdFor(KEY)).toBe(id);
    expect(googleCalendarEventIdFor('approval:0002-abcd')).not.toBe(id);
  });

  it('creates an all-day event with dates only', async () => {
    const google = fakeGoogle([json(200, { id: 'abcde12345' })]);
    const outcome = await writer(google.fetchImpl).createEvent({
      draft: { title: '휴가', time: { allDay: true, startDate: '2026-10-09', endDate: '2026-10-10' } },
      idempotencyKey: KEY,
    });
    expect(outcome).toEqual({ status: 'SENT', externalRef: 'abcde12345' });
    expect(bodyOf(google.calendarCalls[0]!)).toMatchObject({ start: { date: '2026-10-09' }, end: { date: '2026-10-10' } });
  });

  it('a repeated create (409 on the derived id) is NOT_SENT ALREADY_EXISTS, never a second event', async () => {
    const google = fakeGoogle([json(409, { error: { message: 'The requested identifier already exists.' } })]);
    expect(await writer(google.fetchImpl).createEvent({ draft: DRAFT, idempotencyKey: KEY })).toEqual({
      status: 'NOT_SENT', reason: 'ALREADY_EXISTS', retryable: false,
    });
  });

  it('refuses an invalid draft before any network call', async () => {
    const google = fakeGoogle([]);
    const calendar = writer(google.fetchImpl);
    const timed = DRAFT.time;
    const bad: CalendarEventDraft[] = [
      { ...DRAFT, title: '' },
      { ...DRAFT, title: 'two\nlines' },
      { ...DRAFT, title: 'x'.repeat(201) },
      { ...DRAFT, location: 'x'.repeat(201) },
      { ...DRAFT, description: 'x'.repeat(4001) },
      { ...DRAFT, time: { ...timed, start: '2026-10-07T10:00:00' } as never },
      { ...DRAFT, time: { allDay: false, start: '2026-10-07T11:00:00Z', end: '2026-10-07T10:00:00Z', timeZone: 'Asia/Seoul' } },
      { ...DRAFT, time: { allDay: false, start: '2026-10-07T10:00:00Z', end: '2026-10-07T11:00:00Z', timeZone: 'Mars/Base' } },
      { ...DRAFT, time: { allDay: false, start: '2026-10-01T00:00:00Z', end: '2026-12-01T00:00:00Z', timeZone: 'UTC' } },
      { ...DRAFT, time: { allDay: true, startDate: '2026-02-30', endDate: '2026-03-01' } },
      { ...DRAFT, time: { allDay: true, startDate: '2026-10-09', endDate: '2026-10-09' } },
    ];
    for (const draft of bad) {
      expect(await calendar.createEvent({ draft, idempotencyKey: KEY })).toMatchObject({ status: 'NOT_SENT', reason: 'INVALID_REQUEST' });
    }
    expect(await calendar.createEvent({ draft: DRAFT, idempotencyKey: 'short' })).toMatchObject({ reason: 'INVALID_REQUEST' });
    expect(google.calendarCalls).toHaveLength(0);
    expect(google.tokenCalls).toHaveLength(0);
  });

  it('classifies write failures: 4xx NOT_SENT, 5xx / transport / unreadable success UNCERTAIN; no retry', async () => {
    const cases: Array<[Reply, unknown]> = [
      [json(400, {}), { status: 'NOT_SENT', reason: 'REJECTED', retryable: false }],
      [json(401, {}), { status: 'NOT_SENT', reason: 'UNAUTHORIZED', retryable: false }],
      [json(403, {}), { status: 'NOT_SENT', reason: 'FORBIDDEN', retryable: false }],
      [json(404, {}), { status: 'NOT_SENT', reason: 'NOT_FOUND', retryable: false }],
      [json(429, {}), { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: false }],
      [json(500, {}), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [new Error(`reset ${ACCESS_TOKEN}`), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
      [new Response('nope', { status: 200 }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
      [json(200, { summary: 'no id' }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
    ];
    for (const [reply, expected] of cases) {
      const google = fakeGoogle([reply]);
      const outcome = await writer(google.fetchImpl).createEvent({ draft: DRAFT, idempotencyKey: KEY });
      expect(outcome).toEqual(expected);
      expect(google.calendarCalls).toHaveLength(1);
      assertNoSecrets(outcome);
    }
  });

  it('a token that lacks calendar.events, or holds a broader scope, or fails to refresh is NOT_SENT before the write', async () => {
    const cases: Array<[() => Reply, string]> = [
      [() => tokenOk(GOOGLE_CALENDAR_READONLY_SCOPE), 'INSUFFICIENT_SCOPE'],
      [() => tokenOk(`${GOOGLE_CALENDAR_READ_WRITE_SCOPE} https://www.googleapis.com/auth/calendar`), 'FORBIDDEN'],
      [() => json(400, { error: 'invalid_grant' }), 'UNAUTHORIZED'],
      [() => new Error('offline'), 'UNAVAILABLE'],
    ];
    for (const [token, reason] of cases) {
      const google = fakeGoogle([], token);
      expect(await writer(google.fetchImpl).createEvent({ draft: DRAFT, idempotencyKey: KEY })).toEqual({
        status: 'NOT_SENT', reason, retryable: false,
      });
      expect(google.calendarCalls).toHaveLength(0);
    }
  });
});

describe('GoogleCalendarWriter — update and delete (ADR-0110 amendment D3)', () => {
  const ETAG = '"3181161784712000"';
  /** The event as the preview listed it (start/end as the reader gives them: UTC instants). */
  const EXPECTED: CalendarEventExpectation = {
    allDay: false,
    start: '2026-10-07T06:00:00.000Z',
    end: '2026-10-07T07:00:00.000Z',
    version: ETAG,
  };
  const live = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'evt123',
    etag: ETAG,
    status: 'confirmed',
    start: { dateTime: '2026-10-07T15:00:00+09:00' },
    end: { dateTime: '2026-10-07T16:00:00+09:00' },
    ...overrides,
  });
  const single = (): Response => json(200, live());

  it('updates only the changed fields of a single event with sendUpdates=none after a read pre-check', async () => {
    const google = fakeGoogle([single(), json(200, { id: 'evt123', htmlLink: EVENT_LINK })]);
    const outcome = await writer(google.fetchImpl).updateEvent({
      eventId: 'evt123',
      expected: EXPECTED,
      changes: { title: '회의 (변경)', time: { allDay: true, startDate: '2026-10-08', endDate: '2026-10-09' } },
    });
    expect(outcome).toEqual({ status: 'SENT', externalRef: 'evt123', url: EVENT_LINK });
    const [read, patch] = google.calendarCalls;
    expect(read!.init?.method).toBe('GET');
    expect(read!.url.pathname).toBe('/calendar/v3/calendars/primary/events/evt123');
    expect(read!.url.searchParams.get('fields')).toBe(
      'id,etag,status,recurrence,recurringEventId,start(date,dateTime),end(date,dateTime)',
    );
    expect(patch!.init?.method).toBe('PATCH');
    // The write is conditional on the approved version: an edit racing the pre-check is refused by Google (412).
    expect((patch!.init?.headers as Record<string, string>)['If-Match']).toBe(ETAG);
    expect(patch!.url.pathname).toBe('/calendar/v3/calendars/primary/events/evt123');
    expect(patch!.url.searchParams.get('sendUpdates')).toBe('none');
    expect(bodyOf(patch!)).toEqual({
      summary: '회의 (변경)',
      start: { date: '2026-10-08', dateTime: null, timeZone: null },
      end: { date: '2026-10-09', dateTime: null, timeZone: null },
    });
  });

  it('allows a single instance of a series but refuses the recurring series itself', async () => {
    const instance = fakeGoogle([
      json(200, live({ id: 'evt123_20261007T010000Z', recurringEventId: 'evt123' })),
      new Response(null, { status: 204 }),
    ]);
    expect(await writer(instance.fetchImpl).deleteEvent({ eventId: 'evt123_20261007T010000Z', expected: EXPECTED })).toEqual({
      status: 'SENT', externalRef: 'evt123_20261007T010000Z',
    });
    expect(instance.calendarCalls[1]!.init?.method).toBe('DELETE');
    expect(instance.calendarCalls[1]!.url.searchParams.get('sendUpdates')).toBe('none');

    for (const op of ['update', 'delete'] as const) {
      const series = fakeGoogle([json(200, live({ recurrence: ['RRULE:FREQ=WEEKLY'] }))]);
      const calendar = writer(series.fetchImpl);
      const outcome = op === 'update'
        ? await calendar.updateEvent({ eventId: 'evt123', expected: EXPECTED, changes: { title: 'x' } })
        : await calendar.deleteEvent({ eventId: 'evt123', expected: EXPECTED });
      expect(outcome).toEqual({ status: 'NOT_SENT', reason: 'RECURRING_SERIES_REFUSED', retryable: false });
      expect(series.calendarCalls).toHaveLength(1);
    }
  });

  it('a missing, cancelled or unreadable event is NOT_SENT and nothing is written', async () => {
    for (const [reply, reason] of [
      [json(404, {}), 'NOT_FOUND'],
      [json(410, {}), 'NOT_FOUND'],
      [json(200, live({ status: 'cancelled' })), 'NOT_FOUND'],
      [json(500, {}), 'UNAVAILABLE'],
      [new Error('offline'), 'UNAVAILABLE'],
    ] as const) {
      const google = fakeGoogle([reply]);
      expect(await writer(google.fetchImpl).deleteEvent({ eventId: 'evt123', expected: EXPECTED })).toEqual({
        status: 'NOT_SENT', reason, retryable: false,
      });
      expect(google.calendarCalls).toHaveLength(1);
    }
  });

  it('the pre-check read refreshes once on 401; the write itself is never retried', async () => {
    let tokens = 0;
    const google = fakeGoogle([json(401, {}), single(), json(503, {})], () => {
      tokens += 1;
      return tokenOk();
    });
    expect(await writer(google.fetchImpl).updateEvent({ eventId: 'evt123', expected: EXPECTED, changes: { location: '본사' } })).toEqual({
      status: 'UNCERTAIN', reason: 'SERVER_ERROR',
    });
    expect(tokens).toBe(2);
    expect(google.calendarCalls.map((call) => call.init?.method)).toEqual(['GET', 'GET', 'PATCH']);
  });

  it('refuses (TARGET_CHANGED) an event that changed after the preview, and never writes it', async () => {
    const drifts: Array<Record<string, unknown>> = [
      live({ etag: '"3181161784799999"' }),
      live({ start: { dateTime: '2026-10-07T16:00:00+09:00' }, end: { dateTime: '2026-10-07T17:00:00+09:00' } }),
      live({ end: { dateTime: '2026-10-07T16:30:00+09:00' } }),
      live({ start: { date: '2026-10-07' }, end: { date: '2026-10-08' } }),
      live({ id: 'evt999' }),
    ];
    for (const body of drifts) {
      for (const op of ['update', 'delete'] as const) {
        const google = fakeGoogle([json(200, body)]);
        const calendar = writer(google.fetchImpl);
        const outcome = op === 'update'
          ? await calendar.updateEvent({ eventId: 'evt123', expected: EXPECTED, changes: { title: 'x' } })
          : await calendar.deleteEvent({ eventId: 'evt123', expected: EXPECTED });
        expect(outcome).toEqual({ status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false });
        expect(google.calendarCalls).toHaveLength(1);
      }
    }
    // An all-day expectation compares dates (and the tag); the write is conditional on the tag.
    const allDay: CalendarEventExpectation = { allDay: true, start: '2026-10-07', end: '2026-10-08', version: ETAG };
    const ok = fakeGoogle([json(200, live({ start: { date: '2026-10-07' }, end: { date: '2026-10-08' } })), new Response(null, { status: 204 })]);
    expect(await writer(ok.fetchImpl).deleteEvent({ eventId: 'evt123', expected: allDay })).toMatchObject({ status: 'SENT' });
    expect((ok.calendarCalls[1]!.init?.headers as Record<string, string>)['If-Match']).toBe(ETAG);
    const moved = fakeGoogle([json(200, live({ start: { date: '2026-10-08' }, end: { date: '2026-10-09' } }))]);
    expect(await writer(moved.fetchImpl).deleteEvent({ eventId: 'evt123', expected: allDay })).toMatchObject({ reason: 'TARGET_CHANGED' });
    // The live event lost its tag: it cannot be proven unchanged.
    const untagged = fakeGoogle([json(200, live({ etag: undefined }))]);
    expect(await writer(untagged.fetchImpl).deleteEvent({ eventId: 'evt123', expected: EXPECTED })).toMatchObject({ reason: 'TARGET_CHANGED' });
  });

  it('Codex P2: a missing or malformed bound version is NOT_SENT TARGET_CHANGED before any network call (never unconditional)', async () => {
    const { version: _version, ...unversioned } = EXPECTED;
    for (const expected of [
      unversioned,
      { ...EXPECTED, version: '' },
      { ...EXPECTED, version: 'two\nlines' },
      { ...EXPECTED, version: 42 },
    ] as unknown as CalendarEventExpectation[]) {
      // Even when the live event was edited (title change, new tag), nothing is read or written.
      const google = fakeGoogle([json(200, live({ etag: '"after-title-change"' })), new Response(null, { status: 204 })]);
      const calendar = writer(google.fetchImpl);
      expect(await calendar.deleteEvent({ eventId: 'evt123', expected })).toEqual({
        status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
      });
      expect(await calendar.updateEvent({ eventId: 'evt123', expected, changes: { title: 'x' } })).toEqual({
        status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
      });
      expect(google.calendarCalls).toHaveLength(0);
      expect(google.tokenCalls).toHaveLength(0);
    }
  });

  it('a 412 on the conditional write (edited after the pre-check) is NOT_SENT TARGET_CHANGED', async () => {
    for (const op of ['update', 'delete'] as const) {
      const google = fakeGoogle([single(), json(412, {})]);
      const calendar = writer(google.fetchImpl);
      const outcome = op === 'update'
        ? await calendar.updateEvent({ eventId: 'evt123', expected: EXPECTED, changes: { title: 'x' } })
        : await calendar.deleteEvent({ eventId: 'evt123', expected: EXPECTED });
      expect(outcome).toEqual({ status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false });
      expect(google.calendarCalls).toHaveLength(2);
    }
  });

  it('refuses invalid ids, a missing or malformed expectation, or empty changes before any network call', async () => {
    const google = fakeGoogle([]);
    const calendar = writer(google.fetchImpl);
    expect(await calendar.updateEvent({ eventId: 'evt123', expected: EXPECTED, changes: {} })).toMatchObject({ reason: 'INVALID_REQUEST' });
    expect(await calendar.updateEvent({ eventId: '../other', expected: EXPECTED, changes: { title: 'x' } })).toMatchObject({
      reason: 'INVALID_REQUEST',
    });
    expect(await calendar.deleteEvent({ eventId: '', expected: EXPECTED })).toMatchObject({ reason: 'INVALID_REQUEST' });
    const malformed = [
      undefined,
      { allDay: false, start: 'not a time', end: EXPECTED.end },
      { allDay: true, start: '2026-10-07T00:00:00Z', end: '2026-10-08', version: ETAG },
    ] as unknown as CalendarEventExpectation[];
    for (const expected of malformed) {
      expect(await calendar.deleteEvent({ eventId: 'evt123', expected })).toMatchObject({ reason: 'INVALID_REQUEST' });
      expect(await calendar.updateEvent({ eventId: 'evt123', expected, changes: { title: 'x' } })).toMatchObject({ reason: 'INVALID_REQUEST' });
    }
    expect(google.calendarCalls).toHaveLength(0);
  });

  it('always targets primary and validates its configuration value-free', () => {
    const google = fakeGoogle([]);
    expect(writer(google.fetchImpl).target).toBe('primary');
    expect(writer(google.fetchImpl).source).toBe('calendar');
    expect(() => writer(google.fetchImpl, { refreshToken: ' ' })).toThrow('google calendar writer: a non-empty refresh token is required');
    expect(() => writer(google.fetchImpl, { clientSecret: '' })).toThrow('client secret');
    expect(google.tokenCalls).toHaveLength(0);
  });
});
