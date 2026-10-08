import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  AiFailureKind,
  AiProviderError,
  Capability,
  embeddingRequestMetadata,
  parseEmbeddingEnvelope,
} from '@quoky/core';
import type { AiRequest } from '@quoky/core';
import type { CliRunOptions, CliRunResult, CliRunner } from './cli-runner';
import {
  DEFAULT_OLLAMA_EMBEDDING_KEEP_ALIVE,
  MAX_EMBEDDING_INPUT_CHARS,
  OLLAMA_COLOR_ENV,
  OLLAMA_EMBEDDING_WARM_UP_MIN_INTERVAL_MS,
  OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS,
  OllamaCliEmbeddingProvider,
} from './ollama-embedding-provider';
import type { OllamaCliEmbeddingProviderOptions } from './ollama-embedding-provider';

interface Call {
  bin: string;
  args: string[];
  options: CliRunOptions;
}

const OK_VECTOR = '[0.25, -0.5, 1e-3, 0]';

function recordingRunner(result: Partial<CliRunResult> = {}): { runner: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CliRunner = async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { code: 0, stdout: OK_VECTOR, stderr: '', timedOut: false, ...result };
  };
  return { runner, calls };
}

function provider(result: Partial<CliRunResult> = {}, options: OllamaCliEmbeddingProviderOptions = {}) {
  const { runner, calls } = recordingRunner(result);
  return { embedder: new OllamaCliEmbeddingProvider({ runner, ...options }), calls };
}

function embeddingRequest(prompt = '우리 집 고양이 이름은 나비야', role: 'query' | 'document' = 'document'): AiRequest {
  return { capability: Capability.EMBEDDING, prompt, metadata: { ...embeddingRequestMetadata(role) } };
}

async function failureOf(promise: Promise<unknown>): Promise<AiProviderError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AiProviderError);
  return error as AiProviderError;
}

