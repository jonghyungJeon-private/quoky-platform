import { createHash } from 'node:crypto';
import { Capability } from '../../domain';
import type { Id, IsoTimestamp } from '../../domain';
import { NoProviderAvailableError } from '../../errors';
import type {
  AiProvider,
  Logger,
  ProviderSelector,
  VectorProvider,
  VectorQueryResult,
  VectorRecord,
} from '../../ports';
import { now } from '../../util/clock';
import { containsCredentialMaterial } from '../credential-guard';
import {
  cosineSimilarity,
  embeddingRequestMetadata,
  parseEmbeddingEnvelope,
  type EmbeddingEnvelope,
  type EmbeddingRole,
} from './embedding-envelope';
import { memoryVectorUnits } from './memory-passages';
import type { RecallActivity } from './recall-activity';

/** Legacy (ADR-0098 D8) collection: one vector per memory, space not in the name. Kept for rollback; no longer read. */
export const DURABLE_MEMORY_VECTOR_COLLECTION = 'durable-memory-v1';
/** ADR-0124 section 5.3: every space gets its own collection `durable-memory-v2-<space>`; vectors never mix. */
export const DURABLE_MEMORY_V2_COLLECTION_PREFIX = 'durable-memory-v2-';
export const DEFAULT_MAX_NEW_EMBEDDINGS_PER_TURN = 4;
export const DEFAULT_SEMANTIC_TURN_BUDGET_MS = 3_000;
export const DEFAULT_MAX_INDEXED_VECTORS = 20_000;

/**
 * The v2 collection of one embedding space: a readable slug of the space id plus a hash of the whole id, so two
 * spaces never share a file even when their slugs coincide. Matches the vector store's name pattern (`[a-z0-9-]{1,64}`).
 */
export function durableMemoryCollectionFor(space: string): string {
  const slug = space
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '');
  const hash = createHash('sha256').update(space, 'utf8').digest('hex').slice(0, 12);
  return `${DURABLE_MEMORY_V2_COLLECTION_PREFIX}${slug.length > 0 ? `${slug}-` : ''}${hash}`;
}

/** One already-eligible durable candidate. The scorer never sees, adds or widens candidates itself. */
export interface SemanticRecallCandidate {
  readonly id: Id;
  readonly content: string;
}

/**
 * One recall turn's semantic state: the query embedded ONCE and the stored vectors read ONCE, under one shared turn
 * budget. It serves candidate generation (nearest memories by max-sim) and scoring of the eligible candidates.
 */
export interface SemanticRecallSession {
  /**
   * Ids of the `limit` memories whose best stored vector is closest to the query (max-sim over a memory's vectors).
   * Only ids: the caller applies scope, authority, expiry, supersession and archive filters to the records itself.
   */
  nearestMemoryIds(limit: number): Promise<Id[]>;
  /** Scores for the eligible candidates; `null` means no semantic signal (any failure or timeout). */
  score(candidates: readonly SemanticRecallCandidate[]): Promise<ReadonlyMap<Id, number> | null>;
  /**
   * ADR-0124 P2-6: after `score()`, the ordinal of the passage whose vector gave each memory its maximum score, for
   * multi-unit memories only (a single-vector memory has no entry). Optional and read-only; absent or empty means
   * "unknown", and every caller must work without it.
   */
  matchedPassageOrdinals?(): ReadonlyMap<Id, number>;
}

/**
 * Optional semantic re-ranking seam used by `DefaultMemoryRetriever`. `null` means "no semantic signal":
 * the retriever then ranks lexically, byte-identical to recall without a scorer.
 */
export interface SemanticRecallScoring {
  score(
    query: string,
    candidates: readonly SemanticRecallCandidate[],
  ): Promise<ReadonlyMap<Id, number> | null>;
  /**
   * Embed the query once and return a session, or `null` when no semantic signal is available (no provider,
   * timeout, error, credential-like query). A scorer without it can only score a fixed candidate list.
   */
  openSession?(query: string): Promise<SemanticRecallSession | null>;
}

