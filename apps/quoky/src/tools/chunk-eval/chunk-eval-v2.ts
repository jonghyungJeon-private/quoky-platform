/**
 * ADR-0124 section 16: the run over the harder synthetic set v2 (phase 0: no model, no embedder, no network). It reuses the v1
 * run (`runChunkEval`: baseline clip and the lexical arm EL, the C1 chunker, BM25 with Core's settings) unchanged and adds what
 * v2 is for: window recall by feature tag and by shape x feature tag, exact miss counts by shape x needle kind, the chunker's
 * overlap use on long-paragraph cases, and the paired plain-text / Markdown result on the section-name Drive cases.
 */
import { lexicalWindow } from './arms';
import { ChunkStatsAccumulator, runChunkEval, type ChunkEvalReport, type ShapeChunkStats } from './chunk-eval';
import { pairedArm, type PairedArm } from './drive-format';
import { SHAPES, type Shape } from './corpus';
import { CORPUS_V2_SEED, CORPUS_V2_VERSION, FEATURE_TAGS, type ChunkEvalCaseV2, type FeatureTag } from './corpus-v2';
import { mean, recallAtK, reciprocalRank, round4 } from './metrics';

export interface FeatureStratum {
  readonly n: number;
  readonly hits: number;
  readonly misses: number;
  readonly windowRecall: number;
}
export interface ElFeatureStratum extends FeatureStratum {
  readonly recallAt1: number;
  readonly mrr: number;
}
export interface MissCell {
  readonly n: number;
  readonly misses: number;
}

export interface LongParagraphStats {
  readonly cases: number;
  /** Passages that intersect the long paragraph, per case. */
  readonly passagesInParagraph: { readonly mean: number; readonly max: number };
  /** Passages in the paragraph that carry an overlap, summed over the cases. */
  readonly overlapPassages: number;
  /** Cases whose needle lies inside an overlap span (so two passages hold it). */
  readonly needleInOverlap: number;
  /** Cases whose needle is held by more than one passage. */
  readonly needleInTwoPassages: number;
  readonly overCap: number;
}

export interface ChunkEvalV2Report extends Omit<ChunkEvalReport, 'kind' | 'corpus'> {
  readonly kind: 'chunk-eval-v2';
  readonly corpus: { readonly version: string; readonly seed: string; readonly sha256: string; readonly cases: number; readonly sectionNamePairs: number };
  readonly features: { readonly baseline: Readonly<Record<string, FeatureStratum>>; readonly EL: Readonly<Record<string, ElFeatureStratum>> };
  readonly byShapeFeature: { readonly baseline: Readonly<Record<string, Readonly<Record<string, FeatureStratum>>>>; readonly EL: Readonly<Record<string, Readonly<Record<string, ElFeatureStratum>>>> };
  readonly misses: {
    readonly baseline: Readonly<Record<string, Readonly<Record<string, MissCell>>>>;
    readonly EL: Readonly<Record<string, Readonly<Record<string, MissCell>>>>;
    readonly ELMissIds: readonly string[];
  };
  readonly chunkerLongParagraph: {
    readonly byShape: Readonly<Record<string, { readonly longParagraphCases: ShapeChunkStats | null; readonly otherCases: ShapeChunkStats | null; readonly inParagraph: LongParagraphStats | null }>>;
  };
  readonly sectionNameDrivePairs: {
    readonly pairs: number;
    readonly baseline: PairedArm;
    readonly EL: PairedArm;
    readonly ELRetrieval: { readonly recallAt1: { readonly text: number; readonly markdown: number }; readonly mrr: { readonly text: number; readonly markdown: number } };
  };
  readonly note: string;
}

function stratum(hits: readonly boolean[]): FeatureStratum {
  const count = hits.filter(Boolean).length;
  return { n: hits.length, hits: count, misses: hits.length - count, windowRecall: round4(hits.length === 0 ? 0 : count / hits.length) };
}

