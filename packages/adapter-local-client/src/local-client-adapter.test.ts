import { chmodSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { outboundMessage } from '@quoky/core';
import type { ConversationContext } from '@quoky/core';

import { OWNER, openStream, postMessage, raw, request, startHarness } from './test-support';
import type { Harness } from './test-support';

const open: Harness[] = [];
async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const harness = await startHarness(options);
  open.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.cleanup();
});

const ctx: ConversationContext = { platform: 'local-client', channelId: 'local-client-dm', userId: OWNER, direct: true };
const wrong = (): string => ['wr', 'ong', 'tok', 'en'].join('-');
const turn = (h: Harness, payload: Record<string, unknown> = {}) =>
  postMessage(h.socket, h.token(), { clientMessageId: 'cm-1', text: '안녕', ...payload });

describe('start (ADR-0125 D2, D3)', () => {
  it('binds a 0600 socket, then writes a 0600 token file, and exposes status', async () => {
    const h = await start();
    expect(statSync(h.socket).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(h.dir, 'local-client.token')).mode & 0o777).toBe(0o600);
    expect(h.token().length).toBeGreaterThanOrEqual(43);
    const status = await request(h.socket, { path: '/client/v1/status', token: h.token() });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ status: 'ready', epoch: h.adapter.epoch });
    expect(h.adapter.status()).toMatchObject({ enabled: true, listening: true, openStreams: 0, authFailuresLastHour: 0 });
  });

  it('removes the socket and the token file on clean stop', async () => {
    const h = await start();
    await h.adapter.stop();
    expect(existsSync(h.socket)).toBe(false);
    expect(existsSync(path.join(h.dir, 'local-client.token'))).toBe(false);
  });

  it('the token differs per start', async () => {
    const a = await start();
    const first = a.token();
    await a.adapter.stop();
    const b = await start({ dir: a.dir });
    expect(b.token()).not.toBe(first);
    expect(b.adapter.epoch).not.toBe(a.adapter.epoch);
  });

  it.each([
    ['no owner configured', { ownerUserId: undefined }, 'OWNER_NOT_CONFIGURED'],
    ['owner not a Discord owner', { ownerIsDiscordOwner: false }, 'OWNER_NOT_DISCORD_OWNER'],
    ['owner maps to no single Actor', { verifyOwner: async () => false }, 'OWNER_UNRESOLVED'],
    ['owner check throws', { verifyOwner: async () => Promise.reject(new Error('x')) }, 'OWNER_UNRESOLVED'],
    ['no instance lock', { instanceLockHeld: false }, 'NO_INSTANCE_LOCK'],
    ['in-memory database', { fileBackedDb: false }, 'DB_NOT_FILE_BACKED'],
  ] as const)('fails closed: %s', async (_name, override, reason) => {
    const h = await start(override as never);
    expect(h.adapter.status()).toMatchObject({ enabled: false, listening: false, disabledReason: reason });
    expect(existsSync(h.socket)).toBe(false);
    expect(existsSync(path.join(h.dir, 'local-client.token'))).toBe(false);
  });

  it('refuses a group- or other-accessible data directory', async () => {
    const h = await start({ dir: undefined });
    await h.adapter.stop();
    chmodSync(h.dir, 0o755);
    const again = await start({ dir: h.dir });
    expect(again.adapter.status().disabledReason).toBe('DATA_DIR_UNSAFE');
    chmodSync(h.dir, 0o700);
  });
});

