import {
  logAnchoredApprovalFailure,
} from '../approval-decision-service';
import {
  GitPushBlockedError,
  classifyGitFailure,
} from '../git-manager';
import {
  ApprovalStatus,
  RiskLevel,
  approvalRef,
} from '../../domain';
import type {
  Actor,
  GitCommitResult,
  GitPushResult,
  GitStatus,
  RepositoryInfo,
  InboundMessage,
  Session,
} from '../../domain';
import { normalizeRelativePath } from '../target-scope';
import { isValidCommitMessage } from '../commit-message';
import { isSafePushBranch, isSafePushRemote } from '../push-target';
import {
  newFileCommitCandidates,
  partitionCommitCandidates,
} from '../code-work/code-change-set';
import {
  type PushTargetRefusal,
  checkPushHead,
  resolvePushTarget,
  verifyApprovedPushTarget,
} from '../code-work/push-target-resolution';
import {
  committedSubjectOf,
} from '../code-work/pr-description';
import { ConversationRuntimeApplyLayer } from './apply-layer';
import {
  buildCommitApprovalReason,
  buildPushApprovalReason,
  parsePushUpstream,
  safeRelativePath,
} from './helpers';
import { PROTECTED_COMMIT_BRANCHES } from './intent-words';
import { interpretDecision, interpretPushExecutionIntent, parseCommitMessage } from './turn-intents';
import type { ApplyPreviewAnchor, TurnResult } from './types';

export abstract class ConversationRuntimeGitCommitPushLayer extends ConversationRuntimeApplyLayer {
  /**
   * An explicit git-commit request at WORKSPACE_APPLIED (Sprint 2x, ADR-0045) — PLAN a commit and halt at a
   * HIGH approval. Runs ONLY read-only `git.status` (never `git.diff`); creates a HIGH `ApprovalRequest`;
   * re-anchors `COMMIT_APPROVAL_PENDING`. Performs NO git mutation, CommandExecution, WorkspaceWrite, Patch,
   * CodeGeneration, or ExecutionOrchestrator call. Actual commit execution is a future Sprint 2y.
   */
  protected async handleCommitApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    if (!anchor.workspaceRef || !anchor.executionPlanRef || !anchor.targetFiles.length) {
      return this.failComposed(message, session, this.deps.composer.composeCommitUnavailable(message.context));
    }

    // 1. Commit message: user-provided (validated) else deterministic template. Invalid user msg → ask again.
    const parsed = parseCommitMessage(message.text, anchor.targetFiles);
    if (parsed === 'invalid') {
      return this.respondComposed(message, session, this.deps.composer.composeCommitMessageInvalid(message.context));
    }
    const commitMessage = parsed.message;

    // 2. Read-only git status ONLY (CA #1/#12). A throw → composeCommitStatusUnavailable (a read WAS
    //    attempted — precise wording), NO approval, NO fallback. NEVER git.diff.
    let status: GitStatus;
    try {
      status = await this.deps.git.status(anchor.workspaceRef.rootPath);
    } catch {
      this.logCommitApprovalFailed(session, anchor, 'git status read failed');
      return this.failComposed(message, session, this.deps.composer.composeCommitStatusUnavailable(message.context));
    }

    // 2b. QA-022: Personal v1 never commits on main/master (ADR-0094). Refuse up front, from the branch the
    //     read-only status above already reported, instead of asking for an approval that can only fail at
    //     "커밋 실행". NO approval is created. The composition-root git guard still refuses at execution time
    //     (defense in depth, and the authority for detached/unknown branches).
    if (PROTECTED_COMMIT_BRANCHES.has(status.branch.trim().toLowerCase())) {
      return this.respondComposed(message, session, this.deps.composer.composeCommitProtectedBranch(message.context));
    }

    // 3. Candidate files = changed ∩ targetFiles with defensive path safety (CA #6/#14). Clean → nothing to
    //    commit. Any out-of-scope/unsafe path OR empty in-scope set → bounded warning, NO approval.
    const rawChanged = [...status.staged, ...status.unstaged, ...status.untracked];
    if (rawChanged.length === 0) {
      return this.respondComposed(message, session, this.deps.composer.composeCommitNothingToCommit(message.context));
    }
    const scope = new Set(anchor.targetFiles.map(normalizeRelativePath));
    const inScope: string[] = [];
    const outOfScope: string[] = [];
    for (const raw of rawChanged) {
      const safe = safeRelativePath(raw); // null = absolute / `..` / empty / non-normalizable
      if (safe !== null && scope.has(safe)) inScope.push(safe);
      else outOfScope.push(safe ?? raw); // unsafe paths surfaced as out-of-scope, never trusted/committed
    }
    const candidateFiles = [...new Set(inScope)];
    if (outOfScope.length > 0 || candidateFiles.length === 0) {
      return this.respondComposed(message, session, this.deps.composer.composeCommitOutOfScopeChanges(message.context, outOfScope));
    }

