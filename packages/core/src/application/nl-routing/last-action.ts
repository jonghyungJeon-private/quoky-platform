import type { Id, IsoTimestamp, Session } from '../../domain';
import { isNlActionEntryId, type NlActionEntryId } from './catalog';

/**
 * ADR-0120 amendment A6-D2: `Session.metadata['quoky.lastAction']`, the content-free record of the last local write Quoky
 * executed for one (Session, Actor), so "방금 거 취소해줘", "그거 완료 처리해줘" and "되돌려줘" refer to it deterministically.
 *
 *   metadata['quoky.lastAction'] = { byActor: { [actorId]: LastActionRecord } }
 *
 * - Written by every executed LOCAL_WRITE: the A6 selections AND the anchored Class A commands (`할 일 추가:`, `알림 …`,
 *   `완료 처리: N`, `알림 N 취소`), only while `QUOKY_NL_ACTIONS` is not `off`.
 * - Holds ids, a label, a version stamp and timestamps only: never a title, body, name or snippet.
 * - Fresh for {@link LAST_ACTION_TTL_MS} (10 minutes: "방금 거", plain "되돌려줘"). It is kept for
 *   {@link LAST_ACTION_REPLY_TTL_MS} (30 minutes) so a platform reply to its echo can still name it (ratification record A).
 * - `echoReplyIds` are the platform ids of Quoky's confirmation (the ADR-0098 D3 delivery receipt), bound after delivery.
 * - After a local undo the record becomes an `action.undo` record (`undoOf` the undone entry) that is not undoable.
 *
 * Anything expired, malformed or written for another actor counts as absent. No migration: plain JSON in metadata.
 */

export const LAST_ACTION_METADATA_KEY = 'quoky.lastAction';
/** A6-D2: "방금 거" and a plain "되돌려줘" refer to the last action for 10 minutes. */
export const LAST_ACTION_TTL_MS = 10 * 60_000;
/** Ratification record A: a reply to the action's echo names it for 30 minutes. */
export const LAST_ACTION_REPLY_TTL_MS = 30 * 60_000;
const MAX_ACTORS = 64;
const MAX_ID_CHARS = 512;
const MAX_REPLY_IDS = 16;
const MAX_REPLY_ID_CHARS = 256;

export type LastActionSource = 'todo' | 'reminder';

export interface LastActionRecord {
  /** The executed entry (`todo.add`, …) or `action.undo` after an undo. */
  readonly entryId: NlActionEntryId;
  readonly source: LastActionSource;
  /** The local UUID of the item acted on (the restored or canceled item after an undo). */
  readonly itemId: Id;
  /** The label the echo showed (a to-do number or a reminder's `#N`). */
  readonly label?: number;
  /** The item's `updatedAt` right after the action: an inverse that needs "unchanged since" compares it. */
  readonly version?: string;
  readonly at: IsoTimestamp;
  /** Whether "되돌려줘" may undo it (an `action.undo` record never is). */
  readonly undoable: boolean;
  readonly undone: boolean;
  /** `action.undo` records: the entry that was undone. */
  readonly undoOf?: NlActionEntryId;
  /** The inbound message that caused it (to bind the echo's platform ids after delivery). */
  readonly requestId?: string;
  readonly echoReplyIds: readonly string[];
}

