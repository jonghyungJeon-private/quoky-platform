// G6 harness: the A3a-D2 renderer. Core, not the model, writes every item label (ID plus subject) and every time:
// the model's `judge.v1` output carries ordinals and `{item:N}` / `{time:N}` / `{end:N}` placeholders only, and this
// module turns it into the reply the owner labels. Pure and deterministic.
//
// Labels (A3a-D2): calendar `M/D(요일) HH:MM–HH:MM <title>`; Jira `KEY(<summary>)`; mail `<subject> (<sender>)`;
// GitHub `<repo>#<number> <title>`; to-do `<title>`. EN cases use English weekday names and English fixed sentences;
// both arms are rendered by the same code, so the choice cannot favour an arm.
// `{time:N}` = item N's start (weekday, date and time, as A2-D3: "11월 12일(목) 10:00"); `{end:N}` = its end
// (time only when it ends on the start's local date). Time placeholders exist for calendar items only.

import { WEEKDAY_EN, WEEKDAY_KO, hhmm, isDateOnly, localParts } from './facts.mjs';

export const LABEL_TITLE_MAX = 120;
export const CAPTION_EXTRA = { ko: '함께 챙기면 좋은 점', en: 'Also worth keeping in mind' };
/** A2-D7 empty-`usedItems` sentence, reused by A3a-D2 for an empty `ranked`. */
export const EMPTY_SENTENCE = { ko: '위 내용만으로는 답하기 어려워요.', en: "I can't answer that from these items alone." };
/** A3a-D6 ③ criteria hint. */
export const CRITERIA_HINT = {
  ko: '어떤 기준으로 우선순위를 볼지(예: 마감, 외부 참석, 준비 시간) 말씀해 주시면 그 기준으로 정리해 드릴게요.',
  en: 'Tell me which criterion to use (for example the deadline, external attendees or prep time) and I will sort them by it.',
};
/** A2-D7 fallback (② hint). The listing stays above it. */
export const FALLBACK_HINT = {
  ko: '이 내용으로 답을 만들지 못했어요. 원하시는 주제를 직접 말씀해 주시면 그걸로 답해 드릴게요.',
  en: "I couldn't build an answer from this. Tell me the topic you want and I'll answer with that.",
};

const PLACEHOLDER = /\{([^{}]*)\}/g;
const VALID_PLACEHOLDER = /^(item|time|end):([1-9]\d*)$/;

