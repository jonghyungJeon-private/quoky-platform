import type { Id, Metadata } from '../domain';

export interface VectorRecord {
  id: Id;
  vector: number[];
  metadata?: Metadata;
}

export interface VectorQueryResult {
  id: Id;
  score: number;
  metadata?: Metadata;
}

/**
 * PORT: semantic memory recall. v1 implementation: LocalVectorProvider.
 *
 * Note: embedding GENERATION is a separate concern (an AiProvider EMBEDDING
 * capability, e.g. via Ollama). This port only stores/queries vectors, so v2
 * can swap to pgvector/Qdrant without core changes.
 */
export interface VectorProvider {
  init(): Promise<void>;
  upsert(collection: string, records: VectorRecord[]): Promise<void>;
  query(collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]>;
  delete(collection: string, ids: Id[]): Promise<void>;
  /**
   * Names of the collections that currently exist in the store (ADR-0124 section 5.5: forget removes a memory's
   * vectors from every embedding space's collection, so it must be able to find them). Optional: a store that cannot
   * list returns nothing here and the caller falls back to the collections it knows by name.
   */
  listCollections?(): Promise<string[]>;
}
