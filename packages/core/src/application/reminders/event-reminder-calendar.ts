import { REMINDER_LIMITS, type IsoTimestamp, type ReminderEventRef } from '../../domain';
import { CALENDAR_EVENTS_MAX_LIMIT, type CalendarEvent, type CalendarReader } from '../../ports/calendar-reader.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS } from '../calendar/calendar-question';
import { CALENDAR_READ_TIMEOUT_MS } from '../calendar/calendar-turn-handler';
import type { EventReminderTarget } from './event-reminder-grammar';
import { addLocalDays, localDateOf, toZonedDateTime, zonedToUtc } from './zoned-time';

/**
 * Event-relative reminders and the calendar (ADR-0117 D5/D6, BRF-2): which event a request names, and what became of
 * that event when its reminder fires. Read-only through the existing `CalendarReader` port (no new port, no write), no
 * model, bounded reads; logs carry counts and failure classes only, never a title or an id.
 *
 * - **Creation (D5).** One read: the named day in `QUOKY_TIMEZONE`, or the next 14 days from now. Only timed events
 *   that have not started are candidates. A title is matched case-, space- and punctuation-insensitively; a time by its
 *   local start (a bare `3시` is 03:00 or 15:00). An exact title wins over a partial one; several different titles, or
 *   several events at the earliest matching start, are ambiguous and the owner is asked to name one. A request that
 *   only matches all-day events is refused: an all-day event has no start to be early for.
 * - **Re-check (D6).** The event is looked up by its stored id: first around its expected start (±12 h), then across
 *   `[now − 1 day, now + 30 days)`. Found: the dispatcher compares its start. Not found in a complete read: `gone` (the
 *   adapter never returns a cancelled event, so deleted and cancelled read the same). A failure, a timeout or a full
 *   page that does not contain it: `unreadable`.
 */

/** The whole creation read must finish within the schedule handler's bound (an interactive turn). */
export const EVENT_REMINDER_CREATE_TIMEOUT_MS = CALENDAR_READ_TIMEOUT_MS;
/** Both re-check reads of one reminder must finish within this bound (it holds the dispatch tick). */
export const EVENT_REMINDER_RECHECK_TIMEOUT_MS = 15_000;
/** How far "the next meeting" looks ahead. */
export const EVENT_REMINDER_LOOKAHEAD_DAYS = CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS;
/** At most this many candidates are shown when the request is ambiguous. */
export const EVENT_REMINDER_MAX_CHOICES = 5;
/** The re-check's narrow window around the expected start, each side. */
const RECHECK_NARROW_MS = 12 * 60 * 60_000;
/** The re-check's wide window: from a day ago (an event moved earlier) to 30 days ahead (the port allows 31). */
const RECHECK_WIDE_BEFORE_MS = 24 * 60 * 60_000;
const RECHECK_WIDE_AFTER_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type EventReminderResolution =
  | { readonly kind: 'found'; readonly event: CalendarEvent; readonly startMs: number; readonly fireAt: IsoTimestamp }
  /** The event starts too soon for this offset (its due time is less than a minute away or already past). */
  | { readonly kind: 'too-soon'; readonly event: CalendarEvent; readonly startMs: number }
  /** Several events match; the owner names one (earliest first, at most EVENT_REMINDER_MAX_CHOICES). */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly CalendarEvent[] }
  /** Only all-day events match. */
  | { readonly kind: 'all-day'; readonly event: CalendarEvent }
  /** Nothing matches. `partial`: the read returned a full page, so a later event may not have been seen. */
  | { readonly kind: 'none'; readonly partial: boolean };

export type EventReminderRecheck =
  | { readonly kind: 'found'; readonly event: CalendarEvent }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' };

/** The comparison key of a title: NFKC, lower case, without spaces or punctuation. */
export function eventTitleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

const MEETING_NOUN_KEYS = ['회의', '미팅', 'meeting'];

function startMsOf(event: CalendarEvent): number {
  return event.allDay ? Number.NaN : Date.parse(event.start);
}

function matchesTime(event: CalendarEvent, time: NonNullable<EventReminderTarget['time']>, timeZone: string): boolean {
  const local = toZonedDateTime(startMsOf(event), timeZone);
  if (local.minute !== time.minute) return false;
  if (time.meridiem === 'am') return local.hour === time.hour % 12;
  if (time.meridiem === 'pm') return local.hour === (time.hour % 12) + 12;
  if (time.hour >= 1 && time.hour <= 12) return local.hour === time.hour % 12 || local.hour === (time.hour % 12) + 12;
  return local.hour === time.hour;
}

