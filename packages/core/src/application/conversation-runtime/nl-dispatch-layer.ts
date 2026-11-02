import { isDirectConversation, messageBody, outboundBody, outboundMessage, withOutboundBody } from '../message-rendering';
import { isNlActionEntryId, type NlCatalogEntry, type NlClassBProbe } from '../nl-routing/catalog';
import { type ShownListing } from '../nl-routing/honest-chat';
import { type NlSelectionDecision, type NlSelectionRoute, type NlSelectionService } from '../nl-routing/nl-selection-service';
import { readLastSelection } from '../nl-routing/selection-state';
import { renderActionStopped, renderActionUnavailable, renderExternalUndoUnavailable } from '../nl-routing/nl-action-policy';
import { isActionPendingQuestion, type PendingQuestion } from '../nl-routing/selection-state';
import { renderNlActionDmOnly } from '../surface-grants/surface-grant-copy';
import { Capability } from '../../domain';
import type { Actor, Id, InboundMessage, Intent, Session } from '../../domain';
import {
  executionLocalityOf,
  type AiExecutionLocality,
  type ConversationTurnHandler,
  type TurnHandlerContext,
  type TurnHandlerOutcome,
  type TurnHandlerReply,
} from '../../ports';
import { mergeItemSummarizeEntries } from '../nl-routing/action-entries';
import { nlActionReceiptSource, nlHeldItemWordsFor } from './helpers';
import type { NlChatFacts, NlEarlySelection } from './internal-types';
import { externalUndoDraftKindOf } from '../connector-writes/external-undo-resolver';
import type { TurnHandlerWriteDraft } from '../../ports/conversation-turn-handler.port';
import { ConversationRuntimeTurnHandlerLayer } from './turn-handler-layer';
import type { ApplyPreviewAnchor, TurnResult } from './types';

export abstract class ConversationRuntimeNlDispatchLayer extends ConversationRuntimeTurnHandlerLayer {
  /**
   * A6 R5a §3.2/§3.3: the owner's answer to a pending deictic draft. An approval runs the existing handler path INSIDE the
   * service's session lock (the handler writes no session row); its receipt (lastAction, echo, undo hint) is recorded
   * after the lock is released, like any A6 dispatch. A deny or a stale answer gets a fixed reply; anything else drops the
   * draft and the turn routes normally. `undefined` continues the turn.
   */
  protected async handleDeicticDraft(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    applyAnchor: ApplyPreviewAnchor | null,
    userMemoryId: Id,
    actionQuestionOpen: boolean,
  ): Promise<TurnResult | undefined> {
    const nl = this.deps.nlSelection;
    if (nl?.answerDeicticDraft === undefined || !isDirectConversation(message.context)) return undefined;
    let answered: Awaited<ReturnType<NlSelectionService['answerDeicticDraft']>>;
    try {
      answered = await nl.answerDeicticDraft(
        {
          text: message.text,
          session,
          actor,
          now: this.clock(),
          ...(message.quotedRanges !== undefined ? { quotedRanges: message.quotedRanges } : {}),
          ...(message.formatting?.code === true ? { codeFormatted: true } : {}),
          ...(message.replyTo?.messageId !== undefined ? { replyToMessageId: message.replyTo.messageId } : {}),
          turnId: message.id,
          direct: true,
        },
        async (command): Promise<TurnHandlerOutcome | null> => {
          // Every write the handler makes carries the kill switch as a condition its store checks with the write.
          const ctx = this.turnHandlerContext(message, session, actor, applyAnchor, { actionSwitchOf: actor.id });
          for (const handler of this.nlActionServers(command.entryId)) {
            const outcome = (await handler.handleSelected?.(command, ctx)) ?? null;
            if (outcome !== null) return outcome;
          }
          return null;
        },
        { actionQuestionOpen },
      );
    } catch (err) {
      this.deps.logger.warn('nl deictic draft failed', { errorName: err instanceof Error ? err.name : typeof err, sessionId: session.id });
      return undefined;
    }
    if (answered === undefined) return undefined;
    if (answered.kind === 'dropped') {
      if (answered.prefix !== undefined) this.nlDeicticPrefix.set(message, answered.prefix);
      return undefined;
    }
    this.nlTurns.set(message, { sessionId: session.id, keep: false });
    if (answered.kind === 'reply') return this.respondNlAsk(message, session, answered);
    const outcome = answered.value as TurnHandlerOutcome | null;
    if (outcome === null) {
      this.deps.nlSelection?.logActionUnserved?.(answered.audit, 'unserved', message.id);
      return this.respondComposed(message, session, outboundMessage(message.context, renderActionUnavailable(answered.command.language)));
    }
    this.nlActionTurns.set(message, { audit: answered.audit, language: answered.command.language });
    return this.respondTurnHandler(message, session, actor, userMemoryId, outcome);
  }

