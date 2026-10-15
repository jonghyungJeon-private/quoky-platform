import type { Provider } from '@nestjs/common';
import {
  ActorMetadataStore,
  NOTIFICATION_SINK,
  STORAGE_PROVIDER,
  SurfaceGate,
  SurfaceGrantService,
  newId,
  parseSurfaceChannelKey,
  renderSurfaceSeedApplied,
  renderSurfaceSeedReAdded,
  type Actor,
  type ConversationContext,
  type Logger,
  type NotificationSink,
  type StorageProvider,
  type SurfaceGrantSeedResult,
} from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import type { ChannelGrantsConfig } from '../surface-grants/channel-grants-config';

/**
 * ADR-0122 (A9 P1) — surface permission grants, feature composition. Binds `SURFACE_GRANTS` to the Core gate (mode from
 * `QUOKY_CHANNEL_GRANTS`, P1 default `off`) and the grant service over the live `storage.actors` repository through the
 * ONE per-actor metadata lock (`ActorMetadataStore`, the same lock the A6 switch and the D7 preferences use). The runtime
 * receives it as its optional `surfaceGrants` dep (ADR-0032 baseline 36 → 37); `main.ts` applies the deploy seed after
 * the identity provisioner; `QuokyCore` drops a reaction in a channel without `memory` (only while `enforce`).
 */

export const SURFACE_GRANTS = Symbol('SurfaceGrants');

export interface SurfaceGrantsFeatureConfig {
  readonly channelGrants: ChannelGrantsConfig;
  /** `QUOKY_DISCORD_OWNER_IDS` (ADR-0091). */
  readonly discordOwnerIds: readonly string[];
  /** `QUOKY_TELEGRAM_OWNER_IDS` when Telegram is on (ADR-0114). */
  readonly telegramOwnerIds: readonly string[];
}

export interface SurfaceGrantsComposition {
  readonly gate: SurfaceGate;
  readonly service: SurfaceGrantService;
  /** Present only while `enforce`: whether a feedback reaction in this conversation may be recorded (`memory`). */
  readonly reactionAllowed?: (context: ConversationContext) => Promise<boolean>;
  /** D6: apply the configured seed once per digest (only while `enforce`); a no-op without a seed. */
  applySeed(now: string): Promise<readonly SurfaceGrantSeedResult[]>;
  /** D6: the owner DM line of each channel the last `applySeed` added groups to (call once the platform is up). */
  deliverSeedReceipts(): Promise<void>;
}

export interface SurfaceGrantsCompositionOptions {
  readonly logger?: Logger;
}

const DISCORD_PLATFORM = 'discord';
const TELEGRAM_PLATFORM = 'telegram';

/** D3 owner check: the actor holds the message's identity and that identity is a configured owner id. */
export function surfaceOwnerCheck(config: Pick<SurfaceGrantsFeatureConfig, 'discordOwnerIds' | 'telegramOwnerIds'>) {
  return (actor: Pick<Actor, 'identities'>, context: Pick<ConversationContext, 'platform' | 'userId'>): boolean => {
    const holds = actor.identities.some((identity) => identity.platform === context.platform && identity.externalId === context.userId);
    if (!holds) return false;
    if (context.platform === DISCORD_PLATFORM) return config.discordOwnerIds.includes(context.userId);
    if (context.platform === TELEGRAM_PLATFORM) return config.telegramOwnerIds.includes(context.userId);
    return false;
  };
}

