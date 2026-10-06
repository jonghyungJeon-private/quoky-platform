import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BootstrapPreflightError } from '../bootstrap-preflight';
import {
  acquireInstanceLock,
  instanceLockPath,
  parseLockRecord,
  readHostBootId,
  type InstanceLock,
  type InstanceLockDeps,
  type InstanceLockFs,
} from './instance-lock';

const BOOT_A = '11111111-2222-4333-8444-555555555555';
const BOOT_B = '99999999-8888-4777-8666-555555555555';
const LOCK = '/data/quoky.db.lock';
const DEAD_PID = 9;

// ---------------------------------------------------------------------------------------------------------------
// In-memory file system with an op hook, so a test can run another starter "between" any two steps of this one.
// ---------------------------------------------------------------------------------------------------------------
type Store = Map<string, string>;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function memFs(store: Store, beforeOp?: (op: string, file: string) => void): InstanceLockFs {
  return {
    mkdir: (dir) => beforeOp?.('mkdir', dir),
    readdir: (dir) => {
      beforeOp?.('readdir', dir);
      return [...store.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
    },
    readFile: (file) => {
      beforeOp?.('readFile', file);
      const text = store.get(file);
      if (text === undefined) throw errno('ENOENT');
      return text;
    },
    writeNew: (file, text) => {
      beforeOp?.('writeNew', file);
      if (store.has(file)) throw errno('EEXIST');
      store.set(file, text);
    },
    link: (existing, created) => {
      beforeOp?.('link', created);
      const text = store.get(existing);
      if (text === undefined) throw errno('ENOENT');
      if (store.has(created)) throw errno('EEXIST');
      store.set(created, text);
    },
    unlink: (file) => {
      beforeOp?.('unlink', file);
      if (!store.delete(file)) throw errno('ENOENT');
    },
  };
}

function generations(store: Store): number[] {
  return [...store.keys()]
    .map((f) => /\/gen-(\d+)$/.exec(f)?.[1])
    .filter((g): g is string => g !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function topRecord(store: Store) {
  const gens = generations(store);
  const top = gens[gens.length - 1];
  return top === undefined ? undefined : parseLockRecord(store.get(`${LOCK}/gen-${top}`) ?? '');
}

function seedHeld(store: Store, generation: number, record: { pid: number; bootId: string | null; token: string }): void {
  store.set(`${LOCK}/gen-${generation}`, JSON.stringify({ state: 'held', startedAt: 'x', ...record }));
}

/** A simulated starter process. `alive` is the shared process table. */
interface Starter {
  readonly name: string;
  readonly pid: number;
  lock?: InstanceLock;
  error?: string;
}

function runStarter(
  store: Store,
  alive: Set<number>,
  name: string,
  pid: number,
  pauseAt?: { op: number; run: () => void },
  extra: Partial<InstanceLockDeps> = {},
): Starter {
  const starter: Starter = { name, pid };
  let ops = 0;
  let paused = false;
  const fs = memFs(store, () => {
    if (pauseAt && !paused && ops === pauseAt.op) {
      paused = true;
      pauseAt.run();
    }
    ops += 1;
  });
  alive.add(pid);
  try {
    starter.lock = acquireInstanceLock(LOCK, {
      pid,
      fs,
      bootId: () => BOOT_A,
      isProcessAlive: (p) => alive.has(p),
      token: () => `${name}-token`,
      now: () => new Date('2026-10-06T00:00:00.000Z'),
      ...extra,
    });
  } catch (err) {
    starter.error = (err as BootstrapPreflightError).code;
  }
  return starter;
}

/** Number of fs ops a solo starter performs on a store shaped like `seed` (upper bound for pause points). */
function soloOpCount(seed: (store: Store) => void): number {
  const store: Store = new Map();
  seed(store);
  let ops = 0;
  acquireInstanceLock(LOCK, {
    pid: 1,
    fs: memFs(store, () => {
      ops += 1;
    }),
    bootId: () => BOOT_A,
    isProcessAlive: () => false,
    token: () => 'probe',
  });
  return ops;
}

/** Safety: exactly one live holder, and it is the current (highest) generation. */
function expectSingleOwner(store: Store, starters: Starter[]): Starter {
  const owners = starters.filter((s) => s.lock !== undefined);
  expect(owners.map((s) => s.name)).toHaveLength(1);
  const owner = owners[0]!;
  const top = topRecord(store);
  expect(top).toMatchObject({ state: 'held', pid: owner.pid, token: `${owner.name}-token` });
  expect(generations(store).at(-1)).toBe(owner.lock!.generation);
  for (const s of starters) if (s !== owner) expect(s.error).toBe('INSTANCE_ALREADY_RUNNING');
  return owner;
}

describe('instanceLockPath (ADR-0102 D4)', () => {
  it('puts the lock directory beside the database and skips in-memory/unset databases', () => {
    expect(instanceLockPath('/data/quoky.db')).toBe('/data/quoky.db.lock');
    expect(instanceLockPath(':memory:')).toBeUndefined();
    expect(instanceLockPath('')).toBeUndefined();
  });
});

describe('acquireInstanceLock liveness (ADR-0102 D4)', () => {
  it('never takes over a live pid on the same boot (typed error, lock untouched)', () => {
    const store: Store = new Map();
    seedHeld(store, 1, { pid: 100, bootId: BOOT_A, token: 'owner' });
    const alive = new Set([100]);
    const b = runStarter(store, alive, 'b', 200);
    expect(b.error).toBe('INSTANCE_ALREADY_RUNNING');
    expect(generations(store)).toEqual([1]);
    expect(topRecord(store)).toMatchObject({ token: 'owner' });
  });

  it('a wall-clock jump (minutes or years, either direction) cannot make a live owner stale', () => {
    for (const jumpMs of [3 * 60_000, -3 * 60_000, 365 * 86_400_000, -365 * 86_400_000]) {
      const store: Store = new Map();
      const alive = new Set<number>();
      const owner = runStarter(store, alive, 'owner', 100, undefined, { now: () => new Date(1_790_000_000_000) });
      expect(owner.lock).toBeDefined();
      const late = runStarter(store, alive, 'late', 200, undefined, {
        now: () => new Date(1_790_000_000_000 + jumpMs),
      });
      expect(late.error).toBe('INSTANCE_ALREADY_RUNNING');
      expect(topRecord(store)).toMatchObject({ token: 'owner-token' });
    }
  });

  it('fails closed when either boot id is unknown: a live pid is never taken over', () => {
    const store: Store = new Map();
    seedHeld(store, 1, { pid: 100, bootId: BOOT_A, token: 'owner' });
    const alive = new Set([100]);
    expect(runStarter(store, alive, 'b', 200, undefined, { bootId: () => undefined }).error).toBe(
      'INSTANCE_ALREADY_RUNNING',
    );
    const store2: Store = new Map();
    seedHeld(store2, 1, { pid: 100, bootId: null, token: 'owner' });
    expect(runStarter(store2, alive, 'c', 300, undefined, { bootId: () => BOOT_B }).error).toBe(
      'INSTANCE_ALREADY_RUNNING',
    );
  });

  it('takes over a live pid only when the recorded boot id differs (pid reuse after reboot)', () => {
    const store: Store = new Map();
    seedHeld(store, 1, { pid: 100, bootId: BOOT_B, token: 'previous-boot' });
    const alive = new Set([100]); // pid 100 is now some unrelated process
    const b = runStarter(store, alive, 'b', 200);
    expect(b.lock?.generation).toBe(2);
    expect(generations(store)).toEqual([2]);
    expect(topRecord(store)).toMatchObject({ state: 'held', pid: 200, bootId: BOOT_A, token: 'b-token' });
  });

  it('takes over a dead pid, our own pid (previous holder gone) and a corrupt generation', () => {
    const store: Store = new Map();
    seedHeld(store, 1, { pid: DEAD_PID, bootId: BOOT_A, token: 'dead' });
    const alive = new Set<number>();
    expect(runStarter(store, alive, 'a', 100).lock?.generation).toBe(2);
    alive.delete(100);
    seedHeld(store, 3, { pid: 300, bootId: BOOT_A, token: 'mine-before' });
    expect(runStarter(store, alive, 'self', 300).lock?.generation).toBe(4);
    store.set(`${LOCK}/gen-5`, 'not json');
    expect(runStarter(store, alive, 'after', 400).lock?.generation).toBe(6);
    store.set(`${LOCK}/gen-7`, JSON.stringify({ state: 'held', pid: 0, startedAt: 'x', bootId: null, token: 't' }));
    expect(runStarter(store, alive, 'pid0', 500).lock?.generation).toBe(8); // pid 0 is a process group, not an owner
    expect(generations(store)).toEqual([8]);
  });
});

describe('acquireInstanceLock takeover races (Codex P1: no read→unlink window)', () => {
  it('regression: A judges a stale lock, B takes it over meanwhile; A never removes B’s fresh lock', () => {
    const store: Store = new Map();
    seedHeld(store, 1, { pid: DEAD_PID, bootId: BOOT_A, token: 'dead' });
    const alive = new Set<number>();
    let b: Starter | undefined;
    // Pause A right after it read and judged gen-1 (its next op is the temp write for gen-2).
    const a = runStarter(store, alive, 'a', 100, {
      op: 3,
      run: () => {
        b = runStarter(store, alive, 'b', 200);
      },
    });
    expect(b?.lock?.generation).toBe(2);
    expectSingleOwner(store, [a, b!]);
    expect(a.error).toBe('INSTANCE_ALREADY_RUNNING');
  });

  it('regression: A paused for a long time while B takes over, releases, and C takes over; A backs off', () => {
    const store: Store = new Map();
    seedHeld(store, 1, { pid: DEAD_PID, bootId: BOOT_A, token: 'dead' });
    const alive = new Set<number>();
    let b: Starter | undefined;
    let c: Starter | undefined;
    const a = runStarter(store, alive, 'a', 100, {
      op: 3,
      run: () => {
        b = runStarter(store, alive, 'b', 200);
        b.lock!.release();
        alive.delete(200);
        c = runStarter(store, alive, 'c', 300);
      },
    });
    // gen-2 was garbage-collected, so A's create of gen-2 succeeds — and its verify step sees gen-4 and backs off.
    expect(c?.lock?.generation).toBe(4);
    expectSingleOwner(store, [a, c!]);
    expect(store.has(`${LOCK}/gen-2`)).toBe(false);
  });

  const staleSeed = (store: Store) => seedHeld(store, 1, { pid: DEAD_PID, bootId: BOOT_A, token: 'dead' });
  const pausePoints = soloOpCount(staleSeed) + 4;

  it('exhaustive: B runs entirely inside every step of A → exactly one owner', () => {
    for (let k = 0; k < pausePoints; k += 1) {
      const store: Store = new Map();
      staleSeed(store);
      const alive = new Set<number>();
      let b: Starter | undefined;
      const a = runStarter(store, alive, 'a', 100, { op: k, run: () => (b = runStarter(store, alive, 'b', 200)) });
      b ??= runStarter(store, alive, 'b', 200);
      expectSingleOwner(store, [a, b]);
    }
  });

  it('exhaustive: inside every step of A, B (paused at every step for C) acquires; and with B releasing first', () => {
    for (const bReleases of [false, true]) {
      for (let k = 0; k < pausePoints; k += 1) {
        for (let j = 0; j < pausePoints; j += 1) {
          const store: Store = new Map();
          staleSeed(store);
          const alive = new Set<number>();
          let b: Starter | undefined;
          let c: Starter | undefined;
          const a = runStarter(store, alive, 'a', 100, {
            op: k,
            run: () => {
              b = runStarter(store, alive, 'b', 200, { op: j, run: () => (c = runStarter(store, alive, 'c', 300)) });
              if (bReleases && b.lock) {
                b.lock.release();
                b.lock = undefined;
                alive.delete(200);
                c = runStarter(store, alive, 'c2', 300);
              }
            },
          });
          const all = [a, b, c].filter((s): s is Starter => s !== undefined);
          const owners = all.filter((s) => s.lock !== undefined);
          expect(owners, `k=${k} j=${j} release=${bReleases}`).toHaveLength(1);
          expectSingleOwner(
            store,
            all.filter((s) => s.lock !== undefined || s.error !== undefined),
          );
        }
      }
    }
  });

  it('two starters racing for the same next generation: O_EXCL picks one, the other re-judges and is refused', () => {
    const store: Store = new Map();
    staleSeed(store);
    const alive = new Set<number>();
    let b: Starter | undefined;
    // Pause A immediately before it links gen-2 into place.
    let aOps = 0;
    const fs = memFs(store, (op, file) => {
      aOps += 1;
      if (op === 'link' && file.endsWith('/gen-2') && b === undefined) b = runStarter(store, alive, 'b', 200);
    });
    alive.add(100);
    let aError: string | undefined;
    try {
      acquireInstanceLock(LOCK, { pid: 100, fs, bootId: () => BOOT_A, isProcessAlive: (p) => alive.has(p), token: () => 'a' });
    } catch (err) {
      aError = (err as BootstrapPreflightError).code;
    }
    expect(aOps).toBeGreaterThan(0);
    expect(b?.lock?.generation).toBe(2);
    expect(aError).toBe('INSTANCE_ALREADY_RUNNING');
    expect(topRecord(store)).toMatchObject({ token: 'b-token' });
  });
});

describe('InstanceLock.release (ADR-0102 D4)', () => {
  it('writes a released marker above its generation, removes the older ones, and is idempotent', () => {
    const store: Store = new Map();
    const alive = new Set<number>();
    const a = runStarter(store, alive, 'a', 100);
    expect(a.lock?.generation).toBe(1);
    a.lock!.release();
    a.lock!.release();
    expect(generations(store)).toEqual([2]);
    expect(topRecord(store)).toMatchObject({ state: 'released', pid: 100, token: 'a-token' });
    // The pid is still alive (exit handler), yet the next starter takes over at once because the lock was released.
    const b = runStarter(store, alive, 'b', 200);
    expect(b.lock?.generation).toBe(3);
    expect(generations(store)).toEqual([3]);
  });

  it('touches nothing when a newer generation exists', () => {
    const store: Store = new Map();
    const alive = new Set<number>();
    const a = runStarter(store, alive, 'a', 100);
    seedHeld(store, 2, { pid: 200, bootId: BOOT_A, token: 'other' });
    a.lock!.release();
    expect(generations(store)).toEqual([1, 2]);
    expect(topRecord(store)).toMatchObject({ token: 'other' });
  });

  it('never throws, even if the file system fails', () => {
    const store: Store = new Map();
    let broken = false;
    const lock = acquireInstanceLock(LOCK, {
      pid: 1,
      bootId: () => BOOT_A,
      token: () => 't',
      fs: memFs(store, () => {
        if (broken) throw errno('EIO');
      }),
    });
    broken = true;
    expect(() => lock.release()).not.toThrow();
  });
});

describe('readHostBootId', () => {
  it('reads kern.bootsessionuuid on macOS (equality id, no clock), the kernel boot_id on Linux', () => {
    const calls: string[][] = [];
    const id = readHostBootId({
      platform: 'darwin',
      runCommand: (file, args) => {
        calls.push([file, ...args]);
        return `${BOOT_A.toUpperCase()}\n`;
      },
    });
    expect(id).toBe(BOOT_A);
    expect(calls).toEqual([['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid']]);
    expect(readHostBootId({ platform: 'linux', readFile: () => `${BOOT_B}\n` })).toBe(BOOT_B);
  });

  it('is undefined when unreadable, malformed or unsupported', () => {
    expect(
      readHostBootId({
        platform: 'darwin',
        runCommand: () => {
          throw new Error('timeout');
        },
      }),
    ).toBeUndefined();
    expect(readHostBootId({ platform: 'darwin', runCommand: () => '{ sec = 1790810610 }' })).toBeUndefined();
    expect(readHostBootId({ platform: 'win32' })).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('reads a stable id on this host', () => {
    const id = readHostBootId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readHostBootId()).toBe(id);
  });
});

describe('acquireInstanceLock on the real file system', () => {
  const dirs: string[] = [];
  function tempLockPath(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'quoky-lock-'));
    dirs.push(dir);
    return path.join(dir, 'nested', 'quoky.db.lock');
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates a private lock directory with one owner-only generation and no temp file', () => {
    const lockPath = tempLockPath();
    const lock = acquireInstanceLock(lockPath, { pid: 4242, bootId: () => BOOT_A, token: () => 'tok-a' });
    expect(statSync(lockPath).mode & 0o777).toBe(0o700);
    expect(readdirSync(lockPath)).toEqual(['gen-1']);
    const genFile = path.join(lockPath, 'gen-1');
    expect(statSync(genFile).mode & 0o777).toBe(0o600);
    expect(parseLockRecord(readFileSync(genFile, 'utf8'))).toEqual({
      state: 'held',
      pid: 4242,
      startedAt: expect.any(String),
      bootId: BOOT_A,
      token: 'tok-a',
    });
    lock.release();
    expect(readdirSync(lockPath)).toEqual(['gen-2']);
  });

  it('uses the real process table and boot id by default: a live pid (this process) blocks a second acquire', () => {
    const lockPath = tempLockPath();
    const lock = acquireInstanceLock(lockPath);
    let thrown: unknown;
    try {
      acquireInstanceLock(lockPath, { pid: process.pid + 1 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BootstrapPreflightError);
    expect((thrown as BootstrapPreflightError).code).toBe('INSTANCE_ALREADY_RUNNING');
    lock.release();
    acquireInstanceLock(lockPath, { pid: process.pid + 1 }).release();
  });

  it('fails with INSTANCE_LOCK_UNAVAILABLE when the lock directory cannot be created or is a plain file', () => {
    const lockPath = tempLockPath();
    const root = path.dirname(path.dirname(lockPath));
    writeFileSync(path.join(root, 'file'), '');
    expect(() => acquireInstanceLock(path.join(root, 'file', 'db.lock'))).toThrow(
      expect.objectContaining({ code: 'INSTANCE_LOCK_UNAVAILABLE' }),
    );
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '{"pid":1}'); // a single-file lock left by an older build
    expect(() => acquireInstanceLock(lockPath)).toThrow(expect.objectContaining({ code: 'INSTANCE_LOCK_UNAVAILABLE' }));
    expect(existsSync(lockPath)).toBe(true);
  });
});
