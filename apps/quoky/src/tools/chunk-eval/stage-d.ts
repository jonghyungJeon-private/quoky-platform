/**
 * ADR-0124 phase 1 stage D (owner decisions 2026-11-06), CH7 memory set only: the rerank arms R(Ex), the memory-path latency bar,
 * the stage D plan v2 and digest, the stage D decision and report. The v1 / v2 runs, the stage A-C plan (v1) and the connector
 * path latency bar (1 query + 200 passages within 8 s) are unchanged and not used by any rerank arm.
 */
import { createHash } from 'node:crypto';
import { percentiles } from '../selector-rag/embed';
import { LANGUAGES } from './corpus';
import {
  ARM_IDS,
  ARM_SPECS,
  ArmEmbedder,
  KEEP_ALIVE,
  cosineScores,
  rankByScores,
  resolveArms,
  type ArmId,
  type EmbedItem,
  type PlanCount,
  type ResolvedArms,
} from './embed-arms';
import { PLAN_PARAMETERS, pinKey } from './embed-plan';
import {
  ENGLISH_TOLERANCE_BP,
  KOREAN_GAIN_BP,
  goldRank,
  lexicalMemoryMetrics,
  memoryItems,
  memoryPassageTexts,
  pathMetrics,
  runMemoryArm,
  smallestOf,
  type MemMetrics,
  type MemoryArmRun,
  type PathMetrics,
} from './memory-eval';
import { MEMORY_SEED, MEMORY_VERSION, type MemoryQuery, type MemorySet } from './memory-set';
import { recallAtK, mean, round4 } from './metrics';
import {
  CANDIDATE_CAP_UNITS,
  RERANK_DIGEST12,
  RERANK_FORMAT,
  RERANK_MODEL,
  RERANK_NUM_PREDICT,
  RERANK_PROMPT_SHA,
  RERANK_SEED,
  RERANK_TOP_N,
  pinReranker,
  type Candidate,
  type LlmReranker,
  type RerankerPin,
} from './rerank-arm';
import { ModelNotInstalledError, type FetchLike } from '../selector-rag/embed';

export const STAGE_D_PLAN_VERSION = 'chunk-embed-plan.v2';
/** Memory path: memories are embedded at write time, so only a warm single query embed is on the user's clock. */
export const MEMORY_QUERY_BAR_MS = 1_000;
export const MEMORY_LATENCY_QUERIES = 50;
export const PROBE_RERANK_QUERIES = 20;
export const SAMPLE_SEED = 'quoky-adr-0124-stage-d-2026-11-06';
/** The owner's informational target (not a gate): Recall@5 of at least 95%. */
export const TARGET_BP = 9_500;

export type RerankArmId = `R(${ArmId})`;
export type StageDArmId = ArmId | RerankArmId;

export function parseStageDArm(token: string): StageDArmId | undefined {
  if ((ARM_IDS as readonly string[]).includes(token)) return token as ArmId;
  const match = /^R\((E[0-3])\)$/u.exec(token);
  return match === null ? undefined : (`R(${match[1] as ArmId})` as RerankArmId);
}
export const isRerankArm = (arm: string): arm is RerankArmId => /^R\(E[0-3]\)$/u.test(arm);
export const baseOf = (arm: RerankArmId): ArmId => arm.slice(2, 4) as ArmId;

/** E0 is always planned (the decision rule compares against it); then the other embedders in arm order; then the rerank arms in the given order. */
export function stageDPlanned(requested: readonly StageDArmId[]): { planned: StageDArmId[]; embedderIds: ArmId[]; rerankArms: RerankArmId[] } {
  const rerankArms = [...new Set(requested.filter(isRerankArm))];
  const wanted = new Set<ArmId>(['E0', ...requested.filter((arm): arm is ArmId => !isRerankArm(arm)), ...rerankArms.map(baseOf)]);
  const embedderIds = ARM_IDS.filter((arm) => wanted.has(arm));
  const planned: StageDArmId[] = [...ARM_IDS.filter((arm) => requested.includes(arm) || arm === 'E0'), ...rerankArms];
  return { planned, embedderIds, rerankArms };
}

// ---------------------------------------------------------------- selection

