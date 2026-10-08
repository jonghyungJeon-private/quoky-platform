import { describe, expect, it } from 'vitest';
import {
  Capability,
  createMemoryRetrievalRequest,
  MemoryType,
  type MemoryRecord,
} from '../domain';
import { NoProviderAvailableError } from '../errors';
import type {
  AiProvider,
  AiRequest,
  DurableMemoryQuery,
  MemoryRepository,
  ProviderSelector,
  VectorProvider,
  VectorQueryResult,
  VectorRecord,
} from '../ports';
import { DefaultMemoryRetriever } from './memory-retriever';
import { cosineSimilarity, formatEmbeddingEnvelope } from './recall/embedding-envelope';
import { SemanticRecallScorer } from './recall/semantic-recall-scorer';
import type { SemanticRecallCandidate, SemanticRecallScoring } from './recall/semantic-recall-scorer';

const CURRENT_TIME = '2026-08-24T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1_000;

function record(
  id: string,
  content: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    type: MemoryType.LONG_TERM,
    scope: { sessionId: 'session-1', userId: 'actor-1' },
    content,
    metadata: {
      kind: 'SEMANTIC',
      provenance: 'USER_PROVIDED',
      authorityLevel: 'USER_CLAIM_OR_INTENT',
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function repository(records: MemoryRecord[]): MemoryRepository {
  return {
    async get(id) {
      return records.find((candidate) => candidate.id === id) ?? null;
    },
    async save(entity) {
      return entity;
    },
    async delete() {},
    async list() {
      return records;
    },
    async findByScope() {
      return records;
    },
    async findDurableCandidates(query: DurableMemoryQuery) {
      return records
        .filter((candidate) => !query.excludeIds?.includes(candidate.id))
        .slice(0, query.limit);
    },
    async findShortTermByUser() {
      return [];
    },
  };
}

function request(maxResults = 10, scope: { actorId?: string; sessionId?: string; projectId?: string } = { actorId: 'actor-1' }) {
  return createMemoryRetrievalRequest({
    query: 'blue sky preference',
    capability: Capability.GENERAL_CHAT,
    scope,
    authorityFitness: ['USER_CLAIM_OR_INTENT'],
    maxResults,
  });
}

function retriever(records: MemoryRecord[], options = {}) {
  return new DefaultMemoryRetriever(repository(records), {
    clock: () => CURRENT_TIME,
    ...options,
  });
}

describe('DefaultMemoryRetriever', () => {
  it('drops malformed persisted candidates fail-closed without authority escalation', async () => {
    const valid = record('valid', 'blue sky preference');
    const malformed = record('malformed', 'blue sky preference malformed', {
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'ASSISTANT_NON_AUTHORITATIVE',
      },
    });

    const results = await retriever([malformed, valid]).retrieve(request());

    expect(results.map(({ memory }) => memory.id)).toEqual(['valid']);
    expect(results[0]!.memory.authorityLevel).toBe('USER_CLAIM_OR_INTENT');
    expect(results).not.toContainEqual(
      expect.objectContaining({
        memory: expect.objectContaining({ authorityLevel: 'ASSISTANT_NON_AUTHORITATIVE' }),
      }),
    );
  });

  it('excludes authority-unfit candidates without weakening scope or retrying broadly', async () => {
    const queries: DurableMemoryQuery[] = [];
    const candidate = record('unfit', 'blue sky preference');
    const scopedRepository = repository([candidate]);
    scopedRepository.findDurableCandidates = async (query) => {
      queries.push(query);
      return [candidate];
    };
    const memoryRetriever = new DefaultMemoryRetriever(scopedRepository, {
      clock: () => CURRENT_TIME,
    });
    const constrainedRequest = createMemoryRetrievalRequest({
      query: 'blue sky preference',
      capability: Capability.GENERAL_CHAT,
      scope: { actorId: 'actor-1', projectId: 'project-1' },
      authorityFitness: ['ASSISTANT_NON_AUTHORITATIVE'],
      maxResults: 10,
    });

    await expect(memoryRetriever.retrieve(constrainedRequest)).resolves.toEqual([]);
    expect(queries).toEqual([
      expect.objectContaining({
        scope: { projectId: 'project-1', userId: 'actor-1' },
        limit: 50,
      }),
    ]);
  });

  it('ranks stronger lexical overlap ahead of weaker candidates', async () => {
    const results = await retriever([
      record('weak', 'blue ocean'),
      record('strong', 'My blue sky preference'),
    ]).retrieve(request());

    expect(results.map(({ memory }) => memory.id)).toEqual(['strong', 'weak']);
    expect(results[0]!.relevanceScore).toBeGreaterThan(results[1]!.relevanceScore);
  });

  it('uses configurable recency decay to rank equally relevant content', async () => {
    const results = await retriever(
      [
        record('old', 'blue sky alpha', {
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-25T00:00:00.000Z',
        }),
        record('new', 'blue sky beta', { updatedAt: CURRENT_TIME }),
      ],
      { recencyWeight: 0.5, recencyHalfLifeMs: DAY_MS },
    ).retrieve(request());

    expect(results.map(({ memory }) => memory.id)).toEqual(['new', 'old']);
  });

  it('excludes expired candidates even if a repository returns them', async () => {
    const expired = record('expired', 'blue sky preference', {
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        expiresAt: '2026-08-23T23:59:59.000Z',
      },
    });

    await expect(retriever([expired]).retrieve(request())).resolves.toEqual([]);
  });

  it('excludes superseded candidates even if a repository returns them', async () => {
    const superseded = record('old', 'blue sky preference', {
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        supersededBy: 'replacement',
      },
    });

    await expect(retriever([superseded]).retrieve(request())).resolves.toEqual([]);
  });

  it('deduplicates normalized content after ranking', async () => {
    const results = await retriever([
      record('older', '  BLUE   sky preference '),
      record('newer', 'blue sky preference', { updatedAt: CURRENT_TIME }),
    ]).retrieve(request());

    expect(results.map(({ memory }) => memory.id)).toEqual(['newer']);
  });

  it('returns an empty result when the repository has no candidates', async () => {
    await expect(retriever([]).retrieve(request())).resolves.toEqual([]);
  });

  it('recalls by actor across sessions and projects and rejects other actors and non-durable scopes', async () => {
    const results = await retriever([
      record('other-session', 'blue sky preference', { scope: { sessionId: 'session-2', userId: 'actor-1' } }),
      record('with-project', 'blue sky preference extra', {
        scope: { sessionId: 'session-1', projectId: 'project-elsewhere', userId: 'actor-1' },
      }),
      record('other-actor', 'blue sky preference', { scope: { sessionId: 'session-1', userId: 'actor-2' } }),
      record('no-actor', 'blue sky preference', { scope: { sessionId: 'session-1' } }),
      record('with-channel', 'blue sky preference', { scope: { userId: 'actor-1', channelId: 'c1' } }),
      record('with-thread', 'blue sky preference', { scope: { userId: 'actor-1', threadId: 't1' } }),
      record('with-task', 'blue sky preference', { scope: { userId: 'actor-1', taskId: 'task-1' } }),
    ]).retrieve(request());

    expect(results.map(({ memory }) => memory.id).sort()).toEqual(['other-session', 'with-project']);
  });

  it('applies session or project only when the request provides them', async () => {
    const records = [
      record('a', 'blue sky preference', { scope: { sessionId: 'session-1', userId: 'actor-1' } }),
      record('b', 'blue sky preference two', { scope: { sessionId: 'session-2', userId: 'actor-1' } }),
    ];
    const results = await retriever(records).retrieve(request(10, { actorId: 'actor-1', sessionId: 'session-1' }));
    expect(results.map(({ memory }) => memory.id)).toEqual(['a']);
  });

  it('fails closed without an actor and never queries the repository', async () => {
    const queries: DurableMemoryQuery[] = [];
    const repo = repository([record('a', 'blue sky preference')]);
    repo.findDurableCandidates = async (query) => { queries.push(query); return []; };
    const results = await new DefaultMemoryRetriever(repo, { clock: () => CURRENT_TIME }).retrieve(request(10, { sessionId: 'session-1' }));
    expect(results).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('widens the pre-scoring candidate fetch beyond the result limit', async () => {
    const queries: DurableMemoryQuery[] = [];
    const repo = repository([]);
    repo.findDurableCandidates = async (query) => { queries.push(query); return []; };
    await new DefaultMemoryRetriever(repo, { clock: () => CURRENT_TIME }).retrieve(request(10));
    expect(queries[0]?.limit).toBe(50);
  });

  it('caps retrieval at the lower configured limit', async () => {
    const records = Array.from({ length: 15 }, (_, index) =>
      record(`memory-${index}`, `blue sky preference ${index}`),
    );

    await expect(retriever(records).retrieve(request(15))).resolves.toHaveLength(10);
    await expect(retriever(records, { limit: 3 }).retrieve(request(10))).resolves.toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Opt-in semantic re-ranking (ADR-0098 D8)
// ---------------------------------------------------------------------------

/** Deterministic concept embedding: [pet, food, work, other]. Unrelated text is orthogonal to every concept. */
function conceptVector(text: string): number[] {
  const pet = /반려동물|고양이|강아지/u.test(text) ? 1 : 0;
  const food = /커피|음식|라면/u.test(text) ? 1 : 0;
  const work = /회의|프로젝트|보고서/u.test(text) ? 1 : 0;
  return [pet, food, work, pet + food + work === 0 ? 1 : 0];
}

class ConceptEmbedder implements AiProvider {
  readonly id = 'fake-embedder';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  readonly prompts: string[] = [];
  constructor(private readonly respond?: (request: AiRequest) => Promise<string>) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async execute(request: AiRequest) {
    this.prompts.push(request.prompt);
    if (this.respond) return { text: await this.respond(request) };
    return { text: formatEmbeddingEnvelope(conceptVector(request.prompt), 'fake-space') };
  }
}

class InMemoryVectors implements VectorProvider {
  readonly records = new Map<string, VectorRecord>();
  async init(): Promise<void> {}
  async upsert(_collection: string, records: VectorRecord[]): Promise<void> {
    for (const entry of records) this.records.set(entry.id, entry);
  }
  async query(_collection: string, vector: number[], topK: number): Promise<VectorQueryResult[]> {
    return [...this.records.values()]
      .map((entry) => ({
        id: entry.id,
        score: cosineSimilarity(vector, entry.vector),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async delete(): Promise<void> {}
}

function selecting(provider: AiProvider | Error): ProviderSelector {
  return {
    async select() {
      if (provider instanceof Error) throw provider;
      return provider;
    },
  };
}

const PET_QUERY = '반려동물 이름이 뭐였지';
const PET_MEMORY = '우리 집 고양이 이름은 나비야';

function petRequest() {
  return createMemoryRetrievalRequest({
    query: PET_QUERY,
    capability: Capability.GENERAL_CHAT,
    scope: { actorId: 'actor-1' },
    authorityFitness: ['USER_CLAIM_OR_INTENT'],
    maxResults: 10,
  });
}

/** 34 lexically closer distractors plus the lexically disjoint target, which is the oldest record. */
function seededRecords(): MemoryRecord[] {
  const distractors = Array.from({ length: 34 }, (_unused, index) =>
    record(`distractor-${String(index).padStart(2, '0')}`, `이름이 뭐였지 메모 ${index}`, {
      updatedAt: `2026-08-${String(10 + (index % 18)).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );
  return [...distractors, record('pet', PET_MEMORY, { updatedAt: '2026-08-02T00:00:00.000Z' })];
}

describe('DefaultMemoryRetriever semantic re-ranking (ADR-0098 D8)', () => {
  it('lexical recall alone misses the lexically disjoint memory', async () => {
    const results = await retriever(seededRecords()).retrieve(petRequest());
    expect(results.map(({ memory }) => memory.id)).not.toContain('pet');
  });

  it('ranks a semantically related but lexically disjoint memory into the top 10 once it is indexed', async () => {
    const embedder = new ConceptEmbedder();
    const vectors = new InMemoryVectors();
    const records = seededRecords();
    const semantic = retriever(records, {
      semanticScorer: new SemanticRecallScorer({ selector: selecting(embedder), vectors }),
    });

    // At most four new document embeddings per turn: the newest records are indexed first, the target last.
    let results = await semantic.retrieve(petRequest());
    for (let turn = 0; turn < 10 && !results.some(({ memory }) => memory.id === 'pet'); turn++) {
      results = await semantic.retrieve(petRequest());
    }

    expect(results.map(({ memory }) => memory.id)[0]).toBe('pet');
    expect(results).toHaveLength(10);
    expect(results[0]!.retrievalReason).toMatch(/^lexical=0\.0000; recency=\d\.\d{4}; semantic=1\.0000$/);
    expect(vectors.records.size).toBe(records.length);
    // Never more than the query plus four documents per turn.
    expect(embedder.prompts.length).toBeLessThanOrEqual(5 * 10);
  });

  it.each([
    ['no EMBEDDING provider', () => new NoProviderAvailableError(Capability.EMBEDDING)],
    ['a malformed provider', () => new ConceptEmbedder(async () => 'not an envelope')],
    ['a slow provider', () => new ConceptEmbedder(() => new Promise<string>(() => undefined))],
  ] as const)('gives byte-identical lexical results with %s', async (_label, makeProvider) => {
    const records = seededRecords();
    const lexical = await retriever(records).retrieve(petRequest());
    const degraded = await retriever(records, {
      semanticScorer: new SemanticRecallScorer(
        { selector: selecting(makeProvider()), vectors: new InMemoryVectors() },
        { turnBudgetMs: 20 },
      ),
    }).retrieve(petRequest());

    expect(JSON.stringify(degraded)).toBe(JSON.stringify(lexical));
  });

  it('falls back to lexical when the scorer itself throws', async () => {
    const records = seededRecords();
    const throwing: SemanticRecallScoring = {
      async score() {
        throw new Error('scorer failure');
      },
    };
    const lexical = await retriever(records).retrieve(petRequest());
    const degraded = await retriever(records, { semanticScorer: throwing }).retrieve(petRequest());
    expect(JSON.stringify(degraded)).toBe(JSON.stringify(lexical));
  });

  it('never returns an expired, superseded or other-actor record even when its vector scores highly', async () => {
    const meta = { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT' };
    const records = [
      record('expired', '고양이 메모 하나', { metadata: { ...meta, expiresAt: '2026-08-01T00:00:00.000Z' } }),
      record('superseded', '고양이 메모 둘', { metadata: { ...meta, supersededBy: 'other' } }),
      record('other-actor', '고양이 메모 셋', { scope: { userId: 'actor-2' } }),
      record('eligible', '아침에는 커피를 마셔'),
    ];
    const vectors = new InMemoryVectors();
    for (const id of ['expired', 'superseded', 'other-actor']) {
      vectors.records.set(id, { id, vector: conceptVector('고양이'), metadata: { space: 'fake-space', dimensions: 4 } });
    }
    const offered: SemanticRecallCandidate[][] = [];
    const inner = new SemanticRecallScorer({ selector: selecting(new ConceptEmbedder()), vectors });
    const spying: SemanticRecallScoring = {
      score(query, candidates) {
        offered.push([...candidates]);
        return inner.score(query, candidates);
      },
    };

    const results = await retriever(records, { semanticScorer: spying }).retrieve(petRequest());

    expect(results.map(({ memory }) => memory.id)).toEqual(['eligible']);
    expect(offered).toEqual([[{ id: 'eligible', content: '아침에는 커피를 마셔' }]]);
  });

  it('ignores a score for an id the retriever did not offer and clamps out-of-range scores', async () => {
    const records = [record('a', 'blue sky preference'), record('b', 'blue ocean')];
    const scorer: SemanticRecallScoring = {
      async score() {
        return new Map([
          ['a', 5],
          ['b', -3],
          ['not-offered', 1],
        ]);
      },
    };
    const results = await retriever(records, { semanticScorer: scorer }).retrieve(request());
    expect(results.map(({ memory }) => memory.id)).toEqual(['a', 'b']);
    expect(results[0]!.retrievalReason).toContain('semantic=1.0000');
    expect(results[1]!.retrievalReason).toContain('semantic=0.0000');
  });

  it('records the retrieval mode and the raw semantic score as structured fields (live QA D5, Codex P3)', async () => {
    const records = [record('a', 'blue sky preference'), record('b', 'blue ocean')];
    const scorer: SemanticRecallScoring = {
      async score() {
        return new Map([
          ['a', 0.8123],
          ['b', 0.25],
        ]);
      },
    };
    const results = await retriever(records, { semanticScorer: scorer }).retrieve(request());
    expect(results.map((result) => [result.retrievalMode, result.semanticScore])).toEqual([
      ['semantic', 0.8123],
      ['semantic', 0.25],
    ]);
    const lexical = await retriever(records).retrieve(request());
    expect(lexical.every((result) => result.retrievalMode === 'lexical' && result.semanticScore === undefined)).toBe(true);
  });

  it('rejects an out-of-range semantic weight', () => {
    expect(() => retriever([], { semanticWeight: 1.5 })).toThrow(RangeError);
  });
});

describe('DefaultMemoryRetriever — archived memories (ADR-0106 amendment)', () => {
  it('asks the repository to exclude archived records and never ranks or offers one to the semantic scorer', async () => {
    const archived = record('archived-1', 'blue sky preference archived', {
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        archivedAt: '2026-08-20T00:00:00.000Z',
        archiveExpiresAt: '2026-08-27T00:00:00.000Z',
      },
    });
    const live = record('live-1', 'blue sky preference live');
    const queries: DurableMemoryQuery[] = [];
    const base = repository([archived, live]);
    // A repository that ignores the filter: the retriever's own re-check still keeps the archived record out.
    const leaky: MemoryRepository = {
      ...base,
      async findDurableCandidates(query) {
        queries.push(query);
        return base.findDurableCandidates(query);
      },
    };
    const offered: string[] = [];
    const scorer: SemanticRecallScoring = {
      async score(_query, candidates: readonly SemanticRecallCandidate[]) {
        offered.push(...candidates.map((candidate) => candidate.id));
        return new Map(candidates.map((candidate) => [candidate.id, 1]));
      },
    };
    const retriever = new DefaultMemoryRetriever(leaky, { clock: () => CURRENT_TIME, semanticScorer: scorer });
    const results = await retriever.retrieve(request());
    expect(results.map((result) => result.memory.id)).toEqual(['live-1']);
    expect(offered).toEqual(['live-1']);
    expect(queries[0]?.archived).toBe('exclude');
  });
});