function matchesDay(event: CalendarEvent, dayOffset: number, now: IsoTimestamp, timeZone: string): boolean {
  const wanted = addLocalDays(localDateOf(now, timeZone), dayOffset);
  if (event.allDay) {
    const key = `${wanted.year}-${String(wanted.month).padStart(2, '0')}-${String(wanted.day).padStart(2, '0')}`;
    return event.start <= key && key < event.end;
  }
  const local = localDateOf(startMsOf(event), timeZone);
  return local.year === wanted.year && local.month === wanted.month && local.day === wanted.day;
}

function matchesWeekday(event: CalendarEvent, weekday: number, timeZone: string): boolean {
  if (event.allDay) {
    const [year, month, day] = event.start.split('-').map(Number);
    return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay() === weekday;
  }
  return toZonedDateTime(startMsOf(event), timeZone).weekday === weekday;
}

function byStartThenId(a: CalendarEvent, b: CalendarEvent): number {
  return startMsOf(a) - startMsOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One event per title key (the earliest), so a duplicate on two calendars is one choice. */
function distinctByTitle(events: readonly CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const event of events) {
    const key = eventTitleKey(event.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

/**
 * The event a request names, among `events` (pure; `now` and the zone are inputs). See the module comment for the
 * rules. `partial` says the read returned a full page.
 */
export function resolveEventReminderTarget(
  events: readonly CalendarEvent[],
  target: EventReminderTarget,
  options: { readonly now: IsoTimestamp; readonly timeZone: string; readonly offsetMinutes: number; readonly partial?: boolean },
): EventReminderResolution {
  const nowMs = Date.parse(options.now);
  const titleKey = target.title !== undefined ? eventTitleKey(target.title) : '';
  const titled = (event: CalendarEvent): boolean => titleKey.length === 0 || eventTitleKey(event.title).includes(titleKey);
  const onDay = (event: CalendarEvent): boolean =>
    (target.dayOffset === undefined || matchesDay(event, target.dayOffset, options.now, options.timeZone)) &&
    (target.weekday === undefined || matchesWeekday(event, target.weekday, options.timeZone));

  const timed = events
    .filter((event) => !event.allDay && Number.isFinite(startMsOf(event)) && startMsOf(event) > nowMs)
    .filter((event) => onDay(event) && titled(event))
    .filter((event) => target.time === undefined || matchesTime(event, target.time, options.timeZone))
    .sort(byStartThenId);

  if (timed.length === 0) {
    // An all-day event matches a title or a day, never a clock time; it is refused rather than silently skipped.
    const allDay =
      target.time === undefined && (titleKey.length > 0 || target.dayOffset !== undefined || target.weekday !== undefined)
        ? events.filter((event) => event.allDay && onDay(event) && titled(event))
        : [];
    const first = allDay[0];
    return first !== undefined ? { kind: 'all-day', event: first } : { kind: 'none', partial: options.partial === true };
  }

  let pool = timed;
  if (titleKey.length > 0) {
    const exactKeys = new Set([titleKey, ...MEETING_NOUN_KEYS.map((noun) => `${titleKey}${noun}`)]);
    const exact = timed.filter((event) => exactKeys.has(eventTitleKey(event.title)));
    if (exact.length > 0) pool = exact;
    else {
      const titles = distinctByTitle(timed);
      if (titles.length > 1) return { kind: 'ambiguous', candidates: titles.slice(0, EVENT_REMINDER_MAX_CHOICES) };
    }
  }
  const first = pool[0] as CalendarEvent;
  const startMs = startMsOf(first);
  const ties = distinctByTitle(pool.filter((event) => startMsOf(event) === startMs));
  if (ties.length > 1) return { kind: 'ambiguous', candidates: ties.slice(0, EVENT_REMINDER_MAX_CHOICES) };

  const fireMs = startMs - options.offsetMinutes * 60_000;
  if (fireMs - nowMs < REMINDER_LIMITS.minLeadMs) return { kind: 'too-soon', event: first, startMs };
  return { kind: 'found', event: first, startMs, fireAt: new Date(fireMs).toISOString() };
}

/** The creation read's window: the named day (from now when it is today), or the next 14 days. */
export function eventReminderCreationWindow(
  target: EventReminderTarget,
  now: IsoTimestamp,
  timeZone: string,
): { readonly from: IsoTimestamp; readonly to: IsoTimestamp } | null {
  const nowMs = Date.parse(now);
  if (target.dayOffset === undefined) {
    return { from: new Date(nowMs).toISOString(), to: new Date(nowMs + EVENT_REMINDER_LOOKAHEAD_DAYS * DAY_MS).toISOString() };
  }
  const day = addLocalDays(localDateOf(now, timeZone), target.dayOffset);
  const startMs = zonedToUtc({ ...day, hour: 0, minute: 0 }, timeZone).epochMs;
  const endMs = zonedToUtc({ ...addLocalDays(day, 1), hour: 0, minute: 0 }, timeZone).epochMs;
  const from = Math.max(startMs, nowMs);
  if (!(endMs > from)) return null;
  return { from: new Date(from).toISOString(), to: new Date(endMs).toISOString() };
}

class EventReminderReadTimeout extends Error {
  constructor() {
    super('calendar read timed out');
    this.name = 'EventReminderReadTimeout';
  }
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EventReminderReadTimeout()), timeoutMs);
  });
  const task = run();
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failureClass(error: unknown): string {
  if (error instanceof EventReminderReadTimeout) return 'TIMEOUT';
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === 'string' && /^[A-Z_]{1,40}$/.test(reason) ? reason : 'UNAVAILABLE';
}

