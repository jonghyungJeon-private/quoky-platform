import { createHash } from 'node:crypto';
import { ApprovalStatus, RiskLevel } from '../../domain';
import type { ApprovalRequest, ExecutionPlanRef, Id, IsoTimestamp, Session, WorkspaceRef } from '../../domain';
import { interpretApprovalDecision } from '../approval-decision';
import {
  type CodeGenerationContextReader,
  type CredentialOverrideGrant,
  readCodeGenerationContextFiles,
} from '../code-generation-context';
import { PENDING_APPROVAL_TTL_MS, pendingApprovalRemainingMs } from '../conversation-commands';
import type { ExecutionOutcome, ExecutionRequest } from '../execution-orchestrator';

/**
 * Owner one-time, hash-bound CRITICAL override for credential-guard refusals in the code-change preview
 * (ADR-0097 D3/D5). Domain types and pure rules only: no storage, no clock of its own, no provider.
 *
 * Grant state lives ONLY on the inert plan-less anchor Task of the original request (ADR-0040 technique,
 * {@link StatelessCredentialOverrideFlow}); never on Session, in memory stores, or in an authoritative
 * in-memory cache. Every record here is content-free: path, SHA-256, detector and line, never file content or
 * the matched text. A path is user-facing only (reply copy); logs carry ids, index, hash and line.
 */

/** Anchor discriminator: proves a plan-less Task's metadata is a credential-override anchor (ADR-0097 D3). */
export const CREDENTIAL_OVERRIDE_ANCHOR_KIND = 'code-preview-credential-override' as const;

/** One anchor holds at most one grant per refused target of a ≤5-file change set (ADR-0097 D5, ADR-0099). */
export const MAX_CREDENTIAL_OVERRIDE_GRANTS = 5;

/** `ApprovalDecision.comment` the runtime records when the owner sends the file anyway (ADR-0097 D5). */
export const CREDENTIAL_OVERRIDE_APPROVE_COMMENT = 'credential-override';
/** `ApprovalDecision.comment` the runtime records when the owner refuses the override. */
export const CREDENTIAL_OVERRIDE_DENY_COMMENT = 'credential-override-denied';

/** Per-grant lifecycle (ADR-0097 D5). Never regresses; `CONSUMED` and `INVALIDATED` are terminal. */
export type CredentialOverrideGrantState = 'PENDING' | 'GRANTED' | 'CONSUMED' | 'INVALIDATED';

/**
 * Anchor lifecycle: `PENDING` while one grant awaits the owner's decision; `GRANTED` once every grant is granted
 * and the set waits for the single dispatch; `CONSUMED` after the one consume save; `INVALIDATED` otherwise.
 */
export type CredentialOverrideAnchorStatus = CredentialOverrideGrantState;

/**
 * Why a set was invalidated (ADR-0097 D5/D7). Every invalidation sends nothing and asks for a fresh request.
 * `superseded` means a newer request (or a different actor/request) took the set's place; `inconsistent` means
 * the stored record cannot be proven to be this request (malformed anchor, a decision recorded outside the anchor
 * — e.g. a crash between `ApprovalManager.decide` and `recordGrant` — or an ApprovalRequest that is not this
 * request's CRITICAL override).
 */
export type CredentialOverrideInvalidationReason =
  | 'reset'
  | 'denied'
  | 'expired'
  | 'project-changed'
  | 'changed'
  | 'superseded'
  | 'inconsistent';

/** The original-request binding every grant (and its anchor) carries (ADR-0097 D5 "Binding"). */
export interface CredentialOverrideBinding {
  /** The owner actor who must decide and later dispatch. */
  ownerActorId: Id;
  sessionId: Id;
  workspaceRef: WorkspaceRef;
  /** The session's active project at refusal time. */
  projectId?: Id;
  /** The CODE_IMPLEMENTATION request: its approval-anchor Task id and its execution plan id. */
  requestTaskId: Id;
  executionPlanId: Id;
}

