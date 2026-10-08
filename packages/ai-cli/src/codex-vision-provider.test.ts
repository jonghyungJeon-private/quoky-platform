import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiFailureKind, AiProviderManager, Capability, CapabilityRouter, describeAiFailure, executionLocalityOf } from '@quoky/core';
import type { AiImageInput, AiRequest } from '@quoky/core';
import {
  CODEX_CONFIG_OVERRIDES,
  CODEX_DISABLED_FEATURES,
  CodexCliProvider,
} from './codex-cli-provider';
import {
  CODEX_VISION_CWD_PREFIX,
  CODEX_VISION_PREAMBLE,
  CodexCliVisionProvider,
  DEFAULT_CODEX_VISION_TIMEOUT_MS,
} from './codex-vision-provider';
import { ClaudeCliProvider, MAX_VISION_IMAGE_BYTES } from './index';
import type { CliRunOptions, CliRunResult, CliRunner } from './cli-runner';

// ADR-0111 amendment (2026-10-08): the Codex CLI vision provider. Offline: every CLI call goes to a fake runner; the
// images are real temp files so the open/size/signature checks and the private copies run for real.

interface Call {
  bin: string;
  args: string[];
  opts: CliRunOptions;
  /** The cwd's entries at spawn time, with each image copy's bytes and mode. */
  cwdEntries: Array<{ name: string; bytes: Buffer; mode: number; symlink: boolean }>;
  cwdMode: number;
}

function recordingRunner(respond: (args: string[], opts: CliRunOptions) => CliRunResult): { runner: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (bin, args, opts) => {
      // Only an execute call's own cwd is inspected (a readiness probe runs in the shared OS temp directory).
      const own = opts.cwd.includes(CODEX_VISION_CWD_PREFIX);
      const cwdEntries = (own ? readdirSync(opts.cwd) : []).map((name) => {
        const path = join(opts.cwd, name);
        return { name, bytes: readFileSync(path), mode: statSync(path).mode & 0o777, symlink: lstatSync(path).isSymbolicLink() };
      });
      calls.push({ bin, args, opts, cwdEntries, cwdMode: own ? statSync(opts.cwd).mode & 0o777 : -1 });
      return respond(args, opts);
    },
  };
}

const ok = (stdout: string, stderr = ''): CliRunResult => ({ code: 0, stdout, stderr, timedOut: false });

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

/** The event stream the live `codex exec --image` call printed on 2026-10-08 (0.160.0 shape; values made up). */
function answered(text: string): string {
  return jsonl(
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 8337, cached_input_tokens: 2688, output_tokens: 30 } },
  );
}
const ANSWER = '막대 4개(빨강, 초록, 파랑, 주황)이고 주황 막대가 가장 높아요.';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([1, 2])]);

let dir: string;
let png: string;
let jpg: string;
let webp: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-codex-vision-test-'));
  png = join(dir, 'intake-1.png');
  jpg = join(dir, 'intake-2.jpg');
  webp = join(dir, 'intake-3.webp');
  writeFileSync(png, PNG);
  writeFileSync(jpg, JPEG);
  writeFileSync(webp, WEBP);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PROMPT = '# System\nread it\n\n# Task\nUser request: "what is this?"';
