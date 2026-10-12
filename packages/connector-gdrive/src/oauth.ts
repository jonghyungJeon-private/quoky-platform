import { createHash, randomBytes } from 'node:crypto';
import { ConnectorQueryError, type ConnectorQueryErrorReason } from '@quoky/core';
import { GDriveHttpError, GDriveRequestError, GDriveResponseError, GDriveResponseTooLargeError, GDriveScopeError } from './errors';

/**
 * Google OAuth 2.0 for the Drive adapter (ADR-0118 D3, DRV-1; the GML-1 pattern): the refresh-token grant used at
 * runtime and the authorization-code + PKCE exchange used once by the owner's consent helper. The ONLY scope ever
 * requested or accepted is `drive.readonly`; a grant missing it is `MISSING` (consent needed) and a grant with any other
 * scope — including full `drive`, `drive.file`, `drive.metadata`, `drive.appdata`, a Gmail or calendar scope or
 * `openid` — is `TOO_BROAD` and refused. One grant set, one token file: the Drive token is never the calendar or Gmail
 * token. Egress is fixed to `oauth2.googleapis.com`; redirects are refused. Nothing here logs, and no error carries a token, secret, code or
 * response content.
 */

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** The complete set of scopes the Drive grant may hold. */
export const DRIVE_ALLOWED_SCOPES: readonly string[] = Object.freeze([DRIVE_READONLY_SCOPE]);
export const GDRIVE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Opened by the owner's browser during consent; Quoky itself never sends a request to this host. */
export const GDRIVE_OAUTH_CONSENT_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GDriveOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** An in-memory access token. Never persisted or logged. */
export interface GDriveAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface GDriveTokenRequestOptions {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

/** No refresh token came back from the code exchange (Google omits it when consent was not shown again). */
export class GDriveNoRefreshTokenError extends ConnectorQueryError {
  constructor() {
    super('INVALID_RESPONSE', 'gdrive: the consent response carried no refresh token');
    this.name = 'GDriveNoRefreshTokenError';
  }
}

/**
 * The granted scope must be exactly `drive.readonly`: missing → `GDriveScopeError('MISSING')`, anything else alongside
 * or instead → `GDriveScopeError('TOO_BROAD')`. An absent scope field cannot be verified and is refused (`MISSING`).
 * Returns the normalized grant string.
 */
export function assertDriveReadonlyScope(scope: unknown): string {
  if (typeof scope !== 'string') throw new GDriveScopeError('MISSING');
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  for (const entry of granted) {
    if (!DRIVE_ALLOWED_SCOPES.includes(entry)) throw new GDriveScopeError('TOO_BROAD');
  }
  if (!granted.has(DRIVE_READONLY_SCOPE)) throw new GDriveScopeError('MISSING');
  return DRIVE_READONLY_SCOPE;
}

/** Exchange the long-lived refresh token for a short-lived access token (`grant_type=refresh_token`). */
export async function refreshGDriveAccessToken(
  client: GDriveOAuthClient,
  refreshToken: string,
  options: GDriveTokenRequestOptions & { readonly nowMs: number },
): Promise<GDriveAccessToken> {
  const payload = await postTokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
    },
    options,
  );
  assertDriveReadonlyScope(payload.scope);
  const token = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new GDriveResponseError('token');
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new GDriveResponseError('token');
  }
  if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== 'bearer') {
    throw new GDriveResponseError('token');
  }
  return { token, expiresAtMs: options.nowMs + expiresIn * 1000 };
}

export interface GDriveAuthorizationCodeExchange {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * The consent helper's one-time exchange (`grant_type=authorization_code` with PKCE). Returns the refresh token and the
 * normalized granted scope (always exactly `drive.readonly`); any other grant is refused and nothing is returned.
 */
export async function exchangeGDriveAuthorizationCode(
  client: GDriveOAuthClient,
  exchange: GDriveAuthorizationCodeExchange,
  options: GDriveTokenRequestOptions,
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
  const scope = assertDriveReadonlyScope(payload.scope);
  const refreshToken = payload.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) throw new GDriveNoRefreshTokenError();
  return { refreshToken, scope };
}

/** A PKCE verifier (43 base64url characters) and its S256 challenge. */
export function createGDrivePkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** An unguessable OAuth `state` value bound to one consent attempt. */
export function createGDriveOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

export interface GDriveConsentUrlInput {
  readonly clientId: string;
  /** A loopback redirect: `http://127.0.0.1:<port>/<path>` (a Google "Desktop app" OAuth client allows any port). */
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}

/**
 * The consent URL for `drive.readonly` only: offline access, consent always shown (so a refresh token is returned), no
 * incremental grants (so no earlier grant — the calendar's or any other — is merged into this one), PKCE S256. It
 * contains no secret.
 */
export function buildGDriveConsentUrl(input: GDriveConsentUrlInput): string {
  if (!isLoopbackRedirect(input.redirectUri)) {
    throw new Error('gdrive: the redirect must be an http://127.0.0.1 loopback address');
  }
  const url = new URL(GDRIVE_OAUTH_CONSENT_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_READONLY_SCOPE);
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
  options: GDriveTokenRequestOptions,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(GDRIVE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new GDriveRequestError('token');
  }
  if (!response.ok) {
    throw new GDriveHttpError(tokenErrorReason(response.status, await readOAuthErrorCode(response)), 'token', response.status);
  }
  const payload = await readBoundedTokenJson(response);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new GDriveResponseError('token');
  }
  return payload as Record<string, unknown>;
}

/** A token endpoint body is a few hundred bytes; anything past this cap is refused (HARD-1). */
const TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;

/**
 * Read the token endpoint body as JSON, at most `TOKEN_RESPONSE_MAX_BYTES`: a larger declared length is refused without
 * reading, a larger stream is cancelled at the cap. Any failure is a sanitized typed error carrying no body content.
 */
async function readBoundedTokenJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > TOKEN_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new GDriveResponseTooLargeError('token');
  }
  const body = response.body;
  if (body === null) throw new GDriveResponseError('token');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TOKEN_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GDriveResponseTooLargeError('token');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GDriveResponseTooLargeError) throw error;
    throw new GDriveRequestError('token');
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, total))) as unknown;
  } catch {
    throw new GDriveResponseError('token');
  }
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
    const body: unknown = await readBoundedTokenJson(response);
    if (typeof body !== 'object' || body === null) return undefined;
    const code = (body as Record<string, unknown>).error;
    return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
