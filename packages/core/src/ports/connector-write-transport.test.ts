import { channel } from 'node:diagnostics_channel';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyConnectorWriteTransportFailure,
  installConnectorWriteTransportDiagnostics,
  isConnectorWritePreSendFailure,
} from './connector-write-transport';

const NOT_SENT = { status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false } as const;
const UNCERTAIN = { status: 'UNCERTAIN', reason: 'TRANSPORT' } as const;

function codeError(code: string, message = `${code} test`): Error {
  return Object.assign(new Error(message), { code });
}

/** The shape the platform fetch throws: `TypeError('fetch failed')` with the transport error as `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

describe('classifyConnectorWriteTransportFailure (UNC-1: NOT_SENT only when provably never sent)', () => {
  installConnectorWriteTransportDiagnostics();

  it('connection set-up codes are NOT_SENT, wrapped by fetch or bare', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(classifyConnectorWriteTransportFailure(fetchFailed(codeError(code))), code).toEqual(NOT_SENT);
      expect(classifyConnectorWriteTransportFailure(codeError(code)), code).toEqual(NOT_SENT);
    }
  });

  it('TLS handshake failures (certificate verification, handshake timeout) are NOT_SENT', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_TLS_HANDSHAKE_TIMEOUT',
    ]) {
      expect(classifyConnectorWriteTransportFailure(fetchFailed(codeError(code))), code).toEqual(NOT_SENT);
    }
  });

  it('a refused proxy tunnel (CONNECT answered 4xx/5xx) is NOT_SENT, also when fetch wraps it in a DOMException', () => {
    for (const status of [403, 407, 502, 503]) {
      const tunnel = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { code: 'UND_ERR_ABORTED' });
      const cancelled = Object.assign(new DOMException('Request was cancelled.', 'AbortError'), { cause: tunnel });
      expect(classifyConnectorWriteTransportFailure(fetchFailed(cancelled)), String(status)).toEqual(NOT_SENT);
    }
    expect(classifyConnectorWriteTransportFailure(fetchFailed(new Error('Proxy response !== 200 when HTTP Tunneling')))).toEqual(NOT_SENT);
  });

  it('an error undici published on its connect-error channel is NOT_SENT by identity (a connect-stage ECONNRESET)', () => {
    const reset = codeError('ECONNRESET', 'read ECONNRESET');
    expect(classifyConnectorWriteTransportFailure(fetchFailed(reset))).toEqual(UNCERTAIN);
    channel('undici:client:connectError').publish({ error: reset, connectParams: { host: 'example.invalid' } });
    expect(classifyConnectorWriteTransportFailure(fetchFailed(reset))).toEqual(NOT_SENT);
    // Identity, not shape: another ECONNRESET (e.g. after the request was written) stays UNCERTAIN.
    expect(classifyConnectorWriteTransportFailure(fetchFailed(codeError('ECONNRESET', 'read ECONNRESET')))).toEqual(UNCERTAIN);
  });

  it('anything ambiguous stays UNCERTAIN: resets after connect, socket closes, timeouts, aborts, unknown values', () => {
    const ambiguous: unknown[] = [
      fetchFailed(codeError('ECONNRESET')),
      fetchFailed(codeError('EPIPE')),
      fetchFailed(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET', name: 'SocketError' })),
      fetchFailed(codeError('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      new DOMException('This operation was aborted', 'AbortError'),
      new Error('socket hang up'),
      new Error('Proxy response (403) !== 200 when HTTP Tunneling, then more'),
      fetchFailed(undefined),
      'ECONNREFUSED',
      null,
      undefined,
      { code: 42 },
    ];
    for (const error of ambiguous) expect(classifyConnectorWriteTransportFailure(error)).toEqual(UNCERTAIN);
  });

  it('follows a bounded cause chain only', () => {
    let deep: unknown = codeError('ECONNREFUSED');
    for (let i = 0; i < 4; i += 1) deep = new Error(`wrap ${i}`, { cause: deep });
    expect(isConnectorWritePreSendFailure(deep)).toBe(true);
    deep = new Error('one more', { cause: deep });
    expect(isConnectorWritePreSendFailure(deep)).toBe(false);
    const cyclic: Error & { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    expect(isConnectorWritePreSendFailure(cyclic)).toBe(false);
  });
});

describe('classifyConnectorWriteTransportFailure with the real platform fetch (localhost only)', () => {
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
  const failureOf = async (url: string): Promise<unknown> => {
    try {
      await fetch(url, { method: 'POST', body: '{"unc1":true}', signal: AbortSignal.timeout(5000) });
    } catch (error) {
      return error;
    }
    throw new Error('expected the request to fail');
  };

  it('a refused connection is NOT_SENT', async () => {
    const port = await listen(net.createServer());
    await new Promise((resolve) => servers.pop()?.close(resolve));
    expect(classifyConnectorWriteTransportFailure(await failureOf(`https://127.0.0.1:${port}/`))).toEqual(NOT_SENT);
  });

  it('a reset during the TLS handshake (connect stage) is NOT_SENT; a non-TLS reply breaking the handshake too', async () => {
    const reset = await listen(net.createServer((socket) => socket.resetAndDestroy()));
    expect(classifyConnectorWriteTransportFailure(await failureOf(`https://127.0.0.1:${reset}/`))).toEqual(NOT_SENT);
    const garbage = await listen(
      net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.end('HTTP/1.1 200 OK\r\n\r\n');
      }),
    );
    expect(classifyConnectorWriteTransportFailure(await failureOf(`https://127.0.0.1:${garbage}/`))).toEqual(NOT_SENT);
  });

  it('a close after the request was written is UNCERTAIN', async () => {
    const port = await listen(
      net.createServer((socket) => {
        socket.on('error', () => undefined);
        socket.once('data', () => socket.destroy());
      }),
    );
    expect(classifyConnectorWriteTransportFailure(await failureOf(`http://127.0.0.1:${port}/`))).toEqual(UNCERTAIN);
  });
});
