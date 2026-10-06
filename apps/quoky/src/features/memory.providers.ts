import type { Provider } from '@nestjs/common';
import {
  DefaultMemoryWriter,
  LEARNING_REPOSITORY,
  MemoryCommandService,
  MemoryManager,
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  createLearningItemsRemovalCascade,
  createMemoryCommandTurnHandler,
  createSessionHistoryClearer,
  createShortTermHistoryRemovalCascade,
  createVectorRemovalCascade,
  type ConversationTurnHandler,
  type LearningMemoryForgetCascade,
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
 *   forget/edit cascade (ADR-0106 D5): the durable-memory vector cache, then the owner's v14 `learning_items` rows
 *   whose `source_memory_id` is a removed record (ADR-0107 D7), through the `LEARNING_REPOSITORY` port that
 *   `feedback.providers.ts` binds (only its `deleteBySourceMemory` seam is used here), then the owner's own SHORT_TERM
 *   conversation-history turns that carry a removed record's text (W2-L01), through the storage provider's actor and
 *   memory repositories.
 * - ADR-0106 amendment: a confirmed forget archives the record for `archiveDays` (`QUOKY_MEMORY_ARCHIVE_DAYS`,
 *   default 7; 0 = delete at once) and clears the owner's short-term history of the current session; the daily
 *   maintenance (`ops/memory-archive-purge.ts`, driven from `main.ts`) calls `purgeExpiredArchive`.
 * - `MEMORY_TURN_HANDLERS` — the `pre-classify` order-50 handler; `turn-handlers.providers.ts` concatenates it.
 */

/** App-local token for this feature's handler list (the wave-1 `feature-tokens.ts` is not edited after wave 1). */
export const MEMORY_TURN_HANDLERS = Symbol('MemoryTurnHandlers');

/** Composition seam for offline acceptance only; production passes none. */
export interface MemoryCompositionOptions {
  readonly logger?: Logger;
  /** Extra cascades after the vector cache, learning-items and conversation-history cascades. */
  readonly extraCascades?: readonly MemoryRemovalCascade[];
  /** `config.memory.archiveDays` (`QUOKY_MEMORY_ARCHIVE_DAYS`); the service default (7) when absent. */
  readonly archiveDays?: number;
}

export function createMemoryProviders(options: MemoryCompositionOptions = {}): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('memory-commands');
  return [
    {
      provide: MemoryCommandService,
      useFactory: (
        memory: MemoryManager,
        storage: StorageProvider,
        vectors: VectorProvider,
        learning: LearningMemoryForgetCascade,
      ) =>
        new MemoryCommandService({
          records: {
            get: (id) => storage.memories.get(id),
            findDurableCandidates: (query) => storage.memories.findDurableCandidates(query),
            save: (record) => storage.memories.save(record),
          },
          writer: new DefaultMemoryWriter(memory),
          cascades: [
            createVectorRemovalCascade(vectors),
            createLearningItemsRemovalCascade(learning),
            createShortTermHistoryRemovalCascade({
              actors: { get: (id) => storage.actors.get(id) },
              sessions: { get: (id) => storage.sessions.get(id) },
              history: {
                findShortTermByUser: (userId) => storage.memories.findShortTermByUser(userId),
                delete: (id) => storage.memories.delete(id),
              },
            }),
            ...(options.extraCascades ?? []),
          ],
          sessionHistory: createSessionHistoryClearer({
            actors: { get: (id) => storage.actors.get(id) },
            sessions: { get: (id) => storage.sessions.get(id) },
            history: {
              findByScope: (scope, type) => storage.memories.findByScope(scope, type),
              delete: (id) => storage.memories.delete(id),
            },
          }),
          ...(options.archiveDays === undefined ? {} : { archiveDays: options.archiveDays }),
          logger,
        }),
      inject: [MemoryManager, STORAGE_PROVIDER, VECTOR_PROVIDER, LEARNING_REPOSITORY],
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
