import { describe, expect, it } from 'vitest';
import { Capability, createMemoryRetrievalRequest, MemoryType, type MemoryRecord } from '../domain';
import type { DurableMemoryByIdsQuery, DurableMemoryQuery, MemoryRepository } from '../ports';
import { DefaultMemoryRetriever, SEMANTIC_CANDIDATE_TOP_K } from './memory-retriever';
import type { SemanticRecallCandidate, SemanticRecallScoring, SemanticRecallSession } from './recall/semantic-recall-scorer';

const NOW = '2026-11-06T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1_000;

function record(id: string, content: string, overrides: Partial<MemoryRecord> = {}, metadata: Record<string, unknown> = {}): MemoryRecord {
  return {
    id,
    type: MemoryType.LONG_TERM,
    scope: { userId: 'owner' },
    content,
    metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT', ...metadata },
    createdAt: new Date(Date.parse(NOW) - 100 * DAY).toISOString(),
    updatedAt: new Date(Date.parse(NOW) - 100 * DAY).toISOString(),
    ...overrides,
  };
}

/**
 * A repository whose recent pool is `recent` and whose by-id read returns every named record WITHOUT applying any
 * filter: the worst case, so the tests prove the retriever's own eligibility pass is what keeps a bad hit out.
 */
function repo(recent: MemoryRecord[], all: MemoryRecord[], seen: { byIds: DurableMemoryByIdsQuery[]; recent: DurableMemoryQuery[] } = { byIds: [], recent: [] }): MemoryRepository {
  return {
    async get(id) { return all.find((entry) => entry.id === id) ?? null; },
    async save(entity) { return entity; },
    async delete() {},
    async list() { return all; },
    async findByScope() { return all; },
    async findDurableCandidates(query) { seen.recent.push(query); return recent; },
    async findDurableCandidatesByIds(query) { seen.byIds.push(query); return all.filter((entry) => query.ids.includes(entry.id)); },
    async findShortTermByUser() { return []; },
  };
}

/** A scorer whose session proposes `nearest` and scores candidates by a fixed table (perfect = 1). */
function scorerOf(nearest: string[], table: Record<string, number>, hooks: { opened?: number; failOpen?: boolean; failNearest?: boolean; nullScore?: boolean } = {}): SemanticRecallScoring {
  return {
    async score() { throw new Error('the session path must be used'); },
    async openSession() {
      if (hooks.failOpen) return null;
      hooks.opened = (hooks.opened ?? 0) + 1;
      const session: SemanticRecallSession = {
        async nearestMemoryIds() { if (hooks.failNearest) throw new Error('boom'); return nearest; },
        async score(candidates: readonly SemanticRecallCandidate[]) {
          if (hooks.nullScore) return null;
          return new Map(candidates.filter((candidate) => table[candidate.id] !== undefined).map((candidate) => [candidate.id, table[candidate.id] as number]));
        },
      };
      return session;
    },
  };
}

const ask = (maxResults = 10) => createMemoryRetrievalRequest({ query: 'where is my passport', capability: Capability.GENERAL_CHAT, scope: { actorId: 'owner' }, authorityFitness: ['USER_CLAIM_OR_INTENT'], maxResults });
const ids = async (retriever: DefaultMemoryRetriever) => (await retriever.retrieve(ask())).map((result) => result.memory.id);

