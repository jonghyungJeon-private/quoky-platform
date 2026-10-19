import type { IsoTimestamp } from '../../domain';
import { containsCredentialMaterial } from '../credential-guard';
import {
  isNlActionEntryId,
  isNlCatalogEntryId,
  type NlAmbiguityKey,
  type NlArgs,
  type NlArgSpec,
  type NlArgValue,
  type NlCatalogEntry,
  type NlCatalogEntryId,
} from './catalog';
import {
  formatNlRef,
  isNlDeicticOnlyPayload,
  NL_ACTION_CANONICAL_WORDS,
  NL_ACTION_ENTRIES,
  NL_ACTION_LOANWORDS,
  NL_ACTION_VERBAL_NOUNS,
  NL_ACTION_WORDS,
  NL_CONTENT_WORDS,
  containsNlTimeExpression,
  nlNamesPeriod,
  NL_ENTRY_NOUN_LOANWORDS,
  NL_ENTRY_NOUN_VERBS,
  NL_ENTRY_NOUNS,
  NL_MODE_FULL_WORDS,
  NL_MODE_SUMMARY_WORDS,
  NL_RECENCY_WORDS,
  nlFrameExpressesAction,
  nlHasLastWord,
  withoutSpan,
  withoutStructures,
  isNlRefGrounded,
  isNlSpanGrounded,
  nlActionSourceOf,
  nlNamedItemSources,
  nlR2SourcesOffered,
  normalizeNlSpan,
  parseNlRef,
} from './action-entries';
import { NL_FENCED_PLACEHOLDER, NL_QUOTED_PLACEHOLDER, isGroundedIn, normalizeForMatch } from './selection-input';
import type { NlSelectionCandidate } from './selection-output';
import { nlFrameIsElliptical, nlHasExclusionOrNegation, nlHasUnnegatedMention, nlIsRequestForm, nlLabelTailVeto, nlRelaysRequest, nlRequestEndsBefore, nlRequestsSomething, nlRequestVeto, type NlRequestVeto } from './request-shape';
import { nlFrameHasActionInflection, nlGarbledActionWord, nlGarbledEntryNoun, type NlActionVocabulary, type NlGarbledEntryNoun } from './garbled-action';
import {
  isNlRangeSymbol,
  isNlTimeWord,
  isWeekdayOrTimeKeyword,
  nlCanonicalWeekdaySymbol,
  nlRangeKeepsWeekday,
  nlKeywordIsTitle,
  nlSingleWeekday,
  nlMultiWeekdayBound,
  nlUntilBound,
  nlUntilSymbolWeekday,
  nlWeekdayMentions,
  normalizeNlRangeSymbol,
  resolveNlRange,
  type NlResolvedRange,
  type NlWeekdayMention,
} from './symbolic-time';
import { canonicalNlKeyword } from './keyword-canonical';
import { parseReminderWhen } from '../reminders/reminder-grammar';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

export { canonicalNlKeyword } from './keyword-canonical';

/**
 * Deterministic validation of a selector candidate (ADR-0120 D4, the ADR-0090 L2 policy), in order:
 *  (1) closed ids and the argument schema (unknown args rejected, closed values only);
 *  (2) the entry is offered in this turn's catalog (registered and configured) and is a READ entry (D5);
 *  (3) bounds: limit 1..10, keyword 1..100 characters;
 *  (4) a range is a symbol Core resolves with the turn's clock and `QUOKY_TIMEZONE` (at most 31 days), and keeps the one
 *      weekday the owner's words name (A5 implementation note 2: "다음 주 수" is never next Monday nor the whole week);
 *      an `until-*` period is grounded by the owner's inclusive end bound on that weekday, and a period holding such a
 *      bounded day without ending on it is spelled as the `until-*` symbol ending on that day (A7);
 *  (5) grounding: a keyword appears verbatim in the owner's non-quoted text or in the previous selection's args, and an
 *      entry with a `range` never takes a time expression as a keyword; a grounded flag / enum value needs an owner word;
 *  (6) the credential guard runs on every string arg.
 * ADR-0120 amendment A6 adds, only when the context allows action entries (`actions`):
 *  - step (2) accepts an offered `ITEM_READ`, `LOCAL_WRITE` or `EXTERNAL_WRITE` entry;
 *  - a `span` is the owner's words verbatim from THIS turn's grounding text (never the previous selection, never a
 *    placeholder), not made only of deictic, ordinal or time words, and credential-guarded (A6-D3 payload rules);
 *  - a `ref` is a closed form grounded by a numeral, ordinal or deictic in the owner's words (A6-D2);
 *  - the entry's own check (exactly one target, a time word in a title, the whole-message time check, bulk requests).
 * A failure names the reason and the argument, never a value. Pure: `now` is an input.
 */

export const NL_LIMIT_MIN = 1;
export const NL_LIMIT_MAX = 10;
export const NL_KEYWORD_MAX_CHARS = 100;

export type NlValidationFailureReason =
  | 'unknown-entry'
  | 'not-offered'
  | 'not-read'
  | 'unknown-arg'
  | 'invalid-arg'
  | 'missing-arg'
  | 'range'
  | 'ungrounded'
  /** A keyword that is only a time expression ("목요일", "내일 오후"): a period belongs in `range` / `partOfDay`. */
  | 'time-keyword'
  /**
   * The period drops or changes the one weekday the owner named ("다음 주 수" read as next Monday or the whole week). Like
   * `time-keyword`, never repaired by dropping the range: the owner is asked.
   */
  | 'weekday'
  | 'credential'
  /** A6-D3: a payload span made only of deictic, ordinal or time words ("그거", "첫 번째 거"). */
  | 'deictic-payload'
  /** A6-D1: a to-do title with a time expression (to-do or reminder?). */
  | 'time-in-title'
  /** A6-D1: a reminder message with a time expression outside `when`. */
  | 'time-outside-when'
  /** A6-D1: one action per message ("다 완료해줘"). */
  | 'bulk'
  /**
   * A6-D3a amendment 1: the owner's own sentence is not a request (a question, a negation, a retraction, reported speech, a
   * hypothetical, a past statement or first-person volition); `arg` names the class ({@link NlRequestVeto}). The turn is chat.
   */
  | 'not-request'
  /**
   * A6-D3a amendment 1, garbled action word addendum (owner decision 2026-10-16): a word in the action word's slot is one
   * jamo (Latin: one letter) away from an action word without being it or a form of it ("3번 완룐 처리해줘"). The owner is
   * asked, offered `candidate`; nothing is written.
   */
  | 'garbled-action'
  /**
   * Owner decision (b) of 2026-10-19: the noun that decides which list a to-do / reminder write touches is garbled ("리마이너
   * 걸어줘": `candidate` is the catalog noun it is near) or an unknown word in that noun's slot (`unknownWord`, the owner's
   * own word, rendered back only in the question and never logged), and no correct list noun is present. Nothing is written.
   */
  | 'garbled-noun'
  /**
   * CA / Codex P2 (2026-10-19): a bare "<title> 할 일" whose title may not be a task (one bare or owner noun, or a last word
   * that looks adnominal without a noun phrase before it): Core asks whether to add it; nothing is written.
   */
  | 'uncertain-title'
  /**
   * A6-D3a amendment 1, elliptical continuation (D12 gate v44 run 3, "이번엔 3번"): a target entry's frame names no action
   * word and makes no request of its own (`nlFrameIsElliptical`). The action is only inferred, so nothing is written: the
   * caller asks a confirmation of the inferred action ("할 일 3번도 완료할까요?") or, with nothing to infer it from, the turn
   * is chat.
   */
  | 'elliptical';

