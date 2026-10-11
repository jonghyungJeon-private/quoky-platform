import { REMINDER_LIMITS } from '../../domain';

/**
 * Event-relative ("pre-meeting") reminder grammar (ADR-0117 D5, BRF-2). Pure and deterministic: no clock, no IO, no
 * model. It recognizes one whole-message request to be reminded a number of minutes before ONE calendar event, and
 * names that event by what the owner said — the next one, a day, a start time and / or a title. The event itself is
 * resolved later against the calendar (`event-reminder-resolver.ts`).
 *
 * Korean: `[내] [다음|첫] [오늘|내일|모레] [오전|오후] [H시[ M분|반]] [<제목>] 회의|미팅|일정|약속 [시작] <N분|N시간[ M분]|한 시간|30분…>
 * 전(에) <verb>`, where the verb is a closed imperative (`알려줘`, `알려 주세요`, `리마인드 해줘`, `알림 줘`, …).
 * English: `[please] remind me <N minutes|an hour|…> before [my|the] [next] [<time>] [<title>] meeting|call|event|
 * appointment [today|tomorrow]`.
 *
 * - The offset is bounded (1-120 minutes); outside it is `CLARIFY(EVENT_OFFSET_OUT_OF_RANGE)`.
 * - `회의 전에 알려줘` / `remind me before my next meeting` (no offset) is `CLARIFY(EVENT_OFFSET_MISSING)`.
 * - Anything else — a body after `전에` (`회의 10분 전에 자료 준비 알려줘`), a negation, a question — is not matched here
 *   and goes on to the ADR-0101 grammar unchanged.
 *
 * Nothing is ever created for every event: one command, one event (ADR-0101 D1, decision 22).
 */

export type EventReminderMeridiem = 'am' | 'pm';

/** The event the owner named. Every part is optional; with none, it is the next timed event. */
export interface EventReminderTarget {
  /** Days from today in the owner's zone (`오늘` 0, `내일` 1, `모레` 2). */
  readonly dayOffset?: number;
  /** A weekday (0 = Sunday … 6 = Saturday): its nearest occurrence within the lookahead (`금요일 회의`). */
  readonly weekday?: number;
  /**
   * A start time of day. `clock24`: written `HH:MM` (`03:00`, `15:00`, `9:30`), a 24-hour time matched exactly. Otherwise
   * `meridiem` absent with `hour` 1-12 (`3시`) matches either half of the day.
   */
  readonly time?: {
    readonly hour: number;
    readonly minute: number;
    readonly meridiem?: EventReminderMeridiem;
    readonly clock24?: true;
  };
  /** Words of the title (matched case- and space-insensitively against the event title). */
  readonly title?: string;
}

export type EventReminderParse =
  | { readonly kind: 'none' }
  | { readonly kind: 'create'; readonly offsetMinutes: number; readonly target: EventReminderTarget }
  | { readonly kind: 'clarify'; readonly reason: 'EVENT_OFFSET_OUT_OF_RANGE' | 'EVENT_OFFSET_MISSING' };

/** A title the owner names is at most this long (a longer "title" is a sentence, not a name). */
export const EVENT_REMINDER_TITLE_MAX_CHARS = 60;

const NONE: EventReminderParse = { kind: 'none' };

const KO_NOUN = String.raw`(?:회의|미팅|일정|약속)`;
const KO_VERB = String.raw`(?:알려\s?(?:줘요|줘|주세요|줄래요|줄래|주십시오|주시겠어요|주실래요)|리마인드\s?(?:해\s?줘요|해\s?줘|해\s?주세요|부탁해요|부탁해|부탁드려요)|(?:알림|알람)\s?(?:줘요|줘|주세요|보내\s?줘요|보내\s?줘|보내\s?주세요|설정\s?해\s?줘|설정\s?해\s?주세요|맞춰\s?줘))`;
const KO_NATIVE_HOURS = String.raw`(?:한|두)`;
const KO_OFFSET = String.raw`(?:(\d{1,3})\s?분|(\d{1,2}|${KO_NATIVE_HOURS})\s?시간(?:\s?(반)|\s?(\d{1,2})\s?분)?|(반)\s?시간)`;
const KO_END = String.raw`\s*[.!~]*$`;

/** `<target> <noun> [시작] <offset> 전(에) <verb>`, whole message. */
const KO_PATTERN = new RegExp(String.raw`^(.*?)\s?${KO_NOUN}\s?(?:시작\s?)?(?:하기\s?)?${KO_OFFSET}\s?전(?:에)?\s?${KO_VERB}${KO_END}`, 'u');
/** No offset: `회의 전에 알려줘`, `다음 회의 시작 전에 알려줘`. */
const KO_NO_OFFSET = new RegExp(String.raw`^(.*?)\s?${KO_NOUN}\s?(?:시작\s?)?(?:하기\s?)?전에\s?${KO_VERB}${KO_END}`, 'u');

