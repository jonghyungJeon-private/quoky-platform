import {
  type ImageUnderstandingLocalitiesResolver,
} from '../image-understanding';
import {
  type ConnectorWriteFlow,
} from '../connector-writes/connector-write-flow';
import {
  type IntentClassifyContext,
} from '../intent-classifier';
import { type NlSelectionService } from '../nl-routing/nl-selection-service';
import { type AgentRunService } from '../agent/agent-run-service';
import { type SurfaceGate } from '../surface-grants/surface-gate';
import { type SurfaceGrantService } from '../surface-grants/surface-grant-service';
import {
  Capability,
  RiskLevel,
  TaskStatus,
} from '../../domain';
import type {
  Actor,
  ApplyInput,
  ApprovalDecision,
  ApprovalRef,
  ApprovalRequest,
  Artifact,
  CodeGeneration,
  CodeGenerationRef,
  CodeProposal,
  CodeProposalRef,
  CommandExecution,
  CommandExecutionRef,
  ContextBundle,
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
  WorkspaceRepositoryResolution,
} from '../../domain';
import {
  type AiExecutionLocality,
  type ProviderSelectionContext,
  type ResolvedProviderSelection,
  type AiProvider,
  type AiRequest,
  type Logger,
  type ProjectReadout,
  type ConversationTurnHandler,
} from '../../ports';
import type {
  ResponseComposer,
} from '../response-composer';
import type {
  RuntimeProviderRouting,
} from '../runtime-provider-routing-service';
import type { IntentResolutionContext } from '../intent-resolver';
import type { MemoryWriter } from '../memory-writer';
import type { WorkSurface, WorkSurfaceReadOptions } from '../work-surface-query';
import type { ExternalWorkReadout } from '../work-chat/external-work-readout';
import {
  type PromptCompositionOptions,
} from '../prompt-composer';
import {
  type UntrustedDocumentReadout,
} from '../untrusted-document-readout';
import type { SessionLockHold } from '../session-write-lock';
import {
  type CredentialOverrideFlow,
} from '../credential-override';
import type { RunUsageRecord } from '../../domain';
import {
  type PushMode,
} from '../code-work/push-target-resolution';
import type {
  CancelToken,
  ExecutionOutcome,
  ExecutionRequest,
} from '../execution-orchestrator';

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
  anchor(session: Session, request: ExecutionRequest, outcome: ExecutionOutcome, held?: SessionLockHold): Promise<void>;
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
  findPending(session: Session, held?: SessionLockHold): Promise<PendingScopeClarification | null>;
  /** Anchor a fresh insufficient-scope request so the next turn can recover it. Callers must only
   *  invoke this after confirming an active project exists, the workspace opened successfully, and
   *  no target validated. */
  anchor(session: Session, pending: PendingScopeClarification, held?: SessionLockHold): Promise<void>;
  /** Consume/clear the anchor — called unconditionally once a pending clarification is checked
   *  (next-turn-only semantics). Safe: a no-op unless `session.activeTaskId` still points at THIS
   *  flow's own anchor Task — it must never clear an approval anchor. */
  clear(session: Session, held?: SessionLockHold): Promise<void>;
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
  /** The target paths whose credential-flagged content was sent to the AI ONCE under an owner override for this
   *  preview (ADR-0097 D7). Display-only: a "취소" at `ELIGIBLE` says that send cannot be undone (QA-V2-CL-03).
   *  Absent when no override was used (and on every anchor written before QA-V2-CL-03). */
  credentialOverrideSentPaths?: string[];
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
  /** The approved commit's subject (ADR-0108 D2) — the executed message (== the approved `proposedCommitMessage`,
   *  integrity-checked) as a single line of at most 72 characters, credential-guarded. Set at GIT_COMMITTED; absent
   *  when refused and on anchors committed before ADR-0108 (the PR title then falls back to the file-based form). */
  committedSubject?: string;
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
  /** ADR-0109: the repository identity the push approval covers (resolved from the workspace at approval time when
   *  the per-workspace resolver is configured). Execution re-resolves and refuses (`target changed`) on a difference
   *  or when it is missing. Cleared with the other push fields. Never a URL or token. */
  pushRepositoryIdentity?: RepositoryIdentity;
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
  /** The exact PR title the PR approval covers (ADR-0108 D2, amends ADR-0049 CA #4) — the approved commit's
   *  subject, else `chore: update <first path> (+N files)`. Never the instruction text. Previewed verbatim and sent
   *  verbatim at execution. */
  prTitle?: string;
  /** The exact PR body the PR approval covers (ADR-0108 D3, amends ADR-0049 CA #5) — commit, head→base, committed
   *  file paths (≤20, then "+N more"), "Generated by Quoky; not merged"; never content/diff/secret names; ≤4,000
   *  chars. Previewed verbatim and sent verbatim at execution. */
  prBody?: string;
  /** SHA-256 of (`prTitle`, `prBody`) recorded with the CRITICAL PR approval (ADR-0108 D5, amends ADR-0099 D5). The
   *  execution re-hashes the stored text; a mismatch (or a missing hash, e.g. a pre-ADR-0108 anchor) creates no PR. */
  prContentHash?: string;
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
  findAnchor(session: Session, held?: SessionLockHold): Promise<ApplyPreviewAnchor | null>;
  /**
   * Strictly read-only `findAnchor` (ADR-0113 D4): the anchor in focus, or null — a stale one (project changed) is
   * reported as none and is NEVER cleared here; reconciliation stays in serialized transitions. For the operations UI.
   */
  peekAnchor?(session: Session): Promise<ApplyPreviewAnchor | null>;
  /** Anchor (or re-anchor, on every status transition) the apply-preview fact set. Always creates a
   *  fresh Task and re-points `session.activeTaskId` — same shape as the other two flows. */
  anchor(session: Session, anchor: ApplyPreviewAnchor, held?: SessionLockHold): Promise<void>;
  /** Consume/clear the anchor — called only on deny/cancel (approving re-anchors as `APPROVED` instead).
   *  A no-op unless `session.activeTaskId` still points at THIS flow's own anchor Task. */
  clear(session: Session, held?: SessionLockHold): Promise<void>;
  /**
   * Conditional clear (QA-V2-CL-03 preview discard): re-read the LIVE session from storage (never trust the turn's
   * possibly stale copy) and clear only while its current anchor is still the expected one — same code generation
   * (`codeGenerationRef.id`) and same `status`. Returns whether it cleared. Optional: a flow without it makes the
   * caller fail closed (nothing cleared).
   */
  clearIfCurrent?(session: Session, expected: ApplyPreviewAnchorIdentity, held?: SessionLockHold): Promise<boolean>;
}

