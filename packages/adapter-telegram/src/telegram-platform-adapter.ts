import { NotImplementedError, now } from '@quoky/core';
import type {
  ApprovalDecisionHandler,
  ApprovalRequest,
  ConversationContext,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  OutboundDeliveryReceipt,
  OutboundMessage,
  PlatformAdapter,
} from '@quoky/core';
import { admitTelegramUpdate, TELEGRAM_DROP_REASONS, updateIdOf } from './admission';
import type { AdmittedTelegramMessage, TelegramDropReason } from './admission';
import { TelegramApiError, TelegramBotApi, TelegramFailureCode } from './bot-api';
import type { FetchLike, TelegramMethod } from './bot-api';
import type { TelegramBotToken } from './bot-token';
import { deliverTelegramPreview, deliverTelegramText } from './delivery';
import { contentDisagreesWithText, renderOutboundForTelegram, TELEGRAM_PLATFORM } from './rendering';

/**
 * `PlatformAdapter` for Telegram (ADR-0114). Bot API types stay inside this package; only normalized domain messages
 * cross into Core.
 *
 * - **No inbound port** (D4): long polling with `getUpdates` only; no webhook, no listener.
 * - **Identity first** (D5): `start()` checks the token's bot id and `getMe` against the expected bot id, then probes
 *   for a second poller (HTTP 409), and only then starts polling. A mismatch fails closed before any update is read.
 * - **Admission** (D2): `admission.ts`. A dropped update is only counted; it gets no reply, no download, no log line.
 * - **Offset** (D4): advanced past an update only after it was handed to the runtime (or dropped), so nothing is
 *   reprocessed and nothing is skipped; `stop()` confirms the last offset so a restart does not see it again.
 * - **Delivery** (D7): plain text, lossless 4096 chunks, typing through `sendChatAction`, sends only to an owner's
 *   private chat.
 */

export interface TelegramAdapterConfig {
  /** The bot token holder (never logged; it reaches only the Bot API request path). */
  readonly token: TelegramBotToken;
  /** `QUOKY_TELEGRAM_EXPECTED_BOT_ID`: the bot user id `getMe` must return. */
  readonly expectedBotId: string;
  /** `QUOKY_TELEGRAM_OWNER_IDS`: exact numeric Telegram user ids admitted in their private chats. Empty admits nobody. */
  readonly ownerIds: readonly string[];
}

/** Test seams and bounds; production passes none. */
export interface TelegramAdapterOptions {
  readonly fetch?: FetchLike;
  /** An abortable sleep (backoff, typing refresh is timer-driven). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Wall clock in milliseconds (staleness bound). */
  readonly nowMs?: () => number;
  /** The server-side long-poll wait in seconds (default 25). */
  readonly pollTimeoutSeconds?: number;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
}

export const TelegramStartupErrorCode = {
  /** The token's bot id or `getMe` is not `QUOKY_TELEGRAM_EXPECTED_BOT_ID` (or `getMe` is not a bot). */
  TELEGRAM_IDENTITY_MISMATCH: 'TELEGRAM_IDENTITY_MISMATCH',
  /** `getMe` could not be completed (network, timeout, malformed answer); a later start may succeed. */
  TELEGRAM_IDENTITY_UNVERIFIABLE: 'TELEGRAM_IDENTITY_UNVERIFIABLE',
  /** Telegram rejected the token (HTTP 401/404). */
  TELEGRAM_AUTH_REJECTED: 'TELEGRAM_AUTH_REJECTED',
  /** HTTP 409 on the startup probe: another poller or a webhook holds this bot. */
  TELEGRAM_POLL_CONFLICT: 'TELEGRAM_POLL_CONFLICT',
} as const;
export type TelegramStartupErrorCode = (typeof TelegramStartupErrorCode)[keyof typeof TelegramStartupErrorCode];

/** A typed, value-free startup refusal: the message is the code only. */
export class TelegramStartupError extends Error {
  constructor(readonly code: TelegramStartupErrorCode) {
    super(code);
    this.name = 'TelegramStartupError';
  }
}

