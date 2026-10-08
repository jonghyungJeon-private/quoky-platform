/**
 * Feedback capture and summary (ADR-0098) — application sub-barrel.
 *
 * The track's tasks (first: QUAL-3) add their modules to this folder and export them from this sub-barrel
 * only; the root application barrel is not edited after wave 1.
 */
export * from './implicit-feedback';
export * from './feedback-recorder';
export * from './feedback-summary-composer';
export * from './feedback-summary-turn-handler';
// ADR-0107 (LRN-1): owner-curated learning candidates and examples.
export * from './learning-commands';
export * from './learning-service';
export * from './learning-turn-handler';
// ADR-0107 D5/D6 (LRN-2): curated few-shot example selection for GENERAL_CHAT.
export * from './curated-example-selector';
// ADR-0116 (LRN-5): the curated-example egress policy (owner-selected REMOTE chat providers, flag-gated).
export * from './curated-example-egress-policy';
