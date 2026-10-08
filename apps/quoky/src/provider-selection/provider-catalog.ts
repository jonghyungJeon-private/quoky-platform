import {
  ClaudeCliProvider,
  ClaudeCliVisionProvider,
  CodexCliVisionProvider,
  OllamaCliProvider,
  OllamaCliVisionProvider,
  sameOllamaModel,
} from '@quoky/ai-cli';
import { AiFailureKind, AiProviderError } from '@quoky/core';
import type { AiProvider, Logger } from '@quoky/core';
import { composeChatProviders } from '../chat-provider-composition';
import type { QuokyConfig } from '../config';
import { openAiChatVariant, openAiVision } from '../openai-provider-composition';
import { CHAT_TIER_CAPABILITIES } from './selection-choices';
import type { ChatChoice, ChatProviderName, ImageChoice } from './selection-choices';

/**
 * The registered providers the owner's runtime switch chooses among (ADR-0092 amendment and ADR-0111 amendment,
 * runtime switching), and the one place that maps a choice (`claude:opus`, `codex`, `ollama:granite3.3:8b`, image
 * `claude`) to a registered provider instance. The map is composition-root data: the router only sees the opaque
 * keys (provider ids) the policy hands it.
 *
 * - The list ({@link ProviderCatalog.providers}) IS the `AI_PROVIDERS` array the provider manager holds. A choice of a
 *   Claude alias other than `QUOKY_CLAUDE_MODEL`, or of an Ollama model other than `OLLAMA_MODEL`, adds one bounded,
 *   chat-tier-only instance to it on first use (construction spawns nothing; an Ollama instance loads no model until a
 *   request runs on it).
 * - Image: the Claude vision provider (cloud) is registered whenever its model is valid, the Codex vision provider
 *   (cloud) when the Codex CLI is present or `codex` is the configured or persisted image choice (ADR-0111 amendment of
 *   2026-10-08), the Ollama vision provider when `QUOKY_OLLAMA_VISION_MODEL` is a valid local model. Which one may run — and whether image bytes may leave the host
 *   at all — is decided per request by the policy and the Core image locality policy.
 * - OpenAI API (ADR-0115 D3): the chat instance (`openai-api`) and the image instance (`openai-vision-api`) are
 *   registered only when `QUOKY_OPENAI_API_KEY` and `QUOKY_OPENAI_MODEL` are configured. A choice of another allow-listed
 *   OpenAI model adds one bounded chat-tier instance (`openai-api:<model>`), like a Claude alias. Each is eligible only
 *   while it is the effective chat or image choice; construction makes no network call.
 */

/** At most this many on-demand instances (Claude aliases, extra Ollama models, extra OpenAI models) are ever added. */
export const MAX_ON_DEMAND_PROVIDERS = 12;

export interface ProviderFactories {
  claudeVariant(model: string): AiProvider;
  ollamaVariant(model: string): AiProvider;
  claudeVision(model: string): AiProvider;
  /** The Codex vision provider on `QUOKY_CODEX_MODEL` (absent = the CLI default). */
  codexVision(model: string | undefined): AiProvider;
  ollamaVision(model: string): AiProvider;
  /** A chat-tier OpenAI API instance on an allow-listed model other than `QUOKY_OPENAI_MODEL`. */
  openaiVariant(model: string): AiProvider;
  /** The OpenAI API image instance on `QUOKY_OPENAI_MODEL`. */
  openaiVision(): AiProvider;
}

export interface ProviderCatalogInput {
  readonly ai: QuokyConfig['ai'];
  /** The vision models each image option would use (absent = that option is unavailable on this host). */
  readonly vision: { readonly claudeModel?: string; readonly ollamaModel?: string; readonly codexSelected?: boolean };
  /** The persisted operations-UI default, read before composition (it may name a provider the env does not). */
  readonly persistedChat?: ChatChoice;
  /** The persisted operations-UI image default (a persisted `codex` registers the Codex vision provider). */
  readonly persistedImage?: ImageChoice;
  readonly cliPresent: (bin: string) => boolean;
  /** Providers registered between the chat and the image providers (the opt-in embedding provider). */
  readonly extra?: readonly AiProvider[];
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** Offline-test seams; production passes none. */
  readonly factories?: Partial<ProviderFactories>;
}

const CHAT_TIER = new Set(CHAT_TIER_CAPABILITIES);

