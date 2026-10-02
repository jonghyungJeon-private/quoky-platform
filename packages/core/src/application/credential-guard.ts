/**
 * Deterministic credential-declaration detector shared by the durable-memory write gate and the
 * read-time recall filter. Conservative on purpose: it refuses only when a credential keyword is
 * being assigned a value ("비밀번호는 x", "password: x", "my pin is 1234") or when the text carries
 * token-shaped material, so harmless facts about passwords/tokens in general still pass.
 *
 * {@link containsCredentialFileContent} is the stricter-on-format, file-oriented variant used before a
 * workspace file's content is sent to an AI provider (code-generation context).
 */

export const CREDENTIAL_REJECTION_REASON = 'candidate contains credential or authentication material';

const KO_KEYWORD =
  '(?:비밀\\s?번호|패스워드|비번|인증\\s?번호|OTP|PIN|핀\\s?번호|카드\\s?번호|계좌\\s?비밀번호|API\\s?키|액세스\\s?키|토큰|시크릿|비밀\\s?키|개인\\s?키|암호)';
const EN_KEYWORD =
  '(?:password|passwd|pwd|passcode|pass\\s?phrase|pin(?:\\s?(?:code|number))?|otp|card\\s?number|api[\\s_-]?key|access[\\s_-]?(?:key|token)|auth[\\s_-]?token|token|secret(?:[\\s_-]?key)?|private[\\s_-]?key)';
/** Optional closing quote of a quoted key: `"password": x`, `'토큰': x`. */
const KEY_QUOTE = '["\'`]?';
/**
 * A keyword immediately followed by a topic/subject particle is an assignment whether or not a space
 * follows ("비밀번호는 x", "비밀번호는테스트값이야"). A keyword NOT directly followed by a particle is part
 * of a longer noun phrase ("비밀번호 정책 문서는…", "암호화 방식은…") and never matches. After 이 the
 * copula/connective endings ("토큰이라는", "토큰이랑", "토큰이야", …) are not assignments.
 */
const KO_PARTICLE = '(?:은|는|가|이(?!(?:라|란|랑|나|다|에|야|지|고|면|므|었|니|든|며)))';

const KOREAN_ASSIGNMENT = new RegExp(`${KO_KEYWORD}(?:${KEY_QUOTE}\\s*[:=]|${KO_PARTICLE})\\s*\\S+`, 'iu');
/** No ASCII letter/digit directly before the keyword, so `db_password=` / `"client_secret":` match. */
const ENGLISH_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])${EN_KEYWORD}(?:\\s+(?:is|are|was|will\\s+be)\\b|${KEY_QUOTE}\\s*[:=])\\s*\\S+`,
  'iu',
);
/** Vendor key / token formats — meaningful in both chat text and file content. */
const SECRET_TOKEN_PATTERNS = [
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
];
const SECRET_TOKEN_SHAPED = new RegExp(SECRET_TOKEN_PATTERNS.join('|'), 'u');
/** Card-number shape: chat-only (16-digit literals are common in source files). */
const CARD_NUMBER = /\b(?:\d[ -]?){15}\d\b/u;

/** True when `text` declares a credential value or carries token-shaped secret material. */
export function containsCredentialMaterial(text: string): boolean {
  return (
    KOREAN_ASSIGNMENT.test(text) ||
    ENGLISH_ASSIGNMENT.test(text) ||
    SECRET_TOKEN_SHAPED.test(text) ||
    CARD_NUMBER.test(text)
  );
}

/** File keys: {@link EN_KEYWORD} minus pin/otp/card number (`pin: 13` is routine hardware/config). */
const FILE_KEYWORD =
  '(?:password|passwd|pwd|passcode|pass\\s?phrase|api[\\s_-]?key|access[\\s_-]?(?:key|token)|auth[\\s_-]?token|token|secret(?:[\\s_-]?key)?|private[\\s_-]?key)';
/** A credential-named key (any identifier prefix, optionally quoted) and its separator. */
const FILE_KEY = `(?<![A-Za-z0-9])${FILE_KEYWORD}${KEY_QUOTE}[ \\t]*(?:=(?![=>])|:)[ \\t]*`;
/** `password = "x"`, `"private_key": "x"`, `token: 'x'` — a quoted, non-empty, whitespace-free literal. */
const FILE_QUOTED_ASSIGNMENT = new RegExp(`${FILE_KEY}(["'\`])([^"'\`\\s]+)\\1`, 'giu');
/**
 * Line-oriented unquoted value (.env / YAML / INI / properties): `DB_PASSWORD=hunter2`, `password: x`.
 * Restricted to a whole-line `key<sep>value` whose value carries no code punctuation, so source like
 * `token = getToken();` or `password: string;` does not match.
 */
const FILE_UNQUOTED_ASSIGNMENT = new RegExp(
  `^[ \\t]*(?:export[ \\t]+)?["']?[A-Za-z0-9_.-]*?${FILE_KEY}([^\\s"'\`#;,(){}\\[\\]<>$%]+)[ \\t]*(?:#.*)?$`,
  'gimu',
);
/** Placeholder / type-name / self-named values that are not secrets (quoted or not). */
const PLACEHOLDER_VALUE = new RegExp(
  [
    '^(?:\\$|\\{\\{|<|%)',
    '^(?:string|number|boolean|null|undefined|none|nil|true|false|any|unknown|str|int|bytes|optional|required|redacted|x{3,}|\\*+)$',
    `^${EN_KEYWORD}$`,
  ].join('|'),
  'iu',
);
/** Unquoted dotted identifiers are code references (`settings.API_TOKEN`, `process.env.TOKEN`). */
const CODE_REFERENCE_VALUE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/u;

function hasSecretAssignment(pattern: RegExp, text: string, valueGroup: number, unquoted: boolean): boolean {
  for (const m of text.matchAll(pattern)) {
    const value = m[valueGroup] ?? '';
    if (!value || PLACEHOLDER_VALUE.test(value)) continue;
    if (unquoted && CODE_REFERENCE_VALUE.test(value)) continue;
    return true;
  }
  return false;
}

/**
 * True when workspace FILE content carries credential material: a private-key block, a vendor
 * key/token, or a credential-named key assigned a literal value (JSON / YAML / .env / code string
 * literal). Korean prose and card-number shapes are deliberately not scanned here (docs/comments and
 * numeric literals would trip them); references like `${DB_PASSWORD}` or `process.env.TOKEN` pass.
 */
export function containsCredentialFileContent(content: string): boolean {
  return (
    SECRET_TOKEN_SHAPED.test(content) ||
    hasSecretAssignment(FILE_QUOTED_ASSIGNMENT, content, 2, false) ||
    hasSecretAssignment(FILE_UNQUOTED_ASSIGNMENT, content, 1, true)
  );
}
