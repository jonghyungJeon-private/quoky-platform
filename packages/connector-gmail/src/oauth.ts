import { createHash, randomBytes } from 'node:crypto';
import { ConnectorQueryError, type ConnectorQueryErrorReason } from '@quoky/core';
import { GmailHttpError, GmailRequestError, GmailResponseError, GmailScopeError } from './errors';

/**
 * Google OAuth 2.0 for the Gmail adapter (ADR-0118 D3): the refresh-token grant used at runtime and the
 * authorization-code + PKCE exchange used once by the owner's consent helper. The ONLY scope ever requested or accepted
 * is `gmail.readonly`; a grant missing it is `MISSING` (consent needed) and a grant with any other scope — including
 * `gmail.modify`, `gmail.send`, `gmail.compose`, `gmail.labels`, full `mail.google.com` or `openid` — is `TOO_BROAD` and
 * refused. One grant set, one token file: the Gmail token is never the calendar token. Egress is fixed to
 * `oauth2.googleapis.com`; redirects are refused. Nothing here logs, and no error carries a token, secret, code or
 * response content.
 */

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** The complete set of scopes the Gmail grant may hold. */
export const GMAIL_ALLOWED_SCOPES: readonly string[] = Object.freeze([GMAIL_READONLY_SCOPE]);
export const GMAIL_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Opened by the owner's browser during consent; Quoky itself never sends a request to this host. */
export const GMAIL_OAUTH_CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GmailOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** An in-memory access token. Never persisted or logged. */
export interface GmailAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface GmailTokenRequestOptions {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/** No refresh token came back from the code exchange (Google omits it when consent was not shown again). */
export class GmailNoRefreshTokenError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'gmail: the consent response carried no refresh token');
    this.name = 'GmailNoRefreshTokenError';
  }
}

/**
 * The granted scope must be exactly `gmail.readonly`: missing → `GmailScopeError('MISSING')`, anything else alongside
 * or instead → `GmailScopeError('TOO_BROAD')`. An absent scope field cannot be verified and is refused (`MISSING`).
 * Returns the normalized grant string.
 */
export function assertGmailReadonlyScope(scope: unknown): string {
  if (typeof scope !== 'string') throw new GmailScopeError('MISSING');
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  for (const entry of granted) {
    if (!GMAIL_ALLOWED_SCOPES.includes(entry)) throw new GmailScopeError('TOO_BROAD');
  }
  if (!granted.has(GMAIL_READONLY_SCOPE)) throw new GmailScopeError('MISSING');
  return GMAIL_READONLY_SCOPE;
}

/** Exchange the long-lived refresh token for a short-lived access token (`grant_type=refresh_token`). */
export async function refreshGmailAccessToken(
  client: GmailOAuthClient,
  refreshToken: string,
  options: GmailTokenRequestOptions & { readonly nowMs: number },
): Promise<GmailAccessToken> {
  const payload = await postTokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
    },
    options,
  );
  assertGmailReadonlyScope(payload.scope);
  const token = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new GmailResponseError('token');
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new GmailResponseError('token');
  }
  if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== 'bearer') {
    throw new GmailResponseError('token');
  }
  return { token, expiresAtMs: options.nowMs + expiresIn * 1000 };
}

export interface GmailAuthorizationCodeExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * The consent helper's one-time exchange (`grant_type=authorization_code` with PKCE). Returns the refresh token and the
 * normalized granted scope (always exactly `gmail.readonly`); any other grant is refused and nothing is returned.
 */
export async function exchangeGmailAuthorizationCode(
  client: GmailOAuthClient,
  exchange: GmailAuthorizationCodeExchange,
  options: GmailTokenRequestOptions,
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
  const scope = assertGmailReadonlyScope(payload.scope);
  const refreshToken = payload.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) throw new GmailNoRefreshTokenError();
  return { refreshToken, scope };
}

/** A PKCE verifier (43 base64url characters) and its S256 challenge. */
export function createGmailPkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** An unguessable OAuth `state` value bound to one consent attempt. */
export function createGmailOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

export interface GmailConsentUrlInput {
  readonly clientId: string;
  /** A loopback redirect: `http://127.0.0.1:<port>/<path>` (a Google "Desktop app" OAuth client allows any port). */
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}

/**
 * The consent URL for `gmail.readonly` only: offline access, consent always shown (so a refresh token is returned), no
 * incremental grants (so no earlier grant — the calendar's or any other — is merged into this one), PKCE S256. It
 * contains no secret.
 */
export function buildGmailConsentUrl(input: GmailConsentUrlInput): string {
  if (!isLoopbackRedirect(input.redirectUri)) {
    throw new Error('gmail: the redirect must be an http://127.0.0.1 loopback address');
  }
  const url = new URL(GMAIL_OAUTH_CONSENT_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_READONLY_SCOPE);
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
  options: GmailTokenRequestOptions,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(GMAIL_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new GmailRequestError('token');
  }
  if (!response.ok) {
    throw new GmailHttpError(tokenErrorReason(response.status, await readOAuthErrorCode(response)), 'token', response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GmailResponseError('token');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GmailResponseError('token');
  }
  return payload as Record<string, unknown>;
}

/**
 * Token endpoint errors: `invalid_grant` (revoked or expired refresh token), `invalid_client` and `unauthorized_client`
 * → `UNAUTHORIZED` (auth expired); `invalid_scope` → `INSUFFICIENT_SCOPE` (consent needed); 429 → `RATE_LIMITED`;
 * 5xx → `UNAVAILABLE`.
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
