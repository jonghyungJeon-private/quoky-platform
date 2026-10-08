import { sanitizeGeneralChatText, sanitizeTerminalOutput, stripInternalMetadataEnvelope } from '@quoky/ai-cli';
import { OPENAI_CHAT_PROVIDER_ID, OpenAiApiProvider, OpenAiApiVisionProvider } from '@quoky/ai-openai-api';
import { Capability, readGeneralChatReplyPolicy } from '@quoky/core';
import type { AiProvider, AiRequest } from '@quoky/core';
import type { OpenAiApiConfig } from './config';

/**
 * Composition of the OpenAI API providers (ADR-0115, PRV-1). The adapter (`@quoky/ai-openai-api`) depends only on
 * `@quoky/core`; the composition root injects the provider-neutral chat reply hygiene the CLI providers apply
 * (ADR-0098 D2 and amendment D2), so an OpenAI reply goes through the same envelope strip, translation and action-claim
 * guards as a Codex or Claude reply.
 *
 * The key is passed only into the adapter constructors here; it never reaches Core, a log line or the selection
 * service (which sees provider instances and opaque ids only).
 */

/** The same hygiene the Codex CLI chat provider applies: terminal framing always, the chat guards for `GENERAL_CHAT`. */
export function openAiReplyHygiene(text: string, request: AiRequest): string {
  const clean = sanitizeTerminalOutput(text);
  return request.capability === Capability.GENERAL_CHAT
    ? sanitizeGeneralChatText(stripInternalMetadataEnvelope(clean), readGeneralChatReplyPolicy(request.metadata))
    : clean;
}

/** A chat-tier instance on an allow-listed model other than `QUOKY_OPENAI_MODEL` (`openai-api:<model>`). */
export function openAiChatVariant(config: OpenAiApiConfig, model: string): AiProvider {
  return new OpenAiApiProvider({
    apiKey: config.apiKey,
    model,
    providerId: `${OPENAI_CHAT_PROVIDER_ID}:${model}`,
    replyHygiene: openAiReplyHygiene,
  });
}

/** The image-understanding instance on `QUOKY_OPENAI_MODEL` (`openai-vision-api`). */
export function openAiVision(config: OpenAiApiConfig): AiProvider {
  return new OpenAiApiVisionProvider({ apiKey: config.apiKey, model: config.model, replyHygiene: openAiReplyHygiene });
}
