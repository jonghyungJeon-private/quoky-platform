import type { IsoTimestamp } from '../../domain';
import type { CalendarEvent } from '../../ports/calendar-reader.port';
import type { ConnectorQueryErrorReason } from '../../ports/connector-query';
import { containsCredentialMaterial } from '../credential-guard';
import { escapeDiscordText } from '../work-chat/external-work-readout';
import {
  addLocalDays,
  compareLocalDates,
  localDateOf,
  toZonedDateTime,
  weekdayOf,
  type LocalDate,
} from '../reminders/zoned-time';
import type { CalendarLanguage, CalendarWindow } from './calendar-question';

/**
 * Deterministic calendar replies (ADR-0110 D3, CAL-2). Pure: every instant is rendered in the owner's zone
 * (`QUOKY_TIMEZONE`) from the event data and the window; nothing here reads a clock, calls a provider or a reader.
 *
 * Event text (title, location) is untrusted readout (ADR-0100 D8): clipped, escaped for Discord (no mentions, no
 * markdown), and replaced by a placeholder when it looks like credential material. Replies stay inside one Discord
 * message (`CALENDAR_REPLY_MAX_CHARS`) and list at most `CALENDAR_REPLY_MAX_EVENTS` events.
 */

export const CALENDAR_REPLY_MAX_CHARS = 1900;
export const CALENDAR_REPLY_MAX_EVENTS = 20;
export const CALENDAR_TITLE_DISPLAY_MAX_CHARS = 80;
export const CALENDAR_LOCATION_DISPLAY_MAX_CHARS = 40;

/** Why a calendar read produced no list: the ADR-0100 reasons plus the handler's own timeout. */
export type CalendarReadFailure = ConnectorQueryErrorReason | 'TIMEOUT';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

