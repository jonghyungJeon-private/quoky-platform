import { normalizeForMatch } from './selection-input';
import { isPastSyllable } from './statement-guard';

/**
 * ADR-0120 A6-D3a amendment 1 (owner-approved direction 2026-10-16, Proposed): the structural vetoes of a LOCAL_WRITE.
 *
 * The selector chooses the entry and its target; Core no longer asks for a request verb or an affirmative request form
 * from a closed set (that rule refused "3일 뒤 오전 9시에 월세 이체 리마인더", "todo 추가: 프린터 토너 주문" and "1번 할일
 * 체크해줘"). What stays is grammar: a message whose own sentence is not a request never writes, whichever entry the
 * selector chose. Each veto reads a closed grammatical class (endings, particles, interrogatives, negators, quotative and
 * conditional morphemes, the past marker, first-person pronouns), never a topic or a request verb, and each can only turn
 * an action into `none` (chat). Nothing here selects or executes anything.
 *
 * Classes (each checked on the FRAME: the owner's prose with the selector's content spans removed, so a to-do titled
 * "하지 말아야 할 것 정리" or a reminder body "가스 밸브 잠그지 마" is content, not a negation of the request):
 *  - `example`: an example frame (예를 들어, 예컨대, for example, e.g.);
 *  - `reported`: reported or quoted speech (…하래, …하라고 했어, …해 달래, …하자고 했었지, "…해줘 했더니", told me to);
 *  - `negation`: Korean per clause (the last clause, or a negated clause that names the entry's action), English anywhere;
 *  - `retraction`: a request followed by a bare retraction ("…추가해줘 취소", "…완료 ㄱㄱ 아니 취소", "철회", "그만해");
 *  - `question`: a question mark without a polite request form, a how-to or wh-question, a capability or deliberation
 *    form ("할 수 있어", "할까", "할지"), an interrogative ending;
 *  - `conditional`: a hypothetical or conditional (-면, -거든, 만약, if, unless, wish);
 *  - `statement`: a past or report statement (a finite past form, "already", is/was/did …, a thank-you for a done act);
 *  - `volition`: first-person volition or obligation ("추가할게", "내가 할래", "취소하려고", "해야지", "I'll"). The owner
 *    said "추가할게" means the owner will do it: not Quoky's job, so `none`, never a question.
 * Pure; the text is never logged.
 */
export type NlRequestVeto = 'example' | 'reported' | 'negation' | 'retraction' | 'question' | 'conditional' | 'statement' | 'volition';