describe('auth and request hygiene (D3)', () => {
  it('401 for a missing or wrong token, counted; the valid token works', async () => {
    const h = await start();
    expect((await request(h.socket, { path: '/client/v1/status' })).status).toBe(401);
    expect((await request(h.socket, { path: '/client/v1/status', token: wrong() })).status).toBe(401);
    expect((await request(h.socket, { path: '/client/v1/status', token: h.token() })).status).toBe(200);
    expect(h.adapter.status().authFailuresLastHour).toBe(2);
  });

  it('a wrong-token flood opens a lockout (429) but never blocks the valid token', async () => {
    const h = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await request(h.socket, { path: '/client/v1/status', token: wrong() })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    expect((await request(h.socket, { path: '/client/v1/status', token: h.token() })).status).toBe(200);
    expect((await turn(h)).status).toBe(202);
    // Only failures were counted.
    expect(h.adapter.status().authFailuresLastHour).toBe(5);
  });

  it('refuses a foreign Host, any Origin, OPTIONS, other paths, other methods and any query', async () => {
    const h = await start();
    const token = h.token();
    expect((await request(h.socket, { path: '/client/v1/status', token, headers: { Host: 'example.com' } })).status).toBe(400);
    expect((await request(h.socket, { path: '/client/v1/status', token, headers: { Host: 'localhost:80' } })).status).toBe(400);
    expect((await request(h.socket, { path: '/client/v1/status', token, headers: { Host: undefined } })).status).toBe(400);
    const origin = await request(h.socket, { path: '/client/v1/status', token, headers: { Origin: 'http://localhost' } });
    expect(origin.status).toBe(403);
    expect(origin.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(h.socket, { method: 'OPTIONS', path: '/client/v1/messages', token })).status).toBe(405);
    for (const probe of [
      { path: '/' },
      { path: '/client/v1/' },
      { path: '/client/v2/status' },
      { path: '/client/v1/status?x=1' },
      { path: '/client/v1/status/' },
      { path: '/client/v1/%73tatus' },
      { path: '/client/v1/notices/ack', method: 'POST', body: '{}' },
      { path: '/client/v1/approvals/00000000-0000-4000-8000-000000000000/decision', method: 'POST', body: '{}' },
      { path: '/client/v1/status', method: 'DELETE' },
      { path: '/client/v1/messages', method: 'GET' },
    ]) {
      const reply = await request(h.socket, { token, ...probe });
      expect(reply.status, JSON.stringify(probe)).toBe(404);
      expect(reply.body).toBe('');
    }
  });

  it('the OPS-UI token does not work here (a different secret)', async () => {
    const h = await start();
    const opsToken = Buffer.from(h.token(), 'base64url').reverse().toString('base64url');
    expect((await request(h.socket, { path: '/client/v1/status', token: opsToken })).status).toBe(401);
  });

  it('requires application/json with one Content-Length, and bounds the body and the text', async () => {
    const h = await start();
    const token = h.token();
    const body = JSON.stringify({ clientMessageId: 'cm-1', text: 'hi' });
    const post = (headers: Record<string, string | undefined>, payload: string | Buffer = body) =>
      request(h.socket, { method: 'POST', path: '/client/v1/messages', token, body: payload, headers });
    expect((await post({ 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post({ 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post({ 'Content-Type': undefined })).status).toBe(415);
    // Refused from the declared length alone, before any body byte is read.
    const tooBig = await raw(
      h.socket,
      `POST /client/v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${17 * 1024}\r\n\r\n`,
    );
    expect(tooBig.startsWith('HTTP/1.1 413')).toBe(true);
    expect(tooBig).toContain('{"code":"BODY_TOO_LARGE"}');
    const longText = await post({}, JSON.stringify({ clientMessageId: 'cm-2', text: 'y'.repeat(4001) }));
    expect(longText.status).toBe(413);
    expect(JSON.parse(longText.body)).toEqual({ code: 'TEXT_TOO_LONG' });
    expect((await post({}, JSON.stringify({ clientMessageId: 'cm-3', text: 'y'.repeat(4000) }))).status).toBe(202);
    expect(h.messages).toHaveLength(1);
  });

  it.each([
    ['not json', '{nope', 'JSON_INVALID'],
    ['array', '[]', 'JSON_INVALID'],
    ['invalid utf-8', Buffer.from([0x7b, 0xff, 0x7d]), 'JSON_INVALID'],
    ['unknown field (no provider or model can be chosen)', JSON.stringify({ clientMessageId: 'a', text: 'x', provider: 'p' }), 'UNKNOWN_FIELD'],
    ['id charset', JSON.stringify({ clientMessageId: 'a b', text: 'x' }), 'CLIENT_MESSAGE_ID_INVALID'],
    ['id overlong', JSON.stringify({ clientMessageId: 'a'.repeat(65), text: 'x' }), 'CLIENT_MESSAGE_ID_INVALID'],
    ['id unicode', JSON.stringify({ clientMessageId: 'ａｂ', text: 'x' }), 'CLIENT_MESSAGE_ID_INVALID'],
    ['thread charset', JSON.stringify({ clientMessageId: 'a', text: 'x', threadId: '../x' }), 'THREAD_ID_INVALID'],
    ['replyTo charset', JSON.stringify({ clientMessageId: 'a', text: 'x', replyToEventId: 'a:b' }), 'REPLY_TO_INVALID'],
    ['empty text', JSON.stringify({ clientMessageId: 'a', text: '   ' }), 'TEXT_INVALID'],
    ['text not a string', JSON.stringify({ clientMessageId: 'a', text: 5 }), 'TEXT_INVALID'],
  ] as const)('400 for %s', async (_name, body, expected) => {
    const h = await start();
    const reply = await request(h.socket, { method: 'POST', path: '/client/v1/messages', token: h.token(), body });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({ code: expected });
    expect(h.messages).toHaveLength(0);
  });
});

describe('framing and smuggling (D3)', () => {
  const head = (token: string, extra = '') => `POST /client/v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\n${extra}`;
  const json = JSON.stringify({ clientMessageId: 'cm-s', text: 'smuggle' });

  it('400 for Transfer-Encoding with Content-Length, a bare chunked body, and a repeated Content-Length', async () => {
    const h = await start();
    const t = h.token();
    const cases = [
      `${head(t, `Content-Length: ${json.length}\r\nTransfer-Encoding: chunked\r\n`)}\r\n0\r\n\r\nGET /x HTTP/1.1\r\n\r\n`,
      `${head(t, 'Transfer-Encoding: chunked\r\n')}\r\n${json.length.toString(16)}\r\n${json}\r\n0\r\n\r\n`,
      `${head(t, `Content-Length: ${json.length}\r\nContent-Length: ${json.length}\r\n`)}\r\n${json}`,
      `${head(t, `Content-Length: ${json.length}\r\nContent-Length: 5\r\n`)}\r\n${json}`,
    ];
    for (const bytes of cases) expect((await raw(h.socket, bytes)).startsWith('HTTP/1.1 400'), bytes).toBe(true);
    expect(h.messages).toHaveLength(0);
  });

  it('400 for a repeated Host, Authorization or Origin-like confusion and for obsolete line folding', async () => {
    const h = await start();
    const t = h.token();
    const dupHost = `GET /client/v1/status HTTP/1.1\r\nHost: localhost\r\nHost: localhost\r\nAuthorization: Bearer ${t}\r\n\r\n`;
    const dupAuth = `GET /client/v1/status HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${t}\r\nAuthorization: Bearer ${t}\r\n\r\n`;
    const folded = `GET /client/v1/status HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${t}\r\nX-A: one\r\n two\r\n\r\n`;
    for (const bytes of [dupHost, dupAuth, folded]) expect((await raw(h.socket, bytes)).startsWith('HTTP/1.1 400'), bytes).toBe(true);
  });

  it('400 for a header block over 8 KiB and for Expect: 100-continue', async () => {
    const h = await start();
    const t = h.token();
    const huge = `GET /client/v1/status HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${t}\r\nX-Pad: ${'a'.repeat(9000)}\r\n\r\n`;
    expect((await raw(h.socket, huge)).startsWith('HTTP/1.1 400')).toBe(true);
    const expect100 = `${head(t, `Content-Length: ${json.length}\r\nExpect: 100-continue\r\n`)}\r\n`;
    const out = await raw(h.socket, expect100);
    expect(out).not.toContain('100 Continue');
    expect(out.startsWith('HTTP/1.1 400')).toBe(true);
  });

  it('serves a pipelined second request never: one turn only, then the connection closes', async () => {
    const h = await start();
    const t = h.token();
    const one = `${head(t, `Content-Length: ${json.length}\r\n`)}\r\n${json}`;
    const two = `${head(t, `Content-Length: ${json.length}\r\n`)}\r\n${json.replace('cm-s', 'cm-t')}`;
    const out = await raw(h.socket, one + two);
    expect(out.startsWith('HTTP/1.1 202')).toBe(true);
    expect(out.match(/HTTP\/1\.1 202/g)).toHaveLength(1);
    expect(h.messages).toHaveLength(1);
  });

  it('drops a connection that sends headers too slowly', async () => {
    const h = await start({ headersTimeoutMs: 300, requestTimeoutMs: 600 });
    const out = await raw(h.socket, 'GET /client/v1/status HTTP/1.1\r\nHost: localhost\r\n', 3000);
    expect(out).not.toContain('HTTP/1.1 2');
    expect((await request(h.socket, { path: '/client/v1/status', token: h.token() })).status).toBe(200);
  });
});

describe('turns (D4)', () => {
  it('mints an lc-<uuid> id, maps the owner, direct: true, thread and replyTo', async () => {
    const h = await start();
    const reply = await turn(h, { clientMessageId: 'cm-abc', threadId: 'th-1', replyToEventId: 'ev-9' });
    expect(reply.status).toBe(202);
    const body = JSON.parse(reply.body) as { turnId: string; epoch: string };
    expect(body.epoch).toBe(h.adapter.epoch);
    expect(body.turnId).toMatch(/^lc-[0-9a-f-]{36}$/);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({
      id: body.turnId,
      text: '안녕',
      context: { platform: 'local-client', channelId: 'local-client-dm', threadId: 'th-1', userId: OWNER, direct: true },
      replyTo: { messageId: 'ev-9' },
    });
    expect(h.messages[0]?.id).not.toContain('cm-abc');
  });

  it('dedupes by clientMessageId: same text replays the first turnId, another text or thread is 409', async () => {
    const h = await start();
    const first = JSON.parse((await turn(h)).body) as { turnId: string };
    const again = await turn(h);
    expect(again.status).toBe(202);
    expect(JSON.parse(again.body).turnId).toBe(first.turnId);
    expect(h.messages).toHaveLength(1);
    const text = await turn(h, { text: '다른 말' });
    expect(text.status).toBe(409);
    expect(JSON.parse(text.body)).toEqual({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await turn(h, { threadId: 'other' })).status).toBe(409);
    expect(h.messages).toHaveLength(1);
  });

  it('an id that equals a Core-style uuid is only a dedupe key and never the message id', async () => {
    const h = await start();
    const coreLike = '11111111-2222-4333-8444-555555555555';
    await turn(h, { clientMessageId: coreLike });
    expect(h.messages[0]?.id).not.toBe(coreLike);
  });

  it('limits turns per minute (429)', async () => {
    const h = await start({ maxTurnsPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await turn(h, { clientMessageId: `cm-${i}` })).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    // a replay of an accepted turn is not a new turn
    expect((await turn(h, { clientMessageId: 'cm-0' })).status).toBe(202);
  });

  it('is 503 NOT_READY and queues nothing until the inbound gate opens; status says starting', async () => {
    let open: (value: boolean) => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => (open = resolve));
    const h = await start({ gate });
    const status = await request(h.socket, { path: '/client/v1/status', token: h.token() });
    expect(JSON.parse(status.body)).toEqual({ status: 'starting', epoch: h.adapter.epoch });
    const refused = await turn(h);
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toEqual({ code: 'NOT_READY' });
    expect((await request(h.socket, { path: '/client/v1/events', token: h.token() })).status).toBe(503);
    expect(h.messages).toHaveLength(0);
    open(true);
    await new Promise((r) => setTimeout(r, 20));
    expect((await turn(h)).status).toBe(202);
    expect(h.messages).toHaveLength(1);
  });

  it('stops the adapter when the gate resolves false', async () => {
    const h = await start({ gate: Promise.resolve(false) });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.adapter.status()).toMatchObject({ enabled: false, listening: false, disabledReason: 'INBOUND_GATE_CLOSED' });
    expect(existsSync(h.socket)).toBe(false);
  });

  it('is 503 until a message handler is registered', async () => {
    const h = await start({ noHandler: true });
    expect((await turn(h)).status).toBe(503);
  });

  it('a throwing runtime handler never breaks the surface', async () => {
    const h = await start({ noHandler: true });
    h.adapter.onMessage(async () => Promise.reject(new Error('boom')));
    expect((await turn(h)).status).toBe(202);
    expect((await request(h.socket, { path: '/client/v1/status', token: h.token() })).status).toBe(200);
  });
});

describe('events (D4)', () => {
  it('streams replies with <epoch>-<seq> ids and returns the id as the delivery receipt', async () => {
    const h = await start();
    const stream = await openStream(h.socket, h.token());
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    const receipt = await h.adapter.sendMessage({ ...outboundMessage(ctx, '답변이에요'), replyToMessageId: undefined } as never);
    const id = `${h.adapter.epoch}-1`;
    expect(receipt).toEqual({ platformMessageIds: [id] });
    const text = await stream.until((t) => t.includes('event: reply'));
    expect(text).toContain(`id: ${id}\n`);
    expect(text).toContain('"text":"답변이에요"');
    expect(text).toContain('event: status');
    await h.adapter.sendTyping({ ...ctx, threadId: 'th' });
    await stream.until((t) => t.includes('event: typing'));
    stream.close();
  });

  it('carries the turnId and thread of the turn it answers, and typed spans for untrusted text', async () => {
    const h = await start();
    const stream = await openStream(h.socket, h.token());
    const accepted = JSON.parse((await turn(h, { threadId: 'th-1' })).body) as { turnId: string };
    const { untrustedText, messageContent, outboundMessage: build } = await import('@quoky/core');
    const content = messageContent('제목: ', untrustedText('<@everyone> 회의', 'markup'));
    await h.adapter.sendMessage({ ...build({ ...ctx, threadId: 'th-1' }, content), replyToMessageId: accepted.turnId } as never);
    const text = await stream.until((t) => t.includes('event: reply'));
    const data = JSON.parse(/event: reply\ndata: (.*)\n/.exec(text)?.[1] ?? '{}') as { turnId: string; threadId: string; content: Array<{ type: string; text: string }>; text: string };
    expect(data.turnId).toBe(accepted.turnId);
    expect(data.threadId).toBe('th-1');
    expect(data.text).toBe('제목: <@everyone> 회의');
    expect(data.content).toEqual([
      { type: 'text', text: '제목: ' },
      { type: 'untrusted', text: '<@everyone> 회의' },
    ]);
    stream.close();
  });

  it('resumes from a valid Last-Event-ID of this epoch and replays only newer events', async () => {
    const h = await start();
    for (const text of ['one', 'two', 'three']) await h.adapter.sendMessage(outboundMessage(ctx, text) as never);
    const stream = await openStream(h.socket, h.token(), { 'Last-Event-ID': `${h.adapter.epoch}-1` });
    const text = await stream.until((t) => t.includes('three'));
    expect(text).not.toContain('resync');
    expect(text).not.toContain('"text":"one"');
    expect(text).toContain('"text":"two"');
    expect(text).toContain(`id: ${h.adapter.epoch}-3\n`);
    stream.close();
  });

  it.each([
    ['another epoch', (e: string) => `${e === 'a' ? 'b' : 'a'}-1`],
    ['a future seq', (e: string) => `${e}-99`],
    ['non-numeric', (e: string) => `${e}-x`],
    ['negative', (e: string) => `${e}--1`],
    ['overlong', (e: string) => `${e}-${'9'.repeat(40)}`],
    ['overlong epoch', () => `${'a'.repeat(200)}-1`],
    ['garbage', () => '../../etc/passwd'],
    ['empty-ish', () => ' '],
  ])('resyncs without replaying for %s', async (_name, build) => {
    const h = await start();
    await h.adapter.sendMessage(outboundMessage(ctx, 'secret reply one') as never);
    const stream = await openStream(h.socket, h.token(), { 'Last-Event-ID': build(h.adapter.epoch) });
    const text = await stream.until((t) => t.includes('event: status'));
    expect(text).toContain('"resync":true');
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.text()).not.toContain('secret reply one');
    expect(stream.text()).not.toContain('event: reply');
    stream.close();
  });

  // 'a seq before the ring' is in the local-client-surface corpus (forged-last-event-id).

  it.each([
    ['a replay that passes the backlog bound', 12, 2000],
    ['a single queued reply that alone passes the bound', 1, 20_000],
  ])('treats %s as not resumable: 200, resync, no replay, stream kept open', async (_name, count, size) => {
    // Regression: such a resume used to be destroyed before the head was flushed (0 bytes, dropped again on every retry).
    const h = await start({ maxStreamBacklogBytes: 16 * 1024 });
    for (let i = 0; i < count; i += 1) await h.adapter.sendMessage(outboundMessage(ctx, `${i}:${'q'.repeat(size)}`) as never);
    const req = `GET /client/v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${h.token()}\r\nLast-Event-ID: ${h.adapter.epoch}-0\r\n\r\n`;
    const pending = raw(h.socket, req, 300);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.adapter.status().openStreams).toBe(1);
    const out = await pending;
    expect(out.startsWith('HTTP/1.1 200')).toBe(true);
    expect(out).toContain('event: status');
    expect(out).toContain('"resync":true');
    expect(out).not.toContain('event: reply');
    expect(h.adapter.peakStreamBacklogBytes).toBeLessThanOrEqual(16 * 1024);
  });

  it('allows at most 2 streams (429) and sends heartbeat comments', async () => {
    const h = await start({ heartbeatMs: 40 });
    const a = await openStream(h.socket, h.token());
    const b = await openStream(h.socket, h.token());
    expect((await request(h.socket, { path: '/client/v1/events', token: h.token() })).status).toBe(429);
    await a.until((t) => t.includes(': hb'));
    expect(h.adapter.status().openStreams).toBe(2);
    a.close();
    b.close();
  });

  it('a request with a wrong token never opens a stream', async () => {
    const h = await start();
    expect((await request(h.socket, { path: '/client/v1/events', token: wrong() })).status).toBe(401);
  });

  it('events carry no token, path, provider id or stack', async () => {
    const h = await start();
    const stream = await openStream(h.socket, h.token());
    await turn(h);
    await h.adapter.sendMessage(outboundMessage(ctx, 'plain answer') as never);
    await stream.until((t) => t.includes('event: reply'));
    const all = stream.text();
    expect(all).not.toContain(h.token());
    expect(all).not.toContain(h.dir);
    expect(all).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    stream.close();
  });
});