/** A fixed, seeded pick of `size` queries: ordered by sha256(seed | label | id). Stable for a given set. */
export function sampleQueries(queries: readonly MemoryQuery[], size: number, label: string): MemoryQuery[] {
  const key = (query: MemoryQuery): string => createHash('sha256').update(`${SAMPLE_SEED}|${label}|${query.id}`).digest('hex');
  return [...queries].sort((a, b) => key(a).localeCompare(key(b))).slice(0, size);
}
export const selectionSha = (queries: readonly MemoryQuery[]): string => createHash('sha256').update(JSON.stringify(queries.map((query) => query.id))).digest('hex');

// ---------------------------------------------------------------- plan v2

export const STAGE_D_PARAMETERS = {
  base: PLAN_PARAMETERS,
  rerank: {
    model: RERANK_MODEL,
    ratifiedDigest12: RERANK_DIGEST12,
    topN: RERANK_TOP_N,
    candidateCapUnits: CANDIDATE_CAP_UNITS,
    candidateText: 'a long memory: the passage the first-stage multi-vector scoring matched best; otherwise the memory text; whitespace collapsed, cut at the cap',
    promptSha256: RERANK_PROMPT_SHA,
    seed: RERANK_SEED,
    temperature: 0,
    think: false,
    format: RERANK_FORMAT,
    keepAlive: KEEP_ALIVE,
    numPredict: RERANK_NUM_PREDICT,
    firstStage: 'multi-vector Recall (one vector per C1 passage, score = max cosine)',
    rest: 'memories after the top N keep their first-stage order',
  },
  memoryLatency: {
    barMs: MEMORY_QUERY_BAR_MS,
    eligibility: 'p95 of a warm single query embed over the sample, cache bypassed',
    sampleQueries: MEMORY_LATENCY_QUERIES,
    warmups: 1,
    selection: 'sha256 order of seed | label | query id',
    seed: SAMPLE_SEED,
    connectorPathInformation: 'the 1 query + 200 passage block still runs and is reported; it gates nothing on the memory path',
  },
  probe: { rerankQueries: PROBE_RERANK_QUERIES, cacheBypassed: true },
  decision: { englishToleranceBp: ENGLISH_TOLERANCE_BP, koreanGainBp: KOREAN_GAIN_BP, input: 'multi-vector Recall@5 (embedder arms) or reranked Recall@5 (R arms) per language on CH7', targetBp: TARGET_BP, targetIsGate: false, rerankLatencyIsGate: false, rTieSize: 'embedder plus reranker parameters' },
} as const;

export interface StageDInputs {
  readonly sets: { readonly memory: { readonly digest: string }; readonly v2: { readonly digest: string } };
  readonly planned: readonly StageDArmId[];
  readonly resolved: ResolvedArms;
  readonly reranker: RerankerPin | null;
  readonly dropped: readonly { readonly arm: string; readonly reason: string }[];
}

