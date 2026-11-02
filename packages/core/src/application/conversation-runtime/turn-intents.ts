import { detectHelpIntent } from '../help-intent/help-intent';
import { hasCoLocatedUnnegated, unnegatedMatch } from '../intent-negation';
import { isChainCompanionRequest, isGitConceptQuestion, isGitTopicOnlyMention } from '../git-request-shape';
import { isAcceptedExecutionPhrase } from '../execution-command-guard';
import { type ConnectorWriteRelease, type ConnectorWriteStep, connectorWriteExecutionGate } from '../connector-writes/connector-write-flow';
import { interpretApprovalDecision, interpretStrayDecisionUtterance } from '../approval-decision';
import { detectExplicitValidationKinds, isDeniedValidationRequest } from '../validation-run-intent';
import { POLICY_SENSITIVE_CHAT_KIND } from '../intent-classifier';
import type { LastTurnReplyKind } from '../nl-routing/last-turn';
import { Capability, IntentType } from '../../domain';
import type { CommandExecution, Intent } from '../../domain';
import { type TurnHandlerOutcome } from '../../ports';
import type { ResponseComposer, TestResultDetail } from '../response-composer';
import { detectWorkChatCommand } from '../work-chat/work-chat-command';
import { normalizeRelativePath } from '../target-scope';
import { MAX_COMMIT_MESSAGE_CHARS, isValidCommitMessage } from '../commit-message';
import { extractSafeTargetCandidates } from '../code-work/code-change-set';
import type { CodeChangeTargetCollection } from '../code-work/code-change-set';
import {
  APPLY_WORDS,
  CLEANUP_BRANCH_WORD,
  CLEANUP_BULK,
  CLEANUP_FOREIGN_CHAIN_WORD,
  CLEANUP_MAIN_TARGET,
  CLEANUP_NOT_A_REQUEST,
  CLEANUP_REMOTE_WORD,
  CLEANUP_VERB,
  COMMIT_EXECUTION_FORBIDDEN,
  COMMIT_EXECUTION_WORDS,
  COMMIT_FORBIDDEN_COMPANION,
  COMMIT_WORDS,
  FINAL_APPLY_WORDS,
  GIT_DIFF_WORDS,
  GIT_MUTATING_WORDS,
  GIT_STATUS_WORDS,
  HOW_TO_QUESTION,
  MAIN_WORD,
  MERGE_EXECUTION_ATTACHED,
  MERGE_EXECUTION_FOREIGN,
  MERGE_EXECUTION_VERB,
  MERGE_QUESTION,
  MERGE_REQUEST_ATTACHED,
  MERGE_WORD,
  PATCH_WORDS,
  PR_CREATION_WORDS,
  PR_FORBIDDEN_COMPANION,
  PR_STATUS_NOUN,
  PR_STATUS_QUERY,
  PR_WORD,
  PUSH_CHAT_TOPIC,
  PUSH_EXECUTION_WORDS,
  PUSH_FORBIDDEN_COMPANION,
  PUSH_REQUEST_SHAPES,
  PUSH_WORDS,
  REMOTE_CLEANUP_BARE_EXECUTE,
  REMOTE_CLEANUP_EXECUTE_VERB,
  SYNC_FOREIGN,
  SYNC_WORD,
} from './intent-words';
import type { ApprovalDecisionKind } from './types';

/** Capabilities that operate on files need a resolved workspace; chat does not. */
export function needsWorkspace(capability: Capability): boolean {
  return capability === Capability.CODE_IMPLEMENTATION || capability === Capability.TEST_EXECUTION;
}

/** Interpret a user message as an approval decision (only meaningful while a pending approval exists). */
export function interpretDecision(text: string): ApprovalDecisionKind {
  return interpretApprovalDecision(text);
}

/** Explicit apply intent only (Sprint 2s, ADR-0040) — deliberately NOT interpretDecision/APPROVE_WORDS;
 *  "좋아"/"오케이"/"확인"/"괜찮네" must never authorize file modification (Critical Product Rule). */
export function interpretApplyIntent(text: string): boolean {
  return unnegatedMatch(text, APPLY_WORDS); // negation-aware (ADR-0062 draft): "적용하지 마" is not an apply
}

/** Explicit patch-generation intent only (Sprint 2t, ADR-0041) — the ambiguous standalone "계속 진행"
 *  is excluded; combined with routing, generation only fires on an APPROVED anchor. */
export function interpretPatchIntent(text: string): boolean {
  return unnegatedMatch(text, PATCH_WORDS); // negation-aware (ADR-0062 draft)
}

/** Explicit final workspace-apply intent only (Sprint 2u, ADR-0042) — qualified phrases only; a bare
 *  "적용"/"다음 단계 진행"/"좋아" never triggers a file write. Combined with routing, a write only fires
 *  on a PATCH_READY anchor. Checked before apply-intent so "패치 적용해줘" is a file-apply. */
export function interpretFinalApplyIntent(text: string): boolean {
  return unnegatedMatch(text, FINAL_APPLY_WORDS); // negation-aware (ADR-0062 draft)
}

