import { describeAiFailure } from '../ai-failure';
import { generalChatReplyPolicy, generalChatReplyPolicyMetadata } from '../chat-policy/chat-response-policy';
import { guardInternalActionClaims } from '../chat-policy/internal-action-claim-guard';
import {
  detectOwnMemoryRecallQuestion,
  hasOwnMemoryRecallHit,
  renderOwnMemoryDmOnly,
  renderOwnMemoryNotFound,
} from '../chat-policy/own-memory-recall';
import {
  noticeLanguage,
} from '../chat-policy/internal-action-vocabulary';
import {
  isAttachmentReplyWithheld,
  renderAttachmentReplyWithheld,
  withAttachedTextFiles,
} from '../attachment-context';
import {
  isDirectConversation,
  outboundBody,
  outboundMessage,
  plainTextOf,
} from '../message-rendering';
import {
  detectConversationControl,
} from '../conversation-commands';
import {
  IntentClassifier,
  externalActionRequestOf,
} from '../intent-classifier';
import {
  guardFalseControlDenials,
  guardFalseIncapabilityClaims,
  guardShownListingDenials,
  nlShownItemTitles,
  nlShownItemWords,
  nlSpanRequestsOfferedSource,
  nlUnquoteNonCommands,
  CLOSED_QUESTION_FACT,
  renderConfiguredSourcesFact,
  renderControlCommandsFact,
  type NlControlScope,
} from '../nl-routing/honest-chat';
import { languageOf } from '../nl-routing/nl-selection-service';
import type { LastTurnReplyKind } from '../nl-routing/last-turn';
import {
  LAST_REPLY_METADATA_KEY,
  nlBareYesNo,
  readClosedQuestion,
  readLastReply,
} from '../nl-routing/last-reply';
import type { MessageBody } from '../../domain';
import { type PendingQuestion } from '../nl-routing/selection-state';
import { parseActionSwitchPhrase } from '../nl-routing/action-switch';
import {
  Capability,
  IntentType,
  TaskStatus,
} from '../../domain';
import type {
  Actor,
  Artifact,
  ContextBundle,
  Id,
  InboundMessage,
  Intent,
  OutboundMessage,
  Session,
  Task,
  TurnWorkFacts,
} from '../../domain';
import {
  executionLocalityOf,
  type AiExecutionResult,
  type ProjectReadout,
} from '../../ports';
import { ProviderGatewayTerminalStatus } from '../provider-routing-gateway';
import { RoutingFailureCode } from '../runtime-response-validation-contracts';
import type {
  RuntimeProviderRoutingAudit,
} from '../runtime-provider-routing-service';
import type { ExternalWorkReadout } from '../work-chat/external-work-readout';
import { todoListLeavesUnexpressedContent } from '../work-chat/work-chat-command';
import {
  curatedExamplesForPrompt,
  isExternalWorkReadout,
} from '../prompt-composer';
import {
  isR2DocumentSource,
  isUntrustedDocumentReadout,
  renderUntrustedDocumentHistoryNote,
  renderUntrustedDocumentReplyWithheld,
  type UntrustedDocumentReadout,
  type UntrustedDocumentSource,
} from '../untrusted-document-readout';
import {
  checkDocumentSummaryClaims,
  renderDocumentSummaryTooLong,
} from '../document-summary-claim-check';
import { combinedUsage } from '../provider-usage-record';
import { runUsageRecord } from '../provider-usage-record';
import { documentSummaryCredentialShaped } from './helpers';
import type { NlChatFacts } from './internal-types';
import { ConversationRuntimeBase } from './runtime-base';
import { needsWorkspace } from './turn-intents';
import type { TurnResult } from './types';

export abstract class ConversationRuntimeChatLayer extends ConversationRuntimeBase {
  /** A6 R5a §1.2: write `quoky.lastTurn` for an owner DM turn (the service writes nothing while the flag is off). */
  protected async recordNlLastTurn(message: InboundMessage): Promise<void> {
    const nl = this.deps.nlSelection;
    const facts = this.nlTurnFacts.get(message);
    if (nl?.recordLastTurn === undefined || facts === undefined || nl.deicticWritesMode?.() === 'off') return;
    const kind = this.nlReplyKinds.get(message) ?? { kind: 'chat' as const };
    await nl.recordLastTurn({
      session: { id: facts.sessionId },
      actorId: facts.actorId,
      message: {
        id: message.id,
        text: message.text,
        attachmentCount: message.attachments?.length ?? 0,
        quoted: (message.quotedRanges?.length ?? 0) > 0,
        codeFormatted: message.formatting?.code === true,
      },
      ...(facts.memoryId !== undefined ? { memoryId: facts.memoryId } : {}),
      replyKind: kind.kind,
      ...(kind.listingSource !== undefined ? { listingSource: kind.listingSource } : {}),
      now: this.clock(),
      direct: isDirectConversation(message.context),
    });
  }