export interface EventReminderCalendarDeps {
  readonly reader: Pick<CalendarReader, 'listEvents'>;
  readonly logger?: Logger;
  /** Injectable for tests. */
  readonly createTimeoutMs?: number;
  readonly recheckTimeoutMs?: number;
}

/** The two bounded reads of event-relative reminders over the configured `CalendarReader`. Never throws. */
export class EventReminderCalendar {
  constructor(private readonly deps: EventReminderCalendarDeps) {}

  /** The events a creation request may name, or `null` when the calendar could not be read. */
  async readForCreation(
    target: EventReminderTarget,
    now: IsoTimestamp,
    timeZone: string,
  ): Promise<{ readonly events: readonly CalendarEvent[]; readonly partial: boolean } | null> {
    const window = eventReminderCreationWindow(target, now, timeZone);
    if (window === null) return { events: [], partial: false };
    try {
      const events = await withTimeout(
        () => this.deps.reader.listEvents({ ...window, limit: CALENDAR_EVENTS_MAX_LIMIT }),
        this.deps.createTimeoutMs ?? EVENT_REMINDER_CREATE_TIMEOUT_MS,
      );
      if (!Array.isArray(events)) return null;
      this.log('info', 'reminder.event.create_read', { events: events.length });
      return { events, partial: events.length >= CALENDAR_EVENTS_MAX_LIMIT };
    } catch (error) {
      this.log('warn', 'reminder.event.create_read_failed', { reason: failureClass(error) });
      return null;
    }
  }

  /** What became of the referenced event (D6). `expectedStart` is the start the reminder was scheduled for. */
  async recheck(ref: ReminderEventRef, expectedStart: IsoTimestamp, now: IsoTimestamp): Promise<EventReminderRecheck> {
    const expectedMs = Date.parse(expectedStart);
    const nowMs = Date.parse(now);
    try {
      const verdict = await withTimeout(async (): Promise<EventReminderRecheck> => {
        const narrow = await this.deps.reader.listEvents({
          from: new Date(expectedMs - RECHECK_NARROW_MS).toISOString(),
          to: new Date(expectedMs + RECHECK_NARROW_MS).toISOString(),
          limit: CALENDAR_EVENTS_MAX_LIMIT,
        });
        const near = findById(narrow, ref.eventId);
        if (near !== undefined) return { kind: 'found', event: near };
        const wide = await this.deps.reader.listEvents({
          from: new Date(nowMs - RECHECK_WIDE_BEFORE_MS).toISOString(),
          to: new Date(nowMs + RECHECK_WIDE_AFTER_MS).toISOString(),
          limit: CALENDAR_EVENTS_MAX_LIMIT,
        });
        const far = findById(wide, ref.eventId);
        if (far !== undefined) return { kind: 'found', event: far };
        // A full page that does not contain the event proves nothing: the event may be past the page.
        return Array.isArray(wide) && wide.length < CALENDAR_EVENTS_MAX_LIMIT ? { kind: 'gone' } : { kind: 'unreadable' };
      }, this.deps.recheckTimeoutMs ?? EVENT_REMINDER_RECHECK_TIMEOUT_MS);
      this.log('info', 'reminder.event.recheck', { verdict: verdict.kind });
      return verdict;
    } catch (error) {
      this.log('warn', 'reminder.event.recheck_failed', { reason: failureClass(error) });
      return { kind: 'unreadable' };
    }
  }

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger?.[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

function findById(events: readonly CalendarEvent[] | unknown, id: string): CalendarEvent | undefined {
  return Array.isArray(events) ? (events as readonly CalendarEvent[]).find((event) => event.id === id) : undefined;
}
