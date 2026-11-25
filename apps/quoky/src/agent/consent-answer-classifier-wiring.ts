import { Capability, createConsentAnswerClassifier, type AiProvider } from '@quoky/core';
import type { ConsentAnswerClassifierMode } from './consent-answer-config';

/**
 * ADR-0121 amendment A6, "A6 classifier wiring": the composition root builds the consent-answer classifier switch from
 * `QUOKY_CONSENT_ANSWER_CLASSIFIER` instead of hard-wiring `{ mode: 'off' }`.
 *
 * - `off` (the default): exactly `{ mode: 'off' }`, as before; nothing is built and no router is touched.
 * - `on`: the A6-S2 adapter over the router's `INTENT_SELECTION` route. `on` is still refused at startup (`config.ts`,
 *   CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED) until the A6-S4 gate passes, so this branch is reachable from tests only. The adapter does
 *   not count calls: the gate charges every call to the actor's hourly model-call cap before it (`ConsentTurnGateDeps.chargeModelCall`).
 *   The chat provider of the turn is not a composition-time fact, so the adapter gets none and answers `unclear` without a call until
 *   the A6-S4 slice supplies it per turn (fail closed).
 */
export type ConsentClassifierSwitchBuilt = { readonly mode: 'off' } | { readonly mode: 'on'; readonly classify: ReturnType<typeof createConsentAnswerClassifier> };

export function buildConsentClassifierSwitch(
  mode: ConsentAnswerClassifierMode | undefined,
  router: { select(capability: Capability): Promise<AiProvider> },
  now: () => number,
): ConsentClassifierSwitchBuilt {
  if (mode !== 'on') return { mode: 'off' };
  return { mode: 'on', classify: createConsentAnswerClassifier({ select: () => router.select(Capability.INTENT_SELECTION), now }) };
}
