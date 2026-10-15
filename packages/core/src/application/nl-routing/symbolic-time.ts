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
import { isNlContentWord, isNlParticleOnly } from './grammar-residual';

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

/**
 * ADR-0120 amendment A7: an open-start period that ends on a weekday the owner bounds ("금요일까지").
 * `until-fri` = today through the nearest Friday (today included, the same day `fri` names, 1-7 days); `until-next-fri` =
 * today through Friday of next (Monday-based) week (2-14 days). Core places both; the selector only names the symbol, and it validates only
 * when the owner's words carry an inclusive end bound on that weekday (`selection-validator.ts` step 4b).
 */
const UNTIL_SYMBOL = /^until-(next-)?(mon|tue|wed|thu|fri|sat|sun)$/;

/** The weekday (0 = Sunday) and week of an `until-*` symbol, or `undefined` for any other symbol. */
export function nlUntilSymbolWeekday(symbol: string): { readonly weekday: number; readonly next: boolean } | undefined {
  const match = UNTIL_SYMBOL.exec(symbol);
  return match === null ? undefined : { weekday: WEEKDAY_INDEX[match[2] as string] as number, next: match[1] !== undefined };
}

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
  const weekday = /^((?:this|next|last|until|until-next)-)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(lower);
  return weekday ? `${weekday[1] ?? ''}${FULL_WEEKDAY[weekday[2] as string]}` : lower;
}

/** Whether `symbol` is syntactically a range symbol (it may still fail to resolve: "02-30", a span over 31 days). */
export function isNlRangeSymbol(symbol: string): boolean {
  if ((NL_RANGE_SYMBOLS as readonly string[]).includes(symbol)) return true;
  if (/^(?:(?:this|next|last)-)?(?:mon|tue|wed|thu|fri|sat|sun)$/.test(symbol)) return true;
  if (UNTIL_SYMBOL.test(symbol)) return true;
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
  const until = nlUntilSymbolWeekday(symbol);
  if (until !== undefined) {
    // A7: today through the nearest such day (1..7 days), or through that day of next week (2..14 days: a Monday through
    // next week's Sunday is 14).
    const days = until.next ? Math.round(compareLocalDates(addLocalDays(monday, 7 + ((until.weekday + 6) % 7)), today) / 86_400_000) + 1 : ((until.weekday - weekdayOf(today) + 7) % 7) + 1;
    return place(today, days);
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
  // A numeric date: m/d, m-dd, or dotted m.dd with a two-digit day; a version number ("2.0", "4.2", "1.10.3") is not one.
  /^(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])$/u,
  /^(?:0?[1-9]|1[0-2])[.-](?:0[1-9]|[12]\d|3[01])\.?$/u,
  /^\d{4}[./-]\d{1,2}[./-]\d{1,2}\.?$/u,
  /^\d{1,2}월\d{1,2}일$/u,
  /^\d+(?:주|일|개월|달|년)(?:전|후|간|동안)?$/u,
  /^\d{1,2}(?:am|pm)$/u,
];
/** One particle or ending glued on a time word ("목요일은", "오후에", "내일까지"). */
const TIME_WORD_TAIL = /(?:에서|까지|부터|에는|으로|은|는|이|가|을|를|에|의|도|만|쯤|께|쯤에)$/u;

/** One word of a time expression (a weekday, relative day or week, part of day, date or clock time), particles allowed. */
export function isNlTimeWord(token: string): boolean {
  return isTimeWord(token.normalize('NFC').toLowerCase());
}

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

// ── The weekday the owner's words name (ADR-0120 A5 implementation note 2) ───────────────────────────────────────────

/** A week anchor attached to a weekday ("다음 주 수요일", "이번주 금"). */
export type NlWeekAnchor = 'last' | 'this' | 'next' | 'after-next';

