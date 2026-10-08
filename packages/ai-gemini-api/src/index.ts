/**
 * `@quoky/ai-gemini-api` — the Gemini API `AiProvider` adapter (ADR-0115 D4, PRV-2): chat tier and image understanding
 * only, `node:fetch` only (no vendor SDK), no tools, function declarations or code execution, the pinned
 * `https://generativelanguage.googleapis.com` endpoint, the key in the `x-goog-api-key` header only.
 */
export {
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_API_ORIGIN,
  GEMINI_API_VERSION_PATH,
  GEMINI_GENERATE_METHOD,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MODELS_PATH,
  GEMINI_MODEL_ALLOW_LIST,
  GEMINI_PROBE_TIMEOUT_MS,
  MAX_GEMINI_PROBE_RESPONSE_BYTES,
  MAX_GEMINI_REQUEST_BYTES,
  MAX_GEMINI_RESPONSE_BYTES,
  MAX_GEMINI_RESPONSE_PARTS,
  MAX_GEMINI_TIMEOUT_MS,
  MAX_GEMINI_VISION_IMAGES,
  MAX_GEMINI_VISION_IMAGE_BYTES,
  MIN_GEMINI_TIMEOUT_MS,
  isAllowedGeminiModel,
  isWellFormedGeminiApiKey,
} from './gemini-api-config';
export type { GeminiModel } from './gemini-api-config';
export { GeminiApiKey } from './gemini-api-key';
export { GeminiApiError, GeminiFailureCode, failureCodeOfStatus } from './gemini-http';
export {
  GEMINI_CHAT_CAPABILITIES,
  GEMINI_CHAT_PRIORITY,
  GEMINI_CHAT_PROVIDER_ID,
  GEMINI_SHARED_PROBE_TTL_MS,
  GEMINI_TRUNCATED_SUFFIX,
  GEMINI_VISION_PROVIDER_ID,
  GeminiApiProvider,
  GeminiApiVisionProvider,
  GeminiSharedProbe,
  buildGenerateContentRequestBody,
  parseGenerateContentBody,
} from './gemini-api-provider';
export type {
  GeminiAcceptedFinishReason,
  GeminiApiProviderOptions,
  GeminiInputPart,
  GeminiReplyHygiene,
} from './gemini-api-provider';
