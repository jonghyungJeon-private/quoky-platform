import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

import { OPS_UI_CSS, OPS_UI_DEFAULT_REFRESH_SECONDS, OPS_UI_JS, OPS_UI_MIN_REFRESH_SECONDS } from './assets';
import { OPS_MAX_CODE_ATTEMPTS, OpsIntentStore } from './intents';
import {
  renderActionOutcome,
  renderDashboard,
  renderForgetConfirm,
  renderMemoryPage,
  renderReminderCancelConfirm,
  renderSignInPage,
  renderStatusPage,
} from './render';
import {
  OPS_UI_SECURITY_HEADERS,
  OPS_UI_SESSION_COOKIE,
  OpsUiSessionStore,
  SignInRateLimiter,
  clearedSessionCookie,
  constantTimeEquals,
  newSecret,
  readCookie,
  sessionCookie,
} from './security';
import type { OpsUiSession } from './security';
import { removeTokenFile, writeTokenFile } from './token-file';
import type { OpsActions, OpsUiEventLog, OpsViewModelSource } from './view-model';

/**
 * The OPS-1 listener (ADR-0113 D1–D4): one `node:http` server inside the Quoky process.
 *
 * - **Loopback only.** The only accepted bind host is `127.0.0.1`; anything else throws {@link OpsUiBindError} before
 *   a socket is opened. A taken port (or any listen failure) makes `start()` report `UNAVAILABLE` and leaves the rest
 *   of Quoky running.
 * - **Host check.** Every request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` is refused
 *   (DNS-rebinding defence).
 * - **Access.** A random 256-bit token per start, written to a `0600` file; `POST /session` with a constant-time match
 *   sets an `HttpOnly; SameSite=Strict; Path=/` session cookie. Failed sign-ins are rate-limited.
 * - **Origin and CSRF.** Every `POST` must carry `Origin` equal to the listener origin, checked before any handler;
 *   in-session state changes (sign-out, the only one in Phase 1) also need the session's CSRF token.
 * - **Headers.** Every response carries the exact ADR-0113 D4 CSP plus `nosniff`, `no-referrer` and `no-store`; no
 *   CORS header is ever sent.
 * - **Handling (OPS-2, ADR-0113 D7).** Only when `actions` is given: reminder cancel and memory forget, each a
 *   same-origin `POST` with the session CSRF token. Executing posts also carry a one-time action nonce bound to the
 *   session and to the subject shown on the confirmation page (`intents.ts`), so a double submit runs once. There is
 *   no approve or reject route (OPS-2b). Without `actions` the listener is the Phase 1 read-only screen.
 */

export const OPS_UI_BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

export class OpsUiBindError extends Error {
  readonly code = 'OPS_UI_BIND_NOT_LOOPBACK';
  constructor() {
    super('OPS_UI_BIND_NOT_LOOPBACK');
    this.name = 'OpsUiBindError';
  }
}

export interface OpsUiServerOptions {
  /** Must be `127.0.0.1` (ADR-0113 D2). */
  readonly host: string;
  /** 1024–65535 in production (validated by the config); `0` lets tests take an ephemeral port. */
  readonly port: number;
  /** Absolute path of `ops-ui.token`. */
  readonly tokenFilePath: string;
  readonly view: OpsViewModelSource;
  readonly log: OpsUiEventLog;
  readonly nowMs?: () => number;
  readonly refreshSeconds?: number;
  /** OPS-2 owner handling; absent = Phase 1 read-only (no handling route exists). */
  readonly actions?: OpsActions;
}

export type OpsUiStartResult =
  | { readonly status: 'LISTENING'; readonly port: number }
  | { readonly status: 'UNAVAILABLE'; readonly reason: string };

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

class RequestBodyError extends Error {
  constructor(readonly status: 413 | 415 | 400) {
    super(`body ${status}`);
  }
}

