import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import {
  LocalCommandRunner,
  defaultRawRunner,
  maskCommandOutput,
  type RawCommandRunner,
  type RawRunResult,
} from './index';
import type { CommandRunOptions } from '@quoky/core';

const opts: CommandRunOptions = { cwd: tmpdir(), timeoutMs: 10_000 };

/** Records (command, args, options) so we can assert the argv array (no shell string). */
function recordingRaw(result: RawRunResult): {
  raw: RawCommandRunner;
  calls: Array<{ command: string; args: string[]; options: CommandRunOptions }>;
} {
  const calls: Array<{ command: string; args: string[]; options: CommandRunOptions }> = [];
  const raw: RawCommandRunner = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { raw, calls };
}

describe('LocalCommandRunner — argv-array execution (CAP-007, ADR-0028)', () => {
  it('passes command + args as a separate argv array (never a shell string)', async () => {
    const { raw, calls } = recordingRaw({ status: 0, stdout: 'x', stderr: '', timedOut: false });
    await new LocalCommandRunner(raw).run('pnpm', ['run', 'build'], opts);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('pnpm');
    expect(Array.isArray(calls[0]!.args)).toBe(true);
    expect(calls[0]!.args).toEqual(['run', 'build']); // not concatenated
  });

  it('maps a raw success to exitCode 0 and masks/caps output', async () => {
    const { raw } = recordingRaw({ status: 0, stdout: 'token sk' + '-abcdefgh12345678', stderr: '', timedOut: false });
    const r = await new LocalCommandRunner(raw).run('node', ['-v'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).not.toContain('sk' + '-abcdefgh12345678');
    expect(r.stdout).toContain('***redacted***');
  });

  it('propagates timeout (exitCode null, timedOut true)', async () => {
    const { raw } = recordingRaw({ status: null, stdout: '', stderr: '', timedOut: true });
    const r = await new LocalCommandRunner(raw).run('node', ['-e', 'while(true){}'], opts);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('really runs node end-to-end (success + nonzero exit)', async () => {
    const runner = new LocalCommandRunner();
    const ok = await runner.run('node', ['-e', "process.stdout.write('hello')"], opts);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('hello');

    const bad = await runner.run('node', ['-e', 'process.exit(3)'], opts);
    expect(bad.exitCode).toBe(3);
  });

  it('defaultRawRunner kills a hung process at the timeout', () => {
    const res = defaultRawRunner('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: tmpdir(),
      timeoutMs: 300,
    });
    expect(res.timedOut).toBe(true);
  });

  // CAP-007 review MB-1: a child must NOT inherit the full parent process.env by default.
  it('does NOT pass the full parent process.env to the child by default', () => {
    process.env.CHUNSIK_SECRET_TEST = 'supersecret-value';
    try {
      const res = defaultRawRunner(
        'node',
        ['-e', "process.stdout.write(process.env.CHUNSIK_SECRET_TEST ?? 'UNSET')"],
        { cwd: tmpdir(), timeoutMs: 10_000 },
      );
      expect(res.stdout).toBe('UNSET'); // parent secret-like var not inherited
    } finally {
      delete process.env.CHUNSIK_SECRET_TEST;
    }
  });

  it('still provides PATH by default so allow-listed binaries resolve', () => {
    const res = defaultRawRunner(
      'node',
      ['-e', "process.stdout.write(process.env.PATH ? 'HASPATH' : 'NOPATH')"],
      { cwd: tmpdir(), timeoutMs: 10_000 },
    );
    expect(res.stdout).toBe('HASPATH');
  });

  it('passes ONLY the explicit env when one is supplied (parent vars excluded)', () => {
    process.env.CHUNSIK_SECRET_TEST2 = 'leak-me';
    try {
      const res = defaultRawRunner(
        'node',
        [
          '-e',
          "process.stdout.write((process.env.FOO ?? 'NONE') + ':' + (process.env.CHUNSIK_SECRET_TEST2 ?? 'UNSET'))",
        ],
        { cwd: tmpdir(), timeoutMs: 10_000, env: { PATH: process.env.PATH ?? '', FOO: 'bar' } },
      );
      expect(res.stdout).toBe('bar:UNSET'); // explicit env honored; parent var not leaked
    } finally {
      delete process.env.CHUNSIK_SECRET_TEST2;
    }
  });
});

describe('maskCommandOutput', () => {
  it('redacts api keys, bearer tokens, and url credentials', () => {
    expect(maskCommandOutput('key sk' + '-abcdefgh12345678 done')).not.toContain('sk' + '-abcdefgh12345678');
    expect(maskCommandOutput('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(maskCommandOutput('clone https://user:secrettoken@github.com/x')).not.toContain('secrettoken');
  });

  it('caps very long output', () => {
    const masked = maskCommandOutput('a'.repeat(200_000));
    expect(masked.length).toBeLessThan(200_000);
    expect(masked).toContain('[truncated]');
  });
});
