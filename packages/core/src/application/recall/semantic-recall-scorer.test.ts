import { describe, expect, it } from 'vitest';
import { AiFailureKind, Capability } from '../../domain';
import { AiProviderError, NoProviderAvailableError } from '../../errors';
import type {
  AiProvider,
  AiRequest,
  LogFields,
  Logger,
  ProviderSelector,
  VectorProvider,
  VectorQueryResult,
  VectorRecord,
} from '../../ports';
import { containsCredentialMaterial } from '../credential-guard';
import { cosineSimilarity, formatEmbeddingEnvelope, readEmbeddingRole } from './embedding-envelope';
import { DURABLE_MEMORY_VECTOR_COLLECTION, SemanticRecallScorer } from './semantic-recall-scorer';

const CLOCK = (): string => '2026-10-02T00:00:00.000Z';

/** Deterministic concept embedding: [pet, food, work, bias]. Lexically disjoint texts can share a concept. */
function conceptVector(text: string): number[] {
  return [
    /반려동물|고양이|강아지|pet|cat/u.test(text) ? 1 : 0,
    /커피|음식|라면|coffee|food/u.test(text) ? 1 : 0,
    /회의|프로젝트|보고서|meeting|report/u.test(text) ? 1 : 0,
    0.1,
  ];
}

class FakeEmbeddingProvider implements AiProvider {
  readonly id = 'fake-embedder';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  readonly requests: AiRequest[] = [];
  constructor(private readonly respond: (request: AiRequest) => Promise<string> | string = (request) =>
    formatEmbeddingEnvelope(conceptVector(request.prompt), 'fake-space')) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async execute(request: AiRequest) {
    this.requests.push(request);
    return { text: await this.respond(request) };
  }
}

class MemoryVectorStore implements VectorProvider {
  readonly records = new Map<string, VectorRecord>();
  upserts = 0;
  failQuery = false;
  async init(): Promise<void> {}
  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    expect(collection).toBe(DURABLE_MEMORY_VECTOR_COLLECTION);
    this.upserts += 1;
    for (const record of records) this.records.set(record.id, record);
  }
  async query(_collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    if (this.failQuery) throw new Error('store unavailable');
    return [...this.records.values()]
      .filter((record) => record.vector.length === vector.length)
      .map((record) => ({
        id: record.id,
        score: cosineSimilarity(vector, record.vector),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async delete(_collection: string, ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }
}

class RecordingLogger implements Logger {
  readonly lines: Array<{ message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void {
    this.lines.push({ message, ...(fields ? { fields } : {}) });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ message, ...(fields ? { fields } : {}) });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ message, ...(fields ? { fields } : {}) });
  }
}

function selectorFor(provider: AiProvider | Error): ProviderSelector & { calls: number } {
  const selector = {
    calls: 0,
    async select(capability: Capability): Promise<AiProvider> {
      selector.calls += 1;
      expect(capability).toBe(Capability.EMBEDDING);
      if (provider instanceof Error) throw provider;
      return provider;
    },
  };
  return selector;
}

function setup(
  provider: AiProvider | Error = new FakeEmbeddingProvider(),
  options: ConstructorParameters<typeof SemanticRecallScorer>[1] = {},
) {
  const vectors = new MemoryVectorStore();
  const logger = new RecordingLogger();
  const selector = selectorFor(provider);
  const scorer = new SemanticRecallScorer({ selector, vectors, logger, clock: CLOCK }, options);
  return { scorer, vectors, logger, selector };
}

const PET = { id: 'm-pet', content: '우리 집 고양이 이름은 나비야' };
const FOOD = { id: 'm-food', content: '아침에는 커피를 마셔' };
const WORK = { id: 'm-work', content: '매주 월요일 10시에 팀 회의가 있어' };
const QUERY = '반려동물 이름이 뭐였지?';

