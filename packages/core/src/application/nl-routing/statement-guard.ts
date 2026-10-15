import { isNlRequestOrWhWord } from './grammar-residual';

/**
 * ADR-0120 amendment A7 (Proposed): a clear past-tense statement is not a request to read (neg-042, "어제 일정 있었는데
 * 까먹었어 ㅠ"). D2 rule 2 already tells the selector that statements of fact are `none`; this is the deterministic
 * second check after it, message-level and for READ entries only. It reads grammar, never topics: the sentence-final
 * ending, the closed request / interrogative forms of `grammar-residual.ts`, the closed wh-word stems and a connective
 * clause ending. No phrase, verb or source word routes anything, and it can only turn a capture into `none` (chat), never
 * select an entry.
 *
 * A message is a clear past statement only when ALL hold:
 *  1. it has Korean text and no question mark;
 *  2. no word is a request or interrogative form (알려줘, 보여줘, 뭐, 언제, 몇, 무슨, 어디, 누구, 얼마, 왜, … and the
 *     request endings 줘 / 주세요 / 줄래 / 할래 / 볼래 / 할까 and the quoted 달라고 / 주라고), and it is no wish ("…으면
 *     했어", "…으면 좋겠다", "…고 싶었다": a polite way to ask);
 *  3. the last word (emoticons such as ㅠ, ㅋㅋ and emoji ignored) ends in a PAST or retrospective DECLARATIVE ending. Past
 *     is only the past marker 았 / 었 / 였 / 했 and its contractions (왔, 봤, 났, 찼, 됐, 셨 …): never 겠 (a guess or an
 *     intention: "확인해야겠다") and never the present 있 / 없 ("회의 있다", "메일 있습니다"). Then:
 *     - unambiguous on its own: past + 다 or 습니다 ("끝났다"), or the retrospective 더라 / 던데 ("왔더라", "없더라");
 *     - the informal past 어 / 어요 / 네 ("까먹었어") is also a casual question without its question mark ("메일 왔어",
 *       "일정 궁금했어", "일정 확인 필요했어"), so it counts only with one more grammatical marker: a double past
 *       ("찼었어") or a background clause before it ("있었는데 까먹었어"). A degree adverb ("메일 진짜 왔어") is not one.
 * Pure.
 */

/** The past marker (았/었/였/했) and its contractions: a ㅆ-final syllable with the vowel ㅏ ㅐ ㅓ ㅕ ㅘ ㅙ ㅝ. */
function isPastSyllable(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171 || code % 28 !== 20) return false;
  const vowel = Math.floor(code / 28) % 21;
  return vowel === 0 || vowel === 1 || vowel === 4 || vowel === 6 || vowel === 9 || vowel === 10 || vowel === 14;
}

/** The closed wh-word stems (a token that starts with one asks: "뭐였지", "몇시", "언제야", "어디서", "누구한테"). */
const WH_STEM = /^(?:뭐|뭘|뭔|무슨|무엇|언제|몇|어떤|어떻|어때|어디|누가|누구|얼마|왜)/u;
/** The closed request endings on any verb ("찾아줘", "봐주세요", "알려줄래", "볼래", "해볼까"). */
const REQUEST_ENDING = /(?:줘|줘요|주세요|주실래요?|줄래요?|줄까요?|볼래요?|볼까요?|할래요?|할까요?|하자|봐봐)$/u;
/** The closed quoted-request forms (…달라고 / …주라고: "보여달라고 했는데", "알려달라고 했었어"), treated like 줘. */
const QUOTED_REQUEST = /(?:달라고|주라고)/u;
/** A wish, which is a polite request: a conditional before 했/좋/바라 ("보여줬으면 했어", "알면 좋겠다"), or 싶 ("보고 싶었다"). */
const WISH_CONDITIONAL = /(?:으면|면)$/u;
const WISH_PREDICATE = /^(?:했|하|해|합|좋|바라|바랐|바래)/u;
const WISH_DESIRE = /싶/u;
/** The retrospective declarative endings. */
const RETROSPECTIVE = /(?:더라|더라고|더라구|던데)(?:요)?$/u;
/** A background clause ending before the final predicate ("있었는데", "봤는데", "했는데"). */
const BACKGROUND_CLAUSE = /(?:는데|은데|ㄴ데|던데)$/u;
/** Trailing emoticon jamo and emoji glued to a word ("까먹었어ㅠㅠ"). */
const TRAILING_NOISE = /[\u3131-\u318e\p{Extended_Pictographic}\uFE0F\u200D]+$/u;

export function nlIsPastStatement(text: string): boolean {
  const normalized = text.normalize('NFC').replace(/\p{Cf}/gu, '');
  if (!/\p{Script=Hangul}/u.test(normalized) || /[?？]/u.test(normalized)) return false;
  const tokens = normalized
    .split(/[\s.,!~…;:·"'“”‘’()[\]{}<>]+/u)
    .map((token) => token.replace(TRAILING_NOISE, ''))
    .filter((token) => token.length > 0);
  const last = tokens.at(-1);
  if (last === undefined) return false;
  if (tokens.some((token) => WH_STEM.test(token) || REQUEST_ENDING.test(token) || QUOTED_REQUEST.test(token) || isNlRequestOrWhWord(token))) return false;
  const before = tokens.slice(0, -1);
  // A wish anywhere: -(으)면 followed by 하/좋/바라 with any ending ("보여주셨으면 해서 말씀드렸습니다"), or 싶.
  if (WISH_DESIRE.test(last) || tokens.some((token, index) => WISH_CONDITIONAL.test(token) && WISH_PREDICATE.test(tokens[index + 1] ?? ''))) return false;
  const chars = Array.from(last);
  const at = (fromEnd: number): string | undefined => chars[chars.length - fromEnd];
  if (RETROSPECTIVE.test(last)) return true;
  // past + 다 / 습니다 ("끝났다", "했다", "했습니다")
  if (at(1) === '다' && (isPastSyllable(at(2)) || (at(2) === '니' && at(3) === '습' && isPastSyllable(at(4))))) return true;
  // the informal past 어 / 어요 / 네 / 네요, with one more grammatical marker
  const ending = last.endsWith('어요') || last.endsWith('네요') ? 2 : last.endsWith('어') || last.endsWith('네') ? 1 : 0;
  if (ending === 0 || !isPastSyllable(at(ending + 1))) return false;
  if (at(ending + 1) === '었' && isPastSyllable(at(ending + 2))) return true;
  return before.some((token) => BACKGROUND_CLAUSE.test(token));
}
