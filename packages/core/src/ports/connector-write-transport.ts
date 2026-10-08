import { channel } from 'node:diagnostics_channel';
import { connectorWriteNotSent, connectorWriteUncertain, type ConnectorWriteOutcome } from './connector-write.port';

/**
 * Shared transport-failure classification for every connector WRITE request (ADR-0112 D2/D4; UNC-1 live network-fault
 * UAT, 2026-10-08). A thrown write request is `NOT_SENT('UNAVAILABLE')` ONLY when the request provably never reached the
 * server; everything else stays `UNCERTAIN('TRANSPORT')` (fail safe: "may have been written", never retried).
 *
 * Provably not sent:
 * - a failure the platform `fetch` (undici) reported on its `undici:client:connectError` diagnostics channel — the
 *   connection (DNS, TCP, proxy tunnel or TLS handshake) was never established, so no request byte was written. The
 *   thrown error is matched by IDENTITY (the very error object undici published), never by timing, so concurrent
 *   requests cannot be confused. This covers a reset during connect and every TLS handshake failure;
 * - an error code that only connection set-up can produce: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`,
 *   `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`, `ERR_TLS_HANDSHAKE_TIMEOUT` and the TLS certificate-verification codes;
 * - a refused proxy tunnel (`CONNECT` answered with a non-200 status: undici's "Proxy response (NNN) !== 200 when HTTP
 *   Tunneling").
 *
 * Ambiguous, so UNCERTAIN: a reset / "other side closed" after the connection was up (`ECONNRESET` outside connect,
 * `UND_ERR_SOCKET`), any timeout or abort (it may fire after the request left), and anything unrecognised.
 */

const CONNECT_ERROR_CHANNEL = 'undici:client:connectError';

/** Error codes that can only arise before a request is written (name resolution or connection set-up). */
const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  // TLS certificate verification (handshake only).
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
]);

/** undici's refused-tunnel message (`ProxyAgent` / `EnvHttpProxyAgent`): the CONNECT was answered with a non-200. */
const PROXY_TUNNEL_REFUSED = /^Proxy response (?:\(\d{3}\) )?!== 200 when HTTP Tunneling$/;

/** How deep the `cause` chain is followed (fetch wraps the transport error once or twice). */
const MAX_CAUSE_DEPTH = 5;

/** Errors undici published as connect-stage failures (weakly held: they vanish with the error). */
const connectStageErrors = new WeakSet<object>();
/** Held strongly so the subscription can never be collected. */
let connectErrorChannel: ReturnType<typeof channel> | undefined;

/**
 * Subscribes (once per process) to undici's connect-error diagnostics channel. Every connector writer calls this from
 * its constructor, so the subscription exists before its first request. Idempotent and side-effect free otherwise.
 */
export function installConnectorWriteTransportDiagnostics(): void {
  if (connectErrorChannel !== undefined) return;
  connectErrorChannel = channel(CONNECT_ERROR_CHANNEL);
  connectErrorChannel.subscribe((message: unknown) => {
    const error = isObject(message) ? message.error : undefined;
    if (isObject(error)) connectStageErrors.add(error);
  });
}

/** True when `error` (or an error in its `cause` chain) provably failed before the request was written. */
export function isConnectorWritePreSendFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isObject(current); depth += 1) {
    if (connectStageErrors.has(current)) return true;
    const code = current.code;
    if (typeof code === 'string' && PRE_SEND_CODES.has(code)) return true;
    const message = current.message;
    if (typeof message === 'string' && PROXY_TUNNEL_REFUSED.test(message)) return true;
    current = current.cause;
  }
  return false;
}

/** The outcome of a write request that threw: NOT_SENT only when provably never sent, else UNCERTAIN (fail safe). */
export function classifyConnectorWriteTransportFailure(error: unknown): ConnectorWriteOutcome {
  return isConnectorWritePreSendFailure(error) ? connectorWriteNotSent('UNAVAILABLE') : connectorWriteUncertain('TRANSPORT');
}

function isObject(value: unknown): value is Record<string, unknown> & object {
  return typeof value === 'object' && value !== null;
}
