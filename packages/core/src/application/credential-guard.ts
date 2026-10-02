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

/**
 * FILE-content guard ("refuse rather than leak"). Deliberately conservative: a credential-named key
 * followed by an assignment operator and ANY literal value refuses the file. Only the explicit
 * reference forms below pass; everything else that looks like a value (bare identifiers, dotted
 * names, numbers, quoted text of any shape) counts as a literal. Known, accepted false positives:
 * `{ token: 'identifier' }`, `this.token = token`, `token = settings.API_TOKEN`.
 */

/** Any key token, quoted (may hold spaces/Korean) or bare (identifier chars, dots, dashes), plus operator. */
const FILE_KEY_ASSIGNMENT = new RegExp(
  `(?:(["'\`])([^"'\`\\n]{1,64})\\1|(?<![\\p{L}\\p{N}_$.\\-])([\\p{L}\\p{N}_$\\-][\\p{L}\\p{N}_$.\\-]*)(["'\`]?))` +
    `[ \\t]*(\\?)?[ \\t]*(:=|=>|=(?!=)|:(?!:))`,
  'gu',
);
/** Key word segments (camelCase / snake / kebab / dotted split) that name a credential. */
const CREDENTIAL_KEY_WORDS = new Set([
  'password', 'passwords', 'passwd', 'pwd', 'pass', 'passcode', 'passphrase', 'secret', 'secrets',
  'token', 'tokens', 'auth', 'credential', 'credentials', 'apikey', 'apikeys', 'accesskey', 'privatekey',
]);
const CREDENTIAL_KEY_PAIRS = new Set(['api key', 'access key', 'private key']);
const KO_CREDENTIAL_KEY = /(?:비밀\s?번호|패스워드|비번|암호|토큰|시크릿|(?:^|[^가-힣]|액세스|비밀|개인|인증)키)$/u;
/** `maxTokens: 4096`, `token_ttl: 3600` — counts, not credentials (numeric values only). */
const TOKEN_COUNT_WORDS = new Set([
  'max', 'min', 'num', 'total', 'count', 'limit', 'budget', 'usage', 'input', 'output', 'prompt',
  'completion', 'ttl', 'expiry', 'expires', 'length', 'len', 'size',
]);

