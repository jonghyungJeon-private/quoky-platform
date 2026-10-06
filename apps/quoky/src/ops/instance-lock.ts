import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BootstrapPreflightError } from '../bootstrap-preflight';

/**
 * ADR-0102 D4 single-instance lock. One Quoky process may own a database: startup creates `<db>.lock` exclusively
 * (written to a private temp file, then hard-linked into place, so the lock is never seen half-written) holding the
 * pid, start time and host boot time. A second process on the same database fails before `storage.init()`.
 *
 * A lock is stale — and is taken over — only when its owner is gone: the recorded pid no longer exists, or the
 * host has rebooted since it was written (a pid recorded before a reboot can belong to an unrelated process now).
 * Accepted residual R1 (no storage compare-and-set) stays accepted only while this lock guarantees one writer.
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
    'Could not create the database lock file next to QUOKY_DB_PATH. Check that the directory exists and is writable by you.',
};

/** Boot times closer than this are the same boot (uptime-derived boot time jitters by about a second). */
const SAME_BOOT_TOLERANCE_MS = 120_000;

export interface InstanceLockRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly bootTimeMs: number;
  readonly token: string;
}

export interface InstanceLockDeps {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly bootTimeMs?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly token?: () => string;
}

export interface InstanceLock {
  readonly path: string;
  /** Removes the lock if it is still ours. Idempotent and synchronous (safe in a process `exit` handler). */
  release(): void;
}

/** `<db>.lock` beside the database; `undefined` for an in-memory or unset database (nothing to protect). */
export function instanceLockPath(dbPath: string): string | undefined {
  if (dbPath === '' || dbPath === ':memory:') return undefined;
  return `${path.resolve(dbPath)}.lock`;
}

export function acquireInstanceLock(lockPath: string, deps: InstanceLockDeps = {}): InstanceLock {
  const pid = deps.pid ?? process.pid;
  const bootTimeMs = deps.bootTimeMs ?? hostBootTimeMs;
  const isAlive = deps.isProcessAlive ?? isProcessAlive;
  const record: InstanceLockRecord = {
    pid,
    startedAt: (deps.now ?? (() => new Date()))().toISOString(),
    bootTimeMs: bootTimeMs(),
    token: (deps.token ?? randomUUID)(),
  };
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  }

  // One takeover attempt at most: create, and if a stale lock is in the way, remove it and create once more.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryCreate(lockPath, record)) return ownedLock(lockPath, record.token);
    const existingText = readLockText(lockPath);
    if (existingText === undefined) continue; // vanished between our create and read: try again
    const existing = parseLockRecord(existingText);
    const stale =
      existing === undefined ||
      Math.abs(existing.bootTimeMs - record.bootTimeMs) > SAME_BOOT_TOLERANCE_MS ||
      // Our own pid in the lock means its writer is gone (pid reuse): we are that pid now.
      existing.pid === pid ||
      !isAlive(existing.pid);
    if (!stale) throw lockError(InstanceLockErrorCode.INSTANCE_ALREADY_RUNNING);
    // Remove only the exact stale lock we inspected, never a fresh one another starter just wrote.
    if (readLockText(lockPath) === existingText) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
  throw lockError(InstanceLockErrorCode.INSTANCE_ALREADY_RUNNING);
}

export function parseLockRecord(text: string): InstanceLockRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<InstanceLockRecord> | null;
    if (
      value &&
      Number.isSafeInteger(value.pid) &&
      typeof value.startedAt === 'string' &&
      typeof value.bootTimeMs === 'number' &&
      typeof value.token === 'string'
    ) {
      return value as InstanceLockRecord;
    }
  } catch {
    /* corrupt */
  }
  return undefined;
}

function tryCreate(lockPath: string, record: InstanceLockRecord): boolean {
  const tempPath = `${lockPath}.${record.token}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  }
  try {
    linkSync(tempPath, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw lockError(InstanceLockErrorCode.INSTANCE_LOCK_UNAVAILABLE);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
  }
}

function ownedLock(lockPath: string, token: string): InstanceLock {
  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      const current = readLockText(lockPath);
      if (current !== undefined && parseLockRecord(current)?.token === token) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

function readLockText(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

function hostBootTimeMs(): number {
  return Date.now() - Math.round(os.uptime() * 1000);
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
