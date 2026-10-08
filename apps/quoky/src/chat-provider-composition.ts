import { ClaudeCliProvider, CodexCliProvider, OllamaCliProvider } from '@quoky/ai-cli';
import type { AiProvider, Logger } from '@quoky/core';
import type { QuokyConfig } from './config';
import type { ChatChoice } from './provider-selection/selection-choices';

/**
 * The chat providers for the composition root's `AI_PROVIDERS` list (ADR-0092, its 2026-10-07 amendment and the
 * runtime-switching amendment).
 *
 * Registration is by what CAN run on this host; which one answers is the owner's selection, applied by the router's
 * `ProviderSelectionPolicy` (session override → operations-UI default → `QUOKY_CHAT_PROVIDER` → derived default):
 *
 * - **Claude** is always registered (and keeps code, review, planning and policy-sensitive chat).
 * - **Codex** is registered when the configured selection or the persisted default names it (as before: an unready
 *   Codex falls back to Claude at selection time), or when its CLI is present on this host, so the owner can switch to
 *   it without a restart.
 * - **Ollama chat** is registered when the configured selection or the persisted default names it (as before), or when
 *   `OLLAMA_MODEL` is set and the CLI is present. Registration loads no model: readiness is `ollama list`, and the
 *   model runs only when a request is executed.
 *
 * Construction spawns nothing (the CLI presence check is a filesystem lookup); readiness is probed by the provider
 * manager only when a provider is eligible for a selection. Embedding and image providers are composed separately.
 */

export interface ChatProviderRegistrationOptions {
  /** Whether a CLI binary can be started (a filesystem lookup). Default: none present (offline tests). */
  readonly cliPresent?: (bin: string) => boolean;
  /** The persisted operations-UI default (it may name a provider the configuration does not). */
  readonly persistedChat?: ChatChoice;
}

export interface ChatProviderRegistration {
  /** In registration order: Claude first, then Ollama, then Codex. */
  readonly providers: readonly AiProvider[];
  readonly claude: AiProvider;
  readonly codex?: AiProvider;
  readonly ollama?: AiProvider;
}

export function composeChatProviders(
  ai: QuokyConfig['ai'],
  logger: Pick<Logger, 'info' | 'warn'>,
  options: ChatProviderRegistrationOptions = {},
): ChatProviderRegistration {
  const { chat } = ai;
  if (chat.warning !== undefined) {
    logger.warn('QUOKY_CHAT_PROVIDER overrides a contradicting QUOKY_OLLAMA_ENABLED', {
      code: chat.warning,
      chatProvider: chat.provider,
    });
  }
  logger.info('chat provider selected', { chatProvider: chat.provider, source: chat.source });

  const present = options.cliPresent ?? (() => false);
  const persisted = options.persistedChat?.provider;
  const claude = new ClaudeCliProvider(ai.claudeBin, { model: ai.claudeModel });
  const wantsOllama =
    chat.provider === 'ollama' || persisted === 'ollama' || (ai.ollamaModelConfigured === true && present(ai.ollamaBin));
  const wantsCodex = chat.provider === 'codex' || persisted === 'codex' || present(ai.codexBin);
  const ollama = wantsOllama ? new OllamaCliProvider({ bin: ai.ollamaBin, model: ai.ollamaModel }) : undefined;
  const codex = wantsCodex
    ? new CodexCliProvider(ai.codexBin, {
        ...(ai.codexModel === undefined ? {} : { model: ai.codexModel }),
        cleanup: { logger },
      })
    : undefined;
  const providers = [claude, ...(ollama ? [ollama] : []), ...(codex ? [codex] : [])];
  return { providers, claude, ...(codex ? { codex } : {}), ...(ollama ? { ollama } : {}) };
}

/** The registered chat providers as a list (see {@link composeChatProviders}). */
export function createChatAiProviders(
  ai: QuokyConfig['ai'],
  logger: Pick<Logger, 'info' | 'warn'>,
  options: ChatProviderRegistrationOptions = {},
): AiProvider[] {
  return [...composeChatProviders(ai, logger, options).providers];
}
