import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cookieFrom, send } from '../test-support/http-client';
import { OPS_INTENT_TTL_MS } from './intents';
import { OPS_UI_CSP } from './security';
import { OpsUiServer } from './server';
import type { OpsActionOutcome, OpsActions, OpsProviderSelectionPage } from './view-model';

/**
 * Runtime model switch on the operations UI (ADR-0092 / ADR-0111 amendments; ADR-0113 D4/D7 protections): the
 * `/providers` page needs a session; every change is a same-origin POST with the session CSRF token and a one-time
 * nonce whose subject is fixed server-side; a double submit runs once; each step leaves a content-free audit line.
 */

const PAGE: OpsProviderSelectionPage = {
  status: 'OK',
  chat: {
    effective: 'claude:sonnet',
    source: '설정 QUOKY_CHAT_PROVIDER',
    readiness: '준비됨',
    options: [
      { subject: 'chat:claude:sonnet', label: 'claude:sonnet', readiness: '준비됨', egress: '클라우드', current: true },
      { subject: 'chat:codex', label: '<codex>', readiness: '준비됨', egress: '클라우드 (OpenAI로 전송)', current: false },
    ],
    reset: { subject: 'chat:reset', label: '설정 기본값으로 되돌리기 (대화)', readiness: '', egress: '', current: false },
  },
  image: {
    effective: 'off',
    source: '설정',
    readiness: '',
    options: [
      { subject: 'image:claude', label: 'claude', readiness: '준비됨', egress: '클라우드', current: false, warning: '이 선택은 첨부 이미지를 이 컴퓨터 밖(Anthropic)으로 보내요.' },
      { subject: 'image:off', label: 'off', readiness: '', egress: '사용 안 함', current: true },
    ],
  },
  sessionOverrides: '2개',
  notes: ['코드 작업은 항상 Claude가 맡아요.'],
};

class FakeActions implements OpsActions {
  readonly calls: string[] = [];
  async reminderCancelPreview() {
    return { status: 'REFUSED' as const, outcome: { code: 'X', message: 'x', ok: false } };
  }
  async cancelReminder(): Promise<OpsActionOutcome> {
    return { code: 'X', message: 'x', ok: false };
  }
  async listMemories() {
    return { status: 'OK' as const, rows: [], total: 0 };
  }
  async requestForget() {
    return { status: 'REFUSED' as const, outcome: { code: 'X', message: 'x', ok: false } };
  }
  async confirmForget(): Promise<OpsActionOutcome> {
    return { code: 'X', message: 'x', ok: false };
  }
  async providerSelection() {
    this.calls.push('page');
    return PAGE;
  }
  async setProviderDefault(subject: string): Promise<OpsActionOutcome> {
    this.calls.push(`set ${subject}`);
    return { code: 'DEFAULT_SET', message: `기본값을 바꿨어요 <${subject}>`, ok: true };
  }
}

let dir: string;
const started: OpsUiServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ops-ui-providers-'));
});
afterEach(async () => {
  for (const server of started.splice(0)) await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function start(actions: OpsActions = new FakeActions()) {
  const events: string[] = [];
  const clock = { now: Date.parse('2026-10-07T05:00:00.000Z') };
  const tokenFile = path.join(dir, 'ops-ui.token');
  const server = new OpsUiServer({
    host: '127.0.0.1',
    port: 0,
    tokenFilePath: tokenFile,
    view: async () => ({ generatedAt: 'now', panels: [] }),
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
  const port = result.port;
  const token = readFileSync(tokenFile, 'utf8').trim();
  const origin = `http://127.0.0.1:${port}`;
  const signIn = async () => {
    const res = await send({ port, method: 'POST', path: '/session', origin, form: { token } });
    const cookie = cookieFrom(res);
    if (!cookie) throw new Error('no cookie');
    return cookie;
  };
  const post = (form: Record<string, string>, cookie?: string, from = origin) =>
    send({ port, method: 'POST', path: '/actions/providers/select', origin: from, form, ...(cookie === undefined ? {} : { cookie }) });
  return { port, events, clock, signIn, post, actions: actions as FakeActions };
}

/**
 * The (csrf, nonce) pair of an option's form: a table row's form follows its label; the reset form's button text (its
 * label) follows the form's hidden fields.
 */
function formFor(page: string, label: string, where: 'after' | 'before' = 'after'): { csrf: string; nonce: string } {
  const at = page.indexOf(label);
  const start = where === 'after' ? page.indexOf('<form', at) : page.lastIndexOf('<form', at);
  const form = page.slice(start, page.indexOf('</form>', start));
  const csrf = /name="csrf" value="([^"]+)"/.exec(form)?.[1];
  const nonce = /name="nonce" value="([^"]+)"/.exec(form)?.[1];
  if (at < 0 || start < 0 || !csrf || !nonce) throw new Error(`no form for ${label}`);
  return { csrf, nonce };
}

