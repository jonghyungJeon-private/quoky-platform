import type {
  Actor,
  Id,
  InboundMessage,
  IsoTimestamp,
  OutboundMessage,
  Session,
  WorkspaceRef,
} from '../domain';

/**
 * The three fixed dispatch points in `ConversationRuntime.handleInner` (ADR-0096 D3):
 *  - `control` — right after the help/reset branch, before short-term memory capture; runs in every state,
 *    including a pending approval. Handlers here must be read-only and provider-free.
 *  - `post-anchor` — after the last `*_PENDING` approval intercept and before the ADR-0043 deny-fragment check.
 *  - `pre-classify` — after the `기억해:` block and before the intent classifier.
 *
 * The declaration order of `TURN_HANDLER_STAGES` is the dispatch order and the primary registry sort key.
 */
export const TURN_HANDLER_STAGES = ['control', 'post-anchor', 'pre-classify'] as const;
export type TurnHandlerStage = (typeof TURN_HANDLER_STAGES)[number];

/**
 * Read-only snapshot of the conversation's apply-preview anchor at dispatch time (ADR-0096 D1). `status` is the
 * anchor's status value as a plain string; a handler never receives, mutates or re-anchors the anchor itself.
 */
export interface TurnHandlerAnchorSnapshot {
  readonly status: string;
  readonly workspaceRef?: WorkspaceRef;
  readonly projectId?: Id;
}

export interface TurnHandlerContext {
  readonly message: InboundMessage;
  readonly session: Session;
  readonly actor: Actor;
  /** The runtime's shared clock reading for this turn. */
  readonly now: IsoTimestamp;
  readonly applyAnchor: TurnHandlerAnchorSnapshot | null;
  /** The active project's workspace, opened lazily on request; `null` when there is none or it cannot open. */
  resolveActiveWorkspace(): Promise<WorkspaceRef | null>;
}

export interface TurnHandlerReply {
  readonly reply: OutboundMessage;
  /** Defaults to `RESPONDED`. */
  readonly status?: 'RESPONDED' | 'FAILED';
}

/**
 * PORT: one deterministic conversational turn handler (ADR-0096). Registered statically in the composition root
 * under `CONVERSATION_TURN_HANDLERS`; the runtime only dispatches. A handler's state and mutation authority stay
 * with its owning capability service.
 *
 * Contract:
 *  - return `null` to fall through unchanged;
 *  - never call an `AiProvider` and never create a Task, TaskRun or ApprovalRequest;
 *  - catch its own errors (a leaked exception reaches the runtime's generic `handle` backstop).
 *
 * The registry rejects duplicate `id`s and sorts by `(stage, order, id)`.
 */
export interface ConversationTurnHandler {
  readonly id: string;
  readonly stage: TurnHandlerStage;
  readonly order: number;
  /** Lines contributed to the help reply (ADR-0096 D6), in registry order; bounded by the composer. */
  readonly helpLines?: readonly string[];
  handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null>;
}