const imageRequest = (images: AiImageInput[], prompt = PROMPT): AiRequest => ({
  capability: Capability.IMAGE_UNDERSTANDING,
  prompt,
  images,
});
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe('CodexCliVisionProvider — descriptor', () => {
  it('advertises ONLY IMAGE_UNDERSTANDING and declares REMOTE; the chat Codex provider still advertises no image capability', () => {
    const provider = new CodexCliVisionProvider();
    expect(provider.id).toBe('codex-vision-cli');
    expect(provider.capabilities).toEqual([{ capability: Capability.IMAGE_UNDERSTANDING, priority: 100 }]);
    expect(executionLocalityOf(provider)).toBe('REMOTE');
    expect(new CodexCliProvider().capabilities.map((c) => c.capability)).not.toContain(Capability.IMAGE_UNDERSTANDING);
  });

  it('refuses a model name that could be read as a flag', () => {
    for (const model of ['--sandbox', '-x', 'a b', '']) {
      expect(() => new CodexCliVisionProvider({ model }), model).toThrow('Invalid Codex model name');
    }
    expect(new CodexCliVisionProvider({ model: 'gpt-5.5' }).buildArgs()).toContain('gpt-5.5');
  });

  it('argv: every --image first (each before a flag), then the chat isolation flags, low effort, the disabled tools and the trailing stdin marker', () => {
    const args = new CodexCliVisionProvider({ model: 'gpt-5.5' }).buildArgs(['/t/image-1.png', '/t/image-2.jpg']);
    expect(args.slice(0, 5)).toEqual(['exec', '--image', '/t/image-1.png', '--image', '/t/image-2.jpg']);
    expect(args[5]).toBe('--json');
    for (const flag of ['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) expect(args).toContain(flag);
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    for (const override of [...CODEX_CONFIG_OVERRIDES, 'model_reasoning_effort="low"']) {
      expect(args[args.indexOf(override) - 1]).toBe('-c');
    }
    for (const feature of CODEX_DISABLED_FEATURES) expect(args[args.indexOf(feature) - 1]).toBe('--disable');
    // view_image (the tool that reads files from disk) stays disabled; --image attaches the bytes to the prompt.
    expect(args).toContain('view_image');
    expect(args.slice(-3)).toEqual(['-m', 'gpt-5.5', '-']);
    // Identical isolation to the chat provider: only the --image pairs and the effort differ.
    const chat = new CodexCliProvider('codex', { model: 'gpt-5.5' }).buildArgs({ capability: Capability.GENERAL_CHAT });
    expect(args.filter((arg, i) => !arg.startsWith('/t/') && args[i + 1]?.startsWith('/t/') !== true)).toEqual(chat);
  });
});

describe('CodexCliVisionProvider — readiness', () => {
  it('is ready only when `codex login status` exits 0 and reports a login; no model call', async () => {
    const { runner, calls } = recordingRunner(() => ok('', 'Logged in using ChatGPT\n'));
    expect(await new CodexCliVisionProvider({ bin: '/x/codex', runner }).isAvailable()).toBe(true);
    expect(calls.map((c) => [c.bin, c.args])).toEqual([['/x/codex', ['login', 'status']]]);
    for (const outcome of [
      { code: 1, stdout: '', stderr: 'Not logged in', timedOut: false },
      ok('', 'Not logged in\n'),
      { code: null, stdout: '', stderr: '', timedOut: true },
    ]) {
      const probe = recordingRunner(() => outcome);
      expect(await new CodexCliVisionProvider({ runner: probe.runner }).isAvailable()).toBe(false);
    }
  });
});

describe('CodexCliVisionProvider — execute', () => {
  it('copies the image into a fresh EMPTY private cwd, passes only that copy as --image, the prompt on stdin, and removes the cwd', async () => {
    const { runner, calls } = recordingRunner(() => ok(answered(ANSWER)));
    const provider = new CodexCliVisionProvider({ runner });
    const result = await provider.execute(imageRequest([{ path: png, mimeType: 'image/png' }]));
    expect(result.text).toBe(ANSWER);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.bin).toBe('codex');
    // The cwd is a new directory under the OS temp dir, private, holding exactly the one copy (nothing else exposed).
    expect(call.opts.cwd.startsWith(join(dirname(call.opts.cwd), CODEX_VISION_CWD_PREFIX))).toBe(true);
    expect(call.opts.cwd).not.toBe(dir);
    expect(call.cwdMode).toBe(0o700);
    expect(call.cwdEntries).toEqual([{ name: 'image-1.png', bytes: PNG, mode: 0o600, symlink: false }]);
    const imageArg = call.args[call.args.indexOf('--image') + 1]!;
    expect(imageArg).toBe(join(call.opts.cwd, 'image-1.png'));
    // The intake path never reaches argv or stdin; the prompt is stdin only.
    expect(call.args.join('\u0000')).not.toContain(dir);
    expect(call.args).not.toContain(PROMPT);
    expect(call.opts.input).toBe(`${CODEX_VISION_PREAMBLE}${PROMPT}`);
    expect(call.opts.input).not.toContain(dir);
    expect(call.opts.timeoutMs).toBe(DEFAULT_CODEX_VISION_TIMEOUT_MS);
    expect(existsSync(call.opts.cwd)).toBe(false);
    // The original intake file is untouched.
    expect(readFileSync(png)).toEqual(PNG);
  });

  it('three images: three copies in upload order with the right extensions', async () => {
    const { runner, calls } = recordingRunner(() => ok(answered(ANSWER)));
    await new CodexCliVisionProvider({ runner }).execute(
      imageRequest([
        { path: jpg, mimeType: 'image/jpeg' },
        { path: png, mimeType: 'image/png' },
        { path: webp, mimeType: 'image/webp' },
      ]),
    );
    const call = calls[0]!;
    expect(call.cwdEntries.map((e) => [e.name, e.bytes])).toEqual([
      ['image-1.jpg', JPEG],
      ['image-2.png', PNG],
      ['image-3.webp', WEBP],
    ]);
    const images = call.args.flatMap((arg, i) => (call.args[i - 1] === '--image' ? [arg] : []));
    expect(images).toEqual(['image-1.jpg', 'image-2.png', 'image-3.webp'].map((name) => join(call.opts.cwd, name)));
  });

  it('the audit holds counts and hashes only: no prompt, reply, image bytes or path', async () => {
    const { runner } = recordingRunner(() => ok(answered(ANSWER)));
    const result = await new CodexCliVisionProvider({ runner }).execute(imageRequest([{ path: png, mimeType: 'image/png' }]));
    expect(result.audit).toMatchObject({
      model: 'cli-default',
      executionLocality: 'REMOTE',
      promptSha256: sha(PROMPT),
      providerInputSha256: sha(`${CODEX_VISION_PREAMBLE}${PROMPT}`),
      replySha256: sha(ANSWER),
      imageCount: 1,
      imageBytes: PNG.length,
      imageSha256: [sha(PNG)],
      agentMessageCount: 1,
      actionItemCount: 0,
      warningItemCount: 1,
      turnCompletedCount: 1,
      inputTokens: 8337,
    });
    const audit = JSON.stringify(result.audit);
    expect((result.audit as { sanitizedCommand: string[] }).sanitizedCommand.slice(0, 3)).toEqual(['codex', 'exec', '--image']);
    expect((result.audit as { sanitizedCommand: string[] }).sanitizedCommand[3]).toBe('<image>');
    for (const forbidden of [dir, tmpdir(), CODEX_VISION_CWD_PREFIX, 'read it', ANSWER, PNG.toString('base64')]) {
      expect(audit).not.toContain(forbidden);
    }
  });

  it('a reply that quotes a path has it replaced by <image>', async () => {
    let cwd = '';
    const { runner } = recordingRunner((_args, opts) => {
      cwd = opts.cwd;
      return ok(answered(`${join(opts.cwd, 'image-1.png')} and ${png} show a chart`));
    });
    const result = await new CodexCliVisionProvider({ runner }).execute(imageRequest([{ path: png, mimeType: 'image/png' }]));
    expect(result.text).toBe('<image> and <image> show a chart');
    expect(result.text).not.toContain(cwd);
  });

  it.each([
    ['a timeout', { code: null, stdout: '', stderr: '', timedOut: true }, AiFailureKind.TIMEOUT],
    ['a CLI that cannot start', { code: null, stdout: '', stderr: 'spawn codex ENOENT', timedOut: false }, AiFailureKind.UNAVAILABLE],
    ['a login failure', { code: 1, stdout: jsonl({ type: 'turn.started' }, { type: 'turn.failed', error: { message: 'Not logged in' } }), stderr: '', timedOut: false }, AiFailureKind.UNAVAILABLE],
    ['a usage limit', { code: 1, stdout: '', stderr: 'You have hit your usage limit', timedOut: false }, AiFailureKind.UNAVAILABLE],
    ['any other failure', { code: 2, stdout: '', stderr: 'image too large', timedOut: false }, AiFailureKind.EXECUTION_FAILED],
    ['output over the capture bound', { ...ok(answered(ANSWER)), outputOverflowed: true }, AiFailureKind.EXECUTION_FAILED],
    ['no reply', ok(answered('   ')), AiFailureKind.EMPTY_OUTPUT],
  ])('classifies %s with a fixed reason', async (_label, outcome, kind) => {
    const { runner } = recordingRunner(() => outcome as CliRunResult);
    const error = await new CodexCliVisionProvider({ runner })
      .execute(imageRequest([{ path: png, mimeType: 'image/png' }]))
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ kind });
    expect((error as Error).message).toMatch(/^codex vision CLI [a-z ]+/u);
  });

  it('#140 P2 rule: CLI text that echoes the prompt, the image or a path never reaches the error, summary or audit', async () => {
    const big = join(dir, 'echo.png');
    const bigBytes = Buffer.concat([PNG, Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256))]);
    writeFileSync(big, bigBytes);
    const base64 = bigBytes.toString('base64');
    const prompt = '# Task\nUser request: "PROMPT_ECHO_MARKER"';
    const echoes: Array<[string, (cwd: string, input: string) => CliRunResult]> = [
      ['stderr, exit 1', (cwd, input) => ({ code: 1, stdout: '', stderr: `invalid image ${cwd}/image-1.png ${base64} ${input}`, timedOut: false })],
      ['turn.failed, exit 1', (cwd, input) => ({ code: 1, stdout: jsonl({ type: 'turn.started' }, { type: 'turn.failed', error: { message: `${input} ${cwd} ${base64}` } }), stderr: '', timedOut: false })],
      ['error event, exit 0', (cwd, input) => ok(jsonl({ type: 'turn.started' }, { type: 'error', message: `${input} ${cwd}` }, { type: 'turn.completed' }))],
      ['malformed stream', (cwd, input) => ok(`${input}\n${cwd}\n${base64}\n`)],
      ['spawn failure', (cwd) => ({ code: null, stdout: '', stderr: `cannot run in ${cwd}`, timedOut: false })],
      ['timeout', (cwd, input) => ({ code: null, stdout: input, stderr: cwd, timedOut: true })],
      ['action item', (cwd, input) => ok(jsonl({ type: 'turn.started' }, { type: 'item.completed', item: { id: 'x', type: 'command_execution', command: `cat ${cwd} ${input}` } }, { type: 'turn.completed' }))],
    ];
    for (const [label, respond] of echoes) {
      const { runner } = recordingRunner((_args, opts) => respond(opts.cwd, opts.input));
      const error = await new CodexCliVisionProvider({ runner })
        .execute(imageRequest([{ path: big, mimeType: 'image/png' }], prompt))
        .catch((err: unknown) => err);
      expect(error, label).toBeInstanceOf(Error);
      const persisted = JSON.stringify([(error as Error).message, describeAiFailure(error), (error as { audit?: unknown }).audit ?? null]);
      expect(persisted, label).not.toContain('PROMPT_ECHO_MARKER');
      expect(persisted, label).not.toContain(dir);
      expect(persisted, label).not.toContain(CODEX_VISION_CWD_PREFIX);
      expect(persisted, label).not.toContain(base64.slice(0, 40));
      expect((error as Error).message, label).toMatch(/^codex vision CLI [a-z ]+/u);
    }
  });

  it('a stream with a tool action or an unknown event is refused as a whole and the cwd is still removed', async () => {
    for (const stdout of [
      jsonl({ type: 'turn.started' }, { type: 'item.completed', item: { id: 'x', type: 'file_change' } }, { type: 'item.completed', item: { id: 'y', type: 'agent_message', text: ANSWER } }, { type: 'turn.completed' }),
      jsonl({ type: 'turn.started' }, { type: 'item.completed', item: { id: 'y', type: 'agent_message', text: ANSWER } }, { type: 'new.event' }, { type: 'turn.completed' }),
      jsonl({ type: 'item.completed', item: { id: 'y', type: 'agent_message', text: ANSWER } }),
    ]) {
      const { runner, calls } = recordingRunner(() => ok(stdout));
      await expect(new CodexCliVisionProvider({ runner }).execute(imageRequest([{ path: png, mimeType: 'image/png' }]))).rejects.toMatchObject({
        kind: AiFailureKind.EXECUTION_FAILED,
      });
      expect(existsSync(calls[0]!.opts.cwd)).toBe(false);
    }
  });

  it('the cwd is removed when the runner throws', async () => {
    let cwd = '';
    const runner: CliRunner = async (_bin, _args, opts) => {
      cwd = opts.cwd;
      throw new Error('runner exploded');
    };
    await expect(new CodexCliVisionProvider({ runner }).execute(imageRequest([{ path: png, mimeType: 'image/png' }]))).rejects.toThrow();
    expect(cwd).not.toBe('');
    expect(existsSync(cwd)).toBe(false);
  });

  it('requires IMAGE_UNDERSTANDING, no workspace, and 1–3 distinct images; spawns nothing otherwise', async () => {
    const { runner, calls } = recordingRunner(() => ok(answered(ANSWER)));
    const provider = new CodexCliVisionProvider({ runner });
    const one = { path: png, mimeType: 'image/png' as const };
    for (const request of [
      { ...imageRequest([one]), capability: Capability.GENERAL_CHAT },
      { ...imageRequest([one]), workspace: { path: dir } } as unknown as AiRequest,
      imageRequest([]),
      imageRequest([one, { path: jpg, mimeType: 'image/jpeg' }, { path: webp, mimeType: 'image/webp' }, one]),
      imageRequest([one, one]),
    ]) {
      await expect(provider.execute(request)).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an unsafe or inconsistent image before spawning: relative path, symlink, vanished, empty, oversize, wrong type', async () => {
    const { runner, calls } = recordingRunner(() => ok(answered(ANSWER)));
    const provider = new CodexCliVisionProvider({ runner });
    const link = join(dir, 'link.png');
    symlinkSync(png, link);
    const empty = join(dir, 'empty.png');
    writeFileSync(empty, Buffer.alloc(0));
    const huge = join(dir, 'huge.png');
    writeFileSync(huge, Buffer.concat([PNG, Buffer.alloc(MAX_VISION_IMAGE_BYTES)]));
    for (const image of [
      { path: 'intake-1.png', mimeType: 'image/png' as const },
      { path: link, mimeType: 'image/png' as const },
      { path: join(dir, 'gone.png'), mimeType: 'image/png' as const },
      { path: empty, mimeType: 'image/png' as const },
      { path: huge, mimeType: 'image/png' as const },
      { path: jpg, mimeType: 'image/png' as const },
    ]) {
      const error = await provider.execute(imageRequest([image])).catch((err: unknown) => err);
      expect(error, image.path).toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
      expect((error as Error).message).not.toContain(dir);
    }
    expect(calls).toHaveLength(0);
  });

  it('is selected by capability, never by id, and never for a chat-tier capability', async () => {
    const { runner } = recordingRunner(() => ok('', 'Logged in using ChatGPT\n'));
    const vision = new CodexCliVisionProvider({ runner });
    const claude = new ClaudeCliProvider('claude', { runner: async () => ok('{"loggedIn":true}') });
    const router = new CapabilityRouter(new AiProviderManager([claude, vision]));
    const selected = await router.select(Capability.IMAGE_UNDERSTANDING);
    expect(selected.id).toBe('codex-vision-cli');
    expect(executionLocalityOf(selected)).toBe('REMOTE');
    expect((await router.select(Capability.GENERAL_CHAT)).id).toBe(claude.id);
  });
});
