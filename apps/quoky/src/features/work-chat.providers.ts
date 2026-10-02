import type { Provider } from '@nestjs/common';
import type { ConversationTurnHandler } from '@quoky/core';
import { WORK_CHAT_TURN_HANDLERS } from './feature-tokens';

/**
 * Chat-usable work integrations (ADR-0100) — feature composition (ADR-0096 D7).
 *
 * Starts empty: no turn handler is registered, so conversation behaviour is unchanged. WORK-T5 registers this
 * feature's handlers, services, lazy repository views and sink factories here, and only here.
 */
export const workChatProviders: Provider[] = [
  { provide: WORK_CHAT_TURN_HANDLERS, useValue: [] satisfies readonly ConversationTurnHandler[] },
];
