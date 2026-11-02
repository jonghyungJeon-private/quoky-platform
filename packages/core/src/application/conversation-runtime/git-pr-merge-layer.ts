import {
  logAnchoredApprovalFailure,
} from '../approval-decision-service';
import { RepositoryHostingBlockedError } from '../repository-hosting-manager';
import { RemoteBranchCleanupBlockedError, RemoteBranchCleanupUnverifiedError } from '../../domain';
import {
  BranchCleanupBlockedError,
  BranchCleanupUnverifiedError,
  GitMainSyncBlockedError,
  GitMainSyncUnverifiedError,
} from '../git-manager';
import {
  ApprovalStatus,
  RiskLevel,
  approvalRef,
  pullRequestRef,
} from '../../domain';
import type {
  Actor,
  GitBranchCleanupResult,
  GitMainSyncResult,
  InboundMessage,
  PullRequestMergeResult,
  PullRequestResult,
  PullRequestStatusPreview,
  RemoteBranchCleanupResult,
  Session,
} from '../../domain';
import { now } from '../../util/clock';
import { isSafePushBranch, isSafePushRemote } from '../push-target';
import {
  buildDeterministicPrDescription,
  prDescriptionContentHash,
} from '../code-work/pr-description';
import { ConversationRuntimeGitCommitPushLayer } from './git-commit-push-layer';
import {
  buildMergeApprovalReason,
  buildPrApprovalReason,
  buildRemoteBranchCleanupApprovalReason,
  parsePushUpstream,
} from './helpers';
import { DEPLOY_ONLY_WORDS, MAIN_SYNC_REMOTE, PR_BASE_BRANCH_POLICY } from './intent-words';
import {
  interpretDecision,
  interpretMergeIntent,
  interpretPrIntent,
  interpretPrStatusIntent,
  interpretRemoteBranchCleanupExecutionIntent,
  interpretRemoteBranchCleanupIntent,
} from './turn-intents';
import type { ApplyPreviewAnchor, TurnResult } from './types';

