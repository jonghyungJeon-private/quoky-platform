import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  SemanticRecallScorer,
  cosineSimilarity,
  durableMemoryCollectionFor,
  formatEmbeddingEnvelope,
  memoryVectorUnits,
  MemoryType,
  type AiProvider,
  type AiRequest,
  type MemoryRecord,
  type VectorProvider,
  type VectorQueryResult,
  type VectorRecord,
} from '@quoky/core';
import { MemoryVectorBackfill, liveDurableMemories } from './memory-vector-backfill';

const SPACE = 'fake-embed/aaaaaaaaaaaa/v0.40.14/p12345678';
const COLLECTION = durableMemoryCollectionFor(SPACE);
const NOW = '2026-11-06T00:00:00.000Z';

const vectorOf = (text: string): number[] => [/고양이|cat/u.test(text) ? 1 : 0, /커피|coffee/u.test(text) ? 1 : 0, 0.1];

class Provider implements AiProvider {
  readonly id = 'fake';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  readonly prompts: string[] = [];
  down = false;
  concurrent = 0;
  maxConcurrent = 0;
  async isAvailable() { return !this.down; }
  async execute(request: AiRequest) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.concurrent -= 1;
    this.prompts.push(request.prompt);
    return { text: formatEmbeddingEnvelope(vectorOf(request.prompt), SPACE) };
  }
}

class Store implements VectorProvider {
  readonly collections = new Map<string, Map<string, VectorRecord>>();
  of(name: string) { let found = this.collections.get(name); if (!found) this.collections.set(name, (found = new Map())); return found; }
  async init() {}
  async upsert(collection: string, records: VectorRecord[]) { for (const record of records) this.of(collection).set(record.id, record); }
  async query(collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    return [...this.of(collection).values()].filter((r) => r.vector.length === vector.length).map((r) => ({ id: r.id, score: cosineSimilarity(vector, r.vector), ...(r.metadata ? { metadata: r.metadata } : {}) })).slice(0, topK);
  }
  async delete(collection: string, ids: string[]) { for (const id of ids) this.of(collection).delete(id); }
  ids() { return [...this.of(COLLECTION).keys()].sort(); }
}

const LONG = ['one', 'two', 'three'].map((word) => `${word} 고양이 ${'filler text '.repeat(70)}`.slice(0, 700)).join('\n\n');