/** One weekday the owner's words name. */
export interface NlWeekdayMention {
  /** 0 = Sunday … 6 = Saturday (`weekdayOf`). */
  readonly weekday: number;
  /**
   * false when the word may mean something else: the one-syllable 일 (also work, day: "다음 주 일 많아?") and a
   * one-syllable weekday followed by a content word that is not a time word or the entry's own source word ("이번 주 금
   * 시세 발표"). Core then accepts that weekday or a period without a weekday, never another single day.
   */
  readonly certain: boolean;
  /** The weekday bounds a period ("금요일까지", "수요일 부터", "by this Friday"). */
  readonly bound: boolean;
  /** An exclusive bound: the period starts the day `after` it ("수요일 이후") or ends the day `before` it ("금요일 전에"). */
  readonly boundSide?: NlBoundSide;
  /**
   * A7: the bound is an inclusive END bound ("금요일까지", "금요일 까지", "수요일날까지", "by / until / till / through Friday"),
   * the closed subset of the bound words above; 부터, from, since, ~ and the exclusive words are not.
   */
  readonly until?: true;
  /** A7: the bound is an inclusive START bound ("목요일부터", "from / since Thursday"). */
  readonly start?: true;
  /** The week anchor attached to it ("다음 주 수" = next, "this Friday" = this). */
  readonly week?: NlWeekAnchor;
  /**
   * English anchors, which never fix the Monday-based week: "next" / "last" put the day after / before today; "this" puts
   * it in the current week or the coming seven days ("this Monday" said on a Sunday is tomorrow).
   */
  readonly direction?: NlWeekdayDirection;
  /** The one-syllable form, when the owner used it. */
  readonly abbreviation?: string;
}

export type NlBoundSide = 'after' | 'before';
export type NlWeekdayDirection = 'future' | 'past' | 'this';

/** The one weekday the owner's text names (several mentions of the same weekday merged). */
export interface NlExpressedWeekday {
  readonly weekday: number;
  readonly certain: boolean;
  readonly bound: boolean;
  readonly boundSide?: NlBoundSide;
  /** A7: every mention carries an inclusive end bound ("까지", "by", "until", "till", "through"). */
  readonly until?: true;
  /**
   * A7: the mentions disagree on the end bound (some carry it, some not: "보고서는 금요일까지야, 금요일 일정 알려줘") or, with
   * an end bound, on the week word ("다음 주 금요일까지 … 금요일도"). No reading is inferred: every period is asked.
   */
  readonly boundConflict?: true;
  /** The week anchor every mention carries, when they agree. */
  readonly week?: NlWeekAnchor;
  readonly direction?: NlWeekdayDirection;
}

const KO_WEEKDAY_SYLLABLE: Readonly<Record<string, number>> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const EN_WEEKDAY_INDEX: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** The same week anchors the full weekday names already take (this, next, last, the week after next). */
const KO_WEEK_ANCHOR = '(?<![가-힣])(다다음\\s*주|다음\\s*주|담\\s*주|차주|이번\\s*주|금주|지난\\s*주|저번\\s*주)';
/** The end of a word: the end of the text, whitespace, or any punctuation or symbol ("수(오전)", "수?"). */
const WORD_END = '(?=$|\\s|[\\p{P}\\p{S}])';
/** One closed particle glued on a one-syllable weekday ("수에", "금까지"). */
const ABBREVIATION_PARTICLE = '(?:에는|에도|에만|이랑|하고|까지|부터|에|엔|은|는|도|만|쯤|랑)';
/** Joiners inside a list of one-syllable weekdays ("토, 일", "월~수", "수랑 목"). */
const ABBREVIATION_JOIN = '\\s*(?:[,·/~～-]|이랑|하고|랑|와|과)?\\s*';
/** After a weekday: a particle or word that makes it a bound of a period ("까지", " 부터", "날까지", "전에"). */
const KO_BOUND_TAIL = /^\s*(?:날\s*)?(까지|부터|전까지|이전|이후|전에|후에|~|～)/u;
/** Before an English weekday: a bound marker ("by", "through", "after"); its anchor is read with the weekday. */
const EN_BOUND_HEAD = /(?:^|\s)(until|till|by|from|since|before|after|through|thru)\s+(?:the\s+|coming\s+)?$/u;

/** The side of an exclusive bound word (이후, 후에, after; 전에, 이전, 전까지, before); inclusive words have none. */
function boundSideOf(word: string | undefined): NlBoundSide | undefined {
  if (word === undefined) return undefined;
  if (word === '이후' || word === '후에' || word === 'after') return 'after';
  if (word === '이전' || word === '전에' || word === '전까지' || word === 'before') return 'before';
  return undefined;
}

