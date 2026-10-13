import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { now } from '@quoky/core';
import type { Logger } from '@quoky/core';
import type { TrafficInitiator } from '../correlation-context';
import { isoWithOffset, localDateKey } from './iso-time';

/**
 * The traffic and volume ledger (ADR-0121 D8, design §5.4, MSIT ⑤-2/⑤-3/⑤-4).
 *
 * **Where:** `<data dir>/audit/egress-YYYY-MM-DD.jsonl` (the data dir is the directory of `QUOKY_DB_PATH`; the date is
 * the host-local date). When a day's file reaches the size cap the ledger continues in `egress-YYYY-MM-DD.1.jsonl`,
 * `.2`, … up to {@link LEDGER_MAX_PARTS_PER_DAY} parts; after that the day's further records are dropped and one warning
 * is logged. Files older than the retention (default 90 days) are deleted at start and at each day change. Directory
 * mode 0700, file mode 0600. Append-only: a record is never rewritten.
 *
 * **What:** one JSON object per line, schema `v: 1`, in three kinds (see {@link LedgerRecord}). A record holds a host
 * name, a budget label, a method, a path TEMPLATE (`egress-policy.ts` `pathTemplate`: no query, ids replaced by
 * `{id}`), a status, byte counts, a latency, the pinned IP of a new connection, and the content-free turn correlation
 * id. It never holds a header, a token, a query string, a body, a full URL or an error message.
 *
 * A ledger write failure never affects the request; it is logged once (by code) and the ledger keeps trying.
 */

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_FILE_PREFIX = 'egress-';
export const LEDGER_DIR_NAME = 'audit';
export const DEFAULT_LEDGER_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const LEDGER_MAX_PARTS_PER_DAY = 4;
export const DEFAULT_LEDGER_RETENTION_DAYS = 90;

/** Small-request threshold and burst rule of the design (§5.4): ≥ 20 requests under 2 KB to one host in 5 minutes. */
export const SMALL_REQUEST_BYTES = 2048;
export const SMALL_BURST_COUNT = 20;
export const SHORT_WINDOW_MS = 5 * 60_000;
export const LONG_WINDOW_MS = 24 * 60 * 60_000;

export type GuardEventName =
  | 'new-destination'
  | 'denied-range'
  | 'ip-literal'
  | 'insecure-scheme'
  | 'budget-exceeded'
  | 'backoff-open'
  | 'volume-alert'
  | 'repeated-small'
  | 'unguarded-request';

export interface RecordBase {
  readonly v: typeof LEDGER_SCHEMA_VERSION;
  /** ISO-8601, host-local with offset. */
  readonly ts: string;
  /** Turn/tick correlation id, `null` outside one. */
  readonly cid: string | null;
  readonly initiator: TrafficInitiator;
  /** Lowercase destination host name (or IP literal). */
  readonly host: string;
  /** Budget label (`egress-policy.ts` `labelFor`), `unlisted` when not on the allowlist. */
  readonly label: string;
}

/** One finished (or refused) outbound HTTP request. */
export interface LedgerRequestRecord extends RecordBase {
  readonly kind: 'request';
  readonly method: string;
  readonly path: string;
  /** HTTP status, `null` when there was no answer (refused, network error). */
  readonly status: number | null;
  /** `2xx` … `5xx`, or `none`. */
  readonly statusClass: string;
  /** Request body bytes written to the socket. */
  readonly bytesUp: number;
  /** Response body bytes read from the socket (wire bytes, before decompression). */
  readonly bytesDown: number;
  readonly latencyMs: number;
  /** `ok` = answered (any status), `error` = no answer, `refused` = blocked by the guard in `enforce`. */
  readonly outcome: 'ok' | 'error' | 'refused';
  readonly mode: 'observe' | 'enforce';
}

/** One new connection: the resolved address that was checked and pinned (for the self-check's IP → host mapping). */
export interface LedgerConnectRecord extends RecordBase {
  readonly kind: 'connect';
  readonly ip: string | null;
  readonly port: number;
  readonly outcome: 'pinned' | 'refused';
}

/** A guard finding (`observed` in `observe`, `blocked` in `enforce` when it refused the request). */
export interface LedgerGuardRecord extends RecordBase {
  readonly kind: 'guard';
  readonly event: GuardEventName;
  /** A fixed code: the deny category, the budget refusal reason, `down`/`up`, … never free text. */
  readonly detail: string;
  readonly mode: 'observe' | 'enforce';
  readonly action: 'observed' | 'blocked';
}

