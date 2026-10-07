import { newId } from '../util/id';
import { now } from '../util/clock';
import { SessionStatus } from '../domain';
import type { ConversationContext, Id, Session } from '../domain';
import type { StorageProvider } from '../ports';
import { SESSION_WRITE_LOCK, type SessionLockHold, type SessionWriteLock } from './session-write-lock';

/**
 * Opens and maintains conversation Sessions (ADR-0001 — thin). Reuses the active
 * session for a channel/thread or creates one. It never stores snapshots or a
 * pinned provider.
 */
export class SessionManager {
  /** Every write of an existing session row runs under the shared session write lock (ADR-0113 D7). */
  constructor(
    private readonly storage: StorageProvider,
    private readonly sessionLock: SessionWriteLock = SESSION_WRITE_LOCK,
  ) {}

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
   * written back over that newer state. Runs under the shared session write lock. Returns the live session as touched.
   */
  async touch(session: Session, held?: SessionLockHold): Promise<Session> {
    return this.sessionLock.saveFields(this.storage.sessions, session, { lastActivityAt: now() }, held);
  }

  /**
   * Close a session (ADR-0093 reset). Saved through the existing repository as `CLOSED`, so the next
   * `openForContext` for the same channel/thread opens a fresh session. Nothing else is touched: tasks,
   * approvals, artifacts and memory stay as they are.
   */
  async close(session: Session, held?: SessionLockHold): Promise<Session> {
    // Whole-copy by contract (the caller's fields are kept), under the shared session write lock (ADR-0113 D7); the
    // reset passes the hold it already has. A CLOSED session is never located, decided for or re-anchored.
    return this.sessionLock.run(
      session.id,
      () => this.storage.sessions.save({ ...session, status: SessionStatus.CLOSED, lastActivityAt: now() }),
      held,
    );
  }

  /** Bind a registered project to the session as its active project (ADR-0018). */
  async setActiveProject(session: Session, projectId: Id, held?: SessionLockHold): Promise<Session> {
    return this.sessionLock.saveFields(this.storage.sessions, session, { activeProjectId: projectId, lastActivityAt: now() }, held);
  }
}
