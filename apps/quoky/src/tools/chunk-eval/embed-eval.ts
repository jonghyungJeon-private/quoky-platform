/**
 * ADR-0124 phase 1: the CH1 passage-set run for the embedder arms E0-E3 and the hybrid EH(x) (set v1 or v2). Pure over the
 * cases plus an embedder per arm; a test drives it with a fake fetch. Thresholds stay PROPOSALS: the report is NON-GATING.
 *
 * Per arm and case: the query vector (query role), the passage vectors (document role), cosine ranking (ties by ordinal),
 * the window = the EL arm's greedy one-window packing over that ranking, and EH(x) = reciprocal rank fusion (k = 60) of the
 * arm's ranking and the EL BM25 full ranking (no extra embedding).
 */
import { relevantPassages, windowHasNeedle } from './arms';
import { firstRelevantRank, mean, ndcgAtK, recallAtK, reciprocalRank, round4 } from './metrics';
import { DEPTHS, SHAPES, type ChunkEvalCase } from './corpus';
import { FEATURE_TAGS, type ChunkEvalCaseV2 } from './corpus-v2';
import {
  ArmEmbedder,
  RRF_K,
  costOf,
  cosineScores,
  fitOf,
  inScope,
  itemsFor,
  packRankedWindow,
  rankByScores,
  rrfFuse,
  type ArmId,
  type CaseBundle,
  type CostReport,
  type EvalSet,
  type FitReport,
  type Scope,
} from './embed-arms';

export interface MetricRow {
  readonly n: number;
  readonly recallAt1: number;
  readonly recallAt3: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly windowRecall: number;
}
export type MetricMap = Readonly<Record<string, MetricRow>>;

export interface CaseScore {
  readonly item: ChunkEvalCase;
  readonly rank: number | null;
  readonly ndcg: number;
  readonly windowHit: boolean;
}

export function metricRow(scores: readonly CaseScore[]): MetricRow {
  const at = (k: number): number => round4(mean(scores.map((s) => recallAtK(s.rank, k))));
  return {
    n: scores.length,
    recallAt1: at(1),
    recallAt3: at(3),
    recallAt5: at(5),
    recallAt10: at(10),
    mrr: round4(mean(scores.map((s) => reciprocalRank(s.rank)))),
    ndcgAt10: round4(mean(scores.map((s) => s.ndcg))),
    windowRecall: round4(mean(scores.map((s) => (s.windowHit ? 1 : 0)))),
  };
}

