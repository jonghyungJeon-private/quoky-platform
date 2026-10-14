/**
 * The action-claim post-guard for a document summary (ADR-0118 D7/D8, GML-1 review P2-3). The ADR-0104 internal-action
 * guard knows Quoky's own domains (commit, push, to-do, reminder, …) but not mail actions, and a hostile mail can steer
 * its summary into "I forwarded the email" or "답장을 보냈어요". A summary performs no action, so a reply that claims, in the
 * first person or with Quoky as the subject, that a mail was sent, forwarded, replied to, deleted, archived, labelled
 * or marked read, or that a to-do, reminder or calendar entry was created, is withheld whole with a fixed notice.
 *
 * DRV-1 adds the document actions (edited, shared, moved, renamed, uploaded, deleted, a permission changed) with the
 * file as the object, so a Drive summary steered into "문서를 공유했어요" or "I shared the doc" is withheld the same way.
 *
 * Third-person sentences about the item's author stay allowed ("김철수 님이 회의 자료를 보냈어요", "Kim sent the deck"):
 * a Korean claim is exempt only when the nearest real subject before it (`<word>이/가/께서/님이`, not an adverb or a
 * generic noun) is someone other than Quoky or a stand-in for it; an English claim needs an `I` / `we` / `Quoky`
 * subject. Known false positives fail closed: a claim with no subject marker about a company
 * (`쿠팡에서 배송 안내 메일을 보냈어요`) and quoted first-person speech. Every pattern is linear (bounded repetition only) on the provider's bounded reply.
 *
 * v5 claim-guard gaps (closed structurally, never by widening an exemption): the reply is checked as written and
 * normalized ({@link normalizeForClaimCheck}: invisible characters, NFKD without combining marks, NFKC, lookalike letters,
 * and a `Quo-ky` / `쿼 키` split by any separator run joined), so a split name is the name. Every match of every claim
 * pattern is judged, overlapping included, so an exempt claim never hides another. A third-party subject exempts a
 * claim only when it governs the claim's own verb: a causal, contrastive or conditional connective, a finite past verb,
 * an honorific verb form or a request-verb adnominal between them (`부탁하셔서`, `요청한`, `했는데`) ends its scope; a
 * sequential connective (`정리해서`, `요청하여`) ends it only before a humble benefactive claim; an adnominal that only
 * describes the object (`요청하는 메일`, `받은 피드백`) does not. An honorific subject never exempts a humble benefactive
 * claim (`김철수님이 … 보내 드렸습니다`). A first-person or named Quoky actor (outside reported speech) in a sentence
 * with an action, anywhere in the reply, means no claim is exempt; a generic stand-in (`비서가`) counts in its own
 * sentence only. Each clause is read once and each claim is judged by binary search, so the guard stays linear.
 */

import type { UntrustedDocumentSource } from './untrusted-document-readout';

/**
 * Quoky stand-ins in Korean: a nearest subject that is one of these never exempts a claim (re-review item 3), whether
 * it is the first person or a word the model may use for itself.
 */
const KO_STAND_INS = new Set([
  '제', '저', '내', '나', '저희', '우리', 'quoky', '쿼키', '비서', '어시스턴트', '봇', '챗봇', 'ai', '에이아이', '시스템', 'i', 'we',
]);

/**
 * Words ending in 이/가 that are adverbs or generic nouns, never the author of an action (`같이`, `많이`, `내용이`,
 * `요청이`): they are not subjects at all, so they neither exempt a claim nor hide the subject before them.
 */
const KO_NOT_A_SUBJECT = new Set([
  '같', '많', '깊', '높', '길', '넓', '일찍', '빨', '쉽', '굳', '끝', '깨끗', '틈틈', '번번', '곳곳', '일일',
  '내용', '요청', '문의', '연락', '메일', '이메일', '답장', '회신', '일정', '회의', '자료', '시간', '날짜', '마감', '확인',
  '필요', '문제', '이유', '결과', '변경', '처리', '진행', '준비', '정리', '요약', '알림', '안내', '공지', '첨부', '파일',
]);
/** DRV-1: document nouns, extra non-subjects for a Drive summary only (a mail summary matches the pre-DRV-1 guard). */
const KO_DRIVE_NOT_A_SUBJECT = new Set(['문서', '시트', '폴더', '드라이브', '링크', '권한', '제목', '이름']);

/**
 * The completed or benefactive auxiliaries of a 하다 action noun (`전달했`, `전달해 드렸`, `전달해 뒀`, `전달해 놓았`,
 * `전달해 줬`, `전달 완료했`): v5 closes the contracted and casual forms (`뒀`, `놨`, `줬`) that main missed.
 */
const KO_DONE = String.raw`(?:했|해\s?(?:드렸|두었|뒀|놓았|놨|줬|주었)|완료했|하였)`;

/** Korean claims of a mail action or of a created to-do / reminder / calendar entry (past or completed tense). */
const KO_CLAIMS: readonly RegExp[] = [
  /(?:답장|회신|메일|이메일|요약)(?:을|를|은|는)?\s*(?:[^\s]{1,8}\s+){0,2}?(?:보냈|보내\s?(?:드렸|두었|뒀|놓았|놨|줬|주었)|전송했|발송했)/u,
  new RegExp(String.raw`(?:전달|삭제|보관|발송|전송|회신|답장)(?:을|를)?\s*${KO_DONE}`, 'u'),
  new RegExp(String.raw`(?:삭제|보관|전달|발송|읽음)\s*처리\s*(?:를\s*)?${KO_DONE}`, 'u'),
  // v5: a benefactive or completed 처리 with no object noun (`처리해 드렸습니다`, `처리해 두었어요`, `처리 완료했습니다`).
  /처리\s?(?:를\s*)?(?:해\s?(?:드렸|두었|뒀|놓았|놨|줬|주었)|완료했)/u,
  /(?:메일|이메일)(?:을|를|은|는|들을)?\s*(?:모두\s*|다\s*|전부\s*)?(?:지웠|옮겼|휴지통)/u,
  /라벨(?:을|를)?\s*(?:붙였|달았|추가했|지정했)/u,
  new RegExp(String.raw`(?:안\s?)?읽음\s*(?:으로\s*)?(?:표시|처리)(?:를)?\s*${KO_DONE}`, 'u'),
  new RegExp(String.raw`할\s?일(?:을|를|로|에|도)?\s*(?:\S{1,20}\s+){0,3}?(?:추가|등록|생성)${KO_DONE}|할\s?일(?:을|를)?\s*만들었`, 'u'),
  new RegExp(String.raw`(?:알림|리마인더)(?:을|를|도)?\s*(?:\S{1,20}\s+){0,3}?(?:설정|등록|추가)${KO_DONE}|(?:알림|리마인더)(?:을|를)?\s*맞춰`, 'u'),
  new RegExp(String.raw`(?:일정|이벤트|약속|회의)(?:을|를|도)?\s*(?:\S{1,20}\s+){0,3}?(?:추가|등록)${KO_DONE}|캘린더에\s*(?:추가|등록)${KO_DONE}`, 'u'),
];

