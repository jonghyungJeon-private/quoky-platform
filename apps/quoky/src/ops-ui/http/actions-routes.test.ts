import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cookieFrom, send } from '../test-support/http-client';
import type { TestResponse } from '../test-support/http-client';
import { OPS_MAX_CODE_ATTEMPTS, OPS_INTENT_TTL_MS } from './intents';
import { OPS_UI_CSP } from './security';
import { OpsUiServer } from './server';
import type { OpsActionOutcome, OpsActions, OpsViewModel } from './view-model';

/**
 * OPS-2 request side (ADR-0113 D4/D7): every handling POST needs the session, the listener Origin and the session
 * CSRF token; executing posts also need the one-time action nonce, whose subject is fixed server-side; a double
 * submit runs the action once; the forget confirm needs the issued code typed back; there is no approve or reject.
 */

const VIEW: OpsViewModel = {
  generatedAt: '2026-10-06 14:00:00',
  panels: [
    {
      id: 'reminders',
      title: '알림 대기열',
      state: 'OK',
      fields: [],
      table: {
        columns: ['번호', '내용'],
        rows: [['#1', '회의 준비'], ['#2', '전달 중']],
        emptyText: '없음',
        rowLinks: [{ label: '취소…', href: '/actions/reminders/cancel?no=1' }, null],
      },
      notes: [],
    },
    {
      id: 'memory',
      title: '기억 보관함',
      state: 'OK',
      fields: [],
      notes: [],
      links: [
        { label: '기억 잊기', href: '/memories' },
        { label: 'evil', href: '//evil.example/x' },
        { label: 'js', href: 'javascript:alert(1)' },
      ],
    },
  ],
};

const CODE = 'K7QM';

class FakeActions implements OpsActions {
  readonly calls: string[] = [];
  /** Resolves cancel only when released (to hold a submit in flight). */
  hold: Promise<void> | undefined;

  async reminderCancelPreview(displayNo: number) {
    this.calls.push(`preview ${displayNo}`);
    if (displayNo === 9) {
      return { status: 'REFUSED' as const, outcome: { code: 'NOT_FOUND', message: '그 번호의 알림을 찾지 못했어요.', ok: false } };
    }
    return { status: 'FOUND' as const, displayNo, label: '<b>회의 준비</b>', nextAt: '2026-10-07 09:00:00' };
  }
  async cancelReminder(displayNo: number): Promise<OpsActionOutcome> {
    this.calls.push(`cancel ${displayNo}`);
    if (this.hold) await this.hold;
    return { code: 'CANCELED', message: '알림을 취소했어요. 더 이상 보내지 않아요.', ok: true };
  }
  async listMemories() {
    this.calls.push('list');
    return { status: 'OK' as const, rows: [{ number: 1, preview: '커피는 <아메리카노>' }], total: 1 };
  }
  async requestForget(number: number) {
    this.calls.push(`request ${number}`);
    if (number === 9) return { status: 'REFUSED' as const, outcome: { code: 'NOT_FOUND', message: '없어요', ok: false } };
    return { status: 'CONFIRMATION' as const, number, preview: '커피는 <아메리카노>', code: CODE };
  }
  async confirmForget(code: string): Promise<OpsActionOutcome> {
    this.calls.push(`confirm ${code}`);
    return { code: 'FORGOTTEN', message: '기억을 잊었어요.', ok: true };
  }
}

interface Harness {
  readonly port: number;
  readonly token: string;
  readonly actions: FakeActions;
  readonly events: string[];
  readonly clock: { now: number };
}

let dir: string;
const started: OpsUiServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ops-ui-actions-'));
});

afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function startServer(): Promise<Harness> {
  const events: string[] = [];
  const actions = new FakeActions();
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
    actions,
  });
  const result = await server.start();
  if (result.status !== 'LISTENING') throw new Error('not listening');
  started.push(server);
  return { port: result.port, token: readFileSync(tokenFile, 'utf8').trim(), actions, events, clock };
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

async function signIn(h: Harness): Promise<string> {
  const res = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('no cookie');
  return cookie;
}

