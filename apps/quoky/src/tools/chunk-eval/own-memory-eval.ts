/**
 * ADR-0124 phase 2 P2-5 (B): the own-memory judgment rule evaluation on CH9 (`--set memory-own --stage R --arms E4 --modes backfilled`).
 *
 * The recall is the REAL runtime path (same construction as stage R / CH8: SqliteStorageProvider, OllamaCliEmbeddingProvider, LocalVectorProvider,
 * the production memory scorer, the production backfill job to completion, `DefaultMemoryRetriever` with `maxResults` 10). From the retrieved
 * memories the recalled entries are built the way `context-builder.ts` `selectDurableRecall` does (rank by relevance, content dedup, at most 10,
 * content truncated at MAX_MEMORY_CHARS, ordered by createdAt then id; `retrievalMode` and `semanticScore` passed through), and the REAL
 * `hasOwnMemoryRecallHit` decides rule F0 (production). The offline families of `own-memory-rules.ts` run over the same entries; they are pure
 * functions and are never wired to production. E4 arm and backfilled mode only (the owner-approved single local run).
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
  detectOwnMemoryRecallQuestion,
  durableMemoryCollectionFor,
  hasOwnMemoryRecallHit,
  type AiProvider,
  type DurableMemoryByIdsQuery,
  type DurableMemoryQuery,
  type Logger,
  type MemoryRecord,
  type MemoryRepository,
  type ProviderSelector,
  type RetrievedMemory,
  type SemanticRecallScoring,
  type SemanticRecallSession,
} from '@quoky/core';
import type { SemanticRecallScorer } from '@quoky/core';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { LocalVectorProvider } from '@quoky/vector-local';
import { BACKFILL_BATCH } from '../../memory-vector-backfill';
import { createProductionMemoryBackfill, createProductionMemoryScorer } from '../../context-builder-provider';
import { percentiles } from '../selector-rag/embed';
import { MEMORY_OWN_SEED, MEMORY_OWN_VERSION, OWN_CATEGORIES, type OwnQuery, type OwnSet } from './memory-set-own';
import { MEMORY_V2_RETRIEVAL_TIME } from './memory-set-v2';
import { OWN_RULES, DELTA_OPTIONS, decide, SAFETY_MARGIN, TAU_GRID, MIN_GAIN, F1_PREFERENCE_TOLERANCE, buildOwnRulesReport, ownRulesLines, rankedSemantic, type OwnRulesReport, type RecallEntry, type RuleQuestion } from './own-memory-rules';
import { ACTOR_ID, IMPLEMENTATION_FILES, RUNTIME_CONSTANTS, STAGE_R_PARAMETERS, canonicalModes, stageRModel, vectorUnitsOf, type RunMode, type RuntimeEmbeddingProvider, type StageRInputs, type StageRPin } from './stage-r';

export const OWN_PLAN_VERSION = 'own-memory-plan.v1';
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The ONLY arm and mode of the owner-approved single local run. */
export const OWN_ARM = 'E4' as const;
export const OWN_MODES: readonly RunMode[] = ['backfilled'];

/** Mirrors `context-builder.ts` (pinned against the source by tests). */
export const CONTEXT_BUILDER_CONSTANTS = { maxMemoryChars: 400, durableRecallLimit: 10 } as const;

// ---------------------------------------------------------------- implementation identity and parameters (part of the plan digest)

const REPO_ROOT = resolve(__dirname, '../../../../..');
export const IMPLEMENTATION_FILES_OWN = [
  ...IMPLEMENTATION_FILES,
  'packages/core/src/application/chat-policy/own-memory-recall.ts',
  'packages/core/src/application/context-builder.ts',
  'apps/quoky/src/tools/chunk-eval/memory-set-own.ts',
  'apps/quoky/src/tools/chunk-eval/own-memory-rules.ts',
  'apps/quoky/src/tools/chunk-eval/own-memory-eval.ts',
] as const;

