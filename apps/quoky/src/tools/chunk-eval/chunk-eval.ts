/**
 * ADR-0124 slice C2: the CH1 run. Pure over the corpus; no model, no embedder, no network, no clock (the CLI adds the
 * time to the file name). CH1-CH7 thresholds are PROPOSALS (section 7): this report shows numbers and a proposal
 * reference, and never a ratified PASSED.
 */
import { chunking } from '@quoky/core';

import { baselineWindow, lexicalRank, lexicalWindow, NOT_RUN_ARMS, windowHasNeedle } from './arms';
import { CORPUS_SEED, CORPUS_VERSION, DEPTHS, SHAPES, type ChunkEvalCase } from './corpus';
import { mean, ndcgAtK, recallAtK, reciprocalRank, round4 } from './metrics';

const codePointLength = chunking.codePointLength;

export interface Stratum {
  readonly n: number;
  readonly windowRecall: number;
}
export type Strata = Readonly<Record<string, Stratum>>;

/** Window recall by shape, then by a second factor (shape x depth, shape x length tier, shape x language, shape x needle kind). */
export type ShapeStrata = Readonly<Record<string, Strata>>;

export interface ArmReport {
  readonly cases: number;
  readonly windowRecall: number;
  readonly refusedOrEmpty: number;
  readonly meanWindowCodePoints: number;
  readonly byDepth: Strata;
  readonly byShape: Strata;
  readonly byLanguage: Strata;
  readonly byLength: Strata;
  readonly byNeedleKind: Strata;
  readonly byShapeDepth: Readonly<Record<string, Strata>>;
  readonly byShapeLength: Readonly<Record<string, Strata>>;
  readonly byShapeLanguage: Readonly<Record<string, Strata>>;
  readonly byShapeNeedleKind: Readonly<Record<string, Strata>>;
}

/** C1 chunker statistics for one shape (EL arm's chunking of every case of the shape; whole-item coverage packing for windows). */
export interface ShapeChunkStats {
  readonly cases: number;
  readonly passagesPerCase: { readonly mean: number; readonly max: number };
  readonly passageCodePoints: { readonly mean: number; readonly p95: number; readonly max: number };
  /** Windows needed to cover the whole item with the default window budget (3,000 code points / 1,800 estimated tokens). */
  readonly windowsPerCase: { readonly mean: number; readonly max: number };
  readonly overCap: number;
  /** Passages carrying an overlap (a split paragraph or code block), and their share of all passages. */
  readonly overlapPassages: number;
  readonly overlapShare: number;
  readonly kinds: Readonly<Record<string, number>>;
}

export const BOUNDARY_LEVEL_NOTE =
  'not exposed: a Passage carries its kind, span, overlap and overCap but not which boundary level (heading, blank line, list item, sentence, grapheme) produced the cut; the chunker was not changed to expose it, so that column is skipped';

export interface RetrievalReport {
  readonly recallAt1: number;
  readonly recallAt3: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly byDepth: Readonly<Record<string, { readonly n: number; readonly recallAt5: number; readonly mrr: number }>>;
  readonly byLanguage: Readonly<Record<string, { readonly n: number; readonly recallAt5: number; readonly mrr: number }>>;
}

export interface CaseRow {
  readonly id: string;
  readonly baselineHit: boolean;
  readonly lexicalHit: boolean;
  readonly lexicalRank: number | null;
  readonly passages: number;
}

export interface ChunkEvalReport {
  readonly kind: 'chunk-eval';
  readonly status: 'NON-GATING';
  readonly corpus: { readonly version: string; readonly seed: string; readonly sha256: string; readonly cases: number };
  readonly arms: { readonly baseline: ArmReport; readonly EL: ArmReport & { readonly retrieval: RetrievalReport } };
  readonly notRun: readonly string[];
  readonly gate: {
    readonly id: 'CH1';
    readonly ratified: false;
    readonly proposal: string;
    readonly verdict: 'NOT_RUN';
    readonly note: string;
    readonly lexicalReference: { readonly minRecallDepth30to70: number; readonly meetsProposalBar: boolean; readonly informationalOnly: true };
  };
  readonly chunker: { readonly byShape: Readonly<Record<string, ShapeChunkStats>>; readonly boundaryLevel: string };
  readonly caseRows: readonly CaseRow[];
}

