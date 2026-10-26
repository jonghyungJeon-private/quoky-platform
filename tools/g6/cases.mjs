// G6 harness: the held-out case-set format, its validation and the G6 coverage check (DECISIONS.md "ADR-0121 A3a
// measurement record": ≥ 30 calendar cases, ≥ 7 per other source, KO and EN, ≥ 40% `order`, ≥ 5 calendar cases with
// an overlap or back-to-back pair, ≥ 1/3 of calendar cases with name fields). Pure; no clock, no network, no model.
//
// Set file (`local-judgment-heldout.v2.json`):
//   { "version": 2, "set": "local-judgment-heldout", "timezone": "Asia/Seoul", "description": "...",
//     "cases": [ { "id", "source", "lang", "ownerRequest", "select", "count"?, "now", "items": [...] } ] }
// Item fields per source (required first; no other field is accepted, so a typo cannot pass silently):
//   calendar: summary, start, end | location, attendees (string[]), organizer, description
//             start/end both ISO date-times with offset, or both YYYY-MM-DD (all-day, end exclusive); end > start
//   mail:     from, subject, receivedAt | snippet, unread (boolean)
//   jira:     key, summary, status | priority, due, assignee, reporter
//   github:   repo, number (integer), kind ("pr" | "issue"), title | state, updatedAt, author
//   todo:     title | due, status

import { hasOverlapOrBackToBack, isDateOnly, isDateTime } from './facts.mjs';
import { COUNT_MAX, COUNT_MIN } from './schema.mjs';

export const SOURCES = ['calendar', 'mail', 'jira', 'github', 'todo'];
export const LANGS = ['ko', 'en'];
export const ITEMS_MIN = 2;
export const ITEMS_MAX = 10;

const FIELDS = {
  calendar: { required: ['summary', 'start', 'end'], optional: ['location', 'attendees', 'organizer', 'description'] },
  mail: { required: ['from', 'subject', 'receivedAt'], optional: ['snippet', 'unread'] },
  jira: { required: ['key', 'summary', 'status'], optional: ['priority', 'due', 'assignee', 'reporter'] },
  github: { required: ['repo', 'number', 'kind', 'title'], optional: ['state', 'updatedAt', 'author'] },
  todo: { required: ['title'], optional: ['due', 'status'] },
};

export const COVERAGE = {
  calendarMin: 30,
  otherSourceMin: 7,
  orderShareMin: 0.4,
  calendarOverlapOrBackToBackMin: 5,
  calendarNameFieldShareMin: 1 / 3,
};

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateItem(source, item, where) {
  const errors = [];
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return [`${where}: item must be an object`];
  const spec = FIELDS[source];
  for (const key of Object.keys(item)) {
    if (!spec.required.includes(key) && !spec.optional.includes(key)) errors.push(`${where}: unknown field ${key}`);
  }
  for (const key of spec.required) if (!(key in item)) errors.push(`${where}: missing ${key}`);
  for (const [key, value] of Object.entries(item)) {
    if (key === 'attendees') {
      if (!Array.isArray(value) || !value.every(nonEmptyString)) errors.push(`${where}: attendees must be a string array`);
    } else if (key === 'unread') {
      if (typeof value !== 'boolean') errors.push(`${where}: unread must be boolean`);
    } else if (key === 'number') {
      if (!Number.isInteger(value) || value < 1) errors.push(`${where}: number must be a positive integer`);
    } else if (!nonEmptyString(value)) {
      errors.push(`${where}: ${key} must be a non-empty string`);
    }
  }
  if (source === 'calendar' && errors.length === 0) {
    const bothTimed = isDateTime(item.start) && isDateTime(item.end);
    const bothDates = isDateOnly(item.start) && isDateOnly(item.end);
    if (!bothTimed && !bothDates) errors.push(`${where}: start/end must both be ISO date-times with offset or both YYYY-MM-DD`);
    else if (Date.parse(item.end) <= Date.parse(item.start)) errors.push(`${where}: end must be after start`);
  }
  if (source === 'github' && 'kind' in item && item.kind !== 'pr' && item.kind !== 'issue') {
    errors.push(`${where}: kind must be pr or issue`);
  }
  return errors;
}

/** Validates one case. Returns a list of problems (empty = valid). */
export function validateCase(c, index = 0) {
  const where = `cases[${index}]${c && typeof c.id === 'string' ? ` (${c.id})` : ''}`;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return [`${where}: case must be an object`];
  const errors = [];
  const allowed = ['id', 'source', 'lang', 'ownerRequest', 'select', 'count', 'now', 'items'];
  for (const key of Object.keys(c)) if (!allowed.includes(key)) errors.push(`${where}: unknown field ${key}`);
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(c.id)) errors.push(`${where}: id must match [a-z0-9][a-z0-9-]{0,40}`);
  if (!SOURCES.includes(c.source)) errors.push(`${where}: source must be one of ${SOURCES.join(', ')}`);
  if (!LANGS.includes(c.lang)) errors.push(`${where}: lang must be ko or en`);
  if (!nonEmptyString(c.ownerRequest)) errors.push(`${where}: ownerRequest must be a non-empty string`);
  if (c.select !== 'order' && c.select !== 'pick') errors.push(`${where}: select must be order or pick`);
  if ('count' in c) {
    if (c.select !== 'pick') errors.push(`${where}: count is allowed only with select pick (V11)`);
    else if (!Number.isInteger(c.count) || c.count < COUNT_MIN || c.count > COUNT_MAX) {
      errors.push(`${where}: count must be an integer ${COUNT_MIN}..${COUNT_MAX}`);
    }
  }
  if (!isDateTime(c.now)) errors.push(`${where}: now must be an ISO date-time with offset`);
  if (!Array.isArray(c.items) || c.items.length < ITEMS_MIN || c.items.length > ITEMS_MAX) {
    errors.push(`${where}: items must be an array of ${ITEMS_MIN}..${ITEMS_MAX}`);
  } else if (SOURCES.includes(c.source)) {
    c.items.forEach((item, i) => errors.push(...validateItem(c.source, item, `${where}.items[${i}]`)));
  }
  return errors;
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