/** One refused `credential-assignment` target's grant, content-free (ADR-0097 D5). */
export interface CredentialOverrideGrantRecord extends CredentialOverrideBinding {
  /** The CRITICAL `ApprovalRequest` raised for this target. */
  approvalRequestId: Id;
  /** Index into the deduplicated target read order (log-safe). */
  targetIndex: number;
  /** Workspace-relative path as the user supplied it (reply copy only, never logged). */
  path: string;
  /** Lowercase hex SHA-256 of the target's UTF-8 content at refusal time. */
  contentSha256: string;
  detector: 'credential-assignment';
  /** 1-based line of the first credential assignment at refusal time. */
  line: number;
  state: CredentialOverrideGrantState;
  invalidationReason?: CredentialOverrideInvalidationReason;
  createdAt: IsoTimestamp;
  grantedAt?: IsoTimestamp;
  grantedBy?: Id;
  consumedAt?: IsoTimestamp;
  invalidatedAt?: IsoTimestamp;
}

/**
 * The anchored fact set of ONE original request (ADR-0097 D5): the in-flight `{request, outcome}` (the same
 * precedent as `StatelessApprovalFlow`'s execution anchor) so the preview can re-run after each grant, the
 * request's `newFileTargets` (ADR-0099), the binding, and every grant. The anchor Task row is the audit record.
 */
export interface CredentialOverrideAnchor extends CredentialOverrideBinding {
  kind: typeof CREDENTIAL_OVERRIDE_ANCHOR_KIND;
  status: CredentialOverrideAnchorStatus;
  invalidationReason?: CredentialOverrideInvalidationReason;
  request: ExecutionRequest;
  outcome: ExecutionOutcome;
  newFileTargets: string[];
  grants: CredentialOverrideGrantRecord[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  consumedAt?: IsoTimestamp;
  invalidatedAt?: IsoTimestamp;
  /** `system` for expiry/content/project/supersession; the owner actor id for reset or denial. */
  invalidatedBy?: string;
}

/** An overridable refusal as `readCodeGenerationContextFiles` reports it (log-safe except `targetPath`). */
export interface CredentialOverrideRefusal {
  targetIndex: number;
  /** User-supplied path, for the reply only. */
  targetPath: string;
  contentSha256: string;
  line: number;
}

// ---------------------------------------------------------------------------------------------------------
// Decision interpretation (ADR-0097 D3)
// ---------------------------------------------------------------------------------------------------------

/**
 * The dedicated whole-message approve set. It shares no word with the plan-approval vocabulary: `승인`, `좋아`
 * and `ok` re-prompt and never send.
 */
export const CREDENTIAL_OVERRIDE_SEND_PHRASES: readonly string[] = [
  '그래도 보내줘',
  '그래도 보내',
  '그래도 보내 줘',
  '그래도 전송해줘',
  'send anyway',
];
/** The phrase the copy tells the owner to type. */
export const CREDENTIAL_OVERRIDE_SEND_PHRASE = '그래도 보내줘';

const SEND_SET: ReadonlySet<string> = new Set(CREDENTIAL_OVERRIDE_SEND_PHRASES);
const DENY_SET: ReadonlySet<string> = new Set(['보내지 마', '보내지마']);

/** Trim, NFC, collapse whitespace, ASCII-lowercase only (never a locale fold), strip trailing `.`/`!`. */
function normalizeOverrideText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[.!]+$/, '')
    .trim();
}

export type CredentialOverrideDecision = 'send' | 'deny' | 'reprompt';

/**
 * Interpret one message while an override is pending. `send` only for the whole-message phrase set; `deny` for an
 * `interpretApprovalDecision` deny/cancel or `보내지 마`; everything else (including `승인`, `좋아`, `ok`, a question,
 * or the phrase inside a longer sentence) re-prompts. Pure.
 */
export function interpretCredentialOverrideDecision(text: string): CredentialOverrideDecision {
  const normalized = normalizeOverrideText(text);
  if (SEND_SET.has(normalized)) return 'send';
  if (DENY_SET.has(normalized)) return 'deny';
  const decision = interpretApprovalDecision(text);
  return decision === 'deny' || decision === 'cancel' ? 'deny' : 'reprompt';
}

