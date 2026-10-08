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
import { OpenAiApiKey } from './openai-api-key';
import {
  DEFAULT_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_OUTPUT_ITEMS,
  MAX_OPENAI_PROBE_RESPONSE_BYTES,
  MAX_OPENAI_RESPONSE_BYTES,
  MAX_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_VISION_IMAGES,
  MIN_OPENAI_TIMEOUT_MS,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_MODELS_PATH,
  OPENAI_PROBE_TIMEOUT_MS,
  OPENAI_RESPONSES_PATH,
  isAllowedOpenAiModel,
  isWellFormedOpenAiApiKey,
} from './openai-api-config';
import type { OpenAiModel } from './openai-api-config';
import { OpenAiApiError, OpenAiFailureCode, callOpenAi } from './openai-http';

/**
 * OpenAI API providers (ADR-0115; PRV-1): HTTP adapters for the chat tier and image understanding ONLY.
 *
 * - **Capabilities.** The chat instance advertises `GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS` and
 *   `READONLY_LOOKUP`; the image instance — a separate provider, as for Claude and Codex vision — advertises only
 *   `IMAGE_UNDERSTANDING`. Neither ever advertises code, review, tests, project analysis, planning, policy-sensitive
 *   chat or embeddings, and each refuses any other capability, any workspace and (the chat instance) any image BEFORE a
 *   request is sent (D2).
 * - **Containment (D5).** One Responses API call per request: the rendered prompt (and, for the image instance, only
 *   the #143 canonical image bytes, inline as data URLs). No `tools`, `functions` or `tool_choice`, no web search or
 *   file search, no file upload, no `previous_response_id` or conversation, `store: false`. A response that contains
 *   any action item (a function, tool, search or other call) is refused as a whole. The endpoint is pinned
 *   (`https://api.openai.com`), redirects are refused, and both instances declare `REMOTE` (ADR-0107 D6).
 * - **Key (D6).** Held in a true private field, sent only as the `Authorization` header to the pinned host, never in
 *   a log, the audit, an error, argv or the result. Construction validates its shape and never echoes it.
 * - **Readiness and failures (D7).** Readiness is one bounded model-get (`GET /v1/models/<model>`), no generation; a
 *   timed-out probe is indeterminate. Failures are fixed codes ({@link OpenAiFailureCode}); a message never carries a
 *   response body.
 * - **Usage.** The response's token counts go into the audit (the PRV-3 ledger seam); nothing reads them to switch.
 */

export const OPENAI_CHAT_CAPABILITIES: readonly Capability[] = Object.freeze([
  Capability.GENERAL_CHAT,
  Capability.SUMMARIZATION,
  Capability.DOCUMENT_ANALYSIS,
  Capability.READONLY_LOOKUP,
]);
/** Above Claude's chat-tier priorities, like Codex: wins only while it is the eligible effective choice. */
export const OPENAI_CHAT_PRIORITY = 100;

export const OPENAI_CHAT_PROVIDER_ID = 'openai-api';
export const OPENAI_VISION_PROVIDER_ID = 'openai-vision-api';

/**
 * Optional provider-neutral reply hygiene the composition root injects (the same chat output hygiene the CLI providers
 * apply). The adapter itself only strips control characters.
 */
export type OpenAiReplyHygiene = (text: string, request: AiRequest) => string;

export interface OpenAiApiProviderOptions {
  /** `QUOKY_OPENAI_API_KEY` (preferably the {@link OpenAiApiKey} holder); must be well formed. */
  readonly apiKey: OpenAiApiKey | string;
  /** A model on the allow-list ({@link isAllowedOpenAiModel}). */
  readonly model: string;
  readonly providerId?: string;
  /** Offline-test seam; production uses the platform `fetch`. */
  readonly fetch?: typeof fetch;
  /** Default generation timeout (a request's own `timeoutMs` wins, clamped). */
  readonly timeoutMs?: number;
  readonly replyHygiene?: OpenAiReplyHygiene;
  /**
   * A readiness probe shared with the other instance on the same key and model (the chat and image instances), so
   * both answer from ONE model-get call. Absent = this instance probes on its own.
   */
  readonly sharedProbe?: OpenAiSharedProbe;
}

/** How long a shared probe answer is reused by the sibling instance (the provider manager caches on top). */
export const OPENAI_SHARED_PROBE_TTL_MS = 30_000;

/**
 * One readiness answer shared by the instances on the same key and model: concurrent callers join the in-flight probe,
 * and a definitive answer is reused for {@link OPENAI_SHARED_PROBE_TTL_MS}. An indeterminate (timed-out) probe is not
 * cached.
 */
export class OpenAiSharedProbe {
  #inflight: Promise<boolean> | undefined;
  #cached: { readonly value: boolean; readonly at: number } | undefined;

