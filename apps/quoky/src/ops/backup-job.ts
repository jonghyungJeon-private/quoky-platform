import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger } from '@quoky/core';
import type { SqliteBackupFailure, SqliteBackupResult, SqliteCopyRequest } from '@quoky/storage-sqlite';
import { isVectorSnapshotEntryName } from '@quoky/vector-local';
import type {
  VectorSnapshotFailure,
  VectorSnapshotRequest,
  VectorSnapshotResult,
  VectorSnapshotSummary,
} from '@quoky/vector-local';
import { BootstrapPreflightError } from '../bootstrap-preflight';
import {
  BACKUP_KINDS,
  type BackupKind,
  backupFileName,
  isPartialVectorSnapshotName,
  listBackupFiles,
  nextDailyBackupAt,
  parseBackupFileName,
  partialBackupKind,
  partialFileName,
  selectBackupsToKeep,
  vectorSnapshotDbName,
  vectorSnapshotName,
} from './backup-files';

/**
 * Scheduled SQLite backup (ADR-0102 D6, SUB-2): a composition-root lifecycle job with the same shape as the
 * ADR-0101 D6 reminder tick — a non-overlapping, unref'd `setTimeout` chain, started by `main.ts` after storage and
 * the platform are up and stopped first on shutdown. It is not a scheduler for anything else and reaches no provider,
 * connector or tool: its whole surface is the database file, the vector store directory (read only), its backup
 * directory and a failure callback.
 *
 * - **Daily copy** at 04:00 `QUOKY_TIMEZONE`. The chain wakes at most every 15 minutes and compares the wall clock
 *   with the due instant, so a Mac that slept through 04:00 takes the copy soon after waking. At start, when the
 *   newest daily copy is older than 24 hours (or none exists), the first copy is taken 10 minutes after start.
 * - **Pre-migration copy**: `ensurePreMigrationBackup` runs before `storage.init()` (so never while a migration
 *   runs) when the existing database's `user_version` is below this build's latest; a copy that is not verified
 *   refuses the start (ADR-0102 D3: a migration on the host DB requires a fresh verified backup first).
 * - **Manual copy** (`role: 'manual'`, `runManual()`): the on-demand `quokyctl.sh backup --apply`, run by a separate
 *   short-lived process (`tools/backup-now.ts`) while the service keeps running. `VACUUM INTO` reads one consistent
 *   snapshot through a read-only connection; in WAL mode that reader never blocks the service's writer (and the
 *   writer never blocks it), so no restart, signal or IPC is needed.
 * - **Never during a migration**: migrations run only inside `storage.init()` (synchronously), the daily chain is
 *   armed only after it returns, and the ADR-0102 D4 lock rules out a second service process.
 * - **Copy + verify**: claim a temporary `.partial` name exclusively (mode 600), `VACUUM INTO` it, verify read-only
 *   (`integrity_check`, `user_version`), then rename to the final name. A copy that fails anywhere is removed; only
 *   verified copies ever carry a final name. Bounded: one copy + verify may take at most `BACKUP_TIMEOUT_MS`.
 * - **Vector snapshot**: when a vector store path is configured, the same run snapshots it next to the DB copy
 *   (`<stem>.vectors/`, dir 700, files 600; `@quoky/vector-local` `writeVerifiedVectorSnapshot`, verified by size,
 *   SHA-256 and record counts), bounded by its own `BACKUP_TIMEOUT_MS`. The DB copy is the authoritative half: a vector
 *   snapshot that fails is recorded (`vectors.outcome: FAILED`) and logged, but never fails the DB copy, never refuses
 *   a start and sends no notice — the store is a rebuildable cache (see the restore runbook). The DB copy is renamed
 *   first and the snapshot second, so a final snapshot always has its DB copy.
 * - **Directory** mode 700, **files** 600. **Retention** 7 daily + 4 weekly + 3 pre-migration + 5 manual
 *   (`backup-files.ts`); a vector snapshot is pruned with its DB copy. Pruning deletes only the job's own names, only
 *   regular files (and, inside a snapshot directory, only snapshot entries), only after a verified copy. A partial of
 *   another process's kind is removed only once it is older than `PARTIAL_STALE_MS`.
 * - **Status**: `status()` and `backup-status.json` (600) in the backup directory for tools and the OPS-1 screen
 *   (ADR-0113 D6: last backup time, verified yes/no, retained count, next run; file names only). The service owns the
 *   scheduled fields and the manual process owns `lastManual`; each merges the other's fields from the file.
 * - A failed or unverifiable scheduled copy is logged (code only) and reported once through `onFailure`.
 */

