import { describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider, AiRequest, ProviderSelector, VectorProvider, VectorQueryResult, VectorRecord } from '../../ports';
import { MAX_DURABLE_CONTENT_CHARACTERS } from '../memory-writer';
import { allMemoryVectorIds, MAX_PASSAGES_PER_MEMORY, memoryVectorUnits } from './memory-passages';
import { chunk } from '../chunking';
import { cosineSimilarity, formatEmbeddingEnvelope, readEmbeddingRole } from './embedding-envelope';
import { DURABLE_MEMORY_V2_COLLECTION_PREFIX, durableMemoryCollectionFor, SemanticRecallScorer } from './semantic-recall-scorer';

const SPACE = 'fake-embed/aaaaaaaaaaaa/p12345678';

/** [pet, food, work, bias]: a concept embedding, so lexically disjoint texts can share a concept. */
function conceptVector(text: string): number[] {
  return [/고양이|cat/u.test(text) ? 1 : 0, /커피|coffee/u.test(text) ? 1 : 0, /회의|meeting/u.test(text) ? 1 : 0, 0.1];
}

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  readonly requests: AiRequest[] = [];
  constructor(private readonly space = SPACE) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async execute(request: AiRequest) {
    this.requests.push(request);
    return { text: formatEmbeddingEnvelope(conceptVector(request.prompt), this.space) };
  }
  roles(): Array<string | undefined> {
    return this.requests.map((request) => readEmbeddingRole(request.metadata));
  }
}

