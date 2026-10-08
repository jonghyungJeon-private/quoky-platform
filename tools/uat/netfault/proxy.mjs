// UNC-1 fault-injecting HTTPS CONNECT proxy (no dependencies; Node >= 18).
//
// Listens for `CONNECT host:443` tunnels on PROXY_PORT (default 3128) and serves a small control API on
// CONTROL_PORT (default 8081). Only hosts in ALLOW_HOSTS (default `slack.com`) on port 443 are tunnelled; anything
// else gets `403`. The proxy never decrypts TLS: it only reads the plaintext TLS record headers (content type and
// length) to tell when the client has sent application data (the HTTP request) through the tunnel.
//
// Modes (set with `POST /mode?m=<mode>`, read at CONNECT time for each new tunnel):
//   pass               forward both directions untouched.
//   refuse             reset the client socket as soon as the CONNECT line arrives (nothing reaches the upstream).
//   cut-after-request  forward the client's request upstream untouched; once the client has sent at least
//                      REQUEST_BYTES of TLS application data, swallow every upstream byte and reset the CLIENT side
//                      CUT_DELAY_MS after the first swallowed upstream byte (the response). The upstream side stays
//                      open (drained) for UPSTREAM_LINGER_MS so the server finishes the request normally.
//   stall-after-request like cut-after-request but never cuts the client: the response is swallowed and the client
//                      is left waiting until it gives up (a timeout past the writer's limit).
//
// `GET /log` returns every tunnel event as JSON; `POST /reset-log` clears it. Nothing secret passes through this
// process in plaintext, and nothing payload-like is logged (only hosts, byte counts, record counts and timings).

import http from 'node:http';
import net from 'node:net';

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3128);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8081);
const ALLOW_HOSTS = new Set((process.env.ALLOW_HOSTS ?? 'slack.com').split(',').map((h) => h.trim().toLowerCase()));
const REQUEST_BYTES = Number(process.env.REQUEST_BYTES ?? 400);
const CUT_DELAY_MS = Number(process.env.CUT_DELAY_MS ?? 200);
const UPSTREAM_LINGER_MS = Number(process.env.UPSTREAM_LINGER_MS ?? 15000);
const MODES = new Set(['pass', 'refuse', 'cut-after-request', 'stall-after-request']);

let mode = process.env.INITIAL_MODE ?? 'pass';
let tunnelSeq = 0;
/** Open tunnels (id → sockets and the mode they were opened in); all are closed on every mode change. */
const openTunnels = new Map();
const events = [];
const t0 = Date.now();

function log(event) {
  const entry = { t: new Date().toISOString(), ms: Date.now() - t0, ...event };
  events.push(entry);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** Incremental TLS record header parser: counts records and bytes per content type, never reads payloads. */
function tlsRecordCounter() {
  let pending = Buffer.alloc(0);
  let skip = 0;
  const stats = { records: 0, appRecords: 0, appBytes: 0, handshakeRecords: 0, other: 0, unparsed: false };
  return {
    stats,
    feed(chunk) {
      if (stats.unparsed) return;
      let buf = chunk;
      while (buf.length > 0) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          skip -= n;
          buf = buf.subarray(n);
          continue;
        }
        pending = Buffer.concat([pending, buf]);
        buf = Buffer.alloc(0);
        if (pending.length < 5) return;
        const type = pending[0];
        const length = pending.readUInt16BE(3);
        if (type < 20 || type > 24 || pending[1] !== 3) {
          stats.unparsed = true;
          return;
        }
        stats.records += 1;
        if (type === 23) {
          stats.appRecords += 1;
          stats.appBytes += length;
        } else if (type === 22) stats.handshakeRecords += 1;
        else stats.other += 1;
        const rest = pending.subarray(5);
        pending = Buffer.alloc(0);
        skip = length;
        buf = rest;
      }
    },
  };
}

