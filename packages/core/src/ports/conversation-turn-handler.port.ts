import type {
  ActionWriteCondition,
  Actor,
  Id,
  InboundMessage,
  IsoTimestamp,
  MessageBody,
  OutboundMessage,
  Session,
  WorkspaceRef,
} from '../domain';
// Type-only: the summarize payload is the bounded, untrusted readout WORK-T3 defines next to the work grammar
// (ADR-0100 D8). Erased at compile time, so the port module has no runtime dependency on the application layer.
import type { ExternalWorkReadout } from '../application/work-chat/external-work-readout';
// Type-only, like the readout above: the bounded untrusted readout of one personal item the owner asked to summarize
// (ADR-0118 D7, GML-1), plain data.
import type { UntrustedDocumentReadout } from '../application/untrusted-document-readout';
// Type-only, like the readout above: the parsed connector-write request (ADR-0112 D5), plain data.
import type { ConnectorWriteDraft } from '../application/connector-writes/connector-write-draft';
// Type-only, like the readouts above: the closed natural-language catalog and a validated selection (ADR-0120), plain data.
import type { NlActionReceipt, NlCatalogEntry, NlClassBProbe, NlGrammarSelection, NlListingReceipt, NlSelectedCommand } from '../application/nl-routing/catalog';
// Type-only, like the catalog above: the closed ADR-0122 capability groups (plain string ids).
import type { SurfaceGroupId } from '../application/surface-grants/surface-groups';

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
  /**
   * ADR-0120 amendment A2: true only when `QUOKY_NL_GRAMMAR_YIELD=on`, selection is `active` and would run for this turn
   * (same provider family, no pending approval). A Class B listing grammar may then decline a message with a qualifier it
   * cannot express. Absent or false: every grammar behaves exactly as before.
   */
  readonly grammarYield?: boolean;
  /** The active project's workspace, opened lazily on request; `null` when there is none or it cannot open. */
  resolveActiveWorkspace(): Promise<WorkspaceRef | null>;
  /**
   * ADR-0120 amendment A6-D3: present only on an A6 action dispatch. The handler passes it with every state write
   * (create, complete, cancel, reopen, reactivate) to the store, which evaluates it atomically with the write: while the
   * persisted kill switch is stopped nothing is written, whatever happened since dispatch.
   */
  readonly nlActionWriteCondition?: ActionWriteCondition;
}

/**
 * ADR-0120 amendment A4 (S1): the only fields a Class B probe may read — the owner's message, the turn's clock and the A2
 * yield flag. No session, actor, anchor or workspace, so a probe cannot depend on (or touch) conversation state.
 */
export type TurnHandlerProbeContext = Pick<TurnHandlerContext, 'message' | 'now' | 'grammarYield'>;

/**
 * ADR-0122 D2.1: the capability groups a handler would answer this message under. Every listed group must pass the
 * surface gate before `handle()` runs (a connector write lists `writes` and the service's read group).
 * `onDeny: 'reply'` ends the turn with the fixed denial copy; `'skip'` (hint-only claims such as `todo.hint`, or a claim
 * `handle()` may still decline) lets the turn continue to the next handler as if this one returned `null`.
 */
export interface SurfaceClaim {
  readonly groups: readonly [SurfaceGroupId, ...SurfaceGroupId[]];
  readonly onDeny: 'reply' | 'skip';
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
  /**
   * ADR-0120 follow-up: set by a handler that owns a catalog entry when this deterministic grammar reply is a listing the
   * entry also expresses (the reverse of `handleSelected`). The runtime records it as the structural `lastSelection`, so
   * "그 중에 …" refines this listing. Absent: the reply has no catalog equivalent and the runtime clears `lastSelection`.
   */
  readonly nlSelection?: NlGrammarSelection;
  /**
   * ADR-0120 amendment A6-D2/D3: the local write this reply reports (an A6 selection or an anchored Class A command),
   * content-free. The runtime records `quoky.lastAction` and the echo label from it, only while `QUOKY_NL_ACTIONS` is
   * not `off`. Never changes the reply.
   */
  readonly nlAction?: NlActionReceipt;
  /** A6-D2: the to-do or reminder listing this reply shows (labels and ids only), recorded like `nlAction`. */
  readonly nlListing?: NlListingReceipt;
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
  /**
   * Untrusted external data; rendered for the prompt as NON_AUTHORITATIVE_BACKGROUND only. An external-work readout
   * (ADR-0100 D8) or, widened by type only (ADR-0118 D7), the readout of one personal item the owner explicitly asked
   * to summarize — its summary turn is self-contained and SHORT_TERM history keeps a fixed note instead of the summary.
   */
  readonly readout: ExternalWorkReadout | UntrustedDocumentReadout;
  /** The deterministic list, used whenever summarization does not produce a reply (neutral content, PLT-0). */
  readonly fallbackText: MessageBody;
  /** Deterministic source links and the disclosure line, appended to a successful summary (neutral content, PLT-0). */
  readonly footer: MessageBody;
  /** As on `TurnHandlerReply`: the catalog equivalent of this deterministic lookup (ADR-0120 follow-up). */
  readonly nlSelection?: NlGrammarSelection;
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
  /**
   * The natural-language catalog entries this handler owns and can serve right now (ADR-0120 D1): only entries of a
   * registered and configured source. Read on every selection turn (it may be a getter). Absent: no entry.
   */
  readonly catalog?: readonly NlCatalogEntry[];
  handle(ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null>;
  /**
   * Serve one validated natural-language selection of an entry in `catalog` (ADR-0120 interfaces): map it to the
   * handler's existing typed command and return the same reply variants `handle` may return, under the same rules (no
   * provider, no Task, no approval; the handler enforces its own DM-only rule). `null` lets the turn continue to chat.
   */
  handleSelected?(command: NlSelectedCommand, ctx: TurnHandlerContext): Promise<TurnHandlerOutcome | null>;
  /**
   * ADR-0120 D6 Phase C (S1): whether one of this handler's frozen Class B grammars would answer this message, and with
   * which catalog equivalent — synchronous and pure: no read, no write, no provider, no state change. The runtime asks
   * it only when Phase C is on; then a hit runs selection first and `handle` is called only as the fallback when the
   * selector is unavailable. Class A branches (anchored commands, writes, item summaries, usage hints) return `null`, so
   * `handle` answers them exactly as before. Absent: the handler has no Class B grammar.
   */
  classBProbe?(ctx: TurnHandlerProbeContext): NlClassBProbe | null;
  /**
   * ADR-0122 D2.1: the twin of `classBProbe` — synchronous and pure (no read, no write, no provider): the groups this
   * handler would answer the message under, or `null` when it would not claim it. Reuses the handler's own pure parser.
   * The runtime asks it before `handle()` in a channel while `QUOKY_CHANNEL_GRANTS=enforce`; a denied claim never reaches
   * `handle()`. Fail closed: in a channel a non-null outcome without a claim is replaced by the denial copy and logged as a
   * defect. Every registered handler implements it (registry test).
   */
  surfaceClaim?(ctx: TurnHandlerProbeContext): SurfaceClaim | null;
}
