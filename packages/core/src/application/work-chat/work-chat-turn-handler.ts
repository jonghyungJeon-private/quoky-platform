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
import { isNlActionEntryId, type NlCatalogEntry, type NlClassBProbe, type NlSelectedCommand } from '../nl-routing/catalog';
import { nlActionEntry } from '../nl-routing/action-entries';
import { nlWave1Entry } from '../nl-routing/wave1-entries';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { renderListStatusDmOnly } from '../nl-routing/nl-action-policy';
import { isDirectConversation } from '../message-rendering';
import { surfaceClaimOf, surfaceGroupsOfWorkChatCommand } from '../surface-grants/surface-group-map';
import { surfaceChannelHolds } from '../surface-grants/surface-permit';
import { WORK_CHAT_SOURCE_ENTRY, nlSelectionForWorkChatCommand, renderWorkChatCount, workChatCommandForSelection } from './work-chat-selection';
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
import type { WorkChatOutcome, WorkDesk } from './work-chat-service';

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
  readonly desk: Pick<WorkDesk, 'handle' | 'configuredSources'> & Partial<Pick<WorkDesk, 'handleAction'>>;
  readonly mode: WorkChatMode;
  /**
   * `QUOKY_WORK_SUMMARY_ENABLED` (owner decision ADR-0100 #2). The desk already honours it; the handler re-checks it
   * so that, with summaries off, no `summarize` outcome can ever leave this handler (the deterministic list is the
   * reply and no provider is called).
   */
  readonly summaryEnabled: boolean;
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
    return [
      ...configured.flatMap((source) => (source === 'jira' ? [nlWave1Entry('jira.issues'), nlWave1Entry('jira.release')] : [nlWave1Entry(WORK_CHAT_SOURCE_ENTRY[source])])),
      nlWave1Entry('todo.list'),
    ];
  }

  /**
   * A validated selection mapped to the existing typed lookup or to-do list command (ADR-0120 interfaces), answered like
   * `handle` answers it. A count question gets the deterministic list with a count line first (never a summary).
   */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    if (this.deps.mode !== 'lookup') return this.handleAction(selected, ctx);
    // ADR-0120 A8: a release link is read from the owner's own non-quoted words only (quoted or fenced text is data).
    const prepared = selected.entryId === 'jira.release' ? prepareSelectionInput(ctx.message.text, 0, ctx.message.quotedRanges ?? []) : undefined;
    const mapped = workChatCommandForSelection(selected, prepared === undefined || 'skip' in prepared ? '' : prepared.groundingText);
    if (mapped === null) return null;
    // A status view is DM-only in a channel unless the gate is enforced and the channel holds `todo` (ADR-0122 P2, Codex
    // P2 of #221); with the gate off it stays DM-only. Nothing is read when refused.
    if (mapped.kind === 'todo.list' && mapped.status !== undefined && !surfaceChannelHolds(ctx.message.context, ctx.surfacePermit, 'todo')) {
      return { reply: outboundMessage(ctx.message.context, renderListStatusDmOnly(selected.language), { replyToMessageId: ctx.message.id }) };
    }
    // ADR-0120 A8 owner decision 7: a release listing knows whether it answers in a channel — every-assignee scope and the
    // lists stay DM-only there unless the gate is enforced and the channel holds `jira-project` (ADR-0122 P2).
    const command =
      mapped.kind === 'release' && !surfaceChannelHolds(ctx.message.context, ctx.surfacePermit, 'jira-project') ? { ...mapped, inChannel: true as const } : mapped;
    const { outcome, listed } = await this.run(command, ctx);
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
      outcome = await handleAction.call(this.deps.desk, selected, ctx.actor, ctx.nlActionWriteCondition);
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

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null> {
    const command = detectWorkChatCommand(ctx.message.text, { yieldToSelection: ctx.grammarYield === true });
    if (!command || workChatCommandMode(command) !== this.deps.mode) return null;
    const { outcome } = await this.run(command, ctx);
    // ADR-0120 follow-up: a listing this grammar answered is also its catalog selection (a failure shows no listing).
    if (outcome === null || outcome.kind === 'write-draft') return outcome;
    if (outcome.kind !== 'summarize' && outcome.status === 'FAILED') return outcome;
    const nlSelection = nlSelectionForWorkChatCommand(command);
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
  ): Promise<{ readonly outcome: TurnHandlerOutcome | null; readonly listed?: { readonly count: number; readonly truncated: boolean } }> {
    // ADR-0112 D5 (CWR-2): an exact Jira comment / transition or Slack post request is handed to the runtime's
    // connector-write flow (this handler creates no approval and makes no write). `fallbackText` is the fixed refusal
    // the runtime replies with while writes are off.
    if (command.kind === 'connector-write') {
      return { outcome: { kind: 'write-draft', draft: command.draft, fallbackText: renderExternalWriteRefusal(command.source) } };
    }
    let outcome: WorkChatOutcome;
    try {
      // ADR-0122 D2.4: the combined view filters its Jira / GitHub sections by the channel's permit (absent: unchanged).
      outcome = ctx.surfacePermit !== undefined && (command.kind === 'todo.list' || command.kind === 'todo.summary')
        ? await this.deps.desk.handle(command, ctx.actor, { permit: ctx.surfacePermit })
        : await this.deps.desk.handle(command, ctx.actor);
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
      };
      return outcome.listed === undefined ? { outcome: reply } : { outcome: reply, listed: outcome.listed };
    }
    // Only lookups summarise, and only with summaries enabled; anything else gets the deterministic list.
    if (!this.deps.summaryEnabled || this.deps.mode !== 'lookup') {
      return { outcome: { reply: outboundMessage(ctx.message.context, outcome.fallbackText) } };
    }
    const summarize: TurnHandlerSummarizeReply = {
      kind: 'summarize',
      readout: outcome.readout,
      fallbackText: outcome.fallbackText,
      footer: outcome.footer,
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