export function runChunkEvalV2(cases: readonly ChunkEvalCaseV2[], digest: string): ChunkEvalV2Report {
  const base = runChunkEval(cases, digest);
  const rows = base.caseRows;
  const baselineHits = rows.map((row) => row.baselineHit);
  const elHits = rows.map((row) => row.lexicalHit);
  const ranks = rows.map((row) => row.lexicalRank);
  const select = (predicate: (item: ChunkEvalCaseV2) => boolean): number[] => cases.map((item, at) => (predicate(item) ? at : -1)).filter((at) => at >= 0);
  const plain = (at: readonly number[], hits: readonly boolean[]): FeatureStratum => stratum(at.map((i) => hits[i] as boolean));
  const withRanks = (at: readonly number[]): ElFeatureStratum => ({
    ...plain(at, elHits),
    recallAt1: round4(mean(at.map((i) => recallAtK(ranks[i] ?? null, 1)))),
    mrr: round4(mean(at.map((i) => reciprocalRank(ranks[i] ?? null)))),
  });
  const keys: readonly (FeatureTag | 'all')[] = ['all', ...FEATURE_TAGS];
  const has = (item: ChunkEvalCaseV2, tag: FeatureTag | 'all'): boolean => tag === 'all' || item.tags.includes(tag);
  const features = {
    baseline: Object.fromEntries(keys.map((tag) => [tag, plain(select((item) => has(item, tag)), baselineHits)])),
    EL: Object.fromEntries(keys.map((tag) => [tag, withRanks(select((item) => has(item, tag)))])),
  };
  const byShapeFeature = {
    baseline: {} as Record<string, Record<string, FeatureStratum>>,
    EL: {} as Record<string, Record<string, ElFeatureStratum>>,
  };
  const missesBase: Record<string, Record<string, MissCell>> = {};
  const missesEl: Record<string, Record<string, MissCell>> = {};
  const accumulators = new Map<string, { lp: ChunkStatsAccumulator; other: ChunkStatsAccumulator; lpCases: number; otherCases: number }>();
  const inParagraph = new Map<string, { counts: number[]; overlap: number; inOverlap: number; inTwo: number; overCap: number }>();
  for (const shape of SHAPES) {
    const shapeAt = select((item) => item.shape === shape);
    if (shapeAt.length === 0) continue;
    byShapeFeature.baseline[shape] = {};
    byShapeFeature.EL[shape] = {};
    for (const tag of keys) {
      const at = shapeAt.filter((i) => has(cases[i] as ChunkEvalCaseV2, tag));
      if (at.length === 0) continue;
      (byShapeFeature.baseline[shape] as Record<string, FeatureStratum>)[tag] = plain(at, baselineHits);
      (byShapeFeature.EL[shape] as Record<string, ElFeatureStratum>)[tag] = withRanks(at);
    }
    const cells = (hits: readonly boolean[]): Record<string, MissCell> => {
      const out: Record<string, MissCell> = {};
      for (const kind of [...new Set(shapeAt.map((i) => (cases[i] as ChunkEvalCaseV2).needleKind))].sort()) {
        const at = shapeAt.filter((i) => (cases[i] as ChunkEvalCaseV2).needleKind === kind);
        out[kind] = { n: at.length, misses: at.filter((i) => !hits[i]).length };
      }
      return out;
    };
    missesBase[shape] = cells(baselineHits);
    missesEl[shape] = cells(elHits);
  }
  // chunker statistics split by long-paragraph cases, and the overlap use inside the paragraph itself
  for (const item of cases) {
    const entry = accumulators.get(item.shape) ?? { lp: new ChunkStatsAccumulator(), other: new ChunkStatsAccumulator(), lpCases: 0, otherCases: 0 };
    accumulators.set(item.shape, entry);
    const passages = lexicalWindow(item).passages;
    if (item.longParagraph === undefined) {
      entry.other.add(item.prepared, passages);
      entry.otherCases += 1;
      continue;
    }
    entry.lp.add(item.prepared, passages);
    entry.lpCases += 1;
    const span = item.longParagraph;
    const touching = passages.filter((passage) => passage.span.start < span.end && passage.span.end > span.start);
    const holders = passages.filter((passage) => passage.span.start < item.needle.end && passage.span.end > item.needle.start);
    const stat = inParagraph.get(item.shape) ?? { counts: [], overlap: 0, inOverlap: 0, inTwo: 0, overCap: 0 };
    inParagraph.set(item.shape, stat);
    stat.counts.push(touching.length);
    stat.overlap += touching.filter((passage) => passage.overlap !== undefined).length;
    stat.overCap += touching.filter((passage) => passage.overCap === true).length;
    if (passages.some((passage) => passage.overlap !== undefined && passage.overlap.start < item.needle.end && passage.overlap.end > item.needle.start)) stat.inOverlap += 1;
    if (holders.length > 1) stat.inTwo += 1;
  }
  const chunkerLongParagraph: ChunkEvalV2Report['chunkerLongParagraph'] = {
    byShape: Object.fromEntries(
      SHAPES.filter((shape) => accumulators.has(shape)).map((shape: Shape) => {
        const entry = accumulators.get(shape) as NonNullable<ReturnType<typeof accumulators.get>>;
        const stat = inParagraph.get(shape);
        return [
          shape,
          {
            longParagraphCases: entry.lpCases === 0 ? null : entry.lp.stats(),
            otherCases: entry.otherCases === 0 ? null : entry.other.stats(),
            inParagraph:
              stat === undefined
                ? null
                : {
                    cases: stat.counts.length,
                    passagesInParagraph: { mean: Math.round(mean(stat.counts) * 10) / 10, max: stat.counts.reduce((top, value) => Math.max(top, value), 0) },
                    overlapPassages: stat.overlap,
                    needleInOverlap: stat.inOverlap,
                    needleInTwoPassages: stat.inTwo,
                    overCap: stat.overCap,
                  },
          },
        ];
      }),
    ),
  };
  // the paired plain-text / Markdown result on the section-name Drive cases
  const texts = cases.map((item, at) => (item.format === 'text' ? at : -1)).filter((at) => at >= 0);
  const pairIndex = new Map(cases.map((item, at) => [item.id, at] as const));
  const marks = texts.map((at) => pairIndex.get(`${(cases[at] as ChunkEvalCaseV2).pairId}-markdown`) as number);
  const depths = texts.map((at) => (cases[at] as ChunkEvalCaseV2).depth);
  const pickRows = <T>(list: readonly T[], at: readonly number[]): T[] => at.map((i) => list[i] as T);
  const rankStat = (at: readonly number[]): { recallAt1: number; mrr: number } => ({ recallAt1: round4(mean(at.map((i) => recallAtK(ranks[i] ?? null, 1)))), mrr: round4(mean(at.map((i) => reciprocalRank(ranks[i] ?? null)))) });
  const textRank = rankStat(texts);
  const markRank = rankStat(marks);
  const { corpus: _corpus, kind: _kind, ...rest } = base;
  void _corpus;
  void _kind;
  return {
    ...rest,
    kind: 'chunk-eval-v2',
    corpus: { version: CORPUS_V2_VERSION, seed: CORPUS_V2_SEED, sha256: digest, cases: cases.length, sectionNamePairs: texts.length },
    features,
    byShapeFeature,
    misses: { baseline: missesBase, EL: missesEl, ELMissIds: rows.filter((row) => !row.lexicalHit).map((row) => row.id) },
    chunkerLongParagraph,
    sectionNameDrivePairs: {
      pairs: texts.length,
      baseline: pairedArm(pickRows(baselineHits, texts), pickRows(baselineHits, marks), depths),
      EL: pairedArm(pickRows(elHits, texts), pickRows(elHits, marks), depths),
      ELRetrieval: { recallAt1: { text: textRank.recallAt1, markdown: markRank.recallAt1 }, mrr: { text: textRank.mrr, markdown: markRank.mrr } },
    },
    note: 'Phase 0, lexical arm only, synthetic text, no model. Per-shape parameters and thresholds stay owner decisions; overCap counts a passage over the 1,200 cap (one unsplittable grapheme), which a long paragraph does not cause: a long paragraph shows as split passages with overlap.',
  };
}

