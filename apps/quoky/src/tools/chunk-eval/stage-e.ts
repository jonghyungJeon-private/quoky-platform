/**
 * ADR-0124 phase 1 stage E (owner decision 2026-11-06), CH7 memory set only: the cross-encoder arms X(Ex) / X50(Ex), the optional
 * embedder arm E4, the stage E plan v3 and digest, report and probe. It reuses the stage D machinery (first stage, candidates,
 * metrics, memory-path latency bar, decision). The v1 / v2 runs and the stage A-D plans are unchanged.
 *
 * X(Ex): a local cross-encoder reorders the multi-vector first-stage top 20 of Ex; X50(Ex): the top 50. Memories after the top N keep
 * their first-stage order. The candidate text is stage D's (a long memory: its best-matching passage; otherwise the memory text) but
 * is NOT cut at stage D's 600-unit cap: the cross-encoder gets the whole candidate up to its max_length tokens.
 */
import { createHash } from 'node:crypto';
import { percentiles, ModelNotInstalledError, type FetchLike } from '../selector-rag/embed';
import { STAGE_E_ARM_IDS, resolveArms, type ArmEmbedder, type ArmId, type PlanCount, type ResolvedArms } from './embed-arms';
import { goldRank, lexicalMemoryMetrics, memoryItems, pathMetrics, type PathMetrics, type MemMetrics } from './memory-eval';
import { MEMORY_SEED, MEMORY_VERSION, type MemoryQuery, type MemorySet } from './memory-set';
import { pinKey } from './embed-plan';
import { RERANK_TOP_N, pinReranker, type RerankerPin } from './rerank-arm';
import {
  CROSS_ENCODER_BATCH,
  CROSS_ENCODER_MAX_LENGTH,
  CROSS_ENCODER_PARAMS_M,
  CROSS_ENCODER_THREADS,
  crossEncoderPin,
  orderByScore,
  type CrossEncoderPin,
  type PairScorer,
  type SanityResult,
} from './cross-encoder';
import {
  MEMORY_LATENCY_QUERIES,
  PROBE_RERANK_QUERIES,
  STAGE_D_PARAMETERS,
  TARGET_BP,
  baseOf,
  decideStageD,
  decisionInputsD,
  isRerankArm,
  parseStageDArm,
  recallAtN,
  sampleQueries,
  selectionSha,
  type FirstStage,
  type QueryLatencyBlock,
  type RecallAtN,
  type RerankArmId,
  type RerankArmRun,
  type StageDDecisionInput,
  type StageDEmbedderRun,
  type StageDVerdict,
} from './stage-d';

export const STAGE_E_PLAN_VERSION = 'chunk-embed-plan.v3';
export const CROSS_TOP_N = RERANK_TOP_N;
export const CROSS_TOP_N_LARGE = 50;

export type CrossArmId = `X(${ArmId})` | `X50(${ArmId})`;
export type StageEArmId = ArmId | RerankArmId | CrossArmId;

const CROSS_PATTERN = /^(X|X50)\((E[0-4])\)$/u;

/** Plain arms E0-E4, rerank arms R(E0..E3) (kept from stage D) and cross-encoder arms X(E0..E4), X50(E0..E4). */
export function parseStageEArm(token: string): StageEArmId | undefined {
  if ((STAGE_E_ARM_IDS as readonly string[]).includes(token)) return token as ArmId;
  if (CROSS_PATTERN.test(token)) return token as CrossArmId;
  return parseStageDArm(token);
}
export const isCrossArm = (arm: string): arm is CrossArmId => CROSS_PATTERN.test(arm);
export const crossBase = (arm: CrossArmId): ArmId => (CROSS_PATTERN.exec(arm) as RegExpExecArray)[2] as ArmId;
export const crossTopN = (arm: CrossArmId): number => ((CROSS_PATTERN.exec(arm) as RegExpExecArray)[1] === 'X50' ? CROSS_TOP_N_LARGE : CROSS_TOP_N);

