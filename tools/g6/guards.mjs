// G6 harness: the A2-D7 guards as amended by A3a-D2, applied to one raw `judge.v1` output. Pure and deterministic.
//
// Order (A2-D7 order, plus the A3a checks):
//   1. strict-parse    JSON object with exactly intro (string), ranked ([{n: integer, why: string}]), extra (string[]);
//                      no extra keys, no prose
//   2. empty ranked    not a failure: the fixed sentence and the ③ criteria hint are shown (renderEmpty)
//   3. ordinal-range / ordinal-unique / select-shape (schema.mjs checkOrdinals; ranked = N | min(count, N) | 1..N)
//   4. url             no URL, `www.`-shaped token, domain-shaped token or e-mail address in any model text
//   5. credential      the ADR-0097 credential guard (a replica of packages/core/src/application/credential-guard.ts
//                      containsCredentialMaterial: keyword assignments, vendor token shapes, card numbers, NFKC view)
//   6. placeholder     every `{…}` is `{item:N}` (any source) or `{time:N}` / `{end:N}` (calendar), N in 1..N
//   7. time-date       the A2-D3 guard on all model text after removing valid placeholders
//   8. length          intro ≤ 150 chars and ≤ 2 lines; why ≤ 200 chars, 1 line; extra ≤ 3 entries, each ≤ 150, 1 line
// A failed check gets one retry with a fixed corrective instruction that names the check, never the content
// (CORRECTIONS); a second failure gives the A2-D7 fallback.

import { checkOrdinals, EXTRA_MAX, EXTRA_MAX_ITEMS, INTRO_MAX, WHY_MAX } from './schema.mjs';
import { invalidPlaceholders, stripValidPlaceholders } from './render.mjs';

export const CHECKS = [
  'strict-parse',
  'ordinal-range',
  'ordinal-unique',
  'select-shape',
  'url',
  'credential',
  'placeholder',
  'time-date',
  'length',
];

/** Fixed corrective instruction per failed check (names the check, never the content). */
export const CORRECTIONS = {
  'strict-parse': '직전 출력이 형식 검사를 통과하지 못했습니다. intro, ranked, extra 세 필드만 있는 JSON 한 개로 다시 쓰세요.',
  'ordinal-range': '직전 출력이 항목 번호 검사를 통과하지 못했습니다. n에는 주어진 항목 번호만 쓰세요.',
  'ordinal-unique': '직전 출력이 항목 번호 중복 검사를 통과하지 못했습니다. ranked에서 같은 항목 번호를 두 번 쓰지 마세요.',
  'select-shape': '직전 출력이 개수 검사를 통과하지 못했습니다. 요청 형식이 정한 개수만큼 ranked에 넣으세요.',
  url: '직전 출력이 링크 검사를 통과하지 못했습니다. URL, 도메인, 이메일 주소를 쓰지 마세요.',
  credential: '직전 출력이 비밀 정보 검사를 통과하지 못했습니다. 비밀번호, 키, 토큰 같은 값을 쓰지 마세요.',
  placeholder: '직전 출력이 자리표시자 검사를 통과하지 못했습니다. {item:번호}, 일정이면 {time:번호}, {end:번호}만 쓰세요.',
  'time-date': '직전 출력이 시각·날짜 검사를 통과하지 못했습니다. 시각이나 날짜를 숫자로 쓰지 말고 {time:번호}, {end:번호}를 쓰세요.',
  length: '직전 출력이 길이 검사를 통과하지 못했습니다. intro는 150자·2줄, why는 200자·1줄, extra는 3개·각 150자·1줄 이내로 쓰세요.',
};

// --- 4. URL -----------------------------------------------------------------------------------------------------
const URL_SHAPED = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|io|dev|app|co|kr|jp|cn|uk|de|test|ai|me|ly|gg|info|biz|xyz|site|link)\b/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
];

export function hasUrl(text) {
  return URL_SHAPED.some((re) => re.test(text));
}

// --- 5. Credential (replica of the ADR-0097 chat-text detector) -------------------------------------------------
const KO_KEYWORD =
  '(?:비밀\\s?번호|패스워드|비번|인증\\s?번호|OTP|PIN|핀\\s?번호|카드\\s?번호|계좌\\s?비밀번호|API\\s?키|액세스\\s?키|토큰|시크릿|비밀\\s?키|개인\\s?키|암호)';
const EN_KEYWORD =
  '(?:password|passwd|pwd|passcode|pass\\s?phrase|pin(?:\\s?(?:code|number))?|otp|card\\s?number|api[\\s_-]?key|access[\\s_-]?(?:key|token)|auth[\\s_-]?token|token|secret(?:[\\s_-]?key)?|private[\\s_-]?key)';
