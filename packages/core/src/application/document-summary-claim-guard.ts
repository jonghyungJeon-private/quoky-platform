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

/** Korean claims of a mail action or of a created to-do / reminder / calendar entry (past or completed tense). */
const KO_CLAIMS: readonly RegExp[] = [
  /(?:답장|회신|메일|이메일|요약)(?:을|를|은|는)?\s*(?:[^\s]{1,8}\s+){0,2}?(?:보냈|보내\s?드렸|전송했|발송했)/u,
  /(?:전달|삭제|보관|발송|전송|회신|답장)(?:을|를)?\s*(?:했|해\s?드렸|해\s?두었|해\s?놓았|완료했|하였)/u,
  /(?:삭제|보관|전달|발송|읽음)\s*처리\s*(?:를\s*)?(?:했|해\s?드렸|해\s?두었|완료했|하였)/u,
  /(?:메일|이메일)(?:을|를|은|는|들을)?\s*(?:모두\s*|다\s*|전부\s*)?(?:지웠|옮겼|휴지통)/u,
  /라벨(?:을|를)?\s*(?:붙였|달았|추가했|지정했)/u,
  /(?:안\s?)?읽음\s*(?:으로\s*)?(?:표시|처리)(?:를)?\s*(?:했|해\s?드렸|해\s?두었)/u,
  /할\s?일(?:을|를|로|에|도)?\s*(?:\S{1,20}\s+){0,3}?(?:추가|등록|생성)(?:했|해\s?드렸|해\s?두었|하였)|할\s?일(?:을|를)?\s*만들었/u,
  /(?:알림|리마인더)(?:을|를|도)?\s*(?:\S{1,20}\s+){0,3}?(?:설정|등록|추가)(?:했|해\s?드렸|해\s?두었|하였)|(?:알림|리마인더)(?:을|를)?\s*맞춰/u,
  /(?:일정|이벤트|약속|회의)(?:을|를|도)?\s*(?:\S{1,20}\s+){0,3}?(?:추가|등록)(?:했|해\s?드렸|해\s?두었|하였)|캘린더에\s*(?:추가|등록)(?:했|해\s?드렸|해\s?두었)/u,
];

/**
 * Drive-only Korean claims (CA re-review item 1): wordings that are ordinary in a mail about someone else's change
 * (`약관 업데이트를 했으니 확인하라는 메일이에요`), so they apply to a Drive summary only.
 */
const KO_DRIVE_CLAIMS: readonly RegExp[] = [
  // DRV-1: a document action with the file, folder, link or permission as its object (`문서를 공유했어요`, `파일을 삭제해
  // 드렸어요`, `권한을 변경했어요`). Narrow on purpose: `진행 상황을 공유했어요` in a meeting-notes summary is not a claim.
  /(?:문서|파일|시트|스프레드시트|폴더|드라이브|링크|권한|공유\s?설정)(?:을|를|은|는|도|들을)?\s*(?:\S{1,20}\s+){0,2}?(?:공유|편집|수정|삭제|이동|복사|업로드|변경|부여|휴지통으로\s?이동)\s?(?:했|해\s?드렸|해\s?두었|해\s?놓았|완료했|하였)/u,
  /(?:문서|파일|시트|스프레드시트|폴더)(?:을|를|은|는|도|들을)?\s*(?:모두\s*|다\s*|전부\s*)?(?:\S{1,20}\s+){0,2}?(?:지웠|옮겼|고쳤|바꿨|올렸)/u,
  /(?:이름|제목|권한)(?:을|를)?\s*(?:\S{1,20}\s+){0,2}?(?:바꿨|변경했|바꿔\s?드렸|변경해\s?드렸)/u,
  /업데이트(?:를)?\s*(?:했|해\s?드렸|해\s?두었)/u,
  /공유를\s*완료했/u,
  /권한(?:을|를)?\s*(?:\S{1,20}\s+){0,2}?(?:드렸|줬|주었)/u,
  /내용(?:을|를)?\s*(?:\S{1,20}\s+){0,2}?(?:수정|편집|변경)\s?(?:했|해\s?드렸|해\s?두었|해\s?놓았|완료했|하였)/u,
  /(?:에게|한테|께)\s*(?:\S{1,20}\s+){0,2}?공유\s?(?:했|해\s?드렸|해\s?두었|해\s?놓았|완료했|하였)/u,
];

