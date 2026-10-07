import type { Id, Session } from '../domain';

/** The session store slice a field-scoped save needs; `get` re-reads the live row (absent → the caller's copy). */
export interface LiveSessionStore {
  save(session: Session): Promise<Session>;
  get?(id: Id): Promise<Session | null>;
}

/**
 * Save ONLY `fields` onto the LIVE session (ADR-0113 D7, the credential-override flow's `releasePointer` pattern): the
 * row is re-read and the caller's possibly stale Session object is never written back whole, so a transition that
 * landed meanwhile — the operations UI re-anchoring an approved gate, a reset close, a project switch — is kept.
 * A store without `get` (test seams) falls back to the caller's copy.
 */
export async function saveSessionFields(store: LiveSessionStore, session: Session, fields: Partial<Session>): Promise<Session> {
  const live = (store.get ? await store.get(session.id) : null) ?? session;
  return store.save({ ...live, ...fields });
}

/**
 * Release the session pointer iff the LIVE session still points at `taskId` (the anchor the caller found); a pointer
 * another transition has moved on (e.g. the UI re-anchored the gate on a fresh anchor Task) is left alone.
 * Returns whether it released it.
 */
export async function releaseSessionPointer(
  store: LiveSessionStore,
  session: Session,
  taskId: Id,
  fields: Partial<Session> = {},
): Promise<boolean> {
  const live = (store.get ? await store.get(session.id) : null) ?? session;
  if (live.activeTaskId !== taskId) return false;
  await store.save({ ...live, ...fields, activeTaskId: undefined });
  return true;
}
