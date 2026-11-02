import { KO_END, KO_START, koNoun } from '../git-request-shape';
import type { ApplyPreviewAnchor } from './types';

// Approve/deny/cancel decision phrases for pending approvals live in ./approval-decision (whole-token,
// negation-aware); "APPROVE_WORDS" in the comments below refers to that approve phrase set.

export const CANCEL_WORDS = ['취소', '중단', '그만'];

/** Explicit apply-only phrases (Sprint 2s, ADR-0040) — "좋아"/"오케이"/"확인"/"괜찮네" must NEVER match;
 *  those stay in APPROVE_WORDS for the ordinary approval flow but are insufficient to authorize file
 *  modification. "이대로 진행" (multi-word) is deliberately distinct from APPROVE_WORDS' bare "진행" —
 *  the two word-sets are non-overlapping by construction, not by coincidence. */
export const APPLY_WORDS = ['적용', '반영', '이대로 진행'];

/** Explicit patch phrases (Sprint 2t, ADR-0041) — distinct from APPROVE_WORDS and APPLY_WORDS. CA Round 1
 *  Required Change #2: the ambiguous standalone "계속 진행" is deliberately excluded — a bare "continue"
 *  intent must never be auto-read as PatchSet generation. Every entry is an explicit patch-generation
 *  phrase; "다음 단계 진행" is the full multi-word form (never bare "다음 단계"); "좋아"/"오케이"/"확인"
 *  never match. Combined with routing (generation only on an APPROVED anchor), this enforces:
 *  explicit patch phrase + APPROVED anchor ⇒ generation; a bare "계속 진행" ⇒ never generation. */
export const PATCH_WORDS = [
  '패치 만들어',
  '패치 생성',
  '패치로 만들어',
  'patch 만들어',
  'generate patch',
  'patchset 만들어',
  '다음 단계 진행',
];

/** Explicit final workspace-apply phrases (Sprint 2u, ADR-0042) — the first real file mutation. Distinct
 *  from APPROVE_WORDS/APPLY_WORDS/PATCH_WORDS: every entry is a QUALIFIED apply phrase, so a bare "적용"/
 *  "반영"/"좋아"/"오케이"/"확인"/"다음 단계 진행" never triggers a file write (CA Q3). No overlap with
 *  PATCH_WORDS; checked before APPLY_WORDS so "패치 적용해줘" (which also contains the apply-word "적용")
 *  routes to file-apply, not Sprint 2s apply-intent. */
export const FINAL_APPLY_WORDS = [
  '최종 적용',
  '파일에 적용',
  '패치 적용',
  'workspace에 적용',
  'apply patch',
  'apply to workspace',
];

/** Mutating git phrases (Sprint 2w, ADR-0044, CA Required Change #5/#6) — must NEVER route to a read-only
 *  preview; checked FIRST (precedence over diff/status). Korean "커밋" counts as a command only with an
 *  action verb, so "커밋 전에 변경사항 요약해줘" is a STATUS phrase; English `commit` stays conservative (any
 *  `commit` token → mutating). */
export const GIT_MUTATING_WORDS =
  /(커밋\s*(해|하자|할|하기|하고|하는)|\bcommit\b|푸시|\bpush\b|git\s*add|\badd\s*해|리셋|\breset\b|checkout|체크아웃|stash|스태시|\bbranch\b|브랜치\s*(만들|생성)|merge|머지|rebase|리베이스|\btag\b|태그)/i;
/** Read-only diff-preview phrases (Sprint 2w). */
export const GIT_DIFF_WORDS = /(\bdiff\b|디프)/i;
/** Read-only status/changed-files phrases (Sprint 2w) — incl. the CA-approved safe Korean "커밋 전에 …". */
export const GIT_STATUS_WORDS = /(git\s*상태|깃\s*상태|git\s*status|\bstatus\b\s*보여|변경\s*파일|변경\s*사항|변경사항|바뀐\s*파일|커밋\s*전)/i;

/** Explicit git-commit request phrases (Sprint 2x, ADR-0045) — qualified; a bare "좋아"/"오케이"/"확인"/
 *  "다음 단계"/"진행해"/"이대로 해" never matches, and bare "커밋 전" (2w status) is excluded (no action verb). */
