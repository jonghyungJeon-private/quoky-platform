/**
 * Deterministic credential-declaration detector shared by the durable-memory write gate and the
 * read-time recall filter. Conservative on purpose: it refuses only when a credential keyword is
 * being assigned a value ("비밀번호는 x", "password: x", "my pin is 1234") or when the text carries
 * token-shaped material, so harmless facts about passwords/tokens in general still pass.
 *
 * {@link containsCredentialFileContent} is the stricter-on-format, file-oriented variant used before a
 * workspace file's content is sent to an AI provider (code-generation context);
 * {@link classifyCredentialFileContent} reports which of its detectors fired and where.
 */

import { baselineFileContentRefusal } from './credential-guard-baseline';

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
 * FILE-content guard ("refuse rather than leak"). STRICT-ONLY and deliberately conservative (ADR-0097):
 * one rule for every file, with no file-type awareness and no path input. A credential-named key
 * followed by an assignment operator and ANY literal value refuses the file. Only the explicit
 * reference forms below pass; everything else that looks like a value (bare identifiers, dotted
 * names, numbers, quoted text of any shape) counts as a literal. Known, accepted false positives
 * (absorbed by the owner's one-time override, never by loosening this rule):
 * - literal-looking references: `{ token: 'identifier' }`, `this.token = token`,
 *   `token = settings.API_TOKEN`, `let password: Secret;`, C# `{ get; set; } = string.Empty;`;
 * - any quoted literal later in the expression after a reference head, including call arguments of a
 *   chained call (`getToken().concat("x")`, `obj.method().other("x")`, and a wrapped builder
 *   `const auth = createAuth()\n  .withProvider("github")`), quoted text in a comment inside the
 *   expression, and a `/* … *\/` comment at a line end (read as a trailing `/` operator);
 * - arrows with a parameter list (`async (t) => t.token`, `(x) => x.token`): only `() => …` and an
 *   `async`/`static` head with a non-literal body pass;
 * - bare elements after a separator inside the value's bracket (`tokens = [getA(), fallbackToken]`).
 * Accepted residuals (not refused): an object-literal value is judged by its own keys only
 * (`password: {a: "", b: hunter2}`); `#` comment lines between a reference and its continuation end the
 * expression; elements of nested brackets inside the value are not judged bare (`[[a, hunter2]]`).
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

/** How far past the assignment operator a value expression is followed. */
const VALUE_WINDOW = 4096;
const VALUE_END = /^[ \t]*(?:$|\r?\n|[,;)\]}])/u;
/** The value token ends here: end of line, a separator/closer, or a trailing comment. */
const TOKEN_END = '(?=[ \\t]*(?:$|\\r?\\n|[,;)\\]}#]|//))';
const TEMPLATE_PLACEHOLDER = /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|%\([^)\n]*\)s/gu;
const ENV_REFERENCE = /^(?:process\.env|import\.meta\.env|os\.environ|ENV)(?![\w$])(?:\??\.[\w$]+|\[[^\]\n]*\])*/u;
const CALL_EXPRESSION = /^(?:(?:await|new)\s+)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*[ \t]*\(/u;
/** `async (…)` / `static (…)` start a function value (or nothing), never a call expression. */
const NON_CALL_HEAD = /^(?:async|static)[ \t]*\(/u;
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

/** A line ending with an operator continues the expression on the next line (`a ??`, `a +`, `cond ?`). */
const CONTINUES_AFTER = /(?:[+\-*/%\\?:=&|^~,]|\?\?)$/u;
/**
 * A next code line starting with an operator continues the expression (Prettier's wrapped ternary / `??` /
 * `||` / chained-call layout: `a\n  ? b\n  : "x"`, `a\n  ?? "x"`). It is tested at the next CODE
 * character ({@link nextCodeIndex}), so blank lines and `//` / `/* … *\/` comments between the two lines
 * (`a\n  // dev\n  ?? "x"`) do not end the expression; a comment itself never starts a continuation.
 */
const CONTINUES_BEFORE = /\s*(?:\?\?|\|\||&&|\?\.?|:(?!:)|\.(?!\.\.)|[+\-*%]|\/(?![/*]))/uy;
const LEADING_SPACE = /\s*/uy;
/** The pre-ADR-0097 continuation test on the raw line (a trailing `+` or backslash, comments included). */
const RAW_LINE_CONTINUES = /[+\\][ \t\r]*$/u;
/** A raw string opener after `#` (Rust `r#"…"#`, Swift `#"…"#`): not a comment. */
const RAW_STRING_HASHES = /#*"/uy;

/**
 * Calls that only wrap or decode a literal into a (secret) string value (`String::from("x")`, `str("x")`,
 * `Some("x")`, `new String("x")`, `SecretStr("x")`, `Secret.of("x")`, `atob("…")`,
 * `base64.b64decode("…")`): any non-blank quoted literal in their arguments is the value itself.
 */
const LITERAL_WRAPPER_CALL =
  /^(?:new\s+)?(?:pydantic\.)?(?:String|SecretString|SecretStr|SecretBytes|Secret|SecretBox|Zeroizing|str|bytes|Some|Ok|atob|base64\.(?:b64|urlsafe_b64|b32|b16)decode|Base64\.(?:strict_|urlsafe_)?decode64)(?:::<[^>\n]*>)?(?:(?:::|\.)(?:from|new|of))?[ \t]*(?=\()/u;
/** `Buffer.from("…", "base64")`: a literal FIRST argument is the value (`Buffer.from(raw, "base64")` is not). */
const FIRST_ARG_WRAPPER_CALL = /^Buffer\.from[ \t]*\(\s*(?=["'`])/u;
/**
 * Env lookups with a default (`os.getenv("K", "x")`, `os.environ.get("K", "x")`, `ENV.fetch("K", "x")`,
 * Laravel `env("K", "x")`): a non-blank literal after the first argument is a hard-coded fallback value.
 */
const ENV_DEFAULT_CALL = /^(?:os\.getenv|os\.environ\.get|environ\.get|getenv|ENV\.fetch|env)[ \t]*(?=\()/u;
/** Optional `async`/`static` and Rust `fn` / TS generic parameters before an arrow's parameter list. */
const ARROW_HEAD = /^(?:(?:async|static)\s+)*(?:fn\s*)?(?:<[^\n=()]*>\s*)?/u;
/** Arrow heads the strict rule already passed: an empty parameter list, or an `async`/`static` head. */
const PASSING_ARROW_HEAD = /^(?:\([ \t]*\)|(?:async|static)[ \t]*\()/u;

const KEY_IDENTIFIER = '[\\p{L}_][\\p{L}\\p{N}_]*';
/** A Go type after the key: optional pointer / slice / array prefixes, then a (qualified) type name. */
const GO_TYPE = '(?:\\*|\\[\\d*\\])*[\\p{L}_][\\p{L}\\p{N}_.]*';
/** The text before a Go `const (` / `var (` group's opening parenthesis. */
const GO_GROUP_HEAD = /(?:^|\n)[ \t]*(?:const|var)[ \t]*$/u;

/** True when `keyStart` sits directly inside a Go `const ( … )` / `var ( … )` group. */
function inGoDeclarationGroup(src: string, keyStart: number): boolean {
  let depth = 0;
  for (let i = keyStart - 1; i >= Math.max(0, keyStart - 4000); i--) {
    const c = src[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      return c === '(' && GO_GROUP_HEAD.test(src.slice(Math.max(0, i - 200), i));
    }
  }
  return false;
}

interface TypedDeclaration {
  readonly pattern: RegExp;
  /** Extra scope check on the key's offset (default: every match counts). */
  readonly inScope?: (src: string, keyStart: number) => boolean;
}

/**
 * Declarations where a type or accessor sits between the key and `=` (or the key is a string argument),
 * so {@link FILE_KEY_ASSIGNMENT} does not see them. Applied to EVERY file (there is no path input):
 * Go `const Password string = "x"` (line-anchored `const`/`var`) and the member lines of a grouped
 * `const (` / `var (` declaration (`\tPassword string = "x"`), C# `Password { get; set; } = "x"` (the
 * accessor block and the initializer may sit on the following lines), PHP `define("DB_PASSWORD", "x")`.
 * Group 1 is the key.
 */
const TYPED_DECLARATIONS: readonly TypedDeclaration[] = [
  { pattern: new RegExp(`(?:^|\\n)[ \\t]*(?:const|var)[ \\t]+(${KEY_IDENTIFIER})[ \\t]+${GO_TYPE}[ \\t]*=(?!=)`, 'gu') },
  {
    pattern: new RegExp(`(?:^|\\n)[ \\t]+(${KEY_IDENTIFIER})[ \\t]+${GO_TYPE}[ \\t]*=(?!=)`, 'gu'),
    inScope: inGoDeclarationGroup,
  },
  { pattern: new RegExp(`(?<![\\p{L}\\p{N}_$.])(${KEY_IDENTIFIER})\\s*\\{[^{}]{0,200}\\}\\s*=(?!=)`, 'gu') },
  { pattern: /(?<![\p{L}\p{N}_$])define[ \t]*\([ \t]*["']([^"'\n]{1,64})["'][ \t]*,/giu },
];

/**
 * Same segments as the baseline's split (`ABCDef` → `ABC Def`), in linear time: the baseline's
 * `/([A-Z]+)([A-Z][a-z])/` backtracks quadratically on a long upper-case run. The lookahead form inserts the
 * space at exactly the same places (the consumed `[A-Z][a-z]` can never be the `[A-Z]` before a split).
 */
function keyWordSegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/gu, '$1 ')
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
 * A line comment starts at `s[i]`: `//`, or a `#` at the start or after whitespace that does not open a
 * raw string (`#"…"#`). A `#` glued to code (`this.#x`, `r#"…"#`) is not a comment.
 */
function isCommentStart(s: string, i: number): boolean {
  if (s.startsWith('//', i)) return true;
  if (s[i] !== '#' || (i > 0 && !/\s/u.test(s[i - 1] as string))) return false;
  RAW_STRING_HASHES.lastIndex = i + 1;
  return !RAW_STRING_HASHES.test(s);
}

/** Index of the next code character at or after `i`: whitespace and `//` / `/* … *\/` comments are skipped. */
function nextCodeIndex(s: string, i: number): number {
  let j = i;
  for (;;) {
    LEADING_SPACE.lastIndex = j;
    j += (LEADING_SPACE.exec(s) as RegExpExecArray)[0].length;
    if (s.startsWith('//', j)) {
      const nl = s.indexOf('\n', j);
      if (nl < 0) return s.length;
      j = nl;
    } else if (s.startsWith('/*', j)) {
      const close = s.indexOf('*/', j + 2);
      if (close < 0) return s.length;
      j = close + 2;
    } else return j;
  }
}

/** A bare element of an open bracket (`hunter2`, `1234`, `a.b`): not a quote, bracket, or `${…}` placeholder. */
const BARE_ELEMENT_START = /^(?!\$\{)[\p{L}\p{N}_$]/u;

/**
 * True when an element right after a separator inside the value's own bracket (`["", hunter2]`,
 * `[null, 1234]`, `[getA(), b]`) is a bare scalar rather than a reference form (a call, an env
 * reference, or a keyword literal), matching the strict rule for a first element (`password: [x]`).
 */
function isBareElement(element: string): boolean {
  if (!BARE_ELEMENT_START.test(element) || KEYWORD_LITERAL.test(element) || ENV_REFERENCE.test(element)) {
    return false;
  }
  return NON_CALL_HEAD.test(element) || !CALL_EXPRESSION.test(element);
}

/**
 * True when ANY quoted literal with non-blank content appears in the rest of the assigned expression
 * (`"" + "x"`, `"" "x"`, `getPw() + "x"`, `a ? "x" : b`) up to the end of the statement. `depth` is the
 * number of brackets already open around the value (`password = (""\n  "x"\n)`, `['', 'x']`): line
 * breaks and separators inside them do not end the expression; closing past them does; a bare element
 * after a separator directly inside them ({@link isBareElement}) is a literal too. At depth 0 a line
 * break ends it unless the line ends with an operator, the next code line starts with one, or the break
 * sits inside a `/* … *\/` comment. Comment text is still scanned, so a quoted literal in it refuses.
 */
function tailHasLiteral(s: string, depth = 0): boolean {
  let open = depth;
  let lineStart = 0;
  /** Index just past the last code character on the current line (-1: none yet). */
  let lastCode = -1;
  /** Index just past the `*\/` closing the `/* … *\/` comment last opened (-1: none). */
  let blockCommentEnd = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (i >= blockCommentEnd && s.startsWith('/*', i)) {
      const close = s.indexOf('*/', i + 2);
      blockCommentEnd = close < 0 ? s.length : close + 2;
    }
    if (c === '"' || c === "'" || c === '`') {
      const lit = readLiteral(s, i);
      if (hasLiteralText(lit.content)) return true;
      i = lit.end - 1;
      lastCode = lit.end;
    } else if (isCommentStart(s, i)) {
      const nl = s.indexOf('\n', i);
      if (nl < 0) return false;
      i = nl - 1;
    } else if (c === '\n') {
      if (open === 0 && i >= blockCommentEnd) {
        const lineEnd = lastCode < 0 ? '' : s.slice(Math.max(0, lastCode - 2), lastCode);
        CONTINUES_BEFORE.lastIndex = nextCodeIndex(s, i + 1);
        const continued =
          CONTINUES_AFTER.test(lineEnd) ||
          RAW_LINE_CONTINUES.test(s.slice(lineStart, i)) ||
          CONTINUES_BEFORE.test(s);
        if (!continued) return false;
      }
      lineStart = i + 1;
      lastCode = -1;
    } else if (c === '(' || c === '[' || c === '{') {
      open++;
      lastCode = i + 1;
    } else if (c === ')' || c === ']' || c === '}') {
      if (open === 0) return false;
      open--;
      lastCode = i + 1;
    } else if (open === 0 && (c === ';' || c === ',')) return false;
    else if (c === ',' && open === depth && isBareElement(s.slice(nextCodeIndex(s, i + 1)))) return true;
    else if (!/\s/u.test(c)) lastCode = i + 1;
  }
  return false;
}

/**
 * Skips whitespace before a value. A line break after the operator continues onto the next line only
 * when that line is indented (YAML block value, wrapped TS/Python) or starts with a quote; otherwise the
 * value is empty.
 */
function skipValueSpace(value: string): string {
  const v = value.replace(/^[ \t]*/u, '');
  if (!/^\r?\n/u.test(v)) return v;
  const rest = v.replace(/^\s+/u, '');
  const indented = /[ \t]$/u.test(v.slice(0, v.length - rest.length));
  // A nested YAML mapping (`password:\n  rotation: 30d`) holds no value itself; its keys are scanned on their own.
  const nestedKey = /^["']?[\w.$-]+["']?[ \t]*:(?:\s|$)/u.test(rest);
  return !nestedKey && (indented || /^["'`]/u.test(rest)) ? rest : '';
}

/**
 * Skips whitespace and opening brackets before a value and counts the brackets. Inside an open bracket
 * every line break continues the value (`password = (\n""\n"x"\n)`).
 */
function skipValueLead(value: string, brackets = 0): { readonly v: string; readonly brackets: number } {
  const v = brackets > 0 ? value.replace(/^\s+/u, '') : skipValueSpace(value);
  return /^[[(]/u.test(v) ? skipValueLead(v.slice(1), brackets + 1) : { v, brackets };
}

/** Index just past the bracket closing the one opened at `s[open]` (quoted literals are skipped). */
function closingBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '"' || c === "'" || c === '`') i = readLiteral(s, i).end - 1;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i + 1;
  }
  return s.length;
}

/** True when the call whose `(` is at `v[open]` has a non-blank quoted literal after its first argument. */
function hasLiteralDefaultArgument(v: string, open: number): boolean {
  const close = closingBracket(v, open);
  const args = v.slice(open + 1, close - 1);
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i] as string;
    if (c === '"' || c === "'" || c === '`') i = readLiteral(args, i).end - 1;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return tailHasLiteral(args.slice(i + 1), 1);
  }
  return false;
}

const skipSpaceAt = (v: string, i: number): number => i + (/^\s*/u.exec(v.slice(i)) as RegExpExecArray)[0].length;

/**
 * Index just past the `=>` that follows a parameter list ending at `i` (optionally after a TS return
 * type `: Promise<string>`), or -1 when no arrow follows.
 */
function arrowEnd(v: string, i: number): number {
  let j = skipSpaceAt(v, i);
  if (v.startsWith('=>', j)) return j + 2;
  if (v[j] !== ':') return -1;
  let depth = 0;
  for (j++; j < Math.min(v.length, i + 300); j++) {
    if (v.startsWith('=>', j)) {
      if (depth === 0) return j + 2;
      j++;
      continue;
    }
    const c = v[j] as string;
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) {
      if (depth === 0) return -1;
      depth--;
    } else if (depth === 0 && (c === ';' || c === ',' || c === '=' || c === '\n')) return -1;
  }
  return -1;
}

/** A function value: a block body (not a value; its statements are scanned key by key), or an expression body at `v[body]`. */
type FunctionValue = { readonly block: true } | { readonly block: false; readonly body: number };

/**
 * A parenthesised arrow function assigned to a credential-named key (`() => "x"`, `async () => "x"`,
 * `fetchToken = async (): Promise<string> => {…}`), or undefined when `v` is not one.
 */
function arrowFunctionValue(v: string): FunctionValue | undefined {
  let i = (ARROW_HEAD.exec(v) as RegExpExecArray)[0].length;
  if (v[i] !== '(') return undefined;
  i = arrowEnd(v, closingBracket(v, i));
  if (i < 0) return undefined;
  const body = skipSpaceAt(v, i);
  return v[body] === '{' ? { block: true } : { block: false, body };
}

interface ValueContext {
  readonly typePosition: boolean;
  readonly typeContext: () => boolean;
  readonly countKey: boolean;
}

/** A typed declaration (Go/C#/PHP): the key is never in a type position. */
const NO_TYPE_POSITION: Omit<ValueContext, 'countKey'> = { typePosition: false, typeContext: () => false };

/** True when the value starting at `value` is a literal (i.e. not an explicit reference form). */
function isLiteralValue(value: string, ctx: ValueContext, depth = 0): boolean {
  if (depth > 3) return true;
  // An expression-bodied arrow refuses when its body is a literal (a body that is a type is a TS function
  // type: `tokenSource: () => Promise<string>`). `() => …` and `async`/`static (…) => …` otherwise pass as
  // before; any other parameter list (`(x) => …`) is judged by the rule below, which refuses it.
  const head = skipValueSpace(value);
  const fn = arrowFunctionValue(head);
  if (fn) {
    const body = fn.block ? '' : head.slice(fn.body);
    if (!fn.block && !TYPE_ANNOTATION.test(body) && isLiteralValue(body, ctx, depth + 1)) return true;
    if (PASSING_ARROW_HEAD.test(head)) return false;
  }
  const lead = skipValueLead(value);
  const { brackets } = lead;
  let v = lead.v;
  if (VALUE_END.test(v)) return brackets > 0 && tailHasLiteral(v, brackets);
  const quoted = /^(?:[rbuf]{1,2}(?=["'`]))?(["'`])/iu.exec(v);
  if (quoted) {
    const literal = readLiteral(v, quoted[0].length - 1);
    return hasLiteralText(literal.content) || tailHasLiteral(v.slice(literal.end), brackets);
  }
  const placeholders = /^(?:\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|%\([^)\n]*\)s)+/u.exec(v);
  if (placeholders) {
    const rest = v.slice(placeholders[0].length);
    return !VALUE_END.test(rest) || (brackets > 0 && tailHasLiteral(rest, brackets));
  }
  // A nested object/block: its own keys are scanned separately; inside brackets the rest is still judged.
  if (v.startsWith('{')) return brackets > 0 && tailHasLiteral(v.slice(closingBracket(v, 0)), brackets);
  const keyword = KEYWORD_LITERAL.exec(v) ?? (ctx.countKey ? NUMERIC_LITERAL.exec(v) : null);
  if (keyword) return tailHasLiteral(v.slice(keyword[0].length), brackets);
  const wrapper = LITERAL_WRAPPER_CALL.exec(v);
  if (wrapper) {
    // A wrapped reference (`SecretStr(os.environ["PW"])`) is judged as that reference; otherwise any
    // non-blank literal in the arguments or the rest of the statement is the value. Without a literal the
    // rule below still applies (`String::from(value)` is not a call expression and refuses).
    const args = v.slice(wrapper[0].length);
    const inner = skipValueLead(args).v;
    const literal =
      CALL_EXPRESSION.test(inner) || ENV_REFERENCE.test(inner)
        ? isLiteralValue(args, ctx, depth + 1) || tailHasLiteral(args.slice(closingBracket(args, 0)), brackets)
        : tailHasLiteral(args, brackets);
    if (literal) return true;
  }
  const firstArg = FIRST_ARG_WRAPPER_CALL.exec(v);
  if (firstArg && hasLiteralText(readLiteral(v, firstArg[0].length).content)) return true;
  const envDefault = ENV_DEFAULT_CALL.exec(v);
  if (envDefault && hasLiteralDefaultArgument(v, envDefault[0].length)) return true;
  const call = NON_CALL_HEAD.test(v) ? null : CALL_EXPRESSION.exec(v);
  const env = call ? null : ENV_REFERENCE.exec(v);
  if (call || env) {
    // After a reference head a fallback (`?? "x"`, `or x`) is a value of its own; any literal in the rest
    // of the statement (`getPw() + "x"`, `process.env.X ? "a" : "b"`) refuses.
    const rest = v.slice(call ? closingBracket(v, call[0].length - 1) : (env?.[0].length ?? 0));
    const fallback = FALLBACK_OPERATOR.exec(rest);
    if (fallback && isLiteralValue(rest.slice(fallback[0].length), ctx, depth + 1)) return true;
    return tailHasLiteral(rest, brackets);
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

/** Offset of the first key (in either scan) assigned a literal, or -1 when there is none. */
function firstCredentialAssignment(content: string): number {
  let first = -1;
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
    if (isLiteralValue(content.slice(valueStart, valueStart + VALUE_WINDOW), ctx)) {
      first = keyStart;
      break;
    }
  }
  for (const { pattern, inScope } of TYPED_DECLARATIONS) {
    for (const m of content.matchAll(pattern)) {
      const key = m[1] as string;
      const keyStart = (m.index ?? 0) + m[0].indexOf(key);
      if (first >= 0 && keyStart >= first) break;
      const kind = classifyKey(key);
      if (!kind || (inScope && !inScope(content, keyStart))) continue;
      const valueStart = (m.index ?? 0) + m[0].length;
      const ctx: ValueContext = { ...NO_TYPE_POSITION, countKey: kind === 'count' };
      if (isLiteralValue(content.slice(valueStart, valueStart + VALUE_WINDOW), ctx)) {
        first = keyStart;
        break;
      }
    }
  }
  return first;
}

/**
 * Which file-content detector fired, never the matched text. `secret-token`: a private-key block or a
 * vendor key/token shape (takes precedence). `credential-assignment`: a credential-named key assigned a
 * literal; `line` is the 1-based line of the first such key.
 */
export type CredentialFileFinding =
  | { readonly kind: 'none' }
  | { readonly kind: 'secret-token' }
  | { readonly kind: 'credential-assignment'; readonly line: number };

/**
 * Classifies workspace FILE content (see {@link containsCredentialFileContent} for the rule). The
 * result names the detector and, for a credential assignment, its line, so a caller can tell the owner
 * where the file was refused without echoing any value.
 */
export function classifyCredentialFileContent(content: string): CredentialFileFinding {
  if (SECRET_TOKEN_SHAPED.test(content)) return { kind: 'secret-token' };
  // Bounded time: a shape the key scans would backtrack on quadratically refuses the file (fail closed, refusal-ADDING
  // like every ADR-0097 change), and the key scans then read only the text BEFORE it, so an earlier credential key
  // still reports its own (earlier) line.
  const unscannable = unscannableOffset(content);
  const scanned = unscannable >= 0 ? content.slice(0, unscannable) : content;
  // ADR-0097 is refusal-ADDING only: whatever the strict rule below concludes, the file is refused whenever
  // the frozen pre-hardening guard (d99d19c) refuses it — new refusals are a superset of the baseline's.
  const baseline = baselineFileContentRefusal(scanned);
  if (baseline?.kind === 'secret-token') return { kind: 'secret-token' };
  const offsets = [baseline?.offset ?? -1, firstCredentialAssignment(scanned), unscannable].filter((o) => o >= 0);
  if (offsets.length === 0) return { kind: 'none' };
  return { kind: 'credential-assignment', line: lineAt(content, Math.min(...offsets)) };
}

/** 1-based line of `offset`. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = content.indexOf('\n'); i >= 0 && i < offset; i = content.indexOf('\n', i + 1)) line++;
  return line;
}

/**
 * Longest key-token run and blank run the key scans are allowed to see. The key-assignment scan (shared with the
 * FROZEN baseline, which may not be edited) costs O(L²) per key on a key of length L made of one upper-case run
 * (the camel-case split) and O(W²) on a run of W blanks right after a key token (`[ \t]*(\?)?[ \t]*`), so an
 * untrusted 256 KiB input like `"AAAA…A="` (a base64 blob) would hold the event loop for about a minute.
 * With both bounded to this length the whole scan stays linear in the content (cost ≈ content × bound).
 */
export const CREDENTIAL_SCAN_MAX_RUN = 256;
/** A key token longer than the bound that is followed by an assignment operator (the scan would classify it). */
const OVERSIZED_KEY = new RegExp(
  `(?<![\\p{L}\\p{N}_$.\\-])[\\p{L}\\p{N}_$\\-][\\p{L}\\p{N}_$.\\-]{${CREDENTIAL_SCAN_MAX_RUN},}` +
    `["'\`]?[ \\t]*\\??[ \\t]*(?::=|=>|=(?!=)|:(?!:))`,
  'u',
);
/** A blank run longer than the bound right after a key character or a closing quote. */
const OVERSIZED_BLANK = new RegExp(`[\\p{L}\\p{N}_$.\\-"'\`][ \\t]{${CREDENTIAL_SCAN_MAX_RUN + 1},}`, 'u');

/**
 * Offset of a shape the key scans cannot judge in bounded time, or -1. Such content is refused as a
 * `credential-assignment` (overridable by the owner like any other, ADR-0095) rather than scanned: refusing what
 * cannot be checked is the ADR-0097 "refuse rather than leak" direction. The earliest such shape wins.
 */
function unscannableOffset(content: string): number {
  const blank = OVERSIZED_BLANK.exec(content)?.index ?? -1;
  // Only the text before a long blank run is searched for an oversized key, so that search never meets one.
  const key = OVERSIZED_KEY.exec(blank >= 0 ? content.slice(0, blank) : content)?.index ?? -1;
  return key >= 0 ? key : blank;
}

/**
 * True when workspace FILE content carries credential material: a private-key block, a vendor
 * key/token, or a credential-named key (password/secret/token/api key/auth/credentials …, any
 * prefix/suffix; Korean 비밀번호/암호/토큰/키) assigned any literal with `:`, `=`, `=>`, or `:=`, or in a
 * typed declaration (Go `const Password string = …`, C# `Password { get; set; } = …`, PHP
 * `define("DB_PASSWORD", …)`). Reference forms pass: env lookups (without a literal default), call
 * expressions, `${…}`/`{{…}}`/`%(…)s` placeholders, type annotations, comparisons, empty values,
 * booleans/null, and block-bodied functions. A value may start on the next (indented) line, be
 * triple-quoted, sit in brackets across lines, be built by concatenation (`"" + "x"`, `"" "x"`,
 * `(""\n  "x"\n)`, `['', 'x']`), follow a reference (`getPw() + "x"`, `process.env.X ? "a" : "b"`,
 * `process.env.X\n  ?? "x"`), be wrapped or decoded (`SecretStr("x")`, `atob("…")`,
 * `Buffer.from("…", "base64")`), be an env default (`os.getenv("K", "x")`) or an expression-bodied arrow
 * (`() => "x"`): any non-blank quoted literal in the expression refuses. A credential-named key whose
 * block value is a nested YAML mapping (`password:\n  rotation: 30d`) has no value of its own (nested
 * keys are scanned separately; a nested `value: x` is a residual). Korean prose and card-number shapes
 * are not scanned here. Strict-only: no file-type awareness and no path input. Monotone: it also refuses
 * everything the frozen `d99d19c` guard refused (`credential-guard-baseline.ts`), so a parsing improvement
 * here can never drop a baseline refusal. Detection is regex-based and BEST-EFFORT, not a complete DLP.
 */
export function containsCredentialFileContent(content: string): boolean {
  return classifyCredentialFileContent(content).kind !== 'none';
}
