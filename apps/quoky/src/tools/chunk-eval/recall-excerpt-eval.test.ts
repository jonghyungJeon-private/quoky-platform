/**
 * ADR-0124 phase 2 P2-6: offline tests of the recall-excerpt comparison (metrics, pre-declared verdict, and one run through the
 * real runtime classes with a deterministic fake embedder). No model is called.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Capability, chunking, formatEmbeddingEnvelope, renderRecallContent, type AiProvider } from '@quoky/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { MemorySet } from './memory-set';
import {
  DELIVERED_ENTRY_LIMIT,
  EXCERPT_VERDICT_RULE,
  buildExcerptComparison,
  deliveredFor,
  excerptComparisonLines,
  excerptOutcome,
  excerptVerdict,
  factSentenceOf,
  nearestRank,
  variantMetrics,
  type ExcerptQueryOutcome,
  type VariantMetrics,
} from './recall-excerpt-eval';
import { IMPLEMENTATION_FILES, STAGE_R_PARAMETERS, runArmFresh, summaryLinesStageR, buildStageRReport, STAGE_R_PLAN_VERSION, type RuntimeEmbeddingProvider } from './stage-r';

const scratch = mkdtempSync(join(tmpdir(), 'recall-excerpt-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('fact sentence and delivery', () => {
  const text = 'Alpha is 3.5 units. filler one filler.\n\nBeta is green. filler two.\n\nGamma ends here';
  const memory = { text, factOffsets: [0, text.indexOf('Beta'), text.indexOf('Gamma')] };
  it('the fact sentence is the leading sentence of the asked block, not the filler after it', () => {
    expect(factSentenceOf(memory, 0)).toBe('Alpha is 3.5 units.');
    expect(factSentenceOf(memory, 1)).toBe('Beta is green.');
    expect(factSentenceOf(memory, 2)).toBe('Gamma ends here');
    expect(factSentenceOf(memory, 3)).toBeUndefined();
  });

  it('delivery mirrors the builder: retriever order, no repeated id or content, at most 10 entries, rank = position among delivered', () => {
    expect(DELIVERED_ENTRY_LIMIT).toBe(10);
    const results = [
      { id: 'a', content: 'same' },
      { id: 'a', content: 'other' },
      { id: 'b', content: 'same' },
      ...Array.from({ length: 12 }, (_, at) => ({ id: `m${at}`, content: `memory ${at}` })),
    ];
    const out = deliveredFor(results, 'V0');
    expect(out.map((entry) => entry.id)).toEqual(['a', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
    const body = (n: number): string => `${'가'.repeat(n)}`;
    const long = `${body(590)}\n\n${body(590)}\n\n${body(590)}`;
    const ranked = Array.from({ length: 5 }, (_, at) => ({ id: `r${at}`, content: `${long}${at}`, matchedPassageOrdinal: 0 }));
    const v2 = deliveredFor(ranked, 'V2');
    expect(v2.map((entry) => entry.text.length)).toEqual([1_201, 1_201, 1_201, 401, 401]);
    // a duplicate that is skipped does not use up a top rank
    const skipped = deliveredFor([{ id: 'x', content: long, matchedPassageOrdinal: 0 }, { id: 'x', content: long, matchedPassageOrdinal: 0 }, ...ranked], 'V2');
    expect(skipped.map((entry) => entry.text.length)).toEqual([1_201, 1_201, 1_201, 401, 401, 401]);
  });

  it('the V0 delivery is the pure function at V0', () => {
    const results = [{ id: 'a', content: 'x'.repeat(900), matchedPassageOrdinal: 1 }];
    expect(deliveredFor(results, 'V0')[0]?.text).toBe(renderRecallContent('x'.repeat(900), 1, 1, 'V0'));
  });

  it('fact delivered needs gold delivered AND the whole fact sentence in the text, ellipses ignored', () => {
    const query = { gold: ['m'], targetLong: true, factIndex: 1, beyondCut: false };
    const memories = new Map([['m', memory]]);
    expect(excerptOutcome(query, memories, [{ id: 'm', text: '…Beta is green. filler two.…' }])).toMatchObject({ goldDelivered: true, factDelivered: true });
    expect(excerptOutcome(query, memories, [{ id: 'm', text: '…Beta is gre…' }])).toMatchObject({ goldDelivered: true, factDelivered: false });
    expect(excerptOutcome(query, memories, [{ id: 'other', text: 'Beta is green.' }])).toMatchObject({ goldDelivered: false, factDelivered: false });
    expect(excerptOutcome({ ...query, targetLong: false, factIndex: null }, memories, [{ id: 'm', text: 'Beta is green.' }]).factDelivered).toBe(false);
    expect(excerptOutcome(query, memories, [{ id: 'm', text: 'ab' }, { id: 'z', text: 'cde' }]).chars).toBe(5);
  });
});

const outcome = (over: Partial<ExcerptQueryOutcome> = {}): ExcerptQueryOutcome => ({ targetLong: true, beyondCut: false, goldDelivered: true, factDelivered: false, chars: 1000, ...over });

describe('metrics and the pre-declared verdict', () => {
  it('percentiles are nearest-rank; shares split beyondCut / within', () => {
    expect(nearestRank([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(nearestRank(Array.from({ length: 100 }, (_, at) => at + 1), 0.95)).toBe(95);
    expect(nearestRank([], 0.5)).toBe(0);
    const metrics = variantMetrics('V1', [outcome({ factDelivered: true, beyondCut: true, chars: 10 }), outcome({ beyondCut: true, chars: 20 }), outcome({ factDelivered: true, chars: 30 }), outcome({ targetLong: false, chars: 40 })]);
    expect(metrics.factDelivered).toMatchObject({ n: 2, of: 3 });
    expect(metrics.factDeliveredBeyondCut).toMatchObject({ n: 1, of: 2 });
    expect(metrics.factDeliveredWithinCut).toMatchObject({ n: 1, of: 1 });
    expect(metrics.goldDelivered).toMatchObject({ n: 4, of: 4 });
    expect(metrics.chars).toEqual({ p50: 20, p95: 40, max: 40 });
  });

  /** n long queries, `facts` of which have the fact delivered; `gold` of 100 total queries have gold; p95 chars fixed. */
  const metric = (variant: 'V0' | 'V1' | 'V2', facts: number, goldDelivered = 100, p95 = 1000): VariantMetrics => {
    const base = variantMetrics(variant, Array.from({ length: 100 }, (_, at) => outcome({ factDelivered: at < facts, goldDelivered: at < goldDelivered, chars: p95 })));
    return base;
  };

  it('adopt V1 iff fact(V1) > fact(V0) and gold(V1) == gold(V0)', () => {
    expect(excerptVerdict(metric('V0', 30), metric('V1', 31), metric('V2', 31))).toBe('adopt V1');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 30), metric('V2', 30))).toBe('keep V0');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 29), metric('V2', 29))).toBe('keep V0');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 60, 99), metric('V2', 60, 99))).toBe('keep V0');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 60, 100), metric('V2', 60, 100))).toBe('adopt V1');
  });

  it('adopt V2 only with +0.10 over V1, the same gold and p95 chars within 2 x V0', () => {
    expect(excerptVerdict(metric('V0', 30), metric('V1', 50), metric('V2', 60))).toBe('adopt V2');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 50), metric('V2', 59))).toBe('adopt V1');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 50), metric('V2', 60, 100, 2000))).toBe('adopt V2');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 50), metric('V2', 60, 100, 2001))).toBe('adopt V1');
    expect(excerptVerdict(metric('V0', 30), metric('V1', 50), metric('V2', 90, 99))).toBe('adopt V1');
    // V2 cannot win when V1 does not qualify
    expect(excerptVerdict(metric('V0', 30), metric('V1', 30), metric('V2', 90))).toBe('keep V0');
  });

  it('the comparison reports the verdict and the rule, and the rule is in the plan digest parameters', () => {
    const outcomes = { V0: [outcome()], V1: [outcome({ factDelivered: true })], V2: [outcome({ factDelivered: true })] };
    const comparison = buildExcerptComparison(outcomes);
    expect(comparison.verdict).toBe('adopt V1');
    const text = excerptComparisonLines(comparison).join('\n');
    expect(text).toContain('verdict: adopt V1');
    expect(text).toContain(EXCERPT_VERDICT_RULE.text);
    expect(STAGE_R_PARAMETERS.recallExcerpts.verdict).toBe(EXCERPT_VERDICT_RULE);
    expect(STAGE_R_PLAN_VERSION).toBe('runtime-recall-plan.v4');
    for (const file of ['packages/core/src/application/recall/recall-excerpt.ts', 'packages/core/src/application/context-builder.ts', 'apps/quoky/src/tools/chunk-eval/recall-excerpt-eval.ts']) expect(IMPLEMENTATION_FILES).toContain(file);
  });
});