  /**
   * S1 `c-shadow`: queue the grammar-hit selection for after the reply. The inputs are this turn's snapshot (the owner's
   * text, the session's metadata as the turn saw it, the offered entries); the chat provider is resolved in the
   * background, so nothing here delays the reply.
   */
  protected queueGrammarHitShadow(message: InboundMessage, session: Session, actor: Actor, grammar: NlClassBProbe): void {
    const now = this.clock();
    const entries = [...this.nlCatalog().values()].map((owned) => owned.entry);
    this.nlAfterReply.set(message, async () => {
      // The chat provider is resolved inside the service's bounded, abortable job (W1/W2).
      await this.deps.nlSelection?.shadowGrammarHit?.({
        text: message.text,
        attachmentCount: message.attachments?.length ?? 0,
        ...(message.quotedRanges !== undefined ? { quotedRanges: message.quotedRanges } : {}),
        session: { id: session.id, ...(session.metadata !== undefined ? { metadata: session.metadata } : {}) },
        actor,
        now,
        entries,
        route: 'class-b',
        grammar,
        pending: null,
      }, () => this.nlChatProvider({ capability: Capability.GENERAL_CHAT } as Intent, session, actor));
    });
  }

  /**
   * ADR-0121 S2 `shadow`: queue the planner job for an owner DM turn whose selection decided (`execute`, `ask` or `none`).
   * The kill switch is checked here on the turn's actor snapshot and again when the job starts. The inputs are this turn's
   * snapshot: the owner's text, the offered entries, the previous selection as structure only and the live decision's
   * closed values (for the one-step agreement); the chat provider this turn resolved bounds the planner's egress.
   * Only FRESH read selections are shadowed (CA review): a turn that answered an open question (`nlPending`) and an A6
   * action decision (an action entry executed or asked about) are skipped, so the agreement compares like with like.
   */
  protected queueAgentShadow(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    entries: readonly NlCatalogEntry[],
    decision: NlSelectionDecision,
    chat: { readonly id: string; readonly locality: AiExecutionLocality } | undefined,
    route: NlSelectionRoute,
    nlPending: PendingQuestion | null | undefined,
  ): void {
    const agent = this.deps.agentRuns;
    if (agent === undefined || (decision.kind !== 'execute' && decision.kind !== 'ask' && decision.kind !== 'none')) return;
    if (nlPending !== undefined && nlPending !== null) return;
    if (decision.kind === 'execute' && (decision.action !== undefined || isNlActionEntryId(decision.command.entryId))) return;
    if (decision.kind === 'ask' && decision.entryId !== undefined && isNlActionEntryId(decision.entryId)) return;
    const direct = isDirectConversation(message.context);
    if (!agent.shadowAdmits(actor, direct)) return;
    const now = this.clock();
    const last = readLastSelection(session, actor.id, now);
    const live =
      decision.kind === 'execute'
        ? { kind: 'execute' as const, source: route, entryId: decision.command.entryId, args: decision.command.args }
        : { kind: decision.kind, source: route };
    this.agentAfterReply.set(message, () =>
      agent.runShadow(
        {
          text: message.text,
          attachmentCount: message.attachments?.length ?? 0,
          ...(message.quotedRanges !== undefined ? { quotedRanges: message.quotedRanges } : {}),
          actor,
          now,
          entries,
          ...(last !== undefined ? { previous: { entryId: last.entryId, args: last.args } } : {}),
          direct,
          live,
        },
        async () => chat,
      ),
    );
  }

