import { describe, expect, it } from 'vitest';
import { Capability, IntentType, RiskLevel, TaskStatus, createDurableMemory, createRetrievedMemory, MemoryType, createMemoryRetrievalRequest } from '../../domain';
import type { MemoryRecord, Task } from '../../domain';
import type { AiProvider, AiRequest, ProviderSelector, VectorProvider, VectorQueryResult, VectorRecord, DurableMemoryByIdsQuery, DurableMemoryQuery, MemoryRepository } from '../../ports';
import { ContextBuilder, RECALL_EXCERPT_VARIANT } from '../context-builder';
import type { MemoryManager } from '../memory-manager';
import { DefaultMemoryRetriever, type MemoryRetriever } from '../memory-retriever';
import { cosineSimilarity, formatEmbeddingEnvelope } from './embedding-envelope';
import { memoryPassageStartOffset, memoryVectorUnits } from './memory-passages';
import { renderRecallContent } from './recall-excerpt';
import { durableMemoryCollectionFor, SemanticRecallScorer, type SemanticRecallScoring, type SemanticRecallSession } from './semantic-recall-scorer';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const SPACE = 'fake-embed/aaaaaaaaaaaa/p12345678';

/** Three ~700-code-point paragraphs: a multi-passage memory. The emoji sits at code point 399 of the 2nd and 3rd paragraph. */
const paragraph = (marker: string): string => `${marker} ${'가'.repeat(390)}😀${'나'.repeat(190)}`;
const LONG = [paragraph('고양이 이야기'), paragraph('커피 이야기'), paragraph('회의 이야기')].join('\n\n');
const SHORT = '우리 집 고양이 이름은 나비야';
const MID = `${'중간 길이 메모 '.repeat(60)}끝`; // 400 < length < 1,200, a single unit

function conceptVector(text: string): number[] {
  return [/고양이|cat/u.test(text) ? 1 : 0, /커피|coffee/u.test(text) ? 1 : 0, /회의|meeting/u.test(text) ? 1 : 0, 0.1];
}

