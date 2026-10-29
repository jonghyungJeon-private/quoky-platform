import type {
  ConversationTurnHandler,
  SurfaceClaim,
  TurnHandlerContext,
  TurnHandlerProbeContext,
  TurnHandlerOutcome,
  TurnHandlerSummarizeReply,
} from '../../ports/conversation-turn-handler.port';
import type { MessageBody } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import { containsCredentialMaterial } from '../credential-guard';
import { clipMessage, messageBody, outboundBody, outboundMessage, plainTextOf, withOutboundBody } from '../message-rendering';
import type { NlItemR2Level } from '../nl-routing/nl-selection-service';
import { isNlActionEntryId, type NlCatalogEntry, type NlClassBProbe, type NlSelectedCommand } from '../nl-routing/catalog';
import { nlActionEntry, nlItemSummarizeEntry } from '../nl-routing/action-entries';
import { isNlR2ItemSource, type NlActionReceipt } from '../nl-routing/catalog';
import { renderUntrustedDocumentFull, renderUntrustedDocumentHistoryNote } from '../untrusted-document-readout';
import {
  buildWorkItemReadout,
  renderWorkItemCredentialWithheld,
  renderWorkItemDmOnly,
  renderWorkItemEmpty,
  renderWorkItemFailure,
  renderWorkItemFallback,
  renderWorkItemFooter,
  renderWorkItemReplyNotIsolable,
  renderWorkItemSummaryOff,
  workItemBytesBucket,
  workItemDocumentSource,
  workItemFetchOutcome,
  workItemLabel,
  workItemNotes,
  workItemParticipants,
} from './work-item-summary';
import { nlWave1Entry } from '../nl-routing/wave1-entries';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { renderListStatusDmOnly } from '../nl-routing/nl-action-policy';
import { isDirectConversation } from '../message-rendering';
import { LAST_LISTING_METADATA_KEY, readListingRecord } from '../last-listing';
import { surfaceClaimOf, surfaceGroupsOfWorkChatCommand } from '../surface-grants/surface-group-map';
import { surfaceChannelHolds } from '../surface-grants/surface-permit';
import { WORK_CHAT_SOURCE_ENTRY, nlSelectionForWorkChatCommand, releaseCommandForSelection, renderWorkChatCount, workChatCommandForSelection } from './work-chat-selection';
import {
  EXTERNAL_WORK_EXCERPT_MAX_CHARS,
  EXTERNAL_WORK_FIELD_MAX_CHARS,
  EXTERNAL_WORK_FOOTER_MAX_CHARS,
  EXTERNAL_WORK_MAX_ITEMS,
  EXTERNAL_WORK_PROMPT_MAX_CHARS,
  EXTERNAL_WORK_READOUT_KIND,
  EXTERNAL_WORK_TITLE_MAX_CHARS,
  EXTERNAL_WORK_URL_MAX_CHARS,
  countExternalWorkPromptItems,
  renderExternalWorkReadoutForPrompt,
} from './external-work-readout';
import type { ExternalWorkReadout } from './external-work-readout';
import {
  WORK_CHAT_LOOKUP_QUERIES,
  WORK_CHAT_SOURCES,
  detectWorkChatCommand,
  workChatCommandMode,
} from './work-chat-command';
import type { WorkChatCommand, WorkChatMode } from './work-chat-command';
import {
  renderExternalWriteRefusal,
  renderLookupFailure,
  renderTodoFailure,
  renderTodoListFailure,
} from './work-chat-renderer';
import type { WorkChatOutcome, WorkDesk, WorkDeskHandleOptions } from './work-chat-service';

