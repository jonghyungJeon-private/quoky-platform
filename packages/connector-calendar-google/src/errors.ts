import { ConnectorQueryError, type ConnectorQueryErrorReason } from '@quoky/core';

/**
 * Sanitized Google Calendar failures. Every class extends the ADR-0100 `ConnectorQueryError` (ADR-0110 D1), and no
 * message carries a token, client secret, authorization code, header, request parameter or response content.
 */

/** Which Google endpoint failed: the OAuth token endpoint or the Calendar API. */
export type GoogleCalendarEndpoint = 'token' | 'calendar';

/** A sanitized HTTP failure from either endpoint. */
export class GoogleCalendarHttpError extends ConnectorQueryError {
  constructor(
    reason: ConnectorQueryErrorReason,
    readonly endpoint: GoogleCalendarEndpoint,
    readonly status: number,
  ) {
    super(reason, `google calendar: ${endpoint} request failed (${reason.toLowerCase()})`);
    this.name = 'GoogleCalendarHttpError';
  }
}

/** A sanitized transport or timeout failure. The underlying fetch error is deliberately not retained. */
export class GoogleCalendarRequestError extends ConnectorQueryError {
  constructor(readonly endpoint: GoogleCalendarEndpoint) {
    super('UNAVAILABLE', `google calendar: ${endpoint} request did not complete`);
    this.name = 'GoogleCalendarRequestError';
  }
}

/** A sanitized response-shape failure. Raw response content is deliberately not retained. */
export class GoogleCalendarResponseError extends ConnectorQueryError {
  constructor(readonly endpoint: GoogleCalendarEndpoint) {
    super('INVALID_RESPONSE', `google calendar: ${endpoint} returned an unexpected response`);
    this.name = 'GoogleCalendarResponseError';
  }
}

/**
 * The granted OAuth scope is not exactly `calendar.readonly` (ADR-0110 D2). `MISSING` → `INSUFFICIENT_SCOPE`;
 * `TOO_BROAD` (any other scope granted alongside it) → `FORBIDDEN`: Quoky refuses to hold a broader grant.
 */
export class GoogleCalendarScopeError extends ConnectorQueryError {
  constructor(readonly kind: 'MISSING' | 'TOO_BROAD') {
    super(
      kind === 'MISSING' ? 'INSUFFICIENT_SCOPE' : 'FORBIDDEN',
      kind === 'MISSING'
        ? 'google calendar: the token does not grant calendar.readonly'
        : 'google calendar: the token grants more than calendar.readonly; re-run the consent helper',
    );
    this.name = 'GoogleCalendarScopeError';
  }
}
