import { randomUUID } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { cosineSimilarity, isEmbeddingVector } from '@quoky/core';
import type { Id, Metadata, VectorProvider, VectorQueryResult, VectorRecord } from '@quoky/core';
import {
  COLLECTION_NAME_PATTERN,
  STORE_FORMAT_VERSION,
  decodeEntry,
  encodeVector,
  isPlainMetadata,
  isValidId,
  parseCollectionEntries,
  type PersistedRecord,
} from './format';

export {
  VECTOR_SNAPSHOT_MANIFEST,
  VECTOR_SNAPSHOT_SCHEMA,
  inspectVectorStore,
  isVectorSnapshotEntryName,
  verifyVectorSnapshot,
  writeVerifiedVectorSnapshot,
} from './snapshot';
export type {
  VectorSnapshotFailure,
  VectorSnapshotRequest,
  VectorSnapshotResult,
  VectorSnapshotSummary,
  VectorStoreInspection,
} from './snapshot';

/** ADR-0098 D8: at most this many records per collection; the oldest-written are evicted beyond it. */
export const DEFAULT_MAX_RECORDS_PER_COLLECTION = 20_000;

/** Minimal filesystem surface. Production uses node:fs; tests inject failures to prove atomic writes. */
export interface VectorStoreIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** What to do when an upsert would take a collection above its cap (ADR-0123 Q1 safeguard 1). */
export type VectorOverflowPolicy = 'evict' | 'reject';

/** Thrown under `overflow: 'reject'` when an upsert, or a loaded file, would exceed the cap. Nothing is written or trimmed. */
export class VectorCapacityError extends Error {
  readonly code = 'VECTOR_CAPACITY_EXCEEDED';
  constructor(
    readonly collection: string,
    readonly limit: number,
    readonly attempted: number,
    readonly phase: 'upsert' | 'load',
  ) {
    super(`Vector collection ${collection} would hold ${attempted} records, above the cap of ${limit} (${phase}, overflow=reject)`);
    this.name = 'VectorCapacityError';
  }
}

/** Thrown by writes to a collection whose bad file could not be moved aside, so the original is never overwritten. */
export class VectorQuarantineError extends Error {
  readonly code = 'VECTOR_QUARANTINE_FAILED';
  constructor(readonly collection: string) {
    super(`Vector collection ${collection} is write-blocked: its unusable file could not be preserved`);
    this.name = 'VectorQuarantineError';
  }
}

export type VectorCorruptReason = 'parse-error' | 'unreadable';

/**
 * A collection file that could not be used. Deliberately carries no file content: only the collection name, the
 * reason, the byte size (null when the file could not be read) and where the file was moved (null if the move failed).
 */
export interface VectorCorruptEvent {
  readonly collection: string;
  readonly reason: VectorCorruptReason;
  readonly byteSize: number | null;
  readonly quarantinedTo: string | null;
}

export interface VectorStoreLogger {
  warn(message: string, fields: Readonly<Record<string, string | number | null>>): void;
}

export interface LocalVectorProviderOptions {
  maxRecordsPerCollection?: number;
  /** Default 'evict' (oldest-written records are dropped silently). 'reject' throws VectorCapacityError and writes nothing. */
  overflow?: VectorOverflowPolicy;
  /** Receives one warning per corrupt or unreadable collection file (no content). Default: silent. */
  logger?: VectorStoreLogger;
  /**
   * Rebuild hook. Called once, after the collection started empty and its file was quarantined, so the owning feature
   * can re-upsert from its source of truth (for the example pool: the checked-in pool file). It runs asynchronously
   * after the load settles (so it may call `upsert` on this provider) and its failures are swallowed.
   */
  onCorrupt?: (event: VectorCorruptEvent) => void | Promise<void>;
  /** Test seam only; production always uses node:fs. */
  io?: VectorStoreIo;
}

