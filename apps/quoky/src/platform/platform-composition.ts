import { TELEGRAM_PLATFORM, TelegramPlatformAdapter } from '@quoky/adapter-telegram';
import type { TelegramAdapterOptions } from '@quoky/adapter-telegram';
import type { Logger, PlatformAdapter } from '@quoky/core';
import type { PlatformIdentityLink } from '../actor-identity-provisioner';
import type { TelegramConfig } from '../telegram/telegram-config';
import { CompositePlatformAdapter } from './composite-platform-adapter';

/**
 * ADR-0114 D6/D13: the adapter bound to `PLATFORM_ADAPTER`. With Telegram off (no `config.telegram`) it is the Discord
 * adapter itself, exactly as before; nothing Telegram-related is constructed. With Telegram on it is one composite over
 * Discord (primary) and Telegram.
 */
export function composePlatformAdapter(
  discord: PlatformAdapter,
  telegram: TelegramConfig | undefined,
  deps: { readonly logger: (scope: string) => Logger; readonly telegramOptions?: TelegramAdapterOptions },
): PlatformAdapter {
  if (telegram === undefined) return discord;
  const adapter = new TelegramPlatformAdapter(
    { token: telegram.token, expectedBotId: telegram.expectedBotId, ownerIds: telegram.ownerIds },
    deps.logger('telegram'),
    deps.telegramOptions,
  );
  return new CompositePlatformAdapter(discord, [adapter], deps.logger('platform'));
}

/**
 * ADR-0114 D3: each Telegram owner id links to the configured Discord owner's Actor (the ADR-0009 seam), so the
 * runtime's `(platform, userId)` lookup resolves a Telegram turn to that same Actor. Empty with Telegram off.
 */
export function telegramOwnerIdentityLinks(telegram: TelegramConfig | undefined): PlatformIdentityLink[] {
  return (telegram?.ownerActorMap ?? []).map((link) => ({
    identity: { platform: TELEGRAM_PLATFORM, externalId: link.telegramId },
    owner: { platform: 'discord', externalId: link.discordOwnerId },
  }));
}
