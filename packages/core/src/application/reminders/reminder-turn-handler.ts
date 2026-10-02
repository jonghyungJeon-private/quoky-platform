import type {
  ConversationTurnHandler,
  TurnHandlerContext,
  TurnHandlerReply,
} from '../../ports/conversation-turn-handler.port';
import type { Logger } from '../../ports/logger.port';
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
export const REMINDER_TURN_HANDLER_ORDER = 200;

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
  readonly conversation: Pick<ReminderConversationService, 'handleTurn'>;
  /** Fallback copy if the service ever throws (it is documented never to). */
  readonly composer: Pick<ReminderReplyComposer, 'storageFailure'>;
  /** `QUOKY_REMINDERS_ENABLED`; selects the help lines only (the service owns the disabled reply). */
  readonly enabled: boolean;
  readonly logger: Logger;
}

export class ReminderTurnHandler implements ConversationTurnHandler {
  readonly id = REMINDER_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = REMINDER_TURN_HANDLER_ORDER;
  readonly helpLines: readonly string[];

  constructor(private readonly deps: ReminderTurnHandlerDeps) {
    this.helpLines = deps.enabled ? REMINDER_HELP_LINES : REMINDER_DISABLED_HELP_LINES;
  }

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    try {
      const reply = await this.deps.conversation.handleTurn({
        text: ctx.message.text,
        context: ctx.message.context,
        actorId: ctx.actor.id,
        messageId: ctx.message.id,
        now: ctx.now,
      });
      return reply ? { reply } : null;
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
