import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiFailureKind,
  AiProviderManager,
  Capability,
  CapabilityRouter,
  executionLocalityOf,
} from '@quoky/core';
import type { AiImageInput, AiRequest } from '@quoky/core';
import {
  ClaudeCliProvider,
  ClaudeCliVisionProvider,
  DEFAULT_CLAUDE_VISION_TIMEOUT_MS,
  MAX_CLAUDE_VISION_IMAGE_BYTES,
  OllamaCliVisionProvider,
  buildClaudeVisionStreamJsonInput,
  parseClaudeStreamJsonResult,
} from './index';
import type { CliRunOptions, CliRunner, CliRunResult } from './cli-runner';

// ADR-0111 amendment A1/A2: the Claude CLI vision provider. Offline: every CLI call goes to a fake runner; the images
// are real temp files so the open/size/signature checks run for real.

interface Call { bin: string; args: string[]; opts: CliRunOptions }

function recordingRunner(respond: (args: string[], opts: CliRunOptions) => CliRunResult): { runner: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return respond(args, opts);
    },
  };
}

const ok = (stdout: string, stderr = ''): CliRunResult => ({ code: 0, stdout, stderr, timedOut: false });

/** The event lines the real CLI printed for a successful image call (shape from the verified run; values made up). */
function streamJson(result: Record<string, unknown>): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet', tools: [], mcp_servers: [] }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] } }),
    JSON.stringify({ type: 'rate_limit_event' }),
    JSON.stringify({ type: 'result', num_turns: 1, ...result }),
  ].join('\n') + '\n';
}
const SUCCESS = streamJson({ subtype: 'success', is_error: false, result: '주간 매출 막대 그래프예요.' });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([1, 2])]);

let dir: string;
let png: string;
let jpg: string;
let webp: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-claude-vision-test-'));
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

const imageRequest = (images: AiImageInput[], prompt = '# System\nread it\n\n# Task\nUser request: "what is this?"'): AiRequest => ({
  capability: Capability.IMAGE_UNDERSTANDING,
  prompt,
  images,
});

describe('ClaudeCliVisionProvider — descriptor', () => {
  it('advertises ONLY IMAGE_UNDERSTANDING and declares REMOTE (cloud)', () => {
    const provider = new ClaudeCliVisionProvider({ model: 'sonnet' });
    expect(provider.capabilities.map((c) => c.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
    expect(executionLocalityOf(provider)).toBe('REMOTE');
    expect(provider.id).toBe('claude-vision-cli');
  });

  it('uses the chat provider isolation flags, stream-json in and out, and no tools (`--tools ""` last)', () => {
    const args = new ClaudeCliVisionProvider({ model: 'sonnet' }).buildArgs();
    expect(args).toEqual([
      '-p', '--model', 'sonnet', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
    ]);
    // Same isolation prefix as the chat ClaudeCliProvider.
    expect(args.slice(0, 7)).toEqual(new ClaudeCliProvider('claude', { model: 'sonnet' }).buildArgs());
  });

  it('refuses a model name that could be read as a flag or carries whitespace', () => {
    for (const model of ['--help', '-p', 'two words', 'a;b', '']) {
      expect(() => new ClaudeCliVisionProvider({ model }), model).toThrow('Invalid Claude model name');
    }
  });
});

describe('ClaudeCliVisionProvider — readiness (CLI present AND logged in)', () => {
  it('ready only when `claude auth status --json` exits 0 with loggedIn: true; bounded; account fields unread', async () => {
    const { runner, calls } = recordingRunner(() =>
      ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.invalid' })),
    );
    expect(await new ClaudeCliVisionProvider({ model: 'sonnet', bin: '/x/claude', runner }).isAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe('/x/claude');
    expect(calls[0]?.args).toEqual(['auth', 'status', '--json']);
    expect(calls[0]?.opts.timeoutMs).toBe(10_000);
    expect(calls[0]?.opts.input).toBe('');
  });

  it.each([
    ['logged out', ok(JSON.stringify({ loggedIn: false }))],
    ['loggedIn not a boolean', ok(JSON.stringify({ loggedIn: 'true' }))],
    ['non-JSON output', ok('Not logged in · Please run /login')],
    ['non-zero exit', { code: 1, stdout: '', stderr: 'error', timedOut: false }],
    ['CLI missing (spawn failed)', { code: null, stdout: '', stderr: 'spawn claude ENOENT', timedOut: false }],
    ['probe timed out', { code: null, stdout: '', stderr: '', timedOut: true }],
  ])('not ready when %s', async (_label, result) => {
    const { runner } = recordingRunner(() => result as CliRunResult);
    expect(await new ClaudeCliVisionProvider({ model: 'sonnet', runner }).isAvailable()).toBe(false);
  });

  it('a throwing runner is not ready', async () => {
    const runner: CliRunner = async () => { throw new Error('boom'); };
    expect(await new ClaudeCliVisionProvider({ model: 'sonnet', runner }).isAvailable()).toBe(false);
  });
});

describe('ClaudeCliVisionProvider — stream-json payload', () => {
  it('one user message: base64 image blocks in upload order, then the prompt as a text block, newline-terminated', () => {
    const line = buildClaudeVisionStreamJsonInput('PROMPT', [
      { mimeType: 'image/png', base64: 'QUJD' },
      { mimeType: 'image/jpeg', base64: 'REVG' },
    ]);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
          { type: 'text', text: 'PROMPT' },
        ],
      },
    });
  });
});

