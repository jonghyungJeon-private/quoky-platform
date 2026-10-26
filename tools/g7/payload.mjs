// G7 harness: the A3b payload builder (ADR-0121 A3b-D2..D4, measured by G7; DECISIONS.md "ADR-0121 A3b payload
// definition for G7"). Pure and deterministic: no clock read, no network, no model. The one model step of the pipeline
// (the A3b-D5 batched classifier) is NOT here: `prepareTitles` stops before it, `classify.mjs` builds and checks that
// call, and `finishPayload` applies its guarded result.
//
// What leaves per item (and nothing else): the payload ordinal, the coarse time (relative day, duration, the A3a-D3
// overlap and back-to-back flags; no year, month, date or clock time) and the minimized title or a fixed placeholder.
// Besides the list, the request carries only the fixed instruction, the fixed shape line and the owner's words after
// the D3 preparation (claude.mjs).
//
// Pipeline per title (A3b-D3, in this order):
//   1. NFKC. A bidi, invisible or newline character withholds the title (A2-D12).
//   2. Title-level credential guard (harness rule: the token-level guard of A2-D12 cannot see an assignment that the
//      split cuts in two, so a hit on the whole title withholds it; fail closed).
//   3. A3b-D4 pre-split removal, each span replaced by one space: `://` spans, e-mail-shaped spans, dotted spans
//      `[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+`, phone-shaped spans (≥ 7 digits).
//   4. Tokenize on whitespace and _ - / | · , . : ; ( ) [ ] { } < > " ' # ; the first 12 tokens.
//   5. A2-D12 drops, with the name fields = the UNION over all items of the read (attendees, organizer) plus the
//      owner's names (A3b-D3 [C4]).
//   6. The classifier (A3b-D5; classify.mjs) — keeps 0–4 token indices per title; [] withholds the title.
//   7. A2-D14 filter on the joined kept tokens (2–30 chars, 1–4 tokens, closed charset, no drop condition, verbatim
//      substrings, not only ordinal/stage words). Never truncated; a failure withholds the title.
// A withheld title keeps its line (ordinal and coarse time) with the placeholder.

import { calendarFacts, duration as itemDuration, isDateOnly, localParts, relDay } from '../g6/facts.mjs';
import { hasCredential } from '../g6/guards.mjs';

export const PAYLOAD_VERSION = 'g7-payload.v1';
export const TITLE_TOKEN_SCAN_MAX = 12;
export const TOPIC_TOKENS_MAX = 4;
export const TOPIC_CHARS_MIN = 2;
export const TOPIC_CHARS_MAX = 30;
export const LINE_CHARS_MAX = 80;
export const LIST_CHARS_MAX = 800;
export const LIST_ITEMS_MIN = 2;
export const LIST_ITEMS_MAX = 10;
export const WITHHELD = { ko: '(제목 생략)', en: '(title withheld)' };
export const SEP = ' · ';

// --- 1. normalization ---------------------------------------------------------------------------------------------
/** A2-D12: bidi controls, zero-width and invisible characters, BOM, soft hyphen; plus every line break. */
const REJECT_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF\u00AD\n\r\u0085\u2028\u2029]/u;

export function nfkc(text) {
  return String(text ?? '').normalize('NFKC');
}

