import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../bootstrap-preflight';
import { loadConfig, QuokyConfigErrorCode, resolveEnvFilePath } from '../config';
import { startupExitCode } from './exit-codes';

const OWNER = '111111111111111111';
const BOT = '888888888888888888';
const base = { QUOKY_DISCORD_OWNER_IDS: OWNER } as NodeJS.ProcessEnv;

function configError(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error('expected a config error');
}

describe('ADR-0102 host runtime configuration (SUB-1)', () => {
  it('defaults: no launcher, zero recent starts, no identity expectation', () => {
    const config = loadConfig(base);
    expect(config.host).toEqual({ recentStarts: 0 });
    expect(config.discord.expectedBotId).toBeUndefined();
  });

  it('parses the launcher-written values and QUOKY_DISCORD_EXPECTED_BOT_ID', () => {
    const config = loadConfig({
      ...base,
      QUOKY_LAUNCHER: 'launchd',
      QUOKY_LAUNCHER_RECENT_STARTS: '3',
      QUOKY_DISCORD_EXPECTED_BOT_ID: ` ${BOT} `,
    });
    expect(config.host).toEqual({ launcher: 'launchd', recentStarts: 3 });
    expect(config.discord.expectedBotId).toBe(BOT);
  });

  it('the expected bot id works outside the launcher too (blank = unset)', () => {
    expect(loadConfig({ ...base, QUOKY_DISCORD_EXPECTED_BOT_ID: BOT }).discord.expectedBotId).toBe(BOT);
    expect(loadConfig({ ...base, QUOKY_DISCORD_EXPECTED_BOT_ID: '  ' }).discord.expectedBotId).toBeUndefined();
  });

  it('under the launcher the expected bot id is required', () => {
    expect(configError({ ...base, QUOKY_LAUNCHER: 'launchd' })).toBe(QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_REQUIRED);
  });

  it.each(['123', 'abc', `${BOT},${BOT}`])('refuses a malformed expected bot id %j without echoing it', (value) => {
    expect(configError({ ...base, QUOKY_DISCORD_EXPECTED_BOT_ID: value })).toBe(
      QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_INVALID,
    );
  });

  it.each([
    { QUOKY_LAUNCHER: 'systemd' },
    { QUOKY_LAUNCHER: '' },
    { QUOKY_LAUNCHER_RECENT_STARTS: '-1' },
    { QUOKY_LAUNCHER_RECENT_STARTS: '12345' },
    { QUOKY_LAUNCHER_RECENT_STARTS: 'x' },
  ])('refuses launcher values not written by the launcher: %j', (extra) => {
    expect(configError({ ...base, ...extra })).toBe(QuokyConfigErrorCode.LAUNCHER_INVALID);
  });

  it('every new code has a remediation hint and exits with the configuration code', () => {
    for (const code of [
      QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_INVALID,
      QuokyConfigErrorCode.DISCORD_EXPECTED_BOT_ID_REQUIRED,
      QuokyConfigErrorCode.LAUNCHER_INVALID,
    ]) {
      const report = describeStartupFailure(Object.assign(new Error(code), { code }));
      expect(report).toEqual({ message: code, hint: expect.any(String) });
      expect(startupExitCode(report)).toBe(78);
    }
  });

  it('resolveEnvFilePath reads QUOKY_ENV_FILE only (blank = repository default)', () => {
    expect(resolveEnvFilePath({})).toBeUndefined();
    expect(resolveEnvFilePath({ QUOKY_ENV_FILE: ' ' })).toBeUndefined();
    expect(resolveEnvFilePath({ QUOKY_ENV_FILE: '/Users/me/quoky/.env.local' })).toBe('/Users/me/quoky/.env.local');
  });
});

describe('startupExitCode (ADR-0102 D5)', () => {
  it.each([
    'DISCORD_BOT_TOKEN_MISSING',
    'DISCORD_TOKEN_INVALID',
    'INSTANCE_ALREADY_RUNNING',
    'ENV_FILE_INSECURE',
    'DISCORD_OWNER_IDS_MISSING',
    'TIMEZONE_INVALID',
    'CONTINUATION_RECEIVER_CONTAINMENT_UNAVAILABLE',
  ])('%s is a configuration exit (78)', (message) => {
    expect(startupExitCode({ message })).toBe(78);
  });

  it.each(['INSTANCE_LOCK_UNAVAILABLE', 'DISCORD_IDENTITY_UNVERIFIABLE', 'connect ECONNREFUSED', 'boom'])(
    '%s is an ordinary failure (1) that launchd relaunches',
    (message) => {
      expect(startupExitCode({ message })).toBe(1);
    },
  );
});
