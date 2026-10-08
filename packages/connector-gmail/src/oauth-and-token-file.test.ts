import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GMAIL_OAUTH_TOKEN_URL,
  GMAIL_READONLY_SCOPE,
  assertGmailReadonlyScope,
  buildGmailConsentUrl,
  createGmailPkcePair,
  exchangeGmailAuthorizationCode,
} from './oauth';
import { GmailTokenFileError, readGmailTokenFile, writeGmailTokenFile } from './token-file';

const REFRESH = 'fixture-refresh-value';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-gmail-token-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GmailTokenFileError);
    expect((error as Error).message).not.toContain(REFRESH);
    return (error as GmailTokenFileError).code;
  }
  return undefined;
}

describe('Gmail OAuth (ADR-0118 D3): gmail.readonly and nothing else', () => {
  it('the consent URL asks for gmail.readonly only, offline, consent shown, no incremental grant, PKCE S256', () => {
    const pkce = createGmailPkcePair();
    const url = new URL(
      buildGmailConsentUrl({ clientId: 'fixture-client', redirectUri: 'http://127.0.0.1:53682/oauth2callback', state: 'st', codeChallenge: pkce.challenge }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(() => buildGmailConsentUrl({ clientId: 'c', redirectUri: 'https://example.com/cb', state: 's', codeChallenge: 'x' })).toThrow();
  });

  it('accepts exactly gmail.readonly; refuses a missing scope and any additional or broader scope', () => {
    expect(assertGmailReadonlyScope(GMAIL_READONLY_SCOPE)).toBe(GMAIL_READONLY_SCOPE);
    expect(() => assertGmailReadonlyScope(undefined)).toThrow(expect.objectContaining({ kind: 'MISSING', reason: 'INSUFFICIENT_SCOPE' }));
    expect(() => assertGmailReadonlyScope('')).toThrow(expect.objectContaining({ kind: 'MISSING' }));
    for (const extra of [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://mail.google.com/',
      CALENDAR_SCOPE,
      'openid',
    ]) {
      expect(() => assertGmailReadonlyScope(`${GMAIL_READONLY_SCOPE} ${extra}`), extra).toThrow(
        expect.objectContaining({ kind: 'TOO_BROAD', reason: 'FORBIDDEN' }),
      );
    }
  });

  it('the code exchange posts once to the token endpoint and returns the read-only grant; a broader grant is refused', async () => {
    const posts: string[] = [];
    const respond = (scope: string) =>
      (async (input: URL | RequestInfo, init?: RequestInit) => {
        posts.push(`${String(input)} ${init?.method}`);
        return new Response(JSON.stringify({ access_token: 'fixture-access-value', refresh_token: REFRESH, expires_in: 3599, scope }), { status: 200 });
      }) as typeof fetch;
    const exchange = { code: 'fixture-code', codeVerifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:1/cb' };
    await expect(
      exchangeGmailAuthorizationCode({ clientId: 'c', clientSecret: 's' }, exchange, { fetchImpl: respond(GMAIL_READONLY_SCOPE), timeoutMs: 1000 }),
    ).resolves.toEqual({ refreshToken: REFRESH, scope: GMAIL_READONLY_SCOPE });
    await expect(
      exchangeGmailAuthorizationCode({ clientId: 'c', clientSecret: 's' }, exchange, {
        fetchImpl: respond(`${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.send`),
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: 'TOO_BROAD' });
    expect(posts).toEqual([`${GMAIL_OAUTH_TOKEN_URL} POST`, `${GMAIL_OAUTH_TOKEN_URL} POST`]);
  });
});

describe('Gmail token file (ADR-0118 D3, the ADR-0110 D2 pattern): one grant set, mode 600', () => {
  it('writes a NEW mode-600 file recording gmail.readonly and reads the refresh token back', () => {
    const path = join(dir, 'gmail.json');
    writeGmailTokenFile(path, REFRESH);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, scope: GMAIL_READONLY_SCOPE, refresh_token: REFRESH });
    expect(readGmailTokenFile(path)).toBe(REFRESH);
    expect(codeOf(() => writeGmailTokenFile(path, REFRESH))).toBe('GMAIL_TOKEN_FILE_EXISTS');
  });

  it('never records or accepts another grant set (a calendar token file is refused)', () => {
    expect(codeOf(() => writeGmailTokenFile(join(dir, 'x.json'), REFRESH, CALENDAR_SCOPE))).toBe('GMAIL_TOKEN_FILE_INVALID');
    const calendarFile = join(dir, 'calendar.json');
    writeFileSync(calendarFile, JSON.stringify({ version: 1, scope: CALENDAR_SCOPE, refresh_token: REFRESH }), { mode: 0o600 });
    chmodSync(calendarFile, 0o600);
    expect(codeOf(() => readGmailTokenFile(calendarFile))).toBe('GMAIL_TOKEN_FILE_INVALID');
  });

  it('refuses group/other permissions, a symlink, a missing file and malformed content', () => {
    const open = join(dir, 'open.json');
    writeFileSync(open, JSON.stringify({ version: 1, scope: GMAIL_READONLY_SCOPE, refresh_token: REFRESH }));
    chmodSync(open, 0o644);
    expect(codeOf(() => readGmailTokenFile(open))).toBe('GMAIL_TOKEN_FILE_PERMISSIONS');
    chmodSync(open, 0o600);
    const link = join(dir, 'link.json');
    symlinkSync(open, link);
    expect(codeOf(() => readGmailTokenFile(link))).toBe('GMAIL_TOKEN_FILE_NOT_REGULAR');
    expect(codeOf(() => readGmailTokenFile(join(dir, 'missing.json')))).toBe('GMAIL_TOKEN_FILE_UNREADABLE');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"version":1,"scope":"x"', { mode: 0o600 });
    chmodSync(bad, 0o600);
    expect(codeOf(() => readGmailTokenFile(bad))).toBe('GMAIL_TOKEN_FILE_INVALID');
  });
});
