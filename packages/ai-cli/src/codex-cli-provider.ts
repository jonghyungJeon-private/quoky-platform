import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AiFailureKind,
  AiProviderError,
  ArtifactKind,
  newId,
  now,
  readGeneralChatReplyPolicy,
} from '@quoky/core';
import type {
  AiCapabilityDescriptor,
  AiExecutionLocality,
  AiExecutionResult,
  AiRequest,
  Artifact,
  Logger,
} from '@quoky/core';
import { BaseCliAiProvider, Capability } from './base-cli-provider';
import { defaultCliRunner } from './cli-runner';
import type { CliRunner, CliRunResult } from './cli-runner';
import {
  sanitizeGeneralChatText,
  sanitizeTerminalOutput,
  stripInternalMetadataEnvelope,
} from './output-sanitizer';

/**
 * The chat-tier capabilities the Codex CLI serves (ADR-0092 amendment, 2026-10-07). Code implementation, code review,
 * policy-sensitive chat, embeddings and images are deliberately absent: those stay on Claude (or their own providers).
 */
export const CODEX_CHAT_CAPABILITIES: readonly Capability[] = [
  Capability.GENERAL_CHAT,
  Capability.SUMMARIZATION,
  Capability.DOCUMENT_ANALYSIS,
  Capability.READONLY_LOOKUP,
];

/**
 * Advertised priority for every chat-tier capability. It is above Claude's (50-60), so when the composition root
 * registers Codex it wins those capabilities through the router's ordinary priority sort — no provider-id branching.
 * Claude stays the selection-time fallback when Codex is not ready.
 */
export const CODEX_CHAT_PRIORITY = 100;

export const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
/** `codex login status` is a local file read; bounded so a hung CLI never stalls routing. */
export const CODEX_PROBE_TIMEOUT_MS = 10_000;
/** Prefix of the empty per-call working directory (always under the OS temp directory, removed after the call). */
export const CODEX_CWD_PREFIX = 'quoky-codex-';

/** Codex `model_reasoning_effort` levels used by the adapter-owned capability table. */
export type CodexEffortLevel = 'low' | 'medium';

/** Adapter-owned capability -> reasoning effort (mirrors the Claude table of ADR-0092 for the same capabilities). */
export const DEFAULT_CODEX_EFFORT_BY_CAPABILITY: Readonly<Record<string, CodexEffortLevel>> = {
  [Capability.GENERAL_CHAT]: 'low',
  [Capability.SUMMARIZATION]: 'low',
  [Capability.READONLY_LOOKUP]: 'low',
  [Capability.DOCUMENT_ANALYSIS]: 'medium',
};

/**
 * `-c key=value` overrides on every run (values are TOML). Verified against `codex-cli 0.160.0`: each key is
 * schema-checked by the CLI (`codex debug prompt-input -c <key>=<bad value>` fails), so a typo cannot pass silently.
 * - `approval_policy="never"`: never ask; anything the sandbox refuses is refused, not escalated.
 * - `project_doc_max_bytes=0`: no `AGENTS.md` project instructions are read.
 * - `skills.include_instructions=false`: the skills catalogue is not put into the model context.
 * - `web_search="disabled"`: no web search tool.
 * - `mcp_servers={}`: no MCP servers, even if a profile or a future default added one.
 * - `history.persistence="none"`: nothing is appended to the owner's Codex history file.
 */
export const CODEX_CONFIG_OVERRIDES: readonly string[] = [
  'approval_policy="never"',
  'project_doc_max_bytes=0',
  'skills.include_instructions=false',
  'web_search="disabled"',
  'mcp_servers={}',
  'history.persistence="none"',
];

/**
 * Feature flags turned off on every run (`--disable <name>`, verified against `codex features list` in 0.160.0; an
 * unknown name makes the CLI exit, so a removed flag fails the run closed instead of being ignored). `shell_tool` and
 * `unified_exec` remove the shell tools; the rest remove connectors, plugins, browser/computer use, image generation,
 * hooks, sub-agents and other agent tools a chat reply never needs.
 */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apps',
  'plugins',
  'remote_plugin',
  'tool_suggest',
  'skill_search',
  'skill_mcp_dependency_install',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'view_image',
  'hooks',
  'multi_agent',
  'goals',
  'sleep_tool',
  'code_mode_host',
  'workspace_dependencies',
];

