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
 *  - `conditional`: a hypothetical or conditional (-면, -거든, 만약, if, unless);
 *  - `wish`: a wish or a hedge (-고 싶다, 바래, 희망, should I, maybe, would be nice);
 *  - `deferred`: deferred timing (회의 끝나고, -고 나서, -ㄴ 뒤에, 나중에, after the meeting, later): not now, so none;
 *  - `statement`: a past or report statement (a finite past form or is/was/did … with no request after it, a plain
 *    declarative -다 on the last word, a thank-you for a done act);
 *  - `volition`: first-person volition or obligation ("추가할게", "내가 할래", "취소하려고", "해야지", "I'll"). The owner
 *    said "추가할게" means the owner will do it: not Quoky's job, so `none`, never a question.
 * Pure; the text is never logged.
 */
export type NlRequestVeto = 'example' | 'joke' | 'reported' | 'negation' | 'retraction' | 'question' | 'conditional' | 'wish' | 'deferred' | 'statement' | 'volition';

/**
 * Korean negators that negate the request itself: 안/못 + the light verb (안 해, 못 해), 금지, 아니, 필요 없, 싫, 말고, 됐어 ….
 * The verb negators -지 마/말/않 and 안/못 + a content verb are SCOPED (CA round 3): they negate the verb right before or
 * after them, so they veto only when that verb is the light verb 하/되 or an action word ("야식 먹지 않기" is content).
 */
const NEGATION_KO = /(?:^|\s)(?:안|못)(?=\s*(?:되|돼|됐|해|했|하|할|함)|$)|안\s*(?:해|하|되|돼|됐|할|함)|(?<!잘)못\s*(?:해|하|했|함)|금지|아니|아냐|아님|ㄴㄴ|노노|됐어|됐다|잠깐|필요\s*없|싫|말고/u;

const NEGATION_EN = /(?:^|\s)(?:don't|dont|do not|doesn't|didn't|shouldn't|won't|wouldn't|can't|cannot|never|not|no|nope|nah)(?=\s|$|[,.!?])/u;
/** Exclusion markers ("그거 말고 이거", "그거 대신", "그거 빼고", "not that one, this one", "instead of", "except", "rather than"). */
const EXCLUSION_KO = /말고|아니고|빼고|대신|제외/u;
const EXCLUSION_EN = /(?:^|[^a-z])(?:not|instead|except|rather than)(?![a-z])/u;
/** The scoped Korean verb negators (-지 마 / -지 말 / -지 않). */
const VERB_NEGATION_KO = /지\s*(?:마|말|않)/u;

/**
 * Whether the owner's prose holds any exclusion or negation marker anywhere: the exclusion markers above, the request-shape
 * Korean and English negators and the scoped verb negators. No scope is read: a caller that only narrows a value when the
 * prose is plain (the `item.summarize` recency grounding) keeps the selector's value whenever this is true (fail-safe).
 */
export function nlHasExclusionOrNegation(prose: string): boolean {
  const text = normalizeForMatch(prose);
  return EXCLUSION_KO.test(text) || NEGATION_KO.test(text) || VERB_NEGATION_KO.test(text) || EXCLUSION_EN.test(text) || NEGATION_EN.test(text);
}

/** A negator that spans a clause boundary of the split below ("필요 | 없어"); "하지 | 마" is the scoped verb negator. */
const SPANNING_NEGATION = /필요\s*없|안\s*(?:해|하|되|돼|됐|할|함)/u;
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
const QUOTATIVE_KO = /(?:라|자|달라|냐|다)고\s*(?:했|하더|하던|하셨|하시|하네|하대|해서|하길래|하니까|그러|그랬|말했|들었|한다|합니다|하는데|해(?!\s*(?:줘|주세요|줄래|주실|주시|줘요))|전해|전달|말해|얘기해|이야기해)|(?:라|다)(?:는데|던데|더라)/u;
// The past 랬 is hearsay with any ending after it (달랬어, 하랬는데, 주랬잖아); the present 래 also before the connective
// 는데 (달래는데): the same contracted quotative followed by a connective, never a phrase (A6 R2 review, CA P3).
const CONTRACTED_QUOTATIVE_KO = /(?:하|으|달|주)(?:(?:래|래요|래서|라셔|라시|란다|재|재요)(?=$|[\s.!?~,]|[\u3131-\u318e]|는데)|랬)/u;
/**
 * The word-final contracted quotatives (하래, 달래, 주래, 으래 … at a word end): hearsay wherever a content span puts them
 * (CA review: "김 대리가 보고서 작성하래 추가" as a title is still reported). Only the forms that go on inside the word
 * and modify a noun (-랬던, -래는데, -랬다는) are exempt inside a content span.
 */
const CONTRACTED_QUOTATIVE_FINAL_KO = /(?:하|으|달|주)(?:래|래요|래서|랬|라셔|라시|란다|재|재요)(?=$|[\s.!?~,]|[\u3131-\u318e])/u;
/** A quoted segment of the frame (content spans already removed): '…', "…", “…”, ‘…’, 「…」, 『…』. */
const QUOTED_SEGMENT = /'([^']+)'|"([^"]+)"|“([^”]+)”|‘([^’]+)’|「([^」]+)」|『([^』]+)』/gu;
const REPORTED_EN = /\b(?:told|asked|wants?|wanted|said|says)\s+(?:(?:me|us|him|her|them)\s+)?to\b|\b(?:you|someone|somebody|they|he|she)\s+(?:should|must|might|could|said|says|told|wants?|wanted)\b/u;
/**
 * A joke or a tease (CA round 3): never an instruction. The closed class of joke nouns (농담, 장난; English joke) frames
 * the utterance as not serious in two grammatical slots: as the predicate with the copula ("장난이야", "장난임") or as the
 * manner adverbial of the act, the instrumental -(으)로 or 삼아 ("장난으로 알림 걸어줘", "장난삼아", "as a joke",
 * "jokingly"; live test 2026-10-16 I16). 장난 counts only as a word of its own: a compound ("장난감", "말장난") is another
 * noun.
 */
const JOKE = /농담|(?<![가-힣])장난(?:이야|이에요|이었어|이었음|임|이지|으로|삼아)(?![가-힣])|같은\s*소리|\bjk\b|\bj\/k\b|\bkidding\b|\bjust joking\b|\bjokingly\b|\bas a joke\b/u;

