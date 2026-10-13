import { channel } from 'node:diagnostics_channel';
import { ADDRCONFIG, lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import { Agent, Dispatcher, buildConnector, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { now } from '@quoky/core';
import type { Logger } from '@quoky/core';
import { currentCorrelation } from '../correlation-context';
import type { CorrelationContext, TrafficInitiator } from '../correlation-context';
import { EgressBudgets, parseRetryAfterSeconds } from './egress-budget';
import type { BudgetEvent, BudgetRefusal, BudgetTicket } from './egress-budget';
import { checkDestination, labelFor, localEndpointFor, normalizeHost, pathTemplate, UNLISTED_LABEL } from './egress-policy';
import type { DestinationFinding, EgressInventory } from './egress-policy';
import { classifyAddress } from './ip-ranges';
import type { DenyCategory } from './ip-ranges';
import { recordBase, SmallRequestBurstDetector, statusClassOf } from './traffic-ledger';
import type { GuardEventName, LedgerRequestRecord, LedgerSink } from './traffic-ledger';

/**
 * The process egress guard (ADR-0121 D8, design §5.2), composition-root code: Core never sees it.
 *
 * What it does, for Quoky's own Node HTTP paths:
 * - **fetch / undici.** {@link installEgressGuard} installs a dispatcher as undici's process-global dispatcher, which
 *   Node's built-in `fetch` and every `undici.request` without an explicit dispatcher (discord.js REST) use. Each request
 *   — and each hop of a redirect a caller still follows, because every hop is a new dispatch — is checked by NAME
 *   (https only, no IP literal, host on the allowlist), counted against its budget, and recorded in the traffic ledger.
 * - **Connection-bound address check and pinning.** A new connection resolves the host itself (`dns.lookup` with
 *   `hints: ADDRCONFIG`, all addresses, resolver order, a 10 s bound) and checks EVERY address against the deny ranges
 *   (`ip-ranges.ts`). The socket is then opened with the original name — so TLS SNI, certificate verification and the
 *   `Host` header keep it — but its lookup answers ONLY from that checked list (family and `all` honoured, order kept,
 *   so multi-address fallback and Happy Eyeballs still work). A later or second DNS answer (rebinding) can never reach
 *   the socket. Loopback is allowed only for the exact `127.0.0.1:<port>` local endpoint (Ollama) named as such in the
 *   URL. In `observe` every resolved address is kept, so observe connects exactly as Node would.
 * - **Redirects.** `maxRedirections` is stripped, so the dispatcher never follows a redirect itself; a caller that
 *   follows one (fetch) does so with a new, checked dispatch.
 * - **`http`/`https` modules.** `http.globalAgent` and `https.globalAgent` are replaced by agents that apply the same
 *   name check and the same checked, pinned lookup (they are connection-logged, not byte-counted).
 * - **Unguarded undici traffic.** A request created by another undici dispatcher (a library that brings its own Agent)
 *   is noticed on the `undici:request:create` diagnostics channel and logged as `unguarded-request` when its host is not
 *   on the allowlist. It is observed only.
 *
 * Modes (`QUOKY_EGRESS_GUARD`): `observe` (the default) logs every finding as a content-free guard event and lets the
 * request through unchanged; `enforce` refuses it with {@link EgressRefusedError} before any byte is sent.
 *
 * **What it does NOT cover — stated plainly.** Child processes (`claude -p`, `ollama`, `git` in code work) run in other
 * processes; no in-process hook can see or block their sockets. The same holds for libraries that open raw sockets
 * outside undici and the `http`/`https` agents — today that is the discord.js gateway websocket (`ws` with its own
 * `createConnection`). Those destinations are reduced (L1 for the Claude CLI) and observed by the host self-check, not
 * blocked. A process-wide guarantee needs an OS-level control (design Q10), which the owner has deferred.
 */

export type GuardMode = 'observe' | 'enforce';

/** Why the guard refused a request in `enforce` (a fixed code, never free text). */
export type EgressRefusalReason = DestinationFinding | 'denied-range' | 'budget-exceeded' | 'backoff';

/** Error codes the connector-write transport guard reads as "refused before any byte was sent". */
export const EGRESS_REFUSED_CODE = 'EGRESS_REFUSED';

/** The deterministic refusal of `enforce` mode. Its message names the reason only (no host, path or value). */
export class EgressRefusedError extends Error {
  readonly code = EGRESS_REFUSED_CODE;
  constructor(
    readonly reason: EgressRefusalReason,
    readonly detail?: string,
  ) {
    super(`egress refused: ${reason}${detail !== undefined ? ` (${detail})` : ''}`);
    this.name = 'EgressRefusedError';
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Name resolution (`dns.lookup` with `all: true` in production; a stub in tests). */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** The undici connector the guard delegates to after the check (undici's `buildConnector()` in production). */
export type BaseConnector = (options: buildConnector.Options, callback: buildConnector.Callback) => void;

/**
 * Builds the base connector around the guard's pinned lookup. Production: `buildConnector({ lookup })`, so the socket's
 * own name resolution is answered ONLY from the addresses the guard already checked (never a fresh DNS query).
 */
export type BaseConnectorFactory = (pinnedLookup: LookupFunction) => BaseConnector;

/** Bound of one name resolution, the same as undici's connect timeout. */
export const DNS_TIMEOUT_MS = 10_000;

export interface EgressGuardOptions {
  readonly mode: GuardMode;
  readonly inventory: EgressInventory;
  readonly logger: Logger;
  readonly ledger?: LedgerSink;
  readonly budgets?: EgressBudgets;
  readonly resolve?: Resolver;
  readonly baseConnector?: BaseConnectorFactory;
  readonly clock?: () => Date;
  /** Default {@link DNS_TIMEOUT_MS}. */
  readonly dnsTimeoutMs?: number;
}

/**
 * `dns.lookup` as `net` would call it for an unspecified family (`hints: ADDRCONFIG`, resolver order kept), but with all
 * addresses. The guard bounds it with {@link boundedResolver} ({@link DNS_TIMEOUT_MS}).
 */
export const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true, hints: ADDRCONFIG }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => ({ address: entry.address, family: entry.family })));
    });
  });

