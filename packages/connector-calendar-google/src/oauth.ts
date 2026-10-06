import { createHash, randomBytes } from 'node:crypto';
import { ConnectorQueryError, type ConnectorQueryErrorReason } from '@quoky/core';
import {
  GoogleCalendarHttpError,
  GoogleCalendarRequestError,
  GoogleCalendarResponseError,
  GoogleCalendarScopeError,
} from './errors';

/**
 * Google OAuth 2.0 for the calendar adapter (ADR-0110 D2): the refresh-token grant used at runtime, and the
 * authorization-code + PKCE exchange used once by the local consent helper. The consent requests `calendar.readonly`
 * and `calendar.events` only (ADR-0110 amendment D1, 2026-10-06); a grant must include `calendar.readonly` and may
 * include `calendar.events`, and any other scope (`calendar`, `calendar.settings.*`, ACL or sharing scopes, `openid`,
 * …) is refused. Reads keep using the read path (GET only). Egress is fixed to `oauth2.googleapis.com`; redirects are
 * refused. Nothing here logs, and no error carries a token, secret, code or response content.
 */

export const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Event create/update/delete on calendars the owner can write (ADR-0110 amendment D1); used only by CWR-2 writes. */
export const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
/** Every scope the consent requests and a grant may hold, in request order. Nothing broader is ever accepted. */
export const GOOGLE_CALENDAR_ALLOWED_SCOPES: readonly string[] = Object.freeze([
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
]);
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Opened by the owner's browser during consent; Quoky itself never sends a request to this host. */
export const GOOGLE_OAUTH_CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** An in-memory access token. Never persisted or logged. */
export interface GoogleAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface GoogleTokenRequestOptions {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/** No refresh token came back from the code exchange (Google omits it when consent was not shown again). */
export class GoogleCalendarNoRefreshTokenError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'google calendar: the consent response carried no refresh token');
    this.name = 'GoogleCalendarNoRefreshTokenError';
  }
}

/** Exchange the long-lived refresh token for a short-lived access token (`grant_type=refresh_token`). */
export async function refreshGoogleAccessToken(
  client: GoogleOAuthClient,
  refreshToken: string,
  options: GoogleTokenRequestOptions & { readonly nowMs: number },
): Promise<GoogleAccessToken> {
  const payload = await postTokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
    },
    options,
  );
  assertGrantedCalendarScopes(payload.scope);
  const token = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof token !== 'string' || token.length === 0) throw new GoogleCalendarResponseError('token');
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new GoogleCalendarResponseError('token');
  }
  if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== 'bearer') {
    throw new GoogleCalendarResponseError('token');
  }
  return { token, expiresAtMs: options.nowMs + expiresIn * 1000 };
}

export interface GoogleAuthorizationCodeExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * The consent helper's one-time exchange (`grant_type=authorization_code` with PKCE). Returns the refresh token and the
 * normalized granted scopes (`calendar.readonly`, optionally followed by `calendar.events`, space-separated).
 */
export async function exchangeGoogleAuthorizationCode(
  client: GoogleOAuthClient,
  exchange: GoogleAuthorizationCodeExchange,
  options: GoogleTokenRequestOptions,
): Promise<{ readonly refreshToken: string; readonly scope: string }> {
  const payload = await postTokenRequest(
    {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: exchange.code,
      code_verifier: exchange.codeVerifier,
      redirect_uri: exchange.redirectUri,
    },
    options,
  );
  const scope = assertGrantedCalendarScopes(payload.scope);
  const refreshToken = payload.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) throw new GoogleCalendarNoRefreshTokenError();
  return { refreshToken, scope };
}

/**
 * The granted scope set (ADR-0110 amendment D1): `calendar.readonly` is required (missing →
 * `GoogleCalendarScopeError('MISSING')`), `calendar.events` is allowed, and any other scope alongside them →
 * `GoogleCalendarScopeError('TOO_BROAD')` — the full `calendar` scope, `calendar.settings.*`, ACL/sharing scopes,
 * `openid`/`email` included. An absent scope field cannot be verified and is refused. Returns the normalized grant:
 * the allowed scopes that were granted, in `GOOGLE_CALENDAR_ALLOWED_SCOPES` order, space-separated.
 */
export function assertGrantedCalendarScopes(scope: unknown): string {
  if (typeof scope !== 'string') throw new GoogleCalendarScopeError('MISSING');
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  if (!granted.has(GOOGLE_CALENDAR_READONLY_SCOPE)) throw new GoogleCalendarScopeError('MISSING');
  for (const entry of granted) {
    if (!GOOGLE_CALENDAR_ALLOWED_SCOPES.includes(entry)) throw new GoogleCalendarScopeError('TOO_BROAD');
  }
  return GOOGLE_CALENDAR_ALLOWED_SCOPES.filter((allowed) => granted.has(allowed)).join(' ');
}

/** Whether a normalized grant (see `assertGrantedCalendarScopes`) includes `calendar.events`. */
export function grantIncludesCalendarEvents(scope: string): boolean {
  return scope.split(/\s+/).includes(GOOGLE_CALENDAR_EVENTS_SCOPE);
}

/** A PKCE verifier (43 base64url characters) and its S256 challenge. */
export function createGooglePkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** An unguessable OAuth `state` value bound to one consent attempt. */
export function createGoogleOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

export interface GoogleConsentUrlInput {
  readonly clientId: string;
  /** A loopback redirect: `http://127.0.0.1:<port>/<path>` (a Google "Desktop app" OAuth client allows any port). */
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}

/**
 * The consent URL for `calendar.readonly` and `calendar.events` only (ADR-0110 amendment D1), offline access, consent
 * always shown (so a refresh token is returned), no incremental grants (so no earlier, broader grant is merged in),
 * PKCE S256. It contains no secret.
 */
export function buildGoogleConsentUrl(input: GoogleConsentUrlInput): string {
  if (!isLoopbackRedirect(input.redirectUri)) {
    throw new Error('google calendar: the redirect must be an http://127.0.0.1 loopback address');
  }
  const url = new URL(GOOGLE_OAUTH_CONSENT_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_CALENDAR_ALLOWED_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port.length > 0 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

async function postTokenRequest(
  form: Record<string, string>,
  options: GoogleTokenRequestOptions,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new GoogleCalendarRequestError('token');
  }
  if (!response.ok) {
    throw new GoogleCalendarHttpError(tokenErrorReason(response.status, await readOAuthErrorCode(response)), 'token', response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GoogleCalendarResponseError('token');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GoogleCalendarResponseError('token');
  }
  return payload as Record<string, unknown>;
}

/**
 * Token endpoint errors: `invalid_grant` (revoked or expired refresh token; a "Testing" consent screen expires refresh
 * tokens after 7 days), `invalid_client` and `unauthorized_client` → `UNAUTHORIZED`; `invalid_scope` →
 * `INSUFFICIENT_SCOPE`; 429 → `RATE_LIMITED`; 5xx → `UNAVAILABLE`.
 */
function tokenErrorReason(status: number, code: string | undefined): ConnectorQueryErrorReason {
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  if (code === 'invalid_scope') return 'INSUFFICIENT_SCOPE';
  if (status === 403 && code === undefined) return 'FORBIDDEN';
  return 'UNAUTHORIZED';
}

/** The OAuth `error` code only (a short token from a fixed vocabulary); everything else in the body is dropped. */
async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const code = (body as Record<string, unknown>).error;
    return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
