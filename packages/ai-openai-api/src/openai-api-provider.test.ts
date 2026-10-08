import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiFailureKind, AiProviderError, Capability, ProviderProbeIndeterminateError } from '@quoky/core';
import type { AiRequest } from '@quoky/core';
import {
  MAX_OPENAI_RESPONSE_BYTES,
  OPENAI_API_ORIGIN,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_MODEL_ALLOW_LIST,
  OPENAI_TRUNCATED_SUFFIX,
  OpenAiApiError,
  OpenAiApiKey,
  OpenAiApiProvider,
  OpenAiSharedProbe,
  OpenAiApiVisionProvider,
  OpenAiFailureCode,
  isAllowedOpenAiModel,
  isWellFormedOpenAiApiKey,
} from './index';

/**
 * ADR-0115 (PRV-1): the OpenAI API adapter over a FAKE fetch only — no test ever reaches the network. The fake key is
 * assembled at runtime from pieces so no token-shaped literal exists in the source.
 */

const FAKE_KEY = ['sk', 'quokytest', 'Q'.repeat(12) + 'z9'.repeat(8)].join('-');
const MODEL = 'gpt-4.1-mini';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type Responder = (call: Call) => Response | Promise<Response>;

function fakeFetch(responder: Responder): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function reply(text: string, extra: Record<string, unknown> = {}): Response {
  return json({
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
    ],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 150,
    },
    ...extra,
  });
}

/** A fetch that never answers until its signal aborts (then rejects like the platform fetch). */
function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException(`aborted ${String(_input)}`, 'AbortError')));
    })) as typeof fetch;
}

function chat(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiApiProvider>[0]> = {}): OpenAiApiProvider {
  return new OpenAiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fetchImpl, ...extra });
}

function vision(fetchImpl: typeof fetch): OpenAiApiVisionProvider {
  return new OpenAiApiVisionProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fetchImpl });
}

const CHAT_REQUEST: AiRequest = { capability: Capability.GENERAL_CHAT, prompt: 'Rendered prompt: say hello.' };

/** Every serialised trace of a thrown error (message, stack, own fields). */
function traces(err: unknown): string {
  const e = err as Error;
  return [String(e), e.message, e.stack ?? '', JSON.stringify(e), inspect(e, { depth: 5 })].join('\n');
}

async function failureOf(promise: Promise<unknown>): Promise<OpenAiApiError | AiProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AiProviderError);
    return err as AiProviderError;
  }
  throw new Error('expected a failure');
}