/** Bounds a resolver: no answer within `timeoutMs` is an `EAI_AGAIN` failure (nothing was sent). */
export function boundedResolver(resolve: Resolver, timeoutMs: number): Resolver {
  return (hostname) =>
    new Promise((fulfil, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error('name resolution timed out'), { code: 'EAI_AGAIN' }));
      }, timeoutMs);
      timer.unref?.();
      resolve(hostname).then(
        (addresses) => {
          clearTimeout(timer);
          fulfil(addresses);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}

/** A resolution-stage error with a `code` the connector-write transport reads as "nothing was sent". */
function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'ENOTFOUND' });
}

/**
 * Answers a `net` lookup from a list of already-checked addresses, honouring the requested `family` (0, 4, 6, or
 * `'IPv4'`/`'IPv6'`) and `all`. Order is kept, so with `all` (Happy Eyeballs, `autoSelectFamily`) and family 0 the socket
 * can still fall back to the next address or the other family.
 */
export function answerLookup(addresses: readonly ResolvedAddress[], options: unknown, callback: (...args: unknown[]) => void): void {
  const raw = typeof options === 'number' ? options : typeof options === 'object' && options !== null ? (options as { family?: unknown }).family : 0;
  const family = raw === 'IPv4' ? 4 : raw === 'IPv6' ? 6 : typeof raw === 'number' ? raw : 0;
  const all = typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true;
  const matching = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : [...addresses];
  const first = matching[0];
  if (first === undefined) {
    callback(notFound('no checked address of the requested family'));
    return;
  }
  if (all) callback(null, matching.map((entry) => ({ address: entry.address, family: entry.family })));
  else callback(null, first.address, first.family);
}

/** How long a repeated finding (same event, host, label, detail) stays silent in the log and the ledger. */
const FINDING_REPEAT_MS: Readonly<Record<GuardEventName, number>> = {
  'new-destination': 60 * 60_000,
  'denied-range': 60 * 60_000,
  'ip-literal': 60 * 60_000,
  'insecure-scheme': 60 * 60_000,
  'unguarded-request': 60 * 60_000,
  'budget-exceeded': 60_000,
  'backoff-open': 0,
  'volume-alert': 0,
  'repeated-small': 0,
};

interface ConnectAttempt {
  readonly hostname: string;
  readonly port: number;
  readonly protocol: string;
}

interface PinDecision {
  /** The addresses the connection may use, in resolver order (all checked; in observe, all resolved). */
  readonly addresses: readonly ResolvedAddress[];
  readonly denied?: DenyCategory;
  readonly refuse: boolean;
}

