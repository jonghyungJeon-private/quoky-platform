import type { IsoTimestamp } from '../../domain';
import { calendarWindowForDays } from '../../ports/calendar-window';
import { detectReplyLanguage } from '../chat-policy/chat-response-policy';
import { detectExternalActionRequest, isPersonalScheduleQuestion } from '../intent-classifier';
import {
  addLocalDays,
  compareLocalDates,
  isValidLocalDate,
  localDateOf,
  weekdayOf,
  type LocalDate,
} from '../reminders/zoned-time';

/**
 * Calendar schedule questions (ADR-0110 D3, CAL-2) — the pure grammar of the `pre-classify` calendar handler.
 *
 * A message is claimed only when it is one of:
 *  - a **schedule question** about the owner's own calendar or availability: the ADR-0110 QUAL-7 switch
 *    (`isPersonalScheduleQuestion`, the schedule subset of the QA-V2-005 personal-data route — "내일 일정 뭐야?",
 *    "다음 회의 언제야?", "나 내일 바빠?", "What's my next meeting?"), or a whole-message schedule request such as
 *    "오늘 일정", "이번 주 일정", "캘린더 보여줘", "today's schedule";
 *  - a **calendar write request** (create, move or delete an event): the fixed read-only refusal (ADR-0110 D6; the
 *    amendment's approved writes ship with CWR-2 in wave 5).
 *
 * How-to questions ("캘린더 어떻게 써?") are left to the help-intent handler. Reminder phrases are excluded by the handler
 * BEFORE this grammar runs (any message the reminder grammar recognizes stays a reminder: "내일 9시에 회의 알려줘").
 * Deterministic, no LLM, no clock: `placeCalendarSpan` takes `now` as an input.
 */

export type CalendarLanguage = 'ko' | 'en';

/** The period a schedule question asks about, before it is placed on the calendar. */
export type CalendarSpan =
  /** A day relative to today (`0` today, `1` tomorrow, `-1` yesterday, …). */
  | { readonly kind: 'day'; readonly offset: number }
  /** A weekday: `nearest` = today or its next occurrence; `this`/`next` = that day in this/next Monday-based week. */
  | { readonly kind: 'weekday'; readonly weekday: number; readonly week: 'nearest' | 'this' | 'next' }
  /** A month/day without a year (the occurrence nearest to today). */
  | { readonly kind: 'date'; readonly month: number; readonly day: number }
  /** A Monday-based week. */
  | { readonly kind: 'week'; readonly which: 'this' | 'next' }
  /** Saturday and Sunday of this or next Monday-based week. */
  | { readonly kind: 'weekend'; readonly which: 'this' | 'next' }
  /** The next upcoming event ("다음 회의 언제야?"). */
  | { readonly kind: 'next' };

export type CalendarQuestion =
  | { readonly kind: 'events'; readonly span: CalendarSpan; readonly language: CalendarLanguage }
  | { readonly kind: 'write-refused'; readonly language: CalendarLanguage };

/** Longer messages are never schedule questions (a pasted text that mentions "일정" is not a question). */
export const CALENDAR_QUESTION_MAX_CHARS = 200;
/** How far ahead "next event" looks (well inside the port's 31-day window). */
export const CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS = 14;

const DAY = String.raw`[월화수목금토일]요일`;
const SPAN_KO = String.raw`(?:오늘|금일|내일|낼|모레|글피|어제|(?:이번|다음)\s*주말|(?:이번\s*주|금주|다음\s*주|담주|차주)(?:\s*(?:${DAY}|주말))?|주말|${DAY}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*/\s*\d{1,2})(?:\s*(?:오전|오후|아침|저녁|밤|낮))?`;
const ALWAYS_NOUN_KO = String.raw`(?:일정|스케줄(?!러)|캘린더|달력)`;
const SPAN_NOUN_KO = String.raw`(?:일정|스케줄(?!러)|캘린더|달력|약속|미팅|회의(?!록|실))`;
const BARE_TAIL_KO = String.raw`(?:\s*(?:은|는|좀|목록|리스트))?(?:\s*(?:보여\s*줘|보여\s*주세요|보여\s*줄래|알려\s*줘|알려\s*주세요|알려\s*줄래|확인해\s*줘|확인해\s*주세요|뭐야|뭐예요|뭐에요|뭐지|어때|어때요))?\s*[?？.!~]*$`;
const POSSESSIVE_KO = String.raw`(?:(?:내|제|나의|저의|우리)\s+)?`;
/** "오늘 일정", "이번 주 일정 보여줘", "내 일정", "캘린더", "10월 7일 일정은?", "금요일 회의 알려줘". */
const BARE_KO = new RegExp(
  String.raw`^${POSSESSIVE_KO}(?:${SPAN_KO}\s*(?:의\s*)?${SPAN_NOUN_KO}|${ALWAYS_NOUN_KO}(?:\s+${SPAN_KO})?)${BARE_TAIL_KO}`,
  'u',
);
const SPAN_EN = String.raw`(?:today|tomorrow|tonight|this\s+week(?:end)?|next\s+week|the\s+week)`;
/** "today's schedule", "my calendar", "show my agenda for tomorrow", "calendar this week". */
const BARE_EN = new RegExp(
  String.raw`^(?:(?:please\s+)?(?:show|list|check)\s+(?:me\s+)?)?(?:my\s+)?(?:${SPAN_EN}(?:'s|’s)?\s+)?(?:calendar|schedule|agenda)(?:\s+(?:for\s+)?${SPAN_EN})?(?:\s+please)?\s*[?.!]*$`,
  'iu',
);