/**
 * Work chat as two ADR-0096 `pre-classify` turn handlers over WORK-T3's `WorkDesk` (ADR-0100 D2, WORK-T4).
 *
 * - `mode: 'mutation'` (order 100): anchored to-do add/complete/cancel/link — the closed ADR-0100 D1 prefix list —
 *   plus the numbered to-do forms and their usage hints. It runs before reminders (order 200), so
 *   `할 일 추가: 내일 9시에 회의 알려줘` adds a to-do and never a reminder.
 * - `mode: 'lookup'` (order 300): the combined "my work" list, read-only connector lookups and searches, the fixed
 *   connector-write refusal and the search usage hints.
 *
 * Both sit after every pending-approval / anchor intercept, the stray-decision reply and `기억해:` (registry
 * ordering, ADR-0096 D5), so a work phrase never pre-empts a pending decision. A handler never calls a provider: a
 * lookup the desk wants summarised comes back as the `summarize` outcome, and only the runtime decides whether a
 * SUMMARIZATION provider runs. Registration happens in the composition root (WORK-T5).
 */

export const WORK_CHAT_TODO_TURN_HANDLER_ID = 'work-chat.todo';
export const WORK_CHAT_TODO_TURN_HANDLER_ORDER = 100;
export const WORK_CHAT_LOOKUP_TURN_HANDLER_ID = 'work-chat.lookup';
export const WORK_CHAT_LOOKUP_TURN_HANDLER_ORDER = 300;

/**
 * Help lines (ADR-0096 D6; each well under the composer's 120-character bound). Every quoted example is a phrase the
 * grammar routes to that handler's mode (pinned by the handler test).
 */
export const WORK_CHAT_TODO_TURN_HELP_LINES: readonly string[] = Object.freeze([
  '- 할 일: "할 일 추가: 내용", "완료 처리: 번호", "할 일 취소: 번호", "할 일 연결: 번호 Jira KEY-1"',
]);
export const WORK_CHAT_LOOKUP_TURN_HELP_LINES: readonly string[] = Object.freeze([
  '- 업무 조회(읽기 전용): "내 할 일 보여줘", "내 Jira 이슈 보여줘", "GitHub 리뷰 요청 보여줘", "Slack에서 배포 검색"',
]);

/** The whole summary reply (model text + footer) stays inside one chat message. */
export const WORK_SUMMARY_REPLY_MAX_CHARS = 1900;

export interface WorkChatTurnHandlerDeps {
  readonly desk: Pick<WorkDesk, 'handle' | 'configuredSources'> & Partial<Pick<WorkDesk, 'handleAction' | 'readItem'>>;
  readonly mode: WorkChatMode;
  /**
   * `QUOKY_WORK_SUMMARY_ENABLED` (owner decision ADR-0100 #2). The desk already honours it; the handler re-checks it
   * so that, with summaries off, no `summarize` outcome can ever leave this handler (the deterministic list is the
   * reply and no provider is called).
   */
  readonly summaryEnabled: boolean;
  /**
   * ADR-0120 amendment A6 R2 (`QUOKY_NL_ITEM_R2`, default `off`): while not `off` the lookup handler offers
   * `item.summarize` over the configured Jira / Slack sources (the selection service decides per source whether it acts or
   * only logs) and answers a validated one through `desk.readItem`. `off`: nothing is offered or answered.
   */
  readonly itemR2?: NlItemR2Level;
  readonly logger: Logger;
}

export class WorkChatTurnHandler implements ConversationTurnHandler {
  readonly id: string;
  readonly stage = 'pre-classify' as const;
  readonly order: number;
  readonly helpLines: readonly string[];

  constructor(private readonly deps: WorkChatTurnHandlerDeps) {
    const mutation = deps.mode === 'mutation';
    this.id = mutation ? WORK_CHAT_TODO_TURN_HANDLER_ID : WORK_CHAT_LOOKUP_TURN_HANDLER_ID;
    this.order = mutation ? WORK_CHAT_TODO_TURN_HANDLER_ORDER : WORK_CHAT_LOOKUP_TURN_HANDLER_ORDER;
    this.helpLines = mutation ? WORK_CHAT_TODO_TURN_HELP_LINES : WORK_CHAT_LOOKUP_TURN_HELP_LINES;
  }

