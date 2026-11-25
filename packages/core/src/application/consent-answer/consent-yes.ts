import type { BoundConsent } from './consent-pending';

/**
 * The owner-yes brand (CS-1a review round 2). A {@link BoundConsent} only says a step was claimed and bound; `bind` does not know
 * what the owner answered. The yes brand is recorded ONLY by the yes path of `answerConsentTurn` (`closed-yes`, `classifier-yes`,
 * `classifier-yes-and-more`), through {@link recordOwnerYes}; a boundary test pins that `consent-answer.ts` is its only caller.
 * A consumer that needs "the owner said yes" (`mintSummaryConsentToken`) checks {@link isOwnerYes}.
 */
const YES = new WeakSet<object>();

/** Record that the bound consent came from a yes answer. Called by the answer pipeline only (boundary-pinned). */
export function recordOwnerYes(bound: BoundConsent): void {
  YES.add(bound);
}

/** Whether `value` is a bound consent the answer pipeline recorded as a yes. */
export function isOwnerYes(value: unknown): value is BoundConsent {
  return typeof value === 'object' && value !== null && YES.has(value);
}
