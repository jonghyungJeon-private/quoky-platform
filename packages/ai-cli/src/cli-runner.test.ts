import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CALLER_ENV_ALLOWLIST,
  INHERITED_ENV_ALLOWLIST,
  MAX_STDERR_CAPTURE_BYTES,
  MAX_STDOUT_CAPTURE_BYTES,
  buildChildEnvironment,
  createContainedCliRunner,
} from './cli-runner';
import type {
  CliRunOptions,
  CliRunResult,
  ContainmentSnapshot,
  RunnerTimers,
  TimerHandle,
} from './cli-runner';

/** Control characters built from char codes so no raw control byte lives in this source. */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const REPLACEMENT = String.fromCharCode(0xfffd);

// ---------------------------------------------------------------------------
// Manual scheduler — lifecycle ordering is asserted without real timers, and a
// CLEARED timer's handler can still be fired to prove the runner's guards hold.
// ---------------------------------------------------------------------------

interface ManualTimer {
  id: number;
  handler: () => void;
  ms: number;
  cleared: boolean;
}

class ManualTimers implements RunnerTimers {
  readonly registered: ManualTimer[] = [];
  private nextId = 1;

  setTimeout = (handler: () => void, ms: number): TimerHandle => {
    const timer: ManualTimer = { id: this.nextId, handler, ms, cleared: false };
    this.nextId += 1;
    this.registered.push(timer);
    return { unref: () => undefined, id: timer.id } as TimerHandle & { id: number };
  };

  clearTimeout = (handle: TimerHandle): void => {
    const id = (handle as TimerHandle & { id?: number }).id;
    const timer = this.registered.find((entry) => entry.id === id);
    if (timer) timer.cleared = true;
  };

  /** The run's timeout timer (always registered first). */
  get timeout(): ManualTimer | undefined {
    return this.registered[0];
  }

  /** The SIGKILL grace timer, registered only once termination is requested. */
  get grace(): ManualTimer | undefined {
    return this.registered[1];
  }

  /** Fires a handler even if it was cleared, so the runner's own guards are exercised. */
  fire(timer: ManualTimer | undefined): void {
    timer?.handler();
  }
}

// ---------------------------------------------------------------------------
// Fake child process (no real process is ever spawned in this suite)
// ---------------------------------------------------------------------------

interface StdinBehavior {
  /** Error handed to the `write` callback. */
  writeError?: Error;
  /** Error emitted on the stdin stream during `write`. */
  emitError?: Error;
  /** Error thrown synchronously by `write()`. */
  writeThrows?: Error;
  /** Error thrown synchronously by `end()` (write/end race). */
  endThrows?: Error;
}

class FakeStdin extends EventEmitter {
  readonly written: string[] = [];
  ended = false;

  constructor(private readonly behavior: StdinBehavior = {}) {
    super();
  }

  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.behavior.writeThrows) throw this.behavior.writeThrows;
    this.written.push(data);
    callback?.(this.behavior.writeError ?? null);
    if (this.behavior.emitError) this.emit('error', this.behavior.emitError);
    return true;
  }

  end(): void {
    if (this.behavior.endThrows) throw this.behavior.endThrows;
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  readonly stdin: FakeStdin | null;

  constructor(stdin: FakeStdin | null = new FakeStdin()) {
    super();
    this.stdin = stdin;
  }

  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

interface SpawnRecord {
  bin: string;
  args: readonly string[];
  options: SpawnOptions;
}

interface StartConfig {
  stdin?: FakeStdin | null;
  spawnThrows?: Error;
  createThrows?: boolean;
  removeThrows?: boolean;
  parentEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  bin?: string;
  args?: string[];
  environmentProfile?: CliRunOptions['environmentProfile'];
  downloadMarkerPolicy?: CliRunOptions['downloadMarkerPolicy'];
  /** Use the production temp-dir implementation instead of the recording wrapper. */
  productionTempDir?: boolean;
  /** Make the observation hook throw AFTER recording, to prove it is isolated. */
  hookThrows?: Error;
}

interface StartedRun {
  result: Promise<CliRunResult>;
  child?: FakeChild;
  spawns: SpawnRecord[];
  created: string[];
  removed: string[];
  timers: ManualTimers;
  snapshots: ContainmentSnapshot[];
}

const PARENT_WITH_SECRETS: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/tester',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TMPDIR: '/parent/tmp',
  TMP: '/parent/tmp',
  TEMP: '/parent/tmp',
  ANTHROPIC_API_KEY: 'parent-api-key',
  OPENAI_API_KEY: 'parent-api-key',
  GITHUB_TOKEN: 'parent-token',
  DISCORD_BOT_TOKEN: 'parent-bot-token',
  DATABASE_URL: 'parent-database-credential',
  AWS_SECRET_ACCESS_KEY: 'parent-credential',
  NPM_PASSWORD: 'parent-password',
  HTTP_PROXY: 'http://proxy:8080',
  HTTPS_PROXY: 'http://proxy:8080',
  NO_PROXY: 'localhost',
  SSL_CERT_FILE: '/parent/ca.pem',
  NODE_EXTRA_CA_CERTS: '/parent/ca.pem',
  NODE_OPTIONS: '--require /parent/preload.js',
  NODE_PATH: '/parent/node_modules',
  LD_PRELOAD: '/parent/evil.so',
  DYLD_INSERT_LIBRARIES: '/parent/evil.dylib',
  BASH_ENV: '/parent/bashrc',
  ZDOTDIR: '/parent/zsh',
  SHELL: '/bin/zsh',
  OLLAMA_HOST: 'http://elsewhere:11434',
  OLLAMA_MODEL: 'parent-model',
};

/**
 * Names that must NEVER reach a child, derived from the allow-list itself. `TMPDIR`
 * is excluded because the runner OWNS it: it is always set, but never to the parent's
 * value — asserted separately below.
 */
const FORBIDDEN_CHILD_ENV_NAMES = Object.keys(PARENT_WITH_SECRETS).filter(
  (name) =>
    name !== 'TMPDIR' &&
    !INHERITED_ENV_ALLOWLIST.includes(name as (typeof INHERITED_ENV_ALLOWLIST)[number]),
);

