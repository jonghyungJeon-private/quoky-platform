/**
 * ADR-0124 phase 2 step P2-1 (owner decision 2026-11-06), CH7 memory set only: the RUNTIME-path recall measurement, stage R.
 *
 * Phases 1 stages A-E rank the CH7 memories with a harness-side scorer over ALL memories. The live service does something else:
 * `DefaultMemoryRetriever` takes the most recently updated candidates (`findDurableCandidates`, ORDER BY updatedAt DESC,
 * LIMIT max(limit * 5, 50)), since P2-2 widened by the memories nearest to the query in the vector store
 * (`findDurableCandidatesByIds`, K = 50, same SQL filters), applies the eligibility filters, scores lexically plus recency, asks the
 * optional `SemanticRecallScorer` (lazy embedding: at most 4 new vectors per turn, 3 s turn budget, one vector per passage of a long
 * memory, max cosine, collection per embedding space) and blends 0.7 semantic / 0.3 lexical. "Gates must match live": this stage
 * runs the CH7 queries through those real classes.
 *
 * What is real (constructed from the production classes, no re-implementation of any scoring or blending):
 *   - `SqliteStorageProvider` (its `memories` repository, real `findDurableCandidates` and `findDurableCandidatesByIds`) on a temp file,
 *   - `OllamaCliEmbeddingProvider` (`ollama run`, its OWN default role prefixes, not the harness ARM_SPECS prefixes),
 *   - `LocalVectorProvider` (fresh temp dir per arm and mode),
 *   - `createProductionMemoryScorer` of `context-builder-provider.ts` (the SAME function production uses: local-only selector,
 *     multi-vector, collection per space), `DefaultMemoryRetriever` with default options.
 * What mirrors `app.module.ts` / `context-builder.ts` by hand (`createProductionContextBuilder` builds the retriever inside and
 * does not expose it): the three request constants (`maxNewEmbeddingsPerTurn` 4,
 * `embeddingTimeoutMs` 3000 from config.ts, `maxResults` 10 and the authority fitness from context-builder.ts). The provider
 * selector is a fixed one (the router is not needed to pick the only EMBEDDING provider); like the router at startup, the run
 * probes `isAvailable()` once and lets the warm-up settle before the first query.
 *
 * Arms: L (no semantic scorer, no model), E0 (`nomic-embed-text`, the live model), E4 (`embeddinggemma:300m`). Semantic arms run in
 * two modes: `live` (empty vector store, lazy embedding as a fresh switch experiences it) and `warm` (every memory embedded first
 * through the same scorer, so only the candidate widening, the passage vectors and the blend remain). Status NON-GATING.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_EMBEDDING_INPUT_CHARS, OllamaCliEmbeddingProvider } from '@quoky/ai-cli';
import {
  Capability,
  DEFAULT_DURABLE_RECALL_LIMIT,
  DEFAULT_MAX_INDEXED_VECTORS,
  DEFAULT_MAX_NEW_EMBEDDINGS_PER_TURN,
  DEFAULT_SEMANTIC_TURN_BUDGET_MS,
  DEFAULT_SEMANTIC_WEIGHT,
  DefaultMemoryRetriever,
  MAX_PASSAGES_PER_MEMORY,
  SEMANTIC_CANDIDATE_TOP_K,
  MemoryType,
  NoProviderAvailableError,
  createMemoryRetrievalRequest,
  durableMemoryCollectionFor,
  localOnlyProviderSelector,
  memoryVectorUnits,
  type AiProvider,
  type DurableMemoryAuthorityLevel,
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
import { percentiles, type FetchLike } from '../selector-rag/embed';
import { ARM_SPECS, resolveArms, type ArmPin } from './embed-arms';
import { LANGUAGES, seeded } from './corpus';
import { pathMetrics, type PathMetrics } from './memory-eval';
import type { MemorySet } from './memory-set';

export const STAGE_R_PLAN_VERSION = 'runtime-recall-plan.v2';
export const STAGE_R_ARM_IDS = ['L', 'E0', 'E4'] as const;
export type StageRArmId = (typeof STAGE_R_ARM_IDS)[number];
export type SemanticArmId = Exclude<StageRArmId, 'L'>;
export type RunMode = 'lexical' | 'live' | 'backfilled' | 'warm';

export const parseStageRArm = (token: string): StageRArmId | undefined => (STAGE_R_ARM_IDS as readonly string[]).includes(token) ? (token as StageRArmId) : undefined;
export const isSemanticArm = (arm: StageRArmId): arm is SemanticArmId => arm !== 'L';

/** The models are the stage A-E ones by name (E0 = the live nomic model, E4 = EmbeddingGemma); the prefixes are the PROVIDER's own. */
export const stageRModel = (arm: SemanticArmId): string => ARM_SPECS[arm].model;

