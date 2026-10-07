import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sanitizeTerminalOutput } from './output-sanitizer';

export interface CliRunOptions {
  /** Working directory for the process (use a neutral dir to avoid CLAUDE.md pickup). */
  cwd: string;
  /** Text written to the child's stdin (the prompt — never passed as an argv). */
  input: string;
  timeoutMs: number;
  /**
   * Provider-owned child environment overrides. Only the names in
   * {@link CALLER_ENV_ALLOWLIST} are accepted; anything else makes the run fail
   * closed WITHOUT spawning, so `options.env` can never be used as a bypass for
   * full parent-environment inheritance.
   */
  env?: Readonly<Record<string, string>>;
  /** Opt-in environment used only by the app-private Ollama generation validator. */
  environmentProfile?: 'ISOLATED_OLLAMA_VALIDATION';
  /**
   * Bounded observation only; this does not prevent bytes sent before a marker.
   * `OLLAMA_PULL` scans stdout and stderr (isolated validation, controlled prompts).
   * `OLLAMA_PULL_STDERR` scans stderr only: `ollama run` prints pull progress there, so a
   * production answer on stdout that merely quotes a pull log is never mistaken for a download.
   */
  downloadMarkerPolicy?: 'OLLAMA_PULL' | 'OLLAMA_PULL_STDERR';
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  downloadObserved?: boolean;
  outputOverflowed?: boolean;
}

/**
 * Injectable CLI executor. The default uses node:child_process; tests inject a
 * fake to assert command construction without spawning anything.
 */
export type CliRunner = (bin: string, args: string[], options: CliRunOptions) => Promise<CliRunResult>;

// ---------------------------------------------------------------------------
// Containment bounds
// ---------------------------------------------------------------------------

/**
 * Per-stream capture bound for stdout. Sized for a real PRODUCT response — a code
 * proposal carries whole-file `newContent`, so the Stage 2A validation harness's
 * 8 KiB preview bound would truncate legitimate output. 256 KiB is generous for a
 * single-file proposal while keeping worst-case accumulation flat and predictable.
 */
export const MAX_STDOUT_CAPTURE_BYTES = 262_144;

/**
 * Per-stream capture bound for stderr — deliberately smaller than stdout because
 * stderr is DIAGNOSTIC ONLY: both providers surface at most 300–1,000 characters of
 * it and never turn it into response text.
 */
export const MAX_STDERR_CAPTURE_BYTES = 65_536;

/** Grace period between SIGTERM and SIGKILL when the runner stops a child. */
export const KILL_GRACE_MS = 1_000;

/** Prefix of the runner-owned per-child temporary directory (always under OS temp). */
export const CHILD_TEMP_PREFIX = 'chunsik-cli-';

/**
 * The ONLY parent-process variables forwarded to a child. The full `process.env`
 * is never inherited, so no API key, token, password, credential, proxy setting,
 * certificate override, Node preload (`NODE_OPTIONS`/`NODE_PATH`/`LD_PRELOAD`/
 * `DYLD_*`), or shell-initialization value can reach a Provider process.
 *
 * `PATH` is required because both CLI adapters are configured with a bare command
 * name. `HOME` is required and deliberately preserved: Claude's existing OAuth /
 * global configuration and Ollama's model inventory both live under it. Isolating
 * HOME is a separate, later Architecture Sprint — not this one.
 *
 * `USER` (a non-secret login name) is required on macOS: the Claude Code CLI reads
 * its OAuth login from the login Keychain and needs `USER` to locate it; without it
 * every `claude -p` fails with "Not logged in". `LOGNAME` is deliberately NOT
 * forwarded: verified live, adding it alongside `USER` breaks the Keychain lookup.
 */
export const INHERITED_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;

/**
 * The only names a Provider adapter may add through `CliRunOptions.env`. Minimised
 * to what the in-tree adapters actually require today: Ollama's colour controls
 * (Claude passes no environment at all). `TMPDIR` is intentionally absent — it is
 * runner-owned and must not be overridable by a caller.
 */
export const CALLER_ENV_ALLOWLIST = ['NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE'] as const;
const VALIDATION_ENV_ALLOWLIST = new Set([
  'NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'OLLAMA_HOST', 'OLLAMA_NO_CLOUD',
]);

const CALLER_ENV_ALLOWED = new Set<string>(CALLER_ENV_ALLOWLIST);

