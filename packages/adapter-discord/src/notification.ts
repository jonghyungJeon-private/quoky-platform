import { REMINDER_LIMITS } from '@quoky/core';
import { renderNotificationForDiscord } from './rendering';
import type {
  Logger,
  NotificationNotSentReason,
  NotificationSinkOutcome,
  NotificationUncertainReason,
  OwnerNotification,
} from '@quoky/core';

/**
 * Owner-only outbound notification delivery for the Discord adapter (ADR-0101 D4/D8, mirrors the ADR-0091 gate).
 *
 * Pure of discord.js: the adapter injects channel resolution, so every branch is testable offline. The function
 * NEVER throws for a delivery failure; it classifies it:
 *  - `SENT{via}`: the platform confirmed the message was created.
 *  - `NOT_SENT{reason, retryable}`: confirmed NOT transmitted (pre-send validation, 4xx refusals, a rate-limit
 *    rejection, a channel that could not be resolved before any send was attempted).
 *  - `UNCERTAIN{reason}`: the send may have reached the platform (timeout, network error, 5xx, anything
 *    unclassified once the send call started). When in doubt: UNCERTAIN. It is never retried or re-routed.
 */

export const DISCORD_NOTIFICATION_PLATFORM = 'discord';
/** Discord's hard message limit; the mention prefix must still fit under it. */
const DISCORD_MESSAGE_LIMIT = 2_000;
/** A hung send must not block the dispatcher tick forever; it is then UNCERTAIN (it may still land). */
export const DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS = 20_000;
/** Target resolution (channel / DM fetch) is bounded too: a stalled or rate-limited fetch must not block the dispatcher. */
export const DEFAULT_NOTIFICATION_RESOLVE_TIMEOUT_MS = 10_000;

export interface NotificationAllowedMentions {
  /** Always empty: no role/everyone/user mention is ever parsed out of the text. */
  parse: never[];
  /** Present only for a guild send: the owner. */
  users?: string[];
}

export interface NotificationSendOptions {
  content: string;
  allowedMentions: NotificationAllowedMentions;
}

/** Structural stand-in for a sendable Discord channel / DM channel. */
export interface NotificationChannel {
  send(options: NotificationSendOptions): Promise<unknown>;
}

export interface OwnerNotificationDeps {
  readonly ownerIds: readonly string[];
  /** Allowlisted guild channel ids (a thread is admitted by its own id or its parent channel id). */
  readonly channelIds: readonly string[];
  /** If set, a guild target in another guild is not admitted. */
  readonly guildId?: string;
  /** `QUOKY_REMINDERS_CHANNEL_DELIVERY`: opt-in guild-channel delivery of TEXT notifications. Default off. */
  readonly channelDelivery: boolean;
  /** Resolve a sendable guild channel/thread; null when it cannot be fetched or is not sendable. */
  fetchChannel(id: string): Promise<NotificationChannel | null>;
  /** Resolve (create if needed) the owner's DM channel; rejects when it cannot be resolved. */
  fetchOwnerDm(userId: string): Promise<NotificationChannel>;
  readonly logger: Logger;
  readonly sendTimeoutMs?: number;
  /** Deadline for resolving the target before any send; on expiry nothing was sent -> NOT_SENT{retryable:true}. */
  readonly resolveTimeoutMs?: number;
}

type Refused = 'MISSING_ACCESS' | 'UNKNOWN_TARGET' | 'RATE_LIMITED';
type Classified =
  | { readonly kind: 'REFUSED'; readonly reason: Refused }
  | { readonly kind: 'UNCERTAIN'; readonly reason: NotificationUncertainReason };

/** Discord JSON error codes: the request was refused and created no message. */
const MISSING_ACCESS_CODES = new Set([50001, 50007, 50013, 50083]);
const UNKNOWN_TARGET_CODES = new Set([10003, 10004, 10013]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);

function readField(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>)[key] : undefined;
}

/**
 * Classify a Discord / transport error by duck typing (no discord.js import). Anything not recognised as a
 * definite 4xx refusal is UNCERTAIN: a message may have been created.
 */
