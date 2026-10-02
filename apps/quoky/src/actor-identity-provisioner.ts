import type { Actor, ExternalIdentity, Logger, StorageProvider } from '@quoky/core';
import { ConsoleLogger } from './console-logger';
import type { ActorIdentityMapping } from './config';

/** App-private startup service for explicit, additive links to existing Actors. */
export class ActorIdentityProvisioner {
  constructor(
    private readonly storage: StorageProvider,
    private readonly mappings: readonly ActorIdentityMapping[],
    private readonly log: Logger = new ConsoleLogger('actor-identity'),
  ) {}

  async provision(): Promise<void> {
    const plans = new Map<string, { actor: Actor; additions: ExternalIdentity[]; targets: Map<string, string> }>();
    const claimedTargets = new Map<string, string>();

    for (const [index, mapping] of this.mappings.entries()) {
      const actor = await this.storage.actors.findByExternalIdentity(
        mapping.actor.platform,
        mapping.actor.externalId,
      );
      if (!actor) {
        // The Actor is created on the owner's first inbound message, so a fresh install has none yet.
        // Skip (never crash startup); the mapping applies on the next start. Only the index is logged.
        this.log.warn(
          'skipped QUOKY_ACTOR_IDENTITY_MAPPINGS entry: no matching Actor yet (message the bot once, then restart)',
          { platform: mapping.actor.platform, mappingIndex: index },
        );
        continue;
      }
      const plan = plans.get(actor.id) ?? { actor, additions: [], targets: new Map<string, string>() };
      plans.set(actor.id, plan);

      for (const platform of ['jira', 'github'] as const) {
        const externalId = mapping.identities[platform];
        if (externalId === undefined) continue;
        const planned = plan.targets.get(platform);
        if (planned !== undefined && planned !== externalId) {
          throw new Error(`ACTOR_IDENTITY_PROVISIONING_PLATFORM_CONFLICT:${platform}`);
        }
        plan.targets.set(platform, externalId);

        const existingForPlatform = actor.identities.filter((identity) => identity.platform === platform);
        if (existingForPlatform.some((identity) => identity.externalId !== externalId)) {
          throw new Error(`ACTOR_IDENTITY_PROVISIONING_PLATFORM_CONFLICT:${platform}`);
        }

        const targetKey = `${platform}\u0000${externalId}`;
        const claimedBy = claimedTargets.get(targetKey);
        if (claimedBy !== undefined && claimedBy !== actor.id) {
          throw new Error(`ACTOR_IDENTITY_PROVISIONING_TARGET_CONFLICT:${platform}:${externalId}`);
        }
        claimedTargets.set(targetKey, actor.id);

        const owner = await this.storage.actors.findByExternalIdentity(platform, externalId);
        if (owner && owner.id !== actor.id) {
          throw new Error(`ACTOR_IDENTITY_PROVISIONING_TARGET_CONFLICT:${platform}:${externalId}`);
        }
        if (!existingForPlatform.some((identity) => identity.externalId === externalId)
          && !plan.additions.some((identity) => identity.platform === platform && identity.externalId === externalId)) {
          plan.additions.push({ platform, externalId });
        }
      }
    }

    // All mappings are preflighted before the first write, so configuration conflicts cannot partially apply.
    for (const plan of [...plans.values()].sort((left, right) => left.actor.id.localeCompare(right.actor.id))) {
      if (plan.additions.length === 0) continue;
      await this.storage.actors.save({
        ...plan.actor,
        identities: [...plan.actor.identities, ...plan.additions],
      });
    }
  }
}
