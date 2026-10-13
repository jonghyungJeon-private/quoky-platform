import type { ConversationContext, Id } from '../domain';
import type { TurnResult } from './conversation-runtime';

/**
 * A delivered turn as the platform-entry facade saw it (ADR-0118 amendment of 2026-10-12, GML-2): which inbound message
 * it answered (its id and conversation context only — never its text or attachments), the session it ran in, its status
 * and the platform ids the adapter reported for the reply (ADR-0098 D3 delivery receipt). Plain data: no reply text.
 */
export interface DeliveredTurn {
  readonly messageId: Id;
  readonly context: ConversationContext;
  readonly sessionId: Id;
  readonly status: TurnResult['status'];
  readonly platformMessageIds: readonly string[];
}

/**
 * An application-level hook `QuokyCore` calls after a reply was delivered with a receipt (not a port, and not part of
 * `ConversationTurnHandler`). The composition root registers each observer explicitly (today: the mail handler, which
 * binds its listing replies to their platform ids so a later platform reply to a listing picks from that listing).
 * Best-effort: it must never throw into the turn, never send a message and never change the reply (it runs after
 * delivery).
 */
export interface TurnDeliveryObserver {
  observeDelivery(turn: DeliveredTurn): Promise<void>;
}