/**
 * True when the whole message is an override send phrase. Used only when NOTHING is pending, so the runtime can
 * reply deterministically (QA-018 pattern) instead of letting a chat model claim a file was sent.
 */
export function isStrayCredentialOverridePhrase(text: string): boolean {
  return SEND_SET.has(normalizeOverrideText(text));
}

// ---------------------------------------------------------------------------------------------------------
// Approval request (ADR-0097 D3)
// ---------------------------------------------------------------------------------------------------------

/** Structurally `ApprovalManager.requestForRisk` (and the runtime's `deps.approvals`). */
export interface CredentialOverrideApprovalRequester {
  requestForRisk(input: {
    executionPlanRef: ExecutionPlanRef;
    riskLevel: RiskLevel;
    reason: string;
    requestedBy: string;
  }): Promise<ApprovalRequest>;
}

/** The CRITICAL approval's reason: target index, hash, detector and line — never the path or any content. */
export function credentialOverrideApprovalReason(
  refusal: Pick<CredentialOverrideRefusal, 'targetIndex' | 'contentSha256' | 'line'>,
): string {
  return (
    `credential-guard override: send target #${refusal.targetIndex} content once to the AI provider for this ` +
    `code preview; sha256=${refusal.contentSha256}; detector=credential-assignment; line=${refusal.line}`
  );
}

// ---------------------------------------------------------------------------------------------------------
// Assessment: restart reconstruction and revalidation (ADR-0097 D5)
// ---------------------------------------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Lowercase hex SHA-256 of UTF-8 text (the same digest the context reader binds). */
export function credentialOverrideContentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const sameWorkspace = (a: WorkspaceRef | undefined, b: WorkspaceRef | undefined): boolean =>
  !!a && !!b && a.id === b.id && a.rootPath === b.rootPath && a.kind === b.kind;

/** Whether an ApprovalRequest is this anchor's own CRITICAL override request (same plan, CRITICAL risk). */
const isOverrideApprovalOf = (approval: ApprovalRequest, anchor: CredentialOverrideAnchor): boolean =>
  approval.riskLevel === RiskLevel.CRITICAL && approval.executionPlanRef?.id === anchor.executionPlanId;

/** Whether a grant's own binding equals its anchor's (every grant carries the full binding, D5). */
function grantBoundToAnchor(grant: CredentialOverrideGrantRecord, anchor: CredentialOverrideAnchor): boolean {
  return (
    grant.ownerActorId === anchor.ownerActorId &&
    grant.sessionId === anchor.sessionId &&
    sameWorkspace(grant.workspaceRef, anchor.workspaceRef) &&
    grant.projectId === anchor.projectId &&
    grant.requestTaskId === anchor.requestTaskId &&
    grant.executionPlanId === anchor.executionPlanId
  );
}

/**
 * Structural well-formedness of an anchor read back from storage: 1..5 grants, distinct approvals and paths,
 * at most one PENDING grant (and only as the newest), every grant bound to the anchor, a valid hash and line.
 * A malformed anchor cannot be proven to be this request and is never honored.
 */
export function isWellFormedCredentialOverrideAnchor(anchor: CredentialOverrideAnchor): boolean {
  if (anchor.kind !== CREDENTIAL_OVERRIDE_ANCHOR_KIND) return false;
  if (!anchor.ownerActorId || !anchor.sessionId || !anchor.requestTaskId || !anchor.executionPlanId) return false;
  if (!anchor.workspaceRef || !anchor.request || !anchor.outcome || !Array.isArray(anchor.newFileTargets)) return false;
  const grants = anchor.grants;
  if (!Array.isArray(grants) || grants.length === 0 || grants.length > MAX_CREDENTIAL_OVERRIDE_GRANTS) return false;
  const approvals = new Set<Id>();
  const paths = new Set<string>();
  for (const [i, g] of grants.entries()) {
    if (!g || !grantBoundToAnchor(g, anchor)) return false;
    if (g.detector !== 'credential-assignment' || !SHA256_HEX.test(g.contentSha256)) return false;
    if (!Number.isInteger(g.line) || g.line < 1 || !Number.isInteger(g.targetIndex) || g.targetIndex < 0) return false;
    if (!g.path || !g.approvalRequestId || approvals.has(g.approvalRequestId) || paths.has(g.path)) return false;
    if (g.state === 'PENDING' && i !== grants.length - 1) return false;
    approvals.add(g.approvalRequestId);
    paths.add(g.path);
  }
  return true;
}

