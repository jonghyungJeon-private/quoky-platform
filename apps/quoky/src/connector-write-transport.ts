import { channel } from 'node:diagnostics_channel';
import {
  connectorWriteNotSent,
  connectorWriteUncertain,
  type ConnectorWriteOutcome,
  type ConnectorWriteTransportAttempt,
  type ConnectorWriteTransportGuard,
} from '@quoky/core';

/**
 * The platform-fetch transport guard for connector WRITE requests (UNC-1 live network-fault UAT and its reviews,
 * 2026-10-08). It implements Core's `ConnectorWriteTransportGuard` contract and is injected by the composition root into
 * the Slack, Jira and Google Calendar writers (adapters depend only on `@quoky/core`, ARCHITECTURE.md §11.3; Core stays
 * free of transport specifics).
 *
 * `NOT_SENT('UNAVAILABLE')` needs BOTH:
 *
 * 1. **Invocation-wide no-send evidence.** Each write request opens a window for its target origin. While it is open,
 *    any request-bytes event the platform fetch (undici) publishes for that origin — `undici:client:sendHeaders`
 *    (headers written to a socket) or `undici:request:bodySent` — poisons the window, whatever happens next. This
 *    covers fetch's own re-dispatches (a POST is retried on a new connection after HTTP 421 even with
 *    `redirect: 'error'`): bytes on the first connection make the final error irrelevant. A proxy CONNECT has the
 *    proxy's origin and is not a request to the target. An event whose origin cannot be read poisons every open
 *    window. Concurrent requests to the same origin poison each other (accepted: it fails safe).
 * 2. **Connection-stage evidence** on the thrown error: the very object undici published on
 *    `undici:client:connectError` (matched by identity), a name-resolution code (`ENOTFOUND`, `EAI_AGAIN`), or a refused
 *    proxy tunnel ("Proxy response (NNN) !== 200 when HTTP Tunneling").
 *
 * Everything else is `UNCERTAIN('TRANSPORT')`. NOT_SENT therefore means: no request bytes were observed on any
 * connection to the target during this write, and the failure happened while connecting.
 */

const CONNECT_ERROR_CHANNEL = 'undici:client:connectError';
/** Published when a request's headers / body are written to a socket (present on Node 18.20 and Node 22). */
const SEND_CHANNELS = ['undici:client:sendHeaders', 'undici:request:bodySent'] as const;
/** Name resolution happens only before a connection exists. */
const NAME_RESOLUTION_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN']);
/** undici's refused-tunnel message (`ProxyAgent` / `EnvHttpProxyAgent`): the CONNECT was answered with a non-200. */
const PROXY_TUNNEL_REFUSED = /^Proxy response (?:\(\d{3}\) )?!== 200 when HTTP Tunneling$/;
/** How deep the `cause` chain is followed (fetch wraps the transport error once or twice). */
const MAX_CAUSE_DEPTH = 5;

interface InvocationWindow {
  readonly origin: string;
  poisoned: boolean;
}

/** Errors undici published as connect-stage failures (weakly held: they vanish with the error). */
const connectStageErrors = new WeakSet<object>();
/** The open write windows. */
const openWindows = new Set<InvocationWindow>();
/** Held strongly so the subscriptions can never be collected. */
const subscribedChannels: Array<ReturnType<typeof channel>> = [];

/**
 * Subscribes (once per process) to undici's connect-error and request-bytes diagnostics channels. The composition root
 * calls it before it builds any writer; {@link platformFetchTransportGuard} also calls it. Idempotent.
 */
export function installConnectorWriteTransportDiagnostics(): void {
  if (subscribedChannels.length > 0) return;
  const connectError = channel(CONNECT_ERROR_CHANNEL);
  connectError.subscribe((message: unknown) => {
    const error = isObject(message) ? message.error : undefined;
    if (isObject(error)) connectStageErrors.add(error);
  });
  subscribedChannels.push(connectError);
  for (const name of SEND_CHANNELS) {
    const send = channel(name);
    send.subscribe((message: unknown) => poisonWindowsFor(originOfRequestMessage(message)));
    subscribedChannels.push(send);
  }
}

/** True only with connection-stage evidence that `error` failed while connecting (see the module comment, part 2). */
export function hasConnectionStageEvidence(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isObject(current); depth += 1) {
    if (connectStageErrors.has(current)) return true;
    const code = current.code;
    if (typeof code === 'string' && NAME_RESOLUTION_CODES.has(code)) return true;
    const message = current.message;
    if (typeof message === 'string' && PROXY_TUNNEL_REFUSED.test(message)) return true;
    current = current.cause;
  }
  return false;
}

/** The guard the composition root injects into every connector writer. */
export const platformFetchTransportGuard: ConnectorWriteTransportGuard = {
  begin(target: URL): ConnectorWriteTransportAttempt {
    installConnectorWriteTransportDiagnostics();
    const window: InvocationWindow = { origin: originOf(target) ?? '', poisoned: false };
    // A target without a readable origin can never prove anything: start poisoned.
    if (window.origin === '') window.poisoned = true;
    openWindows.add(window);
    return {
      classifyFailure(error: unknown): ConnectorWriteOutcome {
        return !window.poisoned && hasConnectionStageEvidence(error)
          ? connectorWriteNotSent('UNAVAILABLE')
          : connectorWriteUncertain('TRANSPORT');
      },
      end(): void {
        openWindows.delete(window);
      },
    };
  },
};

function poisonWindowsFor(origin: string | undefined): void {
  for (const window of openWindows) {
    if (origin === undefined || window.origin === origin) window.poisoned = true;
  }
}

function originOfRequestMessage(message: unknown): string | undefined {
  const request = isObject(message) ? message.request : undefined;
  const origin = isObject(request) ? request.origin : undefined;
  return origin === undefined ? undefined : originOf(origin);
}

function originOf(value: unknown): string | undefined {
  try {
    const origin = new URL(String(value)).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> & object {
  return typeof value === 'object' && value !== null;
}
