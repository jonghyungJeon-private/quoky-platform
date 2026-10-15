import type {
  ConversationContext,
  Id,
  MessageContent,
  NotificationDeliveryOutcome,
  OwnerNotificationKind,
} from '../domain';

/**
 * PORT: owner notification delivery (ADR-0101 D4/D8; DI token `NOTIFICATION_SINK`).
 *
 * Domain types only; `PlatformAdapter` and its fakes are unchanged. The adapter owns the owner-only outbound
 * gate (rechecked at delivery time), the delivery target (owner DM by default; the originating allowlisted
 * channel only under the `QUOKY_REMINDERS_CHANNEL_DELIVERY` opt-in, `TEXT` only; `BRIEF` and ADR-0113's
 * `OPS_DECISION_RESULT` are always DM-only), mention policy and
 * outcome classification. `deliver` never throws for a delivery failure: it classifies it.
 */

export interface OwnerNotification {
  /** Correlates the delivery with the reminder occurrence in logs; never shown to the user. */
  correlationId: Id;
  /** The originating conversation; its `userId` is the owner the notification is addressed to. */
  target: ConversationContext;
  kind: OwnerNotificationKind;
  /** Plain, already-composed text (≤ `REMINDER_LIMITS.maxDeliveredTextChars`). */
  text: string;
  /**
   * PLT-0: the same notification as platform-neutral content when it carries a platform-rendered span (an untrusted
   * title, a conversation reference); `text` is its plain rendering and the adapter renders `content` instead.
   */
  content?: MessageContent;
  /**
   * ADR-0122 D2.6 (P2, Codex P1): a last-moment check for a CHANNEL send. An adapter that delivers to the originating
   * channel MUST perform the channel send only through `sendIfAllowed(send)` — after resolving the channel — which checks
   * the live grants and runs `send` while holding the caller's lock (a revoke waits until the send returns). When it
   * resolves `{sent: false}`, rejects before `send` started, or does not start `send` within the adapter's send deadline,
   * nothing goes to the channel and the adapter delivers `dm` (text, and `content` when present) to the owner DM instead.
   * Absent: unchanged. Never consulted for a DM send.
   */
  channelRecheck?: {
    sendIfAllowed<T>(send: () => Promise<T>): Promise<ChannelRecheckResult<T>>;
    readonly dm: { readonly text: string; readonly content?: MessageContent };
  };
}

/** The outcome of {@link OwnerNotification.channelRecheck}: the send ran (its value), or the channel was refused. */
export type ChannelRecheckResult<T> = { readonly sent: true; readonly value: T } | { readonly sent: false };

/**
 * Re-exported name of the delivery-outcome contract (defined in the domain because reminder transitions consume
 * it): `SENT{via}` = the platform confirmed the message was created; `NOT_SENT{reason, retryable}` = confirmed
 * not transmitted; `UNCERTAIN{reason}` = it may have been transmitted. When in doubt an adapter returns
 * `UNCERTAIN`. Only `NOT_SENT{retryable: true}` is ever retried.
 */
export type NotificationSinkOutcome = NotificationDeliveryOutcome;

export interface NotificationSink {
  /**
   * PLT-0 obligation: an adapter whose platform parses any markup MUST render `notification.content` with its own
   * `MessageMarkup` whenever it is present, and deliver (and length-check) that rendering — never `text`, which is the
   * plain rendering with untrusted spans verbatim and is safe only on a platform that parses no markup at all.
   */
  deliver(notification: OwnerNotification): Promise<NotificationSinkOutcome>;
}
