import type { IsoTimestamp } from '../../domain';
import { calendarWindowForDays } from '../../ports/calendar-window';
import {
  CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH,
  type CalendarEventDraft,
  type CalendarEventTime,
} from '../../ports/connector-write.port';
import { CALENDAR_EVENT_LOCATION_MAX_LENGTH, CALENDAR_EVENT_TITLE_MAX_LENGTH } from '../../ports/calendar-reader.port';
import type {
  CalendarDraftChanges,
  CalendarEventReference,
  ConnectorWriteClockTime,
  ConnectorWriteDraft,
  ConnectorWriteLocalDate,
} from '../connector-writes/connector-write-draft';
import { addLocalDays, isValidLocalDate, zonedToUtc, type LocalDate } from '../reminders/zoned-time';
import { extractSpan, placeCalendarSpan } from './calendar-question';

/**
 * Calendar WRITE requests (ADR-0110 amendment D3, CWR-2) — the pure grammar that turns a message the calendar handler
 * already classified as a write (`isCalendarWriteRequest`) into an exact `ConnectorWriteDraft`. No clock of its own
 * (`now` is an input), no IO, no model.
 *
 * - **Delete** (`취소`, `삭제`, `지워`, `빼`): "내일 3시 회의 취소해줘". **Update** (`옮겨`, `바꿔`, `미뤄`, `당겨`, `변경`,
 *   `이동`): a time move "내일 3시 회의 4시로 옮겨줘" (the duration is kept), or "… 제목을 X로 바꿔줘" / "… 장소를 X로
 *   바꿔줘". **Create** otherwise: "내일 오후 3시에 회의 잡아줘 제목 주간 회의 장소 3층".
 * - The event an update or delete means is a REFERENCE (day + optional start time + optional quoted title); the write
 *   flow lists that day and asks which one when more than one matches — this grammar never picks an event.
 * - Day words reuse the read grammar's `extractSpan` (today when none is named); a week, weekend or "next" span is
 *   too broad for a write and becomes a usage hint.
 * - Clock times follow the reminder convention with a day: an explicit 오전/오후 (아침, 낮, 점심, 저녁, 밤) wins; without
 *   one, 1–6 is afternoon, 7–11 morning, 12 noon, and 0 or 13–23 is taken as written. "반" is 30 minutes.
 * - A new event without an end lasts one hour; "3시부터 4시까지", "3시~4시" and "1시간"/"30분" set it. "종일" is an
 *   all-day event. The title is the text after "제목" (or a quoted text), else the meeting noun the owner used.
 * - Anything write-shaped that does not parse exactly is a `usage` draft (the reply explains the forms).
 */

export interface CalendarWriteGrammarOptions {
  readonly now: IsoTimestamp;
  /** `QUOKY_TIMEZONE`: every date and time is read and written in this zone. */
  readonly timeZone: string;
}

const DEFAULT_DURATION_MINUTES = 60;
const MAX_DURATION_MINUTES = 24 * 60;

const DELETE_VERB = /(?:취소|삭제|지워|지우|빼)\s*(?:해)?\s*(?:줘|주세요|줄래|주실래요|줄\s*수\s*있)|\b(?:cancel|delete|remove)\b/iu;
const UPDATE_VERB = /(?:옮겨|바꿔|미뤄|당겨|(?:변경|수정|이동|조정)\s*해)\s*(?:줘|주세요|줄래|주실래요|줄\s*수\s*있)|\b(?:move|reschedule|postpone|push\s+back)\b/iu;

