import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GDRIVE_OAUTH_TOKEN_URL,
  DRIVE_READONLY_SCOPE,
  assertDriveReadonlyScope,
  buildGDriveConsentUrl,
  createGDrivePkcePair,
  exchangeGDriveAuthorizationCode,
} from './oauth';
import { GDriveTokenFileError, readGDriveTokenFile, writeGDriveTokenFile } from './token-file';

const REFRESH = 'fixture-refresh-value';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-gdrive-token-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GDriveTokenFileError);
    expect((error as Error).message).not.toContain(REFRESH);
    return (error as GDriveTokenFileError).code;
  }
  return undefined;
}

describe('Drive OAuth (ADR-0118 D3, DRV-1): drive.readonly and nothing else', () => {
  it('the consent URL asks for drive.readonly only, offline, consent shown, no incremental grant, PKCE S256', () => {
    const pkce = createGDrivePkcePair();
    const url = new URL(
      buildGDriveConsentUrl({ clientId: 'fixture-client', redirectUri: 'http://127.0.0.1:53682/oauth2callback', state: 'st', codeChallenge: pkce.challenge }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(DRIVE_READONLY_SCOPE);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(() => buildGDriveConsentUrl({ clientId: 'c', redirectUri: 'https://example.com/cb', state: 's', codeChallenge: 'x' })).toThrow();
  });

  it('accepts exactly drive.readonly; refuses a missing scope and any additional or broader scope', () => {
    expect(assertDriveReadonlyScope(DRIVE_READONLY_SCOPE)).toBe(DRIVE_READONLY_SCOPE);
    expect(() => assertDriveReadonlyScope(undefined)).toThrow(expect.objectContaining({ kind: 'MISSING', reason: 'INSUFFICIENT_SCOPE' }));
    expect(() => assertDriveReadonlyScope('')).toThrow(expect.objectContaining({ kind: 'MISSING' }));
    for (const extra of [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.metadata',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/drive.appdata',
      'https://www.googleapis.com/auth/gmail.readonly',
      CALENDAR_SCOPE,
      'openid',
    ]) {
      expect(() => assertDriveReadonlyScope(`${DRIVE_READONLY_SCOPE} ${extra}`), extra).toThrow(
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
      exchangeGDriveAuthorizationCode({ clientId: 'c', clientSecret: 's' }, exchange, { fetchImpl: respond(DRIVE_READONLY_SCOPE), timeoutMs: 1000 }),
    ).resolves.toEqual({ refreshToken: REFRESH, scope: DRIVE_READONLY_SCOPE });
    await expect(
      exchangeGDriveAuthorizationCode({ clientId: 'c', clientSecret: 's' }, exchange, {
        fetchImpl: respond(`${DRIVE_READONLY_SCOPE} https://www.googleapis.com/auth/drive`),
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: 'TOO_BROAD' });
    expect(posts).toEqual([`${GDRIVE_OAUTH_TOKEN_URL} POST`, `${GDRIVE_OAUTH_TOKEN_URL} POST`]);
  });
});

describe('Drive token file (ADR-0118 D3, the ADR-0110 D2 pattern): one grant set, mode 600', () => {
  it('writes a NEW mode-600 file recording gmail.readonly and reads the refresh token back', () => {
    const path = join(dir, 'drive.json');
    writeGDriveTokenFile(path, REFRESH);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, scope: DRIVE_READONLY_SCOPE, refresh_token: REFRESH });
    expect(readGDriveTokenFile(path)).toBe(REFRESH);
    expect(codeOf(() => writeGDriveTokenFile(path, REFRESH))).toBe('GDRIVE_TOKEN_FILE_EXISTS');
  });

  it('never records or accepts another grant set (a calendar or Gmail token file is refused)', () => {
    expect(codeOf(() => writeGDriveTokenFile(join(dir, 'x.json'), REFRESH, CALENDAR_SCOPE))).toBe('GDRIVE_TOKEN_FILE_INVALID');
    const calendarFile = join(dir, 'calendar.json');
    writeFileSync(calendarFile, JSON.stringify({ version: 1, scope: CALENDAR_SCOPE, refresh_token: REFRESH }), { mode: 0o600 });
    chmodSync(calendarFile, 0o600);
    expect(codeOf(() => readGDriveTokenFile(calendarFile))).toBe('GDRIVE_TOKEN_FILE_INVALID');
    const gmailFile = join(dir, 'gmail.json');
    writeFileSync(gmailFile, JSON.stringify({ version: 1, scope: 'https://www.googleapis.com/auth/gmail.readonly', refresh_token: REFRESH }), { mode: 0o600 });
    chmodSync(gmailFile, 0o600);
    expect(codeOf(() => readGDriveTokenFile(gmailFile))).toBe('GDRIVE_TOKEN_FILE_INVALID');
  });

  it('refuses group/other permissions, a symlink, a missing file and malformed content', () => {
    const open = join(dir, 'open.json');
    writeFileSync(open, JSON.stringify({ version: 1, scope: DRIVE_READONLY_SCOPE, refresh_token: REFRESH }));
    chmodSync(open, 0o644);
    expect(codeOf(() => readGDriveTokenFile(open))).toBe('GDRIVE_TOKEN_FILE_PERMISSIONS');
    chmodSync(open, 0o600);
    const link = join(dir, 'link.json');
    symlinkSync(open, link);
    expect(codeOf(() => readGDriveTokenFile(link))).toBe('GDRIVE_TOKEN_FILE_NOT_REGULAR');
    expect(codeOf(() => readGDriveTokenFile(join(dir, 'missing.json')))).toBe('GDRIVE_TOKEN_FILE_UNREADABLE');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"version":1,"scope":"x"', { mode: 0o600 });
    chmodSync(bad, 0o600);
    expect(codeOf(() => readGDriveTokenFile(bad))).toBe('GDRIVE_TOKEN_FILE_INVALID');
  });
});