describe('renderRecallContent (pure)', () => {
  it('V0 is the head, 400 code units then an ellipsis, exactly the former truncate', () => {
    const former = (text: string): string => (text.length > 400 ? `${text.slice(0, 400)}…` : text);
    for (const text of [SHORT, MID, LONG, 'x'.repeat(400), 'x'.repeat(401), `${'가'.repeat(399)}😀tail`]) {
      expect(renderRecallContent(text, undefined, 1, 'V0')).toBe(former(text));
      expect(renderRecallContent(text, 1, 1, 'V0')).toBe(former(text));
    }
  });

  it('V1 starts at the matched passage with a leading ellipsis and a trailing one when cut', () => {
    const start = memoryPassageStartOffset(LONG, 1) as number;
    expect(start).toBeGreaterThan(0);
    const out = renderRecallContent(LONG, 1, 5, 'V1');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(1, 8)).toBe(LONG.slice(start, start + 7));
    expect([...out.slice(1, -1)]).toHaveLength(400);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it('V1 on the first passage has no leading ellipsis, and a short tail has no trailing one', () => {
    const first = renderRecallContent(LONG, 0, 5, 'V1');
    expect(first.startsWith('…')).toBe(false);
    expect(first.endsWith('…')).toBe(true);
    const last = renderRecallContent(LONG, 2, 5, 'V1');
    expect(last.startsWith('…')).toBe(true);
    const tail = LONG.slice(memoryPassageStartOffset(LONG, 2) as number);
    expect(last.slice(1)).toBe([...tail].length > 400 ? `${[...tail].slice(0, 400).join('')}…` : tail);
  });

  it('never splits a surrogate pair at the cut, with Hangul and emoji', () => {
    const emoji = `${'가'.repeat(399)}😀${'나'.repeat(300)}\n\n${'다'.repeat(300)}`;
    for (const variant of ['V1', 'V2'] as const) {
      for (const ordinal of [0, 1]) for (const rank of [1, 4]) expect(renderRecallContent(emoji, ordinal, rank, variant)).not.toMatch(LONE_SURROGATE);
    }
    const out = renderRecallContent(emoji, 0, 5, 'V1');
    expect([...out.slice(0, -1)]).toHaveLength(400);
    expect(out).toContain('😀');
  });

  it('V2 gives ranks 1-3 up to 1,200 code points and the rest 400', () => {
    const bare = (text: string): string[] => [...text.replace(/…/g, '')];
    for (const rank of [1, 2, 3]) {
      const top = renderRecallContent(LONG, 0, rank, 'V2');
      expect(bare(top)).toHaveLength(1_200);
      expect(top.endsWith('…')).toBe(true);
      expect(top).not.toMatch(LONE_SURROGATE);
    }
    for (const rank of [4, 10]) expect(bare(renderRecallContent(LONG, 0, rank, 'V2'))).toHaveLength(400);
    // the tail of the memory fits in 1,200: no trailing ellipsis
    const tail = LONG.slice(memoryPassageStartOffset(LONG, 1) as number);
    expect(renderRecallContent(LONG, 1, 1, 'V2')).toBe(`…${tail}`);
  });

  it('falls back to V0 for a single-unit memory, an unknown ordinal or no ordinal', () => {
    for (const variant of ['V1', 'V2'] as const) {
      expect(renderRecallContent(MID, 0, 1, variant)).toBe(renderRecallContent(MID, undefined, 1, 'V0'));
      expect(renderRecallContent(LONG, 99, 1, variant)).toBe(renderRecallContent(LONG, undefined, 1, 'V0'));
      expect(renderRecallContent(LONG, undefined, 1, variant)).toBe(renderRecallContent(LONG, undefined, 1, 'V0'));
      expect(renderRecallContent(SHORT, 1, 1, variant)).toBe(SHORT);
    }
  });
});

// ---------------------------------------------------------------- the context builder

const task: Task = {
  id: 't1',
  title: 't',
  description: 'hello',
  status: TaskStatus.PENDING,
  intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'hello' },
  riskLevel: RiskLevel.LOW,
  context: { platform: 'discord', channelId: 'c', userId: 'u', direct: true },
  actorId: 'A1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const memoryManager = { recentShortTerm: async () => [], projectMemory: async () => undefined } as unknown as MemoryManager;
const retrieved = (id: string, content: string, matchedPassageOrdinal?: number) =>
  createRetrievedMemory({
    memory: createDurableMemory({ id, content, kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT', scope: { actorId: 'A1' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', metadata: { sourceRecordId: `s-${id}` } }),
    relevanceScore: 0.9,
    retrievalReason: 'test',
    ...(matchedPassageOrdinal === undefined ? {} : { matchedPassageOrdinal }),
  });
const retrieverOf = (...entries: ReturnType<typeof retrieved>[]): MemoryRetriever => ({ retrieve: async () => entries });
const delivered = async (builder: ContextBuilder): Promise<string[]> => ((await builder.build(task)).durableRecall ?? []).map((entry) => entry.content);

describe('ContextBuilder recall excerpts', () => {
  it('production variant is V1: a multi-passage memory shows its matched passage, a memory without an ordinal its head', async () => {
    expect(RECALL_EXCERPT_VARIANT).toBe('V1');
    const out = await delivered(new ContextBuilder(memoryManager, {}, retrieverOf(retrieved('c', LONG, 1), retrieved('a', SHORT), retrieved('d', `${LONG}z`))));
    expect(out).toContain(renderRecallContent(LONG, 1, 1, 'V1'));
    expect(out).toContain(SHORT);
    expect(out).toContain(renderRecallContent(`${LONG}z`, undefined, 2, 'V0'));
  });

  it('a builder given V0 still delivers the former head cut, matched ordinal or not', async () => {
    const former = (text: string): string => (text.length > 400 ? `${text.slice(0, 400)}…` : text);
    const entries = [retrieved('a', SHORT), retrieved('b', MID, undefined), retrieved('c', LONG, 1), retrieved('d', `${'x'.repeat(401)}`)];
    const out = await delivered(new ContextBuilder(memoryManager, {}, retrieverOf(...entries), undefined, 'V0'));
    expect(out.sort()).toEqual([SHORT, MID, LONG, 'x'.repeat(401)].map(former).sort());
  });

  it('a builder given V1 delivers the matched passage; V2 gives the top ranks a full passage', async () => {
    const entries = [retrieved('c', LONG, 1)];
    const v1 = await delivered(new ContextBuilder(memoryManager, {}, retrieverOf(...entries), undefined, 'V1'));
    expect(v1[0]).toBe(renderRecallContent(LONG, 1, 1, 'V1'));
    expect(v1[0]).toContain('커피 이야기');
    const v2 = await delivered(new ContextBuilder(memoryManager, {}, retrieverOf(...entries), undefined, 'V2'));
    expect(v2[0]).toBe(renderRecallContent(LONG, 1, 1, 'V2'));
    expect(v2[0]?.length).toBeGreaterThan(v1[0]?.length as number);
  });
});

// ---------------------------------------------------------------- plumbing: scorer session and retriever

class FakeProvider implements AiProvider {
  readonly id = 'fake';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  async isAvailable(): Promise<boolean> { return true; }
  async execute(request: AiRequest) { return { text: formatEmbeddingEnvelope(conceptVector(request.prompt), SPACE) }; }
}
class Store implements VectorProvider {
  readonly collections = new Map<string, Map<string, VectorRecord>>();
  async init(): Promise<void> {}
  private of(name: string): Map<string, VectorRecord> {
    let found = this.collections.get(name);
    if (found === undefined) this.collections.set(name, (found = new Map()));
    return found;
  }
  async upsert(collection: string, records: VectorRecord[]): Promise<void> { for (const record of records) this.of(collection).set(record.id, record); }
  async query(collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    return [...this.of(collection).values()]
      .filter((record) => record.vector.length === vector.length)
      .map((record) => ({ id: record.id, score: cosineSimilarity(vector, record.vector), ...(record.metadata ? { metadata: record.metadata } : {}) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async delete(collection: string, ids: string[]): Promise<void> { for (const id of ids) this.of(collection).delete(id); }
}
const selector: ProviderSelector = { select: async () => new FakeProvider() };
const newScorer = (vectors = new Store()) => new SemanticRecallScorer({ selector, vectors }, { collectionFor: durableMemoryCollectionFor, multiVector: true, maxNewEmbeddingsPerTurn: 20 });

describe('matched passage ordinal plumbing', () => {
  it('the session reports the argmax passage of a multi-passage memory, none for a single-unit memory, on a cold and a warm store', async () => {
    const vectors = new Store();
    const scorer = newScorer(vectors);
    const candidates = [{ id: 'long', content: LONG }, { id: 'short', content: SHORT }, { id: 'mid', content: MID }];
    for (const pass of ['cold', 'warm']) {
      const session = await scorer.openSession('커피 한 잔');
      expect(session, pass).not.toBeNull();
      const scores = await (session as SemanticRecallSession).score(candidates);
      expect(scores?.has('long')).toBe(true);
      const ordinals = (session as SemanticRecallSession).matchedPassageOrdinals?.();
      expect(ordinals?.get('long'), pass).toBe(1);
      expect(ordinals?.has('short'), pass).toBe(false);
      expect(ordinals?.has('mid'), pass).toBe(false);
      const other = await scorer.openSession('회의');
      await (other as SemanticRecallSession).score(candidates);
      expect((other as SemanticRecallSession).matchedPassageOrdinals?.().get('long'), pass).toBe(2);
    }
  });

  it('the argmax uses raw cosines: with all-negative cosines (clamped to 0) the least negative passage wins; the score stays the clamped max', async () => {
    const negative = (text: string): number[] => [/아래/u.test(text) ? -0.8 : /위/u.test(text) ? -0.2 : 0, 1 - 0.99 * 0, 0];
    const query = [1, 0, 0];
    const content = [paragraph('아래 이야기'), paragraph('위 이야기')].join('\n\n');
    expect(memoryVectorUnits('m', content, true).length).toBe(2);
    const provider: AiProvider = { id: 'neg', capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }], isAvailable: async () => true, execute: async (request: AiRequest) => ({ text: formatEmbeddingEnvelope(request.prompt.includes('QUERY') ? query : negative(request.prompt), SPACE) }) } as AiProvider;
    const scorer = new SemanticRecallScorer({ selector: { select: async () => provider }, vectors: new Store() }, { collectionFor: durableMemoryCollectionFor, multiVector: true, maxNewEmbeddingsPerTurn: 20 });
    const session = (await scorer.openSession('QUERY')) as SemanticRecallSession;
    const scores = await session.score([{ id: 'm', content }]);
    expect(scores?.get('m')).toBe(0);
    expect(session.matchedPassageOrdinals?.().get('m')).toBe(1);
  });

  it('equal cosines go to the lowest ordinal, with a partially cached store and with a warm one alike', async () => {
    const flat = (text: string): number[] => [1, 0, text.length > 0 ? 0 : 0];
    const content = [paragraph('가 이야기'), paragraph('나 이야기'), paragraph('다 이야기')].join('\n\n');
    const provider: AiProvider = { id: 'flat', capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }], isAvailable: async () => true, execute: async (request: AiRequest) => ({ text: formatEmbeddingEnvelope(flat(request.prompt), SPACE) }) } as AiProvider;
    const results: Array<number | undefined> = [];
    for (const maxNew of [1, 2, 20]) {
      const vectors = new Store();
      const scorer = new SemanticRecallScorer({ selector: { select: async () => provider }, vectors }, { collectionFor: durableMemoryCollectionFor, multiVector: true, maxNewEmbeddingsPerTurn: maxNew });
      for (const turn of [1, 2, 3]) {
        const session = (await scorer.openSession('q')) as SemanticRecallSession;
        await session.score([{ id: 'm', content }]);
        results.push(session.matchedPassageOrdinals?.().get('m'));
        void turn;
      }
    }
    expect(new Set(results)).toEqual(new Set([0]));
  });

  it('score() keeps returning the same plain score map', async () => {
    const scores = await newScorer().score('커피', [{ id: 'long', content: LONG }]);
    expect(scores).toBeInstanceOf(Map);
    expect(scores?.get('long')).toBeGreaterThan(0.5);
  });

  const NOW = '2026-11-06T00:00:00.000Z';
  const rec = (id: string, content: string): MemoryRecord => ({ id, type: MemoryType.LONG_TERM, scope: { userId: 'owner' }, content, metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT' }, createdAt: NOW, updatedAt: NOW });
  const repo = (records: MemoryRecord[]): MemoryRepository => ({
    async get(id) { return records.find((r) => r.id === id) ?? null; },
    async save(e) { return e; },
    async delete() {},
    async list() { return records; },
    async findByScope() { return records; },
    async findDurableCandidates(_q: DurableMemoryQuery) { return records; },
    async findDurableCandidatesByIds(q: DurableMemoryByIdsQuery) { return records.filter((r) => q.ids.includes(r.id)); },
    async findShortTermByUser() { return []; },
  });
  const ask = () => createMemoryRetrievalRequest({ query: 'q', capability: Capability.GENERAL_CHAT, scope: { actorId: 'owner' }, authorityFitness: ['USER_CLAIM_OR_INTENT'], maxResults: 10 });

  it('the retriever surfaces the ordinal on the semantic result of a multi-passage memory only', async () => {
    const retriever = new DefaultMemoryRetriever(repo([rec('long', LONG), rec('short', SHORT)]), { clock: () => NOW, semanticScorer: newScorer() });
    const retrieve = async (query: string) => (await retriever.retrieve({ ...ask(), query }));
    const results = await retrieve('커피 한 잔');
    expect(results.find((r) => r.memory.id === 'long')?.matchedPassageOrdinal).toBe(1);
    expect(results.find((r) => r.memory.id === 'short')?.matchedPassageOrdinal).toBeUndefined();
  });

  it('without an ordinal accessor, or without a scorer, results carry no ordinal', async () => {
    const plain: SemanticRecallScoring = {
      score: async () => { throw new Error('session path only'); },
      openSession: async () => ({ nearestMemoryIds: async () => [], score: async (c) => new Map(c.map((x) => [x.id, 0.5])) }),
    };
    const a = await new DefaultMemoryRetriever(repo([rec('long', LONG)]), { clock: () => NOW, semanticScorer: plain }).retrieve(ask());
    expect(a[0]?.matchedPassageOrdinal).toBeUndefined();
    const b = await new DefaultMemoryRetriever(repo([rec('long', LONG)]), { clock: () => NOW }).retrieve(ask());
    expect(b[0]?.matchedPassageOrdinal).toBeUndefined();
  });
});
