import { helpTopicOfLines } from '../help-intent/help-intent-turn-handler';
import { noticeLanguage } from '../chat-policy/internal-action-vocabulary';
import { imageUnderstandingPolicyOf, type ImageUnderstandingLocalitiesResolver, type ImageUnderstandingPolicy } from '../image-understanding';
import { outboundMessage } from '../message-rendering';
import { isPendingCancelUtterance } from '../approval-decision';
import { ApprovalDecisionService, type ApprovalDecisionInput, type ApprovalDecisionReply, type PendingApprovalLookup } from '../approval-decision-service';
import { safeRequestId, toSafeError } from '../safe-error';
import { type NlCatalogEntry, type NlSelectedCommand } from '../nl-routing/catalog';
import { type NlControlScope } from '../nl-routing/honest-chat';
import { languageOf } from '../nl-routing/nl-selection-service';
import { renderAgentSwitchReply } from '../agent/agent-run-service';
import { type NlActionAudit } from '../nl-routing/nl-action-policy';
import type { LastTurnReplyKind } from '../nl-routing/last-turn';
import { nearMissActionSwitchPhrase, parseActionSwitchPhrase, renderActionSwitchHint, renderActionSwitchReply } from '../nl-routing/action-switch';
import {
  allowedSurfaceGroups,
  decideSurface,
  isSurfaceDirect,
  type SurfaceDecision,
  type SurfaceGate,
  type SurfaceGateAudit,
} from '../surface-grants/surface-gate';
import { type SurfacePermit } from '../surface-grants/surface-permit';
import { renderNlActionDmOnly, renderSurfaceDenied, renderSurfaceSwitchSuffix } from '../surface-grants/surface-grant-copy';
import { surfaceGroupOfStateStep, surfaceGroupsOfSelection, type StateBoundStep } from '../surface-grants/surface-group-map';
import type { SurfaceGroupId } from '../surface-grants/surface-groups';
import { parseJiraReleaseLinks } from '../work-chat/jira-release-link';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { CommandExecutionStatus } from '../../domain';
import type {
  Actor,
  ApprovalRequest,
  CommandExecution,
  ConversationContext,
  Id,
  InboundMessage,
  IsoTimestamp,
  OutboundMessage,
  RepositoryIdentity,
  Session,
  TurnWorkFacts,
  WorkspaceRepositoryResolution,
} from '../../domain';
import {
  type ConversationTurnHandler,
  type SurfaceClaim,
  type TurnHandlerContext,
  type TurnHandlerOutcome,
  type TurnHandlerReply,
  type TurnHandlerStage,
} from '../../ports';
import { now } from '../../util/clock';
import type { ExecutionOutcome, ExecutionOutcomeStatus } from '../execution-orchestrator';
import { BoundedShownItems, SurfaceDeniedError, orderTurnHandlers, sameRepositoryIdentity, toReplyStatus, type HostingIdentityLookup } from './helpers';
import { interpretDecision, toTestResultDetail } from './turn-intents';
import type { ApplyPreviewAnchor, ConversationRuntimeDeps, ConversationRuntimeOptions, LongItemSummaryOptions, RuntimeTurnStatus, TurnResult } from './types';

export abstract class ConversationRuntimeBase {
  protected readonly clock: () => IsoTimestamp;
  protected readonly gitRemoteEnabled: boolean;
  protected readonly gitMergeEnabled: boolean;
  /** ADR-0124 Part L C5a-2: the S3 options (absent = every summary on today's path). */
  protected readonly longItemSummary: LongItemSummaryOptions | undefined;
  /**
   * ADR-0111 amendment A2: which declared provider localities may receive image bytes (default `LOCAL` only) — fixed
   * at composition, or resolved per image turn from the effective selection (runtime switching).
   */
  protected readonly imagePolicy: ImageUnderstandingPolicy | ImageUnderstandingLocalitiesResolver;
  /** The registered turn handlers per stage, each in `(order, id)` order (ADR-0096 D2). */
  protected readonly turnHandlersByStage: Readonly<Record<TurnHandlerStage, readonly ConversationTurnHandler[]>>;
  /** The handlers' contributed help lines in registry order (ADR-0096 D6); bounded by the composer. */
  protected readonly contributedHelpLines: readonly string[];
  /** The registry in dispatch order: the ADR-0120 catalog is read from it on each selection turn. */
  protected readonly turnHandlerRegistry: readonly ConversationTurnHandler[];
  /** Owner decision A follow-up (2026-10-22): the one help topic each handler's contributed help lines answer (once). */
  protected readonly handlerHelpTopics = new Map<ConversationTurnHandler, string>();
  /**
   * ADR-0113 D7 (OPS-2b): the one approval decision path, shared with the local operations UI. Built from collaborators
   * this runtime already holds (no deps key); the composition root reaches it through the runtime instance.
   */
  readonly approvalDecisions: ApprovalDecisionService;

