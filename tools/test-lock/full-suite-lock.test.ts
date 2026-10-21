import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM helper without type declarations (tools/ is outside the TypeScript build)
import { MISSING_OWNER_GRACE_MS, acquire, defaultLockDir, isStale, readOwner, recordChild, release, tryAcquire } from './full-suite-lock.mjs';
import { readdirSync } from 'node:fs';

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
      env: { ...process.env, QUOKY_LOCK_DIR: resolve(dir, '..'), QUOKY_TEST_NO_WAIT: '1', QUOKY_TEST_LOCK_DRY_RUN: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain(`full-suite lock held by pid ${process.pid}`);
    expect(readOwner(dir)).toMatchObject({ pid: process.pid, cwd: '/elsewhere' });
  });

  // The wrapper never starts vitest here: QUOKY_TEST_LOCK_DRY_RUN=1 exits right after the lock handling.
  function wrapper(args: string[], dir: string, extra: Record<string, string> = {}) {
    return spawnSync(process.execPath, [resolve(__dirname, 'run-full-suite.mjs'), ...args], {
      env: { ...process.env, QUOKY_LOCK_DIR: resolve(dir, '..'), QUOKY_TEST_LOCK_DRY_RUN: '1', ...extra },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }
  const thisFile = resolve(__dirname, 'full-suite-lock.test.ts');

  it('W1: no lock only when there is a non-option argument and every one is an existing regular file', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: 'now', cwd: '/elsewhere' }));
    const env = { QUOKY_TEST_NO_WAIT: '1' };
    const file = wrapper([thisFile], dir, env);
    expect(file.status).toBe(0);
    expect(file.stderr).toContain('targeted: true');
    // A filter, a directory, no argument, an option only, an option value, or a mix all take the lock (held: exit 75).
    for (const args of [['no-such-file-or-filter'], ['tools'], [], ['--reporter', 'verbose'], [thisFile, 'no-such-file']]) {
      const locked = wrapper(args, dir, env);
      expect(locked.status, JSON.stringify(args)).toBe(75);
    }
    expect(readOwner(dir)).toMatchObject({ pid: process.pid, cwd: '/elsewhere' });
  });

  it('W1: a full run takes the lock, exits 0 on the dry run and releases it; --version and --help never run tests', () => {
    const dir = lockDir();
    const full = wrapper([], dir);
    expect(full.status).toBe(0);
    expect(full.stderr).toContain('full-suite lock taken');
    expect(full.stderr).toContain('dry run: would run vitest run');
    expect(existsSync(dir)).toBe(false);
    for (const flag of ['--version', '-v']) {
      const version = wrapper([flag], dir);
      expect(version.status).toBe(0);
      expect(version.stdout).toMatch(/^vitest\/\d+\.\d+\.\d+/);
      expect(version.stderr).not.toContain('lock taken');
    }
  });

  it('W2: stale when the owner predates the boot, or a live PID is not a node process', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    const write = (owner: object) => writeFileSync(join(dir, 'owner'), JSON.stringify(owner));
    write({ pid: process.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(isStale(dir, Date.now(), { bootTimeMs: Date.now() - 60_000 })).toBe(true);
    expect(isStale(dir, Date.now(), { bootTimeMs: Date.now() - 2 * 3_600_000 })).toBe(false);
    write({ pid: process.pid, startedAt: new Date().toISOString() });
    expect(isStale(dir, Date.now(), { commandOf: () => '/usr/sbin/cfprefsd agent' })).toBe(true);
    expect(isStale(dir, Date.now(), { commandOf: () => '/opt/homebrew/bin/node vitest.mjs run' })).toBe(false);
    expect(isStale(dir)).toBe(false);
  });

  it('W3: a stale takeover renames the lock aside and removes it; a lock replaced in between is put back', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    expect(tryAcquire(dir)).toEqual({ acquired: true });
    expect(readOwner(dir)).toMatchObject({ pid: process.pid });
    expect(readdirSync(join(dir, '..')).filter((name) => name.includes('.stale.'))).toEqual([]);
    release(dir);

    // Race: after the stale judgement another waiter replaces the lock with a live one: we must not remove it.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    const result = tryAcquire(dir, {}, {
      afterJudge: () => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), tag: 'fresh' }));
      },
    });
    expect(result.acquired).toBe(false);
    expect(readOwner(dir)).toMatchObject({ pid: process.pid, tag: 'fresh' });
  });

  it('W4: the watchdog kills a process whose wrapper PID is gone, and leaves one whose wrapper lives', async () => {
    const watchdog = resolve(__dirname, 'wrapper-watchdog.cjs');
    const run = (wrapperPid: number, waitMs: number) =>
      spawnSync(process.execPath, ['--require', watchdog, '-e', `setTimeout(() => process.exit(0), ${waitMs})`], {
        env: { ...process.env, QUOKY_TEST_WRAPPER_PID: String(wrapperPid), QUOKY_TEST_WATCHDOG_MS: '100' },
        encoding: 'utf8',
        timeout: 15_000,
      });
    expect(run(DEAD_PID, 8_000).signal).toBe('SIGKILL');
    expect(run(process.pid, 600).status).toBe(0);
  });
});
