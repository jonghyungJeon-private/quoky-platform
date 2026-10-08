import {
  LEARNING_EGRESS_LOCAL_ONLY,
  LEARNING_EXAMPLE_EGRESS_OWNER_SELECTED_REMOTE,
  isLearningEgressAllowed,
} from '../../domain';
import type { CuratedExampleEgress } from '../../domain';
import type { AiExecutionLocality, ProviderSelectionSource } from '../../ports';

/**
 * Curated-example egress policy (ADR-0107 D5/D6 as amended by ADR-0116). Two decisions, both data-driven:
 *
 * 1. **Which use-time egress class an example carries** ({@link curatedExampleEgressOf}). The composition root sets
 *    {@link CuratedExampleEgressPolicy.remoteOwnerSelected} from `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED` (default
 *    `false`). Off → every entry is `LOCAL_ONLY`, exactly as before (prompts byte-identical). On → entries carry
 *    `LOCAL_OR_OWNER_SELECTED_REMOTE`. The STORED item egress is not touched either way.
 * 2. **Whether an entry may reach the resolved provider** ({@link isCuratedExampleEgressAllowed}), after the provider is
 *    resolved: from its declared `executionLocality` and the selection source the selector reported with it. Never
 *    from a provider id. A `REMOTE` (or undeclared) provider receives an example only when the entry is
 *    `LOCAL_OR_OWNER_SELECTED_REMOTE` AND the source is `OWNER_SELECTED`; the derived default, the selection-time
 *    fallback and a missing source are not owner selections (fail closed). `LOCAL` keeps the ADR-0107 rule.
 *
 * The capability gate (GENERAL_CHAT only), the credential guard at use, the 2-example cap and the budget stay in
 * `curatedExamplesForPrompt`; consent, retention and the forget cascade stay in the learning store.
 */
export interface CuratedExampleEgressPolicy {
  /** ADR-0116 D1: `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED`. */
  readonly remoteOwnerSelected: boolean;
}

/** The ADR-0107 policy (and the ADR-0116 default): examples reach only a `LOCAL` provider. */
export const LOCAL_ONLY_CURATED_EXAMPLE_EGRESS_POLICY: CuratedExampleEgressPolicy = Object.freeze({
  remoteOwnerSelected: false,
});

/** The use-time egress class every selected entry carries under `policy`. */
export function curatedExampleEgressOf(policy: CuratedExampleEgressPolicy): CuratedExampleEgress {
  return policy.remoteOwnerSelected === true ? LEARNING_EXAMPLE_EGRESS_OWNER_SELECTED_REMOTE : LEARNING_EGRESS_LOCAL_ONLY;
}

/** What is known about the provider resolved for this execution. Absent fields fail closed. */
export interface CuratedExampleEgressTarget {
  /** `executionLocalityOf(provider)`; absent → `REMOTE`. */
  readonly executionLocality?: AiExecutionLocality;
  /** From `ProviderSelector.resolve`; absent → not an owner selection. */
  readonly selectionSource?: ProviderSelectionSource;
}

/** ADR-0116 D2/D3: may an entry with egress class `egress` be composed for `target`? Unknown classes never are. */
export function isCuratedExampleEgressAllowed(egress: unknown, target: CuratedExampleEgressTarget): boolean {
  if (typeof egress !== 'string') return false;
  if (target.executionLocality === 'LOCAL') {
    return (
      isLearningEgressAllowed(egress, 'LOCAL') ||
      egress === LEARNING_EXAMPLE_EGRESS_OWNER_SELECTED_REMOTE
    );
  }
  return egress === LEARNING_EXAMPLE_EGRESS_OWNER_SELECTED_REMOTE && target.selectionSource === 'OWNER_SELECTED';
}