/**
 * Explicit post-apply validation intent only (Sprint 2v, ADR-0043) — qualified validation tokens only; a
 * bare "좋아"/"오케이"/"확인"/"다음 단계 진행"/"계속 진행" (or any message with no validation token) never
 * matches. The command is DERIVED from the matched kind, never from user text. Returns:
 *  - `'test'` / `'typecheck'` → run exactly that one allow-listed command;
 *  - `'ambiguous'` → clarify: bare "검증", OR BOTH test and typecheck requested (CA Round 1 #1 — never a
 *    silent pick);
 *  - `'unsupported'` → a validation phrase carrying a dangerous/arbitrary command fragment (CA Round 1 #2
 *    — refuse, never a run);
 *  - `null` → not a validation intent at all → fall through (Sprint 2l path / normal routing).
 * Only consulted inside the WORKSPACE_APPLIED routing guard, so Sprint 2l semantics are untouched.
 */
export function interpretPostApplyValidationIntent(
  text: string,
): 'test' | 'typecheck' | 'ambiguous' | 'unsupported' | null {
  const t = text.trim().toLowerCase();
  // Use the same explicit request boundary as IntentClassifier. Topic mentions alone must never enter the
  // direct command.run path merely because a WORKSPACE_APPLIED anchor exists.
  const { test: wantsTest, typecheck: wantsTypecheck } = detectExplicitValidationKinds(text);
  const mentionsTest = unnegatedMatch(text, [/테스트|\btests?\b/i]);
  const mentionsTypecheck = unnegatedMatch(text, [/typecheck|타입\s*체크|type\s*check/i]);
  const wantsValidate = unnegatedMatch(text, [
    /^\s*검증\s*$/i,
    /^\s*검증\s*(?:해\s*(?:줘|주세요|봐|보세요|줄래|주실래요?)|하(?:세요|자|라)|부탁해)\s*$/i,
    /^\s*(?:please\s+)?validate\s*$/i,
  ]);
  const hasValidationSignal =
    wantsTest || wantsTypecheck || mentionsTest || mentionsTypecheck || wantsValidate;
  // (CA Round 1 #2) Any validation signal combined with an out-of-allow-list fragment is refused before
  // request-shape gating. A denied suffix may prevent an end-anchored request matcher from detecting a kind,
  // but it must never let the message fall through to or trigger command execution.
  if (isDeniedValidationRequest(t) && hasValidationSignal) return 'unsupported';
  // Gate first: with no validation token this is NOT our branch — a pure "git status 해줘" falls through
  // untouched (CA Round 1 #7), never a validation "unsupported" reply.
  if (!wantsTypecheck && !wantsTest && !wantsValidate) return null;
  // (CA Round 1 #1) BOTH test and typecheck requested → clarify; NEVER silently pick one.
  if ((wantsTypecheck && mentionsTest) || (wantsTest && mentionsTypecheck)) return 'ambiguous';
  if (wantsTypecheck) return 'typecheck';
  if (wantsTest) return 'test';
  return 'ambiguous'; // "검증" alone
}

/**
 * Explicit read-only git-preview intent (Sprint 2w, ADR-0044). Returns:
 *  - `'mutating'` → a git MUTATION phrase (커밋/푸시/add/reset/…, or any English `commit`) → reject, no git
 *    call. Checked FIRST — precedence over diff/status (CA Required Change #6);
 *  - `'diff'` → a read-only diff preview;
 *  - `'status'` → a read-only status/changed-files preview;
 *  - `null` → not a git-preview intent → fall through (no broad general git handling, CA Q3).
 * Only consulted inside the WORKSPACE_APPLIED routing guard. Korean "커밋 전에 변경사항 요약" is status;
 * English `commit` is conservative (→ mutating) until a future sprint adds clearer NL handling (CA #5).
 */
export function interpretGitPreviewIntent(text: string): 'status' | 'diff' | 'mutating' | null {
  const t = text.trim().toLowerCase();
  // W1-L03: a how-to question about a git mutation ("git commit 어떻게 해?") is chat, not a mutation to reject.
  // Live QA 2026-10-07: a concept question / topic mention ("rebase와 merge 비교해줘", "푸시 로직 검토해줘") is chat too.
  if (GIT_MUTATING_WORDS.test(t)) return HOW_TO_QUESTION.test(t) || isGitTopicOnlyMention(t) ? null : 'mutating';
  if (GIT_DIFF_WORDS.test(t)) return 'diff';
  if (GIT_STATUS_WORDS.test(t)) return 'status';
  return null;
}

/**
 * Explicit git-commit intent (Sprint 2x, ADR-0045). Returns:
 *  - `'commit'` → a pure commit request → commit-approval planning;
 *  - `'commit-with-forbidden'` → a commit request bundled with push/add/reset/… (rejected — approval only);
 *  - `null` → not a commit request. A push/add/reset-**only** phrase returns null so the Sprint 2w
 *    git-preview mutating-reject still handles it unchanged; "커밋 전에 변경사항 요약" (no action verb after
 *    커밋) stays a 2w status phrase. A bare 좋아/오케이/확인/다음 단계/진행해/이대로 해 → null.
 */