const VALUE_END = /^[ \t]*(?:$|\r?\n|[,;)\]}])/u;
/** The value token ends here: end of line, a separator/closer, or a trailing comment. */
const TOKEN_END = '(?=[ \\t]*(?:$|\\r?\\n|[,;)\\]}#]|//))';
const TEMPLATE_PLACEHOLDER = /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|%\([^)\n]*\)s/gu;
const ENV_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ|ENV)(?![\w$])(?:\??\.[\w$]+|\[[^\]\n]*\])*/u;
const CALL_EXPRESSION = /^(?:(?:await|new)\s+)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*[ \t]*\(/u;
const KEYWORD_LITERAL = new RegExp(`^(?:true|false|null|undefined|none|nil)${TOKEN_END}`, 'iu');
const NUMERIC_LITERAL = new RegExp(`^-?\\d[\\d_]*(?:\\.\\d+)?${TOKEN_END}`, 'u');
const FALLBACK_OPERATOR = /^[ \t]*(?:\?\?|\|\||or\b)[ \t]*/u;
const TYPE_ATOM =
  '(?:[A-Z][\\w$]*(?:\\.[A-Z][\\w$]*)*|string|number|boolean|bigint|symbol|object|unknown|any|never|void|undefined|null|str|int|float|bool|bytes)' +
  '(?:<[^<>\\n]*>|\\[[^\\[\\]\\n]*\\])?(?:\\[\\])*';
const TYPE_ANNOTATION = new RegExp(
  `^${TYPE_ATOM}(?:[ \\t]*\\|[ \\t]*${TYPE_ATOM})*(?=[ \\t]*(?:$|\\r?\\n|[;,)=]))`,
  'u',
);
const TYPE_DECLARATION_HEAD = /\b(?:interface|class)\s+[\w$]+[^{};=]*$|\btype\s+[\w$]+(?:<[^>]*>)?\s*=\s*$/u;

function keyWordSegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** 'count' for token-count keys (`maxTokens`), true for other credential keys, false otherwise. */
function classifyKey(key: string): boolean | 'count' {
  const words = keyWordSegments(key);
  const credential = words.filter(
    (w, i) => CREDENTIAL_KEY_WORDS.has(w) || CREDENTIAL_KEY_PAIRS.has(`${w} ${words[i + 1] ?? ''}`),
  );
  if (credential.length === 0) return KO_CREDENTIAL_KEY.test(key.trim());
  const onlyTokens = credential.every((w) => w === 'token' || w === 'tokens');
  return onlyTokens && words.some((w) => TOKEN_COUNT_WORDS.has(w)) ? 'count' : true;
}

/** Nearest unclosed `(` (parameter list) or `{` opened by an interface/class/type declaration. */
function inTypeContext(src: string, keyStart: number): boolean {
  let depth = 0;
  for (let i = keyStart - 1; i >= Math.max(0, keyStart - 4000); i--) {
    const c = src[i];
    if (c === '}' || c === ')') depth++;
    else if (c === '{' || c === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      return c === '(' || TYPE_DECLARATION_HEAD.test(src.slice(Math.max(0, i - 200), i));
    }
  }
  return false;
}

/** Reads the string literal opening at `s[i]` (single, double, backtick, or triple-quoted). */
function readLiteral(s: string, i: number): { content: string; end: number } {
  const q = s[i] as string;
  const triple = q !== '`' && s.startsWith(q.repeat(3), i);
  let j = i + (triple ? 3 : 1);
  let out = '';
  for (; j < s.length; j++) {
    const c = s[j] as string;
    if (c === '\\') {
      out += s[++j] ?? '';
    } else if (triple) {
      if (s.startsWith(q.repeat(3), j)) return { content: out, end: j + 3 };
      out += c;
    } else if (c === q) {
      return { content: out, end: j + 1 };
    } else if (c === '\n' && q !== '`') {
      return { content: out, end: j };
    } else out += c;
  }
  return { content: out, end: j };
}

const hasLiteralText = (content: string): boolean => content.replace(TEMPLATE_PLACEHOLDER, '').trim() !== '';

/**
 * True when ANY quoted literal with non-blank content appears in the rest of the assigned expression
 * (`"" + "x"`, `"" "x"`, a parenthesised multi-line concatenation) up to the end of the statement.
 */
function tailHasLiteral(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '"' || c === "'" || c === '`') {
      const lit = readLiteral(s, i);
      if (hasLiteralText(lit.content)) return true;
      i = lit.end - 1;
    } else if (c === '#' || s.startsWith('//', i)) {
      const nl = s.indexOf('\n', i);
      if (nl < 0) return false;
      i = nl - 1;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0 && (c === ';' || c === ',')) return false;
    else if (depth === 0 && c === '\n') {
      const continued = /[+\\][ \t\r]*$/u.test(s.slice(0, i)) || /^\s*\+/u.test(s.slice(i + 1));
      if (!continued) return false;
    }
  }
  return false;
}

/**
 * Skips whitespace and opening brackets before a value. A line break after the operator continues onto
 * the next line only when that line is indented (YAML block value, wrapped TS/Python) or starts with a
 * quote; otherwise the value is empty.
 */
