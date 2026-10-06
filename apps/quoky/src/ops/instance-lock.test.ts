import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BootstrapPreflightError } from '../bootstrap-preflight';
import { acquireInstanceLock, instanceLockPath, parseLockRecord } from './instance-lock';

const dirs: string[] = [];
function tempLockPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'quoky-lock-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'quoky.db.lock');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOOT = 1_700_000_000_000;
const base = { bootTimeMs: () => BOOT, now: () => new Date('2026-10-06T00:00:00.000Z') };
let tokenCounter = 0;
const nextToken = () => `token-${(tokenCounter += 1)}`;

function writeLock(lockPath: string, record: Record<string, unknown>): void {
  acquireInstanceLock(lockPath, { ...base, pid: 1, token: nextToken }).release(); // creates the directory
  writeFileSync(lockPath, JSON.stringify(record));
}

describe('instanceLockPath (ADR-0102 D4)', () => {
  it('puts the lock beside the database and skips in-memory/unset databases', () => {
    expect(instanceLockPath('/data/quoky.db')).toBe('/data/quoky.db.lock');
    expect(instanceLockPath(':memory:')).toBeUndefined();
    expect(instanceLockPath('')).toBeUndefined();
  });
});

describe('acquireInstanceLock (ADR-0102 D4)', () => {
  it('creates an owner-only lock file with pid, start time, boot time and token, and leaves no temp file', () => {
    const lockPath = tempLockPath();
    const lock = acquireInstanceLock(lockPath, { ...base, pid: 4242, token: () => 'tok-a' });
    const record = parseLockRecord(readFileSync(lockPath, 'utf8'));
    expect(record).toEqual({ pid: 4242, startedAt: '2026-10-06T00:00:00.000Z', bootTimeMs: BOOT, token: 'tok-a' });
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(lockPath))).toEqual(['quoky.db.lock']);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses a second instance while the owner process is alive (typed error, before any storage work)', () => {
    const lockPath = tempLockPath();
    const first = acquireInstanceLock(lockPath, { ...base, pid: 100, token: () => 'first' });
    let thrown: unknown;
    try {
      acquireInstanceLock(lockPath, { ...base, pid: 200, isProcessAlive: (pid) => pid === 100, token: () => 'second' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BootstrapPreflightError);
    expect((thrown as BootstrapPreflightError).code).toBe('INSTANCE_ALREADY_RUNNING');
    // The first owner's lock is untouched.
    expect(parseLockRecord(readFileSync(lockPath, 'utf8'))?.token).toBe('first');
    first.release();
  });

  it('takes over a stale lock whose pid is gone', () => {
    const lockPath = tempLockPath();
    writeLock(lockPath, { pid: 100, startedAt: 'x', bootTimeMs: BOOT, token: 'dead' });
    const lock = acquireInstanceLock(lockPath, { ...base, pid: 200, isProcessAlive: () => false, token: () => 'new' });
    expect(parseLockRecord(readFileSync(lockPath, 'utf8'))?.token).toBe('new');
    lock.release();
  });

  it('takes over a lock written before a reboot even if its pid is alive now (pid reuse)', () => {
    const lockPath = tempLockPath();
    writeLock(lockPath, { pid: 100, startedAt: 'x', bootTimeMs: BOOT - 3_600_000, token: 'old-boot' });
    const lock = acquireInstanceLock(lockPath, { ...base, pid: 200, isProcessAlive: () => true, token: () => 'new' });
    expect(parseLockRecord(readFileSync(lockPath, 'utf8'))?.token).toBe('new');
    lock.release();
  });

  it('treats a lock holding our own pid as stale and a corrupt lock as stale', () => {
    const lockPath = tempLockPath();
    writeLock(lockPath, { pid: 300, startedAt: 'x', bootTimeMs: BOOT, token: 'mine-before' });
    acquireInstanceLock(lockPath, { ...base, pid: 300, isProcessAlive: () => true, token: () => 'mine' }).release();
    writeFileSync(lockPath, 'not json');
    const lock = acquireInstanceLock(lockPath, { ...base, pid: 301, isProcessAlive: () => true, token: () => 'after' });
    expect(parseLockRecord(readFileSync(lockPath, 'utf8'))?.token).toBe('after');
    lock.release();
  });

  it('release removes only its own lock and is idempotent', () => {
    const lockPath = tempLockPath();
    const lock = acquireInstanceLock(lockPath, { ...base, pid: 1, token: () => 'ours' });
    writeFileSync(lockPath, JSON.stringify({ pid: 2, startedAt: 'x', bootTimeMs: BOOT, token: 'theirs' }));
    lock.release();
    lock.release();
    expect(parseLockRecord(readFileSync(lockPath, 'utf8'))?.token).toBe('theirs');
  });

  it('fails with INSTANCE_LOCK_UNAVAILABLE when the lock directory cannot be created', () => {
    const lockPath = tempLockPath();
    const blocker = path.dirname(path.dirname(lockPath));
    writeFileSync(path.join(blocker, 'file'), '');
    expect(() => acquireInstanceLock(path.join(blocker, 'file', 'db.lock'), base)).toThrow(
      expect.objectContaining({ code: 'INSTANCE_LOCK_UNAVAILABLE' }),
    );
  });

  it('uses the real process table by default: a live pid (this process) blocks a second acquire', () => {
    const lockPath = tempLockPath();
    const lock = acquireInstanceLock(lockPath);
    expect(() => acquireInstanceLock(lockPath, { pid: process.pid + 1 })).toThrow(
      expect.objectContaining({ code: 'INSTANCE_ALREADY_RUNNING' }),
    );
    lock.release();
  });
});