function handleTunnel(client, head) {
  const id = ++tunnelSeq;
  const tunnelMode = mode;
  const line = head.toString('latin1').split('\r\n')[0] ?? '';
  const match = /^CONNECT ([A-Za-z0-9.-]+):(\d+) HTTP\/1\.[01]$/.exec(line);
  if (!match) {
    log({ tunnel: id, event: 'bad-request' });
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const host = match[1].toLowerCase();
  const port = Number(match[2]);
  if (!ALLOW_HOSTS.has(host) || port !== 443) {
    log({ tunnel: id, event: 'denied', host, port });
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  log({ tunnel: id, event: 'connect', host, port, mode: tunnelMode });
  if (tunnelMode === 'refuse') {
    client.resetAndDestroy();
    log({ tunnel: id, event: 'refused-reset', host });
    return;
  }

  const upstream = net.connect(port, host);
  openTunnels.set(id, { client, upstream, mode: tunnelMode });
  const up = tlsRecordCounter();
  const down = tlsRecordCounter();
  let upBytes = 0;
  let downForwarded = 0;
  let downSwallowed = 0;
  let requestSeenAt = null;
  let clientCutAt = null;
  let closed = false;
  const faulty = tunnelMode === 'cut-after-request' || tunnelMode === 'stall-after-request';

  const summary = (why) => {
    openTunnels.delete(id);
    if (closed) return;
    closed = true;
    log({
      tunnel: id,
      event: 'closed',
      why,
      mode: tunnelMode,
      upBytes,
      downForwarded,
      downSwallowed,
      clientTls: up.stats,
      serverTls: down.stats,
      requestSeenMs: requestSeenAt,
      clientCutMs: clientCutAt,
    });
  };

  upstream.on('connect', () => {
    log({ tunnel: id, event: 'upstream-connected', host, remote: upstream.remoteAddress });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  upstream.on('error', (error) => {
    log({ tunnel: id, event: 'upstream-error', code: error.code ?? 'ERR' });
    if (!client.destroyed) client.destroy();
  });
  client.on('error', (error) => log({ tunnel: id, event: 'client-error', code: error.code ?? 'ERR' }));

  client.on('data', (chunk) => {
    upBytes += chunk.length;
    up.feed(chunk);
    if (faulty && requestSeenAt === null && up.stats.appBytes >= REQUEST_BYTES) {
      requestSeenAt = Date.now() - t0;
      log({ tunnel: id, event: 'request-forwarded', clientAppBytes: up.stats.appBytes, clientAppRecords: up.stats.appRecords });
    }
    if (!upstream.destroyed) upstream.write(chunk);
  });
  client.on('end', () => {
    // Half-close from the client: keep the upstream open so the server can still finish (the linger timer ends it).
    log({ tunnel: id, event: 'client-end' });
  });
  client.on('close', () => {
    log({ tunnel: id, event: 'client-close' });
    if (!faulty) {
      upstream.destroy();
      summary('client-close');
    } else {
      setTimeout(() => {
        upstream.destroy();
        summary('upstream-linger-done');
      }, UPSTREAM_LINGER_MS);
    }
  });

  upstream.on('data', (chunk) => {
    down.feed(chunk);
    if (faulty && requestSeenAt !== null) {
      if (downSwallowed === 0) log({ tunnel: id, event: 'response-swallowing', firstChunkBytes: chunk.length });
      downSwallowed += chunk.length;
      if (tunnelMode === 'cut-after-request' && clientCutAt === null) {
        clientCutAt = -1;
        setTimeout(() => {
          clientCutAt = Date.now() - t0;
          log({ tunnel: id, event: 'client-cut-reset', downSwallowed });
          client.resetAndDestroy();
        }, CUT_DELAY_MS);
      }
      return;
    }
    downForwarded += chunk.length;
    if (!client.destroyed) client.write(chunk);
  });
  upstream.on('end', () => {
    log({ tunnel: id, event: 'upstream-end' });
    if (!faulty && !client.destroyed) client.end();
  });
  upstream.on('close', () => {
    if (!faulty) {
      if (!client.destroyed) client.destroy();
      summary('upstream-close');
    }
  });
}

const proxy = net.createServer((client) => {
  let head = Buffer.alloc(0);
  const onData = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) {
      if (head.length > 8192) client.destroy();
      return;
    }
    client.off('data', onData);
    client.pause();
    const rest = head.subarray(end + 4);
    handleTunnel(client, head.subarray(0, end));
    if (client.destroyed) return;
    if (rest.length > 0) client.unshift(rest);
    client.resume();
  };
  client.on('data', onData);
  client.on('error', () => undefined);
});

const control = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://control');
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname === '/mode') {
    const next = url.searchParams.get('m') ?? '';
    if (!MODES.has(next)) return reply(400, { error: 'unknown mode' });
    const previous = mode;
    mode = next;
    log({ event: 'mode', mode, previous });
    // No tunnel outlives a mode change: a keep-alive tunnel from the previous mode can never carry a later request.
    for (const [tunnel, open] of openTunnels) {
      openTunnels.delete(tunnel);
      log({ tunnel, event: 'closed-on-mode-change', mode: open.mode, newMode: next });
      open.client.destroy();
      open.upstream.destroy();
    }
    return reply(200, { mode });
  }
  if (req.method === 'GET' && url.pathname === '/mode') return reply(200, { mode });
  if (req.method === 'GET' && url.pathname === '/log') return reply(200, { mode, events });
  if (req.method === 'POST' && url.pathname === '/reset-log') {
    events.length = 0;
    return reply(200, { ok: true });
  }
  return reply(404, { error: 'not found' });
});

proxy.listen(PROXY_PORT, '0.0.0.0', () => log({ event: 'proxy-listening', port: PROXY_PORT, allow: [...ALLOW_HOSTS] }));
control.listen(CONTROL_PORT, '0.0.0.0', () => log({ event: 'control-listening', port: CONTROL_PORT, mode }));
