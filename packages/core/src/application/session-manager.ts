import { newId } from '../util/id';
import { now } from '../util/clock';
import { SessionStatus } from '../domain';
import type { ConversationContext, Id, Session } from '../domain';
import type { StorageProvider } from '../ports';
import { saveSessionFields } from './session-live-save';

/**
 * Opens and maintains conversation Sessions (ADR-0001 — thin). Reuses the active
 * session for a channel/thread or creates one. It never stores snapshots or a
 * pinned provider.
 */
export class SessionManager {
  constructor(private readonly storage: StorageProvider) {}

  /** Reuse the active session for this context, or open a new one. */
  async openForContext(context: ConversationContext, actorId: Id): Promise<Session> {
    const active = await this.storage.sessions.findActiveByContext(
      context.channelId,
      context.threadId,
    );
    if (active) return active;

    const ts = now();
    const session: Session = {
      id: newId(),
      actorId,
      context,
      status: SessionStatus.ACTIVE,
      createdAt: ts,
      lastActivityAt: ts,
    };
    return this.storage.sessions.save(session);
  }

  /**
   * Record activity on a session (updates lastActivityAt) — field-scoped on the LIVE row (ADR-0113 D7): a turn's
   * snapshot taken before an operations-UI decision re-anchored the session (or a reset closed it) must never be
   * written back over that newer state. Returns the live session as touched.
   */
  async touch(session: Session): Promise<Session> {
    return saveSessionFields(this.storage.sessions, session, { lastActivityAt: now() });
  }

  /**
   * Close a session (ADR-0093 reset). Saved through the existing repository as `CLOSED`, so the next
   * `openForContext` for the same channel/thread opens a fresh session. Nothing else is touched: tasks,
   * approvals, artifacts and memory stay as they are.
   */
  async close(session: Session): Promise<Session> {
    // Whole-copy by contract (the caller's fields are kept). Race-safe all the same: the reset closes under the
    // approval and session locks (ADR-0113 D7), and a CLOSED session is never located, decided for or re-anchored.
    return this.storage.sessions.save({ ...session, status: SessionStatus.CLOSED, lastActivityAt: now() });
  }

  /** Bind a registered project to the session as its active project (ADR-0018). */
  async setActiveProject(session: Session, projectId: Id): Promise<Session> {
    return saveSessionFields(this.storage.sessions, session, { activeProjectId: projectId, lastActivityAt: now() });
  }
}
