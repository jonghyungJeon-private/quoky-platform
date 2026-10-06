import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import type { Message, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { NotImplementedError, now } from '@quoky/core';
import { deliverPreview, deliverWithNotice, FILE_ATTACHMENT_CHUNK_THRESHOLD } from './delivery';
import { DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS, deliverOwnerNotification } from './notification';
import type { NotificationChannel, NotificationSendOptions } from './notification';
import { isAdmittedReaction, toRating } from './reactions';
import { readConnectedIdentity } from './connected-identity';
import type { DiscordConnectedIdentity } from './connected-identity';
import { AttachmentIntake, renderAttachmentIntakeNote, summarizeAttachmentIntake } from './attachments';
import type { AttachmentIntakeOptions, AttachmentIntakeResult, AttachmentSource } from './attachments';

export {
  chunkText,
  deliverChunks,
  deliverWithNotice,
  DISCORD_SAFE_LIMIT,
  FILE_ATTACHMENT_CHUNK_THRESHOLD,
  PARTIAL_FAILURE_NOTICE,
} from './delivery';
export type { DeliveryReport, ChunkSender } from './delivery';
export {
  classifyDiscordError,
  deliverOwnerNotification,
  DEFAULT_NOTIFICATION_RESOLVE_TIMEOUT_MS,
  DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS,
  DISCORD_NOTIFICATION_PLATFORM,
} from './notification';
export type {
  NotificationAllowedMentions,
  NotificationChannel,
  NotificationSendOptions,
  OwnerNotificationDeps,
} from './notification';
export { isAdmittedReaction, toRating } from './reactions';
export {
  DEFAULT_IDENTITY_READY_TIMEOUT_MS,
  DiscordIdentityUnavailableError,
  readConnectedIdentity,
} from './connected-identity';
export type { DiscordConnectedIdentity, IdentityClientView } from './connected-identity';
export type { ReactionAdmissionInput } from './reactions';
export {
  ATTACHMENT_CDN_HOSTS,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_SWEEP_AGE_MS,
  AttachmentIntake,
  classifyAttachment,
  DEFAULT_ATTACHMENT_TEMP_ROOT,
  IMAGE_ATTACHMENT_MAX_BYTES,
  renderAttachmentIntakeNote,
  TEXT_ATTACHMENT_MAX_BYTES,
} from './attachments';
export type { AttachmentIntakeOptions, AttachmentIntakeResult, AttachmentSource } from './attachments';
import type {
  ApprovalDecisionHandler,
  ApprovalRequest,
  ConversationContext,
  InboundAttachment,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  NotificationSink,
  NotificationSinkOutcome,
  OutboundDeliveryReceipt,
  OutboundMessage,
  OwnerNotification,
  PlatformAdapter,
  PlatformFeedbackAction,
  PlatformFeedbackHandler,
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
  /**
   * ADR-0101 D8 opt-in (QUOKY_REMINDERS_CHANNEL_DELIVERY): deliver TEXT notifications to the originating
   * allowlisted guild channel/thread instead of the owner DM. Absent/false = owner DM only. The daily brief is
   * always DM-only regardless of this flag.
   */
  channelDelivery?: boolean;
}

/** Optional collaborators (test seams); the composition root may omit them. */
export interface DiscordAdapterOptions {
  /** ADR-0111 attachment intake options (fetch seam, temp directory). */
  readonly attachments?: AttachmentIntakeOptions;
}

/** How often the runner-owned attachment temp directory is swept (ADR-0111 D2: files older than 10 minutes). */
const ATTACHMENT_SWEEP_INTERVAL_MS = 60_000;

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
export class DiscordPlatformAdapter implements PlatformAdapter, NotificationSink {
  readonly platform = 'discord';

  private client?: Client;
  private messageHandler?: InboundMessageHandler;
  private approvalHandler?: ApprovalDecisionHandler;
  private feedbackHandler?: PlatformFeedbackHandler;
  /** Active self-refreshing typing loops, keyed by target channel/thread id. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** ADR-0111: bounded intake for admitted messages' attachments. */
  private readonly attachmentIntake: AttachmentIntake;
  private attachmentSweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: DiscordConfig,
    private readonly logger: Logger,
    options: DiscordAdapterOptions = {},
  ) {
    this.attachmentIntake = new AttachmentIntake(options.attachments);
  }

  onMessage(handler: InboundMessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalDecision(handler: ApprovalDecisionHandler): void {
    this.approvalHandler = handler;
  }

  /** ADR-0098 D3: admitted 👍/👎 reactions on this bot's replies. */
  onFeedback(handler: PlatformFeedbackHandler): void {
    this.feedbackHandler = handler;
  }

  async start(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        // ADR-0091: owner direct messages. DM channels arrive uncached, so the Channel partial is required.
        GatewayIntentBits.DirectMessages,
        // ADR-0098 D3: reaction feedback (non-privileged intents). Partials let add/remove events for an uncached
        // user/reaction still arrive; admission itself never fetches.
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    });
    this.client = client;

    // ADR-0111 D2: leftovers from an earlier run are swept now, then every minute (files older than 10 minutes).
    void this.attachmentIntake.sweep();
    const sweepTimer = setInterval(() => void this.attachmentIntake.sweep(), ATTACHMENT_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
    this.attachmentSweepTimer = sweepTimer;

    client.on(Events.MessageCreate, (message) => {
      void this.handleMessageCreate(message);
    });
    client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.handleReaction(reaction, user, 'ADDED');
    });
    client.on(Events.MessageReactionRemove, (reaction, user) => {
      void this.handleReaction(reaction, user, 'REMOVED');
    });

    await client.login(this.config.token);
  }

  async stop(): Promise<void> {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    if (this.attachmentSweepTimer) clearInterval(this.attachmentSweepTimer);
    this.attachmentSweepTimer = undefined;
    await this.attachmentIntake.dispose();
    await this.client?.destroy();
    this.client = undefined;
  }

  /**
   * Delivers one reply and returns the ids of every Discord message posted for it (text chunks, preview parts,
   * attachments and notices, in posting order; ADR-0098 D3) — including after a partial failure, so the parts that
   * did arrive stay rateable. Nothing posted → an empty receipt.
   */
  async sendMessage(message: OutboundMessage): Promise<OutboundDeliveryReceipt> {
    const target = message.context.threadId ?? message.context.channelId;
    const platformMessageIds: string[] = [];
    const receipt: OutboundDeliveryReceipt = { platformMessageIds };
    // The response is arriving — stop the "is typing…" loop for this target.
    this.clearTyping(target);
    const channel = await this.fetchChannel(target);
    if (!channel?.isSendable()) {
      this.logger.warn('send skipped: channel not sendable', { channelId: target });
      return receipt;
    }

    // F5-C/D/E (Sprint 4c-Follow-up-5): a complete structured preview is delivered LOSSLESSLY — ordered
    // multipart fenced messages, or a complete `.diff` attachment (in-memory Buffer; no temp file, so
    // nothing touches the workspace/sandbox). Observability is length-only (never raw diff content).
    if (message.preview) {
      const report = await deliverPreview(message.preview, {
        sendText: async (chunk) => {
          platformMessageIds.push((await channel.send(chunk)).id);
        },
        sendAttachment: async (canonicalDiff, filename, caption) => {
          const sent = await channel.send({
            content: caption,
            files: [{ attachment: Buffer.from(canonicalDiff, 'utf8'), name: filename }],
          });
          platformMessageIds.push(sent.id);
        },
        notify: async (notice) => {
          try {
            platformMessageIds.push((await channel.send(notice)).id);
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
      return receipt;
    }

    const report = await deliverWithNotice(
      message.text,
      async (chunk) => {
        platformMessageIds.push((await channel.send(chunk)).id);
      },
      async (notice) => {
        // Single best-effort notice; if it also fails, log only (ADR-0016).
        try {
          platformMessageIds.push((await channel.send(notice)).id);
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
      return receipt;
    }
    if (report.totalChunks > 1) {
      this.logger.info('message delivered in chunks', {
        channelId: target,
        chunks: report.totalChunks,
        fileAttachmentThresholdHit: report.totalChunks > FILE_ATTACHMENT_CHUNK_THRESHOLD,
      });
    }
    return receipt;
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

  /**
   * ADR-0102 D5 (adapter-local, not part of `PlatformAdapter`): read-only facts about the identity this client
   * connected as — bot user id, guild ids and the given channel ids' guilds — for the composition root's startup
   * identity check. Waits for the gateway READY up to `readyTimeoutMs`; never sends or changes anything.
   */
  async readConnectedIdentity(
    channelIds: readonly string[],
    options: { readonly readyTimeoutMs?: number } = {},
  ): Promise<DiscordConnectedIdentity> {
    const client = this.client;
    if (!client) throw new Error('DISCORD_NOT_STARTED');
    return readConnectedIdentity(
      {
        isReady: () => client.isReady(),
        onceReady: (listener) => {
          client.once(Events.ClientReady, listener);
          return () => {
            client.off(Events.ClientReady, listener);
          };
        },
        botUserId: () => client.user?.id,
        guildIds: () => client.guilds.cache.keys(),
        channelGuildId: async (id) => {
          const channel = await this.fetchChannel(id);
          if (!channel) return undefined;
          return 'guildId' in channel && typeof channel.guildId === 'string' ? channel.guildId : null;
        },
      },
      channelIds,
      options,
    );
  }

  async requestApproval(_request: ApprovalRequest, _context: ConversationContext): Promise<void> {
    // Out of scope for Sprint 1a (no approval UI yet). See ADR-0010 / risk policy.
    void this.approvalHandler;
    throw new NotImplementedError('DiscordPlatformAdapter.requestApproval');
  }

  /**
   * ADR-0101 D4/D8: owner-only notification delivery. Classification and target policy live in notification.ts;
   * this method only supplies the live client. A client that is not started/ready is a confirmed non-send.
   */
  async deliver(notification: OwnerNotification): Promise<NotificationSinkOutcome> {
    const client = this.client;
    if (!client || (typeof client.isReady === 'function' && !client.isReady())) {
      this.logger.warn('owner notification delivery', {
        correlationId: notification.correlationId,
        kind: notification.kind,
        status: 'NOT_SENT',
        reason: 'NOT_CONNECTED',
        retryable: true,
      });
      return { status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true };
    }
    // ADR-0101 D6 (at-most-once): the shared client REST retries 5xx/transport failures up to 3 times, which could
    // post a message the platform already accepted. Notification posts go through a dedicated REST with retries off.
    const rest = new REST({
      retries: 0,
      timeout: DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS,
    }).setToken(this.config.token);
    const noRetryChannel = (channelId: string): NotificationChannel => ({
      send: (options: NotificationSendOptions) =>
        rest.post(Routes.channelMessages(channelId), {
          body: {
            content: options.content,
            allowed_mentions: { parse: options.allowedMentions.parse, ...(options.allowedMentions.users ? { users: options.allowedMentions.users } : {}) },
          },
        }),
    });
    return deliverOwnerNotification(notification, {
      ownerIds: this.config.ownerIds,
      channelIds: this.config.channelIds ?? [],
      ...(this.config.guildId ? { guildId: this.config.guildId } : {}),
      channelDelivery: this.config.channelDelivery === true,
      fetchChannel: async (id): Promise<NotificationChannel | null> => {
        const channel = await this.fetchChannel(id);
        return channel?.isSendable() ? noRetryChannel(channel.id) : null;
      },
      fetchOwnerDm: async (userId): Promise<NotificationChannel> => {
        const user = await client.users.fetch(userId);
        const dm = await user.createDM();
        return noRetryChannel(dm.id);
      },
      logger: this.logger,
    });
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
      const sources = readAttachmentSources(message);
      this.logger.info('message received', {
        messageId: message.id,
        channelId: message.channelId,
        userId: message.author.id,
        ...(sources.length > 0 ? { attachmentCount: sources.length } : {}),
      });
      // ADR-0111 D2: attachment intake only AFTER the ADR-0091 gate above; a dropped message downloads nothing.
      // It runs before the handler, so before any wait the composition root adds there (ADR-0102 D5 identity gate);
      // see the ordering note on InboundMessageHandler.
      const intake = sources.length > 0 ? await this.attachmentIntake.intake(sources) : undefined;
      try {
        if (intake) await this.reportAttachmentIntake(message, intake);
        await handler(this.toInbound(message, intake?.attachments));
      } finally {
        // ADR-0111 D2: temp files live only for the turn.
        await intake?.release();
      }
    } catch (err) {
      this.logger.error('message handling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * ADR-0098 D3 reaction feedback. Admission ({@link isAdmittedReaction}: 👍/👎 only, owner reactor, bot-authored
   * target, ADR-0091 location) runs on data already present in the gateway event and cache — BEFORE any fetch or
   * logging. Nothing is fetched at all: an uncached (partial) target has no known author and is dropped, so
   * feedback is captured for replies still in the message cache. A dropped reaction is never logged; the handler
   * failure log carries no ids or content. Nothing is ever sent in response.
   */
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    action: PlatformFeedbackAction,
  ): Promise<void> {
    try {
      const rating = toRating(reaction.emoji.id ? null : reaction.emoji.name);
      if (!rating) return;
      const message = reaction.message;
      const channel = (message.channel ?? null) as { isThread?: () => boolean; parentId?: string | null } | null;
      const isThread = channel?.isThread?.() === true;
      const parentId = isThread ? (channel?.parentId ?? null) : null;
      const admitted = isAdmittedReaction({
        userId: user.id,
        ownerIds: this.config.ownerIds,
        messageAuthorId: message.partial ? null : message.author?.id,
        botUserId: this.client?.user?.id,
        guildId: message.guildId ?? null,
        ...(this.config.guildId ? { configuredGuildId: this.config.guildId } : {}),
        channelId: message.channelId,
        isThread,
        parentId,
        channelIds: this.config.channelIds ?? [],
      });
      if (!admitted) return;
      const handler = this.feedbackHandler;
      if (!handler) return;
      const context: ConversationContext = {
        platform: this.platform,
        channelId: isThread ? (parentId ?? message.channelId) : message.channelId,
        userId: user.id,
        ...(message.guildId ? { spaceId: message.guildId } : {}),
        ...(isThread ? { threadId: message.channelId } : {}),
      };
      await handler({
        platform: this.platform,
        context,
        targetPlatformMessageId: message.id,
        rating,
        action,
        occurredAt: now(),
      });
    } catch (err) {
      this.logger.warn('feedback reaction handling failed', {
        errorName: err instanceof Error ? err.name : typeof err,
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

  /**
   * ADR-0111 D2/D3: logs content-free counts and, when an attachment was not taken in, posts one deterministic note
   * naming it and why (best-effort, no mentions). Never echoes attachment content.
   */
  private async reportAttachmentIntake(message: Message, intake: AttachmentIntakeResult): Promise<void> {
    this.logger.info('attachment intake', { messageId: message.id, ...summarizeAttachmentIntake(intake.attachments) });
    const note = renderAttachmentIntakeNote(intake.attachments);
    if (!note) return;
    try {
      const channel = await this.fetchChannel(message.channelId);
      if (!channel?.isSendable()) return;
      await channel.send({ content: note, allowedMentions: { parse: [] } });
    } catch (err) {
      this.logger.warn('attachment intake note send failed', {
        channelId: message.channelId,
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }
  }

  /** Translate a Discord Message into a normalized InboundMessage. */
  private toInbound(message: Message, attachments?: readonly InboundAttachment[]): InboundMessage {
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
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      receivedAt: now(),
    };
  }

  private async fetchChannel(id: string) {
    if (!this.client) return null;
    return this.client.channels.fetch(id).catch(() => null);
  }
}

/** Metadata of a Discord message's attachments, in upload order (no content, no download). */
function readAttachmentSources(message: Message): AttachmentSource[] {
  const collection = message.attachments;
  if (!collection || typeof collection.values !== 'function') return [];
  return [...collection.values()].map((attachment) => ({
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    url: attachment.url,
  }));
}