let dir: string | undefined;
afterEach(() => {
  vi.useRealTimers();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

function imageFile(name: string, bytes: Buffer): string {
  dir ??= mkdtempSync(join(tmpdir(), 'quoky-openai-test-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('configuration facts', () => {
  it('pins the endpoint and bounds the model allow-list; the key shape refuses whitespace, newlines and prefixes', () => {
    expect(OPENAI_API_ORIGIN).toBe('https://api.openai.com');
    expect(OPENAI_MODEL_ALLOW_LIST.length).toBeLessThanOrEqual(12);
    expect(isAllowedOpenAiModel(MODEL)).toBe(true);
    expect(isAllowedOpenAiModel('gpt-4.1-mini ')).toBe(false);
    expect(isAllowedOpenAiModel('o3')).toBe(false);
    expect(isWellFormedOpenAiApiKey(FAKE_KEY)).toBe(true);
    expect(isWellFormedOpenAiApiKey(`${FAKE_KEY}\n`)).toBe(false);
    expect(isWellFormedOpenAiApiKey(`Bearer ${FAKE_KEY}`)).toBe(false);
    expect(isWellFormedOpenAiApiKey(['sk', 'short'].join('-'))).toBe(false);
    expect(isWellFormedOpenAiApiKey(FAKE_KEY.replace('sk', 'pk'))).toBe(false);
  });

  it('construction refuses a malformed key or a model off the list without echoing either', () => {
    const badKey = `${FAKE_KEY} trailing`;
    for (const make of [
      () => new OpenAiApiProvider({ apiKey: badKey, model: MODEL }),
      () => new OpenAiApiVisionProvider({ apiKey: badKey, model: MODEL }),
    ]) {
      expect(make).toThrow('Invalid OpenAI API key');
      try {
        make();
      } catch (err) {
        expect(traces(err)).not.toContain(FAKE_KEY);
      }
    }
    expect(() => new OpenAiApiProvider({ apiKey: FAKE_KEY, model: 'gpt-secret-preview' })).toThrow(
      'OpenAI model is not on the allow-list',
    );
  });
});

describe('capabilities and locality (ADR-0115 D2, D5)', () => {
  it('the chat instance serves exactly the chat tier; the image instance only IMAGE_UNDERSTANDING; both REMOTE', () => {
    const { fetch } = fakeFetch(() => reply('x'));
    const c = chat(fetch);
    const v = vision(fetch);
    expect(c.id).toBe('openai-api');
    expect(v.id).toBe('openai-vision-api');
    expect(c.capabilities.map((d) => d.capability).sort()).toEqual(
      [Capability.GENERAL_CHAT, Capability.SUMMARIZATION, Capability.DOCUMENT_ANALYSIS, Capability.READONLY_LOOKUP].sort(),
    );
    expect(v.capabilities.map((d) => d.capability)).toEqual([Capability.IMAGE_UNDERSTANDING]);
    const never = [
      Capability.CODE_IMPLEMENTATION,
      Capability.CODE_REVIEW,
      Capability.TEST_EXECUTION,
      Capability.PROJECT_ANALYSIS,
      Capability.ARCHITECTURE_PLANNING,
      Capability.POLICY_SENSITIVE_CHAT,
      Capability.EMBEDDING,
    ];
    for (const provider of [c, v]) {
      expect(provider.executionLocality).toBe('REMOTE');
      for (const capability of never) expect(provider.capabilities.some((d) => d.capability === capability)).toBe(false);
    }
  });

  it('refuses another capability, a workspace, or an image on the chat instance BEFORE any request is sent', async () => {
    const fake = fakeFetch(() => reply('x'));
    const c = chat(fake.fetch);
    const v = vision(fake.fetch);
    const refusals = [
      c.execute({ capability: Capability.CODE_IMPLEMENTATION, prompt: 'p' }),
      c.execute({ capability: Capability.POLICY_SENSITIVE_CHAT, prompt: 'p' }),
      c.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p' }),
      c.execute({ ...CHAT_REQUEST, workspace: { root: '/tmp/x' } as unknown as AiRequest['workspace'] }),
      c.execute({ ...CHAT_REQUEST, images: [{ path: imageFile('a.png', PNG), mimeType: 'image/png' }] }),
      c.execute({ ...CHAT_REQUEST, contextFiles: [{ path: 'memory.md', content: 'remembered' }] as unknown as AiRequest['contextFiles'] }),
      v.execute({ capability: Capability.GENERAL_CHAT, prompt: 'p' }),
      v.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p' }),
    ];
    for (const refusal of refusals) {
      const err = await failureOf(refusal);
      expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
      expect(err.message).toContain('REQUEST_REFUSED');
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('request shape (ADR-0115 D5): no tool surface, store false, pinned host', () => {
  it('POSTs one Responses API call with only model, input, store and the output bound', async () => {
    const fake = fakeFetch(() => reply('Hello!'));
    const result = await chat(fake.fetch).execute(CHAT_REQUEST);
    expect(result.text).toBe('Hello!');
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.url).toBe('https://api.openai.com/v1/responses');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization', 'content-type']);
    const body = JSON.parse(String(call!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'max_output_tokens', 'model', 'store']);
    expect(body).toEqual({
      model: MODEL,
      input: [{ role: 'user', content: [{ type: 'input_text', text: CHAT_REQUEST.prompt }] }],
      store: false,
      max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    });
    const raw = String(call!.init.body);
    for (const forbidden of ['tools', 'functions', 'function_call', 'tool_choice', 'web_search', 'file_search', 'previous_response_id', 'conversation', 'background']) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  it('the image instance sends the prompt and only the canonical image bytes inline (no upload, no URL fetch)', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
    const fake = fakeFetch(() => reply('A cat on a sofa.'));
    const pngPath = imageFile('one.png', PNG);
    const jpgPath = imageFile('two.jpg', jpeg);
    const result = await vision(fake.fetch).execute({
      capability: Capability.IMAGE_UNDERSTANDING,
      prompt: 'Describe the image.',
      images: [
        { path: pngPath, mimeType: 'image/png' },
        { path: jpgPath, mimeType: 'image/jpeg' },
      ],
    });
    expect(result.text).toBe('A cat on a sofa.');
    const body = JSON.parse(String(fake.calls[0]!.init.body)) as { input: Array<{ content: unknown[] }>; store: boolean };
    expect(Object.keys(body).sort()).toEqual(['input', 'max_output_tokens', 'model', 'store']);
    expect(body.store).toBe(false);
    expect(body.input[0]!.content).toEqual([
      { type: 'input_text', text: 'Describe the image.' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG.toString('base64')}`, detail: 'auto' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'auto' },
    ]);
    // The audit carries counts and hashes, never the path or the bytes.
    const audit = JSON.stringify(result.audit);
    expect(result.audit).toMatchObject({ imageCount: 2, imageBytes: PNG.length + jpeg.length });
    expect(audit).not.toContain(pngPath);
    expect(audit).not.toContain(PNG.toString('base64'));
  });

  it('refuses a symlinked, mislabelled, duplicated or missing image and more than 3 images, before sending', async () => {
    const fake = fakeFetch(() => reply('x'));
    const v = vision(fake.fetch);
    const real = imageFile('real.png', PNG);
    const link = join(dir!, 'link.png');
    symlinkSync(real, link);
    const cases: AiRequest['images'][] = [
      [{ path: link, mimeType: 'image/png' }],
      [{ path: real, mimeType: 'image/jpeg' }],
      [{ path: imageFile('text.png', Buffer.from('not an image')), mimeType: 'image/png' }],
      [{ path: real, mimeType: 'image/png' }, { path: real, mimeType: 'image/png' }],
      [{ path: join(dir!, 'gone.png'), mimeType: 'image/png' }],
      [{ path: 'relative.png', mimeType: 'image/png' }],
      [1, 2, 3, 4].map((n) => ({ path: imageFile(`m${n}.png`, PNG), mimeType: 'image/png' as const })),
    ];
    for (const images of cases) {
      const err = await failureOf(v.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p', images }));
      expect(err.message).toContain('REQUEST_REFUSED');
      expect(err.message).not.toContain(dir!);
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('reply handling', () => {
  it('records usage counts and hashes in the audit; applies the injected hygiene; strips control characters', async () => {
    const fake = fakeFetch(() => reply('Hi\u001b[31m there\u0000!'));
    const seen: string[] = [];
    const result = await chat(fake.fetch, {
      replyHygiene: (text, request) => {
        seen.push(request.capability);
        return text.toUpperCase();
      },
    }).execute(CHAT_REQUEST);
    expect(result.text).toBe('HI[31M THERE!');
    expect(seen).toEqual([Capability.GENERAL_CHAT]);
    expect(result.audit).toMatchObject({
      model: MODEL,
      api: 'responses',
      executionLocality: 'REMOTE',
      store: false,
      toolDefinitionCount: 0,
      responseStatus: 'completed',
      outputItemCount: 2,
      messageItemCount: 1,
      reasoningItemCount: 1,
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 150,
    });
    expect(JSON.stringify(result.audit)).not.toContain(CHAT_REQUEST.prompt);
  });

  it('incomplete at the output bound: the text is returned, marked as cut off after hygiene, and audited', async () => {
    const fake = fakeFetch(() => reply('partial answer', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const incomplete = await chat(fake.fetch, { replyHygiene: (text) => text.toUpperCase() }).execute(CHAT_REQUEST);
    expect(incomplete.text).toBe(`PARTIAL ANSWER${OPENAI_TRUNCATED_SUFFIX}`);
    expect(OPENAI_TRUNCATED_SUFFIX).toBe('\n\n(답변이 길이 제한으로 잘렸어요.)');
    expect(incomplete.audit).toMatchObject({ responseStatus: 'incomplete', incompleteReason: 'max_output_tokens' });
    // Cut off before any text: still empty output, never a bare suffix.
    const empty = await failureOf(
      chat(fakeFetch(() => reply('  ', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).fetch).execute(CHAT_REQUEST),
    );
    expect((empty as OpenAiApiError).code).toBe(OpenAiFailureCode.EMPTY_OUTPUT);
  });

  it.each([
    ['content_filter', { reason: 'content_filter' }],
    ['an unknown reason', { reason: 'something_new' }],
    ['no details', undefined],
  ])('incomplete for %s fails closed (INCOMPLETE → EXECUTION_FAILED)', async (_name, details) => {
    const err = await failureOf(
      chat(fakeFetch(() => reply('filtered text', { status: 'incomplete', ...(details ? { incomplete_details: details } : {}) })).fetch).execute(CHAT_REQUEST),
    );
    expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect((err as OpenAiApiError).code).toBe(OpenAiFailureCode.INCOMPLETE);
    expect(traces(err)).not.toContain('filtered text');
  });

  it('a refusal part is the reply text', async () => {    const refusal = await chat(
      fakeFetch(() =>
        json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }] }),
      ).fetch,
    ).execute(CHAT_REQUEST);
    expect(refusal.text).toBe('I cannot help with that.');
    expect(refusal.audit).toMatchObject({ refusalCount: 1 });
  });
});

describe('failure taxonomy (ADR-0115 D7 / ADR-0092 amendment D5): fixed codes, never a body', () => {
  const ECHO = `Incorrect API key provided: ${FAKE_KEY}. SECRET-BODY-TEXT`;
  const cases: Array<[string, () => Response | Promise<Response>, AiFailureKind, OpenAiFailureCode]> = [
    ['401', () => json({ error: { message: ECHO } }, 401), AiFailureKind.AUTH_REQUIRED, OpenAiFailureCode.AUTH],
    ['403', () => json({ error: { message: ECHO } }, 403), AiFailureKind.AUTH_REQUIRED, OpenAiFailureCode.AUTH],
    ['429', () => json({ error: { message: ECHO, code: 'insufficient_quota' } }, 429), AiFailureKind.UNAVAILABLE, OpenAiFailureCode.RATE_LIMITED],
    ['500', () => json({ error: { message: ECHO } }, 500), AiFailureKind.UNAVAILABLE, OpenAiFailureCode.UNAVAILABLE],
    ['503', () => new Response(ECHO, { status: 503 }), AiFailureKind.UNAVAILABLE, OpenAiFailureCode.UNAVAILABLE],
    ['404', () => json({ error: { message: ECHO } }, 404), AiFailureKind.UNAVAILABLE, OpenAiFailureCode.UNAVAILABLE],
    ['400', () => json({ error: { message: ECHO } }, 400), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.BAD_REQUEST],
    ['network', () => Promise.reject(new TypeError(`fetch failed ${FAKE_KEY} SECRET-BODY-TEXT`)), AiFailureKind.UNAVAILABLE, OpenAiFailureCode.UNAVAILABLE],
    ['status failed', () => json({ status: 'failed', error: { message: ECHO }, output: [] }), AiFailureKind.UNAVAILABLE, OpenAiFailureCode.UNAVAILABLE],
    ['empty text', () => reply('   \n '), AiFailureKind.EMPTY_OUTPUT, OpenAiFailureCode.EMPTY_OUTPUT],
    ['no message', () => json({ status: 'completed', output: [{ type: 'reasoning' }] }), AiFailureKind.EMPTY_OUTPUT, OpenAiFailureCode.EMPTY_OUTPUT],
    ['function call', () => json({ status: 'completed', output: [{ type: 'function_call', name: 'x', arguments: ECHO }] }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.TOOL_CALL_REFUSED],
    ['web search', () => json({ status: 'completed', output: [{ type: 'web_search_call' }] }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.TOOL_CALL_REFUSED],
    ['tool call mixed with text', () =>
      json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }, { type: 'mcp_call' }] }),
      AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.TOOL_CALL_REFUSED],
    ['unknown item', () => json({ status: 'completed', output: [{ type: 'mystery' }] }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.MALFORMED_RESPONSE],
    ['unknown part', () => json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'audio' }] }] }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.MALFORMED_RESPONSE],
    ['not JSON', () => new Response(`<html>${ECHO}</html>`, { status: 200 }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.MALFORMED_RESPONSE],
    ['background', () => json({ status: 'in_progress', output: [] }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.MALFORMED_RESPONSE],
    ['declared too large', () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_OPENAI_RESPONSE_BYTES + 1) } }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.RESPONSE_TOO_LARGE],
    ['streamed too large', () => new Response(`"${'x'.repeat(MAX_OPENAI_RESPONSE_BYTES + 10)}"`, { status: 200 }), AiFailureKind.EXECUTION_FAILED, OpenAiFailureCode.RESPONSE_TOO_LARGE],
    ['redirected elsewhere', () => {
      const response = reply('hijacked');
      Object.defineProperty(response, 'url', { value: 'https://evil.example/v1/responses' });
      return response;
    }, AiFailureKind.UNAVAILABLE, OpenAiFailureCode.UNAVAILABLE],
  ];

  for (const [name, respond, kind, code] of cases) {
    it(`${name} → ${kind} / ${code}`, async () => {
      const err = await failureOf(chat(fakeFetch(respond).fetch).execute(CHAT_REQUEST));
      expect(err).toBeInstanceOf(OpenAiApiError);
      expect(err.kind).toBe(kind);
      expect((err as OpenAiApiError).code).toBe(code);
      const trace = traces(err);
      expect(trace).not.toContain(FAKE_KEY);
      expect(trace).not.toContain('SECRET-BODY-TEXT');
      expect(trace).not.toContain('Incorrect API key');
      expect(trace).not.toContain(CHAT_REQUEST.prompt);
      expect(trace).not.toContain('api.openai.com');
    });
  }

  it('a call that never answers is a TIMEOUT within its bound (headers)', async () => {
    vi.useFakeTimers();
    const pending = failureOf(chat(hangingFetch()).execute({ ...CHAT_REQUEST, timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    const err = await pending;
    expect(err.kind).toBe(AiFailureKind.TIMEOUT);
    expect((err as OpenAiApiError).code).toBe(OpenAiFailureCode.TIMEOUT);
    expect(traces(err)).not.toContain(FAKE_KEY);
  });

  it('a body that stalls after the headers is a TIMEOUT too (one timer bounds headers and body)', async () => {
    vi.useFakeTimers();
    const stalled = (async (_input: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const pending = failureOf(chat(stalled).execute({ ...CHAT_REQUEST, timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).kind).toBe(AiFailureKind.TIMEOUT);
  });
});

describe('readiness (ADR-0115 D7): one bounded model-get, no generation', () => {
  it('GETs /v1/models/<model> with no body; ready only for a 200 naming that model', async () => {
    const fake = fakeFetch(() => json({ id: MODEL, object: 'model', owned_by: 'openai' }));
    expect(await chat(fake.fetch).isAvailable()).toBe(true);
    expect(await vision(fake.fetch).isAvailable()).toBe(true);
    for (const call of fake.calls) {
      expect(call.url).toBe(`https://api.openai.com/v1/models/${MODEL}`);
      expect(call.init.method).toBe('GET');
      expect(call.init.body).toBeUndefined();
      expect(call.init.redirect).toBe('error');
      expect(call.url).not.toContain('/responses');
    }
    expect(await chat(fakeFetch(() => json({ id: 'gpt-4o' })).fetch).isAvailable()).toBe(false);
  });

  it('auth, rate limit, server errors and network errors are "not ready"; a timeout is indeterminate', async () => {
    for (const respond of [
      () => json({ error: { message: FAKE_KEY } }, 401),
      () => json({}, 429),
      () => json({}, 503),
      () => json({}, 404),
      () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      expect(await chat(fakeFetch(respond).fetch).isAvailable()).toBe(false);
    }
    vi.useFakeTimers();
    const pending = chat(hangingFetch()).isAvailable().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;
    expect(err).toBeInstanceOf(ProviderProbeIndeterminateError);
    expect(traces(err)).not.toContain(FAKE_KEY);
  });
});

describe('shared readiness (one model-get for the chat and image instances)', () => {
  it('two instances on one shared probe make one call; a timed-out probe is not cached', async () => {
    const fake = fakeFetch(() => json({ id: MODEL }));
    const shared = new OpenAiSharedProbe();
    const c = new OpenAiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    const v = new OpenAiApiVisionProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    expect(await Promise.all([c.isAvailable(), v.isAvailable()])).toEqual([true, true]);
    expect(await v.isAvailable()).toBe(true);
    expect(fake.calls).toHaveLength(1);

    let now = 0;
    const expiring = new OpenAiSharedProbe(1000, () => now);
    let calls = 0;
    const probe = async () => {
      calls += 1;
      if (calls === 1) throw new ProviderProbeIndeterminateError('timed out');
      return false;
    };
    await expect(expiring.run(probe)).rejects.toBeInstanceOf(ProviderProbeIndeterminateError);
    expect(await expiring.run(probe)).toBe(false);
    expect(await expiring.run(probe)).toBe(false);
    now = 1000;
    expect(await expiring.run(probe)).toBe(false);
    expect(calls).toBe(3);
  });
});

describe('key redaction (ADR-0115 D6)', () => {
  it('the OpenAiApiKey holder never shows the key to JSON, inspect, spread or string conversion', async () => {
    const holder = OpenAiApiKey.from(FAKE_KEY);
    if (holder === null) throw new Error('unreachable');
    expect(OpenAiApiKey.from(`${FAKE_KEY} `)).toBeNull();
    const wrapped = { ai: { openai: { apiKey: holder, model: MODEL } } };
    for (const view of [JSON.stringify(wrapped), inspect(wrapped, { depth: 10, showHidden: true }), String(holder), `${holder}`, JSON.stringify({ ...holder })]) {
      expect(view).not.toContain(FAKE_KEY);
    }
    expect(JSON.stringify(wrapped)).toContain('[REDACTED]');
    // The adapter accepts the holder and sends the real key in the header only.
    const fake = fakeFetch(() => reply('ok'));
    await new OpenAiApiProvider({ apiKey: holder, model: MODEL, fetch: fake.fetch }).execute(CHAT_REQUEST);
    expect((fake.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('the key is never in the result, the audit, the raw facts, or a serialisation of the provider', async () => {
    const fake = fakeFetch(() => reply(`echo ${FAKE_KEY} done`));
    const provider = chat(fake.fetch);
    const result = await provider.execute(CHAT_REQUEST);
    expect(result.text).toBe('echo [redacted] done');
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    for (const p of [provider, vision(fake.fetch)]) {
      expect(JSON.stringify(p)).not.toContain(FAKE_KEY);
      expect(inspect(p, { depth: 10, showHidden: true })).not.toContain(FAKE_KEY);
      expect(Object.values(p).map(String).join('\n')).not.toContain(FAKE_KEY);
    }
  });

  it('the key is sent only in the Authorization header to the pinned host, never in the URL or the body', async () => {
    const fake = fakeFetch((call) => (call.url.includes('/models/') ? json({ id: MODEL }) : reply('ok')));
    const provider = chat(fake.fetch);
    await provider.isAvailable();
    await provider.execute(CHAT_REQUEST);
    for (const call of fake.calls) {
      expect(new URL(call.url).origin).toBe(OPENAI_API_ORIGIN);
      expect(call.url).not.toContain(FAKE_KEY);
      expect(String(call.init.body ?? '')).not.toContain(FAKE_KEY);
    }
  });
});