/** E0 is always planned; then the other embedders in arm order; then the R arms, then the X arms in the given order. */
export function stageEPlanned(requested: readonly StageEArmId[]): { planned: StageEArmId[]; embedderIds: ArmId[]; rerankArms: RerankArmId[]; crossArms: CrossArmId[] } {
  const rerankArms = [...new Set(requested.filter(isRerankArm))];
  const crossArms = [...new Set(requested.filter(isCrossArm))];
  const plain = requested.filter((arm): arm is ArmId => !isRerankArm(arm) && !isCrossArm(arm));
  const wanted = new Set<ArmId>(['E0', ...plain, ...rerankArms.map(baseOf), ...crossArms.map(crossBase)]);
  const embedderIds = STAGE_E_ARM_IDS.filter((arm) => wanted.has(arm));
  const planned: StageEArmId[] = [...STAGE_E_ARM_IDS.filter((arm) => plain.includes(arm) || arm === 'E0'), ...rerankArms, ...crossArms];
  return { planned, embedderIds, rerankArms, crossArms };
}

// ---------------------------------------------------------------- plan v3

export const STAGE_E_PARAMETERS = {
  base: STAGE_D_PARAMETERS,
  cross: {
    topN: CROSS_TOP_N,
    topNLarge: CROSS_TOP_N_LARGE,
    maxLength: CROSS_ENCODER_MAX_LENGTH,
    batch: CROSS_ENCODER_BATCH,
    intraOpThreads: CROSS_ENCODER_THREADS,
    executionProvider: 'cpu',
    graphOptimization: 'all',
    truncation: 'passage side (the closing special token is kept)',
    padding: 'dynamic, per batch',
    tokenization: 'the model tokenizer.json pair post-processor (query, passage)',
    score: 'the single logit; candidates ordered by descending score, ties keep first-stage order',
    candidateText: 'as stage D (a long memory: the passage the first-stage scoring matched best; otherwise the memory text), whitespace not collapsed, NOT cut at the stage D 600-unit cap: up to max_length tokens',
    rest: 'memories after the top N keep their first-stage order',
    network: 'none: local files only, verified against SHA256SUMS and the pins before loading',
    probe: { queries: PROBE_RERANK_QUERIES, sanityCheck: 'a relevant pair must outscore an unrelated pair' },
    latency: 'per query wall time of scoring the candidates (p50, p95); reported, not a gate',
  },
  decision: { ...STAGE_D_PARAMETERS.decision, candidates: 'plain arms, R arms and X arms', xTieSize: 'embedder plus reranker parameters' },
} as const;

export interface StageEInputs {
  readonly sets: { readonly memory: { readonly digest: string }; readonly v2: { readonly digest: string } };
  readonly planned: readonly StageEArmId[];
  readonly resolved: ResolvedArms;
  readonly reranker: RerankerPin | null;
  readonly crossEncoder: CrossEncoderPin | null;
  readonly dropped: readonly { readonly arm: string; readonly reason: string }[];
}

