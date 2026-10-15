/**
 * The structural guard of the Class B listing grammars (ADR-0120 follow-up 2). A whole-message listing grammar may answer
 * a turn only when everything the owner said is something the grammar can express. When, after the grammar's own
 * vocabulary is removed, a content word is left over — a qualifier or keyword the grammar cannot carry ("정기회의",
 * "스크럼", "위클리카", "오후 거만") — the grammar declines and the turn falls through to the classifier and natural-language
 * selection, which can bind the qualifier (`calendar.events` with a keyword, …).
 *
 * This narrows a grammar; it adds no phrase. The only word lists here are closed grammatical classes (particles, endings,
 * interrogatives, request verbs, pronouns, English function words): none names an intent, a source or a topic. A word that
 * is not in them counts as content, so a doubtful message is declined and selection decides.
 */

const HANGUL = /\p{Script=Hangul}/u;

/** Korean particles and copula endings: a leftover made only of these carries no content ("에서", "이나", "이에요"). */
const PARTICLES = '에서|에게서|에게|한테서|한테|께서|께|까지|부터|이나|나|이랑|랑|이라도|라도|이든|든|으로|로|에는|에도|에|은|는|이|가|을|를|의|도|만|와|과|이야|야|이에요|예요|이죠|죠|이라|라고|인가요|인가|인지|인데|일까|일까요|이니|니|입니까|이냐|냐|요';
const PARTICLE_ONLY = new RegExp(`^(?:${PARTICLES})+$`, 'u');

/**
 * Korean verbal morphology, as suffix stripping rather than phrases: a request stem (알려, 보여, 확인해, …) or an existence /
 * state stem (있, 없, 되, …), an optional giving auxiliary (주, 드리), an optional honorific (시) and a closed set of polite,
 * interrogative and plain endings. "알려주실래요", "보여주시겠어요", "있습니까", "있었나요", "확인해 주세요" (split into two tokens) all end
 * here, with no phrase listed.
 */
const REQUEST_STEM = '(?:알려|보여|확인해|확인|조회해|조회|정리해|정리|말해|찾아|찾아봐|검색해|브리핑해|요약해|가르쳐|해|봐|보)';
// 줄/드릴: the adnominal form before a dependent noun ("알려줄 수 있어").
const GIVE = '(?:주|줄|드리|드릴|드려|줘)';
const REQUEST_END =
  '(?:|시|실|세요|십시오|시오|실래요?|실래|시겠어요|시겠습니까|시겠나요|시나요|시는지|실수|줘요?|줄래요?|줄까요?|주라|라|래요?|ㄹ래요?|' +
  '드릴까요|드릴게요|드릴래요|드립니다|드리겠습니다|드려요|립니다|릴까요|릴게요|겠어요|겠습니다|겠습니까|어요|아요|해요|해|요|ㅂ니다|습니다|습니까|ㅂ니까|니까|나요|ㄹ까요)';
const REQUEST_VERBAL = new RegExp(`^${REQUEST_STEM}${GIVE}?${REQUEST_END}$`, 'u');
// 아니/아닌 are not here: like 안/못 they negate, so a leftover "아닌" is content ("리뷰 요청 아닌 거").
const EXIST_STEM = '(?:있|없|되|돼|맞|이|였|하)';
const EXIST_END =
  '(?:|어|어요|아요|는|네|네요|죠|지|지요|군요|습니다|습니까|ㅂ니다|ㅂ니까|니까|나요|나|니|냐|는지|는가|은가|ㄴ가|ㄴ가요|을까요?|ㄹ까요?|을지|을텐데|' +
  '는데|던가요?|었어요?|었나요?|었나|었지요?|었습니까|었습니다|았어요?|았나요?|았나|였어요?|였나요?|였나|였지요?|시나요|시나|세요|십니까|실까요|으세요|으십니까|으시나요|으신가요|으신지|으실까요|으시죠)';
