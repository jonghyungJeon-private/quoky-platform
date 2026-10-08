import { createHash, timingSafeEqual } from 'node:crypto';

import { ApprovalStatus, SessionStatus } from '../domain';
import type {
  Actor,
  ApprovalDecision,
  ApprovalRequest,
  ConversationContext,
  Id,
  IsoTimestamp,
  OutboundMessage,
  RiskLevel,
  Session,
} from '../domain';
import type { ConnectorWriteOperation } from '../ports/connector-write.port';
import { now } from '../util/clock';
import { sha256Canonical } from './canonical-digest';
import { APPROVAL_REVOKED_COMMENT } from './approval-manager';
import { PENDING_APPROVAL_TTL_MS, pendingApprovalRemainingMs } from './conversation-commands';
import { CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE } from './connector-writes/connector-write-copy';
import {
  connectorWriteExecutionGate,
  connectorWriteTargetOf,
  type ConnectorWriteAnchorView,
  type ConnectorWriteStep,
  type ConnectorWriteTargetSummary,
} from './connector-writes/connector-write-flow';
import { documentedExecutionPhrase } from './execution-command-guard';
import {
  CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
  CREDENTIAL_OVERRIDE_DENY_COMMENT,
  type CredentialOverrideGrantResult,
  type CredentialOverrideLookup,
} from './credential-override';
import type {
  ApplyPreviewAnchor,
  ConversationRuntimeDeps,
  PendingScopeClarification,
  RuntimeTurnStatus,
} from './conversation-runtime';
import type { ExecutionReplyStatus } from './response-composer';
import type { ExecutionOutcome, ExecutionRequest } from './execution-orchestrator';
import { SESSION_WRITE_LOCK, type SessionLockHold, type SessionWriteLock } from './session-write-lock';
import { KeyedMutex } from '../util/keyed-mutex';

/**
 * ADR-0113 D7 (OPS-2b): the ONE approval decision path, shared by chat and the local operations UI.
 *
 * Extracted from `ConversationRuntime`'s decision turns with their behaviour unchanged: the runtime still interprets the
 * chat text (approve / deny / cancel / ambiguous) and still owns the ambiguous re-prompt, then hands the decision to this
 * service, which runs exactly what the turn ran before — the pending-context integrity guard, the request re-read, the
 * ADR-0093 expiry re-check immediately before a positive decision, the `ApprovalManager.decide` record, the anchor
 * re-anchor / release, the composed reply and the session-history record. The operations UI reaches the same methods
 * through {@link ApprovalDecisionService.decideFromOpsUi}, as the owner `Actor`, with the `ops-ui` surface marker.
 *
 * What a decision does NOT do from either surface: execute. Approving records the approval (the chain moves to its
 * `*_APPROVED` state, or the connector write to `APPROVED`); the commit, push, PR, merge, remote cleanup and connector
 * write still run only on their exact chat execution phrase. The two kinds whose chat approval itself runs work in the
 * same turn — the plan-scoped approval (resume + code-generation preview) and the ADR-0097 credential override (the
 * send phrase dispatches) — keep that approval in chat: the UI may reject them, never approve them.
 *
 * Built only from collaborators the runtime already holds (ADR-0113 D8: no new `ConversationRuntimeDeps` key, no
 * `app.module.ts` provider); the runtime constructs it and exposes it as `ConversationRuntime.approvalDecisions`.
 *
 * Serialization (lock order approval → session, see `session-write-lock.ts`): EVERY transition of a pending approval — chat approve/deny/cancel, the UI's approve/reject, the
 * ADR-0093 expiry (turn start and the re-check before a positive decision), the ADR-0097 credential-override send and
 * its close of a stray request, and the conversation reset — runs in-process (single instance, ADR-0102 D4) under the
 * per-approval lock, then the shared per-session write lock (`SESSION_WRITE_LOCK`) of the conversation it changes —
 * the SAME lock every session writer (touch, project switch, reset close, every flow's pointer save) takes, so no
 * session write can interleave with a decision. The session hold is passed explicitly to every flow / SessionManager
 * call made inside it (re-entrant for the holder only; a call without it would queue behind its own caller). Inside the locks each transition re-reads the approval and acts only
 * while it is still `PENDING`, so the `PENDING` check, the decision save and the session update it carries (re-anchor,
 * release, close) cannot interleave with another transition. The first one wins; a chat turn that lost the race gets
 * the existing "nothing to decide" reply, a UI request that lost gets `ALREADY_DECIDED` (or `NOT_FOUND` when the
 * conversation was reset meanwhile), and a reset session is never re-anchored: the UI decides only for a conversation
 * that is still ACTIVE when it holds the session lock.
 */

export type ApprovalDecisionVerdict = 'approve' | 'deny' | 'cancel';
export type ApprovalDecisionSurface = 'chat' | 'ops-ui';
/** The audit marker an operations-UI decision carries in `ApprovalRequest.comment` (ADR-0113 D7 audit; no new table). */
export const OPS_UI_DECISION_SURFACE = 'ops-ui';

/** What a decision turn returns; the runtime adds the session id to make a `TurnResult`. */
export interface ApprovalDecisionReply {
  readonly status: RuntimeTurnStatus;
  readonly reply: OutboundMessage;
}

/** The decision input a surface supplies. `context` is where the reply is composed for (the originating conversation). */
export interface ApprovalDecisionInput {
  readonly context: ConversationContext;
  readonly session: Session;
  readonly actor: Actor;
  readonly surface: ApprovalDecisionSurface;
  /** Set by the service inside its locks (the session write lock hold passed to every session writer); callers omit. */
  readonly held?: SessionLockHold;
}

/**
 * The approval holding a conversation, if any (ADR-0093): the plan-scoped approval derived by `approvalFlow`
 * (ADR-0032), or the PENDING request behind an apply-preview anchor's `*_PENDING` status (ADR-0040…0060).
 * `planPending`/`pendingScope`/`applyAnchor` are the lookups the runtime's routing reuses, so no flow is queried twice
 * in one turn.
 */
export interface PendingApprovalLookup {
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
  /**
   * The session's connector-write anchor (ADR-0112), looked up after the credential-override set and before the
   * apply-preview anchor (the same session pointer, so at most one of them is ever set).
   */
  connectorWrite?: ConnectorWriteAnchorView | null;
  pending: ApprovalRequest | null;
}

/** Which decision path a pending approval takes (the UI shows a fixed label per kind; chat routes by anchor state). */
export type ApprovalGateKind =
  | 'PLAN'
  | 'CREDENTIAL_OVERRIDE'
  | 'CONNECTOR_WRITE'
  | 'APPLY'
  | 'COMMIT'
  | 'PUSH'
  | 'PR'
  | 'MERGE'
  | 'REMOTE_BRANCH_CLEANUP';

/** Kinds whose chat approval only RECORDS the approval (the execution needs a later exact chat phrase). */
const UI_APPROVABLE_KINDS: ReadonlySet<ApprovalGateKind> = new Set<ApprovalGateKind>([
  'CONNECTOR_WRITE',
  'APPLY',
  'COMMIT',
  'PUSH',
  'PR',
  'MERGE',
  'REMOTE_BRANCH_CLEANUP',
]);

/** The anchor statuses that hold a pending approval, and the kind each decides. */
const ANCHORED_KIND: Readonly<Partial<Record<ApplyPreviewAnchor['status'], ApprovalGateKind>>> = {
  AWAITING_APPROVAL: 'APPLY',
  COMMIT_APPROVAL_PENDING: 'COMMIT',
  PUSH_APPROVAL_PENDING: 'PUSH',
  PR_APPROVAL_PENDING: 'PR',
  MERGE_APPROVAL_PENDING: 'MERGE',
  REMOTE_BRANCH_CLEANUP_PENDING: 'REMOTE_BRANCH_CLEANUP',
};

