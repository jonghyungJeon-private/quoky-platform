import { existsSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalVectorProvider } from './index';
import type { VectorStoreIo } from './index';

const COLLECTION = 'durable-memory-v1';
const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quoky-vector-test-'));
  roots.push(root);
  return join(root, 'vectors');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const realIo: VectorStoreIo = {
  readFile: (path) => fsPromises.readFile(path, 'utf8'),
  writeFile: (path, data) => fsPromises.writeFile(path, data, { encoding: 'utf8', flag: 'wx' }),
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (path) => fsPromises.unlink(path),
  mkdir: async (path) => {
    await fsPromises.mkdir(path, { recursive: true });
  },
};

describe('LocalVectorProvider (ADR-0098 D8)', () => {
  it('creates nothing on init and returns no results for a missing collection', async () => {
    const storePath = freshRoot();
    const store = new LocalVectorProvider(storePath);
    await store.init();
    expect(existsSync(storePath)).toBe(false);
    await expect(store.query(COLLECTION, [1, 0], 5)).resolves.toEqual([]);
  });

  it('upserts and answers cosine top-K with metadata, skipping records of other dimensions', async () => {
    const store = new LocalVectorProvider(freshRoot());
    await store.upsert(COLLECTION, [
      { id: 'a', vector: [1, 0], metadata: { contentHash: 'ha', space: 's', dimensions: 2 } },
      { id: 'b', vector: [0.6, 0.8] },
      { id: 'c', vector: [0, 1] },
      { id: 'three-d', vector: [1, 0, 0] },
    ]);

    const results = await store.query(COLLECTION, [1, 0], 2);
    expect(results.map((result) => result.id)).toEqual(['a', 'b']);
    expect(results[0]?.score).toBeCloseTo(1);
    expect(results[1]?.score).toBeCloseTo(0.6);
    expect(results[0]?.metadata).toEqual({ contentHash: 'ha', space: 's', dimensions: 2 });
    expect((await store.query(COLLECTION, [1, 0], 10)).map((result) => result.id)).toEqual(['a', 'b', 'c']);
    expect(await store.query(COLLECTION, [1, 0], 0)).toEqual([]);
  });

  it('returns metadata copies the caller cannot use to mutate the store', async () => {
    const store = new LocalVectorProvider(freshRoot());
    await store.upsert(COLLECTION, [{ id: 'a', vector: [1, 0], metadata: { tag: 'x' } }]);
    const [first] = await store.query(COLLECTION, [1, 0], 1);
    if (first?.metadata) first.metadata.tag = 'mutated';
    expect((await store.query(COLLECTION, [1, 0], 1))[0]?.metadata).toEqual({ tag: 'x' });
  });

  it('survives a reopen and keeps upsert, replace and delete', async () => {
    const storePath = freshRoot();
    const first = new LocalVectorProvider(storePath);
    await first.upsert(COLLECTION, [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0, 1] },
    ]);
    await first.upsert(COLLECTION, [{ id: 'a', vector: [0, 1], metadata: { v: 2 } }]);
    await first.delete(COLLECTION, ['b']);

    const reopened = new LocalVectorProvider(storePath);
    const results = await reopened.query(COLLECTION, [0, 1], 10);
    expect(results.map((result) => result.id)).toEqual(['a']);
    expect(results[0]?.score).toBeCloseTo(1);
    expect(results[0]?.metadata).toEqual({ v: 2 });
    expect(readdirSync(storePath)).toEqual([`${COLLECTION}.json`]);
  });

  it('delete is idempotent and writes nothing when no id is stored (ADR-0106 D5 forget with recall off)', async () => {
    const storePath = freshRoot();
    let writes = 0;
    const counting: VectorStoreIo = {
      ...realIo,
      writeFile: async (path, data) => {
        writes += 1;
        await realIo.writeFile(path, data);
      },
    };
    const empty = new LocalVectorProvider(storePath, { io: counting });
    await empty.delete(COLLECTION, ['never-stored']);
    expect(writes).toBe(0);
    expect(existsSync(storePath)).toBe(false);

    await empty.upsert(COLLECTION, [{ id: 'kept', vector: [1, 0] }, { id: 'gone', vector: [0, 1] }]);
    expect(writes).toBe(1);
    await empty.delete(COLLECTION, ['absent']);
    expect(writes).toBe(1);
    await empty.delete(COLLECTION, ['gone', 'absent']);
    expect(writes).toBe(2);
    await empty.delete(COLLECTION, ['gone']);
    expect(writes).toBe(2);
    const reopened = new LocalVectorProvider(storePath);
    expect((await reopened.query(COLLECTION, [1, 0], 10)).map((result) => result.id)).toEqual(['kept']);
  });

  it('writes atomically: a failed write leaves the previous file and in-memory view intact', async () => {
    const storePath = freshRoot();
    const seeded = new LocalVectorProvider(storePath);
    await seeded.upsert(COLLECTION, [{ id: 'kept', vector: [1, 0] }]);
    const before = readFileSync(join(storePath, `${COLLECTION}.json`), 'utf8');

    let failRename = true;
    const flaky = new LocalVectorProvider(storePath, {
      io: {
        ...realIo,
        rename: async (from, to) => {
          if (failRename) throw new Error('simulated crash before rename');
          await realIo.rename(from, to);
        },
      },
    });
    await expect(flaky.upsert(COLLECTION, [{ id: 'lost', vector: [0, 1] }])).rejects.toThrow('simulated crash');

    expect(readFileSync(join(storePath, `${COLLECTION}.json`), 'utf8')).toBe(before);
    expect(readdirSync(storePath)).toEqual([`${COLLECTION}.json`]); // no temporary file left behind
    expect((await flaky.query(COLLECTION, [1, 0], 10)).map((result) => result.id)).toEqual(['kept']);

    failRename = false;
    await flaky.upsert(COLLECTION, [{ id: 'later', vector: [0, 1] }]);
    expect((await new LocalVectorProvider(storePath).query(COLLECTION, [1, 0], 10)).map((r) => r.id).sort()).toEqual([
      'kept',
      'later',
    ]);
  });

  it('a failed temporary write never touches the target file', async () => {
    const storePath = freshRoot();
    const store = new LocalVectorProvider(storePath, {
      io: {
        ...realIo,
        writeFile: async () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(store.upsert(COLLECTION, [{ id: 'a', vector: [1] }])).rejects.toThrow('disk full');
    expect(existsSync(join(storePath, `${COLLECTION}.json`))).toBe(false);
  });

  it.each(['', '../escape', 'a/b', 'UPPER', '-leading', 'with space', 'x'.repeat(65), 'dot.json'])(
    'rejects the collection name %j',
    async (collection) => {
      const store = new LocalVectorProvider(freshRoot());
      await expect(store.upsert(collection, [{ id: 'a', vector: [1] }])).rejects.toThrow(TypeError);
      await expect(store.query(collection, [1], 1)).rejects.toThrow(TypeError);
      await expect(store.delete(collection, ['a'])).rejects.toThrow(TypeError);
    },
  );

  it('rejects invalid records and query vectors', async () => {
    const store = new LocalVectorProvider(freshRoot());
    await expect(store.upsert(COLLECTION, [{ id: '', vector: [1] }])).rejects.toThrow(TypeError);
    await expect(store.upsert(COLLECTION, [{ id: 'a', vector: [] }])).rejects.toThrow(TypeError);
    await expect(store.upsert(COLLECTION, [{ id: 'a', vector: [Number.NaN] }])).rejects.toThrow(TypeError);
    await expect(store.query(COLLECTION, [Number.POSITIVE_INFINITY], 1)).rejects.toThrow(TypeError);
  });

  it('enforces the per-collection cap by evicting the oldest-written records', async () => {
    const storePath = freshRoot();
    const store = new LocalVectorProvider(storePath, { maxRecordsPerCollection: 3 });
    await store.upsert(COLLECTION, [
      { id: 'r1', vector: [1, 0] },
      { id: 'r2', vector: [1, 0] },
      { id: 'r3', vector: [1, 0] },
    ]);
    await store.upsert(COLLECTION, [{ id: 'r1', vector: [1, 0] }]); // rewritten → newest
    await store.upsert(COLLECTION, [{ id: 'r4', vector: [1, 0] }]);

    const ids = (await store.query(COLLECTION, [1, 0], 10)).map((result) => result.id).sort();
    expect(ids).toEqual(['r1', 'r3', 'r4']);
    const reopened = await new LocalVectorProvider(storePath, { maxRecordsPerCollection: 3 }).query(COLLECTION, [1, 0], 10);
    expect(reopened.map((result) => result.id).sort()).toEqual(['r1', 'r3', 'r4']);
    expect(() => new LocalVectorProvider(storePath, { maxRecordsPerCollection: 0 })).toThrow(RangeError);
  });

  it('treats a corrupt file as an empty, rebuildable cache', async () => {
    const storePath = freshRoot();
    await fsPromises.mkdir(storePath, { recursive: true });
    writeFileSync(join(storePath, `${COLLECTION}.json`), '{not json');
    const store = new LocalVectorProvider(storePath);
    await expect(store.query(COLLECTION, [1], 1)).resolves.toEqual([]);
    await store.upsert(COLLECTION, [{ id: 'a', vector: [1] }]);
    expect((await new LocalVectorProvider(storePath).query(COLLECTION, [1], 1)).map((r) => r.id)).toEqual(['a']);
  });

  it('serializes concurrent writes to one collection', async () => {
    const storePath = freshRoot();
    const store = new LocalVectorProvider(storePath);
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => store.upsert(COLLECTION, [{ id: `c${index}`, vector: [1, index] }])),
    );
    const reopened = await new LocalVectorProvider(storePath).query(COLLECTION, [1, 0], 20);
    expect(reopened).toHaveLength(8);
  });

  it('keeps collections in separate files', async () => {
    const storePath = freshRoot();
    const store = new LocalVectorProvider(storePath);
    await store.upsert('alpha', [{ id: 'a', vector: [1] }]);
    await store.upsert('beta', [{ id: 'b', vector: [1] }]);
    expect(readdirSync(storePath).sort()).toEqual(['alpha.json', 'beta.json']);
    expect((await store.query('alpha', [1], 5)).map((r) => r.id)).toEqual(['a']);
  });
});
