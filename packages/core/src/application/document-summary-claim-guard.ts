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
 * v5 claim-guard gaps (closed structurally, never by widening an exemption): the reply is checked both as written and
 * normalized ({@link normalizeForClaimCheck}: format characters removed, blank letters read as spaces, NFKD with the
 * combining marks dropped, NFKC, Cyrillic/Greek lookalikes folded, and a spaced, hyphenated or dotted `Quo-ky` / `쿼 키`
 * collapsed), so a split name is the name. A third-party subject exempts a claim only when it is the subject of the
 * claim's own verb: a predicate between them (`부탁하셔서`, `요청한`, `했는데`) ends its scope, and an honorific subject
 * never exempts a humble benefactive claim (`김철수님이 … 보내 드렸습니다`). A Quoky stand-in acting anywhere in the reply
 * (a first-person pronoun or the name; a generic stand-in such as `비서` in the claim's sentence or a neighbouring one)
 * means no claim is exempt, so a cross-sentence split cannot hide the actor.
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

/**
 * v5: English claims with no `I` / `we` / `Quoky` subject that still say Quoky acted. A passive in a sentence that says
 * it was done for the owner (`The reply has been sent on your behalf`, `… as you requested`), with or without an agent;
 * the owner's own reply passively done (`Your reply was sent`); and a sentence that opens with the bare past verb, the
 * subject dropped (`Sent the reply.`, `Done — forwarded it to Kim.`), so `Quoky here. Sent the reply.` cannot split the
 * subject from the verb. `set` is left out of the dropped-subject form (it is also the imperative of an action item).
 */
const enPassive = (verbs: string): RegExp =>
  new RegExp(`\\b(?:(?:has|have|had)\\s+been|was|were|is|are|been|got|gets)\\s+(?:[a-z]{1,20}\\s+){0,2}?(?:${verbs})\\b`, 'i');
const EN_ON_YOUR_BEHALF =
  /\b(?:on\s+your\s+behalf|on\s+behalf\s+of\s+you|as\s+(?:you\s+)?requested|as\s+you\s+asked|per\s+your\s+request)\b/i;
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
const EN_PASSIVE_MAIL = enPassive(EN_MAIL_VERBS);
const EN_PASSIVE_DRIVE = enPassive(
  `${EN_MAIL_VERBS}|shared|unshared|edited|modified|renamed|uploaded|copied|updated|changed|granted|revised|fixed`,
);
const EN_YOUR_REPLY_PASSIVE = enYourReplyPassive(EN_MAIL_VERBS);

function englishClaim(text: string, source: UntrustedDocumentSource): boolean {
  if (EN_CLAIM.test(text) || EN_DID_CLAIM.test(text) || EN_YOUR_REPLY_PASSIVE.test(text)) return true;
  // The Drive wordings are active for a Drive summary only: a mail's own news ("we changed our pricing") is not a claim.
  if (source === 'drive' && (EN_DRIVE_CLAIM.test(text) || EN_DID_DRIVE_CLAIM.test(text) || EN_MADE_CLAIM.test(text))) return true;
  const passive = source === 'drive' ? EN_PASSIVE_DRIVE : EN_PASSIVE_MAIL;
  return sentences(text).some(
    (sentence) => EN_DROPPED_SUBJECT.test(sentence) || (EN_ON_YOUR_BEHALF.test(sentence) && passive.test(sentence)),
  );
}

/**
 * Invisible characters: the format characters (zero-width spaces and joiners, bidi controls, soft hyphen) and the
 * letters that render blank (the Hangul fillers, the braille blank, the Khmer inherent vowels).
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const BLANK_LETTERS = /[\u115F\u1160\u3164\uFFA0\u2800\u17B4\u17B5]/gu;
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
/** `Quoky` with up to three non-letters between its letters (`Quo-ky`, `Quo ky`, `Q.u.o.k.y`, `Qu0ky`): one word again. */
const SPLIT_NAME = /q[^\p{L}\p{N}]{0,3}u[^\p{L}\p{N}]{0,3}[o0][^\p{L}\p{N}]{0,3}k[^\p{L}\p{N}]{0,3}y/giu;
const SPLIT_KO_NAME = /([쿼퀴])[^\p{L}\p{N}]{0,3}키/gu;

/**
 * The reply as the guard reads it (v5 gap 1): the invisible characters replaced by `invisible` (removed, so `보​냈어요` is
 * one word, or a space, so `I​sent` is two), NFKD with the combining marks dropped, then NFKC (full-width letters),
 * lookalike letters folded, and a split `Quoky` / `쿼키` joined. Every step is a single linear pass. The guard checks
 * the reply as written and both forms, so normalising can only add a match, never remove one.
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
/** Words the model may use for itself that are also ordinary nouns (`시스템이 점검 중`): scoped to nearby sentences. */
const KO_GENERIC_STAND_INS = new Set(['비서', '어시스턴트', '봇', '챗봇', 'ai', '에이아이', '시스템', 'i', 'we']);

/**
 * Whether a Quoky stand-in acts or is the topic in `span` (v5 gap 3): a first-person pronoun (`제가`, `저는`), the name
 * as an actor (`Quoky가`, `쿼키는`, `Quoky에서`, `저희 측에서`) and, when `generic`, a generic stand-in (`비서가`).
 */
function standInActs(span: string, generic: boolean): boolean {
  const words = span.split(/\s+/u).map(wordOf).filter((word) => word.length > 0);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (KO_FIRST_PERSON_ACTORS.has(word)) return true;
    const stem = KO_ACTOR_FORM.exec(word)?.[1];
    const side = /^(?:측|쪽)(?:에서|이|가|은|는)?$/u.test(words[index + 1] ?? '');
    for (const candidate of [stem, side ? word : undefined]) {
      if (candidate === undefined) continue;
      if (QUOKY_NAME_WORD.test(candidate) || (side && (candidate === '저희' || candidate === '우리'))) return true;
      if (generic && KO_GENERIC_STAND_INS.has(candidate)) return true;
    }
  }
  return false;
}

