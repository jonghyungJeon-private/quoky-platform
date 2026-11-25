import { AGENT_WORK_SUMMARY_SOURCES, type AgentWorkSummarySource } from './flow-policy';

/**
 * ADR-0121 rule ① confirm slice, CS-1a: the owner-facing question of a remote summary ("Before EVERY remote summary", SR-1
 * rule ①). Fixed reply text built from closed Core nouns, the item counts Core recorded and the recipient's display name
 * (provider data, never branched on); it is not prompt text, so no D12 gate.
 *
 * One template serves two readers (A6.4): the owner sees it with the real counts, and the A6-S2 consent classifier sees the same
 * template with every count replaced by a fixed placeholder ({@link renderSummaryConsentQuestion} with `countPlaceholder`;
 * `consentClassifierQuestion` renders it through this function, so the classifier judges exactly the question the owner read).
 * Pure and total: an invalid input renders `''` (no question).
 */

/** The sources a rule-① question may name: exactly the consent sources (mail, Drive and the five A5 work sources). */
export type SummaryConsentSourceName = 'mail' | 'drive' | AgentWorkSummarySource;

export const SUMMARY_CONSENT_SOURCE_NAMES: readonly SummaryConsentSourceName[] = Object.freeze(['mail', 'drive', ...AGENT_WORK_SUMMARY_SOURCES] as const);

export interface SummaryConsentQuestionInput {
  readonly language: 'ko' | 'en';
  /** The recipient's display name, from `QuarantinedSummarizerRoute.recipientLabel` (provider data). */
  readonly recipient: string;
  /** In the order given (callers pass the plan order of the covered reads, a source at its first read); one part each. `count` is the number of item ids recorded. */
  readonly sources: readonly { readonly source: SummaryConsentSourceName; readonly count: number }[];
}

/**
 * Names the bytes of the question template (both languages, the noun table, the joins and the placeholders). Any wording change,
 * however small, bumps it. The A6-S4 plan digest binds it with the classifier prompt version (a6-12), so a reworded question can
 * never be judged by a digest made for the old one.
 */
export const SUMMARY_CONSENT_QUESTION_VERSION = 'summary-consent-question.v1';

/** The KO placeholder for an item count (the A6.4 classifier template). */
export const SUMMARY_CONSENT_KO_COUNT_PLACEHOLDER = '{개수}';
/** The EN placeholder for an item count. */
export const SUMMARY_CONSENT_EN_COUNT_PLACEHOLDER = '{count}';

/** The closed noun table; the EN singular is used for exactly one item. */
const NOUN: Readonly<Record<SummaryConsentSourceName, { readonly ko: string; readonly enOne: string; readonly enMany: string }>> = Object.freeze({
  mail: { ko: '메일', enOne: 'mail', enMany: 'mails' },
  drive: { ko: '드라이브 파일', enOne: 'Drive file', enMany: 'Drive files' },
  calendar: { ko: '캘린더 일정', enOne: 'Calendar event', enMany: 'Calendar events' },
  jira: { ko: '지라 이슈', enOne: 'Jira issue', enMany: 'Jira issues' },
  slack: { ko: '슬랙 메시지', enOne: 'Slack message', enMany: 'Slack messages' },
  confluence: { ko: '컨플루언스 문서', enOne: 'Confluence page', enMany: 'Confluence pages' },
  github: { ko: '깃허브 항목', enOne: 'GitHub item', enMany: 'GitHub items' },
});

const isSource = (value: unknown): value is SummaryConsentSourceName => typeof value === 'string' && (SUMMARY_CONSENT_SOURCE_NAMES as readonly string[]).includes(value);

/**
 * KO: `{noun} {n}건을 {remote}에 보내 요약할게요. 보낼까요? (응/아니)`; several sources join their parts with `과` (every part ends
 * in `건`). EN: `I'll send {n} {noun} to {remote} to summarise them. Shall I send them? (yes/no)`; parts join with `, ` and a final
 * ` and `; `it` and the singular noun for exactly one item. `countPlaceholder` writes every count as a fixed placeholder (EN in
 * the plural form), for the classifier.
 */
export function renderSummaryConsentQuestion(input: SummaryConsentQuestionInput, options: { readonly countPlaceholder?: boolean } = {}): string {
  try {
    const { language, recipient } = input;
    const sources: readonly SummaryConsentQuestionInput['sources'][number][] = input.sources;
    if ((language !== 'ko' && language !== 'en') || typeof recipient !== 'string' || recipient.trim().length === 0) return '';
    if (!Array.isArray(input.sources) || sources.length === 0) return '';
    const placeholder = options.countPlaceholder === true;
    const seen = new Set<string>();
    for (const part of sources) {
      const source: unknown = part?.source;
      if (!isSource(source) || seen.has(source)) return '';
      seen.add(source);
      if (!placeholder && (!Number.isInteger(part.count) || part.count < 1)) return '';
    }
    const total = placeholder ? 0 : sources.reduce((sum, part) => sum + part.count, 0);
    if (language === 'ko') {
      const parts = sources.map((part) => `${NOUN[part.source].ko} ${placeholder ? SUMMARY_CONSENT_KO_COUNT_PLACEHOLDER : String(part.count)}건`);
      return `${parts.join('과 ')}을 ${recipient}에 보내 요약할게요. 보낼까요? (응/아니)`;
    }
    const one = !placeholder && total === 1;
    const parts = sources.map((part) => {
      const noun = NOUN[part.source];
      return `${placeholder ? SUMMARY_CONSENT_EN_COUNT_PLACEHOLDER : String(part.count)} ${!placeholder && part.count === 1 ? noun.enOne : noun.enMany}`;
    });
    const list = parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
    return `I'll send ${list} to ${recipient} to summarise ${one ? 'it' : 'them'}. Shall I send ${one ? 'it' : 'them'}? (yes/no)`;
  } catch {
    return '';
  }
}
