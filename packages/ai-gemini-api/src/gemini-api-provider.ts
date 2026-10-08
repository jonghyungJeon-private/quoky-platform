import { createHash } from 'node:crypto';
import {
  AiFailureKind,
  AiProviderError,
  ArtifactKind,
  Capability,
  ProviderProbeIndeterminateError,
  newId,
  now,
} from '@quoky/core';
import type {
  AiCapabilityDescriptor,
  AiExecutionLocality,
  AiExecutionResult,
  AiProvider,
  AiRequest,
  Artifact,
  Metadata,
} from '@quoky/core';
import { readCanonicalImage } from './image-input';
import { GeminiApiKey } from './gemini-api-key';
import {
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_GENERATE_METHOD,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MODELS_PATH,
  GEMINI_PROBE_TIMEOUT_MS,
  MAX_GEMINI_PROBE_RESPONSE_BYTES,
  MAX_GEMINI_REQUEST_BYTES,
  MAX_GEMINI_RESPONSE_BYTES,
  MAX_GEMINI_RESPONSE_PARTS,
  MAX_GEMINI_TIMEOUT_MS,
  MAX_GEMINI_VISION_IMAGES,
  MIN_GEMINI_TIMEOUT_MS,
  isAllowedGeminiModel,
  isWellFormedGeminiApiKey,
} from './gemini-api-config';
import type { GeminiModel } from './gemini-api-config';
import { GeminiApiError, GeminiFailureCode, callGemini } from './gemini-http';

/**
 * Gemini API providers (ADR-0115 D4; PRV-2): HTTP adapters for the chat tier and image understanding ONLY, following
 * the PRV-1 OpenAI API pattern.
 *
 * - **Capabilities.** The chat instance advertises `GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS` and
 *   `READONLY_LOOKUP`; the image instance — a separate provider, as for Claude, Codex and OpenAI vision — advertises
 *   only `IMAGE_UNDERSTANDING`. Neither ever advertises code, review, tests, project analysis, planning,
 *   policy-sensitive chat or embeddings, and each refuses any other capability, any workspace, any context file and
 *   (the chat instance) any image BEFORE a request is sent (D2).
 * - **Containment (D5).** One `generateContent` call per request: one user turn with the rendered prompt (and, for the
 *   image instance, only the #143 canonical image bytes, inline). No `tools` (no function declarations, no code
 *   execution, no Google Search grounding, no URL context), no `toolConfig`, no `cachedContent`, no file upload, no
 *   `systemInstruction`, one candidate. A response that contains a function call, tool call, executable code, a
 *   code-execution result or grounding metadata is refused as a whole. The endpoint is pinned
 *   (`https://generativelanguage.googleapis.com`), redirects are refused, and both instances declare `REMOTE`
 *   (ADR-0107 D6).
 * - **Key (D6).** Held in a true private field, sent only as the `x-goog-api-key` header to the pinned host — never in
 *   the URL query, a log, the audit, an error, argv or the result. Construction validates its shape and never echoes it.
 * - **Finish reasons.** `STOP` is a reply; `MAX_TOKENS` is a reply marked as cut off ({@link GEMINI_TRUNCATED_SUFFIX});
 *   a blocked prompt and the safety, recitation, blocklist, prohibited-content and personal-data reasons fail closed
 *   (`SAFETY_BLOCKED`); the tool-call reasons are `TOOL_CALL_REFUSED`; anything else (`LANGUAGE`, `OTHER`, unknown,
 *   absent) is `INCOMPLETE`. No partial text of a failed candidate is ever returned.
 * - **Readiness and failures (D7).** Readiness is one bounded model-get (`GET /v1beta/models/<model>`), no generation;
 *   a timed-out probe is indeterminate. Failures are fixed codes ({@link GeminiFailureCode}); a message never carries a
 *   response body.
 * - **Usage.** The response's token counts go into the audit under the Codex/OpenAI names (the PRV-3 ledger seam);
 *   nothing reads them to switch.
 */

