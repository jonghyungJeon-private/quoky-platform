/**
 * ADR-0124 phase 1: the zero-model-call plan, its digest, and the stage B probe. The plan reads the pins (version and tags
 * from the loopback daemon; no embedding call), counts what each arm would embed after cache hits and prints a digest. A
 * model-in-the-loop `run` or `probe` must carry that digest (AGENTS.md: Strict action on a plan digest).
 */
import { createHash } from 'node:crypto';
import { percentiles } from '../selector-rag/embed';
import {
  ArmEmbedder,
  BATCH_SIZE,
  KEEP_ALIVE,
  LATENCY_BUDGET_MS,
  LATENCY_PASSAGES,
  RRF_K,
  costOf,
  fitOf,
  inScope,
  itemsFor,
  latencyCalls,
  measureLatency,
  type ArmId,
  type ArmPin,
  type CaseBundle,
  type CostReport,
  type EmbedItem,
  type FitReport,
  type LatencyBlock,
  type PlanCount,
  type ResolvedArms,
  type Scope,
} from './embed-arms';
import { memoryItems } from './memory-eval';
import { MEMORY_CUT_UNITS, type MemorySet } from './memory-set';

export const PLAN_VERSION = 'chunk-embed-plan.v1';

export interface PlanSets {
  readonly v1: { readonly digest: string };
  readonly v2: { readonly digest: string };
  readonly memory: { readonly digest: string };
}

/** Every parameter that shapes a measurement. Part of the digest, so a changed parameter is a different plan. */
export const PLAN_PARAMETERS = {
  batch: BATCH_SIZE,
  concurrency: 1,
  truncate: false,
  keepAlive: KEEP_ALIVE,
  rrfK: RRF_K,
  ks: [1, 3, 5, 10],
  ndcgK: 10,
  memoryCutUnits: MEMORY_CUT_UNITS,
  latency: { passages: LATENCY_PASSAGES, queries: 1, budgetMs: LATENCY_BUDGET_MS, sample: 'v2 C1 passage texts in case order, de-duplicated, fixed stride, language-grouped batches of 16', memoryRun: 'one untimed warm-up call, then the timed block', probe: 'a cold block then a warm block, both cache bypassed' },
  window: 'EL greedy one-window packing over the arm ranking',
  verdictInput: 'multi-vector Recall@5 per language on CH7',
} as const;

export interface PlanInputs {
  readonly sets: PlanSets;
  readonly resolved: ResolvedArms;
  readonly scope: Scope;
  readonly shapes?: readonly string[];
}

const pinKey = (pin: ArmPin): object => ({ arm: pin.arm, model: pin.model, digest12: pin.digest12, ollamaVersion: pin.ollamaVersion, spaceId: pin.spaceId, queryPrefix: pin.queryPrefix, documentPrefix: pin.documentPrefix });

