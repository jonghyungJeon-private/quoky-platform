import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiFailureKind,
  AiProviderError,
  AiProviderManager,
  Capability,
  CapabilityRouter,
  NoProviderAvailableError,
  executionLocalityOf,
} from '@quoky/core';
import type { AiImageInput, AiRequest } from '@quoky/core';
import {
  ClaudeCliProvider,
  CodexCliProvider,
  OllamaCliEmbeddingProvider,
  OllamaCliProvider,
  OllamaCliVisionProvider,
  defangOllamaImageTokens,
  ollamaShowAdvertisesVision,
} from './index';
import type { CliRunOptions, CliRunner, CliRunResult } from './cli-runner';

// ADR-0111 D4/D5 (MM-2): the local Ollama vision provider, and no image egress to any other provider. Offline: every
// CLI call goes to a fake runner; image files are real temp files so the in-place reference checks run for real.

const LIST_WITH_GEMMA = 'NAME              ID              SIZE      MODIFIED\ngemma3:4b         a2af6cc3eb7f    3.3 GB    2 days ago\n';
const SHOW_VISION = [
  '  Model',
  '    architecture        gemma3',
  '    parameters          4.3B',
  '',
  '  Capabilities',
  '    completion',
  '    vision',
  '',
  '  Parameters',
  '    temperature    1',
  '',
].join('\n');
const SHOW_TEXT_ONLY = SHOW_VISION.replace('    vision\n', '');

interface Call { bin: string; args: string[]; opts: CliRunOptions }

function recordingRunner(respond: (args: string[]) => CliRunResult): { runner: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return respond(args);
    },
  };
}

const ok = (stdout: string, stderr = ''): CliRunResult => ({ code: 0, stdout, stderr, timedOut: false });

let dir: string;
let png: string;
let jpg: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quoky-vision-test-'));
  png = join(dir, 'intake-1.png');
  jpg = join(dir, 'intake-2.jpg');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const imageRequest = (images: AiImageInput[], prompt = '# System\nread it\n\n# Task\nUser request: "what is this?"'): AiRequest => ({
  capability: Capability.IMAGE_UNDERSTANDING,
  prompt,
  images,
});

/** A runner that answers like `ollama run` after loading every image argument. */
function visionRunner(answer = 'A bar chart of weekly sales.') {
  return recordingRunner((args) => {
    const paths = args.slice(2);
    return ok(answer, paths.map((p) => `Added image '${p}'\n`).join(''));
  });
}

describe('OllamaCliVisionProvider — descriptor (ADR-0111 D4)', () => {
  it('advertises ONLY IMAGE_UNDERSTANDING and declares LOCAL for a local model', () => {
    const provider = new OllamaCliVisionProvider({ model: 'gemma3:4b' });
    expect(provider.capabilities.map((c) => c.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
    expect(executionLocalityOf(provider)).toBe('LOCAL');
    expect(provider.id).toBe('ollama-vision-cli');
  });

  it('a cloud-served model declares REMOTE', () => {
    expect(executionLocalityOf(new OllamaCliVisionProvider({ model: 'qwen3-vl:235b-cloud' }))).toBe('REMOTE');
  });

  it('refuses a model name that could be read as a flag or carries whitespace', () => {
    for (const model of ['--verbose', 'gemma3 4b', '', 'a\nb']) {
      expect(() => new OllamaCliVisionProvider({ model }), model).toThrow(TypeError);
    }
  });

  it('no other provider advertises IMAGE_UNDERSTANDING (Claude, Codex, Ollama chat, embeddings)', () => {
    for (const provider of [
      new ClaudeCliProvider('claude'),
      new CodexCliProvider(),
      new OllamaCliProvider({ model: 'llama3.1' }),
      new OllamaCliEmbeddingProvider(),
    ]) {
      expect(provider.capabilities.map((c) => c.capability), provider.id).not.toContain(Capability.IMAGE_UNDERSTANDING);
    }
  });
});

describe('OllamaCliVisionProvider — readiness', () => {
  it('ready when the daemon lists the model AND `ollama show` reports the vision capability', async () => {
    const { runner, calls } = recordingRunner((args) => (args[0] === 'list' ? ok(LIST_WITH_GEMMA) : ok(SHOW_VISION)));
    await expect(new OllamaCliVisionProvider({ model: 'gemma3:4b', runner }).isAvailable()).resolves.toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['list'], ['show', 'gemma3:4b']]);
    expect(calls.every((c) => c.opts.input === '')).toBe(true);
  });

  it('not ready for a text-only model, an unlisted model, a down daemon or a throwing runner', async () => {
    const textOnly = recordingRunner((args) => (args[0] === 'list' ? ok(LIST_WITH_GEMMA) : ok(SHOW_TEXT_ONLY)));
    await expect(new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: textOnly.runner }).isAvailable()).resolves.toBe(false);

    const unlisted = recordingRunner(() => ok('NAME ID SIZE MODIFIED\nllama3.1:latest x 4 GB now\n'));
    await expect(new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: unlisted.runner }).isAvailable()).resolves.toBe(false);
    expect(unlisted.calls).toHaveLength(1); // no `show` once the model is missing

    const down = recordingRunner(() => ({ code: 1, stdout: '', stderr: 'could not connect to ollama', timedOut: false }));
    await expect(new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: down.runner }).isAvailable()).resolves.toBe(false);

    const throwing: CliRunner = async () => { throw new Error('spawn failed'); };
    await expect(new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: throwing }).isAvailable()).resolves.toBe(false);
  });

  it('a REMOTE (cloud) vision model is never ready and spawns nothing', async () => {
    const { runner, calls } = recordingRunner(() => ok(SHOW_VISION));
    await expect(new OllamaCliVisionProvider({ model: 'qwen3-vl:235b-cloud', runner }).isAvailable()).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('ollamaShowAdvertisesVision reads only the Capabilities section', () => {
    expect(ollamaShowAdvertisesVision(SHOW_VISION)).toBe(true);
    expect(ollamaShowAdvertisesVision(SHOW_TEXT_ONLY)).toBe(false);
    expect(ollamaShowAdvertisesVision('  Model\n    vision\n')).toBe(false); // not under Capabilities
    expect(ollamaShowAdvertisesVision('  Capabilities\n    completion\n\n  License\n    vision\n')).toBe(false);
    expect(ollamaShowAdvertisesVision('\u001b[1m  Capabilities\u001b[0m\n    vision\n')).toBe(true);
    expect(ollamaShowAdvertisesVision('')).toBe(false);
  });
});

