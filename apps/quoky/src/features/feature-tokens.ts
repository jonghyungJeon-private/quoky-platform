/**
 * App-local composition tokens for the Personal v2 feature tracks (ADR-0096 D7).
 *
 * Each token carries one feature's `readonly ConversationTurnHandler[]`, bound by that feature's own
 * `features/<feature>.providers.ts`; `turn-handlers.providers.ts` concatenates them into the Core
 * `CONVERSATION_TURN_HANDLERS` token. Registration is static code in the composition root — no manifest,
 * discovery or runtime loading. This file is never edited after wave 1.
 */
export const CODE_WORK_TURN_HANDLERS = Symbol('CodeWorkTurnHandlers');
export const WORK_CHAT_TURN_HANDLERS = Symbol('WorkChatTurnHandlers');
export const REMINDER_TURN_HANDLERS = Symbol('ReminderTurnHandlers');
export const FEEDBACK_TURN_HANDLERS = Symbol('FeedbackTurnHandlers');
