import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, readSqliteUserVersion, verifySqliteBackupFile, writeVerifiedSqliteCopy } from './backup';
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
});
