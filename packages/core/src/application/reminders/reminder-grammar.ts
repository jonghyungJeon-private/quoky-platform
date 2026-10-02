import {
  REMINDER_LIMITS,
  reminderBodyLength,
  type IsoTimestamp,
  type ReminderBodyKind,
  type ReminderLocalTime,
  type ReminderSchedule,
  type ReminderWeekday,
} from '../../domain';
import { isNegated } from '../intent-negation';
import { nextOccurrenceAfter } from './reminder-schedule';
import {
  REMINDER_DEFAULT_TIME_ZONE,
  addLocalDays,
  compareLocalDates,
  isValidLocalDate,
  toZonedDateTime,
  zonedToUtc,
  type LocalDate,
} from './zoned-time';

/**
 * Deterministic KO/EN reminder grammar (ADR-0101 D2). Pure: `now` and the zone are inputs; no clock, id, IO or
 * model call. Returns `NOT_REMINDER | CREATE | LIST | CANCEL | CLARIFY(reason)`.
 *
 * - CREATE needs a reminder verb (`알려줘`, `리마인드 해줘`, `알림 줘`, `remind me`, …) that is not negated, plus a time
 *   expression bound to it: Korean by `에` / `뒤에` / `후에`, English by `at` / `in` / `on` / `tomorrow` / `every`.
 *   The generic `알려줘` is also an information request: with a direct question as the body (`9시에 뭐 있어? 알려줘`,
 *   `내일 3시에 회의 있나 알려줘`), an embedded yes/no question (`내일 3시에 예약 가능한지 알려줘`, `회의인지`,
 *   `참석 여부`) or the time bound to an adnominal clause (`9시에 오픈하는 식당 알려줘`, `11시에 문 닫는 카페
 *   알려줘`) it is `NOT_REMINDER`; the explicit verbs (`리마인드 해줘`, `알림 줘`) stay reminders.
 *   A Korean verb is a closed imperative form ending the word: inflected, past, permissive or noun uses
 *   (`알려줘서`, `알려줘도 돼`, `알려주라고 했는데`, `리마인드 메일`, `리마인드됐어`) are not requests, nor are
 *   `안 알려줘`, `필요 없어`, `no need to remind me`, `you forgot to remind me`.
 * - Not the owner's reminder: a message naming another addressee (`김대리한테`, `팀원들에게`), an embedded question
 *   (`9시에 뭐 있는지 알려줘`, `remind me what time …`), or a deadline (`remind me by 5pm` → CLARIFY).
 * - English: a time inside a relative or content clause of the body (`remind me to book the restaurant that opens at
 *   9am`, `… when I get home at 6`, `remind me that the store opens at 9am`) describes the body, never the reminder; it
 *   stays in the body and, with no other time bound to `remind me`, is `CLARIFY(MISSING_TIME)`.
 * - A part of the day, day or recurrence bound on its own (`오전에 9시에`, `평일에 9시에`) joins the time directly
 *   after it; anywhere else, or left in the body next to a bare 12-hour clock (`9시에 저녁 약속`,
 *   `at 7 to plan the evening`), it is `CLARIFY(AMBIGUOUS_TIME)` — the marker is never dropped or guessed.
 * - Meridiem: an explicit marker (`오전`/`오후`/`아침`/`저녁`/`밤`/`am`/`pm`, …) or a 24-hour time wins; with a date
 *   (day word, weekday, date or recurrence) 1–6 → PM, 7–11 → AM, 12 → noon; a bare time → nearest future.
 * - Clarify, never guess: past, nonexistent, more than 366 days or less than 1 minute ahead, sub-daily or other
 *   unsupported recurrence, empty or over-200-character body, ambiguous combinations, and a day reference the
 *   grammar does not resolve (`15일`, `다음 주` without a weekday, `주말`, `다음 달`, `on the 15th`, `next week`)
 *   next to a bare time — it is never folded into the body while the time is read as today's.
 * - A reminder request with a day but no clock is `CLARIFY(MISSING_TIME)`, not chat: `remind me tomorrow to …`,
 *   `내일 오전에 회의 알려줘`, and any day or part-of-day word with an explicit verb (`내일 회의 리마인드 해줘`).
 * - Every message that starts with an anchored to-do prefix of the closed ADR-0100 D1 list is `NOT_REMINDER`.
 * - LIST and CANCEL match the whole message only.
 *
 * Fixed interpretations (documented so the confirmation, which echoes the absolute date, is never a surprise):
 * weeks start on Monday (`다음 주 월요일` / `next Monday` = Monday of next week); a bare weekday is its nearest
 * future occurrence; a month/day without a year is this year, or next year once that date has passed; `자정` /
 * `midnight` / `밤 12시` with a day means the end of that day (24:00); `오전 12시` is 00:00 and `오후 12시` / `정오`
 * is 12:00.
 */

export type ReminderClarifyReason =
  | 'PAST_TIME'
  | 'INVALID_DATE'
  | 'INVALID_TIME'
  | 'NONEXISTENT_TIME'
  | 'TOO_FAR'
  | 'TOO_SOON'
  | 'UNSUPPORTED_RECURRENCE'
  | 'MISSING_TIME'
  | 'AMBIGUOUS_TIME'
  | 'EMPTY_BODY'
  | 'BODY_TOO_LONG'
  | 'INVALID_REMINDER_NUMBER'
  | 'BULK_CANCEL_UNSUPPORTED';

export type ReminderCommand =
  | { readonly kind: 'NOT_REMINDER' }
  | {
      readonly kind: 'CREATE';
      readonly body: string;
      readonly bodyKind: ReminderBodyKind;
      readonly schedule: ReminderSchedule;
      readonly firstFireAt: IsoTimestamp;
      readonly timeZone: string;
    }
  | { readonly kind: 'LIST' }
  | { readonly kind: 'CANCEL'; readonly displayNo: number }
  | { readonly kind: 'CLARIFY'; readonly reason: ReminderClarifyReason };

export interface ReminderGrammarOptions {
  /** The current instant (from the shared clock); the grammar never reads a clock itself. */
  now: IsoTimestamp;
  /** The owner's IANA zone (`QUOKY_TIMEZONE`); defaults to `Asia/Seoul`. */
  timeZone?: string;
}

/**
 * Anchored to-do prefix heads, mirrored literally from the closed ADR-0100 D1 list (the WORK grammar owns them).
 * A message that starts with one of these heads, optional whitespace and `:`/`：` is never a reminder.
 */
export const ANCHORED_TODO_PREFIX_HEADS = [
  // add
  '할 일 추가',
  '할일 추가',
  '할 일 등록',
  '할일 등록',
  'todo add',
  'add todo',
  'to-do add',
  // complete
  '완료 처리',
  '할 일 완료',
  '할일 완료',
  'todo done',
  // cancel
  '할 일 취소',
  '할일 취소',
  'todo cancel',
  // link
  '할 일 연결',
  '할일 연결',
  'todo link',
] as const;

/** Bodies that make a reminder the local daily brief (ADR-0101 D2/D7), compared after normalization. */
export const REMINDER_BRIEF_BODIES = [
  '오늘 할 일',
  '오늘 할일',
  '할 일 목록',
  '할일 목록',
  '브리핑',
  'daily brief',
  "today's tasks",
] as const;

const NOT_REMINDER: ReminderCommand = { kind: 'NOT_REMINDER' };

