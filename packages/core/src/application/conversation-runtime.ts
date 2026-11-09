import { detectInternalActionStatusTurn, noticeLanguage } from './chat-policy/internal-action-vocabulary';
import { CREDENTIAL_REJECTION_REASON, containsCredentialMaterial } from './credential-guard';
import { imageAttachmentsOf } from './image-understanding';
import { currentTurnAttachmentsOf, hasEffectiveText, hasNoUsableAttachment, renderAttachmentsNotRead } from './attachment-context';
import { unnegatedMatch } from './intent-negation';
import { isChainCompanionRequest, isGitTopicOnlyMention } from './git-request-shape';
import { isAcceptedExecutionPhrase } from './execution-command-guard';
import {
  isAnyConnectorWriteExecutionPhrase,
  connectorWriteOperationsOfPhrase,
  connectorWriteOperationsAskedAbout,
  connectorWriteOperationsNamedLoosely,
  isBareExecutionQuestionOrNegation,
  isBareExecutionRequest,
} from './connector-writes/connector-write-flow';
import { isDirectConversation, joinBody, messageBody, outboundBody, outboundMessage, withOutboundBody } from './message-rendering';
import { parseActionSwitchPhrase, renderActionSwitchReply } from './nl-routing/action-switch';
import { interpretStrayDecisionUtterance } from './approval-decision';
import { anchorAfterRejection } from './approval-decision-service';
import { safeRequestId, toSafeError } from './safe-error';
import { PENDING_APPROVAL_TTL_MS, detectConversationControl } from './conversation-commands';
import { chatIntentOf, detectProjectRegistration } from './intent-classifier';
import { type NlClassBProbe } from './nl-routing/catalog';
import { languageOf } from './nl-routing/nl-selection-service';
import { renderNoOpenQuestion } from './nl-routing/last-reply';
import { LAST_SELECTION_METADATA_KEY, isActionPendingQuestion } from './nl-routing/selection-state';
import { SURFACE_GRANT_PENDING_METADATA_KEY } from './surface-grants/surface-grant-service';
import { surfaceGroupOfStateStep, surfaceGroupsOfWriteOperation } from './surface-grants/surface-group-map';
import type { Actor, InboundMessage, Intent, OutboundMessage, Session } from '../domain';
import { CONNECTOR_WRITE_OPERATIONS, type ConversationTurnHandler } from '../ports';
import { nlLocalListTarget } from './nl-routing/action-entries';
import { isStrayCredentialOverridePhrase } from './credential-override';
import type { NlChatFacts, NlEarlySelection } from './conversation-runtime/internal-types';
import type { TurnResult } from './conversation-runtime/types';
import { SurfaceDeniedError, withoutSessionMetadataKey } from './conversation-runtime/helpers';
import {
  CLEANUP_BRANCH_WORD,
  CLEANUP_VERB,
  DEPLOY_ONLY_WORDS,
  MAIN_SYNC_MENTION,
  MERGE_WORD,
  POST_PUSH_CHAIN_STATUSES,
  PR_CREATED_COMPANION_WORDS,
  PUSH_EXECUTION_WORDS,
} from './conversation-runtime/intent-words';
import {
  explicitDurableMemoryContent,
  explicitNewFileTarget,
  interpretApplyIntent,
  interpretBranchCleanupIntent,
  interpretCommitExecutionIntent,
  interpretCommitIntent,
  interpretDecision,
  interpretFinalApplyIntent,
  interpretGitPreviewIntent,
  interpretMainSyncIntent,
  interpretMergeExecutionIntent,
  interpretMergeIntent,
  interpretMergeStatusIntent,
  interpretNoAnchorPushRequest,
  interpretNoChainMergeRequest,
  interpretPatchIntent,
  interpretPostApplyValidationIntent,
  interpretPrIntent,
  interpretPrStatusIntent,
  interpretPushExecutionIntent,
  interpretPushIntent,
  interpretRemoteBranchCleanupExecutionIntent,
  interpretRemoteBranchCleanupIntent,
  isFreshCreateResend,
  isHowToQuestionWithoutTarget,
  isPreviewDiscardUtterance,
  isWorkChatLookupCommand,
  lapsedConnectorWriteStep,
  nlSelectionRoute,
  nlWorkSurfaceRoute,
  parseCommitMessage,
} from './conversation-runtime/turn-intents';
import { ConversationRuntimeExecutionImageLayer } from './conversation-runtime/execution-image-layer';
export {
  filterInScopeChanges,
  toCodeChangePreview,
  toCodeDiffPreview,
  SurfaceDeniedError,
  nlConfirmToRecord,
  nlHeldItemWordsFor,
} from './conversation-runtime/helpers';

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

export type {
  RuntimeTurnStatus,
  TurnResult,
  ApprovalDecisionKind,
  ApprovalFlow,
  PendingScopeClarification,
  ScopeClarificationFlow,
  ApplyPreviewAnchorStatus,
  ApplyPreviewAnchor,
  ApplyPreviewFlow,
  ApplyPreviewAnchorIdentity,
  ConversationRuntimeDeps,
  ConversationRuntimeOptions,
  LongItemSummaryOptions,
} from './conversation-runtime/types';

/** ADR-0122 D2.3: the anchor statuses whose pending decision intercepts every turn. */
const PENDING_DECISION_ANCHOR_STATUSES: ReadonlySet<string> = new Set([
  'AWAITING_APPROVAL',
  'COMMIT_APPROVAL_PENDING',
  'PUSH_APPROVAL_PENDING',
  'PR_APPROVAL_PENDING',
  'MERGE_APPROVAL_PENDING',
  'REMOTE_BRANCH_CLEANUP_PENDING',
]);

