import type { Provider } from '@nestjs/common';
import {
  DefaultMemoryWriter,
  MemoryCommandService,
  MemoryManager,
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  createMemoryCommandTurnHandler,
  createVectorRemovalCascade,
  type ConversationTurnHandler,
  type Logger,
  type MemoryRemovalCascade,
  type StorageProvider,
  type VectorProvider,
} from '@quoky/core';
import { ConsoleLogger } from '../console-logger';

/**
 * Memory management commands (ADR-0106, MEM-1) — feature composition (ADR-0096 D7). Every memory-command binding
 * lives here:
 *
 * - `MemoryCommandService` — actor-scoped list/view/edit/forget over the storage provider's memory repository,
 *   resolved at call time (repositories are assigned at `storage.init()`, after DI construction), with every write
 *   through the ADR-0073 `DefaultMemoryWriter` (the same writer the runtime's `기억해:` block uses) and the
 *   forget/edit cascade: the durable-memory vector cache today.
 * - `MEMORY_TURN_HANDLERS` — the `pre-classify` order-50 handler; `turn-handlers.providers.ts` concatenates it.
 *
 * LRN-1 integration point (ADR-0107 D7): add a `MemoryRemovalCascade` that deletes the owner's `learning_items` rows
 * whose `source_memory_id` is in the event, to the `cascades` list below. Nothing else changes.
 */

/** App-local token for this feature's handler list (the wave-1 `feature-tokens.ts` is not edited after wave 1). */
export const MEMORY_TURN_HANDLERS = Symbol('MemoryTurnHandlers');

/** Composition seam for offline acceptance only; production passes none. */
export interface MemoryCompositionOptions {
  readonly logger?: Logger;
  /** Extra cascades after the vector cache (the LRN-1 learning-items cascade is wired here at integration). */
  readonly extraCascades?: readonly MemoryRemovalCascade[];
}

export function createMemoryProviders(options: MemoryCompositionOptions = {}): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('memory-commands');
  return [
    {
      provide: MemoryCommandService,
      useFactory: (memory: MemoryManager, storage: StorageProvider, vectors: VectorProvider) =>
        new MemoryCommandService({
          records: {
            get: (id) => storage.memories.get(id),
            findDurableCandidates: (query) => storage.memories.findDurableCandidates(query),
          },
          writer: new DefaultMemoryWriter(memory),
          cascades: [createVectorRemovalCascade(vectors), ...(options.extraCascades ?? [])],
          logger,
        }),
      inject: [MemoryManager, STORAGE_PROVIDER, VECTOR_PROVIDER],
    },
    {
      provide: MEMORY_TURN_HANDLERS,
      useFactory: (service: MemoryCommandService): readonly ConversationTurnHandler[] => [
        createMemoryCommandTurnHandler({ service, logger }),
      ],
      inject: [MemoryCommandService],
    },
  ];
}

export const memoryProviders: Provider[] = createMemoryProviders();
