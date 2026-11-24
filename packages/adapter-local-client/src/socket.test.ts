import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SOCKET_PATH_BYTES } from './constants';
import { bindSocket } from './socket';
import { leaveStaleSocket, startHarness, tempDataDir } from './test-support';
import type { Harness } from './test-support';

const open: Harness[] = [];
const dirs: string[] = [];
async function start(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const harness = await startHarness(options);
  open.push(harness);
  return harness;
}
function dir(): string {
  const made = tempDataDir();
  dirs.push(made);
  return made;
}
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.cleanup();
  for (const made of dirs.splice(0)) {
    try {
      chmodSync(made, 0o700);
    } catch {
      // gone
    }
    rmSync(made, { recursive: true, force: true });
  }
});

describe('stale and hostile socket paths (D2 step 2)', () => {
  // The stale-socket cases (replaced under the lock, never unlinked without it) are in the local-client-surface corpus.

  it('a live socket disables the adapter and is never unlinked or disturbed', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    const live = net.createServer((c) => c.end('still here'));
    await new Promise<void>((resolve) => live.listen(socket, resolve));
    const before = lstatSync(socket, { bigint: true }).ino;
    const h = await start({ dir: d });
    expect(h.adapter.status().disabledReason).toBe('SOCKET_LIVE');
    expect(existsSync(path.join(d, 'local-client.token'))).toBe(false);
    expect(lstatSync(socket, { bigint: true }).ino).toBe(before);
    const answer = await new Promise<string>((resolve) => {
      const c = net.connect(socket);
      c.on('data', (b) => resolve(b.toString()));
    });
    expect(answer).toBe('still here');
    await h.adapter.stop();
    expect(existsSync(socket)).toBe(true);
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });

  it('any other probe errno (EACCES) disables the adapter and never unlinks', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    await leaveStaleSocket(socket);
    chmodSync(socket, 0o000);
    const h = await start({ dir: d });
    expect(h.adapter.status().disabledReason).toBe('SOCKET_PROBE_FAILED');
    expect(existsSync(socket)).toBe(true);
    expect(existsSync(path.join(d, 'local-client.token'))).toBe(false);
  });

  it.each([
    ['a regular file', (p: string) => writeFileSync(p, 'x')],
    ['a directory', (p: string) => mkdirSync(p)],
    ['a symlink to a socket-looking path', (p: string) => symlinkSync('/tmp', p)],
    ['a dangling symlink', (p: string) => symlinkSync('/nonexistent-lc-target', p)],
  ])('%s at the path disables the adapter and is left alone', async (_name, place) => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    place(socket);
    const h = await start({ dir: d });
    expect(h.adapter.status().disabledReason).toBe('SOCKET_PATH_OCCUPIED');
    expect(lstatSync(socket, { throwIfNoEntry: false })).toBeDefined();
    expect(existsSync(path.join(d, 'local-client.token'))).toBe(false);
  });

  it('refuses a data directory that is a symlink', async () => {
    const real = dir();
    const link = path.join(os.tmpdir(), `lc-link-${process.pid}-${Date.now()}`);
    symlinkSync(real, link);
    try {
      const h = await start({ dir: link });
      expect(h.adapter.status().disabledReason).toBe('DATA_DIR_UNSAFE');
      expect(existsSync(path.join(real, 'local-client.sock'))).toBe(false);
    } finally {
      unlinkSync(link);
    }
  });

  it('refuses a missing data directory (it never creates one)', async () => {
    const parent = dir();
    const h = await start({ dir: path.join(parent, 'absent') });
    expect(h.adapter.status().disabledReason).toBe('DATA_DIR_UNSAFE');
    expect(existsSync(path.join(parent, 'absent'))).toBe(false);
  });

  it(`refuses a socket path over ${MAX_SOCKET_PATH_BYTES} UTF-8 bytes (no TCP fallback)`, async () => {
    const parent = dir();
    // multi-byte characters count by bytes, not characters
    const long = path.join(parent, '가'.repeat(30));
    mkdirSync(long, { mode: 0o700 });
    expect(Buffer.byteLength(path.join(long, 'local-client.sock'))).toBeGreaterThan(MAX_SOCKET_PATH_BYTES);
    expect(path.join(long, 'local-client.sock').length).toBeLessThan(MAX_SOCKET_PATH_BYTES + 30);
    const h = await start({ dir: long });
    expect(h.adapter.status()).toMatchObject({ listening: false, disabledReason: 'SOCKET_PATH_TOO_LONG' });
  });
});

