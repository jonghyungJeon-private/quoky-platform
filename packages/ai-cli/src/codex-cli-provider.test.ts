import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  AiFailureKind,
  AiProviderManager,
  Capability,
  CapabilityRouter,
  detectExternalActionRequest,
  executionLocalityOf,
  generalChatReplyPolicyMetadata,
  ProviderProbeIndeterminateError,
} from '@quoky/core';
import type { AiProvider } from '@quoky/core';
import {
  CODEX_CHAT_CAPABILITIES,
  CODEX_CHAT_PREAMBLE,
  CODEX_CONFIG_OVERRIDES,
  CODEX_CWD_CLEANUP_RETRY_MS,
  CODEX_CWD_PREFIX,
  CODEX_DISABLED_FEATURES,
  CODEX_PROBE_TIMEOUT_MS,
  CodexCliProvider,
  classifyCodexFailure,
  parseCodexJsonEvents,
  removeCodexCallDirectory,
} from './codex-cli-provider';
import { ClaudeCliProvider } from './index';
import { createContainedCliRunner } from './cli-runner';
import type { CliRunOptions, CliRunResult, CliRunner } from './cli-runner';
import { UNSUPPORTED_ACTION_NOTICE_KO } from './output-sanitizer';

const PROMPT = '# System\nBe helpful.\n\n# Task\n--- Current user message ---\n{"content":"비 오는 날 듣기 좋은 노래 3곡 추천해줘"}';

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

/** The event stream `codex exec --json` printed for one answered turn in the live check (0.160.0 shape). */
function answered(text: string): string {
  return jsonl(
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'thinking about songs' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80 } },
  );
}

interface RecordedCall {
  bin: string;
  args: string[];
  opts: CliRunOptions;
  cwdExistedAndEmpty: boolean;
}

function recordingRunner(result: CliRunResult, calls: RecordedCall[]): CliRunner {
  return async (bin, args, opts) => {
    const cwdExistedAndEmpty = existsSync(opts.cwd) && readdirSync(opts.cwd).length === 0;
    calls.push({ bin, args, opts, cwdExistedAndEmpty });
    return result;
  };
}

const ok = (stdout: string): CliRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });

describe('CodexCliProvider — capabilities and locality', () => {
  it('advertises exactly the chat-tier capabilities, above Claude, and declares REMOTE', () => {
    const codex = new CodexCliProvider();
    expect(codex.capabilities.map((c) => c.capability)).toEqual([
      Capability.GENERAL_CHAT,
      Capability.SUMMARIZATION,
      Capability.DOCUMENT_ANALYSIS,
      Capability.READONLY_LOOKUP,
    ]);
    const claude = new ClaudeCliProvider();
    for (const descriptor of codex.capabilities) {
      const claudePriority = claude.capabilities.find((c) => c.capability === descriptor.capability)?.priority ?? 0;
      expect(descriptor.priority).toBeGreaterThan(claudePriority);
    }
    expect(codex.executionLocality).toBe('REMOTE');
    expect(executionLocalityOf(codex)).toBe('REMOTE');
  });

  it('never advertises code, review, policy-sensitive, embedding, image or test capabilities', () => {
    const advertised = new CodexCliProvider().capabilities.map((c) => c.capability);
    for (const capability of [
      Capability.CODE_IMPLEMENTATION,
      Capability.CODE_REVIEW,
      Capability.POLICY_SENSITIVE_CHAT,
      Capability.EMBEDDING,
      Capability.IMAGE_UNDERSTANDING,
      Capability.TEST_EXECUTION,
      Capability.ARCHITECTURE_PLANNING,
      Capability.PROJECT_ANALYSIS,
    ]) {
      expect(advertised).not.toContain(capability);
    }
  });

  it('refuses a model name that could be read as a flag', () => {
    for (const model of ['--dangerously-bypass-approvals-and-sandbox', '-s', 'two words', 'a;b', '', 'x'.repeat(129)]) {
      expect(() => new CodexCliProvider('codex', { model }), model).toThrow(TypeError);
    }
    expect(() => new CodexCliProvider('codex', { model: 'gpt-5.1-codex' })).not.toThrow();
  });
});