/**
 * Drive-only Korean claims (CA re-review item 1): wordings that are ordinary in a mail about someone else's change
 * (`약관 업데이트를 했으니 확인하라는 메일이에요`), so they apply to a Drive summary only.
 */
const KO_DRIVE_CLAIMS: readonly RegExp[] = [
  // DRV-1: a document action with the file, folder, link or permission as its object (`문서를 공유했어요`, `파일을 삭제해
  // 드렸어요`, `권한을 변경했어요`). Narrow on purpose: `진행 상황을 공유했어요` in a meeting-notes summary is not a claim.
  new RegExp(String.raw`(?:문서|파일|시트|스프레드시트|폴더|드라이브|링크|권한|공유\s?설정)(?:을|를|은|는|도|들을)?\s*(?:\S{1,20}\s+){0,2}?(?:공유|편집|수정|삭제|이동|복사|업로드|변경|부여|휴지통으로\s?이동)\s?${KO_DONE}`, 'u'),
  /(?:문서|파일|시트|스프레드시트|폴더)(?:을|를|은|는|도|들을)?\s*(?:모두\s*|다\s*|전부\s*)?(?:\S{1,20}\s+){0,2}?(?:지웠|옮겼|고쳤|바꿨|올렸)/u,
  /(?:이름|제목|권한)(?:을|를)?\s*(?:\S{1,20}\s+){0,2}?(?:바꿨|변경했|바꿔\s?드렸|변경해\s?드렸)/u,
  new RegExp(String.raw`업데이트(?:를)?\s*${KO_DONE}`, 'u'),
  /공유를\s*완료했/u,
  /권한(?:을|를)?\s*(?:\S{1,20}\s+){0,2}?(?:드렸|줬|주었)/u,
  new RegExp(String.raw`내용(?:을|를)?\s*(?:\S{1,20}\s+){0,2}?(?:수정|편집|변경)\s?${KO_DONE}`, 'u'),
  new RegExp(String.raw`(?:에게|한테|께)\s*(?:\S{1,20}\s+){0,2}?공유\s?${KO_DONE}`, 'u'),
];

/** A subject-marked word in a Korean clause: `김철수가`, `팀장님이`, `제가` (only `이/가/께서/님이` count; group 2 is the marker). */
const KO_SUBJECT = /(?:^|\s)([^\s]{1,20}?)(께서|님이|이|가)(?=\s)/gu;

/**
 * English claims with a first-person or Quoky subject. Contractions take a straight or a curly apostrophe, and up to
 * six filler words may stand before the verb (`I went ahead and sent`, `I've just forwarded`).
 */
const enClaim = (verbs: string): RegExp =>
  new RegExp(
    "\\b(?:I(?:['’](?:ve|d))?|we(?:['’]ve)?|Quoky)\\s+" +
      '(?:(?:have|has|had|just|already|also|now|then|successfully|went|go|gone|ahead|and|quickly|immediately|actually|' +
      `promptly|simply|kindly)\\s+){0,6}(?:${verbs})\\b`,
    'i',
  );
const EN_MAIL_VERBS =
  'sent|forwarded|replied|responded|deleted|removed|archived|trashed|labell?ed|marked|moved|created|added|' +
  'scheduled|set\\s+up|set|booked|drafted';
const EN_CLAIM = enClaim(EN_MAIL_VERBS);

/**
 * Drive-only English verbs (the pre-DRV-1 mail guard is untouched): the document actions, and `updated`, `changed`,
 * `granted`, `gave`, `revised`, `fixed` (`The sender says we updated our privacy policy` is a mail's own news).
 */
const EN_DRIVE_CLAIM = enClaim(
  `${EN_MAIL_VERBS}|shared|unshared|edited|modified|renamed|uploaded|copied|updated|changed|granted|gave|revised|fixed`,
);

/**
 * Codex final delta: an emphatic `did` (`I did send a reply`, `we did forward it`) with a present-tense verb; `did not`
 * is a denial, not a claim. The guard stays best-effort (a paraphrase can always evade a lexicon): the fixed footer of
 * every summary, which states that nothing was sent or changed, is the guarantee.
 */
const enDidClaim = (verbs: string): RegExp =>
  new RegExp(
    `\\b(?:I|we|Quoky)\\s+(?:[a-z]{1,20}\\s+){0,3}?did\\s+(?!not\\b|n['’]t\\b)(?:[a-z]{1,20}\\s+){0,2}?(?:${verbs})\\b`,
    'i',
  );
const EN_DID_MAIL_VERBS = 'send|forward|reply|respond|delete|remove|archive|trash|label|mark|move|create|add|schedule|set\\s+up|book|draft';
const EN_DID_CLAIM = enDidClaim(EN_DID_MAIL_VERBS);
const EN_DID_DRIVE_CLAIM = enDidClaim(`${EN_DID_MAIL_VERBS}|share|unshare|edit|modify|rename|upload|copy|update|change|grant|give`);

