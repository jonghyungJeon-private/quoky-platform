import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { COLLECTION_FILE_PATTERN, decodeEntry, parseCollectionEntries } from './format';

/**
 * Backup snapshot of the local vector store (the vector half of the ADR-0102 D6 backup set). The composition root owns
 * the schedule, names, retention and status; this module owns the only knowledge of the store's file format.
 *
 * Why a plain file copy is a consistent snapshot: the provider replaces a collection file only by renaming a fully
 * written temporary file over it, so every read of `<collection>.json` sees one complete version. The provider's own
 * temporary files (`.<collection>.<uuid>.tmp`) and anything that is not a regular `<collection>.json` file are never
 * copied. Collections are independent caches keyed by memory id and content hash (a stale or extra vector is never
 * served), so they need no cross-file atomicity.
 *
 * A snapshot is a directory: the copied `<collection>.json` files (mode 600) and `.snapshot.json`, a manifest with
 * each file's byte size, SHA-256 and record count. Verification (the analogue of `integrity_check`) re-reads the
 * copy: the directory holds exactly the manifest's files, each file's size and SHA-256 match, and each parses in the
 * store format with the recorded number of usable records (every vector decodes to finite floats). A source file that
 * the provider itself would treat as an empty cache (unparseable, another format version) is not copied and is counted
 * in `skippedInvalid`. An absent store directory (semantic recall never wrote) is an empty snapshot.
 *
 * Results are classified, never thrown, and carry codes and counts only: no path, vector or metadata.
 */

export const VECTOR_SNAPSHOT_MANIFEST = '.snapshot.json';
export const VECTOR_SNAPSHOT_SCHEMA = 'quoky.vector-snapshot/1';

export type VectorSnapshotFailure =
  /** The store path exists but is not a readable directory, or a collection file could not be read. */
  | 'SOURCE_UNREADABLE'
  /** The target directory already exists. */
  | 'TARGET_EXISTS'
  /** Creating the target directory or writing a file failed (disk full, permissions, ...). */
  | 'COPY_FAILED'
  /** The re-read copy does not match its manifest. */
  | 'VERIFY_FAILED'
  /** The caller aborted (shutdown or the job's time bound). */
  | 'ABORTED';

export interface VectorSnapshotSummary {
  /** `false` when the store directory did not exist (an empty snapshot). */
  readonly storePresent: boolean;
  readonly collections: number;
  /** Usable records over all copied collections (what the provider would load). */
  readonly records: number;
  /** Source collection files the provider would treat as an empty cache; not copied. */
  readonly skippedInvalid: number;
}

export type VectorSnapshotResult =
  | ({ readonly ok: true } & VectorSnapshotSummary)
  | { readonly ok: false; readonly failure: VectorSnapshotFailure };

export type VectorStoreInspection =
  | ({ readonly ok: true } & VectorSnapshotSummary)
  | { readonly ok: false; readonly failure: 'SOURCE_UNREADABLE' };

export interface VectorSnapshotRequest {
  /** The live store directory (`QUOKY_VECTOR_PATH`). Only read. */
  readonly sourceDir: string;
  /** The snapshot directory to create (mode 700). Its parent must exist; it must not. */
  readonly targetDir: string;
  /** Aborting stops between files, removes what was written and resolves `ABORTED`. */
  readonly signal?: AbortSignal;
}

interface ManifestCollection {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly records: number;
}

interface Manifest {
  readonly schema: typeof VECTOR_SNAPSHOT_SCHEMA;
  readonly storePresent: boolean;
  readonly collections: readonly ManifestCollection[];
  readonly skippedInvalid: number;
}

class SnapshotStop extends Error {
  constructor(readonly failure: VectorSnapshotFailure) {
    super(failure);
  }
}

/** `<collection>.json` or the manifest: the only names a snapshot directory may hold (pruning removes only these). */
export function isVectorSnapshotEntryName(name: string): boolean {
  return name === VECTOR_SNAPSHOT_MANIFEST || COLLECTION_FILE_PATTERN.test(name);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Usable records in a collection file, or `null` when the provider would treat it as an empty cache. */
function countUsableRecords(bytes: Buffer): number | null {
  const entries = parseCollectionEntries(bytes.toString('utf8'));
  if (entries === null) return null;
  // Same rule as the provider's load: a later entry with the same id replaces the earlier one.
  const ids = new Set<string>();
  for (const entry of entries) {
    const decoded = decodeEntry(entry);
    if (decoded !== null) ids.add(decoded.id);
  }
  return ids.size;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The regular `<collection>.json` files of the store, sorted; `null` when the store directory does not exist. */
async function listCollectionFiles(dir: string): Promise<string[] | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SnapshotStop('SOURCE_UNREADABLE');
  }
  // Dirent types do not follow symlinks: a symlinked "collection" is never copied.
  return entries
    .filter((entry) => entry.isFile() && COLLECTION_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Reads one source collection file; `null` when it vanished between listing and reading. */
async function readSourceFile(dir: string, file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(join(dir, file));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SnapshotStop('SOURCE_UNREADABLE');
  }
}

/** Read-only scan of the live store (the dry-run report): what a snapshot would copy now. Never throws. */
export async function inspectVectorStore(sourceDir: string): Promise<VectorStoreInspection> {
  try {
    const files = await listCollectionFiles(sourceDir);
    if (files === null) return { ok: true, storePresent: false, collections: 0, records: 0, skippedInvalid: 0 };
    let collections = 0;
    let records = 0;
    let skippedInvalid = 0;
    for (const file of files) {
      const bytes = await readSourceFile(sourceDir, file);
      if (bytes === null) continue;
      const count = countUsableRecords(bytes);
      if (count === null) {
        skippedInvalid += 1;
        continue;
      }
      collections += 1;
      records += count;
    }
    return { ok: true, storePresent: true, collections, records, skippedInvalid };
  } catch {
    return { ok: false, failure: 'SOURCE_UNREADABLE' };
  }
}

async function removeSnapshotDir(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isVectorSnapshotEntryName(name)) continue;
    try {
      await fs.unlink(join(dir, name));
    } catch {
      // best effort
    }
  }
  try {
    await fs.rmdir(dir);
  } catch {
    // something foreign is inside, or it is already gone: leave it
  }
}