export function classifyDiscordError(err: unknown): Classified {
  const name = readField(err, 'name');
  const status = readField(err, 'status');
  const code = readField(err, 'code');
  const cause = readField(err, 'cause');
  const causeCode = readField(cause, 'code');

  if (name === 'RateLimitError' || status === 429) return { kind: 'REFUSED', reason: 'RATE_LIMITED' };
  if (typeof code === 'number') {
    if (MISSING_ACCESS_CODES.has(code)) return { kind: 'REFUSED', reason: 'MISSING_ACCESS' };
    if (UNKNOWN_TARGET_CODES.has(code)) return { kind: 'REFUSED', reason: 'UNKNOWN_TARGET' };
  }
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return { kind: 'REFUSED', reason: 'MISSING_ACCESS' };
    if (status === 404) return { kind: 'REFUSED', reason: 'UNKNOWN_TARGET' };
    if (status >= 500) return { kind: 'UNCERTAIN', reason: 'PLATFORM_ERROR' };
    // Any other 4xx (400, 408, ...): not provably "no message created" with a usable reason -> UNCERTAIN.
    return { kind: 'UNCERTAIN', reason: status === 408 ? 'TIMEOUT' : 'UNCLASSIFIED' };
  }
  if (name === 'AbortError' || code === 'ABORT_ERR') return { kind: 'UNCERTAIN', reason: 'ABORTED' };
  if (name === 'TimeoutError' || (typeof code === 'string' && TIMEOUT_CODES.has(code)) || (typeof causeCode === 'string' && TIMEOUT_CODES.has(causeCode))) {
    return { kind: 'UNCERTAIN', reason: 'TIMEOUT' };
  }
  const message = readField(err, 'message');
  if (
    (typeof code === 'string' && NETWORK_CODES.has(code)) ||
    (typeof causeCode === 'string' && NETWORK_CODES.has(causeCode)) ||
    (typeof message === 'string' && /fetch failed|socket hang up|network/i.test(message))
  ) {
    return { kind: 'UNCERTAIN', reason: 'NETWORK_ERROR' };
  }
  return { kind: 'UNCERTAIN', reason: 'UNCLASSIFIED' };
}

function notSent(reason: NotificationNotSentReason, retryable: boolean): NotificationSinkOutcome {
  return { status: 'NOT_SENT', reason, retryable };
}

/** Marker so the send timeout is classified as TIMEOUT without relying on a message. */
class SendTimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

