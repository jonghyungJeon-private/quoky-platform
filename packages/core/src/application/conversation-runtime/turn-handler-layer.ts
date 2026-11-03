import { generalChatReplyPolicy } from '../chat-policy/chat-response-policy';
import { noticeLanguage } from '../chat-policy/internal-action-vocabulary';
import { parseLearningCommand } from '../feedback/learning-commands';
import { parseMemoryCommand } from '../memory-commands/memory-command-grammar';
import { parseModelSelectionCommand } from '../model-selection/model-selection-command';
import { parseReminderMessage } from '../reminders/reminder-grammar';
import { documentedExecutionPhrase, isAcceptedExecutionPhrase } from '../execution-command-guard';
import {
  type ConnectorWriteAnchorView,
  type ConnectorWriteLatestRequest,
  type ConnectorWriteFlow,
  type ConnectorWriteStep,
  connectorWriteExecutionGate,
  connectorWriteTargetOf,
  isAnyConnectorWriteExecutionPhrase,
  connectorWriteOperationsAskedAbout,
  connectorWriteOperationsNamedLoosely,
  isBareExecutionProhibition,
  isBareExecutionQuestionOrNegation,
  isBareExecutionRequest,
  isConnectorWriteSendStale,
  mentionsConnectorWriteExecutionStep,
  namesApprovedWriteStepVerb,
} from '../connector-writes/connector-write-flow';
import { CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE } from '../connector-writes/connector-write-copy';
import { outboundMessage, withOutboundBody } from '../message-rendering';
import { interpretStrayDecisionUtterance, isPendingCancelUtterance } from '../approval-decision';
import { externalLastActionOf } from '../nl-routing/last-action';
import { type ConversationControlCommand } from '../conversation-commands';
import { NON_ABSOLUTE_REGISTRATION_KIND } from '../intent-classifier';
import { type NlListingReceipt } from '../nl-routing/catalog';
import { surfacePermittedWorkSources } from '../surface-grants/surface-permit';
import { SURFACE_GRANT_HELP_LINES } from '../surface-grants/surface-grant-copy';
import { surfaceGroupsOfSelection, surfaceGroupsOfWriteDraft, surfaceGroupsOfWriteFamily, surfaceGroupsOfWriteOperation } from '../surface-grants/surface-group-map';
import { Capability, IntentType } from '../../domain';
import type { Actor, ApprovalRequest, Id, InboundMessage, Intent, IsoTimestamp, OutboundMessage, Session, WorkspaceRef } from '../../domain';
import {
  CONNECTOR_WRITE_OPERATIONS,
  type ConnectorWriteOperation,
  type ProjectReadout,
  type ConversationTurnHandler,
  type TurnHandlerAnchorSnapshot,
  type TurnHandlerContext,
  type TurnHandlerOutcome,
  type TurnHandlerReply,
  type TurnHandlerSummarizeReply,
  type TurnHandlerStage,
  type TurnHandlerWriteDraft,
} from '../../ports';
import { detectWorkChatCommand } from '../work-chat/work-chat-command';
import { isWorkSummaryRequestTextWithheld } from '../prompt-composer';
import { appendWorkSummaryFooter, isSummarizableExternalWorkReadout } from '../work-chat/work-chat-turn-handler';
import { numberExternalWorkSummary } from '../work-chat/external-work-readout';
import { pseudonymiseParticipants } from '../work-chat/work-item-summary';
import { containsCardSpoofLine, renderCardSpoofNotice } from '../card-spoof';
import {
  documentSummaryReply,
  documentSummaryReplyBody,
  isSummarizableDocumentReadout,
  isR2DocumentSource,
  isUntrustedDocumentReadout,
  type UntrustedDocumentReadout,
} from '../untrusted-document-readout';
import { checkDocumentSummaryClaims, isFixedDocumentSummaryNotice, renderDocumentSummaryTooLong } from '../document-summary-claim-check';
import { ConversationRuntimeChatLayer } from './chat-layer';
import { SurfaceDeniedError, frozenPlainSnapshot, nlConfirmToRecord } from './helpers';
import type { NlChatFacts, RecentConnectorWrite } from './internal-types';
import { connectorWriteChoiceIndex, explicitDurableMemoryContent, interpretDecision, nlReplyKindOf } from './turn-intents';
import type { ApplyPreviewAnchor, RuntimeTurnStatus, TurnResult } from './types';

