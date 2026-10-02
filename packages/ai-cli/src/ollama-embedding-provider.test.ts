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
  MAX_EMBEDDING_INPUT_CHARS,
  OLLAMA_COLOR_ENV,
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

  it('runs `ollama run <model>` with the text on stdin in the default runner profile, like chat', async () => {
    const { embedder, calls } = provider({}, { bin: '/opt/ollama', timeoutMs: 1234 });
    await embedder.execute(embeddingRequest());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.bin).toBe('/opt/ollama');
    expect(call?.args).toEqual(['run', 'nomic-embed-text']);
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
    expect(plain.calls[0]?.args).toEqual(['run', 'mxbai-embed-large:latest']);

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
});
