import type {
  ConversationTurnHandler,
  SurfaceClaim,
  TurnHandlerContext,
  TurnHandlerProbeContext,
  TurnHandlerReply,
  TurnHandlerWriteDraft,
} from '../../ports/conversation-turn-handler.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import { CALENDAR_EVENTS_MAX_LIMIT, type CalendarEvent, type CalendarReader } from '../../ports/calendar-reader.port';
import { isConnectorQueryError } from '../../ports/connector-query';
import type { Id, MessageBody } from '../../domain';
import { outboundMessage } from '../message-rendering';
import { PENDING_APPROVAL_TTL_MS } from '../conversation-commands';
import type { CalendarRecentListing, ConnectorWriteDraft } from '../connector-writes/connector-write-draft';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { parseCalendarQuestion, placeCalendarSpan, type CalendarLanguage, type CalendarWindow } from './calendar-question';
import { nlFlagArg, nlStringArg, type NlCatalogEntry, type NlClassBProbe, type NlGrammarSelection, type NlSelectedCommand } from '../nl-routing/catalog';
import { isoDateOf, type NlResolvedRange } from '../nl-routing/symbolic-time';
import { CALENDAR_PART_OF_DAY_VALUES, type CalendarPartOfDay } from '../nl-routing/wave1-entries';
import { addLocalDays, zonedToUtcIso } from '../reminders/zoned-time';
import { nlWave1Entry } from '../nl-routing/wave1-entries';
import { parseCalendarWriteRequest } from './calendar-write-request';
import { surfaceClaimOf } from '../surface-grants/surface-group-map';
import {
  calendarListedEventIds,
  renderCalendarEvents,
  renderCalendarHistoryNote,
  renderCalendarInvalidDate,
  renderCalendarReadFailure,
  renderCalendarWriteRefused,
  type CalendarReadFailure,
} from './calendar-reply-renderer';

export const CALENDAR_TURN_HANDLER_ID = 'calendar';
/**
 * ADR-0110 D3 (amends ADR-0096 D5): `pre-classify`, order 150 — after memory commands (50), learning commands (60) and
 * anchored to-dos (100), before reminders (200), work lookups (300) and help intent (400).
 */
export const CALENDAR_TURN_HANDLER_ORDER = 150;
/** The content-free Class B grammar id of the schedule-question grammar (ADR-0120 D10 agreement log). */
export const CALENDAR_GRAMMAR_ID = 'calendar-question';
/** The whole read (every configured calendar and page) must finish within this bound. */
export const CALENDAR_READ_TIMEOUT_MS = 30_000;
/** At most this many sessions' last calendar list are kept in memory (the oldest is dropped first). */
export const CALENDAR_RECENT_LISTINGS_MAX = 256;

/** The contributed help line (ADR-0096 D6; one line under the composer's 120-character bound, quoted phrases route here). */
export const CALENDAR_HELP_LINES: readonly string[] = Object.freeze([
  '- 캘린더(읽기 전용): "오늘 일정", "내일 일정 뭐야?", "이번 주 일정", "다음 회의 언제야?"',
]);
/** The help line while calendar writes are on (ADR-0110 amendment, CWR-2): reads plus the approved write forms. */
export const CALENDAR_WRITE_HELP_LINES: readonly string[] = Object.freeze([
  '- 캘린더: "오늘 일정", "다음 회의 언제야?", "내일 오후 3시에 회의 잡아줘 제목 주간 회의", "내일 3시 회의 취소해줘"(승인 후 실행)',
]);

export interface CalendarTurnHandlerDeps {
  readonly reader: CalendarReader;
  /** `QUOKY_TIMEZONE`: windows and every rendered time are in this zone. */
  readonly timeZone: string;
  readonly logger?: Logger;
  /** Injectable for tests; production uses CALENDAR_READ_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * Whether calendar writes are bound (ADR-0110 amendment D7: `QUOKY_CALENDAR_WRITE_ENABLED=true` AND a writer was
   * built). Picks the help line only: a write request is always handed to the runtime as a `write-draft`, and the
   * runtime replies with the fixed read-only refusal whenever no calendar writer is bound.
   */
  readonly writesEnabled?: boolean;
}

class CalendarReadTimeout extends Error {
  constructor() {
    super('calendar read timed out');
    this.name = 'CalendarReadTimeout';
  }
}

