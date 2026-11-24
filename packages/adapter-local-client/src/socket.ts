import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
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

/**
 * D2 steps 3-4: `listen(socketPath)`, then `chmod` to 0600 and `lstat` again (a socket, our uid, mode 0600), recording
 * `(dev, ino)`. A mismatch leaves the handle open but unreferenced (see {@link releaseSocket}) and disables the adapter.
 */
export async function bindSocket(server: http.Server, socketPath: string, uid: number): Promise<BindResult> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    return { ok: false, reason: 'SOCKET_BIND_FAILED' };
  }
  try {
    chmodSync(socketPath, 0o600);
    const stat = lstatOrUndefined(socketPath);
    if (stat === undefined || !stat.isSocket() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o600n) {
      server.unref();
      return { ok: false, reason: 'SOCKET_VERIFY_FAILED' };
    }
    return { ok: true, identity: identityOf(stat) };
  } catch {
    server.unref();
    return { ok: false, reason: 'SOCKET_VERIFY_FAILED' };
  }
}

/**
 * D2 end of life: the socket is unlinked only while the path still has the recorded `(dev, ino)`. libuv unlinks the
 * path of a closing pipe server unconditionally, so when the path was replaced the handle is NOT closed (a replaced
 * file is left alone); it is unreferenced, accepts nothing the path can reach, and goes away with the process.
 */
export async function releaseSocket(server: http.Server, socketPath: string, recorded: FileIdentity | undefined): Promise<void> {
  let current: FileIdentity | undefined;
  try {
    current = lstatIdentity(socketPath);
  } catch {
    current = undefined;
  }
  server.closeAllConnections();
  if (current === undefined || sameIdentity(current, recorded)) {
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    try {
      if (sameIdentity(lstatIdentity(socketPath), recorded)) unlinkSync(socketPath);
    } catch {
      // already gone
    }
    return;
  }
  server.unref();
}