export function interpretCommitIntent(text: string): 'commit' | 'commit-with-forbidden' | null {
  // Liberal commit-token detection is used ONLY for the forbidden-combo guard, so a bundled request like
  // "commit and push" / "커밋하고 push" is rejected as unsupported (never routed to a plain commit or the
  // 2w mutating reply). The plain-commit trigger stays conservative via COMMIT_WORDS. Negation-aware
  // (ADR-0062 draft): a NEGATED commit/companion token ("커밋하지 마", "do not commit/push") is NOT a request.
  // W1-L03: a how-to question ("git commit 은 어떻게 하는 거야?") asks about committing — never a commit request.
  if (HOW_TO_QUESTION.test(text) || isGitConceptQuestion(text)) return null; // + "커밋 메시지 컨벤션 알려줘" (live QA 2026-10-07)
  const hasCommitToken = unnegatedMatch(text, [/커밋|\bcommit\b/i]);
  if (hasCommitToken && unnegatedMatch(text, [COMMIT_FORBIDDEN_COMPANION])) return 'commit-with-forbidden';
  if (!unnegatedMatch(text, [COMMIT_WORDS])) return null; // "커밋 전"/push-only/negated/etc. → not a commit request
  return 'commit';
}

/**
 * Explicit commit-EXECUTION intent (Sprint 2y, ADR-0046) — only consulted inside the COMMIT_APPROVED /
 * GIT_COMMITTED routing guards. Returns:
 *  - `'push-unsupported'` → a push/other-mutation phrase (checked first; rejected, no push);
 *  - `'execute'` → perform the approved commit ("승인된 커밋 실행해줘"/"커밋 실행해줘"/"이제 실제 커밋해줘"/
 *    "execute commit"/…);
 *  - `null` → not an execution request (bare 좋아/오케이/확인/진행해/다음 단계 → null).
 */
export function interpretCommitExecutionIntent(text: string): 'execute' | 'push-unsupported' | null {
  // Live QA 2026-10-07: with no commit-execution phrase, a question / topic mention ("rebase와 merge 차이가 뭐야?") is
  // never a forbidden companion. An explicit execution phrase is always classified.
  if (!unnegatedMatch(text, [COMMIT_EXECUTION_WORDS]) && isGitTopicOnlyMention(text)) return null;
  if (unnegatedMatch(text, [COMMIT_EXECUTION_FORBIDDEN])) return 'push-unsupported'; // push/reset/… incl. "commit and push"
  if (unnegatedMatch(text, [COMMIT_EXECUTION_WORDS])) return 'execute';
  return null;
}

/**
 * Explicit git-PUSH intent (Sprint 2z, ADR-0047) — only consulted inside the GIT_COMMITTED / PUSH_APPROVED
 * routing guards (never a global/no-anchor handler — CA #1). A forbidden-companion is classified ONLY when
 * a push word is present (CA #2), so a bare "배포해줘"/"branch"/"tag"/"reset" is NOT push handling. Returns:
 *  - `null` → no push word (→ existing fallback);
 *  - `'push-unsupported'` → push bundled with force/PR/deploy/tag/branch/reset/checkout/stash/merge/rebase;
 *  - `'push'` → a plain push request ("푸시해줘"/"git push 해줘"/"원격에 올려줘"/"push this commit"/…).
 */
export function interpretPushIntent(text: string): 'push' | 'push-unsupported' | null {
  if (isGitTopicOnlyMention(text)) return null; // "git push와 merge 차이가 뭐야?" / "푸시 로직을 검토해줘" → chat (live QA 2026-10-07)
  if (!unnegatedMatch(text, [PUSH_WORDS])) return null; // (CA #2) no (non-negated) push word → not push handling
  if (unnegatedMatch(text, [PUSH_FORBIDDEN_COMPANION])) return 'push-unsupported'; // push + force/PR/deploy/tag/branch/…
  return 'push';
}

/**
 * A push request that reaches the no-relevant-anchor fall-through (QA-V2-W8): the strict imperative/execution
 * shape of {@link interpretPushIntent}. A question or a topic mention ("git push가 뭐야?", "푸시 알림 설정하는 법",
 * "push notification 구현 방법") is `null` and stays ordinary chat.
 */
export function interpretNoAnchorPushRequest(text: string): 'push' | 'push-unsupported' | null {
  const kind = interpretPushIntent(text);
  if (kind === null) return null;
  const t = text.trim();
  if (PUSH_CHAT_TOPIC.test(t) || !PUSH_REQUEST_SHAPES.some((re) => re.test(t))) return null;
  return kind;
}

/**
 * Explicit git-push-EXECUTION intent (Sprint 3a, ADR-0048) — only consulted inside the PUSH_APPROVED /
 * GIT_PUSHED routing guards. A forbidden-companion is classified ONLY when a push/exec word is present
 * (2z CA #2 lesson), so a bare "배포"/"branch"/"reset" is NOT push handling. Returns:
 *  - `null` → no push/exec word, OR a bare push word without an execution phrase (→ 2z already-approved);
 *  - `'push-unsupported'` → push bundled with force/PR/deploy/tag/branch/reset/checkout/stash/merge/rebase;
 *  - `'execute'` → an explicit execution phrase ("승인된 push 실행해줘"/"push 실행해줘"/"이제 실제 push"/
 *    "execute approved push"/"push approved commit"/…).
 */