/**
 * A registered view of `inner` that serves ONLY the chat tier under its own id — an on-demand model choice never
 * becomes a candidate for code, review, planning or policy-sensitive chat, and refuses them before spawning.
 */
export function chatTierView(inner: AiProvider, id: string): AiProvider {
  return {
    id,
    capabilities: inner.capabilities.filter((descriptor) => CHAT_TIER.has(descriptor.capability)),
    ...(inner.executionLocality !== undefined ? { executionLocality: inner.executionLocality } : {}),
    isAvailable: () => inner.isAvailable(),
    execute: async (request) => {
      if (!CHAT_TIER.has(request.capability)) {
        throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'this model choice serves the chat tier only');
      }
      return inner.execute(request);
    },
  };
}

export class ProviderCatalog {
  /** The live `AI_PROVIDERS` list. */
  readonly providers: AiProvider[];
  readonly claude: AiProvider;
  readonly codex: AiProvider | undefined;
  /** The `OLLAMA_MODEL` chat instance. */
  readonly ollama: AiProvider | undefined;
  readonly claudeVision: AiProvider | undefined;
  readonly codexVision: AiProvider | undefined;
  readonly ollamaVision: AiProvider | undefined;
  /** The `QUOKY_OPENAI_MODEL` chat instance (absent unless the OpenAI API is configured). */
  readonly openai: AiProvider | undefined;
  readonly openaiVision: AiProvider | undefined;
  /** Whether an Ollama model other than `OLLAMA_MODEL` may be added (the CLI is present or Ollama is registered). */
  readonly ollamaUsable: boolean;
  readonly claudeModel: string;
  readonly ollamaModel: string;
  readonly codexModel: string | undefined;
  readonly openaiModel: string | undefined;
  private readonly onDemand = new Map<string, AiProvider>();
  private readonly factories: ProviderFactories;

  constructor(input: ProviderCatalogInput) {
    const { ai } = input;
    const chat = composeChatProviders(ai, input.logger, {
      cliPresent: input.cliPresent,
      ...(input.persistedChat ? { persistedChat: input.persistedChat } : {}),
    });
    this.factories = {
      claudeVariant: (model) => new ClaudeCliProvider(ai.claudeBin, { model }),
      ollamaVariant: (model) => new OllamaCliProvider({ bin: ai.ollamaBin, model }),
      claudeVision: (model) => new ClaudeCliVisionProvider({ bin: ai.claudeBin, model }),
      codexVision: (model) =>
        new CodexCliVisionProvider({
          bin: ai.codexBin,
          ...(model !== undefined ? { model } : {}),
          // A failed temp-directory cleanup is logged as a value-free code (never a path) and retried once.
          cleanup: { logger: input.logger },
        }),
      ollamaVision: (model) => new OllamaCliVisionProvider({ bin: ai.ollamaBin, model }),
      // Only reached when `ai.openai` is configured (see `canChoose` / the registration below).
      openaiVariant: (model) => openAiChatVariant(requireOpenAi(ai), model),
      openaiVision: () => openAiVision(requireOpenAi(ai)),
      ...input.factories,
    };
    this.claude = chat.claude;
    this.codex = chat.codex;
    this.ollama = chat.ollama;
    this.claudeModel = ai.claudeModel;
    this.ollamaModel = ai.ollamaModel;
    this.codexModel = ai.codexModel;
    this.openai = chat.openai;
    this.openaiModel = ai.openai?.model;
    this.ollamaUsable = chat.ollama !== undefined || input.cliPresent(ai.ollamaBin);
    this.claudeVision = input.vision.claudeModel !== undefined ? this.factories.claudeVision(input.vision.claudeModel) : undefined;
    this.ollamaVision = input.vision.ollamaModel !== undefined ? this.factories.ollamaVision(input.vision.ollamaModel) : undefined;
    // Like the chat Codex provider: registered when it can run here or when a selection names it (an unready Codex then
    // shows as not ready). Construction spawns nothing.
    const wantsCodexVision =
      input.vision.codexSelected === true || input.persistedImage === 'codex' || input.cliPresent(ai.codexBin);
    this.codexVision = wantsCodexVision ? this.factories.codexVision(ai.codexModel) : undefined;
    this.openaiVision = ai.openai !== undefined ? this.factories.openaiVision() : undefined;
    this.providers = [
      ...chat.providers,
      ...(input.extra ?? []),
      ...(this.ollamaVision ? [this.ollamaVision] : []),
      ...(this.claudeVision ? [this.claudeVision] : []),
      ...(this.codexVision ? [this.codexVision] : []),
      ...(this.openaiVision ? [this.openaiVision] : []),
    ];
  }

