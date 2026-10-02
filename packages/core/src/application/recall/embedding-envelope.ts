/**
 * Canonical embedding envelope (ADR-0098 D8). An `EMBEDDING` provider returns its vector inside
 * `AiExecutionResult.text` as this JSON envelope, so the `AiProvider` contract stays unchanged. The adapter
 * formats it with {@link formatEmbeddingEnvelope}; Core reads it with {@link parseEmbeddingEnvelope}, which is
 * strict and fail-closed (any deviation returns `null`).
 */

export const EMBEDDING_ENVELOPE_SCHEMA = 'quoky.embedding.v1';

/** Upper bound on vector dimensions accepted anywhere in the recall path. */
export const MAX_EMBEDDING_DIMENSIONS = 8192;

/** `space` names the vector space (the sanitized local model name); vectors from different spaces never mix. */
const EMBEDDING_SPACE_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

export interface EmbeddingEnvelope {
  readonly schema: typeof EMBEDDING_ENVELOPE_SCHEMA;
  readonly space: string;
  readonly dimensions: number;
  readonly vector: readonly number[];
}

/** Request metadata key naming whether the text is the recall query or a stored document. */
export const EMBEDDING_ROLE_METADATA_KEY = 'embeddingRole';

export type EmbeddingRole = 'query' | 'document';

/** Request metadata for one embedding call. The adapter may map the role to a model-specific input prefix. */
export function embeddingRequestMetadata(role: EmbeddingRole): Readonly<Record<string, unknown>> {
  return Object.freeze({ [EMBEDDING_ROLE_METADATA_KEY]: role });
}

/** The role carried by request metadata, or `undefined` when absent or malformed. */
export function readEmbeddingRole(
  metadata: Readonly<Record<string, unknown>> | undefined,
): EmbeddingRole | undefined {
  const value: unknown = metadata?.[EMBEDDING_ROLE_METADATA_KEY];
  return value === 'query' || value === 'document' ? value : undefined;
}

/** True for a non-empty, bounded array of finite numbers. */
export function isEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_EMBEDDING_DIMENSIONS &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

/** Serialize a vector as the canonical envelope text. Throws `TypeError` on an invalid vector or space. */
export function formatEmbeddingEnvelope(vector: readonly number[], space: string): string {
  if (!isEmbeddingVector(vector)) throw new TypeError('Invalid embedding vector');
  if (!EMBEDDING_SPACE_PATTERN.test(space)) throw new TypeError('Invalid embedding space');
  return JSON.stringify({
    schema: EMBEDDING_ENVELOPE_SCHEMA,
    space,
    dimensions: vector.length,
    embedding: [...vector],
  });
}

const ENVELOPE_KEYS = ['dimensions', 'embedding', 'schema', 'space'];

/** Parse the canonical envelope. Unknown keys, a dimension mismatch or any non-finite value yields `null`. */
export function parseEmbeddingEnvelope(text: string): EmbeddingEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    return null;
  }
  const { schema, space, dimensions, embedding } = record;
  if (schema !== EMBEDDING_ENVELOPE_SCHEMA) return null;
  if (typeof space !== 'string' || !EMBEDDING_SPACE_PATTERN.test(space)) return null;
  if (!isEmbeddingVector(embedding)) return null;
  if (dimensions !== embedding.length) return null;
  return Object.freeze({
    schema: EMBEDDING_ENVELOPE_SCHEMA,
    space,
    dimensions,
    vector: Object.freeze([...embedding]),
  });
}

/**
 * Cosine similarity in [-1, 1]. Vectors of different length, an empty vector or a zero-norm vector have no
 * defined similarity and score 0, so a mismatched record can never outrank a matching one.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    const x = a[index] as number;
    const y = b[index] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(similarity)) return 0;
  return Math.max(-1, Math.min(1, similarity));
}
