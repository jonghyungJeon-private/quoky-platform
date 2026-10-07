import { ClaudeCliVisionProvider, OllamaCliVisionProvider } from '@quoky/ai-cli';
import type { AiExecutionLocality, AiProvider, Logger } from '@quoky/core';
import type { ImageUnderstandingConfig } from './config';

/**
 * ADR-0111 D4/D5 (MM-2) and its 2026-10-07 amendment (A1/A2): the composition of image understanding. The selection
 * itself (`QUOKY_IMAGE_UNDERSTANDING_PROVIDER`, `QUOKY_OLLAMA_VISION_MODEL`, `QUOKY_IMAGE_UNDERSTANDING_MODEL`) is parsed
 * and validated in `config.ts` (`parseImageUnderstandingConfig`); this module turns it into exactly ONE registered
 * `IMAGE_UNDERSTANDING` provider (or none) and the matching Core image policy. Core never sees the selection — only
 * the providers' declared capability and locality, and the allowed localities.
 *
 * - `ollama`: the local Ollama vision provider (`LOCAL`); the Ollama binary is the one chat uses (`OLLAMA_CLI_BIN`).
 *   Registration is independent of `QUOKY_OLLAMA_ENABLED` (that flag registers the chat model only).
 * - `claude`: the Claude CLI vision provider (`REMOTE`) on the chat CLI binary (`CLAUDE_CLI_BIN`); the policy then
 *   also allows `REMOTE` — the owner's explicit cloud opt-in.
 * - `off`: nothing; the policy stays local-only.
 */

/** The localities Core may send image bytes to for this selection (ADR-0111 amendment A2). */
export function imageUnderstandingLocalitiesFor(config: ImageUnderstandingConfig): readonly AiExecutionLocality[] {
  return config.provider === 'claude' ? ['LOCAL', 'REMOTE'] : ['LOCAL'];
}

/** A short, value-free description of the selection for the operations UI and startup logs (never a model name). */
export function describeImageUnderstandingSelection(config: ImageUnderstandingConfig): {
  readonly selection: ImageUnderstandingConfig['provider'];
  readonly locality: AiExecutionLocality | 'NONE';
} {
  if (config.provider === 'claude') return { selection: 'claude', locality: 'REMOTE' };
  if (config.provider === 'ollama') return { selection: 'ollama', locality: 'LOCAL' };
  return { selection: 'off', locality: 'NONE' };
}

export function createImageUnderstandingProviders(
  config: ImageUnderstandingConfig,
  options: { ollamaBin: string; claudeBin: string; logger: Logger },
): AiProvider[] {
  switch (config.provider) {
    case 'ollama':
      return [new OllamaCliVisionProvider({ bin: options.ollamaBin, model: config.model })];
    case 'claude':
      options.logger.info('image understanding uses a cloud provider', { selection: 'claude', locality: 'REMOTE' });
      return [new ClaudeCliVisionProvider({ bin: options.claudeBin, model: config.model })];
    case 'off':
      if (config.invalid) options.logger.warn('image understanding not registered', { reason: config.invalid });
      return [];
  }
}
