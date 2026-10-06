import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_CALENDAR_READONLY_SCOPE } from './oauth';
import {
  GoogleCalendarTokenFileError,
  readGoogleCalendarTokenFile,
  writeGoogleCalendarTokenFile,
} from './token-file';

const TOKEN = '1//refresh-token-value';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-calendar-token-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleCalendarTokenFileError);
    expect((error as Error).message).not.toContain(TOKEN);
    return (error as GoogleCalendarTokenFileError).code;
  }
  return undefined;
}

function writeRaw(name: string, content: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

describe('Google Calendar token file (ADR-0110 D2)', () => {
  it('writes a new mode-600 file and reads the refresh token back', () => {
    const path = join(dir, 'token.json');
    writeGoogleCalendarTokenFile(path, TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      scope: GOOGLE_CALENDAR_READONLY_SCOPE,
      refresh_token: TOKEN,
    });
    expect(readGoogleCalendarTokenFile(path)).toBe(TOKEN);
  });

  it('records a calendar.readonly + calendar.events grant and reads it back; refuses to write a broader grant', () => {
    const both = `${GOOGLE_CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/calendar.events`;
    const path = join(dir, 'token-events.json');
    writeGoogleCalendarTokenFile(path, TOKEN, both);
    expect(JSON.parse(readFileSync(path, 'utf8')).scope).toBe(both);
    expect(readGoogleCalendarTokenFile(path)).toBe(TOKEN);
    expect(
      codeOf(() => writeGoogleCalendarTokenFile(join(dir, 'broad.json'), TOKEN, `${both} https://www.googleapis.com/auth/calendar`)),
    ).toBe('CALENDAR_TOKEN_FILE_INVALID');
    expect(existsSync(join(dir, 'broad.json'))).toBe(false);
    // Only the normalized form the writer produces is read back.
    const reversed = JSON.stringify({ version: 1, scope: both.split(' ').reverse().join(' '), refresh_token: TOKEN });
    expect(codeOf(() => readGoogleCalendarTokenFile(writeRaw('rev.json', reversed)))).toBe('CALENDAR_TOKEN_FILE_INVALID');
  });

  it('never overwrites an existing file', () => {
    const path = writeRaw('token.json', 'keep me');
    expect(codeOf(() => writeGoogleCalendarTokenFile(path, TOKEN))).toBe('CALENDAR_TOKEN_FILE_EXISTS');
    expect(readFileSync(path, 'utf8')).toBe('keep me');
  });

  it('refuses to write an implausible token', () => {
    expect(codeOf(() => writeGoogleCalendarTokenFile(join(dir, 'a.json'), 'has space'))).toBe('CALENDAR_TOKEN_FILE_INVALID');
    expect(codeOf(() => writeGoogleCalendarTokenFile(join(dir, 'b.json'), ''))).toBe('CALENDAR_TOKEN_FILE_INVALID');
  });

  it('refuses a file group or others can read or write', () => {
    const content = JSON.stringify({ version: 1, scope: GOOGLE_CALENDAR_READONLY_SCOPE, refresh_token: TOKEN });
    expect(codeOf(() => readGoogleCalendarTokenFile(writeRaw('g.json', content, 0o640)))).toBe('CALENDAR_TOKEN_FILE_PERMISSIONS');
    expect(codeOf(() => readGoogleCalendarTokenFile(writeRaw('o.json', content, 0o604)))).toBe('CALENDAR_TOKEN_FILE_PERMISSIONS');
    expect(readGoogleCalendarTokenFile(writeRaw('r.json', content, 0o400))).toBe(TOKEN);
  });

  it('refuses a symlink, a directory and a missing file', () => {
    const real = join(dir, 'real.json');
    writeGoogleCalendarTokenFile(real, TOKEN);
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    expect(codeOf(() => readGoogleCalendarTokenFile(link))).toBe('CALENDAR_TOKEN_FILE_NOT_REGULAR');
    expect(codeOf(() => readGoogleCalendarTokenFile(dir))).toBe('CALENDAR_TOKEN_FILE_NOT_REGULAR');
    expect(codeOf(() => readGoogleCalendarTokenFile(join(dir, 'missing.json')))).toBe('CALENDAR_TOKEN_FILE_UNREADABLE');
  });

  it('refuses malformed content, another scope, another version and an oversized file', () => {
    expect(codeOf(() => readGoogleCalendarTokenFile(writeRaw('a.json', 'not json')))).toBe('CALENDAR_TOKEN_FILE_INVALID');
    expect(codeOf(() => readGoogleCalendarTokenFile(writeRaw('b.json', JSON.stringify({ refresh_token: TOKEN }))))).toBe(
      'CALENDAR_TOKEN_FILE_INVALID',
    );
    expect(
      codeOf(() =>
        readGoogleCalendarTokenFile(
          writeRaw('c.json', JSON.stringify({ version: 1, scope: 'https://www.googleapis.com/auth/calendar', refresh_token: TOKEN })),
        ),
      ),
    ).toBe('CALENDAR_TOKEN_FILE_INVALID');
    expect(
      codeOf(() =>
        readGoogleCalendarTokenFile(writeRaw('d.json', JSON.stringify({ version: 2, scope: GOOGLE_CALENDAR_READONLY_SCOPE, refresh_token: TOKEN }))),
      ),
    ).toBe('CALENDAR_TOKEN_FILE_INVALID');
    expect(codeOf(() => readGoogleCalendarTokenFile(writeRaw('e.json', 'x'.repeat(17 * 1024))))).toBe('CALENDAR_TOKEN_FILE_TOO_LARGE');
  });
});