function oneLine(text, max = LABEL_TITLE_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function weekdayName(parts, lang) {
  return (lang === 'en' ? WEEKDAY_EN : WEEKDAY_KO)[parts.weekday];
}

function shortDate(parts, lang) {
  return `${parts.month}/${parts.day}(${weekdayName(parts, lang)})`;
}

const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function longDate(parts, lang) {
  return lang === 'en'
    ? `${weekdayName(parts, lang)} ${MONTH_EN[parts.month - 1]} ${parts.day}`
    : `${parts.month}월 ${parts.day}일(${weekdayName(parts, lang)})`;
}

/** The last local day of an all-day item (the API end date is exclusive). */
function allDayLastParts(item) {
  const end = localParts(item.end, 'UTC');
  const last = new Date(Date.UTC(end.year, end.month - 1, end.day) - 86_400_000).toISOString().slice(0, 10);
  return localParts(last, 'UTC');
}

function senderName(from) {
  const text = String(from ?? '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(text);
  if (m && m[1].trim()) return m[1].trim();
  return text.replace(/^<|>$/g, '');
}

/** Core's item label (A3a-D2). */
export function itemLabel(source, item, { lang, timeZone }) {
  switch (source) {
    case 'calendar': {
      const title = oneLine(item.summary);
      if (isDateOnly(item.start)) {
        const s = localParts(item.start, 'UTC');
        const last = allDayLastParts(item);
        if (last.dayNumber <= s.dayNumber) return `${shortDate(s, lang)} ${lang === 'en' ? 'all day' : '종일'} ${title}`;
        return `${shortDate(s, lang)}–${shortDate(last, lang)} ${title}`;
      }
      const s = localParts(item.start, timeZone);
      const e = localParts(item.end, timeZone);
      const end = e.dayNumber === s.dayNumber ? hhmm(e) : `${shortDate(e, lang)} ${hhmm(e)}`;
      return `${shortDate(s, lang)} ${hhmm(s)}–${end} ${title}`;
    }
    case 'jira':
      return `${oneLine(item.key, 40)}(${oneLine(item.summary)})`;
    case 'mail':
      return `${oneLine(item.subject)} (${oneLine(senderName(item.from), 60)})`;
    case 'github':
      return `${oneLine(item.repo, 60)}#${item.number} ${oneLine(item.title)}`;
    case 'todo':
      return oneLine(item.title);
    default:
      throw new Error(`unknown source ${source}`);
  }
}

/** `{time:N}`: weekday, date and start time. */
export function renderTime(item, { lang, timeZone }) {
  if (isDateOnly(item.start)) return longDate(localParts(item.start, 'UTC'), lang);
  const s = localParts(item.start, timeZone);
  return `${longDate(s, lang)} ${hhmm(s)}`;
}

/** `{end:N}`: the end time, with the date only when it is not the start's local date. */
export function renderEnd(item, { lang, timeZone }) {
  if (isDateOnly(item.start)) return longDate(allDayLastParts(item), lang);
  const s = localParts(item.start, timeZone);
  const e = localParts(item.end, timeZone);
  return e.dayNumber === s.dayNumber ? hhmm(e) : `${longDate(e, lang)} ${hhmm(e)}`;
}

/**
 * Every `{…}` in `text` that is not a valid placeholder for this case: `{item:N}` for any source, `{time:N}` and
 * `{end:N}` for calendar only, N in 1..n. Returns the invalid tokens (empty = valid).
 */
export function invalidPlaceholders(text, { source, n }) {
  const bad = [];
  for (const m of String(text).matchAll(PLACEHOLDER)) {
    const v = VALID_PLACEHOLDER.exec(m[1]);
    const ordinal = v ? Number(v[2]) : 0;
    if (!v || ordinal > n || (v[1] !== 'item' && source !== 'calendar')) bad.push(m[0]);
  }
  return bad;
}

/** Text with every valid placeholder removed (what the time/date guard reads). */
export function stripValidPlaceholders(text, ctx) {
  return String(text).replace(PLACEHOLDER, (token) => (invalidPlaceholders(token, ctx).length === 0 ? ' ' : token));
}

/** Substitutes `{item:N}`, `{time:N}` and `{end:N}`. Call only on text that passed `invalidPlaceholders`. */
export function substitute(text, testCase, timeZone) {
  const ctx = { lang: testCase.lang, timeZone };
  return String(text).replace(PLACEHOLDER, (token, inner) => {
    const v = VALID_PLACEHOLDER.exec(inner);
    if (!v) throw new Error(`invalid placeholder ${token}`);
    const item = testCase.items[Number(v[2]) - 1];
    if (!item) throw new Error(`placeholder out of range ${token}`);
    if (v[1] === 'item') return itemLabel(testCase.source, item, ctx);
    if (testCase.source !== 'calendar') throw new Error(`time placeholder on ${testCase.source}`);
    return v[1] === 'time' ? renderTime(item, ctx) : renderEnd(item, ctx);
  });
}

/** The deterministic listing (item order), as the A2-D7 fallback keeps the read section. */
export function renderListing(testCase, timeZone) {
  const ctx = { lang: testCase.lang, timeZone };
  return testCase.items.map((item, i) => `${i + 1}. ${itemLabel(testCase.source, item, ctx)}`).join('\n');
}

/** The A2-D7 fallback reply. */
export function renderFallback(testCase, timeZone) {
  return `${renderListing(testCase, timeZone)}\n\n${FALLBACK_HINT[testCase.lang]}`;
}

/** The empty-`ranked` reply (A3a-D2: the fixed sentence and the ③ criteria hint). */
export function renderEmpty(testCase) {
  return `${EMPTY_SENTENCE[testCase.lang]} ${CRITERIA_HINT[testCase.lang]}`;
}

/**
 * Renders a guarded `judge.v1` output. `order` lines are numbered by rank; `pick` lines are bulleted. Each line is
 * Core's label, then " — " and the substituted `why`. `extra` goes under the fixed caption.
 */
export function renderJudge(output, testCase, timeZone) {
  if (output.ranked.length === 0) return renderEmpty(testCase);
  const ctx = { lang: testCase.lang, timeZone };
  const blocks = [];
  const intro = substitute(output.intro, testCase, timeZone).trim();
  if (intro) blocks.push(intro);
  blocks.push(
    output.ranked
      .map((entry, i) => {
        const marker = testCase.select === 'order' ? `${i + 1}.` : '-';
        const why = substitute(entry.why, testCase, timeZone).trim();
        const label = itemLabel(testCase.source, testCase.items[entry.n - 1], ctx);
        return why ? `${marker} ${label} — ${why}` : `${marker} ${label}`;
      })
      .join('\n'),
  );
  const extra = output.extra.map((e) => substitute(e, testCase, timeZone).trim()).filter(Boolean);
  if (extra.length > 0) blocks.push(`${CAPTION_EXTRA[testCase.lang]}\n${extra.map((e) => `- ${e}`).join('\n')}`);
  return blocks.join('\n\n');
}