describe('SemanticRecallScorer (ADR-0098 D8)', () => {
  it('scores eligible candidates by cosine similarity and caches their vectors with content hashes', async () => {
    const provider = new FakeEmbeddingProvider();
    const { scorer, vectors } = setup(provider);

    const scores = await scorer.score(QUERY, [PET, FOOD, WORK]);

    expect(scores).not.toBeNull();
    expect(scores?.get('m-pet')).toBeGreaterThan(0.9);
    expect(scores?.get('m-food')).toBeLessThan(0.2);
    expect(scores?.get('m-work')).toBeLessThan(0.2);
    expect(provider.requests.map((request) => readEmbeddingRole(request.metadata))).toEqual([
      'query',
      'document',
      'document',
      'document',
    ]);
    expect(provider.requests.every((request) => request.capability === Capability.EMBEDDING)).toBe(true);
    expect(provider.requests.every((request) => (request.timeoutMs ?? 0) > 0)).toBe(true);
    expect(vectors.records.get('m-pet')?.metadata).toEqual({
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      space: 'fake-space',
      dimensions: 4,
    });
  });

  it('reuses cached vectors on the next turn and re-embeds only a changed record', async () => {
    const provider = new FakeEmbeddingProvider();
    const { scorer } = setup(provider);
    await scorer.score(QUERY, [PET, FOOD]);
    provider.requests.length = 0;

    const reused = await scorer.score(QUERY, [PET, FOOD]);
    expect(provider.requests).toHaveLength(1); // the query only
    expect(reused?.get('m-pet')).toBeGreaterThan(0.9);

    provider.requests.length = 0;
    const edited = { id: 'm-food', content: '요즘 강아지를 키워' };
    const rescored = await scorer.score(QUERY, [PET, edited]);
    expect(provider.requests.map((request) => request.prompt)).toEqual([QUERY, edited.content]);
    expect(rescored?.get('m-food')).toBeGreaterThan(0.9);
  });

  it('embeds at most maxNewEmbeddingsPerTurn documents per turn and leaves the rest unscored', async () => {
    const provider = new FakeEmbeddingProvider();
    const { scorer } = setup(provider, { maxNewEmbeddingsPerTurn: 2 });
    const candidates = Array.from({ length: 5 }, (_unused, index) => ({ id: `m-${index}`, content: `메모 ${index}` }));

    const first = await scorer.score(QUERY, candidates);
    expect(provider.requests).toHaveLength(3);
    expect([...(first?.keys() ?? [])]).toEqual(['m-0', 'm-1']);

    const second = await scorer.score(QUERY, candidates);
    expect([...(second?.keys() ?? [])].sort()).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
  });

  it('never sends a credential-like candidate or query to the embedding provider', async () => {
    const secret = { id: 'm-secret', content: '내 계정 password=hunter2 고양이' };
    expect(containsCredentialMaterial(secret.content)).toBe(true);
    const provider = new FakeEmbeddingProvider();
    const { scorer, selector } = setup(provider);

    const scores = await scorer.score(QUERY, [secret, PET]);
    expect(scores?.has('m-secret')).toBe(false);
    expect(provider.requests.some((request) => request.prompt.includes('hunter2'))).toBe(false);

    provider.requests.length = 0;
    const callsBefore = selector.calls;
    expect(await scorer.score('password=hunter2 고양이', [PET])).toBeNull();
    expect(provider.requests).toHaveLength(0);
    expect(selector.calls).toBe(callsBefore);
  });

  it('never scores an id outside the offered candidates, even when the store holds a strong match', async () => {
    const { scorer, vectors } = setup();
    vectors.records.set('m-expired', {
      id: 'm-expired',
      vector: conceptVector('고양이'),
      metadata: { contentHash: 'x', space: 'fake-space', dimensions: 4 },
    });

    const scores = await scorer.score(QUERY, [FOOD]);
    expect([...(scores?.keys() ?? [])]).toEqual(['m-food']);
  });

  it.each([
    ['no EMBEDDING provider', new NoProviderAvailableError(Capability.EMBEDDING), 'NO_PROVIDER'],
    [
      'an unavailable provider',
      new FakeEmbeddingProvider(() => {
        throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'daemon down');
      }),
      'ERROR',
    ],
    ['a malformed envelope', new FakeEmbeddingProvider(() => '[0.1, 0.2]'), 'ERROR'],
    [
      'a document in another vector space',
      new FakeEmbeddingProvider((request) =>
        formatEmbeddingEnvelope(
          conceptVector(request.prompt),
          readEmbeddingRole(request.metadata) === 'query' ? 'space-a' : 'space-b',
        ),
      ),
      'ERROR',
    ],
  ] as const)('falls back (null) on %s and logs counts only', async (_label, provider, reason) => {
    const { scorer, logger, vectors } = setup(provider);
    expect(await scorer.score(QUERY, [PET, FOOD])).toBeNull();
    expect(vectors.upserts).toBe(0);
    const line = logger.lines.at(-1);
    expect(line?.fields?.reason).toBe(reason);
    expect(JSON.stringify(logger.lines)).not.toContain('고양이');
    expect(JSON.stringify(logger.lines)).not.toContain(QUERY);
  });

  it('falls back (null) when the vector store fails', async () => {
    const { scorer, vectors } = setup();
    vectors.failQuery = true;
    expect(await scorer.score(QUERY, [PET])).toBeNull();
  });

  it('falls back (null) when the turn budget elapses, and stops embedding afterwards', async () => {
    let release: (() => void) | undefined;
    const provider = new FakeEmbeddingProvider(
      (request) =>
        new Promise<string>((resolve) => {
          release = () => resolve(formatEmbeddingEnvelope(conceptVector(request.prompt), 'fake-space'));
        }),
    );
    const { scorer, logger, vectors } = setup(provider, { turnBudgetMs: 20 });

    expect(await scorer.score(QUERY, [PET, FOOD])).toBeNull();
    expect(logger.lines.at(-1)?.fields?.reason).toBe('TIMEOUT');

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.requests).toHaveLength(1);
    expect(vectors.upserts).toBe(0);
  });

  it('returns null without any provider call for no candidates or an empty query', async () => {
    const provider = new FakeEmbeddingProvider();
    const { scorer, selector } = setup(provider);
    expect(await scorer.score(QUERY, [])).toBeNull();
    expect(await scorer.score('   ', [PET])).toBeNull();
    expect(selector.calls).toBe(0);
  });

  it('rejects invalid bounds at construction', () => {
    const deps = { selector: selectorFor(new FakeEmbeddingProvider()), vectors: new MemoryVectorStore() };
    expect(() => new SemanticRecallScorer(deps, { maxNewEmbeddingsPerTurn: 0 })).toThrow(RangeError);
    expect(() => new SemanticRecallScorer(deps, { turnBudgetMs: 1.5 })).toThrow(RangeError);
  });
});
