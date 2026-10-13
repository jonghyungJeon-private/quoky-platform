import type { IsoTimestamp } from '../../domain';
import {
  addLocalDays,
  compareLocalDates,
  daysInMonth,
  isValidLocalDate,
  isValidTimeZone,
  localDateOf,
  weekdayOf,
  zonedToUtcIso,
  type LocalDate,
} from '../reminders/zoned-time';

/**
 * Symbolic time for natural-language selection (ADR-0120 D4 step 4). The selector names a period with a closed symbol
 * (`today`, `this-week`, `10-20`, `2026-10-01..2026-10-07`); Core alone resolves it with the turn's clock and
 * `QUOKY_TIMEZONE`. The model never computes a timestamp: a date it names is the owner's own (`MM-DD` or
 * `YYYY-MM-DD`), and every relative period is placed here. Pure: `now` and the zone are inputs.
 */

/** The relative period symbols, in prompt order. */
export const NL_RANGE_SYMBOLS = [
  'today',
  'yesterday',
  'tomorrow',
  'day-after-tomorrow',
  'this-week',
  'last-week',
  'next-week',
  'this-weekend',
  'next-weekend',
  /** The week after next (다다음 주). */
  'week-after-next',
  'this-month',
  'last-month',
  /** From today to the last day of this month ("이번 달 말까지"). */
  'rest-of-month',
  'last-7-days',
  'next-7-days',
  /** From now to the end of the lookahead (the next event); calendar only. */
  'upcoming',
] as const;
export type NlRangeSymbol = (typeof NL_RANGE_SYMBOLS)[number];

/**
 * Weekday symbols: `mon` = the nearest such day from today (today included); `this-mon` = that day of the current
 * Monday-based week; `next-mon` / `last-mon` = that day of next / last week.
 */
export const NL_WEEKDAY_SYMBOLS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** ADR-0120 D4 step 3: a date span of at most 31 days. */
export const NL_RANGE_MAX_DAYS = 31;
/** The lookahead of `upcoming` (the calendar's next-event window). */
export const NL_UPCOMING_LOOKAHEAD_DAYS = 14;

/** A period placed on the owner's calendar: local dates `[startDate, startDate + days)`, instants `[from, to)`. */
export interface NlResolvedRange {
  readonly symbol: string;
  readonly startDate: LocalDate;
  readonly days: number;
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  /** `upcoming` only: the window starts now, not at midnight. */
  readonly upcoming?: true;
  /** A relative day (`today` 0, `yesterday` -1, `tomorrow` 1, …); undefined for any other symbol. */
  readonly dayOffset?: number;
}

const DATE = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const WEEKDAY_INDEX: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FULL_WEEKDAY: Readonly<Record<string, string>> = {
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
};

/**
 * The closed spelling of a symbol: lower-case, and a full English weekday name in its three-letter form ("friday" →
 * "fri", "next-monday" → "next-mon"). Anything else is returned unchanged (and may then fail validation).
 */
export function normalizeNlRangeSymbol(symbol: string): string {
  const lower = symbol.trim().toLowerCase();
  const weekday = /^((?:this|next|last)-)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(lower);
  return weekday ? `${weekday[1] ?? ''}${FULL_WEEKDAY[weekday[2] as string]}` : lower;
}

/** Whether `symbol` is syntactically a range symbol (it may still fail to resolve: "02-30", a span over 31 days). */
export function isNlRangeSymbol(symbol: string): boolean {
  if ((NL_RANGE_SYMBOLS as readonly string[]).includes(symbol)) return true;
  if (/^(?:(?:this|next|last)-)?(?:mon|tue|wed|thu|fri|sat|sun)$/.test(symbol)) return true;
  const parts = symbol.split('..');
  if (parts.length > 2) return false;
  return parts.every((part) => DATE.test(part));
}

/**
 * Resolve a symbol in `timeZone` as seen from `now`. `undefined` for an unknown symbol, a date that does not exist, a
 * reversed range or a span over {@link NL_RANGE_MAX_DAYS} days.
 */