export class ConversationRuntime extends ConversationRuntimeExecutionImageLayer {
  // Public pure seams of the intent interpreters (the tests and callers use them as statics); the implementations live in
  // './conversation-runtime/turn-intents'.
  static interpretDecision(...a: Parameters<typeof interpretDecision>): ReturnType<typeof interpretDecision> { return interpretDecision(...a); }
  static interpretApplyIntent(...a: Parameters<typeof interpretApplyIntent>): ReturnType<typeof interpretApplyIntent> { return interpretApplyIntent(...a); }
  static interpretPatchIntent(...a: Parameters<typeof interpretPatchIntent>): ReturnType<typeof interpretPatchIntent> { return interpretPatchIntent(...a); }
  static interpretFinalApplyIntent(...a: Parameters<typeof interpretFinalApplyIntent>): ReturnType<typeof interpretFinalApplyIntent> { return interpretFinalApplyIntent(...a); }
  static interpretPostApplyValidationIntent(...a: Parameters<typeof interpretPostApplyValidationIntent>): ReturnType<typeof interpretPostApplyValidationIntent> { return interpretPostApplyValidationIntent(...a); }
  static interpretGitPreviewIntent(...a: Parameters<typeof interpretGitPreviewIntent>): ReturnType<typeof interpretGitPreviewIntent> { return interpretGitPreviewIntent(...a); }
  static interpretCommitIntent(...a: Parameters<typeof interpretCommitIntent>): ReturnType<typeof interpretCommitIntent> { return interpretCommitIntent(...a); }
  static interpretCommitExecutionIntent(...a: Parameters<typeof interpretCommitExecutionIntent>): ReturnType<typeof interpretCommitExecutionIntent> { return interpretCommitExecutionIntent(...a); }
  static interpretPushIntent(...a: Parameters<typeof interpretPushIntent>): ReturnType<typeof interpretPushIntent> { return interpretPushIntent(...a); }
  static interpretNoAnchorPushRequest(...a: Parameters<typeof interpretNoAnchorPushRequest>): ReturnType<typeof interpretNoAnchorPushRequest> { return interpretNoAnchorPushRequest(...a); }
  static interpretPushExecutionIntent(...a: Parameters<typeof interpretPushExecutionIntent>): ReturnType<typeof interpretPushExecutionIntent> { return interpretPushExecutionIntent(...a); }
  static interpretPrIntent(...a: Parameters<typeof interpretPrIntent>): ReturnType<typeof interpretPrIntent> { return interpretPrIntent(...a); }
  static interpretPrStatusIntent(...a: Parameters<typeof interpretPrStatusIntent>): ReturnType<typeof interpretPrStatusIntent> { return interpretPrStatusIntent(...a); }
  static isWorkChatLookupCommand(...a: Parameters<typeof isWorkChatLookupCommand>): ReturnType<typeof isWorkChatLookupCommand> { return isWorkChatLookupCommand(...a); }
  static interpretMergeIntent(...a: Parameters<typeof interpretMergeIntent>): ReturnType<typeof interpretMergeIntent> { return interpretMergeIntent(...a); }
  static interpretNoChainMergeRequest(...a: Parameters<typeof interpretNoChainMergeRequest>): ReturnType<typeof interpretNoChainMergeRequest> { return interpretNoChainMergeRequest(...a); }
  static interpretMergeExecutionIntent(...a: Parameters<typeof interpretMergeExecutionIntent>): ReturnType<typeof interpretMergeExecutionIntent> { return interpretMergeExecutionIntent(...a); }
  static interpretMergeStatusIntent(...a: Parameters<typeof interpretMergeStatusIntent>): ReturnType<typeof interpretMergeStatusIntent> { return interpretMergeStatusIntent(...a); }
  static interpretMainSyncIntent(...a: Parameters<typeof interpretMainSyncIntent>): ReturnType<typeof interpretMainSyncIntent> { return interpretMainSyncIntent(...a); }
  static interpretRemoteBranchCleanupIntent(...a: Parameters<typeof interpretRemoteBranchCleanupIntent>): ReturnType<typeof interpretRemoteBranchCleanupIntent> { return interpretRemoteBranchCleanupIntent(...a); }
  static interpretRemoteBranchCleanupExecutionIntent(...a: Parameters<typeof interpretRemoteBranchCleanupExecutionIntent>): ReturnType<typeof interpretRemoteBranchCleanupExecutionIntent> { return interpretRemoteBranchCleanupExecutionIntent(...a); }
  static interpretBranchCleanupIntent(...a: Parameters<typeof interpretBranchCleanupIntent>): ReturnType<typeof interpretBranchCleanupIntent> { return interpretBranchCleanupIntent(...a); }
  static parseCommitMessage(...a: Parameters<typeof parseCommitMessage>): ReturnType<typeof parseCommitMessage> { return parseCommitMessage(...a); }
  static explicitNewFileTarget(...a: Parameters<typeof explicitNewFileTarget>): ReturnType<typeof explicitNewFileTarget> { return explicitNewFileTarget(...a); }

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
      let result = await this.handleInner(message);
      // A6 R5a §3.2 `none`: a turn that ended an unanswered preview says so before its own reply.
      const prefix = this.nlDeicticPrefix.get(message);
      if (prefix !== undefined) result = { ...result, reply: withOutboundBody(result.reply, messageBody(prefix, '\n', outboundBody(result.reply))) };
      this.holdNlShownItemWords(message, result);
      await this.settleNlLastSelection(message);
      await this.recordNlLastTurn(message);
      await this.recordNlLastReply(message);
      this.startAfterReply(message);
      return result;
    } catch (err) {
      // An error turn ends the follow-up window too: whatever was recorded this turn no longer describes a shown listing.
      await this.settleNlLastSelection(message, true).catch(() => undefined);
      this.nlReplyKinds.set(message, { kind: 'note' });
      await this.recordNlLastTurn(message).catch(() => undefined);
      // The sanitized error below is not a chat reply, whatever route the turn was on.
      this.nlChatReplies.delete(message);
      await this.recordNlLastReply(message).catch(() => undefined);
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
    // ADR-0122 D4.2 (Codex P2): the pending channel grant as this turn's FIRST read saw it, before the touch below returns
    // the live row — a confirmation is bound to the question that existed when the turn began.
    const grantPendingSeen = session.metadata?.[SURFACE_GRANT_PENDING_METADATA_KEY];
    // ADR-0113 D7: the activity touch runs under the shared session write lock, field-scoped on the live row, so this
    // turn's snapshot never overwrites an operations-UI decision's re-anchor; the turn continues on the touched copy.
    session = (await this.deps.sessions.touch(session)) ?? session;
    // A6 R5a: who and where this turn is, for `quoky.lastTurn` at the end of the turn (nothing is written while off).
    this.nlTurnFacts.set(message, { sessionId: session.id, actorId: actor.id });
    // ADR-0120 D7: an open selection question ends with this owner turn whatever route answers it; selection below gets
    // the question only when the turn reaches it (`active` only; nothing is written when there is none).
    const nlPending = this.deps.nlSelection?.takePending ? await this.deps.nlSelection.takePending(session, actor.id, this.clock()) : undefined;
    // Owner decision of 2026-10-29 ("1번 진행"): this turn ended this actor's open question; if chat answers the turn, the
    // question was closed without an answer (an answer is never chat), see `quoky.lastReply` `questionClosedAt`.
    if (nlPending !== undefined && nlPending !== null) this.nlClosedQuestions.add(message);
    // ADR-0120 follow-up: `lastSelection` must describe the listing of the LAST turn only; see `settleNlLastSelection`.
    if (this.deps.nlSelection?.mode === 'active' && session.metadata?.[LAST_SELECTION_METADATA_KEY] !== undefined) {
      this.nlTurns.set(message, { sessionId: session.id, keep: false });
    }

    // (0-) ADR-0112 (CWR-2) lazy expiry, like ADR-0093's for a pending approval: an approved connector-write grant never
    // executed, or a numbered choice never answered, within the lifetime is closed here, before any lookup, and the
    // pointer it displaced is handed back — mirrored on this turn's copy so the restored chain (e.g. an open code-change
    // anchor) routes on this very turn and no later save re-points the session at the closed anchor.
    const lapsedWrite = (await this.deps.connectorWriteFlow?.releaseExpired(session, this.clock())) ?? null;
    if (lapsedWrite) session = { ...session, activeTaskId: lapsedWrite.activeTaskId };

    // (0) Conversation control + pending-approval lifetime (ADR-0093) — BEFORE memory capture, approval/anchor
    // routing and classification, in every conversation state. Expiry is lazy (no scheduler): an expired
    // PENDING approval is recorded denied on this turn. Control phrases take precedence: help/reset still run
    // (with the expiry notice prepended); any other turn gets only the expiry notice.
    const control = detectConversationControl(message.text);
    let lookup = await this.findPendingApproval(session);
    let expiryNotice: OutboundMessage | null = null;
    if (lookup.pending && this.remainingMs(lookup.pending) <= 0) {
      if (await this.expirePendingApproval(session, lookup)) {
        expiryNotice = this.deps.composer.composeApprovalExpired(
          message.context,
          lookup.pending,
          PENDING_APPROVAL_TTL_MS,
        );
        // ADR-0112: the expired write's anchor handed the pointer back; mirror it on this turn's copy.
        if (lookup.connectorWrite) session = { ...session, activeTaskId: lookup.connectorWrite.anchor.previousActiveTaskId };
      } else {
        // ADR-0113 D7: another transition (the operations UI) decided it first under the shared lock — this turn's
        // session and lookup are stale; re-derive both from the live state.
        session = await this.deps.sessions.openForContext(message.context, actor.id);
        lookup = await this.findPendingApproval(session);
      }
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
    // ADR-0120 amendment A2: a Class B listing grammar may decline only when selection would run for this turn.
    if (
      this.deps.nlSelection?.yieldsToSelection !== undefined &&
      this.deps.nlSelection.grammarYieldEnabled?.() === true &&
      !lookup.pending &&
      (await this.nlYieldsToSelection(session, actor))
    ) {
      this.nlYield.add(message);
    }
    // ADR-0120 amendment A6-D3: the owner's kill-switch phrase (`에이전트 중지` / `에이전트 재개`, Class A, owner DM, every
    // state). Recognized only while QUOKY_NL_ACTIONS is not `off` (with `off` the text is routed exactly as before).
    if (this.deps.nlSelection?.handleSwitchPhrase !== undefined && isDirectConversation(message.context) && !expiryNotice) {
      const switched = await this.deps.nlSelection.handleSwitchPhrase(actor, message.text, this.clock());
      if (switched !== undefined) {
        const reply = this.withAgentSwitchSuffix(message.text, switched, this.withSurfaceSwitchSuffix(message.text, switched));
        // A6-D3 amendment (2026-11-03): a saved stop also closes the owner's open approvals of the governed kinds and lists them.
        const stopped = parseActionSwitchPhrase(message.text) === 'stopped' && switched === renderActionSwitchReply('stopped', languageOf(message.text));
        const notice = stopped ? await this.stopOpenGovernedApprovals(actor, message.text) : undefined;
        return this.responded(session, outboundMessage(message.context, notice === undefined ? reply : joinBody([reply, notice])));
      }
    }
    // ADR-0121 S2 (D7, reused switch): while QUOKY_AGENT_MODE is not `off`, the same phrase (owner DM, every state) also when
    // A6 actions are off; it saves the same `quoky.actionSwitch` record. With `off` (or absent) the text routes as before.
    if (this.deps.agentRuns !== undefined && this.deps.agentRuns.mode !== 'off' && isDirectConversation(message.context) && !expiryNotice) {
      const switched = await this.deps.agentRuns.handleSwitchPhrase(actor, message.text, this.clock());
      if (switched !== undefined) return this.responded(session, outboundMessage(message.context, this.withAgentSurfaceSuffix(message.text, switched)));
    }
    // Live DM test 2026-10-20: a near miss of the switch phrase ("에이ㄴ트 재개", "에이전트 재") while the exact phrase is
    // recognized (owner DM, every state, like the phrase) gets the exact phrase instead of chat. It never switches (owner
    // decision 2026-10-20: exact phrase only, both directions). Nothing is recorded, as for the phrase itself.
    if (isDirectConversation(message.context) && !expiryNotice && this.switchScope() !== undefined) {
      const nearMiss = this.handleSwitchNearMiss(message);
      if (nearMiss !== undefined) return this.responded(session, outboundMessage(message.context, nearMiss));
    }
    // ADR-0122 D4 / D4.6: while QUOKY_CHANNEL_GRANTS=enforce, the kill-switch phrase (owner DM, also with A6 actions off)
    // and the owner's anchored channel-permission phrases, in every state, before the control handlers. Nothing is
    // recorded (like the kill switch). With `off` (or absent) the text routes exactly as before.
    const surfaceService = this.surfaceGate()?.enforced === true ? this.deps.surfaceGrants?.service : undefined;
    // CA P2: a turn that answers an approval expiry still ends a pending grant ("any other message"); it never confirms.
    if (surfaceService?.handleGrantPending !== undefined && expiryNotice) {
      const ended = await surfaceService.handleGrantPending(message, session, actor, this.clock(), { cancelOnly: true, seenPending: grantPendingSeen });
      if (ended?.cleared === true) session = withoutSessionMetadataKey(session, SURFACE_GRANT_PENDING_METADATA_KEY);
    }
    if (surfaceService !== undefined && !expiryNotice) {
      const switched = await surfaceService.handleSwitchPhrase(actor, message, this.clock());
      if (switched !== undefined) return this.responded(session, outboundMessage(message.context, switched));
      // D4.2 (P2): `허용 실행` saves a pending grant of this channel; any other message ends it and routes as before.
      if (surfaceService.handleGrantPending !== undefined) {
        const pendingGrant = await surfaceService.handleGrantPending(message, session, actor, this.clock(), { seenPending: grantPendingSeen });
        if (pendingGrant?.reply !== undefined) return this.responded(session, outboundMessage(message.context, pendingGrant.reply));
        if (pendingGrant?.cleared === true) session = withoutSessionMetadataKey(session, SURFACE_GRANT_PENDING_METADATA_KEY);
      }
      const phrase = await surfaceService.handlePhrase(message, actor, this.clock(), session);
      if (phrase !== undefined) return this.responded(session, outboundMessage(message.context, phrase));
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
        expiryNotice && lookup.applyAnchor ? anchorAfterRejection(lookup.applyAnchor) : lookup.applyAnchor,
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
    this.nlTurnFacts.set(message, { sessionId: session.id, actorId: actor.id, memoryId: userMemory.id });
    if (expiryNotice) {
      await this.deps.memory.recordAssistant(expiryNotice.text, message.context, session.id);
      return { status: 'DENIED', reply: expiryNotice, sessionId: session.id };
    }
    // ADR-0112: the follow-up the lapsed write was waiting for (its exact execution phrase, or a choice number) is told
    // that it lapsed — never run, and never handed to a model as a bare "1".
    const lapsedReply = lapsedWrite ? lapsedConnectorWriteStep(lapsedWrite, message.text) : null;
    if (lapsedReply) return this.respondConnectorWriteStep(message, session, lapsedReply, '');

    // ADR-0120 amendment A6: an open A6 question is answered before any grammar ("3", "요약" must not be read as anything
    // else), and the anchored `되돌리기` (owner decision 8) runs the undo with no selector call. Both only while actions are
    // acting and no approval is pending; with QUOKY_NL_ACTIONS `off` neither exists.
    if (!lookup.pending && this.deps.nlSelection?.actionsActing?.(actor) === true) {
      // A6 R5a: the owner's answer to a deictic-write preview or question (no selector call), before anything else.
      const deictic = await this.handleDeicticDraft(message, session, actor, lookup.applyAnchor, userMemory.id, isActionPendingQuestion(nlPending));
      if (deictic !== undefined) return deictic;
      const early = await this.handleEarlyNlAction(message, session, actor, lookup.applyAnchor, userMemory.id, nlPending);
      if (early !== undefined) return early;
    }

    // (A) Approval-decision routing — ONLY when a pending approval is derived for this session.
    const pending = lookup.planPending;
    if (pending) {
      // ADR-0122 D2.5: the code-work approval re-checks its group at every decision step (deny / cancel always pass).
      const deniedPlan = await this.surfaceDeniedDecision(message, session, actor, ['code']);
      if (deniedPlan) return deniedPlan;
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
      // W1-L01 (live QA): a how-to question that names no file ("완료 처리 어떻게 해?") is a new question, not the
      // reply naming the file — routed normally, it reaches the `pre-classify` help-intent handler or chat.
      if (
        !detectProjectRegistration(message.text) &&
        !isFreshCreateResend(message.text) &&
        !isHowToQuestionWithoutTarget(message.text)
      ) {
        const deniedScope = await this.surfaceDeniedDecision(message, session, actor, ['code']);
        if (deniedScope) return deniedScope;
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
      const deniedOverride = await this.surfaceDeniedDecision(message, session, actor, ['code']);
      if (deniedOverride) return deniedOverride;
      return this.handleCredentialOverrideTurn(message, session, actor, override);
    }
    if (override?.state === 'consumed' && isStrayCredentialOverridePhrase(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeCredentialOverrideAlreadyUsed(message.context));
    }

    // (A2c) Connector-write routing (ADR-0112 D5/D6, CWR-2) — same position class as the override: a PENDING CRITICAL
    // write approval intercepts EVERY turn (decision flow only); an approved grant runs ONLY on its exact execution
    // phrase; a numbered choice is next-turn-only; a finished write answers a repeated phrase without sending again.
    // Anything else falls through to normal routing (the anchor stays, except an abandoned choice).
    let applyAnchor = lookup.applyAnchor;
    if (lookup.connectorWrite && this.deps.connectorWriteFlow) {
      const handled = await this.handleConnectorWriteAnchorTurn(message, session, actor, lookup.connectorWrite);
      if (handled === 'released') {
        // The anchor was closed and handed its pointer back: mirror it and read the restored chain for this turn.
        session = { ...session, activeTaskId: lookup.connectorWrite.anchor.previousActiveTaskId };
        applyAnchor = await this.deps.applyPreviewFlow.findAnchor(session);
      } else if (handled) {
        return handled;
      }
    }

    // (A3) Apply-preview routing (Sprint 2s, ADR-0040) — checked after approvalFlow/scopeClarificationFlow
    // so neither is ever pre-empted. (All three were already read, in this order, by findPendingApproval.)
    // (QA-V2 post-connect) an explicit work-chat lookup/search command ("Confluence에서 배포 검색") is never captured by the
    // anchored-chain companion/deploy/merge-word replies below; it falls through to the work-chat handler. Pending-approval
    // intercepts and execution allow-list gates above/below are untouched.
    const workLookup = isWorkChatLookupCommand(message.text);
    // (live QA 2026-10-07) A concept question or topic mention about a git operation ("git rebase와 merge 차이를 간단히
    // 설명해줘", "머지 전략 비교해줘", "explain git merge") is never captured by the anchored chain's bare-word replies
    // (already approved / already merged / unsupported companion / execution-phrase hint) either; it reaches chat. The
    // pending-approval intercepts and the execution allow-list gates are untouched.
    // (live QA 2026-10-07, LRN-2 "예시 1 수정: … 담당자와 기한을 함께 적어요" at PR_CREATED) An explicit deterministic command
    // of a registered turn handler — memory / learning / to-do / work-chat / reminder / "기억해:" — is never hijacked by
    // the chain's word-based detectors: they read an empty text for it, so it reaches its handler. Pending-approval
    // intercepts above and the exact execution allow-list gates (which read `message.text`) are untouched.
    // (live test 2, A09) A sentence that names Quoky's own to-do or reminder list as the place of its write ("'시안 2차 피드백
    // 반영' 할 일로 등록해줘") is a local-list request: the chain's word detectors (the apply word 반영, commit, merge …) read
    // an empty text for it too, so it reaches the to-do / reminder routes. Quoted content is not read for the list: a list
    // phrase inside quotes never counts, a quoted title before a real list command does. The approval and allow-list gates hold.
    const explicitCommand = this.isExplicitTurnHandlerCommand(message.text) || nlLocalListTarget(message.text, message.quotedRanges) !== undefined;
    const chainText = explicitCommand ? '' : message.text;
    const bareChainWordsOff = workLookup || explicitCommand || isGitTopicOnlyMention(message.text);
    // A chain companion reply (deploy / release / merge / reviewer / label / assignee) needs the companion word AND a
    // request shape attached to it ("배포해줘", "라벨 붙여줘", a bare "배포"); free text that merely contains the noun is chat.
    const chainCompanionAsk = (words: RegExp): boolean =>
      !bareChainWordsOff && words.test(chainText) && isChainCompanionRequest(chainText);
    // A real second ApprovalRequest is pending decision — intercepts EVERY turn, exactly like the first
    // approval does, regardless of whether the message is an apply phrase.
    // ADR-0122 D2.3/D2.5: every pending decision of the state-bound section re-checks `code` (deny / cancel always pass).
    if (applyAnchor !== null && PENDING_DECISION_ANCHOR_STATUSES.has(applyAnchor.status)) {
      const deniedDecision = await this.surfaceDeniedDecision(message, session, actor, [surfaceGroupOfStateStep('pending-decision')]);
      if (deniedDecision) return deniedDecision;
    }
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
    // (QA-V2-CL-03) "취소" while a diff preview awaits "적용해줘" discards that preview — never the QA-018 "nothing to
    // approve" reply, which ignored the open preview. ELIGIBLE only: no approval exists yet and no file was changed.
    // Every approval-pending state above keeps its own decision flow; later states keep their own replies.
    if (applyAnchor?.status === 'ELIGIBLE' && isPreviewDiscardUtterance(message.text)) {
      return this.stateBoundStep(message, session, actor, 'preview-discard', () => this.handlePreviewDiscardTurn(message, session, applyAnchor));
    }
    // (A3b) ADR-0111 D4/D5 (MM-2): a message carrying an admitted image is an image turn — after every pending
    // approval / scope / override intercept above (they keep their decision semantics; the image is not read there)
    // and before every `post-anchor` / `pre-classify` handler and the classifier. Images reach only a LOCAL
    // `IMAGE_UNDERSTANDING` provider; with none ready the reply is deterministic.
    const images = imageAttachmentsOf(message);
    if (images.length > 0) {
      return this.handleImageUnderstandingTurn(message, session, actor, images);
    }
    // (A3c) ADR-0111 D2/D3: no attachment of the message is usable — the adapter refused it (credential-like, too large,
    // unsupported, …) or Core's final re-check dropped it — AND the message has no text. The adapter already named each
    // refused file; no provider runs, so no model answers about a file it never got. "No text" means no effective
    // content: mention tokens, whitespace and invisible characters do not count. A message with ANY other text routes
    // normally (guessing whether the text is "about the file" swallowed independent questions); a chat prompt then
    // states that the attachment was not read and must not be guessed.
    if (hasNoUsableAttachment(message) && !hasEffectiveText(message.text)) {
      // Content-free: a count only, never a file name or reason text.
      this.deps.logger.info('attachment turn answered without a provider', {
        attachmentCount: message.attachments?.length ?? 0,
      });
      const text = renderAttachmentsNotRead(
        noticeLanguage(undefined, message.text),
        currentTurnAttachmentsOf(message)?.notReadReasons,
      );
      return this.respondComposed(message, session, { context: message.context, text });
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
    if (interpretPostApplyValidationIntent(message.text) === 'unsupported') {
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
      // (Codex wave-8 review, allow-list decision) ONLY an exact accepted execution phrase executes (EXECUTION_PHRASES
      // in execution-command-guard); any other commit-execution mention → the already-approved reply, which quotes
      // the documented phrase. The same rule applies to every approved execution gate below.
      if (isAcceptedExecutionPhrase('commit', message.text)) return this.stateBoundStep(message, session, actor, 'commit', () => this.handleCommitExecutionTurn(message, session, applyAnchor));
      const execKind = interpretCommitExecutionIntent(chainText);
      if (execKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitPushUnsupportedTurn(message, session));
      if (execKind === 'execute') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitAlreadyApprovedTurn(message, session));
    }
    if (applyAnchor?.status === 'GIT_COMMITTED') {
      // (Sprint 2z, ADR-0047) push is checked FIRST so "푸시해줘" plans a push approval rather than hitting
      // the 2y commit-push-unsupported reply. A push bundled with force/PR/deploy/… → unsupported companion.
      const pushKind = interpretPushIntent(chainText);
      if (pushKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushUnsupportedCompanionTurn(message, session));
      if (pushKind === 'push') return this.stateBoundStep(message, session, actor, 'push', () => this.handlePushApprovalTurn(message, session, actor, applyAnchor));
      // A repeat commit-execution phrase at GIT_COMMITTED → already committed (2y). ("push"-forbidden here is
      // handled above by 2z; the remaining COMMIT_EXECUTION 'push-unsupported' cases have no push word.)
      const execKind = interpretCommitExecutionIntent(chainText);
      if (execKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitPushUnsupportedTurn(message, session));
      if (execKind === 'execute') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitAlreadyCommittedTurn(message, session, applyAnchor));
    }
    // (Sprint 3a, ADR-0048) approved git push EXECUTION — checked before the 2z already-approved so
    // "승인된 push 실행해줘" executes rather than re-printing already-approved. A bare push phrase (no exec
    // word) falls to the 2z already-approved reply. A push+forbidden phrase → unsupported companion.
    if (applyAnchor?.status === 'PUSH_APPROVED') {
      if (isAcceptedExecutionPhrase('push', message.text)) return this.stateBoundStep(message, session, actor, 'push', () => this.handlePushExecutionTurn(message, session, actor, applyAnchor));
      const exKind = interpretPushExecutionIntent(chainText);
      if (exKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushUnsupportedCompanionTurn(message, session));
      if (exKind === 'execute') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushAlreadyApprovedTurn(message, session)); // not an exact phrase (allow-list)
      // (Sprint 2z) a bare push phrase at PUSH_APPROVED → already approved (not pushed).
      const pushKind = interpretPushIntent(chainText);
      if (pushKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushUnsupportedCompanionTurn(message, session));
      if (pushKind === 'push') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushAlreadyApprovedTurn(message, session));
    }
    // (Sprint 3a/3b) At GIT_PUSHED: a repeat push-execution/push phrase → already pushed; a push+forbidden →
    // unsupported companion (checked first, so a push+PR bundle is a push companion). (Sprint 3b, ADR-0049) an
    // explicit PR-creation phrase → CRITICAL PR approval; a PR+forbidden → unsupported companion; a bare
    // deploy-only phrase → deploy-only future-sprint (PR-creation is now supported, so it is no longer bundled).
    if (applyAnchor?.status === 'GIT_PUSHED') {
      const exKind = interpretPushExecutionIntent(chainText);
      if (exKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushUnsupportedCompanionTurn(message, session));
      if (exKind === 'execute') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushAlreadyPushedTurn(message, session, applyAnchor));
      const prKind = interpretPrIntent(chainText);
      if (prKind === 'pr-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePrUnsupportedCompanionTurn(message, session));
      if (prKind === 'create') return this.stateBoundStep(message, session, actor, 'pr-create', () => this.handlePrApprovalTurn(message, session, actor, applyAnchor));
      if (chainCompanionAsk(DEPLOY_ONLY_WORDS)) return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushPrDeployUnsupportedTurn(message, session));
      if (interpretPushIntent(chainText) === 'push') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushAlreadyPushedTurn(message, session, applyAnchor));
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
      !interpretPrStatusIntent(chainText) &&
      !interpretMergeStatusIntent(chainText)
    ) {
      const execKind = unnegatedMatch(chainText, [PUSH_EXECUTION_WORDS])
        ? interpretPushExecutionIntent(chainText)
        : null;
      const pushKind = execKind === 'execute' ? 'push' : (execKind ?? interpretNoAnchorPushRequest(chainText));
      if (pushKind === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushUnsupportedCompanionTurn(message, session));
      if (pushKind === 'push') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushAlreadyPushedTurn(message, session, applyAnchor));
    }
    // (Sprint 3b, ADR-0049) already PR-approved — a PR+forbidden → unsupported companion (before create, CA #9);
    // a PR-creation phrase → already approved (not created, Q11); a deploy-only phrase → state-specific reply.
    if (applyAnchor?.status === 'PR_APPROVED') {
      if (isAcceptedExecutionPhrase('prCreate', message.text)) {
        return this.stateBoundStep(message, session, actor, 'pr-create', () => this.handlePrCreationExecutionTurn(message, session, actor, applyAnchor));
      }
      const prKind = interpretPrIntent(chainText);
      if (prKind === 'pr-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePrUnsupportedCompanionTurn(message, session));
      // (Sprint 3d-D, ADR-0054) an explicit PR create/open phrase at PR_APPROVED now EXECUTES creation
      // (state-driven trigger — the same grammar requested approval at GIT_PUSHED). Bare noun/승인/진행해 → null.
      if (prKind === 'create') {
        // not an exact accepted phrase (allow-list) → already approved; the reply quotes "PR 생성 실행".
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.respondComposed(message, session, this.deps.composer.composePrAlreadyApproved(message.context)));
      }
      if (chainCompanionAsk(DEPLOY_ONLY_WORDS)) return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePrApprovedDeployUnsupportedTurn(message, session));
    }
    // (Sprint 3d-D) After a PR was created/connected: a PR create phrase → already created (+ URL, no new call);
    // a deploy/merge/release/companion phrase → unsupported future step. Never re-creates / merges / deploys.
    if (applyAnchor?.status === 'PR_CREATED') {
      // (Sprint 3e) an explicit PR/CI/check/review status phrase → read-only status preview (checked first).
      if (interpretPrStatusIntent(chainText)) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      // (Sprint 3f, ADR-0056) an explicit merge approval / merge phrase → CRITICAL merge-approval halt (records
      // permission only; NO merge). Checked before create/companion so "머지해줘" plans an approval, not a companion.
      if (interpretMergeIntent(chainText) === 'merge') {
        // ADR-0099 D5: with QUOKY_GIT_MERGE_ENABLED=false the merge chain is off — the fixed reply comes BEFORE any
        // merge ApprovalRequest or MERGE_APPROVAL_PENDING anchor (the hosting guard also refuses the merge call).
        if (!this.gitMergeEnabled) {
          return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.respondComposed(message, session, this.deps.composer.composeMergeDisabled(message.context)));
        }
        return this.stateBoundStep(message, session, actor, 'merge', () => this.handleMergeApprovalTurn(message, session, actor, applyAnchor));
      }
      const prKind = interpretPrIntent(chainText);
      if (prKind === 'create') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePrAlreadyCreatedTurn(message, session, applyAnchor));
      if (prKind === 'pr-unsupported' || (chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePrCreatedCompanionUnsupportedTurn(message, session));
      }
    }
    // (Sprint 3f/3g) After merge approval is recorded, in order (status → execution → bare-mention → companion):
    // a status/check phrase → read-only preview (keeps MERGE_APPROVED); an explicit merge-EXECUTION command →
    // live preflight → merge (Sprint 3g); a bare merge mention (no exec verb) → already-approved (ask to merge
    // explicitly, no mutation); deploy/release/reviewer/label/assignee → unsupported future step.
    if (applyAnchor?.status === 'MERGE_APPROVED') {
      if (isAcceptedExecutionPhrase('merge', message.text)) return this.stateBoundStep(message, session, actor, 'merge', () => this.handleMergeExecutionTurn(message, session, actor, applyAnchor));
      if (
        interpretPrStatusIntent(chainText) ||
        interpretMergeStatusIntent(chainText)
      ) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      // (Sprint 3g, ADR-0057, CA change 1) "머지해줘"/"이 PR 머지해줘"/"merge this PR"/"실제 머지해줘"/… → EXECUTE.
      // A merge-execution-shaped phrase that is not an exact accepted phrase (allow-list) → already approved.
      if (interpretMergeExecutionIntent(chainText) === 'execute') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyApprovedTurn(message, session));
      }
      // A bare "머지"/"merge" mention (merge word, no execution verb, not a status phrase) → already approved,
      // ask to merge explicitly (CA change 4). NO mutation. Checked before the deploy/companion words so a merge
      // noun does not fall into the companion-unsupported reply.
      if (chainCompanionAsk(MERGE_WORD)) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyApprovedTurn(message, session));
      }
      if ((chainCompanionAsk(DEPLOY_ONLY_WORDS) || chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeApprovedCompanionUnsupportedTurn(message, session));
      }
    }
    // (Sprint 3g/3h) PR_MERGED, in order: an explicit LOCAL main sync command → fast-forward sync (Sprint 3h,
    // checked FIRST so "머지된 main 받아와줘" syncs rather than being read as a merge phrase); a status/check phrase →
    // read-only preview (keeps PR_MERGED); any merge phrase → already merged (NO new mutation); deploy/release/
    // companion → unsupported future step.
    if (applyAnchor?.status === 'PR_MERGED') {
      // (allow-list) only an exact accepted sync phrase syncs; any other sync mention → a fixed hint naming the phrase.
      if (isAcceptedExecutionPhrase('mainSync', message.text)) return this.stateBoundStep(message, session, actor, 'main-sync', () => this.handleMainSyncTurn(message, session, actor, applyAnchor));
      if (
        interpretPrStatusIntent(chainText) ||
        interpretMergeStatusIntent(chainText)
      ) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      if (!bareChainWordsOff && MAIN_SYNC_MENTION.test(chainText)) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.respondComposed(message, session, this.deps.composer.composeExecutionPhraseHint(message.context, 'main-sync')));
      }
      if (
        interpretMergeExecutionIntent(chainText) === 'execute' ||
        (chainCompanionAsk(MERGE_WORD))
      ) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyMergedTurn(message, session, applyAnchor));
      }
      if ((chainCompanionAsk(DEPLOY_ONLY_WORDS) || chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeExecutionUnsupportedCompanionTurn(message, session));
      }
    }
    // (Sprint 3h/3i) Terminal MAIN_SYNCED, in order: a REMOTE cleanup phrase → unsupported (Sprint 3i, CA change 1
    // — checked FIRST so it never falls through to a local delete); an explicit LOCAL cleanup command → safe local
    // branch delete (Sprint 3i); a sync command → already synced; a status/check phrase → read-only preview; any
    // merge phrase → already merged; deploy/release/companion → unsupported future step.
    if (applyAnchor?.status === 'MAIN_SYNCED') {
      if (interpretRemoteBranchCleanupIntent(chainText) === 'remote') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleRemoteBranchCleanupUnsupportedTurn(message, session));
      }
      // (allow-list) only an exact accepted cleanup phrase deletes; any other local-cleanup mention → a fixed hint.
      if (isAcceptedExecutionPhrase('localCleanup', message.text)) {
        return this.stateBoundStep(message, session, actor, 'local-cleanup', () => this.handleBranchCleanupTurn(message, session, actor, applyAnchor));
      }
      if (interpretMainSyncIntent(chainText) === 'sync') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMainAlreadySyncedTurn(message, session, applyAnchor));
      }
      if (
        interpretPrStatusIntent(chainText) ||
        interpretMergeStatusIntent(chainText)
      ) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      if (!bareChainWordsOff && CLEANUP_BRANCH_WORD.test(chainText) && CLEANUP_VERB.test(chainText)) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.respondComposed(message, session, this.deps.composer.composeExecutionPhraseHint(message.context, 'local-cleanup')));
      }
      if (
        interpretMergeExecutionIntent(chainText) === 'execute' ||
        (chainCompanionAsk(MERGE_WORD))
      ) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyMergedTurn(message, session, applyAnchor));
      }
      if ((chainCompanionAsk(DEPLOY_ONLY_WORDS) || chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeExecutionUnsupportedCompanionTurn(message, session));
      }
    }
    // (Sprint 3i/3j-A) Terminal BRANCH_CLEANED: a REMOTE cleanup phrase → CRITICAL remote-cleanup approval (Sprint
    // 3j-A, checked FIRST; records permission only, NO delete); a LOCAL cleanup phrase → already cleaned (no
    // mutation); a sync command → still synced; a status/check phrase → read-only preview; any merge phrase →
    // already merged; deploy/release/companion → unsupported. NEVER deletes/deploys.
    if (applyAnchor?.status === 'BRANCH_CLEANED') {
      if (interpretRemoteBranchCleanupIntent(chainText) === 'remote') {
        return this.stateBoundStep(message, session, actor, 'remote-cleanup', () => this.handleRemoteBranchCleanupApprovalTurn(message, session, actor, applyAnchor));
      }
      if (interpretBranchCleanupIntent(chainText) === 'local') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleBranchAlreadyCleanedTurn(message, session, applyAnchor));
      }
      if (interpretMainSyncIntent(chainText) === 'sync') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMainAlreadySyncedTurn(message, session, applyAnchor));
      }
      if (
        interpretPrStatusIntent(chainText) ||
        interpretMergeStatusIntent(chainText)
      ) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      if (
        interpretMergeExecutionIntent(chainText) === 'execute' ||
        (chainCompanionAsk(MERGE_WORD))
      ) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyMergedTurn(message, session, applyAnchor));
      }
      if ((chainCompanionAsk(DEPLOY_ONLY_WORDS) || chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeExecutionUnsupportedCompanionTurn(message, session));
      }
    }
    // (Sprint 3j-B, ADR-0060) REMOTE_BRANCH_CLEANUP_APPROVED — an explicit EXECUTION command is checked FIRST (CA
    // change 1) so it is never swallowed by the re-request route → live preflight → single GitHub refs DELETE →
    // REMOTE_BRANCH_CLEANED; a re-request (no execute verb) → already approved (no re-approval); a status/check phrase
    // → read-only preview (keeps the state); a merge phrase → already merged; deploy/release/companion → unsupported.
    if (applyAnchor?.status === 'REMOTE_BRANCH_CLEANUP_APPROVED') {
      if (isAcceptedExecutionPhrase('remoteCleanup', message.text)) {
        return this.stateBoundStep(message, session, actor, 'remote-cleanup', () => this.handleRemoteBranchCleanupExecutionTurn(message, session, actor, applyAnchor));
      }
      // An execution-shaped phrase that is not an exact accepted phrase (allow-list) → already approved (quotes the phrase).
      if (interpretRemoteBranchCleanupExecutionIntent(chainText) === 'execute') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleRemoteBranchCleanupAlreadyApprovedTurn(message, session));
      }
      if (interpretRemoteBranchCleanupIntent(chainText) === 'remote') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleRemoteBranchCleanupAlreadyApprovedTurn(message, session));
      }
      if (
        interpretPrStatusIntent(chainText) ||
        interpretMergeStatusIntent(chainText)
      ) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      if (
        interpretMergeExecutionIntent(chainText) === 'execute' ||
        (chainCompanionAsk(MERGE_WORD))
      ) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyMergedTurn(message, session, applyAnchor));
      }
      if ((chainCompanionAsk(DEPLOY_ONLY_WORDS) || chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeExecutionUnsupportedCompanionTurn(message, session));
      }
    }
    // (Sprint 3j-B, ADR-0060) Terminal REMOTE_BRANCH_CLEANED: a remote cleanup phrase → already cleaned (no second
    // DELETE); a local cleanup phrase → already cleaned; a sync command → still synced; a status/check phrase →
    // read-only preview (keeps the state); a merge phrase → already merged; deploy/release/companion → unsupported.
    if (applyAnchor?.status === 'REMOTE_BRANCH_CLEANED') {
      if (
        interpretRemoteBranchCleanupExecutionIntent(chainText) === 'execute' ||
        interpretRemoteBranchCleanupIntent(chainText) === 'remote'
      ) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleRemoteBranchAlreadyCleanedTurn(message, session, applyAnchor));
      }
      if (interpretBranchCleanupIntent(chainText) === 'local') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleBranchAlreadyCleanedTurn(message, session, applyAnchor));
      }
      if (interpretMainSyncIntent(chainText) === 'sync') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMainAlreadySyncedTurn(message, session, applyAnchor));
      }
      if (
        interpretPrStatusIntent(chainText) ||
        interpretMergeStatusIntent(chainText)
      ) {
        return this.stateBoundStep(message, session, actor, 'pr-status', () => this.handlePrStatusPreviewTurn(message, session, applyAnchor));
      }
      if (
        interpretMergeExecutionIntent(chainText) === 'execute' ||
        (chainCompanionAsk(MERGE_WORD))
      ) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeAlreadyMergedTurn(message, session, applyAnchor));
      }
      if ((chainCompanionAsk(DEPLOY_ONLY_WORDS) || chainCompanionAsk(PR_CREATED_COMPANION_WORDS))) {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleMergeExecutionUnsupportedCompanionTurn(message, session));
      }
    }
    // (CA #1) NO global/no-anchor push handling is installed — push handling is anchored to GIT_COMMITTED /
    // PUSH_APPROVAL_PENDING / PUSH_APPROVED only; every other state keeps its existing behavior.
    // An explicit commit-execution phrase with no commit-relevant anchor → a scoped "not available" reply —
    // ONLY for an explicit 'execute' phrase (never push-only, which is left to existing 2w/2x handling).
    if (
      applyAnchor?.status !== 'COMMIT_APPROVED' &&
      applyAnchor?.status !== 'GIT_COMMITTED' &&
      interpretCommitExecutionIntent(chainText) === 'execute'
    ) {
      return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitExecutionUnavailableTurn(message, session));
    }
    // (Sprint 2v/2w/2x) WORKSPACE_APPLIED follow-ups, in order: validation → commit-approval → git preview.
    // Validation is checked FIRST so a mixed/dangerous phrase like "pnpm test; git commit" is caught by the
    // 2v deny-fragment path, not treated as a commit. A plain commit phrase ("커밋해줘") carries no validation
    // token, so it falls through to the commit check unaffected.
    if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
      // (allow-list) a run ('test'/'typecheck') executes a command, so only an exact accepted phrase runs it; any other
      // run-shaped phrase gets a fixed hint naming the phrase. Clarify/unsupported replies execute nothing (unchanged).
      if (isAcceptedExecutionPhrase('validationTest', message.text)) {
        return this.stateBoundStep(message, session, actor, 'validation', () => this.handlePostApplyValidationTurn(message, session, applyAnchor, 'test'));
      }
      if (isAcceptedExecutionPhrase('validationTypecheck', message.text)) {
        return this.stateBoundStep(message, session, actor, 'validation', () => this.handlePostApplyValidationTurn(message, session, applyAnchor, 'typecheck'));
      }
      const validationKind = interpretPostApplyValidationIntent(chainText);
      if (validationKind === 'test' || validationKind === 'typecheck') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.respondComposed(message, session, this.deps.composer.composeExecutionPhraseHint(message.context, 'validation')));
      }
      if (validationKind) {
        return this.stateBoundStep(message, session, actor, 'validation', () => this.handlePostApplyValidationTurn(message, session, applyAnchor, validationKind));
      }
      // (Sprint 2x) explicit commit request → commit-approval PLANNING (halt, no git mutation). A
      // push/add/reset-only phrase → null → falls to the 2w git-preview mutating reject (unchanged).
      const commitKind = interpretCommitIntent(chainText);
      if (commitKind) {
        return commitKind === 'commit'
          ? this.stateBoundStep(message, session, actor, 'commit', () => this.handleCommitApprovalTurn(message, session, actor, applyAnchor))
          : this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitUnsupportedCompanionTurn(message, session));
      }
      // (Sprint 2w, ADR-0044) Explicit read-only git preview → GitManager.status/diff against the applied
      // workspace. With no WORKSPACE_APPLIED anchor this is never consulted (no general git handling).
      const gitKind = interpretGitPreviewIntent(chainText);
      if (gitKind) {
        return this.stateBoundStep(message, session, actor, 'git-preview', () => this.handleGitPreviewTurn(message, session, applyAnchor, gitKind));
      }
    }
    // (Sprint 2x, ADR-0045) A commit request outside WORKSPACE_APPLIED: at COMMIT_APPROVED say already-approved
    // (not committed); otherwise a scoped "no applied change to commit" reply (never broad general handling).
    if (interpretCommitIntent(chainText)) {
      if (applyAnchor?.status === 'COMMIT_APPROVED') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitAlreadyApprovedTurn(message, session));
      }
      return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleCommitUnavailableTurn(message, session));
    }
    // (Sprint 2u, ADR-0042) Explicit final workspace-apply → the first real file mutation. Checked before
    // patch- and apply-intent (FINAL_APPLY_WORDS is non-overlapping with PATCH_WORDS and precedes
    // APPLY_WORDS so "패치 적용해줘" is a file-apply, not a Sprint 2s apply-intent). Only fires on PATCH_READY.
    if (interpretFinalApplyIntent(chainText)) {
      if (applyAnchor?.status === 'PATCH_READY') {
        // (allow-list) only an exact accepted apply phrase writes files; otherwise the patch-ready (not applied) reply,
        // which quotes "패치 적용해줘".
        if (!isAcceptedExecutionPhrase('patchApply', message.text)) return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePatchAlreadyGeneratedTurn(message, session));
        return this.stateBoundStep(message, session, actor, 'apply', () => this.handleWorkspaceApplyTurn(message, session, applyAnchor));
      }
      if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleWorkspaceAlreadyAppliedTurn(message, session)); // never re-applies
      }
      // no anchor / ELIGIBLE / APPROVED / PATCH_READY-without-patchRef — never a new code-change request.
      return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleWorkspaceApplyUnavailableTurn(message, session));
    }
    // (Sprint 2t, ADR-0041) Explicit patch command → PatchSet representation. Generation only on APPROVED.
    // CA Round 1 #8: at WORKSPACE_APPLIED, route to the workspace-already-applied reply (never a
    // "preview generated" reply that would hide the stronger applied state).
    if (interpretPatchIntent(chainText)) {
      if (applyAnchor?.status === 'APPROVED') {
        return this.stateBoundStep(message, session, actor, 'patch', () => this.handlePatchGenerationTurn(message, session, applyAnchor));
      }
      if (applyAnchor?.status === 'PATCH_READY') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePatchAlreadyGeneratedTurn(message, session)); // don't regenerate
      }
      if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleWorkspaceAlreadyAppliedTurn(message, session));
      }
      // patch command with no APPROVED/PATCH_READY anchor (none / ELIGIBLE) — never falls through to a
      // new code-change request, mirroring the apply-unavailable handling.
      return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePatchUnavailableTurn(message, session));
    }
    if (interpretApplyIntent(chainText)) {
      if (applyAnchor?.status === 'ELIGIBLE') {
        return this.stateBoundStep(message, session, actor, 'apply', () => this.handleApplyIntentTurn(message, session, actor, applyAnchor)); // creates approval #2
      }
      if (applyAnchor?.status === 'APPROVED' || applyAnchor?.status === 'PATCH_READY') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleApplyAlreadyApprovedTurn(message, session)); // don't re-ask, don't re-approve
      }
      // CA Round 1 #8: at WORKSPACE_APPLIED, "적용해줘" must not say "아직 적용하지 않았어요" — the files
      // were already applied. Route to the workspace-already-applied reply.
      if (applyAnchor?.status === 'WORKSPACE_APPLIED') {
        return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleWorkspaceAlreadyAppliedTurn(message, session));
      }
      // No anchor at all (or a stale one, already auto-cleared by findAnchor). An explicit apply phrase
      // must NEVER be reinterpreted as a new, unscoped code-change request (CA review).
      return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleApplyPreviewUnavailableTurn(message, session));
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
      const noAnchorPush = interpretNoAnchorPushRequest(chainText);
      if (noAnchorPush === 'push-unsupported') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handlePushUnsupportedCompanionTurn(message, session));
      if (noAnchorPush === 'push') return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.handleNoPushTargetTurn(message, session));
    }
    // Live QA session 3 (D11): a merge request with no code chain at all ("PR 머지해줘") gets the documented fixed reply —
    // the merge-disabled refusal while QUOKY_GIT_MERGE_ENABLED=false (quickstart §6/§8), otherwise "no PR to merge" —
    // never chat. No approval, no git/hosting call.
    if (!applyAnchor && interpretNoChainMergeRequest(chainText) === 'merge') {
      return this.stateBoundStep(message, session, actor, 'chain-reply', () => this.respondComposed(
        message,
        session,
        this.gitMergeEnabled ? this.deps.composer.composeNoMergeTarget(message.context) : this.deps.composer.composeMergeDisabled(message.context),
      ));
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
    // ADR-0112 (CWR-2): a connector-write execution phrase with no approved write of that kind runs nothing and says so
    // (with or without the flow) — a chat model must never claim a comment, post or calendar change happened.
    if (isAnyConnectorWriteExecutionPhrase(message.text)) {
      return this.respondStrayConnectorWritePhrase(message, session, actor, connectorWriteOperationsOfPhrase(message.text));
    }
    // Routing exec gaps: the same step phrased as a question or a negation ("댓글 실행해도 돼?", "Slack 게시 실행하지 마")
    // gets the same non-mutating replies instead of chat. It never executes: the allow-list's question/negation veto
    // stays, and only the approving conversation's exact phrase runs a write.
    // DET-2: likewise a loose imperative ("댓글 실행해") or a "did it happen?" question ("댓글 달았어?", "일정 추가됐어?").
    const askedAbout = connectorWriteOperationsAskedAbout(message.text);
    const namedWrites = askedAbout.length > 0 ? askedAbout : connectorWriteOperationsNamedLoosely(message.text);
    if (namedWrites.length > 0) {
      return this.respondStrayConnectorWritePhrase(message, session, actor, namedWrites);
    }
    const bareAfterUnconfirmed = await this.respondBareExecutionAfterUnconfirmedWrite(message, session, actor);
    if (bareAfterUnconfirmed) return bareAfterUnconfirmed;
    // Live QA session 3 (D11): a bare "실행" / "go" / "run it" with no code chain and no approved write here runs nothing
    // and says so deterministically (a chat model once answered that Quoky cannot execute anything). With a chain anchor
    // the turn routes as before (its own state replies own it).
    // DET-2: the same bare step asked or negated ("실행해도 돼?", "실행하지 마") gets the same reply — but only with nothing
    // approved anywhere: a grant waiting in another conversation is named instead (Codex P2 on 5594c16; a grant in THIS
    // conversation is answered by the connector-write anchor branch above).
    if (!applyAnchor && isBareExecutionQuestionOrNegation(message.text) && this.deps.connectorWriteFlow) {
      const now = this.clock();
      for (const operation of CONNECTOR_WRITE_OPERATIONS) {
        // ADR-0122 (Codex): another conversation's write is never named in a channel without its groups.
        if (this.surfaceBlocks(message.context, actor, surfaceGroupsOfWriteOperation(operation))) continue;
        const elsewhere = await this.deps.connectorWriteFlow.approvedElsewhere(session, actor.id, operation, now);
        if (elsewhere) {
          return this.respondComposed(message, session, this.deps.composer.composeConnectorWriteApprovedElsewhere(message.context, elsewhere));
        }
      }
    }
    if (!applyAnchor && (isBareExecutionRequest(message.text) || isBareExecutionQuestionOrNegation(message.text))) {
      return this.respondComposed(message, session, this.deps.composer.composeNoApprovedExecution(message.context));
    }
    if (interpretStrayDecisionUtterance(message.text)) {
      return this.respondComposed(message, session, this.deps.composer.composeNoPendingDecision(message.context));
    }

    const durableMemoryContent = explicitDurableMemoryContent(message.text);
    if (durableMemoryContent === '') {
      // QA-010: the explicit command with no content is a usage error, never ordinary chat.
      return this.respondComposed(message, session, this.deps.composer.composeMemoryUsageHint(message.context));
    }
    if (durableMemoryContent !== null) {
      // ADR-0122 D1: `기억해:` is `memory`.
      const deniedMemory = this.surfaceDenied(message.context, actor, ['memory'], { path: 'route' });
      if (deniedMemory) return this.surfaceDeniedTurn(message, session, deniedMemory);
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
    // ADR-0120 D6 Phase C (S1, `QUOKY_NL_PHASE=c`): at the position where a frozen Class B grammar would answer, selection
    // runs first; the grammar answers only when the selector is unavailable. Class A handlers keep their order and run as
    // before. Phase A (the default): exactly the dispatch below.
    let nlEarly: NlEarlySelection | undefined;
    if (this.nlPhaseC(lookup.pending)) {
      const phaseC = await this.dispatchPreClassifyPhaseC(message, session, actor, applyAnchor, userMemory.id, nlPending);
      if (phaseC.kind === 'responded') return phaseC.result;
      nlEarly = phaseC.early;
    } else if (this.nlPhaseCShadow(lookup.pending)) {
      // S1 `c-shadow`: exactly the Phase A dispatch; a Class B answer also queues one background selection that starts
      // only after this turn's reply was handed back (`startAfterReply`) and only logs its agreement.
      const ctx = this.turnHandlerContext(message, session, actor, applyAnchor);
      let responder: ConversationTurnHandler | undefined;
      const handled = await this.dispatchTurnHandlers('pre-classify', this.turnHandlersByStage['pre-classify'], ctx, (handler) => {
        responder = handler;
      });
      if (handled) {
        // ADR-0122: a denied turn is not a grammar answer: no background selection on its text, no S1 agreement line.
        const probe = responder === undefined || this.surfaceDenials.has(handled) ? null : this.nlClassBProbe(responder, ctx);
        if (probe !== null) {
          this.queueGrammarHitShadow(message, session, actor, probe);
          // ADR-0121 S2 shadow coverage: the read a Class B grammar answered is planned too (liveSource `grammar`).
          if (this.deps.agentRuns !== undefined && this.deps.agentRuns.mode === 'shadow') this.queueAgentGrammarShadow(message, session, actor, probe, nlPending);
        }
        return this.respondTurnHandler(message, session, actor, userMemory.id, handled);
      }
    } else {
      const preClassifyDispatch = this.runTurnHandlers('pre-classify', () =>
        this.turnHandlerContext(message, session, actor, applyAnchor),
      );
      const preClassifyHandled = preClassifyDispatch ? await preClassifyDispatch : null;
      if (preClassifyHandled) return this.respondTurnHandler(message, session, actor, userMemory.id, preClassifyHandled);
    }

    // (B0b) ADR-0104 D3 (DET-1, QA-V2-W8-02): a whole-message status question or completion statement about a
    // code-chain action ("커밋됐어?", "푸시했어", "브랜치 삭제했어", "did you push?") that no route above answered is
    // answered from the apply-preview anchor — never by a chat model, which cannot see the repository and used to affirm
    // states it never checked. Every anchored reply above keeps its precedence; the turn-handler registry and its
    // stages/orders (ADR-0096) are unchanged, and no git/hosting call or provider call is made here.
    const statusDomain = detectInternalActionStatusTurn(message.text);
    if (statusDomain) {
      return this.stateBoundStep(message, session, actor, 'internal-status', () => this.handleInternalActionStatusTurn(message, session, applyAnchor, statusDomain));
    }

    let intent: Intent;
    try {
      intent = await this.deps.classifier.classify(message, { hasActiveProject: Boolean(session.activeProjectId) });
    } catch (err) {
      return this.failReadOnlyTurn(message, session, err); // nothing ran yet — provably no mutation
    }
    // Live UAT R9: an explicit `none` of a selector that ran (at a Class B position above) wins over the classifier's frozen
    // personal-work surface clause; only a skipped, failed or disabled selector leaves the surface as the fallback.
    if (nlEarly?.declined === true && nlWorkSurfaceRoute(intent) !== undefined) intent = chatIntentOf(message.text);
    this.deps.logger.info('intent classified', {
      capability: intent.capability,
      requiresWork: intent.requiresWork,
    });

    // (C) Execution intent → resolve workspace (if needed) → Intent Resolver → Execution Orchestrator. A failure
    // here keeps the conservative MAY_HAVE_APPLIED backstop in `handle`.
    if (this.deps.intentResolver.isExecution(intent)) {
      // ADR-0122 D2.3: code work (change, tests, apply) is `code`.
      const deniedCode = this.surfaceDenied(message.context, actor, ['code'], { path: 'route' });
      if (deniedCode) return this.surfaceDeniedTurn(message, session, deniedCode);
      return this.handleExecutionIntent(message, session, actor, intent);
    }

    // (C2) ADR-0120 D6 Phase A: natural-language selection, only on a turn every earlier route (the pre-classify
    // grammars, the B0b status answer and the classifier above) left for chat — `GENERAL_CHAT`, or `POLICY_SENSITIVE_CHAT`
    // for the personal-data reason alone — and never while an approval is pending. Absent or `off`: nothing runs here.
    // Phase C: a selection already made at a Class B position this turn is not repeated (one call per message, D3); its
    // honest-chat fact carries over. The classifier's personal-work surface is a Class B grammar too (`work-surface`):
    // selection runs first there, and the surface is the fallback for every other outcome.
    // ADR-0120 A2 (implementation note 2): in Phase A the same route runs when the A2 yield is on and the surface clause (a
    // substring match) leaves content its phrase family cannot express. A selector `none` then makes the turn chat; a
    // skipped, failed, timed-out or unavailable selector leaves the surface as the fallback (A5 change 9). No agreement line
    // is logged for it (no grammar probe), so the D10 data stays Phase C only.
    let nlFacts: NlChatFacts | undefined = nlEarly?.facts;
    if (nlEarly === undefined && this.deps.nlSelection !== undefined && this.deps.nlSelection.mode !== 'off' && !lookup.pending) {
      const phaseC = this.nlPhaseC(lookup.pending);
      const route =
        nlSelectionRoute(intent) ??
        (phaseC || this.nlSurfaceYields(message) ? nlWorkSurfaceRoute(intent) : undefined);
      if (route !== undefined) {
        try {
          const grammar: NlClassBProbe | undefined = route === 'work-surface' && phaseC ? { grammarId: 'work-surface', selection: { entryId: 'todo.list', args: {} } } : undefined;
          const selected = await this.handleNlSelection(message, session, actor, applyAnchor, userMemory.id, route, intent, nlPending, grammar);
          if (selected.kind === 'responded') return selected.result;
          if (route !== 'work-surface') nlFacts = selected.facts;
          else if (selected.declined === true) {
            // Live UAT R9: the selector ran and answered `none`, so its decision wins over the frozen surface clause: the
            // turn is chat (with the configured-sources fact), never a Jira / GitHub lookup. Only a skipped, failed or
            // disabled selector leaves the surface as the fallback.
            intent = chatIntentOf(message.text);
            nlFacts = selected.facts;
          }
        } catch (err) {
          return this.failReadOnlyTurn(message, session, err);
        }
      }
    }

    // (C3) Owner decision of 2026-10-29 ("끊긴 확인 고치고 재측정"): a bare yes or no bound for chat with nothing waiting for
    // it gets Core's fixed notice and no chat call. Every route above that answers a yes or no (the D7 question, the A6
    // continuation and undo confirmations, approvals, anchors) has had its turn; after a chat reply the yes still goes to
    // chat, which may have asked it.
    if (this.isStaleBareYesNo(message, session, actor, intent, nlPending, lookup.pending !== null || lookup.override !== null || Boolean(lookup.connectorWrite) || applyAnchor !== null)) {
      return this.respondComposed(message, session, outboundMessage(message.context, renderNoOpenQuestion(languageOf(message.text))));
    }

    // Every remaining route (work surface, project registration, analysis, chat) never reaches a workspace,
    // git or command mutator, so an infrastructure failure renders the confirmed-not-applied wording instead
    // of the backstop's "변경 적용 여부를 확인할 수 없어요".
    try {
      return await this.handleNonExecutionTurn(message, session, actor, intent, userMemory.id, nlFacts);
    } catch (err) {
      return this.failReadOnlyTurn(message, session, err);
    }
  }
}
