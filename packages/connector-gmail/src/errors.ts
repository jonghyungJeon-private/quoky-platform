import { ConnectorQueryError, type ConnectorQueryErrorReason } from '@quoky/core';

/**
 * Sanitized Gmail failures. Every class extends the ADR-0100 `ConnectorQueryError` (the `MailReader` port contract,
 * ADR-0118 D2), and no message carries a token, client secret, authorization code, header, request parameter, query,
 * message id or response content. The reason is the typed failure Core renders:
 *
 * - `UNAUTHORIZED` — auth expired or revoked (`invalid_grant`, a 401 after one refresh);
 * - `INSUFFICIENT_SCOPE` — consent needed (`gmail.readonly` not granted);
 * - `FORBIDDEN` — a grant broader than `gmail.readonly`, or an administrator refusal;
 * - `RATE_LIMITED`, `UNAVAILABLE` (transport, timeout, 5xx), `INVALID_RESPONSE` (shape or size), `NOT_FOUND`.
 */

/** Which Google endpoint failed: the OAuth token endpoint or the Gmail API. */
export type GmailEndpoint = 'token' | 'gmail';

/** A sanitized HTTP failure from either endpoint. */
export class GmailHttpError extends ConnectorQueryError {
  constructor(
    reason: ConnectorQueryErrorReason,
    readonly endpoint: GmailEndpoint,
    readonly status: number,
  ) {
    super(reason, `gmail: ${endpoint} request failed (${reason.toLowerCase()})`);
    this.name = 'GmailHttpError';
  }
}

/** A sanitized transport or timeout failure. The underlying fetch error is deliberately not retained. */
export class GmailRequestError extends ConnectorQueryError {
  constructor(readonly endpoint: GmailEndpoint) {
    super('UNAVAILABLE', `gmail: ${endpoint} request did not complete`);
    this.name = 'GmailRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class GmailResponseError extends ConnectorQueryError {
  constructor(readonly endpoint: GmailEndpoint) {
    super('INVALID_RESPONSE', `gmail: ${endpoint} returned an unexpected response`);
    this.name = 'GmailResponseError';
  }
}

/** A response body larger than the bound for its call; the read stops at the bound and nothing more is kept. */
export class GmailResponseTooLargeError extends ConnectorQueryError {
  constructor(readonly endpoint: GmailEndpoint) {
    super('INVALID_RESPONSE', `gmail: ${endpoint} response exceeded its size bound`);
    this.name = 'GmailResponseTooLargeError';
  }
}

/**
 * The granted OAuth scope lacks `gmail.readonly` (`MISSING` → `INSUFFICIENT_SCOPE`: consent needed) or holds any other
 * scope (`TOO_BROAD` → `FORBIDDEN`: Quoky refuses to hold a broader grant; ADR-0118 D3).
 */
export class GmailScopeError extends ConnectorQueryError {
  constructor(readonly kind: 'MISSING' | 'TOO_BROAD') {
    super(
      kind === 'MISSING' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN',
      kind === 'MISSING'
        ? 'gmail: the token does not grant gmail.readonly; run the consent helper with --gmail'
        : 'gmail: the token grants more than gmail.readonly; re-run the consent helper with --gmail',
    );
    this.name = 'GmailScopeError';
  }
}

/** The client was asked for a request outside its read-only allowlist (a programming error; never sent). */
export class GmailEndpointNotAllowedError extends Error {
  constructor() {
    super('gmail: only GET requests to the pinned read endpoints are allowed');
    this.name = 'GmailEndpointNotAllowedError';
  }
}
