import type { AiFailureKind } from './domain';

/** Thrown by skeleton methods whose business logic is intentionally deferred. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** No AiProvider could serve the requested capability (none available). */
export class NoProviderAvailableError extends Error {
  constructor(capability: string) {
    super(`No available AiProvider for capability: ${capability}`);
    this.name = 'NoProviderAvailableError';
  }
}

/**
 * A classified AI execution failure (ADR-0015). The provider sets `kind` and a
 * technical `message` (already secret-masked); the core maps the kind to a
 * user-facing message and stores a summary on the TaskRun.
 */
export class AiProviderError extends Error {
  constructor(
    readonly kind: AiFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** An illegal task status transition was attempted. */
export class InvalidTaskTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

/** A workspace mutation was attempted while git was dirty / unsafe. */
export class WorkspaceNotSafeError extends Error {
  constructor(detail: string) {
    super(`Workspace not safe to modify: ${detail}`);
    this.name = 'WorkspaceNotSafeError';
  }
}

/** Ephemeral ADR-0088/0089 guard/bypass failure; no durable lifecycle.
 *
 * `UNRESOLVED_STARTED_RUN` is a canonical live-attempt policy conflict.
 * `TASK_RUN_STORAGE_BUSY` is persistence lock contention: no TaskRun start committed, no attempt
 * identity exists, and it is deliberately NOT the same outcome as a live-attempt conflict. Adapters
 * own driver-error translation; Core never inspects driver codes, classes or messages.
 * `CONTINUATION_RUN_DELETE_FORBIDDEN` is the ADR-0089 refusal to delete a continuation-bound TaskRun.
 */
export class GuardedTaskRunStartError extends Error {
  constructor(readonly code: 'STALE_HANDOFF' | 'BINDING_MISMATCH' | 'WORK_ITEM_NOT_CONTINUABLE'
    | 'TASK_NOT_EXECUTABLE' | 'APPROVAL_STALE' | 'UNRESOLVED_STARTED_RUN'
    | 'CONTINUATION_GUARD_REQUIRED' | 'CONTINUATION_RUN_DELETE_FORBIDDEN'
    | 'CONTINUATION_TERMINALIZATION_REQUIRES_SECURE_PATH'
    | 'TASK_RUN_STORAGE_BUSY') {
    super(code);
    this.name = 'GuardedTaskRunStartError';
  }
}

/**
 * R3-A containment evidence conflict (ADR-0089 amendment A-1). A single coherent bounded classification
 * for every attempt to violate the containment evidence state machine: replacing immutable binding
 * evidence, removing/changing append-once post-attempt evidence, dropping evidence, or acting on a
 * TaskRun that is not in the required STARTED state. Adapters own driver-error translation; Core never
 * inspects driver codes. The single `code` keeps the classification from multiplying unnecessarily
 * while `reason` records the bounded cause for audit/tests.
 */
export class ContainmentEvidenceConflictError extends Error {
  readonly code = 'CONTAINMENT_EVIDENCE_CONFLICT' as const;
  constructor(
    readonly reason:
      | 'RUN_NOT_FOUND'
      | 'RUN_NOT_STARTED'
      | 'RUN_NOT_CONTINUATION_BOUND'
      | 'CALLER_SUPPLIED_EVIDENCE'
      | 'BINDING_DIGEST_CONFLICT'
      | 'BINDING_MISSING'
      | 'POST_ATTEMPT_CONFLICT'
      | 'EVIDENCE_REMOVED'
      | 'MALFORMED_EVIDENCE',
  ) {
    super('CONTAINMENT_EVIDENCE_CONFLICT');
    this.name = 'ContainmentEvidenceConflictError';
  }
}