  /** Turns (by message object) for which the Class B listing grammars may yield to selection (amendment A2). */
  protected readonly nlYield = new WeakSet<InboundMessage>();

  /**
   * Per turn (by message object): a previous `lastSelection` exists and this turn has not yet replaced it. `chat`: the turn
   * was answered by chat, which keeps the record one turn older (owner decision D1) instead of clearing it.
   */
  protected readonly nlTurns = new WeakMap<InboundMessage, { sessionId: Id; keep: boolean; chat?: boolean }>();
  /** Owner decision of 2026-10-28: the shown listing's item words per `sessionId|actorId` (process memory only, bounded). */
  protected readonly nlShownItems = new BoundedShownItems();
  /** A6 R5a: who and where each turn is (and its SHORT_TERM user record), for `quoky.lastTurn`. */
  protected readonly nlTurnFacts = new WeakMap<InboundMessage, { readonly sessionId: Id; readonly actorId: Id; readonly memoryId?: Id }>();
  /** A6 R5a: what kind of reply each turn gave (unmarked: `chat`). */
  protected readonly nlReplyKinds = new WeakMap<InboundMessage, { readonly kind: LastTurnReplyKind; readonly listingSource?: 'todo' | 'reminder' }>();
  /** A6 R5a: the prefix of a turn that ended an unanswered preview. */
  protected readonly nlDeicticPrefix = new WeakMap<InboundMessage, string>();
  /** Owner decision of 2026-10-29: turns answered by chat (GENERAL_CHAT / POLICY_SENSITIVE_CHAT), for `quoky.lastReply`. */
  protected readonly nlChatReplies = new WeakSet<InboundMessage>();
  /** Owner decision of 2026-10-29 ("1번 진행"): turns whose start took the actor's open D7 question (`takePending`). */
  protected readonly nlClosedQuestions = new WeakSet<InboundMessage>();

  /** Background work that must start only after a turn's reply was handed back (by message object). */
  protected readonly nlAfterReply = new WeakMap<InboundMessage, () => Promise<void>>();

  /** The last background run started after a reply (tests await it; production never does). */
  lastAfterReplyRun: Promise<void> = Promise.resolve();

  /** ADR-0121 S2: the agent's shadow job queued for after a turn's reply (by message object). */
  protected readonly agentAfterReply = new WeakMap<InboundMessage, () => Promise<void>>();

  /** The last agent shadow job started after a reply (tests await it; production never does). */
  lastAgentAfterReplyRun: Promise<void> = Promise.resolve();

  /** A6: the turn's A6 decision (by message), completed with the handler's receipt in `respondTurnHandler`. */
  protected readonly nlActionTurns = new WeakMap<InboundMessage, { readonly audit: NlActionAudit; readonly language: 'ko' | 'en' }>();

  /** Denial outcomes this runtime made (by identity): never a grammar answer (no c-shadow job, no agreement line). */
  protected readonly surfaceDenials = new WeakSet<TurnHandlerOutcome>();

