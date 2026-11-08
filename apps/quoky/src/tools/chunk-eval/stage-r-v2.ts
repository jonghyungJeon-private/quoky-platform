/**
 * ADR-0124 phase 2 P2-3 validation: stage R on the CH8 set (`--set memory-v2 --stage R`).
 *
 * Same runtime path as stage R (the real SqliteStorageProvider, OllamaCliEmbeddingProvider, LocalVectorProvider, the production
 * memory scorer and DefaultMemoryRetriever with default options), with two differences for CH8: `updatedAt` comes from each memory's authored
 * `daysAgo` relative to the fixed retrieval time (not the seeded spread), and the blend comparison is the pre-declared VALIDATION of
 * `blend-validation.ts` (B0, B1, B2; Recall@5 / MRR@10 per language and category; newer-first rate; advisory verdict), not a sweep.
 *
 * This is a separate module on purpose: the stage R plan digest covers the bytes of `stage-r.ts` and `blend-sweep.ts`, and the CH7 plan
 * digests must not change, so the CH7 files are not edited. The run body below follows `runRuntimeArm` of `stage-r.ts` line by line
 * (a drift test pins the shared pieces); only the timestamps and the blend report differ.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Capability,
  DefaultMemoryRetriever,
  MemoryType,
  NoProviderAvailableError,
  createMemoryRetrievalRequest,
  durableMemoryCollectionFor,
  type AiProvider,
  type DurableMemoryByIdsQuery,
  type DurableMemoryQuery,
  type Logger,
  type MemoryRecord,
  type MemoryRepository,
  type ProviderSelector,
  type SemanticRecallScoring,
  type SemanticRecallSession,
} from '@quoky/core';
import type { SemanticRecallScorer } from '@quoky/core';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { LocalVectorProvider } from '@quoky/vector-local';
import { BACKFILL_BATCH } from '../../memory-vector-backfill';
import { createProductionMemoryBackfill, createProductionMemoryScorer } from '../../context-builder-provider';
import { percentiles } from '../selector-rag/embed';
import { LANGUAGES } from './corpus';
import { pathMetrics, type PathMetrics } from './memory-eval';
import type { MemorySet } from './memory-set';
import { CH8_CATEGORIES, MEMORY_V2_RETRIEVAL_TIME, type Ch8Set } from './memory-set-v2';
import { BLEND_RULES, clamp01, contentKeyOf, lexicalScoreOf, recencyOf } from './blend-sweep';
import { VALIDATION_CANDIDATE_IDS, VERDICT_RULE, blendValidationLines, buildBlendValidation, validationCandidates, type BlendValidation, type ValidationQuery } from './blend-validation';
import {
  ACTOR_ID,
  IMPLEMENTATION_FILES,
  RUNTIME_CONSTANTS,
  STAGE_R_PARAMETERS,
  canonicalModes,
  runsOf,
  stageRModel,
  vectorUnitsOf,
  type RunMode,
  type RuntimeDiagnostics,
  type RuntimeEmbeddingProvider,
  type StageRArmId,
  type StageRInputs,
  type StageRPin,
  type StageRPlanReport,
} from './stage-r';

export const STAGE_R_V2_PLAN_VERSION = 'runtime-recall-plan.v3-ch8';
export const SEED_LABEL_V2 = 'quoky-adr-0124-p2-3-ch8-validation-2026-11-09';
const DAY_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------- implementation identity and parameters (part of the plan digest)

const REPO_ROOT = resolve(__dirname, '../../../../..');
/** The CH7 stage R runtime files plus the CH8 modules (repo-relative). */
export const IMPLEMENTATION_FILES_V2 = [
  ...IMPLEMENTATION_FILES,
  'apps/quoky/src/tools/chunk-eval/memory-set-v2.ts',
  'apps/quoky/src/tools/chunk-eval/blend-validation.ts',
  'apps/quoky/src/tools/chunk-eval/stage-r-v2.ts',
] as const;

