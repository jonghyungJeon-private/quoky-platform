import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

export { LATEST_SCHEMA_VERSION } from './migrations';

/**
 * SQLite online backup primitives (ADR-0102 D6, SUB-2). The composition root owns the schedule, file naming,
 * retention and notices; this adapter module owns the only SQL involved, so no driver type leaves the package:
 *
 * - `readSqliteUserVersion` reads a database's `user_version` through a read-only connection (the pre-migration
 *   check runs it before `storage.init()`).
 * - `writeVerifiedSqliteCopy` writes a `VACUUM INTO` snapshot of the source (read-only connection: a consistent
 *   snapshot, no write to the source) and then verifies the copy read-only (`PRAGMA integrity_check` must be exactly
 *   `ok`, and the copy's `user_version` must equal the source's). Both steps run on a worker thread, so a large
 *   database never stalls the event loop (the Discord gateway and the reminder tick keep running), and the caller's
 *   wait is bounded by `timeoutMs`: on expiry the worker is terminated and the result is `TIMEOUT` (an abort signal
 *   does the same on shutdown, `ABORTED`). A terminated copy may leave a partial target file; the caller writes to a
 *   temporary name and removes it.
 *
 * Results are classified, never thrown, and carry codes only: no path, SQL text or driver message.
 */

export type SqliteBackupFailure =
  /** The source could not be opened or read. */
  | 'SOURCE_UNREADABLE'
  /** `VACUUM INTO` failed (target exists, disk full, I/O error, ...). */
  | 'COPY_FAILED'
  /** The copy could not be opened, or `integrity_check` did not return exactly `ok`. */
  | 'INTEGRITY_FAILED'
  /** The copy's `user_version` differs from the source's. */
  | 'USER_VERSION_MISMATCH'
  /** The bounded wait elapsed; the worker was terminated. */
  | 'TIMEOUT'
  /** The caller aborted (shutdown); the worker was terminated. */
  | 'ABORTED'
  /** The worker died without a result. */
  | 'WORKER_FAILED';

export type SqliteBackupResult =
  | { readonly ok: true; readonly userVersion: number }
  | { readonly ok: false; readonly failure: SqliteBackupFailure };

export interface SqliteCopyRequest {
  /** The live database file. Opened read-only. */
  readonly sourcePath: string;
  /** Where the copy is written. Must not exist yet (`VACUUM INTO` refuses an existing non-empty file). */
  readonly targetPath: string;
  /** Upper bound of the whole copy + verify. */
  readonly timeoutMs: number;
  /** Lock wait of the read-only source connection. */
  readonly busyTimeoutMs?: number;
  /** Aborting terminates the worker and resolves `ABORTED` (used on shutdown). */
  readonly signal?: AbortSignal;
}

const DEFAULT_BACKUP_BUSY_TIMEOUT_MS = 5_000;

/**
 * The database's `user_version`, read through a read-only connection; `undefined` when the file does not exist.
 * Throws only when an existing file cannot be read (the caller fails closed).
 */
export function readSqliteUserVersion(dbPath: string): number | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: DEFAULT_BACKUP_BUSY_TIMEOUT_MS });
  try {
    return Number(db.pragma('user_version', { simple: true })) || 0;
  } finally {
    db.close();
  }
}

/**
 * Verify an existing backup copy read-only (the restore drill, `backup-now --verify`): `PRAGMA integrity_check` must be
 * exactly `ok`. Returns the copy's `user_version`. A symlink or non-regular file is refused (`SOURCE_UNREADABLE`). A `VACUUM INTO` copy is in rollback-journal mode, so a read-only
 * open creates no `-wal`/`-shm` file next to it. Synchronous (a short-lived tool, never the service). Never throws.
 */