export const BACKUP_TIMEOUT_MS = 5 * 60 * 1000;
/** The chain re-reads the wall clock at least this often (timers do not advance while a Mac sleeps). */
export const BACKUP_POLL_MS = 15 * 60 * 1000;
/** First copy after a start when the newest daily copy is older than `BACKUP_STALE_MS` (or none exists). */
export const BACKUP_CATCH_UP_DELAY_MS = 10 * 60 * 1000;
export const BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
/** A partial of another process's kind is left alone until this old (a run takes at most 2 x BACKUP_TIMEOUT_MS). */
export const PARTIAL_STALE_MS = 3 * BACKUP_TIMEOUT_MS;
export const BACKUP_STATUS_FILE = 'backup-status.json';
export const BACKUP_STATUS_SCHEMA = 'quoky.backup-status/1';

/** Why a run did not produce a verified copy (the adapter's classification, or a file-system step here). */
export type BackupRunFailure = SqliteBackupFailure | 'DIRECTORY_UNAVAILABLE' | 'TARGET_EXISTS' | 'FINALIZE_FAILED';

/** Why a run's vector snapshot did not verify. */
export type VectorBackupFailure = VectorSnapshotFailure | 'TIMEOUT' | 'FINALIZE_FAILED' | 'WORKER_FAILED';

export interface VectorBackupRecord {
  readonly outcome: 'VERIFIED' | 'FAILED';
  readonly failure?: VectorBackupFailure;
  /** Directory name only (never a path). */
  readonly dir?: string;
  /** `false`: the store directory did not exist at backup time (an empty snapshot; restore leaves no vectors). */
  readonly storePresent?: boolean;
  readonly collections?: number;
  readonly records?: number;
  /** Source collection files the provider treats as an empty cache (not copied). */
  readonly skippedInvalid?: number;
}

export interface BackupRunRecord {
  readonly kind: BackupKind;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly outcome: 'VERIFIED' | 'FAILED';
  readonly failure?: BackupRunFailure;
  /** File name only (never a path). */
  readonly file?: string;
  /** `user_version` of the verified copy (equal to the source's). */
  readonly userVersion?: number;
  /** The vector half of the backup set; absent when no vector store is configured or the DB copy failed. */
  readonly vectors?: VectorBackupRecord;
}

export interface BackupStatus {
  readonly schema: typeof BACKUP_STATUS_SCHEMA;
  readonly updatedAt: IsoTimestamp;
  readonly enabled: boolean;
  readonly state: BackupJobState;
  /** The last scheduled run (daily / pre-migration), written by the service. */
  readonly lastRun: BackupRunRecord | null;
  /** The last on-demand run (`quokyctl.sh backup --apply`), written by the manual process. */
  readonly lastManual: BackupRunRecord | null;
  /** The newest verified copy. `userVersion` is unknown (absent) for a copy found on disk from an earlier run. */
  readonly lastVerified: {
    readonly at: IsoTimestamp;
    readonly kind: BackupKind;
    readonly file: string;
    readonly userVersion?: number;
    /** Its vector snapshot directory, when one exists. */
    readonly vectors?: string;
  } | null;
  readonly retainedCount: number;
  /** Retained copies, newest first, file names only. */
  readonly retained: readonly string[];
  /** Retained vector snapshots (directory names), newest first. A retained copy without one has no vector snapshot. */
  readonly retainedVectors: readonly string[];
  readonly nextScheduledAt: IsoTimestamp | null;
}

export type BackupJobState = 'IDLE' | 'DISABLED' | 'RUNNING' | 'STOPPED';