describe('/providers page', () => {
  it('needs a session; renders sources, readiness, warnings, escaped labels and one form per non-current option', async () => {
    const h = await start();
    expect((await send({ port: h.port, path: '/providers' })).status).toBe(303);
    expect(h.actions.calls).toEqual([]);
    const cookie = await h.signIn();
    const res = await send({ port: h.port, path: '/providers', cookie });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(OPS_UI_CSP);
    expect(res.body).toContain('설정 QUOKY_CHAT_PROVIDER');
    expect(res.body).toContain('대화별로 따로 바꾼 대화: 2개');
    expect(res.body).toContain('이 선택은 첨부 이미지를 이 컴퓨터 밖(Anthropic)으로 보내요.');
    expect(res.body).toContain('&lt;codex&gt;');
    expect(res.body).not.toContain('<codex>');
    // Current options get no form; the others and the reset each get one with a distinct nonce.
    const nonces = [...res.body.matchAll(/name="nonce" value="([^"]+)"/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(3);
    expect(res.body).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/i);
    // The subject never appears in a form field.
    expect(res.body).not.toContain('value="chat:codex"');
  });

  it('a change needs the session, the Origin and the CSRF token, then runs once with the server-side subject', async () => {
    const h = await start();
    const cookie = await h.signIn();
    const page = (await send({ port: h.port, path: '/providers', cookie })).body;
    const { csrf, nonce } = formFor(page, '&lt;codex&gt;');
    expect((await h.post({ csrf, nonce })).status).toBe(403); // no session
    expect((await h.post({ nonce }, cookie)).status).toBe(403); // no CSRF
    expect((await h.post({ nonce, csrf: 'wrong' }, cookie)).status).toBe(403);
    expect((await h.post({ nonce, csrf }, cookie, 'http://evil.example')).status).toBe(403);
    expect((await h.post({ csrf, nonce: 'forged' }, cookie)).status).toBe(409);
    // A tampered extra field cannot redirect the change: the subject is the nonce's.
    const ran = await h.post({ csrf, nonce, subject: 'chat:claude:opus' }, cookie);
    expect(ran.status).toBe(200);
    expect(ran.body).toContain('DEFAULT_SET');
    expect(ran.body).toContain('기본값을 바꿨어요 &lt;chat:codex&gt;');
    const again = await h.post({ csrf, nonce }, cookie);
    expect(again.body).toContain('이미 처리한 요청이라 다시 실행하지 않았어요.');
    expect(h.actions.calls).toEqual(['page', 'set chat:codex']);
    expect(h.events.filter((e) => e.startsWith('ops-ui.action '))).toEqual([
      'ops-ui.action {"surface":"ops-ui","action":"provider.select","outcome":"DEFAULT_SET","repeated":false}',
      'ops-ui.action {"surface":"ops-ui","action":"provider.select","outcome":"DEFAULT_SET","repeated":true}',
    ]);
  });

  it('the reset form and an image option carry their own subjects; nonces expire with the intent window', async () => {
    const h = await start();
    const cookie = await h.signIn();
    const page = (await send({ port: h.port, path: '/providers', cookie })).body;
    const reset = formFor(page, '설정 기본값으로 되돌리기 (대화)', 'before');
    const image = formFor(page, '이 선택은 첨부 이미지를');
    expect((await h.post(reset, cookie)).status).toBe(200);
    h.clock.now += OPS_INTENT_TTL_MS;
    expect((await h.post(image, cookie)).status).toBe(409);
    expect(h.actions.calls).toEqual(['page', 'set chat:reset']);
  });

  it('without the provider-selection actions there is no page and no route', async () => {
    const bare = new FakeActions() as Partial<FakeActions>;
    delete (bare as { providerSelection?: unknown }).providerSelection;
    Object.defineProperty(bare, 'providerSelection', { value: undefined });
    const h = await start(bare as OpsActions);
    const cookie = await h.signIn();
    expect((await send({ port: h.port, path: '/providers', cookie })).status).toBe(404);
    expect((await h.post({ csrf: 'x', nonce: 'x' }, cookie)).status).toBe(404);
  });
});