function field(page: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(page);
  if (!match?.[1]) throw new Error(`no ${name}`);
  return match[1];
}

async function csrfOf(h: Harness, cookie: string): Promise<string> {
  return field((await send({ port: h.port, path: '/', cookie })).body, 'csrf');
}

function post(h: Harness, p: string, form: Record<string, string>, cookie?: string, from = origin(h.port)): Promise<TestResponse> {
  return send({ port: h.port, method: 'POST', path: p, origin: from, form, ...(cookie === undefined ? {} : { cookie }) });
}

async function cancelPage(h: Harness, cookie: string, no = 1): Promise<{ csrf: string; nonce: string; body: string }> {
  const res = await send({ port: h.port, path: `/actions/reminders/cancel?no=${no}`, cookie });
  expect(res.status).toBe(200);
  return { csrf: field(res.body, 'csrf'), nonce: field(res.body, 'nonce'), body: res.body };
}

function expectInlineFree(page: string): void {
  expect(page.match(/<script\b[^>]*>/gi) ?? []).toEqual(['<script src="/ops.js" defer>']);
  expect(page).not.toMatch(/<style\b/i);
  for (const tag of page.match(/<[a-z!/][^>]*>/gi) ?? []) {
    expect(tag).not.toMatch(/\sstyle\s*=/i);
    expect(tag).not.toMatch(/\son[a-z]+\s*=/i);
    expect(tag).not.toMatch(/javascript:/i);
  }
}

describe('OPS-2 routes: session, Origin and CSRF (ADR-0113 D4)', () => {
  it('refuses every handling POST without a session, before any action runs', async () => {
    const h = await startServer();
    for (const p of ['/actions/reminders/cancel', '/actions/memories/forget/request', '/actions/memories/forget/confirm']) {
      const res = await post(h, p, { csrf: 'x', nonce: 'x', number: '1', code: CODE });
      expect(res.status).toBe(403);
    }
    expect((await send({ port: h.port, path: '/memories' })).status).toBe(303);
    expect((await send({ port: h.port, path: '/actions/reminders/cancel?no=1' })).status).toBe(303);
    expect(h.actions.calls).toEqual([]);
  });

  it('refuses a handling POST without the CSRF token, with a wrong one, or from a foreign or missing Origin', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const { csrf, nonce } = await cancelPage(h, cookie);
    expect((await post(h, '/actions/reminders/cancel', { nonce }, cookie)).status).toBe(403);
    expect((await post(h, '/actions/reminders/cancel', { nonce, csrf: 'wrong' }, cookie)).status).toBe(403);
    expect((await post(h, '/actions/reminders/cancel', { nonce, csrf }, cookie, 'http://evil.example')).status).toBe(403);
    const noOrigin = await send({ port: h.port, method: 'POST', path: '/actions/reminders/cancel', cookie, form: { nonce, csrf } });
    expect(noOrigin.status).toBe(403);
    expect((await post(h, '/actions/memories/forget/request', { number: '1' }, cookie)).status).toBe(403);
    expect(h.actions.calls).toEqual(['preview 1']);
    // The intent survived every refusal: the genuine submit still runs once.
    expect((await post(h, '/actions/reminders/cancel', { nonce, csrf }, cookie)).status).toBe(200);
    expect(h.actions.calls).toEqual(['preview 1', 'cancel 1']);
  });

  it('serves hardened, inline-free handling pages with every dynamic string escaped', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = await csrfOf(h, cookie);
    const dashboard = (await send({ port: h.port, path: '/', cookie })).body;
    expect(dashboard).toContain('<a class="action" href="/actions/reminders/cancel?no=1">취소…</a>');
    expect(dashboard).toContain('<a class="action" href="/memories">기억 잊기</a>');
    expect(dashboard).not.toContain('evil.example');
    expect(dashboard).not.toContain('javascript:');
    const responses = [
      await send({ port: h.port, path: '/actions/reminders/cancel?no=1', cookie }),
      await send({ port: h.port, path: '/memories', cookie }),
      await post(h, '/actions/memories/forget/request', { csrf, number: '1' }, cookie),
    ];
    for (const res of responses) {
      expect(res.headers['content-security-policy']).toBe(OPS_UI_CSP);
      expect(res.headers['cache-control']).toBe('no-store');
      expectInlineFree(res.body);
    }
    expect(responses[0]?.body).toContain('&lt;b&gt;회의 준비&lt;/b&gt;');
    expect(responses[1]?.body).toContain('커피는 &lt;아메리카노&gt;');
    expect(responses[2]?.body).toContain('커피는 &lt;아메리카노&gt;');
  });
});