const MERIDIEM = String.raw`(?:(오전|오후|아침|새벽|낮|점심|저녁|밤)\s*)?`;
const CLOCK = String.raw`${MERIDIEM}(?:(\d{1,2})\s*시(?!간)(?:\s*(\d{1,2})\s*분|\s*(반))?|(\d{1,2}):(\d{2}))`;
const CLOCK_RE = new RegExp(CLOCK, 'u');
const RANGE_RE = new RegExp(String.raw`${CLOCK}\s*(?:부터|~|〜|-|–|에서)\s*${CLOCK}(?:\s*까지)?`, 'u');
const DURATION_RE = /(\d{1,2})\s*시간(?:\s*(반))?(?:\s*(\d{1,2})\s*분)?|(?<![시\d])(\d{1,3})\s*분\s*(?:동안|짜리|간)/u;
const ALL_DAY = /종일|하루\s*종일|하루\s*일정|all[\s-]?day/iu;
const FIELD_KEYWORD = /(제목|장소|위치|설명|메모)\s*(?:은|는|:|：)?\s*/gu;
const QUOTED = /"([^"]{1,200})"|“([^”]{1,200})”|'([^']{1,200})'|‘([^’]{1,200})’|「([^」]{1,200})」|『([^』]{1,200})』/u;
const MEETING_NOUN = /(회의|미팅|약속|면담|통화|콜|점심|저녁\s*약속|일정)/u;
const DAY_WORD = String.raw`(?:오늘|내일|낼|모레|글피|(?:이번|다음)\s*주\s*[월화수목금토일]요일|[월화수목금토일]요일|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*/\s*\d{1,2})`;
/** "4시로 옮겨줘", "모레 오후 4시로 미뤄줘" — the new time of a move. */
const MOVE_TARGET = new RegExp(
  String.raw`(?:(${DAY_WORD})\s*)?${CLOCK}\s*(?:으로|로)\s*(?:옮겨|바꿔|미뤄|당겨|(?:변경|수정|이동|조정)\s*해)`,
  'u',
);
const RENAME = /제목\s*(?:을|를)?\s*([\s\S]{1,200}?)\s*(?:으로|로)\s*(?:바꿔|변경\s*해|수정\s*해)/u;
const RELOCATE = /(?:장소|위치)\s*(?:을|를)?\s*([\s\S]{1,200}?)\s*(?:으로|로)\s*(?:바꿔|변경\s*해|수정\s*해|옮겨)/u;

function normalize(text: string): string {
  return text.normalize('NFC').trim();
}

/** 24-hour clock from one CLOCK match starting at `offset` in `groups` (meridiem, h, m, 반, hh, mm). */
function clockOf(groups: readonly (string | undefined)[], offset: number): ConnectorWriteClockTime | undefined {
  const meridiem = groups[offset];
  const koHour = groups[offset + 1];
  const koMinute = groups[offset + 2];
  const half = groups[offset + 3];
  const colonHour = groups[offset + 4];
  const colonMinute = groups[offset + 5];
  let hour: number;
  let minute: number;
  let written24 = false;
  if (colonHour !== undefined && colonMinute !== undefined) {
    hour = Number(colonHour);
    minute = Number(colonMinute);
    written24 = true;
  } else if (koHour !== undefined) {
    hour = Number(koHour);
    minute = half !== undefined ? 30 : koMinute !== undefined ? Number(koMinute) : 0;
  } else {
    return undefined;
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return undefined;
  }
  switch (meridiem) {
    case '오전':
    case '아침':
    case '새벽':
      if (hour > 12) return undefined;
      return { hour: hour === 12 ? 0 : hour, minute };
    case '오후':
    case '저녁':
    case '밤':
      if (hour === 0) return undefined;
      return { hour: hour >= 12 ? hour : hour + 12, minute };
    case '낮':
    case '점심':
      return { hour: hour >= 12 ? hour : hour <= 6 ? hour + 12 : hour, minute };
    default:
      if (written24 || hour === 0 || hour > 12) return { hour, minute };
      return { hour: hour === 12 ? 12 : hour <= 6 ? hour + 12 : hour, minute };
  }
}

/** The single day a write is about, or undefined when the message names a week / weekend / "next" span. */
function dayOf(text: string, options: CalendarWriteGrammarOptions): LocalDate | undefined {
  const span = extractSpan(text);
  if (span.kind !== 'day' && span.kind !== 'weekday' && span.kind !== 'date') return undefined;
  const window = placeCalendarSpan(span, options.now, options.timeZone);
  return window?.startDate;
}

function toLocal(date: LocalDate): ConnectorWriteLocalDate {
  return { year: date.year, month: date.month, day: date.day };
}

/** ISO instant with the zone's offset (`2026-10-07T15:00:00+09:00`) for a wall-clock time, or undefined in a DST gap. */
function zonedInstant(date: LocalDate, time: ConnectorWriteClockTime, timeZone: string): string | undefined {
  const resolved = zonedToUtc({ ...date, hour: time.hour, minute: time.minute }, timeZone);
  if (resolved.resolution === 'NONEXISTENT') return undefined;
  return new Date(resolved.epochMs).toISOString();
}