const EXIST_VERBAL = new RegExp(`^${EXIST_STEM}${EXIST_END}$`, 'u');
/** Interrogative and copula endings that follow a wh-word or an agenda word ("뭐예요", "언제죠", "몇 시입니까"). */
const COPULA_END = '(?:야|예요|에요|이에요|이야|입니다|입니까|인가요|인가|인지|죠|지요|지|였어요?|였지요?|였나요|이었나요|이죠|일까요?|이에요)';
const WH_VERBAL = new RegExp(`^(?:뭐|뭘|뭔|무엇|언제|몇|시|개|건|어때|어떻|어떤)${COPULA_END}?$`, 'u');

/** Korean closed-class words: interrogatives, request verbs and endings, existence and state endings, first person, fillers. */
const KO_FUNCTION =
  /^(?:나|내|제|저|저의|나의|우리|좀|뭐|뭘|뭐가|뭐야|뭐예요|뭐에요|뭐지|뭐였어|뭐였지|뭔지|무엇|무슨|어떤|어떻게|어때|어때요|돼|돼요|되나|되니|될까|되는지|많이|계속|몇|몇개|몇시|시야|시예요|개|개야|개예요|언제|언제야|언제예요|있어|있어요|있나|있나요|있니|있는지|있을까|있을텐데|있었지|있었어|있었나|있었어요|없어|없나|없니|없어요|알려줘|알려줘요|알려줄래|알려줄래요|알려주세요|알려|보여줘|보여줘요|보여줄래|보여주세요|보여|확인|확인해줘|확인해주세요|확인해|조회|조회해줘|정리|정리해줘|정리해주세요|목록|리스트|줘|줘요|주세요|줄래|줄래요|해줘|해주세요|해|보기|봐|봐줘|있다|없다|맞아|맞나|그럼|그러면|그리고|근데|혹시|그냥|한번|다시|안녕|쿼키|쿼키야)$/u;

/**
 * The closed one-syllable degree and frequency adverbs (A2 implementation note 2): "다 보여줘", "또 보여줘", "더", "꼭". A
 * one-syllable word outside the closed classes is content ("할 일 앱 알려줘"). The negating 안/못 are not here: they change
 * the meaning. (좀 is in {@link KO_FUNCTION}.)
 */
const ONE_SYLLABLE_ADVERB = /^(?:다|또|더|꼭|잘|딱|막|곧|늘|참|꽤|퍽|쭉|확|싹|푹)$/u;

/**
 * Dependent nouns (수, 줄, 데, 거, 것, …), bare (no particle), are grammar only right after a VERBAL adnominal form: a
 * request or existence form ending in ㄴ/ㄹ ("알려줄 수", "보여줄 수", "있는 거"), or an expressed match ending in an
 * adnominal verbal syllable ("요청 온 거", "남은 거"). Never after a noun ("할 일 수", "내일 지도", "다음 주 수"). This can only
 * make a grammar decline more often than a fixed list would, never less.
 */
const DEPENDENT_NOUN = /^(?:수|줄|데|거|것|게|건|걸|바|뿐|때|듯|채|지|등)$/u;
/** The adnominal verbal syllables that may close an expressed match ("온", "된", "받은", "남은", "있는", "마감인"). */
const ADNOMINAL_SYLLABLE = /(?:은|는|던|된|온|인|한)$/u;
function endsInAdnominal(word: string): boolean {
  const last = word.at(-1);
  if (last === undefined) return false;
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return false;
  const final = code % 28;
  return final === 4 || final === 8; // ㄴ or ㄹ
}
/** 없는 negates ("없는 거"), so it never makes a dependent noun grammar. */
function isVerbalAdnominal(word: string): boolean {
  return endsInAdnominal(word) && !word.startsWith('없') && (REQUEST_VERBAL.test(word) || EXIST_VERBAL.test(word));
}
/** 수 is "possibility" (grammar) only before a form of 있/없 ("알려줄 수 있나요"); elsewhere it is "number" ("남은 수"). */
function boundDependentNoun(token: string, before: string, next: string): boolean {
  if (!DEPENDENT_NOUN.test(token) || !(before.endsWith(REMOVED_ADNOMINAL) || isVerbalAdnominal(before))) return false;
  return token !== '수' || (/^(?:있|없)/u.test(next) && EXIST_VERBAL.test(next));
}

