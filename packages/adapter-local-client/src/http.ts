import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SignInRateLimiter, constantTimeEquals } from '@quoky/local-auth';

import {
  HEADERS_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_TEXT_CHARS,
  MAX_TURNS_PER_MINUTE,
  OPAQUE_ID,
  REQUEST_TIMEOUT_MS,
} from './constants';
import type { EventHub } from './events';
import { fingerprintOf } from './idempotency';
import type { IdempotencyRing } from './idempotency';

/**
 * ADR-0125 D2/D3/D4: the HTTP/1.1 surface over the Unix socket. Imports only `node:*`, `@quoky/local-auth` and
 * siblings (D6): everything it needs from the adapter arrives through {@link LocalClientHttpDeps}.
 *
 * Order of every request: framing hygiene (400) -> `Host` (400) -> `Origin` (403) -> `OPTIONS` (405) -> route (404, no
 * body) -> Bearer token (401/429) -> readiness (503) -> content type / length / body bounds -> handler. The token is
 * compared FIRST and the failure limiter is consulted only on a failure, so a valid token is never blocked, during a
 * lockout too (P2-2).
 */

export interface TurnRequest {
  readonly turnId: string;
  readonly clientMessageId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly replyToEventId?: string;
}

export interface LocalClientHttpDeps {
  readonly hub: EventHub;
  readonly dedupe: IdempotencyRing;
  readonly limiter: SignInRateLimiter;
  readonly nowMs: () => number;
  /** The current token (per start, replaced by rotation). */
  token(): string;
  isReady(): boolean;
  /** The ADR-0102 D5 readiness word reported by `status` and the stream: `starting` or `ready`. */
  statusWord(): 'starting' | 'ready';
  mintTurnId(): string;
  /** Hand one accepted turn to the runtime. Never throws into the HTTP layer. */
  onTurn(turn: TurnRequest): void;
  /** Rotate the token (D3); true on success. The adapter closes the streams. */
  rotate(): boolean;
  recordAuthFailure(): void;
  maxTurnsPerMinute?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' } as const;
/** Headers that must appear at most once (a repeat is request smuggling or confusion material). */
const SINGLE_HEADERS = new Set(['host', 'authorization', 'content-type', 'content-length', 'origin', 'last-event-id']);

function send(res: ServerResponse, status: number, body?: Record<string, unknown>): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store', Connection: 'close' });
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'Content-Length': payload.length });
  res.end(payload);
}

const code = (value: string): Record<string, unknown> => ({ code: value });

function headerViolations(req: IncomingMessage): boolean {
  const seen = new Set<string>();
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = (raw[i] as string).toLowerCase();
    const value = raw[i + 1] as string;
    if (name === 'transfer-encoding' || name === 'content-encoding' || name === 'expect' || name === 'upgrade' || name === 'te' || name === 'trailer') return true;
    if (SINGLE_HEADERS.has(name)) {
      if (seen.has(name)) return true;
      seen.add(name);
    }
    // Obsolete line folding and raw control characters in a value (HTAB is the only one allowed).
    if (/[\r\n\u0000]/.test(value) || /[\r\n\u0000]/.test(name)) return true;
  }
  return false;
}

function bearerOf(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/i.exec(header);
  return match?.[1] ?? '';
}

function readBody(req: IncomingMessage, length: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > length) return resolve(undefined);
      chunks.push(chunk);
    });
    req.once('end', () => resolve(received === length ? Buffer.concat(chunks) : undefined));
    req.once('error', () => resolve(undefined));
    req.once('aborted', () => resolve(undefined));
  });
}

const MESSAGE_FIELDS = new Set(['clientMessageId', 'threadId', 'text', 'replyToEventId']);

type ParsedMessage = { readonly ok: true; readonly value: Omit<TurnRequest, 'turnId'> } | { readonly ok: false; readonly status: number; readonly code: string };

function parseMessage(buffer: Buffer): ParsedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    return { ok: false, status: 400, code: 'JSON_INVALID' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, status: 400, code: 'JSON_INVALID' };
  const body = parsed as Record<string, unknown>;
  if (Object.keys(body).some((key) => !MESSAGE_FIELDS.has(key))) return { ok: false, status: 400, code: 'UNKNOWN_FIELD' };
  const { clientMessageId, threadId, text, replyToEventId } = body;
  if (typeof clientMessageId !== 'string' || !OPAQUE_ID.test(clientMessageId)) return { ok: false, status: 400, code: 'CLIENT_MESSAGE_ID_INVALID' };
  if (threadId !== undefined && (typeof threadId !== 'string' || !OPAQUE_ID.test(threadId))) return { ok: false, status: 400, code: 'THREAD_ID_INVALID' };
  if (replyToEventId !== undefined && (typeof replyToEventId !== 'string' || !OPAQUE_ID.test(replyToEventId))) {
    return { ok: false, status: 400, code: 'REPLY_TO_INVALID' };
  }
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, status: 400, code: 'TEXT_INVALID' };
  if (text.length > MAX_TEXT_CHARS) return { ok: false, status: 413, code: 'TEXT_TOO_LONG' };
  return {
    ok: true,
    value: {
      clientMessageId,
      text,
      ...(threadId === undefined ? {} : { threadId }),
      ...(replyToEventId === undefined ? {} : { replyToEventId }),
    },
  };
}

