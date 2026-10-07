import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyCredentialFileContent,
  containsCredentialFileContent,
  containsCredentialMaterial,
  credentialDetectionView,
  CREDENTIAL_SCAN_MAX_RUN,
} from './credential-guard';
import { baselineFileContentRefusal } from './credential-guard-baseline';

describe('containsCredentialMaterial (durable-memory write gate + read-time exclusion)', () => {
  it.each([
    // Codex delta-review bypasses
    '{"password":"demo-value"}',
    '비밀번호는테스트값이야',
    // quoted keys: JSON / single quotes / backticks
    '{"password": "demo-value"}',
    "{'token': 'abc123'}",
    '`secret`: x',
    '{"db_password":"x"}',
    '{"client_secret": "x"}',
    '{"비밀번호": "테스트값"}',
    "'토큰': 'abc'",
    // unquoted / YAML / env-style
    'password: x',
    'password:x',
    'password=x',
    'password = x',
    'DB_PASSWORD=hunter2',
    'api_key: abcd',
    'aws_secret_access_key = wJalrXUtnFEMI',
    // English prose
    'my password is hunter2',
    'Password is hunter2',
    // Korean with and without whitespace after the particle / separator
    '비밀번호는 테스트값이야',
    '비밀번호는테스트값이야',
    '비밀번호가테스트값이야',
    '비밀번호가 테스트값',
    '패스워드:abc123',
    '패스워드 : abc123',
    '비번=1234',
    '비번 = 1234',
    '토큰이 abc123',
    '토큰은abc123',
    '암호는파랑고래',
    '비밀 번호는 1234',
    '내 API 키는abcd1234',
    // token-shaped
    'sk-abcdefghijklmnopqrstuvwxyz',
    '카드번호 1234-5678-9012-3456',
  ])('flags %j', (text) => {
    expect(containsCredentialMaterial(text)).toBe(true);
  });

  it.each([
    '내 UAT 확인 단어는 파랑 고래야',
    '내 배포 창은 화요일이야',
    '비밀번호 정책 문서는 Confluence에 있어',
    '암호화 방식은 AES야',
    '비밀번호정책은 위키에 있어',
    '토큰이라는 개념은 어려워',
    '비번이랑 아이디는 따로 관리해',
    'use pnpm for this project',
    'passwordless login is enabled',
    'the password policy lives in Confluence',
  ])('passes harmless fact %j', (text) => {
    expect(containsCredentialMaterial(text)).toBe(false);
  });
});

