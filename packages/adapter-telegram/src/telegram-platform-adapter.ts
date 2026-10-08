import { NotImplementedError, now, REMINDER_LIMITS } from '@quoky/core';
import type {
  ApprovalDecisionHandler,
  ApprovalRequest,
  ConversationContext,
  InboundAttachment,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  NotificationNotSentReason,
  NotificationSink,
  NotificationSinkOutcome,
  OutboundDeliveryReceipt,
  OutboundMessage,
  OwnerNotification,
  PlatformAdapter,
  PlatformFeedbackHandler,
} from '@quoky/core';
import { admitTelegramUpdate, TELEGRAM_DROP_REASONS, updateIdOf } from './admission';
import type { AdmittedTelegramMessage, AdmittedTelegramReaction, TelegramDropReason } from './admission';
import {
  ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  renderAttachmentIntakeNote,
  summarizeAttachmentIntake,
  TelegramAttachmentIntake,
} from './attachments';
import type { AttachmentIntakeResult, TelegramAttachmentIntakeOptions, TelegramFileGateway } from './attachments';
import { TelegramApiError, TelegramBotApi, TelegramFailureCode } from './bot-api';
import type { FetchLike, TelegramCallOptions, TelegramMethod } from './bot-api';
import type { TelegramBotToken } from './bot-token';
import { deliverTelegramPreview, deliverTelegramText, TELEGRAM_MESSAGE_LIMIT } from './delivery';
import { telegramMessageKey } from './reactions';
import { contentDisagreesWithText, renderOutboundForTelegram, renderTelegramContent, TELEGRAM_PLATFORM } from './rendering';

/**
 * `PlatformAdapter` for Telegram (ADR-0114). Bot API types stay inside this package; only normalized domain messages
 * cross into Core.
 *
 * - **No inbound port** (D4): long polling with `getUpdates` only; no webhook, no listener.
 * - **Identity first** (D5): `start()` checks the token's bot id, then (bounded ~5 s each) `getMe` and a non-confirming
 *   probe that must not get HTTP 409 (in practice a webhook). A definitive answer there is a typed startup error; a
 *   transient one resolves `start()` and is retried in the background, where a later definitive answer halts the
 *   Telegram side only (`onHalt`). Nothing is read, and nothing is sent, before `getMe` matched.
 * - **Admission** (D2): `admission.ts`. A dropped update is only counted; it gets no reply, no download, no log line.
 * - **Offset** (D4): advanced past an update only after it was handed to the runtime (or dropped), so nothing is
 *   reprocessed and nothing is skipped; `stop()` confirms the last offset so a restart does not see it again.
 * - **Conflicts** (D4): three 409s within five minutes while polling (a second instance) halt the Telegram side.
 * - **Delivery** (D7): plain text, lossless 4096 chunks, typing through `sendChatAction`, sends only to an owner's
 *   private chat, and only while verified and not halted.
 * - **Attachments** (D8, TG-2): `attachments.ts`. Only for an admitted message, after the identity gate: metadata
 *   bounds first, then `getFile` and the bounded download through the same guarded outbound path as every send. An
 *   album (`media_group_id`) is one turn.
 * - **Feedback** (D9, TG-2): `message_reaction` updates (asked for explicitly in `allowed_updates`); an owner's 👍/👎
 *   in their own private chat reaches `onFeedback`. Everything else is dropped silently.
 */

export interface TelegramAdapterConfig {
  /** The bot token holder (never logged; it reaches only the Bot API request path). */
  readonly token: TelegramBotToken;
  /** `QUOKY_TELEGRAM_EXPECTED_BOT_ID`: the bot user id `getMe` must return. */
  readonly expectedBotId: string;
  /** `QUOKY_TELEGRAM_OWNER_IDS`: exact numeric Telegram user ids admitted in their private chats. Empty admits nobody. */
  readonly ownerIds: readonly string[];
}

/**
 * Where the poll offset survives a restart (decision 2 of the TG-1 review). `load` returns the offset to resume from (or
 * `undefined`); `save` must be atomic. The composition root keeps it in a private file beside the database.
 */
export interface TelegramOffsetStore {
  load(): number | undefined;
  save(offset: number): void;
}

/** Test seams and bounds; production passes none except the offset store. */
export interface TelegramAdapterOptions {
  /** Persisted poll offset; absent = in memory only (a restart then relies on Telegram's own confirmation). */
  readonly offsetStore?: TelegramOffsetStore;
  readonly fetch?: FetchLike;
  /** An abortable sleep (backoff, typing refresh is timer-driven). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Wall clock in milliseconds (staleness bound). */
  readonly nowMs?: () => number;
  /** The server-side long-poll wait in seconds (default 25). */
  readonly pollTimeoutSeconds?: number;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
  /** Bound of each startup identity call (`getMe`, the probe); default {@link STARTUP_CALL_TIMEOUT_MS}. */
  readonly startupCallTimeoutMs?: number;
  /** TG-2 attachment intake options (temp directory, sweep clock). */
  readonly attachments?: TelegramAttachmentIntakeOptions;
  /** The wait before an album is re-polled for its later parts (default {@link MEDIA_GROUP_SETTLE_MS}). */
  readonly mediaGroupSettleMs?: number;
}