interface PlacedEvent {
  readonly event: CalendarEvent;
  /** Local start / last date (inclusive) of the event. */
  readonly firstDate: LocalDate;
  readonly lastDate: LocalDate;
  /** Sort key and "upcoming" test: the start instant (local midnight for an all-day event). */
  readonly startMs: number;
}

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`;
}

function parseDate(value: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function sameDate(a: LocalDate, b: LocalDate): boolean {
  return compareLocalDates(a, b) === 0;
}

function place(event: CalendarEvent, timeZone: string): PlacedEvent | undefined {
  if (event.allDay) {
    const first = parseDate(event.start);
    const endExclusive = parseDate(event.end);
    if (first === undefined || endExclusive === undefined) return undefined;
    const last = compareLocalDates(endExclusive, first) > 0 ? addLocalDays(endExclusive, -1) : first;
    return { event, firstDate: first, lastDate: last, startMs: Date.UTC(first.year, first.month - 1, first.day) };
  }
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  // An event ending exactly at local midnight does not reach into the next day.
  const lastMs = endMs > startMs ? endMs - 1 : startMs;
  return { event, firstDate: localDateOf(startMs, timeZone), lastDate: localDateOf(lastMs, timeZone), startMs };
}

function dateLabel(date: LocalDate, language: CalendarLanguage): string {
  const weekday = weekdayOf(date);
  return language === 'en'
    ? `${WEEKDAY_EN[weekday]}, ${MONTH_EN[date.month - 1]} ${date.day}`
    : `${date.month}월 ${date.day}일(${WEEKDAY_KO[weekday]})`;
}

function shortDate(date: LocalDate, language: CalendarLanguage): string {
  return language === 'en' ? `${MONTH_EN[date.month - 1]} ${date.day}` : `${date.month}월 ${date.day}일`;
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A timed instant relative to the day it is listed under: "09:00", "24:00" (midnight ending that day) or a dated form. */
function instantLabel(ms: number, day: LocalDate, timeZone: string, language: CalendarLanguage, isEnd: boolean): string {
  const local = toZonedDateTime(ms, timeZone);
  const date = { year: local.year, month: local.month, day: local.day };
  if (sameDate(date, day)) return hhmm(local.hour, local.minute);
  if (isEnd && local.hour === 0 && local.minute === 0 && sameDate(date, addLocalDays(day, 1))) return '24:00';
  return `${shortDate(date, language)} ${hhmm(local.hour, local.minute)}`;
}

function whenLabel(placed: PlacedEvent, day: LocalDate, timeZone: string, language: CalendarLanguage): string {
  const allDay = language === 'en' ? 'All day' : '종일';
  if (placed.event.allDay) {
    if (sameDate(placed.firstDate, placed.lastDate)) return allDay;
    const range = `${shortDate(placed.firstDate, language)}–${shortDate(placed.lastDate, language)}`;
    return `${allDay} (${range})`;
  }
  const endMs = Date.parse(placed.event.end);
  return `${instantLabel(placed.startMs, day, timeZone, language, false)}–${instantLabel(endMs, day, timeZone, language, true)}`;
}

function untrusted(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  const text = clip(value, maxChars);
  if (text.length === 0) return undefined;
  if (containsCredentialMaterial(value)) return undefined;
  return escapeDiscordText(text);
}

function titleOf(event: CalendarEvent, language: CalendarLanguage): string {
  if (event.title.trim().length > 0 && containsCredentialMaterial(event.title)) {
    return language === 'en' ? '(title hidden)' : '(제목 숨김)';
  }
  return untrusted(event.title, CALENDAR_TITLE_DISPLAY_MAX_CHARS) ?? (language === 'en' ? '(no title)' : '(제목 없음)');
}

function eventLine(placed: PlacedEvent, day: LocalDate, timeZone: string, language: CalendarLanguage): string {
  const location = untrusted(placed.event.location, CALENDAR_LOCATION_DISPLAY_MAX_CHARS);
  const tentative = placed.event.status === 'tentative' ? (language === 'en' ? ' (tentative)' : ' (미정)') : '';
  return `- ${whenLabel(placed, day, timeZone, language)} ${titleOf(placed.event, language)}${location ? ` · ${location}` : ''}${tentative}`;
}

function relativeDayLabel(offset: number | undefined, language: CalendarLanguage): string | undefined {
  const ko: Record<number, string> = { [-1]: '어제', 0: '오늘', 1: '내일', 2: '모레', 3: '글피' };
  const en: Record<number, string> = { [-1]: 'Yesterday', 0: 'Today', 1: 'Tomorrow' };
  if (offset === undefined) return undefined;
  return (language === 'en' ? en : ko)[offset];
}

/** "오늘(10월 6일(화))" → "오늘 · 10월 6일(화)"; "이번 주 · 10월 5일(월)~10월 11일(일)". */
function periodLabel(window: CalendarWindow, language: CalendarLanguage): string {
  const first = window.startDate;
  const last = addLocalDays(first, window.days - 1);
  const range = window.days === 1 ? dateLabel(first, language) : `${dateLabel(first, language)} ~ ${dateLabel(last, language)}`;
  const span = window.span;
  let name: string | undefined;
  if (span.kind === 'day') name = relativeDayLabel(window.dayOffset, language);
  else if (span.kind === 'week') name = language === 'en' ? (span.which === 'next' ? 'Next week' : 'This week') : span.which === 'next' ? '다음 주' : '이번 주';
  else if (span.kind === 'weekend') name = language === 'en' ? (span.which === 'next' ? 'Next weekend' : 'This weekend') : span.which === 'next' ? '다음 주말' : '이번 주말';
  return name === undefined ? range : `${name} · ${range}`;
}

function footer(timeZone: string, language: CalendarLanguage, truncatedAt?: number, writesEnabled = false): string {
  const zone = escapeDiscordText(timeZone);
  const base =
    language === 'en'
      ? writesEnabled
        ? `(Times in ${zone})`
        : `(Times in ${zone} · read-only calendar)`
      : writesEnabled
        ? `(${zone} 기준)`
        : `(${zone} 기준 · 캘린더 읽기 전용)`;
  if (truncatedAt === undefined) return base;
  return language === 'en'
    ? `${base}\nOnly the first ${truncatedAt} events were read; there may be more.`
    : `${base}\n캘린더에서 처음 ${truncatedAt}개까지만 읽었어요. 더 있을 수 있어요.`;
}

/** Append lines while the reply stays inside the budget; the rest is summarised as "외 N개". */
function bounded(header: string, body: readonly string[], tail: string, language: CalendarLanguage, hidden: number): string {
  const lines: string[] = [];
  let omitted = hidden;
  const reserve = 40; // room for the "외 N개" line
  let length = Array.from(header).length + Array.from(tail).length + 2 + reserve;
  for (const [index, line] of body.entries()) {
    const size = Array.from(line).length + 1;
    if (length + size > CALENDAR_REPLY_MAX_CHARS) {
      omitted += body.slice(index).filter((entry) => entry.startsWith('- ')).length;
      break;
    }
    lines.push(line);
    length += size;
  }
  // Never end on a dangling day heading.
  while (lines.length > 0 && !(lines[lines.length - 1] as string).startsWith('- ')) lines.pop();
  if (omitted > 0) lines.push(language === 'en' ? `…and ${omitted} more` : `…외 ${omitted}개`);
  return [header, ...lines, tail].join('\n');
}

export interface CalendarRenderOptions {
  readonly timeZone: string;
  readonly now: IsoTimestamp;
  readonly language: CalendarLanguage;
  /** The `limit` the read used: a full page means there may be more events. */
  readonly limit: number;
  /** Calendar writes are bound: the footer then omits the "read-only" note. */
  readonly writesEnabled?: boolean;
}

function placedInWindow(window: CalendarWindow, events: readonly CalendarEvent[], timeZone: string): PlacedEvent[] {
  const first = window.startDate;
  const last = addLocalDays(first, window.days - 1);
  return events
    .map((event) => place(event, timeZone))
    .filter((entry): entry is PlacedEvent => entry !== undefined)
    .filter((entry) => compareLocalDates(entry.lastDate, first) >= 0 && compareLocalDates(entry.firstDate, last) <= 0)
    .sort((a, b) => Number(b.event.allDay) - Number(a.event.allDay) || a.startMs - b.startMs);
}

function nextEventOf(events: readonly CalendarEvent[], options: CalendarRenderOptions): PlacedEvent | undefined {
  const nowMs = Date.parse(options.now);
  const today = localDateOf(nowMs, options.timeZone);
  const placed = events
    .map((event) => place(event, options.timeZone))
    .filter((entry): entry is PlacedEvent => entry !== undefined)
    .sort((a, b) => a.startMs - b.startMs);
  return (
    placed.find((entry) => !entry.event.allDay && entry.startMs >= nowMs) ??
    placed.find((entry) => entry.event.allDay && compareLocalDates(entry.firstDate, today) > 0)
  );
}

/**
 * The ids of the events {@link renderCalendarEvents} lists for this window, in list order (the "next" answer's one
 * event). The calendar handler keeps them as the session's recent calendar context (live QA D2).
 */
export function calendarListedEventIds(
  window: CalendarWindow,
  events: readonly CalendarEvent[],
  options: CalendarRenderOptions,
): string[] {
  const shown = window.span.kind === 'next'
    ? [nextEventOf(events, options)].filter((entry): entry is PlacedEvent => entry !== undefined)
    : placedInWindow(window, events, options.timeZone).slice(0, CALENDAR_REPLY_MAX_EVENTS);
  return shown.map((entry) => entry.event.id).filter((id) => typeof id === 'string' && id.length > 0);
}

/** The answer to a day, week or weekend question. */
export function renderCalendarEvents(
  window: CalendarWindow,
  events: readonly CalendarEvent[],
  options: CalendarRenderOptions,
): string {
  const { timeZone, language } = options;
  if (window.span.kind === 'next') return renderNextEvent(window, events, options);
  const first = window.startDate;
  const placed = placedInWindow(window, events, timeZone);
  const period = periodLabel(window, language);
  const truncatedAt = events.length >= options.limit ? options.limit : undefined;
  const tail = footer(timeZone, language, truncatedAt, options.writesEnabled === true);
  if (placed.length === 0) {
    const none = language === 'en' ? `${period}: nothing on your calendar.` : `${period}: 캘린더에 일정이 없어요.`;
    return `${none}\n${tail}`;
  }
  const header =
    language === 'en'
      ? `${period}: ${placed.length} event${placed.length === 1 ? '' : 's'}`
      : `${period}: 일정 ${placed.length}개`;

  const shown = placed.slice(0, CALENDAR_REPLY_MAX_EVENTS);
  const hidden = placed.length - shown.length;
  const body: string[] = [];
  if (window.days === 1) {
    for (const entry of shown) body.push(eventLine(entry, first, timeZone, language));
  } else {
    // Grouped by the first day of the window the event falls on (an event that started earlier is listed on day one).
    const byDay = new Map<string, { day: LocalDate; entries: PlacedEvent[] }>();
    for (const entry of shown) {
      const day = compareLocalDates(entry.firstDate, first) < 0 ? first : entry.firstDate;
      const key = `${day.year}-${day.month}-${day.day}`;
      const group = byDay.get(key) ?? { day, entries: [] };
      group.entries.push(entry);
      byDay.set(key, group);
    }
    const groups = [...byDay.values()].sort((a, b) => compareLocalDates(a.day, b.day));
    for (const group of groups) {
      body.push(dateLabel(group.day, language));
      for (const entry of group.entries) body.push(eventLine(entry, group.day, timeZone, language));
    }
  }
  return bounded(header, body, tail, language, hidden);
}

/** "다음 회의 언제야?": the first timed event starting at or after now; else the first all-day event after today. */
function renderNextEvent(window: CalendarWindow, events: readonly CalendarEvent[], options: CalendarRenderOptions): string {
  const { timeZone, language } = options;
  const next = nextEventOf(events, options);
  const tail = footer(timeZone, language, undefined, options.writesEnabled === true);
  if (next === undefined) {
    return language === 'en'
      ? `Nothing upcoming on your calendar in the next ${window.days} days.\n${tail}`
      : `앞으로 ${window.days}일 안에 예정된 일정이 없어요.\n${tail}`;
  }
  const line = eventLine(next, next.firstDate, timeZone, language).slice(2);
  const day = dateLabel(next.firstDate, language);
  return language === 'en' ? `Next on your calendar: ${day} ${line}\n${tail}` : `다음 일정: ${day} ${line}\n${tail}`;
}

/** A date the calendar does not have ("2월 30일"). No read was made. */
export function renderCalendarInvalidDate(language: CalendarLanguage): string {
  return language === 'en'
    ? "That date doesn't exist on the calendar, so I didn't look anything up. Try another date."
    : '달력에 없는 날짜라서 일정을 조회하지 않았어요. 다른 날짜로 다시 물어봐 주세요.';
}

/** A failed read: truthful, value-free, and never "no events" (the schedule was not checked). */
export function renderCalendarReadFailure(failure: CalendarReadFailure, language: CalendarLanguage): string {
  const en = language === 'en';
  switch (failure) {
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPE':
      return en
        ? "I couldn't read your calendar: the calendar connection was rejected (expired or changed permissions). Re-run the calendar consent helper (calendar-auth) to reconnect. Your schedule was not checked."
        : '캘린더 인증이 거부돼서 일정을 확인하지 못했어요. 연결이 만료됐거나 권한이 바뀌었을 수 있어요. 캘린더 동의 도우미(calendar-auth)로 다시 연결해 주세요.';
    case 'NOT_FOUND':
      return en
        ? "I couldn't find the configured calendar, so your schedule was not checked. Check QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS."
        : '설정된 캘린더를 찾지 못해서 일정을 확인하지 못했어요. QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS 설정을 확인해 주세요.';
    case 'RATE_LIMITED':
      return en
        ? 'The calendar is rate-limiting requests right now, so your schedule was not checked. Please try again shortly.'
        : '캘린더 요청 한도에 걸려서 일정을 확인하지 못했어요. 잠시 후 다시 물어봐 주세요.';
    case 'UNSUPPORTED_QUERY':
      return en ? "I can't look up that period on the calendar." : '그 기간은 캘린더에서 조회할 수 없어요.';
    case 'INVALID_RESPONSE':
      return en
        ? "I couldn't understand the calendar's response, so your schedule was not checked."
        : '캘린더 응답을 해석하지 못해서 일정을 확인하지 못했어요.';
    case 'TIMEOUT':
      return en
        ? "The calendar didn't answer in time, so your schedule was not checked. Please try again shortly."
        : '캘린더가 제한 시간 안에 응답하지 않아서 일정을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'UNAVAILABLE':
    default:
      return en
        ? "I can't reach the calendar right now, so your schedule was not checked. Please try again shortly."
        : '지금은 캘린더에 연결할 수 없어서 일정을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

/** ADR-0110 D6 (calendar writes ship with CWR-2): a create/move/delete request changes nothing. */
export function renderCalendarWriteRefused(language: CalendarLanguage): string {
  return language === 'en'
    ? "I can only read your calendar for now. Creating, moving or deleting events isn't available yet, so nothing was changed."
    : '지금은 캘린더를 읽기만 할 수 있어요. 일정 추가·변경·삭제는 아직 지원하지 않아서 아무것도 바꾸지 않았어요.';
}

/**
 * What the SHORT_TERM conversation history keeps instead of the reply (TurnHandlerReply.history): no event text, so a
 * later chat turn's context — which may go to a REMOTE provider — never carries calendar content (ADR-0110 D4).
 */
export function renderCalendarHistoryNote(language: CalendarLanguage): string {
  return language === 'en'
    ? '[Quoky answered a calendar question from the calendar; event details are not kept in the conversation history.]'
    : '[캘린더 조회 응답 — 일정 내용은 대화 기록에 남기지 않아요.]';
}
