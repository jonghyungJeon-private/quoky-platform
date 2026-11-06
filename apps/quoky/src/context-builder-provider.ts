import {
  ContextBuilder,
  CuratedExampleSelector,
  DefaultMemoryRetriever,
  LEARNING_EXAMPLE_VECTOR_COLLECTION,
  RecallActivityGauge,
  SemanticRecallScorer,
  durableMemoryCollectionFor,
  localOnlyProviderSelector,
  type ContextBuilderConfig,
  type LearningRepository,
  type Logger,
  type MemoryManager,
  type MemoryRepository,
  type ProviderSelector,
  type StorageProvider,
  type VectorProvider,
} from '@quoky/core';
import type { QuokyConfig } from './config';
import { MemoryVectorBackfill } from './memory-vector-backfill';

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
  /**
   * Shared between the recall scorer (marks each turn) and the background backfill (yields to a turn), so the two are
   * wired from one gauge in the composition root.
   */
  activity?: RecallActivityGauge;
}

/**
 * Owner-curated example layer (ADR-0107 D5/D6, LRN-2). Passed only when `QUOKY_LEARNING_EXAMPLES_ENABLED=true`
 * (default false); without it the bundle carries no examples and prompts stay byte-identical to v2. The examples are
 * ranked by the local embedding scorer when `semanticRecall` is also composed (`QUOKY_EMBEDDING_ENABLED=true`) and
 * lexically otherwise. Example text is `LOCAL_ONLY`, so the scorer may use only an `EMBEDDING` provider that declares
 * `LOCAL` execution, and caches vectors (no text) in its own collection. Whether an example reaches a prompt is decided
 * later, by the composer, from the resolved chat provider's declared locality and — ADR-0116 — its selection source.
 */
export interface ProductionCuratedExampleOptions {
  learning: Pick<LearningRepository, 'list'>;
  /**
   * ADR-0116 D1 (`QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED`, default false): examples may also reach a `REMOTE` chat
   * provider that is the owner's explicit selection. Absent or false → `LOCAL` providers only (byte-identical).
   */
  remoteOwnerSelected?: boolean;
  logger?: Logger;
}

/**
 * The curated-example options for {@link createProductionContextBuilder} from the configuration (ADR-0107 D5,
 * ADR-0116 D1): `undefined` unless `QUOKY_LEARNING_EXAMPLES_ENABLED=true`; then the learning store and
 * `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED`. The one mapping used by the composition root and its acceptance test.
 */
export function curatedExampleOptionsOf(
  config: Pick<QuokyConfig, 'learning'>,
  learning: Pick<LearningRepository, 'list'>,
  logger?: Logger,
): ProductionCuratedExampleOptions | undefined {
  if (!config.learning.examplesEnabled) return undefined;
  return {
    learning,
    remoteOwnerSelected: config.learning.examplesRemoteEnabled,
    ...(logger === undefined ? {} : { logger }),
  };
}

/**
 * Whether the learning copy must disclose that examples may accompany an owner-selected cloud model (ADR-0116 R4):
 * the same condition under which {@link curatedExampleOptionsOf} lets examples leave the host.
 */
export function learningRemoteDisclosureOf(config: Pick<QuokyConfig, 'learning'>): boolean {
  return config.learning.examplesEnabled && config.learning.examplesRemoteEnabled;
}

/**
 * The production durable-memory scorer (ADR-0124 section 5, P2-2): multi-vector (one vector per passage of a long
 * memory), one collection per embedding space (`durable-memory-v2-<space>`), ADR-0110 D4 local-only provider
 * selection. Exported so the stage R measurement builds exactly the same wiring.
 */
export function createProductionMemoryScorer(semanticRecall: ProductionSemanticRecallOptions): SemanticRecallScorer {
  return new SemanticRecallScorer(
    {
      // ADR-0110 D4: durable memory text is the owner's personal content and must not reach a remote model,
      // so a non-LOCAL embedding provider is treated as absent (fail closed to lexical, never remote).
      selector: localOnlyProviderSelector(semanticRecall.selector),
      vectors: semanticRecall.vectors,
      ...(semanticRecall.logger === undefined ? {} : { logger: semanticRecall.logger }),
      ...(semanticRecall.activity === undefined ? {} : { activity: semanticRecall.activity }),
    },
    {
      collectionFor: durableMemoryCollectionFor,
      multiVector: true,
      maxNewEmbeddingsPerTurn: semanticRecall.maxNewPerTurn,
      embeddingTimeoutMs: semanticRecall.timeoutMs,
    },
  );
}

/**
 * The production backfill job (ADR-0124 section 5.4): the SAME scorer as recall, so it embeds locally only and under
 * the same credential rule; started by `main.ts` after the application is up.
 */
export function createProductionMemoryBackfill(
  storage: Pick<StorageProvider, 'memories'>,
  semanticRecall: ProductionSemanticRecallOptions,
): MemoryVectorBackfill {
  return new MemoryVectorBackfill({
    scorer: createProductionMemoryScorer(semanticRecall),
    memories: () => storage.memories,
    ...(semanticRecall.activity === undefined ? {} : { activity: semanticRecall.activity }),
    ...(semanticRecall.logger === undefined ? {} : { logger: semanticRecall.logger }),
  });
}

/** The production retriever over `repository`: the scorer above when semantic recall is on, lexical otherwise. */
export function createProductionMemoryRetriever(
  repository: MemoryRepository,
  semanticRecall?: ProductionSemanticRecallOptions,
): DefaultMemoryRetriever {
  return new DefaultMemoryRetriever(
    repository,
    semanticRecall === undefined ? {} : { semanticScorer: createProductionMemoryScorer(semanticRecall) },
  );
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
  curatedExamples?: ProductionCuratedExampleOptions,
): ContextBuilder {
  const repository: MemoryRepository = {
    get: (id) => storage.memories.get(id),
    save: (record) => storage.memories.save(record),
    delete: (id) => storage.memories.delete(id),
    list: () => storage.memories.list(),
    findByScope: (scope, type) => storage.memories.findByScope(scope, type),
    findDurableCandidates: (query) => storage.memories.findDurableCandidates(query),
    findDurableCandidatesByIds: async (query) =>
      storage.memories.findDurableCandidatesByIds === undefined
        ? []
        : storage.memories.findDurableCandidatesByIds(query),
    findShortTermByUser: (userId) => storage.memories.findShortTermByUser(userId),
  };

  const retriever = createProductionMemoryRetriever(repository, semanticRecall);
  const exampleSelector =
    curatedExamples === undefined
      ? undefined
      : new CuratedExampleSelector({
          learning: curatedExamples.learning,
          egressPolicy: { remoteOwnerSelected: curatedExamples.remoteOwnerSelected === true },
          ...(semanticRecall === undefined
            ? {}
            : {
                semanticScorer: new SemanticRecallScorer(
                  {
                    selector: localOnlyProviderSelector(semanticRecall.selector),
                    vectors: semanticRecall.vectors,
                    ...(semanticRecall.logger === undefined ? {} : { logger: semanticRecall.logger }),
                  },
                  {
                    collection: LEARNING_EXAMPLE_VECTOR_COLLECTION,
                    maxNewEmbeddingsPerTurn: semanticRecall.maxNewPerTurn,
                    embeddingTimeoutMs: semanticRecall.timeoutMs,
                  },
                ),
              }),
          ...(curatedExamples.logger === undefined ? {} : { logger: curatedExamples.logger }),
        });
  return new ContextBuilder(memory, config, retriever, exampleSelector);
}
