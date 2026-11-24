import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { InboundMessage, Logger } from '@quoky/core';

import { LocalClientPlatformAdapter } from './local-client-platform-adapter';
import type { LocalClientAdapterOptions } from './local-client-platform-adapter';

export const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

export function tempDataDir(): string {
  // mkdtemp creates mode 0700 (the D2 data-directory rule).
  return mkdtempSync(path.join(os.tmpdir(), 'lc-'));
}

/** A socket file whose owner process was killed: nobody listens, the file stays (a stale socket). */
export async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

export interface Harness {
  readonly dir: string;
  readonly adapter: LocalClientPlatformAdapter;
  readonly messages: InboundMessage[];
  readonly socket: string;
  token(): string;
  cleanup(): Promise<void>;
}

export const OWNER = '1000000000000001';

export async function startHarness(options: Partial<LocalClientAdapterOptions> & { dir?: string; gate?: Promise<boolean>; noHandler?: boolean } = {}): Promise<Harness> {
  const dir = options.dir ?? tempDataDir();
  const adapter = new LocalClientPlatformAdapter({
    dataDir: dir,
    instanceLockHeld: true,
    fileBackedDb: true,
    ownerUserId: OWNER,
    ownerIsDiscordOwner: true,
    verifyOwner: async () => true,
    logger: silentLogger,
    probeTimeoutMs: 300,
    ...options,
  });
  const messages: InboundMessage[] = [];
  if (options.noHandler !== true) adapter.onMessage(async (message) => void messages.push(message));
  if (options.gate !== undefined) adapter.gateInbound(options.gate);
  await adapter.start();
  const socket = path.join(dir, 'local-client.sock');
  return {
    dir,
    adapter,
    messages,
    socket,
    token: () => readFileSync(path.join(dir, 'local-client.token'), 'utf8').trim(),
    cleanup: async () => {
      await adapter.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** One HTTP request over the Unix socket with caller-controlled headers (defaults are the contract's). */
export function request(
  socketPath: string,
  input: { method?: string; path: string; headers?: Record<string, string | undefined>; body?: string | Buffer; token?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body);
    const headers: Record<string, string> = { Host: 'localhost', Connection: 'close' };
    if (input.token !== undefined) headers.Authorization = `Bearer ${input.token}`;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (value === undefined) delete headers[name];
      else headers[name] = value;
    }
    const req = http.request({ socketPath, method: input.method ?? 'GET', path: input.path, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function postMessage(socketPath: string, token: string, payload: Record<string, unknown>): Promise<Reply> {
  return request(socketPath, { method: 'POST', path: '/client/v1/messages', token, body: JSON.stringify(payload) });
}

/** Raw bytes in, everything out until the server closes (for framing and smuggling cases). */
export function raw(socketPath: string, bytes: string, waitMs = 400): Promise<string> {
  return new Promise((resolve) => {
    const client = net.connect(socketPath, () => client.write(bytes));
    let out = '';
    client.on('data', (chunk) => (out += chunk.toString('utf8')));
    client.on('close', () => resolve(out));
    client.on('error', () => resolve(out));
    setTimeout(() => {
      client.destroy();
      resolve(out);
    }, waitMs).unref();
  });
}

export interface Stream {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  text(): string;
  closed(): Promise<void>;
  until(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
}

export function openStream(socketPath: string, token: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/client/v1/events', headers: { Host: 'localhost', Authorization: `Bearer ${token}`, ...headers }, setHost: false }, (res) => {
      let text = '';
      const waiters: Array<() => void> = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        for (const waiter of waiters.splice(0)) waiter();
      });
      const closed = new Promise<void>((done) => res.on('close', () => done()));
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        closed: () => closed,
        until: (predicate, timeoutMs = 2000) =>
          new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`stream timeout; got: ${text}`)), timeoutMs);
            const check = (): void => {
              if (predicate(text)) {
                clearTimeout(timer);
                ok(text);
              } else waiters.push(check);
            };
            check();
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}
