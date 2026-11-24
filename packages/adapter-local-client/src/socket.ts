import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import net from 'node:net';
import type http from 'node:http';
import path from 'node:path';

import { MAX_SOCKET_PATH_BYTES, SOCKET_FILE_NAME, SOCKET_PROBE_TIMEOUT_MS } from './constants';
import type { LocalClientDisableReason } from './constants';

/**
 * ADR-0125 D2: the Unix-socket start sequence, in order, and its end of life. Every refusal is a typed reason; the
 * caller disables only this adapter (fail closed) and the rest of Quoky starts. No function here takes a host or a port.
 */

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function identityOf(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

export function sameIdentity(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/** `lstat` without following; `undefined` when the path does not exist (any other error is rethrown). */
export function lstatOrUndefined(target: string): BigIntStats | undefined {
  try {
    return lstatSync(target, { bigint: true });
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return undefined;
    throw err;
  }
}

export function errnoOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

export type ProbeResult = 'connected' | 'refused' | 'other';

/** A connect with a timeout: only `ECONNREFUSED` means "nobody is listening"; everything else is `other`. */
export function probeSocket(socketPath: string, timeoutMs: number = SOCKET_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const client = net.connect(socketPath);
    const done = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done('other'), timeoutMs);
    client.once('connect', () => done('connected'));
    client.once('error', (err) => done(errnoOf(err) === 'ECONNREFUSED' ? 'refused' : 'other'));
  });
}

export interface SocketPreflightInput {
  readonly dataDir: string;
  readonly instanceLockHeld: boolean;
  readonly fileBackedDb: boolean;
  readonly uid?: number;
  readonly probeTimeoutMs?: number;
}

export type SocketPreflight =
  | { readonly ok: true; readonly socketPath: string }
  | { readonly ok: false; readonly reason: LocalClientDisableReason };

/**
 * D2 steps 0-2: the lock and file-backed DB, the path length in UTF-8 bytes, the data directory (a real directory, owned
 * by the process uid, no group or other bits), and an existing path at the socket location. A stale socket (owned by
 * the uid, probe refused) is unlinked, and only here, only because step 0 proved the ADR-0102 D4 lock is held.
 */
export async function preflightSocketPath(input: SocketPreflightInput): Promise<SocketPreflight> {
  if (!input.instanceLockHeld) return { ok: false, reason: 'NO_INSTANCE_LOCK' };
  if (!input.fileBackedDb) return { ok: false, reason: 'DB_NOT_FILE_BACKED' };
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) return { ok: false, reason: 'DATA_DIR_UNSAFE' };
  const socketPath = path.join(path.resolve(input.dataDir), SOCKET_FILE_NAME);
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) return { ok: false, reason: 'SOCKET_PATH_TOO_LONG' };

  try {
    const dir = lstatOrUndefined(path.dirname(socketPath));
    if (dir === undefined || !dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== BigInt(uid) || (dir.mode & 0o077n) !== 0n) {
      return { ok: false, reason: 'DATA_DIR_UNSAFE' };
    }
    const existing = lstatOrUndefined(socketPath);
    if (existing === undefined) return { ok: true, socketPath };
    if (!existing.isSocket() || existing.uid !== BigInt(uid)) return { ok: false, reason: 'SOCKET_PATH_OCCUPIED' };
    const probe = await probeSocket(socketPath, input.probeTimeoutMs);
    if (probe === 'connected') return { ok: false, reason: 'SOCKET_LIVE' };
    if (probe !== 'refused') return { ok: false, reason: 'SOCKET_PROBE_FAILED' };
    // Stale and ours: unlink only if it is still the very file that was probed.
    if (!sameIdentity(identityOf(existing), lstatIdentity(socketPath))) return { ok: false, reason: 'SOCKET_PROBE_FAILED' };
    try {
      unlinkSync(socketPath);
    } catch {
      return { ok: false, reason: 'SOCKET_STALE_UNLINK_FAILED' };
    }
    return { ok: true, socketPath };
  } catch {
    return { ok: false, reason: 'DATA_DIR_UNSAFE' };
  }
}

function lstatIdentity(target: string): FileIdentity | undefined {
  const stat = lstatOrUndefined(target);
  return stat === undefined ? undefined : identityOf(stat);
}

export type BindResult =
  | { readonly ok: true; readonly identity: FileIdentity }
  | { readonly ok: false; readonly reason: LocalClientDisableReason };

/** A random name beside the socket, the same length as `local-client.sock`, so the D2 path-length check covers it. */
function temporaryBindPath(socketPath: string): string {
  return path.join(path.dirname(socketPath), `.lc-${randomBytes(4).toString('hex')}.sock`);
}

/** Close a server (idempotent; resolves when it is not listening). libuv unlinks the name it was bound to. */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

/**
 * D2 steps 3-4. The server binds to a random temporary name inside the 0700 data directory, the socket is `chmod`ed to
 * 0600 and `lstat`ed (a socket, our uid, mode 0600) and its `(dev, ino)` recorded, and only then is it `rename`d onto
 * `local-client.sock` (never over an existing entry). libuv remembers the name it bound and unlinks THAT name on close,
 * which is already gone after the rename, so the adapter can always close the server without touching whatever is at
 * the real path. Any mismatch closes the server and disables the adapter; the real path is removed only while it still
 * has the recorded `(dev, ino)`.
 */
export async function bindSocket(server: http.Server, socketPath: string, uid: number): Promise<BindResult> {
  const tempPath = temporaryBindPath(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(tempPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    await closeServer(server);
    return { ok: false, reason: 'SOCKET_BIND_FAILED' };
  }
  let identity: FileIdentity | undefined;
  try {
    chmodSync(tempPath, 0o600);
    const stat = lstatOrUndefined(tempPath);
    if (stat === undefined || !stat.isSocket() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o600n) {
      await closeServer(server);
      return { ok: false, reason: 'SOCKET_VERIFY_FAILED' };
    }
    const recorded = identityOf(stat);
    // `rename` replaces silently; the path was free at preflight and must still be (nothing is ever clobbered).
    if (lstatOrUndefined(socketPath) !== undefined) {
      await closeServer(server);
      return { ok: false, reason: 'SOCKET_PATH_OCCUPIED' };
    }
    renameSync(tempPath, socketPath);
    identity = recorded;
    if (!sameIdentity(lstatIdentity(socketPath), recorded)) {
      await releaseSocket(server, socketPath, recorded);
      return { ok: false, reason: 'SOCKET_VERIFY_FAILED' };
    }
    return { ok: true, identity: recorded };
  } catch {
    await releaseSocket(server, socketPath, identity);
    return { ok: false, reason: 'SOCKET_VERIFY_FAILED' };
  }
}

/**
 * D2 end of life: the server is always closed (libuv unlinks only the temporary bind name, gone since the rename), and
 * the socket path is unlinked only while it still has the recorded `(dev, ino)`; a replaced file is left alone.
 */
export async function releaseSocket(server: http.Server, socketPath: string, recorded: FileIdentity | undefined): Promise<void> {
  server.closeAllConnections();
  await closeServer(server);
  try {
    if (sameIdentity(lstatIdentity(socketPath), recorded)) unlinkSync(socketPath);
  } catch {
    // already gone, or not ours to remove
  }
}
