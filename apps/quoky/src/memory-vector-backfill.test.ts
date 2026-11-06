import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  SemanticRecallScorer,
  cosineSimilarity,
  durableMemoryCollectionFor,
  formatEmbeddingEnvelope,
  memoryVectorUnits,
  MemoryType,
  RecallActivityGauge,
  type AiProvider,
  type AiRequest,
  type MemoryRecord,
  type VectorProvider,
  type VectorQueryResult,
  type VectorRecord,
} from '@quoky/core';
import { MemoryVectorBackfill, confirmLiveMemories, liveDurableMemories } from './memory-vector-backfill';

const SPACE = 'fake-embed/aaaaaaaaaaaa/v0.40.14/p12345678';
const SPACE_B = 'fake-embed/bbbbbbbbbbbb/v0.41.0/p12345678';
const COLLECTION = durableMemoryCollectionFor(SPACE);
const NOW = '2026-11-06T00:00:00.000Z';

const vectorOf = (text: string): number[] => [/고양이|cat/u.test(text) ? 1 : 0, /커피|coffee/u.test(text) ? 1 : 0, 0.1];

class Provider implements AiProvider {
  readonly id = 'fake';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  readonly prompts: string[] = [];
  down = false;
  space = SPACE;
  onPrompt: ((prompt: string) => void) | undefined;
  hang: ((prompt: string) => boolean) | undefined;
  concurrent = 0;
  maxConcurrent = 0;
  async isAvailable() { return !this.down; }
  async execute(request: AiRequest) {
    this.onPrompt?.(request.prompt);
    if (this.hang?.(request.prompt) === true) await new Promise<never>(() => undefined);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.concurrent -= 1;
    this.prompts.push(request.prompt);
    return { text: formatEmbeddingEnvelope(vectorOf(request.prompt), this.space) };
  }
}

class Store implements VectorProvider {
  readonly collections = new Map<string, Map<string, VectorRecord>>();
  of(name: string) { let found = this.collections.get(name); if (!found) this.collections.set(name, (found = new Map())); return found; }
  async init() {}
  beforeUpsert: (() => void) | undefined;
  async upsert(collection: string, records: VectorRecord[]) { this.beforeUpsert?.(); for (const record of records) this.of(collection).set(record.id, record); }
  onQuery: (() => void) | undefined;
  async query(collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    this.onQuery?.();
    return [...this.of(collection).values()].filter((r) => r.vector.length === vector.length).map((r) => ({ id: r.id, score: cosineSimilarity(vector, r.vector), ...(r.metadata ? { metadata: r.metadata } : {}) })).slice(0, topK);
  }
  async delete(collection: string, ids: string[]) { for (const id of ids) this.of(collection).delete(id); }
  ids() { return [...this.of(COLLECTION).keys()].sort(); }
}

const LONG = ['one', 'two', 'three'].map((word) => `${word} 고양이 ${'filler text '.repeat(70)}`.slice(0, 700)).join('\n\n');