/** How-to / setup questions about the calendar feature itself (the help-intent handler answers those). */
const HOW_TO =
  /어떻게\s*(?:써|쓰|사용|해|하|연결|설정|봐|보)|(?:쓰는|사용하는|연결하는|설정하는|보는)\s*(?:법|방법)|방법|\bhow\s+(?:do|to|can|should|would)\b|\b(?:set\s*up|connect|configure)\b/iu;

/** A calendar noun that names the owner's calendar (not a cron or code "schedule"). */
const WRITE_NOUN_KO = String.raw`(?:일정|스케줄(?!러)|캘린더|달력)`;
const WRITE_VERB_KO = String.raw`(?:옮겨|바꿔|미뤄|당겨|지워|빼|(?:변경|수정|삭제|취소|이동|조정)\s*해)\s*(?:줘|주세요|줄래|주실래요|줄\s*수\s*있)`;
/** Move/delete requests for an event; creates are the shared ADR-0098 calendar external action. */
const WRITE_KO = new RegExp(String.raw`${WRITE_NOUN_KO}[^.!?？\n]{0,20}?${WRITE_VERB_KO}`, 'u');
const WRITE_EN =
  /(?:^|[.!?]\s+)(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)*(?:move|reschedule|cancel|delete|remove|push\s+back|postpone)\b[^.!?\n]{0,40}\b(?:calendar|meetings?|appointments?|events?)\b/iu;
/** A cron / code / job "schedule" is not the owner's calendar (mirrors the ADR-0098 calendar external-action blocker). */
const CODE_SCHEDULE =
  /^(?![\s\S]*(?:캘린더|달력|calendar))[\s\S]*(?:cron|크론|스케줄러|scheduler|코드|code|함수|\bjobs?\b|배치|작업|태스크|\btasks?\b|워크플로|workflow|크롤)/iu;

