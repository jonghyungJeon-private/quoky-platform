import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../bootstrap-preflight';
import { loadConfig, QuokyConfigErrorCode } from '../config';
import { startupExitCode, QuokyExitCode } from '../ops/exit-codes';
import { TelegramStartupError, TelegramStartupErrorCode } from '@quoky/adapter-telegram';
import { TelegramConfigErrorCode } from './telegram-config';

const DISCORD_OWNER = '111111111111111111';
const BOT_ID = ['70', '01', '23', '4'].join('');
/** Runtime-built token pieces (no token-shaped literal in source). */
const SECRET = ['AAH', 'cfg', '_', 'k'.repeat(15), '-', 'm'.repeat(14)].join('');
const TOKEN = [BOT_ID, SECRET].join(':');
const TG_OWNER = '5550001';

function telegramEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    QUOKY_DISCORD_OWNER_IDS: DISCORD_OWNER,
    QUOKY_TELEGRAM_ENABLED: 'true',
    QUOKY_TELEGRAM_BOT_TOKEN: TOKEN,
    QUOKY_TELEGRAM_EXPECTED_BOT_ID: BOT_ID,
    QUOKY_TELEGRAM_OWNER_IDS: TG_OWNER,
    QUOKY_TELEGRAM_OWNER_ACTOR_MAP: `${TG_OWNER}=${DISCORD_OWNER}`,
    ...overrides,
  };
  for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
  return base as NodeJS.ProcessEnv;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('Telegram configuration (ADR-0114 D13)', () => {
  it('is off by default and with the flag false: no other Telegram key is read (even malformed ones)', () => {
    expect(loadConfig({ QUOKY_DISCORD_OWNER_IDS: DISCORD_OWNER }).telegram).toBeUndefined();
    expect(loadConfig(telegramEnv({ QUOKY_TELEGRAM_ENABLED: 'false', QUOKY_TELEGRAM_BOT_TOKEN: 'garbage' })).telegram).toBeUndefined();
    expect('telegram' in loadConfig({ QUOKY_DISCORD_OWNER_IDS: DISCORD_OWNER })).toBe(false);
  });

  it('parses a complete configuration; the token is a redacted holder everywhere the config is printed', () => {
    const config = loadConfig(telegramEnv());
    expect(config.telegram).toMatchObject({
      expectedBotId: BOT_ID,
      ownerIds: [TG_OWNER],
      ownerActorMap: [{ telegramId: TG_OWNER, discordOwnerId: DISCORD_OWNER }],
    });
    expect(config.telegram?.token.reveal()).toBe(TOKEN);
    for (const surface of [JSON.stringify(config), inspect(config, { depth: 10 }), JSON.stringify({ ...config.telegram })]) {
      expect(surface).not.toContain(SECRET);
    }
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    ['a non-boolean flag', { QUOKY_TELEGRAM_ENABLED: 'yes' }, TelegramConfigErrorCode.TELEGRAM_ENABLED_INVALID],
    ['an empty flag', { QUOKY_TELEGRAM_ENABLED: '' }, TelegramConfigErrorCode.TELEGRAM_ENABLED_INVALID],
    ['no token', { QUOKY_TELEGRAM_BOT_TOKEN: undefined }, TelegramConfigErrorCode.TELEGRAM_BOT_TOKEN_MISSING],
    ['a malformed token', { QUOKY_TELEGRAM_BOT_TOKEN: `bot${TOKEN}` }, TelegramConfigErrorCode.TELEGRAM_BOT_TOKEN_INVALID],
    ['a quoted token', { QUOKY_TELEGRAM_BOT_TOKEN: `"${TOKEN}"` }, TelegramConfigErrorCode.TELEGRAM_BOT_TOKEN_INVALID],
    ['no expected bot id', { QUOKY_TELEGRAM_EXPECTED_BOT_ID: undefined }, TelegramConfigErrorCode.TELEGRAM_EXPECTED_BOT_ID_MISSING],
    ['a malformed expected bot id', { QUOKY_TELEGRAM_EXPECTED_BOT_ID: '@quoky_bot' }, TelegramConfigErrorCode.TELEGRAM_EXPECTED_BOT_ID_INVALID],
    ['a token of another bot', { QUOKY_TELEGRAM_EXPECTED_BOT_ID: '8009876' }, TelegramConfigErrorCode.TELEGRAM_TOKEN_BOT_ID_MISMATCH],
    ['no owner ids', { QUOKY_TELEGRAM_OWNER_IDS: ' ' }, TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_MISSING],
    ['a username as owner id', { QUOKY_TELEGRAM_OWNER_IDS: '@owner' }, TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_INVALID],
    ['a negative (group) id', { QUOKY_TELEGRAM_OWNER_IDS: '-1001234' }, TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_INVALID],
    ['an empty entry', { QUOKY_TELEGRAM_OWNER_IDS: `${TG_OWNER},` }, TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_INVALID],
    ['the bot as owner', { QUOKY_TELEGRAM_OWNER_IDS: BOT_ID }, TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_INVALID],
    ['no actor map', { QUOKY_TELEGRAM_OWNER_ACTOR_MAP: undefined }, TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INCOMPLETE],
    [
      'an unmapped owner',
      { QUOKY_TELEGRAM_OWNER_IDS: `${TG_OWNER},5550002` },
      TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INCOMPLETE,
    ],
    ['a malformed map entry', { QUOKY_TELEGRAM_OWNER_ACTOR_MAP: `${TG_OWNER}:${DISCORD_OWNER}` }, TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INVALID],
    [
      'a map entry for a non-owner Telegram id',
      { QUOKY_TELEGRAM_OWNER_ACTOR_MAP: `${TG_OWNER}=${DISCORD_OWNER},5550009=${DISCORD_OWNER}` },
      TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INVALID,
    ],
    [
      'a duplicate map entry',
      { QUOKY_TELEGRAM_OWNER_ACTOR_MAP: `${TG_OWNER}=${DISCORD_OWNER},${TG_OWNER}=${DISCORD_OWNER}` },
      TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INVALID,
    ],
    [
      'a map to a non-owner Discord id',
      { QUOKY_TELEGRAM_OWNER_ACTOR_MAP: `${TG_OWNER}=999999999999999999` },
      TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_NOT_DISCORD_OWNER,
    ],
  ])('%s is a typed, value-free startup error', (_label, overrides, code) => {
    let message = '';
    try {
      loadConfig(telegramEnv(overrides));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(codeOf(() => loadConfig(telegramEnv(overrides)))).toBe(code);
    expect(message).toBe(code);
    expect(message).not.toContain(SECRET);
    // Every code is a configuration exit (78) with a hint that names variables, never a value.
    const failure = describeStartupFailure(new Error(code));
    expect(failure.message).toBe(code);
    expect(failure.hint).toMatch(/QUOKY_TELEGRAM_/);
    expect(startupExitCode(failure)).toBe(QuokyExitCode.CONFIGURATION);
    expect(Object.values(QuokyConfigErrorCode)).toContain(code);
  });
});

describe('Telegram startup refusals (ADR-0114 D4/D5): hints and exit codes', () => {
  it.each([
    [TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH, QuokyExitCode.CONFIGURATION],
    [TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED, QuokyExitCode.CONFIGURATION],
    [TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT, QuokyExitCode.CONFIGURATION],
    [TelegramStartupErrorCode.TELEGRAM_IDENTITY_UNVERIFIABLE, QuokyExitCode.FAILURE],
  ])('%s exits %i with a remediation hint', (code, exit) => {
    const failure = describeStartupFailure(new TelegramStartupError(code));
    expect(failure.message).toBe(code);
    expect(failure.hint).toBeTruthy();
    expect(startupExitCode(failure)).toBe(exit);
  });
});