/** Drive only: `I made the document public` (a visibility or access change). */
const EN_MADE_CLAIM =
  /\b(?:I|we|Quoky)\s+(?:[a-z]{1,20}\s+){0,3}?made\s+(?:[a-z]{1,20}\s+){0,3}?(?:public|private|editable|viewable|shareable)\b/i;

/** Format characters (zero-width spaces and joiners, bidi controls, soft hyphen). */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Letters that render blank (the Hangul fillers, the braille blank, the Khmer inherent vowels). */
const BLANK_LETTERS = /[ᅟᅠㅤﾠ⠀឴឵]/gu;
/** Combining marks (`Q̈uoky`), dropped after NFKD so a decorated letter is its base letter. */
const COMBINING_MARKS = /\p{M}/gu;
/** Cyrillic, Greek and Armenian letters that look like Latin ones (`Ԛuoky`, `Ι sent`), folded to the Latin letter. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  А: 'A', В: 'B', Е: 'E', Ѕ: 'S', І: 'I', Ј: 'J', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y',
  Х: 'X', Ԛ: 'Q', Ԝ: 'W', Ү: 'Y', а: 'a', е: 'e', ѕ: 's', і: 'i', ј: 'j', к: 'k', о: 'o', р: 'p', с: 'c', у: 'y',
  х: 'x', ԛ: 'q', ԝ: 'w', ү: 'y', һ: 'h',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  Ϙ: 'Q', α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', υ: 'u', γ: 'y', ϙ: 'q',
  օ: 'o', ս: 'u', հ: 'h',
};
const LOOKALIKE_LETTERS = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');
/**
 * `Quoky` with any run of non-letters between its letters (`Quo-ky`, `Quo    ky`, `Quo ~ - ky`, `Q.u.o.k.y`, `Qu0ky`)
 * and `쿼 키`: one word again. Linear: a separator run is scanned only by the attempt that starts at the letter before it
 * (a failed attempt gives the run back one non-letter at a time, and each fails at once on the next literal letter).
 */
const SPLIT_NAME = /q[^\p{L}\p{N}]*u[^\p{L}\p{N}]*[o0][^\p{L}\p{N}]*k[^\p{L}\p{N}]*y/giu;
const SPLIT_KO_NAME = /([쿼퀴])[^\p{L}\p{N}]*키/gu;

/**
 * The reply as the guard reads it (v5 gap 1): the invisible characters replaced by `invisible` (removed, so `보​냈어요` is
 * one word, or a space, so `I​sent` is two), NFKD with the combining marks dropped, then NFKC (full-width letters; the
 * jamo spelling `ㅋㅝㅋㅣ` is recomposed), lookalike letters folded, and a split `Quoky` / `쿼키` joined. Every step is a
 * single linear pass. The guard checks the reply as written and both forms, so normalising can only add a match.
 */
export function normalizeForClaimCheck(text: string, invisible: '' | ' ' = ''): string {
  return text
    .replace(FORMAT_CHARACTERS, invisible)
    .normalize('NFKD')
    .replace(BLANK_LETTERS, invisible)
    .replace(COMBINING_MARKS, '')
    .normalize('NFKC')
    .replace(LOOKALIKE_LETTERS, (letter) => LOOKALIKES[letter] ?? letter)
    .replace(SPLIT_NAME, 'Quoky')
    .replace(SPLIT_KO_NAME, '$1키');
}