export const GEMINI_CHAT_CAPABILITIES: readonly Capability[] = Object.freeze([
  Capability.GENERAL_CHAT,
  Capability.SUMMARIZATION,
  Capability.DOCUMENT_ANALYSIS,
  Capability.READONLY_LOOKUP,
]);
/** Above Claude's chat-tier priorities, like Codex and OpenAI: wins only while it is the eligible effective choice. */
export const GEMINI_CHAT_PRIORITY = 100;

export const GEMINI_CHAT_PROVIDER_ID = 'gemini-api';
export const GEMINI_VISION_PROVIDER_ID = 'gemini-vision-api';

/**
 * Optional provider-neutral reply hygiene the composition root injects (the same chat output hygiene the CLI providers
 * apply). The adapter itself only strips control characters.
 */
export type GeminiReplyHygiene = (text: string, request: AiRequest) => string;

export interface GeminiApiProviderOptions {
  /** `QUOKY_GEMINI_API_KEY` (preferably the {@link GeminiApiKey} holder); must be well formed. */
  readonly apiKey: GeminiApiKey | string;
  /** A model on the allow-list ({@link isAllowedGeminiModel}). */
  readonly model: string;
  readonly providerId?: string;
  /** Offline-test seam; production uses the platform `fetch`. */
  readonly fetch?: typeof fetch;
  /** Default generation timeout (a request's own `timeoutMs` wins, clamped). */
  readonly timeoutMs?: number;
  readonly replyHygiene?: GeminiReplyHygiene;
  /**
   * A readiness probe shared with the other instance on the same key and model (the chat and image instances), so
   * both answer from ONE model-get call. Absent = this instance probes on its own.
   */
  readonly sharedProbe?: GeminiSharedProbe;
}

/** How long a shared probe answer is reused by the sibling instance (the provider manager caches on top). */
export const GEMINI_SHARED_PROBE_TTL_MS = 30_000;

/**
 * One readiness answer shared by the instances on the same key and model: concurrent callers join the in-flight probe,
 * and a definitive answer is reused for {@link GEMINI_SHARED_PROBE_TTL_MS}. An indeterminate (timed-out) probe is not
 * cached. {@link invalidate} (called when an execution on either instance fails in a way that may mean the provider is
 * no longer usable) drops the cached answer AND any in-flight probe: a generation counter keeps a probe that started
 * before the invalidation from repopulating the cache, so the next readiness check always makes a fresh model-get.
 * (The same rules as the PRV-1 OpenAI probe; adapters do not share code across packages.)
 */
export class GeminiSharedProbe {
  #inflight: Promise<boolean> | undefined;
  #cached: { readonly value: boolean; readonly at: number } | undefined;
  #generation = 0;

