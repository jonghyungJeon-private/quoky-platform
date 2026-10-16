import { APPROVAL_DECISION_PHRASES } from './approval-decision';
import { connectorWriteLabel } from './connector-writes/connector-write-copy';
import { EXECUTION_PHRASES } from './execution-command-guard';
import { DEICTIC_APPROVE_TOKENS, DEICTIC_DENY_TOKENS } from './nl-routing/deictic-draft-reply';
import { CONNECTOR_WRITE_OPERATIONS } from '../ports/connector-write.port';

/**
 * ADR-0120 amendment A6 R2, owner decision D11 (proposal §3.3 item 4): the card-spoof check on a Jira / Slack summary.
 * Deterministic and structural. A summary line that, after normalisation, EQUALS a phrase Quoky's own approval and
 * execution matchers accept, or BEGINS WITH one of Quoky's card header markers, replaces the whole summary with a fixed
 * notice: hostile content can never put a look-alike "승인" or a fake approval card in front of the owner.
 *
 * The closed set is derived from the matchers' own vocabularies, never listed by hand: the approve / deny / cancel
 * phrases (`approval-decision.ts`), the R5a draft approve / deny tokens, every execution phrase of every gate (with the
 * optional leading 지금 / 이제 / now and trailing now / please the gate accepts), the 되돌리기 / 에이전트 중지 / 에이전트
 * 재개 control phrases, and the card header markers of the connector-write previews ("<write> 미리보기", "<write> 승인을
 * 기다리고", "위험도:", "남은 시간:").
 *
 * Normalisation of a line (and of every set member): NFKC; every format or default-ignorable character removed
 * (`\p{Cf}`, variation selectors, zero-width, bidi, tag characters); markdown stripped (a leading `>`, list marker or
 * heading `#`); every punctuation and symbol character and all whitespace removed; case-folded. A sentence that merely
 * contains a phrase ("승인 절차는 다음 주에 논의") is not equal to it and passes. `full` mode never filters (the owner reads
 * the raw text inside an untrusted span; an approval needs a pending card and a separate owner turn anyway).
 */

const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;
const LEADING_MARKUP = /^(?:\s*(?:>+|#{1,6}|[-*+•·]|\d{1,3}[.)]|\(\d{1,3}\)|[①-⑳]))+\s*/u;
const PUNCTUATION_SYMBOL_SPACE = /[\p{P}\p{S}\p{Z}\s]+/gu;

/** One line in the comparison form. Pure. */
export function normalizeCardSpoofLine(line: string): string {
  let text = line.normalize('NFKC');
  for (let round = 0; round < 3; round += 1) {
    const next = text.replace(INVISIBLE, '').normalize('NFKC');
    if (next === text) break;
    text = next;
  }
  // Markdown emphasis, strike, backticks and link brackets are punctuation or symbols and go in the last step; a
  // leading quote, heading or list marker is removed first so "1. 승인" and "> 승인" compare as "승인".
  text = text.replace(LEADING_MARKUP, '');
  return text.replace(PUNCTUATION_SYMBOL_SPACE, '').toLowerCase();
}

const OPTIONAL_PREFIXES = ['', '지금 ', '이제 ', 'now '];
const OPTIONAL_SUFFIXES = ['', ' now', ' please'];

function executionForms(): string[] {
  return Object.values(EXECUTION_PHRASES).flatMap((phrases) =>
    phrases.flatMap((phrase) => OPTIONAL_PREFIXES.flatMap((prefix) => OPTIONAL_SUFFIXES.map((suffix) => `${prefix}${phrase}${suffix}`))),
  );
}

let phrases: ReadonlySet<string> | undefined;
let headers: readonly string[] | undefined;

/** The normalised closed set (built on first use). */
export function cardSpoofPhrases(): ReadonlySet<string> {
  phrases ??= new Set(
    [...APPROVAL_DECISION_PHRASES, ...DEICTIC_APPROVE_TOKENS, ...DEICTIC_DENY_TOKENS, ...executionForms(), '되돌리기', '에이전트 중지', '에이전트 재개']
      .map(normalizeCardSpoofLine)
      .filter((phrase) => phrase.length > 0),
  );
  return phrases;
}

/** The normalised card header markers (a line that begins with one is a card look-alike). */
export function cardSpoofHeaders(): readonly string[] {
  headers ??= [
    ...CONNECTOR_WRITE_OPERATIONS.flatMap((operation) => [`${connectorWriteLabel(operation)} 미리보기`, `${connectorWriteLabel(operation)} 승인을 기다리고`, `${connectorWriteLabel(operation)} 승인을 기록했어요`]),
    '위험도: CRITICAL',
    '남은 시간:',
  ]
    .map(normalizeCardSpoofLine)
    .filter((marker) => marker.length > 0);
  return headers;
}

/** Whether one line is a card spoof (equal to a phrase, or beginning with a card header marker). Pure. */
export function isCardSpoofLine(line: string): boolean {
  const normalized = normalizeCardSpoofLine(line);
  if (normalized.length === 0) return false;
  if (cardSpoofPhrases().has(normalized)) return true;
  return cardSpoofHeaders().some((marker) => normalized.startsWith(marker));
}

/** Whether any line of a summary is a card spoof. Pure. */
export function containsCardSpoofLine(text: string): boolean {
  return text.split(/\r\n|[\n\r\u2028\u2029]/u).some(isCardSpoofLine);
}

/** The fixed notice that replaces a summary with a card-spoof line (proposal §3.3). */
export function renderCardSpoofNotice(language: 'ko' | 'en'): string {
  return language === 'en'
    ? "The summary contained something that looks like a confirmation phrase, so I did not show it. Say 'show the original' to read it yourself."
    : "요약에 확인 문구처럼 보이는 내용이 있어 보여드리지 않아요. '원문 보여줘'로 직접 확인해 주세요.";
}
