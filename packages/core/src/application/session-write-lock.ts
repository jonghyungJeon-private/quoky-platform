import type { Id, Session } from '../domain';
import { KeyedMutex, type LockHold } from '../util/keyed-mutex';

/**
 * ADR-0113 D7: the ONE per-session write lock. Every write of a `Session` row — the activity touch, a project
 * switch, the reset close, every flow's pointer anchor/release (approval, scope clarification, apply preview,
 * connector write, credential override) and the operations-UI decision's re-anchor — runs under this lock, keyed by
 * the session id, and inside it re-reads the LIVE row and applies only its own fields. So no writer can save a stale
 * snapshot over a newer one (the touch / project re-registration that restored a PENDING pointer over a UI
 * approval's re-anchor), and concurrent field saves never lose each other's updates.
 *
 * Lock order (deadlock freedom), outermost first — every path acquires in this order and never the reverse:
 *   1. the approval lock   (`ApprovalDecisionService`, keyed by approval id)
 *   2. the session lock    (this, keyed by session id; at most ONE session held at a time)
 *   3. a flow's own anchor queue (e.g. the credential-override flow's per-anchor serialization)
 * A flow method that both takes its anchor queue and writes the session takes the session lock FIRST.
 *
 * Re-entrancy is explicit: a caller already holding the session lock passes its {@link SessionLockHold} to the
 * flow / SessionManager method it calls (their optional trailing `held` parameter); that call then runs inside the
 * caller's critical section. A call without the hold queues normally — so a holder must ALWAYS pass it on.
 *
 * One instance per process ({@link SESSION_WRITE_LOCK}, single instance — ADR-0102 D4); components default to it
 * and accept an override only for isolation in tests.
 */
export type SessionLockHold = LockHold;

/** The session store slice a field-scoped save needs; `get` re-reads the live row (absent → the caller's copy). */
export interface LiveSessionStore {
  save(session: Session): Promise<Session>;
  get?(id: Id): Promise<Session | null>;
}

export class SessionWriteLock {
  private readonly mutex = new KeyedMutex();

  /** Run `work` holding the session's write lock (re-entrant for `held`, see the class note). */
  run<T>(sessionId: Id, work: (hold: SessionLockHold) => Promise<T>, held?: SessionLockHold): Promise<T> {
    return this.mutex.run(sessionId, work, held);
  }

  /**
   * Under the lock: re-read the live row and save ONLY `fields` onto it — the caller's possibly stale Session object
   * is never written back whole. A store without `get` (test seams) falls back to the caller's copy.
   */
  saveFields(store: LiveSessionStore, session: Session, fields: Partial<Session>, held?: SessionLockHold): Promise<Session> {
    return this.run(
      session.id,
      async () => {
        const live = (store.get ? await store.get(session.id) : null) ?? session;
        return store.save({ ...live, ...fields });
      },
      held,
    );
  }

  /**
   * Under the lock: release the pointer iff the LIVE session still points at `taskId` (compare-and-clear); a pointer
   * another writer has moved on is left alone. `fields` are saved with the release. Returns whether it released.
   */
  releasePointer(
    store: LiveSessionStore,
    session: Session,
    taskId: Id,
    fields: Partial<Session> = {},
    held?: SessionLockHold,
  ): Promise<boolean> {
    return this.run(
      session.id,
      async () => {
        const live = (store.get ? await store.get(session.id) : null) ?? session;
        if (live.activeTaskId !== taskId) return false;
        await store.save({ ...live, ...fields, activeTaskId: undefined });
        return true;
      },
      held,
    );
  }
}

/** The process-wide session write lock every session writer shares by default. */
export const SESSION_WRITE_LOCK = new SessionWriteLock();
