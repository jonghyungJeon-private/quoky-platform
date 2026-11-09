/** ADR-0124 phase 2 P2-3: offline tests of the blend comparison. Synthetic tables plus one run through the real retriever with a fake embedder; no model. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capability, chunking, formatEmbeddingEnvelope, type AiProvider } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import { BLEND_CANDIDATES, buildBlendSweep, percentiles7, rankIds, selectCandidate, splitOf, type BlendQuery, type BlendRow, type CandidateResult, type HalfMetrics } from './blend-sweep';
import type { MemorySet } from './memory-set';
import { STAGE_R_PARAMETERS, runArmFresh, stageRDigest, type RuntimeEmbeddingProvider, type StageRInputs } from './stage-r';

const scratch = mkdtempSync(join(tmpdir(), 'blend-sweep-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const row = (id: string, o: Partial<BlendRow> = {}): BlendRow => ({ id, contentKey: `content-${id}`, updatedAt: '2026-10-01T00:00:00.000Z', lexical: 0, recency: 0.5, semantic: undefined, ...o });
const PRODUCTION = { semanticWeight: 0.7, recencyWeight: 0.1 };
const byId = (id: string) => BLEND_CANDIDATES.find((candidate) => candidate.id === id) as (typeof BLEND_CANDIDATES)[number];

describe('blend sweep: ranking formulas', () => {
  it('the candidate list is the pre-declared one', () => {
    expect(BLEND_CANDIDATES.map((c) => c.id)).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10']);
    expect(byId('B0')).toMatchObject({ semanticWeight: 0.7, recencyWeight: 0.25 });
  });

  it('linear: a candidate without a semantic score uses lexical and recency exactly like production', () => {
    const rows = [row('a', { semantic: 0.2, lexical: 0, recency: 0 }), row('b', { lexical: 0.9, recency: 0.5 })];
    // a: 0.7*0.2 = 0.14 * 0.75 = 0.105; b: 0.9*0.75 + 0.5*0.25 = 0.8
    expect(rankIds(rows, byId('B0'), 10)).toEqual(['b', 'a']);
    // B8 (semantic only, no recency): a = 0.2, b = lexical 0.9 -> still b by the production rule for unscored candidates
    expect(rankIds(rows, byId('B8'), 10)).toEqual(['b', 'a']);
  });

  it('B8 ranks by semantic alone, ties by updatedAt desc then id', () => {
    const rows = [row('a', { semantic: 0.5, updatedAt: '2026-09-01T00:00:00.000Z' }), row('b', { semantic: 0.5, updatedAt: '2026-10-01T00:00:00.000Z' }), row('c', { semantic: 0.5, updatedAt: '2026-10-01T00:00:00.000Z' }), row('d', { semantic: 0.9, lexical: 0 })];
    expect(rankIds(rows, byId('B8'), 10)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('RRF over semantic and lexical ranks (k = 60)', () => {
    const rows = [row('a', { semantic: 0.9, lexical: 0 }), row('b', { semantic: 0.5, lexical: 0.5 }), row('c', { semantic: 0.1, lexical: 1 })];
    // a: 1/61+1/63, b: 2/62, c: 1/63+1/61 (= a) -> a and c tie, id asc; both above b
    expect(rankIds(rows, byId('B9'), 10)).toEqual(['a', 'c', 'b']);
  });

  it('RRF gives no semantic term to an unscored candidate; B10 adds a recency rank', () => {
    const rows = [row('a', { semantic: 0.9, lexical: 0, recency: 0.1 }), row('u', { lexical: 0.2, recency: 0.9 })];
    // B9: a = 1/61 + 1/62 (lexical rank 2); u = 1/61 (lexical rank 1)
    expect(rankIds(rows, byId('B9'), 10)).toEqual(['a', 'u']);
    // B10: a = 1/61 (sem) + 1/62 (lex) + 1/62 (rec) = 0.0486 > u = 1/61 (lex) + 1/61 (rec) = 0.0328
    expect(rankIds(rows, byId('B10'), 10)).toEqual(['a', 'u']);
    // with the semantic rank absent for both, the recency rank decides: u (lex 1, rec 1) beats v (lex 2, rec 2)
    expect(rankIds([row('v', { lexical: 0.1, recency: 0.2 }), row('u', { lexical: 0.2, recency: 0.9 })], byId('B10'), 10)).toEqual(['u', 'v']);
  });

  it('dedups by content key and cuts at the limit', () => {
    const rows = [row('a', { semantic: 0.9, contentKey: 'same' }), row('b', { semantic: 0.8, contentKey: 'same' }), row('c', { semantic: 0.7 }), row('d', { semantic: 0.6 })];
    expect(rankIds(rows, byId('B8'), 2)).toEqual(['a', 'c']);
  });
});

describe('blend sweep: split, selection, fidelity', () => {
  it('split is deterministic per language in set order: even = select, odd = confirm', () => {
    const languages = ['ko', 'en', 'ko', 'en', 'ko', 'mixed'];
    expect(splitOf(languages)).toEqual(['select', 'select', 'confirm', 'confirm', 'select', 'select']);
    expect(splitOf(languages)).toEqual(splitOf(languages));
  });

  const half = (ko: number, en: number, mixed: number, mrr: number): HalfMetrics => ({ overall: { n: 3, recallAt5: 0, mrrAt10: mrr }, byLanguage: { ko: { n: 1, recallAt5: ko, mrrAt10: 0 }, en: { n: 1, recallAt5: en, mrrAt10: 0 }, mixed: { n: 1, recallAt5: mixed, mrrAt10: 0 } } });
  const result = (id: string, select: HalfMetrics): CandidateResult => ({ id, label: id, select, confirm: select, all: select });
  const langs = ['ko', 'en', 'mixed'];

  it('selection maximizes the worst-language Recall@5, then MRR, then the lower index', () => {
    expect(selectCandidate([result('B0', half(0.4, 0.8, 0.6, 0.5)), result('B1', half(0.5, 0.5, 0.9, 0.1)), result('B2', half(0.3, 0.9, 0.9, 0.9))], langs)).toBe('B1');
    expect(selectCandidate([result('B0', half(0.5, 0.8, 0.6, 0.5)), result('B1', half(0.5, 0.5, 0.9, 0.7))], langs)).toBe('B1');
    expect(selectCandidate([result('B0', half(0.5, 0.8, 0.6, 0.5)), result('B1', half(0.5, 0.9, 0.9, 0.5))], langs)).toBe('B0');
  });

  const goodQuery = (language: string): BlendQuery => {
    const rows = [row('g', { semantic: 0.9, lexical: 0.5 }), row('x', { semantic: 0.3, lexical: 0.2 })];
    return { language, gold: ['g'], actual: rankIds(rows, byId('B1'), 10), rows };
  };

  it('zero mismatches: valid, a candidate is selected and floor data is reported', () => {
    const sweep = buildBlendSweep([goodQuery('ko'), goodQuery('ko'), goodQuery('en'), goodQuery('en'), goodQuery('mixed'), goodQuery('mixed')], langs, PRODUCTION);
    expect(sweep.fidelity).toEqual({ queries: 6, mismatches: 0 });
    expect(sweep.invalid).toBeNull();
    expect(sweep.selected).toBe('B0');
    expect(sweep.split.select).toEqual({ ko: 1, en: 1, mixed: 1 });
    expect(sweep.confirmB0VsSelected).not.toBeNull();
    expect(sweep.floor.goldSemantic).toMatchObject({ n: 6, min: 0.9, max: 0.9 });
    expect(sweep.floor.bestNonGoldSemantic).toMatchObject({ n: 6, p50: 0.3 });
  });

  it('a fidelity mismatch marks the sweep INVALID with the count and selects nothing', () => {
    const bad: BlendQuery = { ...goodQuery('en'), actual: ['x', 'g'] };
    const sweep = buildBlendSweep([goodQuery('ko'), bad, bad], langs, PRODUCTION);
    expect(sweep.fidelity).toEqual({ queries: 3, mismatches: 2 });
    expect(sweep.invalid?.reason).toContain('2 of 3');
    expect(sweep.selected).toBeNull();
    expect(sweep.confirmB0VsSelected).toBeNull();
  });

  it('INVALID with a clear reason when no frozen candidate equals the production weights', () => {
    const sweep = buildBlendSweep([goodQuery('ko')], langs, { semanticWeight: 0.7, recencyWeight: 0.11 });
    expect(sweep.invalid?.reason).toContain('no frozen linear candidate equals the production weights');
    expect(sweep.selected).toBeNull();
    expect(sweep.fidelity.mismatches).toBe(0);
  });

  it('labels B0 as the previous production and the matching candidate as production', () => {
    const sweep = buildBlendSweep([goodQuery('ko')], langs, PRODUCTION);
    expect(sweep.candidates.find((c) => c.id === 'B0')?.label).toContain('previous production 0.25');
    expect(sweep.candidates.find((c) => c.id === 'B1')?.label).toContain('(production)');
  });

  it('percentiles are null on no data', () => {
    expect(percentiles7([])).toBeNull();
    expect(percentiles7([0.2, 0.4])).toMatchObject({ n: 2, min: 0.2, max: 0.4 });
  });
});

describe('blend sweep: stage R integration', () => {
  const DIM = 64;
  const hashOf = (term: string): number => {
    let h = 2166136261;
    for (const ch of term) h = Math.imul(h ^ (ch.codePointAt(0) as number), 16777619) >>> 0;
    return h;
  };
  const embedText = (text: string): number[] => {
    const vector = new Array<number>(DIM).fill(0);
    for (const term of chunking.lexicalTerms(text)) vector[hashOf(term) % DIM] = (vector[hashOf(term) % DIM] as number) + 1;
    vector[0] = (vector[0] as number) + 0.01;
    return vector;
  };
  const provider = (): RuntimeEmbeddingProvider =>
    ({
      id: 'fake-embed',
      capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }],
      executionLocality: 'LOCAL',
      isAvailable: async () => true,
      execute: async (request: { prompt: string }) => ({ text: formatEmbeddingEnvelope(embedText(request.prompt), 'fake-embed'), raw: {}, audit: { model: 'fake-embed' } }) as never,
    }) as unknown as AiProvider as RuntimeEmbeddingProvider;
  const WORDS = ['copper', 'lantern', 'harbor', 'violet', 'orchard', 'granite', 'saffron', 'meadow', 'compass', 'thistle'];
  const SIZE = 60;
  const set: MemorySet = {
    memories: Array.from({ length: SIZE }, (_, at) => ({ id: `mem-${at}`, language: 'en' as const, text: `note ${at} about ${WORDS[at % 10]} ${WORDS[(at * 3 + 1) % 10]} item${at}x`, long: false, factOffsets: [] })),
    queries: Array.from({ length: SIZE }, (_, at) => ({ id: `q-${at}`, language: (['ko', 'en', 'mixed'] as const)[at % 3], text: `what about item${at}x ${WORDS[at % 10]}`, gold: [`mem-${at}`], mode: 'shared' as const, sharedTerms: 2, targetLong: false, factIndex: null, beyondCut: false })),
  };

  it('the offline current formula reproduces the real DefaultMemoryRetriever on every query (0 mismatches); lexical and live carry no sweep', async () => {
    const backfilled = await runArmFresh({ arm: 'E0', mode: 'backfilled', set, provider: provider(), tmpRoot: scratch });
    expect(backfilled.invalid).toBeNull();
    expect(backfilled.blendSweep?.fidelity).toEqual({ queries: SIZE, mismatches: 0 });
    expect(backfilled.blendSweep?.invalid).toBeNull();
    expect(backfilled.blendSweep?.results).toHaveLength(BLEND_CANDIDATES.length);
    expect(backfilled.blendSweep?.split.select).toEqual({ ko: 10, en: 10, mixed: 10 });
    const lexical = await runArmFresh({ arm: 'L', mode: 'lexical', set, tmpRoot: scratch });
    expect(lexical.blendSweep).toBeNull();
    const live = await runArmFresh({ arm: 'E0', mode: 'live', set, provider: provider(), tmpRoot: scratch });
    expect(live.blendSweep).toBeNull();
  }, 60_000);

  it('records fetched by id but cut by the top-K merge never enter the table (170 memories: recent 50 + at most K = 50)', async () => {
    const big: MemorySet = {
      memories: Array.from({ length: 170 }, (_, at) => ({ id: `big-${at}`, language: 'en' as const, text: `note ${at} about ${WORDS[at % 10]} ${WORDS[(at * 3 + 1) % 10]} item${at}x`, long: false, factOffsets: [] })),
      queries: Array.from({ length: 12 }, (_, at) => ({ id: `bq-${at}`, language: (['ko', 'en', 'mixed'] as const)[at % 3], text: `what about item${at * 13}x ${WORDS[(at * 13) % 10]}`, gold: [`big-${at * 13}`], mode: 'shared' as const, sharedTerms: 2, targetLong: false, factIndex: null, beyondCut: false })),
    };
    const run = await runArmFresh({ arm: 'E0', mode: 'backfilled', set: big, provider: provider(), tmpRoot: scratch });
    // the retriever fetched up to 100 by id (2 x K) but keeps K: a pool-based table would reach 150 rows
    expect(run.blendSweep?.tableSize.max).toBeLessThanOrEqual(100);
    expect(run.blendSweep?.tableSize.max).toBeGreaterThan(50);
    expect(run.blendSweep?.fidelity.mismatches).toBe(0);
  }, 60_000);

  it('a mismatch carries diagnosis details (at most 5) with the first differing position', () => {
    const rows = [row('g', { semantic: 0.9, lexical: 0.5 }), row('x', { semantic: 0.3, lexical: 0.2 })];
    const bad: BlendQuery = { language: 'en', gold: ['g'], actual: ['x', 'g'], rows };
    const sweep = buildBlendSweep(Array.from({ length: 8 }, () => bad), ['ko', 'en', 'mixed'], PRODUCTION);
    expect(sweep.fidelity.mismatches).toBe(8);
    expect(sweep.mismatchDetails).toHaveLength(5);
    expect(sweep.mismatchDetails[0]).toMatchObject({ queryIndex: 0, language: 'en', actualTop: ['x', 'g'], offlineTop: ['g', 'x'] });
    expect(sweep.mismatchDetails[0]?.firstDifference).toMatchObject({ position: 0, actual: { id: 'x' }, offline: { id: 'g', semantic: 0.9 } });
  });

  it('the plan digest changes when the candidate list changes', () => {
    const inputs: StageRInputs = { set: { digest: 'd', memories: 1, queries: 1 }, planned: ['E0'], pins: [], dropped: [] };
    const reference = stageRDigest(inputs);
    const changed = { ...STAGE_R_PARAMETERS, blend: { ...STAGE_R_PARAMETERS.blend, candidates: BLEND_CANDIDATES.slice(0, 5) } };
    expect(stageRDigest(inputs, changed)).not.toBe(reference);
  });
});
