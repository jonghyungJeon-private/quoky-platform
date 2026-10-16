import type { Id, IsoTimestamp } from '../../domain';
import { isNlR2ItemSource, type NlR2ItemSource } from './catalog';

/**
 * ADR-0120 amendment A6 R2, owner decision D9 (A6-D2 amendment C6): `Session.metadata['quoky.lastRead']`, a third
 * content-free reference record beside the listing slots and `quoky.lastAction`. A successful `item.summarize` over a
 * Jira issue or a Slack message (a summary, a full readout or its deterministic fallback) writes the item it read, so
 * "그거 원문 보여줘" or "방금 본 거" after "2번 이슈 요약해줘" mean that item.
 *
 *   metadata['quoky.lastRead'] = { byActor: { [actorId]: { source, id, label?, at } } }
 *
 * - Holds the source, the opaque item reference, the shown label and a timestamp: never a title, text, channel or author.
 * - Fresh for {@link LAST_READ_TTL_MS} (10 minutes); anything older, malformed or another actor's counts as absent.
 * - Read by `item.summarize` only (`item-reference.ts`): it is never a referent for a LOCAL_WRITE, an R5a deictic draft or
 *   `action.undo`.
 */

export const LAST_READ_METADATA_KEY = 'quoky.lastRead';
export const LAST_READ_TTL_MS = 10 * 60_000;
const MAX_ACTORS = 64;
const MAX_ID_CHARS = 512;

export interface LastReadRecord {
  readonly source: NlR2ItemSource;
  readonly id: string;
  readonly label?: number;
  /** When the listing that showed the item was written (the "목록 이후 수정됨" check). */
  readonly listingAt?: IsoTimestamp;
  readonly at: IsoTimestamp;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One stored record, or `undefined` when malformed. */
export function lastReadOf(raw: unknown): LastReadRecord | undefined {
  const record = recordOf(raw);
  if (!isNlR2ItemSource(record.source)) return undefined;
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > MAX_ID_CHARS) return undefined;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return undefined;
  const label = Number.isSafeInteger(record.label) && (record.label as number) >= 1 ? (record.label as number) : undefined;
  const listingAt = typeof record.listingAt === 'string' && Number.isFinite(Date.parse(record.listingAt)) ? (record.listingAt as IsoTimestamp) : undefined;
  return { source: record.source, id: record.id, ...(label !== undefined ? { label } : {}), ...(listingAt !== undefined ? { listingAt } : {}), at: record.at as IsoTimestamp };
}

/** This actor's fresh record (within {@link LAST_READ_TTL_MS}), else `undefined`. Pure. */
export function readLastRead(value: unknown, actorId: Id, now: IsoTimestamp): LastReadRecord | undefined {
  const record = lastReadOf(recordOf(recordOf(value).byActor)[actorId]);
  if (record === undefined) return undefined;
  const age = Date.parse(now) - Date.parse(record.at);
  return Number.isFinite(age) && age >= 0 && age < LAST_READ_TTL_MS ? record : undefined;
}

/** Pure: the next metadata value after `actorId` read `record` (other actors kept when fresh, at most 64). */
export function withLastRead(current: unknown, actorId: Id, record: LastReadRecord, now: IsoTimestamp): unknown {
  const byActor: Record<string, unknown> = {};
  for (const [other, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
    if (other === actorId) continue;
    if (readLastRead({ byActor: { [other]: raw } }, other, now) !== undefined) byActor[other] = raw;
  }
  const keys = Object.keys(byActor);
  while (keys.length >= MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined) delete byActor[victim];
  }
  byActor[actorId] = {
    source: record.source,
    id: record.id,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.listingAt !== undefined ? { listingAt: record.listingAt } : {}),
    at: record.at,
  };
  return { byActor };
}