function connectErrno(target: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(target);
    c.once('connect', () => {
      c.destroy();
      resolve('CONNECTED');
    });
    c.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'UNKNOWN'));
  });
}

describe('bind by temporary name and no-replace link (D2 steps 3-4)', () => {
  it('a verify failure closes the server: no listener and no file remain', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    const server = http.createServer();
    // A uid that is not ours: the post-bind lstat cannot match, so the bind is refused after listen.
    const result = await bindSocket(server, socket, (process.getuid?.() ?? 0) + 1);
    expect(result).toEqual({ ok: false, reason: 'SOCKET_VERIFY_FAILED' });
    expect(server.listening).toBe(false);
    expect(readdirSync(d)).toEqual([]);
    expect(await connectErrno(socket)).toBe('ENOENT');
  });

  it('never publishes over an entry that appeared at the path after preflight; that entry is left alone', async () => {
    // bindSocket has no check-then-act step left: the pre-created entry is met by the atomic link itself (EEXIST).
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    writeFileSync(socket, 'theirs');
    const before = lstatSync(socket, { bigint: true });
    const server = http.createServer();
    const result = await bindSocket(server, socket, process.getuid?.() ?? 0);
    expect(result).toEqual({ ok: false, reason: 'SOCKET_PATH_OCCUPIED' });
    expect(server.listening).toBe(false);
    const after = lstatSync(socket, { bigint: true });
    expect([after.dev, after.ino, after.nlink]).toEqual([before.dev, before.ino, before.nlink]);
    expect(readFileSync(socket, 'utf8')).toBe('theirs');
    expect(readdirSync(d)).toEqual(['local-client.sock']);
  });

  it('a successful bind leaves the socket with one link only (the temporary name is gone)', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    const server = http.createServer();
    expect((await bindSocket(server, socket, process.getuid?.() ?? 0)).ok).toBe(true);
    expect(lstatSync(socket, { bigint: true }).nlink).toBe(1n);
    expect(readdirSync(d)).toEqual(['local-client.sock']);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a successful bind places the socket at the real path, mode 0600, and returns its (dev, ino)', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    const server = http.createServer();
    const result = await bindSocket(server, socket, process.getuid?.() ?? 0);
    const stat = lstatSync(socket, { bigint: true });
    expect(result).toEqual({ ok: true, identity: { dev: stat.dev, ino: stat.ino } });
    expect(Number(stat.mode & 0o777n)).toBe(0o600);
    expect(readdirSync(d)).toEqual(['local-client.sock']);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // libuv unlinks only the temporary name it bound (already gone): the real path is the adapter's to remove.
    expect(existsSync(socket)).toBe(true);
  });
});

describe('leftover temporary bind names (D2, under the D4 lock)', () => {
  it('removes only a stale socket in the adapter temp-name format; other entries are left alone', async () => {
    const d = dir();
    const staleTemp = path.join(d, '.lc-0a1b2c3d.sock');
    await leaveStaleSocket(staleTemp);
    const plainTemp = path.join(d, '.lc-00ff00ff.sock');
    writeFileSync(plainTemp, 'not a socket');
    const otherName = path.join(d, '.lc-stale.sock');
    await leaveStaleSocket(otherName);
    const liveTemp = path.join(d, '.lc-11223344.sock');
    const live = net.createServer((c) => c.end('live'));
    await new Promise<void>((resolve) => live.listen(liveTemp, resolve));
    const h = await start({ dir: d });
    expect(h.adapter.status().listening).toBe(true);
    expect(existsSync(staleTemp)).toBe(false);
    expect(readFileSync(plainTemp, 'utf8')).toBe('not a socket');
    expect(lstatSync(otherName).isSocket()).toBe(true);
    expect(lstatSync(liveTemp).isSocket()).toBe(true);
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });

  it('never touches temp-named entries without the instance lock', async () => {
    const d = dir();
    const staleTemp = path.join(d, '.lc-0a1b2c3d.sock');
    await leaveStaleSocket(staleTemp);
    const h = await start({ dir: d, instanceLockHeld: false });
    expect(h.adapter.status().disabledReason).toBe('NO_INSTANCE_LOCK');
    expect(lstatSync(staleTemp).isSocket()).toBe(true);
  });
});

