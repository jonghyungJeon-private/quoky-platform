/**
 * The claim check of a document summary (ADR-0104 D1 amendment for summary turns, owner-approved 2026-10-15;
 * ADR-0118 D7/D8).
 *
 * The ADR-0104 internal-action claim guard and the document-summary claim guard decide, unchanged. On a summary they read
 * more forms of the text than on main, so only stricter verdicts are added:
 *  - the reply as written, with links neutralized, and as rendered with every markup stripped (`**merged**`, `_x_`,
 *    `` `x` ``, `~~x~~`, `[x](url)`, `<b>x</b>`, `>` quote markers);
 *  - each of these with wrapped lines joined (`The PR has been\nmerged.` is one sentence);
 *  - quoted text (which the ADR-0104 guard skips as a mention) unwrapped and read as a claim, unless it is an attributed
 *    quote (below);
 *  - a request said to be carried out (`요청대로 처리했어요`, `말씀하신 대로 … 완료`), and a completion with no actor or
 *    for the owner (`The PR got merged.`, `Successfully merged the PR.`, `머지함.`, `끝!`, `For you, all set.`);
 *  - a sentence that names the assistant or the owner and reports a completed act (`이건 제 계정으로 진행했어요`,
 *    `요약 모델이 대신 처리했어요`, `요청하신 건 모두 처리했습니다`, `종형님께 전달 완료`).
 *
 * One narrow exemption, owner-approved with the attribution design: an ATTRIBUTED QUOTE is the document's words, not
 * Quoky's (`시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요`, `메일에서 김철수 님은 '배포했다'고 적었어요`, `According to the
 * sheet, the status is "merged"`). A quoted span is attributed only when all hold, in its own sentence:
 *  - the quote is closed (`'…'`, `"…"`, `“…”`, `‘…’`, `「…」`, `『…』`);
 *  - the sentence names the document as the source, a field of it, or a named person reporting (`시트에는`, `메일에서`,
 *    `표시돼`, `적혀`, `상태는`, `처리 칸에는`, `김철수 님은 … 적었어요`, `according to the sheet`, `the email says`,
 *    `the status is`, `marked as`, `Kim wrote`), and a Korean quote is followed by a citation (`라고`, `로`, `고`, `이고`,
 *    `예요`, a comma, …);
 *  - no assistant marker anywhere in the sentence, the quote included: the first person (with possessive and reflexive
 *    forms), Quoky or a stand-in, an addressee or honorific form (`요청하신`, `님께`, `에게`, `드렸`, `대신`), `you`,
 *    `your`, `for you`, `on your behalf`.
 * An attributed quote is masked for the document guard and stays a mention for the ADR-0104 guard (as on main). Every
 * other quoted span is read as a claim by both guards.
 *
 * Pure, provider-neutral and linear: the text is bounded first ({@link DOCUMENT_SUMMARY_GUARD_MAX_CHARS}); each form is
 * built in one pass and each guard runs a fixed number of times.
 */
import type { GeneralChatReplyPolicy } from './chat-policy/chat-response-policy';
import { guardInternalActionClaims } from './chat-policy/internal-action-claim-guard';
import { INTERNAL_ACTION_DOMAINS, renderInternalActionClaimNotice } from './chat-policy/internal-action-vocabulary';
import {
  containsDocumentActionClaim,
  normalizeForClaimCheck,
  renderDocumentActionClaimWithheld,
} from './document-summary-claim-guard';
import { neutralizeLinks } from './link-neutralizer';
import { renderUntrustedDocumentReplyWithheld, type UntrustedDocumentSource } from './untrusted-document-readout';

/**
 * The longest summary the claim guards read. The delivered summary is shorter (it is clipped for every platform), so a
 * longer reply is withheld before any guard runs: it bounds the guards' work.
 */
export const DOCUMENT_SUMMARY_GUARD_MAX_CHARS = 8000;

/** The verdict on one summary text. `claim` carries the fixed notice that replaces the whole summary. */
export type DocumentSummaryClaimVerdict =
  | { readonly kind: 'clean' }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'claim'; readonly notice: string };

/** A request said to be carried out (`요청대로 처리했어요`, `요청한 대로 완료`, `말씀하신 대로 보냈어요`). Bounded gap. */
const KO_REQUEST_CARRIED_OUT =
  /(?:요청|말씀|부탁|지시|말|얘기)(?:하신|하셨던|한|했던)?\s?대로[^.!?\n]{0,40}?(?:했|하였|됐|되었|완료|처리|드렸|뒀|두었|놨|놓았|마쳤|끝냈)/u;