export function stageEDigest(input: StageEInputs, parameters: unknown = STAGE_E_PARAMETERS): string {
  const body = {
    version: STAGE_E_PLAN_VERSION,
    stage: 'E',
    sets: input.sets,
    planned: input.planned,
    arms: input.resolved.available.map(pinKey),
    reranker: input.reranker,
    crossEncoder: input.crossEncoder,
    dropped: input.dropped.map((d) => d.arm),
    parameters,
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export interface StageEResolution {
  readonly planned: StageEArmId[];
  readonly resolved: ResolvedArms;
  readonly reranker: RerankerPin | null;
  readonly crossEncoder: CrossEncoderPin | null;
  readonly dropped: { arm: string; reason: string }[];
  readonly rerankArms: RerankArmId[];
  readonly crossArms: CrossArmId[];
}

/**
 * Pins the embedders (a missing one, E4 included, is dropped with a note), the optional R reranker, and the cross-encoder
 * directory (only when an X arm is planned). `verify` hashes the directory; it throws on any mismatch, which is not a drop: a
 * tampered or incomplete model directory stops the command. X arms whose first-stage embedder is missing are dropped with a note.
 */
export async function resolveStageE(
  requested: readonly StageEArmId[],
  options: { baseUrl?: string; fetchImpl?: FetchLike; verify: () => Promise<Record<string, string>> },
): Promise<StageEResolution> {
  const { planned, embedderIds, rerankArms, crossArms } = stageEPlanned(requested);
  const resolved = await resolveArms(embedderIds, options.baseUrl, options.fetchImpl);
  let reranker: RerankerPin | null = null;
  let rerankerReason = '';
  if (rerankArms.length > 0) {
    try {
      reranker = await pinReranker(options.baseUrl, options.fetchImpl);
    } catch (error) {
      if (error instanceof ModelNotInstalledError) rerankerReason = error.message;
      else throw error;
    }
  }
  const crossEncoder = crossArms.length > 0 ? crossEncoderPin(await options.verify()) : null;
  const dropped: { arm: string; reason: string }[] = [...resolved.dropped];
  const missingBase = (base: ArmId): boolean => resolved.dropped.some((d) => d.arm === base);
  for (const arm of rerankArms) {
    if (reranker === null) dropped.push({ arm, reason: rerankerReason });
    else if (missingBase(baseOf(arm))) dropped.push({ arm, reason: `first-stage arm ${baseOf(arm)} is not available` });
  }
  for (const arm of crossArms) if (missingBase(crossBase(arm))) dropped.push({ arm, reason: `first-stage arm ${crossBase(arm)} is not available` });
  return { planned, resolved, reranker, crossEncoder, dropped, rerankArms, crossArms };
}

export interface StageEPlanReport {
  readonly kind: 'chunk-eval-stage-e-plan';
  readonly version: typeof STAGE_E_PLAN_VERSION;
  readonly digest: string;
  readonly sets: StageEInputs['sets'];
  readonly planned: readonly string[];
  readonly dropped: readonly { readonly arm: string; readonly reason: string }[];
  readonly arms: readonly { readonly arm: ArmId; readonly pin: object; readonly memory: { readonly queries: PlanCount; readonly singles: PlanCount; readonly passages: PlanCount }; readonly memoryPathQueryCalls: number }[];
  readonly reranker: RerankerPin | null;
  readonly crossEncoder: CrossEncoderPin | null;
  readonly crossPairsPerArm: Readonly<Record<string, number>>;
  readonly parameters: typeof STAGE_E_PARAMETERS;
  readonly note: string;
}

export function buildStageEPlan(input: StageEInputs, embedders: readonly ArmEmbedder[], set: MemorySet, crossArms: readonly CrossArmId[]): StageEPlanReport {
  const mem = memoryItems(set);
  return {
    kind: 'chunk-eval-stage-e-plan',
    version: STAGE_E_PLAN_VERSION,
    digest: stageEDigest(input),
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
    crossEncoder: input.crossEncoder,
    crossPairsPerArm: Object.fromEntries(crossArms.map((arm) => [arm, set.queries.length * crossTopN(arm)])),
    parameters: STAGE_E_PARAMETERS,
    note: 'Zero embedding or generation calls: pins come from the loopback daemon (version, tags, show); counts come from the on-disk cache. The cross-encoder model files were hashed against SHA256SUMS and the pins (a local read; the ONNX model is not loaded in plan mode). A run scores up to queries x N (query, candidate) pairs per X arm on the CPU; nothing is cached.',
  };
}

export function planLinesE(plan: StageEPlanReport): string[] {
  const out = [`eval:chunk stage E plan (no model call) — ${plan.version}, memory set ${plan.sets.memory.digest.slice(0, 12)}`];
  out.push(`planned arms: ${plan.planned.join(', ')}${plan.dropped.length > 0 ? `; dropped: ${plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}` : ''}`);
  for (const arm of plan.arms) {
    const pin = arm.pin as { model: string; digest12: string; ollamaVersion: string };
    out.push(`${arm.arm} ${pin.model}@${pin.digest12} ollama${pin.ollamaVersion}: queries ${arm.memory.queries.toEmbed}/${arm.memory.queries.unique} to embed, whole memories ${arm.memory.singles.toEmbed}/${arm.memory.singles.unique}, passages ${arm.memory.passages.toEmbed}/${arm.memory.passages.unique}; memory-path latency sample ${MEMORY_LATENCY_QUERIES} queries + 1 warm-up`);
  }
  if (plan.reranker !== null) out.push(`reranker (R arms) ${plan.reranker.model}@${plan.reranker.digest12}`);
  if (plan.crossEncoder !== null) {
    const pin = plan.crossEncoder;
    out.push(`cross-encoder ${pin.repo}@${pin.revision.slice(0, 12)} ${pin.modelFile} sha256 ${(pin.files[pin.modelFile] as string).slice(0, 12)} (files verified); onnxruntime-node ${pin.runtime.onnxruntimeNode}, tokenizers ${pin.runtime.huggingfaceTokenizers}; max_length ${CROSS_ENCODER_MAX_LENGTH}, batch ${CROSS_ENCODER_BATCH}, threads ${CROSS_ENCODER_THREADS}`);
    out.push(`  pairs per arm: ${Object.entries(plan.crossPairsPerArm).map(([arm, pairs]) => `${arm} ${pairs}`).join(', ')}`);
  }
  out.push(`plan digest: ${plan.digest}`);
  return out;
}

// ---------------------------------------------------------------- first stage reuse

/** The same first stage cut to the top `n` (candidates only; the full ranking is kept, so ranks beyond N stay first-stage ranks). */
export const limitStage = (stage: FirstStage, n: number): FirstStage => ({ ranking: stage.ranking, candidates: stage.candidates.slice(0, n) });

// ---------------------------------------------------------------- cross-encoder arm run

const r3 = (value: number): number => Math.round(value * 1000) / 1000;

/** The candidates ordered by descending score, then every memory after the top N in its first-stage order. */
export function reorderRanking(stage: FirstStage, scores: readonly number[]): number[] {
  if (scores.length !== stage.candidates.length) throw new Error(`the scorer returned ${scores.length} scores for ${stage.candidates.length} candidates`);
  return [...orderByScore(scores).map((index) => stage.ranking[index] as number), ...stage.ranking.slice(stage.candidates.length)];
}

export interface CrossArmRun {
  readonly base: ArmId;
  readonly topN: number;
  readonly maxLength: number;
  readonly batch: number;
  readonly metrics: PathMetrics;
  readonly firstStageRecallAtN: RecallAtN;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number; readonly queries: number };
  readonly pairsScored: number;
}

/** Reorders the top `topN` candidates of every query by the scorer; memories after the top N keep their first-stage order. */
export async function runCrossArm(scorer: PairScorer, base: ArmId, topN: number, set: MemorySet, firstStage: readonly FirstStage[], clock: () => number = () => performance.now()): Promise<CrossArmRun> {
  const firstRanks: (number | null)[] = [];
  const ranks: (number | null)[] = [];
  const times: number[] = [];
  let pairs = 0;
  for (const [at, query] of set.queries.entries()) {
    const stage = limitStage(firstStage[at] as FirstStage, topN);
    const started = clock();
    const scores = await scorer.score(query.text, stage.candidates.map((candidate) => candidate.text));
    times.push(r3(clock() - started));
    const ranking = reorderRanking(stage, scores);
    pairs += scores.length;
    firstRanks.push(goldRank(set, stage.ranking, query.gold));
    ranks.push(goldRank(set, ranking, query.gold));
  }
  const p = percentiles(times);
  return {
    base,
    topN,
    maxLength: CROSS_ENCODER_MAX_LENGTH,
    batch: CROSS_ENCODER_BATCH,
    metrics: pathMetrics(set, ranks),
    firstStageRecallAtN: recallAtN(set, firstRanks, topN),
    latencyMs: { p50: r3(p.p50), p95: r3(p.p95), max: times.length === 0 ? 0 : Math.max(...times), queries: times.length },
    pairsScored: pairs,
  };
}

// ---------------------------------------------------------------- decision

const sumOrNull = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.round((a + b) * 1000) / 1000);
const lang = (m: PathMetrics, language: string): number => m.byLanguage[language]?.recallAt5 ?? 0;

