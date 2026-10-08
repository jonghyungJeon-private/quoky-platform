/**
 * On-demand backup (ADR-0102 D6 follow-up): the separate short-lived process behind `quokyctl.sh backup`.
 *
 *   node apps/quoky/dist/tools/backup-now.js --dry-run         what a copy would write and prune (read-only)
 *   node apps/quoky/dist/tools/backup-now.js --apply           take a verified `manual` copy + vector snapshot now
 *   node apps/quoky/dist/tools/backup-now.js --verify <name>   re-verify a retained copy and its vector snapshot
 *
 * It runs while the service keeps running, without a restart, signal or IPC: the DB copy is `VACUUM INTO` from a
 * read-only connection on a worker thread, which in WAL mode reads one consistent snapshot while the service's writer
 * keeps committing: ordinary WAL commits continue while the copy reads, but a checkpoint cannot pass the reader's
 * snapshot, so checkpoints may be delayed (and the WAL may grow) until the copy ends; the copy's connection itself
 * waits up to 5 s on a lock (busy timeout). The copy never writes to the live database, takes no
 * instance lock and never runs a migration. The vector store is only read (each collection file is replaced by an
 * atomic rename, so every read sees one complete version). Same partial → verify → rename flow, names, permissions
 * (dir 700, files 600) and status file as the scheduled job (`ops/backup-job.ts`, `role: 'manual'`), kind `manual`
 * (the 5 newest are kept).
 *
 * Configuration: the tool never reads `.env.local` (or any env file). It uses the effective, non-secret configuration
 * the running service publishes at start (`<db dir>/ops/backup-config.json`, `ops/backup-config.ts`: backup directory,
 * enabled, time zone, DB and vector paths), read with the private-file checks. When that file is missing, invalid or
 * for another database (the service has not started with this build yet), it falls back to the defaults
 * (`resolveDataPaths`, `<db dir>/backups`, the default time zone) from the process environment and prints a notice.
 * `quokyctl.sh backup` passes only the service's DB and vector paths (the launcher's own helpers). Every run holds the
 * backup lock (an OS-held SQLite exclusive lock, released by the kernel if the process dies), shared with the
 * service's runs.
 *
 * Exit codes: 0 ok; 1 the DB copy failed (nothing kept), or `--verify` failed; 2 usage; 3 blocked (no database,
 * invalid configuration, not a retained copy, another backup run holds the lock); 4 the DB copy verified but its vector
 * snapshot did not (the DB copy is kept).
 */
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, LogFields, Logger } from '@quoky/core';
import {
  LATEST_SCHEMA_VERSION,
  readSqliteUserVersion,
  tryAcquireExclusiveLock,
  verifySqliteBackupFile,
  writeVerifiedSqliteCopy,
} from '@quoky/storage-sqlite';
import type { SqliteBackupResult, SqliteCopyRequest } from '@quoky/storage-sqlite';
import {
  inspectVectorStore,
  verifyVectorSnapshot,
  writeVerifiedVectorSnapshot,
} from '@quoky/vector-local';
import type { VectorSnapshotRequest, VectorSnapshotResult, VectorStoreInspection } from '@quoky/vector-local';
import { BootstrapPreflightError } from '../bootstrap-preflight';
import { resolveDataPaths } from '../config';
import { backupConfigPath, readBackupConfig } from '../ops/backup-config';
import { BackupJob, type BackupRunRecord } from '../ops/backup-job';
import {
  BACKUP_RETENTION,
  backupFileName,
  listBackupFiles,
  parseBackupFileName,
  selectBackupsToKeep,
  vectorSnapshotName,
} from '../ops/backup-files';
import { loadOpsConfig } from '../ops/ops-config';
import { parseReminderConfig } from '../reminders/reminder-config';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_VECTORS_FAILED = 4;

const HELP = [
  'usage: backup-now (--dry-run | --apply | --verify <quoky-<UTC stamp>-<kind>.db>)',
  '  --dry-run   show the copy and the vector snapshot it would write and what retention would prune (read-only)',
  '  --apply     take a verified manual copy of the database and a verified vector snapshot now',
  '  --verify    re-verify a retained copy (integrity_check, user_version) and its vector snapshot (restore drill)',
].join('\n');

