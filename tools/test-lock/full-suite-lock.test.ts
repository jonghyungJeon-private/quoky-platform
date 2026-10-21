import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM helper without type declarations (tools/ is outside the TypeScript build)
import { MISSING_OWNER_GRACE_MS, acquire, defaultLockDir, isStale, readOwner, recordChild, release, tryAcquire } from './full-suite-lock.mjs';

// The machine-wide full-suite lock (2026-10-21 harness hardening). Temporary lock directories only; the wrapper is
// spawned only on the path that exits before vitest starts.

const DEAD_PID = 9_999_999;
const dirs: string[] = [];
function lockDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'quoky-lock-'));
  dirs.push(parent);
  return join(parent, 'full-suite');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('full-suite lock', () => {
  it('defaults to ~/Library/Application Support/Quoky/locks/full-suite and honours QUOKY_LOCK_DIR', () => {
    expect(defaultLockDir({})).toMatch(/Library\/Application Support\/Quoky\/locks\/full-suite$/);
    expect(defaultLockDir({ QUOKY_LOCK_DIR: '/x/y' })).toBe('/x/y/full-suite');
  });

  it('mkdir-locks once, records the PID, refuses a second holder while the PID lives, and releases', () => {
    const dir = lockDir();
    expect(tryAcquire(dir)).toEqual({ acquired: true });
    expect(readOwner(dir)).toMatchObject({ pid: process.pid });
    const second = tryAcquire(dir);
    expect(second.acquired).toBe(false);
    expect(second.owner.pid).toBe(process.pid);
    recordChild(dir, 4242);
    expect(readOwner(dir)).toMatchObject({ pid: process.pid, childPid: 4242 });
    expect(release(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('takes over a stale lock (holder and child gone) but not one whose vitest child still runs', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    expect(isStale(dir)).toBe(true);
    expect(tryAcquire(dir)).toEqual({ acquired: true });
    expect(readOwner(dir)).toMatchObject({ pid: process.pid });
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, childPid: process.pid }));
    expect(isStale(dir)).toBe(false);
    expect(tryAcquire(dir).acquired).toBe(false);
    // Someone else's lock is never released by this process.
    expect(release(dir)).toBe(false);
  });

  it('a lock dir without an owner file is stale only after the grace period', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    expect(isStale(dir)).toBe(false);
    const old = (Date.now() - MISSING_OWNER_GRACE_MS - 5_000) / 1000;
    utimesSync(dir, old, old);
    expect(isStale(dir)).toBe(true);
  });

  it('waits while held and acquires after release; fails fast with noWait', async () => {
    const dir = lockDir();
    expect(tryAcquire(dir).acquired).toBe(true);
    const lines: string[] = [];
    expect(await acquire(dir, { noWait: true, log: (line: string) => lines.push(line) })).toBe(false);
    expect(lines[0]).toContain('QUOKY_TEST_NO_WAIT=1, not waiting');
    const waited: string[] = [];
    setTimeout(() => release(dir), 120);
    expect(await acquire(dir, { pollMs: 20, log: (line: string) => waited.push(line) })).toBe(true);
    expect(waited[0]).toContain('waiting for the full-suite lock');
    release(dir);
  });

  it('`pnpm test` (the wrapper) exits 75 with a message when the lock is held and QUOKY_TEST_NO_WAIT=1', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: 'now', cwd: '/elsewhere' }));
    const result = spawnSync(process.execPath, [resolve(__dirname, 'run-full-suite.mjs')], {
      env: { ...process.env, QUOKY_LOCK_DIR: resolve(dir, '..'), QUOKY_TEST_NO_WAIT: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain(`full-suite lock held by pid ${process.pid}`);
    expect(readOwner(dir)).toMatchObject({ pid: process.pid, cwd: '/elsewhere' });
  });
});