export function verifySqliteBackupFile(copyPath: string): SqliteBackupResult {
  // A copy is a regular file of the backup job; a symlink (or anything else) is refused, never followed.
  try {
    if (!lstatSync(copyPath).isFile()) return { ok: false, failure: 'SOURCE_UNREADABLE' };
  } catch {
    return { ok: false, failure: 'SOURCE_UNREADABLE' };
  }
  let copy: Database.Database | undefined;
  try {
    copy = new Database(copyPath, { readonly: true, fileMustExist: true, timeout: DEFAULT_BACKUP_BUSY_TIMEOUT_MS });
    const rows = copy.pragma('integrity_check') as Array<{ integrity_check?: unknown }>;
    const ok = Array.isArray(rows) && rows.length === 1 && rows[0]?.integrity_check === 'ok';
    if (!ok) return { ok: false, failure: 'INTEGRITY_FAILED' };
    return { ok: true, userVersion: Number(copy.pragma('user_version', { simple: true })) || 0 };
  } catch {
    return { ok: false, failure: 'INTEGRITY_FAILED' };
  } finally {
    try {
      copy?.close();
    } catch {
      // closing a read-only handle cannot lose data
    }
  }
}

export type ExclusiveLockResult =
  | { readonly ok: true; readonly release: () => void }
  /** `BUSY`: another holder (this process or another) has the lock. `UNAVAILABLE`: the lock directory or file is unusable. */
  | { readonly ok: false; readonly failure: 'BUSY' | 'UNAVAILABLE' };

/** Lock paths this process holds. A second acquire in the same process returns `BUSY` without opening anything. */
const heldInThisProcess = new Set<string>();

/**
 * The lock's directory must be a real directory (not a symlink, realpath = parent's realpath + its name), mode 700 and
 * owned by this user. The lock file's safety is bound to this directory: under the owner-only threat model, a same-user
 * process that can write inside a 700 directory could already tamper with the backups themselves, so it is out of scope.
 */
function isPrivateRealDirectory(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    if ((stat.mode & 0o777) !== 0o700) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    const resolved = resolve(dir);
    return realpathSync(dir) === join(realpathSync(dirname(resolved)), basename(resolved));
  } catch {
    return false;
  }
}

/**
 * An OS-held exclusive lock on a dedicated lock database (serializes backup runs across processes): a connection with
 * `busy_timeout = 0` runs `PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE` and is held until `release()`. SQLite's
 * lock is an fcntl lock, which the kernel drops when the process dies, so a crashed holder never leaves a stale lock:
 * there is no pid, age or takeover rule.
 *
 * Only SQLite ever opens the lock file: POSIX drops a process's fcntl locks when *any* descriptor of that file is closed
 * in the process, so this function never opens or closes it itself, and a second acquire while this process already
 * holds the lock returns `BUSY` at once (a process-wide guard) without touching the file. The directory must be a
 * private real directory (`isPrivateRealDirectory`); the file is created by SQLite inside it (its mode follows the
 * umask; the directory is what keeps it private, and it holds no data). These checks are not TOCTOU-free: a same-user
 * process that can write inside the directory could swap the file between the check and the open, which the owner-only
 * threat model leaves out of scope. Never throws.
 */
export function tryAcquireExclusiveLock(lockPath: string): ExclusiveLockResult {
  const key = resolve(lockPath);
  if (heldInThisProcess.has(key)) return { ok: false, failure: 'BUSY' };
  if (!isPrivateRealDirectory(dirname(key))) return { ok: false, failure: 'UNAVAILABLE' };
  try {
    const stat = lstatSync(key);
    if (!stat.isFile()) return { ok: false, failure: 'UNAVAILABLE' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, failure: 'UNAVAILABLE' };
  }
  let db: Database.Database;
  try {
    db = new Database(key, { timeout: 0 });
  } catch {
    return { ok: false, failure: 'UNAVAILABLE' };
  }
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    try {
      db.close();
    } catch {
      // nothing held
    }
    const code = (error as { code?: unknown }).code;
    return { ok: false, failure: typeof code === 'string' && code.startsWith('SQLITE_BUSY') ? 'BUSY' : 'UNAVAILABLE' };
  }
  heldInThisProcess.add(key);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        // closing releases the lock anyway
      }
      try {
        db.close();
      } catch {
        // the process exit releases it at the latest
      }
      heldInThisProcess.delete(key);
    },
  };
}

