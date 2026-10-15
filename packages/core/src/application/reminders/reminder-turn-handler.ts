import type {
  ConversationTurnHandler,
  SurfaceClaim,
  TurnHandlerContext,
  TurnHandlerProbeContext,
  TurnHandlerReply,
} from '../../ports/conversation-turn-handler.port';
import type { Logger } from '../../ports/logger.port';
import { isDirectConversation, outboundMessage } from '../message-rendering';
import { surfaceClaimOf } from '../surface-grants/surface-group-map';
import { parseReminderMessage } from './reminder-grammar';
import { isNlActionEntryId, type NlCatalogEntry, type NlSelectedCommand } from '../nl-routing/catalog';
import { nlActionEntry } from '../nl-routing/action-entries';
import { nlWave1Entry } from '../nl-routing/wave1-entries';
import type { OnDemandBrief } from './on-demand-brief';
import type { ReminderConversationService } from './reminder-conversation-service';
import type { ReminderReplyComposer } from './reminder-reply-composer';

/**
 * Owner reminders as an ADR-0096 `pre-classify` turn handler (ADR-0101 D5, PRO-5).
 *
 * Runs after pending-approval capture (a reminder phrase while an approval is pending keeps the ADR-0093
 * reminder), the stray-decision reply, `기억해:` and the order-100 anchored to-do handler, and before the intent
 * classifier. It only wraps `ReminderConversationService`: a reminder phrase ends in one deterministic reply, any
 * other message falls through (`null`). No Task, provider, tool, connector or durable memory.
 *
 * Always registered, whatever `QUOKY_REMINDERS_ENABLED` says: with the flag off the service answers a recognized
 * phrase with the fixed disabled copy, so a reminder request never reaches chat (where a model could promise a
 * reminder it cannot keep, QA-008/QA-018).
 */

export const REMINDER_TURN_HANDLER_ID = 'reminders';

/**
 * ADR-0117 D5 (BRF-2): what SHORT_TERM history keeps instead of a reminder reply that echoes calendar event titles
 * (any reply carrying an untrusted span), as the calendar handler does, so event text never reaches a later prompt.
 */
export const REMINDER_EVENT_HISTORY_NOTE = '[알림 응답 — 캘린더 일정 내용은 대화 기록에 남기지 않아요.]';
export const REMINDER_TURN_HANDLER_ORDER = 200;

/** ADR-0120 / ADR-0117 D5: SHORT_TERM history keeps this instead of an on-demand brief (it may carry event titles). */
export const ON_DEMAND_BRIEF_HISTORY_NOTE = '[오늘의 브리핑 응답 — 브리핑 내용은 대화 기록에 남기지 않아요.]';

/** ADR-0117 D4 (amended by ADR-0120): the on-demand brief is answered only in the owner's DM. */
export function renderBriefDmOnly(language: 'ko' | 'en'): string {
  return language === 'en'
    ? "Today's brief is shown only in a direct message. Send me \"today's brief\" in a DM."
    : '오늘의 브리핑은 DM에서만 보여 드려요. 저에게 DM으로 "오늘 브리핑해줘"라고 보내 주세요.';
}

/** Help lines while reminders are on (ADR-0096 D6; each well under the composer's 120-char bound). */
export const REMINDER_HELP_LINES: readonly string[] = [
  '- "30분 뒤에 스트레칭 알려줘", "내일 오전 9시에 회의 준비 알려줘", "매일 오전 8시에 오늘 할 일 알려줘": 알림을 만들어요.',
  '- "알림 목록", "알림 N 취소": 예정된 알림을 보거나 하나씩 취소해요. 알림은 기본으로 DM으로 보내요.',
];

/** The single help line while reminders are off. */
export const REMINDER_DISABLED_HELP_LINES: readonly string[] = [
  '- 알림(리마인더) 기능은 지금 꺼져 있어요.',
];

export interface ReminderTurnHandlerDeps {
  readonly conversation: Pick<ReminderConversationService, 'handleTurn'> &
    Partial<Pick<ReminderConversationService, 'listReply' | 'listReplyDetailed' | 'handleTurnDetailed' | 'handleAction'>>;
  /** Fallback copy if the service ever throws (it is documented never to). */
  readonly composer: Pick<ReminderReplyComposer, 'storageFailure'>;
  /** `QUOKY_REMINDERS_ENABLED`; selects the help lines only (the service owns the disabled reply). */
  readonly enabled: boolean;
  readonly logger: Logger;
  /** ADR-0120 `brief.today`: the on-demand brief; absent = the entry is not offered. */
  readonly brief?: Pick<OnDemandBrief, 'compose'>;
}

export class ReminderTurnHandler implements ConversationTurnHandler {
  readonly id = REMINDER_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = REMINDER_TURN_HANDLER_ORDER;
  readonly helpLines: readonly string[];

  constructor(private readonly deps: ReminderTurnHandlerDeps) {
    this.helpLines = deps.enabled ? REMINDER_HELP_LINES : REMINDER_DISABLED_HELP_LINES;
  }

  /**
   * ADR-0120 D1: `reminder.list` while reminders are on, and `brief.today` when the on-demand brief is wired. A getter,
   * read on every selection turn.
   */
  get catalog(): readonly NlCatalogEntry[] {
    return [
      ...(this.deps.enabled && this.deps.conversation.listReply !== undefined ? [nlWave1Entry('reminder.list')] : []),
      // The brief rides on the reminder store: with reminders off it is not offered (and never answered).
      ...(this.deps.enabled && this.deps.brief !== undefined ? [nlWave1Entry('brief.today')] : []),
      // ADR-0120 amendment A6: the reminder action entries (offered by the runtime only while QUOKY_NL_ACTIONS allows).
      ...(this.deps.enabled && this.deps.conversation.handleAction !== undefined
        ? [nlActionEntry('reminder.create'), nlActionEntry('reminder.cancel'), nlActionEntry('action.undo')]
        : []),
    ];
  }