/** Sentences: split on sentence ends and line breaks. */
function sentences(text: string): string[] {
  return text.split(/[.!?。\n]+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

/** Clauses of one sentence: split on Korean clause connectors. */
function clauses(sentence: string, source: UntrustedDocumentSource): string[] {
  // A mail summary splits exactly as before DRV-1; a Drive summary keeps `다고` (reported speech) in one clause.
  const split = source === 'drive' ? /(?:하고|했고|(?<!다)고)\s/u : /(?:하고|했고|고)\s/u;
  return sentence.split(split).map((clause) => clause.trim()).filter((clause) => clause.length > 0);
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** A word as the guard compares it: letters and digits only, lower case (`"Quo-ky"` → `quoky`). */
function wordOf(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** Quoky's name, alone or with a role glued to it (`quoky`, `쿼키`, `quoky봇`, `쿼키님`); `quoky-platform` is not it. */
const QUOKY_NAME_WORD = /^(?:quoky|쿼키|퀴키)(?:봇|님|비서|ai|어시스턴트)?$/u;

function isStandInWord(word: string): boolean {
  return KO_STAND_INS.has(word) || QUOKY_NAME_WORD.test(word);
}

/** A word that is an actor or a topic: the stem before `께서`, `님이`, `이/가`, `은/는` or `에서` (`Quoky에서`). */
const KO_ACTOR_FORM = /^(.{1,20}?)(?:님께서|께서|님이|님은|이|가|은|는|에서)$/u;
/** The first-person pronouns as subject or topic (`저가` is a price and `나이` an age, so the forms are spelled out). */
const KO_FIRST_PERSON_ACTORS = new Set([
  '제가', '저는', '저도', '저희가', '저희는', '저희도', '내가', '나는', '나도', '우리가', '우리는', '우리도',
]);
/** Words the model may use for itself that are also ordinary nouns (`시스템이 점검 중`): the claim's own sentence only. */
const KO_GENERIC_STAND_INS = new Set(['비서', '어시스턴트', '봇', '챗봇', 'ai', '에이아이', '시스템', 'i', 'we']);

/** The Hangul syllable's final consonant (0 = none) and medial vowel indices, or undefined for any other character. */
function hangul(character: string | undefined): { readonly final: number; readonly medial: number } | undefined {
  if (character === undefined || character.length !== 1) return undefined;
  const code = character.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return undefined;
  return { final: code % 28, medial: Math.floor(code / 28) % 21 };
}
/** A past or completed verb form: a syllable ending in ㅆ (`했`, `었`, `됐`, `드렸`), except the existential `있`. */
function hasPastSyllable(word: string): boolean {
  for (const character of word) if (character !== '있' && hangul(character)?.final === 20) return true;
  return false;
}
/** An open syllable on ㅏ ㅐ ㅓ ㅕ ㅘ ㅙ ㅝ (`해`, `셔`, `와`, `줘`, `내`): the infinitive of a verb, not `에`, `께` or `고`. */
function openInfinitive(character: string | undefined): boolean {
  const syllable = hangul(character);
  return syllable !== undefined && syllable.final === 0 && [0, 1, 4, 6, 9, 10, 14].includes(syllable.medial);
}

/** An action in a sentence that names Quoky: a claim stem, a benefactive, `대신`, or a past or completed verb. */
const KO_ACTION =
  /드렸|드립|드림|대신|대리|보내|보냈|전달|삭제|보관|발송|전송|회신|답장|처리|등록|추가|생성|설정|공유|수정|편집|이동|변경|업데이트|업로드|지웠|옮겼/u;

/** What one sentence says about Quoky as an actor, computed once per sentence (v5 gap 3). */
interface SentenceActors {
  /** A first-person pronoun or the name as actor or topic, in a sentence with an action (`Quoky가 처리했습니다`). */
  readonly acting: boolean;
  /** A generic stand-in as actor or topic (`비서가`): it removes the exemption in its own sentence only. */
  readonly generic: boolean;
}

/** Reported speech after a first-person word (`'저는 …'라고`, `…했다고 말씀하셨어요`): the third party's words. */
const KO_REPORTED_SPEECH = /라고|다고|냐고|자고|라며|다며|라는|다는|래요|대요/u;
const QUOTE_MARK = /["“”‘’'「」『』]/u;
/** An English reporting verb or a quote before `we` / `I` (`Kim says we finalized …`): the third party's words. */
const EN_REPORTING =
  /\b(?:say|says|said|write|writes|wrote|mention|mentions|mentioned|tell|tells|told|ask|asks|asked|note|notes|noted|explain|explains|explained|report|reports|reported|claim|claims|claimed|add|adds|added|confirm|confirms|confirmed|according\s+to)\b|["“‘]/i;

function actorsIn(sentence: string): SentenceActors {
  const tokens = sentence.split(/\s+/u).filter((token) => token.length > 0);
  const words = tokens.map(wordOf);
  // Reported speech after a word, read right to left once (linear).
  const reportedAfter: boolean[] = new Array<boolean>(tokens.length + 1).fill(false);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    reportedAfter[index] = reportedAfter[index + 1] === true || KO_REPORTED_SPEECH.test(tokens[index + 1] ?? '');
  }
  let quoted = false;
  let strong = false;
  let generic = false;
  for (let index = 0; index < words.length && !(strong && generic); index += 1) {
    const word = words[index] as string;
    const ownWords = !quoted && reportedAfter[index] !== true && !KO_REPORTED_SPEECH.test(tokens[index] ?? '');
    if (QUOTE_MARK.test(tokens[index] ?? '')) quoted = true;
    if (word.length === 0) continue;
    if (ownWords && KO_FIRST_PERSON_ACTORS.has(word)) strong = true;
    const stem = KO_ACTOR_FORM.exec(word)?.[1];
    const side = /^(?:측|쪽)(?:에서|이|가|은|는)?$/u.test(words[index + 1] ?? '');
    for (const candidate of [stem, side ? word : undefined]) {
      if (candidate === undefined) continue;
      const pronoun = side && (candidate === '저희' || candidate === '우리');
      if (QUOKY_NAME_WORD.test(candidate) || (ownWords && pronoun)) strong = true;
      if (KO_GENERIC_STAND_INS.has(candidate)) generic = true;
    }
  }
  const english = EN_ACTOR.exec(sentence);
  const reporting = EN_REPORTING.exec(sentence);
  const englishActor = english !== null && (reporting === null || reporting.index > english.index);
  const acting = (strong && (KO_ACTION.test(sentence) || hasPastSyllable(sentence))) || englishActor;
  return { acting, generic };
}

/**
 * How far a word between a subject and a claim ends the subject's scope (v5 gap 2, narrowed after the CA re-review).
 * - `STRONG`: a new clause whose subject is likely someone else. These are the causal, contrastive and conditional
 *   connectives (`-니까`, `-는데`, `-지만`, `-면`, `-길래`, `말하길`), a finite past verb (`했는데`, `했어요`), an honorific
 *   verb form (`부탁하셔서`, `요청하셨는데`), the past adnominals of the request verbs (`요청한`, `부탁하신`, `드린`,
 *   `시킨`), and sentence ends (`-니다`, `-어요`, `-서요`).
 * - `WEAK`: a sequential connective whose subject usually continues (`정리해서 공유했어요`, `검토하여`, `부탁해`,
 *   `시켜`). It ends the scope only for a humble benefactive claim (`… 보내 드렸습니다`).
 * - `NONE`: everything else, including adnominal and complement forms that only describe the object (`요청하는 메일`,
 *   `논의했던 예산안`, `참석하는지`, `제출하도록`, `받은 피드백`, `보낸 메일`, `확인해 달라는`, `중요한`, `에 대한`).
 */
const NONE = 0;
const WEAK = 1;
const STRONG = 2;
type ScopeEnd = typeof NONE | typeof WEAK | typeof STRONG;

const KO_CLAUSE_END =
  /(?:니까|으니|[는은던인한운]데|지만|[으하되시]면|므로|길래|기에|더니|거든|자마자|[하시라다]길|(?:요청|부탁|지시|문의|말씀|요구)(?:한|하신)|드린|시킨|니다|[어아해워와여에예세셔서]요|죠)$/u;
/** Adnominal and complement endings: a past or honorific form ending in one of these describes the object. */
const KO_DESCRIBING_END = /(?:던|는|을|은|신|실|다는|단|는지|을지|도록|다고|다며|대)$/u;
/** Honorific verb forms (`부탁하셔서`, `요청하셨는데`, `하시니`). */
const KO_HONORIFIC_VERB = /하셔|하시|셨/u;
/** Words ending like a predicate that are nouns or postpositions (`올해`, `피해`, `에 대해`, `위하여`, `통해`). */
const KO_NOT_A_PREDICATE = new Set([
  '해', '올해', '지난해', '새해', '매해', '한해', '이해', '피해', '손해', '방해', '재해', '오해', '견해', '침해', '동해', '서해', '남해',
  '대해', '위해', '관해', '통해', '의해', '인해', '대하여', '위하여', '관하여', '통하여', '의하여', '인하여',
]);
/** The auxiliary after a `-해` infinitive (`확인해 달라는`, `검토해 주세요`, `보내 드리`, `해 보니`): one predicate. */
const KO_AUXILIARY_START = /^(?:달라|달란|주|줘|줬|드리|드려|드렸|보|봐|봤|두|뒀|놓|놨)/u;

/** The scope end of one whitespace token (`next` is the text after it, for the `-해` auxiliary). Linear in the token. */
function scopeEnd(token: string, next: string): ScopeEnd {
  let start = 0;
  let end = token.length;
  while (start < end && !WORD_CHARACTER.test(token.charAt(start))) start += 1;
  while (end > start && !WORD_CHARACTER.test(token.charAt(end - 1))) end -= 1;
  if (start === end) return NONE;
  const word = token.slice(start, end);
  if (KO_NOT_A_PREDICATE.has(word)) return NONE;
  const tail = word.slice(-8);
  if (KO_CLAUSE_END.test(tail)) return STRONG;
  if ((hasPastSyllable(word) || KO_HONORIFIC_VERB.test(word)) && !KO_DESCRIBING_END.test(tail)) return STRONG;
  const last = word.charAt(word.length - 1);
  if (last === '서' && openInfinitive(word.charAt(word.length - 2))) return WEAK;
  if (tail.endsWith('하여') || tail.endsWith('시켜')) return WEAK;
  if (last === '해') return KO_AUXILIARY_START.test(next.trimStart()) ? NONE : WEAK;
  return /[,;:]/u.test(token.charAt(end)) && openInfinitive(last) ? WEAK : NONE;
}

/** A humble benefactive (`보내 드렸습니다`): the speaker serving the listener, never an honoured third party's own act. */
const KO_HUMBLE_BENEFACTIVE = /드렸|드립|드림/u;

/**
 * Reported speech right after the verb (`설정했다는 안내`, `보냈다고 해요`, `보냈대요`): the item says so, Quoky does not
 * claim it. (`…답니다` is not reported speech and is not exempt.) Sticky: read at the claim's end, no copy of the rest.
 */
const KO_REPORTED = /\S{0,20}?(?:다는|다고|단\s|대요|다며)/uy;

function reportedAt(text: string, index: number): boolean {
  KO_REPORTED.lastIndex = index;
  return KO_REPORTED.test(text);
}

/** A subject found once per clause: where it ends, whether it is a Quoky stand-in, whether it is honorific. */
interface ClauseSubject {
  readonly end: number;
  readonly standIn: boolean;
  readonly honorific: boolean;
}

interface ClauseToken {
  readonly start: number;
  readonly end: number;
  readonly scope: ScopeEnd;
}

/**
 * One clause, read once (linear): its real subjects in order, the first stand-in subject's end, and every token's scope
 * end with "next weak / next strong" indexes, so each claim match in the clause is judged by binary search.
 */
class ClauseReading {
  private subjectList: ClauseSubject[] | undefined;
  private tokenList: ClauseToken[] | undefined;
  private nextAt: { readonly weak: Int32Array; readonly strong: Int32Array } | undefined;
  private standInEnd: number | undefined;

  constructor(
    private readonly clause: string,
    private readonly source: UntrustedDocumentSource,
  ) {}

  private subjects(): ClauseSubject[] {
    if (this.subjectList !== undefined) return this.subjectList;
    const list: ClauseSubject[] = [];
    for (const match of this.clause.matchAll(KO_SUBJECT)) {
      const word = wordOf(match[1] ?? '');
      if (word.length === 0 || KO_NOT_A_SUBJECT.has(word)) continue;
      if (this.source === 'drive' && KO_DRIVE_NOT_A_SUBJECT.has(word)) continue;
      const marker = match[2] ?? '';
      list.push({
        end: (match.index ?? 0) + match[0].length,
        standIn: isStandInWord(word),
        honorific: marker === '께서' || marker === '님이' || word.endsWith('님'),
      });
    }
    this.subjectList = list;
    return list;
  }

  private tokens(): ClauseToken[] {
    if (this.tokenList !== undefined) return this.tokenList;
    const found = [...this.clause.matchAll(/\S+/gu)];
    this.tokenList = found.map((match, index) => {
      const start = match.index ?? 0;
      return { start, end: start + match[0].length, scope: scopeEnd(match[0], found[index + 1]?.[0] ?? '') };
    });
    return this.tokenList;
  }

  /** The index of the first token that starts at or after `position` (binary search). */
  private firstTokenFrom(position: number): number {
    const tokens = this.tokens();
    let low = 0;
    let high = tokens.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tokens[middle] as ClauseToken).start < position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /** For each token index, the first token at or after it whose scope end is at least weak / strong (right to left). */
  private next(): { readonly weak: Int32Array; readonly strong: Int32Array } {
    if (this.nextAt !== undefined) return this.nextAt;
    const tokens = this.tokens();
    const weak = new Int32Array(tokens.length + 1);
    const strong = new Int32Array(tokens.length + 1);
    weak[tokens.length] = tokens.length;
    strong[tokens.length] = tokens.length;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const scope = (tokens[index] as ClauseToken).scope;
      weak[index] = scope >= WEAK ? index : (weak[index + 1] as number);
      strong[index] = scope === STRONG ? index : (strong[index + 1] as number);
    }
    this.nextAt = { weak, strong };
    return this.nextAt;
  }

  /**
   * The strongest scope end in `[from, to)`: whole tokens, and the part before the claim of a token that runs into it
   * (`부탁하셔서메일을`, judged on at most its last 12 characters). O(log n) per claim after one linear pass.
   */
  private scopeBetween(from: number, to: number): ScopeEnd {
    const tokens = this.tokens();
    const first = this.firstTokenFrom(from);
    const { weak, strong } = this.next();
    const inside = (index: number): boolean => index < tokens.length && (tokens[index] as ClauseToken).end <= to;
    let scope: ScopeEnd = inside(strong[first] as number) ? STRONG : inside(weak[first] as number) ? WEAK : NONE;
    const cut = tokens[this.firstTokenFrom(to) - 1];
    if (scope !== STRONG && cut !== undefined && cut.start >= from && cut.end > to) {
      const part = scopeEnd(this.clause.slice(Math.max(cut.start, to - 12), to), this.clause.slice(to, to + 4));
      if (part > scope) scope = part;
    }
    return scope;
  }

  /**
   * Whether the claim at `claimAt` is exempt: the NEAREST real subject BEFORE it names someone other than Quoky
   * (`김철수가 메일을 보냈어요`). Fail closed (sign-off item 3): a Quoky stand-in subject anywhere before the claim in the
   * clause means no exemption (`제가 김철수가 요청한 답장을 보냈어요`); a subject after the claim, an adverb or a generic
   * noun never exempts. v5 narrows it further (gap 2): a strong scope end between the subject and the claim, or a weak
   * one before a humble benefactive claim, means the subject is not the claim's; an honorific subject never exempts a
   * humble benefactive claim.
   */
  exempt(claimAt: number, claim: string): boolean {
    const subjects = this.subjects();
    // Subjects are in order; a subject counts when its following space lies before the claim (as on a cut clause).
    let low = 0;
    let high = subjects.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((subjects[middle] as ClauseSubject).end < claimAt) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return false;
    if (this.firstStandInEnd() < claimAt) return false;
    const nearest = subjects[low - 1] as ClauseSubject;
    const humble = KO_HUMBLE_BENEFACTIVE.test(claim);
    const scope = this.scopeBetween(nearest.end, claimAt);
    if (scope === STRONG || (scope === WEAK && humble)) return false;
    return !(nearest.honorific && humble);
  }

  private firstStandInEnd(): number {
    if (this.standInEnd === undefined) {
      this.standInEnd = this.subjects().find((subject) => subject.standIn)?.end ?? Number.POSITIVE_INFINITY;
    }
    return this.standInEnd;
  }
}

const KO_MAIL_CLAIMS_ALL = KO_CLAIMS.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));
const KO_DRIVE_CLAIMS_ALL = [...KO_CLAIMS, ...KO_DRIVE_CLAIMS].map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

/**
 * A Korean clause claims an action when ANY match of ANY claim pattern is neither reported speech nor exempt. Matches
 * may overlap (CA re-review P1): after each match the search resumes one character after its start, so a wider exempt
 * match that starts earlier (`메일을 저가 답장을 보내줬`) cannot swallow the claim inside it (`답장을 보내줬`, after the
 * stand-in `저가`). Every pattern's repetition is bounded, so each match is short and the loop stays linear.
 */
function koreanClaim(clause: string, source: UntrustedDocumentSource, standInInScope: () => boolean): boolean {
  const reading = new ClauseReading(clause, source);
  for (const pattern of source === 'drive' ? KO_DRIVE_CLAIMS_ALL : KO_MAIL_CLAIMS_ALL) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(clause); match !== null; match = pattern.exec(clause)) {
      pattern.lastIndex = match.index + 1;
      if (reportedAt(clause, match.index + match[0].length)) continue;
      if (!standInInScope() && reading.exempt(match.index, match[0])) continue;
      return true;
    }
  }
  return false;
}

