import type {
  Actor,
  Id,
  InboundMessage,
  IsoTimestamp,
  OutboundMessage,
  Session,
  WorkspaceRef,
} from '../domain';
// Type-only: the summarize payload is the bounded, untrusted readout WORK-T3 defines next to the work grammar
// (ADR-0100 D8). Erased at compile time, so the port module has no runtime dependency on the application layer.
import type { ExternalWorkReadout } from '../application/work-chat/external-work-readout';
// Type-only, like the readout above: the parsed connector-write request (ADR-0112 D5), plain data.
import type { ConnectorWriteDraft } from '../application/connector-writes/connector-write-draft';

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

/**
 * Everything here is a deeply-frozen plain-data COPY taken at dispatch time (ADR-0096 D1) — never the runtime's
 * own message/session/actor objects. Mutating it throws in strict mode and has no effect on the turn otherwise;
 * `resolveActiveWorkspace` is bound to the session's active project as it was at dispatch.
 */
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

/** A deterministic reply: the handler's text is the turn's reply (the default variant, `kind` may be omitted). */
export interface TurnHandlerReply {
  readonly kind?: 'reply';
  readonly reply: OutboundMessage;
  /** Defaults to `RESPONDED`. */
  readonly status?: 'RESPONDED' | 'FAILED';
  /**
   * What the SHORT_TERM conversation history keeps for this turn instead of the verbatim texts (ADR-0106 D5, W2-L01):
   * `user` replaces the already-recorded inbound text, `assistant` is recorded instead of `reply.text`. Omitted fields
   * are recorded verbatim. Ignored at `control`, which records nothing.
   */
  readonly history?: { readonly user?: string; readonly assistant?: string };
}

/**
 * The only provider-reaching handler outcome (ADR-0096 D4, ADR-0100 D8). The handler itself never calls a provider:
 * the runtime runs its existing work-turn path with `Capability.SUMMARIZATION` over the bounded, sanitized
 * `readout` (provider selection, Task/TaskRun creation and audit stay where they are) and appends `footer` to a
 * successful summary. On any other result — no provider, a provider failure, a readout that fails re-validation,
 * or a dispatch stage that must stay provider-free (`control`) — the reply is `fallbackText`.
 */
export interface TurnHandlerSummarizeReply {
  readonly kind: 'summarize';
  /** Untrusted external data; rendered for the prompt as NON_AUTHORITATIVE_BACKGROUND only. */
  readonly readout: ExternalWorkReadout;
  /** The deterministic list, used whenever summarization does not produce a reply. */
  readonly fallbackText: string;
  /** Deterministic source links and the disclosure line, appended to a successful summary. */
  readonly footer: string;
}

/**
 * A parsed connector-write request (ADR-0112 D5, ADR-0110 amendment; CWR-2). The handler itself creates no approval
 * and makes no write (ADR-0096 D4): the runtime hands `draft` to its optional `connectorWriteFlow`, which builds the
 * exact payload, the deterministic preview and the one-time CRITICAL approval. When the flow is absent, or has no
 * writer for this draft (writes are off), or the stage must stay approval-free (`control`), the reply is
 * `fallbackText` — the handler's own fixed "writes are off" copy.
 */
export interface TurnHandlerWriteDraft {
  readonly kind: 'write-draft';
  readonly draft: ConnectorWriteDraft;
  readonly fallbackText: string;
  /** As on `TurnHandlerReply`: what SHORT_TERM history keeps instead of the reply text (e.g. a fixed calendar note). */
  readonly history?: { readonly assistant?: string };
}

/**
 * What one handler returns for a turn it claims (ADR-0096 D1 `TurnHandlerReply`, plus the ADR-0100 summarize and the
 * ADR-0112 write-draft variants).
 */
export type TurnHandlerOutcome = TurnHandlerReply | TurnHandlerSummarizeReply | TurnHandlerWriteDraft;

/**
 * PORT: one deterministic conversational turn handler (ADR-0096). Registered statically in the composition root
 * under `CONVERSATION_TURN_HANDLERS`; the runtime only dispatches. A handler's state and mutation authority stay
 * with its owning capability service.
 *
 * Contract:
 *  - return `null` to fall through unchanged;
 *  - never call an `AiProvider` and never create a Task, TaskRun or ApprovalRequest (a `summarize` outcome asks the
 *    runtime to run its own SUMMARIZATION work path, a `write-draft` outcome asks it to run its connector-write flow;
 *    both are honoured at `post-anchor` / `pre-classify` only);
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
  handle(ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null>;
}