export class EgressGuard {
  readonly mode: GuardMode;
  readonly inventory: EgressInventory;
  readonly budgets: EgressBudgets;
  private readonly logger: Logger;
  private readonly ledger: LedgerSink | undefined;
  private readonly resolve: Resolver;
  private readonly baseConnect: BaseConnector;
  /** Checked address lists by host name, held while a connect to that host is in flight (read by the pinned lookup). */
  private readonly pinned = new Map<string, { addresses: readonly ResolvedAddress[]; holders: number }>();
  private readonly clock: () => Date;
  private readonly findingsSeen = new Map<string, number>();
  private readonly bursts = new SmallRequestBurstDetector();
  /** Depth of synchronous guarded dispatches (the `undici:request:create` observer skips our own requests). */
  private dispatchDepth = 0;

  constructor(options: EgressGuardOptions) {
    this.mode = options.mode;
    this.inventory = options.inventory;
    this.logger = options.logger;
    this.ledger = options.ledger;
    this.clock = options.clock ?? (() => new Date(now()));
    this.budgets = options.budgets ?? new EgressBudgets(() => this.clock().getTime());
    this.resolve = boundedResolver(options.resolve ?? defaultResolver, options.dnsTimeoutMs ?? DNS_TIMEOUT_MS);
    this.baseConnect = (options.baseConnector ?? ((lookup) => buildConnector({ lookup })))(this.pinnedLookup);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Address check and pinning (shared by the undici connector and the http/https lookup)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Resolves `attempt.hostname` ONCE and checks every address. In `enforce` any denied address refuses the connection; in
   * `observe` the finding is logged and every resolved address is kept in resolver order, so observe connects exactly
   * as Node would (behaviour-neutral).
   */
  async decidePin(attempt: ConnectAttempt, correlation: CorrelationContext | undefined): Promise<PinDecision> {
    const host = normalizeHost(attempt.hostname);
    const literal = isIP(host) !== 0;
    const addresses: readonly ResolvedAddress[] = literal ? [{ address: host, family: isIP(host) }] : await this.resolve(host);
    if (addresses.length === 0) {
      const error = new Error('name resolution returned no address') as Error & { code?: string };
      error.code = 'ENOTFOUND';
      throw error;
    }
    const localAllowed = (address: ResolvedAddress): boolean =>
      literal && address.address === '127.0.0.1' && localEndpointFor(this.inventory, host, attempt.port) !== undefined;
    let denied: DenyCategory | undefined;
    for (const address of addresses) {
      const category = localAllowed(address) ? undefined : classifyAddress(address.address);
      if (category !== undefined) denied ??= category;
    }
    const label = labelFor(this.inventory, host, attempt.port, '/');
    if (denied !== undefined) {
      this.finding('denied-range', host, label, denied, correlation, this.mode === 'enforce');
      if (this.mode === 'enforce') return { addresses: [], denied, refuse: true };
    }
    return { addresses, ...(denied !== undefined ? { denied } : {}), refuse: false };
  }

  /**
   * The lookup handed to the base connector: it answers ONLY from the list {@link connect} checked for this host and
   * never resolves again, so a rebinding answer cannot reach the socket. No held list means no address.
   */
  readonly pinnedLookup: LookupFunction = (hostname, options, callback) => {
    const entry = this.pinned.get(normalizeHost(hostname));
    if (entry === undefined) {
      (callback as (error: Error) => void)(notFound('egress guard: no checked address for this host'));
      return;
    }
    answerLookup(entry.addresses, options, callback as (...args: unknown[]) => void);
  };

  /**
   * The undici `connect` function: resolve and check once, hold the checked list for the pinned lookup, then delegate
   * to the base connector with the ORIGINAL name (so SNI, certificate verification and `Host` keep it). Every failure,
   * including a synchronous throw of the base connector, reaches `callback` exactly once.
   */
  readonly connect = (options: buildConnector.Options, callback: buildConnector.Callback): void => {
    const correlation = currentCorrelation();
    const hostname = normalizeHost(options.hostname);
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);
    const label = labelFor(this.inventory, hostname, port, '/');
    let held = false;
    let settled = false;
    const finish = (error: Error | null, socket: Socket | null): void => {
      if (settled) return;
      settled = true;
      if (held) this.release(hostname);
      if (error !== null) callback(error, null);
      else callback(null, socket as Socket);
    };
    this.decidePin({ hostname, port, protocol: options.protocol }, correlation)
      .then((decision) => {
        if (decision.refuse || decision.addresses.length === 0) {
          this.writeConnect(correlation, hostname, label, null, port, 'refused');
          finish(new EgressRefusedError('denied-range', decision.denied), null);
          return;
        }
        this.hold(hostname, decision.addresses);
        held = true;
        this.baseConnect(options, (error, socket) => {
          if (error === null && socket !== null) {
            const ip = socket.remoteAddress ?? decision.addresses[0]?.address ?? null;
            this.writeConnect(correlation, hostname, label, ip, port, 'pinned');
          }
          finish(error, socket);
        });
      })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error('egress guard: connect failed'), null));
  };

  /**
   * A `net` lookup for the `http`/`https` agents: the same single resolution and check, answered with the checked list
   * (family and `all` honoured). Ports are unknown here, so loopback is never excepted (the local endpoint is an IP
   * literal, which never reaches a lookup).
   */
  readonly lookup: LookupFunction = (hostname, options, callback) => {
    const correlation = currentCorrelation();
    const host = normalizeHost(hostname);
    const label = labelFor(this.inventory, host, 0, '/');
    this.decidePin({ hostname: host, port: 0, protocol: 'https:' }, correlation)
      .then((decision) => {
        if (decision.refuse || decision.addresses.length === 0) {
          this.writeConnect(correlation, host, label, null, 0, 'refused');
          (callback as (error: Error) => void)(new EgressRefusedError('denied-range', decision.denied));
          return;
        }
        this.writeConnect(correlation, host, label, decision.addresses[0]?.address ?? null, 0, 'pinned');
        answerLookup(decision.addresses, options, callback as (...args: unknown[]) => void);
      })
      .catch((error: unknown) => (callback as (error: Error) => void)(error instanceof Error ? error : new Error('lookup failed')));
  };

  private hold(host: string, addresses: readonly ResolvedAddress[]): void {
    const entry = this.pinned.get(host);
    // Concurrent connects to one host each hold a list that was checked; the latest checked list answers.
    this.pinned.set(host, { addresses, holders: (entry?.holders ?? 0) + 1 });
  }

  private release(host: string): void {
    const entry = this.pinned.get(host);
    if (entry === undefined) return;
    if (entry.holders <= 1) this.pinned.delete(host);
    else this.pinned.set(host, { addresses: entry.addresses, holders: entry.holders - 1 });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Name-level check and budgets (per request / per redirect hop)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Runs the name-level checks and the budget for one request. Returns the refusal in `enforce`, else `undefined`
   * (with every finding logged), plus the budget ticket that later receives the byte counts.
   */
  admitRequest(
    url: URL,
    path: string,
    correlation: CorrelationContext | undefined,
  ): { refusal?: EgressRefusedError; ticket: BudgetTicket; label: string; host: string } {
    const host = normalizeHost(url.hostname);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const label = labelFor(this.inventory, host, port, path);
    const enforce = this.mode === 'enforce';
    let refusal: EgressRefusedError | undefined;
    for (const finding of checkDestination(this.inventory, { protocol: url.protocol, host, port })) {
      this.finding(finding, host, label, finding, correlation, enforce);
      refusal ??= new EgressRefusedError(finding);
    }
    // A request enforce refuses by name never reaches the budget windows (a retry loop cannot keep them full).
    if (enforce && refusal !== undefined) return { refusal, ticket: NO_TICKET, label, host };
    const initiator: TrafficInitiator = correlation?.initiator ?? 'background';
    // In enforce a budget refusal is not counted either; in observe the request really goes out, so it counts.
    const { verdict, ticket } = this.budgets.admit(label, initiator, { countRefused: !enforce });
    if (!verdict.ok) {
      const reason: EgressRefusalReason = verdict.reason === 'backoff' ? 'backoff' : 'budget-exceeded';
      this.finding(reason === 'backoff' ? 'backoff-open' : 'budget-exceeded', host, label, verdict.reason, correlation, enforce);
      refusal ??= new EgressRefusedError(reason, verdict.reason satisfies BudgetRefusal);
    }
    return { ...(enforce && refusal !== undefined ? { refusal } : {}), ticket, label, host };
  }

  /** Called when a request finished (answered, failed or refused). Writes the ledger record and feeds the detectors. */
  finishRequest(
    record: Omit<LedgerRequestRecord, 'v' | 'ts' | 'cid' | 'initiator' | 'kind' | 'mode'>,
    correlation: CorrelationContext | undefined,
    retryAfterSeconds: number | undefined,
  ): void {
    const full: LedgerRequestRecord = {
      ...recordBase(this.clock, correlation, record.host, record.label),
      kind: 'request',
      method: record.method,
      path: record.path,
      status: record.status,
      statusClass: record.statusClass,
      bytesUp: record.bytesUp,
      bytesDown: record.bytesDown,
      latencyMs: record.latencyMs,
      outcome: record.outcome,
      mode: this.mode,
    };
    this.ledger?.append(full);
    if (record.outcome !== 'refused') {
      for (const event of this.budgets.recordOutcome(record.label, record.status ?? undefined, retryAfterSeconds)) {
        this.budgetEvent(event, record.host, correlation);
      }
    }
    if (this.bursts.observe(full, this.clock().getTime())) {
      this.finding('repeated-small', record.host, record.label, 'short-window', correlation, false);
    }
  }

  /** Records a request created by an undici dispatcher other than ours (observe-only, see the module comment). */
  noticeUnguardedRequest(origin: unknown): void {
    if (this.dispatchDepth > 0) return;
    let url: URL;
    try {
      url = new URL(String(origin));
    } catch {
      return;
    }
    const host = normalizeHost(url.hostname);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const label = labelFor(this.inventory, host, port, '/');
    if (label === UNLISTED_LABEL) this.finding('unguarded-request', host, label, 'foreign-dispatcher', currentCorrelation(), false);
  }

  /** Runs `work` while marking dispatches as guarded (synchronous span only). */
  withinGuardedDispatch<T>(work: () => T): T {
    this.dispatchDepth += 1;
    try {
      return work();
    } finally {
      this.dispatchDepth -= 1;
    }
  }

  private budgetEvent(event: BudgetEvent, host: string, correlation: CorrelationContext | undefined): void {
    if (event.kind === 'backoff-open') {
      this.finding('backoff-open', host, event.label, `open-${Math.round(event.openMs / 1000)}s`, correlation, false);
    } else {
      this.finding('volume-alert', host, 'all', `${event.direction}-80pct`, correlation, false);
    }
  }

  private finding(
    event: GuardEventName,
    host: string,
    label: string,
    detail: string,
    correlation: CorrelationContext | undefined,
    blocked: boolean,
  ): void {
    const key = `${event}|${host}|${label}|${detail}|${blocked ? 'b' : 'o'}`;
    const nowMs = this.clock().getTime();
    const last = this.findingsSeen.get(key);
    const quiet = FINDING_REPEAT_MS[event];
    if (quiet > 0 && last !== undefined && nowMs - last < quiet) return;
    this.findingsSeen.set(key, nowMs);
    const action = blocked ? 'blocked' : 'observed';
    this.ledger?.append({
      ...recordBase(this.clock, correlation, host, label),
      kind: 'guard',
      event,
      detail,
      mode: this.mode,
      action,
    });
    this.logger.warn('egress.guard', { event, host, label, detail, mode: this.mode, action });
  }

  private writeConnect(
    correlation: CorrelationContext | undefined,
    host: string,
    label: string,
    ip: string | null,
    port: number,
    outcome: 'pinned' | 'refused',
  ): void {
    this.ledger?.append({ ...recordBase(this.clock, correlation, host, label), kind: 'connect', ip, port, outcome });
  }
}

