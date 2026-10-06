import type { Id } from '../../domain';
import type { VectorProvider } from '../../ports';
import { DURABLE_MEMORY_VECTOR_COLLECTION } from '../recall/semantic-recall-scorer';

/**
 * What a memory command removed from the owner's durable recall (ADR-0106 D5):
 *  - `forget`: the record and its earlier (superseded) versions are about to be deleted;
 *  - `edit`: the record was superseded by a new one and no longer takes part in recall.
 */
export interface MemoryRemovalEvent {
  readonly actorId: Id;
  readonly reason: 'forget' | 'edit';
  /** Memory record ids. */
  readonly memoryIds: readonly Id[];
  /** Vector ids the records carried besides their own ids (`MemoryRecord.vectorId`), if any. */
  readonly vectorIds: readonly Id[];
}

/**
 * The forget/edit cascade seam (ADR-0106 D5, ADR-0107 D7): data derived from a durable memory that must go when the
 * memory goes. This is an application-level hook, not a port — it adds no DI token (ADR-0106 D6); the composition
 * root passes the list it has. Implementations are idempotent: removing what is already absent succeeds.
 *
 * Wired today: the `VectorProvider` cache entry ({@link createVectorRemovalCascade}). Wired at the v3 wave-2
 * integration once LRN-1's v14 `learning_items` store exists: a cascade that deletes every row whose
 * `source_memory_id` is one of `memoryIds`, scoped to `actorId`. Without it the commands work unchanged.
 */
export interface MemoryRemovalCascade {
  /** A short, content-free name for logs. */
  readonly id: string;
  onMemoriesRemoved(event: MemoryRemovalEvent): Promise<void>;
}

/**
 * Removes the durable-memory vectors (ADR-0098 D8 cache: vector ids equal memory ids) through the existing
 * `VectorProvider.delete`. The cache is rebuildable; this keeps a forgotten memory's embedding off the disk.
 */
export function createVectorRemovalCascade(
  vectors: Pick<VectorProvider, 'delete'>,
  collection: string = DURABLE_MEMORY_VECTOR_COLLECTION,
): MemoryRemovalCascade {
  return {
    id: 'vector',
    async onMemoriesRemoved(event) {
      const ids = [...new Set([...event.memoryIds, ...event.vectorIds])];
      if (ids.length === 0) return;
      await vectors.delete(collection, ids);
    },
  };
}