  /**
   * ADR-0120 D1: the lookup handler offers the entries of the configured work sources plus `todo.list`; the mutation
   * handler offers none (writes are never selected, D5). A getter, read on every selection turn.
   */
  get catalog(): readonly NlCatalogEntry[] {
    if (this.deps.mode !== 'lookup') {
      // ADR-0120 amendment A6: the to-do action entries (the runtime offers them only while QUOKY_NL_ACTIONS allows).
      return this.deps.desk.handleAction === undefined
        ? []
        : [nlActionEntry('todo.add'), nlActionEntry('todo.complete'), nlActionEntry('todo.cancel'), nlActionEntry('action.undo')];
    }
    const configured = this.deps.desk.configuredSources?.() ?? [];
    // ADR-0120 A8: a configured Jira source also offers its release listing, right after `jira.issues`.
    // A6 R2: `item.summarize` over the configured Jira / Slack sources, only while QUOKY_NL_ITEM_R2 is not `off`.
    const r2 = (this.deps.itemR2 ?? 'off') !== 'off' && this.deps.desk.readItem !== undefined ? configured.filter(isNlR2ItemSource) : [];
    return [
      ...configured.flatMap((source) => (source === 'jira' ? [nlWave1Entry('jira.issues'), nlWave1Entry('jira.release')] : [nlWave1Entry(WORK_CHAT_SOURCE_ENTRY[source])])),
      nlWave1Entry('todo.list'),
      ...(r2.length > 0 ? [nlItemSummarizeEntry(r2)] : []),
    ];
  }

