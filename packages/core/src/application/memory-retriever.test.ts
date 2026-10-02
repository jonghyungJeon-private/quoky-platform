import { describe, expect, it } from 'vitest';
import {
  Capability,
  createMemoryRetrievalRequest,
  MemoryType,
  type MemoryRecord,
} from '../domain';
import type { DurableMemoryQuery, MemoryRepository } from '../ports';
import { DefaultMemoryRetriever } from './memory-retriever';

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