/**
 * Schedule questions answered from the owner's calendar (ADR-0110 D3–D6, CAL-2) as an ADR-0096 `pre-classify` turn
 * handler, order 150. Registered by the composition root ONLY when a `CalendarReader` is configured (D5), so with no
 * calendar the QUAL-7 routing is unchanged.
 *
 * - A message the reminder grammar recognizes is never claimed ("내일 9시에 회의 알려줘" stays a reminder).
 * - A calendar write request is handed to the runtime as a `write-draft` (CWR-2); while writes are off the runtime
 *   replies with the fixed read-only refusal (D6). No read is made here.
 * - A schedule question reads `[from, to)` in `QUOKY_TIMEZONE` once and answers with the deterministic list. There is no
 *   summary and no provider call of any kind (D4: summaries would be LOCAL-only, and the turn-handler `summarize`
 *   outcome cannot be restricted to a LOCAL provider, so none is ever returned — no Claude fallback for calendar text).
 * - A failed read is answered truthfully with fixed copy (never "no events"), status `FAILED`.
 * - The conversation history keeps a fixed note instead of the reply, so event text never reaches a later prompt.
 *
 * - The ids of the events a list showed (never their text) are kept in memory per session for the ADR-0093 lifetime
 *   (live QA D2): an update / delete that names no day carries them to the write flow as the session's recent calendar
 *   context. Lost on restart, where the flow asks which event instead.
 *
 * Creates no Task, TaskRun or ApprovalRequest; logs no message or event text.
 */
export class CalendarTurnHandler implements ConversationTurnHandler {
  readonly id = CALENDAR_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = CALENDAR_TURN_HANDLER_ORDER;
  readonly helpLines: readonly string[];
  /**
   * Per (session, actor): the calendar list this handler last showed that actor (ids only), insertion order = age. A
   * shared conversation never hands one actor's list to another (the recent-write anchors bind the actor too).
   */
  private readonly recentListings = new Map<string, CalendarRecentListing & { readonly sessionId: Id; readonly actorId: Id }>();

  constructor(private readonly deps: CalendarTurnHandlerDeps) {
    this.helpLines = deps.writesEnabled === true ? CALENDAR_WRITE_HELP_LINES : CALENDAR_HELP_LINES;
  }

  /**
   * ADR-0122 D2.1: a schedule question is `calendar`; a write request is `writes` plus `calendar` (its preview shows calendar
   * data). The same parse `handle` reads; nothing is read.
   */
  surfaceClaim(ctx: TurnHandlerProbeContext): SurfaceClaim | null {
    const question = this.parseQuestion(ctx);
    if (question === null) return null;
    return surfaceClaimOf(question.kind === 'write-refused' ? ['writes', 'calendar'] : ['calendar']);
  }

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | TurnHandlerWriteDraft | null> {
    const text = ctx.message.text;
    const question = this.parseQuestion(ctx);
    if (question === null) return null;
    const language = question.language;
    if (question.kind === 'write-refused') {
      // ADR-0110 amendment (CWR-2): the exact request (or a usage hint) goes to the runtime's connector-write flow; this
      // handler creates no approval and makes no write. While writes are off the runtime replies `fallbackText`, the
      // fixed read-only refusal. The history keeps a fixed note, never event text.
      this.log('info', 'calendar.turn_handler.write_draft', {});
      return {
        kind: 'write-draft',
        draft: this.withRecentListing(parseCalendarWriteRequest(text, { now: ctx.now, timeZone: this.deps.timeZone }), ctx),
        fallbackText: renderCalendarWriteRefused(language),
        history: { assistant: renderCalendarHistoryNote(language) },
      };
    }

    const window = placeCalendarSpan(question.span, ctx.now, this.deps.timeZone);
    if (window === undefined) return this.reply(ctx, renderCalendarInvalidDate(language), 'RESPONDED', language);
    const answered = await this.answer(ctx, window, question.remaining === true, language);
    // ADR-0120 follow-up: the structural `calendar.events` equivalent of what this grammar just listed.
    return answered.status === 'FAILED' ? answered : { ...answered, nlSelection: calendarGrammarSelection(window, question.remaining === true) };
  }

  /** The schedule grammar exactly as `handle` reads it (a reminder is never a schedule question); `null` on no match. */
  private parseQuestion(ctx: TurnHandlerProbeContext): ReturnType<typeof parseCalendarQuestion> {
    try {
      if (parseReminderMessage(ctx.message.text, { now: ctx.now, timeZone: this.deps.timeZone }).kind !== 'NOT_REMINDER') return null;
      return parseCalendarQuestion(ctx.message.text, { yieldToSelection: ctx.grammarYield === true });
    } catch {
      return null;
    }
  }

