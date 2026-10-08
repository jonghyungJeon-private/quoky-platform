import type {
  ApprovalDecisionHandler,
  ApprovalRequest,
  ConversationContext,
  InboundMessageHandler,
  Logger,
  NotificationSink,
  NotificationSinkOutcome,
  OutboundDeliveryReceipt,
  OutboundMessage,
  OwnerNotification,
  PlatformAdapter,
  PlatformFeedbackHandler,
} from '@quoky/core';
import { isConnectedIdentityReader, isInboundGateTarget } from '../ops/startup-identity-check';
import type { ConnectedIdentityFacts } from '../ops/startup-identity-check';

/**
 * ADR-0114 D6: one `PlatformAdapter` over several platform adapters, built only by the composition root. Core keeps its
 * single `PLATFORM_ADAPTER` token and sees the unchanged contract; `platform` stays opaque data it never branches on.
 *
 * - Inbound: every child gets the same message, approval-decision and feedback handlers, so turns from every platform
 *   reach the runtime through one path (and the composition root's identity gate wraps them all).
 * - Outbound: `sendMessage`, `sendTyping` and `requestApproval` are routed by `context.platform` to the child of that
 *   platform; a context of no composed platform is refused (nothing is sent), never sent to another platform.
 * - Adapter-local capabilities (not part of `PlatformAdapter`) are forwarded explicitly: the ADR-0102 D5 inbound gate
 *   to every child that takes one; the Discord identity reader to the PRIMARY child. Owner notifications are routed
 *   by kind and `target.platform` (see {@link CompositePlatformAdapter.deliver}; ADR-0114 D11).
 * - Lifecycle: children start in order (primary first); when one fails, the ones already started are stopped and the
 *   error is rethrown unchanged (a typed startup refusal keeps its code). Stop runs in reverse order.
 */
export class CompositePlatformAdapter implements PlatformAdapter, NotificationSink {
  readonly platform: string;
  private readonly children: readonly PlatformAdapter[];

  constructor(
    private readonly primary: PlatformAdapter,
    others: readonly PlatformAdapter[],
    private readonly logger: Logger,
  ) {
    this.children = [primary, ...others];
    const ids = this.children.map((child) => child.platform);
    if (new Set(ids).size !== ids.length) throw new Error('COMPOSITE_PLATFORM_DUPLICATE');
    this.platform = ids.join('+');
  }

  /** The composed platform ids, primary first. */
  get platforms(): readonly string[] {
    return this.children.map((child) => child.platform);
  }

  /** The composed adapter of `platform` (composition-root and acceptance use; Core never sees it). */
  adapterFor(platform: string): PlatformAdapter | undefined {
    return this.childFor(platform);
  }

  private childFor(platform: string): PlatformAdapter | undefined {
    return this.children.find((child) => child.platform === platform);
  }

  async start(): Promise<void> {
    const started: PlatformAdapter[] = [];
    for (const child of this.children) {
      try {
        await child.start();
        started.push(child);
      } catch (err) {
        for (const done of started.reverse()) await done.stop().catch(() => undefined);
        throw err;
      }
    }
  }

  async stop(): Promise<void> {
    for (const child of [...this.children].reverse()) await child.stop().catch(() => undefined);
  }

  onMessage(handler: InboundMessageHandler): void {
    for (const child of this.children) child.onMessage(handler);
  }

  onApprovalDecision(handler: ApprovalDecisionHandler): void {
    for (const child of this.children) child.onApprovalDecision(handler);
  }

  onFeedback(handler: PlatformFeedbackHandler): void {
    for (const child of this.children) child.onFeedback?.(handler);
  }

  async sendMessage(message: OutboundMessage): Promise<void | OutboundDeliveryReceipt> {
    const child = this.childFor(message.context.platform);
    if (!child) {
      this.logger.warn('send refused: platform not composed', { platform: message.context.platform });
      return { platformMessageIds: [] };
    }
    return child.sendMessage(message);
  }

  async sendTyping(context: ConversationContext): Promise<void> {
    await this.childFor(context.platform)?.sendTyping(context);
  }

  async requestApproval(request: ApprovalRequest, context: ConversationContext): Promise<void> {
    const child = this.childFor(context.platform);
    if (!child) throw new Error('PLATFORM_NOT_COMPOSED');
    await child.requestApproval(request, context);
  }

  /** ADR-0102 D5 (adapter-local): every child that holds adapter-side inbound effects waits for the same gate. */
  gateInbound(gate: Promise<boolean>): void {
    for (const child of this.children) if (isInboundGateTarget(child)) child.gateInbound(gate);
  }

  /** ADR-0102 D5 (adapter-local): the primary (Discord) identity facts; each other child checks its own at start. */
  async readConnectedIdentity(
    channelIds: readonly string[],
    options?: { readonly readyTimeoutMs?: number },
  ): Promise<ConnectedIdentityFacts> {
    if (!isConnectedIdentityReader(this.primary)) throw new Error('PLATFORM_IDENTITY_UNSUPPORTED');
    return this.primary.readConnectedIdentity(channelIds, options);
  }

  /**
   * ADR-0114 D11 (CA P1-1): owner notifications are routed.
   * - `OPS_DECISION_RESULT` (and the `OPS_NOTICE` health notices, which travel as a `BRIEF` addressed to the primary
   *   platform) always go to the PRIMARY (Discord), whatever the target says.
   * - `TEXT` reminders and the `BRIEF` go to the child whose platform is `target.platform`: a reminder is delivered
   *   where it was created. That child's own sink rechecks owner and target.
   * - A platform that is not composed, or a child without a sink, is `NOT_SENT TARGET_NOT_ADMITTED` (never re-routed).
   */
  async deliver(notification: OwnerNotification): Promise<NotificationSinkOutcome> {
    const child = notification.kind === 'OPS_DECISION_RESULT' ? this.primary : this.childFor(notification.target.platform);
    const sink = child as Partial<NotificationSink> | undefined;
    if (!child || typeof sink?.deliver !== 'function') return { status: 'NOT_SENT', reason: 'TARGET_NOT_ADMITTED', retryable: false };
    return sink.deliver.call(child, notification);
  }
}