const nodeIo: VectorStoreIo = {
  readFile: (path) => fsPromises.readFile(path, 'utf8'),
  writeFile: (path, data) => fsPromises.writeFile(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (path) => fsPromises.unlink(path),
  mkdir: async (path) => {
    await fsPromises.mkdir(path, { recursive: true, mode: 0o700 });
  },
};

interface StoredRecord {
  readonly vector: readonly number[];
  readonly metadata?: Metadata;
}

function assertCollection(collection: string): void {
  if (!COLLECTION_NAME_PATTERN.test(collection)) throw new TypeError('Invalid vector collection name');
}

function copyMetadata(metadata: Metadata | undefined): Metadata | undefined {
  return metadata === undefined ? undefined : (JSON.parse(JSON.stringify(metadata)) as Metadata);
}

/**
 * Local `VectorProvider` (ADR-0073 as amended by ADR-0098 D8). A derived, rebuildable cache: one JSON file per
 * collection at `<storePath>/<collection>.json`, loaded lazily into memory, written atomically (a uniquely named
 * temporary file renamed over the target, so a failed write never leaves a partial store), with cosine top-K
 * queries and a per-collection record cap (the oldest-written records are evicted first). Records whose
 * dimensions differ from the query are skipped. An unreadable or corrupt file starts the collection empty, is moved aside
 * to `<collection>.corrupt-<timestamp>.json`, is reported (no content) to the optional logger, and fires `onCorrupt`
 * so the owner can rebuild. With `overflow: 'reject'` the cap is a hard limit instead of an eviction.
 * Embedding GENERATION is not here — it is an `AiProvider` `EMBEDDING` capability. Uses node:fs/node:path only.
 */
export class LocalVectorProvider implements VectorProvider {
  private readonly maxRecords: number;
  private readonly io: VectorStoreIo;
  private readonly overflow: VectorOverflowPolicy;
  private readonly logger: VectorStoreLogger | undefined;
  private readonly onCorrupt: LocalVectorProviderOptions['onCorrupt'];
  private readonly collections = new Map<string, Promise<Map<Id, StoredRecord>>>();
  /** Collections whose unusable file could not be moved aside: reads are empty, writes throw until it is preserved. */
  private readonly writeBlocked = new Map<string, string>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly storePath: string,
    options: LocalVectorProviderOptions = {},
  ) {
    this.maxRecords = options.maxRecordsPerCollection ?? DEFAULT_MAX_RECORDS_PER_COLLECTION;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new RangeError('maxRecordsPerCollection must be a positive integer');
    }
    this.io = options.io ?? nodeIo;
    this.overflow = options.overflow ?? 'evict';
    this.logger = options.logger;
    this.onCorrupt = options.onCorrupt;
  }

  /** Lifecycle hook. The store directory is created lazily on the first write, so a disabled recall creates nothing. */
  async init(): Promise<void> {
    if (this.storePath.length === 0) throw new TypeError('Vector store path is required');
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    assertCollection(collection);
    for (const record of records) {
      if (!isValidId(record.id)) throw new TypeError('Invalid vector record id');
      if (!isEmbeddingVector(record.vector)) throw new TypeError('Invalid vector');
      if (record.metadata !== undefined && !isPlainMetadata(record.metadata)) {
        throw new TypeError('Invalid vector record metadata');
      }
    }
    if (records.length === 0) return;
    await this.mutate(collection, (current) => {
      const next = new Map(current);
      for (const record of records) {
        // Re-inserting moves the id to the newest position, so eviction drops the oldest-written records.
        next.delete(record.id);
        const metadata = copyMetadata(record.metadata);
        next.set(record.id, {
          vector: Array.from(Float32Array.from(record.vector)),
          ...(metadata === undefined ? {} : { metadata }),
        });
      }
      if (this.overflow === 'reject' && next.size > this.maxRecords) {
        throw new VectorCapacityError(collection, this.maxRecords, next.size, 'upsert');
      }
      while (next.size > this.maxRecords) {
        const oldest = next.keys().next();
        if (oldest.done === true) break;
        next.delete(oldest.value);
      }
      return next;
    });
  }

  async query(collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    assertCollection(collection);
    if (!isEmbeddingVector(vector)) throw new TypeError('Invalid query vector');
    if (!Number.isInteger(topK) || topK < 1) return [];
    const records = await this.load(collection);
    const scored: Array<{ id: Id; score: number; record: StoredRecord }> = [];
    for (const [id, record] of records) {
      if (record.vector.length !== vector.length) continue;
      scored.push({ id, score: cosineSimilarity(vector, record.vector), record });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, topK).map(({ id, score, record }) => {
      const metadata = copyMetadata(record.metadata);
      return { id, score, ...(metadata === undefined ? {} : { metadata }) };
    });
  }

  /**
   * Remove records by id (ADR-0106 D5: a forgotten or edited memory's vector). Idempotent: ids that are not stored
   * are ignored, and when none of them is stored nothing is written — so a forget with semantic recall disabled
   * never creates the store directory or a collection file.
   */
  async delete(collection: string, ids: Id[]): Promise<void> {
    assertCollection(collection);
    if (ids.length === 0) return;
    let changed = false;
    await this.mutate(
      collection,
      (current) => {
        const next = new Map(current);
        for (const id of ids) changed = next.delete(id) || changed;
        return next;
      },
      () => changed,
    );
  }

  private filePath(collection: string): string {
    return join(this.storePath, `${collection}.json`);
  }

  private load(collection: string): Promise<Map<Id, StoredRecord>> {
    let loaded = this.collections.get(collection);
    if (loaded === undefined) {
      const attempt = this.readCollection(collection);
      loaded = attempt;
      this.collections.set(collection, attempt);
      // A failed load is not cached: once the file is repaired the next call rereads it.
      attempt.catch(() => {
        if (this.collections.get(collection) === attempt) this.collections.delete(collection);
      });
    }
    return loaded;
  }

  private async readCollection(collection: string): Promise<Map<Id, StoredRecord>> {
    const records = new Map<Id, StoredRecord>();
    let raw: string;
    try {
      raw = await this.io.readFile(this.filePath(collection));
    } catch (error) {
      // A missing file is a normal first run. Anything else is unreadable: start empty, but keep the file for inspection.
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') await this.quarantine(collection, 'unreadable', null);
      return records;
    }
    const persisted = parseCollectionEntries(raw);
    if (persisted === null) {
      await this.quarantine(collection, 'parse-error', Buffer.byteLength(raw, 'utf8'));
      return records;
    }
    for (const entry of persisted) {
      const decoded = decodeEntry(entry);
      if (decoded === null) continue;
      records.delete(decoded.id);
      records.set(decoded.id, { vector: decoded.vector, ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }) });
    }
    if (this.overflow === 'reject' && records.size > this.maxRecords) {
      // Refuse rather than trim: trimming would silently drop approved records. The file is left untouched, and
      // every read and write of this collection fails until the cap is raised or the file is repaired.
      throw new VectorCapacityError(collection, this.maxRecords, records.size, 'load');
    }
    while (records.size > this.maxRecords) {
      const oldest = records.keys().next();
      if (oldest.done === true) break;
      records.delete(oldest.value);
    }
    return records;
  }

  /** Move a bad file to `<collection>.corrupt-<timestamp>.json`, warn without content, and signal the rebuild hook. */
  private async quarantine(collection: string, reason: VectorCorruptReason, byteSize: number | null): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(this.storePath, `${collection}.corrupt-${stamp}.json`);
    let quarantinedTo: string | null = null;
    try {
      await this.io.rename(this.filePath(collection), target);
      quarantinedTo = target;
    } catch {
      // Could not move it aside: block writes so the original is never overwritten (retried on the next write).
      this.writeBlocked.set(collection, target);
    }
    const event: VectorCorruptEvent = { collection, reason, byteSize, quarantinedTo };
    try {
      this.logger?.warn('vector collection file unusable; starting empty', { collection, reason, byteSize, quarantinedTo });
    } catch {
      // A failing logger must not break recall.
    }
    const hook = this.onCorrupt;
    if (hook !== undefined) {
      void Promise.resolve()
        .then(() => hook(event))
        .catch(() => undefined);
    }
  }

  private async assertWritable(collection: string): Promise<void> {
    const target = this.writeBlocked.get(collection);
    if (target === undefined) return;
    try {
      await this.io.rename(this.filePath(collection), target);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw new VectorQuarantineError(collection);
    }
    this.writeBlocked.delete(collection);
  }

  /** Serialize writes per collection; the in-memory view changes only after the file was replaced. */
  private async mutate(
    collection: string,
    change: (current: ReadonlyMap<Id, StoredRecord>) => Map<Id, StoredRecord>,
    shouldPersist: () => boolean = () => true,
  ): Promise<void> {
    const previous = this.writeChains.get(collection) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await this.load(collection);
      await this.assertWritable(collection);
      const next = change(current);
      if (!shouldPersist()) return;
      await this.persist(collection, next);
      this.collections.set(collection, Promise.resolve(next));
    });
    this.writeChains.set(
      collection,
      run.catch(() => undefined),
    );
    await run;
  }

  private async persist(collection: string, records: ReadonlyMap<Id, StoredRecord>): Promise<void> {
    const persisted: PersistedRecord[] = [];
    for (const [id, record] of records) {
      persisted.push({
        id,
        v: encodeVector(record.vector),
        ...(record.metadata === undefined ? {} : { m: record.metadata }),
      });
    }
    const body = JSON.stringify({ version: STORE_FORMAT_VERSION, records: persisted });
    await this.io.mkdir(this.storePath);
    const target = this.filePath(collection);
    const temporary = join(this.storePath, `.${collection}.${randomUUID()}.tmp`);
    try {
      await this.io.writeFile(temporary, body);
      await this.io.rename(temporary, target);
    } catch (error) {
      try {
        await this.io.unlink(temporary);
      } catch {
        // The temporary file may never have been created.
      }
      throw error;
    }
  }
}
