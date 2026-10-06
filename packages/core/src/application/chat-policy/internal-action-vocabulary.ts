/**
 * Quoky-internal action vocabulary (ADR-0104 D1–D3, DET-1).
 *
 * Pure, provider-neutral Core data plus two small deterministic helpers. It imports only the reply-language detector
 * from this folder and performs no I/O.
 *
 * - `INTERNAL_ACTION_VOCABULARY` is the per-feature vocabulary inventory (ADR-0104 D3): for every Quoky-domain action
 *   family, which handler family owns its state, the anchor/feature states it answers in, the nouns and verbs a User
 *   (or a model reply) uses for it, and the exact command a User sends to really do it.
 * - `renderInternalActionNotDoneNotice` is the fixed KO/EN notice "nothing was done, plus the exact command" used both
 *   by the GENERAL_CHAT claim guard (`internal-action-claim-guard.ts`) and by the runtime's state-aware status replies.
 * - `detectInternalActionStatusTurn` recognises a whole message that is a status question or a completion statement
 *   about a code-chain action ("커밋됐어?", "브랜치 삭제했어", "did you push?"), so the runtime can answer it from the
 *   apply-preview anchor instead of letting a chat model affirm a state it cannot see (QA-V2-W8-02).
 *
 * The command lines quote phrases the runtime and the handlers actually accept (the help text, the handler-contributed
 * help lines and the documented execution phrases); `internal-action-vocabulary.test.ts` pins that. Changing this
 * lexicon needs a matching update of `golden/action-shaped-fallthrough.v1.json` (ADR-0104 D2).
 */
import { detectReplyLanguage } from './chat-response-policy';

/** Bumped whenever a domain, noun, verb or command line changes (ADR-0104 D2: "closed, versioned lexicon"). */
export const INTERNAL_ACTION_LEXICON_VERSION = 1;

/** The closed set of Quoky-domain action families (ADR-0104 D1). */
export const INTERNAL_ACTION_DOMAINS = Object.freeze([
  'commit',
  'push',
  'pr',
  'merge',
  'branch',
  'apply',
  'todo',
  'reminder',
  'memory',
  'connector-write',
] as const);
export type InternalActionDomain = (typeof INTERNAL_ACTION_DOMAINS)[number];

/** The code-chain domains whose state lives on the apply-preview anchor (answered by the runtime itself). */
export const CODE_CHAIN_STATUS_DOMAINS = Object.freeze(['commit', 'push', 'pr', 'merge', 'branch'] as const);
export type CodeChainStatusDomain = (typeof CODE_CHAIN_STATUS_DOMAINS)[number];

export function isInternalActionDomain(value: unknown): value is InternalActionDomain {
  return typeof value === 'string' && (INTERNAL_ACTION_DOMAINS as readonly string[]).includes(value);
}

/** One row of the vocabulary inventory (ADR-0104 D3). Regex sources are matched case-insensitively. */
export interface InternalActionVocabularyEntry {
  readonly domain: InternalActionDomain;
  /** The handler family that owns the action's state (and so its deterministic replies). */
  readonly owner: string;
  /** The anchor / feature states in which that owner answers the domain's vocabulary deterministically. */
  readonly states: readonly string[];
  /** Domain nouns (Korean and English), as one regex alternation source. */
  readonly nouns: string;
  /** Korean action verbs that pair with a noun ("PR을 생성", "할 일을 추가"); the noun may itself be the verb. */
  readonly koVerbs: string;
  /** English past participles that pair with a noun ("created", "added"). */
  readonly enVerbs: string;
  /** What Quoky did not do, as a Korean "…하지 않았고" stem ("커밋하지"). */
  readonly notDoneKo: string;
  /** What Quoky did not do, as an English infinitive ("commit"). */
  readonly notDoneEn: string;
  /** The exact command line for the domain (phrases the runtime/handlers accept). */
  readonly commandKo: string;
  readonly commandEn: string;
}

const POST_PUSH = [
  'PR_APPROVED',
  'PR_CREATED',
  'MERGE_APPROVED',
  'PR_MERGED',
  'MAIN_SYNCED',
  'BRANCH_CLEANED',
  'REMOTE_BRANCH_CLEANUP_APPROVED',
  'REMOTE_BRANCH_CLEANED',
] as const;

/**
 * The per-feature vocabulary inventory (ADR-0104 D3). Code-chain rows are answered by `ConversationRuntime` from the
 * apply-preview anchor in every state listed; the other rows are owned by their turn handler (to-do, reminders,
 * memory, branch commands) and by the read-only connector lookups. In every state, a GENERAL_CHAT reply that claims one
 * of these actions is replaced by the not-done notice (ADR-0104 D1).
 */
