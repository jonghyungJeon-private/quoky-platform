import type { Provider } from '@nestjs/common';
import {
  CONVERSATION_TURN_HANDLERS,
  TURN_HANDLER_STAGES,
  createHelpIntentTurnHandler,
  type ConnectorWriteFlow,
  type ConversationTurnHandler,
} from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import {
  CODE_WORK_TURN_HANDLERS,
  FEEDBACK_TURN_HANDLERS,
  REMINDER_TURN_HANDLERS,
  WORK_CHAT_TURN_HANDLERS,
} from './feature-tokens';
import { CALENDAR_TURN_HANDLERS } from './calendar.providers';
import { CONNECTOR_WRITE_FLOW } from './connector-writes.providers';
import { MEMORY_TURN_HANDLERS } from './memory.providers';
import { MODEL_SELECTION_TURN_HANDLERS } from './provider-selection.providers';

type TurnHandlerList = readonly ConversationTurnHandler[];

/**
 * The handlers' contributed help lines in dispatch order — `(stage, order, id)`, stages in `TURN_HANDLER_STAGES`
 * order, ids by code unit — the same order `ConversationRuntime` lists them in the full help reply (ADR-0096 D6).
 */
function contributedHelpLinesOf(handlers: TurnHandlerList): readonly string[] {
  const stageIndex = (handler: ConversationTurnHandler) => TURN_HANDLER_STAGES.indexOf(handler.stage);
  return [...handlers]
    .sort(
      (a, b) =>
        stageIndex(a) - stageIndex(b) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .flatMap((handler) => handler.helpLines ?? []);
}

/**
 * Binds the Core `CONVERSATION_TURN_HANDLERS` token to the concatenation of the feature handler lists (ADR-0096 D7:
 * code work, work chat, reminders, feedback, the ADR-0106 memory commands at `pre-classify` order 50 and the ADR-0110
 * calendar handler at `pre-classify` order 150 — an empty list when no calendar is configured, ADR-0110 D5, and the
 * owner's model-selection command at `pre-classify` order 70 — ADR-0092 amendment, runtime switching) plus the
 * help-intent handler (ADR-0104 D4: `pre-classify`, order 400, after work lookups and before the classifier; LLM-1
 * ships the module, the composition root registers it). The concatenation order carries no meaning:
 * `ConversationRuntime` rejects duplicate ids and dispatches by `(stage, order, id)` (ADR-0096 D2/D5).
 *
 * The help-intent handler answers from the help lines of the final, fully-registered list plus the connector-write
 * flow's lines (a getter, so it always sees exactly what the full help reply lists, in the runtime's order — DET-2:
 * a capability question is answered with that full text); it ignores its own line for topic answers.
 */
export const turnHandlersProvider: Provider = {
  provide: CONVERSATION_TURN_HANDLERS,
  useFactory: (
    codeWork: TurnHandlerList,
    workChat: TurnHandlerList,
    reminders: TurnHandlerList,
    feedback: TurnHandlerList,
    memory: TurnHandlerList,
    calendar: TurnHandlerList,
    modelSelection: TurnHandlerList,
    connectorWriteFlow: Pick<ConnectorWriteFlow, 'helpLines'> | null | undefined,
  ): TurnHandlerList => {
    const registered: ConversationTurnHandler[] = [
      ...codeWork,
      ...workChat,
      ...reminders,
      ...feedback,
      ...memory,
      ...calendar,
      ...modelSelection,
    ];
    registered.push(
      createHelpIntentTurnHandler({
        helpLines: () => [...contributedHelpLinesOf(registered), ...(connectorWriteFlow?.helpLines ?? [])],
        logger: new ConsoleLogger('help-intent'),
      }),
    );
    return registered;
  },
  inject: [
    CODE_WORK_TURN_HANDLERS,
    WORK_CHAT_TURN_HANDLERS,
    REMINDER_TURN_HANDLERS,
    FEEDBACK_TURN_HANDLERS,
    MEMORY_TURN_HANDLERS,
    CALENDAR_TURN_HANDLERS,
    MODEL_SELECTION_TURN_HANDLERS,
    // Optional: a composition without the connector-write providers (feature tests) has no write lines to add.
    { token: CONNECTOR_WRITE_FLOW, optional: true },
  ],
};
