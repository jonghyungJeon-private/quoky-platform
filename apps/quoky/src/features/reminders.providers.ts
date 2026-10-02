import type { Provider } from '@nestjs/common';
import type { ConversationTurnHandler } from '@quoky/core';
import { REMINDER_TURN_HANDLERS } from './feature-tokens';

/**
 * Proactive owner reminders (ADR-0101) — feature composition (ADR-0096 D7).
 *
 * Starts empty: no turn handler is registered, so conversation behaviour is unchanged. PRO-5 registers this
 * feature's handlers, services, lazy repository views and sink factories here, and only here.
 */
export const remindersProviders: Provider[] = [
  { provide: REMINDER_TURN_HANDLERS, useValue: [] satisfies readonly ConversationTurnHandler[] },
];
