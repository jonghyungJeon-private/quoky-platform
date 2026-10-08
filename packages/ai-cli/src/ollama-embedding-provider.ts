import { tmpdir } from 'node:os';
import {
  AiFailureKind,
  AiProviderError,
  Capability,
  formatEmbeddingEnvelope,
  isEmbeddingVector,
  now,
  readEmbeddingRole,
} from '@quoky/core';
import type {
  AiCapabilityDescriptor,
  AiExecutionLocality,
  AiExecutionResult,
  AiRequest,
  EmbeddingRole,
  IsoTimestamp,
} from '@quoky/core';
import { BaseCliAiProvider } from './base-cli-provider';
import { defaultCliRunner, maskSecrets } from './cli-runner';
import type { CliRunner } from './cli-runner';
import { sanitizeTerminalOutput } from './output-sanitizer';

// ---------------------------------------------------------------------------
// Shared Ollama CLI helpers (also used by OllamaCliProvider in ./index).
// ---------------------------------------------------------------------------

/** The only caller environment an Ollama child receives (`CALLER_ENV_ALLOWLIST`; ADR-0098 D8). */
export const OLLAMA_COLOR_ENV = {
  NO_COLOR: '1',
  CLICOLOR: '0',
  CLICOLOR_FORCE: '0',
} as const;

/** Bounded probe for the Ollama daemon + model inventory; a hung daemon must not stall routing. */
export const OLLAMA_PROBE_TIMEOUT_MS = 5_000;

/**
 * ADR-0107 D6 (mirrors ADR-0098 D8): an Ollama provider declares `LOCAL` execution only when its configured model
 * name and tag contain no `cloud` (case-insensitive); an Ollama cloud-served model runs off this host and is `REMOTE`.
 */
export function ollamaModelExecutionLocality(model: string): AiExecutionLocality {
  return /cloud/i.test(model) ? 'REMOTE' : 'LOCAL';
}

/**
 * True when an `ollama list` table lists `model` (an untagged name means `:latest`).
 * The match is exact and case-sensitive: the configured model must equal the NAME
 * column of `ollama list`, otherwise the provider is reported unavailable (fail closed).
 */
export function ollamaListIncludesModel(listOutput: string, model: string): boolean {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return listOutput
    .split('\n')
    .slice(1) // header row: NAME ID SIZE MODIFIED
    .some((line) => line.trim().split(/\s+/u)[0] === wanted);
}

export function sanitizedOllamaModelName(model: string): string {
  return /^[A-Za-z0-9._:/-]{1,200}$/.test(model) ? model : '[redacted]';
}

/**
 * A non-zero exit because the DAEMON is unreachable is UNAVAILABLE, so the router drops its cached probe and
 * the next turn re-probes instead of re-selecting a dead provider. Matching is conservative — only the CLI's
 * own connection errors ("could not connect to ollama app/server", "ollama server not responding", a refused
 * dial to the local daemon address); a refused dial to a remote registry during a model download stays
 * EXECUTION_FAILED; anything else (model not found, a runtime error) stays EXECUTION_FAILED. "timed out waiting for
 * server to start" is what the macOS CLI prints after it tried to start an Ollama app that is not running (~5 s).
 */
