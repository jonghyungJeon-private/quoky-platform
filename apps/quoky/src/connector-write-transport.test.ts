import { channel } from 'node:diagnostics_channel';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasConnectionStageEvidence,
  installConnectorWriteTransportDiagnostics,
  platformFetchTransportGuard,
} from './connector-write-transport';

const NOT_SENT = { status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false } as const;
const UNCERTAIN = { status: 'UNCERTAIN', reason: 'TRANSPORT' } as const;
const CONNECT_ERROR = 'undici:client:connectError';

function codeError(code: string, message = `${code} test`): Error {
  return Object.assign(new Error(message), { code });
}

/** The shape the platform fetch throws: `TypeError('fetch failed')` with the transport error as `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

const TARGET = new URL('https://slack.example.invalid/api/chat.postMessage');

/** One window for `target`, classified immediately (no request-bytes event inside it). */
function classifyConnectorWriteTransportFailure(error: unknown, target: URL = TARGET) {
  const attempt = platformFetchTransportGuard.begin(target);
  try {
    return attempt.classifyFailure(error);
  } finally {
    attempt.end();
  }
}

/** Simulates undici reporting that request headers were written to a socket for `origin`. */
function publishSendHeaders(origin: unknown, method = 'POST'): void {
  channel('undici:client:sendHeaders').publish({ request: { origin, method, path: '/api/chat.postMessage' }, headers: '' });
}

/** Simulates undici reporting `error` as a connect-stage failure (the identity the classifier matches). */
function publishConnectError(error: Error): void {
  channel(CONNECT_ERROR).publish({ error, connectParams: { host: 'example.invalid' } });
}

