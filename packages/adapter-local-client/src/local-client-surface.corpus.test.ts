import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { messageContent, outboundMessage, untrustedText } from '@quoky/core';
import type { ConversationContext, OutboundMessage } from '@quoky/core';

import { OWNER, leaveStaleSocket, openStream, postMessage, raw, request, startHarness, tempDataDir } from './test-support';
import type { Harness } from './test-support';

/**
 * The deterministic `local-client-surface` red-team family (ADR-0125, "Red-team lot"), LC-1b part: every group except
 * "Approvals" and "Notices" (LC-4). No model call. Each case is an ATTACK that returns true when it SUCCEEDED; the
 * suite passes only with 0 successes, and each group keeps at least its minimum of cases. The ratified gate runs this
 * family 3 times at 0 successes before the flag may be turned on; this file is the repeatable form of one run.
 */

type Group =
  | 'token-and-scope'
  | 'socket-path'
  | 'no-tcp'
  | 'lockout-dos'
  | 'idempotency'
  | 'forged-last-event-id'
  | 'approval-id-encoding'
  | 'smuggling'
  | 'floods'
  | 'leakage'
  | 'content-imitation';

const MINIMUM: Record<Group, number> = {
  'token-and-scope': 8,
  'socket-path': 8,
  'no-tcp': 4,
  'lockout-dos': 4,
  idempotency: 6,
  'forged-last-event-id': 5,
  'approval-id-encoding': 6,
  smuggling: 6,
  floods: 6,
  leakage: 10,
  'content-imitation': 8,
};

interface Attack {
  readonly group: Group;
  readonly name: string;
  /** true = the attack succeeded (a finding). */
  run(): Promise<boolean>;
}

const harnesses: Harness[] = [];
const cleanups: Array<() => void> = [];
async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const harness = await startHarness(options);
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const frag = (...parts: string[]): string => parts.join('');
const ctx: ConversationContext = { platform: 'local-client', channelId: 'local-client-dm', userId: OWNER, direct: true };
const ok2xx = (status: number): boolean => status >= 200 && status < 300;
const GET_STATUS = '/client/v1/status';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const attacks: Attack[] = [];
const add = (group: Group, name: string, run: () => Promise<boolean>): void => void attacks.push({ group, name, run });

// ---- Token and scope (8)
const asStatus = async (h: Harness, headers: Record<string, string>) => (await request(h.socket, { path: GET_STATUS, headers: { Authorization: undefined, ...headers } })).status;
add('token-and-scope', 'no Authorization header', async () => ok2xx(await asStatus(await start(), {})));
add('token-and-scope', 'empty bearer', async () => ok2xx(await asStatus(await start(), { Authorization: 'Bearer ' })));
add('token-and-scope', 'wrong token', async () => ok2xx(await asStatus(await start(), { Authorization: `Bearer ${frag('no', 'pe')}` })));
add('token-and-scope', 'valid token with a trailing space and with a prefix cut', async () => {
  const h = await start();
  const t = h.token();
  return ok2xx(await asStatus(h, { Authorization: `Bearer ${t} x` })) || ok2xx(await asStatus(h, { Authorization: `Bearer ${t.slice(0, 20)}` }));
});
add('token-and-scope', 'the Basic scheme and a token in a cookie or the query', async () => {
  const h = await start();
  const t = h.token();
  const basic = await asStatus(h, { Authorization: `Basic ${Buffer.from(`x:${t}`).toString('base64')}` });
  const cookie = await asStatus(h, { Cookie: `token=${t}` });
  const query = (await request(h.socket, { path: `${GET_STATUS}?token=${t}` })).status;
  return ok2xx(basic) || ok2xx(cookie) || ok2xx(query);
});
add('token-and-scope', 'the OPS-UI style token (a different secret)', async () => {
  const h = await start();
  return ok2xx(await asStatus(h, { Authorization: `Bearer ${Buffer.from(h.token(), 'base64url').reverse().toString('base64url')}` }));
});
add('token-and-scope', 'a token from a previous start', async () => {
  const first = await start();
  const old = first.token();
  await first.adapter.stop();
  const second = await start({ dir: first.dir });
  return ok2xx(await asStatus(second, { Authorization: `Bearer ${old}` }));
});
add('token-and-scope', 'a token from before a rotation', async () => {
  const h = await start();
  const old = h.token();
  await request(h.socket, { method: 'POST', path: '/client/v1/token/rotate', token: old, body: '{}' });
  return ok2xx(await asStatus(h, { Authorization: `Bearer ${old}` }));
});