/**
 * Adapter-owned framing placed before the rendered Core prompt. The Codex CLI is an agent, so it is told up front that
 * this is a single chat reply with everything it needs supplied. The rendered prompt that follows is unchanged.
 */
export const CODEX_CHAT_PREAMBLE =
  'You are writing one chat reply for Quoky. Everything you need is in this message. Reply with the final answer ' +
  'text only. Do not run commands, read or write files, browse, or call any tool.\n\n';

/** JSONL item types that mean the agent acted (ran, edited, called or searched) instead of only answering. */
const CODEX_ACTION_ITEM_TYPES: ReadonlySet<string> = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'collab_tool_call',
]);

/**
 * The only event types a supported `codex exec --json` stream may contain (0.160.0). Anything else — including a type
 * a newer CLI adds — rejects the run: an unrecognised event could carry an action this adapter cannot see.
 */
const CODEX_ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'error',
  'item.started',
  'item.updated',
  'item.completed',
]);

/**
 * The only item types accepted inside `item.*` events: the reply, reasoning, the CLI's non-fatal `error` notice
 * (0.160.0 emits one per run because the disabled `code_mode_host` makes code mode fail closed) and `todo_list`.
 * `todo_list` is the built-in plan tool (`update_plan`): it only records a checklist in the session, has no side
 * effect, cannot be switched off in 0.160.0 (`--disable plan_tool` is an unknown flag), and a multi-step chat request
 * can plausibly trigger it, so it is accepted as inert and never shown. Action items are rejected separately; any
 * other item type (a new tool) is unknown and rejects the run.
 */
const CODEX_ALLOWED_ITEM_TYPES: ReadonlySet<string> = new Set(['agent_message', 'reasoning', 'error', 'todo_list']);

const CODEX_AUTH_FAILURE =
  /(not logged in|please (run|log ?in)|codex login|authenticat|unauthori[sz]ed|invalid api key|\b401\b|\b403\b|token (has )?expired|refresh token)/i;
const CODEX_LIMIT_FAILURE = /(usage limit|rate limit|quota|too many requests|\b429\b)/i;

/** The model goes into argv, so refuse anything that could be read as another flag (same shape as the Claude model). */
export function isValidCodexModelName(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(model);
}

export interface CodexCliProviderOptions {
  runner?: CliRunner;
  timeoutMs?: number;
  /** Model passed as `-m`. Unset means the CLI's own default model for the logged-in account. */
  model?: string;
  /** Where a failed temp-directory cleanup is reported (value-free code); and offline-test seams. */
  cleanup?: CodexCwdCleanup;
}

/** Why a stream is not a well-formed, supported, single-turn `codex exec --json` stream. Codes only, never text. */
export type CodexStreamViolation =
  | 'MALFORMED_LINE'
  | 'UNKNOWN_EVENT_TYPE'
  | 'UNKNOWN_ITEM_TYPE'
  | 'MALFORMED_ITEM'
  | 'TURN_NOT_COMPLETED_ONCE';

