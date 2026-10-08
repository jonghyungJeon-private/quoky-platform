import { newId } from '../util/id';
import { now } from '../util/clock';
import type { Actor, ConversationContext } from '../domain';
import type { StorageProvider } from '../ports';

/**
 * Resolves the acting principal for a conversation (ADR-0009). v1 is thin: a
 * platform user is mapped to a local Actor, created on first contact. No teams,
 * no permissions.
 */
export class ActorManager {
  constructor(private readonly storage: StorageProvider) {}

  /** Find the Actor for this context's platform user, creating one if absent. */
  async resolveFromContext(context: ConversationContext): Promise<Actor> {
    const existing = await this.storage.actors.findByExternalIdentity(
      context.platform,
      context.userId,
    );
    if (existing) return existing;

    const actor: Actor = {
      id: newId(),
      // TODO(1b): enrich from the platform profile (e.g. the chat display name).
      displayName: context.userId,
      identities: [{ platform: context.platform, externalId: context.userId }],
      createdAt: now(),
    };
    return this.storage.actors.save(actor);
  }
}
