/**
 * Internal-action claim guard (ADR-0104 D1/D2, DET-1; amends the ADR-0098 amendment D2 guard scope).
 *
 * A chat reply performs no action. When a GENERAL_CHAT or POLICY_SENSITIVE_CHAT reply claims that Quoky did, or will,
 * perform a Quoky-domain action (commit, push, PR, merge, branch, apply/file change, to-do, reminder, memory, connector
 * write), or asserts the state of such an action that Quoky did not report ("삭제된 상태가 맞습니다", "완료된 상태로
 * 보입니다"), the whole reply is replaced by a fixed notice: nothing was done, plus the exact command for the domain.
 *
 * Pure and provider-neutral: Core applies it to the chat reply text of every provider (no provider-id branching). It
 * matches the claim SHAPE only, through a closed, versioned lexicon (`internal-action-vocabulary.ts`):
 *  - first-person or impersonal completed / promised aspect of a domain verb paired with a domain noun
 *    ("커밋했습니다", "푸시했어요", "할 일을 추가했습니다", "완료 처리했습니다", "I've pushed", "has been merged");
 *  - completed-state assertions about a domain object ("삭제된 상태가 맞습니다", "완료된 상태로 보입니다", "성공적으로
 *    완성하였습니다"), whose domain comes from the sentence or, failing that, from the current User message.
 * Exemptions (mirroring QUAL-6): fenced/inline code, double-quoted text and block quotes; a translation clause; a
 * reply that renders a passage the User asked to translate when that passage itself carries the same claim ("변경 사항을
 * 커밋했습니다 영어로 번역해줘"); conditionals and how-to forms ("~하면", "~하려면", "~했다면"); imperatives addressed
 * to the User ("커밋하세요"); questions; negations ("하지 않았어요", "상태가 맞지 않습니다", "I haven't pushed"); and an
 * acknowledgement of the User's OWN action — a reportative ending ("삭제했군요", "커밋했네요") or a second-person subject
 * ("사용자가 브랜치를 삭제했습니다", "you said your PR is merged") — unless Quoky itself is the nearest subject ("제가",
 * "Quoky가"). Exemptions are clause-scoped (";", a dash, ", so/and/but/then", Korean connectives): a how-to, report or
 * negation in one clause never hides a claim in another ("Your PR is merged, so you can delete the branch."). A memory
 * claim needs Quoky's own memory ("기억", "my/your memory"), never a technical "memory"/"메모리". A language preference
 * ("한국어로 답해줘", "in English please") is never an exemption: it does not make a claiming reply a rendering.
 */
import type { GeneralChatReplyPolicy } from './chat-response-policy';
import {
  INTERNAL_ACTION_DOMAINS,
  INTERNAL_ACTION_VOCABULARY,
  noticeLanguage,
  renderInternalActionClaimNotice,
  type InternalActionDomain,
} from './internal-action-vocabulary';

// ── Korean ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Auxiliary service / completion forms after "해": "해 드렸어요", "해 둘게요", "해 놨어요". */
const KO_AUX = String.raw`\s*(?:드렸|드릴게|드릴께|드리겠|뒀|두었|둘게|둘께|두겠|놓았|놨|놓을게|놓겠)`;
/** Completed or promised forms after a Sino-Korean verb noun ("추가했", "생성하였", "등록할게", "삭제됐", "완료"). */
const KO_DO = String.raw`(?:(?:완료\s*(?:처리\s*)?)?(?:했|하였|하겠|할게|할께|해${KO_AUX}|됐|되었|돼\s*있|되어\s*있)|완료(?=\s*(?:[.!~]|$|입니다|이에요|예요|했|하였|됐|되었|처리\s*(?:했|하였|됐|되었))))`;
const KO_PARTICLE = String.raw`(?:\s*(?:을|를|이|가|은|는|도|에|에서|으로|로))?\s*`;
/** A conditional, reported, question or negated continuation means the clause does not claim the action. */
const KO_NOT_A_CLAIM = String.raw`(?!\s*(?:는지|냐|나요|나\?|니\?|을까|다면|다고|다는|단|더라도|더라면|던|을\s*(?:때|경우|수|지)|으면|면|지\s*(?:않|못|마|말)|기\s*(?:전|위해|를)|어야|야\s*(?:해|합|할)|었다면|었는지))`;
/** Native Korean verbs: [past, connective (takes a service aux), promise stem (+게), intent stem (+겠)]. */
const NATIVE_VERBS = {
  make: ['만들었', '만들어', '만들', '만들'],
  erase: ['지웠', '지워', '지울', '지우'],
  upload: ['올렸', '올려', '올릴', '올리'],
  open: ['열었', '열어', '열', '열'],
  swap: ['바꿨', '바꿔', '바꿀', '바꾸'],
  fit: ['맞췄', '맞춰', '맞출', '맞추'],
  hang: ['걸었', '걸어', '걸', '걸'],
  leave: ['남겼', '남겨', '남길', '남기'],
  attach: ['달았', '달아', '달', '달'],
  send: ['보냈', '보내', '보낼', '보내'],
  put: ['넣었', '넣어', '넣을', '넣'],
} as const;
type NativeVerb = keyof typeof NATIVE_VERBS;