  /** Owner decision of 2026-10-29: write `quoky.lastReply` (whether this turn was answered by chat; nothing unless `active`). */
  protected async recordNlLastReply(message: InboundMessage): Promise<void> {
    const nl = this.deps.nlSelection;
    const facts = this.nlTurnFacts.get(message);
    if (nl?.recordLastReply === undefined || nl.mode !== 'active' || facts === undefined) return;
    await nl.recordLastReply({ id: facts.sessionId }, facts.actorId, this.nlChatReplies.has(message), this.clock(), this.nlClosedQuestions.has(message));
  }

  /**
   * Owner decision of 2026-10-29 ("1번 진행", context eval `sc-confirm-chat-yes`): this chat turn follows an open D7 question
   * Core closed without an answer, so its prompt carries {@link CLOSED_QUESTION_FACT}. Either this very turn took the
   * actor's question (and is chat, so it did not answer it), or the actor's fresh `quoky.lastReply` holds
   * `questionClosedAt` (every reply since was chat). Only in `active`, only for GENERAL_CHAT / POLICY_SENSITIVE_CHAT.
   */
  protected closedQuestionFact(message: InboundMessage, session: Session, actor: Actor, capability: Capability): string | undefined {
    if (this.deps.nlSelection?.mode !== 'active') return undefined;
    if (capability !== Capability.GENERAL_CHAT && capability !== Capability.POLICY_SENSITIVE_CHAT) return undefined;
    const closed = this.nlClosedQuestions.has(message) || readClosedQuestion(session.metadata?.[LAST_REPLY_METADATA_KEY], actor.id, this.clock());
    return closed ? CLOSED_QUESTION_FACT : undefined;
  }

  /**
   * Owner decision of 2026-10-29: this chat-bound turn is a stale bare yes or no. All of: selection is `active`; the turn
   * is chat; no D7 question was open at its start (`takePending` ran and found none); no approval, override, connector-write
   * or apply-preview anchor is open (`anchored`); the whole message, after input preparation, is a yes or no of the closed
   * continuation reply set; and the fresh `quoky.lastReply` says Quoky's previous reply was NOT chat. No record (a new
   * session, an expired one, selection not active before) keeps today's chat route.
   */
  protected isStaleBareYesNo(message: InboundMessage, session: Session, actor: Actor, intent: Intent, nlPending: PendingQuestion | null | undefined, anchored: boolean): boolean {
    if (this.deps.nlSelection?.mode !== 'active' || nlPending !== null || anchored) return false;
    if (intent.type !== IntentType.CHAT || (intent.capability !== Capability.GENERAL_CHAT && intent.capability !== Capability.POLICY_SENSITIVE_CHAT)) return false;
    if (nlBareYesNo(message.text, message.attachments?.length ?? 0, message.quotedRanges ?? []) === 'none') return false;
    return readLastReply(session.metadata?.[LAST_REPLY_METADATA_KEY], actor.id, this.clock())?.chat === false;
  }

  /** An A6 question, refusal or (R5a) preview: its body, and its fixed history note when it shows the owner's items. */
  protected async respondNlAsk(
    message: InboundMessage,
    session: Session,
    decision: { readonly text: string; readonly body?: MessageBody; readonly history?: string; readonly replyKind?: LastTurnReplyKind },
  ): Promise<TurnResult> {
    this.nlReplyKinds.set(message, { kind: decision.replyKind ?? 'question' });
    const reply = outboundMessage(message.context, decision.body ?? decision.text);
    await this.deps.memory.recordAssistant(decision.history ?? reply.text, message.context, session.id);
    return { status: 'RESPONDED', reply, sessionId: session.id };
  }

  /**
   * ADR-0120 follow-up: after a turn, a `lastSelection` that this turn did not itself write or record (a selection, or a
   * handler's grammar listing) is cleared — a turn answered by help, an approval, a write preview or a clarification
   * question has no catalog equivalent, so a later "그 중에 …" must not bind to an older, unrelated listing. Owner
   * decision D1 (2026-10-26) reverses follow-up 2 for a turn answered by chat: the record stays, one turn older, within
   * its own 30 minutes, and the selector is told how many chat turns came after it.
   */
  protected async settleNlLastSelection(message: InboundMessage, failed = false): Promise<void> {
    const turn = this.nlTurns.get(message);
    if (turn === undefined || (turn.keep && !failed)) return;
    this.nlTurns.delete(message);
    const facts = this.nlTurnFacts.get(message);
    const keep = this.deps.nlSelection?.keepLastSelectionAcrossChat;
    if (turn.chat === true && !failed && facts !== undefined && keep !== undefined) {
      await keep.call(this.deps.nlSelection, { id: turn.sessionId }, facts.actorId, this.clock());
      return;
    }
    await this.deps.nlSelection?.clearLastSelection?.({ id: turn.sessionId });
  }