/** Text after each field keyword, up to the next keyword (verbatim, outer whitespace and trailing punctuation removed). */
function fieldsOf(text: string): { head: string; title?: string; location?: string; description?: string } {
  const matches = [...text.matchAll(FIELD_KEYWORD)];
  if (matches.length === 0) return { head: text };
  const head = text.slice(0, matches[0]?.index ?? text.length);
  const fields: { title?: string; location?: string; description?: string } = {};
  matches.forEach((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]?.index ?? text.length) : text.length;
    const value = stripQuotes(stripTrailingRequest(text.slice(start, end)));
    if (value.length === 0) return;
    const key = match[1];
    if (key === '제목') fields.title ??= value;
    else if (key === '장소' || key === '위치') fields.location ??= value;
    else fields.description ??= value;
  });
  return { head, ...fields };
}

/** A booking / change verb the owner wrote after a field ("제목 주간 회의로 잡아줘") is not part of the field. */
const TRAILING_REQUEST =
  /\s*(?:(?:으로|로)\s*)?(?:(?:잡아|넣어|만들어|(?:추가|등록|예약)\s*해)\s*(?:줘|주세요|줄래|주실래요)?|해\s*(?:줘|주세요))\s*[.!~]*$/u;

function stripTrailingRequest(value: string): string {
  return value.replace(/[\s,，]+$/u, '').replace(TRAILING_REQUEST, '').replace(/[\s,，]+$/u, '').trim();
}

function quotedOf(text: string): string | undefined {
  const match = QUOTED.exec(text);
  if (!match) return undefined;
  return match.slice(1).find((group) => group !== undefined)?.trim();
}

function bounded(value: string | undefined, max: number): boolean {
  return value === undefined || (value.length > 0 && Array.from(value).length <= max);
}

function durationOf(text: string): number | undefined {
  const match = DURATION_RE.exec(text);
  if (!match) return undefined;
  if (match[1] !== undefined) {
    return Number(match[1]) * 60 + (match[2] !== undefined ? 30 : 0) + (match[3] !== undefined ? Number(match[3]) : 0);
  }
  return match[4] !== undefined ? Number(match[4]) : undefined;
}