  constructor(
    private readonly ttlMs: number = GEMINI_SHARED_PROBE_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  run(probe: () => Promise<boolean>): Promise<boolean> {
    if (this.#cached !== undefined && this.clock() - this.#cached.at < this.ttlMs) return Promise.resolve(this.#cached.value);
    if (this.#inflight !== undefined) return this.#inflight;
    const generation = this.#generation;
    const inflight: Promise<boolean> = probe()
      .then((value) => {
        // A probe that started before an invalidation answers its own caller only; it never refills the cache.
        if (generation === this.#generation) this.#cached = { value, at: this.clock() };
        return value;
      })
      .finally(() => {
        if (this.#inflight === inflight) this.#inflight = undefined;
      });
    this.#inflight = inflight;
    return inflight;
  }

  /** Forget the cached answer and any in-flight probe; the next {@link run} probes afresh. */
  invalidate(): void {
    this.#generation += 1;
    this.#cached = undefined;
    this.#inflight = undefined;
  }
}

/**
 * The failures after which a cached "ready" must not be reused. `BAD_REQUEST` is included because the Gemini API
 * answers an invalid or revoked key with HTTP 400, and the body that would distinguish it is never read.
 */
const READINESS_INVALIDATING_CODES: ReadonlySet<GeminiFailureCode> = new Set<GeminiFailureCode>([
  GeminiFailureCode.UNAVAILABLE,
  GeminiFailureCode.RATE_LIMITED,
  GeminiFailureCode.AUTH,
  GeminiFailureCode.TIMEOUT,
  GeminiFailureCode.BAD_REQUEST,
]);

/** Appended (after hygiene) to a reply cut off by the output bound (`MAX_TOKENS`), so the owner knows it is partial. */
export const GEMINI_TRUNCATED_SUFFIX = '\n\n(답변이 길이 제한으로 잘렸어요.)';

/** One part of the request's single user turn. */
export type GeminiInputPart =
  | { readonly text: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } };

/**
 * The exact `generateContent` request body (no tool surface): one user turn and the generation bound. Exported so the
 * request shape is tested directly.
 */
export function buildGenerateContentRequestBody(parts: readonly GeminiInputPart[]): Record<string, unknown> {
  return {
    contents: [
      {
        role: 'user',
        parts: parts.map((part) => ('text' in part ? { text: part.text } : { inlineData: { ...part.inlineData } })),
      },
    ],
    generationConfig: { candidateCount: 1, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
  };
}

/** The finish reasons a reply is accepted under. */
export type GeminiAcceptedFinishReason = 'STOP' | 'MAX_TOKENS';

/** Part keys that mean the model acted instead of answering (never requested, so never accepted). */
const ACTION_PART_KEYS = ['functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult', 'toolCall', 'toolResponse'] as const;
/**
 * The ONLY keys a reply part may carry (a strict allow-list, Codex P2): `text`, plus the two pieces of text-part
 * metadata the API attaches to thinking models' output — `thought` (a boolean; a `true` part is a thought summary and is
 * never part of the reply) and `thoughtSignature` (an opaque string, ignored). A part with any other key — `inlineData`,
 * `fileData`, an action key, or anything unknown, even next to a `text` — refuses the whole response.
 */
const TEXT_PART_KEYS: ReadonlySet<string> = new Set(['text', 'thought', 'thoughtSignature']);
/** Finish reasons that mean the model tried to call a tool (none is declared). */
const TOOL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
]);
/** Finish reasons that are a content block: fail closed, never a partial answer. */
const SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

interface ParsedResponse {
  readonly text: string;
  readonly finishReason: GeminiAcceptedFinishReason;
  readonly partCount: number;
  readonly textPartCount: number;
  readonly thoughtPartCount: number;
  readonly usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Present and not empty (an object with a key, or an array with an item). */
/**
 * Whether a `safetyRatings` value holds a rating the API marked `blocked: true` (Codex P2: an explicit block fails
 * closed whatever the finish reason). Absent is no block; anything but an array of objects is malformed.
 */
function hasBlockedRating(value: unknown, fail: (code: GeminiFailureCode) => GeminiApiError): boolean {
  if (value === undefined || value === null) return false;
  if (!Array.isArray(value)) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
  return value.some((raw) => {
    const rating = asRecord(raw);
    if (rating === undefined) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    return rating.blocked === true;
  });
}

function nonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  return record !== undefined ? Object.keys(record).length > 0 : value !== undefined && value !== null;
}

/**
 * Parse a `generateContent` body, failing closed: exactly one candidate whose content parts carry only the
 * {@link TEXT_PART_KEYS} (thought parts are counted and dropped); a blocked prompt or any `blocked: true` safety rating,
 * any action part, any grounding metadata, any other part key (inline data, file data, unknown — even beside a `text`)
 * or a finish reason other than `STOP` / `MAX_TOKENS` refuses the whole response.
 */
export function parseGenerateContentBody(json: unknown, label: string): ParsedResponse {
  const fail = (code: GeminiFailureCode): GeminiApiError => new GeminiApiError(code, label);
  const body = asRecord(json);
  if (body === undefined) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
  const promptFeedback = asRecord(body.promptFeedback);
  const blockReason = promptFeedback?.blockReason;
  if (blockReason !== undefined && blockReason !== null) throw fail(GeminiFailureCode.SAFETY_BLOCKED);
  if (hasBlockedRating(promptFeedback?.safetyRatings, fail)) throw fail(GeminiFailureCode.SAFETY_BLOCKED);
  const candidates = body.candidates;
  if (candidates === undefined || (Array.isArray(candidates) && candidates.length === 0)) {
    throw fail(GeminiFailureCode.EMPTY_OUTPUT);
  }
  if (!Array.isArray(candidates) || candidates.length !== 1) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
  const candidate = asRecord(candidates[0]);
  if (candidate === undefined) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
  // An explicit safety block fails closed before anything else is read, even with text and STOP or MAX_TOKENS.
  if (hasBlockedRating(candidate.safetyRatings, fail)) throw fail(GeminiFailureCode.SAFETY_BLOCKED);
  // Grounding (Google Search, URL context) is a tool the request never declares.
  if (nonEmpty(candidate.groundingMetadata) || nonEmpty(candidate.urlContextMetadata) || nonEmpty(candidate.groundingAttributions)) {
    throw fail(GeminiFailureCode.TOOL_CALL_REFUSED);
  }

  let parts: unknown[] = [];
  if (candidate.content !== undefined) {
    const content = asRecord(candidate.content);
    if (content === undefined || (content.role !== undefined && content.role !== 'model')) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    if (content.parts !== undefined) {
      if (!Array.isArray(content.parts) || content.parts.length > MAX_GEMINI_RESPONSE_PARTS) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
      parts = content.parts;
    }
  }
  let text = '';
  let textPartCount = 0;
  let thoughtPartCount = 0;
  for (const raw of parts) {
    const part = asRecord(raw);
    if (part === undefined) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    if (ACTION_PART_KEYS.some((key) => key in part)) throw fail(GeminiFailureCode.TOOL_CALL_REFUSED);
    if (Object.keys(part).some((key) => !TEXT_PART_KEYS.has(key))) throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    if (typeof part.text !== 'string') throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    if (part.thought !== undefined && typeof part.thought !== 'boolean') throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') {
      throw fail(GeminiFailureCode.MALFORMED_RESPONSE);
    }
    if (part.thought === true) {
      // A thought summary is never part of the answer (and is not requested).
      thoughtPartCount += 1;
      continue;
    }
    textPartCount += 1;
    text += part.text;
  }

  const finishReason = candidate.finishReason;
  if (typeof finishReason === 'string' && TOOL_FINISH_REASONS.has(finishReason)) throw fail(GeminiFailureCode.TOOL_CALL_REFUSED);
  if (typeof finishReason === 'string' && SAFETY_FINISH_REASONS.has(finishReason)) throw fail(GeminiFailureCode.SAFETY_BLOCKED);
  if (finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') throw fail(GeminiFailureCode.INCOMPLETE);

  const usage = asRecord(body.usageMetadata);
  const parsedUsage: ParsedResponse['usage'] = {};
  const inputTokens = count(usage?.promptTokenCount);
  const cachedInputTokens = count(usage?.cachedContentTokenCount);
  const outputTokens = count(usage?.candidatesTokenCount);
  const reasoningTokens = count(usage?.thoughtsTokenCount);
  const totalTokens = count(usage?.totalTokenCount);
  if (inputTokens !== undefined) parsedUsage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) parsedUsage.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) parsedUsage.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) parsedUsage.reasoningTokens = reasoningTokens;
  if (totalTokens !== undefined) parsedUsage.totalTokens = totalTokens;
  return { text, finishReason, partCount: parts.length, textPartCount, thoughtPartCount, usage: parsedUsage };
}