  /** D1: mark that this turn is answered by chat (a general or policy-sensitive chat reply), so settle keeps the record. */
  protected markNlChatTurn(message: InboundMessage, capability: Capability): void {
    if (capability !== Capability.GENERAL_CHAT && capability !== Capability.POLICY_SENSITIVE_CHAT) return;
    this.nlChatReplies.add(message);
    const turn = this.nlTurns.get(message);
    if (turn !== undefined && !turn.keep) turn.chat = true;
  }

  /**
   * Owner decision of 2026-10-28 (fix 1 of the 95386868 context analysis): when this turn wrote `lastSelection` (it showed
   * a listing), the words of the items Core itself rendered in that reply are held IN PROCESS MEMORY ONLY, per session and
   * actor, for the shown-listing guard (`ShownListing.itemWords`). They are never persisted, logged or sent anywhere
   * (ADR-0110 D4), and they are used only while `lastSelection` still names the same entry, within its own 30 minutes.
   */
  protected holdNlShownItemWords(message: InboundMessage, result: TurnResult): void {
    const turn = this.nlTurns.get(message);
    const facts = this.nlTurnFacts.get(message);
    if (turn?.keep !== true || facts === undefined) return;
    const text = plainTextOf(outboundBody(result.reply));
    // Codex review of 7f7e8d32: bound to this turn's own listing record (its turn id), never to a completion time.
    this.nlShownItems.set(`${facts.sessionId}|${facts.actorId}`, { turnId: message.id, words: nlShownItemWords(text), titles: nlShownItemTitles(text) });
  }

  /** Mark that this turn wrote `lastSelection` (the selection service did), so the settle step keeps it. */
  protected keepNlLastSelection(message: InboundMessage, session: Session): void {
    const turn = this.nlTurns.get(message);
    if (turn !== undefined) turn.keep = true;
    else this.nlTurns.set(message, { sessionId: session.id, keep: true });
  }

  /**
   * ADR-0120 A2 (implementation note 2): the classifier's personal-work surface clause yields to selection on this turn —
   * the A2 gate is on and the message leaves content the to-do / my-work phrase family cannot express.
   */
  protected nlSurfaceYields(message: InboundMessage): boolean {
    return this.nlYield.has(message) && todoListLeavesUnexpressedContent(message.text.trim());
  }

  /** ADR-0120 D6 Phase C (S1) is on for this turn: `QUOKY_NL_PHASE=c`, `active` or `shadow`, and no approval pending. */
  protected nlPhaseC(pending: unknown): boolean {
    return !pending && this.deps.nlSelection?.phaseCEnabled?.() === true;
  }

  /** S1 `c-shadow` is on for this turn: `QUOKY_NL_PHASE=c-shadow` with `active`, and no approval pending. */
  protected nlPhaseCShadow(pending: unknown): boolean {
    return !pending && this.deps.nlSelection?.phaseCShadowEnabled?.() === true && this.deps.nlSelection.shadowGrammarHit !== undefined;
  }

