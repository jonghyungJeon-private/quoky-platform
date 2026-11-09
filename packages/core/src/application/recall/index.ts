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
  DURABLE_MEMORY_V2_COLLECTION_PREFIX,
  DURABLE_MEMORY_VECTOR_COLLECTION,
  SemanticRecallScorer,
  durableMemoryCollectionFor,
} from './semantic-recall-scorer';
export type {
  SemanticRecallCandidate,
  SemanticRecallLiveSet,
  SemanticRecallMaintenance,
  SemanticRecallMaintenanceOptions,
  SemanticRecallScorerDeps,
  SemanticRecallScorerOptions,
  SemanticRecallScoring,
  SemanticRecallSession,
} from './semantic-recall-scorer';
export {
  MAX_PASSAGES_PER_MEMORY,
  allMemoryVectorIds,
  memoryPassageStartOffset,
  memoryVectorUnits,
  passageVectorId,
} from './memory-passages';
export type { MemoryVectorUnit } from './memory-passages';
export {
  RECALL_EXCERPT_DEFAULT_CHARS,
  RECALL_EXCERPT_TOP_RANKS,
  RECALL_EXCERPT_TOP_RANK_CHARS,
  renderRecallContent,
} from './recall-excerpt';
export type { RecallExcerptVariant } from './recall-excerpt';
export { RecallActivityGauge } from './recall-activity';
export type { RecallActivity, RecallActivityReader } from './recall-activity';