  /** Whether a chat provider can be chosen on this host at all (Claude always; Codex/Ollama/OpenAI when registrable). */
  canChoose(provider: ChatProviderName): boolean {
    if (provider === 'claude') return true;
    if (provider === 'codex') return this.codex !== undefined;
    if (provider === 'openai') return this.openai !== undefined;
    return this.ollamaUsable;
  }

  /** The choice with a model equal to the configured default folded into "the default" (`model` absent). */
  normalize(choice: ChatChoice): ChatChoice {
    if (choice.provider === 'claude' && choice.model !== undefined && choice.model === this.claudeModel) {
      return { provider: 'claude' };
    }
    // Folded only when the `OLLAMA_MODEL` instance is registered; otherwise the model is an on-demand choice.
    if (
      choice.provider === 'ollama' &&
      choice.model !== undefined &&
      this.ollama !== undefined &&
      sameOllamaModel(choice.model, this.ollamaModel)
    ) {
      return { provider: 'ollama' };
    }
    if (choice.provider === 'openai' && choice.model !== undefined && choice.model === this.openaiModel) {
      return { provider: 'openai' };
    }
    return choice;
  }

  /** The owner-facing label: `claude:sonnet`, `codex`, `ollama:llama3.1`, `openai:gpt-4.1-mini`. */
  label(choice: ChatChoice): string {
    const normalized = this.normalize(choice);
    if (normalized.provider === 'codex') return 'codex';
    if (normalized.provider === 'claude') return `claude:${normalized.model ?? this.claudeModel}`;
    if (normalized.provider === 'openai') return `openai:${normalized.model ?? this.openaiModel ?? 'default'}`;
    return `ollama:${normalized.model ?? this.ollamaModel}`;
  }

  /**
   * The registered provider that serves `choice`, adding an on-demand instance when the choice names a non-default
   * model; `undefined` when the choice cannot run here (Codex not registered, Ollama absent, the on-demand bound hit).
   */
  resolveChat(choice: ChatChoice): AiProvider | undefined {
    const normalized = this.normalize(choice);
    if (normalized.provider === 'codex') return this.codex;
    if (normalized.provider === 'openai') {
      if (this.openai === undefined) return undefined;
      return normalized.model === undefined ? this.openai : this.onDemandInstance(`openai:${normalized.model}`, () =>
        chatTierView(this.factories.openaiVariant(normalized.model as string), `openai-api:${normalized.model}`),
      );
    }
    if (normalized.provider === 'claude') {
      return normalized.model === undefined ? this.claude : this.onDemandInstance(`claude:${normalized.model}`, () =>
        chatTierView(this.factories.claudeVariant(normalized.model as string), `claude-cli:${normalized.model}`),
      );
    }
    if (normalized.model === undefined) return this.ollama;
    if (!this.ollamaUsable) return undefined;
    return this.onDemandInstance(`ollama:${normalized.model}`, () =>
      chatTierView(this.factories.ollamaVariant(normalized.model as string), `ollama-cli:${normalized.model}`),
    );
  }

  /** The registered image provider for `choice`; `null` for `off`, `undefined` when that option is unavailable. */
  resolveImage(choice: ImageChoice): AiProvider | null | undefined {
    switch (choice) {
      case 'off':
        return null;
      case 'claude':
        return this.claudeVision;
      case 'codex':
        return this.codexVision;
      case 'ollama':
        return this.ollamaVision;
      case 'openai':
        return this.openaiVision;
    }
  }

  private onDemandInstance(key: string, create: () => AiProvider): AiProvider | undefined {
    const existing = this.onDemand.get(key);
    if (existing !== undefined) return existing;
    if (this.onDemand.size >= MAX_ON_DEMAND_PROVIDERS) return undefined;
    const provider = create();
    this.onDemand.set(key, provider);
    this.providers.push(provider);
    return provider;
  }
}

function requireOpenAi(ai: QuokyConfig['ai']): NonNullable<QuokyConfig['ai']['openai']> {
  if (ai.openai === undefined) throw new Error('the OpenAI API is not configured');
  return ai.openai;
}
