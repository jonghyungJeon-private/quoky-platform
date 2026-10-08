import { newId, now } from '@quoky/core';
import type { Actor, ExternalIdentity, Logger, StorageProvider } from '@quoky/core';
import { ConsoleLogger } from './console-logger';
import type { ActorIdentityMapping } from './config';

/**
 * ADR-0114 D3 (the ADR-0009 seam): a chat-platform identity that IS the configured owner of another platform — the
 * Telegram owner id linked to the Discord owner's Actor. Composition-root configuration, never inferred.
 */
export interface PlatformIdentityLink {
  readonly identity: ExternalIdentity;
  readonly owner: ExternalIdentity;
}

/** App-private startup service for explicit, additive links to existing Actors. */
export class ActorIdentityProvisioner {
  constructor(
    private readonly storage: StorageProvider,
    private readonly mappings: readonly ActorIdentityMapping[],
    private readonly log: Logger = new ConsoleLogger('actor-identity'),
    private readonly platformLinks: readonly PlatformIdentityLink[] = [],
  ) {}

  async provision(): Promise<void> {
    const plans = new Map<string, ProvisioningPlan>();
    // ADR-0114 D3 links are planned first, with the mappings below, and nothing is written until every link and
    // mapping passed its preflight (CA P3-2): a configuration conflict never partially applies.
    const createdByOwner = await this.planPlatformLinks(plans);
    const claimedTargets = new Map<string, string>();

    for (const [index, mapping] of this.mappings.entries()) {
      const actor =
        (await this.storage.actors.findByExternalIdentity(mapping.actor.platform, mapping.actor.externalId)) ??
        createdByOwner.get(`${mapping.actor.platform}\u0000${mapping.actor.externalId}`) ??
        null;
      if (!actor) {
        // The Actor is created on the owner's first inbound message, so a fresh install has none yet.
        // Skip (never crash startup); the mapping applies on the next start. Only the index is logged.
        this.log.warn(
          'skipped QUOKY_ACTOR_IDENTITY_MAPPINGS entry: no matching Actor yet (message the bot once, then restart)',
          { platform: mapping.actor.platform, mappingIndex: index },
        );
        continue;
      }
      const plan = plans.get(actor.id) ?? { actor, additions: [], targets: new Map<string, string>(), created: false };
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

    // All links and mappings are preflighted before the first write, so configuration conflicts cannot partially apply.
    for (const plan of [...plans.values()].sort((left, right) => left.actor.id.localeCompare(right.actor.id))) {
      if (plan.additions.length === 0 && !plan.created) continue;
      await this.storage.actors.save({
        ...plan.actor,
        identities: [...plan.actor.identities, ...plan.additions],
      });
    }
  }

  /**
   * ADR-0114 D3 (planning only, no write): every linked identity (a Telegram owner id) resolves to the owner Actor of
   * its configured Discord owner id, so actor-scoped memory, to-dos, reminders and learning follow the owner across
   * platforms and no second Actor is ever created for the owner. Runs at startup before the platform starts, so the
   * first Telegram turn already finds the link:
   * - the link already holds: nothing changes;
   * - the identity belongs to ANOTHER Actor (for example after the map was pointed at another Discord owner): a startup
   *   error `ACTOR_IDENTITY_PROVISIONING_TARGET_CONFLICT:<platform>` (configuration, exit 78), never a silent merge;
   * - the Discord owner has no Actor yet (a fresh install): the owner Actor is planned with both identities, exactly the
   *   Actor the first Discord turn would have created (the `ActorManager` shape), plus the link.
   * Errors carry the platform only, never an id. Returns the planned new Actors by `<platform>\0<owner id>`.
   */
  private async planPlatformLinks(plans: Map<string, ProvisioningPlan>): Promise<Map<string, Actor>> {
    const created = new Map<string, Actor>();
    for (const link of this.platformLinks) {
      const ownerKey = `${link.owner.platform}\u0000${link.owner.externalId}`;
      const linked = await this.storage.actors.findByExternalIdentity(link.identity.platform, link.identity.externalId);
      const owner = (await this.storage.actors.findByExternalIdentity(link.owner.platform, link.owner.externalId)) ?? created.get(ownerKey) ?? null;
      if (linked && owner && linked.id === owner.id) continue;
      if (linked) throw new Error(`ACTOR_IDENTITY_PROVISIONING_TARGET_CONFLICT:${link.identity.platform}`);
      const identity = { platform: link.identity.platform, externalId: link.identity.externalId };
      if (owner) {
        const plan = plans.get(owner.id) ?? { actor: owner, additions: [], targets: new Map<string, string>(), created: false };
        plans.set(owner.id, plan);
        if (!plan.actor.identities.concat(plan.additions).some((known) => known.platform === identity.platform && known.externalId === identity.externalId)) {
          plan.additions.push(identity);
        }
        continue;
      }
      const actor: Actor = {
        id: newId(),
        displayName: link.owner.externalId,
        identities: [{ platform: link.owner.platform, externalId: link.owner.externalId }],
        createdAt: now(),
      };
      created.set(ownerKey, actor);
      plans.set(actor.id, { actor, additions: [identity], targets: new Map<string, string>(), created: true });
    }
    return created;
  }
}

interface ProvisioningPlan {
  readonly actor: Actor;
  readonly additions: ExternalIdentity[];
  readonly targets: Map<string, string>;
  /** A new owner Actor planned by an ADR-0114 D3 link on a fresh install (saved even with no other addition). */
  readonly created: boolean;
}
