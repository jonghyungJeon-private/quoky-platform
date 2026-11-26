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
  ITEM_SUMMARY_CONSENT_INVALID: 'ITEM_SUMMARY_CONSENT_INVALID',
  ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT: 'ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT',
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

/**
 * ADR-0121 amendment A8 (OQ1-2): `QUOKY_ITEM_SUMMARY_CONSENT`, rule ① for the live item summaries (mail item and thread, Drive
 * file, Jira issue, Slack message and thread) and the D8 lookup summary.
 *
 * - Unset or exactly `off` (the default): the live summaries are as built, byte for byte (no pre-resolve, no guard, no question,
 *   no recipient line; CS-1a C1).
 * - Exactly `on`, which needs `QUOKY_SUMMARY_CONSENT=on` (the shared pending store and the gate; otherwise
 *   `ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT`, precedent `NL_ITEM_R2_REQUIRES_ACTIONS`): an expected REMOTE recipient is
 *   summarised and the reply ends with the recipient line; an unexpected one is asked in the owner DM (nothing sent until the yes;
 *   the yes is unavailable until OQ1-3); a D8 lookup with a REMOTE recipient shows the listing only (until OQ1-4). Enabling it in a
 *   runtime is a separate Strict step (A8.10).
 * - Anything else is `ITEM_SUMMARY_CONSENT_INVALID`.
 */
export interface ItemSummaryConsentConfig {
  readonly mode: SummaryConsentMode;
}

export function parseItemSummaryConsentConfig(env: NodeJS.ProcessEnv, summaryConsent: SummaryConsentConfig): ItemSummaryConsentConfig {
  const raw = env.QUOKY_ITEM_SUMMARY_CONSENT;
  if (raw === undefined || raw === 'off') return { mode: 'off' };
  if (raw !== 'on') throw new SummaryConsentConfigError(SummaryConsentConfigErrorCode.ITEM_SUMMARY_CONSENT_INVALID);
  if (summaryConsent.mode !== 'on') throw new SummaryConsentConfigError(SummaryConsentConfigErrorCode.ITEM_SUMMARY_CONSENT_REQUIRES_SUMMARY_CONSENT);
  return { mode: 'on' };
}