export interface BackupNowDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly clock?: () => IsoTimestamp;
  /** Fault-injection seams; production passes none. */
  readonly copy?: (request: SqliteCopyRequest) => Promise<SqliteBackupResult>;
  readonly snapshotVectors?: (request: VectorSnapshotRequest) => Promise<VectorSnapshotResult>;
}

const silentLogger: Logger = {
  info: (_message: string, _fields?: LogFields) => undefined,
  warn: (_message: string, _fields?: LogFields) => undefined,
  error: (_message: string, _fields?: LogFields) => undefined,
};

interface Resolved {
  readonly dbPath: string;
  readonly vectorPath?: string;
  readonly dir: string;
  readonly timeZone: string;
  readonly scheduledEnabled: boolean;
}

type Args = { mode: 'dry-run' } | { mode: 'apply' } | { mode: 'verify'; name: string };

function parseArgs(argv: readonly string[]): Args | null {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (args.length === 1 && args[0] === '--dry-run') return { mode: 'dry-run' };
  if (args.length === 1 && args[0] === '--apply') return { mode: 'apply' };
  if (args.length === 2 && args[0] === '--verify' && typeof args[1] === 'string') return { mode: 'verify', name: args[1] };
  return null;
}

/** The defaults, from the process environment only (what `resolveDataPaths`/`loadOpsConfig` give the service). */
function resolveDefaults(env: NodeJS.ProcessEnv): Resolved {
  const { dbPath, vectorPath } = resolveDataPaths(env);
  const ops = loadOpsConfig(env, {
    dbPath,
    ...(vectorPath !== '' ? { vectorPath } : {}),
    ...(env.QUOKY_LAUNCHER === 'launchd' ? { launcher: 'launchd' as const } : {}),
  });
  const { timeZone } = parseReminderConfig(env);
  return {
    dbPath: ops.backup.dbPath,
    ...(ops.backup.vectorPath !== undefined ? { vectorPath: ops.backup.vectorPath } : {}),
    dir: ops.backup.dir,
    timeZone,
    scheduledEnabled: ops.backup.enabled,
  };
}

/**
 * The service's published backup configuration (`<db dir>/ops/backup-config.json`) when it is readable, valid and for
 * this database; otherwise the defaults, with a notice. `.env.local` is never read.
 */
function resolveConfig(env: NodeJS.ProcessEnv, notice: (line: string) => void): Resolved {
  const defaults = resolveDefaults(env);
  if (defaults.dbPath === '' || defaults.dbPath === ':memory:') return defaults;
  const file = backupConfigPath(defaults.dbPath);
  const read = readBackupConfig(file);
  const reason = !read.ok ? read.reason : path.resolve(read.config.dbPath) !== defaults.dbPath ? 'OTHER_DATABASE' : undefined;
  if (read.ok && reason === undefined) {
    const { config } = read;
    return {
      dbPath: defaults.dbPath,
      ...(config.vectorPath !== null ? { vectorPath: config.vectorPath } : {}),
      dir: config.backupDir,
      timeZone: config.timeZone,
      scheduledEnabled: config.enabled,
    };
  }
  notice(
    `note:  no usable service backup config at ${file} (${reason ?? 'INVALID'}); using the defaults ` +
      `(backups in ${defaults.dir}, time zone ${defaults.timeZone}). Start the service once with this build so a ` +
      'QUOKY_BACKUP_DIR or QUOKY_TIMEZONE set in .env.local applies here (this tool never reads .env.local).',
  );
  return defaults;
}

function describeInspection(inspection: VectorStoreInspection): string {
  if (!inspection.ok) return `unreadable (${inspection.failure}): the snapshot would fail; the DB copy would still be kept`;
  if (!inspection.storePresent) return 'absent (semantic recall has not written yet): an empty snapshot';
  const skipped = inspection.skippedInvalid > 0 ? `, ${inspection.skippedInvalid} unusable collection file(s) skipped` : '';
  return `${inspection.collections} collection(s), ${inspection.records} record(s)${skipped}`;
}