function record(id: string, content: string, metadata: Record<string, unknown> = {}, scope: MemoryRecord['scope'] = { userId: 'owner' }, updatedAt = NOW): MemoryRecord {
  return { id, type: MemoryType.LONG_TERM, scope, content, metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT', ...metadata }, createdAt: updatedAt, updatedAt };
}

function setup(records: MemoryRecord[], batch = 2, extra: { activity?: RecallActivityGauge; scorerOptions?: ConstructorParameters<typeof SemanticRecallScorer>[1]; stopBoundMs?: number } = {}) {
  const provider = new Provider();
  const vectors = new Store();
  const scorer = new SemanticRecallScorer(
    { selector: { select: async () => { if (provider.down) throw new Error('provider down'); return provider; } }, vectors },
    { collectionFor: durableMemoryCollectionFor, multiVector: true, ...extra.scorerOptions },
  );
  let current = records;
  // deliberately filter-free reads: the job's own in-code liveness checks are what is tested
  const memories = {
    findDurableCandidates: async () => current,
    findDurableCandidatesByIds: async (query: { ids: string[] }) => current.filter((entry) => query.ids.includes(entry.id)),
  };
  const job = new MemoryVectorBackfill(
    { scorer, memories: () => memories, clock: () => NOW, ...(extra.activity === undefined ? {} : { activity: extra.activity }) },
    { batch, activeDelayMs: 5, idleDelayMs: 50, retryDelayMs: 20, startDelayMs: 1, ...(extra.stopBoundMs === undefined ? {} : { stopBoundMs: extra.stopBoundMs }) },
  );
  return { job, provider, vectors, scorer, memories, get: () => current, set: (next: MemoryRecord[]) => { current = next; } };
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
    vectors.of(COLLECTION).set('ghost', { id: 'ghost', vector: [1, 0, 0.1], metadata: { contentHash: 'h', space: SPACE, dimensions: 3 } });
    // before the first pass the space is unknown to the scorer: the probe finds it, the sweep then removes the ghost
    expect((await job.runToCompletion()).deleted).toBe(1);
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
    (down.job as unknown as { deps: { scorer: { maintain: () => Promise<null> } } }).deps.scorer.maintain = async () => null;
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

describe('stale snapshots (review round 2, P2-a)', () => {
  it('a memory saved while the pass runs keeps the vector a turn wrote for it: the live list is read after the store snapshot', async () => {
    const { job, vectors, provider, set, get } = setup([record('live', '고양이')], 10);
    const late = record('late', '커피');
    // the store snapshot is taken after the turn embedded the new memory, but the old order read the live list before it existed
    vectors.onQuery = () => {
      vectors.onQuery = undefined;
      set([...get(), late]);
      vectors.of(COLLECTION).set('late', { id: 'late', vector: vectorOf('커피'), metadata: { contentHash: 'h', space: SPACE, dimensions: 3 } });
    };
    const tick = await job.runOnce();
    expect(vectors.ids()).toContain('late');
    expect(tick.deleted).toBe(0);
    expect(provider.prompts.length).toBeGreaterThan(0);
  });

  it('a memory forgotten while its vector is being embedded gets no vector back, and the tick keeps going', async () => {
    const { job, vectors, provider, set, get } = setup([record('keep', '고양이'), record('gone', '커피')], 10);
    provider.onPrompt = (prompt) => { if (prompt === '커피') set(get().filter((entry) => entry.id !== 'gone')); };
    const tick = await job.runOnce();
    expect(vectors.ids()).toEqual(['keep']);
    expect(tick).toMatchObject({ state: 'working', embedded: 1 });
    // the next pass finds nothing left to do
    expect((await job.runOnce()).state).toBe('idle');
  });

  it('a vector whose memory is missing from the snapshot is deleted only when a fresh read still says it is not live', async () => {
    const provider = new Provider();
    const vectors = new Store();
    const scorer = new SemanticRecallScorer({ selector: { select: async () => provider }, vectors }, { collectionFor: durableMemoryCollectionFor, multiVector: true });
    const meta = { contentHash: 'h', space: SPACE, dimensions: 3 };
    vectors.of(COLLECTION).set('x', { id: 'x', vector: vectorOf('x'), metadata: meta });
    vectors.of(COLLECTION).set('y', { id: 'y', vector: vectorOf('y'), metadata: meta });
    const asked: string[][] = [];
    await scorer.maintain(async () => ({ candidates: [], truncated: false }), { confirmLive: async (ids) => { asked.push([...ids]); return new Set(['x']); } });
    expect(asked).toEqual([['x', 'y']]);
    expect(vectors.ids()).toEqual(['x']);
  });

  it('confirmLiveMemories applies the same liveness rules to a fresh by-id read', async () => {
    const records = [record('live', 'a'), record('arch', 'b', { archivedAt: NOW }), record('exp', 'c', { expiresAt: '2026-01-01T00:00:00.000Z' })];
    const memories = { findDurableCandidates: async () => records, findDurableCandidatesByIds: async (q: { ids: string[] }) => records.filter((r) => q.ids.includes(r.id)) };
    expect([...(await confirmLiveMemories(memories, ['live', 'arch', 'exp', 'ghost'], NOW))]).toEqual(['live']);
    expect([...(await confirmLiveMemories({ findDurableCandidates: async () => records }, ['live', 'arch'], NOW))]).toEqual(['live']);
  });
});

describe('shutdown (P2-b)', () => {
  it('stop() returns promptly while an embedding hangs, and the pass ends without writing', async () => {
    const { job, provider, vectors } = setup([record('a', '고양이'), record('b', '커피')], 10, { stopBoundMs: 300 });
    provider.hang = (prompt) => prompt === '커피';
    job.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const started = Date.now();
    await job.stop();
    expect(Date.now() - started).toBeLessThan(400);
    expect(vectors.ids()).toEqual([]);
  });

  it('stop() is bounded even when the tick in flight never settles', async () => {
    const { job } = setup([record('a', '고양이')], 10, { stopBoundMs: 80 });
    (job as unknown as { deps: { scorer: { maintain: () => Promise<never> } } }).deps.scorer.maintain = () => new Promise<never>(() => undefined);
    job.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await job.stop();
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe('yielding to recall turns (P2-c)', () => {
  it('the scorer marks a recall turn and the gauge reports it busy until it ends plus the grace', async () => {
    let nowMs = 1_000;
    const gauge = new RecallActivityGauge(() => nowMs);
    const provider = new Provider();
    const scorer = new SemanticRecallScorer({ selector: { select: async () => provider }, vectors: new Store(), activity: gauge }, { collectionFor: durableMemoryCollectionFor });
    const session = await scorer.openSession('고양이');
    expect(gauge.isBusy(2_000)).toBe(true);
    await session?.score([{ id: 'm', content: '고양이' }]);
    nowMs += 1_000;
    expect(gauge.isBusy(2_000)).toBe(true);
    nowMs += 1_500;
    expect(gauge.isBusy(2_000)).toBe(false);
    // a failed open ends the mark as well
    const failing = new SemanticRecallScorer({ selector: { select: async () => { throw new Error('none'); } }, vectors: new Store(), activity: gauge }, { collectionFor: durableMemoryCollectionFor });
    await failing.openSession('x');
    nowMs += 3_000;
    expect(gauge.isBusy(2_000)).toBe(false);
  });

  it('a tick does nothing while a turn is active or just ended, and ends its batch when a turn starts mid-way', async () => {
    let nowMs = 10_000;
    const gauge = new RecallActivityGauge(() => nowMs);
    const { job, provider, vectors } = setup([record('a', '고양이'), record('b', '커피'), record('c', 'x')], 10, { activity: gauge });
    const token = gauge.begin(3_000);
    expect((await job.runOnce()).state).toBe('paused');
    expect(provider.prompts).toEqual([]);
    gauge.end(token);
    nowMs += 1_000;
    expect((await job.runOnce()).state).toBe('paused');
    nowMs += 1_500;
    // a turn begins while the first embedding runs: the batch stops after it
    provider.onPrompt = (prompt) => { if (prompt === '고양이') gauge.begin(3_000); };
    const partial = await job.runOnce();
    expect(partial.embedded).toBe(1);
    expect(vectors.ids()).toEqual(['a']);
  });
});

describe('store cap (P2-d)', () => {
  it('embeds nothing when the wanted vectors exceed the cap, warns once and reports idle', async () => {
    const warnings: string[] = [];
    const provider = new Provider();
    const vectors = new Store();
    const scorer = new SemanticRecallScorer(
      { selector: { select: async () => provider }, vectors, logger: { info: () => undefined, warn: (m) => { warnings.push(m); }, error: () => undefined } },
      { collectionFor: durableMemoryCollectionFor, maxIndexed: 2 },
    );
    const records = [record('a', '고양이'), record('b', '커피'), record('c', 'x')];
    const memories = { findDurableCandidates: async () => records };
    const job = new MemoryVectorBackfill({ scorer, memories: () => memories, clock: () => NOW }, { batch: 8 });
    const first = await job.runOnce();
    expect(first).toMatchObject({ state: 'idle', embedded: 0 });
    await job.runOnce();
    expect(vectors.ids()).toEqual([]);
    expect(provider.prompts.filter((p) => p !== 'index maintenance')).toEqual([]);
    expect(warnings.filter((m) => m.includes('over the store cap'))).toHaveLength(1);
  });
});

describe('idle ticks (P3)', () => {
  it('skips the full pass while the memory fingerprint is unchanged, and runs it again after a change', async () => {
    const { job, provider, set, get } = setup([record('a', '고양이')], 10);
    await job.runToCompletion();
    const probes = () => provider.prompts.filter((p) => p === 'index maintenance').length;
    expect(probes()).toBe(1);
    const embeds = provider.prompts.length;
    expect((await job.runOnce()).state).toBe('idle'); // records the fingerprint
    expect((await job.runOnce()).state).toBe('idle'); // skipped
    expect(provider.prompts.length).toBe(embeds);
    set([...get(), record('b', '커피', {}, { userId: 'owner' }, '2026-11-06T01:00:00.000Z')]);
    expect((await job.runOnce()).state).toBe('working');
    expect(provider.prompts.length).toBeGreaterThan(embeds);
  });

  it('reuses the space inside a working chain; the first pass after idle time re-reads it', async () => {
    const { job, provider, set, get } = setup([record('a', '고양이')], 1);
    await job.runToCompletion();
    set([...get(), record('b', '커피', {}, { userId: 'owner' }, '2026-11-06T01:00:00.000Z'), record('c', 'x', {}, { userId: 'owner' }, '2026-11-06T02:00:00.000Z')]);
    await job.runToCompletion();
    // chain 1: one probe; chain 2: one refresh probe at its start, none on the following working ticks
    expect(provider.prompts.filter((p) => p === 'index maintenance')).toHaveLength(2);
  });
});

describe('review round 3', () => {
  it('a forget landing between the pre-write check and the upsert leaves no vector after the call returns', async () => {
    const { job, vectors, set, get } = setup([record('keep', '고양이'), record('gone', '커피')], 10);
    vectors.beforeUpsert = () => set(get().filter((entry) => entry.id !== 'gone'));
    const tick = await job.runOnce();
    expect(vectors.ids()).toEqual(['keep']);
    expect(tick.state).toBe('working');
    expect(tick.deleted).toBe(1);
  });

  it('yields before selecting the provider, and before every model step', async () => {
    const provider = new Provider();
    let selects = 0;
    const scorer = new SemanticRecallScorer({ selector: { select: async () => { selects += 1; return provider; } }, vectors: new Store() }, { collectionFor: durableMemoryCollectionFor });
    const live = async () => ({ candidates: [{ id: 'a', content: '고양이' }], truncated: false });
    const confirmLive = async (ids: readonly string[]) => new Set(ids);
    expect(await scorer.maintain(live, { confirmLive, shouldYield: () => true })).toMatchObject({ yielded: true, embedded: 0 });
    expect(selects).toBe(0);
    // first check passes, the one before the provider selection says yield
    let calls = 0;
    expect(await scorer.maintain(live, { confirmLive, shouldYield: () => ++calls > 1 })).toMatchObject({ yielded: true, embedded: 0 });
    expect(selects).toBe(0);
    expect(provider.prompts).toEqual([]);
  });

  it('yields when a recall turn starts while the provider selection is awaited (review round 4)', async () => {
    const provider = new Provider();
    let turnActive = false;
    const scorer = new SemanticRecallScorer({ selector: { select: async () => { turnActive = true; return provider; } }, vectors: new Store() }, { collectionFor: durableMemoryCollectionFor });
    const live = async () => ({ candidates: [{ id: 'a', content: '고양이' }], truncated: false });
    const confirmLive = async (ids: readonly string[]) => new Set(ids);
    expect(await scorer.maintain(live, { confirmLive, shouldYield: () => turnActive })).toMatchObject({ yielded: true, embedded: 0 });
    expect(provider.prompts).toEqual([]);
  });

  it('with the space known the sweep runs while the provider is down', async () => {
    const { job, provider, vectors, set, get } = setup([record('a', '고양이'), record('b', '커피')], 10);
    await job.runToCompletion();
    provider.down = true;
    set(get().filter((entry) => entry.id !== 'b'));
    const tick = await job.runOnce();
    expect(tick.deleted).toBe(1);
    expect(vectors.ids()).toEqual(['a']);
  });

  it('a re-pulled model or upgraded runtime is noticed on the next full pass: the cached space is dropped and the new space is filled', async () => {
    const { job, provider, vectors, set, get } = setup([record('a', '고양이')], 10);
    await job.runToCompletion();
    expect(vectors.ids()).toEqual(['a']);
    provider.space = SPACE_B;
    set([...get(), record('b', '커피', {}, { userId: 'owner' }, '2026-11-06T01:00:00.000Z')]);
    await job.runToCompletion();
    const next = vectors.of(durableMemoryCollectionFor(SPACE_B));
    expect([...next.keys()].sort()).toEqual(['a', 'b']);
    expect([...next.values()].every((r) => r.metadata?.space === SPACE_B)).toBe(true);
  });

  it('the abort listener is removed when the pass ends', async () => {
    const provider = new Provider();
    const scorer = new SemanticRecallScorer({ selector: { select: async () => provider }, vectors: new Store() }, { collectionFor: durableMemoryCollectionFor });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await scorer.maintain(async () => ({ candidates: [], truncated: false }), { confirmLive: async () => new Set(), signal: controller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
