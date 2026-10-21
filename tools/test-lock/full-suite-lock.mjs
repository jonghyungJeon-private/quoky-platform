// Machine-wide lock for the FULL test suite (2026-10-21 harness hardening).
//
// Incident (2026-10-16): several full `pnpm test` runs at once (one vitest worker is ~3.5 GB on an 18 GB machine) filled
// swap and froze the PC. Only one full suite may run on this machine at a time, across every worktree and agent.
//
// Design: an atomic `mkdir` lock directory (default `~/Library/Application Support/Quoky/locks/full-suite`, override
// with QUOKY_LOCK_DIR for the parent directory) holding an `owner` file with the holder's PID, the vitest child PID once
// spawned, the start time and the working tree. The lock is stale when neither PID is alive (a SIGKILLed wrapper whose
// vitest child is still running keeps the lock, so orphaned workers are not doubled up), or when the owner file never
// appeared within a grace period. A stale lock is taken over.
//
// Stale also when the owner was recorded before the last boot (PIDs restart), or when a recorded PID is alive but its
// command is not a node process (the PID was reused). The takeover is race-free: the stale lock directory is renamed
// aside atomically (only one waiter wins the rename), the moved owner is checked to be the one judged stale, and only
// then is it removed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';

export const OWNER_FILE = 'owner';
/** An owner file is written right after `mkdir`; a lock dir older than this without one is a crashed acquire. */
export const MISSING_OWNER_GRACE_MS = 10_000;

export function defaultLockDir(env = process.env) {
  const parent = env.QUOKY_LOCK_DIR && env.QUOKY_LOCK_DIR.trim() !== '' ? env.QUOKY_LOCK_DIR : join(homedir(), 'Library', 'Application Support', 'Quoky', 'locks');
  return join(parent, 'full-suite');
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else; it is alive.
    return error && error.code === 'EPERM';
  }
}

/** The command line of a PID (`ps -o command= -p`), or undefined when it cannot be read. */
export function commandOf(pid) {
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** A live holder: the PID exists and (when its command can be read) is a node process, not a reused PID. */
function holderAlive(pid, readCommand) {
  if (!isAlive(pid)) return false;
  const command = readCommand(pid);
  return command === undefined || command === '' ? true : command.includes('node');
}

/** The parsed owner file, or undefined when it is missing or unreadable. */
export function readOwner(lockDir) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), 'utf8'));
    return owner && typeof owner === 'object' ? owner : undefined;
  } catch {
    return undefined;
  }
}

function writeOwner(lockDir, owner) {
  const tmp = join(lockDir, `${OWNER_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(owner)}\n`);
  renameSync(tmp, join(lockDir, OWNER_FILE));
}

/**
 * Whether an existing lock directory is stale (no live holder). `env` is for tests: `bootTimeMs`, `commandOf(pid)`.
 */
export function isStale(lockDir, now = Date.now(), env = {}) {
  const owner = readOwner(lockDir);
  if (owner === undefined) {
    try {
      return now - statSync(lockDir).mtimeMs > MISSING_OWNER_GRACE_MS;
    } catch {
      return true;
    }
  }
  const bootTimeMs = env.bootTimeMs ?? Date.now() - uptime() * 1000;
  const startedAt = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : Number.NaN;
  // Recorded before this boot: whatever PID it names now is someone else.
  if (Number.isFinite(startedAt) && startedAt < bootTimeMs) return true;
  const readCommand = env.commandOf ?? commandOf;
  return !holderAlive(owner.pid, readCommand) && !holderAlive(owner.childPid, readCommand);
}

/**
 * One non-blocking attempt. Returns `{ acquired: true }`, or `{ acquired: false, owner }` when a live holder has it.
 * A stale lock is renamed aside atomically, verified, removed, and the attempt retried. `hooks.afterJudge` is for tests.
 */
export function tryAcquire(lockDir, info = {}, hooks = {}) {
  mkdirSync(join(lockDir, '..'), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeOwner(lockDir, { pid: process.pid, startedAt: new Date().toISOString(), cwd: process.cwd(), ...info });
      return { acquired: true };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const judged = readOwner(lockDir);
    if (!isStale(lockDir)) return { acquired: false, owner: judged };
    hooks.afterJudge?.();
    // Take the stale lock over race-free: rename it aside (one waiter wins; ENOENT: someone else already took it).
    const aside = `${lockDir}.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(lockDir, aside);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (JSON.stringify(readOwner(aside)) !== JSON.stringify(judged)) {
      // The directory moved is not the one judged stale (another waiter replaced it in between): put it back. When the lock
      // directory exists again the new holder wins; leave it and retry.
      try {
        renameSync(aside, lockDir);
      } catch {
        // lockDir exists again
      }
      continue;
    }
    rmSync(aside, { recursive: true, force: true });
  }
  return { acquired: false, owner: readOwner(lockDir) };
}

/** Record the vitest child PID so a killed wrapper does not free the lock while its workers still run. */
export function recordChild(lockDir, childPid) {
  const owner = readOwner(lockDir);
  if (owner === undefined || owner.pid !== process.pid) return;
  writeOwner(lockDir, { ...owner, childPid });
}

/** Release only a lock this process holds. */
export function release(lockDir) {
  const owner = readOwner(lockDir);
  if (owner !== undefined && owner.pid !== process.pid) return false;
  rmSync(lockDir, { recursive: true, force: true });
  return true;
}

export function describeOwner(owner) {
  if (owner === undefined) return 'another full suite (owner file not written yet)';
  return `pid ${owner.pid}${owner.childPid ? ` (vitest ${owner.childPid})` : ''} since ${owner.startedAt ?? '?'} in ${owner.cwd ?? '?'}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire, waiting while a live holder has the lock (`noWait`: fail fast instead). `log` gets a line when waiting starts
 * and every `reportEveryMs`. Resolves true when acquired, false when `noWait` and held.
 */
export async function acquire(lockDir, { noWait = false, pollMs = 5_000, reportEveryMs = 60_000, log = () => {}, info = {} } = {}) {
  let lastReport = -Infinity;
  const started = Date.now();
  for (;;) {
    const result = tryAcquire(lockDir, info);
    if (result.acquired) return true;
    if (noWait) {
      log(`full-suite lock held by ${describeOwner(result.owner)}; QUOKY_TEST_NO_WAIT=1, not waiting (lock: ${lockDir})`);
      return false;
    }
    if (Date.now() - lastReport >= reportEveryMs) {
      lastReport = Date.now();
      log(`waiting for the full-suite lock (held by ${describeOwner(result.owner)}; waited ${Math.round((Date.now() - started) / 1000)} s; lock: ${lockDir})`);
    }
    await sleep(pollMs);
  }
}