export function interpretPushExecutionIntent(text: string): 'execute' | 'push-unsupported' | null {
  if (!unnegatedMatch(text, [PUSH_EXECUTION_WORDS]) && !unnegatedMatch(text, [PUSH_WORDS])) return null; // no (non-negated) push/exec word
  // A bare push word in a question / topic mention is chat (live QA 2026-10-07); an execution phrase is always classified
  // (Codex wave-8 review, P1: "푸시 실행해도 돼?" must never reach a later destructive route).
  if (!unnegatedMatch(text, [PUSH_EXECUTION_WORDS]) && isGitTopicOnlyMention(text)) return null;
  if (unnegatedMatch(text, [PUSH_FORBIDDEN_COMPANION])) return 'push-unsupported'; // push + force/PR/deploy/tag/branch/…
  if (unnegatedMatch(text, [PUSH_EXECUTION_WORDS])) return 'execute';
  return null; // a bare push word (no exec word) → leave to the 2z already-approved reply at PUSH_APPROVED
}

/**
 * Explicit PR-creation intent (Sprint 3b, ADR-0049) — only consulted inside the GIT_PUSHED / PR_APPROVED
 * routing guards (never a global/no-anchor handler). A forbidden-companion is classified ONLY when a PR
 * word is present (2z CA #2 lesson), so a bare "배포"/"merge"/"reset" is NOT PR handling. Returns:
 *  - null → no PR word, OR a bare PR noun WITHOUT a create/open verb (→ existing behavior — CA #1);
 *  - 'pr-unsupported' → PR bundled with deploy/merge/release/auto-merge/force/reset/… (CA #5);
 *  - 'create' → an explicit PR-creation phrase ("PR 만들어줘"/"open a PR"/"merge request 만들어줘"/…).
 */
export function interpretPrIntent(text: string): 'create' | 'pr-unsupported' | null {
  if (!unnegatedMatch(text, [PR_WORD])) return null; // no (non-negated) PR word → not PR handling
  if (isGitTopicOnlyMention(text)) return null; // "PR 만드는 법 알려줘" / "PR과 머지 차이" → chat (live QA 2026-10-07)
  // PR + deploy/merge/release/force/… → unsupported only when the companion rides along with a PR request: a PR
  // create verb, a companion request shape, or a short command ("PR 만들고 배포", "PR and merge"). Free text that merely
  // names both ("PR 설명에 배포 일정 적어줘") is not a bundle (live QA 2026-10-07).
  if (
    unnegatedMatch(text, [PR_FORBIDDEN_COMPANION]) &&
    (unnegatedMatch(text, [PR_CREATION_WORDS]) || isChainCompanionRequest(text) || text.trim().split(/\s+/).length <= 4)
  ) {
    return 'pr-unsupported';
  }
  if (unnegatedMatch(text, [PR_CREATION_WORDS])) return 'create';
  return null; // a bare PR noun without a create/open verb → not PR handling (CA #1)
}

/**
 * Explicit PR/CI/check/review STATUS-preview intent (Sprint 3e, ADR-0055) — only consulted at PR_CREATED.
 * True only when BOTH a status-context noun (PR/CI/check/review) AND a query verb (상태/확인/…) are present, so
 * a bare "상태" never triggers (CA Q1) and merge/deploy/release/reviewer/label phrases (no status noun+query)
 * do not match — they keep routing to the companion-unsupported reply.
 */
export function interpretPrStatusIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  return PR_STATUS_NOUN.test(t) && PR_STATUS_QUERY.test(t) && !isGitConceptQuestion(t); // "PR 리뷰 어떻게 하는지 알려줘" → chat
}

/** True for an explicit work-chat lookup/search command (reuses the work-chat grammar; never a to-do mutation). */
export function isWorkChatLookupCommand(text: string): boolean {
  return detectWorkChatCommand(text)?.kind === 'lookup';
}

/**
 * Explicit merge-APPROVAL intent (Sprint 3f, ADR-0056) — only consulted at PR_CREATED, AFTER the status
 * intent. Returns `'merge'` only for a merge word + an approval/execution request verb attached to it (live QA
 * 2026-10-07: a concept question or topic mention such as "git rebase와 merge 차이를 간단히 설명해줘" is null); a merge
 * safety/possibility QUESTION or a bare merge noun returns null (→ falls through to the companion reply). A
 * bare "진행해"/"좋아"/"승인" has no merge word → null (so PR_CREATED + "진행해" never creates a merge approval).
 */
export function interpretMergeIntent(text: string): 'merge' | null {
  const t = text.trim().toLowerCase();
  if (!MERGE_WORD.test(t)) return null;
  if (MERGE_QUESTION.test(t)) return null; // "머지 가능해?/안전해?/통과?" → not an approval request
  // Live QA 2026-10-07: a concept question / topic mention ("git rebase와 merge 차이를 간단히 설명해줘", "머지 전략 비교해줘",
  // "explain git merge") is chat, and the request verb must attach to the merge word ("머지해줘", "merge the PR").
  if (isGitTopicOnlyMention(t)) return null;
  if (MERGE_REQUEST_ATTACHED.test(t)) return 'merge';
  return null; // bare "머지" noun → companion-unsupported
}

/**
 * A merge request with no code chain (live QA session 3, D11): the {@link interpretMergeIntent} request shape, naming a
 * git merge — "머지"/"merge", or "병합" next to a PR / git word ("PR 머지해줘", "머지해줘", "PR 병합해줘"). A generic
 * "파일 병합해줘" is not one (chat). Only picks the fixed merge-disabled / no-PR reply; never an approval or a merge.
 */
