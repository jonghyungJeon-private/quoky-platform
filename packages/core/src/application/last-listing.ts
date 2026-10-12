import type { Id, IsoTimestamp, Session } from '../domain';
import type { SessionManager } from './session-manager';

/**
 * The last mail / Drive listing of one (Session, Actor), persisted so "N번 메일 요약해줘" survives a restart (GML-1 /
 * DRV-1 residual). No migration: it lives in the existing `Session.metadata` JSON beside the model selection:
 *
 *   metadata['quoky.lastListing'] = { byActor: { [actorId]: { mail?: Entry, drive?: Entry } } }
 *   Entry = { source: 'mail' | 'drive', ids: string[] (displayed ids only, list order), at: ISO timestamp }
 *
 * Only the opaque provider ids of the DISPLAYED entries are stored; never a subject, sender, name or snippet. Each
 * source has its own slot and an entry whose `source` differs from the slot is ignored, so `N번 메일` never resolves a
 * Drive id (and the reverse). The TTL is checked on read. Plain data only.
 */
export const LAST_LISTING_METADATA_KEY = 'quoky.lastListing';
/** A summary may refer to a list shown at most this long ago. */
export const LAST_LISTING_TTL_MS = 30 * 60_000;
/** At most this many Actors keep a persisted listing in one Session (the oldest is dropped first). */
export const LAST_LISTING_MAX_ACTORS = 64;
const MAX_IDS = 50;
const MAX_ID_CHARS = 512;

export type ListingSource = 'mail' | 'drive';

export interface PersistedListing {
  readonly at: IsoTimestamp;
  readonly ids: readonly string[];
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function entryOf(raw: unknown, source: ListingSource): PersistedListing | undefined {
  const entry = recordOf(raw);
  if (entry.source !== source || typeof entry.at !== 'string' || !Array.isArray(entry.ids)) return undefined;
  if (entry.ids.length > MAX_IDS || !entry.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_CHARS)) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(entry.at))) return undefined;
  return { at: entry.at as IsoTimestamp, ids: [...(entry.ids as string[])] };
}

function fresh(at: IsoTimestamp, now: IsoTimestamp): boolean {
  const age = Date.parse(now) - Date.parse(at);
  return Number.isFinite(age) && age >= 0 && age < LAST_LISTING_TTL_MS;
}

/** The persisted listing of this source for this Actor within the TTL, from the session snapshot; else `undefined`. */
export function readPersistedListing(
  session: Pick<Session, 'metadata'>,
  actorId: Id,
  source: ListingSource,
  now: IsoTimestamp,
): PersistedListing | undefined {
  const byActor = recordOf(recordOf(session.metadata?.[LAST_LISTING_METADATA_KEY]).byActor);
  const listing = entryOf(recordOf(byActor[actorId])[source], source);
  return listing !== undefined && fresh(listing.at, now) ? listing : undefined;
}

/** Persist the displayed ids, field-scoped under the session write lock. Resolves `false` when nothing was written. */
export async function persistListing(
  sessions: Pick<SessionManager, 'updateMetadataEntry'>,
  sessionId: Id,
  actorId: Id,
  source: ListingSource,
  ids: readonly string[],
  now: IsoTimestamp,
): Promise<boolean> {
  const saved = await sessions.updateMetadataEntry({ id: sessionId }, LAST_LISTING_METADATA_KEY, (current) => {
    const byActor: Record<string, unknown> = {};
    // Keep every other Actor's still-fresh entries (oldest first), drop the expired and malformed ones.
    for (const [otherActor, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
      if (otherActor === actorId) continue;
      const slots: Record<string, unknown> = {};
      for (const slot of ['mail', 'drive'] as const) {
        const entry = entryOf(recordOf(raw)[slot], slot);
        if (entry !== undefined && fresh(entry.at, now)) slots[slot] = { source: slot, ids: entry.ids, at: entry.at };
      }
      if (Object.keys(slots).length > 0) byActor[otherActor] = slots;
    }
    const own: Record<string, unknown> = {};
    for (const slot of ['mail', 'drive'] as const) {
      if (slot === source) continue;
      const entry = entryOf(recordOf(recordOf(recordOf(current).byActor)[actorId])[slot], slot);
      if (entry !== undefined && fresh(entry.at, now)) own[slot] = { source: slot, ids: entry.ids, at: entry.at };
    }
    if (ids.length > 0) own[source] = { source, ids: ids.slice(0, MAX_IDS), at: now };
    if (Object.keys(own).length > 0) byActor[actorId] = own;
    const keys = Object.keys(byActor);
    while (keys.length > LAST_LISTING_MAX_ACTORS) {
      const victim = keys.shift();
      if (victim !== undefined && victim !== actorId) delete byActor[victim];
      else if (victim !== undefined) keys.push(victim);
    }
    return Object.keys(byActor).length === 0 ? undefined : { byActor };
  });
  return saved !== null;
}