/** The PENDING approval id an apply-preview anchor status carries, if that status is a pending gate. */
export function pendingApprovalIdOf(anchor: ApplyPreviewAnchor): Id | undefined {
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
 * The anchor after its pending approval was rejected — the same state each decision path's deny/cancel branch moves to
 * (null = clear: the apply approval has nothing earlier to preserve). Used for expiry.
 */
export function anchorAfterRejection(anchor: ApplyPreviewAnchor): ApplyPreviewAnchor | null {
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
        pushRepositoryIdentity: undefined,
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
        prBody: undefined,
        prContentHash: undefined,
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

/** Whether a connector-write step concerns the calendar (its history keeps a fixed note, never event text — ADR-0110 D4). */
export function isCalendarWriteStep(step: Exclude<ConnectorWriteStep, { kind: 'writes-off' }>): boolean {
  switch (step.kind) {
    case 'usage':
      return step.topic.startsWith('calendar');
    case 'refused':
    case 'closed':
      return step.family === 'calendar';
    case 'choice':
      return true;
    case 'preview':
      return step.preview.operation.startsWith('CALENDAR_');
    default:
      return step.operation.startsWith('CALENDAR_');
  }
}

// ── confirmation reference (ADR-0113 D7) ───────────────────────────────────────────────────────────────────────────

/** The reference window (the ADR-0106 code window style): 30 minutes. */
export const APPROVAL_REFERENCE_WINDOW_MS = 30 * 60 * 1000;
/** Wrong references accepted for one approval within one window before UI approve is disabled for it (chat unaffected). */
export const APPROVAL_REFERENCE_MAX_ATTEMPTS = 5;
export const APPROVAL_REFERENCE_LENGTH = 6;
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The kind-specific grant binding chat's consume step already checks, from the anchor that holds the approval (the
 * approved push target, the PR content, the ADR-0112 payload via the approval reason, ...). A changed binding changes
 * the digest, so an old reference no longer matches.
 */
export type ApprovalGrantBinding =
  | { readonly kind: 'CONNECTOR_WRITE'; readonly operation: string }
  | { readonly kind: Exclude<ApprovalGateKind, 'PLAN' | 'CREDENTIAL_OVERRIDE' | 'CONNECTOR_WRITE'>; readonly anchor: ApplyPreviewAnchor };

function grantBindingShape(binding: ApprovalGrantBinding): unknown {
  if (binding.kind === 'CONNECTOR_WRITE') return { operation: binding.operation };
  const a = binding.anchor;
  switch (binding.kind) {
    case 'APPLY':
      return {
        codeGeneration: a.codeGenerationRef?.id ?? null,
        codeProposal: a.codeProposalRef?.id ?? null,
        targets: a.targetFiles ?? [],
        newFiles: a.newFileTargets ?? [],
      };
    case 'COMMIT':
      return {
        workspaceChange: a.workspaceChangeRef?.id ?? null,
        message: a.proposedCommitMessage ?? null,
        files: a.commitCandidateFiles ?? [],
      };
    case 'PUSH':
      return {
        commit: a.pushCommitHash ?? null,
        remote: a.pushRemote ?? null,
        branch: a.pushBranch ?? null,
        upstream: a.pushUpstreamRef ?? null,
        mode: a.pushMode ?? null,
        // ADR-0109: present only when the push approval bound a repository, so older digests are unchanged.
        ...(a.pushRepositoryIdentity
          ? { repository: `${a.pushRepositoryIdentity.provider}:${a.pushRepositoryIdentity.owner}/${a.pushRepositoryIdentity.repo}` }
          : {}),
      };
    case 'PR':
      return {
        commit: a.prPushedCommitHash ?? null,
        head: a.prHeadBranch ?? null,
        base: a.prBaseBranch ?? null,
        title: a.prTitle ?? null,
        content: a.prContentHash ?? null,
      };
    case 'MERGE':
    case 'REMOTE_BRANCH_CLEANUP':
      return {
        pr: a.pullRequestNumber ?? null,
        head: a.pullRequestHeadBranch ?? null,
        base: a.pullRequestBaseBranch ?? null,
        commit: a.pullRequestCommitHash ?? null,
      };
  }
}

/** SHA-256 over the approval's execution-plan ref, risk level, reason and the kind-specific grant binding. */
export function approvalBindingDigest(approval: ApprovalRequest, binding: ApprovalGrantBinding): string {
  return sha256Canonical('quoky.approval-reference.binding.v1', [
    approval.executionPlanRef.id,
    approval.riskLevel,
    approval.reason,
    binding.kind,
    grantBindingShape(binding),
  ]);
}

/** The 30-minute window index of an instant. */
export function approvalReferenceWindow(atMs: number): number {
  return Math.floor(atMs / APPROVAL_REFERENCE_WINDOW_MS);
}

/**
 * The confirmation reference: the first 6 characters (Crockford base32) of SHA-256 over the canonical tuple
 * (approval id, binding digest, owner actor id, window index).
 */
export function approvalConfirmationReference(approvalId: Id, bindingDigest: string, ownerActorId: Id, windowIndex: number): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['quoky.approval-reference.v1', approvalId, bindingDigest, ownerActorId, windowIndex]))
    .digest();
  const top30 = digest.readUInt32BE(0) >>> 2;
  let out = '';
  for (let i = APPROVAL_REFERENCE_LENGTH - 1; i >= 0; i--) out += CROCKFORD_BASE32[(top30 >>> (5 * i)) & 31];
  return out;
}