function startRun(config: StartConfig = {}): StartedRun {
  const spawns: SpawnRecord[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const snapshots: ContainmentSnapshot[] = [];
  const timers = new ManualTimers();
  let child: FakeChild | undefined;

  const tempHooks = config.productionTempDir
    ? {}
    : {
        createTempDir: (): string => {
          if (config.createThrows) throw new Error('temp create failed');
          const dir = mkdtempSync(join(realpathSync(tmpdir()), 'quoky-cli-test-'));
          created.push(dir);
          return dir;
        },
        removeTempDir: (dir: string): void => {
          removed.push(dir);
          if (config.removeThrows) throw new Error(`temp remove failed for ${dir}`);
          rmSync(dir, { recursive: true, force: true });
        },
      };

  const runner = createContainedCliRunner({
    ...tempHooks,
    parentEnv: config.parentEnv ?? PARENT_WITH_SECRETS,
    timers,
    onContainment: (snapshot) => {
      snapshots.push(snapshot);
      if (config.hookThrows) throw config.hookThrows;
    },
    spawnFn: (bin, args, options) => {
      spawns.push({ bin, args, options });
      if (config.spawnThrows) throw config.spawnThrows;
      child = new FakeChild(config.stdin === undefined ? new FakeStdin() : config.stdin);
      return child as unknown as ChildProcess;
    },
  });

  const options: CliRunOptions = {
    cwd: config.cwd ?? '/neutral/cwd',
    input: config.input ?? 'the prompt',
    timeoutMs: config.timeoutMs ?? 5_000,
    ...(config.env ? { env: config.env } : {}),
    ...(config.environmentProfile ? { environmentProfile: config.environmentProfile } : {}),
    ...(config.downloadMarkerPolicy ? { downloadMarkerPolicy: config.downloadMarkerPolicy } : {}),
  };
  const result = runner(config.bin ?? 'provider-cli', config.args ?? ['-p'], options);
  return { result, child, spawns, created, removed, timers, snapshots };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Emit a normal close (the runner defers only the result projection by one macrotask). */
async function closeWith(run: StartedRun, code: number | null = 0): Promise<CliRunResult> {
  run.child?.emit('close', code, null);
  return run.result;
}

const childEnvOf = (run: StartedRun): Record<string, string> =>
  (run.spawns[0]?.options.env ?? {}) as Record<string, string>;

const only = (run: StartedRun): ContainmentSnapshot => {
  expect(run.snapshots).toHaveLength(1);
  return run.snapshots[0] as ContainmentSnapshot;
};

// ---------------------------------------------------------------------------

describe('contained CLI runner: parent environment isolation', () => {
  it('forwards only allow-listed parent names plus a runner-owned TMPDIR', async () => {
    const run = startRun();
    await closeWith(run);
    const env = childEnvOf(run);
    expect(Object.keys(env).sort()).toEqual([...INHERITED_ENV_ALLOWLIST, 'TMPDIR'].sort());
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/Users/tester');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.LC_CTYPE).toBe('UTF-8');
  });

  it('never forwards a secret-like, proxy, certificate, preload, or shell parent variable', async () => {
    const run = startRun();
    await closeWith(run);
    const env = childEnvOf(run);
    for (const name of FORBIDDEN_CHILD_ENV_NAMES) {
      expect(env[name], `${name} must not reach the child`).toBeUndefined();
    }
    const serialized = JSON.stringify(env);
    for (const value of [
      'parent-api-key',
      'parent-token',
      'parent-bot-token',
      'parent-credential',
      'parent-password',
      'parent-model',
      'proxy:8080',
      'preload.js',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('never forwards the parent TMPDIR/TMP/TEMP: TMPDIR is runner-owned', async () => {
    const run = startRun();
    await closeWith(run);
    const env = childEnvOf(run);
    expect(env.TMPDIR).not.toBe('/parent/tmp');
    expect(env.TMPDIR).toBe(run.created[0]);
    expect(env.TMP).toBeUndefined();
    expect(env.TEMP).toBeUndefined();
  });

  it('accepts the allow-listed caller environment names', async () => {
    const run = startRun({ env: { NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' } });
    await closeWith(run);
    const env = childEnvOf(run);
    expect(env.NO_COLOR).toBe('1');
    expect(env.CLICOLOR).toBe('0');
    expect(env.CLICOLOR_FORCE).toBe('0');
    expect(Object.keys(env).sort()).toEqual(
      [...INHERITED_ENV_ALLOWLIST, 'TMPDIR', ...CALLER_ENV_ALLOWLIST].sort(),
    );
  });

  it('refuses a non-allow-listed caller name WITHOUT spawning (no bypass path)', async () => {
    const rogueEnvironments: Array<Record<string, string>> = [
      { ANTHROPIC_API_KEY: 'injected' },
      { NODE_OPTIONS: '--require /evil.js' },
      { HTTP_PROXY: 'http://evil' },
      { OLLAMA_HOST: 'http://elsewhere' },
      { PATH: '/evil/bin' },
      { HOME: '/evil/home' },
      { TMPDIR: '/evil/tmp' },
      { NO_COLOR: '1', GITHUB_TOKEN: 'injected' },
    ];
    for (const rogue of rogueEnvironments) {
      const run = startRun({ env: rogue });
      const result = await run.result;
      expect(run.spawns).toHaveLength(0);
      expect(run.child).toBeUndefined();
      expect(result.code).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('not allow-listed');
      expect(result.timedOut).toBe(false);
      // The refused run still cleans up its own temporary directory.
      expect(run.removed).toEqual(run.created);
      expect(existsSync(run.created[0] ?? '')).toBe(false);
      // The rejected name and its value are never echoed.
      for (const [name, value] of Object.entries(rogue)) {
        if (name === 'NO_COLOR') continue; // allow-listed companion in the last case
        expect(result.stderr).not.toContain(name);
        expect(result.stderr).not.toContain(value);
      }
    }
  });

  it('buildChildEnvironment is pure and fails closed on any unknown caller name', () => {
    const allowed = buildChildEnvironment(PARENT_WITH_SECRETS, '/tmp/owned', { NO_COLOR: '1' });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.env.TMPDIR).toBe('/tmp/owned');
      expect(allowed.env.NO_COLOR).toBe('1');
      expect(allowed.env.ANTHROPIC_API_KEY).toBeUndefined();
    }
    const refused = buildChildEnvironment(PARENT_WITH_SECRETS, '/tmp/owned', { SOMETHING_ELSE: 'x' });
    expect(refused.ok).toBe(false);
    const sparseParent = buildChildEnvironment({ PATH: '/bin' }, '/tmp/owned');
    expect(sparseParent.ok).toBe(true);
    if (sparseParent.ok) {
      // An absent parent name is simply not set, never set to an empty string.
      expect(Object.keys(sparseParent.env).sort()).toEqual(['PATH', 'TMPDIR']);
    }
  });

  it('uses an exact parent-free environment for isolated Ollama validation', () => {
    const isolated = buildChildEnvironment(PARENT_WITH_SECRETS, '/tmp/owned', {
      NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0',
      OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_NO_CLOUD: '1',
    }, 'ISOLATED_OLLAMA_VALIDATION');
    expect(isolated.ok).toBe(true);
    if (isolated.ok) {
      expect(isolated.env).toEqual({
        HOME: '/tmp/owned', TMPDIR: '/tmp/owned', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0',
        OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_NO_CLOUD: '1',
      });
      expect(isolated.env.PATH).toBeUndefined();
      expect(isolated.env.HTTP_PROXY).toBeUndefined();
      expect(isolated.env.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it.each([
    undefined,
    '',
    'http://localhost:11434',
    'http://[::1]:11434',
    'http://192.0.2.1:11434',
    'https://127.0.0.1:11434',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:11434/path',
    'http://127.0.0.1:11434?query=1',
    'http://127.0.0.1:11434#hash',
    'http://user:pass@127.0.0.1:11434',
  ])('rejects an invalid isolated OLLAMA_HOST without spawning: %s', async (host) => {
    const env = {
      NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0', OLLAMA_NO_CLOUD: '1',
      ...(host === undefined ? {} : { OLLAMA_HOST: host }),
    };
    const run = startRun({ env, environmentProfile: 'ISOLATED_OLLAMA_VALIDATION' });
    const result = await run.result;
    expect(run.spawns).toHaveLength(0);
    expect(result).toMatchObject({ code: null, stdout: '', outputOverflowed: false });
    if (host) expect(JSON.stringify(result)).not.toContain(host);
  });

  it('rejects a disallowed isolated environment key without spawning', async () => {
    const run = startRun({
      environmentProfile: 'ISOLATED_OLLAMA_VALIDATION',
      env: { OLLAMA_HOST: 'http://127.0.0.1:11434', GITHUB_TOKEN: 'raw-secret' },
    });
    const result = await run.result;
    expect(run.spawns).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('GITHUB_TOKEN');
    expect(JSON.stringify(result)).not.toContain('raw-secret');
  });
});

describe('contained CLI runner: bounded Ollama download observation', () => {
  it.each([
    ['stdout', 'pulling manifest'], ['stderr', 'pulling manifest'],
    ['stdout', 'pulling abcdef123456'], ['stderr', 'pulling abcdef123456'],
    ['stdout', 'verifying sha256 digest'], ['stderr', 'verifying sha256 digest'],
    ['stdout', 'writing manifest'], ['stderr', 'writing manifest'],
  ] as const)('terminates on split %s %s marker without retaining raw output', async (stream, marker) => {
    const run = startRun({
      downloadMarkerPolicy: 'OLLAMA_PULL', environmentProfile: 'ISOLATED_OLLAMA_VALIDATION',
      env: { OLLAMA_HOST: 'http://127.0.0.1:11434' },
    });
    run.child?.[stream].emit('data', Buffer.from(marker.slice(0, 5)));
    run.child?.[stream].emit('data', Buffer.from(marker.slice(5)));
    const result = await closeWith(run, null);
    expect(result.downloadObserved).toBe(true);
    expect(result.outputOverflowed).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(run.child?.signals).toEqual(['SIGTERM']);
  });
});

describe('contained CLI runner: production stderr-only download observation', () => {
  it.each(['pulling manifest', 'pulling abcdef123456', 'verifying sha256 digest', 'writing manifest'])(
    'does not abort a production run whose stdout answer contains "%s"',
    async (marker) => {
      const run = startRun({ downloadMarkerPolicy: 'OLLAMA_PULL_STDERR' });
      run.child?.stdout.emit('data', Buffer.from(`the log said ${marker.slice(0, 5)}`));
      run.child?.stdout.emit('data', Buffer.from(`${marker.slice(5)} and then it finished`));
      const result = await closeWith(run, 0);
      expect(result.downloadObserved).toBe(false);
      expect(result.stdout).toContain(marker);
      expect(run.child?.signals).toEqual([]);
    },
  );

  it.each(['pulling manifest', 'pulling abcdef123456', 'verifying sha256 digest', 'writing manifest'])(
    'aborts a production run whose stderr reports "%s"',
    async (marker) => {
      const run = startRun({ downloadMarkerPolicy: 'OLLAMA_PULL_STDERR' });
      run.child?.stderr.emit('data', Buffer.from(marker.slice(0, 5)));
      run.child?.stderr.emit('data', Buffer.from(marker.slice(5)));
      const result = await closeWith(run, null);
      expect(result.downloadObserved).toBe(true);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(run.child?.signals).toEqual(['SIGTERM']);
    },
  );
});

describe('contained CLI runner: runner-owned temporary directory', () => {
  it('gives each child an independent temp dir under OS temp, outside the repository', async () => {
    const first = startRun({ productionTempDir: true });
    const second = startRun({ productionTempDir: true });
    await closeWith(first);
    await closeWith(second);
    const a = childEnvOf(first).TMPDIR ?? '';
    const b = childEnvOf(second).TMPDIR ?? '';
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
    const osTemp = realpathSync(tmpdir());
    expect(a.startsWith(osTemp)).toBe(true);
    expect(b.startsWith(osTemp)).toBe(true);
    expect(a.startsWith(process.cwd())).toBe(false);
    expect(b.startsWith(process.cwd())).toBe(false);
    expect(a).toContain('chunsik-cli-');
    // Removed by the production cleanup path once each child settled.
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
  });

  it('removes the temp dir exactly once after the child settles', async () => {
    const run = startRun();
    expect(run.removed).toHaveLength(0);
    await closeWith(run);
    expect(run.removed).toEqual(run.created);
    expect(run.removed).toHaveLength(1);
    expect(only(run).cleanupAttempts).toBe(1);
    expect(existsSync(run.created[0] ?? '')).toBe(false);
  });

  it('fails closed without spawning when the temp dir cannot be created', async () => {
    const run = startRun({ createThrows: true });
    const result = await run.result;
    expect(run.spawns).toHaveLength(0);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to prepare the provider process sandbox.');
    expect(result.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BLOCKING FIX 2 — cleanup failure is a containment failure, never a success
// ---------------------------------------------------------------------------

describe('contained CLI runner: cleanup failure is fail-closed', () => {
  it('turns a successful child into a containment failure when cleanup fails', async () => {
    const run = startRun({ removeThrows: true });
    run.child?.stdout.emit('data', Buffer.from('real provider response', 'utf8'));
    const result = await closeWith(run, 0);
    // The child exited 0, but the sandbox may still hold provider data.
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to clean up the provider process sandbox.');
    expect(result.timedOut).toBe(false);
    rmSync(run.created[0] ?? '', { recursive: true, force: true });
  });

  it('never leaks the cleanup path, the raw cleanup error, or the provider output', async () => {
    const run = startRun({ removeThrows: true });
    run.child?.stdout.emit('data', Buffer.from('secret provider answer', 'utf8'));
    const result = await closeWith(run, 0);
    const created = run.created[0] ?? '';
    expect(result.stderr).not.toContain(created);
    expect(result.stderr).not.toContain('temp remove failed');
    expect(result.stderr).not.toContain('secret provider answer');
    expect(result.stdout).not.toContain('secret provider answer');
    rmSync(created, { recursive: true, force: true });
  });

  it('attempts cleanup exactly once and does not re-enter finalize', async () => {
    const run = startRun({ removeThrows: true });
    const result = await closeWith(run, 0);
    expect(run.removed).toHaveLength(1);
    expect(only(run).cleanupAttempts).toBe(1);
    // Late events after settling must not trigger a second cleanup attempt.
    run.child?.emit('close', 0, null);
    run.child?.emit('error', new Error('late'));
    await tick();
    expect(run.removed).toHaveLength(1);
    expect(result.code).toBeNull();
    rmSync(run.created[0] ?? '', { recursive: true, force: true });
  });

  it('does not confuse a cleanup failure with a timeout', async () => {
    const run = startRun({ removeThrows: true, timeoutMs: 1_000 });
    run.timers.fire(run.timers.timeout); // a real timeout happened first
    expect(run.child?.signals).toEqual(['SIGTERM']);
    const result = await closeWith(run, null);
    // Cleanup failure takes precedence and must not be reported as a timeout.
    expect(result.stderr).toBe('Failed to clean up the provider process sandbox.');
    expect(result.timedOut).toBe(false);
    rmSync(run.created[0] ?? '', { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// BLOCKING FIX 3 — spawn errors never carry a raw message
// ---------------------------------------------------------------------------

describe('contained CLI runner: spawn failure exposes nothing', () => {
  const SECRET_MESSAGES: Array<[string, string]> = [
    ['token-shaped', `spawn failed: ghp-${'A'.repeat(24)}`],
    ['jwt-shaped', `spawn failed: ${['A'.repeat(24), 'B'.repeat(6), 'C'.repeat(30)].join('.')}`],
    ['secret-like path', 'spawn /Users/tester/.secrets/provider-key/ollama ENOENT'],
    ['home path', 'spawn ENOENT in /Users/tester/Library/Application Support'],
    ['ansi framed', `${ESC}[31mspawn ENOENT${ESC}[0m ${ESC}]0;title${BEL}`],
    ['password-like', 'spawn failed: password=hunter2 user=admin'],
  ];

  it('returns one bounded generic reason for a synchronous spawn throw', async () => {
    for (const [, message] of SECRET_MESSAGES) {
      const run = startRun({ spawnThrows: new Error(message) });
      const result = await run.result;
      expect(result.code).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Failed to start provider process.');
      expect(result.timedOut).toBe(false);
      expect(result.stderr).not.toContain(message);
      expect(run.removed).toEqual(run.created); // sandbox still cleaned
    }
  });

  it('returns one bounded generic reason for an asynchronous child error', async () => {
    for (const [, message] of SECRET_MESSAGES) {
      const run = startRun();
      run.child?.emit('error', new Error(message));
      const result = await run.result;
      expect(result.code).toBeNull();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Failed to start provider process.');
      expect(result.timedOut).toBe(false);
      expect(result.stderr).not.toContain(message);
    }
  });

  it('leaks no secret fragment, path, or control byte from any spawn error', async () => {
    for (const [, message] of SECRET_MESSAGES) {
      for (const run of [startRun({ spawnThrows: new Error(message) }), startRun()]) {
        run.child?.emit('error', new Error(message));
        const result = await run.result;
        const combined = `${result.stdout}${result.stderr}`;
        for (const fragment of [
          'ghp-',
          '/Users/tester',
          '.secrets',
          'password',
          'hunter2',
          'ENOENT',
          'Application Support',
          ESC,
          BEL,
        ]) {
          expect(combined).not.toContain(fragment);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCKING FIX 1 — close wins over the timeout
// ---------------------------------------------------------------------------

describe('contained CLI runner: close/timeout ordering', () => {
  it('a timeout callback that runs right after close does not mark the run timed out', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    run.child?.emit('close', 0, null);
    run.timers.fire(run.timers.timeout); // fires inside the deferred window
    const result = await run.result;
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(run.child?.signals).toEqual([]); // no SIGTERM, no SIGKILL
  });

  it('clears both timers synchronously when close is observed', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    expect(run.timers.timeout?.cleared).toBe(false);
    run.child?.emit('close', 0, null);
    expect(run.timers.timeout?.cleared).toBe(true); // synchronous, not deferred
    await run.result;
  });

  it('observes a late stdin EPIPE inside the deferred window (the only reason to defer)', async () => {
    const stdin = new FakeStdin();
    const run = startRun({ stdin, input: 'a prompt' });
    run.child?.stdout.emit('data', Buffer.from('output the child produced', 'utf8'));
    run.child?.emit('close', 0, null);
    stdin.emit('error', new Error('EPIPE')); // arrives after close, before the projection
    const result = await run.result;
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to deliver the prompt to the provider process.');
    expect(result.timedOut).toBe(false);
  });

  it('a late timeout callback after the result resolved changes nothing', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    const result = await closeWith(run, 0);
    expect(result.timedOut).toBe(false);
    run.timers.fire(run.timers.timeout);
    await tick();
    expect(result.timedOut).toBe(false); // the resolved value is immutable
    expect(run.child?.signals).toEqual([]);
    expect(run.removed).toHaveLength(1);
  });

  it('a late SIGKILL grace callback after close sends no signal', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    run.timers.fire(run.timers.timeout); // real timeout: arms the grace timer
    expect(run.child?.signals).toEqual(['SIGTERM']);
    expect(run.timers.grace).toBeDefined();
    run.child?.emit('close', null, 'SIGTERM');
    expect(run.timers.grace?.cleared).toBe(true);
    run.timers.fire(run.timers.grace); // cleared, but fire anyway
    const result = await run.result;
    expect(run.child?.signals).toEqual(['SIGTERM']); // never escalated
    expect(result.timedOut).toBe(true); // the timeout really did happen
  });

  it('requestTermination after close never signals', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    run.child?.emit('close', 0, null);
    // Any post-close path that would terminate (timeout, overflow, stdin failure)
    // must be disarmed.
    run.timers.fire(run.timers.timeout);
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    const result = await run.result;
    expect(run.child?.signals).toEqual([]);
    expect(only(run).terminationRequests).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('a real timeout still projects timedOut with the bounded output captured so far', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    run.child?.stdout.emit('data', Buffer.from('partial answer', 'utf8'));
    run.timers.fire(run.timers.timeout);
    expect(run.child?.signals).toEqual(['SIGTERM']);
    const result = await closeWith(run, null);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('partial answer');
  });
});

// ---------------------------------------------------------------------------
// BLOCKING FIX 4 — no decode or count once a stream has overflowed
// ---------------------------------------------------------------------------

describe('contained CLI runner: output byte bounds stop decoding', () => {
  it('never decodes an oversized stdout chunk and fails closed', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    const result = await closeWith(run, 0);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Provider process exceeded the stdout capture limit.');
    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('aaaa');
    const snapshot = only(run);
    expect(snapshot.stdoutDecodeCalls).toBe(0); // the breaching chunk was never decoded
    expect(snapshot.stdoutBytes).toBe(0); // and never counted
    expect(run.child?.signals).toEqual(['SIGTERM']);
    expect(result).not.toHaveProperty('outputOverflowed');
  });

  it('never decodes an oversized stderr chunk and fails closed', async () => {
    const run = startRun();
    run.child?.stderr.emit('data', Buffer.alloc(MAX_STDERR_CAPTURE_BYTES + 1, 0x62));
    const result = await closeWith(run, 0);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Provider process exceeded the stderr capture limit.');
    expect(result.stderr).not.toContain('bbbb');
    const snapshot = only(run);
    expect(snapshot.stderrDecodeCalls).toBe(0);
    expect(snapshot.stderrBytes).toBe(0);
    expect(result).not.toHaveProperty('outputOverflowed');
  });

  it.each(['stdout', 'stderr'] as const)('projects structured %s overflow only for validation profile', async (stream) => {
    const run = startRun({
      environmentProfile: 'ISOLATED_OLLAMA_VALIDATION',
      env: { OLLAMA_HOST: 'http://127.0.0.1:11434' },
    });
    const limit = stream === 'stdout' ? MAX_STDOUT_CAPTURE_BYTES : MAX_STDERR_CAPTURE_BYTES;
    run.child?.[stream].emit('data', Buffer.alloc(limit + 1, 0x61));
    const result = await closeWith(run, 0);
    expect(result.outputOverflowed).toBe(true);
  });

  it('keeps legacy successful result shape free of opt-in observations', async () => {
    const result = await closeWith(startRun(), 0);
    expect(result).not.toHaveProperty('downloadObserved');
    expect(result).not.toHaveProperty('outputOverflowed');
  });

  it('ignores every later chunk on both streams once one has overflowed', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.from('accepted', 'utf8')); // counted + decoded
    const acceptedBytes = Buffer.byteLength('accepted', 'utf8');
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61)); // overflow
    run.child?.stdout.emit('data', Buffer.from('late stdout', 'utf8'));
    run.child?.stderr.emit('data', Buffer.from('late stderr', 'utf8'));
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    const result = await closeWith(run, 0);
    const snapshot = only(run);
    expect(snapshot.stdoutDecodeCalls).toBe(1); // only the first accepted chunk
    expect(snapshot.stdoutBytes).toBe(acceptedBytes); // frozen at the pre-overflow count
    expect(snapshot.stderrDecodeCalls).toBe(0); // containment failure gates the other stream too
    expect(snapshot.stderrBytes).toBe(0);
    expect(snapshot.terminationRequests).toBe(1); // requested exactly once
    expect(run.child?.signals).toEqual(['SIGTERM']);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Provider process exceeded the stdout capture limit.');
  });

  it('escalates to SIGKILL once when the grace period elapses after an overflow', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    expect(run.child?.signals).toEqual(['SIGTERM']);
    run.timers.fire(run.timers.grace);
    expect(run.child?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    run.timers.fire(run.timers.grace); // a repeat callback must not signal again
    await closeWith(run, null);
    expect(run.child?.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(only(run).terminationRequests).toBe(1);
  });

  it('sends no SIGKILL when the child exits inside the grace period after an overflow', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    expect(run.child?.signals).toEqual(['SIGTERM']);
    run.child?.emit('close', null, 'SIGTERM');
    expect(run.timers.grace?.cleared).toBe(true);
    run.timers.fire(run.timers.grace);
    await run.result;
    expect(run.child?.signals).toEqual(['SIGTERM']);
  });

  it('accepts a chunk exactly at the stderr limit and a chunk exactly at the stdout limit', async () => {
    const errRun = startRun();
    errRun.child?.stderr.emit('data', Buffer.alloc(MAX_STDERR_CAPTURE_BYTES, 0x62));
    const errResult = await closeWith(errRun, 0);
    expect(errResult.code).toBe(0);
    expect(Buffer.byteLength(errResult.stderr, 'utf8')).toBe(MAX_STDERR_CAPTURE_BYTES);
    expect(only(errRun).stderrDecodeCalls).toBe(1);

    const outRun = startRun();
    outRun.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES, 0x61));
    const outResult = await closeWith(outRun, 0);
    expect(outResult.code).toBe(0);
    expect(Buffer.byteLength(outResult.stdout, 'utf8')).toBe(MAX_STDOUT_CAPTURE_BYTES);
  });

  it('applies the two limits independently (a stdout above the stderr bound still succeeds)', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDERR_CAPTURE_BYTES + 2_048, 0x61));
    run.child?.stderr.emit('data', Buffer.alloc(MAX_STDERR_CAPTURE_BYTES - 1_024, 0x62));
    const result = await closeWith(run, 0);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_STDERR_CAPTURE_BYTES + 2_048);
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(MAX_STDERR_CAPTURE_BYTES - 1_024);
  });

  it('accumulates a many-chunk stream up to the bound without exceeding it', async () => {
    const run = startRun();
    const chunk = Buffer.alloc(16_384, 0x63);
    const chunks = MAX_STDOUT_CAPTURE_BYTES / 16_384;
    for (let i = 0; i < chunks; i += 1) {
      run.child?.stdout.emit('data', chunk);
    }
    const result = await closeWith(run, 0);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_STDOUT_CAPTURE_BYTES);
    expect(only(run).stdoutDecodeCalls).toBe(chunks);
  });

  it('does not decode an oversized chunk of malformed UTF-8', async () => {
    const run = startRun();
    const malformed = Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x80); // lone continuation bytes
    run.child?.stdout.emit('data', malformed);
    const result = await closeWith(run, 0);
    expect(only(run).stdoutDecodeCalls).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(REPLACEMENT);
  });

  it('does not re-insert a decoder tail into an overflowed result', async () => {
    const run = startRun();
    const partial = Buffer.from('가', 'utf8').subarray(0, 2); // incomplete sequence, kept in the decoder
    run.child?.stdout.emit('data', partial);
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    const result = await closeWith(run, 0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(REPLACEMENT);
    expect(result.stderr).toBe('Provider process exceeded the stdout capture limit.');
  });

  it('removes every listener after an overflow-driven settle', async () => {
    const run = startRun();
    const child = run.child;
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    await closeWith(run, null);
    expect(child?.listenerCount('close')).toBe(0);
    expect(child?.stdout.listenerCount('data')).toBe(0);
    expect(child?.stderr.listenerCount('data')).toBe(0);
    expect(child?.stdin?.listenerCount('error')).toBe(0);
    // Exactly one swallowing 'error' listener remains, so a late emit cannot become
    // an unhandled error event.
    expect(child?.listenerCount('error')).toBe(1);
  });
});

describe('contained CLI runner: UTF-8-safe streaming', () => {
  it('restores a multi-byte sequence split across chunks', async () => {
    const run = startRun();
    const bytes = Buffer.from('한글 응답', 'utf8');
    run.child?.stdout.emit('data', bytes.subarray(0, 2)); // splits the first code point
    run.child?.stdout.emit('data', bytes.subarray(2, 7));
    run.child?.stdout.emit('data', bytes.subarray(7));
    const result = await closeWith(run, 0);
    expect(result.stdout).toBe('한글 응답');
    expect(result.stdout).not.toContain(REPLACEMENT);
  });

  it('uses an independent decoder per stream (interleaved partial sequences do not mix)', async () => {
    const run = startRun();
    const out = Buffer.from('한', 'utf8');
    const err = Buffer.from('글', 'utf8');
    run.child?.stdout.emit('data', out.subarray(0, 2));
    run.child?.stderr.emit('data', err.subarray(0, 2));
    run.child?.stdout.emit('data', out.subarray(2));
    run.child?.stderr.emit('data', err.subarray(2));
    const result = await closeWith(run, 0);
    expect(result.stdout).toBe('한');
    expect(result.stderr).toBe('글');
    expect(result.stdout).not.toContain(REPLACEMENT);
    expect(result.stderr).not.toContain(REPLACEMENT);
  });

  it('flushes the decoder at stream end for a trailing incomplete sequence', async () => {
    const run = startRun();
    const bytes = Buffer.from('가', 'utf8');
    run.child?.stdout.emit('data', bytes.subarray(0, 2)); // never completed
    const result = await closeWith(run, 0);
    // The incomplete tail surfaces as a replacement character rather than vanishing.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(REPLACEMENT);
  });
});

describe('contained CLI runner: diagnostic sanitation', () => {
  it('strips ANSI CSI/OSC/ESC and control bytes from the diagnostic stderr', async () => {
    const run = startRun();
    const framed = `${ESC}[31mError:${ESC}[0m ${ESC}]0;title${BEL}boom${NUL}`;
    run.child?.stderr.emit('data', Buffer.from(framed, 'utf8'));
    const result = await closeWith(run, 1);
    expect(result.stderr).toBe('Error: boom');
    expect(result.stderr).not.toContain(ESC);
    expect(result.stderr).not.toContain(BEL);
    expect(result.stderr).not.toContain(NUL);
  });

  it('leaves a successful stdout byte-for-byte unchanged (the adapter owns response semantics)', async () => {
    const run = startRun();
    const raw = `${ESC}[K## result\n\n\`\`\`ts\nconst x = 1;\n\`\`\`${NUL}`;
    run.child?.stdout.emit('data', Buffer.from(raw, 'utf8'));
    const result = await closeWith(run, 0);
    expect(result.stdout).toBe(raw);
    expect(result.stdout).toContain(ESC);
  });
});

describe('contained CLI runner: child lifecycle', () => {
  it('spawns with shell:false, the caller cwd, and a piped stdio triple', async () => {
    const run = startRun({ cwd: '/caller/cwd', bin: 'some-cli', args: ['run', 'a-model'] });
    await closeWith(run);
    expect(run.spawns[0]?.bin).toBe('some-cli');
    expect(run.spawns[0]?.args).toEqual(['run', 'a-model']);
    expect(run.spawns[0]?.options.shell).toBe(false);
    expect(run.spawns[0]?.options.cwd).toBe('/caller/cwd'); // never replaced by the temp dir
    expect(run.spawns[0]?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('writes the prompt to stdin and ends it', async () => {
    const stdin = new FakeStdin();
    const run = startRun({ stdin, input: 'my prompt' });
    await closeWith(run);
    expect(stdin.written).toEqual(['my prompt']);
    expect(stdin.ended).toBe(true);
  });

  it('fails closed when stdin is unavailable', async () => {
    const run = startRun({ stdin: null });
    run.child?.emit('close', 0, null);
    const result = await run.result;
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to open the provider process input stream.');
    expect(result.timedOut).toBe(false);
    expect(run.child?.signals).toEqual(['SIGTERM']);
  });

  it('fails closed when the stdin write callback errors while a prompt was pending', async () => {
    const stdin = new FakeStdin({ writeError: new Error('EPIPE') });
    const run = startRun({ stdin, input: 'a prompt' });
    run.child?.stdout.emit('data', Buffer.from('partial', 'utf8'));
    const result = await closeWith(run, 0);
    expect(result.code).toBeNull(); // an undelivered prompt is never a success
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to deliver the prompt to the provider process.');
  });

  it('fails closed when the stdin stream emits an error while a prompt was pending', async () => {
    const stdin = new FakeStdin({ emitError: new Error('EPIPE') });
    const run = startRun({ stdin, input: 'a prompt' });
    const result = await closeWith(run, 0);
    expect(result.code).toBeNull();
    expect(result.stderr).toBe('Failed to deliver the prompt to the provider process.');
  });

  it('fails closed on a SYNCHRONOUS stdin.write throw, terminating and settling once', async () => {
    const thrown = new Error('EPIPE on /Users/tester/.secrets/pipe');
    const stdin = new FakeStdin({ writeThrows: thrown });
    const run = startRun({ stdin, input: 'a prompt' });
    expect(stdin.written).toEqual([]); // the write never landed
    expect(run.child?.signals).toEqual(['SIGTERM']); // terminated once
    const result = await closeWith(run, 0);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to deliver the prompt to the provider process.');
    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('/Users/tester');
    expect(result.stderr).not.toContain('EPIPE');
    const snapshot = only(run); // settle exactly once
    expect(snapshot.terminationRequests).toBe(1);
    expect(snapshot.cleanupAttempts).toBe(1);
  });

  it('fails closed on an end()/write race that throws', async () => {
    const stdin = new FakeStdin({ endThrows: new Error('already ended') });
    const run = startRun({ stdin, input: 'a prompt' });
    const result = await closeWith(run, 0);
    expect(result.code).toBeNull();
    expect(result.stderr).toBe('Failed to deliver the prompt to the provider process.');
  });

  it('ignores a harmless stdin error when there was no prompt to deliver (availability probe)', async () => {
    const stdin = new FakeStdin({ emitError: new Error('EPIPE') });
    const run = startRun({ stdin, input: '', args: ['--version'] });
    run.child?.stdout.emit('data', Buffer.from('1.2.3', 'utf8'));
    const result = await closeWith(run, 0);
    expect(stdin.written).toEqual([]); // nothing written for an empty input
    expect(result.code).toBe(0); // the probe still succeeds
    expect(result.stdout).toBe('1.2.3');
  });

  it('ignores a synchronous stdin.write throw shape for an availability probe (never called)', async () => {
    const stdin = new FakeStdin({ writeThrows: new Error('EPIPE') });
    const run = startRun({ stdin, input: '', args: ['--version'] });
    run.child?.stdout.emit('data', Buffer.from('1.2.3', 'utf8'));
    const result = await closeWith(run, 0);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('1.2.3');
    expect(run.child?.signals).toEqual([]);
  });

  it('handles a signal-only close (no exit code)', async () => {
    const run = startRun();
    run.child?.emit('close', null, 'SIGKILL');
    const result = await run.result;
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('settles once with the close result when close precedes a late error', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.from('answer', 'utf8'));
    run.child?.emit('close', 0, null);
    run.child?.emit('error', new Error('late error'));
    const result = await run.result;
    // Close wins: the observed exit code and output survive the late error.
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('answer');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    await tick();
    expect(run.created).toHaveLength(1);
    expect(run.removed).toHaveLength(1);
    expect(only(run).cleanupAttempts).toBe(1);
  });

  it('settles once with the spawn failure when error precedes close', async () => {
    const run = startRun();
    run.child?.emit('error', new Error('early error'));
    run.child?.emit('close', 0, null);
    const result = await run.result;
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Failed to start provider process.');
    await tick();
    expect(run.removed).toHaveLength(1);
    expect(only(run).cleanupAttempts).toBe(1);
  });

  it('removes every stream/process listener and timer once settled', async () => {
    const run = startRun({ timeoutMs: 10_000 });
    const child = run.child;
    expect(child?.listenerCount('close')).toBe(1);
    expect(child?.stdout.listenerCount('data')).toBe(1);
    const result = await closeWith(run);
    expect(child?.listenerCount('close')).toBe(0);
    expect(child?.stdout.listenerCount('data')).toBe(0);
    expect(child?.stderr.listenerCount('data')).toBe(0);
    expect(child?.stdin?.listenerCount('error')).toBe(0);
    // One swallowing 'error' listener is retained on purpose (see finalize()).
    expect(child?.listenerCount('error')).toBe(1);
    expect(run.timers.timeout?.cleared).toBe(true);
    // Late events after settling change neither the result nor the resources.
    child?.stdout.emit('data', Buffer.from('late', 'utf8'));
    child?.emit('close', 1, null);
    child?.emit('error', new Error('late'));
    await tick();
    expect(result.stdout).toBe('');
    expect(result.code).toBe(0);
    expect(run.removed).toHaveLength(1);
    expect(run.snapshots).toHaveLength(1);
  });
});

describe('contained CLI runner: no retry', () => {
  it('spawns exactly once for a non-zero exit', async () => {
    const run = startRun();
    run.child?.stderr.emit('data', Buffer.from('failed', 'utf8'));
    const result = await closeWith(run, 2);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('failed');
    expect(run.spawns).toHaveLength(1);
  });

  it('spawns exactly once for a timeout', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    run.timers.fire(run.timers.timeout);
    await closeWith(run, null);
    expect(run.spawns).toHaveLength(1);
  });

  it('spawns exactly once for a spawn error', async () => {
    const run = startRun();
    run.child?.emit('error', new Error('boom'));
    await run.result;
    expect(run.spawns).toHaveLength(1);
  });

  it('spawns exactly once for an overflow', async () => {
    const run = startRun();
    run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    await closeWith(run, null);
    expect(run.spawns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The full failure projection contract, in one place.
// ---------------------------------------------------------------------------

describe('contained CLI runner: failure projection', () => {
  const genericFailure = (result: CliRunResult): void => {
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.split('\n')).toHaveLength(1); // one bounded line
    expect(result.timedOut).toBe(false);
  };

  it('projects every containment failure as code null / empty stdout / generic stderr', async () => {
    genericFailure(await startRun({ env: { GITHUB_TOKEN: 'x' } }).result);
    genericFailure(await startRun({ createThrows: true }).result);
    genericFailure(await startRun({ spawnThrows: new Error('x') }).result);

    const stdinRun = startRun({ stdin: null });
    stdinRun.child?.emit('close', 0, null);
    genericFailure(await stdinRun.result);

    const overflowRun = startRun();
    overflowRun.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
    genericFailure(await closeWith(overflowRun, 0));

    const cleanupRun = startRun({ removeThrows: true });
    cleanupRun.child?.stdout.emit('data', Buffer.from('ignored', 'utf8'));
    genericFailure(await closeWith(cleanupRun, 0));
    rmSync(cleanupRun.created[0] ?? '', { recursive: true, force: true });
  });

  it('projects a timeout with timedOut true and the bounded output kept', async () => {
    const run = startRun({ timeoutMs: 1_000 });
    run.child?.stdout.emit('data', Buffer.from('partial', 'utf8'));
    run.child?.stderr.emit('data', Buffer.from('warn', 'utf8'));
    run.timers.fire(run.timers.timeout);
    const result = await closeWith(run, null);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toBe('warn');
  });

  it('projects a normal non-zero exit and a normal success unchanged (baseline)', async () => {
    const failing = startRun();
    failing.child?.stdout.emit('data', Buffer.from('some output', 'utf8'));
    failing.child?.stderr.emit('data', Buffer.from('some warning', 'utf8'));
    const failed = await closeWith(failing, 3);
    expect(failed).toEqual({
      code: 3,
      stdout: 'some output',
      stderr: 'some warning',
      timedOut: false,
    });

    const ok = startRun();
    ok.child?.stdout.emit('data', Buffer.from('the answer', 'utf8'));
    const success = await closeWith(ok, 0);
    expect(success).toEqual({ code: 0, stdout: 'the answer', stderr: '', timedOut: false });
  });
});

// ---------------------------------------------------------------------------
// `onContainment` is a PURE OBSERVATION seam: a throwing observer must be fully
// isolated from the execution lifecycle.
// ---------------------------------------------------------------------------

const HOOK_SECRET_FRAGMENTS = [
  'ghp_secret-token',
  '/Users/tester/.secrets/provider',
  'password=hunter2',
] as const;

/** A hook error carrying every fragment that must never reach a result. */
const throwingHook = (): Error =>
  new Error(`observation hook exploded: ${HOOK_SECRET_FRAGMENTS.join(' ')}`);

/** One reusable child lifecycle, so a normal hook and a throwing hook are comparable. */
type Lifecycle = (run: StartedRun) => Promise<CliRunResult>;

const successLifecycle: Lifecycle = (run) => {
  run.child?.stdout.emit('data', Buffer.from('the complete answer', 'utf8'));
  run.child?.stderr.emit('data', Buffer.from('a warning', 'utf8'));
  return closeWith(run, 0);
};

const timeoutLifecycle: Lifecycle = (run) => {
  run.child?.stdout.emit('data', Buffer.from('partial answer', 'utf8'));
  run.child?.stderr.emit('data', Buffer.from('slow', 'utf8'));
  run.timers.fire(run.timers.timeout);
  return closeWith(run, null);
};

const overflowLifecycle: Lifecycle = (run) => {
  run.child?.stdout.emit('data', Buffer.alloc(MAX_STDOUT_CAPTURE_BYTES + 1, 0x61));
  return closeWith(run, null);
};

interface Watched<T> {
  value: T;
  uncaught: unknown[];
}

/** Records any uncaught exception / unhandled rejection raised while `body` runs. */
async function watchUncaught<T>(body: () => Promise<T>): Promise<Watched<T>> {
  const uncaught: unknown[] = [];
  const record = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    const value = await body();
    await tick(); // let any deferred throw surface before we stop watching
    return { value, uncaught };
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
}

describe('contained CLI runner: observation hook isolation', () => {
  it('resolves normally when the observation hook throws (no uncaught, no rejection)', async () => {
    const run = startRun({ hookThrows: throwingHook() });
    let rejected = false;
    const watched = await watchUncaught(() =>
      successLifecycle(run).catch((error: unknown) => {
        rejected = true;
        throw error;
      }),
    );
    expect(rejected).toBe(false);
    expect(watched.uncaught).toEqual([]);
    expect(watched.value).toEqual({
      code: 0,
      stdout: 'the complete answer',
      stderr: 'a warning',
      timedOut: false,
    });
    expect(run.snapshots).toHaveLength(1); // the hook really did run, and really did throw
  });

  it('produces an identical result with a normal hook and a throwing hook', async () => {
    const normal = await successLifecycle(startRun());
    const throwing = await successLifecycle(startRun({ hookThrows: throwingHook() }));
    expect(throwing).toEqual(normal);
  });

  it('still attempts cleanup exactly once when the hook throws', async () => {
    const run = startRun({ hookThrows: throwingHook() });
    await successLifecycle(run);
    expect(run.removed).toEqual(run.created);
    expect(run.removed).toHaveLength(1);
    expect(only(run).cleanupAttempts).toBe(1);
    expect(existsSync(run.created[0] ?? '')).toBe(false);
  });

  it('sends no signal on a successful path when the hook throws', async () => {
    const run = startRun({ hookThrows: throwingHook() });
    await successLifecycle(run);
    expect(run.child?.signals).toEqual([]);
    expect(only(run).terminationRequests).toBe(0);
  });

  it('leaves a timeout lifecycle unchanged when the hook throws', async () => {
    const normalRun = startRun({ timeoutMs: 1_000 });
    const normal = await timeoutLifecycle(normalRun);
    const throwingRun = startRun({ timeoutMs: 1_000, hookThrows: throwingHook() });
    const throwing = await timeoutLifecycle(throwingRun);
    expect(throwing).toEqual(normal);
    expect(throwing.timedOut).toBe(true);
    expect(throwing.stdout).toBe('partial answer');
    expect(throwing.stderr).toBe('slow');
    expect(throwingRun.child?.signals).toEqual(normalRun.child?.signals);
    expect(throwingRun.child?.signals).toEqual(['SIGTERM']);
    expect(only(throwingRun).cleanupAttempts).toBe(only(normalRun).cleanupAttempts);
    expect(only(throwingRun).terminationRequests).toBe(1);
  });

  it('leaves an overflow containment failure unchanged when the hook throws', async () => {
    const normalRun = startRun();
    const normal = await overflowLifecycle(normalRun);
    const throwingRun = startRun({ hookThrows: throwingHook() });
    const throwing = await overflowLifecycle(throwingRun);
    expect(throwing).toEqual(normal);
    expect(throwing).toEqual({
      code: null,
      stdout: '',
      stderr: 'Provider process exceeded the stdout capture limit.',
      timedOut: false,
    });
    expect(throwingRun.child?.signals).toEqual(['SIGTERM']);
    expect(only(throwingRun).stdoutDecodeCalls).toBe(0);
    expect(only(throwingRun).terminationRequests).toBe(1);
  });

  it('leaves a spawn failure unchanged when the hook throws', async () => {
    const normal = await startRun({ spawnThrows: new Error('spawn boom') }).result;
    const throwingRun = startRun({ spawnThrows: new Error('spawn boom'), hookThrows: throwingHook() });
    const throwing = await throwingRun.result;
    expect(throwing).toEqual(normal);
    expect(throwing).toEqual({
      code: null,
      stdout: '',
      stderr: 'Failed to start provider process.',
      timedOut: false,
    });
    expect(throwingRun.removed).toEqual(throwingRun.created);
  });

  it('never exposes the hook error, on any lifecycle', async () => {
    const lifecycles: Array<[string, Lifecycle, StartConfig]> = [
      ['success', successLifecycle, {}],
      ['timeout', timeoutLifecycle, { timeoutMs: 1_000 }],
      ['overflow', overflowLifecycle, {}],
      ['spawn failure', (run) => run.result, { spawnThrows: new Error('spawn boom') }],
      ['cleanup failure', successLifecycle, { removeThrows: true }],
    ];
    for (const [, lifecycle, config] of lifecycles) {
      const run = startRun({ ...config, hookThrows: throwingHook() });
      const result = await lifecycle(run);
      const serialized = JSON.stringify(result);
      for (const fragment of HOOK_SECRET_FRAGMENTS) {
        expect(serialized).not.toContain(fragment);
      }
      expect(serialized).not.toContain('observation hook exploded');
      if (config.removeThrows) rmSync(run.created[0] ?? '', { recursive: true, force: true });
    }
  });

  it('settles exactly once after a hook throw, ignoring every late event', async () => {
    const run = startRun({ hookThrows: throwingHook(), timeoutMs: 1_000 });
    const result = await successLifecycle(run);
    const before = { ...result };
    let thenCount = 0;
    void run.result.then(() => {
      thenCount += 1;
    });
    run.child?.stdout.emit('data', Buffer.from('late stdout', 'utf8'));
    run.child?.stderr.emit('data', Buffer.from('late stderr', 'utf8'));
    run.child?.emit('close', 1, null);
    run.child?.emit('error', new Error('late error'));
    run.timers.fire(run.timers.timeout);
    run.timers.fire(run.timers.grace); // never armed on this path — a no-op
    await tick();
    expect(result).toEqual(before);
    expect(thenCount).toBe(1); // resolved exactly once
    expect(run.snapshots).toHaveLength(1); // settle entered exactly once
    expect(run.removed).toHaveLength(1); // cleanup attempted exactly once
    expect(run.child?.signals).toEqual([]);
  });

  it('hands the hook a frozen snapshot (a pure observation seam)', async () => {
    const run = startRun();
    await successLifecycle(run);
    expect(Object.isFrozen(only(run))).toBe(true);
  });
});