/** The Hangul syllable's final consonant (0 = none) and medial vowel indices, or undefined for any other character. */
function hangul(character: string): { readonly final: number; readonly medial: number } | undefined {
  const code = character.charCodeAt(0) - 0xac00;
  if (character.length !== 1 || code < 0 || code > 11171) return undefined;
  return { final: code % 28, medial: Math.floor(code / 28) % 21 };
}
/** An open syllable on ㅏ ㅐ ㅓ ㅕ ㅘ ㅙ ㅝ (`해`, `셔`, `와`, `줘`, `내`): the infinitive of a verb, not `에`, `께` or `고`. */
function openInfinitive(character: string | undefined): boolean {
  const syllable = character === undefined ? undefined : hangul(character);
  return syllable !== undefined && syllable.final === 0 && [0, 1, 4, 6, 9, 10, 14].includes(syllable.medial);
}

/**
 * Word endings of a Korean predicate that is not the claim's own verb: connectives (`-니까`, `-면서`, `-는데`, `-지만`,
 * `-도록`, `-려고`, `-길래`), adnominals of a relative clause (`요청한`, `보낸`, `받은`, `하던`, `하는`, `하신`) and
 * sentence ends (`-니다`, `-어요`). `-한` also ends an adjective (`중요한 메일`); it is counted anyway, failing closed.
 */
const KO_PREDICATE_END =
  /(?:니까|으니|면서|[으하되시이]며|[으하되시]면|[는은던인한운]데|지만|도록|려고|려면|자마자|길래|기에|느라고?|므로|더니|다가|거든|[는은]지|던|한|된|[하되시주]는|(?:있|없|보내|드리|받)는|(?:[하주드오되가]|보내|계)신|낸|드린|받은|읽은|만든|남긴|쓴|해준|보내온|니다|[어아해워와여에예세셔]요|죠)$/u;
/** Honorific verb forms (`부탁하셔서`, `요청하셨는데`, `하시니`). */
const KO_HONORIFIC_VERB = /하셔|하시|셨/u;

/**
 * Whether `span` (the words between a subject and the claim) holds a predicate, so the subject belongs to another
 * clause (v5 gap 2): `김철수님이 부탁하셔서 메일을 보내 드렸습니다`, `김철수가 요청한 메일을 보냈어요`. A predicate is a word
 * with a past or existential stem (a syllable ending in ㅆ: `했`, `었`, `있`), an honorific verb form, an `-아서/-어서`
 * connective (`해서`, `와서`; `에서` and `께서` are particles), a predicate ending, or an infinitive before a comma (`부탁해,`).
 */
function predicateBetween(span: string): boolean {
  for (const token of span.split(/\s+/u)) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (word.length === 0) continue;
    const characters = [...word];
    if (characters.some((character) => hangul(character)?.final === 20)) return true;
    if (KO_HONORIFIC_VERB.test(word) || KO_PREDICATE_END.test(word)) return true;
    if (word.endsWith('서') && openInfinitive(characters[characters.length - 2])) return true;
    if (/[,;:]$/u.test(token) && openInfinitive(characters[characters.length - 1])) return true;
  }
  return false;
}

