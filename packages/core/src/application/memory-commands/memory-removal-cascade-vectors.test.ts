import { describe, expect, it } from 'vitest';
import type { VectorProvider } from '../../ports';
import { memoryVectorUnits } from '../recall/memory-passages';
import { durableMemoryCollectionFor, DURABLE_MEMORY_VECTOR_COLLECTION } from '../recall/semantic-recall-scorer';
import { createVectorRemovalCascade } from './memory-removal-cascade';

function store(initial: Record<string, string[]>) {
  const collections = new Map(Object.entries(initial).map(([name, ids]) => [name, new Set(ids)]));
  const provider: Pick<VectorProvider, 'delete' | 'listCollections'> = {
    async delete(collection, ids) {
      const found = collections.get(collection);
      if (found === undefined) return;
      for (const id of ids) found.delete(id);
    },
    async listCollections() { return [...collections.keys()]; },
  };
  return { provider, collections };
}

const LONG = ['one', 'two', 'three'].map((word) => `${word} ${'filler text '.repeat(70)}`.slice(0, 700)).join('\n\n');

describe('forget removes every vector of a memory (ADR-0124 section 5.5, ADR-0106 amendment)', () => {
  it('deletes the memory id and ALL passage vectors from every embedding space, and the legacy v1 entry', async () => {
    const passages = memoryVectorUnits('mem-1', LONG, true).map((unit) => unit.vectorId);
    expect(passages.length).toBeGreaterThan(1);
    const spaceA = durableMemoryCollectionFor('a/aaaaaaaaaaaa/p00000000');
    const spaceB = durableMemoryCollectionFor('b/bbbbbbbbbbbb/p00000000');
    const { provider, collections } = store({
      [DURABLE_MEMORY_VECTOR_COLLECTION]: ['mem-1', 'mem-2'],
      [spaceA]: [...passages, 'mem-2', 'mem-2#0'],
      [spaceB]: ['mem-1', ...passages],
      'learning-example-v1': ['mem-1'],
    });
    await createVectorRemovalCascade(provider).onMemoriesRemoved({ actorId: 'a', reason: 'forget', memoryIds: ['mem-1'], vectorIds: [], contents: [LONG] });
    expect([...(collections.get(spaceA) ?? [])].sort()).toEqual(['mem-2', 'mem-2#0']);
    expect([...(collections.get(spaceB) ?? [])]).toEqual([]);
    expect([...(collections.get(DURABLE_MEMORY_VECTOR_COLLECTION) ?? [])]).toEqual(['mem-2']);
    // the learning-example collection is another cascade's business
    expect([...(collections.get('learning-example-v1') ?? [])]).toEqual(['mem-1']);
  });

  it('a store that cannot list collections still clears the legacy collection and creates nothing', async () => {
    const deletes: string[] = [];
    await createVectorRemovalCascade({ async delete(collection) { deletes.push(collection); } }).onMemoriesRemoved({ actorId: 'a', reason: 'edit', memoryIds: ['m'], vectorIds: [], contents: [] });
    expect(deletes).toEqual([DURABLE_MEMORY_VECTOR_COLLECTION]);
  });
});