/** C0/C1 control characters other than TAB, LF and CR (terminal escapes, NUL, DEL). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_GEMINI_TIMEOUT_MS;
  return Math.min(MAX_GEMINI_TIMEOUT_MS, Math.max(MIN_GEMINI_TIMEOUT_MS, Math.floor(ms)));
}

abstract class GeminiApiProviderBase implements AiProvider {
  abstract readonly id: string;
  abstract readonly capabilities: readonly AiCapabilityDescriptor[];
  /** ADR-0107 D6: the hosted model runs off this host. */
  readonly executionLocality: AiExecutionLocality = 'REMOTE';
  readonly model: GeminiModel;
  /** Never enumerable, never serialised, never inspected: a true private field. */
  readonly #apiKey: string;
  readonly #sharedProbe: GeminiSharedProbe | undefined;
  protected readonly fetchImpl: typeof fetch;
  protected readonly defaultTimeoutMs: number;
  protected readonly replyHygiene: GeminiReplyHygiene | undefined;
  protected abstract readonly label: string;

  protected constructor(options: GeminiApiProviderOptions) {
    const apiKey = options.apiKey instanceof GeminiApiKey ? options.apiKey.reveal() : options.apiKey;
    if (!isWellFormedGeminiApiKey(apiKey)) throw new TypeError('Invalid Gemini API key');
    if (!isAllowedGeminiModel(options.model)) throw new TypeError('Gemini model is not on the allow-list');
    this.#apiKey = apiKey;
    this.#sharedProbe = options.sharedProbe;
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultTimeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS);
    this.replyHygiene = options.replyHygiene;
  }

  /**
   * Ready means the pinned API accepts the key and serves the model for generation (`GET /v1beta/models/<model>`, 200
   * naming `models/<model>` and, when listed, supporting `generateContent`). No generation. A timed-out probe is
   * indeterminate (the previous answer is kept); any other failure is "not ready".
   */
  isAvailable(): Promise<boolean> {
    return this.#sharedProbe !== undefined ? this.#sharedProbe.run(() => this.probeModel()) : this.probeModel();
  }

  private async probeModel(): Promise<boolean> {
    try {
      const { json } = await callGemini(this.fetchImpl, {
        method: 'GET',
        path: `${GEMINI_MODELS_PATH}/${encodeURIComponent(this.model)}`,
        apiKey: this.#apiKey,
        timeoutMs: GEMINI_PROBE_TIMEOUT_MS,
        maxResponseBytes: MAX_GEMINI_PROBE_RESPONSE_BYTES,
        label: this.label,
      });
      const model = asRecord(json);
      if (model?.name !== `models/${this.model}`) return false;
      const methods = model.supportedGenerationMethods;
      return methods === undefined || (Array.isArray(methods) && methods.includes('generateContent'));
    } catch (err) {
      if (err instanceof GeminiApiError && err.code === GeminiFailureCode.TIMEOUT) {
        throw new ProviderProbeIndeterminateError(`${this.label} models probe timed out`);
      }
      return false;
    }
  }

  abstract execute(request: AiRequest): Promise<AiExecutionResult>;

  protected refuse(reason: string): never {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, `${this.label}: ${GeminiFailureCode.REQUEST_REFUSED} (${reason})`);
  }

  /** One `generateContent` call and the shared reply handling. */
  protected async generate(
    request: AiRequest,
    parts: readonly GeminiInputPart[],
    auditExtra: Metadata,
    title: string,
  ): Promise<AiExecutionResult> {
    const body = JSON.stringify(buildGenerateContentRequestBody(parts));
    const requestBodyBytes = Buffer.byteLength(body, 'utf8');
    if (requestBodyBytes > MAX_GEMINI_REQUEST_BYTES) this.refuse('the request is larger than one inline request allows');
    let json: unknown;
    let responseBytes: number;
    let parsed: ParsedResponse;
    try {
      ({ json, responseBytes } = await callGemini(this.fetchImpl, {
        method: 'POST',
        path: `${GEMINI_MODELS_PATH}/${encodeURIComponent(this.model)}${GEMINI_GENERATE_METHOD}`,
        apiKey: this.#apiKey,
        body,
        timeoutMs: clampTimeout(request.timeoutMs ?? this.defaultTimeoutMs),
        maxResponseBytes: MAX_GEMINI_RESPONSE_BYTES,
        label: this.label,
      }));
      parsed = parseGenerateContentBody(json, this.label);
    } catch (err) {
      // The router invalidates its own readiness cache on UNAVAILABLE; the shared probe must not answer the re-probe
      // from its cache either (chat and image instances alike).
      if (err instanceof GeminiApiError && READINESS_INVALIDATING_CODES.has(err.code)) this.#sharedProbe?.invalidate();
      throw err;
    }
    const cleaned = parsed.text.replace(CONTROL_CHARACTERS, '');
    const hygienic = this.replyHygiene ? this.replyHygiene(cleaned, request) : cleaned;
    // Defence in depth: the model never sees the key, but a reply can never carry it either.
    const answer = hygienic.split(this.#apiKey).join('[redacted]').trim();
    if (!answer) throw new GeminiApiError(GeminiFailureCode.EMPTY_OUTPUT, this.label);
    const truncated = parsed.finishReason === 'MAX_TOKENS';
    const text = truncated ? `${answer}${GEMINI_TRUNCATED_SUFFIX}` : answer;

    const artifact: Artifact = { id: newId(), kind: ArtifactKind.MARKDOWN_REPORT, title, content: text, createdAt: now() };
    return {
      text,
      artifacts: [artifact],
      raw: { finishReason: parsed.finishReason },
      // Counts and hashes only: no prompt, reply, image byte, key or response text.
      audit: {
        model: this.model,
        api: 'generateContent',
        executionLocality: this.executionLocality,
        toolDefinitionCount: 0,
        promptSha256: sha256(request.prompt),
        replySha256: sha256(text),
        requestBodyBytes,
        responseBytes,
        finishReason: parsed.finishReason,
        truncated,
        partCount: parsed.partCount,
        textPartCount: parsed.textPartCount,
        thoughtPartCount: parsed.thoughtPartCount,
        ...parsed.usage,
        ...auditExtra,
        outputSanitized: true,
      },
    };
  }
}

