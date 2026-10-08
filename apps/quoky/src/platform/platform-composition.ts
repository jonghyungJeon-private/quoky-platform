import { TELEGRAM_PLATFORM, TelegramPlatformAdapter } from '@quoky/adapter-telegram';
import type { TelegramStartupErrorCode } from '@quoky/adapter-telegram';
import type { TelegramAdapterOptions } from '@quoky/adapter-telegram';
import type { Logger, PlatformAdapter } from '@quoky/core';
import type { PlatformIdentityLink } from '../actor-identity-provisioner';
import type { TelegramConfig } from '../telegram/telegram-config';
import { telegramOffsetStoreFor } from '../telegram/telegram-offset-store';
import { CompositePlatformAdapter } from './composite-platform-adapter';

/**
 * ADR-0114 D6/D13: the adapter bound to `PLATFORM_ADAPTER`. With Telegram off (no `config.telegram`) it is the Discord
 * adapter itself, exactly as before; nothing Telegram-related is constructed. With Telegram on it is one composite over
 * Discord (primary) and Telegram.
 */
export function composePlatformAdapter(
  discord: PlatformAdapter,
  telegram: TelegramConfig | undefined,
  deps: {
    readonly logger: (scope: string) => Logger;
    /** The database path: the poll offset is persisted beside it (`ops/telegram-offset.json`). */
    readonly dbPath: string;
    readonly telegramOptions?: TelegramAdapterOptions;
  },
): PlatformAdapter {
  if (telegram === undefined) return discord;
  const adapter = new TelegramPlatformAdapter(
    { token: telegram.token, expectedBotId: telegram.expectedBotId, ownerIds: telegram.ownerIds },
    deps.logger('telegram'),
    { offsetStore: telegramOffsetStoreFor(deps.dbPath, telegram.expectedBotId), ...deps.telegramOptions },
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

/**
 * ADR-0114 (TG-1, CA re-review P3-3): route each Telegram halt (conflict, rejected token, identity mismatch, loop
 * failure) to `listener` once, so the owner hears about it on Discord. `false` when Telegram is not composed.
 */
export function onTelegramHalt(platform: PlatformAdapter, listener: (code: TelegramStartupErrorCode) => void): boolean {
  const telegram = platform instanceof CompositePlatformAdapter ? platform.adapterFor(TELEGRAM_PLATFORM) : undefined;
  if (!(telegram instanceof TelegramPlatformAdapter)) return false;
  telegram.onHalt(listener);
  return true;
}

/**
 * CA final check #3: a Telegram halt can fire before Discord is READY (the startup identity block has not finished),
 * when the owner DM would be `NOT_SENT NOT_CONNECTED` after the `OPS_NOTICE` ledger already took a slot, so the notice
 * would be lost. Halt codes are held until {@link HaltNoticeBuffer.release} (called once Discord is verified and the
 * operations runtime started), then forwarded in order; after that they pass straight through.
 */
export interface HaltNoticeBuffer {
  readonly listener: (code: TelegramStartupErrorCode) => void;
  release(): void;
}

export function haltNoticeBuffer(notify: (code: TelegramStartupErrorCode) => void): HaltNoticeBuffer {
  let held: TelegramStartupErrorCode[] | undefined = [];
  return {
    listener: (code) => {
      if (held !== undefined) held.push(code);
      else notify(code);
    },
    release: () => {
      const pending = held ?? [];
      held = undefined;
      for (const code of pending) notify(code);
    },
  };
}
