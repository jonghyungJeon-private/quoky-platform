/**
 * The action-claim post-guard for a document summary (ADR-0118 D7/D8, GML-1 review P2-3). The ADR-0104 internal-action
 * guard knows Quoky's own domains (commit, push, to-do, reminder, …) but not mail actions, and a hostile mail can steer
 * its summary into "I forwarded the email" or "답장을 보냈어요". A summary performs no action, so a reply that claims, in the
 * first person or with Quoky as the subject, that a mail was sent, forwarded, replied to, deleted, archived, labelled
 * or marked read, or that a to-do, reminder or calendar entry was created, is withheld whole with a fixed notice.
 *
 * Third-person sentences about the item's author stay allowed ("김철수 님이 회의 자료를 보냈어요", "Kim sent the deck"):
 * a Korean clause with a non-first-person subject (`<word>이/가/께서`) is exempt, and an English claim needs an
 * `I` / `we` / `Quoky` subject. Every pattern is linear (bounded repetition only) on the provider's bounded reply.
 */

/** First-person or Quoky subjects in Korean: a clause with one of these is never exempt. */
const KO_FIRST_PERSON = new Set(['제', '저', '내', '나', '저희', '우리', 'quoky', '쿼키']);

/** Korean claims of a mail action or of a created to-do / reminder / calendar entry (past or completed tense). */
const KO_CLAIMS: readonly RegExp[] = [
  /(?:답장|회신|메일|이메일|요약)(?:을|를|은|는)?\s*(?:모두\s*|다\s*|전부\s*)?(?:보냈|보내\s?드렸|전송했|발송했)/u,
  /(?:전달|삭제|보관|발송|전송|회신|답장)(?:을|를)?\s*(?:했|해\s?드렸|해\s?두었|해\s?놓았|완료했|하였)/u,
  /(?:메일|이메일)(?:을|를|은|는|들을)?\s*(?:모두\s*|다\s*|전부\s*)?(?:지웠|옮겼|휴지통)/u,
  /라벨(?:을|를)?\s*(?:붙였|달았|추가했|지정했)/u,
  /(?:안\s?)?읽음\s*(?:으로\s*)?(?:표시|처리)(?:를)?\s*(?:했|해\s?드렸|해\s?두었)/u,
  /할\s?일(?:을|를|로|에|도)?\s*(?:\S+\s+){0,3}?(?:추가|등록|생성)(?:했|해\s?드렸|해\s?두었|하였)|할\s?일(?:을|를)?\s*만들었/u,
  /(?:알림|리마인더)(?:을|를|도)?\s*(?:\S+\s+){0,3}?(?:설정|등록|추가)(?:했|해\s?드렸|해\s?두었|하였)|(?:알림|리마인더)(?:을|를)?\s*맞춰/u,
  /(?:일정|이벤트|약속|회의)(?:을|를|도)?\s*(?:\S+\s+){0,3}?(?:추가|등록)(?:했|해\s?드렸|해\s?두었|하였)|캘린더에\s*(?:추가|등록)(?:했|해\s?드렸|해\s?두었)/u,
];

/** A subject-marked word in a Korean clause: `김철수가`, `팀장님이`, `회사에서는`… (only `이/가/께서` count). */
const KO_SUBJECT = /(?:^|\s)([^\s]{1,20}?)(?:께서|님이|이|가)\s/gu;

/** English claims with a first-person or Quoky subject. */
const EN_CLAIM =
  /\b(?:I|I've|I'd|we|we've|Quoky)\s+(?:(?:have|has|had|just|already|also|now|then|successfully)\s+){0,3}(?:sent|forwarded|replied|responded|deleted|removed|archived|trashed|labell?ed|marked|moved|created|added|scheduled|set\s+up|set|booked|drafted)\b/i;

/** Sentences and clauses: split on sentence ends, line breaks and Korean clause connectors. */
function clauses(text: string): string[] {
  return text.split(/[.!?。\n]+|(?:하고|했고|고)\s/u).map((clause) => clause.trim()).filter((clause) => clause.length > 0);
}

function hasThirdPersonSubject(clause: string): boolean {
  for (const match of clause.matchAll(KO_SUBJECT)) {
    const word = (match[1] ?? '').toLowerCase();
    if (word.length > 0 && !KO_FIRST_PERSON.has(word)) return true;
  }
  return false;
}

/** Reported speech right after the verb (`설정했다는 안내`, `보냈다고 해요`): the item says so, Quoky does not claim it. */
const KO_REPORTED = /^\S*?(?:다는|다고|단\s|대요|답니다|다며)/u;

function koreanClaim(clause: string): boolean {
  for (const pattern of KO_CLAIMS) {
    const match = pattern.exec(clause);
    if (match === null) continue;
    if (KO_REPORTED.test(clause.slice(match.index + match[0].length))) continue;
    return true;
  }
  return false;
}

/** Whether a document-summary reply claims that Quoky performed a mail or Quoky-domain action. */
export function containsDocumentActionClaim(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (EN_CLAIM.test(text)) return true;
  return clauses(text).some((clause) => koreanClaim(clause) && !hasThirdPersonSubject(clause));
}

/** The fixed reply that replaces a summary claiming an action (never shown, never stored). */
export function renderDocumentActionClaimWithheld(language: 'ko' | 'en'): string {
  return language === 'en'
    ? 'The summary claimed an action that was never taken, so it was not shown. Quoky only read the email: nothing was ' +
        'sent, replied to, forwarded, deleted, archived, labelled or scheduled, and no to-do or reminder was created.'
    : '요약이 하지 않은 일을 했다고 말해서 보여 드리지 않았어요. Quoky는 메일을 읽기만 했고, 보내기·답장·전달·삭제·보관·' +
        '라벨 변경·일정 추가를 하지 않았으며 할 일이나 알림도 만들지 않았어요.';
}
