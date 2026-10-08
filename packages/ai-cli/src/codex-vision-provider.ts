import { createHash } from 'node:crypto';
import { closeSync, constants, mkdtempSync, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  acceptCodexRun,
  buildCodexExecArgs,
  isValidCodexModelName,
  probeCodexLogin,
  removeCodexCallDirectory,
} from './codex-cli-provider';
import type { CodexCwdCleanup, CodexEffortLevel } from './codex-cli-provider';
import { sanitizeTerminalOutput } from './output-sanitizer';
import { MAX_VISION_IMAGES, readVisionImageFile, scrubImagePaths } from './vision-image-file';

/** Default `IMAGE_UNDERSTANDING` timeout (the live check of 2026-10-08 answered in about 7 s). */
export const DEFAULT_CODEX_VISION_TIMEOUT_MS = 120_000;
/** Prefix of the empty per-call working directory that holds only the image copies (removed after the call). */
export const CODEX_VISION_CWD_PREFIX = 'quoky-codex-vision-';
/** Reasoning effort for an image reading (the chat tier's `low`; a description or transcription needs no more). */
export const CODEX_VISION_EFFORT: CodexEffortLevel = 'low';

/**
 * Adapter-owned framing placed before the rendered Core image prompt (the Codex CLI is an agent: it is told up front
 * that the attached images and this message are everything it gets). The rendered prompt that follows is unchanged.
 */
export const CODEX_VISION_PREAMBLE =
  'You are reading the attached image(s) for Quoky. Everything you need is in the attached image(s) and this message. ' +
  'Reply with the final answer text only. Do not run commands, read or write files, browse, or call any tool.\n\n';

const LABEL = 'codex vision CLI';
const REFUSED = 'codex vision: image reference refused';
const IMAGE_MESSAGES = { refused: REFUSED, unavailable: 'codex vision: image reference is no longer available' } as const;