function describeVectors(record: BackupRunRecord['vectors']): string {
  if (record === undefined) return 'not configured (no vector store path): DB-only copy';
  if (record.outcome === 'FAILED') return `FAILED (${record.failure ?? 'unknown'})`;
  const absent = record.storePresent === false ? ', store absent at backup time' : '';
  return `verified ${record.dir ?? ''} (${record.collections ?? 0} collection(s), ${record.records ?? 0} record(s)${absent})`;
}

/** What a manual copy taken now would prune afterwards (retention applied to the directory plus the new copy). */
function prunePreview(dir: string, newName: string, timeZone: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => {
      try {
        return lstatSync(path.join(dir, n)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const files = listBackupFiles([...names, newName]);
  const keep = selectBackupsToKeep(files, timeZone);
  return files.filter((f) => !keep.has(f.name)).map((f) => f.name);
}

export const MISSING_VECTOR_SNAPSHOT_GUIDANCE = [
  'no vector snapshot for this copy (taken before vector snapshots existed, or its snapshot failed).',
  'Restore the DB copy alone and move the current vectors/ directory aside (do not keep it): the store then starts',
  'empty and semantic recall rebuilds itself from the restored memories. Until a memory is re-embedded (at most 4 per',
  'turn, only for memories a turn considers) it is ranked lexically; recall stays correct because a stored vector is',
  'used only when its memory id and content hash match the restored memory.',
];

export async function runCli(argv: readonly string[], deps: BackupNowDeps): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.stdout(HELP);
    return EXIT_OK;
  }
  const args = parseArgs(argv);
  if (args === null) {
    deps.stderr(HELP);
    return EXIT_USAGE;
  }

  let resolved: Resolved;
  try {
    resolved = resolveConfig(deps.env, deps.stdout);
  } catch (error) {
    const code = error instanceof BootstrapPreflightError ? error.code : (error as { code?: unknown }).code;
    const hint = error instanceof BootstrapPreflightError ? `: ${error.hint}` : '';
    deps.stderr(`BLOCKED: configuration ${typeof code === 'string' ? code : 'invalid'}${hint}`);
    return EXIT_BLOCKED;
  }
  const { dbPath, vectorPath, dir, timeZone } = resolved;
  if (dbPath === '' || dbPath === ':memory:') {
    deps.stderr('BLOCKED: the database is not a file (QUOKY_DB_PATH); there is nothing to back up');
    return EXIT_BLOCKED;
  }

  if (args.mode === 'verify') return verify(args.name, resolved, deps);

  let userVersion: number | undefined;
  try {
    userVersion = readSqliteUserVersion(dbPath);
  } catch {
    deps.stderr(`BLOCKED: the database at ${dbPath} cannot be read; nothing was written`);
    return EXIT_BLOCKED;
  }
  if (userVersion === undefined) {
    deps.stderr(`BLOCKED: no database at ${dbPath}; there is nothing to back up`);
    return EXIT_BLOCKED;
  }

  if (args.mode === 'dry-run') {
    const clock = deps.clock ?? sharedClock;
    const name = backupFileName('manual', Date.parse(clock()));
    deps.stdout(`database:   ${dbPath} (user_version ${userVersion})`);
    deps.stdout(
      `vectors:    ${vectorPath === undefined ? 'not configured: DB-only copy' : `${vectorPath}: ${describeInspection(await inspectVectorStore(vectorPath))}`}`,
    );
    deps.stdout(`backup dir: ${dir} (mode 700; files 600)`);
    if (!resolved.scheduledEnabled) deps.stdout('note:  scheduled backups are off (QUOKY_BACKUP_ENABLED); a manual copy still runs');
    deps.stdout(`plan:  write ${name} (VACUUM INTO a .partial name, verify integrity_check + user_version, rename)`);
    if (vectorPath !== undefined) {
      deps.stdout(`plan:  write ${vectorSnapshotName(name)}/ (copy each collection, verify size + SHA-256 + record counts, rename)`);
    }
    const pruned = prunePreview(dir, name, timeZone);
    deps.stdout(
      `plan:  keep the ${BACKUP_RETENTION.manual} newest manual copies; prune ${pruned.length === 0 ? 'nothing' : pruned.join(', ')} (and their vector snapshots)`,
    );
    deps.stdout('note:  the service keeps running: the copy only reads the database and the vector store');
    return EXIT_OK;
  }

  const job = new BackupJob({
    role: 'manual',
    enabled: resolved.scheduledEnabled,
    dbPath,
    dir,
    timeZone,
    copy: deps.copy ?? writeVerifiedSqliteCopy,
    readUserVersion: readSqliteUserVersion,
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    tryLock: tryAcquireExclusiveLock,
    ...(vectorPath !== undefined
      ? { vectorPath, snapshotVectors: deps.snapshotVectors ?? writeVerifiedVectorSnapshot }
      : {}),
    logger: silentLogger,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  const record = await job.runManual();
  if (record.failure === 'BACKUP_IN_PROGRESS') {
    deps.stderr('BLOCKED: another backup run (manual or scheduled) holds the backup lock; nothing was written');
    return EXIT_BLOCKED;
  }
  if (record.outcome !== 'VERIFIED') {
    deps.stderr(`FAILED: the manual copy did not verify (${record.failure ?? 'unknown'}); nothing was kept`);
    return EXIT_FAILED;
  }
  const status = job.status();
  deps.stdout(`backup:  verified ${record.file ?? ''} (user_version ${record.userVersion ?? '?'}) in ${dir}`);
  deps.stdout(`vectors: ${describeVectors(record.vectors)}`);
  deps.stdout(`retained: ${status.retainedCount} copies, ${status.retainedVectors.length} with a vector snapshot`);
  if (record.vectors?.outcome === 'FAILED') {
    deps.stderr('WARNING: the DB copy is kept, but its vector snapshot failed; see the restore runbook for a copy without one');
    return EXIT_VECTORS_FAILED;
  }
  return EXIT_OK;
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

async function verify(name: string, resolved: Resolved, deps: BackupNowDeps): Promise<number> {
  if (parseBackupFileName(name) === undefined) {
    deps.stderr('BLOCKED: --verify takes a copy name such as quoky-20261007T190000Z-daily.db (see backup-status.json)');
    return EXIT_BLOCKED;
  }
  const copyPath = path.join(resolved.dir, name);
  if (!existsSync(copyPath) && !isSymlink(copyPath)) {
    deps.stderr(`BLOCKED: ${name} is not in ${resolved.dir}`);
    return EXIT_BLOCKED;
  }
  if (isSymlink(resolved.dir) || isSymlink(copyPath) || !lstatSync(copyPath).isFile()) {
    deps.stderr(`FAILED: ${name} (or the backup directory) is a symlink or not a regular file; do not restore it`);
    return EXIT_FAILED;
  }
  const db = verifySqliteBackupFile(copyPath);
  if (!db.ok) {
    deps.stderr(`FAILED: ${name} did not verify (${db.failure}); do not restore it`);
    return EXIT_FAILED;
  }
  deps.stdout(`database: ${name} ok (integrity_check ok, user_version ${db.userVersion})`);
  const snapshotName = vectorSnapshotName(name);
  const snapshotPath = path.join(resolved.dir, snapshotName);
  if (!existsSync(snapshotPath) && !isSymlink(snapshotPath)) {
    deps.stdout(`vectors:  ${MISSING_VECTOR_SNAPSHOT_GUIDANCE[0]}`);
    for (const line of MISSING_VECTOR_SNAPSHOT_GUIDANCE.slice(1)) deps.stdout(`          ${line}`);
    return EXIT_OK;
  }
  const vectors = await verifyVectorSnapshot(snapshotPath);
  if (!vectors.ok) {
    deps.stderr(`FAILED: ${snapshotName} did not verify (${vectors.failure}); restore the DB copy and treat it as having no snapshot`);
    return EXIT_FAILED;
  }
  const absent = vectors.storePresent ? '' : '; the store was absent at backup time, so the restored store is empty';
  deps.stdout(`vectors:  ${snapshotName} ok (${vectors.collections} collection(s), ${vectors.records} record(s)${absent})`);
  deps.stdout('restore:  this copy and its vector snapshot are a matching set; restore both (quickstart section 7)');
  return EXIT_OK;
}

if (require.main === module) {
  void runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_FAILED;
    },
  );
}