/** "만들었" / "만들어 드렸" / "만들게" / "만들겠" for each listed verb; `null` when the domain has none. */
function koNative(verbs: readonly NativeVerb[]): string | null {
  if (verbs.length === 0) return null;
  return verbs
    .map((verb) => {
      const [past, connective, promise, intent] = NATIVE_VERBS[verb];
      return String.raw`${past}|${connective}${KO_AUX}|${promise}(?:게|께)|${intent}겠`;
    })
    .join('|');
}

/** Which native verbs pair with which domain noun ("PR을 만들었어요", "브랜치를 지웠어요", "Jira에 댓글을 남겼어요"). */
const KO_NATIVE_BY_DOMAIN: Readonly<Record<InternalActionDomain, readonly NativeVerb[]>> = {
  commit: [],
  push: ['upload'],
  pr: ['make', 'upload', 'open'],
  merge: [],
  branch: ['make', 'erase', 'swap'],
  apply: ['swap'],
  todo: ['put'],
  reminder: ['fit', 'hang', 'make'],
  memory: [],
  'connector-write': ['make', 'upload', 'leave', 'attach', 'send'],
};
const GAP = String.raw`[^.!?\n]{0,24}?`;

function escapeAlternation(source: string): string {
  return `(?:${source})`;
}

const NOUN_IS_VERB: ReadonlySet<InternalActionDomain> = new Set(['commit', 'push', 'merge']);

/** "<noun> … <verb><completed form>" or "<noun-verb><completed form>" for one domain. */
function koDomainClaim(domain: InternalActionDomain): RegExp {
  const entry = INTERNAL_ACTION_VOCABULARY[domain];
  const noun = escapeAlternation(entry.nouns);
  const verb = escapeAlternation(entry.koVerbs);
  const native = koNative(KO_NATIVE_BY_DOMAIN[domain]);
  const action = native === null ? String.raw`${verb}\s*${KO_DO}` : String.raw`${verb}\s*${KO_DO}|${native}`;
  // Only commit / push / merge nouns are verbs themselves ("커밋했어요", "푸시 완료", "머지됐어요"); "기억했어요" is not a
  // durable-memory claim and "PR했어요" is not Korean.
  const nounAsVerb = NOUN_IS_VERB.has(domain) ? String.raw`|${noun}${KO_PARTICLE}${KO_DO}` : '';
  const source = String.raw`${noun}${GAP}${KO_PARTICLE}(?:${action})${nounAsVerb}`;
  return new RegExp(String.raw`(?:${source})${KO_NOT_A_CLAIM}`, 'giu');
}

/** Domain-specific Korean claims that carry their own domain without a noun. */
const KO_SPECIAL: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = [
  // "완료 처리했습니다" is the to-do command's own verb.
  ['todo', new RegExp(String.raw`완료\s*처리\s*(?:했|하였|해${KO_AUX}|됐|되었)${KO_NOT_A_CLAIM}`, 'gu')],
  // A promise to remind at a time ("내일 9시에 알려 드릴게요"); "방법을 알려 드릴게요" names no time and is not matched.
  [
    'reminder',
    new RegExp(
      String.raw`(?:\d+\s*(?:분|시간|일|시)|내일|모레|아침|저녁|오전|오후|매일|매주|정각)${GAP}알려\s*(?:드릴게|드릴께|드리겠)`,
      'gu',
    ),
  ],
  // A promise or report of durably storing / forgetting ("기억해 둘게요", "기억해 뒀어요", "잊어버릴게요"), and a report
  // that Quoky remembered ("기억했습니다", W1-L02: no memory write ever happens on a chat turn — only "기억해:" stores).
  // A plain conversational promise "기억할게요" is not matched: the session transcript does carry it within the
  // conversation (the notice names "기억해:" when a storing claim is made).
  [
    'memory',
    new RegExp(
      String.raw`(?:기억해\s*(?:둘게|둘께|두겠|두었|뒀|놓을게|놓았|놨|드릴게|드렸)|기억\s*(?:했|하였)|잊어\s*(?:버렸|버릴게|버리겠|드릴게|드렸)|잊을게|잊겠)${KO_NOT_A_CLAIM}`,
      'gu',
    ),
  ],
];

/** Domain verbs whose completed-state assertion needs no noun in the sentence. */
const KO_STATE_VERB = String.raw`(?:삭제|완료|생성|적용|커밋|푸시|병합|머지|저장|등록|취소|설정|반영|정리|추가|전환|처리|제거|완성)`;
/**
 * A negated or questioned continuation of a state assertion ("상태가 맞지 않습니다", "상태로 보이지 않아요", "상태가
 * 아닌 것 같아요", "상태가 맞는지 확인해 보세요", "확인이 안 됐어요"): the sentence does not assert the state. The
 * window stops at a comma so a later, separate negation ("…보입니다, 푸시는 안 됐어요") does not hide the assertion.
 */