type Keyed = (item: ChunkEvalCase) => string;
const KEYS: Readonly<Record<'byDepth' | 'byShape' | 'byLanguage' | 'byLength' | 'byNeedleKind', Keyed>> = {
  byDepth: (item) => String(item.depth),
  byShape: (item) => item.shape,
  byLanguage: (item) => item.language,
  byLength: (item) => String(item.length),
  byNeedleKind: (item) => item.needleKind,
};

function strata(cases: readonly ChunkEvalCase[], hits: readonly boolean[], key: Keyed): Strata {
  const groups = new Map<string, boolean[]>();
  cases.forEach((item, at) => {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), hits[at] as boolean]);
  });
  const out: Record<string, Stratum> = {};
  for (const name of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const list = groups.get(name) as boolean[];
    out[name] = { n: list.length, windowRecall: round4(mean(list.map((hit) => (hit ? 1 : 0)))) };
  }
  return out;
}

function nestedStrata(cases: readonly ChunkEvalCase[], hits: readonly boolean[], second: Keyed): Record<string, Strata> {
  const out: Record<string, Strata> = {};
  for (const shape of SHAPES) {
    const at = cases.map((item, i) => (item.shape === shape ? i : -1)).filter((i) => i >= 0);
    if (at.length === 0) continue;
    out[shape] = strata(
      at.map((i) => cases[i] as ChunkEvalCase),
      at.map((i) => hits[i] as boolean),
      second,
    );
  }
  return out;
}

export function armReport(cases: readonly ChunkEvalCase[], hits: readonly boolean[], windowPoints: readonly number[], unsent: number): ArmReport {
  return {
    cases: cases.length,
    windowRecall: round4(mean(hits.map((hit) => (hit ? 1 : 0)))),
    refusedOrEmpty: unsent,
    meanWindowCodePoints: Math.round(mean(windowPoints)),
    byDepth: strata(cases, hits, KEYS.byDepth),
    byShape: strata(cases, hits, KEYS.byShape),
    byLanguage: strata(cases, hits, KEYS.byLanguage),
    byLength: strata(cases, hits, KEYS.byLength),
    byNeedleKind: strata(cases, hits, KEYS.byNeedleKind),
    byShapeDepth: nestedStrata(cases, hits, KEYS.byDepth),
    byShapeLength: nestedStrata(cases, hits, KEYS.byLength),
    byShapeLanguage: nestedStrata(cases, hits, KEYS.byLanguage),
    byShapeNeedleKind: nestedStrata(cases, hits, KEYS.byNeedleKind),
  };
}

export class ChunkStatsAccumulator {
  private cases = 0;
  private readonly perCase: number[] = [];
  private readonly sizes: number[] = [];
  private readonly windows: number[] = [];
  private overCap = 0;
  private overlap = 0;
  private readonly kinds: Record<string, number> = {};

  add(prepared: string, passages: readonly chunking.Passage[]): void {
    this.cases += 1;
    this.perCase.push(passages.length);
    for (const passage of passages) {
      this.sizes.push(passage.span.end - passage.span.start);
      if (passage.overCap === true) this.overCap += 1;
      if (passage.overlap !== undefined) this.overlap += 1;
      this.kinds[passage.kind] = (this.kinds[passage.kind] ?? 0) + 1;
    }
    this.windows.push(chunking.packWindows(prepared, passages, passages.map((passage) => passage.ordinal)).length);
  }

