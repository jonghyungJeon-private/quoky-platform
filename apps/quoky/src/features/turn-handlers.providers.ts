import type { Provider } from '@nestjs/common';
import { CONVERSATION_TURN_HANDLERS, type ConversationTurnHandler } from '@quoky/core';
import {
  CODE_WORK_TURN_HANDLERS,
  FEEDBACK_TURN_HANDLERS,
  REMINDER_TURN_HANDLERS,
  WORK_CHAT_TURN_HANDLERS,
} from './feature-tokens';

type TurnHandlerList = readonly ConversationTurnHandler[];

/**
 * Binds the Core `CONVERSATION_TURN_HANDLERS` token to the concatenation of the four feature handler lists
 * (ADR-0096 D7). The concatenation order carries no meaning: `ConversationRuntime` rejects duplicate ids and
 * dispatches by `(stage, order, id)` (ADR-0096 D2/D5).
 */
export const turnHandlersProvider: Provider = {
  provide: CONVERSATION_TURN_HANDLERS,
  useFactory: (
    codeWork: TurnHandlerList,
    workChat: TurnHandlerList,
    reminders: TurnHandlerList,
    feedback: TurnHandlerList,
  ): TurnHandlerList => [...codeWork, ...workChat, ...reminders, ...feedback],
  inject: [CODE_WORK_TURN_HANDLERS, WORK_CHAT_TURN_HANDLERS, REMINDER_TURN_HANDLERS, FEEDBACK_TURN_HANDLERS],
};