  /**
   * ADR-0120 D6 Phase C: the schedule-question grammar (frozen Class B, ADR-0110 D3) would answer this message, with the
   * `calendar.events` equivalent of the span it would list. A write request is Class A (`null`). Pure: nothing is read.
   */
  classBProbe(ctx: TurnHandlerProbeContext): NlClassBProbe | null {
    const question = this.parseQuestion(ctx);
    if (question === null || question.kind === 'write-refused') return null;
    try {
      const window = placeCalendarSpan(question.span, ctx.now, this.deps.timeZone);
      if (window !== undefined) return { grammarId: CALENDAR_GRAMMAR_ID, selection: calendarGrammarSelection(window, question.remaining === true) };
    } catch {
      // An unplaceable span is still the grammar's turn (it answers with the invalid-date note).
    }
    return { grammarId: CALENDAR_GRAMMAR_ID };
  }

  /** ADR-0120 D1: `calendar.events`, offered whenever this handler is registered (a reader is configured, D5). */
  readonly catalog: readonly NlCatalogEntry[] = Object.freeze([nlWave1Entry('calendar.events')]);

  /**
   * A validated `calendar.events` selection (ADR-0120 interfaces): the Core-resolved range (at most 31 days, or the
   * next-event lookahead) read and rendered exactly like a schedule question — no provider, history note only.
   */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    if (selected.entryId !== 'calendar.events' || selected.range === undefined) return null;
    const part = nlStringArg(selected.args, 'partOfDay');
    const partOfDay = (CALENDAR_PART_OF_DAY_VALUES as readonly string[]).includes(part ?? '') ? (part as CalendarPartOfDay) : undefined;
    const narrowing = {
      ...(partOfDay !== undefined ? { partOfDay } : {}),
      ...(nlFlagArg(selected.args, 'timedOnly') ? { timedOnly: true as const } : {}),
      ...(nlFlagArg(selected.args, 'availability') ? { availability: true as const } : {}),
    };
    return this.answer(ctx, calendarWindowOfRange(selected.range, ctx.now, this.deps.timeZone), nlFlagArg(selected.args, 'remaining'), selected.language, nlStringArg(selected.args, 'keyword'), narrowing);
  }

  /** Read `window` once and answer with the deterministic list (shared by the grammar and selection). */
  private async answer(
    ctx: TurnHandlerContext,
    window: CalendarWindow,
    remainingOnly: boolean,
    language: CalendarLanguage,
    keyword?: string,
    narrowing: CalendarNarrowing = {},
  ): Promise<TurnHandlerReply> {
    // "남은 일정" (Codex P2 on 5594c16): read from now, and drop any timed event that already ended, in case a reader
    // returns the whole day anyway; a span that is already over reads nothing.
    const remaining = remainingOnly;
    const nowMs = Date.parse(ctx.now);
    const from = remaining && nowMs > Date.parse(window.from) ? ctx.now : window.from;
    let events: readonly CalendarEvent[];
    let pageFull = false;
    let excludedAllDay = 0;
    // The next-event window has no day to narrow: part of day and timed-only apply to a listed period only.
    const narrows = window.span.kind !== 'next' && (narrowing.partOfDay !== undefined || narrowing.timedOnly === true);
    try {
      events =
        remaining && nowMs >= Date.parse(window.to)
          ? []
          : await this.readWithTimeout({ from, to: window.to, limit: CALENDAR_EVENTS_MAX_LIMIT });
      pageFull = events.length >= CALENDAR_EVENTS_MAX_LIMIT;
      if (remaining) events = events.filter((event) => !hasFinished(event, nowMs));
      // Live UAT R2/R5: a part of the day keeps the timed events that overlap it on some day of the window; timed-only
      // drops all-day entries (leave, holidays). Both leave all-day events out and count them, so the reply says so.
      if (narrows) {
        excludedAllDay = events.filter((event) => event.allDay).length;
        events = events.filter((event) => !event.allDay);
        if (narrowing.partOfDay !== undefined) {
          const parts = partOfDayWindows(window, narrowing.partOfDay, this.deps.timeZone);
          events = events.filter((event) => overlapsAny(event, parts));
        }
      }
      // ADR-0120 follow-up: a grounded title keyword narrows the fetched events here, on the title only, case-insensitively.
      // Titles never reach the model (ADR-0110 D4); the filter runs after the read and the remaining filter.
      if (keyword !== undefined) {
        const needle = keyword.normalize('NFC').toLowerCase();
        events = events.filter((event) => event.title.normalize('NFC').toLowerCase().includes(needle));
      }
    } catch (error) {
      const failure: CalendarReadFailure =
        error instanceof CalendarReadTimeout ? 'TIMEOUT' : isConnectorQueryError(error) ? error.reason : 'UNAVAILABLE';
      this.log('warn', 'calendar.turn_handler.read_failed', { span: window.span.kind, reason: failure });
      return this.reply(ctx, renderCalendarReadFailure(failure, language), 'FAILED', language);
    }
    this.log('info', 'calendar.turn_handler.answered', { span: window.span.kind, events: events.length });
    const renderOptions = {
      timeZone: this.deps.timeZone,
      now: ctx.now,
      language,
      limit: CALENDAR_EVENTS_MAX_LIMIT,
      writesEnabled: this.deps.writesEnabled === true,
      ...(remaining ? { remaining: true } : {}),
      ...(narrows && narrowing.partOfDay !== undefined ? { partOfDay: narrowing.partOfDay } : {}),
      ...(narrows && narrowing.timedOnly === true ? { timedOnly: true } : {}),
      ...(narrowing.availability === true ? { availability: true } : {}),
      ...(excludedAllDay > 0 ? { excludedAllDay } : {}),
      // A full page was narrowed after the read: the answer may be incomplete, so it says so and claims no free time.
      ...(pageFull ? { pageFull: true } : {}),
      ...((keyword !== undefined || narrows || narrowing.availability === true) && pageFull ? { partial: true } : {}),
      ...(keyword !== undefined ? { keyword } : {}),
    };
    const reply = renderCalendarEvents(window, events, renderOptions);
    this.rememberListing(ctx.session.id, ctx.actor.id, {
      at: ctx.now,
      window: { from: window.from, to: window.to },
      eventIds: calendarListedEventIds(window, events, renderOptions),
    });
    return this.reply(ctx, reply, 'RESPONDED', language);
  }

  /** An empty list replaces an older one too: "the last list shown" had nothing to pick. */
  private rememberListing(sessionId: Id, actorId: Id, listing: CalendarRecentListing): void {
    const key = listingKey(sessionId, actorId);
    this.recentListings.delete(key);
    this.recentListings.set(key, { ...listing, sessionId, actorId });
    while (this.recentListings.size > CALENDAR_RECENT_LISTINGS_MAX) {
      const oldest = this.recentListings.keys().next().value;
      if (oldest === undefined) break;
      this.recentListings.delete(oldest);
    }
  }

  /** An undated update / delete carries this session's last list (within the ADR-0093 lifetime) to the flow. */
  private withRecentListing(draft: ConnectorWriteDraft, ctx: TurnHandlerContext): ConnectorWriteDraft {
    if ((draft.kind !== 'calendar-update' && draft.kind !== 'calendar-delete') || draft.ref.inferredDay !== true) return draft;
    const key = listingKey(ctx.session.id, ctx.actor.id);
    const listing = this.recentListings.get(key);
    if (!listing || listing.sessionId !== ctx.session.id || listing.actorId !== ctx.actor.id) return draft;
    const age = Date.parse(ctx.now) - Date.parse(listing.at);
    if (!Number.isFinite(age) || age < 0 || age >= PENDING_APPROVAL_TTL_MS) {
      this.recentListings.delete(key);
      return draft;
    }
    const ref = { ...draft.ref, recentListing: { at: listing.at, window: listing.window, eventIds: [...listing.eventIds] } };
    return { ...draft, ref };
  }

  private reply(
    ctx: TurnHandlerContext,
    text: MessageBody,
    status: 'RESPONDED' | 'FAILED',
    language: CalendarLanguage,
  ): TurnHandlerReply {
    return {
      reply: outboundMessage(ctx.message.context, text, { replyToMessageId: ctx.message.id }),
      status,
      history: { assistant: renderCalendarHistoryNote(language) },
    };
  }

  private async readWithTimeout(query: Parameters<CalendarReader['listEvents']>[0]): Promise<readonly CalendarEvent[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CalendarReadTimeout()), this.deps.timeoutMs ?? CALENDAR_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.deps.reader.listEvents(query), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

