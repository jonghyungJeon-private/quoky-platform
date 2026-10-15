/**
 * The claim check of a document summary (ADR-0104 D1 amendment for summary turns, owner-approved 2026-10-15;
 * ADR-0118 D7/D8).
 *
 * Invariant: a verdict is never looser than origin/main for the same text. Main's checks run unchanged on the reply as
 * written — the ADR-0104 internal-action claim guard, and the document-summary claim guard on the raw and the
 * display-neutralized text — and there is no exemption of any kind. Every addition can only flag more:
 *  - main's two guards also read the reply as rendered with every markup stripped (`**merged**`, `_x_`, `` `x` ``,
 *    `~~x~~`, `[x](url)`, `<b>x</b>`, `>` quote markers), and each form with wrapped lines joined
 *    (`The PR has been\nmerged.` is one sentence);
 *  - outside quoted text (the document's own words, which the attribution prompt asks the model to quote), these are
 *    claims, clause by clause, a negated clause excepted:
 *    - a request said to be carried out (`요청대로 처리했어요`, `말씀하신 대로 … 완료`);
 *    - a bare or owner-directed completion (`The PR got merged.`, `Successfully merged the PR.`, `Already did that.`,
 *      `머지함.`, `끝!`, `all set`, `for you`, `on your behalf`, `myself`);
 *    - a completed act next to a self-reference (`이 요약`, `요약본`, `이 답변`, `방금`, `this summary`, `just now`), or
 *      the summary itself sent or posted with no named subject (`상태는 'Slack'에 요약을 게시했어요`);
 *    - a completed act in a clause that names the speaker or addresses the owner (`제가`, `제 계정으로`, `Quoky`,
 *      `요약 모델이`, `요청하신`, `종형님께`, `you`).
 * A reply over {@link DOCUMENT_SUMMARY_GUARD_MAX_CHARS} is withheld before any guard runs.
 *
 * Pure, provider-neutral and linear: quoted text is blanked in one pass (the next closing quote of each kind is
 * precomputed per line, so an unmatched quote costs nothing), clauses are split once, and each guard runs a fixed number
 * of times on the bounded text.
 */
import type { GeneralChatReplyPolicy } from './chat-policy/chat-response-policy';
import { guardInternalActionClaims } from './chat-policy/internal-action-claim-guard';
import { INTERNAL_ACTION_DOMAINS, renderInternalActionClaimNotice } from './chat-policy/internal-action-vocabulary';
import {
  containsDocumentActionClaim,
  normalizeForClaimCheck,
  renderDocumentActionClaimWithheld,
} from './document-summary-claim-guard';
import { joinedWrappedLines } from './document-summary-lines';
import { neutralizeLinks } from './link-neutralizer';
import { renderUntrustedDocumentReplyWithheld, type UntrustedDocumentSource } from './untrusted-document-readout';

export { joinedWrappedLines };

/**
 * The longest summary the claim guards read. The delivered summary is shorter (it is bounded for every platform), so a
 * longer reply is withheld before any guard runs: it bounds the guards' work.
 */
export const DOCUMENT_SUMMARY_GUARD_MAX_CHARS = 8000;

/** The verdict on one summary text. `claim` carries the fixed notice that replaces the whole summary. */
export type DocumentSummaryClaimVerdict =
  | { readonly kind: 'clean' }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'claim'; readonly notice: string };

