/**
 * ADR-0124 section 7 gate CH7 and the section 6 decision rule, phase 1.
 *
 * Per embedder arm over the frozen synthetic memory set: Recall@5 and MRR per language for the SINGLE-vector path (whole memory,
 * cut at 8,000 UTF-16 units, as today) and the MULTI-vector path (one vector per C1 passage, score = max cosine, ADR section 5),
 * and the same two on the long memories. The EL lexical arm (BM25 over the whole memory text) is the baseline.
 *
 * The decision rule (ratified 2026-11-05) is a pure function of the measured numbers: `decideEmbedder`. Its Korean and English
 * inputs are the MULTI-vector Recall@5 (the path section 5 proposes); the single-vector numbers are reported beside them.
 */
import { chunking } from '@quoky/core';
import { firstRelevantRank, mean, recallAtK, reciprocalRank, round4 } from './metrics';
import { LANGUAGES } from './corpus';
import {
  ARM_SPECS,
  ArmEmbedder,
  LATENCY_BUDGET_MS,
  costOf,
  cosineScores,
  fitOf,
  measureLatency,
  rankByScores,
  type ArmId,
  type CostReport,
  type EmbedItem,
  type FitReport,
  type LatencyBlock,
} from './embed-arms';
import { MEMORY_SEED, MEMORY_VERSION, singleVectorText, type MemorySet } from './memory-set';

export interface MemMetrics {
  readonly n: number;
  readonly recallAt5: number;
  readonly mrr: number;
}
export interface PathMetrics {
  readonly overall: MemMetrics;
  readonly byLanguage: Readonly<Record<string, MemMetrics>>;
  readonly longMemories: MemMetrics;
  readonly shortMemories: MemMetrics;
  /** Queries whose gold fact starts after the 8,000-unit cut. */
  readonly beyondCut: MemMetrics;
}

function memMetrics(ranks: readonly (number | null)[]): MemMetrics {
  return { n: ranks.length, recallAt5: round4(mean(ranks.map((rank) => recallAtK(rank, 5)))), mrr: round4(mean(ranks.map(reciprocalRank))) };
}

/** Metrics of one scoring path, from the 1-based gold rank of every query (same order as `set.queries`). */
export function pathMetrics(set: MemorySet, ranks: readonly (number | null)[]): PathMetrics {
  const pick = (predicate: (at: number) => boolean): (number | null)[] => ranks.filter((_, at) => predicate(at));
  const byLanguage: Record<string, MemMetrics> = {};
  for (const language of LANGUAGES) byLanguage[language] = memMetrics(pick((at) => set.queries[at]?.language === language));
  return {
    overall: memMetrics(ranks),
    byLanguage,
    longMemories: memMetrics(pick((at) => set.queries[at]?.targetLong === true)),
    shortMemories: memMetrics(pick((at) => set.queries[at]?.targetLong === false)),
    beyondCut: memMetrics(pick((at) => set.queries[at]?.beyondCut === true)),
  };
}

/** The first gold memory's rank in a ranking of memory indexes. */
function goldRank(set: MemorySet, ranking: readonly number[], gold: readonly string[]): number | null {
  const relevant = new Set(set.memories.map((memory, at) => (gold.includes(memory.id) ? at : -1)).filter((at) => at >= 0));
  return firstRelevantRank(ranking, relevant);
}

export function lexicalMemoryMetrics(set: MemorySet): PathMetrics {
  const index = new chunking.Bm25Index(set.memories.map((memory) => memory.text));
  return pathMetrics(set, set.queries.map((query) => goldRank(set, index.rank(query.text), query.gold)));
}

const memoryPassageTexts = (text: string): string[] => {
  const index = new chunking.CodePointIndex(text);
  return chunking.chunk(text).map((passage) => index.slice(passage.span.start, passage.span.end));
};

