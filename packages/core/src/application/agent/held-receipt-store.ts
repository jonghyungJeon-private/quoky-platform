import { HELD_RECEIPT_FROZEN_TTL_MS, HELD_RECEIPT_METADATA_KEY, parseHeldReceipt, type HeldReceipt } from './held-receipt';
import { parsePendingA7Pick, type PendingA7Pick } from './a7-pick';

/**
 * ADR-0121 amendment A7, slice A7-S4b: where the A7 state lives (A7.6: "one content-free receipt record beside `quoky.lastRead`; the pending
 * destination pick with its frozen receipt"). Pure functions over `Session.metadata[`{@link HELD_RECEIPT_METADATA_KEY}`]`, in the style of
 * `quoky.lastRead` (`readLastRead` / `withLastRead`): no new `ConversationRuntimeDeps` key, no migration, no port. The caller (the runtime)
 * owns the read and the save; the agent service only returns the next value.
 *
 *   metadata['quoky.heldReceipt'] = { byActor: { [actorId]: { held?, pick?, card? } } }
 *
 * - `held`: the content-free held receipt (A7.4) of the owner's last delivered listing or answer;
 * - `pick`: the pending destination pick with its frozen receipt (A7.4b);
 * - `card`: the open A7 card's frozen items and the facts the closure check needs (A7.4c item 4).
 *
 * Every record is strict-parsed, holds ids, digests, closed values and the owner's own validated scalar args and NEVER an item title or field,
 * an owner's own words, an answer text or a model output (ADR-0121 D3, D7: no content cache; AGENTS.md: no context snapshot in a Session).
 * Anything malformed counts as absent. A record older than every window it could serve is dropped at the next write.
 *
 * Review round 1 (P1-1; A7.4: "the kill switch and a restart void it"): the state is stamped with the BOOT ID of the process that wrote it
 * (injected by the composition root, like the hasher) and every record carries its own time. The reader ({@link readA7State}) takes a
 * {@link A7StateGuard}: a record written by another boot is absent, and so is one at or before the kill switch's last change (`stop`, then
 * `resume`, voids it). There is no guard-free read: a caller without a boot id gets no state (fail closed).
 */

const MAX_ACTORS = 64;
/** A card record is kept at most this long after the card was made (the card's own lifetime is far shorter; this only bounds the metadata). */
const CARD_RECORD_TTL_MS = 2 * HELD_RECEIPT_FROZEN_TTL_MS;

/** What the closure check of one card needs, and the receipt that closing it may hand on (A7.4c item 4). */
export interface A7CardRecord {
  readonly cardId: string;
  /** Opaque: handed back to the proposal port's `closureOf`. */
  readonly taskId: string;
  readonly sessionId: string;
  readonly cardAt: string;
  /** The card's frozen items with their ORIGINAL `at` (a carried receipt keeps it). */
  readonly frozen: HeldReceipt;
  /** The card was built from a carried receipt: closing it hands nothing on (at most one carry-over). */
  readonly builtFromCarried: boolean;
  /**
   * P2-2: the owner turn that CLOSED the card (set by the runtime when it observes the closure, {@link withCardClosingTurn}). The card's items
   * carry over only to the turn right after it; absent, nothing carries over (fail closed).
   */
  readonly closingTurnId?: string;
}

/** What the reader needs to tell a live record from a void one (P1-1). */
export interface A7StateGuard {
  /** The boot id of THIS process; a record of another boot is absent. Empty or absent: no state at all. */
  readonly bootId: string | undefined;
  /** The `at` of the kill switch's last change (`quoky.actionSwitch`): a record at or before it is absent (stop, then resume, voids it). */
  readonly switchAt?: string;
}

export interface A7ActorState {
  readonly held?: HeldReceipt;
  readonly pick?: PendingA7Pick;
  readonly card?: A7CardRecord;
}

const CARD_KEYS: ReadonlySet<string> = new Set(['cardId', 'taskId', 'sessionId', 'cardAt', 'frozen', 'builtFromCarried', 'closingTurnId']);

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;

