import type { Id, IsoTimestamp, Metadata } from './common';
import type { MemoryType } from './enums';

/**
 * Scope narrows which memories apply to a given moment. A retrieval typically
 * filters by some subset (e.g. all PROJECT memory for projectId X, plus
 * SHORT_TERM memory for threadId Y).
 */
export interface MemoryScope {
  userId?: string;
  channelId?: string;
  threadId?: string;
  /** Conversation session this memory belongs to (ADR-0001). */
  sessionId?: Id;
  taskId?: Id;
  projectId?: Id;
}

/**
 * A single durable memory. Quoky Memory is the source of truth; the AI CLIs
 * are stateless executors that receive memory ONLY via generated context files.
 */
export interface MemoryRecord {
  id: Id;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  /** Optional vector id in the VectorProvider, for semantic recall. */
  vectorId?: Id;
  metadata?: Metadata;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * ADR-0106 amendment (archive with restore): a forgotten durable record is kept for a bounded time with these two
 * metadata keys in its existing JSON document (no migration). `archivedAt` marks it archived; `archiveExpiresAt` is
 * when the daily maintenance deletes it permanently. An archived record takes part in nothing — no listing, recall
 * (lexical or semantic), context building or learning — until it is restored (both keys removed).
 */
export const MEMORY_ARCHIVED_AT_KEY = 'archivedAt';
export const MEMORY_ARCHIVE_EXPIRES_AT_KEY = 'archiveExpiresAt';

/** Whether a record is archived (ADR-0106 amendment): it carries an `archivedAt` metadata value. */
export function isArchivedMemory(record: Pick<MemoryRecord, 'metadata'>): boolean {
  const value = record.metadata?.[MEMORY_ARCHIVED_AT_KEY];
  return value !== undefined && value !== null;
}

/**
 * A file that the MemoryManager materializes into the workspace so a stateless
 * CLI can "see" the relevant memory. Path is workspace-relative, e.g.
 * "CLAUDE.md", "AGENTS.md", ".chunsik/context.md", ".chunsik/task.md".
 *
 * NOTE: This is the ONLY mechanism by which memory reaches a CLI. The core
 * builds these; the AiProvider just passes them through to the workspace.
 */
export interface ContextFile {
  path: string;
  content: string;
}
