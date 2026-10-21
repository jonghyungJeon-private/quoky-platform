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
// Stale also when the owner was recorded before the last boot (PIDs restart), or when a recorded PID is alive but is a
// different process than the recorded one (the PID was reused: its command is not node, or its start time does not fit the
// recorded start). A live lock is never moved. Takeovers are serialised by a separate mutex directory
// (`<lock>.takeover`, itself stale after 30 s): inside it the owner is re-read, re-judged stale and required to equal the
// owner judged before; only then is the lock directory removed. Fresh acquirers only ever `mkdir`.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';

export const OWNER_FILE = 'owner';
/** An owner file is written right after `mkdir`; a lock dir older than this without one is a crashed acquire. */
export const MISSING_OWNER_GRACE_MS = 30_000;
/** A takeover mutex older than this belongs to a crashed taker. */
export const TAKEOVER_MUTEX_STALE_MS = 30_000;
/** `ps` start times have a 1 s resolution; allow this much slack when comparing them to recorded times. */
export const START_TIME_SLACK_MS = 2_000;

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

/** The start time of a PID in ms (`ps -o lstart=`), or undefined when it cannot be read or parsed. */
export function startTimeOf(pid) {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
    if (result.status !== 0) return undefined;
    const parsed = Date.parse(result.stdout.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A live holder: the PID exists, is a node process and started when the recorded process started. `kind` 'wrapper': the
 * wrapper recorded `startedAt` after it started, so a start LATER than that (+ slack) is a reused PID. `kind` 'child':
 * vitest was spawned right before `childStartedAt` (fallback: after `startedAt`), so a start before `anchor - slack` or
 * after `anchor + slack` is a reused PID.
 */
function holderAlive(pid, kind, owner, env) {
  if (!isAlive(pid)) return false;
  const command = (env.commandOf ?? commandOf)(pid);
  if (command !== undefined && command !== '' && !command.includes('node')) return false;
  const started = (env.startTimeOf ?? startTimeOf)(pid);
  if (started === undefined) return true;
  const startedAt = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : Number.NaN;
  if (kind === 'wrapper') return !(Number.isFinite(startedAt) && started > startedAt + START_TIME_SLACK_MS);
  const childStartedAt = typeof owner.childStartedAt === 'string' ? Date.parse(owner.childStartedAt) : Number.NaN;
  if (Number.isFinite(childStartedAt)) return started >= childStartedAt - 5 * START_TIME_SLACK_MS && started <= childStartedAt + START_TIME_SLACK_MS;
  return !(Number.isFinite(startedAt) && started < startedAt - START_TIME_SLACK_MS);
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
  let bootTimeMs = env.bootTimeMs;
  if (bootTimeMs === undefined) {
    try {
      bootTimeMs = Date.now() - (env.uptime ?? uptime)() * 1000;
    } catch {
      // A restricted sandbox refuses the probe (`uv_uptime returned EPERM`). Without a boot time a recorded owner cannot be
      // judged: conservatively treat the lock as held (callers wait, or exit 75 with QUOKY_TEST_NO_WAIT=1).
      return false;
    }
  }
  const startedAt = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : Number.NaN;
  // Recorded before this boot: whatever PID it names now is someone else.
  if (Number.isFinite(startedAt) && startedAt < bootTimeMs) return true;
  try {
    return !holderAlive(owner.pid, 'wrapper', owner, env) && !holderAlive(owner.childPid, 'child', owner, env);
  } catch {
    // A failing `ps` probe: conservatively treat the lock as held.
    return false;
  }
}

/**
 * One non-blocking attempt. Returns `{ acquired: true }`, or `{ acquired: false, owner }` when a live holder has it (or
 * another waiter is taking a stale lock over). `hooks.afterJudge` is for tests (it runs between the first judgement and the
 * takeover mutex, where a race can happen); `hooks.beforeRemove` runs inside the mutex right before the removal.
 */
export function tryAcquire(lockDir, info = {}, hooks = {}) {
  mkdirSync(join(lockDir, '..'), { recursive: true });
  const mutex = `${lockDir}.takeover`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
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
    // Serialise takeovers. A held mutex means another waiter is on it: wait (the caller polls). A crashed taker's mutex is
    // removed after 30 s.
    try {
      mkdirSync(mutex);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(mutex).mtimeMs > TAKEOVER_MUTEX_STALE_MS) rmSync(mutex, { recursive: true, force: true });
      } catch {
        // the mutex is gone already
      }
      return { acquired: false, owner: readOwner(lockDir) };
    }
    // A random token proves the mutex is still ours right before the removal (a stalled taker's mutex can be cleared as
    // stale and re-taken by another waiter).
    const token = randomBytes(12).toString('hex');
    const holdsMutex = () => {
      try {
        return readFileSync(join(mutex, 'token'), 'utf8') === token;
      } catch {
        return false;
      }
    };
    try {
      writeFileSync(join(mutex, 'token'), token);
      // Inside the mutex only the owner identity is compared (no `ps`, which can stall): the lock must still be exactly the
      // owner judged stale (a defined identity), or a lock directory with no owner file older than the grace period.
      const stillJudged = () => {
        const current = readOwner(lockDir);
        if (judged !== undefined) return current !== undefined && JSON.stringify(current) === JSON.stringify(judged);
        if (current !== undefined) return false;
        try {
          return Date.now() - statSync(lockDir).mtimeMs > MISSING_OWNER_GRACE_MS;
        } catch {
          return false;
        }
      };
      if (stillJudged()) {
        hooks.beforeRemove?.();
        // Re-read immediately before removing, and make sure the mutex is still ours.
        if (holdsMutex() && stillJudged()) rmSync(lockDir, { recursive: true, force: true });
      }
    } finally {
      if (holdsMutex()) rmSync(mutex, { recursive: true, force: true });
    }
  }
  return { acquired: false, owner: readOwner(lockDir) };
}

/** Record the vitest child PID so a killed wrapper does not free the lock while its workers still run. */
export function recordChild(lockDir, childPid) {
  const owner = readOwner(lockDir);
  if (owner === undefined || owner.pid !== process.pid) return;
  writeOwner(lockDir, { ...owner, childPid, childStartedAt: new Date().toISOString() });
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
