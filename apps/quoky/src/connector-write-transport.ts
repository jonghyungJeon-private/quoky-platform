import { channel } from 'node:diagnostics_channel';
import {
  connectorWriteNotSent,
  connectorWriteUncertain,
  type ConnectorWriteOutcome,
  type ConnectorWriteTransportClassifier,
} from '@quoky/core';

/**
 * The platform-fetch transport classifier for connector WRITE requests (UNC-1 live network-fault UAT, 2026-10-08). It
 * implements Core's `ConnectorWriteTransportClassifier` contract and is injected by the composition root into the
 * Slack, Jira and Google Calendar writers (adapters depend only on `@quoky/core`, ARCHITECTURE.md §11.3; Core stays free
 * of transport specifics).
 *
 * ONE rule: `NOT_SENT('UNAVAILABLE')` only with connection-stage evidence, otherwise `UNCERTAIN('TRANSPORT')`.
 * Connection-stage evidence is exactly:
 * - the error (anywhere in the `cause` chain) is the very object the platform fetch (undici) published on its
 *   `undici:client:connectError` diagnostics channel — the connection (DNS, TCP, proxy tunnel or TLS handshake) was
 *   never established, so no request byte was written. Matched by IDENTITY, never by shape or timing, so concurrent
 *   requests cannot be confused;
 * - `ENOTFOUND` / `EAI_AGAIN`: a name-resolution failure cannot happen after the request was sent;
 * - a refused proxy tunnel: undici's "Proxy response (NNN) !== 200 when HTTP Tunneling", raised before the tunnel exists.
 *
 * Every other code — `ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`,
 * `ERR_TLS_HANDSHAKE_TIMEOUT`, TLS certificate codes — is NOT_SENT only together with the connect-error evidence (they
 * can also surface on an established connection, e.g. `read EHOSTUNREACH` after the request bytes were written).
 * Timeouts, aborts and anything unrecognised stay UNCERTAIN.
 */

const CONNECT_ERROR_CHANNEL = 'undici:client:connectError';
/** Name resolution happens only before a connection exists. */
const NAME_RESOLUTION_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN']);
/** undici's refused-tunnel message (`ProxyAgent` / `EnvHttpProxyAgent`): the CONNECT was answered with a non-200. */
const PROXY_TUNNEL_REFUSED = /^Proxy response (?:\(\d{3}\) )?!== 200 when HTTP Tunneling$/;
/** How deep the `cause` chain is followed (fetch wraps the transport error once or twice). */
const MAX_CAUSE_DEPTH = 5;

/** Errors undici published as connect-stage failures (weakly held: they vanish with the error). */
const connectStageErrors = new WeakSet<object>();
/** Held strongly so the subscription can never be collected. */
let connectErrorChannel: ReturnType<typeof channel> | undefined;

/**
 * Subscribes (once per process) to undici's connect-error diagnostics channel. The composition root calls it before it
 * builds any writer, so the subscription exists before the first write request. Idempotent.
 */
export function installConnectorWriteTransportDiagnostics(): void {
  if (connectErrorChannel !== undefined) return;
  connectErrorChannel = channel(CONNECT_ERROR_CHANNEL);
  connectErrorChannel.subscribe((message: unknown) => {
    const error = isObject(message) ? message.error : undefined;
    if (isObject(error)) connectStageErrors.add(error);
  });
}

/** True only with connection-stage evidence that `error` failed before the request was written. */
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

/** {@link ConnectorWriteTransportClassifier}: NOT_SENT only with connection-stage evidence, else UNCERTAIN. */
export const classifyConnectorWriteTransportFailure: ConnectorWriteTransportClassifier = (
  error: unknown,
): ConnectorWriteOutcome =>
  hasConnectionStageEvidence(error) ? connectorWriteNotSent('UNAVAILABLE') : connectorWriteUncertain('TRANSPORT');

function isObject(value: unknown): value is Record<string, unknown> & object {
  return typeof value === 'object' && value !== null;
}
