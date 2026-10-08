import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  SqliteStorageProvider,
  readSqliteUserVersion,
  writeVerifiedSqliteCopy,
} from '@quoky/storage-sqlite';
import type { SqliteBackupResult, SqliteCopyRequest } from '@quoky/storage-sqlite';
import { LocalVectorProvider, writeVerifiedVectorSnapshot } from '@quoky/vector-local';
import type { VectorSnapshotRequest, VectorSnapshotResult } from '@quoky/vector-local';
import type { LogFields, Logger } from '@quoky/core';
import { describeStartupFailure } from '../bootstrap-preflight';
import { QuokyExitCode, startupExitCode } from './exit-codes';
import {
  BACKUP_CATCH_UP_DELAY_MS,
  BACKUP_POLL_MS,
  BACKUP_STATUS_FILE,
  BackupErrorCode,
  BackupJob,
  type BackupJobDeps,
  type BackupJobTimers,
  type BackupRunRecord,
} from './backup-job';
import { backupFileName, partialFileName, vectorSnapshotName } from './backup-files';

const SEOUL = 'Asia/Seoul';
// 2026-10-06 10:00 KST
const T0 = Date.parse('2026-10-06T01:00:00.000Z');

class ManualTimers implements BackupJobTimers {
  private nextId = 1;
  clockMs = T0;
  readonly pending = new Map<number, { callback: () => void; dueAt: number; ms: number; unrefed: boolean }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    const entry = { callback, dueAt: this.clockMs + ms, ms, unrefed: false };
    this.pending.set(id, entry);
    return { id, unref: () => { entry.unrefed = true; } };
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete((handle as { id: number }).id);
  }
  now = (): string => new Date(this.clockMs).toISOString();
  next(): { dueAt: number; ms: number; unrefed: boolean } | undefined {
    return [...this.pending.values()].sort((a, b) => a.dueAt - b.dueAt)[0];
  }
  fireNext(): boolean {
    const next = [...this.pending.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
    if (next === undefined) return false;
    this.pending.delete(next[0]);
    this.clockMs = Math.max(this.clockMs, next[1].dueAt);
    next[1].callback();
    return true;
  }
}