export const COMMIT_WORDS =
  /(커밋\s*(해|하자|할래|준비|승인)|커밋\s*메시지|git\s*commit|commit\s+this|prepare\s+commit|create\s+commit\s+approval)/i;
/** Non-commit git mutations that must NOT ride along with a commit request (Sprint 2x) — a commit bundled
 *  with any of these is rejected (commit-approval planning only). */
export const COMMIT_FORBIDDEN_COMPANION =
  /(푸시|\bpush\b|git\s*add|\badd\s*해|리셋|\breset\b|checkout|체크아웃|stash|스태시|\bbranch\b|브랜치|merge|머지|rebase|리베이스|\btag\b|태그)/i;

/** Explicit commit-EXECUTION phrases (Sprint 2y, ADR-0046) — distinct from the 2x commit-approval words. */
export const COMMIT_EXECUTION_WORDS =
  /(승인된?\s*커밋\s*실행|커밋\s*실행|이제\s*실제\s*커밋|commit\s+approved\s+changes|execute\s+commit|run\s+approved\s+commit)/i;
/** Non-commit git mutations that must be rejected on the execution path (Sprint 2y) — never a push/commit. */
export const COMMIT_EXECUTION_FORBIDDEN =
  /(푸시|\bpush\b|리셋|\breset\b|checkout|체크아웃|stash|스태시|\bbranch\b|브랜치|merge|머지|rebase|리베이스|\btag\b|태그|git\s*add)/i;

/** Explicit git-PUSH phrases (Sprint 2z, ADR-0047) — a bare 좋아/오케이/확인/진행해/다음 단계 never matches.
 *  `푸시`/`push` as a bare token counts (only ever consulted in push-relevant states), so companions like
 *  "푸시하고 배포" are caught by PUSH_FORBIDDEN_COMPANION rather than slipping through as non-push. */
export const PUSH_WORDS =
  /(푸시|git\s*push|\bpush\b|원격에\s*올려|리모트에\s*올려|원격으로\s*보내|push\s+this\s+commit|push\s+(the\s+)?approved\s+commit)/i;
/** Force + bundling + other git ops that must NOT ride along with a push (Sprint 2z, CA #2/#5) — only ever
 *  consulted when a PUSH word is already present, so a bare "배포"/"branch"/"tag"/"reset" is NOT push handling. */
export const PUSH_FORBIDDEN_COMPANION =
  /(--?force|\bforce\b|강제|(^|\s)-f(\s|$)|(^|\s)\+[\w./-]|--delete\b|(^|\s)-d(\s|$)|(^|\s):[\w./-]|--mirror\b|--all\b|--tags\b|--prune\b|\bpr\b|pull\s*request|풀\s*리퀘|배포|deploy|머지|\bmerge\b|리베이스|rebase|\btag\b|태그|\bbranch\b|브랜치|리셋|\breset\b|checkout|체크아웃|stash|스태시)/i;

/** A push word as the request's own object ("푸시", "git push", "push"). */
export const PUSH_TOKEN_SRC = '(?:푸시|git\\s*push|\\bpush\\b)';
/** A Korean request tail attached DIRECTLY to the push word ("푸시해줘", "push 실행해줘", "git push 해 줘"). */
export const KO_PUSH_REQUEST_TAIL_SRC =
  '(?:\\s*(?:을|를))?(?:\\s*좀)?\\s*(?:해\\s*줘요?|해\\s*주세요|해\\s*주라|해\\s*줄래요?|해라|해\\s*봐|하자|해|' +
  '실행(?:\\s*해\\s*줘요?|\\s*해\\s*주세요|\\s*해|\\s*하자)?|진행(?:\\s*해\\s*줘요?|\\s*해)?)';
export const KO_IMPERATIVE_END_SRC = '(?:해\\s*줘요?|해\\s*주세요|해\\s*주라|해라|하자|해)';
/**
 * Push-request shapes (QA-V2-W8; Codex wave-8 review): the request verb must attach to the push word ITSELF —
 * never a trailing "해줘" elsewhere in the sentence ("git push 명령을 한국어로 번역해줘" / "푸시 로직을 검토해줘" are
 * chat) — or the text is a typed push command, with or without options/remote/refspec ("git push --force origin x").
 */