// --- 3. A3b-D4 pre-split removal ----------------------------------------------------------------------------------
const SCHEME_SPAN = /\S*:\/\/\S*/gu;
const EMAIL_SPAN = /[^\s@]+@[^\s@]+/gu;
const DOTTED_SPAN = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
const PHONE_CANDIDATE = /\+?\(?\d[\d\s().+-]*\d/gu;
const PHONE_MIN_DIGITS = 7;

/** Removes the A3b-D4 spans whole (each replaced by one space). Returns { text, removed: string[] }. */
export function preSplitRemoval(text) {
  const removed = [];
  const cut = (re, s, keep = () => true) =>
    s.replace(re, (m) => {
      if (!keep(m)) return m;
      removed.push(m);
      return ' ';
    });
  let s = cut(SCHEME_SPAN, text);
  s = cut(EMAIL_SPAN, s);
  s = cut(DOTTED_SPAN, s);
  s = cut(PHONE_CANDIDATE, s, (m) => (m.match(/\d/g) ?? []).length >= PHONE_MIN_DIGITS);
  return { text: s, removed };
}

// --- 4. tokenization ----------------------------------------------------------------------------------------------
const SPLIT = /[\s_\-/|·,.:;()[\]{}<>"'#]+/u;

export function tokenize(text) {
  return text.split(SPLIT).filter(Boolean).slice(0, TITLE_TOKEN_SCAN_MAX);
}

// --- 5. name fields (union) and the A2-D12 drops -------------------------------------------------------------------
const HANGUL_SYLLABLE = /[가-힣]/u;
const HANGUL_RUN = /[가-힣]+/gu;
const EMAIL_LOCAL = /([^\s<>@"']+)@[^\s<>@"']+/gu;

/** Display part of a name-field string: the text before `<…>` when present, else the whole string. */
function displayPart(value) {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/u.exec(value);
  return m ? m[1] : value;
}

/**
 * The name-field index of one read (A3b-D3 [C4]): every item's attendees and organizer, plus the owner's names.
 * Returns { hangulBigrams: Set, latinParts: Set } — Hangul 2-syllable sequences, and case-folded Latin name parts of
 * ≥ 3 letters from display names and e-mail local parts split on `.`, `_`, `-` and whitespace (A2-D12).
 */
export function nameFieldIndex(items, ownerNames = []) {
  const fields = [];
  for (const item of items) {
    if (Array.isArray(item.attendees)) fields.push(...item.attendees);
    if (typeof item.organizer === 'string') fields.push(item.organizer);
  }
  fields.push(...ownerNames);
  const hangulBigrams = new Set();
  const latinParts = new Set();
  for (const raw of fields) {
    const value = nfkc(raw);
    for (const run of value.match(HANGUL_RUN) ?? []) {
      const chars = [...run];
      for (let i = 0; i + 1 < chars.length; i += 1) hangulBigrams.add(chars[i] + chars[i + 1]);
    }
    const sources = [displayPart(value), ...[...value.matchAll(EMAIL_LOCAL)].map((m) => m[1])];
    if (!value.includes('<') && /^[^\s@]+@[^\s@]+$/u.test(value.trim())) sources.push(value.trim().split('@')[0]);
    for (const src of sources) {
      for (const part of src.split(/[._\-\s]+/u)) {
        const folded = part.toLowerCase();
        if (/^[a-z]{3,}$/u.test(folded)) latinParts.add(folded);
      }
    }
  }
  return { hangulBigrams, latinParts };
}

const LATIN = /[A-Za-z]/u;
const CYRILLIC_OR_GREEK = /[Ͱ-Ͽἀ-῿Ѐ-ԯ]/u;
const DIGIT_RUN_3 = /\d{3,}/u;
const URL_OR_PHONE_SHAPE = /@|:\/\/|www\.|^\+?\d[\d-]{6,}$/iu;
export const LATIN_TOKEN_MAX = 20;

/** The A2-D12 drop reason of one token, or null when it survives. */
export function dropReason(token, index) {
  if (HANGUL_SYLLABLE.test(token)) {
    const chars = [...token];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      if (index.hangulBigrams.has(chars[i] + chars[i + 1])) return 'name-hangul';
    }
  }
  const folded = token.toLowerCase();
  for (const part of index.latinParts) if (folded.includes(part)) return 'name-latin';
  if (URL_OR_PHONE_SHAPE.test(token)) return 'url-or-phone';
  if (DIGIT_RUN_3.test(token)) return 'digit-run';
  if (LATIN.test(token) && CYRILLIC_OR_GREEK.test(token)) return 'mixed-script';
  if (LATIN.test(token) && [...token].length > LATIN_TOKEN_MAX) return 'long-latin';
  if (hasCredential(token)) return 'credential';
  return null;
}

// --- 7. A2-D14 topic filter ----------------------------------------------------------------------------------------
/** Hangul syllables, Latin letters, digits, space, `-` and `.` (A2-D14). */
const TOPIC_CHARSET = /^[가-힣A-Za-z0-9 .-]+$/u;
/** A token that is only an ordinal or a stage word ("1차" alone is not a topic; A2-D14). */
export const ORDINAL_OR_STAGE =
  /^(?:\d{1,2}(?:차|번째|번|회차|회|단계|부|기|라운드|주차)|\d{1,2}(?:st|nd|rd|th)|first|second|third|final|round|stage|phase|최종|예선|본선|결선|중간|사전|초기)$/iu;

/** Checks a candidate topic built from kept tokens. Returns null when it passes, else the failed rule. */
export function topicFilter(tokens, nfkcTitle, index) {
  if (tokens.length < 1 || tokens.length > TOPIC_TOKENS_MAX) return 'token-count';
  const topic = tokens.join(' ');
  const chars = [...topic].length;
  if (chars < TOPIC_CHARS_MIN || chars > TOPIC_CHARS_MAX) return 'char-count';
  if (!TOPIC_CHARSET.test(topic)) return 'charset';
  for (const t of tokens) {
    if (dropReason(t, index) !== null) return 'drop-condition';
    if (!nfkcTitle.includes(t)) return 'not-verbatim';
  }
  if (tokens.every((t) => ORDINAL_OR_STAGE.test(t))) return 'ordinal-or-stage-only';
  return null;
}

// --- coarse time (A3b-D2 [W1]) -------------------------------------------------------------------------------------
const WEEKDAY_EN_LONG = { 일: 'Sunday', 월: 'Monday', 화: 'Tuesday', 수: 'Wednesday', 목: 'Thursday', 금: 'Friday', 토: 'Saturday' };

/** The relative day in the case language. KO is A3a-D3 `relDay` verbatim; EN is its fixed equivalent. */
export function relDayText(start, now, timeZone, lang) {
  const ko = relDay(start, now, timeZone);
  if (lang !== 'en') return ko;
  if (ko === '오늘') return 'today';
  if (ko === '내일') return 'tomorrow';
  if (ko === '모레') return 'in 2 days';
  if (ko === '어제') return 'yesterday';
  let m = /^(\d+)일 전$/u.exec(ko);
  if (m) return `${m[1]} days ago`;
  m = /^(\d+)일 뒤$/u.exec(ko);
  if (m) return `in ${m[1]} days`;
  m = /^(이번|다음) 주 (.)요일$/u.exec(ko);
  if (m) return `${m[1] === '이번' ? 'this' : 'next'} ${WEEKDAY_EN_LONG[m[2]]}`;
  throw new Error(`no EN form for relDay ${ko}`);
}

/** Duration rounded to 5 minutes (A3a-D3 `duration`), rendered: `1시간 30분` / `종일` / `N일간` (EN `1 h 30 min`). */
export function durationText(item, lang) {
  const d = itemDuration(item);
  if (d === '종일') return lang === 'en' ? 'all day' : '종일';
  if (typeof d === 'string') {
    const days = Number(d.replace('일', ''));
    return lang === 'en' ? `${days} days` : `${days}일간`;
  }
  const h = Math.floor(d / 60);
  const m = d % 60;
  if (lang === 'en') return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
  return h === 0 ? `${m}분` : m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** The A3a-D3 flags of one payload line (ordinals in payload order). */
export function flagTexts(fact, lang) {
  const flags = [];
  if (fact.overlapsWith.length > 0) {
    const list = fact.overlapsWith.join(', ');
    flags.push(lang === 'en' ? `overlaps ${list}` : `${list}번과 겹침`);
  }
  if (fact.backToBack) flags.push(lang === 'en' ? 'right after the previous event' : '앞 일정에 바로 이어짐');
  return flags;
}

// --- order ---------------------------------------------------------------------------------------------------------
/**
 * The payload order (A3b-D2: sorted by start time). Key: the local start date in the time zone, then all-day items
 * before timed ones, then the start instant, then the original index. Returns `perm` with perm[p-1] = the case index
 * of payload ordinal p.
 */
export function payloadOrder(items, timeZone) {
  const keyed = items.map((item, i) => {
    const allDay = isDateOnly(item.start);
    const day = allDay ? localParts(item.start, 'UTC').dayNumber : localParts(item.start, timeZone).dayNumber;
    return { i, day, allDay: allDay ? 0 : 1, t: allDay ? 0 : Date.parse(item.start) };
  });
  keyed.sort((a, b) => a.day - b.day || a.allDay - b.allDay || a.t - b.t || a.i - b.i);
  return keyed.map((k) => k.i);
}

// --- the owner's words (ADR-0121 D3 preparation) ---------------------------------------------------------------------
/**
 * The owner's words as sent: fenced blocks and quoted lines (`>`) removed, trimmed. A credential-guard hit means no
 * offer (the pre-egress guard). Returns { ok, text } or { ok: false, reason }.
 */
export function prepareOwnerWords(text) {
  const withoutFences = String(text ?? '').replace(/```[\s\S]*?```/gu, ' ');
  const kept = withoutFences
    .split('\n')
    .filter((line) => !/^\s*>/u.test(line))
    .join('\n')
    .trim();
  if (!kept) return { ok: false, reason: 'owner-words-empty' };
  if (hasCredential(kept)) return { ok: false, reason: 'owner-words-credential' };
  return { ok: true, text: kept };
}

// --- the deterministic stage (before the classifier) ------------------------------------------------------------------
/**
 * Steps 1–5 for every title of one case, in payload order. Returns
 *   { perm, facts, index, titles: [{ p, nfkc, tokens, withheld: null | reason, drops: {code: n} }] }
 * where `tokens` are the survivors that go to the classifier (empty when withheld).
 */
export function prepareTitles(testCase, timeZone, ownerNames) {
  const perm = payloadOrder(testCase.items, timeZone);
  const ordered = perm.map((i) => testCase.items[i]);
  const facts = calendarFacts(ordered, testCase.now, timeZone);
  const index = nameFieldIndex(testCase.items, ownerNames);
  const titles = ordered.map((item, k) => {
    const entry = { p: k + 1, nfkc: nfkc(item.summary), tokens: [], withheld: null, drops: {} };
    if (REJECT_CHARS.test(entry.nfkc)) return { ...entry, withheld: 'invisible-or-newline' };
    if (hasCredential(entry.nfkc)) return { ...entry, withheld: 'title-credential' };
    const { text } = preSplitRemoval(entry.nfkc);
    for (const token of tokenize(text)) {
      const reason = dropReason(token, index);
      if (reason) entry.drops[reason] = (entry.drops[reason] ?? 0) + 1;
      else entry.tokens.push(token);
    }
    if (entry.tokens.length === 0) entry.withheld = 'no-token-left';
    return entry;
  });
  return { perm, facts, index, titles };
}

/**
 * Steps 6–7 and the list. `keep` is the classifier's guarded result for the titles sent (classify.mjs
 * `checkKeep`), aligned with `sent` (the payload ordinals sent, in order), or null when the call failed or was not
 * needed — a failure withholds every title that was sent (fail closed, no retry).
 * Returns { offer: true, lines, list, chars, withheld, titles } or { offer: false, reason, ... }.
 */
export function finishPayload({ testCase, timeZone, prepared, sent, keep }) {
  const lang = testCase.lang;
  const keepByP = new Map();
  if (keep) sent.forEach((p, j) => keepByP.set(p, keep[j]));
  const titles = prepared.titles.map((t) => {
    if (t.withheld) return { p: t.p, title: null, withheld: t.withheld };
    if (!keep) return { p: t.p, title: null, withheld: 'classifier-failed' };
    const indices = keepByP.get(t.p) ?? [];
    if (indices.length === 0) return { p: t.p, title: null, withheld: 'classifier-dropped' };
    const kept = indices.map((i) => t.tokens[i - 1]);
    const fail = topicFilter(kept, t.nfkc, prepared.index);
    if (fail) return { p: t.p, title: null, withheld: `filter-${fail}` };
    return { p: t.p, title: kept.join(' '), withheld: null };
  });
  const n = titles.length;
  if (n < LIST_ITEMS_MIN || n > LIST_ITEMS_MAX) {
    return { offer: false, reason: 'item-count', titles, withheld: titles.filter((t) => t.withheld).length };
  }
  const lines = [];
  for (const t of titles) {
    const item = testCase.items[prepared.perm[t.p - 1]];
    const fact = prepared.facts[t.p - 1];
    const head = [relDayText(item.start, testCase.now, timeZone, lang), durationText(item, lang), ...flagTexts(fact, lang)].join(SEP);
    let line = `${t.p}. ${head}${SEP}${t.title ?? WITHHELD[lang]}`;
    if ([...line].length > LINE_CHARS_MAX && t.title !== null) {
      t.withheld = 'line-too-long';
      t.title = null;
      line = `${t.p}. ${head}${SEP}${WITHHELD[lang]}`;
    }
    if ([...line].length > LINE_CHARS_MAX) {
      return { offer: false, reason: 'line-too-long', titles, withheld: titles.filter((x) => x.withheld).length };
    }
    lines.push(line);
  }
  const withheld = titles.filter((t) => t.withheld).length;
  if (withheld === n) return { offer: false, reason: 'every-title-withheld', titles, withheld };
  const list = lines.join('\n');
  if ([...list].length > LIST_CHARS_MAX) return { offer: false, reason: 'list-too-long', titles, withheld };
  return { offer: true, lines, list, chars: [...list].length, titles, withheld };
}