export const INTERNAL_ACTION_VOCABULARY: Readonly<Record<InternalActionDomain, InternalActionVocabularyEntry>> =
  Object.freeze({
    commit: {
      domain: 'commit',
      owner: 'ConversationRuntime code chain (ADR-0045/0046)',
      states: ['none', 'ELIGIBLE', 'APPROVED', 'PATCH_READY', 'WORKSPACE_APPLIED', 'COMMIT_APPROVED', 'GIT_COMMITTED', 'PUSH_APPROVED', 'GIT_PUSHED', ...POST_PUSH],
      nouns: String.raw`커밋|commit(?:s|ted)?`,
      koVerbs: String.raw`커밋`,
      enVerbs: String.raw`committed|made`,
      notDoneKo: '커밋하지',
      notDoneEn: 'commit anything',
      commandKo: '커밋하려면: 코드 변경을 적용한 뒤 "커밋해줘" → "승인" → "커밋 실행"',
      commandEn: 'To commit: after applying a change, send "커밋해줘" → "승인" → "커밋 실행".',
    },
    push: {
      domain: 'push',
      owner: 'ConversationRuntime code chain (ADR-0047/0048, QA-V2-W7-02)',
      states: ['none', 'ELIGIBLE', 'APPROVED', 'PATCH_READY', 'WORKSPACE_APPLIED', 'COMMIT_APPROVED', 'GIT_COMMITTED', 'PUSH_APPROVED', 'GIT_PUSHED', ...POST_PUSH],
      nouns: String.raw`푸시|푸쉬|push(?:ed|es)?`,
      koVerbs: String.raw`푸시|푸쉬|push`,
      enVerbs: String.raw`pushed`,
      notDoneKo: '푸시하지',
      notDoneEn: 'push anything',
      commandKo: '푸시하려면: 커밋한 뒤 "푸시해줘" → "승인" → "푸시 실행"',
      commandEn: 'To push: after a commit, send "푸시해줘" → "승인" → "푸시 실행".',
    },
    pr: {
      domain: 'pr',
      owner: 'ConversationRuntime code chain (ADR-0049/0054)',
      states: ['none', 'GIT_COMMITTED', 'PUSH_APPROVED', 'GIT_PUSHED', ...POST_PUSH],
      nouns: String.raw`\bPR\b|피알|풀\s*리퀘(?:스트)?|pull\s+requests?|merge\s+requests?`,
      koVerbs: String.raw`생성|등록|오픈|만들|올리|올렸|열`,
      enVerbs: String.raw`created|opened|raised|submitted|filed`,
      notDoneKo: 'PR을 만들지',
      notDoneEn: 'create a pull request',
      commandKo: 'PR을 만들려면: 푸시한 뒤 "PR 만들어줘" → "승인" → "PR 생성 실행"',
      commandEn: 'To open a pull request: after a push, send "PR 만들어줘" → "승인" → "PR 생성 실행".',
    },
    merge: {
      domain: 'merge',
      owner: 'ConversationRuntime code chain (ADR-0056/0057, ADR-0099 D5)',
      states: ['none', 'GIT_PUSHED', ...POST_PUSH],
      nouns: String.raw`머지|병합|merge[ds]?`,
      koVerbs: String.raw`머지|병합|merge`,
      enVerbs: String.raw`merged`,
      notDoneKo: '머지하지',
      notDoneEn: 'merge anything',
      commandKo: '머지하려면: PR을 만든 뒤 "머지해줘" → "승인" → "머지 실행" (머지 기능이 켜져 있을 때만 가능해요)',
      commandEn: 'To merge: after the pull request exists, send "머지해줘" → "승인" → "머지 실행" (only when merging is enabled).',
    },
    branch: {
      domain: 'branch',
      owner: 'git-branch handler (ADR-0099 D4) + ConversationRuntime branch cleanup (ADR-0060)',
      states: ['none', 'MAIN_SYNCED', 'BRANCH_CLEANED', 'REMOTE_BRANCH_CLEANUP_APPROVED', 'REMOTE_BRANCH_CLEANED'],
      nouns: String.raw`브랜치|branch(?:es)?`,
      koVerbs: String.raw`삭제|생성|전환|정리|제거|만들|지웠|지우|바꾸|바꿨`,
      enVerbs: String.raw`deleted|removed|created|switched|cleaned\s+up|checked\s+out`,
      notDoneKo: '브랜치를 만들거나 바꾸거나 삭제하지',
      notDoneEn: 'create, switch or delete a branch',
      commandKo:
        '브랜치: "브랜치 만들어줘 feature/x" 또는 "feature/x 브랜치로 전환해줘" (로컬만), 머지한 뒤에는 "브랜치 정리해줘"',
      commandEn:
        'Branches: send "브랜치 만들어줘 feature/x" or "feature/x 브랜치로 전환해줘" (local only); after a merge, "브랜치 정리해줘".',
    },
    apply: {
      domain: 'apply',
      owner: 'ConversationRuntime apply chain (ADR-0040..0042)',
      states: ['none', 'ELIGIBLE', 'APPROVED', 'PATCH_READY', 'WORKSPACE_APPLIED'],
      nouns: String.raw`파일|변경\s*사항|변경사항|패치|워크스페이스|저장소|레포|리포|files?|workspace|repo(?:sitory)?`,
      koVerbs: String.raw`적용|수정|반영|변경|생성|삭제|저장`,
      enVerbs: String.raw`applied|updated|modified|changed|edited|saved|created|deleted|written`,
      notDoneKo: '파일을 바꾸지',
      notDoneEn: 'change any file',
      commandKo:
        '파일을 바꾸려면: 파일 경로와 함께 요청 → "승인" → 미리보기 확인 → "적용해줘" → "승인" → "패치 만들어줘" → "패치 적용해줘"',
      commandEn:
        'To change files: ask with the file path → "승인" → check the preview → "적용해줘" → "승인" → "패치 만들어줘" → "패치 적용해줘".',
    },
    todo: {
      domain: 'todo',
      owner: 'work-chat.todo handler (ADR-0100 D1, QA-V2-W7-03/05)',
      states: ['no to-dos', 'open to-dos', 'completed to-do', 'cancelled to-do'],
      nouns: String.raw`할\s*일|투두|to-?dos?|tasks?`,
      koVerbs: String.raw`추가|등록|완료|취소|삭제|연결|체크`,
      enVerbs: String.raw`added|completed|marked|cancell?ed|removed|checked\s+off|linked`,
      notDoneKo: '할 일을 추가하거나 바꾸지',
      notDoneEn: 'add or change any to-do',
      commandKo: '할 일: "할 일 추가: 내용", "완료 처리: 번호", "할 일 취소: 번호" (목록은 "내 할 일 보여줘")',
      commandEn: 'To-dos: send "할 일 추가: 내용", "완료 처리: 번호" or "할 일 취소: 번호" (list: "내 할 일 보여줘").',
    },
    reminder: {
      domain: 'reminder',
      owner: 'reminders handler (ADR-0101)',
      states: ['reminders on', 'reminders off'],
      nouns: String.raw`알림|리마인더|알람|reminders?|alarms?`,
      koVerbs: String.raw`설정|등록|추가|예약|취소|삭제|해제|맞춰|맞췄|걸어|걸었|만들|만들었`,
      enVerbs: String.raw`set|scheduled|created|added|cancell?ed|removed|deleted`,
      notDoneKo: '알림을 만들거나 취소하지',
      notDoneEn: 'set or cancel a reminder',
      commandKo: '알림: "30분 뒤에 스트레칭 알려줘"처럼 요청하고, "알림 목록", "알림 N 취소"로 확인·취소해요.',
      commandEn: 'Reminders: send e.g. "30분 뒤에 스트레칭 알려줘"; "알림 목록" lists them and "알림 N 취소" cancels one.',
    },
    memory: {
      domain: 'memory',
      owner: 'ConversationRuntime "기억해:" block (ADR-0073)',
      states: ['any'],
      nouns: String.raw`기억|메모리|memory|memories`,
      koVerbs: String.raw`저장|삭제|등록|기록`,
      enVerbs: String.raw`saved|stored|deleted|removed|recorded`,
      notDoneKo: '기억을 저장하거나 지우지',
      notDoneEn: 'save or forget anything',
      commandKo: '기억하려면: "기억해: <내용>"이라고 보내 주세요.',
      commandEn: 'To have Quoky remember something, send "기억해: <내용>".',
    },
    'connector-write': {
      domain: 'connector-write',
      owner: 'work-chat.lookup handler (read-only connectors, ADR-0100)',
      states: ['read-only'],
      nouns: String.raw`jira|지라|slack|슬랙|confluence|컨플루언스|github\s+issues?|깃허브\s*이슈|티켓|tickets?`,
      koVerbs: String.raw`생성|등록|작성|게시|전송|업데이트|수정|추가|남겼|남기|달았|올렸|보냈|만들었`,
      enVerbs: String.raw`created|filed|posted|commented|sent|updated|opened`,
      notDoneKo: 'Jira·Slack·Confluence·GitHub에 쓰지',
      notDoneEn: 'write to Jira, Slack, Confluence or GitHub',
      commandKo: '업무 도구는 지금 읽기만 해요: "내 Jira 이슈 보여줘", "GitHub 리뷰 요청 보여줘", "Slack에서 배포 검색"',
      commandEn: 'Work tools are read-only for now: "내 Jira 이슈 보여줘", "GitHub 리뷰 요청 보여줘", "Slack에서 배포 검색".',
    },
  });