  /**
   * ADR-0121 S2 `shadow`, grammar coverage (live DM test 2026-10-20: "오늘 일정 보여줘" was answered by the calendar grammar
   * under `c-shadow`, never reached selection, and so was never planned): queue the planner job for an owner DM turn a
   * frozen Class B grammar answered. A Class B probe is a READ by construction (a write request, an approval, a control
   * phrase or a denied claim has no probe), and a turn that answers an open selection question (`nlPending`) is skipped,
   * as on the selection path. The same job, caps, kill-switch checks and bounds as {@link queueAgentShadow}; the live
   * decision is the grammar's own catalog equivalent (`liveSource: grammar`), so the one-step agreement compares the plan
   * with it where the grammar maps to a catalog entry. The chat provider is resolved inside the bounded job.
   */
  protected queueAgentGrammarShadow(message: InboundMessage, session: Session, actor: Actor, grammar: NlClassBProbe, nlPending: PendingQuestion | null | undefined): void {
    const agent = this.deps.agentRuns;
    if (agent === undefined || (nlPending !== undefined && nlPending !== null)) return;
    const direct = isDirectConversation(message.context);
    if (!agent.shadowAdmits(actor, direct)) return;
    const now = this.clock();
    const entries = [...this.nlCatalog(actor).values()].map((owned) => owned.entry);
    const last = readLastSelection(session, actor.id, now);
    const selection = grammar.selection;
    const live = { kind: 'execute' as const, source: 'grammar' as const, ...(selection !== undefined ? { entryId: selection.entryId, args: selection.args } : {}) };
    this.agentAfterReply.set(message, () =>
      agent.runShadow(
        {
          text: message.text,
          attachmentCount: message.attachments?.length ?? 0,
          ...(message.quotedRanges !== undefined ? { quotedRanges: message.quotedRanges } : {}),
          actor,
          now,
          entries,
          ...(last !== undefined ? { previous: { entryId: last.entryId, args: last.args } } : {}),
          direct,
          live,
        },
        () => this.nlChatProvider({ capability: Capability.GENERAL_CHAT } as Intent, session, actor),
      ),
    );
  }

  /** ADR-0121 S2: start the queued agent job on the next macrotask, after `handle` has resolved; never throws. */
  protected startAgentAfterReply(message: InboundMessage): void {
    const run = this.agentAfterReply.get(message);
    if (run === undefined) return;
    this.agentAfterReply.delete(message);
    this.lastAgentAfterReplyRun = new Promise<void>((resolve) => {
      setImmediate(() => {
        run()
          .catch((error: unknown) => {
            try {
              this.deps.logger.warn('agent shadow after-reply failed', { errorName: error instanceof Error ? error.name : typeof error });
            } catch {
              // best-effort
            }
          })
          .finally(resolve);
      });
    });
  }

  /** Start the queued after-reply work on the next macrotask, after `handle` has resolved; never throws. */
  protected startAfterReply(message: InboundMessage): void {
    this.startAgentAfterReply(message);
    const run = this.nlAfterReply.get(message);
    if (run === undefined) return;
    this.nlAfterReply.delete(message);
    this.lastAfterReplyRun = new Promise<void>((resolve) => {
      setImmediate(() => {
        run()
          .catch((error: unknown) => {
            try {
              this.deps.logger.warn('nl selection after-reply failed', { errorName: error instanceof Error ? error.name : typeof error });
            } catch {
              // best-effort
            }
          })
          .finally(resolve);
      });
    });
  }

  /** ADR-0120 amendment A2: selection would run for this turn (the selector is where this turn's chat would go). */
  protected async nlYieldsToSelection(session: Session, actor: Actor): Promise<boolean> {
    const chat = await this.nlChatProvider({ capability: Capability.GENERAL_CHAT } as Intent, session, actor);
    return (await this.deps.nlSelection?.yieldsToSelection?.(chat?.id, chat?.locality)) === true;
  }

  /**
   * ADR-0120 D6 Phase C (S1): the `pre-classify` stage with selection first at a Class B position. Handlers run in their
   * registry order; before each one's `handle`, its pure `classBProbe` is asked (only while no selection has run this
   * turn). A hit whose catalog entry is offered runs selection:
   *  - an executed read or a question answers the turn;
   *  - `none` ends the stage: the turn continues to the classifier and chat (D9 honest chat), exactly as a Phase A `none`;
   *  - unavailable or skipped (provider down, timeout, family or locality mismatch, credential, too long): the grammar's
   *    own `handle` runs as the fallback and the stage continues as in Phase A.
   * A Class A answer (a probe `null`) is never preceded by selection. The selection runs at most once per message.
   */
  protected async dispatchPreClassifyPhaseC(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    applyAnchor: ApplyPreviewAnchor | null,
    userMemoryId: Id,
    nlPending: PendingQuestion | null | undefined,
  ): Promise<{ readonly kind: 'responded'; readonly result: TurnResult } | { readonly kind: 'continue'; readonly early?: NlEarlySelection }> {
    const handlers = this.turnHandlersByStage['pre-classify'];
    if (handlers.length === 0) return { kind: 'continue' };
    const ctx = this.turnHandlerContext(message, session, actor, applyAnchor);
    let early: NlEarlySelection | undefined;
    for (const handler of handlers) {
      // ADR-0122: a grammar whose claim is denied here answers with the denial before any selector call on this text.
      const deniedClaim = this.deniedReplyClaim(handler, ctx);
      if (deniedClaim !== undefined) {
        return { kind: 'responded', result: await this.respondTurnHandler(message, session, actor, userMemoryId, deniedClaim) };
      }
      if (early === undefined) {
        const probe = this.nlClassBProbe(handler, ctx);
        if (probe !== null) {
          let selected: Awaited<ReturnType<ConversationRuntimeNlDispatchLayer['handleNlSelection']>>;
          try {
            selected = await this.handleNlSelection(
              message,
              session,
              actor,
              applyAnchor,
              userMemoryId,
              'class-b',
              { capability: Capability.GENERAL_CHAT } as Intent,
              nlPending,
              probe,
            );
          } catch (err) {
            // Like (C2): a selected read is read-only, so a failure renders the confirmed-not-applied wording.
            return { kind: 'responded', result: await this.failReadOnlyTurn(message, session, err) };
          }
          if (selected.kind === 'responded') return selected;
          early = { ...(selected.facts !== undefined ? { facts: selected.facts } : {}), ...(selected.declined === true ? { declined: true as const } : {}) };
          if (!selected.fallback) return { kind: 'continue', early };
        }
      }
      const handled = await this.runGatedHandler(handler, ctx);
      if (handled) {
        this.deps.logger.info('turn handler responded', {
          handlerId: handler.id,
          stage: 'pre-classify',
          sessionId: ctx.session.id,
          status: handled.kind === 'summarize' ? 'SUMMARIZE' : handled.kind === 'write-draft' ? 'WRITE_DRAFT' : handled.status ?? 'RESPONDED',
        });
        return { kind: 'responded', result: await this.respondTurnHandler(message, session, actor, userMemoryId, handled) };
      }
    }
    return { kind: 'continue', ...(early !== undefined ? { early } : {}) };
  }