describe('rotation (D3)', () => {
  it('writes a new 0600 token file, invalidates the old token at once and closes every stream', async () => {
    const h = await start();
    const oldToken = h.token();
    const stream = await openStream(h.socket, oldToken);
    const rotated = await request(h.socket, { method: 'POST', path: '/client/v1/token/rotate', token: oldToken, body: '{}' });
    expect(rotated.status).toBe(200);
    expect(rotated.body).not.toContain(h.token());
    await stream.closed();
    expect(h.token()).not.toBe(oldToken);
    expect(statSync(path.join(h.dir, 'local-client.token')).mode & 0o777).toBe(0o600);
    expect((await request(h.socket, { path: '/client/v1/status', token: oldToken })).status).toBe(401);
    expect((await request(h.socket, { path: '/client/v1/status', token: h.token() })).status).toBe(200);
  });

  it('needs the valid token', async () => {
    const h = await start();
    expect((await request(h.socket, { method: 'POST', path: '/client/v1/token/rotate', token: wrong(), body: '{}' })).status).toBe(401);
  });
});

describe('no outbound reach', () => {
  it('another platform context is never delivered', async () => {
    const h = await start();
    const receipt = await h.adapter.sendMessage(outboundMessage({ ...ctx, platform: 'discord' }, 'x') as never);
    expect(receipt).toEqual({ platformMessageIds: [] });
  });

  it('keeps no token or socket path in the status', async () => {
    const h = await start();
    const json = JSON.stringify(h.adapter.status());
    expect(json).not.toContain(h.token());
    expect(json).not.toContain(h.dir);
    expect(readFileSync(path.join(h.dir, 'local-client.token'), 'utf8')).toContain(h.token());
  });
});

