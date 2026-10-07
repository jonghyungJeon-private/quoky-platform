import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { AiFailureKind, AiProviderError, ArtifactKind, newId, now } from '@quoky/core';
import type {
  AiCapabilityDescriptor,
  AiExecutionLocality,
  AiExecutionResult,
  AiImageInput,
  AiRequest,
  Artifact,
} from '@quoky/core';
import { BaseCliAiProvider, Capability } from './base-cli-provider';
import { defaultCliRunner } from './cli-runner';
import type { CliRunner } from './cli-runner';
import { sanitizeTerminalOutput } from './output-sanitizer';

/** The model goes into argv, so refuse anything that could be read as another flag. Shared by both Claude providers. */
export function validatedClaudeModel(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(model)) {
    throw new TypeError('Invalid Claude model name');
  }
  return model;
}

/**
 * Map Claude CLI failure text to an auth vs. generic execution failure. The CLI prints "Not logged in · Please run
 * /login" on STDOUT, so callers pass stderr together with the failure text they have. Shared by both Claude providers.
 */
export function classifyClaudeCliFailure(text: string): AiFailureKind {
  const s = text.toLowerCase();
  if (
    /(not logged in|please run.*login|authenticat|unauthor|invalid api key|\bapi key\b|oauth|credential|forbidden|\b401\b|\b403\b)/.test(
      s,
    )
  ) {
    return AiFailureKind.AUTH_REQUIRED;
  }
  return AiFailureKind.EXECUTION_FAILED;
}

/** Default `IMAGE_UNDERSTANDING` timeout for the hosted model (the verified real call took a few seconds). */
export const DEFAULT_CLAUDE_VISION_TIMEOUT_MS = 120_000;
/** Readiness probe bound (`claude auth status --json`). */
export const CLAUDE_VISION_PROBE_TIMEOUT_MS = 10_000;
/** Images per request (ADR-0111 D2 bounds a message to 3 attachments). */
export const MAX_CLAUDE_VISION_IMAGES = 3;
/** Image file bound (ADR-0111 D2: images ≤ 8 MiB), re-checked on the open file before it is read. */
export const MAX_CLAUDE_VISION_IMAGE_BYTES = 8 * 1024 * 1024;

/** The leading bytes each admitted image type must start with (the file content, not its name, decides). */
const IMAGE_SIGNATURE: Readonly<Record<AiImageInput['mimeType'], (head: Buffer) => boolean>> = {
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

const REFUSED = 'claude vision: image reference refused';

/**
 * Read one runner-owned temp image in place (ADR-0111 D1): an absolute path, opened without following a symlink, a
 * regular non-empty file of at most {@link MAX_CLAUDE_VISION_IMAGE_BYTES} checked on the OPEN descriptor (no
 * check-then-read race), whose content signature matches its declared type. The bytes live only in memory for this
 * request; the path and bytes never reach argv, a log, an error or the result.
 */
function readVisionImage(image: AiImageInput): Buffer {
  const signature = IMAGE_SIGNATURE[image.mimeType];
  if (signature === undefined || typeof image.path !== 'string' || !isAbsolute(image.path)) {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, REFUSED);
  }
  let fd: number;
  try {
    fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'claude vision: image reference is no longer available');
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_CLAUDE_VISION_IMAGE_BYTES) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, REFUSED);
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length || !signature(bytes)) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, REFUSED);
    }
    return bytes;
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, REFUSED);
  } finally {
    closeSync(fd);
  }
}

/**
 * The single stream-json stdin line for `claude -p --input-format stream-json` (shape verified against Claude Code
 * 2.1.292 with a real call): one `user` message whose content is the base64 image blocks in upload order followed by
 * the rendered prompt as a text block, terminated by a newline. Closing stdin ends the conversation after one turn.
 */
export function buildClaudeVisionStreamJsonInput(
  prompt: string,
  images: readonly { readonly mimeType: AiImageInput['mimeType']; readonly base64: string }[],
): string {
  const content = [
    ...images.map((image) => ({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data: image.base64 },
    })),
    { type: 'text', text: prompt },
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/** `result` event subtypes named in a failure reason; anything else is reported as `error`. */
const KNOWN_RESULT_SUBTYPES: readonly string[] = ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd'];

export type ClaudeStreamJsonOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly kind: AiFailureKind; readonly reason: string };