/** The narrowing of a selected calendar read (live UAT R2/R5). */
interface CalendarNarrowing {
  readonly partOfDay?: CalendarPartOfDay;
  readonly timedOnly?: true;
  readonly availability?: true;
}

/** Local-hour bounds of the closed parts of a day: morning 00-12, afternoon 12-18, evening 18-24. */
const PART_OF_DAY_HOURS: Readonly<Record<CalendarPartOfDay, readonly [number, number]>> = {
  morning: [0, 12],
  afternoon: [12, 18],
  evening: [18, 24],
};

/** The `[from, to)` instants of `part` on every local day of `window`. */
function partOfDayWindows(window: CalendarWindow, part: CalendarPartOfDay, timeZone: string): ReadonlyArray<readonly [number, number]> {
  const [startHour, endHour] = PART_OF_DAY_HOURS[part];
  const spans: Array<readonly [number, number]> = [];
  for (let offset = 0; offset < window.days; offset += 1) {
    const day = addLocalDays(window.startDate, offset);
    const from = zonedToUtcIso({ ...day, hour: startHour, minute: 0 }, timeZone);
    const to = endHour === 24 ? zonedToUtcIso({ ...addLocalDays(day, 1), hour: 0, minute: 0 }, timeZone) : zonedToUtcIso({ ...day, hour: endHour, minute: 0 }, timeZone);
    spans.push([Date.parse(from), Date.parse(to)]);
  }
  return spans;
}

