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
 * - CREATE needs a reminder verb (`알려줘`, `리마인드`, `알림 줘`, `remind me`, …) that is not negated, plus a time
 *   expression bound to it: Korean by `에` / `뒤에` / `후에`, English by `at` / `in` / `on` / `tomorrow` / `every`.
 * - Meridiem: an explicit marker (`오전`/`오후`/`아침`/`저녁`/`밤`/`am`/`pm`, …) or a 24-hour time wins; with a date
 *   (day word, weekday, date or recurrence) 1–6 → PM, 7–11 → AM, 12 → noon; a bare time → nearest future.
 * - Clarify, never guess: past, nonexistent, more than 366 days or less than 1 minute ahead, sub-daily or other
 *   unsupported recurrence, empty or over-200-character body, ambiguous combinations.
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

/** Generic `알려줘` forms and the explicit reminder verbs (`리마인드`, `알림 줘`/`알림 설정`). */
const KO_VERB =
  /(알려\s?(?:줘요|줘라|줘|주세요|줄래요|줄래|주라|주십시오|주시겠어요|주실래요))|(리마인드(?:\s?(?:해\s?줘요|해\s?줘|해\s?주세요|해\s?줄래|부탁해|부탁))?|알림\s?(?:줘요|줘|주세요|보내\s?줘요|보내\s?줘|보내\s?주세요|설정\s?해\s?줘|설정\s?해\s?주세요|맞춰\s?줘))/g;

const KO_VERB_PRESENT = new RegExp(KO_VERB.source);

/** What may follow a bound particle: the end, whitespace, punctuation or the verb itself. */
const KO_AFTER_PARTICLE = '(?=$|[\\s.,!?~]|알려|리마인드|알림)';

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

/** Greedy component scan from `start`; returns the expression when it ends in a binding particle. */
function scanKoExpression(text: string, start: number): BoundExpression | null {
  const spec: TimeSpec = {};
  let pos = start;
  let matchedAny = false;
  let past = false;
  let relative = false;
  for (;;) {
    const ws = /\s*/y;
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
    const atWordStart = i === 0 || /[\s.,!?~(]/.test(text[i - 1] ?? '');
    if (atWordStart && !/\s/.test(text[i] ?? '')) {
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

const KO_STRAY_DAY_WORD = /(?:^|\s)(?:오늘|내일|낼|모레|글피|[월화수목금토일]요일|\d{1,2}\s?월\s?\d{1,2}\s?일)(?=$|\s|[은는에의도])/;

function cleanBody(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,!?~:：\-]+|[\s.,!?~]+$/g, '')
    .replace(/^(?:좀|꼭)\s/, '')
    .replace(/\s(?:좀|꼭)$/, '')
    .trim();
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

function parseKorean(text: string, ctx: ResolveContext): ReminderCommand {
  const verb = [...text.matchAll(KO_VERB)].find((m) => !isNegated(text, m.index ?? 0, m[0].length));
  if (verb === undefined) return NOT_REMINDER;
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

  // A meridiem alone (`점심에 뭐 먹을지 알려줘`) is not a time; a day alone is one only for an explicit reminder verb.
  const meaningful = expressions.filter((e) => {
    const s = e.spec;
    if (s.relativeMs !== undefined || hasTimeOfDay(s)) return true;
    return strongVerb && (hasDayInfo(s) || s.recurrence !== undefined);
  });
  if (meaningful.length === 0) return NOT_REMINDER;
  if (meaningful.length > 1) return clarify('AMBIGUOUS_TIME');
  const expression = meaningful[0];
  if (expression === undefined) return NOT_REMINDER;

  const resolved = resolveSpec(expression.spec, ctx);
  if (!resolved.ok) return clarify(resolved.reason);

  const body = stripKoTrailingParticles(cleanBody(removeSpans(text, [expression, verbSpan])));
  const bodyKind = bodyKindOf(body);
  const s = expression.spec;
  if (bodyKind === 'TEXT' && !hasDayInfo(s) && s.recurrence === undefined && s.relativeMs === undefined && KO_STRAY_DAY_WORD.test(` ${body}`)) {
    // `내일 회의 9시에 알려줘`: the day sits outside the bound time — never guess which day was meant.
    return clarify('AMBIGUOUS_TIME');
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
    re: /\b(today|tonight|tomorrow|tmrw)\b(?!['’]s)/gi,
    apply: (spec, m) => {
      const word = (m[1] ?? '').toLowerCase();
      setDay(spec, 'dayOffset', word === 'today' || word === 'tonight' ? 0 : 1);
      if (word === 'tonight') set(spec, 'meridiem', 'NIGHT');
    },
  },
  {
    re: new RegExp(`\\b(?:(next|this)\\s+|on\\s+)(${EN_WD})${EN_END}`, 'gi'),
    apply: (spec, m) => {
      const day = enWeekday(m[2] ?? '');
      if (day === undefined) return;
      const which = (m[1] ?? '').toLowerCase();
      setDay(spec, 'weekday', { day, week: which === 'next' ? 'NEXT' : which === 'this' ? 'THIS' : 'NEAREST' });
    },
  },
  {
    re: /\bin\s+the\s+(morning|afternoon|evening)\b/gi,
    apply: (spec, m) => {
      const word = (m[1] ?? '').toLowerCase();
      set(spec, 'meridiem', word === 'morning' ? 'AM' : word === 'afternoon' ? 'PM' : 'EVENING');
    },
  },
  {
    re: new RegExp(`\\b(?:at\\s+(noon|midnight)|(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)|at\\s+(\\d{1,2})(?::(\\d{2}))?)${EN_END}`, 'gi'),
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

function parseEnglish(text: string, ctx: ResolveContext): ReminderCommand {
  const verb = [...text.matchAll(EN_VERB)].find((m) => !isNegated(text, m.index ?? 0, m[0].length));
  if (verb === undefined) return NOT_REMINDER;
  if (EN_PAST.test(text)) return NOT_REMINDER;

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

  const hasUnsupported = EN_UNSUPPORTED.test(text);
  for (const component of EN_COMPONENTS) {
    component.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = component.re.exec(working)) !== null) {
      if (m[0].length === 0) {
        component.re.lastIndex++;
        continue;
      }
      component.apply(spec, m);
      blank(m.index, m.index + m[0].length);
    }
  }
  if (hasUnsupported) return clarify('UNSUPPORTED_RECURRENCE');

  const hasTime = spec.relativeMs !== undefined || hasTimeOfDay(spec);
  if (!hasTime) {
    // `remind me what we discussed` is a question; `remind me tomorrow to …` is a reminder without a time.
    return hasDayInfo(spec) || spec.recurrence !== undefined ? clarify('MISSING_TIME') : NOT_REMINDER;
  }
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