export function resolveNlRange(symbol: string, now: IsoTimestamp, timeZone: string): NlResolvedRange | undefined {
  if (!isValidTimeZone(timeZone) || symbol.length > 40) return undefined;
  const today = localDateOf(now, timeZone);
  const place = (startDate: LocalDate, days: number, extra: { dayOffset?: number } = {}): NlResolvedRange | undefined => {
    if (!isValidLocalDate(startDate) || !Number.isInteger(days) || days < 1 || days > NL_RANGE_MAX_DAYS) return undefined;
    return {
      symbol,
      startDate,
      days,
      from: midnight(startDate, timeZone),
      to: midnight(addLocalDays(startDate, days), timeZone),
      ...extra,
    };
  };
  const monday = addLocalDays(today, -((weekdayOf(today) + 6) % 7));
  switch (symbol) {
    case 'today':
      return place(today, 1, { dayOffset: 0 });
    case 'yesterday':
      return place(addLocalDays(today, -1), 1, { dayOffset: -1 });
    case 'tomorrow':
      return place(addLocalDays(today, 1), 1, { dayOffset: 1 });
    case 'day-after-tomorrow':
      return place(addLocalDays(today, 2), 1, { dayOffset: 2 });
    case 'this-week':
      return place(monday, 7);
    case 'last-week':
      return place(addLocalDays(monday, -7), 7);
    case 'next-week':
      return place(addLocalDays(monday, 7), 7);
    case 'this-weekend':
      return place(addLocalDays(monday, 5), 2);
    case 'next-weekend':
      return place(addLocalDays(monday, 12), 2);
    case 'week-after-next':
      return place(addLocalDays(monday, 14), 7);
    case 'rest-of-month':
      return place(today, daysInMonth(today.year, today.month) - today.day + 1);
    case 'this-month':
      return place({ ...today, day: 1 }, daysInMonth(today.year, today.month));
    case 'last-month': {
      const first = addLocalDays({ ...today, day: 1 }, -1);
      return place({ ...first, day: 1 }, daysInMonth(first.year, first.month));
    }
    case 'last-7-days':
      return place(addLocalDays(today, -6), 7);
    case 'next-7-days':
      return place(today, 7);
    case 'upcoming': {
      const placed = place(today, NL_UPCOMING_LOOKAHEAD_DAYS);
      return placed === undefined ? undefined : { ...placed, from: new Date(Date.parse(now)).toISOString(), upcoming: true };
    }
    default:
      break;
  }
  const weekday = /^(?:(this|next|last)-)?(mon|tue|wed|thu|fri|sat|sun)$/.exec(symbol);
  if (weekday) {
    const index = WEEKDAY_INDEX[weekday[2] as string] as number;
    if (weekday[1] === undefined) return place(addLocalDays(today, (index - weekdayOf(today) + 7) % 7), 1);
    const weekStart = weekday[1] === 'next' ? addLocalDays(monday, 7) : weekday[1] === 'last' ? addLocalDays(monday, -7) : monday;
    return place(addLocalDays(weekStart, (index + 6) % 7), 1);
  }
  const parts = symbol.split('..');
  if (parts.length > 2) return undefined;
  const dates = parts.map((part) => dateOf(part, today));
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return undefined;
  // A range whose end has no year and falls before its start runs into the next year ("12-28..01-03").
  let end = last;
  if (parts.length === 2 && !/^\d{4}-/.test(parts[1] as string) && compareLocalDates(end, first) < 0) {
    end = { ...end, year: end.year + 1 };
    if (!isValidLocalDate(end)) return undefined;
  }
  const span = Math.round(compareLocalDates(end, first) / 86_400_000) + 1;
  if (span < 1) return undefined;
  return place(first, span);
}

/** A `MM-DD` (the occurrence nearest to today) or `YYYY-MM-DD` date, or `undefined`. */
function dateOf(part: string, today: LocalDate): LocalDate | undefined {
  const match = DATE.exec(part);
  if (!match) return undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (match[1] !== undefined) {
    const date = { year: Number(match[1]), month, day };
    return isValidLocalDate(date) ? date : undefined;
  }
  let best: LocalDate | undefined;
  for (const year of [today.year - 1, today.year, today.year + 1]) {
    const candidate = { year, month, day };
    if (!isValidLocalDate(candidate)) continue;
    if (best === undefined || Math.abs(compareLocalDates(candidate, today)) < Math.abs(compareLocalDates(best, today))) {
      best = candidate;
    }
  }
  return best;
}

function midnight(date: LocalDate, timeZone: string): IsoTimestamp {
  return zonedToUtcIso({ ...date, hour: 0, minute: 0 }, timeZone);
}