  stats(): ShapeChunkStats {
    const sorted = [...this.sizes].sort((a, b) => a - b);
    const p95 = sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] as number);
    const max = (list: readonly number[]): number => list.reduce((top, value) => Math.max(top, value), 0);
    return {
      cases: this.cases,
      passagesPerCase: { mean: Math.round(mean(this.perCase) * 10) / 10, max: max(this.perCase) },
      passageCodePoints: { mean: Math.round(mean(this.sizes)), p95, max: max(this.sizes) },
      windowsPerCase: { mean: Math.round(mean(this.windows) * 10) / 10, max: max(this.windows) },
      overCap: this.overCap,
      overlapPassages: this.overlap,
      overlapShare: round4(this.sizes.length === 0 ? 0 : this.overlap / this.sizes.length),
      kinds: Object.fromEntries(Object.entries(this.kinds).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}

export const CH1_PROPOSAL = 'Hybrid (EH) window recall >= 95% at every depth from 30 to 70% (ADR-0124 section 7, proposal)';

export function runChunkEval(cases: readonly ChunkEvalCase[], digest: string): ChunkEvalReport {
  const baselineHits: boolean[] = [];
  const baselinePoints: number[] = [];
  let baselineUnsent = 0;
  const lexicalHits: boolean[] = [];
  const lexicalPoints: number[] = [];
  let lexicalUnsent = 0;
  const ranks: (number | null)[] = [];
  const ndcgs: number[] = [];
  const rows: CaseRow[] = [];
  const accumulators = new Map<string, ChunkStatsAccumulator>();
  for (const item of cases) {
    const base = baselineWindow(item);
    const baseHit = windowHasNeedle(base, item);
    baselineHits.push(baseHit);
    baselinePoints.push(codePointLength(base.text));
    if (!base.sent) baselineUnsent += 1;
    const lexical = lexicalWindow(item);
    const lexHit = windowHasNeedle(lexical.window, item);
    lexicalHits.push(lexHit);
    lexicalPoints.push(codePointLength(lexical.window.text));
    if (!lexical.window.sent) lexicalUnsent += 1;
    const accumulator = accumulators.get(item.shape) ?? new ChunkStatsAccumulator();
    accumulators.set(item.shape, accumulator);
    accumulator.add(item.prepared, lexical.passages);
    const rank = lexicalRank(lexical);
    ranks.push(rank);
    ndcgs.push(ndcgAtK(lexical.ranking, lexical.relevant, 10));
    rows.push({ id: item.id, baselineHit: baseHit, lexicalHit: lexHit, lexicalRank: rank, passages: lexical.passageCount });
  }
  const recallAt = (k: number): number => round4(mean(ranks.map((rank) => recallAtK(rank, k))));
  const group = (key: Keyed): Record<string, { n: number; recallAt5: number; mrr: number }> => {
    const names = [...new Set(cases.map(key))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    return Object.fromEntries(
      names.map((name) => {
        const at = cases.map((item, i) => (key(item) === name ? i : -1)).filter((i) => i >= 0);
        return [name, { n: at.length, recallAt5: round4(mean(at.map((i) => recallAtK(ranks[i] as number | null, 5)))), mrr: round4(mean(at.map((i) => reciprocalRank(ranks[i] as number | null)))) }];
      }),
    );
  };
  const lexicalArm = armReport(cases, lexicalHits, lexicalPoints, lexicalUnsent);
  const middle = DEPTHS.filter((depth) => depth >= 30 && depth <= 70).map((depth) => lexicalArm.byDepth[String(depth)]?.windowRecall ?? 0);
  const minMiddle = middle.length === 0 ? 0 : Math.min(...middle);
  return {
    kind: 'chunk-eval',
    status: 'NON-GATING',
    corpus: { version: CORPUS_VERSION, seed: CORPUS_SEED, sha256: digest, cases: cases.length },
    arms: {
      baseline: armReport(cases, baselineHits, baselinePoints, baselineUnsent),
      EL: {
        ...lexicalArm,
        retrieval: {
          recallAt1: recallAt(1),
          recallAt3: recallAt(3),
          recallAt5: recallAt(5),
          recallAt10: recallAt(10),
          mrr: round4(mean(ranks.map(reciprocalRank))),
          ndcgAt10: round4(mean(ndcgs)),
          byDepth: group(KEYS.byDepth),
          byLanguage: group(KEYS.byLanguage),
        },
      },
    },
    notRun: [...NOT_RUN_ARMS],
    gate: {
      id: 'CH1',
      ratified: false,
      proposal: CH1_PROPOSAL,
      verdict: 'NOT_RUN',
      note: 'CH1 thresholds are proposals, not ratified; the hybrid arm (EH) and the embedder arms E0-E3 are not run in slice C2 (Phase 0). No gate is declared passed or failed.',
      lexicalReference: { minRecallDepth30to70: minMiddle, meetsProposalBar: minMiddle >= 0.95, informationalOnly: true },
    },
    chunker: {
      byShape: Object.fromEntries(SHAPES.filter((shape) => accumulators.has(shape)).map((shape) => [shape, (accumulators.get(shape) as ChunkStatsAccumulator).stats()])),
      boundaryLevel: BOUNDARY_LEVEL_NOTE,
    },
    caseRows: rows,
  };
}

const pct = (value: number | undefined): string => (value === undefined ? '-' : `${(value * 100).toFixed(0)}%`);
const row = (strata: Strata | undefined): string => (strata === undefined ? '-' : Object.entries(strata).map(([name, s]) => `${name === '2097152' ? '2MiB' : name}=${pct(s.windowRecall)}`).join(' '));

/** Per-shape window recall (baseline / EL) with the EL breakdown by depth and length, and the C1 chunker statistics. */
function shapeLines(report: ChunkEvalReport): string[] {
  const out: string[] = ['by shape (window recall; EL by depth | by length | needle kind):'];
  for (const shape of Object.keys(report.arms.EL.byShape)) {
    const base = report.arms.baseline.byShape[shape];
    const el = report.arms.EL.byShape[shape];
    out.push(`  ${shape.padEnd(12)} n=${el?.n} base ${pct(base?.windowRecall)} EL ${pct(el?.windowRecall)} | depth ${row(report.arms.EL.byShapeDepth[shape])} | length ${row(report.arms.EL.byShapeLength[shape])} | kind ${row(report.arms.EL.byShapeNeedleKind[shape])}`);
  }
  out.push('chunker by shape (passages/case mean max; passage cp mean p95; windows/case mean; overCap; overlap share; kinds):');
  for (const [shape, c] of Object.entries(report.chunker.byShape)) {
    out.push(`  ${shape.padEnd(12)} ${c.passagesPerCase.mean} ${c.passagesPerCase.max}; ${c.passageCodePoints.mean} ${c.passageCodePoints.p95}; ${c.windowsPerCase.mean}; ${c.overCap}; ${pct(c.overlapShare)}; ${Object.entries(c.kinds).map(([k, n]) => `${k}:${n}`).join(' ')}`);
  }
  out.push('chunker boundary level column: skipped (not exposed by the chunker)');
  return out;
}

/** The short console summary. */
export function summaryLines(report: ChunkEvalReport): string[] {
  const line = (name: string, arm: ArmReport): string =>
    `${name.padEnd(9)} recall ${(arm.windowRecall * 100).toFixed(1)}%  ` + Object.entries(arm.byDepth).map(([depth, s]) => `d${depth}=${(s.windowRecall * 100).toFixed(0)}%`).join(' ') + `  (mean window ${arm.meanWindowCodePoints} cp, unsent ${arm.refusedOrEmpty})`;
  const r = report.arms.EL.retrieval;
  return [
    `eval:chunk CH1 (Phase 0, lexical arm only, no model) — ${report.corpus.cases} cases, corpus ${report.corpus.sha256}`,
    line('baseline', report.arms.baseline),
    line('EL', report.arms.EL),
    `EL retrieval: R@1 ${r.recallAt1} R@3 ${r.recallAt3} R@5 ${r.recallAt5} R@10 ${r.recallAt10} MRR ${r.mrr} nDCG@10 ${r.ndcgAt10}`,
    `by language (window recall): ` + (['ko', 'en', 'mixed'] as const).map((l) => `${l} base ${report.arms.baseline.byLanguage[l]?.windowRecall} / EL ${report.arms.EL.byLanguage[l]?.windowRecall}`).join('; '),
    ...shapeLines(report),
    `not run: ${report.notRun.join(', ')}`,
    `gate CH1: ${report.gate.verdict} (proposal, not ratified). EL min recall at depth 30-70 = ${report.gate.lexicalReference.minRecallDepth30to70} (informational; the proposal bar is for the hybrid arm)`,
    `status: NON-GATING`,
  ];
}