/**
 * v5: a passive said to be done at the owner's request (`요청하신 대로 메일이 발송되었습니다`): the requested act was
 * carried out, by no named actor. Reported speech (`처리되었다는 안내`) stays exempt.
 */
const KO_REQUESTED_PASSIVE =
  /(?:요청|말씀|부탁|지시|원)(?:하신|하셨던|한)\s*(?:\S{1,20}\s+){0,4}?(?:발송|전송|처리|전달|회신|삭제|보관|등록|추가|설정|예약|공유|수정)\s?(?:되었|됐|완료되었|완료됐)/gu;

function requestedPassive(sentence: string): boolean {
  for (const match of sentence.matchAll(KO_REQUESTED_PASSIVE)) {
    if (!reportedAt(sentence, match.index + match[0].length)) return true;
  }
  return false;
}

/**
 * v5: English claims with no `I` / `we` / `Quoky` subject that still say Quoky acted.
 * - A passive or a bare participle in a sentence that says it was done for the owner (`Message sent on your behalf`,
 *   `Email forwarded to Kim as requested`), unless an explicit third-party agent did it (`… by Alice`).
 * - An agentless passive anywhere in a reply in which Quoky or the first person acts (`Quoky handled your request.
 *   Your email has been sent.`), as in Korean.
 * - `Your reply was sent`, a bare `Reply sent.`, and a sentence that opens with the bare past verb (`Sent the reply.`),
 *   except a bullet under a heading that names a third party (`Kim's email:` / `Kim:`). `set` is left out of the
 *   dropped-subject form (it is also the imperative of an action item).
 */