function clarify(reason: ReminderClarifyReason): ReminderCommand {
  return { kind: 'CLARIFY', reason };
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ANCHORED_TODO_PREFIX = new RegExp(
  `^(?:${ANCHORED_TODO_PREFIX_HEADS.map(escapeRegExp).join('|')})\\s*[:：]`,
  'i',
);

/** Whether the (trimmed) message starts with an anchored to-do prefix of the closed ADR-0100 D1 list. */
export function startsWithAnchoredTodoPrefix(text: string): boolean {
  return ANCHORED_TODO_PREFIX.test(text.normalize('NFC').trim());
}

const BRIEF_BODY_SET = new Set<string>(REMINDER_BRIEF_BODIES.map((b) => b.toLowerCase()));

function bodyKindOf(body: string): ReminderBodyKind {
  return BRIEF_BODY_SET.has(body.replace(/[’]/g, "'").toLowerCase()) ? 'BRIEF' : 'TEXT';
}

// ---------------------------------------------------------------------------------------------------------------
// LIST / CANCEL (whole message)
// ---------------------------------------------------------------------------------------------------------------

const LIST_PATTERNS: readonly RegExp[] = [
  /^(?:내\s?)?(?:알림|리마인더)\s?(?:목록|리스트)(?:\s?(?:보여\s?줘|보여\s?주세요))?$/,
  /^내\s?알림$/,
  /^(?:list|show)\s+(?:my\s+)?reminders$/i,
  /^my\s+reminders$/i,
];

const CANCEL_PATTERNS: readonly RegExp[] = [
  /^(?:알림|리마인더)\s?#?(\d{1,6})\s?(?:번\s?)?취소(?:\s?해\s?줘요?|\s?해\s?주세요|\s?해)?$/,
  /^#(\d{1,6})\s?(?:알림|리마인더)\s?취소(?:\s?해\s?줘요?|\s?해\s?주세요)?$/,
  /^cancel\s+reminder\s*#?(\d{1,6})$/i,
];

const CANCEL_WITHOUT_NUMBER: readonly RegExp[] = [
  /^(?:알림|리마인더)\s?취소(?:\s?해\s?줘요?|\s?해\s?주세요)?$/,
  /^cancel\s+(?:a\s+|the\s+)?reminder$/i,
];

const BULK_CANCEL: readonly RegExp[] = [
  /^(?:(?:알림|리마인더)\s?(?:모두|전부|전체|다)|(?:모든|전체)\s?(?:알림|리마인더))\s?(?:다\s?)?취소/,
  /^cancel\s+(?:all|every)\s+(?:(?:my|the)\s+)?reminders?\b/i,
];

function matchListOrCancel(message: string): ReminderCommand | null {
  const whole = message.replace(/[\s.!?。]+$/u, '');
  if (LIST_PATTERNS.some((re) => re.test(whole))) return { kind: 'LIST' };
  for (const re of CANCEL_PATTERNS) {
    const m = re.exec(whole);
    if (m?.[1] !== undefined) {
      const displayNo = Number.parseInt(m[1], 10);
      return displayNo >= 1 ? { kind: 'CANCEL', displayNo } : clarify('INVALID_REMINDER_NUMBER');
    }
  }
  if (CANCEL_WITHOUT_NUMBER.some((re) => re.test(whole))) return clarify('INVALID_REMINDER_NUMBER');
  if (BULK_CANCEL.some((re) => re.test(whole))) return clarify('BULK_CANCEL_UNSUPPORTED');
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Time specification shared by the KO and EN parsers
// ---------------------------------------------------------------------------------------------------------------

/** AM-type (`오전`, `아침`, `새벽`, am), PM, DAYTIME (`낮`, `점심`), EVENING (`저녁`), NIGHT (`밤`, tonight). */
type Meridiem = 'AM' | 'PM' | 'DAYTIME' | 'EVENING' | 'NIGHT';

type WeekRef = 'NEAREST' | 'THIS' | 'NEXT' | 'AFTER_NEXT';

interface TimeSpec {
  relativeMs?: number;
  dayOffset?: number;
  weekday?: { day: ReminderWeekday; week: WeekRef };
  date?: { year?: number; month: number; day: number };
  recurrence?: { type: 'DAILY' } | { type: 'WEEKLY'; weekdays: ReminderWeekday[] };
  meridiem?: Meridiem;
  clock?: { hour: number; minute: number; zeroPadded: boolean };
  special?: 'NOON' | 'MIDNIGHT';
  /** A component appeared twice or two incompatible components were combined. */
  conflict?: boolean;
  /** An unparseable component value (e.g. `9시 75분`, a zero-length duration unit). */
  invalidTime?: boolean;
}

function hasTimeOfDay(spec: TimeSpec): boolean {
  return spec.clock !== undefined || spec.special !== undefined;
}

function hasDayInfo(spec: TimeSpec): boolean {
  return spec.dayOffset !== undefined || spec.weekday !== undefined || spec.date !== undefined;
}

function set<K extends keyof TimeSpec>(spec: TimeSpec, key: K, value: TimeSpec[K]): void {
  if (spec[key] !== undefined) spec.conflict = true;
  spec[key] = value;
}

/** Set exactly one day reference (offset, weekday or date); a second one is a conflict. */
function setDay<K extends 'dayOffset' | 'weekday' | 'date'>(spec: TimeSpec, key: K, value: TimeSpec[K]): void {
  if (hasDayInfo(spec)) spec.conflict = true;
  spec[key] = value;
}

const WEEK_STARTS_MONDAY_OFFSET = (weekday: ReminderWeekday): number => (weekday + 6) % 7;

// ---------------------------------------------------------------------------------------------------------------
// Resolution: TimeSpec → schedule + first fire instant, or a clarify reason
// ---------------------------------------------------------------------------------------------------------------

type ClockResolution =
  | { type: 'FIXED'; hour: number; minute: number }
  | { type: 'END_OF_DAY' }
  | { type: 'TWELVE_HOUR'; hour12: number; minute: number }
  | { type: 'CLARIFY'; reason: ReminderClarifyReason };

function resolveClock(spec: TimeSpec, dated: boolean): ClockResolution {
  if (spec.special === 'NOON') return { type: 'FIXED', hour: 12, minute: 0 };
  if (spec.special === 'MIDNIGHT') return { type: 'END_OF_DAY' };
  const clock = spec.clock;
  if (clock === undefined) return { type: 'CLARIFY', reason: 'MISSING_TIME' };
  const { hour: h, minute } = clock;
  if (minute < 0 || minute > 59 || h < 0 || h > 24) return { type: 'CLARIFY', reason: 'INVALID_TIME' };
  if (h === 24) return minute === 0 && spec.meridiem === undefined ? { type: 'END_OF_DAY' } : { type: 'CLARIFY', reason: 'INVALID_TIME' };
  const fixed = (hour: number): ClockResolution => ({ type: 'FIXED', hour, minute });
  const invalid: ClockResolution = { type: 'CLARIFY', reason: 'INVALID_TIME' };
  const ambiguous: ClockResolution = { type: 'CLARIFY', reason: 'AMBIGUOUS_TIME' };
  switch (spec.meridiem) {
    case 'AM':
      if (h > 12) return invalid;
      return fixed(h === 12 ? 0 : h);
    case 'PM':
      if (h === 0) return invalid;
      return fixed(h === 12 ? 12 : h > 12 ? h : h + 12);
    case 'DAYTIME':
      if (h === 0) return invalid;
      return fixed(h >= 12 ? h : h <= 6 ? h + 12 : h);
    case 'EVENING':
      if (h === 0 || h === 12) return ambiguous;
      return fixed(h > 12 ? h : h + 12);
    case 'NIGHT':
      if (h === 12 || h === 0) return minute === 0 ? { type: 'END_OF_DAY' } : ambiguous;
      if (h >= 1 && h <= 5) return ambiguous;
      if (h >= 13 && h <= 17) return invalid;
      return fixed(h > 12 ? h : h + 12);
    case undefined:
      if (h === 0 || h > 12 || clock.zeroPadded) return fixed(h);
      if (dated) return fixed(h === 12 ? 12 : h <= 6 ? h + 12 : h);
      return { type: 'TWELVE_HOUR', hour12: h, minute };
  }
}

const MS_PER_DAY = 86_400_000;
const HORIZON_MS = REMINDER_LIMITS.horizonDays * MS_PER_DAY;

interface ResolveContext {
  nowMs: number;
  timeZone: string;
}

type Resolved =
  | { ok: true; schedule: ReminderSchedule; firstFireAt: IsoTimestamp }
  | { ok: false; reason: ReminderClarifyReason };

function fail(reason: ReminderClarifyReason): Resolved {
  return { ok: false, reason };
}

function checkOnce(epochMs: number, ctx: ResolveContext): Resolved {
  if (epochMs <= ctx.nowMs) return fail('PAST_TIME');
  if (epochMs - ctx.nowMs < REMINDER_LIMITS.minLeadMs) return fail('TOO_SOON');
  if (epochMs - ctx.nowMs > HORIZON_MS) return fail('TOO_FAR');
  const at = new Date(epochMs).toISOString();
  return { ok: true, schedule: { type: 'ONCE', at }, firstFireAt: at };
}

type DatedClock = { type: 'FIXED'; hour: number; minute: number } | { type: 'END_OF_DAY' };

/** The instant of `date` at a FIXED or END_OF_DAY clock; `nonexistent` inside a DST gap (never guessed). */
function instantOn(date: LocalDate, clock: DatedClock, timeZone: string): { epochMs: number; nonexistent: boolean } {
  const local =
    clock.type === 'END_OF_DAY'
      ? { ...addLocalDays(date, 1), hour: 0, minute: 0 }
      : { ...date, hour: clock.hour, minute: clock.minute };
  const resolved = zonedToUtc(local, timeZone);
  return { epochMs: resolved.epochMs, nonexistent: resolved.resolution === 'NONEXISTENT' };
}

function resolveTargetDate(spec: TimeSpec, today: LocalDate, todayWeekday: ReminderWeekday): LocalDate | ReminderClarifyReason {
  if (spec.dayOffset !== undefined) return addLocalDays(today, spec.dayOffset);
  if (spec.weekday !== undefined) {
    const { day, week } = spec.weekday;
    if (week === 'NEAREST') return addLocalDays(today, (day - todayWeekday + 7) % 7);
    const monday = addLocalDays(today, -WEEK_STARTS_MONDAY_OFFSET(todayWeekday));
    const weeks = week === 'THIS' ? 0 : week === 'NEXT' ? 1 : 2;
    return addLocalDays(monday, weeks * 7 + WEEK_STARTS_MONDAY_OFFSET(day));
  }
  const date = spec.date;
  if (date === undefined) return 'MISSING_TIME';
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return 'INVALID_DATE';
  let year = date.year;
  if (year === undefined) {
    // No year: this year, or next year once that month/day has passed (year rollover).
    const beforeToday = date.month < today.month || (date.month === today.month && date.day < today.day);
    year = beforeToday ? today.year + 1 : today.year;
  }
  const candidate = { year, month: date.month, day: date.day };
  return isValidLocalDate(candidate) ? candidate : 'INVALID_DATE';
}

function resolveSpec(spec: TimeSpec, ctx: ResolveContext): Resolved {
  if (spec.conflict) return fail('AMBIGUOUS_TIME');
  if (spec.invalidTime) return fail('INVALID_TIME');

  if (spec.relativeMs !== undefined) {
    if (hasDayInfo(spec) || hasTimeOfDay(spec) || spec.recurrence !== undefined || spec.meridiem !== undefined) {
      return fail('AMBIGUOUS_TIME');
    }
    if (spec.relativeMs < REMINDER_LIMITS.minLeadMs) return fail('TOO_SOON');
    return checkOnce(ctx.nowMs + spec.relativeMs, ctx);
  }

  if (!hasTimeOfDay(spec)) return fail('MISSING_TIME');

  if (spec.recurrence !== undefined) {
    if (hasDayInfo(spec)) return fail('AMBIGUOUS_TIME');
    const clock = resolveClock(spec, true);
    if (clock.type === 'CLARIFY') return fail(clock.reason);
    let time: ReminderLocalTime;
    if (clock.type === 'END_OF_DAY') {
      if (spec.recurrence.type !== 'DAILY') return fail('AMBIGUOUS_TIME');
      time = { hour: 0, minute: 0 };
    } else if (clock.type === 'FIXED') {
      time = { hour: clock.hour, minute: clock.minute };
    } else {
      return fail('AMBIGUOUS_TIME'); // unreachable: a dated clock is never TWELVE_HOUR
    }
    const schedule: ReminderSchedule =
      spec.recurrence.type === 'DAILY'
        ? { type: 'DAILY', time }
        : { type: 'WEEKLY', time, weekdays: [...spec.recurrence.weekdays].sort((a, b) => a - b) };
    const after = new Date(ctx.nowMs + REMINDER_LIMITS.minLeadMs - 1).toISOString();
    const first = nextOccurrenceAfter(schedule, ctx.timeZone, after);
    if (first === null) return fail('INVALID_TIME');
    return { ok: true, schedule, firstFireAt: first };
  }

  const zonedNow = toZonedDateTime(ctx.nowMs, ctx.timeZone);
  const today: LocalDate = { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day };

  if (hasDayInfo(spec)) {
    const clock = resolveClock(spec, true);
    if (clock.type === 'CLARIFY') return fail(clock.reason);
    if (clock.type === 'TWELVE_HOUR') return fail('AMBIGUOUS_TIME'); // unreachable: dated
    const target = resolveTargetDate(spec, today, zonedNow.weekday);
    if (typeof target === 'string') return fail(target);
    if (compareLocalDates(target, today) < 0) return fail('PAST_TIME');
    let instant = instantOn(target, clock, ctx.timeZone);
    if (spec.weekday?.week === 'NEAREST' && instant.epochMs <= ctx.nowMs) {
      // A bare weekday names its nearest FUTURE occurrence: today's has passed, so the same weekday next week.
      instant = instantOn(addLocalDays(target, 7), clock, ctx.timeZone);
    }
    if (instant.nonexistent) return fail('NONEXISTENT_TIME');
    return checkOnce(instant.epochMs, ctx);
  }

  // A bare time of day (no date): its nearest future occurrence.
  const clock = resolveClock(spec, false);
  if (clock.type === 'CLARIFY') return fail(clock.reason);
  const tomorrow = addLocalDays(today, 1);
  const candidates: Array<{ epochMs: number; nonexistent: boolean }> = [];
  if (clock.type === 'TWELVE_HOUR') {
    const am = clock.hour12 % 12;
    const fixedAt = (date: LocalDate, hour: number) =>
      instantOn(date, { type: 'FIXED', hour, minute: clock.minute }, ctx.timeZone);
    candidates.push(fixedAt(today, am), fixedAt(today, am + 12), fixedAt(tomorrow, am));
  } else {
    candidates.push(instantOn(today, clock, ctx.timeZone), instantOn(tomorrow, clock, ctx.timeZone));
  }
  const nearest = candidates.filter((c) => c.epochMs > ctx.nowMs).sort((a, b) => a.epochMs - b.epochMs)[0];
  if (nearest === undefined) return fail('PAST_TIME');
  // The nearest future reading falls in a DST gap → never guess.
  if (nearest.nonexistent) return fail('NONEXISTENT_TIME');
  return checkOnce(nearest.epochMs, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Korean parser
// ---------------------------------------------------------------------------------------------------------------

const KO_WEEKDAYS: Readonly<Record<string, ReminderWeekday>> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

const KO_NATIVE_NUMBERS: Readonly<Record<string, number>> = {
  한: 1,
  두: 2,
  세: 3,
  네: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
  열: 10,
  열한: 11,
  열두: 12,
};
const KO_NATIVE = '(?:열한|열두|다섯|여섯|일곱|여덟|아홉|한|두|세|네|열)';

function koNumber(token: string): number {
  return KO_NATIVE_NUMBERS[token] ?? Number.parseInt(token, 10);
}

/**
 * Markdown emphasis/code/quote characters that wrap words in chat (`**내일**`, `'…'`, `“…”`, `> …`); they are word
 * boundaries for the Korean scanner and the stray-word guards, and are trimmed from a body's ends.
 */
const WRAP = "*_`'\"“”‘’>";

/** A Korean verb form must end the word: `알려줘서`, `알려줘도`, `알려주라고`, `알림 줘야` are not requests. */
const KO_VERB_END = '(?![가-힣])';

/**
 * Generic `알려줘` forms (group 1) and the explicit reminder verbs (group 2): an imperative `리마인드 해줘` /
 * `리마인드 부탁해`, a bare `리마인드` only when it opens the message, and `알림 줘` / `알림 설정해줘` / `알람 맞춰줘`.
 */
const KO_VERB = new RegExp(
  `(알려\\s?(?:줘요|줘라|줘|주세요|줄래요|줄래|주라|주십시오|주시겠어요|주실래요))${KO_VERB_END}` +
    `|((?:리마인드\\s?(?:해\\s?줘요|해\\s?줘|해\\s?주세요|해\\s?줄래요|해\\s?줄래|부탁해요|부탁해|부탁합니다|부탁드려요|부탁드립니다|부탁)` +
    `|(?:알림|알람)\\s?(?:줘요|줘|주세요|보내\\s?줘요|보내\\s?줘|보내\\s?주세요|설정\\s?해\\s?줘요|설정\\s?해\\s?줘|설정\\s?해\\s?주세요|맞춰\\s?줘요|맞춰\\s?줘))${KO_VERB_END}` +
    `|^리마인드(?=$|[\\s:：,.!?]))`,
  'g',
);

const KO_VERB_PRESENT = new RegExp(KO_VERB.source);

/**
 * Reminder-local negation and non-request framing in the verb's clause, on top of the shared `isNegated`
 * (which this slice does not widen): `안 알려줘`, `알려줄 필요 없어`, `no need to remind me`, `you forgot to remind
 * me`, `you were supposed to remind me`, `you didn't remind me`.
 */
/** `안` as its own word right before the verb (`30분 뒤에 안 알려줘`); `방안 알려줘` is not negated. */
const KO_NEGATION_BEFORE_VERB = /(?:^|\s)안\s?$/;
/** `… 알려줘 필요 없어` / `알림 줘 필요는 없어` after the verb. */
const KO_NEGATION_AFTER_VERB = /^\s?(?:은|는|도)?\s?필요\s?(?:는\s?|가\s?|도\s?)?없/;
const EN_LOCAL_NEGATION =
  /\b(?:no\s+need|need\s+not|needn['’]?t|not\s+necessary|unnecessary|no\s+longer|forgot|supposed\s+to|didn['’]?t|did\s+not|wasn['’]?t|weren['’]?t)\b/i;
const LOCAL_CLAUSE_SEPARATOR = /[.,;!?\n]/g;

function localClause(text: string, start: number, end: number): { before: string; after: string } {
  let clauseStart = 0;
  let clauseEnd = text.length;
  for (const m of text.matchAll(LOCAL_CLAUSE_SEPARATOR)) {
    const at = m.index ?? 0;
    if (at < start) clauseStart = at + 1;
    else if (at >= end) {
      clauseEnd = at;
      break;
    }
  }
  return { before: text.slice(clauseStart, start), after: text.slice(end, Math.max(end, clauseEnd)) };
}

function isKoVerbNegated(text: string, start: number, length: number): boolean {
  if (isNegated(text, start, length)) return true;
  const clause = localClause(text, start, start + length);
  return KO_NEGATION_BEFORE_VERB.test(clause.before) || KO_NEGATION_AFTER_VERB.test(clause.after);
}

function isEnVerbNegated(text: string, start: number, length: number): boolean {
  return isNegated(text, start, length) || EN_LOCAL_NEGATION.test(localClause(text, start, start + length).before);
}

/** What may follow a bound particle: the end, whitespace, punctuation, a wrapping character or the verb itself. */
const KO_AFTER_PARTICLE = `(?=$|[\\s.,!?~${WRAP}]|알려|리마인드|알림)`;

/** Day names join directly (`월수금`) or through an explicit separator (`월, 수`, `월요일과 수요일`). */
const KO_WD_SEPARATOR = '(?:\\s?(?:,|、|과|와|및|하고|이랑|랑)\\s?)?';
/** After `매주` short day names are fine (`매주 월수금`); before `마다` every day needs `요일` (`월마다` is monthly). */
const KO_WD_LIST = `[월화수목금토일](?:요일)?(?:${KO_WD_SEPARATOR}[월화수목금토일](?:요일)?)*`;
const KO_WD_LIST_FULL = `[월화수목금토일]요일(?:${KO_WD_SEPARATOR}[월화수목금토일]요일)*`;

const KO_COMPONENTS: ReadonlyArray<{ re: RegExp; apply: (spec: TimeSpec, m: RegExpExecArray) => void; past?: boolean }> = [
  { re: /(?:어제|그제|그저께|엊그제|지난\s?주(?:\s?[월화수목금토일]요일)?|지난\s?[월화수목금토일]요일)/y, apply: () => undefined, past: true },
  {
    re: new RegExp(`((?:(?:\\d{1,4}|${KO_NATIVE})\\s?(?:시간|분|초|일|주)\\s?(?:반\\s?)?)+)(?:뒤|후)(?:에)?${KO_AFTER_PARTICLE}`, 'y'),
    apply: (spec, m) => {
      let total = 0;
      const unitRe = new RegExp(`(\\d{1,4}|${KO_NATIVE})\\s?(시간|분|초|일|주)(\\s?반)?`, 'g');
      let u: RegExpExecArray | null;
      while ((u = unitRe.exec(m[1] ?? '')) !== null) {
        const n = koNumber(u[1] ?? '');
        const unit = u[2];
        const half = u[3] !== undefined;
        if (half && unit !== '시간') spec.invalidTime = true;
        const unitMs = unit === '시간' ? 3_600_000 : unit === '분' ? 60_000 : unit === '초' ? 1000 : unit === '일' ? MS_PER_DAY : 7 * MS_PER_DAY;
        total += n * unitMs + (half ? 1_800_000 : 0);
      }
      set(spec, 'relativeMs', total);
    },
  },
  {
    re: new RegExp(`(?:매일|평일(?:\\s?매일|마다)?|주말마다|매주\\s?주말|매주\\s?(${KO_WD_LIST})(?:\\s?마다)?|(${KO_WD_LIST_FULL})\\s?마다)`, 'y'),
    apply: (spec, m) => {
      const text = m[0];
      if (text.startsWith('매일')) return set(spec, 'recurrence', { type: 'DAILY' });
      if (text.startsWith('평일')) return set(spec, 'recurrence', { type: 'WEEKLY', weekdays: [1, 2, 3, 4, 5] });
      if (text.includes('주말')) return set(spec, 'recurrence', { type: 'WEEKLY', weekdays: [0, 6] });
      const list = m[1] ?? m[2] ?? '';
      const days = new Set<ReminderWeekday>();
      for (const ch of list.replace(/요일/g, '')) {
        const day = KO_WEEKDAYS[ch];
        if (day !== undefined) days.add(day);
      }
      set(spec, 'recurrence', { type: 'WEEKLY', weekdays: [...days] });
    },
  },
  {
    re: /(?:(\d{4})\s?년\s?)?(\d{1,2})\s?월\s?(\d{1,2})\s?일|(\d{4})-(\d{1,2})-(\d{1,2})/y,
    apply: (spec, m) => {
      if (m[4] !== undefined) {
        return setDay(spec, 'date', { year: Number(m[4]), month: Number(m[5]), day: Number(m[6]) });
      }
      const date: { year?: number; month: number; day: number } = { month: Number(m[2]), day: Number(m[3]) };
      if (m[1] !== undefined) date.year = Number(m[1]);
      setDay(spec, 'date', date);
    },
  },
  {
    re: /(내일\s?모레|오늘|내일|낼|모레|글피)/y,
    apply: (spec, m) => {
      const word = (m[1] ?? '').replace(/\s/g, '');
      const offset = word === '오늘' ? 0 : word === '내일' || word === '낼' ? 1 : word === '글피' ? 3 : 2;
      setDay(spec, 'dayOffset', offset);
    },
  },
  {
    re: /(?:(다다음|다음|담|이번|돌아오는)\s?주\s?)?([월화수목금토일])요일/y,
    apply: (spec, m) => {
      const week: WeekRef =
        m[1] === undefined || m[1] === '돌아오는' ? 'NEAREST' : m[1] === '이번' ? 'THIS' : m[1] === '다다음' ? 'AFTER_NEXT' : 'NEXT';
      const day = KO_WEEKDAYS[m[2] ?? ''];
      if (day !== undefined) setDay(spec, 'weekday', { day, week });
    },
  },
  {
    re: /(오전|오후|아침|점심|저녁|밤|새벽|낮)/y,
    apply: (spec, m) => {
      const word = m[1];
      const meridiem: Meridiem =
        word === '오전' || word === '아침' || word === '새벽'
          ? 'AM'
          : word === '오후'
            ? 'PM'
            : word === '저녁'
              ? 'EVENING'
              : word === '밤'
                ? 'NIGHT'
                : 'DAYTIME';
      set(spec, 'meridiem', meridiem);
    },
  },
  {
    re: new RegExp(`(\\d{1,2}|${KO_NATIVE})\\s?시(?![간작])(?:\\s?(?:(\\d{1,2})\\s?분|(반)))?(?:\\s?(?:쯤|경|정각))?|(\\d{1,2}):(\\d{2})(?:\\s?(?:쯤|경))?`, 'y'),
    apply: (spec, m) => {
      if (m[4] !== undefined) {
        const raw = m[4];
        return set(spec, 'clock', { hour: Number(raw), minute: Number(m[5]), zeroPadded: raw.length === 2 && raw.startsWith('0') });
      }
      const raw = m[1] ?? '';
      const minute = m[3] !== undefined ? 30 : m[2] !== undefined ? Number(m[2]) : 0;
      set(spec, 'clock', { hour: koNumber(raw), minute, zeroPadded: /^0\d$/.test(raw) });
    },
  },
  {
    re: /(정오|자정)/y,
    apply: (spec, m) => set(spec, 'special', m[1] === '정오' ? 'NOON' : 'MIDNIGHT'),
  },
];

/** Sub-daily repeats are always a recognized but unsupported reminder phrase. */
const KO_SUBDAILY = /매\s?시간|매\s?분|매\s?시\s?정각|(?:\d{1,4}|한|두|세)\s?(?:시간|분|초)\s?마다|한\s?시간\s?마다/;
/** Monthly / yearly repeats: unsupported, but only claimed when tied to the verb or to a bound time. */
const KO_LONG_RECURRENCE = /매\s?달|매월|매년|매해|격주|매주(?!\s?(?:[월화수목금토일]|주말))/;

interface BoundExpression {
  start: number;
  end: number;
  spec: TimeSpec;
  past: boolean;
}

/** Whitespace or wrapping characters between two components (`**내일** 9시에`). */
const KO_GAP = new RegExp(`[\\s${WRAP}]*`, 'y');
const KO_WORD_START_BEFORE = new RegExp(`[\\s.,!?~(${WRAP}]`);
const KO_WRAP_CHAR = new RegExp(`[\\s${WRAP}]`);
const KO_GAP_ONLY = new RegExp(`^[\\s${WRAP}]*$`);

/** Greedy component scan from `start`; returns the expression when it ends in a binding particle. */
function scanKoExpression(text: string, start: number): BoundExpression | null {
  const spec: TimeSpec = {};
  let pos = start;
  let matchedAny = false;
  let past = false;
  let relative = false;
  for (;;) {
    const ws = KO_GAP;
    ws.lastIndex = pos;
    const wsMatch = ws.exec(text);
    const afterWs = pos + (wsMatch?.[0].length ?? 0);
    let advanced = false;
    for (const component of KO_COMPONENTS) {
      component.re.lastIndex = matchedAny ? afterWs : pos;
      const m = component.re.exec(text);
      if (m === null || m[0].length === 0) continue;
      component.apply(spec, m);
      if (component.past === true) past = true;
      if (spec.relativeMs !== undefined) relative = true;
      pos = component.re.lastIndex;
      matchedAny = true;
      advanced = true;
      break;
    }
    // A relative duration carries its own `뒤에`/`후에`: the expression ends there.
    if (!advanced || relative) break;
  }
  if (!matchedAny) return null;
  if (relative) return { start, end: pos, spec, past };
  const particle = new RegExp(`\\s?에${KO_AFTER_PARTICLE}`, 'y');
  particle.lastIndex = pos;
  const p = particle.exec(text);
  if (p === null) return null;
  return { start, end: pos + p[0].length, spec, past };
}

function findKoExpressions(text: string): BoundExpression[] {
  const found: BoundExpression[] = [];
  let i = 0;
  while (i < text.length) {
    const atWordStart = i === 0 || KO_WORD_START_BEFORE.test(text[i - 1] ?? '');
    if (atWordStart && !KO_WRAP_CHAR.test(text[i] ?? '')) {
      const expression = scanKoExpression(text, i);
      if (expression !== null) {
        found.push(expression);
        i = expression.end;
        continue;
      }
    }
    i++;
  }
  return found;
}

/** Whether a Hangul syllable has a final consonant (batchim). */
function hasBatchim(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

/** Strip a trailing object particle (`을` after a batchim, `를` after none) and quotative `(이)라고`. */
function stripKoTrailingParticles(body: string): string {
  let out = body.replace(/\s?(?:이라고|라고)$/, '');
  if (out !== body) return out;
  const last = out.slice(-1);
  const before = out.slice(-2, -1);
  if (out.length >= 2 && ((last === '을' && hasBatchim(before)) || (last === '를' && !hasBatchim(before) && /[가-힣]/.test(before)))) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Before / after a standalone Korean word: whitespace, a wrapping character, punctuation or a particle. */
const KO_WORD_BEFORE = `(?:^|[\\s(${WRAP}])`;
const KO_WORD_AFTER = `(?=$|[\\s${WRAP},.!?~)은는에의도])`;

const KO_STRAY_DAY_WORD = new RegExp(
  `${KO_WORD_BEFORE}(?:오늘|내일|낼|모레|글피|[월화수목금토일]요일|\\d{1,2}\\s?월\\s?\\d{1,2}\\s?일)${KO_WORD_AFTER}`,
);

/**
 * Day references the grammar does not resolve: a bare day of month (`15일`, not the durations `3일 동안`/`3일치`/
 * `3일 뒤`), a week or month without a weekday or date (`다음 주`, `이번 달`), the weekend, `월말`, `내년`, ….
 */
const KO_UNSUPPORTED_DAY = new RegExp(
  `${KO_WORD_BEFORE}(?:` +
    '\\d{1,2}\\s?일(?!\\s?(?:뒤|후|전|동안|이내|마다|씩))' +
    '|(?:다다음|다음|담|이번|돌아오는|지난)\\s?(?:주말|주|달)' +
    '|주말|월말|월초|연말|연초|내년|다음\\s?해' +
    `)(?=$|[\\s${WRAP}은는에의도까,.!?~)])`,
);

/** A part-of-day word standing on its own (`오전`, `아침`, `저녁`, …). */
const KO_PART_OF_DAY_WORD = new RegExp(`${KO_WORD_BEFORE}(?:오전|오후|아침|점심|저녁|밤|새벽|낮)${KO_WORD_AFTER}`);

/**
 * Time words that must never stay in a body (they would silently change the schedule): a part of the day bound by
 * `에` (`오전에`) and a recurrence (`매일`, `평일`, `주말마다`, `매주`, `월요일마다`).
 */
const KO_BODY_TIME_WORD = new RegExp(
  `${KO_WORD_BEFORE}(?:(?:오전|오후|아침|점심|저녁|밤|새벽|낮)\\s?에(?![가-힣])|(?:매일|평일|매주|주말마다|[월화수목금토일]요일마다)(?=$|[^가-힣]|에|은|는|도|마다))`,
);

/** Whether `text` names a day (resolved or not) outside a bound time expression. */
function hasKoDayWord(text: string): boolean {
  const padded = ` ${text}`;
  return KO_STRAY_DAY_WORD.test(padded) || KO_UNSUPPORTED_DAY.test(padded);
}

const BODY_EDGE = new RegExp(`^[\\s.,!?~:：\\-${WRAP}]+|[\\s.,!?~${WRAP}]+$`, 'g');

function cleanBody(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(BODY_EDGE, '')
    .replace(/^(?:좀|꼭)\s/, '')
    .replace(/\s?(?:좀|꼭)$/, '')
    .replace(BODY_EDGE, '')
    .trim();
}

/** A self addressee (`나한테`, `저에게`) is not part of the body. */
function stripKoSelfAddressee(body: string): string {
  return body.replace(/(?:^|\s)(?:나|저|우리|저희)(?:한테|에게)(?=\s|$)/g, ' ');
}

/**
 * Another addressee (`김대리한테`, `팀원들에게`, `팀장님께`): the owner asks Quoky to tell someone else, which is not
 * an owner reminder. `나`/`저`/`우리`/`저희` are the owner; `함께` / `그저께` / `엊그제께` are not addressees.
 */
const KO_ADDRESSEE = new RegExp(`${KO_WORD_BEFORE}([가-힣A-Za-z0-9]+?)(?:한테|에게|께)(?=$|[\\s,${WRAP}])`, 'g');
const KO_SELF_OR_NOT_ADDRESSEE = new Set(['나', '저', '우리', '저희', '함', '그저', '엊그제', '그제']);

function hasKoOtherAddressee(text: string): boolean {
  return [...text.matchAll(KO_ADDRESSEE)].some((m) => !KO_SELF_OR_NOT_ADDRESSEE.has(m[1] ?? ''));
}

/** A Hangul syllable's final consonant index (0 = none, 4 = ㄴ, 8 = ㄹ). */
function finalConsonant(ch: string): number {
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : -1;
}

const KO_WH_WORD = /뭐|무엇|무슨|언제|어디|누가|누구|왜|어떻게|몇|어느|얼마|어떤/;

/**
 * An embedded question as the body (`9시에 뭐 있는지 알려줘`, `점심에 뭐 먹을지`): the time modifies the question,
 * not the reminder verb. `는지`/`을지` always; `ㄴ지`/`ㄹ지`/`은지` only with a wh-word (`편지`, `업무 일지` are nouns).
 */
function isKoEmbeddedQuestion(body: string): boolean {
  if (/(?:는지|을지)$/.test(body)) return true;
  if (!body.endsWith('지') || body.length < 2) return false;
  const before = body.slice(-2, -1);
  const final = finalConsonant(before);
  return (before === '은' || final === 4 || final === 8) && KO_WH_WORD.test(body);
}

/**
 * A direct question as the body of a generic `알려줘` (`9시에 뭐 있어? 알려줘`, `3시에 회의실 어디야 알려줘`, `내일 3시에
 * 회의 있나 알려줘`): the time sits inside the question, so it is an information request, not a reminder. A wh-word
 * must open a word; a question ending is matched on the body's last word (a polite `요` aside) and limited to
 * predicate forms so nouns (`언니`, `바나나`, `분야`) are not read as questions.
 */
const KO_WH_WORD_START = /(?:^|\s)(?:뭐|뭘|뭔|무엇|무슨|어디|언제|누가|누구|몇|어때|어떄|어떻게|어떤|어느|왜|얼마)/;
const KO_QUESTION_ENDING =
  /(?:어때|어떄|까|냐|(?:있|없|했|됐|맞|좋|많|괜찮|갔|왔|있었|없었)(?:어|나|니|지)|(?:되|오)(?:나|니)|(?:이|거|건)야|(?:인|일|건)가)$/;

function isKoDirectQuestion(body: string, beforeVerb: string): boolean {
  if (/[?？]/.test(beforeVerb)) return true;
  if (KO_WH_WORD_START.test(body)) return true;
  return KO_QUESTION_ENDING.test(body.replace(/요$/, ''));
}

/** Two-syllable nouns ending in `한`/`할` that are not `하다` adnominals (`기한 확인`, `역할 분담`). */
const KO_HAN_NOUN = /(?:기한|제한|권한|시한|무한|유한|역할|분할)$/;
const KO_ADNOMINAL_NEUN_STEM = /(?:하|되|가|오|보|타|열리|끝나|만나|떠나|닫히)는$/;
const KO_ADNOMINAL_EUN = /(?:먹|닫|받|읽|찾|넣|잡|앉|좋|많|작|높|낮|같|괜찮)은$/;
const KO_ADNOMINAL_EUL = /(?:먹|닫|받|읽|찾|있|없|넣|씻|잡|앉)을$/;
const KO_ADNOMINAL_IRREGULAR = /(?:열릴|열린|끝날|끝난|만날|만난|떠날|떠난|걸릴|걸린)$/;
/** One-syllable adnominals (`갈 곳`, `올 버스`); `할`/`한`/`줄` are left out (`할 일`, `한 번`, `줄 서기`). */
const KO_ADNOMINAL_SINGLE = new Set(['갈', '간', '올', '온', '볼', '본', '탈', '탄', '될', '된']);

/**
 * A Hangul adnominal predicate (`오픈하는`, `닫는`, `출발할`, `시작한`, `먹은`, `가던`): a following noun makes the
 * preceding time bind that inner clause (`9시에 오픈하는 식당`), not the reminder verb.
 */
function isKoAdnominal(word: string): boolean {
  if (!/^[가-힣]+$/.test(word)) return false;
  if (word.length === 1) return KO_ADNOMINAL_SINGLE.has(word);
  if (word.endsWith('던')) return word !== '런던';
  if (word.endsWith('는')) return hasBatchim(word.slice(-2, -1)) || KO_ADNOMINAL_NEUN_STEM.test(word);
  if (KO_ADNOMINAL_EUN.test(word) || KO_ADNOMINAL_EUL.test(word) || KO_ADNOMINAL_IRREGULAR.test(word)) return true;
  const last = word.slice(-1);
  const final = finalConsonant(last);
  if (final !== 4 && final !== 8) return false;
  const open = String.fromCharCode(last.charCodeAt(0) - final);
  return (open === '하' || open === '되') && !KO_HAN_NOUN.test(word);
}

/**
 * Whether the bound time is directly followed by an adnominal clause that a noun completes: the first word after
 * the time (`9시에 오픈하는 식당`) or the second one after its argument (`11시에 문 닫는 카페`). A predicate further
 * away has its own modifier (`9시에 3일 동안 먹을 약`) and does not take the time.
 */
function hasKoAdnominalClause(region: string): boolean {
  const words = region
    .split(new RegExp(`[\\s.,!?~${WRAP}]+`))
    .filter((w) => w.length > 0);
  return words.slice(0, Math.min(2, words.length - 1)).some(
    (word, index) => isKoAdnominal(word) && !KO_NOMINALIZER.test(words[index + 1] ?? ''),
  );
}

/** A nominalizer after the adnominal (`약 먹는 거`, `준비할 것`) names the thing to be reminded of, not a question. */
const KO_NOMINALIZER = /^(?:거|것|걸|게|거를|것을|거요|것요)$/;

/** Compound nouns that end like a copula question (`업무일지` is a journal, not `업무일지` "whether it is work"). */
const KO_JI_COMPOUND_NOUN =
  /(?:업무|작업|근무|육아|운동|관찰|영업|학습|여행|공사|운행|감사|메타)(?:일지|인지)$/;

/**
 * An embedded yes/no question as the body of a generic `알려줘` (`내일 3시에 예약 가능한지 알려줘`, `내일 3시에
 * 회의인지 알려줘`, `참석 여부 알려줘`): the time sits inside the question, so it is an information request, not a
 * reminder. Matched on the body's last word: `여부`, or a predicate / copula stem before `지` — `는지`/`을지`, an
 * attached `은지`/`인지`/`일지`, `할지`, or a Hangul adnominal (`가능한지`, `될지`, `열릴지`). Nouns stay bodies: a
 * standalone `편지` / `일지` / `인지` (one syllable before `지`) and the compounds above.
 */
function isKoPredicateQuestion(body: string): boolean {
  const last = body.split(/\s+/).pop() ?? '';
  if (last.endsWith('여부')) return true;
  if (!/^[가-힣]{2,}$/.test(last) || !last.endsWith('지')) return false;
  const stem = last.slice(0, -1);
  if (/(?:는|을)$/.test(stem)) return true;
  if (stem.length >= 2 && /(?:은|인|일)$/.test(stem)) return !KO_JI_COMPOUND_NOUN.test(last);
  return stem === '할' || isKoAdnominal(stem);
}

/**
 * The sentence holding every used span, as a same-length copy of `text` with the other sentences blanked (`… 알려줘.
 * 고마워` → the thanks is not body). Null when the spans cross a sentence end.
 */
function koSentenceWindow(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string | null {
  const first = Math.min(...spans.map((sp) => sp.start));
  const last = Math.max(...spans.map((sp) => sp.end));
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(/[.!?。]+(?=\s|$)/g)) {
    const at = m.index ?? 0;
    if (spans.some((sp) => at >= sp.start && at < sp.end)) continue;
    if (at + m[0].length <= first) start = at + m[0].length;
    else if (at >= last) {
      end = at;
      break;
    } else return null;
  }
  return ' '.repeat(start) + text.slice(start, end) + ' '.repeat(text.length - end);
}

function removeSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    out += `${text.slice(cursor, span.start)} `;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** Fold an auxiliary expression's day, recurrence and meridiem into `target` (a repeat is a conflict). */
function mergeSpec(target: TimeSpec, source: TimeSpec): void {
  if (source.dayOffset !== undefined) setDay(target, 'dayOffset', source.dayOffset);
  if (source.weekday !== undefined) setDay(target, 'weekday', source.weekday);
  if (source.date !== undefined) setDay(target, 'date', source.date);
  if (source.recurrence !== undefined) set(target, 'recurrence', source.recurrence);
  if (source.meridiem !== undefined) set(target, 'meridiem', source.meridiem);
  if (source.conflict === true) target.conflict = true;
  if (source.invalidTime === true) target.invalidTime = true;
}

/** A clock read without any marker as a 12-hour time (`9시`, `at 7`): a part-of-day word nearby could change it. */
function hasBareTwelveHourClock(spec: TimeSpec): boolean {
  const clock = spec.clock;
  return spec.meridiem === undefined && clock !== undefined && !clock.zeroPadded && clock.hour >= 1 && clock.hour <= 12;
}

function parseKorean(text: string, ctx: ResolveContext): ReminderCommand {
  const verb = [...text.matchAll(KO_VERB)].find((m) => !isKoVerbNegated(text, m.index ?? 0, m[0].length));
  if (verb === undefined) return NOT_REMINDER;
  if (hasKoOtherAddressee(text)) return NOT_REMINDER;
  const strongVerb = verb[2] !== undefined;
  const verbStart = verb.index ?? 0;
  const verbSpan = { start: verbStart, end: verbStart + verb[0].length };

  const expressions = findKoExpressions(text).filter((e) => e.end <= verbSpan.start || e.start >= verbSpan.end);
  if (expressions.some((e) => e.past)) return NOT_REMINDER;

  if (KO_SUBDAILY.test(text)) return clarify('UNSUPPORTED_RECURRENCE');
  const longRecurrence = KO_LONG_RECURRENCE.exec(text);
  if (longRecurrence !== null) {
    const between = text.slice(longRecurrence.index + longRecurrence[0].length, verbSpan.start);
    if (expressions.length > 0 || /^\s*$/.test(between)) return clarify('UNSUPPORTED_RECURRENCE');
  }

  // Only a clock or a duration makes a time; a day, recurrence or part of the day bound on its own is auxiliary.
  const timed = expressions.filter((e) => e.spec.relativeMs !== undefined || hasTimeOfDay(e.spec));
  if (timed.length === 0) {
    // A reminder request with a day but no clock must not fall through to chat (which could promise a reminder that
    // is never created): a day or recurrence plus a part of the day bound by 에 (`내일 오전에 회의 알려줘`), or an
    // explicit reminder verb with any day or part-of-day word (`내일 회의 리마인드 해줘`). `내일 날씨 알려줘` stays chat;
    // a meridiem alone (`점심에 뭐 먹을지 알려줘`) or a day alone with `알려줘` (`월요일에 뭐 있는지`) is not a time.
    const dayWithPartOfDay = expressions.some(
      (e) => e.spec.meridiem !== undefined && (hasDayInfo(e.spec) || e.spec.recurrence !== undefined),
    );
    const boundDay = expressions.some((e) => hasDayInfo(e.spec) || e.spec.recurrence !== undefined);
    const outsideVerb = removeSpans(text, [verbSpan]);
    if (
      dayWithPartOfDay ||
      (strongVerb && (boundDay || hasKoDayWord(outsideVerb) || KO_PART_OF_DAY_WORD.test(` ${outsideVerb}`)))
    ) {
      return clarify('MISSING_TIME');
    }
    return NOT_REMINDER;
  }
  if (timed.length > 1) return clarify('AMBIGUOUS_TIME');
  const core = timed[0];
  if (core === undefined) return NOT_REMINDER;

  // An auxiliary expression directly before the time joins it (`오전에 9시에`, `평일에 9시에`, `주말마다 아침에 9시에`);
  // one anywhere else would be dropped into the body while the clock is read without it — clarify instead.
  const spec: TimeSpec = { ...core.spec };
  const used: BoundExpression[] = [core];
  let joinedStart = core.start;
  for (let k = expressions.indexOf(core) - 1; k >= 0; k--) {
    const previous = expressions[k];
    if (previous === undefined || !KO_GAP_ONLY.test(text.slice(previous.end, joinedStart))) break;
    mergeSpec(spec, previous.spec);
    used.push(previous);
    joinedStart = previous.start;
  }
  if (expressions.some((e) => !used.includes(e))) return clarify('AMBIGUOUS_TIME');

  const spans = [...used, verbSpan];
  const sentence = koSentenceWindow(text, spans) ?? text;
  const body = cleanBody(stripKoTrailingParticles(cleanBody(stripKoSelfAddressee(removeSpans(sentence, spans)))));
  if (!strongVerb) {
    // A generic `알려줘` is also an information request: a question (`9시에 뭐 있어 알려줘`, `3시에 예약 가능한지
    // 알려줘`) or a time bound to an inner clause (`9시에 오픈하는 식당 알려줘`) falls through to chat. Explicit
    // reminder verbs stay reminders.
    const afterTime = verbSpan.start >= core.end ? text.slice(core.end, verbSpan.start) : text.slice(core.end);
    if (
      isKoDirectQuestion(body, text.slice(0, verbSpan.start)) ||
      isKoPredicateQuestion(body) ||
      hasKoAdnominalClause(afterTime)
    ) {
      return NOT_REMINDER;
    }
  }

  const resolved = resolveSpec(spec, ctx);
  if (!resolved.ok) return clarify(resolved.reason);

  if (isKoEmbeddedQuestion(body)) return NOT_REMINDER;
  const bodyKind = bodyKindOf(body);
  if (bodyKind === 'TEXT') {
    const padded = ` ${body}`;
    if (KO_BODY_TIME_WORD.test(padded)) return clarify('AMBIGUOUS_TIME'); // `9시에 매일 약`, `9시에 회의 저녁에`
    if (hasBareTwelveHourClock(spec) && KO_PART_OF_DAY_WORD.test(padded)) return clarify('AMBIGUOUS_TIME'); // `9시에 저녁 약속`
    if (!hasDayInfo(spec) && spec.recurrence === undefined && spec.relativeMs === undefined && hasKoDayWord(body)) {
      // `내일 회의 9시에 알려줘`, `15일 오후 3시에 회의 알려줘`, `다음 주 오후 3시에 보고 알려줘`: a day sits outside the
      // bound time (or is one the grammar does not resolve) — never read the time as today's and guess the day.
      return clarify('AMBIGUOUS_TIME');
    }
  }
  return finishCreate(body, bodyKind, resolved, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// English parser
// ---------------------------------------------------------------------------------------------------------------

const EN_WEEKDAY_NAMES: ReadonlyArray<readonly [RegExp, ReminderWeekday]> = [
  [/^sun/i, 0],
  [/^mon/i, 1],
  [/^tue/i, 2],
  [/^wed/i, 3],
  [/^thu/i, 4],
  [/^fri/i, 5],
  [/^sat/i, 6],
];
const EN_WD = '(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)s?';
const EN_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const;
const EN_MONTH =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

function enWeekday(token: string): ReminderWeekday | undefined {
  return EN_WEEKDAY_NAMES.find(([re]) => re.test(token))?.[1];
}

function enMonth(token: string): number {
  return EN_MONTHS.indexOf(token.slice(0, 3).toLowerCase() as (typeof EN_MONTHS)[number]) + 1;
}

function enCount(token: string): number {
  const t = token.toLowerCase();
  return t === 'a' || t === 'an' || t === 'one' ? 1 : Number.parseInt(t, 10);
}

function enUnitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith('s')) return 1000;
  if (u.startsWith('mi')) return 60_000;
  if (u.startsWith('h')) return 3_600_000;
  if (u.startsWith('d')) return MS_PER_DAY;
  return 7 * MS_PER_DAY;
}

const EN_END = '(?=$|[\\s.,!?;])';
const EN_VERB = /\bremind\s+me\b/gi;
const EN_PAST = /\b(?:yesterday|last\s+(?:week|night|month|year|(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))|\d+\s+(?:minutes?|hours?|days?|weeks?)\s+ago)\b/i;
/**
 * Day references the English grammar does not resolve: a bare ordinal day (`on the 15th`), a week, weekend, month
 * or year without a date (`next week`, `this weekend`, `end of the month`).
 */
const EN_UNSUPPORTED_DAY =
  /\b(?:on\s+the\s+\d{1,2}(?:st|nd|rd|th)?|the\s+\d{1,2}(?:st|nd|rd|th)|(?:next|this|coming)\s+(?:week|weekend|month|year)|(?:on|at|over)\s+the\s+weekend|end\s+of\s+(?:the\s+|this\s+|next\s+)?(?:week|month|year))\b/i;
/** A weekday name not bound by `on`/`next`/`this`/`every` (`at 3pm friday`); a possessive (`friday's`) is a noun. */
const EN_STRAY_WEEKDAY = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b(?!['’]s)/i;
/** Politeness / request lead-ins that may precede `remind me` and never belong to the body. */
const EN_LEAD_IN =
  /^(?:(?:hey|hi|hello|ok|okay|so|also|um|quoky|can|could|would|will|you|please|pls|plz|kindly|i|i['’]d|need|want|like|to)\b[\s,!]*)*$/i;
/** `remind me what time the meeting at 3pm is`: an embedded question, not a reminder. */
const EN_WH_AFTER_VERB = /^\s+(?:what|when|where|who|whom|whose|which|why|how|whether|if)\b/i;
/** `remind me by 5pm` / `before tomorrow at 9`: a deadline, not a fire time — clarify, never guess. */
const EN_DEADLINE_BEFORE = /\b(?:by|before|until|till|til|no\s+later\s+than)\s+$/i;
/** A part-of-day word left in the body next to a bare 12-hour clock (`at 7 to plan the evening`). */
const EN_PART_OF_DAY_WORD = /\b(?:morning|afternoon|evening|night|tonight|noon|midnight)s?\b/i;

function enPartOfDay(word: string | undefined): Meridiem | undefined {
  switch ((word ?? '').toLowerCase()) {
    case 'morning':
      return 'AM';
    case 'afternoon':
      return 'PM';
    case 'evening':
      return 'EVENING';
    case 'night':
      return 'NIGHT';
    default:
      return undefined;
  }
}
const EN_PART_OF_DAY = '(morning|afternoon|evening|night)';
const EN_LEAD_IN_MAX_CHARS = 48;
const EN_UNSUPPORTED = /\b(?:every\s+(?:\d+\s+|other\s+)?(?:seconds?|minutes?|mins?|hours?|hrs?|months?|years?)|hourly|monthly|yearly|annually|every\s+other\s+\w+)\b/i;

const EN_COMPONENTS: ReadonlyArray<{ re: RegExp; apply: (spec: TimeSpec, m: RegExpExecArray) => void }> = [
  {
    re: new RegExp(
      `\\b(?:every\\s?day|everyday|daily(?!\\s+brief)|each\\s+day|every\\s+weekday|on\\s+weekdays|weekdays|every\\s+weekend|on\\s+weekends|every\\s+(${EN_WD}(?:\\s*(?:,|and|&)\\s*(?:and\\s+)?${EN_WD})*))${EN_END}`,
      'gi',
    ),
    apply: (spec, m) => {
      const text = m[0].toLowerCase();
      if (/day\b|daily/.test(text) && !/weekday|sunday|monday|tuesday|wednesday|thursday|friday|saturday/.test(text)) {
        return set(spec, 'recurrence', { type: 'DAILY' });
      }
      if (text.includes('weekday')) return set(spec, 'recurrence', { type: 'WEEKLY', weekdays: [1, 2, 3, 4, 5] });
      if (text.includes('weekend')) return set(spec, 'recurrence', { type: 'WEEKLY', weekdays: [0, 6] });
      const days = new Set<ReminderWeekday>();
      for (const token of (m[1] ?? '').split(/[\s,&]+|and/i)) {
        const day = enWeekday(token);
        if (token.length > 0 && day !== undefined) days.add(day);
      }
      set(spec, 'recurrence', { type: 'WEEKLY', weekdays: [...days] });
    },
  },
  {
    re: new RegExp(
      `\\bin\\s+(?:(\\d{1,4}|an?|one)\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)|(half\\s+an?\\s+hour))(?:\\s+and\\s+(?:(\\d{1,4}|an?|one)\\s*(seconds?|secs?|minutes?|mins?)|(a\\s+half)))?${EN_END}`,
      'gi',
    ),
    apply: (spec, m) => {
      let total = m[3] !== undefined ? 1_800_000 : enCount(m[1] ?? '0') * enUnitMs(m[2] ?? 'm');
      if (m[4] !== undefined) total += enCount(m[4]) * enUnitMs(m[5] ?? 'm');
      if (m[6] !== undefined) {
        if (!/^h/i.test(m[2] ?? '')) spec.invalidTime = true;
        total += 1_800_000;
      }
      set(spec, 'relativeMs', total);
    },
  },
  {
    re: new RegExp(`\\bon\\s+${EN_MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${EN_END}`, 'gi'),
    apply: (spec, m) => {
      const date: { year?: number; month: number; day: number } = { month: enMonth(m[1] ?? ''), day: Number(m[2]) };
      if (m[3] !== undefined) date.year = Number(m[3]);
      setDay(spec, 'date', date);
    },
  },
  {
    re: new RegExp(`\\bon\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MONTH}(?:,?\\s+(\\d{4}))?${EN_END}`, 'gi'),
    apply: (spec, m) => {
      const date: { year?: number; month: number; day: number } = { month: enMonth(m[2] ?? ''), day: Number(m[1]) };
      if (m[3] !== undefined) date.year = Number(m[3]);
      setDay(spec, 'date', date);
    },
  },
  {
    re: /\b(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})(?=$|[\s.,!?;])/gi,
    apply: (spec, m) => setDay(spec, 'date', { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    // `tomorrow evening`, `today morning`: the part of the day sets the meridiem.
    re: new RegExp(`\\b(today|tonight|tomorrow|tmrw)(?:\\s+${EN_PART_OF_DAY})?\\b(?!['’]s)`, 'gi'),
    apply: (spec, m) => {
      const word = (m[1] ?? '').toLowerCase();
      setDay(spec, 'dayOffset', word === 'today' || word === 'tonight' ? 0 : 1);
      if (word === 'tonight') set(spec, 'meridiem', 'NIGHT');
      const part = enPartOfDay(m[2]);
      if (part !== undefined) set(spec, 'meridiem', part);
    },
  },
  {
    re: new RegExp(`\\bthis\\s+${EN_PART_OF_DAY}\\b`, 'gi'),
    apply: (spec, m) => {
      setDay(spec, 'dayOffset', 0);
      const part = enPartOfDay(m[1]);
      if (part !== undefined) set(spec, 'meridiem', part);
    },
  },
  {
    re: new RegExp(`\\b(?:(next|this)\\s+|on\\s+)(${EN_WD})(?:\\s+${EN_PART_OF_DAY})?${EN_END}`, 'gi'),
    apply: (spec, m) => {
      const day = enWeekday(m[2] ?? '');
      if (day === undefined) return;
      const which = (m[1] ?? '').toLowerCase();
      setDay(spec, 'weekday', { day, week: which === 'next' ? 'NEXT' : which === 'this' ? 'THIS' : 'NEAREST' });
      const part = enPartOfDay(m[3]);
      if (part !== undefined) set(spec, 'meridiem', part);
    },
  },
  {
    re: /\b(?:in\s+the\s+(morning|afternoon|evening)|at\s+(night))\b/gi,
    apply: (spec, m) => {
      const part = enPartOfDay(m[1] ?? m[2]);
      if (part !== undefined) set(spec, 'meridiem', part);
    },
  },
  {
    // `at` may be written `@` (`remind me @ 5pm`).
    re: new RegExp(
      `(?:(?:\\bat\\s+|@\\s*)(noon|midnight)|(?:\\bat\\s+|@\\s*|\\b)(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)|(?:\\bat\\s+|@\\s*)(\\d{1,2})(?::(\\d{2}))?)${EN_END}`,
      'gi',
    ),
    apply: (spec, m) => {
      if (m[1] !== undefined) return set(spec, 'special', m[1].toLowerCase() === 'noon' ? 'NOON' : 'MIDNIGHT');
      if (m[2] !== undefined) {
        const marker: Meridiem = (m[4] ?? '').toLowerCase().startsWith('a') ? 'AM' : 'PM';
        // An explicit am/pm replaces a `tonight` hint; two explicit markers are a conflict.
        if (spec.meridiem !== undefined && spec.meridiem !== 'NIGHT' && spec.meridiem !== marker) spec.conflict = true;
        spec.meridiem = marker;
        if (Number(m[2]) > 12) spec.invalidTime = true;
        return set(spec, 'clock', { hour: Number(m[2]), minute: m[3] !== undefined ? Number(m[3]) : 0, zeroPadded: false });
      }
      const raw = m[5] ?? '';
      set(spec, 'clock', {
        hour: Number(raw),
        minute: m[6] !== undefined ? Number(m[6]) : 0,
        zeroPadded: /^0\d$/.test(raw),
      });
    },
  },
];

type EnComponent = (typeof EN_COMPONENTS)[number];

interface EnComponentMatch {
  component: EnComponent;
  m: RegExpExecArray;
  start: number;
  end: number;
  /** A deadline word (`by`, `before`, …) directly precedes the match. */
  deadline: boolean;
}

/** Relative / demonstrative markers: a time after one of them may belong to the body, so its binding is ambiguous. */
const EN_CLAUSE_WORD = /\b(?:that|which|who|whom|whose|where|when)\b/i;

/**
 * Start of the body: the first non-blank character of `scan` after the verb. `scan` is `text` with the verb, lead-in
 * and every component match blanked (same length), so times attached to `remind me` sit before this index.
 */
function enBodyStart(scan: string, from: number): number {
  const rest = /[^\s,]/.exec(scan.slice(from));
  return rest === null ? scan.length : from + rest.index;
}

/**
 * Index of the first relative / demonstrative marker in the body (`that`, `which`, `who`, `whom`, `whose`, `where`,
 * `when`), or -1. A time after it is not provably the reminder's (ADR-0101 D2): no verb guessing, ask instead.
 */
function enFirstClauseMarker(text: string, bodyStart: number): number {
  const m = EN_CLAUSE_WORD.exec(text.slice(bodyStart));
  return m === null ? -1 : bodyStart + m.index;
}

function parseEnglish(text: string, ctx: ResolveContext): ReminderCommand {
  const verb = [...text.matchAll(EN_VERB)].find((m) => !isEnVerbNegated(text, m.index ?? 0, m[0].length));
  if (verb === undefined) return NOT_REMINDER;
  if (EN_PAST.test(text)) return NOT_REMINDER;
  if (EN_WH_AFTER_VERB.test(text.slice((verb.index ?? 0) + verb[0].length))) return NOT_REMINDER;

  const spec: TimeSpec = {};
  const spans: Array<{ start: number; end: number }> = [];
  let working = text;
  /** Blank a matched span (same length, so indices into `text` stay valid) so later components cannot re-match it. */
  const blank = (start: number, end: number) => {
    working = working.slice(0, start) + ' '.repeat(end - start) + working.slice(end);
    spans.push({ start, end });
  };
  const verbStart = verb.index ?? 0;
  blank(verbStart, verbStart + verb[0].length);
  // `can you remind me at 9pm to x` / `hey, please remind me …`: the lead-in is not part of the body.
  const leadIn = text.slice(0, verbStart);
  if (leadIn.length > 0 && leadIn.length <= EN_LEAD_IN_MAX_CHARS && EN_LEAD_IN.test(leadIn)) blank(0, verbStart);

  const hasUnsupported = EN_UNSUPPORTED.test(text);
  // Collect every component match first (each blanked in `scan` so later components cannot re-match it), then apply
  // only those bound to the reminder clause: a time inside a relative / content clause stays in the body.
  const matches: EnComponentMatch[] = [];
  let scan = working;
  for (const component of EN_COMPONENTS) {
    component.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = component.re.exec(scan)) !== null) {
      if (m[0].length === 0) {
        component.re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      matches.push({ component, m, start, end, deadline: EN_DEADLINE_BEFORE.test(scan.slice(0, start)) });
      scan = scan.slice(0, start) + ' '.repeat(end - start) + scan.slice(end);
    }
  }
  // A time is the reminder's when it is attached to `remind me` (before the body) or trails a body with no relative /
  // demonstrative marker before it. After a marker the binding is ambiguous: never scheduled, never dropped silently.
  const bodyStart = enBodyStart(scan, verbStart + verb[0].length);
  const marker = enFirstClauseMarker(text, bodyStart);
  const afterMarker = (match: EnComponentMatch) => marker !== -1 && match.start > marker;
  let deadline = false;
  let markedTime = false;
  for (const match of matches) {
    if (afterMarker(match)) {
      markedTime = true;
      continue;
    }
    if (match.deadline) deadline = true;
    match.component.apply(spec, match.m);
    blank(match.start, match.end);
  }
  if (hasUnsupported) return clarify('UNSUPPORTED_RECURRENCE');
  if (deadline) return clarify('AMBIGUOUS_TIME');
  // Day and part-of-day words after a marker describe the body (`the store that opens on monday`), not the time.
  let outsideClauses = working;
  if (marker !== -1) outsideClauses = outsideClauses.slice(0, marker) + ' '.repeat(outsideClauses.length - marker);

  const hasTime = spec.relativeMs !== undefined || hasTimeOfDay(spec);
  if (!hasTime) {
    // `remind me what we discussed` is a question; `remind me tomorrow to …` / `remind me next week to …` is a
    // reminder without a time. `remind me to book the restaurant that opens at 9am` is ambiguous: the time may be
    // the restaurant's or the reminder's, so it is asked, never guessed.
    if (markedTime) return clarify('AMBIGUOUS_TIME');
    return hasDayInfo(spec) || spec.recurrence !== undefined || EN_UNSUPPORTED_DAY.test(working)
      ? clarify('MISSING_TIME')
      : NOT_REMINDER;
  }
  if (
    !hasDayInfo(spec) &&
    spec.recurrence === undefined &&
    spec.relativeMs === undefined &&
    (EN_UNSUPPORTED_DAY.test(outsideClauses) || EN_STRAY_WEEKDAY.test(outsideClauses))
  ) {
    // `remind me on the 15th at 3pm …`, `remind me next week at 9am …`: never read the time as today's.
    return clarify('AMBIGUOUS_TIME');
  }
  // `remind me at 7 tomorrow evening` is read above; a part-of-day word left over next to a bare clock is not guessed.
  if (hasBareTwelveHourClock(spec) && EN_PART_OF_DAY_WORD.test(outsideClauses)) return clarify('AMBIGUOUS_TIME');
  const resolved = resolveSpec(spec, ctx);
  if (!resolved.ok) return clarify(resolved.reason);

  let body = cleanBody(removeSpans(text, spans));
  for (let previous = ''; previous !== body; ) {
    previous = body;
    body = body.replace(/^(?:to|about|that|of|for|please|,)\s+/i, '').replace(/\s+please$/i, '').trim();
  }
  return finishCreate(cleanBody(body), bodyKindOf(body), resolved, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

function finishCreate(
  body: string,
  bodyKind: ReminderBodyKind,
  resolved: Extract<Resolved, { ok: true }>,
  ctx: ResolveContext,
): ReminderCommand {
  if (reminderBodyLength(body) === 0) return clarify('EMPTY_BODY');
  if (reminderBodyLength(body) > REMINDER_LIMITS.maxBodyChars) return clarify('BODY_TOO_LONG');
  return {
    kind: 'CREATE',
    body,
    bodyKind,
    schedule: resolved.schedule,
    firstFireAt: resolved.firstFireAt,
    timeZone: ctx.timeZone,
  };
}

/** Parse one owner message. Never throws for any input string. */
export function parseReminderMessage(text: string, options: ReminderGrammarOptions): ReminderCommand {
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) throw new RangeError('parseReminderMessage: invalid now');
  const timeZone = options.timeZone ?? REMINDER_DEFAULT_TIME_ZONE;
  const trimmed = text.normalize('NFC').trim();
  if (trimmed.length === 0) return NOT_REMINDER;
  if (ANCHORED_TODO_PREFIX.test(trimmed)) return NOT_REMINDER;

  const message = trimmed.replace(/\s+/g, ' ');
  const listOrCancel = matchListOrCancel(message);
  if (listOrCancel !== null) return listOrCancel;

  const ctx: ResolveContext = { nowMs, timeZone };
  return KO_VERB_PRESENT.test(message) ? parseKorean(message, ctx) : parseEnglish(message, ctx);
}