const FILE_REFUSE_CASES: Array<[string, string]> = [
  ['PEM private key', 'const k = `-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----`;'],
  ['RSA private key', '-----BEGIN RSA PRIVATE KEY-----\nabc\n'],
  [
    'service-account JSON',
    '{\n  "type": "service_account",\n  "private_key_id": "abc",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"\n}',
  ],
  ['"private_key" field without a PEM header', '{ "private_key": "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC" }'],
  ['AWS access key id', 'const id = "AKIAIOSFODNN7EXAMPLE";'],
  ['AWS secret in ini', '[default]\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n'],
  ['GCP API key', 'apiKey: AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  ['GitHub token', 'GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"'],
  ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
  ['Slack token', 'slack: xoxb-1234567890-abcdefghij'],
  ['OpenAI-style key', 'client = OpenAI(api_key="sk-proj-abcdefghijklmnopqrstuv")'],
  ['Stripe live key', 'STRIPE = sk_live_abcdefghijklmnop1234'],
  ['JWT', 'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";'],
  ['JSON password', '{"password":"demo-value"}'],
  ['YAML password', 'db:\n  password: hunter2\n'],
  ['.env assignment', 'DB_PASSWORD=hunter2\n'],
  ['exported env', 'export API_TOKEN=abc123\n'],
  ['code string literal', 'const password = "hunter2";'],
  ['single-quoted token', "config.token = 'abc123'"],
  // Codex delta-review bypasses: whitespace / inline values
  ['JSON value with spaces', '{"password":"correct horse battery staple"}'],
  ['code literal with spaces', 'const password = "correct horse battery staple";'],
  ['YAML flow map', 'db: {password: hunter2}'],
  // Codex delta-review bypasses: dotted literals
  ['dotted YAML value', 'password: hunter.two\n'],
  ['dotted .env value', 'API_KEY=abc.def\n'],
  // other assignment syntaxes / key shapes
  ['arrow-pair (PHP/Ruby)', "'password' => 'hunter2',"],
  ['Go short declaration', 'password := "hunter2"'],
  ['keyword argument', 'connect(user="a", password="hunter2")'],
  ['camelCase key', 'const clientSecret = "abc";'],
  ['kebab-case YAML key', 'x-api-key: abc123\n'],
  ['CLI flag', 'mysql --user=root --password=hunter2 db'],
  ['credentials key', 'credentials: abc123\n'],
  ['auth key', "auth: 'basic-abc'"],
  ['Korean quoted key', '{"비밀번호": "테스트값"}'],
  ['Korean bare key', '암호: 파랑고래\n'],
  ['Korean API key', "API키 = 'abc'"],
  ['Korean single-syllable key', '키: abc123\n'],
  ['numeric password', 'password: 123456\n'],
  ['capitalized literal outside a type context', 'password: Hunter2\n'],
  ['capitalized literal in a YAML flow map', 'db: {password: Hunter2, user: a}'],
  ['literal default after a type', 'def connect(password: str = "hunter2"): ...'],
  ['literal fallback after an env reference', 'const token = process.env.TOKEN ?? "dev-token";'],
  ['literal fallback after a call', 'password = os.getenv("PW") or "hunter2"'],
  ['literal next to a placeholder', 'token: "Bearer ${TOKEN}"'],
  ['keyword-prefixed literal', 'password: none-of-your-business\n'],
  ['ENV-prefixed literal', 'password: ENVY123\n'],
  ['secret in array', "tokens = ['abc123']"],
  ['JSON newline after colon', '{"password":\n  "hunter2"}'],
  ['YAML block value on next line', 'password:\n  hunter2\n'],
  ['TS newline after =', 'const password =\n  "hunter2";'],
  ['Python parenthesised newline', 'password = (\n    "hunter2"\n)'],
  ['Python triple double quotes', 'password = """hunter2"""'],
  ['Python triple single quotes', "password = '''hunter2'''"],
  ['multi-line triple quotes', 'password = """\nhunter2\n"""'],
  ['TS string concatenation', 'const password = "" + "hunter2";'],
  ['Python adjacent literals', 'password = "" "hunter2"'],
  ['multi-line concatenation', 'password = ("" +\n  "hunter2")'],
  // Intended false positives ("refuse rather than leak"): a credential-named key with any literal
  // or non-reference value is refused even when it is harmless, because a literal identifier,
  // dotted name, UI label, or self-named value cannot be told apart from a real secret.
  ['documented false positive: identifier-like string', "const node = { token: 'identifier' };"],
  ['documented false positive: dotted code reference', 'token = settings.API_TOKEN\n'],
  ['documented false positive: self-named value', "const fields = { password: 'password' };"],
  ['documented false positive: UI label', 'password: "비밀번호 입력"'],
  ['documented false positive: identifier assignment', 'this.token = token;'],
];

const FILE_PASS_CASES: Array<[string, string]> = [
  ['token from a call', 'const token = getToken();'],
  ['awaited call', 'const token = await auth.getToken(scope);'],
  ['getenv call', 'password = os.getenv("DB_PASSWORD")'],
  ['env() helper', "secret: env('APP_SECRET'),"],
  ['TS type annotation', 'interface Login {\n  password: string;\n  token?: string\n}'],
  ['optional union type', 'type Opts = {\n  token?: string | undefined;\n}'],
  ['named type in an interface', 'interface Cfg {\n  secret: SecretRef\n  apiKey: Promise<Token>,\n}'],
  ['named type in a parameter list', 'function f(secret: SecretRef, password: string) {}'],
  ['Python type hint with env default', 'password: str = os.getenv("PW")'],
  ['bare type line', '  password: string\n'],
  ['comparison', 'if (password === input) return true;'],
  ['loose comparison', 'if (token == null || secret != other) {}'],
  ['env reference', 'const token = process.env.API_TOKEN\n'],
  ['bracket env reference', 'password = os.environ["DB_PASSWORD"]'],
  ['import.meta.env reference', 'const apiKey = import.meta.env.VITE_API_KEY;'],
  ['placeholder', 'password: ${DB_PASSWORD}\n'],
  ['quoted placeholder', '{"password": "${DB_PASSWORD}"}'],
  ['mustache placeholder', 'token: "{{ secrets.TOKEN }}"'],
  ['Python format placeholder', "password = '%(db_password)s'"],
  ['empty literal', 'let token = "";'],
  ['empty YAML value', 'auth:\n  user: me\n'],
  ['nested YAML mapping has no value of its own', 'password:\n  rotation: 30d\n'],
  ['empty literal followed by another key', 'password: ""\nuser: "bob"\n'],
  ['empty JSON literal followed by another key', '{"password": "", "user": "bob"}'],
  ['empty value then unindented key', 'password:\nuser: bob\n'],
  ['nested object', 'const auth = { user, method };'],
  ['booleans and null', 'auth: true\npassword: null\ntoken: undefined\nsecret: None\n'],
  ['token count', 'maxTokens: 4096,\nmax_tokens = 1000\ntoken_ttl: 3600\n'],
  ['unrelated keys containing keyword letters', "author: 'Jane'\ncompass: north\ntokenizer: bpe\npassport: x\n"],
  ['Korean prose', '# 설정\n비밀번호는 환경 변수로 넣어 주세요.\n토큰이 만료되면 다시 로그인해요.'],
  ['GPIO pin config', 'led:\n  pin: 13\n'],
  ['16-digit numeric literal', 'const ns = 1234567890123456;'],
  ['plain source', 'export function add(a: number, b: number) {\n  return a + b;\n}\n'],
];

describe('containsCredentialFileContent (code-generation context)', () => {
  it.each(FILE_REFUSE_CASES)('flags %s', (_label, content) => {
    expect(containsCredentialFileContent(content)).toBe(true);
  });

  it.each(FILE_PASS_CASES)('passes %s', (_label, content) => {
    expect(containsCredentialFileContent(content)).toBe(false);
  });
});

const STRICT_REFUSE_CASES: Array<[string, string]> = [
  // (a) bracket-depth tracking: multi-line / bracketed concatenation (owner-accepted residual closed)
  ['multi-line parenthesised residual', 'password = (""\n    "probe-secret"\n)'],
  ['parenthesised residual with blank lines', 'password = (\n  ""\n\n  "x"\n)'],
  ['array with an empty first element', "password = ['', 'x']"],
  ['unindented element inside an open bracket', 'password = [\nfoo, "x"]'],
  ['object element before a literal', 'tokens = [{ id: 1 }, "x"]'],
  ['keyword element before a literal', 'password = (null, "x")'],
  ['bare element after an empty literal', 'password: ["", hunter2]'],
  ['bare element after a keyword', 'password: [null, hunter2]'],
  ['bare element after a call', 'password = [getA(), hunter2]'],
  ['numeric element after a call', 'password = [getA(), 1234]'],
  ['bare element on the next line', 'passwords = [\n  getA(),\n  hunter2,\n]'],
  ['placeholder element before a literal', 'password = [${A}, "x"]'],
  ['raw string inside brackets', 'password = ["", r#"x"#]'],
  ['Swift raw string inside brackets', 'password = ["", #"x"#]'],
  // (b) operator continuation lines
  ['fallback on the next line', 'const password = process.env.X\n  ?? "hunter2"'],
  ['fallback operator at the line end', 'const token = getToken() ??\n  "hunter2"'],
  ['logical or on the next line', 'const password = getPw()\n  || "hunter2"'],
  ['wrapped ternary', 'const password = process.env.A\n  ? process.env.B\n  : "hunter2"'],
  ['Python backslash continuation', 'password = get_pw() \\\n  + "hunter2"'],
  ['keyword then a fallback on the next line', 'password = null\n  ?? "hunter2"'],
  ['concatenation after a trailing comment-free operator', 'password = getPw() + // note\n  "x"'],
  ['line comment between a reference and its fallback', 'const password = process.env.PW\n  // fallback for local dev\n  ?? "hunter2";'],
  ['block comment line between a reference and its fallback', 'const password = process.env.PW\n  /* dev */\n  ?? "hunter2";'],
  ['line comment between a call and a concatenation', 'const password = getPw()\n  // c\n  + "x";'],
  ['block comment before the fallback operator', 'password = process.env.A\n  /* c */ ?? "x"'],
  ['multi-line block comment before a fallback', 'const password = process.env.PW\n  /* multi\n  line */\n  ?? "hunter2";'],
  ['blank and comment lines before a fallback', 'const password = process.env.PW\n\n  // a\n\n  /* b */\n  ?? "hunter2";'],
  // (c) the whole rest of the statement after a call / env reference head
  ['call plus literal', 'const password = getPw() + "x"'],
  ['env ternary', 'const password = process.env.X ? "a" : "b"'],
  ['chained call with a literal argument', 'const token = getToken().concat("x")'],
  ['parenthesis inside a call argument string', 'const password = getPw(")") + "x"'],
  ['private field is not a comment', 'const password = getPw() + this.#suffix + "x"'],
  ['Ruby fetch block default', 'token = ENV.fetch("TOKEN") { "hunter2" }'],
  ['documented false positive: chained builder argument', 'const auth = createAuth()\n  .withProvider("github")\n  .build();'],
  // (d) env lookups with a literal default
  ['os.getenv default', 'password = os.getenv("DB_PW", "hunter2")'],
  ['os.environ.get default', 'password = os.environ.get("DB_PW", "hunter2")'],
  ['ENV.fetch default', 'password = ENV.fetch("DB_PW", "hunter2")'],
  ['Laravel env default', "'password' => env('DB_PASSWORD', 'secret'),"],
  ['env default nested in a call', 'password = env("K", fallback("x"))'],
  // (e) literal-wrapper and decoder calls
  ['SecretStr', 'password = SecretStr("hunter2")'],
  ['Secret.of', 'const token = Secret.of("hunter2")'],
  ['Rust String::from', 'let password = String::from("hunter2");'],
  ['new String', 'const password = new String("hunter2")'],
  ['Python str()', 'password = str("hunter2")'],
  ['atob', 'const token = atob("aHVudGVy")'],
  ['base64.b64decode', 'token = base64.b64decode("aHVudGVy")'],
  ['Buffer.from with a literal', 'const password = Buffer.from("aHVudGVy", "base64").toString()'],
  ['Buffer.from with the literal on the next line', 'password = Buffer.from(\n  "aGk=",\n  "base64"\n)'],
  ['Buffer.from with an unindented literal on the next line', 'password = Buffer.from(\n"aGk="\n)'],
  ['wrapper plus a literal after it', 'password = SecretStr(get()) + "x"'],
  ['wrapped env lookup with a literal default', 'password = SecretStr(os.getenv("PW", "hunter2"))'],
  ['wrapped call plus a literal', 'password = str(get_pw()) + "x"'],
  ['wrapped env reference inside brackets before a literal', 'tokens = [SecretStr(os.environ["A"]), "x"]'],
  // (f) raw and interpolated string prefixes stay literal (strict rule)
  ['Rust raw string', 'let password = r#"hunter2"#;'],
  ['empty Rust raw string (strictness kept)', 'let password = r#""#;'],
  ['C# interpolated string', 'var password = $"{pw}x";'],
  ['C# verbatim interpolated string', 'var password = @$"{pw}x";'],
  ['empty interpolated string (strictness kept)', 'var password = $"";'],
  // (g) expression-bodied arrow values
  ['arrow returning a literal', 'const password = () => "hunter2"'],
  ['async arrow returning a literal', 'const password = async () => "hunter2"'],
  ['arrow with a return type returning a literal', 'const password = async (): Promise<string> => "hunter2"'],
  ['arrow on the next line', 'const password = () =>\n  "hunter2"'],
  ['arrow returning a bare identifier', 'const token = (x) => x.token'],
  // (h) typed declarations, applied to every file
  ['Go typed const', 'const Password string = "hunter2"'],
  ['Go typed var', 'var Token string = "hunter2"'],
  ['Go typed pointer var', '\tvar apiKey *string = &literal'],
  ['Go grouped var member', 'var (\n\tPassword string = "x"\n)'],
  ['Go grouped const member', 'const (\n\tPassword string = "x"\n)'],
  ['Go grouped const member after another member', 'const (\n\tName string = "app"\n\tPassword string = "x"\n)'],
  ['C# accessor block on the next line', 'public string Password\n{ get; set; } = "x";'],
  ['C# initializer on the next line', 'public string Password { get; set; }\n  = "x";'],
  ['C# multi-line accessor block', 'public string Password\n{\n  get;\n  set;\n} = "x";'],
  ['C# auto-property initializer', 'public string Password { get; set; } = "hunter2";'],
  ['C# getter-only initializer', 'public string ApiKey { get; } = "hunter2";'],
  ['documented false positive: C# dotted default', 'public string Password { get; set; } = string.Empty;'],
  ['PHP define', 'define("DB_PASSWORD", "hunter2");'],
  ['PHP define, single quotes', "define('API_TOKEN', 'hunter2');"],
  ['PHP define, upper case', 'DEFINE("DB_PASSWORD","hunter2");'],
  // strictness kept (the QA-023 branch relaxed these; ADR-0097 does not)
  ['named type outside a type context', 'let password: Secret;'],
  ['exported named type outside a type context', 'export let token: AuthToken;'],
  ['identifier assignment', 'this.token = token;'],
  ['Rust wrapper around a variable (not a call expression)', 'let password = String::from(value);'],
  ['arrow with a parameter list', 'const onToken = (t) => {\n  save(t);\n};'],
  ['fallback to a bare identifier', 'const password = process.env.PW ?? defaultPassword;'],
];

const STRICT_PASS_CASES: Array<[string, string]> = [
  ['bracket env reference', 'token = os.environ["API_TOKEN"]'],
  ['getenv without a default', 'password = os.getenv("DB_PW")'],
  ['getenv with an empty default', 'password = os.getenv("DB_PW", "")'],
  ['getenv with a None default', 'password = os.getenv("DB_PW", None)'],
  ['os.environ.get without a default', 'password = os.environ.get("DB_PW")'],
  ['ENV.fetch without a default', 'password = ENV.fetch("DB_PW")'],
  ['env() helper without a default', "secret: env('APP_SECRET'),"],
  ['placeholder', 'password: ${DB_PASSWORD}'],
  ['token count', 'maxTokens: 4096'],
  ['nested YAML mapping', 'password:\n  rotation: 30d'],
  ['block-bodied arrow', 'const useAuth = () => {\n return 1;\n};'],
  ['function type', 'tokenSource: () => Promise<string>;'],
  ['async block arrow with a return type', 'const fetchToken = async (): Promise<string> => {\n  return fetch(url);\n};'],
  ['async arrow returning a call', 'const getToken = async () => fetchToken();'],
  ['type alias of a function type', 'type TokenFactory = () => Token;'],
  ['wrapper around an env reference', 'password = SecretStr(os.environ["PW"])'],
  ['wrapper around a call', 'password = str(get_pw())'],
  ['Buffer.from with a variable', 'const password = Buffer.from(raw, "base64").toString()'],
  ['statement ends at the line break', 'const token = getToken()\nconst name = "bob";'],
  ['statement ends at a semicolon', 'const token = getToken(); const name = "bob";'],
  ['line comment after a call', 'const token = getToken() // "comment"'],
  ['hash comment after a call', 'token = get_token()  # see "docs"'],
  ['trailing comment ending in an operator does not continue', 'const token = getToken() // TODO:\nconst name = "bob";'],
  ['comment line after a statement', 'const token = getToken()\n// "note"\nconst name = "bob";'],
  ['doc block comment after a statement', 'const token = getToken()\n/**\n * docs "q"\n */\nexport const name = "bob";'],
  ['blank and comment lines then a new statement', 'const token = getToken()\n\n// a\n/* b */\nconst name = "bob";'],
  ['empty fallback', 'const password = process.env.PW ?? ""'],
  ['env fallback to env', 'const password = process.env.A ?? process.env.B;'],
  ['chained call on the next line', 'const token = getToken()\n  .trim();'],
  ['parenthesised env lookup across lines', 'password = (\n  os.getenv("PW")\n)'],
  ['array of calls across lines', 'tokens = [\n  getA(),\n  getB(),\n]'],
  ['array of references and keywords', 'tokens = [getA(), process.env.B, null]'],
  ['array of calls with comments', 'tokens = [\n  getA(), // primary\n  /* backup */ getB(),\n]'],
  ['call arguments are not array elements', 'password = getPw() + join(a, b)'],
  ['object element without a literal after it', 'tokens = [{ id: 1 }]'],
  ['parenthesised await', 'password = (await getPw())'],
  ['empty array', 'password = [\n]'],
  ['keyword then the next key', 'auth: true\npassword: null\n'],
  ['Go untyped const is the generic rule', 'const MaxTokens int = 4096'],
  ['Go typed var from an env lookup', 'var password string = os.Getenv("PW")'],
  ['Go typed var without a value', 'var token string'],
  ['Go grouped var from an env lookup', 'var (\n\tPassword string = os.Getenv("PW")\n)'],
  ['Go struct field with a tag', 'type Cfg struct {\n\tPassword string `json:"password"`\n}'],
  ['C# property without an initializer, then another property', 'public string Password { get; set; }\npublic string Name { get; set; } = "x";'],
  ['C# auto-property without an initializer', 'public string Password { get; set; }'],
  ['PHP define from getenv', 'define("DB_PASSWORD", getenv("DB_PASSWORD"));'],
  ['PHP define of a non-credential', 'define("APP_NAME", "quoky");'],
];

/**
 * ADR-0097 strict-only guard: the refusal-adding QA-023 fixes re-implemented on the strict rule. Every
 * "refuses" row below PASSED the pre-ADR-0097 guard (a bypass); no row may be relaxed. The hardening only
 * adds refusals: the guard also refuses everything the frozen `d99d19c` guard refused (see the
 * monotonicity tests below), so the quote-aware call-argument scan cannot drop a baseline refusal such as
 * `getPw(") ?? hunter2")`.
 */
describe('containsCredentialFileContent strict-only hardening (ADR-0097)', () => {
  it.each(STRICT_REFUSE_CASES)('refuses %s', (_label, content) => {
    expect(containsCredentialFileContent(content)).toBe(true);
    expect(classifyCredentialFileContent(content)).toMatchObject({ kind: 'credential-assignment' });
  });

  it.each(STRICT_PASS_CASES)('passes %s', (_label, content) => {
    expect(containsCredentialFileContent(content)).toBe(false);
    expect(classifyCredentialFileContent(content)).toEqual({ kind: 'none' });
  });
});

const LINE_CASES: Array<[string, string, number]> = [
  ['first line', 'password = "x"\n', 1],
  ['third line', 'const a = 1;\nconst b = 2;\nconst password = "x";\n', 3],
  ['first refusing key, not the first credential key', 'const token = getToken();\nconst password = "x";\n', 2],
  ['quoted JSON key', '{\n  "user": "a",\n  "password": "x"\n}\n', 3],
  ['key line of a multi-line value', '// header\n\npassword = (\n  ""\n  "x"\n)\n', 3],
  ['CRLF line endings', 'a = 1\r\nb = 2\r\npassword = "x"\r\n', 3],
  ['typed declaration before a generic match', 'package main\nconst Password string = "x"\npassword = "y"\n', 2],
  ['generic match before a typed declaration', 'password = "y"\nconst Password string = "x"\n', 1],
  ['PHP define line', '<?php\n\ndefine("DB_PASSWORD", "x");\n', 3],
  ['Go grouped declaration member line', 'package main\n\nvar (\n\tName string = "a"\n\tPassword string = "x"\n)\n', 5],
  ['fallback after a comment line reports the key line', 'const password = process.env.PW\n  // dev\n  ?? "x";\n', 1],
];

describe('classifyCredentialFileContent', () => {
  it('returns none for plain source', () => {
    expect(classifyCredentialFileContent('export const add = (a: number, b: number) => a + b;\n')).toEqual({
      kind: 'none',
    });
    expect(classifyCredentialFileContent('')).toEqual({ kind: 'none' });
  });

  it('reports secret-token for a PEM block or vendor token, taking precedence over an assignment', () => {
    expect(classifyCredentialFileContent('-----BEGIN RSA PRIVATE KEY-----\nabc\n')).toEqual({ kind: 'secret-token' });
    expect(
      classifyCredentialFileContent('password = "hunter2"\nconst gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n'),
    ).toEqual({ kind: 'secret-token' });
  });

  it.each(LINE_CASES)('reports credential-assignment with the 1-based line: %s', (_label, content, line) => {
    expect(classifyCredentialFileContent(content)).toEqual({ kind: 'credential-assignment', line });
    expect(containsCredentialFileContent(content)).toBe(true);
  });

  it('never carries the matched text', () => {
    const finding = classifyCredentialFileContent('password = "do-not-echo"\n');
    expect(JSON.stringify(finding)).not.toContain('do-not-echo');
  });
});

/**
 * ADR-0097 monotonicity: the file guard may only ADD refusals to the frozen `d99d19c` guard
 * (`credential-guard-baseline.ts`). Differential over every table above, the cases the quote-aware call
 * scan used to drop, and a generated key × operator × value corpus: new refusals ⊇ baseline refusals.
 */
describe('containsCredentialFileContent monotonicity over the d99d19c baseline (ADR-0097)', () => {
  /** Baseline refusals the quote-aware closing-bracket scan dropped (Codex wave-1 review). */
  const DROPPED_BY_QUOTE_AWARE_SCAN: Array<[string, string]> = [
    ['Codex review case', 'password = getPw(") ?? hunter2")'],
    ['quoted fallback inside the argument', 'const password = getPw(")??\\"x\\"")'],
    ['or-fallback inside the argument', 'password = get_pw(") or hunter2")'],
    ['bare fallback inside a single-quoted argument', "const token = load(') ?? fallbackToken')"],
    ['logical or inside the argument', 'secret = read(") || dev-secret")'],
  ];
  const VALUES = [
    '"hunter2"', "'x'", '""', 'hunter2', 'getPw()', 'getPw(")")', 'getPw(") ?? hunter2")', 'getPw("(") ?? x',
    'process.env.PW', 'process.env.PW ?? "x"', 'process.env.PW ?? ""', 'os.getenv("PW", "x")', 'os.getenv("PW")',
    '${PW}', '"${PW}"', 'null', 'true', '4096', '[getA(), b]', '("" +\n  "x")', '() => "x"', '(t) => t',
    'SecretStr("x")', 'Buffer.from(raw)', 'string', 'Secret', 'a ? "b" : c', 'getPw() // "c"', '{ a: 1 }',
    'f(g(")"), "x")', 'f(`)`) + "x"', "f(')') or 'x'",
  ];
  const KEYS = ['password', 'token', 'apiKey', 'db_secret', '"password"', 'maxTokens', 'author'];
  const OPERATORS = [' = ', ': ', ' := ', ' => ', '='];
  const GENERATED: Array<[string, string]> = KEYS.flatMap((key) =>
    OPERATORS.flatMap((op) => VALUES.map((value): [string, string] => [`${key}${op}${value}`, `${key}${op}${value}`])),
  );
  const CORPUS: Array<[string, string]> = [
    ...FILE_REFUSE_CASES,
    ...FILE_PASS_CASES,
    ...STRICT_REFUSE_CASES,
    ...STRICT_PASS_CASES,
    ...LINE_CASES.map(([label, content]): [string, string] => [label, content]),
    ...DROPPED_BY_QUOTE_AWARE_SCAN,
    ...GENERATED,
  ];

  it('the baseline is the frozen d99d19c rule (pinned by hash; edit credential-guard.ts instead)', () => {
    const source = readFileSync(join(__dirname, 'credential-guard-baseline.ts'), 'utf8');
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '47c4c94cfe6b9f4b5ab8234230d416df5a99105850a75a4e7ae4325128636e75',
    );
  });

  it.each(DROPPED_BY_QUOTE_AWARE_SCAN)('still refuses a baseline refusal: %s', (_label, content) => {
    expect(baselineFileContentRefusal(content)).toMatchObject({ kind: 'credential-assignment' });
    expect(containsCredentialFileContent(content)).toBe(true);
    expect(classifyCredentialFileContent(content)).toEqual({ kind: 'credential-assignment', line: 1 });
  });

  it('every baseline refusal is still refused, with a detector at least as specific and a line no later', () => {
    const violations: string[] = [];
    let baselineRefusals = 0;
    for (const [label, content] of CORPUS) {
      const baseline = baselineFileContentRefusal(content);
      if (!baseline) continue;
      baselineRefusals++;
      const finding = classifyCredentialFileContent(content);
      if (!containsCredentialFileContent(content) || finding.kind === 'none') {
        violations.push(label);
        continue;
      }
      if (baseline.kind === 'secret-token' && finding.kind !== 'secret-token') violations.push(`${label} (detector)`);
      if (baseline.kind === 'credential-assignment' && finding.kind === 'credential-assignment') {
        const baselineLine = content.slice(0, baseline.offset).split('\n').length;
        if (finding.line > baselineLine) violations.push(`${label} (line ${finding.line} > ${baselineLine})`);
      }
    }
    expect(violations).toEqual([]);
    expect(baselineRefusals).toBeGreaterThan(100); // the differential is not vacuous
  });

  it('the existing pass tables stay passing (the baseline adds no refusal there)', () => {
    for (const [label, content] of [...FILE_PASS_CASES, ...STRICT_PASS_CASES]) {
      expect({ label, baseline: baselineFileContentRefusal(content) }).toEqual({ label, baseline: null });
    }
  });
});

