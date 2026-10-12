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
  'this-month',
  'last-month',
  'last-7-days',
  'next-7-days',
  /** From now to the end of the lookahead (the next event); calendar only. */
  'upcoming',
] as const;
export type NlRangeSymbol = (typeof NL_RANGE_SYMBOLS)[number];

/** Weekday symbols: `mon` = the nearest Monday from today (today included); `next-mon` = Monday of next week. */
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
  const weekday = /^(next-)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(lower);
  return weekday ? `${weekday[1] ?? ''}${FULL_WEEKDAY[weekday[2] as string]}` : lower;
}

/** Whether `symbol` is syntactically a range symbol (it may still fail to resolve: "02-30", a span over 31 days). */
export function isNlRangeSymbol(symbol: string): boolean {
  if ((NL_RANGE_SYMBOLS as readonly string[]).includes(symbol)) return true;
  if (/^(?:next-)?(?:mon|tue|wed|thu|fri|sat|sun)$/.test(symbol)) return true;
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
  const weekday = /^(next-)?(mon|tue|wed|thu|fri|sat|sun)$/.exec(symbol);
  if (weekday) {
    const index = WEEKDAY_INDEX[weekday[2] as string] as number;
    if (weekday[1] === undefined) return place(addLocalDays(today, (index - weekdayOf(today) + 7) % 7), 1);
    return place(addLocalDays(monday, 7 + ((index + 6) % 7)), 1);
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
  'this-month': '이번 달',
  'last-month': '지난달',
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
  'this-month': 'this month',
  'last-month': 'last month',
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