export const PUSH_REQUEST_SHAPES: readonly RegExp[] = [
  // Korean: "푸시해줘", "푸시 해 줘", "git push 해줘", "push 실행", "push 실행해줘", "강제 푸시해줘", "이 커밋 푸시해줘"
  new RegExp(`${PUSH_TOKEN_SRC}${KO_PUSH_REQUEST_TAIL_SRC}\\s*[.!~]*$`, 'i'),
  // Korean bundle: "푸시하고 머지해줘", "푸시한 다음 배포해줘" — a push chained to another imperative (→ companion)
  new RegExp(`${PUSH_TOKEN_SRC}\\s*(?:하고|한\\s*(?:다음|뒤|후)에?|해서)\\s+.+${KO_IMPERATIVE_END_SRC}\\s*[.!~]*$`, 'i'),
  // Korean: "원격에 올려줘", "리모트로 보내줘"
  /(원격|리모트)(에|으로|로)\s*(올려|보내)\s*(줘요?|주세요|줄래요?|라)?\s*[.!~]*$/i,
  // English imperative: "push", "push now", "push this commit", "force push", "push -f", "push to origin"
  /^\s*(please\s+)?(force[\s-]+)?push(\s+(-{1,2}[\w-]+|origin\S*|upstream|now|please|it|this(\s+commit)?|the\s+(approved\s+)?commit|approved\s+commit|to\s+(origin|remote|github)\S*))*\s*[.!]*$/i,
  /^\s*(please\s+)?(execute|run)\s+(the\s+)?(approved\s+)?push(\s+now)?\s*[.!]*$/i,
  // A typed git push command with any options / remote / refspec: "git push", "git push -f origin main"
  /^\s*git\s+push(\s+[\w./:@+=~^-]+)*\s*[.!]*$/i,
];
/**
 * A how-to / explanation question (live QA W1-L01, W1-L03): "git commit 은 어떻게 하는 거야?", "커밋해 주는 방법",
 * "완료 처리 어떻게 해?", "what is git commit?". It asks how something works and never requests the action, so it is
 * never a commit request, a git-mutation reject or the reply to a pending scope clarification; it reaches the
 * `pre-classify` help-intent handler or ordinary chat. No execution gate consults it (those stay exact allow-lists).
 * "차이" matches as a whole word with an optional particle ("차이", "차이를", "차이점이"), never inside another word:
 * "차이나 서버 변경 커밋해줘" is a commit request, not a how-to question (the git-request-shape boundary rule).
 */
export const HOW_TO_QUESTION = new RegExp(
  `어떻게|방법|하는\\s*법|사용법|뭐야|뭔가요|뭐예요|뭐에요|무엇|무슨|뜻이|${koNoun('차이')}|설명해|` +
    '\\bhow\\s+(?:do|does|can|should|would|to)\\b|\\bwhat\\s+(?:is|does|are)\\b|\\bexplain\\b',
  'iu',
);

/**
 * Questions / how-to / notification topics that merely mention push are ordinary chat (QA-V2-W8). Korean topic words
 * match whole words only, with the git-request-shape boundary + particle rule (routing exec gaps): "차이", "차이를",
 * "방법이", "푸시 알림", "설명해줘", "알려줘", "뭐야", "왜" are topics; "차이나", "설명서", "알려진", "왜곡", "뭐든" are not,
 * so "차이나 서버 변경을 푸시해줘" stays a push request. Only consulted on the non-executing push replies (already pushed /
 * no push target / unsupported companion) — never by an execution gate.
 */
export const PUSH_CHAT_TOPIC = new RegExp(
  [
    '[?？]',
    // Interrogatives start their word: "뭐야", "무엇을", "뭔데", "어떻게", "어떤", "왜(요)" — not "뭐든", "왜곡".
    `${KO_START}(?:뭐(?!든|라도)|무엇|뭔|어떻게|어떤|왜(?:요|죠)?${KO_END})`,
    // Topic nouns as whole words with an optional particle: "차이를", "해결방법", "알림", "설정은", "구현", "설명이".
    koNoun('차이|(?:해결|사용|설정)?방법|알림|설정|구현|설명'),
    // The same words as a request verb: "설명해줘", "설정하는", "구현해", "알려줘", "알려 주세요".
    `${KO_START}(?:(?:설명|설정|구현)\\s*(?:해|하|할|좀|부탁)|알려\\s*(?:줘|주|줄|달))`,
    '\\bnotifications?\\b|\\bhow\\b|\\bwhat\\b|\\bwhy\\b|\\bexplain\\b|\\bdifference\\b|\\bwhen\\b',
  ].join('|'),
  'iu',
);