export abstract class ConversationRuntimeGitPrMergeLayer extends ConversationRuntimeGitCommitPushLayer {
  /**
   * A PR-creation phrase while GIT_PUSHED (Sprint 3b, ADR-0049) — records a CRITICAL PR-creation approval.
   * Verify pushed context + safe target, derive deterministic head/base/title/body, create the approval,
   * halt at PR_APPROVAL_PENDING. NO Pull Request is created; NO GitHub API; NO fresh Git read (the pushed
   * anchor is the source of truth — CA #12). NO deploy/merge/branch/release.
   */
  protected async handlePrApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 0. (Sprint 3d-D, CA change 9) PR approval now binds the target repository identity — approving a PR
    //    without a configured target repo is no longer meaningful. If identity is missing/invalid, do NOT
    //    create PR_APPROVAL_PENDING or an ApprovalRequest — respond "not configured". (Token NOT needed here.)
    //    ADR-0109 D2: with the per-workspace resolver the identity is the project's allowlisted origin repository.
    //    The PR must target the repository the push was approved for (when the push bound one).
    const prIdentity = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.pushedRemote && isSafePushRemote(anchor.pushedRemote) ? { remote: anchor.pushedRemote } : {}),
      ...(anchor.pushRepositoryIdentity ? { bound: anchor.pushRepositoryIdentity } : {}),
    });
    if (!prIdentity.ok) {
      return this.respondHostingLookupFailure(message, session, prIdentity, () =>
        this.respondComposed(message, session, this.deps.composer.composePrCreationNotConfigured(message.context)),
      );
    }
    const identity = prIdentity.identity;
    // 1. (Constraint 9/CA #14) complete + safe pushed context, else composePrApprovalUnavailable (no approval).
    //    Log never throws (2x lesson — optional field access).
    const parsed = anchor.pushedUpstreamRef ? parsePushUpstream(anchor.pushedUpstreamRef) : null;
    if (
      anchor.status !== 'GIT_PUSHED' ||
      !anchor.pushedCommitHash ||
      !/^[0-9a-f]{7,40}$/i.test(anchor.pushedCommitHash) ||
      anchor.pushedCommitHash !== anchor.pushCommitHash ||
      anchor.pushedCommitHash !== anchor.commitHash ||
      !anchor.pushedRemote ||
      !isSafePushRemote(anchor.pushedRemote) ||
      !anchor.pushedBranch ||
      !isSafePushBranch(anchor.pushedBranch) ||
      !anchor.pushedUpstreamRef ||
      !parsed ||
      parsed.remote !== anchor.pushedRemote ||
      parsed.branch !== anchor.pushedBranch ||
      !anchor.workspaceRef ||
      !anchor.executionPlanRef
    ) {
      this.logPrApprovalFailed(session, anchor, 'pushed context incomplete/unsafe for PR approval');
      return this.failComposed(message, session, this.deps.composer.composePrApprovalUnavailable(message.context));
    }
    // 2. Deterministic PR target (CA #6/#7). base = fixed policy; head = pushed branch (already safe).
    const headBranch = anchor.pushedBranch;
    const baseBranch = PR_BASE_BRANCH_POLICY;
    // 3. (Q8/CA #10) head == base → product/base-policy limitation, NOT a Git error; NO approval.
    if (headBranch === baseBranch) {
      return this.respondComposed(message, session, this.deps.composer.composePrHeadEqualsBaseUnavailable(message.context));
    }
    // 4. Deterministic title/body (ADR-0108 D2/D3): the title is the approved commit's subject (never the
    //    instruction text); the body lists the commit, head→base and the committed paths. The preview below shows
    //    exactly this text and the approval binds it by hash (D5). No model proposal (D4 flag off by default).
    const description = buildDeterministicPrDescription({
      committedSubject: anchor.committedSubject,
      commitHash: anchor.pushedCommitHash,
      committedFiles: anchor.committedFiles ?? [],
      headBranch,
      baseBranch,
    });
    const { title, body } = description;
    // 5. Create the CRITICAL PR-creation ApprovalRequest — the ONLY effect. NO PR creation, NO GitHub API.
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.CRITICAL,
      reason: buildPrApprovalReason({
        pushedCommitHash: anchor.pushedCommitHash,
        headBranch,
        baseBranch,
        title,
        contentHash: description.contentHash,
        owner: identity.owner,
        repo: identity.repo,
      }),
      requestedBy: actor.id,
    });
    // 6. Halt at PR_APPROVAL_PENDING, preserving ALL pushed/commit/workspace context + distinct PR context +
    //    the approved repository identity (Sprint 3d-D).
    const pendingAnchor: ApplyPreviewAnchor = {
      ...anchor,
      status: 'PR_APPROVAL_PENDING',
      prApprovalId: approval.id,
      prPushedCommitHash: anchor.pushedCommitHash,
      prHeadBranch: headBranch,
      prBaseBranch: baseBranch,
      prTitle: title,
      prBody: body,
      prContentHash: description.contentHash,
      repositoryIdentity: { provider: identity.provider, owner: identity.owner, repo: identity.repo },
    };
    await this.deps.applyPreviewFlow.anchor(session, pendingAnchor);
    const reply = this.deps.composer.composePrApprovalRequested(message.context, {
      pushedCommitHash: anchor.pushedCommitHash,
      headBranch,
      baseBranch,
      title,
      body,
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply: this.previewWithReference(session, reply, approval, pendingAnchor), sessionId: session.id };
  }

  /**
   * Decide the pending PR-creation approval (Sprint 3b, ADR-0049) — mirrors handlePushApprovalDecisionTurn
   * with strict guards (CA #7/#14). A PR-creation / PR+forbidden / deploy-only phrase is a premature request
   * → ambiguous re-prompt (no decide, no PR). Approve → record only, re-anchor PR_APPROVED PRESERVING all
   * context (CA #16). Deny/cancel → revert to GIT_PUSHED clearing ONLY PR fields (CA #15). NEVER creates a PR.
   */
  protected async handlePrApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 0. (CA #14) strict pending-context guard — any missing field → safe failure, NO decide/re-anchor.
    const incomplete = this.approvalDecisions.incompleteAnchoredContext(message.context, session, anchor);
    if (incomplete) return this.decisionTurn(session, await incomplete);
    // 1. (CA #7) a PR-creation / PR+forbidden phrase — or any deploy-only phrase — is a premature request
    //    while PENDING, NOT a clean approve → classify ambiguous → re-prompt; NO decide, NO PR.
    const decision =
      interpretPrIntent(message.text) !== null || DEPLOY_ONLY_WORDS.test(message.text)
        ? 'ambiguous'
        : interpretDecision(message.text);
    if (decision === 'ambiguous') {
      return this.respondAnchoredReminder(
        message,
        session,
        anchor.prApprovalId!,
        anchor,
        this.deps.composer.composePrApprovalUnavailable(message.context),
      );
    }
    // 2. ADR-0113 D7: the shared decision path — (CA #14) request re-read, expiry re-check, decide, PR_APPROVED or back
    //    to GIT_PUSHED. Records only; NO PR creation.
    return this.decisionTurn(
      session,
      await this.approvalDecisions.decideAnchored(this.chatDecision(message, session, actor), anchor, decision),
    );
  }

  /**
   * Actual PR creation execution (Sprint 3d-D, ADR-0054) — from a live PR_APPROVED anchor + an explicit PR
   * create/open phrase. Verifies the live approval + PR/pushed/identity context (STRUCTURED fields only, never
   * parsing ApprovalRequest.reason), then calls `RepositoryHostingManager.createPullRequest` — the manager (not
   * the runtime) owns provider.kind/repo/branch/find/reuse/create/result-integrity. Runtime NEVER calls the
   * provider directly and receives NO token. Success → re-anchor PR_CREATED; failures keep PR_APPROVED (a
   * blocked-pre-mutation failure says "PR not created"; a post-attempt UNVERIFIED failure must not).
   */
  protected async handlePrCreationExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    void actor;
    const manager = this.deps.repositoryHosting?.manager;
    // Not configured: no resolved identity OR no manager (missing GitHub token) — safe not-configured, no call.
    if (!manager) {
      return this.respondComposed(message, session, this.deps.composer.composePrCreationNotConfigured(message.context));
    }
    const lookup = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.repositoryIdentity ? { bound: anchor.repositoryIdentity } : {}),
    });
    if (!lookup.ok) {
      return this.respondHostingLookupFailure(message, session, lookup, () =>
        this.respondComposed(message, session, this.deps.composer.composePrCreationNotConfigured(message.context)),
      );
    }
    const identity = lookup.identity;
    // Complete PR_APPROVED context, incl. the approved repositoryIdentity (CA change 1). Missing → safe failure.
    if (
      anchor.status !== 'PR_APPROVED' ||
      !anchor.prApprovalId ||
      !anchor.prPushedCommitHash ||
      !anchor.prHeadBranch ||
      !anchor.prBaseBranch ||
      !anchor.prTitle ||
      !anchor.workspaceRef ||
      !anchor.executionPlanRef ||
      !anchor.repositoryIdentity
    ) {
      this.logPrApprovalFailed(session, anchor, 'PR execution context incomplete');
      return this.failComposed(message, session, this.deps.composer.composePrCreationUnavailable(message.context));
    }
    // Resolved identity must EXACTLY match the identity approved at PR-approval time (CA change 1).
    if (
      anchor.repositoryIdentity.provider !== identity.provider ||
      anchor.repositoryIdentity.owner !== identity.owner ||
      anchor.repositoryIdentity.repo !== identity.repo
    ) {
      this.logPrApprovalFailed(session, anchor, 'resolved identity does not match approved identity');
      return this.failComposed(message, session, this.deps.composer.composePrCreationUnavailable(message.context));
    }
    // Verify the live approval via STRUCTURED fields + ApprovalRef only — never parse reason text (CA change 2).
    const request = await this.deps.approvals.get(anchor.prApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.APPROVED ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPrApprovalFailed(session, anchor, 'PR approval missing/not-approved/plan-mismatch');
      return this.failComposed(message, session, this.deps.composer.composePrCreationUnavailable(message.context));
    }
    // PR context must still match the pushed context exactly (no fresh Git read — Q14).
    if (
      !/^[0-9a-f]{7,40}$/i.test(anchor.prPushedCommitHash) ||
      anchor.prPushedCommitHash !== anchor.pushedCommitHash ||
      anchor.prPushedCommitHash !== anchor.pushCommitHash ||
      anchor.prPushedCommitHash !== anchor.commitHash ||
      anchor.prHeadBranch !== anchor.pushedBranch ||
      anchor.prBaseBranch !== PR_BASE_BRANCH_POLICY
    ) {
      this.logPrApprovalFailed(session, anchor, 'PR context mismatch');
      return this.failComposed(message, session, this.deps.composer.composePrCreationUnavailable(message.context));
    }
    // ADR-0108 D5: the PR uses EXACTLY the approved title and body. Re-hash the stored text; a missing body/hash
    // (e.g. an anchor approved before ADR-0108) or any mismatch creates NO PR, releases the PR approval context
    // back to GIT_PUSHED (like a denial) and asks for a fresh PR request. The manager owns hosting checks.
    const title = anchor.prTitle;
    const body = anchor.prBody;
    if (
      typeof body !== 'string' ||
      !anchor.prContentHash ||
      prDescriptionContentHash(title, body) !== anchor.prContentHash
    ) {
      this.logPrApprovalFailed(session, anchor, 'approved PR title/body hash mismatch');
      await this.deps.applyPreviewFlow.anchor(session, {
        ...anchor,
        status: 'GIT_PUSHED',
        prApprovalId: undefined,
        prPushedCommitHash: undefined,
        prHeadBranch: undefined,
        prBaseBranch: undefined,
        prTitle: undefined,
        prBody: undefined,
        prContentHash: undefined,
        repositoryIdentity: undefined,
      });
      return this.failComposed(message, session, this.deps.composer.composePrDescriptionMismatch(message.context));
    }
    let result: PullRequestResult;
    try {
      // ADR-0122 D2.5: the live grant is re-read as the last statement before this external call (after every awaited
      // preflight above), so a revoke that landed during them wins.
      const surfaceRevoked = await this.surfaceRecheckBeforeCall(message, session, actor, 'pr-create');
      if (surfaceRevoked) return surfaceRevoked;
      result = await manager.createPullRequest({
        identity,
        headBranch: anchor.prHeadBranch,
        baseBranch: anchor.prBaseBranch,
        title,
        body,
        expectedCommitHash: anchor.prPushedCommitHash,
        approvalRef: approvalRef(request),
      });
    } catch (err) {
      // First remote mutation — fail SAFE. Only a KNOWN pre-mutation BlockedError may say "PR was not created";
      // a known post-attempt UnverifiedError AND any unknown generic/non-Error throw are treated as UNVERIFIED
      // (the POST may have reached the provider), so we never overclaim no PR (CA 3d-D impl review). Keep
      // PR_APPROVED on every failure path.
      if (err instanceof RepositoryHostingBlockedError) {
        this.logPrApprovalFailed(session, anchor, 'PR creation blocked before mutation');
        return this.failComposed(message, session, this.deps.composer.composePrCreationBlocked(message.context));
      }
      this.logPrApprovalFailed(session, anchor, 'PR creation unverified (mutation ambiguity)');
      return this.failComposed(message, session, this.deps.composer.composePrCreationUnverified(message.context));
    }
    // Success → re-anchor PR_CREATED, preserving the full causal chain + PR result (CA change 8).
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'PR_CREATED',
      pullRequestRef: pullRequestRef(result),
      pullRequestNumber: result.pullRequestNumber,
      pullRequestUrl: result.pullRequestUrl,
      pullRequestHeadBranch: result.pullRequestHeadBranch,
      pullRequestBaseBranch: result.pullRequestBaseBranch,
      pullRequestCommitHash: result.pullRequestCommitHash,
      pullRequestReused: result.reused,
    });
    const view = {
      owner: result.owner,
      repo: result.repo,
      headBranch: result.pullRequestHeadBranch,
      baseBranch: result.pullRequestBaseBranch,
      commitHash: result.pullRequestCommitHash,
      prNumber: result.pullRequestNumber,
      prUrl: result.pullRequestUrl,
    };
    const reply = result.reused
      ? this.deps.composer.composePrCreatedReusedExisting(message.context, view)
      : this.deps.composer.composePrCreated(message.context, view);
    return this.respondComposed(message, session, reply);
  }

  /** A PR create/open phrase while already PR_CREATED (Sprint 3d-D) — already created; returns the PR URL; no
   *  new manager/provider call. */
  protected async handlePrAlreadyCreatedTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const reply = this.deps.composer.composePrAlreadyCreated(message.context, {
      prNumber: anchor.pullRequestNumber ?? 0,
      prUrl: anchor.pullRequestUrl ?? '',
    });
    return this.respondComposed(message, session, reply);
  }

  /** A deploy/merge/release/companion phrase while PR_CREATED (Sprint 3d-D) — unsupported future step; no
   *  merge/deploy/release, no new PR. */
  protected async handlePrCreatedCompanionUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePrCreatedCompanionUnsupported(message.context);
    return this.respondComposed(message, session, reply);
  }

  /**
   * READ-ONLY PR status preview (Sprint 3e, ADR-0055) — at PR_CREATED, an explicit PR/CI/check/review status
   * phrase queries the ANCHORED PR (never a user-supplied number/URL). Calls the manager only (never the
   * provider/adapter), passes NO token, requires NO ApprovalRef. KEEPS `PR_CREATED` on every path (no state
   * change, no mutation). A read failure/stale-context means "could not check current status" — never "PR not
   * created / checks failed".
   */
  protected async handlePrStatusPreviewTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const manager = this.deps.repositoryHosting?.manager;
    if (!manager) {
      return this.respondComposed(message, session, this.deps.composer.composePrStatusNotConfigured(message.context));
    }
    const lookup = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.repositoryIdentity ? { bound: anchor.repositoryIdentity } : {}),
    });
    if (!lookup.ok) {
      return this.respondHostingLookupFailure(message, session, lookup, () =>
        this.respondComposed(message, session, this.deps.composer.composePrStatusNotConfigured(message.context)),
      );
    }
    const identity = lookup.identity;
    // Complete PR_CREATED context, incl. the approved identity + durable PullRequestRef (the ONLY query source).
    // (Sprint 3f/3g) also reachable from MERGE_APPROVED and PR_MERGED — read-only, and it never re-anchors so the
    // caller's state (PR_CREATED / MERGE_APPROVED / PR_MERGED) is preserved.
    const ref = anchor.pullRequestRef;
    if (
      (anchor.status !== 'PR_CREATED' &&
        anchor.status !== 'MERGE_APPROVED' &&
        anchor.status !== 'PR_MERGED' &&
        anchor.status !== 'MAIN_SYNCED' &&
        anchor.status !== 'BRANCH_CLEANED' &&
        anchor.status !== 'REMOTE_BRANCH_CLEANUP_APPROVED' &&
        anchor.status !== 'REMOTE_BRANCH_CLEANED') ||
      !ref ||
      !anchor.repositoryIdentity ||
      !anchor.pullRequestHeadBranch ||
      !anchor.pullRequestBaseBranch ||
      !anchor.pullRequestCommitHash
    ) {
      return this.respondComposed(message, session, this.deps.composer.composePrStatusUnavailable(message.context));
    }
    // Resolved identity must match both the approved anchor identity and the ref (never a user-supplied PR).
    if (
      anchor.repositoryIdentity.provider !== identity.provider ||
      anchor.repositoryIdentity.owner !== identity.owner ||
      anchor.repositoryIdentity.repo !== identity.repo ||
      ref.provider !== identity.provider ||
      ref.owner !== identity.owner ||
      ref.repo !== identity.repo
    ) {
      return this.respondComposed(message, session, this.deps.composer.composePrStatusUnavailable(message.context));
    }
    let preview: PullRequestStatusPreview;
    try {
      preview = await manager.getPullRequestStatus({
        identity,
        pullRequestRef: ref,
        expectedHeadBranch: anchor.pullRequestHeadBranch,
        expectedBaseBranch: anchor.pullRequestBaseBranch,
        expectedCommitHash: anchor.pullRequestCommitHash,
      });
    } catch {
      // Read-only failure or stale/unattributable result → could not check; NOT "checks failed"/"PR not created".
      return this.respondComposed(message, session, this.deps.composer.composePrStatusCheckFailed(message.context));
    }
    // Point-in-time preview — KEEP the current state (PR_CREATED or MERGE_APPROVED): no re-anchor, no new
    // state, no mutation. From MERGE_APPROVED, add a reminder that the merge approval is still recorded and no
    // merge happened — the preview must not imply the approval was consumed/cleared (Sprint 3f, CA change 5).
    const mergeApproved = anchor.status === 'MERGE_APPROVED';
    return this.respondComposed(
      message,
      session,
      this.deps.composer.composePrStatusPreview(message.context, preview, { mergeApproved }),
    );
  }

  /** A PR request bundled with deploy/merge/release/force/… (Sprint 3b, CA #5) — unsupported companion; no approval, no PR. */
  protected async handlePrUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePrUnsupportedCompanion(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /**
   * Explicit merge approval / merge phrase while PR_CREATED (Sprint 3f, ADR-0056) — records a CRITICAL merge
   * approval and halts at MERGE_APPROVAL_PENDING. Mirrors handlePrApprovalTurn. **NO merge, NO GitHub write.**
   * Requires complete PR_CREATED context (identity + pullRequestRef + head/base/commit + executionPlanRef).
   */
  protected async handleMergeApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const ref = anchor.pullRequestRef;
    if (
      anchor.status !== 'PR_CREATED' ||
      !ref ||
      !anchor.repositoryIdentity ||
      !anchor.pullRequestNumber ||
      !anchor.pullRequestUrl ||
      !anchor.pullRequestHeadBranch ||
      !anchor.pullRequestBaseBranch ||
      !anchor.pullRequestCommitHash ||
      !anchor.executionPlanRef
    ) {
      this.logPrApprovalFailed(session, anchor, 'merge approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeMergeApprovalUnavailable(message.context));
    }
    // ADR-0109 D2: the project's origin must still be the anchored, allowlisted repository — otherwise no approval.
    const mergeApprovalGate = await this.remoteRepositoryGate(
      message,
      session,
      anchor.workspaceRef?.rootPath,
      { bound: anchor.repositoryIdentity },
      () => this.failComposed(message, session, this.deps.composer.composeMergeApprovalUnavailable(message.context)),
    );
    if (mergeApprovalGate.reply) return mergeApprovalGate.reply;
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.CRITICAL,
      reason: buildMergeApprovalReason({
        owner: anchor.repositoryIdentity.owner,
        repo: anchor.repositoryIdentity.repo,
        prNumber: anchor.pullRequestNumber,
        prUrl: anchor.pullRequestUrl,
        headBranch: anchor.pullRequestHeadBranch,
        baseBranch: anchor.pullRequestBaseBranch,
        commitHash: anchor.pullRequestCommitHash,
        reused: anchor.pullRequestReused ?? false,
      }),
      requestedBy: actor.id,
    });
    const pendingAnchor: ApplyPreviewAnchor = {
      ...anchor,
      status: 'MERGE_APPROVAL_PENDING',
      mergeApprovalId: approval.id,
      mergeApprovalRequestedAt: now(),
    };
    await this.deps.applyPreviewFlow.anchor(session, pendingAnchor);
    const reply = this.deps.composer.composeMergeApprovalRequested(message.context, {
      owner: anchor.repositoryIdentity.owner,
      repo: anchor.repositoryIdentity.repo,
      prNumber: anchor.pullRequestNumber,
      prUrl: anchor.pullRequestUrl,
      headBranch: anchor.pullRequestHeadBranch,
      baseBranch: anchor.pullRequestBaseBranch,
      commitHash: anchor.pullRequestCommitHash,
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply: this.previewWithReference(session, reply, approval, pendingAnchor), sessionId: session.id };
  }

  /**
   * Decide the pending merge approval (Sprint 3f) — mirrors handlePrApprovalDecisionTurn. A merge/deploy/status
   * phrase while pending is a premature request → ambiguous re-prompt (NO decide, NO merge). Approve →
   * MERGE_APPROVED (record only, + mergeApprovedAt/mergeApprovalDecisionBy). Deny/cancel → PR_CREATED clearing
   * ONLY merge fields (PR/push/commit/workspace preserved). Structured fields only — never parse reason.
   */
  protected async handleMergeApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const incomplete = this.approvalDecisions.incompleteAnchoredContext(message.context, session, anchor);
    if (incomplete) return this.decisionTurn(session, await incomplete);
    // A merge / status phrase, or any deploy-only phrase, while PENDING → ambiguous re-prompt (no decide).
    const decision =
      interpretMergeIntent(message.text) !== null ||
      interpretPrStatusIntent(message.text) ||
      DEPLOY_ONLY_WORDS.test(message.text)
        ? 'ambiguous'
        : interpretDecision(message.text);
    if (decision === 'ambiguous') {
      return this.respondAnchoredReminder(
        message,
        session,
        anchor.mergeApprovalId!,
        anchor,
        this.deps.composer.composeMergeApprovalUnavailable(message.context),
      );
    }
    // ADR-0113 D7: the shared decision path — request re-read (structured fields only), expiry re-check, decide,
    // MERGE_APPROVED or back to PR_CREATED. Records only; NO merge.
    return this.decisionTurn(
      session,
      await this.approvalDecisions.decideAnchored(this.chatDecision(message, session, actor), anchor, decision),
    );
  }

  /** A merge phrase while already MERGE_APPROVED (Sprint 3f) — already approved; actual merge is a future step. No mutation. */
  protected async handleMergeAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeMergeAlreadyApproved(message.context);
    return this.respondComposed(message, session, reply);
  }

  /** A deploy/release/reviewer/label/assignee phrase while MERGE_APPROVED (Sprint 3f) — unsupported future step; no mutation. */
  protected async handleMergeApprovedCompanionUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeMergeApprovedCompanionUnsupported(message.context);
    return this.respondComposed(message, session, reply);
  }

  /**
   * Execute a PR merge from MERGE_APPROVED (Sprint 3g, ADR-0057) — the first repository-hosting mutation after PR
   * creation. Re-validates the 3f approval evidence + the full anchored context, then calls the Manager, which
   * runs the LIVE preflight and makes at most ONE mutating call. Calls the manager only (never the provider/
   * adapter), passes NO token. Failure is SAFE: a KNOWN pre-mutation BlockedError may say "not merged"; a known
   * post-attempt UnverifiedError AND any unknown throw are UNVERIFIED (never "not merged"). Keeps MERGE_APPROVED
   * on every failure path. NO merge unless MERGE_APPROVED + execution command + all preflight checks pass.
   */
  protected async handleMergeExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const manager = this.deps.repositoryHosting?.manager;
    // Not configured: no resolved identity OR no manager (missing GitHub token) — safe not-configured, no call.
    if (!manager) {
      return this.respondComposed(message, session, this.deps.composer.composeMergeExecutionUnavailable(message.context));
    }
    const lookup = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.repositoryIdentity ? { bound: anchor.repositoryIdentity } : {}),
    });
    if (!lookup.ok) {
      return this.respondHostingLookupFailure(message, session, lookup, () =>
        this.respondComposed(message, session, this.deps.composer.composeMergeExecutionUnavailable(message.context)),
      );
    }
    const identity = lookup.identity;
    const ref = anchor.pullRequestRef;
    // Anchor/context preflight (checks 1–8). Any missing → Blocked (definitively no merge).
    if (
      anchor.status !== 'MERGE_APPROVED' ||
      !anchor.mergeApprovalId ||
      !anchor.executionPlanRef ||
      !anchor.repositoryIdentity ||
      !ref ||
      !anchor.pullRequestNumber ||
      !anchor.pullRequestUrl ||
      !anchor.pullRequestHeadBranch ||
      !anchor.pullRequestBaseBranch ||
      !anchor.pullRequestCommitHash
    ) {
      this.logPrApprovalFailed(session, anchor, 'merge execution context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeMergeExecutionPreflightBlocked(message.context));
    }
    // Resolved identity must match the approved anchor identity AND the durable ref (never a fresh/user id).
    if (
      anchor.repositoryIdentity.provider !== identity.provider ||
      anchor.repositoryIdentity.owner !== identity.owner ||
      anchor.repositoryIdentity.repo !== identity.repo ||
      ref.provider !== identity.provider ||
      ref.owner !== identity.owner ||
      ref.repo !== identity.repo
    ) {
      this.logPrApprovalFailed(session, anchor, 'merge execution identity mismatch');
      return this.failComposed(message, session, this.deps.composer.composeMergeExecutionPreflightBlocked(message.context));
    }
    // Re-read the 3f approval evidence via STRUCTURED fields + ApprovalRef only — never parse reason. No new request.
    const request = await this.deps.approvals.get(anchor.mergeApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.APPROVED ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPrApprovalFailed(session, anchor, 'merge approval missing/not-approved/plan-mismatch');
      return this.failComposed(message, session, this.deps.composer.composeMergeExecutionPreflightBlocked(message.context));
    }
    let result: PullRequestMergeResult;
    try {
      // ADR-0122 D2.5: the live grant is re-read as the last statement before this external call (after every awaited
      // preflight above), so a revoke that landed during them wins.
      const surfaceRevoked = await this.surfaceRecheckBeforeCall(message, session, actor, 'merge');
      if (surfaceRevoked) return surfaceRevoked;
      result = await manager.mergePullRequest({
        identity,
        pullRequestRef: ref,
        expectedHeadBranch: anchor.pullRequestHeadBranch,
        expectedBaseBranch: anchor.pullRequestBaseBranch,
        expectedHeadSha: anchor.pullRequestCommitHash,
        approvalRef: approvalRef(request),
      });
    } catch (err) {
      // Fail SAFE. Only a KNOWN pre-mutation BlockedError may say "not merged"; a known post-attempt
      // UnverifiedError AND any unknown generic/non-Error throw are UNVERIFIED (the merge may have happened), so
      // we never claim "not merged". Keep MERGE_APPROVED on every failure path (the approval is still valid).
      if (err instanceof RepositoryHostingBlockedError) {
        this.logPrApprovalFailed(session, anchor, 'merge blocked before mutation');
        return this.failComposed(message, session, this.deps.composer.composeMergeExecutionPreflightBlocked(message.context));
      }
      this.logPrApprovalFailed(session, anchor, 'merge unverified (mutation ambiguity)');
      return this.failComposed(message, session, this.deps.composer.composeMergeExecutionUnverified(message.context));
    }
    // Success (freshly merged OR the exact approved head observed already merged) → anchor PR_MERGED, preserving
    // the full causal chain + 3f approval evidence; mergedAt is the RUNTIME record timestamp (CA change 3).
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'PR_MERGED',
      mergedAt: now(),
      mergeExecutedBy: actor.id,
      mergedHeadSha: result.mergedHeadSha,
      mergeCommitHash: result.mergeCommitHash,
    });
    const view = {
      owner: result.owner,
      repo: result.repo,
      prNumber: result.pullRequestNumber,
      prUrl: result.pullRequestUrl,
    };
    const reply = result.alreadyMerged
      ? this.deps.composer.composeMergeExecutionAlreadyMerged(message.context, view)
      : this.deps.composer.composeMergeExecutionSucceeded(message.context, {
          ...view,
          mergedHeadSha: result.mergedHeadSha,
          mergeCommitHash: result.mergeCommitHash,
        });
    return this.respondComposed(message, session, reply);
  }

  /** A merge phrase at PR_MERGED (Sprint 3g) — the PR is already merged; no new mutation. */
  protected async handleMergeAlreadyMergedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
    if (!anchor.repositoryIdentity || !anchor.pullRequestNumber || !anchor.pullRequestUrl) {
      return this.respondComposed(message, session, this.deps.composer.composeMergeExecutionUnsupportedCompanion(message.context));
    }
    const reply = this.deps.composer.composeMergeExecutionAlreadyMerged(message.context, {
      owner: anchor.repositoryIdentity.owner,
      repo: anchor.repositoryIdentity.repo,
      prNumber: anchor.pullRequestNumber,
      prUrl: anchor.pullRequestUrl,
    });
    return this.respondComposed(message, session, reply);
  }

  /** A deploy/release/reviewer/label/assignee/branch-deletion phrase at PR_MERGED (Sprint 3g) — unsupported future step; no mutation. */
  protected async handleMergeExecutionUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeMergeExecutionUnsupportedCompanion(message.context);
    return this.respondComposed(message, session, reply);
  }

  /**
   * Post-merge LOCAL main synchronization from PR_MERGED (Sprint 3h, ADR-0058) — fast-forward-only. Re-validates the
   * PR_MERGED evidence + the anchored identity, then calls the Git Manager (which runs the local + remote preflight
   * and makes at most ONE fast-forward mutation). Calls the manager only (never the provider primitives, never
   * shells to git), passes NO ApprovalRef. Failure is SAFE and PHASE-AWARE: a KNOWN pre-ref-update
   * GitMainSyncBlockedError may say "not synchronized"; a GitMainSyncUnverifiedError (and any unknown throw) is
   * UNVERIFIED (never "not synced"). Keeps PR_MERGED on every failure path. No deploy/release/branch deletion.
   */
  protected async handleMainSyncTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const lookup = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.repositoryIdentity ? { bound: anchor.repositoryIdentity } : {}),
    });
    // Not configured: no resolved identity → cannot verify we are syncing the right repository. Safe not-configured.
    if (!lookup.ok) {
      return this.respondHostingLookupFailure(message, session, lookup, () =>
        this.respondComposed(message, session, this.deps.composer.composeMainSyncUnavailable(message.context)),
      );
    }
    const identity = lookup.identity;
    // Anchor/context preflight (checks 1–5, 10). Any missing/mismatch → Blocked (definitively not synced).
    if (
      anchor.status !== 'PR_MERGED' ||
      !anchor.repositoryIdentity ||
      anchor.repositoryIdentity.provider !== identity.provider ||
      anchor.repositoryIdentity.owner !== identity.owner ||
      anchor.repositoryIdentity.repo !== identity.repo ||
      anchor.pullRequestBaseBranch !== PR_BASE_BRANCH_POLICY ||
      !anchor.mergedHeadSha ||
      !anchor.mergeCommitHash || // CA change 4 — require the exact merge commit; NO mergedHeadSha fallback
      !anchor.workspaceRef?.rootPath
    ) {
      this.logPrApprovalFailed(session, anchor, 'main sync context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeMainSyncBlocked(message.context));
    }
    let result: GitMainSyncResult;
    try {
      result = await this.deps.git.syncMain({
        rootPath: anchor.workspaceRef.rootPath,
        remote: MAIN_SYNC_REMOTE,
        branch: PR_BASE_BRANCH_POLICY,
        expectedRemoteCommit: anchor.mergeCommitHash,
        // ADR-0109 review P1: the anchored (approved) repository goes to the git provider's ls-remote and fetch.
        ...(this.deps.repositoryHosting?.resolveIdentity ? { repository: { ...identity } } : {}),
      });
    } catch (err) {
      // Phase-aware: only a KNOWN pre-ref-update BlockedError may say "not synced"; an UnverifiedError AND any
      // unknown throw are UNVERIFIED (the local ref may have moved). Keep PR_MERGED on every failure path.
      if (err instanceof GitMainSyncBlockedError) {
        this.logPrApprovalFailed(session, anchor, 'main sync blocked before ref update');
        if (err.reason === 'TARGET_CHANGED') {
          return this.failComposed(message, session, this.deps.composer.composeRepositoryTargetChanged(message.context));
        }
        return this.failComposed(message, session, this.deps.composer.composeMainSyncBlocked(message.context));
      }
      void (err instanceof GitMainSyncUnverifiedError);
      this.logPrApprovalFailed(session, anchor, 'main sync unverified (ref-update ambiguity)');
      return this.failComposed(message, session, this.deps.composer.composeMainSyncUnverified(message.context));
    }
    // Success → anchor MAIN_SYNCED, preserving the full PR_MERGED chain + merge evidence; mainSyncedAt is the
    // RUNTIME record timestamp.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'MAIN_SYNCED',
      syncedMainCommit: result.syncedCommitHash,
      mainSyncedAt: now(),
      mainSyncBranch: result.branch,
      syncMode: result.syncMode,
      workingTreeUpdated: result.workingTreeUpdated,
      previousMainCommit: result.previousMainCommit,
    });
    void actor;
    const reply = this.deps.composer.composeMainSyncSucceeded(message.context, {
      syncMode: result.syncMode,
      syncedCommitHash: result.syncedCommitHash,
      previousMainCommit: result.previousMainCommit,
      workingTreeUpdated: result.workingTreeUpdated,
      alreadyUpToDate: result.alreadyUpToDate,
    });
    return this.respondComposed(message, session, reply);
  }

  /** A sync command at MAIN_SYNCED (Sprint 3h) — local main is already synchronized; no new mutation. */
  protected async handleMainAlreadySyncedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
    const reply = this.deps.composer.composeMainSyncSucceeded(message.context, {
      syncMode: anchor.syncMode ?? 'ref-only',
      syncedCommitHash: anchor.syncedMainCommit ?? '',
      previousMainCommit: anchor.previousMainCommit ?? anchor.syncedMainCommit ?? '',
      workingTreeUpdated: anchor.workingTreeUpdated ?? false,
      alreadyUpToDate: true,
    });
    return this.respondComposed(message, session, reply);
  }

  /**
   * Post-merge LOCAL branch cleanup from MAIN_SYNCED (Sprint 3i, ADR-0059) — a safe CAS delete of the already-merged
   * feature branch (the ANCHORED PR head branch; never a user-named branch). Re-validates the MAIN_SYNCED evidence +
   * the anchored identity, resolves the target from the anchor, then calls the Git Manager (which runs the local
   * preflight and makes at most ONE CAS delete). Calls the manager only (never the provider, never shells). NO
   * ApprovalRef. Failure is SAFE and PHASE-AWARE: a KNOWN pre-ref-delete BranchCleanupBlockedError may say "not
   * deleted"; a BranchCleanupUnverifiedError (and any unknown throw) is UNVERIFIED. Keeps MAIN_SYNCED on failure. NO
   * remote deletion, NO force delete, NO deploy/release/tag.
   */
  protected async handleBranchCleanupTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const lookup = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.repositoryIdentity ? { bound: anchor.repositoryIdentity } : {}),
    });
    if (!lookup.ok) {
      return this.respondHostingLookupFailure(message, session, lookup, () =>
        this.respondComposed(message, session, this.deps.composer.composeBranchCleanupUnavailable(message.context)),
      );
    }
    const identity = lookup.identity;
    const target = anchor.pullRequestHeadBranch;
    // Anchor/target preflight (checks 1–8). Any missing/mismatch/unsafe → Blocked (definitely not deleted).
    if (
      anchor.status !== 'MAIN_SYNCED' ||
      !anchor.syncedMainCommit ||
      anchor.mainSyncBranch !== PR_BASE_BRANCH_POLICY ||
      !target ||
      target !== anchor.pushedBranch ||
      target === PR_BASE_BRANCH_POLICY ||
      !isSafePushBranch(target) ||
      !anchor.workspaceRef?.rootPath ||
      !anchor.repositoryIdentity ||
      anchor.repositoryIdentity.provider !== identity.provider ||
      anchor.repositoryIdentity.owner !== identity.owner ||
      anchor.repositoryIdentity.repo !== identity.repo
    ) {
      this.logPrApprovalFailed(session, anchor, 'branch cleanup context incomplete');
      return this.failComposed(
        message,
        session,
        this.deps.composer.composeBranchCleanupBlocked(
          message.context,
          target === PR_BASE_BRANCH_POLICY ? 'TARGET_IS_MAIN' : target && !isSafePushBranch(target) ? 'UNSAFE_NAME' : undefined,
        ),
      );
    }
    let result: GitBranchCleanupResult;
    try {
      result = await this.deps.git.deleteMergedLocalBranch({
        rootPath: anchor.workspaceRef.rootPath,
        branch: target,
        expectedMainCommit: anchor.syncedMainCommit,
      });
    } catch (err) {
      // Phase-aware: only a KNOWN pre-ref-delete BlockedError may say "not deleted"; an UnverifiedError AND any
      // unknown throw are UNVERIFIED. Keep MAIN_SYNCED on every failure path.
      if (err instanceof BranchCleanupBlockedError) {
        this.logPrApprovalFailed(session, anchor, 'branch cleanup blocked before delete');
        return this.failComposed(message, session, this.deps.composer.composeBranchCleanupBlocked(message.context, err.reason));
      }
      void (err instanceof BranchCleanupUnverifiedError);
      this.logPrApprovalFailed(session, anchor, 'branch cleanup unverified (delete ambiguity)');
      return this.failComposed(message, session, this.deps.composer.composeBranchCleanupUnverified(message.context));
    }
    // Success (deleted OR already-absent) → anchor BRANCH_CLEANED, preserving the full MAIN_SYNCED chain; LOCAL only.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'BRANCH_CLEANED',
      branchCleanupMode: 'local',
      cleanedBranch: result.branch,
      branchCleanedAt: now(),
      branchCleanedBy: actor.id,
      cleanedLocalBranch: result.deleted,
      cleanedRemoteBranch: false,
    });
    const reply = this.deps.composer.composeBranchCleanupSucceeded(message.context, {
      cleanedBranch: result.branch,
      cleanedLocalBranch: result.deleted,
      alreadyAbsent: result.alreadyAbsent,
    });
    return this.respondComposed(message, session, reply);
  }

  /** A local cleanup phrase at BRANCH_CLEANED (Sprint 3i) — already cleaned; no new deletion. */
  protected async handleBranchAlreadyCleanedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
    const reply = this.deps.composer.composeBranchCleanupSucceeded(message.context, {
      cleanedBranch: anchor.cleanedBranch ?? anchor.pullRequestHeadBranch ?? '',
      cleanedLocalBranch: false,
      alreadyAbsent: true,
    });
    return this.respondComposed(message, session, reply);
  }

  /** A REMOTE branch cleanup phrase BEFORE the local branch is cleaned (at MAIN_SYNCED) — remote cleanup is available
   *  only from BRANCH_CLEANED (clean the local branch first). NO mutation (Sprint 3i → reworded Sprint 3j-A). */
  protected async handleRemoteBranchCleanupUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeRemoteBranchCleanupUnsupported(message.context);
    return this.respondComposed(message, session, reply);
  }

  /**
   * A REMOTE branch cleanup phrase at BRANCH_CLEANED (Sprint 3j-A, ADR-0060) — records a CRITICAL remote-branch-
   * cleanup approval and halts at REMOTE_BRANCH_CLEANUP_PENDING. Mirrors handleMergeApprovalTurn. **NO remote
   * deletion, NO GitHub write, NO RepositoryHosting call.** The delete TARGET is always the anchored PR head branch
   * (never user-supplied). Requires the complete BRANCH_CLEANED chain (identity + pullRequestRef + PR number/URL +
   * head branch == pushedBranch, safe, non-main + expected head commit + executionPlanRef).
   */
  protected async handleRemoteBranchCleanupApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const target = anchor.pullRequestHeadBranch;
    const expectedHeadCommit = anchor.mergedHeadSha ?? anchor.pullRequestCommitHash;
    if (
      anchor.status !== 'BRANCH_CLEANED' ||
      !anchor.executionPlanRef ||
      !anchor.repositoryIdentity ||
      !anchor.pullRequestRef ||
      !anchor.pullRequestNumber ||
      !anchor.pullRequestUrl ||
      !target ||
      target !== anchor.pushedBranch ||
      target === PR_BASE_BRANCH_POLICY ||
      !isSafePushBranch(target) ||
      !expectedHeadCommit
    ) {
      this.logPrApprovalFailed(session, anchor, 'remote branch cleanup approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(message.context));
    }
    // ADR-0109 D2: the project's origin must still be the anchored, allowlisted repository — otherwise no approval.
    const remoteCleanupApprovalGate = await this.remoteRepositoryGate(
      message,
      session,
      anchor.workspaceRef?.rootPath,
      { bound: anchor.repositoryIdentity },
      () => this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(message.context)),
    );
    if (remoteCleanupApprovalGate.reply) return remoteCleanupApprovalGate.reply;
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.CRITICAL,
      reason: buildRemoteBranchCleanupApprovalReason({
        owner: anchor.repositoryIdentity.owner,
        repo: anchor.repositoryIdentity.repo,
        prNumber: anchor.pullRequestNumber,
        prUrl: anchor.pullRequestUrl,
        branch: target,
        expectedHeadCommit,
      }),
      requestedBy: actor.id,
    });
    const pendingAnchor: ApplyPreviewAnchor = {
      ...anchor,
      status: 'REMOTE_BRANCH_CLEANUP_PENDING',
      remoteBranchCleanupApprovalId: approval.id,
      remoteBranchCleanupApprovalRequestedAt: now(),
    };
    await this.deps.applyPreviewFlow.anchor(session, pendingAnchor);
    const reply = this.deps.composer.composeRemoteBranchCleanupRequested(message.context, {
      owner: anchor.repositoryIdentity.owner,
      repo: anchor.repositoryIdentity.repo,
      prNumber: anchor.pullRequestNumber,
      prUrl: anchor.pullRequestUrl,
      branch: target,
      expectedHeadCommit,
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply: this.previewWithReference(session, reply, approval, pendingAnchor), sessionId: session.id };
  }

  /**
   * Decide the pending remote-branch-cleanup approval (Sprint 3j-A) — mirrors handleMergeApprovalDecisionTurn. A
   * remote-cleanup / execute / status / deploy phrase while pending is a premature command → ambiguous re-prompt (NO
   * decide, NO delete, NO auto-approve). Approve → REMOTE_BRANCH_CLEANUP_APPROVED (record only). Deny/cancel →
   * BRANCH_CLEANED clearing ONLY the four remote-cleanup approval fields (the full chain is preserved). Structured
   * fields only — never parse reason. **NO remote deletion on any path.**
   */
  protected async handleRemoteBranchCleanupDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const incomplete = this.approvalDecisions.incompleteAnchoredContext(message.context, session, anchor);
    if (incomplete) return this.decisionTurn(session, await incomplete);
    // A remote-cleanup / execute / status phrase, or any deploy-only phrase, while PENDING → ambiguous re-prompt.
    const decision =
      interpretRemoteBranchCleanupIntent(message.text) !== null ||
      interpretRemoteBranchCleanupExecutionIntent(message.text) !== null ||
      interpretPrStatusIntent(message.text) ||
      DEPLOY_ONLY_WORDS.test(message.text)
        ? 'ambiguous'
        : interpretDecision(message.text);
    if (decision === 'ambiguous') {
      return this.respondAnchoredReminder(
        message,
        session,
        anchor.remoteBranchCleanupApprovalId!,
        anchor,
        this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(message.context),
      );
    }
    // ADR-0113 D7: the shared decision path — request re-read (structured fields only), expiry re-check, decide,
    // REMOTE_BRANCH_CLEANUP_APPROVED or back to BRANCH_CLEANED. Records only; NO remote deletion.
    return this.decisionTurn(
      session,
      await this.approvalDecisions.decideAnchored(this.chatDecision(message, session, actor), anchor, decision),
    );
  }

  /** A remote cleanup phrase while already REMOTE_BRANCH_CLEANUP_APPROVED (Sprint 3j-A) — already approved; the
   *  actual remote deletion is a future step (3j-B). No mutation. */
  protected async handleRemoteBranchCleanupAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeRemoteBranchCleanupAlreadyApproved(message.context);
    return this.respondComposed(message, session, reply);
  }

  /**
   * Execute a REMOTE branch cleanup from REMOTE_BRANCH_CLEANUP_APPROVED (Sprint 3j-B, ADR-0060) — the execution half.
   * Re-reads the 3j-A CRITICAL approval + re-validates the full anchored remote target + the local-cleanup chain, then
   * calls the Manager, which runs the live preflight and makes at most ONE GitHub refs DELETE (read-immediately-before-
   * delete SHA verify). Calls the manager only (never the provider), passes NO token. Failure is SAFE and PHASE-AWARE:
   * a KNOWN pre-DELETE RemoteBranchCleanupBlockedError may say "not deleted"; a RemoteBranchCleanupUnverifiedError AND
   * any unknown throw are UNVERIFIED (never "not deleted"). Keeps REMOTE_BRANCH_CLEANUP_APPROVED on every failure path.
   */
  protected async handleRemoteBranchCleanupExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const manager = this.deps.repositoryHosting?.manager;
    // Check 1 — not configured (no identity / no manager / no token): safe not-configured, no call, anchor unchanged.
    if (!manager) {
      return this.respondComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionUnavailable(message.context));
    }
    const lookup = await this.hostingIdentityFor(anchor.workspaceRef?.rootPath, {
      ...(anchor.repositoryIdentity ? { bound: anchor.repositoryIdentity } : {}),
    });
    if (!lookup.ok) {
      return this.respondHostingLookupFailure(message, session, lookup, () =>
        this.respondComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionUnavailable(message.context)),
      );
    }
    const identity = lookup.identity;
    const ref = anchor.pullRequestRef;
    const target = anchor.pullRequestHeadBranch;
    const expectedHeadCommit = anchor.mergedHeadSha; // CA change 2 — NO fallback to pullRequestCommitHash
    // Checks 2–14 (approval evidence, identity/ref, target, expected commit, local-cleanup chain) → Blocked.
    if (
      anchor.status !== 'REMOTE_BRANCH_CLEANUP_APPROVED' ||
      !anchor.executionPlanRef ||
      !anchor.remoteBranchCleanupApprovalId ||
      !anchor.remoteBranchCleanupApprovalRequestedAt ||
      !anchor.remoteBranchCleanupApprovedAt ||
      !anchor.remoteBranchCleanupApprovalDecisionBy ||
      !anchor.repositoryIdentity ||
      !ref ||
      !anchor.pullRequestNumber ||
      !anchor.pullRequestUrl ||
      !anchor.pullRequestBaseBranch ||
      !target ||
      target !== anchor.pushedBranch ||
      target === PR_BASE_BRANCH_POLICY ||
      !isSafePushBranch(target) ||
      !expectedHeadCommit ||
      !/^[0-9a-f]{7,40}$/i.test(expectedHeadCommit) ||
      anchor.branchCleanupMode !== 'local' ||
      anchor.cleanedBranch !== target ||
      anchor.cleanedRemoteBranch !== false ||
      typeof anchor.cleanedLocalBranch !== 'boolean'
    ) {
      this.logPrApprovalFailed(session, anchor, 'remote branch cleanup execution context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionBlocked(message.context));
    }
    // Resolved identity must match the approved anchor identity AND the durable ref (never a fresh/user id).
    if (
      anchor.repositoryIdentity.provider !== identity.provider ||
      anchor.repositoryIdentity.owner !== identity.owner ||
      anchor.repositoryIdentity.repo !== identity.repo ||
      ref.provider !== identity.provider ||
      ref.owner !== identity.owner ||
      ref.repo !== identity.repo
    ) {
      this.logPrApprovalFailed(session, anchor, 'remote branch cleanup execution identity mismatch');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionBlocked(message.context));
    }
    // Re-read the 3j-A approval evidence via STRUCTURED fields + ApprovalRef only — never parse reason. No new request.
    const request = await this.deps.approvals.get(anchor.remoteBranchCleanupApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.APPROVED ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPrApprovalFailed(session, anchor, 'remote branch cleanup approval missing/not-approved/plan-mismatch');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionBlocked(message.context));
    }
    let result: RemoteBranchCleanupResult;
    try {
      // ADR-0122 D2.5: the live grant is re-read as the last statement before this external call (after every awaited
      // preflight above), so a revoke that landed during them wins.
      const surfaceRevoked = await this.surfaceRecheckBeforeCall(message, session, actor, 'remote-cleanup');
      if (surfaceRevoked) return surfaceRevoked;
      result = await manager.deleteRemoteBranch({
        identity,
        pullRequestRef: ref,
        expectedHeadBranch: target,
        expectedBaseBranch: anchor.pullRequestBaseBranch,
        branch: target,
        expectedCommitHash: expectedHeadCommit,
        approvalRef: approvalRef(request),
      });
    } catch (err) {
      // Fail SAFE. Only a KNOWN pre-DELETE BlockedError may say "not deleted"; a post-attempt UnverifiedError AND any
      // unknown throw are UNVERIFIED (the DELETE may have happened). Keep REMOTE_BRANCH_CLEANUP_APPROVED on every path.
      if (err instanceof RemoteBranchCleanupBlockedError) {
        this.logPrApprovalFailed(session, anchor, 'remote branch cleanup blocked before delete');
        return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionBlocked(message.context));
      }
      void (err instanceof RemoteBranchCleanupUnverifiedError);
      this.logPrApprovalFailed(session, anchor, 'remote branch cleanup unverified (delete ambiguity)');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupUnverified(message.context));
    }
    // Success (freshly deleted OR already-absent) → anchor REMOTE_BRANCH_CLEANED, preserving the full chain + approval.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'REMOTE_BRANCH_CLEANED',
      remoteBranchCleanupMode: 'remote',
      cleanedRemoteBranchName: result.branch,
      remoteBranchCleanedAt: now(),
      remoteBranchCleanedBy: actor.id,
      remoteBranchCleanupProvider: identity.provider,
      remoteBranchDeletedCommit: result.deletedCommitHash,
      cleanedRemoteBranch: result.deleted,
    });
    const reply = this.deps.composer.composeRemoteBranchCleanupSucceeded(message.context, {
      branch: result.branch,
      cleanedRemoteBranch: result.deleted,
      alreadyAbsent: result.alreadyAbsent,
    });
    return this.respondComposed(message, session, reply);
  }

  /** A remote cleanup / execute phrase at terminal REMOTE_BRANCH_CLEANED (Sprint 3j-B) — already cleaned; no second
   *  DELETE, no mutation. */
  protected async handleRemoteBranchAlreadyCleanedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
    const reply = this.deps.composer.composeRemoteBranchAlreadyCleaned(message.context, {
      branch: anchor.cleanedRemoteBranchName ?? anchor.pullRequestHeadBranch ?? '',
    });
    return this.respondComposed(message, session, reply);
  }

  /** A deploy-only phrase while PR_APPROVED (Sprint 3b, CA #8) — state-specific: PR approval recorded, PR not
   *  created, deployment not done. */
  protected async handlePrApprovedDeployUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePrApprovedDeployUnsupported(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a PR-approval error (Sprint 3b) — never logs diff/file content.
   *  Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  protected logPrApprovalFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    logAnchoredApprovalFailure(this.deps.logger, 'pr', session, anchor, reason); // deliberately NO diff text / file content
  }
}
