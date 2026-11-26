import type { Capability } from '../../domain';
import type { AiProvider } from '../../ports/ai-provider.port';
import type { ProviderSelectionContext } from '../../ports/provider-selection-policy.port';
import { recipientVerdict, type RecipientVerdict } from './expected-recipient';
import { renderItemSummaryRecipientLine } from './recipient-line';

/**
 * ADR-0121 amendment A8.3c (OQ1-2): the per-turn egress guard of ONE live item summary (or the D8 lookup summary) while
 * `QUOKY_ITEM_SUMMARY_CONSENT=on`. The runtime builds it from the turn's pre-resolved verdict (the snapshot) and hands it to
 * the work path, which calls {@link SummaryRecipientGuard.admit} SYNCHRONOUSLY immediately before the summary call and again
 * immediately before its one ADR-0104 regeneration, with nothing awaited in between. `admit` re-checks, on the live selection:
 *
 * - the selector's dispatch-time `isStillEligible` (missing: refused, fail closed);
 * - the live {@link recipientVerdict} (the policy's `expectedRecipientKey` and the composition root's label function) has the
 *   same kind, key and label as the snapshot (a selection that flipped, fell back or lost its name is refused);
 * - `unnamed` is never admitted; `unexpected` only through `allowsUnexpected` (the OQ1-3 consent token; absent: refused).
 *
 * The guard remembers whether a REMOTE call was admitted, so the reply can end with the A8.4 recipient line. Data only: keys and
 * labels are compared as opaque strings; Core never names, ranks or branches on a provider. Absent (the flag off): nothing here runs.
 */

/** The phase of the one summary a guard admits: the call, then at most one regeneration (only after the call). */
export type SummaryRecipientPhase = 'call' | 'regeneration';

/** The content-free code a refused re-check leaves on the run (`failRun`) and in the log. */
export const SUMMARY_RECIPIENT_RECHECK_REFUSED = 'SUMMARY_RECIPIENT_RECHECK_REFUSED';

/** The deterministic-reply id of a reply produced because a re-check refused the summary call. */
export const SUMMARY_CONSENT_REFUSED_REPLY_ID = 'summary-consent-refused';

/**
 * Thrown inside the regeneration closure when {@link SummaryRecipientGuard.admit} refuses the regeneration. The document-summary
 * claim check re-throws it (never its claim-notice catch), so the work path fails the run and the reply is the handler's fallback.
 */
export class RecipientRecheckRefused extends Error {
  constructor(readonly phase: SummaryRecipientPhase) {
    super(SUMMARY_RECIPIENT_RECHECK_REFUSED);
    this.name = 'RecipientRecheckRefused';
  }
}

/** The two selector methods the guard reads (the runtime's router; both optional on its type). */
export interface SummaryRecipientSelector {
  isStillEligible?(capability: Capability, context: ProviderSelectionContext, provider: AiProvider): boolean;
  expectedRecipientKey?(capability: Capability, context: ProviderSelectionContext): string | undefined;
}

export interface SummaryRecipientGuardInput {
  readonly capability: Capability;
  /** The selection context the turn resolved the provider with (the work path builds the same one with the same helper). */
  readonly context: ProviderSelectionContext;
  /** The turn's pre-resolved verdict: `local` or `expected` (OQ1-2); `unexpected` only with `allowsUnexpected` (OQ1-3). */
  readonly snapshot: RecipientVerdict;
  readonly selector: SummaryRecipientSelector;
  /** The composition root's display-label function (the same one the rule-① question uses). */
  readonly recipientLabel: (provider: AiProvider) => string | undefined;
  /** OQ1-3: the consent token's judge for an `unexpected` recipient. Absent: an unexpected recipient is never admitted. */
  readonly allowsUnexpected?: (verdict: RecipientVerdict, phase: SummaryRecipientPhase) => boolean;
}

const sameVerdict = (a: RecipientVerdict, b: RecipientVerdict): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'local' || a.kind === 'unnamed') return true;
  const other = b as typeof a;
  return a.key === other.key && a.label === other.label;
};

export class SummaryRecipientGuard {
  private callAdmitted = false;
  private regenerationAdmitted = false;
  private remoteLabel: string | undefined;

  constructor(private readonly input: SummaryRecipientGuardInput) {}

  /** The turn's verdict this guard holds the live selection to. */
  get snapshot(): RecipientVerdict {
    return this.input.snapshot;
  }

  /** Synchronous and total: `true` lets exactly this model request go out; any doubt is `false` and admits nothing. */
  admit(provider: AiProvider, phase: SummaryRecipientPhase): boolean {
    try {
      if (phase === 'call' ? this.callAdmitted : phase !== 'regeneration' || !this.callAdmitted || this.regenerationAdmitted) return false;
      const { capability, context, selector, snapshot } = this.input;
      if (typeof selector.isStillEligible !== 'function' || selector.isStillEligible(capability, context, provider) !== true) return false;
      const expectedKey = typeof selector.expectedRecipientKey === 'function' ? selector.expectedRecipientKey(capability, context) : undefined;
      const live = recipientVerdict(provider, expectedKey, this.input.recipientLabel);
      if (live.kind === 'unnamed' || !sameVerdict(live, snapshot)) return false;
      if (live.kind === 'unexpected' && this.input.allowsUnexpected?.(live, phase) !== true) return false;
      if (phase === 'call') this.callAdmitted = true;
      else this.regenerationAdmitted = true;
      if (live.kind !== 'local') this.remoteLabel = live.label;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The A8.4 recipient line, only after a REMOTE call was admitted (the caller adds it only to a reply of a completed call);
   * `undefined` for a LOCAL call or when nothing was admitted.
   */
  recipientLine(language: 'ko' | 'en'): string | undefined {
    if (this.remoteLabel === undefined) return undefined;
    const line = renderItemSummaryRecipientLine(this.remoteLabel, language);
    return line === '' ? undefined : line;
  }
}

/**
 * The one fixed line added to the handler's fallback when an item summary was not sent because its recipient could not be
 * used here (an unexpected recipient in a channel, without a descriptor or while another owner step is pending, or an unnamed
 * one). It holds no content, ids or provider name.
 */
const NOT_SENT = {
  ko: '받는 쪽을 확인하지 못해 요약을 보내지 않았어요.',
  en: "I couldn't confirm who would summarise this, so nothing was sent.",
} as const;

export function renderItemSummaryNotSentLine(language: 'ko' | 'en'): string {
  return language === 'en' ? NOT_SENT.en : NOT_SENT.ko;
}