export interface LastActionView {
  readonly record: LastActionRecord;
  /** Within the 10-minute window. */
  readonly fresh: boolean;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function ageOf(at: string, now: IsoTimestamp): number {
  return Date.parse(now) - Date.parse(at);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** One stored record, or `undefined` when malformed. */
export function lastActionOf(raw: unknown): LastActionRecord | undefined {
  const record = recordOf(raw);
  if (!isNlActionEntryId(record.entryId)) return undefined;
  if (record.source !== 'todo' && record.source !== 'reminder') return undefined;
  const itemId = boundedString(record.itemId, MAX_ID_CHARS);
  if (itemId === undefined) return undefined;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return undefined;
  const label = Number.isSafeInteger(record.label) && (record.label as number) >= 1 ? (record.label as number) : undefined;
  const version = boundedString(record.version, 64);
  const requestId = boundedString(record.requestId, MAX_REPLY_ID_CHARS);
  const undoOf = isNlActionEntryId(record.undoOf) ? record.undoOf : undefined;
  const echo = Array.isArray(record.echoReplyIds)
    ? record.echoReplyIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_REPLY_ID_CHARS).slice(0, MAX_REPLY_IDS)
    : [];
  return {
    entryId: record.entryId,
    source: record.source,
    itemId,
    ...(label !== undefined ? { label } : {}),
    ...(version !== undefined ? { version } : {}),
    at: record.at as IsoTimestamp,
    undoable: record.undoable === true && record.entryId !== 'action.undo',
    undone: record.undone === true,
    ...(undoOf !== undefined ? { undoOf } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    echoReplyIds: echo,
  };
}

/** The last action of this actor in this session within 30 minutes (`fresh` within 10), else `undefined`. */
export function readLastAction(value: unknown, actorId: Id, now: IsoTimestamp): LastActionView | undefined {
  const record = lastActionOf(recordOf(recordOf(value).byActor)[actorId]);
  if (record === undefined) return undefined;
  const age = ageOf(record.at, now);
  if (!Number.isFinite(age) || age < 0 || age >= LAST_ACTION_REPLY_TTL_MS) return undefined;
  return { record, fresh: age < LAST_ACTION_TTL_MS };
}

/** {@link readLastAction} over a session snapshot. */
export function readSessionLastAction(session: Pick<Session, 'metadata'>, actorId: Id, now: IsoTimestamp): LastActionView | undefined {
  return readLastAction(session.metadata?.[LAST_ACTION_METADATA_KEY], actorId, now);
}

function serialize(record: LastActionRecord): Record<string, unknown> {
  return {
    entryId: record.entryId,
    source: record.source,
    itemId: record.itemId,
    ...(record.label !== undefined ? { label: record.label } : {}),
    ...(record.version !== undefined ? { version: record.version } : {}),
    at: record.at,
    undoable: record.undoable,
    undone: record.undone,
    ...(record.undoOf !== undefined ? { undoOf: record.undoOf } : {}),
    ...(record.requestId !== undefined ? { requestId: record.requestId } : {}),
    echoReplyIds: [...record.echoReplyIds],
  };
}

/** Every other actor's still-valid record, `actorId`'s replaced by `next` (`undefined` removes it); actors bounded. */
function rewrite(current: unknown, actorId: Id, now: IsoTimestamp, next: LastActionRecord | undefined): unknown {
  const byActor: Record<string, unknown> = {};
  for (const [other, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
    if (other === actorId) continue;
    const record = lastActionOf(raw);
    if (record === undefined) continue;
    const age = ageOf(record.at, now);
    if (Number.isFinite(age) && age >= 0 && age < LAST_ACTION_REPLY_TTL_MS) byActor[other] = serialize(record);
  }
  if (next !== undefined) byActor[actorId] = serialize(next);
  const keys = Object.keys(byActor);
  while (keys.length > MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined && victim !== actorId) delete byActor[victim];
  }
  return Object.keys(byActor).length === 0 ? undefined : { byActor };
}

/** Pure: the next value with `actorId`'s last action set to `record`. */
export function withLastAction(current: unknown, actorId: Id, record: LastActionRecord, now: IsoTimestamp): unknown {
  return rewrite(current, actorId, now, record);
}

/**
 * Pure: bind the delivered echo's platform ids to the action `requestId` caused, only while it is still this actor's last
 * action. `found` is false when it is not (nothing changes then).
 */
export function withLastActionEcho(
  current: unknown,
  actorId: Id,
  requestId: string,
  replyIds: readonly string[],
  now: IsoTimestamp,
): { readonly next: unknown; readonly found: boolean } {
  const view = readLastAction(current, actorId, now);
  if (view === undefined || view.record.requestId !== requestId) return { next: current, found: false };
  const ids = [...new Set(replyIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_REPLY_ID_CHARS))].slice(0, MAX_REPLY_IDS);
  if (ids.length === 0) return { next: current, found: false };
  return { next: rewrite(current, actorId, now, { ...view.record, echoReplyIds: ids }), found: true };
}