const NO_TICKET: BudgetTicket = { addBytes: () => undefined };

// ---------------------------------------------------------------------------------------------------------------------
// The undici dispatcher
// ---------------------------------------------------------------------------------------------------------------------

type Handler = Dispatcher.DispatchHandlers & Record<string, unknown>;

function byteLengthOf(chunk: unknown): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (typeof chunk === 'number') return chunk;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function headerValue(headers: unknown, name: string): string | undefined {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    // Raw response headers (alternating name/value buffers) or a flat request header array.
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === wanted) return String(headers[i + 1]);
    }
    return undefined;
  }
  if (headers !== null && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0]) : String(value);
    }
  }
  return undefined;
}

/**
 * Wraps one request's handler: it forwards every callback unchanged (same `this`, same return values) and only counts
 * the status, the body bytes sent and the response bytes received, then reports once when the request ends.
 */
function observingHandler(
  original: Handler,
  report: (result: { status: number | null; bytesUp: number; bytesDown: number; failed: boolean; retryAfter?: number }) => void,
): Handler {
  let status: number | null = null;
  let bytesUp = 0;
  let bytesDown = 0;
  let retryAfter: number | undefined;
  let reported = false;
  const finish = (failed: boolean): void => {
    if (reported) return;
    reported = true;
    report({ status, bytesUp, bytesDown, failed, ...(retryAfter !== undefined ? { retryAfter } : {}) });
  };
  const wrapped: Handler = {
    onConnect: (abort: (err?: Error) => void) => original.onConnect?.call(original, abort),
    onError: (err: Error) => {
      finish(true);
      return original.onError?.call(original, err);
    },
    onHeaders: (statusCode: number, headers: Buffer[], resume: () => void, statusText: string) => {
      if (statusCode >= 200) status = statusCode;
      if (statusCode === 429 || statusCode === 503) retryAfter = parseRetryAfterSeconds(headerValue(headers, 'retry-after'));
      return original.onHeaders?.call(original, statusCode, headers, resume, statusText) ?? true;
    },
    onData: (chunk: Buffer) => {
      bytesDown += byteLengthOf(chunk);
      return original.onData?.call(original, chunk) ?? true;
    },
    onComplete: (trailers: string[] | null) => {
      finish(false);
      return original.onComplete?.call(original, trailers);
    },
    onBodySent: (chunk: unknown, total?: number) => {
      bytesUp += byteLengthOf(chunk);
      return (original.onBodySent as ((...args: unknown[]) => void) | undefined)?.call(original, chunk, total);
    },
  };
  if (typeof original.onUpgrade === 'function') {
    wrapped.onUpgrade = (statusCode: number, headers: Buffer[] | string[] | null, socket: import('node:stream').Duplex) => {
      status = statusCode;
      finish(false);
      return original.onUpgrade?.call(original, statusCode, headers, socket);
    };
  }
  for (const optional of ['onResponseStarted', 'onRequestSent'] as const) {
    const method = original[optional];
    if (typeof method === 'function') wrapped[optional] = (...args: unknown[]) => (method as (...a: unknown[]) => unknown).apply(original, args);
  }
  return wrapped;
}

