import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cookieFrom, send } from '../test-support/http-client';
import type { TestResponse } from '../test-support/http-client';
import { OPS_UI_CSP } from './security';
import { OpsUiBindError, OpsUiServer } from './server';
import type { OpsUiServerOptions } from './server';
import type { OpsViewModel } from './view-model';

const VIEW: OpsViewModel = {
  generatedAt: '2026-10-06 14:00:00',
  panels: [
    {
      id: 'runtime',
      title: '런타임 / 상태',
      state: 'OK',
      fields: [
        { label: '빌드 버전', value: '0.1.0' },
        { label: 'tricky', value: '<script>alert(1)</script>" onload="x' },
      ],
      notes: ["<style>body{}</style> it's"],
    },
    {
      id: 'reminders',
      title: '알림 대기열',
      state: 'OK',
      fields: [],
      table: { columns: ['번호', '내용'], rows: [['#1', '<img src=x onerror=alert(1)>']], emptyText: '없음' },
      notes: [],
    },
    { id: 'backup', title: '백업 상태', state: 'UNAVAILABLE', errorCode: 'BACKUP_STATUS_UNAVAILABLE', fields: [], notes: [] },
  ],
};

interface Harness {
  readonly server: OpsUiServer;
  readonly port: number;
  readonly tokenFile: string;
  readonly token: string;
  readonly events: string[];
  readonly clock: { now: number };
}

let dir: string;
const started: OpsUiServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ops-ui-http-'));
});

afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function startServer(overrides: Partial<OpsUiServerOptions> = {}): Promise<Harness> {
  const events: string[] = [];
  const clock = { now: Date.parse('2026-10-06T05:00:00.000Z') };
  const tokenFile = path.join(dir, 'ops-ui.token');
  const server = new OpsUiServer({
    host: '127.0.0.1',
    port: 0,
    tokenFilePath: tokenFile,
    view: async () => VIEW,
    log: {
      info: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
      warn: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
    },
    nowMs: () => clock.now,
    ...overrides,
  });
  const result = await server.start();
  if (result.status !== 'LISTENING') throw new Error(`not listening: ${result.reason}`);
  started.push(server);
  return { server, port: result.port, tokenFile, token: readFileSync(tokenFile, 'utf8').trim(), events, clock };
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

async function signIn(h: Harness): Promise<string> {
  const res = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } });
  expect(res.status).toBe(303);
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('no cookie');
  return cookie;
}

function csrfOf(page: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(page);
  if (!match?.[1]) throw new Error('no csrf');
  return match[1];
}

function expectHardened(res: TestResponse): void {
  expect(res.headers['content-security-policy']).toBe(OPS_UI_CSP);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['cache-control']).toBe('no-store');
  for (const name of Object.keys(res.headers)) expect(name.startsWith('access-control-')).toBe(false);
}

