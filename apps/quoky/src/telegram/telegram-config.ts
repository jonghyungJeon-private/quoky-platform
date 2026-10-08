import { TelegramBotToken } from '@quoky/adapter-telegram';

/**
 * ADR-0114 D13: the Telegram settings, parsed and validated at startup. Kept beside `config.ts` (the reminder-config
 * precedent) so `config.ts` needs one call; the codes are merged into `QuokyConfigErrorCode`.
 *
 * `QUOKY_TELEGRAM_ENABLED` (exact `true`/`false`, default `false`) is the only switch: with it off, no other Telegram
 * variable is read and nothing Telegram-related is constructed. With it on, every other variable is required:
 * - `QUOKY_TELEGRAM_BOT_TOKEN`: the BotFather token, held as a {@link TelegramBotToken} (never echoed);
 * - `QUOKY_TELEGRAM_EXPECTED_BOT_ID`: the bot's numeric user id, which must also be the token's own prefix;
 * - `QUOKY_TELEGRAM_OWNER_IDS`: comma-separated numeric Telegram user ids (ADR-0114 D2);
 * - `QUOKY_TELEGRAM_OWNER_ACTOR_MAP`: `<telegram id>=<discord owner id>` for EVERY Telegram owner id, each to an id in
 *   `QUOKY_DISCORD_OWNER_IDS` (ADR-0114 D3).
 * Every error carries its code only, never a configured value.
 */
export const TelegramConfigErrorCode = {
  TELEGRAM_ENABLED_INVALID: 'TELEGRAM_ENABLED_INVALID',
  TELEGRAM_BOT_TOKEN_MISSING: 'TELEGRAM_BOT_TOKEN_MISSING',
  TELEGRAM_BOT_TOKEN_INVALID: 'TELEGRAM_BOT_TOKEN_INVALID',
  TELEGRAM_EXPECTED_BOT_ID_MISSING: 'TELEGRAM_EXPECTED_BOT_ID_MISSING',
  TELEGRAM_EXPECTED_BOT_ID_INVALID: 'TELEGRAM_EXPECTED_BOT_ID_INVALID',
  TELEGRAM_TOKEN_BOT_ID_MISMATCH: 'TELEGRAM_TOKEN_BOT_ID_MISMATCH',
  TELEGRAM_OWNER_IDS_MISSING: 'TELEGRAM_OWNER_IDS_MISSING',
  TELEGRAM_OWNER_IDS_INVALID: 'TELEGRAM_OWNER_IDS_INVALID',
  TELEGRAM_OWNER_ACTOR_MAP_INVALID: 'TELEGRAM_OWNER_ACTOR_MAP_INVALID',
  TELEGRAM_OWNER_ACTOR_MAP_INCOMPLETE: 'TELEGRAM_OWNER_ACTOR_MAP_INCOMPLETE',
  TELEGRAM_OWNER_ACTOR_MAP_NOT_DISCORD_OWNER: 'TELEGRAM_OWNER_ACTOR_MAP_NOT_DISCORD_OWNER',
} as const;
export type TelegramConfigErrorCode = (typeof TelegramConfigErrorCode)[keyof typeof TelegramConfigErrorCode];

/** A fail-closed Telegram configuration error; the message is the code only. Matched by `code` like `QuokyConfigError`. */
export class TelegramConfigError extends Error {
  constructor(readonly code: TelegramConfigErrorCode) {
    super(code);
    this.name = 'TelegramConfigError';
  }
}

/** One Telegram owner and the configured Discord owner whose Actor it is (ADR-0114 D3, the ADR-0009 seam). */
export interface TelegramOwnerActorLink {
  readonly telegramId: string;
  readonly discordOwnerId: string;
}

/** Present on `QuokyConfig` only when `QUOKY_TELEGRAM_ENABLED=true`. */
export interface TelegramConfig {
  readonly token: TelegramBotToken;
  readonly expectedBotId: string;
  readonly ownerIds: readonly string[];
  readonly ownerActorMap: readonly TelegramOwnerActorLink[];
}