export interface BackupJobTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const nodeTimers: BackupJobTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BackupJobDeps {
  /**
   * Scheduled backups on/off. The service job does nothing when off; the manual job (`role: 'manual'`) always runs
   * when asked and only reports this value.
   */
  readonly enabled: boolean;
  /** `service` (default): daily + pre-migration copies. `manual`: the on-demand process (`runManual()`). */
  readonly role?: 'service' | 'manual';
  /** Absolute path of the live database. */
  readonly dbPath: string;
  /** Absolute backup directory. */
  readonly dir: string;
  /** `QUOKY_TIMEZONE`: the 04:00 schedule and the retention days/weeks. */
  readonly timeZone: string;
  /** The adapter's copy + verify (`writeVerifiedSqliteCopy`). */
  readonly copy: (request: SqliteCopyRequest) => Promise<SqliteBackupResult>;
  /** The adapter's read-only `user_version` reader (`readSqliteUserVersion`). */
  readonly readUserVersion: (dbPath: string) => number | undefined;
  /** This build's latest schema version (`LATEST_SCHEMA_VERSION`). */
  readonly latestSchemaVersion: number;
  /** Absolute vector store directory (`QUOKY_VECTOR_PATH`); absent = no vector snapshot. */
  readonly vectorPath?: string;
  /** The vector adapter's snapshot + verify (`writeVerifiedVectorSnapshot`); required with `vectorPath`. */
  readonly snapshotVectors?: (request: VectorSnapshotRequest) => Promise<VectorSnapshotResult>;
  /** Called once per failed or unverifiable scheduled copy (the `OPS_NOTICE`). Must not throw. */
  readonly onFailure?: (record: BackupRunRecord) => void;
  readonly logger: Logger;
  readonly clock?: () => IsoTimestamp;
  readonly timers?: BackupJobTimers;
  readonly timeoutMs?: number;
}

export const BackupErrorCode = {
  BACKUP_PRE_MIGRATION_FAILED: 'BACKUP_PRE_MIGRATION_FAILED',
} as const;

const PRE_MIGRATION_HINT =
  'This build migrates the database schema, which needs a fresh verified backup first (ADR-0102 D3), and the backup ' +
  'did not verify. Check free disk space and the backup directory permissions (see quoky.log for the failure code), ' +
  'then restart.';

const SERVICE_KINDS: ReadonlySet<BackupKind> = new Set<BackupKind>(['daily', 'pre-migration']);
const MANUAL_KINDS: ReadonlySet<BackupKind> = new Set<BackupKind>(['manual']);
const JOB_STATES: ReadonlySet<string> = new Set<BackupJobState>(['IDLE', 'DISABLED', 'RUNNING', 'STOPPED']);

function iso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}

function isKind(value: unknown): value is BackupKind {
  return typeof value === 'string' && (BACKUP_KINDS as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A record read back from `backup-status.json` (another process's); `null` unless it has the expected shape. */
function parseRunRecord(value: unknown): BackupRunRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (!isKind(r.kind) || typeof r.startedAt !== 'string' || typeof r.finishedAt !== 'string') return null;
  if (r.outcome !== 'VERIFIED' && r.outcome !== 'FAILED') return null;
  const vectors = parseVectorRecord(r.vectors);
  return {
    kind: r.kind,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    outcome: r.outcome,
    ...(typeof r.failure === 'string' ? { failure: r.failure as BackupRunFailure } : {}),
    ...(typeof r.file === 'string' && parseBackupFileName(r.file) !== undefined ? { file: r.file } : {}),
    ...(isCount(r.userVersion) ? { userVersion: r.userVersion } : {}),
    ...(vectors !== null ? { vectors } : {}),
  };
}

function parseVectorRecord(value: unknown): VectorBackupRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.outcome !== 'VERIFIED' && v.outcome !== 'FAILED') return null;
  return {
    outcome: v.outcome,
    ...(typeof v.failure === 'string' ? { failure: v.failure as VectorBackupFailure } : {}),
    ...(typeof v.dir === 'string' && vectorSnapshotDbName(v.dir) !== undefined ? { dir: v.dir } : {}),
    ...(typeof v.storePresent === 'boolean' ? { storePresent: v.storePresent } : {}),
    ...(isCount(v.collections) ? { collections: v.collections } : {}),
    ...(isCount(v.records) ? { records: v.records } : {}),
    ...(isCount(v.skippedInvalid) ? { skippedInvalid: v.skippedInvalid } : {}),
  };
}