export function stageDDigest(input: StageDInputs, parameters: unknown = STAGE_D_PARAMETERS): string {
  const body = {
    version: STAGE_D_PLAN_VERSION,
    stage: 'D',
    sets: input.sets,
    planned: input.planned,
    arms: input.resolved.available.map(pinKey),
    reranker: input.reranker,
    dropped: input.dropped.map((d) => d.arm),
    parameters,
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** Pins the embedders and (when a rerank arm is planned) the reranker; rerank arms whose base or reranker is not available are dropped with a note. */
export async function resolveStageD(requested: readonly StageDArmId[], baseUrl?: string, fetchImpl?: FetchLike): Promise<{ planned: StageDArmId[]; resolved: ResolvedArms; reranker: RerankerPin | null; dropped: { arm: string; reason: string }[]; rerankArms: RerankArmId[] }> {
  const { planned, embedderIds, rerankArms } = stageDPlanned(requested);
  const resolved = await resolveArms(embedderIds, baseUrl, fetchImpl);
  let reranker: RerankerPin | null = null;
  let rerankerReason = '';
  if (rerankArms.length > 0) {
    try {
      reranker = await pinReranker(baseUrl, fetchImpl);
    } catch (error) {
      if (error instanceof ModelNotInstalledError) rerankerReason = error.message;
      else throw error;
    }
  }
  const dropped: { arm: string; reason: string }[] = [...resolved.dropped];
  for (const arm of rerankArms) {
    if (reranker === null) dropped.push({ arm, reason: rerankerReason });
    else if (resolved.dropped.some((d) => d.arm === baseOf(arm))) dropped.push({ arm, reason: `first-stage arm ${baseOf(arm)} is not available` });
  }
  return { planned, resolved, reranker, dropped, rerankArms };
}

export interface StageDPlanReport {
  readonly kind: 'chunk-eval-stage-d-plan';
  readonly version: typeof STAGE_D_PLAN_VERSION;
  readonly digest: string;
  readonly sets: StageDInputs['sets'];
  readonly planned: readonly string[];
  readonly dropped: readonly { readonly arm: string; readonly reason: string }[];
  readonly arms: readonly { readonly arm: ArmId; readonly pin: object; readonly memory: { readonly queries: PlanCount; readonly singles: PlanCount; readonly passages: PlanCount }; readonly memoryPathQueryCalls: number }[];
  readonly reranker: RerankerPin | null;
  readonly rerankCallsPerArm: number;
  readonly parameters: typeof STAGE_D_PARAMETERS;
  readonly note: string;
}

export function buildStageDPlan(input: StageDInputs, embedders: readonly ArmEmbedder[], set: MemorySet, rerankArms: readonly string[]): StageDPlanReport {
  const mem = memoryItems(set);
  return {
    kind: 'chunk-eval-stage-d-plan',
    version: STAGE_D_PLAN_VERSION,
    digest: stageDDigest(input),
    sets: input.sets,
    planned: input.planned,
    dropped: input.dropped,
    arms: embedders.map((embedder) => ({
      arm: embedder.pin.arm,
      pin: pinKey(embedder.pin),
      memory: { queries: embedder.plan('query', mem.queries), singles: embedder.plan('document', mem.singles), passages: embedder.plan('document', mem.passages) },
      memoryPathQueryCalls: MEMORY_LATENCY_QUERIES + 1,
    })),
    reranker: input.reranker,
    rerankCallsPerArm: rerankArms.length === 0 ? 0 : set.queries.length,
    parameters: STAGE_D_PARAMETERS,
    note: 'Zero model calls: pins come from the loopback daemon (version, tags, show); counts come from the on-disk cache. A run makes up to one rerank call per query per R arm (cached ones are not repeated); the candidate list, and so the rerank cache key, is known only after the first stage ran. A probe embeds the memory set for the first-stage arms (cached on disk, reused by the run), then makes 20 uncached rerank calls per R arm.',
  };
}

export function planLinesD(plan: StageDPlanReport): string[] {
  const out = [`eval:chunk stage D plan (no model call) — ${plan.version}, memory set ${plan.sets.memory.digest.slice(0, 12)}`];
  out.push(`planned arms: ${plan.planned.join(', ')}${plan.dropped.length > 0 ? `; dropped: ${plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}` : ''}`);
  for (const arm of plan.arms) {
    const pin = arm.pin as { model: string; digest12: string; ollamaVersion: string };
    out.push(`${arm.arm} ${pin.model}@${pin.digest12} ollama${pin.ollamaVersion}: queries ${arm.memory.queries.toEmbed}/${arm.memory.queries.unique} to embed, whole memories ${arm.memory.singles.toEmbed}/${arm.memory.singles.unique}, passages ${arm.memory.passages.toEmbed}/${arm.memory.passages.unique}; memory-path latency sample ${MEMORY_LATENCY_QUERIES} queries + 1 warm-up`);
  }
  if (plan.reranker !== null) out.push(`reranker ${plan.reranker.model}@${plan.reranker.digest12} ollama${plan.reranker.ollamaVersion}; top-${RERANK_TOP_N}, candidate cap ${CANDIDATE_CAP_UNITS}, prompt ${RERANK_PROMPT_SHA.slice(0, 12)}; up to ${plan.rerankCallsPerArm} calls per R arm`);
  out.push(`plan digest: ${plan.digest}`);
  return out;
}

// ---------------------------------------------------------------- first stage

export interface FirstStage {
  /** Memory indexes by descending multi-vector score. */
  readonly ranking: readonly number[];
  /** The top-N candidates with the text the reranker sees (a long memory: its best-matching passage). */
  readonly candidates: readonly Candidate[];
}

/** The multi-vector first stage per query. Vectors come from the embedder (cache hits after a normal run). */
export async function firstStageOf(embedder: ArmEmbedder, set: MemorySet, topN: number = RERANK_TOP_N): Promise<FirstStage[]> {
  const items = memoryItems(set);
  await embedder.settle([{ role: 'query', items: items.queries }, { role: 'document', items: items.passages }]);
  const queryVectors = await embedder.embed('query', items.queries);
  const passageVectors = await embedder.embed('document', items.passages);
  const passagesOf = set.memories.map((memory) => memoryPassageTexts(memory.text));
  return set.queries.map((query) => {
    const q = queryVectors.get(query.text) ?? null;
    const best: string[] = [];
    const scores = passagesOf.map((texts) => {
      const each = cosineScores(q, texts.map((text) => passageVectors.get(text) ?? null));
      let at = 0;
      each.forEach((score, index) => {
        if (score > (each[at] as number)) at = index;
      });
      best.push(texts[at] ?? '');
      return Math.max(Number.NEGATIVE_INFINITY, ...each);
    });
    const ranking = rankByScores(scores);
    return {
      ranking,
      candidates: ranking.slice(0, topN).map((memoryIndex) => {
        const memory = set.memories[memoryIndex] as MemorySet['memories'][number];
        return { id: memory.id, text: memory.long ? (best[memoryIndex] as string) : memory.text };
      }),
    };
  });
}

export interface RecallAtN {
  readonly n: number;
  readonly overall: number;
  readonly byLanguage: Readonly<Record<string, number>>;
}
/** First-stage Recall@N: the ceiling of any reranker of the top N. */
export function recallAtN(set: MemorySet, ranks: readonly (number | null)[], n: number): RecallAtN {
  const byLanguage: Record<string, number> = {};
  for (const language of LANGUAGES) byLanguage[language] = round4(mean(ranks.filter((_, at) => set.queries[at]?.language === language).map((rank) => recallAtK(rank, n))));
  return { n, overall: round4(mean(ranks.map((rank) => recallAtK(rank, n)))), byLanguage };
}

// ---------------------------------------------------------------- memory-path latency

export interface QueryLatencyBlock {
  readonly sample: number;
  readonly sampleSha: string;
  readonly warmups: 1;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly perQueryMs: readonly number[];
  readonly barMs: number;
  readonly meetsBar: boolean;
  readonly reason: string | null;
  readonly overContext: number;
}

const r3 = (value: number): number => Math.round(value * 1000) / 1000;

/** One untimed warm-up, then every sampled query embedded alone, cache bypassed. Eligible when p95 <= the bar. */
export async function measureQueryLatency(embedder: ArmEmbedder, queries: readonly MemoryQuery[], planned: number = MEMORY_LATENCY_QUERIES, barMs: number = MEMORY_QUERY_BAR_MS): Promise<QueryLatencyBlock> {
  const items: EmbedItem[] = queries.map((query) => ({ text: query.text, language: query.language }));
  if (items.length > 0) await embedder.timed('query', [items[0] as EmbedItem]);
  const times: number[] = [];
  let refused = 0;
  let failed = 0;
  for (const item of items) {
    const result = await embedder.timed('query', [item]);
    times.push(r3(result.ms));
    refused += result.refused;
    if (result.successfulCalls === 0) failed += 1;
  }
  const p = percentiles(times);
  const reason =
    items.length < planned ? `sample smaller than planned (${items.length} of ${planned} queries)` : refused > 0 ? `${refused} query input(s) refused as over the model context` : failed > 0 ? `${failed} query call(s) without a successful embedding` : p.p95 > barMs ? `p95 ${r3(p.p95)} ms is over the ${barMs} ms memory-path bar` : null;
  return { sample: items.length, sampleSha: selectionSha(queries), warmups: 1, p50: r3(p.p50), p95: r3(p.p95), max: times.length === 0 ? 0 : Math.max(...times), perQueryMs: times, barMs, meetsBar: reason === null, reason, overContext: refused };
}

// ---------------------------------------------------------------- embedder arm and rerank arm runs

export type StageDEmbedderRun = MemoryArmRun & { readonly firstStageRecallAtN: RecallAtN; readonly memoryPathLatency: QueryLatencyBlock };

export async function runStageDEmbedder(embedder: ArmEmbedder, set: MemorySet, options: { sample: readonly EmbedItem[]; query: EmbedItem; topN?: number }): Promise<{ run: StageDEmbedderRun; firstStage: FirstStage[] }> {
  const run = await runMemoryArm(embedder, set, { sample: options.sample, query: options.query });
  const firstStage = await firstStageOf(embedder, set, options.topN ?? RERANK_TOP_N);
  const ranks = firstStage.map((stage, at) => goldRank(set, stage.ranking, (set.queries[at] as MemoryQuery).gold));
  const memoryPathLatency = await measureQueryLatency(embedder, sampleQueries(set.queries, MEMORY_LATENCY_QUERIES, 'memory-path-latency'));
  return { run: { ...run, firstStageRecallAtN: recallAtN(set, ranks, options.topN ?? RERANK_TOP_N), memoryPathLatency }, firstStage };
}

export interface RerankArmRun {
  readonly base: ArmId;
  readonly topN: number;
  readonly metrics: PathMetrics;
  readonly firstStageRecallAtN: RecallAtN;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number; readonly queries: number; readonly freshCalls: number; readonly cacheHits: number };
  readonly fallbacks: number;
  readonly promptTokens: number;
  readonly evalTokens: number;
}

export async function runRerankArm(reranker: LlmReranker, base: ArmId, set: MemorySet, firstStage: readonly FirstStage[], topN: number = RERANK_TOP_N): Promise<RerankArmRun> {
  const firstRanks: (number | null)[] = [];
  const ranks: (number | null)[] = [];
  const times: number[] = [];
  let fresh = 0;
  let hits = 0;
  let fallbacks = 0;
  let promptTokens = 0;
  let evalTokens = 0;
  for (const [at, query] of set.queries.entries()) {
    const stage = firstStage[at] as FirstStage;
    const result = await reranker.rerank(query.id, query.text, stage.candidates);
    const head = result.order.map((index) => stage.ranking[index] as number);
    const ranking = [...head, ...stage.ranking.slice(stage.candidates.length)];
    firstRanks.push(goldRank(set, stage.ranking, query.gold));
    ranks.push(goldRank(set, ranking, query.gold));
    times.push(result.ms);
    if (result.cached) hits += 1;
    else fresh += 1;
    if (result.fallback) fallbacks += 1;
    promptTokens += result.promptTokens ?? 0;
    evalTokens += result.evalTokens ?? 0;
  }
  const p = percentiles(times);
  return {
    base,
    topN,
    metrics: pathMetrics(set, ranks),
    firstStageRecallAtN: recallAtN(set, firstRanks, topN),
    latencyMs: { p50: r3(p.p50), p95: r3(p.p95), max: times.length === 0 ? 0 : Math.max(...times), queries: times.length, freshCalls: fresh, cacheHits: hits },
    fallbacks,
    promptTokens,
    evalTokens,
  };
}

// ---------------------------------------------------------------- decision

export interface StageDDecisionInput {
  readonly arm: string;
  readonly kind: 'embedder' | 'rerank';
  readonly koRecallAt5: number;
  readonly enRecallAt5: number;
  readonly mixedRecallAt5: number;
  /** Embedder arm: its own. R arm: embedder plus reranker (the pair that has to be resident). */
  readonly paramsM: number | null;
  readonly sizeBytes: number | null;
  /** Memory-path latency of the embedder (an R arm inherits its first stage's: the reranker latency is reported, not gated). */
  readonly memoryP95Ms: number | null;
  readonly latencyMeetsBar: boolean;
  readonly latencyReason: string | null;
}
export interface StageDVerdict {
  readonly verdict: 'INCOMPLETE' | 'KEEP_E0' | 'CHOOSE';
  readonly chosen: string | null;
  readonly text: string;
  readonly reasons: readonly string[];
  readonly rule: string;
  readonly inputs: readonly (StageDDecisionInput & { readonly latencyOk: boolean; readonly englishWithin2Points: boolean; readonly reachesTarget: { readonly ko: boolean; readonly mixed: boolean } })[];
}

export const DECISION_RULE_D =
  'Among the arms (plain embedders and rerank arms R(Ex)) whose first-stage embedder meets the memory-path latency bar (warm single query embed, p95 <= 1000 ms over the sample), choose the highest Korean Recall@5 on CH7, provided it is not more than 2 percentage points worse than E0 on English; a tie goes to the smaller model (a rerank arm counts embedder plus reranker); if no arm beats E0 on Korean by at least 5 points, keep E0. Rerank latency is reported, not a gate. The 95% target is informational. No arm is chosen until all planned arms ran.';

const bp = (value: number): number => Math.round(value * 10_000);

export function decideStageD(planned: readonly string[], inputs: readonly StageDDecisionInput[], barMs: number = MEMORY_QUERY_BAR_MS): StageDVerdict {
  const ran = new Set(inputs.map((input) => input.arm));
  const missing = planned.filter((arm) => !ran.has(arm));
  const e0 = inputs.find((input) => input.arm === 'E0');
  const annotated = inputs.map((input) => ({
    ...input,
    latencyOk: input.latencyMeetsBar && input.memoryP95Ms !== null && input.memoryP95Ms <= barMs,
    englishWithin2Points: e0 !== undefined && bp(e0.enRecallAt5) - bp(input.enRecallAt5) <= ENGLISH_TOLERANCE_BP,
    reachesTarget: { ko: bp(input.koRecallAt5) >= TARGET_BP, mixed: bp(input.mixedRecallAt5) >= TARGET_BP },
  }));
  if (missing.length > 0 || e0 === undefined) {
    const why = e0 === undefined && missing.length === 0 ? 'E0 was not planned, so there is nothing to compare against' : `missing: ${missing.join(', ')}`;
    return { verdict: 'INCOMPLETE', chosen: null, text: `no arm is chosen until all planned arms ran (${why})`, reasons: [why], rule: DECISION_RULE_D, inputs: annotated };
  }
  const reasons = annotated.map(
    (input) =>
      `${input.arm}: ko R@5 ${input.koRecallAt5} (${(bp(input.koRecallAt5) - bp(e0.koRecallAt5)) / 100} points vs E0), en R@5 ${input.enRecallAt5} (${(bp(input.enRecallAt5) - bp(e0.enRecallAt5)) / 100} points vs E0), mixed ${input.mixedRecallAt5}; memory-path query embed p95 ${input.memoryP95Ms ?? 'n/a'} ms ${input.latencyOk ? 'within' : 'over'} ${barMs} ms${input.latencyOk ? '' : ` — NOT ELIGIBLE: ${input.latencyReason ?? 'over the memory-path bar'}`}; 95% target ko ${input.reachesTarget.ko ? 'met' : 'not met'}, mixed ${input.reachesTarget.mixed ? 'met' : 'not met'} (informational)`,
  );
  if (!annotated.find((input) => input.arm === 'E0')?.latencyOk) reasons.push(`E0 itself fails the memory-path latency bar (${e0.latencyReason ?? 'over the bar'}); it is not eligible, and E0 is kept only because the rule keeps E0 when no eligible arm beats it by 5 points`);
  const candidates = annotated.filter((input) => input.latencyOk && input.englishWithin2Points);
  const topKorean = Math.max(...candidates.map((input) => bp(input.koRecallAt5)));
  const winner = smallestOf(candidates.filter((input) => bp(input.koRecallAt5) === topKorean));
  if (winner === undefined || winner.arm === 'E0' || bp(winner.koRecallAt5) - bp(e0.koRecallAt5) < KOREAN_GAIN_BP) {
    const best = winner === undefined ? 'no arm met the memory-path latency bar and the English bound' : `the best eligible arm is ${winner.arm}`;
    return { verdict: 'KEEP_E0', chosen: 'E0', text: `keep E0 (${ARM_SPECS.E0.model}): no arm beats E0 on Korean Recall@5 by at least 5 points (${best})`, reasons, rule: DECISION_RULE_D, inputs: annotated };
  }
  return { verdict: 'CHOOSE', chosen: winner.arm, text: `choose ${winner.arm}: Korean Recall@5 ${winner.koRecallAt5} vs E0 ${e0.koRecallAt5}`, reasons, rule: DECISION_RULE_D, inputs: annotated };
}

// ---------------------------------------------------------------- report

export interface StageDReport {
  readonly kind: 'chunk-eval-memory-stage-d';
  readonly status: 'NON-GATING';
  readonly set: { readonly version: string; readonly seed: string; readonly sha256: string; readonly memories: number; readonly queries: number };
  readonly plan: { readonly version: string; readonly digest: string; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly reranker: RerankerPin | null;
  readonly EL: PathMetrics;
  readonly embedders: Readonly<Record<string, StageDEmbedderRun>>;
  readonly rerank: Readonly<Record<string, RerankArmRun>>;
  readonly verdict: StageDVerdict;
  readonly note: string;
}

const lang = (m: PathMetrics, language: string): number => m.byLanguage[language]?.recallAt5 ?? 0;
const sumOrNull = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.round((a + b) * 1000) / 1000);

export function decisionInputsD(embedders: Readonly<Record<string, StageDEmbedderRun>>, rerank: Readonly<Record<string, RerankArmRun>>, reranker: RerankerPin | null): StageDDecisionInput[] {
  const plain = Object.entries(embedders).map(
    ([arm, run]): StageDDecisionInput => ({
      arm,
      kind: 'embedder',
      koRecallAt5: lang(run.multi, 'ko'),
      enRecallAt5: lang(run.multi, 'en'),
      mixedRecallAt5: lang(run.multi, 'mixed'),
      paramsM: run.pin.paramsM,
      sizeBytes: run.pin.sizeBytes,
      memoryP95Ms: run.memoryPathLatency.p95,
      latencyMeetsBar: run.memoryPathLatency.meetsBar,
      latencyReason: run.memoryPathLatency.reason,
    }),
  );
  const reranked = Object.entries(rerank).map(([arm, run]): StageDDecisionInput => {
    const base = embedders[run.base];
    return {
      arm,
      kind: 'rerank',
      koRecallAt5: lang(run.metrics, 'ko'),
      enRecallAt5: lang(run.metrics, 'en'),
      mixedRecallAt5: lang(run.metrics, 'mixed'),
      paramsM: sumOrNull(base?.pin.paramsM ?? null, reranker?.paramsM ?? null),
      sizeBytes: sumOrNull(base?.pin.sizeBytes ?? null, reranker?.sizeBytes ?? null),
      memoryP95Ms: base?.memoryPathLatency.p95 ?? null,
      latencyMeetsBar: base?.memoryPathLatency.meetsBar ?? false,
      latencyReason: base === undefined ? 'first-stage arm did not run' : base.memoryPathLatency.reason,
    };
  });
  return [...plain, ...reranked];
}

export function buildStageDReport(
  set: MemorySet,
  digest: string,
  runs: { embedders: Readonly<Record<string, StageDEmbedderRun>>; rerank: Readonly<Record<string, RerankArmRun>> },
  plan: StageDReport['plan'],
  reranker: RerankerPin | null,
): StageDReport {
  return {
    kind: 'chunk-eval-memory-stage-d',
    status: 'NON-GATING',
    set: { version: MEMORY_VERSION, seed: MEMORY_SEED, sha256: digest, memories: set.memories.length, queries: set.queries.length },
    plan,
    reranker,
    EL: lexicalMemoryMetrics(set),
    embedders: runs.embedders,
    rerank: runs.rerank,
    verdict: decideStageD(plan.planned, decisionInputsD(runs.embedders, runs.rerank, reranker)),
    note: 'Synthetic fictional memories only. Embedder arms: multi-vector Recall@5 (single-vector and the 200-passage connector-path block are reported as information). R arms: the multi-vector first stage reordered by the local reranker over the top N; memories after the top N keep their first-stage order. Eligibility is the memory-path latency bar (warm single query embed p95); the reranker latency is not a gate. The 95% target is the owner\'s informational target, not a relaxed gold.',
  };
}

export function summaryLinesStageD(report: StageDReport): string[] {
  const m = (x: MemMetrics | undefined): string => (x === undefined ? '-' : `R@5 ${x.recallAt5} MRR ${x.mrr}`);
  const row = (name: string, p: PathMetrics): string => `${name.padEnd(8)} ${m(p.overall)} | ko ${m(p.byLanguage.ko)} | en ${m(p.byLanguage.en)} | mixed ${m(p.byLanguage.mixed)} | long ${m(p.longMemories)} | short ${m(p.shortMemories)}`;
  const out = [`eval:chunk stage D (CH7 memory set, ${STAGE_D_PLAN_VERSION}) — ${report.set.memories} memories, ${report.set.queries} queries, set ${report.set.sha256}, plan ${report.plan.digest}`];
  out.push(row('EL', report.EL));
  for (const [id, run] of Object.entries(report.embedders)) {
    out.push(row(id, run.multi));
    out.push(`  ${id}: memory-path query embed p50 ${run.memoryPathLatency.p50} ms p95 ${run.memoryPathLatency.p95} ms (${run.memoryPathLatency.meetsBar ? 'within' : 'over'} ${run.memoryPathLatency.barMs} ms); first-stage Recall@${run.firstStageRecallAtN.n} ${run.firstStageRecallAtN.overall}; connector-path info: 1 query + 200 passages ${run.latency === null ? 'n/a' : `${run.latency.time200Ms} ms`}`);
  }
  for (const [id, run] of Object.entries(report.rerank)) {
    out.push(row(id, run.metrics));
    out.push(`  ${id}: first-stage Recall@${run.topN} ko ${run.firstStageRecallAtN.byLanguage.ko} en ${run.firstStageRecallAtN.byLanguage.en} mixed ${run.firstStageRecallAtN.byLanguage.mixed}; rerank latency p50 ${run.latencyMs.p50} ms p95 ${run.latencyMs.p95} ms (${run.latencyMs.freshCalls} calls, ${run.latencyMs.cacheHits} cached); fallbacks ${run.fallbacks}`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped: ${report.plan.dropped.map((d) => d.arm).join(', ')}`);
  for (const input of report.verdict.inputs) out.push(`  95% target ${input.arm}: ko ${input.reachesTarget.ko ? 'met' : 'not met'}, mixed ${input.reachesTarget.mixed ? 'met' : 'not met'} (informational)`);
  out.push(`verdict: ${report.verdict.text}`);
  out.push('status: NON-GATING');
  return out;
}

// ---------------------------------------------------------------- probe

export interface StageDProbeReport {
  readonly kind: 'chunk-eval-stage-d-probe';
  readonly status: 'NON-GATING';
  readonly plan: { readonly digest: string; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly reranker: RerankerPin | null;
  readonly memoryPath: Readonly<Record<string, QueryLatencyBlock>>;
  readonly rerank: Readonly<
    Record<string, { readonly selectionSha: string; readonly queries: readonly { readonly id: string; readonly ms: number; readonly fallback: boolean; readonly goldInTopN: boolean; readonly goldRankAfter: number | null }[]; readonly p50: number; readonly p95: number; readonly max: number; readonly fallbacks: number }>
  >;
}

/** Reranks the fixed probe selection with the cache bypassed and prints per-query latency. */
export async function probeRerankArm(reranker: LlmReranker, set: MemorySet, firstStage: readonly FirstStage[]): Promise<StageDProbeReport['rerank'][string]> {
  const picked = sampleQueries(set.queries, PROBE_RERANK_QUERIES, 'probe-rerank');
  const queries: { id: string; ms: number; fallback: boolean; goldInTopN: boolean; goldRankAfter: number | null }[] = [];
  for (const query of picked) {
    const stage = firstStage[set.queries.indexOf(query)] as FirstStage;
    const result = await reranker.rerank(query.id, query.text, stage.candidates, false);
    const ranking = [...result.order.map((index) => stage.ranking[index] as number), ...stage.ranking.slice(stage.candidates.length)];
    const goldRankAfter = goldRank(set, ranking, query.gold);
    const firstRank = goldRank(set, stage.ranking, query.gold);
    queries.push({ id: query.id, ms: result.ms, fallback: result.fallback, goldInTopN: firstRank !== null && firstRank <= stage.candidates.length, goldRankAfter });
  }
  const p = percentiles(queries.map((q) => q.ms));
  return { selectionSha: selectionSha(picked), queries, p50: r3(p.p50), p95: r3(p.p95), max: queries.length === 0 ? 0 : Math.max(...queries.map((q) => q.ms)), fallbacks: queries.filter((q) => q.fallback).length };
}

export function probeLinesD(report: StageDProbeReport): string[] {
  const out = [`eval:chunk stage D probe — plan ${report.plan.digest}`];
  for (const [id, block] of Object.entries(report.memoryPath)) out.push(`${id} memory-path query embed (${block.sample} queries after 1 warm-up): p50 ${block.p50} ms p95 ${block.p95} ms max ${block.max} ms — ${block.meetsBar ? 'within' : 'over'} ${block.barMs} ms${block.reason === null ? '' : ` (${block.reason})`}`);
  for (const [id, arm] of Object.entries(report.rerank)) {
    out.push(`${id} rerank, ${arm.queries.length} queries (selection ${arm.selectionSha.slice(0, 12)}): p50 ${arm.p50} ms p95 ${arm.p95} ms max ${arm.max} ms; fallbacks ${arm.fallbacks}`);
    for (const query of arm.queries) out.push(`  ${query.id}: ${query.ms} ms${query.fallback ? ' (fallback)' : ''}; gold ${query.goldInTopN ? 'in' : 'outside'} top-N, rank after rerank ${query.goldRankAfter ?? '-'}`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped: ${report.plan.dropped.map((d) => d.arm).join(', ')}`);
  out.push('status: NON-GATING');
  return out;
}