/** Validates a whole set file (parsed). Returns a list of problems (empty = valid). */
export function validateSet(set) {
  if (set === null || typeof set !== 'object' || Array.isArray(set)) return ['set must be an object'];
  const errors = [];
  if (!validTimeZone(set.timezone)) errors.push('timezone must be an IANA time zone (for example Asia/Seoul)');
  if (!Array.isArray(set.cases) || set.cases.length === 0) return [...errors, 'cases must be a non-empty array'];
  set.cases.forEach((c, i) => errors.push(...validateCase(c, i)));
  const ids = set.cases.map((c) => c?.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) errors.push(`duplicate case ids: ${[...new Set(dupes)].join(', ')}`);
  return errors;
}

/** The G6 coverage numbers of a valid set, and the list of unmet minimums. */
export function coverage(set) {
  const cases = set.cases;
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, cases.filter((c) => c.source === s).length]));
  const langs = Object.fromEntries(LANGS.map((l) => [l, cases.filter((c) => c.lang === l).length]));
  const orderShare = cases.filter((c) => c.select === 'order').length / cases.length;
  const calendar = cases.filter((c) => c.source === 'calendar');
  const overlapOrB2B = calendar.filter((c) => hasOverlapOrBackToBack(c.items, c.now, set.timezone)).length;
  const nameFields = calendar.filter((c) =>
    c.items.some((it) => (Array.isArray(it.attendees) && it.attendees.length > 0) || nonEmptyString(it.organizer)),
  ).length;
  const unmet = [];
  if (bySource.calendar < COVERAGE.calendarMin) unmet.push(`calendar cases ${bySource.calendar} < ${COVERAGE.calendarMin}`);
  for (const s of SOURCES.filter((x) => x !== 'calendar')) {
    if (bySource[s] < COVERAGE.otherSourceMin) unmet.push(`${s} cases ${bySource[s]} < ${COVERAGE.otherSourceMin}`);
  }
  for (const l of LANGS) if (langs[l] === 0) unmet.push(`no ${l} case`);
  if (orderShare < COVERAGE.orderShareMin) unmet.push(`order share ${orderShare.toFixed(3)} < ${COVERAGE.orderShareMin}`);
  if (overlapOrB2B < COVERAGE.calendarOverlapOrBackToBackMin) {
    unmet.push(`calendar cases with an overlap or back-to-back pair ${overlapOrB2B} < ${COVERAGE.calendarOverlapOrBackToBackMin}`);
  }
  if (calendar.length > 0 && nameFields / calendar.length < COVERAGE.calendarNameFieldShareMin) {
    unmet.push(`calendar cases with attendees/organizer ${nameFields}/${calendar.length} < 1/3`);
  }
  return { total: cases.length, bySource, langs, orderShare, calendarOverlapOrBackToBack: overlapOrB2B, calendarNameFields: nameFields, unmet };
}

// --- the 2026-10-23 tuning set, for the LT dry run only --------------------------------------------------------
// `local-judgment-cases.v1.json` predates `select` and `now`. The dry run (format with think: true) needs only a
// valid request shape, so: judgment `prioritise` / `order` → `order`, every other judgment → `pick` (with its count);
// `now` = 09:00 local on the day before the case's earliest dated item (calendar start, mail receivedAt, or due),
// else 2026-11-01T09:00. These derived values are for the dry run only and are not G6 inputs.
export const TUNING_SET_SHA256 = 'c6bc1e7ea26c8b6af33bb4f101f1391f03fe7f015849cb7232971270857c4d60';
export const TUNING_TIMEZONE = 'Asia/Seoul';

function tuningNow(c) {
  const dates = c.items
    .flatMap((it) => [it.start, it.receivedAt, it.due, it.updatedAt])
    .filter((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
    .map((v) => v.slice(0, 10))
    .sort();
  if (dates.length === 0) return '2026-11-01T09:00:00+09:00';
  const day = new Date(`${dates[0]}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return `${day.toISOString().slice(0, 10)}T09:00:00+09:00`;
}

/** Adapts the tuning set to the case format (dry run only). */
export function adaptTuningSet(tuning) {
  return {
    version: 2,
    set: 'local-judgment-cases.v1 (dry-run adaptation)',
    timezone: TUNING_TIMEZONE,
    cases: tuning.cases.map((c) => {
      const select = c.judgment === 'prioritise' || c.judgment === 'order' ? 'order' : 'pick';
      const out = { id: c.id, source: c.source, lang: c.lang, ownerRequest: c.ownerRequest, select, now: tuningNow(c), items: c.items };
      if (select === 'pick' && Number.isInteger(c.count)) out.count = c.count;
      return out;
    }),
  };
}
