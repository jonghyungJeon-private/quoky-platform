/**
 * Fixed facts of the Gemini API adapter (ADR-0115 D4–D7, PRV-2). Nothing here is configurable at runtime except the
 * model, which must be on {@link GEMINI_MODEL_ALLOW_LIST}, and the key, which must match {@link isWellFormedGeminiApiKey}.
 */

/** The pinned endpoint (ADR-0115 D5): the Google Generative Language API, HTTPS only, no configurable base URL in v4. */
export const GEMINI_API_ORIGIN = 'https://generativelanguage.googleapis.com' as const;
/** The API version every path is under (the version the Gemini API documents for `generateContent` and preview models). */
export const GEMINI_API_VERSION_PATH = '/v1beta' as const;
/** The model-get call used as the readiness probe (`GET /v1beta/models/<model>`, no generation). */
export const GEMINI_MODELS_PATH = `${GEMINI_API_VERSION_PATH}/models` as const;
/** The generation method appended to the model path (`POST /v1beta/models/<model>:generateContent`). */
export const GEMINI_GENERATE_METHOD = ':generateContent' as const;

/**
 * The bounded model allow-list (ADR-0115 D3, "as for Claude aliases"): the text-output Gemini models the Gemini API's
 * models page lists as stable on 2026-10-08, plus the one Pro model (still a preview without a shutdown date). Every
 * entry is a multimodal model, so the same configured model serves the chat instance and the image instance. Shut-down
 * codes (`gemini-2.0-*`, `gemini-3-pro-preview`) and the 2.5 family (served only to projects that used it before) are
 * not on the list. Extending the list is a code change, never configuration.
 */
export const GEMINI_MODEL_ALLOW_LIST = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
] as const);
export type GeminiModel = (typeof GEMINI_MODEL_ALLOW_LIST)[number];

export function isAllowedGeminiModel(model: unknown): model is GeminiModel {
  return typeof model === 'string' && (GEMINI_MODEL_ALLOW_LIST as readonly string[]).includes(model);
}

/**
 * The shape a Google API key has (`AIza` then 35 URL-safe characters, 39 in all) — the shape the Core credential guard
 * already recognises. Anything else (whitespace, a newline, quotes, a pasted `key=` or header prefix) is refused. The
 * value is never echoed.
 */
const API_KEY_SHAPE = /^AIza[0-9A-Za-z_-]{35}$/u;

export function isWellFormedGeminiApiKey(key: unknown): key is string {
  return typeof key === 'string' && API_KEY_SHAPE.test(key);
}

/** Default generation timeout (chat tier and images alike). */
export const DEFAULT_GEMINI_TIMEOUT_MS = 120_000;
/** A request's own `timeoutMs` is clamped into [MIN, MAX]. */
export const MIN_GEMINI_TIMEOUT_MS = 1_000;
export const MAX_GEMINI_TIMEOUT_MS = 300_000;
/** The readiness probe bound (one model-get call). */
export const GEMINI_PROBE_TIMEOUT_MS = 10_000;

/** The largest generation response body read (bytes); a larger one is refused, never partially parsed. */
export const MAX_GEMINI_RESPONSE_BYTES = 2 * 1024 * 1024;
/** The largest probe response body read (bytes). */
export const MAX_GEMINI_PROBE_RESPONSE_BYTES = 64 * 1024;
/** At most this many parts are accepted in the one candidate's content. */
export const MAX_GEMINI_RESPONSE_PARTS = 64;
/** `generationConfig.maxOutputTokens` of every generation (thinking tokens count against it on thinking models). */
export const GEMINI_MAX_OUTPUT_TOKENS = 8192;

/** Images per request (ADR-0111 D2 bounds a message to 3 attachments). */
export const MAX_GEMINI_VISION_IMAGES = 3;
/** Image file bound (ADR-0111 D2: images ≤ 8 MiB), re-checked on the open file before it is read. */
export const MAX_GEMINI_VISION_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * The largest request body sent (bytes). The Gemini API documents a 20 MB total request size for inline image data
 * (prompt and base64 bytes together); a larger request is refused before sending rather than uploaded through the
 * Files API (D5: no file-upload API).
 */
export const MAX_GEMINI_REQUEST_BYTES = 20_000_000;
