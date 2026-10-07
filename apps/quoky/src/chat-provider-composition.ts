import { ClaudeCliProvider, CodexCliProvider, OllamaCliProvider } from '@quoky/ai-cli';
import type { AiProvider, Logger } from '@quoky/core';
import type { QuokyConfig } from './config';

/**
 * The chat providers for the composition root's `AI_PROVIDERS` list (ADR-0092 and its 2026-10-07 amendment). Chat
 * preference is still expressed only by registration; the selector (`QUOKY_CHAT_PROVIDER`, or its back-compat
 * derivation from `QUOKY_OLLAMA_ENABLED`) only decides which provider is registered next to Claude:
 *
 * - `claude`: Claude only (the old `QUOKY_OLLAMA_ENABLED=false`).
 * - `ollama`: Ollama + Claude (the old default).
 * - `codex`: Codex + Claude. Codex advertises only the chat-tier capabilities at a priority above Claude's, so the
 *   router picks it for those by priority; code, review, planning and policy-sensitive chat stay on Claude, which is
 *   also the selection-time fallback when Codex is not ready.
 *
 * Claude is always registered. Embedding and image providers are composed separately and are not affected.
 * Construction spawns nothing; readiness is probed by the provider manager when a capability is selected.
 */
export function createChatAiProviders(ai: QuokyConfig['ai'], logger: Pick<Logger, 'info' | 'warn'>): AiProvider[] {
  const { chat } = ai;
  if (chat.warning !== undefined) {
    logger.warn('QUOKY_CHAT_PROVIDER overrides a contradicting QUOKY_OLLAMA_ENABLED', {
      code: chat.warning,
      chatProvider: chat.provider,
    });
  }
  logger.info('chat provider selected', { chatProvider: chat.provider, source: chat.source });

  const claude = new ClaudeCliProvider(ai.claudeBin, { model: ai.claudeModel });
  switch (chat.provider) {
    case 'claude':
      return [claude];
    case 'ollama':
      return [claude, new OllamaCliProvider({ bin: ai.ollamaBin, model: ai.ollamaModel })];
    case 'codex':
      return [claude, new CodexCliProvider(ai.codexBin, ai.codexModel === undefined ? {} : { model: ai.codexModel })];
  }
}