  /**
   * #280 follow-up: the offered READ listing Core still holds as `lastSelection` (right after the listing, and, since owner
   * decision D1, across chat turns within its 30 minutes; any other turn clears it), with a predicate telling whether a
   * quoted command maps to exactly that listing (same entry and canonical args) through the handlers' own pure Class B
   * probes. The guard drops only denials that refer to this listing (CA review P1-1), so a held record never deletes an
   * unrelated true limitation. No read, no write, no provider.
   */
  protected nlShownListing(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    catalog: ReadonlyMap<string, { readonly entry: NlCatalogEntry }>,
  ): { readonly shown: ShownListing; readonly rerunsListing: (segment: string) => boolean } | undefined {
    const now = this.clock();
    const last = readLastSelection(session, actor.id, now);
    const entry = last === undefined ? undefined : catalog.get(last.entryId)?.entry;
    if (last === undefined || entry === undefined || entry.risk !== 'READ') return undefined;
    const canonical = (args: Readonly<Record<string, unknown>>): string => JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
    const shownArgs = canonical(last.args);
    const rerunsListing = (segment: string): boolean =>
      this.turnHandlerRegistry.some((handler) => {
        if (typeof handler.classBProbe !== 'function') return false;
        try {
          const probe = handler.classBProbe({ message: { ...message, id: `${message.id}:listing-probe`, text: segment }, now });
          return probe?.selection !== undefined && probe.selection.entryId === entry.id && canonical(probe.selection.args) === shownArgs;
        } catch {
          return false;
        }
      });
    // The item words Core held for this listing: only when they were taken at or after the listing was recorded.
    // Codex review of 7f7e8d32: only the words taken from the very turn that recorded this listing attach (turn id match).
    const held = this.nlShownItems.get(`${session.id}|${actor.id}`);
    const itemWords = nlHeldItemWordsFor(held, last);
    // Owner decision of 2026-10-28 (B2): the shown titles, bound to the same listing record (turn id match).
    const itemTitles = held === undefined ? undefined : nlHeldItemWordsFor({ turnId: held.turnId, words: held.titles }, last);
    return {
      shown: {
        entry,
        args: last.args,
        ...(itemWords !== undefined && itemWords.length > 0 ? { itemWords } : {}),
        ...(itemTitles !== undefined && itemTitles.length > 0 ? { itemTitles } : {}),
      },
      rerunsListing,
    };
  }

  /** A handler's Class B probe, only when its catalog equivalent (if any) is offered this turn; never throws. */
  protected nlClassBProbe(handler: ConversationTurnHandler, ctx: TurnHandlerContext): NlClassBProbe | null {
    if (typeof handler.classBProbe !== 'function') return null;
    let probe: NlClassBProbe | null;
    try {
      probe = handler.classBProbe(ctx);
    } catch {
      return null;
    }
    if (probe === null || typeof probe !== 'object') return null;
    // A grammar answer the catalog cannot offer now (an unconfigured source's "not configured" reply) keeps its grammar.
    if (probe.selection !== undefined && !this.nlCatalog().has(probe.selection.entryId)) return null;
    return probe;
  }

