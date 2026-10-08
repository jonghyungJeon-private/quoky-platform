import { MemoryType } from './enums';
import type { Id, IsoTimestamp, Metadata } from './common';
import type { Capability } from './enums';

export const MAX_MEMORY_RETRIEVAL_RESULTS = 100;

export type DurableMemoryProvenance =
  | 'USER_PROVIDED'
  | 'ASSISTANT_GENERATED'
  | 'CORE_RUNTIME'
  | 'CANONICAL_PROJECT'
  | 'TOOL_OR_CONNECTOR'
  | 'LEGACY_UNKNOWN';

/** Recall intent is independent from the source that produced the memory. */
export type DurableMemoryKind = 'EPISODIC' | 'SEMANTIC';

/** Durable recall is background; it can never establish a current authoritative fact. */
export type DurableMemoryAuthorityLevel =
  | 'USER_CLAIM_OR_INTENT'
  | 'ASSISTANT_NON_AUTHORITATIVE'
  | 'NON_AUTHORITATIVE_BACKGROUND';

export interface DurableMemoryScope {
  readonly sessionId?: Id;
  readonly projectId?: Id;
  readonly actorId?: Id;
}

export interface DurableMemory {
  readonly id: Id;
  readonly content: string;
  readonly memoryType: MemoryType.LONG_TERM;
  readonly kind: DurableMemoryKind;
  readonly provenance: DurableMemoryProvenance;
  readonly authorityLevel: DurableMemoryAuthorityLevel;
  readonly scope: DurableMemoryScope;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly supersededBy?: Id;
  readonly metadata: Readonly<Metadata>;
}

export type DurableMemoryInput = Omit<DurableMemory, 'memoryType'> & {
  memoryType?: MemoryType.LONG_TERM;
};

export type MemoryPromotionTrigger =
  | 'EXPLICIT_USER_INSTRUCTION'
  | 'SYSTEM_DETECTED_IMPORTANCE'
  | 'PERIODIC_CONSOLIDATION';

export type MemoryCandidateValidationState = 'PENDING' | 'VALIDATED' | 'REJECTED';

export interface MemoryCandidateInput {
  content: string;
  sourceContent: string;
  trigger: MemoryPromotionTrigger;
  kind: DurableMemoryKind;
  provenance: DurableMemoryProvenance;
  authorityLevel: DurableMemoryAuthorityLevel;
  scope: DurableMemoryScope;
  metadata?: Metadata;
}

/** A transient proposal. It intentionally has no persisted-memory identity or timestamps. */
export interface MemoryCandidate {
  readonly content: string;
  readonly sourceContent: string;
  readonly trigger: MemoryPromotionTrigger;
  readonly kind: DurableMemoryKind;
  readonly provenance: DurableMemoryProvenance;
  readonly authorityLevel: DurableMemoryAuthorityLevel;
  readonly scope: DurableMemoryScope;
  readonly validationState: MemoryCandidateValidationState;
  readonly metadata: Readonly<Metadata>;
}

export interface MemoryRetrievalRequestInput {
  query: string;
  capability: Capability;
  scope: DurableMemoryScope;
  authorityFitness: readonly DurableMemoryAuthorityLevel[];
  maxResults: number;
  excludeIds?: readonly Id[];
}

export interface MemoryRetrievalRequest {
  readonly query: string;
  readonly capability: Capability;
  readonly scope: DurableMemoryScope;
  readonly authorityFitness: readonly DurableMemoryAuthorityLevel[];
  readonly maxResults: number;
  readonly excludeIds: readonly Id[];
}

/** How a recalled memory was ranked this turn (ADR-0098 D8): by the semantic scorer, or lexically only. */
export type MemoryRetrievalMode = 'lexical' | 'semantic';

export interface RetrievedMemoryInput {
  memory: DurableMemory;
  relevanceScore: number;
  /** Human-readable diagnostics only; never parsed (decisions read the structured fields below). */
  retrievalReason: string;
  /** Absent on records retrieved before the field existed (treated as unknown). */
  retrievalMode?: MemoryRetrievalMode;
  /** The raw semantic score in [0, 1]; present exactly when `retrievalMode` is `semantic`. */
  semanticScore?: number;
}