export function createSurfaceGrantsComposition(
  config: SurfaceGrantsFeatureConfig,
  storage: StorageProvider,
  sink: NotificationSink | undefined,
  logger: Logger,
): SurfaceGrantsComposition {
  // The live repository, dereferenced at call time (the SQLite repositories exist only after `storage.init()`).
  const metadata = new ActorMetadataStore({
    get: (id) => storage.actors.get(id),
    save: (actor) => storage.actors.save(actor),
  });
  const gate = new SurfaceGate(config.channelGrants.mode, logger);
  const service = new SurfaceGrantService({
    metadata,
    isOwner: surfaceOwnerCheck(config),
    logger,
    ...(sink !== undefined ? { notify: (notification) => sink.deliver(notification) } : {}),
  });
  const enforced = config.channelGrants.mode === 'enforce';
  const pendingReceipts: { readonly target: ConversationContext; readonly text: string }[] = [];
  const reactionAllowed = enforced
    ? async (context: ConversationContext): Promise<boolean> => {
        try {
          const actor = await storage.actors.findByExternalIdentity(context.platform, context.userId);
          // Fail closed: no owner Actor means nothing to record against anyway.
          if (actor === null) return context.direct === true;
          return gate.decide(context, actor, ['memory'], { path: 'reaction' }).allow;
        } catch {
          return false;
        }
      }
    : undefined;
  return {
    gate,
    service,
    ...(reactionAllowed !== undefined ? { reactionAllowed } : {}),
    async applySeed(now: string): Promise<readonly SurfaceGrantSeedResult[]> {
      const seed = config.channelGrants.seed;
      if (seed === undefined) return [];
      if (!enforced) {
        logger.warn('surface_grant.seed_not_applied', { reason: 'channel-grants-off' });
        return [];
      }
      const results: SurfaceGrantSeedResult[] = [];
      pendingReceipts.length = 0;
      const seen = new Set<string>();
      for (const ownerId of config.discordOwnerIds) {
        const actor = await storage.actors.findByExternalIdentity(DISCORD_PLATFORM, ownerId);
        if (actor === null) {
          // A fresh install has no owner Actor before the first message: the seed applies on the next start.
          logger.warn('surface_grant.seed_skipped', { reason: 'no-owner-actor' });
          continue;
        }
        if (seen.has(actor.id)) continue;
        seen.add(actor.id);
        const target: ConversationContext = { platform: DISCORD_PLATFORM, channelId: '', userId: ownerId, direct: true };
        const result = await service.applySeed(actor.id, seed, now);
        if (result === undefined) continue;
        results.push(result);
        for (const channel of result.added) {
          const channelId = parseSurfaceChannelKey(channel.key)?.channelId ?? '';
          const reAdded = result.reAdded.find((entry) => entry.key === channel.key);
          pendingReceipts.push({
            target,
            text: reAdded !== undefined ? renderSurfaceSeedReAdded(channelId, reAdded.groups) : renderSurfaceSeedApplied(channelId, channel.groups),
          });
        }
      }
      return results;
    },
    async deliverSeedReceipts(): Promise<void> {
      const receipts = pendingReceipts.splice(0);
      if (sink === undefined) return;
      for (const receipt of receipts) {
        try {
          await sink.deliver({ correlationId: newId(), target: receipt.target, kind: 'SURFACE_GRANT', text: receipt.text });
        } catch (error) {
          logger.warn('surface_grant.receipt_failed', { errorName: error instanceof Error ? error.name : typeof error });
        }
      }
    },
  };
}

export function createSurfaceGrantsProviders(
  resolveConfig: () => SurfaceGrantsFeatureConfig,
  options: SurfaceGrantsCompositionOptions = {},
): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('surface-grants');
  return [
    {
      provide: SURFACE_GRANTS,
      useFactory: (storage: StorageProvider, sink?: NotificationSink): SurfaceGrantsComposition => {
        const config = resolveConfig();
        if (config.channelGrants.mode === 'off') {
          logger.warn('surface_grants.off', { explicit: config.channelGrants.explicit, seedConfigured: config.channelGrants.seed !== undefined });
        }
        return createSurfaceGrantsComposition(config, storage, sink, logger);
      },
      inject: [STORAGE_PROVIDER, { token: NOTIFICATION_SINK, optional: true }],
    },
  ];
}