function parseCard(raw: unknown): A7CardRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CARD_KEYS.has(key))) return undefined;
  if (!text(record.cardId) || !text(record.taskId) || !text(record.sessionId) || typeof record.cardAt !== 'string' || !Number.isFinite(Date.parse(record.cardAt)) || typeof record.builtFromCarried !== 'boolean') return undefined;
  const frozen = parseHeldReceipt(record.frozen);
  if (record.closingTurnId !== undefined && !text(record.closingTurnId)) return undefined;
  return frozen === undefined ? undefined : { cardId: record.cardId, taskId: record.taskId, sessionId: record.sessionId, cardAt: record.cardAt, frozen, builtFromCarried: record.builtFromCarried, ...(record.closingTurnId !== undefined ? { closingTurnId: record.closingTurnId } : {}) };
}

/** Whether a record made at `at` is still live under the guard: after the kill switch's last change (strictly). */
function liveAt(at: string, guard: A7StateGuard): boolean {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  if (guard.switchAt === undefined) return true;
  const switched = Date.parse(guard.switchAt);
  return Number.isFinite(switched) && ms > switched;
}

/**
 * This actor's A7 state from the stored metadata value; every part strict-parsed, none checked for the bind windows (the bind does that).
 * Void (absent): everything written by another boot, no boot id given, and every part at or before the kill switch's last change.
 */
export function readA7State(value: unknown, actorId: string, guard: A7StateGuard): A7ActorState {
  if (guard.bootId === undefined || guard.bootId.length === 0) return {};
  const own = recordOf(recordOf(recordOf(value).byActor)[actorId]);
  if (own.bootId !== guard.bootId) return {};
  const held = parseHeldReceipt(own.held);
  const pick = parsePendingA7Pick(own.pick);
  const card = parseCard(own.card);
  return {
    ...(held !== undefined && liveAt(held.at, guard) ? { held } : {}),
    ...(pick !== undefined && pick.actorId === actorId && liveAt(pick.askedAt, guard) ? { pick } : {}),
    ...(card !== undefined && liveAt(card.cardAt, guard) ? { card } : {}),
  };
}

function serialise(state: A7ActorState): Record<string, unknown> {
  return { ...(state.held !== undefined ? { held: state.held } : {}), ...(state.pick !== undefined ? { pick: state.pick } : {}), ...(state.card !== undefined ? { card: state.card } : {}) };
}

function stillUseful(state: A7ActorState, now: number): boolean {
  const alive = (at: string): boolean => {
    const age = now - Date.parse(at);
    return Number.isFinite(age) && age >= 0 && age < CARD_RECORD_TTL_MS;
  };
  return (state.held !== undefined && alive(state.held.at)) || (state.pick !== undefined && alive(state.pick.askedAt)) || (state.card !== undefined && alive(state.card.cardAt));
}

/**
 * Pure: the next metadata value after `actorId`'s state became `next` (an empty state removes the actor). Other actors are kept while one of
 * their records is still within a window, at most 64. The value is plain JSON; a restart does NOT give it back (the boot id differs: every record of another boot is void).
 */
export function withA7State(current: unknown, actorId: string, next: A7ActorState, now: string, guard: A7StateGuard): unknown {
  const nowMs = Date.parse(now);
  const byActor: Record<string, unknown> = {};
  for (const other of Object.keys(recordOf(recordOf(current).byActor))) {
    if (other === actorId) continue;
    const state = readA7State(current, other, guard);
    if (Number.isFinite(nowMs) && stillUseful(state, nowMs)) byActor[other] = { bootId: guard.bootId, ...serialise(state) };
  }
  const keys = Object.keys(byActor);
  while (keys.length >= MAX_ACTORS) {
    const victim = keys.shift();
    if (victim !== undefined) delete byActor[victim];
  }
  const own = serialise(next);
  if (Object.keys(own).length > 0 && guard.bootId !== undefined && guard.bootId.length > 0) byActor[actorId] = { bootId: guard.bootId, ...own };
  return { byActor };
}

/**
 * P2-2: records the owner turn that closed the card, once (a card that already has one keeps it). Pure; the state is unchanged when there is
 * no live card. The runtime calls it on the turn it observes the closure (A7-S5).
 */
export function withCardClosingTurn(current: unknown, actorId: string, closingTurnId: string, now: string, guard: A7StateGuard): unknown {
  const state = readA7State(current, actorId, guard);
  if (state.card === undefined || state.card.closingTurnId !== undefined || !text(closingTurnId)) return current;
  return withA7State(current, actorId, { ...state, card: { ...state.card, closingTurnId } }, now, guard);
}

export { HELD_RECEIPT_METADATA_KEY };
