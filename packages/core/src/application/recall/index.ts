/**
 * Semantic recall (ADR-0098 D8) — application sub-barrel.
 *
 * Opt-in local embedding recall: the canonical embedding envelope and the semantic re-ranker used by
 * `DefaultMemoryRetriever`. Exported from this sub-barrel only; the root application barrel is not edited after
 * wave 1.
 */
export {
  EMBEDDING_ENVELOPE_SCHEMA,
  EMBEDDING_ROLE_METADATA_KEY,
  MAX_EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  embeddingRequestMetadata,
  formatEmbeddingEnvelope,
  isEmbeddingVector,
  parseEmbeddingEnvelope,
  readEmbeddingRole,
} from './embedding-envelope';
export type { EmbeddingEnvelope, EmbeddingRole } from './embedding-envelope';
export {
  DEFAULT_MAX_INDEXED_VECTORS,
  DEFAULT_MAX_NEW_EMBEDDINGS_PER_TURN,
  DEFAULT_SEMANTIC_TURN_BUDGET_MS,
  DURABLE_MEMORY_VECTOR_COLLECTION,
  SemanticRecallScorer,
} from './semantic-recall-scorer';
export type {
  SemanticRecallCandidate,
  SemanticRecallScorerDeps,
  SemanticRecallScorerOptions,
  SemanticRecallScoring,
} from './semantic-recall-scorer';