/** Whether a timed event overlaps one of the spans (an instantaneous event counts when it starts inside one). */
function overlapsAny(event: CalendarEvent, spans: ReadonlyArray<readonly [number, number]>): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!Number.isFinite(start)) return false;
  const last = Number.isFinite(end) && end > start ? end : start + 1;
  return spans.some(([from, to]) => start < to && last > from);
}

/** The cache key of one actor's last list in one conversation. */
function listingKey(sessionId: Id, actorId: Id): string {
  return JSON.stringify([sessionId, actorId]);
}

/** Factory for the composition root (ADR-0096 D7). */
export function createCalendarTurnHandler(deps: CalendarTurnHandlerDeps): CalendarTurnHandler {
  return new CalendarTurnHandler(deps);
}

/**
 * Whether a timed event is over at `nowMs` (it ended at or before now). An all-day event the read returned is kept: it
 * overlaps the window, so it still covers the rest of that day.
 */
function hasFinished(event: CalendarEvent, nowMs: number): boolean {
  if (event.allDay) return false;
  const endMs = Date.parse(event.end);
  return Number.isFinite(endMs) && endMs <= nowMs;
}

/**
 * The reverse of {@link calendarWindowOfRange} (ADR-0120 follow-up): the canonical `calendar.events` args of a window the
 * calendar grammar answered — a closed range symbol, or the single local date for a span with no symbol. Defaults omitted.
 */
export function calendarGrammarSelection(window: CalendarWindow, remaining: boolean): NlGrammarSelection {
  const span = window.span;
  let range: string | undefined;
  switch (span.kind) {
    case 'day':
      range = span.offset === 0 ? undefined : span.offset === 1 ? 'tomorrow' : span.offset === 2 ? 'day-after-tomorrow' : span.offset === -1 ? 'yesterday' : isoDateOf(window.startDate);
      break;
    case 'week':
      range = span.which === 'next' ? 'next-week' : 'this-week';
      break;
    case 'weekend':
      range = span.which === 'next' ? 'next-weekend' : 'this-weekend';
      break;
    case 'next':
      range = 'upcoming';
      break;
    case 'weekday':
    case 'date':
      range = isoDateOf(window.startDate);
      break;
  }
  return { entryId: 'calendar.events', args: { ...(range !== undefined ? { range } : {}), ...(remaining ? { remaining: true } : {}) } };
}

/**
 * The calendar window of a Core-resolved selection range (ADR-0120 D4): the named spans keep their labels ("오늘",
 * "이번 주", "다음 일정"); any other range is its own date span.
 */
export function calendarWindowOfRange(range: NlResolvedRange, now: string, timeZone: string): CalendarWindow {
  const named =
    range.upcoming === true
      ? placeCalendarSpan({ kind: 'next' }, now, timeZone)
      : range.dayOffset !== undefined
        ? placeCalendarSpan({ kind: 'day', offset: range.dayOffset }, now, timeZone)
        : range.symbol === 'this-week' || range.symbol === 'next-week'
          ? placeCalendarSpan({ kind: 'week', which: range.symbol === 'next-week' ? 'next' : 'this' }, now, timeZone)
          : range.symbol === 'this-weekend' || range.symbol === 'next-weekend'
            ? placeCalendarSpan({ kind: 'weekend', which: range.symbol === 'next-weekend' ? 'next' : 'this' }, now, timeZone)
            : undefined;
  if (named !== undefined) return named;
  return {
    span: { kind: 'date', month: range.startDate.month, day: range.startDate.day },
    from: range.from,
    to: range.to,
    startDate: range.startDate,
    days: range.days,
  };
}