export abstract class ConversationRuntimeTurnHandlerLayer extends ConversationRuntimeChatLayer {
  /** Non-execution routes after classification: (L) work surface, (B) registration, (D) analysis, (E)/(F) chat. */
  protected async handleNonExecutionTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    userMemoryId: Id,
    nlFacts?: NlChatFacts,
  ): Promise<TurnResult> {
    if (intent.type === IntentType.LOOKUP && intent.raw?.kind === 'personal-work-surface') {
      // ADR-0122 D2.4: the combined "my work" view, under the same group as `todo.list` (`todo`); its Jira / GitHub
      // sections are read only when the channel's permit also holds `jira-mine` / `github` (P2).
      const deniedSurface = this.surfaceDenied(message.context, actor, surfaceGroupsOfSelection({ entryId: 'todo.list', args: {} }), { path: 'route' });
      if (deniedSurface) return this.surfaceDeniedTurn(message, session, deniedSurface);
      const permit = this.surfacePermitOf(message.context, actor);
      if (permit === undefined) {
        const surface = await this.deps.workSurface.forActor(actor);
        return this.respondComposed(message, session, this.deps.composer.composeWorkSurface(message.context, surface));
      }
      const { sources, withheld } = surfacePermittedWorkSources(permit);
      const surface = sources.length > 0 ? await this.deps.workSurface.forActor(actor, { sources }) : null;
      return this.respondComposed(message, session, this.deps.composer.composeWorkSurface(message.context, surface, withheld));
    }

    // (B) Project registration — deterministic command (ADR-0018).
    if (intent.type === IntentType.REGISTER_PROJECT) {
      const deniedRegistration = this.surfaceDenied(message.context, actor, ['code'], { path: 'route' });
      if (deniedRegistration) return this.surfaceDeniedTurn(message, session, deniedRegistration);
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
      const deniedAnalysis = this.surfaceDenied(message.context, actor, ['code'], { path: 'route' });
      if (deniedAnalysis) return this.surfaceDeniedTurn(message, session, deniedAnalysis);
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
      this.markNlChatTurn(message, intent.capability);
      const provider = await this.deps.router.select(intent.capability, { sessionId: session.id, actorId: actor.id });
      const raw = await provider.execute({ capability: intent.capability, prompt: message.text });
      const guard = this.guardChatReply(intent.capability, raw.text, message.text);
      const result = { ...raw, text: guard.text };
      const composed = this.deps.composer.compose(message.context, result, result.artifacts ?? []);
      const reply = this.asModelReply(composed, raw.text, { withheld: false, guarded: guard.guarded });
      await this.deps.memory.recordAssistant(result.text, message.context, session.id);
      return this.responded(session, reply);
    }

    // (F) Work path — a chat/analysis Task (existing single-capability flow, relocated).
    return nlFacts === undefined
      ? this.handleWorkTurn(message, session, actor, intent, userMemoryId, readout)
      : this.handleWorkTurn(message, session, actor, intent, userMemoryId, readout, nlFacts);
  }

  /** Exact, provider-free activation grammar. Pending governance flows have already run before this is called. */
  /**
   * An explicit deterministic command of a registered turn handler (live QA 2026-10-07): a memory command, a learning
   * command (`예시 N 수정: …`, `후보 N 메모: …`, `예시 목록`, …), a work-chat to-do / lookup / connector-write command, a
   * reminder, the owner's model-selection command (`모델 변경: codex`, `/model`; ADR-0092 amendment, runtime switching),
   * or the runtime's own `기억해:` save. Each grammar is whole-message and anchored, so free chat never matches.
   */
  protected isExplicitTurnHandlerCommand(text: string): boolean {
    if (parseLearningCommand(text) !== null || parseMemoryCommand(text) !== null) return true;
    if (parseModelSelectionCommand(text) !== null) return true;
    if (explicitDurableMemoryContent(text) !== null) return true;
    const workChat = detectWorkChatCommand(text);
    if (workChat !== null && workChat.kind !== 'usage') return true;
    try {
      return parseReminderMessage(text, { now: this.clock() }).kind !== 'NOT_REMINDER';
    } catch {
      return false;
    }
  }

  /**
   * A help/reset control turn (ADR-0093). Deterministic: no provider call, no Task/TaskRun, and nothing is
   * written to conversational or durable memory. Reset first records a still-pending approval as denied
   * (`decidedBy` = the owner actor, comment `reset`), then closes the Session; the next message opens a new
   * one. Reset never cancels a running TaskRun, rolls back an applied change or commit, or deletes memory.
   */
  protected async handleControlTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    command: ConversationControlCommand,
    pending: ApprovalRequest | null,
    expiryNotice: OutboundMessage | null,
  ): Promise<TurnResult> {
    let reply: OutboundMessage;
    let denied = false;
    if (command === 'help') {
      // ADR-0122 P2: the owner's channel-permission phrases are listed only while the gate is enforced (off: unchanged).
      reply = this.deps.composer.composeHelp(
        message.context,
        this.surfaceGate()?.enforced === true ? [...this.contributedHelpLines, ...SURFACE_GRANT_HELP_LINES] : this.contributedHelpLines,
      );
    } else {
      // ADR-0097 D5 (OVR-3 contract): the credential-override set is invalidated (`reset`, by the owner) through the
      // flow BEFORE the session closes, so the reset is serialized with an in-flight consume; nothing is sent.
      // ADR-0113 D7: the invalidation, the `reset` denial and the close run under the shared approval/session locks,
      // so a racing operations-UI decision can neither double-decide the approval nor re-anchor the closed session.
      const reset = await this.approvalDecisions.resetConversation(session, actor, pending);
      denied = reset.deniedPendingApproval;
      reply = this.deps.composer.composeConversationReset(message.context, { deniedPendingApproval: denied });
    }
    this.deps.logger.info('conversation control handled', {
      command,
      sessionId: session.id,
      ...(pending && denied ? { deniedApprovalId: pending.id } : {}),
    });
    return this.responded(session, expiryNotice ? this.deps.composer.composeWithNotice(expiryNotice, reply) : reply);
  }

  /**
   * Dispatch one ADR-0096 stage. Returns `null` WITHOUT building a context or yielding when the stage has no
   * handlers, so an empty registry leaves the turn exactly as before; otherwise the stage's handlers run one at a
   * time in registry order and the first non-null reply wins. A thrown error is not caught here: handlers catch
   * their own, and a leaked one reaches the `handle` backstop.
   */
  protected runTurnHandlers(
    stage: TurnHandlerStage,
    buildContext: () => TurnHandlerContext,
  ): Promise<TurnHandlerOutcome | null> | null {
    const handlers = this.turnHandlersByStage[stage];
    if (handlers.length === 0) return null;
    return this.dispatchTurnHandlers(stage, handlers, buildContext());
  }

  protected async dispatchTurnHandlers(
    stage: TurnHandlerStage,
    handlers: readonly ConversationTurnHandler[],
    ctx: TurnHandlerContext,
    onResponded?: (handler: ConversationTurnHandler) => void,
  ): Promise<TurnHandlerOutcome | null> {
    for (const handler of handlers) {
      const handled = await this.runGatedHandler(handler, ctx);
      if (handled) {
        onResponded?.(handler);
        this.deps.logger.info('turn handler responded', {
          handlerId: handler.id,
          stage,
          sessionId: ctx.session.id,
          status:
            handled.kind === 'summarize' ? 'SUMMARIZE' : handled.kind === 'write-draft' ? 'WRITE_DRAFT' : handled.status ?? 'RESPONDED',
        });
        return handled;
      }
    }
    return null;
  }

  /** The ADR-0096 handler context: domain values plus a read-only snapshot of the apply-preview anchor. */
  protected turnHandlerContext(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    anchor: ApplyPreviewAnchor | null,
    nlActionWriteCondition?: { readonly actionSwitchOf: Id },
  ): TurnHandlerContext {
    const sourceMessage = message;
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
    // ADR-0122 D2.4 (P2): only in a channel with the gate enforced (absent otherwise, so the context is unchanged).
    const permit = this.surfacePermitOf(message.context, actor);
    return Object.freeze({
      message: frozenPlainSnapshot(message),
      session: frozenPlainSnapshot(session),
      actor: frozenPlainSnapshot(actor),
      now: this.clock(),
      applyAnchor,
      ...(this.nlYield.has(sourceMessage) ? { grammarYield: true } : {}),
      resolveActiveWorkspace: () => this.resolveActiveWorkspaceForHandler(sessionId, activeProjectId),
      ...(nlActionWriteCondition !== undefined ? { nlActionWriteCondition: Object.freeze({ ...nlActionWriteCondition }) } : {}),
      ...(permit !== undefined ? { surfacePermit: frozenPlainSnapshot(permit) } : {}),
    });
  }

  /** The active project's workspace for a turn handler — `null` when none is active or it cannot be opened. */
  protected async resolveActiveWorkspaceForHandler(
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
  protected async respondTurnHandler(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    userMemoryId: Id,
    handled: TurnHandlerOutcome,
  ): Promise<TurnResult> {
    // ADR-0120 follow-up: a handler that answers a listing through its deterministic grammar names the catalog
    // equivalent; it becomes `lastSelection` exactly as a selection's would (a failed reply shows no listing).
    if (
      handled.kind !== 'write-draft' &&
      handled.nlSelection !== undefined &&
      (handled.kind === 'summarize' || handled.status !== 'FAILED') &&
      this.deps.nlSelection?.mode === 'active' &&
      this.deps.nlSelection.recordGrammarSelection !== undefined
    ) {
      if (await this.deps.nlSelection.recordGrammarSelection(session, actor.id, handled.nlSelection, this.clock(), message.id)) {
        this.keepNlLastSelection(message, session);
      }
    }
    // Owner decision B (2026-10-22): a reply that asks the owner to confirm one read keeps it as the open D7 question.
    const confirm = nlConfirmToRecord(handled);
    if (confirm !== undefined && this.deps.nlSelection?.mode === 'active' && this.deps.nlSelection.recordConfirmQuestion !== undefined) {
      await this.deps.nlSelection.recordConfirmQuestion(session, actor.id, confirm.selection, confirm.language, this.clock());
    }
    // ADR-0120 amendment A6-D2/D3: the content-free receipts of a to-do / reminder listing or action (an A6 dispatch or an
    // anchored command) become `quoky.lastAction`, the echo label and the listing slot. The service writes nothing while
    // QUOKY_NL_ACTIONS is `off`; the reply is never changed.
    this.nlReplyKinds.set(message, nlReplyKindOf(handled));
    const decided = this.nlActionTurns.get(message);
    // A6 R2: a summarize outcome may carry the `item.summarize` read it reports (its listing is recorded after the
    // summary, once the delivered form is known).
    const summarizeAction = handled.kind === 'summarize' ? handled.nlAction : undefined;
    if (
      this.deps.nlSelection?.recordActionReceipt !== undefined &&
      (decided !== undefined || summarizeAction !== undefined || (handled.kind !== 'summarize' && handled.kind !== 'write-draft' && (handled.nlAction !== undefined || handled.nlListing !== undefined)))
    ) {
      const receipt = handled.kind !== 'summarize' && handled.kind !== 'write-draft' ? handled : undefined;
      const action = receipt?.nlAction ?? summarizeAction;
      await this.deps.nlSelection.recordActionReceipt({
        session,
        actor,
        message: { id: message.id, context: message.context },
        now: this.clock(),
        ...(action !== undefined ? { action } : {}),
        ...(receipt?.nlListing !== undefined ? { listing: receipt.nlListing } : {}),
        ...(decided !== undefined ? { decided: decided.audit, language: decided.language } : {}),
      });
    }
    if (handled.kind === 'summarize') return this.handleTurnHandlerSummary(message, session, actor, userMemoryId, handled);
    if (handled.kind === 'write-draft') return this.handleConnectorWriteDraft(message, session, actor, handled);
    return this.recordTurnHandlerReply(message, session, userMemoryId, handled);
  }

  /**
   * A deterministic handler reply, recorded to SHORT_TERM history as the handler asks (ADR-0106 D5, W2-L01): its
   * `history.user` replaces the inbound turn recorded earlier, its `history.assistant` is recorded instead of the
   * reply text. For memory-edit requests the withheld form is already what `MemoryManager.recordShortTerm` wrote (the
   * decision is made at write time, so no failure here can leave the raw text); this rewrite is the generic path for
   * any other handler and fails closed: when it cannot be applied the recorded inbound turn is removed instead.
   * Failures are logged content-free and never fail the turn (the reply already happened).
   */
  protected async recordTurnHandlerReply(
    message: InboundMessage,
    session: Session,
    userMemoryId: Id,
    handled: TurnHandlerReply,
  ): Promise<TurnResult> {
    const userHistory = handled.history?.user;
    if (userHistory !== undefined) {
      let redacted = false;
      if (this.deps.memory.redactShortTerm) {
        try {
          await this.deps.memory.redactShortTerm(userMemoryId, userHistory);
          redacted = true;
        } catch (error) {
          this.deps.logger.warn('turn handler history redaction failed', {
            messageId: message.id,
            sessionId: session.id,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      if (!redacted) {
        let removed = false;
        if (this.deps.memory.deleteShortTerm) {
          try {
            await this.deps.memory.deleteShortTerm(userMemoryId);
            removed = true;
          } catch (error) {
            this.deps.logger.warn('turn handler history removal failed', {
              messageId: message.id,
              sessionId: session.id,
              errorName: error instanceof Error ? error.name : typeof error,
            });
          }
        }
        if (!removed) {
          this.deps.logger.warn('turn handler history could not be withheld', { messageId: message.id, sessionId: session.id });
        }
      }
    }
    await this.deps.memory.recordAssistant(handled.history?.assistant ?? handled.reply.text, message.context, session.id);
    return { status: handled.status === 'FAILED' ? 'FAILED' : 'RESPONDED', reply: handled.reply, sessionId: session.id };
  }

  /** A `control` handler outcome as a deterministic reply; a `summarize` outcome degrades to its fallback list. */
  protected controlStageReply(
    message: InboundMessage,
    outcome: TurnHandlerOutcome,
  ): { reply: OutboundMessage; status?: 'RESPONDED' | 'FAILED' } {
    if (outcome.kind !== 'summarize' && outcome.kind !== 'write-draft') return outcome;
    this.deps.logger.warn('control turn handler outcome degraded to its fallback', { messageId: message.id, kind: outcome.kind });
    return { reply: outboundMessage(message.context, outcome.fallbackText) };
  }

  /**
   * ADR-0100 D8 work summary. The handler's readout is re-validated (shape, bounds, no credential material, fits the
   * prompt) and handed to the existing `handleWorkTurn` with `Capability.SUMMARIZATION`, so provider selection
   * (capability / priority / `isAvailable`, ADR-0092), Task/TaskRun creation and audit stay exactly where they are.
   * On success the deterministic footer (real links + "N items used") is appended within the message budget. On any
   * other result — a readout that fails re-validation (no provider call), no available provider, a provider failure,
   * or an infrastructure error — the reply is the deterministic list (`fallbackText`).
   */
  protected async handleTurnHandlerSummary(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    userMemoryId: Id,
    summary: TurnHandlerSummarizeReply,
  ): Promise<TurnResult> {
    // A6 R2 (D1): a numbered list records the labels of the form that was delivered (the index or the fallback list).
    const numbered = summary.numbered;
    const recordListing = async (listing: NlListingReceipt | undefined): Promise<void> => {
      if (listing === undefined || this.deps.nlSelection?.recordActionReceipt === undefined) return;
      await this.deps.nlSelection.recordActionReceipt({
        session,
        actor,
        message: { id: message.id, context: message.context },
        now: this.clock(),
        listing,
      });
    };
    const fallback = async (): Promise<TurnResult> => {
      await recordListing(numbered?.fallback);
      // A6 R2 (amendment C10): an item read's fallback names the item; SHORT_TERM keeps only the fixed note.
      const history = summary.history?.assistant;
      if (history === undefined) return this.respondComposed(message, session, outboundMessage(message.context, summary.fallbackText));
      await this.deps.memory.recordAssistant(history, message.context, session.id);
      return { status: 'RESPONDED', reply: outboundMessage(message.context, summary.fallbackText), sessionId: session.id };
    };
    if (isUntrustedDocumentReadout(summary.readout)) {
      return this.handleDocumentSummary(message, session, actor, userMemoryId, summary, summary.readout, fallback);
    }
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
    if (numbered === undefined) return { ...result, reply: withOutboundBody(result.reply, appendWorkSummaryFooter(result.reply.text, summary.footer)) };
    // A6 R2 (D1, live test 3): the model's own list numbering is never a label. Quoky numbers the body's item lines in
    // reading order, renders the index footer in that same order, and records exactly those labels.
    const shown = numberExternalWorkSummary(result.reply.text, readout);
    await recordListing({ source: numbered.summary.source, items: shown.labels.map((id, index) => ({ label: index + 1, id })) });
    return { ...result, reply: withOutboundBody(result.reply, appendWorkSummaryFooter(shown.text, shown.footer)) };
  }

  /**
   * ADR-0118 D7 (GML-1): the summary of ONE personal item the owner explicitly asked for. The readout is re-validated
   * (shape, bounds, no invisible characters, the strict credential guard on the rendered prompt text) BEFORE any
   * provider call, then runs the same SUMMARIZATION work path as a work summary — selection stays capability /
   * priority / `isAvailable`, so the provider is the effective chat-tier choice — over a self-contained prompt with no
   * transcript, recall or examples and no tool surface. The handler created no Task, approval or write, and nothing in
   * this path can (ADR-0096 D4). A rejected readout or any non-RESPONDED result is the handler's fixed `fallbackText`.
   */
  protected async handleDocumentSummary(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    userMemoryId: Id,
    summary: TurnHandlerSummarizeReply,
    readout: UntrustedDocumentReadout,
    fallback: () => Promise<TurnResult>,
  ): Promise<TurnResult> {
    if (!isSummarizableDocumentReadout(readout)) {
      this.deps.logger.warn('document summary readout rejected', { messageId: message.id, sessionId: session.id });
      return fallback();
    }
    const intent: Intent = {
      type: IntentType.SUMMARIZE,
      capability: Capability.SUMMARIZATION,
      confidence: 1,
      requiresWork: true,
      summary: `document summary: ${readout.source}`,
      raw: { kind: 'document-summary', source: readout.source },
    };
    let result: TurnResult;
    try {
      result = await this.handleWorkTurn(message, session, actor, intent, userMemoryId, readout);
    } catch (err) {
      this.deps.logger.warn('document summary path threw', {
        messageId: message.id,
        sessionId: session.id,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return fallback();
    }
    if (result.status !== 'RESPONDED') return fallback();
    // A6 R2 (D5, live test 3): the output scrub. Any written form of a participant's name the summary still carries is
    // pseudonymised before anything below reads or shows it.
    const summaryText = summary.participants !== undefined ? pseudonymiseParticipants(result.reply.text, summary.participants) : result.reply.text;
    // Review P2-4: links neutralized, the provider text an untrusted span, the fixed footer appended.
    const reply = documentSummaryReply(summaryText, summary.footer);
    // ADR-0104 D1 amendment (owner, 2026-10-15; CA P1-2): the exact lines the owner is shown — rendered, capped, built
    // from the body's own parts (the fixed footer is Quoky copy) — pass the claim check, whichever path produced them;
    // otherwise the whole summary is replaced by the fixed notice. A fixed notice is Quoky copy as written.
    if (isFixedDocumentSummaryNotice(summaryText, readout.source)) return { ...result, reply: withOutboundBody(result.reply, reply.body) };
    const language = noticeLanguage(undefined, message.text);
    // A6 R2 (D11, proposal §3.3 item 4): a delivered line that normalises to an approval / execution phrase or begins with
    // a card header replaces the whole Jira / Slack summary with the fixed notice.
    if (isR2DocumentSource(readout.source) && containsCardSpoofLine(reply.shown)) {
      this.deps.logger.info('document summary replaced after the card-spoof check', { messageId: message.id });
      return { ...result, reply: withOutboundBody(result.reply, documentSummaryReplyBody(renderCardSpoofNotice(language), summary.footer)) };
    }
    const verdict = checkDocumentSummaryClaims(reply.shown, message.text, readout.source, language, generalChatReplyPolicy(message.text));
    if (verdict.kind === 'clean') return { ...result, reply: withOutboundBody(result.reply, reply.body) };
    this.deps.logger.info('document summary replaced after the delivered-text check', { messageId: message.id });
    const notice = verdict.kind === 'claim' ? verdict.notice : renderDocumentSummaryTooLong(language);
    return { ...result, reply: withOutboundBody(result.reply, documentSummaryReplyBody(notice, summary.footer)) };
  }

  // ── ADR-0112 / ADR-0110 amendment: connector writes behind exact-payload one-time approvals (CWR-2) ──────────

  /**
   * A handler's `write-draft` (ADR-0112 D5): the flow normalizes the target, checks the allowlist and the credential
   * guard, builds the exact payload and its deterministic preview, and raises the one-time CRITICAL approval bound to
   * the payload hash. With no flow, or no writer for this draft (writes are off), the handler's fixed `fallbackText` is
   * the reply. Nothing is written on this turn in any case.
   */
  protected async handleConnectorWriteDraft(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    outcome: TurnHandlerWriteDraft,
  ): Promise<TurnResult> {
    // ADR-0122 D2.3: the connector-write flow passes the gate with the draft's groups before anything is prepared.
    const deniedDraft = this.surfaceDenied(message.context, actor, surfaceGroupsOfWriteDraft(outcome.draft), { path: 'route' });
    if (deniedDraft) return this.surfaceDeniedTurn(message, session, deniedDraft);
    const flow = this.deps.connectorWriteFlow;
    const history = outcome.history?.assistant;
    if (!flow || !flow.supports(outcome.draft)) {
      return this.respondConnectorWrite(message, session, { context: message.context, text: outcome.fallbackText }, 'RESPONDED', history);
    }
    let step: ConnectorWriteStep;
    try {
      step = await flow.prepare({ session, actor, draft: outcome.draft, now: this.clock(), ...(message.replyTo?.messageId !== undefined ? { replyToMessageId: message.replyTo.messageId } : {}), ownerText: message.text });
    } catch (err) {
      return this.failReadOnlyTurn(message, session, err); // no write call happens while preparing
    }
    return this.respondConnectorWriteStep(message, session, step, outcome.fallbackText, history);
  }

  /**
   * A connector-write step phrase (exact, or a question / negation about it) with no approved write of that kind in this
   * conversation. Runs nothing; the reply is, in order: where the actor's approved write of that kind waits in ANOTHER
   * conversation (live QA cross-session); else this conversation's most recent write of that kind — SENT within the
   * lifetime → already sent with its link (W5-L02); dispatched but unconfirmed (UNCERTAIN / still in flight), at any age
   * until a later write of that kind is SENT → the uncertain warning (it may have been sent; check the target; nothing is
   * resent — Codex P2 on 039d5ff / a2b8aed); else "nothing approved".
   */
  protected async respondStrayConnectorWritePhrase(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    operations: readonly ConnectorWriteOperation[],
  ): Promise<TurnResult> {
    // ADR-0122 D1: a write step phrase in a channel needs `writes` and the service's read group (its replies name targets).
    const deniedWrite = this.surfaceDenied(message.context, actor, [...new Set(operations.flatMap(surfaceGroupsOfWriteOperation))], { path: 'route' });
    if (deniedWrite) return this.surfaceDeniedTurn(message, session, deniedWrite);
    const flow = this.deps.connectorWriteFlow;
    if (flow) {
      const now = this.clock();
      // Execution stays bound to the approving conversation: say where to send the phrase.
      for (const operation of operations) {
        const elsewhere = await flow.approvedElsewhere(session, actor.id, operation, now);
        if (elsewhere) {
          return this.respondComposed(message, session, this.deps.composer.composeConnectorWriteApprovedElsewhere(message.context, elsewhere));
        }
      }
      // Never another conversation's receipt, never an old one.
      for (const operation of operations) {
        const recent = await this.recentConnectorWriteInSession(flow, session, actor, operation, now);
        if (recent) return this.respondRecentConnectorWrite(message, session, recent);
      }
    }
    return this.respondComposed(message, session, this.deps.composer.composeNoApprovedConnectorWrite(message.context));
  }

  /**
   * Codex P2 on 039d5ff: a bare "실행" / "go" / "run it" with no approved write here, right after a write in this
   * conversation that was dispatched but never confirmed, gets the uncertain warning (never chat, which could call it
   * sent or not sent). Null otherwise — the turn routes as before. Runs nothing.
   */
  protected async respondBareExecutionAfterUnconfirmedWrite(
    message: InboundMessage,
    session: Session,
    actor: Actor,
  ): Promise<TurnResult | null> {
    const flow = this.deps.connectorWriteFlow;
    if (!flow || !(isBareExecutionRequest(message.text) || isBareExecutionQuestionOrNegation(message.text))) return null;
    const now = this.clock();
    let newest: RecentConnectorWrite | null = null;
    for (const operation of CONNECTOR_WRITE_OPERATIONS) {
      if (this.surfaceBlocks(message.context, actor, surfaceGroupsOfWriteOperation(operation))) continue;
      const recent = await this.recentConnectorWriteInSession(flow, session, actor, operation, now);
      if (recent && (!newest || recent.at > newest.at)) newest = recent;
    }
    const maySent = newest?.kind === 'unconfirmed' || (newest?.kind === 'latest' && newest.olderUnconfirmed);
    return newest && maySent ? this.respondRecentConnectorWrite(message, session, newest) : null;
  }

  /** This conversation's most recent write of `operation`: SENT (within the lifetime) or dispatched-but-unconfirmed (any age). */
  protected async recentConnectorWriteInSession(
    flow: ConnectorWriteFlow,
    session: Session,
    actor: Actor,
    operation: ConnectorWriteOperation,
    now: IsoTimestamp,
  ): Promise<RecentConnectorWrite | null> {
    // Codex P2/P3 on 55c5a2f: describe the single most recent request of that kind, whatever became of it (no dependence
    // on an older send's lifetime); an older request that may have been sent is still warned about.
    const latest = await flow.latestRequestInSession(session, actor.id, operation);
    if (!latest) return null;
    const state = latest.state;
    switch (state.kind) {
      case 'sent': {
        // W5-L02: "already sent" only within the lifetime; an old send is "nothing approved".
        const sent = await flow.recentSentInSession(session, actor.id, operation, now);
        return sent ? { kind: 'sent', operation, sent, at: sent.sentAt } : null;
      }
      case 'unconfirmed':
        return { kind: 'unconfirmed', operation, status: state.status, at: latest.createdAt };
      case 'closed':
      case 'not-sent': {
        const older = await flow.recentUnconfirmedInSession(session, actor.id, operation, now);
        return {
          kind: 'latest',
          operation,
          latest: latest as ConnectorWriteLatestRequest & { readonly state: { readonly kind: 'closed' | 'not-sent' } },
          olderUnconfirmed: older !== null,
          at: latest.createdAt,
        };
      }
      case 'open': {
        // Not this turn's anchor (that routed above): only an older unresolved write can still be named.
        const older = await flow.recentUnconfirmedInSession(session, actor.id, operation, now);
        return older ? { kind: 'unconfirmed', operation, status: older.status, at: older.at } : null;
      }
    }
  }

  protected respondRecentConnectorWrite(message: InboundMessage, session: Session, recent: RecentConnectorWrite): Promise<TurnResult> {
    const reply =
      recent.kind === 'sent'
        ? this.deps.composer.composeConnectorWriteAlreadyExecuted(message.context, recent.operation, recent.sent)
        : recent.kind === 'latest'
          ? this.deps.composer.composeConnectorWriteLatestRequest(message.context, recent.latest, recent.olderUnconfirmed)
          : this.deps.composer.composeConnectorWriteStep(message.context, {
            kind: 'repeat',
            operation: recent.operation,
            status: recent.status,
          });
    return this.respondComposed(message, session, reply);
  }

  /**
   * ADR-0122 D2.5: whether the APPROVED branch of `handleConnectorWriteAnchorTurn` answers this message with a step that
   * shows or runs the write (the execution phrase, the already-approved / reminder / bare-execution replies) — the same
   * predicates, in the same order; a withdraw is checked by the caller. Pure.
   */
  protected connectorWriteApprovedStepClaims(text: string, operation: ConnectorWriteOperation): boolean {
    if (isAcceptedExecutionPhrase(connectorWriteExecutionGate(operation), text)) return true;
    if (interpretStrayDecisionUtterance(text) === 'approve' || isAnyConnectorWriteExecutionPhrase(text)) return true;
    const loosely = connectorWriteOperationsNamedLoosely(text);
    if (mentionsConnectorWriteExecutionStep(text, operation) || loosely.includes(operation)) return true;
    if (isBareExecutionRequest(text) || isBareExecutionQuestionOrNegation(text) || namesApprovedWriteStepVerb(text, operation)) return true;
    return connectorWriteOperationsAskedAbout(text).length > 0 || loosely.length > 0;
  }

  protected async respondConnectorWriteStep(
    message: InboundMessage,
    session: Session,
    step: ConnectorWriteStep,
    fallbackText: string,
    history?: string,
  ): Promise<TurnResult> {
    const value = await this.approvalDecisions.connectorWriteStepReply(message.context, session.id, step, fallbackText, history);
    const result = this.decisionTurn(session, value);
    if (step.kind !== 'preview') return result;
    // ADR-0113 D7: the approval preview carries the reference line only while the operations UI is on (history unchanged).
    return {
      ...result,
      reply: this.approvalDecisions.withConfirmationReference(
        result.reply,
        step.approval,
        { kind: 'CONNECTOR_WRITE', operation: step.preview.operation },
        session.actorId,
      ),
    };
  }

  protected async respondConnectorWrite(
    message: InboundMessage,
    session: Session,
    reply: OutboundMessage,
    status: RuntimeTurnStatus,
    history?: string,
  ): Promise<TurnResult> {
    return this.decisionTurn(session, await this.approvalDecisions.connectorWriteReply(message.context, session.id, reply, status, history));
  }
  /**
   * A turn while the session holds a connector-write anchor. Returns `null` to let the turn route normally, or
   * `'released'` when the anchor was closed on the way (an abandoned choice) so the caller mirrors the restored pointer.
   *
   * - `APPROVAL_PENDING` intercepts every turn: the ADR-0095 interpreter decides; "승인" is re-checked against the
   *   ADR-0093 lifetime immediately before `ApprovalManager.decide`; anything ambiguous re-prompts with the preview.
   * - `APPROVED` executes ONLY on the operation's exact allow-listed phrase (EXECUTION_PHRASES); another write's phrase
   *   or a bare "승인" names the right phrase; the owner's "거절"/"취소" discards it; anything else falls through and the
   *   grant waits — at most the ADR-0093 lifetime (`releaseExpired` at turn start).
   * - `AWAITING_CHOICE` takes a number on the next turn only; any other message abandons the choice.
   * - After execution a repeated phrase reports the recorded outcome and never sends again.
   */
  protected async handleConnectorWriteAnchorTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    view: ConnectorWriteAnchorView,
  ): Promise<TurnResult | 'released' | null> {
    const flow = this.deps.connectorWriteFlow;
    if (!flow) return null;
    const { anchor } = view;
    const history = anchor.family === 'calendar' ? CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE : undefined;
    const respond = (step: ConnectorWriteStep): Promise<TurnResult> =>
      this.respondConnectorWriteStep(message, session, step, '', history);
    // ADR-0122 D2.5: every step that shows this write or runs it re-checks `writes` and the service's read group against
    // this (the approving) conversation, immediately before; withdrawing it ("거절" / "취소" / a stop word) always passes.
    const writeGroups = surfaceGroupsOfWriteFamily(anchor.family);
    const deniedStep = async (): Promise<TurnResult | null> => {
      const denied = this.surfaceDenied(message.context, actor, writeGroups, { path: 'approval' });
      return denied ? this.surfaceDeniedTurn(message, session, denied) : null;
    };
    switch (anchor.status) {
      case 'APPROVAL_PENDING': {
        const approval = view.approval;
        if (!approval || !anchor.operation || !anchor.preview) return null;
        const deniedPending = await this.surfaceDeniedDecision(message, session, actor, writeGroups);
        if (deniedPending) return deniedPending;
        const phrase = documentedExecutionPhrase(connectorWriteExecutionGate(anchor.operation));
        // Only the actor who asked may decide (the anchor binds actor and session); anyone else is re-prompted.
        // Live QA session 4 (N2): a whole-message "됐어" / "never mind" cancels too (closing sends nothing).
        const interpreted = anchor.actorId === actor.id ? interpretDecision(message.text) : 'ambiguous';
        const decision = interpreted === 'ambiguous' && anchor.actorId === actor.id && isPendingCancelUtterance(message.text)
          ? 'cancel'
          : interpreted;
        this.deps.logger.info('approval decision interpreted', { approvalId: approval.id, decision });
        if (decision === 'ambiguous') {
          const reply = this.deps.composer.composeConnectorWritePending(
            message.context,
            anchor.preview,
            this.remainingMs(approval),
            phrase,
          );
          const reminded = await this.respondConnectorWrite(message, session, reply, 'AWAITING_APPROVAL', history);
          // ADR-0113 D7: the reference line rides the reminder only while the operations UI is on (history unchanged).
          return {
            ...reminded,
            reply: this.approvalDecisions.withConfirmationReference(
              reminded.reply,
              approval,
              { kind: 'CONNECTOR_WRITE', operation: anchor.operation },
              session.actorId,
            ),
          };
        }
        // ADR-0113 D7: the shared decision path (expiry re-check, decide, record approval or close) — the UI runs it too.
        return this.decisionTurn(
          session,
          await this.approvalDecisions.decideConnectorWrite(this.chatDecision(message, session, actor), view, decision),
        );
      }
      case 'AWAITING_CHOICE': {
        const index = connectorWriteChoiceIndex(message.text);
        if (index !== null) {
          const deniedChoice = await deniedStep();
          if (deniedChoice) return deniedChoice;
          let step: ConnectorWriteStep;
          try {
            step = await flow.choose({ session, actor, view, index, now: this.clock() });
          } catch (err) {
            return this.failReadOnlyTurn(message, session, err);
          }
          return respond(step);
        }
        const decision = interpretStrayDecisionUtterance(message.text);
        await flow.close(session, view, 'abandoned', this.clock());
        // Live QA session 4 (N2): "그만" / "아니" / "됐어" / "stop" close the choice with the fixed reply too — never chat,
        // which could not tell what had (not) happened.
        if (decision === 'deny' || decision === 'cancel' || isPendingCancelUtterance(message.text)) {
          return respond({ kind: 'closed', reason: 'abandoned', family: anchor.family });
        }
        return 'released'; // next-turn-only: any other message is a new turn
      }
      case 'APPROVED': {
        if (!anchor.operation) return null;
        const gate = connectorWriteExecutionGate(anchor.operation);
        const decisionWord = interpretStrayDecisionUtterance(message.text);
        const withdrawing = anchor.actorId === actor.id && (decisionWord === 'deny' || decisionWord === 'cancel' || (decisionWord === null && isPendingCancelUtterance(message.text)) || isBareExecutionProhibition(message.text));
        if (!withdrawing && this.connectorWriteApprovedStepClaims(message.text, anchor.operation)) {
          const deniedRun = await deniedStep();
          if (deniedRun) return deniedRun;
        }
        if (isAcceptedExecutionPhrase(gate, message.text)) {
          // Not caught here: after the consume save a failure may follow the send, so the `handle` backstop's
          // "cannot verify" wording is the truthful one. Validation + consume share the revocation's locks (Codex P1).
          // ADR-0122 D2.5: the grant is re-read (live, not this turn's snapshot) inside the execution claim, right
          // before the grant is consumed; a revoke that landed meanwhile wins and nothing is sent.
          const recheck = this.channelGate(message.context) === undefined
            ? undefined
            : () => this.surfaceStillAllows(message.context, actor, writeGroups);
          try {
            const executed = await this.approvalDecisions.executeConnectorWrite(this.chatDecision(message, session, actor), view, recheck);
            // ADR-0112 amendment 1 S3 (context eval P4): every outcome of the write is the last action (receipt id), so
            // "되돌려줘" answers about it and never reaches an older to-do or reminder.
            if (executed.kind === 'outcome') {
              const { source, entryId } = externalLastActionOf(anchor.family, executed.operation);
              await this.deps.nlSelection?.recordExternalWrite?.({ session, actor, message, now: this.clock(), source, entryId, receiptId: executed.receiptId ?? view.taskId, outcome: executed.outcome.status, anchorTaskId: view.taskId, ...(anchor.undoOf !== undefined ? { undoOf: anchor.undoOf.entryId } : {}) });
            }
            return respond(executed);
          } catch (error) {
            if (!(error instanceof SurfaceDeniedError)) throw error;
            return this.surfaceDeniedTurn(message, session, error.decision);
          }
        }
        const decision = interpretStrayDecisionUtterance(message.text);
        // Another write's execution phrase while this one waits approved: it runs nothing, and the reply names the
        // phrase that would (the generic "nothing approved" would be untrue).
        if (decision === 'approve' || isAnyConnectorWriteExecutionPhrase(message.text)) {
          const reply = this.deps.composer.composeConnectorWriteAlreadyApproved(
            message.context,
            anchor.operation,
            documentedExecutionPhrase(gate),
          );
          return this.respondConnectorWrite(message, session, reply, 'RESPONDED', history);
        }
        // W5-L01: a question/negation about the execution step ("댓글 실행해도 돼?") gets the non-mutating reminder, never
        // chat (a model must not claim a send) and never an execution (the exact phrase stays the only executor).
        const loosely = connectorWriteOperationsNamedLoosely(message.text);
        if (mentionsConnectorWriteExecutionStep(message.text, anchor.operation) || loosely.includes(anchor.operation)) {
          const reply = this.deps.composer.composeConnectorWriteApprovedReminder(
            message.context,
            anchor.operation,
            documentedExecutionPhrase(gate),
            anchor.preview ? connectorWriteTargetOf(anchor.preview) : undefined,
          );
          return this.respondConnectorWrite(message, session, reply, 'RESPONDED', history);
        }
        // Routing exec gaps (INT-2 finding): a bare "실행" / "실행해줘" / "go" / "run it" names no step. It runs nothing
        // (the exact phrase stays the only executor) and gets a deterministic reply quoting the approved write's phrase,
        // never chat (a model could answer as if it ran). A question / negation about ANOTHER write's step names the
        // phrase that would run here too (the stray "nothing approved" reply would be untrue).
        // Codex P2 on 5594c16: a bare prohibition ("실행하지 마") withdraws this grant through the serialized revoke path
        // (a cancel; nothing is sent), never "nothing approved". Only the actor who asked may withdraw it; anyone else
        // gets the exact-phrase hint like a bare question ("실행해도 돼?", "실행할까?").
        if (isBareExecutionProhibition(message.text) && anchor.actorId === actor.id) {
          return this.decisionTurn(
            session,
            await this.approvalDecisions.revokeConnectorWrite(this.chatDecision(message, session, actor), view, 'cancelled'),
          );
        }
        // The approved write's own step verb without its object noun ("삭제 실행") is the same non-executing hint.
        if (isBareExecutionRequest(message.text) || isBareExecutionQuestionOrNegation(message.text) || namesApprovedWriteStepVerb(message.text, anchor.operation)) {
          const reply = this.deps.composer.composeConnectorWriteBareExecution(
            message.context,
            anchor.operation,
            documentedExecutionPhrase(gate),
            anchor.preview ? connectorWriteTargetOf(anchor.preview) : undefined,
          );
          return this.respondConnectorWrite(message, session, reply, 'RESPONDED', history);
        }
        if (connectorWriteOperationsAskedAbout(message.text).length > 0 || loosely.length > 0) {
          const reply = this.deps.composer.composeConnectorWriteAlreadyApproved(
            message.context,
            anchor.operation,
            documentedExecutionPhrase(gate),
          );
          return this.respondConnectorWrite(message, session, reply, 'RESPONDED', history);
        }
        // Only the actor who asked may discard the grant; anyone else's "거절" decides nothing here. D12: the approval is
        // recorded withdrawn (REJECTED) together with the close, under the approval → session locks (#132 rules).
        // Live QA session 4 (N2): "그만" / "됐어" / "stop" withdraw it like "취소" (nothing is sent either way).
        const withdraws = decision === 'deny' || decision === 'cancel' || (decision === null && isPendingCancelUtterance(message.text));
        if (withdraws && anchor.actorId === actor.id) {
          return this.decisionTurn(
            session,
            await this.approvalDecisions.revokeConnectorWrite(
              this.chatDecision(message, session, actor),
              view,
              decision === 'deny' ? 'denied' : 'cancelled',
            ),
          );
        }
        return null;
      }
      case 'EXECUTING':
      case 'SENT':
      case 'NOT_SENT':
      case 'UNCERTAIN': {
        // Codex P1 on 55c5a2f: the owner's 거절/취소 while the approved write is already executing cannot withdraw it; say
        // so (the executing turn reports the outcome) — never "nothing was sent".
        // Codex P2 on b571e4d: the wider stop words ("그만", "아니", "됐어", "stop") take the same late path as 취소/거절 —
        // "already started" while executing; once finished, the deterministic "nothing to decide" (취소's route) — never chat.
        if (anchor.actorId === actor.id) {
          const decision = interpretStrayDecisionUtterance(message.text);
          const stopWord = decision === null && isPendingCancelUtterance(message.text);
          if (anchor.status === 'EXECUTING' && anchor.operation && (decision === 'deny' || decision === 'cancel' || stopWord)) {
            const reply = this.deps.composer.composeConnectorWriteRevokeTooLate(message.context, anchor.operation);
            return this.respondConnectorWrite(message, session, reply, 'RESPONDED', history);
          }
          if (anchor.status !== 'EXECUTING' && stopWord) {
            return this.respondComposed(message, session, this.deps.composer.composeNoPendingDecision(message.context));
          }
        }
        if (!anchor.operation || !isAcceptedExecutionPhrase(connectorWriteExecutionGate(anchor.operation), message.text)) {
          return null;
        }
        const deniedFinished = await deniedStep();
        if (deniedFinished) return deniedFinished;
        const now = this.clock();
        // Live QA (cross-session): this conversation's write is finished, but an approved one of the same kind waits in
        // another conversation — run nothing and say where its phrase must be sent.
        const elsewhere = await flow.approvedElsewhere(session, actor.id, anchor.operation, now);
        if (elsewhere) {
          const reply = this.deps.composer.composeConnectorWriteApprovedElsewhere(message.context, elsewhere);
          return this.respondConnectorWrite(message, session, reply, 'RESPONDED', history);
        }
        // An old send is not "already executed" any more: the stray-phrase path answers (nothing approved).
        if (isConnectorWriteSendStale(anchor, now)) return null;
        // Live QA session 3 (D1) / Codex P2: when a later request of the same kind exists in this conversation, the reply
        // describes THAT request (rejected, expired, not sent, …), never this one as "already sent".
        const latest = await flow.latestRequestInSession(session, actor.id, anchor.operation);
        if (latest && latest.taskId !== view.taskId) {
          return this.respondStrayConnectorWritePhrase(message, session, actor, [anchor.operation]);
        }
        return respond(await flow.execute({ session, actor, view, now }));
      }
      default:
        return null;
    }
  }
}