export function classifyOllamaExitStderr(stderr: string): AiFailureKind {
  const s = stderr.toLowerCase();
  if (/could not connect to ollama|ollama server not responding|timed out waiting for server to start|(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d+[^\n]*connect: connection refused/.test(s)) {
    return AiFailureKind.UNAVAILABLE;
  }
  return AiFailureKind.EXECUTION_FAILED;
}

// ---------------------------------------------------------------------------
// Embedding provider
// ---------------------------------------------------------------------------

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text';
export const DEFAULT_OLLAMA_EMBEDDING_TIMEOUT_MS = 3_000;
/**
 * How long the daemon keeps the embedding model loaded after a call (`ollama run --keepalive`). The Ollama default is
 * 5 minutes; once the model is unloaded, the next call must load it again, and a load that queues behind another
 * model's load (a chat or vision model) easily exceeds the per-turn recall budget. The model is small (~0.3-0.4 GB).
 */
export const DEFAULT_OLLAMA_EMBEDDING_KEEP_ALIVE = '30m';
/**
 * Background warm-up bound: the "first call" allowance. A warm-up loads the model outside any turn, so its bound is
 * independent of the per-turn budget; the steady-state call timeout is unchanged.
 */
export const OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS = 30_000;
/** Minimum spacing between warm-ups started after a timed-out call (a readiness transition is never throttled). */
export const OLLAMA_EMBEDDING_WARM_UP_MIN_INTERVAL_MS = 60_000;
/** The fixed warm-up text: never user content. */
const WARM_UP_TEXT = 'warm-up';
/** Embedding input bound (characters). Longer text is truncated before it reaches the CLI. */
export const MAX_EMBEDDING_INPUT_CHARS = 8_000;

export type EmbeddingRolePrefixes = Readonly<Record<EmbeddingRole, string>>;

/** `nomic-embed-text` expects task prefixes on its input; other models get none unless configured. */
const NOMIC_ROLE_PREFIXES: EmbeddingRolePrefixes = Object.freeze({
  query: 'search_query: ',
  document: 'search_document: ',
});
const NO_ROLE_PREFIXES: EmbeddingRolePrefixes = Object.freeze({ query: '', document: '' });

export interface OllamaCliEmbeddingProviderOptions {
  bin?: string;
  model?: string;
  providerId?: string;
  runner?: CliRunner;
  /** Default bound for one embedding call when the request carries none. */
  timeoutMs?: number;
  /** Model-specific input prefixes per role. Default: nomic prefixes for `nomic-embed-text`, none otherwise. */
  rolePrefixes?: EmbeddingRolePrefixes;
  /** `ollama run --keepalive` duration (`30m`, `90s`, `2h`, `-1` = until unloaded). Default {@link DEFAULT_OLLAMA_EMBEDDING_KEEP_ALIVE}. */
  keepAlive?: string;
  /** Load the model in the background when it becomes ready and after a timed-out call. Default true. */
  warmUp?: boolean;
  /** Bound for one background warm-up. Default {@link OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS}. */
  warmUpTimeoutMs?: number;
  /** Shared clock seam (warm-up spacing only). */
  clock?: () => IsoTimestamp;
}

/** The model goes into argv: refuse anything that could be read as a flag, and any cloud-served name. */
function validatedEmbeddingModel(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model) || /cloud/i.test(model)) {
    throw new TypeError('Invalid Ollama embedding model name');
  }
  return model;
}

/** The keep-alive goes into argv as a flag value: a bounded duration (`30m`, `90s`, `2h`, `500ms`) or `-1`. */
function validatedKeepAlive(value: string): string {
  if (!/^(?:-1|0|[1-9][0-9]{0,5}(?:ms|s|m|h))$/.test(value)) {
    throw new TypeError('Invalid Ollama embedding keep-alive duration');
  }
  return value;
}

function defaultRolePrefixes(model: string): EmbeddingRolePrefixes {
  const base = model.split(':')[0] ?? model;
  return base === DEFAULT_OLLAMA_EMBEDDING_MODEL ? NOMIC_ROLE_PREFIXES : NO_ROLE_PREFIXES;
}

