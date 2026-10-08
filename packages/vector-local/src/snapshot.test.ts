import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalVectorProvider,
  VECTOR_SNAPSHOT_MANIFEST,
  inspectVectorStore,
  isVectorSnapshotEntryName,
  verifyVectorSnapshot,
  writeVerifiedVectorSnapshot,
} from './index';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fresh(): { store: string; backups: string } {
  const root = mkdtempSync(join(tmpdir(), 'quoky-vector-snapshot-'));
  roots.push(root);
  const backups = join(root, 'backups');
  mkdirSync(backups);
  return { store: join(root, 'vectors'), backups };
}

const mode = (p: string): number => statSync(p).mode & 0o777;

async function seed(store: string): Promise<void> {
  const provider = new LocalVectorProvider(store);
  await provider.upsert('durable-memory-v1', [
    { id: 'memory-1', vector: [1, 0, 0], metadata: { contentHash: 'a', space: 's', dimensions: 3 } },
    { id: 'memory-2', vector: [0, 1, 0], metadata: { contentHash: 'b', space: 's', dimensions: 3 } },
  ]);
  await provider.upsert('curated-examples-v1', [{ id: 'example-1', vector: [0, 0, 1] }]);
}

describe('vector store snapshot (backup set, ADR-0102 D6 follow-up)', () => {
  it('copies every collection byte for byte with a manifest, dir 700, files 600, and verifies counts', async () => {
    const { store, backups } = fresh();
    await seed(store);
    const target = join(backups, 'quoky-20261007T190000Z-daily.vectors');
    const result = await writeVerifiedVectorSnapshot({ sourceDir: store, targetDir: target });
    expect(result).toEqual({ ok: true, storePresent: true, collections: 2, records: 3, skippedInvalid: 0 });

    expect(readdirSync(target).sort()).toEqual([VECTOR_SNAPSHOT_MANIFEST, 'curated-examples-v1.json', 'durable-memory-v1.json']);
    expect(mode(target)).toBe(0o700);
    for (const name of readdirSync(target)) expect(mode(join(target, name))).toBe(0o600);
    for (const file of ['curated-examples-v1.json', 'durable-memory-v1.json']) {
      expect(readFileSync(join(target, file))).toEqual(readFileSync(join(store, file)));
    }
    const manifest = JSON.parse(readFileSync(join(target, VECTOR_SNAPSHOT_MANIFEST), 'utf8'));
    const durable = readFileSync(join(store, 'durable-memory-v1.json'));
    expect(manifest).toMatchObject({ schema: 'quoky.vector-snapshot/1', storePresent: true, skippedInvalid: 0 });
    expect(manifest.collections).toContainEqual({
      file: 'durable-memory-v1.json',
      bytes: durable.length,
      sha256: createHash('sha256').update(durable).digest('hex'),
      records: 2,
    });
    // The manifest holds counts and hashes only: no vector, id or metadata.
    expect(JSON.stringify(manifest)).not.toContain('memory-1');

    // The restored copy is a working store with the same answers.
    const restored = new LocalVectorProvider(target);
    const hits = await restored.query('durable-memory-v1', [1, 0, 0], 5);
    expect(hits.map((h) => h.id)).toEqual(['memory-1', 'memory-2']);
    expect(await verifyVectorSnapshot(target)).toEqual(result);
  });

  it('an absent store is an empty, verified snapshot (storePresent false)', async () => {
    const { store, backups } = fresh();
    const target = join(backups, 'snap');
    const result = await writeVerifiedVectorSnapshot({ sourceDir: store, targetDir: target });
    expect(result).toEqual({ ok: true, storePresent: false, collections: 0, records: 0, skippedInvalid: 0 });
    expect(readdirSync(target)).toEqual([VECTOR_SNAPSHOT_MANIFEST]);
    expect(existsSync(store)).toBe(false);
  });

  it('copies only regular <collection>.json files: no provider temp file, symlink or foreign file; skips unusable ones', async () => {
    const { store, backups } = fresh();
    await seed(store);
    writeFileSync(join(store, '.durable-memory-v1.0f0e.tmp'), '{"version":1,"records":[]}');
    writeFileSync(join(store, 'notes.txt'), 'foreign');
    writeFileSync(join(store, 'broken-v1.json'), '{not json');
    writeFileSync(join(store, 'future-v1.json'), JSON.stringify({ version: 2, records: [] }));
    const outside = join(backups, '..', 'outside.json');
    writeFileSync(outside, JSON.stringify({ version: 1, records: [] }));
    symlinkSync(outside, join(store, 'linked-v1.json'));

    const target = join(backups, 'snap');
    const result = await writeVerifiedVectorSnapshot({ sourceDir: store, targetDir: target });
    expect(result).toEqual({ ok: true, storePresent: true, collections: 2, records: 3, skippedInvalid: 2 });
    expect(readdirSync(target).sort()).toEqual([VECTOR_SNAPSHOT_MANIFEST, 'curated-examples-v1.json', 'durable-memory-v1.json']);
    expect(await inspectVectorStore(store)).toEqual({ ok: true, storePresent: true, collections: 2, records: 3, skippedInvalid: 2 });
  });

  it('refuses an existing target, and verification catches a changed, missing or extra file', async () => {
    const { store, backups } = fresh();
    await seed(store);
    const target = join(backups, 'snap');
    mkdirSync(target);
    expect(await writeVerifiedVectorSnapshot({ sourceDir: store, targetDir: target })).toEqual({ ok: false, failure: 'TARGET_EXISTS' });
    rmSync(target, { recursive: true });

    expect((await writeVerifiedVectorSnapshot({ sourceDir: store, targetDir: target })).ok).toBe(true);
    const file = join(target, 'durable-memory-v1.json');
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original.subarray(0, original.length - 3), Buffer.from(']}\n')]));
    expect(await verifyVectorSnapshot(target)).toEqual({ ok: false, failure: 'VERIFY_FAILED' });
    writeFileSync(file, original);
    expect((await verifyVectorSnapshot(target)).ok).toBe(true);
    writeFileSync(join(target, 'extra-v1.json'), original);
    expect(await verifyVectorSnapshot(target)).toEqual({ ok: false, failure: 'VERIFY_FAILED' });
    rmSync(join(target, 'extra-v1.json'));
    rmSync(join(target, VECTOR_SNAPSHOT_MANIFEST));
    expect(await verifyVectorSnapshot(target)).toEqual({ ok: false, failure: 'VERIFY_FAILED' });
  });

  it('an unreadable store fails SOURCE_UNREADABLE and an abort fails ABORTED, both removing the partial target', async () => {
    const { store, backups } = fresh();
    writeFileSync(store, 'a file where the store directory should be');
    const target = join(backups, 'snap');
    expect(await writeVerifiedVectorSnapshot({ sourceDir: store, targetDir: target })).toEqual({ ok: false, failure: 'SOURCE_UNREADABLE' });
    expect(existsSync(target)).toBe(false);
    expect(await inspectVectorStore(store)).toEqual({ ok: false, failure: 'SOURCE_UNREADABLE' });

    const other = fresh();
    await seed(other.store);
    const controller = new AbortController();
    controller.abort();
    const aborted = await writeVerifiedVectorSnapshot({ sourceDir: other.store, targetDir: join(other.backups, 'snap'), signal: controller.signal });
    expect(aborted).toEqual({ ok: false, failure: 'ABORTED' });
    expect(readdirSync(other.backups)).toEqual([]);
  });

  it('names a snapshot directory may hold: collection files and the manifest only', () => {
    expect(isVectorSnapshotEntryName('durable-memory-v1.json')).toBe(true);
    expect(isVectorSnapshotEntryName(VECTOR_SNAPSHOT_MANIFEST)).toBe(true);
    for (const name of ['notes.txt', '.durable-memory-v1.abc.tmp', '../x.json', 'UPPER.json']) {
      expect(isVectorSnapshotEntryName(name)).toBe(false);
    }
  });
});
