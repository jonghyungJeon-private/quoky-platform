/**
 * `@quoky/ai-openai-api` — the OpenAI API `AiProvider` adapter (ADR-0115, PRV-1): chat tier and image understanding
 * only, `node:fetch` only (no vendor SDK), no tool definitions, the pinned `https://api.openai.com` endpoint.
 */
export {
  DEFAULT_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_OUTPUT_ITEMS,
  MAX_OPENAI_PROBE_RESPONSE_BYTES,
  MAX_OPENAI_RESPONSE_BYTES,
  MAX_OPENAI_TIMEOUT_MS,
  MAX_OPENAI_VISION_IMAGES,
  MAX_OPENAI_VISION_IMAGE_BYTES,
  MIN_OPENAI_TIMEOUT_MS,
  OPENAI_API_ORIGIN,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_MODELS_PATH,
  OPENAI_MODEL_ALLOW_LIST,
  OPENAI_PROBE_TIMEOUT_MS,
  OPENAI_RESPONSES_PATH,
  isAllowedOpenAiModel,
  isWellFormedOpenAiApiKey,
} from './openai-api-config';
export type { OpenAiModel } from './openai-api-config';
export { OpenAiApiError, OpenAiFailureCode, failureCodeOfStatus } from './openai-http';
export {
  OPENAI_CHAT_CAPABILITIES,
  OPENAI_CHAT_PRIORITY,
  OPENAI_CHAT_PROVIDER_ID,
  OPENAI_VISION_PROVIDER_ID,
  OpenAiApiProvider,
  OpenAiApiVisionProvider,
  buildResponsesRequestBody,
  parseResponsesBody,
} from './openai-api-provider';
export type { OpenAiApiProviderOptions, OpenAiInputPart, OpenAiReplyHygiene } from './openai-api-provider';