/** Stage D inputs plus one per X arm: its first stage's memory-path latency (the reranker latency is reported, not gated); size = embedder + reranker. */
export function decisionInputsE(
  embedders: Readonly<Record<string, StageDEmbedderRun>>,
  rerank: Readonly<Record<string, RerankArmRun>>,
  cross: Readonly<Record<string, CrossArmRun>>,
  reranker: RerankerPin | null,
): StageDDecisionInput[] {
  const crossed = Object.entries(cross).map(([arm, run]): StageDDecisionInput => {
    const base = embedders[run.base];
    return {
      arm,
      kind: 'rerank',
      koRecallAt5: lang(run.metrics, 'ko'),
      enRecallAt5: lang(run.metrics, 'en'),
      mixedRecallAt5: lang(run.metrics, 'mixed'),
      paramsM: sumOrNull(base?.pin.paramsM ?? null, CROSS_ENCODER_PARAMS_M),
      sizeBytes: null,
      memoryP95Ms: base?.memoryPathLatency.p95 ?? null,
      latencyMeetsBar: base?.memoryPathLatency.meetsBar ?? false,
      latencyReason: base === undefined ? 'first-stage arm did not run' : base.memoryPathLatency.reason,
    };
  });
  return [...decisionInputsD(embedders, rerank, reranker), ...crossed];
}