/** What one anchor amounts to, given its ApprovalRequests and the injected clock. */
export type CredentialOverrideAssessment =
  /** One PENDING grant awaits the owner; the set is valid for `remainingMs` (oldest grant bounds it). */
  | {
      readonly kind: 'awaiting-decision';
      readonly grant: CredentialOverrideGrantRecord;
      readonly approval: ApprovalRequest;
      readonly remainingMs: number;
    }
  /** Every grant is GRANTED and still valid: the set waits for the single revalidated dispatch. */
  | { readonly kind: 'ready'; readonly remainingMs: number }
  /** A grant was consumed: terminal, never replayed (a partially-consumed anchor counts as consumed). */
  | { readonly kind: 'consumed' }
  /**
   * The set is (or must now be) invalidated. `pendingApproval` is a still-PENDING ApprovalRequest of the set
   * that the caller closes through `ApprovalManager.decide` (expiry: `system`/expired, ADR-0093).
   */
  | {
      readonly kind: 'invalid';
      readonly reason: CredentialOverrideInvalidationReason;
      readonly pendingApproval: ApprovalRequest | null;
    };

/**
 * Restart-safe reconstruction (ADR-0097 D5): nothing in memory is authoritative, so every read derives the
 * set's state from the anchor and its ApprovalRequests alone. Pure.
 *
 * - `CONSUMED` (anchor or any grant) stays terminal.
 * - Every grant's request must be a CRITICAL request of the anchor's own execution plan.
 * - A `GRANTED` grant is kept only if its request is `APPROVED` (decision true) with `decidedBy` = owner.
 * - A `PENDING` grant is kept only if its request is still `PENDING`.
 * - The whole set expires `PENDING_APPROVAL_TTL_MS` after its OLDEST grant's request was created (no new TTL);
 *   an unknown age (missing request, unparseable timestamp) is expired (fail closed).
 * Otherwise the set is invalid: `denied` for a rejected or non-owner decision, `expired` for age or a missing
 * request, `inconsistent` for a malformed anchor, a foreign request, or a request decided outside the anchor's
 * record. `pendingApproval` is only ever one of the anchor's own CRITICAL requests, never a foreign one.
 */
export function assessCredentialOverrideAnchor(
  anchor: CredentialOverrideAnchor,
  approvals: ReadonlyMap<Id, ApprovalRequest | null>,
  at: IsoTimestamp,
  ttlMs: number = PENDING_APPROVAL_TTL_MS,
): CredentialOverrideAssessment {
  const grants = Array.isArray(anchor.grants) ? anchor.grants : [];
  if (anchor.status === 'CONSUMED' || grants.some((g) => g?.state === 'CONSUMED')) return { kind: 'consumed' };
  const pendingApproval =
    grants
      .map((g) => (g ? approvals.get(g.approvalRequestId) ?? null : null))
      .find((r): r is ApprovalRequest => r?.status === ApprovalStatus.PENDING && isOverrideApprovalOf(r, anchor)) ??
    null;
  const invalid = (reason: CredentialOverrideInvalidationReason): CredentialOverrideAssessment => ({
    kind: 'invalid', reason, pendingApproval,
  });
  if (anchor.status === 'INVALIDATED') return invalid(anchor.invalidationReason ?? 'inconsistent');
  if (!isWellFormedCredentialOverrideAnchor(anchor)) return invalid('inconsistent');

  let remainingMs = ttlMs;
  let pending: { grant: CredentialOverrideGrantRecord; approval: ApprovalRequest } | null = null;
  for (const grant of grants) {
    const approval = approvals.get(grant.approvalRequestId) ?? null;
    if (!approval) return invalid('expired'); // unknown age: never grantable
    if (!isOverrideApprovalOf(approval, anchor)) return invalid('inconsistent'); // not this request's override
    if (approval.status === ApprovalStatus.REJECTED) return invalid('denied');
    if (grant.state === 'GRANTED') {
      if (approval.status !== ApprovalStatus.APPROVED || approval.decision !== true) return invalid('inconsistent');
      const owner = anchor.ownerActorId;
      if (approval.decidedBy !== owner || grant.grantedBy !== owner) return invalid('denied');
    } else if (grant.state === 'PENDING') {
      // Decided (approved) but never recorded on the anchor — e.g. a crash between decide and recordGrant.
      if (approval.status !== ApprovalStatus.PENDING) return invalid('inconsistent');
      pending = { grant, approval };
    } else {
      return invalid(grant.invalidationReason ?? 'inconsistent');
    }
    remainingMs = Math.min(remainingMs, pendingApprovalRemainingMs(approval.createdAt, at, ttlMs));
  }
  if (remainingMs <= 0) return invalid('expired');
  if (pending) {
    if (anchor.status !== 'PENDING') return invalid('inconsistent');
    return { kind: 'awaiting-decision', grant: pending.grant, approval: pending.approval, remainingMs };
  }
  if (anchor.status !== 'GRANTED') return invalid('inconsistent');
  return { kind: 'ready', remainingMs };
}

