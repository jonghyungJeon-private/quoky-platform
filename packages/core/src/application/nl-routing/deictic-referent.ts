import type { ListingItem, ListingSlot } from '../last-listing';
import { nlDeicticOriginOf, nlDeterminerSources, nlHasRecencyWord, nlNumeralsIn, nlOrdinalsIn, withoutNlOriginPhrases, withoutSpan } from './action-entries';
import type { DeicticEntryId, DeicticReferentRef } from './deictic-draft';
import { LOCAL_WRITE_REPLY_PICK_MS, type NlReferenceState } from './item-reference';
import type { LastTurnRecord } from './last-turn';

/**
 * ADR-0120 amendment A6 R5a (§1.4): which earlier text "그거" means when the owner asks to make it a to-do or a reminder.
 * Pure: plain records in (the listing record, `lastAction`, the platform reply target, `lastTurn`), a referent reference
 * (ids and hashes, never text) or a fixed outcome out. Runs only where Core would otherwise refuse with `deictic-payload`.
 *
 * Order (first match wins):
 *  1. A platform reply-to a Quoky message (30 minutes): an echo → that item; a to-do / reminder listing → that listing; a
 *     Quoky chat answer → `model-drafted`; a note (mail, Drive, calendar, summary) → `external-origin`; anything else →
 *     the owner writes the text.
 *  2. A number or ordinal resolves only in the listing the LAST Quoky reply showed (a listing, its echo or its question).
 *     A newer reply of any other kind in between never falls back to an older listing.
 *  3. A determiner plus a source noun ("그 할 일", "그 알림"): the noun names the referent's source (an external noun is
 *     `external-origin`).
 *  4. An origin word: "내가 말한 거" → the owner's previous message (if eligible); "네가 추천한 거" / "답변" →
 *     `model-drafted` (R5b, deferred).
 *  5. A plain deictic uses the last Quoky reply: echo → its item; listing → one item or a question; chat →
 *     `model-drafted` (never a silent fallback to the owner's message); note → `external-origin`; question / refusal /
 *     preview → the owner's previous message when it was eligible at receipt.
 *  6. "방금" / "아까" naming a fresh `lastAction` item that differs from the last reply's referent asks with both.
 * Nothing referable (no `lastTurn`, or a turn before it existed) is today's `deictic-payload` reply.
 */

export type DeicticReferentPath = 'reply-to' | 'number' | 'determiner' | 'origin' | 'echo' | 'listing' | 'owner-message';

export type DeicticRefusalReason =
  | 'model-drafted'
  | 'external-origin'
  | 'write-text'
  | 'no-owner-message'
  | 'stale-number'
  | 'out-of-range'
  | 'not-found';

export type DeicticResolution =
  | { readonly kind: 'resolved'; readonly referent: DeicticReferentRef; readonly path: DeicticReferentPath }
  | { readonly kind: 'ask'; readonly candidates: readonly DeicticReferentRef[]; readonly reason: 'ambiguous' | 'conflict'; readonly path: DeicticReferentPath }
  | { readonly kind: 'refuse'; readonly reason: DeicticRefusalReason }
  | { readonly kind: 'nothing' };

export interface DeicticReferentInput {
  readonly entryId: DeicticEntryId;
  /** The owner's own non-quoted words of this turn. */
  readonly groundingText: string;
  /** A reminder's time words: removed before numbers are read ("내일 9시"). */
  readonly whenSpan?: string;
  readonly state: NlReferenceState;
  /** The previous turn of this (Session, Actor), or `undefined` (none, expired, or recorded before R5a). */
  readonly lastTurn?: LastTurnRecord;
}

const MAX_CANDIDATES = 10;

function itemRef(source: 'todo' | 'reminder', item: Pick<ListingItem, 'id' | 'label'>): DeicticReferentRef {
  return { kind: 'item.local', source, itemId: item.id, ...(item.label > 0 ? { label: item.label } : {}) };
}

function sameReferent(a: DeicticReferentRef, b: DeicticReferentRef): boolean {
  if (a.kind === 'item.local' && b.kind === 'item.local') return a.source === b.source && a.itemId === b.itemId;
  if (a.kind === 'owner.message' && b.kind === 'owner.message') return a.memoryId === b.memoryId;
  return false;
}