function normalize(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function languageOf(text: string): CalendarLanguage {
  return detectReplyLanguage(text) === 'en' ? 'en' : 'ko';
}

/** Quoted text (a title, a phrase to translate) is content, not part of the request: it is blanked before matching. */
const QUOTED_SEGMENT = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu;
/** Requests ABOUT a phrase (translate it, explain it) are ordinary chat, never a calendar write. */
const ABOUT_A_PHRASE = /번역|translate|뜻이|무슨 뜻|의미|meaning|예문|example sentence/iu;
/** A negated, reported or past-tense clause is not a request ("…라고 요청하지 않았어", "I didn't ask to cancel"). */
const NOT_A_REQUEST =
  /라고|라는|다고|하지\s*않|않았|않을|말고|하지\s*마|안\s*해|안\s*했|취소했|삭제했|옮겼|추가했|\b(?:don'?t|didn'?t|do not|did not|never|wasn'?t|weren'?t|haven'?t)\b/iu;
/** Clause boundaries: sentence ends, commas, and coordinating connectives (exclusions are clause-scoped, Codex P2). */
const CLAUSE_SPLIT = /[.!?。！？]\s+|[,;]\s*|\s+(?:and|but|then)\s+|\s*(?:그리고|하지만|근데|그런데)\s+/iu;

function clauseIsWriteRequest(clause: string): boolean {
  if (clause.trim().length === 0 || NOT_A_REQUEST.test(clause)) return false;
  if (detectExternalActionRequest(clause)?.kind === 'calendar') return true;
  return WRITE_KO.test(clause) || WRITE_EN.test(clause);
}

/** Whether the message asks Quoky to create, move or delete a calendar event (refused while calendar writes are off). */
export function isCalendarWriteRequest(text: string): boolean {
  const message = normalize(text);
  if (CODE_SCHEDULE.test(message)) return false;
  // Codex P2 (wave 4): a request ABOUT a phrase is ordinary chat ("'금요일 일정 삭제해줘'를 영어로 번역해줘"); quoted
  // content is blanked (a quoted event title keeps the request a request); negated / reported / past-tense clauses
  // are skipped one clause at a time ("…라고 요청하지 않았어"), so another clause can still be the request.
  if (ABOUT_A_PHRASE.test(message)) return false;
  const unquoted = message.replace(QUOTED_SEGMENT, ' ');
  return unquoted.split(CLAUSE_SPLIT).some(clauseIsWriteRequest);
}

/**
 * Parse one owner message. Returns `null` for anything that is not a calendar question or calendar write request (the
 * message falls through unchanged). Never throws for any input string.
 */
export function parseCalendarQuestion(text: string): CalendarQuestion | null {
  const message = normalize(text);
  if (message.length === 0 || Array.from(message).length > CALENDAR_QUESTION_MAX_CHARS) return null;
  if (HOW_TO.test(message)) return null;
  const language = languageOf(message);
  if (isCalendarWriteRequest(message)) return { kind: 'write-refused', language };
  if (!(BARE_KO.test(message) || BARE_EN.test(message) || isPersonalScheduleQuestion(message))) return null;
  return { kind: 'events', span: extractSpan(message), language };
}

const KO_WEEKDAY: Readonly<Record<string, number>> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const EN_WEEKDAY: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
const EN_MONTH: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** The period the (already claimed) question asks about; today when it names none. Exported for tests. */
export function extractSpan(text: string): CalendarSpan {
  const message = normalize(text).toLowerCase();

  // Korean: week-qualified forms first, so "다음 주" is never read as "다음 (회의)" and "이번 주말" never as "이번 주".
  if (/다음\s*주말/u.test(message)) return { kind: 'weekend', which: 'next' };
  if (/이번\s*주말/u.test(message)) return { kind: 'weekend', which: 'this' };
  const nextWeek = /(?:다음\s*주|담주|차주)\s*(?:([월화수목금토일])요일|(주말))?/u.exec(message);
  if (nextWeek) {
    if (nextWeek[1] !== undefined) return { kind: 'weekday', weekday: KO_WEEKDAY[nextWeek[1]] as number, week: 'next' };
    return nextWeek[2] !== undefined ? { kind: 'weekend', which: 'next' } : { kind: 'week', which: 'next' };
  }
  const thisWeek = /(?:이번\s*주|금주)\s*(?:([월화수목금토일])요일|(주말))?/u.exec(message);
  if (thisWeek) {
    if (thisWeek[1] !== undefined) return { kind: 'weekday', weekday: KO_WEEKDAY[thisWeek[1]] as number, week: 'this' };
    return thisWeek[2] !== undefined ? { kind: 'weekend', which: 'this' } : { kind: 'week', which: 'this' };
  }
  if (/주말/u.test(message)) return { kind: 'weekend', which: 'this' };
  if (/글피/u.test(message)) return { kind: 'day', offset: 3 };
  if (/모레/u.test(message)) return { kind: 'day', offset: 2 };
  if (/내일|(?<![가-힣])낼(?![가-힣])/u.test(message)) return { kind: 'day', offset: 1 };
  if (/어제/u.test(message)) return { kind: 'day', offset: -1 };
  if (/오늘|금일/u.test(message)) return { kind: 'day', offset: 0 };
  const koDate = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/u.exec(message) ?? /(?<![\d.])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/u.exec(message);
  if (koDate) return { kind: 'date', month: Number(koDate[1]), day: Number(koDate[2]) };
  const koWeekday = /([월화수목금토일])요일/u.exec(message);
  if (koWeekday) return { kind: 'weekday', weekday: KO_WEEKDAY[koWeekday[1] as string] as number, week: 'nearest' };

  // English.
  const enNextWeekday = /\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u.exec(message);
  if (enNextWeekday) return { kind: 'weekday', weekday: EN_WEEKDAY[enNextWeekday[1] as string] as number, week: 'next' };
  if (/\bnext\s+week(?:end)?\b/u.test(message)) {
    return /\bnext\s+weekend\b/u.test(message) ? { kind: 'weekend', which: 'next' } : { kind: 'week', which: 'next' };
  }
  if (/\b(?:this\s+)?weekend\b/u.test(message)) return { kind: 'weekend', which: 'this' };
  if (/\b(?:this|the)\s+week\b/u.test(message)) return { kind: 'week', which: 'this' };
  if (/\bday\s+after\s+tomorrow\b/u.test(message)) return { kind: 'day', offset: 2 };
  if (/\b(?:tomorrow|tmrw)\b/u.test(message)) return { kind: 'day', offset: 1 };
  if (/\byesterday\b/u.test(message)) return { kind: 'day', offset: -1 };
  if (/\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/u.test(message)) return { kind: 'day', offset: 0 };
  const enMonthDate =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/u.exec(message);
  if (enMonthDate) return { kind: 'date', month: EN_MONTH[enMonthDate[1] as string] as number, day: Number(enMonthDate[2]) };
  const enWeekday = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/u.exec(message);
  if (enWeekday) return { kind: 'weekday', weekday: EN_WEEKDAY[enWeekday[1] as string] as number, week: 'nearest' };

  // "다음 회의 언제야?", "다음 약속은?", "회의 언제야?", "What's my next meeting?", "when is my upcoming appointment?"
  if (
    /(?<![가-힣])다음\s*(?:회의|미팅|약속|일정|스케줄|이벤트)|언제/u.test(message) ||
    /\b(?:next|upcoming)\s+(?:meeting|appointment|event|call|class|flight)s?\b|\bwhen\b/u.test(message)
  ) {
    return { kind: 'next' };
  }
  return { kind: 'day', offset: 0 };
}

/** A span placed on the owner's calendar: the `[from, to)` instants to read and the local dates they cover. */
export interface CalendarWindow {
  readonly span: CalendarSpan;
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  /** The first local date of the window (today for `next`). */
  readonly startDate: LocalDate;
  /** Number of local dates covered (1 for a day, 7 for a week, 2 for a weekend, the lookahead for `next`). */
  readonly days: number;
  /** The relative-day offset for a `day` span (labels "오늘"/"내일"); undefined otherwise. */
  readonly dayOffset?: number;
}

function mondayOf(date: LocalDate): LocalDate {
  return addLocalDays(date, -((weekdayOf(date) + 6) % 7));
}

/** The occurrence of month/day nearest to `today` (last, this or next year); `undefined` if it never exists. */
function nearestDate(month: number, day: number, today: LocalDate): LocalDate | undefined {
  const candidates = [today.year - 1, today.year, today.year + 1]
    .map((year) => ({ year, month, day }))
    .filter((date) => isValidLocalDate(date));
  let best: LocalDate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || Math.abs(compareLocalDates(candidate, today)) < Math.abs(compareLocalDates(best, today))) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Place a span on the owner's calendar in `timeZone` (`QUOKY_TIMEZONE`) with CAL-1's `calendarWindowForDays`: local
 * midnight to local midnight, DST days included (a 23- or 25-hour day is still one day), weeks Monday to Monday.
 * Returns `undefined` for a date that does not exist ("2월 30일").
 */
export function placeCalendarSpan(
  span: CalendarSpan,
  now: IsoTimestamp,
  timeZone: string,
): CalendarWindow | undefined {
  const today = localDateOf(now, timeZone);
  const window = (startDate: LocalDate, days: number, extra: { dayOffset?: number } = {}): CalendarWindow => ({
    span,
    ...calendarWindowForDays(startDate, days, timeZone),
    startDate,
    days,
    ...extra,
  });
  switch (span.kind) {
    case 'day':
      return window(addLocalDays(today, span.offset), 1, { dayOffset: span.offset });
    case 'weekday': {
      if (span.week === 'nearest') return window(addLocalDays(today, (span.weekday - weekdayOf(today) + 7) % 7), 1);
      const monday = addLocalDays(mondayOf(today), span.week === 'next' ? 7 : 0);
      return window(addLocalDays(monday, (span.weekday + 6) % 7), 1);
    }
    case 'date': {
      const date = nearestDate(span.month, span.day, today);
      return date === undefined ? undefined : window(date, 1);
    }
    case 'week':
      return window(addLocalDays(mondayOf(today), span.which === 'next' ? 7 : 0), 7);
    case 'weekend':
      return window(addLocalDays(mondayOf(today), span.which === 'next' ? 12 : 5), 2);
    case 'next': {
      // From now (not midnight) to the end of the lookahead: only events that have not ended yet are read.
      const { to } = calendarWindowForDays(today, CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS, timeZone);
      return { span, from: new Date(Date.parse(now)).toISOString(), to, startDate: today, days: CALENDAR_NEXT_EVENT_LOOKAHEAD_DAYS };
    }
  }
}