/**
 * Worker body (CommonJS, evaluated): copy, then verify. It posts exactly one `{ ok, ... }` message. The driver is
 * resolved by the parent from this package's own dependency, so the worker loads the same native module.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driverPath);
function run() {
  let source;
  let userVersion;
  try {
    source = new Database(workerData.sourcePath, { readonly: true, fileMustExist: true, timeout: workerData.busyTimeoutMs });
    userVersion = Number(source.pragma('user_version', { simple: true })) || 0;
  } catch (e) {
    try { if (source) source.close(); } catch (_) {}
    return { ok: false, failure: 'SOURCE_UNREADABLE' };
  }
  try {
    source.prepare('VACUUM INTO ?').run(workerData.targetPath);
  } catch (e) {
    return { ok: false, failure: 'COPY_FAILED' };
  } finally {
    try { source.close(); } catch (_) {}
  }
  let copy;
  try {
    copy = new Database(workerData.targetPath, { readonly: true, fileMustExist: true });
    const rows = copy.pragma('integrity_check');
    const okRows = Array.isArray(rows) && rows.length === 1 && rows[0] && rows[0].integrity_check === 'ok';
    if (!okRows) return { ok: false, failure: 'INTEGRITY_FAILED' };
    const copyVersion = Number(copy.pragma('user_version', { simple: true })) || 0;
    if (copyVersion !== userVersion) return { ok: false, failure: 'USER_VERSION_MISMATCH' };
    return { ok: true, userVersion };
  } catch (e) {
    return { ok: false, failure: 'INTEGRITY_FAILED' };
  } finally {
    try { if (copy) copy.close(); } catch (_) {}
  }
}
parentPort.postMessage(run());
`;

const KNOWN_FAILURES: ReadonlySet<string> = new Set<SqliteBackupFailure>([
  'SOURCE_UNREADABLE',
  'COPY_FAILED',
  'INTEGRITY_FAILED',
  'USER_VERSION_MISMATCH',
  'TIMEOUT',
  'ABORTED',
  'WORKER_FAILED',
]);

function toResult(message: unknown): SqliteBackupResult {
  const value = message as { ok?: unknown; userVersion?: unknown; failure?: unknown } | null;
  if (value?.ok === true && typeof value.userVersion === 'number' && Number.isSafeInteger(value.userVersion)) {
    return { ok: true, userVersion: value.userVersion };
  }
  if (value?.ok === false && typeof value.failure === 'string' && KNOWN_FAILURES.has(value.failure)) {
    return { ok: false, failure: value.failure as SqliteBackupFailure };
  }
  return { ok: false, failure: 'WORKER_FAILED' };
}

/** Copy (`VACUUM INTO`) and verify, on a worker thread, within `timeoutMs`. Never throws. */
export function writeVerifiedSqliteCopy(request: SqliteCopyRequest): Promise<SqliteBackupResult> {
  return new Promise<SqliteBackupResult>((resolve) => {
    if (request.signal?.aborted) {
      resolve({ ok: false, failure: 'ABORTED' });
      return;
    }
    let settled = false;
    let worker: Worker | undefined;
    const onAbort = (): void => stopWith('ABORTED');
    const finish = (result: SqliteBackupResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const stopWith = (failure: SqliteBackupFailure): void => {
      finish({ ok: false, failure });
      void worker?.terminate().catch(() => undefined);
    };
    const timer = setTimeout(() => stopWith('TIMEOUT'), request.timeoutMs);
    timer.unref?.();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          driverPath: createRequire(__filename).resolve('better-sqlite3'),
          sourcePath: request.sourcePath,
          targetPath: request.targetPath,
          busyTimeoutMs: request.busyTimeoutMs ?? DEFAULT_BACKUP_BUSY_TIMEOUT_MS,
        },
      });
    } catch {
      finish({ ok: false, failure: 'WORKER_FAILED' });
      return;
    }
    // The worker stays referenced: before the platform starts (the pre-migration copy) it may be the only thing
    // keeping the process alive while `main.ts` awaits it. Shutdown aborts it (`signal`), and `process.exit` ends it.
    worker.once('message', (message) => finish(toResult(message)));
    worker.once('error', () => finish({ ok: false, failure: 'WORKER_FAILED' }));
    worker.once('exit', () => finish({ ok: false, failure: 'WORKER_FAILED' }));
  });
}