  constructor(
    private readonly ttlMs: number = OPENAI_SHARED_PROBE_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  run(probe: () => Promise<boolean>): Promise<boolean> {
    if (this.#cached !== undefined && this.clock() - this.#cached.at < this.ttlMs) return Promise.resolve(this.#cached.value);
    if (this.#inflight !== undefined) return this.#inflight;
    const inflight = probe()
      .then((value) => {
        this.#cached = { value, at: this.clock() };
        return value;
      })
      .finally(() => {
        this.#inflight = undefined;
      });
    this.#inflight = inflight;
    return inflight;
  }
}

/** Why a response was `incomplete` (a bounded vocabulary; anything unknown is `other`). */
export type OpenAiIncompleteReason = 'max_output_tokens' | 'content_filter' | 'other';

/** Appended (after hygiene) to a reply cut off by the output bound, so the owner knows it is partial. */
export const OPENAI_TRUNCATED_SUFFIX = '\n\n(답변이 길이 제한으로 잘렸어요.)';

/** One `input` content part of the Responses API request. */
export type OpenAiInputPart =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string; readonly detail: 'auto' };

/**
 * The exact Responses API request body (no tool surface): `model`, one user `input` message, `store: false` and the
 * output bound. Exported so the request shape is tested directly.
 */
export function buildResponsesRequestBody(model: OpenAiModel, parts: readonly OpenAiInputPart[]): Record<string, unknown> {
  return {
    model,
    input: [{ role: 'user', content: parts.map((part) => ({ ...part })) }],
    store: false,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
  };
}

interface ParsedResponse {
  readonly text: string;
  readonly status: 'completed' | 'incomplete';
  /** Set only for `incomplete`. */
  readonly incompleteReason?: OpenAiIncompleteReason;
  readonly outputItemCount: number;
  readonly messageItemCount: number;
  readonly reasoningItemCount: number;
  readonly refusalCount: number;
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

/**
 * Parse a Responses API body, failing closed: only `message` (assistant `output_text` / `refusal` parts) and
 * `reasoning` items are accepted; any other item — a function, tool, search, computer, shell, MCP or image-generation
 * call, or a type this adapter does not know — refuses the whole response.
 */
export function parseResponsesBody(json: unknown, label: string): ParsedResponse {
  const fail = (code: OpenAiFailureCode): OpenAiApiError => new OpenAiApiError(code, label);
  const body = asRecord(json);
  if (body === undefined) throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
  if (body.status === 'failed') throw fail(OpenAiFailureCode.UNAVAILABLE);
  if (body.status !== 'completed' && body.status !== 'incomplete') throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
  const output = body.output;
  if (!Array.isArray(output) || output.length > MAX_OPENAI_OUTPUT_ITEMS) throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
  const messages: string[] = [];
  let messageItemCount = 0;
  let reasoningItemCount = 0;
  let refusalCount = 0;
  for (const raw of output) {
    const item = asRecord(raw);
    if (item === undefined || typeof item.type !== 'string') throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
    if (item.type === 'reasoning') {
      reasoningItemCount += 1;
      continue;
    }
    if (item.type !== 'message') {
      // Never requested, so never accepted: an action item means the response is not a plain answer.
      throw fail(
        /(_call|_request|_list_tools|_output)$/u.test(item.type) || item.type === 'function_call'
          ? OpenAiFailureCode.TOOL_CALL_REFUSED
          : OpenAiFailureCode.MALFORMED_RESPONSE,
      );
    }
    if (item.role !== 'assistant' || !Array.isArray(item.content)) throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
    messageItemCount += 1;
    let text = '';
    for (const rawPart of item.content) {
      const part = asRecord(rawPart);
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
      else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
        refusalCount += 1;
        text += part.refusal;
      } else throw fail(OpenAiFailureCode.MALFORMED_RESPONSE);
    }
    messages.push(text);
  }
  const usage = asRecord(body.usage);
  const inputDetails = asRecord(usage?.input_tokens_details);
  const outputDetails = asRecord(usage?.output_tokens_details);
  const parsedUsage: ParsedResponse['usage'] = {};
  const inputTokens = count(usage?.input_tokens);
  const cachedInputTokens = count(inputDetails?.cached_tokens);
  const outputTokens = count(usage?.output_tokens);
  const reasoningTokens = count(outputDetails?.reasoning_tokens);
  const totalTokens = count(usage?.total_tokens);
  if (inputTokens !== undefined) parsedUsage.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) parsedUsage.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) parsedUsage.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) parsedUsage.reasoningTokens = reasoningTokens;
  if (totalTokens !== undefined) parsedUsage.totalTokens = totalTokens;
  let incompleteReason: OpenAiIncompleteReason | undefined;
  if (body.status === 'incomplete') {
    const reason = asRecord(body.incomplete_details)?.reason;
    incompleteReason = reason === 'max_output_tokens' || reason === 'content_filter' ? reason : 'other';
  }
  return {
    text: messages.join('\n\n'),
    status: body.status,
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
    outputItemCount: output.length,
    messageItemCount,
    reasoningItemCount,
    refusalCount,
    usage: parsedUsage,
  };
}

