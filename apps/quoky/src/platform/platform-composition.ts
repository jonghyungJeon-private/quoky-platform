import { TELEGRAM_PLATFORM, TelegramPlatformAdapter } from '@quoky/adapter-telegram';
import type { TelegramStartupError, TelegramStartupErrorCode } from '@quoky/adapter-telegram';
import type { TelegramAdapterOptions } from '@quoky/adapter-telegram';
import { LOCAL_CLIENT_PLATFORM, LocalClientPlatformAdapter } from '@quoky/adapter-local-client';
import type { LocalClientAdapterOptions, LocalClientAdapterStatus } from '@quoky/adapter-local-client';
import type { Logger, PlatformAdapter } from '@quoky/core';
import { DISCORD_NOTIFICATION_PLATFORM } from '@quoky/adapter-discord';
import { isConnectedIdentityReader } from '../ops/startup-identity-check';
import type { PlatformIdentityLink } from '../actor-identity-provisioner';
import type { TelegramConfig } from '../telegram/telegram-config';
import { telegramOffsetStoreFor } from '../telegram/telegram-offset-store';
import type { LocalClientConfig } from '../local-client/local-client-config';
import { CompositePlatformAdapter } from './composite-platform-adapter';
import type { NotificationRedirect } from './composite-platform-adapter';

/**
 * ADR-0125 D1 (LC-1b): what the composition root needs to join the local client. Present only when
 * `QUOKY_LOCAL_CLIENT_ENABLED=true`; absent, nothing local-client related is constructed.
 */
export interface LocalClientComposition {
  readonly config: LocalClientConfig;
  /** The ADR-0102 D3 host data directory (the database's directory). */
  readonly dataDir: string;
  /** ADR-0102 D4: `main.ts` took the single-instance lock. */
  readonly instanceLockHeld: boolean;
  /** The database is a file, not `:memory:`. */
  readonly fileBackedDb: boolean;
  /** `QUOKY_DISCORD_OWNER_IDS` (D5 checks the configured owner against them). */
  readonly discordOwnerIds: readonly string[];
  /** D5: the owner id maps, through the ADR-0009 seam, to exactly one Actor (called when the adapter starts). */
  readonly verifyOwner: () => Promise<boolean>;
  /** Test seams for the adapter (probe timeout, limits). */
  readonly adapterOptions?: Partial<LocalClientAdapterOptions>;
}

/**
 * ADR-0114 D6/D13 and ADR-0125 D1: the adapter bound to `PLATFORM_ADAPTER`. With Telegram and the local client off (no
 * `config.telegram`, no `deps.localClient`) it is the Discord adapter itself, exactly as before; nothing Telegram- or
 * local-client-related is constructed. Otherwise it is one composite over Discord (primary), Telegram and the local client.
 * The local client is joined only with the instance lock held and a file-backed database (D2 step 0); otherwise it is not
 * constructed and the log says why.
 */
export function composePlatformAdapter(
  discord: PlatformAdapter,
  telegram: TelegramConfig | undefined,
  deps: {
    readonly logger: (scope: string) => Logger;
    /** The database path: the poll offset is persisted beside it (`ops/telegram-offset.json`). */
    readonly dbPath: string;
    readonly telegramOptions?: TelegramAdapterOptions;
    readonly localClient?: LocalClientComposition;
  },
): PlatformAdapter {
  const children: PlatformAdapter[] = [];
  if (telegram !== undefined) {
    children.push(
      new TelegramPlatformAdapter(
        { token: telegram.token, expectedBotId: telegram.expectedBotId, ownerIds: telegram.ownerIds },
        deps.logger('telegram'),
        { offsetStore: telegramOffsetStoreFor(deps.dbPath, telegram.expectedBotId), ...deps.telegramOptions },
      ),
    );
  }
  const localClient = deps.localClient;
  let redirect: NotificationRedirect | undefined;
  if (localClient !== undefined) {
    if (!localClient.instanceLockHeld || !localClient.fileBackedDb) {
      deps.logger('platform').warn('local-client.not-composed', { reason: localClient.instanceLockHeld ? 'DB_NOT_FILE_BACKED' : 'NO_INSTANCE_LOCK' });
    } else {
      const owner = localClient.config.ownerActor;
      children.push(
        new LocalClientPlatformAdapter({
          dataDir: localClient.dataDir,
          instanceLockHeld: localClient.instanceLockHeld,
          fileBackedDb: localClient.fileBackedDb,
          ownerUserId: owner,
          ownerIsDiscordOwner: owner !== undefined && localClient.discordOwnerIds.includes(owner),
          verifyOwner: localClient.verifyOwner,
          logger: deps.logger('local-client'),
          ...localClient.adapterOptions,
        }),
      );
      // ADR-0125 D8 (LC-1b to LC-3): a reminder created in the app is delivered to the owner's Discord DM.
      redirect = {
        from: LOCAL_CLIENT_PLATFORM,
        toTarget: (target) =>
          owner === undefined ? undefined : { platform: DISCORD_NOTIFICATION_PLATFORM, channelId: target.channelId, userId: owner },
      };
    }
  }
  if (children.length === 0) return discord;
  return new CompositePlatformAdapter(discord, children, deps.logger('platform'), redirect);
}