export const TelegramStartupErrorCode = {
  /**
   * The token's bot id or `getMe` is not `QUOKY_TELEGRAM_EXPECTED_BOT_ID`, or `getMe` is not a bot: a startup error when
   * found by `start()`, a Telegram-only halt when found later.
   */
  TELEGRAM_IDENTITY_MISMATCH: 'TELEGRAM_IDENTITY_MISMATCH',
  /** `getMe` could not be completed (network, timeout, malformed answer): a log code; retried, never thrown or halted. */
  TELEGRAM_IDENTITY_UNVERIFIABLE: 'TELEGRAM_IDENTITY_UNVERIFIABLE',
  /** Telegram rejected the token (HTTP 401/404): a startup error at `start()`, a Telegram-only halt when found later. */
  TELEGRAM_AUTH_REJECTED: 'TELEGRAM_AUTH_REJECTED',
  /**
   * HTTP 409 on the startup probe (in practice a webhook; a startup error), or on a later probe or three 409s in five
   * minutes while polling (a Telegram-only halt).
   */
  TELEGRAM_POLL_CONFLICT: 'TELEGRAM_POLL_CONFLICT',
  /** The poll loop failed unexpectedly (a defect): the Telegram side stopped, never the process (halt code only). */
  TELEGRAM_POLL_LOOP_FAILED: 'TELEGRAM_POLL_LOOP_FAILED',
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
  /** Set when the Telegram side stopped itself (mismatch, rejected token or a poll conflict found while running). */
  readonly halted?: TelegramStartupErrorCode;
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
/** The startup identity calls are bounded short (CA final check): at most ~2 x 5 s before Discord continues. */
export const STARTUP_CALL_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 15_000;
const DOCUMENT_TIMEOUT_MS = 30_000;
const STOP_CONFIRM_TIMEOUT_MS = 3_000;
const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 60_000 } as const;
/** A 429 on a send is retried once when Telegram asks for at most this long (a 429 confirms nothing was posted). */
const MAX_SEND_RETRY_AFTER_SECONDS = 10;
/** Telegram's typing indicator lasts about 5 s; refresh under that while a turn runs, for at most ~2 minutes. */
const TYPING_REFRESH_MS = 4_500;
const TYPING_MAX_TICKS = 27;
/**
 * CA P2-3: Telegram answers 409 to whichever `getUpdates` is NOT the newest, so two instances on one token keep taking
 * updates from each other. Three 409s within five minutes stop this instance's polling (`TELEGRAM_POLL_CONFLICT`).
 */
const CONFLICT_HALT_COUNT = 3;
/** Telegram's update retention: after this long with no update, the held offset is dropped once (CA re-review P2). */
const OFFSET_SILENCE_RESET_MS = 24 * 60 * 60_000;
const CONFLICT_WINDOW_MS = 5 * 60_000;
/** How often the runner-owned attachment temp directory is swept (the Discord adapter's interval). */
const ATTACHMENT_SWEEP_INTERVAL_MS = 60_000;
/**
 * TG-2 albums: Telegram delivers each part of an album (`media_group_id`) as its own message. The parts are held, with
 * the offset kept at the first one, and the album is re-polled after this wait; once a re-poll brings no new part (or
 * after {@link MEDIA_GROUP_MAX_ROUNDS} re-polls, or when anything else arrives) the parts are handed over as ONE turn,
 * and the offset moves past them in the same step.
 */
export const MEDIA_GROUP_SETTLE_MS = 800;
const MEDIA_GROUP_MAX_ROUNDS = 3;
/** Telegram's own album bound. A larger group is split; the ADR-0111 count bound applies to each turn. */
const MEDIA_GROUP_MAX_PARTS = 10;
/** How many recent owner message keys are remembered so a reaction on the owner's own message is dropped. */
const OWNER_MESSAGE_MEMORY = 512;

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

/** CA P3-4: the fixed owner notices (no content, no ids). */
export function staleNotice(count: number): string {
  return `꺼져 있던 동안 받은 메시지 ${count}개는 처리하지 않았어요. 필요하면 다시 보내 주세요.`;
}
/**
 * TG-2: the notice for an owner message with nothing to read (a location, contact, poll, …). Photos, files and captions
 * are taken in now; an unsupported file (a sticker, voice note, video) is named in the attachment note instead.
 */
export const UNSUPPORTED_MESSAGE_NOTICE = '이 형식의 Telegram 메시지는 아직 처리하지 않아요. 텍스트, 사진이나 파일로 보내 주세요.';

/** A hung notification send is UNCERTAIN after this (it may still land); the Discord sink's bound. */
const NOTIFICATION_SEND_TIMEOUT_MS = 20_000;

/** ADR-0101 D4 classification of a failed notification `sendMessage` (CA P1-1). */
export function notificationOutcomeOf(err: unknown): NotificationSinkOutcome {
  const code = err instanceof TelegramApiError ? err.code : undefined;
  switch (code) {
    case TelegramFailureCode.RATE_LIMITED:
      return { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: true };
    case TelegramFailureCode.AUTH:
    case TelegramFailureCode.FORBIDDEN:
      return { status: 'NOT_SENT', reason: 'MISSING_ACCESS', retryable: false };
    case TelegramFailureCode.BAD_REQUEST:
      return { status: 'NOT_SENT', reason: 'UNKNOWN_TARGET', retryable: false };
    case TelegramFailureCode.TIMEOUT:
      return { status: 'UNCERTAIN', reason: 'TIMEOUT' };
    case TelegramFailureCode.ABORTED:
      return { status: 'UNCERTAIN', reason: 'ABORTED' };
    case TelegramFailureCode.UNAVAILABLE:
      return { status: 'UNCERTAIN', reason: (err as TelegramApiError).httpStatus !== undefined ? 'PLATFORM_ERROR' : 'NETWORK_ERROR' };
    default:
      // A 2xx that could not be read, an oversized body or anything unclassified: it may have been posted.
      return { status: 'UNCERTAIN', reason: 'UNCLASSIFIED' };
  }
}

/** The signal of a send made while the adapter is not running (no stop to wait for). */
const NEVER_ABORTED = new AbortController().signal;

/** An outbound call refused before anything was sent (not verified, halted or stopped). */
class OutboundRefused extends Error {
  constructor(readonly method: TelegramMethod) {
    super(`telegram ${method}: NOT_CONNECTED`);
    this.name = 'OutboundRefused';
  }
}

function codeOf(error: unknown): string {
  if (error instanceof OutboundRefused) return 'NOT_CONNECTED';
  return error instanceof TelegramApiError ? error.code : 'UNEXPECTED';
}

export class TelegramPlatformAdapter implements PlatformAdapter, NotificationSink {
  readonly platform = TELEGRAM_PLATFORM;

  private readonly api: TelegramBotApi;
  private readonly owners: ReadonlySet<string>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly pollTimeoutSeconds: number;
  private readonly backoff: { readonly initialMs: number; readonly maxMs: number };
  private readonly offsetStore?: TelegramOffsetStore;
  private readonly startupCallTimeoutMs: number;
  /** The offset last written to the store. */
  private savedOffset?: number;