// ---------------------------------------------------------------- end to end through the real classes with a fake embedder

const DIM = 128;
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
const fakeProvider = (): RuntimeEmbeddingProvider =>
  ({
    id: 'fake-embed',
    capabilities: [{ capability: Capability.EMBEDDING, priority: 100 }],
    executionLocality: 'LOCAL',
    isAvailable: async () => true,
    execute: async (request: { prompt: string }) => ({ text: formatEmbeddingEnvelope(embedText(request.prompt), 'fake-embed'), raw: {}, audit: { model: 'fake-embed' } }) as never,
  }) as unknown as AiProvider as RuntimeEmbeddingProvider;

const FILLER = ['lorem', 'ipsum', 'dolor', 'amet', 'tempus', 'varius', 'nibh', 'porta', 'felis', 'mauris'];
const filler = (seed: number): string => {
  let out = '';
  for (let at = 0; out.length < 520; at += 1) out += `${FILLER[(seed * 7 + at * 3) % 10]} ${FILLER[(seed + at) % 10]}, `;
  return `${out.trim()}.`;
};
/** A long memory in the generator's shape: blocks of "fact sentence + filler paragraph" joined by blank lines. */
function longMemory(id: string, name: string, facts: number): MemorySet['memories'][number] {
  let text = '';
  const offsets: number[] = [];
  for (let at = 0; at < facts; at += 1) {
    if (text !== '') text += '\n\n';
    offsets.push(text.length);
    text += `The ${name}${at}x record keeps value${name}${at}y here. ${filler(at)}`;
  }
  return { id, language: 'en', text, long: true, factOffsets: offsets };
}
const setOf = (): MemorySet => {
  const memories = [longMemory('long-a', 'zorb', 9), longMemory('long-b', 'quix', 9), { id: 'short-a', language: 'en' as const, text: 'the cactus waters itself on tuesday', long: false, factOffsets: [0] }];
  const longQuery = (memoryId: string, name: string, factIndex: number) => ({ id: `q-${memoryId}-${factIndex}`, language: 'en' as const, text: `what is value${name}${factIndex}y for ${name}${factIndex}x`, gold: [memoryId], mode: 'shared' as const, sharedTerms: 2, targetLong: true, factIndex, beyondCut: false });
  return {
    memories,
    queries: [longQuery('long-a', 'zorb', 0), longQuery('long-a', 'zorb', 6), longQuery('long-b', 'quix', 4), longQuery('long-b', 'quix', 8), { id: 'q-short', language: 'en', text: 'when does the cactus water itself', gold: ['short-a'], mode: 'shared', sharedTerms: 3, targetLong: false, factIndex: null, beyondCut: false }],
  };
};

