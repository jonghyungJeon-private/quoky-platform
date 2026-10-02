import { describeAiFailure } from './ai-failure';
import { generalChatReplyPolicyMetadata } from './chat-policy/chat-response-policy';
import { CREDENTIAL_REJECTION_REASON, containsCredentialMaterial } from './credential-guard';
import { hasCoLocatedUnnegated, unnegatedMatch } from './intent-negation';
import { isAffirmativeExecutionCommand } from './execution-command-guard';
import { interpretApprovalDecision, interpretStrayDecisionUtterance } from './approval-decision';
import { detectExplicitValidationKinds, isDeniedValidationRequest } from './validation-run-intent';
import { type MutationSafety, safeRequestId, toSafeError } from './safe-error';
import {
  type ConversationControlCommand,
  PENDING_APPROVAL_TTL_MS,
  detectConversationControl,
  pendingApprovalRemainingMs,
} from './conversation-commands';
import {
  NON_ABSOLUTE_REGISTRATION_KIND,
  detectProjectRegistration,
  externalActionRequestOf,
  type IntentClassifyContext,
} from './intent-classifier';
import { codeGenerationDispatchOfError } from './code-generation-manager';
import { RepositoryHostingBlockedError } from './repository-hosting-manager';
import { RemoteBranchCleanupBlockedError, RemoteBranchCleanupUnverifiedError } from '../domain';
import {
  BranchCleanupBlockedError,
  BranchCleanupUnverifiedError,
  GitMainSyncBlockedError,
  GitMainSyncUnverifiedError,
  GitPushBlockedError,
} from './git-manager';
import {
  ApprovalStatus,
  Capability,
  CodeGenerationStatus,
  CommandExecutionStatus,
  IntentType,
  RiskLevel,
  TaskStatus,
  approvalRef,
  codeGenerationRef,
  codeProposalRef,
  commandExecutionRef,
  patchRef,
  pullRequestRef,
  workspaceChangeRef,
} from '../domain';
import type {
  Actor,
  ApplyInput,
  ApprovalDecision,
  ApprovalRef,
  ApprovalRequest,
  Artifact,
  CodeGeneration,
  CodeGenerationDispatch,
  CodeGenerationRef,
  CodeProposal,
  CodeProposalRef,
  CommandExecution,
  CommandExecutionRef,
  ContextBundle,
  ContextFile,
  ConversationContext,
  ExecutionPlanRef,
  GenerateCodeInput,
  GitBranchCleanupResult,
  GitCommitResult,
  GitDiff,
  GitMainSyncResult,
  GitPushResult,
  GitStatus,
  RepositoryInfo,
  Id,
  InboundMessage,
  Intent,
  IsoTimestamp,
  Metadata,
  OutboundMessage,
  PatchGenerationInput,
  PatchRef,
  PatchSet,
  Project,
  PromptSpec,
  ProposedChange,
  PullRequestMergeResult,
  PullRequestRef,
  PullRequestResult,
  PullRequestStatusPreview,
  RemoteBranchCleanupResult,
  RepositoryIdentity,
  RunCommandInput,
  Session,
  Task,
  TaskRun,
  TurnWorkFacts,
  WorkspaceChange,
  WorkspaceChangeRef,
  WorkspaceDiff,
  WorkspaceRef,
} from '../domain';
import {
  TURN_HANDLER_STAGES,
  type AiProvider,
  type AiRequest,
  type Logger,
  type LogFields,
  type ProjectReadout,
  type ConversationTurnHandler,
  type TurnHandlerAnchorSnapshot,
  type TurnHandlerContext,
  type TurnHandlerOutcome,
  type TurnHandlerSummarizeReply,
  type TurnHandlerStage,
} from '../ports';
import { now } from '../util/clock';
import type {
  ResponseComposer,
  CodeChangePreview,
  CodeDiffPreview,
  ExecutionReplyStatus,
  PatchSetPreview,
  TestResultDetail,
} from './response-composer';
import { ProviderGatewayTerminalStatus } from './provider-routing-gateway';
import { RoutingFailureCode } from './runtime-response-validation-contracts';
import type {
  RuntimeProviderRouting,
  RuntimeProviderRoutingAudit,
} from './runtime-provider-routing-service';
import type { IntentResolutionContext } from './intent-resolver';
import type { MemoryWriter } from './memory-writer';
import type { WorkSurface } from './work-surface-query';
import type { ExternalWorkReadout } from './work-chat/external-work-readout';
import { isExternalWorkReadout, isWorkSummaryRequestTextWithheld } from './prompt-composer';
import { appendWorkSummaryFooter, isSummarizableExternalWorkReadout } from './work-chat/work-chat-turn-handler';
import { extractMentionedPathTokens, normalizeRelativePath } from './target-scope';
import {
  type CodeGenerationContextResult,
  type CredentialOverrideGrant,
  MAX_CODEGEN_CONTEXT_FILE_BYTES,
  MAX_CODEGEN_CONTEXT_TOTAL_BYTES,
  readCodeGenerationContextFiles,
} from './code-generation-context';
import {
  CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
  CREDENTIAL_OVERRIDE_DENY_COMMENT,
  type CredentialOverrideAnchor,
  type CredentialOverrideDispatchAuthorization,
  type CredentialOverrideFlow,
  type CredentialOverrideInvalidationReason,
  type CredentialOverrideLookup,
  type CredentialOverrideRefusal,
  assessCredentialOverrideCoverage,
  interpretCredentialOverrideDecision,
  isStrayCredentialOverridePhrase,
} from './credential-override';
import { MAX_COMMIT_MESSAGE_CHARS, isValidCommitMessage } from './commit-message';
import { isSafePushBranch, isSafePushRemote } from './push-target';
import {
  classifyUnverifiedChangeSet,
  collectCodeChangeTargets,
  extractSafeTargetCandidates,
  isSingleUpdateChangeSet,
  newFileCommitCandidates,
  partitionCommitCandidates,
  validateChangeSetForApply,
  validatePatchableDiff,
  verifyAppliedChangeSet,
} from './code-work/code-change-set';
import type { CodeChangeTargetCollection } from './code-work/code-change-set';
import {
  type PushMode,
  type PushTargetRefusal,
  checkPushHead,
  parsePushUpstreamRef,
  resolvePushTarget,
  verifyApprovedPushTarget,
} from './code-work/push-target-resolution';
import type {
  CancelToken,
  ExecutionOutcome,
  ExecutionOutcomeStatus,
  ExecutionRequest,
} from './execution-orchestrator';

/**
 * Conversation Runtime (Sprint 2k, ADR-0032) — 춘식봇's conversation entry point. It turns one user
 * message into one natural assistant response by **composing** existing Application/Capability
 * services. It is NOT a new execution engine, NOT a Capability, NOT a new Aggregate.
 *
 * Invariants (ADR-0032): the runtime persists NO runtime state; approval-awaiting state is DERIVED
 * from existing Session/Task/ExecutionPlan/ApprovalRequest state (via the injected `approvalFlow`);
 * Session stores NO runtime snapshot. The runtime's essential output is an `OutboundMessage` — the
 * `QuokyCore` facade performs platform delivery. Reply text is built only by `ResponseComposer`.
 */

/** Transient per-turn status — an Application-layer concept, never persisted. */
export type RuntimeTurnStatus = 'RESPONDED' | 'AWAITING_APPROVAL' | 'DENIED' | 'FAILED' | 'CANCELLED';

/** Transient result of handling one message. NOT an aggregate; never persisted. */
export interface TurnResult {
  status: RuntimeTurnStatus;
  reply: OutboundMessage;
  sessionId: Id;
  executionOutcome?: ExecutionOutcome;
  /**
   * ADR-0098 D5: routing facts of a work turn (intent, capability, Task/TaskRun ids, audit-only provider id), set
   * only by the work path. Transient — never persisted on Session; `QuokyCore` hands it to feedback capture.
   */
  workFacts?: TurnWorkFacts;
}

/** How the runtime interprets a user message while a pending approval exists (ADR-0032 §6). */
export type ApprovalDecisionKind = 'approve' | 'deny' | 'cancel' | 'ambiguous';

/**
 * Cross-turn approval mechanics, confined behind one collaborator so the runtime stays stateless and
 * the correlation source is wired once (ADR-0032: `Session.activeTaskId → Task.planId →
 * approvals.findByExecutionPlan → PENDING`). `decide`/`resume` themselves stay with `ApprovalManager`
 * / `ExecutionOrchestrator`; this only finds/anchors/reconstructs.
 */
export interface ApprovalFlow {
  /** Derive the session's PENDING approval, if any, from existing aggregates. */
  findPending(session: Session): Promise<ApprovalRequest | null>;
  /**
   * Anchor an awaiting-approval execution to the session's in-focus Task (existing fields only), so
   * a later turn can find + resume it. Persists what {@link reconstructResume} needs.
   */
  anchor(session: Session, request: ExecutionRequest, outcome: ExecutionOutcome): Promise<void>;
  /** Reconstruct the `{request, prior}` needed to resume, from anchored/derived state (null if unavailable). */
  reconstructResume(
    session: Session,
    approval: ApprovalRequest,
  ): Promise<{ request: ExecutionRequest; prior: ExecutionOutcome } | null>;
}

/**
 * Minimal, non-secret facts needed to recover a code-change request on the next turn (Sprint 2p,
 * ADR-0037). Never the generated code, a patch, a diff, or provider output — there is none yet.
 *
 * `kind` here is an ANCHOR DISCRIMINATOR, not the classifier's intent tag — deliberately named and
 * typed differently from `rawKind` below so the two are never confused.
 */
export interface PendingScopeClarification {
  /** Proves this Task's metadata is a scope-clarification anchor, not merely a plan-less Task for
   *  some unrelated reason (`!task.planId` alone is too implicit). */
  kind: 'code-scope-clarification';
  /** The original intent's restated summary — becomes the recovered request's DISPLAY goal. Must be the
   *  FIRST message's summary, never overwritten by the follow-up reply's text. */
  summary: string;
  /**
   * The FIRST message's FULL authoritative instruction (Sprint 4c-Follow-up-4, F4-B/RC4) — preserved so
   * that a request recovered on the next turn (a bare-path reply) reaches CodeGeneration with the ORIGINAL
   * complete request, not the ≤200-char summary and not the path-only follow-up text. Preserved in full
   * (bounded only by what the inbound transport accepts — no application-level cap). Absent on anchors
   * written before this field existed → recovery falls back to the summary (prior behavior).
   */
  authoritativeInstruction?: string;
  /** The classifier's raw.kind tag ('fix' | 'change' | 'refactor'), if present. Named `rawKind` — not
   *  `kind` — specifically to avoid colliding with the discriminator above. */
  rawKind?: string;
  /** The active project at anchor time — re-checked at recovery time. */
  projectId?: Id;
  /** Stored for observability/future policy only — NOT consulted for expiration in Sprint 2p. The
   *  invalidation rule is next-turn-only consumption, not a TTL. */
  createdAt: IsoTimestamp;
}

/**
 * Cross-turn scope-clarification mechanics (ADR-0037), confined behind one collaborator exactly
 * like ApprovalFlow — so the runtime stays stateless and the correlation source is wired once.
 */
export interface ScopeClarificationFlow {
  /** Derive the session's pending clarification, if any and still valid (project unchanged). */
  findPending(session: Session): Promise<PendingScopeClarification | null>;
  /** Anchor a fresh insufficient-scope request so the next turn can recover it. Callers must only
   *  invoke this after confirming an active project exists, the workspace opened successfully, and
   *  no target validated. */
  anchor(session: Session, pending: PendingScopeClarification): Promise<void>;
  /** Consume/clear the anchor — called unconditionally once a pending clarification is checked
   *  (next-turn-only semantics). Safe: a no-op unless `session.activeTaskId` still points at THIS
   *  flow's own anchor Task — it must never clear an approval anchor. */
  clear(session: Session): Promise<void>;
}

/**
 * The states one apply-preview anchor moves through (Sprint 2s, ADR-0040; Sprint 2t, ADR-0041). Never
 * regresses; deny/cancel clears the anchor entirely instead of introducing a "rejected" state.
 *
 * `PATCH_READY` (Sprint 2t) means: a PatchSet **representation** has been generated and stored (a
 * `patchRef` is available). It does NOT mean the patch was applied — no workspace file was modified, no
 * command was executed, no git operation happened.
 *
 * `WORKSPACE_APPLIED` (Sprint 2u, ADR-0042) means: WorkspaceWrite mutated the workspace file(s) (a
 * `workspaceChangeRef` is available). It does NOT mean committed, pushed, deployed, verified by tests, or
 * that the working tree is clean — no git command ran, no test/command ran, and the working tree now
 * holds the applied change.
 */
export type ApplyPreviewAnchorStatus =
  | 'ELIGIBLE'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'PATCH_READY'
  | 'WORKSPACE_APPLIED'
  /**
   * A HIGH-risk git-commit ApprovalRequest is pending decision (Sprint 2x, ADR-0045). Intercepts every turn
   * like AWAITING_APPROVAL. NOT committed — no git add/commit/push has run.
   */
  | 'COMMIT_APPROVAL_PENDING'
  /**
   * The git-commit approval was granted (Sprint 2x, ADR-0045) — context preserved for the Sprint 2y
   * executor. NOT committed yet — approval only.
   */
  | 'COMMIT_APPROVED'
  /**
   * An approved git commit was executed (Sprint 2y, ADR-0046) — carries `commitHash` + `committedFiles`.
   * The first state that means committed. NOT pushed, NOT deployed — `git push` was not run.
   */
  | 'GIT_COMMITTED'
  /**
   * A CRITICAL git-push ApprovalRequest is pending decision (Sprint 2z, ADR-0047). Intercepts every turn
   * like AWAITING_APPROVAL. NOT pushed — no `git push` has run, and none runs even on approve.
   */
  | 'PUSH_APPROVAL_PENDING'
  /**
   * The git-push approval was granted (Sprint 2z, ADR-0047) — a point-in-time snapshot preserved for the
   * Sprint 3a executor. NOT pushed — approval only.
   */
  | 'PUSH_APPROVED'
  /**
   * An approved git push was executed (Sprint 3a, ADR-0048) — the approved commit was pushed to the approved
   * upstream. The first state that means pushed to a remote. NOT PR-created, NOT deployed.
   */
  | 'GIT_PUSHED'
  /**
   * A CRITICAL Pull-Request-creation ApprovalRequest is pending decision (Sprint 3b, ADR-0049). Intercepts
   * every turn like AWAITING_APPROVAL. NO Pull Request has been created, and none is created even on approve.
   */
  | 'PR_APPROVAL_PENDING'
  /**
   * The PR-creation approval was granted (Sprint 3b, ADR-0049) — records permission only. NOT PR-created,
   * NOT deployed, NOT merged, NOT released. From Sprint 3d-D it also carries `repositoryIdentity` (the
   * approved target), and an explicit PR create/open phrase here EXECUTES creation.
   */
  | 'PR_APPROVED'
  /**
   * An actual Pull Request was created — or an existing open PR was safely connected — during this run
   * (Sprint 3d-D, ADR-0054). The first state that means a PR exists on the hosting provider. NOT merged,
   * NOT deployed, NOT released, NOT reviewed, NOT CI-passed, NOT independently re-verified after creation.
   */
  | 'PR_CREATED'
  /**
   * A CRITICAL merge-approval ApprovalRequest is pending decision (Sprint 3f, ADR-0056). Intercepts every turn.
   * NO merge has been performed and none is performed even on approve — permission recording only.
   */
  | 'MERGE_APPROVAL_PENDING'
  /**
   * The merge approval was granted (Sprint 3f, ADR-0056) — records permission to merge this PR context only.
   * NOT merged, NOT deployed, NOT released, NOT safe-to-merge, NOT mergeable-verified. From Sprint 3g, an
   * explicit merge-execution command here executes the merge (after a full live preflight).
   */
  | 'MERGE_APPROVED'
  /**
   * The approved Pull Request was merged on the hosting provider DURING THIS RUN — or the exact approved head was
   * observed already merged during this run's live preflight (Sprint 3g, ADR-0057). NOT deployed, NOT released,
   * NOT production-ready, NOT branch-deleted, NOT CI-permanently-verified, NOT local-main-synced. From Sprint 3h,
   * an explicit sync command here fast-forwards the LOCAL main.
   */
  | 'PR_MERGED'
  /**
   * The LOCAL workspace repository's `main` ref was synchronized (fast-forward) to the expected post-merge remote
   * `main` commit DURING THIS RUN (Sprint 3h, ADR-0058). NOT deployed, NOT released, NOT production-ready, NOT
   * branch-deleted, NOT remote-branch-cleaned, NOT CI-permanently-verified. From Sprint 3i, an explicit local
   * cleanup command here deletes the already-merged feature branch's LOCAL ref.
   */
  | 'MAIN_SYNCED'
  /**
   * The completed feature branch's LOCAL reference was deleted — or was already absent — DURING THIS RUN (Sprint
   * 3i, ADR-0059). Terminal for the LOCAL chain. NOT deployed, NOT released, NOT tagged, NOT production-ready, NOT
   * remote-branch-deleted, NOT all-branches-cleaned, NOT repository-fully-cleaned. From Sprint 3j-A, an explicit
   * REMOTE branch cleanup phrase here records a CRITICAL approval (permission only; no deletion).
   */
  | 'BRANCH_CLEANED'
  /**
   * A CRITICAL remote-branch-cleanup ApprovalRequest is pending decision (Sprint 3j-A, ADR-0060). Intercepts every
   * turn. NO remote branch has been deleted and none is deleted even on approve — permission recording only.
   */
  | 'REMOTE_BRANCH_CLEANUP_PENDING'
  /**
   * The remote-branch-cleanup approval was granted (Sprint 3j-A, ADR-0060) — records permission to delete the
   * anchored completed PR's REMOTE head branch, for this PR context only. NOT deleted, NOT deployed, NOT released,
   * NOT tagged, NOT safe-to-delete-verified. From Sprint 3j-B, an explicit execution command here deletes the remote
   * branch (after a full live preflight + read-immediately-before-delete SHA verification).
   */
  | 'REMOTE_BRANCH_CLEANUP_APPROVED'
  /**
   * The completed PR's REMOTE head branch was deleted — or was already absent — DURING THIS RUN (Sprint 3j-B,
   * ADR-0060). Terminal. NOT deployed, NOT released, NOT tagged, NOT production-ready, NOT local-branch-deleted-this-
   * run, NOT all-branches-cleaned, NOT repository-fully-cleaned.
   */
  | 'REMOTE_BRANCH_CLEANED';

/**
 * Anchored fact set for "a diff preview was shown; the user may explicitly ask to apply it" (Sprint 2s,
 * ADR-0040). `kind` proves this Task's metadata is an apply-preview anchor, never an approval anchor
 * (`planId` present) or a scope-clarification anchor (different discriminator) — mirrors
 * PendingScopeClarification's pattern exactly.
 */
export interface ApplyPreviewAnchor {
  kind: 'code-preview-apply';
  status: ApplyPreviewAnchorStatus;
  executionPlanRef: ExecutionPlanRef;
  workspaceRef: WorkspaceRef;
  targetFiles: string[];
  /** The subset of `targetFiles` the owner explicitly asked to create (ADR-0099 D1, ADR-0062 wording) — the
   *  ONLY paths an `add` may target at patch, apply and commit time. Absent on an anchor written before
   *  ADR-0099 (or with no new file) and then treated as [] (fail closed: every add is rejected). */
  newFileTargets?: string[];
  codeGenerationRef: CodeGenerationRef;
  codeProposalRef: CodeProposalRef;
  /** The original request's instruction — restated in the apply-approval's `reason`, never re-derived
   *  from chat history. */
  instruction: string;
  /** The active project at anchor time — re-checked at recovery time (mirrors Sprint 2p's Q5 pattern). */
  projectId?: Id;
  createdAt: IsoTimestamp;
  /** Set once `status` moves to `AWAITING_APPROVAL` or beyond; absent while `ELIGIBLE`. */
  approvalId?: Id;
  /** Set once `status` becomes `APPROVED`. */
  approvedAt?: IsoTimestamp;
  /** Set once `status` becomes `PATCH_READY` (Sprint 2t, ADR-0041) — the generated PatchSet's ref,
   *  preserved for Sprint 2u. Its presence makes a repeated patch command idempotent. A PatchSet
   *  representation existing does NOT mean it was applied — no file/command/git mutation occurred. */
  patchRef?: PatchRef;
  /** Set once `status` becomes `WORKSPACE_APPLIED` (Sprint 2u, ADR-0042) — the WorkspaceChange record of
   *  the file mutation, preserved for a future git/test sprint. Files mutated; git commands / tests NOT
   *  run; the working tree is NOT clean. */
  workspaceChangeRef?: WorkspaceChangeRef;
  /** The LATEST post-apply validation run on this WORKSPACE_APPLIED anchor (Sprint 2v, ADR-0043) — the
   *  CommandExecutionRef of a `pnpm test`/`pnpm typecheck` run. Replaced on each new run (latest only; no
   *  history — CommandExecution storage owns history). Its embedded `status` records SUCCEEDED/FAILED/
   *  TIMED_OUT. `status` stays `WORKSPACE_APPLIED` — a validation pass is point-in-time, NOT a durable
   *  "validated" state (no `WORKSPACE_VALIDATED`); git/commit/push/tests-forever are NOT implied. */
  postApplyValidationRef?: CommandExecutionRef;
  /** The pending/decided git-commit ApprovalRequest id (Sprint 2x, ADR-0045) — DISTINCT from `approvalId`
   *  (the apply approval). Set at COMMIT_APPROVAL_PENDING; preserved at COMMIT_APPROVED; cleared on
   *  deny/cancel. */
  commitApprovalId?: Id;
  /** The bounded deterministic (or validated user-provided) commit message proposed for approval (2x). */
  proposedCommitMessage?: string;
  /** In-scope candidate file paths for the commit (changed ∩ targetFiles) preserved for Sprint 2y (2x). */
  commitCandidateFiles?: string[];
  /** Set once `status` becomes `GIT_COMMITTED` (Sprint 2y, ADR-0046) — the executed commit's sha, preserved
   *  for a future push sprint. Committed only; NOT pushed/deployed. */
  commitHash?: string;
  /** The exact files included in the executed commit (Sprint 2y) — the approved candidate set. */
  committedFiles?: string[];
  /** The pending/decided git-push ApprovalRequest id (Sprint 2z, ADR-0047) — DISTINCT from
   *  `commitApprovalId`/`approvalId`. Set at PUSH_APPROVAL_PENDING; preserved at PUSH_APPROVED; cleared on
   *  deny/cancel. */
  pushApprovalId?: Id;
  /** The commit sha the push was approved for (Sprint 2z) — a snapshot of `commitHash` at approval time,
   *  used by a future push-execution sprint to detect HEAD drift. */
  pushCommitHash?: string;
  /** Resolved push remote name, derived from the upstream (Sprint 2z) — e.g. "origin". Never user-provided. */
  pushRemote?: string;
  /** Resolved push branch name, derived from the upstream (Sprint 2z) — e.g. "main" (may contain "/"). */
  pushBranch?: string;
  /** Full upstream tracking ref the push targets (Sprint 2z) — e.g. "origin/main". For a `new-remote-branch`
   *  push (ADR-0099 D5) this is the synthesized `origin/<branch>` the first push creates. */
  pushUpstreamRef?: string;
  /** How the push target was resolved (ADR-0099 D5): `'upstream'` (the branch tracks an upstream) or
   *  `'new-remote-branch'` (no upstream; the first push creates the branch on `origin`). A missing value — every
   *  anchor written before ADR-0099 — is treated as `'upstream'`. Set with the other push fields; cleared with them. */
  pushMode?: PushMode;
  /** Set once `status` becomes `GIT_PUSHED` (Sprint 3a, ADR-0048) — the commit sha actually pushed
   *  (== the approved `pushCommitHash`). Pushed to the approved upstream only; NOT PR-created/deployed. */
  pushedCommitHash?: string;
  /** The remote the approved commit was pushed to (Sprint 3a) — == the approved `pushRemote`. */
  pushedRemote?: string;
  /** The branch the approved commit was pushed to (Sprint 3a) — == the approved `pushBranch`. */
  pushedBranch?: string;
  /** The upstream ref the approved commit was pushed to (Sprint 3a) — == the approved `pushUpstreamRef`. */
  pushedUpstreamRef?: string;
  /** The pending/decided PR-creation ApprovalRequest id (Sprint 3b, ADR-0049) — DISTINCT from
   *  pushApprovalId/commitApprovalId/approvalId. Set at PR_APPROVAL_PENDING; preserved at PR_APPROVED;
   *  cleared on deny/cancel. */
  prApprovalId?: Id;
  /** Snapshot of `pushedCommitHash` at PR-approval time (Sprint 3b) — the pushed commit the PR is for. */
  prPushedCommitHash?: string;
  /** Deterministic PR head branch (Sprint 3b) — == the approved `pushedBranch` (safe/bounded). */
  prHeadBranch?: string;
  /** Deterministic PR base branch (Sprint 3b) — the fixed product policy `main` (never inferred/user-provided). */
  prBaseBranch?: string;
  /** Deterministic bounded PR title (Sprint 3b) — sanitized `instruction`, fallback "Apply approved changes".
   *  NOT a raw diff / file content. */
  prTitle?: string;
  /** Deterministic bounded PR body preview (Sprint 3b) — generated-by-Quoky Platform + short hash + head→base +
   *  committed-file COUNT only (NO file paths / diff / content). Audit-stored; NOT sent anywhere in 3b. */
  prBodyPreview?: string;
  /** The approved target repository identity (Sprint 3d-D, ADR-0054) — resolved from reviewed config at PR
   *  APPROVAL time and stored here, so the approval covers the repo, not only head/base. Set at
   *  PR_APPROVAL_PENDING; preserved at PR_APPROVED/PR_CREATED; cleared on deny/cancel. NO token. */
  repositoryIdentity?: RepositoryIdentity;
  /** Set once `status` becomes `PR_CREATED` (Sprint 3d-D) — provider/owner/repo/number/url handle. */
  pullRequestRef?: PullRequestRef;
  /** The created/connected Pull Request number (Sprint 3d-D). */
  pullRequestNumber?: number;
  /** The created/connected Pull Request URL (Sprint 3d-D) — validated github.com html_url. */
  pullRequestUrl?: string;
  /** The PR head branch as reported by the provider (Sprint 3d-D) — == `prHeadBranch`. */
  pullRequestHeadBranch?: string;
  /** The PR base branch as reported by the provider (Sprint 3d-D) — == `prBaseBranch`. */
  pullRequestBaseBranch?: string;
  /** The PR head commit sha as reported by the provider (Sprint 3d-D) — == `prPushedCommitHash`. */
  pullRequestCommitHash?: string;
  /** True when an existing open PR was connected instead of creating a new one (Sprint 3d-D). */
  pullRequestReused?: boolean;
  /** The pending/decided merge-approval ApprovalRequest id (Sprint 3f, ADR-0056) — DISTINCT from
   *  prApprovalId/pushApprovalId/commitApprovalId/approvalId. Set at MERGE_APPROVAL_PENDING; preserved at
   *  MERGE_APPROVED; cleared on deny/cancel. */
  mergeApprovalId?: Id;
  /** When the merge approval was requested (Sprint 3f). Set at MERGE_APPROVAL_PENDING; cleared on deny/cancel. */
  mergeApprovalRequestedAt?: IsoTimestamp;
  /** When the merge approval was recorded (Sprint 3f). Set at MERGE_APPROVED; cleared on deny/cancel. */
  mergeApprovedAt?: IsoTimestamp;
  /** The actor who decided the merge approval (Sprint 3f) — REQUIRED at MERGE_APPROVED (CA change 2); cleared
   *  on deny/cancel. */
  mergeApprovalDecisionBy?: Id;
  /** The RUNTIME record timestamp (Sprint 3g, ADR-0057) — REQUIRED at PR_MERGED: when Quoky Platform recorded or
   *  OBSERVED the merge result during this run (now()), NOT the provider's original merge time (which, on the
   *  already-merged path, may have happened earlier). */
  mergedAt?: IsoTimestamp;
  /** The actor who triggered merge execution (Sprint 3g) — REQUIRED at PR_MERGED. */
  mergeExecutedBy?: Id;
  /** The head SHA that was merged (Sprint 3g) — REQUIRED at PR_MERGED; equals the anchored pullRequestCommitHash. */
  mergedHeadSha?: string;
  /** Provider-reported merge commit SHA (Sprint 3g) — optional (provider-dependent). */
  mergeCommitHash?: string;
  /** The local main commit reached after the post-merge fast-forward (Sprint 3h, ADR-0058) — REQUIRED at
   *  MAIN_SYNCED; equals the expected remote main tip (== mergeCommitHash). */
  syncedMainCommit?: string;
  /** The RUNTIME record timestamp of the local main sync (Sprint 3h) — REQUIRED at MAIN_SYNCED (now()). */
  mainSyncedAt?: IsoTimestamp;
  /** The local ref synchronized (Sprint 3h) — REQUIRED at MAIN_SYNCED (always 'main' per PR_BASE_BRANCH_POLICY). */
  mainSyncBranch?: string;
  /** Which sync strategy ran (Sprint 3h, CA change 1) — REQUIRED at MAIN_SYNCED. */
  syncMode?: 'checked-out-main' | 'ref-only';
  /** Whether the fast-forward moved the working tree (Sprint 3h, CA change 1) — REQUIRED at MAIN_SYNCED; true only
   *  in checked-out-main mode. */
  workingTreeUpdated?: boolean;
  /** The local main commit BEFORE the fast-forward (Sprint 3h, CA change 3) — REQUIRED at MAIN_SYNCED (CAS base). */
  previousMainCommit?: string;
  /** Which cleanup scope ran (Sprint 3i, ADR-0059) — REQUIRED at BRANCH_CLEANED; ALWAYS 'local' in 3i
   *  ('remote'/'local-and-remote' reserved for a future gated sprint). */
  branchCleanupMode?: 'local' | 'remote' | 'local-and-remote';
  /** The branch targeted for cleanup (Sprint 3i) — REQUIRED at BRANCH_CLEANED; == the anchored PR head branch. */
  cleanedBranch?: string;
  /** The RUNTIME record timestamp of the cleanup (Sprint 3i) — REQUIRED at BRANCH_CLEANED (now()). */
  branchCleanedAt?: IsoTimestamp;
  /** The actor who triggered cleanup (Sprint 3i) — REQUIRED at BRANCH_CLEANED. */
  branchCleanedBy?: Id;
  /** Whether a LOCAL ref was deleted this run (Sprint 3i) — REQUIRED at BRANCH_CLEANED; false when already absent. */
  cleanedLocalBranch?: boolean;
  /** Whether a REMOTE branch was deleted (Sprint 3i) — REQUIRED at BRANCH_CLEANED; false in 3i and stays false through
   *  Sprint 3j-A (remote deletion is performed in 3j-B only). */
  cleanedRemoteBranch?: boolean;
  /** The pending/decided remote-branch-cleanup ApprovalRequest id (Sprint 3j-A, ADR-0060) — DISTINCT from
   *  mergeApprovalId/prApprovalId/pushApprovalId/commitApprovalId/approvalId. Set at REMOTE_BRANCH_CLEANUP_PENDING;
   *  preserved at REMOTE_BRANCH_CLEANUP_APPROVED; cleared on deny/cancel. */
  remoteBranchCleanupApprovalId?: Id;
  /** When the remote-branch-cleanup approval was requested (Sprint 3j-A). Set at REMOTE_BRANCH_CLEANUP_PENDING;
   *  cleared on deny/cancel. */
  remoteBranchCleanupApprovalRequestedAt?: IsoTimestamp;
  /** When the remote-branch-cleanup approval was recorded (Sprint 3j-A). Set at REMOTE_BRANCH_CLEANUP_APPROVED;
   *  cleared on deny/cancel. */
  remoteBranchCleanupApprovedAt?: IsoTimestamp;
  /** The actor who decided the remote-branch-cleanup approval (Sprint 3j-A) — REQUIRED at
   *  REMOTE_BRANCH_CLEANUP_APPROVED; cleared on deny/cancel. */
  remoteBranchCleanupApprovalDecisionBy?: Id;
  /** Which remote cleanup scope ran (Sprint 3j-B, ADR-0060) — REQUIRED at REMOTE_BRANCH_CLEANED; always 'remote'. */
  remoteBranchCleanupMode?: 'remote';
  /** The remote branch deleted/targeted (Sprint 3j-B) — REQUIRED at REMOTE_BRANCH_CLEANED; == the anchored PR head branch. */
  cleanedRemoteBranchName?: string;
  /** The RUNTIME record timestamp of the remote cleanup (Sprint 3j-B) — REQUIRED at REMOTE_BRANCH_CLEANED (now()). */
  remoteBranchCleanedAt?: IsoTimestamp;
  /** The actor who executed the remote cleanup (Sprint 3j-B) — REQUIRED at REMOTE_BRANCH_CLEANED. */
  remoteBranchCleanedBy?: Id;
  /** The hosting provider the remote branch was deleted from (Sprint 3j-B) — REQUIRED at REMOTE_BRANCH_CLEANED. */
  remoteBranchCleanupProvider?: RepositoryIdentity['provider'];
  /** The commit the deleted remote branch pointed at (Sprint 3j-B) — set when a delete happened (== expected head commit). */
  remoteBranchDeletedCommit?: string;
}

/**
 * Cross-turn apply-preview mechanics (Sprint 2s, ADR-0040), confined behind one collaborator exactly
 * like ApprovalFlow/ScopeClarificationFlow — so the runtime stays stateless and the correlation source
 * is wired once.
 */
export interface ApplyPreviewFlow {
  /** Derive the session's apply-preview anchor, if any and still valid (project unchanged). A returned
   *  anchor is not always "pending" anything — it may be `ELIGIBLE` or already `APPROVED`; callers
   *  branch on `.status`. */
  findAnchor(session: Session): Promise<ApplyPreviewAnchor | null>;
  /** Anchor (or re-anchor, on every status transition) the apply-preview fact set. Always creates a
   *  fresh Task and re-points `session.activeTaskId` — same shape as the other two flows. */
  anchor(session: Session, anchor: ApplyPreviewAnchor): Promise<void>;
  /** Consume/clear the anchor — called only on deny/cancel (approving re-anchors as `APPROVED` instead).
   *  A no-op unless `session.activeTaskId` still points at THIS flow's own anchor Task. */
  clear(session: Session): Promise<void>;
}

