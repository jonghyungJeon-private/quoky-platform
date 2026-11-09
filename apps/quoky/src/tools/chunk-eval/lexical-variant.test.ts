/** ADR-0124 phase 2 P2-5 (A): BM25 normalization, the lexical comparison and its pre-declared verdict (offline, no model). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capability, chunking, formatEmbeddingEnvelope, type AiProvider } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { MemorySet } from './memory-set';
import { BLEND_CANDIDATES, type BlendQuery, type BlendRow } from './blend-sweep';
import { LEXICAL_VERDICT_RULE, bm25NormalizedScores, buildLexicalComparison, lexicalComparisonLines, lexicalSetVerdict, lexicalVerdict, withBm25Lexical, type LexicalComparison, type LexicalVariantResult } from './lexical-variant';
import { STAGE_R_PARAMETERS, runArmFresh, type RuntimeEmbeddingProvider } from './stage-r';
import { STAGE_R_V2_PARAMETERS } from './stage-r-v2';

const PRODUCTION = { semanticWeight: 0.7, recencyWeight: 0.1 };
const row = (id: string, o: Partial<BlendRow> = {}): BlendRow => ({ id, contentKey: `content-${id}`, updatedAt: '2026-10-01T00:00:00.000Z', lexical: 0, recency: 0.5, semantic: undefined, ...o });

describe('BM25 normalization', () => {
  it('divides by the pool maximum: the best row is 1, the others are in [0, 1)', () => {
    const scores = bm25NormalizedScores('고양이 이름', ['우리 고양이 이름은 보리야', '고양이는 귀엽다', '오늘 날씨가 맑다']);
    expect(Math.max(...scores)).toBeCloseTo(1, 12);
    expect(scores[0]).toBe(1);
    expect(scores[1]).toBeGreaterThan(0);
    expect(scores[1]).toBeLessThan(1);
    expect(scores[2]).toBe(0);
  });

  it('is 0 for every row when the maximum is 0 (no shared term), and empty for an empty pool', () => {
    expect(bm25NormalizedScores('zzz', ['apple pie', 'banana split'])).toEqual([0, 0]);
    expect(bm25NormalizedScores('apple', [])).toEqual([]);
  });

  it('finds a Korean noun with an attached particle that whole-word overlap misses', () => {
    const scores = bm25NormalizedScores('과일', ['내가 제일 좋아하는 과일은 샤인머스캣이야', '내일은 비가 온다']);
    expect(scores[0]).toBe(1);
    expect(scores[1]).toBe(0);
  });

  it('withBm25Lexical replaces only the lexical field and keeps the rest', () => {
    const rows = [row('a', { text: '과일은 맛있다', lexical: 0.9, semantic: 0.4 }), row('b', { text: '하늘이 푸르다', lexical: 0.1 })];
    const out = withBm25Lexical(rows, '과일');
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ lexical: 1, semantic: 0.4, contentKey: 'content-a' });
    expect(out[1]?.lexical).toBe(0);
  });
});

describe('lexical comparison under the production weights', () => {
  // Korean query whose gold carries the noun with a particle: whole-word lexical is 0 for everyone, BM25 finds the gold.
  const koQuery = (gold = 'g'): BlendQuery => ({
    language: 'ko',
    queryText: '과일',
    gold: [gold],
    actual: [],
    rows: [row('x', { text: '하늘이 푸르다', lexical: 0, recency: 0.9 }), row('g', { text: '내가 좋아하는 과일은 사과야', lexical: 0, recency: 0.1 })],
  });

  it('ranks both variants with the production candidate; L-bm25 recovers the gold that L-word loses', () => {
    const comparison = buildLexicalComparison([koQuery()], ['ko', 'en'], [], PRODUCTION);
    expect(comparison.productionCandidate).toBe('B1');
    expect(comparison.invalid).toBeNull();
    const word = comparison.variants.find((v) => v.id === 'L-word') as LexicalVariantResult;
    const bm25 = comparison.variants.find((v) => v.id === 'L-bm25') as LexicalVariantResult;
    expect(word.byLanguage.ko).toMatchObject({ n: 1, recallAt5: 1, mrrAt10: 0.5 });
    expect(bm25.byLanguage.ko).toMatchObject({ n: 1, recallAt5: 1, mrrAt10: 1 });
    expect(word.byLanguage.en?.n).toBe(0);
  });

  it('is INVALID with a reason when no candidate equals the production weights or the table lacks the texts', () => {
    expect(buildLexicalComparison([koQuery()], ['ko'], [], { semanticWeight: 0.7, recencyWeight: 0.11 }).invalid?.reason).toContain('no frozen linear candidate');
    const noText: BlendQuery = { language: 'ko', gold: ['g'], actual: [], rows: [row('g')] };
    expect(buildLexicalComparison([noText], ['ko'], [], PRODUCTION).invalid?.reason).toContain('lack the memory text');
    expect(lexicalSetVerdict('ch8', buildLexicalComparison([noText], ['ko'], [], PRODUCTION)).pass).toBeNull();
  });

  it('per-category metrics are reported for CH8', () => {
    const tagged = { ...koQuery(), category: 'paraphrase' };
    const comparison = buildLexicalComparison([tagged], ['ko'], ['paraphrase', 'shared'], PRODUCTION);
    expect(comparison.variants[0]?.byCategory.paraphrase?.n).toBe(1);
    expect(comparison.variants[0]?.byCategory.shared?.n).toBe(0);
  });

  it('the production weights candidate exists in the frozen list', () => {
    expect(BLEND_CANDIDATES.some((c) => c.kind === 'linear' && c.semanticWeight === 0.7 && c.recencyWeight === 0.1)).toBe(true);
  });
});

const metrics = (recallAt5: number, mrrAt10: number, n = 100) => ({ n, recallAt5, mrrAt10 });
const comparisonOf = (word: { all: number; ko: number; mrr: number }, bm25: { all: number; ko: number; mrr: number }): LexicalComparison => ({
  productionCandidate: 'B1',
  invalid: null,
  variants: [
    { id: 'L-word', overall: metrics(word.all, word.mrr), byLanguage: { ko: metrics(word.ko, 0) }, byCategory: {} },
    { id: 'L-bm25', overall: metrics(bm25.all, bm25.mrr), byLanguage: { ko: metrics(bm25.ko, 0) }, byCategory: {} },
  ],
});

describe('lexical verdict boundaries (pre-declared)', () => {
  const base = { all: 0.9, ko: 0.8, mrr: 0.8 };
  it('CH8: overall and ko Recall@5 must be >= L-word, MRR@10 >= L-word - 0.005 (all inclusive)', () => {
    expect(lexicalSetVerdict('ch8', comparisonOf(base, { all: 0.9, ko: 0.8, mrr: 0.795 })).pass).toBe(true);
    expect(lexicalSetVerdict('ch8', comparisonOf(base, { all: 0.9, ko: 0.8, mrr: 0.7949 })).pass).toBe(false);
    expect(lexicalSetVerdict('ch8', comparisonOf(base, { all: 0.8999, ko: 0.9, mrr: 0.9 })).pass).toBe(false);
    expect(lexicalSetVerdict('ch8', comparisonOf(base, { all: 0.95, ko: 0.7999, mrr: 0.9 })).pass).toBe(false);
    expect(lexicalSetVerdict('ch8', comparisonOf(base, { all: 0.95, ko: 0.9, mrr: 0.9 })).checks).toHaveLength(3);
  });

  it('CH7: overall Recall@5 >= L-word - 0.01 (inclusive)', () => {
    expect(lexicalSetVerdict('ch7', comparisonOf(base, { all: 0.89, ko: 0, mrr: 0 })).pass).toBe(true);
    expect(lexicalSetVerdict('ch7', comparisonOf(base, { all: 0.8899, ko: 0, mrr: 0 })).pass).toBe(false);
    expect(lexicalSetVerdict('ch7', comparisonOf(base, { all: 0.89, ko: 0, mrr: 0 })).checks).toHaveLength(1);
  });

  it('adopt only when both sets pass; keep as soon as one fails; pending while one is unknown', () => {
    expect(lexicalVerdict(true, true)).toBe('adopt L-bm25');
    expect(lexicalVerdict(true, false)).toBe('keep L-word');
    expect(lexicalVerdict(false, null)).toBe('keep L-word');
    expect(lexicalVerdict(null, false)).toBe('keep L-word');
    expect(lexicalVerdict(true, null)).toContain('pending');
    expect(lexicalVerdict(null, null)).toContain('pending');
  });

  it('the rule text and both variants are part of the plan parameters (so of the digests)', () => {
    expect(STAGE_R_PARAMETERS.lexicalVariants.rule).toBe(LEXICAL_VERDICT_RULE);
    expect(STAGE_R_V2_PARAMETERS.lexicalVariants.rule).toBe(LEXICAL_VERDICT_RULE);
    expect(STAGE_R_PARAMETERS.lexicalVariants.ids).toEqual(['L-word', 'L-bm25']);
  });

  it('prints both variants and the verdict part', () => {
    const lines = lexicalComparisonLines('ch8', comparisonOf(base, { all: 0.95, ko: 0.9, mrr: 0.9 }), ['ko'], []).join('\n');
    expect(lines).toContain('L-word (production)');
    expect(lines).toContain('L-bm25');
    expect(lines).toContain('CH8 lexical conditions: PASS');
  });
});

describe('lexical variants through the real runtime classes (fake embedder)', () => {
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
  const set: MemorySet = {
    memories: Array.from({ length: 30 }, (_, at) => ({ id: `mem-${at}`, language: 'en' as const, text: `note ${at} about ${WORDS[at % 10]} ${WORDS[(at * 3 + 1) % 10]} item${at}x`, long: false, factOffsets: [] })),
    queries: Array.from({ length: 30 }, (_, at) => ({ id: `q-${at}`, language: (['ko', 'en', 'mixed'] as const)[at % 3], text: `what about item${at}x ${WORDS[at % 10]}`, gold: [`mem-${at}`], mode: 'shared' as const, sharedTerms: 2, targetLong: false, factIndex: null, beyondCut: false })),
  };
  const scratch = mkdtempSync(join(tmpdir(), 'lexical-variant-test-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('the table rows carry the memory and query texts; both variants are reported in backfilled mode only; fidelity stays on L-word', async () => {
    const run = await runArmFresh({ arm: 'E0', mode: 'backfilled', set, provider: provider(), tmpRoot: scratch });
    expect(run.invalid).toBeNull();
    expect(run.blendSweep?.fidelity.mismatches).toBe(0);
    expect(run.lexicalVariants?.invalid).toBeNull();
    expect(run.lexicalVariants?.variants.map((v) => v.id)).toEqual(['L-word', 'L-bm25']);
    expect(run.lexicalVariants?.variants[0]?.overall.n).toBe(30);
    // the L-word row of the comparison equals the production candidate's all-half result of the sweep
    const b1 = run.blendSweep?.results.find((r) => r.id === 'B1');
    expect(run.lexicalVariants?.variants[0]?.overall.recallAt5).toBe(b1?.all.overall.recallAt5);
    expect(run.lexicalVariants?.variants[0]?.overall.mrrAt10).toBe(b1?.all.overall.mrrAt10);
    const lexical = await runArmFresh({ arm: 'L', mode: 'lexical', set, tmpRoot: scratch });
    expect(lexical.lexicalVariants).toBeNull();
    const live = await runArmFresh({ arm: 'E0', mode: 'live', set, provider: provider(), tmpRoot: scratch });
    expect(live.lexicalVariants).toBeNull();
  }, 60_000);
});