/** C0/C1 control characters other than TAB, LF and CR (terminal escapes, NUL, DEL). */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_OPENAI_TIMEOUT_MS;
  return Math.min(MAX_OPENAI_TIMEOUT_MS, Math.max(MIN_OPENAI_TIMEOUT_MS, Math.floor(ms)));
}

abstract class OpenAiApiProviderBase implements AiProvider {
  abstract readonly id: string;
  abstract readonly capabilities: readonly AiCapabilityDescriptor[];
  /** ADR-0107 D6: the hosted model runs off this host. */
  readonly executionLocality: AiExecutionLocality = 'REMOTE';
  readonly model: OpenAiModel;
  /** Never enumerable, never serialised, never inspected: a true private field. */
  readonly #apiKey: string;
  readonly #sharedProbe: OpenAiSharedProbe | undefined;
  protected readonly fetchImpl: typeof fetch;
  protected readonly defaultTimeoutMs: number;
  protected readonly replyHygiene: OpenAiReplyHygiene | undefined;
  protected abstract readonly label: string;

  protected constructor(options: OpenAiApiProviderOptions) {
    const apiKey = options.apiKey instanceof OpenAiApiKey ? options.apiKey.reveal() : options.apiKey;
    if (!isWellFormedOpenAiApiKey(apiKey)) throw new TypeError('Invalid OpenAI API key');
    if (!isAllowedOpenAiModel(options.model)) throw new TypeError('OpenAI model is not on the allow-list');
    this.#apiKey = apiKey;
    this.#sharedProbe = options.sharedProbe;
    this.model = options.model;
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultTimeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS);
    this.replyHygiene = options.replyHygiene;
  }

  /**
   * Ready means the pinned API accepts the key and serves the model (`GET /v1/models/<model>`, 200 with that id). No
   * generation. A timed-out probe is indeterminate (the previous answer is kept); any other failure is "not ready".
   */
  isAvailable(): Promise<boolean> {
    return this.#sharedProbe !== undefined ? this.#sharedProbe.run(() => this.probeModel()) : this.probeModel();
  }

  private async probeModel(): Promise<boolean> {
    try {
      const { json } = await callOpenAi(this.fetchImpl, {
        method: 'GET',
        path: `${OPENAI_MODELS_PATH}/${encodeURIComponent(this.model)}`,
        apiKey: this.#apiKey,
        timeoutMs: OPENAI_PROBE_TIMEOUT_MS,
        maxResponseBytes: MAX_OPENAI_PROBE_RESPONSE_BYTES,
        label: this.label,
      });
      return asRecord(json)?.id === this.model;
    } catch (err) {
      if (err instanceof OpenAiApiError && err.code === OpenAiFailureCode.TIMEOUT) {
        throw new ProviderProbeIndeterminateError(`${this.label} models probe timed out`);
      }
      return false;
    }
  }

  abstract execute(request: AiRequest): Promise<AiExecutionResult>;

  protected refuse(reason: string): never {
    throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, `${this.label}: ${OpenAiFailureCode.REQUEST_REFUSED} (${reason})`);
  }

  /** One Responses API call and the shared reply handling. */
  protected async generate(
    request: AiRequest,
    parts: readonly OpenAiInputPart[],
    auditExtra: Metadata,
    title: string,
  ): Promise<AiExecutionResult> {
    const body = JSON.stringify(buildResponsesRequestBody(this.model, parts));
    const { json, responseBytes } = await callOpenAi(this.fetchImpl, {
      method: 'POST',
      path: OPENAI_RESPONSES_PATH,
      apiKey: this.#apiKey,
      body,
      timeoutMs: clampTimeout(request.timeoutMs ?? this.defaultTimeoutMs),
      maxResponseBytes: MAX_OPENAI_RESPONSE_BYTES,
      label: this.label,
    });
    const parsed = parseResponsesBody(json, this.label);
    // Only a reply cut off by the output bound is usable (marked as partial); a filtered or otherwise incomplete one
    // fails closed.
    if (parsed.incompleteReason !== undefined && parsed.incompleteReason !== 'max_output_tokens') {
      throw new OpenAiApiError(OpenAiFailureCode.INCOMPLETE, this.label);
    }
    const cleaned = parsed.text.replace(CONTROL_CHARACTERS, '');
    const hygienic = this.replyHygiene ? this.replyHygiene(cleaned, request) : cleaned;
    // Defence in depth: the model never sees the key, but a reply can never carry it either.
    const answer = hygienic.split(this.#apiKey).join('[redacted]').trim();
    if (!answer) throw new OpenAiApiError(OpenAiFailureCode.EMPTY_OUTPUT, this.label);
    const text = parsed.incompleteReason === 'max_output_tokens' ? `${answer}${OPENAI_TRUNCATED_SUFFIX}` : answer;

    const artifact: Artifact = { id: newId(), kind: ArtifactKind.MARKDOWN_REPORT, title, content: text, createdAt: now() };
    return {
      text,
      artifacts: [artifact],
      raw: { responseStatus: parsed.status },
      // Counts and hashes only: no prompt, reply, image byte, key or response text.
      audit: {
        model: this.model,
        api: 'responses',
        executionLocality: this.executionLocality,
        store: false,
        toolDefinitionCount: 0,
        promptSha256: sha256(request.prompt),
        replySha256: sha256(text),
        requestBodyBytes: Buffer.byteLength(body, 'utf8'),
        responseBytes,
        responseStatus: parsed.status,
        ...(parsed.incompleteReason !== undefined ? { incompleteReason: parsed.incompleteReason } : {}),
        outputItemCount: parsed.outputItemCount,
        messageItemCount: parsed.messageItemCount,
        reasoningItemCount: parsed.reasoningItemCount,
        refusalCount: parsed.refusalCount,
        ...parsed.usage,
        ...auditExtra,
        outputSanitized: true,
      },
    };
  }
}