function isExactIpv4LoopbackEndpoint(value: string | undefined): boolean {
  if (value === undefined || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u.test(value)) return false;
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * Bounded, GENERIC containment-failure reasons. None embeds captured output, a raw
 * OS error message, an environment name or value, a prompt, or a filesystem path.
 * Generic classification is deliberately preferred over masking a raw message: a
 * spawn error can carry the executable path, the user's HOME, or a token-shaped
 * fragment, and no regex is a sound boundary for that.
 */
const REASON_ENV_REJECTED = 'Refused a provider environment variable that is not allow-listed.';
const REASON_SANDBOX_CREATE = 'Failed to prepare the provider process sandbox.';
const REASON_SANDBOX_CLEANUP = 'Failed to clean up the provider process sandbox.';
const REASON_SPAWN = 'Failed to start provider process.';
const REASON_STDOUT_OVERFLOW = 'Provider process exceeded the stdout capture limit.';
const REASON_STDERR_OVERFLOW = 'Provider process exceeded the stderr capture limit.';
const REASON_STDIN_UNAVAILABLE = 'Failed to open the provider process input stream.';
const REASON_STDIN_DELIVERY = 'Failed to deliver the prompt to the provider process.';

export type ChildEnvironment =
  | { readonly ok: true; readonly env: Record<string, string> }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the child environment explicitly. Nothing is inherited except the
 * allow-listed names above; `TMPDIR` is always the runner-owned directory; a
 * caller may only add {@link CALLER_ENV_ALLOWLIST} names. Any other caller name
 * fails closed (the caller's run is refused before a process is spawned).
 */
export function buildChildEnvironment(
  parent: NodeJS.ProcessEnv,
  temporaryDirectory: string,
  callerEnv?: Readonly<Record<string, string>>,
  profile?: CliRunOptions['environmentProfile'],
): ChildEnvironment {
  if (profile === 'ISOLATED_OLLAMA_VALIDATION') {
    if (!isExactIpv4LoopbackEndpoint(callerEnv?.OLLAMA_HOST)) {
      return { ok: false, reason: REASON_ENV_REJECTED };
    }
    const env: Record<string, string> = {
      HOME: temporaryDirectory,
      TMPDIR: temporaryDirectory,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    };
    for (const name of Object.keys(callerEnv ?? {})) {
      if (!VALIDATION_ENV_ALLOWLIST.has(name)) return { ok: false, reason: REASON_ENV_REJECTED };
      const value = callerEnv?.[name];
      if (typeof value === 'string') env[name] = value;
    }
    return { ok: true, env };
  }
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  // Runner-owned, set BEFORE the caller overrides and not caller-allow-listed, so a
  // provider can neither read nor redirect another child's temporary directory.
  env.TMPDIR = temporaryDirectory;
  if (callerEnv) {
    for (const name of Object.keys(callerEnv)) {
      if (!CALLER_ENV_ALLOWED.has(name)) {
        return { ok: false, reason: REASON_ENV_REJECTED };
      }
      const value = callerEnv[name];
      if (typeof value === 'string') env[name] = value;
    }
  }
  return { ok: true, env };
}

// ---------------------------------------------------------------------------
// Contained runner
// ---------------------------------------------------------------------------

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Minimal timer handle shape; `NodeJS.Timeout` satisfies it structurally. */
export interface TimerHandle {
  unref?: () => void;
}

/** Injectable scheduler so lifecycle ordering can be tested without real timers. */
export interface RunnerTimers {
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
}

const defaultTimers: RunnerTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as TimerHandle,
  clearTimeout: (timer) => clearTimeout(timer as unknown as NodeJS.Timeout),
};

/**
 * Internal containment counters, surfaced ONLY through the optional test hook.
 * They are deliberately absent from {@link CliRunResult} — the public runner
 * contract is unchanged.
 */
export interface ContainmentSnapshot {
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDecodeCalls: number;
  readonly stderrDecodeCalls: number;
  readonly terminationRequests: number;
  readonly cleanupAttempts: number;
}

/** Signals a whole process group (`process.kill(-pid, signal)` in production). */
export type ProcessGroupKill = (pid: number, signal: NodeJS.Signals) => void;

/** Test seams. Production always uses the real defaults; no behaviour branches on them. */
export interface ContainedRunnerHooks {
  spawnFn?: SpawnLike;
  createTempDir?: () => string;
  removeTempDir?: (dir: string) => void;
  killGraceMs?: number;
  /** Spawn the child as the leader of its own process group. Default: every platform except Windows. */
  processGroup?: boolean;
  /** How a process group is signalled. Default: `process.kill(-pid, signal)`. */
  killProcessGroup?: ProcessGroupKill;
  parentEnv?: NodeJS.ProcessEnv;
  timers?: RunnerTimers;
  /** Observation only — called once, immediately before the promise resolves. */
  onContainment?: (snapshot: ContainmentSnapshot) => void;
}

function createChildTempDir(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), CHILD_TEMP_PREFIX));
}

function removeChildTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
}

type StdinFailure = 'none' | 'unavailable' | 'delivery';

const defaultKillProcessGroup: ProcessGroupKill = (pid, signal) => {
  process.kill(-pid, signal);
};

/**
 * Process groups of children that are still running. A child in its own group no longer receives the signals sent to
 * Quoky's group (a terminal Ctrl-C, launchd stopping the job), so when the Quoky process exits while a provider call
 * is in flight, the remaining groups are killed here. A hard kill of Quoky itself (SIGKILL) cannot run this hook; such
 * a child then ends on its own when its CLI finishes.
 */
const liveProcessGroups = new Map<number, ProcessGroupKill>();
let exitHookInstalled = false;

function trackProcessGroup(pid: number, kill: ProcessGroupKill): void {
  liveProcessGroups.set(pid, kill);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [groupPid, groupKill] of liveProcessGroups) {
      try {
        groupKill(groupPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    liveProcessGroups.clear();
  });
}

/**
 * Runs ONE command with an ARGUMENT ARRAY (never a shell string, never `shell: true`),
 * a required timeout, cwd = the caller's directory, and **bounded child containment**:
 *
 *  - **No parent-environment inheritance.** The child receives only
 *    {@link INHERITED_ENV_ALLOWLIST} + a runner-owned `TMPDIR` + the caller's
 *    {@link CALLER_ENV_ALLOWLIST} names; any other caller name is refused BEFORE spawn.
 *  - **Runner-owned temporary directory** per child, created under OS temp (never inside
 *    the repository), attempted for removal exactly once. A cleanup failure is a
 *    CONTAINMENT FAILURE, never a success carrying provider output.
 *  - **Independent per-stream BYTE bounds** (not character counts). A chunk that would
 *    breach a bound is never decoded and never partially kept; the stream is dropped,
 *    the child is stopped once (SIGTERM → grace → SIGKILL), and the run fails closed.
 *  - **Process-group termination.** Outside Windows the child leads its own process group, and every termination
 *    signal goes to the whole group, so a CLI wrapper's native grandchild (the Codex Node wrapper forwards SIGTERM
 *    but not SIGKILL) cannot outlive the call. A group signal that fails falls back to the child itself.
 *  - **Bounded settle.** If `close` still has not been observed one grace period after SIGKILL (a descendant keeps the
 *    pipes open), the runner destroys the child's stdio streams, settles (a timeout stays `timedOut`) and cleans up,
 *    so a call can never stay pending.
 *  - **UTF-8-safe streaming** via one `StringDecoder` per stream (never shared), flushed
 *    on close, so a multi-byte sequence split across chunks is restored correctly.
 *  - **Close wins over the timeout.** Observing `close` synchronously freezes
 *    `closeObserved`, clears both timers, and disarms every signal path; only the RESULT
 *    PROJECTION is deferred one macrotask, purely to observe a late stdin EPIPE.
 *  - **Single-settle + single-finalize**: the promise resolves once AND timers, listeners,
 *    and the temporary directory are released exactly once.
 *  - **Generic failure classification.** Every containment failure returns a bounded
 *    generic reason — never a raw OS error message, path, or captured output.
 *  - **Diagnostic-only sanitation**: a successful `stdout` is passed through byte-for-byte
 *    (the provider adapters own response-text sanitation); terminal control sequences are
 *    stripped only from the diagnostic `stderr`.
 *
 * There is **no retry** at this layer — not for a spawn failure, not for a timeout, not
 * for a non-zero exit. Retry is a future Loop control-policy concern.
 */
