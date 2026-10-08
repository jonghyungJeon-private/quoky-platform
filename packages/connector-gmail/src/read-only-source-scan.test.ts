import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0118 D3/D6 source scan: the Gmail adapter can only call read endpoints. Every non-test source file of the package
 * is read and checked, so a later change that adds a write call, a write scope or a second request site fails here
 * (the runtime guard `assertGmailReadRequest` is the other half).
 */
const dir = new URL('./', import.meta.url);
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));
/** Code with comments removed (the doc comments name the forbidden operations on purpose). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('connector-gmail read-only source scan (ADR-0118 D3/D6)', () => {
  it('scans the whole package', () => {
    expect(sources.map((source) => source.name).sort()).toEqual(['errors.ts', 'gmail-mail-reader.ts', 'index.ts', 'mime.ts', 'oauth.ts', 'token-file.ts']);
  });

  it('names no Gmail write endpoint or write operation', () => {
    const forbidden = [
      /\/send\b/,
      /\/drafts\b/,
      /\/modify\b/,
      /\/batchModify\b/,
      /\/batchDelete\b/,
      /\/trash\b/,
      /\/untrash\b/,
      /\/labels\b/,
      /\/import\b/,
      /\/insert\b/,
      /\/watch\b/,
      /\/stop\b/,
      /\/settings\b/,
      /\/attachments\b/,
      /\/history\b/,
      /\/threads\b/,
      /uploadType/,
    ];
    for (const { name, text } of sources) {
      for (const pattern of forbidden) expect(code(text), `${name} ${pattern}`).not.toMatch(pattern);
    }
  });

  it('uses only GET for the Gmail API; the single POST is the OAuth token request', () => {
    const methods = sources.flatMap(({ name, text }) =>
      [...code(text).matchAll(/method:\s*'([A-Z]+)'|const method = '([A-Z]+)'/g)].map((match) => `${name}:${match[1] ?? match[2]}`),
    );
    expect(methods.sort()).toEqual(['gmail-mail-reader.ts:GET', 'oauth.ts:POST']);
    for (const { name, text } of sources) {
      expect(code(text), name).not.toMatch(/'(?:PUT|PATCH|DELETE)'/);
    }
    const oauth = code(sources.find((source) => source.name === 'oauth.ts')?.text ?? '');
    expect(oauth).toMatch(/fetchImpl\(GMAIL_OAUTH_TOKEN_URL,/);
  });

  it('has exactly two request sites: the token POST and the guarded GET', () => {
    const sites = sources.flatMap(({ name, text }) => [...code(text).matchAll(/\bfetchImpl\(/g)].map(() => name));
    expect(sites.sort()).toEqual(['gmail-mail-reader.ts', 'oauth.ts']);
    const reader = code(sources.find((source) => source.name === 'gmail-mail-reader.ts')?.text ?? '');
    // The GET site asserts the read-only allowlist before it sends.
    expect(reader).toMatch(/assertGmailReadRequest\(url, method\);\s*try \{\s*return await this\.fetchImpl\(url,/);
    expect(code(sources.map((source) => source.text).join('\n'))).not.toMatch(/\bfetch\(/);
  });

  it('requests and accepts gmail.readonly only: no other Google scope string appears', () => {
    const scopes = sources.flatMap(({ text }) => [...text.matchAll(/https:\/\/(?:www\.googleapis\.com\/auth\/[\w.]+|mail\.google\.com\/?)/g)].map((match) => match[0]));
    expect([...new Set(scopes)]).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });

  it('pins its egress to the Gmail API and OAuth hosts', () => {
    const hosts = new Set(
      sources.flatMap(({ text }) => [...code(text).matchAll(/'https:\/\/([a-z0-9.-]+)/g)].map((match) => match[1])),
    );
    expect([...hosts].sort()).toEqual(['accounts.google.com', 'gmail.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com']);
  });
});