/** The inclusive end-bound words (A7): Korean 까지 and the English until, till, by, through, thru. */
const UNTIL_WORDS: ReadonlySet<string> = new Set(['까지', 'until', 'till', 'by', 'through', 'thru']);
/** The inclusive start-bound words (A7): Korean 부터 and the English from, since. */
const START_WORDS: ReadonlySet<string> = new Set(['부터', 'from', 'since']);

/** The bound of a Korean weekday from the text after it (and its glued particle). */
function koBound(particle: string | undefined, rest: string): { bound: boolean; boundSide?: NlBoundSide; until?: true; start?: true } {
  if (particle === '까지') return { bound: true, until: true };
  if (particle === '부터') return { bound: true, start: true };
  const tail = KO_BOUND_TAIL.exec(rest);
  if (tail === null) return { bound: false };
  const side = boundSideOf(tail[1]);
  return {
    bound: true,
    ...(side !== undefined ? { boundSide: side } : {}),
    ...(UNTIL_WORDS.has(tail[1] as string) ? { until: true as const } : {}),
    ...(START_WORDS.has(tail[1] as string) ? { start: true as const } : {}),
  };
}

function anchorOf(word: string | undefined): NlWeekAnchor | undefined {
  if (word === undefined) return undefined;
  const compact = word.replace(/\s+/gu, '');
  if (compact === '다다음주') return 'after-next';
  if (compact === '다음주' || compact === '담주' || compact === '차주') return 'next';
  if (compact === '이번주' || compact === '금주') return 'this';
  return 'last';
}

/**
 * Whether a one-syllable weekday is surely a weekday from what follows it: a glued particle, the end of the text, a
 * punctuation mark, another weekday, a time word ("수 오후에"), a closed function word ("수 뭐 있어") or one of the
 * entry's own source words ("수 일정", "목 메일"). Any other content word may make it a noun ("금 시세").
 */