export function interpretNoChainMergeRequest(text: string): 'merge' | null {
  if (interpretMergeIntent(text) !== 'merge') return null;
  if (!unnegatedMatch(text, [MERGE_WORD])) return null;
  const t = text.trim().toLowerCase();
  return /머지|\bmerge\b/.test(t) || PR_WORD.test(t) || /\bgit\b|깃/.test(t) ? 'merge' : null;
}

/**
 * Explicit merge-EXECUTION intent (Sprint 3g, ADR-0057, CA change 1) — only consulted at MERGE_APPROVED /
 * PR_MERGED. A merge word + a request/execution verb → `'execute'`; the MERGE_QUESTION status/check/possibility
 * guard takes precedence (so "머지 상태 확인해줘"/"머지 체크해줘"/"머지 가능해?" never execute); a bare "머지"/"merge"
 * noun (no verb) → null (→ composeMergeAlreadyApproved). At MERGE_APPROVED the CRITICAL 3f approval was already
 * granted, so "머지해줘"/"이 PR 머지해줘"/"merge this PR" are valid execution commands.
 */
export function interpretMergeExecutionIntent(text: string): 'execute' | null {
  const t = text.trim().toLowerCase();
  if (!MERGE_WORD.test(t)) return null;
  if (MERGE_QUESTION.test(t)) return null; // status/check/possibility → not execution (read-only path)
  if (isGitTopicOnlyMention(t)) return null; // concept question / topic mention → chat (live QA 2026-10-07)
  if (MERGE_EXECUTION_FOREIGN.test(t)) return null; // merge + push/deploy/sync/delete/force → never execution (Codex W8)
  if (MERGE_EXECUTION_VERB.test(t) && MERGE_EXECUTION_ATTACHED.test(t)) return 'execute';
  return null; // bare "머지"/"merge" noun → already-approved reply, no execution
}

/**
 * A merge STATUS/CHECK phrase (Sprint 3g) → routes to the read-only status preview at MERGE_APPROVED/PR_MERGED,
 * so "머지 상태 확인해줘"/"머지 체크해줘" land on the 3e preview even though PR_STATUS_NOUN does not include "머지".
 * A merge word + a MERGE_QUESTION status/check/possibility word (never execution).
 */
export function interpretMergeStatusIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  return MERGE_WORD.test(t) && MERGE_QUESTION.test(t) && !isGitConceptQuestion(t); // "merge conflict 해결법 알려줘" → chat
}

/**
 * Explicit post-merge LOCAL main sync intent (Sprint 3h, ADR-0058) — only consulted at PR_MERGED / MAIN_SYNCED.
 * Requires a sync verb (동기화/최신화/받아와/sync/pull/update main) AND a main target — so a bare "sync"/"pull" or a
 * bare "main" alone does not trigger. Covers "main 동기화해줘"/"로컬 main 최신화해줘"/"머지된 main 받아와줘"/"sync main"/
 * "update local main".
 */
export function interpretMainSyncIntent(text: string): 'sync' | null {
  const t = text.trim().toLowerCase();
  if (!SYNC_WORD.test(t)) return null;
  if (isGitTopicOnlyMention(t)) return null; // "git pull과 fetch 차이 설명해줘" → chat (live QA 2026-10-07)
  if (SYNC_FOREIGN.test(t)) return null; // sync + push/PR/delete/deploy/force → never a sync command (Codex W8)
  if (MAIN_WORD.test(t) || /update\s+(local\s+)?main/.test(t)) return 'sync';
  return null;
}

/**
 * A REMOTE branch cleanup phrase (Sprint 3i, ADR-0059, CA change 1; HARDENED in Sprint 3j-A, ADR-0060) — consulted
 * at MAIN_SYNCED (→ unsupported: clean local first) and BRANCH_CLEANED / REMOTE_BRANCH_CLEANUP_APPROVED (→ the
 * CRITICAL approval flow). A cleanup verb + a branch word + a remote qualifier (원격/remote/origin/github) →
 * `'remote'`. **3j-A hardening (CA change 8):** because a remote phrase now starts a real CRITICAL delete-approval
 * (not a 3i no-op), bulk/wildcard/"main·default" phrases MUST be rejected here too so they can never create an
 * approval request. The deletion target is ALWAYS the anchored PR head branch — never a user-named branch.
 */
export function interpretRemoteBranchCleanupIntent(text: string): 'remote' | null {
  const t = text.trim().toLowerCase();
  if (CLEANUP_BULK.test(t) || CLEANUP_MAIN_TARGET.test(t)) return null; // bulk/wildcard/"main·default 삭제" → never
  if (CLEANUP_FOREIGN_CHAIN_WORD.test(t) || CLEANUP_NOT_A_REQUEST.test(t)) return null; // other chain verb / statement (Codex W8)
  if (isGitTopicOnlyMention(t)) return null; // "원격 브랜치 삭제와 로컬 브랜치 삭제 차이" → chat (live QA 2026-10-07)
  if (CLEANUP_VERB.test(t) && CLEANUP_BRANCH_WORD.test(t) && CLEANUP_REMOTE_WORD.test(t)) return 'remote';
  return null;
}