/** Content-free status for the operations panel (TG-3): no ids, no content, no token. */
export interface TelegramAdapterStatus {
  readonly identityVerified: boolean;
  readonly polling: boolean;
  readonly lastPollAt?: string;
  readonly admittedChatCount: number;
  readonly droppedUpdates: Readonly<Record<TelegramDropReason, number>>;
}

const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
/** The HTTP bound of a long poll: the server-side wait plus headroom. */
const POLL_HTTP_HEADROOM_MS = 10_000;
const POLL_LIMIT = 100;
/** 100 updates of 4096 characters each fit well inside this. */
const POLL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CALL_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;
const DOCUMENT_TIMEOUT_MS = 30_000;
const STOP_CONFIRM_TIMEOUT_MS = 3_000;
const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 60_000 } as const;
/** A 429 on a send is retried once when Telegram asks for at most this long (a 429 confirms nothing was posted). */
const MAX_SEND_RETRY_AFTER_SECONDS = 10;
/** Telegram's typing indicator lasts about 5 s; refresh under that while a turn runs, for at most ~2 minutes. */
const TYPING_REFRESH_MS = 4_500;
const TYPING_MAX_TICKS = 27;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

function codeOf(error: unknown): string {
  return error instanceof TelegramApiError ? error.code : 'UNEXPECTED';
}

export class TelegramPlatformAdapter implements PlatformAdapter {
  readonly platform = TELEGRAM_PLATFORM;

  private readonly api: TelegramBotApi;
  private readonly owners: ReadonlySet<string>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly pollTimeoutSeconds: number;
  private readonly backoff: { readonly initialMs: number; readonly maxMs: number };

  private messageHandler?: InboundMessageHandler;
  private approvalHandler?: ApprovalDecisionHandler;
  /** ADR-0102 D5: the composition root's startup identity gate; absent = open. */
  private inboundGate?: Promise<boolean>;