describe('OPS-1 listener: loopback bind (ADR-0113 D2)', () => {
  it('refuses any bind host other than 127.0.0.1 before opening a socket', () => {
    for (const host of ['0.0.0.0', '::', '::1', 'localhost', '192.168.0.10', '']) {
      expect(() => new OpsUiServer({ host, port: 0, tokenFilePath: path.join(dir, 't'), view: async () => VIEW, log: { info() {}, warn() {} } })).toThrow(
        OpsUiBindError,
      );
    }
    expect(existsSync(path.join(dir, 't'))).toBe(false);
  });

  it('binds 127.0.0.1 only', async () => {
    const h = await startServer();
    expect(h.server.boundAddress).toBe('127.0.0.1');
  });

  it('reports a taken port as UNAVAILABLE without writing a token file', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const server = new OpsUiServer({
        host: '127.0.0.1',
        port,
        tokenFilePath: path.join(dir, 'ops-ui.token'),
        view: async () => VIEW,
        log: { info() {}, warn() {} },
      });
      expect(await server.start()).toEqual({ status: 'UNAVAILABLE', reason: 'PORT_IN_USE' });
      expect(existsSync(path.join(dir, 'ops-ui.token'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('refuses a foreign Host header on every route (DNS-rebinding defence)', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    for (const host of ['evil.example', `evil.example:${h.port}`, `127.0.0.1:${h.port + 1}`, `0.0.0.0:${h.port}`, '127.0.0.1']) {
      for (const p of ['/', '/signin', '/ops.css', '/ops.js']) {
        const res = await send({ port: h.port, path: p, host, cookie });
        expect(res.status).toBe(421);
        expectHardened(res);
      }
    }
    const post = await send({ port: h.port, method: 'POST', path: '/session', host: 'evil.example', origin: 'http://evil.example', form: { token: h.token } });
    expect(post.status).toBe(421);
    expect(cookieFrom(post)).toBeUndefined();
    expect((await send({ port: h.port, path: '/ops.css', host: `localhost:${h.port}` })).status).toBe(200);
  });
});

describe('OPS-1 listener: access token and session (ADR-0113 D3)', () => {
  it('writes a 0600 token file, removes it on stop, and uses a different token per start', async () => {
    const first = await startServer();
    expect(lstatSync(first.tokenFile).mode & 0o777).toBe(0o600);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await first.server.stop();
    expect(existsSync(first.tokenFile)).toBe(false);
    const second = await startServer();
    expect(second.token).not.toBe(first.token);
  });

  it('replaces a stale token file and never writes through a symlink', async () => {
    const tokenFile = path.join(dir, 'ops-ui.token');
    writeFileSync(tokenFile, 'stale-token\n', { mode: 0o644 });
    const h = await startServer();
    expect(h.token).not.toBe('stale-token');
    expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600);
    await h.server.stop();

    const target = path.join(dir, 'victim.txt');
    writeFileSync(target, 'do not touch\n');
    symlinkSync(target, tokenFile);
    const again = await startServer();
    expect(readFileSync(target, 'utf8')).toBe('do not touch\n');
    expect(lstatSync(tokenFile).isSymbolicLink()).toBe(false);
    expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(again.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses every request without a valid session except the sign-in page and the two static assets', async () => {
    const h = await startServer();
    const root = await send({ port: h.port, path: '/' });
    expect(root.status).toBe(303);
    expect(root.headers.location).toBe('/signin');
    expect(root.body).toBe('');
    const signin = await send({ port: h.port, path: '/signin' });
    expect(signin.status).toBe(200);
    expect(signin.body).toContain('action="/session"');
    expect((await send({ port: h.port, path: '/ops.css' })).status).toBe(200);
    expect((await send({ port: h.port, path: '/ops.js' })).status).toBe(200);
    const forged = await send({ port: h.port, path: '/', cookie: 'quoky_ops_session=forged' });
    expect(forged.status).toBe(303);
    for (const res of [root, signin, forged]) expect(res.body).not.toContain('빌드 버전');
  });

  it('signs in with the token, sets an HttpOnly SameSite=Strict cookie and serves the dashboard', async () => {
    const h = await startServer();
    const res = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: `  ${h.token}\n` } });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^quoky_ops_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
    const page = await send({ port: h.port, path: '/', cookie: cookieFrom(res) });
    expect(page.status).toBe(200);
    expect(page.body).toContain('빌드 버전');
    // localhost:<port> is an accepted listener origin too.
    const viaLocalhost = await send({
      port: h.port,
      method: 'POST',
      path: '/session',
      host: `localhost:${h.port}`,
      origin: `http://localhost:${h.port}`,
      form: { token: h.token },
    });
    expect(viaLocalhost.status).toBe(303);
  });

  it('rejects a wrong token, and never echoes or logs the token', async () => {
    const h = await startServer();
    const res = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: 'wrong' } });
    expect(res.status).toBe(401);
    expect(cookieFrom(res)).toBeUndefined();
    const ok = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } });
    const dashboard = await send({ port: h.port, path: '/', cookie: cookieFrom(ok) });
    for (const body of [res.body, ok.body, dashboard.body]) expect(body).not.toContain(h.token);
    expect(h.events.join('\n')).not.toContain(h.token);
    expect(h.events.join('\n')).toContain('ops-ui.signin_refused');
  });

  it('rate-limits failed sign-ins: 5 per minute, then a 60 s lockout that also refuses the right token', async () => {
    const h = await startServer();
    for (let i = 0; i < 4; i += 1) {
      expect((await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: `bad${i}` } })).status).toBe(401);
    }
    expect((await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: 'bad4' } })).status).toBe(429);
    const locked = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } });
    expect(locked.status).toBe(429);
    expect(cookieFrom(locked)).toBeUndefined();
    h.clock.now += 59_000;
    expect((await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } })).status).toBe(429);
    h.clock.now += 1_000;
    expect((await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } })).status).toBe(303);
  });

  it('does not lock out on failures spread beyond one minute', async () => {
    const h = await startServer();
    for (let i = 0; i < 8; i += 1) {
      expect((await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: 'bad' } })).status).toBe(401);
      h.clock.now += 20_000;
    }
  });

  it('refuses a sign-in with a foreign or missing Origin, even with the right token', async () => {
    const h = await startServer();
    for (const bad of ['http://evil.example', `http://127.0.0.1:${h.port + 1}`, `https://127.0.0.1:${h.port}`, 'null', undefined]) {
      const res = await send({ port: h.port, method: 'POST', path: '/session', ...(bad !== undefined ? { origin: bad } : {}), form: { token: h.token } });
      expect(res.status).toBe(403);
      expect(cookieFrom(res)).toBeUndefined();
      expectHardened(res);
    }
  });

  it('expires a session after its lifetime', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    h.clock.now += 12 * 60 * 60 * 1000;
    expect((await send({ port: h.port, path: '/', cookie })).status).toBe(303);
  });

  it('drops every session when the process stops (a session never survives a restart)', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    await h.server.stop();
    const next = await startServer();
    expect((await send({ port: next.port, path: '/', cookie })).status).toBe(303);
  });
});