  /** A validated selection (ADR-0120 interfaces): the existing reminder LIST, or the model-free on-demand brief (DM only). */
  async handleSelected(selected: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    const base = { context: ctx.message.context, actorId: ctx.actor.id, messageId: ctx.message.id, now: ctx.now };
    if (isNlActionEntryId(selected.entryId)) return this.handleAction(selected, ctx, base);
    if (selected.entryId === 'reminder.list') {
      // A6: the detailed form also reports the listing as rendered (present only with QUOKY_NL_ACTIONS not off).
      if (this.deps.conversation.listReplyDetailed !== undefined) {
        const listed = await this.deps.conversation.listReplyDetailed(base);
        return { reply: listed.reply, ...(listed.listing !== undefined ? { nlListing: listed.listing } : {}) };
      }
      return this.deps.conversation.listReply === undefined ? null : { reply: await this.deps.conversation.listReply(base) };
    }
    if (selected.entryId !== 'brief.today' || this.deps.brief === undefined || !this.deps.enabled) return null;
    if (!isDirectConversation(ctx.message.context)) {
      return { reply: outboundMessage(ctx.message.context, renderBriefDmOnly(selected.language), { replyToMessageId: ctx.message.id }) };
    }
    try {
      const body = await this.deps.brief.compose(ctx.actor.id, ctx.now);
      return {
        reply: outboundMessage(ctx.message.context, body, { replyToMessageId: ctx.message.id }),
        history: { assistant: ON_DEMAND_BRIEF_HISTORY_NOTE },
      };
    } catch (error) {
      this.deps.logger.error('reminder.turn_handler.brief_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      return {
        reply: outboundMessage(ctx.message.context, this.deps.composer.storageFailure(), { replyToMessageId: ctx.message.id }),
        status: 'FAILED',
      };
    }
  }

  /** ADR-0120 amendment A6: one reminder action (or the undo of one), DM-only, with its content-free receipt. */
  private async handleAction(
    selected: NlSelectedCommand,
    ctx: TurnHandlerContext,
    base: { readonly context: TurnHandlerContext['message']['context']; readonly actorId: string; readonly messageId: string; readonly now: string },
  ): Promise<TurnHandlerReply | null> {
    const handleAction = this.deps.conversation.handleAction;
    if (handleAction === undefined || !this.deps.enabled) return null;
    if (selected.entryId === 'action.undo' && selected.target?.source !== 'reminder') return null;
    if (selected.entryId !== 'reminder.create' && selected.entryId !== 'reminder.cancel' && selected.entryId !== 'action.undo') return null;
    if (!isDirectConversation(ctx.message.context)) {
      const text = selected.language === 'en' ? 'I do that only in a direct message. Nothing was changed.' : '이 작업은 DM에서만 해요. 아무것도 바꾸지 않았어요.';
      return { reply: outboundMessage(ctx.message.context, text, { replyToMessageId: ctx.message.id }), nlAction: { entryId: selected.entryId, result: 'refused', source: 'reminder', reason: 'not-dm' } };
    }
    const condition = ctx.nlActionWriteCondition;
    const result = await handleAction.call(this.deps.conversation, selected, { ...base, ...(condition !== undefined ? { actionCondition: condition } : {}) });
    const reply = result.reply;
    return {
      reply,
      ...(reply.content !== undefined ? { history: { assistant: REMINDER_EVENT_HISTORY_NOTE } } : {}),
      ...(result.action !== undefined ? { nlAction: result.action } : {}),
    };
  }

  /**
   * ADR-0122 D2.1: every reminder grammar hit (create, cancel, list, clarify, the disabled reply) is `reminder`. The same
   * whole-message grammar the service reads; nothing is read or written.
   */
  surfaceClaim(ctx: TurnHandlerProbeContext): SurfaceClaim | null {
    try {
      return parseReminderMessage(ctx.message.text, { now: ctx.now }).kind === 'NOT_REMINDER' ? null : surfaceClaimOf(['reminder']);
    } catch {
      return null;
    }
  }

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    try {
      const input = {
        text: ctx.message.text,
        context: ctx.message.context,
        actorId: ctx.actor.id,
        messageId: ctx.message.id,
        now: ctx.now,
      };
      // A6: the detailed form carries the content-free receipts (present only with QUOKY_NL_ACTIONS not off).
      const detailed = this.deps.conversation.handleTurnDetailed !== undefined ? await this.deps.conversation.handleTurnDetailed(input) : undefined;
      const reply = detailed !== undefined ? detailed?.reply ?? null : await this.deps.conversation.handleTurn(input);
      if (!reply) return null;
      const receipts = {
        ...(detailed?.action !== undefined ? { nlAction: detailed.action } : {}),
        ...(detailed?.listing !== undefined ? { nlListing: detailed.listing } : {}),
      };
      return reply.content !== undefined ? { reply, history: { assistant: REMINDER_EVENT_HISTORY_NOTE }, ...receipts } : { reply, ...receipts };
    } catch (error) {
      // The service catches its own failures; this is the handler-contract backstop. It cannot know whether the
      // text was a reminder phrase, and falling through could let chat promise a reminder, so it answers with the
      // fixed failure copy. Log the failure class only — never the message text.
      this.deps.logger.error('reminder.turn_handler.failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return {
        reply: {
          context: ctx.message.context,
          text: this.deps.composer.storageFailure(),
          replyToMessageId: ctx.message.id,
        },
        status: 'FAILED',
      };
    }
  }
}