/** What one maintenance pass (ADR-0124 section 5.4, outside any turn) did. */
export interface SemanticRecallMaintenance {
  readonly space: string;
  readonly collection: string;
  /** Vectors embedded and stored in this pass. */
  readonly embedded: number;
  /** Vector units of live memories that are still missing after this pass. */
  readonly remaining: number;
  /** Stored vectors removed: a memory no longer live, or a passage ordinal beyond the memory's current units. */
  readonly deleted: number;
  /** Vector units wanted for the space exceed the store cap: nothing was embedded, because it would evict. */
  readonly overCap?: boolean;
  /** The pass yielded to a recall turn (or an abort) before it finished its batch. */
  readonly yielded?: boolean;
}

/** The live durable memories at the moment of the call. `truncated`: the read was bounded and may be incomplete. */
export interface SemanticRecallLiveSet {
  readonly candidates: readonly SemanticRecallCandidate[];
  readonly truncated: boolean;
}

export interface SemanticRecallMaintenanceOptions {
  /** New vectors embedded in this pass (each passage counts one). Default: the per-turn bound. */
  readonly maxNew?: number;
  /** Wall-clock bound for the pass. Default: 30 s. */
  readonly budgetMs?: number;
  /**
   * Which of these memory ids are live RIGHT NOW (a fresh read, not the snapshot). Used before a vector of a memory
   * that looked gone is deleted and before a batch is stored, so a memory saved or forgotten mid-pass is judged by
   * its current state. Without it the pass neither deletes memory-level vectors nor stores new ones.
   */
  readonly confirmLive: (memoryIds: readonly Id[]) => Promise<ReadonlySet<Id>>;
  /** Aborts the pass between steps and cuts an embedding wait short (shutdown). */
  readonly signal?: AbortSignal;
  /** Checked before each embedding: true ends the batch (a recall turn is active). */
  readonly shouldYield?: () => boolean;
  /**
   * Re-read the space after the sweep (the sweep itself runs on the cached space, without the model): a re-pulled model
   * or an upgraded runtime is noticed, and the pass ends so the next one works in the new space. An unavailable
   * provider is ignored here. The caller sets it on the first pass after idle time and on the forced full pass.
   */
  readonly refreshSpace?: boolean;
}

export interface SemanticRecallScorerDeps {
  readonly selector: ProviderSelector;
  readonly vectors: VectorProvider;
  readonly logger?: Logger;
  /** Shared clock seam; used only to measure latency for the bounded log line. */
  readonly clock?: () => IsoTimestamp;
  /** Marks a recall turn for background jobs (see `RecallActivityGauge`). */
  readonly activity?: RecallActivity;
}

export interface SemanticRecallScorerOptions {
  /** Fixed collection (legacy and learning examples). Ignored when `collectionFor` is set. */
  readonly collection?: string;
  /**
   * Collection per embedding space, named by the query envelope's `space` (ADR-0124 5.3). When set, vectors of
   * another space are unreachable by construction.
   */
  readonly collectionFor?: (space: string) => string;
  /** Long memories get one vector per passage (ADR-0124 section 5). Default false: one vector per candidate. */
  readonly multiVector?: boolean;
  /** Document embeddings created per turn (the query embedding is separate; each passage counts). Default 4. */
  readonly maxNewEmbeddingsPerTurn?: number;
  /** Wall-clock budget for the whole turn (query embedding, store read, scoring). Default 3 s. */
  readonly turnBudgetMs?: number;
  /** Upper bound for one embedding call; never more than the remaining turn budget. */
  readonly embeddingTimeoutMs?: number;
  /** `topK` used to read stored vectors back. Default 20,000 (the store's own bound). */
  readonly maxIndexed?: number;
}

type FallbackReason = 'NO_PROVIDER' | 'TIMEOUT' | 'ERROR';

class SemanticRecallFallback extends Error {
  constructor(readonly reason: FallbackReason) {
    super(`semantic recall fallback: ${reason}`);
    this.name = 'SemanticRecallFallback';
  }
}

interface TurnDeadline {
  readonly expiresAtMs: number;
  /** Set when the turn budget ran out; later work in the same turn stops at its next step. */
  expired: boolean;
}

function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

const NO_OP_LOGGER: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The memory a stored vector belongs to: its recorded `memoryId`, else the vector id (single-vector form). */
function memoryIdOf(result: Pick<VectorQueryResult, 'id' | 'metadata'>): Id {
  const recorded = result.metadata?.memoryId;
  return typeof recorded === 'string' && recorded.length > 0 ? recorded : result.id;
}