export type NoticeLanguage = 'ko' | 'en';

/** The reply language for a notice: the given language first, then the script of `fallbackText`, else Korean. */
export function noticeLanguage(preferred: 'ko' | 'en' | 'unknown' | undefined, fallbackText = ''): NoticeLanguage {
  if (preferred === 'ko' || preferred === 'en') return preferred;
  return detectReplyLanguage(fallbackText) === 'en' ? 'en' : 'ko';
}

/**
 * The fixed notice that replaces a GENERAL_CHAT reply claiming a Quoky-domain action (ADR-0104 D1): nothing was done,
 * Quoky did not check the state, plus the exact command for the domain.
 */
export function renderInternalActionClaimNotice(domain: InternalActionDomain, language: NoticeLanguage): string {
  const entry = INTERNAL_ACTION_VOCABULARY[domain];
  if (language === 'en') {
    return `Nothing was done by this reply: Quoky did not ${entry.notDoneEn} and did not check its current state.\n${entry.commandEn}`;
  }
  return `이 답변으로 실행된 작업은 없어요. Quoky는 ${entry.notDoneKo} 않았고, 지금 상태를 확인하지도 않았어요.\n${entry.commandKo}`;
}

/**
 * The state-aware reply for a code-chain status question or completion statement when the anchor shows Quoky did not
 * perform that action in the current code work (ADR-0104 D3, QA-V2-W8-02). It never affirms the User's statement, and
 * it never contradicts a User's report of a git action they ran themselves ("커밋했어", "PR 머지 완료"): it says Quoky
 * cannot see such actions and did not check the repository, so the same wording fits a question and a statement.
 */