describe('ClaudeCliVisionProvider — execute', () => {
  it('sends the images as base64 blocks on stdin; argv carries no path and no bytes; neutral cwd; bounded timeout', async () => {
    const { runner, calls } = recordingRunner(() => ok(SUCCESS));
    const provider = new ClaudeCliVisionProvider({ model: 'sonnet', runner });
    const prompt = '# System\nread it\n\n# Task\nUser request: "이 그래프 설명해줘"';
    const result = await provider.execute(imageRequest(
      [{ path: png, mimeType: 'image/png' }, { path: jpg, mimeType: 'image/jpeg' }, { path: webp, mimeType: 'image/webp' }],
      prompt,
    ));

    expect(result.text).toBe('주간 매출 막대 그래프예요.');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.bin).toBe('claude');
    expect(call.args).toEqual(provider.buildArgs());
    expect(call.opts.cwd).toBe(tmpdir());
    expect(call.opts.timeoutMs).toBe(DEFAULT_CLAUDE_VISION_TIMEOUT_MS);
    const argv = call.args.join(' ');
    for (const path of [png, jpg, webp, dir]) expect(argv).not.toContain(path);
    for (const bytes of [PNG, JPEG, WEBP]) expect(argv).not.toContain(bytes.toString('base64'));

    const sent = JSON.parse(call.opts.input) as { message: { content: Array<Record<string, unknown>> } };
    expect(sent.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: WEBP.toString('base64') } },
      { type: 'text', text: prompt },
    ]);
    // The stdin payload carries the bytes, never the temp-file path.
    expect(call.opts.input).not.toContain(dir);
  });

  it('the audit carries counts and hashes only — no path, no bytes, no prompt text', async () => {
    const { runner } = recordingRunner(() => ok(SUCCESS));
    const prompt = '# Task\nUser request: "PROMPT_BODY_MARKER"';
    const result = await new ClaudeCliVisionProvider({ model: 'sonnet', runner }).execute(
      imageRequest([{ path: png, mimeType: 'image/png' }], prompt),
    );
    expect(result.audit).toMatchObject({
      model: 'sonnet',
      executionLocality: 'REMOTE',
      inputFormat: 'stream-json',
      imageCount: 1,
      imageBytes: PNG.length,
      imageSha256: [createHash('sha256').update(PNG).digest('hex')],
      promptSha256: createHash('sha256').update(prompt).digest('hex'),
    });
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(dir);
    expect(everything).not.toContain(PNG.toString('base64'));
    expect(JSON.stringify(result.audit)).not.toContain('PROMPT_BODY_MARKER');
  });

  it('honours the request timeout and maps a timeout to TIMEOUT', async () => {
    const { runner, calls } = recordingRunner(() => ({ code: null, stdout: '', stderr: '', timedOut: true }));
    const provider = new ClaudeCliVisionProvider({ model: 'sonnet', runner });
    await expect(provider.execute({ ...imageRequest([{ path: png, mimeType: 'image/png' }]), timeoutMs: 5_000 }))
      .rejects.toMatchObject({ kind: AiFailureKind.TIMEOUT });
    expect(calls[0]?.opts.timeoutMs).toBe(5_000);
  });

  it.each([
    ['CLI missing', { code: null, stdout: '', stderr: 'spawn claude ENOENT', timedOut: false }, AiFailureKind.UNAVAILABLE],
    ['not logged in (stdout, exit 1)', { code: 1, stdout: 'Not logged in · Please run /login\n', stderr: '', timedOut: false }, AiFailureKind.AUTH_REQUIRED],
    ['exit 1 with an error result', { code: 1, stdout: streamJson({ subtype: 'error_during_execution', is_error: true, result: 'boom' }), stderr: '', timedOut: false }, AiFailureKind.EXECUTION_FAILED],
    ['exit 0 with an API 401 result', ok(streamJson({ subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid bearer' })), AiFailureKind.AUTH_REQUIRED],
    ['exit 0 with an API 400 result', ok(streamJson({ subtype: 'success', is_error: true, api_error_status: 400, result: 'image too large' })), AiFailureKind.EXECUTION_FAILED],
    ['no result event', ok(JSON.stringify({ type: 'system', subtype: 'init' })), AiFailureKind.EXECUTION_FAILED],
    ['output over the capture bound', { ...ok(SUCCESS), outputOverflowed: true }, AiFailureKind.EXECUTION_FAILED],
    ['empty result text', ok(streamJson({ subtype: 'success', is_error: false, result: '   ' })), AiFailureKind.EMPTY_OUTPUT],
  ])('classifies %s without leaking the image path', async (_label, outcome, kind) => {
    const { runner } = recordingRunner(() => ({ ...(outcome as CliRunResult), stderr: `${(outcome as CliRunResult).stderr} ${png}` }));
    const error = await new ClaudeCliVisionProvider({ model: 'sonnet', runner })
      .execute(imageRequest([{ path: png, mimeType: 'image/png' }]))
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ kind });
    expect(String((error as Error).message)).not.toContain(dir);
    expect(String((error as Error).message)).not.toContain(PNG.toString('base64'));
  });

  it('requires IMAGE_UNDERSTANDING and 1–3 distinct images; spawns nothing otherwise', async () => {
    const { runner, calls } = recordingRunner(() => ok(SUCCESS));
    const provider = new ClaudeCliVisionProvider({ model: 'sonnet', runner });
    const one = { path: png, mimeType: 'image/png' as const };
    for (const request of [
      { ...imageRequest([one]), capability: Capability.GENERAL_CHAT },
      imageRequest([]),
      imageRequest([one, { path: jpg, mimeType: 'image/jpeg' }, { path: webp, mimeType: 'image/webp' }, one]),
      imageRequest([one, one]),
    ]) {
      await expect(provider.execute(request)).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses an unsafe or inconsistent image before spawning: relative path, symlink, vanished, empty, oversize, wrong type', async () => {
    const { runner, calls } = recordingRunner(() => ok(SUCCESS));
    const provider = new ClaudeCliVisionProvider({ model: 'sonnet', runner });
    const link = join(dir, 'link.png');
    symlinkSync(png, link);
    const empty = join(dir, 'empty.png');
    writeFileSync(empty, Buffer.alloc(0));
    const big = join(dir, 'big.png');
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_CLAUDE_VISION_IMAGE_BYTES)]));
    const gone = join(dir, 'gone.png');
    writeFileSync(gone, PNG);
    unlinkSync(gone);
    for (const image of [
      { path: 'intake-1.png', mimeType: 'image/png' },
      { path: link, mimeType: 'image/png' },
      { path: gone, mimeType: 'image/png' },
      { path: empty, mimeType: 'image/png' },
      { path: big, mimeType: 'image/png' },
      { path: jpg, mimeType: 'image/png' }, // a JPEG declared as PNG
      { path: png, mimeType: 'image/gif' },
      { path: dir, mimeType: 'image/png' },
    ] as AiImageInput[]) {
      const error = await provider.execute(imageRequest([image])).catch((err: unknown) => err);
      expect(error, image.path).toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
      expect(String((error as Error).message)).not.toContain(dir);
    }
    expect(calls).toHaveLength(0);
  });

  it('scrubs the image path from the reply text (defense in depth)', async () => {
    const { runner } = recordingRunner(() => ok(streamJson({ subtype: 'success', is_error: false, result: `파일 ${png} 은 그래프예요.` })));
    const result = await new ClaudeCliVisionProvider({ model: 'sonnet', runner }).execute(
      imageRequest([{ path: png, mimeType: 'image/png' }]),
    );
    expect(result.text).toBe('파일 <image> 은 그래프예요.');
  });
});