export class OpsUiServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private token: string | null = null;
  private port = 0;
  private allowedHosts: ReadonlySet<string> = new Set();
  private readonly nowMs: () => number;
  private readonly sessions: OpsUiSessionStore;
  private readonly limiter: SignInRateLimiter;
  private readonly refreshSeconds: number;
  private readonly intents: OpsIntentStore;

  constructor(private readonly options: OpsUiServerOptions) {
    if (options.host !== OPS_UI_BIND_HOST) throw new OpsUiBindError();
    this.nowMs = options.nowMs ?? Date.now;
    this.sessions = new OpsUiSessionStore(this.nowMs);
    this.limiter = new SignInRateLimiter(this.nowMs);
    this.intents = new OpsIntentStore(this.nowMs);
    this.refreshSeconds = Math.max(OPS_UI_MIN_REFRESH_SECONDS, options.refreshSeconds ?? OPS_UI_DEFAULT_REFRESH_SECONDS);
  }

  /** The bound port while listening, else 0. */
  get listeningPort(): number {
    return this.server === null ? 0 : this.port;
  }

  /** The bound address while listening (always `127.0.0.1`), else undefined. */
  get boundAddress(): string | undefined {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== 'string' ? address.address : undefined;
  }

  async start(): Promise<OpsUiStartResult> {
    if (this.server !== null) return { status: 'LISTENING', port: this.port };
    const server = createServer((req, res) => void this.dispatch(req, res));
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    server.maxConnections = 32;
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    const listened = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        resolve({ ok: false, reason: err.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LISTEN_FAILED' });
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve({ ok: true });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: this.options.host, port: this.options.port, exclusive: true });
    });
    if (!listened.ok) {
      this.options.log.warn('ops-ui.unavailable', { reason: listened.reason });
      return { status: 'UNAVAILABLE', reason: listened.reason };
    }

    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address === 'string' || address.address !== OPS_UI_BIND_HOST) {
      await closeServer(server);
      throw new OpsUiBindError();
    }
    this.port = address.port;
    this.allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);

    const token = newSecret();
    const written = writeTokenFile(this.options.tokenFilePath, token);
    if (!written.ok) {
      await closeServer(server);
      this.options.log.warn('ops-ui.unavailable', { reason: written.failure });
      return { status: 'UNAVAILABLE', reason: written.failure };
    }
    this.token = token;
    this.server = server;
    server.on('error', () => this.options.log.warn('ops-ui.server_error', { reason: 'SERVER_ERROR' }));
    this.options.log.info('ops-ui.listening', { host: OPS_UI_BIND_HOST, port: this.port });
    return { status: 'LISTENING', port: this.port };
  }

  /** Close the listener, drop every session and remove the token file. Idempotent; never throws. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.token = null;
    this.sessions.clear();
    this.intents.clear();
    if (server !== null) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await closeServer(server);
      removeTokenFile(this.options.tokenFilePath);
      this.options.log.info('ops-ui.stopped');
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (err) {
      if (err instanceof RequestBodyError) {
        this.sendPage(res, err.status, renderStatusPage('요청 거부', '요청 형식이 올바르지 않아요.'));
        return;
      }
      this.options.log.warn('ops-ui.request_failed', { reason: 'INTERNAL' });
      if (!res.headersSent) this.sendPage(res, 500, renderStatusPage('오류', '화면을 만들지 못했어요.'));
      else res.destroy();
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!this.allowedHosts.has(host)) {
      req.resume();
      this.sendPage(res, 421, renderStatusPage('요청 거부', '허용되지 않은 호스트예요.'));
      return;
    }
    const path = requestPath(req.url);
    const method = req.method ?? 'GET';

    if (method === 'POST') {
      // ADR-0113 D4: Origin first, before any handler or body read.
      if (req.headers.origin !== `http://${host}`) {
        req.resume();
        this.options.log.warn('ops-ui.post_refused', { reason: 'ORIGIN' });
        this.sendPage(res, 403, renderStatusPage('요청 거부', '허용되지 않은 출처예요.'));
        return;
      }
      const handler: Handler | undefined =
        path === '/session'
          ? (q, s) => this.signIn(q, s)
          : path === '/session/end'
            ? (q, s) => this.signOut(q, s)
            : this.actionPost(path);
      if (handler === undefined) {
        req.resume();
        this.sendPage(res, 404, renderStatusPage('없음', '없는 화면이에요.'));
        return;
      }
      await handler(req, res);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      req.resume();
      res.setHeader('Allow', 'GET, HEAD, POST');
      this.sendPage(res, 405, renderStatusPage('요청 거부', '허용되지 않은 요청이에요.'));
      return;
    }
    req.resume();
    switch (path) {
      case '/ops.css':
        this.send(res, 200, 'text/css; charset=utf-8', OPS_UI_CSS);
        return;
      case '/ops.js':
        this.send(res, 200, 'text/javascript; charset=utf-8', OPS_UI_JS);
        return;
      case '/signin':
        if (this.currentSession(req) !== undefined) return this.redirect(res, '/');
        this.sendPage(res, 200, renderSignInPage());
        return;
      case '/': {
        const session = this.currentSession(req);
        if (session === undefined) return this.redirect(res, '/signin');
        const view = await this.options.view();
        this.sendPage(res, 200, renderDashboard(view, session.csrfToken, this.refreshSeconds, this.options.actions !== undefined));
        return;
      }
      case '/actions/reminders/cancel':
      case '/memories': {
        const actions = this.options.actions;
        if (actions === undefined) break;
        const session = this.currentSession(req);
        if (session === undefined) return this.redirect(res, '/signin');
        if (path === '/memories') {
          this.sendPage(res, 200, renderMemoryPage(await actions.listMemories(), session.csrfToken));
          return;
        }
        const displayNo = positiveNumber(queryParam(req.url, 'no'));
        if (displayNo === undefined) {
          this.sendPage(res, 400, renderStatusPage('요청 거부', '알림 번호가 올바르지 않아요.'));
          return;
        }
        const preview = await actions.reminderCancelPreview(displayNo);
        if (preview.status !== 'FOUND') {
          this.sendPage(res, 200, renderActionOutcome('알림 취소', preview.outcome));
          return;
        }
        const nonce = this.intents.issue(session.id, 'reminder-cancel', String(preview.displayNo));
        this.sendPage(res, 200, renderReminderCancelConfirm(preview, session.csrfToken, nonce));
        return;
      }
      default:
        break;
    }
    this.sendPage(res, 404, renderStatusPage('없음', '없는 화면이에요.'));
  }

  /** The OPS-2 handling POST routes (only with `actions`). */
  private actionPost(path: string): Handler | undefined {
    const actions = this.options.actions;
    if (actions === undefined) return undefined;
    switch (path) {
      case '/actions/reminders/cancel':
        return (req, res) =>
          this.inSession(req, res, async (session, form) => {
            const intent = this.intents.find(session.id, 'reminder-cancel', form.get('nonce') ?? undefined);
            if (intent === undefined) return this.staleIntent(res);
            const displayNo = Number(intent.subject);
            const run = await this.intents.runOnce(intent, () => actions.cancelReminder(displayNo));
            this.audit('reminder.cancel', run.outcome.code, run.status === 'REPEATED');
            this.sendPage(res, 200, renderActionOutcome('알림 취소', run.outcome, run.status === 'REPEATED'));
          });
      case '/actions/memories/forget/request':
        return (req, res) =>
          this.inSession(req, res, async (session, form) => {
            const number = positiveNumber(form.get('number') ?? undefined);
            if (number === undefined) {
              this.sendPage(res, 400, renderStatusPage('요청 거부', '기억 번호가 올바르지 않아요.'));
              return;
            }
            const request = await actions.requestForget(number);
            this.audit('memory.forget.request', request.status === 'CONFIRMATION' ? 'CODE_ISSUED' : request.outcome.code, false);
            if (request.status !== 'CONFIRMATION') {
              this.sendPage(res, 200, renderActionOutcome('기억 잊기', request.outcome));
              return;
            }
            const nonce = this.intents.issue(session.id, 'memory-forget', JSON.stringify(request));
            this.sendPage(res, 200, renderForgetConfirm(request, session.csrfToken, nonce));
          });
      case '/actions/memories/forget/confirm':
        return (req, res) =>
          this.inSession(req, res, async (session, form) => {
            const intent = this.intents.find(session.id, 'memory-forget', form.get('nonce') ?? undefined);
            if (intent === undefined) return this.staleIntent(res);
            const request = JSON.parse(intent.subject) as Parameters<typeof renderForgetConfirm>[0];
            const entered = (form.get('code') ?? '').trim().toUpperCase();
            if (!constantTimeEquals(entered, request.code)) {
              intent.attempts += 1;
              this.audit('memory.forget.confirm', 'CODE_MISMATCH', false);
              if (intent.attempts >= OPS_MAX_CODE_ATTEMPTS && intent.result === undefined) {
                this.intents.drop(intent.nonce);
                this.sendPage(
                  res,
                  200,
                  renderActionOutcome('기억 잊기', {
                    code: 'CODE_ATTEMPTS_EXCEEDED',
                    message: '확인 코드가 여러 번 틀려서 이 요청을 닫았어요. 기억 목록에서 다시 시작하세요.',
                    ok: false,
                  }),
                );
                return;
              }
              this.sendPage(res, 200, renderForgetConfirm(request, session.csrfToken, intent.nonce, true));
              return;
            }
            const run = await this.intents.runOnce(intent, () => actions.confirmForget(request.code));
            this.audit('memory.forget.confirm', run.outcome.code, run.status === 'REPEATED');
            this.sendPage(res, 200, renderActionOutcome('기억 잊기', run.outcome, run.status === 'REPEATED'));
          });
      default:
        return undefined;
    }
  }

  /** Session first (no body read without one), then the form and its CSRF token, then the handler. */
  private async inSession(
    req: IncomingMessage,
    res: ServerResponse,
    handle: (session: OpsUiSession, form: URLSearchParams) => Promise<void>,
  ): Promise<void> {
    const session = this.currentSession(req);
    if (session === undefined) {
      req.resume();
      this.options.log.warn('ops-ui.post_refused', { reason: 'SESSION' });
      this.sendPage(res, 403, renderStatusPage('요청 거부', '로그인이 필요해요.'));
      return;
    }
    const form = await readForm(req);
    if (!constantTimeEquals(form.get('csrf') ?? '', session.csrfToken)) {
      this.options.log.warn('ops-ui.post_refused', { reason: 'CSRF' });
      this.sendPage(res, 403, renderStatusPage('요청 거부', '요청을 확인하지 못했어요. 화면을 새로 고친 뒤 다시 시도하세요.'));
      return;
    }
    await handle(session, form);
  }

  private staleIntent(res: ServerResponse): void {
    this.options.log.warn('ops-ui.post_refused', { reason: 'INTENT' });
    this.sendPage(res, 409, renderStatusPage('요청 만료', '이 확인 화면은 만료됐거나 이미 닫혔어요. 운영 화면에서 다시 시작하세요.'));
  }

  /** Content-free audit line for every handling step (ADR-0113 D7 audit: the `ops-ui` surface marker, codes only). */
  private audit(action: string, outcome: string, repeated: boolean): void {
    this.options.log.info('ops-ui.action', { surface: 'ops-ui', action, outcome, repeated });
  }

  private async signIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.limiter.isLocked()) {
      req.resume();
      this.options.log.warn('ops-ui.signin_refused', { reason: 'LOCKED' });
      this.sendPage(res, 429, renderSignInPage('LOCKED'));
      return;
    }
    const form = await readForm(req);
    const candidate = (form.get('token') ?? '').trim();
    const token = this.token;
    if (token !== null && candidate.length > 0 && constantTimeEquals(candidate, token)) {
      this.limiter.recordSuccess();
      const session = this.sessions.create();
      res.setHeader('Set-Cookie', sessionCookie(session.id));
      this.options.log.info('ops-ui.signin');
      this.redirect(res, '/');
      return;
    }
    this.limiter.recordFailure();
    this.options.log.warn('ops-ui.signin_refused', { reason: 'INVALID_TOKEN' });
    this.sendPage(res, this.limiter.isLocked() ? 429 : 401, renderSignInPage(this.limiter.isLocked() ? 'LOCKED' : 'INVALID'));
  }

  private async signOut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.currentSession(req);
    if (session === undefined) {
      req.resume();
      this.sendPage(res, 403, renderStatusPage('요청 거부', '로그인이 필요해요.'));
      return;
    }
    const form = await readForm(req);
    const csrf = form.get('csrf') ?? '';
    if (!constantTimeEquals(csrf, session.csrfToken)) {
      this.options.log.warn('ops-ui.post_refused', { reason: 'CSRF' });
      this.sendPage(res, 403, renderStatusPage('요청 거부', '요청을 확인하지 못했어요. 화면을 새로 고친 뒤 다시 시도하세요.'));
      return;
    }
    this.sessions.end(session.id);
    this.intents.endSession(session.id);
    res.setHeader('Set-Cookie', clearedSessionCookie());
    this.options.log.info('ops-ui.signout');
    this.redirect(res, '/signin');
  }

  private currentSession(req: IncomingMessage): OpsUiSession | undefined {
    return this.sessions.find(readCookie(req.headers.cookie, OPS_UI_SESSION_COOKIE));
  }

  private redirect(res: ServerResponse, location: '/' | '/signin'): void {
    res.setHeader('Location', location);
    this.send(res, 303, 'text/plain; charset=utf-8', '');
  }

  private sendPage(res: ServerResponse, status: number, html: string): void {
    this.send(res, status, 'text/html; charset=utf-8', html);
  }

  private send(res: ServerResponse, status: number, contentType: string, body: string): void {
    for (const [name, value] of Object.entries(OPS_UI_SECURITY_HEADERS)) res.setHeader(name, value);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.statusCode = status;
    res.end(body);
  }
}

function requestPath(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/__invalid__';
  }
}

function queryParam(rawUrl: string | undefined, name: string): string | undefined {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').searchParams.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A list number as the chat grammar takes it: a positive integer of at most 4 digits. */
function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]{0,3}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    req.resume();
    throw new RequestBodyError(415);
  }
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    throw new RequestBodyError(413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestBodyError(413);
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
