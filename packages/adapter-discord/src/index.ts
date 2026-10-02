import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { Message } from 'discord.js';
import { NotImplementedError, now } from '@quoky/core';
import { deliverPreview, deliverWithNotice, FILE_ATTACHMENT_CHUNK_THRESHOLD } from './delivery';

export {
  chunkText,
  deliverChunks,
  deliverWithNotice,
  DISCORD_SAFE_LIMIT,
  FILE_ATTACHMENT_CHUNK_THRESHOLD,
  PARTIAL_FAILURE_NOTICE,
} from './delivery';
export type { DeliveryReport, ChunkSender } from './delivery';
import type {
  ApprovalDecisionHandler,
  ApprovalRequest,
  ConversationContext,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  OutboundMessage,
  PlatformAdapter,
} from '@quoky/core';

export interface DiscordConfig {
  token: string;
  /** If set, ignore messages from other guilds (useful for local dev). */
  guildId?: string;
  /**
   * Personal-edition admission gate (ADR-0091). Only messages authored by one of these Discord user ids are
   * admitted. Fail closed: an empty list admits nobody. Provided by the composition root; Core never sees it.
   */
  ownerIds: readonly string[];
  /**
   * Guild channel ids where owner messages are admitted; a thread is admitted when its own id or its parent
   * channel id is listed. Empty/absent admits owner direct messages only.
   */
  channelIds?: readonly string[];
}

/** Discord typing indicator lasts ~10s; refresh under that while we work. */
const TYPING_REFRESH_MS = 8_000;
/** Safety cap so a typing loop can never leak (≈ covers the 120s CLI timeout). */
const TYPING_MAX_TICKS = 16;

/**
 * PlatformAdapter for Discord. discord.js types stay INSIDE this file; only
 * normalized domain messages cross back into the core.
 *
 * Sprint 1a: receive / send / typing are implemented. `requestApproval` is out
 * of scope (no approval UI yet) and remains unimplemented.
 *
 * Note: reading message text requires the privileged **Message Content Intent**
 * to be enabled for the bot in the Discord Developer Portal.
 */
export class DiscordPlatformAdapter implements PlatformAdapter {
  readonly platform = 'discord';

  private client?: Client;
  private messageHandler?: InboundMessageHandler;
  private approvalHandler?: ApprovalDecisionHandler;
  /** Active self-refreshing typing loops, keyed by target channel/thread id. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly config: DiscordConfig,
    private readonly logger: Logger,
  ) {}

  onMessage(handler: InboundMessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalDecision(handler: ApprovalDecisionHandler): void {
    this.approvalHandler = handler;
  }

  async start(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        // ADR-0091: owner direct messages. DM channels arrive uncached, so the Channel partial is required.
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.client = client;

    client.on(Events.MessageCreate, (message) => {
      void this.handleMessageCreate(message);
    });

    await client.login(this.config.token);
  }

  async stop(): Promise<void> {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    await this.client?.destroy();
    this.client = undefined;
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    const target = message.context.threadId ?? message.context.channelId;
    // The response is arriving — stop the "is typing…" loop for this target.
    this.clearTyping(target);
    const channel = await this.fetchChannel(target);
    if (!channel?.isSendable()) {
      this.logger.warn('send skipped: channel not sendable', { channelId: target });
      return;
    }

    // F5-C/D/E (Sprint 4c-Follow-up-5): a complete structured preview is delivered LOSSLESSLY — ordered
    // multipart fenced messages, or a complete `.diff` attachment (in-memory Buffer; no temp file, so
    // nothing touches the workspace/sandbox). Observability is length-only (never raw diff content).
    if (message.preview) {
      const report = await deliverPreview(message.preview, {
        sendText: async (chunk) => {
          await channel.send(chunk);
        },
        sendAttachment: async (canonicalDiff, filename, caption) => {
          await channel.send({
            content: caption,
            files: [{ attachment: Buffer.from(canonicalDiff, 'utf8'), name: filename }],
          });
        },
        notify: async (notice) => {
          try {
            await channel.send(notice);
          } catch (err) {
            this.logger.warn('preview notice send failed', {
              channelId: target,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      });
      this.logger.info('preview delivered', {
        channelId: target,
        previewId: report.previewId,
        deliveryOutcome: report.outcome,
        deliveryMode: report.deliveryMode,
        partCount: report.partCount,
        deliveredPartCount: report.deliveredPartCount,
        attachmentFallbackUsed: report.attachmentFallbackUsed,
        canonicalDiffLength: report.canonicalDiffLength,
      });
      if (report.outcome === 'DELIVERY_FAILED') {
        this.logger.error('preview delivery failed', { channelId: target, previewId: report.previewId, deliveryMode: report.deliveryMode });
      }
      return;
    }

    const report = await deliverWithNotice(
      message.text,
      async (chunk) => {
        await channel.send(chunk);
      },
      async (notice) => {
        // Single best-effort notice; if it also fails, log only (ADR-0016).
        try {
          await channel.send(notice);
        } catch (err) {
          this.logger.warn('partial-failure notice send failed', {
            channelId: target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    if (!report.ok) {
      // Send failure (ADR-0016): record + log (masked). Partial delivery is reported,
      // not retried, to avoid duplicate messages. The AI run itself is unaffected.
      this.logger.error('message delivery failed', {
        channelId: target,
        sent: report.sent,
        totalChunks: report.totalChunks,
        error: report.error,
      });
      return;
    }
    if (report.totalChunks > 1) {
      this.logger.info('message delivered in chunks', {
        channelId: target,
        chunks: report.totalChunks,
        fileAttachmentThresholdHit: report.totalChunks > FILE_ATTACHMENT_CHUNK_THRESHOLD,
      });
    }
  }

  async sendTyping(context: ConversationContext): Promise<void> {
    const target = context.threadId ?? context.channelId;
    await this.pumpTyping(target);

    // Keep "is typing…" alive during long runs by refreshing under the ~10s TTL.
    // Cleared by the next sendMessage to this target, or after a safety cap.
    if (!this.typingTimers.has(target)) {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (ticks >= TYPING_MAX_TICKS) {
          this.clearTyping(target);
          return;
        }
        void this.pumpTyping(target);
      }, TYPING_REFRESH_MS);
      timer.unref?.();
      this.typingTimers.set(target, timer);
    }
  }

  /** Send a single Discord typing indicator for a target (best-effort). */
  private async pumpTyping(target: string): Promise<void> {
    const channel = await this.fetchChannel(target);
    if (channel && channel.isTextBased() && 'sendTyping' in channel) {
      await channel.sendTyping().catch(() => undefined);
    }
  }

