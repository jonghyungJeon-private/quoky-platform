import type { Actor, Id, Metadata } from '../domain';
import { KeyedMutex } from '../util/keyed-mutex';

/**
 * ADR-0122 D3: the ONE per-actor `Actor.metadata` writer. Every key the runtime keeps on the owner Actor — the A6 kill
 * switch (`quoky.actionSwitch`), the ADR-0120 D7 interpretation preferences (`quoky.interpretationPreferences`), the
 * channel surface grants (`quoky.surfaceGrants`) and any later key — is written through
 * {@link ActorMetadataStore.updateMetadataEntry}: inside the process-wide per-actor lock the LIVE actor is re-read, only
 * that one key is replaced, and the actor is saved. So a writer that read the actor before another writer's save (a
 * preference save racing a grant revoke) can never write the other key's old value back (residual risk R4).
 *
 * A direct `actors.save` of metadata anywhere else fails the source test (`actor-metadata-store.test.ts`). Creating an
 * Actor (`ActorManager`) and the startup identity provisioner (identities only, before any metadata writer runs) are the
 * only other `actors.save` callers. The lock is one instance per process (ADR-0102 D4: one runtime per data directory).
 */

/** The live actor repository slice the store needs (resolved at call time: the SQLite repositories exist after init). */
export interface ActorMetadataRepository {
  get(id: Id): Promise<Actor | null>;
  save(actor: Actor): Promise<Actor>;
}

/** The process-wide per-actor metadata lock every {@link ActorMetadataStore} shares by default. */
export const ACTOR_METADATA_LOCK = new KeyedMutex();

export class ActorMetadataStore {
  constructor(
    private readonly actors: ActorMetadataRepository,
    private readonly lock: KeyedMutex = ACTOR_METADATA_LOCK,
  ) {}

  /**
   * Run `work` on the live actor (null when absent) under the per-actor lock, writing nothing: a writer of any metadata key
   * waits until it finishes (ADR-0122 D2.6: a channel reminder's last-moment grant check and its send). `work` must be
   * bounded by its caller.
   */
  whileLocked<T>(actorId: Id, work: (live: Actor | null) => Promise<T>): Promise<T> {
    return this.lock.run(`actor:${actorId}`, async () => work(await this.actors.get(actorId)));
  }

  /** The live actor (no lock: a read). */
  get(actorId: Id): Promise<Actor | null> {
    return this.actors.get(actorId);
  }

  /**
   * Replace ONE metadata key of the live actor under the per-actor lock. `update` receives the key's live value and
   * returns the next one (`undefined` removes the key). `fallback` is used when the repository has no such actor (a test
   * seam and the first turn of a fresh install); without it a missing actor is left alone (`null`). Returns the saved
   * actor. Errors propagate (callers log content-free and answer with fixed copy).
   */
  async updateMetadataEntry(
    actorId: Id,
    key: string,
    update: (current: unknown, live: Actor) => unknown,
    fallback?: Actor,
  ): Promise<Actor | null> {
    return this.lock.run(`actor:${actorId}`, async () => {
      const live = (await this.actors.get(actorId)) ?? fallback ?? null;
      if (live === null) return null;
      const metadata: Metadata = { ...(live.metadata ?? {}) };
      // `live` (read-only): the whole live actor inside the lock, for an update that must check another key (ADR-0122 P2).
      const next = update(metadata[key], live);
      if (next === undefined) delete metadata[key];
      else metadata[key] = next;
      return this.actors.save({ ...live, metadata });
    });
  }
}