  constructor(
    protected readonly deps: ConversationRuntimeDeps,
    options: ConversationRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? now;
    this.gitRemoteEnabled = options.gitRemoteEnabled ?? false;
    this.gitMergeEnabled = options.gitMergeEnabled ?? false;
    this.longItemSummary = options.longItemSummary;
    const localities = options.imageUnderstandingLocalities;
    this.imagePolicy = typeof localities === 'function' ? localities : imageUnderstandingPolicyOf(localities);
    this.approvalDecisions = new ApprovalDecisionService(
      // Read through to the runtime's own deps object (the same collaborators, never a copy).
      {
        get approvals() { return deps.approvals; },
        get approvalFlow() { return deps.approvalFlow; },
        get scopeClarificationFlow() { return deps.scopeClarificationFlow; },
        get applyPreviewFlow() { return deps.applyPreviewFlow; },
        get credentialOverrideFlow() { return deps.credentialOverrideFlow; },
        get connectorWriteFlow() { return deps.connectorWriteFlow; },
        get composer() { return deps.composer; },
        get memory() { return deps.memory; },
        get sessions() { return deps.sessions; },
        get logger() { return deps.logger; },
        get surfaceGrants() { return deps.surfaceGrants; },
      },
      { clock: this.clock },
    );
    const registry = orderTurnHandlers(deps.turnHandlers ?? []);
    this.turnHandlerRegistry = registry;
    for (const handler of registry) {
      try {
        const topic = helpTopicOfLines(handler.helpLines ?? []);
        if (topic !== undefined) this.handlerHelpTopics.set(handler, topic);
      } catch {
        // A handler whose help lines cannot be read covers no help topic.
      }
    }
    this.turnHandlersByStage = {
      control: registry.filter((h) => h.stage === 'control'),
      'post-anchor': registry.filter((h) => h.stage === 'post-anchor'),
      'pre-classify': registry.filter((h) => h.stage === 'pre-classify'),
    };
    // ADR-0112 (CWR-2): the write flow's lines (only for writes it can perform) follow the registry's lines.
    this.contributedHelpLines = [...registry.flatMap((h) => h.helpLines ?? []), ...(deps.connectorWriteFlow?.helpLines ?? [])];
  }

  /** Milliseconds before a pending approval expires (ADR-0093); `<= 0` means expired. */
  protected remainingMs(approval: ApprovalRequest): number {
    return this.approvalDecisions.remainingMs(approval);
  }

  /** The pending-approval reminder (ADR-0093) — what is pending, 승인/거절, remaining time, 새 대화. */
  protected composePendingReminder(context: ConversationContext, approval: ApprovalRequest): OutboundMessage {
    return this.deps.composer.composePendingApprovalReminder(context, approval, this.remainingMs(approval));
  }

  /**
   * The anchored chain's pending reminder; while the operations UI is on it carries the confirmation reference line
   * (ADR-0113 D7). The history keeps the reminder without it.
   */
  protected async respondAnchoredReminder(
    message: InboundMessage,
    session: Session,
    approvalId: Id,
    anchor: ApplyPreviewAnchor,
    unavailable: OutboundMessage,
  ): Promise<TurnResult> {
    const fresh = await this.deps.approvals.get(approvalId);
    const reply = fresh ? this.composePendingReminder(message.context, fresh) : unavailable;
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    const shown = fresh
      ? this.approvalDecisions.withConfirmationReference(reply, fresh, ApprovalDecisionService.anchoredBinding(anchor), session.actorId)
      : reply;
    return { status: 'AWAITING_APPROVAL', reply: shown, sessionId: session.id };
  }

  /** A chat approval preview with the ADR-0113 D7 reference line while the operations UI is on (history unchanged). */
  protected previewWithReference(
    session: Session,
    reply: OutboundMessage,
    approval: ApprovalRequest,
    anchor: ApplyPreviewAnchor,
  ): OutboundMessage {
    return this.approvalDecisions.withConfirmationReference(reply, approval, ApprovalDecisionService.anchoredBinding(anchor), session.actorId);
  }

  /** The shared decision service's answer as this turn's result. */
  protected decisionTurn(session: Session, value: ApprovalDecisionReply): TurnResult {
    return { status: value.status, reply: value.reply, sessionId: session.id };
  }

  /** The chat surface's decision input for this turn (ADR-0113 D7: chat and the UI share one decision path). */
  protected chatDecision(message: InboundMessage, session: Session, actor: Actor): ApprovalDecisionInput {
    return { context: message.context, session, actor, surface: 'chat' };
  }

  /** Derive the approval holding this conversation, if any (ADR-0093) — the shared decision service's lookup. */
  protected findPendingApproval(session: Session): Promise<PendingApprovalLookup> {
    return this.approvalDecisions.findPending(session);
  }

  /**
   * Record an expired PENDING approval as denied (ADR-0093) — the shared decision service's expiry, under the shared
   * lock. `false` when another transition decided it first (nothing recorded; the lookup is stale).
   */
  protected expirePendingApproval(session: Session, lookup: PendingApprovalLookup): Promise<boolean> {
    return this.approvalDecisions.expire(session, lookup);
  }