export interface RetrievedMemory extends RetrievedMemoryInput {}

export class DurableMemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableMemoryValidationError';
  }
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DurableMemoryValidationError(`${field} must not be empty`);
  }
}

function requireTimestamp(value: IsoTimestamp, field: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DurableMemoryValidationError(`${field} must be an ISO-8601 timestamp`);
  }
}

function validateScope(scope: DurableMemoryScope): void {
  const values = [scope.sessionId, scope.projectId, scope.actorId];
  if (!values.some((value) => value !== undefined)) {
    throw new DurableMemoryValidationError('scope must contain at least one constraint');
  }
  for (const value of values) {
    if (value !== undefined) requireText(value, 'scope identifier');
  }
}

const AUTHORITY_BY_PROVENANCE: Readonly<
  Record<DurableMemoryProvenance, DurableMemoryAuthorityLevel>
> = Object.freeze({
  USER_PROVIDED: 'USER_CLAIM_OR_INTENT',
  ASSISTANT_GENERATED: 'ASSISTANT_NON_AUTHORITATIVE',
  CORE_RUNTIME: 'NON_AUTHORITATIVE_BACKGROUND',
  CANONICAL_PROJECT: 'NON_AUTHORITATIVE_BACKGROUND',
  TOOL_OR_CONNECTOR: 'NON_AUTHORITATIVE_BACKGROUND',
  LEGACY_UNKNOWN: 'NON_AUTHORITATIVE_BACKGROUND',
});

const DURABLE_MEMORY_KINDS: ReadonlySet<string> = new Set(['EPISODIC', 'SEMANTIC']);
const DURABLE_AUTHORITY_LEVELS: ReadonlySet<string> = new Set(
  Object.values(AUTHORITY_BY_PROVENANCE),
);

function validateKind(kind: DurableMemoryKind): void {
  if (!DURABLE_MEMORY_KINDS.has(kind)) {
    throw new DurableMemoryValidationError('kind must be EPISODIC or SEMANTIC');
  }
}

function validateProvenanceAuthority(
  provenance: DurableMemoryProvenance,
  authorityLevel: DurableMemoryAuthorityLevel,
): void {
  if (authorityLevel === ('AUTHORITATIVE_CURRENT_FACT' as DurableMemoryAuthorityLevel)) {
    throw new DurableMemoryValidationError(
      'durable memory cannot have AUTHORITATIVE_CURRENT_FACT authority',
    );
  }
  if (!DURABLE_AUTHORITY_LEVELS.has(authorityLevel)) {
    throw new DurableMemoryValidationError('authorityLevel is not valid for durable memory');
  }
  const requiredAuthority = AUTHORITY_BY_PROVENANCE[provenance];
  if (requiredAuthority === undefined) {
    throw new DurableMemoryValidationError('provenance is not valid for durable memory');
  }
  if (authorityLevel !== requiredAuthority) {
    throw new DurableMemoryValidationError(
      `${provenance} provenance requires ${requiredAuthority} authority`,
    );
  }
}

function immutableScope(scope: DurableMemoryScope): DurableMemoryScope {
  return Object.freeze({ ...scope });
}

function cloneAndFreezeMetadataValue(value: unknown, ancestors: ReadonlySet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) {
    throw new DurableMemoryValidationError('metadata must not contain circular references');
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeMetadataValue(entry, nextAncestors)));
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneAndFreezeMetadataValue(entry, nextAncestors),
      ]),
    ),
  );
}

function immutableMetadata(metadata: Metadata): Readonly<Metadata> {
  return cloneAndFreezeMetadataValue(metadata, new Set()) as Readonly<Metadata>;
}