export interface ParsedCodexEvents {
  readonly lastAgentMessage: string | undefined;
  readonly agentMessageCount: number;
  readonly actionItemCount: number;
  /** Non-fatal `error` items (see {@link CODEX_ALLOWED_ITEM_TYPES}); counted for the audit, never reply text. */
  readonly warningItemCount: number;
  /** Inert `todo_list` (plan) items, counted once per item id for the audit; never reply text. */
  readonly planItemCount: number;
  readonly jsonEventCount: number;
  readonly turnStartedCount: number;
  readonly turnCompletedCount: number;
  readonly failureText: string | undefined;
  /** Every protocol violation found, in order of first occurrence (deduplicated). Empty only for a valid stream. */
  readonly violations: readonly CodexStreamViolation[];
  readonly usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Parse and validate `codex exec --json` stdout (one JSON event per line) **fail closed**: every non-empty line must be
 * a JSON object whose `type` is on {@link CODEX_ALLOWED_EVENT_TYPES}; every `item.*` event must carry an item whose
 * `type` is on {@link CODEX_ALLOWED_ITEM_TYPES} or is an action type (counted, and rejected by the caller); the stream
 * must contain exactly one `turn.started` and exactly one `turn.completed`. Missing or unreadable telemetry is a
 * violation, never evidence that no action happened. Only the last completed `agent_message` becomes reply text.
 */
export function parseCodexJsonEvents(stdout: string): ParsedCodexEvents {
  let lastAgentMessage: string | undefined;
  let agentMessageCount = 0;
  let warningItemCount = 0;
  const planItems = new Set<string>();
  let jsonEventCount = 0;
  let turnStartedCount = 0;
  let turnCompletedCount = 0;
  let failureText: string | undefined;
  const actionItems = new Set<string>();
  const violations = new Set<CodexStreamViolation>();
  const usage: ParsedCodexEvents['usage'] = {};

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      event = undefined;
    }
    if (event === undefined || typeof event.type !== 'string') {
      violations.add('MALFORMED_LINE');
      continue;
    }
    jsonEventCount += 1;
    const type = event.type;
    if (!CODEX_ALLOWED_EVENT_TYPES.has(type)) {
      violations.add('UNKNOWN_EVENT_TYPE');
      continue;
    }
    if (type.startsWith('item.')) {
      const item = asRecord(event.item);
      if (item === undefined || typeof item.type !== 'string') {
        violations.add('MALFORMED_ITEM');
        continue;
      }
      if (CODEX_ACTION_ITEM_TYPES.has(item.type)) {
        actionItems.add(typeof item.id === 'string' ? item.id : `#${jsonEventCount}`);
        continue;
      }
      if (!CODEX_ALLOWED_ITEM_TYPES.has(item.type)) {
        violations.add('UNKNOWN_ITEM_TYPE');
        continue;
      }
      if (type === 'item.completed' && item.type === 'agent_message') {
        if (typeof item.text !== 'string') {
          violations.add('MALFORMED_ITEM');
          continue;
        }
        lastAgentMessage = item.text;
        agentMessageCount += 1;
      } else if (type === 'item.completed' && item.type === 'error') {
        warningItemCount += 1;
      } else if (item.type === 'todo_list') {
        planItems.add(typeof item.id === 'string' ? item.id : `#${jsonEventCount}`);
      }
      continue;
    }
    if (type === 'turn.started') {
      turnStartedCount += 1;
    } else if (type === 'turn.completed') {
      turnCompletedCount += 1;
      const reported = asRecord(event.usage);
      if (reported !== undefined) {
        const inputTokens = countOf(reported.input_tokens);
        const cachedInputTokens = countOf(reported.cached_input_tokens);
        const outputTokens = countOf(reported.output_tokens);
        if (inputTokens !== undefined) usage.inputTokens = inputTokens;
        if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
        if (outputTokens !== undefined) usage.outputTokens = outputTokens;
      }
    } else if (type === 'turn.failed') {
      const error = asRecord(event.error);
      failureText = typeof error?.message === 'string' ? error.message : 'turn failed';
    } else if (type === 'error' && failureText === undefined) {
      failureText = typeof event.message === 'string' ? event.message : 'error';
    }
  }
  if (turnStartedCount !== 1 || turnCompletedCount !== 1) violations.add('TURN_NOT_COMPLETED_ONCE');

  return {
    lastAgentMessage,
    agentMessageCount,
    actionItemCount: actionItems.size,
    warningItemCount,
    planItemCount: planItems.size,
    jsonEventCount,
    turnStartedCount,
    turnCompletedCount,
    failureText,
    violations: [...violations],
    usage,
  };
}

/**
 * Failure kind for a Codex run that did not answer. Login and usage-limit failures are `UNAVAILABLE`: the router drops
 * the cached readiness after an `UNAVAILABLE` execution, and the provider-neutral reply does not name a CLI. Anything
 * else is `EXECUTION_FAILED`. Only the classification leaves this function; the raw text is never echoed.
 */
