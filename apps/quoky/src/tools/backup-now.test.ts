import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  SqliteStorageProvider,
  tryAcquireExclusiveLock,
  verifySqliteBackupFile,
} from '@quoky/storage-sqlite';
import { LocalVectorProvider } from '@quoky/vector-local';
import { BACKUP_LOCK_FILE, BACKUP_STATUS_FILE } from '../ops/backup-job';
import { backupFileName, vectorSnapshotName } from '../ops/backup-files';
import {
  EXIT_BLOCKED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VECTORS_FAILED,
  MISSING_VECTOR_SNAPSHOT_GUIDANCE,
  runCli,
  type BackupNowDeps,
} from './backup-now';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SECRET_LINE = 'DISCORD_BOT_TOKEN=secret-token-value-never-printed';
const NOW = '2026-10-07T03:04:05.000Z';

describe('backup-now: the on-demand backup tool', () => {
  let root: string;
  let dbPath: string;
  let vectorPath: string;
  let backups: string;
  let envFile: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'quoky-backup-now-'));
    dbPath = path.join(root, 'quoky.db');
    vectorPath = path.join(root, 'vectors');
    backups = path.join(root, 'backups');
    envFile = path.join(root, '.env.local');
    writeFileSync(envFile, `${SECRET_LINE}\n`, { mode: 0o600 });
    out = [];
    err = [];
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    await storage.close();
    await new LocalVectorProvider(vectorPath).upsert('durable-memory-v1', [
      { id: 'memory-1', vector: [1, 0, 0], metadata: { contentHash: 'a' } },
    ]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(overrides: Partial<BackupNowDeps> = {}): BackupNowDeps {
    return {
      env: {
        QUOKY_DB_PATH: dbPath,
        QUOKY_VECTOR_PATH: vectorPath,
        QUOKY_BACKUP_DIR: backups,
        QUOKY_TIMEZONE: 'Asia/Seoul',
        QUOKY_LAUNCHER: 'launchd',
      },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      clock: () => NOW,
      ...overrides,
    };
  }

  const manualName = backupFileName('manual', Date.parse(NOW));
  const printed = (): string => [...out, ...err].join('\n');
  /** The backup directory without the persistent lock database (`BACKUP_LOCK_FILE`, held only during a run). */
  const listed = (): string[] => readdirSync(backups).filter((n) => n !== BACKUP_LOCK_FILE);

  it('never reads an env file: configuration comes from the process environment only', async () => {
    // An env file the tool would trip over if it read it (unreadable, and naming another backup directory).
    writeFileSync(envFile, `${SECRET_LINE}\nQUOKY_BACKUP_DIR=${path.join(root, 'elsewhere')}\n`, { mode: 0o000 });
    const code = await runCli(['--apply'], deps({ env: { QUOKY_ENV_FILE: envFile, QUOKY_DB_PATH: dbPath, QUOKY_VECTOR_PATH: vectorPath } }));
    expect(code).toBe(EXIT_OK);
    // The service's default: <db dir>/backups (loadOpsConfig), not the env file's value.
    expect(readdirSync(backups)).toContain(manualName);
    expect(existsSync(path.join(root, 'elsewhere'))).toBe(false);
    const source = readFileSync(path.join(__dirname, 'backup-now.ts'), 'utf8');
    for (const forbidden of ['QUOKY_ENV_FILE', 'dotenv', 'readFileSync', '.env.local\'']) expect(source).not.toContain(forbidden);
  });

  it('--dry-run reports the set it would write and what retention would prune, and writes nothing', async () => {
    mkdirSync(backups);
    const older = Array.from({ length: 5 }, (_, i) => backupFileName('manual', Date.parse(NOW) - (i + 1) * 3_600_000));
    for (const name of older) writeFileSync(path.join(backups, name), 'x');
    const before = readdirSync(backups).sort();

    expect(await runCli(['--dry-run'], deps())).toBe(EXIT_OK);
    expect(readdirSync(backups).sort()).toEqual(before);
    expect(out).toContain(`database:   ${dbPath} (user_version ${LATEST_SCHEMA_VERSION})`);
    expect(out).toContain(`vectors:    ${vectorPath}: 1 collection(s), 1 record(s)`);
    expect(out).toContain(`plan:  write ${manualName} (VACUUM INTO a .partial name, verify integrity_check + user_version, rename)`);
    expect(out.some((l) => l.startsWith(`plan:  write ${vectorSnapshotName(manualName)}/`))).toBe(true);
    expect(out).toContain(`plan:  keep the 5 newest manual copies; prune ${older[4]} (and their vector snapshots)`);
    expect(printed()).not.toContain('secret-token-value');
  });

  it('--dry-run creates no backup directory', async () => {
    expect(await runCli(['--dry-run'], deps())).toBe(EXIT_OK);
    expect(existsSync(backups)).toBe(false);
  });

  it('--apply writes a verified manual set (DB copy + vector snapshot), 700/600, and records lastManual', async () => {
    expect(await runCli(['--apply'], deps())).toBe(EXIT_OK);
    const vectors = vectorSnapshotName(manualName);
    expect(listed().sort()).toEqual([BACKUP_STATUS_FILE, manualName, vectors].sort());
    expect(statSync(path.join(backups, BACKUP_LOCK_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(backups, manualName)).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(backups, vectors)).mode & 0o777).toBe(0o700);
    expect(verifySqliteBackupFile(path.join(backups, manualName))).toEqual({ ok: true, userVersion: LATEST_SCHEMA_VERSION });
    const status = JSON.parse(readFileSync(path.join(backups, BACKUP_STATUS_FILE), 'utf8'));
    expect(status.lastManual).toMatchObject({
      kind: 'manual',
      outcome: 'VERIFIED',
      file: manualName,
      vectors: { outcome: 'VERIFIED', dir: vectors, collections: 1, records: 1 },
    });
    // No service status existed: the scheduled fields are reported from configuration, not invented.
    expect(status).toMatchObject({ enabled: true, state: 'IDLE', lastRun: null, nextScheduledAt: null });
    expect(out).toContain(`vectors: verified ${vectors} (1 collection(s), 1 record(s))`);
    expect(printed()).not.toContain('secret-token-value');
  });

  it('a vector snapshot failure keeps the verified DB copy and exits 4; a DB copy failure keeps nothing and exits 1', async () => {
    const vectorsFail = deps({ snapshotVectors: async () => ({ ok: false, failure: 'SOURCE_UNREADABLE' }) });
    expect(await runCli(['--apply'], vectorsFail)).toBe(EXIT_VECTORS_FAILED);
    expect(listed().sort()).toEqual([BACKUP_STATUS_FILE, manualName].sort());
    expect(out).toContain('vectors: FAILED (SOURCE_UNREADABLE)');

    rmSync(backups, { recursive: true });
    const dbFail = deps({ copy: async () => ({ ok: false, failure: 'COPY_FAILED' }) });
    expect(await runCli(['--apply'], dbFail)).toBe(EXIT_FAILED);
    expect(listed()).toEqual([BACKUP_STATUS_FILE]);
    expect(err).toContain('FAILED: the manual copy did not verify (COPY_FAILED); nothing was kept');
  });

  it('blocks without a database, on invalid configuration, and on bad usage', async () => {
    expect(await runCli(['--apply'], deps({ env: { QUOKY_ENV_FILE: envFile, QUOKY_DB_PATH: path.join(root, 'absent.db') } }))).toBe(
      EXIT_BLOCKED,
    );
    expect(existsSync(backups)).toBe(false);
    expect(
      await runCli(['--apply'], deps({ env: { QUOKY_ENV_FILE: envFile, QUOKY_DB_PATH: dbPath, QUOKY_BACKUP_DIR: 'relative' } })),
    ).toBe(EXIT_BLOCKED);
    expect(err.some((l) => l.startsWith('BLOCKED: configuration BACKUP_DIR_INVALID'))).toBe(true);
    expect(await runCli(['--apply'], deps({ env: { QUOKY_ENV_FILE: envFile, QUOKY_DB_PATH: ':memory:' } }))).toBe(EXIT_BLOCKED);
    expect(await runCli([], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--apply', '--dry-run'], deps())).toBe(EXIT_USAGE);
    expect(printed()).not.toContain('secret-token-value');
  });

  it('while another run holds the backup lock, --apply is blocked (exit 3) and writes nothing', async () => {
    mkdirSync(backups, { mode: 0o700 });
    const held = tryAcquireExclusiveLock(path.join(backups, BACKUP_LOCK_FILE));
    expect(held.ok).toBe(true);
    try {
      expect(await runCli(['--apply'], deps())).toBe(EXIT_BLOCKED);
      expect(err).toContain('BLOCKED: another backup run (manual or scheduled) holds the backup lock; nothing was written');
      expect(readdirSync(backups).filter((n) => n.startsWith('quoky-') || n === BACKUP_STATUS_FILE)).toEqual([]);
    } finally {
      if (held.ok) held.release();
    }
    expect(await runCli(['--apply'], deps())).toBe(EXIT_OK);
  });

  describe('--verify: the restore drill', () => {
    it('confirms a matching set (DB copy + vector snapshot)', async () => {
      await runCli(['--apply'], deps());
      out.length = 0;
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_OK);
      expect(out).toEqual([
        `database: ${manualName} ok (integrity_check ok, user_version ${LATEST_SCHEMA_VERSION})`,
        `vectors:  ${vectorSnapshotName(manualName)} ok (1 collection(s), 1 record(s))`,
        'restore:  this copy and its vector snapshot are a matching set; restore both (quickstart section 7)',
      ]);
    });

    it('a copy without a vector snapshot (older backups) prints the rebuild guidance and still verifies', async () => {
      await runCli(['--apply'], deps());
      rmSync(path.join(backups, vectorSnapshotName(manualName)), { recursive: true });
      out.length = 0;
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_OK);
      const text = out.join('\n');
      expect(text).toContain(MISSING_VECTOR_SNAPSHOT_GUIDANCE[0]);
      expect(text).toContain('move the current vectors/ directory aside');
      expect(text).toContain('at most 4 per');
      expect(text).toContain('ranked lexically');
    });

    it('works with no live database (disaster-recovery drill)', async () => {
      await runCli(['--apply'], deps());
      rmSync(dbPath);
      out.length = 0;
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_OK);
      expect(out.at(-1)).toContain('matching set');
    });

    it('refuses a symlinked copy and a symlinked snapshot root (never followed)', async () => {
      await runCli(['--apply'], deps());
      const elsewhere = path.join(root, 'elsewhere');
      mkdirSync(elsewhere);
      // A symlinked snapshot root pointing at a valid snapshot is still refused.
      const snapshot = path.join(backups, vectorSnapshotName(manualName));
      const { renameSync } = await import('node:fs');
      renameSync(snapshot, path.join(elsewhere, 'snap'));
      symlinkSync(path.join(elsewhere, 'snap'), snapshot);
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_FAILED);
      expect(err.at(-1)).toContain('did not verify (VERIFY_FAILED)');

      renameSync(path.join(backups, manualName), path.join(elsewhere, 'copy.db'));
      symlinkSync(path.join(elsewhere, 'copy.db'), path.join(backups, manualName));
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_FAILED);
      expect(err.at(-1)).toContain('is a symlink or not a regular file');
    });

    it('fails a tampered snapshot or copy, and blocks a name that is not a retained copy', async () => {
      await runCli(['--apply'], deps());
      const snapshotFile = path.join(backups, vectorSnapshotName(manualName), 'durable-memory-v1.json');
      writeFileSync(snapshotFile, `${readFileSync(snapshotFile, 'utf8')} `);
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_FAILED);
      expect(err.at(-1)).toContain('did not verify (VERIFY_FAILED)');

      writeFileSync(path.join(backups, manualName), 'not a database'.repeat(500));
      expect(await runCli(['--verify', manualName], deps())).toBe(EXIT_FAILED);
      expect(await runCli(['--verify', 'quoky-20200101T000000Z-daily.db'], deps())).toBe(EXIT_BLOCKED);
      expect(await runCli(['--verify', '../quoky.db'], deps())).toBe(EXIT_BLOCKED);
    });
  });

  it('copies consistently while another process keeps writing (WAL: no writer error, no restart)', async () => {
    // A bigger database so the copy takes measurable time.
    const driverPath = createRequire(path.join(REPO_ROOT, 'packages', 'storage-sqlite', 'package.json')).resolve('better-sqlite3');
    const Database = createRequire(path.join(REPO_ROOT, 'packages', 'storage-sqlite', 'package.json'))('better-sqlite3') as new (
      file: string,
    ) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void };
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, at INTEGER, pad BLOB)');
    const insert = seed.prepare('INSERT INTO probe (at, pad) VALUES (?, randomblob(8192))');
    seed.exec('BEGIN');
    for (let i = 0; i < 3000; i += 1) insert.run(0);
    seed.exec('COMMIT');
    seed.close();

    const stopFile = path.join(root, 'stop-writer');
    const writer = spawn(
      process.execPath,
      [
        '-e',
        `
        const Database = require(process.argv[1]);
        const fs = require('fs');
        const db = new Database(process.argv[2], { timeout: 5000 });
        db.pragma('journal_mode = WAL');
        const insert = db.prepare('INSERT INTO probe (at, pad) VALUES (?, randomblob(256))');
        const commits = [];
        let errors = 0;
        const sleep = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(process.argv[3])) {
          try { insert.run(Date.now()); commits.push(Date.now()); } catch (e) { errors += 1; }
          if (commits.length === 50) process.stdout.write('ready\\n');
          Atomics.wait(sleep, 0, 0, 1);
        }
        db.close();
        process.stdout.write(JSON.stringify({ commits, errors }) + '\\n');
        `,
        driverPath,
        dbPath,
        stopFile,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    writer.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => writer.on('exit', (code) => resolve(code)));
    for (let waited = 0; !stdout.includes('ready') && waited < 20_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
    expect(stdout).toContain('ready');

    const copyStart = Date.now();
    const code = await runCli(['--apply'], deps({ clock: () => new Date().toISOString() }));
    const copyEnd = Date.now();
    // Keep writing a little after the copy, then stop the writer.
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(stopFile, '');
    expect(await exited).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { commits: number[]; errors: number };

    expect(code).toBe(EXIT_OK);
    expect(result.errors).toBe(0);
    // The writer kept committing while the copy ran (the service would not have been blocked either).
    expect(result.commits.filter((t) => t >= copyStart && t <= copyEnd).length).toBeGreaterThan(0);
    const copyName = readdirSync(backups).find((n) => n.endsWith('-manual.db')) as string;
    expect(verifySqliteBackupFile(path.join(backups, copyName))).toEqual({ ok: true, userVersion: LATEST_SCHEMA_VERSION });
    // One consistent snapshot: every seeded row, some of the concurrent ones, never the ones committed after the copy.
    const copy = new (Database as unknown as new (f: string, o: object) => {
      prepare(sql: string): { get(): { n: number } };
      close(): void;
    })(path.join(backups, copyName), { readonly: true });
    const rows = copy.prepare('SELECT count(*) AS n FROM probe').get().n;
    copy.close();
    expect(rows).toBeGreaterThanOrEqual(3000 + 50);
    expect(rows).toBeLessThan(3000 + result.commits.length);
  }, 60_000);
});
