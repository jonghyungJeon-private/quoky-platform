import type { Id, IsoTimestamp } from '../../domain';
import { sha256Canonical } from '../canonical-digest';
import { containsCredentialMaterial } from '../credential-guard';
import { nlOwnerTextIneligibility, type NlOwnerTextIneligibility } from './action-entries';

/**
 * ADR-0120 amendment A6 R5a (§1.2): `Session.metadata['quoky.lastTurn']`, the content-free record of the last delivered
 * turn of one (Session, Actor):
 *
 *   metadata['quoky.lastTurn'] = { byActor: { [actorId]: LastTurnRecord } }
 *
 * - Written after each turn of an owner DM, only while `QUOKY_NL_DEICTIC_WRITES` is not `off`, through the field-scoped
 *   `SessionManager.updateMetadataEntry` (under `SESSION_WRITE_LOCK`, ADR-0113 D7).
 * - Ids, closed values and a hash only: never the owner's text or Quoky's reply. Text is re-read from its own store.
 * - The owner message's eligibility is decided from the inbound message itself (§1.2); a turn recorded before the record
 *   existed, an expired record or a missing one is INELIGIBLE (no backfill).
 * - Kept {@link LAST_TURN_TTL_MS} (30 minutes); anything expired, malformed or another actor's counts as absent.
 */

export const LAST_TURN_METADATA_KEY = 'quoky.lastTurn';
export const LAST_TURN_TTL_MS = 30 * 60_000;
const MAX_ACTORS = 64;
const MAX_ID_CHARS = 512;
const MAX_REPLY_IDS = 16;

export type LastTurnReplyKind = 'chat' | 'listing' | 'echo' | 'note' | 'question' | 'refusal' | 'preview';
const REPLY_KINDS: readonly LastTurnReplyKind[] = ['chat', 'listing', 'echo', 'note', 'question', 'refusal', 'preview'];

/** Why the owner's message can never be a referent (closed; never a value). */
export type LastTurnIneligibility = NlOwnerTextIneligibility | 'attachment' | 'forward' | 'unrecorded';
const INELIGIBILITIES: readonly LastTurnIneligibility[] = ['multiline', 'quoted', 'fenced', 'attachment', 'forward', 'invisible', 'command', 'deictic', 'credential', 'unrecorded'];

export interface LastTurnOwner {
  /** The SHORT_TERM user record of the turn (absent when the turn recorded none). */
  readonly memoryId?: Id;
  readonly eligible: boolean;
  readonly reason?: LastTurnIneligibility;
  /** {@link ownerMessageHash} of the text as received (eligible messages only). Never logged. */
  readonly hash?: string;
}

export interface LastTurnReply {
  readonly kind: LastTurnReplyKind;
  /** A to-do or reminder listing (or an echo / question merged into one) the reply showed. */
  readonly listingSource?: 'todo' | 'reminder';
  /** The delivered platform ids of the reply (bound after delivery). */
  readonly replyIds: readonly string[];
}

export interface LastTurnRecord {
  readonly at: IsoTimestamp;
  /** The inbound message of the turn. */
  readonly requestId: string;
  readonly owner: LastTurnOwner;
  readonly reply: LastTurnReply;
}

export interface OwnerMessageFacts {
  readonly text: string;
  readonly attachmentCount: number;
  /** The platform marked part of the text as quoted. */
  readonly quoted: boolean;
  /** The platform marked part of the text as code. */
  readonly codeFormatted: boolean;
}

/** §1.2: whether the owner's message may later be a referent, decided from the inbound message (fail closed). */
export function nlOwnerMessageEligibility(facts: OwnerMessageFacts): { readonly eligible: true } | { readonly eligible: false; readonly reason: LastTurnIneligibility } {
  if (facts.attachmentCount > 0) return { eligible: false, reason: 'attachment' };
  if (facts.quoted) return { eligible: false, reason: 'quoted' };
  if (facts.codeFormatted) return { eligible: false, reason: 'fenced' };
  const reason = nlOwnerTextIneligibility(facts.text, containsCredentialMaterial);
  return reason === undefined ? { eligible: true } : { eligible: false, reason };
}

/** The hash an owner message is bound by: the actor, the session, the memory record and the text as recorded. */
export function ownerMessageHash(actorId: Id, sessionId: Id, memoryId: Id, text: string): string {
  return sha256Canonical('quoky.lastTurn.owner.v1', [actorId, sessionId, memoryId, text]);
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function ageOf(at: string, now: IsoTimestamp): number {
  return Date.parse(now) - Date.parse(at);
}

function replyIdsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256))].slice(0, MAX_REPLY_IDS)
    : [];
}