describe('end of life by (dev, ino) (D2)', () => {
  it('does not unlink a socket that was replaced after the bind (and leaves the replacement serving)', async () => {
    const d = dir();
    const h = await start({ dir: d });
    const socket = path.join(d, 'local-client.sock');
    // A same-user process swaps the socket while we run (R1): ours moves away, theirs takes the path.
    renameSync(socket, path.join(d, 'moved.sock'));
    const theirs = net.createServer((c) => c.end('theirs'));
    await new Promise<void>((resolve) => theirs.listen(socket, resolve));
    const theirIno = lstatSync(socket, { bigint: true }).ino;
    await h.adapter.stop();
    expect(lstatSync(socket, { bigint: true }).ino).toBe(theirIno);
    const answer = await new Promise<string>((resolve) => {
      const c = net.connect(socket);
      c.on('data', (b) => resolve(b.toString()));
    });
    expect(answer).toBe('theirs');
    // Our server is closed even though its file was moved away: nothing listens behind the moved name any more.
    expect(h.adapter.status().listening).toBe(false);
    expect(await connectErrno(path.join(d, 'moved.sock'))).toBe('ECONNREFUSED');
    await new Promise<void>((resolve) => theirs.close(() => resolve()));
  });

  it('a normal stop closes the server and removes the socket; no temporary bind name is left', async () => {
    const d = dir();
    const h = await start({ dir: d });
    expect(lstatSync(path.join(d, 'local-client.sock')).isSocket()).toBe(true);
    expect(readdirSync(d).sort()).toEqual(['local-client.sock', 'local-client.token']);
    await h.adapter.stop();
    expect(h.adapter.status().listening).toBe(false);
    expect(readdirSync(d)).toEqual([]);
  });

  it('does not unlink a token file that was replaced (different inode)', async () => {
    const d = dir();
    const h = await start({ dir: d });
    const tokenPath = path.join(d, 'local-client.token');
    unlinkSync(tokenPath);
    writeFileSync(tokenPath, 'someone-elses-file\n', { mode: 0o600 });
    await h.adapter.stop();
    expect(readFileSync(tokenPath, 'utf8')).toBe('someone-elses-file\n');
    expect(existsSync(path.join(d, 'local-client.sock'))).toBe(false);
  });

  it('replaces a stale token file left by an unclean stop', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'local-client.token'), 'stale\n', { mode: 0o644 });
    const h = await start({ dir: d });
    expect(h.token()).not.toBe('stale');
    expect(lstatSync(path.join(d, 'local-client.token')).mode & 0o777).toBe(0o600);
  });

  it('writes no token file when the socket checks fail', async () => {
    const d = dir();
    writeFileSync(path.join(d, 'local-client.sock'), 'x');
    await start({ dir: d });
    expect(existsSync(path.join(d, 'local-client.token'))).toBe(false);
  });

  it('opens no TCP listener', async () => {
    const h = await start();
    const handles = (process as unknown as { _getActiveHandles(): Array<{ address?: () => unknown; _type?: string }> })._getActiveHandles();
    const tcp = handles.filter((handle) => handle instanceof net.Server && typeof handle.address === 'function' && typeof handle.address() === 'object');
    expect(tcp).toEqual([]);
    expect(h.adapter.status().listening).toBe(true);
  });
});
