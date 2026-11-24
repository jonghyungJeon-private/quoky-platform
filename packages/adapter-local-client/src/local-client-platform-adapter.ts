import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

import { NotImplementedError } from '@quoky/core';
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
import { SignInRateLimiter, newSecret, removeTokenFile, writeTokenFile } from '@quoky/local-auth';

import { LOCAL_CLIENT_CHANNEL_ID, LOCAL_CLIENT_PLATFORM, TOKEN_FILE_NAME } from './constants';
import type { LocalClientDisableReason } from './constants';
import { EventHub } from './events';
import { createLocalClientServer } from './http';
import type { TurnRequest } from './http';
import { IdempotencyRing } from './idempotency';
import { renderReply } from './render';
import { bindSocket, identityOf, preflightSocketPath, releaseSocket, sameIdentity } from './socket';
import type { FileIdentity } from './socket';

/**
 * LocalClientPlatformAdapter (ADR-0125 D1-D6, D9; slice LC-1b, text turns only).
 *
 * The same-host macOS client talks HTTP/1.1 over a Unix domain socket in the 0700 host data directory, with a per-start
 * Bearer token as defence in depth. The adapter is one more face of the chat surface: it turns an owner turn into an
 * `InboundMessage` (adapter-minted `lc-<uuid>` id, `direct: true`, the D5 owner) and renders replies as SSE events.
 * It never calls a provider, a connector, storage, git or a workspace. No buttons, no notices of its own (LC-4):
 * a `local-client` notification target is routed to the owner's Discord DM by the composition root (D8).
 *
 * Any start refusal disables only this adapter (a typed reason, logged as a code) and resolves `start()`: the rest of
 * Quoky starts. The adapter takes the ADR-0102 D5 inbound gate: until it resolves `true`, turns are `503 NOT_READY`.
 */

export interface LocalClientAdapterOptions {
  /** The ADR-0102 D3 host data directory (the database's directory). */
  readonly dataDir: string;
  /** ADR-0102 D4: the single-instance lock is held. */
  readonly instanceLockHeld: boolean;
  /** The database is a file (not `:memory:`). */
  readonly fileBackedDb: boolean;
  /** D5: the configured Discord owner id the surface maps to (the `userId` of every turn). */
  readonly ownerUserId: string | undefined;
  /** D5: resolves through the ADR-0009 seam; true only when the owner maps to exactly one Actor. Called at start. */
  readonly verifyOwner: () => Promise<boolean>;
  /** D5: the configured id is one of `QUOKY_DISCORD_OWNER_IDS`. */
  readonly ownerIsDiscordOwner: boolean;
  readonly logger: Logger;
  /** Test seams; production passes none. */
  readonly nowMs?: () => number;
  readonly probeTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly maxTurnsPerMinute?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/** Content-free status for the OPS-UI panel (D12): no content, id, path or token can be expressed. */
export interface LocalClientAdapterStatus {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly openStreams: number;
  readonly lastTurnAt?: string;
  readonly authFailuresLastHour: number;
  readonly disabledReason?: LocalClientDisableReason;
}

const HOUR_MS = 3_600_000;
const MAX_TRACKED_FAILURES = 1_000;

export class LocalClientPlatformAdapter implements PlatformAdapter {
  readonly platform = LOCAL_CLIENT_PLATFORM;

  private handler: InboundMessageHandler | undefined;
  private ready = true;
  private disabled: LocalClientDisableReason | undefined;
  private server: http.Server | undefined;
  private socketPath: string | undefined;
  private socketIdentity: FileIdentity | undefined;
  private tokenPath: string | undefined;
  private tokenIdentity: FileIdentity | undefined;
  private token = '';
  private lastTurnAt: number | undefined;
  private authFailures: number[] = [];
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly nowMs: () => number;
  private readonly hub: EventHub;
  private readonly dedupe: IdempotencyRing;
  private readonly limiter: SignInRateLimiter;

  constructor(private readonly options: LocalClientAdapterOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.hub = new EventHub({
      // A random 64-bit value per start; hex keeps it inside the opaque-id charset.
      epoch: randomBytes(8).toString('hex'),
      now: this.nowMs,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    });
    this.dedupe = new IdempotencyRing(this.nowMs);
    this.limiter = new SignInRateLimiter(this.nowMs);
  }

  /** The process epoch (random per start); every response and event carries it. */
  get epoch(): string {
    return this.hub.epoch;
  }

