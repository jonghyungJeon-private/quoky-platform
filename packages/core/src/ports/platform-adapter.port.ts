import type {
  ApprovalDecision,
  ApprovalRequest,
  ConversationContext,
  InboundMessage,
  IsoTimestamp,
  OutboundMessage,
} from '../domain';

/**
 * The inbound side of a platform. Implementations translate native events
 * (Discord today, Telegram later) into normalized domain messages.
 */
export type InboundMessageHandler = (message: InboundMessage) => Promise<void>;
export type ApprovalDecisionHandler = (decision: ApprovalDecision) => Promise<void>;

/**
 * What a platform reports after delivering one {@link OutboundMessage} (ADR-0098 D3, additive): the platform ids of
 * every message it posted for that reply (text chunks, preview parts, attachments, notices), in posting order.
 * An adapter that cannot report ids may keep returning `void`.
 */
export interface OutboundDeliveryReceipt {
  readonly platformMessageIds: readonly string[];
}

/** An explicit owner rating of a delivered reply (ADR-0098 D3): 👍 is POSITIVE, 👎 is NEGATIVE. */
export type PlatformFeedbackRating = 'POSITIVE' | 'NEGATIVE';
/** `REMOVED` retracts an earlier `ADDED` of the same rating by the same user. */
export type PlatformFeedbackAction = 'ADDED' | 'REMOVED';

/**
 * A normalized feedback reaction (ADR-0098 D3). The adapter emits it only after its own admission gate (owner,
 * bot-authored target message, admitted location); it never carries message text.
 */
export interface PlatformFeedbackSignal {
  readonly platform: string;
  /** Where the rated message lives and who reacted (`userId` is the reacting user). */
  readonly context: ConversationContext;
  /** Platform id of the rated (bot-authored) message. */
  readonly targetPlatformMessageId: string;
  readonly rating: PlatformFeedbackRating;
  readonly action: PlatformFeedbackAction;
  readonly occurredAt: IsoTimestamp;
}

export type PlatformFeedbackHandler = (signal: PlatformFeedbackSignal) => Promise<void>;

/**
 * PORT: the user-facing surface. v1 implementation: DiscordPlatformAdapter.
 *
 * Boundary rule: NO platform-native type (e.g. Discord.js Message) may appear
 * in this interface. Everything is expressed in domain terms.
 */
export interface PlatformAdapter {
  /** Stable platform id, e.g. "discord". */
  readonly platform: string;

  /** Connect/login and begin receiving events. */
  start(): Promise<void>;
  /** Disconnect gracefully. */
  stop(): Promise<void>;

  /** Register the handler the core uses to receive normalized messages. */
  onMessage(handler: InboundMessageHandler): void;
  /** Register the handler invoked when a user approves/denies an action. */
  onApprovalDecision(handler: ApprovalDecisionHandler): void;

  /**
   * Optional (ADR-0098 D3): register the handler invoked for an admitted feedback reaction. A platform without a
   * feedback surface omits it. The handler never sends a message in response.
   */
  onFeedback?(handler: PlatformFeedbackHandler): void;

  /**
   * Send a normalized reply; the adapter renders artifacts natively. May return a delivery receipt with the
   * posted platform message ids (ADR-0098 D3); `void` remains valid for adapters that cannot report them.
   */
  sendMessage(message: OutboundMessage): Promise<void | OutboundDeliveryReceipt>;
  /** Optional UX nicety: show a typing/working indicator. */
  sendTyping(context: ConversationContext): Promise<void>;
  /** Render an approval prompt (e.g. buttons) for a HIGH/CRITICAL action. */
  requestApproval(request: ApprovalRequest, context: ConversationContext): Promise<void>;
}