/** What an arm embeds for the memory set: every query, every cut whole memory, every C1 passage of every memory. */
export function memoryItems(set: MemorySet): { queries: EmbedItem[]; singles: EmbedItem[]; passages: EmbedItem[] } {
  return {
    queries: set.queries.map((query) => ({ text: query.text, language: query.language })),
    singles: set.memories.map((memory) => ({ text: singleVectorText(memory.text), language: memory.language })),
    passages: set.memories.flatMap((memory) => memoryPassageTexts(memory.text).map((text) => ({ text, language: memory.language }))),
  };
}

export interface MemoryArmRun {
  readonly pin: { readonly model: string; readonly digest12: string; readonly ollamaVersion: string; readonly spaceId: string; readonly queryPrefix: string; readonly documentPrefix: string };
  readonly single: PathMetrics;
  readonly multi: PathMetrics;
  /** Multi-vector Recall@5 minus single-vector Recall@5 on the long memories, in percentage points (CH7 proposal: >= +10; not ratified). */
  readonly multiMinusSinglePointsOnLong: number;
  readonly fit: FitReport & { readonly singleOverContext: number; readonly passageOverContext: number };
  readonly cost: CostReport;
  readonly latency: LatencyBlock | null;
}

export async function runMemoryArm(embedder: ArmEmbedder, set: MemorySet, latency?: { sample: readonly EmbedItem[]; query: EmbedItem }): Promise<MemoryArmRun> {
  const items = memoryItems(set);
  const queryVectors = await embedder.embed('query', items.queries);
  const singleVectors = await embedder.embed('document', items.singles);
  const passageVectors = await embedder.embed('document', items.passages);
  const passagesOf = set.memories.map((memory) => memoryPassageTexts(memory.text));
  const singleRanks: (number | null)[] = [];
  const multiRanks: (number | null)[] = [];
  for (const query of set.queries) {
    const q = queryVectors.get(query.text) ?? null;
    const single = cosineScores(q, set.memories.map((memory) => singleVectors.get(singleVectorText(memory.text)) ?? null));
    const multi = passagesOf.map((texts) => Math.max(Number.NEGATIVE_INFINITY, ...cosineScores(q, texts.map((text) => passageVectors.get(text) ?? null))));
    singleRanks.push(goldRank(set, rankByScores(single), query.gold));
    multiRanks.push(goldRank(set, rankByScores(multi), query.gold));
  }
  const single = pathMetrics(set, singleRanks);
  const multi = pathMetrics(set, multiRanks);
  const fit = fitOf(embedder);
  const singleOverContext = items.singles.filter((item) => singleVectors.get(item.text) === null).length;
  const passageOverContext = new Set(items.passages.filter((item) => passageVectors.get(item.text) === null).map((item) => item.text)).size;
  const resident = await embedder.residentMemory();
  const cost = costOf(embedder, resident);
  // the latency block runs last, cache bypassed, so its calls do not enter the cost and fit figures above
  const block = latency === undefined ? null : await measureLatency(embedder, latency.query, latency.sample, true);
  return {
    pin: { model: embedder.pin.model, digest12: embedder.pin.digest12, ollamaVersion: embedder.pin.ollamaVersion, spaceId: embedder.pin.spaceId, queryPrefix: embedder.pin.queryPrefix, documentPrefix: embedder.pin.documentPrefix },
    single,
    multi,
    multiMinusSinglePointsOnLong: Math.round((multi.longMemories.recallAt5 - single.longMemories.recallAt5) * 10_000) / 100,
    fit: { ...fit, singleOverContext, passageOverContext },
    cost,
    latency: block,
  };
}

// ---------------------------------------------------------------- decision rule (ratified 2026-11-05, ADR-0124 section 6)

export interface ArmDecisionInput {
  readonly arm: ArmId;
  readonly koRecallAt5: number;
  readonly enRecallAt5: number;
  /** Measured: 1 query + 200 passage embeddings, warm. */
  readonly time200Ms: number;
  readonly nominalParamsM: number;
}
export interface Verdict {
  readonly verdict: 'INCOMPLETE' | 'KEEP_E0' | 'CHOOSE';
  readonly chosen: ArmId | null;
  readonly text: string;
  readonly reasons: readonly string[];
  readonly rule: string;
  readonly inputs: readonly (ArmDecisionInput & { readonly latencyOk: boolean; readonly englishWithin2Points: boolean })[];
}