// ---- Server impersonation / socket path (8)
const disabledWith = async (prepare: (dir: string) => void | Promise<void>, expectKept?: (dir: string) => boolean): Promise<boolean> => {
  const dir = tempDataDir();
  await prepare(dir);
  const h = await start({ dir });
  const listening = h.adapter.status().listening;
  const tokenWritten = existsSync(path.join(dir, 'local-client.token'));
  const kept = expectKept === undefined ? true : expectKept(dir);
  return listening || tokenWritten || !kept;
};
const sockOf = (dir: string): string => path.join(dir, 'local-client.sock');
add('socket-path', 'a pre-placed regular file', () => disabledWith((d) => writeFileSync(sockOf(d), 'x'), (d) => readFileSync(sockOf(d), 'utf8') === 'x'));
add('socket-path', 'a pre-placed symlink', () => disabledWith((d) => symlinkSync('/etc', sockOf(d)), (d) => existsSync(sockOf(d))));
add('socket-path', 'a pre-placed directory', () => disabledWith((d) => mkdirSync(sockOf(d)), (d) => existsSync(sockOf(d))));
add('socket-path', 'a 0755 data directory', () => disabledWith((d) => chmodSync(d, 0o755)));
add('socket-path', 'a live second server', async () => {
  const dir = tempDataDir();
  const live = net.createServer((c) => c.end());
  await new Promise<void>((r) => live.listen(sockOf(dir), r));
  cleanups.push(() => live.close());
  const h = await start({ dir });
  return h.adapter.status().listening || existsSync(path.join(dir, 'local-client.token'));
});
add('socket-path', 'an over-long path (no TCP fallback)', async () => {
  const dir = path.join(tempDataDir(), '나'.repeat(40));
  mkdirSync(dir, { mode: 0o700 });
  const h = await start({ dir });
  return h.adapter.status().listening;
});
add('socket-path', 'a socket swapped after bind is not unlinked at stop', async () => {
  const h = await start();
  renameSync(h.socket, path.join(h.dir, 'moved'));
  writeFileSync(h.socket, 'theirs');
  await h.adapter.stop();
  return readFileSync(h.socket, 'utf8') !== 'theirs';
});
add('socket-path', 'a replaced token file is not removed at stop', async () => {
  const h = await start();
  const t = path.join(h.dir, 'local-client.token');
  unlinkSync(t);
  writeFileSync(t, 'theirs', { mode: 0o600 });
  await h.adapter.stop();
  return !existsSync(t) || readFileSync(t, 'utf8') !== 'theirs';
});
add('socket-path', 'a stale socket of ours (probe refused) does not keep the surface down while the lock is held', async () => {
  const dir = tempDataDir();
  await leaveStaleSocket(sockOf(dir));
  const h = await start({ dir });
  return !h.adapter.status().listening;
});
add('socket-path', 'a stale socket is never unlinked without the instance lock', async () => {
  const dir = tempDataDir();
  await leaveStaleSocket(sockOf(dir));
  const h = await start({ dir, instanceLockHeld: false });
  return h.adapter.status().listening || lstatSync(sockOf(dir), { throwIfNoEntry: false })?.isSocket() !== true;
});
add('socket-path', 'a data directory owned by another uid', async () => {
  const dir = tempDataDir();
  const h = await start({ dir, uid: (process.getuid?.() ?? 0) + 1 });
  return h.adapter.status().listening || h.adapter.status().disabledReason !== 'DATA_DIR_UNSAFE' || existsSync(sockOf(dir)) || existsSync(path.join(dir, 'local-client.token'));
});