export function createDurableMemory(input: DurableMemoryInput): DurableMemory {
  requireText(input.id, 'id');
  requireText(input.content, 'content');
  validateKind(input.kind);
  validateProvenanceAuthority(input.provenance, input.authorityLevel);
  validateScope(input.scope);
  requireTimestamp(input.createdAt, 'createdAt');
  requireTimestamp(input.updatedAt, 'updatedAt');
  if (input.updatedAt < input.createdAt) {
    throw new DurableMemoryValidationError('updatedAt must not precede createdAt');
  }
  if (input.expiresAt !== undefined) {
    requireTimestamp(input.expiresAt, 'expiresAt');
    if (input.expiresAt <= input.createdAt) {
      throw new DurableMemoryValidationError('expiresAt must follow createdAt');
    }
  }
  if (input.supersededBy !== undefined) {
    requireText(input.supersededBy, 'supersededBy');
    if (input.supersededBy === input.id) {
      throw new DurableMemoryValidationError('a memory cannot supersede itself');
    }
  }

  return Object.freeze({
    ...input,
    memoryType: MemoryType.LONG_TERM,
    scope: immutableScope(input.scope),
    metadata: immutableMetadata(input.metadata),
  });
}

export function createMemoryCandidate(input: MemoryCandidateInput): MemoryCandidate {
  requireText(input.content, 'content');
  requireText(input.sourceContent, 'sourceContent');
  validateKind(input.kind);
  validateProvenanceAuthority(input.provenance, input.authorityLevel);
  validateScope(input.scope);
  return Object.freeze({
    ...input,
    scope: immutableScope(input.scope),
    validationState: 'PENDING',
    metadata: immutableMetadata(input.metadata ?? {}),
  });
}

export function createMemoryRetrievalRequest(
  input: MemoryRetrievalRequestInput,
): MemoryRetrievalRequest {
  requireText(input.query, 'query');
  validateScope(input.scope);
  if (
    !Number.isInteger(input.maxResults) ||
    input.maxResults < 1 ||
    input.maxResults > MAX_MEMORY_RETRIEVAL_RESULTS
  ) {
    throw new DurableMemoryValidationError(
      `maxResults must be an integer between 1 and ${MAX_MEMORY_RETRIEVAL_RESULTS}`,
    );
  }
  if (input.authorityFitness.length === 0) {
    throw new DurableMemoryValidationError('authorityFitness must not be empty');
  }
  for (const authorityLevel of input.authorityFitness) {
    if (
      authorityLevel === ('AUTHORITATIVE_CURRENT_FACT' as DurableMemoryAuthorityLevel) ||
      !DURABLE_AUTHORITY_LEVELS.has(authorityLevel)
    ) {
      throw new DurableMemoryValidationError(
        'authorityFitness contains authority invalid for durable memory',
      );
    }
  }
  const excludeIds = input.excludeIds ?? [];
  for (const id of excludeIds) requireText(id, 'excludeId');
  if (new Set(excludeIds).size !== excludeIds.length) {
    throw new DurableMemoryValidationError('excludeIds must not contain duplicates');
  }
  return Object.freeze({
    ...input,
    scope: immutableScope(input.scope),
    authorityFitness: Object.freeze([...input.authorityFitness]),
    excludeIds: Object.freeze([...excludeIds]),
  });
}

export function createRetrievedMemory(input: RetrievedMemoryInput): RetrievedMemory {
  if (
    !Number.isFinite(input.relevanceScore) ||
    input.relevanceScore < 0 ||
    input.relevanceScore > 1
  ) {
    throw new DurableMemoryValidationError('relevanceScore must be between 0 and 1');
  }
  requireText(input.retrievalReason, 'retrievalReason');
  if (input.semanticScore !== undefined) {
    if (input.retrievalMode !== 'semantic') {
      throw new DurableMemoryValidationError('semanticScore requires retrievalMode semantic');
    }
    if (!Number.isFinite(input.semanticScore) || input.semanticScore < 0 || input.semanticScore > 1) {
      throw new DurableMemoryValidationError('semanticScore must be between 0 and 1');
    }
  }
  return Object.freeze({ ...input });
}