export interface ConversationRuntimeDeps {
  readonly dispatchCommit: Pick<import('./provider-dispatch-commit-coordinator').ProviderDispatchCommitCoordinator, 'commit'>;
  readonly actors: { resolveFromContext(context: ConversationContext): Promise<Actor> };
  readonly sessions: {
    openForContext(context: ConversationContext, actorId: Id): Promise<Session>;
    touch(session: Session): Promise<Session>;
    /** Close the session on a reset (ADR-0093) — `SessionManager.close`, saved as `SessionStatus.CLOSED`. */
    close(session: Session): Promise<Session>;
  };
  readonly memory: {
    recordShortTerm(message: InboundMessage, sessionId?: Id): Promise<{ id: Id }>;
    recordAssistant(text: string, context: ConversationContext, sessionId?: Id): Promise<unknown>;
    recordToolMemory(text: string, opts: { projectId?: Id; sessionId?: Id }): Promise<unknown>;
  };
  /** Required durable-memory activation policy collaborator (M2, ADR-0073). */
  readonly memoryWriter: MemoryWriter;
  /** `ctx.hasActiveProject` lets the classifier keep bare code/test/analysis keywords as chat when no project
   *  is active (Personal v1). */
  readonly classifier: { classify(message: InboundMessage, ctx?: IntentClassifyContext): Promise<Intent> };
  readonly projects: {
    register(path: string, session: Session): Promise<{ ok: boolean; message: string; project?: { id: Id } }>;
    get(id: Id): Promise<Project | null>;
  };
  readonly analyzer: {
    prepare(session: Session): Promise<{ ready: boolean; message?: string; readout?: ProjectReadout }>;
  };
  readonly tasks: {
    createTask(
      intent: Intent,
      context: ConversationContext,
      anchor: { requestText: string; actorId: Id; sessionId: Id; projectId?: Id },
    ): Promise<Task>;
    transition(task: Task, to: TaskStatus): Promise<Task>;
    startRun(task: Task, capability: Capability): Promise<TaskRun>;
    completeRun(
      run: TaskRun,
      opts: { artifactIds: Id[]; providerId?: string; metadata?: Metadata },
    ): Promise<unknown>;
    failRun(
      run: TaskRun,
      summary: string,
      opts: { providerId?: string; metadata?: Metadata },
    ): Promise<unknown>;
  };
  readonly workspace: {
    prepare(task: Task): Promise<WorkspaceRef | undefined>;
    open(project: { id: Id; rootPath: string }): Promise<WorkspaceRef>;
    /** Reused for target-scope validation (Sprint 2o, ADR-0036) — not a new port/capability. */
    list(ref: WorkspaceRef, glob?: string): Promise<string[]>;
    /** Reused for post-approval diff preview (Sprint 2r, ADR-0039) — not a new port/capability; the
     *  same read-only WorkspaceManager.diff() ExecutionOrchestrator's WORKSPACE_DIFF stage uses. */
    diff(ref: WorkspaceRef, changes: ProposedChange[]): Promise<WorkspaceDiff>;
    /** Reused for code-generation preview context (QA-012) — a type-only widening, not a new
     *  port/capability: the same already-registered read-only WorkspaceManager.read() (CAP-001,
     *  sandboxed; refuses secret/binary/oversized/out-of-root files). The AI request carries no cwd
     *  (CAP-008 MB-2), so a target's current content reaches the provider only as `contextFiles`. */
    read(ref: WorkspaceRef, relPath: string): Promise<string>;
  };
  readonly commandExecutions: { get(id: Id): Promise<CommandExecution | null> };
  /** Reused for post-apply validation (Sprint 2v, ADR-0043) — the SAME already-registered
   *  CommandExecutionManager ExecutionOrchestrator depends on and the runtime already reads via
   *  `commandExecutions`. The ONLY thing that runs a command; allow-list/dangerous-arg/risk/Ref-gated. On
   *  this path it only ever runs `pnpm test`/`pnpm typecheck` (derived from the validation intent, never
   *  user text); it never spawns a shell, calls git, or mutates a file. */
  readonly command: { run(input: RunCommandInput): Promise<CommandExecution> };
  readonly contextBuilder: { build(task: Task, excludeMemoryIds: Id[]): Promise<ContextBundle> };
  /** ADR-0100 D8: the readout is widened by type only to carry a work summary's external-work readout. */
  readonly promptComposer: {
    compose(task: Task, bundle: ContextBundle, readout?: ProjectReadout | ExternalWorkReadout): PromptSpec;
  };
  readonly promptRenderer: {
    render(
      spec: PromptSpec,
      opts: { capability: Capability; workspace?: WorkspaceRef; metadata?: Readonly<Record<string, unknown>> },
    ): AiRequest;
  };
  readonly router: { select(capability: Capability): Promise<AiProvider> };
  /** Optional Slice 5A seam. Only TaskRun-backed GENERAL_CHAT work turns may use it. */
  readonly runtimeProviderRouting?: RuntimeProviderRouting;
  readonly artifacts: { persistAll(taskId: Id, runId: Id, artifacts: Artifact[]): Promise<Id[]> };
  readonly composer: ResponseComposer;
  /** Read-only, rebuildable personal-work projection. Replaces the unused legacy `risk` dependency (31 → 31). */
  readonly workSurface: { forActor(actor: Actor): Promise<WorkSurface> };
  readonly intentResolver: {
    resolve(intent: Intent, context: IntentResolutionContext): ExecutionRequest | null;
    isExecution(intent: Intent): boolean;
  };
  readonly orchestrator: {
    run(request: ExecutionRequest, cancelToken?: CancelToken): Promise<ExecutionOutcome>;
    resume(request: ExecutionRequest, prior: ExecutionOutcome, cancelToken?: CancelToken): Promise<ExecutionOutcome>;
  };
  readonly approvals: {
    decide(approvalId: Id, decision: ApprovalDecision): Promise<ApprovalRequest>;
    /** Reused for the ambiguous-retry prompt on the apply gate (Sprint 2s) — a type-only widening, not
     *  a new method (`ApprovalManager.get` already exists). */
    get(approvalId: Id): Promise<ApprovalRequest | null>;
    /** Reused for the second (apply) approval (Sprint 2s, ADR-0040) — not a new capability/port; the
     *  same already-registered ApprovalManager instance already implements this. */
    requestForRisk(input: {
      executionPlanRef: ExecutionPlanRef;
      riskLevel: RiskLevel;
      reason: string;
      requestedBy: string;
    }): Promise<ApprovalRequest>;
  };
  readonly approvalFlow: ApprovalFlow;
  readonly scopeClarificationFlow: ScopeClarificationFlow;
  readonly applyPreviewFlow: ApplyPreviewFlow;
  /** Reused for post-approval preview generation (Sprint 2q, ADR-0038) — not a new capability/port. */
  readonly codeGeneration: {
    generate(input: GenerateCodeInput): Promise<CodeGeneration>;
    getProposal(generation: CodeGeneration): Promise<CodeProposal | null>;
  };
  /** Reused for PatchSet generation (Sprint 2t, ADR-0041) — the same already-registered PatchManager
   *  ExecutionOrchestrator already depends on. Representation-only (CAP-005); never applies.
   *  `get` (Sprint 2u) loads the generated PatchSet from anchor.patchRef — PatchManager.get already
   *  exists; a type-only widening, not a new method. */
  readonly patch: {
    generate(input: PatchGenerationInput): Promise<PatchSet>;
    get(id: Id): Promise<PatchSet | null>;
  };
  /** Read-only load of the approved CodeProposal by ref (Sprint 2t) — backed by storage.codeProposals,
   *  already in the runtime factory's scope. Not a new port. */
  readonly codeProposals: { get(id: Id): Promise<CodeProposal | null> };
  /** Reused for the first real file mutation (Sprint 2u, ADR-0042) — the same already-registered
   *  WorkspaceWriteManager ExecutionOrchestrator already depends on. The ONLY thing that mutates files;
   *  Ref-gated, never queries ApprovalManager, never calls git/command execution. */
  readonly workspaceWrite: {
    apply(input: ApplyInput): Promise<WorkspaceChange>;
    /** All-or-nothing change-set apply (ADR-0099 D2) — the same WorkspaceWriteManager, same Ref gate. Used for
     *  every change set other than the single-`update` ADR-0042 shape. Optional only so narrow fakes that never
     *  reach a change set need not stub it; when absent a change set fails closed before any write. */
    applyChangeSet?(input: ApplyInput): Promise<WorkspaceChange>;
  };
  /** Reused for the read-only post-apply git preview (Sprint 2w, ADR-0044) — the already-registered
   *  GitManager (CAP-002). READ-ONLY: `status` is unchanged; `diff` is a new read-only extension. The
   *  runtime never shells out to git and never calls a mutating git operation on this path. */
  readonly git: {
    status(rootPath: string): Promise<GitStatus>;
    diff(rootPath: string): Promise<GitDiff>;
    /** Reused for approved exact-file git commit (Sprint 2y, ADR-0046) — the same already-registered
     *  GitManager. The ONLY git mutation; Ref-gated (APPROVED), commits exactly the approved tracked files,
     *  never pushes. `newFiles` (ADR-0099 D3) ⊆ `files` are the approved untracked new-file targets — the only
     *  paths the provider `git add`s (exact pathspecs); omitted when there are none (no `git add` at all). */
    commitFiles(input: {
      rootPath: string;
      files: string[];
      message: string;
      approvalRef: ApprovalRef;
      newFiles?: string[];
    }): Promise<GitCommitResult>;
    /** Reused for read-only push-approval inspection (Sprint 2z, ADR-0047) — `GitManager.info` already
     *  exists (branch/headSha/detached). READ-ONLY, no network fetch, no mutation; a type-only widening. */
    info(rootPath: string): Promise<RepositoryInfo>;
    /** Reused for the approved git push (Sprint 3a, ADR-0048) — the same already-registered GitManager. The
     *  ONLY remote mutation; Ref-gated (APPROVED), pushes exactly the approved commit to the approved
     *  upstream (`git push <remote> HEAD:<branch>`), never force/tags/all/-u, never a PR/deploy. */
    pushApprovedCommit(input: { rootPath: string; remote: string; branch: string; commitHash: string; approvalRef: ApprovalRef }): Promise<GitPushResult>;
    /** Post-merge LOCAL main synchronization (Sprint 3h, ADR-0058) — the same already-registered GitManager.
     *  Fast-forward-only; NO ApprovalRef (local, non-destructive, gated by PR_MERGED + explicit command +
     *  preflight). The runtime calls this ONLY — never the provider primitives, never shells to git. */
    syncMain(input: { rootPath: string; remote: string; branch: string; expectedRemoteCommit: string }): Promise<GitMainSyncResult>;
    /** Post-merge LOCAL branch cleanup (Sprint 3i, ADR-0059) — the same already-registered GitManager. Safe CAS
     *  delete of the anchored merged feature branch; NO ApprovalRef (local, recoverable, gated by MAIN_SYNCED +
     *  explicit command + preflight). The runtime calls this ONLY — never the provider, never shells to git. */
    deleteMergedLocalBranch(input: { rootPath: string; branch: string; expectedMainCommit: string }): Promise<GitBranchCleanupResult>;
  };
  /**
   * Repository Hosting (CAP-010, Sprint 3d-D, ADR-0054) — actual PR creation execution. OPTIONAL: absent/empty
   * when not configured. `identity` is the reviewed config identity (from RepositoryIdentityResolver at
   * composition; independent of token). `manager` is the `RepositoryHostingManager` — present ONLY when a
   * GitHub token is configured (so the adapter could be constructed); when absent, PR creation execution is
   * "not configured" and fails safe. The runtime calls `manager.createPullRequest` ONLY — NEVER the provider
   * directly, and receives NO token.
   */
  readonly repositoryHosting?: {
    identity?: RepositoryIdentity;
    manager?: {
      createPullRequest(input: {
        identity: RepositoryIdentity;
        headBranch: string;
        baseBranch: string;
        title: string;
        body: string;
        expectedCommitHash: string;
        approvalRef: ApprovalRef;
      }): Promise<PullRequestResult>;
      /** Read-only PR status preview (Sprint 3e, ADR-0055) — no ApprovalRef, no mutation, no state change. */
      getPullRequestStatus(input: {
        identity: RepositoryIdentity;
        pullRequestRef: PullRequestRef;
        expectedHeadBranch: string;
        expectedBaseBranch: string;
        expectedCommitHash: string;
      }): Promise<PullRequestStatusPreview>;
      /** PR merge execution (Sprint 3g, ADR-0057) — the Manager consumes the ApprovalRef + runs the live
       *  preflight; the runtime calls this ONLY (never the provider), passes NO token. */
      mergePullRequest(input: {
        identity: RepositoryIdentity;
        pullRequestRef: PullRequestRef;
        expectedHeadBranch: string;
        expectedBaseBranch: string;
        expectedHeadSha: string;
        approvalRef: ApprovalRef;
      }): Promise<PullRequestMergeResult>;
      /** Remote branch cleanup execution (Sprint 3j-B, ADR-0060) — the Manager consumes the ApprovalRef + runs the
       *  live preflight + the single GitHub refs DELETE; the runtime calls this ONLY (never the provider), passes NO
       *  token. */
      deleteRemoteBranch(input: {
        identity: RepositoryIdentity;
        pullRequestRef: PullRequestRef;
        expectedHeadBranch: string;
        expectedBaseBranch: string;
        branch: string;
        expectedCommitHash: string;
        approvalRef: ApprovalRef;
      }): Promise<RemoteBranchCleanupResult>;
    };
  };
  /**
   * Deterministic turn-handler registry (ADR-0096; amends ADR-0032: baseline 32 → 33). OPTIONAL: absent/empty
   * keeps every turn exactly as before. The runtime only dispatches, at three fixed points in `handleInner`;
   * each handler's state and mutation authority stay with its owning capability service. Duplicate ids are
   * rejected at construction; dispatch order is `(stage, order, id)`.
   */
  readonly turnHandlers?: readonly ConversationTurnHandler[];
  /**
   * One-time, hash-bound CRITICAL owner override for a credential-guard refusal in the code-change preview
   * (ADR-0097; amends ADR-0032: baseline 33 → 34). OPTIONAL: when absent every credential refusal stays terminal
   * (fail closed) and no override phrase is recognized.
   */
  readonly credentialOverrideFlow?: CredentialOverrideFlow;
  readonly logger: Logger;
}

/**
 * Runtime options that are not collaborators (so they stay outside the dispatch-boundary deps count).
 * `clock` is the shared clock for the pending-approval lifetime (ADR-0093) — the expiry check and the
 * `decidedAt` of an expiry/reset denial. Omitted → the shared `util/clock` `now()`; tests inject a fixed one.
 */
export interface ConversationRuntimeOptions {
  readonly clock?: () => IsoTimestamp;
  /**
   * Whether remote git operations (push etc.) are enabled for this deployment (Personal v1:
   * `QUOKY_GIT_REMOTE_ENABLED`, default false; ADR-0094). Display-only here — it picks truthful copy for an
   * unsupported push request (QA-020); the composition-root git guard remains the enforcement point.
   */
  readonly gitRemoteEnabled?: boolean;
  /**
   * Whether the merge chain (PR merge, main sync, post-merge local and remote branch cleanup) is enabled
   * (`QUOKY_GIT_MERGE_ENABLED`, default false; ADR-0099 D5). Display-only, like `gitRemoteEnabled`: when false a
   * merge request at `PR_CREATED` gets the fixed "merge disabled" reply BEFORE any merge approval is created. The
   * composition-root `PersonalHostingGuard` / `PersonalGitGuard` remain the enforcement points.
   */
  readonly gitMergeEnabled?: boolean;
}

/**
 * The approval currently holding a conversation, if any (ADR-0093): the plan-scoped approval derived by
 * `approvalFlow` (ADR-0032), or the PENDING request behind an apply-preview anchor's `*_PENDING` status
 * (ADR-0040…0060). `planPending`/`pendingScope`/`applyAnchor` are the lookups the routing below reuses, so no
 * flow is queried twice in one turn.
 */
interface PendingApprovalLookup {
  planPending: ApprovalRequest | null;
  /** Looked up only when no plan-scoped approval is pending (ADR-0037 ordering is unchanged). */
  pendingScope: PendingScopeClarification | null;
  /** Looked up only when neither a plan-scoped approval nor a scope clarification is pending. */
  applyAnchor: ApplyPreviewAnchor | null;
  /**
   * The session's credential-override set (ADR-0097), looked up after the scope clarification and before the
   * apply-preview anchor (the same session pointer, so at most one of them is ever set).
   */
  override: CredentialOverrideLookup | null;
  pending: ApprovalRequest | null;
}

/** A code-change preview's refs, targets and prepared (read, classified, grant-checked) context content. */
interface PreparedCodeGeneration {
  readonly planRef: ExecutionPlanRef;
  readonly workspaceRef: WorkspaceRef;
  readonly targetFiles: string[];
  readonly contextFiles: ContextFile[];
}

type CodeGenerationPreparation =
  | { readonly ok: true; readonly value: PreparedCodeGeneration }
  | { readonly ok: false; readonly failure: 'missing-refs' }
  | {
      readonly ok: false;
      readonly failure: 'context';
      readonly context: Extract<CodeGenerationContextResult, { ok: false }>;
    };

/** The dispatch-time grant view of an anchor's grant records (the shape the flow hands `dispatch`). */
function toDispatchGrants(anchor: CredentialOverrideAnchor): CredentialOverrideGrant[] {
  return anchor.grants.map((g) => ({
    path: g.path, contentSha256: g.contentSha256, detector: g.detector, line: g.line, state: 'CONSUMED' as const,
  }));
}

/** True iff the grants the flow consumed are exactly the grants the dispatched content was prepared under. */
function sameDispatchGrants(
  consumed: readonly CredentialOverrideGrant[],
  prepared: readonly CredentialOverrideGrant[],
): boolean {
  return (
    consumed.length === prepared.length &&
    consumed.every((g, i) => {
      const p = prepared[i]!;
      return (
        normalizeRelativePath(g.path) === normalizeRelativePath(p.path) &&
        g.contentSha256 === p.contentSha256 &&
        g.detector === p.detector &&
        g.line === p.line &&
        g.state === p.state
      );
    })
  );
}

/**
 * A deeply-frozen, plain-data copy of a turn-handler context value (ADR-0096 D1). Arrays and plain objects are
 * copied recursively and frozen; primitives pass through; any other value (function, class instance, Map, Date,
 * a cyclic back-reference) is omitted — the domain values handed to handlers are plain data by construction, so
 * nothing is lost, and nothing a handler does to its copy can reach the runtime's own objects.
 */
function frozenPlainSnapshot<T>(value: T): T {
  const seen = new WeakSet<object>();
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (seen.has(v)) return undefined;
    if (Array.isArray(v)) {
      seen.add(v);
      const out = Object.freeze(v.map((item) => copy(item)));
      seen.delete(v);
      return out;
    }
    const proto = Object.getPrototypeOf(v) as unknown;
    if (proto !== Object.prototype && proto !== null) return undefined;
    seen.add(v);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      const item = copy((v as Record<string, unknown>)[key]);
      if (item !== undefined) out[key] = item;
    }
    seen.delete(v);
    return Object.freeze(out);
  };
  return copy(value) as T;
}

// Approve/deny/cancel decision phrases for pending approvals live in ./approval-decision (whole-token,
// negation-aware); "APPROVE_WORDS" in the comments below refers to that approve phrase set.
const CANCEL_WORDS = ['취소', '중단', '그만'];

/** Explicit apply-only phrases (Sprint 2s, ADR-0040) — "좋아"/"오케이"/"확인"/"괜찮네" must NEVER match;
 *  those stay in APPROVE_WORDS for the ordinary approval flow but are insufficient to authorize file
 *  modification. "이대로 진행" (multi-word) is deliberately distinct from APPROVE_WORDS' bare "진행" —
 *  the two word-sets are non-overlapping by construction, not by coincidence. */
const APPLY_WORDS = ['적용', '반영', '이대로 진행'];

/** Explicit patch phrases (Sprint 2t, ADR-0041) — distinct from APPROVE_WORDS and APPLY_WORDS. CA Round 1
 *  Required Change #2: the ambiguous standalone "계속 진행" is deliberately excluded — a bare "continue"
 *  intent must never be auto-read as PatchSet generation. Every entry is an explicit patch-generation
 *  phrase; "다음 단계 진행" is the full multi-word form (never bare "다음 단계"); "좋아"/"오케이"/"확인"
 *  never match. Combined with routing (generation only on an APPROVED anchor), this enforces:
 *  explicit patch phrase + APPROVED anchor ⇒ generation; a bare "계속 진행" ⇒ never generation. */