describe('candidate widening (ADR-0124 section 5, owner decision 2026-11-06 b)', () => {
  const recentOne = record('recent', 'a recent note about lunch', { updatedAt: NOW });
  const old = record('old', 'the red folder in the hallway drawer holds the document', {});

  it('a memory outside the recent pool is found when it is semantically close, and the filter is asked for with the same fields', async () => {
    const seen = { byIds: [] as DurableMemoryByIdsQuery[], recent: [] as DurableMemoryQuery[] };
    const retriever = new DefaultMemoryRetriever(repo([recentOne], [recentOne, old], seen), { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 0.9, recent: 0.1 }) });
    expect(await ids(retriever)).toEqual(['old', 'recent']);
    const { limit: _limit, ...recentFilter } = seen.recent[0] as DurableMemoryQuery;
    expect(seen.byIds[0]).toEqual({ ...recentFilter, ids: ['old'] });
    expect(seen.byIds[0]).toMatchObject({ scope: { userId: 'owner' }, excludeExpired: true, excludeSuperseded: true, archived: 'exclude' });
  });

  it('without a scorer, or when no session opens, recall is the recent pool only (today)', async () => {
    expect(await ids(new DefaultMemoryRetriever(repo([recentOne], [recentOne, old]), { clock: () => NOW }))).toEqual(['recent']);
    const hooks = { failOpen: true };
    expect(await ids(new DefaultMemoryRetriever(repo([recentOne], [recentOne, old]), { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 1 }, hooks) }))).toEqual(['recent']);
  });

  it('the query is embedded once per turn: one session serves candidate generation and scoring', async () => {
    const hooks: { opened?: number } = {};
    const retriever = new DefaultMemoryRetriever(repo([recentOne], [recentOne, old]), { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 0.9 }, hooks) });
    await retriever.retrieve(ask());
    expect(hooks.opened).toBe(1);
  });

  it('a vector hit that fails any eligibility rule is dropped even with a perfect score', async () => {
    const archived = record('archived', 'passport location, archived', {}, { archivedAt: '2026-10-01T00:00:00.000Z' });
    const expired = record('expired', 'passport location, expired', {}, { expiresAt: '2026-10-01T00:00:00.000Z' });
    const superseded = record('superseded', 'passport location, superseded', {}, { supersededBy: 'new-id' });
    const foreign = record('foreign', 'passport location of another user', { scope: { userId: 'someone-else' } });
    const wrongAuthority = record('wrong-authority', 'passport location, tool output', {}, { authorityLevel: 'SYSTEM_VERIFIED' });
    const channelScoped = record('channel', 'passport location in a channel', { scope: { userId: 'owner', channelId: 'c1' } });
    const everything = [recentOne, old, archived, expired, superseded, foreign, wrongAuthority, channelScoped];
    const perfect = Object.fromEntries(everything.map((entry) => [entry.id, 1]));
    const retriever = new DefaultMemoryRetriever(repo([recentOne], everything), {
      clock: () => NOW,
      semanticScorer: scorerOf(everything.map((entry) => entry.id), perfect),
    });
    expect(await ids(retriever)).toEqual(expect.arrayContaining(['old', 'recent']));
    expect((await ids(retriever)).sort()).toEqual(['old', 'recent']);
  });

  it('a hit whose memory no longer exists is dropped silently', async () => {
    const retriever = new DefaultMemoryRetriever(repo([recentOne], [recentOne]), { clock: () => NOW, semanticScorer: scorerOf(['ghost', 'recent'], { ghost: 1, recent: 0.5 }) });
    expect(await ids(retriever)).toEqual(['recent']);
  });

  it('records already in the recent pool are not added twice, and excluded ids are never fetched back', async () => {
    const seen = { byIds: [] as DurableMemoryByIdsQuery[], recent: [] as DurableMemoryQuery[] };
    const retriever = new DefaultMemoryRetriever(repo([recentOne], [recentOne, old], seen), { clock: () => NOW, semanticScorer: scorerOf(['recent', 'old'], { recent: 1, old: 1 }) });
    const results = await ids(retriever);
    expect(results.filter((id) => id === 'recent')).toHaveLength(1);
    expect(seen.byIds[0]?.ids).toEqual(['old']);
    const excluded = createMemoryRetrievalRequest({ query: 'x', capability: Capability.GENERAL_CHAT, scope: { actorId: 'owner' }, authorityFitness: ['USER_CLAIM_OR_INTENT'], maxResults: 10, excludeIds: ['old'] });
    const filtered = await new DefaultMemoryRetriever(repo([recentOne], [recentOne, old], seen), { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 1 }) }).retrieve(excluded);
    expect(filtered.map((result) => result.memory.id)).toEqual(['recent']);
    expect(seen.byIds.at(-1)?.excludeIds).toEqual(['old']);
  });

  it('the widening count is the named constant K = 50', () => {
    expect(SEMANTIC_CANDIDATE_TOP_K).toBe(50);
  });

  it.each([
    ['the session cannot list nearest memories', { failNearest: true }],
    ['the scorer returns no scores', { nullScore: true }],
  ])('falls back to the lexical ranking of the recent pool when %s', async (_name, hooks) => {
    const retriever = new DefaultMemoryRetriever(repo([recentOne], [recentOne, old]), { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 1 }, hooks) });
    const results = await retriever.retrieve(ask());
    expect(results.map((result) => result.memory.id)).toEqual(hooks.failNearest ? ['recent'] : ['recent', 'old']);
    expect(results.every((result) => result.retrievalMode === 'lexical')).toBe(true);
  });

  it('a repository error on the widened read keeps the recent pool', async () => {
    const broken = { ...repo([recentOne], [recentOne, old]), findDurableCandidatesByIds: async () => { throw new Error('db'); } };
    const retriever = new DefaultMemoryRetriever(broken, { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 1, recent: 0.2 }) });
    expect(await ids(retriever)).toEqual(['recent']);
  });

  it('a repository without the widened read leaves recall on the recent pool', async () => {
    const plain = repo([recentOne], [recentOne, old]);
    delete (plain as { findDurableCandidatesByIds?: unknown }).findDurableCandidatesByIds;
    const retriever = new DefaultMemoryRetriever(plain, { clock: () => NOW, semanticScorer: scorerOf(['old'], { old: 1, recent: 0.2 }) });
    expect(await ids(retriever)).toEqual(['recent']);
  });
});