/** The anchor with every unconsumed grant and the anchor itself flipped to `INVALIDATED{reason}`. Pure. */
export function invalidateCredentialOverrideAnchor(
  anchor: CredentialOverrideAnchor,
  reason: CredentialOverrideInvalidationReason,
  invalidatedBy: string,
  at: IsoTimestamp,
): CredentialOverrideAnchor {
  return {
    ...anchor,
    status: 'INVALIDATED',
    invalidationReason: reason,
    invalidatedAt: at,
    invalidatedBy,
    updatedAt: at,
    grants: (Array.isArray(anchor.grants) ? anchor.grants : []).map((g) =>
      g.state === 'CONSUMED' || g.state === 'INVALIDATED'
        ? g
        : { ...g, state: 'INVALIDATED' as const, invalidationReason: reason, invalidatedAt: at },
    ),
  };
}

/**
 * Pre-dispatch coverage check (ADR-0097 D5 "No content is sent until every refused target is GRANTED"): does the
 * request's target set still hold a refused `credential-assignment` target without a grant? It runs the same
 * context assembly as the dispatch, but DISCARDS every read content (the result never carries content), so the
 * granted grants are projected as admitted for classification only. Nothing is consumed and nothing is sent:
 * the caller consumes through the flow only after `covered`, and the real dispatch read re-verifies each hash.
 */
export type CredentialOverrideCoverage =
  | { readonly kind: 'covered' }
  /** Another target needs its own CRITICAL override; it joins the same anchor as a new PENDING grant. */
  | { readonly kind: 'needs-override'; readonly refusal: CredentialOverrideRefusal }
  /** A hard failure (unreadable, oversized, secret-token, or a granted file changed since the override). */
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'target-read-failed'
        | 'target-too-large'
        | 'context-total-too-large'
        | 'target-contains-credential'
        | 'target-changed-since-override';
      readonly targetIndex: number;
      /** User-supplied path (reply only) when the reader reported one. */
      readonly targetPath?: string;
    };