/**
 * An explicit remote-branch-cleanup EXECUTION intent (Sprint 3j-A, HARDENED in Sprint 3j-B, ADR-0060) — only
 * consulted at REMOTE_BRANCH_CLEANUP_APPROVED, checked FIRST (Sprint 3j-B, CA change 1) so an execution phrase
 * ("원격 브랜치 삭제 실행해줘" / "지금 원격 브랜치 삭제해줘" / "execute remote branch cleanup" / "proceed") is never swallowed
 * by the re-request ("already approved") route. A pure execute verb (실행/진행/지금/execute/proceed/now) → `'execute'`.
 * **3j-B hardening (CA change 1):** bulk/wildcard/main/default phrases are rejected here too so they can never
 * execute a delete. A bare re-request ("원격 브랜치 삭제해줘", no execute verb) → null → "already approved".
 */
export function interpretRemoteBranchCleanupExecutionIntent(text: string): 'execute' | null {
  const t = text.trim().toLowerCase();
  if (CLEANUP_BULK.test(t) || CLEANUP_MAIN_TARGET.test(t)) return null; // bulk/wildcard/main·default → never execute (CA change 1)
  // (Codex wave-8 review, P1) only the step's OWN execution phrases: never a push/merge/PR/sync/… phrase ("execute
  // approved push", "푸시 실행해도 돼?"), never a statement/question, never an execute word with unrelated content.
  if (CLEANUP_FOREIGN_CHAIN_WORD.test(t) || CLEANUP_NOT_A_REQUEST.test(t)) return null;
  if (isGitTopicOnlyMention(t)) return null; // concept question / topic mention → chat (live QA 2026-10-07)
  if (REMOTE_CLEANUP_BARE_EXECUTE.test(t)) return 'execute'; // "실행해줘" / "proceed" — the approved step's own command
  // Otherwise the step's OWN target is required (Codex wave-8 re-review): a cleanup verb + a branch word + a remote
  // qualifier + an execute verb — "delete the file now" names no remote branch and never executes.
  if (
    CLEANUP_VERB.test(t) &&
    CLEANUP_BRANCH_WORD.test(t) &&
    CLEANUP_REMOTE_WORD.test(t) &&
    unnegatedMatch(t, [REMOTE_CLEANUP_EXECUTE_VERB])
  ) {
    return 'execute';
  }
  return null;
}

/**
 * A LOCAL branch cleanup phrase (Sprint 3i, ADR-0059) — only consulted at MAIN_SYNCED/BRANCH_CLEANED, AFTER the
 * remote guard. A cleanup verb + a branch word → `'local'`; rejects bulk/wildcard, a "main"-delete target, and any
 * remote qualifier (handled by interpretRemoteBranchCleanupIntent). The deletion target is ALWAYS the anchored PR
 * head branch — never a user-named branch. A bare "정리해줘"/"배포해줘" (no branch word) → null.
 */
export function interpretBranchCleanupIntent(text: string): 'local' | null {
  const t = text.trim().toLowerCase();
  if (CLEANUP_BULK.test(t) || CLEANUP_MAIN_TARGET.test(t)) return null; // bulk/wildcard/"main 삭제" → never
  if (CLEANUP_REMOTE_WORD.test(t)) return null; // remote → not local (routed by interpretRemoteBranchCleanupIntent)
  if (CLEANUP_FOREIGN_CHAIN_WORD.test(t) || CLEANUP_NOT_A_REQUEST.test(t)) return null; // other chain verb / statement (Codex W8)
  if (isGitTopicOnlyMention(t)) return null; // concept question / topic mention → chat (live QA 2026-10-07)
  if (CLEANUP_VERB.test(t) && CLEANUP_BRANCH_WORD.test(t)) return 'local';
  return null;
}

/**
 * Resolve the commit message for a commit-approval turn (Sprint 2x, CA #6/#7/#8). If the text carries a
 * user message (a single quoted segment after a `메시지`/`message` keyword) it is accepted only when it is
 * exactly one candidate, single-line, ≤120 chars, control-char-free, and trimmed non-empty — otherwise
 * `'invalid'`. With no user message, a deterministic template from `targetFiles` is used (no AI). Never
 * interpolates diff/file content.
 */
