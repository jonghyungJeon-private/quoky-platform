import { createHash } from 'node:crypto';
import { Capability } from '../../domain';
import type { Id, IsoTimestamp } from '../../domain';
import { NoProviderAvailableError } from '../../errors';
import type { AiProvider, Logger, ProviderSelector, VectorProvider, VectorRecord } from '../../ports';
import { now } from '../../util/clock';
import { containsCredentialMaterial } from '../credential-guard';
import {
  cosineSimilarity,
  embeddingRequestMetadata,
  parseEmbeddingEnvelope,
  type EmbeddingEnvelope,
  type EmbeddingRole,
} from './embedding-envelope';

/** Collection holding durable-memory vectors. Vector ids equal memory ids; the store is a rebuildable cache. */
export const DURABLE_MEMORY_VECTOR_COLLECTION = 'durable-memory-v1';
export const DEFAULT_MAX_NEW_EMBEDDINGS_PER_TURN = 4;
export const DEFAULT_SEMANTIC_TURN_BUDGET_MS = 3_000;
export const DEFAULT_MAX_INDEXED_VECTORS = 20_000;

/** One already-eligible durable candidate. The scorer never sees, adds or widens candidates itself. */
export interface SemanticRecallCandidate {
  readonly id: Id;
  readonly content: string;
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
}

export interface SemanticRecallScorerDeps {
  readonly selector: ProviderSelector;
  readonly vectors: VectorProvider;
  readonly logger?: Logger;
  /** Shared clock seam; used only to measure latency for the bounded log line. */
  readonly clock?: () => IsoTimestamp;
}

export interface SemanticRecallScorerOptions {
  readonly collection?: string;
  /** Document embeddings created per turn (the query embedding is separate). Default 4. */
  readonly maxNewEmbeddingsPerTurn?: number;
  /** Wall-clock budget for the whole scoring step, including provider selection. Default 3 s. */
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

/**
 * Opt-in local semantic recall (ADR-0098 D8). Re-ranks ONLY the durable candidates the retriever already found
 * eligible: it embeds the query and at most `maxNewEmbeddingsPerTurn` missing or stale candidates through the
 * `EMBEDDING` capability (selected by capability, never by provider id), caches their vectors in the
 * `VectorProvider`, and returns cosine scores clamped to [0, 1]. Credential-like text is never sent to a
 * provider. Every failure (no provider, timeout, malformed envelope, store error) returns `null` so recall
 * falls back to lexical; the log line carries counts and latency only, never content.
 */
export class SemanticRecallScorer implements SemanticRecallScoring {
  private readonly collection: string;
  private readonly maxNew: number;
  private readonly turnBudgetMs: number;
  private readonly embeddingTimeoutMs: number;
  private readonly maxIndexed: number;
  private readonly logger: Logger;
  private readonly clock: () => IsoTimestamp;

  constructor(
    private readonly deps: SemanticRecallScorerDeps,
    options: SemanticRecallScorerOptions = {},
  ) {
    this.collection = options.collection ?? DURABLE_MEMORY_VECTOR_COLLECTION;
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
    if (candidates.length === 0) return null;
    // Never embed credential-matching content: neither the query nor any candidate reaches a provider.
    if (query.trim().length === 0 || containsCredentialMaterial(query)) return null;
    const seen = new Set<Id>();
    const eligible = candidates.filter((candidate) => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return candidate.content.trim().length > 0 && !containsCredentialMaterial(candidate.content);
    });
    if (eligible.length === 0) return null;

    const startedAtMs = this.nowMs();
    const deadline = { expiresAtMs: startedAtMs + this.turnBudgetMs, expired: false };
    let embedded = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadline.expired = true;
        reject(new SemanticRecallFallback('TIMEOUT'));
      }, this.turnBudgetMs);
    });
    const task = this.scoreWithin(query, eligible, deadline, () => {
      embedded += 1;
    });
    // A late rejection after the deadline must not surface as an unhandled rejection.
    task.catch(() => undefined);
    try {
      const scores = await Promise.race([task, timeout]);
      this.logger.info('semantic recall scored', {
        candidates: eligible.length,
        scored: scores.size,
        embedded,
        latencyMs: this.nowMs() - startedAtMs,
      });
      return scores;
    } catch (error) {
      deadline.expired = true;
      this.logger.warn('semantic recall unavailable; lexical recall used', {
        reason: error instanceof SemanticRecallFallback ? error.reason : 'ERROR',
        candidates: eligible.length,
        embedded,
        latencyMs: this.nowMs() - startedAtMs,
      });
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async scoreWithin(
    query: string,
    eligible: readonly SemanticRecallCandidate[],
    deadline: { readonly expiresAtMs: number; expired: boolean },
    onEmbedded: () => void,
  ): Promise<ReadonlyMap<Id, number>> {
    let provider: AiProvider;
    try {
      provider = await this.deps.selector.select(Capability.EMBEDDING);
    } catch (error) {
      throw error instanceof NoProviderAvailableError ? new SemanticRecallFallback('NO_PROVIDER') : error;
    }

    const queryEnvelope = await this.embed(provider, query, 'query', deadline);
    const stored = await this.deps.vectors.query(this.collection, [...queryEnvelope.vector], this.maxIndexed);
    this.assertWithinBudget(deadline);
    const storedById = new Map(stored.map((result) => [result.id, result]));

    const scores = new Map<Id, number>();
    const missing: Array<{ candidate: SemanticRecallCandidate; contentHash: string }> = [];
    for (const candidate of eligible) {
      const contentHash = contentHashOf(candidate.content);
      const hit = storedById.get(candidate.id);
      if (
        hit !== undefined &&
        hit.metadata?.contentHash === contentHash &&
        hit.metadata?.space === queryEnvelope.space &&
        hit.metadata?.dimensions === queryEnvelope.dimensions &&
        Number.isFinite(hit.score)
      ) {
        scores.set(candidate.id, clampUnit(hit.score));
      } else {
        missing.push({ candidate, contentHash });
      }
    }

    const fresh: VectorRecord[] = [];
    for (const { candidate, contentHash } of missing.slice(0, this.maxNew)) {
      const documentEnvelope = await this.embed(provider, candidate.content, 'document', deadline);
      onEmbedded();
      if (
        documentEnvelope.space !== queryEnvelope.space ||
        documentEnvelope.dimensions !== queryEnvelope.dimensions
      ) {
        throw new SemanticRecallFallback('ERROR');
      }
      scores.set(candidate.id, clampUnit(cosineSimilarity(queryEnvelope.vector, documentEnvelope.vector)));
      fresh.push({
        id: candidate.id,
        vector: [...documentEnvelope.vector],
        metadata: {
          contentHash,
          space: documentEnvelope.space,
          dimensions: documentEnvelope.dimensions,
        },
      });
    }
    if (fresh.length > 0) {
      this.assertWithinBudget(deadline);
      await this.deps.vectors.upsert(this.collection, fresh);
    }
    return scores;
  }

  private async embed(
    provider: AiProvider,
    text: string,
    role: EmbeddingRole,
    deadline: { readonly expiresAtMs: number; expired: boolean },
  ): Promise<EmbeddingEnvelope> {
    this.assertWithinBudget(deadline);
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

  private assertWithinBudget(deadline: { readonly expiresAtMs: number; expired: boolean }): void {
    if (deadline.expired) throw new SemanticRecallFallback('TIMEOUT');
  }

  private nowMs(): number {
    const value = Date.parse(this.clock());
    return Number.isNaN(value) ? 0 : value;
  }
}