describe('the live-check client (ADR-0125 D2: curl --unix-socket reaches it)', () => {
  const curl = spawnSync('curl', ['--version']);
  it.skipIf(curl.status !== 0)('answers a curl request with the contract headers', async () => {
    const h = await start();
    // Async spawn: the server runs in this process, so a blocking spawnSync would starve it.
    const run = (args: string[], stdin?: string): Promise<{ stdout: string }> =>
      new Promise((resolve) => {
        const child = spawn('curl', ['--silent', '--max-time', '5', '--unix-socket', h.socket, '--write-out', '|%{http_code}', ...args]);
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.on('close', () => resolve({ stdout }));
        child.stdin.end(stdin ?? '');
      });
    const ok = await run(['-K', '-', '-H', 'Host: localhost', 'http://localhost/client/v1/status'], `header = "Authorization: Bearer ${h.token()}"\n`);
    expect(ok.stdout).toBe(`{"status":"ready","epoch":"${h.adapter.epoch}"}|200`);
    // curl's default Host would be localhost; an Origin header is still refused.
    const origin = await run(['-K', '-', '-H', 'Origin: http://localhost', 'http://localhost/client/v1/status'], `header = "Authorization: Bearer ${h.token()}"\n`);
    expect(origin.stdout).toContain('|403');
    expect((await run(['http://localhost/client/v1/status'])).stdout).toContain('|401');
  });
});