describe('CodexCliProvider — argv and isolation', () => {
  it('runs `codex exec` with the prompt on stdin only, in a fresh empty temp cwd that is removed afterwards', async () => {
    const calls: RecordedCall[] = [];
    const codex = new CodexCliProvider('codex', { runner: recordingRunner(ok(answered('추천 노래입니다.')), calls) });
    const result = await codex.execute({ capability: Capability.GENERAL_CHAT, prompt: PROMPT });

    expect(result.text).toBe('추천 노래입니다.');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.bin).toBe('codex');
    expect(call.args[0]).toBe('exec');
    expect(call.args.at(-1)).toBe('-');
    // The prompt (and any part of it) is never an argv element.
    for (const arg of call.args) {
      expect(arg).not.toContain('비 오는 날');
      expect(arg).not.toContain('Current user message');
    }
    expect(call.opts.input).toBe(`${CODEX_CHAT_PREAMBLE}${PROMPT}`);
    expect(call.opts.input.endsWith(PROMPT)).toBe(true);
    // Fresh, empty, OS-temp cwd, gone after the call.
    expect(call.cwdExistedAndEmpty).toBe(true);
    expect(call.opts.cwd).toContain(CODEX_CWD_PREFIX);
    expect(call.opts.cwd).not.toBe(tmpdir());
    expect(existsSync(call.opts.cwd)).toBe(false);
    // No caller environment: the runner's allow-listed environment only.
    expect(call.opts.env).toBeUndefined();
    expect(call.opts.timeoutMs).toBe(120_000);
  });

  it('passes every isolation flag and override, and no shell, apply, bypass or writable flag', () => {
    const args = new CodexCliProvider().buildArgs({ capability: Capability.GENERAL_CHAT });
    for (const flag of ['--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('--color') + 1]).toBe('never');
    const overrides = args.flatMap((arg, index) => (arg === '-c' ? [args[index + 1]] : []));
    expect(overrides).toEqual(expect.arrayContaining([...CODEX_CONFIG_OVERRIDES]));
    expect(overrides).toContain('approval_policy="never"');
    expect(overrides).toContain('mcp_servers={}');
    expect(overrides).toContain('project_doc_max_bytes=0');
    const disabled = args.flatMap((arg, index) => (arg === '--disable' ? [args[index + 1]] : []));
    expect(disabled).toEqual([...CODEX_DISABLED_FEATURES]);
    expect(disabled).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks']));

    const joined = args.join(' ');
    for (const forbidden of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '--approve-for-me',
      'workspace-write',
      'danger-full-access',
      '--add-dir',
      '--worktree',
      '--full-auto',
      '--enable',
      '--image',
      '--oss',
      '--profile',
      'apply',
      'resume',
      'review',
    ]) {
      expect(joined, forbidden).not.toContain(forbidden);
    }
    expect(args).not.toContain('-i');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('-C');
  });

  it('adds the adapter-owned reasoning effort per capability and the configured model', () => {
    const codex = new CodexCliProvider('codex', { model: 'gpt-5.1-codex' });
    const chat = codex.buildArgs({ capability: Capability.GENERAL_CHAT });
    expect(chat).toContain('model_reasoning_effort="low"');
    expect(chat.slice(chat.indexOf('-m'), chat.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5.1-codex']);
    expect(codex.buildArgs({ capability: Capability.DOCUMENT_ANALYSIS })).toContain('model_reasoning_effort="medium"');
    // Unset model: the CLI default, no -m flag.
    expect(new CodexCliProvider().buildArgs({ capability: Capability.GENERAL_CHAT })).not.toContain('-m');
  });

  it('refuses images, workspaces and non-chat capabilities before spawning', async () => {
    const calls: RecordedCall[] = [];
    const codex = new CodexCliProvider('codex', { runner: recordingRunner(ok(answered('x')), calls) });
    await expect(codex.execute({
      capability: Capability.GENERAL_CHAT, prompt: PROMPT, images: [{ path: '/tmp/a.png', mimeType: 'image/png' }],
    })).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    await expect(codex.execute({
      capability: Capability.GENERAL_CHAT, prompt: PROMPT, workspace: { rootPath: '/tmp/repo' } as never,
    })).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    for (const capability of [Capability.CODE_IMPLEMENTATION, Capability.CODE_REVIEW, Capability.POLICY_SENSITIVE_CHAT]) {
      await expect(codex.execute({ capability, prompt: PROMPT })).rejects.toMatchObject({
        kind: AiFailureKind.EXECUTION_FAILED,
      });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('CodexCliProvider — output parsing', () => {
  it('returns only the final agent message; reasoning and earlier messages are never shown', async () => {
    const stdout = jsonl(
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'SECRET REASONING' } },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'draft answer' } },
      { type: 'item.completed', item: { id: 'a2', type: 'agent_message', text: '\u001b[1m최종 답변\u001b[0m' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
    );
    const result = await new CodexCliProvider('codex', { runner: async () => ok(stdout) }).execute({
      capability: Capability.SUMMARIZATION,
      prompt: PROMPT,
    });
    expect(result.text).toBe('최종 답변');
    expect(result.text).not.toContain('REASONING');
    expect(result.artifacts?.[0]?.content).toBe('최종 답변');
  });

  it('records an audit of counts and hashes only', async () => {
    const reply = '비 오는 날엔 이 노래들을 추천해요.';
    const result = await new CodexCliProvider('codex', { runner: async () => ok(answered(reply)) }).execute({
      capability: Capability.GENERAL_CHAT,
      prompt: PROMPT,
    });
    const audit = result.audit as Record<string, unknown>;
    const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(audit).toMatchObject({
      model: 'cli-default',
      promptSha256: sha(PROMPT),
      providerInputSha256: sha(`${CODEX_CHAT_PREAMBLE}${PROMPT}`),
      replySha256: sha(reply),
      jsonEventCount: 6,
      agentMessageCount: 1,
      actionItemCount: 0,
      warningItemCount: 1,
      planItemCount: 0,
      turnCompletedCount: 1,
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 80,
      outputSanitized: true,
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('비 오는 날');
    expect(serialized).not.toContain(reply);
    expect(serialized).not.toContain(CODEX_CWD_PREFIX);
    expect(audit.sanitizedCommand).toEqual(['codex', ...new CodexCliProvider().buildArgs({ capability: Capability.GENERAL_CHAT })]);
    expect(result.raw).toEqual({ exitCode: 0 });
  });

  it('applies the provider-neutral chat hygiene to GENERAL_CHAT replies (action-claim guard)', async () => {
    const userText = '내일 3시 회의 캘린더에 추가해줘';
    const result = await new CodexCliProvider('codex', {
      runner: async () => ok(answered('네! 구글 캘린더에 내일 오후 3시 회의를 추가해 드릴게요.')),
    }).execute({
      capability: Capability.GENERAL_CHAT,
      prompt: PROMPT,
      metadata: generalChatReplyPolicyMetadata(userText, detectExternalActionRequest(userText)),
    });
    expect(result.text).toBe(UNSUPPORTED_ACTION_NOTICE_KO);
  });

  it('withholds the whole reply when the agent executed, edited, called or searched anything', async () => {
    for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search']) {
      const stdout = jsonl(
        { type: 'item.started', item: { id: 'x', type, status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: {} },
      );
      await expect(
        new CodexCliProvider('codex', { runner: async () => ok(stdout) }).execute({
          capability: Capability.GENERAL_CHAT,
          prompt: PROMPT,
        }),
        type,
      ).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    }
  });

  it('accepts the observed 0.160.0 stream shape, including item.started/updated lifecycle events', () => {
    const parsed = parseCodexJsonEvents(jsonl(
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'w', type: 'error', message: 'notice' } },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'r', type: 'reasoning', text: '' } },
      { type: 'item.updated', item: { id: 'r', type: 'reasoning', text: 'x' } },
      { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'x' } },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'hi' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ));
    expect(parsed).toMatchObject({
      lastAgentMessage: 'hi', agentMessageCount: 1, actionItemCount: 0, warningItemCount: 1,
      turnStartedCount: 1, turnCompletedCount: 1, violations: [],
    });
  });

  describe('fails closed on anything but a well-formed, supported, single completed turn (Codex P2)', () => {
    const reply = { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'looks fine' } };
    const exec0 = (stdout: string) =>
      new CodexCliProvider('codex', { runner: async () => ok(stdout) }).execute({
        capability: Capability.GENERAL_CHAT,
        prompt: PROMPT,
      });
    const START = { type: 'turn.started' };
    const DONE = { type: 'turn.completed', usage: {} };

    it.each<[string, string, string]>([
      [
        'a malformed (truncated) action line next to a valid reply',
        `${jsonl(START)}{"type":"item.started","item":{"id":"c","type":"command_exec\n${jsonl(reply, DONE)}`,
        'MALFORMED_LINE',
      ],
      ['a non-JSON line', `warning: something\n${jsonl(START, reply, DONE)}`, 'MALFORMED_LINE'],
      ['a JSON value that is not an event object', `${jsonl(START, reply, DONE)}[]\n`, 'MALFORMED_LINE'],
      ['an event with no type', jsonl(START, { item: {} }, reply, DONE), 'MALFORMED_LINE'],
      ['an unknown tool item', jsonl(START, { type: 'item.completed', item: { id: 't', type: 'patch_apply' } }, reply, DONE), 'UNKNOWN_ITEM_TYPE'],
      ['an unknown event type', jsonl(START, { type: 'exec.approval_request', command: 'rm -rf /' }, reply, DONE), 'UNKNOWN_EVENT_TYPE'],
      ['an item event without an item', jsonl(START, { type: 'item.completed' }, reply, DONE), 'MALFORMED_ITEM'],
      ['an agent message without text', jsonl(START, { type: 'item.completed', item: { id: 'a', type: 'agent_message' } }, DONE), 'MALFORMED_ITEM'],
      ['no turn.completed', jsonl(START, reply), 'TURN_NOT_COMPLETED_ONCE'],
      ['no turn.started', jsonl(reply, DONE), 'TURN_NOT_COMPLETED_ONCE'],
      ['two completed turns', jsonl(START, reply, DONE, START, reply, DONE), 'TURN_NOT_COMPLETED_ONCE'],
      ['an empty stream', '', 'TURN_NOT_COMPLETED_ONCE'],
    ])('rejects %s', async (_label, stdout, violation) => {
      expect(parseCodexJsonEvents(stdout).violations).toContain(violation);
      const err = await exec0(stdout).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
      expect(String((err as Error).message)).toContain(violation);
      expect(String((err as Error).message)).not.toContain('looks fine');
    });

    it('accepts a todo_list (built-in plan tool) as an inert item: counted, never shown', async () => {
      const stdout = jsonl(
        START,
        { type: 'item.started', item: { id: 'p', type: 'todo_list', items: [{ text: 'read the file', completed: false }] } },
        { type: 'item.updated', item: { id: 'p', type: 'todo_list', items: [{ text: 'read the file', completed: true }] } },
        { type: 'item.completed', item: { id: 'p', type: 'todo_list', items: [{ text: 'read the file', completed: true }] } },
        reply,
        DONE,
      );
      expect(parseCodexJsonEvents(stdout)).toMatchObject({ violations: [], planItemCount: 1, actionItemCount: 0 });
      const result = await exec0(stdout);
      expect(result.text).toBe('looks fine');
      expect(result.text).not.toContain('read the file');
      expect(result.audit).toMatchObject({ planItemCount: 1 });
    });

    it('rejects every action-like item, even with a valid reply and a completed turn', async () => {
      for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call']) {
        for (const phase of ['item.started', 'item.updated', 'item.completed']) {
          const stdout = jsonl(START, { type: phase, item: { id: 'x', type } }, reply, DONE);
          expect(parseCodexJsonEvents(stdout).actionItemCount, `${phase} ${type}`).toBe(1);
          await expect(exec0(stdout), `${phase} ${type}`).rejects.toMatchObject({
            kind: AiFailureKind.EXECUTION_FAILED,
            message: expect.stringContaining('tool action'),
          });
        }
      }
    });
  });

  it('no agent message or only whitespace → EMPTY_OUTPUT', async () => {
    for (const stdout of [jsonl({ type: 'turn.started' }, { type: 'turn.completed', usage: {} }), answered('   \n  ')]) {
      await expect(
        new CodexCliProvider('codex', { runner: async () => ok(stdout) }).execute({
          capability: Capability.GENERAL_CHAT,
          prompt: PROMPT,
        }),
      ).rejects.toMatchObject({ kind: AiFailureKind.EMPTY_OUTPUT });
    }
  });
});