const enPassive = (verbs: string): RegExp =>
  new RegExp(`\\b(?:(?:has|have|had)\\s+been|was|were|is|are|been|got|gets)\\s+(?:[a-z]{1,20}\\s+){0,2}?(?:${verbs})\\b`, 'i');
const EN_ON_YOUR_BEHALF =
  /\b(?:on\s+your\s+behalf|on\s+behalf\s+of\s+you|as\s+(?:you\s+)?requested|as\s+you\s+asked|per\s+your\s+request)\b/i;
/** A participle with no object after it (`sent on your behalf`), not an active verb with one (`Kim forwarded it`). */
const enBareParticiple = (verbs: string): RegExp =>
  new RegExp(
    `\\b(?:${verbs})\\b(?!\\s+(?:it|the|a|an|this|that|these|those|them|his|her|their|my|our|your|every|all)\\b)`,
    'i',
  );
/** An explicit agent that is not Quoky and not a time (`by Alice`, `by the sender`; not `by me`, `by Friday`). */
const EN_THIRD_PARTY_AGENT =
  /\bby\s+(?!(?:me|us|myself|quoky|the\s+assistant|your\s+assistant|an?\s+assistant|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|now|then|noon|midnight|eod|end|next|this|the\s+end|close)\b)[a-z]/i;