export async function assessCredentialOverrideCoverage(
  reader: CodeGenerationContextReader,
  ref: WorkspaceRef,
  targetFiles: readonly string[],
  newFileTargets: readonly string[],
  grants: readonly CredentialOverrideGrantRecord[],
): Promise<CredentialOverrideCoverage> {
  const projected: CredentialOverrideGrant[] = grants
    .filter((g) => g.state === 'GRANTED')
    .map((g) => ({
      path: g.path, contentSha256: g.contentSha256, detector: g.detector, line: g.line, state: 'CONSUMED',
    }));
  const result = await readCodeGenerationContextFiles(reader, ref, targetFiles, newFileTargets, {
    credentialOverrides: projected,
  });
  if (result.ok) return { kind: 'covered' };
  if (result.reason === 'target-contains-credential' && result.overridable) {
    return {
      kind: 'needs-override',
      refusal: {
        targetIndex: result.targetIndex,
        targetPath: result.targetPath,
        contentSha256: result.contentSha256,
        line: result.line,
      },
    };
  }
  return {
    kind: 'blocked',
    reason: result.reason,
    targetIndex: result.targetIndex,
    ...('targetPath' in result ? { targetPath: result.targetPath } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Flow contract (ADR-0097 D4/D5) — implemented by StatelessCredentialOverrideFlow, wired by OVR-4
// ---------------------------------------------------------------------------------------------------------

/** What `findPending` sees on the session's anchor pointer. */
export type CredentialOverrideLookup =
  | {
      readonly state: 'awaiting-decision';
      readonly anchor: CredentialOverrideAnchor;
      readonly grant: CredentialOverrideGrantRecord;
      readonly approval: ApprovalRequest;
      readonly remainingMs: number;
    }
  | { readonly state: 'ready'; readonly anchor: CredentialOverrideAnchor; readonly remainingMs: number }
  /** Consumed, or a dispatch claim is in flight: the "already used" reply. */
  | { readonly state: 'consumed'; readonly anchor: CredentialOverrideAnchor }
  /**
   * Invalidated by this lookup (the anchor is saved `INVALIDATED` and the pointer released). The caller closes
   * `pendingApproval` (if any) through `ApprovalManager.decide` and replies with a fresh-request message.
   */
  | {
      readonly state: 'invalidated';
      readonly anchor: CredentialOverrideAnchor;
      readonly reason: CredentialOverrideInvalidationReason;
      readonly pendingApproval: ApprovalRequest | null;
    };

/** Input to raise one CRITICAL override for an overridable refusal of the request in flight. */
export interface CredentialOverrideRequestInput {
  readonly request: ExecutionRequest;
  readonly outcome: ExecutionOutcome;
  /** The owner actor (the turn's resolved actor); must equal `session.actorId`. */
  readonly ownerActorId: Id;
  readonly refusal: CredentialOverrideRefusal;
}

export type CredentialOverrideRequestResult =
  | { readonly ok: true; readonly anchor: CredentialOverrideAnchor; readonly approval: ApprovalRequest }
  | {
      readonly ok: false;
      /**
       * `unbound`: the request cannot be bound (no plan/workspace/owner, or the pointer is not this request).
       * `chain-invalid`: the pointer holds an override set that is not a fully GRANTED set of this request; it
       * was invalidated (nothing raised), and `pendingApproval` is a still-PENDING request the caller closes.
       * `anchor-failed`: the CRITICAL request was created but the anchor Task or the session pointer could not
       * be saved. `pendingApproval` is that just-created request: the caller MUST close it as rejected through
       * `ApprovalManager.decide`, because a pointer still on the plan-approval Task would otherwise let
       * `StatelessApprovalFlow.findPending` surface it to the plain plan-approval vocabulary (ADR-0097 D3).
       */
      readonly reason:
        | 'unbound'
        | 'invalid-refusal'
        | 'too-many-targets'
        | 'duplicate-target'
        | 'chain-invalid'
        | 'anchor-failed';
      readonly pendingApproval?: ApprovalRequest | null;
    };

export type CredentialOverrideGrantResult =
  | { readonly ok: true; readonly anchor: CredentialOverrideAnchor }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'not-pending' | CredentialOverrideInvalidationReason;
      readonly pendingApproval?: ApprovalRequest | null;
    };

/** What `invalidate` did to the session's override anchor. */
export type CredentialOverrideInvalidationResult =
  /** The set is (now, or already was) `INVALIDATED`: nothing was sent — the "nothing was sent" reply. */
  | { readonly state: 'invalidated'; readonly anchor: CredentialOverrideAnchor }
  /**
   * The set was already consumed (its single dispatch won the per-anchor serialization, or has run): nothing was
   * invalidated, and the caller MUST reply "already used", never "nothing was sent".
   */
  | { readonly state: 'consumed'; readonly anchor: CredentialOverrideAnchor };

/** The current turn's facts every grant must equal at dispatch time (ADR-0097 D5 "Revalidate"). */
export interface CredentialOverrideDispatchInput {
  readonly actorId: Id;
  /** `resolveActiveWorkspace()` for this turn. */
  readonly workspaceRef: WorkspaceRef;
  /** The session's active project for this turn. */
  readonly projectId?: Id;
  /** The execution plan id of the request being dispatched. */
  readonly executionPlanId: Id;
  /** The read-only Workspace reader (`WorkspaceManager.read`) used to re-read every granted target. */
  readonly reader: CodeGenerationContextReader;
}

export type CredentialOverrideDispatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /**
       * `already-used`: consumed, or a claim is held by another turn. `not-granted`: some grant still awaits a
       * decision (nothing changed). `consume-failed`: the consume save failed (nothing sent). Any invalidation
       * reason: the set was invalidated and nothing was sent.
       */
      readonly reason:
        | 'not-found'
        | 'already-used'
        | 'not-granted'
        | 'consume-failed'
        | CredentialOverrideInvalidationReason;
    };

/**
 * Cross-turn credential-override mechanics behind one collaborator (ADR-0097 D4), like the other stateless flows.
 * Every method is a no-op on (or never touches) a session pointer that is not this flow's own anchor.
 *
 * Concurrency: every method that reads-and-writes an anchor is serialized per anchor (Personal is one process,
 * ADR-0091), and `consumeAndDispatch` holds that serialization from its first read through the consume save. An
 * invalidation (reset, denial, project change, supersession) therefore lands either before the consume — and the
 * dispatch then fails and sends nothing — or after it, and reports `consumed`.
 *
 * Wiring obligations (OVR-4):
 * - Before anchoring any NEWER request on the session pointer (e.g. `StatelessApprovalFlow.anchor`, which
 *   overwrites `activeTaskId`), call `clear()` so a live older set is written `INVALIDATED{superseded}` (D7
 *   audit) instead of being orphaned as `PENDING`/`GRANTED`.
 * - Close every `pendingApproval` handed back (`findPending`, `requestOverride`, `recordGrant`) through
 *   `ApprovalManager.decide`.
 * - `consumeAndDispatch` releases the pointer right after the consume save, so later turns never keep hitting a
 *   consumed anchor; a later send phrase then takes the stray-phrase path.
 */
export interface CredentialOverrideFlow {
  /** Reconstruct the session's override anchor (restart-safe; invalidates and releases a no-longer-valid set). */
  findPending(session: Session): Promise<CredentialOverrideLookup | null>;
  /** Create the CRITICAL ApprovalRequest via `requestForRisk` and anchor (or extend) the request's grant set. */
  requestOverride(
    session: Session,
    input: CredentialOverrideRequestInput,
    approvals: CredentialOverrideApprovalRequester,
  ): Promise<CredentialOverrideRequestResult>;
  /** After `ApprovalManager.decide(approved)`: mark the PENDING grant of `approvalId` GRANTED (re-verified). */
  recordGrant(session: Session, approvalId: Id): Promise<CredentialOverrideGrantResult>;
  /**
   * Revalidate every grant, consume the whole set in one anchor save, release the session pointer, then run
   * `dispatch` (the single `generate()`) with the consumed grants, under a per-anchor single-flight claim held
   * until it settles.
   */
  consumeAndDispatch<T>(
    session: Session,
    input: CredentialOverrideDispatchInput,
    dispatch: (grants: readonly CredentialOverrideGrant[]) => Promise<T>,
  ): Promise<CredentialOverrideDispatchResult<T>>;
  /**
   * Invalidate every unconsumed grant and the anchor, and release the pointer. `null` when the pointer is not our
   * anchor; `consumed` when the set was already consumed (nothing to invalidate — reply "already used").
   */
  invalidate(
    session: Session,
    reason: CredentialOverrideInvalidationReason,
    invalidatedBy: string,
  ): Promise<CredentialOverrideInvalidationResult | null>;
  /** Release the pointer if it is ours; an unconsumed set is invalidated `superseded` first. */
  clear(session: Session): Promise<void>;
}
