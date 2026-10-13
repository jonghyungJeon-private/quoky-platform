import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, buildConnector, getGlobalDispatcher, request as undiciRequest } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '@quoky/core';
import { hasConnectionStageEvidence } from '../connector-write-transport';
import { currentCorrelation, runWithCorrelation } from '../correlation-context';
import { redactSecrets } from '../error-diagnostics';
import { EgressBudgets } from './egress-budget';
import {
  EGRESS_REFUSED_CODE,
  EgressGuard,
  EgressRefusedError,
  GuardedDispatcher,
  answerLookup,
  installEgressGuard,
} from './egress-guard';
import type { BaseConnectorFactory, GuardMode, ResolvedAddress, Resolver } from './egress-guard';
import type { EgressInventory } from './egress-policy';
import { TrafficLedger } from './traffic-ledger';
import type { LedgerRecord, LedgerSink } from './traffic-ledger';

// ---------------------------------------------------------------------------------------------------------------------
// Harness: a local HTTP server, a stub resolver, a recording ledger and logger. No real DNS, no external network.
// ---------------------------------------------------------------------------------------------------------------------

interface Hit {
  readonly host: string | undefined;
  readonly url: string | undefined;
  readonly method: string | undefined;
  readonly body: string;
}

let server: Server;
let port = 0;
let hits: Hit[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end('ok');

beforeEach(async () => {
  hits = [];
  respond = (_req, res) => res.end('ok');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      hits.push({ host: req.headers.host, url: req.url, method: req.method, body });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class MemoryLedger implements LedgerSink {
  readonly records: LedgerRecord[] = [];
  append(record: LedgerRecord): void {
    this.records.push(record);
  }
  of<K extends LedgerRecord['kind']>(kind: K): Array<Extract<LedgerRecord, { kind: K }>> {
    return this.records.filter((record): record is Extract<LedgerRecord, { kind: K }> => record.kind === kind);
  }
}

function recordingLogger(): Logger & { lines: Array<{ message: string; fields?: LogFields }> } {
  const lines: Array<{ message: string; fields?: LogFields }> = [];
  const push = (message: string, fields?: LogFields): void => {
    lines.push({ message, ...(fields ? { fields } : {}) });
  };
  return { lines, info: push, warn: push, error: push };
}

function inventory(hosts: Record<string, string> = {}, withLocal = true): EgressInventory {
  return {
    hosts: new Map(Object.entries(hosts)),
    localEndpoints: withLocal ? [{ host: '127.0.0.1', port, label: 'ollama-local' }] : [],
  };
}

/** A resolver that answers from a table, one answer per call (to simulate rebinding), and counts calls. */
function stubResolver(answers: Record<string, ReadonlyArray<readonly ResolvedAddress[]>>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = (async (hostname: string) => {
    calls.push(hostname);
    const queue = answers[hostname];
    if (queue === undefined || queue.length === 0) {
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    }
    const index = Math.min(calls.filter((name) => name === hostname).length - 1, queue.length - 1);
    return queue[index] ?? [];
  }) as Resolver & { calls: string[] };
  resolver.calls = calls;
  return resolver;
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

interface SeenConnect {
  readonly hostname: string;
  readonly servername: string | null | undefined;
  /** What the guard's pinned lookup answered for this connection (or the error it gave). */
  readonly addresses: unknown;
}

/**
 * The base connector the guard delegates to. It records the name and servername it was given and what the guard's
 * pinned lookup answers for that name, then (test only) reaches the local server: a public test address cannot be
 * dialled offline.
 */
function remappingConnector(): { factory: BaseConnectorFactory; seen: SeenConnect[] } {
  const real = buildConnector({});
  const seen: SeenConnect[] = [];
  const factory: BaseConnectorFactory = (lookup) => (options, callback) => {
    lookup(options.hostname, { all: true }, (error: Error | null, addresses: unknown) => {
      seen.push({ hostname: options.hostname, servername: options.servername, addresses: error ?? addresses });
      real({ ...options, hostname: '127.0.0.1' }, callback);
    });
  };
  return { factory, seen };
}

interface Harness {
  readonly guard: EgressGuard;
  readonly dispatcher: GuardedDispatcher;
  readonly ledger: MemoryLedger;
  readonly logger: ReturnType<typeof recordingLogger>;
  readonly connector: { readonly seen: SeenConnect[] };
  readonly resolver: ReturnType<typeof stubResolver>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const open: GuardedDispatcher[] = [];
afterEach(async () => {
  for (const dispatcher of open.splice(0)) await dispatcher.close();
});

function harness(
  mode: GuardMode,
  options: {
    hosts?: Record<string, string>;
    answers?: Record<string, ReadonlyArray<readonly ResolvedAddress[]>>;
    budgets?: EgressBudgets;
  } = {},
): Harness {
  const ledger = new MemoryLedger();
  const logger = recordingLogger();
  const connector = remappingConnector();
  const resolver = stubResolver(options.answers ?? {});
  const guard = new EgressGuard({
    mode,
    inventory: inventory(options.hosts),
    logger,
    ledger,
    resolve: resolver,
    baseConnector: connector.factory,
    ...(options.budgets !== undefined ? { budgets: options.budgets } : {}),
  });
  const dispatcher = new GuardedDispatcher(guard);
  open.push(dispatcher);
  return {
    guard,
    dispatcher,
    ledger,
    logger,
    connector,
    resolver,
    // Node's fetch accepts undici's `dispatcher` option; the global dispatcher is left alone here.
    fetch: (url, init = {}) => fetch(url, { ...init, dispatcher } as RequestInit),
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<EgressRefusedError> {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      if (current instanceof EgressRefusedError) return current;
      current = (current as { cause?: unknown }).cause;
    }
    throw new Error(`not an egress refusal: ${String(error)}`);
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------------------------------------------------
// Connection-bound address check, pinning and rebinding (unit level, stubbed resolver and connector)
// ---------------------------------------------------------------------------------------------------------------------

function connectOnce(guard: EgressGuard, hostname: string, protocol = 'https:', portText = '443'): Promise<Error | null> {
  return new Promise((resolve) => {
    guard.connect({ hostname, host: hostname, protocol, port: portText }, (error) => resolve(error));
  });
}

function unitGuard(
  mode: GuardMode,
  answers: Record<string, ReadonlyArray<readonly ResolvedAddress[]>>,
  options: { throwSync?: boolean; resolve?: Resolver; dnsTimeoutMs?: number } = {},
) {
  const ledger = new MemoryLedger();
  const seen: SeenConnect[] = [];
  const resolver = stubResolver(answers);
  const guard = new EgressGuard({
    mode,
    inventory: inventory({ 'api.example.test': 'jira' }),
    logger: recordingLogger(),
    ledger,
    resolve: options.resolve ?? resolver,
    ...(options.dnsTimeoutMs !== undefined ? { dnsTimeoutMs: options.dnsTimeoutMs } : {}),
    baseConnector: (lookup) => (connectOptions, callback) => {
      if (options.throwSync === true) throw new Error('tls.connect threw synchronously');
      lookup(connectOptions.hostname, { all: true }, (error: Error | null, addresses: unknown) => {
        seen.push({ hostname: connectOptions.hostname, servername: connectOptions.servername, addresses: error ?? addresses });
        const first = Array.isArray(addresses) ? (addresses[0] as ResolvedAddress | undefined) : undefined;
        if (error !== null) callback(error, null);
        else callback(null, { remoteAddress: first?.address } as never);
      });
    },
  });
  return { guard, ledger, seen, resolver };
}

describe('connection-bound deny-range check (T13)', () => {
  it.each([
    ['RFC 1918', [v4('10.1.2.3')], 'private'],
    ['cloud metadata', [v4('169.254.169.254')], 'metadata'],
    ['CGNAT (Tailscale)', [v4('100.100.1.1')], 'cgnat'],
    ['ULA', [v6('fd7a:115c:a1e0::1')], 'ula'],
    ['IPv6 link-local', [v6('fe80::1')], 'link-local'],
    ['IPv4-mapped private', [v6('::ffff:10.0.0.1')], 'private'],
    ['IPv4-mapped metadata (hex)', [v6('::ffff:a9fe:a9fe')], 'metadata'],
    ['loopback name', [v4('127.0.0.1')], 'loopback'],
    ['one bad address among good ones', [v4('93.184.216.34'), v4('192.168.0.9')], 'private'],
  ])('enforce refuses an allowlisted name resolving to %s, before connecting', async (_name, addresses, category) => {
    const { guard, ledger, seen } = unitGuard('enforce', { 'api.example.test': [addresses] });
    const error = await connectOnce(guard, 'api.example.test');
    expect(error).toBeInstanceOf(EgressRefusedError);
    expect(error).toMatchObject({ code: EGRESS_REFUSED_CODE, reason: 'denied-range', detail: category });
    expect(seen).toEqual([]);
    expect(ledger.of('connect')).toMatchObject([{ host: 'api.example.test', ip: null, outcome: 'refused' }]);
    expect(ledger.of('guard')).toMatchObject([{ event: 'denied-range', detail: category, action: 'blocked', mode: 'enforce' }]);
  });

  it('observe is behaviour-neutral: it logs the denied range and hands every resolved address, in order, to the socket', async () => {
    const { guard, ledger, seen } = unitGuard('observe', { 'api.example.test': [[v4('10.0.0.1'), v4('93.184.216.34')]] });
    expect(await connectOnce(guard, 'api.example.test')).toBeNull();
    expect(seen).toEqual([
      { hostname: 'api.example.test', servername: undefined, addresses: [v4('10.0.0.1'), v4('93.184.216.34')] },
    ]);
    expect(ledger.of('guard')).toMatchObject([{ event: 'denied-range', detail: 'private', action: 'observed' }]);
    expect(ledger.of('connect')).toMatchObject([{ ip: '10.0.0.1', outcome: 'pinned' }]);
  });

  it('pins to the checked list with the name kept for SNI, and a rebinding answer can never reach the socket', async () => {
    const { guard, seen, resolver } = unitGuard('enforce', {
      'api.example.test': [[v6('2606:4700::1'), v4('93.184.216.34')], [v4('10.0.0.7')]],
    });
    expect(await connectOnce(guard, 'api.example.test')).toBeNull();
    // The socket keeps the NAME (SNI, certificate, Host) but its lookup answers only the checked list: every address,
    // in resolver order, so multi-address fallback and Happy Eyeballs still work.
    expect(seen).toEqual([
      { hostname: 'api.example.test', servername: undefined, addresses: [v6('2606:4700::1'), v4('93.184.216.34')] },
    ]);
    expect(resolver.calls).toEqual(['api.example.test']);
    // Once the connect is done the list is released: the pinned lookup never resolves on its own.
    const late = await new Promise<unknown>((resolve) => guard.pinnedLookup('api.example.test', {}, (error) => resolve(error)));
    expect(late).toMatchObject({ code: 'ENOTFOUND' });
    expect(resolver.calls).toEqual(['api.example.test']);
    // The next connection re-resolves; the rebound private answer is refused, nothing is dialled.
    const second = await connectOnce(guard, 'api.example.test');
    expect(second).toMatchObject({ reason: 'denied-range', detail: 'private' });
    expect(seen).toHaveLength(1);
    expect(resolver.calls).toEqual(['api.example.test', 'api.example.test']);
  });

  it('an IP literal is checked without any resolution; only the exact 127.0.0.1 local endpoint passes the loopback rule', async () => {
    const { guard, seen, resolver } = unitGuard('enforce', {});
    expect(await connectOnce(guard, '127.0.0.1', 'http:', String(port))).toBeNull();
    expect(seen).toMatchObject([{ hostname: '127.0.0.1', addresses: [v4('127.0.0.1')] }]);
    expect(await connectOnce(guard, '127.0.0.1', 'http:', '8080')).toMatchObject({ reason: 'denied-range', detail: 'loopback' });
    expect(await connectOnce(guard, '[::ffff:127.0.0.1]', 'http:', String(port))).toMatchObject({ detail: 'loopback' });
    expect(resolver.calls).toEqual([]);
  });

  it('a resolution failure passes through with its code (the write transport still sees ENOTFOUND)', async () => {
    const { guard } = unitGuard('enforce', {});
    expect(await connectOnce(guard, 'missing.example.test')).toMatchObject({ code: 'ENOTFOUND' });
  });

  it('a resolver that never answers fails after the DNS bound with EAI_AGAIN', async () => {
    const { guard } = unitGuard('observe', {}, { resolve: () => new Promise(() => undefined), dnsTimeoutMs: 20 });
    const error = await connectOnce(guard, 'api.example.test');
    expect(error).toMatchObject({ code: 'EAI_AGAIN', message: 'name resolution timed out' });
    expect(hasConnectionStageEvidence(error)).toBe(true);
  });

  it('a synchronous throw of the base connector reaches the callback once, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { guard } = unitGuard('observe', { 'api.example.test': [[v4('93.184.216.34')]] }, { throwSync: true });
      let calls = 0;
      const error = await new Promise<Error | null>((resolve) => {
        guard.connect({ hostname: 'api.example.test', host: 'api.example.test', protocol: 'https:', port: '443' }, (e) => {
          calls += 1;
          resolve(e);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(error).toMatchObject({ message: 'tls.connect threw synchronously' });
      expect(calls).toBe(1);
      expect(unhandled).toEqual([]);
      // The held list is released after the failure.
      const late = await new Promise<unknown>((resolve) => guard.pinnedLookup('api.example.test', {}, (e) => resolve(e)));
      expect(late).toMatchObject({ code: 'ENOTFOUND' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Real requests through Node's fetch and the guarded dispatcher
// ---------------------------------------------------------------------------------------------------------------------

describe('guarded dispatcher: observe versus enforce', () => {
  it('observe: an allowlisted name is resolved by the guard, pinned to the checked IP, Host kept; the ledger records it', async () => {
    const h = harness('observe', { hosts: { 'svc.example.test': 'jira' }, answers: { 'svc.example.test': [[v4('93.184.216.34')]] } });
    const response = await runWithCorrelation('owner-turn', () =>
      h.fetch(`http://svc.example.test:${port}/rest/api/3/issue/PROJ-7?fields=summary`, { method: 'POST', body: 'hello' }),
      'abcdef0123456789',
    );
    expect(await response.text()).toBe('ok');
    expect(hits).toEqual([{ host: `svc.example.test:${port}`, url: '/rest/api/3/issue/PROJ-7?fields=summary', method: 'POST', body: 'hello' }]);
    expect(h.connector.seen).toMatchObject([{ hostname: 'svc.example.test', addresses: [v4('93.184.216.34')] }]);
    const [request] = h.ledger.of('request');
    expect(request).toMatchObject({
      v: 1,
      cid: 'abcdef0123456789',
      initiator: 'owner-turn',
      host: 'svc.example.test',
      label: 'jira',
      method: 'POST',
      path: '/rest/api/3/issue/{id}',
      status: 200,
      statusClass: '2xx',
      bytesUp: 5,
      bytesDown: 2,
      outcome: 'ok',
      mode: 'observe',
    });
    expect(request?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    // The connect record carries the socket's real remote address (the test connector reaches the local server).
    expect(h.ledger.of('connect')).toMatchObject([{ host: 'svc.example.test', ip: '127.0.0.1', port, outcome: 'pinned' }]);
    // Plain http to a name is a finding, observed only.
    expect(h.ledger.of('guard')).toMatchObject([{ event: 'insecure-scheme', action: 'observed' }]);
  });

  it('observe: a new destination is logged (content-free) and not blocked', async () => {
    const h = harness('observe', { answers: { 'new.example.test': [[v4('93.184.216.34')]] } });
    const response = await h.fetch(`http://new.example.test:${port}/x`);
    expect(response.status).toBe(200);
    expect(hits).toHaveLength(1);
    const events = h.ledger.of('guard').map((record) => record.event);
    expect(events).toContain('new-destination');
    expect(h.ledger.of('request')).toMatchObject([{ host: 'new.example.test', label: 'unlisted', outcome: 'ok' }]);
    const warn = h.logger.lines.find((line) => line.fields?.event === 'new-destination');
    expect(warn).toEqual({
      message: 'egress.guard',
      fields: { event: 'new-destination', host: 'new.example.test', label: 'unlisted', detail: 'new-destination', mode: 'observe', action: 'observed' },
    });
  });

  it('enforce: a new destination is refused before any resolution or byte, with a deterministic error', async () => {
    const h = harness('enforce');
    const refusal = await refusalOf(h.fetch('https://new.example.test/x?token=abc'));
    expect(refusal.message).toBe('egress refused: new-destination');
    expect(refusal.code).toBe(EGRESS_REFUSED_CODE);
    expect(h.resolver.calls).toEqual([]);
    expect(hits).toEqual([]);
    // The query (and its value) is never recorded.
    expect(h.ledger.of('request')).toMatchObject([{ host: 'new.example.test', path: '/{id}', outcome: 'refused', status: null, bytesUp: 0 }]);
    expect(h.ledger.of('guard')).toMatchObject([{ event: 'new-destination', action: 'blocked', mode: 'enforce' }]);
  });

  it('enforce: an IP literal and plain http are refused; the exact local endpoint is allowed', async () => {
    const h = harness('enforce');
    const refusal = await refusalOf(h.fetch(`http://127.0.0.2:${port}/`));
    expect(['insecure-scheme', 'ip-literal']).toContain(refusal.reason);
    const local = await h.fetch(`http://127.0.0.1:${port}/api/tags`);
    expect(local.status).toBe(200);
    expect(h.ledger.of('request').at(-1)).toMatchObject({ host: '127.0.0.1', label: 'ollama-local', outcome: 'ok' });
    expect(h.connector.seen).toMatchObject([{ hostname: '127.0.0.1' }]);
  });

  it('every redirect hop is re-checked: enforce refuses a hop to an unlisted host, observe follows and logs it', async () => {
    respond = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://elsewhere.example.test:${port}/landing` });
        res.end();
      } else res.end('landed');
    };
    const enforce = harness('enforce');
    await refusalOf(enforce.fetch(`http://127.0.0.1:${port}/start`));
    expect(hits.map((hit) => hit.url)).toEqual(['/start']);
    expect(enforce.ledger.of('guard')).toContainEqual(
      expect.objectContaining({ host: 'elsewhere.example.test', event: 'new-destination', action: 'blocked' }),
    );

    const observe = harness('observe', { answers: { 'elsewhere.example.test': [[v4('93.184.216.34')]] } });
    expect(await (await observe.fetch(`http://127.0.0.1:${port}/start`)).text()).toBe('landed');
    expect(observe.ledger.of('request').map((record) => record.host)).toEqual(['127.0.0.1', 'elsewhere.example.test']);
  });

  it('a refusal reaches the connector-write transport as no-send evidence', async () => {
    const h = harness('enforce');
    let caught: unknown;
    try {
      await h.fetch('https://new.example.test/write', { method: 'POST', body: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(hasConnectionStageEvidence(caught)).toBe(true);
  });
});

describe('budgets and backoff through the dispatcher (design §5.3)', () => {
  it('enforce rejects the request over the per-minute cap with a deterministic error; observe only logs it', async () => {
    const table = { 'ollama-local': { perMinute: 2 } };
    const enforce = harness('enforce', { budgets: new EgressBudgets(() => Date.now(), table) });
    await enforce.fetch(`http://127.0.0.1:${port}/a`);
    await enforce.fetch(`http://127.0.0.1:${port}/b`);
    const refusal = await refusalOf(enforce.fetch(`http://127.0.0.1:${port}/c`));
    expect(refusal.message).toBe('egress refused: budget-exceeded (rate-minute)');
    expect(hits).toHaveLength(2);

    const observe = harness('observe', { budgets: new EgressBudgets(() => Date.now(), table) });
    for (const name of ['a', 'b', 'c']) expect((await observe.fetch(`http://127.0.0.1:${port}/${name}`)).status).toBe(200);
    expect(observe.ledger.of('guard')).toMatchObject([{ event: 'budget-exceeded', detail: 'rate-minute', action: 'observed' }]);
  });

  it('three 429 answers open the backoff; enforce then refuses without contacting the server', async () => {
    respond = (_req, res) => {
      res.writeHead(429, { 'retry-after': '30' });
      res.end('slow down');
    };
    const table = { 'ollama-local': { breaker: true } };
    const h = harness('enforce', { budgets: new EgressBudgets(() => Date.now(), table) });
    for (let i = 0; i < 3; i += 1) expect((await h.fetch(`http://127.0.0.1:${port}/`)).status).toBe(429);
    const refusal = await refusalOf(h.fetch(`http://127.0.0.1:${port}/`));
    expect(refusal.reason).toBe('backoff');
    expect(hits).toHaveLength(3);
    expect(h.ledger.of('guard').map((record) => [record.event, record.detail])).toEqual([
      ['backoff-open', 'open-300s'],
      ['backoff-open', 'backoff'],
    ]);
  });
});

describe('pinned lookup answers (family and all honoured, order kept)', () => {
  const mixed = [v6('2606:4700::1'), v4('93.184.216.34'), v6('2606:4700::2'), v4('93.184.216.35')];
  const answer = (options: unknown): Promise<unknown[]> =>
    new Promise((resolve) => answerLookup(mixed, options, (...args: unknown[]) => resolve(args)));

  it.each([
    [{ family: 4 }, [null, '93.184.216.34', 4]],
    [{ family: 6 }, [null, '2606:4700::1', 6]],
    [{ family: 0 }, [null, '2606:4700::1', 6]],
    [{ family: 'IPv4' }, [null, '93.184.216.34', 4]],
    [4, [null, '93.184.216.34', 4]],
    [{ family: 4, all: true }, [null, [v4('93.184.216.34'), v4('93.184.216.35')]]],
    [{ family: 0, all: true }, [null, mixed]],
    [{ all: true }, [null, mixed]],
  ])('%j → %j', async (options, expected) => {
    expect(await answer(options)).toEqual(expected);
  });

  it('a family with no checked address is ENOTFOUND (the socket falls back only within the checked list)', async () => {
    const [error] = await new Promise<unknown[]>((resolve) =>
      answerLookup([v6('2606:4700::1')], { family: 4 }, (...args: unknown[]) => resolve(args)),
    );
    expect(error).toMatchObject({ code: 'ENOTFOUND' });
  });

  it('the http/https agent lookup returns the checked list for the requested family', async () => {
    const { guard } = unitGuard('enforce', { 'api.example.test': [[v6('2606:4700::1'), v4('93.184.216.34')]] });
    const v4Only = await new Promise<unknown[]>((resolve) =>
      guard.lookup('api.example.test', { family: 4 }, (...args: unknown[]) => resolve(args)),
    );
    expect(v4Only).toEqual([null, '93.184.216.34', 4]);
    const everything = await new Promise<unknown[]>((resolve) =>
      guard.lookup('api.example.test', { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(everything).toEqual([null, [v6('2606:4700::1'), v4('93.184.216.34')]]);
  });
});

describe('dispatcher hardening', () => {
  it('strips maxRedirections: a redirect is never followed inside the dispatcher', async () => {
    respond = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://elsewhere.example.test:${port}/landing` });
        res.end();
      } else res.end('landed');
    };
    const h = harness('enforce');
    const answer = await undiciRequest(`http://127.0.0.1:${port}/start`, { dispatcher: h.dispatcher, maxRedirections: 3 });
    await answer.body.text();
    expect(answer.statusCode).toBe(302);
    expect(hits.map((hit) => hit.url)).toEqual(['/start']);
    expect(h.resolver.calls).toEqual([]);
  });

  it('enforce: an owner turn flooding Jira hits the 3x cap; an owner turn on Telegram is never refused', () => {
    const guard = new EgressGuard({
      mode: 'enforce',
      inventory: { hosts: new Map([['acme.atlassian.net', 'jira'], ['api.telegram.org', 'telegram']]), localEndpoints: [] },
      logger: recordingLogger(),
      ledger: new MemoryLedger(),
    });
    const jira = new URL('https://acme.atlassian.net/rest/api/3/search/jql');
    const telegram = new URL('https://api.telegram.org/bot1/sendMessage');
    runWithCorrelation('owner-turn', () => {
      for (let i = 0; i < 60; i += 1) {
        expect(guard.admitRequest(jira, jira.pathname, currentCorrelation()).refusal).toBeUndefined();
      }
      const refused = guard.admitRequest(jira, jira.pathname, currentCorrelation()).refusal;
      expect(refused).toMatchObject({ reason: 'budget-exceeded', detail: 'rate-minute' });
      expect(refused?.message).toBe('egress refused: budget-exceeded (rate-minute)');
      for (let i = 0; i < 300; i += 1) {
        expect(guard.admitRequest(telegram, telegram.pathname, currentCorrelation()).refusal).toBeUndefined();
      }
    });
  });

  it('a request enforce refuses by name is not counted in the budget windows', async () => {
    const budgets = new EgressBudgets(() => Date.now());
    const h = harness('enforce', { budgets });
    for (let i = 0; i < 30; i += 1) await refusalOf(h.fetch('https://unlisted.example.test/'));
    expect(budgets.admit('unlisted', 'background').verdict.ok).toBe(true);
  });
});

describe('ledger redaction: no token-shaped string ever reaches the file', () => {
  it('a token in the path, the query, a header and the body leaves no trace in the ledger file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'quoky-egress-'));
    try {
      // Every secret is assembled from fragments: the source holds no token-shaped literal.
      const botToken = ['8123', '45678'].join('') + ':' + ['AAH', 'x9_k', 'Lm2-'].join('').repeat(4);
      const githubToken = ['gh', 'p_'].join('') + ['Zq8', 'Rt3'].join('').repeat(6);
      const openAiKey = ['s', 'k-'].join('') + ['proj', 'Ab12'].join('_').repeat(4);
      const googleKey = ['AI', 'za'].join('') + 'Sy'.repeat(18) + 'z';
      const ledgerFile = new TrafficLedger({ dir: path.join(dir, 'audit') });
      const ledger = new MemoryLedger();
      const sink: LedgerSink = { append: (record) => (ledger.append(record), ledgerFile.append(record)) };
      const guard = new EgressGuard({ mode: 'observe', inventory: inventory(), logger: recordingLogger(), ledger: sink });
      const dispatcher = new GuardedDispatcher(guard);
      open.push(dispatcher);
      await fetch(`http://127.0.0.1:${port}/bot${botToken}/sendMessage?key=${googleKey}&access_token=${githubToken}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${openAiKey}`, 'x-api-key': googleKey },
        body: JSON.stringify({ text: githubToken }),
        dispatcher,
      } as RequestInit);
      expect(hits[0]?.url).toContain(botToken);
      const files = readdirSync(path.join(dir, 'audit'));
      expect(files).toHaveLength(1);
      const content = readFileSync(path.join(dir, 'audit', files[0] ?? ''), 'utf8');
      for (const secret of [botToken, githubToken, openAiKey, googleKey, 'key=', 'access_token', 'authorization', 'Bearer', '?']) {
        expect(content).not.toContain(secret);
      }
      // The existing redaction patterns find nothing to redact: no token-shaped string at all.
      expect(redactSecrets(content)).toBe(content);
      expect(ledger.of('request')).toMatchObject([{ path: '/{id}/{id}', bytesUp: JSON.stringify({ text: githubToken }).length }]);
      for (const record of ledger.records) {
        expect(Object.keys(record).sort()).not.toContain('headers');
        expect(Object.keys(record).sort()).not.toContain('url');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('installEgressGuard (process-wide)', () => {
  it('routes the global fetch and the https global agent through the guard, and uninstall restores both', async () => {
    const before = getGlobalDispatcher();
    const beforeHttps = https.globalAgent;
    const beforeHttp = http.globalAgent;
    const ledger = new MemoryLedger();
    const guard = new EgressGuard({ mode: 'enforce', inventory: inventory(), logger: recordingLogger(), ledger });
    const installed = installEgressGuard(guard);
    try {
      expect(getGlobalDispatcher()).not.toBe(before);
      // The replacement agents keep the previous settings (keep-alive, socket limits, options).
      for (const [replaced, previous] of [[http.globalAgent, beforeHttp], [https.globalAgent, beforeHttps]] as const) {
        const now = replaced as unknown as Record<string, unknown>;
        const was = previous as unknown as Record<string, unknown>;
        expect(replaced).not.toBe(previous);
        expect(now.keepAlive).toBe(was.keepAlive);
        expect(now.keepAliveMsecs).toBe(was.keepAliveMsecs);
        expect(now.maxSockets).toBe(was.maxSockets);
        expect(now.maxFreeSockets).toBe(was.maxFreeSockets);
        expect(now.options).toMatchObject(was.options as object);
      }
      expect((await fetch(`http://127.0.0.1:${port}/global`)).status).toBe(200);
      await expect(fetch('https://unlisted.example.test/')).rejects.toThrow();
      const agentError = await new Promise<Error>((resolve) => {
        https.get('https://unlisted.example.test/', () => resolve(new Error('unexpected response'))).on('error', resolve);
      });
      expect(agentError).toMatchObject({ code: EGRESS_REFUSED_CODE, reason: 'new-destination' });
      const httpLocal = await new Promise<number | undefined>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/agent`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
      });
      expect(httpLocal).toBe(200);
      expect(ledger.of('request').map((record) => record.path)).toEqual(['/{id}', '/']);
      // A library that brings its own undici Agent bypasses the dispatcher: observed (never blocked) when off-list.
      const foreign = new Agent();
      try {
        // Whether `localhost` answers on this host does not matter: the request is noticed when it is created.
        await undiciRequest(`http://localhost:${port}/foreign`, { dispatcher: foreign })
          .then((answer) => answer.body.text())
          .catch(() => undefined);
      } finally {
        await foreign.close();
      }
      expect(ledger.of('guard')).toContainEqual(
        expect.objectContaining({ event: 'unguarded-request', host: 'localhost', detail: 'foreign-dispatcher', action: 'observed' }),
      );
    } finally {
      await installed.uninstall();
    }
    expect(getGlobalDispatcher()).toBe(before);
    expect(https.globalAgent).toBe(beforeHttps);
  });
});