describe('OllamaCliEmbeddingProvider (ADR-0098 D8)', () => {
  it('advertises only EMBEDDING under its own provider id', () => {
    const embedder = new OllamaCliEmbeddingProvider();
    expect(embedder.id).toBe('ollama-embed-cli');
    expect(embedder.capabilities).toEqual([{ capability: Capability.EMBEDDING, priority: 100 }]);
  });

  it('runs `ollama run --keepalive 30m <model>` with the text on stdin in the default runner profile, like chat', async () => {
    const { embedder, calls } = provider({}, { bin: '/opt/ollama', timeoutMs: 1234 });
    await embedder.execute(embeddingRequest());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.bin).toBe('/opt/ollama');
    expect(call?.args).toEqual(['run', '--keepalive', DEFAULT_OLLAMA_EMBEDDING_KEEP_ALIVE, 'nomic-embed-text']);
    expect(DEFAULT_OLLAMA_EMBEDDING_KEEP_ALIVE).toBe('30m');
    expect(call?.options.cwd).toBe(tmpdir());
    expect(call?.options.timeoutMs).toBe(1234);
    // Exactly the chat colour variables: no OLLAMA_HOST / OLLAMA_NO_CLOUD and no validation profile.
    expect(call?.options.env).toEqual(OLLAMA_COLOR_ENV);
    expect(call?.options.env).not.toHaveProperty('OLLAMA_HOST');
    expect(call?.options.env).not.toHaveProperty('OLLAMA_NO_CLOUD');
    expect(call?.options.environmentProfile).toBeUndefined();
    expect(call?.options.downloadMarkerPolicy).toBe('OLLAMA_PULL_STDERR');
    // The text never becomes an argv entry.
    expect(call?.args.join(' ')).not.toContain('고양이');
  });

  it('returns the canonical Core envelope for a JSON vector on stdout', async () => {
    const { embedder } = provider({ stdout: `\n${OK_VECTOR}\n` });
    const result = await embedder.execute(embeddingRequest());
    expect(parseEmbeddingEnvelope(result.text)).toEqual({
      schema: 'quoky.embedding.v1',
      space: 'nomic-embed-text',
      dimensions: 4,
      vector: [0.25, -0.5, 0.001, 0],
    });
    expect(result.audit).toMatchObject({ model: 'nomic-embed-text', dimensions: 4 });
  });

  it('applies the nomic role prefixes and a request timeout', async () => {
    const { embedder, calls } = provider();
    await embedder.execute({ ...embeddingRequest('반려동물', 'query'), timeoutMs: 700 });
    await embedder.execute(embeddingRequest('고양이', 'document'));
    await embedder.execute({ capability: Capability.EMBEDDING, prompt: '역할 없음' });
    expect(calls.map((call) => call.options.input)).toEqual([
      'search_query: 반려동물',
      'search_document: 고양이',
      '역할 없음',
    ]);
    expect(calls[0]?.options.timeoutMs).toBe(700);
    expect(calls[1]?.options.timeoutMs).toBe(3000);
  });

  it('adds no prefix for other models unless configured', async () => {
    const plain = provider({}, { model: 'mxbai-embed-large:latest' });
    await plain.embedder.execute(embeddingRequest('text', 'query'));
    expect(plain.calls[0]?.options.input).toBe('text');
    expect(plain.calls[0]?.args).toEqual(['run', '--keepalive', '30m', 'mxbai-embed-large:latest']);

    const custom = provider({}, { model: 'other-embed', rolePrefixes: { query: 'Q: ', document: 'D: ' } });
    await custom.embedder.execute(embeddingRequest('text', 'document'));
    expect(custom.calls[0]?.options.input).toBe('D: text');
  });

  it('bounds the input to MAX_EMBEDDING_INPUT_CHARS without splitting a surrogate pair', async () => {
    const { embedder, calls } = provider();
    await embedder.execute({ capability: Capability.EMBEDDING, prompt: 'a'.repeat(MAX_EMBEDDING_INPUT_CHARS + 50) });
    expect(calls[0]?.options.input).toHaveLength(MAX_EMBEDDING_INPUT_CHARS);

    const emoji = '😀';
    await embedder.execute({
      capability: Capability.EMBEDDING,
      prompt: `${'a'.repeat(MAX_EMBEDDING_INPUT_CHARS - 1)}${emoji}`,
    });
    expect(calls[1]?.options.input).toBe('a'.repeat(MAX_EMBEDDING_INPUT_CHARS - 1));
  });

  it('fails the run UNAVAILABLE when a model download is observed (it never pulls)', async () => {
    const { embedder } = provider({ code: null, stdout: '', downloadObserved: true });
    const error = await failureOf(embedder.execute(embeddingRequest()));
    expect(error.kind).toBe(AiFailureKind.UNAVAILABLE);
    expect(error.message).toMatch(/not installed locally/);
  });

  it.each([
    ['a text answer', 'The capital of France is Paris.'],
    ['a non-finite value', '[1, NaN, 2]'],
    ['a nested array', '[[0.1, 0.2]]'],
    ['an object', '{"embedding":[0.1]}'],
    ['a string entry', '["0.1"]'],
    ['an empty array', '[]'],
    ['too many dimensions', JSON.stringify(new Array(8193).fill(0.1))],
  ])('fails EXECUTION_FAILED on %s without echoing the output', async (_label, stdout) => {
    const { embedder } = provider({ stdout });
    const error = await failureOf(embedder.execute(embeddingRequest()));
    expect(error.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect(error.message).not.toContain('Paris');
  });

  it('fails EMPTY_OUTPUT on empty stdout', async () => {
    const { embedder } = provider({ stdout: '  \n' });
    expect((await failureOf(embedder.execute(embeddingRequest()))).kind).toBe(AiFailureKind.EMPTY_OUTPUT);
  });

  it.each([
    [{ timedOut: true, code: null }, AiFailureKind.TIMEOUT],
    [{ code: null, stderr: 'Refused a provider environment variable that is not allow-listed.' }, AiFailureKind.UNAVAILABLE],
    [{ code: 1, stderr: 'Error: could not connect to ollama app, is it running?' }, AiFailureKind.UNAVAILABLE],
    // macOS CLI after it tried to start an Ollama app that is not running (~5 s; measured 2026-10-08)
    [{ code: 1, stderr: 'Error: timed out waiting for server to start' }, AiFailureKind.UNAVAILABLE],
    [{ code: 1, stderr: 'Error: model "nomic-embed-text" not found' }, AiFailureKind.EXECUTION_FAILED],
  ] as const)('classifies a failed run %j as %s', async (result, kind) => {
    const { embedder } = provider({ stdout: '', ...result });
    expect((await failureOf(embedder.execute(embeddingRequest()))).kind).toBe(kind);
  });

  it('refuses a non-EMBEDDING capability or empty input without spawning', async () => {
    const { embedder, calls } = provider();
    expect(
      (await failureOf(embedder.execute({ capability: Capability.GENERAL_CHAT, prompt: 'hi' }))).kind,
    ).toBe(AiFailureKind.EXECUTION_FAILED);
    expect((await failureOf(embedder.execute(embeddingRequest('   ')))).kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect(calls).toHaveLength(0);
  });

  it.each(['-rf', 'nomic embed', 'nomic-embed-text:cloud', 'gpt-oss-cloud', ''])(
    'refuses the model name %j at construction',
    (model) => {
      expect(() => new OllamaCliEmbeddingProvider({ model })).toThrow(TypeError);
    },
  );

  describe('isAvailable', () => {
    const LIST = 'NAME ID SIZE MODIFIED\nnomic-embed-text:latest abc 274 MB now\nllama3.1:latest def 4.7 GB now\n';

    it('is ready only when the daemon lists the embedding model, probing with the chat colour env', async () => {
      const { embedder, calls } = provider({ stdout: LIST });
      expect(await embedder.isAvailable()).toBe(true);
      expect(calls[0]?.args).toEqual(['list']);
      expect(calls[0]?.options.env).toEqual(OLLAMA_COLOR_ENV);
      expect(calls[0]?.options.environmentProfile).toBeUndefined();
      expect(calls[0]?.options.input).toBe('');
    });

    it('is unavailable when the model is not installed, the daemon is down or the probe throws', async () => {
      expect(await provider({ stdout: 'NAME ID SIZE MODIFIED\nllama3.1:latest def 4.7 GB now\n' }).embedder.isAvailable()).toBe(
        false,
      );
      expect(await provider({ code: 1, stdout: '' }).embedder.isAvailable()).toBe(false);
      expect(await provider({ stdout: LIST, timedOut: true }).embedder.isAvailable()).toBe(false);
      const throwing = new OllamaCliEmbeddingProvider({
        runner: async () => {
          throw new Error('spawn failed');
        },
      });
      expect(await throwing.isAvailable()).toBe(false);
    });
  });
  it.each(['5m', '90s', '2h', '500ms', '-1', '0'])('accepts the keep-alive %j', async (keepAlive) => {
    const { embedder, calls } = provider({}, { keepAlive });
    await embedder.execute(embeddingRequest());
    expect(calls[0]?.args).toEqual(['run', '--keepalive', keepAlive, 'nomic-embed-text']);
  });

  it.each(['', '5', '-5m', '--verbose', '5 m', '1d', '10000000s'])('refuses the keep-alive %j at construction', (keepAlive) => {
    expect(() => new OllamaCliEmbeddingProvider({ keepAlive })).toThrow(TypeError);
  });

  describe('background warm-up (first-call allowance)', () => {
    const LIST = 'NAME ID SIZE MODIFIED\nnomic-embed-text:latest abc 274 MB now\n';

    /** `list` answers per `daemon.up`; `run` answers a vector, or times out while `daemon.loading`. */
    function daemonRunner() {
      const daemon = { up: true, loading: false };
      const calls: Call[] = [];
      const runner: CliRunner = async (bin, args, options) => {
        calls.push({ bin, args, options });
        if (args[0] === 'list') {
          return daemon.up
            ? { code: 0, stdout: LIST, stderr: '', timedOut: false }
            : { code: 1, stdout: '', stderr: 'Error: timed out waiting for server to start', timedOut: false };
        }
        if (daemon.loading) return { code: null, stdout: '', stderr: '', timedOut: true };
        return { code: 0, stdout: OK_VECTOR, stderr: '', timedOut: false };
      };
      return { daemon, calls, runner };
    }

    function manualClock(startMs = Date.parse('2026-10-08T00:00:00.000Z')) {
      let ms = startMs;
      return { clock: () => new Date(ms).toISOString(), advance: (by: number) => { ms += by; } };
    }

    const runs = (calls: readonly Call[]) => calls.filter((call) => call.args[0] === 'run');

    it('loads the model once with the fixed warm-up text when the first probe is ready', async () => {
      const { calls, runner } = daemonRunner();
      const embedder = new OllamaCliEmbeddingProvider({ runner });

      expect(await embedder.isAvailable()).toBe(true);
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(1);
      const [warmUp] = runs(calls);
      expect(warmUp?.args).toEqual(['run', '--keepalive', '30m', 'nomic-embed-text']);
      expect(warmUp?.options.input).toBe('search_query: warm-up');
      expect(warmUp?.options.timeoutMs).toBe(OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS);
      expect(warmUp?.options.env).toEqual(OLLAMA_COLOR_ENV);
      expect(warmUp?.options.downloadMarkerPolicy).toBe('OLLAMA_PULL_STDERR');

      // Staying ready does not warm up again (the keep-alive keeps the model loaded).
      expect(await embedder.isAvailable()).toBe(true);
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(1);
    });

    it('warms up again when the daemon comes back after a not-ready probe, and never while it is down', async () => {
      const { daemon, calls, runner } = daemonRunner();
      daemon.up = false;
      const embedder = new OllamaCliEmbeddingProvider({ runner });

      expect(await embedder.isAvailable()).toBe(false);
      expect(await embedder.isAvailable()).toBe(false);
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(0);

      daemon.up = true;
      expect(await embedder.isAvailable()).toBe(true);
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(1);
    });

    it('after a timed-out call starts one background load with the long bound, spaced by the minimum interval', async () => {
      const { daemon, calls, runner } = daemonRunner();
      const time = manualClock();
      const embedder = new OllamaCliEmbeddingProvider({ runner, clock: time.clock, warmUp: true });
      daemon.loading = true;

      const first = await failureOf(embedder.execute({ ...embeddingRequest('q', 'query'), timeoutMs: 2_000 }));
      expect(first.kind).toBe(AiFailureKind.TIMEOUT);
      await embedder.warmUpSettled();
      // the call itself (2 s, steady-state bound unchanged) + one warm-up (30 s allowance)
      expect(runs(calls).map((call) => call.options.timeoutMs)).toEqual([2_000, OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS]);

      time.advance(OLLAMA_EMBEDDING_WARM_UP_MIN_INTERVAL_MS - 1);
      await failureOf(embedder.execute(embeddingRequest('q', 'query')));
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(3); // throttled: no second warm-up yet

      time.advance(1);
      await failureOf(embedder.execute(embeddingRequest('q', 'query')));
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(5);

      // Once loaded, calls succeed at the steady-state bound and start nothing else.
      daemon.loading = false;
      await embedder.execute(embeddingRequest('q', 'query'));
      await embedder.warmUpSettled();
      expect(runs(calls)).toHaveLength(6);
      expect(runs(calls)[5]?.options.timeoutMs).toBe(3_000);
    });

    it('keeps a single warm-up in flight', async () => {
      let release: () => void = () => undefined;
      const calls: Call[] = [];
      const runner: CliRunner = async (bin, args, options) => {
        calls.push({ bin, args, options });
        if (args[0] === 'list') return { code: 0, stdout: LIST, stderr: '', timedOut: false };
        if (options.timeoutMs === OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS) {
          await new Promise<void>((resolve) => { release = resolve; });
          return { code: 0, stdout: OK_VECTOR, stderr: '', timedOut: false };
        }
        return { code: null, stdout: '', stderr: '', timedOut: true };
      };
      const embedder = new OllamaCliEmbeddingProvider({ runner });
      await embedder.isAvailable(); // starts the warm-up, which stays in flight
      await failureOf(embedder.execute(embeddingRequest()));
      await failureOf(embedder.execute(embeddingRequest()));
      expect(calls.filter((call) => call.options.timeoutMs === OLLAMA_EMBEDDING_WARM_UP_TIMEOUT_MS)).toHaveLength(1);
      release();
      await embedder.warmUpSettled();
    });

    it('never warms up when disabled, and a failing warm-up is ignored', async () => {
      const { calls, runner } = daemonRunner();
      const disabled = new OllamaCliEmbeddingProvider({ runner, warmUp: false });
      expect(await disabled.isAvailable()).toBe(true);
      await disabled.warmUpSettled();
      expect(runs(calls)).toHaveLength(0);

      const throwing = new OllamaCliEmbeddingProvider({
        runner: async (_bin, args) => {
          if (args[0] === 'list') return { code: 0, stdout: LIST, stderr: '', timedOut: false };
          throw new Error('spawn failed');
        },
      });
      expect(await throwing.isAvailable()).toBe(true);
      await expect(throwing.warmUpSettled()).resolves.toBeUndefined();
    });
  });
});
