import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger } from '@quoky/core';
import type { SqliteBackupFailure, SqliteBackupResult, SqliteCopyRequest } from '@quoky/storage-sqlite';
import { BootstrapPreflightError } from '../bootstrap-preflight';
import {
  type BackupKind,
  backupFileName,
  isPartialBackupFileName,
  listBackupFiles,
  nextDailyBackupAt,
  partialFileName,
  selectBackupsToKeep,
} from './backup-files';

/**
 * Scheduled SQLite backup (ADR-0102 D6, SUB-2): a composition-root lifecycle job with the same shape as the
 * ADR-0101 D6 reminder tick — a non-overlapping, unref'd `setTimeout` chain, started by `main.ts` after storage and
 * the platform are up and stopped first on shutdown. It is not a scheduler for anything else and reaches no provider,
 * connector or tool: its whole surface is the database file, its backup directory and a failure callback.
 *
 * - **Daily copy** at 04:00 `QUOKY_TIMEZONE`. The chain wakes at most every 15 minutes and compares the wall clock
 *   with the due instant, so a Mac that slept through 04:00 takes the copy soon after waking. At start, when the
 *   newest daily copy is older than 24 hours (or none exists), the first copy is taken 10 minutes after start.
 * - **Pre-migration copy**: `ensurePreMigrationBackup` runs before `storage.init()` (so never while a migration
 *   runs) when the existing database's `user_version` is below this build's latest; a copy that is not verified
 *   refuses the start (ADR-0102 D3: a migration on the host DB requires a fresh verified backup first).
 * - **Never during a migration**: migrations run only inside `storage.init()` (synchronously), the daily chain is
 *   armed only after it returns, and the ADR-0102 D4 lock rules out a second process.
 * - **Copy + verify**: `VACUUM INTO` a temporary `.partial` name, verify read-only (`integrity_check`,
 *   `user_version`), chmod 600, then rename to the final name. A copy that fails anywhere is removed; only verified
 *   copies ever carry a final name. Bounded: one copy + verify may take at most `BACKUP_TIMEOUT_MS`.
 * - **Directory** mode 700, **files** 600. **Retention** 7 daily + 4 weekly + 3 pre-migration
 *   (`backup-files.ts`); pruning deletes only the job's own names, only regular files, only after a verified copy.
 * - **Status**: `status()` in process, and `backup-status.json` (600) in the backup directory for tools and the
 *   OPS-1 screen (ADR-0113 D6: last backup time, verified yes/no, retained count, next run; file names only).
 * - A failed or unverifiable copy is logged (code only) and reported once through `onFailure` (the `OPS_NOTICE`).
 */

export const BACKUP_TIMEOUT_MS = 5 * 60 * 1000;
/** The chain re-reads the wall clock at least this often (timers do not advance while a Mac sleeps). */
export const BACKUP_POLL_MS = 15 * 60 * 1000;
/** First copy after a start when the newest daily copy is older than `BACKUP_STALE_MS` (or none exists). */
export const BACKUP_CATCH_UP_DELAY_MS = 10 * 60 * 1000;
export const BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
export const BACKUP_STATUS_FILE = 'backup-status.json';
export const BACKUP_STATUS_SCHEMA = 'quoky.backup-status/1';

/** Why a run did not produce a verified copy (the adapter's classification, or a file-system step here). */
export type BackupRunFailure = SqliteBackupFailure | 'DIRECTORY_UNAVAILABLE' | 'TARGET_EXISTS' | 'FINALIZE_FAILED';

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
}

export interface BackupStatus {
  readonly schema: typeof BACKUP_STATUS_SCHEMA;
  readonly updatedAt: IsoTimestamp;
  readonly enabled: boolean;
  readonly state: BackupJobState;
  readonly lastRun: BackupRunRecord | null;
  /** The newest verified copy. `userVersion` is unknown (absent) for a copy found on disk from an earlier run. */
  readonly lastVerified: {
    readonly at: IsoTimestamp;
    readonly kind: BackupKind;
    readonly file: string;
    readonly userVersion?: number;
  } | null;
  readonly retainedCount: number;
  /** Retained copies, newest first, file names only. */
  readonly retained: readonly string[];
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
  readonly enabled: boolean;
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

function iso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}

export class BackupJob {
  private stateValue: BackupJobState = 'IDLE';
  private timer: unknown = undefined;
  private dueMs: number | null = null;
  private inFlight: Promise<BackupRunRecord> | null = null;
  private abort: AbortController | null = null;
  private lastRun: BackupRunRecord | null = null;
  private lastVerified: BackupStatus['lastVerified'] = null;
  private retained: string[] = [];
  private readonly clock: () => IsoTimestamp;
  private readonly timers: BackupJobTimers;
  private readonly timeoutMs: number;

  constructor(private readonly deps: BackupJobDeps) {
    this.clock = deps.clock ?? sharedClock;
    this.timers = deps.timers ?? nodeTimers;
    this.timeoutMs = deps.timeoutMs ?? BACKUP_TIMEOUT_MS;
    if (!deps.enabled) this.stateValue = 'DISABLED';
  }

  get state(): BackupJobState {
    return this.stateValue;
  }