/** Quoky or the first person as the subject of a past verb (`Quoky handled`, `I checked`, `we've reviewed`). */
const EN_ACTOR =
  /\b(?:I|[Ww]e|Quoky|QUOKY|quoky)(?:['’](?:ve|d))?\s+(?:[a-z]{1,20}\s+){0,3}?(?:[a-z]{2,20}ed|sent|did|made|took|got|set|done|put)\b/;
const enYourReplyPassive = (verbs: string): RegExp =>
  new RegExp(
    `\\byour\\s+(?:reply|response|answer|draft)\\s+(?:(?:has|have|had)\\s+been|was|is|got)\\s+(?:[a-z]{1,20}\\s+){0,2}?(?:${verbs})\\b`,
    'i',
  );
const EN_DROPPED_SUBJECT_VERBS =
  'sent|forwarded|replied|responded|deleted|removed|archived|trashed|labell?ed|marked|moved|created|added|scheduled|booked|drafted';
const EN_DROPPED_SUBJECT = new RegExp(
  `^(?:[-*•>]\\s*)?(?:(?:done|ok|okay|sure|alright|all\\s+set)\\W{0,3}\\s*)?(?:(?:just|already|also|successfully)\\s+){0,2}` +
    `(?:${EN_DROPPED_SUBJECT_VERBS})\\s+(?:the|it|this|that|these|those|them|your|a|an|all|every|him|her)\\b`,
  'i',
);
/** A bare `Reply sent.` / `Email forwarded to Kim.`: the item and its participle, nothing else. */
const EN_BARE_DONE = new RegExp(
  `^(?:[-*•>]\\s*)?(?:the\\s+|your\\s+)?(?:reply|replies|response|answer|email|emails|e-mail|mail|message|messages|draft|invite|invitation|reminder)\\s+` +
    `(?:(?:just|already|successfully)\\s+)?(?:${EN_DROPPED_SUBJECT_VERBS})(?:\\s+(?:to|for)\\s+\\S+)?$`,
  'i',
);
const EN_PASSIVE_MAIL = enPassive(EN_MAIL_VERBS);
const EN_PASSIVE_DRIVE = enPassive(
  `${EN_MAIL_VERBS}|shared|unshared|edited|modified|renamed|uploaded|copied|updated|changed|granted|revised|fixed`,
);
const EN_BARE_MAIL = enBareParticiple(EN_DROPPED_SUBJECT_VERBS);
const EN_BARE_DRIVE = enBareParticiple(
  `${EN_DROPPED_SUBJECT_VERBS}|shared|unshared|edited|modified|renamed|uploaded|copied|updated|changed|granted|revised|fixed`,
);
const EN_YOUR_REPLY_PASSIVE = enYourReplyPassive(EN_MAIL_VERBS);

/** First words of a heading that are not a person (`Summary:`, `Next steps:`, `The sender:`) or are Quoky's own. */
const EN_HEADING_NOT_A_PERSON =
  /^(?:i|we|me|my|our|us|quoky|assistant|the|this|that|these|those|here|done|ok|okay|summary|status|update|updates|action|actions|result|results|note|notes|next|key|main|highlights|today|todo|reply|answer|response|thread|email|message|subject|from|to|re|fwd|tl|요약|결과|완료|다음|참고|정리)$/iu;
const HEADING_NAME = /^(?:[-*•>#]+\s*)?(\p{Lu}[\p{L}.-]{0,30}|[가-힣]{2,5})/u;

/**
 * A heading line that names a third party (CA re-review): any line ending in `:` whose first word is a name, not a
 * heading word or Quoky (`Kim's email:`, `Kim wrote:`, `Kim (Sales):`, `Kim's update:`, `Kim — key points:`, `김철수:`).
 */
function thirdPartyHeading(line: string): boolean {
  if (line.length > 120 || !line.endsWith(':')) return false;
  const name = HEADING_NAME.exec(line)?.[1];
  return name !== undefined && !EN_HEADING_NOT_A_PERSON.test(name) && !QUOKY_NAME_WORD.test(name.toLowerCase());
}

/** An item attributed to a third party at its end: `Sent the contract to legal (Kim).`, `(by Kim Lee)`, `(김철수)`. */
const EN_TRAILING_ATTRIBUTION =
  /\((?:by\s+|from\s+|per\s+)?(\p{Lu}[\p{L}.'’-]{0,30}(?:\s+\p{Lu}[\p{L}.'’-]{0,30}){0,2}|[가-힣]{2,5}(?:\s?님)?)\)\s*[.!]?$/u;

function attributedToThirdParty(line: string): boolean {
  const name = EN_TRAILING_ATTRIBUTION.exec(line.length > 200 ? line.slice(-200) : line)?.[1];
  if (name === undefined) return false;
  const first = name.split(/\s/u)[0] ?? '';
  return !EN_HEADING_NOT_A_PERSON.test(first) && !QUOKY_NAME_WORD.test(first.toLowerCase());
}

/**
 * The dropped-subject and bare-participle sentences, line by line. Bullets under a third-party heading (blank lines
 * keep the heading) and items attributed to a third party at their end are the third party's, not Quoky's.
 */
function droppedSubjectClaim(text: string): boolean {
  let thirdPartyBullets = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.endsWith(':')) {
      thirdPartyBullets = thirdPartyHeading(trimmed);
      continue;
    }
    const bullet = /^(?:[-*•>]|\d{1,3}[.)]\s)/u.test(trimmed);
    if (!bullet) thirdPartyBullets = false;
    if ((bullet && thirdPartyBullets) || attributedToThirdParty(trimmed)) continue;
    if (sentences(trimmed).some((sentence) => EN_DROPPED_SUBJECT.test(sentence) || EN_BARE_DONE.test(sentence))) return true;
  }
  return false;
}