/**
 * What may follow a removed vocabulary word inside the same token and still be its morphology, in order: a noun's plural
 * and ONE particle or copula ending ("할 일들을", "할일이랑", "이슈들"), or one verbal ending left by a removed stem ("뭐
 * 있|어"). Particles may not repeat ("할일만나" is content), and nothing before the grammar word is morphology ("아이할일").
 */
const GLUED_SUFFIX = new RegExp(`^(?:들?(?:${PARTICLES})?|어|아|어요|아요|요|죠|지|네|니|나|냐|다|습니다|ㅂ니다|나요|니까)$`, 'u');

const EN_FUNCTION = new Set([
  'a', 'an', 'the', 'my', 'me', 'i', 'we', 'our', 'do', 'does', 'did', 'have', 'has', 'had', 'am', 'are', 'is', 'was', 'were', 'be', 'been', 'will',
  'what', "what's", 'whats', 'which', 'when', "when's", 'how', 'many', 'much', 'there', "there's", 'any', 'anything', 'something', 'show', 'list', 'tell',
  'give', 'get', 'check', 'see', 'look', 'please', 'pls', 'can', 'could', 'would', 'you', 'on', 'in', 'for', 'at', 'of', 'to', 'by', 'and', 'or',
  'got', 'all', 'it', 'its', "it's", 'that', 'this', 'now', 'yes', 'no', 'ok', 'okay', 'hi', 'hey', 'quoky', 'about', 'with', 'from', 'then', 'so', 'just',
]);