export function createContainedCliRunner(hooks: ContainedRunnerHooks = {}): CliRunner {
  const spawnFn = hooks.spawnFn ?? (spawn as unknown as SpawnLike);
  const createTempDir = hooks.createTempDir ?? createChildTempDir;
  const removeTempDir = hooks.removeTempDir ?? removeChildTempDir;
  const killGraceMs = hooks.killGraceMs ?? KILL_GRACE_MS;
  const useProcessGroup = hooks.processGroup ?? process.platform !== 'win32';
  const killProcessGroup = hooks.killProcessGroup ?? defaultKillProcessGroup;
  const timers = hooks.timers ?? defaultTimers;
  const parentEnvOf = (): NodeJS.ProcessEnv => hooks.parentEnv ?? process.env;

  return (bin, args, options) =>
    new Promise<CliRunResult>((resolve) => {
      const structuredValidationObservations =
        options.environmentProfile === 'ISOLATED_OLLAMA_VALIDATION';
      const observedResult = (result: CliRunResult): CliRunResult => ({
        ...result,
        ...(options.downloadMarkerPolicy === undefined ? {} : {
          downloadObserved: result.downloadObserved ?? false,
        }),
        ...(structuredValidationObservations ? {
          outputOverflowed: result.outputOverflowed ?? false,
        } : {}),
      });
      let temporaryDirectory: string;
      try {
        temporaryDirectory = createTempDir();
      } catch {
        // Nothing was spawned and nothing was created: fail closed immediately.
        resolve(observedResult({ code: null, stdout: '', stderr: REASON_SANDBOX_CREATE, timedOut: false }));
        return;
      }

      const childEnv = buildChildEnvironment(
        parentEnvOf(), temporaryDirectory, options.env, options.environmentProfile,
      );
      if (!childEnv.ok) {
        let refusedReason = childEnv.reason;
        try {
          removeTempDir(temporaryDirectory);
        } catch {
          refusedReason = REASON_SANDBOX_CLEANUP;
        }
        // Refused before any process exists — `code: null` keeps the providers'
        // existing "could not run" mapping (UNAVAILABLE).
        resolve(observedResult({ code: null, stdout: '', stderr: refusedReason, timedOut: false }));
        return;
      }

      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutDecodeCalls = 0;
      let stderrDecodeCalls = 0;
      let terminationRequests = 0;
      let cleanupAttempts = 0;
      let stdoutOverflowed = false;
      let stderrOverflowed = false;
      let timedOut = false;
      let spawnFailed = false;
      let stdinFailure: StdinFailure = 'none';
      let cleanupFailed = false;
      let downloadObserved = false;
      let markerTail = '';
      let closeObserved = false;
      let killRequested = false;
      let killEscalated = false;
      let settled = false;
      let finalized = false;
      let timeoutTimer: TimerHandle | undefined;
      let forceKillTimer: TimerHandle | undefined;
      let abandonTimer: TimerHandle | undefined;
      let child: ChildProcess | undefined;
      let groupPid: number | undefined;

      /**
       * Any condition that makes this run a containment failure. Once true, no further
       * chunk may be counted, decoded, or accumulated.
       */
      const containmentFailed = (): boolean =>
        spawnFailed || stdoutOverflowed || stderrOverflowed || downloadObserved || stdinFailure !== 'none';

      const clearTimers = (): void => {
        if (timeoutTimer) {
          timers.clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (forceKillTimer) {
          timers.clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        if (abandonTimer) {
          timers.clearTimeout(abandonTimer);
          abandonTimer = undefined;
        }
      };

      /**
       * Releases every child-lifecycle resource EXACTLY once — timers, stream and
       * process listeners, and the runner-owned temporary directory. Deliberately
       * separate from `settled`: resolving the promise once is not the same as
       * releasing resources once. Re-entrancy is impossible: `finalized` is set
       * BEFORE the cleanup attempt, so a throwing cleanup cannot re-enter.
       */
      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        clearTimers();
        if (groupPid !== undefined) liveProcessGroups.delete(groupPid);
        child?.stdout?.removeAllListeners();
        child?.stderr?.removeAllListeners();
        child?.stdin?.removeAllListeners();
        child?.removeAllListeners();
        // A ChildProcess with no 'error' listener turns a late emit into an UNHANDLED
        // error event, which would crash the host process. One swallowing listener is
        // retained on purpose: after settling, a late error can change nothing.
        child?.on('error', () => undefined);
        cleanupAttempts += 1;
        try {
          removeTempDir(temporaryDirectory);
        } catch {
          cleanupFailed = true;
        }
      };

      const failClosed = (reason: string, outputOverflowed = false): CliRunResult => observedResult({
        code: null,
        stdout: '',
        stderr: reason,
        timedOut: false,
        ...(structuredValidationObservations ? { outputOverflowed } : {}),
      });

      const finishResult = (code: number | null): CliRunResult => {
        // Containment failures first: each returns the same shape with a bounded
        // generic reason, and NEVER carries provider output or a real exit code.
        if (spawnFailed) return failClosed(REASON_SPAWN);
        if (stdoutOverflowed) return failClosed(REASON_STDOUT_OVERFLOW, true);
        if (stderrOverflowed) return failClosed(REASON_STDERR_OVERFLOW, true);
        if (stdinFailure === 'unavailable') return failClosed(REASON_STDIN_UNAVAILABLE);
        if (stdinFailure === 'delivery') return failClosed(REASON_STDIN_DELIVERY);
        // A sandbox that could not be removed is a containment failure even when the
        // child exited 0: provider data may still be on disk, so the run must not be
        // reported as an application success. Ordered BEFORE the timeout projection so
        // a cleanup failure is never reported as a timeout.
        if (cleanupFailed) return failClosed(REASON_SANDBOX_CLEANUP);
        // Timeout and normal exit share one projection: the observed exit code plus the
        // bounded output captured so far. `stdout` is returned untouched (the provider
        // adapters own response-text semantics); only the diagnostic stream is sanitized.
        return observedResult({
          code, stdout, stderr: sanitizeTerminalOutput(stderr), timedOut,
          ...(options.downloadMarkerPolicy === undefined ? {} : { downloadObserved }),
        });
      };

      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        finalize(); // must run first: it decides `cleanupFailed`
        // The result is computed BEFORE the observation hook runs, so nothing the hook
        // does can change what the caller receives.
        const result = finishResult(code);
        const snapshot: ContainmentSnapshot = Object.freeze({
          stdoutBytes,
          stderrBytes,
          stdoutDecodeCalls,
          stderrDecodeCalls,
          terminationRequests,
          cleanupAttempts,
        });
        try {
          hooks.onContainment?.(snapshot);
        } catch {
          // `onContainment` is a PURE OBSERVATION seam: a throwing observer must never
          // affect the execution lifecycle. The throw is swallowed here — not projected
          // as a containment failure, not added to stderr, not logged, not retried, and
          // never allowed to leave the promise unresolved.
        }
        resolve(result);
      };

      /**
       * Requests termination at most once: SIGTERM, then SIGKILL after the grace
       * period. Disarmed the instant `close` is observed, so no signal is ever sent
       * to an already-exited child (and a late grace callback is a no-op).
       */
      /** Signal the child's whole process group when it leads one; otherwise (or if that fails) the child itself. */
      const signalChild = (signal: NodeJS.Signals): void => {
        if (groupPid !== undefined) {
          try {
            killProcessGroup(groupPid, signal);
            return;
          } catch {
            /* group already gone or not signalable: fall back to the child */
          }
        }
        try {
          child?.kill(signal);
        } catch {
          /* already gone */
        }
      };

      const requestTermination = (): void => {
        if (killRequested || closeObserved || !child) return;
        killRequested = true;
        terminationRequests += 1;
        signalChild('SIGTERM');
        forceKillTimer = timers.setTimeout(() => {
          // A late or repeated grace callback must never signal again.
          if (closeObserved || settled || killEscalated) return;
          killEscalated = true;
          signalChild('SIGKILL');
          // Bounded settle: a descendant that survived (or ignored) the signals may still hold the inherited pipes, so
          // `close` might never come. One more grace period, then stop waiting for it.
          abandonTimer = timers.setTimeout(() => {
            if (closeObserved || settled) return;
            for (const stream of [child?.stdout, child?.stderr, child?.stdin]) {
              try {
                stream?.destroy();
              } catch {
                /* already destroyed */
              }
            }
            flushDecoders();
            settle(null);
          }, killGraceMs);
          abandonTimer.unref?.();
        }, killGraceMs);
        forceKillTimer.unref?.();
      };

      try {
        child = spawnFn(bin, args, {
          cwd: options.cwd, // caller's cwd contract is preserved verbatim
          env: { ...childEnv.env },
          shell: false, // explicit: argv vector, never a shell string
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // Own process group (POSIX), so termination reaches every descendant; see `signalChild`.
          ...(useProcessGroup ? { detached: true } : {}),
        });
        if (useProcessGroup && typeof child.pid === 'number' && child.pid > 0) {
          groupPid = child.pid;
          trackProcessGroup(groupPid, killProcessGroup);
        }
      } catch {
        // Raw Error.message is deliberately discarded: it can carry the executable
        // path, the user's HOME, or a secret-shaped fragment.
        spawnFailed = true;
        settle(null);
        return;
      }

      const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        const isStdout = stream === 'stdout';
        // Gate BEFORE any counting or decoding: a settled run, an already-overflowed
        // stream, or any containment failure must leave every counter untouched.
        if (settled || (isStdout ? stdoutOverflowed : stderrOverflowed) || containmentFailed()) return;
        const limit = isStdout ? MAX_STDOUT_CAPTURE_BYTES : MAX_STDERR_CAPTURE_BYTES;
        const total = (isStdout ? stdoutBytes : stderrBytes) + chunk.byteLength;
        if (total > limit) {
          // The breaching chunk is NEVER handed to the decoder and never partially
          // kept, so malformed or oversized bytes cannot reach a result string.
          if (isStdout) {
            stdoutOverflowed = true;
            stdout = '';
          } else {
            stderrOverflowed = true;
            stderr = '';
          }
          requestTermination();
          return;
        }
        if (
          options.downloadMarkerPolicy === 'OLLAMA_PULL' ||
          (options.downloadMarkerPolicy === 'OLLAMA_PULL_STDERR' && !isStdout)
        ) {
          const observed = `${markerTail}${chunk.toString('utf8')}`.toLocaleLowerCase('en-US');
          markerTail = observed.slice(-128);
          if (
            observed.includes('pulling manifest') ||
            /pulling\s+[a-f0-9]{8,}/u.test(observed) ||
            observed.includes('verifying sha256 digest') ||
            observed.includes('writing manifest')
          ) {
            downloadObserved = true;
            stdout = '';
            stderr = '';
            requestTermination();
            return;
          }
        }
        if (isStdout) {
          stdoutBytes = total;
          stdoutDecodeCalls += 1;
          stdout += stdoutDecoder.write(chunk);
        } else {
          stderrBytes = total;
          stderrDecodeCalls += 1;
          stderr += stderrDecoder.write(chunk);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

      child.on('error', () => {
        // Close wins: once the child has exited, a late `error` must not override the
        // observed exit code or turn a normal exit into a spawn failure.
        if (closeObserved) return;
        // Raw Error.message deliberately discarded (see the spawn catch above).
        spawnFailed = true;
        settle(null);
      });

      /**
       * Flush both decoders at stream end. Trailing bytes were already counted when
       * their chunk arrived, so the tails are appended WITHOUT re-counting — and never
       * at all once the run is a containment failure.
       */
      const flushDecoders = (): void => {
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (containmentFailed()) return;
        if (stdoutTail.length > 0) stdout += stdoutTail;
        if (stderrTail.length > 0) stderr += stderrTail;
      };

      child.on('close', (code: number | null) => {
        // SYNCHRONOUS on close: freeze `closeObserved`, disarm both timers, and with
        // them every remaining signal path. A late timeout callback can no longer set
        // `timedOut`, and a late grace callback can no longer send SIGKILL.
        closeObserved = true;
        clearTimers();
        // Only the RESULT PROJECTION is deferred, and only so a late stdin EPIPE (a
        // child that exited before consuming the prompt) is observed first — otherwise
        // an undelivered prompt could be reported as a successful response.
        setImmediate(() => {
          if (settled) return;
          flushDecoders();
          settle(code);
        });
      });

      timeoutTimer = timers.setTimeout(() => {
        if (closeObserved || settled) return; // a normal exit is never a timeout
        timedOut = true;
        requestTermination();
      }, options.timeoutMs);
      timeoutTimer.unref?.();

      const stdin = child.stdin;
      if (!stdin) {
        stdinFailure = 'unavailable';
        requestTermination();
        return;
      }
      /** An EPIPE while delivering nothing (an availability probe) is harmless. */
      const recordStdinFailure = (): void => {
        if (stdinFailure !== 'none' || options.input.length === 0) return;
        stdinFailure = 'delivery';
        requestTermination();
      };
      stdin.on('error', recordStdinFailure);
      if (options.input.length > 0) {
        try {
          stdin.write(options.input, (error) => {
            if (error) recordStdinFailure();
          });
        } catch {
          recordStdinFailure(); // synchronous write throw
        }
      }
      try {
        stdin.end();
      } catch {
        recordStdinFailure();
      }
    });
}

/** Default runner: the contained runner with production spawn/temp/timer behaviour. */
export const defaultCliRunner: CliRunner = createContainedCliRunner();

const SECRET_PATTERNS: RegExp[] = [
  // Discord-bot-token shape: <id>.<part>.<part>
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g,
  // Common API-key / OAuth shapes
  /\b(?:sk|pk|ghp|gho|ghs|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
];

/** Redact obvious secret-shaped substrings before logging/storing CLI output. */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '***redacted***'), text);
}