  private controller?: AbortController;
  private loop?: Promise<void>;
  private stopped = false;
  private polling = false;
  private identityVerified = false;
  /** The next `getUpdates` offset: one past the last update handed to the runtime or dropped. */
  private offset?: number;
  /** The offset Telegram has confirmed (sent with a successful `getUpdates`). */
  private confirmedOffset?: number;
  private lastPollAt?: string;
  private readonly admittedChats = new Set<string>();
  private readonly dropped: Record<TelegramDropReason, number> = Object.fromEntries(
    TELEGRAM_DROP_REASONS.map((reason) => [reason, 0]),
  ) as Record<TelegramDropReason, number>;
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly config: TelegramAdapterConfig,
    private readonly logger: Logger,
    options: TelegramAdapterOptions = {},
  ) {
    this.api = new TelegramBotApi(config.token, options.fetch);
    this.owners = new Set(config.ownerIds);
    this.sleep = options.sleep ?? abortableSleep;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  onMessage(handler: InboundMessageHandler): void {
    this.messageHandler = handler;
  }

  onApprovalDecision(handler: ApprovalDecisionHandler): void {
    // ADR-0114 D10: approvals are text phrases on Telegram (no buttons), so no decision ever arrives here.
    this.approvalHandler = handler;
  }

  /** ADR-0102 D5 (adapter-local): an admitted update waits for this gate and is never handed over unless it is `true`. */
  gateInbound(gate: Promise<boolean>): void {
    this.inboundGate = gate;
  }

  /** Content-free status (no ids, no content, no token). */
  status(): TelegramAdapterStatus {
    return {
      identityVerified: this.identityVerified,
      polling: this.polling,
      ...(this.lastPollAt !== undefined ? { lastPollAt: this.lastPollAt } : {}),
      admittedChatCount: this.admittedChats.size,
      droppedUpdates: { ...this.dropped },
    };
  }

  /**
   * Identity check, conflict probe, then polling (in the background). Throws {@link TelegramStartupError} and reads no
   * update when the identity does not match, the token is rejected or another poller/webhook holds the bot.
   */
  async start(): Promise<void> {
    if (this.loop !== undefined) return;
    this.stopped = false;
    // The token names its bot: a token for another bot fails before any network call.
    if (this.config.token.botId !== this.config.expectedBotId) {
      throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH);
    }
    let me: unknown;
    try {
      me = await this.api.call('getMe', {}, { timeoutMs: CALL_TIMEOUT_MS });
    } catch (err) {
      throw new TelegramStartupError(
        codeOf(err) === TelegramFailureCode.AUTH
          ? TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED
          : TelegramStartupErrorCode.TELEGRAM_IDENTITY_UNVERIFIABLE,
      );
    }
    const id = (me as { id?: unknown } | null)?.id;
    const isBot = (me as { is_bot?: unknown } | null)?.is_bot;
    if (typeof id !== 'number' || String(id) !== this.config.expectedBotId || isBot !== true) {
      this.logger.error('telegram startup identity mismatch', { fields: 'bot' });
      throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH);
    }
    this.identityVerified = true;
    // A conflict probe that confirms nothing (no offset): HTTP 409 means a webhook or another poller holds the bot.
    try {
      await this.api.call('getUpdates', { limit: 1, timeout: 0 }, { timeoutMs: CALL_TIMEOUT_MS, maxResponseBytes: POLL_MAX_RESPONSE_BYTES });
    } catch (err) {
      const code = codeOf(err);
      if (code === TelegramFailureCode.CONFLICT) throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT);
      if (code === TelegramFailureCode.AUTH) throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED);
      // Anything transient: the poll loop backs off and retries.
    }
    this.logger.info('telegram startup identity verified', { bot: 'match', owners: this.owners.size });
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.run(controller.signal);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    this.controller = undefined;
    // Confirm what was handed over, so the next start does not receive it again (best-effort, bounded).
    if (this.offset !== undefined && this.offset !== this.confirmedOffset) {
      try {
        await this.api.call('getUpdates', { offset: this.offset, limit: 1, timeout: 0 }, {
          timeoutMs: STOP_CONFIRM_TIMEOUT_MS,
          maxResponseBytes: POLL_MAX_RESPONSE_BYTES,
        });
        this.confirmedOffset = this.offset;
      } catch (err) {
        this.logger.warn('telegram offset confirm on stop failed', { code: codeOf(err) });
      }
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    this.polling = true;
    try {
      await this.poll(signal);
    } finally {
      this.polling = false;
    }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let delay = this.backoff.initialMs;
    this.logger.info('telegram polling started');
    while (!this.stopped) {
      let updates: unknown;
      const sentOffset = this.offset;
      try {
        updates = await this.api.call(
          'getUpdates',
          {
            ...(sentOffset !== undefined ? { offset: sentOffset } : {}),
            limit: POLL_LIMIT,
            timeout: this.pollTimeoutSeconds,
            allowed_updates: ['message'],
          },
          {
            timeoutMs: this.pollTimeoutSeconds * 1000 + POLL_HTTP_HEADROOM_MS,
            signal,
            maxResponseBytes: POLL_MAX_RESPONSE_BYTES,
          },
        );
        if (!Array.isArray(updates)) throw new TelegramApiError(TelegramFailureCode.MALFORMED_RESPONSE, 'getUpdates');
      } catch (err) {
        if (this.stopped) break;
        const wait = this.nextDelay(err, delay);
        delay = Math.min(this.backoff.maxMs, Math.max(delay * 2, this.backoff.initialMs));
        if (codeOf(err) === TelegramFailureCode.CONFLICT) {
          this.logger.error('telegram poll conflict', { code: TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT, delayMs: wait });
        } else {
          this.logger.warn('telegram poll failed', { code: codeOf(err), delayMs: wait });
        }
        await this.sleep(wait, signal);
        continue;
      }
      delay = this.backoff.initialMs;
      if (sentOffset !== undefined) this.confirmedOffset = sentOffset;
      this.lastPollAt = now();
      const before = this.offset;
      const proceed = await this.handleBatch(updates, signal);
      if (!proceed) break;
      // A non-empty batch that moved nothing (entries without a usable update_id) must not spin.
      if (updates.length > 0 && this.offset === before) await this.sleep(this.backoff.maxMs, signal);
    }
  }

  private nextDelay(err: unknown, delay: number): number {
    if (err instanceof TelegramApiError) {
      if (err.code === TelegramFailureCode.CONFLICT) return this.backoff.maxMs;
      if (err.code === TelegramFailureCode.RATE_LIMITED && err.retryAfterSeconds !== undefined) {
        return Math.max(delay, err.retryAfterSeconds * 1000);
      }
    }
    return delay;
  }

  /** Admit, hand over or count each update in order; `false` stops polling (the identity gate closed). */
  private async handleBatch(updates: readonly unknown[], signal: AbortSignal): Promise<boolean> {
    for (const update of updates) {
      const updateId = updateIdOf(update);
      // Already handed over or dropped (a repeated entry): never processed twice.
      if (updateId !== undefined && this.offset !== undefined && updateId < this.offset) continue;
      const admission = admitTelegramUpdate(update, this.owners, Math.floor(this.nowMs() / 1000));
      if (admission.kind === 'admitted') {
        // ADR-0102 D5: nothing is handed over unless the startup identity gate opened; the offset stays put.
        if (!(await this.inboundGateOpen(signal))) return false;
        this.dispatch(admission.message);
      } else {
        this.dropped[admission.reason] += 1;
      }
      if (updateId !== undefined) this.offset = updateId + 1;
    }
    return true;
  }

  /** Hand one admitted message to the runtime. The turn runs on; polling does not wait for it. */
  private dispatch(message: AdmittedTelegramMessage): void {
    const handler = this.messageHandler;
    if (!handler) return;
    this.admittedChats.add(message.chatId);
    this.logger.info('message received', { platform: TELEGRAM_PLATFORM, messageId: message.messageId });
    void handler(this.toInbound(message)).catch((err: unknown) =>
      this.logger.error('message handling failed', { errorName: err instanceof Error ? err.name : typeof err }),
    );
  }

  private toInbound(message: AdmittedTelegramMessage): InboundMessage {
    const context: ConversationContext = {
      platform: TELEGRAM_PLATFORM,
      channelId: message.chatId,
      userId: message.userId,
      // Admission admits only the owner's own private chat with the bot.
      direct: true,
    };
    return { id: message.messageId, context, text: message.text, receivedAt: now() };
  }

  /** `true` only when no gate is set or it resolved `true`; a rejected gate, or a stop while waiting, counts as closed. */
  private async inboundGateOpen(signal: AbortSignal): Promise<boolean> {
    const gate = this.inboundGate;
    if (!gate) return true;
    if (signal.aborted) return false;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<boolean>((resolve) => {
      onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return (await Promise.race([gate.then((open) => open === true, () => false), aborted])) && !signal.aborted;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** An outbound target is admitted only when it is a listed owner's own private chat (rechecked on every send). */
  private ownerChatOf(context: ConversationContext): string | undefined {
    if (context.platform !== TELEGRAM_PLATFORM) return undefined;
    const chatId = context.channelId;
    return this.owners.has(chatId) && context.threadId === undefined ? chatId : undefined;
  }

  async sendMessage(message: OutboundMessage): Promise<OutboundDeliveryReceipt> {
    const platformMessageIds: string[] = [];
    const receipt: OutboundDeliveryReceipt = { platformMessageIds };
    const chatId = this.ownerChatOf(message.context);
    if (chatId === undefined) {
      this.logger.warn('send refused: not an owner private chat', { platform: message.context.platform });
      return receipt;
    }
    this.clearTyping(chatId);
    const record = (id: string): void => {
      if (id !== '') platformMessageIds.push(id);
    };
    const post = async (text: string, html = false): Promise<void> => {
      record(await this.postMessage(chatId, text, html));
    };
    const notify = async (notice: string): Promise<void> => {
      try {
        await post(notice);
      } catch (err) {
        this.logger.warn('telegram notice send failed', { code: codeOf(err) });
      }
    };

    if (message.preview) {
      const report = await deliverTelegramPreview(message.preview, {
        sendPlain: (text) => post(text),
        sendHtml: (html) => post(html, true),
        sendDocument: async (diff, filename) => {
          record(await this.postDocument(chatId, diff, filename));
        },
        notify,
      });
      this.logger.info('preview delivered', {
        platform: TELEGRAM_PLATFORM,
        previewId: report.previewId,
        deliveryOutcome: report.outcome,
        deliveryMode: report.deliveryMode,
        partCount: report.partCount,
        deliveredPartCount: report.deliveredPartCount,
        canonicalDiffLength: report.canonicalDiffLength,
      });
      return receipt;
    }

    if (contentDisagreesWithText(message)) {
      this.logger.warn('outbound content and text disagree', { platform: TELEGRAM_PLATFORM, textLength: message.text.length });
    }
    const text = renderOutboundForTelegram(message);
    if (text.trim().length === 0) return receipt;
    const report = await deliverTelegramText(text, (chunk) => post(chunk), notify, codeOf);
    if (!report.ok) {
      this.logger.error('message delivery failed', {
        platform: TELEGRAM_PLATFORM,
        sent: report.sent,
        totalChunks: report.totalChunks,
        code: report.errorCode,
      });
    } else if (report.totalChunks > 1) {
      this.logger.info('message delivered in chunks', { platform: TELEGRAM_PLATFORM, chunks: report.totalChunks });
    }
    return receipt;
  }

  /** One `sendMessage`; a 429 asking for a short wait is retried once (Telegram posted nothing). Returns the message id. */
  private async postMessage(chatId: string, text: string, html: boolean): Promise<string> {
    const params = {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(html ? { parse_mode: 'HTML' } : {}),
    };
    const result = await this.callWithRateLimitRetry('sendMessage', () => params, SEND_TIMEOUT_MS);
    return messageIdOf(result);
  }

  private async postDocument(chatId: string, content: string, filename: string): Promise<string> {
    const form = (): FormData => {
      const data = new FormData();
      data.append('chat_id', chatId);
      data.append('document', new Blob([content], { type: 'text/x-diff' }), filename);
      return data;
    };
    return messageIdOf(await this.callWithRateLimitRetry('sendDocument', form, DOCUMENT_TIMEOUT_MS));
  }

  private async callWithRateLimitRetry(
    method: TelegramMethod,
    params: () => Record<string, unknown> | FormData,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.api.call(method, params(), { timeoutMs });
    } catch (err) {
      const retryAfter = err instanceof TelegramApiError && err.code === TelegramFailureCode.RATE_LIMITED ? err.retryAfterSeconds : undefined;
      if (retryAfter === undefined || retryAfter > MAX_SEND_RETRY_AFTER_SECONDS) throw err;
      await this.sleep(retryAfter * 1000, new AbortController().signal);
      return this.api.call(method, params(), { timeoutMs });
    }
  }

  async sendTyping(context: ConversationContext): Promise<void> {
    const chatId = this.ownerChatOf(context);
    if (chatId === undefined) return;
    await this.pumpTyping(chatId);
    if (this.typingTimers.has(chatId)) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks >= TYPING_MAX_TICKS || this.stopped) {
        this.clearTyping(chatId);
        return;
      }
      void this.pumpTyping(chatId);
    }, TYPING_REFRESH_MS);
    timer.unref?.();
    this.typingTimers.set(chatId, timer);
  }

  private async pumpTyping(chatId: string): Promise<void> {
    await this.api.call('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined);
  }

  private clearTyping(chatId: string): void {
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
  }

  async requestApproval(_request: ApprovalRequest, _context: ConversationContext): Promise<void> {
    // ADR-0114 D10: text-phrase approvals only; no button surface.
    void this.approvalHandler;
    throw new NotImplementedError('TelegramPlatformAdapter.requestApproval');
  }
}

function messageIdOf(result: unknown): string {
  const id = (result as { message_id?: unknown } | null)?.message_id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : '';
}
