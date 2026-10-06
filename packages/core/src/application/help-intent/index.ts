/**
 * Help intent (ADR-0104 D4) — application sub-barrel. LLM-1 ships the pure grammar and the provider-free
 * `pre-classify` turn handler (order 400); the composition root registers it (DET-1).
 */
export * from './help-intent';
export * from './help-intent-turn-handler';
