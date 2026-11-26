import type { SummaryConsentSourceName } from './summary-consent-question';

/**
 * ADR-0121 amendment A7, slice A7-S4a (A7.5 step 4): the rule-① question of an A7 DRAFT. It is the existing summary question plus
 * the destination clause the draft needs, as a NEW version for the A7 draft consent only: `summary-consent-question.v2` is unchanged
 * for every existing caller (it has no destination and is pinned by its own test).
 *
 * KO: `Slack 메시지 3건을 {remote}에 보내 BE-123 댓글 초안을 만들게요. 보낼까요? (응/아니)`. The question names the item count, the
 * recipient and the destination, so the owner knows what the draft is for. Fixed text built from closed nouns, the count Core
 * recorded, the recipient's display name (provider data, never branched on) and the destination the owner wrote. Pure and total:
 * an invalid input renders `''` (no question).
 */
export const DRAFT_CONSENT_QUESTION_VERSION = 'draft-consent-question.v1';

/** The closed nouns of the A7 sources of the first slices (Slack and Jira), in the brand spelling of the question. */
const NOUN: Readonly<Partial<Record<SummaryConsentSourceName, { readonly ko: string; readonly enOne: string; readonly enMany: string }>>> = Object.freeze({
  jira: { ko: 'Jira 이슈', enOne: 'Jira issue', enMany: 'Jira issues' },
  slack: { ko: 'Slack 메시지', enOne: 'Slack message', enMany: 'Slack messages' },
});

/** The destination as the owner wrote it: an issue key of the A1-D4 grammar (checked, so no free text reaches the question). */
const DESTINATION_KEY = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/;

export interface DraftConsentQuestionInput {
  readonly language: 'ko' | 'en';
  readonly recipient: string;
  readonly source: SummaryConsentSourceName;
  readonly count: number;
  /** The Jira issue key of the destination (the owner's own literal). */
  readonly destination: string;
}

export function renderDraftConsentQuestion(input: DraftConsentQuestionInput): string {
  try {
    const { language, recipient, source, count, destination } = input;
    const noun = NOUN[source];
    if (noun === undefined || (language !== 'ko' && language !== 'en')) return '';
    if (typeof recipient !== 'string' || recipient.trim().length === 0 || /[\r\n]/u.test(recipient)) return '';
    if (!Number.isInteger(count) || count < 1) return '';
    if (typeof destination !== 'string' || !DESTINATION_KEY.test(destination)) return '';
    if (language === 'ko') return `${noun.ko} ${count}건을 ${recipient}에 보내 ${destination} 댓글 초안을 만들게요. 보낼까요? (응/아니)`;
    const one = count === 1;
    return `I'll send ${count} ${one ? noun.enOne : noun.enMany} to ${recipient} to draft a comment for ${destination}. Shall I send ${one ? 'it' : 'them'}? (yes/no)`;
  } catch {
    return '';
  }
}
