import type { Id, IsoTimestamp, Metadata } from './common';
import type { ConversationContext } from './messaging';
import type { SessionStatus } from './enums';

/**
 * Conversation aggregate root (ADR-0001 — deliberately THIN). It owns identity,
 * lifecycle, and scope, and REFERENCES tasks; it never stores context/memory
 * snapshots and never pins an AI provider.
 */
export interface Session {
  id: Id;
  /** The acting principal (ADR-0009). */
  actorId: Id;
  /** Where the conversation lives (generic, never a platform SDK type). */
  context: ConversationContext;
  status: SessionStatus;
  projectId?: Id;
  /** The local project registered as active for this session (ADR-0018). */
  activeProjectId?: Id;
  /** The task currently in focus, if any (referenced, not owned). */
  activeTaskId?: Id;
  createdAt: IsoTimestamp;
  lastActivityAt: IsoTimestamp;
  metadata?: Metadata;
}