export function renderInternalActionNotDone(domain: CodeChainStatusDomain, language: NoticeLanguage): string {
  const entry = INTERNAL_ACTION_VOCABULARY[domain];
  if (language === 'en') {
    return `In the current code work Quoky did not ${entry.notDoneEn}. Quoky cannot see git actions you run yourself, and it did not check the repository.\n${entry.commandEn}`;
  }
  return `지금 진행 중인 코드 작업에서 Quoky는 ${entry.notDoneKo} 않았어요. 직접 실행하신 git 작업은 Quoky가 볼 수 없고, 저장소 상태를 확인하지도 않았어요.\n${entry.commandKo}`;
}

// ── status-turn shape (code-chain domains only) ───────────────────────────────────────────────────────────────

/** Optional leading filler words ("혹시", "그래서", "이미", "그 PR" …). */
const KO_LEAD = String.raw`(?:(?:혹시|그래서|그럼|그러면|이제|아까|방금|벌써|이미|아직|진짜|정말|혹시나|그거|그|이|내|제|우리)\s*)*`;
const KO_PARTICLE = String.raw`(?:\s*(?:은|는|이|가|을|를|도))?\s*`;
/** A completed / state form: "했", "됐", "되어 있", "된 거", "완료(했)", "끝났" … ("다 됐어?"). */
const KO_DONE = String.raw`(?:다\s*)?(?:했|하였|됐|되었|돼\s*있|되어\s*있|된\s*(?:거|건|상태)|한\s*(?:거|건)|해\s*(?:놨|뒀|두었|놓았)|완료\s*(?:했|됐|되었|된\s*(?:거|건))?|완료|끝났|끝난\s*(?:거|건))`;
/** What may follow the completed form in a whole status message ("어", "나요", "습니까", "는지", "지?"). */
const KO_TAIL = String.raw`(?:어|어요|나|나요|니|냐|지|죠|지요|습니다|습니까|음|다|야|요|가요|가|는지|는지\s*(?:알려|확인해)\s*줘)?`;
const END = String.raw`[\s?？!.~]*$`;

