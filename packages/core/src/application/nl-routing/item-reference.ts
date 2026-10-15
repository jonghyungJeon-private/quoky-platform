import type { IsoTimestamp } from '../../domain';
import type { AnyListingReplyMatch, ListingItem, ListingRecord, ListingSlot, ListingSource } from '../last-listing';
import { LISTING_REPLY_TTL_MS } from '../last-listing';
import type { NlActionEntryId, NlItemSource, NlItemTarget, NlUndoSpec } from './catalog';
import { nlIndexWording, nlNamedItemSources, type NlRef } from './action-entries';
import type { LastActionView } from './last-action';
import { normalizeForMatch } from './selection-input';

/**
 * ADR-0120 amendment A6-D2: deterministic, content-free item references. Pure: every input is plain data (the listing
 * record, the last action, the reply target, the owner's own words) and `now`.
 *
 * Resolution, in order:
 *  0. A platform reply to a listing names that listing (GML-2 reply-to-pick): 24 hours for `item.summarize`, 30 minutes
 *     for every LOCAL_WRITE. Another source asks; an expired one asks.
 *  1. A reminder's digits mean its display number `#N` only when the turn is about reminders (a reminder noun, a fresh
 *     reminder listing as the most recent one, or a fresh reminder `lastAction`); ordinal words mean the position in the
 *     most recent reminder listing. Bare digits never cancel a reminder otherwise.
 *  2. `#n` and `last` resolve ONLY against the most recently written listing; another source asks (an older mail listing
 *     behind a newer Drive listing is never used); a missing number answers "목록에 K건만 있어요" and nothing runs.
 *  3. `recent` / `this`: the fresh `lastAction` of the entry's source; otherwise the most recent listing when it has that
 *     source and exactly one item; otherwise ask.
 *  4. A fresh `lastAction` item that differs from a fresh single-item listing of the same source asks.
 * Before all of them (A6 R1 fix, "Same source only"): when the owner's words name item sources with the catalog's nouns
 * ("1번 문서", "2번 메일", "그 알림") and none of them is the entry's source, the reply asks (other-source), for every ref
 * kind, so a selector `source` that disagrees with the owner's noun never reads or changes another source's item.
 * The execution-time check (5: re-read by id, owned, actionable) belongs to the handler.
 */

/** LOCAL_WRITE reply-to-pick window (A6-D2): 30 minutes. `item.summarize` keeps the GML-2 24 hours. */
export const LOCAL_WRITE_REPLY_PICK_MS = 30 * 60_000;

export type NlResolutionOutcome = 'resolved' | 'out-of-range' | 'expired' | 'ambiguous' | 'stale' | 'other-source' | 'none' | 'conflict';

export interface NlReferenceState {
  readonly listings: ListingRecord;
  readonly lastAction?: LastActionView;
  /** The owner's message is a platform reply: what its target is (a listing, or nothing Quoky recorded). */
  readonly replyTo?: { readonly messageId: string; readonly listing?: AnyListingReplyMatch };
  readonly now: IsoTimestamp;
}

export type NlReferenceResolution =
  | { readonly kind: 'resolved'; readonly target: NlItemTarget }
  | {
      readonly kind: 'unresolved';
      readonly outcome: Exclude<NlResolutionOutcome, 'resolved'>;
      /** The source the question is about (the entry's) and the listing that was found instead, if any. */
      readonly source: NlItemSource;
      readonly found?: ListingSource;
      /** The candidates to ask about, under their own shown labels (same source only). */
      readonly candidates?: readonly ListingItem[];
      readonly listingAt?: IsoTimestamp;
      /** Out of range: how many items the listing holds and which number was asked. */
      readonly count?: number;
      readonly index?: number;
    };

export interface NlReferenceInput {
  readonly entryId: NlActionEntryId;
  readonly source: NlItemSource;
  readonly ref: NlRef;
  /** The owner's own non-quoted words of this turn. */
  readonly groundingText: string;
  readonly state: NlReferenceState;
}

const REMINDER_NOUNS = ['알림', '리마인더', '리마인드', 'reminder'];

function ageMs(at: string, now: IsoTimestamp): number {
  return Date.parse(now) - Date.parse(at);
}

function aboutReminders(input: NlReferenceInput): boolean {
  const text = normalizeForMatch(input.groundingText);
  if (REMINDER_NOUNS.some((noun) => text.includes(noun))) return true;
  if (input.state.listings.mostRecent?.source === 'reminder') return true;
  const last = input.state.lastAction;
  return last !== undefined && last.fresh && last.record.source === 'reminder';
}