/** File extension of the image copy (the content signature was already checked; the name only helps the CLI). */
const IMAGE_EXTENSION: Readonly<Record<AiImageInput['mimeType'], string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface CodexCliVisionProviderOptions {
  bin?: string;
  /** Model passed as `-m` (`QUOKY_CODEX_MODEL`). Unset means the CLI's own default model for the logged-in account. */
  model?: string;
  providerId?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  /** Where a failed temp-directory cleanup is reported (value-free code); and offline-test seams. */
  cleanup?: CodexCwdCleanup;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

/** Write `bytes` as a new private file (0600, `O_EXCL`, never through a symlink). */
function writePrivateCopy(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * Codex CLI vision provider (ADR-0111 amendment of 2026-10-08, owner request; the ADR-0092 amendment's `[LATER]` Codex
 * image option): a separate provider instance that advertises ONLY `IMAGE_UNDERSTANDING` and declares `REMOTE` (the
 * hosted OpenAI model reads the image). Core sends it images only while `codex` is the effective image selection
 * (the composition root's locality policy), exactly like the Claude vision provider.
 *
 * Each call runs `codex exec` with the chat provider's isolation (no user config, rules, project docs, skills, MCP, web
 * search, shell or other agent tools; read-only sandbox, approvals `never`, ephemeral, nothing in history) and the same
 * fail-closed event-stream check. The images are re-read from the intake's canonical temp files (no symlink, size and
 * signature checked on the open descriptor) and written as private copies into a fresh EMPTY temp cwd, which is the
 * only directory the CLI is pointed at; each copy is passed as its own `--image <path>`, and the prompt goes on stdin.
 * The cwd is removed after the call. Failure messages are fixed reasons with bounded codes (never CLI output); the
 * audit holds counts and hashes only (the argv in it has every image path replaced by `<image>`).
 */
export class CodexCliVisionProvider extends BaseCliAiProvider {
  readonly id: string;
  /** ADR-0107 D6: the hosted model runs off this host. */
  readonly executionLocality: AiExecutionLocality = 'REMOTE';
  protected readonly bin: string;
  private readonly model: string | undefined;
  private readonly runner: CliRunner;
  private readonly defaultTimeoutMs: number;
  private readonly cleanup: CodexCwdCleanup;

  readonly capabilities: readonly AiCapabilityDescriptor[] = [
    { capability: Capability.IMAGE_UNDERSTANDING, priority: 100 },
  ];

  constructor(options: CodexCliVisionProviderOptions = {}) {
    super();
    if (options.model !== undefined && !isValidCodexModelName(options.model)) {
      throw new TypeError('Invalid Codex model name');
    }
    this.model = options.model;
    this.id = options.providerId ?? 'codex-vision-cli';
    this.bin = options.bin ?? 'codex';
    this.runner = options.runner ?? defaultCliRunner;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CODEX_VISION_TIMEOUT_MS;
    this.cleanup = options.cleanup ?? {};
  }

  /** `codex exec --image <copy>… <isolation flags> -c model_reasoning_effort="low" [--disable …] [-m <model>] -`. */
  buildArgs(imagePaths: readonly string[] = []): string[] {
    return buildCodexExecArgs({
      effort: CODEX_VISION_EFFORT,
      ...(this.model !== undefined ? { model: this.model } : {}),
      imagePaths,
    });
  }

  /** Ready means the CLI runs and reports a login (`codex login status`). No model call is made. */
  override async isAvailable(): Promise<boolean> {
    return probeCodexLogin(this.runner, this.bin);
  }

  override async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (request.capability !== Capability.IMAGE_UNDERSTANDING) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'codex vision provider serves IMAGE_UNDERSTANDING only');
    }
    if (request.workspace !== undefined) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'codex vision provider never runs in a workspace');
    }
    const images = request.images ?? [];
    if (images.length === 0 || images.length > MAX_VISION_IMAGES) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'codex vision: 1 to 3 images are required');
    }
    if (new Set(images.map((image) => image.path)).size !== images.length) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, REFUSED);
    }
    const bytes = images.map((image) => readVisionImageFile(image, IMAGE_MESSAGES));
    const imageSha256 = bytes.map((b) => sha256(b));
    const imageBytes = bytes.reduce((sum, b) => sum + b.length, 0);
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const input = `${CODEX_VISION_PREAMBLE}${request.prompt}`;

    let cwd: string;
    try {
      cwd = mkdtempSync(join(realpathSync(tmpdir()), CODEX_VISION_CWD_PREFIX));
    } catch {
      throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'codex vision CLI could not prepare its working directory');
    }
    const copies: string[] = [];
    let args: string[];
    let result;
    try {
      try {
        images.forEach((image, index) => {
          const copy = join(cwd, `image-${index + 1}.${IMAGE_EXTENSION[image.mimeType]}`);
          // `--image` splits its value on commas; a temp path never has one, and one that did is refused, not split.
          if (copy.includes(',')) throw new Error('comma in temp path');
          writePrivateCopy(copy, bytes[index]!);
          copies.push(copy);
        });
      } catch {
        throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'codex vision CLI could not prepare its image copies');
      }
      args = this.buildArgs(copies);
      try {
        result = await this.runner(this.bin, args, { cwd, input, timeoutMs });
      } catch (err) {
        // A runner error may carry the argv (the copy paths): only a fixed reason leaves.
        if (err instanceof AiProviderError) throw err;
        throw new AiProviderError(AiFailureKind.UNAVAILABLE, `${LABEL} could not run`);
      }
    } finally {
      // Never throws (Codex review P2): a cleanup error carries the path and must not replace the outcome.
      removeCodexCallDirectory(cwd, 'codex-vision', this.cleanup);
    }

    if (result.outputOverflowed === true) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, `${LABEL} output exceeded the capture bound`);
    }
    // Fixed reasons with bounded codes only (the shared Codex taxonomy); stdout/stderr are read only to classify.
    const events = acceptCodexRun(result, timeoutMs, LABEL);
    const scrubbed = scrubImagePaths(
      sanitizeTerminalOutput(events.lastAgentMessage ?? ''),
      [...copies, cwd, ...images.map((image) => image.path)],
    );
    const text = scrubbed.trim();
    if (!text) {
      throw new AiProviderError(AiFailureKind.EMPTY_OUTPUT, `${LABEL} returned empty output`);
    }

    const artifact: Artifact = {
      id: newId(),
      kind: ArtifactKind.MARKDOWN_REPORT,
      title: 'codex-vision-response',
      content: text,
      createdAt: now(),
    };
    const pathSet = new Set(copies);
    return {
      text,
      artifacts: [artifact],
      raw: { exitCode: result.code },
      // Counts and hashes only: no prompt, reply, path, image byte or CLI text.
      audit: {
        model: this.model ?? 'cli-default',
        executionLocality: this.executionLocality,
        sanitizedCommand: ['codex', ...args.map((arg) => (pathSet.has(arg) ? '<image>' : arg))],
        promptSha256: sha256(request.prompt),
        providerInputSha256: sha256(input),
        replySha256: sha256(text),
        imageCount: images.length,
        imageBytes,
        imageSha256,
        jsonEventCount: events.jsonEventCount,
        agentMessageCount: events.agentMessageCount,
        actionItemCount: events.actionItemCount,
        warningItemCount: events.warningItemCount,
        planItemCount: events.planItemCount,
        turnCompletedCount: events.turnCompletedCount,
        ...events.usage,
        outputSanitized: true,
      },
    };
  }
}
