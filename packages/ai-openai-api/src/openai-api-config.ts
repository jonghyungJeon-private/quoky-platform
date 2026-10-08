/**
 * Fixed facts of the OpenAI API adapter (ADR-0115 D4–D7). Nothing here is configurable at runtime except the model,
 * which must be on {@link OPENAI_MODEL_ALLOW_LIST}, and the key, which must match {@link isWellFormedOpenAiApiKey}.
 */

/** The pinned endpoint (ADR-0115 D5): HTTPS only, no configurable base URL in v4. */
export const OPENAI_API_ORIGIN = 'https://api.openai.com' as const;
/** The Responses API (the generation call). */
export const OPENAI_RESPONSES_PATH = '/v1/responses' as const;
/** The model-get call used as the readiness probe (no generation). */
export const OPENAI_MODELS_PATH = '/v1/models' as const;

/**
 * The bounded model allow-list (ADR-0115 D3, "as for Claude aliases"). Every entry accepts text and image input on the
 * Responses API, so the same configured model serves the chat instance and the image instance. Extending the list is a
 * code change, never configuration.
 */
export const OPENAI_MODEL_ALLOW_LIST = Object.freeze([
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
] as const);
export type OpenAiModel = (typeof OPENAI_MODEL_ALLOW_LIST)[number];

export function isAllowedOpenAiModel(model: unknown): model is OpenAiModel {
  return typeof model === 'string' && (OPENAI_MODEL_ALLOW_LIST as readonly string[]).includes(model);
}

/**
 * The shape an OpenAI secret key has (`sk-` then URL-safe characters: user, project, service-account and admin keys
 * alike). Anything else — whitespace, a newline (header injection), quotes, a pasted `Bearer ` prefix — is refused.
 * The value is never echoed.
 */
const API_KEY_SHAPE = /^sk-[A-Za-z0-9_-]{20,512}$/u;

export function isWellFormedOpenAiApiKey(key: unknown): key is string {
  return typeof key === 'string' && API_KEY_SHAPE.test(key);
}

/** Default generation timeout (chat tier and images alike). */
export const DEFAULT_OPENAI_TIMEOUT_MS = 120_000;
/** A request's own `timeoutMs` is clamped into [MIN, MAX]. */
export const MIN_OPENAI_TIMEOUT_MS = 1_000;
export const MAX_OPENAI_TIMEOUT_MS = 300_000;
/** The readiness probe bound (one model-get call). */
export const OPENAI_PROBE_TIMEOUT_MS = 10_000;

/** The largest generation response body read (bytes); a larger one is refused, never partially parsed. */
export const MAX_OPENAI_RESPONSE_BYTES = 2 * 1024 * 1024;
/** The largest probe response body read (bytes). */
export const MAX_OPENAI_PROBE_RESPONSE_BYTES = 64 * 1024;
/** At most this many output items are accepted in one response. */
export const MAX_OPENAI_OUTPUT_ITEMS = 64;
/** `max_output_tokens` of every generation (reasoning tokens count against it on reasoning models). */
export const OPENAI_MAX_OUTPUT_TOKENS = 8192;

/** Images per request (ADR-0111 D2 bounds a message to 3 attachments). */
export const MAX_OPENAI_VISION_IMAGES = 3;
/** Image file bound (ADR-0111 D2: images ≤ 8 MiB), re-checked on the open file before it is read. */
export const MAX_OPENAI_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