describe('OPS-2 routes: one-time intents and idempotent double submit (ADR-0113 D7)', () => {
  it('runs a reminder cancel once for a repeated submit, answering the repeat with the same outcome', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const { csrf, nonce } = await cancelPage(h, cookie);
    const first = await post(h, '/actions/reminders/cancel', { csrf, nonce }, cookie);
    const second = await post(h, '/actions/reminders/cancel', { csrf, nonce }, cookie);
    expect(first.status).toBe(200);
    expect(first.body).toContain('CANCELED');
    expect(first.body).not.toContain('이미 처리한 요청');
    expect(second.status).toBe(200);
    expect(second.body).toContain('CANCELED');
    expect(second.body).toContain('이미 처리한 요청');
    expect(h.actions.calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel 1']);
    expect(h.events.filter((e) => e.startsWith('ops-ui.action '))).toEqual([
      'ops-ui.action {"surface":"ops-ui","action":"reminder.cancel","outcome":"CANCELED","repeated":false}',
      'ops-ui.action {"surface":"ops-ui","action":"reminder.cancel","outcome":"CANCELED","repeated":true}',
    ]);
  });

  it('runs a reminder cancel once for two concurrent submits', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const { csrf, nonce } = await cancelPage(h, cookie);
    let release: () => void = () => undefined;
    h.actions.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const both = Promise.all([
      post(h, '/actions/reminders/cancel', { csrf, nonce }, cookie),
      post(h, '/actions/reminders/cancel', { csrf, nonce }, cookie),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.actions.calls.filter((c) => c.startsWith('cancel'))).toEqual(['cancel 1']);
  });

  it('takes the subject from the server-side intent: a tampered number is ignored', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const { csrf, nonce } = await cancelPage(h, cookie, 1);
    await post(h, '/actions/reminders/cancel', { csrf, nonce, no: '2', displayNo: '2' }, cookie);
    expect(h.actions.calls).toEqual(['preview 1', 'cancel 1']);
  });

  it('refuses a missing, unknown, foreign-session, expired or wrong-kind nonce', async () => {
    const h = await startServer();
    const cookieA = await signIn(h);
    const cookieB = await signIn(h);
    const a = await cancelPage(h, cookieA);
    const csrfB = await csrfOf(h, cookieB);
    expect((await post(h, '/actions/reminders/cancel', { csrf: a.csrf }, cookieA)).status).toBe(409);
    expect((await post(h, '/actions/reminders/cancel', { csrf: a.csrf, nonce: 'made-up' }, cookieA)).status).toBe(409);
    expect((await post(h, '/actions/reminders/cancel', { csrf: csrfB, nonce: a.nonce }, cookieB)).status).toBe(409);
    expect((await post(h, '/actions/memories/forget/confirm', { csrf: a.csrf, nonce: a.nonce, code: CODE }, cookieA)).status).toBe(409);
    h.clock.now += OPS_INTENT_TTL_MS;
    expect((await post(h, '/actions/reminders/cancel', { csrf: a.csrf, nonce: a.nonce }, cookieA)).status).toBe(409);
    expect(h.actions.calls.filter((c) => !c.startsWith('preview'))).toEqual([]);
  });

  it('drops a session intents on sign-out', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const { csrf, nonce } = await cancelPage(h, cookie);
    await post(h, '/session/end', { csrf }, cookie);
    expect((await post(h, '/actions/reminders/cancel', { csrf, nonce }, cookie)).status).toBe(403);
    expect(h.actions.calls).toEqual(['preview 1']);
  });

  it('shows a refused preview without issuing an intent, and rejects a malformed number', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const refused = await send({ port: h.port, path: '/actions/reminders/cancel?no=9', cookie });
    expect(refused.status).toBe(200);
    expect(refused.body).toContain('NOT_FOUND');
    expect(refused.body).not.toContain('name="nonce"');
    for (const bad of ['0', '-1', 'abc', '1.5', '12345', '']) {
      expect((await send({ port: h.port, path: `/actions/reminders/cancel?no=${bad}`, cookie })).status).toBe(400);
    }
  });
});