export function classifyCodexFailure(text: string): AiFailureKind {
  const normalized = sanitizeTerminalOutput(text);
  if (CODEX_AUTH_FAILURE.test(normalized) || CODEX_LIMIT_FAILURE.test(normalized)) return AiFailureKind.UNAVAILABLE;
  return AiFailureKind.EXECUTION_FAILED;
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Delay before the single retry of a failed per-call directory removal. */
export const CODEX_CWD_CLEANUP_RETRY_MS = 5_000;

/** Value-free warning codes of the per-call directory cleanup (logged with a bounded errno class, never a path). */
export type CodexCwdCleanupCode = 'CODEX_CWD_CLEANUP_FAILED' | 'CODEX_CWD_CLEANUP_RETRY_FAILED';

/** Offline-test seams for {@link removeCodexCallDirectory}; production passes none. */
export interface CodexCwdCleanup {
  readonly logger?: Pick<Logger, 'warn'>;
  readonly remove?: (path: string) => void;
  readonly scheduleRetry?: (retry: () => void, delayMs: number) => void;
}

function errnoClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,15}$/u.test(code) ? code : 'unknown';
}

const defaultRemove = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 2 });
const defaultScheduleRetry = (retry: () => void, delayMs: number): void => {
  setTimeout(retry, delayMs).unref();
};

/**
 * Remove a Codex call's own temp working directory (Codex review P2 on 76e0028). It NEVER throws: a removal error (it
 * carries the path) must not escape the fixed-error boundary into a TaskRun summary, and an answered call stays
 * answered. A failure logs the value-free `CODEX_CWD_CLEANUP_FAILED` (provider label and errno class only) and schedules
 * ONE retry after {@link CODEX_CWD_CLEANUP_RETRY_MS} (an unref'd timer, so it never keeps the process alive); a failed
 * retry logs `CODEX_CWD_CLEANUP_RETRY_FAILED` and leaves the directory to the OS temp cleanup. The directory is the
 * call's own `mkdtemp` (0700) under the OS temp directory — not the attachment intake's private root, so the intake
 * sweep does not cover it.
 */
export function removeCodexCallDirectory(path: string, provider: 'codex-chat' | 'codex-vision', cleanup: CodexCwdCleanup = {}): void {
  const remove = cleanup.remove ?? defaultRemove;
  const warn = (code: CodexCwdCleanupCode, err: unknown): void => {
    try {
      cleanup.logger?.warn('codex temp directory cleanup failed', { code, provider, errno: errnoClass(err) });
    } catch {
      // A failing logger never turns cleanup into an error.
    }
  };
  try {
    remove(path);
  } catch (err) {
    warn('CODEX_CWD_CLEANUP_FAILED', err);
    try {
      (cleanup.scheduleRetry ?? defaultScheduleRetry)(() => {
        try {
          remove(path);
        } catch (retryErr) {
          warn('CODEX_CWD_CLEANUP_RETRY_FAILED', retryErr);
        }
      }, CODEX_CWD_CLEANUP_RETRY_MS);
    } catch {
      // Scheduling failed: the OS temp cleanup is the last resort; nothing escapes.
    }
  }
}

/**
 * The `codex exec` argv shared by the chat and the vision provider (ADR-0092 amendment D5). The prompt is never an argv
 * element: the final `-` makes the CLI read it from stdin. Every element is a fixed literal, the validated model name,
 * or (vision only) the path of an image copy inside the call's own empty temp directory, each after its own `--image`
 * and before the next flag (`--image` takes several values, so it never sits next to the trailing `-`).
 */
export function buildCodexExecArgs(options: {
  readonly effort?: CodexEffortLevel;
  readonly model?: string;
  readonly imagePaths?: readonly string[];
} = {}): string[] {
  const args = ['exec'];
  for (const path of options.imagePaths ?? []) args.push('--image', path);
  args.push(
    '--json',
    '--color', 'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
  );
  for (const override of CODEX_CONFIG_OVERRIDES) args.push('-c', override);
  if (options.effort !== undefined) args.push('-c', `model_reasoning_effort="${options.effort}"`);
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature);
  if (options.model !== undefined) args.push('-m', options.model);
  args.push('-');
  return args;
}