/**
 * Completions with no actor or with the owner as the beneficiary, which the attribution prompt forbids and main's guards
 * do not read as claims (stricter than main, summary only; each is bounded and linear):
 *  - English `got merged`, a sentence opening with a bare past verb (`Successfully merged the PR.`, `Already did that.`),
 *    `all set`, `on your behalf`, `for you`, `as requested`, `myself` with a past verb;
 *  - Korean noun-verb endings `머지함`, `생성됨`, `처리했음`;
 *  - a bare completion line (`끝!`, `완료.`, `Done!`, `All done.`).
 */
const COMPLETION_CLAIMS: readonly RegExp[] = [
  /\b(?:got|gets|get|getting)\s+(?:[a-z]+\s+)?(?:merged|pushed|committed|created|deleted|removed|posted|filed|sent|forwarded|shared|opened|closed|added|scheduled|updated|uploaded|done|handled)\b/iu,
  /(?:^|[\n.!?]\s*)(?:[-*•>]\s*)?(?:(?:already|successfully|just|also|finally)\s+)?(?:merged|pushed|committed|created|deleted|removed|posted|filed|sent|forwarded|shared|opened|added|scheduled|updated|uploaded|handled|took\s+care|did\s+(?:that|it|this|so)|done\s+(?:that|it|this))\b/iu,
  /\ball\s+set\b|\bon\s+your\s+behalf\b|\bas\s+(?:you\s+)?requested\b|\bper\s+your\s+request\b|\bfor\s+you\b/iu,
  /\b(?:myself|ourselves)\b/iu,
  /(?:머지|병합|푸시|커밋|생성|등록|삭제|추가|전송|발송|게시|처리|완료|공유|수정|반영|적용|작성|업로드|전달)\s?(?:함|했음|됨|되었음|완료함|완료됨)(?![가-힣])/u,
  /(?:^|\n)\s*(?:[-*•>]\s*)?(?:끝|완료|다\s?했어요|다\s?끝났어요|done|all\s+done|finished)\s*[!.~]*\s*(?:$|\n)/imu,
];

// ── markup and wrapped lines ───────────────────────────────────────────────────────────────────────────────────────

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

const BULLET = /^\s*(?:[-*•>]|\d{1,3}[.)])\s+/u;
const HEADING = /^\s*#{1,6}\s|^[^\n]{1,80}:\s*$/u;
/** A line that ends a sentence or a block, so the next line is not its continuation. */
const LINE_COMPLETE = /[.!?。！？:)\]」』]\s*$/u;

/** The text with wrapped lines joined: a line that starts no bullet or heading continues an unfinished previous line. */
export function joinedWrappedLines(text: string): string {
  const out: string[] = [];
  let previous = '';
  for (const line of text.split('\n')) {
    const continues =
      previous.trim() !== '' && line.trim() !== '' && !BULLET.test(line) && !HEADING.test(line) && !HEADING.test(previous) && !LINE_COMPLETE.test(previous);
    if (continues) out[out.length - 1] = `${out[out.length - 1] as string} ${line.trim()}`;
    else out.push(line);
    previous = line;
  }
  return out.join('\n');
}

// ── attributed quotes ──────────────────────────────────────────────────────────────────────────────────────────────

/** A closed quoted span, as the ADR-0104 guard reads quotes (double and typographic quotes, a single-quoted span). */
const QUOTED_SPAN = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|(?<![\p{L}\p{N}])'[^'\n]{1,80}'(?![A-Za-z])/gu;

/** The document as the source, or a record verb (`시트에는`, `메일에서`, `표시돼`, `적혀`, `김철수 님은 … 적었어요`). */
const KO_ATTRIBUTION = new RegExp(
  [
    String.raw`(?:시트|문서|메일|이메일|스레드|표|파일|스프레드시트|탭|열|칸|셀|기록|목록|트래커|본문|제목|상태\s?(?:열|칸|값|란))(?:에는|에서는|에|에서|의|을\s?보면|를\s?보면)(?![\p{L}])`,
    String.raw`표시돼|표시되어|표시됐|기록돼|기록되어|기록됐|적혀|쓰여`,
    // A field of the document naming its quoted value (`상태는 '…'`, `처리 칸에는 '…'`, `비고는 '…'`).
    String.raw`(?<![\p{L}])(?:상태|처리|비고|결과|메모|진행\s?상황|내용|제목|값|항목|담당|우선순위|단계)\s?(?:칸|열|란|값)?(?:은|는|이|가|에는|에서는)(?![\p{L}])`,
    String.raw`(?:님|씨)(?:은|는|이|께서)\s[^.!?\n]{0,120}?(?:적었|썼|말했|밝혔|전했|알렸|적어\s?두었|공지했)`,
  ].join('|'),
  'u',
);
/** A Korean citation right after the closing quote (`'…'라고`, `'…'로 표시돼`, `'…'고 적었어요`, `'…'예요`). */
const KO_CITATION = /^\s?(?:라고|이라고|로|으로|고|라는|이라는|란|이란|라며|이라며|예요|이에요|입니다|이고|이며|이었|였|이라|라|[,，)\]]|$)/u;
const EN_ATTRIBUTION_SOURCE =
  /\baccording\s+to\s+(?:the|this)\s+(?:sheet|spreadsheet|document|doc|email|mail|message|thread|tracker|file|table)\b|\b(?:the|this)\s+(?:sheet|spreadsheet|document|doc|email|mail|message|thread|tracker|file|table|status\s+column)\s+(?:says|said|shows|showed|lists|listed|reads|records|recorded|marks|marked|notes|noted|states|stated)\b|\b(?:marked|listed|recorded|shown|labell?ed)\s+as\b|\bthe\s+(?:status|state|result|note|notes|owner|column|value|field|entry)\s+(?:is|was|reads|says|shows)\b/iu;