  /** Stop the refreshing typing loop for a target, if any. */
  private clearTyping(target: string): void {
    const timer = this.typingTimers.get(target);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(target);
    }
  }

  async requestApproval(_request: ApprovalRequest, _context: ConversationContext): Promise<void> {
    // Out of scope for Sprint 1a (no approval UI yet). See ADR-0010 / risk policy.
    void this.approvalHandler;
    throw new NotImplementedError('DiscordPlatformAdapter.requestApproval');
  }

  private async handleMessageCreate(message: Message): Promise<void> {
    try {
      if (message.author.bot) return;
      if (this.config.guildId && message.guildId && message.guildId !== this.config.guildId) {
        return;
      }
      // ADR-0091: silent drop BEFORE the handler/InboundMessage — no reply, no log of the author or content.
      if (!this.isAdmitted(message)) return;
      const handler = this.messageHandler;
      if (!handler) return;
      this.logger.info('message received', {
        messageId: message.id,
        channelId: message.channelId,
        userId: message.author.id,
      });
      await handler(this.toInbound(message));
    } catch (err) {
      this.logger.error('message handling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Owner-only entry gate (ADR-0091). Admits an owner's direct message (no guild) or an owner's message in an
   * allowlisted guild channel, or in a thread whose own id or parent channel id is allowlisted.
   */
  private isAdmitted(message: Message): boolean {
    if (!this.config.ownerIds.includes(message.author.id)) return false;
    if (message.guildId === null) return true; // direct message
    const channelIds = this.config.channelIds ?? [];
    if (channelIds.includes(message.channelId)) return true;
    const channel = message.channel;
    return channel.isThread() && channel.parentId !== null && channelIds.includes(channel.parentId);
  }

  /** Translate a Discord Message into a normalized InboundMessage. */
  private toInbound(message: Message): InboundMessage {
    const inThread = message.channel.isThread();
    const channelId = inThread ? (message.channel.parentId ?? message.channelId) : message.channelId;
    const threadId = inThread ? message.channelId : undefined;

    const context: ConversationContext = {
      platform: this.platform,
      channelId,
      userId: message.author.id,
      ...(message.guildId ? { spaceId: message.guildId } : {}),
      ...(threadId ? { threadId } : {}),
    };

    return {
      id: message.id,
      context,
      text: message.content,
      receivedAt: now(),
    };
  }

  private async fetchChannel(id: string) {
    if (!this.client) return null;
    return this.client.channels.fetch(id).catch(() => null);
  }
}