/**
 * Bounded time on untrusted input (Discord attachments run this synchronously on up to 256 KiB): the key scans
 * backtrack quadratically on a long key-token run before an operator and on a long blank run after a key, which held
 * the event loop for about a minute on `"AAAA…A="`. Such shapes refuse instead of being scanned.
 */
describe('classifyCredentialFileContent is bounded-time on adversarial 256 KiB input', () => {
  const SIZE = 256 * 1024;
  /** Generous wall-clock bound (the unbounded scan took ~60 s on the first case; bounded runs take tens of ms). */
  const BOUND_MS = 1_500;
  const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const timed = (content: string) => {
    const started = performance.now();
    const finding = classifyCredentialFileContent(content);
    const material = containsCredentialMaterial(content);
    return { finding, material, ms: performance.now() - started };
  };

  it.each<[string, string]>([
    ['a base64-like run ending in "="', `${'A'.repeat(SIZE)}=`],
    ['a base64-like run ending in ":"', `${'A'.repeat(SIZE)}:`],
    ['a long blank run after a key', `a${' '.repeat(SIZE)}`],
    ['a long blank run around "?" after a key', `a${'\t'.repeat(SIZE / 2)}?${'\t'.repeat(SIZE / 2)}`],
  ])('refuses %s quickly (fail closed)', (_label, content) => {
    const { finding, ms } = timed(content);
    expect(finding).toEqual({ kind: 'credential-assignment', line: 1 });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it.each<[string, string]>([
    ['keys just under the bound, each assigned', fill(`${'A'.repeat(CREDENTIAL_SCAN_MAX_RUN)}=\n`)],
    ['blank runs just under the bound after keys', fill(`a${' '.repeat(CREDENTIAL_SCAN_MAX_RUN)}\n`)],
    ['blank runs after quoted keys', fill(`"a"${' '.repeat(CREDENTIAL_SCAN_MAX_RUN)}\n`)],
    ['a long key run with no operator', `${'A'.repeat(SIZE)} text`],
    ['a long Go-style typed key (scanned: the camel-case split is linear)', `\nconst ${'A'.repeat(SIZE)} string = "x"`],
    ['ordinary log lines', fill('2026-10-06T00:00:00Z INFO worker=3 status=ok elapsed_ms=12 path=/v1/items\n')],
    ['wrapped base64 lines with padding', fill('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo+/0123456789abcdefghijklmnopqrstuvwxyzAB==\n')],
  ])('passes %s quickly', (_label, content) => {
    const { finding, ms } = timed(content);
    expect(finding).toEqual({ kind: 'none' });
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('only refuses an oversized key run that is followed by an assignment operator', () => {
    const run = 'A'.repeat(CREDENTIAL_SCAN_MAX_RUN + 1);
    expect(classifyCredentialFileContent(`${run}=`)).toEqual({ kind: 'credential-assignment', line: 1 });
    expect(classifyCredentialFileContent(`${'A'.repeat(CREDENTIAL_SCAN_MAX_RUN)}=`)).toEqual({ kind: 'none' });
    expect(classifyCredentialFileContent(`${run} done`)).toEqual({ kind: 'none' });
    expect(classifyCredentialFileContent(`${run}==`)).toEqual({ kind: 'none' });
  });

  it('still reports an earlier credential key at its own line, and a secret token as secret-token', () => {
    const blob = `${'A'.repeat(SIZE)}=`;
    expect(classifyCredentialFileContent(`a\npassword = "hunter2"\n${blob}`)).toEqual({ kind: 'credential-assignment', line: 2 });
    expect(classifyCredentialFileContent(`a\nb\n${blob}`)).toEqual({ kind: 'credential-assignment', line: 3 });
    expect(classifyCredentialFileContent(`${blob}\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n`)).toEqual({ kind: 'secret-token' });
  });

  it('splits camel-case keys exactly as before (linear split)', () => {
    for (const key of ['APIKey', 'DBPassword', 'XMLHttpToken', 'myAPIToken', 'AUTHToken', 'maxTOKENS']) {
      expect({ key, refused: containsCredentialFileContent(`${key} = "x"`) }).toEqual({
        key,
        refused: baselineFileContentRefusal(`${key} = "x"`) !== null,
      });
    }
  });
});

describe('detection view: invisible and control characters cannot split a credential (ADR-0097, ADR-0111 re-review)', () => {
  const VALUE = 'demo-review-value';
  const SPLITTERS: ReadonlyArray<readonly [string, string]> = [
    ['U+200B zero-width space', '\u200B'],
    ['U+200C zero-width non-joiner', '\u200C'],
    ['U+200D zero-width joiner', '\u200D'],
    ['U+2060 word joiner', '\u2060'],
    ['U+202E right-to-left override', '\u202E'],
    ['U+2066 left-to-right isolate', '\u2066'],
    ['U+FEFF byte order mark', '\uFEFF'],
    ['U+00AD soft hyphen', '\u00AD'],
    ['U+FE0F variation selector', '\uFE0F'],
    ['U+E0101 variation selector supplement', '\u{E0101}'],
    ['U+034F combining grapheme joiner', '\u034F'],
    ['CR', '\r'],
    ['NUL', '\u0000'],
    ['U+0085 C1 next line', '\u0085'],
    ['U+009B C1 CSI', '\u009B'],
    ['DEL', '\u007F'],
  ];

  it.each(SPLITTERS)('%s inside the keyword: chat and file detectors both refuse', (_label, ch) => {
    const chat = 'my pass' + ch + 'word=' + VALUE;
    const file = 'db_pass' + ch + 'word = "' + VALUE + '"\n';
    expect(containsCredentialMaterial(chat)).toBe(true);
    expect(containsCredentialFileContent(file)).toBe(true);
    expect(classifyCredentialFileContent(file)).toEqual({ kind: 'credential-assignment', line: 1 });
  });

  it.each(SPLITTERS)('%s inside a token prefix: chat and file detectors both refuse', (_label, ch) => {
    const token = 's' + ch + 'k-' + 'A'.repeat(24);
    const ghToken = 'gh' + ch + 'p_' + 'b'.repeat(36);
    expect(containsCredentialMaterial('key ' + token)).toBe(true);
    expect(containsCredentialMaterial('key ' + ghToken)).toBe(true);
    expect(classifyCredentialFileContent('KEY = ' + token + '\n')).toEqual({ kind: 'secret-token' });
  });

  it('NFKC: full-width keyword and token prefix are refused', () => {
    expect(containsCredentialMaterial('ｐａｓｓｗｏｒｄ=' + VALUE)).toBe(true);
    expect(containsCredentialMaterial('ｓｋ－' + 'A'.repeat(24))).toBe(true);
  });

  it('keeps line numbers: a split keyword on line 3 reports line 3, even with CRLF endings', () => {
    const content = 'a = 1\r\nb = 2\r\napi_' + '\u200B' + 'key = "' + VALUE + '"\r\n';
    expect(classifyCredentialFileContent(content)).toEqual({ kind: 'credential-assignment', line: 3 });
  });

  it('is detection only: the view strips invisibles, the caller keeps the original text', () => {
    const original = 'pass' + '\u200B' + 'word=' + VALUE;
    expect(credentialDetectionView(original)).toBe('password=' + VALUE);
    expect(credentialDetectionView('line 1\n\tline 2')).toBe('line 1\n\tline 2');
    expect(original).toContain('\u200B');
  });

  it('refusal-adding only: a match on the original text is never lost to the view', () => {
    // Removing NUL would glue the prefix to the preceding letter and break `\bsk-`; the original still matches.
    expect(containsCredentialMaterial('x' + '\u0000' + 'sk-' + 'A'.repeat(24))).toBe(true);
  });

  it('does not refuse harmless text that merely contains invisible characters', () => {
    expect(containsCredentialMaterial('hello' + '\u200B' + 'world, 비밀' + '\u200C' + '번호 정책 문서')).toBe(false);
    expect(containsCredentialFileContent('const greeting = ' + '\uFEFF' + 'getGreeting();\n')).toBe(false);
  });
});