export type LedgerRecord = LedgerRequestRecord | LedgerConnectRecord | LedgerGuardRecord;

/** The sink the guard writes to (the file ledger in production, an array in tests). */
export interface LedgerSink {
  append(record: LedgerRecord): void;
}

export interface TrafficLedgerOptions {
  /** `<data dir>/audit`. */
  readonly dir: string;
  readonly maxFileBytes?: number;
  readonly retentionDays?: number;
  readonly clock?: () => Date;
  readonly logger?: Logger;
}

const FILE_NAME = /^egress-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

/** The append-only JSONL file ledger. */
export class TrafficLedger implements LedgerSink {
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private readonly clock: () => Date;
  private day = '';
  private part = 0;
  private size = 0;
  private droppedToday = false;
  private failureLogged = false;

  constructor(private readonly options: TrafficLedgerOptions) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_LEDGER_MAX_FILE_BYTES;
    this.retentionDays = options.retentionDays ?? DEFAULT_LEDGER_RETENTION_DAYS;
    this.clock = options.clock ?? (() => new Date(now()));
  }

  /** The file a record written now goes to (tests and the startup log). */
  currentFile(): string {
    this.roll(localDateKey(this.clock()));
    return this.fileFor(this.day, this.part);
  }

  append(record: LedgerRecord): void {
    try {
      this.roll(localDateKey(this.clock()));
      const line = `${JSON.stringify(record)}\n`;
      const length = Buffer.byteLength(line);
      if (this.size > 0 && this.size + length > this.maxFileBytes) {
        if (this.part + 1 >= LEDGER_MAX_PARTS_PER_DAY) {
          if (!this.droppedToday) {
            this.droppedToday = true;
            this.options.logger?.warn('egress.ledger.cap_reached', { maxFileBytes: this.maxFileBytes, parts: LEDGER_MAX_PARTS_PER_DAY });
          }
          return;
        }
        this.part += 1;
        this.size = this.sizeOf(this.fileFor(this.day, this.part));
      }
      const fd = openSync(this.fileFor(this.day, this.part), 'a', 0o600);
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
      this.size += length;
    } catch (error) {
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.options.logger?.warn('egress.ledger.write_failed', { errorCode: errorCodeOf(error) });
      }
    }
  }

  /** Deletes ledger files older than the retention. Runs at start and at each day change. */
  prune(): void {
    let names: string[];
    try {
      names = readdirSync(this.options.dir);
    } catch {
      return;
    }
    const cutoff = new Date(this.clock().getTime() - this.retentionDays * LONG_WINDOW_MS);
    const cutoffKey = localDateKey(cutoff);
    for (const name of names) {
      const match = FILE_NAME.exec(name);
      if (match === null || (match[1] ?? '') >= cutoffKey) continue;
      try {
        unlinkSync(path.join(this.options.dir, name));
      } catch {
        // A file that cannot be removed now is retried at the next day change.
      }
    }
  }

  private roll(day: string): void {
    if (day === this.day) return;
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.options.dir, 0o700);
    } catch {
      // Best effort on a directory the process does not own.
    }
    this.day = day;
    this.droppedToday = false;
    // Continue in the last existing part of the day (a restart appends, never truncates).
    let part = 0;
    while (part + 1 < LEDGER_MAX_PARTS_PER_DAY && this.sizeOf(this.fileFor(day, part + 1)) > 0) part += 1;
    this.part = part;
    this.size = this.sizeOf(this.fileFor(day, part));
    this.prune();
  }

  private fileFor(day: string, part: number): string {
    return path.join(this.options.dir, `${LEDGER_FILE_PREFIX}${day}${part === 0 ? '' : `.${part}`}.jsonl`);
  }

  private sizeOf(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }
}

function errorCodeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'UNKNOWN';
}

/** Builds the common fields of a record. */
export function recordBase(
  clock: () => Date,
  correlation: { readonly cid: string; readonly initiator: TrafficInitiator } | undefined,
  host: string,
  label: string,
): RecordBase {
  return {
    v: LEDGER_SCHEMA_VERSION,
    ts: isoWithOffset(clock()),
    cid: correlation?.cid ?? null,
    initiator: correlation?.initiator ?? 'background',
    host,
    label,
  };
}