export function groupMetrics(scores: readonly CaseScore[], key: (score: CaseScore) => string): MetricMap {
  const groups = new Map<string, CaseScore[]>();
  for (const score of scores) groups.set(key(score), [...(groups.get(key(score)) ?? []), score]);
  return Object.fromEntries([...groups.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((name) => [name, metricRow(groups.get(name) as CaseScore[])]));
}

const tagsOf = (item: ChunkEvalCase): readonly string[] => ((item as Partial<ChunkEvalCaseV2>).tags as readonly string[] | undefined) ?? [];

export interface Strata {
  readonly overall: MetricRow;
  readonly byLanguage: MetricMap;
  readonly byNeedleKind: MetricMap;
  readonly byShape: MetricMap;
  readonly byDepth: MetricMap;
  readonly byLength: MetricMap;
  /** v2 only: by feature tag, and shape x feature tag (a case counts in every tag it carries). */
  readonly byFeature?: MetricMap;
  readonly byShapeFeature?: Readonly<Record<string, MetricMap>>;
}

export function strataOf(set: EvalSet, scores: readonly CaseScore[]): Strata {
  const base = {
    overall: metricRow(scores),
    byLanguage: groupMetrics(scores, (s) => s.item.language),
    byNeedleKind: groupMetrics(scores, (s) => s.item.needleKind),
    byShape: groupMetrics(scores, (s) => s.item.shape),
    byDepth: groupMetrics(scores, (s) => String(s.item.depth)),
    byLength: groupMetrics(scores, (s) => (s.item.length === 2_097_152 ? '2MiB' : String(s.item.length))),
  };
  if (set === 'v1') return base;
  const withTag = (tag: string): CaseScore[] => scores.filter((s) => tag === 'all' || tagsOf(s.item).includes(tag));
  const byFeature: Record<string, MetricRow> = {};
  for (const tag of ['all', ...FEATURE_TAGS]) if (withTag(tag).length > 0) byFeature[tag] = metricRow(withTag(tag));
  const byShapeFeature: Record<string, MetricMap> = {};
  for (const shape of SHAPES) {
    const inShape = scores.filter((s) => s.item.shape === shape);
    if (inShape.length === 0) continue;
    const row: Record<string, MetricRow> = {};
    for (const tag of ['all', ...FEATURE_TAGS]) {
      const list = inShape.filter((s) => tag === 'all' || tagsOf(s.item).includes(tag));
      if (list.length > 0) row[tag] = metricRow(list);
    }
    byShapeFeature[shape] = row;
  }
  return { ...base, byFeature, byShapeFeature };
}

export interface EmbedderRun {
  readonly pin: { readonly model: string; readonly digest12: string; readonly ollamaVersion: string; readonly spaceId: string; readonly queryPrefix: string; readonly documentPrefix: string };
  readonly cases: number;
  readonly shapes: readonly string[];
  /** The EL lexical arm on exactly the cases this embedder ran. */
  readonly EL: Strata;
  readonly embedder: Strata;
  readonly hybrid: Strata;
  readonly fit: FitReport;
  readonly cost: CostReport;
  readonly otherModelsResidentBefore: readonly string[];
}
export interface ChunkEmbedReport {
  readonly kind: 'chunk-eval-embed';
  readonly status: 'NON-GATING';
  readonly set: EvalSet;
  readonly corpus: { readonly version: string; readonly seed: string; readonly sha256: string; readonly cases: number };
  readonly plan: { readonly digest: string; readonly scope: Scope; readonly shapes: readonly string[] | null; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly parameters: { readonly batch: number; readonly concurrency: 1; readonly truncate: false; readonly rrfK: number; readonly window: string };
  readonly arms: Readonly<Record<string, EmbedderRun>>;
  readonly note: string;
}

export const PARAMETERS = { batch: 16, concurrency: 1 as const, truncate: false as const, rrfK: RRF_K, window: 'EL greedy one-window packing (3,000 code points / 1,800 estimated tokens), over the arm ranking' };

function scoreCase(bundle: CaseBundle, ranking: readonly number[], window: ReturnType<typeof packRankedWindow>): CaseScore {
  const relevant = relevantPassages(bundle.lexical.passages, bundle.item.needle.start, bundle.item.needle.end);
  return { item: bundle.item, rank: firstRelevantRank(ranking, relevant), ndcg: ndcgAtK(ranking, relevant, 10), windowHit: windowHasNeedle(window, bundle.item) };
}

export interface RunOptions {
  readonly set: EvalSet;
  readonly bundles: readonly CaseBundle[];
  readonly scope: Scope;
  readonly shapes?: readonly string[];
}

/** Runs one arm over the set's in-scope cases. The arm's embeddings come from `embedder.embed` (cache first, then the daemon). */
export async function runArmOnSet(embedder: ArmEmbedder, options: RunOptions): Promise<EmbedderRun> {
  const arm = embedder.pin.arm as ArmId;
  const bundles = options.bundles.filter((bundle) => inScope(options.scope, options.shapes, options.set, arm, bundle.item));
  const otherModelsResidentBefore = await embedder.otherResident();
  const { queries, passages } = itemsFor(bundles);
  const queryVectors = await embedder.embed('query', queries);
  const passageVectors = await embedder.embed('document', passages);
  const lexical: CaseScore[] = [];
  const dense: CaseScore[] = [];
  const hybrid: CaseScore[] = [];
  for (const bundle of bundles) {
    const query = queryVectors.get(bundle.item.question) ?? null;
    const ranking = rankByScores(cosineScores(query, bundle.texts.map((text) => passageVectors.get(text) ?? null)));
    const fused = rrfFuse([ranking, bundle.lexical.ranking], RRF_K);
    lexical.push(scoreCase(bundle, bundle.lexical.ranking, bundle.lexical.window));
    dense.push(scoreCase(bundle, ranking, packRankedWindow(bundle.item, bundle.lexical.passages, ranking)));
    hybrid.push(scoreCase(bundle, fused, packRankedWindow(bundle.item, bundle.lexical.passages, fused)));
  }
  const resident = await embedder.residentMemory();
  const shapes = [...new Set(bundles.map((bundle) => bundle.item.shape))];
  return {
    pin: { model: embedder.pin.model, digest12: embedder.pin.digest12, ollamaVersion: embedder.pin.ollamaVersion, spaceId: embedder.pin.spaceId, queryPrefix: embedder.pin.queryPrefix, documentPrefix: embedder.pin.documentPrefix },
    cases: bundles.length,
    shapes,
    EL: strataOf(options.set, lexical),
    embedder: strataOf(options.set, dense),
    hybrid: strataOf(options.set, hybrid),
    fit: fitOf(embedder),
    cost: costOf(embedder, resident),
    otherModelsResidentBefore,
  };
}

const pct = (value: number | undefined): string => (value === undefined ? '-' : `${(value * 100).toFixed(1)}%`);
const rowLine = (name: string, row: MetricRow): string =>
  `${name.padEnd(8)} n=${row.n} R@1 ${row.recallAt1} R@3 ${row.recallAt3} R@5 ${row.recallAt5} R@10 ${row.recallAt10} MRR ${row.mrr} nDCG@10 ${row.ndcgAt10} window ${pct(row.windowRecall)}`;

export function summaryLinesEmbed(report: ChunkEmbedReport): string[] {
  const out = [`eval:chunk CH1 embedder arms (${report.set}) — corpus ${report.corpus.sha256}, plan ${report.plan.digest}`];
  for (const [id, run] of Object.entries(report.arms)) {
    out.push(`${id} ${run.pin.model}@${run.pin.digest12} ollama${run.pin.ollamaVersion} (${run.cases} cases; shapes ${run.shapes.join(',')})`);
    out.push(`  ${rowLine('EL', run.EL.overall)}`, `  ${rowLine(id, run.embedder.overall)}`, `  ${rowLine(`EH(${id})`, run.hybrid.overall)}`);
    const byLanguage = Object.keys(run.embedder.byLanguage).map((language) => `${language} ${id} R@5 ${run.embedder.byLanguage[language]?.recallAt5} / EH ${run.hybrid.byLanguage[language]?.recallAt5} / EL ${run.EL.byLanguage[language]?.recallAt5}`);
    out.push(`  by language: ${byLanguage.join('; ')}`);
    out.push(`  depth window recall (${id} | EH): ${DEPTHS.map((depth) => `d${depth}=${pct(run.embedder.byDepth[String(depth)]?.windowRecall)}|${pct(run.hybrid.byDepth[String(depth)]?.windowRecall)}`).join(' ')}`);
    out.push(`  fit: overContext ${run.fit.overContext}; ${Object.entries(run.fit.byLanguage).map(([language, f]) => `${language} tok/syl ${f.tokensPerHangulSyllable ?? '-'} tok/cp ${f.tokensPerCodePoint ?? '-'}`).join('; ')}`);
    out.push(`  cost: calls ${run.cost.calls}, first ${run.cost.firstCallMs} ms, warm p50 ${run.cost.warmCallMs.p50} p95 ${run.cost.warmCallMs.p95} ms, resident ${run.cost.resident === null ? 'n/a' : `${Math.round(run.cost.resident.sizeBytes / 1_048_576)} MiB`}`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped (not installed): ${report.plan.dropped.map((d) => d.arm).join(', ')}`);
  out.push('status: NON-GATING');
  return out;
}