describe('CodexCliProvider — failures', () => {
  const run = (result: CliRunResult, timeoutMs?: number) =>
    new CodexCliProvider('codex', { runner: async () => result }).execute({
      capability: Capability.GENERAL_CHAT,
      prompt: PROMPT,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  it('timeout → TIMEOUT with the bounded timeout passed to the runner', async () => {
    const calls: RecordedCall[] = [];
    const codex = new CodexCliProvider('codex', {
      timeoutMs: 45_000,
      runner: recordingRunner({ code: null, stdout: '', stderr: '', timedOut: true }, calls),
    });
    await expect(codex.execute({ capability: Capability.GENERAL_CHAT, prompt: PROMPT })).rejects.toMatchObject({
      kind: AiFailureKind.TIMEOUT,
    });
    expect(calls[0]?.opts.timeoutMs).toBe(45_000);
    await expect(run({ code: null, stdout: '', stderr: '', timedOut: true }, 5_000)).rejects.toMatchObject({
      kind: AiFailureKind.TIMEOUT,
    });
  });

  it('spawn failure (code null) → UNAVAILABLE', async () => {
    await expect(run({ code: null, stdout: '', stderr: 'spawn codex ENOENT', timedOut: false })).rejects.toMatchObject({
      kind: AiFailureKind.UNAVAILABLE,
    });
  });

  it('not logged in / usage limit → UNAVAILABLE; other failures → EXECUTION_FAILED; the raw text is never echoed', async () => {
    const authFailed = jsonl({ type: 'turn.failed', error: { message: 'Not logged in. Please run codex login' } });
    const err = await run({ code: 1, stdout: authFailed, stderr: '', timedOut: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: AiFailureKind.UNAVAILABLE });
    expect(String((err as Error).message)).not.toContain('codex login');

    await expect(run({ code: 1, stdout: jsonl({ type: 'error', message: "You've hit your usage limit" }), stderr: '', timedOut: false }))
      .rejects.toMatchObject({ kind: AiFailureKind.UNAVAILABLE });

    const other = await run({
      code: 2, stdout: '', stderr: 'Error: Unknown feature flag: shell_tool (prompt: 비 오는 날)', timedOut: false,
    }).catch((e: unknown) => e);
    expect(other).toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    expect(String((other as Error).message)).not.toContain('비 오는 날');

    // A failed turn is a failure even when the process exits 0.
    await expect(run(ok(jsonl({ type: 'turn.failed', error: { message: 'stream disconnected' } }))))
      .rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
  });

  it('classifies failure text', () => {
    expect(classifyCodexFailure('401 Unauthorized')).toBe(AiFailureKind.UNAVAILABLE);
    expect(classifyCodexFailure('rate limit exceeded (429)')).toBe(AiFailureKind.UNAVAILABLE);
    expect(classifyCodexFailure('model returned an unexpected response')).toBe(AiFailureKind.EXECUTION_FAILED);
  });

  it('a wrapper whose native child ignores SIGTERM and holds the pipes still settles as TIMEOUT (Codex P2)', async () => {
    const stream = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
    let child: (EventEmitter & { pid: number; stdout: ReturnType<typeof stream>; stderr: ReturnType<typeof stream> }) | undefined;
    const groupSignals: Array<string | 0> = [];
    let spawnCwd = '';
    const runner = createContainedCliRunner({
      killGraceMs: 20,
      processGroup: true,
      killProcessGroup: (_pid, signal) => { groupSignals.push(signal); }, // the "native child" ignores it
      spawnFn: (_bin, _args, options) => {
        spawnCwd = String(options.cwd);
        const stdin = Object.assign(stream(), { write: (_d: string, cb?: (e?: Error | null) => void) => { cb?.(null); return true; }, end: () => undefined });
        child = Object.assign(new EventEmitter(), { pid: 31337, stdout: stream(), stderr: stream(), stdin, kill: () => true });
        return child as unknown as ChildProcess; // never emits `close`
      },
    });
    const codex = new CodexCliProvider('codex', { runner, timeoutMs: 20 });
    await expect(codex.execute({ capability: Capability.GENERAL_CHAT, prompt: PROMPT })).rejects.toMatchObject({
      kind: AiFailureKind.TIMEOUT,
    });
    expect(groupSignals).toEqual(['SIGTERM', 0, 'SIGKILL']); // 0 = the group existence probe
    expect(child?.stdout.destroyed).toBe(true);
    expect(spawnCwd).toContain(CODEX_CWD_PREFIX);
    expect(existsSync(spawnCwd)).toBe(false);
  });

  it('removes the temp cwd even when the runner throws', async () => {
    let seenCwd = '';
    const codex = new CodexCliProvider('codex', {
      runner: async (_bin, _args, opts) => {
        seenCwd = opts.cwd;
        throw new Error('boom');
      },
    });
    await expect(codex.execute({ capability: Capability.GENERAL_CHAT, prompt: PROMPT })).rejects.toThrow('boom');
    expect(seenCwd).toContain(CODEX_CWD_PREFIX);
    expect(existsSync(seenCwd)).toBe(false);
  });
});

describe('CodexCliProvider — readiness probe', () => {
  it('ready when `codex login status` exits 0 and reports a login (no model call)', async () => {
    const calls: RecordedCall[] = [];
    const codex = new CodexCliProvider('codex', {
      runner: recordingRunner({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n', timedOut: false }, calls),
    });
    expect(await codex.isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['login', 'status']);
    expect(calls[0]?.opts.input).toBe('');
    expect(calls[0]?.opts.timeoutMs).toBe(CODEX_PROBE_TIMEOUT_MS);
    expect(CODEX_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it.each<[string, CliRunResult]>([
    ['not logged in', { code: 1, stdout: '', stderr: 'Not logged in\n', timedOut: false }],
    ['exit 0 but no login line', { code: 0, stdout: 'something else', stderr: '', timedOut: false }],
    ['missing CLI', { code: null, stdout: '', stderr: 'spawn codex ENOENT', timedOut: false }],
  ])('not ready when %s', async (_label, result) => {
    expect(await new CodexCliProvider('codex', { runner: async () => result }).isAvailable()).toBe(false);
  });

  it('a timed-out probe is indeterminate, never "not ready" (live QA D16)', async () => {
    const result: CliRunResult = { code: null, stdout: '', stderr: 'Logged in using ChatGPT', timedOut: true };
    await expect(new CodexCliProvider('codex', { runner: async () => result }).isAvailable()).rejects.toBeInstanceOf(
      ProviderProbeIndeterminateError,
    );
  });

  it('a throwing runner is not ready', async () => {
    const codex = new CodexCliProvider('codex', { runner: async () => { throw new Error('x'); } });
    expect(await codex.isAvailable()).toBe(false);
  });
});

describe('CodexCliProvider — routing by priority (no provider-id branching)', () => {
  const ready = (provider: AiProvider): AiProvider => provider;

  it('with Codex and Claude registered, chat-tier capabilities go to Codex and code/policy stay on Claude', async () => {
    const loggedIn: CliRunner = async (_bin, args) =>
      args[0] === 'login'
        ? { code: 0, stdout: '', stderr: 'Logged in using ChatGPT', timedOut: false }
        : { code: 0, stdout: '', stderr: '', timedOut: false };
    const claudeReady: CliRunner = async () => ({ code: 0, stdout: 'claude 2.x', stderr: '', timedOut: false });
    const claude = ready(new ClaudeCliProvider('claude', { runner: claudeReady }));
    const codex = ready(new CodexCliProvider('codex', { runner: loggedIn }));
    const router = new CapabilityRouter(new AiProviderManager([claude, codex], { availabilityTtlMs: 0 }));

    for (const capability of CODEX_CHAT_CAPABILITIES) {
      expect((await router.select(capability)).id, capability).toBe('codex-cli');
    }
    for (const capability of [
      Capability.CODE_IMPLEMENTATION, Capability.CODE_REVIEW, Capability.POLICY_SENSITIVE_CHAT,
      Capability.PROJECT_ANALYSIS, Capability.ARCHITECTURE_PLANNING,
    ]) {
      expect((await router.select(capability)).id, capability).toBe('claude-cli');
    }
  });

  it('an unready Codex falls back to Claude at selection time', async () => {
    const claude = new ClaudeCliProvider('claude', {
      runner: async () => ({ code: 0, stdout: 'claude 2.x', stderr: '', timedOut: false }),
    });
    const codex = new CodexCliProvider('codex', {
      runner: async () => ({ code: 1, stdout: '', stderr: 'Not logged in', timedOut: false }),
    });
    const router = new CapabilityRouter(new AiProviderManager([claude, codex], { availabilityTtlMs: 0 }));
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe('claude-cli');
  });
});

describe('CodexCliProvider — temp directory cleanup never escapes (Codex review P2 on 76e0028)', () => {
  it('an EACCES on removal keeps the answered reply, logs a path-free code and schedules one retry', async () => {
    const warnings: unknown[] = [];
    const retries: number[] = [];
    let removed = '';
    const codex = new CodexCliProvider('codex', {
      runner: async () => ok(answered('답이에요.')),
      cleanup: {
        logger: { warn: (_message, fields) => { warnings.push(fields); } },
        remove: (path) => {
          removed = path;
          throw Object.assign(new Error(`EACCES: permission denied, rmdir '${path}'`), { code: 'EACCES' });
        },
        scheduleRetry: (_retry, delayMs) => { retries.push(delayMs); },
      },
    });
    const result = await codex.execute({ capability: Capability.GENERAL_CHAT, prompt: PROMPT });
    expect(result.text).toBe('답이에요.');
    expect(warnings).toEqual([{ code: 'CODEX_CWD_CLEANUP_FAILED', provider: 'codex-chat', errno: 'EACCES' }]);
    expect(retries).toEqual([CODEX_CWD_CLEANUP_RETRY_MS]);
    expect(JSON.stringify(warnings)).not.toContain(removed);
    rmSync(removed, { recursive: true, force: true });
  });

  it('removeCodexCallDirectory swallows logger and scheduler failures too', () => {
    expect(() =>
      removeCodexCallDirectory('/nonexistent/quoky-codex-x', 'codex-chat', {
        logger: { warn: () => { throw new Error('logger down'); } },
        remove: () => { throw new Error('nope'); },
        scheduleRetry: () => { throw new Error('no timers'); },
      }),
    ).not.toThrow();
  });
});