// ---------------------------------------------------------------- fixed parameters (all part of the plan digest)

export const SEED_LABEL = 'quoky-adr-0124-p2-1-runtime-recall-2026-11-06';
/** The injected retrieval time and the span the seeded `updatedAt` values spread over. */
export const RETRIEVAL_TIME = '2026-11-06T00:00:00.000Z';
export const SPREAD_DAYS = 180;
export const ACTOR_ID = 'ch7-runtime-actor';
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Mirrors `ContextBuilder` (DURABLE_RECALL_LIMIT, DURABLE_AUTHORITY_FITNESS) and config.ts (embedding timeout default). Where the
 * production module EXPORTS a constant it is imported; the rest are literals pinned against the production source by tests
 * (`stage-r.test.ts`: "literals match the production source"): maxResults and authorityFitness (context-builder.ts),
 * embeddingTimeoutMs (config.ts), the candidate fetch multiplier / minimum, recency weight and half-life (memory-retriever.ts).
 */
export const RUNTIME_CONSTANTS = {
  maxResults: 10,
  authorityFitness: ['USER_CLAIM_OR_INTENT', 'ASSISTANT_NON_AUTHORITATIVE', 'NON_AUTHORITATIVE_BACKGROUND'] as readonly DurableMemoryAuthorityLevel[],
  maxNewEmbeddingsPerTurn: DEFAULT_MAX_NEW_EMBEDDINGS_PER_TURN,
  embeddingTimeoutMs: 3_000,
  semanticTurnBudgetMs: DEFAULT_SEMANTIC_TURN_BUDGET_MS,
  vectorQueryLimit: DEFAULT_MAX_INDEXED_VECTORS,
  maxEmbeddingInputChars: MAX_EMBEDDING_INPUT_CHARS,
  vectorCollection: 'durable-memory-v2-<space slug>-<hash12>, space = <model>/<digest12>/p<prefix scheme hash8>',
  multiVector: true,
  maxPassagesPerMemory: MAX_PASSAGES_PER_MEMORY,
  semanticCandidateTopK: SEMANTIC_CANDIDATE_TOP_K,
  retrieverDefaultLimit: DEFAULT_DURABLE_RECALL_LIMIT,
  candidateFetchMultiplier: 5,
  candidateFetchMin: 50,
  recencyWeight: 0.25,
  recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1_000,
  semanticWeight: DEFAULT_SEMANTIC_WEIGHT,
  ollamaBin: 'ollama',
  candidatePool: 'findDurableCandidates (newest updatedAt first, LIMIT max(maxResults * 5, 50) = 50) plus findDurableCandidatesByIds (the K memories nearest to the query in the vector store, same SQL filters), deduplicated by id',
} as const;

// ---------------------------------------------------------------- implementation identity (part of the plan digest)