/** Chain states after a successful push (QA-V2-W7-02) — a push phrase here means "already pushed", never a new push. */
export const POST_PUSH_CHAIN_STATUSES: ReadonlySet<ApplyPreviewAnchor['status']> = new Set([
  'PR_APPROVED',
  'PR_CREATED',
  'MERGE_APPROVED',
  'PR_MERGED',
  'MAIN_SYNCED',
  'BRANCH_CLEANED',
  'REMOTE_BRANCH_CLEANUP_APPROVED',
  'REMOTE_BRANCH_CLEANED',
]);

/** Chain states after a successful merge (ADR-0104 D3 status replies: "머지됐어?" → already merged). */
export const MERGED_CHAIN_STATUSES: ReadonlySet<ApplyPreviewAnchor['status']> = new Set([
  'PR_MERGED',
  'MAIN_SYNCED',
  'BRANCH_CLEANED',
  'REMOTE_BRANCH_CLEANUP_APPROVED',
  'REMOTE_BRANCH_CLEANED',
]);

/** Branches Personal v1 never commits on (ADR-0094; QA-022 up-front refusal at commit-approval planning). */
export const PROTECTED_COMMIT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/** Bound on user-controllable git ref (remote/branch/upstream) display length (Sprint 2z, CA #6). */
export const MAX_GIT_REF_DISPLAY = 80;

/** Explicit git-push-EXECUTION phrases (Sprint 3a, ADR-0048) — distinct from the 2z push-approval words;
 *  a bare 좋아/오케이/확인/진행해/다음 단계 never matches. Only consulted at PUSH_APPROVED / GIT_PUSHED. */
export const PUSH_EXECUTION_WORDS =
  /(승인된?\s*(푸시|push)\s*실행|(푸시|push)\s*실행|이제\s*실제\s*(푸시|push)|execute\s+(the\s+)?approved\s+push|run\s+approved\s+push|push\s+approved\s+commit)/i;
/** Deploy-only phrases (Sprint 3b, ADR-0049 — replaces the 3a `PR_DEPLOY_WORDS`) — a bare deploy request
 *  (no PR word) at GIT_PUSHED/PR_APPROVED gets a state-appropriate "deploy not supported" reply. PR phrases
 *  are handled by `interpretPrIntent`, NOT here. */
export const DEPLOY_ONLY_WORDS = /(배포|deploy|릴리즈|release)/i;

/** Companion follow-ups that are unsupported once a PR is already created (Sprint 3d-D) — merge/deploy/release/
 *  reviewer/label/assignee. Consulted ONLY at PR_CREATED to answer "that's a future step" (no mutation). */
export const PR_CREATED_COMPANION_WORDS =
  /(배포|deploy|릴리즈|release|머지|\bmerge\b|병합|auto\s*-?\s*merge|자동\s*머지|리뷰어|reviewer|라벨|\blabel\b|assignee|담당자)/i;

/** Explicit PR/CI/check/review STATUS-query phrases (Sprint 3e, ADR-0055) — only consulted at PR_CREATED. A
 *  status-context noun (PR/풀리퀘/pull request/CI/체크/check(s)/리뷰/review) AND a query verb (상태/status/확인/
 *  어때/봐/알려/통과/열려) must BOTH be present, in either order. A bare "상태" with no PR/CI/check/review context
 *  never matches (CA Q1); merge/deploy/release/reviewer/label/assignee are NOT status phrases (they route to the
 *  companion-unsupported reply). */
export const PR_STATUS_NOUN = /(\bpr\b|풀\s*리퀘|pull\s*request|\bci\b|체크|checks?|리뷰|review)/i;
export const PR_STATUS_QUERY = /(상태|status|확인|어때|봐줘|봐|알려|통과(했|돼|되)|열려\s*있|open\s*\?)/i;

