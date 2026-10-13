import { ConnectorQueryError, type ConnectorQueryErrorReason } from '@quoky/core';

/**
 * Sanitized Google Drive failures. Every class extends the ADR-0100 `ConnectorQueryError` (the `DriveReader` port
 * contract, ADR-0118 D2), and no message carries a token, client secret, authorization code, header, request parameter,
 * query, file name, file id or response content. The reason is the typed failure Core renders:
 *
 * - `UNAUTHORIZED` — auth expired or revoked (`invalid_grant`, a 401 after one refresh);
 * - `INSUFFICIENT_SCOPE` — consent needed (`drive.readonly` not granted);
 * - `FORBIDDEN` — a grant broader than `drive.readonly`, or an administrator refusal;
 * - `RATE_LIMITED`, `UNAVAILABLE` (transport, timeout, 5xx), `INVALID_RESPONSE` (shape or size), `NOT_FOUND`.
 */

/** Which Google endpoint failed: the OAuth token endpoint, the Drive API or the Sheets API (DRV-2b). */
export type GDriveEndpoint = 'token' | 'drive' | 'sheets';

/** A sanitized HTTP failure from any endpoint. */
export class GDriveHttpError extends ConnectorQueryError {
  constructor(
    reason: ConnectorQueryErrorReason,
    readonly endpoint: GDriveEndpoint,
    readonly status: number,
    /**
     * DRV-2b: Google answered that the API is not enabled for the project (403 `SERVICE_DISABLED` /
     * `accessNotConfigured`). Read from the fixed `reason` tokens only.
     */
    readonly serviceDisabled = false,
  ) {
    super(reason, `gdrive: ${endpoint} request failed (${reason.toLowerCase()})`);
    this.name = 'GDriveHttpError';
  }
}

/** A sanitized transport or timeout failure. The underlying fetch error is deliberately not retained. */
export class GDriveRequestError extends ConnectorQueryError {
  constructor(readonly endpoint: GDriveEndpoint) {
    super('UNAVAILABLE', `gdrive: ${endpoint} request did not complete`);
    this.name = 'GDriveRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class GDriveResponseError extends ConnectorQueryError {
  constructor(readonly endpoint: GDriveEndpoint) {
    super('INVALID_RESPONSE', `gdrive: ${endpoint} returned an unexpected response`);
    this.name = 'GDriveResponseError';
  }
}

/** A response body larger than the bound for its call; the read stops at the bound and nothing more is kept. */
export class GDriveResponseTooLargeError extends ConnectorQueryError {
  constructor(readonly endpoint: GDriveEndpoint) {
    super('INVALID_RESPONSE', `gdrive: ${endpoint} response exceeded its size bound`);
    this.name = 'GDriveResponseTooLargeError';
  }
}

/**
 * The granted OAuth scope lacks `drive.readonly` (`MISSING` → `INSUFFICIENT_SCOPE`: consent needed) or holds any other
 * scope (`TOO_BROAD` → `FORBIDDEN`: Quoky refuses to hold a broader grant; ADR-0118 D3).
 */
export class GDriveScopeError extends ConnectorQueryError {
  constructor(readonly kind: 'MISSING' | 'TOO_BROAD') {
    super(
      kind === 'MISSING' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN',
      kind === 'MISSING'
        ? 'gdrive: the token does not grant drive.readonly; run the consent helper with --drive'
        : 'gdrive: the token grants more than drive.readonly; re-run the consent helper with --drive',
    );
    this.name = 'GDriveScopeError';
  }
}

/** The client was asked for a request outside its read-only allowlist (a programming error; never sent). */
export class GDriveEndpointNotAllowedError extends Error {
  constructor() {
    super('gdrive: only GET requests to the pinned read endpoints are allowed');
    this.name = 'GDriveEndpointNotAllowedError';
  }
}