/** Crockford decoding of a typed reference: case-insensitive, I/L → 1, O → 0, separators dropped. */
export function normalizeApprovalReference(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

function sameReference(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

// ── the operations-UI surface ──────────────────────────────────────────────────────────────────────────────────────

/** Metadata the operations UI may show for a pending approval (ADR-0113 D5: no payload, preview, reply or reference). */
export interface ApprovalSurfaceView {
  readonly approvalId: Id;
  readonly kind: ApprovalGateKind;
  readonly riskLevel: RiskLevel;
  readonly createdAt: IsoTimestamp;
  readonly remainingMs: number;
  /** Whether the UI may approve it (it may always reject it). */
  readonly approvable: boolean;
  /** Where the chat preview was shown (the originating conversation; ids only). */
  readonly chat: ConversationContext;
}

export type ApprovalSurfaceRefusal =
  /** No pending approval with this id is held by a conversation (unknown, already decided, or not anchored). */
  | 'NOT_FOUND'
  /** The approval is held by a conversation of another actor. */
  | 'FOREIGN'
  /** It was decided (by chat, or by an earlier UI request) before this one. */
  | 'ALREADY_DECIDED'
  /** Its chat approval runs work in the same turn (plan resume, credential-override send): approve it in chat. */
  | 'APPROVE_IN_CHAT'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_MISMATCH'
  /** Five wrong references in this window: UI approve is disabled for this approval until the window ends. */
  | 'REFERENCE_LOCKED';

export type ApprovalSurfaceLocate =
  | { readonly status: 'FOUND'; readonly view: ApprovalSurfaceView }
  | { readonly status: 'REFUSED'; readonly refusal: 'NOT_FOUND' | 'FOREIGN' };

export type ApprovalSurfaceDecision =
  | {
      readonly status: 'DECIDED';
      readonly outcome: 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'UNAVAILABLE';
      readonly kind: ApprovalGateKind;
      /** The composed reply, exactly as chat would have answered (recorded into that session's history). */
      readonly reply: OutboundMessage;
      /** The originating conversation (for the owner-DM result notice; never shown by the UI). */
      readonly chat: ConversationContext;
      /**
       * An APPROVED connector write only: what was approved (kind and target, never the payload), the exact phrase that
       * runs it — which must be sent in `chat` (execution is bound to the approving conversation) — and the grant's
       * lifetime, so the owner DM can say what, where and how long.
       */
      readonly connectorWrite?: ConnectorWriteApprovedNotice;
    }
  | { readonly status: 'REFUSED'; readonly refusal: ApprovalSurfaceRefusal };

/** {@link ApprovalSurfaceDecision}'s approved connector-write details. */
export interface ConnectorWriteApprovedNotice {
  readonly operation: ConnectorWriteOperation;
  readonly target: ConnectorWriteTargetSummary;
  readonly executionPhrase: string;
  readonly remainingMs: number;
}

export interface OpsUiDecisionInput {
  readonly approvalId: Id;
  readonly decision: 'approve' | 'reject';
  /** The resolved owner Actor (ADR-0113 D7: the UI token stands in for ADR-0091 owner admission). */
  readonly actor: Actor;
  /** The confirmation reference the owner typed (approve only). */
  readonly reference?: string;
  /** The conversations to search for the holder (the owner's open sessions); read fresh per request. */
  readonly sessions: () => Promise<readonly Session[]>;
}

/** The link/reference a finished write recorded (for a repeat reply). */
function outcomeLinkOf(anchor: ConnectorWriteAnchorView['anchor']): { externalRef?: string; url?: string } {
  return {
    ...(anchor.outcome?.externalRef ? { externalRef: anchor.outcome.externalRef } : {}),
    ...(anchor.outcome?.url ? { url: anchor.outcome.url } : {}),
  };
}

// ── the service ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ApprovalDecisionServiceDeps = Pick<
  ConversationRuntimeDeps,
  | 'approvals'
  | 'approvalFlow'
  | 'scopeClarificationFlow'
  | 'applyPreviewFlow'
  | 'credentialOverrideFlow'
  | 'connectorWriteFlow'
  | 'composer'
  | 'logger'
> & {
  readonly memory: Pick<ConversationRuntimeDeps['memory'], 'recordAssistant'>;
  /** The reset closes the session under the same locks as the decision it races (ADR-0093). */
  readonly sessions: Pick<ConversationRuntimeDeps['sessions'], 'close'>;
};

export interface ApprovalDecisionServiceOptions {
  /** The shared clock (ADR-0093 lifetime, decision timestamps of expiry denials, the reference window). */
  readonly clock?: () => IsoTimestamp;
  /** The session write lock (ADR-0113 D7). Omitted → the process-wide {@link SESSION_WRITE_LOCK} every writer shares. */
  readonly sessionLock?: SessionWriteLock;
}

/** The plan-scoped approve: a reply (cannot reconstruct, or expired), or the resume context the runtime runs. */
export type PlanApproveResult =
  | { readonly kind: 'reply'; readonly value: ApprovalDecisionReply }
  | { readonly kind: 'resume'; readonly request: ExecutionRequest; readonly prior: ExecutionOutcome };

/** The credential-override send (ADR-0097): a reply (expired, or nothing left to decide), or the grant it recorded. */
export type CredentialOverrideSendResult =
  | { readonly kind: 'reply'; readonly value: ApprovalDecisionReply }
  | { readonly kind: 'granted'; readonly granted: CredentialOverrideGrantResult };

type AnchoredFailureFamily = 'commit' | 'push' | 'pr';

export class ApprovalDecisionService {
  private readonly clock: () => IsoTimestamp;
  /** The per-approval lock (outermost; see the serialization note above). */
  private readonly approvalLock = new KeyedMutex();
  /** The shared per-session write lock (inside the approval lock). */
  private readonly sessionLock: SessionWriteLock;
  /** Approval ids decided from the operations UI (a racing chat turn on a stale anchor must not decide again). */
  private readonly settledByOpsUi = new Set<Id>();
  private readonly referenceAttempts = new Map<Id, { window: number; wrong: number }>();
  private confirmationReferenceEnabled = false;

  constructor(
    private readonly deps: ApprovalDecisionServiceDeps,
    options: ApprovalDecisionServiceOptions = {},
  ) {
    this.clock = options.clock ?? now;
    this.sessionLock = options.sessionLock ?? SESSION_WRITE_LOCK;
  }

  // ── lookup and expiry (moved from the runtime) ──────────────────────────────────────────────────────────────────

  /** Milliseconds before a pending approval expires (ADR-0093); `<= 0` means expired. */
  remainingMs(approval: ApprovalRequest): number {
    return pendingApprovalRemainingMs(approval.createdAt, this.clock());
  }

  /**
   * Derive the approval holding this conversation, if any (ADR-0093), with the same lookups and order the routing uses:
   * `approvalFlow.findPending` (plan-scoped, ADR-0032), then the scope clarification (ADR-0037, which holds no
   * approval), then the credential-override set (ADR-0097, whose reconstruction re-reads every ApprovalRequest of the
   * set), then the connector-write anchor (ADR-0112), then the apply-preview anchor, whose `*_PENDING` status names the
   * PENDING request id (re-read through `approvals.get`, never trusted blindly).
   */
  async findPending(session: Session, held?: SessionLockHold): Promise<PendingApprovalLookup> {
    const planPending = await this.deps.approvalFlow.findPending(session);
    if (planPending) return { planPending, pendingScope: null, applyAnchor: null, override: null, pending: planPending };
    const pendingScope = await this.deps.scopeClarificationFlow.findPending(session, held);
    if (pendingScope) return { planPending: null, pendingScope, applyAnchor: null, override: null, pending: null };
    const override = (await this.deps.credentialOverrideFlow?.findPending(session, held)) ?? null;
    if (override) {
      const pending =
        override.state === 'awaiting-decision' && override.approval.status === ApprovalStatus.PENDING
          ? override.approval
          : null;
      return { planPending: null, pendingScope: null, applyAnchor: null, override, pending };
    }
    const connectorWrite = (await this.deps.connectorWriteFlow?.find(session, held)) ?? null;
    if (connectorWrite) {
      const pending =
        connectorWrite.anchor.status === 'APPROVAL_PENDING' && connectorWrite.approval?.status === ApprovalStatus.PENDING
          ? connectorWrite.approval
          : null;
      return { planPending: null, pendingScope: null, applyAnchor: null, override: null, connectorWrite, pending };
    }
    const applyAnchor = await this.deps.applyPreviewFlow.findAnchor(session, held);
    const approvalId = applyAnchor ? pendingApprovalIdOf(applyAnchor) : undefined;
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

  /**
   * Record an expired PENDING approval as denied (ADR-0093) through the existing `ApprovalManager.decide`:
   * `decidedBy: 'system'` (the system-attribution convention), comment `expired`, `decidedAt` from the shared clock.
   * An anchor-scoped approval also moves its anchor back exactly like a denial, so the expired request can never be
   * approved and the earlier state (e.g. WORKSPACE_APPLIED) survives.
   *
   * Runs under the approval's and the session's locks and re-reads the approval first: when another transition (a UI
   * decision, a reset) already moved it off `PENDING`, nothing is recorded and `false` is returned — the caller's
   * lookup is stale and must be re-derived.
   */
  expire(session: Session, lookup: PendingApprovalLookup): Promise<boolean> {
    const approval = lookup.pending;
    if (!approval) return Promise.resolve(false);
    return this.exclusive(approval.id, session.id, async (held) => {
      if (this.isSettledByOpsUi(approval.id) || (await this.freshPending(approval.id)) === null) return false;
      await this.expireUnlocked(session, lookup, held);
      return true;
    });
  }

  /** The expiry body; callers hold the approval's lock and the session lock (`held`), and checked it is still PENDING. */
  private async expireUnlocked(session: Session, lookup: PendingApprovalLookup, held: SessionLockHold | undefined): Promise<void> {
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
      await this.deps.credentialOverrideFlow?.invalidate(session, 'expired', 'system', held);
    } else if (lookup.connectorWrite) {
      // ADR-0112: an expired connector-write approval closes its anchor; nothing is sent.
      await this.deps.connectorWriteFlow?.close(session, lookup.connectorWrite, 'expired', this.clock(), held);
    } else if (!lookup.planPending && lookup.applyAnchor) {
      const released = anchorAfterRejection(lookup.applyAnchor);
      if (released) await this.deps.applyPreviewFlow.anchor(session, released, held);
      else await this.deps.applyPreviewFlow.clear(session, held);
    }
    this.deps.logger.info('pending approval expired', { approvalId: approval.id, sessionId: session.id });
  }

  /**
   * The expiry re-check before a positive decision found the approval expired: record the same `system`/`expired`
   * denial (and anchor release) as the turn-start path and answer with the expiry notice. `override` (ADR-0097): the
   * credential-override set `approval` belongs to, released exactly like turn-start expiry. Callers hold the lock.
   */
  private async recordExpiryBeforeApprove(
    context: ConversationContext,
    session: Session,
    approval: ApprovalRequest,
    applyAnchor: ApplyPreviewAnchor | null,
    override: CredentialOverrideLookup | null,
    held: SessionLockHold | undefined,
  ): Promise<ApprovalDecisionReply> {
    await this.expireUnlocked(
      session,
      { planPending: applyAnchor || override ? null : approval, pendingScope: null, applyAnchor, override, pending: approval },
      held,
    );
    const reply = this.deps.composer.composeApprovalExpired(context, approval, PENDING_APPROVAL_TTL_MS);
    await this.deps.memory.recordAssistant(reply.text, context, session.id);
    return { status: 'DENIED', reply };
  }

  /**
   * Re-check the 30-minute lifetime (ADR-0093) with the shared clock IMMEDIATELY before a positive decision. When
   * expired it records the expiry denial and returns the expiry-notice reply; otherwise `null` and the caller approves.
   * The deadline check is SYNCHRONOUS, so no yield point separates it from `approvals.decide`.
   */
  private expiredBeforeApprove(
    input: ApprovalDecisionInput,
    approval: ApprovalRequest,
    applyAnchor: ApplyPreviewAnchor | null,
  ): Promise<ApprovalDecisionReply> | null {
    if (this.remainingMs(approval) > 0) return null;
    return this.recordExpiryBeforeApprove(input.context, input.session, approval, applyAnchor, null, input.held);
  }

  // ── serialization ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Run `work` after every earlier transition of the same approval id has finished (in-process, single instance). */
  serialize<T>(approvalId: Id | undefined, work: () => Promise<T>): Promise<T> {
    if (approvalId === undefined || approvalId === '') return work();
    return this.approvalLock.run(approvalId, () => work());
  }

  /**
   * The approval's lock, then the shared session write lock (the one acquisition order every path uses); `work` gets
   * the session hold and MUST pass it to every session writer it calls.
   */
  private exclusive<T>(approvalId: Id | undefined, sessionId: Id, work: (held: SessionLockHold) => Promise<T>): Promise<T> {
    return this.serialize(approvalId, () => this.sessionLock.run(sessionId, work));
  }

  /** The approval re-read inside the lock, or null when it is gone or no longer PENDING (never trust a caller's copy). */
  private async freshPending(approvalId: Id): Promise<ApprovalRequest | null> {
    const current = await this.deps.approvals.get(approvalId);
    return current?.status === ApprovalStatus.PENDING ? current : null;
  }

  /** Whether the operations UI already decided this approval (a racing chat turn must not decide it again). */
  isSettledByOpsUi(approvalId: Id | undefined): boolean {
    return approvalId !== undefined && this.settledByOpsUi.has(approvalId);
  }

  /**
   * The chat answer when another transition (the UI, an expiry, a reset) decided first: the existing "nothing to
   * decide" reply; nothing is decided.
   */
  private async lostToOpsUi(input: ApprovalDecisionInput): Promise<ApprovalDecisionReply> {
    const reply = this.deps.composer.composeNoPendingDecision(input.context);
    await this.deps.memory.recordAssistant(reply.text, input.context, input.session.id);
    return { status: 'RESPONDED', reply };
  }

  private decisionOf(approvalId: Id, input: ApprovalDecisionInput, approved: boolean): ApprovalDecision {
    return {
      approvalId,
      approved,
      decidedBy: input.actor.id,
      decidedAt: now(),
      ...(input.surface === 'ops-ui' ? { comment: OPS_UI_DECISION_SURFACE } : {}),
    };
  }

  private async recorded(
    input: ApprovalDecisionInput,
    reply: OutboundMessage,
    status: RuntimeTurnStatus,
  ): Promise<ApprovalDecisionReply> {
    await this.deps.memory.recordAssistant(reply.text, input.context, input.session.id);
    return { status, reply };
  }

  // ── (A) the plan-scoped approval (ADR-0032) ────────────────────────────────────────────────────────────────────

  /**
   * Approve: reconstruct FIRST — never record a decision we cannot act on (CA review); only once the halted execution
   * is recoverable is the expiry re-checked and the decision recorded. The resume itself (orchestrator + the ADR-0038
   * code-generation preview) stays in the runtime: chat only.
   */
  approvePlan(input: ApprovalDecisionInput, pending: ApprovalRequest): Promise<PlanApproveResult> {
    return this.exclusive(pending.id, input.session.id, async (held): Promise<PlanApproveResult> => {
      input = { ...input, held };
      if (this.isSettledByOpsUi(pending.id) || (await this.freshPending(pending.id)) === null) {
        return { kind: 'reply', value: await this.lostToOpsUi(input) };
      }
      const ctx = await this.deps.approvalFlow.reconstructResume(input.session, pending);
      if (!ctx) {
        // Can't reconstruct — fail safe: re-ask, and do NOT call ApprovalManager.decide.
        const reply = this.deps.composer.composeApprovalNotice(input.context, pending);
        return { kind: 'reply', value: await this.recorded(input, reply, 'AWAITING_APPROVAL') };
      }
      const expired = this.expiredBeforeApprove(input, pending, null);
      if (expired) return { kind: 'reply', value: await expired };
      await this.deps.approvals.decide(pending.id, this.decisionOf(pending.id, input, true));
      return { kind: 'resume', request: ctx.request, prior: ctx.prior };
    });
  }

  /** Deny / cancel — record the (rejecting) decision; never resume. */
  rejectPlan(input: ApprovalDecisionInput, pending: ApprovalRequest, verdict: 'deny' | 'cancel'): Promise<ApprovalDecisionReply> {
    return this.exclusive(pending.id, input.session.id, (held) => this.rejectPlanUnlocked({ ...input, held }, pending, verdict));
  }

  private async rejectPlanUnlocked(
    input: ApprovalDecisionInput,
    pending: ApprovalRequest,
    verdict: 'deny' | 'cancel',
  ): Promise<ApprovalDecisionReply> {
    if (this.isSettledByOpsUi(pending.id) || (await this.freshPending(pending.id)) === null) return this.lostToOpsUi(input);
    await this.deps.approvals.decide(pending.id, this.decisionOf(pending.id, input, false));
    const status: RuntimeTurnStatus = verdict === 'deny' ? 'DENIED' : 'CANCELLED';
    const replyStatus: ExecutionReplyStatus = verdict === 'deny' ? 'DENIED' : 'CANCELLED';
    const reply = this.deps.composer.composeExecutionResult(input.context, replyStatus);
    return this.recorded(input, reply, status);
  }

  // ── (A2b) the credential override (ADR-0097): the deny path ────────────────────────────────────────────────────

  /**
   * Deny: an awaiting-decision request is recorded rejected, then the whole set is invalidated (`denied`, by the
   * owner). Its approve is the dedicated send phrase, which dispatches in the same turn — chat only.
   */
  rejectCredentialOverride(
    input: ApprovalDecisionInput,
    override: Extract<CredentialOverrideLookup, { state: 'awaiting-decision' | 'ready' }>,
  ): Promise<ApprovalDecisionReply> {
    const approvalId = override.state === 'awaiting-decision' ? override.approval.id : undefined;
    return this.exclusive(approvalId, input.session.id, (held) => this.rejectCredentialOverrideUnlocked({ ...input, held }, override));
  }

  private async rejectCredentialOverrideUnlocked(
    input: ApprovalDecisionInput,
    override: Extract<CredentialOverrideLookup, { state: 'awaiting-decision' | 'ready' }>,
  ): Promise<ApprovalDecisionReply> {
    const flow = this.deps.credentialOverrideFlow!; // a lookup exists only when the flow is wired
    const grant = override.state === 'awaiting-decision' ? override.grant : override.anchor.grants.at(-1);
    const path = grant?.path ?? '';
    if (override.state === 'awaiting-decision') {
      if (this.isSettledByOpsUi(override.approval.id) || (await this.freshPending(override.approval.id)) === null) {
        return this.lostToOpsUi(input);
      }
      await this.deps.approvals.decide(override.approval.id, {
        approvalId: override.approval.id,
        approved: false,
        decidedBy: input.actor.id,
        decidedAt: this.clock(),
        comment: input.surface === 'ops-ui' ? `${CREDENTIAL_OVERRIDE_DENY_COMMENT};${OPS_UI_DECISION_SURFACE}` : CREDENTIAL_OVERRIDE_DENY_COMMENT,
      });
    }
    const result = await flow.invalidate(input.session, 'denied', input.actor.id, input.held);
    this.deps.logger.info('credential guard override denied', { sessionId: input.session.id });
    const reply = result?.state === 'consumed'
      ? this.deps.composer.composeCredentialOverrideAlreadyUsed(input.context)
      : this.deps.composer.composeCredentialOverrideDenied(input.context, path);
    return this.recorded(input, reply, 'DENIED');
  }

  /**
   * The send phrase on an awaiting-decision override (ADR-0097 D3), under the same locks as its deny and the UI's
   * reject: re-read the request (a request another transition decided is never approved), re-check the whole set's
   * expiry — it expires with its OLDEST override (D5) — synchronously right before `decide`, record the approval and
   * the grant. The dispatch that follows (the runtime's) runs only on a grant this call recorded.
   */
  approveCredentialOverride(
    input: ApprovalDecisionInput,
    override: Extract<CredentialOverrideLookup, { state: 'awaiting-decision' }>,
  ): Promise<CredentialOverrideSendResult> {
    const approval = override.approval;
    return this.exclusive(approval.id, input.session.id, async (held): Promise<CredentialOverrideSendResult> => {
      input = { ...input, held };
      const flow = this.deps.credentialOverrideFlow!; // a lookup exists only when the flow is wired
      if (this.isSettledByOpsUi(approval.id) || (await this.freshPending(approval.id)) === null) {
        return { kind: 'reply', value: await this.lostToOpsUi(input) };
      }
      const earlier: ApprovalRequest[] = [];
      for (const g of override.anchor.grants) {
        if (g.approvalRequestId === approval.id) continue;
        const r = await this.deps.approvals.get(g.approvalRequestId);
        if (r) earlier.push(r);
      }
      if (Math.min(this.remainingMs(approval), ...earlier.map((r) => this.remainingMs(r))) <= 0) {
        return {
          kind: 'reply',
          value: await this.recordExpiryBeforeApprove(input.context, input.session, approval, null, override, held),
        };
      }
      await this.deps.approvals.decide(approval.id, {
        approvalId: approval.id,
        approved: true,
        decidedBy: input.actor.id,
        decidedAt: this.clock(),
        comment: CREDENTIAL_OVERRIDE_APPROVE_COMMENT,
      });
      return { kind: 'granted', granted: await flow.recordGrant(input.session, approval.id, held) };
    });
  }

  /**
   * Close a still-PENDING request as rejected (a stray override request, ADR-0097 D5), under its lock; one another
   * transition already decided is kept. Returns whether it closed it.
   */
  closeIfPending(approvalId: Id, decidedBy: string, comment: string): Promise<boolean> {
    return this.serialize(approvalId, async () => {
      if ((await this.freshPending(approvalId)) === null) return false;
      await this.deps.approvals.decide(approvalId, { approvalId, approved: false, decidedBy, decidedAt: this.clock(), comment });
      return true;
    });
  }

  // ── (A2d) the conversation reset (ADR-0093) ────────────────────────────────────────────────────────────────────

  /**
   * Reset: invalidate a credential-override set (`reset`, by the owner — BEFORE the close, ADR-0097 D5), record a
   * still-PENDING approval rejected (`decidedBy` = the owner, comment `reset`) and close the session — all under the
   * pending approval's lock and the session's lock, so a UI decision racing it either finished first (the reset then
   * finds nothing pending and only closes) or runs after it and finds the approval decided and the conversation
   * closed (it never re-anchors it). Returns whether this reset denied the approval.
   */
  resetConversation(session: Session, actor: Actor, pending: ApprovalRequest | null): Promise<{ deniedPendingApproval: boolean }> {
    return this.exclusive(pending?.id, session.id, async (held) => {
      await this.deps.credentialOverrideFlow?.invalidate(session, 'reset', actor.id, held);
      let deniedPendingApproval = false;
      if (pending && !this.isSettledByOpsUi(pending.id) && (await this.freshPending(pending.id)) !== null) {
        await this.deps.approvals.decide(pending.id, {
          approvalId: pending.id,
          approved: false,
          decidedBy: actor.id,
          decidedAt: this.clock(),
          comment: 'reset',
        });
        deniedPendingApproval = true;
      }
      await this.deps.sessions.close(session, held);
      return { deniedPendingApproval };
    });
  }

  // ── (A2c) the connector write (ADR-0112) ────────────────────────────────────────────────────────────────────────

  /**
   * An APPROVAL_PENDING connector write decided: approve records the approval and moves the anchor to APPROVED (the
   * write runs only on its exact chat execution phrase); deny/cancel record the rejection and close the anchor.
   */
  decideConnectorWrite(
    input: ApprovalDecisionInput,
    view: ConnectorWriteAnchorView,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    return this.exclusive(view.approval?.id, input.session.id, (held) =>
      this.decideConnectorWriteUnlocked({ ...input, held }, view, verdict),
    );
  }

  private async decideConnectorWriteUnlocked(
    input: ApprovalDecisionInput,
    view: ConnectorWriteAnchorView,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const flow = this.deps.connectorWriteFlow!;
    const { anchor } = view;
    const approval = view.approval!;
    const history = anchor.family === 'calendar' ? CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE : undefined;
    if (this.isSettledByOpsUi(approval.id) || (await this.freshPending(approval.id)) === null) return this.lostToOpsUi(input);
    if (verdict === 'approve') {
      // ADR-0093 expiry re-check, synchronous, immediately before the positive decision.
      if (this.remainingMs(approval) <= 0) {
        await this.expireUnlocked(
          input.session,
          { planPending: null, pendingScope: null, applyAnchor: null, override: null, connectorWrite: view, pending: approval },
          input.held,
        );
        const reply = this.deps.composer.composeApprovalExpired(input.context, approval, PENDING_APPROVAL_TTL_MS);
        return this.connectorWriteReply(input.context, input.session.id, reply, 'DENIED', history);
      }
      await this.deps.approvals.decide(approval.id, this.decisionOf(approval.id, input, true));
      const step = await flow.recordApproval({
        session: input.session,
        actor: input.actor,
        view,
        now: this.clock(),
        ...(input.held ? { held: input.held } : {}),
      });
      return this.connectorWriteStepReply(input.context, input.session.id, step, '', history);
    }
    await this.deps.approvals.decide(approval.id, this.decisionOf(approval.id, input, false));
    const reason = verdict === 'deny' ? 'denied' : 'cancelled';
    await flow.close(input.session, view, reason, this.clock(), input.held);
    return this.connectorWriteStepReply(input.context, input.session.id, { kind: 'closed', reason, family: anchor.family }, '', history);
  }

  /**
   * Run an APPROVED connector write (its exact phrase). The flow validates and consumes the grant inside the SAME
   * approval → session locks a revocation takes (Codex P1 on 55c5a2f), on the live anchor and approval, then sends
   * outside them. A withdrawn grant is refused truthfully; a started one is reported, never re-sent.
   */
  executeConnectorWrite(input: ApprovalDecisionInput, view: ConnectorWriteAnchorView): Promise<ConnectorWriteStep> {
    const flow = this.deps.connectorWriteFlow!;
    return flow.execute({
      session: input.session,
      actor: input.actor,
      view,
      now: this.clock(),
      claim: (work) => this.exclusive(view.anchor.approvalId, input.session.id, work),
    });
  }

  /**
   * Live QA session 3 (D12): the owner's "거절"/"취소" after a connector write was APPROVED but before it ran. Under the
   * approval → session locks (the ones execution's claim takes): re-read the anchor; only an APPROVED, unconsumed grant
   * is withdrawn (approval APPROVED → REJECTED, `ApprovalManager.revoke`) and closed. If execution already started, the
   * reply says so (the outcome is reported by that turn) — never "nothing was sent"; if it already finished, the
   * recorded outcome answers; if it was closed meanwhile, the "nothing to decide" reply answers. Runs nothing.
   */
  revokeConnectorWrite(
    input: ApprovalDecisionInput,
    view: ConnectorWriteAnchorView,
    reason: 'denied' | 'cancelled',
  ): Promise<ApprovalDecisionReply> {
    return this.exclusive(view.anchor.approvalId, input.session.id, async (held) => {
      const flow = this.deps.connectorWriteFlow!;
      const { anchor } = view;
      const history = anchor.family === 'calendar' ? CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE : undefined;
      const live = await flow.find(input.session, held);
      if (!live || live.taskId !== view.taskId || live.anchor.approvalId !== anchor.approvalId) {
        return this.lostToOpsUi({ ...input, held });
      }
      const operation = live.anchor.operation;
      if (operation && (live.anchor.consumedAt || live.anchor.status !== 'APPROVED')) {
        const status = live.anchor.status;
        if (status === 'EXECUTING') {
          const reply = this.deps.composer.composeConnectorWriteRevokeTooLate(input.context, operation);
          return this.connectorWriteReply(input.context, input.session.id, reply, 'RESPONDED', history);
        }
        if (status === 'SENT' || status === 'NOT_SENT' || status === 'UNCERTAIN') {
          const repeat = { kind: 'repeat', operation, status, ...outcomeLinkOf(live.anchor) } as const;
          return this.connectorWriteStepReply(input.context, input.session.id, repeat, '', history);
        }
        return this.lostToOpsUi({ ...input, held });
      }
      const approvalId = live.anchor.approvalId;
      if (approvalId && this.deps.approvals.revoke) {
        const approval = await this.deps.approvals.get(approvalId);
        if (approval?.status === ApprovalStatus.APPROVED) {
          await this.deps.approvals.revoke(approvalId, {
            ...this.decisionOf(approvalId, input, false),
            comment: APPROVAL_REVOKED_COMMENT,
          });
          // Live QA session 4 (N1): the withdrawal is audited in the log like every other decision (content-free).
          this.deps.logger.info('approval decided', {
            approvalId,
            surface: input.surface,
            kind: 'CONNECTOR_WRITE',
            outcome: 'REVOKED',
          });
        }
      }
      await flow.close(input.session, live, reason, this.clock(), held);
      return this.connectorWriteStepReply(input.context, input.session.id, { kind: 'closed', reason, family: anchor.family }, '', history);
    });
  }

  /** Compose a connector-write step reply and record it (a calendar step keeps the fixed note in history). */
  async connectorWriteStepReply(
    context: ConversationContext,
    sessionId: Id,
    step: ConnectorWriteStep,
    fallbackText: string,
    history?: string,
  ): Promise<ApprovalDecisionReply> {
    if (step.kind === 'writes-off') {
      const text = fallbackText.length > 0 ? fallbackText : this.deps.composer.composeNoApprovedConnectorWrite(context).text;
      return this.connectorWriteReply(context, sessionId, { context, text }, 'RESPONDED', history);
    }
    const reply = this.deps.composer.composeConnectorWriteStep(context, step);
    const status: RuntimeTurnStatus =
      step.kind === 'preview'
        ? 'AWAITING_APPROVAL'
        : step.kind === 'closed'
          ? step.reason === 'denied'
            ? 'DENIED'
            : 'CANCELLED'
          : 'RESPONDED';
    // A calendar step keeps the fixed write note (never event text); the handler's own note covers only its fallback.
    const calendar = isCalendarWriteStep(step);
    return this.connectorWriteReply(context, sessionId, reply, status, calendar ? CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE : history);
  }

  /** Record a connector-write reply (or its fixed history note) and return it with its status. */
  async connectorWriteReply(
    context: ConversationContext,
    sessionId: Id,
    reply: OutboundMessage,
    status: RuntimeTurnStatus,
    history?: string,
  ): Promise<ApprovalDecisionReply> {
    await this.deps.memory.recordAssistant(history ?? reply.text, context, sessionId);
    return { status, reply };
  }

  // ── (A3) the anchored code-change chain (apply, commit, push, PR, merge, remote branch cleanup) ──────────────────

  /**
   * The strict pending-context integrity guard each anchored decision ran BEFORE interpreting the message (CA #2/#9/#14):
   * a pending gate is valid only with its COMPLETE resume context. Returns the safe-failure reply (no decide, no git,
   * no re-anchor), or `null` when the context is complete (synchronously, so a complete context costs no yield).
   */
  incompleteAnchoredContext(
    context: ConversationContext,
    session: Session,
    anchor: ApplyPreviewAnchor,
  ): Promise<ApprovalDecisionReply> | null {
    switch (anchor.status) {
      case 'COMMIT_APPROVAL_PENDING':
        if (
          !anchor.commitApprovalId ||
          !anchor.proposedCommitMessage ||
          !anchor.commitCandidateFiles?.length ||
          !anchor.workspaceRef ||
          !anchor.workspaceChangeRef ||
          !anchor.executionPlanRef
        ) {
          return this.anchoredUnavailable(context, session, anchor, 'commit', 'pending commit approval context incomplete');
        }
        return null;
      case 'PUSH_APPROVAL_PENDING':
        if (
          !anchor.pushApprovalId ||
          !anchor.pushCommitHash ||
          !anchor.pushRemote ||
          !anchor.pushBranch ||
          !anchor.pushUpstreamRef ||
          !anchor.commitHash ||
          !anchor.workspaceRef ||
          !anchor.executionPlanRef
        ) {
          return this.anchoredUnavailable(context, session, anchor, 'push', 'pending push approval context incomplete');
        }
        return null;
      case 'PR_APPROVAL_PENDING':
        if (
          !anchor.prApprovalId ||
          !anchor.prPushedCommitHash ||
          !anchor.prHeadBranch ||
          !anchor.prBaseBranch ||
          !anchor.prTitle ||
          !anchor.workspaceRef ||
          !anchor.executionPlanRef
        ) {
          return this.anchoredUnavailable(context, session, anchor, 'pr', 'pending PR approval context incomplete');
        }
        return null;
      case 'MERGE_APPROVAL_PENDING':
        if (!anchor.mergeApprovalId || !anchor.executionPlanRef) {
          return this.anchoredUnavailable(context, session, anchor, 'pr', 'pending merge approval context incomplete');
        }
        return null;
      case 'REMOTE_BRANCH_CLEANUP_PENDING':
        if (!anchor.remoteBranchCleanupApprovalId || !anchor.executionPlanRef) {
          return this.anchoredUnavailable(
            context,
            session,
            anchor,
            'pr',
            'pending remote branch cleanup approval context incomplete',
          );
        }
        return null;
      default:
        return null;
    }
  }

  /** Decide the anchored chain's pending gate (after the integrity guard and the runtime's text interpretation). */
  decideAnchored(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    return this.exclusive(pendingApprovalIdOf(anchor), input.session.id, (held) =>
      this.decideAnchoredUnlocked({ ...input, held }, anchor, verdict),
    );
  }

  private async decideAnchoredUnlocked(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    if (this.isSettledByOpsUi(pendingApprovalIdOf(anchor))) return this.lostToOpsUi(input);
    switch (anchor.status) {
      case 'AWAITING_APPROVAL':
        return this.decideApply(input, anchor, verdict);
      case 'COMMIT_APPROVAL_PENDING':
        return this.decideCommit(input, anchor, verdict);
      case 'PUSH_APPROVAL_PENDING':
        return this.decidePush(input, anchor, verdict);
      case 'PR_APPROVAL_PENDING':
        return this.decidePr(input, anchor, verdict);
      case 'MERGE_APPROVAL_PENDING':
        return this.decideMerge(input, anchor, verdict);
      case 'REMOTE_BRANCH_CLEANUP_PENDING':
        return this.decideRemoteBranchCleanup(input, anchor, verdict);
      default:
        throw new Error(`no pending approval gate at anchor status ${anchor.status}`);
    }
  }

  /** Sprint 2s (ADR-0040): the apply approval. Approve re-anchors APPROVED (no patch, no write); deny/cancel clear. */
  private async decideApply(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const approved = verdict === 'approve';
    // Re-read inside the lock: an apply approval another transition already decided is never decided again.
    const request = await this.freshPending(anchor.approvalId!);
    if (request === null) return this.lostToOpsUi(input);
    if (approved) {
      const expired = this.expiredBeforeApprove(input, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(anchor.approvalId!, this.decisionOf(anchor.approvalId!, input, approved));

    if (!approved) {
      // deny / cancel — nothing left to preserve.
      await this.deps.applyPreviewFlow.clear(input.session, input.held);
      const replyStatus: ExecutionReplyStatus = verdict === 'deny' ? 'DENIED' : 'CANCELLED';
      const reply = this.deps.composer.composeExecutionResult(input.context, replyStatus);
      return this.recorded(input, reply, verdict === 'deny' ? 'DENIED' : 'CANCELLED');
    }

    // approve — Sprint 2s stops here (no Patch/WorkspaceWrite/CommandExecution/git call), but the approved context MUST
    // survive for the apply sprint. Re-anchor (never clear): every ref this anchor carries is exactly what it needs.
    await this.deps.applyPreviewFlow.anchor(input.session, { ...anchor, status: 'APPROVED', approvedAt: now() }, input.held);
    const reply = this.deps.composer.composeApplyApprovalRecorded(input.context);
    return this.recorded(input, reply, 'RESPONDED');
  }

  /** Sprint 2x (ADR-0045): the commit approval. Approve records only (COMMIT_APPROVED); deny/cancel → WORKSPACE_APPLIED. */
  private async decideCommit(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const approvalId = anchor.commitApprovalId!;
    // (CA #3) verify the referenced ApprovalRequest before deciding: exists, PENDING, same plan.
    const request = await this.deps.approvals.get(approvalId);
    if (!request || request.status !== ApprovalStatus.PENDING || request.executionPlanRef.id !== anchor.executionPlanRef.id) {
      return this.anchoredUnavailable(input.context, input.session, anchor, 'commit', 'commit approval request missing/mismatched');
    }
    const approved = verdict === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(input, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(approvalId, this.decisionOf(approvalId, input, approved));
    if (!approved) {
      // (CA #9/#11) deny/cancel: the applied workspace state MUST survive → revert to WORKSPACE_APPLIED, clearing ONLY
      // the commit fields; use a COMMIT-SPECIFIC reply (never generic composeExecutionResult).
      await this.deps.applyPreviewFlow.anchor(input.session, {
        ...anchor,
        status: 'WORKSPACE_APPLIED',
        commitApprovalId: undefined,
        proposedCommitMessage: undefined,
        commitCandidateFiles: undefined,
      }, input.held);
      const reply =
        verdict === 'deny'
          ? this.deps.composer.composeCommitApprovalDenied(input.context)
          : this.deps.composer.composeCommitApprovalCancelled(input.context);
      return this.recorded(input, reply, verdict === 'deny' ? 'DENIED' : 'CANCELLED');
    }
    // approve — records only; the git commit runs on the exact execution phrase. Preserve full context.
    await this.deps.applyPreviewFlow.anchor(input.session, { ...anchor, status: 'COMMIT_APPROVED' }, input.held);
    const reply = this.deps.composer.composeCommitApprovalRecorded(input.context);
    return this.recorded(input, reply, 'RESPONDED');
  }

  /** Sprint 2z (ADR-0047): the push approval. Approve records only (PUSH_APPROVED); deny/cancel → GIT_COMMITTED. */
  private async decidePush(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const approvalId = anchor.pushApprovalId!;
    // (CA #9) verify the referenced ApprovalRequest before deciding: exists, PENDING, same plan.
    const request = await this.deps.approvals.get(approvalId);
    if (!request || request.status !== ApprovalStatus.PENDING || request.executionPlanRef.id !== anchor.executionPlanRef.id) {
      return this.anchoredUnavailable(input.context, input.session, anchor, 'push', 'push approval request missing/mismatched');
    }
    const approved = verdict === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(input, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(approvalId, this.decisionOf(approvalId, input, approved));
    if (!approved) {
      // (Constraint 5) deny/cancel: the local commit MUST survive → revert to GIT_COMMITTED, clearing ONLY the push
      // fields; commit context preserved. NO git push.
      await this.deps.applyPreviewFlow.anchor(input.session, {
        ...anchor,
        status: 'GIT_COMMITTED',
        pushApprovalId: undefined,
        pushCommitHash: undefined,
        pushRemote: undefined,
        pushBranch: undefined,
        pushUpstreamRef: undefined,
        pushMode: undefined,
        pushRepositoryIdentity: undefined,
      }, input.held);
      const reply =
        verdict === 'deny'
          ? this.deps.composer.composePushApprovalDenied(input.context)
          : this.deps.composer.composePushApprovalCancelled(input.context);
      return this.recorded(input, reply, verdict === 'deny' ? 'DENIED' : 'CANCELLED');
    }
    // approve — records only; (CA #8) PRESERVE all push + commit context. NO git push.
    await this.deps.applyPreviewFlow.anchor(input.session, { ...anchor, status: 'PUSH_APPROVED' }, input.held);
    const reply = this.deps.composer.composePushApprovalRecorded(input.context);
    return this.recorded(input, reply, 'RESPONDED');
  }

  /** Sprint 3b (ADR-0049): the PR approval. Approve records only (PR_APPROVED); deny/cancel → GIT_PUSHED. */
  private async decidePr(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const approvalId = anchor.prApprovalId!;
    // (CA #14) verify the referenced ApprovalRequest before deciding: exists, PENDING, same plan.
    const request = await this.deps.approvals.get(approvalId);
    if (!request || request.status !== ApprovalStatus.PENDING || request.executionPlanRef.id !== anchor.executionPlanRef.id) {
      return this.anchoredUnavailable(input.context, input.session, anchor, 'pr', 'PR approval request missing/mismatched');
    }
    const approved = verdict === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(input, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(approvalId, this.decisionOf(approvalId, input, approved));
    if (!approved) {
      // (CA #15) deny/cancel: revert to GIT_PUSHED, clear ONLY the PR fields; pushed/commit/workspace preserved.
      await this.deps.applyPreviewFlow.anchor(input.session, {
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
      }, input.held);
      const reply =
        verdict === 'deny'
          ? this.deps.composer.composePrApprovalDenied(input.context)
          : this.deps.composer.composePrApprovalCancelled(input.context);
      return this.recorded(input, reply, verdict === 'deny' ? 'DENIED' : 'CANCELLED');
    }
    // approve — record only; re-anchor PR_APPROVED PRESERVING all context (CA #16). NO PR creation.
    await this.deps.applyPreviewFlow.anchor(input.session, { ...anchor, status: 'PR_APPROVED' }, input.held);
    const reply = this.deps.composer.composePrApprovalRecorded(input.context);
    return this.recorded(input, reply, 'RESPONDED');
  }

  /** Sprint 3f (ADR-0056): the merge approval. Approve records only (MERGE_APPROVED); deny/cancel → PR_CREATED. */
  private async decideMerge(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const approvalId = anchor.mergeApprovalId!;
    // Verify the referenced ApprovalRequest via STRUCTURED fields only — never parse reason.
    const request = await this.deps.approvals.get(approvalId);
    if (!request || request.status !== ApprovalStatus.PENDING || request.executionPlanRef.id !== anchor.executionPlanRef.id) {
      return this.anchoredUnavailable(input.context, input.session, anchor, 'pr', 'merge approval request missing/mismatched');
    }
    const approved = verdict === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(input, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(approvalId, this.decisionOf(approvalId, input, approved));
    if (!approved) {
      // Deny/cancel → back to PR_CREATED, clear ONLY merge fields; PR/push/commit/workspace preserved.
      await this.deps.applyPreviewFlow.anchor(input.session, {
        ...anchor,
        status: 'PR_CREATED',
        mergeApprovalId: undefined,
        mergeApprovalRequestedAt: undefined,
        mergeApprovedAt: undefined,
        mergeApprovalDecisionBy: undefined,
      }, input.held);
      const reply =
        verdict === 'deny'
          ? this.deps.composer.composeMergeApprovalDenied(input.context)
          : this.deps.composer.composeMergeApprovalCancelled(input.context);
      return this.recorded(input, reply, verdict === 'deny' ? 'DENIED' : 'CANCELLED');
    }
    // approve — record only; re-anchor MERGE_APPROVED preserving all context. NO merge.
    await this.deps.applyPreviewFlow.anchor(input.session, {
      ...anchor,
      status: 'MERGE_APPROVED',
      mergeApprovedAt: now(),
      mergeApprovalDecisionBy: input.actor.id,
    }, input.held);
    const reply = this.deps.composer.composeMergeApprovalRecorded(input.context);
    return this.recorded(input, reply, 'RESPONDED');
  }

  /** Sprint 3j-A (ADR-0060): the remote-branch-cleanup approval. Approve records only; deny/cancel → BRANCH_CLEANED. */
  private async decideRemoteBranchCleanup(
    input: ApprovalDecisionInput,
    anchor: ApplyPreviewAnchor,
    verdict: ApprovalDecisionVerdict,
  ): Promise<ApprovalDecisionReply> {
    const approvalId = anchor.remoteBranchCleanupApprovalId!;
    // Verify the referenced ApprovalRequest via STRUCTURED fields only — never parse reason.
    const request = await this.deps.approvals.get(approvalId);
    if (!request || request.status !== ApprovalStatus.PENDING || request.executionPlanRef.id !== anchor.executionPlanRef.id) {
      return this.anchoredUnavailable(
        input.context,
        input.session,
        anchor,
        'pr',
        'remote branch cleanup approval request missing/mismatched',
      );
    }
    const approved = verdict === 'approve';
    if (approved) {
      const expired = this.expiredBeforeApprove(input, request, anchor);
      if (expired) return await expired;
    }
    await this.deps.approvals.decide(approvalId, this.decisionOf(approvalId, input, approved));
    if (!approved) {
      // Deny/cancel → back to BRANCH_CLEANED, clearing ONLY the four remote-cleanup approval fields (CA change 7).
      await this.deps.applyPreviewFlow.anchor(input.session, {
        ...anchor,
        status: 'BRANCH_CLEANED',
        remoteBranchCleanupApprovalId: undefined,
        remoteBranchCleanupApprovalRequestedAt: undefined,
        remoteBranchCleanupApprovedAt: undefined,
        remoteBranchCleanupApprovalDecisionBy: undefined,
      }, input.held);
      const reply =
        verdict === 'deny'
          ? this.deps.composer.composeRemoteBranchCleanupDenied(input.context)
          : this.deps.composer.composeRemoteBranchCleanupCancelled(input.context);
      return this.recorded(input, reply, verdict === 'deny' ? 'DENIED' : 'CANCELLED');
    }
    // approve — record only; re-anchor REMOTE_BRANCH_CLEANUP_APPROVED preserving all context. NO remote deletion.
    await this.deps.applyPreviewFlow.anchor(input.session, {
      ...anchor,
      status: 'REMOTE_BRANCH_CLEANUP_APPROVED',
      remoteBranchCleanupApprovedAt: now(),
      remoteBranchCleanupApprovalDecisionBy: input.actor.id,
    }, input.held);
    const reply = this.deps.composer.composeRemoteBranchCleanupRecorded(input.context);
    return this.recorded(input, reply, 'RESPONDED');
  }

  /** Log the content-free failure line (the same lines the runtime logs) and answer with the gate's unavailable reply. */
  private async anchoredUnavailable(
    context: ConversationContext,
    session: Session,
    anchor: ApplyPreviewAnchor,
    family: AnchoredFailureFamily,
    reason: string,
  ): Promise<ApprovalDecisionReply> {
    logAnchoredApprovalFailure(this.deps.logger, family, session, anchor, reason);
    const reply = this.unavailableReply(context, anchor);
    await this.deps.memory.recordAssistant(reply.text, context, session.id);
    return { status: 'FAILED', reply };
  }

  private unavailableReply(context: ConversationContext, anchor: ApplyPreviewAnchor): OutboundMessage {
    switch (anchor.status) {
      case 'COMMIT_APPROVAL_PENDING':
        return this.deps.composer.composeCommitUnavailable(context);
      case 'PUSH_APPROVAL_PENDING':
        return this.deps.composer.composePushApprovalUnavailable(context);
      case 'PR_APPROVAL_PENDING':
        return this.deps.composer.composePrApprovalUnavailable(context);
      case 'MERGE_APPROVAL_PENDING':
        return this.deps.composer.composeMergeApprovalUnavailable(context);
      case 'REMOTE_BRANCH_CLEANUP_PENDING':
        return this.deps.composer.composeRemoteBranchCleanupApprovalUnavailable(context);
      default:
        return this.deps.composer.composeApplyPreviewUnavailable(context);
    }
  }

  // ── the confirmation reference line (chat side) ─────────────────────────────────────────────────────────────────

  /**
   * ADR-0113 D7: the operations UI turns the chat preview reference line on while it is listening, and off when it
   * stops. Off (the default), every chat reply is byte-identical to the pre-OPS-2b runtime.
   */
  setConfirmationReferenceEnabled(enabled: boolean): void {
    this.confirmationReferenceEnabled = enabled;
  }

  get confirmationReferenceShown(): boolean {
    return this.confirmationReferenceEnabled;
  }

  /** The anchored chain's grant binding for a pending gate, or null when the anchor holds no UI-approvable gate. */
  static anchoredBinding(anchor: ApplyPreviewAnchor): ApprovalGrantBinding | null {
    const kind = ANCHORED_KIND[anchor.status];
    if (kind === undefined || kind === 'PLAN' || kind === 'CREDENTIAL_OVERRIDE' || kind === 'CONNECTOR_WRITE') return null;
    return { kind, anchor };
  }

  /**
   * Append the reference line to a chat approval preview (or its pending reminder) when the UI is on; otherwise the
   * reply is returned unchanged. `ownerActorId` is the conversation's actor (the owner, ADR-0091).
   */
  withConfirmationReference(
    reply: OutboundMessage,
    approval: ApprovalRequest,
    binding: ApprovalGrantBinding | null,
    ownerActorId: Id,
  ): OutboundMessage {
    if (!this.confirmationReferenceEnabled || binding === null) return reply;
    const reference = approvalConfirmationReference(
      approval.id,
      approvalBindingDigest(approval, binding),
      ownerActorId,
      approvalReferenceWindow(Date.parse(this.clock())),
    );
    return this.deps.composer.composeApprovalConfirmationReference(reply, reference);
  }

  // ── the operations-UI surface ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Strictly read-only (ADR-0113 D4): the UI-decidable PENDING approval a conversation holds and its decision kind, or
   * null — derived from the flows' read-only peeks, never their `find*` lookups, so nothing is closed, invalidated,
   * cleared or released. A state that looks inconsistent (e.g. approved, `recordApproval` not yet run) is legitimate
   * mid-transition and reads as "nothing pending" here; only the serialized decision transitions reconcile it. A flow
   * without a peek reports nothing (the kind is unknown, never guessed).
   */
  async peekPending(
    session: Session,
  ): Promise<{ readonly approval: ApprovalRequest; readonly kind: ApprovalGateKind; readonly writeActorId?: Id } | null> {
    if (session.status !== SessionStatus.ACTIVE) return null;
    const plan = await this.deps.approvalFlow.findPending(session); // read-only by construction (no anchor writes)
    if (plan) return { approval: plan, kind: 'PLAN' };
    const override = await this.deps.credentialOverrideFlow?.peekPending?.(session);
    if (override && override.status === ApprovalStatus.PENDING) return { approval: override, kind: 'CREDENTIAL_OVERRIDE' };
    const write = await this.deps.connectorWriteFlow?.peek?.(session);
    if (write) {
      if (write.anchor.status !== 'APPROVAL_PENDING' || !write.anchor.operation || !write.approval) return null;
      return { approval: write.approval, kind: 'CONNECTOR_WRITE', writeActorId: write.anchor.actorId };
    }
    const anchor = await this.deps.applyPreviewFlow.peekAnchor?.(session);
    const approvalId = anchor ? pendingApprovalIdOf(anchor) : undefined;
    const kind = anchor ? ANCHORED_KIND[anchor.status] : undefined;
    if (!approvalId || !kind) return null;
    const request = await this.deps.approvals.get(approvalId);
    return request?.status === ApprovalStatus.PENDING ? { approval: request, kind } : null;
  }

  /**
   * The decision kind of every UI-decidable pending approval an ACTIVE conversation in `sessions` holds, keyed by
   * approval id — the same read-only resolution {@link locateForOpsUi} uses, so the UI list and its confirmation page
   * name the same kind (live QA D7). Side-effect free (ADR-0113 D4: a dashboard GET never mutates).
   */
  async pendingGateKindsForOpsUi(sessions: () => Promise<readonly Session[]>): Promise<ReadonlyMap<Id, ApprovalGateKind>> {
    const kinds = new Map<Id, ApprovalGateKind>();
    for (const session of await sessions()) {
      const peeked = await this.peekPending(session);
      if (peeked) kinds.set(peeked.approval.id, peeked.kind);
    }
    return kinds;
  }

  /**
   * Strictly read-only: the metadata the UI's confirmation page shows for a pending approval (never a payload or
   * reference). Uses {@link peekPending}, so a confirmation page GET never mutates (ADR-0113 D4).
   */
  async locateForOpsUi(approvalId: Id, actor: Actor, sessions: () => Promise<readonly Session[]>): Promise<ApprovalSurfaceLocate> {
    const found = await this.peekLocate(approvalId, sessions);
    if (found === null) return { status: 'REFUSED', refusal: 'NOT_FOUND' };
    if (!this.peekOwnedBy(found, actor)) return { status: 'REFUSED', refusal: 'FOREIGN' };
    const { kind, approval } = found;
    return {
      status: 'FOUND',
      view: {
        approvalId,
        kind,
        riskLevel: approval.riskLevel,
        createdAt: approval.createdAt,
        remainingMs: this.remainingMs(approval),
        approvable: UI_APPROVABLE_KINDS.has(kind),
        chat: found.session.context,
      },
    };
  }

  /** The read-only holder of `approvalId` among `sessions`, or null. */
  private async peekLocate(
    approvalId: Id,
    sessions: () => Promise<readonly Session[]>,
  ): Promise<{ session: Session; approval: ApprovalRequest; kind: ApprovalGateKind; writeActorId?: Id } | null> {
    for (const session of await sessions()) {
      const peeked = await this.peekPending(session);
      if (peeked?.approval.id === approvalId) return { session, ...peeked };
    }
    return null;
  }

  private peekOwnedBy(found: { session: Session; writeActorId?: Id }, actor: Actor): boolean {
    if (found.session.actorId !== actor.id) return false;
    return found.writeActorId === undefined || found.writeActorId === actor.id;
  }

  /**
   * Approve or reject from the operations UI (ADR-0113 D7), as the owner Actor with the `ops-ui` marker. Runs the same
   * decision path chat runs for the approval's kind, under the same per-approval serialization; the originating
   * conversation's state ends as it would after the chat decision and the composed reply is recorded into its
   * history. Approve needs the chat preview's confirmation reference; it never executes anything.
   */
  decideFromOpsUi(input: OpsUiDecisionInput): Promise<ApprovalSurfaceDecision> {
    return this.serialize(input.approvalId, async () => {
      // Find the holder read-only (ADR-0113 D4): outside the holder's session write lock nothing may be reconciled.
      const current = await this.deps.approvals.get(input.approvalId);
      if (current === null) return refused('NOT_FOUND');
      if (current.status !== ApprovalStatus.PENDING) return refused('ALREADY_DECIDED');
      const first = await this.peekLocate(input.approvalId, input.sessions);
      if (first === null) return refused('NOT_FOUND');
      if (!this.peekOwnedBy(first, input.actor)) return refused('FOREIGN');
      // The holder is known only now: take its session write lock (approval → session, the order every path uses),
      // then re-read both for THAT session only (never another session's lock while holding this one) — a reset or
      // any other session write that landed meanwhile wins, and nothing stale is re-anchored.
      const holderId = first.session.id;
      return this.sessionLock.run(holderId, async (held) => {
        const fresh = await this.locateForDecision(input, { sessionId: holderId, held });
        if (fresh.status === 'REFUSED') return fresh;
        return this.decideFromOpsUiUnlocked(input, fresh.found, held);
      });
    });
  }

  /** The fresh approval status and its holder (an ACTIVE conversation of this actor), or why the UI is refused. */
  private async locateForDecision(
    input: OpsUiDecisionInput,
    only?: { readonly sessionId: Id; readonly held: SessionLockHold },
  ): Promise<
    | { readonly status: 'FOUND'; readonly found: { session: Session; lookup: PendingApprovalLookup; approval: ApprovalRequest } }
    | { readonly status: 'REFUSED'; readonly refusal: ApprovalSurfaceRefusal }
  > {
    const current = await this.deps.approvals.get(input.approvalId);
    if (current === null) return { status: 'REFUSED', refusal: 'NOT_FOUND' };
    if (current.status !== ApprovalStatus.PENDING) return { status: 'REFUSED', refusal: 'ALREADY_DECIDED' };
    const found = await this.locate(input.approvalId, input.sessions, only);
    if (found === null) return { status: 'REFUSED', refusal: 'NOT_FOUND' };
    if (!this.ownedBy(found, input.actor)) return { status: 'REFUSED', refusal: 'FOREIGN' };
    return { status: 'FOUND', found };
  }

  private async decideFromOpsUiUnlocked(
    input: OpsUiDecisionInput,
    found: { session: Session; lookup: PendingApprovalLookup; approval: ApprovalRequest },
    held: SessionLockHold,
  ): Promise<ApprovalSurfaceDecision> {
    const { session, lookup, approval } = found;
    const kind = approvalGateKindOf(lookup)!;
    const decisionInput: ApprovalDecisionInput = { context: session.context, session, actor: input.actor, surface: 'ops-ui', held };
    const decided = (outcome: 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'UNAVAILABLE', value: ApprovalDecisionReply): ApprovalSurfaceDecision => {
      // Only a decision that left PENDING settles the id (an UNAVAILABLE answer decided nothing).
      if (outcome !== 'UNAVAILABLE') this.settledByOpsUi.add(input.approvalId);
      this.deps.logger.info('approval decided', { approvalId: input.approvalId, surface: OPS_UI_DECISION_SURFACE, kind, outcome });
      const anchor = kind === 'CONNECTOR_WRITE' && outcome === 'APPROVED' ? lookup.connectorWrite?.anchor : undefined;
      const connectorWrite: ConnectorWriteApprovedNotice | undefined =
        anchor?.operation && anchor.preview
          ? {
              operation: anchor.operation,
              target: connectorWriteTargetOf(anchor.preview),
              executionPhrase: documentedExecutionPhrase(connectorWriteExecutionGate(anchor.operation)),
              // Just approved: the whole ADR-0093 lifetime, counted from now.
              remainingMs: PENDING_APPROVAL_TTL_MS,
            }
          : undefined;
      return {
        status: 'DECIDED',
        outcome,
        kind,
        reply: value.reply,
        chat: session.context,
        ...(connectorWrite ? { connectorWrite } : {}),
      };
    };

    // ADR-0093: an expired approval is recorded denied exactly as the next chat turn would; it can never be approved.
    if (this.remainingMs(approval) <= 0) {
      await this.expireUnlocked(session, lookup, held);
      const reply = this.deps.composer.composeApprovalExpired(session.context, approval, PENDING_APPROVAL_TTL_MS);
      await this.deps.memory.recordAssistant(reply.text, session.context, session.id);
      return decided('EXPIRED', { status: 'DENIED', reply });
    }

    if (input.decision === 'approve') {
      if (!UI_APPROVABLE_KINDS.has(kind)) return refused('APPROVE_IN_CHAT');
      const check = this.checkReference(approval, lookup, input.actor.id, input.reference);
      if (check !== null) return refused(check);
    }
    const verdict: ApprovalDecisionVerdict = input.decision === 'approve' ? 'approve' : 'deny';

    let value: ApprovalDecisionReply;
    if (kind === 'PLAN') {
      value = await this.rejectPlanUnlocked(decisionInput, approval, 'deny');
    } else if (kind === 'CREDENTIAL_OVERRIDE') {
      value = await this.rejectCredentialOverrideUnlocked(
        decisionInput,
        lookup.override as Extract<CredentialOverrideLookup, { state: 'awaiting-decision' }>,
      );
    } else if (kind === 'CONNECTOR_WRITE') {
      value = await this.decideConnectorWriteUnlocked(decisionInput, lookup.connectorWrite!, verdict);
    } else {
      const anchor = lookup.applyAnchor!;
      const incomplete = this.incompleteAnchoredContext(session.context, session, anchor);
      value = incomplete ? await incomplete : await this.decideAnchoredUnlocked(decisionInput, anchor, verdict);
    }
    const outcome =
      value.status === 'FAILED'
        ? 'UNAVAILABLE'
        : value.status === 'DENIED' && verdict === 'approve'
          ? 'EXPIRED'
          : verdict === 'approve'
            ? 'APPROVED'
            : 'REJECTED';
    return decided(outcome, value);
  }

  /** null when the reference is valid; otherwise why it is refused (attempts are counted per approval and window). */
  private checkReference(
    approval: ApprovalRequest,
    lookup: PendingApprovalLookup,
    ownerActorId: Id,
    raw: string | undefined,
  ): ApprovalSurfaceRefusal | null {
    const window = approvalReferenceWindow(Date.parse(this.clock()));
    const attempts = this.referenceAttempts.get(approval.id);
    if (attempts !== undefined && attempts.window === window && attempts.wrong >= APPROVAL_REFERENCE_MAX_ATTEMPTS) {
      return 'REFERENCE_LOCKED';
    }
    const entered = normalizeApprovalReference(raw ?? '');
    if (entered.length === 0) return 'REFERENCE_REQUIRED';
    const binding = bindingOf(lookup);
    if (binding !== null) {
      const digest = approvalBindingDigest(approval, binding);
      for (const w of [window, window - 1]) {
        if (sameReference(entered, approvalConfirmationReference(approval.id, digest, ownerActorId, w))) return null;
      }
    }
    const wrong = attempts !== undefined && attempts.window === window ? attempts.wrong + 1 : 1;
    this.referenceAttempts.set(approval.id, { window, wrong });
    this.deps.logger.warn('approval reference mismatch', { approvalId: approval.id, surface: OPS_UI_DECISION_SURFACE, attempts: wrong });
    return wrong >= APPROVAL_REFERENCE_MAX_ATTEMPTS ? 'REFERENCE_LOCKED' : 'REFERENCE_MISMATCH';
  }

  /** Find the conversation holding `approvalId` PENDING, with the same lookup chat runs at turn start. */
  private async locate(
    approvalId: Id,
    sessions: () => Promise<readonly Session[]>,
    only?: { readonly sessionId: Id; readonly held: SessionLockHold },
  ): Promise<{ session: Session; lookup: PendingApprovalLookup; approval: ApprovalRequest } | null> {
    for (const session of await sessions()) {
      // `only`: inside that session's write lock, look at it alone (its hold goes to the lookups that may write).
      if (only !== undefined && session.id !== only.sessionId) continue;
      // Only a live conversation holds an approval: a reset (closed) session is never decided for or re-anchored.
      if (session.status !== SessionStatus.ACTIVE) continue;
      const lookup = await this.findPending(session, only?.held);
      if (lookup.pending?.id === approvalId && approvalGateKindOf(lookup) !== null) return { session, lookup, approval: lookup.pending };
    }
    return null;
  }

  private ownedBy(found: { session: Session; lookup: PendingApprovalLookup }, actor: Actor): boolean {
    if (found.session.actorId !== actor.id) return false;
    const writeActor = found.lookup.connectorWrite?.anchor.actorId;
    return writeActor === undefined || writeActor === actor.id;
  }
}

function refused(refusal: ApprovalSurfaceRefusal): ApprovalSurfaceDecision {
  return { status: 'REFUSED', refusal };
}

/** The decision kind a lookup's pending approval takes, or null when nothing UI-decidable is pending. */
export function approvalGateKindOf(lookup: PendingApprovalLookup): ApprovalGateKind | null {
  if (!lookup.pending) return null;
  if (lookup.planPending) return 'PLAN';
  if (lookup.override) return lookup.override.state === 'awaiting-decision' ? 'CREDENTIAL_OVERRIDE' : null;
  if (lookup.connectorWrite) return lookup.connectorWrite.anchor.operation ? 'CONNECTOR_WRITE' : null;
  if (lookup.applyAnchor) return ANCHORED_KIND[lookup.applyAnchor.status] ?? null;
  return null;
}

/** The grant binding of a UI-approvable pending approval. */
function bindingOf(lookup: PendingApprovalLookup): ApprovalGrantBinding | null {
  const view = lookup.connectorWrite;
  if (view?.anchor.operation) return { kind: 'CONNECTOR_WRITE', operation: view.anchor.operation };
  return lookup.applyAnchor ? ApprovalDecisionService.anchoredBinding(lookup.applyAnchor) : null;
}

/**
 * The content-free failure lines of the anchored gates (deliberately NO diff text / file content / stderr). Shared by
 * the decision path and the runtime's execution turns.
 */
export function logAnchoredApprovalFailure(
  logger: ApprovalDecisionServiceDeps['logger'],
  family: AnchoredFailureFamily,
  session: Session,
  anchor: ApplyPreviewAnchor,
  reason: string,
): void {
  switch (family) {
    case 'commit':
      logger.warn('commit approval failed', {
        reason,
        sessionId: session.id,
        executionPlanId: anchor.executionPlanRef?.id,
        commitApprovalId: anchor.commitApprovalId,
      });
      return;
    case 'push':
      logger.warn('push approval failed', {
        reason,
        sessionId: session.id,
        executionPlanId: anchor.executionPlanRef?.id,
        pushApprovalId: anchor.pushApprovalId,
      });
      return;
    case 'pr':
      logger.warn('pr approval failed', {
        reason,
        sessionId: session.id,
        executionPlanId: anchor.executionPlanRef?.id,
        prApprovalId: anchor.prApprovalId,
      });
  }
}