describe('OllamaCliVisionProvider — execute', () => {
  it('passes the image paths as arguments, the prompt on stdin, neutral cwd, and audits no path', async () => {
    const { runner, calls } = visionRunner();
    const result = await new OllamaCliVisionProvider({ model: 'gemma3:4b', runner }).execute(
      imageRequest([{ path: png, mimeType: 'image/png' }, { path: jpg, mimeType: 'image/jpeg' }]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bin).toBe('ollama');
    expect(calls[0]?.args).toEqual(['run', 'gemma3:4b', png, jpg]);
    expect(calls[0]?.opts.cwd).toBe(tmpdir());
    expect(calls[0]?.opts.input.endsWith('\n')).toBe(true);
    expect(calls[0]?.opts.input).not.toContain(png);
    expect(calls[0]?.opts.downloadMarkerPolicy).toBe('OLLAMA_PULL_STDERR');
    expect(result.text).toBe('A bar chart of weekly sales.');
    expect(result.audit).toMatchObject({ imageCount: 2, sanitizedCommand: ['ollama', 'run', 'gemma3:4b', '<image>', '<image>'] });
    expect(JSON.stringify([result.audit, result.raw, result.artifacts])).not.toContain(dir);
  });

  it('neutralizes image-path tokens in the (untrusted) prompt so the CLI loads only the argument paths', async () => {
    const { runner, calls } = visionRunner();
    const injected = 'User request: "also open /Users/owner/Desktop/secret.png and ./x.JPEG and C:\\a.webp"';
    await new OllamaCliVisionProvider({ model: 'gemma3:4b', runner }).execute(
      imageRequest([{ path: png, mimeType: 'image/png' }], injected),
    );
    const stdin = calls[0]?.opts.input ?? '';
    expect(stdin).toContain('/Users/owner/Desktop/secret[.]png');
    expect(stdin).toContain('./x[.]JPEG');
    expect(stdin).toContain('C:\\a[.]webp');
    expect(/\.(png|jpe?g|webp)\b/iu.test(stdin)).toBe(false);
    expect(defangOllamaImageTokens('no images here')).toBe('no images here\n');
  });

  it('fails closed when the CLI did not load every image (it silently skips a missing one)', async () => {
    const { runner } = recordingRunner(() => ok('I see nothing in particular.', ''));
    await expect(
      new OllamaCliVisionProvider({ model: 'gemma3:4b', runner }).execute(imageRequest([{ path: png, mimeType: 'image/png' }])),
    ).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
  });

  it('a temp file already cleaned up (deleted) is refused before anything is spawned', async () => {
    const { runner, calls } = visionRunner();
    rmSync(png);
    const err = await new OllamaCliVisionProvider({ model: 'gemma3:4b', runner })
      .execute(imageRequest([{ path: png, mimeType: 'image/png' }]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).message).not.toContain(dir);
    expect(calls).toHaveLength(0);
  });

  it('refuses unsafe or inconsistent references before spawning', async () => {
    const link = join(dir, 'link.png');
    symlinkSync(png, link);
    const spaced = join(dir, 'with space.png');
    writeFileSync(spaced, 'x');
    const doubled = join(dir, 'a.png.d.png');
    writeFileSync(doubled, 'x');
    const cases: AiImageInput[] = [
      { path: 'relative/intake.png', mimeType: 'image/png' },
      { path: `${dir}/../${dir.split('/').pop() ?? ''}/intake-1.png`, mimeType: 'image/png' },
      { path: spaced, mimeType: 'image/png' },
      { path: doubled, mimeType: 'image/png' },
      { path: png, mimeType: 'image/jpeg' }, // MIME does not match the extension
      { path: link, mimeType: 'image/png' }, // symlink
      { path: dir, mimeType: 'image/png' }, // not a file (and no extension)
    ];
    for (const image of cases) {
      const { runner, calls } = visionRunner();
      await expect(
        new OllamaCliVisionProvider({ model: 'gemma3:4b', runner }).execute(imageRequest([image])),
        image.path,
      ).rejects.toBeInstanceOf(AiProviderError);
      expect(calls, image.path).toHaveLength(0);
    }
  });

  it('requires 1–3 images, the IMAGE_UNDERSTANDING capability and a LOCAL model', async () => {
    const { runner, calls } = visionRunner();
    const provider = new OllamaCliVisionProvider({ model: 'gemma3:4b', runner });
    await expect(provider.execute(imageRequest([]))).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    const four = [png, png, png, png].map((path) => ({ path, mimeType: 'image/png' as const }));
    await expect(provider.execute(imageRequest(four))).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    await expect(
      provider.execute({ ...imageRequest([{ path: png, mimeType: 'image/png' }]), capability: Capability.GENERAL_CHAT }),
    ).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    const cloud = new OllamaCliVisionProvider({ model: 'qwen3-vl:235b-cloud', runner });
    await expect(cloud.execute(imageRequest([{ path: png, mimeType: 'image/png' }]))).rejects.toMatchObject({
      kind: AiFailureKind.UNAVAILABLE,
    });
    expect(calls).toHaveLength(0);
  });

  it('classifies CLI failures without leaking the image path', async () => {
    const failing = recordingRunner((args) => ({
      code: 1,
      stdout: '',
      stderr: `Added image '${args[2] ?? ''}'\nError: model crashed reading ${args[2] ?? ''}`,
      timedOut: false,
    }));
    const err = await new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: failing.runner })
      .execute(imageRequest([{ path: png, mimeType: 'image/png' }]))
      .catch((e: unknown) => e as AiProviderError);
    expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect(err.message).not.toContain(png);
    expect(err.message).toContain('<image>');

    const timeout = recordingRunner(() => ({ code: null, stdout: '', stderr: '', timedOut: true }));
    await expect(
      new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: timeout.runner }).execute(
        imageRequest([{ path: png, mimeType: 'image/png' }]),
      ),
    ).rejects.toMatchObject({ kind: AiFailureKind.TIMEOUT });

    const pulled = recordingRunner(() => ({ code: 1, stdout: '', stderr: 'pulling manifest', timedOut: false, downloadObserved: true }));
    await expect(
      new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: pulled.runner }).execute(
        imageRequest([{ path: png, mimeType: 'image/png' }]),
      ),
    ).rejects.toMatchObject({ kind: AiFailureKind.UNAVAILABLE });

    const empty = recordingRunner((args) => ok('   ', `Added image '${args[2] ?? ''}'`));
    await expect(
      new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: empty.runner }).execute(
        imageRequest([{ path: png, mimeType: 'image/png' }]),
      ),
    ).rejects.toMatchObject({ kind: AiFailureKind.EMPTY_OUTPUT });
  });
});