function targetFrom(slot: ListingSlot, item: ListingItem): NlItemTarget {
  return { source: slot.source as NlItemSource, id: item.id, label: item.label, ...(slot.source === 'mail' || slot.source === 'drive' ? { listingAt: slot.at } : {}) };
}

function unresolved(
  input: NlReferenceInput,
  outcome: Exclude<NlResolutionOutcome, 'resolved'>,
  extra: Partial<Omit<Extract<NlReferenceResolution, { kind: 'unresolved' }>, 'kind' | 'outcome'>> = {},
): NlReferenceResolution {
  return { kind: 'unresolved', outcome, ...extra, source: extra.source ?? input.source };
}

/** Pick within one slot of the entry's source (`#n` by shown label or position, `last`, a single-item `this`). */
function pickInSlot(input: NlReferenceInput, slot: ListingSlot): NlReferenceResolution {
  const ref = input.ref;
  if (ref.kind === 'index') {
    // Reminder ordinal words mean the position in the listing; every other number is the shown label.
    const byPosition = slot.source === 'reminder' && nlIndexWording(ref.index, input.groundingText) === 'ordinal';
    const item = byPosition ? slot.items[ref.index - 1] : slot.items.find((candidate) => candidate.label === ref.index);
    if (item === undefined) return unresolved(input, 'out-of-range', { count: slot.items.length, index: ref.index, found: slot.source, listingAt: slot.at });
    return { kind: 'resolved', target: targetFrom(slot, item) };
  }
  if (ref.kind === 'last') {
    const item = slot.items[slot.items.length - 1];
    return item === undefined ? unresolved(input, 'none') : { kind: 'resolved', target: targetFrom(slot, item) };
  }
  if (slot.items.length === 1) return { kind: 'resolved', target: targetFrom(slot, slot.items[0] as ListingItem) };
  return unresolved(input, 'ambiguous', { candidates: slot.items.slice(0, 10), found: slot.source, listingAt: slot.at });
}

/** A6-D2 resolution of one `ref` for an entry of `source`. Pure. */
export function resolveItemReference(input: NlReferenceInput): NlReferenceResolution {
  const { state, ref, source } = input;
  const localWrite = input.entryId !== 'item.summarize';
  // Same source only: the owner's own source noun wins over the selector's `source` (and entry), for every ref kind.
  const named = nlNamedItemSources(input.groundingText);
  if (named.size > 0 && !named.has(source)) {
    const meant = named.size === 1 ? [...named][0] : undefined;
    const found = state.replyTo?.listing?.kind === 'listing' ? state.replyTo.listing.slot.source : state.listings.mostRecent?.source;
    return unresolved(input, 'other-source', { ...(meant !== undefined ? { source: meant } : {}), ...(found !== undefined && found !== meant ? { found } : {}) });
  }
  // 0. reply-to-pick names its listing explicitly.
  const reply = state.replyTo?.listing;
  if (reply !== undefined) {
    if (reply.kind === 'expired') return unresolved(input, 'expired', { found: reply.source });
    const age = ageMs(reply.slot.at, state.now);
    const window = localWrite ? LOCAL_WRITE_REPLY_PICK_MS : LISTING_REPLY_TTL_MS;
    if (!Number.isFinite(age) || age < 0 || age >= window) return unresolved(input, 'expired', { found: reply.slot.source });
    if (reply.slot.source !== source) return unresolved(input, 'other-source', { found: reply.slot.source });
    return pickInSlot(input, reply.slot);
  }
  const mostRecent = state.listings.mostRecent;
  // 1. a reminder's display number.
  if (source === 'reminder' && ref.kind === 'index') {
    const wording = nlIndexWording(ref.index, input.groundingText);
    if (wording === 'digits') {
      if (!aboutReminders(input)) {
        return mostRecent !== undefined && mostRecent.source !== 'reminder'
          ? unresolved(input, 'other-source', { found: mostRecent.source })
          : unresolved(input, 'none');
      }
      // The display number is stable: the listing (when fresh) supplies the id, the repository resolves it otherwise.
      const listed = state.listings.slots.reminder?.items.find((item) => item.label === ref.index);
      return { kind: 'resolved', target: { source: 'reminder', ...(listed !== undefined ? { id: listed.id } : {}), label: ref.index } };
    }
  }
  // 3. `recent` / `this`.
  if (ref.kind === 'recent' || ref.kind === 'this') {
    const last = state.lastAction;
    const lastItem = last !== undefined && last.fresh && last.record.source === source && !last.record.undone ? last.record : undefined;
    const single = mostRecent !== undefined && mostRecent.source === source && mostRecent.items.length === 1 ? mostRecent.items[0] : undefined;
    if (lastItem !== undefined) {
      // 4. conflict with a fresh single-item listing of the same source.
      if (single !== undefined && single.id !== lastItem.itemId) {
        return unresolved(input, 'conflict', { candidates: [single, { label: lastItem.label ?? 0, id: lastItem.itemId }].filter((item) => item.label > 0), found: source });
      }
      return { kind: 'resolved', target: { source, id: lastItem.itemId, ...(lastItem.label !== undefined ? { label: lastItem.label } : {}) } };
    }
    if (mostRecent === undefined) return unresolved(input, last !== undefined && last.record.source === source ? 'stale' : 'none');
    if (mostRecent.source !== source) return unresolved(input, 'other-source', { found: mostRecent.source });
    return pickInSlot(input, mostRecent);
  }
  // 2. `#n` and `last`: the most recent listing only.
  if (mostRecent === undefined) return unresolved(input, 'none');
  if (mostRecent.source !== source) return unresolved(input, 'other-source', { found: mostRecent.source });
  return pickInSlot(input, mostRecent);
}