const EN_NOUN = String.raw`(?:meeting|call|event|appointment)`;
const EN_OFFSET = String.raw`(?:(\d{1,3})\s?(?:minutes?|mins?|m)|(an?|one|two|\d)\s?(?:hours?|hrs?|h)|(half)\s+an\s+hour)`;
const EN_PATTERN = new RegExp(
  String.raw`^(?:please\s+)?remind\s+me\s+${EN_OFFSET}\s+before\s+(.*?)\b${EN_NOUN}(?:\s+(today|tomorrow))?(?:\s+please)?\s*[.!]*$`,
  'iu',
);
const EN_NO_OFFSET = new RegExp(
  String.raw`^(?:please\s+)?remind\s+me\s+before\s+(?:my|the)\s+(?:next\s+)?(?:.{0,40}?\s)?${EN_NOUN}(?:\s+(?:today|tomorrow))?\s*[.!]*$`,
  'iu',
);

function normalize(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function koHours(value: string): number {
  if (value === '한') return 1;
  if (value === '두') return 2;
  return Number(value);
}

function enHours(value: string): number {
  const lower = value.toLowerCase();
  if (lower === 'a' || lower === 'an' || lower === 'one') return 1;
  if (lower === 'two') return 2;
  return Number(lower);
}

function offsetResult(minutes: number, target: EventReminderTarget | null): EventReminderParse {
  if (target === null) return NONE;
  if (
    !Number.isInteger(minutes) ||
    minutes < REMINDER_LIMITS.minEventOffsetMinutes ||
    minutes > REMINDER_LIMITS.maxEventOffsetMinutes
  ) {
    return { kind: 'clarify', reason: 'EVENT_OFFSET_OUT_OF_RANGE' };
  }
  return { kind: 'create', offsetMinutes: minutes, target };
}

const KO_DAY: Readonly<Record<string, number>> = { 오늘: 0, 내일: 1, 낼: 1, 모레: 2 };
const KO_DAY_RE = /(?:^|\s)(오늘|내일|낼|모레)(?=\s|$)/u;
const KO_WEEKDAY: Readonly<Record<string, number>> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const KO_WEEKDAY_RE = /(?:^|\s)(?:이번\s?주\s?)?([월화수목금토일])요일(?:\s?(?:의|에))?(?=\s|$)/u;
/** A week or a later date (`다음 주`, `10월 20일`) is not resolved here: the request goes on to the ADR-0101 grammar. */
const KO_UNSUPPORTED_SPAN = /(?:^|\s)(?:다음|담|차)\s?주(?!간)|\d{1,2}\s?월\s?\d{1,2}\s?일|\d{1,2}\s?\/\s?\d{1,2}|주말/u;
const KO_TIME_RE = /(?:^|\s)(?:(오전|오후|아침|저녁|밤|낮)\s?)?(\d{1,2})\s?시(?:\s?(\d{1,2})\s?분|\s?(반))?(?=\s|$|의|에)|(?:^|\s)(\d{1,2}):(\d{2})(?=\s|$|의|에)/u;
/** Words that only say "the next one" or "my": they never become a title. */
const KO_FILLER = /^(?:(?:내|제|나의|저의|우리|다음|그\s?다음|첫|첫\s?번째|이번|지금|곧|바로|예정된|잡힌|있는)\s)+/u;
const KO_TRAILING_PARTICLE = /\s?(?:의|에|에서)$/u;

function koMeridiem(word: string | undefined): EventReminderMeridiem | undefined {
  if (word === undefined) return undefined;
  return word === '오전' || word === '아침' ? 'am' : 'pm';
}

/** `null` when the target text cannot name an event (a sentence, a question, an over-long title). */
function koTarget(raw: string): EventReminderTarget | null {
  let rest = ` ${raw.trim()} `;
  if (KO_UNSUPPORTED_SPAN.test(rest)) return null;
  let dayOffset: number | undefined;
  let weekday: number | undefined;
  const day = KO_DAY_RE.exec(rest);
  if (day !== null) {
    dayOffset = KO_DAY[day[1] as string];
    rest = rest.replace(day[0], ' ');
  } else {
    const named = KO_WEEKDAY_RE.exec(rest);
    if (named !== null) {
      weekday = KO_WEEKDAY[named[1] as string];
      rest = rest.replace(named[0], ' ');
    }
  }
  let time: EventReminderTarget['time'];
  const clock = KO_TIME_RE.exec(rest);
  if (clock !== null) {
    if (clock[2] !== undefined) {
      const hour = Number(clock[2]);
      const minute = clock[4] !== undefined ? 30 : clock[3] !== undefined ? Number(clock[3]) : 0;
      const meridiem = koMeridiem(clock[1]);
      if (hour > 23 || minute > 59 || (meridiem !== undefined && (hour < 1 || hour > 12))) return null;
      time = { hour, minute, ...(meridiem !== undefined ? { meridiem } : {}) };
    } else {
      const hour = Number(clock[5]);
      const minute = Number(clock[6]);
      if (hour > 23 || minute > 59) return null;
      // `HH:MM` is a 24-hour clock, matched exactly: `03:00` is 03:00, never 15:00.
      time = { hour, minute, clock24: true };
    }
    rest = rest.replace(clock[0], ' ');
  }
  return withTitle({ dayOffset, weekday, time }, `${rest.replace(/\s+/g, ' ').trim()} `.replace(KO_FILLER, '').trim().replace(KO_TRAILING_PARTICLE, ''));
}

function withTitle(
  parts: { dayOffset: number | undefined; weekday?: number | undefined; time: EventReminderTarget['time'] },
  rawTitle: string,
): EventReminderTarget | null {
  const title = rawTitle.trim();
  if (/[?？]/.test(title) || Array.from(title).length > EVENT_REMINDER_TITLE_MAX_CHARS) return null;
  return {
    ...(parts.dayOffset !== undefined ? { dayOffset: parts.dayOffset } : {}),
    ...(parts.weekday !== undefined ? { weekday: parts.weekday } : {}),
    ...(parts.time !== undefined ? { time: parts.time } : {}),
    ...(title.length > 0 ? { title } : {}),
  };
}

const EN_TIME_RE = /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)?(?=\s|$)/iu;
const EN_FILLER = /^(?:(?:my|the|our|next|upcoming|first)\s+)+/iu;