/**
 * Opt-in local semantic recall (ADR-0098 D8, ADR-0124 section 5). Embeds the query through the `EMBEDDING`
 * capability (selected by capability, never by provider id) and scores ONLY the durable candidates the retriever
 * found eligible: it caches at most `maxNewEmbeddingsPerTurn` missing or stale vectors per turn in the
 * `VectorProvider` and returns cosine scores clamped to [0, 1]. With `multiVector` a long memory has one vector per
 * passage and scores as the maximum over them. The session additionally lists the memories nearest to the query so
 * the retriever can widen its candidate pool; it returns ids only and never grants eligibility. Credential-like text
 * is never sent to a provider. Every failure (no provider, timeout, malformed envelope, store error) returns `null`
 * so recall falls back to lexical; the log line carries counts and latency only, never content.
 */
export class SemanticRecallScorer implements SemanticRecallScoring {
  private readonly collection: string;
  private readonly collectionFor: ((space: string) => string) | undefined;
  private readonly multiVector: boolean;
  private readonly maxNew: number;
  private readonly turnBudgetMs: number;
  private readonly embeddingTimeoutMs: number;
  private readonly maxIndexed: number;
  private readonly logger: Logger;
  private readonly clock: () => IsoTimestamp;
  /** The space and dimension of the last envelope seen: lets a maintenance pass skip its probe embedding. */
  private knownSpace: { space: string; dimensions: number } | undefined;
  private capWarned = false;

  constructor(
    private readonly deps: SemanticRecallScorerDeps,
    options: SemanticRecallScorerOptions = {},
  ) {
    this.collection = options.collection ?? DURABLE_MEMORY_VECTOR_COLLECTION;
    this.collectionFor = options.collectionFor;
    this.multiVector = options.multiVector ?? false;
    this.maxNew = positiveInteger(
      options.maxNewEmbeddingsPerTurn ?? DEFAULT_MAX_NEW_EMBEDDINGS_PER_TURN,
      'maxNewEmbeddingsPerTurn',
    );
    this.turnBudgetMs = positiveInteger(options.turnBudgetMs ?? DEFAULT_SEMANTIC_TURN_BUDGET_MS, 'turnBudgetMs');
    this.embeddingTimeoutMs = positiveInteger(
      options.embeddingTimeoutMs ?? this.turnBudgetMs,
      'embeddingTimeoutMs',
    );
    this.maxIndexed = positiveInteger(options.maxIndexed ?? DEFAULT_MAX_INDEXED_VECTORS, 'maxIndexed');
    this.logger = deps.logger ?? NO_OP_LOGGER;
    this.clock = deps.clock ?? now;
  }

  async score(
    query: string,
    candidates: readonly SemanticRecallCandidate[],
  ): Promise<ReadonlyMap<Id, number> | null> {
    if (this.eligibleOf(candidates).length === 0) return null;
    const session = await this.openSession(query);
    return session === null ? null : session.score(candidates);
  }