/**
 * Read the stream-json stdout (one JSON event per line) and return the final `result` event's outcome. Only the result
 * event's `result` text is used; every other event (init, assistant, rate-limit) is ignored and nothing is echoed.
 * `failureText` is the plain text available for classifying a failure (the result text or a non-JSON line such as
 * "Not logged in"), never logged.
 */
export function parseClaudeStreamJsonResult(stdout: string): ClaudeStreamJsonOutcome & { readonly failureText: string } {
  let result: Record<string, unknown> | undefined;
  const plain: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      plain.push(trimmed);
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'result') {
      result = parsed as Record<string, unknown>;
    }
  }
  const resultText = typeof result?.result === 'string' ? result.result : '';
  const failureText = [resultText, ...plain].join('\n');
  if (result === undefined) {
    return { ok: false, kind: classifyClaudeCliFailure(failureText), reason: 'no result event', failureText };
  }
  if (result.is_error === true || result.subtype !== 'success') {
    // Only bounded, known values reach the reason (it ends up in the persisted failure summary).
    const status =
      typeof result.api_error_status === 'number' && Number.isInteger(result.api_error_status) &&
      result.api_error_status >= 100 && result.api_error_status <= 599
        ? result.api_error_status
        : undefined;
    const kind = status === 401 || status === 403 ? AiFailureKind.AUTH_REQUIRED : classifyClaudeCliFailure(failureText);
    const subtype =
      typeof result.subtype === 'string' && KNOWN_RESULT_SUBTYPES.includes(result.subtype) ? result.subtype : 'error';
    return { ok: false, kind, reason: `result ${subtype}${status === undefined ? '' : ` status ${status}`}`, failureText };
  }
  return { ok: true, text: resultText, failureText };
}

export interface ClaudeCliVisionProviderOptions {
  /** Claude model alias or full name passed as `--model` (`QUOKY_IMAGE_UNDERSTANDING_MODEL` or `QUOKY_CLAUDE_MODEL`). */
  model: string;
  bin?: string;
  providerId?: string;
  runner?: CliRunner;
  timeoutMs?: number;
}

/**
 * Claude CLI vision provider (ADR-0111 amendment A1/A2, owner decision 2026-10-07): a separate provider instance that
 * advertises ONLY `IMAGE_UNDERSTANDING` and declares `REMOTE` (the hosted model reads the image). It is registered only
 * when the owner selects `QUOKY_IMAGE_UNDERSTANDING_PROVIDER=claude`, and Core sends it images only under the matching
 * composition-time policy.
 *
 * The image goes as a base64 image content block on stdin (`--input-format stream-json`), so no file-reading tool is
 * needed: every tool is disabled (`--tools ""`), and the run is isolated exactly like the chat `ClaudeCliProvider`
 * (`--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, neutral cwd, existing OAuth login, no
 * HTTP API). The image path and bytes never appear in argv, logs, errors, the result or the audit (counts and hashes).
 */
export class ClaudeCliVisionProvider extends BaseCliAiProvider {
  readonly id: string;
  /** ADR-0107 D6: the hosted model runs off this host. */
  readonly executionLocality: AiExecutionLocality = 'REMOTE';
  protected readonly bin: string;
  private readonly model: string;
  private readonly runner: CliRunner;
  private readonly defaultTimeoutMs: number;

  readonly capabilities: readonly AiCapabilityDescriptor[] = [
    { capability: Capability.IMAGE_UNDERSTANDING, priority: 100 },
  ];

  constructor(options: ClaudeCliVisionProviderOptions) {
    super();
    this.model = validatedClaudeModel(options.model);
    this.id = options.providerId ?? 'claude-vision-cli';
    this.bin = options.bin ?? 'claude';
    this.runner = options.runner ?? defaultCliRunner;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_VISION_TIMEOUT_MS;
  }

  /**
   * Fixed argv: print mode, the model, the chat provider's isolation flags, stream-json in and out (the CLI requires
   * `--verbose` for stream-json output in print mode), and `--tools ""` LAST (it is variadic). No path, no prompt.
   */
  buildArgs(): string[] {
    return [
      '-p', '--model', this.model, '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
    ];
  }