const PATCH_WORDS = [
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
const FINAL_APPLY_WORDS = [
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
const GIT_MUTATING_WORDS =
  /(커밋\s*(해|하자|할|하기|하고|하는)|\bcommit\b|푸시|\bpush\b|git\s*add|\badd\s*해|리셋|\breset\b|checkout|체크아웃|stash|스태시|\bbranch\b|브랜치\s*(만들|생성)|merge|머지|rebase|리베이스|\btag\b|태그)/i;
/** Read-only diff-preview phrases (Sprint 2w). */
const GIT_DIFF_WORDS = /(\bdiff\b|디프)/i;
/** Read-only status/changed-files phrases (Sprint 2w) — incl. the CA-approved safe Korean "커밋 전에 …". */
const GIT_STATUS_WORDS = /(git\s*상태|깃\s*상태|git\s*status|\bstatus\b\s*보여|변경\s*파일|변경\s*사항|변경사항|바뀐\s*파일|커밋\s*전)/i;

/** Explicit git-commit request phrases (Sprint 2x, ADR-0045) — qualified; a bare "좋아"/"오케이"/"확인"/
 *  "다음 단계"/"진행해"/"이대로 해" never matches, and bare "커밋 전" (2w status) is excluded (no action verb). */
const COMMIT_WORDS =
  /(커밋\s*(해|하자|할래|준비|승인)|커밋\s*메시지|git\s*commit|commit\s+this|prepare\s+commit|create\s+commit\s+approval)/i;
/** Non-commit git mutations that must NOT ride along with a commit request (Sprint 2x) — a commit bundled
 *  with any of these is rejected (commit-approval planning only). */
const COMMIT_FORBIDDEN_COMPANION =
  /(푸시|\bpush\b|git\s*add|\badd\s*해|리셋|\breset\b|checkout|체크아웃|stash|스태시|\bbranch\b|브랜치|merge|머지|rebase|리베이스|\btag\b|태그)/i;

/** Explicit commit-EXECUTION phrases (Sprint 2y, ADR-0046) — distinct from the 2x commit-approval words. */
const COMMIT_EXECUTION_WORDS =
  /(승인된?\s*커밋\s*실행|커밋\s*실행|이제\s*실제\s*커밋|commit\s+approved\s+changes|execute\s+commit|run\s+approved\s+commit)/i;
/** Non-commit git mutations that must be rejected on the execution path (Sprint 2y) — never a push/commit. */
const COMMIT_EXECUTION_FORBIDDEN =
  /(푸시|\bpush\b|리셋|\breset\b|checkout|체크아웃|stash|스태시|\bbranch\b|브랜치|merge|머지|rebase|리베이스|\btag\b|태그|git\s*add)/i;

/** Explicit git-PUSH phrases (Sprint 2z, ADR-0047) — a bare 좋아/오케이/확인/진행해/다음 단계 never matches.
 *  `푸시`/`push` as a bare token counts (only ever consulted in push-relevant states), so companions like
 *  "푸시하고 배포" are caught by PUSH_FORBIDDEN_COMPANION rather than slipping through as non-push. */
const PUSH_WORDS =
  /(푸시|git\s*push|\bpush\b|원격에\s*올려|리모트에\s*올려|원격으로\s*보내|push\s+this\s+commit|push\s+(the\s+)?approved\s+commit)/i;
/** Force + bundling + other git ops that must NOT ride along with a push (Sprint 2z, CA #2/#5) — only ever
 *  consulted when a PUSH word is already present, so a bare "배포"/"branch"/"tag"/"reset" is NOT push handling. */
const PUSH_FORBIDDEN_COMPANION =
  /(--?force|\bforce\b|강제|(^|\s)-f(\s|$)|(^|\s)\+[\w./-]|--delete\b|(^|\s)-d(\s|$)|(^|\s):[\w./-]|--mirror\b|--all\b|--tags\b|--prune\b|\bpr\b|pull\s*request|풀\s*리퀘|배포|deploy|머지|\bmerge\b|리베이스|rebase|\btag\b|태그|\bbranch\b|브랜치|리셋|\breset\b|checkout|체크아웃|stash|스태시)/i;

/** A push word as the request's own object ("푸시", "git push", "push"). */
const PUSH_TOKEN_SRC = '(?:푸시|git\\s*push|\\bpush\\b)';
/** A Korean request tail attached DIRECTLY to the push word ("푸시해줘", "push 실행해줘", "git push 해 줘"). */
const KO_PUSH_REQUEST_TAIL_SRC =
  '(?:\\s*(?:을|를))?(?:\\s*좀)?\\s*(?:해\\s*줘요?|해\\s*주세요|해\\s*주라|해\\s*줄래요?|해라|해\\s*봐|하자|해|' +
  '실행(?:\\s*해\\s*줘요?|\\s*해\\s*주세요|\\s*해|\\s*하자)?|진행(?:\\s*해\\s*줘요?|\\s*해)?)';
const KO_IMPERATIVE_END_SRC = '(?:해\\s*줘요?|해\\s*주세요|해\\s*주라|해라|하자|해)';
/**
 * Push-request shapes (QA-V2-W8; Codex wave-8 review): the request verb must attach to the push word ITSELF —
 * never a trailing "해줘" elsewhere in the sentence ("git push 명령을 한국어로 번역해줘" / "푸시 로직을 검토해줘" are
 * chat) — or the text is a typed push command, with or without options/remote/refspec ("git push --force origin x").
 */
const PUSH_REQUEST_SHAPES: readonly RegExp[] = [
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
/** Questions / how-to / notification topics that merely mention push are ordinary chat. */
const PUSH_CHAT_TOPIC =
  /[?？]|뭐|무엇|뭔|어떻게|어떤|왜|방법|알려|설명|차이|알림|notification|설정|구현|\bhow\b|\bwhat\b|\bwhy\b|\bexplain\b|\bdifference\b|\bwhen\b/i;

/** Chain states after a successful push (QA-V2-W7-02) — a push phrase here means "already pushed", never a new push. */
const POST_PUSH_CHAIN_STATUSES: ReadonlySet<ApplyPreviewAnchor['status']> = new Set([
  'PR_APPROVED',
  'PR_CREATED',
  'MERGE_APPROVED',
  'PR_MERGED',
  'MAIN_SYNCED',
  'BRANCH_CLEANED',
  'REMOTE_BRANCH_CLEANUP_APPROVED',
  'REMOTE_BRANCH_CLEANED',
]);

/** Branches Personal v1 never commits on (ADR-0094; QA-022 up-front refusal at commit-approval planning). */
const PROTECTED_COMMIT_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/** Bound on user-controllable git ref (remote/branch/upstream) display length (Sprint 2z, CA #6). */
const MAX_GIT_REF_DISPLAY = 80;

/** Explicit git-push-EXECUTION phrases (Sprint 3a, ADR-0048) — distinct from the 2z push-approval words;
 *  a bare 좋아/오케이/확인/진행해/다음 단계 never matches. Only consulted at PUSH_APPROVED / GIT_PUSHED. */
const PUSH_EXECUTION_WORDS =
  /(승인된?\s*(푸시|push)\s*실행|(푸시|push)\s*실행|이제\s*실제\s*(푸시|push)|execute\s+(the\s+)?approved\s+push|run\s+approved\s+push|push\s+approved\s+commit)/i;
/** Deploy-only phrases (Sprint 3b, ADR-0049 — replaces the 3a `PR_DEPLOY_WORDS`) — a bare deploy request
 *  (no PR word) at GIT_PUSHED/PR_APPROVED gets a state-appropriate "deploy not supported" reply. PR phrases
 *  are handled by `interpretPrIntent`, NOT here. */
const DEPLOY_ONLY_WORDS = /(배포|deploy|릴리즈|release)/i;

/** Companion follow-ups that are unsupported once a PR is already created (Sprint 3d-D) — merge/deploy/release/
 *  reviewer/label/assignee. Consulted ONLY at PR_CREATED to answer "that's a future step" (no mutation). */
const PR_CREATED_COMPANION_WORDS =
  /(배포|deploy|릴리즈|release|머지|\bmerge\b|병합|auto\s*-?\s*merge|자동\s*머지|리뷰어|reviewer|라벨|\blabel\b|assignee|담당자)/i;

/** Explicit PR/CI/check/review STATUS-query phrases (Sprint 3e, ADR-0055) — only consulted at PR_CREATED. A
 *  status-context noun (PR/풀리퀘/pull request/CI/체크/check(s)/리뷰/review) AND a query verb (상태/status/확인/
 *  어때/봐/알려/통과/열려) must BOTH be present, in either order. A bare "상태" with no PR/CI/check/review context
 *  never matches (CA Q1); merge/deploy/release/reviewer/label/assignee are NOT status phrases (they route to the
 *  companion-unsupported reply). */
const PR_STATUS_NOUN = /(\bpr\b|풀\s*리퀘|pull\s*request|\bci\b|체크|checks?|리뷰|review)/i;
const PR_STATUS_QUERY = /(상태|status|확인|어때|봐줘|봐|알려|통과(했|돼|되)|열려\s*있|open\s*\?)/i;

/** Explicit merge-APPROVAL / merge phrases (Sprint 3f, ADR-0056) — only consulted at PR_CREATED, AFTER the
 *  status intent. A merge word is required; a merge QUESTION (가능/안전/되나/통과/?/mergeable) is NOT an approval
 *  request; only a merge word + a request/approval/execution verb triggers. "머지해줘" (execution wording) is
 *  treated as a merge-approval REQUEST (Sprint 3f records permission only). */
const MERGE_WORD = /(머지|병합|\bmerge\b)/i;
// A merge SAFETY/POSSIBILITY/STATUS/INSPECTION question (not an approval request) — a possibility/safety word,
// a status/check/inspection word, or a trailing "?". Consulted only when a MERGE_WORD is present, so it never
// affects non-merge phrases. "머지 상태 확인해줘"/"머지 확인해줘"/"머지 체크해줘" are inquiries, NOT approval requests
// (Sprint 3f impl review — the "해줘" request verb must not turn an inquiry into an approval).
const MERGE_QUESTION =
  /(가능|안전|괜찮|되나|되나요|통과|상태|확인|봐줘|봐|알려|체크|\bcheck\b|\bstatus\b|\bmergeable\b|can\s+i|is\s+it|\?)/i;
// An explicit merge approval/execution REQUEST verb ("머지 승인해줘"/"머지해줘"/"머지해도 되게 승인"/"merge this"/"approve merge").
const MERGE_REQUEST_VERB = /(승인|approve|approval|요청|받아|해줘|해\s*줘|해도\s*되게|merge\s+this|이\s*pr\s*머지)/i;
// A merge-EXECUTION verb (Sprint 3g, ADR-0057, CA change 1) — only consulted at MERGE_APPROVED/PR_MERGED, AFTER
// the MERGE_QUESTION status guard. At MERGE_APPROVED the user already passed the CRITICAL merge-approval gate, so
// a direct merge imperative (해줘/실행/실제/지금/승인된/now/execute/merge this/approved) IS an execution command. A
// bare "머지"/"merge" noun (no verb) is NOT execution (→ composeMergeAlreadyApproved).
const MERGE_EXECUTION_VERB = /(해줘|해\s*줘|실제|실행|지금|승인된|\bnow\b|\bexecute\b|merge\s+this|\bapproved\b)/i;
// (Codex wave-8 review) the execution verb must attach to the merge word itself ("머지해줘", "머지 실행해줘", "merge
// this PR", "merge now", "execute merge") — a trailing "해줘" on another verb ("머지 로그 요약해줘") is never a merge.
const MERGE_EXECUTION_ATTACHED =
  /((머지|병합)\s*(을|를)?\s*(좀\s*)?(해|실행|진행|하자|시켜)|\bmerge\s+(this|it|the|now|pr|approved)\b|\b(execute|run|do)\s+(the\s+)?(approved\s+)?merge\b|\bapproved\s+merge\b)/i;
// Chain verbs foreign to the merge step (Codex wave-8 review): a merge bundled with push/deploy/sync/branch-delete/
// force/reset/rebase is never a merge-EXECUTION command.
const MERGE_EXECUTION_FOREIGN =
  /(푸시|\bpush|배포|deploy|릴리즈|release|동기화|최신화|\bsync\b|\bpull\b(?!\s*request)|삭제|지워|제거|정리|\bdelete\b|\bremove\b|clean\s*up|\bcleanup\b|리베이스|rebase|리셋|\breset\b|강제|\bforce\b)/i;
// Post-merge LOCAL main sync (Sprint 3h, ADR-0058) — only consulted at PR_MERGED/MAIN_SYNCED. A sync command needs
// a sync VERB (동기화/최신화/받아와/sync/pull/update ... main) AND a MAIN target — a bare "sync"/"pull" or a bare "main"
// alone never triggers.
const SYNC_WORD = /(동기화|최신화|받아와|받아\s*줘|\bsync\b|\bpull\b(?!\s*request)|update\s+(local\s+)?main|당겨)/i;
// Chain verbs foreign to the main sync step (Codex wave-8 review): push / pull-request / branch delete / deploy / force.
const SYNC_FOREIGN =
  /(푸시|\bpush|pull\s*request|풀\s*리퀘|삭제|지워|제거|\bdelete\b|\bremove\b|배포|deploy|릴리즈|release|리베이스|rebase|리셋|\breset\b|강제|\bforce\b)/i;
const MAIN_WORD = /(\bmain\b|메인|origin\/main)/i;
/** The origin to sync local main from (github.com origin; fixed like PR_BASE_BRANCH_POLICY). */
const MAIN_SYNC_REMOTE = 'origin';
// Post-merge LOCAL branch cleanup (Sprint 3i, ADR-0059) — only consulted at MAIN_SYNCED/BRANCH_CLEANED. A cleanup
// command needs a cleanup VERB + a BRANCH word. A REMOTE qualifier routes to the "unsupported" reply (remote
// deletion deferred); bulk/wildcard and a "main"-delete target never trigger.
const CLEANUP_VERB = /(정리|삭제|제거|지워|지우|없애|\bcleanup\b|clean\s*up|\bdelete\b|\bremove\b|\bprune\b)/i;
const CLEANUP_BRANCH_WORD = /(브랜치|\bbranch\b)/i;
const CLEANUP_REMOTE_WORD = /(원격|\bremote\b|\borigin\b|github)/i;
const CLEANUP_BULK = /(다\s*(삭제|지워|정리)|전부|모두|\ball\b|every|\*|패턴|pattern|wildcard)/i;
const CLEANUP_MAIN_TARGET = /(^|\s)(main|메인|master|default(\s*branch)?|기본\s*브랜치)\s*(브랜치)?\s*(삭제|지워|delete|remove)/i;
// Remote-branch-cleanup EXECUTION verb (Sprint 3j-A, ADR-0060) — only consulted at REMOTE_BRANCH_CLEANUP_APPROVED, to
// route an execute imperative to the "execution is a future step (3j-B)" reply. A re-request (원격 브랜치 삭제해줘) is
// caught first by interpretRemoteBranchCleanupIntent, so this needs only the pure execute verbs.
const REMOTE_CLEANUP_EXECUTE_VERB = /(실행|진행|지금|승인된|\bexecute\b|\bproceed\b|\bnow\b|go\s*ahead)/i;
// A bare execute command with no other content ("실행해줘", "진행해", "proceed", "go ahead") — the only cleanup-execution
// form without a cleanup verb (Codex wave-8 review: "지금 몇 시야?" / "진행 상황 알려줘" must never delete a branch).
const REMOTE_CLEANUP_BARE_EXECUTE =
  /^((이제|지금|바로)\s*)*(실행|진행)\s*(해\s*줘요?|해\s*주세요|해|하자|해라|할게|시켜\s*줘)?\s*[.!~]*$|^(please\s+)?(proceed|execute|go\s*ahead|do\s+it)(\s+(it|now))?(\s+please)?\s*[.!]*$/i;
// Chain verbs foreign to a branch-cleanup step (Codex wave-8 review): a push / merge / PR / sync / commit / deploy /
// force phrase is never a branch cleanup — "execute approved push" must not reach the remote DELETE. "머지된 브랜치" /
// "merged branch" are qualifiers, not merge verbs.
const CLEANUP_FOREIGN_CHAIN_WORD =
  /(푸시|\bpush|원격에\s*올려|리모트에\s*올려|머지(?!\s*된)|병합(?!\s*된)|\bmerge\b|\bpr\b|pull\s*request|풀\s*리퀘|동기화|최신화|\bsync\b|\bpull\b|커밋|\bcommit\b|배포|deploy|릴리즈|release|리베이스|rebase|리셋|\breset\b|강제|\bforce\b|\btag\b|태그)/i;
// A statement / question / report about a cleanup is never a cleanup request (Codex wave-8 review): "브랜치 삭제했어",
// "브랜치 정리 완료", "브랜치 삭제 로그를 요약해줘", "원격 브랜치 상태 알려줘".
const CLEANUP_NOT_A_REQUEST =
  /[?？]|(삭제|정리|제거)\s*(했|됐|되었|됨|완료|끝)|지웠|없앴|뭐|무엇|어떻게|왜|방법|설명|요약|보여|알려|로그|기록|이력|상태|확인|체크|\bhow\b|\bwhat\b|\bwhy\b|\bsummar|\bshow\b|\blogs?\b|\bexplain\b|\bstatus\b|\bcheck\b|\bdeleted\b|\bremoved\b/i;

/** A PR-ish noun (Sprint 3b, ADR-0049) — only ever consulted at GIT_PUSHED/PR_APPROVAL_PENDING/PR_APPROVED.
 *  A bare 좋아/오케이/확인/진행해/다음 단계 never matches. A noun ALONE is not a PR-creation request (CA #1). */
const PR_WORD = /(\bpr\b|pull\s*request|풀\s*리퀘|merge\s*request|\bmr\b)/i;
/** Explicit PR-CREATION phrases (Sprint 3b, Q4 — CA #1/#2/#3): a PR-ish noun REQUIRES a create/open verb.
 *  Covers Korean spacing/order incl. "깃허브 PR 만들어줘" (CA #2) and "merge request 만들어줘"/"create merge
 *  request" (CA #3). A bare "PR"/"GitHub PR"/"pull request"/"merge request" is NOT sufficient (CA #1). */
const PR_CREATION_WORDS =
  /((깃허브\s*)?(\bpr\b|pull\s*request|풀\s*리퀘|merge\s*request|\bmr\b)\s*(만들|생성|열|올려)|github\s*pr\s*(만들|생성|열|올려)|open\s+(a\s+)?(pr|pull\s*request|merge\s*request)|create\s+(a\s+)?(pr|pull\s*request|merge\s*request))/i;
/** Companions that must NOT ride along with a PR request (Sprint 3b, Constraint 10 / Q5 / CA #5) — only ever
 *  consulted when a PR word is present (2z CA #2 lesson). `\bmerge\b(?!\s*request)` keeps the GitLab synonym
 *  "merge request" a CREATE phrase while catching "auto merge" / "PR 만들고 merge". */
const PR_FORBIDDEN_COMPANION =
  /(배포|deploy|auto\s*-?\s*merge|자동\s*머지|\bmerge\b(?!\s*request)|머지|병합|릴리즈|release|--?force|강제|\bforce\b|(^|\s)-f(\s|$)|리셋|\breset\b|checkout|체크아웃|stash|스태시|rebase|리베이스|\btag\b|태그|브랜치\s*생성|create\s+branch)/i;

/** Fixed PR base-branch product policy for Quoky Platform V2 (Sprint 3b, Q6/CA #6/#11 — CA option C). RepositoryInfo
 *  exposes NO default branch and no config default-branch source exists, so the base branch is a STATED PRODUCT
 *  POLICY, not an inferred/user-provided value. Revisit if a safer configured default-branch source is added. */
const PR_BASE_BRANCH_POLICY = 'main';
/** Bounded PR subject length (Sprint 3b, CA #4). */
const MAX_PR_TITLE = 100;
/** Defensive bound on the PR body preview length (Sprint 3b, CA #5). */
const MAX_PR_BODY = 1000;
/** Fixed PR title fallback when `instruction` is empty/blank after sanitization (Sprint 3b, CA #4). */
const PR_TITLE_FALLBACK = 'Apply approved changes';

/** Git-commit display/approval bounds (Sprint 2x, CA #7). */
const MAX_COMMIT_OUT_OF_SCOPE_SHOWN = 10;
const MAX_COMMIT_CANDIDATE_FILES = 30;
// Commit-message bounds/validation are shared with GitManager (Sprint 2y) — see ./commit-message.

/**
 * Defensively normalize a git-status path to a safe project-relative path, or `null` when it is absolute,
 * contains a `..` traversal, is empty, or is otherwise not safely representable (Sprint 2x, CA #6). A `null`
 * path is never trusted — the caller surfaces it as out-of-scope and refuses to create a commit approval.
 */
function safeRelativePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) return null; // absolute (POSIX `/…` or Windows `C:\…`)
  const normalized = normalizeRelativePath(trimmed);
  if (normalized.length === 0) return null;
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * Compose the HIGH commit-approval `reason` string (Sprint 2x, ADR-0045, CA #4/#11). Names the operation,
 * workspace, bounded candidate files, commit message, validation context, and that this records permission
 * only — actual git add/commit/push is NOT executed in Sprint 2x. NO raw diff / file content.
 */
function buildCommitApprovalReason(
  workspaceRef: WorkspaceRef,
  candidateFiles: string[],
  commitMessage: string,
  validation: { command: string; status: string } | 'unavailable' | 'none',
  newFiles: readonly string[] = [],
): string {
  const shown = candidateFiles.slice(0, MAX_COMMIT_CANDIDATE_FILES);
  const omitted = candidateFiles.length - shown.length;
  // ADR-0099 D3: a new file is marked so the approval covers the `git add` it implies.
  const isNew = new Set(newFiles);
  const files = `${shown.map((f) => (isNew.has(f) ? `${f} (new file)` : f)).join(', ')}${omitted > 0 ? ` (외 ${omitted}개 생략)` : ''}`;
  const validationText =
    validation === 'none'
      ? 'no post-apply validation on record'
      : validation === 'unavailable'
        ? 'validation record could not be resolved'
        : `latest validation: ${validation.command} ${validation.status}`;
  return [
    'operation: git commit approval planning',
    `workspaceRef: ${workspaceRef.id}`,
    `candidate files: ${files}`,
    `proposed commit message: ${commitMessage}`,
    validationText,
    'risk: HIGH',
    'no git add/commit/push has been performed',
    'this approval records permission only; actual git add/commit/push is NOT executed in Sprint 2x — future execution requires a separate step',
  ].join('\n');
}

/** Bound + strip a user-controllable git ref for display (Sprint 2z, CA #6) — trims, drops control chars,
 *  caps length. Never lets a raw/unbounded/control-char branch string reach a reason or reply. */
function boundGitRef(ref: string): string {
  return [...ref.trim()].filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('').slice(0, MAX_GIT_REF_DISPLAY);
}

/**
 * Split + validate an upstream tracking ref into `<remote>/<branch>` on the FIRST '/' (Sprint 2z, ADR-0047,
 * CA #5). Returns `null` (→ block approval) when the ref is empty, over-long, has control chars, has no
 * '/', or has an empty remote/branch, or a remote containing whitespace. `branch` may contain '/' (e.g.
 * `feature/x`). Read-only; no git call.
 */
function parsePushUpstream(upstream: string): { remote: string; branch: string } | null {
  // ADR-0099 D5: one parser for approval, execution and the PR step (the pure push-target resolver's).
  return parsePushUpstreamRef(upstream);
}

/**
 * Compose the CRITICAL push-approval `reason` (Sprint 2z, ADR-0047, CA #4/#6/#7/#13). Names the operation,
 * commit sha, bounded remote/branch/upstream, ahead count, that NO push has run, that this records
 * permission only (NOT executed in Sprint 2z; future execution needs a separate step), and the point-in-time
 * caveat. NO raw diff/file content and NO validation/test "push-ready" context (CA #13).
 */
function buildPushApprovalReason(input: {
  commitHash: string;
  remote: string;
  branch: string;
  upstream: string;
  ahead?: number;
  mode?: PushMode;
}): string {
  const target =
    input.mode === 'new-remote-branch'
      ? [
          'mode: new remote branch (the branch has no upstream; the first push creates it on the remote)',
          `remote: ${boundGitRef(input.remote)}`,
          `branch: ${boundGitRef(input.branch)}`,
          `creates: ${boundGitRef(input.upstream)}`,
          'no force push; no upstream (tracking) configuration; no fetch',
        ]
      : [
          `remote: ${boundGitRef(input.remote)}`,
          `branch: ${boundGitRef(input.branch)}`,
          `upstream: ${boundGitRef(input.upstream)}`,
          `ahead: ${input.ahead ?? 0}`,
        ];
  return [
    'operation: git push approval planning',
    `commit: ${input.commitHash}`,
    ...target,
    'risk: CRITICAL',
    'no git push has been performed',
    'this approval records permission only; actual git push is NOT executed in Sprint 2z — future execution requires a separate step',
    'this is a point-in-time snapshot; the branch is not guaranteed pushable later — future push execution must re-read Git state before pushing',
  ].join('\n');
}

/**
 * Deterministic bounded PR title (Sprint 3b, ADR-0049, CA #4). Sanitizes the preserved `instruction`: strips
 * control chars, removes backticks and leading markdown heading/quote markers, collapses whitespace to single
 * spaces, trims, and caps at MAX_PR_TITLE. Falls back to the fixed PR_TITLE_FALLBACK when empty/blank.
 * `instruction` is user-originated, so it is never used raw. NOT a raw diff / file content.
 */
function derivePrTitle(instruction?: string): string {
  const cleaned = (instruction ?? '')
    .replace(/`+/g, '') // remove backticks
    .replace(/^\s*[#>]+\s*/gm, '') // remove leading markdown heading/quote markers (per line, before newlines collapse)
    .replace(/\s+/g, ' ') // collapse ALL whitespace (incl. newlines/tabs) to a single space
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '') // strip remaining (non-whitespace) control chars
    .trim();
  if (!cleaned) return PR_TITLE_FALLBACK;
  return cleaned.slice(0, MAX_PR_TITLE);
}

/**
 * Deterministic bounded PR body preview (Sprint 3b, ADR-0049, CA #5). Generated-by-Quoky Platform + pushed short
 * hash + head→base + committed-file COUNT ONLY (never file paths / diff / content) + explicit no-deployment /
 * approval-only. Bounded by clampToMessageBudget.
 */
function buildPrBodyPreview(input: {
  pushedCommitHash: string;
  headBranch: string;
  baseBranch: string;
  committedFileCount: number;
}): string {
  // All parts are inherently bounded (short hash + boundGitRef-capped branches + a count); a defensive
  // MAX_PR_BODY cap keeps it deterministic and bounded (CA #5).
  return [
    'Quoky Platform이 생성한 PR 초안입니다.',
    `커밋: ${input.pushedCommitHash.slice(0, 7)}`,
    `대상: ${boundGitRef(input.headBranch)} → ${boundGitRef(input.baseBranch)}`,
    `변경 파일 수: ${input.committedFileCount}개`,
    '배포는 하지 않았어요. PR은 아직 생성되지 않았고 승인만 기록해요.',
  ]
    .join('\n')
    .slice(0, MAX_PR_BODY);
}

/**
 * Bounded CRITICAL PR-creation approval reason (Sprint 3b, ADR-0049, CA #6/#12). No diff/file content/paths.
 * Explicitly states no PR created / no deployment / no merge / permission-only / not-in-3b / future
 * repository-hosting step, and the "not verified on hosting, not guaranteed creatable" discipline.
 */
function buildPrApprovalReason(input: {
  pushedCommitHash: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  owner?: string;
  repo?: string;
}): string {
  return [
    'operation: pull request creation approval planning',
    // Target repository for human review (Sprint 3d-D) — owner/repo only, NEVER a token. Structured anchor
    // fields (anchor.repositoryIdentity) are the authority; this reason text is NOT parsed later (CA change 10).
    ...(input.owner && input.repo ? [`repository: ${boundGitRef(input.owner)}/${boundGitRef(input.repo)}`] : []),
    `pushed commit: ${input.pushedCommitHash}`,
    `head: ${boundGitRef(input.headBranch)}`,
    `base: ${boundGitRef(input.baseBranch)}`,
    `title: ${input.title.slice(0, MAX_PR_TITLE)}`,
    'risk: CRITICAL',
    'no pull request has been created',
    'no deployment has been performed',
    'no merge has been performed',
    'this approval records permission only',
    'actual PR creation is NOT performed in Sprint 3b',
    'future execution requires a separate repository-hosting step',
    'creating a PR mutates shared collaboration state (CI, notifications, reviews, branch protections, automations)',
    'approval is based on the pushed context currently recorded by Quoky Platform; it does not verify the branch on the hosting provider and does not guarantee a PR can be created',
  ].join('\n');
}

/**
 * Deterministic bounded PR BODY for the actual creation call (Sprint 3d-D, ADR-0054, CA change 11) — the text
 * sent to the hosting provider. Generated-by-Quoky Platform + bounded title + pushed short hash + head→base +
 * committed-file COUNT ONLY (never file paths / diff / content / token / remoteUrl) + explicit no
 * merge/deploy/release. Bounded by MAX_PR_BODY. Re-derived from approved context — the stored `prBodyPreview`
 * is not trusted verbatim.
 */
function buildPrBody(input: {
  title: string;
  pushedCommitHash: string;
  headBranch: string;
  baseBranch: string;
  committedFileCount: number;
}): string {
  return [
    'Quoky Platform이 생성한 PR입니다.',
    `제목: ${input.title.slice(0, MAX_PR_TITLE)}`,
    `커밋: ${input.pushedCommitHash.slice(0, 7)}`,
    `대상: ${boundGitRef(input.headBranch)} → ${boundGitRef(input.baseBranch)}`,
    `변경 파일 수: ${input.committedFileCount}개`,
    '머지/배포/릴리즈는 하지 않았어요.',
  ]
    .join('\n')
    .slice(0, MAX_PR_BODY);
}

/**
 * Deterministic bounded PR MERGE-APPROVAL reason (Sprint 3f, ADR-0056). Records permission-only intent for a
 * specific PR context — owner/repo/PR number/URL/head/base/short commit/pr-source — and explicitly states no
 * merge/deploy/release was performed and that the approval does NOT verify checks/reviews/mergeability/safety.
 * NO token / raw diff / file content / check logs / review body / full GitHub response. Never parsed later.
 */
function buildMergeApprovalReason(input: {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  headBranch: string;
  baseBranch: string;
  commitHash: string;
  reused: boolean;
}): string {
  return [
    'operation: pull request merge approval planning',
    `repository: ${boundGitRef(input.owner)}/${boundGitRef(input.repo)}`,
    `pull request: #${input.prNumber} ${input.prUrl.slice(0, MAX_GIT_REF_DISPLAY)}`,
    `head: ${boundGitRef(input.headBranch)}`,
    `base: ${boundGitRef(input.baseBranch)}`,
    `commit: ${input.commitHash.slice(0, 7)}`,
    `pr source: ${input.reused ? 'connected-existing' : 'created'}`,
    'risk: CRITICAL',
    'no merge has been performed',
    'no deployment has been performed',
    'no release has been performed',
    'this approval records permission only',
    'actual merge execution is NOT performed in Sprint 3f and requires a separate repository-hosting step',
    'merge is not guaranteed safe or mergeable by this approval; checks/reviews/hosting state are not verified',
  ].join('\n');
}

/**
 * Build the CRITICAL remote-branch-cleanup approval reason (Sprint 3j-A, ADR-0060). States ONLY the requested
 * permission TARGET — repository, PR, the anchored remote head branch, and the expected head commit — plus the
 * risk and the permission-only disclaimers (CA change 4). It must NOT claim the branch currently exists, that its
 * SHA is still the expected one, that the PR is still merged, or that the delete will succeed / is safe now — those
 * are live execution checks for Sprint 3j-B. Deterministic; never parsed back.
 */
function buildRemoteBranchCleanupApprovalReason(input: {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  expectedHeadCommit: string;
}): string {
  return [
    'operation: remote branch cleanup approval planning',
    `repository: ${boundGitRef(input.owner)}/${boundGitRef(input.repo)}`,
    `pull request: #${input.prNumber} ${input.prUrl.slice(0, MAX_GIT_REF_DISPLAY)}`,
    `remote head branch (target): ${boundGitRef(input.branch)}`,
    `expected head commit: ${input.expectedHeadCommit.slice(0, 7)}`,
    'risk: CRITICAL',
    'no remote branch has been deleted',
    'no deployment has been performed',
    'no release has been performed',
    'this approval records permission only',
    'actual remote branch deletion is NOT performed in Sprint 3j-A and requires a separate 3j-B execution step',
    'branch existence, current commit, PR merged state, and delete safety are NOT asserted by this approval; they are verified live at execution',
  ].join('\n');
}

/** Map an Execution Orchestrator outcome status to the ResponseComposer reply status. */
function toReplyStatus(status: ExecutionOutcomeStatus): ExecutionReplyStatus {
  return status as unknown as ExecutionReplyStatus; // identical string values (ADR-0032)
}

/**
 * Split a proposal into in-scope changes (path normalizes to a validated targetFiles entry) and
 * everything else, reported as a warning and never read/rendered as content (AI Code Generation
 * Preview, ADR-0038; Unified Diff Preview, ADR-0039). AI-proposed paths are untrusted; targetFiles is
 * the authoritative scope. Exported (not a private class method) so it is directly unit-testable,
 * matching `target-scope.ts`'s pattern.
 *
 * Preserves each in-scope `ProposedChange`'s `delete`/`newContent` shape exactly as given — spreads
 * `change` and overrides only `path`, never reconstructing a new object that could default a field the
 * AI's proposal didn't carry (Sprint 2r, ADR-0039, CA Round 1 Required Change #6).
 */
export function filterInScopeChanges(
  proposal: ProposedChange[],
  targetFiles: string[],
): { inScope: ProposedChange[]; outOfScopeWarnings: string[] } {
  const normalizedTargets = new Map(targetFiles.map((p) => [normalizeRelativePath(p), p]));
  const inScope: ProposedChange[] = [];
  const outOfScopeWarnings: string[] = [];
  for (const change of proposal) {
    const validatedPath = normalizedTargets.get(normalizeRelativePath(change.path));
    if (!validatedPath) {
      outOfScopeWarnings.push(change.path);
      continue;
    }
    inScope.push({ ...change, path: validatedPath }); // validated value, never the AI's raw path
  }
  return { inScope, outOfScopeWarnings };
}

/** Sprint 2q's original filtering + text-excerpt shaping (ADR-0038) — now a thin wrapper over
 *  {@link filterInScopeChanges}. Signature/behavior unchanged; retained for compatibility (ADR-0039). */
export function toCodeChangePreview(proposal: ProposedChange[], targetFiles: string[]): CodeChangePreview {
  const { inScope, outOfScopeWarnings } = filterInScopeChanges(proposal, targetFiles);
  const changes: CodeChangePreview['changes'] = inScope.map((c) => ({
    path: c.path,
    kind: c.delete ? 'delete' : 'update',
    ...(c.delete ? {} : { excerpt: c.newContent }),
  }));
  return { changes, outOfScopeWarnings };
}

/**
 * Shape an already-guarded `WorkspaceManager.diff()` result into the composer-facing DTO (Sprint 2r,
 * ADR-0039). Pure data reshaping — no bounding/truncation-notice text here; `ResponseComposer` owns
 * that (ADR-0032). Callers must have already rejected an empty `diff.files` before calling this, and any
 * `changeKind: 'add'` entry must already have passed the explicit-new-file + non-existence guard (F3-A,
 * Sprint 4c-Follow-up-3) — an `add` here is a confirmed new-file preview, rendered against empty content.
 */
export function toCodeDiffPreview(diff: WorkspaceDiff, outOfScopeWarnings: string[]): CodeDiffPreview {
  const changes: CodeDiffPreview['changes'] = diff.files.map((f) => ({
    path: f.path, // already the validated targetFiles value passed into workspace.diff
    // 'modify' -> 'update'; 'add' is a guarded new-file preview (F3-A); 'delete' unchanged.
    kind: f.changeKind === 'delete' ? 'delete' : f.changeKind === 'add' ? 'add' : 'update',
    unified: f.unified, // '' when binary or size-skipped by the provider
    binary: f.binary,
    // ADR-0099 D1 byte bounds for the apply-capable footer; only when the provider reported them.
    ...(f.oldSize !== undefined ? { oldSize: f.oldSize } : {}),
    ...(f.newSize !== undefined ? { newSize: f.newSize } : {}),
  }));
  return { changes, outOfScopeWarnings };
}

export class ConversationRuntime {
  private readonly clock: () => IsoTimestamp;
  private readonly gitRemoteEnabled: boolean;
  private readonly gitMergeEnabled: boolean;
  /** The registered turn handlers per stage, each in `(order, id)` order (ADR-0096 D2). */
  private readonly turnHandlersByStage: Readonly<Record<TurnHandlerStage, readonly ConversationTurnHandler[]>>;
  /** The handlers' contributed help lines in registry order (ADR-0096 D6); bounded by the composer. */
  private readonly contributedHelpLines: readonly string[];

  constructor(
    private readonly deps: ConversationRuntimeDeps,
    options: ConversationRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? now;
    this.gitRemoteEnabled = options.gitRemoteEnabled ?? false;
    this.gitMergeEnabled = options.gitMergeEnabled ?? false;
    const registry = ConversationRuntime.orderTurnHandlers(deps.turnHandlers ?? []);
    this.turnHandlersByStage = {
      control: registry.filter((h) => h.stage === 'control'),
      'post-anchor': registry.filter((h) => h.stage === 'post-anchor'),
      'pre-classify': registry.filter((h) => h.stage === 'pre-classify'),
    };
    this.contributedHelpLines = registry.flatMap((h) => h.helpLines ?? []);
  }

  /**
   * Validate and order the turn-handler registry (ADR-0096 D2): a known stage, a finite order and a non-empty id
   * unique across the registry, else construction fails; sorted by `(stage, order, id)` with stages in
   * `TURN_HANDLER_STAGES` order and ids compared by code unit (locale-independent).
   */
  private static orderTurnHandlers(handlers: readonly ConversationTurnHandler[]): ConversationTurnHandler[] {
    const seen = new Set<string>();
    for (const handler of handlers) {
      if (typeof handler.id !== 'string' || handler.id.length === 0) {
        throw new Error('conversation turn handler id must be a non-empty string');
      }
      if (seen.has(handler.id)) throw new Error(`duplicate conversation turn handler id: ${handler.id}`);
      seen.add(handler.id);
      if (!TURN_HANDLER_STAGES.includes(handler.stage)) {
        throw new Error(`conversation turn handler ${handler.id} has an unknown stage`);
      }
      if (!Number.isFinite(handler.order)) {
        throw new Error(`conversation turn handler ${handler.id} has a non-finite order`);
      }
    }
    const stageIndex = (stage: TurnHandlerStage): number => TURN_HANDLER_STAGES.indexOf(stage);
    return [...handlers].sort(
      (a, b) =>
        stageIndex(a.stage) - stageIndex(b.stage) ||
        a.order - b.order ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** Capabilities that operate on files need a resolved workspace; chat does not. */
  private static needsWorkspace(capability: Capability): boolean {
    return capability === Capability.CODE_IMPLEMENTATION || capability === Capability.TEST_EXECUTION;
  }

  /** Interpret a user message as an approval decision (only meaningful while a pending approval exists). */
  static interpretDecision(text: string): ApprovalDecisionKind {
    return interpretApprovalDecision(text);
  }

  /** Explicit apply intent only (Sprint 2s, ADR-0040) — deliberately NOT interpretDecision/APPROVE_WORDS;
   *  "좋아"/"오케이"/"확인"/"괜찮네" must never authorize file modification (Critical Product Rule). */
  static interpretApplyIntent(text: string): boolean {
    return unnegatedMatch(text, APPLY_WORDS); // negation-aware (ADR-0062 draft): "적용하지 마" is not an apply
  }

  /** Explicit patch-generation intent only (Sprint 2t, ADR-0041) — the ambiguous standalone "계속 진행"
   *  is excluded; combined with routing, generation only fires on an APPROVED anchor. */
  static interpretPatchIntent(text: string): boolean {
    return unnegatedMatch(text, PATCH_WORDS); // negation-aware (ADR-0062 draft)
  }

  /** Explicit final workspace-apply intent only (Sprint 2u, ADR-0042) — qualified phrases only; a bare
   *  "적용"/"다음 단계 진행"/"좋아" never triggers a file write. Combined with routing, a write only fires
   *  on a PATCH_READY anchor. Checked before apply-intent so "패치 적용해줘" is a file-apply. */
  static interpretFinalApplyIntent(text: string): boolean {
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
  static interpretPostApplyValidationIntent(
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
  static interpretGitPreviewIntent(text: string): 'status' | 'diff' | 'mutating' | null {
    const t = text.trim().toLowerCase();
    if (GIT_MUTATING_WORDS.test(t)) return 'mutating';
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
  static interpretCommitIntent(text: string): 'commit' | 'commit-with-forbidden' | null {
    // Liberal commit-token detection is used ONLY for the forbidden-combo guard, so a bundled request like
    // "commit and push" / "커밋하고 push" is rejected as unsupported (never routed to a plain commit or the
    // 2w mutating reply). The plain-commit trigger stays conservative via COMMIT_WORDS. Negation-aware
    // (ADR-0062 draft): a NEGATED commit/companion token ("커밋하지 마", "do not commit/push") is NOT a request.
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
  static interpretCommitExecutionIntent(text: string): 'execute' | 'push-unsupported' | null {
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
  static interpretPushIntent(text: string): 'push' | 'push-unsupported' | null {
    if (!unnegatedMatch(text, [PUSH_WORDS])) return null; // (CA #2) no (non-negated) push word → not push handling
    if (unnegatedMatch(text, [PUSH_FORBIDDEN_COMPANION])) return 'push-unsupported'; // push + force/PR/deploy/tag/branch/…
    return 'push';
  }

  /**
   * A push request that reaches the no-relevant-anchor fall-through (QA-V2-W8): the strict imperative/execution
   * shape of {@link interpretPushIntent}. A question or a topic mention ("git push가 뭐야?", "푸시 알림 설정하는 법",
   * "push notification 구현 방법") is `null` and stays ordinary chat.
   */
  static interpretNoAnchorPushRequest(text: string): 'push' | 'push-unsupported' | null {
    const kind = ConversationRuntime.interpretPushIntent(text);
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
  static interpretPushExecutionIntent(text: string): 'execute' | 'push-unsupported' | null {
    if (!unnegatedMatch(text, [PUSH_EXECUTION_WORDS]) && !unnegatedMatch(text, [PUSH_WORDS])) return null; // no (non-negated) push/exec word
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
  static interpretPrIntent(text: string): 'create' | 'pr-unsupported' | null {
    if (!unnegatedMatch(text, [PR_WORD])) return null; // no (non-negated) PR word → not PR handling
    if (unnegatedMatch(text, [PR_FORBIDDEN_COMPANION])) return 'pr-unsupported'; // PR + deploy/merge/release/force/…
    if (unnegatedMatch(text, [PR_CREATION_WORDS])) return 'create';
    return null; // a bare PR noun without a create/open verb → not PR handling (CA #1)
  }

  /**
   * Explicit PR/CI/check/review STATUS-preview intent (Sprint 3e, ADR-0055) — only consulted at PR_CREATED.
   * True only when BOTH a status-context noun (PR/CI/check/review) AND a query verb (상태/확인/…) are present, so
   * a bare "상태" never triggers (CA Q1) and merge/deploy/release/reviewer/label phrases (no status noun+query)
   * do not match — they keep routing to the companion-unsupported reply.
   */
  static interpretPrStatusIntent(text: string): boolean {
    const t = text.trim().toLowerCase();
    return PR_STATUS_NOUN.test(t) && PR_STATUS_QUERY.test(t);
  }

  /**
   * Explicit merge-APPROVAL intent (Sprint 3f, ADR-0056) — only consulted at PR_CREATED, AFTER the status
   * intent. Returns `'merge'` only for a merge word + an explicit approval/execution request verb; a merge
   * safety/possibility QUESTION or a bare merge noun returns null (→ falls through to the companion reply). A
   * bare "진행해"/"좋아"/"승인" has no merge word → null (so PR_CREATED + "진행해" never creates a merge approval).
   */
  static interpretMergeIntent(text: string): 'merge' | null {
    const t = text.trim().toLowerCase();
    if (!MERGE_WORD.test(t)) return null;
    if (MERGE_QUESTION.test(t)) return null; // "머지 가능해?/안전해?/통과?" → not an approval request
    if (MERGE_REQUEST_VERB.test(t)) return 'merge';
    return null; // bare "머지" noun → companion-unsupported
  }

  /**
   * Explicit merge-EXECUTION intent (Sprint 3g, ADR-0057, CA change 1) — only consulted at MERGE_APPROVED /
   * PR_MERGED. A merge word + a request/execution verb → `'execute'`; the MERGE_QUESTION status/check/possibility
   * guard takes precedence (so "머지 상태 확인해줘"/"머지 체크해줘"/"머지 가능해?" never execute); a bare "머지"/"merge"
   * noun (no verb) → null (→ composeMergeAlreadyApproved). At MERGE_APPROVED the CRITICAL 3f approval was already
   * granted, so "머지해줘"/"이 PR 머지해줘"/"merge this PR" are valid execution commands.
   */
  static interpretMergeExecutionIntent(text: string): 'execute' | null {
    const t = text.trim().toLowerCase();
    if (!MERGE_WORD.test(t)) return null;
    if (MERGE_QUESTION.test(t)) return null; // status/check/possibility → not execution (read-only path)
    if (MERGE_EXECUTION_FOREIGN.test(t)) return null; // merge + push/deploy/sync/delete/force → never execution (Codex W8)
    if (MERGE_EXECUTION_VERB.test(t) && MERGE_EXECUTION_ATTACHED.test(t)) return 'execute';
    return null; // bare "머지"/"merge" noun → already-approved reply, no execution
  }

  /**
   * A merge STATUS/CHECK phrase (Sprint 3g) → routes to the read-only status preview at MERGE_APPROVED/PR_MERGED,
   * so "머지 상태 확인해줘"/"머지 체크해줘" land on the 3e preview even though PR_STATUS_NOUN does not include "머지".
   * A merge word + a MERGE_QUESTION status/check/possibility word (never execution).
   */
  static interpretMergeStatusIntent(text: string): boolean {
    const t = text.trim().toLowerCase();
    return MERGE_WORD.test(t) && MERGE_QUESTION.test(t);
  }

  /**
   * Explicit post-merge LOCAL main sync intent (Sprint 3h, ADR-0058) — only consulted at PR_MERGED / MAIN_SYNCED.
   * Requires a sync verb (동기화/최신화/받아와/sync/pull/update main) AND a main target — so a bare "sync"/"pull" or a
   * bare "main" alone does not trigger. Covers "main 동기화해줘"/"로컬 main 최신화해줘"/"머지된 main 받아와줘"/"sync main"/
   * "update local main".
   */
  static interpretMainSyncIntent(text: string): 'sync' | null {
    const t = text.trim().toLowerCase();
    if (!SYNC_WORD.test(t)) return null;
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
  static interpretRemoteBranchCleanupIntent(text: string): 'remote' | null {
    const t = text.trim().toLowerCase();
    if (CLEANUP_BULK.test(t) || CLEANUP_MAIN_TARGET.test(t)) return null; // bulk/wildcard/"main·default 삭제" → never
    if (CLEANUP_FOREIGN_CHAIN_WORD.test(t) || CLEANUP_NOT_A_REQUEST.test(t)) return null; // other chain verb / statement (Codex W8)
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
  static interpretRemoteBranchCleanupExecutionIntent(text: string): 'execute' | null {
    const t = text.trim().toLowerCase();
    if (CLEANUP_BULK.test(t) || CLEANUP_MAIN_TARGET.test(t)) return null; // bulk/wildcard/main·default → never execute (CA change 1)
    // (Codex wave-8 review, P1) only the step's OWN execution phrases: never a push/merge/PR/sync/… phrase ("execute
    // approved push", "푸시 실행해도 돼?"), never a statement/question, never an execute word with unrelated content.
    if (CLEANUP_FOREIGN_CHAIN_WORD.test(t) || CLEANUP_NOT_A_REQUEST.test(t)) return null;
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
  static interpretBranchCleanupIntent(text: string): 'local' | null {
    const t = text.trim().toLowerCase();
    if (CLEANUP_BULK.test(t) || CLEANUP_MAIN_TARGET.test(t)) return null; // bulk/wildcard/"main 삭제" → never
    if (CLEANUP_REMOTE_WORD.test(t)) return null; // remote → not local (routed by interpretRemoteBranchCleanupIntent)
    if (CLEANUP_FOREIGN_CHAIN_WORD.test(t) || CLEANUP_NOT_A_REQUEST.test(t)) return null; // other chain verb / statement (Codex W8)
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
  static parseCommitMessage(text: string, targetFiles: string[]): { message: string } | 'invalid' {
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

  /**
   * Handle one inbound message → one transient `TurnResult` (with an `OutboundMessage`). Never sends
   * to the platform (delivery is the facade's job) and never persists runtime state.
   */
  /**
   * Public entry — NEVER throws for an application/runtime error (Sprint 4c-Follow-up-7, F7-D). Delegates to
   * the full turn flow; on ANY escaping error it returns a sanitized FAILED TurnResult so the caller delivers
   * exactly ONE safe user-facing response (mapped message + code, no raw exception / stack / secrets). The full
   * exception + stack are preserved in the internal log only. No business action is retried.
   */
  async handle(message: InboundMessage): Promise<TurnResult> {
    try {
      return await this.handleInner(message);
    } catch (err) {
      const safe = toSafeError(err);
      this.deps.logger.error('inbound handling failed', {
        errorName: err instanceof Error ? err.name : typeof err,
        code: safe.code,
        messageId: message.id,
        // internal-only (stdout/stderr sink) — never sent to the user (CA §5)
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Generic backstop: this catch wraps the ENTIRE turn, so it cannot prove where handleInner failed —
      // a mutation may already have been applied. Render the conservative "cannot verify" wording; NEVER
      // claim zero mutation here (Sprint 4c-Follow-up-7 CA mutation-certainty correction).
      const reply = this.deps.composer.composeSanitizedError(message.context, safe, {
        requestId: safeRequestId(message.id),
        mutationSafety: 'MAY_HAVE_APPLIED',
      });
      return { status: 'FAILED', reply, sessionId: '' };
    }
  }

  private async handleInner(message: InboundMessage): Promise<TurnResult> {
    const actor = await this.deps.actors.resolveFromContext(message.context);
    let session = await this.deps.sessions.openForContext(message.context, actor.id);
    await this.deps.sessions.touch(session);

    // (0) Conversation control + pending-approval lifetime (ADR-0093) — BEFORE memory capture, approval/anchor
    // routing and classification, in every conversation state. Expiry is lazy (no scheduler): an expired
    // PENDING approval is recorded denied on this turn. Control phrases take precedence: help/reset still run
    // (with the expiry notice prepended); any other turn gets only the expiry notice.
    const control = detectConversationControl(message.text);
    const lookup = await this.findPendingApproval(session);
    let expiryNotice: OutboundMessage | null = null;
    if (lookup.pending && this.remainingMs(lookup.pending) <= 0) {
      await this.expirePendingApproval(session, lookup);
      expiryNotice = this.deps.composer.composeApprovalExpired(
        message.context,
        lookup.pending,
        PENDING_APPROVAL_TTL_MS,
      );
    }
    // ADR-0097 D5: a credential-override set that is no longer live released its anchor pointer on the canonical
    // session (invalidated now, or consumed earlier). Mirror the release on this turn's copy so no later save in
    // this turn re-points the session at the terminal anchor; an invalidation is answered like an expiry.
    if (lookup.override && (expiryNotice || lookup.override.state === 'invalidated' || lookup.override.state === 'consumed')) {
      if (lookup.override.state === 'invalidated') {
        expiryNotice = await this.closeInvalidatedCredentialOverride(message, session, lookup.override);
      } else if (lookup.override.state === 'consumed') {
        await this.deps.credentialOverrideFlow?.clear(session); // a pointer left on a consumed set: release it
      }
      session = { ...session, activeTaskId: undefined };
    }
    if (control) {
      return this.handleControlTurn(message, session, actor, control, expiryNotice ? null : lookup.pending, expiryNotice);
    }
    // (0b) ADR-0096 `control` turn handlers — in every state, including a pending approval; nothing is recorded
    // to memory (like help/reset) and an expiry notice is prepended exactly as `handleControlTurn` does. After an
    // expiry the snapshot shows the anchor as the expiry left it (released like a denial, or cleared).
    const controlDispatch = this.runTurnHandlers('control', () =>
      this.turnHandlerContext(
        message,
        session,
        actor,
        expiryNotice && lookup.applyAnchor ? ConversationRuntime.anchorAfterRejection(lookup.applyAnchor) : lookup.applyAnchor,
      ),
    );
    const controlOutcome = controlDispatch ? await controlDispatch : null;
    if (controlOutcome) {
      // Control handlers are provider-free (ADR-0096 D3): a `summarize` outcome here is never honoured — its
      // deterministic list is the reply and no Task or provider runs.
      const controlHandled = this.controlStageReply(message, controlOutcome);
      const reply = expiryNotice
        ? this.deps.composer.composeWithNotice(expiryNotice, controlHandled.reply)
        : controlHandled.reply;
      const result = this.responded(session, reply);
      return controlHandled.status === 'FAILED' ? { ...result, status: 'FAILED' } : result;
    }

    const userMemory = await this.deps.memory.recordShortTerm(message, session.id);
    if (expiryNotice) {
      await this.deps.memory.recordAssistant(expiryNotice.text, message.context, session.id);
      return { status: 'DENIED', reply: expiryNotice, sessionId: session.id };
    }

    // (A) Approval-decision routing — ONLY when a pending approval is derived for this session.
    const pending = lookup.planPending;
    if (pending) {
      return this.handleApprovalTurn(message, session, actor, pending);
    }

    // (A2) Scope-clarification routing (ADR-0037) — checked BEFORE classification so a bare
    // file-path reply doesn't need to re-trigger the classifier's fix/change/refactor keywords.
    // Ordering is load-bearing: approvalFlow is checked first, so an approval-anchored session
    // (planId present) is never routed here.
    const pendingScope = lookup.pendingScope;
    if (pendingScope) {
      // QA-015: an explicit project-registration request is a new request, not a reply naming the file to change.
      // The clarification is next-turn-only, so it is consumed here and the turn is routed normally.
      // ADR-0099 D1 (QA follow-up): a resend of the request WITH explicit create wording and a named path is a
      // fresh request too — the bare-path recovery only routes existing files, so it would answer the same
      // "not found" reply again (dead end). Routed normally, the create wording is honored and its own text is the
      // instruction.
      if (!detectProjectRegistration(message.text) && !ConversationRuntime.isFreshCreateResend(message.text)) {
        return this.handleScopeClarificationTurn(message, session, actor, pendingScope);
      }
      await this.deps.scopeClarificationFlow.clear(session);
    }

    // (A2b) Credential-override routing (ADR-0097 D4) — after the scope clarification and before every
    // `post-anchor` / `pre-classify` handler stage (only `control` ran above). A live set (one CRITICAL override
    // awaiting its decision, or a fully granted set awaiting its single dispatch) intercepts EVERY turn; only the
    // dedicated send phrase sends, so "승인"/"좋아"/"ok" re-prompt. A send phrase for an already-consumed set gets the
    // "already used" reply (never a replay).
    const override = lookup.override;
    if (override?.state === 'awaiting-decision' || override?.state === 'ready') {
      return this.handleCredentialOverrideTurn(message, session, actor, override);
    }
    if (override?.state === 'consumed' && isStrayCredentialOverridePhrase(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeCredentialOverrideAlreadyUsed(message.context));
    }

    // (A3) Apply-preview routing (Sprint 2s, ADR-0040) — checked after approvalFlow/scopeClarificationFlow
    // so neither is ever pre-empted. (All three were already read, in this order, by findPendingApproval.)
    const applyAnchor = lookup.applyAnchor;
    // A real second ApprovalRequest is pending decision — intercepts EVERY turn, exactly like the first
    // approval does, regardless of whether the message is an apply phrase.
    if (applyAnchor?.status === 'AWAITING_APPROVAL') {
      return this.handleApplyApprovalTurn(message, session, actor, applyAnchor);
    }
    // (Sprint 2x, ADR-0045) A pending git-commit approval intercepts EVERY turn, exactly like AWAITING_APPROVAL.
    if (applyAnchor?.status === 'COMMIT_APPROVAL_PENDING') {
      return this.handleCommitApprovalDecisionTurn(message, session, actor, applyAnchor);
    }
    // (Sprint 2z, ADR-0047) A pending git-push approval intercepts EVERY turn — decision flow ONLY (CA #3);
    // any push/force/deploy phrase is not approve/deny/cancel, so it re-prompts (never routes to
    // unsupported-companion while pending). No git push runs.
    if (applyAnchor?.status === 'PUSH_APPROVAL_PENDING') {
      return this.handlePushApprovalDecisionTurn(message, session, actor, applyAnchor);
    }
    // (Sprint 3b, ADR-0049) A pending PR-creation approval intercepts EVERY turn — decision flow ONLY (CA #7);
    // a PR-creation/PR+forbidden/deploy phrase is not approve/deny/cancel, so it re-prompts. No PR created.
    if (applyAnchor?.status === 'PR_APPROVAL_PENDING') {
      return this.handlePrApprovalDecisionTurn(message, session, actor, applyAnchor);
    }
    // (Sprint 3f, ADR-0056) A pending merge approval intercepts EVERY turn — decision flow ONLY; a
    // merge/deploy/status phrase while pending re-prompts (no decide, no merge). "진행해" approves ONLY here.
    if (applyAnchor?.status === 'MERGE_APPROVAL_PENDING') {
      return this.handleMergeApprovalDecisionTurn(message, session, actor, applyAnchor);
    }
    // (Sprint 3j-A, ADR-0060) A pending remote-branch-cleanup approval intercepts EVERY turn — decision flow ONLY; a
    // remote-cleanup/execute/status/deploy phrase while pending re-prompts (no decide, no delete, no auto-approve).
    if (applyAnchor?.status === 'REMOTE_BRANCH_CLEANUP_PENDING') {
      return this.handleRemoteBranchCleanupDecisionTurn(message, session, actor, applyAnchor);
    }
    // (A4) ADR-0096 `post-anchor` turn handlers — every pending approval / scope clarification / `*_PENDING`
    // intercept above has already captured its turn, so a handler can never pre-empt a decision. Runs BEFORE the
    // ADR-0043 deny-fragment check and the WORKSPACE_APPLIED git-mutating-word reject below.
    const postAnchorDispatch = this.runTurnHandlers('post-anchor', () =>
      this.turnHandlerContext(message, session, actor, applyAnchor),
    );
    const postAnchorHandled = postAnchorDispatch ? await postAnchorDispatch : null;
    if (postAnchorHandled) return this.respondTurnHandler(message, session, actor, userMemory.id, postAnchorHandled);
    // ADR-0043 safety gate: deny-fragment refusal is anchor-independent and precedes every route that can
    // execute a derived validation command. Without this guard, a missing/stale WORKSPACE_APPLIED anchor can
    // fall through to IntentClassifier -> RUN_TESTS -> ExecutionOrchestrator. Keep pending approval decisions
    // above this check because those turns cannot enter validation execution and must retain decision semantics.
    if (ConversationRuntime.interpretPostApplyValidationIntent(message.text) === 'unsupported') {
      return this.respondComposed(
        message,
        session,
        this.deps.composer.composePostApplyValidationUnsupported(message.context),
      );
    }
    // (Sprint 2y, ADR-0046) Approved git commit EXECUTION — GATED to commit-relevant states only (CA #4).
    // Checked before the 2x commit-intent so "이제 실제 커밋해줘" executes rather than re-printing
    // already-approved. push-only is NOT intercepted outside commit states (WORKSPACE_APPLIED "push" stays
    // the 2w mutating reject).
    if (applyAnchor?.status === 'COMMIT_APPROVED') {
      const execKind = ConversationRuntime.interpretCommitExecutionIntent(message.text);
      if (execKind === 'push-unsupported') return this.handleCommitPushUnsupportedTurn(message, session);
      if (execKind === 'execute') {
        // (Codex wave-8 re-review) one affirmative-execution guard on every approved execution gate: a question /
        // negation / past-tense / reported phrase that names the step never executes it → already-approved reply.
        if (!isAffirmativeExecutionCommand(message.text)) return this.handleCommitAlreadyApprovedTurn(message, session);
        return this.handleCommitExecutionTurn(message, session, applyAnchor);
      }
    }
    if (applyAnchor?.status === 'GIT_COMMITTED') {
      // (Sprint 2z, ADR-0047) push is checked FIRST so "푸시해줘" plans a push approval rather than hitting
      // the 2y commit-push-unsupported reply. A push bundled with force/PR/deploy/… → unsupported companion.
      const pushKind = ConversationRuntime.interpretPushIntent(message.text);
      if (pushKind === 'push-unsupported') return this.handlePushUnsupportedCompanionTurn(message, session);
      if (pushKind === 'push') return this.handlePushApprovalTurn(message, session, actor, applyAnchor);
      // A repeat commit-execution phrase at GIT_COMMITTED → already committed (2y). ("push"-forbidden here is
      // handled above by 2z; the remaining COMMIT_EXECUTION 'push-unsupported' cases have no push word.)
      const execKind = ConversationRuntime.interpretCommitExecutionIntent(message.text);
      if (execKind === 'push-unsupported') return this.handleCommitPushUnsupportedTurn(message, session);
      if (execKind === 'execute') return this.handleCommitAlreadyCommittedTurn(message, session, applyAnchor);
    }
    // (Sprint 3a, ADR-0048) approved git push EXECUTION — checked before the 2z already-approved so
    // "승인된 push 실행해줘" executes rather than re-printing already-approved. A bare push phrase (no exec
    // word) falls to the 2z already-approved reply. A push+forbidden phrase → unsupported companion.
    if (applyAnchor?.status === 'PUSH_APPROVED') {
      const exKind = ConversationRuntime.interpretPushExecutionIntent(message.text);
      if (exKind === 'push-unsupported') return this.handlePushUnsupportedCompanionTurn(message, session);
      if (exKind === 'execute') {
        if (!isAffirmativeExecutionCommand(message.text)) return this.handlePushAlreadyApprovedTurn(message, session); // (Codex W8)
        return this.handlePushExecutionTurn(message, session, actor, applyAnchor);
      }
      // (Sprint 2z) a bare push phrase at PUSH_APPROVED → already approved (not pushed).
      const pushKind = ConversationRuntime.interpretPushIntent(message.text);
      if (pushKind === 'push-unsupported') return this.handlePushUnsupportedCompanionTurn(message, session);
      if (pushKind === 'push') return this.handlePushAlreadyApprovedTurn(message, session);
    }
    // (Sprint 3a/3b) At GIT_PUSHED: a repeat push-execution/push phrase → already pushed; a push+forbidden →
    // unsupported companion (checked first, so a push+PR bundle is a push companion). (Sprint 3b, ADR-0049) an
    // explicit PR-creation phrase → CRITICAL PR approval; a PR+forbidden → unsupported companion; a bare
    // deploy-only phrase → deploy-only future-sprint (PR-creation is now supported, so it is no longer bundled).
    if (applyAnchor?.status === 'GIT_PUSHED') {
      const exKind = ConversationRuntime.interpretPushExecutionIntent(message.text);
      if (exKind === 'push-unsupported') return this.handlePushUnsupportedCompanionTurn(message, session);
      if (exKind === 'execute') return this.handlePushAlreadyPushedTurn(message, session, applyAnchor);
      const prKind = ConversationRuntime.interpretPrIntent(message.text);
      if (prKind === 'pr-unsupported') return this.handlePrUnsupportedCompanionTurn(message, session);
      if (prKind === 'create') return this.handlePrApprovalTurn(message, session, actor, applyAnchor);
      if (DEPLOY_ONLY_WORDS.test(message.text)) return this.handlePushPrDeployUnsupportedTurn(message, session);
      if (ConversationRuntime.interpretPushIntent(message.text) === 'push') return this.handlePushAlreadyPushedTurn(message, session, applyAnchor);
    }
    // (QA-V2-W7-02) After the push, every later chain state: a push/push-execution phrase must never fall through
    // to chat (a free-text model reply could fabricate or advise e.g. `git push -f`). A push+forbidden companion
    // (force/merge/deploy/PR/…) → the unsupported companion reply; any other push phrase → already pushed. Read-only
    // PR/merge status phrases keep priority; no git/hosting call is ever made here. An explicit push-EXECUTION phrase
    // ("푸시 실행해도 돼?", "execute approved push") is ALWAYS intercepted, whatever its question shape (Codex wave-8
    // review, P1: it must never reach a later destructive execution route such as the remote-branch DELETE at
    // REMOTE_BRANCH_CLEANUP_APPROVED). A bare push-word mention uses the strict request shape (QA-V2-W8), so a
    // question/topic mention such as "git push가 뭐야?" stays ordinary chat.
    if (
      applyAnchor &&
      POST_PUSH_CHAIN_STATUSES.has(applyAnchor.status) &&
      !ConversationRuntime.interpretPrStatusIntent(message.text) &&
      !ConversationRuntime.interpretMergeStatusIntent(message.text)
    ) {
      const execKind = unnegatedMatch(message.text, [PUSH_EXECUTION_WORDS])
        ? ConversationRuntime.interpretPushExecutionIntent(message.text)
        : null;
      const pushKind = execKind === 'execute' ? 'push' : (execKind ?? ConversationRuntime.interpretNoAnchorPushRequest(message.text));
      if (pushKind === 'push-unsupported') return this.handlePushUnsupportedCompanionTurn(message, session);
      if (pushKind === 'push') return this.handlePushAlreadyPushedTurn(message, session, applyAnchor);
    }
    // (Sprint 3b, ADR-0049) already PR-approved — a PR+forbidden → unsupported companion (before create, CA #9);
    // a PR-creation phrase → already approved (not created, Q11); a deploy-only phrase → state-specific reply.
    if (applyAnchor?.status === 'PR_APPROVED') {
      const prKind = ConversationRuntime.interpretPrIntent(message.text);
      if (prKind === 'pr-unsupported') return this.handlePrUnsupportedCompanionTurn(message, session);
      // (Sprint 3d-D, ADR-0054) an explicit PR create/open phrase at PR_APPROVED now EXECUTES creation
      // (state-driven trigger — the same grammar requested approval at GIT_PUSHED). Bare noun/승인/진행해 → null.
      if (prKind === 'create') {
        if (!isAffirmativeExecutionCommand(message.text)) {
          return this.respondComposed(message, session, this.deps.composer.composePrAlreadyApproved(message.context)); // (Codex W8)
        }
        return this.handlePrCreationExecutionTurn(message, session, actor, applyAnchor);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text)) return this.handlePrApprovedDeployUnsupportedTurn(message, session);
    }
    // (Sprint 3d-D) After a PR was created/connected: a PR create phrase → already created (+ URL, no new call);
    // a deploy/merge/release/companion phrase → unsupported future step. Never re-creates / merges / deploys.
    if (applyAnchor?.status === 'PR_CREATED') {
      // (Sprint 3e) an explicit PR/CI/check/review status phrase → read-only status preview (checked first).
      if (ConversationRuntime.interpretPrStatusIntent(message.text)) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      // (Sprint 3f, ADR-0056) an explicit merge approval / merge phrase → CRITICAL merge-approval halt (records
      // permission only; NO merge). Checked before create/companion so "머지해줘" plans an approval, not a companion.
      if (ConversationRuntime.interpretMergeIntent(message.text) === 'merge') {
        // ADR-0099 D5: with QUOKY_GIT_MERGE_ENABLED=false the merge chain is off — the fixed reply comes BEFORE any
        // merge ApprovalRequest or MERGE_APPROVAL_PENDING anchor (the hosting guard also refuses the merge call).
        if (!this.gitMergeEnabled) {
          return this.respondComposed(message, session, this.deps.composer.composeMergeDisabled(message.context));
        }
        return this.handleMergeApprovalTurn(message, session, actor, applyAnchor);
      }
      const prKind = ConversationRuntime.interpretPrIntent(message.text);
      if (prKind === 'create') return this.handlePrAlreadyCreatedTurn(message, session, applyAnchor);
      if (prKind === 'pr-unsupported' || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handlePrCreatedCompanionUnsupportedTurn(message, session);
      }
    }
    // (Sprint 3f/3g) After merge approval is recorded, in order (status → execution → bare-mention → companion):
    // a status/check phrase → read-only preview (keeps MERGE_APPROVED); an explicit merge-EXECUTION command →
    // live preflight → merge (Sprint 3g); a bare merge mention (no exec verb) → already-approved (ask to merge
    // explicitly, no mutation); deploy/release/reviewer/label/assignee → unsupported future step.
    if (applyAnchor?.status === 'MERGE_APPROVED') {
      if (
        ConversationRuntime.interpretPrStatusIntent(message.text) ||
        ConversationRuntime.interpretMergeStatusIntent(message.text)
      ) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      // (Sprint 3g, ADR-0057, CA change 1) "머지해줘"/"이 PR 머지해줘"/"merge this PR"/"실제 머지해줘"/… → EXECUTE.
      if (ConversationRuntime.interpretMergeExecutionIntent(message.text) === 'execute') {
        if (!isAffirmativeExecutionCommand(message.text)) return this.handleMergeAlreadyApprovedTurn(message, session); // (Codex W8)
        return this.handleMergeExecutionTurn(message, session, actor, applyAnchor);
      }
      // A bare "머지"/"merge" mention (merge word, no execution verb, not a status phrase) → already approved,
      // ask to merge explicitly (CA change 4). NO mutation. Checked before the deploy/companion words so a merge
      // noun does not fall into the companion-unsupported reply.
      if (MERGE_WORD.test(message.text)) {
        return this.handleMergeAlreadyApprovedTurn(message, session);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text) || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handleMergeApprovedCompanionUnsupportedTurn(message, session);
      }
    }
    // (Sprint 3g/3h) PR_MERGED, in order: an explicit LOCAL main sync command → fast-forward sync (Sprint 3h,
    // checked FIRST so "머지된 main 받아와줘" syncs rather than being read as a merge phrase); a status/check phrase →
    // read-only preview (keeps PR_MERGED); any merge phrase → already merged (NO new mutation); deploy/release/
    // companion → unsupported future step.
    if (applyAnchor?.status === 'PR_MERGED') {
      // (Codex W8) a sync question / prohibition / statement never syncs — it falls through to the routes below.
      if (ConversationRuntime.interpretMainSyncIntent(message.text) === 'sync' && isAffirmativeExecutionCommand(message.text)) {
        return this.handleMainSyncTurn(message, session, actor, applyAnchor);
      }
      if (
        ConversationRuntime.interpretPrStatusIntent(message.text) ||
        ConversationRuntime.interpretMergeStatusIntent(message.text)
      ) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretMergeExecutionIntent(message.text) === 'execute' ||
        MERGE_WORD.test(message.text)
      ) {
        return this.handleMergeAlreadyMergedTurn(message, session, applyAnchor);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text) || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handleMergeExecutionUnsupportedCompanionTurn(message, session);
      }
    }
    // (Sprint 3h/3i) Terminal MAIN_SYNCED, in order: a REMOTE cleanup phrase → unsupported (Sprint 3i, CA change 1
    // — checked FIRST so it never falls through to a local delete); an explicit LOCAL cleanup command → safe local
    // branch delete (Sprint 3i); a sync command → already synced; a status/check phrase → read-only preview; any
    // merge phrase → already merged; deploy/release/companion → unsupported future step.
    if (applyAnchor?.status === 'MAIN_SYNCED') {
      if (ConversationRuntime.interpretRemoteBranchCleanupIntent(message.text) === 'remote') {
        return this.handleRemoteBranchCleanupUnsupportedTurn(message, session);
      }
      // (Codex W8) "do not delete local branch" / "브랜치 정리해도 돼?" never deletes — falls through to the routes below.
      if (ConversationRuntime.interpretBranchCleanupIntent(message.text) === 'local' && isAffirmativeExecutionCommand(message.text)) {
        return this.handleBranchCleanupTurn(message, session, actor, applyAnchor);
      }
      if (ConversationRuntime.interpretMainSyncIntent(message.text) === 'sync') {
        return this.handleMainAlreadySyncedTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretPrStatusIntent(message.text) ||
        ConversationRuntime.interpretMergeStatusIntent(message.text)
      ) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretMergeExecutionIntent(message.text) === 'execute' ||
        MERGE_WORD.test(message.text)
      ) {
        return this.handleMergeAlreadyMergedTurn(message, session, applyAnchor);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text) || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handleMergeExecutionUnsupportedCompanionTurn(message, session);
      }
    }
    // (Sprint 3i/3j-A) Terminal BRANCH_CLEANED: a REMOTE cleanup phrase → CRITICAL remote-cleanup approval (Sprint
    // 3j-A, checked FIRST; records permission only, NO delete); a LOCAL cleanup phrase → already cleaned (no
    // mutation); a sync command → still synced; a status/check phrase → read-only preview; any merge phrase →
    // already merged; deploy/release/companion → unsupported. NEVER deletes/deploys.
    if (applyAnchor?.status === 'BRANCH_CLEANED') {
      if (ConversationRuntime.interpretRemoteBranchCleanupIntent(message.text) === 'remote') {
        return this.handleRemoteBranchCleanupApprovalTurn(message, session, actor, applyAnchor);
      }
      if (ConversationRuntime.interpretBranchCleanupIntent(message.text) === 'local') {
        return this.handleBranchAlreadyCleanedTurn(message, session, applyAnchor);
      }
      if (ConversationRuntime.interpretMainSyncIntent(message.text) === 'sync') {
        return this.handleMainAlreadySyncedTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretPrStatusIntent(message.text) ||
        ConversationRuntime.interpretMergeStatusIntent(message.text)
      ) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretMergeExecutionIntent(message.text) === 'execute' ||
        MERGE_WORD.test(message.text)
      ) {
        return this.handleMergeAlreadyMergedTurn(message, session, applyAnchor);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text) || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handleMergeExecutionUnsupportedCompanionTurn(message, session);
      }
    }
    // (Sprint 3j-B, ADR-0060) REMOTE_BRANCH_CLEANUP_APPROVED — an explicit EXECUTION command is checked FIRST (CA
    // change 1) so it is never swallowed by the re-request route → live preflight → single GitHub refs DELETE →
    // REMOTE_BRANCH_CLEANED; a re-request (no execute verb) → already approved (no re-approval); a status/check phrase
    // → read-only preview (keeps the state); a merge phrase → already merged; deploy/release/companion → unsupported.
    if (applyAnchor?.status === 'REMOTE_BRANCH_CLEANUP_APPROVED') {
      if (ConversationRuntime.interpretRemoteBranchCleanupExecutionIntent(message.text) === 'execute') {
        if (!isAffirmativeExecutionCommand(message.text)) return this.handleRemoteBranchCleanupAlreadyApprovedTurn(message, session); // (Codex W8)
        return this.handleRemoteBranchCleanupExecutionTurn(message, session, actor, applyAnchor);
      }
      if (ConversationRuntime.interpretRemoteBranchCleanupIntent(message.text) === 'remote') {
        return this.handleRemoteBranchCleanupAlreadyApprovedTurn(message, session);
      }
      if (
        ConversationRuntime.interpretPrStatusIntent(message.text) ||
        ConversationRuntime.interpretMergeStatusIntent(message.text)
      ) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretMergeExecutionIntent(message.text) === 'execute' ||
        MERGE_WORD.test(message.text)
      ) {
        return this.handleMergeAlreadyMergedTurn(message, session, applyAnchor);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text) || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handleMergeExecutionUnsupportedCompanionTurn(message, session);
      }
    }
    // (Sprint 3j-B, ADR-0060) Terminal REMOTE_BRANCH_CLEANED: a remote cleanup phrase → already cleaned (no second
    // DELETE); a local cleanup phrase → already cleaned; a sync command → still synced; a status/check phrase →
    // read-only preview (keeps the state); a merge phrase → already merged; deploy/release/companion → unsupported.
    if (applyAnchor?.status === 'REMOTE_BRANCH_CLEANED') {
      if (
        ConversationRuntime.interpretRemoteBranchCleanupExecutionIntent(message.text) === 'execute' ||
        ConversationRuntime.interpretRemoteBranchCleanupIntent(message.text) === 'remote'
      ) {
        return this.handleRemoteBranchAlreadyCleanedTurn(message, session, applyAnchor);
      }
      if (ConversationRuntime.interpretBranchCleanupIntent(message.text) === 'local') {
        return this.handleBranchAlreadyCleanedTurn(message, session, applyAnchor);
      }
      if (ConversationRuntime.interpretMainSyncIntent(message.text) === 'sync') {
        return this.handleMainAlreadySyncedTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretPrStatusIntent(message.text) ||
        ConversationRuntime.interpretMergeStatusIntent(message.text)
      ) {
        return this.handlePrStatusPreviewTurn(message, session, applyAnchor);
      }
      if (
        ConversationRuntime.interpretMergeExecutionIntent(message.text) === 'execute' ||
        MERGE_WORD.test(message.text)
      ) {
        return this.handleMergeAlreadyMergedTurn(message, session, applyAnchor);
      }
      if (DEPLOY_ONLY_WORDS.test(message.text) || PR_CREATED_COMPANION_WORDS.test(message.text)) {
        return this.handleMergeExecutionUnsupportedCompanionTurn(message, session);
      }
    }
    // (CA #1) NO global/no-anchor push handling is installed — push handling is anchored to GIT_COMMITTED /
    // PUSH_APPROVAL_PENDING / PUSH_APPROVED only; every other state keeps its existing behavior.
    // An explicit commit-execution phrase with no commit-relevant anchor → a scoped "not available" reply —
    // ONLY for an explicit 'execute' phrase (never push-only, which is left to existing 2w/2x handling).
    if (
      applyAnchor?.status !== 'COMMIT_APPROVED' &&
      applyAnchor?.status !== 'GIT_COMMITTED' &&
      ConversationRuntime.interpretCommitExecutionIntent(message.text) === 'execute'
    ) {
      return this.handleCommitExecutionUnavailableTurn(message, session);
    }
    // (Sprint 2v/2w/2x) WORKSPACE_APPLIED follow-ups, in order: validation → commit-approval → git preview.
    // Validation is checked FIRST so a mixed/dangerous phrase like "pnpm test; git commit" is caught by the
    // 2v deny-fragment path, not treated as a commit. A plain commit phrase ("커밋해줘") carries no validation
    // token, so it falls through to the commit check unaffected.
    if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
      const validationKind = ConversationRuntime.interpretPostApplyValidationIntent(message.text);
      // (Codex W8 re-review) a run ('test'/'typecheck') executes a command, so it also needs the affirmative guard
      // ("run the tests was already done" never runs); clarify/unsupported replies execute nothing and stay as-is.
      const runsCommand = validationKind === 'test' || validationKind === 'typecheck';
      if (validationKind && (!runsCommand || isAffirmativeExecutionCommand(message.text))) {
        return this.handlePostApplyValidationTurn(message, session, applyAnchor, validationKind);
      }
      // (Sprint 2x) explicit commit request → commit-approval PLANNING (halt, no git mutation). A
      // push/add/reset-only phrase → null → falls to the 2w git-preview mutating reject (unchanged).
      const commitKind = ConversationRuntime.interpretCommitIntent(message.text);
      if (commitKind) {
        return commitKind === 'commit'
          ? this.handleCommitApprovalTurn(message, session, actor, applyAnchor)
          : this.handleCommitUnsupportedCompanionTurn(message, session);
      }
      // (Sprint 2w, ADR-0044) Explicit read-only git preview → GitManager.status/diff against the applied
      // workspace. With no WORKSPACE_APPLIED anchor this is never consulted (no general git handling).
      const gitKind = ConversationRuntime.interpretGitPreviewIntent(message.text);
      if (gitKind) {
        return this.handleGitPreviewTurn(message, session, applyAnchor, gitKind);
      }
    }
    // (Sprint 2x, ADR-0045) A commit request outside WORKSPACE_APPLIED: at COMMIT_APPROVED say already-approved
    // (not committed); otherwise a scoped "no applied change to commit" reply (never broad general handling).
    if (ConversationRuntime.interpretCommitIntent(message.text)) {
      if (applyAnchor?.status === 'COMMIT_APPROVED') {
        return this.handleCommitAlreadyApprovedTurn(message, session);
      }
      return this.handleCommitUnavailableTurn(message, session);
    }
    // (Sprint 2u, ADR-0042) Explicit final workspace-apply → the first real file mutation. Checked before
    // patch- and apply-intent (FINAL_APPLY_WORDS is non-overlapping with PATCH_WORDS and precedes
    // APPLY_WORDS so "패치 적용해줘" is a file-apply, not a Sprint 2s apply-intent). Only fires on PATCH_READY.
    if (ConversationRuntime.interpretFinalApplyIntent(message.text)) {
      if (applyAnchor?.status === 'PATCH_READY') {
        // (Codex W8) "패치 적용해도 돼?" / "패치 적용하지 마" never writes files → patch-ready (not applied) reply.
        if (!isAffirmativeExecutionCommand(message.text)) return this.handlePatchAlreadyGeneratedTurn(message, session);
        return this.handleWorkspaceApplyTurn(message, session, applyAnchor);
      }
      if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
        return this.handleWorkspaceAlreadyAppliedTurn(message, session); // never re-applies
      }
      // no anchor / ELIGIBLE / APPROVED / PATCH_READY-without-patchRef — never a new code-change request.
      return this.handleWorkspaceApplyUnavailableTurn(message, session);
    }
    // (Sprint 2t, ADR-0041) Explicit patch command → PatchSet representation. Generation only on APPROVED.
    // CA Round 1 #8: at WORKSPACE_APPLIED, route to the workspace-already-applied reply (never a
    // "preview generated" reply that would hide the stronger applied state).
    if (ConversationRuntime.interpretPatchIntent(message.text)) {
      if (applyAnchor?.status === 'APPROVED') {
        return this.handlePatchGenerationTurn(message, session, applyAnchor);
      }
      if (applyAnchor?.status === 'PATCH_READY') {
        return this.handlePatchAlreadyGeneratedTurn(message, session); // don't regenerate
      }
      if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
        return this.handleWorkspaceAlreadyAppliedTurn(message, session);
      }
      // patch command with no APPROVED/PATCH_READY anchor (none / ELIGIBLE) — never falls through to a
      // new code-change request, mirroring the apply-unavailable handling.
      return this.handlePatchUnavailableTurn(message, session);
    }
    if (ConversationRuntime.interpretApplyIntent(message.text)) {
      if (applyAnchor?.status === 'ELIGIBLE') {
        return this.handleApplyIntentTurn(message, session, actor, applyAnchor); // creates approval #2
      }
      if (applyAnchor?.status === 'APPROVED' || applyAnchor?.status === 'PATCH_READY') {
        return this.handleApplyAlreadyApprovedTurn(message, session); // don't re-ask, don't re-approve
      }
      // CA Round 1 #8: at WORKSPACE_APPLIED, "적용해줘" must not say "아직 적용하지 않았어요" — the files
      // were already applied. Route to the workspace-already-applied reply.
      if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
        return this.handleWorkspaceAlreadyAppliedTurn(message, session);
      }
      // No anchor at all (or a stale one, already auto-cleared by findAnchor). An explicit apply phrase
      // must NEVER be reinterpreted as a new, unscoped code-change request (CA review).
      return this.handleApplyPreviewUnavailableTurn(message, session);
    }
    // (QA-V2-W8) A push / push-execution request with no push-relevant anchor (none, or not yet committed): the
    // chain states above own every anchored push phrase, so this is only the no-chain fall-through. Deterministic
    // reply — a free-text model reply could fabricate a push or advise `git push -f`. No git/hosting call.
    if (
      !(
        applyAnchor &&
        (applyAnchor.status === 'GIT_COMMITTED' ||
          applyAnchor.status === 'PUSH_APPROVED' ||
          applyAnchor.status === 'GIT_PUSHED' ||
          POST_PUSH_CHAIN_STATUSES.has(applyAnchor.status))
      )
    ) {
      const noAnchorPush = ConversationRuntime.interpretNoAnchorPushRequest(message.text);
      if (noAnchorPush === 'push-unsupported') return this.handlePushUnsupportedCompanionTurn(message, session);
      if (noAnchorPush === 'push') return this.handleNoPushTargetTurn(message, session);
    }
    // Anything else: fall through untouched — an ELIGIBLE/APPROVED/PATCH_READY/WORKSPACE_APPLIED anchor is
    // an optional follow-up opportunity, never a hard gate ordinary conversation must route around.

    // QA-018: every pending approval/anchor decision route has already run above, so a bare decision word here
    // ("승인", "거절", "취소", "ok") decides nothing. Answer deterministically — no provider call, no Task — so a
    // chat model can never claim an approval was accepted.
    // ADR-0097 D4: likewise a credential-override send phrase with nothing pending sends nothing and says so.
    if (this.deps.credentialOverrideFlow && isStrayCredentialOverridePhrase(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeNoPendingCredentialOverride(message.context));
    }
    if (interpretStrayDecisionUtterance(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeNoPendingDecision(message.context));
    }

    const durableMemoryContent = ConversationRuntime.explicitDurableMemoryContent(message.text);
    if (durableMemoryContent === '') {
      // QA-010: the explicit command with no content is a usage error, never ordinary chat.
      return this.respondComposed(message, session, this.deps.composer.composeMemoryUsageHint(message.context));
    }
    if (durableMemoryContent !== null) {
      // QA-009: refuse credential declarations at the write gate; nothing is stored.
      if (containsCredentialMaterial(durableMemoryContent)) {
        return this.respondComposed(message, session, this.deps.composer.composeMemorySensitiveRefused(message.context));
      }
      try {
        const candidate = this.deps.memoryWriter.createCandidate({
          content: durableMemoryContent,
          sourceContent: message.text,
          trigger: 'EXPLICIT_USER_INSTRUCTION',
          kind: 'SEMANTIC',
          provenance: 'USER_PROVIDED',
          authorityLevel: 'USER_CLAIM_OR_INTENT',
          scope: { sessionId: session.id, actorId: actor.id },
          metadata: { sourceReferences: [userMemory.id] },
        });
        const decision = await this.deps.memoryWriter.promote(candidate);
        const reply =
          decision.outcome === 'REJECTED' && decision.policyReason === CREDENTIAL_REJECTION_REASON
            ? this.deps.composer.composeMemorySensitiveRefused(message.context)
            : decision.outcome === 'REJECTED'
            ? this.deps.composer.composeMemoryStoreFailed(message.context)
            : this.deps.composer.composeMemoryStored(message.context);
        return this.respondComposed(message, session, reply);
      } catch (error) {
        this.deps.logger.warn('durable memory activation failed', {
          messageId: message.id,
          sessionId: session.id,
          actorId: actor.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return this.respondComposed(
          message,
          session,
          this.deps.composer.composeMemoryStoreFailed(message.context),
        );
      }
    }

    // (B0) ADR-0096 `pre-classify` turn handlers — after the QA-018 stray-decision reply and the `기억해:` block,
    // immediately before the intent classifier.
    const preClassifyDispatch = this.runTurnHandlers('pre-classify', () =>
      this.turnHandlerContext(message, session, actor, applyAnchor),
    );
    const preClassifyHandled = preClassifyDispatch ? await preClassifyDispatch : null;
    if (preClassifyHandled) return this.respondTurnHandler(message, session, actor, userMemory.id, preClassifyHandled);

    let intent: Intent;
    try {
      intent = await this.deps.classifier.classify(message, { hasActiveProject: Boolean(session.activeProjectId) });
    } catch (err) {
      return this.failReadOnlyTurn(message, session, err); // nothing ran yet — provably no mutation
    }
    this.deps.logger.info('intent classified', {
      capability: intent.capability,
      requiresWork: intent.requiresWork,
    });

    // (C) Execution intent → resolve workspace (if needed) → Intent Resolver → Execution Orchestrator. A failure
    // here keeps the conservative MAY_HAVE_APPLIED backstop in `handle`.
    if (this.deps.intentResolver.isExecution(intent)) {
      return this.handleExecutionIntent(message, session, actor, intent);
    }

    // Every remaining route (work surface, project registration, analysis, chat) never reaches a workspace,
    // git or command mutator, so an infrastructure failure renders the confirmed-not-applied wording instead
    // of the backstop's "변경 적용 여부를 확인할 수 없어요".
    try {
      return await this.handleNonExecutionTurn(message, session, actor, intent, userMemory.id);
    } catch (err) {
      return this.failReadOnlyTurn(message, session, err);
    }
  }

  /** Non-execution routes after classification: (L) work surface, (B) registration, (D) analysis, (E)/(F) chat. */
  private async handleNonExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    userMemoryId: Id,
  ): Promise<TurnResult> {
    if (intent.type === IntentType.LOOKUP && intent.raw?.kind === 'personal-work-surface') {
      const surface = await this.deps.workSurface.forActor(actor);
      return this.respondComposed(message, session, this.deps.composer.composeWorkSurface(message.context, surface));
    }

    // (B) Project registration — deterministic command (ADR-0018).
    if (intent.type === IntentType.REGISTER_PROJECT) {
      if (intent.raw?.kind === NON_ABSOLUTE_REGISTRATION_KIND) {
        // QA-015: a relative/home path is never resolved against the process cwd — ask for an absolute path.
        return this.respondComposed(message, session, this.deps.composer.composeProjectPathNotAbsolute(message.context));
      }
      const path = typeof intent.raw?.path === 'string' ? intent.raw.path : '';
      // ADR-0097 D5 (OVR-3 contract): a project switch goes through the override flow FIRST so it is serialized
      // with an in-flight consume; a released anchor pointer is not written back by the registration.
      const released = await this.deps.credentialOverrideFlow?.invalidate(session, 'project-changed', 'system');
      const result = await this.deps.projects.register(path, released ? { ...session, activeTaskId: undefined } : session);
      await this.deps.memory.recordAssistant(result.message, message.context, session.id);
      return this.responded(session, { context: message.context, text: result.message });
    }

    // (D) Gated project analysis (ADR-0019) — gather a read-only readout to feed the prompt.
    let readout: ProjectReadout | undefined;
    if (intent.capability === Capability.PROJECT_ANALYSIS) {
      const prep = await this.deps.analyzer.prepare(session);
      if (!prep.ready) {
        const text = prep.message ?? '프로젝트 분석을 진행할 수 없어요.';
        await this.deps.memory.recordAssistant(text, message.context, session.id);
        return this.responded(session, { context: message.context, text });
      }
      readout = prep.readout;
    }

    // (E) Fast path — conversational, no Task needed.
    if (!intent.requiresWork) {
      const provider = await this.deps.router.select(intent.capability);
      const result = await provider.execute({ capability: intent.capability, prompt: message.text });
      const reply = this.deps.composer.compose(message.context, result, result.artifacts ?? []);
      await this.deps.memory.recordAssistant(result.text, message.context, session.id);
      return this.responded(session, reply);
    }

    // (F) Work path — a chat/analysis Task (existing single-capability flow, relocated).
    return this.handleWorkTurn(message, session, actor, intent, userMemoryId, readout);
  }

  /** Exact, provider-free activation grammar. Pending governance flows have already run before this is called. */
  private static explicitDurableMemoryContent(text: string): string | null {
    const match = text.trim().match(/^(?:기억해줘|기억해|remember)\s*:\s*(.*)$/isu);
    return match ? (match[1] ?? '').trim() : null;
  }

  /** Milliseconds before a pending approval expires (ADR-0093); `<= 0` means expired. */
  private remainingMs(approval: ApprovalRequest): number {
    return pendingApprovalRemainingMs(approval.createdAt, this.clock());
  }

  /** The pending-approval reminder (ADR-0093) — what is pending, 승인/거절, remaining time, 새 대화. */
  private composePendingReminder(context: ConversationContext, approval: ApprovalRequest): OutboundMessage {
    return this.deps.composer.composePendingApprovalReminder(context, approval, this.remainingMs(approval));
  }

  /**
   * Derive the approval holding this conversation, if any (ADR-0093), with the same lookups and order the
   * routing below uses: `approvalFlow.findPending` (plan-scoped, ADR-0032), then the scope clarification
   * (ADR-0037, which holds no approval), then the credential-override set (ADR-0097, whose reconstruction re-reads
   * every ApprovalRequest of the set), then the apply-preview anchor, whose `*_PENDING` status names the
   * PENDING request id (re-read through `approvals.get`, never trusted blindly).
   */
  private async findPendingApproval(session: Session): Promise<PendingApprovalLookup> {
    const planPending = await this.deps.approvalFlow.findPending(session);
    if (planPending) return { planPending, pendingScope: null, applyAnchor: null, override: null, pending: planPending };
    const pendingScope = await this.deps.scopeClarificationFlow.findPending(session);
    if (pendingScope) return { planPending: null, pendingScope, applyAnchor: null, override: null, pending: null };
    const override = (await this.deps.credentialOverrideFlow?.findPending(session)) ?? null;
    if (override) {
      const pending =
        override.state === 'awaiting-decision' && override.approval.status === ApprovalStatus.PENDING
          ? override.approval
          : null;
      return { planPending: null, pendingScope: null, applyAnchor: null, override, pending };
    }
    const applyAnchor = await this.deps.applyPreviewFlow.findAnchor(session);
    const approvalId = applyAnchor ? ConversationRuntime.pendingApprovalIdOf(applyAnchor) : undefined;
    if (!approvalId) return { planPending: null, pendingScope: null, applyAnchor, override: null, pending: null };
    const request = await this.deps.approvals.get(approvalId);
    return {
      planPending: null,
      pendingScope: null,
      applyAnchor,
      override: null,
      pending: request?.status === ApprovalStatus.PENDING ? request : null,
    };
  }

  /** The PENDING approval id an apply-preview anchor status carries, if that status is a pending gate. */
  private static pendingApprovalIdOf(anchor: ApplyPreviewAnchor): Id | undefined {
    switch (anchor.status) {
      case 'AWAITING_APPROVAL':
        return anchor.approvalId;
      case 'COMMIT_APPROVAL_PENDING':
        return anchor.commitApprovalId;
      case 'PUSH_APPROVAL_PENDING':
        return anchor.pushApprovalId;
      case 'PR_APPROVAL_PENDING':
        return anchor.prApprovalId;
      case 'MERGE_APPROVAL_PENDING':
        return anchor.mergeApprovalId;
      case 'REMOTE_BRANCH_CLEANUP_PENDING':
        return anchor.remoteBranchCleanupApprovalId;
      default:
        return undefined;
    }
  }

  /**
   * The anchor after its pending approval was rejected — the same state each decision handler's deny/cancel
   * branch moves to (null = clear: the apply approval has nothing earlier to preserve). Used for expiry.
   */
  private static anchorAfterRejection(anchor: ApplyPreviewAnchor): ApplyPreviewAnchor | null {
    switch (anchor.status) {
      case 'COMMIT_APPROVAL_PENDING':
        return {
          ...anchor,
          status: 'WORKSPACE_APPLIED',
          commitApprovalId: undefined,
          proposedCommitMessage: undefined,
          commitCandidateFiles: undefined,
        };
      case 'PUSH_APPROVAL_PENDING':
        return {
          ...anchor,
          status: 'GIT_COMMITTED',
          pushApprovalId: undefined,
          pushCommitHash: undefined,
          pushRemote: undefined,
          pushBranch: undefined,
          pushUpstreamRef: undefined,
          pushMode: undefined,
        };
      case 'PR_APPROVAL_PENDING':
        return {
          ...anchor,
          status: 'GIT_PUSHED',
          prApprovalId: undefined,
          prPushedCommitHash: undefined,
          prHeadBranch: undefined,
          prBaseBranch: undefined,
          prTitle: undefined,
          prBodyPreview: undefined,
          repositoryIdentity: undefined,
        };
      case 'MERGE_APPROVAL_PENDING':
        return {
          ...anchor,
          status: 'PR_CREATED',
          mergeApprovalId: undefined,
          mergeApprovalRequestedAt: undefined,
          mergeApprovedAt: undefined,
          mergeApprovalDecisionBy: undefined,
        };
      case 'REMOTE_BRANCH_CLEANUP_PENDING':
        return {
          ...anchor,
          status: 'BRANCH_CLEANED',
          remoteBranchCleanupApprovalId: undefined,
          remoteBranchCleanupApprovalRequestedAt: undefined,
          remoteBranchCleanupApprovedAt: undefined,
          remoteBranchCleanupApprovalDecisionBy: undefined,
        };
      default:
        return null; // AWAITING_APPROVAL (apply)
    }
  }

  /**
   * Record an expired PENDING approval as denied (ADR-0093) through the existing `ApprovalManager.decide`:
   * `decidedBy: 'system'` (the system-attribution convention), comment `expired`, `decidedAt` from the shared
   * clock. An anchor-scoped approval also moves its anchor back exactly like a denial, so the expired request
   * can never be approved and the earlier state (e.g. WORKSPACE_APPLIED) survives.
   */
  private async expirePendingApproval(session: Session, lookup: PendingApprovalLookup): Promise<void> {
    const approval = lookup.pending;
    if (!approval) return;
    await this.deps.approvals.decide(approval.id, {
      approvalId: approval.id,
      approved: false,
      decidedBy: 'system',
      decidedAt: this.clock(),
      comment: 'expired',
    });
    if (lookup.override) {
      // ADR-0097 D5: an expired override invalidates its whole set (`system`/`expired`); nothing is sent.
      await this.deps.credentialOverrideFlow?.invalidate(session, 'expired', 'system');
    } else if (!lookup.planPending && lookup.applyAnchor) {
      const released = ConversationRuntime.anchorAfterRejection(lookup.applyAnchor);
      if (released) await this.deps.applyPreviewFlow.anchor(session, released);
      else await this.deps.applyPreviewFlow.clear(session);
    }
    this.deps.logger.info('pending approval expired', { approvalId: approval.id, sessionId: session.id });
  }

  /**
   * Re-check the 30-minute lifetime (ADR-0093) with the injected clock IMMEDIATELY before a positive decision.
   * The turn-start check runs before awaited memory capture / resume reconstruction / request re-reads, so an
   * approval that was live then can be past its deadline by the time it would be approved. Every
   * `approvals.decide(..., approved: true)` site for a conversational pending approval calls this first: when
   * expired it records the same `system`/`expired` denial (and anchor release) as the turn-start path and returns
   * the expiry-notice turn; otherwise `null` and the caller approves. The deadline check is SYNCHRONOUS and
   * callers must not await it on the live path, so no yield point separates the check from `approvals.decide`.
   */
  private expiredBeforeApprove(
    message: InboundMessage,
    session: Session,
    approval: ApprovalRequest,
    applyAnchor: ApplyPreviewAnchor | null,
  ): Promise<TurnResult> | null {
    if (this.remainingMs(approval) > 0) return null;
    return this.recordExpiryBeforeApprove(message, session, approval, applyAnchor);
  }

  /** `override` (ADR-0097): the credential-override set `approval` belongs to, released exactly like turn-start expiry. */
  private async recordExpiryBeforeApprove(
    message: InboundMessage,
    session: Session,
    approval: ApprovalRequest,
    applyAnchor: ApplyPreviewAnchor | null,
    override: CredentialOverrideLookup | null = null,
  ): Promise<TurnResult> {
    await this.expirePendingApproval(session, {
      planPending: applyAnchor || override ? null : approval,
      pendingScope: null,
      applyAnchor,
      override,
      pending: approval,
    });
    const reply = this.deps.composer.composeApprovalExpired(message.context, approval, PENDING_APPROVAL_TTL_MS);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'DENIED', reply, sessionId: session.id };
  }

  /**
   * A help/reset control turn (ADR-0093). Deterministic: no provider call, no Task/TaskRun, and nothing is
   * written to conversational or durable memory. Reset first records a still-pending approval as denied
   * (`decidedBy` = the owner actor, comment `reset`), then closes the Session; the next message opens a new
   * one. Reset never cancels a running TaskRun, rolls back an applied change or commit, or deletes memory.
   */
  private async handleControlTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    command: ConversationControlCommand,
    pending: ApprovalRequest | null,
    expiryNotice: OutboundMessage | null,
  ): Promise<TurnResult> {
    let reply: OutboundMessage;
    if (command === 'help') {
      reply = this.deps.composer.composeHelp(message.context, this.contributedHelpLines);
    } else {
      // ADR-0097 D5 (OVR-3 contract): invalidate a credential-override set (`reset`, by the owner) through the flow
      // BEFORE the session closes, so the reset is serialized with an in-flight consume; nothing is sent.
      await this.deps.credentialOverrideFlow?.invalidate(session, 'reset', actor.id);
      if (pending) {
        await this.deps.approvals.decide(pending.id, {
          approvalId: pending.id,
          approved: false,
          decidedBy: actor.id,
          decidedAt: this.clock(),
          comment: 'reset',
        });
      }
      await this.deps.sessions.close(session);
      reply = this.deps.composer.composeConversationReset(message.context, { deniedPendingApproval: Boolean(pending) });
    }
    this.deps.logger.info('conversation control handled', {
      command,
      sessionId: session.id,
      ...(pending && command === 'reset' ? { deniedApprovalId: pending.id } : {}),
    });
    return this.responded(session, expiryNotice ? this.deps.composer.composeWithNotice(expiryNotice, reply) : reply);
  }

  /**
   * Dispatch one ADR-0096 stage. Returns `null` WITHOUT building a context or yielding when the stage has no
   * handlers, so an empty registry leaves the turn exactly as before; otherwise the stage's handlers run one at a
   * time in registry order and the first non-null reply wins. A thrown error is not caught here: handlers catch
   * their own, and a leaked one reaches the `handle` backstop.
   */
  private runTurnHandlers(
    stage: TurnHandlerStage,
    buildContext: () => TurnHandlerContext,
  ): Promise<TurnHandlerOutcome | null> | null {
    const handlers = this.turnHandlersByStage[stage];
    if (handlers.length === 0) return null;
    return this.dispatchTurnHandlers(stage, handlers, buildContext());
  }

  private async dispatchTurnHandlers(
    stage: TurnHandlerStage,
    handlers: readonly ConversationTurnHandler[],
    ctx: TurnHandlerContext,
  ): Promise<TurnHandlerOutcome | null> {
    for (const handler of handlers) {
      const handled = await handler.handle(ctx);
      if (handled) {
        this.deps.logger.info('turn handler responded', {
          handlerId: handler.id,
          stage,
          sessionId: ctx.session.id,
          status: handled.kind === 'summarize' ? 'SUMMARIZE' : handled.status ?? 'RESPONDED',
        });
        return handled;
      }
    }
    return null;
  }

  /** The ADR-0096 handler context: domain values plus a read-only snapshot of the apply-preview anchor. */
  private turnHandlerContext(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor | null,
  ): TurnHandlerContext {
    const applyAnchor: TurnHandlerAnchorSnapshot | null = anchor
      ? frozenPlainSnapshot({
          status: anchor.status,
          workspaceRef: anchor.workspaceRef,
          ...(anchor.projectId ? { projectId: anchor.projectId } : {}),
        })
      : null;
    // Deep, frozen copies — never the runtime's own objects — so nothing a handler does (even an assignment in
    // sloppy mode, or a mutation it keeps after returning) can change the text the pending-decision routes read,
    // the session the runtime persists, or the actor. The workspace resolver is bound to the session id and active
    // project captured HERE, at dispatch time, not to any object a handler can reach.
    const sessionId = session.id;
    const activeProjectId = session.activeProjectId;
    return Object.freeze({
      message: frozenPlainSnapshot(message),
      session: frozenPlainSnapshot(session),
      actor: frozenPlainSnapshot(actor),
      now: this.clock(),
      applyAnchor,
      resolveActiveWorkspace: () => this.resolveActiveWorkspaceForHandler(sessionId, activeProjectId),
    });
  }

  /** The active project's workspace for a turn handler — `null` when none is active or it cannot be opened. */
  private async resolveActiveWorkspaceForHandler(
    sessionId: Id,
    activeProjectId: Id | undefined,
  ): Promise<WorkspaceRef | null> {
    if (!activeProjectId) return null;
    try {
      const project = await this.deps.projects.get(activeProjectId);
      if (!project) return null;
      return await this.deps.workspace.open({ id: project.id, rootPath: project.rootPath });
    } catch (err) {
      this.deps.logger.warn('turn handler workspace resolution failed', {
        sessionId,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return null;
    }
  }

  /**
   * A `post-anchor` / `pre-classify` handler outcome (ADR-0096 D3): a deterministic reply is recorded like every
   * composed reply; a `summarize` outcome runs the existing SUMMARIZATION work path (ADR-0096 D4, ADR-0100 D8).
   */
  private respondTurnHandler(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    userMemoryId: Id,
    handled: TurnHandlerOutcome,
  ): Promise<TurnResult> {
    if (handled.kind === 'summarize') return this.handleTurnHandlerSummary(message, session, actor, userMemoryId, handled);
    return handled.status === 'FAILED'
      ? this.failComposed(message, session, handled.reply)
      : this.respondComposed(message, session, handled.reply);
  }

  /** A `control` handler outcome as a deterministic reply; a `summarize` outcome degrades to its fallback list. */
  private controlStageReply(
    message: InboundMessage,
    outcome: TurnHandlerOutcome,
  ): { reply: OutboundMessage; status?: 'RESPONDED' | 'FAILED' } {
    if (outcome.kind !== 'summarize') return outcome;
    this.deps.logger.warn('control turn handler summarize outcome ignored', { messageId: message.id });
    return { reply: { context: message.context, text: outcome.fallbackText } };
  }

  /**
   * ADR-0100 D8 work summary. The handler's readout is re-validated (shape, bounds, no credential material, fits the
   * prompt) and handed to the existing `handleWorkTurn` with `Capability.SUMMARIZATION`, so provider selection
   * (capability / priority / `isAvailable`, ADR-0092), Task/TaskRun creation and audit stay exactly where they are.
   * On success the deterministic footer (real links + "N items used") is appended within the message budget. On any
   * other result — a readout that fails re-validation (no provider call), no available provider, a provider failure,
   * or an infrastructure error — the reply is the deterministic list (`fallbackText`).
   */
  private async handleTurnHandlerSummary(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    userMemoryId: Id,
    summary: TurnHandlerSummarizeReply,
  ): Promise<TurnResult> {
    const fallback = (): Promise<TurnResult> =>
      this.respondComposed(message, session, { context: message.context, text: summary.fallbackText });
    if (!isSummarizableExternalWorkReadout(summary.readout)) {
      this.deps.logger.warn('work summary readout rejected', { messageId: message.id, sessionId: session.id });
      return fallback();
    }
    const readout = summary.readout;
    // The summary prompt is self-contained (no transcript / durable recall); the current request text is its only
    // User-authored part, and PromptComposer drops it (readout kept) when the credential detector matches.
    if (isWorkSummaryRequestTextWithheld(message.text)) {
      this.deps.logger.warn('work summary request text withheld from prompt', {
        messageId: message.id,
        sessionId: session.id,
        reasonCode: 'WORK_SUMMARY_REQUEST_CREDENTIAL_MATERIAL',
      });
    }
    const intent: Intent = {
      type: IntentType.SUMMARIZE,
      capability: Capability.SUMMARIZATION,
      confidence: 1,
      requiresWork: true,
      summary: `work summary: ${readout.request.source} ${readout.request.query}`,
      raw: { kind: 'work-chat-summary', source: readout.request.source, query: readout.request.query },
    };
    let result: TurnResult;
    try {
      result = await this.handleWorkTurn(message, session, actor, intent, userMemoryId, readout);
    } catch (err) {
      this.deps.logger.warn('work summary path threw', {
        messageId: message.id,
        sessionId: session.id,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return fallback();
    }
    if (result.status !== 'RESPONDED') return fallback();
    return { ...result, reply: { ...result.reply, text: appendWorkSummaryFooter(result.reply.text, summary.footer) } };
  }

  /**
   * A failure on a route that never reaches a workspace/git/command mutator (classification, work surface,
   * registration, analysis, chat). Same sanitized rendering as the `handle` backstop, but with the provable
   * `CONFIRMED_NOT_APPLIED` line — a chat failure must never say a change may have been applied.
   */
  private failReadOnlyTurn(message: InboundMessage, session: Session, err: unknown): TurnResult {
    const safe = toSafeError(err);
    this.deps.logger.error('read-only turn failed', {
      errorName: err instanceof Error ? err.name : typeof err,
      code: safe.code,
      messageId: message.id,
      sessionId: session.id,
      // internal-only (stdout/stderr sink) — never sent to the user
      stack: err instanceof Error ? err.stack : undefined,
    });
    const reply = this.deps.composer.composeSanitizedError(message.context, safe, {
      requestId: safeRequestId(message.id),
      mutationSafety: 'CONFIRMED_NOT_APPLIED',
    });
    return { status: 'FAILED', reply, sessionId: session.id };
  }

  /** (A) A turn that lands while an approval is pending: interpret + route (ADR-0032 §6). */
  private async handleApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    pending: ApprovalRequest,
  ): Promise<TurnResult> {
    const decision = ConversationRuntime.interpretDecision(message.text);
    this.deps.logger.info('approval decision interpreted', { approvalId: pending.id, decision });

    if (decision === 'ambiguous') {
      // ADR-0093: a non-decision message is captured by the pending approval — a reminder, never chat.
      const reply = this.composePendingReminder(message.context, pending);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id }; // no resume
    }

    if (decision === 'approve') {
      // Reconstruct FIRST — never record a decision we cannot act on (CA review). Only once the
      // halted execution is recoverable do we decide + resume.
      const ctx = await this.deps.approvalFlow.reconstructResume(session, pending);
      if (!ctx) {
        // Can't reconstruct — fail safe: re-ask, and do NOT call ApprovalManager.decide.
        const reply = this.deps.composer.composeApprovalNotice(message.context, pending);
        await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
        return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
      }
      const expired = this.expiredBeforeApprove(message, session, pending, null);
      if (expired) return await expired;
      await this.deps.approvals.decide(pending.id, this.decisionOf(pending.id, actor.id, true));
      const outcome = await this.deps.orchestrator.resume(ctx.request, ctx.prior);
      // ADR-0038: a cleanly-resumed planningOnly request now runs an AI CodeGeneration preview
      // (never Patch/WorkspaceWrite/CommandExecution). A resume outcome that did NOT complete cleanly
      // (rare — e.g. the approval re-fetch failed) falls back to the existing generic handling.
      if (ctx.request.planningOnly) {
        if (outcome.status !== ('COMPLETED' as ExecutionOutcomeStatus)) {
          return this.replyForOutcome(message.context, session, outcome);
        }
        return this.runCodeGenerationPreview(message, session, ctx.request, outcome);
      }
      return this.replyForOutcome(message.context, session, outcome);
    }

    // deny / cancel — record the (rejecting) decision; never resume.
    await this.deps.approvals.decide(pending.id, this.decisionOf(pending.id, actor.id, false));
    const status: RuntimeTurnStatus = decision === 'deny' ? 'DENIED' : 'CANCELLED';
    const replyStatus: ExecutionReplyStatus = decision === 'deny' ? 'DENIED' : 'CANCELLED';
    const reply = this.deps.composer.composeExecutionResult(message.context, replyStatus);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status, reply, sessionId: session.id };
  }

  /**
   * After a planningOnly CODE_IMPLEMENTATION approval resumes cleanly, run AI Code Generation once,
   * in preview mode, and render the result as a unified diff against the current workspace content
   * (ADR-0038, ADR-0039). Never calls ExecutionOrchestrator, Patch, WorkspaceWrite, or
   * CommandExecution — this method's only side effects are at most one CodeGenerationManager.generate()
   * call (CAP-008) and at most one WorkspaceManager.diff() call (CAP-001) — both read-only, neither
   * ever touches the filesystem. Before generate(), each validated (non-new-file) target's current
   * content is read through the read-only WorkspaceManager.read() (CAP-001) and passed as bounded
   * `contextFiles` (QA-012); an unreadable or oversized target fails the preview before any AI call.
   *
   * executionPlanRef, workspaceRef, and a non-empty targetFiles must ALL be present before
   * generate() is ever called — targetFiles is the only allowed scope source; there is no AI
   * target-file guessing. An empty diff result or a changeKind of 'add' for a validated target (its
   * current content could not be found/read at diff time) is a failed preview, never a partial or
   * degraded success (ADR-0039, CA Round 1).
   *
   * The credential-override dispatch (ADR-0097 D5) does not come through here: it prepares the same content
   * before its consume ({@link prepareCodeGeneration}) and enters {@link generateCodeChangePreview} directly.
   */
  private async runCodeGenerationPreview(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
  ): Promise<TurnResult> {
    const prepared = await this.prepareCodeGeneration(request, outcome, []);
    if (!prepared.ok) return this.failCodeGenerationPreparation(message, session, request, outcome, prepared, []);
    return this.generateCodeChangePreview(message, session, request, outcome, prepared.value);
  }

  /**
   * Everything a code-change preview needs BEFORE the provider call: the refs, the targets and each validated
   * target's current content (QA-012). The AI request carries no workspace cwd (CAP-008 MB-2), so each validated
   * target's CURRENT content must arrive as read-only contextFiles — otherwise the provider only sees a bare path
   * and cannot propose a faithful full-file `newContent`. Read via the existing read-only WorkspaceManager.read
   * (CAP-001). An unreadable target or an oversized context is a failed preview (never truncated, never treated as
   * an 'add'); explicit new-file targets are skipped (they must not exist yet). generate() is never called on any
   * of these failures.
   *
   * `grants` admit exactly those refused files whose content still hashes to the grant (ADR-0097 D5). The override
   * path passes the grants it is about to consume, and only sends the prepared content once the flow has consumed
   * exactly those grants (`sameDispatchGrants`), so no read sits between the flow's final validation and generate().
   */
  private async prepareCodeGeneration(
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    grants: readonly CredentialOverrideGrant[],
  ): Promise<CodeGenerationPreparation> {
    const planRef = outcome.refs.executionPlanRef;
    const workspaceRef = request.workspaceRef;
    const targetFiles = request.targetFiles;
    if (!planRef || !workspaceRef || !targetFiles?.length) return { ok: false, failure: 'missing-refs' };
    const context = await readCodeGenerationContextFiles(
      this.deps.workspace,
      workspaceRef,
      targetFiles,
      request.newFileTargets ?? [],
      { credentialOverrides: grants },
    );
    if (!context.ok) return { ok: false, failure: 'context', context };
    return { ok: true, value: { planRef, workspaceRef, targetFiles, contextFiles: context.contextFiles } };
  }

  /** The reply for a failed {@link prepareCodeGeneration} (nothing was sent to the provider). */
  private async failCodeGenerationPreparation(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    failed: Extract<CodeGenerationPreparation, { ok: false }>,
    grants: readonly CredentialOverrideGrant[],
  ): Promise<TurnResult> {
    if (failed.failure === 'missing-refs') {
      this.logPreviewFailure('missing-refs-or-targets', message, session, request);
      return this.failComposed(
        message, session, this.deps.composer.composeCodeGenerationPreviewFailed(message.context), outcome,
      );
    }
    const context = failed.context;
    this.logPreviewFailure(`context-${context.reason}`, message, session, request, {
      targetIndex: context.targetIndex,
      maxFileBytes: MAX_CODEGEN_CONTEXT_FILE_BYTES,
      maxTotalBytes: MAX_CODEGEN_CONTEXT_TOTAL_BYTES,
    });
    const overrideFlow = this.deps.credentialOverrideFlow;
    // ADR-0097 D3: an overridable `credential-assignment` refusal (no hard failure on any target) raises ONE
    // CRITICAL owner override instead of the terminal refusal — only on the first, grant-free read (a refusal
    // inside a granted dispatch means the content changed after the coverage check: nothing is sent).
    if (
      context.reason === 'target-contains-credential' && context.overridable && overrideFlow && grants.length === 0
    ) {
      const refusal: CredentialOverrideRefusal = {
        targetIndex: context.targetIndex,
        targetPath: context.targetPath,
        contentSha256: context.contentSha256,
        line: context.line,
      };
      return this.requestCredentialOverride(message, session, request, outcome, refusal);
    }
    if (context.reason === 'target-changed-since-override') {
      this.deps.logger.warn('credential guard override content changed', {
        sessionId: session.id,
        targetIndex: context.targetIndex,
      });
      return this.failComposed(
        message,
        session,
        this.deps.composer.composeCredentialOverrideContentChanged(message.context, context.targetPath),
        outcome,
      );
    }
    // A target whose content carries credential material is never sent to the provider; the path
    // (user-supplied) goes to the reply only — the log above carries just the target index. With the
    // override flow wired, a token/private-key refusal also says it can never be sent (ADR-0097 D6).
    const reply = context.reason !== 'target-contains-credential'
      ? this.deps.composer.composeCodeGenerationPreviewFailed(message.context)
      : overrideFlow && !context.overridable
      ? this.deps.composer.composeCredentialOverrideHardRefused(message.context, context.targetPath)
      : this.deps.composer.composeCodeGenerationPreviewCredentialRefused(message.context, context.targetPath);
    return this.failComposed(message, session, reply, outcome);
  }

  /**
   * The provider call and the preview built from it, on content already prepared by {@link prepareCodeGeneration}.
   *
   * `override` (ADR-0097 D5, OVR-3 contract) is set only inside the credential-override flow's dispatch: the grants it
   * has just consumed, the grants the content was prepared under, and the dispatch's authorization. Then
   * - this method performs NO awaited I/O before generate(): the consumed grants must equal the prepared ones and
   *   `authorization.recheck()` (expiry by the injected clock, claim on the CONSUMED set, session ACTIVE and bound per
   *   the last canonical load) runs synchronously right before the call — otherwise nothing is sent;
   * - after the provider call it re-loads the canonical session and, unless it is still ACTIVE, bound to the same
   *   project and not re-pointed at a newer request, discards the preview (no anchor, no session save) and says the
   *   request was cancelled; otherwise the apply-preview anchor is written onto that FRESH session (never the turn's
   *   copy), so a reset close, a project switch or a newer pointer that landed meanwhile is never overwritten.
   */
  private async generateCodeChangePreview(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    prepared: PreparedCodeGeneration,
    override?: {
      readonly grants: readonly CredentialOverrideGrant[];
      readonly preparedGrants: readonly CredentialOverrideGrant[];
      readonly authorization: CredentialOverrideDispatchAuthorization;
    },
  ): Promise<TurnResult> {
    const { planRef, workspaceRef, targetFiles, contextFiles } = prepared;
    const grants = override?.grants ?? [];
    // QA follow-up (ADR-0097 D7): once a granted dispatch has reached the provider, every later failure must say
    // the confirmed content WAS sent once but no proposal came of it (a fresh request and a fresh override are
    // needed) — never the plain "could not generate" copy that reads as if nothing left the machine.
    const afterSendFailure = (reply: OutboundMessage): OutboundMessage =>
      override
        ? this.deps.composer.composeCredentialOverrideSentNoProposal(message.context, grants.map((g) => g.path))
        : reply;
    // A failed generation reports truthfully how far the granted content got (ADR-0097 truthful copy): nothing
    // sent (failure before the provider was invoked), sent (the provider returned) or uncertain (the provider
    // call itself threw/timed out). The override was consumed in every case — it is never replayed.
    const generationFailure = (dispatch: CodeGenerationDispatch): OutboundMessage => {
      const failed = this.deps.composer.composeCodeGenerationPreviewFailed(message.context);
      if (!override) return failed;
      return dispatch === 'sent'
        ? afterSendFailure(failed)
        : this.deps.composer.composeCredentialOverrideGenerationFailed(
          message.context, grants.map((g) => g.path), dispatch,
        );
    };
    if (override) {
      // Synchronous — nothing below may await before generate() is invoked.
      const denied = sameDispatchGrants(override.grants, override.preparedGrants)
        ? override.authorization.recheck()
        : 'inconsistent';
      if (denied) {
        this.deps.logger.warn('credential guard override not dispatched', { sessionId: session.id, reason: denied });
        return this.failComposed(
          message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, denied), outcome,
        );
      }
    }

    let generation: CodeGeneration;
    try {
      generation = await this.deps.codeGeneration.generate({
        executionPlanRef: planRef,
        capability: Capability.CODE_IMPLEMENTATION,
        instruction: request.instruction,
        workspaceRef,
        targetFiles,
        ...(contextFiles.length ? { contextFiles } : {}),
      });
    } catch (err) {
      // An exception raised before provider.execute() was invoked is untagged → nothing was sent.
      const dispatch = codeGenerationDispatchOfError(err);
      this.logPreviewFailure('code-generation-exception', message, session, request, { dispatch });
      return this.failComposed(message, session, generationFailure(dispatch), outcome);
    }
    if (generation.status !== CodeGenerationStatus.SUCCEEDED) {
      // A recorded failure without a transmission state cannot be claimed as "not sent".
      const dispatch = generation.dispatch ?? 'uncertain';
      this.logPreviewFailure('code-generation-not-succeeded', message, session, request, {
        codeGenerationId: generation.id,
        dispatch,
        ...(generation.failureKind ? { failureKind: String(generation.failureKind) } : {}),
      });
      return this.failComposed(message, session, generationFailure(dispatch), outcome);
    }

    const proposal = await this.deps.codeGeneration.getProposal(generation);
    if (!proposal) {
      this.logPreviewFailure('missing-proposal', message, session, request, { codeGenerationId: generation.id });
      return this.failComposed(
        message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
      );
    }

    const { inScope, outOfScopeWarnings } = filterInScopeChanges(proposal.proposal, targetFiles);
    if (inScope.length === 0) {
      // Every proposed path was outside the validated targetFiles — never present this as a
      // successful code-change proposal.
      this.logPreviewFailure('out-of-scope-proposal', message, session, request, {
        codeGenerationId: generation.id,
        proposalId: proposal.id,
        outOfScopeCount: outOfScopeWarnings.length,
      });
      return this.failComposed(
        message,
        session,
        afterSendFailure(this.deps.composer.composeCodeGenerationPreviewNoValidChange(message.context, outOfScopeWarnings)),
        outcome,
      );
    }

    let diff: WorkspaceDiff;
    try {
      diff = await this.deps.workspace.diff(workspaceRef, inScope);
    } catch {
      // Read-only failure (e.g. current file unreadable) — same guaranteed non-mutation as every
      // other preview failure (ADR-0039, CA Round 1 Required Change #8).
      this.logPreviewFailure('workspace-diff-throw', message, session, request, {
        codeGenerationId: generation.id,
        proposalId: proposal.id,
      });
      return this.failComposed(
        message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
      );
    }

    // An empty diff result cannot be a successful preview (ADR-0039, CA Round 1 Required Change #3).
    if (diff.files.length === 0) {
      this.logPreviewFailure('empty-diff', message, session, request, {
        codeGenerationId: generation.id,
        proposalId: proposal.id,
      });
      return this.failComposed(
        message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
      );
    }

    // F3-A (Sprint 4c-Follow-up-3, CA APPROVED_WITH_CHANGES §3.1/§3.2): a `changeKind='add'` diff is a
    // valid NEW-FILE preview ONLY for a path that (a) originated from the EXPLICIT new-file flow
    // (`request.newFileTargets`, set by A2 — never inferred from arbitrary targetFiles), (b) is in
    // targetFiles, (c) normalizes to a safe relative path (already guaranteed by
    // extractTargetPathCandidates + normalizeRelativePath), and (d) a read-only existence check
    // confirms does NOT currently exist. Any other `add` — an existing/unreadable file, an
    // extra/unexpected path, or a path not from the explicit new-file flow — stays a FAILED preview
    // (preserves the ADR-0039/ADR-0036 safety the old unconditional gate provided). Every rejection is
    // non-mutating (no file is created — the existence check only lists) and emits an F3-B branch log.
    const normalizedTargets = new Set(targetFiles.map((p) => normalizeRelativePath(p)));
    const newFileTargets = new Set((request.newFileTargets ?? []).map((p) => normalizeRelativePath(p)));
    for (const file of diff.files) {
      if (file.changeKind !== 'add') continue;
      const norm = normalizeRelativePath(file.path);
      if (!newFileTargets.has(norm) || !normalizedTargets.has(norm)) {
        // 'add' for a non-explicit / unexpected / not-a-new-file target — the original failure.
        this.logPreviewFailure('unexpected-add-diff', message, session, request, {
          codeGenerationId: generation.id,
          proposalId: proposal.id,
        });
        return this.failComposed(
          message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
        );
      }
      // Read-only existence re-check (only lists; never creates the file): an explicit new-file target
      // must NOT already exist. If it exists — or we cannot confirm non-existence — reject; this keeps
      // the "existing file, content unreadable at diff time" case the old gate caught.
      let exists: boolean;
      try {
        const hits = await this.deps.workspace.list(workspaceRef, file.path);
        exists = hits.some((hit) => normalizeRelativePath(hit) === norm);
      } catch {
        this.logPreviewFailure('add-existence-check-failed', message, session, request, {
          codeGenerationId: generation.id,
          proposalId: proposal.id,
        });
        return this.failComposed(
          message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
        );
      }
      if (exists) {
        this.logPreviewFailure('add-diff-for-existing-file', message, session, request, {
          codeGenerationId: generation.id,
          proposalId: proposal.id,
        });
        return this.failComposed(
          message, session, afterSendFailure(this.deps.composer.composeCodeGenerationPreviewFailed(message.context)), outcome,
        );
      }
    }

    const diffPreview = toCodeDiffPreview(diff, outOfScopeWarnings);
    // ADR-0097 D7: a preview built from granted content leads with the one-time-send notice (in the preview
    // header, so lossless preview delivery keeps it); every other preview is rendered exactly as before.
    const reply = grants.length
      ? this.deps.composer.composeCodeDiffPreview(message.context, diffPreview, {
          credentialOverrideSentPaths: grants.map((g) => g.path),
        })
      : this.deps.composer.composeCodeDiffPreview(message.context, diffPreview);
    // ADR-0097 D5 (OVR-3 contract): a granted dispatch writes onto the canonical session re-loaded AFTER the provider
    // call, and only while it still admits this request; otherwise the preview is discarded (no anchor, no save).
    let anchorSession = session;
    if (override) {
      const reloaded = await override.authorization.reloadSession();
      if (!reloaded.ok) {
        this.deps.logger.warn('credential guard override preview discarded', {
          sessionId: session.id,
          reason: reloaded.reason,
          codeGenerationId: generation.id,
        });
        // Truthful: the granted content WAS sent once; the request itself is cancelled and nothing was kept
        // (dedicated copy — not the reused scope-clarification "request cancelled" text).
        const cancelled = this.deps.composer.composeCredentialOverrideSentThenCancelled(
          message.context,
          grants.map((g) => g.path),
        );
        return this.failComposed(message, session, cancelled, outcome);
      }
      anchorSession = reloaded.session;
    }
    // Sprint 2s (ADR-0040): remember what was just previewed, in case the user explicitly asks to apply
    // it on a later turn. A plan-less Task anchor — never discoverable by approvalFlow.
    await this.deps.applyPreviewFlow.anchor(anchorSession, {
      kind: 'code-preview-apply',
      status: 'ELIGIBLE',
      executionPlanRef: planRef,
      workspaceRef,
      targetFiles,
      // ADR-0099 D1: persist the explicit new-file targets — the only paths a later add may target.
      ...(newFileTargets.size ? { newFileTargets: [...newFileTargets] } : {}),
      codeGenerationRef: codeGenerationRef(generation),
      codeProposalRef: codeProposalRef(proposal),
      instruction: request.instruction,
      ...(anchorSession.activeProjectId ? { projectId: anchorSession.activeProjectId } : {}),
      createdAt: now(),
    });
    return this.respondComposed(message, session, reply, outcome);
  }

  /**
   * F3-B (Sprint 4c-Follow-up-3): secret-free branch log for an internally-caught preview failure. The
   * `runCodeGenerationPreview` failure branches are NOT covered by the inbound catch (Track B), so
   * without this the branch was only diagnosable by inspecting the sqlite aggregate (as the last
   * disambiguation required). Emits ONLY safe metadata — a branch identifier + non-secret ids/counts.
   * NEVER proposal content, file contents, rendered diff text, tokens, or secrets (the `Logger` port's
   * `LogFields` is primitive-only by contract, and callers pass only ids/counts).
   */
  private logPreviewFailure(
    branch: string,
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    extra: LogFields = {},
  ): void {
    this.deps.logger.warn('code preview failed', {
      stage: 'code-generation-preview',
      branch,
      capability: 'CODE_IMPLEMENTATION',
      sessionId: session.id,
      messageId: message.id,
      ...(request.targetFiles ? { targetPathCount: request.targetFiles.length } : {}),
      ...(request.newFileTargets ? { newFileTargetCount: request.newFileTargets.length } : {}),
      ...extra,
    }); // deliberately NO proposal content / file contents / diff text / tokens / secrets
  }

  // ---------------------------------------------------------------------------------------------------------
  // Credential-guard override (ADR-0097). The flow owns every grant record (on the inert plan-less anchor Task);
  // the runtime only routes, records ApprovalManager decisions, and runs the single dispatch through the flow.
  // Logs carry ids, target index, hash and line only — never a path or any file content.
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Raise one CRITICAL override for an overridable refusal of the request in flight (ADR-0097 D3): the flow creates
   * the request via `requestForRisk` and anchors (or extends) the request's grant set; the reply names file and
   * line. When the set cannot be raised, the refusal stays terminal and a just-created request is closed.
   */
  private async requestCredentialOverride(
    message: InboundMessage,
    session: Session,
    request: ExecutionRequest,
    outcome: ExecutionOutcome,
    refusal: CredentialOverrideRefusal,
  ): Promise<TurnResult> {
    const flow = this.deps.credentialOverrideFlow;
    // The owner is the session's actor; fail closed when the session carries none (never a placeholder owner).
    const ownerActorId = session.actorId;
    const raised = flow && ownerActorId
      ? await flow.requestOverride(session, { request, outcome, ownerActorId, refusal }, this.deps.approvals)
      : null;
    if (!raised?.ok) {
      if (raised?.pendingApproval) {
        await this.closeCredentialOverrideApproval(raised.pendingApproval, 'system', `credential-override-${raised.reason}`);
      }
      // A set already holding grants of this request can no longer complete: never leave it GRANTED.
      await flow?.invalidate(session, 'inconsistent', 'system');
      this.deps.logger.warn('credential guard override not raised', {
        sessionId: session.id,
        reason: raised ? raised.reason : 'unbound',
        targetIndex: refusal.targetIndex,
      });
      return this.failComposed(
        message,
        session,
        this.deps.composer.composeCodeGenerationPreviewCredentialRefused(message.context, refusal.targetPath),
        outcome,
      );
    }
    this.deps.logger.warn('credential guard override requested', {
      sessionId: session.id,
      approvalId: raised.approval.id,
      targetIndex: refusal.targetIndex,
      contentSha256: refusal.contentSha256,
      line: refusal.line,
      grantCount: raised.anchor.grants.length,
    });
    const reply = this.deps.composer.composeCredentialOverridePrompt(message.context, refusal.targetPath, refusal.line);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id, executionOutcome: outcome };
  }

  /**
   * A turn while a credential-override set is live (ADR-0097 D3/D5): only the dedicated send phrase sends;
   * deny/cancel ends the whole set; anything else (including "승인") re-prompts with the remaining time. A send
   * re-checks the set's expiry synchronously right before `decide` (ADR-0095 §5), records the grant, then either
   * raises the next refused target's override or runs the single revalidated dispatch.
   */
  private async handleCredentialOverrideTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    override: Extract<CredentialOverrideLookup, { state: 'awaiting-decision' | 'ready' }>,
  ): Promise<TurnResult> {
    const flow = this.deps.credentialOverrideFlow!; // a lookup exists only when the flow is wired
    const grant = override.state === 'awaiting-decision' ? override.grant : override.anchor.grants.at(-1);
    const path = grant?.path ?? '';
    const decision = interpretCredentialOverrideDecision(message.text);
    this.deps.logger.info('credential override decision interpreted', {
      sessionId: session.id,
      decision,
      state: override.state,
      ...(override.state === 'awaiting-decision' ? { approvalId: override.approval.id } : {}),
    });

    if (decision === 'reprompt') {
      const reply = this.deps.composer.composeCredentialOverrideReprompt(message.context, path, override.remainingMs);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }

    if (decision === 'deny') {
      if (override.state === 'awaiting-decision') {
        await this.deps.approvals.decide(override.approval.id, {
          approvalId: override.approval.id,
          approved: false,
          decidedBy: actor.id,
          decidedAt: this.clock(),
          comment: CREDENTIAL_OVERRIDE_DENY_COMMENT,
        });
      }
      const result = await flow.invalidate(session, 'denied', actor.id);
      this.deps.logger.info('credential guard override denied', { sessionId: session.id });
      const reply = result?.state === 'consumed'
        ? this.deps.composer.composeCredentialOverrideAlreadyUsed(message.context)
        : this.deps.composer.composeCredentialOverrideDenied(message.context, path);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'DENIED', reply, sessionId: session.id };
    }

    // send
    if (override.state === 'ready') return this.continueCredentialOverride(message, session, actor, override.anchor);
    const approval = override.approval;
    // The whole set expires with its OLDEST override (ADR-0097 D5): read the earlier grants' requests first, then
    // check synchronously — no await between the deadline check and `decide`.
    const earlier: ApprovalRequest[] = [];
    for (const g of override.anchor.grants) {
      if (g.approvalRequestId === approval.id) continue;
      const r = await this.deps.approvals.get(g.approvalRequestId);
      if (r) earlier.push(r);
    }
    if (Math.min(this.remainingMs(approval), ...earlier.map((r) => this.remainingMs(r))) <= 0) {
      return this.recordExpiryBeforeApprove(message, session, approval, null, override);
    }
    await this.deps.approvals.decide(approval.id, {
      approvalId: approval.id,
      approved: true,
      decidedBy: actor.id,
      decidedAt: this.clock(),
      comment: CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
    });
    const granted = await flow.recordGrant(session, approval.id);
    if (!granted.ok) {
      if (granted.pendingApproval) {
        await this.closeCredentialOverrideApproval(granted.pendingApproval, 'system', `credential-override-${granted.reason}`);
      }
      this.deps.logger.warn('credential guard override grant not recorded', {
        sessionId: session.id,
        approvalId: approval.id,
        reason: granted.reason,
      });
      const reason: CredentialOverrideInvalidationReason =
        granted.reason === 'not-found' || granted.reason === 'not-pending' ? 'inconsistent' : granted.reason;
      return this.failComposed(message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, reason));
    }
    this.deps.logger.warn('credential guard override granted', {
      sessionId: session.id,
      approvalId: approval.id,
      targetIndex: override.grant.targetIndex,
      contentSha256: override.grant.contentSha256,
      line: override.grant.line,
    });
    return this.continueCredentialOverride(message, session, actor, granted.anchor);
  }

  /**
   * After a grant (or for a fully granted set found at turn start): if another target of the same request still
   * needs its own override, raise it on the same anchor; on a hard failure invalidate the set; otherwise consume
   * the whole set and run the preview ONCE with the consumed grants and the anchor's `newFileTargets`.
   */
  private async continueCredentialOverride(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: CredentialOverrideAnchor,
  ): Promise<TurnResult> {
    const flow = this.deps.credentialOverrideFlow!;
    // ADR-0099: the anchor holds the request's explicit new-file targets; the re-run must keep them.
    const request: ExecutionRequest = anchor.newFileTargets.length
      ? { ...anchor.request, newFileTargets: [...anchor.newFileTargets] }
      : anchor.request;
    const coverage = await assessCredentialOverrideCoverage(
      this.deps.workspace,
      anchor.workspaceRef,
      request.targetFiles ?? [],
      anchor.newFileTargets,
      anchor.grants,
    );
    if (coverage.kind === 'needs-override') {
      return this.requestCredentialOverride(message, session, request, anchor.outcome, coverage.refusal);
    }
    if (coverage.kind === 'blocked') {
      // Something changed since the override was raised (at refusal time no target had a hard failure).
      await flow.invalidate(session, 'changed', 'system');
      this.deps.logger.warn('credential guard override blocked', {
        sessionId: session.id,
        reason: coverage.reason,
        targetIndex: coverage.targetIndex,
      });
      const targetPath = coverage.targetPath ?? '';
      const reply =
        coverage.reason === 'target-changed-since-override'
          ? this.deps.composer.composeCredentialOverrideContentChanged(message.context, targetPath)
          : coverage.reason === 'target-contains-credential'
          ? this.deps.composer.composeCredentialOverrideHardRefused(message.context, targetPath)
          : this.deps.composer.composeCredentialOverrideInvalidated(message.context, 'changed');
      return this.failComposed(message, session, reply, anchor.outcome);
    }

    // The binding is to the request's workspace: it must still be the active project's workspace.
    const project = session.activeProjectId ? await this.deps.projects.get(session.activeProjectId) : null;
    if (!project || project.id !== anchor.projectId || project.rootPath !== anchor.workspaceRef.rootPath) {
      await flow.invalidate(session, 'project-changed', 'system');
      return this.failComposed(
        message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, 'project-changed'),
      );
    }
    // OVR-3 contract: read, classify and grant-check every target's content BEFORE the consume, so the dispatch
    // below performs no awaited I/O between the flow's final validation and generate(). The content is prepared
    // under the grants about to be consumed and sent only if the flow consumes exactly those grants; a granted
    // target's content must still hash to its grant here, and the flow's own revalidation read (under its
    // serialization) must match it too. A failure here leaves the set GRANTED, so it is invalidated: nothing sent.
    const preparedGrants = toDispatchGrants(anchor);
    const prepared = await this.prepareCodeGeneration(request, anchor.outcome, preparedGrants);
    if (!prepared.ok) {
      await flow.invalidate(session, prepared.failure === 'missing-refs' ? 'inconsistent' : 'changed', 'system');
      return this.failCodeGenerationPreparation(message, session, request, anchor.outcome, prepared, preparedGrants);
    }
    const dispatched = await flow.consumeAndDispatch(
      session,
      {
        actorId: actor.id,
        workspaceRef: anchor.workspaceRef,
        projectId: session.activeProjectId,
        executionPlanId: anchor.executionPlanId,
        reader: this.deps.workspace,
      },
      (grants, authorization) =>
        this.generateCodeChangePreview(message, session, request, anchor.outcome, prepared.value, {
          grants,
          preparedGrants,
          authorization,
        }),
    );
    if (dispatched.ok) return dispatched.value;
    this.deps.logger.warn('credential guard override not dispatched', { sessionId: session.id, reason: dispatched.reason });
    if (dispatched.reason === 'already-used') {
      return this.failComposed(message, session, this.deps.composer.composeCredentialOverrideAlreadyUsed(message.context));
    }
    let reason: CredentialOverrideInvalidationReason;
    if (dispatched.reason === 'not-found' || dispatched.reason === 'not-granted' || dispatched.reason === 'consume-failed') {
      reason = 'inconsistent';
      await flow.invalidate(session, reason, 'system'); // never leave an undispatchable set GRANTED
    } else {
      reason = dispatched.reason;
    }
    return this.failComposed(message, session, this.deps.composer.composeCredentialOverrideInvalidated(message.context, reason));
  }

  /**
   * A set the flow invalidated while reconstructing it at turn start (expired, project changed, superseded,
   * inconsistent, …): close its still-PENDING request and return the notice answered like an ADR-0093 expiry.
   */
  private async closeInvalidatedCredentialOverride(
    message: InboundMessage,
    session: Session,
    override: Extract<CredentialOverrideLookup, { state: 'invalidated' }>,
  ): Promise<OutboundMessage> {
    if (override.pendingApproval) {
      const comment = override.reason === 'expired' ? 'expired' : `credential-override-${override.reason}`;
      await this.closeCredentialOverrideApproval(override.pendingApproval, 'system', comment);
    }
    this.deps.logger.info('credential guard override invalidated', { sessionId: session.id, reason: override.reason });
    return this.deps.composer.composeCredentialOverrideInvalidated(message.context, override.reason);
  }

  /** Close a still-PENDING override request as rejected (it is never left PENDING); an already-decided one is kept. */
  private async closeCredentialOverrideApproval(approval: ApprovalRequest, decidedBy: string, comment: string): Promise<void> {
    const current = await this.deps.approvals.get(approval.id);
    if (current?.status !== ApprovalStatus.PENDING) return;
    await this.deps.approvals.decide(approval.id, {
      approvalId: approval.id,
      approved: false,
      decidedBy,
      decidedAt: this.clock(),
      comment,
    });
  }

  /** No eligible apply-preview anchor exists at all (Sprint 2s, ADR-0040) — an explicit apply phrase is
   *  never reinterpreted as a new, unscoped code-change request. Never reaches the classifier or the
   *  Orchestrator. */
  private async handleApplyPreviewUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeApplyPreviewUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** The apply approval was already decided APPROVED and the user asked to apply again (Sprint 2s,
   *  ADR-0040) — never re-asks, never creates a duplicate approval. */
  private async handleApplyAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeApplyApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /**
   * An explicit apply phrase arrived while the anchor is ELIGIBLE (Sprint 2s, ADR-0040) — create the
   * second, HIGH-risk ApprovalRequest and halt. Never calls ExecutionOrchestrator, Patch, WorkspaceWrite,
   * or CommandExecution.
   */
  private async handleApplyIntentTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    if (!anchor.workspaceRef || !anchor.targetFiles.length || !anchor.codeProposalRef) {
      // Defensive — the anchor is always written complete (runCodeGenerationPreview), but never trust
      // it blindly.
      const reply = this.deps.composer.composeApplyPreviewUnavailable(message.context);
      return this.failComposed(message, session, reply);
    }
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.HIGH, // apply approval is unconditionally HIGH, never auto-approved
      reason:
        `Apply AI code proposal ${anchor.codeProposalRef.id} from generation ${anchor.codeGenerationRef.id} ` +
        `to ${anchor.targetFiles.join(', ')}`,
      requestedBy: actor.id,
    });
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'AWAITING_APPROVAL', approvalId: approval.id });
    const reply = this.deps.composer.composeApplyApprovalRequested(message.context, anchor.targetFiles);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
  }

  /**
   * Decide the already-created second (apply) approval (Sprint 2s, ADR-0040). Reuses the same
   * interpretDecision (./approval-decision) the first approval uses — only the *creation* trigger needed a
   * distinct word-set, not the decision itself. Approving re-anchors as
   * APPROVED (never clears) so a future Apply sprint can recover every ref; denying/cancelling clears.
   */
  private async handleApplyApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const decision = ConversationRuntime.interpretDecision(message.text);
    if (decision === 'ambiguous') {
      const fresh = await this.deps.approvals.get(anchor.approvalId!);
      const reply = fresh
        ? this.composePendingReminder(message.context, fresh)
        : this.deps.composer.composeApplyPreviewUnavailable(message.context); // pathological
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }

    const approved = decision === 'approve';
    if (approved) {
      const request = await this.deps.approvals.get(anchor.approvalId!);
      const expired = request ? this.expiredBeforeApprove(message, session, request, anchor) : null;
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(anchor.approvalId!, this.decisionOf(anchor.approvalId!, actor.id, approved));

    if (!approved) {
      // deny / cancel — nothing left to preserve.
      await this.deps.applyPreviewFlow.clear(session);
      const replyStatus: ExecutionReplyStatus = decision === 'deny' ? 'DENIED' : 'CANCELLED';
      const reply = this.deps.composer.composeExecutionResult(message.context, replyStatus);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: decision === 'deny' ? 'DENIED' : 'CANCELLED', reply, sessionId: session.id };
    }

    // approve — Sprint 2s stops here (no Patch/WorkspaceWrite/CommandExecution/git call), but the
    // approved context MUST survive for a future Apply sprint. Re-anchor (never clear): every ref this
    // anchor carries is exactly what that future sprint will need.
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'APPROVED', approvedAt: now() });
    const reply = this.deps.composer.composeApplyApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /**
   * An explicit patch command arrived while the apply anchor is APPROVED (Sprint 2t, ADR-0041) — recover
   * the approved context, re-validate against the latest workspace content, and generate a PatchSet
   * REPRESENTATION via the existing Patch capability (CAP-005). Never applies: no WorkspaceWrite, no
   * CommandExecution, no git/file mutation. The Application layer derives the ApprovalRef and injects it;
   * PatchManager never queries ApprovalManager. On success the anchor becomes PATCH_READY (patchRef
   * preserved for Sprint 2u); a PatchSet existing does NOT mean it was applied.
   */
  private async handlePatchGenerationTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. Approved-context guards.
    if (!anchor.approvalId || !anchor.workspaceRef || !anchor.targetFiles.length || !anchor.codeProposalRef) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }
    const approval = await this.deps.approvals.get(anchor.approvalId);
    if (!approval || approval.status !== ApprovalStatus.APPROVED) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }

    // 2. Source of truth = the CodeProposal aggregate, never rendered diff text / chat memory.
    const proposal = await this.deps.codeProposals.get(anchor.codeProposalRef.id);
    if (!proposal) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }

    // 3. Re-filter against validated targetFiles — targetFiles stays authoritative.
    const { inScope } = filterInScopeChanges(proposal.proposal, anchor.targetFiles);
    if (inScope.length === 0) {
      return this.failComposed(message, session, this.deps.composer.composePatchUnavailable(message.context));
    }

    // 4. Re-run WorkspaceManager.diff against CURRENT content — staleness/add/binary/empty check.
    let diff: WorkspaceDiff;
    try {
      diff = await this.deps.workspace.diff(anchor.workspaceRef, inScope);
    } catch {
      this.logPatchGenerationFailed(session, anchor, 'workspace diff failed');
      return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
    }
    // No PatchSet for empty / delete / binary / oversized (empty unified) / out-of-bounds results, nor for an
    // `add` outside the anchor's persisted newFileTargets (ADR-0099 D1; a pre-ADR-0099 anchor admits none).
    const patchable = validatePatchableDiff(diff, anchor);
    if (!patchable.ok) {
      this.logPatchGenerationFailed(session, anchor, patchable.reason);
      return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
    }
    // Each `add` path is re-checked absent (read-only list; never creates anything) — ADR-0099 D1.
    for (const addPath of patchable.addPaths) {
      let exists: boolean;
      try {
        const hits = await this.deps.workspace.list(anchor.workspaceRef, addPath);
        exists = hits.some((hit) => normalizeRelativePath(hit) === normalizeRelativePath(addPath));
      } catch {
        exists = true; // cannot confirm absence → fail closed
      }
      if (exists) {
        this.logPatchGenerationFailed(session, anchor, 'new-file target exists or could not be checked');
        return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
      }
    }

    // 5. Application derives the ApprovalRef; PatchManager receives it and re-validates.
    let patchSet: PatchSet;
    try {
      patchSet = await this.deps.patch.generate({
        executionPlanRef: anchor.executionPlanRef,
        approvalRef: approvalRef(approval),
        changes: inScope,
        diff,
      });
    } catch {
      this.logPatchGenerationFailed(session, anchor, 'patch generation failed');
      return this.failComposed(message, session, this.deps.composer.composePatchGenerationFailed(message.context));
    }

    // 6. Preserve PatchRef on the anchor for Sprint 2u — re-anchor PATCH_READY, never clear.
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'PATCH_READY', patchRef: patchRef(patchSet) });

    // 7. ResponseComposer renders the preview from PatchSet facts.
    const reply = this.deps.composer.composePatchSetPreview(message.context, {
      operations: patchSet.operations.map((op) => ({ path: op.path, kind: op.operation, unified: op.diff })),
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A patch command arrived while the anchor is already PATCH_READY (Sprint 2t) — never regenerates. */
  private async handlePatchAlreadyGeneratedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePatchAlreadyGenerated(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A patch command arrived with no APPROVED/PATCH_READY apply context (Sprint 2t) — never a new
   *  code-change request, never reaches the classifier or the Orchestrator. */
  private async handlePatchUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePatchUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for PatchSet generation (Sprint 2t, ADR-0041 — CA Round 1) — so
   *  operators can trace failures without the user seeing internals and without leaking diff/file text. */
  private logPatchGenerationFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('PatchSet generation failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
      approvalId: anchor.approvalId,
      codeProposalId: anchor.codeProposalRef.id,
      targetFiles: anchor.targetFiles.join(', '),
    }); // deliberately NO diff text / file content
  }

  /**
   * An explicit final workspace-apply command arrived while the anchor is PATCH_READY (Sprint 2u,
   * ADR-0042) — the first real file mutation. Loads the PatchSet by patchRef, verifies its integrity
   * (identity/status/approval/plan, 1..5 in-scope `update`/`add` ops with add ⇔ newFileTargets — ADR-0099),
   * applies it through WorkspaceWrite (the ONLY file mutator: a single `update` via the per-file `apply`, any
   * other set via the all-or-nothing `applyChangeSet`; both re-validate each diff against current content),
   * verifies the returned WorkspaceChange, and re-anchors WORKSPACE_APPLIED. Never calls git,
   * CommandExecution, ExecutionOrchestrator, PatchManager.generate, or CodeGeneration.
   */
  private async handleWorkspaceApplyTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 1. Anchor-state guard: PATCH_READY must carry a patchRef + the refs we need.
    if (!anchor.patchRef || !anchor.workspaceRef || !anchor.approvalId || !anchor.executionPlanRef) {
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyUnavailable(message.context));
    }

    // 2. Load the PatchSet — the artifact to apply (CA Q2).
    const patchSet = await this.deps.patch.get(anchor.patchRef.id);
    if (!patchSet) {
      this.logWorkspaceApplyFailed(session, anchor, 'patch set not found');
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }

    // 3. PatchSet integrity (CA Q5 + CA Round 1 #1/#2, widened by ADR-0099 D1): the anchored, GENERATED,
    //    approval/plan-bound PatchSet with 1..5 unique in-scope `update`/`add` ops, add ⇔ newFileTargets;
    //    delete/binary/out-of-scope all rejected.
    const integrity = validateChangeSetForApply(patchSet, anchor);
    if (!integrity.ok) {
      this.logWorkspaceApplyFailed(session, anchor, `patch set failed integrity/support checks: ${integrity.reason}`);
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }

    // 4. Apply through WorkspaceWrite — the ONLY file mutation. The single-`update` ADR-0042 shape keeps the
    //    per-file `apply` (its applyPatch re-validates the diff against current content: stale → 'failed',
    //    file unchanged). Every other allowed set goes through the all-or-nothing `applyChangeSet` (ADR-0099 D2).
    const applyInput: ApplyInput = {
      patchSet,
      approvalRef: patchSet.approvalRef, // the approval that authorized THIS patch (§5.3)
      workspaceRef: anchor.workspaceRef,
    };
    const single = isSingleUpdateChangeSet(patchSet.operations);
    const applyChangeSet = this.deps.workspaceWrite.applyChangeSet?.bind(this.deps.workspaceWrite);
    if (!single && !applyChangeSet) {
      this.logWorkspaceApplyFailed(session, anchor, 'change-set apply unavailable');
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }
    let change: WorkspaceChange;
    try {
      change = single || !applyChangeSet
        ? await this.deps.workspaceWrite.apply(applyInput)
        : await applyChangeSet(applyInput);
    } catch {
      this.logWorkspaceApplyFailed(session, anchor, 'workspace write threw');
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceApplyFailed(message.context));
    }

    // 5. Result-integrity gate (CA Round 1 #3/#4, ADR-0099 D2). Success requires APPLIED AND a full match of the
    //    returned change to the artifact/context, results one-to-one with the ops; anything else → no
    //    WORKSPACE_APPLIED. A change set reports by outcome: rolled back → "nothing changed"; a partial or
    //    unverifiable state → "may have applied" with the file list.
    if (!verifyAppliedChangeSet(change, patchSet, anchor.workspaceRef)) {
      this.logWorkspaceApplyFailed(session, anchor, `workspace change not cleanly applied (status ${change.status})`);
      const outcome = single ? 'failed' : classifyUnverifiedChangeSet(change);
      const files = patchSet.operations.map((o) => o.path);
      const reply =
        outcome === 'rolled-back'
          ? this.deps.composer.composeWorkspaceApplyRolledBack(message.context, files)
          : outcome === 'may-have-applied'
            ? this.deps.composer.composeWorkspaceApplyPartiallyApplied(message.context, files)
            : this.deps.composer.composeWorkspaceApplyFailed(message.context);
      return this.failComposed(message, session, reply);
    }

    // 6. Success — re-anchor WORKSPACE_APPLIED, preserving the WorkspaceChangeRef for a future git/test sprint.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'WORKSPACE_APPLIED',
      workspaceChangeRef: workspaceChangeRef(change),
    });
    const reply = this.deps.composer.composeWorkspaceApplied(
      message.context,
      patchSet.operations.map((o) => o.path),
      integrity.newFiles,
    );
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A final/patch/apply command arrived while the anchor is WORKSPACE_APPLIED (Sprint 2u) — never
   *  re-applies, and never understates the applied state (CA Round 1 #8). */
  private async handleWorkspaceAlreadyAppliedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeWorkspaceAlreadyApplied(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A final-apply command arrived with no PATCH_READY/WORKSPACE_APPLIED apply context (Sprint 2u) —
   *  never a new code-change request, never reaches the classifier or the Orchestrator. */
  private async handleWorkspaceApplyUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeWorkspaceApplyUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for workspace apply (Sprint 2u, ADR-0042 — CA Round 1) — so
   *  operators can trace failures without the user seeing internals and without leaking diff/file text. */
  private logWorkspaceApplyFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('workspace apply failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
      approvalId: anchor.approvalId,
      patchId: anchor.patchRef?.id,
      targetFiles: anchor.targetFiles.join(', '),
    }); // deliberately NO diff text / file content
  }

  /**
   * An explicit post-apply validation command arrived while the anchor is WORKSPACE_APPLIED (Sprint 2v,
   * ADR-0043) — run exactly one allow-listed validation command (`pnpm test`/`pnpm typecheck`) through
   * CommandExecution, against the workspace the file was applied to (`anchor.workspaceRef`), tied to the
   * applied change (`anchor.workspaceChangeRef`). Never spawns a shell, calls git, mutates a file, or
   * touches the ExecutionOrchestrator. `kind` came from `interpretPostApplyValidationIntent`:
   *  - `'unsupported'` → a validation phrase carried an out-of-allow-list command fragment (CA #2);
   *  - `'ambiguous'`   → bare "검증" or BOTH test+typecheck requested (CA #1);
   * both are NORMAL responses (RESPONDED), run nothing, never re-anchor, never set a ref (CA #3).
   */
  private async handlePostApplyValidationTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
    kind: 'test' | 'typecheck' | 'ambiguous' | 'unsupported',
  ): Promise<TurnResult> {
    // 1. (CA #2/#3) Dangerous/arbitrary command fragment → a distinct "unsupported" reply. NORMAL turn.
    if (kind === 'unsupported') {
      return this.respondComposed(message, session, this.deps.composer.composePostApplyValidationUnsupported(message.context));
    }

    // 2. (CA #1/#3) Ambiguous — bare "검증" OR both test+typecheck → ask for exactly one. NORMAL turn.
    if (kind === 'ambiguous') {
      return this.respondComposed(message, session, this.deps.composer.composePostApplyValidationClarify(message.context));
    }

    // 3. Anchor guard: WORKSPACE_APPLIED must carry the refs we need (defensive; set at apply time).
    if (!anchor.workspaceRef || !anchor.executionPlanRef) {
      return this.failComposed(message, session, this.deps.composer.composePostApplyValidationUnavailable(message.context));
    }

    // 4. Derive exactly one allow-listed command — NEVER from user text (CA Constraint 3 / #2).
    const args = kind === 'typecheck' ? ['typecheck'] : ['test'];

    // 5. Run via CommandExecution — the ONLY command runner. cwd = the applied workspace (CA Q6); tied to
    //    the applied change via workspaceChangeRef (CA Q8). `pnpm test`/`pnpm typecheck` are MEDIUM risk →
    //    no approvalRef needed. (CA #4) A throw BEFORE a CommandExecution exists → no re-anchor, no ref.
    let execution: CommandExecution;
    try {
      execution = await this.deps.command.run({
        executionPlanRef: anchor.executionPlanRef,
        workspaceRef: anchor.workspaceRef,
        ...(anchor.workspaceChangeRef ? { workspaceChangeRef: anchor.workspaceChangeRef } : {}),
        command: 'pnpm',
        args,
      });
    } catch {
      this.logPostApplyValidationFailed(session, anchor, 'command execution threw');
      return this.failComposed(message, session, this.deps.composer.composePostApplyValidationUnavailable(message.context));
    }

    // 6. (CA #4/#6) A CommandExecution now exists (SUCCEEDED/FAILED/TIMED_OUT). Preserve its ref on the
    //    anchor — LATEST ONLY (replaces any prior; no history on the anchor). `status` stays
    //    WORKSPACE_APPLIED — no WORKSPACE_VALIDATED.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      postApplyValidationRef: commandExecutionRef(execution),
    });

    // 7. Render (CA Q9/Q10/Q11) — reuses the Sprint 2m/2n bounded-output helpers via toTestResultDetail.
    const detail = ConversationRuntime.toTestResultDetail(execution);
    if (
      execution.status === CommandExecutionStatus.SUCCEEDED ||
      execution.status === CommandExecutionStatus.FAILED
    ) {
      const passed = execution.status === CommandExecutionStatus.SUCCEEDED;
      const reply = passed
        ? this.deps.composer.composePostApplyValidationPassed(message.context, detail)
        : this.deps.composer.composePostApplyValidationFailed(message.context, detail);
      // pass and fail are both the project's result (not a bot error) — recorded as a normal turn.
      return this.respondComposed(message, session, reply);
    }
    if (execution.status === CommandExecutionStatus.TIMED_OUT) {
      const reply = this.deps.composer.composePostApplyValidationTimedOut(message.context, detail);
      return this.failComposed(message, session, reply);
    }
    // Non-terminal / unexpected (defensive) — CommandExecution normally returns a terminal status.
    return this.failComposed(message, session, this.deps.composer.composePostApplyValidationUnavailable(message.context));
  }

  /** Structured, no-content failure log for a post-apply validation error (Sprint 2v) — mirrors the Sprint
   *  2t/2u pattern; never logs stdout/stderr or file content. */
  private logPostApplyValidationFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('post-apply validation failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
      workspaceChangeId: anchor.workspaceChangeRef?.id,
    }); // deliberately NO stdout/stderr / file content
  }

  /**
   * An explicit read-only git-preview command arrived while the anchor is WORKSPACE_APPLIED (Sprint 2w,
   * ADR-0044). Runs ONLY read-only Git methods (`git.status`, and for a diff preview `git.status` then
   * `git.diff`) against the applied workspace (`anchor.workspaceRef.rootPath`). Never shells out, never calls
   * a mutating git operation, WorkspaceWrite, CommandExecution, Patch, CodeGeneration, or the
   * ExecutionOrchestrator; never re-anchors. A git-MUTATION phrase is rejected (read-only reminder). A git
   * read throw → safe failure, with no CommandExecution/shell/re-resolve fallback.
   */
  private async handleGitPreviewTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
    kind: 'status' | 'diff' | 'mutating',
  ): Promise<TurnResult> {
    // 1. (CA Q4/#6) A git MUTATION phrase → read-only "not supported" reply. NORMAL turn (RESPONDED),
    //    no git call, anchor unchanged.
    if (kind === 'mutating') {
      // QA-020: a push/remote request gets remote-specific copy; other local git mutations (add/reset/stash/…)
      // keep the local wording. Both point at the supported local commit phrase "커밋해줘".
      const scope = ConversationRuntime.interpretPushIntent(message.text) !== null ? 'remote' : 'local';
      return this.respondComposed(
        message,
        session,
        this.deps.composer.composeGitMutationNotSupported(message.context, { scope, remoteEnabled: this.gitRemoteEnabled }),
      );
    }

    // 2. Anchor guard: WORKSPACE_APPLIED must carry the workspaceRef we read against (defensive).
    if (!anchor.workspaceRef) {
      return this.failComposed(message, session, this.deps.composer.composeGitPreviewUnavailable(message.context));
    }
    const rootPath = anchor.workspaceRef.rootPath;

    // 3. Read-only validation context (CA Q8/#8) — a missing/failed lookup NEVER fails the git preview.
    const validation = await this.loadValidationContext(anchor);

    // 4. Read-only Git call (CA Constraint 1/2, Q10/#2/#7). A throw → safe failure; NO CommandExecution/
    //    shell fallback, NO workspace re-resolution. A diff preview reads status FIRST (branch/clean +
    //    UNTRACKED paths, which `git diff HEAD` omits); if status throws, git.diff is NOT called (CA #7).
    try {
      if (kind === 'diff') {
        const status = await this.deps.git.status(rootPath);
        const diff = await this.deps.git.diff(rootPath);
        return this.respondComposed(message, session, this.deps.composer.composeGitDiffPreview(message.context, { status, diff, validation }));
      }
      const status = await this.deps.git.status(rootPath);
      return this.respondComposed(message, session, this.deps.composer.composeGitStatusPreview(message.context, { status, validation }));
    } catch {
      this.logGitPreviewFailed(session, anchor, `git ${kind} read failed`);
      return this.failComposed(message, session, this.deps.composer.composeGitPreviewUnavailable(message.context));
    }
  }

  /**
   * Read-only: resolve the last post-apply validation's command + status for git-preview display context
   * (Sprint 2w, CA Q8). Uses the existing read-only `commandExecutions.get`; never runs a command. `null`
   * ref → 'none'; a record that is gone or a THROW → 'unavailable' — a validation-lookup failure must NOT
   * fail the git preview (CA Required Change #8).
   */
  private async loadValidationContext(
    anchor: ApplyPreviewAnchor,
  ): Promise<{ command: string; status: string } | 'unavailable' | 'none'> {
    const ref = anchor.postApplyValidationRef;
    if (!ref) return 'none';
    try {
      const exec = await this.deps.commandExecutions.get(ref.id);
      if (!exec) return 'unavailable';
      return { command: [exec.command, ...exec.args].join(' '), status: exec.status };
    } catch {
      return 'unavailable';
    }
  }

  /** Structured, no-content failure log for a git preview read error (Sprint 2w) — never logs diff/file
   *  content or stderr. */
  private logGitPreviewFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('git preview failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef.id,
    }); // deliberately NO diff text / file content / stderr
  }

  /**
   * An explicit git-commit request at WORKSPACE_APPLIED (Sprint 2x, ADR-0045) — PLAN a commit and halt at a
   * HIGH approval. Runs ONLY read-only `git.status` (never `git.diff`); creates a HIGH `ApprovalRequest`;
   * re-anchors `COMMIT_APPROVAL_PENDING`. Performs NO git mutation, CommandExecution, WorkspaceWrite, Patch,
   * CodeGeneration, or ExecutionOrchestrator call. Actual commit execution is a future Sprint 2y.
   */
  private async handleCommitApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    if (!anchor.workspaceRef || !anchor.executionPlanRef || !anchor.targetFiles.length) {
      return this.failComposed(message, session, this.deps.composer.composeCommitUnavailable(message.context));
    }

    // 1. Commit message: user-provided (validated) else deterministic template. Invalid user msg → ask again.
    const parsed = ConversationRuntime.parseCommitMessage(message.text, anchor.targetFiles);
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
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'COMMIT_APPROVAL_PENDING',
      commitApprovalId: approval.id,
      proposedCommitMessage: commitMessage,
      commitCandidateFiles: candidateFiles,
    });
    const reply = this.deps.composer.composeCommitApprovalRequested(message.context, {
      candidateFiles,
      commitMessage,
      validation,
      ...(newFiles.length ? { newFiles } : {}),
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
  }

  /**
   * Decide the pending commit approval (Sprint 2x, ADR-0045) — mirrors handleApplyApprovalTurn, with strict
   * guards (CA #2/#3). Approve → record only, re-anchor `COMMIT_APPROVED` (NO git commit — Sprint 2y).
   * Deny/cancel → record REJECTED and REVERT to `WORKSPACE_APPLIED` (clear only commit fields), with a
   * commit-specific reply (CA #9/#11). Never runs git.
   */
  private async handleCommitApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // (CA #2) strict pending-context integrity guard — a pending commit approval is valid only with COMPLETE
    //  resume context for Sprint 2y. Any missing field → safe failure, NO decide / git / re-anchor.
    if (
      anchor.status !== 'COMMIT_APPROVAL_PENDING' ||
      !anchor.commitApprovalId ||
      !anchor.proposedCommitMessage ||
      !anchor.commitCandidateFiles?.length ||
      !anchor.workspaceRef ||
      !anchor.workspaceChangeRef ||
      !anchor.executionPlanRef
    ) {
      this.logCommitApprovalFailed(session, anchor, 'pending commit approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeCommitUnavailable(message.context));
    }
    const decision = ConversationRuntime.interpretDecision(message.text);
    if (decision === 'ambiguous') {
      // (CA #13) preserve pending context: re-prompt only; no decide, no new approval, no re-anchor.
      const fresh = await this.deps.approvals.get(anchor.commitApprovalId);
      const reply = fresh
        ? this.composePendingReminder(message.context, fresh)
        : this.deps.composer.composeCommitUnavailable(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }
    // (CA #3) verify the referenced ApprovalRequest before deciding: exists, PENDING, same plan.
    const request = await this.deps.approvals.get(anchor.commitApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.PENDING ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logCommitApprovalFailed(session, anchor, 'commit approval request missing/mismatched');
      return this.failComposed(message, session, this.deps.composer.composeCommitUnavailable(message.context));
    }
    const approved = decision === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(message, session, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(anchor.commitApprovalId, this.decisionOf(anchor.commitApprovalId, actor.id, approved));
    if (!approved) {
      // (CA #9/#11) deny/cancel: the applied workspace state MUST survive → revert to WORKSPACE_APPLIED,
      //  clearing ONLY the commit fields; use a COMMIT-SPECIFIC reply (never generic composeExecutionResult).
      await this.deps.applyPreviewFlow.anchor(session, {
        ...anchor,
        status: 'WORKSPACE_APPLIED',
        commitApprovalId: undefined,
        proposedCommitMessage: undefined,
        commitCandidateFiles: undefined,
      });
      const reply =
        decision === 'deny'
          ? this.deps.composer.composeCommitApprovalDenied(message.context)
          : this.deps.composer.composeCommitApprovalCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: decision === 'deny' ? 'DENIED' : 'CANCELLED', reply, sessionId: session.id };
    }
    // approve — Sprint 2x records only; actual git commit is a future sprint. Preserve full context.
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'COMMIT_APPROVED' });
    const reply = this.deps.composer.composeCommitApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /** A commit request while the anchor is COMMIT_APPROVED (Sprint 2x) — already approved; not committed. */
  private async handleCommitAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitAlreadyApproved(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A commit request with no WORKSPACE_APPLIED/COMMIT_APPROVED anchor (Sprint 2x) — no commit flow. */
  private async handleCommitUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A commit request bundled with push/reset/add/… (Sprint 2x) — commit-approval only; no git ran. */
  private async handleCommitUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitUnsupportedCompanion(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a commit-approval error (Sprint 2x) — never logs diff/content.
   *  Defensive optional access: this is called from the incomplete-pending-context guard, where a required
   *  field (e.g. `executionPlanRef`) may be missing, so logging must never throw (CA impl review). */
  private logCommitApprovalFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('commit approval failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef?.id,
      commitApprovalId: anchor.commitApprovalId,
    }); // deliberately NO diff text / file content
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
  private async handleCommitExecutionTurn(
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
  private async handleCommitAlreadyCommittedTurn(
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
  private async handleCommitPushUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitPushUnsupported(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** An explicit commit-execution phrase with no commit-relevant anchor (Sprint 2y) — a new commit approval
   *  is required first; no commit, no git ran. */
  private async handleCommitExecutionUnavailableTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeCommitExecutionUnavailable(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a commit-EXECUTION error (Sprint 2y) — never logs diff/file
   *  content or stderr. Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  private logCommitExecutionFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
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
  private async handlePushApprovalTurn(
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
      }),
      requestedBy: actor.id,
    });

    // 10. Halt at PUSH_APPROVAL_PENDING, preserving distinct push context + all commit context.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'PUSH_APPROVAL_PENDING',
      pushApprovalId: approval.id,
      pushCommitHash: anchor.commitHash,
      pushRemote: target.remote,
      pushBranch: target.branch,
      pushUpstreamRef: target.upstreamRef,
      pushMode: target.mode,
    });
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
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
  }

  /**
   * Decide the pending push approval (Sprint 2z, ADR-0047) — mirrors handleCommitApprovalDecisionTurn with
   * strict guards (CA #3/#9). Approve → record only, re-anchor `PUSH_APPROVED` PRESERVING all push + commit
   * context (CA #8). Deny/cancel → record REJECTED and REVERT to `GIT_COMMITTED` clearing ONLY push fields.
   * A push/force/deploy phrase is ambiguous → re-prompt (never routed to unsupported-companion while
   * pending). NEVER runs git push.
   */
  private async handlePushApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // (CA #9) strict pending-context integrity guard — any missing field → safe failure, NO decide/git/re-anchor.
    if (
      anchor.status !== 'PUSH_APPROVAL_PENDING' ||
      !anchor.pushApprovalId ||
      !anchor.pushCommitHash ||
      !anchor.pushRemote ||
      !anchor.pushBranch ||
      !anchor.pushUpstreamRef ||
      !anchor.commitHash ||
      !anchor.workspaceRef ||
      !anchor.executionPlanRef
    ) {
      this.logPushApprovalFailed(session, anchor, 'pending push approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composePushApprovalUnavailable(message.context));
    }
    // (Sprint 3a, ADR-0048) A push-EXECUTION phrase ("승인된 push 실행해줘" — note the "승인" substring) or a
    // push+forbidden phrase is a premature push request while approval is still PENDING, NOT a clean approve
    // of THIS approval. Classify it ambiguous so it re-prompts (matching the 2z push-phrase intent above)
    // instead of auto-approving on the "승인" substring; a bare "승인"/"거절"/"취소" still decides normally.
    const decision =
      ConversationRuntime.interpretPushExecutionIntent(message.text) !== null
        ? 'ambiguous'
        : ConversationRuntime.interpretDecision(message.text);
    if (decision === 'ambiguous') {
      // (CA #3) push/force/deploy phrases land here too (not approve/deny/cancel) → re-prompt, preserve
      // context; no decide, no new approval, no re-anchor, no push.
      const fresh = await this.deps.approvals.get(anchor.pushApprovalId);
      const reply = fresh
        ? this.composePendingReminder(message.context, fresh)
        : this.deps.composer.composePushApprovalUnavailable(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }
    // (CA #9) verify the referenced ApprovalRequest before deciding: exists, PENDING, same plan.
    const request = await this.deps.approvals.get(anchor.pushApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.PENDING ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPushApprovalFailed(session, anchor, 'push approval request missing/mismatched');
      return this.failComposed(message, session, this.deps.composer.composePushApprovalUnavailable(message.context));
    }
    const approved = decision === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(message, session, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(anchor.pushApprovalId, this.decisionOf(anchor.pushApprovalId, actor.id, approved));
    if (!approved) {
      // (Constraint 5) deny/cancel: the local commit MUST survive → revert to GIT_COMMITTED, clearing ONLY
      // the push fields; commit context preserved. NO git push.
      await this.deps.applyPreviewFlow.anchor(session, {
        ...anchor,
        status: 'GIT_COMMITTED',
        pushApprovalId: undefined,
        pushCommitHash: undefined,
        pushRemote: undefined,
        pushBranch: undefined,
        pushUpstreamRef: undefined,
        pushMode: undefined,
      });
      const reply =
        decision === 'deny'
          ? this.deps.composer.composePushApprovalDenied(message.context)
          : this.deps.composer.composePushApprovalCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: decision === 'deny' ? 'DENIED' : 'CANCELLED', reply, sessionId: session.id };
    }
    // approve — Sprint 2z records only; actual git push is a future sprint. (CA #8) PRESERVE all push +
    // commit context (push fields NOT cleared). NO git push.
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'PUSH_APPROVED' });
    const reply = this.deps.composer.composePushApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /** A push phrase while already PUSH_APPROVED (Sprint 2z) — already approved; not pushed, no new approval. */
  private async handlePushAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePushAlreadyApproved(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A push request with no commit chain in progress (QA-V2-W8) — fixed reply; no approval, no git. */
  private async handleNoPushTargetTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeNoPushTarget(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** A push bundled with force/PR/deploy/tag/branch/… on GIT_COMMITTED or PUSH_APPROVED (Sprint 2z) — push
   *  approval only; those companions are not supported; no approval, no git. */
  private async handlePushUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
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
  private respondPushTargetRefusal(
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
  private logPushApprovalFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('push approval failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef?.id,
      pushApprovalId: anchor.pushApprovalId,
    }); // deliberately NO diff text / file content / stderr
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
  private async handlePushExecutionTurn(
    message: InboundMessage,
    session: Session,
    _actor: Actor,
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

    // 10. (first REMOTE mutation) push the exact approved target through the Ref-gated capability. A throw →
    //     composePushExecutionFailed (could-not-complete / check remote / NO rollback; never "remote
    //     unchanged"). KEEP PUSH_APPROVED, preserve context, NO GIT_PUSHED (CA #2/#11).
    let result: GitPushResult;
    try {
      result = await this.deps.git.pushApprovedCommit({
        rootPath: anchor.workspaceRef.rootPath,
        remote: anchor.pushRemote,
        branch: anchor.pushBranch,
        commitHash: anchor.pushCommitHash,
        approvalRef: gitApprovalRef,
      });
    } catch (err) {
      // (ADR-0061, Sprint 4b) A GitPushBlockedError is an App-auth PRE-mutation failure (token mint / one-shot
      // GIT_ASKPASS creation / HTTPS github.com remote preflight): the push was never attempted → "not pushed"
      // (composePushExecutionUnavailable). Any OTHER throw stays the conservative could-not-complete / check-remote
      // reply (never claims "not pushed"). Both keep PUSH_APPROVED and never set GIT_PUSHED (CA #2/#11).
      if (err instanceof GitPushBlockedError) {
        this.logPushExecutionFailed(session, anchor, 'git push blocked pre-mutation (App-auth credential/remote preflight)');
        return this.failComposed(message, session, this.deps.composer.composePushExecutionUnavailable(message.context));
      }
      this.logPushExecutionFailed(session, anchor, 'git push failed');
      return this.failComposed(message, session, this.deps.composer.composePushExecutionFailed(message.context));
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
  private async handlePushAlreadyPushedTurn(
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
  private async handlePushPrDeployUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePushPrDeployUnsupported(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a push-EXECUTION error (Sprint 3a) — never logs diff/file
   *  content or stderr. Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  private logPushExecutionFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('push execution failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef?.id,
      pushApprovalId: anchor.pushApprovalId,
    }); // deliberately NO diff text / file content / stderr
  }

  /**
   * A PR-creation phrase while GIT_PUSHED (Sprint 3b, ADR-0049) — records a CRITICAL PR-creation approval.
   * Verify pushed context + safe target, derive deterministic head/base/title/body, create the approval,
   * halt at PR_APPROVAL_PENDING. NO Pull Request is created; NO GitHub API; NO fresh Git read (the pushed
   * anchor is the source of truth — CA #12). NO deploy/merge/branch/release.
   */
  private async handlePrApprovalTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 0. (Sprint 3d-D, CA change 9) PR approval now binds the target repository identity — approving a PR
    //    without a configured target repo is no longer meaningful. If identity is missing/invalid, do NOT
    //    create PR_APPROVAL_PENDING or an ApprovalRequest — respond "not configured". (Token NOT needed here.)
    const identity = this.deps.repositoryHosting?.identity;
    if (!identity) {
      return this.respondComposed(message, session, this.deps.composer.composePrCreationNotConfigured(message.context));
    }
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
    // 4. Deterministic bounded title/body (CA #4/#5). Body carries the committed-file COUNT only (no paths).
    const title = derivePrTitle(anchor.instruction);
    const bodyPreview = buildPrBodyPreview({
      pushedCommitHash: anchor.pushedCommitHash,
      headBranch,
      baseBranch,
      committedFileCount: anchor.committedFiles?.length ?? 0,
    });
    // 5. Create the CRITICAL PR-creation ApprovalRequest — the ONLY effect. NO PR creation, NO GitHub API.
    const approval = await this.deps.approvals.requestForRisk({
      executionPlanRef: anchor.executionPlanRef,
      riskLevel: RiskLevel.CRITICAL,
      reason: buildPrApprovalReason({
        pushedCommitHash: anchor.pushedCommitHash,
        headBranch,
        baseBranch,
        title,
        owner: identity.owner,
        repo: identity.repo,
      }),
      requestedBy: actor.id,
    });
    // 6. Halt at PR_APPROVAL_PENDING, preserving ALL pushed/commit/workspace context + distinct PR context +
    //    the approved repository identity (Sprint 3d-D).
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'PR_APPROVAL_PENDING',
      prApprovalId: approval.id,
      prPushedCommitHash: anchor.pushedCommitHash,
      prHeadBranch: headBranch,
      prBaseBranch: baseBranch,
      prTitle: title,
      prBodyPreview: bodyPreview,
      repositoryIdentity: { provider: identity.provider, owner: identity.owner, repo: identity.repo },
    });
    const reply = this.deps.composer.composePrApprovalRequested(message.context, {
      pushedCommitHash: anchor.pushedCommitHash,
      headBranch,
      baseBranch,
      title,
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
  }

  /**
   * Decide the pending PR-creation approval (Sprint 3b, ADR-0049) — mirrors handlePushApprovalDecisionTurn
   * with strict guards (CA #7/#14). A PR-creation / PR+forbidden / deploy-only phrase is a premature request
   * → ambiguous re-prompt (no decide, no PR). Approve → record only, re-anchor PR_APPROVED PRESERVING all
   * context (CA #16). Deny/cancel → revert to GIT_PUSHED clearing ONLY PR fields (CA #15). NEVER creates a PR.
   */
  private async handlePrApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    // 0. (CA #14) strict pending-context guard — any missing field → safe failure, NO decide/re-anchor.
    if (
      anchor.status !== 'PR_APPROVAL_PENDING' ||
      !anchor.prApprovalId ||
      !anchor.prPushedCommitHash ||
      !anchor.prHeadBranch ||
      !anchor.prBaseBranch ||
      !anchor.prTitle ||
      !anchor.workspaceRef ||
      !anchor.executionPlanRef
    ) {
      this.logPrApprovalFailed(session, anchor, 'pending PR approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composePrApprovalUnavailable(message.context));
    }
    // 1. (CA #7) a PR-creation / PR+forbidden phrase — or any deploy-only phrase — is a premature request
    //    while PENDING, NOT a clean approve → classify ambiguous → re-prompt; NO decide, NO PR.
    const decision =
      ConversationRuntime.interpretPrIntent(message.text) !== null || DEPLOY_ONLY_WORDS.test(message.text)
        ? 'ambiguous'
        : ConversationRuntime.interpretDecision(message.text);
    if (decision === 'ambiguous') {
      const fresh = await this.deps.approvals.get(anchor.prApprovalId);
      const reply = fresh
        ? this.composePendingReminder(message.context, fresh)
        : this.deps.composer.composePrApprovalUnavailable(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }
    // 2. (CA #14) verify the referenced ApprovalRequest before deciding: exists, PENDING, same plan.
    const request = await this.deps.approvals.get(anchor.prApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.PENDING ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPrApprovalFailed(session, anchor, 'PR approval request missing/mismatched');
      return this.failComposed(message, session, this.deps.composer.composePrApprovalUnavailable(message.context));
    }
    const approved = decision === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(message, session, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(anchor.prApprovalId, this.decisionOf(anchor.prApprovalId, actor.id, approved));
    if (!approved) {
      // (CA #15) deny/cancel: revert to GIT_PUSHED, clear ONLY the PR fields; pushed/commit/workspace preserved.
      await this.deps.applyPreviewFlow.anchor(session, {
        ...anchor,
        status: 'GIT_PUSHED',
        prApprovalId: undefined,
        prPushedCommitHash: undefined,
        prHeadBranch: undefined,
        prBaseBranch: undefined,
        prTitle: undefined,
        prBodyPreview: undefined,
        repositoryIdentity: undefined,
      });
      const reply =
        decision === 'deny'
          ? this.deps.composer.composePrApprovalDenied(message.context)
          : this.deps.composer.composePrApprovalCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: decision === 'deny' ? 'DENIED' : 'CANCELLED', reply, sessionId: session.id };
    }
    // approve — record only; re-anchor PR_APPROVED PRESERVING all context (CA #16). NO PR creation.
    await this.deps.applyPreviewFlow.anchor(session, { ...anchor, status: 'PR_APPROVED' });
    const reply = this.deps.composer.composePrApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /**
   * Actual PR creation execution (Sprint 3d-D, ADR-0054) — from a live PR_APPROVED anchor + an explicit PR
   * create/open phrase. Verifies the live approval + PR/pushed/identity context (STRUCTURED fields only, never
   * parsing ApprovalRequest.reason), then calls `RepositoryHostingManager.createPullRequest` — the manager (not
   * the runtime) owns provider.kind/repo/branch/find/reuse/create/result-integrity. Runtime NEVER calls the
   * provider directly and receives NO token. Success → re-anchor PR_CREATED; failures keep PR_APPROVED (a
   * blocked-pre-mutation failure says "PR not created"; a post-attempt UNVERIFIED failure must not).
   */
  private async handlePrCreationExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    void actor;
    const identity = this.deps.repositoryHosting?.identity;
    const manager = this.deps.repositoryHosting?.manager;
    // Not configured: no resolved identity OR no manager (missing GitHub token) — safe not-configured, no call.
    if (!identity || !manager) {
      return this.respondComposed(message, session, this.deps.composer.composePrCreationNotConfigured(message.context));
    }
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
    // Deterministic bounded body (count only — CA change 11). The manager owns hosting checks + integrity.
    const body = buildPrBody({
      title: anchor.prTitle,
      pushedCommitHash: anchor.prPushedCommitHash,
      headBranch: anchor.prHeadBranch,
      baseBranch: anchor.prBaseBranch,
      committedFileCount: anchor.committedFiles?.length ?? 0,
    });
    let result: PullRequestResult;
    try {
      result = await manager.createPullRequest({
        identity,
        headBranch: anchor.prHeadBranch,
        baseBranch: anchor.prBaseBranch,
        title: anchor.prTitle,
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
  private async handlePrAlreadyCreatedTurn(
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
  private async handlePrCreatedCompanionUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
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
  private async handlePrStatusPreviewTurn(
    message: InboundMessage,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const identity = this.deps.repositoryHosting?.identity;
    const manager = this.deps.repositoryHosting?.manager;
    if (!identity || !manager) {
      return this.respondComposed(message, session, this.deps.composer.composePrStatusNotConfigured(message.context));
    }
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
  private async handlePrUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePrUnsupportedCompanion(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /**
   * Explicit merge approval / merge phrase while PR_CREATED (Sprint 3f, ADR-0056) — records a CRITICAL merge
   * approval and halts at MERGE_APPROVAL_PENDING. Mirrors handlePrApprovalTurn. **NO merge, NO GitHub write.**
   * Requires complete PR_CREATED context (identity + pullRequestRef + head/base/commit + executionPlanRef).
   */
  private async handleMergeApprovalTurn(
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
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'MERGE_APPROVAL_PENDING',
      mergeApprovalId: approval.id,
      mergeApprovalRequestedAt: now(),
    });
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
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
  }

  /**
   * Decide the pending merge approval (Sprint 3f) — mirrors handlePrApprovalDecisionTurn. A merge/deploy/status
   * phrase while pending is a premature request → ambiguous re-prompt (NO decide, NO merge). Approve →
   * MERGE_APPROVED (record only, + mergeApprovedAt/mergeApprovalDecisionBy). Deny/cancel → PR_CREATED clearing
   * ONLY merge fields (PR/push/commit/workspace preserved). Structured fields only — never parse reason.
   */
  private async handleMergeApprovalDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    if (anchor.status !== 'MERGE_APPROVAL_PENDING' || !anchor.mergeApprovalId || !anchor.executionPlanRef) {
      this.logPrApprovalFailed(session, anchor, 'pending merge approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeMergeApprovalUnavailable(message.context));
    }
    // A merge / status phrase, or any deploy-only phrase, while PENDING → ambiguous re-prompt (no decide).
    const decision =
      ConversationRuntime.interpretMergeIntent(message.text) !== null ||
      ConversationRuntime.interpretPrStatusIntent(message.text) ||
      DEPLOY_ONLY_WORDS.test(message.text)
        ? 'ambiguous'
        : ConversationRuntime.interpretDecision(message.text);
    if (decision === 'ambiguous') {
      const fresh = await this.deps.approvals.get(anchor.mergeApprovalId);
      const reply = fresh
        ? this.composePendingReminder(message.context, fresh)
        : this.deps.composer.composeMergeApprovalUnavailable(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }
    // Verify the referenced ApprovalRequest via STRUCTURED fields only — never parse reason.
    const request = await this.deps.approvals.get(anchor.mergeApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.PENDING ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPrApprovalFailed(session, anchor, 'merge approval request missing/mismatched');
      return this.failComposed(message, session, this.deps.composer.composeMergeApprovalUnavailable(message.context));
    }
    const approved = decision === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(message, session, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(anchor.mergeApprovalId, this.decisionOf(anchor.mergeApprovalId, actor.id, approved));
    if (!approved) {
      // Deny/cancel → back to PR_CREATED, clear ONLY merge fields; PR/push/commit/workspace preserved.
      await this.deps.applyPreviewFlow.anchor(session, {
        ...anchor,
        status: 'PR_CREATED',
        mergeApprovalId: undefined,
        mergeApprovalRequestedAt: undefined,
        mergeApprovedAt: undefined,
        mergeApprovalDecisionBy: undefined,
      });
      const reply =
        decision === 'deny'
          ? this.deps.composer.composeMergeApprovalDenied(message.context)
          : this.deps.composer.composeMergeApprovalCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: decision === 'deny' ? 'DENIED' : 'CANCELLED', reply, sessionId: session.id };
    }
    // approve — record only; re-anchor MERGE_APPROVED preserving all context. NO merge.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'MERGE_APPROVED',
      mergeApprovedAt: now(),
      mergeApprovalDecisionBy: actor.id,
    });
    const reply = this.deps.composer.composeMergeApprovalRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /** A merge phrase while already MERGE_APPROVED (Sprint 3f) — already approved; actual merge is a future step. No mutation. */
  private async handleMergeAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composeMergeAlreadyApproved(message.context);
    return this.respondComposed(message, session, reply);
  }

  /** A deploy/release/reviewer/label/assignee phrase while MERGE_APPROVED (Sprint 3f) — unsupported future step; no mutation. */
  private async handleMergeApprovedCompanionUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
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
  private async handleMergeExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const identity = this.deps.repositoryHosting?.identity;
    const manager = this.deps.repositoryHosting?.manager;
    // Not configured: no resolved identity OR no manager (missing GitHub token) — safe not-configured, no call.
    if (!identity || !manager) {
      return this.respondComposed(message, session, this.deps.composer.composeMergeExecutionUnavailable(message.context));
    }
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
  private async handleMergeAlreadyMergedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
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
  private async handleMergeExecutionUnsupportedCompanionTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
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
  private async handleMainSyncTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const identity = this.deps.repositoryHosting?.identity;
    // Not configured: no resolved identity → cannot verify we are syncing the right repository. Safe not-configured.
    if (!identity) {
      return this.respondComposed(message, session, this.deps.composer.composeMainSyncUnavailable(message.context));
    }
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
      });
    } catch (err) {
      // Phase-aware: only a KNOWN pre-ref-update BlockedError may say "not synced"; an UnverifiedError AND any
      // unknown throw are UNVERIFIED (the local ref may have moved). Keep PR_MERGED on every failure path.
      if (err instanceof GitMainSyncBlockedError) {
        this.logPrApprovalFailed(session, anchor, 'main sync blocked before ref update');
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
  private async handleMainAlreadySyncedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
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
  private async handleBranchCleanupTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const identity = this.deps.repositoryHosting?.identity;
    if (!identity) {
      return this.respondComposed(message, session, this.deps.composer.composeBranchCleanupUnavailable(message.context));
    }
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
      return this.failComposed(message, session, this.deps.composer.composeBranchCleanupBlocked(message.context));
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
        return this.failComposed(message, session, this.deps.composer.composeBranchCleanupBlocked(message.context));
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
  private async handleBranchAlreadyCleanedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
    const reply = this.deps.composer.composeBranchCleanupSucceeded(message.context, {
      cleanedBranch: anchor.cleanedBranch ?? anchor.pullRequestHeadBranch ?? '',
      cleanedLocalBranch: false,
      alreadyAbsent: true,
    });
    return this.respondComposed(message, session, reply);
  }

  /** A REMOTE branch cleanup phrase BEFORE the local branch is cleaned (at MAIN_SYNCED) — remote cleanup is available
   *  only from BRANCH_CLEANED (clean the local branch first). NO mutation (Sprint 3i → reworded Sprint 3j-A). */
  private async handleRemoteBranchCleanupUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
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
  private async handleRemoteBranchCleanupApprovalTurn(
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
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'REMOTE_BRANCH_CLEANUP_PENDING',
      remoteBranchCleanupApprovalId: approval.id,
      remoteBranchCleanupApprovalRequestedAt: now(),
    });
    const reply = this.deps.composer.composeRemoteBranchCleanupRequested(message.context, {
      owner: anchor.repositoryIdentity.owner,
      repo: anchor.repositoryIdentity.repo,
      prNumber: anchor.pullRequestNumber,
      prUrl: anchor.pullRequestUrl,
      branch: target,
      expectedHeadCommit,
    });
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
  }

  /**
   * Decide the pending remote-branch-cleanup approval (Sprint 3j-A) — mirrors handleMergeApprovalDecisionTurn. A
   * remote-cleanup / execute / status / deploy phrase while pending is a premature command → ambiguous re-prompt (NO
   * decide, NO delete, NO auto-approve). Approve → REMOTE_BRANCH_CLEANUP_APPROVED (record only). Deny/cancel →
   * BRANCH_CLEANED clearing ONLY the four remote-cleanup approval fields (the full chain is preserved). Structured
   * fields only — never parse reason. **NO remote deletion on any path.**
   */
  private async handleRemoteBranchCleanupDecisionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    if (anchor.status !== 'REMOTE_BRANCH_CLEANUP_PENDING' || !anchor.remoteBranchCleanupApprovalId || !anchor.executionPlanRef) {
      this.logPrApprovalFailed(session, anchor, 'pending remote branch cleanup approval context incomplete');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(message.context));
    }
    // A remote-cleanup / execute / status phrase, or any deploy-only phrase, while PENDING → ambiguous re-prompt.
    const decision =
      ConversationRuntime.interpretRemoteBranchCleanupIntent(message.text) !== null ||
      ConversationRuntime.interpretRemoteBranchCleanupExecutionIntent(message.text) !== null ||
      ConversationRuntime.interpretPrStatusIntent(message.text) ||
      DEPLOY_ONLY_WORDS.test(message.text)
        ? 'ambiguous'
        : ConversationRuntime.interpretDecision(message.text);
    if (decision === 'ambiguous') {
      const fresh = await this.deps.approvals.get(anchor.remoteBranchCleanupApprovalId);
      const reply = fresh
        ? this.composePendingReminder(message.context, fresh)
        : this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id };
    }
    // Verify the referenced ApprovalRequest via STRUCTURED fields only — never parse reason.
    const request = await this.deps.approvals.get(anchor.remoteBranchCleanupApprovalId);
    if (
      !request ||
      request.status !== ApprovalStatus.PENDING ||
      request.executionPlanRef.id !== anchor.executionPlanRef.id
    ) {
      this.logPrApprovalFailed(session, anchor, 'remote branch cleanup approval request missing/mismatched');
      return this.failComposed(message, session, this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(message.context));
    }
    const approved = decision === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(message, session, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(
      anchor.remoteBranchCleanupApprovalId,
      this.decisionOf(anchor.remoteBranchCleanupApprovalId, actor.id, approved),
    );
    if (!approved) {
      // Deny/cancel → back to BRANCH_CLEANED, clearing ONLY the four remote-cleanup approval fields (CA change 7).
      await this.deps.applyPreviewFlow.anchor(session, {
        ...anchor,
        status: 'BRANCH_CLEANED',
        remoteBranchCleanupApprovalId: undefined,
        remoteBranchCleanupApprovalRequestedAt: undefined,
        remoteBranchCleanupApprovedAt: undefined,
        remoteBranchCleanupApprovalDecisionBy: undefined,
      });
      const reply =
        decision === 'deny'
          ? this.deps.composer.composeRemoteBranchCleanupDenied(message.context)
          : this.deps.composer.composeRemoteBranchCleanupCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: decision === 'deny' ? 'DENIED' : 'CANCELLED', reply, sessionId: session.id };
    }
    // approve — record only; re-anchor REMOTE_BRANCH_CLEANUP_APPROVED preserving all context. NO remote deletion.
    await this.deps.applyPreviewFlow.anchor(session, {
      ...anchor,
      status: 'REMOTE_BRANCH_CLEANUP_APPROVED',
      remoteBranchCleanupApprovedAt: now(),
      remoteBranchCleanupApprovalDecisionBy: actor.id,
    });
    const reply = this.deps.composer.composeRemoteBranchCleanupRecorded(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /** A remote cleanup phrase while already REMOTE_BRANCH_CLEANUP_APPROVED (Sprint 3j-A) — already approved; the
   *  actual remote deletion is a future step (3j-B). No mutation. */
  private async handleRemoteBranchCleanupAlreadyApprovedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
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
  private async handleRemoteBranchCleanupExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor,
  ): Promise<TurnResult> {
    const identity = this.deps.repositoryHosting?.identity;
    const manager = this.deps.repositoryHosting?.manager;
    // Check 1 — not configured (no identity / no manager / no token): safe not-configured, no call, anchor unchanged.
    if (!identity || !manager) {
      return this.respondComposed(message, session, this.deps.composer.composeRemoteBranchCleanupExecutionUnavailable(message.context));
    }
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
  private async handleRemoteBranchAlreadyCleanedTurn(message: InboundMessage, session: Session, anchor: ApplyPreviewAnchor): Promise<TurnResult> {
    const reply = this.deps.composer.composeRemoteBranchAlreadyCleaned(message.context, {
      branch: anchor.cleanedRemoteBranchName ?? anchor.pullRequestHeadBranch ?? '',
    });
    return this.respondComposed(message, session, reply);
  }

  /** A deploy-only phrase while PR_APPROVED (Sprint 3b, CA #8) — state-specific: PR approval recorded, PR not
   *  created, deployment not done. */
  private async handlePrApprovedDeployUnsupportedTurn(message: InboundMessage, session: Session): Promise<TurnResult> {
    const reply = this.deps.composer.composePrApprovedDeployUnsupported(message.context);
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return this.responded(session, reply);
  }

  /** Structured, no-content failure log for a PR-approval error (Sprint 3b) — never logs diff/file content.
   *  Optional field access so it never throws on incomplete context (Sprint 2x lesson). */
  private logPrApprovalFailed(session: Session, anchor: ApplyPreviewAnchor, reason: string): void {
    this.deps.logger.warn('pr approval failed', {
      reason,
      sessionId: session.id,
      executionPlanId: anchor.executionPlanRef?.id,
      prApprovalId: anchor.prApprovalId,
    }); // deliberately NO diff text / file content
  }

  /** (C) Resolve the workspace (if the capability needs it), run the execution, and frame the reply. */
  private async handleExecutionIntent(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
  ): Promise<TurnResult> {
    const ws = await this.resolveExecutionWorkspace(message, session, intent.capability);
    if ('status' in ws) return ws;
    const workspaceRef = ws.workspaceRef;

    // ADR-0036: a code-change request needs a validated target before it may reach Planning/Approval.
    let targetFiles: string[] | undefined;
    // F3-A (Sprint 4c-Follow-up-3): the positive origin signal for the new-file add-diff preview guard.
    // Set ONLY when A2's explicit new-file flow fires below — never for an ordinary existing-file target.
    let newFileTargets: string[] | undefined;
    // F4-A (Sprint 4c-Follow-up-4): the FULL inbound request is the authoritative code-generation
    // instruction (never the ≤200-char display summary). Set ONLY for CODE_IMPLEMENTATION so no other
    // capability's behavior changes. Per the CA input-fidelity amendment, every accepted inbound request
    // is preserved COMPLETELY — no application-level length cap, no silent truncation. The instruction is
    // bounded only by what the inbound transport (Discord) accepts; a small app cap is explicitly NOT
    // imposed here (long-preview delivery is handled losslessly downstream — Sprint 4c-Follow-up-5).
    let authoritativeInstruction: string | undefined;
    if (intent.capability === Capability.CODE_IMPLEMENTATION) {
      authoritativeInstruction = message.text;
      // ADR-0099 D1: EVERY safe named path is a target (≤ MAX_CHANGE_SET_FILES), never only the first hit.
      // An existing path is an update target; a missing one is a new-file target only with the negation-aware
      // ADR-0062 create wording (A2, now for each missing path — F3-A marks it as an explicit new-file origin
      // so runCodeGenerationPreview may accept its `add` diff, still re-checked absent at diff time); otherwise
      // the reply names the missing paths and asks again. This changes ROUTING only: preview stays
      // non-mutating and the apply/commit/push/PR approval gates are untouched. A typed absolute / home /
      // traversal / dot-leading path is never a target (never rewritten into an in-project path) but does not
      // refuse a request that also names a safe target — an API route or import specifier in the prose is
      // instruction content. Fenced code is pasted content, never a target.
      const { candidates, unsafe } = extractSafeTargetCandidates(message.text);
      const collected = await this.collectCodeChangeTargets(
        workspaceRef!, candidates, ConversationRuntime.isExplicitNewFileRequest(message.text),
      );
      if (collected.kind === 'targets') {
        targetFiles = collected.targets;
        if (collected.newFileTargets.length) newFileTargets = collected.newFileTargets;
      } else if (collected.kind === 'too-many') {
        return this.respondComposed(
          message, session, this.deps.composer.composeTooManyTargets(message.context, collected.count, collected.max),
        );
      }
      if (!targetFiles) {
        // ADR-0099 D1: a "some named paths are missing" reply asks for the WHOLE request again (with create
        // wording for a new file), so it is NOT anchored — the resend must route as a fresh request, where the
        // create wording is honored and its own text becomes the instruction. Anchoring it would send the resend
        // to the existing-files-only recovery with the stale instruction and dead-end on the same reply.
        if (ConversationRuntime.asksForWholeRequestAgain(collected)) {
          return this.respondComposed(message, session, this.composeTargetScopeReply(message, collected, unsafe));
        }
        // ADR-0037: anchor so the user's very next reply (even a bare path) can recover this
        // request. Reached only for a fresh CODE_IMPLEMENTATION request with an active project and
        // an opened workspace (both already required to reach this line) and no validated target.
        await this.deps.credentialOverrideFlow?.clear(session); // ADR-0097 D5: never orphan a live set
        await this.deps.scopeClarificationFlow.anchor(session, {
          kind: 'code-scope-clarification',
          summary: intent.summary,
          // F4-B/RC4: preserve the ORIGINAL full request so a next-turn bare-path reply recovers the
          // complete instruction, never the path-only text or the ≤200-char summary.
          ...(authoritativeInstruction ? { authoritativeInstruction } : {}),
          ...(typeof intent.raw?.kind === 'string' ? { rawKind: intent.raw.kind } : {}),
          ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
          createdAt: now(),
        });
        return this.respondComposed(message, session, this.composeTargetScopeReply(message, collected, unsafe));
      }
    }

    return this.runResolvedExecution(
      message, session, actor, intent, workspaceRef, targetFiles, newFileTargets, authoritativeInstruction,
    );
  }

  /** Explicit create-file markers (Sprint 4c-Follow-up-2, A2) — KO + EN. Conservative: only unambiguous
   *  file-creation wording, so an ordinary code-change request never trips it. */
  private static readonly NEW_FILE_MARKER =
    /(파일\s*생성|파일\s*추가|새\s*파일(?:\s*(?:생성|추가))?|create\s+(?:a\s+)?(?:new\s+)?file|new\s+file|add\s+(?:a\s+)?(?:new\s+)?file)/i;

  /** File noun for the co-located create-file phrasing (Sprint 4c-Follow-up-6). */
  private static readonly NEW_FILE_NOUN = /(파일|file)/i;

  /** IMPERATIVE/request create verb (Sprint 4c-Follow-up-6): natural KO "만들어줘 / 만들어 줘 / 만들자 / 생성해(줘)"
   *  and "make/create". Deliberately request-shaped so a PAST/descriptive "만들어졌는지" ("how it was made") or a
   *  negated "만들지 마" is NOT matched as a create request. */
  private static readonly NEW_FILE_CREATE_VERB =
    /(만들어\s*줘|만들어\s*주(?:세요|실래요|시겠어요)?|만들어\s*줄래|만들어라|만들자|생성\s*해(?:\s*줘|\s*주세요)?|\bcreate\b|\bmake\b)/i;

  /**
   * The pre-ADR-0099 single new-file rule (Sprint 4c-Follow-up-2, A2; extended 4c-Follow-up-6): the normalized
   * path for a create-file request with exactly ONE candidate, else null. NOT used for routing any more — a
   * code-change request now collects every named path (≤ MAX_CHANGE_SET_FILES) through
   * `collectCodeChangeTargets` with {@link isExplicitNewFileRequest} as the create gate. Kept only as the public,
   * pure seam the create-wording tests exercise (`isExplicitNewFileRequest` itself is private). No I/O.
   */
  static explicitNewFileTarget(text: string, candidates: readonly string[]): string | null {
    if (!ConversationRuntime.isExplicitNewFileRequest(text)) return null;
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
  private static isExplicitNewFileRequest(text: string): boolean {
    return (
      unnegatedMatch(text, [ConversationRuntime.NEW_FILE_MARKER]) ||
      hasCoLocatedUnnegated(text, ConversationRuntime.NEW_FILE_NOUN, ConversationRuntime.NEW_FILE_CREATE_VERB)
    );
  }

  /**
   * Whether a reply to a pending scope clarification is really a full resend of a code-change request with explicit
   * (non-negated) create wording and at least one safe named path (ADR-0099 D1 QA follow-up). Such a resend is
   * routed as a fresh request instead of the existing-files-only bare-path recovery.
   */
  private static isFreshCreateResend(text: string): boolean {
    return ConversationRuntime.isExplicitNewFileRequest(text) && extractSafeTargetCandidates(text).candidates.length > 0;
  }

  /** Resolve the active project's workspace for a needsWorkspace capability, or an early-return reply. */
  private async resolveExecutionWorkspace(
    message: InboundMessage,
    session: Session,
    capability: Capability,
  ): Promise<{ workspaceRef?: WorkspaceRef } | TurnResult> {
    if (!ConversationRuntime.needsWorkspace(capability)) return {};
    if (!session.activeProjectId) {
      return this.respondComposed(message, session, this.deps.composer.composeNeedsProject(message.context));
    }
    const project = await this.deps.projects.get(session.activeProjectId);
    if (!project) {
      return this.respondComposed(message, session, this.deps.composer.composeNeedsProject(message.context));
    }
    try {
      const workspaceRef = await this.deps.workspace.open({ id: project.id, rootPath: project.rootPath });
      return { workspaceRef };
    } catch {
      return this.failComposed(message, session, this.deps.composer.composeWorkspaceUnavailable(message.context));
    }
  }

  /**
   * Resolve → run → frame the halt/complete/fail reply. Shared tail for a ready ExecutionRequest.
   *
   * MUTATION-CERTAINTY BOUNDARY (Sprint 4c-Follow-up-7; narrowed per CA re-review). This is a SHARED
   * execution tail — it runs `orchestrator.run` for EVERY execution capability, including `TEST_EXECUTION`
   * and command flows that CAN produce side effects (generated files, snapshots, caches, artifacts,
   * side-effecting scripts) before an error escapes. So the method as a whole is NOT read-only, and the
   * mutation-safety invariant covers ALL mutations, not only `WorkspaceWrite.apply`. On a thrown error the
   * sanitized FAILED reply's mutation-certainty is therefore chosen by capability:
   *   - `CODE_IMPLEMENTATION` — the approval-gated preview flow. The orchestrator computes a read-only diff
   *     and stops at AWAITING_APPROVAL BEFORE any apply; the actual WorkspaceWrite apply / git ops live
   *     exclusively in the separate approval-decision turns (`handleApplyApprovalTurn` et al.). No
   *     mutation-capable port is reachable on this first-turn/recovered preview path, so a failure is
   *     provably pre-mutation → `CONFIRMED_NOT_APPLIED`.
   *   - EVERY OTHER capability (`TEST_EXECUTION`, command execution, any other shared execution capability)
   *     — a side effect may already have happened, so the verdict stays conservative → `MAY_HAVE_APPLIED`.
   * Never rethrows (so this specific verdict wins over the generic backstop) and never leaks raw/stack. The
   * generic `handle()` and `QuokyCore` backstops stay conservative (`MAY_HAVE_APPLIED`) for everything else.
   */
  private async runResolvedExecution(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    workspaceRef: WorkspaceRef | undefined,
    targetFiles: string[] | undefined,
    newFileTargets?: string[],
    authoritativeInstruction?: string,
  ): Promise<TurnResult> {
    try {
      return await this.runResolvedExecutionInner(
        message,
        session,
        actor,
        intent,
        workspaceRef,
        targetFiles,
        newFileTargets,
        authoritativeInstruction,
      );
    } catch (err) {
      const safe = toSafeError(err);
      this.deps.logger.error('execution turn failed', {
        errorName: err instanceof Error ? err.name : typeof err,
        code: safe.code,
        capability: intent.capability,
        messageId: message.id,
        // internal-only sink — never sent to the user
        stack: err instanceof Error ? err.stack : undefined,
      });
      // CONFIRMED_NOT_APPLIED ONLY for the approval-gated CODE_IMPLEMENTATION preview flow (provably
      // pre-mutation on this shared tail). TEST_EXECUTION / command execution / any other shared capability
      // may already have triggered a side effect, so they MUST stay conservative (CA re-review).
      const mutationSafety: MutationSafety =
        intent.capability === Capability.CODE_IMPLEMENTATION ? 'CONFIRMED_NOT_APPLIED' : 'MAY_HAVE_APPLIED';
      const reply = this.deps.composer.composeSanitizedError(message.context, safe, {
        requestId: safeRequestId(message.id),
        mutationSafety,
      });
      return { status: 'FAILED', reply, sessionId: session.id };
    }
  }

  private async runResolvedExecutionInner(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    workspaceRef: WorkspaceRef | undefined,
    targetFiles: string[] | undefined,
    newFileTargets?: string[],
    authoritativeInstruction?: string,
  ): Promise<TurnResult> {
    const request = this.deps.intentResolver.resolve(intent, {
      requestedBy: actor.id,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
      ...(workspaceRef ? { workspaceRef } : {}),
      ...(targetFiles ? { targetFiles } : {}),
      ...(newFileTargets ? { newFileTargets } : {}),
      // F4-A (Sprint 4c-Follow-up-4): the full authoritative instruction → ExecutionRequest.instruction;
      // goal stays the bounded display summary.
      ...(authoritativeInstruction ? { authoritativeInstruction } : {}),
    });
    if (!request) {
      // Defensive: isExecution() gated this path, so resolve should not return null.
      return this.failComposed(message, session, this.deps.composer.composeCommandUnavailable(message.context));
    }

    // F4-C (Sprint 4c-Follow-up-4): safe, length-only observability for instruction fidelity — proves the
    // display summary is bounded while the authoritative instruction carries the full request. NEVER logs
    // raw instruction/request/file content (LogFields is primitive-only; only lengths/booleans passed).
    if (intent.capability === Capability.CODE_IMPLEMENTATION) {
      this.deps.logger.info('code-change instruction fidelity', {
        stage: 'intent-resolution',
        capability: 'CODE_IMPLEMENTATION',
        displaySummaryLength: intent.summary.length,
        authoritativeInstructionLength: request.instruction.length,
        instructionTruncatedForDisplay: request.instruction.length > intent.summary.length,
      });
    }

    const outcome = await this.deps.orchestrator.run(request);
    if (outcome.status === ('AWAITING_APPROVAL' as ExecutionOutcomeStatus)) {
      // ADR-0097 D5 (OVR-3 contract): a newer request never orphans a live override set (`superseded`).
      await this.deps.credentialOverrideFlow?.clear(session);
      await this.deps.approvalFlow.anchor(session, request, outcome); // enable next-turn resume
      // ADR-0035: a code-change halt gets a more specific prompt than the generic approval text —
      // it names this as a code-change request and states that no file is modified yet.
      if (intent.capability === Capability.CODE_IMPLEMENTATION) {
        // New-file targets have no current content to send; only existing target files are disclosed.
        const sentFiles = (request.targetFiles ?? []).filter((f) => !(request.newFileTargets ?? []).includes(f));
        const reply = this.deps.composer.composeCodeChangeApprovalRequired(
          message.context, sentFiles, request.newFileTargets ?? [],
        );
        await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
        return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id, executionOutcome: outcome };
      }
      return this.replyForOutcome(message.context, session, outcome);
    }
    if (intent.capability === Capability.TEST_EXECUTION) {
      return this.frameTestResult(message, session, outcome);
    }
    return this.replyForOutcome(message.context, session, outcome);
  }

  /**
   * (A2) Recover a code-change request from a pending scope clarification (ADR-0037). Consumes the
   * anchor unconditionally (next-turn-only) before evaluating the reply. The recovered request's
   * goal/instruction always comes from `pending.summary` — the ORIGINAL first message — never from
   * this follow-up message's text.
   */
  private async handleScopeClarificationTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    pending: PendingScopeClarification,
  ): Promise<TurnResult> {
    await this.deps.scopeClarificationFlow.clear(session); // next-turn-only: consumed either way

    if (CANCEL_WORDS.some((w) => message.text.trim() === w || message.text.includes(w))) {
      const reply = this.deps.composer.composeScopeClarificationCancelled(message.context);
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'CANCELLED', reply, sessionId: session.id };
    }
    // QA-V2-004: a bare decision word ("승인", "거절", "ok") right after a rejected target is not a file path and
    // there is no approval to decide — the deterministic QA-018 "nothing to approve" reply, never the "which file?"
    // clarification copy. The clarification was consumed above.
    if (interpretStrayDecisionUtterance(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeNoPendingDecision(message.context));
    }

    const ws = await this.resolveExecutionWorkspace(message, session, Capability.CODE_IMPLEMENTATION);
    if ('status' in ws) return ws; // no active project / workspace unavailable — same replies as fresh

    const recovered: Intent = {
      type: IntentType.IMPLEMENT_CODE,
      capability: Capability.CODE_IMPLEMENTATION,
      confidence: 1,
      requiresWork: true,
      summary: pending.summary,
      ...(pending.rawKind ? { raw: { kind: pending.rawKind } } : {}),
    };

    // ADR-0099 D1: the same collector as a fresh request. Recovery only ever routes EXISTING files (never a
    // new-file origin), so a missing path here is named and asked again; an unsafe typed path is never a target
    // and is refused when no safe target is left.
    const { candidates, unsafe } = extractSafeTargetCandidates(message.text);
    const collected = await this.collectCodeChangeTargets(ws.workspaceRef!, candidates, false);
    if (collected.kind === 'targets') {
      // F4-B/RC4: recover with the ORIGINAL full instruction from the anchor — never `message.text`
      // (the bare-path follow-up) and never the ≤200-char summary.
      return this.runResolvedExecution(
        message, session, actor, recovered, ws.workspaceRef, collected.targets, undefined, pending.authoritativeInstruction,
      );
    }
    if (collected.kind === 'too-many') {
      return this.respondComposed(
        message, session, this.deps.composer.composeTooManyTargets(message.context, collected.count, collected.max),
      );
    }

    const reply = this.composeTargetScopeReply(message, collected, unsafe);
    return this.respondComposed(message, session, reply); // no re-anchor (next-turn-only)
  }

  /**
   * ADR-0099 D1 target collection over the read-only workspace listing. Never assume list()'s glob is
   * exact-match — a hit counts only when it normalizes to the candidate, and THAT hit (never the raw
   * candidate) becomes the target. At most MAX_CHANGE_SET_FILES lookups; more candidates are refused unlooked.
   */
  private collectCodeChangeTargets(
    workspaceRef: WorkspaceRef,
    candidates: readonly string[],
    allowNewFiles: boolean,
  ): Promise<CodeChangeTargetCollection> {
    return collectCodeChangeTargets({
      candidates,
      allowNewFiles,
      resolveExisting: async (candidate) => {
        const hits = await this.deps.workspace.list(workspaceRef, candidate);
        return hits.find((hit) => normalizeRelativePath(hit) === normalizeRelativePath(candidate)) ?? null;
      },
    });
  }

  /**
   * Whether the target-scope reply is {@link ResponseComposer.composeTargetsMissing} — some named paths resolved
   * but others are missing, or several are missing (ADR-0099 D1). That reply asks the owner to resend the WHOLE
   * request (adding create wording for a new file), so it is never anchored as a scope clarification: a bare-path
   * recovery could neither honor the create wording nor take the corrected instruction. A single missing path,
   * an unsafe path, or no path at all keeps the ADR-0037 bare-path clarification.
   */
  private static asksForWholeRequestAgain(
    collected: CodeChangeTargetCollection,
  ): collected is Extract<CodeChangeTargetCollection, { kind: 'missing' }> {
    return collected.kind === 'missing' && (collected.resolved.length > 0 || collected.missing.length > 1);
  }

  /**
   * The "which file?" reply for a code-change request with no usable target set (ADR-0036/0037; QA-016;
   * ADR-0099 D1). Some named paths resolved but others are missing, or several are missing → name every
   * missing path and ask again (never a silent drop). Otherwise, when the user DID type a path that could not
   * be used (missing, outside the project, absolute, traversal), say so and echo the path as typed — never
   * whether an out-of-root file exists; with no safe path left, a typed unsafe path (`unsafe`, already dropped
   * as a target) is the one echoed. With no path typed at all, keep the original clarification copy.
   */
  private composeTargetScopeReply(
    message: InboundMessage,
    collected: CodeChangeTargetCollection,
    unsafe: readonly string[],
  ): OutboundMessage {
    if (ConversationRuntime.asksForWholeRequestAgain(collected)) {
      return this.deps.composer.composeTargetsMissing(message.context, collected.missing);
    }
    // A missing safe path is the one the owner meant; only with no safe path at all is the unsafe one echoed.
    const mentioned = extractMentionedPathTokens(message.text);
    const typed = collected.kind === 'none'
      ? (unsafe[0] ?? mentioned[0])
      : (mentioned.find((token) => !unsafe.includes(token)) ?? mentioned[0]);
    return typed
      ? this.deps.composer.composeTargetPathRejected(message.context, typed)
      : this.deps.composer.composeTargetScopeClarification(message.context);
  }

  /** Assemble the display-relevant facts for a ran/timed-out `CommandExecution` (ADR-0034). Raw only — no truncation, no text. */
  private static toTestResultDetail(exec: CommandExecution): TestResultDetail {
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

  /**
   * Frame a TEST_EXECUTION outcome (ADR-0033; detail three-way branch added in ADR-0034). A command
   * that RAN → a **product test result** (pass/fail + detail), read via the existing
   * `CommandExecution` read path; `TIMED_OUT` → a distinct timeout reply (not a test verdict); a
   * command that never ran at all (allow-list refusal / system error, no `CommandExecution`) → an
   * execution-failure reply. The orchestrator's status contract is not reinterpreted — the runtime
   * only chooses which case applies and assembles raw facts; all text lives in `ResponseComposer`.
   */
  private async frameTestResult(
    message: InboundMessage,
    session: Session,
    outcome: ExecutionOutcome,
  ): Promise<TurnResult> {
    const id = outcome.refs.commandExecutionId;
    const exec: CommandExecution | null = id ? await this.deps.commandExecutions.get(id) : null;
    if (
      exec &&
      (exec.status === CommandExecutionStatus.SUCCEEDED || exec.status === CommandExecutionStatus.FAILED)
    ) {
      const passed = exec.status === CommandExecutionStatus.SUCCEEDED;
      const detail = ConversationRuntime.toTestResultDetail(exec);
      const reply = this.deps.composer.composeTestResult(message.context, { ...detail, passed });
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'RESPONDED', reply, sessionId: session.id, executionOutcome: outcome };
    }
    if (exec && exec.status === CommandExecutionStatus.TIMED_OUT) {
      const detail = ConversationRuntime.toTestResultDetail(exec);
      const reply = this.deps.composer.composeTestTimedOut(message.context, detail);
      return this.failComposed(message, session, reply, outcome);
    }
    // Command never ran at all (allow-list refusal → no CommandExecution, spawn/system error).
    return this.failComposed(message, session, this.deps.composer.composeCommandUnavailable(message.context), outcome);
  }

  private async respondComposed(
    message: InboundMessage,
    session: Session,
    reply: OutboundMessage,
    outcome?: ExecutionOutcome,
  ): Promise<TurnResult> {
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id, ...(outcome ? { executionOutcome: outcome } : {}) };
  }

  private async failComposed(
    message: InboundMessage,
    session: Session,
    reply: OutboundMessage,
    outcome?: ExecutionOutcome,
  ): Promise<TurnResult> {
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'FAILED', reply, sessionId: session.id, ...(outcome ? { executionOutcome: outcome } : {}) };
  }

  /** Map an ExecutionOutcome to a TurnResult + recorded reply. */
  private async replyForOutcome(
    context: ConversationContext,
    session: Session,
    outcome: ExecutionOutcome,
  ): Promise<TurnResult> {
    if (outcome.status === ('AWAITING_APPROVAL' as ExecutionOutcomeStatus)) {
      // Only a plan-scoped ref is available here (not the full ApprovalRequest) — use the generic
      // ResponseComposer prompt. The runtime never builds reply text itself (ADR-0032 §10).
      const reply = this.deps.composer.composeApprovalRequired(context);
      await this.deps.memory.recordAssistant(reply.text, context, session.id);
      return { status: 'AWAITING_APPROVAL', reply, sessionId: session.id, executionOutcome: outcome };
    }
    const replyStatus = toReplyStatus(outcome.status);
    const reply = this.deps.composer.composeExecutionResult(context, replyStatus);
    await this.deps.memory.recordAssistant(reply.text, context, session.id);
    const status: RuntimeTurnStatus =
      replyStatus === 'COMPLETED'
        ? 'RESPONDED'
        : replyStatus === 'DENIED'
          ? 'DENIED'
          : replyStatus === 'CANCELLED'
            ? 'CANCELLED'
            : 'FAILED';
    return { status, reply, sessionId: session.id, executionOutcome: outcome };
  }

  /** (F) Existing single-capability work path (relocated from QuokyCore), returning a reply. */
  private async handleWorkTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    excludeMemoryId: Id,
    readout: ProjectReadout | ExternalWorkReadout | undefined,
  ): Promise<TurnResult> {
    let task = await this.deps.tasks.createTask(intent, message.context, {
      requestText: message.text,
      actorId: actor.id,
      sessionId: session.id,
      ...(session.activeProjectId ? { projectId: session.activeProjectId } : {}),
    });
    // F7-A (Sprint 4c-Follow-up-7): reach RUNNING through the LEGAL lifecycle PENDING → PLANNING → RUNNING.
    // TaskManager.TRANSITIONS forbids PENDING → RUNNING directly; the prior direct jump threw
    // InvalidTaskTransitionError under the real TaskManager on every GENERAL_CHAT / PROJECT_ANALYSIS work
    // turn (masked in tests by a permissive fake `transition`). A non-execution work turn has no separate
    // planning phase, so PLANNING is a pass-through step to the legal predecessor of RUNNING.
    task = await this.deps.tasks.transition(task, TaskStatus.PLANNING);
    task = await this.deps.tasks.transition(task, TaskStatus.RUNNING);
    const capability: Capability = task.intent.capability;
    const run = await this.deps.tasks.startRun(task, capability);

    let providerId: string | undefined;
    let routingAudit: RuntimeProviderRoutingAudit | undefined;
    // ADR-0098 D5: transient routing facts for feedback capture; `providerId` is audit-only, never shown.
    const workFacts = (accepted: string | undefined): TurnWorkFacts => ({
      intentType: intent.type,
      capability,
      taskId: task.id,
      runId: run.id,
      ...(accepted ? { providerId: accepted } : {}),
    });
    try {
      const workspace = ConversationRuntime.needsWorkspace(capability)
        ? await this.deps.workspace.prepare(task)
        : undefined;
      // ADR-0100 D8 / ADR-0096 D4: a connector work summary is self-contained — no short-term history or durable
      // recall is read for it (PromptComposer also ignores the bundle for an external-work readout).
      const bundle: ContextBundle = isExternalWorkReadout(readout)
        ? { taskId: task.id, conversationTranscript: [], backgroundResources: [] }
        : await this.deps.contextBuilder.build(task, excludeMemoryId ? [excludeMemoryId] : []);
      const promptSpec = this.deps.promptComposer.compose(task, bundle, readout);
      const aiRequest = this.deps.promptRenderer.render(promptSpec, {
        capability,
        ...(workspace ? { workspace } : {}),
        // ADR-0098 D2: structured reply facts from the actual current User message (the same text PromptComposer
        // renders as the current turn), so adapters never re-derive them from the serialized prompt. Amendment D2:
        // a POLICY_SENSITIVE_CHAT turn gets them too, plus Core's external-action classification of that message,
        // which alone enables the adapter's action-claim guard.
        ...(capability === Capability.GENERAL_CHAT || capability === Capability.POLICY_SENSITIVE_CHAT
          ? { metadata: generalChatReplyPolicyMetadata(task.description, externalActionRequestOf(task.intent)) }
          : {}),
      });

      if (capability === Capability.GENERAL_CHAT && this.deps.runtimeProviderRouting) {
        const recencyFact = [...(bundle.conversationTranscript ?? [])]
          .reverse()
          .find((entry) => (entry.role ?? (entry.provenance === 'USER' ? 'user' : 'unknown')) === 'user')
          ?.content;
        await this.deps.dispatchCommit.commit(run.id, run.id);
        const routed = await this.deps.runtimeProviderRouting.execute({
          facts: {
            capability,
            intentType: intent.type,
            requiresWork: intent.requiresWork,
          },
          request: aiRequest,
          ...(recencyFact === undefined ? {} : { recencyFact }),
          currentUserTurn: message.text,
          executionId: run.id,
        });
        routingAudit = routed.audit;

        if (routed.status === ProviderGatewayTerminalStatus.ACCEPTED) {
          if (routed.output === undefined || routed.acceptedProviderId === undefined) {
            throw new Error('Accepted routing result is incomplete');
          }
          providerId = routed.acceptedProviderId;
          const artifacts: Artifact[] = routed.output.artifacts.map((artifact) => ({ ...artifact }));
          const artifactIds = await this.deps.artifacts.persistAll(task.id, run.id, artifacts);
          await this.deps.tasks.completeRun(run, {
            artifactIds,
            providerId,
            metadata: { routingAudit },
          });
          await this.deps.memory.recordAssistant(
            routed.output.text,
            message.context,
            task.sessionId ?? session.id,
          );
          await this.deps.tasks.transition(task, TaskStatus.COMPLETED);
          const reply = this.deps.composer.compose(
            message.context,
            { text: routed.output.text, artifacts },
            artifacts,
          );
          return this.responded(session, reply, workFacts(providerId));
        }

        await this.deps.tasks.failRun(run, `Provider routing ended with ${routed.status}`, {
          metadata: { routingAudit },
        });
        await this.deps.tasks.transition(
          task,
          routed.status === ProviderGatewayTerminalStatus.HUMAN_REVIEW_REQUIRED
            ? TaskStatus.NEEDS_REVIEW
            : TaskStatus.FAILED,
        );
        this.deps.logger.error('provider routing ended without accepted output', {
          taskId: task.id,
          runId: run.id,
          status: routed.status,
        });
        const reply = this.deps.composer.composeProviderRoutingTerminal(
          message.context,
          routed.status,
          routed.failureCode === RoutingFailureCode.SEMANTIC_VALIDATION_UNRESOLVED
            ? routed.failureCode
            : null,
        );
        return { status: 'FAILED', reply, sessionId: session.id, workFacts: workFacts(undefined) };
      }

      const provider = await this.deps.router.select(capability);
      providerId = provider.id;
      await this.deps.dispatchCommit.commit(run.id, run.id);
      const result = await provider.execute(aiRequest);

      const artifactIds = await this.deps.artifacts.persistAll(task.id, run.id, result.artifacts ?? []);
      await this.deps.tasks.completeRun(run, {
        artifactIds,
        ...(providerId ? { providerId } : {}),
        ...(result.audit ? { metadata: result.audit } : {}),
      });
      await this.deps.memory.recordAssistant(result.text, message.context, task.sessionId ?? session.id);
      if (capability === Capability.PROJECT_ANALYSIS && task.projectId) {
        await this.deps.memory.recordToolMemory(result.text, {
          projectId: task.projectId,
          sessionId: task.sessionId ?? session.id,
        });
      }
      await this.deps.tasks.transition(task, TaskStatus.COMPLETED);
      const reply = this.deps.composer.compose(message.context, result, result.artifacts ?? []);
      return this.responded(session, reply, workFacts(providerId));
    } catch (err) {
      const failure = describeAiFailure(err);
      await this.deps.tasks.failRun(run, failure.errorSummary, {
        ...(providerId ? { providerId } : {}),
        ...(routingAudit ? { metadata: { routingAudit } } : {}),
      });
      await this.deps.tasks.transition(task, TaskStatus.FAILED);
      this.deps.logger.error('work turn failed', { taskId: task.id, runId: run.id, kind: failure.kind });
      const reply = this.deps.composer.composeError(message.context, failure.userMessage);
      return { status: 'FAILED', reply, sessionId: session.id, workFacts: workFacts(providerId) };
    }
  }

  private decisionOf(approvalId: Id, decidedBy: string, approved: boolean): ApprovalDecision {
    return { approvalId, approved, decidedBy, decidedAt: now() };
  }

  private responded(session: Session, reply: OutboundMessage, workFacts?: TurnWorkFacts): TurnResult {
    return { status: 'RESPONDED', reply, sessionId: session.id, ...(workFacts ? { workFacts } : {}) };
  }
}