/** Pick one item of a to-do / reminder slot: a number by its shown label, an ordinal by position, else one item or ask. */
function pickInSlot(slot: ListingSlot, numbers: readonly number[], ordinals: readonly number[], path: DeicticReferentPath): DeicticResolution {
  if (slot.source !== 'todo' && slot.source !== 'reminder') return { kind: 'refuse', reason: 'external-origin' };
  const source = slot.source;
  if (numbers.length + ordinals.length > 1) return { kind: 'refuse', reason: 'write-text' };
  if (numbers.length === 1) {
    const item = slot.items.find((candidate) => candidate.label === numbers[0]);
    return item === undefined ? { kind: 'refuse', reason: 'out-of-range' } : { kind: 'resolved', referent: itemRef(source, item), path };
  }
  if (ordinals.length === 1) {
    const item = slot.items[(ordinals[0] as number) - 1];
    return item === undefined ? { kind: 'refuse', reason: 'out-of-range' } : { kind: 'resolved', referent: itemRef(source, item), path };
  }
  if (slot.items.length === 1) return { kind: 'resolved', referent: itemRef(source, slot.items[0] as ListingItem), path };
  if (slot.items.length === 0) return { kind: 'refuse', reason: 'not-found' };
  return { kind: 'ask', reason: 'ambiguous', candidates: slot.items.slice(0, MAX_CANDIDATES).map((item) => itemRef(source, item)), path };
}

/** The to-do / reminder listing the LAST Quoky reply showed (its own slot, written by that very turn). */
function lastReplySlot(input: DeicticReferentInput): ListingSlot | undefined {
  const turn = input.lastTurn;
  if (turn === undefined || turn.reply.listingSource === undefined) return undefined;
  if (turn.reply.kind !== 'listing' && turn.reply.kind !== 'echo' && turn.reply.kind !== 'question') return undefined;
  const slot = input.state.listings.slots[turn.reply.listingSource];
  return slot !== undefined && slot.requestId === turn.requestId ? slot : undefined;
}

/** The fresh `lastAction` item (not undone), optionally of one source. */
function lastActionItem(input: DeicticReferentInput, source?: 'todo' | 'reminder'): DeicticReferentRef | undefined {
  const last = input.state.lastAction;
  if (last === undefined || !last.fresh || last.record.undone || last.record.entryId === 'action.undo') return undefined;
  if (source !== undefined && last.record.source !== source) return undefined;
  return { kind: 'item.local', source: last.record.source, itemId: last.record.itemId, ...(last.record.label !== undefined ? { label: last.record.label } : {}) };
}

function ownerMessage(input: DeicticReferentInput): DeicticReferentRef | undefined {
  const turn = input.lastTurn;
  if (turn === undefined || !turn.owner.eligible || turn.owner.memoryId === undefined || turn.owner.hash === undefined) return undefined;
  return { kind: 'owner.message', memoryId: turn.owner.memoryId, hash: turn.owner.hash, at: turn.at };
}