describe('platformFetchTransportGuard — connection-stage evidence (UNC-1)', () => {
  installConnectorWriteTransportDiagnostics();

  it('name resolution failures are NOT_SENT on their own (DNS cannot happen after the request was sent)', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      expect(classifyConnectorWriteTransportFailure(fetchFailed(codeError(code))), code).toEqual(NOT_SENT);
      expect(classifyConnectorWriteTransportFailure(codeError(code)), code).toEqual(NOT_SENT);
    }
  });

  it('a refused proxy tunnel (CONNECT answered non-200) is NOT_SENT, also wrapped in a DOMException', () => {
    for (const status of [403, 407, 502, 503]) {
      const tunnel = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { code: 'UND_ERR_ABORTED' });
      const cancelled = Object.assign(new DOMException('Request was cancelled.', 'AbortError'), { cause: tunnel });
      expect(classifyConnectorWriteTransportFailure(fetchFailed(cancelled)), String(status)).toEqual(NOT_SENT);
    }
    expect(classifyConnectorWriteTransportFailure(fetchFailed(new Error('Proxy response !== 200 when HTTP Tunneling')))).toEqual(NOT_SENT);
  });

  it('connection-looking codes WITHOUT connect-error evidence are UNCERTAIN (Codex P1: they can follow a sent request)', () => {
    for (const code of [
      'ECONNREFUSED',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ECONNRESET',
      'UND_ERR_CONNECT_TIMEOUT',
      'ERR_TLS_HANDSHAKE_TIMEOUT',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      expect(classifyConnectorWriteTransportFailure(fetchFailed(codeError(code))), code).toEqual(UNCERTAIN);
    }
  });

  it('the same codes WITH connect-error evidence (the very error object undici published) are NOT_SENT', () => {
    for (const code of ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']) {
      const error = codeError(code);
      expect(classifyConnectorWriteTransportFailure(fetchFailed(error)), code).toEqual(UNCERTAIN);
      publishConnectError(error);
      expect(classifyConnectorWriteTransportFailure(fetchFailed(error)), code).toEqual(NOT_SENT);
      // Identity, not shape: an equal-looking error that undici did not publish stays UNCERTAIN.
      expect(classifyConnectorWriteTransportFailure(fetchFailed(codeError(code))), code).toEqual(UNCERTAIN);
    }
  });

  it('anything else stays UNCERTAIN: socket closes, timeouts, aborts, unknown values', () => {
    const ambiguous: unknown[] = [
      fetchFailed(codeError('EPIPE')),
      fetchFailed(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET', name: 'SocketError' })),
      fetchFailed(codeError('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      new DOMException('This operation was aborted', 'AbortError'),
      new Error('socket hang up'),
      new Error('Proxy response (403) !== 200 when HTTP Tunneling, then more'),
      fetchFailed(undefined),
      'ENOTFOUND',
      null,
      undefined,
      { code: 42 },
    ];
    for (const error of ambiguous) expect(classifyConnectorWriteTransportFailure(error)).toEqual(UNCERTAIN);
  });

  it('follows a bounded cause chain only', () => {
    let deep: unknown = codeError('ENOTFOUND');
    for (let i = 0; i < 4; i += 1) deep = new Error(`wrap ${i}`, { cause: deep });
    expect(hasConnectionStageEvidence(deep)).toBe(true);
    deep = new Error('one more', { cause: deep });
    expect(hasConnectionStageEvidence(deep)).toBe(false);
    const cyclic: Error & { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    expect(hasConnectionStageEvidence(cyclic)).toBe(false);
  });
});

describe('platformFetchTransportGuard — invocation-wide no-send evidence (UNC-1 round 3)', () => {
  installConnectorWriteTransportDiagnostics();
  const ENOTFOUND = () => fetchFailed(codeError('ENOTFOUND'));

  it('any request-bytes event for the target origin inside the window makes even connection-stage errors UNCERTAIN', () => {
    const proxy407 = () =>
      fetchFailed(Object.assign(new DOMException('Request was cancelled.', 'AbortError'), {
        cause: Object.assign(new Error('Proxy response (407) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }),
      }));
    const refused = codeError('ECONNREFUSED');
    publishConnectError(refused);
    for (const make of [ENOTFOUND, () => fetchFailed(codeError('EAI_AGAIN')), () => fetchFailed(refused), proxy407]) {
      expect(classifyConnectorWriteTransportFailure(make())).toEqual(NOT_SENT);
      for (const name of ['undici:client:sendHeaders', 'undici:request:bodySent']) {
        const attempt = platformFetchTransportGuard.begin(TARGET);
        channel(name).publish({ request: { origin: TARGET.origin, method: 'POST', path: TARGET.pathname } });
        expect(attempt.classifyFailure(make()), name).toEqual(UNCERTAIN);
        attempt.end();
      }
    }
  });

  it('a proxy CONNECT (the proxy origin) and other origins do not poison; an unreadable origin poisons every window', () => {
    const attempt = platformFetchTransportGuard.begin(TARGET);
    publishSendHeaders('http://unc1-proxy:3128', 'CONNECT');
    publishSendHeaders('https://other.example.invalid');
    expect(attempt.classifyFailure(ENOTFOUND())).toEqual(NOT_SENT);
    publishSendHeaders(undefined);
    expect(attempt.classifyFailure(ENOTFOUND())).toEqual(UNCERTAIN);
    attempt.end();
    const malformed = platformFetchTransportGuard.begin(TARGET);
    publishSendHeaders('not a url');
    expect(malformed.classifyFailure(ENOTFOUND())).toEqual(UNCERTAIN);
    malformed.end();
  });

  it('concurrent windows on the same origin poison each other (fail safe); another origin and closed windows do not', () => {
    const first = platformFetchTransportGuard.begin(TARGET);
    const second = platformFetchTransportGuard.begin(new URL('/api/other', TARGET));
    const elsewhere = platformFetchTransportGuard.begin(new URL('https://jira.example.invalid/rest/api/3/issue/P-1/comment'));
    publishSendHeaders(TARGET.origin);
    expect(first.classifyFailure(ENOTFOUND())).toEqual(UNCERTAIN);
    expect(second.classifyFailure(ENOTFOUND())).toEqual(UNCERTAIN);
    expect(elsewhere.classifyFailure(ENOTFOUND())).toEqual(NOT_SENT);
    for (const attempt of [first, second, elsewhere]) attempt.end();
    // After the windows ended, a new window starts clean.
    publishSendHeaders(TARGET.origin);
    expect(classifyConnectorWriteTransportFailure(ENOTFOUND())).toEqual(NOT_SENT);
  });
});

describe('platformFetchTransportGuard with the real platform fetch (localhost only)', () => {
  installConnectorWriteTransportDiagnostics();
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  const listen = (server: net.Server): Promise<number> =>
    new Promise((resolve) => {
      servers.push(server);
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });
  /** One write exactly as a writer does it: open the window, POST, classify a thrown request inside the window. */
  const writeThrough = async (url: string, body = '{"unc1":true}'): Promise<{ error: unknown; outcome: unknown }> => {
    const attempt = platformFetchTransportGuard.begin(new URL(url));
    try {
      await fetch(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(5000) });
    } catch (error) {
      return { error, outcome: attempt.classifyFailure(error) };
    } finally {
      attempt.end();
    }
    throw new Error('expected the request to fail');
  };
  const outcomeOf = async (url: string, body?: string): Promise<unknown> => (await writeThrough(url, body)).outcome;

  it('a refused connection is NOT_SENT (undici reports it as a connect error)', async () => {
    const port = await listen(net.createServer());
    await new Promise((resolve) => servers.pop()?.close(resolve));
    expect(await outcomeOf(`https://127.0.0.1:${port}/`)).toEqual(NOT_SENT);
  });

  it('a reset during the TLS handshake and a non-TLS reply breaking the handshake are NOT_SENT', async () => {
    const reset = await listen(net.createServer((socket) => socket.resetAndDestroy()));
    expect(await outcomeOf(`https://127.0.0.1:${reset}/`)).toEqual(NOT_SENT);
    const garbage = await listen(
      net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.end('HTTP/1.1 200 OK\r\n\r\n');
      }),
    );
    expect(await outcomeOf(`https://127.0.0.1:${garbage}/`)).toEqual(NOT_SENT);
  });

  it('a close after the request was written is UNCERTAIN', async () => {
    const port = await listen(
      net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.once('data', () => socket.destroy());
      }),
    );
    expect(await outcomeOf(`http://127.0.0.1:${port}/`)).toEqual(UNCERTAIN);
  });

  it('Codex repro: `read EHOSTUNREACH` on an established connection after 250+ request bytes is UNCERTAIN', async () => {
    const connectErrors: unknown[] = [];
    const clientSockets: net.Socket[] = [];
    const onConnectError = (message: unknown): void => {
      connectErrors.push(message);
    };
    const onConnected = (message: unknown): void => {
      const socket = (message as { socket?: net.Socket }).socket;
      if (socket) clientSockets.push(socket);
    };
    channel(CONNECT_ERROR).subscribe(onConnectError);
    channel('undici:client:connected').subscribe(onConnected);
    try {
      let received = 0;
      const port = await listen(
        net.createServer((socket) => {
          socket.on('error', () => undefined);
          socket.on('data', (chunk) => {
            received += chunk.length;
            if (received < 250) return;
            // The request bytes reached the server; the CLIENT's established socket now fails with an
            // unreachable-host read error (as a route loss would surface).
            const client = clientSockets.at(-1);
            client?.destroy(Object.assign(new Error('read EHOSTUNREACH'), { code: 'EHOSTUNREACH', errno: -113, syscall: 'read' }));
          });
        }),
      );
      const { error, outcome } = await writeThrough(`http://127.0.0.1:${port}/api/chat.postMessage`, JSON.stringify({ text: 'x'.repeat(300) }));
      expect(received).toBeGreaterThanOrEqual(250);
      expect((error as { cause?: { code?: string } }).cause?.code).toBe('EHOSTUNREACH');
      expect(connectErrors).toHaveLength(0);
      expect(hasConnectionStageEvidence(error)).toBe(false);
      expect(outcome).toEqual(UNCERTAIN);
    } finally {
      channel(CONNECT_ERROR).unsubscribe(onConnectError);
      channel('undici:client:connected').unsubscribe(onConnected);
    }
  });

  it('Codex repro (round 3): 421 on the first connection after the full POST, retry connect refused → UNCERTAIN', async () => {
    let received = 0;
    let server: net.Server | undefined;
    const port = await listen(
      (server = net.createServer((socket) => {
        socket.on('error', () => undefined);
        let buffered = '';
        socket.on('data', (chunk) => {
          received += chunk.length;
          buffered += chunk.toString('latin1');
          if (!buffered.includes('\r\n\r\n') || !buffered.endsWith('}')) return;
          // The whole request (headers + body) arrived. Stop listening so fetch's automatic re-dispatch of the POST
          // (HTTP 421 Misdirected Request) fails to connect, then answer 421.
          server?.close();
          socket.end('HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        });
      })),
    );
    const { error, outcome } = await writeThrough(`http://127.0.0.1:${port}/api/chat.postMessage`, JSON.stringify({ text: 'x'.repeat(120) }));
    expect(received).toBeGreaterThanOrEqual(250);
    // The FINAL error alone looks connection-stage (the retry's refused connect, published by undici)...
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('ECONNREFUSED');
    expect(hasConnectionStageEvidence(error)).toBe(true);
    // ...but request bytes were observed on the first connection during this write: UNCERTAIN.
    expect(outcome).toEqual(UNCERTAIN);
  });
});