describe('OPS-2 routes: memory forget needs the code (ADR-0106 D4, ADR-0113 D7)', () => {
  it('issues the code on a POST, refuses a wrong code, then confirms once with the issued code', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = await csrfOf(h, cookie);
    expect((await send({ port: h.port, path: '/memories', cookie })).body).toContain('/actions/memories/forget/request');
    const confirmPage = await post(h, '/actions/memories/forget/request', { csrf, number: '1' }, cookie);
    expect(confirmPage.status).toBe(200);
    expect(confirmPage.body).toContain(CODE);
    const nonce = field(confirmPage.body, 'nonce');

    const wrong = await post(h, '/actions/memories/forget/confirm', { csrf, nonce, code: 'ZZZZ' }, cookie);
    expect(wrong.body).toContain('확인 코드가 맞지 않아요');
    const empty = await post(h, '/actions/memories/forget/confirm', { csrf, nonce }, cookie);
    expect(empty.body).toContain('확인 코드가 맞지 않아요');
    expect(h.actions.calls).toEqual(['list', 'request 1']);

    const ok = await post(h, '/actions/memories/forget/confirm', { csrf, nonce, code: CODE.toLowerCase() }, cookie);
    expect(ok.body).toContain('FORGOTTEN');
    const again = await post(h, '/actions/memories/forget/confirm', { csrf, nonce, code: CODE }, cookie);
    expect(again.body).toContain('이미 처리한 요청');
    expect(h.actions.calls).toEqual(['list', 'request 1', `confirm ${CODE}`]);
    expect(h.events.join('\n')).not.toContain(CODE);
  });

  it(`closes the request after ${OPS_MAX_CODE_ATTEMPTS} wrong codes`, async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = await csrfOf(h, cookie);
    const nonce = field((await post(h, '/actions/memories/forget/request', { csrf, number: '1' }, cookie)).body, 'nonce');
    let last: TestResponse | undefined;
    for (let i = 0; i < OPS_MAX_CODE_ATTEMPTS; i += 1) last = await post(h, '/actions/memories/forget/confirm', { csrf, nonce, code: 'ZZZZ' }, cookie);
    expect(last?.body).toContain('CODE_ATTEMPTS_EXCEEDED');
    expect((await post(h, '/actions/memories/forget/confirm', { csrf, nonce, code: CODE }, cookie)).status).toBe(409);
    expect(h.actions.calls.filter((c) => c.startsWith('confirm'))).toEqual([]);
  });

  it('answers a refused request without a confirm form, and rejects a malformed number', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = await csrfOf(h, cookie);
    const refused = await post(h, '/actions/memories/forget/request', { csrf, number: '9' }, cookie);
    expect(refused.body).toContain('NOT_FOUND');
    expect(refused.body).not.toContain('name="nonce"');
    expect((await post(h, '/actions/memories/forget/request', { csrf, number: 'x' }, cookie)).status).toBe(400);
  });
});

describe('OPS-2 routes: no approval decision surface (OPS-2b)', () => {
  it('has no approve or reject route, even with handling actions wired', async () => {
    const h = await startServer();
    const cookie = await signIn(h);
    const csrf = await csrfOf(h, cookie);
    for (const p of ['/approve', '/reject', '/actions/approvals/approve', '/actions/approvals/reject', '/actions/approve', '/actions/reject']) {
      expect((await post(h, p, { csrf, id: 'approval-1' }, cookie)).status).toBe(404);
      expect((await send({ port: h.port, path: p, cookie })).status).toBe(404);
    }
  });
});
