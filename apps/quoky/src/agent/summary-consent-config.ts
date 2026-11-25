/**
 * ADR-0121 SR-1 rule ① (the confirm slice, CS-1a): the ask-mode switch `QUOKY_SUMMARY_CONSENT`, parsed and validated only here
 * (composition root) and folded into `QuokyConfig.summaryConsent` by `config.ts`. Typed value-free errors: the message is the
 * code only.
 *
 * - Unset or exactly `off` (the default): no question and no pending step. The Core guard (`deriveM2Localities`) is NOT behind
 *   this switch: an agent summary never reaches a `REMOTE` model without the owner's bound yes, so with `off` the agent path
 *   is `LOCAL` or listing-only.
 * - Exactly `on`: a summarize step whose selector would pick a `REMOTE` model asks first (the question and a pending consent
 *   step). It also composes the one shared pending store and the runtime gate that answers it (CS-2, `features/agent.providers.ts`). It is
 *   inert while `QUOKY_AGENT_MODE=active` is refused at startup and the agent read ports are empty.
 * - Anything else is `SUMMARY_CONSENT_INVALID`.
 */

export type SummaryConsentMode = 'off' | 'on';

export interface SummaryConsentConfig {
  readonly mode: SummaryConsentMode;
}

export const SummaryConsentConfigErrorCode = {
  SUMMARY_CONSENT_INVALID: 'SUMMARY_CONSENT_INVALID',
} as const;
export type SummaryConsentConfigErrorCode = (typeof SummaryConsentConfigErrorCode)[keyof typeof SummaryConsentConfigErrorCode];

export class SummaryConsentConfigError extends Error {
  constructor(readonly code: SummaryConsentConfigErrorCode) {
    super(code);
    this.name = 'SummaryConsentConfigError';
  }
}

export function parseSummaryConsentConfig(env: NodeJS.ProcessEnv): SummaryConsentConfig {
  const raw = env.QUOKY_SUMMARY_CONSENT;
  if (raw === undefined || raw === 'off') return { mode: 'off' };
  if (raw === 'on') return { mode: 'on' };
  throw new SummaryConsentConfigError(SummaryConsentConfigErrorCode.SUMMARY_CONSENT_INVALID);
}
