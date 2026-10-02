import type { Id, IsoTimestamp } from './common';
import type { ResourceRef } from './resource-ref';

/** High-level durable-work lifecycle only (ADR-0075). */
export enum WorkItemStatus {
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELED = 'CANCELED',
}

/** Typed creation source; never a generic metadata or trigger-state container. */
export type WorkItemOrigin = 'conversation' | 'connector';

/**
 * CAP-011 durable personal-work aggregate (ADR-0075).
 *
 * It owns identity, Actor ownership, an optional Project reference, external
 * ResourceRef correlation, high-level lifecycle and origin. Execution,
 * approval, provider, conversation and workflow state remain outside it.
 */
export interface WorkItem {
  readonly id: Id;
  readonly actorId: Id;
  readonly projectId?: Id;
  /** Normalized by `normalizeWorkItemTitle` (ADR-0100 D4); absent on legacy rows. */
  readonly title?: string;
  readonly resourceRefs: readonly ResourceRef[];
  readonly status: WorkItemStatus;
  readonly origin: WorkItemOrigin;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

const TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  [WorkItemStatus.ACTIVE]: [WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED],
  [WorkItemStatus.COMPLETED]: [],
  [WorkItemStatus.CANCELED]: [],
};

export function canTransitionWorkItem(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Return a new aggregate value; persisted WorkItems are never mutated in place. */
export function transitionWorkItem(
  item: WorkItem,
  to: WorkItemStatus,
  updatedAt: IsoTimestamp,
): WorkItem {
  if (!canTransitionWorkItem(item.status, to)) {
    throw new Error(`Invalid WorkItem transition: ${item.status} -> ${to}`);
  }
  return { ...item, status: to, updatedAt };
}

/** Deduplicate correlations by stable ResourceRef identity while preserving order. */
export function uniqueResourceRefs(refs: readonly ResourceRef[]): readonly ResourceRef[] {
  const identities = new Set<string>();
  return refs.filter((ref) => {
    if (identities.has(ref.identity)) return false;
    identities.add(ref.identity);
    return true;
  });
}

/** Maximum ResourceRef correlations one WorkItem may hold (ADR-0100 D4). */
export const WORK_ITEM_MAX_RESOURCE_REFS = 10;

/** Maximum WorkItem title length in characters, after normalization (ADR-0100 D4). */
export const WORK_ITEM_MAX_TITLE_LENGTH = 200;

export type WorkItemTitleErrorCode = 'EMPTY' | 'TOO_LONG';

export class WorkItemTitleError extends Error {
  constructor(readonly code: WorkItemTitleErrorCode) {
    super(
      code === 'EMPTY'
        ? 'WorkItem title must not be empty'
        : `WorkItem title must be at most ${WORK_ITEM_MAX_TITLE_LENGTH} characters`,
    );
    this.name = 'WorkItemTitleError';
  }
}

/** Trim, collapse whitespace runs to one space, and require 1..200 characters. */
export function normalizeWorkItemTitle(raw: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (title.length === 0) throw new WorkItemTitleError('EMPTY');
  if (Array.from(title).length > WORK_ITEM_MAX_TITLE_LENGTH) {
    throw new WorkItemTitleError('TOO_LONG');
  }
  return title;
}

export type WorkItemCorrelationErrorCode = 'NOT_ACTIVE' | 'TOO_MANY_REFS';

export class WorkItemCorrelationError extends Error {
  constructor(readonly code: WorkItemCorrelationErrorCode) {
    super(
      code === 'NOT_ACTIVE'
        ? 'WorkItem can be correlated only while ACTIVE'
        : `WorkItem may hold at most ${WORK_ITEM_MAX_RESOURCE_REFS} ResourceRefs`,
    );
    this.name = 'WorkItemCorrelationError';
  }
}

/**
 * Merge ResourceRefs into an ACTIVE WorkItem, de-duplicated by identity. Returns
 * a new value; when nothing new is added the item is returned unchanged.
 */
export function correlateWorkItem(
  item: WorkItem,
  refs: readonly ResourceRef[],
  updatedAt: IsoTimestamp,
): WorkItem {
  if (item.status !== WorkItemStatus.ACTIVE) throw new WorkItemCorrelationError('NOT_ACTIVE');
  const merged = uniqueResourceRefs([...item.resourceRefs, ...refs]);
  if (merged.length > WORK_ITEM_MAX_RESOURCE_REFS) {
    throw new WorkItemCorrelationError('TOO_MANY_REFS');
  }
  if (merged.length === item.resourceRefs.length) return item;
  return { ...item, resourceRefs: merged, updatedAt };
}
