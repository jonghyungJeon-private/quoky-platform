import { GEMINI_CHAT_PROVIDER_ID, GeminiApiProvider, GeminiApiVisionProvider, GeminiSharedProbe } from '@quoky/ai-gemini-api';
import type { AiProvider } from '@quoky/core';
import type { GeminiApiConfig } from './config';
import { openAiReplyHygiene } from './openai-provider-composition';

/**
 * Composition of the Gemini API providers (ADR-0115 D4, PRV-2), the same shape as the OpenAI composition. The adapter
 * (`@quoky/ai-gemini-api`) depends only on `@quoky/core`; the composition root injects the provider-neutral chat reply
 * hygiene the CLI and OpenAI providers apply (ADR-0098 D2 and amendment D2 — `openAiReplyHygiene` is provider-neutral
 * despite its name).
 *
 * The key holder is passed only into the adapter constructors here; it never reaches Core, a log line or the selection
 * service. The chat and image instances on the configured model share ONE readiness probe.
 */

const sharedProbes = new WeakMap<GeminiApiConfig, GeminiSharedProbe>();

function sharedProbeOf(config: GeminiApiConfig): GeminiSharedProbe {
  let probe = sharedProbes.get(config);
  if (probe === undefined) {
    probe = new GeminiSharedProbe();
    sharedProbes.set(config, probe);
  }
  return probe;
}

/** The provider-neutral chat reply hygiene, applied to every Gemini reply. */
export const geminiReplyHygiene = openAiReplyHygiene;

/** The chat-tier instance on `QUOKY_GEMINI_MODEL` (`gemini-api`). */
export function geminiChat(config: GeminiApiConfig): AiProvider {
  return new GeminiApiProvider({
    apiKey: config.apiKey,
    model: config.model,
    replyHygiene: geminiReplyHygiene,
    sharedProbe: sharedProbeOf(config),
  });
}

/** A chat-tier instance on an allow-listed model other than `QUOKY_GEMINI_MODEL` (`gemini-api:<model>`). */
export function geminiChatVariant(config: GeminiApiConfig, model: string): AiProvider {
  return new GeminiApiProvider({
    apiKey: config.apiKey,
    model,
    providerId: `${GEMINI_CHAT_PROVIDER_ID}:${model}`,
    replyHygiene: geminiReplyHygiene,
  });
}

/** The image-understanding instance on `QUOKY_GEMINI_MODEL` (`gemini-vision-api`). */
export function geminiVision(config: GeminiApiConfig): AiProvider {
  return new GeminiApiVisionProvider({
    apiKey: config.apiKey,
    model: config.model,
    replyHygiene: geminiReplyHygiene,
    sharedProbe: sharedProbeOf(config),
  });
}