  /**
   * A failure on a route that never reaches a workspace/git/command mutator (classification, work surface,
   * registration, analysis, chat). Same sanitized rendering as the `handle` backstop, but with the provable
   * `CONFIRMED_NOT_APPLIED` line — a chat failure must never say a change may have been applied.
   */
  protected failReadOnlyTurn(message: InboundMessage, session: Session, err: unknown): TurnResult {
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

  /**
   * Frame a TEST_EXECUTION outcome (ADR-0033; detail three-way branch added in ADR-0034). A command
   * that RAN → a **product test result** (pass/fail + detail), read via the existing
   * `CommandExecution` read path; `TIMED_OUT` → a distinct timeout reply (not a test verdict); a
   * command that never ran at all (allow-list refusal / system error, no `CommandExecution`) → an
   * execution-failure reply. The orchestrator's status contract is not reinterpreted — the runtime
   * only chooses which case applies and assembles raw facts; all text lives in `ResponseComposer`.
   */
  protected async frameTestResult(
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
      const detail = toTestResultDetail(exec);
      const reply = this.deps.composer.composeTestResult(message.context, { ...detail, passed });
      await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
      return { status: 'RESPONDED', reply, sessionId: session.id, executionOutcome: outcome };
    }
    if (exec && exec.status === CommandExecutionStatus.TIMED_OUT) {
      const detail = toTestResultDetail(exec);
      const reply = this.deps.composer.composeTestTimedOut(message.context, detail);
      return this.failComposed(message, session, reply, outcome);
    }
    // Command never ran at all (allow-list refusal → no CommandExecution, spawn/system error).
    return this.failComposed(message, session, this.deps.composer.composeCommandUnavailable(message.context), outcome);
  }

