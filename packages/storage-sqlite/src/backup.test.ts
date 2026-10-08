import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, utimesSync } from 'node:fs';
import {
  LATEST_SCHEMA_VERSION,
  readSqliteUserVersion,
  tryAcquireExclusiveLock,
  verifySqliteBackupFile,
  writeVerifiedSqliteCopy,
} from './backup';
import { SqliteStorageProvider } from './index';

describe('SQLite backup primitives (ADR-0102 D6)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quoky-backup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readSqliteUserVersion: undefined for a missing file, the version for an existing one', async () => {
    const dbPath = join(dir, 'quoky.db');
    expect(readSqliteUserVersion(dbPath)).toBeUndefined();
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    await storage.close();
    expect(readSqliteUserVersion(dbPath)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('copies a live WAL database with VACUUM INTO and verifies the copy (integrity_check, user_version)', async () => {
    const dbPath = join(dir, 'quoky.db');
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    // A second writer connection with an uncheckpointed WAL write: the snapshot must include it.
    const writer = new Database(dbPath);
    writer.exec(`CREATE TABLE IF NOT EXISTS backup_probe (v TEXT)`);
    writer.prepare(`INSERT INTO backup_probe (v) VALUES (?)`).run('row-1');

    const targetPath = join(dir, 'copy.db');
    const result = await writeVerifiedSqliteCopy({ sourcePath: dbPath, targetPath, timeoutMs: 30_000 });
    expect(result).toEqual({ ok: true, userVersion: LATEST_SCHEMA_VERSION });

    const copy = new Database(targetPath, { readonly: true });
    expect(copy.prepare(`SELECT v FROM backup_probe`).all()).toEqual([{ v: 'row-1' }]);
    expect(Number(copy.pragma('user_version', { simple: true }))).toBe(LATEST_SCHEMA_VERSION);
    copy.close();
    // The source is untouched and still writable by its owner.
    writer.prepare(`INSERT INTO backup_probe (v) VALUES (?)`).run('row-2');
    writer.close();
    await storage.close();
  });

  it('verifySqliteBackupFile re-checks a copy read-only and leaves no -wal/-shm beside it', async () => {
    const dbPath = join(dir, 'quoky.db');
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    const copyDir = mkdtempSync(join(dir, 'copies-'));
    const copyPath = join(copyDir, 'copy.db');
    expect((await writeVerifiedSqliteCopy({ sourcePath: dbPath, targetPath: copyPath, timeoutMs: 30_000 })).ok).toBe(true);
    await storage.close();
    expect(verifySqliteBackupFile(copyPath)).toEqual({ ok: true, userVersion: LATEST_SCHEMA_VERSION });
    expect(readdirSync(copyDir)).toEqual(['copy.db']);
    expect(verifySqliteBackupFile(join(copyDir, 'absent.db'))).toEqual({ ok: false, failure: 'SOURCE_UNREADABLE' });
    writeFileSync(join(copyDir, 'junk.db'), 'not a database'.repeat(500));
    expect(verifySqliteBackupFile(join(copyDir, 'junk.db'))).toEqual({ ok: false, failure: 'INTEGRITY_FAILED' });
  });

  it('a cleanly closed WAL database (no -wal/-shm) is copied too', async () => {
    const dbPath = join(dir, 'quoky.db');
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    await storage.close();
    const result = await writeVerifiedSqliteCopy({ sourcePath: dbPath, targetPath: join(dir, 'c.db'), timeoutMs: 30_000 });
    expect(result.ok).toBe(true);
  });

  it('classifies a missing source as SOURCE_UNREADABLE and writes nothing', async () => {
    const targetPath = join(dir, 'copy.db');
    const result = await writeVerifiedSqliteCopy({ sourcePath: join(dir, 'absent.db'), targetPath, timeoutMs: 30_000 });
    expect(result).toEqual({ ok: false, failure: 'SOURCE_UNREADABLE' });
    expect(existsSync(targetPath)).toBe(false);
  });

  it('classifies a non-database source as SOURCE_UNREADABLE', async () => {
    const sourcePath = join(dir, 'garbage.db');
    writeFileSync(sourcePath, 'not a database at all, just text'.repeat(200));
    const result = await writeVerifiedSqliteCopy({ sourcePath, targetPath: join(dir, 'copy.db'), timeoutMs: 30_000 });
    expect(result.ok).toBe(false);
    expect(['SOURCE_UNREADABLE', 'COPY_FAILED']).toContain((result as { failure: string }).failure);
  });

  it('refuses to overwrite an existing target (COPY_FAILED)', async () => {
    const dbPath = join(dir, 'quoky.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE t (x)`);
    db.close();
    const targetPath = join(dir, 'copy.db');
    writeFileSync(targetPath, 'occupied');
    const result = await writeVerifiedSqliteCopy({ sourcePath: dbPath, targetPath, timeoutMs: 30_000 });
    expect(result).toEqual({ ok: false, failure: 'COPY_FAILED' });
  });

  it('is bounded: an already-expired budget resolves TIMEOUT', async () => {
    const dbPath = join(dir, 'quoky.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE t (x)`);
    db.close();
    const result = await writeVerifiedSqliteCopy({ sourcePath: dbPath, targetPath: join(dir, 'copy.db'), timeoutMs: 0 });
    expect(result).toEqual({ ok: false, failure: 'TIMEOUT' });
  });

  it('an aborted signal resolves ABORTED without starting a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const targetPath = join(dir, 'copy.db');
    const result = await writeVerifiedSqliteCopy({
      sourcePath: join(dir, 'quoky.db'),
      targetPath,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, failure: 'ABORTED' });
    expect(existsSync(targetPath)).toBe(false);
  });

  describe('tryAcquireExclusiveLock: an OS-held lock the kernel releases', () => {
    const DIST = join(__dirname, '..', 'dist', 'backup.js');

    /** A child process that takes the lock and then waits forever (until killed). */
    function lockingChild(lockPath: string): Promise<{ child: ReturnType<typeof spawn> }> {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `const r = require(process.argv[1]).tryAcquireExclusiveLock(process.argv[2]);
           process.stdout.write(r.ok ? 'locked\\n' : 'busy\\n');
           setInterval(() => {}, 1000);`,
          DIST,
          lockPath,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      return new Promise((resolve, reject) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('locked')) resolve({ child });
          else reject(new Error('child could not lock'));
        });
      });
    }

    /** An external contender: a child process that tries once and reports `locked` or `busy`. */
    function externalTry(lockPath: string): string {
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `const r = require(process.argv[1]).tryAcquireExclusiveLock(process.argv[2]);
           process.stdout.write(r.ok ? 'locked' : r.failure);`,
          DIST,
          lockPath,
        ],
        { encoding: 'utf8' },
      );
      return result.stdout;
    }

    it('one holder at a time; release lets the next one in', () => {
      const lockPath = join(dir, '.backup-lock.db');
      const first = tryAcquireExclusiveLock(lockPath);
      expect(first.ok).toBe(true);
      expect(tryAcquireExclusiveLock(lockPath)).toEqual({ ok: false, failure: 'BUSY' });
      if (first.ok) first.release();
      const second = tryAcquireExclusiveLock(lockPath);
      expect(second.ok).toBe(true);
      if (second.ok) second.release();
    });

    it.skipIf(!existsSync(DIST))('a same-process contender never releases the holder\'s kernel lock (A, then B, then external C)', () => {
      const lockPath = join(dir, '.backup-lock.db');
      const a = tryAcquireExclusiveLock(lockPath);
      expect(a.ok).toBe(true);
      // B in the same process: BUSY at once from the process-wide guard, without opening (or closing) the file.
      expect(tryAcquireExclusiveLock(lockPath)).toEqual({ ok: false, failure: 'BUSY' });
      expect(tryAcquireExclusiveLock(lockPath)).toEqual({ ok: false, failure: 'BUSY' });
      // C in another process is still blocked: A's fcntl lock survived B.
      expect(externalTry(lockPath)).toBe('BUSY');
      if (a.ok) a.release();
      expect(externalTry(lockPath)).toBe('locked');
    });

    it('the lock directory must be a private real directory (700, owned by this user, not a symlink)', () => {
      const open = join(dir, 'open');
      mkdirSync(open, { mode: 0o755 });
      chmodSync(open, 0o755);
      expect(tryAcquireExclusiveLock(join(open, '.backup-lock.db'))).toEqual({ ok: false, failure: 'UNAVAILABLE' });
      const real = join(dir, 'real');
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, join(dir, 'linked'));
      expect(tryAcquireExclusiveLock(join(dir, 'linked', '.backup-lock.db'))).toEqual({ ok: false, failure: 'UNAVAILABLE' });
      expect(readdirSync(real)).toEqual([]);
      const ok = tryAcquireExclusiveLock(join(real, '.backup-lock.db'));
      expect(ok.ok).toBe(true);
      if (ok.ok) ok.release();
    });

    it.skipIf(!existsSync(DIST))('a SIGKILLed holder releases the lock; a live holder is never taken over, however old', async () => {
      const lockPath = join(dir, '.backup-lock.db');
      const { child } = await lockingChild(lockPath);
      expect(tryAcquireExclusiveLock(lockPath)).toEqual({ ok: false, failure: 'BUSY' });
      // No age rule: an ancient-looking lock file of a live holder stays held.
      utimesSync(lockPath, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
      expect(tryAcquireExclusiveLock(lockPath)).toEqual({ ok: false, failure: 'BUSY' });

      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      const after = tryAcquireExclusiveLock(lockPath);
      expect(after.ok).toBe(true);
      if (after.ok) after.release();
    }, 20_000);

    it('refuses a lock path that is a symlink or a directory (UNAVAILABLE)', () => {
      const target = join(dir, 'target.db');
      writeFileSync(target, '');
      symlinkSync(target, join(dir, 'link.db'));
      expect(tryAcquireExclusiveLock(join(dir, 'link.db'))).toEqual({ ok: false, failure: 'UNAVAILABLE' });
      expect(tryAcquireExclusiveLock(dir)).toEqual({ ok: false, failure: 'UNAVAILABLE' });
    });
  });
});
