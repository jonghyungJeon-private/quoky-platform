import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_ENVELOPE_SCHEMA,
  MAX_EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  embeddingRequestMetadata,
  formatEmbeddingEnvelope,
  isEmbeddingVector,
  parseEmbeddingEnvelope,
  readEmbeddingRole,
} from './embedding-envelope';

describe('embedding envelope (ADR-0098 D8)', () => {
  it('round-trips a vector through the canonical envelope', () => {
    const text = formatEmbeddingEnvelope([0.1, -0.2, 0.3], 'nomic-embed-text');
    expect(JSON.parse(text)).toEqual({
      schema: EMBEDDING_ENVELOPE_SCHEMA,
      space: 'nomic-embed-text',
      dimensions: 3,
      embedding: [0.1, -0.2, 0.3],
    });
    expect(parseEmbeddingEnvelope(text)).toEqual({
      schema: EMBEDDING_ENVELOPE_SCHEMA,
      space: 'nomic-embed-text',
      dimensions: 3,
      vector: [0.1, -0.2, 0.3],
    });
  });

  it('refuses to format an invalid vector or space', () => {
    expect(() => formatEmbeddingEnvelope([], 'm')).toThrow(TypeError);
    expect(() => formatEmbeddingEnvelope([Number.NaN], 'm')).toThrow(TypeError);
    expect(() => formatEmbeddingEnvelope([1], 'bad space')).toThrow(TypeError);
    expect(() => formatEmbeddingEnvelope(new Array(MAX_EMBEDDING_DIMENSIONS + 1).fill(0.1), 'm')).toThrow(TypeError);
  });

  it.each([
    ['not json', 'nope'],
    ['an array', '[1,2,3]'],
    ['null', 'null'],
    ['a wrong schema', JSON.stringify({ schema: 'other', space: 'm', dimensions: 1, embedding: [1] })],
    ['an extra key', JSON.stringify({ schema: EMBEDDING_ENVELOPE_SCHEMA, space: 'm', dimensions: 1, embedding: [1], x: 1 })],
    ['a missing key', JSON.stringify({ schema: EMBEDDING_ENVELOPE_SCHEMA, space: 'm', embedding: [1] })],
    ['a dimension mismatch', JSON.stringify({ schema: EMBEDDING_ENVELOPE_SCHEMA, space: 'm', dimensions: 2, embedding: [1] })],
    ['a string entry', JSON.stringify({ schema: EMBEDDING_ENVELOPE_SCHEMA, space: 'm', dimensions: 1, embedding: ['1'] })],
    ['an empty vector', JSON.stringify({ schema: EMBEDDING_ENVELOPE_SCHEMA, space: 'm', dimensions: 0, embedding: [] })],
    ['a bad space', JSON.stringify({ schema: EMBEDDING_ENVELOPE_SCHEMA, space: 'a b', dimensions: 1, embedding: [1] })],
  ])('parses %s as null (fail closed)', (_label, text) => {
    expect(parseEmbeddingEnvelope(text)).toBeNull();
  });

  it('recognizes only bounded finite numeric vectors', () => {
    expect(isEmbeddingVector([0, 1.5, -2])).toBe(true);
    expect(isEmbeddingVector([])).toBe(false);
    expect(isEmbeddingVector([Number.POSITIVE_INFINITY])).toBe(false);
    expect(isEmbeddingVector('1,2')).toBe(false);
  });

  it('carries the embedding role in request metadata and reads only known roles', () => {
    expect(readEmbeddingRole(embeddingRequestMetadata('query'))).toBe('query');
    expect(readEmbeddingRole(embeddingRequestMetadata('document'))).toBe('document');
    expect(readEmbeddingRole({ embeddingRole: 'other' })).toBeUndefined();
    expect(readEmbeddingRole(undefined)).toBeUndefined();
  });

  it('computes cosine similarity and scores undefined comparisons as 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