/** Korean negators (a standalone or glued 안/못, -지 마/말/않, 금지, 아니, 필요 없, 싫, 말고 …), as in A6 R1. */
const NEGATION_KO = /[지진](?:는|도|만)?\s*(?:마|말|않)|(?:^|\s)(?:안|못)(?=\s|$|되|돼|됐|해|했|하|할)|안\s*(?:해|하|되|돼|됐|할|함)|(?<!잘)못\s*(?:해|하|했|함)|금지|아니|아냐|아님|ㄴㄴ|노노|됐어|됐다|잠깐|필요\s*없|싫|말아|말고/u;
const NEGATION_EN = /(?:^|\s)(?:don't|dont|do not|doesn't|didn't|shouldn't|won't|wouldn't|can't|cannot|never|not|no|nope|nah)(?=\s|$|[,.!?])/u;
/** A negator that spans a clause boundary of the split below ("필요 | 없어", "하지 | 마"). */
const SPANNING_NEGATION = /필요\s*없|[지진](?:는|도|만)?\s*(?:마|말|않)|안\s*(?:해|하|되|돼|됐|할|함)/u;
/** A clause that starts with the negator of the clause before it ("추가하지 | 마"). */
const NEGATOR_START = /^(?:마|말|않)/u;
const EXAMPLE_FRAME = /예를\s*들어|예컨대|for example|e\.g\./u;

/** Where a Korean clause ends: sentence punctuation, 말고, or a word in a sentence-final or connective ending + space. */
const KO_CLAUSE_BOUNDARY = /[,.!?。;:~\n]|말고|(?:야|어|요|다|래|니|게|지|음|함|돼|대|줘|자)(?=\s)/gu;
/** A clause of laughter, emoticons or punctuation only ("ㅋㅋ", "ㅠㅠ", "^^"): no clause of its own. */
const LAUGHTER_ONLY = /^[ㅋㅎㅠㅜㅡ^~.!?,…\s\p{Extended_Pictographic}\uFE0F\u200D]*$/u;
/** Trailing emoticon jamo, emoji and punctuation on a word ("했어ㅋㅋ", "추가!!"); ㄱㄱ alone is such a word too. */
const WORD_NOISE = /[\u3131-\u318e\p{Extended_Pictographic}\uFE0F\u200D~^!.?,…:;"'“”‘’()[\]]+$/u;

// reported speech: a quoted request, the quotative -라고/-자고/-달라고/-냐고/-다고 + a speech verb, a hearsay ending, and
// the contracted quotatives on the light verb 하, the linking vowel 으, 달(라) and 주 (하래, 넣으래, 해 달래, 해 주래, 하재).
const QUOTED_REQUEST_KO = /(?:줘|주세요|줄래|해)\s*(?:했던|했잖아|했는데|했더니|했어|했지|했다|했었|라고|이라고|라는|란|하면|하고|그랬|하길래|해서|하니까|하더라|하던데|하셨)/u;
const QUOTATIVE_KO = /(?:라|자|달라|냐|다)고\s*(?:했|하더|하던|하셨|하시|하네|하대|해서|하길래|하니까|그러|그랬|말했|들었|한다|합니다|하는데|해)|(?:라|다)(?:는데|던데|더라)/u;
const CONTRACTED_QUOTATIVE_KO = /(?:하|으|달|주)(?:래|래요|래서|랬|라셔|라시|란다|재|재요)(?=$|[\s.!?~,]|[\u3131-\u318e])/u;
const REPORTED_EN = /\b(?:told|asked|wants?|wanted|said|says)\s+(?:(?:me|us|him|her|them)\s+)?to\b/u;

// questions
const QUESTION_MARK = /[?？]/u;
/** A polite request form may carry a question mark ("해줄래?", "해 줄 수 있어?", "can you … ?"). */
const POLITE_REQUEST = /줄래|줄\s*수\s*있|주실래|주시겠|주실\s*수|주시면|부탁|^(?:please\s+)?(?:can|could|would|will)\s+you\b|\bplease\b/u;
/** How-to and wh-forms (closed interrogatives). */
const HOWTO_WH_KO = /어떻게|어케|는\s*법(?=$|\s|[?.!~]|이|을|은|좀)|방법|하려면|뭐라고|뭐야|뭔지|뭐지|뭘|무엇|무슨|어디|언제|누가|누구|왜|몇|어느|어떤/u;
/** Capability ("할 수 있어" without 줄), deliberation ("할까", "줄까") and "whether" ("할지"). */
const CAPABILITY_DELIBERATION_KO = /(?:할|될)\s*수\s*(?:있|없)|(?:할|될|볼|줄|을|일|걸)까(?=$|\s|요|[.!~])|(?:할|될|을)지(?=$|\s)/u;
/** An interrogative sentence ending on the last word ("완료하니", "취소했나요", "끝났냐"). */
const INTERROGATIVE_ENDING_KO = /(?:(?<!더)니|나요|냐|냐고|는가|은가|던가)$/u;
const QUESTION_EN = /(?:^|[,.;!?]\s*)(?:how|what|why|when|where|who|which|whose)\b|\bhow\s+(?:to|do|can|does|should)\b/u;

// conditionals and hypotheticals
const CONDITIONAL_KO = /(?:면|거든|더라면)(?=$|[\s,.!?~]|요)|만약|만일|(?:할|될|을)\s*경우/u;
const CONDITIONAL_EN = /\b(?:if|unless|in case|suppose|supposing|whenever|wish|would have|could have|should have)\b/u;

// statements: after the past marker (았/었/였/했 and contractions) only a finite sentence ending may follow
const FINITE_AFTER_PAST = /^(?:|어|어요|어용|다|지|지요|죠|네|네요|음|습니다|군|군요|구나|잖아|잖아요|더라|더라고|던데|더니)$/u;
/** A thank-you or a report of a done act ("알려줘서 고마워"). */
const DONE_FOR_ME_KO = /줘서(?=$|\s)/u;
/**
 * An existential or copular predicate ends the sentence ("추가 질문 있어", "2번은 회의야"): a statement. "줄 수 있어"
 * (a polite request) is excluded by its 수.
 */
const EXISTENTIAL_LAST = /^(?:있|없)(?:어|어요|다|음|습니다|네|네요|지)$|(?:이야|이에요|예요|입니다|이다)$/u;
/** A request ending anywhere in the frame (only to decide whether an adnominal mention stands alone). */
const REQUEST_ENDING_KO = /(?:줘|줘요|주세요|주십시오|줄래|줄래요|주실래요|주시겠|해라|하자|하세요|둬|놔|부탁)(?=$|\s|[.!?~,])/u;
const STATEMENT_EN = /(?:^|\s)(?:is|are|was|were|did|does|has|have|had|been|it's|i'm|i've)(?=\s|$|[,.!?])|\balready\b|\bused to\b/u;

// volition and obligation
const FIRST_PERSON_KO = /(?:^|\s)(?:내가|제가|나는|저는|나도|저도)(?=\s)/u;
/** -(으)ㄹ게 / -(으)ㄹ께: a syllable with the final ㄹ, then 게/께 (+요) ends the word. */
const PROMISE_ENDING = /(?:게|께)(?:요)?$/u;
/** The causative -게 하다 / -게 만들다 is not a promise ("알게 해줘"). */
const CAUSATIVE_NEXT = /^(?:해|하|만들|돼|되)/u;
const INTENTION_KO = /려고(?=$|\s|요|[.!?~,])|야지(?=$|\s|요|[.!?~,])|야겠|겠지|려나/u;
/** The obligation -아/어야 하다 as the sentence's own finite predicate ("2번 완료해야 해"); "해야 할 일" is a noun phrase. */
const OBLIGATION_KO = /야\s*(?:해|해요|한다|합니다|돼|돼요|된다|됩니다|됨|함|하나|하나요|되나|돼나)$/u;
/** -(으)ㄹ 거야: future intention on the last clause ("추가할 거야"). */
const FUTURE_INTENTION_KO = /\s(?:거야|거예요|거에요|거임|겁니다|거다|꺼야)$/u;
const VOLITION_EN = /(?:^|[,.;!?]\s*)(?:i|we)\s|\bi'll\b|\bi will\b|\bi'm going to\b|\bwe'll\b|\blet me\b|\bi'd\b/u;

/** The final consonant index of a Hangul syllable (0 = none, 4 = ㄴ, 8 = ㄹ), or -1 for anything else. */
function finalConsonant(char: string | undefined): number {
  if (char === undefined) return -1;
  const code = char.charCodeAt(0) - 0xac00;
  return code < 0 || code > 11171 ? -1 : code % 28;
}

function wordsOf(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((word) => word.replace(WORD_NOISE, ''))
    .filter((word) => word.length > 0);
}

/** The Korean clauses of `text`, trimmed, empty ones dropped. */
function clausesOf(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  for (const match of text.matchAll(KO_CLAUSE_BOUNDARY)) {
    const end = (match.index ?? 0) + match[0].length;
    clauses.push(text.slice(start, end));
    start = end;
  }
  clauses.push(text.slice(start));
  // Trailing punctuation goes; jamo stay (a clause "ㄴㄴ" is a negation), but a clause of laughter alone is dropped.
  return clauses.map((clause) => clause.replace(/[\s.,!?~;:…"'“”‘’()[\]]+$/u, '').trim()).filter((clause) => clause.length > 0 && !LAUGHTER_ONLY.test(clause));
}

function names(clause: string, words: readonly string[]): boolean {
  return words.some((word) => clause.includes(normalizeForMatch(word)));
}

/** A finite past form: the last past marker of the word is followed only by a sentence-final ending ("완료했어", "놨다"). */
function isFinitePast(word: string): boolean {
  const chars = Array.from(word);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (isPastSyllable(chars[index])) return FINITE_AFTER_PAST.test(chars.slice(index + 1).join(''));
  }
  return false;
}

/** An adnominal form (a modifier): the last syllable has the final ㄴ, or is 던 / 는 ("완료된거", "추가한", "취소했던"). */
function isAdnominal(word: string): boolean {
  const chars = Array.from(word.replace(/(?:거|걸|건|것|게)$/u, ''));
  const last = chars.at(-1);
  return finalConsonant(last) === 4 || last === '던' || last === '는';
}

/** A verb in its adnominal 는 form ("추가하는"): not a topic particle. */
function isAdnominalVerb(word: string): boolean {
  return /(?:하|되|있|없|주|두|놓)는$/u.test(word);
}

/** An embedded question: -는지 / -(으)ㄴ지 / -인지 ("완료됐는지", "취소인지"). */
function isEmbeddedQuestion(word: string): boolean {
  const chars = Array.from(word);
  return chars.at(-1) === '지' && (chars.at(-2) === '는' || chars.at(-2) === '던' || finalConsonant(chars.at(-2)) === 4);
}

/** A retraction stem: a command made of it ("취소 취소") cancels the cancel (an undo), it is not retracted. */
const RETRACTION_STEM = /취소|캔슬|철회|되돌|cancel|undo/u;

/**
 * A word that issues a command before a retraction: a request ending, ㄱㄱ / 고고, or an action word (Latin: the whole
 * word) in its nominal or verbal, not adnominal, form. A retraction stem itself never counts.
 */
function isCommandWord(raw: string, actionWords: readonly string[]): boolean {
  if (/^(?:ㄱㄱ|고고)/u.test(raw)) return true;
  const word = raw.replace(WORD_NOISE, '');
  if (RETRACTION_STEM.test(word)) return false;
  if (/(?:줘|줘요|주세요|줄래|해|해요|하자|둬|놔|부탁)$/u.test(word)) return true;
  const holds = (action: string): boolean => (/^[a-z0-9 -]+$/u.test(action) ? word === action : word.includes(action));
  if (!actionWords.some((action) => holds(normalizeForMatch(action)))) return false;
  const last = Array.from(word).at(-1);
  // An adnominal form names an earlier act ("추가한 거", "완료했던 거", "취소된 알림"): no command.
  return !(finalConsonant(last) === 4 || last === '던' || last === '는');
}

const RETRACTION_FINAL = /^(?:취소|취소요|캔슬|철회|아니|아니야|아냐|아님|ㄴㄴ|노노|됐어|됐다|잠깐|그만|그만해|nope|nah|cancel|undo)$/u;
const RETRACTION_ANYWHERE = /철회|그만\s*(?:해|하|둬|두)/u;

/**
 * The veto class of a LOCAL_WRITE frame, or `undefined` when the frame is a request shape. `frame` is the owner's prose
 * without the selector's content spans; `entryWords` the entry's own action words and `actionWords` every entry's (both
 * used only to VETO: a negated clause that names the action, a command before a retraction). `tail`, when the content
 * span ends the message undelimited (no quote or colon before it), is that span: its negation or question mark still
 * counts, so a span cannot swallow "…추가하지 마".
 */
export function nlRequestVeto(frame: string, entryWords: readonly string[], actionWords: readonly string[], tail?: string): NlRequestVeto | undefined {
  const text = normalizeForMatch(frame).replace(/[’‘`´]/gu, "'");
  if (EXAMPLE_FRAME.test(text)) return 'example';
  if (QUOTED_REQUEST_KO.test(text) || QUOTATIVE_KO.test(text) || CONTRACTED_QUOTATIVE_KO.test(text) || REPORTED_EN.test(text)) return 'reported';

  const clauses = clausesOf(text);
  const negated = (index: number): boolean =>
    NEGATION_KO.test(clauses[index] ?? '') || NEGATOR_START.test(clauses[index + 1] ?? '') || (index > 0 && NEGATOR_START.test(clauses[index] ?? ''));
  const tailText = tail === undefined ? undefined : normalizeForMatch(tail);
  if (NEGATION_EN.test(text) || (tailText !== undefined && (NEGATION_KO.test(tailText) || NEGATION_EN.test(tailText)))) return 'negation';
  if (clauses.length > 0 && negated(clauses.length - 1)) return 'negation';
  if (clauses.length > 1 && SPANNING_NEGATION.test(`${wordsOf(clauses.at(-2) ?? '').at(-1) ?? ''} ${clauses.at(-1) ?? ''}`)) return 'negation';
  if (clauses.some((clause, index) => negated(index) && names(clause, entryWords))) return 'negation';

  const rawWords = text.split(/\s+/u).filter((word) => word.length > 0);
  const words = wordsOf(text);
  const last = words.at(-1);
  if (RETRACTION_ANYWHERE.test(text)) return 'retraction';
  if (last !== undefined && RETRACTION_FINAL.test(last) && rawWords.slice(0, -1).some((word) => isCommandWord(word, actionWords))) return 'retraction';

  const polite = POLITE_REQUEST.test(text);
  if ((QUESTION_MARK.test(text) || (tailText !== undefined && QUESTION_MARK.test(tailText))) && !polite) return 'question';
  if (HOWTO_WH_KO.test(text) || CAPABILITY_DELIBERATION_KO.test(text) || QUESTION_EN.test(text)) return 'question';
  if (last !== undefined && INTERROGATIVE_ENDING_KO.test(last)) return 'question';

  if (CONDITIONAL_KO.test(text) || CONDITIONAL_EN.test(text)) return 'conditional';

  // The last clause carries the sentence's own predicate (Korean is head-final): an earlier past or intention clause is a
  // reason ("3번 끝났어 완료로 바꿔줘", "해야 할 일에 … 올려줘", "it's done, mark it complete").
  const lastClause = clauses.at(-1) ?? '';
  if (wordsOf(lastClause).some(isFinitePast) || DONE_FOR_ME_KO.test(lastClause) || STATEMENT_EN.test(lastClause)) return 'statement';
  const lastWords = wordsOf(lastClause);
  // A copular sentence with its 이다 elided ends on a topic-marked noun ("할 일 제목은 '보고서 마감'"): a statement.
  const lastWord = words.at(-1) ?? '';
  if (Array.from(lastWord).length >= 2 && /[은는]$/u.test(lastWord) && !isAdnominalVerb(lastWord)) return 'statement';
  if (EXISTENTIAL_LAST.test(lastWords.at(-1) ?? '') && !/수$/u.test(lastWords.at(-2) ?? '') && !/수(?:있|없)/u.test(lastWords.at(-1) ?? '')) return 'statement';
  // The entry's action named only as a modifier or an embedded question ("2번 완료된거 맞아", "2번 완료됐는지 보여줄래?"):
  // the sentence is about the item's state, not a request for the action.
  const mentions = words.filter((word) => entryWords.some((action) => !/^[a-z0-9 -]+$/u.test(action) && word.includes(normalizeForMatch(action))));
  if (mentions.length > 0 && mentions.every(isEmbeddedQuestion)) return 'question';
  if (mentions.length > 0 && mentions.every(isAdnominal) && !REQUEST_ENDING_KO.test(text)) return 'statement';

  if (FIRST_PERSON_KO.test(text) || INTENTION_KO.test(lastClause) || OBLIGATION_KO.test(text.replace(WORD_NOISE, '')) || FUTURE_INTENTION_KO.test(lastClause) || VOLITION_EN.test(lastClause)) return 'volition';
  // A promise ends its sentence: the last word, or a word followed by punctuation ("추가할게. 도서관 책 반납"). An adverbial
  // -게 inside a sentence ("길게 적어줘") or the causative "-게 해줘" is no promise.
  const spoken = rawWords.map((raw) => ({ raw, word: raw.replace(WORD_NOISE, '') })).filter((entry) => entry.word.length > 0);
  for (const [index, { raw, word }] of spoken.entries()) {
    const chars = Array.from(word.replace(/요$/u, ''));
    const promise = PROMISE_ENDING.test(word) && finalConsonant(chars.at(-2)) === 8;
    const endsSentence = index === spoken.length - 1 || raw !== word;
    if (promise && endsSentence && !CAUSATIVE_NEXT.test(spoken[index + 1]?.word ?? '')) return 'volition';
  }
  return undefined;
}