  /** (F) Existing single-capability work path (relocated from QuokyCore), returning a reply. */
  protected async handleWorkTurn(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    intent: Intent,
    excludeMemoryId: Id,
    readout: ProjectReadout | ExternalWorkReadout | UntrustedDocumentReadout | undefined,
    nlFacts?: NlChatFacts,
  ): Promise<TurnResult> {
    // Live DM test 2026-10-20: the switch phrases are recognized on this owner DM turn (the fact names them; the guard keeps them).
    const controls = isDirectConversation(message.context) ? this.switchScope() : undefined;
    this.markNlChatTurn(message, intent.capability);
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
      const workspace = needsWorkspace(capability)
        ? await this.deps.workspace.prepare(task)
        : undefined;
      // ADR-0100 D8 / ADR-0096 D4: a connector work summary is self-contained — no short-term history or durable
      // recall is read for it (PromptComposer also ignores the bundle for an external-work readout).
      // ADR-0111 D3: the current message's text attachments join the bundle as one bounded, untrusted Resource
      // (from the InboundMessage only; never persisted). A work summary stays self-contained and carries none.
      // ADR-0118 D7: a document summary is self-contained the same way (no transcript, recall or attachments).
      // ADR-0122 D7 (P2): a channel holding `memory` while the gate is enforced gets durable recall and curated examples.
      const channelRecall = this.channelHoldsGroup(message.context, actor, 'memory');
      const bundle: ContextBundle = isExternalWorkReadout(readout) || isUntrustedDocumentReadout(readout)
        ? { taskId: task.id, conversationTranscript: [], backgroundResources: [] }
        : withAttachedTextFiles(
            channelRecall
              ? await this.deps.contextBuilder.build(task, excludeMemoryId ? [excludeMemoryId] : [], { channelRecall: true })
              : await this.deps.contextBuilder.build(task, excludeMemoryId ? [excludeMemoryId] : []),
            message,
          );

      // W3-L01 (ADR-0104 D3, ADR-0106): an own-memory recall question ("내가 좋아하는 과일이 뭐였지?") whose assembled
      // context holds nothing relevant — no active durable recall sharing a topic word or scored very high
      // semantically (archived/expired/superseded records never reach the bundle; live QA D5) and no earlier User turn
      // of this conversation mentioning it — is answered truthfully without a provider, which used to invent a
      // personal fact. A hit keeps the provider flow below unchanged.
      if (
        (capability === Capability.GENERAL_CHAT || capability === Capability.POLICY_SENSITIVE_CHAT) &&
        !isExternalWorkReadout(readout)
      ) {
        const ownMemoryQuestion = detectOwnMemoryRecallQuestion(message.text);
        if (ownMemoryQuestion && !hasOwnMemoryRecallHit(ownMemoryQuestion, bundle)) {
          // P0 / ADR-0122 D7: outside a DM no durable memory is recalled (except in a channel holding `memory` while the
          // gate is enforced), so "not in my memory" would be untrue there.
          const direct = isDirectConversation(message.context) || channelRecall;
          const text = direct
            ? renderOwnMemoryNotFound(ownMemoryQuestion.language)
            : renderOwnMemoryDmOnly(ownMemoryQuestion.language);
          await this.deps.tasks.completeRun(run, {
            artifactIds: [],
            metadata: { deterministicReply: direct ? 'own-memory-not-found' : 'own-memory-dm-only' },
          });
          await this.deps.memory.recordAssistant(text, message.context, task.sessionId ?? session.id);
          await this.deps.tasks.transition(task, TaskStatus.COMPLETED);
          // Content-free (no question or topic text).
          this.deps.logger.info('own memory question answered without recall hit', { taskId: task.id, capability });
          return this.responded(session, { context: message.context, text }, workFacts(undefined));
        }
      }

      // ADR-0120 D9: after a `none` selection the chat prompt carries one more authoritative Core fact (the configured
      // sources and their commands); without it the call is exactly as before.
      // Live DM test 2026-10-20 (Codex P2): while the switch phrases are recognized, every owner DM chat prompt names them,
      // with or without a selection or a read catalog this turn.
      const sourcesFact =
        nlFacts !== undefined
          ? renderConfiguredSourcesFact(nlFacts.entries, this.contributedHelpLines, controls !== undefined ? { controls } : {})
          : controls !== undefined && (capability === Capability.GENERAL_CHAT || capability === Capability.POLICY_SENSITIVE_CHAT)
          ? renderControlCommandsFact(controls)
          : undefined;
      // Owner decision of 2026-10-29 ("1번 진행"): the closed-question fact, beside the D9 / control facts.
      const closedFact = this.closedQuestionFact(message, session, actor, capability);
      const chatFacts = [sourcesFact, closedFact].filter((fact): fact is string => fact !== undefined);
      const nlComposition = chatFacts.length === 0 ? undefined : { additionalCurrentFacts: chatFacts };
      const promptSpec =
        nlComposition === undefined
          ? this.deps.promptComposer.compose(task, bundle, readout)
          : this.deps.promptComposer.compose(task, bundle, readout, nlComposition);
      const renderOptions = {
        capability,
        ...(workspace ? { workspace } : {}),
        // ADR-0098 D2: structured reply facts from the actual current User message (the same text PromptComposer
        // renders as the current turn), so adapters never re-derive them from the serialized prompt. Amendment D2:
        // a POLICY_SENSITIVE_CHAT turn gets them too, plus Core's external-action classification of that message,
        // which alone enables the adapter's action-claim guard.
        ...(capability === Capability.GENERAL_CHAT || capability === Capability.POLICY_SENSITIVE_CHAT
          ? { metadata: generalChatReplyPolicyMetadata(task.description, externalActionRequestOf(task.intent)) }
          : {}),
      };
      const aiRequest = this.deps.promptRenderer.render(promptSpec, renderOptions);

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
          // ADR-0111 D3: the attachment credential check runs FIRST, on the original reply and every artifact.
          const withheld = this.withheldAttachmentReply(bundle, message, routed.output.text, routed.output.artifacts, task.id);
          const guard = withheld ? null : this.guardChatReply(capability, routed.output.text, task.description, task.id, nlFacts, controls);
          const replyText = withheld?.text ?? guard?.text ?? routed.output.text;
          const artifacts: Artifact[] = withheld ? [] : routed.output.artifacts.map((artifact) => ({ ...artifact }));
          const artifactIds = await this.deps.artifacts.persistAll(task.id, run.id, artifacts);
          await this.deps.tasks.completeRun(run, {
            artifactIds,
            providerId,
            metadata: { routingAudit },
          });
          await this.deps.memory.recordAssistant(replyText, message.context, task.sessionId ?? session.id);
          await this.deps.tasks.transition(task, TaskStatus.COMPLETED);
          const reply = this.asModelReply(
            this.deps.composer.compose(message.context, { text: replyText, artifacts }, artifacts),
            routed.output.text,
            { withheld: withheld !== null, guarded: guard?.guarded === true },
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

      // A6 R2 (D6, amendment C9): a Jira / Slack item summary carries the data-only work-text constraint.
      const selectionContext = {
        sessionId: session.id,
        actorId: actor.id,
        ...(isUntrustedDocumentReadout(readout) && isR2DocumentSource(readout.source) ? { workText: true as const } : {}),
      };
      // ADR-0116 D3: the selector reports, with the provider, whether it is the owner's explicit selection; a selector
      // without `resolve` reports nothing, which counts as "not an owner selection" (fail closed).
      const resolved = this.deps.router.resolve
        ? await this.deps.router.resolve(capability, selectionContext)
        : { provider: await this.deps.router.select(capability, selectionContext) };
      const provider = resolved.provider;
      providerId = provider.id;
      // ADR-0107 D6 / ADR-0116: the curated-example layer is composed only now that the provider for this execution
      // is resolved, from its declared locality and the selection source (data, never its id): LOCAL, or REMOTE when
      // the flag-gated egress class allows an owner-selected provider. Otherwise — and on the routed seam above — the
      // request stays exactly as composed without it; there is no re-execution elsewhere.
      const composition = {
        executionLocality: executionLocalityOf(provider),
        ...('source' in resolved ? { selectionSource: resolved.source } : {}),
        ...(nlComposition ?? {}),
      };
      const curatedExampleCount = curatedExamplesForPrompt(task, bundle, readout, composition).length;
      const executionRequest =
        curatedExampleCount > 0
          ? this.deps.promptRenderer.render(
              this.deps.promptComposer.compose(task, bundle, readout, composition),
              renderOptions,
            )
          : aiRequest;
      await this.deps.dispatchCommit.commit(run.id, run.id);
      const firstExecution = await provider.execute(executionRequest);
      // ADR-0104 D1: the internal-action claim guard runs on every chat reply, whichever provider produced it.
      // ADR-0111 D3: the attachment credential check runs FIRST, on the original reply and every artifact.
      // ADR-0118 D7/D8: a document summary gets both — the credential check (its own notice) and the claim check
      // (`checkDocumentSummaryClaims`: the ADR-0104 guard and the summary guard, read more strictly), so a summary an
      // injected item steered toward "I added a to-do / set a reminder" is never shown. ADR-0104 D1 amendment (owner,
      // 2026-10-15): a flagged first draft is regenerated ONCE with the stricter attribution rule (the flagged text is
      // never fed back); a second flagged draft is replaced whole by the fixed notice.
      const documentSummary = isUntrustedDocumentReadout(readout);
      const summaryCheck = documentSummary
        ? await this.documentSummaryWithOneRegeneration(
            firstExecution,
            message,
            task,
            readout.source,
            () => provider.execute(this.deps.promptRenderer.render(this.deps.promptComposer.compose(task, bundle, readout, { ...composition, documentSummaryRetry: true }), renderOptions)),
          )
        : undefined;
      const executed = summaryCheck?.executed ?? firstExecution;
      const withheld = documentSummary
        ? this.withheldDocumentSummaryReply(message, executed.text, executed.artifacts ?? [], task.id)
        : this.withheldAttachmentReply(bundle, message, executed.text, executed.artifacts ?? [], task.id);
      const chatGuard = withheld || documentSummary ? null : this.guardChatReply(capability, executed.text, task.description, task.id, nlFacts, controls);
      const guard = documentSummary ? (withheld ? null : (summaryCheck?.guard ?? null)) : chatGuard;
      // Review P3-1: a document summary keeps no provider artifacts (they could carry mail-derived text into storage).
      const result = withheld
        ? { ...executed, ...withheld }
        : { ...executed, text: guard?.text ?? executed.text, ...(documentSummary ? { artifacts: [] } : {}) };

      const artifactIds = await this.deps.artifacts.persistAll(task.id, run.id, result.artifacts ?? []);
      // ADR-0107 measurement hook: the run records how many curated examples it carried (a count, never text or ids),
      // so the 👎 rate of turns with and without examples can be compared.
      const runMetadata =
        curatedExampleCount > 0 ? { ...(result.audit ?? {}), curatedExampleCount } : result.audit;
      // ADR-0115 D8 (PRV-3): the run's `Usage` (reported counts, or the label alone = "unknown"; never estimated) on TaskRun.usage.
      const usage = runUsageRecord(executed.usage);
      await this.deps.tasks.completeRun(run, {
        artifactIds,
        ...(providerId ? { providerId } : {}),
        ...(runMetadata ? { metadata: runMetadata } : {}),
        ...(usage ? { usage } : {}),
      });
      // ADR-0118 D7/D8: a document summary is never kept as transcript (a fixed note instead), so neither the item's
      // text nor anything an injected item steered the model to write reaches a later prompt.
      await this.deps.memory.recordAssistant(
        documentSummary ? renderUntrustedDocumentHistoryNote(readout.source, noticeLanguage(undefined, message.text)) : result.text,
        message.context,
        task.sessionId ?? session.id,
      );
      if (capability === Capability.PROJECT_ANALYSIS && task.projectId) {
        await this.deps.memory.recordToolMemory(result.text, {
          projectId: task.projectId,
          sessionId: task.sessionId ?? session.id,
        });
      }
      await this.deps.tasks.transition(task, TaskStatus.COMPLETED);
      const composed = this.deps.composer.compose(message.context, result, result.artifacts ?? []);
      // Review P2-4: a document summary is never a model reply (its body is rebuilt as an untrusted span by the caller).
      const reply = documentSummary
        ? composed
        : this.asModelReply(composed, executed.text, { withheld: withheld !== null, guarded: guard?.guarded === true });
      return this.responded(session, reply, workFacts(providerId));
    } catch (err) {
      const failure = describeAiFailure(err);
      await this.deps.tasks.failRun(run, failure.errorSummary, {
        ...(providerId ? { providerId } : {}),
        ...(routingAudit ? { metadata: { routingAudit } } : {}),
      });
      await this.deps.tasks.transition(task, TaskStatus.FAILED);
      this.deps.logger.error('work turn failed', { taskId: task.id, runId: run.id, kind: failure.kind });
      // Codex review P2 of 31dd36e9: the fixed error below is not a chat reply, so `quoky.lastReply` records a non-chat
      // turn (ending any closed-question fact) even though the turn was marked chat before the provider call.
      this.nlChatReplies.delete(message);
      const reply = this.deps.composer.composeError(message.context, failure.userMessage);
      return { status: 'FAILED', reply, sessionId: session.id, workFacts: workFacts(providerId) };
    }
  }

