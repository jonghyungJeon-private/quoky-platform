import type { Provider } from '@nestjs/common';
import type { ConversationTurnHandler } from '@quoky/core';
import { FEEDBACK_TURN_HANDLERS } from './feature-tokens';

/**
 * Answer-feedback summary (ADR-0098) — feature composition (ADR-0096 D7).
 *
 * Starts empty: no turn handler is registered, so conversation behaviour is unchanged. QUAL-4 registers this
 * feature's handlers, services, lazy repository views and sink factories here, and only here.
 */
export const feedbackProviders: Provider[] = [
  { provide: FEEDBACK_TURN_HANDLERS, useValue: [] satisfies readonly ConversationTurnHandler[] },
];