  /** D4 / ADR-0102 D5 (adapter-local): turns are `503 NOT_READY` until the gate resolves `true`; `false` stops the adapter. */
  gateInbound(gate: Promise<boolean>): void {
    this.ready = false;
    void gate.then(
      (verified) => {
        if (verified) this.ready = true;
        else {
          this.disabled ??= 'INBOUND_GATE_CLOSED';
          void this.stop();
        }
      },
      () => {
        this.disabled ??= 'INBOUND_GATE_CLOSED';
        void this.stop();
      },
    );
  }

  status(): LocalClientAdapterStatus {
    const since = this.nowMs() - HOUR_MS;
    return {
      enabled: this.disabled === undefined,
      listening: this.server?.listening === true && this.disabled === undefined && !this.stopped,
      openStreams: this.hub.openStreams,
      ...(this.lastTurnAt === undefined ? {} : { lastTurnAt: new Date(this.lastTurnAt).toISOString() }),
      authFailuresLastHour: this.authFailures.filter((at) => at >= since).length,
      ...(this.disabled === undefined ? {} : { disabledReason: this.disabled }),
    };
  }

  async start(): Promise<void> {
    try {
      await this.startSurface();
    } catch {
      await this.disable('SOCKET_BIND_FAILED');
    }
    // A stop (the inbound gate resolving `false`) may have arrived while the sockets were being set up: finish it.
    if (this.stopped) await this.stop();
  }

  private async startSurface(): Promise<void> {
    const { ownerUserId } = this.options;
    // D5 first: fail closed with a reason before anything touches the file system.
    if (ownerUserId === undefined || ownerUserId.length === 0) return this.disable('OWNER_NOT_CONFIGURED');
    if (!this.options.ownerIsDiscordOwner) return this.disable('OWNER_NOT_DISCORD_OWNER');
    let resolved = false;
    try {
      resolved = await this.options.verifyOwner();
    } catch {
      resolved = false;
    }
    if (!resolved) return this.disable('OWNER_UNRESOLVED');

    const uid = process.getuid?.();
    const pre = await preflightSocketPath({
      dataDir: this.options.dataDir,
      instanceLockHeld: this.options.instanceLockHeld,
      fileBackedDb: this.options.fileBackedDb,
      ...(uid === undefined ? {} : { uid }),
      ...(this.options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: this.options.probeTimeoutMs }),
    });
    if (!pre.ok) return this.disable(pre.reason);
    if (uid === undefined) return this.disable('DATA_DIR_UNSAFE');