const KEY_QUOTE = '["\'`]?';
const KO_PARTICLE = '(?:은|는|가|이(?!(?:라|란|랑|나|다|에|야|지|고|면|므|었|니|든|며)))';
const KOREAN_ASSIGNMENT = new RegExp(`${KO_KEYWORD}(?:${KEY_QUOTE}\\s*[:=]|${KO_PARTICLE})\\s*\\S+`, 'iu');
const ENGLISH_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])${EN_KEYWORD}(?:\\s+(?:is|are|was|will\\s+be)\\b|${KEY_QUOTE}\\s*[:=])\\s*\\S+`,
  'iu',
);
const SECRET_TOKEN_SHAPED = new RegExp(
  [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    '\\bsk-[A-Za-z0-9_-]{16,}',
    '\\b[sr]k_live_[A-Za-z0-9]{16,}',
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bgithub_pat_[A-Za-z0-9_]{20,}',
    '\\bxox[abeprs]-[A-Za-z0-9-]{10,}',
    '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{35}',
    '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    '\\bBearer\\s+[A-Za-z0-9._~+/=-]{20,}',
  ].join('|'),
  'u',
);
const CARD_NUMBER = /\b(?:\d[ -]?){15}\d\b/u;
const DETECTION_INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

function detectionView(text) {
  let view = text;
  for (let round = 0; round < 4; round += 1) {
    const next = view.replace(DETECTION_INVISIBLE, '').normalize('NFKC');
    if (next === view) return view;
    view = next;
  }
  return view.replace(DETECTION_INVISIBLE, '');
}

function credentialIn(text) {
  return KOREAN_ASSIGNMENT.test(text) || ENGLISH_ASSIGNMENT.test(text) || SECRET_TOKEN_SHAPED.test(text) || CARD_NUMBER.test(text);
}

export function hasCredential(text) {
  return credentialIn(text) || credentialIn(detectionView(text));
}

// --- 7. Time and date (A2-D3 guard) -----------------------------------------------------------------------------
const NATIVE_HOUR = '(?:열한|열두|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)';
/** Words that start with 시 and are not a clock time after a native numeral (시간, 시작, 시점, …). */
const NOT_CLOCK_AFTER_SI = '(?!간|대|각|적|작|절|장|급|청|민|험|설|공|점|스|키|켜|도|트|야|즌|리|선|위|행|안|기|합|계|범)';
const MONTH_EN = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const TIME_DATE = [
  /\d{1,2}\s*:\s*\d{2}/, // H:MM
  /\d{1,2}\s*시(?!간)/, // N시, N시 N분, N시 반 (N시간 is a duration)
  /(?:오전|오후)\s*\d{1,2}/, // 오전/오후 plus an hour
  new RegExp(`(?<![가-힣])${NATIVE_HOUR}\\s*시${NOT_CLOCK_AFTER_SI}`), // 세 시, 열한 시
  /\b\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i, // h(:mm) am/pm
  /\b\d{1,2}\s*o'?clock\b/i,
  /\d{4}\s*[-./년]\s*\d{1,2}/, // 2026-11-12, 2026.11, 2026년 11
  /(?<![\d.])\d{1,2}\s*\/\s*\d{1,2}(?![\d])/, // 11/12
  /\d{1,2}\s*월(?!\s*요일)/, // 11월, 11월 12일
  /(?<!\d)\d{1,2}\s*일(?!\s*(?:뒤|후|전|간|동안|째|차|이내|이상|이하|정도|치|만에|내|씩|짜리|연속|가량|넘게|남짓|분량))/, // 12일 (N일 뒤 / N일간 are relative)
  new RegExp(`\\b${MONTH_EN}\\s+\\d{1,2}(?!\\d)`, 'i'), // Nov 12
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_EN}(?![a-z])`, 'i'), // 12 Nov, 12th of November
];

export function hasTimeOrDate(text) {
  return TIME_DATE.some((re) => re.test(text));
}

// --- the pipeline -------------------------------------------------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strictParse(raw) {
  let o;
  try {
    o = JSON.parse(String(raw).trim());
  } catch {
    return null;
  }
  if (!isPlainObject(o)) return null;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'extra,intro,ranked') return null;
  if (typeof o.intro !== 'string' || !Array.isArray(o.ranked) || !Array.isArray(o.extra)) return null;
  for (const e of o.ranked) {
    if (!isPlainObject(e) || Object.keys(e).sort().join(',') !== 'n,why') return null;
    if (typeof e.n !== 'number' || !Number.isInteger(e.n) || typeof e.why !== 'string') return null;
  }
  if (!o.extra.every((e) => typeof e === 'string')) return null;
  return o;
}

function lines(text) {
  return text.split('\n').length;
}

function chars(text) {
  return [...text].length;
}

/**
 * Applies the guards to one raw output. `testCase` = { source, select, count?, items }.
 * Returns { ok: true, output, empty } or { ok: false, check } with the first failed check.
 */
export function guardOutput(raw, testCase) {
  const output = strictParse(raw);
  if (!output) return { ok: false, check: 'strict-parse' };
  if (output.ranked.length === 0) return { ok: true, output, empty: true };
  const n = testCase.items.length;
  const shapeFail = checkOrdinals(output.ranked, { select: testCase.select, count: testCase.count, n });
  if (shapeFail) return { ok: false, check: shapeFail };
  const texts = [output.intro, ...output.ranked.map((e) => e.why), ...output.extra];
  if (texts.some(hasUrl)) return { ok: false, check: 'url' };
  if (texts.some(hasCredential)) return { ok: false, check: 'credential' };
  const ctx = { source: testCase.source, n };
  if (texts.some((t) => invalidPlaceholders(t, ctx).length > 0)) return { ok: false, check: 'placeholder' };
  if (texts.some((t) => hasTimeOrDate(stripValidPlaceholders(t, ctx)))) return { ok: false, check: 'time-date' };
  if (chars(output.intro) > INTRO_MAX || lines(output.intro) > 2) return { ok: false, check: 'length' };
  if (output.ranked.some((e) => chars(e.why) > WHY_MAX || e.why.includes('\n'))) return { ok: false, check: 'length' };
  if (output.extra.length > EXTRA_MAX_ITEMS || output.extra.some((e) => chars(e) > EXTRA_MAX || e.includes('\n'))) {
    return { ok: false, check: 'length' };
  }
  return { ok: true, output, empty: false };
}