class Store implements VectorProvider {
  readonly collections = new Map<string, Map<string, VectorRecord>>();
  async init(): Promise<void> {}
  private of(name: string): Map<string, VectorRecord> {
    let found = this.collections.get(name);
    if (found === undefined) this.collections.set(name, (found = new Map()));
    return found;
  }
  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    for (const record of records) this.of(collection).set(record.id, record);
  }
  async query(collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    return [...this.of(collection).values()]
      .filter((record) => record.vector.length === vector.length)
      .map((record) => ({ id: record.id, score: cosineSimilarity(vector, record.vector), ...(record.metadata ? { metadata: record.metadata } : {}) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async delete(collection: string, ids: string[]): Promise<void> {
    for (const id of ids) this.of(collection).delete(id);
  }
}

const selectorFor = (provider: AiProvider): ProviderSelector => ({ select: async () => provider });

/** Three paragraphs of about 700 characters each, so the chunker cuts three passages; only the middle one is about coffee. */
const LONG_ID = 'long-1';
const paragraph = (seed: string, extra = ''): string => `${extra} ${seed} `.repeat(1).padEnd(700, `${seed} `).slice(0, 700).trim();
const LONG = [paragraph('plain filler text about the weather', '고양이 이야기'), paragraph('another filler about gardens', '커피 이야기'), paragraph('closing notes about shelves', '회의 이야기')].join('\n\n');

function setup(options: ConstructorParameters<typeof SemanticRecallScorer>[1] = {}, provider = new FakeProvider()) {
  const vectors = new Store();
  const scorer = new SemanticRecallScorer(
    { selector: selectorFor(provider), vectors },
    { collectionFor: durableMemoryCollectionFor, multiVector: true, ...options },
  );
  return { scorer, vectors, provider, collection: durableMemoryCollectionFor(SPACE) };
}

describe('durable memory vector units (ADR-0124 section 5.1, 5.2)', () => {
  it('a short memory keeps one vector whose id is the memory id and whose text is the whole content', () => {
    expect(memoryVectorUnits('m1', '우리 집 고양이 이름은 나비야', true)).toEqual([{ vectorId: 'm1', text: '우리 집 고양이 이름은 나비야' }]);
  });

  it('a long memory has one vector per passage with ids <memoryId>#<ordinal>; single-vector mode keeps the whole text', () => {
    const units = memoryVectorUnits(LONG_ID, LONG, true);
    expect(units.length).toBeGreaterThan(1);
    expect(units.map((unit) => unit.vectorId)).toEqual(units.map((_, ordinal) => `${LONG_ID}#${ordinal}`));
    expect(memoryVectorUnits(LONG_ID, LONG, false)).toEqual([{ vectorId: LONG_ID, text: LONG }]);
  });

  it('allMemoryVectorIds names the memory id and every passage id a store can hold', () => {
    const ids = allMemoryVectorIds('x');
    expect(ids).toHaveLength(MAX_PASSAGES_PER_MEMORY + 1);
    expect(ids.slice(0, 3)).toEqual(['x', 'x#0', 'x#1']);
    const units = memoryVectorUnits(LONG_ID, LONG, true);
    for (const unit of units) expect(allMemoryVectorIds(LONG_ID)).toContain(unit.vectorId);
  });
});

describe('passage bound (ADR-0124 section 5.6: nothing silently unembedded)', () => {
  it('the chunker never yields more than MAX_PASSAGES_PER_MEMORY for a memory of the maximum length, for any shape', () => {
    const max = MAX_DURABLE_CONTENT_CHARACTERS;
    const shapes: Record<string, string> = {
      oneLongParagraph: 'word '.repeat(max).slice(0, max),
      shortLines: 'a\n'.repeat(max).slice(0, max),
      blankLineSeparated: 'x\n\n'.repeat(max).slice(0, max),
      sentences: '가나다라. '.repeat(max).slice(0, max),
      bullets: '- item\n'.repeat(max).slice(0, max),
      noBreaks: 'a'.repeat(max),
      combiningMarks: `e${'\u0301'.repeat(max - 1)}`,
      emoji: '😀'.repeat(max / 2),
      table: '| a | b |\n'.repeat(max).slice(0, max),
    };
    for (const [name, text] of Object.entries(shapes)) {
      const units = memoryVectorUnits('m', text, true);
      expect(units.length, name).toBeLessThanOrEqual(MAX_PASSAGES_PER_MEMORY);
      // nothing is cut: with this few passages every passage is a unit
      expect(chunk(text).length, name).toBeLessThanOrEqual(MAX_PASSAGES_PER_MEMORY);
    }
  });
});

describe('durableMemoryCollectionFor (ADR-0124 section 5.3)', () => {
  it('is a valid store name under the v2 prefix and differs for every space', () => {
    const names = [SPACE, 'fake-embed/bbbbbbbbbbbb/p12345678', 'fake-embed/aaaaaaaaaaaa/p87654321', 'fake:embed/aaaaaaaaaaaa/p12345678', 'fake-embed-aaaaaaaaaaaa-p12345678'].map(durableMemoryCollectionFor);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(name.startsWith(DURABLE_MEMORY_V2_COLLECTION_PREFIX)).toBe(true);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(durableMemoryCollectionFor('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });
});

describe('multi-vector scoring', () => {
  it('stores one vector per passage and scores the memory by its best passage', async () => {
    const { scorer, vectors, collection } = setup({ maxNewEmbeddingsPerTurn: 10 });
    const scores = await scorer.score('커피 한 잔', [{ id: LONG_ID, content: LONG }]);
    const stored = vectors.collections.get(collection);
    const units = memoryVectorUnits(LONG_ID, LONG, true);
    expect([...(stored?.keys() ?? [])].sort()).toEqual(units.map((unit) => unit.vectorId).sort());
    expect(stored?.get(`${LONG_ID}#0`)?.metadata).toMatchObject({ space: SPACE, memoryId: LONG_ID });
    // the coffee passage matches the coffee query best: score = max cosine over passages, not the whole-text cosine
    const best = Math.max(...units.map((unit) => cosineSimilarity(conceptVector('커피 한 잔'), conceptVector(unit.text))));
    expect(scores?.get(LONG_ID)).toBeCloseTo(best, 10);
    expect(scores?.get(LONG_ID)).toBeGreaterThan(cosineSimilarity(conceptVector('커피 한 잔'), conceptVector(LONG)) - 1e-9);
  });

  it('counts every new passage against the per-turn bound and scores from the passages that exist so far', async () => {
    const { scorer, provider, vectors, collection } = setup({ maxNewEmbeddingsPerTurn: 2 });
    const units = memoryVectorUnits(LONG_ID, LONG, true);
    expect(units.length).toBe(3);
    const first = await scorer.score('고양이', [{ id: LONG_ID, content: LONG }]);
    expect(provider.roles().filter((role) => role === 'document')).toHaveLength(2);
    expect(vectors.collections.get(collection)?.size).toBe(2);
    expect(first?.has(LONG_ID)).toBe(true);
    await scorer.score('고양이', [{ id: LONG_ID, content: LONG }]);
    expect(vectors.collections.get(collection)?.size).toBe(3);
    // fully indexed: the third turn embeds no document
    const before = provider.requests.length;
    await scorer.score('고양이', [{ id: LONG_ID, content: LONG }]);
    expect(provider.requests.length - before).toBe(1);
  });

  it('a different space uses a different collection: vectors never mix', async () => {
    const vectors = new Store();
    const a = new FakeProvider('space-a/aaaaaaaaaaaa/p00000000');
    const b = new FakeProvider('space-b/bbbbbbbbbbbb/p00000000');
    const content = '우리 집 고양이 이름은 나비야';
    for (const provider of [a, b]) {
      const scorer = new SemanticRecallScorer({ selector: selectorFor(provider), vectors }, { collectionFor: durableMemoryCollectionFor, multiVector: true });
      await scorer.score('고양이', [{ id: 'm', content }]);
    }
    expect([...vectors.collections.keys()].sort()).toEqual(['space-a/aaaaaaaaaaaa/p00000000', 'space-b/bbbbbbbbbbbb/p00000000'].map(durableMemoryCollectionFor).sort());
    // the b-scorer found nothing of a's in its own collection and embedded afresh
    expect(b.roles()).toEqual(['query', 'document']);
  });

  it('an old v1-style single vector is not read: the legacy collection is never queried', async () => {
    const { scorer, vectors, provider } = setup();
    await vectors.upsert('durable-memory-v1', [{ id: 'm', vector: conceptVector('고양이'), metadata: { contentHash: 'x', space: SPACE, dimensions: 4 } }]);
    await scorer.score('고양이', [{ id: 'm', content: '고양이 이야기' }]);
    expect(provider.roles()).toEqual(['query', 'document']);
  });
});

describe('semantic session (one query embedding per turn)', () => {
  it('embeds the query once for candidate generation and scoring', async () => {
    const { scorer, provider } = setup({ maxNewEmbeddingsPerTurn: 10 });
    const session = await scorer.openSession('커피');
    expect(session).not.toBeNull();
    await session?.nearestMemoryIds(5);
    await session?.score([{ id: 'm', content: '아침 커피' }]);
    expect(provider.roles().filter((role) => role === 'query')).toHaveLength(1);
  });

  it('lists the memories nearest to the query by max-sim over their passages, best first, bounded by the limit', async () => {
    const { scorer, vectors, collection } = setup({ maxNewEmbeddingsPerTurn: 10 });
    const meta = (memoryId?: string) => ({ contentHash: 'h', space: SPACE, dimensions: 4, ...(memoryId === undefined ? {} : { memoryId }) });
    await vectors.upsert(collection, [
      { id: 'cat', vector: conceptVector('고양이'), metadata: meta() },
      { id: 'mix#0', vector: conceptVector('회의'), metadata: meta('mix') },
      { id: 'mix#1', vector: conceptVector('고양이 커피'), metadata: meta('mix') },
      { id: 'work', vector: conceptVector('회의'), metadata: meta() },
      { id: 'other-space', vector: conceptVector('고양이'), metadata: { ...meta(), space: 'elsewhere' } },
    ]);
    const session = await scorer.openSession('고양이');
    const ids = await session?.nearestMemoryIds(3);
    expect(ids).toEqual(['cat', 'mix', 'work']);
    expect(await session?.nearestMemoryIds(1)).toEqual(['cat']);
    expect(await session?.nearestMemoryIds(0)).toEqual([]);
  });

  it('no provider, a failing store or a credential-like query yields no session', async () => {
    const none = new SemanticRecallScorer({ selector: { select: async () => { throw new Error('none'); } }, vectors: new Store() }, { collectionFor: durableMemoryCollectionFor });
    expect(await none.openSession('커피')).toBeNull();
    const failing = new Store();
    failing.query = async () => { throw new Error('store down'); };
    const broken = new SemanticRecallScorer({ selector: selectorFor(new FakeProvider()), vectors: failing }, { collectionFor: durableMemoryCollectionFor });
    expect(await broken.openSession('커피')).toBeNull();
    const provider = new FakeProvider();
    const guarded = new SemanticRecallScorer({ selector: selectorFor(provider), vectors: new Store() }, { collectionFor: durableMemoryCollectionFor });
    expect(await guarded.openSession('password=hunter2hunter2 sk-ABCDEFGHIJKLMNOPQRSTUVWX')).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });
});
