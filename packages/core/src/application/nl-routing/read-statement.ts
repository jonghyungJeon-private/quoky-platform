import { nlIsRequestForm, nlRequestsSomething } from './request-shape';
import type { NlArgs } from './catalog';
import { isNlRequestOrWhWord } from './grammar-residual';

/**
 * Message-level, READ-only structural checks next to the A7 past-statement guard (`statement-guard.ts`). Like it they read
 * grammar only (endings, connectives, quote pairs, the closed request / interrogative forms), never a topic, a source word
 * or a phrase, and they can only turn a capture into `none` (chat), never select an entry. Pure.
 *
 * - `reason-statement`: a reason clause plus a lone predicate ("<clause>-서 <predicate>"): a statement of feeling about a
 *   cause, not a request. The reason clause may hold an embedded question ("…뭐 있는지 몰라서"), because a question that is
 *   subordinate to a reason is part of the statement. Not a statement when: a question mark, any request or interrogative
 *   form anywhere, or the main clause is more than one word (an object or a topic makes it a command: "급해서 확인해 주세요",
 *   "바빠서 이슈 확인해").
 * - `quoted-request`: a quoted segment that is itself a complete request, which no argument of the selection consumes, is a
 *   phrase being talked about, not a request being made. A quote that IS an argument value ("슬랙에서 "롤백" 검색") is the
 *   owner's content and never counts.
 */
export type NlReadNotRequest = 'reason-statement' | 'quoted-request';

const WH_STEM = /^(?:뭐|뭘|뭔|무슨|무엇|언제|몇|어떤|어떻|어때|어디|누가|누구|얼마|왜)/u;
const REQUEST_ENDING = /(?:줘|줘요|주세요|주십시오|주실래요?|줄래요?|줄까요?|볼래요?|볼까요?|할래요?|할까요?|하자|봐봐|부탁\S*)$/u;
const INTERROGATIVE = /(?:니|냐|냐고|까|까요|나요|가요|는가|은가|던가|지)$/u;
/** A reason connective on a word that is not the last: -아서/-어서/-라서, -(으)니까, -느라 (never the locative 에서 or a noun ending in 서). */
const REASON_CONNECTIVE = /(?:[아어여라]서|니까|느라)$/u;
const TRAILING_NOISE = /[ㄱ-ㆎ\p{Extended_Pictographic}️‍]+$/u;
const QUOTED = /"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’|「([^」]+)」|『([^』]+)』/gu;

function tokensOf(text: string): string[] {
  return text
    .split(/[\s.,!~…;:·"'“”‘’()[\]{}<>]+/u)
    .map((token) => token.replace(TRAILING_NOISE, ''))
    .filter((token) => token.length > 0);
}

function asksOrRequests(token: string): boolean {
  return WH_STEM.test(token) || REQUEST_ENDING.test(token) || isNlRequestOrWhWord(token);
}

function isReasonStatement(text: string): boolean {
  if (!/\p{Script=Hangul}/u.test(text) || /[?？]/u.test(text)) return false;
  const tokens = tokensOf(text);
  let connective = -1;
  for (const [index, token] of tokens.entries()) if (index < tokens.length - 1 && token.length >= 2 && REASON_CONNECTIVE.test(token)) connective = index;
  if (connective < 0) return false;
  const main = tokens.slice(connective + 1);
  const last = main[0];
  if (main.length !== 1 || last === undefined || !/\p{Script=Hangul}$/u.test(last)) return false;
  // Nothing before the connective may be a request; a wh-word there is the embedded question of the reason clause.
  if (tokens.slice(0, connective + 1).some((token) => REQUEST_ENDING.test(token))) return false;
  return !asksOrRequests(last) && !INTERROGATIVE.test(last) && !/싶/u.test(last);
}

function consumedByArgs(inner: string, args: NlArgs): boolean {
  const needle = inner.trim().toLowerCase();
  return Object.values(args).some((value) => {
    if (typeof value !== 'string') return false;
    const own = value.trim().toLowerCase();
    return own.length > 0 && (own.includes(needle) || needle.includes(own));
  });
}

function hasUnconsumedQuotedRequest(text: string, args: NlArgs): boolean {
  for (const match of text.matchAll(QUOTED)) {
    const inner = (match.slice(1).find((group) => group !== undefined) ?? '').trim();
    const words = tokensOf(inner);
    if (words.length < 2 || consumedByArgs(inner, args)) continue;
    if (nlIsRequestForm(words.at(-1) ?? '') || nlRequestsSomething(inner, [])) return true;
  }
  return false;
}

/** The class of a READ capture that is not a request, or `undefined`. `groundingText` is the owner's non-platform-quoted words. */
export function nlReadNotRequest(groundingText: string, args: NlArgs): NlReadNotRequest | undefined {
  const text = groundingText.normalize('NFC').replace(/\p{Cf}/gu, '');
  if (hasUnconsumedQuotedRequest(text, args)) return 'quoted-request';
  if (isReasonStatement(text)) return 'reason-statement';
  return undefined;
}