/** Identifies one apply-preview anchor state for {@link ApplyPreviewFlow.clearIfCurrent}. */
export interface ApplyPreviewAnchorIdentity {
  readonly status: ApplyPreviewAnchorStatus;
  readonly codeGenerationId: Id;
}

export interface ConversationRuntimeDeps {
  readonly dispatchCommit: Pick<import('../provider-dispatch-commit-coordinator').ProviderDispatchCommitCoordinator, 'commit'>;
  readonly actors: { resolveFromContext(context: ConversationContext): Promise<Actor> };
  readonly sessions: {
    openForContext(context: ConversationContext, actorId: Id): Promise<Session>;
    /** `held`: a caller already holding the session write lock passes its hold (ADR-0113 D7). */
    touch(session: Session, held?: SessionLockHold): Promise<Session>;
    /** Close the session on a reset (ADR-0093) — `SessionManager.close`, saved as `SessionStatus.CLOSED`. */
    close(session: Session, held?: SessionLockHold): Promise<Session>;
  };
  readonly memory: {
    recordShortTerm(message: InboundMessage, sessionId?: Id): Promise<{ id: Id }>;
    recordAssistant(text: string, context: ConversationContext, sessionId?: Id): Promise<unknown>;
    recordToolMemory(text: string, opts: { projectId?: Id; sessionId?: Id }): Promise<unknown>;
    /** W2-L01: rewrite a recorded SHORT_TERM turn (a turn handler's `history.user`); `MemoryManager` provides it. */
    redactShortTerm?(id: Id, content: string): Promise<unknown>;
    /** Fail-closed fallback when that rewrite fails: remove the recorded SHORT_TERM turn; `MemoryManager` provides it. */
    deleteShortTerm?(id: Id): Promise<unknown>;
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
      opts: { artifactIds: Id[]; providerId?: string; metadata?: Metadata; usage?: RunUsageRecord },
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
  /** `options.channelRecall` (ADR-0122 D7, P2): passed only for a channel holding `memory` while the gate is enforced. */
  readonly contextBuilder: { build(task: Task, excludeMemoryIds: Id[], options?: { readonly channelRecall?: boolean }): Promise<ContextBundle> };
  /**
   * ADR-0100 D8: the readout is widened by type only to carry a work summary's external-work readout; ADR-0118 D7
   * widens it the same way for the untrusted readout of one personal item the owner asked to summarize.
   */
  readonly promptComposer: {
    /** ADR-0107 D6: `options` (type-only widening) carries the resolved provider's locality for the example layer. */
    compose(
      task: Task,
      bundle: ContextBundle,
      readout?: ProjectReadout | ExternalWorkReadout | UntrustedDocumentReadout,
      options?: PromptCompositionOptions,
    ): PromptSpec;
  };
  readonly promptRenderer: {
    render(
      spec: PromptSpec,
      opts: { capability: Capability; workspace?: WorkspaceRef; metadata?: Readonly<Record<string, unknown>> },
    ): AiRequest;
  };
  /**
   * The provider selector. The runtime passes the turn's session as the selection context (ADR-0092 amendment, runtime
   * switching), so the owner's session-scoped choice can apply; a selector may ignore it.
   */
  readonly router: {
    select(capability: Capability, context?: ProviderSelectionContext): Promise<AiProvider>;
    /** Optional: `select` plus whether the provider is the owner's explicit selection (ADR-0116 D3). */
    resolve?(capability: Capability, context?: ProviderSelectionContext): Promise<ResolvedProviderSelection>;
    /** Optional synchronous dispatch-time eligibility check (image turns; ADR-0111 amendment, runtime switching). */
    isStillEligible?(capability: Capability, context: ProviderSelectionContext, provider: AiProvider): boolean;
  };
  /** Optional Slice 5A seam. Only TaskRun-backed GENERAL_CHAT work turns may use it. */
  readonly runtimeProviderRouting?: RuntimeProviderRouting;
  readonly artifacts: { persistAll(taskId: Id, runId: Id, artifacts: Artifact[]): Promise<Id[]> };
  readonly composer: ResponseComposer;
  /** Read-only, rebuildable personal-work projection. Replaces the unused legacy `risk` dependency (31 → 31). */
  /** `options.sources` (ADR-0122 D2.4, P2): only in a channel with the gate enforced, the sources its permit allows. */
  readonly workSurface: { forActor(actor: Actor, options?: WorkSurfaceReadOptions): Promise<WorkSurface> };
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
    /**
     * Live QA session 3 (D12): withdraw an APPROVED, unexecuted connector-write grant (`ApprovalManager.revoke`, the same
     * already-registered instance). Optional so narrow fakes keep compiling; absent → the anchor still closes.
     */
    revoke?(approvalId: Id, decision: ApprovalDecision): Promise<ApprovalRequest>;
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
    pushApprovedCommit(input: {
      rootPath: string;
      remote: string;
      branch: string;
      commitHash: string;
      approvalRef: ApprovalRef;
      /** ADR-0109: the repository the push approval bound (passed only with the per-workspace resolver). */
      repository?: RepositoryIdentity;
    }): Promise<GitPushResult>;
    /** Post-merge LOCAL main synchronization (Sprint 3h, ADR-0058) — the same already-registered GitManager.
     *  Fast-forward-only; NO ApprovalRef (local, non-destructive, gated by PR_MERGED + explicit command +
     *  preflight). The runtime calls this ONLY — never the provider primitives, never shells to git. */
    syncMain(input: {
      rootPath: string;
      remote: string;
      branch: string;
      expectedRemoteCommit: string;
      /** ADR-0109: the anchored repository (passed only with the per-workspace resolver). */
      repository?: RepositoryIdentity;
    }): Promise<GitMainSyncResult>;
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
    /**
     * ADR-0109 D2 (multi-repository allowlist): resolves a registered project's repository identity from its workspace
     * `origin` (composition root: a sanitized local git read, the hosting adapter's URL rules, checked against
     * the allowlist). `remote` names the remote a push will actually use when it is not `origin`; its URLs must name the
     * same repository. OPTIONAL: absent keeps the static `identity` above exactly as before. When present it REPLACES
     * `identity` for every remote step (push, PR, status, merge, main sync, cleanup): a `refused` result stops the
     * step before any git remote call, hosting call or token mint, with a truthful reply. Never a URL or token.
     */
    resolveIdentity?(rootPath: string, remote?: string): Promise<WorkspaceRepositoryResolution>;
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
  /**
   * Connector writes behind exact-payload one-time CRITICAL approvals (ADR-0112 D5, ADR-0110 amendment; amends
   * ADR-0032: baseline 34 → 35). OPTIONAL: when absent every write request gets its handler's fixed "writes are off"
   * reply and no write can ever run.
   */
  readonly connectorWriteFlow?: ConnectorWriteFlow;
  /**
   * Natural-language capability selection (ADR-0120 D6 Phase A; amends ADR-0032: baseline 35 → 36). OPTIONAL: absent,
   * or mode `off`, keeps every turn byte-identical. The runtime only dispatches and presents: the catalog call,
   * validation, the clarification state, `lastSelection` and the interpretation preferences belong to the service.
   */
  readonly nlSelection?: Pick<NlSelectionService, 'mode' | 'decide'> &
    Partial<
      Pick<
        NlSelectionService,
        | 'takePending'
        // ADR-0122 D2.2: a question refused by the surface gate is dropped (no new deps key: the same slot).
        | 'dropPending'
        | 'recordGrammarSelection'
        // Owner decision B (2026-10-22): a handler reply that asks to confirm one read keeps it as the open question.
        | 'recordConfirmQuestion'
        | 'clearLastSelection'
        // Owner decision D1 (2026-10-26): a chat turn keeps `lastSelection`, one turn older.
        | 'keepLastSelectionAcrossChat'
        | 'yieldsToSelection'
        | 'grammarYieldEnabled'
        | 'phaseCEnabled'
        | 'phaseCShadowEnabled'
        | 'shadowGrammarHit'
        // ADR-0120 amendment A6 (no new deps key: the same `nlSelection` slot); all inert while QUOKY_NL_ACTIONS is off.
        | 'actionLevel'
        | 'actionsOffered'
        | 'actionsActing'
        | 'handleSwitchPhrase'
        | 'decideAnchoredUndo'
        | 'answerActionPending'
        | 'recordActionReceipt'
        // Context eval 2026-10-26 (P4): an approved connector write becomes the (not undoable) last action.
        | 'recordExternalWrite'
        | 'logActionUnserved'
        | 'actionsStillActing'
        // ADR-0120 amendment A6 R5a (no new deps key): deictic writes; inert while QUOKY_NL_DEICTIC_WRITES is off.
        | 'answerDeicticDraft'
        | 'recordLastTurn'
        | 'deicticWritesMode'
        // Owner decision of 2026-10-29 (no new deps key): whether the last reply was chat, for a stale bare yes or no.
        | 'recordLastReply'
      >
    >;
  /**
   * ADR-0122 surface permission grants (amends ADR-0032: baseline 36 → 37). OPTIONAL: absent, or the gate in mode `off`
   * (`QUOKY_CHANNEL_GRANTS=off`), keeps every turn byte-identical (the P0 DM-only checks stay in their handlers). With
   * `enforce`, the one Core gate runs before every handler, selection, route, state-bound step and approval in a channel;
   * `service` answers the owner's list / revoke phrases and the kill-switch phrase.
   */
  readonly surfaceGrants?: {
    readonly gate: SurfaceGate;
    readonly service?: Pick<SurfaceGrantService, 'handlePhrase' | 'handleSwitchPhrase'> & Partial<Pick<SurfaceGrantService, 'handleGrantPending'>>;
    /** The live actor (grants re-read at an execution step, D2.5); absent → the turn's snapshot. */
    readonly freshActor?: (actorId: Id) => Promise<Actor | null>;
  };
  /**
   * ADR-0121 stage S2 (amends ADR-0032: baseline 37 → 38): the bounded read agent. OPTIONAL: absent, or mode `off`
   * (`QUOKY_AGENT_MODE`, the default), keeps every turn byte-identical (the runtime reads `mode` and nothing else). In
   * `shadow`, an owner DM turn that reached selection (or, under `c-shadow`, whose read a Class B grammar answered) queues
   * one background planner job after its reply (no read, no M2,
   * one content-free log line), and the kill-switch phrase is recognized while the mode is not `off`. `active` is refused
   * at construction until the D11 gates pass.
   */
  readonly agentRuns?: Pick<AgentRunService, 'mode' | 'shadowAdmits' | 'runShadow' | 'handleSwitchPhrase' | 'switchSuffix'>;
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
  /**
   * ADR-0111 amendment A2 (2026-10-07): the declared provider localities that may receive image bytes on an image turn.
   * Absent → `['LOCAL']` (the ADR-0111 D5 default; behaviour unchanged). The composition root passes
   * `['LOCAL', 'REMOTE']` only when the owner explicitly selected a cloud image provider. A composition-time option,
   * not a deps key: it is configuration, like `gitRemoteEnabled`, and no collaborator.
   * ADR-0111 amendment (runtime switching): it may instead be a resolver read on every image turn with the turn's
   * session, so the policy follows the owner's effective image selection; a failing resolver means `['LOCAL']`.
   */
  readonly imageUnderstandingLocalities?: readonly AiExecutionLocality[] | ImageUnderstandingLocalitiesResolver;
}