function parseLastVerified(value: unknown): BackupStatus['lastVerified'] {
  if (typeof value !== 'object' || value === null) return null;
  const lv = value as Record<string, unknown>;
  if (typeof lv.at !== 'string' || !isKind(lv.kind) || typeof lv.file !== 'string') return null;
  if (parseBackupFileName(lv.file) === undefined) return null;
  return {
    at: lv.at,
    kind: lv.kind,
    file: lv.file,
    ...(isCount(lv.userVersion) ? { userVersion: lv.userVersion } : {}),
    ...(typeof lv.vectors === 'string' && vectorSnapshotDbName(lv.vectors) === lv.file ? { vectors: lv.vectors } : {}),
  };
}

/** A vector snapshot that failed (already cleaned up), or one verified in its partial directory awaiting rename. */
type VectorAttempt = { readonly failed: VectorBackupRecord } | { readonly verified: VectorSnapshotSummary };

interface DiskStatus {
  readonly enabled?: boolean;
  readonly state?: BackupJobState;
  readonly lastRun: BackupRunRecord | null;
  readonly lastManual: BackupRunRecord | null;
  readonly lastVerified: BackupStatus['lastVerified'];
  readonly nextScheduledAt: IsoTimestamp | null;
}

function newer(
  a: BackupStatus['lastVerified'],
  b: BackupStatus['lastVerified'],
): BackupStatus['lastVerified'] {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

export class BackupJob {
  private stateValue: BackupJobState = 'IDLE';
  private timer: unknown = undefined;
  private dueMs: number | null = null;
  private inFlight: Promise<BackupRunRecord> | null = null;
  private abort: AbortController | null = null;
  private lastRun: BackupRunRecord | null = null;
  private lastVerified: BackupStatus['lastVerified'] = null;
  private readonly clock: () => IsoTimestamp;
  private readonly timers: BackupJobTimers;
  private readonly timeoutMs: number;
  private readonly role: 'service' | 'manual';
  private readonly ownKinds: ReadonlySet<BackupKind>;

  constructor(private readonly deps: BackupJobDeps) {
    this.clock = deps.clock ?? sharedClock;
    this.timers = deps.timers ?? nodeTimers;
    this.timeoutMs = deps.timeoutMs ?? BACKUP_TIMEOUT_MS;
    this.role = deps.role ?? 'service';
    this.ownKinds = this.role === 'manual' ? MANUAL_KINDS : SERVICE_KINDS;
    if (!deps.enabled && this.role === 'service') this.stateValue = 'DISABLED';
  }

  get state(): BackupJobState {
    return this.stateValue;
  }

  /**
   * The merged view: this job's own fields, the other process's fields from `backup-status.json`, the newest verified
   * copy of either, and the retained copies as they are on disk now.
   */
  status(): BackupStatus {
    const disk = this.readStatusFile();
    const { retained, retainedVectors } = this.scanRetained();
    const lastVerified = newer(this.lastVerified, disk?.lastVerified ?? null);
    const service = this.role === 'service';
    return {
      schema: BACKUP_STATUS_SCHEMA,
      updatedAt: this.clock(),
      enabled: service ? this.deps.enabled : (disk?.enabled ?? this.deps.enabled),
      state: service ? this.stateValue : (disk?.state ?? (this.deps.enabled ? 'IDLE' : 'DISABLED')),
      lastRun: service ? this.lastRun : (disk?.lastRun ?? null),
      lastManual: service ? (disk?.lastManual ?? null) : this.lastRun,
      lastVerified,
      retainedCount: retained.length,
      retained,
      retainedVectors,
      nextScheduledAt: service ? (this.dueMs === null ? null : iso(this.dueMs)) : (disk?.nextScheduledAt ?? null),
    };
  }

  /**
   * Before `storage.init()`: when the existing database is below this build's schema, take and verify a
   * pre-migration copy, or refuse the start. Disabled, absent database, current or ahead schema → nothing to do.
   */
  async ensurePreMigrationBackup(): Promise<'DISABLED' | 'NO_DATABASE' | 'NOT_NEEDED' | 'VERIFIED'> {
    if (!this.deps.enabled || this.role !== 'service') return 'DISABLED';
    let version: number | undefined;
    try {
      version = this.deps.readUserVersion(this.deps.dbPath);
    } catch {
      this.deps.logger.error('backup.pre_migration.failed', { failure: 'SOURCE_UNREADABLE' });
      throw new BootstrapPreflightError(BackupErrorCode.BACKUP_PRE_MIGRATION_FAILED, PRE_MIGRATION_HINT);
    }
    if (version === undefined) return 'NO_DATABASE';
    if (version >= this.deps.latestSchemaVersion) return 'NOT_NEEDED';
    this.deps.logger.info('backup.pre_migration.started', { from: version, to: this.deps.latestSchemaVersion });
    const record = await this.run('pre-migration');
    if (record.outcome !== 'VERIFIED') {
      throw new BootstrapPreflightError(BackupErrorCode.BACKUP_PRE_MIGRATION_FAILED, PRE_MIGRATION_HINT);
    }
    return 'VERIFIED';
  }

  /** The on-demand copy (`role: 'manual'` only): one verified DB copy + vector snapshot, pruned and recorded. */
  async runManual(): Promise<BackupRunRecord> {
    if (this.role !== 'manual') throw new Error('runManual needs role "manual"');
    this.refreshLastVerified();
    return this.run('manual');
  }

  /**
   * Arm the daily chain (after `storage.init()` and the platform start). Idempotent; a no-op when disabled, stopped or
   * the manual role. Never throws.
   */
  start(): boolean {
    if (this.role !== 'service') return false;
    if (this.stateValue !== 'IDLE') return this.stateValue === 'RUNNING';
    this.stateValue = 'RUNNING';
    this.refreshLastVerified();
    const nowMs = Date.parse(this.clock());
    const newestDaily = listBackupFiles(this.scanRetained().retained).find((f) => f.kind === 'daily');
    const stale = newestDaily === undefined || nowMs - newestDaily.takenAtMs > BACKUP_STALE_MS;
    this.dueMs = stale ? nowMs + BACKUP_CATCH_UP_DELAY_MS : nextDailyBackupAt(nowMs, this.deps.timeZone);
    this.arm(nowMs);
    this.writeStatus();
    this.deps.logger.info('backup.schedule.started', { nextScheduledAt: iso(this.dueMs) });
    return true;
  }

  /** Disarm the chain and abort an in-flight copy (its partial files are removed). Idempotent; never throws. */
  async stop(): Promise<void> {
    if (this.stateValue === 'RUNNING') this.stateValue = 'STOPPED';
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dueMs = null;
    this.abort?.abort();
    const pending = this.inFlight;
    if (pending !== null) await pending.catch(() => undefined);
  }

  /** Resolves once no copy is in flight (tests and shutdown observability). */
  async idle(): Promise<void> {
    while (this.inFlight !== null) await this.inFlight.catch(() => undefined);
  }

  private arm(nowMs: number): void {
    if (this.stateValue !== 'RUNNING' || this.dueMs === null) return;
    const delay = Math.max(1_000, Math.min(this.dueMs - nowMs, BACKUP_POLL_MS));
    const handle = this.timers.setTimeout(() => this.onTimer(), delay);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.timer = handle;
  }

  private onTimer(): void {
    this.timer = undefined;
    if (this.stateValue !== 'RUNNING' || this.dueMs === null) return;
    const nowMs = Date.parse(this.clock());
    if (nowMs < this.dueMs) {
      this.arm(nowMs);
      return;
    }
    void this.run('daily').then((record) => {
      if (this.stateValue !== 'RUNNING') return;
      if (record.outcome !== 'VERIFIED') this.reportFailure(record);
      const after = Date.parse(this.clock());
      this.dueMs = nextDailyBackupAt(after, this.deps.timeZone);
      this.writeStatus();
      this.arm(after);
    });
  }

  private reportFailure(record: BackupRunRecord): void {
    try {
      this.deps.onFailure?.(record);
    } catch {
      // The notice path never breaks the chain.
    }
  }

  /** One copy, single-flight. Never rejects. */
  private run(kind: BackupKind): Promise<BackupRunRecord> {
    if (this.inFlight !== null) return this.inFlight;
    const work = this.copyOnce(kind).finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    this.inFlight = work;
    return work;
  }

  private async copyOnce(kind: BackupKind): Promise<BackupRunRecord> {
    const startedAt = this.clock();
    const fail = (failure: BackupRunFailure): BackupRunRecord => this.record({ kind, startedAt, outcome: 'FAILED', failure });

    try {
      this.ensureDirectory();
    } catch {
      return fail('DIRECTORY_UNAVAILABLE');
    }
    const finalName = backupFileName(kind, Date.parse(startedAt));
    const finalPath = path.join(this.deps.dir, finalName);
    const partialPath = path.join(this.deps.dir, partialFileName(finalName));
    const vectorName = vectorSnapshotName(finalName);
    const vectorPath = path.join(this.deps.dir, vectorName);
    const vectorPartialPath = path.join(this.deps.dir, partialFileName(vectorName));
    if (existsSync(finalPath) || existsSync(vectorPath)) return fail('TARGET_EXISTS');
    // Claim the partial name exclusively (mode 600 from the first byte): a second run in the same second, in this or
    // another process, gets TARGET_EXISTS instead of sharing the file. `VACUUM INTO` accepts an empty target.
    try {
      closeSync(openSync(partialPath, 'wx', 0o600));
    } catch {
      return fail('TARGET_EXISTS');
    }

    const abort = new AbortController();
    this.abort = abort;
    try {
      let result: SqliteBackupResult;
      try {
        result = await this.deps.copy({
          sourcePath: this.deps.dbPath,
          targetPath: partialPath,
          timeoutMs: this.timeoutMs,
          signal: abort.signal,
        });
      } catch {
        result = { ok: false, failure: 'WORKER_FAILED' };
      }
      if (!result.ok) {
        this.removePartial(partialPath);
        return fail(result.failure);
      }

      const snapshot = await this.snapshotVectors(vectorName, vectorPartialPath, abort.signal);
      if (abort.signal.aborted) {
        this.removePartial(partialPath);
        this.removeVectorDir(vectorPartialPath);
        return fail('ABORTED');
      }
      try {
        chmodSync(partialPath, 0o600);
        renameSync(partialPath, finalPath);
      } catch {
        this.removePartial(partialPath);
        this.removeVectorDir(vectorPartialPath);
        return fail('FINALIZE_FAILED');
      }
      const vectors = snapshot === undefined ? undefined : this.finalizeVectors(snapshot, vectorPartialPath, vectorPath, vectorName);
      const record = this.record({
        kind,
        startedAt,
        outcome: 'VERIFIED',
        file: finalName,
        userVersion: result.userVersion,
        ...(vectors !== undefined ? { vectors } : {}),
      });
      this.lastVerified = {
        at: startedAt,
        kind,
        file: finalName,
        userVersion: result.userVersion,
        ...(vectors?.outcome === 'VERIFIED' ? { vectors: vectorName } : {}),
      };
      this.prune();
      this.writeStatus();
      return record;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  /** The vector half, written to its partial directory; `undefined` when no vector store is configured. */
  private async snapshotVectors(
    vectorName: string,
    partialDir: string,
    jobSignal: AbortSignal,
  ): Promise<VectorAttempt | undefined> {
    const { vectorPath, snapshotVectors } = this.deps;
    if (vectorPath === undefined || snapshotVectors === undefined) return undefined;
    const bound = new AbortController();
    let timedOut = false;
    const onJobAbort = (): void => bound.abort();
    jobSignal.addEventListener('abort', onJobAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      bound.abort();
    }, this.timeoutMs);
    timer.unref?.();
    let result: VectorSnapshotResult;
    try {
      result = await snapshotVectors({ sourceDir: vectorPath, targetDir: partialDir, signal: bound.signal });
    } catch {
      result = { ok: false, failure: 'COPY_FAILED' };
    } finally {
      clearTimeout(timer);
      jobSignal.removeEventListener('abort', onJobAbort);
    }
    if (!result.ok) {
      this.removeVectorDir(partialDir);
      const failure: VectorBackupFailure = result.failure === 'ABORTED' && timedOut ? 'TIMEOUT' : result.failure;
      this.deps.logger.error('backup.vectors.failed', { dir: vectorName, failure });
      return { failed: { outcome: 'FAILED', failure } };
    }
    return { verified: result };
  }

  /** Rename a verified vector snapshot to its final name (after the DB copy's rename). */
  private finalizeVectors(attempt: VectorAttempt, partialDir: string, finalDir: string, vectorName: string): VectorBackupRecord {
    if ('failed' in attempt) return attempt.failed;
    try {
      chmodSync(partialDir, 0o700);
      renameSync(partialDir, finalDir);
    } catch {
      this.removeVectorDir(partialDir);
      this.deps.logger.error('backup.vectors.failed', { dir: vectorName, failure: 'FINALIZE_FAILED' });
      return { outcome: 'FAILED', failure: 'FINALIZE_FAILED' };
    }
    const { storePresent, collections, records, skippedInvalid } = attempt.verified;
    return { outcome: 'VERIFIED', dir: vectorName, storePresent, collections, records, skippedInvalid };
  }

  private record(fields: Omit<BackupRunRecord, 'finishedAt'>): BackupRunRecord {
    const record: BackupRunRecord = { ...fields, finishedAt: this.clock() };
    this.lastRun = record;
    if (record.outcome === 'VERIFIED') {
      this.deps.logger.info('backup.verified', {
        kind: record.kind,
        file: record.file,
        userVersion: record.userVersion,
        ...(record.vectors !== undefined
          ? { vectors: record.vectors.outcome, vectorRecords: record.vectors.records }
          : {}),
      });
    } else {
      this.deps.logger.error('backup.failed', { kind: record.kind, failure: record.failure });
      this.writeStatus();
    }
    return record;
  }

  private ensureDirectory(): void {
    mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.deps.dir, 0o700);
  }

  private removePartial(partialPath: string): void {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        unlinkSync(`${partialPath}${suffix}`);
      } catch {
        // absent: nothing to remove
      }
    }
  }

  /**
   * Remove a snapshot directory of the job's own naming: only a real directory (never a symlink), only the snapshot
   * entries inside it that are regular files, then the directory itself. Something foreign inside keeps it.
   */
  private removeVectorDir(dirPath: string): boolean {
    try {
      if (!lstatSync(dirPath).isDirectory()) return false;
    } catch {
      return true; // absent
    }
    let names: string[] = [];
    try {
      names = readdirSync(dirPath);
    } catch {
      return false;
    }
    for (const name of names) {
      const entry = path.join(dirPath, name);
      try {
        if (isVectorSnapshotEntryName(name) && lstatSync(entry).isFile()) unlinkSync(entry);
      } catch {
        // best effort
      }
    }
    try {
      rmdirSync(dirPath);
      return true;
    } catch {
      return false;
    }
  }

  private listNames(): string[] {
    try {
      return readdirSync(this.deps.dir);
    } catch {
      return [];
    }
  }

  private isRegularFile(name: string): boolean {
    try {
      return lstatSync(path.join(this.deps.dir, name)).isFile();
    } catch {
      return false;
    }
  }

  private isDirectory(name: string): boolean {
    try {
      return lstatSync(path.join(this.deps.dir, name)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Retained = the job's own final copies that are regular files, newest first, and their snapshot directories. */
  private scanRetained(): { retained: string[]; retainedVectors: string[] } {
    const names = this.listNames();
    const files = listBackupFiles(names.filter((n) => this.isRegularFile(n)));
    const retained = files.map((f) => f.name);
    const vectorNames = new Set(names.filter((n) => vectorSnapshotDbName(n) !== undefined && this.isDirectory(n)));
    const retainedVectors = retained.map(vectorSnapshotName).filter((n) => vectorNames.has(n));
    return { retained, retainedVectors };
  }

  /** After a restart, the newest copy on disk is the last verified one (only verified copies get a final name). */
  private refreshLastVerified(): void {
    if (this.lastVerified !== null) return;
    const { retained, retainedVectors } = this.scanRetained();
    const newest = listBackupFiles(retained)[0];
    if (newest === undefined) return;
    const previous = this.readStatusFile()?.lastVerified ?? null;
    if (previous !== null && previous.file === newest.name) {
      this.lastVerified = previous;
      return;
    }
    const vectors = vectorSnapshotName(newest.name);
    this.lastVerified = {
      at: iso(newest.takenAtMs),
      kind: newest.kind,
      file: newest.name,
      ...(retainedVectors.includes(vectors) ? { vectors } : {}),
    };
  }

  /** The other process's fields from `backup-status.json`; `null` when absent or not this schema. */
  private readStatusFile(): DiskStatus | null {
    let raw: string;
    try {
      raw = readFileSync(path.join(this.deps.dir, BACKUP_STATUS_FILE), 'utf8');
    } catch {
      return null;
    }
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value !== 'object' || value === null || value.schema !== BACKUP_STATUS_SCHEMA) return null;
      return {
        ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
        ...(typeof value.state === 'string' && JOB_STATES.has(value.state) ? { state: value.state as BackupJobState } : {}),
        lastRun: parseRunRecord(value.lastRun),
        lastManual: parseRunRecord(value.lastManual),
        lastVerified: parseLastVerified(value.lastVerified),
        nextScheduledAt: typeof value.nextScheduledAt === 'string' ? value.nextScheduledAt : null,
      };
    } catch {
      return null;
    }
  }

  private isStalePartial(name: string): boolean {
    try {
      return lstatSync(path.join(this.deps.dir, name)).mtimeMs < Date.parse(this.clock()) - PARTIAL_STALE_MS;
    } catch {
      return false;
    }
  }

  /**
   * Delete what retention does not keep, orphaned snapshots and stale partials. Only the job's own names; only
   * regular files (snapshot directories: see `removeVectorDir`). A partial of another process's kind may be a run in
   * progress there, so it is removed only once it is older than `PARTIAL_STALE_MS`.
   */
  private prune(): void {
    const names = this.listNames();
    const files = listBackupFiles(names.filter((n) => this.isRegularFile(n)));
    const keep = selectBackupsToKeep(files, this.deps.timeZone);
    for (const file of files) {
      if (keep.has(file.name)) continue;
      try {
        unlinkSync(path.join(this.deps.dir, file.name));
        this.deps.logger.info('backup.pruned', { file: file.name });
      } catch {
        this.deps.logger.warn('backup.prune_failed', { file: file.name });
      }
    }
    for (const name of names) {
      const dbName = vectorSnapshotDbName(name);
      if (dbName === undefined || keep.has(dbName) || !this.isDirectory(name)) continue;
      if (this.removeVectorDir(path.join(this.deps.dir, name))) this.deps.logger.info('backup.pruned', { file: name });
      else this.deps.logger.warn('backup.prune_failed', { file: name });
    }
    for (const name of names) {
      const kind = partialBackupKind(name);
      if (kind === undefined) continue;
      if (!this.ownKinds.has(kind) && !this.isStalePartial(name)) continue;
      if (isPartialVectorSnapshotName(name)) {
        if (this.isDirectory(name)) this.removeVectorDir(path.join(this.deps.dir, name));
        continue;
      }
      if (!this.isRegularFile(name)) continue;
      try {
        unlinkSync(path.join(this.deps.dir, name));
      } catch {
        // best effort
      }
    }
  }

  private writeStatus(): void {
    if (!this.deps.enabled && this.role === 'service') return;
    const target = path.join(this.deps.dir, BACKUP_STATUS_FILE);
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      this.ensureDirectory();
      writeFileSync(tmp, `${JSON.stringify(this.status(), null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch {
      this.deps.logger.warn('backup.status_write_failed');
    }
  }
}