const KO_STATE_NOT_ASSERTED = String.raw`(?!\s*(?:이|되)?(?:는지|ㄴ지|인지|은지|나요|을까|일까|다면|으면|면)|[^.!?\n,]{0,8}?(?:지\s*(?:않|못)|아니|아닌|안\s*(?:됐|되었|돼|되|된|되어)))`;
/** "삭제된 상태가 맞습니다", "완료된 상태로 보입니다", "적용되어 있습니다", "이미 삭제되었습니다", "성공적으로 완성하였습니다". */
const KO_STATE_ASSERTION = new RegExp(
  String.raw`(?:${[
    String.raw`${KO_STATE_VERB}(?:된|되어\s*있는|돼\s*있는)\s*상태(?:가\s*맞|로\s*보|로\s*확인|가\s*확인|입니다|예요|에요|이에요|인\s*것\s*같|일\s*거)`,
    String.raw`${KO_STATE_VERB}(?:되어|돼)\s*있(?:습니다|어요|네요|는\s*것으로\s*보|는\s*것\s*같)`,
    String.raw`이미\s*${KO_STATE_VERB}(?:되었|됐|했|하였)${KO_NOT_A_CLAIM}`,
    String.raw`(?:성공적으로|정상적으로|무사히|모두|전부)\s*${KO_STATE_VERB}(?:하였|했|되었|됐)${KO_NOT_A_CLAIM}`,
  ].join('|')})${KO_STATE_NOT_ASSERTED}`,
  'gu',
);

/** A noun-less report of storing something ("저장했어요", "기록해 뒀어요"): a memory claim when the User asked about memory. */
const KO_NOUNLESS_STORE = new RegExp(
  String.raw`(?:저장|기록)\s*(?:했|하였|해${KO_AUX}|됐|되었)${KO_NOT_A_CLAIM}`,
  'gu',
);

/**
 * A reportative / acknowledging ending right after the verb: the reply acknowledges what the User did ("브랜치를
 * 삭제했군요", "커밋했네요", "PR을 만들었다니", "푸시했잖아요"), it does not report Quoky's own action.
 */