function enTarget(raw: string, dayWord: string | undefined): EventReminderTarget | null {
  let rest = ` ${raw.trim()} `;
  let time: EventReminderTarget['time'];
  const clock = EN_TIME_RE.exec(rest);
  if (clock !== null) {
    const hour = Number(clock[1]);
    const minute = clock[2] !== undefined ? Number(clock[2]) : 0;
    const marker = clock[3]?.toLowerCase().replace(/\./g, '');
    const meridiem: EventReminderMeridiem | undefined = marker === 'am' ? 'am' : marker === 'pm' ? 'pm' : undefined;
    // A bare number with neither minutes nor am/pm is not a clock ("my 2 meetings").
    if (clock[2] === undefined && meridiem === undefined) return null;
    if (hour > 23 || minute > 59 || (meridiem !== undefined && (hour < 1 || hour > 12))) return null;
    // `9:30` / `15:00` without am/pm is a 24-hour clock, matched exactly.
    time = { hour, minute, ...(meridiem !== undefined ? { meridiem } : clock[2] !== undefined ? { clock24: true as const } : {}) };
    rest = rest.replace(clock[0], ' ');
  }
  const dayOffset = dayWord === undefined ? undefined : dayWord.toLowerCase() === 'today' ? 0 : 1;
  const title = `${rest.replace(/\s+/g, ' ').trim()} `.replace(EN_FILLER, '').trim();
  return withTitle({ dayOffset, time }, title);
}

/** Parse one owner message (already free of an anchored to-do prefix). Never throws. */
export function parseEventReminder(text: string): EventReminderParse {
  const message = normalize(text);
  if (message.length === 0 || Array.from(message).length > 200) return NONE;

  const ko = KO_PATTERN.exec(message);
  if (ko !== null) {
    const [, target = '', minutes, hours, half, hourMinutes, halfHour] = ko;
    const total =
      minutes !== undefined
        ? Number(minutes)
        : halfHour !== undefined
          ? 30
          : koHours(hours ?? '0') * 60 + (half !== undefined ? 30 : Number(hourMinutes ?? '0'));
    return offsetResult(total, koTarget(target));
  }
  const koMissing = KO_NO_OFFSET.exec(message);
  if (koMissing !== null && koTarget(koMissing[1] ?? '') !== null) return { kind: 'clarify', reason: 'EVENT_OFFSET_MISSING' };

  const en = EN_PATTERN.exec(message);
  if (en !== null) {
    const [, minutes, hours, half, target = '', dayWord] = en;
    const total = minutes !== undefined ? Number(minutes) : half !== undefined ? 30 : enHours(hours ?? '0') * 60;
    return offsetResult(total, enTarget(target, dayWord));
  }
  if (EN_NO_OFFSET.test(message)) return { kind: 'clarify', reason: 'EVENT_OFFSET_MISSING' };
  return NONE;
}