export function resolveDeicticReferent(input: DeicticReferentInput): DeicticResolution {
  const { state } = input;
  const prose = withoutNlOriginPhrases(input.whenSpan !== undefined ? withoutSpan(input.groundingText, input.whenSpan) : input.groundingText);
  const numbers = [...new Set(nlNumeralsIn(prose))];
  const ordinals = [...new Set(nlOrdinalsIn(prose))];

  // 1. A platform reply names what it replies to.
  const reply = state.replyTo;
  if (reply !== undefined) {
    const last = state.lastAction;
    if (last !== undefined && last.record.echoReplyIds.includes(reply.messageId)) {
      if (last.record.undone || last.record.entryId === 'action.undo') return { kind: 'refuse', reason: 'not-found' };
      return { kind: 'resolved', referent: { kind: 'item.local', source: last.record.source, itemId: last.record.itemId, ...(last.record.label !== undefined ? { label: last.record.label } : {}) }, path: 'reply-to' };
    }
    const listing = reply.listing;
    if (listing?.kind === 'expired') return { kind: 'refuse', reason: 'not-found' };
    if (listing?.kind === 'listing') {
      if (listing.slot.source === 'mail' || listing.slot.source === 'drive') return { kind: 'refuse', reason: 'external-origin' };
      const age = Date.parse(state.now) - Date.parse(listing.slot.at);
      if (!Number.isFinite(age) || age < 0 || age >= LOCAL_WRITE_REPLY_PICK_MS) return { kind: 'refuse', reason: 'not-found' };
      return pickInSlot(listing.slot, numbers, ordinals, 'reply-to');
    }
    const turn = input.lastTurn;
    if (turn !== undefined && turn.reply.replyIds.includes(reply.messageId)) {
      if (turn.reply.kind === 'chat') return { kind: 'refuse', reason: 'model-drafted' };
      if (turn.reply.kind === 'note') return { kind: 'refuse', reason: 'external-origin' };
    }
    return { kind: 'refuse', reason: 'write-text' };
  }

  // 2. A number or ordinal: only in the listing the last reply showed.
  if (numbers.length + ordinals.length > 0) {
    const slot = lastReplySlot(input);
    if (slot === undefined) return { kind: 'refuse', reason: 'stale-number' };
    return pickInSlot(slot, numbers, ordinals, 'number');
  }

  // 3. A determiner plus a source noun names the referent's source.
  const named = nlDeterminerSources(input.groundingText);
  if (named.size > 0) {
    if (named.has('mail') || named.has('drive')) return { kind: 'refuse', reason: 'external-origin' };
    if (named.size > 1) return { kind: 'refuse', reason: 'write-text' };
    const source = [...named][0] as 'todo' | 'reminder';
    const slot = lastReplySlot(input);
    if (slot !== undefined && slot.source === source) return pickInSlot(slot, [], [], 'determiner');
    const item = lastActionItem(input, source);
    return item !== undefined ? { kind: 'resolved', referent: item, path: 'determiner' } : { kind: 'refuse', reason: 'not-found' };
  }

  // 4. An origin word.
  const origin = nlDeicticOriginOf(input.groundingText);
  if (origin === 'assistant') return { kind: 'refuse', reason: 'model-drafted' };
  if (origin === 'owner') {
    const message = ownerMessage(input);
    return message !== undefined ? { kind: 'resolved', referent: message, path: 'origin' } : { kind: 'refuse', reason: 'no-owner-message' };
  }

  // 5. A plain deictic: the last Quoky reply.
  const turn = input.lastTurn;
  if (turn === undefined) return { kind: 'nothing' };
  let resolved: DeicticResolution;
  switch (turn.reply.kind) {
    case 'echo': {
      const item = lastActionItem(input);
      const own = state.lastAction?.record.requestId === turn.requestId;
      resolved = item !== undefined && own ? { kind: 'resolved', referent: item, path: 'echo' } : { kind: 'refuse', reason: 'write-text' };
      break;
    }
    case 'listing': {
      const slot = lastReplySlot(input);
      resolved = slot !== undefined ? pickInSlot(slot, [], [], 'listing') : { kind: 'refuse', reason: 'write-text' };
      break;
    }
    case 'chat':
      return { kind: 'refuse', reason: 'model-drafted' };
    case 'note':
      return { kind: 'refuse', reason: 'external-origin' };
    case 'question':
    case 'refusal':
    case 'preview': {
      const slot = lastReplySlot(input);
      if (slot !== undefined) {
        resolved = pickInSlot(slot, [], [], 'listing');
        break;
      }
      const message = ownerMessage(input);
      resolved = message !== undefined ? { kind: 'resolved', referent: message, path: 'owner-message' } : { kind: 'refuse', reason: 'write-text' };
      break;
    }
  }

  // 6. "방금" / "아까" naming a fresh last action that is not the last reply's referent: ask with both.
  const recent = nlHasRecencyWord(input.groundingText) ? lastActionItem(input) : undefined;
  if (recent !== undefined && resolved.kind === 'resolved' && !sameReferent(recent, resolved.referent)) {
    return { kind: 'ask', reason: 'conflict', candidates: [recent, resolved.referent], path: resolved.path };
  }
  return resolved;
}
