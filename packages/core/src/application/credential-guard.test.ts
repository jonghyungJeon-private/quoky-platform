import { describe, expect, it } from 'vitest';
import { containsCredentialFileContent, containsCredentialMaterial } from './credential-guard';

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

describe('containsCredentialFileContent (code-generation context)', () => {
  it.each([
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
  ])('flags %s', (_label, content) => {
    expect(containsCredentialFileContent(content)).toBe(true);
  });

  it.each([
    ['token from a call', 'const token = getToken();'],
    ['TS type annotation', 'interface Login {\n  password: string;\n  token?: string\n}'],
    ['bare type line', '  password: string\n'],
    ['comparison', 'if (password === input) return true;'],
    ['env reference', 'const token = process.env.API_TOKEN\n'],
    ['dotted reference', 'token = settings.API_TOKEN\n'],
    ['placeholder', 'password: ${DB_PASSWORD}\n'],
    ['quoted placeholder', '{"password": "${DB_PASSWORD}"}'],
    ['self-named value', "const fields = { password: 'password' };"],
    ['label with spaces', 'placeholder: "Enter your password",\npassword: "비밀번호 입력"'],
    ['empty literal', 'let token = "";'],
    ['Korean prose', '# 설정\n비밀번호는 환경 변수로 넣어 주세요.\n토큰이 만료되면 다시 로그인해요.'],
    ['GPIO pin config', 'led:\n  pin: 13\n'],
    ['16-digit numeric literal', 'const ns = 1234567890123456;'],
    ['plain source', 'export function add(a: number, b: number) {\n  return a + b;\n}\n'],
  ])('passes %s', (_label, content) => {
    expect(containsCredentialFileContent(content)).toBe(false);
  });
});