/** Ready means the CLI runs and reports a login (`codex login status`). No model call is made. */
export async function probeCodexLogin(runner: CliRunner, bin: string): Promise<boolean> {
  try {
    const result = await runner(bin, ['login', 'status'], {
      cwd: tmpdir(),
      input: '',
      timeoutMs: CODEX_PROBE_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.timedOut) return false;
    // The CLI prints the status on stderr ("Logged in using ChatGPT"); accept either stream.
    const status = sanitizeTerminalOutput(`${result.stdout}\n${result.stderr}`);
    return /^\s*logged in\b/im.test(status) && !/not logged in/i.test(status);
  } catch {
    return false;
  }
}

/**
 * The classified outcome of one `codex exec --json` run, shared by the chat and the vision provider (ADR-0015 failure
 * taxonomy). Every thrown message is a fixed text with `label`, the timeout, the exit code or violation codes — never
 * CLI output, which could quote the prompt. Returns the parsed events of an accepted run.
 */
export function acceptCodexRun(result: CliRunResult, timeoutMs: number, label: string): ParsedCodexEvents {
  if (result.timedOut) {
    throw new AiProviderError(AiFailureKind.TIMEOUT, `${label} timed out after ${timeoutMs}ms`);
  }
  if (result.code === null) {
    throw new AiProviderError(AiFailureKind.UNAVAILABLE, `${label} could not run`);
  }
  const events = parseCodexJsonEvents(result.stdout);
  if (events.actionItemCount > 0) {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, `${label} attempted a tool action; the reply was withheld`);
  }
  if (result.code !== 0 || events.failureText !== undefined) {
    const kind = classifyCodexFailure(`${events.failureText ?? ''}\n${result.stderr}`);
    const exitCode = Number.isSafeInteger(result.code) ? result.code : 'unknown';
    throw new AiProviderError(
      kind,
      kind === AiFailureKind.UNAVAILABLE ? `${label} is not usable right now (exit ${exitCode})` : `${label} failed (exit ${exitCode})`,
    );
  }
  // Fail closed on anything but a well-formed, supported, single completed turn: telemetry that cannot be read is
  // never taken as "no action happened". Only the violation codes leave; no stream text is echoed.
  if (events.violations.length > 0) {
    throw new AiProviderError(
      AiFailureKind.EXECUTION_FAILED,
      `${label} event stream refused (${events.violations.join(',')}); the reply was withheld`,
    );
  }
  return events;
}

/**
 * Codex CLI chat provider (ADR-0092 amendment, 2026-10-07). Registered only when `QUOKY_CHAT_PROVIDER=codex`, and then
 * it serves only the chat-tier capabilities ({@link CODEX_CHAT_CAPABILITIES}); code, review and policy-sensitive work
 * stays on Claude. Runs `codex exec` non-interactively with the prompt on **stdin**, in a fresh **empty** temp cwd that
 * is removed afterwards, under the `read-only` sandbox with approvals `never`, without the owner's Codex config,
 * rules, project docs, skills, MCP servers, web search, shell tools or other agent features, and with nothing written
 * to session or history files. Only the final assistant message of the `--json` event stream becomes the reply; the
 * stream must be a well-formed, allow-listed, single completed turn, and a run that executed, edited, called or
 * searched anything is refused as a whole.
 *
 * Residual (ADR note): the CLI is an agent and offers no "no tools at all" switch. With the shell and other tools
 * disabled, the remaining containment is the read-only sandbox in an empty directory, the fail-closed check above,
 * and the egress decision itself — every chat prompt goes to OpenAI, accepted by the owner like Claude's.
 */
export class CodexCliProvider extends BaseCliAiProvider {
  readonly id = 'codex-cli';
  /** ADR-0107 D6: the Codex CLI sends the request to a hosted model. */
  readonly executionLocality: AiExecutionLocality = 'REMOTE';
  protected readonly bin: string;
  private readonly runner: CliRunner;
  private readonly defaultTimeoutMs: number;
  private readonly model: string | undefined;
  private readonly cleanup: CodexCwdCleanup;