export type ImplementationHashesOwn = Readonly<Record<string, string>>;
let hashCache: ImplementationHashesOwn | undefined;
export function implementationHashesOwn(root: string = REPO_ROOT): ImplementationHashesOwn {
  if (root === REPO_ROOT && hashCache !== undefined) return hashCache;
  const out: Record<string, string> = {};
  for (const file of IMPLEMENTATION_FILES_OWN) out[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  if (root === REPO_ROOT) hashCache = out;
  return out;
}

export const STAGE_R_OWN_PARAMETERS = {
  set: `CH9 (${MEMORY_OWN_VERSION}, ${MEMORY_OWN_SEED}): hand-written, 70 first-person memories (ko 42, en 28) and 140 own-memory recall questions (positive-paraphrase 50, positive-shared 20, negative 70), split calibrate / validate per category and language`,
  retrievalTime: MEMORY_V2_RETRIEVAL_TIME,
  updatedAt: 'authored daysAgo per memory: RETRIEVAL_TIME minus daysAgo days',
  actorId: ACTOR_ID,
  storage: STAGE_R_PARAMETERS.storage,
  runtime: RUNTIME_CONSTANTS,
  arm: OWN_ARM,
  modes: { backfilled: STAGE_R_PARAMETERS.modes.backfilled },
  recallEntries: { ...CONTEXT_BUILDER_CONSTANTS, build: 'retriever results ranked by relevance desc, updatedAt desc, id asc; dedup by id and content; at most 10; content truncated at maxMemoryChars (plus an ellipsis); ordered by createdAt then memory id; retrievalMode and semanticScore passed through' },
  rules: OWN_RULES,
  grid: { tau: `${TAU_GRID[0]} .. ${TAU_GRID[TAU_GRID.length - 1]} step 0.01`, deltas: DELTA_OPTIONS, safetyMargin: SAFETY_MARGIN, minGain: MIN_GAIN, f1Tolerance: F1_PREFERENCE_TOLERANCE },
  fidelity: 'rule F0 is decided by the REAL hasOwnMemoryRecallHit; the offline F0 recomputation must equal it for every question or the run is INVALID',
  safetyBar: 'zero false hits on the validate negatives',
  productionUnchanged: 'harness only: no production behaviour changes in this step',
  status: 'NON-GATING (the verdict is advisory)',
} as const;

// ---------------------------------------------------------------- authored timestamps and records

export const updatedAtOfOwn = (set: Pick<OwnSet, 'memories'>): Map<string, string> => {
  const end = Date.parse(MEMORY_V2_RETRIEVAL_TIME);
  return new Map(set.memories.map((memory) => [memory.id, new Date(end - memory.daysAgo * DAY_MS).toISOString()]));
};

export const memoryRecordsOfOwn = (set: OwnSet): MemoryRecord[] => {
  const stamps = updatedAtOfOwn(set);
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

// ---------------------------------------------------------------- the recalled entries exactly as context-builder.ts builds them

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** `ContextBuilder.selectDurableRecall` (no token budget): rank, content dedup, limit, truncation, createdAt order. Keeps the memory id of each entry. */
export function durableRecallEntriesOf(results: readonly RetrievedMemory[]): RecallEntry[] {
  const ranked = [...results].sort((a, b) => b.relevanceScore - a.relevanceScore || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || a.memory.id.localeCompare(b.memory.id));
  const seenIds = new Set<string>();
  const seenContent: string[] = [];
  const selected: Array<RecallEntry & { createdAt: string }> = [];
  for (const candidate of ranked) {
    if (selected.length >= CONTEXT_BUILDER_CONSTANTS.durableRecallLimit) break;
    if (seenIds.has(candidate.memory.id)) continue;
    if (seenContent.includes(candidate.memory.content)) continue;
    const content = truncate(candidate.memory.content, CONTEXT_BUILDER_CONSTANTS.maxMemoryChars);
    if (content.length === 0) continue;
    selected.push({
      memoryId: candidate.memory.id,
      content,
      createdAt: candidate.memory.createdAt,
      ...(candidate.retrievalMode !== undefined ? { retrievalMode: candidate.retrievalMode } : {}),
      ...(candidate.semanticScore !== undefined ? { semanticScore: candidate.semanticScore } : {}),
    });
    seenIds.add(candidate.memory.id);
    seenContent.push(candidate.memory.content);
  }
  selected.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.memoryId.localeCompare(b.memoryId));
  return selected.map(({ createdAt: _createdAt, ...entry }) => entry);
}

/** The real production decision (rule F0) over the entries. */
export const productionHit = (question: NonNullable<ReturnType<typeof detectOwnMemoryRecallQuestion>>, entries: readonly RecallEntry[]): boolean =>
  hasOwnMemoryRecallHit(question, { conversationTranscript: [], durableRecall: entries });

/** Builds the rule input of one query from its recalled entries; `null` when the text is not an own-memory recall question. */
export function ruleQuestionOf(query: OwnQuery, entries: readonly RecallEntry[]): RuleQuestion | null {
  const question = detectOwnMemoryRecallQuestion(query.text);
  if (question === null) return null;
  return { id: query.id, category: query.category, half: query.half, language: query.language, gold: query.gold, question, entries };
}

// ---------------------------------------------------------------- plan

export interface StageROwnInputs extends Omit<StageRInputs, 'set'> {
  readonly set: { readonly digest: string; readonly memories: number; readonly queries: number };
}

export function stageROwnDigest(input: StageROwnInputs, parameters: unknown = STAGE_R_OWN_PARAMETERS, implementation: ImplementationHashesOwn = implementationHashesOwn()): string {
  const body = { version: OWN_PLAN_VERSION, stage: 'R-own', set: input.set, planned: input.planned, pins: input.pins, dropped: input.dropped.map((d) => d.arm), modes: canonicalModes(OWN_MODES), parameters, implementation };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** The model-call upper bound of the backfilled run: one query embedding per query, one document embedding per vector unit, the backfill batches and a margin. */
export function ownModelCallsUpperBound(set: Pick<OwnSet, 'memories' | 'queries'>): number {
  const units = vectorUnitsOf(set).length;
  return set.queries.length + units + Math.ceil(units / BACKFILL_BATCH) + 20;
}

export interface StageROwnPlanReport {
  readonly kind: 'chunk-eval-stage-r-own-plan';
  readonly version: typeof OWN_PLAN_VERSION;
  readonly digest: string;
  readonly set: StageROwnInputs['set'];
  readonly planned: readonly string[];
  readonly dropped: StageROwnInputs['dropped'];
  readonly modes: readonly RunMode[];
  readonly pins: readonly StageRPin[];
  readonly runs: readonly { readonly arm: string; readonly mode: RunMode; readonly queries: number; readonly modelCallsUpperBound: number }[];
  readonly parameters: typeof STAGE_R_OWN_PARAMETERS;
  readonly note: string;
}

export function buildStageROwnPlan(input: StageROwnInputs, set: Pick<OwnSet, 'memories' | 'queries'>): StageROwnPlanReport {
  const gone = new Set(input.dropped.map((d) => d.arm));
  return {
    kind: 'chunk-eval-stage-r-own-plan',
    version: OWN_PLAN_VERSION,
    digest: stageROwnDigest(input),
    set: input.set,
    planned: input.planned,
    dropped: input.dropped,
    modes: canonicalModes(OWN_MODES),
    pins: input.pins,
    runs: input.planned.filter((arm) => !gone.has(arm)).map((arm) => ({ arm, mode: 'backfilled' as const, queries: set.queries.length, modelCallsUpperBound: ownModelCallsUpperBound(set) })),
    parameters: STAGE_R_OWN_PARAMETERS,
    note: 'Zero model calls in plan mode (pins from the loopback daemon, prefixes from the real provider against a recording runner). The run calls `ollama run` once per query embedding and once per document embedding through the real provider; the count is an upper bound. Harness only: production is unchanged.',
  };
}

export function planLinesOwn(plan: StageROwnPlanReport): string[] {
  const out = [`eval:chunk stage R plan on CH9 own-memory set (no model call) - ${plan.version}, memory set ${plan.set.digest.slice(0, 12)} (${plan.set.memories} memories, ${plan.set.queries} questions)`];
  out.push(`planned arms: ${plan.planned.join(', ')}${plan.dropped.length > 0 ? `; dropped: ${plan.dropped.map((d) => `${d.arm} (${d.reason})`).join('; ')}` : ''}`);
  for (const pin of plan.pins) out.push(`${pin.arm} ${pin.model}@${pin.digest12} ollama${pin.ollamaVersion}: runtime prefixes query ${JSON.stringify(pin.runtimeQueryPrefix)} document ${JSON.stringify(pin.runtimeDocumentPrefix)} (the provider's own defaults)`);
  out.push(`mode: ${plan.modes.join(', ')} only (part of the digest)`);
  out.push(`rules (in the digest): ${OWN_RULES.F0}; ${OWN_RULES.F1}; ${OWN_RULES.F2}`);
  out.push(`grid: tau ${TAU_GRID[0]?.toFixed(2)}..${TAU_GRID[TAU_GRID.length - 1]?.toFixed(2)} step 0.01, safety margin +${SAFETY_MARGIN}; ${OWN_RULES.calibration}`);
  out.push(`verdict (pre-declared, in the digest): ${OWN_RULES.verdict}; safety bar: zero false hits on the validate negatives`);
  out.push(`updatedAt = authored daysAgo before ${MEMORY_V2_RETRIEVAL_TIME}; actor ${ACTOR_ID}; production unchanged (harness only)`);
  for (const run of plan.runs) out.push(`run ${run.arm}/${run.mode}: ${run.queries} questions, up to ${run.modelCallsUpperBound} ollama calls`);
  out.push(`plan digest: ${plan.digest}`);
  return out;
}

// ---------------------------------------------------------------- the run

export interface OwnQuestionRow {
  readonly id: string;
  readonly category: string;
  readonly half: string;
  readonly production: boolean;
  readonly top1: number | null;
  readonly top2: number | null;
  readonly goldScore: number | null;
  readonly entries: number;
}

export interface OwnArmRun {
  readonly arm: typeof OWN_ARM;
  readonly mode: 'backfilled';
  readonly model: string;
  readonly rules: OwnRulesReport | null;
  readonly rows: readonly OwnQuestionRow[];
  /** Offline F0 versus the real hasOwnMemoryRecallHit. */
  readonly fidelity: { readonly questions: number; readonly mismatches: number };
  readonly diagnostics: { readonly queries: number; readonly goldNotRecalled: number; readonly scorerNullQueries: number; readonly fallbackReasons: Readonly<Record<string, number>>; readonly embeddedDocuments: number; readonly latencyMs: { readonly p50: number; readonly p95: number } };
  readonly prewarm: { readonly stored: number; readonly of: number; readonly scoringCalls: number; readonly missing: number } | null;
  readonly invalid: { readonly reason: string } | null;
}

export interface OwnRunOptions {
  readonly set: OwnSet;
  readonly provider: RuntimeEmbeddingProvider;
  readonly workDir: string;
  readonly clock?: () => number;
}

const fixedSelector = (provider: AiProvider): ProviderSelector => ({
  async select(capability) {
    if (capability !== Capability.EMBEDDING) throw new NoProviderAvailableError(capability);
    return provider;
  },
});

const emptyDiagnostics: OwnArmRun['diagnostics'] = { queries: 0, goldNotRecalled: 0, scorerNullQueries: 0, fallbackReasons: {}, embeddedDocuments: 0, latencyMs: { p50: 0, p95: 0 } };

export async function runOwnMemoryArm(options: OwnRunOptions): Promise<OwnArmRun> {
  const { set, provider } = options;
  const clock = options.clock ?? (() => performance.now());
  mkdirSync(options.workDir, { recursive: true });
  const storage = new SqliteStorageProvider({ dbPath: join(options.workDir, 'memory.db') });
  await storage.init();
  try {
    for (const record of memoryRecordsOfOwn(set)) await storage.memories.save(record);
    const repository: MemoryRepository = {
      get: (id) => storage.memories.get(id),
      save: (record) => storage.memories.save(record),
      delete: (id) => storage.memories.delete(id),
      list: () => storage.memories.list(),
      findByScope: (scope, type) => storage.memories.findByScope(scope, type),
      findDurableCandidates: (query: DurableMemoryQuery) => storage.memories.findDurableCandidates(query),
      findDurableCandidatesByIds: (query: DurableMemoryByIdsQuery) => storage.memories.findDurableCandidatesByIds!(query),
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
    const scorer: SemanticRecallScorer = createProductionMemoryScorer({
      selector: fixedSelector(provider),
      vectors: observed,
      logger,
      timeoutMs: RUNTIME_CONSTANTS.embeddingTimeoutMs,
      maxNewPerTurn: RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn,
    });
    await provider.isAvailable().catch(() => false);
    await provider.warmUpSettled?.();

    // the REAL production backfill job runs to completion before any query: what the owner has once it caught up
    const units = vectorUnitsOf(set);
    const wanted = new Set(units.map((unit) => unit.vectorId));
    const job = createProductionMemoryBackfill(storage, { selector: fixedSelector(provider), vectors: observed, timeoutMs: RUNTIME_CONSTANTS.embeddingTimeoutMs, maxNewPerTurn: RUNTIME_CONSTANTS.maxNewEmbeddingsPerTurn });
    const limit = Math.ceil(units.length / BACKFILL_BATCH) + 20;
    let ticks = 0;
    for (; ticks < limit; ticks += 1) {
      const tick = await job.runOnce();
      if (tick.state !== 'working') break;
    }
    let stored = 0;
    if (dimension !== 0 && spaceId !== undefined) {
      const inStore = await vectors.query(durableMemoryCollectionFor(spaceId), new Array<number>(dimension).fill(1), RUNTIME_CONSTANTS.vectorQueryLimit);
      stored = new Set(inStore.filter((hit) => wanted.has(hit.id) && hit.metadata?.space === spaceId).map((hit) => hit.id)).size;
    }
    const missing = units.length - stored;
    const prewarm = { stored, of: units.length, scoringCalls: ticks + 1, missing };
    if (missing > 0) {
      return { arm: OWN_ARM, mode: 'backfilled', model: stageRModel(OWN_ARM), rules: null, rows: [], fidelity: { questions: 0, mismatches: 0 }, diagnostics: emptyDiagnostics, prewarm, invalid: { reason: `backfilled prewarming incomplete: ${missing} of ${units.length} vectors are not stored after ${ticks + 1} passes` } };
    }

    let lastScores: ReadonlyMap<string, number> | null = null;
    const semantic: SemanticRecallScoring = {
      async score(query, candidates) {
        const result = await scorer.score(query, candidates);
        lastScores = result;
        return result;
      },
      async openSession(query) {
        const session = await scorer.openSession(query);
        if (session === null) return null;
        const observedSession: SemanticRecallSession = {
          nearestMemoryIds: (count) => session.nearestMemoryIds(count),
          async score(candidates) {
            const result = await session.score(candidates);
            lastScores = result;
            return result;
          },
        };
        return observedSession;
      },
    };
    const retriever = new DefaultMemoryRetriever(repository, { clock: () => MEMORY_V2_RETRIEVAL_TIME, semanticScorer: semantic });
    const items: RuleQuestion[] = [];
    const rows: OwnQuestionRow[] = [];
    const latencies: number[] = [];
    let mismatches = 0;
    let goldNotRecalled = 0;
    let scorerNull = 0;
    observing = true;
    for (const query of set.queries) {
      lastScores = null;
      const started = clock();
      const results = await retriever.retrieve(
        createMemoryRetrievalRequest({ query: query.text, capability: Capability.GENERAL_CHAT, scope: { actorId: ACTOR_ID }, authorityFitness: RUNTIME_CONSTANTS.authorityFitness, maxResults: RUNTIME_CONSTANTS.maxResults }),
      );
      latencies.push(clock() - started);
      if (lastScores === null) scorerNull += 1;
      const entries = durableRecallEntriesOf(results);
      const item = ruleQuestionOf(query, entries);
      if (item === null) throw new Error(`CH9 question is not an own-memory recall question: ${query.id}`);
      items.push(item);
      const production = productionHit(item.question, entries);
      const offlineF0 = decide({ family: 'F0' }, item).hit;
      if (production !== offlineF0) mismatches += 1;
      const ranked = rankedSemantic(entries);
      const goldEntry = entries.find((entry) => query.gold.includes(entry.memoryId));
      if (query.gold.length > 0 && goldEntry === undefined) goldNotRecalled += 1;
      rows.push({ id: query.id, category: query.category, half: query.half, production, top1: ranked[0]?.score ?? null, top2: ranked[1]?.score ?? null, goldScore: goldEntry?.semanticScore ?? null, entries: entries.length });
    }
    observing = false;
    const n = set.queries.length;
    const invalid = mismatches > 0 ? { reason: `fidelity: the offline F0 disagrees with the real hasOwnMemoryRecallHit on ${mismatches} of ${n} questions` } : null;
    return {
      arm: OWN_ARM,
      mode: 'backfilled',
      model: stageRModel(OWN_ARM),
      rules: buildOwnRulesReport(items),
      rows,
      fidelity: { questions: n, mismatches },
      diagnostics: {
        queries: n,
        goldNotRecalled,
        scorerNullQueries: scorerNull,
        fallbackReasons,
        embeddedDocuments,
        latencyMs: (({ p50, p95 }) => ({ p50: Math.round(p50 * 10) / 10, p95: Math.round(p95 * 10) / 10 }))(percentiles(latencies)),
      },
      prewarm,
      invalid,
    };
  } finally {
    await storage.close();
  }
}

/** Runs the arm in a fresh temp dir (sqlite file and vector store), removed afterwards. */
export async function runOwnArmFresh(options: Omit<OwnRunOptions, 'workDir'> & { tmpRoot?: string }): Promise<OwnArmRun> {
  const root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'quoky-stage-r-own-'));
  try {
    return await runOwnMemoryArm({ ...options, workDir: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- report

export interface StageROwnReport {
  readonly kind: 'chunk-eval-memory-stage-r-own';
  readonly status: 'NON-GATING';
  readonly memorySetDigest: string;
  readonly plan: { readonly version: typeof OWN_PLAN_VERSION; readonly digest: string; readonly pins: readonly StageRPin[]; readonly planned: readonly string[]; readonly dropped: StageROwnInputs['dropped'] };
  readonly parameters: typeof STAGE_R_OWN_PARAMETERS;
  readonly runs: readonly OwnArmRun[];
}

export function buildStageROwnReport(memorySetDigest: string, planBlock: StageROwnReport['plan'], runs: readonly OwnArmRun[]): StageROwnReport {
  return { kind: 'chunk-eval-memory-stage-r-own', status: 'NON-GATING', memorySetDigest, plan: planBlock, parameters: STAGE_R_OWN_PARAMETERS, runs };
}

export function summaryLinesStageROwn(report: StageROwnReport): string[] {
  const out = [`eval:chunk stage R on CH9 (own-memory judgment, NON-GATING) - plan ${report.plan.digest.slice(0, 12)}, memory set ${report.memorySetDigest.slice(0, 12)}`];
  for (const run of report.runs) {
    if (run.invalid !== null || run.rules === null) {
      out.push(`${run.arm}/${run.mode}: INVALID - ${run.invalid?.reason ?? 'no rules report'}`);
      continue;
    }
    const d = run.diagnostics;
    out.push(`${run.arm}/${run.mode}: ${d.queries} questions; fidelity ${run.fidelity.mismatches} mismatches (offline F0 vs the real hasOwnMemoryRecallHit); gold not among the recalled entries ${d.goldNotRecalled}; scorer null ${d.scorerNullQueries}; embedded ${d.embeddedDocuments}; latency p50 ${d.latencyMs.p50} ms / p95 ${d.latencyMs.p95} ms${run.prewarm === null ? '' : `; backfill ${run.prewarm.stored}/${run.prewarm.of}`}${Object.keys(d.fallbackReasons).length === 0 ? '' : `; fallbacks ${JSON.stringify(d.fallbackReasons)}`}`);
    out.push(...ownRulesLines(run.rules));
  }
  out.push(`categories: ${OWN_CATEGORIES.join(', ')}; production is unchanged (harness only); any rule change is an owner decision.`);
  return out;
}