describe('OPS-1 listener: Origin and CSRF (ADR-0113 D4)', () => {
  it('signs out only with the session CSRF token and the listener Origin', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = csrfOf((await send({ port: h.port, path: '/', cookie })).body);

    const noToken = await send({ port: h.port, method: 'POST', path: '/session/end', origin: origin(h.port), cookie, form: {} });
    expect(noToken.status).toBe(403);
    const wrongToken = await send({ port: h.port, method: 'POST', path: '/session/end', origin: origin(h.port), cookie, form: { csrf: 'x' } });
    expect(wrongToken.status).toBe(403);
    const foreign = await send({ port: h.port, method: 'POST', path: '/session/end', origin: 'http://evil.example', cookie, form: { csrf } });
    expect(foreign.status).toBe(403);
    const noOrigin = await send({ port: h.port, method: 'POST', path: '/session/end', cookie, form: { csrf } });
    expect(noOrigin.status).toBe(403);
    // still signed in after every refusal
    expect((await send({ port: h.port, path: '/', cookie })).status).toBe(200);

    const ok = await send({ port: h.port, method: 'POST', path: '/session/end', origin: origin(h.port), cookie, form: { csrf } });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/signin');
    expect(String(ok.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await send({ port: h.port, path: '/', cookie })).status).toBe(303);
  });

  it('refuses sign-out without a session', async () => {
    const h = await startServer();
    const res = await send({ port: h.port, method: 'POST', path: '/session/end', origin: origin(h.port), form: { csrf: 'x' } });
    expect(res.status).toBe(403);
  });

  it('has no state-changing endpoint beyond sign-in and sign-out (Phase 1)', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = csrfOf((await send({ port: h.port, path: '/', cookie })).body);
    for (const p of ['/', '/approve', '/reject', '/reminders/cancel', '/memory/forget', '/api/snapshot', '/chat']) {
      const res = await send({ port: h.port, method: 'POST', path: p, origin: origin(h.port), cookie, form: { csrf } });
      expect(res.status).toBe(404);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await send({ port: h.port, method, path: '/', origin: origin(h.port), cookie });
      expect(res.status).toBe(405);
      expectHardened(res);
    }
    // the session is unaffected by all of the above
    expect((await send({ port: h.port, path: '/', cookie })).status).toBe(200);
  });

  it('refuses a non-form body and an oversized body', async () => {
    const h = await startServer();
    const json = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token }, contentType: 'application/json' });
    expect(json.status).toBe(415);
    const big = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: 'x'.repeat(5000) } });
    expect(big.status).toBe(413);
    expect(cookieFrom(json)).toBeUndefined();
  });
});

describe('OPS-1 listener: CSP and inline-free pages (ADR-0113 D4)', () => {
  it('sends the exact CSP, nosniff, no-referrer and no-store on every response, and no CORS header', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const responses = [
      await send({ port: h.port, path: '/signin' }),
      await send({ port: h.port, path: '/' }),
      await send({ port: h.port, path: '/', cookie }),
      await send({ port: h.port, path: '/ops.css' }),
      await send({ port: h.port, path: '/ops.js' }),
      await send({ port: h.port, path: '/missing' }),
      await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: 'bad' } }),
      await send({ port: h.port, method: 'POST', path: '/session', origin: 'http://evil.example', form: { token: 'bad' } }),
    ];
    for (const res of responses) expectHardened(res);
    expect(OPS_UI_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(OPS_UI_CSP).not.toContain('unsafe-inline');
    expect(OPS_UI_CSP).not.toContain('unsafe-eval');
    expect(OPS_UI_CSP).not.toMatch(/nonce-|sha256-/);
  });

  it('serves pages with no inline script, inline style, style= attribute or on*= handler, with every dynamic string escaped', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const pages = [
      (await send({ port: h.port, path: '/signin' })).body,
      (await send({ port: h.port, path: '/', cookie })).body,
      (await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: 'bad' } })).body,
    ];
    for (const page of pages) {
      const scripts = page.match(/<script\b[^>]*>/gi) ?? [];
      expect(scripts).toEqual(['<script src="/ops.js" defer>']);
      expect(page).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/i);
      expect(page).not.toMatch(/<style\b/i);
      // Attributes live only inside tags; escaped text can never open one (no raw `<` survives escaping).
      const tags = page.match(/<[a-z!/][^>]*>/gi) ?? [];
      expect(tags.length).toBeGreaterThan(5);
      for (const tag of tags) {
        expect(tag).not.toMatch(/\sstyle\s*=/i);
        expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
        expect(tag).not.toMatch(/javascript:/i);
      }
    }
    const dashboard = pages[1] ?? '';
    expect(dashboard).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot; onload=&quot;x');
    expect(dashboard).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(dashboard).toContain('&lt;style&gt;body{}&lt;/style&gt; it&#39;s');
    expect(dashboard).toContain('BACKUP_STATUS_UNAVAILABLE');
  });

  it('serves the stylesheet and script with their own content types', async () => {
    const h = await startServer();
    const css = await send({ port: h.port, path: '/ops.css' });
    const js = await send({ port: h.port, path: '/ops.js' });
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.body).toContain('location.reload');
    expect(js.body).not.toMatch(/fetch\(|XMLHttpRequest|eval\(/);
  });
});