export function statusClassOf(status: number | null): string {
  if (status === null || status < 100 || status > 599) return 'none';
  return `${Math.floor(status / 100)}xx`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cumulative summary (MSIT ⑤-4): short (5 min) and long (24 h) windows per destination host.
// ---------------------------------------------------------------------------------------------------------------------

export interface WindowTotals {
  readonly requests: number;
  readonly bytesUp: number;
  readonly bytesDown: number;
  /** Requests whose up + down bytes were under {@link SMALL_REQUEST_BYTES}. */
  readonly small: number;
  /** Small requests that were not part of an owner turn (the "repeated small queries" signal). */
  readonly smallOutsideOwnerTurn: number;
  readonly refused: number;
}

export interface HostSummary {
  readonly host: string;
  readonly labels: readonly string[];
  readonly short: WindowTotals;
  readonly long: WindowTotals;
  /** ≥ {@link SMALL_BURST_COUNT} small requests outside an owner turn within the short window. */
  readonly repeatedSmall: boolean;
}

interface MutableTotals {
  requests: number;
  bytesUp: number;
  bytesDown: number;
  small: number;
  smallOutsideOwnerTurn: number;
  refused: number;
}

const emptyTotals = (): MutableTotals => ({ requests: 0, bytesUp: 0, bytesDown: 0, small: 0, smallOutsideOwnerTurn: 0, refused: 0 });

function addTo(totals: MutableTotals, record: LedgerRequestRecord): void {
  totals.requests += 1;
  totals.bytesUp += record.bytesUp;
  totals.bytesDown += record.bytesDown;
  if (record.outcome === 'refused') totals.refused += 1;
  if (record.bytesUp + record.bytesDown < SMALL_REQUEST_BYTES) {
    totals.small += 1;
    if (record.initiator !== 'owner-turn') totals.smallOutsideOwnerTurn += 1;
  }
}

/**
 * Summarizes request records per host over the short (5 min) and long (24 h) windows ending at `nowMs`. Pure: the
 * self-check and the live guard both use it. Records whose `ts` cannot be parsed are ignored.
 */
export function summarizeTraffic(records: Iterable<LedgerRecord>, nowMs: number): HostSummary[] {
  const byHost = new Map<string, { labels: Set<string>; short: MutableTotals; long: MutableTotals }>();
  for (const record of records) {
    if (record.kind !== 'request') continue;
    const at = Date.parse(record.ts);
    if (Number.isNaN(at) || at > nowMs || at <= nowMs - LONG_WINDOW_MS) continue;
    let entry = byHost.get(record.host);
    if (entry === undefined) {
      entry = { labels: new Set(), short: emptyTotals(), long: emptyTotals() };
      byHost.set(record.host, entry);
    }
    entry.labels.add(record.label);
    addTo(entry.long, record);
    if (at > nowMs - SHORT_WINDOW_MS) addTo(entry.short, record);
  }
  return [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, entry]) => ({
      host,
      labels: [...entry.labels].sort(),
      short: { ...entry.short },
      long: { ...entry.long },
      repeatedSmall: entry.short.smallOutsideOwnerTurn >= SMALL_BURST_COUNT,
    }));
}

/**
 * The live short-window detector the guard feeds with each request record: it reports a host once per short window
 * when it crosses the repeated-small threshold. Memory is bounded to the last 5 minutes of small requests.
 */
export class SmallRequestBurstDetector {
  private readonly recent = new Map<string, number[]>();
  private readonly reportedAt = new Map<string, number>();

  /** Returns true when this record makes `host` cross the threshold (and it was not reported in the last window). */
  observe(record: LedgerRequestRecord, nowMs: number): boolean {
    if (record.initiator === 'owner-turn' || record.bytesUp + record.bytesDown >= SMALL_REQUEST_BYTES) return false;
    const since = nowMs - SHORT_WINDOW_MS;
    const times = (this.recent.get(record.host) ?? []).filter((at) => at > since);
    times.push(nowMs);
    this.recent.set(record.host, times);
    if (times.length < SMALL_BURST_COUNT) return false;
    const last = this.reportedAt.get(record.host);
    if (last !== undefined && last > since) return false;
    this.reportedAt.set(record.host, nowMs);
    return true;
  }
}
