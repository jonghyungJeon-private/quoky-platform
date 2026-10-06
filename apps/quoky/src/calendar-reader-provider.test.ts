import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_READONLY_SCOPE, GoogleCalendarReader, writeGoogleCalendarTokenFile } from '@quoky/connector-calendar-google';
import type { Logger } from '@quoky/core';

import { createCalendarReader } from './calendar-reader-provider';
import { loadConfig, resolveGoogleCalendarOAuthClient } from './config';

const CLIENT_SECRET = 'client-secret-value';
const REFRESH_TOKEN = '1//refresh-token-value';

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { QUOKY_DISCORD_OWNER_IDS: '111111111111111111', ...overrides } as NodeJS.ProcessEnv;
}

const CLIENT_ENV = {
  QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
};

function testLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { info: vi.fn(), warn, error: vi.fn() }, warn };
}

function assertNothingSecretLogged(warn: ReturnType<typeof vi.fn>, extra: string[] = []): void {
  const logged = JSON.stringify(warn.mock.calls);
  for (const secret of [CLIENT_SECRET, REFRESH_TOKEN, ...extra]) expect(logged).not.toContain(secret);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-calendar-provider-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('calendar config (ADR-0110 D2/D5)', () => {
  it('is absent unless the client id, client secret and a refresh token source are all set', () => {
    expect(loadConfig(env({})).calendar).toBeUndefined();
    expect(loadConfig(env(CLIENT_ENV)).calendar).toBeUndefined();
    expect(loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: '  ', QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN })).calendar).toBeUndefined();
    expect(loadConfig(env({ QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'id', QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN })).calendar).toBeUndefined();
    expect('calendar' in loadConfig(env({}))).toBe(false);
  });

  it('parses an inline refresh token with the default primary calendar and QUOKY_TIMEZONE', () => {
    expect(loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN })).calendar).toEqual({
      google: {
        clientId: 'client-id.apps.googleusercontent.com',
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        calendarIds: ['primary'],
      },
      timeZone: 'Asia/Seoul',
    });
    expect(
      loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN, QUOKY_TIMEZONE: 'Europe/Berlin' })).calendar
        ?.timeZone,
    ).toBe('Europe/Berlin');
  });

  it('resolves a relative token file from the repository root and splits calendar ids', () => {
    const calendar = loadConfig(
      env({
        ...CLIENT_ENV,
        QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: './data/google-calendar-token.json',
        QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS: ' primary , team@group.calendar.google.com ,',
      }),
    ).calendar;
    expect(calendar?.google.tokenFile).toMatch(/\/data\/google-calendar-token\.json$/);
    expect(calendar?.google.tokenFile?.startsWith('/')).toBe(true);
    expect(calendar?.google.refreshToken).toBeUndefined();
    expect(calendar?.google.calendarIds).toEqual(['primary', 'team@group.calendar.google.com']);
  });

  it('exposes the OAuth client for the consent helper only when both values are set', () => {
    expect(resolveGoogleCalendarOAuthClient(env(CLIENT_ENV))).toEqual({
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: CLIENT_SECRET,
    });
    expect(resolveGoogleCalendarOAuthClient(env({ QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'id' }))).toBeUndefined();
  });
});

describe('createCalendarReader (composition, ADR-0110 D5)', () => {
  it('returns no reader when the calendar is not configured', () => {
    const { logger, warn } = testLogger();
    expect(createCalendarReader(undefined, logger)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('registers a Google reader from an inline token without any network call', () => {
    const { logger, warn } = testLogger();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const reader = createCalendarReader(
      loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN })).calendar,
      logger,
      { fetchImpl },
    );
    expect(reader).toBeInstanceOf(GoogleCalendarReader);
    expect(reader?.readOnly).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('registers a reader from a mode-600 token file', () => {
    const tokenFile = join(dir, 'token.json');
    writeGoogleCalendarTokenFile(tokenFile, REFRESH_TOKEN);
    const { logger, warn } = testLogger();
    const reader = createCalendarReader(
      loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: tokenFile })).calendar,
      logger,
    );
    expect(reader).toBeInstanceOf(GoogleCalendarReader);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses an unsafe or missing token file with a fixed code and no path or token in the log', () => {
    const tokenFile = join(dir, 'open.json');
    writeFileSync(tokenFile, JSON.stringify({ version: 1, scope: GOOGLE_CALENDAR_READONLY_SCOPE, refresh_token: REFRESH_TOKEN }));
    chmodSync(tokenFile, 0o644);
    const { logger, warn } = testLogger();
    expect(createCalendarReader(loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: tokenFile })).calendar, logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('calendar not registered', { reason: 'CALENDAR_TOKEN_FILE_PERMISSIONS' });

    const missing = testLogger();
    expect(
      createCalendarReader(loadConfig(env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: join(dir, 'missing.json') })).calendar, missing.logger),
    ).toBeUndefined();
    expect(missing.warn).toHaveBeenCalledWith('calendar not registered', { reason: 'CALENDAR_TOKEN_FILE_UNREADABLE' });
    assertNothingSecretLogged(warn, [dir]);
    assertNothingSecretLogged(missing.warn, [dir]);
  });

  it('refuses an inline token and a token file together', () => {
    const { logger, warn } = testLogger();
    const reader = createCalendarReader(
      loadConfig(
        env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN, QUOKY_CALENDAR_GOOGLE_TOKEN_FILE: join(dir, 'token.json') }),
      ).calendar,
      logger,
    );
    expect(reader).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('calendar not registered', { reason: 'CALENDAR_TOKEN_SOURCE_CONFLICT' });
    assertNothingSecretLogged(warn);
  });

  it('refuses calendar ids the adapter rejects without logging them', () => {
    const { logger, warn } = testLogger();
    const reader = createCalendarReader(
      loadConfig(
        env({ ...CLIENT_ENV, QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN, QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS: 'private/calendar-id' }),
      ).calendar,
      logger,
    );
    expect(reader).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('calendar not registered', { reason: 'CALENDAR_CONFIGURATION_REJECTED' });
    assertNothingSecretLogged(warn, ['private/calendar-id']);
  });
});
