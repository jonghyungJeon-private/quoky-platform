import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BootstrapPreflightError } from '../bootstrap-preflight';

/**
 * ADR-0102 D4 single-instance lock. One Quoky process may own a database; a second process on the same database fails
 * with `INSTANCE_ALREADY_RUNNING` before `storage.init()`. Accepted residual R1 (no storage compare-and-set) stays
 * accepted only while this lock guarantees one writer, so the protocol below is race-free by construction, not by
 * timing.
 *
 * ## Layout
 * `<db>.lock/` is a private (0700) directory of **generation files** `gen-<n>` (n = 1, 2, 3, ...). Each generation is
 * created exclusively (`O_EXCL`: written to a private temp file, then hard-linked into place, so it is never seen
 * half-written) and is never rewritten. A generation is either `held` (pid, start time, host boot id, random token) or
 * a `released` marker. The **highest** generation is the lock's current state.
 *
 * ## Acquire (bounded rounds)
 * 1. List the generations; `top` = the highest (0 if none). Read it (vanished → next round).
 * 2. If `top` is `held` and its owner is live → `INSTANCE_ALREADY_RUNNING`. It is free when it is a `released` marker,
 *    unreadable/corrupt, or its owner is gone (see Liveness).
 * 3. Create `gen-<top+1>` exclusively. `EEXIST` → another starter got there first → next round (re-judge its owner).
 * 4. Verify: list again; if any generation higher than ours exists, ours is not the lock — delete ours, next round.
 * 5. Otherwise we own the lock. Delete the generations below ours (garbage only).
 *
 * Nothing ever removes or renames the current (highest) generation: takeover moves *forward* by creating `top+1`, and
 * deletions touch only generations below an existing higher one (step 4/5 and release). That is what makes the
 * protocol safe without an atomic compare-and-delete, which POSIX does not offer for files:
 * - Two starters judging the same stale `top` both try to create `top+1`; `O_EXCL` lets exactly one win, and the loser
 *   re-judges the winner (alive → refused).
 * - A starter paused for any length of time after judging `top` stale can only create a generation whose name is free.
 *   A name below the current maximum is free only after it was garbage-collected, which happens only once a higher
 *   generation exists — and the maximum is never deleted, so the paused starter's step-4 listing always sees it and
 *   backs off. It can never remove someone else's lock (the race the previous unlink-based takeover had).
 * - A generation is judged once, by content, and never re-read for a removal decision, so no read→unlink window
 *   exists.
 *
 * ## Liveness (never a clock heuristic)
 * A `held` owner is gone only when (a) `kill(pid, 0)` reports the pid does not exist (`ESRCH`; `EPERM` means it exists),
 * or (b) the pid is our own (a live process with our pid is us, and we have not written the lock), or (c) the pid is
 * alive but the recorded host **boot id** differs from the current one — the only way a live pid can be someone else's
 * reused number. The boot id is an opaque per-boot identifier compared for equality only (macOS
 * `kern.bootsessionuuid`, Linux `/proc/sys/kernel/random/boot_id`); wall-clock time is never used, so clock steps
 * cannot make a live owner look stale. If either boot id is unknown, the boots are treated as the same (fail closed: a
 * live pid is never taken over).
 *
 * ## Release
 * On exit the owner, if the highest generation is still its own, creates a `released` marker at `own+1` and deletes
 * the generations below the marker. If that cannot be done the generation simply stays, and the next starter takes it
 * over because the pid is gone.
 */
export const InstanceLockErrorCode = {
  INSTANCE_ALREADY_RUNNING: 'INSTANCE_ALREADY_RUNNING',
  INSTANCE_LOCK_UNAVAILABLE: 'INSTANCE_LOCK_UNAVAILABLE',
} as const;
export type InstanceLockErrorCode = (typeof InstanceLockErrorCode)[keyof typeof InstanceLockErrorCode];

const HINTS: Readonly<Record<InstanceLockErrorCode, string>> = {
  INSTANCE_ALREADY_RUNNING:
    'Another Quoky process is using this database. Stop it first (`ops/launchd/quokyctl.sh status` shows the service), or point this run at a different QUOKY_DB_PATH.',
  INSTANCE_LOCK_UNAVAILABLE:
    'Could not use the lock directory `<QUOKY_DB_PATH>.lock`. Check that the database directory exists and is writable by you, and that `<QUOKY_DB_PATH>.lock` is a directory (a plain file left by an older build can be removed while no Quoky process runs).',
};

