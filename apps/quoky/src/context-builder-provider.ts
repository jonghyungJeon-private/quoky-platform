import {
  ContextBuilder,
  DefaultMemoryRetriever,
  SemanticRecallScorer,
  type ContextBuilderConfig,
  type Logger,
  type MemoryManager,
  type MemoryRepository,
  type ProviderSelector,
  type StorageProvider,
  type VectorProvider,
} from '@quoky/core';

/**
 * Opt-in semantic recall composition (ADR-0098 D8). Passed only when `QUOKY_EMBEDDING_ENABLED=true`; without it
 * durable recall stays purely lexical. The scorer selects the `EMBEDDING` capability through the selector and
 * caches vectors in the `VectorProvider`; neither touches `StorageProvider`, whose lazy ownership is unchanged.
 */
export interface ProductionSemanticRecallOptions {
  selector: ProviderSelector;
  vectors: VectorProvider;
  /**
   * Bound for one embedding call (`QUOKY_EMBEDDING_TIMEOUT_MS`). The whole scoring step keeps the fixed ADR-0098
   * per-turn budget (3 s), so a call never runs past what is left of it.
   */
  timeoutMs: number;
  /** Document embeddings created per turn (fixed at 4 by configuration). */
  maxNewPerTurn: number;
  logger?: Logger;
}

/**
 * Construct the production ContextBuilder while preserving the storage provider's
 * post-init repository ownership. Nest creates application services before
 * SqliteStorageProvider.init(), so each operation must resolve `memories` lazily.
 */
export function createProductionContextBuilder(
  memory: MemoryManager,
  storage: StorageProvider,
  config: ContextBuilderConfig,
  semanticRecall?: ProductionSemanticRecallOptions,
): ContextBuilder {
  const repository: MemoryRepository = {
    get: (id) => storage.memories.get(id),
    save: (record) => storage.memories.save(record),
    delete: (id) => storage.memories.delete(id),
    list: () => storage.memories.list(),
    findByScope: (scope, type) => storage.memories.findByScope(scope, type),
    findDurableCandidates: (query) => storage.memories.findDurableCandidates(query),
    findShortTermByUser: (userId) => storage.memories.findShortTermByUser(userId),
  };

  const retriever = new DefaultMemoryRetriever(
    repository,
    semanticRecall === undefined
      ? {}
      : {
          semanticScorer: new SemanticRecallScorer(
            {
              selector: semanticRecall.selector,
              vectors: semanticRecall.vectors,
              ...(semanticRecall.logger === undefined ? {} : { logger: semanticRecall.logger }),
            },
            {
              maxNewEmbeddingsPerTurn: semanticRecall.maxNewPerTurn,
              embeddingTimeoutMs: semanticRecall.timeoutMs,
            },
          ),
        },
  );
  return new ContextBuilder(memory, config, retriever);
}
