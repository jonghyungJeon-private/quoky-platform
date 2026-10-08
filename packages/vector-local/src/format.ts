import { isEmbeddingVector } from '@quoky/core';
import type { Metadata } from '@quoky/core';

/**
 * The on-disk format of the local vector store, shared by the provider (`index.ts`) and the backup snapshot
 * (`snapshot.ts`): one `<collection>.json` file per collection, `{ version: 1, records: [{ id, v, m? }] }`.
 */

export const STORE_FORMAT_VERSION = 1;
/** One JSON file per collection, so the name must be a safe file stem. */
export const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A collection file name: `<collection>.json`. */
export const COLLECTION_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
export const MAX_RECORD_ID_LENGTH = 200;

export interface PersistedRecord {
  id: string;
  /** Little-endian Float32 vector, base64 (about a quarter of a decimal JSON array). */
  v: string;
  m?: Metadata;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= MAX_RECORD_ID_LENGTH;
}

export function isPlainMetadata(value: unknown): value is Metadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeVector(vector: readonly number[]): string {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

export function decodeVector(encoded: string): number[] | null {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const vector: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) vector.push(bytes.readFloatLE(offset));
  return isEmbeddingVector(vector) ? vector : null;
}

/** One persisted entry, decoded; `null` when the provider would skip it. */
export function decodeEntry(entry: unknown): { id: string; vector: number[]; metadata?: Metadata } | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { id, v, m } = entry as { id?: unknown; v?: unknown; m?: unknown };
  if (!isValidId(id) || typeof v !== 'string') return null;
  if (m !== undefined && !isPlainMetadata(m)) return null;
  const vector = decodeVector(v);
  if (vector === null) return null;
  return { id, vector, ...(m === undefined ? {} : { metadata: m }) };
}

/** The persisted entries of a collection file, or `null` when the provider would treat the file as an empty cache. */
export function parseCollectionEntries(raw: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { version, records } = parsed as { version?: unknown; records?: unknown };
  if (version !== STORE_FORMAT_VERSION || !Array.isArray(records)) return null;
  return records as unknown[];
}