/** Rounds of the acquire loop; every extra round is caused by a concurrent starter making progress. */
const MAX_ROUNDS = 8;
const GENERATION_NAME = /^gen-([1-9]\d{0,14})$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HeldLockRecord {
  readonly state: 'held';
  readonly pid: number;
  readonly startedAt: string;
  /** Opaque host boot identifier; `null` when it could not be read. */
  readonly bootId: string | null;
  readonly token: string;
}
export interface ReleasedLockRecord {
  readonly state: 'released';
  readonly pid: number;
  readonly releasedAt: string;
  readonly token: string;
}
export type InstanceLockRecord = HeldLockRecord | ReleasedLockRecord;

/** The few synchronous file operations the protocol needs (Node-style errors with `code`). A seam for race tests. */
export interface InstanceLockFs {
  /** `mkdir -p` with the given mode for the leaf. */
  mkdir(dir: string, mode: number): void;
  readdir(dir: string): string[];
  readFile(file: string): string;
  /** Create a new file exclusively (`wx`, 0600). */
  writeNew(file: string, text: string): void;
  /** Hard-link; throws `EEXIST` if `created` exists. */
  link(existing: string, created: string): void;
  unlink(file: string): void;
}

export const nodeInstanceLockFs: InstanceLockFs = {
  mkdir: (dir, mode) => {
    mkdirSync(path.dirname(dir), { recursive: true });
    mkdirSync(dir, { recursive: true, mode });
  },
  readdir: (dir) => readdirSync(dir),
  readFile: (file) => readFileSync(file, 'utf8'),
  writeNew: (file, text) => writeFileSync(file, text, { mode: 0o600, flag: 'wx' }),
  link: (existing, created) => linkSync(existing, created),
  unlink: (file) => unlinkSync(file),
};

export interface InstanceLockDeps {
  readonly pid?: number;
  readonly now?: () => Date;
  /** Current host boot id (equality-compared only); `undefined` when unknown. */
  readonly bootId?: () => string | undefined;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly token?: () => string;
  readonly fs?: InstanceLockFs;
}

export interface InstanceLock {
  readonly path: string;
  /** The generation this process owns. */
  readonly generation: number;
  /** Releases the lock if it is still ours. Idempotent, synchronous and never throws (safe in a process `exit` handler). */
  release(): void;
}

/** `<db>.lock` (a directory) beside the database; `undefined` for an in-memory or unset database. */
export function instanceLockPath(dbPath: string): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return `${path.resolve(dbPath)}.lock`;
}

export function acquireInstanceLock(lockDir: string, deps: InstanceLockDeps = {}): InstanceLock {
  const fs = deps.fs ?? nodeInstanceLockFs;
  const now = deps.now ?? (() => new Date());
  const self: Self = {
    pid: deps.pid ?? process.pid,
    bootId: (deps.bootId ?? readHostBootId)(),
    isAlive: deps.isProcessAlive ?? isProcessAlive,
  };
  const record: HeldLockRecord = {
    state: 'held',
    pid: self.pid,
    startedAt: now().toISOString(),
    bootId: self.bootId ?? null,
    token: (deps.token ?? randomUUID)(),
  };
  try {
    fs.mkdir(lockDir, 0o700);
  } catch {
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const top = highestGeneration(fs, lockDir);
    if (top > 0) {
      const text = readOrUndefined(fs, generationPath(lockDir, top));
      if (text === undefined) continue; // superseded while we listed: look again
      if (!isFree(parseLockRecord(text), self)) throw lockError(InstanceLockErrorCode.INSTANCE_ALREADY_RUNNING);
    }
    const mine = top + 1;
    if (!createGeneration(fs, lockDir, mine, record)) continue; // another starter won gen `mine`: judge it next round
    if (highestGeneration(fs, lockDir) > mine) {
      // A newer generation exists, so `mine` reused a garbage-collected name and is not the lock. Back off.
      removeQuietly(fs, generationPath(lockDir, mine));
      continue;
    }
    removeGenerationsBelow(fs, lockDir, mine);
    return ownedLock(fs, lockDir, mine, record, now);
  }
  throw lockError(InstanceLockErrorCode.INSTANCE_ALREADY_RUNNING);
}

export function parseLockRecord(text: string): InstanceLockRecord | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') return undefined;
    // pid must be a real process id: kill(0 or negative) addresses process groups, never a single owner.
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.token !== 'string') {
      return undefined;
    }
    if (
      value.state === 'held' &&
      typeof value.startedAt === 'string' &&
      (value.bootId === null || typeof value.bootId === 'string')
    ) {
      return value as unknown as HeldLockRecord;
    }
    if (value.state === 'released' && typeof value.releasedAt === 'string') {
      return value as unknown as ReleasedLockRecord;
    }
  } catch {
    /* corrupt */
  }
  return undefined;
}