export function parseCommitMessage(text: string, targetFiles: string[]): { message: string } | 'invalid' {
  // A user message is offered ONLY via a quoted segment (e.g. 메시지는 "fix: …"). No quote → deterministic
  // template (so "커밋 메시지 만들어줘" means "make one for me", not an empty user message). More than one
  // quoted segment → invalid (CA #8, no ambiguous multi-message extraction).
  const quoted = text.match(/["'`]([^"'`]*)["'`]/g) ?? [];
  if (quoted.length > 0) {
    if (quoted.length !== 1) return 'invalid';
    const inner = quoted[0]!.slice(1, -1).trim();
    if (!isValidCommitMessage(inner)) return 'invalid';
    return { message: inner };
  }
  const primary = targetFiles[0] ?? 'workspace';
  const suffix = targetFiles.length > 1 ? ` 외 ${targetFiles.length - 1}개` : '';
  return { message: `chore: update ${primary}${suffix}`.slice(0, MAX_COMMIT_MESSAGE_CHARS) };
}

/** A6 R5a: what a handler's reply was, for `quoky.lastTurn` (an echo, a to-do / reminder listing, a question, a note). */
export function nlReplyKindOf(handled: TurnHandlerOutcome): { readonly kind: LastTurnReplyKind; readonly listingSource?: 'todo' | 'reminder' } {
  if (handled.kind === 'summarize' || handled.kind === 'write-draft') return { kind: 'note' };
  const action = handled.nlAction;
  const local = (source: string | undefined): 'todo' | 'reminder' | undefined => (source === 'todo' || source === 'reminder' ? source : undefined);
  if (action !== undefined && (action.result === 'executed' || action.result === 'undone') && local(action.source) !== undefined) {
    return { kind: 'echo', listingSource: local(action.source) as 'todo' | 'reminder' };
  }
  if (handled.nlListing !== undefined && handled.nlListing.items.length > 0) {
    // A6 R2: a Jira / Slack listing is a listing reply, but never an R5a referent source.
    const listed = local(handled.nlListing.source);
    return listed !== undefined ? { kind: 'listing', listingSource: listed } : { kind: 'listing' };
  }
  if (action !== undefined && action.result === 'asked' && (action.candidates?.length ?? 0) > 0 && local(action.source) !== undefined) {
    return { kind: 'question', listingSource: local(action.source) as 'todo' | 'reminder' };
  }
  return { kind: 'note' };
}

/** ADR-0120 D6 Phase C: the classifier's personal-work surface (a frozen Class B clause, D6) as a selection route. */
export function nlWorkSurfaceRoute(intent: Intent): 'work-surface' | undefined {
  return intent.type === IntentType.LOOKUP && intent.raw?.kind === 'personal-work-surface' ? 'work-surface' : undefined;
}

/** ADR-0120 D6: the Phase A routes selection may run on, or `undefined`. */
export function nlSelectionRoute(intent: Intent): 'chat' | 'personal-data' | undefined {
  if (intent.capability === Capability.GENERAL_CHAT && intent.type === IntentType.CHAT) return 'chat';
  if (
    intent.capability === Capability.POLICY_SENSITIVE_CHAT &&
    intent.raw?.kind === POLICY_SENSITIVE_CHAT_KIND &&
    intent.raw.reason === 'personal-data'
  ) {
    return 'personal-data';
  }
  return undefined;
}

export function explicitDurableMemoryContent(text: string): string | null {
  const match = text.trim().match(/^(?:기억해줘|기억해|remember)\s*:\s*(.*)$/isu);
  return match ? (match[1] ?? '').trim() : null;
}

/**
 * The reply for the follow-up a lapsed write was waiting for: its exact execution phrase after an expired grant, or a
 * choice number after an expired choice. Anything else routes as a new turn (null).
 */
export function lapsedConnectorWriteStep(lapsed: ConnectorWriteRelease, text: string): ConnectorWriteStep | null {
  if (lapsed.status === 'APPROVED') {
    if (!lapsed.operation || !isAcceptedExecutionPhrase(connectorWriteExecutionGate(lapsed.operation), text)) return null;
    return { kind: 'refused', reason: 'grant-expired', family: lapsed.family };
  }
  if (connectorWriteChoiceIndex(text) === null) return null;
  return { kind: 'refused', reason: 'choice-expired', family: lapsed.family };
}

/** "1", "2번", "1번이요", "2번으로" — a choice number, or null. */
export function connectorWriteChoiceIndex(text: string): number | null {
  const match = /^\s*(\d{1,2})\s*(?:번(?:째)?)?\s*(?:이요|요|으로|로|으로\s*해\s*줘|로\s*해\s*줘|이에요|입니다)?\s*[.!~]*\s*$/u.exec(text);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 1 ? index : null;
}

/** Optional "the preview / the change" noun before a cancel word ("미리보기 취소", "변경 취소해줘", "cancel the preview"). */
export const PREVIEW_DISCARD_NOUN =
  /^(?:(?:이|그|this|the)\s*)?(?:미리\s*보기|변경\s*사항|코드\s*변경|변경|수정\s*사항|preview|changes?)\s*(?:은|는|을|를|도)?\s*/i;

/**
 * Whether a turn at an ELIGIBLE anchor asks to discard the shown preview (QA-V2-CL-03): a bare cancel utterance
 * ("취소", "취소해줘", "cancel"), optionally led by a preview noun. Deny/approve words are NOT discards and keep the
 * QA-018 reply; a cancel word inside a longer request ("결제 취소 기능 추가해줘") is not a bare utterance.
 */
export function isPreviewDiscardUtterance(text: string): boolean {
  const trimmed = text.trim();
  // Only a genuinely bare message: the stray-decision parser strips punctuation, so a fenced/inline code block or a
  // multi-line message that merely contains "cancel" must never discard a preview.
  if (trimmed.length === 0 || /[`\n\r]|~~~/.test(trimmed)) return false;
  if (interpretStrayDecisionUtterance(trimmed) === 'cancel') return true;
  const withoutNoun = trimmed.replace(PREVIEW_DISCARD_NOUN, '');
  return withoutNoun !== trimmed && interpretStrayDecisionUtterance(withoutNoun) === 'cancel';
}

/** Explicit create-file markers (Sprint 4c-Follow-up-2, A2) — KO + EN. Conservative: only unambiguous
 *  file-creation wording, so an ordinary code-change request never trips it. */