// ---- No TCP reach (4)
add('no-tcp', 'no TCP listener appears with the flag on', async () => {
  await start();
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles.some((handle) => handle instanceof net.Server && typeof (handle as net.Server).address() === 'object' && (handle as net.Server).address() !== null);
});
add('no-tcp', 'a browser-style form post (Origin) is refused before any handler', async () => {
  const h = await start();
  const r = await request(h.socket, { method: 'POST', path: '/client/v1/messages', token: h.token(), headers: { Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'text=hi' });
  return ok2xx(r.status) || h.messages.length > 0;
});
add('no-tcp', 'a rebinding Host is refused', async () => {
  const h = await start();
  const r = await request(h.socket, { path: GET_STATUS, token: h.token(), headers: { Host: 'quoky.evil.example' } });
  return ok2xx(r.status);
});
add('no-tcp', 'a no-cors EventSource-style open with an Origin gets no stream', async () => {
  const h = await start();
  const r = await request(h.socket, { path: '/client/v1/events', token: h.token(), headers: { Origin: 'null' } });
  return ok2xx(r.status);
});

// ---- Lockout DoS (4)
const floodThenValid = async (probe: (h: Harness) => Promise<number>): Promise<boolean> => {
  const h = await start();
  const token = h.token();
  for (let i = 0; i < 12; i += 1) await request(h.socket, { path: GET_STATUS, token: frag('bad', String(i)) });
  void token;
  return !ok2xx(await probe(h));
};
add('lockout-dos', 'valid status during a lockout is served', () => floodThenValid(async (h) => (await request(h.socket, { path: GET_STATUS, token: h.token() })).status));
add('lockout-dos', 'a valid turn during a lockout is served', () => floodThenValid(async (h) => (await postMessage(h.socket, h.token(), { clientMessageId: 'cm-l', text: 'hi' })).status));
add('lockout-dos', 'a valid event stream during a lockout is served', () =>
  floodThenValid(async (h) => {
    const s = await openStream(h.socket, h.token());
    s.close();
    return s.status;
  }),
);
add('lockout-dos', 'the lockout ends by itself and does not count valid requests', async () => {
  let now = 1_000_000;
  const h = await start({ nowMs: () => now });
  for (let i = 0; i < 6; i += 1) await request(h.socket, { path: GET_STATUS, token: frag('bad', String(i)) });
  const locked = (await request(h.socket, { path: GET_STATUS, token: frag('bad', 'x') })).status === 429;
  now += 61_000;
  const after = (await request(h.socket, { path: GET_STATUS, token: frag('bad', 'y') })).status;
  return !locked || after !== 401;
});

// ---- Idempotency abuse (6)
const turn = (h: Harness, p: Record<string, unknown>) => postMessage(h.socket, h.token(), { clientMessageId: 'cm-1', text: 'a', ...p });
add('idempotency', 'same key, another text, makes no second turn', async () => {
  const h = await start();
  await turn(h, {});
  const r = await turn(h, { text: 'b' });
  return r.status !== 409 || h.messages.length !== 1;
});
add('idempotency', 'same key, another thread, makes no second turn', async () => {
  const h = await start();
  await turn(h, {});
  const r = await turn(h, { threadId: 't' });
  return r.status !== 409 || h.messages.length !== 1;
});
add('idempotency', 'a replay after a restart (new epoch) is a new turn the client can tell apart', async () => {
  const a = await start();
  const first = JSON.parse((await turn(a, {})).body) as { epoch: string };
  await a.adapter.stop();
  const b = await start({ dir: a.dir });
  const second = JSON.parse((await turn(b, {})).body) as { epoch: string };
  return first.epoch === second.epoch;
});
add('idempotency', 'charset and length abuse on the key', async () => {
  const h = await start();
  const bad = ['a b', 'a/b', 'a\u0000b', '', 'a'.repeat(65), '한글', 'a;b', '../x', 'a\nb'];
  for (const key of bad) if (ok2xx((await turn(h, { clientMessageId: key })).status)) return true;
  return h.messages.length > 0;
});
add('idempotency', 'ring overflow stays bounded and still detects a recent conflict', async () => {
  const h = await start({ maxTurnsPerMinute: 10_000 });
  for (let i = 0; i < 530; i += 1) await turn(h, { clientMessageId: `k${i}` });
  const conflict = await turn(h, { clientMessageId: 'k529', text: 'other' });
  return conflict.status !== 409;
});
add('idempotency', 'a key shaped like a Core id never becomes the message id', async () => {
  const h = await start();
  const key = '3f2b8c1e-9d4a-4e7b-8a21-6c5d4e3f2a10';
  await turn(h, { clientMessageId: key });
  return h.messages[0]?.id.includes(key) === true || !/^lc-/.test(h.messages[0]?.id ?? '');
});

// ---- Forged Last-Event-ID (6)
const forged = (build: (epoch: string) => string): (() => Promise<boolean>) => async () => {
  const h = await start();
  await h.adapter.sendMessage(outboundMessage(ctx, 'private earlier reply') as OutboundMessage);
  const s = await openStream(h.socket, h.token(), { 'Last-Event-ID': build(h.adapter.epoch) });
  await sleep(40);
  const leaked = s.text().includes('private earlier reply') || s.status !== 200;
  s.close();
  return leaked;
};
add('forged-last-event-id', 'another epoch', forged((e) => `${e === 'a' ? 'b' : 'a'}-0`));
add('forged-last-event-id', 'a future seq', forged((e) => `${e}-999`));
add('forged-last-event-id', 'non-numeric', forged((e) => `${e}-abc`));
add('forged-last-event-id', 'negative', forged((e) => `${e}--5`));
add('forged-last-event-id', 'overlong', forged((e) => `${e}-${'1'.repeat(500)}`));
add('forged-last-event-id', 'a path-like value', forged(() => '../../etc/passwd'));
add('forged-last-event-id', 'a seq before the ring (more than 200 events behind) replays nothing', async () => {
  const h = await start();
  for (let i = 0; i < 205; i += 1) await h.adapter.sendMessage(outboundMessage(ctx, `m${i}`) as OutboundMessage);
  const s = await openStream(h.socket, h.token(), { 'Last-Event-ID': `${h.adapter.epoch}-2` });
  await s.until((t) => t.includes('event: status'));
  await sleep(40);
  const replayed = !s.text().includes('"resync":true') || s.text().includes('event: reply');
  s.close();
  return replayed;
});

// ---- Encoded / traversal approvalId (6): the decision endpoint does not exist in LC-1b, and an encoded id never reaches a handler.
const GOOD = '3f2b8c1e-9d4a-4e7b-8a21-6c5d4e3f2a10';
for (const [name, id] of [
  ['%2F', '%2F..%2F'],
  ['%2e%2e', '%2e%2e'],
  ['dot-dot', '..'],
  ['NUL', `${GOOD}%00`],
  ['double encoding', '%252e%252e'],
  ['Unicode look-alike', GOOD.replace('a', 'а')],
  ['uppercase', GOOD.toUpperCase()],
  ['overlong', 'a'.repeat(5000)],
] as const) {
  add('approval-id-encoding', name, async () => {
    const h = await start();
    const body = JSON.stringify({ decision: 'approve', threadId: 't' });
    // raw bytes: the Node client itself refuses some of these targets, an attacker would not
    const out = await raw(h.socket, `POST /client/v1/approvals/${id}/decision HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${h.token()}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    // a 404 with no body, or a 400 from the parser itself: never a handler, never a 2xx
    return !(out.startsWith('HTTP/1.1 404') || out.startsWith('HTTP/1.1 400')) || /HTTP\/1\.1 2\d\d/.test(out) || h.messages.length > 0;
  });
}

// ---- Header and body smuggling (6)
const J = JSON.stringify({ clientMessageId: 'cm-s', text: 'smuggled' });
const head = (t: string, extra: string): string => `POST /client/v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${t}\r\nContent-Type: application/json\r\n${extra}`;
const smuggle = (build: (t: string) => string): (() => Promise<boolean>) => async () => {
  const h = await start();
  const out = await raw(h.socket, build(h.token()));
  return /HTTP\/1\.1 2\d\d/.test(out) || h.messages.length > 0;
};
add('smuggling', 'Transfer-Encoding with Content-Length', smuggle((t) => `${head(t, `Content-Length: ${J.length}\r\nTransfer-Encoding: chunked\r\n`)}\r\n0\r\n\r\n${J}`));
add('smuggling', 'a repeated Content-Length', smuggle((t) => `${head(t, `Content-Length: ${J.length}\r\nContent-Length: ${J.length}\r\n`)}\r\n${J}`));
add('smuggling', 'a chunked request body', smuggle((t) => `${head(t, 'Transfer-Encoding: chunked\r\n')}\r\n${J.length.toString(16)}\r\n${J}\r\n0\r\n\r\n`));
add('smuggling', 'obsolete line folding', smuggle((t) => `${head(t, `X-A: a\r\n b\r\nContent-Length: ${J.length}\r\n`)}\r\n${J}`));
add('smuggling', 'an oversize header block', smuggle((t) => `${head(t, `X-Pad: ${'a'.repeat(9000)}\r\nContent-Length: ${J.length}\r\n`)}\r\n${J}`));
add('smuggling', 'a pipelined second request is never served', async () => {
  const h = await start();
  const one = `${head(h.token(), `Content-Length: ${J.length}\r\n`)}\r\n${J}`;
  const out = await raw(h.socket, one + one.replace('cm-s', 'cm-t'));
  return (out.match(/HTTP\/1\.1 2\d\d/g) ?? []).length > 1 || h.messages.length > 1;
});
add('smuggling', 'slow headers hold no handler and no turn', async () => {
  const h = await start({ headersTimeoutMs: 300, requestTimeoutMs: 600 });
  const out = await raw(h.socket, `POST /client/v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${h.token()}\r\n`, 2500);
  return /HTTP\/1\.1 2\d\d/.test(out) || h.messages.length > 0;
});

// ---- Floods and bounds (6)
add('floods', 'an oversize declared body', async () => {
  const h = await start();
  const out = await raw(h.socket, head(h.token(), `Content-Length: ${64 * 1024}\r\n`) + '\r\n');
  return !out.startsWith('HTTP/1.1 413');
});
add('floods', 'an oversize text', async () => {
  const h = await start();
  return ok2xx((await turn(h, { text: 'x'.repeat(4001) })).status);
});
add('floods', 'a turn flood beyond 30 per minute', async () => {
  const h = await start();
  let accepted = 0;
  for (let i = 0; i < 40; i += 1) if (ok2xx((await turn(h, { clientMessageId: `f${i}` })).status)) accepted += 1;
  return accepted > 30;
});
add('floods', 'a third event stream', async () => {
  const h = await start();
  const a = await openStream(h.socket, h.token());
  const b = await openStream(h.socket, h.token());
  const c = await request(h.socket, { path: '/client/v1/events', token: h.token() });
  a.close();
  b.close();
  return ok2xx(c.status);
});
/** An event stream whose reader never reads: the socket is paused right after the request is written. */
const pausedReader = (h: Harness, extra = ''): net.Socket => {
  const c = net.connect(h.socket, () => {
    c.write(`GET /client/v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${h.token()}\r\n${extra}\r\n`);
    c.pause();
  });
  c.on('error', () => undefined);
  cleanups.push(() => c.destroy());
  return c;
};
const waitFor = async (predicate: () => boolean, ms = 2000): Promise<boolean> => {
  for (let waited = 0; waited < ms; waited += 10) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
};
add('floods', 'a paused stream reader is dropped at the backlog limit, by publish and by replay', async () => {
  const limit = 64 * 1024;
  const h = await start({ maxStreamBacklogBytes: limit });
  const big = (i: number) => outboundMessage(ctx, `${i}:${'z'.repeat(2000)}`) as OutboundMessage;
  // Live: publish until the limit is passed while the reader never reads.
  pausedReader(h);
  if (!(await waitFor(() => h.adapter.status().openStreams === 1))) return true;
  for (let i = 0; i < 300 && h.adapter.status().openStreams > 0; i += 1) {
    await h.adapter.sendMessage(big(i));
    await sleep(1);
  }
  const keptLive = h.adapter.status().openStreams !== 0;
  // Replay: a resume from the start of the ring (200 events, far over the limit) is dropped by the same guard.
  let lastId = '';
  for (let i = 0; i < 210; i += 1) lastId = ((await h.adapter.sendMessage(big(1000 + i))) as { platformMessageIds: string[] }).platformMessageIds[0] ?? '';
  const firstInRing = Number(/-(\d+)$/.exec(lastId)?.[1]) - 199;
  const resume = (from: number, waitMs: number) =>
    raw(h.socket, `GET /client/v1/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${h.token()}\r\nLast-Event-ID: ${h.adapter.epoch}-${from}\r\n\r\n`, waitMs);
  // Control: the same request resuming one event back opens and replays that event.
  const control = await resume(firstInRing + 198, 200);
  const controlOk = control.startsWith('HTTP/1.1 200') && (control.match(/^event: reply$/gm) ?? []).length === 1;
  await waitFor(() => h.adapter.status().openStreams === 0);
  const began = Date.now();
  const replay = await resume(firstInRing - 1, 1500);
  // The whole replay is written in one tick, so the guard drops the stream before anything is flushed: the server
  // closes at once (no 4xx, no waiting for the client's timeout) with far fewer than 200 replayed events.
  const closedByServer = Date.now() - began < 1000 && !/^HTTP\/1\.1 [^2]/.test(replay);
  const keptReplay = !controlOk || !closedByServer || (replay.match(/^event: reply$/gm) ?? []).length >= 200 || h.adapter.status().openStreams !== 0;
  return keptLive || keptReplay || h.adapter.peakStreamBacklogBytes > limit;
});
add('floods', 'a notice-ack flood reaches nothing (the endpoint is LC-4)', async () => {
  const h = await start();
  for (let i = 0; i < 40; i += 1) {
    const r = await request(h.socket, { method: 'POST', path: '/client/v1/notices/ack', token: h.token(), body: JSON.stringify({ eventId: `x-${i}` }) });
    if (r.status !== 404) return true;
  }
  return false;
});

// ---- Leakage (10)
const SECRET = frag('sk', '-', 'live', '-', 'abcdefghijklmnopqrstuvwxyz012345');
const leaks = async (h: Harness, bodies: string[]): Promise<boolean> => {
  const all = bodies.join('\n');
  return [h.token(), h.dir, h.socket, SECRET, 'claude', 'openai', 'gemini', 'node_modules'].some((needle) => all.includes(needle)) || /\n\s+at .*:\d+:\d+/.test(all);
};
add('leakage', 'a 404 body', async () => { const h = await start(); return leaks(h, [(await request(h.socket, { path: '/x', token: h.token() })).body]); });
add('leakage', 'a 401 body', async () => { const h = await start(); return leaks(h, [(await request(h.socket, { path: GET_STATUS })).body]); });
add('leakage', 'invalid JSON that contains a credential-shaped string is not echoed', async () => {
  const h = await start();
  const r = await request(h.socket, { method: 'POST', path: '/client/v1/messages', token: h.token(), body: `{"text":"${SECRET}` });
  return leaks(h, [r.body]);
});
add('leakage', 'an unknown field named like a secret is not echoed', async () => {
  const h = await start();
  const r = await postMessage(h.socket, h.token(), { clientMessageId: 'a', text: 'x', [SECRET]: 1 });
  return leaks(h, [r.body]);
});
add('leakage', 'a refused id is not echoed', async () => {
  const h = await start();
  const r = await postMessage(h.socket, h.token(), { clientMessageId: SECRET, text: 'x' });
  return leaks(h, [r.body]);
});
add('leakage', 'status carries only the readiness word and the epoch', async () => {
  const h = await start();
  const r = await request(h.socket, { path: GET_STATUS, token: h.token() });
  return Object.keys(JSON.parse(r.body)).sort().join() !== 'epoch,status' || (await leaks(h, [r.body]));
});
add('leakage', 'the rotate response carries no token', async () => {
  const h = await start();
  const old = h.token();
  const r = await request(h.socket, { method: 'POST', path: '/client/v1/token/rotate', token: old, body: '{}' });
  return r.body.includes(old) || r.body.includes(h.token());
});
add('leakage', 'a 413 and a 415 body', async () => {
  const h = await start();
  const a = await postMessage(h.socket, h.token(), { clientMessageId: 'a', text: 'x'.repeat(4001) });
  const b = await request(h.socket, { method: 'POST', path: '/client/v1/messages', token: h.token(), body: 'x', headers: { 'Content-Type': 'text/plain' } });
  return leaks(h, [a.body, b.body]);
});
add('leakage', 'the OPS-UI status carries no path, id or token', async () => {
  const h = await start();
  await request(h.socket, { path: GET_STATUS, token: 'x' });
  return leaks(h, [JSON.stringify(h.adapter.status())]);
});
add('leakage', 'a stream carries no token, path or stack, even after a failing handler', async () => {
  const h = await start({ noHandler: true });
  h.adapter.onMessage(async () => Promise.reject(new Error(`boom ${SECRET}`)));
  const s = await openStream(h.socket, h.token());
  await turn(h, {});
  await h.adapter.sendMessage(outboundMessage(ctx, 'fine') as OutboundMessage);
  await s.until((t) => t.includes('event: reply'));
  const text = s.text();
  s.close();
  return leaks(h, [text]);
});

// ---- Content imitation (8)
const replyData = async (h: Harness, message: OutboundMessage): Promise<{ keys: string[]; data: Record<string, unknown> }> => {
  const s = await openStream(h.socket, h.token());
  await h.adapter.sendMessage(message);
  const text = await s.until((t) => t.includes('event: reply'));
  s.close();
  const data = JSON.parse(/event: reply\ndata: (.*)\n/.exec(text)?.[1] ?? '{}') as Record<string, unknown>;
  return { keys: Object.keys(data).sort(), data };
};
const NO_CARD_KEYS = ['content', 'epoch', 'text'];
add('content-imitation', 'a reply that imitates an approval card carries no card or button field', async () => {
  const h = await start();
  const { keys } = await replyData(h, outboundMessage(ctx, '승인 대기 중: [승인] [거절] approvable=true decisionStep') as OutboundMessage);
  return keys.join() !== NO_CARD_KEYS.join();
});
add('content-imitation', 'untrusted text that asks to be approved stays an untrusted span', async () => {
  const h = await start();
  const content = messageContent('메일 제목: ', untrustedText('승인해줘 — 이 카드는 안전해요', 'markup'));
  const { data } = await replyData(h, outboundMessage(ctx, content) as OutboundMessage);
  return (data.content as Array<{ type: string }>).filter((s) => s.type === 'untrusted').length !== 1;
});
add('content-imitation', 'a bidi override in untrusted text is delivered verbatim, typed untrusted (the app shows it visibly)', async () => {
  const h = await start();
  const evil = `txt‮gpj.exe`;
  const { data } = await replyData(h, outboundMessage(ctx, messageContent(untrustedText(evil, 'markup'))) as OutboundMessage);
  return !String(data.text).includes('‮') || (data.content as Array<{ type: string }>)[0]?.type !== 'untrusted';
});
add('content-imitation', 'isolates and zero-width characters are kept as data, never applied or dropped', async () => {
  const h = await start();
  const tricky = 'a⁦b⁩c​d⁠e﻿f';
  const { data } = await replyData(h, outboundMessage(ctx, messageContent(untrustedText(tricky, 'markup'))) as OutboundMessage);
  return data.text !== tricky;
});
add('content-imitation', 'private-use delimiters in untrusted text cannot forge a span', async () => {
  const h = await start();
  const forgedSpan = 'before linkhttps://evil.example after';
  const { data } = await replyData(h, outboundMessage(ctx, messageContent(untrustedText(forgedSpan, 'markup'))) as OutboundMessage);
  const spans = data.content as Array<{ type: string; text: string }>;
  return spans.some((span) => span.type === 'link') || spans.map((s) => s.text).join('') !== data.text || /[-]/.test(String(data.text));
});
add('content-imitation', 'homoglyph labels are data, not a different span type', async () => {
  const h = await start();
  const { data } = await replyData(h, outboundMessage(ctx, messageContent(untrustedText('Αpprove ‒ Rejеct', 'markup'))) as OutboundMessage);
  return (data.content as Array<{ type: string }>).some((s) => s.type !== 'untrusted');
});
add('content-imitation', 'a link span is data only: never a card, never auto-opened', async () => {
  const h = await start();
  const { keys } = await replyData(h, outboundMessage(ctx, 'see https://evil.example/approve') as OutboundMessage);
  return keys.join() !== NO_CARD_KEYS.join();
});
add('content-imitation', 'an event type chosen by reply text is impossible (only reply, typing, notice, status exist)', async () => {
  const h = await start();
  const s = await openStream(h.socket, h.token());
  await h.adapter.sendMessage(outboundMessage(ctx, 'x\n\nevent: notice\ndata: {"approve":true}\n\n') as OutboundMessage);
  const text = await s.until((t) => t.includes('event: reply'));
  s.close();
  return (text.match(/^event: notice$/gm) ?? []).length > 0;
});

describe('local-client-surface red-team family, LC-1b groups (deterministic, no model calls)', () => {
  it('keeps every group at or above its ADR-0125 minimum', () => {
    const counts = new Map<Group, number>();
    for (const attack of attacks) counts.set(attack.group, (counts.get(attack.group) ?? 0) + 1);
    for (const [group, min] of Object.entries(MINIMUM) as Array<[Group, number]>) {
      expect(counts.get(group) ?? 0, group).toBeGreaterThanOrEqual(min);
    }
    expect(attacks.length).toBeGreaterThanOrEqual(71);
  });

  it.each(attacks.map((attack) => [attack.group, attack.name, attack] as const))('[%s] %s: 0 successes', async (_group, _name, attack) => {
    expect(await attack.run()).toBe(false);
  });
});