/** Explicit merge-APPROVAL / merge phrases (Sprint 3f, ADR-0056) — only consulted at PR_CREATED, AFTER the
 *  status intent. A merge word is required; a merge QUESTION (가능/안전/되나/통과/?/mergeable) is NOT an approval
 *  request; only a merge word + a request/approval/execution verb triggers. "머지해줘" (execution wording) is
 *  treated as a merge-approval REQUEST (Sprint 3f records permission only). */
export const MERGE_WORD = /(머지|병합|\bmerge\b)/i;
// A merge SAFETY/POSSIBILITY/STATUS/INSPECTION question (not an approval request) — a possibility/safety word,
// a status/check/inspection word, or a trailing "?". Consulted only when a MERGE_WORD is present, so it never
// affects non-merge phrases. "머지 상태 확인해줘"/"머지 확인해줘"/"머지 체크해줘" are inquiries, NOT approval requests
// (Sprint 3f impl review — the "해줘" request verb must not turn an inquiry into an approval).
export const MERGE_QUESTION =
  /(가능|안전|괜찮|되나|되나요|통과|상태|확인|봐줘|봐|알려|체크|\bcheck\b|\bstatus\b|\bmergeable\b|can\s+i|is\s+it|\?)/i;
// An explicit merge approval/execution REQUEST ("머지 승인해줘"/"머지해줘"/"머지해도 되게 승인"/"merge this"/"approve merge").
// (live QA 2026-10-07) the request verb must attach to the merge word itself ("머지해줘", "PR 머지해줘", "main에 머지해줘",
// "머지 승인해줘", "병합해줘", "merge the PR", "approve merge") — a trailing "설명해줘" elsewhere in the sentence ("git rebase와
// merge 차이를 간단히 설명해줘") is never a merge request.
export const MERGE_REQUEST_ATTACHED =
  /((머지|병합)\s*(을|를)?\s*(좀\s*)?(해(?!결)|하자|시켜|진행|실행|승인|요청)|\bmerge\s+(this|it|the|now|pr|approval)\b|\bapprove\s+(the\s+)?(pr\s+)?merge\b|\b(request|create)\s+(a\s+)?merge\s+approval\b)/i;
// A merge-EXECUTION verb (Sprint 3g, ADR-0057, CA change 1) — only consulted at MERGE_APPROVED/PR_MERGED, AFTER
// the MERGE_QUESTION status guard. At MERGE_APPROVED the user already passed the CRITICAL merge-approval gate, so
// a direct merge imperative (해줘/실행/실제/지금/승인된/now/execute/merge this/approved) IS an execution command. A
// bare "머지"/"merge" noun (no verb) is NOT execution (→ composeMergeAlreadyApproved).
export const MERGE_EXECUTION_VERB = /(해줘|해\s*줘|실제|실행|지금|승인된|\bnow\b|\bexecute\b|merge\s+this|\bapproved\b)/i;
// (Codex wave-8 review) the execution verb must attach to the merge word itself ("머지해줘", "머지 실행해줘", "merge
// this PR", "merge now", "execute merge") — a trailing "해줘" on another verb ("머지 로그 요약해줘") is never a merge.
export const MERGE_EXECUTION_ATTACHED =
  /((머지|병합)\s*(을|를)?\s*(좀\s*)?(해|실행|진행|하자|시켜)|\bmerge\s+(this|it|the|now|pr|approved)\b|\b(execute|run|do)\s+(the\s+)?(approved\s+)?merge\b|\bapproved\s+merge\b)/i;
// Chain verbs foreign to the merge step (Codex wave-8 review): a merge bundled with push/deploy/sync/branch-delete/
// force/reset/rebase is never a merge-EXECUTION command.
export const MERGE_EXECUTION_FOREIGN =
  /(푸시|\bpush|배포|deploy|릴리즈|release|동기화|최신화|\bsync\b|\bpull\b(?!\s*request)|삭제|지워|제거|정리|\bdelete\b|\bremove\b|clean\s*up|\bcleanup\b|리베이스|rebase|리셋|\breset\b|강제|\bforce\b)/i;