/**
 * Idle window of the dedicated long-poll pool. undici's default (4 s) is shorter than the gap around a Telegram long
 * poll, so every poll paid a new TCP+TLS handshake (and a new address check + ledger `connect` record). Only requests
 * labelled `telegram-poll` use this pool: a long idle window exposes a request to a stale-socket reset, which is safe
 * to repeat for the offset-based `getUpdates` but not for a POST that sends something. Everything else keeps undici's
 * default window on the shared Agent. Both pools use the same guarded, pinning connector.
 */
export const POLL_KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** The ledger label whose requests use the long-poll pool and may be repeated once after a stale-socket reset. */
const POLL_LABEL = 'telegram-poll';
const STALE_SOCKET_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

/**
 * Repeats ONE request once, immediately, when it fails with a stale-socket error before any response byte. Only the
 * caller that knows the request is safe to repeat (a poll with a re-sendable body) uses it.
 */
function retryOnceOnStaleSocket(original: Handler, redispatch: (handler: Handler) => boolean): Handler {
  let retried = false;
  let sawResponse = false;
  const wrapped: Handler = {
    ...(original as object),
    onConnect: (abort: (err?: Error) => void) => original.onConnect?.call(original, abort),
    onError: (err: Error) => {
      const code = (err as { code?: unknown }).code;
      if (!retried && !sawResponse && typeof code === 'string' && STALE_SOCKET_CODES.has(code)) {
        retried = true;
        if (redispatch(wrapped)) return;
      }
      return original.onError?.call(original, err);
    },
    onHeaders: (statusCode: number, headers: Buffer[], resume: () => void, statusText: string) => {
      if (statusCode >= 200) sawResponse = true;
      return original.onHeaders?.call(original, statusCode, headers, resume, statusText) ?? true;
    },
    onData: (chunk: Buffer) => original.onData?.call(original, chunk) ?? true,
    onComplete: (trailers: string[] | null) => original.onComplete?.call(original, trailers),
    onBodySent: (chunk: unknown, total?: number) => (original.onBodySent as ((...args: unknown[]) => void) | undefined)?.call(original, chunk, total),
  };
  return wrapped;
}

