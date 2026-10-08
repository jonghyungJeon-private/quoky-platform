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
}

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