  /**
   * A validated selection mapped to the existing typed lookup or to-do list command (ADR-0120 interfaces), answered like
   * `handle` answers it. A count question gets a count line first and then the first few items of the deterministic list
   * (at most `WORK_CHAT_COUNT_PREVIEW_ITEMS`; owner review 2026-10-21), never a summary.
   */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    if (this.deps.mode !== 'lookup') return this.handleAction(selected, ctx);
    if (selected.entryId === 'item.summarize') return this.summarizeItem(selected, ctx);
    // ADR-0120 A8: a release link is read from the owner's own non-quoted words only (quoted or fenced text is data).
    const prepared = selected.entryId === 'jira.release' ? prepareSelectionInput(ctx.message.text, 0, ctx.message.quotedRanges ?? []) : undefined;
    const groundingText = prepared === undefined || 'skip' in prepared ? '' : prepared.groundingText;
    // ADR-0120 A8 owner decision 7: a release listing knows whether it answers in a channel — every-assignee scope and the
    // lists stay DM-only there unless the gate is enforced and the channel holds `jira-project` (ADR-0122 P2).
    const mapped =
      selected.entryId === 'jira.release'
        ? releaseCommandForSelection(selected, groundingText, { inChannel: !surfaceChannelHolds(ctx.message.context, ctx.surfacePermit, 'jira-project') })
        : workChatCommandForSelection(selected, groundingText);
    if (mapped === null) return null;
    // A status view is DM-only in a channel unless the gate is enforced and the channel holds `todo` (ADR-0122 P2, Codex
    // P2 of #221); with the gate off it stays DM-only. Nothing is read when refused.
    if (mapped.kind === 'todo.list' && mapped.status !== undefined && !surfaceChannelHolds(ctx.message.context, ctx.surfacePermit, 'todo')) {
      return { reply: outboundMessage(ctx.message.context, renderListStatusDmOnly(selected.language), { replyToMessageId: ctx.message.id }) };
    }
    const command = mapped;
    const { outcome, listed } = await this.run(command, ctx, selected.language);
    if (command.kind !== 'lookup' || command.listOnly !== true || listed === undefined || outcome === null) return outcome;
    if (outcome.kind !== undefined && outcome.kind !== 'reply') return outcome;
    const count = renderWorkChatCount(command.source, listed, selected.language);
    return { ...outcome, reply: withOutboundBody(outcome.reply, messageBody(count, '\n', outboundBody(outcome.reply))) };
  }

  /**
   * ADR-0120 amendment A6: a validated to-do action (or the undo of one), its target resolved by Core. DM-only (A6-D1).
   * The reply carries the content-free receipt the runtime records as `lastAction`.
   */
  private async handleAction(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    const handleAction = this.deps.desk.handleAction;
    if (handleAction === undefined || !isNlActionEntryId(selected.entryId)) return null;
    if (selected.entryId === 'action.undo' && selected.target?.source !== 'todo') return null;
    if (!isDirectConversation(ctx.message.context)) {
      return { reply: outboundMessage(ctx.message.context, renderActionDmOnly(selected.language)), nlAction: { entryId: selected.entryId, result: 'refused', source: 'todo', reason: 'not-dm' } };
    }
    let outcome: WorkChatOutcome;
    try {
      // The fresh listing lets an answer name an existing to-do by the number the owner saw (A6-D2 amendment, #233).
      outcome = await handleAction.call(this.deps.desk, selected, ctx.actor, ctx.nlActionWriteCondition, todoListingOptions(ctx));
    } catch (error) {
      this.deps.logger.error('work_chat.turn_handler.failed', { handlerId: this.id, errorName: error instanceof Error ? error.name : 'unknown' });
      return { reply: outboundMessage(ctx.message.context, renderTodoFailure()), status: 'FAILED' };
    }
    if (outcome.kind !== 'reply') return null;
    return {
      reply: outboundMessage(ctx.message.context, outboundBody(outcome)),
      ...(outcome.action !== undefined ? { nlAction: outcome.action } : {}),
    };
  }

  /**
   * ADR-0120 amendment A6 R2: ONE listed Jira issue or Slack message, its target resolved by Core from the content-free
   * listing slot (never from content). DM-only (A6-D1). `summary` hands the single-item readout to the ADR-0100 D8
   * `summarize` path (the runtime re-validates it and runs SUMMARIZATION); `full` shows it to the owner in untrusted
   * spans with no model call (record C). A summary while QUOKY_WORK_SUMMARY_ENABLED=false is refused before any fetch.
   * Every outcome keeps only the fixed history note (amendment C10) and carries a content-free receipt.
   */
  private async summarizeItem(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    const target = selected.target;
    const readItem = this.deps.desk.readItem;
    if ((this.deps.itemR2 ?? 'off') === 'off' || readItem === undefined || target === undefined || !isNlR2ItemSource(target.source) || target.id === undefined) return null;
    const source = target.source;
    const itemRef = target.id;
    const scope = selected.args.scope === 'thread' ? 'thread' : 'item';
    const mode = selected.args.mode === 'full' ? 'full' : 'summary';
    const language = selected.language;
    const history = { assistant: renderUntrustedDocumentHistoryNote(workItemDocumentSource(source, scope), language) };
    const receipt = (result: NlActionReceipt['result'], extra: Partial<Pick<NlActionReceipt, 'reason' | 'fetch'>> = {}): NlActionReceipt => ({
      entryId: 'item.summarize',
      result,
      source,
      itemId: itemRef,
      ...(target.label !== undefined ? { label: target.label } : {}),
      ...extra,
    });
    const answer = (text: MessageBody, action: NlActionReceipt): TurnHandlerOutcome => ({
      reply: outboundMessage(ctx.message.context, text, { replyToMessageId: ctx.message.id }),
      history,
      nlAction: action,
    });
    if (!isDirectConversation(ctx.message.context)) return answer(renderWorkItemDmOnly(), receipt('refused', { reason: 'not-dm' }));
    // A Jira issue has no thread; a Slack thread is read whole, never one reply apart (D4).
    if (source === 'jira' && scope === 'thread') return answer(renderWorkItemReplyNotIsolable(), receipt('refused', { reason: 'reply-not-isolable' }));
    // CA P2 (proposal §2.1 fixture gate): until a RECORDED Slack fixture proves that one `conversations.replies` request
    // isolates a single thread reply, a listed reply (`channel:ts:threadTs`) is refused explicitly before any fetch; its
    // whole thread ('스레드 요약') and every top-level message stay supported.
    // TODO(A6 R2): record the live Slack fixture (Strict, owner-approved) and lift this refusal when it passes.
    if (source === 'slack' && scope === 'item' && itemRef.split(':').length === 3) {
      return answer(renderWorkItemReplyNotIsolable(), receipt('refused', { reason: 'reply-not-isolable' }));
    }
    // D6: QUOKY_WORK_SUMMARY_ENABLED=false keeps its meaning — no Jira or Slack text reaches a model; 0 GETs.
    if (mode === 'summary' && !this.deps.summaryEnabled) return answer(renderWorkItemSummaryOff(), receipt('refused', { reason: 'summary-off' }));
    let read: Awaited<ReturnType<NonNullable<WorkDesk['readItem']>>>;
    try {
      read = await readItem.call(this.deps.desk, source, itemRef, scope);
    } catch (error) {
      this.deps.logger.error('work_chat.turn_handler.failed', { handlerId: this.id, errorName: error instanceof Error ? error.name : 'unknown' });
      read = { kind: 'failure', reason: 'UNAVAILABLE' };
    }
    if (read.kind === 'failure') {
      this.deps.logger.info('work_chat.item_read', { source, outcome: workItemFetchOutcome(read.reason) });
      return answer(renderWorkItemFailure(source, read.reason), receipt('refused', { reason: workItemFetchOutcome(read.reason), fetch: { outcome: workItemFetchOutcome(read.reason), count: 1, bytes: '0' } }));
    }
    const item = read.item;
    const fetched = { count: item.detail?.requests ?? 1, bytes: workItemBytesBucket(item.detail?.bytes) };
    const built = buildWorkItemReadout({ source, scope, mode, item });
    if (!built.ok) {
      const outcome = built.refusal === 'EMPTY' ? 'empty' : 'credential-withheld';
      this.deps.logger.info('work_chat.item_read', { source, outcome });
      return answer(built.refusal === 'EMPTY' ? renderWorkItemEmpty() : renderWorkItemCredentialWithheld(), receipt('refused', { reason: outcome, fetch: { outcome, ...fetched } }));
    }
    const notes = workItemNotes({
      source,
      scope,
      item,
      ...(source === 'jira' ? { listedKey: itemRef.split(':')[0] as string } : {}),
      ...(target.listingAt !== undefined ? { listingAt: target.listingAt } : {}),
    });
    const executed = receipt('executed', { fetch: { outcome: 'ok', ...fetched } });
    this.deps.logger.info('work_chat.item_read', { source, outcome: 'ok', mode, requests: fetched.count });
    if (mode === 'full') {
      const full = renderUntrustedDocumentFull(built.readout, { language, label: workItemLabel(source, target.label, scope), totalChars: built.totalChars });
      return answer(messageBody(full, ...notes.flatMap((note) => ['\n', note])), executed);
    }
    return {
      kind: 'summarize',
      readout: built.readout,
      fallbackText: renderWorkItemFallback(source, item, notes),
      footer: renderWorkItemFooter(source, scope, target.label, item, notes),
      history,
      nlAction: executed,
      participants: workItemParticipants(item),
    };
  }

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    const command = detectWorkChatCommand(ctx.message.text, { yieldToSelection: ctx.grammarYield === true });
    if (!command || workChatCommandMode(command) !== this.deps.mode) return null;
    const { outcome } = await this.run(command, ctx);
    // ADR-0120 follow-up: a listing this grammar answered is also its catalog selection (a failure shows no listing).
    if (outcome === null || outcome.kind === 'write-draft') return outcome;
    if (outcome.kind !== 'summarize' && outcome.status === 'FAILED') return outcome;
    // P9: the listing Core actually answered (a reinterpreted release) wins over the command's own catalog equivalent.
    const nlSelection = outcome.nlSelection ?? nlSelectionForWorkChatCommand(command);
    return nlSelection === null ? outcome : { ...outcome, nlSelection };
  }

  /**
   * ADR-0120 D6 Phase C: the unanchored lookup and listing phrases (`detectLookup`, `detectJiraListing`, the search,
   * to-do list and to-do summary forms — frozen Class B) would answer this message with a catalog equivalent. The anchored to-do heads, the
   * write requests and refusals, the usage hints and lookups the catalog cannot express (a GitHub or Jira text search)
   * are not probed (`null`), so `handle` answers them exactly as before. Pure: the desk is not called.
   */
  classBProbe(ctx: TurnHandlerProbeContext): NlClassBProbe | null {
    let command: WorkChatCommand | null;
    try {
      command = detectWorkChatCommand(ctx.message.text, { yieldToSelection: ctx.grammarYield === true });
    } catch {
      return null;
    }
    // The to-do summary question runs in the mutation handler (order 100), every other read in the lookup handler.
    if (command === null || workChatCommandMode(command) !== this.deps.mode) return null;
    if (command.kind !== 'lookup' && command.kind !== 'todo.list' && command.kind !== 'todo.summary') return null;
    const selection = nlSelectionForWorkChatCommand(command);
    if (selection === null) return null;
    const grammarId = command.kind === 'lookup' ? `work-lookup.${command.query}` : command.kind === 'todo.list' ? 'work-lookup.todo-list' : 'work-lookup.todo-summary';
    return { grammarId, selection };
  }

  /**
   * ADR-0122 D2.1: the groups this handler's grammar would answer under — the same `detectWorkChatCommand` `handle` reads,
   * mapped by the exhaustive work-command switch. Hint-only and status statements (`todo.hint`, `todo.status`: the desk may
   * still decline when no open to-do matches) are `skip`. Pure: the desk is not called.
   */
  surfaceClaim(ctx: TurnHandlerProbeContext): SurfaceClaim | null {
    let command: WorkChatCommand | null;
    try {
      command = detectWorkChatCommand(ctx.message.text, { yieldToSelection: ctx.grammarYield === true });
    } catch {
      return null;
    }
    if (command === null || workChatCommandMode(command) !== this.deps.mode) return null;
    return surfaceClaimOf(surfaceGroupsOfWorkChatCommand(command), command.kind === 'todo.hint' || command.kind === 'todo.status' ? 'skip' : 'reply');
  }

  /** One command through the desk; `listed` is a deterministic lookup list's item count (for a count answer). */
  private async run(
    command: WorkChatCommand,
    ctx: TurnHandlerContext,
    language: 'ko' | 'en' = 'ko',
  ): Promise<{ readonly outcome: TurnHandlerOutcome | null; readonly listed?: { readonly count: number; readonly truncated: boolean; readonly shown?: number } }> {
    // ADR-0112 D5 (CWR-2): an exact Jira comment / transition or Slack post request is handed to the runtime's
    // connector-write flow (this handler creates no approval and makes no write). `fallbackText` is the fixed refusal
    // the runtime replies with while writes are off.
    if (command.kind === 'connector-write') {
      return { outcome: { kind: 'write-draft', draft: command.draft, fallbackText: renderExternalWriteRefusal(command.source) } };
    }
    let outcome: WorkChatOutcome;
    try {
      const options = handleOptionsOf(command, ctx);
      outcome = options === undefined ? await this.deps.desk.handle(command, ctx.actor) : await this.deps.desk.handle(command, ctx.actor, options);
    } catch (error) {
      // The desk catches its own failures; this is the handler-contract backstop. The message was a recognized work
      // command, so it must not fall through to chat (a model could claim the change). Failure class only, no text.
      this.deps.logger.error('work_chat.turn_handler.failed', {
        handlerId: this.id,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      // A hint-only command is not a mutation request: on failure the turn simply falls through.
      if (command.kind === 'todo.hint' || command.kind === 'todo.status') return { outcome: null };
      return { outcome: { reply: { context: ctx.message.context, text: backstopText(command) }, status: 'FAILED' } };
    }
    if (outcome.kind === 'none') return { outcome: null };
    if (outcome.kind === 'reply') {
      // ADR-0120 amendment A6: the desk's content-free receipts ride along (present only with QUOKY_NL_ACTIONS not off).
      const reply = {
        reply: outboundMessage(ctx.message.context, outboundBody(outcome)),
        ...(outcome.action !== undefined ? { nlAction: outcome.action } : {}),
        ...(outcome.listing !== undefined ? { nlListing: outcome.listing } : {}),
        ...(outcome.confirm !== undefined ? { nlConfirm: { selection: outcome.confirm, language } } : {}),
        // P9: the listing actually shown (a release value read as a visible project key) becomes `lastSelection`.
        ...(outcome.resolved !== undefined ? { nlSelection: outcome.resolved } : {}),
      };
      return outcome.listed === undefined ? { outcome: reply } : { outcome: reply, listed: outcome.listed };
    }
    // Only lookups summarise, and only with summaries enabled; anything else gets the deterministic list.
    if (!this.deps.summaryEnabled || this.deps.mode !== 'lookup') {
      return { outcome: { reply: outboundMessage(ctx.message.context, outcome.fallbackText), ...(outcome.numbered !== undefined ? { nlListing: outcome.numbered.fallback } : {}) } };
    }
    const summarize: TurnHandlerSummarizeReply = {
      kind: 'summarize',
      readout: outcome.readout,
      fallbackText: outcome.fallbackText,
      footer: outcome.footer,
      ...(outcome.numbered !== undefined ? { numbered: outcome.numbered } : {}),
    };
    return { outcome: summarize };
  }
}

/** Both work-chat handlers, mutation (100) then lookup (300), over one desk. */
export function createWorkChatTurnHandlers(
  deps: Omit<WorkChatTurnHandlerDeps, 'mode'>,
): readonly [WorkChatTurnHandler, WorkChatTurnHandler] {
  return [new WorkChatTurnHandler({ ...deps, mode: 'mutation' }), new WorkChatTurnHandler({ ...deps, mode: 'lookup' })];
}

/**
 * What the desk needs besides the command, or `undefined` (the call is exactly as before):
 *  - ADR-0122 D2.4: the combined view filters its Jira / GitHub sections by the channel's permit.
 *  - ADR-0120 A6-D2 amendment (2026-10-16): a to-do command that names or may name a list number gets the fresh to-do
 *    listing of this (Session, Actor) — what the owner last saw — so the number resolves against it, not the live order.
 */
function handleOptionsOf(command: WorkChatCommand, ctx: TurnHandlerContext): WorkDeskHandleOptions | undefined {
  if (command.kind === 'todo.list' || command.kind === 'todo.summary') return ctx.surfacePermit !== undefined ? { permit: ctx.surfacePermit } : undefined;
  if (
    command.kind !== 'todo.add' &&
    command.kind !== 'todo.complete' &&
    command.kind !== 'todo.cancel' &&
    command.kind !== 'todo.link' &&
    command.kind !== 'todo.hint' &&
    command.kind !== 'todo.status'
  ) {
    return undefined;
  }
  return todoListingOptions(ctx);
}

/** The owner's fresh to-do listing slot of this (Session, Actor) as desk options, or `undefined` (none, expired, unreadable). */
function todoListingOptions(ctx: TurnHandlerContext): WorkDeskHandleOptions | undefined {
  let todoListing: WorkDeskHandleOptions['todoListing'];
  try {
    todoListing = readListingRecord(ctx.session.metadata?.[LAST_LISTING_METADATA_KEY], ctx.actor.id, ctx.now).slots.todo;
  } catch {
    todoListing = undefined;
  }
  return todoListing === undefined ? undefined : { todoListing };
}

/** A6-D1: every action entry is DM-only. */
function renderActionDmOnly(language: 'ko' | 'en'): string {
  return language === 'en' ? 'I do that only in a direct message. Nothing was changed.' : '이 작업은 DM에서만 해요. 아무것도 바꾸지 않았어요.';
}

function backstopText(command: WorkChatCommand): string {
  switch (command.kind) {
    case 'todo.list':
    case 'todo.summary':
      return renderTodoListFailure();
    case 'lookup':
    case 'release':
    case 'external-write-unsupported':
    case 'connector-write':
      return renderLookupFailure(command.source, 'UNAVAILABLE');
    case 'usage':
      return command.topic.startsWith('todo-') ? renderTodoFailure() : renderTodoListFailure();
    default:
      return renderTodoFailure();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime-side guards for the `summarize` outcome (ADR-0100 D8)
// ---------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function boundedLine(value: unknown, maxChars: number, required: boolean): boolean {
  if (value === undefined) return !required;
  if (typeof value !== 'string') return false;
  const length = Array.from(value).length;
  if (length > maxChars || (required && length === 0)) return false;
  return !CONTROL_CHARS.test(value) && !containsCredentialMaterial(value);
}

/**
 * Re-validate a `summarize` readout before any of it can reach a provider (defence in depth over WORK-T3's builder,
 * which already enforces all of this). Fail closed: any shape, bound or credential violation means the runtime
 * replies with the deterministic list and makes no provider call. Requires 1..10 items that all fit the prompt
 * section, so the footer never discloses or links an item the model did not see.
 */
export function isSummarizableExternalWorkReadout(readout: unknown): readout is ExternalWorkReadout {
  if (typeof readout !== 'object' || readout === null) return false;
  const candidate = readout as Partial<ExternalWorkReadout>;
  if (candidate.kind !== EXTERNAL_WORK_READOUT_KIND) return false;
  const request = candidate.request;
  if (typeof request !== 'object' || request === null) return false;
  if (!(WORK_CHAT_SOURCES as readonly unknown[]).includes(request.source)) return false;
  if (!(WORK_CHAT_LOOKUP_QUERIES as readonly unknown[]).includes(request.query)) return false;
  if (!boundedLine(request.text, EXTERNAL_WORK_FIELD_MAX_CHARS, false)) return false;
  if (typeof candidate.truncated !== 'boolean') return false;
  if (!Number.isInteger(candidate.omittedSensitive) || (candidate.omittedSensitive as number) < 0) return false;
  if (candidate.numbered !== undefined && candidate.numbered !== true) return false;
  const items = candidate.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > EXTERNAL_WORK_MAX_ITEMS) return false;
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) return false;
    const fields = item as Record<string, unknown>;
    if (
      !boundedLine(fields.ref, EXTERNAL_WORK_FIELD_MAX_CHARS + 20, true) ||
      !boundedLine(fields.title, EXTERNAL_WORK_TITLE_MAX_CHARS, true) ||
      !boundedLine(fields.url, EXTERNAL_WORK_URL_MAX_CHARS, false) ||
      !boundedLine(fields.status, EXTERNAL_WORK_FIELD_MAX_CHARS, false) ||
      !(fields.dueDate === undefined || (typeof fields.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fields.dueDate))) ||
      !boundedLine(fields.container, EXTERNAL_WORK_FIELD_MAX_CHARS, false) ||
      !boundedLine(fields.excerpt, EXTERNAL_WORK_EXCERPT_MAX_CHARS, false)
    ) {
      return false;
    }
  }
  const valid = readout as ExternalWorkReadout;
  if (countExternalWorkPromptItems(valid) !== items.length) return false;
  return renderExternalWorkReadoutForPrompt(valid).length <= EXTERNAL_WORK_PROMPT_MAX_CHARS;
}

/**
 * The reply for a successful work summary: the model text, a blank line and the deterministic footer, bounded to
 * `WORK_SUMMARY_REPLY_MAX_CHARS`. The footer is kept whole (it is capped at 1,000 characters) and the summary is
 * shortened instead, so the source links and the "N items used" disclosure always reach the user. Both bounds apply
 * to the delivered text (the footer's titles are platform-rendered spans, PLT-0).
 */
export function appendWorkSummaryFooter(summaryText: string, footer: MessageBody): MessageBody {
  const body = summaryText.trim();
  if (plainTextOf(footer).trim().length === 0) return messageBody(clipMessage(body, WORK_SUMMARY_REPLY_MAX_CHARS, 'code-points'));
  const tail = clipMessage(footer, EXTERNAL_WORK_FOOTER_MAX_CHARS, 'code-points', { trim: true });
  return messageBody(clipMessage(body, WORK_SUMMARY_REPLY_MAX_CHARS, 'code-points', { after: messageBody('\n\n', tail) }));
}