  /**
   * ADR-0120 D6/D8: the id of the provider this chat turn would reach — the same resolution the chat path makes (the
   * turn's capability with the session's selection context). `undefined` when it cannot be known (the routed Stage 2A
   * seam decides GENERAL_CHAT itself, or nothing resolves); selection is then skipped. Read as opaque data.
   */
  protected async nlChatProvider(intent: Intent, session: Session, actor: Actor): Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined> {
    if (intent.capability === Capability.GENERAL_CHAT && this.deps.runtimeProviderRouting) return undefined;
    try {
      const context = { sessionId: session.id, actorId: actor.id };
      const provider = this.deps.router.resolve
        ? (await this.deps.router.resolve(intent.capability, context)).provider
        : await this.deps.router.select(intent.capability, context);
      // The provider family, so a model variant (`claude-cli:opus`) still counts as its base provider for egress, plus its
      // declared locality (S1: an equal family must also have an equal locality).
      return { id: provider.family ?? provider.id, locality: executionLocalityOf(provider) };
    } catch {
      return undefined;
    }
  }

  /**
   * The catalog entries the registered handlers contribute right now, each with its owning handler (first wins). An A6
   * action entry is included only for `actor` while the selection service offers actions (QUOKY_NL_ACTIONS not `off`,
   * kill switch running); otherwise the map is exactly the READ catalog it was before A6.
   */
  protected nlCatalog(actor?: Actor): Map<string, { readonly entry: NlCatalogEntry; readonly handler: ConversationTurnHandler }> {
    const owned = new Map<string, { readonly entry: NlCatalogEntry; readonly handler: ConversationTurnHandler }>();
    const actions = actor !== undefined && this.deps.nlSelection?.actionsOffered?.(actor) === true;
    const summarize: NlCatalogEntry[] = [];
    for (const handler of this.turnHandlerRegistry) {
      if (typeof handler.handleSelected !== 'function') continue;
      let entries: readonly NlCatalogEntry[];
      try {
        entries = handler.catalog ?? [];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.risk !== 'READ' && !actions) continue;
        if (entry.id === 'item.summarize') summarize.push(entry);
        if (!owned.has(entry.id)) owned.set(entry.id, { entry, handler });
      }
    }
    // A6 R2: several handlers contribute `item.summarize` (mail, Drive, the work-chat lookup for Jira / Slack): the
    // selector sees ONE entry whose `source` enum is their union (the R1 entry itself while no R2 source is offered).
    const first = owned.get('item.summarize');
    if (first !== undefined && summarize.length > 1) owned.set('item.summarize', { ...first, entry: mergeItemSummarizeEntries(summarize) });
    return owned;
  }

  /**
   * The help topic of every catalog entry the registered handlers declare, by the same per-handler topics the help-scope
   * question's Quoky option uses (read-only diagnostics; the agent-plan scorer's table is pinned against it by test, owner
   * decision of 2026-10-26).
   */
  entryHelpTopics(): Readonly<Record<string, string>> {
    const topics: Record<string, string> = {};
    for (const handler of this.turnHandlerRegistry) {
      const topic = this.handlerHelpTopics.get(handler);
      if (topic === undefined) continue;
      try {
        for (const entry of handler.catalog ?? []) topics[entry.id] = topic;
      } catch {
        continue;
      }
    }
    return topics;
  }

  /**
   * Owner decision A follow-up (2026-10-22): per offered entry, the one help topic its owning handler's contributed help
   * lines answer (`helpTopicOfLines`, computed once per handler at construction), so the help-scope question's Quoky
   * option shows that source's help section.
   */
  protected nlEntryHelpTopics(catalog: ReadonlyMap<string, { readonly entry: NlCatalogEntry; readonly handler: ConversationTurnHandler }>): Record<string, string> {
    const topics: Record<string, string> = {};
    for (const [id, owned] of catalog) {
      const topic = this.handlerHelpTopics.get(owned.handler);
      if (topic !== undefined) topics[id] = topic;
    }
    return topics;
  }

  /** A6: every handler that declares action entry `entryId` (several serve `item.summarize` / `action.undo` by source). */
  protected nlActionServers(entryId: string): ConversationTurnHandler[] {
    const servers: ConversationTurnHandler[] = [];
    for (const handler of this.turnHandlerRegistry) {
      if (typeof handler.handleSelected !== 'function') continue;
      try {
        if ((handler.catalog ?? []).some((entry) => entry.id === entryId)) servers.push(handler);
      } catch {
        continue;
      }
    }
    return servers;
  }

  /**
   * ADR-0120 amendment A6: dispatch one A6 decision to the handler that serves its source (the first that answers), then
   * present it like that handler's own reply with the basis line first. `lastSelection` is never kept (A6-D3). A decision
   * no handler serves gets a fixed reply: an action request never falls to chat.
   */
  protected async dispatchNlAction(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    applyAnchor: ApplyPreviewAnchor | null,
    userMemoryId: Id,
    decision: Extract<NlSelectionDecision, { kind: 'execute' }>,
  ): Promise<TurnResult> {
    this.nlTurns.set(message, { sessionId: session.id, keep: false });
    // A6-D3: the kill switch is re-read from the persisted Actor as the last check before anything runs.
    if (this.deps.nlSelection?.actionsStillActing !== undefined && !(await this.deps.nlSelection.actionsStillActing(actor))) {
      if (decision.action !== undefined) this.deps.nlSelection.logActionUnserved?.(decision.action, 'stopped', message.id);
      return this.respondComposed(message, session, outboundMessage(message.context, renderActionStopped(decision.command.language)));
    }
    // ADR-0122 D2.2: every A6 entry is `nl-actions` (DM-only). In a channel the gate answers with the A6 copy and the same
    // content-free `refused / not-dm` receipt the handlers give (D2.7); no handler runs.
    const deniedAction = this.surfaceDenied(message.context, actor, this.surfaceGroupsOfSelected(decision.command, message), {
      path: 'selection',
      entryId: decision.command.entryId,
    });
    if (deniedAction) {
      if (decision.action !== undefined) this.nlActionTurns.set(message, { audit: decision.action, language: decision.command.language });
      const source = nlActionReceiptSource(decision.command);
      const refusal: TurnHandlerReply = {
        reply: outboundMessage(message.context, deniedAction.reason === 'dm-only' && deniedAction.group === 'nl-actions'
          ? renderNlActionDmOnly(decision.command.language)
          : this.surfaceDenialText(message.text, deniedAction)),
        ...(source !== undefined && isNlActionEntryId(decision.command.entryId)
          ? { nlAction: { entryId: decision.command.entryId, result: 'refused' as const, source, reason: 'not-dm' } }
          : {}),
      };
      return this.respondTurnHandler(message, session, actor, userMemoryId, refusal);
    }
    // ADR-0112 amendment 3 (O1): the undo of an approved external write is not a local handler's job. The receipt id of this
    // session's own `lastAction` becomes a connector-write draft; the flow resolves it again, previews it and asks for the
    // CRITICAL approval (nothing is written on this turn). While the writer is off, the fixed reply says so.
    if (decision.command.externalUndo !== undefined) {
      if (decision.action !== undefined) this.nlActionTurns.set(message, { audit: decision.action, language: decision.command.language });
      const draft: TurnHandlerWriteDraft = {
        kind: 'write-draft',
        draft: { kind: externalUndoDraftKindOf(decision.command.externalUndo.family), receiptId: decision.command.externalUndo.receiptId },
        fallbackText: renderExternalUndoUnavailable(decision.command.language),
      };
      const undoResult = await this.respondTurnHandler(message, session, actor, userMemoryId, draft);
      if (decision.basis === undefined) return undoResult;
      return { ...undoResult, reply: withOutboundBody(undoResult.reply, messageBody(decision.basis, '\n', outboundBody(undoResult.reply))) };
    }
    // Every write the handler makes carries the switch as a condition its store checks atomically with the write.
    const ctx = this.turnHandlerContext(message, session, actor, applyAnchor, { actionSwitchOf: actor.id });
    let outcome: TurnHandlerOutcome | null = null;
    let handlerId: string | undefined;
    for (const handler of this.nlActionServers(decision.command.entryId)) {
      outcome = (await handler.handleSelected?.(decision.command, ctx)) ?? null;
      if (outcome !== null) {
        handlerId = handler.id;
        break;
      }
    }
    if (outcome === null) {
      if (decision.action !== undefined) this.deps.nlSelection?.logActionUnserved?.(decision.action, 'unserved', message.id);
      return this.respondComposed(message, session, outboundMessage(message.context, renderActionUnavailable(decision.command.language)));
    }
    if (decision.action !== undefined) this.nlActionTurns.set(message, { audit: decision.action, language: decision.command.language });
    this.deps.logger.info('nl action dispatched', { handlerId, entryId: decision.command.entryId, sessionId: session.id });
    const result = await this.respondTurnHandler(message, session, actor, userMemoryId, outcome);
    if (decision.basis === undefined) return result;
    return { ...result, reply: withOutboundBody(result.reply, messageBody(decision.basis, '\n', outboundBody(result.reply))) };
  }

  /** A6: the early answer to an open A6 question, or the anchored `되돌리기`; `undefined` continues the turn. */
  protected async handleEarlyNlAction(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    applyAnchor: ApplyPreviewAnchor | null,
    userMemoryId: Id,
    nlPending: PendingQuestion | null | undefined,
  ): Promise<TurnResult | undefined> {
    const nl = this.deps.nlSelection;
    if (nl === undefined) return undefined;
    const entries = [...this.nlCatalog(actor).values()].map((owned) => owned.entry);
    const base = {
      text: message.text,
      attachmentCount: message.attachments?.length ?? 0,
      ...(message.quotedRanges !== undefined ? { quotedRanges: message.quotedRanges } : {}),
      session,
      actor,
      now: this.clock(),
      entries,
      route: 'chat' as const,
      ...(message.replyTo?.messageId !== undefined ? { replyToMessageId: message.replyTo.messageId } : {}),
      turnId: message.id,
      ...(message.formatting?.code === true ? { codeFormatted: true } : {}),
      direct: isDirectConversation(message.context),
      ...(this.surfaceGate()?.enforced === true ? { surfaceEnforced: true } : {}),
    };
    let decision: NlSelectionDecision | undefined;
    try {
      if (isActionPendingQuestion(nlPending) && nl.answerActionPending !== undefined) decision = await nl.answerActionPending({ ...base, pending: nlPending });
      if (decision === undefined && nl.decideAnchoredUndo !== undefined) decision = await nl.decideAnchoredUndo(base);
    } catch {
      decision = undefined;
    }
    if (decision === undefined) return undefined;
    if (decision.kind === 'ask') {
      // ADR-0122 D2.2: an A6 question lists the owner's items; in a channel it is the A6 DM-only copy instead.
      const deniedAsk = await this.surfaceDeniedAsk(message, session, actor, { ...decision, entryId: decision.entryId ?? 'action.undo' });
      if (deniedAsk) return deniedAsk;
      return this.respondNlAsk(message, session, decision);
    }
    if (decision.kind !== 'execute') return undefined;
    try {
      return await this.dispatchNlAction(message, session, actor, applyAnchor, userMemoryId, decision);
    } catch (err) {
      return this.failReadOnlyTurn(message, session, err);
    }
  }

  /**
   * ADR-0120 D6/D7/D9: ask the selection service for a decision and present it. An executable read goes to the owning
   * handler's `handleSelected` and is answered like that handler's own reply, with the basis line first; a question is
   * answered as is; `none` and an unavailable selector continue to honest chat with the configured-sources fact.
   */
  protected async handleNlSelection(
    message: InboundMessage,
    session: Session,
    actor: Actor,
    applyAnchor: ApplyPreviewAnchor | null,
    userMemoryId: Id,
    route: NlSelectionRoute,
    intent: Intent,
    nlPending?: PendingQuestion | null,
    grammar?: NlClassBProbe,
  ): Promise<
    | { readonly kind: 'responded'; readonly result: TurnResult }
    | { readonly kind: 'continue'; readonly facts?: NlChatFacts; readonly fallback?: true; readonly declined?: true }
  > {
    const nl = this.deps.nlSelection as Pick<NlSelectionService, 'mode' | 'decide'>;
    const catalog = this.nlCatalog(actor);
    const entries = [...catalog.values()].map((owned) => owned.entry);
    // #280 follow-up: the listing the previous turn showed, read before this turn's selection changes the record.
    const shownListing = this.nlShownListing(message, session, actor, catalog);
    const chat = await this.nlChatProvider(intent, session, actor);
    // Owner-approved fix of 2026-10-28: the titles Core showed in the held listing, only when bound to its very record.
    const heldListing = readLastSelection(session, actor.id, this.clock());
    const heldItems = heldListing === undefined ? undefined : this.nlShownItems.get(`${session.id}|${actor.id}`);
    const shownTitles = heldListing !== undefined && heldItems !== undefined && nlHeldItemWordsFor({ turnId: heldItems.turnId, words: heldItems.titles }, heldListing);
    const decision = await nl.decide({
      ...(shownTitles !== undefined && shownTitles !== false && shownTitles.length > 0 ? { shownItemTitles: shownTitles } : {}),
      ...(chat !== undefined ? { chatProviderId: chat.id, chatProviderLocality: chat.locality } : {}),
      entryHelpTopics: this.nlEntryHelpTopics(catalog),
      ...(nlPending !== undefined ? { pending: nlPending } : {}),
      ...(grammar !== undefined ? { grammar } : {}),
      ...(message.replyTo?.messageId !== undefined ? { replyToMessageId: message.replyTo.messageId } : {}),
      turnId: message.id,
      ...(message.formatting?.code === true ? { codeFormatted: true } : {}),
      direct: isDirectConversation(message.context),
      ...(this.surfaceGate()?.enforced === true ? { surfaceEnforced: true } : {}),
      text: message.text,
      attachmentCount: message.attachments?.length ?? 0,
      ...(message.quotedRanges !== undefined ? { quotedRanges: message.quotedRanges } : {}),
      session,
      actor,
      now: this.clock(),
      entries,
      route,
    });
    // ADR-0121 S2 shadow: a DM turn that reached selection queues one background planner job for after the reply.
    if (this.deps.agentRuns !== undefined && this.deps.agentRuns.mode === 'shadow') this.queueAgentShadow(message, session, actor, entries, decision, chat, route, nlPending);
    // A6-D6: the honest-chat fact names the action families only while they act (shadow keeps today's fact).
    const factEntries = this.deps.nlSelection?.actionsActing?.(actor) === true ? entries : entries.filter((entry) => entry.risk === 'READ');
    const honest = nl.mode === 'active' && factEntries.length > 0 ? { entries: factEntries, ...(shownListing !== undefined ? { listing: shownListing } : {}) } : undefined;
    switch (decision.kind) {
      case 'skip':
        // Phase C: the grammar is the fallback when selection did not run (shadow included: the grammar answers).
        return { kind: 'continue', ...(grammar !== undefined ? { fallback: true as const } : {}) };
      case 'none':
        return { kind: 'continue', ...(honest !== undefined ? { facts: honest } : {}), ...(nl.mode === 'active' ? { declined: true as const } : {}) };
      case 'unavailable':
        return { kind: 'continue', ...(honest !== undefined ? { facts: honest } : {}), ...(grammar !== undefined ? { fallback: true as const } : {}) };
      case 'ask': {
        // ADR-0122 D2.2: a question about one entry (usage, preference, an A6 target with the owner's item labels) is
        // gated like that entry; a denied A6 question also closes the pending question it saved.
        const deniedAsk = await this.surfaceDeniedAsk(message, session, actor, decision);
        if (deniedAsk) return { kind: 'responded', result: deniedAsk };
        this.deps.logger.info('nl selection asked', { sessionId: session.id });
        return { kind: 'responded', result: await this.respondNlAsk(message, session, decision) };
      }
      case 'execute': {
        // ADR-0120 amendment A6: an action (or ITEM_READ) decision goes to the handler that serves its source.
        if (isNlActionEntryId(decision.command.entryId)) {
          return { kind: 'responded', result: await this.dispatchNlAction(message, session, actor, applyAnchor, userMemoryId, decision) };
        }
        const owner = catalog.get(decision.command.entryId);
        const serve = owner?.handler.handleSelected;
        // Phase C: a selection no handler serves leaves the turn to the grammar that would have answered it.
        const unserved = { kind: 'continue' as const, ...(honest !== undefined ? { facts: honest } : {}), ...(grammar !== undefined ? { fallback: true as const } : {}) };
        if (owner === undefined || serve === undefined) return unserved;
        // The service already wrote this selection as `lastSelection`; it stays only when the handler shows the listing.
        this.nlTurns.set(message, { sessionId: session.id, keep: false });
        // ADR-0122 D2.2: the selected entry's group passes the gate before the owning handler reads anything.
        const deniedSelection = this.surfaceDenied(message.context, actor, this.surfaceGroupsOfSelected(decision.command, message), {
          path: 'selection',
          entryId: decision.command.entryId,
        });
        if (deniedSelection) return { kind: 'responded', result: await this.surfaceDeniedTurn(message, session, deniedSelection) };
        const outcome = await serve.call(owner.handler, decision.command, this.turnHandlerContext(message, session, actor, applyAnchor));
        if (outcome === null) return unserved;
        // A failed read shows no listing: a later "그 중에 …" must not refine it.
        if (outcome.kind !== 'summarize' && outcome.kind !== 'write-draft' && outcome.status === 'FAILED') {
          this.nlTurns.set(message, { sessionId: session.id, keep: false });
        } else {
          this.keepNlLastSelection(message, session);
        }
        this.deps.logger.info('nl selection dispatched', { handlerId: owner.handler.id, entryId: decision.command.entryId, sessionId: session.id });
        const result = await this.respondTurnHandler(message, session, actor, userMemoryId, outcome);
        if (decision.basis === undefined) return { kind: 'responded', result };
        return {
          kind: 'responded',
          result: { ...result, reply: withOutboundBody(result.reply, messageBody(decision.basis, '\n', outboundBody(result.reply))) },
        };
      }
    }
  }
}
