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
const PARTICLE_ONLY = /^(?:에서|에게서|에게|한테서|한테|께서|께|까지|부터|이나|나|이랑|랑|이라도|라도|이든|든|으로|로|에는|에도|에|은|는|이|가|을|를|의|도|만|와|과|이야|야|이에요|예요|이죠|죠|이라|라고|인가요|인가|인지|인데|일까|일까요|이니|니|입니까|이냐|냐|요)+$/u;

/**
 * Korean verbal morphology, as suffix stripping rather than phrases: a request stem (알려, 보여, 확인해, …) or an existence /
 * state stem (있, 없, 되, …), an optional giving auxiliary (주, 드리), an optional honorific (시) and a closed set of polite,
 * interrogative and plain endings. "알려주실래요", "보여주시겠어요", "있습니까", "있었나요", "확인해 주세요" (split into two tokens) all end
 * here, with no phrase listed.
 */
const REQUEST_STEM = '(?:알려|보여|확인해|확인|조회해|조회|정리해|정리|말해|찾아|찾아봐|검색해|브리핑해|요약해|가르쳐|해|봐|보)';
const GIVE = '(?:주|드리|드려|줘)';
const REQUEST_END =
  '(?:|시|세요|십시오|시오|실래요?|실래|시겠어요|시겠습니까|시겠나요|시나요|시는지|실수|줘요?|줄래요?|줄까요?|주라|라|래요?|ㄹ래요?|' +
  '드릴까요|드릴게요|드릴래요|드립니다|드리겠습니다|드려요|립니다|릴까요|릴게요|겠어요|겠습니다|겠습니까|어요|아요|해요|해|요|ㅂ니다|습니다|습니까|ㅂ니까|니까|나요|ㄹ까요)';
const REQUEST_VERBAL = new RegExp(`^${REQUEST_STEM}${GIVE}?${REQUEST_END}$`, 'u');
const EXIST_STEM = '(?:있|없|되|돼|맞|아니|아닌|이|였|하)';
const EXIST_END =
  '(?:|어|어요|아요|네|네요|죠|지|지요|군요|습니다|습니까|ㅂ니다|ㅂ니까|니까|나요|나|니|냐|는지|는가|은가|ㄴ가|ㄴ가요|을까요?|ㄹ까요?|을지|을텐데|' +
  '는데|던가요?|었어요?|었나요?|었나|었지요?|었습니까|었습니다|았어요?|았나요?|았나|였어요?|였나요?|였나|였지요?|시나요|시나|세요|십니까|실까요|으세요|으십니까|으시나요|으신가요|으신지|으실까요|으시죠)';
const EXIST_VERBAL = new RegExp(`^${EXIST_STEM}${EXIST_END}$`, 'u');
/** Interrogative and copula endings that follow a wh-word or an agenda word ("뭐예요", "언제죠", "몇 시입니까"). */
const COPULA_END = '(?:야|예요|에요|이에요|이야|입니다|입니까|인가요|인가|인지|죠|지요|지|였어요?|였지요?|였나요|이었나요|이죠|일까요?|이에요)';
const WH_VERBAL = new RegExp(`^(?:뭐|뭘|뭔|무엇|언제|몇|시|개|건|어때|어떻|어떤)${COPULA_END}?$`, 'u');

/** Korean closed-class words: interrogatives, request verbs and endings, existence and state endings, first person, fillers. */
const KO_FUNCTION =
  /^(?:나|내|제|저|저의|나의|우리|좀|뭐|뭘|뭐가|뭐야|뭐예요|뭐에요|뭐지|뭐였어|뭐였지|뭔지|무엇|무슨|어떤|어떻게|어때|어때요|돼|돼요|되나|되니|될까|되는지|많이|계속|몇|몇개|몇시|시야|시예요|개|개야|개예요|언제|언제야|언제예요|있어|있어요|있나|있나요|있니|있는지|있을까|있을텐데|있었지|있었어|있었나|있었어요|없어|없나|없니|없어요|알려줘|알려줘요|알려줄래|알려줄래요|알려주세요|알려|알려줄|보여줘|보여줘요|보여줄래|보여주세요|보여|확인|확인해줘|확인해주세요|확인해|조회|조회해줘|정리|정리해줘|정리해주세요|목록|리스트|줘|줘요|주세요|줄래|줄래요|해줘|해주세요|해|보기|봐|봐줘|있다|없다|맞아|맞나|그럼|그러면|그리고|근데|혹시|그냥|한번|안녕|쿼키|쿼키야)$/u;

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
    if (token.length < 2) return false;
    return !PARTICLE_ONLY.test(token) && !KO_FUNCTION.test(token) && !REQUEST_VERBAL.test(token) && !EXIST_VERBAL.test(token) && !WH_VERBAL.test(token);
  }
  if (token.length < 2) return false;
  return !EN_FUNCTION.has(token);
}

/**
 * The content words of `text` that neither the grammar's own vocabulary (`expressed`, global-safe regexes of the forms it
 * parses: spans, nouns, filters) nor the closed grammatical classes account for. Empty: the grammar expresses the whole
 * message. Pure.
 */
export function unexpressedContentWords(text: string, expressed: readonly RegExp[]): string[] {
  let rest = stripMarks(text);
  for (const pattern of expressed) {
    const flags = pattern.flags.replace(/[gy]/gu, '');
    rest = rest.replace(new RegExp(pattern.source, `${flags}g`), ' ');
  }
  const out: string[] = [];
  for (const token of rest.split(/[^\p{L}\p{N}'’-]+/u)) {
    const word = token.replace(/^['’-]+|['’-]+$/gu, '');
    if (word.length > 0 && isContentToken(word)) out.push(word);
  }
  return out;
}

/** Whether something the owner said would change the meaning and the grammar cannot express it (the grammar then declines). */
export function leavesUnexpressedContent(text: string, expressed: readonly RegExp[]): boolean {
  return unexpressedContentWords(text, expressed).length > 0;
}