  readonly capabilities: readonly AiCapabilityDescriptor[] = CODEX_CHAT_CAPABILITIES.map((capability) => ({
    capability,
    priority: CODEX_CHAT_PRIORITY,
  }));

  constructor(bin = 'codex', options: CodexCliProviderOptions = {}) {
    super();
    this.bin = bin;
    this.runner = options.runner ?? defaultCliRunner;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    if (options.model !== undefined && !isValidCodexModelName(options.model)) {
      throw new TypeError('Invalid Codex model name');
    }
    this.model = options.model;
    this.cleanup = options.cleanup ?? {};
  }

  /**
   * `codex exec` argv. The prompt is never an argv element: the final `-` makes the CLI read it from stdin. Every
   * element is a fixed literal or the validated model name.
   */
  buildArgs(request?: Pick<AiRequest, 'capability'>): string[] {
    const effort = request === undefined ? undefined : DEFAULT_CODEX_EFFORT_BY_CAPABILITY[request.capability];
    return buildCodexExecArgs({
      ...(effort !== undefined ? { effort } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
    });
  }

  /** Ready means the CLI runs and reports a login (`codex login status`). No model call is made. */
  override async isAvailable(): Promise<boolean> {
    return probeCodexLogin(this.runner, this.bin);
  }

  override async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (!CODEX_CHAT_CAPABILITIES.includes(request.capability)) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'codex provider serves chat-tier capabilities only');
    }
    if ((request.images?.length ?? 0) > 0) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'codex CLI provider does not accept images');
    }
    if (request.workspace !== undefined) {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'codex CLI provider never runs in a workspace');
    }
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const args = this.buildArgs(request);
    const input = `${CODEX_CHAT_PREAMBLE}${request.prompt}`;

    let cwd: string;
    try {
      cwd = mkdtempSync(join(realpathSync(tmpdir()), CODEX_CWD_PREFIX));
    } catch {
      throw new AiProviderError(AiFailureKind.UNAVAILABLE, 'codex CLI could not prepare its working directory');
    }
    let result;
    try {
      result = await this.runner(this.bin, args, { cwd, input, timeoutMs });
    } finally {
      removeCodexCallDirectory(cwd, 'codex-chat', this.cleanup);
    }

    // Classified failure taxonomy (ADR-0015). Raw CLI text is never echoed: it could quote the prompt.
    const events = acceptCodexRun(result, timeoutMs, 'codex CLI');

    const message = sanitizeTerminalOutput(events.lastAgentMessage ?? '');
    const text = (request.capability === Capability.GENERAL_CHAT
      ? sanitizeGeneralChatText(stripInternalMetadataEnvelope(message), readGeneralChatReplyPolicy(request.metadata))
      : message
    ).trim();
    if (!text) {
      throw new AiProviderError(AiFailureKind.EMPTY_OUTPUT, 'codex CLI returned empty output');
    }

    const artifact: Artifact = {
      id: newId(),
      kind: ArtifactKind.MARKDOWN_REPORT,
      title: 'codex-response',
      content: text,
      createdAt: now(),
    };
    return {
      text,
      artifacts: [artifact],
      raw: { exitCode: result.code },
      // Counts and hashes only: no prompt, reply, path or CLI text.
      audit: {
        model: this.model ?? 'cli-default',
        sanitizedCommand: ['codex', ...args],
        promptSha256: sha256(request.prompt),
        providerInputSha256: sha256(input),
        replySha256: sha256(text),
        jsonEventCount: events.jsonEventCount,
        agentMessageCount: events.agentMessageCount,
        actionItemCount: events.actionItemCount,
        warningItemCount: events.warningItemCount,
        planItemCount: events.planItemCount,
        turnCompletedCount: events.turnCompletedCount,
        ...events.usage,
        captureMode: 'pipe',
        colorDisabled: true,
        outputSanitized: true,
      },
    };
  }
}