export function planDigest(input: PlanInputs): string {
  const body = {
    version: PLAN_VERSION,
    sets: input.sets,
    planned: input.resolved.planned,
    arms: input.resolved.available.map(pinKey),
    dropped: input.resolved.dropped.map((d) => d.arm),
    scope: input.scope,
    shapes: input.shapes === undefined || input.shapes.length === 0 ? null : [...input.shapes].sort(),
    parameters: PLAN_PARAMETERS,
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export interface ArmPlan {
  readonly arm: ArmId;
  readonly pin: object;
  readonly v1: { readonly cases: number; readonly queries: PlanCount; readonly passages: PlanCount };
  readonly v2: { readonly cases: number; readonly queries: PlanCount; readonly passages: PlanCount };
  readonly memory: { readonly queries: PlanCount; readonly singles: PlanCount; readonly passages: PlanCount };
  readonly latencyBlockCalls: { readonly memoryRun: number; readonly probe: number };
  readonly embeddingCalls: number;
}
export interface PlanReport {
  readonly kind: 'chunk-eval-embed-plan';
  readonly digest: string;
  readonly scope: Scope;
  readonly shapes: readonly string[] | null;
  readonly sets: PlanSets;
  readonly planned: readonly string[];
  readonly dropped: readonly { readonly arm: string; readonly reason: string }[];
  readonly arms: readonly ArmPlan[];
  readonly parameters: typeof PLAN_PARAMETERS;
  readonly note: string;
}

export interface PlanData {
  readonly v1: readonly CaseBundle[];
  readonly v2: readonly CaseBundle[];
  readonly memory: MemorySet;
  readonly sample: readonly EmbedItem[];
}

export function buildPlanReport(input: PlanInputs, embedders: readonly ArmEmbedder[], data: PlanData): PlanReport {
  const arms = embedders.map((embedder): ArmPlan => {
    const arm = embedder.pin.arm;
    const forSet = (set: 'v1' | 'v2', bundles: readonly CaseBundle[]): ArmPlan['v1'] => {
      const scoped = bundles.filter((bundle) => inScope(input.scope, input.shapes, set, arm, bundle.item));
      const items = itemsFor(scoped);
      return { cases: scoped.length, queries: embedder.plan('query', items.queries), passages: embedder.plan('document', items.passages) };
    };
    const v1 = forSet('v1', data.v1);
    const v2 = forSet('v2', data.v2);
    const mem = memoryItems(data.memory);
    const memory = { queries: embedder.plan('query', mem.queries), singles: embedder.plan('document', mem.singles), passages: embedder.plan('document', mem.passages) };
    const latencyBlockCalls = { memoryRun: latencyCalls(data.sample, true), probe: 2 * latencyCalls(data.sample, false) };
    const embeddingCalls = v1.queries.calls + v1.passages.calls + v2.queries.calls + v2.passages.calls + memory.queries.calls + memory.singles.calls + memory.passages.calls + latencyBlockCalls.memoryRun;
    return { arm, pin: pinKey(embedder.pin), v1, v2, memory, latencyBlockCalls, embeddingCalls };
  });
  return {
    kind: 'chunk-eval-embed-plan',
    digest: planDigest(input),
    scope: input.scope,
    shapes: input.shapes === undefined || input.shapes.length === 0 ? null : [...input.shapes],
    sets: input.sets,
    planned: input.resolved.planned,
    dropped: input.resolved.dropped,
    arms,
    parameters: PLAN_PARAMETERS,
    note: 'Zero model calls: pins come from the loopback daemon version and tags; counts come from the on-disk cache. embeddingCalls counts the three set runs plus the memory run latency block; a probe adds latencyBlockCalls.probe. A batch refused as over context is retried one by one, which adds calls not counted here.',
  };
}

export function planLines(plan: PlanReport): string[] {
  const out = [`eval:chunk embedder plan (no model call) — scope ${plan.scope}${plan.shapes === null ? '' : `, shapes ${plan.shapes.join(',')}`}`];
  out.push(`sets: v1 ${plan.sets.v1.digest.slice(0, 12)}, v2 ${plan.sets.v2.digest.slice(0, 12)}, memory ${plan.sets.memory.digest.slice(0, 12)}`);
  out.push(`planned arms: ${plan.planned.join(', ')}${plan.dropped.length > 0 ? `; dropped (not installed): ${plan.dropped.map((d) => d.arm).join(', ')}` : ''}`);
  for (const arm of plan.arms) {
    const pin = arm.pin as { model: string; digest12: string; ollamaVersion: string; spaceId: string };
    out.push(`${arm.arm} ${pin.model}@${pin.digest12} ollama${pin.ollamaVersion}`);
    const line = (name: string, cases: number | undefined, q: PlanCount, p: PlanCount): string =>
      `  ${name.padEnd(7)}${cases === undefined ? '' : ` ${cases} cases;`} queries ${q.toEmbed}/${q.unique} to embed (${q.cacheHits} cached, ${q.calls} calls); passages ${p.toEmbed}/${p.unique} (${p.cacheHits} cached, ${p.calls} calls)`;
    out.push(line('v1', arm.v1.cases, arm.v1.queries, arm.v1.passages), line('v2', arm.v2.cases, arm.v2.queries, arm.v2.passages));
    out.push(line('memory', undefined, arm.memory.queries, arm.memory.passages) + `; whole memories ${arm.memory.singles.toEmbed}/${arm.memory.singles.unique} (${arm.memory.singles.calls} calls)`);
    out.push(`  latency block: ${arm.latencyBlockCalls.memoryRun} calls in the memory run, ${arm.latencyBlockCalls.probe} in a probe; embedding calls for the three set runs ${arm.embeddingCalls}`);
  }
  out.push(`plan digest: ${plan.digest}`);
  return out;
}

// ---------------------------------------------------------------- probe (stage B)

export interface ProbeArm {
  readonly pin: object;
  readonly cold: LatencyBlock;
  readonly warm: LatencyBlock;
  readonly callMs: { readonly p50: number; readonly p95: number };
  readonly fit: FitReport;
  readonly cost: CostReport;
}
export interface ProbeReport {
  readonly kind: 'chunk-eval-embed-probe';
  readonly status: 'NON-GATING';
  readonly plan: { readonly digest: string; readonly planned: readonly string[]; readonly dropped: readonly { readonly arm: string; readonly reason: string }[] };
  readonly sample: { readonly passages: number; readonly sha256: string };
  readonly arms: Readonly<Record<string, ProbeArm>>;
}

export const sampleDigest = (sample: readonly EmbedItem[]): string => createHash('sha256').update(JSON.stringify(sample.map((item) => [item.language, item.text]))).digest('hex');

/** Per arm: the fixed sample (+1 query) embedded cold and then warm, cache bypassed; tokens per syllable and resident memory. */
export async function runProbeArm(embedder: ArmEmbedder, sample: readonly EmbedItem[], query: EmbedItem): Promise<ProbeArm> {
  const cold = await measureLatency(embedder, query, sample, false);
  const warm = await measureLatency(embedder, query, sample, false);
  const resident = await embedder.residentMemory();
  const p = percentiles(embedder.calls.slice(cold.calls).map((call) => call.ms));
  return { pin: pinKey(embedder.pin), cold, warm, callMs: { p50: Math.round(p.p50 * 1000) / 1000, p95: Math.round(p.p95 * 1000) / 1000 }, fit: fitOf(embedder), cost: costOf(embedder, resident) };
}

export function probeLines(report: ProbeReport): string[] {
  const out = [`eval:chunk embedder probe — ${report.sample.passages}-passage sample ${report.sample.sha256.slice(0, 12)}, plan ${report.plan.digest}`];
  for (const [id, arm] of Object.entries(report.arms)) {
    const pin = arm.pin as { model: string; digest12: string };
    out.push(`${id} ${pin.model}@${pin.digest12}: cold ${arm.cold.time200Ms} ms (first call ${arm.cold.firstCallMs} ms), warm ${arm.warm.time200Ms} ms for 200 passages + 1 query (${arm.warm.meetsBar ? 'within' : 'over'} ${arm.warm.budgetMs} ms); call p50 ${arm.callMs.p50} p95 ${arm.callMs.p95} ms`);
    out.push(`  fit: overContext ${arm.fit.overContext}; ${Object.entries(arm.fit.byLanguage).map(([language, f]) => `${language} tok/syl ${f.tokensPerHangulSyllable ?? '-'} tok/cp ${f.tokensPerCodePoint ?? '-'}`).join('; ')}; resident ${arm.cost.resident === null ? 'n/a' : `${Math.round(arm.cost.resident.sizeBytes / 1_048_576)} MiB`}`);
  }
  if (report.plan.dropped.length > 0) out.push(`dropped (not installed): ${report.plan.dropped.map((d) => d.arm).join(', ')}`);
  out.push('status: NON-GATING');
  return out;
}