// ── forms ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The text as any platform may show it: markup removed, link labels kept, struck-through words and `>` markers dropped. */
export function strippedOfMarkup(text: string): string {
  return neutralizeLinks(text, 'display')
    .replace(/\[([^\]\n]{0,200})\]\([^)\n]{0,500}\)/gu, '$1')
    .replace(/<\/?[A-Za-z][A-Za-z0-9]{0,10}(?:\s[^<>\n]{0,200})?\/?>/gu, '')
    // Struck-through words read as deleted (`~~not~~ merged` reads `merged`).
    .replace(/~~[^~\n]{0,200}~~/gu, '')
    .replace(/\*{1,3}|_{1,3}|~~|`+/gu, '')
    .replace(/^[ \t]*(?:>[ \t]?)+/gmu, '');
}

/** Opening quote → its closing quote. A straight quote closes itself. */
const QUOTE_PAIRS: Readonly<Record<string, string>> = { '"': '"', '“': '”', '‘': '’', '「': '」', '『': '』', "'": "'" };
const CLOSERS = [...new Set(Object.values(QUOTE_PAIRS))];
const WORD = /[\p{L}\p{N}]/u;

/**
 * The text with every closed quoted span on a line replaced by blanks (the document's own words are not read by the
 * additions). Linear: per line, the next position of each closing quote is computed once from the right, so every
 * opening quote finds its closer in constant time and an unmatched one is skipped.
 */
export function blankQuoted(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const chars = Array.from(line);
      const next: Record<string, Int32Array> = {};
      for (const closer of CLOSERS) {
        const positions = new Int32Array(chars.length + 1).fill(-1);
        for (let index = chars.length - 1; index >= 0; index -= 1) {
          positions[index] = chars[index] === closer ? index : (positions[index + 1] as number);
        }
        next[closer] = positions;
      }
      let out = '';
      let index = 0;
      while (index < chars.length) {
        const char = chars[index] as string;
        const closer = QUOTE_PAIRS[char];
        const straightSingle = char === "'";
        // A straight single quote opens only after a non-letter (`I've` and `it's` are words, not quotes).
        const opens = closer !== undefined && !(straightSingle && index > 0 && WORD.test(chars[index - 1] as string));
        const end = opens ? ((next[closer] as Int32Array)[index + 1] as number) : -1;
        if (end > index && !(straightSingle && end - index > 81)) {
          out += ' '.repeat(end - index + 1);
          index = end + 1;
          continue;
        }
        out += char;
        index += 1;
      }
      return out;
    })
    .join('\n');
}

// ── the additions (clause by clause, outside quotes) ──────────────────────────────────────────────────────────────

/** Clause boundaries: a sentence end, a line break, `·`, a semicolon or comma, a dash between spaces. */
const CLAUSE_BOUNDARY = /[.!?。！？]+(?=\s|$)|\n+|\s·\s|[;,，]|\s[—–-]\s/gu;
/** A negated clause (`않았`, `안 했`, `못`, `없`, `not`, `never`, `nothing`, `no`): the additions do not read it. */
const NEGATION = /않|안\s|못|없|아니|\b(?:not|never|nothing|no|none)\b|n['’]t\b/iu;

/** A completed act: Korean `했`, `됐`, `완료`, `처리`, `드렸`, …; English past, perfect or passive. */
const KO_COMPLETED = /했|하였|됐|되었|되어\s?있|돼\s?있|완료|처리|드렸|뒀|두었|놨|놓았|마쳤|끝냈|끝났|보냈|올렸|만들었|남겼|게시|전송|발송/u;
const EN_COMPLETED =
  /\b[a-z]{2,}ed\b|\b(?:sent|made|done|set|put|took|taken|wrote|written|ran|got|gave|given|did|built|kept|left|paid|sold|posted)\b/iu;
const completed = (clause: string): boolean => KO_COMPLETED.test(clause) || EN_COMPLETED.test(clause);

/** A request said to be carried out (`요청대로 처리했어요`, `요청한 대로 완료`, `말씀하신 대로 보냈어요`). */
const KO_REQUEST_CARRIED_OUT =
  /(?:요청|말씀|부탁|지시|말|얘기)(?:하신|하셨던|한|했던)?\s?대로[^.!?\n]{0,40}?(?:했|하였|됐|되었|완료|처리|드렸|뒀|두었|놨|놓았|마쳤|끝냈)/u;

/** Bare or owner-directed completions (bounded patterns). */
const COMPLETION_CLAIMS: readonly RegExp[] = [
  /\b(?:got|gets|get|getting)\s+(?:[a-z]+\s+)?(?:merged|pushed|committed|created|deleted|removed|posted|filed|sent|forwarded|shared|opened|closed|added|scheduled|updated|uploaded|done|handled)\b/iu,
  /^\s*(?:[-*•>]\s*)?(?:(?:already|successfully|just|also|finally)\s+)?(?:merged|pushed|committed|created|deleted|removed|posted|filed|sent|forwarded|shared|opened|added|scheduled|updated|uploaded|handled|took\s+care|did\s+(?:that|it|this|so)|done\s+(?:that|it|this))\b/iu,
  /\ball\s+set\b|\bon\s+your\s+behalf\b|\bas\s+(?:you\s+)?requested\b|\bper\s+your\s+request\b|\bfor\s+you\b/iu,
  /\b(?:myself|ourselves)\b/iu,
  /(?:머지|병합|푸시|커밋|생성|등록|삭제|추가|전송|발송|게시|처리|완료|공유|수정|반영|적용|작성|업로드|전달)\s?(?:함|했음|됨|되었음|완료함|완료됨)(?![가-힣])/u,
  /^\s*(?:[-*•>]\s*)?(?:끝|완료|다\s?했어요|다\s?끝났어요|done|all\s+done|finished)\s*[!.~]*\s*$/iu,
];

/** This reply or this moment as the frame of an act (`이 요약`, `요약본`, `이 답변`, `방금`, `this summary`, `just now`). */
const SELF_REFERENCE = /이\s?요약|본\s?요약|요약본|이\s?답변|이\s?메시지|방금|지금\s?막|\bthis\s+(?:summary|reply|message|answer)\b|\bjust\s+now\b/iu;

/**
 * The speaker named, or the owner addressed: the first person (with possessive and reflexive forms), Quoky, a summarizing
 * model or assistant, an honorific addressee (`요청하신`, `종형님께` — not `님께서`, a third party's subject), `you`.
 */
const SPEAKER_KO = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?:제가|저는|저도|저의|저를|저에게|저한테|저희|내가|나는|나의|우리(?:가|는|도|의|측|쪽)|제\s|내\s|제\s?쪽)`,
    String.raw`quoky|쿼키|퀴키|비서|어시스턴트|챗봇|봇(?:이|가|은|는)|요약\s?모델|이\s?모델|ai\s?모델|ai\s?비서`,
    String.raw`(?:요청|말씀|부탁|지시|원|문의)(?:하신|하셨)`,
    String.raw`님께(?!서)|님에게|당신|사용자님|회원님|고객님|드렸|드릴|드립|드림|드리겠|대신`,
  ].join('|'),
  'iu',
);
const SPEAKER_LATIN =
  /(?<![A-Za-z0-9])(?:i|i['’](?:ve|ll|d|m)|we|we['’](?:ve|ll|d|re)|me|us|my|our|ours|mine|you|your|yours|yourself|quoky(?:['’]s)?|assistant|bot|chatbot|claude|gpt|chatgpt|gemini|copilot)(?![A-Za-z0-9])/iu;

/**
 * The summary itself sent or posted (`요약을 게시했어요`, `요약본을 Slack에 보냈어요`) with no named subject in the clause:
 * only Quoky makes this summary. A clause with a subject (`김철수 님이 회의 요약을 보냈어요`) is the document's report.
 */
const SUMMARY_SENT = /요약(?:본)?(?:을|를)\s?(?:[^\s]{1,12}\s){0,2}?(?:게시|전송|발송|보냈|보내|올렸|공유|전달)/u;
const KO_NAMED_SUBJECT = /(?:^|\s)[^\s]{1,20}?(?:께서|님이|이|가)\s/u;

function namesSpeaker(clause: string): boolean {
  return [clause, normalizeForClaimCheck(clause, ' ')].some((form) => SPEAKER_KO.test(form) || SPEAKER_LATIN.test(form));
}

/** The additions, on a quote-blanked form, clause by clause (linear: one split, a fixed set of bounded tests each). */
function additionClaim(blanked: string): boolean {
  let cursor = 0;
  const clauses: string[] = [];
  for (const boundary of blanked.matchAll(CLAUSE_BOUNDARY)) {
    clauses.push(blanked.slice(cursor, boundary.index));
    cursor = boundary.index + boundary[0].length;
  }
  clauses.push(blanked.slice(cursor));
  for (const clause of clauses) {
    if (clause.trim() === '' || NEGATION.test(clause)) continue;
    if (KO_REQUEST_CARRIED_OUT.test(clause) || COMPLETION_CLAIMS.some((pattern) => pattern.test(clause))) return true;
    if (completed(clause) && (SELF_REFERENCE.test(clause) || namesSpeaker(clause))) return true;
    if (completed(clause) && SUMMARY_SENT.test(clause) && !KO_NAMED_SUBJECT.test(clause)) return true;
  }
  return false;
}

// ── the verdict ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The claim verdict on one summary text (a provider's draft, or the exact text delivered to the owner). The notice is the
 * ADR-0104 one when that guard matched, else the document guard's.
 */
export function checkDocumentSummaryClaims(
  text: string,
  currentUserMessage: string,
  source: UntrustedDocumentSource,
  language: 'ko' | 'en',
  replyPolicy?: Pick<GeneralChatReplyPolicy, 'replyLanguage'>,
): DocumentSummaryClaimVerdict {
  if (typeof text !== 'string') return { kind: 'claim', notice: renderDocumentActionClaimWithheld(language, source) };
  if (text.length > DOCUMENT_SUMMARY_GUARD_MAX_CHARS) return { kind: 'too-long' };
  const display = neutralizeLinks(text, 'display');
  const stripped = strippedOfMarkup(text);
  // Main's checks first, exactly as on main (raw text; the document guard also on the display form).
  const forms = [text, display, stripped, joinedWrappedLines(text), joinedWrappedLines(stripped)];
  for (const form of forms) {
    const internal = guardInternalActionClaims(form, currentUserMessage, replyPolicy);
    if (internal.guarded) return { kind: 'claim', notice: internal.text };
  }
  for (const form of forms) {
    if (containsDocumentActionClaim(form, source)) return { kind: 'claim', notice: renderDocumentActionClaimWithheld(language, source) };
  }
  for (const form of [text, joinedWrappedLines(stripped)]) {
    if (additionClaim(blankQuoted(form))) return { kind: 'claim', notice: renderDocumentActionClaimWithheld(language, source) };
  }
  return { kind: 'clean' };
}

/** The fixed reply when a summary is longer than the guards read (never shown, never stored). */
export function renderDocumentSummaryTooLong(language: 'ko' | 'en'): string {
  return language === 'en'
    ? 'The summary was too long to check safely, so it was not shown.'
    : '요약이 너무 길어 안전하게 확인할 수 없어서 보여 드리지 않았어요.';
}

/**
 * Whether a summary turn's reply text is exactly one of the fixed notices that replace a summary (Quoky copy, never
 * item text): the delivered-text check accepts it as written, so a truthful notice (`Quoky는 메일을 읽기만 했고 …`) is
 * never read as a claim.
 */
export function isFixedDocumentSummaryNotice(text: string, source: UntrustedDocumentSource): boolean {
  for (const language of ['ko', 'en'] as const) {
    if (text === renderDocumentActionClaimWithheld(language, source)) return true;
    if (text === renderDocumentSummaryTooLong(language) || text === renderUntrustedDocumentReplyWithheld(language)) return true;
    if (INTERNAL_ACTION_DOMAINS.some((domain) => text === renderInternalActionClaimNotice(domain, language))) return true;
  }
  return false;
}