/** The chat-tier instance (`gemini-api`). */
export class GeminiApiProvider extends GeminiApiProviderBase {
  readonly id: string;
  readonly capabilities: readonly AiCapabilityDescriptor[] = GEMINI_CHAT_CAPABILITIES.map((capability) => ({
    capability,
    priority: GEMINI_CHAT_PRIORITY,
  }));
  protected readonly label = 'gemini API';

  constructor(options: GeminiApiProviderOptions) {
    super(options);
    this.id = options.providerId ?? GEMINI_CHAT_PROVIDER_ID;
  }

  async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (!GEMINI_CHAT_CAPABILITIES.includes(request.capability)) this.refuse('chat-tier capabilities only');
    if ((request.images?.length ?? 0) > 0) this.refuse('the chat instance does not accept images');
    if (request.workspace !== undefined) this.refuse('never runs in a workspace');
    // Memory reaches this provider only inside the rendered prompt; a context file would be silently dropped.
    if ((request.contextFiles?.length ?? 0) > 0) this.refuse('context files are not accepted');
    return this.generate(request, [{ text: request.prompt }], {}, 'gemini-response');
  }
}

/** The image-understanding instance (`gemini-vision-api`). */
export class GeminiApiVisionProvider extends GeminiApiProviderBase {
  readonly id: string;
  readonly capabilities: readonly AiCapabilityDescriptor[] = [{ capability: Capability.IMAGE_UNDERSTANDING, priority: 100 }];
  protected readonly label = 'gemini vision API';