class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ level: 'error', message, fields }); }
  messages(): string[] { return this.lines.map((l) => l.message); }
}

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('BackupJob (ADR-0102 D6)', () => {
  let root: string;
  let dbPath: string;
  let dir: string;
  let timers: ManualTimers;
  let logger: RecordingLogger;
  let failures: BackupRunRecord[];

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'quoky-backup-job-'));
    dbPath = path.join(root, 'quoky.db');
    dir = path.join(root, 'backups');
    timers = new ManualTimers();
    logger = new RecordingLogger();
    failures = [];
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    await storage.close();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function job(overrides: Partial<BackupJobDeps> = {}): BackupJob {
    return new BackupJob({
      enabled: true,
      dbPath,
      dir,
      timeZone: SEOUL,
      copy: writeVerifiedSqliteCopy,
      readUserVersion: readSqliteUserVersion,
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
      onFailure: (record) => failures.push(record),
      logger,
      clock: timers.now,
      timers,
      ...overrides,
    });
  }

  /** Fire timers until a copy has run (the chain polls at most every 15 minutes). */
  async function fireUntilRun(backup: BackupJob, maxFires = 200): Promise<void> {
    const before = backup.status().lastRun;
    for (let i = 0; i < maxFires; i += 1) {
      timers.fireNext();
      await backup.idle();
      // let the post-run continuation (status, re-arm) settle
      await new Promise((r) => setImmediate(r));
      if (backup.status().lastRun !== before) return;
    }
    throw new Error('no backup ran');
  }

  it('takes a verified copy: VACUUM INTO, integrity_check + user_version, dir 700, file 600, status file', async () => {
    const backup = job();
    expect(backup.start()).toBe(true);
    // No copy yet: the first one is a catch-up 10 minutes after start, polled.
    expect(backup.status().nextScheduledAt).toBe(new Date(T0 + BACKUP_CATCH_UP_DELAY_MS).toISOString());
    expect(timers.next()?.unrefed).toBe(true);
    await fireUntilRun(backup);

    const name = backupFileName('daily', T0 + BACKUP_CATCH_UP_DELAY_MS);
    expect(readdirSync(dir).sort()).toEqual([BACKUP_STATUS_FILE, name].sort());
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, name))).toBe(0o600);
    expect(mode(path.join(dir, BACKUP_STATUS_FILE))).toBe(0o600);
    expect(readSqliteUserVersion(path.join(dir, name))).toBe(LATEST_SCHEMA_VERSION);

    const status = JSON.parse(readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'));
    expect(status).toMatchObject({
      schema: 'quoky.backup-status/1',
      enabled: true,
      state: 'RUNNING',
      lastRun: { kind: 'daily', outcome: 'VERIFIED', file: name, userVersion: LATEST_SCHEMA_VERSION },
      lastVerified: { kind: 'daily', file: name, userVersion: LATEST_SCHEMA_VERSION },
      retainedCount: 1,
      retained: [name],
      // next: 04:00 KST on 10-07 = 2026-10-06T19:00Z
      nextScheduledAt: '2026-10-06T19:00:00.000Z',
    });
    // File names only: no directory path anywhere in the status.
    expect(JSON.stringify(status)).not.toContain(root);
    expect(failures).toEqual([]);
    await backup.stop();
  });

  it('runs at 04:00 QUOKY_TIMEZONE when a fresh daily copy exists, waking at most every 15 minutes', async () => {
    mkdirSync(dir, { recursive: true });
    const recent = backupFileName('daily', Date.parse('2026-10-05T19:00:00Z')); // today 04:00 KST
    writeFileSync(path.join(dir, recent), 'x');
    const backup = job();
    backup.start();
    expect(backup.status().nextScheduledAt).toBe('2026-10-06T19:00:00.000Z');
    expect(timers.next()?.ms).toBe(BACKUP_POLL_MS);
    await fireUntilRun(backup);
    expect(backup.status().lastRun).toMatchObject({ outcome: 'VERIFIED', file: backupFileName('daily', Date.parse('2026-10-06T19:00:00Z')) });
    expect(backup.status().nextScheduledAt).toBe('2026-10-07T19:00:00.000Z');
    await backup.stop();
  });

  it('a slept-through 04:00 runs at the first wake after it (wall clock, not timer time)', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, backupFileName('daily', Date.parse('2026-10-05T19:00:00Z'))), 'x');
    const backup = job();
    backup.start();
    // The Mac sleeps 20 hours; the pending 15-minute timer fires once on wake.
    timers.clockMs = Date.parse('2026-10-06T21:00:00Z');
    await fireUntilRun(backup, 1);
    expect(backup.status().lastRun?.outcome).toBe('VERIFIED');
    await backup.stop();
  });

  it('prunes by retention, only its own names and regular files, never foreign files', async () => {
    mkdirSync(dir, { recursive: true });
    const old = Array.from({ length: 40 }, (_, i) =>
      backupFileName('daily', Date.parse('2026-10-04T19:00:00Z') - i * 86_400_000),
    );
    for (const name of old) writeFileSync(path.join(dir, name), 'x');
    const foreign = ['notes.txt', 'quoky.db', 'quoky-20200101T000000Z-daily.db.keep'];
    for (const name of foreign) writeFileSync(path.join(dir, name), 'keep me');
    // A symlink with a backup-shaped name is not a regular file: never deleted.
    const linkName = backupFileName('daily', Date.parse('2020-01-01T00:00:00Z'));
    symlinkSync(path.join(root, 'quoky.db'), path.join(dir, linkName));
    writeFileSync(path.join(dir, '.quoky-20261001T000000Z-daily.db.partial'), 'stale');

    const backup = job();
    backup.start();
    await fireUntilRun(backup);
    const names = readdirSync(dir);
    for (const name of [...foreign, linkName]) expect(names).toContain(name);
    expect(names).not.toContain('.quoky-20261001T000000Z-daily.db.partial');
    const kept = backup.status().retained;
    // 7 days (the new copy + 6 older days) + 2 extra weekly copies (the 2 newest weeks are already covered).
    expect(kept).toHaveLength(9);
    expect(names.filter((n) => old.includes(n))).toHaveLength(8);
    expect(backup.status().retainedCount).toBe(9);
    await backup.stop();
  });

  it('a failed copy is removed, logged by code, reported once, and the chain continues', async () => {
    const copies: SqliteCopyRequest[] = [];
    const failingCopy = async (request: SqliteCopyRequest): Promise<SqliteBackupResult> => {
      copies.push(request);
      writeFileSync(request.targetPath, 'half written');
      return { ok: false, failure: 'INTEGRITY_FAILED' };
    };
    const backup = job({ copy: failingCopy });
    backup.start();
    await fireUntilRun(backup);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'daily', outcome: 'FAILED', failure: 'INTEGRITY_FAILED' });
    expect(copies[0]?.targetPath.endsWith('.partial')).toBe(true);
    expect(copies[0]?.timeoutMs).toBe(5 * 60 * 1000);
    expect(readdirSync(dir)).toEqual([BACKUP_STATUS_FILE]);
    expect(logger.lines).toContainEqual({ level: 'error', message: 'backup.failed', fields: { kind: 'daily', failure: 'INTEGRITY_FAILED' } });
    const status = JSON.parse(readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'));
    expect(status.lastRun).toMatchObject({ outcome: 'FAILED', failure: 'INTEGRITY_FAILED' });
    expect(status.lastVerified).toBeNull();
    // Re-armed for the next 04:00.
    expect(backup.status().nextScheduledAt).toBe('2026-10-06T19:00:00.000Z');
    expect(timers.pending.size).toBe(1);
    await backup.stop();
  });

  it('copies never overlap, and stop() aborts an in-flight copy without reporting it', async () => {
    let release: (r: SqliteBackupResult) => void = () => undefined;
    let calls = 0;
    let aborted = false;
    const slowCopy = (request: SqliteCopyRequest): Promise<SqliteBackupResult> => {
      calls += 1;
      request.signal?.addEventListener('abort', () => {
        aborted = true;
        release({ ok: false, failure: 'ABORTED' });
      });
      return new Promise((resolve) => (release = resolve));
    };
    const backup = job({ copy: slowCopy });
    backup.start();
    timers.clockMs = T0 + BACKUP_CATCH_UP_DELAY_MS;
    timers.fireNext();
    expect(calls).toBe(1);
    expect(timers.pending.size).toBe(0); // nothing re-armed while a copy runs
    await backup.stop();
    expect(aborted).toBe(true);
    expect(backup.state).toBe('STOPPED');
    expect(failures).toEqual([]);
    expect(timers.pending.size).toBe(0);
  });

  it('disabled: never starts, writes nothing', async () => {
    const backup = job({ enabled: false });
    expect(backup.start()).toBe(false);
    expect(backup.state).toBe('DISABLED');
    expect(await backup.ensurePreMigrationBackup()).toBe('DISABLED');
    expect(existsSync(dir)).toBe(false);
    expect(timers.pending.size).toBe(0);
  });

  describe('pre-migration copy (ADR-0102 D3)', () => {
    it('nothing to do for an absent database or a current/ahead schema', async () => {
      expect(await job({ dbPath: path.join(root, 'absent.db') }).ensurePreMigrationBackup()).toBe('NO_DATABASE');
      expect(await job().ensurePreMigrationBackup()).toBe('NOT_NEEDED');
      expect(await job({ latestSchemaVersion: LATEST_SCHEMA_VERSION - 1 }).ensurePreMigrationBackup()).toBe('NOT_NEEDED');
      expect(existsSync(dir)).toBe(false);
    });

    it('takes a verified pre-migration copy when this build would migrate the database', async () => {
      const backup = job({ latestSchemaVersion: LATEST_SCHEMA_VERSION + 1 });
      expect(await backup.ensurePreMigrationBackup()).toBe('VERIFIED');
      const name = backupFileName('pre-migration', T0);
      expect(readdirSync(dir).sort()).toEqual([BACKUP_STATUS_FILE, name].sort());
      expect(readSqliteUserVersion(path.join(dir, name))).toBe(LATEST_SCHEMA_VERSION);
      expect(mode(path.join(dir, name))).toBe(0o600);
      expect(backup.status().lastVerified).toMatchObject({ kind: 'pre-migration', file: name });
    });

    it('refuses the start (configuration exit) when the copy does not verify, before any migration', async () => {
      const backup = job({
        latestSchemaVersion: LATEST_SCHEMA_VERSION + 1,
        copy: async () => ({ ok: false, failure: 'COPY_FAILED' }),
      });
      const error = await backup.ensurePreMigrationBackup().then(
        () => undefined,
        (err: unknown) => err,
      );
      const report = describeStartupFailure(error);
      expect(report.message).toBe(BackupErrorCode.BACKUP_PRE_MIGRATION_FAILED);
      expect(startupExitCode(report)).toBe(QuokyExitCode.CONFIGURATION);
      // The pre-migration path does not send the notice (the platform is not up); the start is refused instead.
      expect(failures).toEqual([]);
    });

    it('an unreadable database also refuses the start', async () => {
      const backup = job({
        readUserVersion: () => {
          throw new Error('SQLITE_NOTADB');
        },
      });
      await expect(backup.ensurePreMigrationBackup()).rejects.toMatchObject({ code: BackupErrorCode.BACKUP_PRE_MIGRATION_FAILED });
    });
  });

  it('after a restart, the status keeps the last verified copy (from the previous status file)', async () => {
    const first = job();
    first.start();
    await fireUntilRun(first);
    await first.stop();
    const name = first.status().lastVerified?.file;

    const second = job();
    second.start();
    expect(second.status().lastVerified).toMatchObject({ file: name, userVersion: LATEST_SCHEMA_VERSION });
    expect(second.status().retained).toEqual([name]);
    await second.stop();
  });

  describe('vector store in the backup set', () => {
    let vectorPath: string;

    beforeEach(async () => {
      vectorPath = path.join(root, 'vectors');
      await new LocalVectorProvider(vectorPath).upsert('durable-memory-v1', [
        { id: 'memory-1', vector: [1, 0, 0], metadata: { contentHash: 'a' } },
        { id: 'memory-2', vector: [0, 1, 0], metadata: { contentHash: 'b' } },
      ]);
    });

    function vectorJob(overrides: Partial<BackupJobDeps> = {}): BackupJob {
      return job({ vectorPath, snapshotVectors: writeVerifiedVectorSnapshot, ...overrides });
    }

    it('snapshots the vector store next to every copy (same stem, dir 700, files 600) and records it', async () => {
      const backup = vectorJob();
      backup.start();
      await fireUntilRun(backup);
      const name = backupFileName('daily', T0 + BACKUP_CATCH_UP_DELAY_MS);
      const vectors = vectorSnapshotName(name);
      expect(readdirSync(dir).sort()).toEqual([BACKUP_STATUS_FILE, name, vectors].sort());
      expect(mode(path.join(dir, vectors))).toBe(0o700);
      for (const entry of readdirSync(path.join(dir, vectors))) expect(mode(path.join(dir, vectors, entry))).toBe(0o600);
      expect(readFileSync(path.join(dir, vectors, 'durable-memory-v1.json'))).toEqual(
        readFileSync(path.join(vectorPath, 'durable-memory-v1.json')),
      );

      const status = JSON.parse(readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'));
      expect(status.lastRun).toMatchObject({
        outcome: 'VERIFIED',
        file: name,
        vectors: { outcome: 'VERIFIED', dir: vectors, storePresent: true, collections: 1, records: 2, skippedInvalid: 0 },
      });
      expect(status.lastVerified).toMatchObject({ file: name, vectors });
      expect(status.retainedVectors).toEqual([vectors]);
      expect(JSON.stringify(status)).not.toContain(root);
      expect(JSON.stringify(status)).not.toContain('memory-1');
      expect(logger.lines).toContainEqual(
        expect.objectContaining({ message: 'backup.verified', fields: expect.objectContaining({ vectors: 'VERIFIED', vectorRecords: 2 }) }),
      );
      await backup.stop();
    });

    it('a pre-migration copy carries its vector snapshot too', async () => {
      const backup = vectorJob({ latestSchemaVersion: LATEST_SCHEMA_VERSION + 1 });
      expect(await backup.ensurePreMigrationBackup()).toBe('VERIFIED');
      const name = backupFileName('pre-migration', T0);
      expect(readdirSync(dir).sort()).toEqual([BACKUP_STATUS_FILE, name, vectorSnapshotName(name)].sort());
    });

    it('a failed or timed-out vector snapshot keeps the verified DB copy, sends no notice and leaves no partial', async () => {
      const failing = async (request: VectorSnapshotRequest): Promise<VectorSnapshotResult> => {
        mkdirSync(request.targetDir);
        writeFileSync(path.join(request.targetDir, 'durable-memory-v1.json'), 'half');
        return { ok: false, failure: 'COPY_FAILED' };
      };
      const backup = vectorJob({ snapshotVectors: failing });
      backup.start();
      await fireUntilRun(backup);
      const name = backupFileName('daily', T0 + BACKUP_CATCH_UP_DELAY_MS);
      expect(readdirSync(dir).sort()).toEqual([BACKUP_STATUS_FILE, name].sort());
      expect(backup.status().lastRun).toMatchObject({ outcome: 'VERIFIED', file: name, vectors: { outcome: 'FAILED', failure: 'COPY_FAILED' } });
      expect(backup.status().lastVerified?.vectors).toBeUndefined();
      expect(backup.status().retainedVectors).toEqual([]);
      expect(failures).toEqual([]);
      expect(logger.lines).toContainEqual({ level: 'error', message: 'backup.vectors.failed', fields: { dir: vectorSnapshotName(name), failure: 'COPY_FAILED' } });
      await backup.stop();

      // A snapshot that outlives the bound is aborted and recorded as TIMEOUT (the DB copy keeps its own bound).
      const hanging = (request: VectorSnapshotRequest): Promise<VectorSnapshotResult> =>
        new Promise((resolve) => request.signal?.addEventListener('abort', () => resolve({ ok: false, failure: 'ABORTED' })));
      const slow = job({
        latestSchemaVersion: LATEST_SCHEMA_VERSION + 1,
        vectorPath,
        snapshotVectors: hanging,
        timeoutMs: 50,
        copy: (request) => writeVerifiedSqliteCopy({ ...request, timeoutMs: 30_000 }),
        clock: () => new Date(T0 + 60_000).toISOString(),
      });
      expect(await slow.ensurePreMigrationBackup()).toBe('VERIFIED');
      expect(slow.status().lastRun?.vectors).toEqual({ outcome: 'FAILED', failure: 'TIMEOUT' });
    });

    it('prunes a vector snapshot with its DB copy and orphaned snapshots; never foreign entries or symlinks', async () => {
      mkdirSync(dir, { recursive: true });
      const old = Array.from({ length: 12 }, (_, i) => backupFileName('daily', Date.parse('2026-10-04T19:00:00Z') - i * 86_400_000));
      for (const name of old) {
        writeFileSync(path.join(dir, name), 'x');
        mkdirSync(path.join(dir, vectorSnapshotName(name)));
        writeFileSync(path.join(dir, vectorSnapshotName(name), 'durable-memory-v1.json'), '{}');
        writeFileSync(path.join(dir, vectorSnapshotName(name), '.snapshot.json'), '{}');
      }
      // The oldest pruned copy's snapshot also holds a foreign file: its snapshot entries go, the directory stays.
      const foreignHolder = vectorSnapshotName(old[old.length - 1] as string);
      writeFileSync(path.join(dir, foreignHolder, 'notes.txt'), 'keep me');
      // A snapshot without its DB copy is an orphan; a symlink with a snapshot name is never followed or removed.
      const orphan = vectorSnapshotName(backupFileName('daily', Date.parse('2026-01-01T00:00:00Z')));
      mkdirSync(path.join(dir, orphan));
      writeFileSync(path.join(dir, orphan, 'durable-memory-v1.json'), '{}');
      const linkTarget = path.join(root, 'elsewhere');
      mkdirSync(linkTarget);
      writeFileSync(path.join(linkTarget, 'durable-memory-v1.json'), 'outside');
      const link = vectorSnapshotName(backupFileName('daily', Date.parse('2020-01-01T00:00:00Z')));
      symlinkSync(linkTarget, path.join(dir, link));

      const backup = vectorJob();
      backup.start();
      await fireUntilRun(backup);
      const names = readdirSync(dir);
      const retained = backup.status().retained;
      const pruned = old.filter((name) => !retained.includes(name));
      expect(pruned.length).toBeGreaterThan(0);
      for (const name of old) {
        if (retained.includes(name)) expect(names).toContain(vectorSnapshotName(name));
        else if (vectorSnapshotName(name) !== foreignHolder) expect(names).not.toContain(vectorSnapshotName(name));
      }
      expect(names).not.toContain(orphan);
      expect(readdirSync(path.join(dir, foreignHolder))).toEqual(['notes.txt']);
      expect(names).toContain(link);
      expect(readFileSync(path.join(linkTarget, 'durable-memory-v1.json'), 'utf8')).toBe('outside');
      expect(backup.status().retainedVectors).toEqual(retained.map(vectorSnapshotName));
      await backup.stop();
    });
  });

  describe('partials across processes', () => {
    it('removes its own kinds\' partials, but another process\'s only once stale', async () => {
      mkdirSync(dir, { recursive: true });
      const freshManual = partialFileName(backupFileName('manual', T0 - 60_000));
      const freshManualVectors = partialFileName(vectorSnapshotName(backupFileName('manual', T0 - 60_000)));
      const staleManual = partialFileName(backupFileName('manual', T0 - 2 * 3_600_000));
      const ownDaily = partialFileName(backupFileName('daily', T0 - 60_000));
      for (const name of [freshManual, staleManual, ownDaily]) writeFileSync(path.join(dir, name), '');
      mkdirSync(path.join(dir, freshManualVectors));
      const at = (ms: number): Date => new Date(ms);
      utimesSync(path.join(dir, freshManual), at(T0), at(T0));
      utimesSync(path.join(dir, freshManualVectors), at(T0), at(T0));
      utimesSync(path.join(dir, ownDaily), at(T0), at(T0));
      utimesSync(path.join(dir, staleManual), at(T0 - 2 * 3_600_000), at(T0 - 2 * 3_600_000));

      const backup = job();
      backup.start();
      await fireUntilRun(backup);
      const names = readdirSync(dir);
      expect(names).toContain(freshManual);
      expect(names).toContain(freshManualVectors);
      expect(names).not.toContain(staleManual);
      expect(names).not.toContain(ownDaily);
      await backup.stop();
    });

    it('claims its partial name exclusively: a taken name fails TARGET_EXISTS and is left untouched', async () => {
      mkdirSync(dir, { recursive: true });
      const name = backupFileName('daily', T0 + BACKUP_CATCH_UP_DELAY_MS);
      writeFileSync(path.join(dir, partialFileName(name)), 'another run');
      const backup = job();
      backup.start();
      await fireUntilRun(backup);
      expect(backup.status().lastRun).toMatchObject({ outcome: 'FAILED', failure: 'TARGET_EXISTS' });
      expect(readFileSync(path.join(dir, partialFileName(name)), 'utf8')).toBe('another run');
      await backup.stop();
    });
  });

  describe('manual role (quokyctl.sh backup --apply)', () => {
    it('takes a manual copy beside the running service; each side keeps the other\'s status fields', async () => {
      const service = job();
      service.start();
      const scheduled = service.status().nextScheduledAt;

      const manual = job({ role: 'manual' });
      expect(manual.start()).toBe(false);
      expect(await manual.ensurePreMigrationBackup()).toBe('DISABLED');
      const record = await manual.runManual();
      const name = backupFileName('manual', T0);
      expect(record).toMatchObject({ kind: 'manual', outcome: 'VERIFIED', file: name, userVersion: LATEST_SCHEMA_VERSION });
      expect(mode(path.join(dir, name))).toBe(0o600);

      const afterManual = JSON.parse(readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'));
      expect(afterManual).toMatchObject({ enabled: true, state: 'RUNNING', nextScheduledAt: scheduled, lastRun: null });
      expect(afterManual.lastManual).toMatchObject({ kind: 'manual', outcome: 'VERIFIED', file: name });
      expect(afterManual.lastVerified).toMatchObject({ kind: 'manual', file: name });
      // The running service sees the manual copy without a restart (OPS-1 reads status()).
      expect(service.status().lastManual).toMatchObject({ file: name });
      expect(service.status().lastVerified).toMatchObject({ file: name });
      expect(service.status().retained).toEqual([name]);

      await fireUntilRun(service);
      const daily = backupFileName('daily', T0 + BACKUP_CATCH_UP_DELAY_MS);
      const afterDaily = JSON.parse(readFileSync(path.join(dir, BACKUP_STATUS_FILE), 'utf8'));
      expect(afterDaily.lastRun).toMatchObject({ kind: 'daily', file: daily });
      expect(afterDaily.lastManual).toMatchObject({ file: name });
      expect(afterDaily.lastVerified).toMatchObject({ kind: 'daily', file: daily });
      expect(afterDaily.retained).toEqual([daily, name]);
      await service.stop();
    });

    it('keeps the 5 newest manual copies and never prunes the scheduled ones', async () => {
      mkdirSync(dir, { recursive: true });
      const daily = backupFileName('daily', Date.parse('2026-10-05T19:00:00Z'));
      writeFileSync(path.join(dir, daily), 'x');
      const older = Array.from({ length: 6 }, (_, i) => backupFileName('manual', T0 - (i + 1) * 3_600_000));
      for (const name of older) writeFileSync(path.join(dir, name), 'x');
      await job({ role: 'manual' }).runManual();
      const names = readdirSync(dir);
      expect(names).toContain(daily);
      expect(names).toContain(backupFileName('manual', T0));
      expect(older.filter((n) => names.includes(n))).toEqual(older.slice(0, 4));
    });
  });
});