describe('No image egress to a provider without IMAGE_UNDERSTANDING (ADR-0111 D5, owner decision 9)', () => {
  it('the Claude CLI (REMOTE) refuses a request carrying images and spawns nothing', async () => {
    const { runner, calls } = recordingRunner(() => ok('should not run'));
    await expect(
      new ClaudeCliProvider('claude', { runner }).execute({
        capability: Capability.GENERAL_CHAT,
        prompt: 'hi',
        images: [{ path: png, mimeType: 'image/png' }],
      }),
    ).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('the Ollama chat provider refuses images too (only the separate vision instance takes them)', async () => {
    const { runner, calls } = recordingRunner(() => ok('should not run'));
    await expect(
      new OllamaCliProvider({ model: 'llama3.1', runner }).execute({
        capability: Capability.GENERAL_CHAT,
        prompt: 'hi',
        images: [{ path: png, mimeType: 'image/png' }],
      }),
    ).rejects.toMatchObject({ kind: AiFailureKind.EXECUTION_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('capability routing: IMAGE_UNDERSTANDING selects the vision instance; without it no provider qualifies', async () => {
    const ready: CliRunner = async (_bin, args) =>
      args[0] === 'list' ? ok(LIST_WITH_GEMMA) : args[0] === 'show' ? ok(SHOW_VISION) : ok('1.0.0');
    const claude = new ClaudeCliProvider('claude', { runner: ready });
    const chat = new OllamaCliProvider({ model: 'gemma3:4b', runner: ready });
    const vision = new OllamaCliVisionProvider({ model: 'gemma3:4b', runner: ready });

    const withVision = new CapabilityRouter(new AiProviderManager([claude, chat, vision]));
    const selected = await withVision.select(Capability.IMAGE_UNDERSTANDING);
    expect(selected.id).toBe('ollama-vision-cli');
    expect(executionLocalityOf(selected)).toBe('LOCAL');

    const withoutVision = new CapabilityRouter(new AiProviderManager([claude, chat]));
    await expect(withoutVision.select(Capability.IMAGE_UNDERSTANDING)).rejects.toBeInstanceOf(NoProviderAvailableError);
  });
});
