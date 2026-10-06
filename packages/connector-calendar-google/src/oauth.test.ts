import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from '@quoky/core';
import { GoogleCalendarScopeError } from './errors';
import {
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_OAUTH_TOKEN_URL,
  GoogleCalendarNoRefreshTokenError,
  assertReadonlyScope,
  buildGoogleConsentUrl,
  createGoogleOAuthState,
  createGooglePkcePair,
  exchangeGoogleAuthorizationCode,
  isLoopbackRedirect,
} from './oauth';

const CLIENT = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret-value' };
const REDIRECT = 'http://127.0.0.1:53682/oauth2callback';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fake(response: Response): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Google OAuth helpers (ADR-0110 D2)', () => {
  it('builds a calendar.readonly-only, offline, PKCE consent URL with no secret in it', () => {
    const url = new URL(
      buildGoogleConsentUrl({ clientId: CLIENT.clientId, redirectUri: REDIRECT, state: 'state-1', codeChallenge: 'challenge-1' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: GOOGLE_CALENDAR_READONLY_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
    });
    expect(url.toString()).not.toContain(CLIENT.clientSecret);
  });

  it('accepts only an http://127.0.0.1:<port> loopback redirect', () => {
    expect(isLoopbackRedirect(REDIRECT)).toBe(true);
    for (const bad of [
      'http://localhost:53682/cb',
      'https://127.0.0.1:53682/cb',
      'http://127.0.0.1/cb',
      'http://127.0.0.1:53682/cb?x=1',
      'http://example.com:53682/cb',
      'not a url',
    ]) {
      expect(isLoopbackRedirect(bad)).toBe(false);
    }
    expect(() => buildGoogleConsentUrl({ clientId: 'c', redirectUri: 'https://evil.example/cb', state: 's', codeChallenge: 'c' })).toThrow(
      'loopback',
    );
  });

  it('creates an S256 PKCE pair and unguessable states', () => {
    const pair = createGooglePkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    expect(createGooglePkcePair().verifier).not.toBe(pair.verifier);
    expect(createGoogleOAuthState()).not.toBe(createGoogleOAuthState());
  });

  it('accepts exactly calendar.readonly and refuses missing or broader scopes', () => {
    expect(() => assertReadonlyScope(GOOGLE_CALENDAR_READONLY_SCOPE)).not.toThrow();
    expect(() => assertReadonlyScope(` ${GOOGLE_CALENDAR_READONLY_SCOPE}  `)).not.toThrow();
    const missing = (() => {
      try {
        assertReadonlyScope('openid');
      } catch (error) {
        return error as GoogleCalendarScopeError;
      }
      return undefined;
    })();
    expect(missing?.kind).toBe('MISSING');
    expect(missing?.reason).toBe('INSUFFICIENT_SCOPE');
    expect(() => assertReadonlyScope(undefined)).toThrow(GoogleCalendarScopeError);
    expect(() => assertReadonlyScope(`${GOOGLE_CALENDAR_READONLY_SCOPE} openid email`)).toThrow('more than calendar.readonly');
  });

  it('exchanges an authorization code with the PKCE verifier and returns the refresh token', async () => {
    const google = fake(json(200, { access_token: 'a', refresh_token: '1//refresh', expires_in: 3599, scope: GOOGLE_CALENDAR_READONLY_SCOPE }));
    const result = await exchangeGoogleAuthorizationCode(
      CLIENT,
      { code: '4/code', codeVerifier: 'verifier', redirectUri: REDIRECT },
      { fetchImpl: google.fetchImpl, timeoutMs: 1000 },
    );
    expect(result).toEqual({ refreshToken: '1//refresh', scope: GOOGLE_CALENDAR_READONLY_SCOPE });
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(google.calls[0]!.init?.redirect).toBe('error');
    expect(Object.fromEntries(new URLSearchParams(String(google.calls[0]!.init?.body)))).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      code: '4/code',
      code_verifier: 'verifier',
      redirect_uri: REDIRECT,
    });
  });

  it('refuses an exchange without a refresh token or with a broader scope', async () => {
    const noRefresh = fake(json(200, { access_token: 'a', expires_in: 3599, scope: GOOGLE_CALENDAR_READONLY_SCOPE }));
    await expect(
      exchangeGoogleAuthorizationCode(CLIENT, { code: 'c', codeVerifier: 'v', redirectUri: REDIRECT }, { fetchImpl: noRefresh.fetchImpl, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(GoogleCalendarNoRefreshTokenError);

    const broad = fake(json(200, { refresh_token: '1//r', scope: 'https://www.googleapis.com/auth/calendar' }));
    await expect(
      exchangeGoogleAuthorizationCode(CLIENT, { code: 'c', codeVerifier: 'v', redirectUri: REDIRECT }, { fetchImpl: broad.fetchImpl, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(GoogleCalendarScopeError);
  });

  it('maps a rejected code to UNAUTHORIZED without the response content', async () => {
    const google = fake(json(400, { error: 'invalid_grant', error_description: 'Malformed auth code 4/secret-code' }));
    const error = await exchangeGoogleAuthorizationCode(
      CLIENT,
      { code: '4/secret-code', codeVerifier: 'v', redirectUri: REDIRECT },
      { fetchImpl: google.fetchImpl, timeoutMs: 1000 },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorQueryError);
    expect((error as ConnectorQueryError).reason).toBe('UNAUTHORIZED');
    expect((error as Error).message).not.toContain('secret-code');
    expect((error as Error).message).not.toContain(CLIENT.clientSecret);
  });
});
