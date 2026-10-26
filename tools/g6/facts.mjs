// G6 harness: the A3a-D3 calendar relational facts (ADR-0121 A3a, DECISIONS.md "ADR-0121 A3a measurement record").
//
// Pure and deterministic: no clock read, no network, no model. Every value is computed from the items' own start/end
// and the case's `now`, in the set's time zone (QUOKY_TIMEZONE in production; the set's `timezone` here).
//
// | Fact          | Definition (A3a-D3)                                                                            |
// | duration      | minutes rounded to 5; `종일` for a one-day all-day item; multi-day as `N일`                     |
// | overlapsWith  | ordinals whose intervals strictly intersect this one (touching ends are not overlap)           |
// | backToBack    | the previous item on the same day ends 0–10 minutes before this one starts                     |
// | gapBefore     | minutes since the previous item on the same day ended; absent for the first                    |
// | relDay        | 오늘, 내일, 모레, or 이번 주/다음 주 plus weekday; otherwise `N일 뒤` (past: 어제, `N일 전`)       |
//
// Harness rules where A3a-D3 is silent (frozen with this file's hash):
// - "previous item on the same day" = among the timed items whose start falls on the same local date and that END at
//   or before this item's start, the one with the latest end (ties: lower ordinal). An item whose only earlier
//   neighbours overlap it has no gapBefore and no backToBack; the overlap is in overlapsWith.
// - All-day items (date-only start/end, end exclusive as in the Google Calendar API) take part in no interval fact
//   (overlapsWith, backToBack, gapBefore); they get duration and relDay only.
// - Weeks start on Monday.

export const BACK_TO_BACK_MAX_MINUTES = 10;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
export const WEEKDAY_EN = WEEKDAYS;

const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isDateOnly(value) {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

export function isDateTime(value) {
  return typeof value === 'string' && DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

/** Days since 1970-01-01 of a calendar date (no time zone involved). */
function dayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Local calendar parts of an ISO date-time in `timeZone`, or of a date-only string as is. */
export function localParts(value, timeZone) {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const dn = dayNumber(year, month, day);
    return { year, month, day, hour: 0, minute: 0, weekday: (((dn + 4) % 7) + 7) % 7, dayNumber: dn, allDay: true };
  }
  if (!isDateTime(value)) throw new Error(`not an ISO date-time with offset: ${value}`);
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
    dayNumber: dayNumber(year, month, day),
    allDay: false,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function hhmm(parts) {
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** Monday-based week index of a day number. */
function weekOf(dn) {
  const weekday = (((dn + 4) % 7) + 7) % 7; // 0 = Sunday
  return Math.floor((dn - ((weekday + 6) % 7)) / 7);
}

/** relDay of an item start relative to `now` (A3a-D3). */
export function relDay(start, now, timeZone) {
  const s = localParts(start, timeZone);
  const n = localParts(now, timeZone);
  const diff = s.dayNumber - n.dayNumber;
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === 2) return '모레';
  if (diff === -1) return '어제';
  if (diff < -1) return `${-diff}일 전`;
  const weekDiff = weekOf(s.dayNumber) - weekOf(n.dayNumber);
  if (weekDiff === 0) return `이번 주 ${WEEKDAY_KO[s.weekday]}요일`;
  if (weekDiff === 1) return `다음 주 ${WEEKDAY_KO[s.weekday]}요일`;
  return `${diff}일 뒤`;
}

function roundTo5(minutes) {
  if (minutes <= 0) return 0;
  return Math.max(5, Math.round(minutes / 5) * 5);
}

/** duration of one calendar item (A3a-D3): a number of minutes, `종일`, or `N일`. */
export function duration(item) {
  if (isDateOnly(item.start)) {
    const s = localParts(item.start, 'UTC');
    const e = localParts(item.end, 'UTC');
    const days = Math.max(1, e.dayNumber - s.dayNumber);
    return days === 1 ? '종일' : `${days}일`;
  }
  const minutes = (Date.parse(item.end) - Date.parse(item.start)) / 60_000;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}일`;
  return roundTo5(minutes);
}

/**
 * The A3a-D3 facts for every item of a calendar read, by ordinal (1-based, the order of `items`).
 * Returns an array aligned with `items`: `{ n, duration, overlapsWith, backToBack, gapBefore?, relDay }`.
 */
export function calendarFacts(items, now, timeZone) {
  const timed = items.map((item, i) => {
    if (isDateOnly(item.start)) return null;
    return {
      n: i + 1,
      start: Date.parse(item.start),
      end: Date.parse(item.end),
      day: localParts(item.start, timeZone).dayNumber,
    };
  });
  return items.map((item, i) => {
    const self = timed[i];
    const fact = { n: i + 1, duration: duration(item), overlapsWith: [], backToBack: false, relDay: relDay(item.start, now, timeZone) };
    if (!self) return fact;
    for (const other of timed) {
      if (!other || other.n === self.n) continue;
      if (other.start < self.end && self.start < other.end) fact.overlapsWith.push(other.n);
    }
    let previous = null;
    for (const other of timed) {
      if (!other || other.n === self.n || other.day !== self.day) continue;
      if (other.end > self.start) continue;
      if (!previous || other.end > previous.end || (other.end === previous.end && other.n < previous.n)) previous = other;
    }
    if (previous) {
      const gap = Math.round((self.start - previous.end) / 60_000);
      fact.gapBefore = gap;
      fact.backToBack = gap >= 0 && gap <= BACK_TO_BACK_MAX_MINUTES;
    }
    return fact;
  });
}

/** True when a calendar read has at least one overlap or back-to-back pair (the set's coverage check). */
export function hasOverlapOrBackToBack(items, now, timeZone) {
  return calendarFacts(items, now, timeZone).some((f) => f.overlapsWith.length > 0 || f.backToBack);
}

/** The facts block sent to the local model beside the items (STRUCTURE, LOCAL_MODEL_ONLY). One line per item. */
export function formatFactsBlock(facts) {
  return facts
    .map((f) => {
      const parts = [`relDay=${f.relDay}`, `duration=${typeof f.duration === 'number' ? `${f.duration}분` : f.duration}`];
      parts.push(`overlapsWith=[${f.overlapsWith.join(',')}]`);
      parts.push(`backToBack=${f.backToBack ? 'yes' : 'no'}`);
      if (f.gapBefore !== undefined) parts.push(`gapBefore=${f.gapBefore}분`);
      return `${f.n}: ${parts.join(' | ')}`;
    })
    .join('\n');
}