// ---------------------------------------------------------------- report

export interface StageEReport {
  readonly kind: 'chunk-eval-memory-stage-e';
  readonly status: 'NON-GATING';
  readonly set: { readonly version: string; readonly seed: string; readonly sha256: string; readonly memories: number; readonly queries: number };
  readonly plan: { readonly version: string; readonly digest: string; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly reranker: RerankerPin | null;
  readonly crossEncoder: CrossEncoderPin | null;
  readonly EL: PathMetrics;
  readonly embedders: Readonly<Record<string, StageDEmbedderRun>>;
  readonly rerank: Readonly<Record<string, RerankArmRun>>;
  readonly cross: Readonly<Record<string, CrossArmRun>>;
  readonly verdict: StageDVerdict;
  readonly note: string;
}

export function buildStageEReport(
  set: MemorySet,
  digest: string,
  runs: { embedders: Readonly<Record<string, StageDEmbedderRun>>; rerank: Readonly<Record<string, RerankArmRun>>; cross: Readonly<Record<string, CrossArmRun>> },
  plan: StageEReport['plan'],
  reranker: RerankerPin | null,
  crossEncoder: CrossEncoderPin | null,
): StageEReport {
  return {
    kind: 'chunk-eval-memory-stage-e',
    status: 'NON-GATING',
    set: { version: MEMORY_VERSION, seed: MEMORY_SEED, sha256: digest, memories: set.memories.length, queries: set.queries.length },
    plan,
    reranker,
    crossEncoder,
    EL: lexicalMemoryMetrics(set),
    embedders: runs.embedders,
    rerank: runs.rerank,
    cross: runs.cross,
    verdict: decideStageD(plan.planned, decisionInputsE(runs.embedders, runs.rerank, runs.cross, reranker)),
    note: 'Synthetic fictional memories only. Embedder arms: multi-vector Recall@5. X arms: the multi-vector first stage top N reordered by the local cross-encoder (candidate text up to max_length tokens; stage D 600-unit cap not applied); memories after the top N keep their first-stage order. Same ratified decision rule and memory-path latency bar as stage D (the X arm inherits its first stage embedder latency; cross-encoder latency is reported, not a gate); an X arm counts embedder plus reranker parameters for the tie-break. The 95% target is the owner\'s informational target, not a relaxed gold.',
  };
}

export function summaryLinesStageE(report: StageEReport): string[] {
  const m = (x: MemMetrics | undefined): string => (x === undefined ? '-' : `R@5 ${x.recallAt5} MRR ${x.mrr}`);
  const row = (name: string, p: PathMetrics): string => `${name.padEnd(8)} ${m(p.overall)} | ko ${m(p.byLanguage.ko)} | en ${m(p.byLanguage.en)} | mixed ${m(p.byLanguage.mixed)} | long ${m(p.longMemories)} | short ${m(p.shortMemories)}`;
  const out = [`eval:chunk stage E (CH7 memory set, ${STAGE_E_PLAN_VERSION}) — ${report.set.memories} memories, ${report.set.queries} queries, set ${report.set.sha256}, plan ${report.plan.digest}`];
  out.push(row('EL', report.EL));
  for (const [id, run] of Object.entries(report.embedders)) {
    out.push(row(id, run.multi));
    out.push(`  ${id}: memory-path query embed p50 ${run.memoryPathLatency.p50} ms p95 ${run.memoryPathLatency.p95} ms (${run.memoryPathLatency.meetsBar ? 'within' : 'over'} ${run.memoryPathLatency.barMs} ms); first-stage Recall@${run.firstStageRecallAtN.n} ${run.firstStageRecallAtN.overall}`);
  }
  for (const [id, run] of Object.entries(report.rerank)) {
    out.push(row(id, run.metrics));
    out.push(`  ${id}: first-stage Recall@${run.topN} ko ${run.firstStageRecallAtN.byLanguage.ko} en ${run.firstStageRecallAtN.byLanguage.en} mixed ${run.firstStageRecallAtN.byLanguage.mixed}; rerank latency p50 ${run.latencyMs.p50} ms p95 ${run.latencyMs.p95} ms; fallbacks ${run.fallbacks}`);
  }
  for (const [id, run] of Object.entries(report.cross)) {
    out.push(row(id, run.metrics));
    out.push(`  ${id}: first-stage Recall@${run.topN} ko ${run.firstStageRecallAtN.byLanguage.ko} en ${run.firstStageRecallAtN.byLanguage.en} mixed ${run.firstStageRecallAtN.byLanguage.mixed}; cross-encoder latency per query p50 ${run.latencyMs.p50} ms p95 ${run.latencyMs.p95} ms max ${run.latencyMs.max} ms (${run.pairsScored} pairs, max_length ${run.maxLength}, batch ${run.batch})`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped: ${report.plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}`);
  for (const input of report.verdict.inputs) out.push(`  95% target ${input.arm}: ko ${input.reachesTarget.ko ? 'met' : 'not met'}, mixed ${input.reachesTarget.mixed ? 'met' : 'not met'} (informational, ${TARGET_BP / 100}%)`);
  out.push(`verdict: ${report.verdict.text}`);
  out.push('status: NON-GATING');
  return out;
}

// ---------------------------------------------------------------- probe

export interface CrossProbeArm {
  readonly selectionSha: string;
  readonly queries: readonly { readonly id: string; readonly ms: number; readonly goldInTopN: boolean; readonly goldRankAfter: number | null }[];
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface StageEProbeReport {
  readonly kind: 'chunk-eval-stage-e-probe';
  readonly status: 'NON-GATING';
  readonly plan: { readonly digest: string; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly crossEncoder: CrossEncoderPin | null;
  readonly sanity: SanityResult | null;
  readonly memoryPath: Readonly<Record<string, QueryLatencyBlock>>;
  readonly cross: Readonly<Record<string, CrossProbeArm>>;
  readonly rerank: Readonly<Record<string, unknown>>;
}

/** Scores the fixed probe selection (the same 20 seeded queries as the stage D probe) and records per-query latency. */
export async function probeCrossArm(scorer: PairScorer, topN: number, set: MemorySet, firstStage: readonly FirstStage[], clock: () => number = () => performance.now()): Promise<CrossProbeArm> {
  const picked = sampleQueries(set.queries, PROBE_RERANK_QUERIES, 'probe-rerank');
  const queries: { id: string; ms: number; goldInTopN: boolean; goldRankAfter: number | null }[] = [];
  for (const query of picked) {
    const stage = limitStage(firstStage[set.queries.indexOf(query as MemoryQuery)] as FirstStage, topN);
    const started = clock();
    const scores = await scorer.score(query.text, stage.candidates.map((candidate) => candidate.text));
    const ms = r3(clock() - started);
    const ranking = reorderRanking(stage, scores);
    const firstRank = goldRank(set, stage.ranking, query.gold);
    queries.push({ id: query.id, ms, goldInTopN: firstRank !== null && firstRank <= stage.candidates.length, goldRankAfter: goldRank(set, ranking, query.gold) });
  }
  const p = percentiles(queries.map((q) => q.ms));
  return { selectionSha: selectionSha(picked), queries, p50: r3(p.p50), p95: r3(p.p95), max: queries.length === 0 ? 0 : Math.max(...queries.map((q) => q.ms)) };
}

export function probeLinesE(report: StageEProbeReport): string[] {
  const out = [`eval:chunk stage E probe — plan ${report.plan.digest}`];
  if (report.sanity !== null) out.push(`cross-encoder sanity: relevant ${report.sanity.relevant.toFixed(3)} vs unrelated ${report.sanity.unrelated.toFixed(3)} — ${report.sanity.ok ? 'ok' : 'FAILED'}`);
  for (const [id, block] of Object.entries(report.memoryPath)) out.push(`${id} memory-path query embed (${block.sample} queries after 1 warm-up): p50 ${block.p50} ms p95 ${block.p95} ms max ${block.max} ms — ${block.meetsBar ? 'within' : 'over'} ${block.barMs} ms${block.reason === null ? '' : ` (${block.reason})`}`);
  for (const [id, arm] of Object.entries(report.cross)) {
    out.push(`${id} cross-encoder, ${arm.queries.length} queries (selection ${arm.selectionSha.slice(0, 12)}): p50 ${arm.p50} ms p95 ${arm.p95} ms max ${arm.max} ms`);
    for (const query of arm.queries) out.push(`  ${query.id}: ${query.ms} ms; gold ${query.goldInTopN ? 'in' : 'outside'} top-N, rank after rerank ${query.goldRankAfter ?? '-'}`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped: ${report.plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}`);
  out.push('status: NON-GATING');
  return out;
}