interface Self {
  readonly pid: number;
  readonly bootId: string | undefined;
  readonly isAlive: (pid: number) => boolean;
}

/** Whether the current generation may be superseded. A live pid is live unless the host provably rebooted since. */
function isFree(existing: InstanceLockRecord | undefined, self: Self): boolean {
  if (existing === undefined || existing.state === 'released') return true;
  if (existing.pid === self.pid) return true; // a live process with our pid is us, and we hold no lock yet
  if (!self.isAlive(existing.pid)) return true;
  // Alive: only a known, different boot id proves the pid number was reused after a reboot.
  return existing.bootId !== null && self.bootId !== undefined && existing.bootId !== self.bootId;
}

function generationPath(lockDir: string, generation: number): string {
  return path.join(lockDir, `gen-${generation}`);
}

function listGenerations(fs: InstanceLockFs, lockDir: string): number[] {
  let names: string[];
  try {
    names = fs.readdir(lockDir);
  } catch {
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  }
  const generations: number[] = [];
  for (const name of names) {
    const match = GENERATION_NAME.exec(name);
    if (match) generations.push(Number(match[1]));
  }
  return generations;
}

function highestGeneration(fs: InstanceLockFs, lockDir: string): number {
  return listGenerations(fs, lockDir).reduce((max, g) => (g > max ? g : max), 0);
}

/** Exclusive create of `gen-<generation>`: `false` if it already exists. Never seen half-written. */
function createGeneration(fs: InstanceLockFs, lockDir: string, generation: number, record: InstanceLockRecord): boolean {
  const tempPath = path.join(lockDir, `tmp-${record.token}-${record.state}-${generation}`);
  try {
    fs.writeNew(tempPath, `${JSON.stringify(record)}\n`);
  } catch {
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  }
  try {
    fs.link(tempPath, generationPath(lockDir, generation));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  } finally {
    removeQuietly(fs, tempPath);
  }
}

/** Garbage-collects generations strictly below `generation` (which exists), so never the current one. */
function removeGenerationsBelow(fs: InstanceLockFs, lockDir: string, generation: number): void {
  let generations: number[];
  try {
    generations = listGenerations(fs, lockDir);
  } catch {
    return;
  }
  for (const g of generations) if (g < generation) removeQuietly(fs, generationPath(lockDir, g));
}

function ownedLock(
  fs: InstanceLockFs,
  lockDir: string,
  generation: number,
  record: HeldLockRecord,
  now: () => Date,
): InstanceLock {
  let released = false;
  return {
    path: lockDir,
    generation,
    release(): void {
      if (released) return;
      released = true;
      try {
        if (highestGeneration(fs, lockDir) !== generation) return;
        const current = readOrUndefined(fs, generationPath(lockDir, generation));
        if (current === undefined || parseLockRecord(current)?.token !== record.token) return;
        const marker: ReleasedLockRecord = {
          state: 'released',
          pid: record.pid,
          releasedAt: now().toISOString(),
          token: record.token,
        };
        if (!createGeneration(fs, lockDir, generation + 1, marker)) return;
        removeGenerationsBelow(fs, lockDir, generation + 1);
      } catch {
        /* best effort: a generation left behind is taken over once this pid is gone */
      }
    },
  };
}

function readOrUndefined(fs: InstanceLockFs, file: string): string | undefined {
  try {
    return fs.readFile(file);
  } catch {
    return undefined;
  }
}

function removeQuietly(fs: InstanceLockFs, file: string): void {
  try {
    fs.unlink(file);
  } catch {
    /* already gone */
  }
}

export interface BootIdSources {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: (file: string, args: readonly string[]) => string;
  readonly readFile?: (file: string) => string;
}

/**
 * The host boot identifier: an opaque per-boot UUID (macOS `sysctl -n kern.bootsessionuuid`, bounded to 2 s; Linux
 * `/proc/sys/kernel/random/boot_id`). Not derived from any clock. `undefined` when it cannot be read or looks wrong.
 */
export function readHostBootId(sources: BootIdSources = {}): string | undefined {
  const platform = sources.platform ?? process.platform;
  const runCommand =
    sources.runCommand ??
    ((file: string, args: readonly string[]) =>
      execFileSync(file, args, { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }));
  const readFile = sources.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
  try {
    let raw: string;
    if (platform === 'darwin') raw = runCommand('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
    else if (platform === 'linux') raw = readFile('/proc/sys/kernel/random/boot_id');
    else return undefined;
    const id = raw.trim().toLowerCase();
    return BOOT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `kill(pid, 0)`: ESRCH means gone; EPERM means it exists under another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockError(code: InstanceLockErrorCode): BootstrapPreflightError {
  return new BootstrapPreflightError(code, HINTS[code]);
}