// questions
const QUESTION_MARK = /[?？]/u;
/** A polite request form may carry a question mark ("해줄래?", "해 줄 수 있어?", "can you … ?"). */
const POLITE_REQUEST = /줄래|줄\s*수\s*있|주실래|주시겠|주실\s*수|주시면|부탁|^(?:please\s+)?(?:can|could|would|will)\s+you\b|\bplease\b/u;
/** How-to and wh-forms (closed interrogatives). */
const HOWTO_WH_KO = /어떻게|어케|는\s*법(?=$|\s|[?.!~]|이|을|은|좀)|방법|하려면|뭐라고|뭐야|뭔지|뭐지|뭘|무엇|무슨|어디|언제|누가|누구|왜|몇|어느|어떤/u;
/** Capability ("할 수 있어" without 줄), deliberation ("할까", "줄까") and "whether" ("할지"). */
const CAPABILITY_DELIBERATION_KO = /(?:할|될)\s*수\s*(?:있|없)|(?:할|될|볼|줄|을|일|걸)까(?=$|\s|요|[.!~])|(?:할|될|을)지(?=$|\s)/u;
/** -(으)ㄹ까 on any verb ("완료해 버릴까"): a syllable with the final ㄹ, then 까(요). */
const DELIBERATION_TAIL = /까(?:요)?$/u;
/** An interrogative sentence ending on the last word ("완료하니", "취소했나요", "끝났냐"). */
const INTERROGATIVE_ENDING_KO = /(?:(?<!더)니|나요|냐|냐고|는가|은가|던가)$/u;
const QUESTION_EN = /(?:^|[,.;!?]\s*)(?:how|what|why|when|where|who|which|whose)\b|\bhow\s+(?:to|do|can|does|should)\b/u;

// wishes, hedges and deferred timing
const WISH_KO = /싶|바래|바라|바랍|희망|아마(?=$|\s)|듯(?=$|\s|해|하|함|요|싶|[.!~])|(?:^|\s)각(?=$|\s|[.!~ㅋㅎ])/u;
const WISH_EN = /\bshould i\b|\bmaybe\b|\bperhaps\b|\bprobably\b|\bmight\b|thinking (?:of|about)|would be nice|\bi wish\b|\bi hope\b|\bhopefully\b/u;
/** -고 나서, the aspectual 끝나고 / 마치고, 나중에, 이따(가) without a time of its own; English after / later / once. */
const DEFERRED_KO = /고\s*나서|(?:끝나|마치|끝내)고(?=$|\s)|나중에|이따가?(?=$|\s)(?!\s*\d)/u;
const DEFERRED_EN = /\b(?:after|later|once)\b/u;

// conditionals and hypotheticals
const CONDITIONAL_EN = /\b(?:if|unless|in case|suppose|supposing|whenever|would have|could have|should have)\b/u;

// statements: after the past marker (았/었/였/했 and contractions) only a finite sentence ending may follow
const FINITE_AFTER_PAST = /^(?:|어|어요|어용|다|지|지요|죠|네|네요|음|습니다|군|군요|구나|잖아|잖아요|더라|더라고|던데|더니)$/u;
/** A plan, not a request ("2번 완료 예정"). */
const PLANNED_KO = /예정(?=$|\s|이|임|입니다|[.!~])/u;
/** A report ending on the last word: -함 / -됨, or a past or existential stem + 음 ("추가함", "필요함", "다녀왔음"). */
const REPORT_ENDING_LAST = /(?:함|됨)$|(?:했|됐|었|았|였|있|없|겠)음$/u;
/** A thank-you or a report of a done act ("알려줘서 고마워"). */
const DONE_FOR_ME_KO = /(?:줘서|주셔서)(?=$|\s)|서\s*다행/u;
/** An afterthought that turns on the request ("2번 완료해줘. 아 근데 그거 아직이네"): a later clause led by but/actually. */
const AFTERTHOUGHT = /^(?:아\s*)?(?:근데|그런데|하지만|but\b|actually\b).*(?:네|네요|다|어|지|구나|잖아|yet|not)$/u;
/**
 * An existential or copular predicate ends the sentence ("추가 질문 있어", "2번은 회의야"): a statement. "줄 수 있어"
 * (a polite request) is excluded by its 수.
 */
const EXISTENTIAL_LAST = /^(?:있|없)(?:어|어요|다|음|습니다|네|네요|지)$|(?:이야|이에요|예요|입니다|이다)$/u;
/** A request ending anywhere in the frame (only to decide whether an adnominal mention stands alone). */
const REQUEST_ENDING_KO = /(?:줘|줘요|주세요|주십시오|줄래|줄래요|주실래요|주시겠|해라|하자|하세요|둬|놔|부탁)(?=$|\s|[.!?~,])/u;
/** A word that is itself a request (an ending of the closed request class), without needing an action word. */
const REQUEST_WORD_KO = /(?:줘|줘요|주세요|주십시오|줄래|줄래요|주실래요|주시겠어요|해라|하자|하세요|둬|둬요|놔|놔요|부탁|부탁해|부탁해요|부탁드려요|부탁드립니다)$/u;
/** English request signals at a clause start (for a statement followed by a request: "it's done, mark it complete"). */
const EN_REQUEST_SIGNAL = /^(?:please\b|(?:can|could|would|will)\s+you\b|(?:mark|set|make|put|turn)\b)/u;
/** Korean hearsay on a clause's last word: -(으)ㄴ대 / -는대 / -았대 ("완료한대", "취소했대"), -ㄹ 거래. */
const HEARSAY_TAIL = /대(?:요)?$/u;
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
/** English volition only in its explicit forms (CA round 3): a reason clause "I need it" is no volition. */
const VOLITION_EN = /\bi'll\b|\bi will\b|\bi'm going to\b|\bwe'll\b|\blet me\b/u;

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

/** A retraction stem: a bare one ("취소 취소") cancels the cancel (an undo); with a request ending it is a command. */
const RETRACTION_STEM = /취소|캔슬|철회|되돌|cancel|undo/u;

function holdsActionWord(word: string, actionWords: readonly string[]): boolean {
  return actionWords.some((raw) => {
    const action = normalizeForMatch(raw);
    return /^[a-z0-9 -]+$/u.test(action) ? word === action : word.includes(action);
  });
}

/**
 * The scoped verb negators of a clause (CA round 3): -지 마/말/않 negates the verb right before it (with the noun before a
 * light-verb form: "완료 처리하지 마"), 안/못 the verb right after it. A negation counts only when that verb is the light
 * verb 하/되 alone or holds an action word; `before` is the last word of the previous clause, for a negator split off
 * ("추가하지 | 마").
 */