type Route = 'status' | 'messages' | 'events' | 'rotate';

function routeOf(method: string | undefined, url: string | undefined): Route | undefined {
  // The raw target must be exactly the path: no query, no fragment, no encoding, no absolute-form.
  if (method === 'GET' && url === '/client/v1/status') return 'status';
  if (method === 'POST' && url === '/client/v1/messages') return 'messages';
  if (method === 'GET' && url === '/client/v1/events') return 'events';
  if (method === 'POST' && url === '/client/v1/token/rotate') return 'rotate';
  return undefined;
}

export function createLocalClientServer(deps: LocalClientHttpDeps): http.Server {
  const turnTimes: number[] = [];
  const maxTurns = deps.maxTurnsPerMinute ?? MAX_TURNS_PER_MINUTE;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (headerViolations(req)) return send(res, 400, code('BAD_REQUEST'));
    if (req.headers.host !== 'localhost') return send(res, 400, code('HOST_REFUSED'));
    if (req.headers.origin !== undefined) return send(res, 403, code('ORIGIN_REFUSED'));
    if (req.method === 'OPTIONS') return send(res, 405);
    const route = routeOf(req.method, req.url);
    if (route === undefined) return send(res, 404);

    // Token first; the limiter only on a failure (P2-2).
    const valid = constantTimeEquals(bearerOf(req), deps.token()) && bearerOf(req).length > 0;
    if (!valid) {
      if (deps.limiter.isLocked()) return send(res, 429, code('RATE_LIMITED'));
      deps.limiter.recordFailure();
      deps.recordAuthFailure();
      return send(res, 401, code('UNAUTHORIZED'));
    }

    if (route === 'status') return send(res, 200, { status: deps.statusWord(), epoch: deps.hub.epoch });

    if (route === 'events') {
      if (!deps.isReady()) return send(res, 503, code('NOT_READY'));
      const last = req.headers['last-event-id'];
      if (deps.hub.attach(res, typeof last === 'string' ? last : undefined, deps.statusWord()) === 'TOO_MANY_STREAMS') {
        return send(res, 429, code('TOO_MANY_STREAMS'));
      }
      return;
    }

    if (route === 'messages' && !deps.isReady()) return send(res, 503, code('NOT_READY'));

    // State-changing request: JSON with exactly one Content-Length, within the body bound.
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      return send(res, 415, code('CONTENT_TYPE_INVALID'));
    }
    const declared = req.headers['content-length'];
    if (typeof declared !== 'string' || !/^[0-9]{1,9}$/.test(declared)) return send(res, 411, code('LENGTH_REQUIRED'));
    const length = Number(declared);
    if (length > MAX_BODY_BYTES) return send(res, 413, code('BODY_TOO_LARGE'));
    const body = await readBody(req, length);
    if (body === undefined) return send(res, 400, code('BAD_REQUEST'));

    if (route === 'rotate') {
      if (!deps.rotate()) return send(res, 500, code('ROTATE_FAILED'));
      return send(res, 200, { rotated: true, epoch: deps.hub.epoch });
    }

    const parsed = parseMessage(body);
    if (!parsed.ok) return send(res, parsed.status, code(parsed.code));
    const fingerprint = fingerprintOf(parsed.value.threadId, parsed.value.text);
    const verdict = deps.dedupe.check(parsed.value.clientMessageId, fingerprint);
    if (verdict.kind === 'conflict') return send(res, 409, code('IDEMPOTENCY_CONFLICT'));
    if (verdict.kind === 'replay') return send(res, 202, { turnId: verdict.turnId, epoch: deps.hub.epoch });

    const now = deps.nowMs();
    while (turnTimes.length > 0 && now - (turnTimes[0] as number) >= 60_000) turnTimes.shift();
    if (turnTimes.length >= maxTurns) return send(res, 429, code('TURN_RATE_LIMITED'));
    turnTimes.push(now);

    const turnId = deps.mintTurnId();
    deps.dedupe.remember(parsed.value.clientMessageId, fingerprint, turnId);
    deps.onTurn({ ...parsed.value, turnId });
    return send(res, 202, { turnId, epoch: deps.hub.epoch });
  };

  const server = http.createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      insecureHTTPParser: false,
      headersTimeout: deps.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      requestTimeout: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: 1_000,
      keepAliveTimeout: 1,
    },
    (req, res) => {
      handle(req, res).catch(() => send(res, 500, code('INTERNAL')));
    },
  );
  server.maxRequestsPerSocket = 1;
  // `Expect: 100-continue` is refused before the client sends a body.
  server.on('checkContinue', (_req, res) => send(res, 400, code('BAD_REQUEST')));
  server.on('checkExpectation', (_req, res) => send(res, 400, code('BAD_REQUEST')));
  // A request the parser itself refuses (oversize header block, duplicate Content-Length, Transfer-Encoding with
  // Content-Length, obsolete folding, malformed framing) is a 400 before any handler.
  server.on('clientError', (_err, socket) => {
    if (!socket.writable || socket.destroyed) return socket.destroy();
    const payload = JSON.stringify(code('BAD_REQUEST'));
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
    );
  });
  return server;
}