function stripMarks(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[“”‘’「」『』"'`]/gu, ' ');
}

/** Whether a leftover token carries content: it is not a particle run, a closed-class word or too short to be a word. */
function isContentToken(token: string): boolean {
  if (/^\d+$/u.test(token)) return false;
  if (HANGUL.test(token)) {
    // A one-syllable token counts too ("앱", "팁"): only the closed classes make a token grammar, never its length.
    return (
      !PARTICLE_ONLY.test(token) &&
      !KO_FUNCTION.test(token) &&
      !ONE_SYLLABLE_ADVERB.test(token) &&
      !REQUEST_VERBAL.test(token) &&
      !EXIST_VERBAL.test(token) &&
      !WH_VERBAL.test(token)
    );
  }
  if (token.length < 2) return false;
  return !EN_FUNCTION.has(token);
}

/**
 * Whether one word is content for the closed grammatical classes above (not a particle, function word, closed adverb,
 * request, existence or interrogative form). Shared with the weekday reading of `symbolic-time` (A5 implementation note 2).
 */
export function isNlContentWord(token: string): boolean {
  return isContentToken(token.normalize('NFC').toLowerCase());
}

/** The noun stems of {@link REQUEST_STEM}: alone ("드라이브 정리 다 했어") they name an activity, not a request. */
const BARE_NOUN_STEM = /^(?:확인|조회|정리)$/u;

/**
 * Whether one word is a Korean request or interrogative form of the closed classes above: a request verbal ("알려줘",
 * "보여주세요", "확인해"; a bare noun stem such as "정리" is not one) or a wh-word with its copula ending ("뭐야",
 * "언제죠", "몇"). Shared with the A7 statement check.
 */
export function isNlRequestOrWhWord(token: string): boolean {
  const word = token.normalize('NFC').toLowerCase();
  return (REQUEST_VERBAL.test(word) && !BARE_NOUN_STEM.test(word)) || WH_VERBAL.test(word);
}

/** Whether `text` is nothing but particles ("이", "에는"). */
export function isNlParticleOnly(text: string): boolean {
  return PARTICLE_ONLY.test(text);
}

/** A closed-class word other than a particle run (a glued fragment may not be a free run of particles). */
function isClosedWord(token: string): boolean {
  return KO_FUNCTION.test(token) || ONE_SYLLABLE_ADVERB.test(token) || REQUEST_VERBAL.test(token) || EXIST_VERBAL.test(token) || WH_VERBAL.test(token);
}

/** What an expressed match is replaced with: a non-letter that keeps the fragments around it in one token. */
const REMOVED = '\u0001';
/** The same, for a match that ends in an adnominal verbal syllable. */
const REMOVED_ADNOMINAL = '\u0002';

/**
 * The content words of `text` that neither the grammar's own vocabulary (`expressed`, global-safe regexes of the forms it
 * parses: spans, nouns, filters) nor the closed grammatical classes account for. Empty: the grammar expresses the whole
 * message. Pure.
 */
export function unexpressedContentWords(text: string, expressed: readonly RegExp[]): string[] {
  let rest = stripMarks(text);
  for (const pattern of expressed) {
    const flags = pattern.flags.replace(/[gy]/gu, '');
    // The whitespace a match swallowed stays, so only fragments really glued to the match share its token. A match that
    // ends in an adnominal verbal syllable ("온", "남은") is marked, so a dependent noun after it is grammar.
    rest = rest.replace(new RegExp(pattern.source, `${flags}g`), (match) => {
      const marker = ADNOMINAL_SYLLABLE.test(match.trimEnd()) ? REMOVED_ADNOMINAL : REMOVED;
      return `${/^\s*/u.exec(match)?.[0] ?? ''}${marker}${/\s*$/u.exec(match)?.[0] ?? ''}`;
    });
  }
  const out: string[] = [];
  const tokens = rest.split(/[^\p{L}\p{N}'’\u0001\u0002-]+/u).filter((token) => token.length > 0);
  tokens.forEach((token, position) => {
    // A bare dependent noun right after a verbal adnominal form is grammar ("알려줄 수 있나요", "요청 온 거").
    if (boundDependentNoun(token, tokens[position - 1] ?? '', tokens[position + 1] ?? '')) return;
    // Inside a token that held an expressed word: a fragment AFTER it is morphology only when it is one closed suffix
    // (`GLUED_SUFFIX`) or a closed word; a fragment BEFORE it ("아이할일") is a word of its own. A token with no expressed
    // word is judged as a whole.
    const pieces = token.split(/[\u0001\u0002]/u);
    pieces.forEach((piece, index) => {
      const word = piece.replace(/^['’-]+|['’-]+$/gu, '');
      if (word.length === 0) return;
      if (pieces.length === 1) {
        if (isContentToken(word)) out.push(word);
        return;
      }
      const closed = index > 0 ? GLUED_SUFFIX.test(word) || isClosedWord(word) : isClosedWord(word);
      if (closed || (!HANGUL.test(word) && !isContentToken(word))) return;
      out.push(word);
    });
  });
  return out;
}

/** Whether something the owner said would change the meaning and the grammar cannot express it (the grammar then declines). */
export function leavesUnexpressedContent(text: string, expressed: readonly RegExp[]): boolean {
  return unexpressedContentWords(text, expressed).length > 0;
}

/**
 * Whether `text` contains one of `words` — the grounding words of a typed catalog argument (a part of the day, a Jira
 * role or period, a Drive kind). A Latin word matches as a whole word ("weekly" is not "week"); a Korean word matches
 * inside a token, so an attached particle or ending still counts ("오후에", "진행중인").
 *
 * The second part of the A2 rule (2026-10-14): a Class B grammar never counts a word as expressed when the word grounds
 * a typed argument of the grammar's own catalog entry that the grammar does not carry. The word lists are the
 * selector's own grounding vocabularies (one source of truth), never phrases.
 */
export function containsGroundingWord(text: string, words: readonly string[]): boolean {
  const lowerText = text.normalize('NFC').toLowerCase();
  return words.some((word) => {
    const lower = word.normalize('NFC').toLowerCase();
    return /^[a-z\s-]+$/u.test(lower)
      ? new RegExp(`(?<![a-z])${lower.replace(/[-\s]+/gu, '[-\\s]+')}(?![a-z])`, 'u').test(lowerText)
      : lowerText.includes(lower);
  });
}

/**
 * The third part of the A2 rule (2026-10-14): a grammar slot that takes free text and sends it whole as a catalog keyword
 * (a Slack or Confluence search term, a Jira keyword) expresses the message only when that text is already what the
 * catalog's own keyword rule keeps (`canonical`, the selector-side canonicalization). When the rule would cut it — the
 * slot swallowed a clause such as "배포 얘기 나온 거" — the grammar would search for words the owner did not mean, so it
 * declines and selection binds the core term.
 */
export function slotSwallowsClause(slot: string, canonical: (value: string) => string): boolean {
  return canonical(slot) !== slot;
}