function verbNegated(clause: string, actionWords: readonly string[], before = ''): boolean {
  const words = clause.split(/\s+/u).filter((word) => word.length > 0);
  const negatesAt = (index: number, stemEnd: number): boolean => {
    const token = index >= 0 ? (words[index] ?? '') : before;
    const stem = token.slice(0, stemEnd < 0 ? token.length : stemEnd);
    // The light verbs and the closed generic do-verbs (실행, 진행, 처리): "하지 마", "아직 실행하지는 마".
    if (/^(?:하|되|해)?$/u.test(stem) || /^(?:실행|진행|처리)(?:하|되)?$/u.test(stem)) return true;
    const previous = index > 0 ? (words[index - 1] ?? '') : index === 0 ? before : '';
    const phrase = `${previous} ${stem}`;
    return holdsActionWord(phrase, actionWords) || phrase.split(/\s+/u).some((word) => holdsActionWord(word, actionWords));
  };
  // The prohibitive -지 마 / -지 말아(라) / -지 마세요 is addressed to Quoky: it always negates the request. The descriptive
  // -지 않- and the nominal -지 말기 / -지 않기 negate only their own verb ("야식 먹지 않기" is content).
  if (/[지진](?:는|도|만)?\s*(?:마(?![가-힣])|마요|마세요|마라|말아|말라)/u.test(clause) || /^(?:마(?![가-힣])|마요|마세요|마라|말아|말라)/u.test(clause) && /[지진](?:는|도|만)?$/u.test(before)) return true;
  for (const [index, word] of words.entries()) {
    const own = /[지진](?:는|도|만)?(?:마|말|않)/u.exec(word);
    if (own !== null) {
      if (negatesAt(index, own.index)) return true;
      continue;
    }
    if (/^(?:마|말|않)/u.test(word) && index > 0) {
      const previous = words[index - 1] ?? '';
      const tail = /[지진](?:는|도|만)?$/u.exec(previous);
      if (tail !== null && negatesAt(index - 1, tail.index)) return true;
    }
    if (/^(?:마|말|않)/u.test(word) && index === 0) {
      const tail = /[지진](?:는|도|만)?$/u.exec(before);
      if (tail !== null && negatesAt(-1, tail.index)) return true;
    }
    if (/^(?:안|못)$/u.test(word)) {
      const next = words[index + 1] ?? '';
      if (next === '' || /^(?:하|해|되|돼|됐|했|할|함)/u.test(next) || holdsActionWord(next, actionWords)) return true;
    }
  }
  return false;
}

/** Whether a Korean clause negates the request (the unscoped negators, or a scoped verb negator on the action). */
function negatesKo(clause: string, actionWords: readonly string[], before = ''): boolean {
  return NEGATION_KO.test(clause) || verbNegated(clause, actionWords, before);
}

/**
 * A word that issues a command: ㄱㄱ / 고고, a request ending, or an action word (Latin: the whole word) in its nominal or
 * verbal, not adnominal, form. A bare retraction stem ("취소") is no command; "취소해줘" is (Codex P2).
 */
function isCommandWord(raw: string, actionWords: readonly string[]): boolean {
  if (/^(?:ㄱㄱ|고고)/u.test(raw)) return true;
  const word = raw.replace(WORD_NOISE, '');
  if (REQUEST_WORD_KO.test(word) || (/(?:해|해요)$/u.test(word) && holdsActionWord(word, actionWords))) return true;
  if (RETRACTION_STEM.test(word)) return false;
  if (!holdsActionWord(word, actionWords)) return false;
  const last = Array.from(word).at(-1);
  // An adnominal form names an earlier act ("추가한 거", "완료했던 거", "취소된 알림"): no command.
  return !(finalConsonant(last) === 4 || last === '던' || last === '는');
}

/** Whether a clause makes a request of its own (a request word, an action word as a command, or an English request lead). */
function requestsSomething(clause: string, actionWords: readonly string[]): boolean {
  return EN_REQUEST_SIGNAL.test(clause.trim()) || clause.split(/\s+/u).some((word) => word.length > 0 && isCommandWord(word, actionWords));
}

/**
 * A quoted text that is itself a request: it ENDS in a request or imperative form ("1번 완료 처리해줘", "지워", "추가하자")
 * or, in English, starts with a request lead or an action verb ("please add this …"). An action noun inside a content phrase
 * ("보고서 추가 검토") or a nominal ending ("작업 완료", "추가하기") is content, not a quoted command (Codex P2).
 */
function isQuotedRequest(inner: string, actionWords: readonly string[]): boolean {
  const words = wordsOf(inner);
  // A finite request form anywhere in the quoted clause ("2번 완료해줘 지금", Codex P2): a request ending, a 하다 verb of
  // an action word, or a Korean action verb in its own imperative ending ("지워", "되돌려", "꺼"). A verbal noun ("추가",
  // "완료") or a nominalised form ("추가하기") is content.
  for (const word of words) {
    if (REQUEST_WORD_KO.test(word)) return true;
    if (/(?:해|해요|하세요|해라|하자|합시다)$/u.test(word) && holdsActionWord(word, actionWords)) return true;
    if (holdsActionWord(word, actionWords) && /[가-힣]$/u.test(word) && /(?:어|아|워|려|빼|꺼|줘)$/u.test(word)) return true;
  }
  const first = words[0] ?? '';
  return EN_REQUEST_SIGNAL.test(inner.trim()) || (/^[a-z]+$/u.test(first) && holdsActionWord(first, actionWords));
}

const RETRACTION_FINAL = /^(?:취소|취소요|캔슬|철회|아니|아니야|아냐|아님|ㄴㄴ|노노|됐어|됐다|잠깐|그만|그만해|nope|nah|cancel|undo)$/u;
const RETRACTION_ANYWHERE = /철회|그만\s*(?:해|하|둬|두)/u;

/** A negated clause (Korean) that names one of `words`: the owner refused that action somewhere ("2번 취소하지 마 3번 빼줘"). */
function negatedClauseNames(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const clauses = clausesOf(text);
  return clauses.some(
    (clause, index) =>
      (negatesKo(clause, words, wordsOf(clauses[index - 1] ?? '').at(-1) ?? '') || verbNegated(clauses[index + 1] ?? '', words, wordsOf(clause).at(-1) ?? '')) && names(clause, words),
  );
}

/** Where the selector's spans sit, for the veto: the content spans and the reminder time (deferral words in it are its time). */
export interface NlRequestSpans {
  /** The content spans (`title`, `body`, `match`) as the selector returned them; their own negated action always counts. */
  readonly content?: readonly string[];
  /** A reminder's `when` span. */
  readonly when?: string;
  /** The content spans a quote pair encloses: a quoted request as the content is the object of another verb (neg-090). */
  readonly quoted?: readonly string[];
  /**
   * Undelimited content that ends the message after the request word: exempt from the lexical and statement classes, but
   * its retraction, negation and joke still count (Codex P1: "할 일 추가해줘 우유 사기, 아니 취소").
   */
  readonly trailing?: readonly string[];
}

/**
 * Where the lexical classes (wh-words, conditional -면, wishes, deferral) may NOT fire: a hit that lies entirely inside a
 * content span still in the frame is the content's own ("할 일에 라면 추가해줘", "점심 먹은 후 약 먹기 1시에 알려줘",
 * "희망퇴직"); a hit that crosses the span's edge ("할 일 추가하는 | 법") or lies outside counts. A span that runs to the end of
 * the message without a request before it swallowed the predicate, so none of its words is exempt.
 */
