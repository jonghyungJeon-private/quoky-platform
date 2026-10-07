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

  /**
   * Update ONE `metadata` key of the LIVE session row, field-scoped under the shared session write lock (ADR-0113 D7):
   * the live row is re-read inside the lock, `update` receives that key's live value and returns the next one
   * (`undefined` removes the key), and only that key changes — concurrent writers of other fields or other metadata keys
   * never lose an update. A session that is gone or no longer ACTIVE is left untouched (`null`). Plain data only, never
   * a snapshot of context or memory.
   */
  async updateMetadataEntry(
    session: Pick<Session, 'id'>,
    key: string,
    update: (current: unknown) => unknown,
    held?: SessionLockHold,
  ): Promise<Session | null> {
    return this.sessionLock.run(
      session.id,
      async () => {
        const live = await this.storage.sessions.get(session.id);
        if (live === null || live.status !== SessionStatus.ACTIVE) return null;
        const metadata: Record<string, unknown> = { ...(live.metadata ?? {}) };
        const next = update(metadata[key]);
        if (next === undefined) delete metadata[key];
        else metadata[key] = next;
        const { metadata: _previous, ...rest } = live;
        return this.storage.sessions.save(Object.keys(metadata).length > 0 ? { ...rest, metadata } : rest);
      },
      held,
    );
  }

  /** Bind a registered project to the session as its active project (ADR-0018). */
  async setActiveProject(session: Session, projectId: Id, held?: SessionLockHold): Promise<Session> {
    return this.sessionLock.saveFields(this.storage.sessions, session, { activeProjectId: projectId, lastActivityAt: now() }, held);
  }
}
