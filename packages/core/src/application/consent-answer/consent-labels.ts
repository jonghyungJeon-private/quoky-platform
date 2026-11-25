import type { AiExecutionLocality } from '../../ports/ai-provider.port';
import { AGENT_WORK_SUMMARY_SOURCES } from '../agent/flow-policy';

/**
 * ADR-0121 A6: the closed vocabulary shared by the answer pipeline (`consent-answer.ts`), the pending steps
 * (`consent-pending.ts`) and the classifier (`consent-classifier.ts`), kept apart so none of them imports another in a cycle.
 */

/** The classifier's closed labels (A6.3 step 3 as amended by AM-2). */
export const CONSENT_ANSWER_LABELS = ['yes', 'yes-and-more', 'no', 'other', 'unclear'] as const;
export type ConsentAnswerLabel = (typeof CONSENT_ANSWER_LABELS)[number];

/**
 * The source nouns a rule-① summary consent may name (A6.4: the source noun is a closed Core label). Exactly the Core sources
 * whose content a summary can be granted for (`REMOTE_ON_SUMMARY_REQUEST`: mail, Drive; the five work sources, A5-S3). Anything
 * else is refused when the pending step is minted, so no free text reaches the classifier question.
 */
export const CONSENT_SOURCES = ['mail', 'drive', ...AGENT_WORK_SUMMARY_SOURCES] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export function isConsentSource(value: unknown): value is ConsentSource {
  return typeof value === 'string' && (CONSENT_SOURCES as readonly string[]).includes(value);
}

/** The content-free classifier request (A6.4): never an item, a topic, a count, a source content or the history. */
export interface ConsentClassifierRequest {
  /** The fixed question text with the item count / topic as placeholders (A6-S2, `buildConsentClassifierRequest`). */
  readonly question: string;
  readonly reply: string;
}

/** The port-level facts of the provider this turn's chat would reach (the same two facts `nlSameEgress` reads); no platform or provider type. */
export interface ConsentChatFacts {
  readonly id: string;
  readonly locality: AiExecutionLocality;
}

/**
 * What the pipeline hands one classifier call besides the content-free request (A6 classifier wiring): the turn's chat facts (the
 * no-new-egress rule) and the cap charge the adapter makes immediately before the provider is actually called (`false`: no call).
 */
export interface ConsentClassifierContext {
  readonly chat?: ConsentChatFacts;
  readonly charge?: () => boolean;
}