/** ADR-0125 D5: the local-client owner id links to the configured Discord owner's Actor (the ADR-0009 seam). */
export function localClientOwnerIdentityLinks(
  localClient: LocalClientConfig | undefined,
  discordOwnerIds: readonly string[],
): PlatformIdentityLink[] {
  const owner = localClient?.ownerActor;
  if (owner === undefined || !discordOwnerIds.includes(owner)) return [];
  return [{ identity: { platform: LOCAL_CLIENT_PLATFORM, externalId: owner }, owner: { platform: DISCORD_NOTIFICATION_PLATFORM, externalId: owner } }];
}

/** ADR-0125 D12: the composed local-client adapter's content-free status, or undefined when it is not composed. */
export function localClientStatusOf(platform: PlatformAdapter | undefined): LocalClientAdapterStatus | undefined {
  const adapter = platform instanceof CompositePlatformAdapter ? platform.adapterFor(LOCAL_CLIENT_PLATFORM) : undefined;
  return adapter instanceof LocalClientPlatformAdapter ? adapter.status() : undefined;
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

/**
 * Codex final delta P2-2: release held halt notices only once the platform (Discord) is READY, independent of the
 * optional startup identity check (no `QUOKY_DISCORD_EXPECTED_BOT_ID` skips that wait). Readiness is the signal the
 * identity check uses (`readConnectedIdentity`, read-only, nothing sent), each attempt bounded by `readyTimeoutMs`. When
 * READY does not come within the bound the codes stay held — no ledger slot, no suppression — and the wait goes on,
 * releasing them on the first READY. `cancel()` ends the wait at shutdown.
 */
export function releaseWhenPlatformReady(
  platform: PlatformAdapter,
  buffer: HaltNoticeBuffer,
  options: {
    readonly readyTimeoutMs: number;
    readonly logger?: Logger;
    /** Pause between attempts that failed at once (a test seam; default the ready bound, at most 5 s). */
    readonly retryDelayMs?: number;
  },
): { readonly done: Promise<void>; cancel(): void } {
  let cancelled = false;
  let wake: () => void = () => undefined;
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const done = (async () => {
    if (!isConnectedIdentityReader(platform)) {
      buffer.release();
      return;
    }
    let warned = false;
    while (!cancelled) {
      try {
        await platform.readConnectedIdentity([], { readyTimeoutMs: options.readyTimeoutMs });
        if (!cancelled) buffer.release();
        return;
      } catch {
        if (!warned) options.logger?.warn('telegram halt notices held until discord is ready');
        warned = true;
        if (!cancelled) await pause(options.retryDelayMs ?? Math.min(options.readyTimeoutMs, 5_000));
      }
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      wake();
    },
  };
}

/**
 * ADR-0102 D5 / ADR-0114 D4 (CA final check, rule question 1): route a definitive answer of the background startup
 * identity check (before the first verification) to `listener` — the composition root's graceful shutdown with the
 * startup exit code (78). `false` when Telegram is not composed.
 */
export function onTelegramFatal(platform: PlatformAdapter, listener: (error: TelegramStartupError) => void): boolean {
  const telegram = platform instanceof CompositePlatformAdapter ? platform.adapterFor(TELEGRAM_PLATFORM) : undefined;
  if (!(telegram instanceof TelegramPlatformAdapter)) return false;
  telegram.onFatal(listener);
  return true;
}

/**
 * The exit for a fatal Telegram startup answer: the same report and exit code as a startup error thrown out of
 * `bootstrap()` (`describeStartupFailure` → `startupExitCode`, 78 for these codes), after a graceful `shutdown`.
 */
export async function exitForTelegramFatal(
  error: TelegramStartupError,
  deps: {
    readonly log: Logger;
    readonly describe: (err: unknown) => { readonly message: string; readonly hint?: string };
    readonly exitCode: (report: { readonly message: string; readonly hint?: string }) => number;
    readonly shutdown: (exitCode: number) => Promise<void>;
  },
): Promise<number> {
  const failure = deps.describe(error);
  deps.log.error('failed to start', { error: failure.message });
  if (failure.hint) deps.log.error('how to fix', { hint: failure.hint });
  const code = deps.exitCode(failure);
  await deps.shutdown(code);
  return code;
}
