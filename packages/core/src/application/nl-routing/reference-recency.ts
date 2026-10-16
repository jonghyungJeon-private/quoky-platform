import type { ListingRecord, ListingSlot } from '../last-listing';

/**
 * A6 reference priority (owner-approved 2026-10-16, A6-D2 clarification; `docs/plans/a6-reference-priority-proposal.md`
 * §2.1): which is the newest referable thing, the fresh `lastAction` or a listing, compared by timestamp. Pure.
 *
 * - The slot the action's own echo wrote (same source and same `requestId`) is ignored: an echo `merge` stamps the slot
 *   with the action's own `at`, so without the exclusion every write would tie with itself.
 * - `L` is the newest remaining fresh slot of ANY source.
 * - `action`: `A` is newer than `L` (or there is no `L`).
 * - `listing`: `L` is newer than `A`.
 * - `tie`: `A` and `L` are within {@link REFERENCE_TIE_MS}, or either timestamp is unreadable. A tie is never broken in
 *   favour of the write: the caller asks.
 *
 * A6 R2 (owner decision D9): for `item.summarize` only, `quoky.lastRead` takes the place of `lastAction` under exactly
 * these rules (a read writes no listing, so it has no echo slot).
 */

/** Two records within this distance are a tie ("within the same second"). */
export const REFERENCE_TIE_MS = 1_000;

export type ReferenceRecency =
  | { readonly kind: 'action' }
  | { readonly kind: 'listing' | 'tie'; readonly slot: ListingSlot };

/** Whether `slot` is the echo the action itself wrote (same source, same inbound request). */
export function isActionEcho(slot: ListingSlot, action: { readonly source: string; readonly requestId?: string }): boolean {
  return slot.source === action.source && action.requestId !== undefined && slot.requestId === action.requestId;
}

/** The newest referable record between `action` and the fresh listing slots (§2.1). */
export function newestReference(action: { readonly source: string; readonly requestId?: string; readonly at: string }, listings: ListingRecord): ReferenceRecency {
  let newest: ListingSlot | undefined;
  for (const slot of Object.values(listings.slots)) {
    if (slot === undefined || isActionEcho(slot, action)) continue;
    if (newest === undefined || Date.parse(slot.at) > Date.parse(newest.at)) newest = slot;
  }
  if (newest === undefined) return { kind: 'action' };
  const delta = Date.parse(newest.at) - Date.parse(action.at);
  if (!Number.isFinite(delta) || Math.abs(delta) < REFERENCE_TIE_MS) return { kind: 'tie', slot: newest };
  return delta > 0 ? { kind: 'listing', slot: newest } : { kind: 'action' };
}