// Post-merge LOCAL main sync (Sprint 3h, ADR-0058) — only consulted at PR_MERGED/MAIN_SYNCED. A sync command needs
// a sync VERB (동기화/최신화/받아와/sync/pull/update ... main) AND a MAIN target — a bare "sync"/"pull" or a bare "main"
// alone never triggers.
export const SYNC_WORD = /(동기화|최신화|받아와|받아\s*줘|\bsync\b|\bpull\b(?!\s*request)|update\s+(local\s+)?main|당겨)/i;
// Chain verbs foreign to the main sync step (Codex wave-8 review): push / pull-request / branch delete / deploy / force.
export const SYNC_FOREIGN =
  /(푸시|\bpush|pull\s*request|풀\s*리퀘|삭제|지워|제거|\bdelete\b|\bremove\b|배포|deploy|릴리즈|release|리베이스|rebase|리셋|\breset\b|강제|\bforce\b)/i;
export const MAIN_WORD = /(\bmain\b|메인|origin\/main)/i;
/** Any mention of the main-sync step (allow-list hint at PR_MERGED) — never an execution trigger on its own. */
export const MAIN_SYNC_MENTION = /(동기화|최신화|받아와|\bsync\b|update\s+(local\s+)?main|\bpull\s+main\b)/i;
/** The origin to sync local main from (github.com origin; fixed like PR_BASE_BRANCH_POLICY). */
export const MAIN_SYNC_REMOTE = 'origin';
// Post-merge LOCAL branch cleanup (Sprint 3i, ADR-0059) — only consulted at MAIN_SYNCED/BRANCH_CLEANED. A cleanup
// command needs a cleanup VERB + a BRANCH word. A REMOTE qualifier routes to the "unsupported" reply (remote
// deletion deferred); bulk/wildcard and a "main"-delete target never trigger.
export const CLEANUP_VERB = /(정리|삭제|제거|지워|지우|없애|\bcleanup\b|clean\s*up|\bdelete\b|\bremove\b|\bprune\b)/i;
export const CLEANUP_BRANCH_WORD = /(브랜치|\bbranch\b)/i;
export const CLEANUP_REMOTE_WORD = /(원격|\bremote\b|\borigin\b|github)/i;
export const CLEANUP_BULK = /(다\s*(삭제|지워|정리)|전부|모두|\ball\b|every|\*|패턴|pattern|wildcard)/i;
export const CLEANUP_MAIN_TARGET = /(^|\s)(main|메인|master|default(\s*branch)?|기본\s*브랜치)\s*(브랜치)?\s*(삭제|지워|delete|remove)/i;
// Remote-branch-cleanup EXECUTION verb (Sprint 3j-A, ADR-0060) — only consulted at REMOTE_BRANCH_CLEANUP_APPROVED, to
// route an execute imperative to the "execution is a future step (3j-B)" reply. A re-request (원격 브랜치 삭제해줘) is
// caught first by interpretRemoteBranchCleanupIntent, so this needs only the pure execute verbs.
export const REMOTE_CLEANUP_EXECUTE_VERB = /(실행|진행|지금|승인된|\bexecute\b|\bproceed\b|\bnow\b|go\s*ahead)/i;
// A bare execute command with no other content ("실행해줘", "진행해", "proceed", "go ahead") — the only cleanup-execution
// form without a cleanup verb (Codex wave-8 review: "지금 몇 시야?" / "진행 상황 알려줘" must never delete a branch).
export const REMOTE_CLEANUP_BARE_EXECUTE =
  /^((이제|지금|바로)\s*)*(실행|진행)\s*(해\s*줘요?|해\s*주세요|해|하자|해라|할게|시켜\s*줘)?\s*[.!~]*$|^(please\s+)?(proceed|execute|go\s*ahead|do\s+it)(\s+(it|now))?(\s+please)?\s*[.!]*$/i;
