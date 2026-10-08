import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiFailureKind, AiProviderError, Capability, ProviderProbeIndeterminateError } from '@quoky/core';
import type { AiRequest } from '@quoky/core';
import {
  GEMINI_API_ORIGIN,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MODEL_ALLOW_LIST,
  GEMINI_TRUNCATED_SUFFIX,
  GeminiApiError,
  GeminiApiKey,
  GeminiApiProvider,
  GeminiApiVisionProvider,
  GeminiFailureCode,
  GeminiSharedProbe,
  MAX_GEMINI_RESPONSE_BYTES,
  MAX_GEMINI_VISION_IMAGE_BYTES,
  isAllowedGeminiModel,
  isWellFormedGeminiApiKey,
} from './index';

/**
 * ADR-0115 D4 (PRV-2): the Gemini API adapter over a FAKE fetch only — no test ever reaches the network. The fake key is
 * assembled at runtime from pieces so no token-shaped literal exists in the source.
 */

const FAKE_KEY = ['AI', 'za', 'Q'.repeat(10), 'z9'.repeat(12), 'x'].join('');
const MODEL = 'gemini-3.5-flash-lite';
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;

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

/** A `generateContent` answer with one candidate. */
/** `finishReason: null` leaves the field out. */
function candidate(parts: unknown[], finishReason: string | null = 'STOP', extra: Record<string, unknown> = {}): Response {
  return json({
    candidates: [{ content: { role: 'model', parts }, ...(finishReason !== null ? { finishReason } : {}), index: 0, ...extra }],
    usageMetadata: {
      promptTokenCount: 120,
      cachedContentTokenCount: 20,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 10,
      totalTokenCount: 160,
    },
    modelVersion: MODEL,
    responseId: 'resp-test',
  });
}

function reply(text: string, finishReason: string | null = 'STOP'): Response {
  return candidate([{ text }], finishReason);
}

/** A fetch that never answers until its signal aborts (then rejects like the platform fetch). */
function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException(`aborted ${String(_input)}`, 'AbortError')));
    })) as typeof fetch;
}

function chat(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof GeminiApiProvider>[0]> = {}): GeminiApiProvider {
  return new GeminiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fetchImpl, ...extra });
}

function vision(fetchImpl: typeof fetch): GeminiApiVisionProvider {
  return new GeminiApiVisionProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fetchImpl });
}

const CHAT_REQUEST: AiRequest = { capability: Capability.GENERAL_CHAT, prompt: 'Rendered prompt: say hello.' };

/** Every serialised trace of a thrown error (message, stack, own fields). */
function traces(err: unknown): string {
  const e = err as Error;
  return [String(e), e.message, e.stack ?? '', JSON.stringify(e), inspect(e, { depth: 5 })].join('\n');
}