  /**
   * ADR-0111 amendment of 2026-10-08: mark a reply as a provider-generated answer (`format: 'model-reply'`, the opt-in
   * that lets a platform adapter adapt Markdown such as tables) ONLY for the provider's own, unaltered answer. The guard
   * OUTCOMES decide first (Codex review P3): a reply the attachment credential check withheld, or that the internal-action
   * claim guard replaced, is never flagged — even when the provider's text happens to equal the fixed notice. Only then
   * must the final composed text equal the provider's text (no composer fallback or other change).
   */
  protected asModelReply(
    reply: OutboundMessage,
    providerText: string,
    outcome: { readonly withheld: boolean; readonly guarded: boolean },
  ): OutboundMessage {
    if (outcome.withheld || outcome.guarded) return reply;
    const text = providerText.trim();
    return text !== '' && reply.text === text ? { ...reply, format: 'model-reply' } : reply;
  }

  /**
   * ADR-0104 D1 (DET-1): the provider-neutral internal-action claim guard on a GENERAL_CHAT / POLICY_SENSITIVE_CHAT
   * reply. A reply claiming a Quoky-domain action (commit, push, PR, merge, branch, file change, to-do, reminder,
   * memory, connector write) or asserting such a state is replaced as a whole by the fixed not-done notice. Other
   * capabilities (analysis over a real readout, summarization, code generation) are returned unchanged. The log line is
   * content-free (domain only).
   */
  protected guardChatReply(
    capability: Capability,
    text: string,
    currentUserMessage: string,
    taskId?: Id,
    nlFacts?: NlChatFacts,
    controls?: NlControlScope,
  ): { readonly text: string; readonly guarded: boolean } {
    if (capability !== Capability.GENERAL_CHAT && capability !== Capability.POLICY_SENSITIVE_CHAT && capability !== Capability.IMAGE_UNDERSTANDING) {
      return this.guardChatReplyClaims(capability, text, currentUserMessage, taskId, nlFacts, controls);
    }
    // Owner decision of 2026-10-28 (B1, amends the D2 copy rule): in the chat model's own text, a quoted or code span keeps
    // its marks only when it is a command the owner can send: the grammar path claims it, or it names an offered source
    // and ends in a request form. It runs before the claim guards, so Core's own copy (a notice, a usage line) is never
    // touched.
    const entries = nlFacts?.entries ?? [];
    const unquoted = nlUnquoteNonCommands(text, (span) => this.nlGrammarRuns(span) || nlSpanRequestsOfferedSource(span, entries));
    if (unquoted.unquoted > 0) this.deps.logger.info('chat quote marks removed', { capability, spans: unquoted.unquoted, ...(taskId ? { taskId } : {}) });
    const claims = this.guardChatReplyClaims(capability, unquoted.text, currentUserMessage, taskId, nlFacts, controls);
    return unquoted.unquoted > 0 ? { text: claims.text, guarded: true } : claims;
  }