async function sendWithTimeout(channel: NotificationChannel, options: NotificationSendOptions, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      channel.send(options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SendTimeoutError('notification send timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ResolveTimeoutError extends Error {
  override readonly name = 'ResolveTimeoutError';
}

/** Bound a pre-send resolution step. Rejects with ResolveTimeoutError (nothing has been transmitted yet). */
async function withResolveDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ResolveTimeoutError('notification target resolution timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logFields(n: OwnerNotification, outcome: NotificationSinkOutcome): Record<string, string | number | boolean> {
  return {
    correlationId: n.correlationId,
    kind: n.kind,
    status: outcome.status,
    ...(outcome.status === 'SENT' ? { via: outcome.via } : { reason: outcome.reason }),
    ...(outcome.status === 'NOT_SENT' ? { retryable: outcome.retryable } : {}),
  };
}

/** Deliver one owner notification. Never throws for a delivery failure; logs ids and outcome only. */
export async function deliverOwnerNotification(
  notification: OwnerNotification,
  deps: OwnerNotificationDeps,
): Promise<NotificationSinkOutcome> {
  const outcome = await deliver(notification, deps);
  const log = outcome.status === 'SENT' ? deps.logger.info : deps.logger.warn;
  log.call(deps.logger, 'owner notification delivery', logFields(notification, outcome));
  return outcome;
}

async function deliver(n: OwnerNotification, deps: OwnerNotificationDeps): Promise<NotificationSinkOutcome> {
  const { target } = n;
  // Delivery-time recheck of platform and owner (nothing is sent for a mismatch).
  if (target.platform !== DISCORD_NOTIFICATION_PLATFORM) return notSent('TARGET_NOT_ADMITTED', false);
  const ownerId = target.userId;
  if (!deps.ownerIds.includes(ownerId)) return notSent('NOT_OWNER', false);

  const text = renderNotificationForDiscord(n);
  if ([...text].length > REMINDER_LIMITS.maxDeliveredTextChars) return notSent('TEXT_TOO_LONG', false);

  const timeoutMs = deps.sendTimeoutMs ?? DEFAULT_NOTIFICATION_SEND_TIMEOUT_MS;

  // Opt-in guild-channel target: TEXT only (the brief and ADR-0113's OPS_DECISION_RESULT are always DM-only),
  // originating guild channel/thread only.
  if (deps.channelDelivery && n.kind === 'TEXT' && target.spaceId !== undefined) {
    const channelOutcome = await tryChannel(n, text, ownerId, deps, timeoutMs);
    if (channelOutcome) return channelOutcome;
    // Confirmed non-transmitting refusal, or target unusable/not admitted: fall back once to the owner DM.
  }
  return sendDm(text, ownerId, deps, timeoutMs);
}

function resolveMs(deps: OwnerNotificationDeps): number {
  return deps.resolveTimeoutMs ?? DEFAULT_NOTIFICATION_RESOLVE_TIMEOUT_MS;
}

function isAdmittedGuildTarget(n: OwnerNotification, deps: OwnerNotificationDeps): boolean {
  const { target } = n;
  if (deps.guildId !== undefined && target.spaceId !== deps.guildId) return false;
  return deps.channelIds.includes(target.channelId) || (target.threadId !== undefined && deps.channelIds.includes(target.threadId));
}

/**
 * Returns a terminal outcome, or `null` to fall back to the DM (target not admitted/unusable, or a confirmed
 * non-transmitting permission/unknown-channel refusal). An UNCERTAIN or retryable result is terminal: no fallback.
 */
async function tryChannel(
  n: OwnerNotification,
  text: string,
  ownerId: string,
  deps: OwnerNotificationDeps,
  timeoutMs: number,
): Promise<NotificationSinkOutcome | null> {
  if (!isAdmittedGuildTarget(n, deps)) return null;
  const targetId = n.target.threadId ?? n.target.channelId;
  let channel: NotificationChannel | null;
  try {
    channel = await withResolveDeadline(Promise.resolve().then(() => deps.fetchChannel(targetId)), resolveMs(deps));
  } catch (err) {
    // A stalled/rate-limited fetch: nothing sent; retry later rather than blocking or guessing a fallback.
    if (err instanceof ResolveTimeoutError) return notSent('NOT_CONNECTED', true);
    channel = null; // resolution failed before any send: nothing transmitted, use the DM
  }
  if (!channel) return null;

  const content = `<@${ownerId}> ${text}`;
  if (content.length > DISCORD_MESSAGE_LIMIT) return notSent('TEXT_TOO_LONG', false);
  try {
    await sendWithTimeout(channel, { content, allowedMentions: { parse: [], users: [ownerId] } }, timeoutMs);
    return { status: 'SENT', via: 'channel' };
  } catch (err) {
    const c = classifyDiscordError(err);
    if (c.kind === 'UNCERTAIN') return { status: 'UNCERTAIN', reason: c.reason };
    if (c.reason === 'RATE_LIMITED') return notSent('RATE_LIMITED', true);
    return null; // MISSING_ACCESS / UNKNOWN_TARGET: confirmed not transmitted -> DM fallback
  }
}

async function sendDm(
  text: string,
  ownerId: string,
  deps: OwnerNotificationDeps,
  timeoutMs: number,
): Promise<NotificationSinkOutcome> {
  if (text.length > DISCORD_MESSAGE_LIMIT) return notSent('TEXT_TOO_LONG', false);
  let dm: NotificationChannel;
  try {
    dm = await withResolveDeadline(Promise.resolve().then(() => deps.fetchOwnerDm(ownerId)), resolveMs(deps));
  } catch (err) {
    if (err instanceof ResolveTimeoutError) return notSent('NOT_CONNECTED', true);
    // Resolution happens before any send call: nothing was transmitted.
    const c = classifyDiscordError(err);
    if (c.kind === 'REFUSED') return notSent(c.reason, c.reason === 'RATE_LIMITED');
    // Transport trouble while opening the DM: safe to retry (bounded by the dispatcher); reported as NOT_CONNECTED.
    return notSent('NOT_CONNECTED', true);
  }
  try {
    await sendWithTimeout(dm, { content: text, allowedMentions: { parse: [] } }, timeoutMs);
    return { status: 'SENT', via: 'dm' };
  } catch (err) {
    const c = classifyDiscordError(err);
    if (c.kind === 'UNCERTAIN') return { status: 'UNCERTAIN', reason: c.reason };
    return notSent(c.reason, c.reason === 'RATE_LIMITED');
  }
}