// ── undo (ratification record A) ─────────────────────────────────────────────────────────────────────────────────

export type NlUndoResolution =
  | { readonly kind: 'resolved'; readonly target: NlItemTarget; readonly undo: NlUndoSpec }
  | { readonly kind: 'unresolved'; readonly outcome: 'no-action' | 'undo-of-undo' | 'echo-mismatch' | 'stale' };

/**
 * Which action "되돌려줘" undoes: the latest action of this (Session, Actor) within 10 minutes, or the action whose echo a
 * platform reply points to (its ids must match `echoReplyIds`, within 30 minutes). An undo is never undone again, and a
 * reply to anything else asks. Pure.
 */
export function resolveUndo(state: Pick<NlReferenceState, 'lastAction' | 'replyTo'>): NlUndoResolution {
  const last = state.lastAction;
  const replyId = state.replyTo?.messageId;
  if (replyId !== undefined) {
    if (last === undefined || !last.record.echoReplyIds.includes(replyId)) return { kind: 'unresolved', outcome: 'echo-mismatch' };
  } else if (last === undefined) {
    return { kind: 'unresolved', outcome: 'no-action' };
  } else if (!last.fresh) {
    return { kind: 'unresolved', outcome: 'stale' };
  }
  const record = last.record;
  if (record.entryId === 'action.undo' || !record.undoable) return { kind: 'unresolved', outcome: 'undo-of-undo' };
  if (record.undone) return { kind: 'unresolved', outcome: 'undo-of-undo' };
  return {
    kind: 'resolved',
    target: { source: record.source, id: record.itemId, ...(record.label !== undefined ? { label: record.label } : {}) },
    undo: { entryId: record.entryId, ...(record.version !== undefined ? { version: record.version } : {}) },
  };
}

// ── the selector's structural view (A6-D2 "Reference context") ─────────────────────────────────────────────────────

function minutes(at: string, now: IsoTimestamp): number {
  return Math.max(0, Math.floor(ageMs(at, now) / 60_000));
}

/**
 * The "Reference context" line: kinds, counts and ages only (the ADR-0121 D4 `STRUCTURE` label). Never an id, a label
 * value, a title or a subject. `none` when nothing is fresh.
 */
export function renderReferenceContext(state: NlReferenceState): string {
  const parts: string[] = [];
  const mostRecent = state.listings.mostRecent;
  if (mostRecent !== undefined) {
    parts.push(`last listing: ${mostRecent.source} (${mostRecent.items.length} items, ${minutes(mostRecent.at, state.now)} min ago)`);
    const others = Object.values(state.listings.slots)
      .filter((slot): slot is ListingSlot => slot !== undefined && slot.source !== mostRecent.source)
      .map((slot) => `${slot.source} (${slot.items.length} items, ${minutes(slot.at, state.now)} min ago)`);
    if (others.length > 0) parts.push(`older listings: ${others.join(', ')}`);
  }
  const last = state.lastAction;
  if (last !== undefined && last.fresh) {
    parts.push(`last action: ${last.record.entryId} (${minutes(last.record.at, state.now)} min ago${last.record.undoable && !last.record.undone ? ', undoable' : ''})`);
  }
  return parts.length === 0 ? 'none' : parts.join('; ');
}

/** Whether the turn has any fresh reference record (A6-D3: such a turn bypasses the selection cache). */
export function hasReferenceRecord(state: NlReferenceState): boolean {
  return state.listings.mostRecent !== undefined || (state.lastAction !== undefined && state.lastAction.fresh) || state.replyTo !== undefined;
}
