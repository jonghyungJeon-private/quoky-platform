import { createHash } from 'node:crypto';
import type {
  DurableMemory,
  DurableMemoryScope,
  IsoTimestamp,
  MemoryRecord,
  MemoryRetrievalRequest,
  RetrievedMemory,
} from '../domain';
import { createDurableMemory, createRetrievedMemory } from '../domain';
import type { MemoryRepository } from '../ports';
import { now } from '../util/clock';
import { scoreSemanticRelevance } from './semantic-relevance';

export const DEFAULT_DURABLE_RECALL_LIMIT = 10;
const CANDIDATE_FETCH_MULTIPLIER = 5;
const MIN_CANDIDATE_FETCH = 50;
const DEFAULT_RECENCY_WEIGHT = 0.25;
const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface DefaultMemoryRetrieverOptions {
  /** Hard cap applied in addition to the request's maxResults. */
  limit?: number;
  /** Share of the final score assigned to exponentially decayed recency. */
  recencyWeight?: number;
  recencyHalfLifeMs?: number;
  /** Injectable only to make lifecycle and recency decisions deterministic. */
  clock?: () => IsoTimestamp;
}

/**
 * Storage-neutral durable recall boundary. Implementations own bounded hybrid
 * scoring across relevance, recency, importance, scope, authority, and redundancy.
 */
export interface MemoryRetriever {
  retrieve(query: MemoryRetrievalRequest): Promise<RetrievedMemory[]>;
}

function metadataText(record: MemoryRecord, key: string): string | undefined {
  const value = record.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function normalizedContentHash(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ').toLocaleLowerCase('und');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function scopeMatches(record: MemoryRecord, scope: DurableMemoryScope): boolean {
  return (
    scope.actorId !== undefined &&
    record.scope.userId === scope.actorId &&
    (scope.sessionId === undefined || record.scope.sessionId === scope.sessionId) &&
    (scope.projectId === undefined || record.scope.projectId === scope.projectId) &&
    record.scope.channelId === undefined &&
    record.scope.threadId === undefined &&
    record.scope.taskId === undefined
  );
}

function toDurableMemory(record: MemoryRecord): DurableMemory {
  return createDurableMemory({
    id: record.id,
    content: record.content,
    kind: metadataText(record, 'kind') as DurableMemory['kind'],
    provenance: metadataText(record, 'provenance') as DurableMemory['provenance'],
    authorityLevel: metadataText(
      record,
      'authorityLevel',
    ) as DurableMemory['authorityLevel'],
    scope: {
      ...(record.scope.sessionId ? { sessionId: record.scope.sessionId } : {}),
      ...(record.scope.projectId ? { projectId: record.scope.projectId } : {}),
      ...(record.scope.userId ? { actorId: record.scope.userId } : {}),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(metadataText(record, 'expiresAt')
      ? { expiresAt: metadataText(record, 'expiresAt') }
      : {}),
    ...(metadataText(record, 'supersededBy')
      ? { supersededBy: metadataText(record, 'supersededBy') }
      : {}),
    metadata: { ...(record.metadata ?? {}) },
  });
}

/** Storage-neutral deterministic lexical fallback for ADR-0073 durable recall. */
export class DefaultMemoryRetriever implements MemoryRetriever {
  private readonly limit: number;
  private readonly recencyWeight: number;
  private readonly recencyHalfLifeMs: number;
  private readonly clock: () => IsoTimestamp;

  constructor(
    private readonly repository: MemoryRepository,
    options: DefaultMemoryRetrieverOptions = {},
  ) {
    this.limit = options.limit ?? DEFAULT_DURABLE_RECALL_LIMIT;
    this.recencyWeight = options.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;
    this.recencyHalfLifeMs = options.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
    this.clock = options.clock ?? now;

    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new RangeError('limit must be a positive integer');
    }
    if (
      !Number.isFinite(this.recencyWeight) ||
      this.recencyWeight < 0 ||
      this.recencyWeight > 1
    ) {
      throw new RangeError('recencyWeight must be between 0 and 1');
    }
    if (!Number.isFinite(this.recencyHalfLifeMs) || this.recencyHalfLifeMs <= 0) {
      throw new RangeError('recencyHalfLifeMs must be a positive finite number');
    }
  }

  async retrieve(request: MemoryRetrievalRequest): Promise<RetrievedMemory[]> {
    const retrievalTime = this.clock();
    const retrievalTimeMs = Date.parse(retrievalTime);
    if (Number.isNaN(retrievalTimeMs)) throw new Error('clock must return an ISO-8601 timestamp');

    const limit = Math.min(request.maxResults, this.limit);
    // ADR-0073 amendment: fail closed without an actor; query by actor only.
    if (!request.scope.actorId) return [];
    const records = await this.repository.findDurableCandidates({
      scope: {
        ...(request.scope.sessionId ? { sessionId: request.scope.sessionId } : {}),
        ...(request.scope.projectId ? { projectId: request.scope.projectId } : {}),
        userId: request.scope.actorId,
      },
      limit: Math.max(limit * CANDIDATE_FETCH_MULTIPLIER, MIN_CANDIDATE_FETCH),
      excludeIds: [...request.excludeIds],
      excludeExpired: true,
      excludeSuperseded: true,
    });

    const scored = records.flatMap((record) => {
      if (!scopeMatches(record, request.scope) || request.excludeIds.includes(record.id)) return [];
      const expiresAt = metadataText(record, 'expiresAt');
      if (expiresAt !== undefined && Date.parse(expiresAt) < retrievalTimeMs) return [];
      if (metadataText(record, 'supersededBy') !== undefined) return [];

      try {
        const memory = toDurableMemory(record);
        if (!request.authorityFitness.includes(memory.authorityLevel)) return [];
        const lexicalScore = scoreSemanticRelevance(request.query, memory.content);
        const updatedAtMs = Date.parse(memory.updatedAt);
        const ageMs = Math.max(0, retrievalTimeMs - updatedAtMs);
        const recencyScore = Math.exp((-Math.LN2 * ageMs) / this.recencyHalfLifeMs);
        const relevanceScore =
          lexicalScore * (1 - this.recencyWeight) + recencyScore * this.recencyWeight;
        return [{ memory, lexicalScore, recencyScore, relevanceScore }];
      } catch {
        return [];
      }
    });

    scored.sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        b.memory.updatedAt.localeCompare(a.memory.updatedAt) ||
        a.memory.id.localeCompare(b.memory.id),
    );

    const seenContent = new Set<string>();
    const results: RetrievedMemory[] = [];
    for (const candidate of scored) {
      const contentKey = normalizedContentHash(candidate.memory.content);
      if (seenContent.has(contentKey)) continue;
      seenContent.add(contentKey);
      results.push(
        createRetrievedMemory({
          memory: candidate.memory,
          relevanceScore: candidate.relevanceScore,
          retrievalReason: `lexical=${candidate.lexicalScore.toFixed(4)}; recency=${candidate.recencyScore.toFixed(4)}`,
        }),
      );
      if (results.length >= limit) break;
    }
    return results;
  }
}
