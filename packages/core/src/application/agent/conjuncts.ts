/**
 * ADR-0121 S2: the conjuncts of the owner's prose. Moved to `nl-routing/conjuncts` (owner decision of 2026-10-27, the
 * one-step `timedOnly` rule shares the plan validator's clauses); re-exported here so the agent's imports are unchanged.
 */
export { aliasStarts, conjunctTokens, type ConjunctToken } from '../nl-routing/conjuncts';