describe('parseClaudeStreamJsonResult', () => {
  it('takes only the final result event and ignores every other line', () => {
    expect(parseClaudeStreamJsonResult(SUCCESS)).toMatchObject({ ok: true, text: '주간 매출 막대 그래프예요.' });
    expect(parseClaudeStreamJsonResult(`garbage\n${SUCCESS}`)).toMatchObject({ ok: true });
    expect(parseClaudeStreamJsonResult('')).toMatchObject({ ok: false, kind: AiFailureKind.EXECUTION_FAILED });
  });
});

describe('capability routing with the Claude vision provider (amendment A2)', () => {
  it('IMAGE_UNDERSTANDING selects the Claude vision instance, never the chat ClaudeCliProvider', async () => {
    const ready: CliRunner = async () => ok(JSON.stringify({ loggedIn: true }));
    const chat = new ClaudeCliProvider('claude', { runner: async () => ok('Claude Code 2') });
    const vision = new ClaudeCliVisionProvider({ model: 'sonnet', runner: ready });
    const router = new CapabilityRouter(new AiProviderManager([chat, vision]));
    const selected = await router.select(Capability.IMAGE_UNDERSTANDING);
    expect(selected.id).toBe('claude-vision-cli');
    expect(executionLocalityOf(selected)).toBe('REMOTE');
    // The chat provider never advertises the capability, and the local vision provider is a separate instance.
    expect(chat.capabilities.map((c) => c.capability)).not.toContain(Capability.IMAGE_UNDERSTANDING);
    expect(new OllamaCliVisionProvider({ model: 'gemma3:4b' }).capabilities).toEqual(vision.capabilities);
  });
});
