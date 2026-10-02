import type { Provider } from '@nestjs/common';
import type { ConversationTurnHandler } from '@quoky/core';
import { CODE_WORK_TURN_HANDLERS } from './feature-tokens';

/**
 * Code-work branch commands (ADR-0099) — feature composition (ADR-0096 D7).
 *
 * Starts empty: no turn handler is registered, so conversation behaviour is unchanged. CODE-4 registers this
 * feature's handlers, services, lazy repository views and sink factories here, and only here.
 */
export const codeWorkProviders: Provider[] = [
  { provide: CODE_WORK_TURN_HANDLERS, useValue: [] satisfies readonly ConversationTurnHandler[] },
];