const KO_REPORTATIVE_TAIL = /^\s*(?:군|구나|구먼|구려|네요|네(?![가-힣])|다니|다면서|잖)/u;
/** Quoky (the reply's speaker) named as the subject ("제가 커밋했잖아요", "Quoky가 삭제했습니다"). */
const KO_FIRST_PERSON = String.raw`(?:제가|저는|저도|저희가|내가|나는|(?:quoky|쿼키|퀴키)(?:가|는|도|에서))`;
/** The User named as the subject ("사용자가 브랜치를 삭제했습니다", "당신이 커밋했어요"). */
const KO_SECOND_PERSON = String.raw`(?:당신(?:이|은|께서)|사용자(?:님)?(?:이|가|께서|는|은)|회원님(?:이|께서|은)|고객님(?:이|께서|은)|본인(?:이|께서))`;
/** Every person subject in a sentence; group 1 is set for Quoky (first person), group 2 for the User. */
const KO_PERSON_SUBJECT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(${KO_FIRST_PERSON})|(${KO_SECOND_PERSON}))(?![\p{L}\p{N}])`,
  'giu',
);

/**
 * Clause boundaries inside one sentence: ";", a dash, ", so/and/but/then/because", a Korean comma, and a Korean
 * connective ending (-니까/-으니/-어서/-고/-지만/-는데/-면서) before a space. An exemption (negation, how-to, report,
 * subject) applies to its own clause only, so "Your PR is merged, so you can delete the branch." still claims.
 */
const CLAUSE_BOUNDARY = new RegExp(
  [
    String.raw`\s*[;—–]\s*`,
    String.raw`\s+-\s+`,
    String.raw`,\s*(?=(?:so|and|but|then|because)\b)`,
    String.raw`(?<=[가-힣]),\s*`,
    String.raw`(?<=[가-힣](?:니까|으니|어서|아서|해서|여서|고|지만|는데|면서))\s+`,
  ].join('|'),
  'giu',
);

/** The `[start, end)` clauses of a sentence (boundaries excluded). */
function clauseRanges(sentence: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let cursor = 0;
  for (const boundary of sentence.matchAll(CLAUSE_BOUNDARY)) {
    if (boundary.index > cursor) ranges.push([cursor, boundary.index]);
    cursor = boundary.index + boundary[0].length;
  }
  if (cursor < sentence.length) ranges.push([cursor, sentence.length]);
  return ranges;
}

/** The clauses of a sentence as text. */
function clausesOf(sentence: string): string[] {
  return clauseRanges(sentence).map(([start, end]) => sentence.slice(start, end));
}

/** Start offset of the clause holding `index`. */
function clauseStartOf(sentence: string, index: number): number {
  let start = 0;
  for (const [from] of clauseRanges(sentence)) if (from <= index) start = from;
  return start;
}

/**
 * A closed list of Korean verbs in a relative (관형형) form that govern a preceding subject ("당신이 말한 거",
 * "사용자님이 요청하신 브랜치", "당신이 만든 브랜치"): the User subject belongs to that embedded clause, Quoky is the
 * subject of the main verb. Determiners and adjectives ("다른", "새", "이", "그", "모든", "여러", "중요한") are not in
 * it, so "사용자가 다른 브랜치를 삭제했습니다" stays the User's own action.
 */
const KO_HA_STEMS =
  '말|말씀|얘기|이야기|요청|부탁|언급|작성|지정|선택|입력|추가|생성|삭제|등록|설정|제안|공유|수정|원|지시|설명|질문|명령|업로드|커밋|푸시|머지|병합|확인|사용|이용|준비|기록|저장|예약|변경|전환|정리|제거|완료|처리|작업|개발|구현|배포|빌드|테스트|검토|리뷰|관리|편집|복사|이동|분리|생성|연결';
const KO_HA_RELATIVE = '한|하신|하는|하시는|했던|하셨던|하던|하시던|할|하실';
const KO_NATIVE_RELATIVE =
  '만든|만드신|만드는|만들던|만들|쓴|쓰신|쓰는|쓰던|보낸|보내신|보내는|보내던|올린|올리신|올리는|올리던|준|주신|주는|주던|줬던|' +
  '적은|적으신|적는|적던|고른|고르신|남긴|남기신|넣은|넣으신|바꾼|바꾸신|고친|고치신|지운|지우신|붙인|붙이신|' +
  '알려준|알려주신|알려주는|받은|받으신|정한|정하신|한|하신|하는|했던|하던|할';
const KO_RELATIVE_VERB = new RegExp(
  String.raw`^(?:(?:${KO_HA_STEMS})\s?(?:${KO_HA_RELATIVE})|${KO_NATIVE_RELATIVE}|[가-힣]*(?:해|어|아|여)(?:준|주신|주는|주던|줬던))$`,
  'u',
);

/**
 * True when the Korean claim at `[start, end)` acknowledges the User's own action rather than claiming Quoky's. The
 * nearest person subject before the verb decides (a subject carries over into the next clause, "사용자가 PR을
 * 만들었고 브랜치를 삭제했습니다"): Quoky in the same clause is always a claim; a reportative ending ("삭제했군요")
 * is the User's; a User subject is the User's unless a relative verb from the closed list governs it ("당신이 말한 거
 * 기억했습니다").
 */
function koUsersOwnAction(sentence: string, start: number, end: number): boolean {
  let nearest: { readonly firstPerson: boolean; readonly index: number; readonly end: number } | null = null;
  for (const subject of sentence.slice(0, start).matchAll(KO_PERSON_SUBJECT)) {
    nearest = { firstPerson: subject[1] !== undefined, index: subject.index, end: subject.index + subject[0].length };
  }
  const reportative = KO_REPORTATIVE_TAIL.test(sentence.slice(end));
  // Quoky as the nearest subject is a claim even across clauses ("제가 확인했고 브랜치를 삭제했네요"); only an
  // honorific reportative verb (-셨/-하신 …군요/네요) marks the User's own action after a Quoky clause ("제가 보니
  // 브랜치를 삭제하셨네요").
  if (nearest?.firstPerson) {
    const honorific = /(?:셨|으신|하신)/u.test(sentence.slice(start, Math.min(sentence.length, end + 2)));
    return nearest.index < clauseStartOf(sentence, start) && reportative && honorific;
  }
  if (reportative) return true;
  if (nearest === null) return false;
  const between = sentence.slice(nearest.end, start).trim();
  return between === '' || !between.split(/\s+/u).some((word) => KO_RELATIVE_VERB.test(word.replace(/[^\p{L}\p{N}]+$/u, '')));
}

/** The first match of a global Korean claim pattern that Quoky claims (not the User's own action), or `null`. */
function koQuokyClaim(sentence: string, pattern: RegExp): RegExpMatchArray | null {
  for (const match of sentence.matchAll(pattern)) {
    if (!koUsersOwnAction(sentence, match.index, match.index + match[0].length)) return match;
  }
  return null;
}

// ── English ────────────────────────────────────────────────────────────────────────────────────────────────────

const EN_CONDITIONAL = String.raw`(?<!\b(?:if|once|when|after|before|until|unless|whether|whenever)\s)`;
const EN_ADVERB = String.raw`(?:\s+(?:just|already|now|successfully|also|gone\s+ahead\s+and))?`;
const EN_PAST_SUBJECT = String.raw`${EN_CONDITIONAL}\bI(?:'ve|\s+have)?${EN_ADVERB}\s+`;
const EN_FUTURE_SUBJECT = String.raw`(?:${EN_CONDITIONAL}\bI(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)\s+(?:now\s+|also\s+|go\s+ahead\s+and\s+)?|\blet\s+me\s+(?:go\s+ahead\s+and\s+)?)`;

/** English per-domain verbs: [past, base]. The noun is required later in the same sentence unless `nounless`. */
const EN_VERBS: Readonly<Record<InternalActionDomain, { past: string; base: string; nounless?: boolean }>> = {
  commit: { past: 'committed', base: 'commit', nounless: true },
  push: { past: 'pushed', base: 'push', nounless: true },
  pr: { past: 'created|opened|raised|submitted|filed', base: 'create|open|raise|submit|file' },
  merge: { past: 'merged', base: 'merge' },
  branch: { past: 'deleted|removed|created|switched\\s+to|checked\\s+out|cleaned\\s+up', base: 'delete|remove|create|switch\\s+to|check\\s+out|clean\\s+up' },
  apply: { past: 'applied|updated|modified|changed|edited|saved|created|deleted|written\\s+to|wrote\\s+to', base: 'apply|update|modify|change|edit|save|create|delete|write\\s+to' },
  todo: { past: 'added|completed|marked|cancell?ed|removed|checked\\s+off|linked', base: 'add|complete|mark|cancel|remove|check\\s+off|link' },
  reminder: { past: 'set|scheduled|created|added|cancell?ed|removed|deleted', base: 'set|schedule|create|add|cancel|remove|delete' },
  memory: { past: 'saved|stored|deleted|removed|recorded|noted', base: 'save|store|delete|remove|record|note' },
  'connector-write': { past: 'created|filed|posted|commented|sent|updated|opened', base: 'create|file|post|comment|send|update|open' },
};

/** English nouns per domain (narrower than the Korean lexicon: "task"/"issue" alone are too generic here). */
const EN_NOUNS: Readonly<Record<InternalActionDomain, string>> = {
  commit: String.raw`commits?|changes`,
  push: String.raw`branch|changes|commits?|remote|origin`,
  pr: String.raw`pr|pull\s+requests?|merge\s+requests?`,
  merge: String.raw`pr|pull\s+requests?|branch|changes|into\s+main`,
  branch: String.raw`branch(?:es)?`,
  apply: String.raw`files?|workspace|repo(?:sitory)?|project|patch`,
  todo: String.raw`to-?dos?|to-?do\s+list|task\s+list`,
  reminder: String.raw`reminders?|alarms?`,
  memory: String.raw`memory|memories`,
  'connector-write': String.raw`jira|slack|confluence|github\s+issues?|tickets?|comments?`,
};

function enDomainClaim(domain: InternalActionDomain): RegExp {
  const { past, base, nounless } = EN_VERBS[domain];
  const verb = String.raw`(?:${EN_PAST_SUBJECT}(?:${past})|${EN_FUTURE_SUBJECT}(?:${base}))\b`;
  const source = nounless ? verb : String.raw`${verb}[^.!?\n]*\b(?:${EN_NOUNS[domain]})\b`;
  return new RegExp(source, 'iu');
}

/** English claims that carry their own domain without a noun ("I'll remind you", "I'll remember that"). */
const EN_SPECIAL: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = [
  ['reminder', new RegExp(String.raw`${EN_FUTURE_SUBJECT}remind\s+you\b|${EN_PAST_SUBJECT}set\s+(?:a|the|your)\s+reminder\b`, 'iu')],
  // Durable storing / forgetting ("I'll save that to memory", "I've forgotten it") and a report of having remembered
  // ("I've remembered that", "I remembered what you said", W1-L02); a conversational promise "I'll remember that" is not
  // matched, mirroring the Korean "기억할게요".
  [
    'memory',
    new RegExp(
      String.raw`${EN_FUTURE_SUBJECT}(?:save|store|keep|add)\s+(?:that|this|it)\s+(?:in|to)\s+(?:my\s+|your\s+)?(?:long-term\s+)?memory\b|${EN_PAST_SUBJECT}(?:forgotten|deleted\s+(?:that|this|it)\s+from\s+(?:my\s+)?memory)\b` +
        String.raw`|${EN_CONDITIONAL}\bI(?:'ve|\s+have)\s+(?:now\s+|already\s+|also\s+)?remembered\b` +
        String.raw`|${EN_CONDITIONAL}\bI\s+(?:already\s+|also\s+)?remembered\s+(?:it|this|everything|what\s+you\s+(?:said|told\s+me|mentioned|shared)|your)\b`,
      'iu',
    ),
  ],
];

/**
 * Impersonal completion / state assertions; the domain comes from the sentence's nouns or the User message. Perfect
 * ("has been merged") and past ("was deleted") passives assert a state, as does "now" / "already" ("your PR is now
 * merged"); a plain present passive asserts one about a specific Quoky-scope object (`EN_PRESENT_STATE`: "Your PR is
 * merged."), but not in generic how-to prose ("In Git, a branch is deleted with git branch -d").
 */
const EN_STATE_ASSERTION =
  /\b(?:has|have)\s+(?:now\s+|already\s+)?been\s+(?:successfully\s+)?(?:committed|pushed|merged|created|opened|added|completed|marked|set|scheduled|saved|deleted|removed|cancell?ed|applied|updated|posted)\b|\b(?:was|were)\s+(?:now\s+|already\s+)?(?:successfully\s+)?(?:committed|pushed|merged|deleted|completed|done|cancell?ed|applied|removed)\b|\b(?:is|are)\s+(?:now|already)\s+(?:successfully\s+)?(?:committed|pushed|merged|deleted|completed|done|cancell?ed|applied|removed)\b/iu;
/**
 * A present-state completion about a Quoky-scope object ("Your PR is merged.", "The changes are pushed.", "Your reminder
 * is set for 5 PM.", "The to-do is added."), with a determiner so the object is a specific one. Generic how-to prose
 * ("a branch is deleted with git branch -d", "the commits are pushed to origin by CI") is excluded by the agent /
 * instrument continuation here and by `EN_GENERIC` on the sentence.
 */
const EN_PRESENT_STATE = new RegExp(
  String.raw`\b(?:your|the|this|that|my|these|those)\s+(?:[\w./#-]+\s+){0,2}?` +
    String.raw`(?:pr|pull\s+requests?|merge\s+requests?|changes|commits?|branch(?:es)?|reminders?|alarms?|to-?dos?|to-?do\s+list|memory|memories)` +
    String.raw`(?:\s+#?\d+)?\s+(?:is|are)\s+(?:all\s+|now\s+|already\s+)?(?:successfully\s+)?` +
    String.raw`(?:merged|created|opened|pushed|committed|set(?:\s+up)?|scheduled|added|saved|stored|deleted|removed|completed|done|applied|cancell?ed|marked\s+(?:as\s+)?(?:done|complete(?:d)?))\b` +
    String.raw`(?!\s+(?:with|by|using|via|through|when|if|once|after|before|automatically)\b)`,
  'iu',
);
/** Generic / instructional prose (clause-scoped): a present passive there describes how things work. */
const EN_GENERIC =
  /\b(?:usually|typically|generally|normally|often|always|sometimes|by\s+default|you\s+(?:can|could|should|may|might|need\s+to|have\s+to)|can\s+be|in\s+git(?:hub)?)\b/iu;
/** A sentence-initial purpose frame ("To merge, …") makes the whole sentence instructional. */
const EN_INSTRUCTION_FRAME = /^\s*to\s+[a-z]+\s*,/iu;
/** The reply relays the User's own report ("you said your PR is merged"), it does not assert the state itself. */
const EN_REPORTED =
  /\b(?:you\s+(?:said|say|mentioned|told\s+me|wrote|reported|noted|confirmed|indicated)|you(?:'ve|\s+have)\s+(?:said|mentioned|told\s+me|confirmed)|according\s+to\s+you|as\s+you\s+(?:said|mentioned|noted))\b/iu;
/**
 * A memory-save report that names Quoky's memory or is a subject-less clause-initial report ("That is now stored in my
 * memory.", "saved to your Quoky memory", "Got it — saved to memory."). A technical passive ("Data is stored in memory
 * during program execution.") names no owner and is not one.
 */
const EN_MEMORY_STORED = new RegExp(
  String.raw`\b(?:saved|stored|noted|recorded)\s+(?:(?:it|that|this)\s+)?(?:in|to)\s+(?:my|your|quoky(?:'s)?)\s+(?:quoky\s+)?(?:long-term\s+)?memory\b` +
    String.raw`|^\s*(?:(?:got\s+it|done|ok(?:ay)?|sure|alright)\s*[,.!]?\s*)?(?:all\s+|now\s+)?(?:saved|stored)\s+(?:(?:it|that|this)\s+)?(?:in|to)\s+(?:long-term\s+)?memory\b`,
  'iu',
);
/**
 * A memory claim must be about Quoky's own memory: a "기억" word, an owned memory ("my / your / Quoky memory") or a
 * remember request; a technical "memory" / "메모리" alone (RAM, a cache) is not Quoky's memory.
 */
const MEMORY_OWNERSHIP =
  /기억|\b(?:my|your)\s+(?:quoky\s+)?(?:long-term\s+)?memor|quoky(?:'s)?\s+memor|(?:quoky|쿼키|퀴키)의?\s*(?:기억|메모리)|(?<![\p{L}\p{N}])(?:제|내|저의|나의)\s*(?:장기\s*)?메모리|long-term\s+memory|\bremember/iu;
const EN_NEGATION = /\b(?:not|never|n't|no\s+longer)\b/iu;
/** A subordinate / instruction clause around an English state ("Once the changes are committed, push them"). */
const EN_SUBORDINATE = /\b(?:if|once|when|whenever|after|before|until|unless|whether|make\s+sure|ensure|check|verify)\b/iu;
/** State verbs that are themselves a domain ("커밋된", "푸시되어", "병합된", "has been merged"). */
const STATE_VERB_DOMAINS: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = [
  ['commit', /커밋|committed/iu],
  ['push', /푸시|pushed/iu],
  ['merge', /병합|머지|merged/iu],
];

// ── prose extraction and exemptions ────────────────────────────────────────────────────────────────────────────

/** A sentence that is (or introduces) a translation, gloss or meaning is a mention, never a claim. */
const TRANSLATION_CLAUSE = /번역|영어로는|한국어로는|영문으로는|뜻(?:은|이에요|입니다)|의미(?:는|예요|입니다)|translat|in\s+(?:english|korean)|means\b|\(Translated\s+from/iu;

/** A fence opener: up to three spaces, then three or more backticks or tildes, then an info string. */
const FENCE_OPEN = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/u;
/** A fence closer candidate: up to three spaces, a run of one fence character, then only spaces or tabs. */
const FENCE_CLOSE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/u;

/**
 * Drop every fenced code block with CommonMark semantics: a block opened by a run of N backticks (or tildes) closes
 * only on a line holding a run of the SAME character of length >= N and nothing else, so a ``` block closed by ````
 * ends there instead of swallowing the rest of the reply; a backtick opener's info string cannot contain a backtick;
 * an unclosed block runs to the end of the reply.
 */
function stripFencedCode(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (fence !== null) {
      const run = FENCE_CLOSE.exec(line)?.[1];
      if (run !== undefined && run[0] === fence.char && run.length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    const run = open?.[1];
    if (run !== undefined && !(run[0] === '`' && (open?.[2] ?? '').includes('`'))) {
      fence = { char: run[0] ?? '`', length: run.length };
      kept.push('');
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** The prose sentences of a reply: code, quoted text and block quotes are mentions, never claims (QUAL-6). */
function claimSentences(text: string): string[] {
  const prose = stripFencedCode(text)
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/gu, ' ')
    // A single-quoted span ('보고서 쓰기') — never an English contraction ("I've", "it's"): no letter before the opening
    // quote and no Latin letter after the closing one.
    .replace(/(?<![\p{L}\p{N}])'[^'\n]{1,80}'(?![A-Za-z])/gu, ' ')
    .split(/\r?\n/u)
    .filter((line) => !/^\s{0,3}>/u.test(line))
    .join('\n');
  return prose
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

function isQuestion(sentence: string): boolean {
  return /[?？]\s*$/u.test(sentence);
}

const KO_DOMAIN_CLAIMS: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = INTERNAL_ACTION_DOMAINS.map(
  (domain) => [domain, koDomainClaim(domain)] as const,
);
const EN_DOMAIN_CLAIMS: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = INTERNAL_ACTION_DOMAINS.map(
  (domain) => [domain, enDomainClaim(domain)] as const,
);
const DOMAIN_NOUNS: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = INTERNAL_ACTION_DOMAINS.map(
  (domain) => [domain, new RegExp(INTERNAL_ACTION_VOCABULARY[domain].nouns, 'iu')] as const,
);
/** User-message vocabulary that names a domain without its noun ("보고서 초안 쓰기 완료" → to-do). */
const USER_DOMAIN_VERBS: ReadonlyArray<readonly [InternalActionDomain, RegExp]> = [
  ['todo', /완료|끝냈|다\s*했/u],
  ['reminder', /알려\s*줘|알려줘|remind/iu],
  ['memory', /기억해|remember/iu],
];

/** The first domain a text names by noun, then (when `withVerbs`) by a domain verb; `null` when none. */
function domainNamedIn(text: string, withVerbs: boolean): InternalActionDomain | null {
  const prose = text.replace(/`[^`\n]*`/gu, ' ');
  let best: { domain: InternalActionDomain; index: number } | null = null;
  for (const [domain, pattern] of DOMAIN_NOUNS) {
    const index = prose.search(pattern);
    if (index >= 0 && (best === null || index < best.index)) best = { domain, index };
  }
  if (best) return best.domain;
  if (!withVerbs) return null;
  for (const [domain, pattern] of USER_DOMAIN_VERBS) if (pattern.test(prose)) return domain;
  return null;
}

/**
 * The domain one sentence claims, or `null`. `translationClauseExempt` is false only when scanning the User's own
 * passage to translate, whose sentence carries the "번역해줘" instruction itself.
 */
function sentenceClaim(sentence: string, userMessage: string, translationClauseExempt = true): InternalActionDomain | null {
  if (isQuestion(sentence) || (translationClauseExempt && TRANSLATION_CLAUSE.test(sentence))) return null;
  for (const [domain, pattern] of KO_SPECIAL) if (koQuokyClaim(sentence, pattern)) return domain;
  for (const [domain, pattern] of KO_DOMAIN_CLAIMS) {
    if (!koQuokyClaim(sentence, pattern)) continue;
    // "메모리에 저장됐습니다" in a technical answer is not Quoky's memory (`MEMORY_OWNERSHIP`).
    if (domain === 'memory' && !MEMORY_OWNERSHIP.test(sentence) && !MEMORY_OWNERSHIP.test(userMessage)) continue;
    return domain;
  }
  for (const [domain, pattern] of EN_SPECIAL) if (pattern.test(sentence)) return domain;
  for (const [domain, pattern] of EN_DOMAIN_CLAIMS) if (pattern.test(sentence)) return domain;
  // A noun-less "저장했어요" / "saved to memory" answering a memory question (W1-L02): no chat turn writes memory.
  const userDomain = domainNamedIn(userMessage, true);
  if (userDomain === 'memory' && MEMORY_OWNERSHIP.test(userMessage) && koQuokyClaim(sentence, KO_NOUNLESS_STORE)) return 'memory';
  const koState = koQuokyClaim(sentence, KO_STATE_ASSERTION);
  if (koState !== null) return stateDomain(koState[0], sentence, userMessage, userDomain);
  // English exemptions are clause-scoped: a negation, condition, report or how-to in one clause never hides a state
  // asserted in another ("Your PR is merged, so you can delete the branch.").
  const instructional = EN_INSTRUCTION_FRAME.test(sentence);
  for (const clause of clausesOf(sentence)) {
    if (EN_NEGATION.test(clause) || EN_SUBORDINATE.test(clause) || EN_REPORTED.test(clause)) continue;
    if (EN_MEMORY_STORED.test(clause)) return 'memory';
    const enState =
      clause.match(EN_STATE_ASSERTION) ??
      (instructional || EN_GENERIC.test(clause) ? null : clause.match(EN_PRESENT_STATE));
    if (enState === null) continue;
    const domain = stateDomain(enState[0], clause, userMessage, userDomain);
    if (domain !== null) return domain;
  }
  return null;
}

/**
 * The domain of an asserted state: the asserted verb when it is a domain verb itself ("커밋된 상태", "has been
 * merged"), else the noun of `scope`, else the User message's domain. A memory state needs Quoky's own memory in
 * `scope` or the User message (`MEMORY_OWNERSHIP`): "the cache has been saved in memory" is not a memory claim.
 */
function stateDomain(
  asserted: string,
  scope: string,
  userMessage: string,
  userDomain: InternalActionDomain | null,
): InternalActionDomain | null {
  for (const [domain, pattern] of STATE_VERB_DOMAINS) if (pattern.test(asserted)) return domain;
  const domain = domainNamedIn(scope, false) ?? userDomain;
  if (domain === 'memory' && !MEMORY_OWNERSHIP.test(scope) && !MEMORY_OWNERSHIP.test(userMessage)) return null;
  return domain;
}

/** A User message that explicitly asks for a translation ("번역해줘", "translate this"), not a language preference. */
const TRANSLATION_REQUEST = /번역|translat/iu;

/**
 * The domains claimed by the passage of a User translation request ("변경 사항을 커밋했습니다 영어로 번역해줘",
 * "\"푸시했어요\"를 영어로 번역해줘"); empty when the message is not a translation request. Quotes are unwrapped (the
 * passage is often quoted) but code is still dropped. A reply's claim in one of these domains renders the User's text;
 * any other claim in the same reply is still Quoky's own.
 */
function translatedPassageDomains(userMessage: string): ReadonlySet<InternalActionDomain> {
  const domains = new Set<InternalActionDomain>();
  if (typeof userMessage !== 'string' || !TRANSLATION_REQUEST.test(userMessage)) return domains;
  const passage = userMessage
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/["“”‘’「」『』']/gu, '');
  for (const sentence of passage.split(/(?<=[.!?。！？])\s+|\n+/u)) {
    const domain = sentence.trim() === '' ? null : sentenceClaim(sentence.trim(), '', false);
    if (domain) domains.add(domain);
  }
  return domains;
}

/** What the guard found in one reply. */
export interface InternalActionClaim {
  readonly domain: InternalActionDomain;
}

/**
 * The first Quoky-domain action claim in a chat reply, or `null` (ADR-0104 D1/D2). `currentUserMessage` is the turn's
 * own User message; it only supplies the domain of a noun-less state assertion ("삭제된 상태가 맞습니다" after
 * "브랜치 삭제했어"). Deterministic, provider-neutral and side-effect free.
 */
export function detectInternalActionClaim(text: string, currentUserMessage = ''): InternalActionClaim | null {
  return firstClaim(text, currentUserMessage, new Set());
}

function firstClaim(
  text: string,
  currentUserMessage: string,
  exemptDomains: ReadonlySet<InternalActionDomain>,
): InternalActionClaim | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  for (const sentence of claimSentences(text)) {
    const domain = sentenceClaim(sentence, currentUserMessage);
    if (domain && !exemptDomains.has(domain)) return Object.freeze({ domain });
  }
  return null;
}

/** The guard's verdict for one reply. `text` is the reply to deliver (the original when nothing was claimed). */
export interface InternalActionGuardResult {
  readonly text: string;
  readonly guarded: boolean;
  readonly domain?: InternalActionDomain;
}

/**
 * Provider-neutral internal-action claim guard (ADR-0104 D1). Applies to every GENERAL_CHAT and POLICY_SENSITIVE_CHAT
 * reply. A reply that claims a Quoky-domain action is replaced as a whole by the fixed notice in the reply language
 * (the Core reply policy first, then the reply's own script, else Korean). The only turn-level exemption is a User
 * message that asks to translate a passage carrying the same claim (the reply renders the User's text). A language
 * preference ("한국어로 답해줘. 푸시했어?", "in English please, did you push?") is not exempt.
 */
export function guardInternalActionClaims(
  text: string,
  currentUserMessage: string,
  replyPolicy?: Pick<GeneralChatReplyPolicy, 'replyLanguage'>,
): InternalActionGuardResult {
  const claim = firstClaim(text, currentUserMessage, translatedPassageDomains(currentUserMessage));
  if (!claim) return Object.freeze({ text, guarded: false });
  const language = noticeLanguage(replyPolicy?.replyLanguage, text);
  return Object.freeze({
    text: renderInternalActionClaimNotice(claim.domain, language),
    guarded: true,
    domain: claim.domain,
  });
}