export const NEW_FILE_MARKER =
  /(파일\s*생성|파일\s*추가|새\s*파일(?:\s*(?:생성|추가))?|create\s+(?:a\s+)?(?:new\s+)?file|new\s+file|add\s+(?:a\s+)?(?:new\s+)?file)/i;

/** File noun for the co-located create-file phrasing (Sprint 4c-Follow-up-6). */
export const NEW_FILE_NOUN = /(파일|file)/i;

/** IMPERATIVE/request create verb (Sprint 4c-Follow-up-6): natural KO "만들어줘 / 만들어 줘 / 만들자 / 생성해(줘)"
 *  and "make/create". Deliberately request-shaped so a PAST/descriptive "만들어졌는지" ("how it was made") or a
 *  negated "만들지 마" is NOT matched as a create request. */
export const NEW_FILE_CREATE_VERB =
  /(만들어\s*줘|만들어\s*주(?:세요|실래요|시겠어요)?|만들어\s*줄래|만들어라|만들자|생성\s*해(?:\s*줘|\s*주세요)?|\bcreate\b|\bmake\b)/i;

/**
 * The pre-ADR-0099 single new-file rule (Sprint 4c-Follow-up-2, A2; extended 4c-Follow-up-6): the normalized
 * path for a create-file request with exactly ONE candidate, else null. NOT used for routing any more — a
 * code-change request now collects every named path (≤ MAX_CHANGE_SET_FILES) through
 * `collectCodeChangeTargets` with {@link isExplicitNewFileRequest} as the create gate. Kept only as the public,
 * pure seam the create-wording tests exercise (`isExplicitNewFileRequest` itself is private). No I/O.
 */
export function explicitNewFileTarget(text: string, candidates: readonly string[]): string | null {
  if (!isExplicitNewFileRequest(text)) return null;
  if (candidates.length !== 1) return null; // 0 → nothing to target; >1 → ambiguous → clarify
  const only = candidates[0];
  return only ? normalizeRelativePath(only) : null;
}

/**
 * Whether the text is an explicit, NON-negated new-file creation request (Sprint 4c-Follow-up-6, CA scope
 * expansion). Two recognizers, both negation-/clause-aware so a negated or descriptive phrase stays a
 * constraint, not a create intent:
 *   (a) the fixed markers (파일 생성/추가, 새 파일, create/new/add file) at a NON-negated position — so
 *       "새 파일 생성 금지" / "do not create file" do NOT count;
 *   (b) natural KO "파일 … 만들다(imperative)" — a file NOUN co-located in the same, un-negated clause with a
 *       request-shaped create VERB — so "다음 파일을 새로 만들어줘" counts, while "파일을 만들지 마" (negated),
 *       "파일은 실제로 만들거나 수정하지 말 것" (negated), and "이 파일이 어떻게 만들어졌는지 알려줘" (descriptive,
 *       not imperative) do NOT.
 */
export function isExplicitNewFileRequest(text: string): boolean {
  return (
    unnegatedMatch(text, [NEW_FILE_MARKER]) ||
    hasCoLocatedUnnegated(text, NEW_FILE_NOUN, NEW_FILE_CREATE_VERB)
  );
}

/**
 * Whether a reply to a pending scope clarification is really a full resend of a code-change request with explicit
 * (non-negated) create wording and at least one safe named path (ADR-0099 D1 QA follow-up). Such a resend is
 * routed as a fresh request instead of the existing-files-only bare-path recovery.
 */
export function isHowToQuestionWithoutTarget(text: string): boolean {
  if (detectHelpIntent(text) === null && !HOW_TO_QUESTION.test(text)) return false;
  const { candidates, unsafe } = extractSafeTargetCandidates(text);
  return candidates.length === 0 && unsafe.length === 0;
}

export function isFreshCreateResend(text: string): boolean {
  return isExplicitNewFileRequest(text) && extractSafeTargetCandidates(text).candidates.length > 0;
}

/**
 * Whether the target-scope reply is {@link ResponseComposer.composeTargetsMissing} — some named paths resolved
 * but others are missing, or several are missing (ADR-0099 D1). That reply asks the owner to resend the WHOLE
 * request (adding create wording for a new file), so it is never anchored as a scope clarification: a bare-path
 * recovery could neither honor the create wording nor take the corrected instruction. A single missing path,
 * an unsafe path, or no path at all keeps the ADR-0037 bare-path clarification.
 */
export function asksForWholeRequestAgain(
  collected: CodeChangeTargetCollection,
): collected is Extract<CodeChangeTargetCollection, { kind: 'missing' }> {
  return collected.kind === 'missing' && (collected.resolved.length > 0 || collected.missing.length > 1);
}

/** Assemble the display-relevant facts for a ran/timed-out `CommandExecution` (ADR-0034). Raw only — no truncation, no text. */
export function toTestResultDetail(exec: CommandExecution): TestResultDetail {
  const kind: 'test' | 'typecheck' = exec.args.includes('typecheck') ? 'typecheck' : 'test';
  return {
    kind,
    command: exec.command,
    args: exec.args,
    durationMs: exec.durationMs,
    stdout: exec.stdout,
    stderr: exec.stderr,
    ...(exec.exitCode !== undefined ? { exitCode: exec.exitCode } : {}),
  };
}