const pct = (value: number | undefined): string => (value === undefined ? '-' : `${(value * 100).toFixed(0)}%`);
const cell = (s: FeatureStratum | undefined): string => (s === undefined ? '-' : `${s.hits}/${s.n}=${pct(s.windowRecall)}`);

/** The short console summary. */
export function summaryLinesV2(report: ChunkEvalV2Report): string[] {
  const out: string[] = [];
  const el = report.arms.EL;
  const base = report.arms.baseline;
  out.push(`eval:chunk v2 (Phase 0, lexical arm only, no model) — ${report.corpus.cases} cases (${report.corpus.sectionNamePairs} Drive section-name pairs), set ${report.corpus.sha256}`);
  out.push(`window recall: baseline ${(base.windowRecall * 100).toFixed(1)}%  EL ${(el.windowRecall * 100).toFixed(1)}%  (EL R@1 ${el.retrieval.recallAt1} R@5 ${el.retrieval.recallAt5} MRR ${el.retrieval.mrr})`);
  out.push('by feature (hits/n = window recall; baseline | EL | EL R@1 MRR):');
  for (const tag of ['all', ...FEATURE_TAGS]) out.push(`  ${tag.padEnd(15)} ${cell(report.features.baseline[tag])} | ${cell(report.features.EL[tag])} | ${report.features.EL[tag]?.recallAt1} ${report.features.EL[tag]?.mrr}`);
  out.push('by shape x feature (EL hits/n):');
  for (const shape of Object.keys(report.byShapeFeature.EL)) {
    const row = report.byShapeFeature.EL[shape] ?? {};
    out.push(`  ${shape.padEnd(12)} ` + Object.entries(row).map(([tag, s]) => `${tag}:${cell(s)}`).join(' '));
  }
  out.push('by shape x feature (baseline hits/n):');
  for (const shape of Object.keys(report.byShapeFeature.baseline)) {
    const row = report.byShapeFeature.baseline[shape] ?? {};
    out.push(`  ${shape.padEnd(12)} ` + Object.entries(row).map(([tag, s]) => `${tag}:${cell(s)}`).join(' '));
  }
  out.push('EL misses by shape x needle kind (misses/n):');
  for (const [shape, kinds] of Object.entries(report.misses.EL)) out.push(`  ${shape.padEnd(12)} ` + Object.entries(kinds).map(([kind, m]) => `${kind}:${m.misses}/${m.n}`).join(' '));
  out.push('baseline misses by shape x needle kind (misses/n):');
  for (const [shape, kinds] of Object.entries(report.misses.baseline)) out.push(`  ${shape.padEnd(12)} ` + Object.entries(kinds).map(([kind, m]) => `${kind}:${m.misses}/${m.n}`).join(' '));
  out.push('chunker, long-paragraph cases vs others (passages/case mean; overCap; overlap passages; overlap share):');
  for (const [shape, c] of Object.entries(report.chunkerLongParagraph.byShape)) {
    const f = (s: ShapeChunkStats | null): string => (s === null ? '-' : `${s.passagesPerCase.mean}; ${s.overCap}; ${s.overlapPassages}; ${pct(s.overlapShare)}`);
    const p = c.inParagraph;
    out.push(`  ${shape.padEnd(12)} lp[${f(c.longParagraphCases)}] other[${f(c.otherCases)}]` + (p === null ? '' : ` in-paragraph: ${p.passagesInParagraph.mean} passages/case (max ${p.passagesInParagraph.max}), overlap ${p.overlapPassages}, needle in overlap ${p.needleInOverlap}/${p.cases}, in 2 passages ${p.needleInTwoPassages}/${p.cases}`));
  }
  const pair = report.sectionNameDrivePairs;
  const arm = (name: string, p: PairedArm): string => `${name.padEnd(9)} text ${(p.recallText * 100).toFixed(1)}% -> markdown ${(p.recallMarkdown * 100).toFixed(1)}% (both ${p.bothHit}, text only ${p.onlyText}, markdown only ${p.onlyMarkdown}, neither ${p.neither})`;
  out.push(`Drive section-name pairs (${pair.pairs}):`, `  ${arm('baseline', pair.baseline)}`, `  ${arm('EL', pair.EL)}`, `  EL R@1 ${pair.ELRetrieval.recallAt1.text} -> ${pair.ELRetrieval.recallAt1.markdown}, MRR ${pair.ELRetrieval.mrr.text} -> ${pair.ELRetrieval.mrr.markdown}`);
  out.push('status: NON-GATING');
  return out;
}
