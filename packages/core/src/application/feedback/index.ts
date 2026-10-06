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