export type ImplementationHashesV2 = Readonly<Record<string, string>>;
let hashCache: ImplementationHashesV2 | undefined;
export function implementationHashesV2(root: string = REPO_ROOT): ImplementationHashesV2 {
  if (root === REPO_ROOT && hashCache !== undefined) return hashCache;
  const out: Record<string, string> = {};
  for (const file of IMPLEMENTATION_FILES_V2) out[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  if (root === REPO_ROOT) hashCache = out;
  return out;
}

export const STAGE_R_V2_PARAMETERS = {
  seed: SEED_LABEL_V2,
  set: 'CH8 (chunk-eval-memory.v2): hand-written, 120 memories and 150 queries tagged paraphrase / shared / recency-wins / old-relevant',
  retrievalTime: MEMORY_V2_RETRIEVAL_TIME,
  updatedAt: 'authored daysAgo per memory: RETRIEVAL_TIME minus daysAgo days (no seeded spread, no draw)',
  actorId: ACTOR_ID,
  storage: STAGE_R_PARAMETERS.storage,
  runtime: RUNTIME_CONSTANTS,
  warmCompleteness: STAGE_R_PARAMETERS.warmCompleteness,
  modes: STAGE_R_PARAMETERS.modes,
  validation: {
    kind: VERDICT_RULE.kind,
    candidates: validationCandidates(),
    candidateIds: VALIDATION_CANDIDATE_IDS,
    categories: CH8_CATEGORIES,
    metrics: 'Recall@5 and MRR@10 overall, per language and per category; newer-first rate on recency-wins (gold ranks above staleId in the top 10; stale absent with gold present counts; gold absent does not)',
    fidelity: BLEND_RULES.fidelity,
    floor: BLEND_RULES.floor,
    verdictRule: VERDICT_RULE,
    semanticArms: 'backfilled and warm modes only (offline re-ranking of the observed candidate table)',
  },
  ranking: STAGE_R_PARAMETERS.ranking,
  diagnostics: STAGE_R_PARAMETERS.diagnostics,
  status: 'NON-GATING (the verdict is advisory)',
} as const;

// ---------------------------------------------------------------- authored timestamps

/** `updatedAt` per memory: the fixed retrieval time minus the authored `daysAgo`. */
export function updatedAtOfV2(set: Pick<Ch8Set, 'memories'>): Map<string, string> {
  const end = Date.parse(MEMORY_V2_RETRIEVAL_TIME);
  return new Map(set.memories.map((memory) => [memory.id, new Date(end - memory.daysAgo * DAY_MS).toISOString()]));
}

/** Memory records built exactly like stage R's `memoryRecordsOf`, with the authored timestamps. */
export const memoryRecordsOfV2 = (set: Ch8Set): MemoryRecord[] => {
  const stamps = updatedAtOfV2(set);
  return set.memories.map((memory) => ({
    id: memory.id,
    type: MemoryType.LONG_TERM,
    scope: { userId: ACTOR_ID },
    content: memory.text,
    metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT' },
    createdAt: stamps.get(memory.id) as string,
    updatedAt: stamps.get(memory.id) as string,
  }));
};

// ---------------------------------------------------------------- plan

export interface StageRV2Inputs extends Omit<StageRInputs, 'set'> {
  readonly set: { readonly digest: string; readonly memories: number; readonly queries: number };
}

export function stageRV2Digest(input: StageRV2Inputs, parameters: unknown = STAGE_R_V2_PARAMETERS, implementation: ImplementationHashesV2 = implementationHashesV2()): string {
  const body = { version: STAGE_R_V2_PLAN_VERSION, stage: 'R', set: input.set, planned: input.planned, pins: input.pins, dropped: input.dropped.map((d) => d.arm), modes: canonicalModes(input.modes), parameters, implementation };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export interface StageRV2PlanReport extends Omit<StageRPlanReport, 'version' | 'parameters'> {
  readonly version: typeof STAGE_R_V2_PLAN_VERSION;
  readonly parameters: typeof STAGE_R_V2_PARAMETERS;
}

export function buildStageRV2Plan(input: StageRV2Inputs, set: Pick<Ch8Set, 'memories' | 'queries'>): StageRV2PlanReport {
  return {
    kind: 'chunk-eval-stage-r-plan',
    version: STAGE_R_V2_PLAN_VERSION,
    digest: stageRV2Digest(input),
    set: input.set,
    planned: input.planned,
    dropped: input.dropped,
    modes: canonicalModes(input.modes),
    pins: input.pins,
    runs: runsOf(input.planned, input.dropped, set, canonicalModes(input.modes)),
    parameters: STAGE_R_V2_PARAMETERS,
    note: 'Zero model calls in plan mode (pins from the loopback daemon, prefixes from the real provider against a recording runner). A run calls `ollama run` once per query embedding and once per document embedding; counts are upper bounds. CH8 is a pre-declared validation of B0/B1/B2 with an advisory verdict; nothing is selected.',
  };
}

export function planLinesRV2(plan: StageRV2PlanReport): string[] {
  const out = [`eval:chunk stage R plan on CH8 (no model call) - ${plan.version}, memory set ${plan.set.digest.slice(0, 12)} (${plan.set.memories} memories, ${plan.set.queries} queries)`];
  out.push(`planned arms: ${plan.planned.join(', ')}${plan.dropped.length > 0 ? `; dropped: ${plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}` : ''}`);
  for (const pin of plan.pins) out.push(`${pin.arm} ${pin.model}@${pin.digest12} ollama${pin.ollamaVersion}: runtime prefixes query ${JSON.stringify(pin.runtimeQueryPrefix)} document ${JSON.stringify(pin.runtimeDocumentPrefix)} (the provider's own defaults)`);
  out.push(`semantic run modes: ${plan.modes.join(', ')} (part of the digest)`);
  out.push(`validation (not selection): candidates ${VALIDATION_CANDIDATE_IDS.join(', ')}; verdict rule (in the digest): ${VERDICT_RULE.text}`);
  out.push(`updatedAt = authored daysAgo before ${MEMORY_V2_RETRIEVAL_TIME}; actor ${ACTOR_ID}`);
  for (const run of plan.runs) out.push(`run ${run.arm}/${run.mode}: ${run.queries} queries${run.modelCallsUpperBound === null || run.modelCallsUpperBound === 0 ? ', no model call' : `, up to ${run.modelCallsUpperBound} ollama calls`}`);
  out.push(`plan digest: ${plan.digest}`);
  return out;
}

// ---------------------------------------------------------------- one arm run through the real runtime classes

export interface RuntimeArmRunV2 {
  readonly arm: StageRArmId;
  readonly mode: RunMode;
  readonly model: string | null;
  readonly metrics: PathMetrics;
  readonly diagnostics: RuntimeDiagnostics;
  /** The pre-declared B0/B1/B2 validation; null for the lexical arm and live mode. */
  readonly blendValidation: BlendValidation | null;
  readonly prewarm: { readonly stored: number; readonly of: number; readonly scoringCalls: number; readonly storeCount: number; readonly missing: number } | null;
  readonly invalid: { readonly reason: string; readonly missing: number } | null;
}

export interface RunOptionsV2 {
  readonly arm: StageRArmId;
  readonly mode: RunMode;
  readonly set: Ch8Set;
  readonly provider?: RuntimeEmbeddingProvider;
  readonly workDir: string;
  readonly clock?: () => number;
}

const share = (n: number, of: number): { n: number; share: number } => ({ n, share: of === 0 ? 0 : Math.round((n / of) * 10_000) / 10_000 });

const fixedSelector = (provider: AiProvider): ProviderSelector => ({
  async select(capability) {
    if (capability !== Capability.EMBEDDING) throw new NoProviderAvailableError(capability);
    return provider;
  },
});

const invalidRun = (arm: StageRArmId, mode: RunMode, prewarm: NonNullable<RuntimeArmRunV2['prewarm']>, reason: string): RuntimeArmRunV2 => ({
  arm,
  mode,
  model: arm === 'L' ? null : stageRModel(arm),
  metrics: pathMetrics({ memories: [], queries: [] } as unknown as MemorySet, []),
  diagnostics: { queries: 0, goldNotInPool: share(0, 0), goldNoSemanticScore: null, goldInPoolNoSemanticScore: null, poolSize: { min: 0, max: 0 }, scorerNullQueries: 0, fallbackReasons: {}, embeddedDocuments: 0, latencyMs: { p50: 0, p95: 0 } },
  blendValidation: null,
  prewarm,
  invalid: { reason, missing: prewarm.missing },
});

export async function runRuntimeArmV2(options: RunOptionsV2): Promise<RuntimeArmRunV2> {
  const { arm, mode, set } = options;
  const clock = options.clock ?? (() => performance.now());
  mkdirSync(options.workDir, { recursive: true });
  const storage = new SqliteStorageProvider({ dbPath: join(options.workDir, 'memory.db') });
  await storage.init();
  try {
    for (const record of memoryRecordsOfV2(set)) await storage.memories.save(record);

    // observers only: they record what the real classes returned and change nothing
    let poolIds = new Set<string>();
    let recentIds = new Set<string>();
    // the exact list the retriever offered the scorer (its eligible set after the top-K merge), observed at the scorer
    let offered: readonly { id: string }[] | null = null;
    const poolSizes: number[] = [];
    const repository: MemoryRepository = {
      get: (id) => storage.memories.get(id),
      save: (record) => storage.memories.save(record),
      delete: (id) => storage.memories.delete(id),
      list: () => storage.memories.list(),
      findByScope: (scope, type) => storage.memories.findByScope(scope, type),
      findDurableCandidates: async (query: DurableMemoryQuery) => {
        const records = await storage.memories.findDurableCandidates(query);
        poolIds = new Set(records.map((record) => record.id));
        recentIds = new Set(poolIds);
        poolSizes.push(records.length);
        return records;
      },
      findDurableCandidatesByIds: async (query: DurableMemoryByIdsQuery) => {
        const records = await storage.memories.findDurableCandidatesByIds!(query);
        for (const record of records) poolIds.add(record.id);
        poolSizes[poolSizes.length - 1] = poolIds.size;
        return records;
      },
      findShortTermByUser: (userId) => storage.memories.findShortTermByUser(userId),
    };
    const fallbackReasons: Record<string, number> = {};
    let embeddedDocuments = 0;
    let observing = false;
    const logger: Logger = {
      info: (_message, fields) => {
        if (observing && typeof fields?.embedded === 'number') embeddedDocuments += fields.embedded;
      },
      warn: (_message, fields) => {
        if (!observing) return;
        const reason = typeof fields?.reason === 'string' ? fields.reason : 'UNKNOWN';
        fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
        if (typeof fields?.embedded === 'number') embeddedDocuments += fields.embedded;
      },
      error: () => undefined,
    };

    let scorer: SemanticRecallScorer | undefined;
    let lastScores: ReadonlyMap<string, number> | null = null;
    let prewarm: RuntimeArmRunV2['prewarm'] = null;
    let semantic: SemanticRecallScoring | undefined;
    if (arm !== 'L') {
      const provider = options.provider as RuntimeEmbeddingProvider;
      const vectors = new LocalVectorProvider(join(options.workDir, 'vectors'));
      await vectors.init();
      let dimension = 0;
      let spaceId: string | undefined;
      const observed = {
        upsert: (collection: string, records: Parameters<LocalVectorProvider['upsert']>[1]) => {
          for (const record of records) {
            dimension = record.vector.length;
            if (typeof record.metadata?.space === 'string') spaceId = record.metadata.space;
          }
          return vectors.upsert(collection, records);
        },
        query: (collection: string, vector: number[], topK: number) => vectors.query(collection, vector, topK),
        delete: (collection: string, ids: Parameters<LocalVectorProvider['delete']>[1]) => vectors.delete(collection, ids),
      } as unknown as LocalVectorProvider;
      // the production scorer itself (context-builder-provider.ts): local-only selector, multi-vector, collection per space
      scorer = createProductionMemoryScorer({
        selector: fixedSelector(provider),
        vectors: observed,
        logger,
        timeoutMs: RUNTIME_CONSTANTS.embeddingTimeoutMs,
        maxNewPerTurn: RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn,
      });
      // like the router at startup: one availability probe, then let the background warm-up finish before any turn
      await provider.isAvailable().catch(() => false);
      await provider.warmUpSettled?.();
      if (mode === 'warm' || mode === 'backfilled') {
        const candidates = set.memories.map((memory) => ({ id: memory.id, content: memory.text }));
        const units = vectorUnitsOf(set);
        const wanted = new Set(units.map((unit) => unit.vectorId));
        const countStored = async (): Promise<number> => {
          if (dimension === 0 || spaceId === undefined) return 0;
          const inStore = await vectors.query(durableMemoryCollectionFor(spaceId), new Array<number>(dimension).fill(1), RUNTIME_CONSTANTS.vectorQueryLimit);
          return new Set(inStore.filter((hit) => wanted.has(hit.id) && hit.metadata?.space === spaceId).map((hit) => hit.id)).size;
        };
        let stored = 0;
        let calls = 0;
        if (mode === 'backfilled') {
          // the REAL production backfill job (ADR-0124 5.4) runs to completion before any query: what the owner has once it caught up
          const job = createProductionMemoryBackfill(storage, {
            selector: fixedSelector(provider),
            vectors: observed,
            timeoutMs: RUNTIME_CONSTANTS.embeddingTimeoutMs,
            maxNewPerTurn: RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn,
          });
          const limit = Math.ceil(units.length / BACKFILL_BATCH) + 20;
          let ticks = 0;
          for (; ticks < limit; ticks += 1) {
            const tick = await job.runOnce();
            if (tick.state !== 'working') break;
          }
          calls = ticks + 1;
          stored = await countStored();
        } else {
          const limit = Math.ceil(units.length / RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn) + 20;
          while (stored < units.length && calls < limit) {
            calls += 1;
            await scorer.score('warm-up', candidates);
            stored = await countStored();
          }
        }
        // the store itself must hold a vector (of the arm's space) for every unit
        const missing = units.length - stored;
        prewarm = { stored, of: units.length, scoringCalls: calls, storeCount: stored, missing };
        if (missing > 0) return invalidRun(arm, mode, prewarm, `${mode} prewarming incomplete: ${missing} of ${units.length} vectors are not stored after ${calls} passes`);
      }
      const inner = scorer;
      // observer only: records the scores the real scorer session returned and changes nothing
      semantic = {
        async score(query, candidates) {
          offered = candidates;
          const result = await inner.score(query, candidates);
          lastScores = result;
          return result;
        },
        async openSession(query) {
          const session = await inner.openSession(query);
          if (session === null) return null;
          const observedSession: SemanticRecallSession = {
            nearestMemoryIds: (limit) => session.nearestMemoryIds(limit),
            async score(candidates) {
              offered = candidates;
              const result = await session.score(candidates);
              lastScores = result;
              return result;
            },
          };
          return observedSession;
        },
      };
    }

    const retriever = new DefaultMemoryRetriever(repository, { clock: () => MEMORY_V2_RETRIEVAL_TIME, ...(semantic === undefined ? {} : { semanticScorer: semantic }) });
    const sweepOn = arm !== 'L' && (mode === 'backfilled' || mode === 'warm');
    const stamps = updatedAtOfV2(set);
    const textOf = new Map(set.memories.map((memory) => [memory.id, memory.text]));
    const tables: ValidationQuery[] = [];
    const ranks: (number | null)[] = [];
    const latencies: number[] = [];
    let notInPool = 0;
    let noScore = 0;
    let inPoolNoScore = 0;
    let scorerNull = 0;
    observing = true;
    for (const query of set.queries) {
      lastScores = null;
      offered = null;
      poolIds = new Set();
      recentIds = new Set();
      const started = clock();
      const results = await retriever.retrieve(
        createMemoryRetrievalRequest({ query: query.text, capability: Capability.GENERAL_CHAT, scope: { actorId: ACTOR_ID }, authorityFitness: RUNTIME_CONSTANTS.authorityFitness, maxResults: RUNTIME_CONSTANTS.maxResults }),
      );
      latencies.push(clock() - started);
      const at = results.findIndex((result) => query.gold.includes(result.memory.id));
      ranks.push(at < 0 ? null : at + 1);
      if (sweepOn) {
        // the candidate table as the retriever saw it: without a semantic result only the recent pool is ranked (memory-retriever.ts)
        const scores = lastScores as ReadonlyMap<string, number> | null;
        // with a scorer result the table is exactly what the retriever offered it (records fetched by id but cut by the top-K merge never were);
        // without one the retriever ranks the eligible recent pool alone (every CH7 memory of the actor is eligible)
        const offeredIds = offered as readonly { id: string }[] | null;
        const tableIds = scores !== null && offeredIds !== null ? offeredIds.map((candidate) => candidate.id) : [...recentIds];
        const rows = tableIds.map((id) => {
          const content = textOf.get(id) as string;
          const updatedAt = stamps.get(id) as string;
          const raw = scores?.get(id);
          return { id, contentKey: contentKeyOf(content), updatedAt, lexical: lexicalScoreOf(query.text, content), recency: recencyOf(updatedAt, MEMORY_V2_RETRIEVAL_TIME, RUNTIME_CONSTANTS.recencyHalfLifeMs), semantic: raw === undefined || !Number.isFinite(raw) ? undefined : clamp01(raw) };
        });
        tables.push({ language: query.language, gold: query.gold, actual: results.map((result) => result.memory.id), rows, category: query.category, staleId: query.staleId });
      }
      const goldInPool = query.gold.some((id) => poolIds.has(id));
      if (!goldInPool) notInPool += 1;
      if (arm !== 'L') {
        const scores = lastScores as ReadonlyMap<string, number> | null;
        if (scores === null) scorerNull += 1;
        const scored = scores !== null && query.gold.some((id) => scores.has(id));
        if (!scored) noScore += 1;
        if (goldInPool && !scored) inPoolNoScore += 1;
      }
    }
    observing = false;
    const n = set.queries.length;
    return {
      arm,
      mode,
      model: arm === 'L' ? null : stageRModel(arm),
      metrics: pathMetrics(set, ranks),
      diagnostics: {
        queries: n,
        goldNotInPool: share(notInPool, n),
        goldNoSemanticScore: arm === 'L' ? null : share(noScore, n),
        goldInPoolNoSemanticScore: arm === 'L' ? null : share(inPoolNoScore, n),
        poolSize: { min: Math.min(...poolSizes), max: Math.max(...poolSizes) },
        scorerNullQueries: scorerNull,
        fallbackReasons,
        embeddedDocuments,
        latencyMs: (({ p50, p95 }) => ({ p50: Math.round(p50 * 10) / 10, p95: Math.round(p95 * 10) / 10 }))(percentiles(latencies)),
      },
      blendValidation: sweepOn ? buildBlendValidation(tables, LANGUAGES, CH8_CATEGORIES) : null,
      prewarm,
      invalid: null,
    };
  } finally {
    await storage.close();
  }
}

/** Runs one arm in a fresh temp dir (sqlite file and vector store), removed afterwards. */
export async function runArmFreshV2(options: Omit<RunOptionsV2, 'workDir'> & { tmpRoot?: string }): Promise<RuntimeArmRunV2> {
  const root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `quoky-stage-r-${options.arm}-${options.mode}-`));
  try {
    return await runRuntimeArmV2({ ...options, workDir: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- report

export interface StageRV2Report {
  readonly kind: 'chunk-eval-memory-stage-r-validation';
  readonly status: 'NON-GATING';
  readonly memorySetDigest: string;
  readonly plan: { readonly version: typeof STAGE_R_V2_PLAN_VERSION; readonly digest: string; readonly pins: readonly StageRPin[]; readonly planned: readonly StageRArmId[]; readonly dropped: StageRV2Inputs['dropped'] };
  readonly parameters: typeof STAGE_R_V2_PARAMETERS;
  readonly runs: readonly RuntimeArmRunV2[];
}

export function buildStageRV2Report(memorySetDigest: string, planBlock: StageRV2Report['plan'], runs: readonly RuntimeArmRunV2[]): StageRV2Report {
  return { kind: 'chunk-eval-memory-stage-r-validation', status: 'NON-GATING', memorySetDigest, plan: planBlock, parameters: STAGE_R_V2_PARAMETERS, runs };
}

const f3 = (value: number): string => value.toFixed(3);
const pct = (value: { n: number; share: number } | null): string => (value === null ? '-' : `${(value.share * 100).toFixed(1)}% (${value.n})`);

export function summaryLinesStageRV2(report: StageRV2Report): string[] {
  const out = [`eval:chunk stage R on CH8 (independent validation, NON-GATING) - plan ${report.plan.digest.slice(0, 12)}, memory set ${report.memorySetDigest.slice(0, 12)}`];
  for (const run of report.runs) {
    if (run.invalid !== null) {
      out.push(`${run.arm}/${run.mode}: INVALID - ${run.invalid.reason} (missing vectors ${run.invalid.missing}); no queries were run`);
      continue;
    }
    const by = (language: string): string => `${language} ${f3(run.metrics.byLanguage[language]?.recallAt5 ?? 0)}`;
    out.push(`${run.arm}/${run.mode}: all ${f3(run.metrics.overall.recallAt5)} (MRR ${f3(run.metrics.overall.mrr)}) ${LANGUAGES.map(by).join(' ')}`);
    const d = run.diagnostics;
    out.push(`  gold not in pool ${pct(d.goldNotInPool)}; gold unscored ${pct(d.goldNoSemanticScore)} (in pool but unscored ${pct(d.goldInPoolNoSemanticScore)}); scorer null ${d.scorerNullQueries}; embedded ${d.embeddedDocuments}; pool ${d.poolSize.min}-${d.poolSize.max}; latency p50 ${d.latencyMs.p50} ms / p95 ${d.latencyMs.p95} ms`);
  }
  for (const run of report.runs) {
    if (run.blendValidation === null) continue;
    out.push(`${run.arm}/${run.mode} blend validation (ADR-0124 P2-3, CH8, offline, NON-GATING):`);
    out.push(...blendValidationLines(run.blendValidation, LANGUAGES, CH8_CATEGORIES));
  }
  out.push('CH8 note: updatedAt values are authored (daysAgo), so recency-wins and old-relevant queries do exercise recency; the verdict is advisory and any production change is an owner decision.');
  return out;
}
