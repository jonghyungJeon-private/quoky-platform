import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM helper without type declarations (tools/ is outside the TypeScript build)
import { MISSING_OWNER_GRACE_MS, acquire, defaultLockDir, isStale, readOwner, recordChild, release, startTimeOf, tryAcquire } from './full-suite-lock.mjs';
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
    expect(isStale(dir, Date.now(), { bootTimeMs: Date.now() - 2 * 3_600_000, startTimeOf: () => undefined })).toBe(false);
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

  it('R3: takeovers are serialised by a mutex: an interleaved takeover never removes a lock that was replaced meanwhile', () => {
    const dir = lockDir();
    const stale = () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    };
    // B judged the lock stale; before it takes the mutex, C took over and a fresh acquirer A holds the lock.
    stale();
    const fresh = { pid: process.pid, startedAt: new Date().toISOString(), tag: 'A' };
    const b = tryAcquire(dir, { tag: 'B' }, {
      afterJudge: () => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        writeFileSync(join(dir, 'owner'), JSON.stringify(fresh));
      },
    });
    expect(b.acquired).toBe(false);
    expect(readOwner(dir)).toEqual(fresh);
    expect(existsSync(`${dir}.takeover`)).toBe(false);
    expect(readdirSync(join(dir, '..')).filter((name) => name.includes('.stale.'))).toEqual([]);
    release(dir);

    // Two interleaved takeovers of one stale lock plus a fresh acquirer: exactly one holder at the end.
    stale();
    const winners: string[] = [];
    const first = tryAcquire(dir, { tag: 'B' }, {
      afterJudge: () => {
        // while B is between judging and the mutex, C runs a whole takeover and a fresh acquirer D mkdirs behind it
        const c = tryAcquire(dir, { tag: 'C' });
        if (c.acquired) winners.push('C');
        const d = tryAcquire(dir, { tag: 'D' });
        if (d.acquired) winners.push('D');
      },
    });
    if (first.acquired) winners.push('B');
    expect(winners).toEqual(['C']);
    expect(readOwner(dir)).toMatchObject({ tag: 'C' });
  });

  it('R3: a held takeover mutex defers the taker; a crashed taker\'s mutex is cleared after 30 s', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    mkdirSync(`${dir}.takeover`);
    expect(tryAcquire(dir).acquired).toBe(false);
    expect(readOwner(dir)).toMatchObject({ pid: DEAD_PID });
    const old = (Date.now() - 40_000) / 1000;
    utimesSync(`${dir}.takeover`, old, old);
    expect(tryAcquire(dir).acquired).toBe(false); // clears the dead mutex ...
    expect(existsSync(`${dir}.takeover`)).toBe(false);
    expect(tryAcquire(dir).acquired).toBe(true); // ... and the next attempt takes over
  });

  it('R3: a lock dir without an owner file is never removed while fresh (mkdir to writeOwner window), only after 30 s', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    expect(tryAcquire(dir).acquired).toBe(false);
    expect(existsSync(dir)).toBe(true);
    const old = (Date.now() - MISSING_OWNER_GRACE_MS - 5_000) / 1000;
    utimesSync(dir, old, old);
    // the owner file appears while the taker is between judging and the mutex: the identity differs, nothing is removed
    const racing = tryAcquire(dir, {}, { afterJudge: () => writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), tag: 'A' })) });
    expect(racing.acquired).toBe(false);
    expect(readOwner(dir)).toMatchObject({ tag: 'A' });
    release(dir);
    mkdirSync(dir);
    utimesSync(dir, old, old);
    expect(tryAcquire(dir).acquired).toBe(true);
  });

  it('R4: a reused PID is stale: the process started after the recorded start (wrapper) or outside the recorded spawn (child)', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    const write = (owner: object) => writeFileSync(join(dir, 'owner'), JSON.stringify(owner));
    const t0 = Date.now() - 600_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const node = () => '/opt/homebrew/bin/node run-full-suite.mjs';
    const boot = { bootTimeMs: t0 - 3_600_000, commandOf: node };
    write({ pid: process.pid, startedAt: iso(t0) });
    // the wrapper started long before it recorded startedAt (it may have waited for the lock): alive
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 - 300_000 })).toBe(false);
    // started well after the recorded start: a reused PID
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 + 60_000 })).toBe(true);
    // within the 2 s slack: alive
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 + 1_000 })).toBe(false);
    // child: vitest was recorded right after its spawn
    write({ pid: DEAD_PID, startedAt: iso(t0), childPid: process.pid, childStartedAt: iso(t0 + 5_000) });
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 + 4_500 })).toBe(false);
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 - 200_000 })).toBe(true);
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 + 500_000 })).toBe(true);
    // child without childStartedAt: only a start before the owner started is a reuse
    write({ pid: DEAD_PID, startedAt: iso(t0), childPid: process.pid });
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 - 60_000 })).toBe(true);
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => t0 + 60_000 })).toBe(false);
    // unreadable start time: assume alive
    expect(isStale(dir, Date.now(), { ...boot, startTimeOf: () => undefined })).toBe(false);
  });

  it('R4: the real ps start time of this process parses and fits the lock the wrapper would record', () => {
    expect(startTimeOf(process.pid)).toBeLessThanOrEqual(Date.now());
    expect(startTimeOf(DEAD_PID)).toBeUndefined();
  });

  it('R5: the token after a value-taking option is not a file, so `--config <file>` locks; `-t <name> <file>` stays targeted', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: 'now', cwd: '/elsewhere' }));
    const env = { QUOKY_TEST_NO_WAIT: '1' };
    expect(wrapper(['--config', 'vitest.config.ts'], dir, env).status).toBe(75);
    expect(wrapper(['-c', 'vitest.config.ts', thisFile], dir, env).status).toBe(0);
    expect(wrapper(['-t', 'some name', thisFile], dir, env).status).toBe(0);
    expect(wrapper(['-t', 'some name'], dir, env).status).toBe(75);
  });

  it('L1: a takeover whose mutex was stolen while it stalled aborts without removing the lock', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    const result = tryAcquire(dir, {}, {
      beforeRemove: () => {
        // the stalled taker's mutex was cleared as stale and another waiter holds its own now
        rmSync(`${dir}.takeover`, { recursive: true, force: true });
        mkdirSync(`${dir}.takeover`);
        writeFileSync(join(`${dir}.takeover`, 'token'), 'someone-elses-token');
      },
    });
    expect(result.acquired).toBe(false);
    expect(readOwner(dir)).toMatchObject({ pid: DEAD_PID });
    // the foreign mutex is not removed by the aborted taker
    expect(existsSync(`${dir}.takeover`)).toBe(true);
    // and with nothing stolen the takeover completes and the mutex is gone
    rmSync(`${dir}.takeover`, { recursive: true });
    expect(tryAcquire(dir).acquired).toBe(true);
    expect(existsSync(`${dir}.takeover`)).toBe(false);
  });

  it('L1: no ps inside the mutex: a live-looking owner that equals the judged one is the only thing compared', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: DEAD_PID, startedAt: 'then' }));
    let changed = false;
    const result = tryAcquire(dir, {}, {
      beforeRemove: () => {
        // the owner changes after the in-mutex check: the final re-read must catch it
        changed = true;
        writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), tag: 'fresh' }));
      },
    });
    expect(changed).toBe(true);
    expect(result.acquired).toBe(false);
    expect(readOwner(dir)).toMatchObject({ tag: 'fresh' });
  });

  it('R5b: a positional must look like a test file AND exist; `--exclude x.test.ts` and a non-test file lock', () => {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner'), JSON.stringify({ pid: process.pid, startedAt: 'now', cwd: '/elsewhere' }));
    const env = { QUOKY_TEST_NO_WAIT: '1' };
    expect(wrapper(['--exclude', 'a.test.ts'], dir, env).status).toBe(75);
    expect(wrapper(['package.json'], dir, env).status).toBe(75);
    expect(wrapper([thisFile], dir, env).status).toBe(0);
  });
});
