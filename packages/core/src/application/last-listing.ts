import type { Id, IsoTimestamp, Session } from '../domain';
import type { SessionManager } from './session-manager';

/**
 * The last mail / Drive listing of one (Session, Actor), persisted so "N번 메일 요약해줘" survives a restart (GML-1 /
 * DRV-1 residual). No migration: it lives in the existing `Session.metadata` JSON beside the model selection:
 *
 *   metadata['quoky.lastListing'] = { byActor: { [actorId]: { mail?: Entry, drive?: Entry, replied?: Replied[] } } }
 *   Entry   = { source: 'mail' | 'drive', ids: string[] (displayed ids only, list order), at: ISO timestamp,
 *               requestId?: string, replyIds?: string[] }
 *   Replied = { source, ids, at, replyIds }   (an earlier listing the owner may still reply to; `ids` is [] once expired)
 *
 * Only the opaque provider ids of the DISPLAYED entries are stored; never a subject, sender, name or snippet. Each
 * source has its own slot and an entry whose `source` differs from the slot is ignored, so `N번 메일` never resolves a
 * Drive id (and the reverse). The TTL is checked on read. Plain data only.
 *
 * GML-2 (ADR-0118 amendment of 2026-10-12, reply-to-pick): a listing also records the inbound message id that asked for
 * it (`requestId`) and, once delivered, the platform ids of its reply (`replyIds`, the ADR-0098 D3 delivery receipt).
 * A platform reply whose opaque `replyTo.messageId` equals one of those ids picks from THAT listing. Core only compares
 * the ids; it never parses them. A newer listing moves the replied-to one into `replied` (at most
 * {@link LISTING_REPLIED_MAX} per Actor), where its ids stay for {@link LISTING_REPLY_TTL_MS} — a reply names its
 * listing, so it is not ambiguous after the 30-minute "last list" window — and then only the reply ids remain until
 * {@link LISTING_REPLY_TOMBSTONE_MS}, so a late reply is told the list expired instead of picking from another list.
 */
export const LAST_LISTING_METADATA_KEY = 'quoky.lastListing';
/** A summary may refer to a list shown at most this long ago. */
export const LAST_LISTING_TTL_MS = 30 * 60_000;
/** At most this many Actors keep a persisted listing in one Session (the oldest is dropped first). */
export const LAST_LISTING_MAX_ACTORS = 64;
/** GML-2: a platform reply to a listing picks from it for this long after the listing was shown. */
export const LISTING_REPLY_TTL_MS = 24 * 60 * 60_000;
/** GML-2: after that, the reply ids alone are kept this long so a late reply is answered "expired". */
export const LISTING_REPLY_TOMBSTONE_MS = 7 * 24 * 60 * 60_000;
/** GML-2: at most this many earlier, replied-to listings are kept per Actor (the oldest is dropped first). */
export const LISTING_REPLIED_MAX = 8;
const MAX_IDS = 50;
const MAX_ID_CHARS = 512;
/** A long reply may be several platform messages (chunks); each is one id. */
const MAX_REPLY_IDS = 16;
const MAX_REPLY_ID_CHARS = 256;
const SLOTS = ['mail', 'drive'] as const;

export type ListingSource = 'mail' | 'drive';

export interface PersistedListing {
  readonly at: IsoTimestamp;
  readonly ids: readonly string[];
}

/** GML-2: what a platform reply points at. */
export type ListingReplyMatch =
  /** A listing within {@link LISTING_REPLY_TTL_MS}: pick from these ids. */
  | { readonly kind: 'listing'; readonly listing: PersistedListing }
  /** A listing Quoky showed, but too long ago (or with its ids already dropped): nothing is picked. */
  | { readonly kind: 'expired' };

interface Entry {
  readonly source: ListingSource;
  readonly ids: readonly string[];
  readonly at: IsoTimestamp;
  readonly requestId?: string;
  readonly replyIds?: readonly string[];
}

interface ActorState {
  readonly slots: Partial<Record<ListingSource, Entry>>;
  readonly replied: readonly Entry[];
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedIds(value: unknown, max: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  return value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= maxChars) ? [...(value as string[])] : undefined;
}

/** One stored entry, or `undefined` when malformed. `allowEmptyIds` admits an expired replied entry (a tombstone). */
function entryOf(raw: unknown, source: ListingSource | undefined, allowEmptyIds = false): Entry | undefined {
  const entry = recordOf(raw);
  const actual = entry.source;
  if (actual !== 'mail' && actual !== 'drive') return undefined;
  if (source !== undefined && actual !== source) return undefined;
  if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) return undefined;
  const ids = boundedIds(entry.ids, MAX_IDS, MAX_ID_CHARS);
  if (ids === undefined || (ids.length === 0 && !allowEmptyIds)) return undefined;
  // The GML-2 fields are optional; a malformed one is dropped, never trusted.
  const requestId = typeof entry.requestId === 'string' && entry.requestId.length > 0 && entry.requestId.length <= MAX_REPLY_ID_CHARS ? entry.requestId : undefined;
  const replyIds = entry.replyIds === undefined ? undefined : boundedIds(entry.replyIds, MAX_REPLY_IDS, MAX_REPLY_ID_CHARS);
  return {
    source: actual,
    ids,
    at: entry.at as IsoTimestamp,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(replyIds !== undefined && replyIds.length > 0 ? { replyIds } : {}),
  };
}