async function failureOf(promise: Promise<unknown>): Promise<GeminiApiError | AiProviderError> {
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
  dir ??= mkdtempSync(join(tmpdir(), 'quoky-gemini-test-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('configuration facts', () => {
  it('pins the endpoint and bounds the model allow-list; the key shape refuses whitespace, newlines and prefixes', () => {
    expect(GEMINI_API_ORIGIN).toBe('https://generativelanguage.googleapis.com');
    expect(GEMINI_MODEL_ALLOW_LIST.length).toBeLessThanOrEqual(12);
    expect(GEMINI_MODEL_ALLOW_LIST.every((model) => model.startsWith('gemini-'))).toBe(true);
    expect(isAllowedGeminiModel(MODEL)).toBe(true);
    expect(isAllowedGeminiModel(`${MODEL} `)).toBe(false);
    expect(isAllowedGeminiModel('gemini-2.0-flash')).toBe(false);
    expect(isAllowedGeminiModel('models/gemini-3.5-flash')).toBe(false);
    expect(FAKE_KEY).toHaveLength(39);
    expect(isWellFormedGeminiApiKey(FAKE_KEY)).toBe(true);
    expect(isWellFormedGeminiApiKey(`${FAKE_KEY}\n`)).toBe(false);
    expect(isWellFormedGeminiApiKey(`key=${FAKE_KEY}`)).toBe(false);
    expect(isWellFormedGeminiApiKey(`${FAKE_KEY}x`)).toBe(false);
    expect(isWellFormedGeminiApiKey(FAKE_KEY.slice(0, 30))).toBe(false);
    expect(isWellFormedGeminiApiKey(FAKE_KEY.replace('AIza', 'AIzb'))).toBe(false);
  });

  it('construction refuses a malformed key or a model off the list without echoing either', () => {
    const badKey = `${FAKE_KEY} trailing`;
    for (const make of [
      () => new GeminiApiProvider({ apiKey: badKey, model: MODEL }),
      () => new GeminiApiVisionProvider({ apiKey: badKey, model: MODEL }),
    ]) {
      expect(make).toThrow('Invalid Gemini API key');
      try {
        make();
      } catch (err) {
        expect(traces(err)).not.toContain(FAKE_KEY);
      }
    }
    expect(() => new GeminiApiProvider({ apiKey: FAKE_KEY, model: 'gemini-secret-preview' })).toThrow(
      'Gemini model is not on the allow-list',
    );
  });
});

describe('capabilities and locality (ADR-0115 D2, D5)', () => {
  it('the chat instance serves exactly the chat tier; the image instance only IMAGE_UNDERSTANDING; both REMOTE', () => {
    const { fetch } = fakeFetch(() => reply('x'));
    const c = chat(fetch);
    const v = vision(fetch);
    expect(c.id).toBe('gemini-api');
    expect(v.id).toBe('gemini-vision-api');
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

  it('refuses another capability, a workspace, a context file, or an image on the chat instance BEFORE sending', async () => {
    const fake = fakeFetch(() => reply('x'));
    const c = chat(fake.fetch);
    const v = vision(fake.fetch);
    const contextFiles = [{ path: 'memory.md', content: 'remembered' }] as unknown as AiRequest['contextFiles'];
    const refusals = [
      c.execute({ capability: Capability.CODE_IMPLEMENTATION, prompt: 'p' }),
      c.execute({ capability: Capability.POLICY_SENSITIVE_CHAT, prompt: 'p' }),
      c.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p' }),
      c.execute({ ...CHAT_REQUEST, workspace: { root: '/tmp/x' } as unknown as AiRequest['workspace'] }),
      c.execute({ ...CHAT_REQUEST, images: [{ path: imageFile('a.png', PNG), mimeType: 'image/png' }] }),
      c.execute({ ...CHAT_REQUEST, contextFiles }),
      v.execute({ capability: Capability.GENERAL_CHAT, prompt: 'p' }),
      v.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p' }),
      v.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p', images: [{ path: imageFile('b.png', PNG), mimeType: 'image/png' }], contextFiles }),
    ];
    for (const refusal of refusals) {
      const err = await failureOf(refusal);
      expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
      expect(err.message).toContain('REQUEST_REFUSED');
    }
    expect(fake.calls).toHaveLength(0);
  });
});

describe('request shape (ADR-0115 D5): no tools, function declarations or code execution; pinned host; key in a header', () => {
  it('POSTs one generateContent call with only one user turn and the generation bound', async () => {
    const fake = fakeFetch(() => reply('Hello!'));
    const result = await chat(fake.fetch).execute(CHAT_REQUEST);
    expect(result.text).toBe('Hello!');
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.url).toBe(GENERATE_URL);
    expect(new URL(call!.url).search).toBe('');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    const headers = call!.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(Object.keys(headers).sort()).toEqual(['accept', 'content-type', 'x-goog-api-key']);
    const body = JSON.parse(String(call!.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig']);
    expect(body).toEqual({
      contents: [{ role: 'user', parts: [{ text: CHAT_REQUEST.prompt }] }],
      generationConfig: { candidateCount: 1, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
    });
    const raw = String(call!.init.body);
    for (const forbidden of [
      'tools',
      'toolConfig',
      'functionDeclarations',
      'codeExecution',
      'googleSearch',
      'googleSearchRetrieval',
      'urlContext',
      'cachedContent',
      'systemInstruction',
      'fileData',
      'safetySettings',
    ]) {
      expect(raw).not.toContain(`"${forbidden}"`);
    }
  });

  it('the image instance sends only the canonical image bytes inline, then the prompt (no upload, no URL fetch)', async () => {
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
    expect(fake.calls[0]!.url).toBe(GENERATE_URL);
    const body = JSON.parse(String(fake.calls[0]!.init.body)) as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig']);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]!.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
      { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
      { text: 'Describe the image.' },
    ]);
    // The audit carries counts and hashes, never the path or the bytes.
    const audit = JSON.stringify(result.audit);
    expect(result.audit).toMatchObject({ imageCount: 2, imageBytes: PNG.length + jpeg.length, toolDefinitionCount: 0 });
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

  it('a request larger than one inline request allows (20 MB) is refused before sending, not uploaded', async () => {
    const fake = fakeFetch(() => reply('x'));
    const big = (n: number) => {
      const bytes = Buffer.alloc(MAX_GEMINI_VISION_IMAGE_BYTES - 1024, 0x41);
      PNG.copy(bytes, 0, 0, 8);
      return { path: imageFile(`big${n}.png`, bytes), mimeType: 'image/png' as const };
    };
    // Two images just under 8 MiB each: ~21 MB once base64-encoded.
    const err = await failureOf(vision(fake.fetch).execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p', images: [big(1), big(2)] }));
    expect(err.message).toContain('REQUEST_REFUSED');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('reply handling', () => {
  it('records usage counts and hashes in the audit; applies the injected hygiene; strips control characters', async () => {
    const fake = fakeFetch(() => candidate([{ text: 'Hi\u001b[31m th' }, { text: 'ere\u0000!' }]));
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
      api: 'generateContent',
      executionLocality: 'REMOTE',
      toolDefinitionCount: 0,
      finishReason: 'STOP',
      truncated: false,
      partCount: 2,
      textPartCount: 2,
      thoughtPartCount: 0,
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 160,
    });
    expect(JSON.stringify(result.audit)).not.toContain(CHAT_REQUEST.prompt);
  });

  it('a thought part is never part of the answer', async () => {
    const fake = fakeFetch(() => candidate([{ text: 'internal reasoning', thought: true }, { text: 'The answer.' }]));
    const result = await chat(fake.fetch).execute(CHAT_REQUEST);
    expect(result.text).toBe('The answer.');
    expect(result.audit).toMatchObject({ thoughtPartCount: 1, textPartCount: 1 });
    expect(JSON.stringify(result)).not.toContain('internal reasoning');
  });

  it('MAX_TOKENS: the text is returned, marked as cut off after hygiene, and audited', async () => {
    const fake = fakeFetch(() => reply('partial answer', 'MAX_TOKENS'));
    const truncated = await chat(fake.fetch, { replyHygiene: (text) => text.toUpperCase() }).execute(CHAT_REQUEST);
    expect(truncated.text).toBe(`PARTIAL ANSWER${GEMINI_TRUNCATED_SUFFIX}`);
    expect(GEMINI_TRUNCATED_SUFFIX).toBe('\n\n(답변이 길이 제한으로 잘렸어요.)');
    expect(truncated.audit).toMatchObject({ finishReason: 'MAX_TOKENS', truncated: true });
    // Cut off before any text (all thinking): still empty output, never a bare suffix.
    for (const respond of [() => reply('  ', 'MAX_TOKENS'), () => json({ candidates: [{ finishReason: 'MAX_TOKENS' }] })]) {
      const empty = await failureOf(chat(fakeFetch(respond).fetch).execute(CHAT_REQUEST));
      expect((empty as GeminiApiError).code).toBe(GeminiFailureCode.EMPTY_OUTPUT);
    }
  });

  it.each([
    ['SAFETY', GeminiFailureCode.SAFETY_BLOCKED],
    ['RECITATION', GeminiFailureCode.SAFETY_BLOCKED],
    ['BLOCKLIST', GeminiFailureCode.SAFETY_BLOCKED],
    ['PROHIBITED_CONTENT', GeminiFailureCode.SAFETY_BLOCKED],
    ['SPII', GeminiFailureCode.SAFETY_BLOCKED],
    ['IMAGE_SAFETY', GeminiFailureCode.SAFETY_BLOCKED],
    ['LANGUAGE', GeminiFailureCode.INCOMPLETE],
    ['OTHER', GeminiFailureCode.INCOMPLETE],
    ['FINISH_REASON_UNSPECIFIED', GeminiFailureCode.INCOMPLETE],
    ['SOMETHING_NEW', GeminiFailureCode.INCOMPLETE],
    [null, GeminiFailureCode.INCOMPLETE],
    ['MALFORMED_FUNCTION_CALL', GeminiFailureCode.TOOL_CALL_REFUSED],
    ['UNEXPECTED_TOOL_CALL', GeminiFailureCode.TOOL_CALL_REFUSED],
  ])('finish reason %s fails closed (%s → EXECUTION_FAILED), never returning the partial text', async (finishReason, code) => {
    const err = await failureOf(chat(fakeFetch(() => reply('blocked partial text', finishReason)).fetch).execute(CHAT_REQUEST));
    expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect((err as GeminiApiError).code).toBe(code);
    expect(traces(err)).not.toContain('blocked partial text');
  });

  it.each([
    ['STOP', 'candidate'],
    ['MAX_TOKENS', 'candidate'],
    ['STOP', 'promptFeedback'],
    ['MAX_TOKENS', 'promptFeedback'],
  ])('text + %s + one blocked safety rating (%s) fails closed as SAFETY_BLOCKED (Codex P2)', async (finishReason, where) => {
    const ratings = [
      { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true },
    ];
    const respond = () =>
      where === 'candidate'
        ? candidate([{ text: 'blocked partial text' }], finishReason, { safetyRatings: ratings })
        : json({
            promptFeedback: { safetyRatings: ratings },
            candidates: [{ content: { role: 'model', parts: [{ text: 'blocked partial text' }] }, finishReason }],
          });
    const err = await failureOf(chat(fakeFetch(respond).fetch).execute(CHAT_REQUEST));
    expect((err as GeminiApiError).code).toBe(GeminiFailureCode.SAFETY_BLOCKED);
    expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect(traces(err)).not.toContain('blocked partial text');
  });

  it('ratings without a block (or blocked: false) do not block; malformed ratings are refused', async () => {
    const ok = await chat(
      fakeFetch(() =>
        candidate([{ text: 'fine' }], 'STOP', {
          safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'LOW', blocked: false }, { category: 'X', probability: 'NEGLIGIBLE' }],
        }),
      ).fetch,
    ).execute(CHAT_REQUEST);
    expect(ok.text).toBe('fine');
    for (const safetyRatings of [{ blocked: true }, ['blocked']]) {
      const err = await failureOf(chat(fakeFetch(() => candidate([{ text: 'x' }], 'STOP', { safetyRatings })).fetch).execute(CHAT_REQUEST));
      expect((err as GeminiApiError).code).toBe(GeminiFailureCode.MALFORMED_RESPONSE);
    }
  });

  it.each([
    ['inlineData beside text', { text: 'smuggled', inlineData: { mimeType: 'image/png', data: 'AAAA' } }, GeminiFailureCode.MALFORMED_RESPONSE],
    ['fileData beside text', { text: 'smuggled', fileData: { mimeType: 'text/plain', fileUri: 'https://example.invalid/f' } }, GeminiFailureCode.MALFORMED_RESPONSE],
    ['an unknown key beside text', { text: 'smuggled', somethingNew: 1 }, GeminiFailureCode.MALFORMED_RESPONSE],
    ['videoMetadata beside text', { text: 'smuggled', videoMetadata: {} }, GeminiFailureCode.MALFORMED_RESPONSE],
    ['functionCall beside text', { text: 'smuggled', functionCall: { name: 'x' } }, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['executableCode beside text', { text: 'smuggled', executableCode: { language: 'PYTHON', code: 'x' } }, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['a null functionCall', { text: 'smuggled', functionCall: null }, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['a non-boolean thought', { text: 'smuggled', thought: 'yes' }, GeminiFailureCode.MALFORMED_RESPONSE],
    ['a non-string thoughtSignature', { text: 'smuggled', thoughtSignature: 7 }, GeminiFailureCode.MALFORMED_RESPONSE],
  ])('a part with %s refuses the whole response (strict part allow-list, Codex P2)', async (_name, part, code) => {
    const err = await failureOf(chat(fakeFetch(() => candidate([{ text: 'ok ' }, part])).fetch).execute(CHAT_REQUEST));
    expect((err as GeminiApiError).code).toBe(code);
    expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect(traces(err)).not.toContain('smuggled');
  });

  it('allowed text-part metadata: a thoughtSignature is ignored; a thought part (with or without one) is excluded', async () => {
    const fake = fakeFetch(() =>
      candidate([
        { text: 'internal reasoning', thought: true, thoughtSignature: 'opaque-signature' },
        { text: 'The answer', thoughtSignature: 'opaque-signature' },
        { text: '.', thought: false },
      ]),
    );
    const result = await chat(fake.fetch).execute(CHAT_REQUEST);
    expect(result.text).toBe('The answer.');
    expect(result.audit).toMatchObject({ partCount: 3, textPartCount: 2, thoughtPartCount: 1 });
    expect(JSON.stringify(result)).not.toContain('internal reasoning');
    expect(JSON.stringify(result)).not.toContain('opaque-signature');
  });

  it('a blocked prompt (promptFeedback.blockReason) fails closed whatever else the body holds', async () => {
    for (const blockReason of ['SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'BLOCK_REASON_UNSPECIFIED']) {
      const err = await failureOf(
        chat(fakeFetch(() => json({ promptFeedback: { blockReason, safetyRatings: [] }, candidates: [] })).fetch).execute(CHAT_REQUEST),
      );
      expect((err as GeminiApiError).code).toBe(GeminiFailureCode.SAFETY_BLOCKED);
      expect(err.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    }
  });
});

describe('failure taxonomy (ADR-0115 D7 / ADR-0092 amendment D5): fixed codes, never a body', () => {
  const ECHO = `API key not valid. Please pass a valid API key: ${FAKE_KEY}. SECRET-BODY-TEXT`;
  const cases: Array<[string, () => Response | Promise<Response>, AiFailureKind, GeminiFailureCode]> = [
    ['401', () => json({ error: { message: ECHO } }, 401), AiFailureKind.AUTH_REQUIRED, GeminiFailureCode.AUTH],
    ['403', () => json({ error: { message: ECHO, status: 'PERMISSION_DENIED' } }, 403), AiFailureKind.AUTH_REQUIRED, GeminiFailureCode.AUTH],
    ['429', () => json({ error: { message: ECHO, status: 'RESOURCE_EXHAUSTED' } }, 429), AiFailureKind.UNAVAILABLE, GeminiFailureCode.RATE_LIMITED],
    ['500', () => json({ error: { message: ECHO } }, 500), AiFailureKind.UNAVAILABLE, GeminiFailureCode.UNAVAILABLE],
    ['503', () => new Response(ECHO, { status: 503 }), AiFailureKind.UNAVAILABLE, GeminiFailureCode.UNAVAILABLE],
    ['404', () => json({ error: { message: ECHO } }, 404), AiFailureKind.UNAVAILABLE, GeminiFailureCode.UNAVAILABLE],
    ['400 (also an invalid key)', () => json({ error: { message: ECHO, status: 'INVALID_ARGUMENT' } }, 400), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.BAD_REQUEST],
    ['network', () => Promise.reject(new TypeError(`fetch failed ${FAKE_KEY} SECRET-BODY-TEXT`)), AiFailureKind.UNAVAILABLE, GeminiFailureCode.UNAVAILABLE],
    ['empty text', () => reply('   \n '), AiFailureKind.EMPTY_OUTPUT, GeminiFailureCode.EMPTY_OUTPUT],
    ['no candidates', () => json({ usageMetadata: {} }), AiFailureKind.EMPTY_OUTPUT, GeminiFailureCode.EMPTY_OUTPUT],
    ['only thoughts', () => candidate([{ text: 'SECRET-BODY-TEXT', thought: true }]), AiFailureKind.EMPTY_OUTPUT, GeminiFailureCode.EMPTY_OUTPUT],
    ['function call', () => candidate([{ functionCall: { name: 'x', args: { echo: ECHO } } }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['executable code', () => candidate([{ executableCode: { language: 'PYTHON', code: ECHO } }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['code execution result', () => candidate([{ codeExecutionResult: { outcome: 'OUTCOME_OK', output: ECHO } }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['function call mixed with text', () => candidate([{ text: 'ok SECRET-BODY-TEXT' }, { functionCall: { name: 'x' } }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['tool call part', () => candidate([{ toolCall: { id: 't' } }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['grounding metadata', () => candidate([{ text: 'SECRET-BODY-TEXT' }], 'STOP', { groundingMetadata: { webSearchQueries: ['q'] } }), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.TOOL_CALL_REFUSED],
    ['inline data in the reply', () => candidate([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.MALFORMED_RESPONSE],
    ['unknown part', () => candidate([{ mystery: true }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.MALFORMED_RESPONSE],
    ['two candidates', () => json({ candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }, { content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }] }), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.MALFORMED_RESPONSE],
    ['user role', () => json({ candidates: [{ content: { role: 'user', parts: [{ text: 'a' }] }, finishReason: 'STOP' }] }), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.MALFORMED_RESPONSE],
    ['not JSON', () => new Response(`<html>${ECHO}</html>`, { status: 200 }), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.MALFORMED_RESPONSE],
    ['a JSON array', () => json([{ candidates: [] }]), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.MALFORMED_RESPONSE],
    ['declared too large', () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_GEMINI_RESPONSE_BYTES + 1) } }), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.RESPONSE_TOO_LARGE],
    ['streamed too large', () => new Response(`"${'x'.repeat(MAX_GEMINI_RESPONSE_BYTES + 10)}"`, { status: 200 }), AiFailureKind.EXECUTION_FAILED, GeminiFailureCode.RESPONSE_TOO_LARGE],
    ['redirected elsewhere', () => {
      const response = reply('hijacked');
      Object.defineProperty(response, 'url', { value: 'https://evil.example/v1beta/models/x:generateContent' });
      return response;
    }, AiFailureKind.UNAVAILABLE, GeminiFailureCode.UNAVAILABLE],
    ['followed a redirect', () => {
      const response = reply('hijacked');
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }, AiFailureKind.UNAVAILABLE, GeminiFailureCode.UNAVAILABLE],
  ];

  for (const [name, respond, kind, code] of cases) {
    it(`${name} → ${kind} / ${code}`, async () => {
      const err = await failureOf(chat(fakeFetch(respond).fetch).execute(CHAT_REQUEST));
      expect(err).toBeInstanceOf(GeminiApiError);
      expect(err.kind).toBe(kind);
      expect((err as GeminiApiError).code).toBe(code);
      const trace = traces(err);
      expect(trace).not.toContain(FAKE_KEY);
      expect(trace).not.toContain('SECRET-BODY-TEXT');
      expect(trace).not.toContain('API key not valid');
      expect(trace).not.toContain(CHAT_REQUEST.prompt);
      expect(trace).not.toContain('googleapis.com');
    });
  }

  it('a call that never answers is a TIMEOUT within its bound (headers)', async () => {
    vi.useFakeTimers();
    const pending = failureOf(chat(hangingFetch()).execute({ ...CHAT_REQUEST, timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    const err = await pending;
    expect(err.kind).toBe(AiFailureKind.TIMEOUT);
    expect((err as GeminiApiError).code).toBe(GeminiFailureCode.TIMEOUT);
    expect(traces(err)).not.toContain(FAKE_KEY);
  });

  it('a body that stalls after the headers is a TIMEOUT too (one timer bounds headers and body)', async () => {
    vi.useFakeTimers();
    const stalled = (async (_input: unknown, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"candidates":'));
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
  it('GETs /v1beta/models/<model> with no body; ready only for a 200 naming that model with generateContent', async () => {
    const fake = fakeFetch(() => json({ name: `models/${MODEL}`, supportedGenerationMethods: ['generateContent', 'countTokens'] }));
    expect(await chat(fake.fetch).isAvailable()).toBe(true);
    expect(await vision(fake.fetch).isAvailable()).toBe(true);
    for (const call of fake.calls) {
      expect(call.url).toBe(MODEL_URL);
      expect(call.init.method).toBe('GET');
      expect(call.init.body).toBeUndefined();
      expect(call.init.redirect).toBe('error');
      expect(call.url).not.toContain(':generateContent');
      expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe(FAKE_KEY);
    }
    expect(await chat(fakeFetch(() => json({ name: 'models/gemini-3.8-flash' })).fetch).isAvailable()).toBe(false);
    expect(await chat(fakeFetch(() => json({ name: `models/${MODEL}`, supportedGenerationMethods: ['embedContent'] })).fetch).isAvailable()).toBe(false);
    expect(await chat(fakeFetch(() => json({ name: `models/${MODEL}` })).fetch).isAvailable()).toBe(true);
  });

  it('auth, invalid key (400), rate limit, server errors and network errors are "not ready"; a timeout is indeterminate', async () => {
    for (const respond of [
      () => json({ error: { message: FAKE_KEY } }, 400),
      () => json({ error: { message: FAKE_KEY } }, 403),
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
    const fake = fakeFetch(() => json({ name: `models/${MODEL}` }));
    const shared = new GeminiSharedProbe();
    const c = new GeminiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    const v = new GeminiApiVisionProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    expect(await Promise.all([c.isAvailable(), v.isAvailable()])).toEqual([true, true]);
    expect(await v.isAvailable()).toBe(true);
    expect(fake.calls).toHaveLength(1);

    let now = 0;
    const expiring = new GeminiSharedProbe(1000, () => now);
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

describe('shared readiness is invalidated by an execution failure', () => {
  /** GET answers `models` in order (then the last one again); POST answers `post`. */
  function scripted(models: Array<() => Response>, post: () => Response) {
    let gets = 0;
    const fake = fakeFetch((call) => {
      if (call.init.method === 'GET') {
        gets += 1;
        return (models[Math.min(gets, models.length) - 1] ?? models[models.length - 1]!)();
      }
      return post();
    });
    return { fake, gets: () => gets };
  }

  it.each([
    ['503', 503],
    ['429', 429],
    ['403', 403],
    ['400 (an invalid or revoked key answers 400)', 400],
  ])('chat: GET ok → POST %s → the next readiness check makes a fresh model-get (now failing → not ready)', async (_n, status) => {
    const { fake, gets } = scripted([() => json({ name: `models/${MODEL}` }), () => json({}, 400)], () => json({ error: { message: 'x' } }, status));
    const shared = new GeminiSharedProbe();
    const c = new GeminiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    const v = new GeminiApiVisionProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    expect(await c.isAvailable()).toBe(true);
    await expect(c.execute(CHAT_REQUEST)).rejects.toBeInstanceOf(GeminiApiError);
    expect(await c.isAvailable()).toBe(false);
    // The sibling instance shares the fresh answer (no third call).
    expect(await v.isAvailable()).toBe(false);
    expect(gets()).toBe(2);
  });

  it('vision: GET ok → POST 429 → the shared answer is dropped for both instances', async () => {
    const { fake, gets } = scripted([() => json({ name: `models/${MODEL}` }), () => json({}, 503)], () => json({}, 429));
    const shared = new GeminiSharedProbe();
    const c = new GeminiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    const v = new GeminiApiVisionProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
    expect(await c.isAvailable()).toBe(true);
    expect(await v.isAvailable()).toBe(true);
    expect(gets()).toBe(1);
    const err = await failureOf(
      v.execute({ capability: Capability.IMAGE_UNDERSTANDING, prompt: 'p', images: [{ path: imageFile('v.png', PNG), mimeType: 'image/png' }] }),
    );
    expect((err as GeminiApiError).code).toBe(GeminiFailureCode.RATE_LIMITED);
    expect(await c.isAvailable()).toBe(false);
    expect(gets()).toBe(2);
  });

  it('a failure that says nothing about readiness (malformed, safety block) keeps the cached answer', async () => {
    for (const post of [() => new Response('<html/>', { status: 200 }), () => reply('x', 'SAFETY')]) {
      const { fake, gets } = scripted([() => json({ name: `models/${MODEL}` })], post);
      const shared = new GeminiSharedProbe();
      const c = new GeminiApiProvider({ apiKey: FAKE_KEY, model: MODEL, fetch: fake.fetch, sharedProbe: shared });
      expect(await c.isAvailable()).toBe(true);
      await expect(c.execute(CHAT_REQUEST)).rejects.toBeInstanceOf(GeminiApiError);
      expect(await c.isAvailable()).toBe(true);
      expect(gets()).toBe(1);
    }
  });

  it('an in-flight probe that completes after the invalidation answers its caller but never refills the cache', async () => {
    let releaseStale: (value: boolean) => void = () => undefined;
    const shared = new GeminiSharedProbe();
    const before = shared.run(() => new Promise<boolean>((resolve) => { releaseStale = resolve; }));
    shared.invalidate();
    // A caller after the invalidation does not join the stale probe: it starts a fresh one.
    let fresh = 0;
    const after = shared.run(async () => { fresh += 1; return false; });
    releaseStale(true);
    expect(await before).toBe(true);
    expect(await after).toBe(false);
    expect(await shared.run(async () => { fresh += 1; return true; })).toBe(false);
    expect(fresh).toBe(1);
  });
});

describe('key redaction (ADR-0115 D6)', () => {
  it('the GeminiApiKey holder never shows the key to JSON, inspect, spread or string conversion', async () => {
    const holder = GeminiApiKey.from(FAKE_KEY);
    if (holder === null) throw new Error('unreachable');
    expect(GeminiApiKey.from(`${FAKE_KEY} `)).toBeNull();
    const wrapped = { ai: { gemini: { apiKey: holder, model: MODEL } } };
    for (const view of [JSON.stringify(wrapped), inspect(wrapped, { depth: 10, showHidden: true }), String(holder), `${holder}`, JSON.stringify({ ...holder })]) {
      expect(view).not.toContain(FAKE_KEY);
    }
    expect(JSON.stringify(wrapped)).toContain('[REDACTED]');
    expect(inspect(holder)).toBe('GeminiApiKey([REDACTED])');
    // The adapter accepts the holder and sends the real key in the header only.
    const fake = fakeFetch(() => reply('ok'));
    await new GeminiApiProvider({ apiKey: holder, model: MODEL, fetch: fake.fetch }).execute(CHAT_REQUEST);
    expect((fake.calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe(FAKE_KEY);
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

  it('the key is sent only in the x-goog-api-key header to the pinned host, never in the URL query or the body', async () => {
    const fake = fakeFetch((call) => (call.init.method === 'GET' ? json({ name: `models/${MODEL}` }) : reply('ok')));
    const provider = chat(fake.fetch);
    await provider.isAvailable();
    await provider.execute(CHAT_REQUEST);
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe(GEMINI_API_ORIGIN);
      expect(url.search).toBe('');
      expect(url.searchParams.has('key')).toBe(false);
      expect(call.url).not.toContain(FAKE_KEY);
      expect(String(call.init.body ?? '')).not.toContain(FAKE_KEY);
      const headers = call.init.headers as Record<string, string>;
      expect(Object.entries(headers).filter(([, value]) => value.includes(FAKE_KEY)).map(([name]) => name)).toEqual(['x-goog-api-key']);
      expect(headers.authorization).toBeUndefined();
    }
  });
});