function abbreviationIsCertain(particle: string | undefined, rest: string, sourceWords: readonly string[]): boolean {
  if (particle !== undefined && particle.length > 0) return true;
  const trimmed = rest.trimStart();
  // A parenthesised gloss is read like the next word ("수(오전)" certain, "금(골드)" uncertain); other punctuation ends it.
  if (trimmed.length === 0 || (/^[\p{P}\p{S}]/u.test(trimmed) && !trimmed.startsWith('('))) return true;
  const next = /^\(?\s*([^\s\p{P}\p{S}]+)/u.exec(trimmed)?.[1];
  if (next === undefined) return true;
  if (KO_WEEKDAY_SYLLABLE[next] !== undefined || isTimeWord(next) || !isNlContentWord(next)) return true;
  return sourceWords.some((word) => {
    const source = word.normalize('NFC').toLowerCase();
    return next === source || (next.startsWith(source) && isNlParticleOnly(next.slice(source.length)));
  });
}

/**
 * Every weekday the owner's text names. A full name counts anywhere (수요일, 수욜, 수요일날, Wednesday). A one-syllable
 * weekday (월 화 수 목 금 토 일) counts ONLY right after a week anchor (다음 주 수, 이번주 금, 지난주 월), as a word of its
 * own; elsewhere 수 is a number, 일 work or a day, 금 gold, 월 a month ("할 일", "남은 수", "3월", "1일", "금 시세").
 * `sourceWords` are the entry's own aliases (a weekday right before one of them is surely a weekday: "수 일정").
 */
export function nlWeekdayMentions(text: string, sourceWords: readonly string[] = []): NlWeekdayMention[] {
  // Zero-width and other format characters never separate a weekday from its bound ("금요일\u200b까지", A7 review).
  const source = text.normalize('NFC').replace(/\p{Cf}/gu, '').toLowerCase();
  const mentions: NlWeekdayMention[] = [];
  const full = new RegExp(`(?:${KO_WEEK_ANCHOR}\\s*)?([월화수목금토일])(?:요일|욜)`, 'gu');
  for (const match of source.matchAll(full)) {
    const end = (match.index ?? 0) + match[0].length;
    const week = anchorOf(match[1]);
    mentions.push({
      weekday: KO_WEEKDAY_SYLLABLE[match[2] as string] as number,
      certain: true,
      ...koBound(undefined, source.slice(end)),
      ...(week !== undefined ? { week } : {}),
    });
  }
  const anchored = new RegExp(`${KO_WEEK_ANCHOR}\\s+([월화수목금토일])(${ABBREVIATION_PARTICLE})?${WORD_END}`, 'gu');
  // A short parenthesised gloss may sit between list members ("수(오전), 금(오후)").
  const next = new RegExp(`(?:\\s*\\([^()]{0,20}\\))?${ABBREVIATION_JOIN}([월화수목금토일])(${ABBREVIATION_PARTICLE})?${WORD_END}`, 'uy');
  for (const match of source.matchAll(anchored)) {
    const week = anchorOf(match[1]);
    let syllable = match[2] as string;
    let particle = match[3];
    let end = (match.index ?? 0) + match[0].length;
    for (;;) {
      const rest = source.slice(end);
      mentions.push({
        weekday: KO_WEEKDAY_SYLLABLE[syllable] as number,
        certain: syllable !== '일' && abbreviationIsCertain(particle, rest, sourceWords),
        ...koBound(particle, rest),
        ...(week !== undefined ? { week } : {}),
        abbreviation: syllable,
      });
      next.lastIndex = end;
      const more = next.exec(source);
      if (more === null) break;
      syllable = more[1] as string;
      particle = more[2];
      end = next.lastIndex;
    }
  }
  const english = /\b(?:(this|next|last)\s+)?(?:(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)day|(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun))s?\b/gu;
  for (const match of source.matchAll(english)) {
    const anchor = match[1];
    // A bare three-letter form ("sun", "wed") is a weekday only with its anchor ("next wed").
    if (match[3] !== undefined && anchor === undefined) continue;
    const weekday = EN_WEEKDAY_INDEX[(match[2] ?? match[3] ?? '').slice(0, 3)];
    if (weekday === undefined) continue;
    const head = EN_BOUND_HEAD.exec(source.slice(0, match.index ?? 0));
    const side = boundSideOf(head?.[1]);
    // "next Friday" may be this coming Friday, "last Friday" this week's and "this Monday" on a Sunday tomorrow, so an
    // English anchor only fixes the direction; "the last Friday of the month" is an ordinal, not an anchor.
    const ordinal =
      anchor === 'last' &&
      /^\s+(?:of|in)\s+(?:(?:the|this|next)\s+month|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/iu.test(
        source.slice((match.index ?? 0) + match[0].length),
      );
    mentions.push({
      weekday,
      certain: true,
      bound: head !== null,
      ...(side !== undefined ? { boundSide: side } : {}),
      ...(head !== null && UNTIL_WORDS.has(head[1] as string) ? { until: true as const } : {}),
      ...(head !== null && START_WORDS.has(head[1] as string) ? { start: true as const } : {}),
      ...(ordinal || anchor === undefined ? {} : { direction: anchor === 'next' ? ('future' as const) : anchor === 'last' ? ('past' as const) : ('this' as const) }),
    });
  }
  return mentions;
}

/** The one weekday of these mentions, or `undefined` for none or several different weekdays ("토, 일", "월~수"). */
export function nlSingleWeekday(mentions: readonly NlWeekdayMention[]): NlExpressedWeekday | undefined {
  const first = mentions[0];
  if (first === undefined || mentions.some((mention) => mention.weekday !== first.weekday)) return undefined;
  const agreed = <T>(pick: (mention: NlWeekdayMention) => T): T | undefined => {
    const values = new Set(mentions.map(pick));
    return values.size === 1 ? pick(first) : undefined;
  };
  const week = agreed((mention) => mention.week);
  const direction = agreed((mention) => mention.direction);
  const boundSide = mentions.find((mention) => mention.bound)?.boundSide;
  return {
    weekday: first.weekday,
    certain: mentions.some((mention) => mention.certain),
    bound: mentions.some((mention) => mention.bound),
    ...(boundSide !== undefined ? { boundSide } : {}),
    // A7: an end bound counts only when EVERY mention of the weekday carries it ("금요일 일정 알려줘, 보고서는 금요일까지야"
    // names Friday itself, not a period up to it).
    ...(mentions.every((mention) => mention.until === true) ? { until: true as const } : {}),
    ...(mentions.some((mention) => mention.until === true) &&
    (!mentions.every((mention) => mention.until === true) || new Set(mentions.map((mention) => mention.week)).size > 1 || new Set(mentions.map((mention) => mention.direction)).size > 1)
      ? { boundConflict: true as const }
      : {}),
    ...(week !== undefined ? { week } : {}),
    ...(direction !== undefined ? { direction } : {}),
  };
}

/** The one weekday the owner's text names (see {@link nlWeekdayMentions}), or `undefined`. */
export function nlExpressedWeekday(text: string, sourceWords: readonly string[] = []): NlExpressedWeekday | undefined {
  return nlSingleWeekday(nlWeekdayMentions(text, sourceWords));
}

/**
 * Whether a resolved period keeps the weekday the owner named (`undefined`: the entry has no period). A single day must
 * be that weekday (in the anchored week, when there is one). A bound weekday must be inside the period or right next to
 * it ("수요일 이후"). A period without the weekday ("다음 주 수" read as the whole next week or as next Monday) is refused,
 * so the owner is asked instead of being shown a different day; an uncertain weekday also accepts a period without one.
 */
export function nlRangeKeepsWeekday(range: NlResolvedRange | undefined, expressed: NlExpressedWeekday, now: IsoTimestamp, timeZone: string): boolean {
  if (range === undefined) return !expressed.certain;
  const { weekStart, inWeek, named } = weekdayPlacement(expressed, now, timeZone);
  const days = Array.from({ length: range.days }, (_, index) => addLocalDays(range.startDate, index));
  const contains = days.some(named);
  if (range.days === 1) return contains;
  if (expressed.bound) {
    // Inclusive bounds (까지, 부터, by, until, through) contain the day; an exclusive one may start right after it
    // ("수요일 이후") or end right before it ("금요일 전에").
    if (contains) return true;
    if (expressed.boundSide === 'after') return named(addLocalDays(range.startDate, -1));
    if (expressed.boundSide === 'before') return named(addLocalDays(range.startDate, range.days));
    return false;
  }
  if (expressed.certain) return false;
  // An uncertain weekday accepts a period without it, but only inside the anchored week, or one that contains the day.
  return weekStart === undefined || contains || days.every(inWeek);
}

/**
 * Where the owner's weekday may fall: `inWeek` checks the anchored Monday-based week (any day without an anchor), `named`
 * a day that is that weekday, in that week and in the English direction ("next Friday" after today).
 */
function weekdayPlacement(
  expressed: NlExpressedWeekday,
  now: IsoTimestamp,
  timeZone: string,
): { readonly weekStart: LocalDate | undefined; readonly inWeek: (date: LocalDate) => boolean; readonly named: (date: LocalDate) => boolean } {
  const today = localDateOf(now, timeZone);
  const monday = addLocalDays(today, -((weekdayOf(today) + 6) % 7));
  const weekStart =
    expressed.week === undefined ? undefined : addLocalDays(monday, { last: -7, this: 0, next: 7, 'after-next': 14 }[expressed.week]);
  const inWeek = (date: LocalDate): boolean => {
    if (weekStart === undefined) return true;
    const offset = Math.round(compareLocalDates(date, weekStart) / 86_400_000);
    return offset >= 0 && offset < 7;
  };
  const inDirection = (date: LocalDate): boolean => {
    const offset = Math.round(compareLocalDates(date, today) / 86_400_000);
    if (expressed.direction === 'future') return offset > 0;
    if (expressed.direction === 'past') return offset < 0;
    if (expressed.direction === 'this') {
      const fromMonday = Math.round(compareLocalDates(date, monday) / 86_400_000);
      return (offset >= 0 && offset <= 6) || (fromMonday >= 0 && fromMonday <= 6);
    }
    return true;
  };
  return { weekStart, inWeek, named: (date) => weekdayOf(date) === expressed.weekday && inWeek(date) && inDirection(date) };
}

/** What the A7 end-bound rule does with a period: keep it, refuse it (`weekday`), or spell it as an `until-*` symbol. */
export type NlUntilBoundOutcome = 'keep' | 'refuse' | { readonly canonical: string };

/**
 * ADR-0120 amendment A7, D4 step 4b. Grounding of the open-start `until-*` symbols, and the one reading of a
 * single day at an inclusive end bound. Pure; it routes nothing: the selector chose the entry and the symbol, and the
 * only words read are the closed bound set of A5 implementation note 2 (까지, by, until, till, through, thru).
 *  - An `until-<weekday>` symbol needs the owner's words to bound THAT weekday with an inclusive end bound, and the
 *    period must end on the day those words name (their week anchor, their English direction): "이번 주 금요일까지" said
 *    on a Saturday is refused, never rolled into next week. A follow-up that names no weekday may carry the previous
 *    selection's identical symbol ("오후만" after it).
 *  - A single day that is the owner's end-bounded weekday ("금요일까지" read as `fri` or `this-fri`) would hide every day
 *    before it, so it is spelled as the `until-*` symbol that ends on the SAME day (the end never moves; the start is
 *    today, like `rest-of-month`). When no such symbol exists (a past day: "지난주 금요일까지") it is refused, so the owner
 *    is asked. An uncertain weekday ("다음 주 일까지") is left to the A5 rule.
 */
export function nlUntilBound(
  symbol: string,
  range: NlResolvedRange | undefined,
  expressed: NlExpressedWeekday | undefined,
  previousRange: string | undefined,
  now: IsoTimestamp,
  timeZone: string,
): NlUntilBoundOutcome {
  const until = nlUntilSymbolWeekday(symbol);
  if (until !== undefined) {
    if (expressed === undefined && previousRange === symbol) return 'keep';
    if (range === undefined || expressed === undefined || expressed.until !== true || expressed.boundConflict === true || !expressed.certain || expressed.weekday !== until.weekday) return 'refuse';
    if (!weekdayPlacement(expressed, now, timeZone).named(lastDayOf(range))) return 'refuse';
    // Without a week word or an English direction the weekday is the nearest one (as for the bare `fri`).
    if (expressed.week === undefined && expressed.direction === undefined) {
      const nearest = resolveNlRange(untilForms(expressed)[0] as string, now, timeZone);
      if (nearest === undefined || compareLocalDates(lastDayOf(nearest), lastDayOf(range)) !== 0) return 'refuse';
    }
    // The same span in the owner's spelling ("다음 주 수요일까지" = until-next-wed even when until-wed is the same days).
    const preferred = untilForms(expressed)[0] as string;
    const owned = preferred === symbol ? undefined : resolveNlRange(preferred, now, timeZone);
    return owned !== undefined && owned.from === range.from && owned.to === range.to ? { canonical: preferred } : 'keep';
  }
  if (expressed?.boundConflict === true) return 'refuse';
  if (range === undefined || range.upcoming === true || expressed === undefined || expressed.until !== true || !expressed.certain) return 'keep';
  const { named } = weekdayPlacement(expressed, now, timeZone);
  const days = Array.from({ length: range.days }, (_, index) => addLocalDays(range.startDate, index));
  // A single day that is another day is the A5 rule's to refuse; a longer period without the day is refused here.
  if (!days.some(named)) return range.days === 1 ? 'keep' : 'refuse';
  // Every period at an end bound is today through the bounded day: a period that holds that day (`fri`, `this-week`,
  // `next-7-days`, `last-7-days` on a Friday, a date span) is spelled as the `until-*` symbol ending on it, when that
  // symbol is itself grounded; otherwise it is refused.
  for (const candidate of untilForms(expressed)) {
    const placed = resolveNlRange(candidate, now, timeZone);
    if (placed === undefined) continue;
    const end = lastDayOf(placed);
    if (!named(end) || !days.some((day) => compareLocalDates(day, end) === 0)) continue;
    // "일요일까지" read as next week's Sunday (`next-sun` or `next-week` on a Thursday) is not the nearest Sunday the owner
    // means, so it is refused, never widened into `until-next-sun`.
    const grounded = nlUntilBound(candidate, placed, expressed, undefined, now, timeZone);
    return grounded === 'refuse' ? 'refuse' : typeof grounded === 'object' ? grounded : { canonical: candidate };
  }
  return 'refuse';
}

/**
 * ADR-0120 amendment A7: a period when the owner names SEVERAL weekdays with bounds ("목요일부터 토요일까지").
 * `undefined` when the rule does not apply (fewer than two weekdays, or no end bound); otherwise whether the period runs
 * exactly from the start-bounded weekday (when one is given) to the end-bounded weekday, each in its own week anchor and
 * direction. No symbol names such a span, so this mostly asks; it never lets an unrelated period through.
 */
export function nlMultiWeekdayBoundKeeps(range: NlResolvedRange | undefined, mentions: readonly NlWeekdayMention[], now: IsoTimestamp, timeZone: string): boolean | undefined {
  if (new Set(mentions.map((mention) => mention.weekday)).size < 2) return undefined;
  const ends = mentions.filter((mention) => mention.until === true);
  if (ends.length === 0) return undefined;
  if (range === undefined || new Set(ends.map((mention) => mention.weekday)).size > 1) return false;
  const starts = mentions.filter((mention) => mention.start === true);
  if (new Set(starts.map((mention) => mention.weekday)).size > 1) return false;
  const placed = (mention: NlWeekdayMention) => weekdayPlacement(nlSingleWeekday([mention]) as NlExpressedWeekday, now, timeZone).named;
  // A bound without a week word of its own takes the other bound's ("다음 주 월요일부터 금요일까지" = next Monday..Friday).
  const withWeek = (mention: NlWeekdayMention, other: NlWeekdayMention | undefined): NlWeekdayMention =>
    mention.week !== undefined || mention.direction !== undefined || other === undefined
      ? mention
      : { ...mention, ...(other.week !== undefined ? { week: other.week } : {}), ...(other.direction !== undefined ? { direction: other.direction } : {}) };
  const end = withWeek(ends[0] as NlWeekdayMention, starts[0]);
  const last = lastDayOf(range);
  if (!placed(end)(last)) return false;
  // Without a week word or an English direction the end is the nearest such day (today included), and the start the
  // nearest such day on or before that end: "목요일부터 토요일까지" on Thursday 10/15 is 10/15..10/17 only.
  const today = localDateOf(now, timeZone);
  const unanchored = (mention: NlWeekdayMention) => mention.week === undefined && mention.direction === undefined;
  if (unanchored(end) && compareLocalDates(last, addLocalDays(today, (end.weekday - weekdayOf(today) + 7) % 7)) !== 0) return false;
  const start = starts[0] === undefined ? undefined : withWeek(starts[0], ends[0]);
  if (start === undefined) return true;
  if (!placed(start)(range.startDate)) return false;
  return !unanchored(start) || compareLocalDates(range.startDate, addLocalDays(last, -((weekdayOf(last) - start.weekday + 7) % 7))) === 0;
}

/** The two `until-*` forms of the owner's weekday, the owner's own spelling first (다음 주 → until-next-*). */
function untilForms(expressed: NlExpressedWeekday): readonly string[] {
  const stem = NL_WEEKDAY_SYMBOLS[(expressed.weekday + 6) % 7] as string;
  return expressed.week === 'next' ? [`until-next-${stem}`, `until-${stem}`] : [`until-${stem}`, `until-next-${stem}`];
}

function lastDayOf(range: NlResolvedRange): LocalDate {
  return addLocalDays(range.startDate, range.days - 1);
}

/**
 * The canonical spelling of a weekday symbol (calendar-accuracy implementation note): `fri`, `this-fri` and `next-fri`
 * may name the same day ("금요일" said on a Wednesday is both `fri` and `this-fri`). When the selector's symbol and the
 * symbol whose week word matches the owner's own words resolve to the SAME day at the turn's clock, the owner's form is
 * kept: a Korean week anchor ("이번 주 금요일" = `this-fri`); else, for a follow-up that only names a day ("목요일 거는?"
 * after this week), the anchored form whose day lies inside the previous selection's period (`this-thu`); else the bare
 * weekday ("금요일" = `fri`). Anything else is returned unchanged: a symbol for another weekday, another day ("금요일"
 * read as `next-fri` on a Wednesday stays wrong and visible), English anchors (they fix a direction, not a week) and the
 * week after next. Never a new day, never a new symbol kind; pure.
 */
export function nlCanonicalWeekdaySymbol(
  symbol: string,
  expressed: NlExpressedWeekday | undefined,
  previousRange: string | undefined,
  now: IsoTimestamp,
  timeZone: string,
): string {
  const match = /^(?:(this|next|last)-)?(mon|tue|wed|thu|fri|sat|sun)$/.exec(symbol);
  if (match === null || expressed === undefined || WEEKDAY_INDEX[match[2] as string] !== expressed.weekday) return symbol;
  const stem = match[2] as string;
  let candidate: string | undefined;
  if (expressed.week !== undefined) candidate = expressed.week === 'after-next' ? undefined : `${expressed.week}-${stem}`;
  else if (expressed.direction === undefined) candidate = previousWeekForm(stem, previousRange, now, timeZone) ?? stem;
  if (candidate === undefined || candidate === symbol) return symbol;
  const given = resolveNlRange(symbol, now, timeZone);
  const owned = resolveNlRange(candidate, now, timeZone);
  return given !== undefined && owned !== undefined && given.from === owned.from && given.to === owned.to ? candidate : symbol;
}

/** The one anchored form of `stem` whose day lies inside the previous period (a week, a span), or `undefined`. */
function previousWeekForm(stem: string, previousRange: string | undefined, now: IsoTimestamp, timeZone: string): string | undefined {
  if (previousRange === undefined) return undefined;
  const previous = resolveNlRange(previousRange, now, timeZone);
  if (previous === undefined || previous.days < 2 || previous.upcoming === true) return undefined;
  const inside = (['this', 'next', 'last'] as const)
    .map((week) => `${week}-${stem}`)
    .filter((form) => {
      const day = resolveNlRange(form, now, timeZone);
      return day !== undefined && Date.parse(day.from) >= Date.parse(previous.from) && Date.parse(day.to) <= Date.parse(previous.to);
    });
  return inside.length === 1 ? inside[0] : undefined;
}

/**
 * Whether a title keyword really carries a title around the weekday ("수요일 스터디", "sunday school") rather than hiding
 * the period in it ("수요일 회의", "수요일 일정"): after the time words and weekday forms are removed, a content word is
 * left that is not one of the entry's own source words.
 */
export function nlKeywordIsTitle(keyword: string, weekday: number, sourceWords: readonly string[]): boolean {
  if (!nlWeekdayMentions(keyword).some((mention) => mention.weekday === weekday)) return false;
  const tokens = keyword.normalize('NFC').toLowerCase().split(/[\s\p{P}\p{S}]+/u).filter((token) => token.length > 0);
  return tokens.some((token) => {
    if (isTimeWord(token) || /^[월화수목금토일](?:요일|욜)/u.test(token) || KO_WEEKDAY_SYLLABLE[token] !== undefined) return false;
    if (!isNlContentWord(token)) return false;
    return !sourceWords.some((word) => {
      const source = word.normalize('NFC').toLowerCase();
      return token === source || (token.startsWith(source) && isNlParticleOnly(token.slice(source.length)));
    });
  });
}

/**
 * Whether a keyword holds a weekday form: a full name anywhere ("수요일", "Friday") or a one-syllable weekday as a word of
 * its own, optionally with one particle ("수", "금까지"). Used only to choose the question after a `time-keyword` refusal.
 */
export function nlKeywordHasWeekdayForm(keyword: string): boolean {
  if (nlWeekdayMentions(keyword).length > 0) return true;
  return keyword
    .normalize('NFC')
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .some((token) => KO_WEEKDAY_SYLLABLE[token] !== undefined || KO_WEEKDAY_SYLLABLE[token.replace(TIME_WORD_TAIL, '')] !== undefined);
}

/**
 * Whether every word of `keyword` is a time word, or (when the owner's text names a weekday in any form) a one-syllable
 * weekday ("수" in "다음 주 수요일 일정"): such a keyword is a period, never a title word.
 */
export function isWeekdayOrTimeKeyword(keyword: string, namesWeekday: boolean): boolean {
  if (isTimeExpression(keyword)) return true;
  if (!namesWeekday) return false;
  const tokens = keyword.normalize('NFC').toLowerCase().split(/\s+/u).filter((token) => token.length > 0);
  const syllable = (token: string): boolean => KO_WEEKDAY_SYLLABLE[token] !== undefined || KO_WEEKDAY_SYLLABLE[token.replace(TIME_WORD_TAIL, '')] !== undefined;
  return tokens.length > 0 && tokens.every((token) => isTimeWord(token) || syllable(token));
}