  constructor(options: GeminiApiProviderOptions) {
    super(options);
    this.id = options.providerId ?? GEMINI_VISION_PROVIDER_ID;
  }

  async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (request.capability !== Capability.IMAGE_UNDERSTANDING) this.refuse('IMAGE_UNDERSTANDING only');
    if (request.workspace !== undefined) this.refuse('never runs in a workspace');
    if ((request.contextFiles?.length ?? 0) > 0) this.refuse('context files are not accepted');
    const images = request.images ?? [];
    if (images.length === 0 || images.length > MAX_GEMINI_VISION_IMAGES) this.refuse('1 to 3 images are required');
    if (new Set(images.map((image) => image.path)).size !== images.length) this.refuse('image reference refused');
    const bytes = images.map((image) => {
      const read = readCanonicalImage(image);
      if (!read.ok) this.refuse(read.reason === 'GONE' ? 'image reference is no longer available' : 'image reference refused');
      return read.bytes;
    });
    // The images first, then the instruction (the order the Gemini API recommends for image prompts).
    const parts: GeminiInputPart[] = [
      ...images.map((image, index): GeminiInputPart => ({
        inlineData: { mimeType: image.mimeType, data: bytes[index]!.toString('base64') },
      })),
      { text: request.prompt },
    ];
    return this.generate(
      request,
      parts,
      {
        imageCount: images.length,
        imageBytes: bytes.reduce((sum, b) => sum + b.length, 0),
        imageSha256: bytes.map((b) => sha256(b)),
      },
      'gemini-vision-response',
    );
  }
}
