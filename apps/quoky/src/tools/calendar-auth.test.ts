import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_READONLY_SCOPE, GOOGLE_OAUTH_TOKEN_URL } from '@quoky/connector-calendar-google';

import {
  EXIT_BLOCKED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  classifyCallback,
  listenOnLoopback,
  runCli,
  type CalendarAuthDeps,
  type CallbackHandler,
} from './calendar-auth';

const CLIENT_SECRET = 'client-secret-value';
const REFRESH_TOKEN = '1//refresh-token-value';
const CODE = '4/authorization-code-value';
const PORT = 53682;

interface Harness {
  deps: CalendarAuthDeps;
  out: string[];
  err: string[];
  written: Array<{ path: string; token: string }>;
  fetchCalls: Array<{ url: string; body: string }>;
  closed: () => boolean;
  /** Resolves with the printed consent URL once the helper is waiting for the redirect. */
  consentUrl: () => Promise<URL>;
  callback: (pathAndQuery: string) => { status: number; body: string };
}

function harness(options: { tokenResponse?: Response; exists?: boolean; env?: NodeJS.ProcessEnv; waitMs?: number } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const written: Array<{ path: string; token: string }> = [];
  const fetchCalls: Array<{ url: string; body: string }> = [];
  let handler: CallbackHandler | undefined;
  let closed = false;
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), body: String(init?.body) });
    return (
      options.tokenResponse ??
      new Response(
        JSON.stringify({ access_token: 'ya29.x', refresh_token: REFRESH_TOKEN, expires_in: 3599, scope: GOOGLE_CALENDAR_READONLY_SCOPE }),
        { status: 200 },
      )
    );
  }) as typeof fetch;
  const deps: CalendarAuthDeps = {
    env:
      options.env ??
      ({ QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: CLIENT_SECRET } as NodeJS.ProcessEnv),
    fetchImpl,
    fileExists: () => options.exists ?? false,
    writeTokenFile: (path, token) => {
      written.push({ path, token });
    },
    listen: async (h) => {
      handler = h;
      return {
        port: PORT,
        close: async () => {
          closed = true;
        },
      };
    },
    waitMs: options.waitMs ?? 60_000,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return {
    deps,
    out,
    err,
    written,
    fetchCalls,
    closed: () => closed,
    consentUrl: async () => {
      for (let i = 0; i < 100; i += 1) {
        const line = out.find((entry) => entry.startsWith('https://accounts.google.com/'));
        if (line !== undefined) return new URL(line);
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error('no consent URL printed');
    },
    callback: (pathAndQuery) => {
      if (handler === undefined) throw new Error('not listening');
      return handler(pathAndQuery);
    },
  };
}

function assertNoSecretsPrinted(h: Harness): void {
  const printed = [...h.out, ...h.err].join('\n');
  for (const secret of [CLIENT_SECRET, REFRESH_TOKEN, CODE, 'ya29.x']) expect(printed).not.toContain(secret);
}

describe('calendar consent helper (ADR-0110 D2)', () => {
  it('runs the loopback PKCE flow, writes the refresh token to a new file and prints no secret', async () => {
    const h = harness();
    const run = runCli(['--out', '/tmp/quoky-test/google-calendar-token.json'], h.deps);
    const consent = await h.consentUrl();

    expect(consent.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_READONLY_SCOPE);
    expect(consent.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${PORT}/oauth2callback`);
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    const state = consent.searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(20);

    expect(h.callback('/favicon.ico').status).toBe(404);
    expect(h.callback(`/oauth2callback?state=${state}&code=${encodeURIComponent(CODE)}&scope=x`).status).toBe(200);
    await expect(run).resolves.toBe(EXIT_OK);

    expect(h.written).toEqual([{ path: '/tmp/quoky-test/google-calendar-token.json', token: REFRESH_TOKEN }]);
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0]!.url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    const form = new URLSearchParams(h.fetchCalls[0]!.body);
    expect(form.get('code')).toBe(CODE);
    expect(form.get('redirect_uri')).toBe(`http://127.0.0.1:${PORT}/oauth2callback`);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.out.join('\n')).toContain('QUOKY_CALENDAR_GOOGLE_TOKEN_FILE=/tmp/quoky-test/google-calendar-token.json');
    expect(h.closed()).toBe(true);
    assertNoSecretsPrinted(h);
  });

  it('refuses a redirect with the wrong state and writes nothing', async () => {
    const h = harness();
    const run = runCli(['--out', '/tmp/x.json'], h.deps);
    await h.consentUrl();
    expect(h.callback(`/oauth2callback?state=forged&code=${CODE}`).status).toBe(400);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('did not match');
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.written).toHaveLength(0);
    expect(h.closed()).toBe(true);
  });

  it('reports a declined consent', async () => {
    const h = harness();
    const run = runCli(['--out', '/tmp/x.json'], h.deps);
    const state = (await h.consentUrl()).searchParams.get('state');
    h.callback(`/oauth2callback?state=${state}&error=access_denied`);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('declined');
    expect(h.written).toHaveLength(0);
  });

  it('refuses a broader grant and writes nothing', async () => {
    const h = harness({
      tokenResponse: new Response(
        JSON.stringify({ refresh_token: REFRESH_TOKEN, scope: `${GOOGLE_CALENDAR_READONLY_SCOPE} https://www.googleapis.com/auth/calendar` }),
        { status: 200 },
      ),
    });
    const run = runCli(['--out', '/tmp/x.json'], h.deps);
    const state = (await h.consentUrl()).searchParams.get('state');
    h.callback(`/oauth2callback?state=${state}&code=${CODE}`);
    await expect(run).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('more than calendar.readonly');
    expect(h.written).toHaveLength(0);
    assertNoSecretsPrinted(h);
  });

  it('times out without a redirect', async () => {
    const h = harness({ waitMs: 5 });
    await expect(runCli(['--out', '/tmp/x.json'], h.deps)).resolves.toBe(EXIT_FAILED);
    expect(h.err.join('\n')).toContain('in time');
    expect(h.closed()).toBe(true);
  });

  it('is blocked before listening when the client is missing or the file exists, and checks its arguments', async () => {
    const listen = vi.fn();
    const noClient = harness({ env: {} as NodeJS.ProcessEnv });
    await expect(runCli(['--out', '/tmp/x.json'], { ...noClient.deps, listen })).resolves.toBe(EXIT_BLOCKED);
    const exists = harness({ exists: true });
    await expect(runCli(['--out', '/tmp/x.json'], { ...exists.deps, listen })).resolves.toBe(EXIT_BLOCKED);
    expect(listen).not.toHaveBeenCalled();
    await expect(runCli([], exists.deps)).resolves.toBe(EXIT_USAGE);
    await expect(runCli(['--out'], exists.deps)).resolves.toBe(EXIT_USAGE);
    await expect(runCli(['--help'], exists.deps)).resolves.toBe(EXIT_OK);
  });

  it('classifies callback requests', () => {
    expect(classifyCallback('/other?state=s&code=c', 's')).toBeUndefined();
    expect(classifyCallback('/oauth2callback?state=s&code=c', 's')).toEqual({ kind: 'code', code: 'c' });
    expect(classifyCallback('/oauth2callback?state=s', 's')).toEqual({ kind: 'invalid' });
    expect(classifyCallback('/oauth2callback?state=t&code=c', 's')).toEqual({ kind: 'state-mismatch' });
    expect(classifyCallback('/oauth2callback?code=c', 's')).toEqual({ kind: 'state-mismatch' });
    expect(classifyCallback('/oauth2callback?state=s&error=access_denied', 's')).toEqual({ kind: 'denied' });
  });

  it('the production listener binds 127.0.0.1 only and answers GET with the handler result', async () => {
    const listener = await listenOnLoopback((path) => (path.startsWith('/oauth2callback') ? { status: 200, body: 'ok' } : { status: 404, body: 'no' }));
    try {
      const ok = await fetch(`http://127.0.0.1:${listener.port}/oauth2callback?x=1`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('ok');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      const post = await fetch(`http://127.0.0.1:${listener.port}/oauth2callback`, { method: 'POST' });
      expect(post.status).toBe(405);
    } finally {
      await listener.close();
    }
  });
});