export const DECISION_RULE =
  'Among the arms that meet the latency bar (1 query + 200 passage embeddings within the 8 s embedding sub-budget, warm), choose the highest Korean Recall@5 on CH7, provided it is not more than 2 percentage points worse than E0 on English; a tie goes to the smaller model; if no arm beats E0 on Korean by at least 5 points, keep E0. No arm is chosen until all planned arms ran.';

const bp = (value: number): number => Math.round(value * 10_000);

/** Pure: the section 6 verdict from the measured numbers. Percentage-point comparisons are done in basis points (no float drift). */
export function decideEmbedder(planned: readonly ArmId[], inputs: readonly ArmDecisionInput[], budgetMs: number = LATENCY_BUDGET_MS): Verdict {
  const ran = new Set(inputs.map((input) => input.arm));
  const missing = planned.filter((arm) => !ran.has(arm));
  const e0 = inputs.find((input) => input.arm === 'E0');
  const annotated = inputs.map((input) => ({
    ...input,
    latencyOk: input.time200Ms <= budgetMs,
    englishWithin2Points: e0 !== undefined && bp(e0.enRecallAt5) - bp(input.enRecallAt5) <= 200,
  }));
  if (missing.length > 0 || e0 === undefined) {
    const why = e0 === undefined && missing.length === 0 ? 'E0 was not planned, so there is nothing to compare against' : `missing: ${missing.join(', ')}`;
    return { verdict: 'INCOMPLETE', chosen: null, text: `no arm is chosen until all planned arms ran (${why})`, reasons: [why], rule: DECISION_RULE, inputs: annotated };
  }
  const reasons = annotated.map(
    (input) =>
      `${input.arm}: ko R@5 ${input.koRecallAt5} (${(bp(input.koRecallAt5) - bp(e0.koRecallAt5)) / 100} points vs E0), en R@5 ${input.enRecallAt5} (${(bp(input.enRecallAt5) - bp(e0.enRecallAt5)) / 100} points vs E0), time for 200 passages + 1 query ${input.time200Ms} ms ${input.latencyOk ? 'within' : 'over'} ${budgetMs} ms`,
  );
  const candidates = annotated.filter((input) => input.latencyOk && input.englishWithin2Points);
  const order = (a: ArmDecisionInput, b: ArmDecisionInput): number => bp(b.koRecallAt5) - bp(a.koRecallAt5) || a.nominalParamsM - b.nominalParamsM || a.arm.localeCompare(b.arm);
  const winner = [...candidates].sort(order)[0];
  const e0Model = ARM_SPECS.E0.model;
  if (winner === undefined || winner.arm === 'E0' || bp(winner.koRecallAt5) - bp(e0.koRecallAt5) < 500) {
    const best = winner === undefined ? 'no arm met the latency bar and the English bound' : `the best eligible arm is ${winner.arm}`;
    return { verdict: 'KEEP_E0', chosen: 'E0', text: `keep E0 (${e0Model}): no arm beats E0 on Korean Recall@5 by at least 5 points (${best})`, reasons, rule: DECISION_RULE, inputs: annotated };
  }
  return { verdict: 'CHOOSE', chosen: winner.arm, text: `choose ${winner.arm} (${ARM_SPECS[winner.arm].model}): Korean Recall@5 ${winner.koRecallAt5} vs E0 ${e0.koRecallAt5}`, reasons, rule: DECISION_RULE, inputs: annotated };
}

// ---------------------------------------------------------------- report