function koStatus(subject: string, verbs?: string): RegExp {
  const action = verbs === undefined ? KO_DONE : String.raw`(?:(?:${verbs})\s*${KO_DONE}|${KO_DONE})`;
  return new RegExp(String.raw`^${KO_LEAD}(?:${subject})${KO_PARTICLE}${action}${KO_TAIL}${END}`, 'iu');
}

const KO_STATUS: ReadonlyArray<readonly [CodeChainStatusDomain, RegExp]> = [
  ['commit', koStatus(String.raw`커밋|commit`)],
  ['push', koStatus(String.raw`푸시|푸쉬|push`)],
  // "PR 만들었어?", "PR 생성됐어?", "PR 올라갔어?" — a bare "PR 했어" is ambiguous and not matched.
  [
    'pr',
    new RegExp(
      String.raw`^${KO_LEAD}(?:PR|피알|풀\s*리퀘(?:스트)?|pull\s*request)${KO_PARTICLE}(?:(?:생성|등록|오픈)\s*${KO_DONE}|만들었|만들어\s*졌|만들어졌|만들어\s*졌|만든\s*(?:거|건)|올렸|올라갔|올라간\s*(?:거|건)|열었|열렸|열린\s*(?:거|건))${KO_TAIL}${END}`,
      'iu',
    ),
  ],
  ['merge', koStatus(String.raw`(?:(?:PR|피알)\s*(?:은|는|이|가|을|를|도)?\s*)?(?:머지|병합|merge)`)],
  // "브랜치 삭제했어", "브랜치 정리 완료", "브랜치 지웠어" — branch creation/switch belongs to the git-branch handler.
  [
    'branch',
    new RegExp(
      String.raw`^${KO_LEAD}(?:(?:로컬|원격|feature)\s*)?브랜치${KO_PARTICLE}(?:(?:삭제|정리|제거)\s*${KO_DONE}|지웠|지워졌|지워\s*졌|지운\s*(?:거|건)|없앴|없어졌)${KO_TAIL}${END}`,
      'iu',
    ),
  ],
];

const EN_OBJECT = String.raw`(?:\s+(?:it|this|that|them|the\s+(?:pr|pull\s+request|branch|commit|changes?)|my\s+(?:pr|branch|commit|changes?)|already|yet|for\s+me))*`;
const EN_SUBJECT = String.raw`^(?:so\s+)?(?:did\s+you|have\s+you|has\s+(?:it|this|that|the\s+(?:pr|pull\s+request|branch|commit|change))\s+been|was\s+(?:it|this|that|the\s+(?:pr|pull\s+request|branch|commit))|is\s+(?:it|this|that|the\s+(?:pr|pull\s+request|branch|commit))|are\s+(?:they|the\s+changes))\s+(?:already\s+)?`;

function enStatus(verb: string): RegExp {
  return new RegExp(String.raw`${EN_SUBJECT}(?:${verb})${EN_OBJECT}${END}`, 'iu');
}

const EN_STATUS: ReadonlyArray<readonly [CodeChainStatusDomain, RegExp, RegExp?]> = [
  ['commit', enStatus(String.raw`commit(?:ted)?`)],
  ['push', enStatus(String.raw`push(?:ed)?`)],
  ['merge', enStatus(String.raw`merge[d]?`)],
  ['pr', enStatus(String.raw`creat(?:e|ed)|open(?:ed)?|raised?`), /\b(?:pr|pull\s+request)\b/iu],
  ['branch', enStatus(String.raw`delet(?:e|ed)|remov(?:e|ed)|clean(?:ed)?\s+up`), /\bbranch\b/iu],
];

/**
 * The code-chain domain a whole message asks about or reports as done ("커밋됐어?", "푸시했어", "PR 만들었어?",
 * "머지됐나요?", "브랜치 삭제했어", "did you push?", "is the branch deleted?"), or `null`. Strict whole-message shape:
 * anything else in the message (a request, a how-to, a conceptual question such as "git push가 뭐야?", a conditional
 * such as "커밋했으면 푸시해줘") is not a status turn and keeps its existing routing.
 */
export function detectInternalActionStatusTurn(text: string): CodeChainStatusDomain | null {
  if (typeof text !== 'string') return null;
  const message = text.normalize('NFC').trim();
  if (message.length === 0 || message.length > 60 || /\n/u.test(message)) return null;
  for (const [domain, pattern] of KO_STATUS) if (pattern.test(message)) return domain;
  for (const [domain, pattern, requires] of EN_STATUS) {
    if (pattern.test(message) && (requires === undefined || requires.test(message))) return domain;
  }
  return null;
}