// Chain verbs foreign to a branch-cleanup step (Codex wave-8 review): a push / merge / PR / sync / commit / deploy /
// force phrase is never a branch cleanup — "execute approved push" must not reach the remote DELETE. "머지된 브랜치" /
// "merged branch" are qualifiers, not merge verbs.
export const CLEANUP_FOREIGN_CHAIN_WORD =
  /(푸시|\bpush|원격에\s*올려|리모트에\s*올려|머지(?!\s*된)|병합(?!\s*된)|\bmerge\b|\bpr\b|pull\s*request|풀\s*리퀘|동기화|최신화|\bsync\b|\bpull\b|커밋|\bcommit\b|배포|deploy|릴리즈|release|리베이스|rebase|리셋|\breset\b|강제|\bforce\b|\btag\b|태그)/i;
// A statement / question / report about a cleanup is never a cleanup request (Codex wave-8 review): "브랜치 삭제했어",
// "브랜치 정리 완료", "브랜치 삭제 로그를 요약해줘", "원격 브랜치 상태 알려줘".
export const CLEANUP_NOT_A_REQUEST =
  /[?？]|(삭제|정리|제거)\s*(했|됐|되었|됨|완료|끝)|지웠|없앴|뭐|무엇|어떻게|왜|방법|설명|요약|보여|알려|로그|기록|이력|상태|확인|체크|\bhow\b|\bwhat\b|\bwhy\b|\bsummar|\bshow\b|\blogs?\b|\bexplain\b|\bstatus\b|\bcheck\b|\bdeleted\b|\bremoved\b/i;

/** A PR-ish noun (Sprint 3b, ADR-0049) — only ever consulted at GIT_PUSHED/PR_APPROVAL_PENDING/PR_APPROVED.
 *  A bare 좋아/오케이/확인/진행해/다음 단계 never matches. A noun ALONE is not a PR-creation request (CA #1). */
export const PR_WORD = /(\bpr\b|pull\s*request|풀\s*리퀘|merge\s*request|\bmr\b)/i;
/** Explicit PR-CREATION phrases (Sprint 3b, Q4 — CA #1/#2/#3): a PR-ish noun REQUIRES a create/open verb.
 *  Covers Korean spacing/order incl. "깃허브 PR 만들어줘" (CA #2) and "merge request 만들어줘"/"create merge
 *  request" (CA #3). A bare "PR"/"GitHub PR"/"pull request"/"merge request" is NOT sufficient (CA #1). */
export const PR_CREATION_WORDS =
  /((깃허브\s*)?(\bpr\b|pull\s*request|풀\s*리퀘|merge\s*request|\bmr\b)\s*(만들|생성|열|올려)|github\s*pr\s*(만들|생성|열|올려)|open\s+(a\s+)?(pr|pull\s*request|merge\s*request)|create\s+(a\s+)?(pr|pull\s*request|merge\s*request))/i;
/** Companions that must NOT ride along with a PR request (Sprint 3b, Constraint 10 / Q5 / CA #5) — only ever
 *  consulted when a PR word is present (2z CA #2 lesson). `\bmerge\b(?!\s*request)` keeps the GitLab synonym
 *  "merge request" a CREATE phrase while catching "auto merge" / "PR 만들고 merge". */
export const PR_FORBIDDEN_COMPANION =
  /(배포|deploy|auto\s*-?\s*merge|자동\s*머지|\bmerge\b(?!\s*request)|머지|병합|릴리즈|release|--?force|강제|\bforce\b|(^|\s)-f(\s|$)|리셋|\breset\b|checkout|체크아웃|stash|스태시|rebase|리베이스|\btag\b|태그|브랜치\s*생성|create\s+branch)/i;

/** Fixed PR base-branch product policy for Quoky Platform V2 (Sprint 3b, Q6/CA #6/#11 — CA option C). RepositoryInfo
 *  exposes NO default branch and no config default-branch source exists, so the base branch is a STATED PRODUCT
 *  POLICY, not an inferred/user-provided value. Revisit if a safer configured default-branch source is added. */
export const PR_BASE_BRANCH_POLICY = 'main';

/** Git-commit display/approval bounds (Sprint 2x, CA #7). */
export const MAX_COMMIT_OUT_OF_SCOPE_SHOWN = 10;
export const MAX_COMMIT_CANDIDATE_FILES = 30;
// Commit-message bounds/validation are shared with GitManager (Sprint 2y) — see ./commit-message.