/** Bound the input without splitting a UTF-16 surrogate pair. */
function boundedInput(text: string): string {
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  let end = MAX_EMBEDDING_INPUT_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Ollama CLI embedding provider (ADR-0098 D8). Advertises ONLY `EMBEDDING`; `OllamaCliProvider` no longer does.
 * Runs `ollama run <model>` with the text on stdin through the existing contained `CliRunner` in its DEFAULT
 * profile — exactly like production Ollama chat: a neutral cwd, only the chat colour variables, no
 * `OLLAMA_HOST`/`OLLAMA_NO_CLOUD` (the runner would refuse them), so the child talks to the CLI's default local
 * daemon. It never pulls: `OLLAMA_PULL_STDERR` aborts the run at the first download marker and the run fails
 * UNAVAILABLE (recall falls back to lexical; the owner pulls the model manually). Stdout must be one JSON array
 * of finite numbers; the vector is returned as the canonical Core envelope in `AiExecutionResult.text`.
 */
export class OllamaCliEmbeddingProvider extends BaseCliAiProvider {
  readonly id: string;
  /** ADR-0107 D6: a cloud-served model is refused at construction, so this is always `LOCAL` in practice. */
  readonly executionLocality: AiExecutionLocality;
  protected readonly bin: string;
  private readonly model: string;
  private readonly runner: CliRunner;
  private readonly defaultTimeoutMs: number;
  private readonly rolePrefixes: EmbeddingRolePrefixes;
  private readonly keepAlive: string;
  private readonly warmUpEnabled: boolean;
  private readonly warmUpTimeoutMs: number;
  private readonly clock: () => IsoTimestamp;
  /** The previous readiness answer; a warm-up follows the first ready answer and every not-ready -> ready change. */
  private lastProbeReady: boolean | undefined;
  private warmUpInFlight: Promise<void> | undefined;
  private lastWarmUpStartedAtMs: number | undefined;

  readonly capabilities: readonly AiCapabilityDescriptor[] = [
    { capability: Capability.EMBEDDING, priority: 100 },
  ];

  constructor(options: OllamaCliEmbeddingProviderOptions = {}) {
    super();
    this.id = options.providerId ?? 'ollama-embed-cli';
    this.bin = options.bin ?? 'ollama';
    this.model = validatedEmbeddingModel(options.model ?? DEFAULT_OLLAMA_EMBEDDING_MODEL);
    this.executionLocality = ollamaModelExecutionLocality(this.model);
    this.runner = options.runner ?? defaultCliRunner;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_OLLAMA_EMBEDDING_TIMEOUT_MS;
    this.rolePrefixes = options.rolePrefixes ?? defaultRolePrefixes(this.model);
    this.keepAlive = validatedKeepAlive(options.keepAlive ?? DEFAULT_OLLAMA_EMBEDDING_KEEP_ALIVE);
    this.warmUpEnabled = options.warmUp ?? true;
    this.warmUpTimeoutMs = options.warmUpTimeoutMs ?? OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS;
    this.clock = options.clock ?? now;
  }

  /** `ollama run --keepalive <duration> <model>`. The text is supplied via stdin, never as an argv. */
  buildArgs(): string[] {
    return ['run', '--keepalive', this.keepAlive, this.model];
  }

  /** Settles when the background warm-up in flight (if any) has finished; never rejects. */
  warmUpSettled(): Promise<void> {
    return this.warmUpInFlight ?? Promise.resolve();
  }

  /** Ready means the daemon answers AND the embedding model is installed (an unlisted model would be pulled). */
  override async isAvailable(): Promise<boolean> {
    try {
      const r = await this.runner(this.bin, ['list'], {
        cwd: tmpdir(),
        input: '',
        timeoutMs: OLLAMA_PROBE_TIMEOUT_MS,
        env: OLLAMA_COLOR_ENV,
      });
      const ready = r.code === 0 && !r.timedOut && ollamaListIncludesModel(r.stdout, this.model);
      this.noteReadiness(ready);
      return ready;
    } catch {
      this.noteReadiness(false);
      return false;
    }
  }

  /** Startup or a not-ready -> ready change: load the model now, outside any turn, so the next call finds it warm. */
  private noteReadiness(ready: boolean): void {
    const becameReady = ready && this.lastProbeReady !== true;
    this.lastProbeReady = ready;
    if (becameReady) this.startWarmUp(false);
  }

  /**
   * Fire-and-forget load of the model with the fixed warm-up text and a generous bound. A call cut off by the per-turn
   * budget cancels its own load in the daemon, so without this a model that cannot load within the budget (it queues
   * behind another model's load) would never become warm. Single-flight; after a timeout it is spaced by
   * {@link OLLAMA_EMBEDDING_WARM_UP_MIN_INTERVAL_MS}. Failures are ignored: the warm-up never answers a request.
   */
  private startWarmUp(throttled: boolean): void {
    if (!this.warmUpEnabled || this.warmUpInFlight !== undefined) return;
    const startedAtMs = this.nowMs();
    if (
      throttled &&
      this.lastWarmUpStartedAtMs !== undefined &&
      startedAtMs - this.lastWarmUpStartedAtMs < OLLAMA_EMBEDDING_WARM_UP_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.lastWarmUpStartedAtMs = startedAtMs;
    const run = (async () => {
      try {
        await this.runner(this.bin, this.buildArgs(), {
          cwd: tmpdir(),
          input: `${this.rolePrefixes.query}${WARM_UP_TEXT}`,
          timeoutMs: this.warmUpTimeoutMs,
          env: OLLAMA_COLOR_ENV,
          downloadMarkerPolicy: 'OLLAMA_PULL_STDERR',
        });
      } catch {
        // ignored: a failed warm-up only means the next call may load the model itself
      }
    })();
    this.warmUpInFlight = run.finally(() => {
      this.warmUpInFlight = undefined;
    });
  }

  private nowMs(): number {
    const value = Date.parse(this.clock());
    return Number.isNaN(value) ? 0 : value;
  }

  override async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (request.capability !== Capability.EMBEDDING) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'ollama embedding provider serves EMBEDDING only');
    }
    if (request.prompt.trim().length === 0) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'ollama embedding input is empty');
    }
    const role = readEmbeddingRole(request.metadata);
    const prefix = role === undefined ? '' : this.rolePrefixes[role];
    const input = boundedInput(`${prefix}${request.prompt}`);
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

    const result = await this.runner(this.bin, this.buildArgs(), {
      // A local model never needs the repo: always a neutral cwd.
      cwd: tmpdir(),
      input,
      timeoutMs,
      // Same default profile and caller allowlist as production chat (ADR-0098 D8): colour variables only.
      env: OLLAMA_COLOR_ENV,
      downloadMarkerPolicy: 'OLLAMA_PULL_STDERR',
    });

    if (result.downloadObserved === true) {
      throw new AiProviderError(
        AiFailureKind.UNAVAILABLE,
        'ollama embedding model is not installed locally; implicit model download was aborted',
      );
    }
    if (result.timedOut) {
      // The model was most likely still loading (cancelled with this call): load it in the background for later turns.
      this.startWarmUp(true);
      throw new AiProviderError(AiFailureKind.TIMEOUT, `ollama embedding timed out after ${timeoutMs}ms`);
    }
    if (result.code === null) {
      throw new AiProviderError(
        AiFailureKind.UNAVAILABLE,
        `ollama CLI could not run: ${maskSecrets(result.stderr).slice(0, 300)}`,
      );
    }
    if (result.code !== 0) {
      throw new AiProviderError(
        classifyOllamaExitStderr(result.stderr),
        `ollama CLI exited ${result.code}: ${maskSecrets(result.stderr).slice(0, 300)}`,
      );
    }

    const output = sanitizeTerminalOutput(result.stdout).trim();
    if (!output) {
      throw new AiProviderError(AiFailureKind.EMPTY_OUTPUT, 'ollama embedding returned empty output');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = undefined;
    }
    if (!isEmbeddingVector(parsed)) {
      // Never echo the output: it may be a model's text answer rather than a vector.
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'ollama embedding output is not a numeric vector');
    }

    const model = sanitizedOllamaModelName(this.model);
    return {
      text: formatEmbeddingEnvelope(parsed, model),
      raw: { exitCode: result.code, stderr: maskSecrets(result.stderr).slice(0, 1000) },
      audit: {
        model,
        sanitizedCommand: ['ollama', 'run', '--keepalive', this.keepAlive, model],
        captureMode: 'pipe',
        colorDisabled: true,
        dimensions: parsed.length,
      },
    };
  }
}