describe('stage R through the real classes (fake embedder, backfilled)', () => {
  it('V1 delivers facts the head cut loses, gold delivery is unchanged, and the summary prints the verdict', async () => {
    const run = await runArmFresh({ arm: 'E4', mode: 'backfilled', set: setOf(), provider: fakeProvider(), tmpRoot: scratch });
    expect(run.invalid).toBeNull();
    const excerpts = run.excerpts;
    expect(excerpts).not.toBeNull();
    const [v0, v1, v2] = excerpts?.variants as [VariantMetrics, VariantMetrics, VariantMetrics];
    expect(excerpts?.longQueries).toBe(4);
    expect(v0.goldDelivered.n).toBe(5);
    expect(v1.goldDelivered.n).toBe(v0.goldDelivered.n);
    // only the first block of a long memory is inside the 400-unit head
    expect(v0.factDelivered.n).toBeLessThanOrEqual(1);
    expect(v1.factDelivered.n).toBeGreaterThan(v0.factDelivered.n);
    expect(v2.factDelivered.n).toBeGreaterThanOrEqual(v1.factDelivered.n);
    expect(v2.chars.max).toBeGreaterThan(v0.chars.max);
    expect(excerpts?.verdict).not.toBe('keep V0');
    const report = buildExcerptReport(run);
    expect(report).toContain('recall excerpt variants');
    expect(report).toContain(`verdict: ${excerpts?.verdict}`);
  }, 60_000);

  it('the lexical arm has no matched passage: V1 equals V0 and the verdict keeps V0', async () => {
    const run = await runArmFresh({ arm: 'L', mode: 'lexical', set: setOf(), tmpRoot: scratch });
    const [v0, v1] = run.excerpts?.variants as [VariantMetrics, VariantMetrics];
    expect(v1.factDelivered).toEqual(v0.factDelivered);
    expect(v1.chars).toEqual(v0.chars);
    expect(run.excerpts?.verdict).toBe('keep V0');
  }, 60_000);
});

function buildExcerptReport(run: Awaited<ReturnType<typeof runArmFresh>>): string {
  return summaryLinesStageR(buildStageRReport('d'.repeat(64), { version: STAGE_R_PLAN_VERSION, digest: 'e'.repeat(64), pins: [], planned: ['E4'], dropped: [] }, [run])).join('\n');
}