/** A Telegram user or bot id: a positive decimal integer of at most 16 digits (52-bit ids), no sign, no leading zero. */
const TELEGRAM_ID = /^[1-9][0-9]{0,15}$/u;
const MAX_TELEGRAM_OWNERS = 16;

function fail(code: TelegramConfigErrorCode): never {
  throw new TelegramConfigError(code);
}

function present(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim().length === 0 ? undefined : raw.trim();
}

/** `undefined` when Telegram is off; the validated settings when it is on. `discordOwnerIds` is the ADR-0091 list. */
export function parseTelegramConfig(env: NodeJS.ProcessEnv, discordOwnerIds: readonly string[]): TelegramConfig | undefined {
  const flag = env.QUOKY_TELEGRAM_ENABLED;
  if (flag === undefined || flag === 'false') return undefined;
  if (flag !== 'true') fail(TelegramConfigErrorCode.TELEGRAM_ENABLED_INVALID);

  const rawToken = env.QUOKY_TELEGRAM_BOT_TOKEN;
  if (rawToken === undefined || rawToken.length === 0) fail(TelegramConfigErrorCode.TELEGRAM_BOT_TOKEN_MISSING);
  const token = TelegramBotToken.from(rawToken) ?? fail(TelegramConfigErrorCode.TELEGRAM_BOT_TOKEN_INVALID);

  const expectedBotId = present(env.QUOKY_TELEGRAM_EXPECTED_BOT_ID) ?? fail(TelegramConfigErrorCode.TELEGRAM_EXPECTED_BOT_ID_MISSING);
  if (!TELEGRAM_ID.test(expectedBotId)) fail(TelegramConfigErrorCode.TELEGRAM_EXPECTED_BOT_ID_INVALID);
  // The token names its bot: a token for another bot is refused before any network call.
  if (token.botId !== expectedBotId) fail(TelegramConfigErrorCode.TELEGRAM_TOKEN_BOT_ID_MISMATCH);

  const rawOwners = present(env.QUOKY_TELEGRAM_OWNER_IDS) ?? fail(TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_MISSING);
  const ownerEntries = rawOwners.split(',').map((entry) => entry.trim());
  if (ownerEntries.length > MAX_TELEGRAM_OWNERS || ownerEntries.some((entry) => !TELEGRAM_ID.test(entry))) {
    fail(TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_INVALID);
  }
  const ownerIds = [...new Set(ownerEntries)];
  // The bot itself is never an owner.
  if (ownerIds.includes(expectedBotId)) fail(TelegramConfigErrorCode.TELEGRAM_OWNER_IDS_INVALID);

  const rawMap = present(env.QUOKY_TELEGRAM_OWNER_ACTOR_MAP) ?? fail(TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INCOMPLETE);
  const links = new Map<string, string>();
  for (const entry of rawMap.split(',').map((part) => part.trim())) {
    const match = /^([0-9]+)=([0-9]+)$/u.exec(entry);
    const telegramId = match?.[1];
    const discordOwnerId = match?.[2];
    if (telegramId === undefined || discordOwnerId === undefined || !TELEGRAM_ID.test(telegramId)) {
      fail(TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INVALID);
    }
    // Each Telegram id maps exactly once, and only a configured Telegram owner can be mapped.
    if (links.has(telegramId) || !ownerIds.includes(telegramId)) fail(TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INVALID);
    if (!discordOwnerIds.includes(discordOwnerId)) fail(TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_NOT_DISCORD_OWNER);
    links.set(telegramId, discordOwnerId);
  }
  if (ownerIds.some((id) => !links.has(id))) fail(TelegramConfigErrorCode.TELEGRAM_OWNER_ACTOR_MAP_INCOMPLETE);

  return {
    token,
    expectedBotId,
    ownerIds,
    ownerActorMap: ownerIds.map((telegramId) => ({ telegramId, discordOwnerId: links.get(telegramId) as string })),
  };
}