function skipValueLead(value: string): string {
  let v = value.replace(/^[ \t]*/u, '');
  if (/^\r?\n/u.test(v)) {
    const rest = v.replace(/^\s+/u, '');
    const indented = /[ \t]$/u.test(v.slice(0, v.length - rest.length));
    // A nested YAML mapping (`password:\n  rotation: 30d`) holds no value itself; its keys are scanned on their own.
    const nestedKey = /^["']?[\w.$-]+["']?[ \t]*:(?:\s|$)/u.test(rest);
    v = !nestedKey && (indented || /^["'`]/u.test(rest)) ? rest : '';
  }
  return /^[[(]/u.test(v) ? skipValueLead(v.slice(1)) : v;
}

function closingParen(value: string, open: number): number {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')' && --depth === 0) return i + 1;
  }
  return value.length;
}

interface ValueContext {
  readonly typePosition: boolean;
  readonly typeContext: () => boolean;
  readonly countKey: boolean;
}

/** True when the value starting at `value` is a literal (i.e. not an explicit reference form). */
function isLiteralValue(value: string, ctx: ValueContext, depth = 0): boolean {
  if (depth > 3) return true;
  let v = skipValueLead(value);
  if (VALUE_END.test(v)) return false;
  const quoted = /^(?:[rbuf]{1,2}(?=["'`]))?(["'`])/iu.exec(v);
  if (quoted) {
    const literal = readLiteral(v, quoted[0].length - 1);
    return hasLiteralText(literal.content) || tailHasLiteral(v.slice(literal.end));
  }
  const placeholders = /^(?:\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|%\([^)\n]*\)s)+/u.exec(v);
  if (placeholders) return !VALUE_END.test(v.slice(placeholders[0].length));
  // A nested object/block: its own keys are scanned separately.
  if (v.startsWith('{')) return false;
  if (KEYWORD_LITERAL.test(v)) return false;
  if (ctx.countKey && NUMERIC_LITERAL.test(v)) return false;
  const call = CALL_EXPRESSION.exec(v);
  const env = call ? null : ENV_REFERENCE.exec(v);
  if (call || env) {
    const rest = v.slice(call ? closingParen(v, call[0].length - 1) : (env?.[0].length ?? 0));
    const fallback = FALLBACK_OPERATOR.exec(rest);
    return fallback ? isLiteralValue(rest.slice(fallback[0].length), ctx, depth + 1) : false;
  }
  if (ctx.typePosition) {
    const type = TYPE_ANNOTATION.exec(v);
    if (type) {
      const named = type[0]
        .split('|')
        .some((atom) => /^[A-Z]/u.test(atom.trim()) && !/^None\b/u.test(atom.trim()));
      if (named && !ctx.typeContext()) return true;
      v = v.slice(type[0].length);
      const defaultValue = /^[ \t]*=(?!=)/u.exec(v);
      return defaultValue ? isLiteralValue(v.slice(defaultValue[0].length), ctx, depth + 1) : false;
    }
  }
  return true;
}

/**
 * True when workspace FILE content carries credential material: a private-key block, a vendor
 * key/token, or a credential-named key (password/secret/token/api key/auth/credentials …, any
 * prefix/suffix; Korean 비밀번호/암호/토큰/키) assigned any literal with `:`, `=`, `=>`, or `:=`.
 * Reference forms pass: env lookups, call expressions, `${…}`/`{{…}}`/`%(…)s` placeholders, type
 * annotations, comparisons, empty values, and booleans/null. Korean prose and card-number shapes
 * are not scanned here. A value may start on the next (indented) line, be triple-quoted, or be built
 * by concatenation (`"" + "x"`, `"" "x"`): any non-blank quoted literal in the expression refuses. A
 * credential-named key whose block value is a nested YAML mapping (`password:\n  rotation: 30d`) has
 * no value of its own (nested keys are scanned separately; a nested `value: x` is a residual). Detection is regex-based and BEST-EFFORT, not a complete DLP.
 */
export function containsCredentialFileContent(content: string): boolean {
  if (SECRET_TOKEN_SHAPED.test(content)) return true;
  for (const m of content.matchAll(FILE_KEY_ASSIGNMENT)) {
    const key = m[2] ?? m[3] ?? '';
    const kind = classifyKey(key);
    if (!kind) continue;
    const keyStart = m.index ?? 0;
    const ctx: ValueContext = {
      typePosition: m[6] === ':' && m[3] !== undefined && !m[4],
      typeContext: () => m[5] === '?' || inTypeContext(content, keyStart),
      countKey: kind === 'count',
    };
    const valueStart = keyStart + m[0].length;
    if (isLiteralValue(content.slice(valueStart, valueStart + 512), ctx)) return true;
  }
  return false;
}