function record(id: string, content: string, metadata: Record<string, unknown> = {}, scope: MemoryRecord['scope'] = { userId: 'owner' }, updatedAt = NOW): MemoryRecord {
  return { id, type: MemoryType.LONG_TERM, scope, content, metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT', ...metadata }, createdAt: updatedAt, updatedAt };
}

function setup(records: MemoryRecord[], batch = 2) {
  const provider = new Provider();
  const vectors = new Store();
  const scorer = new SemanticRecallScorer({ selector: { select: async () => provider }, vectors }, { collectionFor: durableMemoryCollectionFor, multiVector: true });
  let current = records;
  // a deliberately filter-free read: the job's own in-code liveness checks are what is tested
  const memories = { findDurableCandidates: async () => current };
  const job = new MemoryVectorBackfill({ scorer, memories: () => memories, clock: () => NOW }, { batch, activeDelayMs: 5, idleDelayMs: 50, retryDelayMs: 20, startDelayMs: 1 });
  return { job, provider, vectors, set: (next: MemoryRecord[]) => { current = next; } };
}

describe('liveDurableMemories', () => {
  it('keeps live owner-scoped memories and drops archived, superseded, expired, channel and unowned ones', async () => {
    const records = [
      record('live', 'a'),
      record('archived', 'b', { archivedAt: NOW }),
      record('superseded', 'c', { supersededBy: 'x' }),
      record('expired', 'd', { expiresAt: '2026-01-01T00:00:00.000Z' }),
      record('channel', 'e', {}, { userId: 'owner', channelId: 'c' }),
      record('unowned', 'f', {}, {}),
    ];
    const live = await liveDurableMemories({ findDurableCandidates: async () => records }, NOW);
    expect(live.candidates.map((c) => c.id)).toEqual(['live']);
    expect(live.truncated).toBe(false);
  });
});

describe('MemoryVectorBackfill (ADR-0124 section 5.4)', () => {
  it('embeds missing vector units in bounded batches per tick until complete, passages included', async () => {
    const { job, vectors, provider } = setup([record('short', '고양이 이야기'), record('long', LONG), record('other', '커피')]);
    const units = memoryVectorUnits('long', LONG, true).length + 2;
    const first = await job.runOnce();
    expect(first).toMatchObject({ state: 'working', embedded: 2, remaining: units - 2 });
    expect(provider.prompts.filter((p) => p !== 'index maintenance')).toHaveLength(2);
    const done = await job.runToCompletion();
    expect(done.state).toBe('idle');
    expect(vectors.ids()).toEqual([...memoryVectorUnits('long', LONG, true).map((u) => u.vectorId), 'other', 'short'].sort());
    // an idle pass embeds nothing more
    expect(await job.runOnce()).toMatchObject({ state: 'idle', embedded: 0, remaining: 0, deleted: 0 });
  });

  it('sweeps vectors of memories that are no longer live and surplus passage ordinals', async () => {
    const live = record('live', '고양이');
    const gone = [record('forgotten', '커피'), record('arch', '커피 2'), record('sup', '커피 3'), record('exp', '커피 4')];
    const { job, vectors, set } = setup([live, ...gone, record('long', LONG)], 100);
    await job.runToCompletion();
    expect(vectors.ids()).toContain('forgotten');
    // forget (deleted), archive, supersede and expire; the long memory loses a passage on edit
    set([live, record('arch', '커피 2', { archivedAt: NOW }), record('sup', '커피 3', { supersededBy: 'n' }), record('exp', '커피 4', { expiresAt: '2026-01-01T00:00:00.000Z' }), record('long', 'short now')]);
    const swept = await job.runToCompletion();
    expect(swept.deleted).toBeGreaterThanOrEqual(7);
    expect(vectors.ids()).toEqual(['live', 'long']);
  });

  it('closes the forget-during-turn race: a vector a turn wrote for an already forgotten memory is swept', async () => {
    const { job, vectors } = setup([record('live', '고양이')], 10);
    await job.runToCompletion();
    vectors.of(COLLECTION).set('ghost', { id: 'ghost', vector: [1, 0, 0.1], metadata: { contentHash: 'h', space: SPACE, dimensions: 3 } });
    expect((await job.runOnce()).deleted).toBe(1);
    expect(vectors.ids()).toEqual(['live']);
  });

  it('never sends credential-like content to the embedder', async () => {
    const { job, provider, vectors } = setup([record('secret', 'password=hunter2hunter2 sk-ABCDEFGHIJKLMNOPQRSTUVWX'), record('ok', '고양이')], 10);
    await job.runToCompletion();
    expect(provider.prompts.some((p) => p.includes('hunter2'))).toBe(false);
    expect(vectors.ids()).toEqual(['ok']);
  });

  it('stops the pass when the provider is unavailable and is not concurrent with itself', async () => {
    const down = setup([record('a', '고양이')]);
    down.job['deps'].scorer.maintain = async () => null;
    expect((await down.job.runOnce()).state).toBe('unavailable');

    const { job, provider } = setup([record('a', '고양이'), record('b', '커피'), record('c', 'x')], 1);
    const [one, two] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect([one.state, two.state].sort()).toEqual(['busy', 'working']);
    expect(provider.maxConcurrent).toBe(1);
  });

  it('start() runs ticks in the background and stop() waits for the one in flight', async () => {
    vi.useFakeTimers();
    try {
      const { job, vectors } = setup([record('a', '고양이'), record('b', '커피')], 1);
      job.start();
      job.start();
      await vi.advanceTimersByTimeAsync(2_000);
      await job.stop();
      expect(vectors.ids()).toEqual(['a', 'b']);
      const seen = vectors.ids().length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(vectors.ids()).toHaveLength(seen);
    } finally {
      vi.useRealTimers();
    }
  });
});