/** The process-global dispatcher: name check + budget + ledger around an Agent whose connections are checked and pinned. */
export class GuardedDispatcher extends Dispatcher {
  private readonly agent: Agent;
  /** Dedicated pool for `telegram-poll`: the same guarded connector, a long idle window. */
  private readonly pollAgent: Agent;

  constructor(private readonly guard: EgressGuard) {
    super();
    this.agent = new Agent({ connect: guard.connect });
    this.pollAgent = new Agent({
      connect: guard.connect,
      keepAliveTimeout: POLL_KEEP_ALIVE_TIMEOUT_MS,
      keepAliveMaxTimeout: POLL_KEEP_ALIVE_TIMEOUT_MS,
    });
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const correlation = currentCorrelation();
    const started = performance.now();
    let url: URL;
    try {
      url = new URL(String(options.origin ?? ''));
    } catch {
      return this.guard.withinGuardedDispatch(() => this.agent.dispatch(options, handler));
    }
    const rawPath = String(options.path ?? '/');
    const method = String(options.method ?? 'GET').toUpperCase();
    const { refusal, ticket, label, host } = this.guard.admitRequest(url, rawPath, correlation);
    const path = pathTemplate(label, rawPath);
    if (refusal !== undefined) {
      this.guard.finishRequest(
        { host, label, method, path, status: null, statusClass: 'none', bytesUp: 0, bytesDown: 0, latencyMs: 0, outcome: 'refused' },
        correlation,
        undefined,
      );
      queueMicrotask(() => handler.onError?.(refusal));
      return true;
    }
    const contentLength = Number(headerValue(options.headers, 'content-length'));
    const wrapped = observingHandler(handler as Handler, (result) => {
      const bytesUp = result.bytesUp > 0 ? result.bytesUp : Number.isFinite(contentLength) ? contentLength : 0;
      ticket.addBytes(bytesUp, result.bytesDown);
      this.guard.finishRequest(
        {
          host,
          label,
          method,
          path,
          status: result.status,
          statusClass: statusClassOf(result.status),
          bytesUp,
          bytesDown: result.bytesDown,
          latencyMs: Math.round(performance.now() - started),
          outcome: result.status === null && result.failed ? 'error' : 'ok',
        },
        correlation,
        result.retryAfter,
      );
    });
    // A redirect followed INSIDE the dispatcher would skip the per-hop checks: `maxRedirections` is stripped, so a 3xx
    // goes back to the caller (fetch follows it with a new, checked dispatch).
    const forwarded: Dispatcher.DispatchOptions = { ...options, maxRedirections: 0 } as Dispatcher.DispatchOptions;
    if (label !== POLL_LABEL) return this.guard.withinGuardedDispatch(() => this.agent.dispatch(forwarded, wrapped));
    // A repeat needs a body that can be sent again: none, a string/bytes, or a (fetch) async-iterable body that is
    // recorded as it goes out and replayed only if it was fully sent.
    const body = (forwarded as { body?: unknown }).body;
    let replay: (() => { body: unknown } | undefined) | undefined;
    if (body === undefined || body === null || typeof body === 'string' || body instanceof Uint8Array) replay = () => ({ body });
    else if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      let complete = false;
      const source = body as AsyncIterable<Uint8Array | string>;
      (forwarded as { body?: unknown }).body = (async function* record() {
        for await (const chunk of source) {
          chunks.push(Buffer.from(chunk));
          yield chunk;
        }
        complete = true;
      })();
      replay = () => (complete ? { body: Buffer.concat(chunks) } : undefined);
    }
    const send = (handler: Handler, options: Dispatcher.DispatchOptions): boolean =>
      this.guard.withinGuardedDispatch(() => this.pollAgent.dispatch(options, handler));
    if (replay === undefined) return send(wrapped, forwarded);
    const repeat = (handler: Handler): boolean => {
      const again = replay();
      if (again === undefined) return false;
      send(handler, { ...forwarded, body: again.body } as Dispatcher.DispatchOptions);
      return true;
    };
    return send(retryOnceOnStaleSocket(wrapped, repeat), forwarded);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    if (callback !== undefined) {
      Promise.all([this.agent.close(), this.pollAgent.close()]).then(() => callback(), () => callback());
      return;
    }
    return Promise.all([this.agent.close(), this.pollAgent.close()]).then(() => undefined);
  }

  override destroy(): Promise<void>;
  override destroy(err: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(err: Error | null, callback: () => void): void;
  override destroy(errOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    const error = typeof errOrCallback === 'function' ? null : errOrCallback ?? null;
    const done = typeof errOrCallback === 'function' ? errOrCallback : callback;
    if (done !== undefined) {
      Promise.all([this.agent.destroy(error), this.pollAgent.destroy(error)]).then(() => done(), () => done());
      return;
    }
    return Promise.all([this.agent.destroy(error), this.pollAgent.destroy(error)]).then(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// http / https agents
// ---------------------------------------------------------------------------------------------------------------------

type CreateConnection = (options: Record<string, unknown>, callback: (error: Error | null, socket?: Socket) => void) => Socket | undefined;

function guardAgent<T extends http.Agent>(agent: T, guard: EgressGuard, protocol: 'http:' | 'https:'): T {
  const base = (agent as unknown as { createConnection: CreateConnection }).createConnection.bind(agent);
  (agent as unknown as { createConnection: CreateConnection }).createConnection = (options, callback) => {
    const correlation = currentCorrelation();
    const host = normalizeHost(String(options.host ?? options.hostname ?? ''));
    const port = Number(options.port) || (protocol === 'https:' ? 443 : 80);
    const url = new URL(`${protocol}//${isIP(host) === 6 ? `[${host}]` : host}:${port}/`);
    const admitted = guard.admitRequest(url, '/', correlation);
    if (admitted.refusal !== undefined) {
      callback(admitted.refusal);
      return undefined;
    }
    if (isIP(host) !== 0) {
      const category = localEndpointFor(guard.inventory, host, port) !== undefined ? undefined : classifyAddress(host);
      if (category !== undefined && guard.mode === 'enforce') {
        callback(new EgressRefusedError('denied-range', category));
        return undefined;
      }
    }
    return base({ ...options, lookup: guard.lookup }, callback);
  };
  return agent;
}

// ---------------------------------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------------------------------

/** The settings of an existing agent, passed explicitly so the replacement behaves the same. */
function agentSettingsOf(agent: http.Agent): http.AgentOptions {
  const settings = agent as unknown as {
    options?: http.AgentOptions;
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets: number;
    maxFreeSockets: number;
    maxTotalSockets?: number;
    scheduling?: 'fifo' | 'lifo';
  };
  return {
    ...(settings.options ?? {}),
    ...(settings.keepAlive !== undefined ? { keepAlive: settings.keepAlive } : {}),
    ...(settings.keepAliveMsecs !== undefined ? { keepAliveMsecs: settings.keepAliveMsecs } : {}),
    maxSockets: settings.maxSockets,
    maxFreeSockets: settings.maxFreeSockets,
    ...(settings.maxTotalSockets !== undefined ? { maxTotalSockets: settings.maxTotalSockets } : {}),
    ...(settings.scheduling !== undefined ? { scheduling: settings.scheduling } : {}),
  };
}

export interface InstalledEgressGuard {
  readonly guard: EgressGuard;
  /** Restores the previous global dispatcher and agents and stops the diagnostics observer (tests, shutdown). */
  uninstall(): Promise<void>;
}

/**
 * Installs `guard` process-wide: undici's global dispatcher (Node's `fetch`, discord.js REST), the `http`/`https`
 * global agents, and the `undici:request:create` observer. Call it once, before anything opens a connection.
 */
export function installEgressGuard(guard: EgressGuard): InstalledEgressGuard {
  const previousDispatcher = getGlobalDispatcher();
  const previousHttp = http.globalAgent;
  const previousHttps = https.globalAgent;
  const dispatcher = new GuardedDispatcher(guard);
  setGlobalDispatcher(dispatcher);
  // The replacement agents keep the previous global agents' settings (keep-alive, socket limits, options) explicitly.
  http.globalAgent = guardAgent(new http.Agent(agentSettingsOf(previousHttp)), guard, 'http:');
  https.globalAgent = guardAgent(new https.Agent(agentSettingsOf(previousHttps)), guard, 'https:');
  const requestCreate = channel('undici:request:create');
  const onCreate = (message: unknown): void => {
    const request = typeof message === 'object' && message !== null ? (message as { request?: { origin?: unknown } }).request : undefined;
    if (request !== undefined) guard.noticeUnguardedRequest(request.origin);
  };
  requestCreate.subscribe(onCreate);
  return {
    guard,
    async uninstall() {
      requestCreate.unsubscribe(onCreate);
      setGlobalDispatcher(previousDispatcher);
      http.globalAgent = previousHttp;
      https.globalAgent = previousHttps;
      await dispatcher.close().catch(() => undefined);
    },
  };
}