    const server = createLocalClientServer({
      hub: this.hub,
      dedupe: this.dedupe,
      limiter: this.limiter,
      nowMs: this.nowMs,
      token: () => this.token,
      isReady: () => this.ready && this.handler !== undefined && this.disabled === undefined,
      statusWord: () => (this.ready ? 'ready' : 'starting'),
      mintTurnId: () => `lc-${randomUUID()}`,
      onTurn: (turn) => this.dispatch(turn),
      rotate: () => this.rotate(),
      recordAuthFailure: () => {
        this.authFailures.push(this.nowMs());
        if (this.authFailures.length > MAX_TRACKED_FAILURES) this.authFailures.shift();
      },
      ...(this.options.maxTurnsPerMinute === undefined ? {} : { maxTurnsPerMinute: this.options.maxTurnsPerMinute }),
      ...(this.options.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: this.options.headersTimeoutMs }),
      ...(this.options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.options.requestTimeoutMs }),
    });
    this.server = server;
    this.socketPath = pre.socketPath;
    const bound = await bindSocket(server, pre.socketPath, uid);
    if (!bound.ok) {
      this.server = undefined;
      return this.disable(bound.reason);
    }
    this.socketIdentity = bound.identity;

    // D3: the token file only after the socket checks; a failed write closes the server and disables this adapter.
    const token = newSecret();
    const tokenPath = path.join(path.dirname(pre.socketPath), TOKEN_FILE_NAME);
    const written = writeTokenFile(tokenPath, token);
    if (!written.ok) return this.disable('TOKEN_FILE_FAILED');
    this.tokenPath = tokenPath;
    this.tokenIdentity = identityOfFile(tokenPath);
    this.token = token;
    this.options.logger.info('local-client.listening', { epoch: this.hub.epoch });
  }

  /** D3: a new token file, the old token invalid at once, every open stream closed. Never returns the token. */
  private rotate(): boolean {
    if (this.tokenPath === undefined) return false;
    const token = newSecret();
    const written = writeTokenFile(this.tokenPath, token);
    if (!written.ok) {
      // The old file is gone and the old token must not outlive it: fail closed.
      this.token = '';
      void this.disable('TOKEN_ROTATION_FAILED');
      return false;
    }
    this.token = token;
    this.tokenIdentity = identityOfFile(this.tokenPath);
    this.hub.closeAllStreams();
    return true;
  }

  private dispatch(turn: TurnRequest): void {
    const handler = this.handler;
    if (handler === undefined || this.options.ownerUserId === undefined) return;
    this.lastTurnAt = this.nowMs();
    const context: ConversationContext = {
      platform: LOCAL_CLIENT_PLATFORM,
      channelId: LOCAL_CLIENT_CHANNEL_ID,
      userId: this.options.ownerUserId,
      direct: true,
      ...(turn.threadId === undefined ? {} : { threadId: turn.threadId }),
    };
    const message: InboundMessage = {
      // Adapter-minted (P2-3): a client-chosen value never becomes the message id.
      id: turn.turnId,
      context,
      text: turn.text,
      receivedAt: new Date(this.nowMs()).toISOString(),
      ...(turn.replyToEventId === undefined ? {} : { replyTo: { messageId: turn.replyToEventId } }),
    };
    void handler(message).catch((err: unknown) => {
      this.options.logger.error('local-client.turn-failed', { error: err instanceof Error ? err.name : 'unknown' });
    });
  }

  async stop(): Promise<void> {
    // Serialized and idempotent: a second call (or one racing `start()`) runs the same cleanup again, which is a no-op.
    this.chain = this.chain.then(() => this.shutdown());
    await this.chain;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.hub.closeAllStreams();
    const server = this.server;
    this.server = undefined;
    // D2 end of life, in this order and before the ADR-0102 D4 lock is released: socket, then token file, each only
    // while its recorded (dev, ino) still matches.
    if (server !== undefined && this.socketPath !== undefined) await releaseSocket(server, this.socketPath, this.socketIdentity);
    if (this.tokenPath !== undefined) {
      const current = identityOfFile(this.tokenPath);
      if (sameIdentity(current, this.tokenIdentity)) removeTokenFile(this.tokenPath);
    }
    this.token = '';
  }

  private async disable(reason: LocalClientDisableReason): Promise<void> {
    this.disabled ??= reason;
    this.options.logger.warn('local-client.disabled', { reason: this.disabled });
    await this.stop();
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
  }

  onApprovalDecision(_handler: ApprovalDecisionHandler): void {
    // ADR-0125 D7 / LC-4: no buttons here; decisions arrive as owner text through the ordinary turn.
  }

  async sendMessage(message: OutboundMessage): Promise<void | OutboundDeliveryReceipt> {
    if (message.context.platform !== LOCAL_CLIENT_PLATFORM || this.disabled !== undefined || this.stopped) {
      return { platformMessageIds: [] };
    }
    const rendered = renderReply(message);
    const turnId = message.replyToMessageId !== undefined && /^lc-[0-9a-f-]{36}$/.test(message.replyToMessageId) ? message.replyToMessageId : undefined;
    const event = this.hub.publish('reply', {
      ...(turnId === undefined ? {} : { turnId }),
      ...(message.context.threadId === undefined ? {} : { threadId: message.context.threadId }),
      text: rendered.text,
      content: rendered.content,
    });
    // The SSE id is the receipt's message id (ADR-0098 D3), so Core can match a `replyTo` against it.
    return { platformMessageIds: [event.id] };
  }

  async sendTyping(context: ConversationContext): Promise<void> {
    if (context.platform !== LOCAL_CLIENT_PLATFORM || this.disabled !== undefined || this.stopped) return;
    this.hub.publish('typing', context.threadId === undefined ? {} : { threadId: context.threadId });
  }

  async requestApproval(_request: ApprovalRequest, _context: ConversationContext): Promise<void> {
    // ADR-0125 D7: buttons are LC-4 and need their own flag; approvals are text here.
    throw new NotImplementedError('LocalClientPlatformAdapter.requestApproval');
  }
}

function identityOfFile(target: string): FileIdentity | undefined {
  try {
    return identityOf(lstatSync(target, { bigint: true }));
  } catch {
    return undefined;
  }
}