/** `YYYY-MM-DD` of a local date. */
export function isoDateOf(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

const KO_SYMBOL_LABEL: Readonly<Record<string, string>> = {
  today: '오늘',
  yesterday: '어제',
  tomorrow: '내일',
  'day-after-tomorrow': '모레',
  'this-week': '이번 주',
  'last-week': '지난주',
  'next-week': '다음 주',
  'this-weekend': '이번 주말',
  'next-weekend': '다음 주말',
  'week-after-next': '다다음 주',
  'this-month': '이번 달',
  'last-month': '지난달',
  'rest-of-month': '이번 달 말까지',
  'last-7-days': '최근 7일',
  'next-7-days': '앞으로 7일',
  upcoming: '다가오는 일정',
};
const EN_SYMBOL_LABEL: Readonly<Record<string, string>> = {
  today: 'today',
  yesterday: 'yesterday',
  tomorrow: 'tomorrow',
  'day-after-tomorrow': 'the day after tomorrow',
  'this-week': 'this week',
  'last-week': 'last week',
  'next-week': 'next week',
  'this-weekend': 'this weekend',
  'next-weekend': 'next weekend',
  'week-after-next': 'the week after next',
  'this-month': 'this month',
  'last-month': 'last month',
  'rest-of-month': 'until the end of this month',
  'last-7-days': 'the last 7 days',
  'next-7-days': 'the next 7 days',
  upcoming: 'upcoming',
};

/** The owner-facing name of a resolved period ("오늘", "10월 20일", "10월 1일~10월 7일"). */
export function nlRangeLabel(range: NlResolvedRange, language: 'ko' | 'en'): string {
  const named = (language === 'en' ? EN_SYMBOL_LABEL : KO_SYMBOL_LABEL)[range.symbol];
  if (named !== undefined) return named;
  const day = (date: LocalDate) => (language === 'en' ? isoDateOf(date) : `${date.month}월 ${date.day}일`);
  if (range.days === 1) return day(range.startDate);
  return `${day(range.startDate)}~${day(addLocalDays(range.startDate, range.days - 1))}`;
}

/**
 * Words a time expression is made of (weekday, relative day or week, part of day, date or clock time). Validation of
 * ARG VALUES only (never routing): a keyword made of nothing but these is a period, which belongs in `range` or
 * `partOfDay`, never in a title or sender filter (live UAT R4: "목요일 거는?" must not become the keyword "목요일").
 */
const TIME_WORD_PATTERNS: readonly RegExp[] = [
  /^(?:월|화|수|목|금|토|일)요일$/u,
  /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday|rsday)?s?$/u,
  /^(?:오늘|어제|내일|모레|글피|그저께|그제|엊그제|이번|지난|저번|다음|다다음|금주|차주|담주|주말|평일|이번주|지난주|다음주|다다음주|이번달|지난달|다음달|월말|말일|연말|올해|작년|내년|오전|오후|아침|저녁|밤|낮|새벽|주|달|하루|종일|말|초|중순|하순|상순)$/u,
  /^(?:today|yesterday|tomorrow|tonight|morning|afternoon|evening|night|noon|week|weekend|weekday|month|year|next|last|this|past|recent|upcoming|day|days|weeks|months)$/u,
  /^\d{1,2}월$/u,
  /^\d{1,2}일$/u,
  /^\d{1,2}시(?:\d{1,2}분)?(?:반)?$/u,
  /^\d{1,2}:\d{2}$/u,
  /^\d{1,2}[/.-]\d{1,2}$/u,
  /^\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?$/u,
  /^\d{1,2}월\d{1,2}일$/u,
  /^\d+(?:주|일|개월|달|년)(?:전|후|간|동안)?$/u,
  /^\d{1,2}(?:am|pm)$/u,
];
/** One particle or ending glued on a time word ("목요일은", "오후에", "내일까지"). */
const TIME_WORD_TAIL = /(?:에서|까지|부터|에는|으로|은|는|이|가|을|를|에|의|도|만|쯤|께|쯤에)$/u;

function isTimeWord(token: string): boolean {
  if (token.length === 0) return false;
  if (TIME_WORD_PATTERNS.some((pattern) => pattern.test(token))) return true;
  const stripped = token.replace(TIME_WORD_TAIL, '');
  return stripped !== token && stripped.length > 0 && TIME_WORD_PATTERNS.some((pattern) => pattern.test(stripped));
}

/** Whether every word of `text` is a time word (a weekday, date, relative period or part of day). */
export function isTimeExpression(text: string): boolean {
  const tokens = text.normalize('NFC').toLowerCase().replace(/(?<!\d)[,.;!?~]|[,.;!?~](?!\d)/gu, ' ').split(/\s+/u).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every(isTimeWord);
}
