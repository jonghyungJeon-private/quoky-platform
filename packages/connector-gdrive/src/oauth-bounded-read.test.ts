import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from '@quoky/core';
import { refreshGDriveAccessToken, exchangeGDriveAuthorizationCode, DRIVE_READONLY_SCOPE } from './oauth';

// HARD-1: the token endpoint response is read through a bounded reader (16 KiB cap).
const CLIENT = { clientId: 'client-id', clientSecret: 'client-secret-value' };
const SECRET_TOKEN = 'ya29.fixture-access-token-value';
const CAP = 16 * 1024;
const REFRESH_ARGS = { timeoutMs: 1000, nowMs: 0 };

function ok(): Response {
  return new Response(JSON.stringify({ access_token: SECRET_TOKEN, expires_in: 3599, token_type: 'Bearer', scope: DRIVE_READONLY_SCOPE }), { status: 200 });
}

/** A counting stream of 64 chunks of 16 KiB that records pulls and cancellation. */
function counting(prefix = '{"access_token":"ya29.fixture-access-token-value","pad":"'): { response: Response; state: { pulled: number; cancelled: boolean } } {
  const state = { pulled: 0, cancelled: false };
  const total = 64;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(state.pulled === 0 ? prefix + 'x'.repeat(CAP) : 'x'.repeat(CAP)));
        state.pulled += 1;
        if (state.pulled >= total) controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream, { status: 200 }), state };
}

async function failure(promise: Promise<unknown>): Promise<ConnectorQueryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorQueryError);
    return error as ConnectorQueryError;
  }
  throw new Error('expected a failure');
}

const via = (response: Response) => ((async () => response) as unknown as typeof fetch);

describe('Drive OAuth token response is read bounded (HARD-1)', () => {
  it('a normal token response still works (refresh and code exchange)', async () => {
    await expect(refreshGDriveAccessToken(CLIENT, 'r', { fetchImpl: via(ok()), ...REFRESH_ARGS })).resolves.toMatchObject({ token: SECRET_TOKEN });
    const exchanged = await exchangeGDriveAuthorizationCode(
      CLIENT,
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/cb' },
      { fetchImpl: via(new Response(JSON.stringify({ refresh_token: 'r1', scope: DRIVE_READONLY_SCOPE }))), timeoutMs: 1000 },
    );
    expect(exchanged.refreshToken).toBe('r1');
  });

  it('an oversized declared content-length is refused with INVALID_RESPONSE before reading, and the stream is cancelled', async () => {
    const { response, state } = counting();
    const declared = new Response(response.body, { status: 200, headers: { 'content-length': String(CAP * 64) } });
    const error = await failure(refreshGDriveAccessToken(CLIENT, 'r', { fetchImpl: via(declared), ...REFRESH_ARGS }));
    expect(error.reason).toBe('INVALID_RESPONSE');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(2);
    expect(error.message).not.toContain(SECRET_TOKEN);
  });

  it('an oversized streamed body (no content-length) is cancelled at the cap and fails with INVALID_RESPONSE', async () => {
    for (const run of [
      (r: Response) => refreshGDriveAccessToken(CLIENT, 'r', { fetchImpl: via(r), ...REFRESH_ARGS }),
      (r: Response) =>
        exchangeGDriveAuthorizationCode(CLIENT, { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/cb' }, { fetchImpl: via(r), timeoutMs: 1000 }),
    ]) {
      const { response, state } = counting();
      const error = await failure(run(response));
      expect(error.reason).toBe('INVALID_RESPONSE');
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThan(64);
      expect(error.message).not.toContain(SECRET_TOKEN);
      expect(JSON.stringify(error)).not.toContain(SECRET_TOKEN);
    }
  });

  it('an oversized error body is dropped without buffering it (the status still decides the reason)', async () => {
    const { response, state } = counting('{"error":"invalid_grant","pad":"');
    const bad = new Response(response.body, { status: 400 });
    const error = await failure(refreshGDriveAccessToken(CLIENT, 'r', { fetchImpl: via(bad), ...REFRESH_ARGS }));
    expect(error.reason).toBe('UNAUTHORIZED');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(64);
  });
});