/** A subject-marked word in a Korean clause: `김철수가`, `팀장님이`, `제가` (only `이/가/께서/님이` count). */
const KO_SUBJECT = /(?:^|\s)([^\s]{1,20}?)(?:께서|님이|이|가)(?=\s)/gu;

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

/** Sentences and clauses: split on sentence ends, line breaks and Korean clause connectors. */
function clauses(text: string, source: UntrustedDocumentSource): string[] {
  // A mail summary splits exactly as before DRV-1; a Drive summary keeps `다고` (reported speech) in one clause.
  const split = source === 'drive' ? /[.!?。\n]+|(?:하고|했고|(?<!다)고)\s/u : /[.!?。\n]+|(?:하고|했고|고)\s/u;
  return text.split(split).map((clause) => clause.trim()).filter((clause) => clause.length > 0);
}

/**
 * Whether the claim at `claimAt` is exempt: the NEAREST real subject BEFORE it names someone other than Quoky
 * (`김철수가 메일을 보냈어요`). Fail closed (sign-off item 3): if ANY Quoky stand-in is a subject before the claim in the
 * same clause, the claim is never exempt — a relative clause (`제가 김철수가 요청한 답장을 보냈어요`) puts a third-person
 * subject nearest the verb while Quoky is still the actor. A subject after the claim, an adverb or a generic noun never
 * exempts.
 */
function exemptBySubject(clause: string, claimAt: number, source: UntrustedDocumentSource): boolean {
  let nearest: string | undefined;
  for (const match of clause.slice(0, claimAt).matchAll(KO_SUBJECT)) {
    // An opening quote or bracket is not part of the subject (`"제가 …"` is still the first person).
    const word = (match[1] ?? '').replace(/^["'“”‘’「『(\[<]+/u, '').toLowerCase();
    if (word.length === 0 || KO_NOT_A_SUBJECT.has(word) || (source === 'drive' && KO_DRIVE_NOT_A_SUBJECT.has(word))) continue;
    if (KO_STAND_INS.has(word)) return false;
    nearest = word;
  }
  return nearest !== undefined;
}

/**
 * Reported speech right after the verb (`설정했다는 안내`, `보냈다고 해요`, `보냈대요`): the item says so, Quoky does not
 * claim it. (`…답니다` is not reported speech and is not exempt.)
 */
const KO_REPORTED = /^\S{0,20}?(?:다는|다고|단\s|대요|다며)/u;

function koreanClaim(clause: string, source: UntrustedDocumentSource): boolean {
  for (const pattern of source === 'drive' ? [...KO_CLAIMS, ...KO_DRIVE_CLAIMS] : KO_CLAIMS) {
    const match = pattern.exec(clause);
    if (match === null) continue;
    if (KO_REPORTED.test(clause.slice(match.index + match[0].length))) continue;
    if (exemptBySubject(clause, match.index, source)) continue;
    return true;
  }
  return false;
}

/** Whether a document-summary reply claims that Quoky performed a mail or Quoky-domain action. */
export function containsDocumentActionClaim(text: string, source: UntrustedDocumentSource): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (EN_CLAIM.test(text) || EN_DID_CLAIM.test(text)) return true;
  // The Drive wordings are active for a Drive summary only: a mail's own news ("we changed our pricing") is not a claim.
  if (source === 'drive' && (EN_DRIVE_CLAIM.test(text) || EN_DID_DRIVE_CLAIM.test(text) || EN_MADE_CLAIM.test(text))) return true;
  return clauses(text, source).some((clause) => koreanClaim(clause, source));
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