  private messageHandler?: InboundMessageHandler;
  private approvalHandler?: ApprovalDecisionHandler;
  private feedbackHandler?: PlatformFeedbackHandler;
  /** TG-2: bounded intake for admitted messages' attachments (fetched only through {@link files}). */
  private readonly attachmentIntake: TelegramAttachmentIntake;
  /** A true private field: a Node timer is circular, and the adapter must stay JSON-serializable (no token check). */
  #attachmentSweepTimer?: ReturnType<typeof setInterval>;
  private readonly mediaGroupSettleMs: number;
  /** TG-2: the album being collected (its parts are not handed over, and the offset stays at its first part). */
  private pendingGroup?: PendingMediaGroup;
  /** Keys of recent owner messages (bounded): a reaction on one of them is the owner's own message, never feedback. */
  private readonly ownerMessageKeys = new Set<string>();
  /**
   * TG-2: the guarded file access the attachment intake uses. Adapter-local (not part of `PlatformAdapter`); both calls
   * go through the outbound wrappers, so they make no Bot API call before verification, after a halt or after a stop.
   */
  readonly files: TelegramFileGateway;
  /** ADR-0102 D5: the composition root's startup identity gate; absent = open. */
  private inboundGate?: Promise<boolean>;

  private controller?: AbortController;
  /** The startup identity check while it runs (tracked so stop() aborts and awaits it). */
  private starting?: Promise<void>;
  private loop?: Promise<void>;
  private stopped = false;
  private polling = false;
  /** Why the Telegram side stopped on its own (identity, token or conflict found while running); Discord runs on. */
  private halted?: TelegramStartupErrorCode;
  private haltListener?: (code: TelegramStartupErrorCode) => void;
  private fatalListener?: (error: TelegramStartupError) => void;
  private pendingFatal?: TelegramStartupError;
  /** CA P3-4: the owner notices already sent in this poll session (at most one per kind). */
  private readonly noticesSent = new Set<`${string}:${'stale' | 'no-text'}`>();
  /** When the last non-empty batch arrived (or polling started), for the 24 h silence reset. */
  private lastUpdateAtMs = 0;
  /** The current `getUpdates` batch size (halved after an oversized response, reset after a success). */
  private pollLimit = POLL_LIMIT;
  /** When the recent HTTP 409s of the poll happened (ms), for the split-brain policy. */
  private conflicts: number[] = [];
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
    this.offsetStore = options.offsetStore;
    this.startupCallTimeoutMs = options.startupCallTimeoutMs ?? STARTUP_CALL_TIMEOUT_MS;
    this.mediaGroupSettleMs = options.mediaGroupSettleMs ?? MEDIA_GROUP_SETTLE_MS;
    this.files = {
      getFile: async (fileId) =>
        this.outbound('getFile', { file_id: fileId }, { timeoutMs: ATTACHMENT_DOWNLOAD_TIMEOUT_MS, ...this.lifecycleSignal() }),
      download: async (filePath, maxBytes) => this.outboundDownload(filePath, maxBytes),
    };
    this.attachmentIntake = new TelegramAttachmentIntake(this.files, options.attachments);
  }

  onMessage(handler: InboundMessageHandler): void {
    this.messageHandler = handler;
  }

  /** ADR-0098 D3 / ADR-0114 D9 (TG-2): admitted 👍/👎 reactions of the owner in their own private chat. */
  onFeedback(handler: PlatformFeedbackHandler): void {
    this.feedbackHandler = handler;
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
      ...(this.halted !== undefined ? { halted: this.halted } : {}),
      ...(this.lastPollAt !== undefined ? { lastPollAt: this.lastPollAt } : {}),
      admittedChatCount: this.admittedChats.size,
      droppedUpdates: { ...this.dropped },
    };
  }

  /**
   * The startup identity check (ADR-0102 D5, ADR-0114 D4/D5), bounded so a hanging Telegram never blocks Discord for
   * long: `getMe` and the non-confirming conflict probe each get {@link STARTUP_CALL_TIMEOUT_MS} (option
   * `startupCallTimeoutMs`).
   *
   * - A DEFINITIVE answer at startup is a typed startup error, as the ratified ADRs require (exit 78): a token or
   *   `getMe` naming another bot (`TELEGRAM_IDENTITY_MISMATCH`), a rejected token (`TELEGRAM_AUTH_REJECTED`), or HTTP
   *   409 on the probe (`TELEGRAM_POLL_CONFLICT`, in practice a webhook). Nothing is read.
   * - A transient or timed-out answer (CA P2-2) resolves `start()`: the identity is retried in the background with the
   *   poll backoff, and nothing is read or sent until `getMe` matches (`status().identityVerified`).
   * - A definitive answer from that background retry is still the startup check (nothing was verified yet): it fails
   *   closed and goes to `onFatal`, which the composition root turns into a graceful shutdown with exit 78.
   * - A definitive answer found AFTER the first verification (a 401, three 409s, a loop defect while polling) halts the
   *   Telegram side only (`status().halted`, `onHalt` → one owner operations notice): the ADRs say nothing about it,
   *   and stopping a serving process would take Discord down.
   */
  async start(): Promise<void> {
    if (this.loop !== undefined) return;
    if (this.starting !== undefined) return this.starting;
    this.stopped = false;
    this.halted = undefined;
    // CA final check / Codex delta P2-2: a restart verifies the identity afresh; nothing is sent until it matches again.
    this.identityVerified = false;
    this.conflicts = [];
    this.noticesSent.clear();
    this.pendingGroup = undefined;
    // Codex delta P2: a refusal held for a not-yet-registered fatal listener belongs to the previous run only.
    this.pendingFatal = undefined;
    // The token names its bot: a token for another bot fails before any network call.
    if (this.config.token.botId !== this.config.expectedBotId) {
      throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH);
    }
    if (this.offset === undefined) this.offset = this.loadOffset();
    // Codex final delta P2-1: the lifecycle controller exists before the first await, the startup calls carry its signal,
    // and the startup is tracked, so stop() aborts it and waits for it: nothing reaches the Bot API after a stop.
    const controller = new AbortController();
    this.controller = controller;
    // TG-2: the attachment temp directory is swept now and every minute (local files only; no Bot API call).
    if (this.#attachmentSweepTimer === undefined) {
      void this.attachmentIntake.sweep();
      const sweepTimer = setInterval(() => void this.attachmentIntake.sweep(), ATTACHMENT_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
      this.#attachmentSweepTimer = sweepTimer;
    }
    const starting = this.startUp(controller);
    this.starting = starting;
    try {
      await starting;
    } catch (err) {
      // A typed startup refusal: this adapter never ran, so its sweep timer goes too (the composite stops only children
      // that started).
      this.stopAttachmentSweep();
      throw err;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async startUp(controller: AbortController): Promise<void> {
    // Throws the typed startup error for a definitive answer; resolves 'transient' for an outage, a timeout or a stop.
    const first = await this.checkIdentity(controller.signal, this.startupCallTimeoutMs);
    if (this.stopped || controller.signal.aborted) return;
    // CA re-review P3-2: an unexpected rejection of the background loop must never become an unhandled rejection that
    // takes the process (and Discord) down; it halts the Telegram side only and is logged without content.
    this.loop = this.run(controller.signal, first === 'verified').catch((err: unknown) => {
      this.polling = false;
      // A rejection while stopping is the shutdown itself, not a defect: no halt, no notice.
      if (this.stopped) return;
      this.logger.error('telegram poll loop failed', { errorName: err instanceof Error ? err.name : typeof err });
      this.halt(TelegramStartupErrorCode.TELEGRAM_POLL_LOOP_FAILED);
    });
  }

  /**
   * One identity attempt: `getMe`, then a conflict probe that confirms nothing (no offset). Resolves `'verified'` or
   * `'transient'`; throws a {@link TelegramStartupError} for a definitive refusal.
   */
  private async checkIdentity(signal?: AbortSignal, timeoutMs: number = CALL_TIMEOUT_MS): Promise<'verified' | 'transient'> {
    let me: unknown;
    try {
      me = await this.api.call('getMe', {}, { timeoutMs, ...(signal ? { signal } : {}) });
    } catch (err) {
      // Stopped meanwhile: nothing is classified (an abort is never a refusal).
      if (signal?.aborted || this.stopped) return 'transient';
      if (codeOf(err) === TelegramFailureCode.AUTH) throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED);
      return 'transient';
    }
    // Stopped while getMe was in flight: its answer is not acted on (no probe, no verification).
    if (signal?.aborted || this.stopped) return 'transient';
    const id = (me as { id?: unknown } | null)?.id;
    const isBot = (me as { is_bot?: unknown } | null)?.is_bot;
    if (typeof id !== 'number' || String(id) !== this.config.expectedBotId || isBot !== true) {
      this.logger.error('telegram startup identity mismatch', { fields: 'bot' });
      throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH);
    }
    // HTTP 409 here reliably means a webhook is set; a second long-poller is caught by the runtime policy instead.
    try {
      await this.api.call('getUpdates', { limit: 1, timeout: 0 }, {
        timeoutMs,
        maxResponseBytes: POLL_MAX_RESPONSE_BYTES,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted || this.stopped) return 'transient';
      const code = codeOf(err);
      if (code === TelegramFailureCode.CONFLICT) throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT);
      if (code === TelegramFailureCode.AUTH) throw new TelegramStartupError(TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED);
      // Anything transient: the poll loop backs off and retries.
    }
    if (signal?.aborted || this.stopped) return 'transient';
    this.identityVerified = true;
    this.logger.info('telegram startup identity verified', { bot: 'match', owners: this.owners.size });
    return 'verified';
  }

  /**
   * Stop the Telegram side only (never the process): logged, exposed in `status().halted`, and reported ONCE to the
   * {@link onHalt} listener (the composition root sends one owner operations notice on Discord).
   */
  private halt(code: TelegramStartupErrorCode): void {
    if (this.halted !== undefined) return;
    this.halted = code;
    this.logger.error('telegram stopped', { code });
    try {
      this.haltListener?.(code);
    } catch {
      this.logger.warn('telegram halt listener failed', { code });
    }
  }

  private stopAttachmentSweep(): void {
    if (this.#attachmentSweepTimer) clearInterval(this.#attachmentSweepTimer);
    this.#attachmentSweepTimer = undefined;
  }

  /** Adapter-local (not part of `PlatformAdapter`): called once per halt with its code (CA re-review P3-3). */
  onHalt(listener: (code: TelegramStartupErrorCode) => void): void {
    this.haltListener = listener;
  }

  /**
   * Adapter-local: called once when the background retry of the STARTUP identity check (before the first successful
   * verification) gets a definitive answer — another bot, a rejected token, a webhook 409. That is still the startup
   * check of ADR-0102 D5 / ADR-0114 D4, so the composition root ends the process gracefully with exit 78. A refusal
   * found before a listener is registered is delivered on registration.
   */
  onFatal(listener: (error: TelegramStartupError) => void): void {
    this.fatalListener = listener;
    const pending = this.pendingFatal;
    this.pendingFatal = undefined;
    if (pending !== undefined) this.notifyFatal(pending);
  }

  /** Fail closed (nothing more is read or sent; `status().halted`) and hand the typed error to the fatal listener. */
  private failStartup(code: TelegramStartupErrorCode): void {
    if (this.halted !== undefined) return;
    this.halted = code;
    this.logger.error('telegram startup identity refused', { code });
    const error = new TelegramStartupError(code);
    if (this.fatalListener === undefined) this.pendingFatal = error;
    else this.notifyFatal(error);
  }

  private notifyFatal(error: TelegramStartupError): void {
    try {
      this.fatalListener?.(error);
    } catch {
      this.logger.warn('telegram fatal listener failed', { code: error.code });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.controller?.abort();
    // A startup still in flight is aborted and awaited: it can make no call after this.
    await this.starting?.catch(() => undefined);
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    this.controller = undefined;
    // TG-2: an album still being collected is not handed over; its parts stay unconfirmed and come back on restart.
    this.pendingGroup = undefined;
    this.stopAttachmentSweep();
    await this.attachmentIntake.dispose();
    // Confirm what was handed over, so the next start does not receive it again (best-effort, bounded). Only for a
    // verified, un-halted session (CA final check, Critical): an unverified or halted adapter reads nothing from Telegram,
    // not even on stop; the persisted offset still survives the restart.
    if (this.identityVerified && this.halted === undefined && this.offset !== undefined && this.offset !== this.confirmedOffset) {
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

  private async run(signal: AbortSignal, verified: boolean): Promise<void> {
    if (!verified && !(await this.verifyInBackground(signal))) return;
    this.polling = true;
    try {
      await this.poll(signal);
    } finally {
      this.polling = false;
    }
  }

  /** Retry the identity check with the poll backoff until it is verified (`true`), halted or stopped (`false`). */
  private async verifyInBackground(signal: AbortSignal): Promise<boolean> {
    let delay = this.backoff.initialMs;
    this.logger.warn('telegram identity unverifiable; retrying in the background', {
      code: TelegramStartupErrorCode.TELEGRAM_IDENTITY_UNVERIFIABLE,
      delayMs: delay,
    });
    while (!this.stopped) {
      await this.sleep(delay, signal);
      if (this.stopped) return false;
      delay = Math.min(this.backoff.maxMs, delay * 2);
      try {
        if ((await this.checkIdentity(signal)) === 'verified') return true;
      } catch (err) {
        if (err instanceof TelegramStartupError) {
          // Still the STARTUP identity check (nothing was verified yet): ADR-0102 D5 / ADR-0114 D4 — fatal, exit 78.
          this.failStartup(err.code);
          return false;
        }
      }
      if (!this.stopped) {
        this.logger.warn('telegram identity still unverifiable', { code: TelegramStartupErrorCode.TELEGRAM_IDENTITY_UNVERIFIABLE, delayMs: delay });
      }
    }
    return false;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let delay = this.backoff.initialMs;
    this.lastUpdateAtMs = this.nowMs();
    this.logger.info('telegram polling started');
    while (!this.stopped) {
      let updates: unknown;
      // CA re-review P2: after 24 h without any update, Telegram may have restarted update_id from a LOWER value that
      // the held offset would swallow; nothing older can still be pending, so poll once without an offset.
      if (this.offset !== undefined && this.nowMs() - this.lastUpdateAtMs > OFFSET_SILENCE_RESET_MS) {
        this.offset = undefined;
        this.lastUpdateAtMs = this.nowMs();
        this.logger.info('telegram offset reset after a silent day', { reason: 'no-updates-24h' });
      }
      const sentOffset = this.offset;
      try {
        updates = await this.api.call(
          'getUpdates',
          {
            ...(sentOffset !== undefined ? { offset: sentOffset } : {}),
            limit: this.pollLimit,
            timeout: this.pollTimeoutSeconds,
            // TG-2: reactions are not in Telegram's default set; they must be asked for (admission does not rely on it).
            allowed_updates: ['message', 'message_reaction'],
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
        // CA P3-5: a token rejected while running stops the Telegram side (a retry cannot help).
        if (codeOf(err) === TelegramFailureCode.AUTH) {
          this.halt(TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED);
          break;
        }
        // CA P3-1: a batch over the body bound is fetched in halves; one update alone over it is skipped (counted).
        if (codeOf(err) === TelegramFailureCode.RESPONSE_TOO_LARGE && this.shrinkOrSkip()) continue;
        // CA P2-3: repeated 409s mean another instance is polling this bot; stop rather than split the updates.
        if (codeOf(err) === TelegramFailureCode.CONFLICT && this.recordConflict()) {
          this.halt(TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT);
          break;
        }
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
      this.pollLimit = POLL_LIMIT;
      if (sentOffset !== undefined) this.confirmedOffset = sentOffset;
      this.lastPollAt = now();
      if (updates.length > 0) this.lastUpdateAtMs = this.nowMs();
      const before = this.offset;
      const proceed = await this.handleBatch(updates, signal);
      if (!proceed) break;
      // TG-2: an album still being collected is re-polled after a short wait (its parts are not confirmed yet).
      if (this.pendingGroup !== undefined) await this.sleep(this.mediaGroupSettleMs, signal);
      // A non-empty batch that moved nothing (entries without a usable update_id) must not spin.
      else if (updates.length > 0 && this.offset === before) await this.sleep(this.backoff.maxMs, signal);
    }
  }

  /**
   * After a body over the bound: halve the batch size down to 1 (`true`, poll again at once); at 1 with a known offset,
   * skip that single update (`offset + 1`, counted as `malformed`, `true`). Without a known offset nothing can be
   * skipped safely (`false`: the normal backoff applies).
   */
  private shrinkOrSkip(): boolean {
    if (this.pollLimit > 1) {
      this.pollLimit = Math.max(1, Math.floor(this.pollLimit / 2));
      this.logger.warn('telegram poll response too large; fetching fewer updates', { limit: this.pollLimit });
      return true;
    }
    if (this.offset === undefined) return false;
    this.offset += 1;
    this.persistOffset();
    this.dropped.malformed += 1;
    this.logger.warn('telegram update over the size bound skipped', { reason: 'malformed' });
    return true;
  }

  /** Record one HTTP 409; `true` once {@link CONFLICT_HALT_COUNT} fell within {@link CONFLICT_WINDOW_MS}. */
  private recordConflict(): boolean {
    const at = this.nowMs();
    this.conflicts = [...this.conflicts.filter((time) => at - time < CONFLICT_WINDOW_MS), at];
    return this.conflicts.length >= CONFLICT_HALT_COUNT;
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
    /** Owner drops per owner chat (CA re-review P3-1: each owner is told about their own messages only). */
    const ownerDrops = new Map<string, { stale: number; noText: number }>();
    for (const update of updates) {
      const updateId = updateIdOf(update);
      // Already handed over or dropped (a repeated entry): never processed twice.
      if (updateId !== undefined && this.offset !== undefined && updateId < this.offset) continue;
      // TG-2: a part of the album being collected, sent again because it is not confirmed yet.
      if (updateId !== undefined && this.pendingGroup !== undefined && updateId <= this.pendingGroup.lastUpdateId) continue;
      const admission = admitTelegramUpdate(update, this.owners, Math.floor(this.nowMs() / 1000));
      // Every admitted owner message (album parts included) is remembered: a reaction on it is never feedback.
      if (admission.kind === 'admitted') this.rememberOwnerMessage(admission.message.chatId, admission.message.messageId);
      if (admission.kind === 'admitted' && admission.message.mediaGroupId !== undefined && updateId !== undefined) {
        if (this.joinPendingGroup(admission.message, updateId)) continue;
        // Another album, or a full one: the collected one goes first, then this part starts a new one.
        if (!(await this.flushPendingGroup(signal))) return false;
        this.pendingGroup = { parts: [admission.message], lastUpdateId: updateId, grew: true, rounds: 0 };
        continue;
      }
      // Anything else after an album part means the album is complete: it is handed over first, in order.
      if (!(await this.flushPendingGroup(signal))) return false;
      if (admission.kind === 'admitted' || admission.kind === 'reaction') {
        // ADR-0102 D5: nothing is handed over unless the startup identity gate opened; the offset stays put.
        if (!(await this.inboundGateOpen(signal))) return false;
        // Hand over, then advance and persist in the same synchronous step (no await in between): a restart resumes
        // after this update, so the turn is never handed over twice. TG-2 (Codex P1): a message with attachments is
        // handed over only after its intake finished; a stop or halt during the intake hands nothing over and leaves the
        // offset (in memory and on disk) where it was, so a restart delivers the update again.
        if (admission.kind === 'admitted') {
          if (!(await this.handOver(admission.message, signal))) return false;
        } else {
          this.dispatchFeedback(admission.reaction);
        }
        if (updateId !== undefined) this.offset = updateId + 1;
        this.persistOffset();
        continue;
      }
      this.dropped[admission.reason] += 1;
      if (admission.ownerChatId !== undefined) {
        const drops = ownerDrops.get(admission.ownerChatId) ?? { stale: 0, noText: 0 };
        ownerDrops.set(admission.ownerChatId, drops);
        if (admission.reason === 'stale') drops.stale += 1;
        if (admission.reason === 'no-text') drops.noText += 1;
      }
      if (updateId !== undefined) this.offset = updateId + 1;
    }
    // TG-2: the album is complete once a re-poll brought no new part (or after the bounded re-polls).
    const group = this.pendingGroup;
    if (group !== undefined) {
      if (!group.grew || group.rounds >= MEDIA_GROUP_MAX_ROUNDS) {
        if (!(await this.flushPendingGroup(signal))) return false;
      } else {
        group.grew = false;
        group.rounds += 1;
      }
    }
    this.persistOffset();
    for (const [chatId, drops] of ownerDrops) this.noticeOwnerDrops(chatId, drops, signal);
    return true;
  }

  /** Add an album part to the collected album when it is the same album of the same chat and not full. */
  private joinPendingGroup(message: AdmittedTelegramMessage, updateId: number): boolean {
    const group = this.pendingGroup;
    const first = group?.parts[0];
    if (group === undefined || first === undefined) return false;
    if (first.chatId !== message.chatId || first.mediaGroupId !== message.mediaGroupId || group.parts.length >= MEDIA_GROUP_MAX_PARTS) {
      return false;
    }
    group.parts.push(message);
    group.lastUpdateId = updateId;
    group.grew = true;
    return true;
  }

  /**
   * Hand the collected album over as ONE turn and move the offset past its parts in the same synchronous step, after the
   * album's intake finished. `false` when the identity gate is closed or the adapter stopped or halted meanwhile: nothing
   * is handed over and the offset stays at the album's first part.
   */
  private async flushPendingGroup(signal: AbortSignal): Promise<boolean> {
    const group = this.pendingGroup;
    if (group === undefined) return true;
    if (!(await this.inboundGateOpen(signal))) {
      this.pendingGroup = undefined;
      return false;
    }
    // Stopped while waiting for the gate: nothing is handed over.
    if (this.pendingGroup !== group) return false;
    this.pendingGroup = undefined;
    if (!(await this.handOver(mergeAlbum(group.parts), signal))) return false;
    this.offset = group.lastUpdateId + 1;
    this.persistOffset();
    return true;
  }

  /**
   * CA P3-4: one fixed notice per (owner chat, kind) per poll session to that OWNER's own private chat when their messages were not
   * processed (old messages after downtime; messages with no text). Nothing for anyone else; no content echoed.
   */
  private noticeOwnerDrops(chatId: string, drops: { readonly stale: number; readonly noText: number }, signal: AbortSignal): void {
    const notices: Array<{ kind: 'stale' | 'no-text'; text: string }> = [];
    if (drops.stale > 0 && !this.noticesSent.has(`${chatId}:stale`)) {
      notices.push({ kind: 'stale', text: staleNotice(drops.stale) });
    }
    if (drops.noText > 0 && !this.noticesSent.has(`${chatId}:no-text`)) {
      notices.push({ kind: 'no-text', text: UNSUPPORTED_MESSAGE_NOTICE });
    }
    for (const notice of notices) {
      this.noticesSent.add(`${chatId}:${notice.kind}`);
      void (async () => {
        // ADR-0102 D5: no adapter-side effect before the startup identity gate opens.
        if (!(await this.inboundGateOpen(signal)) || !this.connected()) return;
        if (this.ownerChatOf({ platform: TELEGRAM_PLATFORM, channelId: chatId, userId: chatId }) === undefined) return;
        try {
          await this.postMessage(chatId, notice.text, false);
          this.logger.info('telegram owner notice sent', { kind: notice.kind });
        } catch (err) {
          this.logger.warn('telegram owner notice failed', { kind: notice.kind, code: codeOf(err) });
        }
      })();
    }
  }

  private loadOffset(): number | undefined {
    try {
      const offset = this.offsetStore?.load();
      if (offset === undefined) return undefined;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid offset');
      this.savedOffset = offset;
      return offset;
    } catch {
      this.logger.warn('telegram offset store unreadable; resuming from Telegram confirmation', { code: 'TELEGRAM_OFFSET_UNREADABLE' });
      return undefined;
    }
  }

  /** Write the offset when it moved (atomic in the store). A failure is logged; polling goes on. */
  private persistOffset(): void {
    if (this.offsetStore === undefined || this.offset === undefined || this.offset === this.savedOffset) return;
    try {
      this.offsetStore.save(this.offset);
      this.savedOffset = this.offset;
    } catch {
      this.logger.warn('telegram offset could not be saved', { code: 'TELEGRAM_OFFSET_SAVE_FAILED' });
    }
  }

  /**
   * Hand one admitted message to the runtime; the turn runs on, polling does not wait for it. Resolves `true` once the
   * handler WAS CALLED (or there is no handler), so the caller then advances the offset in the same synchronous step.
   *
   * A message with attachments first goes through the bounded intake (TG-2), which the poll loop awaits: it runs only
   * after admission and the identity gate, its temp files live only for the turn, and the handler is called only after
   * it finished (Codex P1: the offset is never saved past an update whose turn has not started). When the adapter
   * stopped or halted meanwhile, the intake's files are released, nothing is handed over, and `false` stops polling with
   * the offset unmoved.
   */
  private async handOver(message: AdmittedTelegramMessage, signal: AbortSignal): Promise<boolean> {
    const handler = this.messageHandler;
    if (!handler) return true;
    this.admittedChats.add(message.chatId);
    const sources = message.attachments ?? [];
    this.logger.info('message received', {
      platform: TELEGRAM_PLATFORM,
      messageId: message.messageId,
      ...(sources.length > 0 ? { attachmentCount: sources.length } : {}),
    });
    const failed = (err: unknown): void =>
      this.logger.error('message handling failed', { errorName: err instanceof Error ? err.name : typeof err });
    if (sources.length === 0) {
      void handler(this.toInbound(message)).catch(failed);
      return true;
    }
    const intake = await this.attachmentIntake.intake(sources);
    const abandoned = (): boolean => signal.aborted || !this.connected();
    if (!abandoned()) await this.reportAttachmentIntake(message, intake);
    if (abandoned()) {
      await intake.release();
      this.logger.info('attachment turn not handed over: telegram stopping', { platform: TELEGRAM_PLATFORM, messageId: message.messageId });
      return false;
    }
    // The handler is called synchronously here (before this method returns), then the files go after the turn.
    void (async () => {
      try {
        await handler(this.toInbound(message, intake.attachments));
      } finally {
        await intake.release();
      }
    })().catch(failed);
    return true;
  }

  /** Remember an owner message key (bounded, oldest first out). */
  private rememberOwnerMessage(chatId: string, messageId: string): void {
    this.ownerMessageKeys.add(telegramMessageKey(chatId, messageId));
    if (this.ownerMessageKeys.size > OWNER_MESSAGE_MEMORY) {
      const oldest = this.ownerMessageKeys.values().next().value;
      if (oldest !== undefined) this.ownerMessageKeys.delete(oldest);
    }
  }

  /**
   * ADR-0111 D2/D3 (TG-2): content-free counts and one line per refused attachment in the log, and, when an attachment
   * was not taken in, one deterministic note to the owner's chat naming it and why. Never echoes content.
   */
  private async reportAttachmentIntake(message: AdmittedTelegramMessage, intake: AttachmentIntakeResult): Promise<void> {
    this.logger.info('attachment intake', { platform: TELEGRAM_PLATFORM, messageId: message.messageId, ...summarizeAttachmentIntake(intake.attachments) });
    for (const diagnostic of intake.diagnostics) {
      this.logger.info('attachment refused', { platform: TELEGRAM_PLATFORM, messageId: message.messageId, ...diagnostic });
    }
    const note = renderAttachmentIntakeNote(intake.attachments);
    if (note === undefined || this.ownerChatOf({ platform: TELEGRAM_PLATFORM, channelId: message.chatId, userId: message.userId }) === undefined) {
      return;
    }
    try {
      await this.postMessage(message.chatId, note, false);
    } catch (err) {
      this.logger.warn('attachment intake note send failed', { platform: TELEGRAM_PLATFORM, code: codeOf(err) });
    }
  }

  /**
   * ADR-0098 D3 (TG-2): one feedback signal per 👍/👎 change. A reaction on a message the owner wrote (remembered key) is
   * dropped; otherwise Core links the target only to a reply the adapter reported posting. Nothing is ever sent back.
   */
  private dispatchFeedback(reaction: AdmittedTelegramReaction): void {
    const key = telegramMessageKey(reaction.chatId, reaction.messageId);
    if (this.ownerMessageKeys.has(key)) {
      this.dropped['not-feedback'] += 1;
      return;
    }
    const handler = this.feedbackHandler;
    if (!handler) return;
    const context: ConversationContext = { platform: TELEGRAM_PLATFORM, channelId: reaction.chatId, userId: reaction.userId, direct: true };
    void (async () => {
      for (const change of reaction.changes) {
        await handler({ platform: TELEGRAM_PLATFORM, context, targetPlatformMessageId: key, rating: change.rating, action: change.action, occurredAt: now() });
      }
    })().catch((err: unknown) =>
      this.logger.warn('feedback reaction handling failed', { errorName: err instanceof Error ? err.name : typeof err }),
    );
  }

  private toInbound(message: AdmittedTelegramMessage, attachments?: readonly InboundAttachment[]): InboundMessage {
    const context: ConversationContext = {
      platform: TELEGRAM_PLATFORM,
      channelId: message.chatId,
      userId: message.userId,
      // Admission admits only the owner's own private chat with the bot.
      direct: true,
    };
    return {
      id: message.messageId,
      context,
      text: message.text,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      receivedAt: now(),
    };
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
    // Codex delta P2: nothing goes to Telegram before getMe matched, or once the Telegram side halted or stopped (the
    // Discord adapter likewise skips a send while it is not connected).
    if (!this.connected()) {
      this.logger.warn('send skipped: telegram not connected', { platform: TELEGRAM_PLATFORM });
      return receipt;
    }
    // TG-2: ids are scoped by the chat (Telegram message ids are unique only inside one chat), the same key a
    // reaction on that message carries.
    const record = (id: string): void => {
      if (id !== '') platformMessageIds.push(telegramMessageKey(chatId, id));
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
      return await this.outbound(method, params(), { timeoutMs });
    } catch (err) {
      const retryAfter = err instanceof TelegramApiError && err.code === TelegramFailureCode.RATE_LIMITED ? err.retryAfterSeconds : undefined;
      if (retryAfter === undefined || retryAfter > MAX_SEND_RETRY_AFTER_SECONDS) throw err;
      // CA P3-6: the wait ends at stop(), and nothing is sent after it.
      const signal = this.controller?.signal ?? NEVER_ABORTED;
      await this.sleep(retryAfter * 1000, signal);
      // Codex delta P2-1: re-checked before the retry: a halt (for example a 401 on the poll) during the wait sends nothing.
      if (signal.aborted) throw new TelegramApiError(TelegramFailureCode.ABORTED, method);
      return this.outbound(method, params(), { timeoutMs, signal });
    }
  }

  async sendTyping(context: ConversationContext): Promise<void> {
    const chatId = this.ownerChatOf(context);
    if (chatId === undefined || !this.connected()) return;
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

  /**
   * THE outbound path (CA final check suggestion): every Bot API call that is not part of the lifecycle — `sendMessage`,
   * `sendDocument`, `sendChatAction`, each retry — goes through here and is refused, with nothing sent, unless the
   * adapter is verified, un-halted and running. The lifecycle reads (`getMe`, the probe, the poll, the stop confirm)
   * are the only other `api.call` sites; a source-scan test pins that list.
   */
  private async outbound(method: TelegramMethod, params: Record<string, unknown> | FormData, options: TelegramCallOptions): Promise<unknown> {
    if (!this.connected()) throw new OutboundRefused(method);
    return this.api.call(method, params, options);
  }

  /**
   * TG-2: THE file download path, guarded exactly like {@link outbound}: refused, with nothing fetched, unless verified,
   * un-halted and running, and cancelled by `stop()`. The download URL (it carries the token) is built inside the Bot
   * API client only; a failure is a fixed code.
   */
  private async outboundDownload(filePath: string, maxBytes: number): Promise<Buffer> {
    if (!this.connected()) throw new OutboundRefused('downloadFile');
    return this.api.download(filePath, { timeoutMs: ATTACHMENT_DOWNLOAD_TIMEOUT_MS, maxResponseBytes: maxBytes, ...this.lifecycleSignal() });
  }

  /** The running lifecycle's abort signal (stop cancels the call), when there is one. */
  private lifecycleSignal(): { signal?: AbortSignal } {
    const signal = this.controller?.signal;
    return signal ? { signal } : {};
  }

  /** Outbound is allowed only after `getMe` matched and while the Telegram side is neither halted nor stopped. */
  private connected(): boolean {
    return this.identityVerified && this.halted === undefined && !this.stopped;
  }

  private async pumpTyping(chatId: string): Promise<void> {
    if (!this.connected()) return;
    await this.outbound('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: CALL_TIMEOUT_MS }).catch(() => undefined);
  }

  private clearTyping(chatId: string): void {
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
    }
  }

  /**
   * ADR-0101 D4 / ADR-0114 D11 (CA P1-1): the owner-only notification sink for a reminder or brief created in a
   * Telegram private chat. The target must be a listed owner's own private chat (rechecked here). At most once: exactly
   * one `sendMessage`, never retried here (not even after a 429), and a text that does not fit ONE message is
   * `TEXT_TOO_LONG` (no multi-part notification, as on Discord). Never throws for a delivery failure; it classifies it:
   * a 429 is `NOT_SENT` retryable, an auth/forbidden/bad request is `NOT_SENT` final, and a timeout, network error,
   * abort or an unusable 2xx is `UNCERTAIN` (the message may have been posted). Logs ids and the outcome only.
   */
  async deliver(notification: OwnerNotification): Promise<NotificationSinkOutcome> {
    const outcome = await this.deliverOnce(notification);
    const log = outcome.status === 'SENT' ? this.logger.info : this.logger.warn;
    log.call(this.logger, 'owner notification delivery', {
      platform: TELEGRAM_PLATFORM,
      correlationId: notification.correlationId,
      kind: notification.kind,
      status: outcome.status,
      ...(outcome.status === 'SENT' ? { via: outcome.via } : { reason: outcome.reason }),
      ...(outcome.status === 'NOT_SENT' ? { retryable: outcome.retryable } : {}),
    });
    return outcome;
  }

  private async deliverOnce(notification: OwnerNotification): Promise<NotificationSinkOutcome> {
    const notSent = (reason: NotificationNotSentReason, retryable: boolean): NotificationSinkOutcome => ({ status: 'NOT_SENT', reason, retryable });
    const { target } = notification;
    if (target.platform !== TELEGRAM_PLATFORM) return notSent('TARGET_NOT_ADMITTED', false);
    if (!this.owners.has(target.userId)) return notSent('NOT_OWNER', false);
    const chatId = this.ownerChatOf(target);
    if (chatId === undefined || chatId !== target.userId) return notSent('TARGET_NOT_ADMITTED', false);
    // Not started, identity not (yet) verified, halted or stopped: nothing was sent; the dispatcher may retry.
    if (!this.connected() || this.loop === undefined) {
      return notSent('NOT_CONNECTED', true);
    }
    if (contentDisagreesWithText(notification)) {
      this.logger.warn('owner notification content and text disagree', { platform: TELEGRAM_PLATFORM, kind: notification.kind });
    }
    const text = notification.content !== undefined ? renderTelegramContent(notification.content) : notification.text;
    // CA re-review P3-6: an empty text is its own refusal, never "too long".
    if (text.trim().length === 0) return notSent('EMPTY_TEXT', false);
    if ([...text].length > REMINDER_LIMITS.maxDeliveredTextChars || text.length > TELEGRAM_MESSAGE_LIMIT) {
      return notSent('TEXT_TOO_LONG', false);
    }
    try {
      await this.outbound(
        'sendMessage',
        { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
        { timeoutMs: NOTIFICATION_SEND_TIMEOUT_MS },
      );
      return { status: 'SENT', via: 'dm' };
    } catch (err) {
      // Refused before anything was sent (the adapter stopped or halted meanwhile): confirmed not transmitted.
      if (err instanceof OutboundRefused) return { status: 'NOT_SENT', reason: 'NOT_CONNECTED', retryable: true };
      return notificationOutcomeOf(err);
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

/** TG-2: the album being collected; `grew` is whether the last poll added a part. */
interface PendingMediaGroup {
  readonly parts: AdmittedTelegramMessage[];
  lastUpdateId: number;
  grew: boolean;
  rounds: number;
}

/**
 * One turn from the parts of an album: the first part's ids, every non-empty caption in order (normally one), and the
 * attachments of all parts in order (the intake's count bound then applies to the whole album).
 */
function mergeAlbum(parts: readonly AdmittedTelegramMessage[]): AdmittedTelegramMessage {
  const first = parts[0] as AdmittedTelegramMessage;
  if (parts.length === 1) return first;
  const text = parts.map((part) => part.text).filter((caption) => caption.trim().length > 0).join('\n');
  const attachments = parts.flatMap((part) => part.attachments ?? []);
  return { ...first, text, attachments };
}
