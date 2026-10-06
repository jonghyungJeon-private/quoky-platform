import { OllamaCliVisionProvider, ollamaModelExecutionLocality } from '@quoky/ai-cli';
import type { AiProvider, Logger } from '@quoky/core';

/**
 * MM-2 configuration (ADR-0111 D4/D5), parsed here from the process environment and not in `config.ts` (owned by
 * CWR-1 in wave 4; a later `config.ts` owner folds the key into `config.ts`/`.env.example` without changing its
 * meaning). A new `QUOKY_*` key with no `CHUNSIK_*` alias.
 *
 * - `QUOKY_OLLAMA_VISION_MODEL`: the operator-chosen local Ollama vision model (for example `gemma3:4b`). Unset or
 *   empty means no image provider is registered and image turns get the deterministic "unavailable" reply.
 *
 * The model must be a plain Ollama model name and must run on this host: a cloud-served model (`*cloud*`, ADR-0107
 * D6) is refused, because image bytes go only to a `LOCAL` provider (owner decision 9). An invalid value disables only
 * image understanding (fail closed) with a code the composition logs; it never stops Quoky and is never echoed.
 * The Ollama binary is the one chat uses (`OLLAMA_CLI_BIN`). Registration is independent of `QUOKY_OLLAMA_ENABLED`
 * (that flag registers the chat model only).
 */

export const ImageUnderstandingConfigErrorCode = {
  VISION_MODEL_INVALID: 'OLLAMA_VISION_MODEL_INVALID',
  VISION_MODEL_NOT_LOCAL: 'OLLAMA_VISION_MODEL_NOT_LOCAL',
} as const;
export type ImageUnderstandingConfigErrorCode =
  (typeof ImageUnderstandingConfigErrorCode)[keyof typeof ImageUnderstandingConfigErrorCode];

export type ImageUnderstandingConfig =
  | { readonly enabled: false; readonly invalid?: ImageUnderstandingConfigErrorCode }
  | { readonly enabled: true; readonly model: string };

export function loadImageUnderstandingConfig(env: NodeJS.ProcessEnv): ImageUnderstandingConfig {
  const model = env.QUOKY_OLLAMA_VISION_MODEL?.trim();
  if (model === undefined || model === '') return { enabled: false };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) {
    return { enabled: false, invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_INVALID };
  }
  if (ollamaModelExecutionLocality(model) !== 'LOCAL') {
    return { enabled: false, invalid: ImageUnderstandingConfigErrorCode.VISION_MODEL_NOT_LOCAL };
  }
  return { enabled: true, model };
}

/**
 * The `IMAGE_UNDERSTANDING` providers for the composition root's `AI_PROVIDERS` list: one local Ollama vision provider
 * when `QUOKY_OLLAMA_VISION_MODEL` is set and valid, otherwise none. Construction spawns nothing; readiness is probed
 * by the provider manager when an image turn selects the capability.
 */
export function createImageUnderstandingProviders(
  env: NodeJS.ProcessEnv,
  options: { ollamaBin: string; logger: Logger },
): AiProvider[] {
  const config = loadImageUnderstandingConfig(env);
  if (!config.enabled) {
    if (config.invalid) options.logger.warn('image understanding not registered', { reason: config.invalid });
    return [];
  }
  return [new OllamaCliVisionProvider({ bin: options.ollamaBin, model: config.model })];
}
