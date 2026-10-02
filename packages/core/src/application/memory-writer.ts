import type {
  DurableMemory,
  DurableMemoryScope,
  Id,
  MemoryCandidate,
  MemoryCandidateInput,
  MemoryRecord,
  MemoryScope,
} from '../domain';
import { createDurableMemory, createMemoryCandidate, MemoryType } from '../domain';
import { now } from '../util/clock';
import { newId } from '../util/id';
import { CREDENTIAL_REJECTION_REASON, containsCredentialMaterial } from './credential-guard';

export type MemoryWriteDecision =
  | {
      readonly outcome: 'PROMOTED';
      readonly memory: DurableMemory;
      readonly policyReason: string;
    }
  | {
      readonly outcome: 'DUPLICATE';
      readonly existingMemoryId: Id;
      readonly policyReason: string;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly policyReason: string;
    }
  | {
      readonly outcome: 'SUPERSEDING';
      readonly memory: DurableMemory;
      readonly supersededMemoryId: Id;
      readonly policyReason: string;
    };

/** An exact, scope-bound forget request; scope-wide deletion is intentionally absent. */
export interface MemoryForgetRequest {
  readonly memoryId: Id;
  readonly scope: DurableMemoryScope;
}

export type MemoryForgetResult =
  | {
      readonly outcome: 'FORGOTTEN';
      readonly memoryId: Id;
      readonly policyReason: string;
    }
  | {
      readonly outcome: 'NOT_FOUND';
      readonly memoryId: Id;
      readonly policyReason: string;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly memoryId: Id;
      readonly policyReason: string;
    };

/** Candidate creation and durable promotion policy boundary (ADR-0073 Section 5). */
export interface MemoryWriter {
  createCandidate(input: MemoryCandidateInput): MemoryCandidate;
  promote(candidate: MemoryCandidate): Promise<MemoryWriteDecision>;
  forget(request: MemoryForgetRequest): Promise<MemoryForgetResult>;
}

type DurableMemoryPersistence = Pick<
  import('./memory-manager').MemoryManager,
  'durableMemory' | 'durableMemories' | 'saveDurable' | 'forgetDurable'
>;

type PersistenceOperation = 'PROMOTE' | 'FORGET';

class MemoryWriterPersistenceError extends Error {
  readonly code = 'PERSISTENCE_FAILURE';

  constructor(
    readonly operation: PersistenceOperation,
    cause: unknown,
  ) {
    super(`MemoryWriter ${operation.toLowerCase()} persistence failed`, { cause });
    this.name = 'MemoryWriterPersistenceError';
  }
}

const MAX_DURABLE_CONTENT_CHARACTERS = 4_000;
const WRITER_OWNED_LIFECYCLE_METADATA = ['expiresAt', 'supersededBy'] as const;
const SECRET_MATERIAL =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+)/i;

function persistenceScope(scope: DurableMemoryScope): MemoryScope {
  return {
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.actorId ? { userId: scope.actorId } : {}),
  };
}

function sameScope(record: MemoryRecord, scope: DurableMemoryScope): boolean {
  return (
    record.scope.sessionId === scope.sessionId &&
    record.scope.projectId === scope.projectId &&
    record.scope.userId === scope.actorId &&
    record.scope.channelId === undefined &&
    record.scope.threadId === undefined &&
    record.scope.taskId === undefined
  );
}

function normalizedContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function metadataText(record: MemoryRecord, key: string): string | undefined {
  const value = record.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function toDurableMemory(record: MemoryRecord): DurableMemory {
  const kind = metadataText(record, 'kind');
  const provenance = metadataText(record, 'provenance');
  const authorityLevel = metadataText(record, 'authorityLevel');
  const expiresAt = metadataText(record, 'expiresAt');
  const supersededBy = metadataText(record, 'supersededBy');

  return createDurableMemory({
    id: record.id,
    content: record.content,
    kind: kind as DurableMemory['kind'],
    provenance: provenance as DurableMemory['provenance'],
    authorityLevel: authorityLevel as DurableMemory['authorityLevel'],
    scope: {
      ...(record.scope.sessionId ? { sessionId: record.scope.sessionId } : {}),
      ...(record.scope.projectId ? { projectId: record.scope.projectId } : {}),
      ...(record.scope.userId ? { actorId: record.scope.userId } : {}),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(supersededBy ? { supersededBy } : {}),
    metadata: { ...(record.metadata ?? {}) },
  });
}

/**
 * Deterministic ADR-0073 lifecycle policy over MemoryManager-owned persistence.
 * It has no Provider, model, vector, adapter, or parallel repository dependency.
 */
export class DefaultMemoryWriter implements MemoryWriter {
  constructor(private readonly memoryManager: DurableMemoryPersistence) {}

  createCandidate(input: MemoryCandidateInput): MemoryCandidate {
    return createMemoryCandidate(input);
  }

  async promote(candidate: MemoryCandidate): Promise<MemoryWriteDecision> {
    const rejection = DefaultMemoryWriter.promotionRejection(candidate);
    if (rejection !== undefined) return { outcome: 'REJECTED', policyReason: rejection };

    let existing: MemoryRecord[];
    try {
      existing = await this.memoryManager.durableMemories(persistenceScope(candidate.scope));
    } catch (cause) {
      throw new MemoryWriterPersistenceError('PROMOTE', cause);
    }

    const duplicate = existing.find(
      (record) =>
        sameScope(record, candidate.scope) &&
        metadataText(record, 'provenance') === candidate.provenance &&
        normalizedContent(record.content) === normalizedContent(candidate.content),
    );
    if (duplicate !== undefined) {
      return {
        outcome: 'DUPLICATE',
        existingMemoryId: duplicate.id,
        policyReason: 'normalized content already exists with matching scope and provenance',
      };
    }

    const supersededMemoryId =
      typeof candidate.metadata['supersedesMemoryId'] === 'string'
        ? candidate.metadata['supersedesMemoryId']
        : undefined;
    let supersededRecord: MemoryRecord | undefined;
    if (supersededMemoryId !== undefined) {
      const supersessionValidation = await this.validateSupersession(
        supersededMemoryId,
        candidate,
      );
      if ('policyReason' in supersessionValidation) {
        return { outcome: 'REJECTED', policyReason: supersessionValidation.policyReason };
      }
      supersededRecord = supersessionValidation.record;
    }

    const timestamp = now();
    const record: MemoryRecord = {
      id: newId(),
      type: MemoryType.LONG_TERM,
      scope: persistenceScope(candidate.scope),
      content: candidate.content.trim(),
      metadata: {
        ...candidate.metadata,
        kind: candidate.kind,
        provenance: candidate.provenance,
        authorityLevel: candidate.authorityLevel,
        sourceContent: candidate.sourceContent,
        trigger: candidate.trigger,
        ...(supersededMemoryId ? { supersedesMemoryId: supersededMemoryId } : {}),
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    let saved: MemoryRecord;
    try {
      saved = await this.memoryManager.saveDurable(record);
    } catch (cause) {
      throw new MemoryWriterPersistenceError('PROMOTE', cause);
    }
    if (supersededRecord !== undefined) {
      try {
        await this.memoryManager.saveDurable({
          ...supersededRecord,
          metadata: { ...(supersededRecord.metadata ?? {}), supersededBy: saved.id },
          updatedAt: timestamp,
        });
      } catch (cause) {
        try {
          await this.memoryManager.forgetDurable(saved.id);
        } catch (rollbackCause) {
          throw new MemoryWriterPersistenceError(
            'PROMOTE',
            new AggregateError(
              [cause, rollbackCause],
              'failed to mark superseded memory and roll back the new version',
            ),
          );
        }
        throw new MemoryWriterPersistenceError('PROMOTE', cause);
      }
    }
    const memory = toDurableMemory(saved);
    return supersededMemoryId
      ? {
          outcome: 'SUPERSEDING',
          memory,
          supersededMemoryId,
          policyReason: 'changed scoped knowledge preserves its superseded memory reference',
        }
      : { outcome: 'PROMOTED', memory, policyReason: 'candidate passed durable-memory policy' };
  }

  async forget(request: MemoryForgetRequest): Promise<MemoryForgetResult> {
    let record: MemoryRecord | null;
    try {
      record = await this.memoryManager.durableMemory(request.memoryId);
    } catch (cause) {
      throw new MemoryWriterPersistenceError('FORGET', cause);
    }
    if (record === null) {
      return {
        outcome: 'NOT_FOUND',
        memoryId: request.memoryId,
        policyReason: 'no memory exists for the exact id',
      };
    }
    if (record.type !== MemoryType.LONG_TERM || !sameScope(record, request.scope)) {
      return {
        outcome: 'REJECTED',
        memoryId: request.memoryId,
        policyReason: 'forget policy requires an exact LONG_TERM memory scope match',
      };
    }
    try {
      await this.memoryManager.forgetDurable(record.id);
    } catch (cause) {
      throw new MemoryWriterPersistenceError('FORGET', cause);
    }
    return {
      outcome: 'FORGOTTEN',
      memoryId: record.id,
      policyReason: 'exact scoped forget request passed policy',
    };
  }

  private static promotionRejection(candidate: MemoryCandidate): string | undefined {
    try {
      createMemoryCandidate(candidate);
    } catch (error) {
      return error instanceof Error
        ? `candidate validation failed: ${error.message}`
        : 'candidate validation failed';
    }
    if (candidate.validationState !== 'PENDING') {
      return 'candidate must be pending application validation';
    }
    const reservedMetadata = WRITER_OWNED_LIFECYCLE_METADATA.find(
      (key) => candidate.metadata[key] !== undefined,
    );
    if (reservedMetadata !== undefined) {
      return `candidate metadata cannot set writer-owned lifecycle field: ${reservedMetadata}`;
    }
    if (candidate.content.length > MAX_DURABLE_CONTENT_CHARACTERS) {
      return `candidate exceeds ${MAX_DURABLE_CONTENT_CHARACTERS} characters`;
    }
    if (
      SECRET_MATERIAL.test(candidate.content) ||
      SECRET_MATERIAL.test(candidate.sourceContent) ||
      containsCredentialMaterial(candidate.content) ||
      containsCredentialMaterial(candidate.sourceContent)
    ) {
      return CREDENTIAL_REJECTION_REASON;
    }
    return undefined;
  }

  private async validateSupersession(
    supersededMemoryId: Id,
    candidate: MemoryCandidate,
  ): Promise<{ readonly record: MemoryRecord } | { readonly policyReason: string }> {
    let prior: MemoryRecord | null;
    try {
      prior = await this.memoryManager.durableMemory(supersededMemoryId);
    } catch (cause) {
      throw new MemoryWriterPersistenceError('PROMOTE', cause);
    }
    if (prior === null) return { policyReason: 'superseded memory does not exist' };
    if (prior.type !== MemoryType.LONG_TERM || !sameScope(prior, candidate.scope)) {
      return { policyReason: 'supersession requires an exact LONG_TERM memory scope match' };
    }
    if (metadataText(prior, 'provenance') !== candidate.provenance) {
      return { policyReason: 'supersession cannot change memory provenance' };
    }
    if (metadataText(prior, 'supersededBy') !== undefined) {
      return { policyReason: 'superseded memory is already superseded' };
    }
    return { record: prior };
  }
}