  /**
   * Owner decision of 2026-10-28 (B1): whether Core's grammar path answers `span` sent alone in a DM, without a model:
   * the intent classifier gives it a non-chat intent, it is a control phrase (conversation or action switch), or a turn
   * handler's pure claim (`surfaceClaim`, the same parser `handle` uses) claims it. Synchronous, pure, never throws.
   */
  protected nlGrammarRuns(span: string): boolean {
    if (parseActionSwitchPhrase(span) !== undefined || detectConversationControl(span) !== null) return true;
    if (IntentClassifier.textIntent(span).type !== IntentType.CHAT) return true;
    const now = this.clock();
    const message: InboundMessage = { id: 'quote-check', text: span, context: { platform: 'quote-check', channelId: 'quote-check', userId: 'quote-check', direct: true }, receivedAt: now };
    return this.turnHandlerRegistry.some((handler) => {
      if (typeof handler.surfaceClaim !== 'function') return false;
      try {
        return handler.surfaceClaim({ message, now }) !== null;
      } catch {
        return false;
      }
    });
  }

  protected guardChatReplyClaims(
    capability: Capability,
    text: string,
    currentUserMessage: string,
    taskId?: Id,
    nlFacts?: NlChatFacts,
    controls?: NlControlScope,
  ): { readonly text: string; readonly guarded: boolean } {
    if (
      capability !== Capability.GENERAL_CHAT &&
      capability !== Capability.POLICY_SENSITIVE_CHAT &&
      capability !== Capability.IMAGE_UNDERSTANDING
    ) {
      return { text, guarded: false };
    }
    const guarded = guardInternalActionClaims(text, currentUserMessage, generalChatReplyPolicy(currentUserMessage));
    if (!guarded.guarded) {
      // ADR-0120 D9: after a `none` selection, a false "cannot access <configured source>" is replaced by its command.
      // Live DM test 2026-10-20 (Codex P2): a denied control command is replaced whenever the switch is recognized.
      if (nlFacts === undefined) {
        if (controls === undefined) return { text, guarded: false };
        const control = guardFalseControlDenials(text, languageOf(currentUserMessage));
        if (!control.guarded) return { text, guarded: false };
        this.deps.logger.info('false incapability claim replaced', { capability, ...(taskId ? { taskId } : {}) });
        return { text: control.text, guarded: true };
      }
      // #280 follow-up: right after a listing, a denial of that listing or a re-run of it is dropped first (from Core's
      // record of what was shown, not from the reply's words); the D9 guard then judges what is left.
      const language = languageOf(currentUserMessage);
      const listing = nlFacts.listing === undefined ? { text, guarded: false } : guardShownListingDenials(text, nlFacts.listing.shown, nlFacts.entries, language, nlFacts.listing.rerunsListing);
      if (listing.guarded) this.deps.logger.info('shown listing denial removed', { capability, entryId: nlFacts.listing?.shown.entry.id, ...(taskId ? { taskId } : {}) });
      // Owner decision of 2026-10-28 (B2): the held listing's values (turn-bound) make a denial naming them false too.
      const incapable = guardFalseIncapabilityClaims(listing.text, nlFacts.entries, language, this.contributedHelpLines, {
        ...(controls !== undefined ? { controls } : {}),
        ...(nlFacts.listing !== undefined ? { held: nlFacts.listing.shown } : {}),
      });
      if (!incapable.guarded) return listing;
      this.deps.logger.info('false incapability claim replaced', { capability, ...(taskId ? { taskId } : {}) });
      return { text: incapable.text, guarded: true };
    }
    this.deps.logger.info('internal action claim replaced', {
      capability,
      domain: guarded.domain,
      ...(taskId ? { taskId } : {}),
    });
    return { text: guarded.text, guarded: true };
  }