/** A named person reporting (`Kim wrote`): the name is capitalized, so this one is case-sensitive. */
const EN_ATTRIBUTION_NAMED = /\b\p{Lu}[\p{L}.'-]{1,30}\s+(?:wrote|writes|says|said|reported|reports|noted|notes|states|stated)\b/u;
const enAttributed = (sentence: string): boolean => EN_ATTRIBUTION_SOURCE.test(sentence) || EN_ATTRIBUTION_NAMED.test(sentence);

/**
 * Assistant markers: the first person (with possessive and reflexive forms), Quoky or a stand-in, an addressee or
 * honorific form, `대신`, a humble benefactive, `you` / `your`. Any one of them in a sentence voids its attributed quotes.
 */
const ASSISTANT_KO = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?:제가|저는|저도|저의|저를|저에게|저한테|저희|내가|나는|나의|우리(?:가|는|도|의|측|쪽)|제\s|내\s|제\s?쪽)`,
    String.raw`quoky|쿼키|퀴키|비서|어시스턴트|챗봇|봇(?![\p{L}])|모델|ai\s?비서|시스템이|시스템가`,
    String.raw`(?:요청|말씀|부탁|지시|원|문의)(?:하신|하셨)`,
    String.raw`님께(?!서)|님에게|에게|한테|드렸|드릴|드립|드림|드리겠|대신|당신|사용자님|회원님|고객님`,
  ].join('|'),
  'iu',
);
/** Latin words end at a non-Latin character, so a glued Korean particle (`Assistant가`) still counts. */
const ASSISTANT_LATIN =
  /(?<![A-Za-z0-9])(?:i|i['’](?:ve|ll|d|m)|we|we['’](?:ve|ll|d|re)|me|us|my|our|ours|mine|myself|ourselves|you|your|yours|yourself|quoky(?:['’]s)?|assistant|bot|chatbot|ai|claude|gpt|chatgpt|gemini|copilot|llm|model)(?![A-Za-z0-9])/iu;

function namesAssistant(sentence: string): boolean {
  return [sentence, normalizeForClaimCheck(sentence, ' ')].some((form) => ASSISTANT_KO.test(form) || ASSISTANT_LATIN.test(form));
}

/** Sentence boundaries (terminal punctuation followed by whitespace, or a line break), as start offsets. */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  for (const end of text.matchAll(/(?<=[.!?。！？])\s+|\n+/gu)) starts.push(end.index + end[0].length);
  return starts;
}

/**
 * The text with each attributed quote masked (`masked`, for the document guard: blanks, like the ADR-0104 guard reads a
 * quote) and every other quote unwrapped (`unwrapped`: the quote marks blanked, the words kept, so both guards read
 * them). Linear: one pass over the spans, each sentence judged once.
 */
export function attributedQuoteForms(text: string): { readonly masked: string; readonly unwrapped: string } {
  const starts = sentenceStarts(text);
  const judged = new Map<number, { readonly attributed: boolean; readonly assistant: boolean }>();
  const sentenceAt = (index: number): { readonly start: number; readonly text: string } => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((starts[middle] as number) <= index) low = middle + 1;
      else high = middle;
    }
    const position = Math.max(0, low - 1);
    const start = starts[position] as number;
    return { start, text: text.slice(start, starts[position + 1] ?? text.length) };
  };
  let masked = '';
  let unwrapped = '';
  let cursor = 0;
  for (const span of text.matchAll(QUOTED_SPAN)) {
    const sentence = sentenceAt(span.index);
    let facts = judged.get(sentence.start);
    if (facts === undefined) {
      facts = {
        attributed: KO_ATTRIBUTION.test(sentence.text) || enAttributed(sentence.text),
        assistant: namesAssistant(sentence.text),
      };
      judged.set(sentence.start, facts);
    }
    const end = span.index + span[0].length;
    const after = text.slice(end, end + 6);
    const korean = /[가-힣]/u.test(sentence.text);
    // A quote may hold sentence ends of its own: the assistant markers are read in the quote itself and in the sentence
    // where it closes as well as where it opens.
    const closing = sentenceAt(Math.max(span.index, end - 1));
    const assistant = facts.assistant || namesAssistant(span[0]) || (closing.start !== sentence.start && namesAssistant(closing.text));
    const attributed = facts.attributed && !assistant && (!korean || KO_CITATION.test(after) || enAttributed(sentence.text));
    const before = text.slice(cursor, span.index);
    const blank = ' '.repeat(span[0].length);
    masked += before + (attributed ? blank : span[0]);
    // The quoted words are read as a sentence of their own (`'제가 등록 완료'로` → `제가 등록 완료.`).
    unwrapped += before + (attributed ? blank : ` ${span[0].slice(1, -1)}. `);
    cursor = span.index + span[0].length;
  }
  masked += text.slice(cursor);
  unwrapped += text.slice(cursor);
  return { masked, unwrapped };
}

/** A completed act: Korean `했`, `됐`, `완료`, `처리`, `드렸`, `진행했`; English past, perfect or passive, `all set`. */
const KO_COMPLETED = /했|하였|됐|되었|되어\s?있|돼\s?있|완료|처리|드렸|뒀|두었|놨|놓았|마쳤|끝냈|끝났|보냈|올렸|만들었|남겼/u;
const EN_COMPLETED =
  /\b[a-z]{2,}ed\b|\b(?:sent|made|done|set|put|took|taken|wrote|written|ran|got|gave|given|did|care|built|kept|left|paid|sold)\b/iu;

/**
 * A sentence that names the assistant or the owner (`제 계정으로`, `요약 모델이 대신`, `요청하신 건`, `종형님께`, `for you`,
 * `myself`) and reports a completed act: Quoky's own act, whatever the domain (stricter than main, summary only).
 */
function assistantCompletion(text: string): boolean {
  const starts = sentenceStarts(text);
  for (let index = 0; index < starts.length; index += 1) {
    const sentence = text.slice(starts[index] as number, starts[index + 1] ?? text.length);
    if ((KO_COMPLETED.test(sentence) || EN_COMPLETED.test(sentence)) && namesAssistant(sentence)) return true;
  }
  return false;
}

// ── the verdict ────────────────────────────────────────────────────────────────────────────────────────────────────

function verdictOnForm(
  form: string,
  currentUserMessage: string,
  source: UntrustedDocumentSource,
  replyPolicy: Pick<GeneralChatReplyPolicy, 'replyLanguage'> | undefined,
): { readonly internal: string } | 'document' | null {
  // Main's ADR-0104 guard, as on main (it skips every quote as a mention).
  const internal = guardInternalActionClaims(form, currentUserMessage, replyPolicy);
  if (internal.guarded) return { internal: internal.text };
  const { masked, unwrapped } = attributedQuoteForms(form);
  // Unattributed quotes read as claims (stricter than main).
  const unquoted = guardInternalActionClaims(unwrapped, currentUserMessage, replyPolicy);
  if (unquoted.guarded) return { internal: unquoted.text };
  // The document guard, with attributed quotes masked (the one exemption) and unattributed quotes unwrapped.
  if (containsDocumentActionClaim(masked, source) || containsDocumentActionClaim(unwrapped, source)) return 'document';
  if (KO_REQUEST_CARRIED_OUT.test(unwrapped) || COMPLETION_CLAIMS.some((pattern) => pattern.test(unwrapped))) return 'document';
  if (assistantCompletion(unwrapped)) return 'document';
  return null;
}

/**
 * The claim verdict on one summary text (a provider's reply, or the exact text delivered to the owner). Main's guards
 * on every form named in the module comment; the notice is the ADR-0104 one when that guard matched, else the document
 * guard's.
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
  const forms = [text, display, stripped, joinedWrappedLines(text), joinedWrappedLines(stripped)];
  const seen = new Set<string>();
  for (const form of forms) {
    if (seen.has(form)) continue;
    seen.add(form);
    const verdict = verdictOnForm(form, currentUserMessage, source, replyPolicy);
    if (verdict === null) continue;
    return { kind: 'claim', notice: verdict === 'document' ? renderDocumentActionClaimWithheld(language, source) : verdict.internal };
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