  /**
   * Real readiness: the CLI is installed AND logged in. `claude auth status --json` answers both in one bounded local
   * call (no model request); only its `loggedIn` boolean is read — the account fields are never kept or logged.
   */
  override async isAvailable(): Promise<boolean> {
    try {
      const r = await this.runner(this.bin, ['auth', 'status', '--json'], {
        cwd: tmpdir(),
        input: '',
        timeoutMs: CLAUDE_VISION_PROBE_TIMEOUT_MS,
      });
      if (r.code !== 0 || r.timedOut) return false;
      const status = JSON.parse(r.stdout) as { loggedIn?: unknown };
      return typeof status === 'object' && status !== null && status.loggedIn === true;
    } catch {
      return false;
    }
  }

  override async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (request.capability !== Capability.IMAGE_UNDERSTANDING) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'claude vision provider serves IMAGE_UNDERSTANDING only');
    }
    const images = request.images ?? [];
    if (images.length === 0 || images.length > MAX_CLAUDE_VISION_IMAGES) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'claude vision: 1 to 3 images are required');
    }
    if (new Set(images.map((image) => image.path)).size !== images.length) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, REFUSED);
    }
    const bytes = images.map(readVisionImage);
    const imageSha256 = bytes.map((b) => createHash('sha256').update(b).digest('hex'));
    const imageBytes = bytes.reduce((sum, b) => sum + b.length, 0);
    const input = buildClaudeVisionStreamJsonInput(
      request.prompt,
      images.map((image, index) => ({ mimeType: image.mimeType, base64: bytes[index]!.toString('base64') })),
    );
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const promptSha256 = createHash('sha256').update(Buffer.from(request.prompt, 'utf8')).digest('hex');
    const args = this.buildArgs();

    const result = await this.runner(this.bin, args, { cwd: tmpdir(), input, timeoutMs });

    // Every failure message is a FIXED reason plus bounded codes, never CLI text: stderr, stdout and a stream-json
    // error `result` may echo the stdin payload (the image base64) or the prompt, and the message is persisted by Core
    // as the TaskRun failure summary. CLI text is read only to classify the failure kind.
    if (result.timedOut) {
      throw new AiProviderError(AiFailureKind.TIMEOUT, `claude vision CLI timed out after ${timeoutMs}ms`);
    }
    if (result.code === null) {
      throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'claude vision CLI could not run (UNAVAILABLE)');
    }
    if (result.outputOverflowed === true) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'claude vision CLI output exceeded the capture bound');
    }
    const outcome = parseClaudeStreamJsonResult(result.stdout);
    if (result.code !== 0) {
      const kind = classifyClaudeCliFailure(`${result.stderr}\n${outcome.failureText}`);
      const exitCode = Number.isSafeInteger(result.code) ? result.code : 'unknown';
      throw new AiProviderError(kind, `claude vision CLI exited ${exitCode} (${kind})`);
    }
    if (!outcome.ok) {
      throw new AiProviderError(outcome.kind, `claude vision CLI failed: ${outcome.reason} (${outcome.kind})`);
    }
    const text = scrubPaths(sanitizeTerminalOutput(outcome.text), images).trim();
    if (!text) {
      throw new AiProviderError(AiFailureKind.EMPTY_OUTPUT, 'claude vision CLI returned empty output');
    }

    const artifact: Artifact = {
      id: newId(),
      kind: ArtifactKind.MARKDOWN_REPORT,
      title: 'claude-vision-response',
      content: text,
      createdAt: now(),
    };
    return {
      text,
      artifacts: [artifact],
      raw: { exitCode: result.code },
      audit: {
        model: this.model,
        executionLocality: this.executionLocality,
        sanitizedCommand: ['claude', ...args],
        inputFormat: 'stream-json',
        promptSha256,
        imageCount: images.length,
        imageBytes,
        imageSha256,
        outputSanitized: true,
      },
    };
  }
}

function scrubPaths(text: string, images: readonly AiImageInput[]): string {
  return images.reduce((acc, image) => (image.path ? acc.split(image.path).join('<image>') : acc), text);
}