  /**
   * Maintenance pass for the space's collection, run by an app-layer job and never inside a turn (ADR-0124 section
   * 5.4). Order matters for correctness against concurrent saves and forgets: the stored vectors are read FIRST, then
   * `loadLive` reads the live memories, so a memory saved after the snapshot is live and a vector a turn wrote after
   * it is not a deletion candidate. A vector whose memory is absent from the live list is deleted only after
   * `confirmLive` says, by a fresh read, that the memory is still not live; a batch is stored only for memories
   * `confirmLive` still reports live just before the upsert. It embeds at most `maxNew` missing or stale vector
   * units (newest memory first) through the same provider selection, credential rule and unit mapping as scoring,
   * yields between embeddings to a recall turn or an abort, and embeds nothing when the space's wanted units exceed
   * the store cap (it would evict). Returns `null` when the provider is unavailable, the pass aborted or anything fails.
   */
  async maintain(
    loadLive: () => Promise<SemanticRecallLiveSet>,
    options: SemanticRecallMaintenanceOptions,
  ): Promise<SemanticRecallMaintenance | null> {
    const startedAtMs = this.nowMs();
    const deadline: TurnDeadline = { expiresAtMs: startedAtMs + (options.budgetMs ?? 30_000), expired: false };
    const maxNew = positiveInteger(options.maxNew ?? this.maxNew, 'maxNew');
    const onAbort = (): void => rejectAborted(new SemanticRecallFallback('ERROR'));
    let rejectAborted: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    aborted.catch(() => undefined);
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const step = <T>(work: Promise<T>): Promise<T> => Promise.race([this.within(deadline, work), aborted]);
    const yieldNow = (): boolean => options.shouldYield?.() === true;
    let embedded = 0;
    try {
      if (yieldNow()) return { space: '', collection: '', embedded: 0, remaining: 0, deleted: 0, yielded: true };
      // The provider is selected only when a step needs the model: with the space known, the sweep runs without it.
      let provider: AiProvider | undefined;
      const modelProvider = async (): Promise<AiProvider | null> => {
        if (yieldNow()) return null;
        provider ??= await step(this.selectProvider());
        // a recall turn may have started while the selection was awaited: yield before any model call
        return yieldNow() ? null : provider;
      };
      // The space is only known from an envelope: reuse the last one seen, else a fixed content-free text identifies it.
      let known = this.knownSpace;
      let probedThisPass = false;
      if (known === undefined) {
        probedThisPass = true;
        const first = await modelProvider();
        if (first === null || yieldNow()) return { space: '', collection: '', embedded: 0, remaining: 0, deleted: 0, yielded: true };
        const probe = await step(this.embed(first, 'index maintenance', 'query', deadline));
        known = this.noteSpace(probe);
      }
      const space = known.space;
      const collection = this.collectionFor === undefined ? this.collection : this.collectionFor(space);
      const stored = await step(this.deps.vectors.query(collection, new Array<number>(known.dimensions).fill(1), this.maxIndexed));
      const byId = new Map(stored.map((hit) => [hit.id, hit]));
      const live = await step(loadLive());

      const wanted = new Set<Id>();
      const liveIds = new Set<Id>();
      const missing: Array<{ memoryId: Id; vectorId: Id; text: string; contentHash: string }> = [];
      for (const candidate of live.candidates) liveIds.add(candidate.id);
      for (const candidate of this.eligibleOf(live.candidates)) {
        for (const unit of memoryVectorUnits(candidate.id, candidate.content, this.multiVector)) {
          wanted.add(unit.vectorId);
          const contentHash = contentHashOf(unit.text);
          const hit = byId.get(unit.vectorId);
          const fresh =
            hit !== undefined &&
            hit.metadata?.contentHash === contentHash &&
            hit.metadata?.space === space &&
            hit.metadata?.dimensions === known.dimensions;
          if (!fresh) missing.push({ memoryId: candidate.id, vectorId: unit.vectorId, text: unit.text, contentHash });
        }
      }

      let deleted = 0;
      if (!live.truncated) {
        const unowned = stored.filter((hit) => !wanted.has(hit.id));
        // a live memory's surplus passage ordinal (or a credential-excluded memory) goes without a re-read; a vector of a
        // memory missing from the snapshot goes only when a fresh read still says it is not live
        const ofLive = unowned.filter((hit) => liveIds.has(memoryIdOf(hit)));
        const ofGone = unowned.filter((hit) => !liveIds.has(memoryIdOf(hit)));
        let doomed = ofLive.map((hit) => hit.id);
        if (ofGone.length > 0) {
          const nowLive = await step(options.confirmLive([...new Set(ofGone.map((hit) => memoryIdOf(hit)))]));
          doomed = doomed.concat(ofGone.filter((hit) => !nowLive.has(memoryIdOf(hit))).map((hit) => hit.id));
        }
        if (doomed.length > 0) {
          await step(this.deps.vectors.delete(collection, doomed));
          deleted = doomed.length;
        }
      }

      if (options.refreshSpace === true && !probedThisPass) {
        let probed: EmbeddingEnvelope | undefined;
        try {
          const refresher = await modelProvider();
          if (refresher !== null) probed = await step(this.embed(refresher, 'index maintenance', 'query', deadline));
        } catch (error) {
          if (options.signal?.aborted) throw error;
        }
        if (probed !== undefined && (probed.space !== space || probed.dimensions !== known.dimensions)) {
          this.noteSpace(probed);
          const next = this.collectionFor === undefined ? this.collection : this.collectionFor(probed.space);
          return { space: probed.space, collection: next, embedded: 0, remaining: Math.max(1, missing.length), deleted };
        }
      }

      if (wanted.size > this.maxIndexed) {
        if (!this.capWarned) {
          this.capWarned = true;
          this.logger.warn('semantic index over the store cap; backfill embeds nothing', { wanted: wanted.size, cap: this.maxIndexed });
        }
        return { space, collection, embedded: 0, remaining: 0, deleted, overCap: true };
      }

      let yielded = false;
      const batch: Array<VectorRecord & { memoryId: Id }> = [];
      for (const item of missing.slice(0, maxNew)) {
        if (options.signal?.aborted) throw new SemanticRecallFallback('ERROR');
        const embedder = await modelProvider();
        if (embedder === null) {
          yielded = true;
          break;
        }
        const envelope = await step(this.embed(embedder, item.text, 'document', deadline));
        if (envelope.space !== space || envelope.dimensions !== known.dimensions) {
          // the identity changed under us: forget the cached space so the next pass re-probes
          this.knownSpace = undefined;
          throw new SemanticRecallFallback('ERROR');
        }
        batch.push({
          id: item.vectorId,
          memoryId: item.memoryId,
          vector: [...envelope.vector],
          metadata: {
            contentHash: item.contentHash,
            space: envelope.space,
            dimensions: envelope.dimensions,
            ...(item.vectorId === item.memoryId ? {} : { memoryId: item.memoryId }),
          },
        });
      }
      if (batch.length > 0) {
        // just before the write: a memory forgotten while its vector was being embedded must not get one back
        const stillLive = await step(options.confirmLive([...new Set(batch.map((item) => item.memoryId))]));
        const kept = batch.filter((item) => stillLive.has(item.memoryId));
        const records = kept.map(({ memoryId: _memoryId, ...record }) => record);
        if (records.length > 0) await step(this.deps.vectors.upsert(collection, records));
        embedded = records.length;
        if (kept.length > 0) {
          // post-write verify: a forget that landed between the check above and the write must not leave a vector
          const afterWrite = await step(options.confirmLive([...new Set(kept.map((item) => item.memoryId))]));
          const stale = kept.filter((item) => !afterWrite.has(item.memoryId));
          if (stale.length > 0) {
            await step(this.deps.vectors.delete(collection, stale.map((item) => item.id)));
            embedded -= stale.length;
            deleted += stale.length;
          }
        }
      }
      this.logger.info('semantic index maintained', {
        live: live.candidates.length,
        embedded,
        remaining: missing.length - batch.length,
        deleted,
        latencyMs: this.nowMs() - startedAtMs,
      });
      return { space, collection, embedded, remaining: missing.length - batch.length, deleted, ...(yielded ? { yielded: true } : {}) };
    } catch (error) {
      this.logger.warn('semantic index maintenance unavailable', {
        reason: error instanceof SemanticRecallFallback ? error.reason : 'ERROR',
        embedded,
        latencyMs: this.nowMs() - startedAtMs,
      });
      return null;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private noteSpace(envelope: EmbeddingEnvelope): { space: string; dimensions: number } {
    this.knownSpace = { space: envelope.space, dimensions: envelope.dimensions };
    return this.knownSpace;
  }

  async openSession(query: string): Promise<SemanticRecallSession | null> {
    // Never embed credential-matching content: neither the query nor any candidate reaches a provider.
    if (query.trim().length === 0 || containsCredentialMaterial(query)) return null;
    const startedAtMs = this.nowMs();
    const deadline: TurnDeadline = { expiresAtMs: startedAtMs + this.turnBudgetMs, expired: false };
    const turn = this.deps.activity?.begin(this.turnBudgetMs);
    const endTurn = (): void => {
      if (turn !== undefined) this.deps.activity?.end(turn);
    };
    try {
      const provider = await this.within(deadline, this.selectProvider());
      const queryEnvelope = await this.within(deadline, this.embed(provider, query, 'query', deadline));
      this.noteSpace(queryEnvelope);
      const collection =
        this.collectionFor === undefined ? this.collection : this.collectionFor(queryEnvelope.space);
      const stored = await this.within(
        deadline,
        this.deps.vectors.query(collection, [...queryEnvelope.vector], this.maxIndexed),
      );
      return new Session(this.sessionContext(), provider, queryEnvelope, collection, stored, deadline, startedAtMs, endTurn);
    } catch (error) {
      endTurn();
      this.logger.warn('semantic recall unavailable; lexical recall used', {
        reason: error instanceof SemanticRecallFallback ? error.reason : 'ERROR',
        candidates: 0,
        embedded: 0,
        latencyMs: this.nowMs() - startedAtMs,
      });
      return null;
    }
  }

  private sessionContext(): SessionContext {
    return {
      eligibleOf: (candidates) => this.eligibleOf(candidates),
      within: (deadline, work) => this.within(deadline, work),
      embed: (provider, text, role, deadline) => this.embed(provider, text, role, deadline),
      nowMs: () => this.nowMs(),
      upsert: (collection, records) => this.deps.vectors.upsert(collection, records),
      logger: this.logger,
      multiVector: this.multiVector,
      maxNew: this.maxNew,
    };
  }

  private eligibleOf(candidates: readonly SemanticRecallCandidate[]): SemanticRecallCandidate[] {
    const seen = new Set<Id>();
    return candidates.filter((candidate) => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return candidate.content.trim().length > 0 && !containsCredentialMaterial(candidate.content);
    });
  }

  private async selectProvider(): Promise<AiProvider> {
    try {
      return await this.deps.selector.select(Capability.EMBEDDING);
    } catch (error) {
      throw error instanceof NoProviderAvailableError ? new SemanticRecallFallback('NO_PROVIDER') : error;
    }
  }

  /** Races `work` against what is left of the turn budget. A late rejection never surfaces unhandled. */
  private async within<T>(deadline: TurnDeadline, work: Promise<T>): Promise<T> {
    work.catch(() => undefined);
    const remainingMs = deadline.expiresAtMs - this.nowMs();
    if (deadline.expired || remainingMs <= 0) {
      deadline.expired = true;
      throw new SemanticRecallFallback('TIMEOUT');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.expired = true;
        reject(new SemanticRecallFallback('TIMEOUT'));
      }, remainingMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async embed(
    provider: AiProvider,
    text: string,
    role: EmbeddingRole,
    deadline: TurnDeadline,
  ): Promise<EmbeddingEnvelope> {
    if (deadline.expired) throw new SemanticRecallFallback('TIMEOUT');
    const remainingMs = Math.max(1, deadline.expiresAtMs - this.nowMs());
    const result = await provider.execute({
      capability: Capability.EMBEDDING,
      prompt: text,
      metadata: { ...embeddingRequestMetadata(role) },
      timeoutMs: Math.min(this.embeddingTimeoutMs, remainingMs),
    });
    const envelope = parseEmbeddingEnvelope(result.text);
    if (envelope === null) throw new SemanticRecallFallback('ERROR');
    return envelope;
  }

  private nowMs(): number {
    const value = Date.parse(this.clock());
    return Number.isNaN(value) ? 0 : value;
  }
}

interface SessionContext {
  eligibleOf(candidates: readonly SemanticRecallCandidate[]): SemanticRecallCandidate[];
  within<T>(deadline: TurnDeadline, work: Promise<T>): Promise<T>;
  embed(provider: AiProvider, text: string, role: EmbeddingRole, deadline: TurnDeadline): Promise<EmbeddingEnvelope>;
  nowMs(): number;
  upsert(collection: string, records: VectorRecord[]): Promise<void>;
  logger: Logger;
  multiVector: boolean;
  maxNew: number;
}

class Session implements SemanticRecallSession {
  private readonly byVectorId: Map<Id, VectorQueryResult>;
  private embedded = 0;
  private readonly matched = new Map<Id, number>();
  private readonly matchedScore = new Map<Id, number>();

  constructor(
    private readonly ctx: SessionContext,
    private readonly provider: AiProvider,
    private readonly queryEnvelope: EmbeddingEnvelope,
    private readonly collection: string,
    stored: readonly VectorQueryResult[],
    private readonly deadline: TurnDeadline,
    private readonly startedAtMs: number,
    private readonly endTurn: () => void,
  ) {
    this.byVectorId = new Map(stored.map((result) => [result.id, result]));
  }

  private usable(hit: VectorQueryResult): boolean {
    return (
      hit.metadata?.space === this.queryEnvelope.space &&
      hit.metadata?.dimensions === this.queryEnvelope.dimensions &&
      Number.isFinite(hit.score)
    );
  }

  async nearestMemoryIds(limit: number): Promise<Id[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const best = new Map<Id, number>();
    for (const hit of this.byVectorId.values()) {
      if (!this.usable(hit)) continue;
      const memoryId = memoryIdOf(hit);
      const previous = best.get(memoryId);
      if (previous === undefined || hit.score > previous) best.set(memoryId, hit.score);
    }
    return [...best.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => id);
  }

  matchedPassageOrdinals(): ReadonlyMap<Id, number> {
    return this.matched;
  }

  async score(candidates: readonly SemanticRecallCandidate[]): Promise<ReadonlyMap<Id, number> | null> {
    const internals = this.ctx;
    const eligible = internals.eligibleOf(candidates);
    if (eligible.length === 0) {
      this.endTurn();
      return null;
    }
    try {
      const scores = await internals.within(this.deadline, this.scoreAll(eligible));
      internals.logger.info('semantic recall scored', {
        candidates: eligible.length,
        scored: scores.size,
        embedded: this.embedded,
        latencyMs: internals.nowMs() - this.startedAtMs,
      });
      return scores;
    } catch (error) {
      internals.logger.warn('semantic recall unavailable; lexical recall used', {
        reason: error instanceof SemanticRecallFallback ? error.reason : 'ERROR',
        candidates: eligible.length,
        embedded: this.embedded,
        latencyMs: internals.nowMs() - this.startedAtMs,
      });
      return null;
    } finally {
      this.endTurn();
    }
  }

  /** Raise the memory's score and, for a passage vector (`<memoryId>#<ordinal>`), remember which passage is the best. */
  private note(scores: Map<Id, number>, memoryId: Id, vectorId: Id, value: number): void {
    const previous = scores.get(memoryId);
    raise(scores, memoryId, value);
    if (previous !== undefined && !(value > previous)) return;
    if (vectorId === memoryId || !vectorId.startsWith(`${memoryId}#`)) {
      this.matched.delete(memoryId);
      return;
    }
    const ordinal = Number(vectorId.slice(memoryId.length + 1));
    if (Number.isInteger(ordinal) && ordinal >= 0) this.matched.set(memoryId, ordinal);
  }

  private async scoreAll(eligible: readonly SemanticRecallCandidate[]): Promise<ReadonlyMap<Id, number>> {
    const internals = this.ctx;
    const scores = new Map<Id, number>();
    this.matched.clear();
    const missing: Array<{ memoryId: Id; vectorId: Id; text: string; contentHash: string }> = [];
    for (const candidate of eligible) {
      for (const unit of memoryVectorUnits(candidate.id, candidate.content, internals.multiVector)) {
        const contentHash = contentHashOf(unit.text);
        const hit = this.byVectorId.get(unit.vectorId);
        if (hit !== undefined && hit.metadata?.contentHash === contentHash && this.usable(hit)) {
          this.note(scores, candidate.id, unit.vectorId, clampUnit(hit.score));
        } else {
          missing.push({ memoryId: candidate.id, vectorId: unit.vectorId, text: unit.text, contentHash });
        }
      }
    }

    const fresh: VectorRecord[] = [];
    for (const item of missing.slice(0, internals.maxNew)) {
      const documentEnvelope = await internals.embed(this.provider, item.text, 'document', this.deadline);
      this.embedded += 1;
      if (
        documentEnvelope.space !== this.queryEnvelope.space ||
        documentEnvelope.dimensions !== this.queryEnvelope.dimensions
      ) {
        throw new SemanticRecallFallback('ERROR');
      }
      this.note(
        scores,
        item.memoryId,
        item.vectorId,
        clampUnit(cosineSimilarity(this.queryEnvelope.vector, documentEnvelope.vector)),
      );
      fresh.push({
        id: item.vectorId,
        vector: [...documentEnvelope.vector],
        metadata: {
          contentHash: item.contentHash,
          space: documentEnvelope.space,
          dimensions: documentEnvelope.dimensions,
          // a single-vector memory is its own id; only passages name their memory
          ...(item.vectorId === item.memoryId ? {} : { memoryId: item.memoryId }),
        },
      });
    }
    if (fresh.length > 0) {
      if (this.deadline.expired) throw new SemanticRecallFallback('TIMEOUT');
      await internals.upsert(this.collection, fresh);
    }
    return scores;
  }
}

/** The memory score is the maximum over its vectors. */
function raise(scores: Map<Id, number>, memoryId: Id, value: number): void {
  const previous = scores.get(memoryId);
  if (previous === undefined || value > previous) scores.set(memoryId, value);
}