/** One stored record, or `undefined` when malformed. */
export function lastTurnOf(raw: unknown): LastTurnRecord | undefined {
  const record = recordOf(raw);
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return undefined;
  const requestId = boundedString(record.requestId, MAX_ID_CHARS);
  if (requestId === undefined) return undefined;
  const owner = recordOf(record.owner);
  const reply = recordOf(record.reply);
  if (!(REPLY_KINDS as readonly unknown[]).includes(reply.kind)) return undefined;
  const memoryId = boundedString(owner.memoryId, MAX_ID_CHARS);
  const hash = typeof owner.hash === 'string' && /^[0-9a-f]{64}$/u.test(owner.hash) ? owner.hash : undefined;
  const reason = (INELIGIBILITIES as readonly unknown[]).includes(owner.reason) ? (owner.reason as LastTurnIneligibility) : undefined;
  // Fail closed: an "eligible" owner needs its record and its hash.
  const eligible = owner.eligible === true && memoryId !== undefined && hash !== undefined;
  const listingSource = reply.listingSource === 'todo' || reply.listingSource === 'reminder' ? reply.listingSource : undefined;
  return {
    at: record.at as IsoTimestamp,
    requestId,
    owner: {
      ...(memoryId !== undefined ? { memoryId } : {}),
      eligible,
      ...(eligible ? { hash } : { reason: reason ?? 'unrecorded' }),
    },
    reply: { kind: reply.kind as LastTurnReplyKind, ...(listingSource !== undefined ? { listingSource } : {}), replyIds: replyIdsOf(reply.replyIds) },
  };
}

/** The last turn of this actor in this session within 30 minutes, else `undefined`. */
export function readLastTurn(value: unknown, actorId: Id, now: IsoTimestamp): LastTurnRecord | undefined {
  const record = lastTurnOf(recordOf(recordOf(value).byActor)[actorId]);
  if (record === undefined) return undefined;
  const age = ageOf(record.at, now);
  return Number.isFinite(age) && age >= 0 && age < LAST_TURN_TTL_MS ? record : undefined;
}

function serialize(record: LastTurnRecord): Record<string, unknown> {
  return {
    at: record.at,
    requestId: record.requestId,
    owner: {
      ...(record.owner.memoryId !== undefined ? { memoryId: record.owner.memoryId } : {}),
      eligible: record.owner.eligible,
      ...(record.owner.reason !== undefined ? { reason: record.owner.reason } : {}),
      ...(record.owner.hash !== undefined ? { hash: record.owner.hash } : {}),
    },
    reply: {
      kind: record.reply.kind,
      ...(record.reply.listingSource !== undefined ? { listingSource: record.reply.listingSource } : {}),
      replyIds: [...record.reply.replyIds],
    },
  };
}

function rewrite(current: unknown, actorId: Id, now: IsoTimestamp, next: LastTurnRecord | undefined): unknown {
  const byActor: Record<string, unknown> = {};
  for (const [other, raw] of Object.entries(recordOf(recordOf(current).byActor))) {
    if (other === actorId) continue;
    const record = lastTurnOf(raw);
    if (record === undefined) continue;
    const age = ageOf(record.at, now);
    if (Number.isFinite(age) && age >= 0 && age < LAST_TURN_TTL_MS) byActor[other] = serialize(record);
  }
  if (next !== undefined) byActor[actorId] = serialize(next);
  const keys = Object.keys(byActor);
  while (keys.length > MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined && victim !== actorId) delete byActor[victim];
  }
  return Object.keys(byActor).length === 0 ? undefined : { byActor };
}

/** Pure: the next value with `actorId`'s last turn set to `record`. */
export function withLastTurn(current: unknown, actorId: Id, record: LastTurnRecord, now: IsoTimestamp): unknown {
  return rewrite(current, actorId, now, record);
}

/** Pure: bind the delivered reply ids to the turn `requestId`, only while it is still this actor's last turn. */
export function withLastTurnReplies(current: unknown, actorId: Id, requestId: string, replyIds: readonly string[], now: IsoTimestamp): unknown {
  const record = readLastTurn(current, actorId, now);
  const ids = replyIdsOf(replyIds);
  if (record === undefined || record.requestId !== requestId || ids.length === 0) return current;
  return rewrite(current, actorId, now, { ...record, reply: { ...record.reply, replyIds: ids } });
}