async function writePrivateFile(file: string, data: Buffer | string): Promise<void> {
  try {
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
    await fs.chmod(file, 0o600);
  } catch {
    throw new SnapshotStop('COPY_FAILED');
  }
}

/** Copy the store into `targetDir`, then verify the copy. Never throws. */
export async function writeVerifiedVectorSnapshot(request: VectorSnapshotRequest): Promise<VectorSnapshotResult> {
  const { sourceDir, targetDir, signal } = request;
  if (signal?.aborted) return { ok: false, failure: 'ABORTED' };
  try {
    await fs.mkdir(targetDir, { mode: 0o700 });
  } catch (error) {
    return { ok: false, failure: errorCode(error) === 'EEXIST' ? 'TARGET_EXISTS' : 'COPY_FAILED' };
  }
  try {
    try {
      await fs.chmod(targetDir, 0o700);
    } catch {
      throw new SnapshotStop('COPY_FAILED');
    }
    const files = await listCollectionFiles(sourceDir);
    const collections: ManifestCollection[] = [];
    let skippedInvalid = 0;
    for (const file of files ?? []) {
      if (signal?.aborted) throw new SnapshotStop('ABORTED');
      const bytes = await readSourceFile(sourceDir, file);
      if (bytes === null) continue;
      const records = countUsableRecords(bytes);
      if (records === null) {
        skippedInvalid += 1;
        continue;
      }
      await writePrivateFile(join(targetDir, file), bytes);
      collections.push({ file, bytes: bytes.length, sha256: sha256(bytes), records });
    }
    if (signal?.aborted) throw new SnapshotStop('ABORTED');
    const manifest: Manifest = {
      schema: VECTOR_SNAPSHOT_SCHEMA,
      storePresent: files !== null,
      collections,
      skippedInvalid,
    };
    await writePrivateFile(join(targetDir, VECTOR_SNAPSHOT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    const verified = await verifyVectorSnapshot(targetDir);
    if (!verified.ok) throw new SnapshotStop(verified.failure);
    return verified;
  } catch (error) {
    await removeSnapshotDir(targetDir);
    return { ok: false, failure: error instanceof SnapshotStop ? error.failure : 'COPY_FAILED' };
  }
}

function parseManifest(raw: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<Record<keyof Manifest, unknown>>;
  if (m.schema !== VECTOR_SNAPSHOT_SCHEMA || typeof m.storePresent !== 'boolean') return null;
  if (!Number.isSafeInteger(m.skippedInvalid) || (m.skippedInvalid as number) < 0) return null;
  if (!Array.isArray(m.collections)) return null;
  const collections: ManifestCollection[] = [];
  const seen = new Set<string>();
  for (const entry of m.collections as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const c = entry as Partial<Record<keyof ManifestCollection, unknown>>;
    if (typeof c.file !== 'string' || !COLLECTION_FILE_PATTERN.test(c.file) || seen.has(c.file)) return null;
    if (!Number.isSafeInteger(c.bytes) || !Number.isSafeInteger(c.records) || typeof c.sha256 !== 'string') return null;
    seen.add(c.file);
    collections.push({ file: c.file, bytes: c.bytes as number, sha256: c.sha256, records: c.records as number });
  }
  return { schema: VECTOR_SNAPSHOT_SCHEMA, storePresent: m.storePresent, collections, skippedInvalid: m.skippedInvalid as number };
}

/**
 * Verify a snapshot directory read-only: exactly the manifest's files, each matching its size, SHA-256 and usable
 * record count. Used right after writing, and by the restore drill (`backup-now --verify`). Never throws.
 */
export async function verifyVectorSnapshot(dir: string): Promise<VectorSnapshotResult> {
  try {
    const manifest = parseManifest(await fs.readFile(join(dir, VECTOR_SNAPSHOT_MANIFEST), 'utf8'));
    if (manifest === null) return { ok: false, failure: 'VERIFY_FAILED' };
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const expected = new Set([VECTOR_SNAPSHOT_MANIFEST, ...manifest.collections.map((c) => c.file)]);
    if (entries.length !== expected.size) return { ok: false, failure: 'VERIFY_FAILED' };
    for (const entry of entries) {
      if (!entry.isFile() || !expected.has(entry.name)) return { ok: false, failure: 'VERIFY_FAILED' };
    }
    let records = 0;
    for (const collection of manifest.collections) {
      const bytes = await fs.readFile(join(dir, collection.file));
      if (bytes.length !== collection.bytes || sha256(bytes) !== collection.sha256) return { ok: false, failure: 'VERIFY_FAILED' };
      if (countUsableRecords(bytes) !== collection.records) return { ok: false, failure: 'VERIFY_FAILED' };
      records += collection.records;
    }
    return {
      ok: true,
      storePresent: manifest.storePresent,
      collections: manifest.collections.length,
      records,
      skippedInvalid: manifest.skippedInvalid,
    };
  } catch {
    return { ok: false, failure: 'VERIFY_FAILED' };
  }
}
