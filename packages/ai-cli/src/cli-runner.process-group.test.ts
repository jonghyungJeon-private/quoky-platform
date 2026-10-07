import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainedCliRunner } from './cli-runner';

/**
 * Codex review P2 (timeout escalation): a CLI wrapper whose native child survives SIGKILL of the wrapper and keeps the
 * inherited pipes open must not leave the call pending. The runner signals the whole process group and, one grace
 * period after SIGKILL, settles without `close`.
 */

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeStdin extends FakeStream {
  write(_data: string, callback?: (error?: Error | null) => void): boolean {
    callback?.(null);
    return true;
  }
  end(): void {}
}

/** Ignores every signal and never emits `close`: a wrapper whose surviving grandchild holds the pipes. */
class StubbornChild extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStdin();
  readonly signals: string[] = [];
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

interface Harness {
  child?: StubbornChild;
  spawnOptions?: SpawnOptions;
  groupSignals: Array<[number, string]>;
  created: string[];
  removed: string[];
}

function harness(options: { processGroup: boolean; pid?: number; groupKillThrows?: boolean }) {
  const h: Harness = { groupSignals: [], created: [], removed: [] };
  const runner = createContainedCliRunner({
    killGraceMs: 20,
    processGroup: options.processGroup,
    killProcessGroup: (pid, signal) => {
      h.groupSignals.push([pid, signal]);
      if (options.groupKillThrows) throw new Error('ESRCH');
    },
    parentEnv: { PATH: '/usr/bin:/bin' },
    createTempDir: () => {
      const dir = mkdtempSync(join(realpathSync(tmpdir()), 'quoky-pg-test-'));
      h.created.push(dir);
      return dir;
    },
    removeTempDir: (dir) => {
      h.removed.push(dir);
      rmSync(dir, { recursive: true, force: true });
    },
    spawnFn: (_bin, _args, spawnOptions) => {
      h.spawnOptions = spawnOptions;
      h.child = new StubbornChild(options.pid);
      return h.child as unknown as ChildProcess;
    },
  });
  return { h, runner };
}

describe('contained runner — process-group termination and bounded settle', () => {
  it('spawns the child as a group leader and signals the whole group, then settles as TIMEOUT without `close`', async () => {
    const { h, runner } = harness({ processGroup: true, pid: 4242 });
    const started = Date.now();
    const result = await runner('codex', ['exec', '-'], { cwd: tmpdir(), input: 'prompt', timeoutMs: 20 });

    expect(h.spawnOptions?.detached).toBe(true);
    expect(result).toMatchObject({ code: null, timedOut: true });
    // SIGTERM then SIGKILL, each to the group (negative-pid semantics live in the default kill function).
    expect(h.groupSignals).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
    expect(h.child?.signals).toEqual([]); // the group signal succeeded, so no per-child fallback
    // Settled although `close` never fired: streams destroyed, temp dir removed exactly once.
    expect(h.child?.stdout.destroyed).toBe(true);
    expect(h.child?.stderr.destroyed).toBe(true);
    expect(h.child?.stdin.destroyed).toBe(true);
    expect(h.removed).toEqual(h.created);
    expect(existsSync(h.created[0]!)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('falls back to signalling the child when the group signal fails', async () => {
    const { h, runner } = harness({ processGroup: true, pid: 4242, groupKillThrows: true });
    const result = await runner('codex', [], { cwd: tmpdir(), input: 'prompt', timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(h.groupSignals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.child?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.removed).toEqual(h.created);
  });

  it('without a process group (or a pid) it signals the child directly and still settles', async () => {
    for (const config of [{ processGroup: false, pid: 4242 }, { processGroup: true }]) {
      const { h, runner } = harness(config);
      const result = await runner('claude', ['-p'], { cwd: tmpdir(), input: 'prompt', timeoutMs: 20 });
      expect(result.timedOut).toBe(true);
      expect(h.groupSignals).toEqual([]);
      expect(h.child?.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(h.removed).toEqual(h.created);
    }
  });

  it('a non-timeout termination (stdout overflow) that never closes settles as the containment failure', async () => {
    const { h, runner } = harness({ processGroup: true, pid: 77 });
    const pending = runner('ollama', ['run'], { cwd: tmpdir(), input: 'prompt', timeoutMs: 60_000 });
    h.child?.stdout.emit('data', Buffer.alloc(262_145, 0x61));
    const result = await pending;
    expect(result).toMatchObject({ code: null, timedOut: false, stdout: '' });
    expect(result.stderr).toBe('Provider process exceeded the stdout capture limit.');
    expect(h.groupSignals).toEqual([[77, 'SIGTERM'], [77, 'SIGKILL']]);
    expect(h.removed).toEqual(h.created);
  });
});

// Real processes (POSIX only): a wrapper that dies on SIGKILL while its grandchild ignores SIGTERM and holds the pipes.
const posix = process.platform !== 'win32';
const strayPids: number[] = [];

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return condition();
}

describe.runIf(posix)('contained runner — real wrapper with a SIGTERM-ignoring grandchild', () => {
  // The wrapper ignores SIGTERM too (like a wrapper that only forwards it); the grandchild inherits stdout/stderr.
  const script = (pidFile: string) =>
    `trap '' TERM; (trap '' TERM; exec sleep 30) & echo $! > '${pidFile}'; wait`;

  it.each([true, false])('settles promptly and removes its temp dir (processGroup=%s)', async (processGroup) => {
    const box = mkdtempSync(join(realpathSync(tmpdir()), 'quoky-pg-real-'));
    const pidFile = join(box, 'grandchild.pid');
    let runnerTemp = '';
    const runner = createContainedCliRunner({
      killGraceMs: 150,
      processGroup,
      createTempDir: () => {
        runnerTemp = mkdtempSync(join(realpathSync(tmpdir()), 'quoky-pg-real-child-'));
        return runnerTemp;
      },
    });
    try {
      const started = Date.now();
      const resultPromise = runner('/bin/sh', ['-c', script(pidFile)], { cwd: box, input: '', timeoutMs: 300 });
      expect(await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 2_000)).toBe(true);
      const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
      strayPids.push(grandchild);

      const result = await resultPromise;
      expect(result).toMatchObject({ code: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(existsSync(runnerTemp)).toBe(false);
      if (processGroup) {
        // The group SIGKILL reached the grandchild too.
        expect(await waitUntil(() => !alive(grandchild), 2_000)).toBe(true);
      } else {
        // Without a group the grandchild survives the wrapper's SIGKILL — the bounded settle still returned.
        expect(alive(grandchild)).toBe(true);
      }
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });
});