const REPO_ROOT = resolve(__dirname, '../../../../..');
/** The source files of the runtime classes a stage R run exercises (plus this file), repo-relative. */
export const IMPLEMENTATION_FILES = [
  'packages/core/src/application/memory-retriever.ts',
  'packages/core/src/application/recall/semantic-recall-scorer.ts',
  'packages/core/src/application/recall/embedding-envelope.ts',
  'packages/core/src/application/recall/memory-passages.ts',
  'packages/core/src/application/chunking/boundaries.ts',
  'packages/core/src/application/chunking/code-points.ts',
  'packages/core/src/application/chunking/coverage.ts',
  'packages/core/src/application/chunking/index.ts',
  'packages/core/src/application/chunking/lexical.ts',
  'packages/core/src/application/chunking/pack.ts',
  'packages/core/src/application/chunking/passages.ts',
  'packages/core/src/application/chunking/readout.ts',
  'packages/core/src/application/chunking/token-estimate.ts',
  'packages/core/src/application/chunking/types.ts',
  'apps/quoky/src/context-builder-provider.ts',
  'apps/quoky/src/memory-vector-backfill.ts',
  'packages/core/src/application/semantic-relevance.ts',
  'packages/ai-cli/src/ollama-embedding-provider.ts',
  'packages/ai-cli/src/cli-runner.ts',
  'packages/vector-local/src/index.ts',
  'packages/storage-sqlite/src/index.ts',
  'apps/quoky/src/tools/chunk-eval/stage-r.ts',
] as const;