/** Clauses of an English sentence, so request framing must govern the passive's own clause (`As requested, here is …:`). */
const EN_CLAUSE_SPLIT = /[:;—–]|\s-\s/u;

function englishClaim(
  text: string,
  all: readonly string[],
  source: UntrustedDocumentSource,
  actorInReply: () => boolean,
): boolean {
  if (EN_CLAIM.test(text) || EN_DID_CLAIM.test(text) || EN_YOUR_REPLY_PASSIVE.test(text)) return true;
  // The Drive wordings are active for a Drive summary only: a mail's own news ("we changed our pricing") is not a claim.
  if (source === 'drive' && (EN_DRIVE_CLAIM.test(text) || EN_DID_DRIVE_CLAIM.test(text) || EN_MADE_CLAIM.test(text))) return true;
  const passive = source === 'drive' ? EN_PASSIVE_DRIVE : EN_PASSIVE_MAIL;
  const bare = source === 'drive' ? EN_BARE_DRIVE : EN_BARE_MAIL;
  for (const sentence of all) {
    for (const clause of sentence.split(EN_CLAUSE_SPLIT)) {
      if (EN_THIRD_PARTY_AGENT.test(clause) || !EN_ON_YOUR_BEHALF.test(clause)) continue;
      if (passive.test(clause) || bare.test(clause)) return true;
    }
    if (!EN_THIRD_PARTY_AGENT.test(sentence) && passive.test(sentence) && actorInReply()) return true;
  }
  return droppedSubjectClaim(text);
}

/**
 * One text form, read once: its sentences and what each says about Quoky as an actor (computed once and shared by the
 * English and Korean checks). A first-person or named Quoky actor in a sentence with an action, anywhere in the reply,
 * withholds every claim a third-party subject would otherwise exempt (gap 3: `Quoky가 처리했습니다. 김철수가 … 보냈습니다.`);
 * a mention without an action (`쿼키가 요약합니다`) does not. A generic stand-in counts in its own sentence only.
 */
function claimIn(text: string, source: UntrustedDocumentSource): boolean {
  const all = sentences(text);
  // Read lazily, once: only a claim match or an agentless passive needs to know who acts in the reply.
  let actors: SentenceActors[] | undefined;
  let acting: boolean | undefined;
  const actorsOf = (): SentenceActors[] => (actors ??= all.map(actorsIn));
  const actorInReply = (): boolean => (acting ??= actorsOf().some((actor) => actor.acting));
  if (englishClaim(text, all, source, actorInReply)) return true;
  return all.some(
    (sentence, index) =>
      requestedPassive(sentence) ||
      clauses(sentence, source).some((clause) =>
        koreanClaim(clause, source, () => actorInReply() || actorsOf()[index]?.generic === true),
      ),
  );
}

/**
 * Whether a document-summary reply claims that Quoky performed a mail or Quoky-domain action. Checked on the reply as
 * written and on both normalized forms ({@link normalizeForClaimCheck}), so normalising never hides a claim; a form
 * identical to one already checked is not checked again.
 */
export function containsDocumentActionClaim(text: string, source: UntrustedDocumentSource): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (claimIn(text, source)) return true;
  const removed = normalizeForClaimCheck(text, '');
  if (removed !== text && claimIn(removed, source)) return true;
  const spaced = normalizeForClaimCheck(text, ' ');
  return spaced !== removed && spaced !== text && claimIn(spaced, source);
}

/** The fixed notice per source (CA review P3-5): a new source fails typecheck until it has its own notice. */
const WITHHELD_NOTICE: Readonly<Record<UntrustedDocumentSource, { readonly ko: string; readonly en: string }>> = {
  mail: {
    en:
      'The summary claimed an action that was never taken, so it was not shown. Quoky only read the email: nothing was ' +
      'sent, replied to, forwarded, deleted, archived, labelled or scheduled, and no to-do or reminder was created.',
    ko:
      '요약이 하지 않은 일을 했다고 말해서 보여 드리지 않았어요. Quoky는 메일을 읽기만 했고, 보내기·답장·전달·삭제·보관·' +
      '라벨 변경·일정 추가를 하지 않았으며 할 일이나 알림도 만들지 않았어요.',
  },
  'mail-thread': {
    en:
      'The summary claimed an action that was never taken, so it was not shown. Quoky only read the email thread: ' +
      'nothing was sent, replied to, forwarded, deleted, archived, labelled or scheduled, and no to-do or reminder was ' +
      'created.',
    ko:
      '요약이 하지 않은 일을 했다고 말해서 보여 드리지 않았어요. Quoky는 메일 스레드를 읽기만 했고, 보내기·답장·전달·삭제·' +
      '보관·라벨 변경·일정 추가를 하지 않았으며 할 일이나 알림도 만들지 않았어요.',
  },
  drive: {
    en:
      'The summary claimed an action that was never taken, so it was not shown. Quoky only read the document: nothing ' +
      'was edited, shared, moved, renamed or deleted, no permission changed, and no to-do or reminder was created.',
    ko:
      '요약이 하지 않은 일을 했다고 말해서 보여 드리지 않았어요. Quoky는 문서를 읽기만 했고, 수정·공유·이동·이름 변경·' +
      '삭제·권한 변경을 하지 않았으며 할 일이나 알림도 만들지 않았어요.',
  },
};

/**
 * The fixed reply that replaces a summary claiming an action (never shown, never stored). It names what the item's
 * source could have done (DRV-1: a document is edited, shared or moved, not sent); neutral nouns only.
 */
export function renderDocumentActionClaimWithheld(language: 'ko' | 'en', source: UntrustedDocumentSource): string {
  return WITHHELD_NOTICE[source][language];
}
