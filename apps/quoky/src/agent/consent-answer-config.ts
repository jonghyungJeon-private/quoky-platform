/**
 * ADR-0121 amendment A6 (ratified 2026-11-23; R10), slice A6-S1: the consent-answer classifier switch
 * `QUOKY_CONSENT_ANSWER_CLASSIFIER`, parsed and validated only here (composition root) and folded into
 * `QuokyConfig.consentAnswer` by `config.ts`. Typed value-free errors: the message is the code only.
 *
 * - Unset or exactly `off` (the default): the A6.3 claim, structural checks and NFKC fast path run, and every other reply
 *   to a pending consent cancels as SR-1 W1 / A2 answer 2 as built. (No consent step is opened by a live path yet: the
 *   rule-① confirm slice and the A2 answer slice are not built, so today the switch changes no turn at all.)
 * - Exactly `on` is refused at startup with `CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED` (the code-level release gate, as
 *   `QUOKY_AGENT_MODE=active`): R10 allows it only after the classifier (A6-S2), the A6-S4 gate and the rule-① confirm slice.
 *   Any change of model, effort, tier or prompt hash needs the gate again (a6-12).
 * - Anything else is `CONSENT_ANSWER_CLASSIFIER_INVALID`.
 */

export type ConsentAnswerClassifierMode = 'off';

export interface ConsentAnswerConfig {
  readonly classifier: ConsentAnswerClassifierMode;
}

export const ConsentAnswerConfigErrorCode = {
  CONSENT_ANSWER_CLASSIFIER_INVALID: 'CONSENT_ANSWER_CLASSIFIER_INVALID',
  CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED: 'CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED',
} as const;
export type ConsentAnswerConfigErrorCode = (typeof ConsentAnswerConfigErrorCode)[keyof typeof ConsentAnswerConfigErrorCode];

export class ConsentAnswerConfigError extends Error {
  constructor(readonly code: ConsentAnswerConfigErrorCode) {
    super(code);
    this.name = 'ConsentAnswerConfigError';
  }
}

export function parseConsentAnswerConfig(env: NodeJS.ProcessEnv): ConsentAnswerConfig {
  const raw = env.QUOKY_CONSENT_ANSWER_CLASSIFIER;
  if (raw === undefined || raw === 'off') return { classifier: 'off' };
  if (raw === 'on') throw new ConsentAnswerConfigError(ConsentAnswerConfigErrorCode.CONSENT_ANSWER_CLASSIFIER_NOT_RELEASED);
  throw new ConsentAnswerConfigError(ConsentAnswerConfigErrorCode.CONSENT_ANSWER_CLASSIFIER_INVALID);
}