export type ImplementationHashes = Readonly<Record<string, string>>;
let hashCache: ImplementationHashes | undefined;
/** sha256 of each runtime source file, read from the repo (cached per process). */
export function implementationHashes(root: string = REPO_ROOT): ImplementationHashes {
  if (root === REPO_ROOT && hashCache !== undefined) return hashCache;
  const out: Record<string, string> = {};
  for (const file of IMPLEMENTATION_FILES) out[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  if (root === REPO_ROOT) hashCache = out;
  return out;
}

export const STAGE_R_PARAMETERS = {
  seed: SEED_LABEL,
  retrievalTime: RETRIEVAL_TIME,
  spreadDays: SPREAD_DAYS,
  updatedAt: 'one seeded draw per memory in set order: RETRIEVAL_TIME minus floor(u * spreadDays * 86400000) ms; never tuned to the gold',
  actorId: ACTOR_ID,
  storage: 'real SqliteStorageProvider on a temp file, memories saved as LONG_TERM durable (USER_PROVIDED, SEMANTIC) for one actor',
  runtime: RUNTIME_CONSTANTS,
  warmCompleteness: 'warm mode requires a stored vector for every vector unit (the memory id for a short memory, one per passage for a long one) in the space collection before any query; otherwise the warm run is INVALID with the missing count',
  modes: { backfilled: 'the real production backfill job (memory-vector-backfill.ts, batch 8 per tick) runs to completion before the queries, then the same queries; requires a stored vector for every vector unit, otherwise INVALID', live: 'empty vector store; queries in the set order, one at a time; lazy embedding (<= 4 new vectors per turn, passages count one each, 3 s turn budget); an empty store widens nothing', warm: 'every vector unit embedded first through the same scorer (repeated scoring calls), then the same queries', lexical: 'no semantic scorer; no model' },
  ranking: 'the retriever results (top 10); gold rank outside the top 10 counts as a miss, so MRR is MRR@10 here',
  diagnostics: ['gold not in the candidate pool (recent 50 plus the semantic top-K)', 'gold without a semantic score', 'scorer fallbacks by reason', 'retrieval latency p50 / p95'],
  status: 'NON-GATING',
} as const;

// ---------------------------------------------------------------- seeded timestamps

/** Deterministic `updatedAt` per memory (set order): spread over `SPREAD_DAYS` before the retrieval time. */
export function seededUpdatedAt(set: MemorySet): Map<string, string> {
  const random = seeded(`${SEED_LABEL}/updatedAt`);
  const end = Date.parse(RETRIEVAL_TIME);
  const out = new Map<string, string>();
  for (const memory of set.memories) out.set(memory.id, new Date(end - Math.floor(random() * SPREAD_DAYS * DAY_MS)).toISOString());
  return out;
}

export const memoryRecordsOf = (set: MemorySet): MemoryRecord[] => {
  const stamps = seededUpdatedAt(set);
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

// ---------------------------------------------------------------- the real provider and its own prefixes

/** The provider the runtime builds (app.module.ts): `OllamaCliEmbeddingProvider` with the configured bin, model and timeout. */
export type RuntimeEmbeddingProvider = AiProvider & { warmUpSettled?: () => Promise<void> };
export type ProviderFactory = (model: string) => RuntimeEmbeddingProvider;

export const defaultProviderFactory: ProviderFactory = (model) =>
  new OllamaCliEmbeddingProvider({ bin: RUNTIME_CONSTANTS.ollamaBin, model, timeoutMs: RUNTIME_CONSTANTS.embeddingTimeoutMs });

/**
 * The role prefixes the REAL provider applies for `model`, read by running it once per role against a recording runner that
 * answers a fixed vector. No model and no process is involved (zero model calls).
 */
export async function runtimePrefixesOf(model: string): Promise<{ query: string; document: string }> {
  const seen: string[] = [];
  const provider = new OllamaCliEmbeddingProvider({
    model,
    warmUp: false,
    runner: async (_bin, args, options) => {
      // the provider asks `ollama list` for the model digest before it produces any vector (fail-closed space id)
      if (args[0] === '--version') return { code: 0, stdout: 'ollama version is 0.0.0\n', stderr: '', timedOut: false } as never;
      if (args[0] === 'list') return { code: 0, stdout: `NAME ID SIZE MODIFIED\n${model.includes(':') ? model : `${model}:latest`} ${'0'.repeat(12)} 1 GB now\n`, stderr: '', timedOut: false } as never;
      seen.push(options.input ?? '');
      return { code: 0, stdout: '[0.5,0.5]', stderr: '', timedOut: false } as never;
    },
  });
  const probe = 'PROBE';
  const read = async (role: 'query' | 'document'): Promise<string> => {
    seen.length = 0;
    await provider.execute({ capability: Capability.EMBEDDING, prompt: probe, metadata: { embeddingRole: role } });
    const input = seen[0] ?? probe;
    return input.endsWith(probe) ? input.slice(0, input.length - probe.length) : input;
  };
  return { query: await read('query'), document: await read('document') };
}

// ---------------------------------------------------------------- plan

export interface StageRPin {
  readonly arm: SemanticArmId;
  readonly model: string;
  readonly digest12: string;
  readonly ollamaVersion: string;
  readonly runtimeQueryPrefix: string;
  readonly runtimeDocumentPrefix: string;
}

export interface StageRInputs {
  readonly set: { readonly digest: string; readonly memories: number; readonly queries: number };
  readonly planned: readonly StageRArmId[];
  readonly pins: readonly StageRPin[];
  readonly dropped: readonly { readonly arm: string; readonly reason: string }[];
}

export function stageRDigest(input: StageRInputs, parameters: unknown = STAGE_R_PARAMETERS, implementation: ImplementationHashes = implementationHashes()): string {
  const body = { version: STAGE_R_PLAN_VERSION, stage: 'R', set: input.set, planned: input.planned, pins: input.pins, dropped: input.dropped.map((d) => d.arm), parameters, implementation };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export interface StageRResolution {
  readonly planned: StageRArmId[];
  readonly pins: StageRPin[];
  readonly dropped: { arm: string; reason: string }[];
}

/**
 * Pins the semantic arms from the loopback daemon (version, tags: no model call) and reads the runtime prefixes of each. An
 * installed-model check failure drops the arm with a note; a cloud model or a non-loopback daemon throws. Never pulls.
 */
export async function resolveStageR(requested: readonly StageRArmId[], options: { baseUrl?: string; fetchImpl?: FetchLike } = {}): Promise<StageRResolution> {
  const planned = STAGE_R_ARM_IDS.filter((arm) => requested.includes(arm));
  const semantic = planned.filter(isSemanticArm);
  const pins: StageRPin[] = [];
  const dropped: { arm: string; reason: string }[] = [];
  if (semantic.length > 0) {
    const resolved = await resolveArms(semantic, options.baseUrl, options.fetchImpl);
    for (const entry of resolved.dropped) dropped.push({ arm: entry.arm, reason: entry.reason });
    for (const pin of resolved.available as readonly ArmPin[]) {
      const prefixes = await runtimePrefixesOf(pin.model);
      pins.push({ arm: pin.arm as SemanticArmId, model: pin.model, digest12: pin.digest12, ollamaVersion: pin.ollamaVersion, runtimeQueryPrefix: prefixes.query, runtimeDocumentPrefix: prefixes.document });
    }
  }
  return { planned, pins, dropped };
}

export interface StageRPlanReport {
  readonly kind: 'chunk-eval-stage-r-plan';
  readonly version: typeof STAGE_R_PLAN_VERSION;
  readonly digest: string;
  readonly set: StageRInputs['set'];
  readonly planned: readonly StageRArmId[];
  readonly dropped: StageRInputs['dropped'];
  readonly pins: readonly StageRPin[];
  readonly runs: readonly { readonly arm: StageRArmId; readonly mode: RunMode; readonly queries: number; readonly modelCallsUpperBound: number | null }[];
  readonly parameters: typeof STAGE_R_PARAMETERS;
  readonly note: string;
}

/** Every vector the production scorer stores for the set: the memory id (short) or `<id>#<ordinal>` per passage (long). */
export function vectorUnitsOf(set: Pick<MemorySet, 'memories'>): Array<{ memoryId: string; vectorId: string }> {
  return set.memories.flatMap((memory) => memoryVectorUnits(memory.id, memory.text, true).map((unit) => ({ memoryId: memory.id, vectorId: unit.vectorId })));
}

export function runsOf(planned: readonly StageRArmId[], dropped: readonly { arm: string }[], set: Pick<MemorySet, 'memories' | 'queries'>): StageRPlanReport['runs'] {
  const gone = new Set(dropped.map((d) => d.arm));
  const out: Array<StageRPlanReport['runs'][number]> = [];
  for (const arm of planned) {
    if (gone.has(arm)) continue;
    if (arm === 'L') out.push({ arm, mode: 'lexical', queries: set.queries.length, modelCallsUpperBound: 0 });
    else {
      const perQuery = 1 + RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn;
      out.push({ arm, mode: 'live', queries: set.queries.length, modelCallsUpperBound: set.queries.length * perQuery });
      const units = vectorUnitsOf(set);
      out.push({ arm, mode: 'backfilled', queries: set.queries.length, modelCallsUpperBound: set.queries.length + units.length + Math.ceil(units.length / BACKFILL_BATCH) + 20 });
      out.push({ arm, mode: 'warm', queries: set.queries.length, modelCallsUpperBound: set.queries.length + Math.ceil(units.length / RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn) * perQuery + units.length });
    }
  }
  return out;
}

export function buildStageRPlan(input: StageRInputs, set: Pick<MemorySet, 'memories' | 'queries'>): StageRPlanReport {
  return {
    kind: 'chunk-eval-stage-r-plan',
    version: STAGE_R_PLAN_VERSION,
    digest: stageRDigest(input),
    set: input.set,
    planned: input.planned,
    dropped: input.dropped,
    pins: input.pins,
    runs: runsOf(input.planned, input.dropped, set),
    parameters: STAGE_R_PARAMETERS,
    note: 'Zero model calls in plan mode: pins come from the loopback daemon (version, tags) and the runtime prefixes from the real provider class run against a recording runner. A run calls `ollama run` once per query embedding and once per document embedding through the real provider; counts are upper bounds (the lazy scorer embeds at most 4 new vectors per turn).',
  };
}

export function planLinesR(plan: StageRPlanReport): string[] {
  const out = [`eval:chunk stage R plan (no model call) - ${plan.version}, memory set ${plan.set.digest.slice(0, 12)} (${plan.set.memories} memories, ${plan.set.queries} queries)`];
  out.push(`planned arms: ${plan.planned.join(', ')}${plan.dropped.length > 0 ? `; dropped: ${plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}` : ''}`);
  for (const pin of plan.pins) out.push(`${pin.arm} ${pin.model}@${pin.digest12} ollama${pin.ollamaVersion}: runtime prefixes query ${JSON.stringify(pin.runtimeQueryPrefix)} document ${JSON.stringify(pin.runtimeDocumentPrefix)} (the provider's own defaults)`);
  out.push(`seed ${STAGE_R_PARAMETERS.seed}: updatedAt spread over ${SPREAD_DAYS} days before ${RETRIEVAL_TIME}; actor ${ACTOR_ID}`);
  for (const run of plan.runs) out.push(`run ${run.arm}/${run.mode}: ${run.queries} queries${run.modelCallsUpperBound === null || run.modelCallsUpperBound === 0 ? ', no model call' : `, up to ${run.modelCallsUpperBound} ollama calls`}`);
  out.push(`plan digest: ${plan.digest}`);
  return out;
}

// ---------------------------------------------------------------- one arm run through the real runtime classes

export interface RuntimeDiagnostics {
  readonly queries: number;
  /** Gold memory not among the candidates offered (the recent 50 plus the semantic top-K widening). */
  readonly goldNotInPool: { readonly n: number; readonly share: number };
  /** Gold memory with no semantic score in that retrieval (null scorer result, or lazy embedding had not reached it). Semantic arms only. */
  readonly goldNoSemanticScore: { readonly n: number; readonly share: number } | null;
  /** The part of the above that was in the pool but unscored (the lazy-embedding effect alone). */
  readonly goldInPoolNoSemanticScore: { readonly n: number; readonly share: number } | null;
  readonly poolSize: { readonly min: number; readonly max: number };
  readonly scorerNullQueries: number;
  readonly fallbackReasons: Readonly<Record<string, number>>;
  readonly embeddedDocuments: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
}

export interface RuntimeArmRun {
  readonly arm: StageRArmId;
  readonly mode: RunMode;
  readonly model: string | null;
  readonly metrics: PathMetrics;
  readonly diagnostics: RuntimeDiagnostics;
  readonly prewarm: { readonly stored: number; readonly of: number; readonly scoringCalls: number; readonly storeCount: number; readonly missing: number } | null;
  /** Set when the run cannot be reported as a valid measurement (warm prewarming incomplete). */
  readonly invalid: { readonly reason: string; readonly missing: number } | null;
}

export interface RunOptions {
  readonly arm: StageRArmId;
  readonly mode: RunMode;
  readonly set: MemorySet;
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

const invalidRun = (arm: StageRArmId, mode: RunMode, prewarm: NonNullable<RuntimeArmRun['prewarm']>, reason: string): RuntimeArmRun => ({
  arm,
  mode,
  model: arm === 'L' ? null : stageRModel(arm),
  metrics: pathMetrics({ memories: [], queries: [] } as unknown as MemorySet, []),
  diagnostics: { queries: 0, goldNotInPool: share(0, 0), goldNoSemanticScore: null, goldInPoolNoSemanticScore: null, poolSize: { min: 0, max: 0 }, scorerNullQueries: 0, fallbackReasons: {}, embeddedDocuments: 0, latencyMs: { p50: 0, p95: 0 } },
  prewarm,
  invalid: { reason, missing: prewarm.missing },
});

export async function runRuntimeArm(options: RunOptions): Promise<RuntimeArmRun> {
  const { arm, mode, set } = options;
  const clock = options.clock ?? (() => performance.now());
  mkdirSync(options.workDir, { recursive: true });
  const storage = new SqliteStorageProvider({ dbPath: join(options.workDir, 'memory.db') });
  await storage.init();
  try {
    for (const record of memoryRecordsOf(set)) await storage.memories.save(record);

    // observers only: they record what the real classes returned and change nothing
    let poolIds = new Set<string>();
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
    let prewarm: RuntimeArmRun['prewarm'] = null;
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
              const result = await session.score(candidates);
              lastScores = result;
              return result;
            },
          };
          return observedSession;
        },
      };
    }

    const retriever = new DefaultMemoryRetriever(repository, { clock: () => RETRIEVAL_TIME, ...(semantic === undefined ? {} : { semanticScorer: semantic }) });
    const ranks: (number | null)[] = [];
    const latencies: number[] = [];
    let notInPool = 0;
    let noScore = 0;
    let inPoolNoScore = 0;
    let scorerNull = 0;
    observing = true;
    for (const query of set.queries) {
      lastScores = null;
      poolIds = new Set();
      const started = clock();
      const results = await retriever.retrieve(
        createMemoryRetrievalRequest({ query: query.text, capability: Capability.GENERAL_CHAT, scope: { actorId: ACTOR_ID }, authorityFitness: RUNTIME_CONSTANTS.authorityFitness, maxResults: RUNTIME_CONSTANTS.maxResults }),
      );
      latencies.push(clock() - started);
      const at = results.findIndex((result) => query.gold.includes(result.memory.id));
      ranks.push(at < 0 ? null : at + 1);
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
      prewarm,
      invalid: null,
    };
  } finally {
    await storage.close();
  }
}

