import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainedCliRunner, trackedProcessGroups } from './cli-runner';
import type { ProcessGroupKill } from './cli-runner';

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
    // Signal 0 is the existence probe before the group SIGKILL.
    expect(h.groupSignals).toEqual([[4242, 'SIGTERM'], [4242, 0], [4242, 'SIGKILL']]);
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
    expect(h.groupSignals.map(([, signal]) => signal)).toEqual(['SIGTERM', 0, 'SIGKILL']);
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
    expect(h.groupSignals).toEqual([[77, 'SIGTERM'], [77, 0], [77, 'SIGKILL']]);
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

/**
 * Real-process timing under a loaded machine (full suite, a parallel build): the shell must install its TERM trap
 * before the runner's timeout fires, or SIGTERM simply kills it and the scenario never happens. The timeout therefore
 * leaves the shell ample start-up time, readiness is polled with a generous bound (it returns as soon as the pid file
 * appears), and "promptly" is judged against what the bug would cost: without the bounded settle the call stays
 * pending until the 30 s grandchild exits.
 */
const REAL_TIMEOUT_MS = 1_500;
const READY_WITHIN_MS = 10_000;
const GRANDCHILD_LIFETIME_MS = 30_000;
const PROMPT_SETTLE_MS = 10_000;

describe.runIf(posix)('contained runner — real wrapper with a SIGTERM-ignoring grandchild', () => {
  // The wrapper ignores SIGTERM too (like a wrapper that only forwards it); the grandchild inherits stdout/stderr.
  const script = (pidFile: string) =>
    `trap '' TERM; (trap '' TERM; exec sleep ${GRANDCHILD_LIFETIME_MS / 1_000}) & echo $! > '${pidFile}'; wait`;

  it.each([true, false])('settles promptly and removes its temp dir (processGroup=%s)', { timeout: 30_000 }, async (processGroup) => {
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
      const resultPromise = runner('/bin/sh', ['-c', script(pidFile)], { cwd: box, input: '', timeoutMs: REAL_TIMEOUT_MS });
      expect(
        await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', READY_WITHIN_MS),
      ).toBe(true);
      const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
      strayPids.push(grandchild);

      const result = await resultPromise;
      expect(result).toMatchObject({ code: null, timedOut: true });
      // Far below the grandchild's lifetime: the call did not wait for the pipes to close.
      expect(Date.now() - started).toBeLessThan(REAL_TIMEOUT_MS + PROMPT_SETTLE_MS);
      expect(REAL_TIMEOUT_MS + PROMPT_SETTLE_MS).toBeLessThan(GRANDCHILD_LIFETIME_MS);
      expect(existsSync(runnerTemp)).toBe(false);
      if (processGroup) {
        // The group SIGKILL reached the grandchild too.
        expect(await waitUntil(() => !alive(grandchild), READY_WITHIN_MS)).toBe(true);
      } else {
        // Without a group the grandchild survives the wrapper's SIGKILL — the bounded settle still returned.
        expect(alive(grandchild)).toBe(true);
      }
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });
});

describe.runIf(posix)('contained runner — the wrapper exits on SIGTERM before its group is gone (Codex re-review P2)', () => {
  // The wrapper does NOT ignore SIGTERM, so it exits at once and `close` arrives (the grandchild has its own stdio).
  // The grandchild ignores SIGTERM. Group termination must still SIGKILL the group after the grace period.
  const script = (pidFile: string) =>
    `(trap '' TERM; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`;

  it('SIGKILLs the group after the grace period even though close came first, and tracks it until then', { timeout: 30_000 }, async () => {
    const box = mkdtempSync(join(realpathSync(tmpdir()), 'quoky-pg-close-'));
    const pidFile = join(box, 'grandchild.pid');
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    const realGroupKill: ProcessGroupKill = (pid, signal) => {
      sent.push([pid, signal]);
      process.kill(-pid, signal);
    };
    // The grace period must outlast the wrapper's `close` delivery even on a loaded host: the assertions below run
    // inside it (no SIGKILL yet), so a short grace would race the event loop.
    const graceMs = 2_000;
    const runner = createContainedCliRunner({ killGraceMs: graceMs, processGroup: true, killProcessGroup: realGroupKill });
    try {
      const resultPromise = runner('/bin/sh', ['-c', script(pidFile)], { cwd: box, input: '', timeoutMs: REAL_TIMEOUT_MS });
      expect(
        await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', READY_WITHIN_MS),
      ).toBe(true);
      const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
      strayPids.push(grandchild);

      const result = await resultPromise;
      const settledAt = Date.now();
      expect(result).toMatchObject({ code: null, timedOut: true });
      const groupPid = sent[0]?.[0];
      expect(sent[0]).toEqual([groupPid, 'SIGTERM']);
      // Settled at the wrapper's close, inside the grace period: no SIGKILL yet, the grandchild is still alive and the
      // group is still tracked for the exit hook.
      expect(sent.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
      expect(alive(grandchild)).toBe(true);
      expect(trackedProcessGroups()).toContain(groupPid);

      // After the grace period the group was probed and SIGKILLed, the grandchild is dead and the group untracked.
      expect(await waitUntil(() => !alive(grandchild), graceMs + READY_WITHIN_MS)).toBe(true);
      expect(Date.now() - settledAt).toBeLessThan(graceMs + READY_WITHIN_MS);
      expect(sent).toContainEqual([groupPid, 0]);
      expect(sent).toContainEqual([groupPid, 'SIGKILL']);
      expect(trackedProcessGroups()).not.toContain(groupPid);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('a normal exit kills nothing and drops the group from tracking', async () => {
    const sent: Array<NodeJS.Signals | 0> = [];
    const runner = createContainedCliRunner({
      processGroup: true,
      killProcessGroup: (pid, signal) => { sent.push(signal); process.kill(-pid, signal); },
    });
    const result = await runner('/bin/sh', ['-c', 'echo ok'], { cwd: tmpdir(), input: '', timeoutMs: 5_000 });
    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: 'ok\n' });
    expect(sent).toEqual([]);
    expect(trackedProcessGroups()).toEqual([]);
  });
});