  status(): BackupStatus {
    return {
      schema: BACKUP_STATUS_SCHEMA,
      updatedAt: this.clock(),
      enabled: this.deps.enabled,
      state: this.stateValue,
      lastRun: this.lastRun,
      lastVerified: this.lastVerified,
      retainedCount: this.retained.length,
      retained: [...this.retained],
      nextScheduledAt: this.dueMs === null ? null : iso(this.dueMs),
    };
  }

  /**
   * Before `storage.init()`: when the existing database is below this build's schema, take and verify a
   * pre-migration copy, or refuse the start. Disabled, absent database, current or ahead schema → nothing to do.
   */
  async ensurePreMigrationBackup(): Promise<'DISABLED' | 'NO_DATABASE' | 'NOT_NEEDED' | 'VERIFIED'> {
    if (!this.deps.enabled) return 'DISABLED';
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

  /**
   * Arm the daily chain (after `storage.init()` and the platform start). Idempotent; a no-op when disabled or
   * stopped. Never throws.
   */
  start(): boolean {
    if (this.stateValue !== 'IDLE') return this.stateValue === 'RUNNING';
    this.stateValue = 'RUNNING';
    this.refreshRetained();
    const nowMs = Date.parse(this.clock());
    const newestDaily = listBackupFiles(this.retained).find((f) => f.kind === 'daily');
    const stale = newestDaily === undefined || nowMs - newestDaily.takenAtMs > BACKUP_STALE_MS;
    this.dueMs = stale ? nowMs + BACKUP_CATCH_UP_DELAY_MS : nextDailyBackupAt(nowMs, this.deps.timeZone);
    this.arm(nowMs);
    this.writeStatus();
    this.deps.logger.info('backup.schedule.started', { nextScheduledAt: iso(this.dueMs) });
    return true;
  }

  /** Disarm the chain and abort an in-flight copy (its partial file is removed). Idempotent; never throws. */
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
    if (existsSync(finalPath)) return fail('TARGET_EXISTS');
    this.removePartial(partialPath);

    const abort = new AbortController();
    this.abort = abort;
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
    } finally {
      if (this.abort === abort) this.abort = null;
    }
    if (!result.ok) {
      this.removePartial(partialPath);
      return fail(result.failure);
    }
    try {
      chmodSync(partialPath, 0o600);
      renameSync(partialPath, finalPath);
    } catch {
      this.removePartial(partialPath);
      return fail('FINALIZE_FAILED');
    }
    const record = this.record({ kind, startedAt, outcome: 'VERIFIED', file: finalName, userVersion: result.userVersion });
    this.lastVerified = { at: startedAt, kind, file: finalName, userVersion: result.userVersion };
    this.prune();
    this.writeStatus();
    return record;
  }

  private record(fields: Omit<BackupRunRecord, 'finishedAt'>): BackupRunRecord {
    const record: BackupRunRecord = { ...fields, finishedAt: this.clock() };
    this.lastRun = record;
    if (record.outcome === 'VERIFIED') {
      this.deps.logger.info('backup.verified', { kind: record.kind, file: record.file, userVersion: record.userVersion });
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

  /** Retained = the job's own final copies that are regular files, newest first. */
  private refreshRetained(): void {
    const files = listBackupFiles(this.listNames().filter((n) => this.isRegularFile(n)));
    this.retained = files.map((f) => f.name);
    if (this.lastVerified === null) {
      // After a restart, the newest copy on disk is the last verified one (only verified copies get a final name).
      this.lastVerified = this.readPreviousLastVerified(files[0]?.name);
      const newest = files[0];
      if (this.lastVerified === null && newest !== undefined) {
        this.lastVerified = { at: iso(newest.takenAtMs), kind: newest.kind, file: newest.name };
      }
    }
  }

  /** The previous status file's `lastVerified`, when it still names the newest copy on disk. */
  private readPreviousLastVerified(newestName: string | undefined): BackupStatus['lastVerified'] {
    if (newestName === undefined) return null;
    try {
      const previous = JSON.parse(readFileSync(path.join(this.deps.dir, BACKUP_STATUS_FILE), 'utf8')) as Partial<BackupStatus>;
      const lv = previous.lastVerified;
      if (previous.schema !== BACKUP_STATUS_SCHEMA || lv === null || lv === undefined || lv.file !== newestName) return null;
      if (typeof lv.at !== 'string' || (lv.kind !== 'daily' && lv.kind !== 'pre-migration')) return null;
      return {
        at: lv.at,
        kind: lv.kind,
        file: lv.file,
        ...(typeof lv.userVersion === 'number' ? { userVersion: lv.userVersion } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Delete what retention does not keep, and stale partials. Only the job's own names; only regular files. */
  private prune(): void {
    const names = this.listNames().filter((n) => this.isRegularFile(n));
    const files = listBackupFiles(names);
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
      if (!isPartialBackupFileName(name)) continue;
      try {
        unlinkSync(path.join(this.deps.dir, name));
      } catch {
        // best effort
      }
    }
    this.refreshRetained();
  }

  private writeStatus(): void {
    if (!this.deps.enabled) return;
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