/** Runs one arm in a fresh temp dir (sqlite file and vector store), removed afterwards. */
export async function runArmFresh(options: Omit<RunOptions, 'workDir'> & { tmpRoot?: string }): Promise<RuntimeArmRun> {
  const root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `quoky-stage-r-${options.arm}-${options.mode}-`));
  try {
    return await runRuntimeArm({ ...options, workDir: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- report

export interface StageRReport {
  readonly kind: 'chunk-eval-memory-stage-r';
  readonly status: 'NON-GATING';
  readonly memorySetDigest: string;
  readonly plan: { readonly version: typeof STAGE_R_PLAN_VERSION; readonly digest: string; readonly pins: readonly StageRPin[]; readonly planned: readonly StageRArmId[]; readonly dropped: StageRInputs['dropped'] };
  readonly parameters: typeof STAGE_R_PARAMETERS;
  readonly runs: readonly RuntimeArmRun[];
  readonly harnessReference: string;
}

export const HARNESS_REFERENCE = 'stage E harness (all memories ranked, not the runtime path), Recall@5 on ko: E0 multi-vector 0.156, E4 single-vector 0.703, E4 multi-vector 0.906';

export function buildStageRReport(memorySetDigest: string, planBlock: StageRReport['plan'], runs: readonly RuntimeArmRun[]): StageRReport {
  return { kind: 'chunk-eval-memory-stage-r', status: 'NON-GATING', memorySetDigest, plan: planBlock, parameters: STAGE_R_PARAMETERS, runs, harnessReference: HARNESS_REFERENCE };
}

const f3 = (value: number): string => value.toFixed(3);
const pct = (value: { n: number; share: number } | null): string => (value === null ? '-' : `${(value.share * 100).toFixed(1)}% (${value.n})`);

export function summaryLinesStageR(report: StageRReport): string[] {
  const out = [`eval:chunk stage R (runtime-path recall, NON-GATING) - plan ${report.plan.digest.slice(0, 12)}, memory set ${report.memorySetDigest.slice(0, 12)}`];
  out.push('Recall@5 / MRR@10 (n per language ' + String(report.runs[0]?.metrics.byLanguage.ko?.n ?? 0) + '):');
  for (const run of report.runs) {
    if (run.invalid !== null) {
      out.push(`${run.arm}/${run.mode}: INVALID - ${run.invalid.reason} (missing vectors ${run.invalid.missing}); no queries were run`);
      continue;
    }
    const by = (language: string): string => `${language} ${f3(run.metrics.byLanguage[language]?.recallAt5 ?? 0)}`;
    out.push(`${run.arm}/${run.mode}: all ${f3(run.metrics.overall.recallAt5)} (MRR ${f3(run.metrics.overall.mrr)}) ${LANGUAGES.map(by).join(' ')} long ${f3(run.metrics.longMemories.recallAt5)} short ${f3(run.metrics.shortMemories.recallAt5)}`);
    const d = run.diagnostics;
    out.push(`  gold not in pool ${pct(d.goldNotInPool)}; gold unscored ${pct(d.goldNoSemanticScore)} (in pool but unscored ${pct(d.goldInPoolNoSemanticScore)}); scorer null ${d.scorerNullQueries}; embedded ${d.embeddedDocuments}; pool ${d.poolSize.min}-${d.poolSize.max}; latency p50 ${d.latencyMs.p50} ms / p95 ${d.latencyMs.p95} ms${run.prewarm === null ? '' : `; prewarm ${run.prewarm.stored}/${run.prewarm.of} in ${run.prewarm.scoringCalls} calls`}${Object.keys(d.fallbackReasons).length === 0 ? '' : `; fallbacks ${JSON.stringify(d.fallbackReasons)}`}`);
  }
  out.push(`reference: ${report.harnessReference}`);
  return out;
}