function ageOf(at: IsoTimestamp, now: IsoTimestamp): number {
  return Date.parse(now) - Date.parse(at);
}

function fresh(at: IsoTimestamp, now: IsoTimestamp): boolean {
  const age = ageOf(at, now);
  return Number.isFinite(age) && age >= 0 && age < LAST_LISTING_TTL_MS;
}

/** A replied-to entry as it should be kept at `now`: ids within the reply TTL, a tombstone after it, dropped later. */
function agedReplied(entry: Entry, now: IsoTimestamp): Entry | undefined {
  if (entry.replyIds === undefined) return undefined;
  const age = ageOf(entry.at, now);
  if (!Number.isFinite(age) || age < 0 || age >= LISTING_REPLY_TOMBSTONE_MS) return undefined;
  return age < LISTING_REPLY_TTL_MS ? entry : { ...entry, ids: [] };
}

/** One Actor's state at `now`: fresh slots; an expired slot that was replied to moves into `replied`. */
function actorStateOf(raw: unknown, now: IsoTimestamp): ActorState {
  const record = recordOf(raw);
  const slots: Partial<Record<ListingSource, Entry>> = {};
  const replied: Entry[] = [];
  const earlier = Array.isArray(record.replied) ? record.replied.slice(-LISTING_REPLIED_MAX * 2) : [];
  for (const item of earlier) {
    const entry = entryOf(item, undefined, true);
    const kept = entry !== undefined ? agedReplied(entry, now) : undefined;
    if (kept !== undefined) replied.push(kept);
  }
  for (const slot of SLOTS) {
    const entry = entryOf(record[slot], slot);
    if (entry === undefined) continue;
    if (fresh(entry.at, now)) slots[slot] = entry;
    else {
      const kept = agedReplied(entry, now);
      if (kept !== undefined) replied.push(kept);
    }
  }
  return { slots, replied: newestReplied(replied) };
}

function newestReplied(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-LISTING_REPLIED_MAX);
}

function serializeEntry(entry: Entry): Record<string, unknown> {
  return {
    source: entry.source,
    ids: [...entry.ids],
    at: entry.at,
    ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
    ...(entry.replyIds !== undefined ? { replyIds: [...entry.replyIds] } : {}),
  };
}

function serializeActor(state: ActorState): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const slot of SLOTS) {
    const entry = state.slots[slot];
    if (entry !== undefined) out[slot] = serializeEntry(entry);
  }
  if (state.replied.length > 0) out.replied = state.replied.map(serializeEntry);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Every Actor's cleaned state, `actorId`'s rewritten by `change`, the Actor count bounded (oldest dropped first, never
 * `actorId`). The result is the next metadata value (`undefined` removes the key).
 */
function rewrite(current: unknown, actorId: Id, now: IsoTimestamp, change: (own: ActorState) => ActorState): unknown {
  const byActor: Record<string, unknown> = {};
  let ownRaw: unknown;
  for (const [otherActor, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
    if (otherActor === actorId) {
      ownRaw = raw;
      continue;
    }
    const serialized = serializeActor(actorStateOf(raw, now));
    if (serialized !== undefined) byActor[otherActor] = serialized;
  }
  const own = serializeActor(change(actorStateOf(ownRaw, now)));
  if (own !== undefined) byActor[actorId] = own;
  const keys = Object.keys(byActor);
  while (keys.length > LAST_LISTING_MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined && victim !== actorId) delete byActor[victim];
    else if (victim !== undefined) keys.push(victim);
  }
  return Object.keys(byActor).length === 0 ? undefined : { byActor };
}

/**
 * Pure: the next listing-state value after `actorId` was shown `ids` from `source` (GML-1), recording the inbound
 * message that asked for it (`requestId`, GML-2). The listing it replaces moves into `replied` when it was delivered
 * with a receipt. Used for the persisted record and for a handler's in-memory copy alike.
 */
export function withListing(
  current: unknown,
  actorId: Id,
  source: ListingSource,
  ids: readonly string[],
  now: IsoTimestamp,
  requestId?: string,
): unknown {
  return rewrite(current, actorId, now, (own) => {
    const slots = { ...own.slots };
    const replied = [...own.replied];
    const previous = slots[source];
    if (previous?.replyIds !== undefined) replied.push(previous);
    delete slots[source];
    if (ids.length > 0) {
      const request = requestId !== undefined && requestId.length > 0 && requestId.length <= MAX_REPLY_ID_CHARS ? requestId : undefined;
      slots[source] = { source, ids: ids.slice(0, MAX_IDS), at: now, ...(request !== undefined ? { requestId: request } : {}) };
    }
    return { slots, replied: newestReplied(replied) };
  });
}

/**
 * Pure (GML-2): record the platform ids of the delivered reply of the listing that `requestId` asked for. `found` is
 * false when that listing is no longer the Actor's current one of this source (nothing changes then).
 */