  /**
   * ADR-0111 D3: on a turn whose prompt carried attachment text — and (amendment A3) on every image turn — the
   * provider's ORIGINAL reply and every artifact payload are checked by the credential guard before any other reply
   * guard runs. A match withholds the whole reply:
   * a fixed notice and no artifacts, before anything is persisted or delivered. `null` lets the reply through to the
   * usual guards. Turns without attachment text are not checked here: a general check would withhold ordinary help
   * answers (`password: <your password>` examples, 16-digit numbers) and is not part of ADR-0097's scope.
   */
  protected withheldAttachmentReply(
    bundle: ContextBundle,
    message: InboundMessage,
    text: string,
    artifacts: readonly Artifact[],
    taskId: Id,
    turn: { readonly imageTurn?: boolean } = {},
  ): { text: string; artifacts: Artifact[] } | null {
    if (turn.imageTurn !== true && (bundle.currentAttachments?.textFiles.length ?? 0) === 0) return null;
    if (!isAttachmentReplyWithheld(text, artifacts)) return null;
    // Content-free.
    this.deps.logger.info('attachment turn reply withheld', { taskId });
    return { text: renderAttachmentReplyWithheld(noticeLanguage(undefined, message.text)), artifacts: [] };
  }

  /**
   * ADR-0104 D1 amendment (owner, 2026-10-15): the claim check of a document summary with at most one regeneration.
   * A credential-shaped first draft is not regenerated (the credential check withholds it). A flagged first draft is
   * regenerated once with the stricter attribution rule; the second draft is final: shown when clean, replaced by the
   * fixed notice otherwise. `guard` is the replacement (`null` when the draft is shown). Content-free counters only.
   */
  protected async documentSummaryWithOneRegeneration(
    first: AiExecutionResult,
    message: InboundMessage,
    task: Task,
    source: UntrustedDocumentSource,
    regenerate: () => Promise<AiExecutionResult>,
  ): Promise<{ readonly executed: AiExecutionResult; readonly guard: { readonly text: string; readonly guarded: boolean } | null }> {
    const language = noticeLanguage(undefined, message.text);
    const replyPolicy = generalChatReplyPolicy(task.description);
    const check = (text: string) => checkDocumentSummaryClaims(text, task.description, source, language, replyPolicy);
    let executed = first;
    let verdict = check(first.text);
    this.deps.logger.info('document summary claim check', { taskId: task.id, attempt: 1, outcome: verdict.kind });
    if (verdict.kind === 'claim' && !documentSummaryCredentialShaped(first.text, first.artifacts ?? [])) {
      let second: AiExecutionResult;
      try {
        second = await regenerate();
      } catch (err) {
        // The first call's usage is kept; with no second draft the flagged first one is replaced (fail closed).
        this.deps.logger.warn('document summary claim check', {
          taskId: task.id,
          attempt: 2,
          outcome: 'regeneration-failed',
          errorName: err instanceof Error ? err.name : typeof err,
        });
        return { executed: first, guard: { text: verdict.notice, guarded: true } };
      }
      const usage = combinedUsage(first.usage, second.usage);
      executed = { ...second, ...(usage ? { usage } : {}) };
      verdict = check(second.text);
      this.deps.logger.info('document summary claim check', { taskId: task.id, attempt: 2, outcome: verdict.kind });
    }
    if (verdict.kind === 'clean') return { executed, guard: null };
    return {
      executed,
      guard: { text: verdict.kind === 'too-long' ? renderDocumentSummaryTooLong(language) : verdict.notice, guarded: true },
    };
  }

  /**
   * ADR-0118 D7: the credential check on a document summary's ORIGINAL reply and every artifact (the item passed the
   * guard, so a match is model-made). A match withholds the whole reply with a fixed notice, before anything is
   * persisted or delivered.
   */
  protected withheldDocumentSummaryReply(
    message: InboundMessage,
    text: string,
    artifacts: readonly Artifact[],
    taskId: Id,
  ): { text: string; artifacts: Artifact[] } | null {
    // Final sign-off W-1: the credential check also runs on the normalized text the owner would be shown.
    if (!documentSummaryCredentialShaped(text, artifacts)) return null;
    this.deps.logger.info('document summary reply withheld', { taskId });
    return { text: renderUntrustedDocumentReplyWithheld(noticeLanguage(undefined, message.text)), artifacts: [] };
  }
}
