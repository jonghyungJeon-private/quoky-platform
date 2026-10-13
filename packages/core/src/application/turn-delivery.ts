import type { Id, InboundMessage } from '../domain';

/**
 * A delivered turn as the platform-entry facade saw it (ADR-0118 amendment of 2026-10-12, GML-2): the inbound message,
 * the session it ran in, its status and the platform ids the adapter reported for the reply (ADR-0098 D3 delivery
 * receipt). Plain data: no reply text.
 */
export interface DeliveredTurn {
  readonly message: InboundMessage;
  readonly sessionId: Id;
  readonly status: string;
  readonly platformMessageIds: readonly string[];
}

/**
 * An application-level hook `QuokyCore` calls after a reply was delivered with a receipt (not a port, and not part of
 * `ConversationTurnHandler`). The mail handler uses it to bind its listing replies to their platform ids, so a later
 * platform reply to a listing picks from that listing. Best-effort: it must never throw into the turn, never send a
 * message and never change or delay the reply (it runs after delivery).
 */
export interface TurnDeliveryObserver {
  observeDelivery(turn: DeliveredTurn): Promise<void>;
}

/** Whether `value` implements {@link TurnDeliveryObserver} (the composition root filters its handlers with it). */
export function isTurnDeliveryObserver<T>(value: T): value is T & TurnDeliveryObserver {
  return typeof value === 'object' && value !== null && typeof (value as { observeDelivery?: unknown }).observeDelivery === 'function';
}