/** The chat-tier instance (`openai-api`). */
export class OpenAiApiProvider extends OpenAiApiProviderBase {
  readonly id: string;
  readonly capabilities: readonly AiCapabilityDescriptor[] = OPENAI_CHAT_CAPABILITIES.map((capability) => ({
    capability,
    priority: OPENAI_CHAT_PRIORITY,
  }));
  protected readonly label = 'openai API';

  constructor(options: OpenAiApiProviderOptions) {
    super(options);
    this.id = options.providerId ?? OPENAI_CHAT_PROVIDER_ID;
  }

  async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (!OPENAI_CHAT_CAPABILITIES.includes(request.capability)) this.refuse('chat-tier capabilities only');
    if ((request.images?.length ?? 0) > 0) this.refuse('the chat instance does not accept images');
    if (request.workspace !== undefined) this.refuse('never runs in a workspace');
    // Memory reaches this provider only inside the rendered prompt; a context file would be silently dropped.
    if ((request.contextFiles?.length ?? 0) > 0) this.refuse('context files are not accepted');
    return this.generate(request, [{ type: 'input_text', text: request.prompt }], {}, 'openai-response');
  }
}

/** The image-understanding instance (`openai-vision-api`). */
export class OpenAiApiVisionProvider extends OpenAiApiProviderBase {
  readonly id: string;
  readonly capabilities: readonly AiCapabilityDescriptor[] = [{ capability: Capability.IMAGE_UNDERSTANDING, priority: 100 }];
  protected readonly label = 'openai vision API';

  constructor(options: OpenAiApiProviderOptions) {
    super(options);
    this.id = options.providerId ?? OPENAI_VISION_PROVIDER_ID;
  }

  async execute(request: AiRequest): Promise<AiExecutionResult> {
    if (request.capability !== Capability.IMAGE_UNDERSTANDING) this.refuse('IMAGE_UNDERSTANDING only');
    if (request.workspace !== undefined) this.refuse('never runs in a workspace');
    const images = request.images ?? [];
    if (images.length === 0 || images.length > MAX_OPENAI_VISION_IMAGES) this.refuse('1 to 3 images are required');
    if (new Set(images.map((image) => image.path)).size !== images.length) this.refuse('image reference refused');
    const bytes = images.map((image) => {
      const read = readCanonicalImage(image);
      if (!read.ok) this.refuse(read.reason === 'GONE' ? 'image reference is no longer available' : 'image reference refused');
      return read.bytes;
    });
    const parts: OpenAiInputPart[] = [
      { type: 'input_text', text: request.prompt },
      ...images.map((image, index): OpenAiInputPart => ({
        type: 'input_image',
        image_url: `data:${image.mimeType};base64,${bytes[index]!.toString('base64')}`,
        detail: 'auto',
      })),
    ];
    return this.generate(
      request,
      parts,
      {
        imageCount: images.length,
        imageBytes: bytes.reduce((sum, b) => sum + b.length, 0),
        imageSha256: bytes.map((b) => sha256(b)),
      },
      'openai-vision-response',
    );
  }
}