/** A humble benefactive (`보내 드렸습니다`): the speaker serving the listener, never an honoured third party's own act. */
const KO_HUMBLE_BENEFACTIVE = /드렸|드립|드림/u;

/**
 * Whether the claim at `claimAt` is exempt: the NEAREST real subject BEFORE it names someone other than Quoky
 * (`김철수가 메일을 보냈어요`). Fail closed (sign-off item 3): if ANY Quoky stand-in is a subject before the claim in the
 * same clause, the claim is never exempt — a relative clause (`제가 김철수가 요청한 답장을 보냈어요`) puts a third-person
 * subject nearest the verb while Quoky is still the actor. A subject after the claim, an adverb or a generic noun never
 * exempts. v5 narrows the exemption further: the subject must govern the claim's own verb (no predicate between them,
 * gap 2), an honorific subject never exempts a humble benefactive claim, and a Quoky stand-in acting in scope
 * (`standInInScope`: the whole reply, or the neighbouring sentences for a generic stand-in) means no exemption (gap 3).
 */
function exemptBySubject(
  clause: string,
  claimAt: number,
  claim: string,
  source: UntrustedDocumentSource,
  standInInScope: boolean,
): boolean {
  if (standInInScope) return false;
  let nearest: { readonly end: number; readonly honorific: boolean } | undefined;
  for (const match of clause.slice(0, claimAt).matchAll(KO_SUBJECT)) {
    const word = wordOf(match[1] ?? '');
    if (word.length === 0 || KO_NOT_A_SUBJECT.has(word) || (source === 'drive' && KO_DRIVE_NOT_A_SUBJECT.has(word))) continue;
    if (isStandInWord(word)) return false;
    const marker = match[2] ?? '';
    nearest = { end: (match.index ?? 0) + match[0].length, honorific: marker === '께서' || marker === '님이' || word.endsWith('님') };
  }
  if (nearest === undefined) return false;
  if (predicateBetween(clause.slice(nearest.end, claimAt))) return false;
  return !(nearest.honorific && KO_HUMBLE_BENEFACTIVE.test(claim));
}

/**
 * Reported speech right after the verb (`설정했다는 안내`, `보냈다고 해요`, `보냈대요`): the item says so, Quoky does not
 * claim it. (`…답니다` is not reported speech and is not exempt.)
 */
const KO_REPORTED = /^\S{0,20}?(?:다는|다고|단\s|대요|다며)/u;

function koreanClaim(clause: string, source: UntrustedDocumentSource, standInInScope: boolean): boolean {
  for (const pattern of source === 'drive' ? [...KO_CLAIMS, ...KO_DRIVE_CLAIMS] : KO_CLAIMS) {
    const match = pattern.exec(clause);
    if (match === null) continue;
    if (KO_REPORTED.test(clause.slice(match.index + match[0].length))) continue;
    if (exemptBySubject(clause, match.index, match[0], source, standInInScope)) continue;
    return true;
  }
  return false;
}

/**
 * The Korean check over the whole reply (v5 gap 3): each clause is judged with the reply around it, so a first-person
 * or named Quoky actor anywhere in the reply, or a generic stand-in in the claim's sentence or the one before or after
 * it, withholds a claim that a third-party subject would otherwise exempt (`Quoky가 처리했습니다. 김철수가 … 보냈습니다.`).
 */
function koreanReplyClaim(text: string, source: UntrustedDocumentSource): boolean {
  const all = sentences(text);
  const actorInReply = standInActs(text, false);
  return all.some((sentence, index) => {
    const nearby = actorInReply || standInActs(`${all[index - 1] ?? ''} ${sentence} ${all[index + 1] ?? ''}`, true);
    return clauses(sentence, source).some((clause) => koreanClaim(clause, source, nearby));
  });
}

function claimIn(text: string, source: UntrustedDocumentSource): boolean {
  return englishClaim(text, source) || koreanReplyClaim(text, source);
}

/**
 * Whether a document-summary reply claims that Quoky performed a mail or Quoky-domain action. Checked on the reply as
 * written and on both normalized forms ({@link normalizeForClaimCheck}), so normalising never hides a claim.
 */
export function containsDocumentActionClaim(text: string, source: UntrustedDocumentSource): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return (
    claimIn(text, source) ||
    claimIn(normalizeForClaimCheck(text, ''), source) ||
    claimIn(normalizeForClaimCheck(text, ' '), source)
  );
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