function parseCreate(text: string, options: CalendarWriteGrammarOptions): ConnectorWriteDraft {
  const usage: ConnectorWriteDraft = { kind: 'usage', topic: 'calendar-create' };
  const { head, title: fieldTitle, location, description } = fieldsOf(text);
  const date = dayOf(head, options);
  if (date === undefined) return { kind: 'usage', topic: 'calendar-span' };
  const title = fieldTitle ?? quotedOf(head) ?? MEETING_NOUN.exec(head)?.[1]?.replace(/\s+/gu, ' ');
  if (title === undefined) return usage;
  if (
    !bounded(title, CALENDAR_EVENT_TITLE_MAX_LENGTH) ||
    !bounded(location, CALENDAR_EVENT_LOCATION_MAX_LENGTH) ||
    !bounded(description, CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH)
  ) {
    return usage;
  }
  let time: CalendarEventTime;
  if (ALL_DAY.test(head)) {
    const end = addLocalDays(date, 1);
    time = { allDay: true, startDate: isoDate(date), endDate: isoDate(end) };
  } else {
    const range = RANGE_RE.exec(head);
    const startClock = range ? clockOf(range, 1) : (() => {
      const single = CLOCK_RE.exec(head);
      return single ? clockOf(single, 1) : undefined;
    })();
    if (startClock === undefined) return usage;
    let endMinutes: number;
    const startMinutes = startClock.hour * 60 + startClock.minute;
    if (range) {
      let endClock = clockOf(range, 7);
      if (endClock === undefined) return usage;
      // "오후 3시부터 4시까지": an end without its own marker inherits the afternoon of its start.
      if (range[7] === undefined && endClock.hour * 60 + endClock.minute <= startMinutes && endClock.hour < 12) {
        endClock = { hour: endClock.hour + 12, minute: endClock.minute };
      }
      endMinutes = endClock.hour * 60 + endClock.minute;
      if (endMinutes <= startMinutes) return usage;
    } else {
      const duration = durationOf(head) ?? DEFAULT_DURATION_MINUTES;
      if (duration <= 0 || duration > MAX_DURATION_MINUTES) return usage;
      endMinutes = startMinutes + duration;
    }
    const endDate = addLocalDays(date, Math.floor(endMinutes / (24 * 60)));
    const endClock = { hour: Math.floor(endMinutes / 60) % 24, minute: endMinutes % 60 };
    const start = zonedInstant(date, startClock, options.timeZone);
    const end = zonedInstant(endDate, endClock, options.timeZone);
    if (start === undefined || end === undefined) return usage;
    time = { allDay: false, start, end, timeZone: options.timeZone };
  }
  const event: CalendarEventDraft = {
    title,
    time,
    ...(location !== undefined ? { location } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  return { kind: 'calendar-create', event };
}

function referenceOf(part: string, options: CalendarWriteGrammarOptions): CalendarEventReference | undefined {
  const date = dayOf(part, options);
  if (date === undefined || !isValidLocalDate(date)) return undefined;
  const clockMatch = CLOCK_RE.exec(part);
  const startTime = clockMatch ? clockOf(clockMatch, 1) : undefined;
  if (clockMatch && startTime === undefined) return undefined;
  const quoted = quotedOf(part);
  const window = calendarWindowForDays(date, 1, options.timeZone);
  return {
    date: toLocal(date),
    window: { from: window.from, to: window.to },
    ...(startTime !== undefined ? { startTime } : {}),
    titleWords: quoted === undefined ? [] : quoted.toLowerCase().split(/\s+/u).filter((w) => w.length > 0),
  };
}

function parseUpdate(text: string, options: CalendarWriteGrammarOptions): ConnectorWriteDraft {
  const usage: ConnectorWriteDraft = { kind: 'usage', topic: 'calendar-change' };
  const move = MOVE_TARGET.exec(text);
  const rename = RENAME.exec(text);
  const relocate = RELOCATE.exec(text);
  const cut = [move?.index, rename?.index, relocate?.index].filter((i): i is number => i !== undefined);
  if (cut.length === 0) return usage;
  const reference = referenceOf(text.slice(0, Math.min(...cut)), options);
  if (reference === undefined) return { kind: 'usage', topic: 'calendar-span' };
  const changes: { moveTo?: CalendarDraftChanges['moveTo']; title?: string; location?: string } = {};
  if (move) {
    const time = clockOf(move, 2);
    if (time === undefined) return usage;
    let date: ConnectorWriteLocalDate | undefined;
    if (move[1] !== undefined) {
      const moved = dayOf(move[1], options);
      if (moved === undefined) return { kind: 'usage', topic: 'calendar-span' };
      date = toLocal(moved);
    }
    changes.moveTo = date === undefined ? { time } : { date, time };
  }
  if (rename) {
    const title = rename[1]?.trim();
    if (!title || !bounded(title, CALENDAR_EVENT_TITLE_MAX_LENGTH)) return usage;
    changes.title = stripQuotes(title);
  }
  if (relocate) {
    const location = relocate[1]?.trim();
    if (!location || !bounded(location, CALENDAR_EVENT_LOCATION_MAX_LENGTH)) return usage;
    changes.location = stripQuotes(location);
  }
  return { kind: 'calendar-update', ref: reference, changes };
}

function parseDelete(text: string, options: CalendarWriteGrammarOptions): ConnectorWriteDraft {
  const verb = DELETE_VERB.exec(text);
  const reference = referenceOf(verb ? text.slice(0, verb.index) : text, options);
  if (reference === undefined) return { kind: 'usage', topic: 'calendar-span' };
  return { kind: 'calendar-delete', ref: reference };
}

function stripQuotes(value: string): string {
  return quotedOf(value) !== undefined && /^["“'‘「『][\s\S]*["”'’」』]$/u.test(value) ? (quotedOf(value) as string) : value;
}

function isoDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Whether the message is Korean enough for this grammar (English write requests get the usage hint). */
const HANGUL = /[가-힣]/u;

/**
 * Parse a calendar write request (the caller has already decided it is one). Always returns a draft: an exact create /
 * update / delete, or a `usage` draft. Never throws for any input string.
 */
export function parseCalendarWriteRequest(text: string, options: CalendarWriteGrammarOptions): ConnectorWriteDraft {
  try {
    const message = normalize(text);
    if (!HANGUL.test(message)) {
      return { kind: 'usage', topic: DELETE_VERB.test(message) || UPDATE_VERB.test(message) ? 'calendar-change' : 'calendar-create' };
    }
    if (DELETE_VERB.test(message)) return parseDelete(message, options);
    if (UPDATE_VERB.test(message) && !/(?:잡아|넣어|만들어|(?:추가|등록|예약)\s*해)/u.test(message)) {
      return parseUpdate(message, options);
    }
    return parseCreate(message, options);
  } catch {
    return { kind: 'usage', topic: 'calendar-create' };
  }
}