function spanRegions(text: string, content: readonly string[]): Array<readonly [number, number]> {
  const regions: Array<readonly [number, number]> = [];
  for (const raw of content) {
    const span = normalizeForMatch(raw).replace(/[’‘`´]/gu, "'");
    if (span.length === 0) continue;
    for (let at = text.indexOf(span); at >= 0; at = text.indexOf(span, at + 1)) {
      if (/^[\s.!?~^ㅋㅎ]*$/u.test(text.slice(at + span.length))) continue;
      // A hit on a longer span's last word ("할 일 추가하는 법") is the sentence's, not the content's; a one-word span is content.
      const lastSpace = span.lastIndexOf(' ');
      regions.push([at, lastSpace < 0 ? at + span.length : at + lastSpace]);
    }
  }
  return regions;
}

function hitOutside(pattern: RegExp, text: string, regions: ReadonlyArray<readonly [number, number]>, inside?: (hit: string, start: number) => boolean): boolean {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const enclosed = regions.some(([from, to]) => start >= from && end <= to);
    // A one-word span that IS the veto word ("방법", "maybe", "나중에") is no content of its own.
    const whole = regions.some(([from, to]) => start === from && end === to && !/\s/u.test(text.slice(from, to)));
    if (!enclosed || whole || inside?.(match[0], start) === true) return true;
  }
  return false;
}

/** The word of `text` around position `at`. */
function wordAt(text: string, at: number): string {
  const from = text.lastIndexOf(' ', at) + 1;
  const to = text.indexOf(' ', at);
  return text.slice(from, to < 0 ? text.length : to);
}

/** Conditional -(으)면 only after a verb stem: a vowel-, ㄹ- or past-final syllable, or 으 ("냉면", "장면" are nouns). */
const CONDITIONAL_MYEON = /[^\s]*면(?=$|[\s,.!?~]|요)/gu;
const CONDITIONAL_OTHER = /만약|만일|(?:할|될|을)\s*경우|거든(?=$|[\s,.!?~]|요)|더라면/u;
function isConditionalWord(word: string): boolean {
  const chars = Array.from(word.replace(/[,.!?~]+$/u, '').replace(/요$/u, ''));
  if (chars.at(-1) !== '면' || chars.length < 2) return false;
  const before = chars.at(-2);
  const final = finalConsonant(before);
  return before === '으' || final === 0 || final === 8 || isPastSyllable(before);
}

/**
 * The Korean quotative and contracted quotative forms in the frame (…하라고 했어, …해 달래, …하랬는데, "…해줘 했더니"). A
 * contracted quotative inside a content span is the content's own, like the lexical classes ("엄마가 전화하랬던 거" as a
 * reminder body, "아기 달래는데" in a title); on the span's last word or outside every span it counts (CA review).
 */
function koreanQuotative(text: string, regions: ReadonlyArray<readonly [number, number]> = []): boolean {
  return QUOTED_REQUEST_KO.test(text) || QUOTATIVE_KO.test(text) || CONTRACTED_QUOTATIVE_FINAL_KO.test(text) || hitOutside(CONTRACTED_QUOTATIVE_KO, text, regions);
}

/**
 * A quoted command that is not this selection's content (a whole-message quote, a translation object): any command word,
 * a nominal one included ("2번 완료"). The selected content span itself is a quoted request only in a finite request form
 * ("보고서 추가 검토" is content, Codex P2).
 */
function quotedCommand(text: string, actionWords: readonly string[]): boolean {
  for (const match of text.matchAll(QUOTED_SEGMENT)) {
    const inner = match.slice(1).find((group) => group !== undefined) ?? '';
    if (requestsSomething(inner, actionWords) || isQuotedRequest(inner, actionWords)) return true;
  }
  return false;
}

/** Hearsay ends a clause: -(으)ㄴ대 / -는대 / -았대 ("민수가 2번 완료한대"), -ㄹ 거래. */
function hearsayEnding(clauses: readonly string[]): boolean {
  for (const clause of clauses) {
    const words = wordsOf(clause);
    const word = words.at(-1) ?? '';
    const before = Array.from(word.replace(HEARSAY_TAIL, '')).at(-1);
    if (HEARSAY_TAIL.test(word) && Array.from(word).length >= 2 && (finalConsonant(before) === 4 || before === '는' || isPastSyllable(before))) return true;
    if (/^거래(?:요)?$/u.test(word) && finalConsonant(Array.from(words.at(-2) ?? '').at(-1)) === 8) return true;
  }
  return false;
}

/**
 * A6 R2 ITEM_READ veto (final narrowing, review round 4): whether the owner relays someone else's request instead of making
 * one. Two structural forms only:
 *  - a quoted span that holds a request FORM (a request or imperative ending, or an English request lead or action verb
 *    first: {@link isQuotedRequest}) next to a reporting frame ({@link KO_REPORT_AFTER_QUOTE}, {@link EN_REPORT_BEFORE_QUOTE});
 *    a bare quoted noun ("\"요약\" 모드로") or an unframed quoted title is a label, not a command;
 *  - a Korean quotative or hearsay form (…해 달래, …하랬는데, …하라고 했어, …한대) that is the message-final predicate: it
 *    ends inside the last word, which may carry a connective tail (-는데, -거든, -서) and sentence punctuation. A hearsay
 *    form that modifies a noun ("엄마가 전화하랬던 부분까지 요약해줘") or sits before the owner's own final request
 *    ("팀장이 3번 요약해달래. 요약해줘": the owner asks, so it reads) does not relay.
 * The English "asked me to" is no relay for a read (it describes the item). Example, joke, retraction, negation and
 * statements stay with the selector. The LOCAL_WRITE `reported` class is unchanged.
 */
/**
 * The reporting frame of a quoted read command (Codex P2, round 6): a Korean quotative right after the closing quote
 * (…"라고 했어", …"이라고 적혀 있네", …" 하고 말했어, …" 했더니) or an English reporting verb right before the opening quote
 * (said / says / told me / wrote / asked / goes "…"), not one led by a relative pronoun (`email #1 that says "…"` describes
 * the item, Codex P2). Without one, a quoted span is a description or a title
 * (`email #1 about "open source"`, `titled "Read receipts"`) and never relays a request.
 */
const KO_REPORT_AFTER_QUOTE = /^\s*(?:(?:이)?라고|(?:하고\s*)?(?:했|하더|하셨|하시|말했|말하|그러|그랬|적혀|써|쓰))/u;
const EN_REPORT_BEFORE_QUOTE = /(?<!\b(?:that|which|who|whose)\s+)\b(?:said|says|say|told|tells|tell|wrote|writes|write|asked|asks|ask|goes|went)(?:\s+(?:me|us|him|her|them|you))?\s*[,:]?\s*$/u;

export function nlRelaysRequest(frame: string, actionWords: readonly string[]): boolean {
  const text = normalizeForMatch(frame).replace(/[\u2018\u2019`\u00b4]/gu, "'");
  for (const match of text.matchAll(QUOTED_SEGMENT)) {
    const start = match.index ?? 0;
    const framed = KO_REPORT_AFTER_QUOTE.test(text.slice(start + match[0].length)) || EN_REPORT_BEFORE_QUOTE.test(text.slice(0, start));
    if (framed && isQuotedRequest(match.slice(1).find((group) => group !== undefined) ?? '', actionWords)) return true;
  }
  // The final predicate: the last word once trailing punctuation, laughter and emoticons are set aside.
  const body = text.replace(/[\s.,!?~\u2026;:"'\u3131-\u318e^\p{Extended_Pictographic}\uFE0F\u200D]+$/u, '');
  const lastStart = body.lastIndexOf(' ') + 1;
  const endsInLast = (pattern: RegExp): boolean =>
    [...body.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].some((match) => (match.index ?? 0) + match[0].length > lastStart);
  if (endsInLast(QUOTED_REQUEST_KO) || endsInLast(QUOTATIVE_KO) || endsInLast(CONTRACTED_QUOTATIVE_KO)) return true;
  return hearsayEnding([body]);
}

/**
 * The veto class of a LOCAL_WRITE frame, or `undefined` when the frame is a request shape. `frame` is the owner's prose
 * without the content spans that a quote pair or a colon form running to the end fully encloses, or that end the message
 * after the request verb (an undelimited span otherwise stays in the frame, so it cannot hide "…추가하지 마").
 * `entryWords` are the entry's own action words and `actionWords` every entry's: both only VETO (a negated clause that
 * names the action, a command before a retraction).
 */
export function nlRequestVeto(frame: string, entryWords: readonly string[], actionWords: readonly string[], spans: NlRequestSpans = {}): NlRequestVeto | undefined {
  const text = normalizeForMatch(frame).replace(/[’‘`´]/gu, "'");
  if (EXAMPLE_FRAME.test(text)) return 'example';
  // A joke in the request frame or in undelimited trailing content; enclosed content is content ("'농담 모음' 추가해줘").
  const trailing = (spans.trailing ?? []).map((span) => normalizeForMatch(span));
  if (JOKE.test(text) || trailing.some((span) => JOKE.test(span))) return 'joke';
  for (const span of trailing) {
    const own = clausesOf(span);
    if (NEGATION_EN.test(span) || own.some((clause, index) => negatesKo(clause, actionWords, wordsOf(own[index - 1] ?? '').at(-1) ?? ''))) return 'negation';
    if (own.length > 1 && RETRACTION_FINAL.test(wordsOf(own.at(-1) ?? '').at(-1) ?? '')) return 'retraction';
  }
  if (koreanQuotative(text, spanRegions(text, spans.content ?? [])) || REPORTED_EN.test(text)) return 'reported';
  if (quotedCommand(text, actionWords)) return 'reported';
  for (const span of [...(spans.content ?? []), ...(spans.quoted ?? [])]) {
    for (const match of normalizeForMatch(span).matchAll(QUOTED_SEGMENT)) if (isQuotedRequest(match.slice(1).find((group) => group !== undefined) ?? '', actionWords)) return 'reported';
  }
  for (const span of spans.quoted ?? []) if (isQuotedRequest(normalizeForMatch(span), actionWords)) return 'reported';

  const clauses = clausesOf(text);
  if (hearsayEnding(clauses)) return 'reported';

  const lastOf = (index: number): string => wordsOf(clauses[index] ?? '').at(-1) ?? '';
  const negated = (index: number): boolean => negatesKo(clauses[index] ?? '', actionWords, lastOf(index - 1)) || verbNegated(clauses[index + 1] ?? '', actionWords, lastOf(index));
  if (NEGATION_EN.test(text)) return 'negation';
  if (clauses.length > 0 && negated(clauses.length - 1)) return 'negation';
  if (clauses.length > 1 && SPANNING_NEGATION.test(`${lastOf(clauses.length - 2)} ${clauses.at(-1) ?? ''}`)) return 'negation';
  if (clauses.some((clause, index) => negated(index) && names(clause, entryWords))) return 'negation';
  // A content span's own negated action always counts, enclosed or not ("'우유 사기 추가하지 마' 추가해줘").
  for (const span of spans.content ?? []) {
    const own = normalizeForMatch(span);
    const englishNegatedAction = NEGATION_EN.test(own) && own.split(/\s+/u).some((word) => holdsActionWord(word, entryWords));
    if (negatedClauseNames(own, entryWords) || englishNegatedAction) return 'negation';
  }

  const rawWords = text.split(/\s+/u).filter((word) => word.length > 0);
  const words = wordsOf(text);
  const last = words.at(-1);
  if (RETRACTION_ANYWHERE.test(text)) return 'retraction';
  if (clauses.some((clause, index) => index > 0 && AFTERTHOUGHT.test(clause) && !requestsSomething(clause, actionWords) && clauses.slice(0, index).some((earlier) => requestsSomething(earlier, actionWords)))) return 'retraction';
  if (last !== undefined && RETRACTION_FINAL.test(last) && rawWords.slice(0, -1).some((word) => isCommandWord(word, actionWords))) return 'retraction';

  // The lexical classes skip a hit that lies entirely inside a content span (its own words are content).
  const regions = spanRegions(text, spans.content ?? []);
  const lexicalHit = (pattern: RegExp, within: string = text): boolean => hitOutside(pattern, within, within === text ? regions : spanRegions(within, spans.content ?? []));
  const polite = POLITE_REQUEST.test(text);
  if (QUESTION_MARK.test(text) && !polite) return 'question';
  if (lexicalHit(HOWTO_WH_KO) || lexicalHit(CAPABILITY_DELIBERATION_KO) || lexicalHit(QUESTION_EN)) return 'question';
  if (last !== undefined && INTERROGATIVE_ENDING_KO.test(last) && !polite) return 'question';
  const lastChars = Array.from((last ?? '').replace(/요$/u, ''));
  if (last !== undefined && DELIBERATION_TAIL.test(last) && finalConsonant(lastChars.at(-2)) === 8) return 'question';

  // -면 counts inside a span only on the action itself or a light verb ("그거 완료되면 알려줘"); "비 오면 우산 챙기기" and
  // "라면" are content.
  const conditionalInside = (hit: string): boolean => /(?:하|되|돼|했|됐)면/u.test(hit) || holdsActionWord(hit, actionWords);
  const conditional = [...text.matchAll(CONDITIONAL_MYEON)].some((match) => {
    if (!isConditionalWord(match[0])) return false;
    const start = match.index ?? 0;
    const enclosed = regions.some(([from, to]) => start >= from && start + match[0].length <= to);
    return !enclosed || conditionalInside(wordAt(text, start));
  });
  if (conditional || lexicalHit(CONDITIONAL_OTHER) || lexicalHit(CONDITIONAL_EN)) return 'conditional';
  if (lexicalHit(WISH_KO) || lexicalHit(WISH_EN)) return 'wish';
  // Deferred timing outside the reminder's own time span: Korean in the clause of the main predicate (an earlier
  // "나중에 까먹지 않게" is a reason), English anywhere ("after the meeting, cancel 2").
  // The reminder's own time stays a time (a digit), so "이따가 5시에" keeps its 이따가 as part of the time. The 후 / 뒤 check
  // skips a span's own words too ("퇴근 후 장보기").
  const whenText = spans.when === undefined ? undefined : normalizeForMatch(spans.when);
  const untimed = whenText === undefined ? text : text.replace(whenText, ' 0 '.padEnd(whenText.length, ' '));
  const untimedRegions = spanRegions(untimed, spans.content ?? []);
  const mainClause = clausesOf(untimed).at(-1) ?? '';
  const mainStart = untimed.lastIndexOf(mainClause);
  const mainRegions = untimedRegions.map(([from, to]) => [from - mainStart, to - mainStart] as const);
  if (hitOutside(DEFERRED_KO, mainClause, mainRegions) || hitOutside(DEFERRED_EN, untimed, untimedRegions)) return 'deferred';
  for (const match of mainClause.matchAll(/(\S+)\s+(?:뒤|후|다음)(?:에|에는)?(?=$|\s)/gu)) {
    const previous = Array.from(match[1] ?? '').at(-1);
    const start = match.index ?? 0;
    const enclosed = mainRegions.some(([from, to]) => start >= from && start + match[0].length <= to);
    if (!enclosed && (finalConsonant(previous) === 4 || previous === '는')) return 'deferred';
  }
  if (lexicalHit(PLANNED_KO)) return 'statement';

  // A past or report statement holds unless a later clause makes a request ("3번 끝났어 완료로 바꿔줘" acts; "2번
  // 완료했어 고마워" does not, Codex P2).
  for (const [index, clause] of clauses.entries()) {
    const statement = wordsOf(clause).some(isFinitePast) || DONE_FOR_ME_KO.test(clause) || STATEMENT_EN.test(clause);
    if (statement && !clauses.slice(index + 1).some((later) => requestsSomething(later, actionWords))) return 'statement';
  }
  const lastClause = clauses.at(-1) ?? '';
  const lastWords = wordsOf(lastClause);
  const lastWord = words.at(-1) ?? '';
  // A plain declarative -다 ends the message ("피곤하다", "되돌리기 기능 좋다", "2번 완료한다"); -ㅂ시다 (let's) and the
  // polite 부탁드립니다 are requests. A report ending -함 / -됨 / -았음 likewise ("민수가 … 추가함", "원상복구 필요함").
  if (/다$/u.test(lastWord) && !/시다$/u.test(lastWord) && !/부탁/u.test(lastWord)) return 'statement';
  if (REPORT_ENDING_LAST.test(lastWord)) return 'statement';
  // A retrospective -더라, a plan noun after -ㄹ ("완료할 계획/생각"), a state noun after -ㄴ ("돌려놓은 상태"), a guess -ㄹ걸
  // ("완료일걸", "해야 될걸"): statements or guesses, never requests (CA P3).
  if (/더라(?:고)?$/u.test(lastWord)) return 'statement';
  const beforeLast = Array.from(words.at(-2) ?? '').at(-1);
  if (/^(?:계획|생각)(?:이야|임|이에요|입니다)?$/u.test(lastWord) && finalConsonant(beforeLast) === 8) return 'statement';
  if (/^상태(?:야|임|이야|예요)?$/u.test(lastWord) && (finalConsonant(beforeLast) === 4 || beforeLast === '는')) return 'statement';
  const guessChars = Array.from(lastWord.replace(/요$/u, ''));
  if (guessChars.at(-1) === '걸' && finalConsonant(guessChars.at(-2)) === 8) return 'wish';
  // A copular sentence with its 이다 elided ends on a topic-marked noun ("할 일 제목은 '보고서 마감'"): a statement.
  if (Array.from(lastWord).length >= 2 && /[은는]$/u.test(lastWord) && !isAdnominalVerb(lastWord)) return 'statement';
  if (EXISTENTIAL_LAST.test(lastWords.at(-1) ?? '') && !/수$/u.test(lastWords.at(-2) ?? '') && !/수(?:있|없)/u.test(lastWords.at(-1) ?? '')) return 'statement';
  // The entry's action named only as a modifier or an embedded question ("2번 완료된거 맞아", "2번 완료됐는지 보여줄래?"):
  // the sentence is about the item's state, not a request for the action.
  const mentions = words.filter((word) => entryWords.some((action) => !/^[a-z0-9 -]+$/u.test(action) && word.includes(normalizeForMatch(action))));
  if (mentions.length > 0 && mentions.every(isEmbeddedQuestion)) return 'question';
  if (mentions.length > 0 && mentions.every(isAdnominal) && !REQUEST_ENDING_KO.test(text)) return 'statement';

  // A first-person subject is volition unless the message makes a request of its own ("내가 자꾸 까먹으니까 … 추가해줘"
  // acts; "내가 2번 완료할래", "제가 2번 완료해요" do not).
  const requestWord = words.some((word) => REQUEST_WORD_KO.test(word)) || EN_REQUEST_SIGNAL.test(text);
  if ((FIRST_PERSON_KO.test(text) && !requestWord) || INTENTION_KO.test(lastClause) || OBLIGATION_KO.test(text.replace(WORD_NOISE, '')) || FUTURE_INTENTION_KO.test(lastClause) || VOLITION_EN.test(lastClause)) return 'volition';
  // A promise ends its sentence: the last word, or a word followed by punctuation ("추가할게. 도서관 책 반납"). An adverbial
  // -게 inside a sentence ("길게 적어줘") or the causative "-게 해줘" is no promise.
  const spoken = rawWords.map((raw) => ({ raw, word: raw.replace(WORD_NOISE, '') })).filter((entry) => entry.word.length > 0);
  for (const [index, { raw, word }] of spoken.entries()) {
    const chars = Array.from(word.replace(/요$/u, ''));
    const promise = PROMISE_ENDING.test(word) && finalConsonant(chars.at(-2)) === 8;
    const endsSentence = index === spoken.length - 1 || raw !== word;
    if (promise && endsSentence && !CAUSATIVE_NEXT.test(spoken[index + 1]?.word ?? '')) return 'volition';
  }
  // A last word in the copula or obligation -야 after a vowel ("그냥 메모야", "사야"): never a request.
  const lastWordChars = Array.from(lastWord);
  if (lastWordChars.length >= 2 && lastWordChars.at(-1) === '야' && finalConsonant(lastWordChars.at(-2)) === 0) return 'statement';
  return undefined;
}

/** A reporting clause that ends the content in English ("… he told me", "… my boss said", "… she asked"). */
const EN_REPORT_TAIL = /\b(?:he|she|they|someone|somebody|everyone|my\s+\w+|the\s+\w+|\w+)\s+(?:told|tells|said|says|asked|asks|wrote|writes|mentioned)(?:\s+(?:me|us|him|her|them))?\s*$/u;
/** A Korean speech verb that ends the content as its own finite clause ("… 그가 말했어", "… 팀장이 그랬어"). */
const KO_SPEECH_TAIL = /(?:말했|말하더|얘기했|이야기했|그랬|그러더|전했|시켰)(?:어|어요|다|대|음|지|는데|더라)?$/u;

/**
 * A6 v49 gate (2026-10-19, a6-negative-none-189 / -193): the request-shape vetoes on the TRAILING clause of a colon label's
 * content ("Todo: renew passport?", "Todo: buy milk he told me", "할 일: 우유 사기 하래"). A label form exempts its content
 * from the vetoes, so without this the message-final question mark or hearsay sits inside the span. Only the end of the
 * span is read, like the last-word rules of the frame: a final question mark (not a polite request form) is a question; a
 * reporting clause, a Korean quotative or hearsay ending, or a speech verb ending the span is reported; a bare retraction
 * after the content is a retraction. The rest of the content stays exempt ("Todo: don't forget the keys" is content).
 */
export function nlLabelTailVeto(span: string): NlRequestVeto | undefined {
  const text = normalizeForMatch(span).replace(/[’‘`´]/gu, "'").trim();
  if (text.length === 0) return undefined;
  if (/[?？]\s*$/u.test(text) && !POLITE_REQUEST.test(text)) return 'question';
  const body = text.replace(/[\s.,!~…;:"'“”‘’)\]]+$/u, '');
  const clauses = clausesOf(body);
  const last = clauses.at(-1) ?? body;
  if (EN_REPORT_TAIL.test(body) || hearsayEnding([last]) || KO_SPEECH_TAIL.test(wordsOf(last).at(-1) ?? '')) return 'reported';
  const lastStart = body.lastIndexOf(' ') + 1;
  const endsInLast = (pattern: RegExp): boolean => [...body.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].some((match) => (match.index ?? 0) + match[0].length > lastStart);
  if (endsInLast(QUOTATIVE_KO) || endsInLast(CONTRACTED_QUOTATIVE_KO) || endsInLast(CONTRACTED_QUOTATIVE_FINAL_KO) || endsInLast(QUOTED_REQUEST_KO)) return 'reported';
  if (clauses.length > 1 && RETRACTION_FINAL.test(wordsOf(last).at(-1) ?? '') && clauses.slice(0, -1).some((clause) => wordsOf(clause).length > 0)) return 'retraction';
  return undefined;
}

/**
 * Whether the text before a content span that ends the message closes a request, so the span is content (CA round 3): its
 * last word is a request word ("할 일 추가해줘 운동 끝나고 샤워하기") or the English "to" / "that" after a request ("remind
 * me at 5pm to stretch after lunch"). A nominal action word or a bare "-해" before the span is not enough.
 */
export function nlRequestEndsBefore(before: string, actionWords: readonly string[]): boolean {
  const text = normalizeForMatch(before).replace(/[:：,]\s*$/u, '');
  const last = wordsOf(text).at(-1) ?? '';
  if (REQUEST_WORD_KO.test(last)) return true;
  return /^(?:to|that)$/u.test(last) && (EN_REQUEST_SIGNAL.test(text) || wordsOf(text).some((word) => /^[a-z]+$/u.test(word) && holdsActionWord(word, actionWords)));
}

/**
 * Imperative endings beside the request words ("되돌려", "취소해", "되돌려죠", "합시다", "하십시오"), and the imperatives of the
 * auxiliaries 보다 / 두다 / 드리다 ("되돌려 봐", "되돌려 보세요", "되돌려 줘봐"); their descriptive forms (보는, 본) stay out.
 */
const IMPERATIVE_TAIL = /(?:해|해요|려|려요|죠|합시다|십시오|봐|봐요|보세요|두세요|드리세요)$/u;

/**
 * Whether one word ends in a request or imperative form: the closed request endings (줘, 주세요, 주십시오, 줄래, 하세요, 해라,
 * 하자, 둬, 놔, 부탁 …) and the imperative tails. The single recogniser for the undo anchor (selection-validator).
 */
export function nlIsRequestForm(raw: string): boolean {
  const word = raw.replace(WORD_NOISE, '').replace(/요{2,}$/u, '요');
  return word.length > 0 && !isAdnominal(word) && (REQUEST_WORD_KO.test(word) || IMPERATIVE_TAIL.test(word));
}

/**
 * Whether `word` is mentioned in `text` outside every negation scope (A6 R2 mode grounding, Codex P2). English: a mention
 * governed by a negator among the (at most three) words right before it, within its sentence part, does not count ("not a
 * summary", "don't summarize", "no need to summarize"); another mention in the same clause still does ("Show the full
 * text of email #1 not a summary" grounds full). The term is matched on the whole text, so "tl;dr" stays one term. Korean: the mention's own stretch runs to
 * the next of `stopWords`, the next sentence punctuation or the end of the first request-form word, whichever comes
 * first; a stretch negated by the request-shape negators ("요약하지 말고 …", "요약 말고", "요약 안 해도 되고") does not count.
 * The same negation grammar as the LOCAL_WRITE vetoes; no phrase list.
 */
export function nlHasUnnegatedMention(text: string, word: string, stopWords: readonly string[]): boolean {
  const target = normalizeForMatch(word);
  if (target.length === 0) return false;
  const normalized = normalizeForMatch(text);
  if (/^[a-z0-9][a-z0-9 ;.-]*$/u.test(target)) {
    const pattern = new RegExp(`(?<![a-z0-9])${target.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}s?(?![a-z0-9])`, 'gu');
    for (const match of normalized.matchAll(pattern)) {
      const before = normalized.slice(0, match.index ?? 0);
      const part = before.slice(before.search(/[^,.!?]*$/u));
      const governing = part.trim().split(/\s+/u).filter((token) => token.length > 0).slice(-3);
      if (!governing.some((token) => NEGATION_EN.test(token))) return true;
    }
    return false;
  }
  const stops = stopWords.map((stop) => normalizeForMatch(stop)).filter((stop) => stop.length > 0 && stop !== target);
  for (let at = normalized.indexOf(target); at >= 0; at = normalized.indexOf(target, at + 1)) {
    const rest = normalized.slice(at);
    let end = rest.length;
    for (const stop of stops) {
      const index = rest.indexOf(stop, target.length);
      if (index > 0) end = Math.min(end, index);
    }
    const punctuation = rest.slice(target.length).search(/[,.!?;]/u);
    if (punctuation >= 0) end = Math.min(end, target.length + punctuation);
    // The first request-form word from the mention on closes the stretch ("요약해줘", "… 내용 보여줘").
    let offset = 0;
    for (const raw of rest.slice(0, end).split(/(\s+)/u)) {
      offset += raw.length;
      if (raw.trim().length > 0 && nlIsRequestForm(raw)) {
        end = Math.min(end, offset);
        break;
      }
    }
    // A scoped negator directly before the mode verb belongs to its stretch ("안 간추려도 되니까", "못 요약해도", Codex P2).
    const preceding = /(?:^|\s)(안|못)\s*$/u.exec(normalized.slice(0, at))?.[1];
    const stretch = preceding === undefined ? rest.slice(0, end) : `${preceding} ${rest.slice(0, end)}`;
    if (!negatesKo(stretch, [target])) return true;
  }
  return false;
}

/** Whether `text` makes a request of its own (a request word, an action word as a command, an English request lead). */
export function nlRequestsSomething(text: string, actionWords: readonly string[]): boolean {
  return requestsSomething(normalizeForMatch(text), actionWords);
}

/**
 * The R5a seam: the replacement of the A6 R1 `nlActionWordGrounded` (removed with the request-form rule). True when one of
 * `words` occurs in the prose and the prose carries no structural veto. Callers that strip their own phrases first (R5a:
 * "내가 말한 거", "아까 보냈던 거") pass the stripped prose, and the selector's `when` span (`spans.when`) so a reminder
 * time ("… 30분 뒤") is read as the time, not as a deferral.
 */
export function nlActionWordGrounded(prose: string, words: readonly string[], spans: NlRequestSpans = {}): boolean {
  const text = normalizeForMatch(prose);
  return words.some((word) => text.includes(normalizeForMatch(word))) && nlRequestVeto(prose, words, words, spans) === undefined;
}

/**
 * The closed LIGHT-VERB class (CA review P2 on the elliptical continuation): words that make a request without naming any
 * action. The light verb 하다 in its request and imperative endings ("해", "해줘", "하세요", "해 주세요"), with the verbal
 * nouns that only carry it (처리, 부탁: "처리해줘", "부탁해", "부탁드립니다"), the bare 처리 / 부탁, the Korean go-signals ㄱㄱ /
 * 고고, the manner adverb 똑같이 ("똑같이 해줘"), and the English do / please. A grammatical class, never a phrase list: an
 * action word with the same endings ("체크해줘", "완료해줘", "빼줘") is not in it.
 */
const LIGHT_VERB_WORD = /^(?:(?:처리|부탁)?(?:해|하)(?:줘|줘요|주세요|주십시오|줄래|줄래요|주실래요|라|자|요|세요|십시오)?|주세요|줘|줘요|(?:처리|부탁)(?:해요|합니다|드려요|드립니다|드릴게요)?|똑같이|do|please|pls|plz)$/u;
const GO_SIGNAL = /^(?:ㄱ{2,}|(?:고){2,})[!~.]*$/u;

/** The copula on a word's end (-이야, -야, -이에요, -예요, -입니다, -이다, -임, -이요). */
const COPULA_TAIL = /(?:이야|야|이에요|예요|에요|입니다|이다|임|이요)$/u;
/** A bare item reference: a numeral (with 번 / #), or an ordinal ending in 번째 / 째. */
const REFERENCE_STEM = /^(?:#?\d{1,3}(?:번(?:째)?)?|[가-힣]{0,3}번째|[가-힣]{1,3}째)$/u;

/**
 * Live test 4 (2026-10-17, turn 39 "이번엔 3번이야" right after "2번 완료"): a frame whose last word is a bare item
 * reference carrying the copula, and which is elliptical once the copula is set aside ({@link nlFrameIsElliptical}). The
 * copula names WHICH item ("this time it's #3"), not a fact about one, so the statement veto does not decide such a frame:
 * the caller offers the continuation confirmation (only right after the same action), else the turn stays chat. Closed
 * classes only (the copula endings, numerals and ordinals); no phrase list. Pure.
 */
export function nlFrameIsCopularReference(frame: string, actionWords: readonly string[]): boolean {
  const words = wordsOf(normalizeForMatch(frame));
  const last = words.at(-1);
  if (last === undefined || !COPULA_TAIL.test(last)) return false;
  const stem = last.replace(COPULA_TAIL, '');
  const previous = words.at(-2) ?? '';
  // "세 번째야": the ordinal spans two words.
  const reference = REFERENCE_STEM.test(stem) || (/^번째$/u.test(stem) && /^[가-힣]{1,2}$/u.test(previous));
  return reference && nlFrameIsElliptical([...words.slice(0, -1), stem].join(' '), actionWords);
}

/**
 * ADR-0120 A6-D3a amendment 1, elliptical continuation (D12 gate v44 run 3, gold a6-reference-none-002 "이번엔 3번"): whether
 * a LOCAL_WRITE frame (the owner's prose without the selector's content spans) is ELLIPTICAL: once the light-verb class
 * ({@link LIGHT_VERB_WORD}: "해줘", "처리해줘", "부탁해", "ㄱㄱ", "똑같이") is set aside, it names no action word of any A6
 * vocabulary (`actionWords`) and makes no request of its own (no request or imperative form, no command word, no English
 * request lead). "이번엔 3번", "그럼 3번", "3번도", "3번도 해줘", "그럼 3번 부탁해", "3번도 ㄱㄱ", "2번 체크" are;
 * "3번 완료", "1번 할일 체크해줘", "2번 빼" are not. The action such a message means is only inferred (from the last
 * action, or by the selector), so it never executes: the owner's rule is "ambiguous: ask, clear: act". Closed classes only
 * (the A6 vocabularies, the request endings, the light verb); no phrase list. Pure.
 */
export function nlFrameIsElliptical(frame: string, actionWords: readonly string[]): boolean {
  const kept = normalizeForMatch(frame)
    .split(/\s+/u)
    .filter((raw) => {
      if (raw.length === 0 || GO_SIGNAL.test(raw)) return false;
      const word = raw.replace(WORD_NOISE, '');
      return word.length > 0 && !LIGHT_VERB_WORD.test(word);
    });
  const text = kept.join(' ');
  const namesAction = actionWords.some((raw) => {
    const word = normalizeForMatch(raw);
    if (word.length === 0) return false;
    return /^[a-z0-9 -]+$/u.test(word) ? new RegExp(`(?<![a-z0-9])${word.replace(/[-]/g, '\\-').replace(/ /g, '\\s+')}(?![a-z0-9])`, 'u').test(text) : text.includes(word);
  });
  if (namesAction) return false;
  return !requestsSomething(text, actionWords) && !wordsOf(text).some((word) => nlIsRequestForm(word));
}