export function withListingReplies(
  current: unknown,
  actorId: Id,
  source: ListingSource,
  requestId: string,
  replyIds: readonly string[],
  now: IsoTimestamp,
): { readonly next: unknown; readonly found: boolean } {
  const ids = [...new Set(replyIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_REPLY_ID_CHARS))].slice(0, MAX_REPLY_IDS);
  let found = false;
  const next = rewrite(current, actorId, now, (own) => {
    const entry = own.slots[source];
    if (entry === undefined || entry.requestId !== requestId || ids.length === 0) return own;
    found = true;
    return { ...own, slots: { ...own.slots, [source]: { ...entry, replyIds: ids } } };
  });
  return { next: found ? next : current, found };
}

/** The current listing of this source for this Actor within the TTL, from a listing-state value; else `undefined`. */
export function readListing(value: unknown, actorId: Id, source: ListingSource, now: IsoTimestamp): PersistedListing | undefined {
  const listing = entryOf(recordOf(recordOf(recordOf(value).byActor)[actorId])[source], source);
  return listing !== undefined && fresh(listing.at, now) ? { at: listing.at, ids: [...listing.ids] } : undefined;
}

/**
 * GML-2: the listing of this source whose delivered reply had the platform id `replyMessageId`, from a listing-state
 * value: `listing` within {@link LISTING_REPLY_TTL_MS}, `expired` after it, `undefined` when no recorded listing reply
 * has that id (the reply then picks nothing and the turn behaves as before).
 */
export function findListingByReply(
  value: unknown,
  actorId: Id,
  source: ListingSource,
  replyMessageId: string,
  now: IsoTimestamp,
): ListingReplyMatch | undefined {
  if (typeof replyMessageId !== 'string' || replyMessageId.length === 0) return undefined;
  const record = recordOf(recordOf(recordOf(value).byActor)[actorId]);
  const candidates: Entry[] = [];
  const slot = entryOf(record[source], source);
  if (slot !== undefined) candidates.push(slot);
  for (const item of Array.isArray(record.replied) ? record.replied.slice(-LISTING_REPLIED_MAX * 2) : []) {
    const entry = entryOf(item, source, true);
    if (entry !== undefined) candidates.push(entry);
  }
  // The newest listing whose reply had this id (an id is never reused by a platform, but a malformed record could repeat it).
  const hit = candidates
    .filter((entry) => entry.replyIds?.includes(replyMessageId) === true)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (hit === undefined) return undefined;
  const age = ageOf(hit.at, now);
  if (!Number.isFinite(age) || age < 0 || age >= LISTING_REPLY_TOMBSTONE_MS) return undefined;
  if (age >= LISTING_REPLY_TTL_MS || hit.ids.length === 0) return { kind: 'expired' };
  return { kind: 'listing', listing: { at: hit.at, ids: [...hit.ids] } };
}

/** The persisted listing of this source for this Actor within the TTL, from the session snapshot; else `undefined`. */
export function readPersistedListing(
  session: Pick<Session, 'metadata'>,
  actorId: Id,
  source: ListingSource,
  now: IsoTimestamp,
): PersistedListing | undefined {
  return readListing(session.metadata?.[LAST_LISTING_METADATA_KEY], actorId, source, now);
}

/** GML-2: {@link findListingByReply} over the session snapshot's persisted record. */
export function findPersistedListingByReply(
  session: Pick<Session, 'metadata'>,
  actorId: Id,
  source: ListingSource,
  replyMessageId: string,
  now: IsoTimestamp,
): ListingReplyMatch | undefined {
  return findListingByReply(session.metadata?.[LAST_LISTING_METADATA_KEY], actorId, source, replyMessageId, now);
}

/** Persist the displayed ids, field-scoped under the session write lock. Resolves `false` when nothing was written. */
export async function persistListing(
  sessions: Pick<SessionManager, 'updateMetadataEntry'>,
  sessionId: Id,
  actorId: Id,
  source: ListingSource,
  ids: readonly string[],
  now: IsoTimestamp,
  requestId?: string,
): Promise<boolean> {
  const saved = await sessions.updateMetadataEntry({ id: sessionId }, LAST_LISTING_METADATA_KEY, (current) =>
    withListing(current, actorId, source, ids, now, requestId),
  );
  return saved !== null;
}

/**
 * GML-2: persist the delivered reply ids of the listing `requestId` asked for, under the session write lock. Resolves
 * `true` only when that listing was found and updated.
 */
export async function persistListingReplies(
  sessions: Pick<SessionManager, 'updateMetadataEntry'>,
  sessionId: Id,
  actorId: Id,
  source: ListingSource,
  requestId: string,
  replyIds: readonly string[],
  now: IsoTimestamp,
): Promise<boolean> {
  let found = false;
  const saved = await sessions.updateMetadataEntry({ id: sessionId }, LAST_LISTING_METADATA_KEY, (current) => {
    const result = withListingReplies(current, actorId, source, requestId, replyIds, now);
    found = result.found;
    return result.next;
  });
  return saved !== null && found;
}