    // 4. Read-only validation context (reused 2w helper) — display only, never blocks (CA #10/Q10).
    const validation = await this.loadValidationContext(anchor);
    // ADR-0099 D3: untracked candidates that are anchored new-file targets are marked as new files.
    const newFiles = newFileCommitCandidates(candidateFiles, anchor, status);

    // 5. Create the HIGH commit ApprovalRequest (CA Constraint 2, #4/#11/Q11). Reason names op/workspace/
    //    bounded candidate files/message/validation + "approval only, actual commit deferred". NO raw diff.
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.HIGH,
      reason: buildCommitApprovalReason(anchor.workspaceRef, candidateFiles, commitMessage, validation, newFiles),
      requestedBy: actor.id,
    });

    // 6. Halt at COMMIT_APPROVAL_PENDING, preserving commit context for the decision turn / Sprint 2y.
    const pendingAnchor: ApplyPreviewAnchor = {
      ...anchor,
      status: 'COMMIT_APPROVAL_PENDING',
      commitApprovalId: approval.id,
      proposedCommitMessage: commitMessage,
      commitCandidateFiles: candidateFiles,
    };
    await this.deps.applyPreviewFlow.anchor(session, pendingAnchor);
    const reply = this.deps.composer.composeCommitApprovalRequested(message.context, {
      candidateFiles,
      commitMessage,
      validation,
      ...(newFiles.length ? { newFiles } : {}),
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply: this.previewWithReference(session, reply, approval, pendingAnchor), sessionId: session.id };
  }

  /**
   * Decide the pending commit approval (Sprint 2x, ADR-0045) — mirrors handleApplyApprovalTurn, with strict
   * guards (CA #2/#3). Approve → record only, re-anchor `COMMIT_APPROVED` (NO git commit — Sprint 2y).
   * Deny/cancel → record REJECTED and REVERT to `WORKSPACE_APPLIED` (clear only commit fields), with a
   * commit-specific reply (CA #9/#11). Never runs git.
   */
  protected async handleCommitApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // (CA #2) strict pending-context integrity guard — a pending commit approval is valid only with COMPLETE
    //  resume context for Sprint 2y. Any missing field → safe failure, NO decide / git / re-anchor.
    const incomplete = this.approvalDecisions.incompleteAnchoredContext(message.context, session, anchor);
    if (incomplete) return this.decisionTurn(session, await incomplete);
    const decision = interpretDecision(message.text);
    if (decision === 'ambiguous') {
      // (CA #13) preserve pending context: re-prompt only; no decide, no new approval, no re-anchor.
      return this.respondAnchoredReminder(
        message,
        session,
        anchor.commitApprovalId!,
        anchor,
        this.deps.composer.composeCommitUnavailable(message.context),
      );
    }
    // ADR-0113 D7: the shared decision path — (CA #3) request re-read, expiry re-check, decide, COMMIT_APPROVED or back
    // to WORKSPACE_APPLIED. Records only; the git commit runs on the exact execution phrase.
    return this.decisionTurn(
      session,
      await this.approvalDecisions.decideAnchored(this.chatDecision(message, session, actor), anchor, decision),
    );
  }

  /** A commit request while the anchor is COMMIT_APPROVED (Sprint 2x) — already approved; not committed. */
  protected async handleCommitAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitAlreadyApproved(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A commit request with no WORKSPACE_APPLIED/COMMIT_APPROVED anchor (Sprint 2x) — no commit flow. */
  protected async handleCommitUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A commit request bundled with push/reset/add/… (Sprint 2x) — commit-approval only; no git ran. */
  protected async handleCommitUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitUnsupportedCompanion(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a commit-approval error (Sprint 2x) — never logs diff/content.
   *  Defensive optional access: this is called from the incomplete-pending-context guard, where a required
   *  field (e.g. `executionPlanRef`) may be missing, so logging must never throw (CA impl review). */
  protected logCommitApprovalFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    logAnchoredApprovalFailure(this.deps.logger, 'commit', session, anchor, reason); // deliberately NO diff text / file content
  }

  /**
   * Execute the approved git commit (Sprint 2y, ADR-0046) — the FIRST real git mutation. Reached ONLY at
   * COMMIT_APPROVED with an explicit commit-EXECUTION phrase (§5.4). Re-verifies the live approval + exact
   * candidate scope against a FRESH `git.status`, then commits exactly the approved files via the Ref-gated
   * `GitManager.commitFiles`. The only `git add` is of the approved untracked candidates that are anchored
   * new-file targets (ADR-0099 D3, passed as `newFiles`); NO push, NO rollback, NO CommandExecution/shell, NO
   * WorkspaceWrite/Patch/CodeGeneration, NO ExecutionOrchestrator. Any other untracked approved candidate is
   * blocked with a DISTINCT reply (CA #1/#2/#3). Any scope drift / stale approval / invalid message → safe failure
   * requiring a NEW approval; no commit. On success → re-anchor GIT_COMMITTED (committed only, NOT pushed).
   */
  protected async handleCommitExecutionTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. (Constraint 3) complete approved context, else safe failure (no commit). Logging never throws.
    if (
      anchor.status !== 'COMMIT_APPROVED' ||
      !anchor.commitApprovalId ||
      !anchor.proposedCommitMessage ||
      !anchor.commitCandidateFiles?.length ||
      !anchor.workspaceRef ||
      !anchor.workspaceChangeRef ||
      !anchor.executionPlanRef
    ) {
      this.logCommitExecutionFailed(session, anchor, 'approved commit context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeCommitExecutionUnavailable(message.context));
    }
    // 2. (Constraint 6) verify the live ApprovalRequest: exists, APPROVED, same plan. Derive the ApprovalRef.
    const request = await this.deps.approvals.get(anchor.commitApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.APPROVED ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logCommitExecutionFailed(session, anchor, 'commit approval not APPROVED/plan-mismatched/missing');
      return this.failComposed(message, session, this.deps.composer.composeCommitExecutionUnavailable(message.context));
    }
    const gitApprovalRef = approvalRef(request);
    // 3. (Constraint 5) approved message still a valid bounded single line, else require a new approval.
    if (!isValidCommitMessage(anchor.proposedCommitMessage)) {
      return this.failComposed(message, session, this.deps.composer.composeCommitExecutionUnavailable(message.context));
    }
    // 4. Re-read git status (Constraint 3). A throw → safe failure, no commit, no fallback.
    let status: GitStatus;
    try {
      status = await this.deps.git.status(anchor.workspaceRef.rootPath);
    } catch {
      this.logCommitExecutionFailed(session, anchor, 'git status read failed');
      return this.failComposed(message, session, this.deps.composer.composeCommitStatusUnavailable(message.context));
    }

    // 5. (Constraints 2/4, Q4/Q5/Q6, CA #2/#11) EXACT-scope re-validation against the FRESH status; sets are
    //    normalized + de-duplicated so a candidate appearing in BOTH staged and unstaged is still eligible.
    //    unavailable() = composeCommitExecutionUnavailable (needs a new approval); untracked() = the DISTINCT
    //    composeCommitExecutionUntrackedUnsupported. Any block → NO commit.
    //    ADR-0099 D3: an untracked candidate is admitted only as one of the anchor's newFileTargets (passed as
    //    `newFiles` for the exact `git add`); every other untracked candidate keeps the distinct reply.
    const partition = partitionCommitCandidates({ candidates: anchor.commitCandidateFiles, scope: anchor, status });
    if (!partition.ok) {
      if (partition.reason === 'untracked-unsupported') {
        this.logCommitExecutionFailed(session, anchor, 'approved candidate is untracked');
        return this.failComposed(message, session, this.deps.composer.composeCommitExecutionUntrackedUnsupported(message.context));
      }
      if (partition.reason === 'scope-drift') {
        this.logCommitExecutionFailed(session, anchor, 'approved commit scope no longer matches working tree');
      }
      return this.failComposed(message, session, this.deps.composer.composeCommitExecutionUnavailable(message.context));
    }
    const safeCandidates = partition.files;
    const candSet = new Set(safeCandidates);

    // 6. Execute the exact-file commit through the Git capability (Ref-gated). A throw → safe failure: NO fake
    //    success, NO push, NO rollback (Q8/CA #10).
    let result: GitCommitResult;
    try {
      result = await this.deps.git.commitFiles({
        rootPath: anchor.workspaceRef.rootPath,
        files: safeCandidates,
        message: anchor.proposedCommitMessage,
        approvalRef: gitApprovalRef,
        ...(partition.newFiles.length ? { newFiles: partition.newFiles } : {}),
      });
    } catch {
      this.logCommitExecutionFailed(session, anchor, 'git commit failed');
      return this.failComposed(message, session, this.deps.composer.composeCommitExecutionFailed(message.context));
    }

    // 7. (CA #8) Result-integrity gate BEFORE trusting the commit: hash non-empty + SHA-shaped; committedFiles
    //    exactly equal the approved candidates; message equals the approved message. Any mismatch → safe
    //    failure, NO GIT_COMMITTED, do not claim committed.
    const sameSet = (a: string[], b: Set<string>): boolean => a.length === b.size && a.every((x) => b.has(x));
    if (
      !/^[0-9a-f]{7,40}$/i.test(result.commitHash) ||
      !sameSet(result.committedFiles.map(normalizeRelativePath), candSet) ||
      result.message !== anchor.proposedCommitMessage
    ) {
      this.logCommitExecutionFailed(session, anchor, 'commit result integrity mismatch');
      return this.failComposed(message, session, this.deps.composer.composeCommitExecutionFailed(message.context));
    }

    // 8. Success → re-anchor GIT_COMMITTED with the hash + committed files. (CA #9) PRESERVE commitApprovalId
    //    (audit/threading) + workspaceRef/workspaceChangeRef/targetFiles/executionPlanRef/postApplyValidationRef
    //    (a future push sprint needs them); clear proposedCommitMessage + commitCandidateFiles (replaced by
    //    committedFiles/hash). Reply: hash + files + no push.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'GIT_COMMITTED',
      commitHash: result.commitHash,
      committedFiles: result.committedFiles,
      // ADR-0108 D2: the approved commit's subject becomes the PR title (result.message == the approved message).
      committedSubject: committedSubjectOf(result.message),
      proposedCommitMessage: undefined,
      commitCandidateFiles: undefined, // commitApprovalId PRESERVED (CA #9)
    });
    const reply = this.deps.composer.composeCommitExecuted(message.context, {
      commitHash: result.commitHash,
      files: result.committedFiles,
      ...(partition.newFiles.length ? { newFiles: partition.newFiles } : {}),
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** An execution phrase while already GIT_COMMITTED (Sprint 2y, Q11) — already committed; no new commit, no
   *  push. Shows the recorded commit hash. */
  protected async handleCommitAlreadyCommittedTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitAlreadyCommitted(message.context, anchor.commitHash);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A push/reset/… companion phrase on a commit-relevant anchor (Sprint 2y) — push is not supported this
   *  sprint; commit only. No git ran, no mutation. */
  protected async handleCommitPushUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitPushUnsupported(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** An explicit commit-execution phrase with no commit-relevant anchor (Sprint 2y) — a new commit approval
   *  is required first; no commit, no git ran. */
  protected async handleCommitExecutionUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitExecutionUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a commit-EXECUTION error (Sprint 2y) — never logs diff/file
   *  content or stderr. Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  protected logCommitExecutionFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('commit execution failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef?.id,
      commitApprovalId: anchor.commitApprovalId,
    }); // deliberately NO diff text / file content / stderr
  }

  /**
   * Plan a git push and halt at a CRITICAL approval (Sprint 2z, ADR-0047) — reached ONLY at GIT_COMMITTED
   * with an explicit push phrase (§5.4). Re-verifies the committed context, then performs read-only
   * `git.info` + `git.status` (no network fetch) to check HEAD == committed hash, a clean tree, a safely-
   * parseable upstream, ahead ≥ 1, not diverged — or, with NO upstream (ADR-0099 D5), a new remote branch on
   * `origin` for the current non-main/master branch (the pure `resolvePushTarget`); creates a CRITICAL
   * `ApprovalRequest`; re-anchors `PUSH_APPROVAL_PENDING` with the resolved `pushMode`. Performs NO `git push`,
   * no CommandExecution/shell, no WorkspaceWrite/Patch/CodeGeneration, no ExecutionOrchestrator call. All facts
   * are point-in-time.
   */
  protected async handlePushApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. (Constraint 2) complete committed context, else safe failure (no approval). Log never throws.
    if (
      anchor.status !== 'GIT_COMMITTED' ||
      !anchor.commitHash ||
      !anchor.committedFiles?.length ||
      !anchor.workspaceRef ||
      !anchor.executionPlanRef
    ) {
      this.logPushApprovalFailed(session, anchor, 'committed context incomplete');
      return this.failComposed(message, session, this.deps.composer.composePushApprovalUnavailable(message.context));
    }
    // 2. (Constraint 8) commitHash SHA-shaped, else safe failure.
    if (!/^[0-9a-f]{7,40}$/i.test(anchor.commitHash)) {
      this.logPushApprovalFailed(session, anchor, 'commitHash not SHA-shaped');
      return this.failComposed(message, session, this.deps.composer.composePushApprovalUnavailable(message.context));
    }
    // 3. Fresh read-only info (Constraint 6/9). A throw → composePushStatusUnavailable, NO approval, NO fallback.
    let info: RepositoryInfo;
    try {
      info = await this.deps.git.info(anchor.workspaceRef.rootPath);
    } catch {
      this.logPushApprovalFailed(session, anchor, 'git info read failed');
      return this.failComposed(message, session, this.deps.composer.composePushStatusUnavailable(message.context));
    }
    // 4. (Constraint 8/Q6, CA #11) detached HEAD OR HEAD ≠ committed hash → no approval, new review needed.
    if (!checkPushHead(info, anchor.commitHash).ok) {
      this.logPushApprovalFailed(session, anchor, 'HEAD detached or differs from committed hash');
      return this.failComposed(message, session, this.deps.composer.composePushHeadMovedUnavailable(message.context));
    }
    // 5. Fresh read-only status. A throw → composePushStatusUnavailable.
    let status: GitStatus;
    try {
      status = await this.deps.git.status(anchor.workspaceRef.rootPath);
    } catch {
      this.logPushApprovalFailed(session, anchor, 'git status read failed');
      return this.failComposed(message, session, this.deps.composer.composePushStatusUnavailable(message.context));
    }
    // 6–8. (ADR-0099 D5) the pure push-target resolver: clean tree (CA #10), then either the ADR-0047 upstream
    //    mode (upstream parses to <remote>/<branch>, ahead ≥ 1, behind = 0 — never a user-provided target) or, with
    //    no upstream, the new-remote-branch mode (fixed `origin` + the CURRENT branch, never main/master, push-safe
    //    name). Point-in-time; re-verified against the approved target before any future push.
    const resolution = resolvePushTarget({ info, status, committedHash: anchor.commitHash });
    if (!resolution.ok) {
      return this.respondPushTargetRefusal(message, session, anchor, resolution.reason, 'approval');
    }
    const target = resolution.target;
    const newRemoteBranch = target.mode === 'new-remote-branch';
    // 8b. (ADR-0109 D2) the project's origin must resolve to one allowlisted repository — otherwise no approval.
    //     The ACTUAL push target is checked: `origin` and the remote the push will use (an upstream's remote).
    const pushApprovalGate = await this.remoteRepositoryGate(
      message,
      session,
      anchor.workspaceRef.rootPath,
      { remote: target.remote },
      () => this.failComposed(message, session, this.deps.composer.composePushApprovalUnavailable(message.context)),
    );
    if (pushApprovalGate.reply) return pushApprovalGate.reply;
    const pushRepositoryIdentity = pushApprovalGate.identity;

    // 9. Create the CRITICAL push ApprovalRequest (Constraint 4). Reason = bounded op/commit/mode/remote/branch/
    //    upstream/ahead + no-push + permission-only + future-step + point-in-time (CA #4/#6/#7).
    //    NO diff/file content; NO validation/test context (CA #13). HEAD == commit & ahead ≥ 1 ⇒ the
    //    committed hash is the tip of the ahead range (Constraint 8).
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.CRITICAL,
      reason: buildPushApprovalReason({
        commitHash: anchor.commitHash,
        remote: target.remote,
        branch: target.branch,
        upstream: target.upstreamRef,
        ...(target.ahead !== undefined ? { ahead: target.ahead } : {}),
        mode: target.mode,
        ...(pushRepositoryIdentity ? { repository: pushRepositoryIdentity } : {}),
      }),
      requestedBy: actor.id,
    });

    // 10. Halt at PUSH_APPROVAL_PENDING, preserving distinct push context + all commit context.
    const pendingAnchor: ApplyPreviewAnchor = {
      ...anchor,
      status: 'PUSH_APPROVAL_PENDING',
      pushApprovalId: approval.id,
      pushCommitHash: anchor.commitHash,
      pushRemote: target.remote,
      pushBranch: target.branch,
      pushUpstreamRef: target.upstreamRef,
      pushMode: target.mode,
      // ADR-0109: the repository this approval covers; execution refuses (target changed) if it resolves differently.
      ...(pushRepositoryIdentity ? { pushRepositoryIdentity: { ...pushRepositoryIdentity } } : {}),
    };
    await this.deps.applyPreviewFlow.anchor(session, pendingAnchor);
    const reply = newRemoteBranch
      ? this.deps.composer.composePushApprovalRequested(message.context, {
          commitHash: anchor.commitHash,
          remote: target.remote,
          branch: target.branch,
          upstream: target.upstreamRef,
          ahead: 0,
          newRemoteBranch: true,
        })
      : this.deps.composer.composePushApprovalRequested(message.context, {
          commitHash: anchor.commitHash,
          remote: target.remote,
          branch: target.branch,
          upstream: target.upstreamRef,
          ahead: target.ahead ?? 0,
        });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply: this.previewWithReference(session, reply, approval, pendingAnchor), sessionId: session.id };
  }

  /**
   * Decide the pending push approval (Sprint 2z, ADR-0047) — mirrors handleCommitApprovalDecisionTurn with
   * strict guards (CA #3/#9). Approve → record only, re-anchor `PUSH_APPROVED` PRESERVING all push + commit
   * context (CA #8). Deny/cancel → record REJECTED and REVERT to `GIT_COMMITTED` clearing ONLY push fields.
   * A push/force/deploy phrase is ambiguous → re-prompt (never routed to unsupported-companion while
   * pending). NEVER runs git push.
   */
  protected async handlePushApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // (CA #9) strict pending-context integrity guard — any missing field → safe failure, NO decide/git/re-anchor.
    const incomplete = this.approvalDecisions.incompleteAnchoredContext(message.context, session, anchor);
    if (incomplete) return this.decisionTurn(session, await incomplete);
    // (Sprint 3a, ADR-0048) A push-EXECUTION phrase ("승인된 push 실행해줘" — note the "승인" substring) or a
    // push+forbidden phrase is a premature push request while approval is still PENDING, NOT a clean approve
    // of THIS approval. Classify it ambiguous so it re-prompts (matching the 2z push-phrase intent above)
    // instead of auto-approving on the "승인" substring; a bare "승인"/"거절"/"취소" still decides normally.
    const decision =
      interpretPushExecutionIntent(message.text) !== null
        ? 'ambiguous'
        : interpretDecision(message.text);
    if (decision === 'ambiguous') {
      // (CA #3) push/force/deploy phrases land here too (not approve/deny/cancel) → re-prompt, preserve
      // context; no decide, no new approval, no re-anchor, no push.
      return this.respondAnchoredReminder(
        message,
        session,
        anchor.pushApprovalId!,
        anchor,
        this.deps.composer.composePushApprovalUnavailable(message.context),
      );
    }
    // ADR-0113 D7: the shared decision path — (CA #9) request re-read, expiry re-check, decide, PUSH_APPROVED or back to
    // GIT_COMMITTED. Records only; NO git push.
    return this.decisionTurn(
      session,
      await this.approvalDecisions.decideAnchored(this.chatDecision(message, session, actor), anchor, decision),
    );
  }

  /** A push phrase while already PUSH_APPROVED (Sprint 2z) — already approved; not pushed, no new approval. */
  protected async handlePushAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePushAlreadyApproved(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A push request with no commit chain in progress (QA-V2-W8) — fixed reply; no approval, no git. */
  protected async handleNoPushTargetTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeNoPushTarget(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A push bundled with force/PR/deploy/tag/branch/… on GIT_COMMITTED or PUSH_APPROVED (Sprint 2z) — push
   *  approval only; those companions are not supported; no approval, no git. */
  protected async handlePushUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePushUnsupportedCompanion(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /**
   * The fixed reply for a push-target refusal from the pure resolver (ADR-0099 D5), keeping each ADR-0047/0048
   * reason's existing copy: a dirty tree, nothing to push and diverged are plain replies; a missing/unparseable
   * upstream keeps the no-upstream reply at approval; a protected or unsafe branch gets its own reply at approval;
   * every execution-time drift (and any HEAD change) is the pre-push "not available — approve again" failure.
   */
  protected respondPushTargetRefusal(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
    reason: PushTargetRefusal,
    phase: 'approval' | 'execution',
  ): Promise<TurnResult> {
    const composer = this.deps.composer;
    const ctx = message.context;
    switch (reason) {
      case 'dirty':
        return this.respondComposed(message, session, composer.composePushDirtyWorkingTree(ctx));
      case 'nothing-to-push':
        return this.respondComposed(message, session, composer.composePushNothingToPush(ctx));
      case 'diverged':
        return this.respondComposed(message, session, composer.composePushDiverged(ctx));
      default:
        break;
    }
    if (phase === 'approval') {
      switch (reason) {
        case 'no-upstream':
          return this.respondComposed(message, session, composer.composePushNoUpstream(ctx));
        case 'protected-branch':
          return this.respondComposed(message, session, composer.composePushProtectedBranch(ctx));
        case 'unsafe-name':
          return this.respondComposed(message, session, composer.composePushBranchNameUnsafe(ctx));
        case 'detached':
        case 'head-moved':
          this.logPushApprovalFailed(session, anchor, 'HEAD detached or differs from committed hash');
          return this.failComposed(message, session, composer.composePushHeadMovedUnavailable(ctx));
        default:
          this.logPushApprovalFailed(session, anchor, `push target refused: ${reason}`);
          return this.failComposed(message, session, composer.composePushApprovalUnavailable(ctx));
      }
    }
    this.logPushExecutionFailed(session, anchor, `push target drifted from the approved target: ${reason}`);
    return this.failComposed(message, session, composer.composePushExecutionUnavailable(ctx));
  }

  /** Structured, no-content failure log for a push-approval error (Sprint 2z) — never logs diff/file content.
   *  Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  protected logPushApprovalFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    logAnchoredApprovalFailure(this.deps.logger, 'push', session, anchor, reason); // deliberately NO diff text / file content
  }

  /**
   * Execute the approved git push (Sprint 3a, ADR-0048) — the FIRST real remote mutation. Reached ONLY at
   * PUSH_APPROVED with an explicit push-execution phrase (§5.6). Re-verifies the live approval + the
   * persisted approved target, re-reads `git.info` + `git.status`, and re-validates HEAD/upstream/ahead/
   * behind/clean-tree against the approved snapshot (ADR-0099 D5 `verifyApprovedPushTarget`: same mode and target;
   * a new-remote-branch approval still on its branch with no upstream or exactly `origin/<branch>`), then pushes
   * the exact approved commit to the exact approved upstream via the Ref-gated `GitManager.pushApprovedCommit`. NO force, NO PR, NO deploy, NO
   * rollback, NO CommandExecution/shell, NO WorkspaceWrite/Patch/CodeGeneration, NO ExecutionOrchestrator.
   * Remote-mutation safety (CA #2/#10/#11): a pre-push failure may say push was not attempted; a provider
   * failure never claims the remote is unchanged; a result-integrity mismatch after a reported success says
   * the push could not be verified — and neither re-anchors GIT_PUSHED nor rolls back.
   */
  protected async handlePushExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. Complete approved push context, else safe failure (pre-push, no push). Log never throws.
    if (
      anchor.status !== 'PUSH_APPROVED' ||
      !anchor.pushApprovalId ||
      !anchor.pushCommitHash ||
      !anchor.pushRemote ||
      !anchor.pushBranch ||
      !anchor.pushUpstreamRef ||
      !anchor.commitHash ||
      !anchor.workspaceRef ||
      !anchor.executionPlanRef
    ) {
      this.logPushExecutionFailed(session, anchor, 'approved push context incomplete');
      return this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context));
    }
    // 2. (CA #3) safe persisted target strings — a malformed anchor fails BEFORE any mutation attempt.
    const parsedApproved = parsePushUpstream(anchor.pushUpstreamRef);
    if (
      !isSafePushRemote(anchor.pushRemote) ||
      !isSafePushBranch(anchor.pushBranch) ||
      !parsedApproved ||
      parsedApproved.remote !== anchor.pushRemote ||
      parsedApproved.branch !== anchor.pushBranch ||
      !/^[0-9a-f]{7,40}$/i.test(anchor.pushCommitHash) ||
      !/^[0-9a-f]{7,40}$/i.test(anchor.commitHash)
    ) {
      this.logPushExecutionFailed(session, anchor, 'persisted approved push target unsafe/malformed');
      return this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context));
    }
    // 3. (Constraint 4) live approval APPROVED + same plan → derive the ApprovalRef.
    const request = await this.deps.approvals.get(anchor.pushApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.APPROVED ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPushExecutionFailed(session, anchor, 'push approval not APPROVED/plan-mismatched/missing');
      return this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context));
    }
    const gitApprovalRef = approvalRef(request);
    // 4. Fresh read-only info (Constraint 3). Throw → composePushStatusUnavailable (pre-push, not attempted).
    //    (CA #6) info.branch is used ONLY for detached detection + logging, never as the push target.
    let info: RepositoryInfo;
    try {
      info = await this.deps.git.info(anchor.workspaceRef.rootPath);
    } catch {
      this.logPushExecutionFailed(session, anchor, 'git info read failed');
      return this.failComposed(message, session, this.deps.composer.composePushStatusUnavailable(message.context));
    }
    // 5. (Q5/Q6) not detached AND HEAD == pushCommitHash == commitHash — else the committed state changed.
    if (!checkPushHead(info, anchor.pushCommitHash).ok || anchor.commitHash !== anchor.pushCommitHash) {
      this.logPushExecutionFailed(session, anchor, 'HEAD detached or differs from approved commit');
      return this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context));
    }
    // 6. Fresh read-only status. Throw → composePushStatusUnavailable.
    let status: GitStatus;
    try {
      status = await this.deps.git.status(anchor.workspaceRef.rootPath);
    } catch {
      this.logPushExecutionFailed(session, anchor, 'git status read failed');
      return this.failComposed(message, session, this.deps.composer.composePushStatusUnavailable(message.context));
    }
    // 7–9. (ADR-0099 D5 drift checks, the same pure resolver as approval) clean tree (Q9); the live target must be
    //    the APPROVED one in the APPROVED mode — upstream mode: the upstream still parses and equals the approved
    //    remote/branch/upstream (Q6); new-remote-branch mode: still on the approved branch, upstream absent or exactly
    //    the synthesized `origin/<branch>`; then ahead ≥ 1 / behind = 0 against any upstream (Q7/Q8).
    const verified = verifyApprovedPushTarget({
      info,
      status,
      approved: {
        mode: anchor.pushMode,
        remote: anchor.pushRemote,
        branch: anchor.pushBranch,
        upstreamRef: anchor.pushUpstreamRef,
        commitHash: anchor.pushCommitHash,
      },
    });
    if (!verified.ok) {
      return this.respondPushTargetRefusal(message, session, anchor, verified.reason, 'execution');
    }
    // 9b. (ADR-0109 D2) re-resolve the project's repository right before the push: refused → no push, no token.
    //     The approval's bound repository must still be the one the push remote (and origin) resolve to.
    const pushExecutionGate = await this.remoteRepositoryGate(
      message,
      session,
      anchor.workspaceRef.rootPath,
      { remote: anchor.pushRemote, ...(anchor.pushRepositoryIdentity ? { bound: anchor.pushRepositoryIdentity } : {}), requireBound: true },
      () => this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context)),
    );
    if (pushExecutionGate.reply) return pushExecutionGate.reply;

    // 10. (first REMOTE mutation) push the exact approved target through the Ref-gated capability. A throw →
    //     composePushExecutionFailed (could-not-complete / check remote / NO rollback; never "remote
    //     unchanged"). KEEP PUSH_APPROVED, preserve context, NO GIT_PUSHED (CA #2/#11).
    let result: GitPushResult;
    try {
      // ADR-0122 D2.5: the live grant is re-read as the last statement before this external call (after every awaited
      // preflight above), so a revoke that landed during them wins.
      const surfaceRevoked = await this.surfaceRecheckBeforeCall(message, session, actor, 'push');
      if (surfaceRevoked) return surfaceRevoked;
      result = await this.deps.git.pushApprovedCommit({
        rootPath: anchor.workspaceRef.rootPath,
        remote: anchor.pushRemote,
        branch: anchor.pushBranch,
        commitHash: anchor.pushCommitHash,
        approvalRef: gitApprovalRef,
        // ADR-0109 review P1: the APPROVED identity (never the fresh lookup) travels to the git provider, which
        // pushes to that repository only and refuses TARGET_CHANGED if the workspace now resolves elsewhere.
        ...(pushExecutionGate.identity && anchor.pushRepositoryIdentity
          ? { repository: { ...anchor.pushRepositoryIdentity } }
          : {}),
      });
    } catch (err) {
      // (ADR-0061, Sprint 4b) A GitPushBlockedError is an App-auth PRE-mutation failure (token mint / one-shot
      // GIT_ASKPASS creation / HTTPS github.com remote preflight): the push was never attempted → "not pushed"
      // (composePushExecutionUnavailable). Any OTHER throw stays the conservative could-not-complete / check-remote
      // reply (never claims "not pushed"). Both keep PUSH_APPROVED and never set GIT_PUSHED (CA #2/#11).
      if (err instanceof GitPushBlockedError) {
        this.logPushExecutionFailed(session, anchor, 'git push blocked pre-mutation (App-auth credential/remote preflight)', err);
        // ADR-0109: the provider's final pre-spawn check found the workspace resolving to another repository.
        if (err.reason === 'TARGET_CHANGED') {
          return this.failComposed(message, session, this.deps.composer.composeRepositoryTargetChanged(message.context));
        }
        return this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context));
      }
      this.logPushExecutionFailed(session, anchor, 'git push failed', err);
      // A timed-out push may or may not have reached the remote (at/after-mutation → Unverified, never "not pushed").
      const timedOut = classifyGitFailure(err) === 'timeout';
      return this.failComposed(
        message,
        session,
        timedOut
          ? this.deps.composer.composePushExecutionTimedOut(message.context)
          : this.deps.composer.composePushExecutionFailed(message.context),
      );
    }

    // 11. (Constraint 9/10, CA #10) result-integrity gate. On mismatch AFTER a reported success → do NOT
    //     claim not-pushed, do NOT rollback, do NOT set GIT_PUSHED → composePushResultUnverified. KEEP
    //     PUSH_APPROVED, preserve context.
    if (
      result.remote !== anchor.pushRemote ||
      result.branch !== anchor.pushBranch ||
      result.upstreamRef !== anchor.pushUpstreamRef ||
      result.commitHash !== anchor.pushCommitHash
    ) {
      this.logPushExecutionFailed(session, anchor, 'push result integrity mismatch');
      return this.failComposed(message, session, this.deps.composer.composePushResultUnverified(message.context));
    }

    // 12. (Q12, CA #12) success → re-anchor GIT_PUSHED, store the pushed target, preserve full audit context.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'GIT_PUSHED',
      pushedCommitHash: result.commitHash,
      pushedRemote: result.remote,
      pushedBranch: result.branch,
      pushedUpstreamRef: result.upstreamRef,
    });
    const reply = this.deps.composer.composePushExecuted(message.context, {
      commitHash: result.commitHash,
      remote: result.remote,
      branch: result.branch,
      // ADR-0099 D5: a first push to a branch without an upstream says the remote branch was created.
      ...(verified.target.mode === 'new-remote-branch' ? { newRemoteBranch: true } : {}),
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A push/execution phrase while already GIT_PUSHED (Sprint 3a, Q13/CA #7) — already pushed; no new push. */
  protected async handlePushAlreadyPushedTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const reply = this.deps.composer.composePushAlreadyPushed(message.context, {
      commitHash: anchor.pushedCommitHash,
      remote: anchor.pushedRemote,
      branch: anchor.pushedBranch,
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A PR/deploy phrase while GIT_PUSHED (Sprint 3a, Q14/CA #13) — already pushed; PR/deploy is a future
   *  sprint; no PR, no deployment. */
  protected async handlePushPrDeployUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePushPrDeployUnsupported(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a push-EXECUTION error (Sprint 3a) — never logs diff/file
   *  content or stderr. Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  protected logPushExecutionFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string, err?: unknown): void {
    this.deps.logger.warn('push execution failed', {
      reason,
      ...(err !== undefined ? { reasonClass: classifyGitFailure(err) } : {}),
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef?.id,
      pushApprovalId: anchor.pushApprovalId,
    }); // deliberately NO diff text / file content / stderr
  }
}