export interface NlValidatedSelection {
  readonly entry: NlCatalogEntry;
  /** Canonical: closed values, defaults omitted (except an open ambiguity's own arg, which is absent by definition). */
  readonly args: NlArgs;
  readonly range?: NlResolvedRange;
  /** An interpretation key whose arg the owner did not state (ADR-0120 D7). */
  readonly openAmbiguity?: NlAmbiguityKey;
}

export type NlValidationResult =
  | { readonly ok: true; readonly value: NlValidatedSelection }
  | {
      readonly ok: false;
      readonly reason: NlValidationFailureReason;
      readonly entryId?: NlCatalogEntryId;
      /** The failing argument's name (never its value). */
      readonly arg?: string;
      /** ADR-0120 A8: the entry whose usage question the clarification uses instead (an entry check's hint). */
      readonly askEntryId?: NlCatalogEntryId;
      /** `garbled-action`: the canonical action word of the entry whose vocabulary holds the near word (never the owner's text). */
      readonly candidate?: string;
      /** `garbled-noun` (unknown): the owner's own word in the list noun's slot; rendered in the question only, never logged. */
      readonly unknownWord?: string;
    };

export interface NlValidationContext {
  /** The entries offered this turn (registered and configured). */
  readonly offered: ReadonlyMap<string, NlCatalogEntry>;
  /** The owner's non-quoted text (`prepareSelectionInput().groundingText`). */
  readonly groundingText: string;
  /** The previous selection's args (structure only), which may also ground a keyword (a refinement). */
  readonly previousArgs?: NlArgs;
  readonly now: IsoTimestamp;
  readonly timeZone: string;
  /**
   * ADR-0120 amendment A6: action entries may validate (the flag allows them and they are offered). Absent or false:
   * step (2) refuses every entry that is not `READ`, exactly as before A6.
   */
  readonly actions?: boolean;
  /**
   * A6-D3a amendment 1, the R5a seam: strips the caller's own phrases (an origin phrase such as "내가 말한 거") from the
   * owner's prose before the request-shape vetoes read it. Spans are still grounded in the whole prose.
   */
  readonly requestFrame?: (prose: string) => string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The content spans of a LOCAL_WRITE: the owner's content, never the request around it (a `when` stays in the frame). */
const CONTENT_SPAN_ARGS = ['title', 'body', 'match'] as const;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [["'", "'"], ['"', '"'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']];
/** A dative recipient ("친구한테", "팀장님께"): something is given to someone, never Quoky's own undo. */
const DATIVE = /(?:한테|에게|께)(?=$|\s|[.,!?~])/u;

/**
 * A quote character without its pair inside a span ("우유' 사기 추가하지 마" runs past a closing quote). An apostrophe
 * between letters ("Kim's") is not a quote.
 */
export function nlSpanHasUnbalancedQuote(span: string): boolean {
  const text = span.replace(/(?<=\p{L})['’](?=\p{L})/gu, '');
  return QUOTE_PAIRS.some(([open, close]) => {
    const opens = text.split(open).length - 1;
    if (open === close) return opens % 2 !== 0;
    return opens !== text.split(close).length - 1;
  });
}

/**
 * Whether the owner's prose fully encloses the span as content: a matching quote pair right around it, or a colon form
 * ("할 일 추가: …", "알림: …") whose span runs to the end of the message.
 */
function spanEnclosure(prose: string, span: string): 'quote' | 'colon' | 'after-request' | undefined {
  const at = prose.indexOf(span);
  if (at < 0) return undefined;
  const before = prose.slice(0, at).replace(/\s+$/u, '');
  const after = prose.slice(at + span.length);
  const opened = before.at(-1);
  const closed = after.replace(/^\s+/u, '').at(0);
  if (QUOTE_PAIRS.some(([open, close]) => opened === open && closed === close)) return 'quote';
  const toEnd = /^[\s.!?~^ㅋㅎ]*$/u.test(after);
  if (/[:：]$/u.test(before) && toEnd) return 'colon';
  // Content that ends the message after the request verb ("할 일 추가해줘 운동 끝나고 샤워하기", "remind me at 5pm to
  // stretch after lunch"): the request is already said, the rest is the content (CA round 3).
  return toEnd && nlRequestEndsBefore(before, NL_ACTION_WORDS) ? 'after-request' : undefined;
}

/** The list nouns of the to-do and reminder lists, spaceless and without hyphens ("할일", "todo", "알림", "리마인더"). */
const LIST_LABELS: readonly string[] = NL_ENTRY_NOUNS.flatMap((list) => list.words).map((word) => normalizeForMatch(word).replace(/[\s-]+/gu, ''));
const TODO_LIST_LABELS: ReadonlySet<string> = new Set(NL_ENTRY_NOUNS.filter((list) => list.owner === 'todo').flatMap((list) => list.words).map((word) => normalizeForMatch(word).replace(/[\s-]+/gu, '')));
/** The action nouns a list label may carry ("알림 설정:", "todo 추가:"): the verbal nouns and the list-noun verbs. */
const LABEL_ACTION_NOUNS: ReadonlySet<string> = new Set([...NL_ACTION_VERBAL_NOUNS, ...NL_ENTRY_NOUN_VERBS].map((word) => normalizeForMatch(word)));
/** A second `key:` inside a colon-enclosed span (a pasted record: "…, 담당: 김대리"); a clock "9:30" has no space after. */
const KEY_INSIDE_SPAN = /(?:^|[\s,;·|/])[^\s:：,;]+[:：](?=\s|$)/u;

/** CA P1 (2026-10-19): the whole message stands inside one quote pair: quoted speech, never the owner's command. */
function wholeMessageQuoted(prose: string): boolean {
  const text = prose.trim().replace(/[.!?~]+$/u, '');
  return text.length > 2 && QUOTE_PAIRS.some(([open, close]) => text.startsWith(open) && text.endsWith(close) && !text.slice(1, -1).includes(close));
}

/**
 * CA P1 (2026-10-19): whether the message's colon label (the first colon followed by a space, with content spans after it)
 * is pasted material rather than the owner's command label. A second `key:` after it always is. A label that is itself a
 * request ("할 일에 추가해줘: …", "can you add a todo for me: …") keeps today's after-request reading. Otherwise the label must OPEN the message: after leading time words only, it is
 * a list noun of the to-do or reminder list, optionally with one action noun ("할 일:", "알림 설정:", "To-do:", "10월 23일
 * 오후 6시 알림:"); "회의록 중 할 일:" or "회의록 붙여넣기 할 일:" are lines of something pasted.
 */
function colonLabelIsPasted(prose: string, content: readonly string[], clock: { readonly now: IsoTimestamp; readonly timeZone: string }): boolean {
  const colon = /[:：](?=\s|$)/u.exec(prose);
  if (colon === null) return false;
  const after = prose.slice(colon.index + 1);
  // Only a label whose content follows it: a colon inside the content itself is the content's.
  if (!content.some((span) => prose.indexOf(span) > colon.index)) return false;
  const label = prose.slice(0, colon.index).trim();
  const tokens = label.split(/\s+/u).filter((token) => token.length > 0);
  // Codex P2: an explicit command or request label first ("할 일 추가해줘: 회의: 안건 정리" keeps its titled colon); the
  // second-key rule applies to bare labels only.
  // Explicit: a Korean request form ("추가해줘") or an English request ("add a todo for me", "remind me"); a nominal action
  // word ("붙여넣기", "todo 추가") is a label, not an explicit request, and still meets the second-key rule.
  const explicit = tokens.some((token) => nlIsRequestForm(token)) || (!/[가-힣]/u.test(label) && nlRequestsSomething(label, NL_ACTION_WORDS));
  if (explicit) return false;
  if (KEY_INSIDE_SPAN.test(after)) return true;
  if (nlRequestsSomething(label, NL_ACTION_WORDS)) return false;
  const first = timePrefixLength(tokens, clock);
  const spaceless = normalizeForMatch(tokens.slice(first).join(' ')).replace(/[\s-]+/gu, '');
  return !LIST_LABELS.some((noun) => spaceless === noun || (spaceless.startsWith(noun) && LABEL_ACTION_NOUNS.has(spaceless.slice(noun.length))));
}

/** The reminder grammar's answers that still mean "this is a time" (a time it will not schedule from here, not a non-time). */
const TIME_CLARIFY_REASONS: ReadonlySet<string> = new Set(['PAST_TIME', 'TOO_SOON', 'TOO_FAR', 'INVALID_DATE', 'INVALID_TIME', 'NONEXISTENT_TIME']);

/**
 * Codex P2 (2026-10-19): how many leading tokens form a time, read by the reminder grammar itself (`parseReminderWhen`, the
 * same parser a reminder's `when` uses: "내일 오전 9시 반", "오후 3시 15분", "10월 22일 오후 3시"), the longest prefix first;
 * a day word alone ("내일 알림: …"), which the grammar reads as a time without a clock, falls back to the time-word class.
 */
function timePrefixLength(tokens: readonly string[], clock: { readonly now: IsoTimestamp; readonly timeZone: string }): number {
  for (let length = Math.min(tokens.length, 8); length > 0; length -= 1) {
    const when = parseReminderWhen(tokens.slice(0, length).join(' '), clock);
    if (when.kind !== 'clarify' || TIME_CLARIFY_REASONS.has(when.reason)) return length;
  }
  let first = 0;
  while (first < tokens.length && isNlTimeWord(tokens[first] as string)) first += 1;
  return first;
}

/**
 * A word that LOOKS adnominal by its last syllable: a final ㄴ, or 는 / 던. A final-syllable test cannot tell a noun from a
 * modifier (검진, 정산 vs 밀린, 급한), so it only decides between executing and asking, never alone between a task and chat.
 */
function looksAdnominal(word: string): boolean {
  const last = Array.from(word).at(-1) ?? '';
  const code = last.charCodeAt(0) - 0xac00;
  return (code >= 0 && code <= 11171 && code % 28 === 4) || last === '는' || last === '던';
}
/** The adnominal endings that are clearly a verb's or adjective's: -은 / -는 / -던. */
const STRONG_ADNOMINAL = /(?:은|는|던)$/u;
/** One-word modifiers that name a list ("남은", "밀린", "급한"): a vowel-stem -ㄴ form of a verb or adjective. */
const MODIFIER_SYLLABLE = /(?:한|된|린|난|운|온|친|낸|준|든|큰|쁜|픈|긴|센)$/u;
/** Closed degree adverbs (제일, 가장 …): only a modifier follows them, never a noun head ("제일 급한"). */
const DEGREE_ADVERB = /^(?:제일|젤|가장|더|덜|아주|매우|너무|진짜|정말|꽤|좀|많이|다)$/u;
/** A word that cannot stand inside a noun phrase: a strong adnominal, an -ㄹ adnominal, a verb ending, a case particle. */
const NOT_NOUN_PHRASE = /(?:은|는|던|을|를|할|될|다|고|서|게|히|면|며|지|요|어|아|여|이|가|에|의|로)$/u;
/** A possessive determiner or the possessive 의 ("우리 팀", "내", "팀장님의"): an owner, not a task. */
const POSSESSIVE_FIRST = /^(?:우리|저희|내|제|나의|저의|너의|네)$/u;

/**
 * CA P2 and Codex P2 (2026-10-19): the shape of a bare "<title> 할 일" (the frame without the title is only a to-do list
 * noun). `modifier`: the title has no noun head, only a modifier and at most degree adverbs ("남은", "밀린", "제일 급한"),
 * so the phrase names a list (chat). `confirm`: uncertain, so Core asks "'…'을(를) 할 일로 추가할까요?": one bare noun
 * ("회사", "청소", "정산"), an owner's ("우리 팀", "팀장님의"), or a last word that looks adnominal without a noun phrase
 * before it. `undefined`: execute: a multi-word task title ("검증 노트북 점검", "직원 정기 건강 검진": nouns before a ㄴ-final
 * noun) or a one-word title in the -기 nominalizer, a task by form (CA P3 #6: "장보기", "빨래하기").
 */
function bareTodoTitle(contentFrame: string, title: string): 'modifier' | 'confirm' | undefined {
  const rest = normalizeForMatch(contentFrame).replace(/[\s.!?~,]+/gu, '');
  if (!TODO_LIST_LABELS.has(rest.replace(/-/gu, ''))) return undefined;
  const words = normalizeForMatch(title).split(/\s+/u).filter((word) => word.length > 0);
  const last = words.at(-1) ?? '';
  const before = words.slice(0, -1);
  const hangulLast = /[가-힣]$/u.test(last);
  if (hangulLast && looksAdnominal(last)) {
    if (before.every((word) => DEGREE_ADVERB.test(word)) && (before.length > 0 || STRONG_ADNOMINAL.test(last) || MODIFIER_SYLLABLE.test(last))) return 'modifier';
    if (before.length === 0 || STRONG_ADNOMINAL.test(last)) return 'confirm';
    return before.every((word) => !NOT_NOUN_PHRASE.test(word) && !POSSESSIVE_FIRST.test(word)) ? undefined : 'confirm';
  }
  if (words.length <= 1) return hangulLast && /기$/u.test(last) && Array.from(last).length >= 2 ? undefined : 'confirm';
  return POSSESSIVE_FIRST.test(words[0] ?? '') || /의$/u.test(last) ? 'confirm' : undefined;
}

/** The words that name a read of one item (Core's mode and content vocabulary) beside every action word. */
/**
 * The command words of a quoted read request (Codex P2, round 5): every action word, the Korean mode and content words (a
 * Korean quoted command still needs its request ending, so a bare "요약" is a label), and the English command verbs only.
 * The English mode and content NOUNS (summary, original, whole, content …) never make a quoted span a command, so
 * `Show the "original" of email #1` reads while `He said "summarize 3"` is relayed.
 */
const ITEM_READ_EN_COMMAND_VERBS: readonly string[] = ['summarize', 'sum up', 'show', 'tell', 'explain', 'read', 'open', 'give', 'send'];
const ITEM_READ_ACTION_WORDS: readonly string[] = [
  ...NL_ACTION_WORDS,
  ...[...NL_MODE_SUMMARY_WORDS, ...NL_MODE_FULL_WORDS, ...NL_CONTENT_WORDS].filter((word) => !/^[a-z0-9 .;-]+$/u.test(word)),
  ...ITEM_READ_EN_COMMAND_VERBS,
];

/**
 * A6 R2 (v47, final narrowing after review): the veto of an `ITEM_READ` request, or `undefined` when it may read. ONLY a
 * relayed request (`nlRelaysRequest`): a quoted span holding a request form, or a Korean quotative or hearsay ending on the
 * owner's clause (…해 달래, …하랬는데, …하라고 했어). Example, joke, retraction, negation, statements, questions,
 * conditionals, wishes and the English "asked me to" stay with the selector: for a read their trigger words as often
 * describe the item or choose a mode ("email #1 that John asked me to review", "농담 부분까지 요약해줘", "…, not the
 * attachments"). A relayed request anywhere vetoes the whole message, also with an own request appended ("팀장이 3번
 * 요약해달래. 요약해줘" is chat: the relayed target is never read on the owner's behalf). It only turns a read into `none`.
 */
export function nlItemReadVeto(groundingText: string): 'reported' | undefined {
  const frame = withoutStructures(groundingText).normalize('NFC').replace(/\s+/g, ' ');
  return nlRelaysRequest(frame, ITEM_READ_ACTION_WORDS) ? 'reported' : undefined;
}

/** A6-D3a amendment 1: the request shape of a LOCAL_WRITE (see {@link requestShapeOf}). */
export interface NlRequestShape {
  readonly veto?: NlRequestVeto;
  readonly expressesAction: boolean;
  /** A content span with an unpaired quote: refused as `invalid-arg`. */
  readonly unbalancedSpan?: string;
  /** The action word a garbled word of the frame may stand for (see `garbled-action.ts`); the selection asks. */
  readonly garbled?: string;
  /** A target entry's frame with no action word and no request form (`nlFrameIsElliptical`); the selection never executes. */
  readonly elliptical?: boolean;
  /** Owner decision (b) of 2026-10-19: the list noun deciding the entry is garbled or unknown (`nlGarbledEntryNoun`); asks. */
  readonly garbledNoun?: NlGarbledEntryNoun;
  /** A bare "<title> 할 일" whose title may not be a task (`bareTodoTitle` `confirm`); Core asks, nothing is written. */
  readonly uncertainTitle?: boolean;
}

/**
 * A6-D3a amendment 1: the request shape of a LOCAL_WRITE. The vetoes read the owner's prose (pasted structures removed)
 * without the content spans that a quote pair or a colon form running to the end fully encloses; an undelimited span stays
 * in the frame, so "할 일에 우유 사기 추가하지 마, 그냥 메모야" stays vetoed whatever span the selector returns. Every span's
 * own negated action always counts. `stripFrame` is the R5a seam: a caller may remove its own phrases ("내가 말한 거",
 * "아까 보냈던 거") from the prose before the vetoes run. An arg-less entry (`action.undo`) also needs its own action word
 * (an undo word) in the frame and no dative recipient ("친구한테 책 돌려줘").
 */
export function requestShapeOf(
  entry: NlCatalogEntry,
  args: NlArgs,
  groundingText: string,
  stripFrame?: (prose: string) => string,
  clock: { readonly now: IsoTimestamp; readonly timeZone: string } = { now: '2026-01-01T00:00:00.000Z' as IsoTimestamp, timeZone: 'Asia/Seoul' },
): NlRequestShape {
  const base = withoutStructures(groundingText).normalize('NFC').replace(/\s+/g, ' ');
  const prose = stripFrame === undefined ? base : stripFrame(base).normalize('NFC').replace(/\s+/g, ' ');
  let vetoFrame = prose;
  let contentFrame = prose;
  const content: string[] = [];
  const quoted: string[] = [];
  const trailing: string[] = [];
  for (const name of CONTENT_SPAN_ARGS) {
    const span = args[name];
    if (typeof span !== 'string' || span.length === 0) continue;
    if (nlSpanHasUnbalancedQuote(span)) return { expressesAction: false, unbalancedSpan: name };
    content.push(span);
    const enclosure = spanEnclosure(prose, span);
    if (enclosure !== undefined) vetoFrame = withoutSpan(vetoFrame, span);
    if (enclosure === 'quote') quoted.push(span);
    // Only quote- or colon-enclosed content is fully exempt; trailing content after the request keeps its retraction,
    // negation and joke checks (Codex P1).
    if (enclosure === 'after-request') trailing.push(span);
    contentFrame = withoutSpan(contentFrame, span);
  }
  const words = entry.actionGrounding ?? [];
  const when = typeof args.when === 'string' ? args.when : undefined;
  let veto = nlRequestVeto(vetoFrame, words, NL_ACTION_WORDS, { content, quoted, trailing, ...(when !== undefined ? { when } : {}) });
  // CA P1 (2026-10-19): a colon label hands Quoky content only as the owner's own command. A whole-message quote is quoted
  // speech, a label that does not open the message (only a time may precede it) is a line of pasted material ("회의록 중
  // 할 일: …"), and a second `key:` inside the content is a pasted record ("…, 담당: 김대리"): all reported, none acts.
  if (veto === undefined && (wholeMessageQuoted(prose) || colonLabelIsPasted(prose, content, clock))) veto = 'reported';
  // A6 v49 gate (2026-10-19): a colon label's content is exempt from the vetoes, but its TRAILING clause is read like the
  // frame's last word: "Todo: renew passport?" is a question, "Todo: buy milk he told me" is reported.
  if (veto === undefined) {
    for (const span of content) {
      if (spanEnclosure(prose, span) !== 'colon') continue;
      veto = nlLabelTailVeto(span);
      if (veto !== undefined) break;
    }
  }
  // For a target entry an item-source noun is part of the reference; a payload entry has no reference.
  const payload = entry.args.some((spec) => spec.kind === 'span' && spec.required === true);
  let expressesAction = nlFrameExpressesAction(contentFrame, !payload);
  // CA P2 (2026-10-19), owner decision A narrowed: a bare "<title> 할 일" names a list, not a task, when the title is one
  // modifier ("남은 할 일", "제일 급한 할 일": an adnominal last word) and asks when it is a single noun or an owner's
  // ("회사 할 일", "팀장님 할 일", "우리 팀 할 일"); a multi-word task title ("검증 노트북 점검 할 일") still executes.
  let uncertainTitle = false;
  if (entry.id === 'todo.add' && typeof args.title === 'string' && spanEnclosure(prose, args.title) !== 'quote') {
    const bare = bareTodoTitle(contentFrame, args.title);
    if (bare === 'modifier') veto ??= 'statement';
    else if (bare === 'confirm') uncertainTitle = true;
  }
  if (entry.args.length === 0 && words.length > 0) {
    // A6-D3a amendment 1, undo confirmation rule: the undo needs one of its own words (a bare 돌려 is "give back": "돈 좀
    // 돌려줘") and no dative recipient ("친구한테 책 돌려줘"). Whether it executes directly or asks a confirmation is decided
    // at the message level by `nlUndoIsDirect` (undo-confirm.ts); no token heuristics here.
    const frameText = normalizeForMatch(contentFrame);
    const anchored = words.some((raw) => {
      const word = normalizeForMatch(raw);
      if (word === '돌려') return /되돌려/u.test(frameText);
      return /^[a-z ]+$/u.test(word) ? new RegExp(`(?<![a-z])${word.replace(/ /g, '\\s+')}(?![a-z])`, 'u').test(frameText) : frameText.includes(word);
    });
    expressesAction &&= anchored && !DATIVE.test(contentFrame);
  }
  // A6-D3a amendment 1, garbled action word addendum: read on the frame without the content spans (a title "완룐 보고서"
  // is content), against the selected entry's own words first.
  const near = nlGarbledActionWord(contentFrame, actionVocabularies(entry), NL_ACTION_VERBAL_NOUNS, CATALOG_WORDS, prose, NL_ACTION_LOANWORDS);
  const garbled = near === undefined ? undefined : canonicalActionWord(near.owner, /^[a-z]+$/u.test(near.word));
  // A6-D3a amendment 1, elliptical continuation: a target entry (a ref or a match; not a payload entry, whose bare content
  // acts by owner decision A, nor the arg-less undo with its own anchor rule) whose frame names no action and requests
  // nothing beyond the light verb ("이번엔 3번", "3번도 해줘") never executes. Read on the content frame, against every A6
  // vocabulary; an inflected action word ("2번 끝냄 처리해줘") names its action.
  const elliptical = !payload && entry.args.length > 0 && nlFrameIsElliptical(contentFrame, NL_ACTION_WORDS) && !nlFrameHasActionInflection(contentFrame, NL_ACTION_WORDS, NL_ACTION_VERBAL_NOUNS);
  // Owner decision (b) of 2026-10-19: the noun that decides a to-do or reminder write is itself garbled ("리마이너 걸어줘")
  // and no correct list noun is in the frame. Read without the content spans and the reminder's time span.
  const listed = isNlActionEntryId(entry.id) ? nlActionSourceOf(entry.id, args) : undefined;
  const nounFrame = when === undefined ? contentFrame : withoutSpan(contentFrame, when);
  const garbledNoun = listed === 'todo' || listed === 'reminder' ? nlGarbledEntryNoun(nounFrame, NL_ENTRY_NOUNS, NL_ENTRY_NOUN_VERBS, [...CATALOG_WORDS, ...NL_ACTION_WORDS], prose, NL_ENTRY_NOUN_LOANWORDS) : undefined;
  return {
    ...(veto !== undefined ? { veto } : {}),
    expressesAction,
    ...(garbled !== undefined ? { garbled } : {}),
    ...(garbledNoun !== undefined ? { garbledNoun } : {}),
    ...(elliptical ? { elliptical } : {}),
    ...(uncertainTitle ? { uncertainTitle } : {}),
  };
}

/** The catalog's own words (aliases and source names of every read and action entry): known words, never a garble. */
const CATALOG_WORDS: readonly string[] = [...Object.values(NL_WAVE1_ENTRIES), ...Object.values(NL_ACTION_ENTRIES)].flatMap((candidate) =>
  candidate === undefined ? [] : [...candidate.aliases, ...(candidate.sourceNames ?? [])],
);

/** The LOCAL_WRITE action vocabularies, the selected entry's first. */
function actionVocabularies(entry: NlCatalogEntry): NlActionVocabulary[] {
  const all = Object.values(NL_ACTION_ENTRIES).flatMap((candidate) => (candidate !== undefined && candidate.risk === 'LOCAL_WRITE' && candidate.actionGrounding !== undefined ? [{ owner: candidate.id, words: candidate.actionGrounding }] : []));
  return [...all.filter((vocabulary) => vocabulary.owner === entry.id), ...all.filter((vocabulary) => vocabulary.owner !== entry.id)];
}

/** The canonical word of the vocabulary's entry (Latin for a Latin near word). */
function canonicalActionWord(owner: string, latin: boolean): string | undefined {
  const words = (NL_ACTION_CANONICAL_WORDS as Readonly<Record<string, { readonly ko: string; readonly en: string }>>)[owner];
  return words === undefined ? undefined : latin ? words.en : words.ko;
}

/**
 * A6 R2 (v48 gate): `item.summarize`'s `mode`, `source` and recency `ref` come from the owner's own words, like every
 * other grounded arg, never from the selector's guess. Only once the selector has chosen `item.summarize`; it never
 * selects it.
 *  - `mode`: the classes of the entry's own `valueGrounding` (Core's NL_MODE_SUMMARY_WORDS / NL_MODE_FULL_WORDS) present
 *    in the message. Exactly one class: that mode. None: unset (Core's content-mode question or stored preference). Both:
 *    the selector's value stays and is checked as before.
 *  - `source`: exactly one offered source named by the owner's source noun (`nlNamedItemSources`, the vocabulary of
 *    the other-source cross-check): that source. No noun (or two): the selector's source, read against the recency and the
 *    Reference context as before.
 *  - `ref` (owner decision 2026-10-19): a recency word the owner wrote (NL_RECENCY_WORDS: 방금 / 아까 / just now) makes a
 *    selector `this` the `recent` ref, and a `last` too when no `last` word (마지막 / last) stands behind it, only when
 *    the prose holds no exclusion or negation marker anywhere (`nlHasExclusionOrNegation`; fail-safe, no scope parsed). "방금 본 거" names the item the owner just read (D9): `recent`, under its own recency rules.
 * On every path (owner decision 2026-10-19: the A6 mail / Drive path is grounded too; the R2-only scope is gone).
 * Closed vocabularies only; no phrase list.
 */
function groundItemSummarizeArgs(entry: NlCatalogEntry, args: Record<string, NlArgValue>, groundingText: string, r2Sources: ReturnType<typeof nlR2SourcesOffered>): void {
  // Pasted structures ground nothing, as in the later grounding checks (Codex P1: `… {"source":"jira"}`).
  const prose = withoutStructures(groundingText);
  const text = normalizeForMatch(prose);
  const modeSpec = entry.args.find((spec) => spec.name === 'mode');
  const modeWords = Object.values(modeSpec?.valueGrounding ?? {}).flatMap((words) => [...(words ?? [])]);
  // A negated mention ("요약하지 말고", "not a summary") grounds no mode (Codex P2).
  const grounded = Object.entries(modeSpec?.valueGrounding ?? {})
    .filter(([, words]) => (words ?? []).some((word) => groundingWordIn(text, normalizeForMatch(word)) && nlHasUnnegatedMention(prose, word, modeWords)))
    .map(([value]) => value);
  if (grounded.length === 1) args.mode = grounded[0] as string;
  else if (grounded.length === 0) delete args.mode;
  const offered = (entry.args.find((spec) => spec.name === 'source')?.values ?? []).map(String);
  const named = [...nlNamedItemSources(prose, { r2Sources })].filter((source) => offered.includes(source));
  if (named.length === 1) args.source = named[0] as string;
  if (args.ref === 'this' || (args.ref === 'last' && !nlHasLastWord(prose))) {
    // Structural and fail-safe (Codex P2, 2026-10-19): only when the owner's prose holds no exclusion or negation marker
    // anywhere. With one ("방금 요약한 그거 말고 이거", "not the one I just now read"), the selector's ref stays, as before
    // the recency grounding existed; no scope is parsed.
    if (!nlHasExclusionOrNegation(prose) && NL_RECENCY_WORDS.some((word) => groundingWordIn(text, normalizeForMatch(word)))) args.ref = 'recent';
  }
}

type NlCheckedArgs =
  | { readonly ok: false; readonly result: NlValidationResult }
  | {
      readonly ok: true;
      readonly entryId: NlCatalogEntryId;
      readonly entry: NlCatalogEntry;
      readonly args: Record<string, NlArgValue>;
      readonly r2Sources: ReturnType<typeof nlR2SourcesOffered>;
      readonly keys: boolean;
    };

/** The first stage of {@link validateSelection}: the args as Core checked and grounded them, before any refusing rule. */
function checkedSelectionArgs(candidate: NlSelectionCandidate, ctx: NlValidationContext): NlCheckedArgs {
  // (1) closed ids
  if (!isNlCatalogEntryId(candidate.entryId)) return { ok: false, result: { ok: false, reason: 'unknown-entry' } };
  const entryId = candidate.entryId;
  // (2) offered (registered + configured) and READ only (wave 1), or an offered A6 entry while actions are allowed
  const entry = ctx.offered.get(entryId);
  if (entry === undefined) return { ok: false, result: { ok: false, reason: 'not-offered', entryId } };
  if (entry.risk !== 'READ' && ctx.actions !== true) return { ok: false, result: { ok: false, reason: 'not-read', entryId } };
  const specs = new Map(entry.args.map((spec) => [spec.name, spec] as const));
  const args: Record<string, NlArgValue> = {};
  // A6 R2 (CA P1): the Jira / Slack nouns and the Jira key ref exist only while the offered item.summarize lists them.
  const r2Sources = entryId === 'item.summarize' ? nlR2SourcesOffered([entry]) : [];
  const keys = r2Sources.includes('jira');
  for (const [name, value] of Object.entries(candidate.args)) {
    const spec = specs.get(name);
    if (spec === undefined) return { ok: false, result: { ok: false, reason: 'unknown-arg', entryId, arg: name } };
    const checked = checkArg(spec, value, keys);
    if (checked === undefined) return { ok: false, result: { ok: false, reason: 'invalid-arg', entryId, arg: name } };
    args[name] = checked;
  }
  entry.normalize?.(args, ctx.groundingText, entry.risk === 'READ' ? ctx.previousArgs : undefined);
  // Every path (owner decision 2026-10-19): with R2 off the A6 entry (mail, Drive) is grounded the same way.
  if (entryId === 'item.summarize') groundItemSummarizeArgs(entry, args, ctx.groundingText, r2Sources);
  return { ok: true, entryId, entry, args, r2Sources, keys };
}

/**
 * Core's own args for a selector candidate (the A6 / R2 eval scorer, owner decision 2026-10-19): the validated args when
 * the selection validates; otherwise the args as Core checked and grounded them before the refusing rule (a question for
 * a missing source holds the grounded ref and mode). `undefined` when the candidate names no offered entry or carries an
 * unknown or invalid arg.
 */
export function nlCoreSelectionArgs(candidate: NlSelectionCandidate, ctx: NlValidationContext): NlArgs | undefined {
  const validated = validateSelection(candidate, ctx);
  if (validated.ok) return validated.value.args;
  const checked = checkedSelectionArgs(candidate, ctx);
  return checked.ok ? Object.freeze(canonicalArgs(checked.entry, checked.args)) : undefined;
}

export function validateSelection(candidate: NlSelectionCandidate, ctx: NlValidationContext): NlValidationResult {
  const checked = checkedSelectionArgs(candidate, ctx);
  if (!checked.ok) return checked.result;
  const { entryId, entry, args, r2Sources, keys } = checked;
  // A6-D3a amendment 1 (owner-approved direction 2026-10-16): a LOCAL_WRITE the selector chose runs unless the owner's own
  // sentence is not a request. No request verb or closed request form is needed; the structural vetoes decide (chat), and
  // a frame with nothing but references ("2번도", "그걸로요", "13번 알림") or nothing but content ("내일 9시 우유")
  // expresses no action.
  if (entry.risk === 'LOCAL_WRITE') {
    const shape = requestShapeOf(entry, args, ctx.groundingText, ctx.requestFrame, { now: ctx.now, timeZone: ctx.timeZone });
    if (shape.unbalancedSpan !== undefined) return { ok: false, reason: 'invalid-arg', entryId, arg: shape.unbalancedSpan };
    if (shape.veto !== undefined) return { ok: false, reason: 'not-request', entryId, arg: shape.veto };
    if (!shape.expressesAction) return { ok: false, reason: 'ungrounded', entryId, arg: 'action' };
    // After the vetoes (a garbled word in a question or a negation is still chat): the action word itself is uncertain, so
    // the owner is asked with the candidate instead of the write running (owner decision 2026-10-16, "3번 완룐 처리해줘").
    if (shape.garbled !== undefined) return { ok: false, reason: 'garbled-action', entryId, arg: 'action', candidate: shape.garbled };
    // Owner decision (b) of 2026-10-19: the same for the noun that decides the list ("리마이너 걸어줘"): a typo of a list
    // noun asks with that noun, an unknown word in its slot asks what it means.
    if (shape.garbledNoun !== undefined) {
      return shape.garbledNoun.kind === 'typo'
        ? { ok: false, reason: 'garbled-noun', entryId, arg: 'entry', candidate: shape.garbledNoun.noun }
        : { ok: false, reason: 'garbled-noun', entryId, arg: 'entry', unknownWord: shape.garbledNoun.word };
    }
    // CA / Codex P2 (2026-10-19): a bare "<title> 할 일" whose title may not be a task asks before anything is added.
    if (shape.uncertainTitle === true) return { ok: false, reason: 'uncertain-title', entryId, arg: 'title' };
    // After the garble (a garbled action word is its own question): an elliptical frame names no action at all, so the
    // action is only inferred and nothing is written ("이번엔 3번" after "1번 완료"; D12 gate v44 run 3).
    if (shape.elliptical === true) return { ok: false, reason: 'elliptical', entryId, arg: 'action' };
  }
  // A6 R2 (v47): an ITEM_READ whose own sentence is not a read request (reported, quoted, negated, retracted, example,
  // conditional, wish, past statement) is chat, like a LOCAL_WRITE veto; a question form still reads.
  if (entry.risk === 'ITEM_READ') {
    const veto = nlItemReadVeto(ctx.groundingText);
    if (veto !== undefined) return { ok: false, reason: 'not-request', entryId, arg: veto };
  }
  // A6-D3 (A6 R1 fix): a payload made only of deictic, ordinal or time words gets its fixed reply ("내용을 직접 적어
  // 주세요") before any missing argument is named: "그거 알림으로 만들어줘" has no time either, and the content is the problem.
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (spec.kind === 'span' && spec.allowsTimeWords !== true && typeof value === 'string' && isNlDeicticOnlyPayload(value)) return { ok: false, reason: 'deictic-payload', entryId, arg: spec.name };
  }
  for (const spec of entry.args) {
    if (spec.required === true && args[spec.name] === undefined) return { ok: false, reason: 'missing-arg', entryId, arg: spec.name };
  }
  // (4) symbolic time
  let range: NlResolvedRange | undefined;
  const rangeSpec = entry.args.find((spec) => spec.kind === 'range');
  // The weekdays the owner's words name, outside a value that may legitimately be one (a sender called "월요일").
  const mentions: readonly NlWeekdayMention[] = rangeSpec !== undefined ? nlWeekdayMentions(withoutNameValues(entry, args, ctx.groundingText), entry.aliases) : [];
  if (rangeSpec !== undefined) {
    // A weekday symbol that names the same day as the owner's own week word is spelled the owner's way ("금요일" = fri,
    // never this-fri when both are this Friday): a canonical form, never another day (calendar-accuracy note).
    const given = args[rangeSpec.name];
    // Owner decision of 2026-10-19 (A5 rule 6): a period that needs the owner's time words is ungrounded without one (a
    // model-made period), unless it is the previous selection's own period carried by a follow-up.
    if (typeof given === 'string' && rangeSpec.timeWordsRequired === true && ctx.previousArgs?.[rangeSpec.name] !== given && !nlNamesPeriod(ctx.groundingText)) {
      return { ok: false, reason: 'ungrounded', entryId, arg: rangeSpec.name };
    }
    if (typeof given === 'string') {
      const previousRange = ctx.previousArgs?.[rangeSpec.name];
      args[rangeSpec.name] = nlCanonicalWeekdaySymbol(given, nlSingleWeekday(mentions), typeof previousRange === 'string' ? previousRange : undefined, ctx.now, ctx.timeZone);
    }
    const symbol = typeof args[rangeSpec.name] === 'string' ? (args[rangeSpec.name] as string) : typeof rangeSpec.default === 'string' ? rangeSpec.default : undefined;
    if (symbol !== undefined) {
      if (symbol === 'upcoming' && rangeSpec.allowUpcoming !== true) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      range = resolveNlRange(symbol, ctx.now, ctx.timeZone);
      if (range === undefined) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      if (rangeSpec.pastOnly === true && Date.parse(range.from) > Date.parse(ctx.now)) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
      if (rangeSpec.futureOnly === true && Date.parse(range.to) <= Date.parse(ctx.now)) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
    }
  }
  // (5) grounding and (6) the credential guard, on every string arg. A6: the previous selection never grounds an action,
  // and every action argument (span, ref, enum and flag words, the entry check) is grounded only in the owner's prose:
  // a pasted structure (JSON, data) grounds nothing (Codex review P1).
  const previousArgs = entry.risk === 'READ' ? ctx.previousArgs : undefined;
  const groundingText = entry.risk === 'READ' ? ctx.groundingText : withoutStructures(ctx.groundingText);
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (spec.kind === 'flag' && value === true && spec.flagGrounding !== undefined) {
      const text = normalizeForMatch(groundingText);
      const stated = spec.flagGrounding.some((word) => groundingWordIn(text, normalizeForMatch(word)));
      if (!stated && previousArgs?.[spec.name] !== true) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (typeof value !== 'string') continue;
    if (spec.kind === 'enum' && spec.valueGrounding?.[value] !== undefined) {
      const text = normalizeForMatch(groundingText);
      const stated = (spec.valueGrounding[value] ?? []).some((word) => groundingWordIn(text, normalizeForMatch(word)));
      if (!stated && previousArgs?.[spec.name] !== value) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (spec.kind === 'keyword') {
      if (rangeSpec !== undefined && spec.allowsTimeWords !== true && isWeekdayOrTimeKeyword(value, mentions.length > 0)) return { ok: false, reason: 'time-keyword', entryId, arg: spec.name };
      const previous = previousArgs?.[spec.name];
      const fromPrevious = typeof previous === 'string' && previous === value;
      if (!fromPrevious && !isGroundedIn(value, groundingText)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    // A6-D3: a span is grounded ONLY in this turn's own words (never the previous selection), and is never only deictic.
    if (spec.kind === 'span') {
      if (!isNlSpanGrounded(value, groundingText)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
      if (spec.allowsTimeWords !== true && isNlDeicticOnlyPayload(value)) return { ok: false, reason: 'deictic-payload', entryId, arg: spec.name };
    }
    // A6-D2: a ref needs a numeral, ordinal or deictic in this turn's own words (a determiner + noun only for the entry's
    // own source, and 저 only for a read).
    if (spec.kind === 'ref') {
      const ref = parseNlRef(value, { keys });
      const target = isNlActionEntryId(entryId) ? { entryId, source: nlActionSourceOf(entryId, args), r2Sources } : undefined;
      if (ref === undefined || !isNlRefGrounded(ref, groundingText, target)) return { ok: false, reason: 'ungrounded', entryId, arg: spec.name };
    }
    if (containsCredentialMaterial(value)) return { ok: false, reason: 'credential', entryId, arg: spec.name };
  }
  // (4b) the owner's weekday is a fact about the period: a period that drops or changes it never validates (after the
  // per-arg checks, so a weekday keyword still fails as `time-keyword`).
  const weekday = nlSingleWeekday(mentions);
  // (4b, A7) an `until-*` period needs the owner's inclusive end bound on that weekday and ends on that day; a
  // period that holds such a bounded day but does not end on it ("금요일까지" read as `fri` or `this-week`) is spelled as
  // the grounded `until-*` symbol ending on that day, else refused. Several weekdays with an end bound ("목요일부터
  // 토요일까지") need a period from the start-bounded day to the end-bounded day. A period that looks back (mail, Jira
  // created / updated) never takes an `until-*` symbol and keeps the A5 rule unchanged.
  const rangeValue = rangeSpec !== undefined ? args[rangeSpec.name] : undefined;
  if (rangeSpec !== undefined) {
    const lookingBack = rangeSpec.pastOnly === true || rangeSpec.pastWindow?.(args) === true;
    if (lookingBack) {
      if (typeof rangeValue === 'string' && nlUntilSymbolWeekday(rangeValue) !== undefined) return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    } else if (weekday?.boundConflict === true) {
      // The mentions disagree on the bound or, with a bound, on the week: no reading is inferred, every period asks.
      return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    } else if (weekday === undefined && mentions.length > 0) {
      // Several weekdays: the exact span, or (both bounds explicit) the one allowed span inside the selected period.
      const multi = nlMultiWeekdayBound(range, mentions, ctx.now, ctx.timeZone);
      if (multi === 'refuse') return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
      if (typeof multi === 'object') {
        args[rangeSpec.name] = multi.canonical;
        range = resolveNlRange(multi.canonical, ctx.now, ctx.timeZone);
      } else if (multi === 'n/a' && typeof rangeValue === 'string' && nlUntilSymbolWeekday(rangeValue) !== undefined) {
        // Several weekdays without one end-bounded span: an `until-*` symbol has nothing to stand on.
        return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
      }
    } else if (typeof rangeValue === 'string') {
      const previousRange = ctx.previousArgs?.[rangeSpec.name];
      const until = nlUntilBound(rangeValue, range, weekday, typeof previousRange === 'string' ? previousRange : undefined, ctx.now, ctx.timeZone);
      if (until === 'refuse') return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
      if (until !== 'keep') {
        args[rangeSpec.name] = until.canonical;
        range = resolveNlRange(until.canonical, ctx.now, ctx.timeZone);
      }
    }
  }
  if (rangeSpec !== undefined && weekday !== undefined) {
    // A weekday inside a grounded title keyword with other words ("수요일 스터디", "sunday school") may be part of the
    // title (A5 rule 6: real title keywords stay), so it is uncertain: another single day is still refused.
    // A keyword that only hides the period ("수요일 회의" with the whole next week) is not a title and stays refused.
    const titled = entry.args.some((spec) => {
      const value = args[spec.name];
      return spec.kind === 'keyword' && typeof value === 'string' && nlKeywordIsTitle(value, weekday.weekday, entry.aliases);
    });
    if (!nlRangeKeepsWeekday(range, titled ? { ...weekday, certain: false } : weekday, ctx.now, ctx.timeZone)) {
      return { ok: false, reason: 'weekday', entryId, arg: rangeSpec.name };
    }
  }
  // Codex P2 (2026-10-19): `futureOnly` again on the FINAL range (a weekday bound may have re-spelled it: "이번 주 월요일부터
  // 화요일까지" on a Wednesday is entirely past).
  if (rangeSpec?.futureOnly === true && range !== undefined && Date.parse(range.to) <= Date.parse(ctx.now)) return { ok: false, reason: 'range', entryId, arg: rangeSpec.name };
  // A6: the entry's own check after the per-arg checks.
  if (entry.check !== undefined) {
    const failure = entry.check(args, groundingText);
    if (failure !== undefined) {
      return {
        ok: false,
        reason: failure.reason,
        entryId,
        ...(failure.arg !== undefined ? { arg: failure.arg } : {}),
        ...(failure.askEntryId !== undefined ? { askEntryId: failure.askEntryId } : {}),
      };
    }
  }
  const openAmbiguity = (entry.ambiguity ?? []).find((key) => key.openWhen(args) && args[key.arg] === undefined);
  return {
    ok: true,
    value: {
      entry,
      args: Object.freeze(canonicalArgs(entry, args)),
      ...(range !== undefined ? { range } : {}),
      ...(openAmbiguity !== undefined ? { openAmbiguity } : {}),
    },
  };
}

/** A closed particle glued after a name ("월요일이 보낸", "Sun한테서"). */
const NAME_PARTICLE = '(?:에게서|한테서|에게|한테|께서|이랑|랑|하고|이|가|은|는|의|도|만|께)?';

/**
 * The owner's text without the values of args that may be made of time words (a sender named "월요일"). Only a whole
 * word is removed (optionally with one particle), so a sender "Sun" never erases the weekday in "Sunday".
 */
function withoutNameValues(entry: NlCatalogEntry, args: Readonly<Record<string, NlArgValue>>, text: string): string {
  let rest = text.normalize('NFC');
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (spec.allowsTimeWords !== true || typeof value !== 'string' || value.trim().length === 0) continue;
    const escaped = value.normalize('NFC').trim().replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
    rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${NAME_PARTICLE}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return rest;
}

/** The args with every value equal to its spec default removed, except an ambiguity arg whose key is in force. */
export function canonicalArgs(entry: NlCatalogEntry, args: Readonly<Record<string, NlArgValue>>): Record<string, NlArgValue> {
  const kept: Record<string, NlArgValue> = {};
  const protectedArgs = new Set((entry.ambiguity ?? []).filter((key) => key.openWhen(args)).map((key) => key.arg));
  for (const spec of entry.args) {
    const value = args[spec.name];
    if (value === undefined) continue;
    if (spec.default !== undefined && value === spec.default && !protectedArgs.has(spec.name)) continue;
    kept[spec.name] = value;
  }
  return kept;
}

/** Type check of one argument (D4 steps 1 and 3); the normalized value or `undefined`. */
function checkArg(spec: NlArgSpec, value: NlArgValue, keys = false): NlArgValue | undefined {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value) ? value : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'limit':
      return typeof value === 'number' && Number.isInteger(value) && value >= NL_LIMIT_MIN && value <= NL_LIMIT_MAX ? value : undefined;
    case 'range': {
      if (typeof value !== 'string') return undefined;
      const symbol = normalizeNlRangeSymbol(value);
      return isNlRangeSymbol(symbol) ? symbol : undefined;
    }
    case 'keyword': {
      if (typeof value !== 'string') return undefined;
      const keyword = canonicalNlKeyword(value);
      const length = Array.from(keyword).length;
      if (length === 0 || length > NL_KEYWORD_MAX_CHARS || CONTROL.test(keyword)) return undefined;
      return keyword;
    }
    case 'span': {
      // A6-D1: verbatim, NFC and whitespace only, one pair of enclosing quotes trimmed; never a placeholder, never repaired.
      if (typeof value !== 'string' || CONTROL.test(value.replace(/[\t\n\r]/g, ' '))) return undefined;
      const span = normalizeNlSpan(value);
      const length = Array.from(span).length;
      if (length === 0 || length > (spec.maxChars ?? NL_KEYWORD_MAX_CHARS)) return undefined;
      if (span.includes(NL_QUOTED_PLACEHOLDER) || span.includes(NL_FENCED_PLACEHOLDER) || /\[files:/u.test(span)) return undefined;
      return span;
    }
    case 'ref': {
      const ref = parseNlRef(value, { keys });
      return ref === undefined ? undefined : formatNlRef(ref);
    }
  }
}

/**
 * A grounding word in normalized text. A word made of ASCII letters and digits only must start a word and may end it or
 * take a plural `s` ("docs" is not in "docker", "sheet" is in "sheets"); a Korean word is a plain substring.
 */
export function groundingWordIn(text: string, word: string): boolean {
  if (!/^[a-z0-9][a-z0-9 -]*$/.test(word)) return text.includes(word);
  const escaped = word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}s?(?![a-z0-9])`).test(text);
}