export interface ChunkEvalMemoryReport {
  readonly kind: 'chunk-eval-memory';
  readonly status: 'NON-GATING';
  readonly set: { readonly version: string; readonly seed: string; readonly sha256: string; readonly memories: number; readonly long: number; readonly queries: number; readonly queriesWithNoSharedWord: number };
  readonly plan: { readonly digest: string | null; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly EL: PathMetrics;
  readonly arms: Readonly<Record<string, MemoryArmRun>>;
  readonly verdict: Verdict | null;
  readonly gate: { readonly id: 'CH7'; readonly ratified: false; readonly proposal: string; readonly verdict: 'NOT_RUN'; readonly note: string };
  readonly note: string;
}

export const CH7_PROPOSAL = 'Section 6 decision rule; multi-vector Recall@5 on long memories >= single-vector + 10 points (ADR-0124 section 7, proposal)';

export function buildMemoryReport(
  set: MemorySet,
  digest: string,
  runs: Readonly<Record<string, MemoryArmRun>>,
  plan: ChunkEvalMemoryReport['plan'],
  embedderRequested: boolean,
): ChunkEvalMemoryReport {
  const inputs: ArmDecisionInput[] = Object.entries(runs).map(([arm, run]) => ({
    arm: arm as ArmId,
    koRecallAt5: run.multi.byLanguage.ko?.recallAt5 ?? 0,
    enRecallAt5: run.multi.byLanguage.en?.recallAt5 ?? 0,
    time200Ms: run.latency?.time200Ms ?? Number.POSITIVE_INFINITY,
    nominalParamsM: ARM_SPECS[arm as ArmId].nominalParamsM,
  }));
  return {
    kind: 'chunk-eval-memory',
    status: 'NON-GATING',
    set: {
      version: MEMORY_VERSION,
      seed: MEMORY_SEED,
      sha256: digest,
      memories: set.memories.length,
      long: set.memories.filter((memory) => memory.long).length,
      queries: set.queries.length,
      queriesWithNoSharedWord: set.queries.filter((query) => query.sharedTerms === 0).length,
    },
    plan,
    EL: lexicalMemoryMetrics(set),
    arms: runs,
    verdict: embedderRequested ? decideEmbedder(plan.planned as ArmId[], inputs) : null,
    gate: { id: 'CH7', ratified: false, proposal: CH7_PROPOSAL, verdict: 'NOT_RUN', note: 'CH7 thresholds are proposals, not ratified; the verdict line applies the ratified section 6 decision rule to the measured numbers and does not declare a gate passed.' },
    note: 'Synthetic fictional memories only. Decision inputs are the multi-vector Recall@5 per language (ko, en); a missing latency block counts as over the bar.',
  };
}

export function summaryLinesMemory(report: ChunkEvalMemoryReport): string[] {
  const m = (x: MemMetrics | undefined): string => (x === undefined ? '-' : `R@5 ${x.recallAt5} MRR ${x.mrr} (n=${x.n})`);
  const out = [`eval:chunk CH7 memory set — ${report.set.memories} memories (${report.set.long} long), ${report.set.queries} queries (${report.set.queriesWithNoSharedWord} with no shared word), set ${report.set.sha256}`];
  const path = (name: string, p: PathMetrics): string => `${name.padEnd(10)} ${m(p.overall)} | ko ${m(p.byLanguage.ko)} | en ${m(p.byLanguage.en)} | mixed ${m(p.byLanguage.mixed)} | long ${m(p.longMemories)}`;
  out.push(path('EL', report.EL));
  for (const [id, run] of Object.entries(report.arms)) {
    out.push(path(`${id} single`, run.single), path(`${id} multi`, run.multi));
    out.push(`  ${id}: multi minus single on long memories ${run.multiMinusSinglePointsOnLong} points; overContext single ${run.fit.singleOverContext} passages ${run.fit.passageOverContext}; time for 200 passages + 1 query ${run.latency === null ? 'n/a' : `${run.latency.time200Ms} ms`}`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped (not installed): ${report.plan.dropped.map((d) => d.arm).join(', ')}`);
  if (report.verdict !== null) out.push(`verdict: ${report.verdict.text}`);
  out.push('status: NON-GATING');
  return out;
}