  protected async respondComposed(
    message: InboundMessage,
    session: Session,
    reply: OutboundMessage,
    outcome?: ExecutionOutcome,
  ): Promise<TurnResult> {
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id, ...(outcome ? { executionOutcome: outcome } : {}) };
  }

  protected async failComposed(
    message: InboundMessage,
    session: Session,
    reply: OutboundMessage,
    outcome?: ExecutionOutcome,
  ): Promise<TurnResult> {
    await this.deps.memory.recordAssistant(reply.text, message.context, session.id);
    return { status: 'FAILED', reply, sessionId: session.id, ...(outcome ? { executionOutcome: outcome } : {}) };
  }

  /**
   * The repository identity a remote step targets (ADR-0109 D2). Without the per-workspace resolver: the static
   * configured identity, unchanged (`not configured` when absent; no binding check — the existing per-step checks
   * apply). With it: the identity resolved right now from the workspace (`origin`, plus `remote` when the step uses
   * another remote) — a missing workspace root is `not configured`, a refusal or a resolver throw is a refusal (fail
   * closed), and an identity that differs from the one the approval bound (`bound`), or a missing binding when
   * `requireBound`, is `target-changed`. Never reads a URL or token itself.
   */
  protected async hostingIdentityFor(
    rootPath: string | undefined,
    opts: { remote?: string; bound?: RepositoryIdentity; requireBound?: boolean } = {},
  ): Promise<HostingIdentityLookup> {
    const hosting = this.deps.repositoryHosting;
    if (!hosting?.resolveIdentity) return hosting?.identity ? { ok: true, identity: hosting.identity } : { ok: false };
    if (!rootPath) return { ok: false };
    let resolution: WorkspaceRepositoryResolution;
    try {
      resolution = await hosting.resolveIdentity(rootPath, opts.remote);
    } catch {
      return { ok: false, refusal: 'unsupported-remote' };
    }
    if (resolution?.status !== 'resolved' || !resolution.identity) {
      return {
        ok: false,
        refusal: resolution?.status === 'refused' ? resolution.reason : 'unsupported-remote',
        ...(resolution?.status === 'refused' && typeof resolution.hint === 'string' ? { hint: resolution.hint } : {}),
      };
    }
    if (opts.bound ? !sameRepositoryIdentity(opts.bound, resolution.identity) : opts.requireBound === true) {
      return { ok: false, refusal: 'target-changed' };
    }
    return { ok: true, identity: resolution.identity };
  }

  /**
   * The reply for a failed {@link hostingIdentityFor} lookup: the fixed repository refusal (nothing ran, no token),
   * the fixed target-changed refusal (the approval no longer covers this repository), or the step's own
   * `not configured` reply.
   */
  protected respondHostingLookupFailure(
    message: InboundMessage,
    session: Session,
    lookup: Extract<HostingIdentityLookup, { ok: false }>,
    notConfigured: () => Promise<TurnResult>,
  ): Promise<TurnResult> {
    if (!lookup.refusal) return notConfigured();
    this.deps.logger.warn('remote step refused: workspace repository not allowlisted, unresolvable or changed', {
      reason: lookup.refusal,
      sessionId: session.id,
    });
    if (lookup.refusal === 'target-changed') {
      return this.failComposed(message, session, this.deps.composer.composeRepositoryTargetChanged(message.context));
    }
    return this.failComposed(
      message,
      session,
      this.deps.composer.composeRepositoryNotAllowed(message.context, lookup.refusal, lookup.hint),
    );
  }

  /**
   * ADR-0109 D2 gate for a remote step that has no hosting identity check of its own (push approval/execution, merge
   * and remote-cleanup approval). A no-op unless the per-workspace resolver is configured, so a deployment without it
   * behaves exactly as before. Returns the resolved identity when the step may continue, otherwise the reply.
   */
  protected async remoteRepositoryGate(
    message: InboundMessage,
    session: Session,
    rootPath: string | undefined,
    opts: { remote?: string; bound?: RepositoryIdentity; requireBound?: boolean },
    notConfigured: () => Promise<TurnResult>,
  ): Promise<{ identity?: RepositoryIdentity; reply?: TurnResult }> {
    if (!this.deps.repositoryHosting?.resolveIdentity) return {};
    const lookup = await this.hostingIdentityFor(rootPath, opts);
    if (!lookup.ok) return { reply: await this.respondHostingLookupFailure(message, session, lookup, notConfigured) };
    return { identity: lookup.identity };
  }

  /** Map an ExecutionOutcome to a TurnResult + recorded reply. */
  protected async replyForOutcome(
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

  // ── ADR-0122 surface permission grants: the one gate at every dispatch point ────────────────────────────────────

  protected surfaceGate(): SurfaceGate | undefined {
    return this.deps.surfaceGrants?.gate;
  }

  /** The enforcing gate for a channel turn; `undefined` with the gate off or absent, and in a DM (nothing checked or logged). */
  protected channelGate(context: ConversationContext): SurfaceGate | undefined {
    const gate = this.deps.surfaceGrants?.gate;
    return gate !== undefined && gate.enforced && !isSurfaceDirect(context) ? gate : undefined;
  }

  /** The gate's denial (logged, content-free) or `undefined` when allowed / not enforced / a DM. */
  protected surfaceDenied(
    context: ConversationContext,
    actor: Pick<Actor, 'metadata'>,
    groups: readonly SurfaceGroupId[],
    audit: SurfaceGateAudit,
  ): Extract<SurfaceDecision, { allow: false }> | undefined {
    const gate = this.channelGate(context);
    if (gate === undefined) return undefined;
    const decision = gate.decide(context, actor, groups, audit);
    return decision.allow ? undefined : decision;
  }

  /**
   * D7 / P2: whether this is a channel turn with the gate enforced AND the channel holds `group` (quiet: no log). False in
   * a DM and with the gate off or absent — callers lift a second-layer DM-only rule only on `true`.
   */
  protected channelHoldsGroup(context: ConversationContext, actor: Pick<Actor, 'metadata'>, group: SurfaceGroupId): boolean {
    const gate = this.channelGate(context);
    return gate !== undefined && decideSurface({ mode: gate.mode, context, actor, groups: [group] }).allow;
  }

  /** D2.4 (P2): the content-free permit of a channel turn with the gate enforced; `undefined` otherwise (DM, off, absent). */
  protected surfacePermitOf(context: ConversationContext, actor: Pick<Actor, 'metadata'>): SurfacePermit | undefined {
    const gate = this.channelGate(context);
    if (gate === undefined) return undefined;
    return { allowed: [...allowedSurfaceGroups({ mode: gate.mode, context, actor })] };
  }

  /** A quiet check (no log) for a lookup that only filters what it may name (another conversation's write). */
  protected surfaceBlocks(context: ConversationContext, actor: Pick<Actor, 'metadata'>, groups: readonly SurfaceGroupId[]): boolean {
    const gate = this.channelGate(context);
    return gate !== undefined && !decideSurface({ mode: gate.mode, context, actor, groups }).allow;
  }

  protected surfaceDenialText(text: string, denied: Extract<SurfaceDecision, { allow: false }>): string {
    return renderSurfaceDenied(denied, noticeLanguage(undefined, text));
  }

  /** D2.7: the fixed denial reply, recorded in short-term history as that fixed text; nothing was read. */
  protected surfaceDeniedTurn(message: InboundMessage, session: Session, denied: Extract<SurfaceDecision, { allow: false }>): Promise<TurnResult> {
    return this.respondComposed(message, session, outboundMessage(message.context, this.surfaceDenialText(message.text, denied)));
  }

  /** The denial as a handler reply (control: nothing recorded; post-anchor / pre-classify: recorded like any reply). */
  protected surfaceDenialOutcome(message: InboundMessage, denied: Extract<SurfaceDecision, { allow: false }>): TurnHandlerReply {
    const outcome: TurnHandlerReply = { reply: outboundMessage(message.context, this.surfaceDenialText(message.text, denied)) };
    this.surfaceDenials.add(outcome);
    return outcome;
  }

  /**
   * D2.5: a decision intercept (a pending approval, a scope question, a credential override, a pending write) in a
   * channel. "거절" / "취소" / a stop word always pass (they only reduce exposure and read nothing); anything else —
   * an approval or the reminder that shows the preview — needs the approval's group.
   */
  protected async surfaceDeniedDecision(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    groups: readonly SurfaceGroupId[],
  ): Promise<TurnResult | null> {
    if (this.channelGate(message.context) === undefined) return null;
    const decision = interpretDecision(message.text);
    if (decision === 'deny' || decision === 'cancel' || isPendingCancelUtterance(message.text)) return null;
    const denied = this.surfaceDenied(message.context, actor, groups, { path: 'approval' });
    return denied ? this.surfaceDeniedTurn(message, session, denied) : null;
  }

  /**
   * D2.3: one step of the state-bound code-change section, gated by its step group (PR status `github`, every other step
   * `code`) immediately before it runs — on the turn's snapshot and then on the live grants; a denied step replies with
   * the denial copy and leaves the anchor unchanged.
   */
  protected async stateBoundStep(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    step: StateBoundStep,
    run: () => Promise<TurnResult>,
  ): Promise<TurnResult> {
    const groups = [surfaceGroupOfStateStep(step)];
    const denied = this.surfaceDenied(message.context, actor, groups, { path: 'route' });
    if (denied) return this.surfaceDeniedTurn(message, session, denied);
    // Codex P1: the turn's actor snapshot may predate an owner-DM revoke that completed while this turn waited, so the
    // live grants are re-read (through the ActorMetadataStore) immediately before the step runs — a commit, push, PR,
    // merge, sync or branch delete never executes on a stale grant.
    if (this.channelGate(message.context) !== undefined) {
      try {
        await this.surfaceStillAllows(message.context, actor, groups);
      } catch (error) {
        if (!(error instanceof SurfaceDeniedError)) throw error;
        return this.surfaceDeniedTurn(message, session, error.decision);
      }
    }
    return run();
  }

  /**
   * D2.1 / D2.9: one turn handler behind the gate. In a channel with the gate enforced: the handler's pure claim is asked
   * first — a denied `reply` claim ends the turn with the denial (handle() never runs), a denied `skip` claim falls
   * through; an outcome without a claim (fail closed) or whose catalog equivalent is outside the claim is replaced by the
   * denial and logged as a defect. Otherwise exactly `handle(ctx)`.
   */
  protected async runGatedHandler(handler: ConversationTurnHandler, ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    const gate = this.channelGate(ctx.message.context);
    if (gate === undefined) return handler.handle(ctx);
    let claim: SurfaceClaim | null = null;
    if (typeof handler.surfaceClaim === 'function') {
      try {
        claim = handler.surfaceClaim(ctx);
      } catch {
        claim = null;
      }
    }
    if (claim !== null) {
      const decision = gate.decide(ctx.message.context, ctx.actor, claim.groups, { path: 'grammar', handlerId: handler.id });
      if (!decision.allow) return claim.onDeny === 'skip' ? null : this.surfaceDenialOutcome(ctx.message, decision);
    }
    const outcome = await handler.handle(ctx);
    if (outcome === null) return null;
    if (claim === null) {
      gate.logMismatch({ handlerId: handler.id, claimed: 'none' });
      gate.decide(ctx.message.context, ctx.actor, [], { path: 'grammar', handlerId: handler.id });
      return this.surfaceDenialOutcome(ctx.message, { allow: false, reason: 'unclassified' });
    }
    const selection = outcome.kind === 'write-draft' ? undefined : outcome.nlSelection;
    if (selection !== undefined) {
      const claimed = claim.groups as readonly SurfaceGroupId[];
      if (surfaceGroupsOfSelection(selection).some((id) => !claimed.includes(id))) {
        gate.logMismatch({ handlerId: handler.id, claimed: claimed.join(','), entryId: selection.entryId });
        return this.surfaceDenialOutcome(ctx.message, { allow: false, reason: 'unclassified' });
      }
    }
    return outcome;
  }

  /** Phase C: the handler's claim denied with `reply` in this channel, as the denial outcome; otherwise `undefined`. */
  protected deniedReplyClaim(handler: ConversationTurnHandler, ctx: TurnHandlerContext): TurnHandlerReply | undefined {
    const gate = this.channelGate(ctx.message.context);
    if (gate === undefined || typeof handler.surfaceClaim !== 'function') return undefined;
    let claim: SurfaceClaim | null;
    try {
      claim = handler.surfaceClaim(ctx);
    } catch {
      return undefined;
    }
    if (claim === null || claim.onDeny !== 'reply') return undefined;
    const decision = gate.decide(ctx.message.context, ctx.actor, claim.groups, { path: 'grammar', handlerId: handler.id });
    return decision.allow ? undefined : this.surfaceDenialOutcome(ctx.message, decision);
  }

  /** D2.2: an `ask` about one entry, gated like that entry (A6: the A6 copy, and the saved question is closed). */
  protected async surfaceDeniedAsk(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    decision: { readonly entryId?: NlCatalogEntry['id'] },
  ): Promise<TurnResult | undefined> {
    if (decision.entryId === undefined || this.channelGate(message.context) === undefined) return undefined;
    const denied = this.surfaceDenied(message.context, actor, surfaceGroupsOfSelection({ entryId: decision.entryId, args: {} }), {
      path: 'selection',
      entryId: decision.entryId,
    });
    if (denied === undefined) return undefined;
    // The question the service saved during this turn must not be answered later in this channel (a "1" would otherwise
    // save a preference before the execution gate): drop it from the live session row, whatever this turn's snapshot holds.
    await this.deps.nlSelection?.dropPending?.(session.id);
    const text = denied.reason === 'dm-only' && denied.group === 'nl-actions'
      ? renderNlActionDmOnly(languageOf(message.text))
      : this.surfaceDenialText(message.text, denied);
    return this.respondComposed(message, session, outboundMessage(message.context, text));
  }

  /**
   * D2.5: the live grant (re-read through the deps' fresh actor read, never this turn's snapshot) still allows `groups`
   * here; otherwise it throws {@link SurfaceDeniedError}. A failed read refuses (fail closed). Logged like any decision.
   */
  protected async surfaceStillAllows(context: ConversationContext, actor: Actor, groups: readonly SurfaceGroupId[]): Promise<boolean> {
    const gate = this.channelGate(context);
    if (gate === undefined) return true;
    let fresh: Pick<Actor, 'metadata'> | null;
    try {
      fresh = this.deps.surfaceGrants?.freshActor !== undefined ? await this.deps.surfaceGrants.freshActor(actor.id) : actor;
    } catch {
      fresh = null;
    }
    // Fail closed: an unreadable owner is a channel without grants.
    const decision = gate.decide(context, fresh ?? {}, groups, { path: 'approval' });
    if (decision.allow) return true;
    throw new SurfaceDeniedError(decision);
  }

  /** D2.5: a strong side effect's last-moment check on the live grants; the denial turn, or `null` to proceed. */
  protected async surfaceRecheckBeforeCall(message: InboundMessage, session: Session, actor: Actor, step: StateBoundStep): Promise<TurnResult | null> {
    if (this.channelGate(message.context) === undefined) return null;
    try {
      await this.surfaceStillAllows(message.context, actor, [surfaceGroupOfStateStep(step)]);
      return null;
    } catch (error) {
      if (!(error instanceof SurfaceDeniedError)) throw error;
      return this.surfaceDeniedTurn(message, session, error.decision);
    }
  }

  /** D2.2: the groups of a validated selection (a `jira.release` link in the owner's own non-quoted words counts). */
  protected surfaceGroupsOfSelected(command: { readonly entryId: NlCatalogEntry['id']; readonly args: NlSelectedCommand['args'] }, message: InboundMessage): readonly SurfaceGroupId[] {
    if (command.entryId !== 'jira.release') return surfaceGroupsOfSelection(command);
    const prepared = prepareSelectionInput(message.text, 0, message.quotedRanges ?? []);
    const grounding = 'skip' in prepared ? '' : prepared.groundingText;
    return surfaceGroupsOfSelection(command, { releaseLink: parseJiraReleaseLinks(grounding).length > 0 });
  }

  /**
   * What the exact switch phrase controls on this runtime (the caller checks the owner DM), or `undefined` when it is not
   * recognized: A6 actions acting in `active` selection, the agent not `off`, the channel grants enforced. With all three
   * off the phrase is ordinary text, so no near miss is answered and no honest-chat control fact is given. Reads
   * `agentRuns.mode` only.
   */
  protected switchScope(): NlControlScope | undefined {
    const nl = this.deps.nlSelection;
    const actions = nl?.handleSwitchPhrase !== undefined && nl.mode === 'active' && nl.actionLevel !== undefined && nl.actionLevel() !== 'off';
    const agent = this.deps.agentRuns !== undefined && this.deps.agentRuns.mode !== 'off';
    const grants = this.surfaceGate()?.enforced === true && this.deps.surfaceGrants?.service !== undefined;
    return actions || agent || grants ? { actions, agent, grants } : undefined;
  }

  /**
   * The reply to a near miss of the switch phrase, or `undefined` when the message is none: the fixed hint naming the exact
   * phrase. Nothing changes (owner decision 2026-10-20: the switch acts only on the exact phrase, stop and resume alike).
   */
  protected handleSwitchNearMiss(message: InboundMessage): string | undefined {
    const near = nearMissActionSwitchPhrase(message.text);
    if (near === undefined) return undefined;
    try {
      this.deps.logger.info('nl_action.switch_near_miss', { kind: near.kind, ...(near.kind !== 'ambiguous' ? { state: near.state } : {}) });
    } catch {
      // best-effort
    }
    return renderActionSwitchHint(near.kind === 'ambiguous' ? ['stopped', 'running'] : [near.state]);
  }

  /** D4.6: while the channel grants are enforced, the A6 switch reply also says the channel grants followed. */
  protected withSurfaceSwitchSuffix(text: string, reply: string): string {
    if (this.surfaceGate()?.enforced !== true) return reply;
    const wanted = parseActionSwitchPhrase(text);
    if (wanted === undefined) return reply;
    const language = languageOf(text);
    return reply === renderActionSwitchReply(wanted, language) ? `${reply}\n${renderSurfaceSwitchSuffix(wanted, language)}` : reply;
  }

  /**
   * ADR-0121 S2: while the agent mode is not `off`, the A6 switch reply (saved) also says the agent followed: the same
   * record stops and resumes both. `withSuffix` is the reply after the D4.6 channel-grants suffix.
   */
  protected withAgentSwitchSuffix(text: string, saved: string, withSuffix: string): string {
    const agent = this.deps.agentRuns;
    if (agent === undefined || agent.mode === 'off') return withSuffix;
    const wanted = parseActionSwitchPhrase(text);
    if (wanted === undefined || saved !== renderActionSwitchReply(wanted, languageOf(text))) return withSuffix;
    const suffix = agent.switchSuffix(text);
    return suffix === undefined ? withSuffix : `${withSuffix}\n${suffix}`;
  }

  /** ADR-0121 S2 / D4.6: the agent's own switch reply (saved) also says the channel grants followed, while they are enforced. */
  protected withAgentSurfaceSuffix(text: string, reply: string): string {
    if (this.surfaceGate()?.enforced !== true) return reply;
    const wanted = parseActionSwitchPhrase(text);
    if (wanted === undefined) return reply;
    const language = languageOf(text);
    return reply === renderAgentSwitchReply(wanted, language) ? `${reply}\n${renderSurfaceSwitchSuffix(wanted, language)}` : reply;
  }

  protected responded(session: Session, reply: OutboundMessage, workFacts?: TurnWorkFacts): TurnResult {
    return { status: 'RESPONDED', reply, sessionId: session.id, ...(workFacts ? { workFacts } : {}) };
  }
}
