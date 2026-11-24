import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SOCKET_PATH_BYTES } from './constants';
import { startHarness, tempDataDir } from './test-support';
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

/** A socket file whose owner process was killed: nobody listens, the file stays (a stale socket). */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('stale and hostile socket paths (D2 step 2)', () => {
  it('replaces a stale socket (ECONNREFUSED, owned by us) while the lock is held', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    await leaveStaleSocket(socket);
    expect(lstatSync(socket).isSocket()).toBe(true);
    const h = await start({ dir: d });
    expect(h.adapter.status().listening).toBe(true);
  });

  it('never unlinks a stale socket without the instance lock', async () => {
    const d = dir();
    const socket = path.join(d, 'local-client.sock');
    await leaveStaleSocket(socket);
    const h = await start({ dir: d, instanceLockHeld: false });
    expect(h.adapter.status().disabledReason).toBe('NO_INSTANCE_LOCK');
    expect(lstatSync(socket).isSocket()).toBe(true);
  });

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
    await new Promise<void>((resolve) => theirs.close(() => resolve()));
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
