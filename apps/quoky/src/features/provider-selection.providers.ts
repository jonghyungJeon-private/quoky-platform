import type { Provider } from '@nestjs/common';
import { listLocalOllamaModels } from '@quoky/ai-cli';
import { AiProviderManager, SessionManager, STORAGE_PROVIDER } from '@quoky/core';
import type { ConversationTurnHandler, StorageProvider } from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import type { QuokyConfig } from '../config';
import { envImageSelectionOf } from '../image-understanding-provider';
import { ModelSelectionTurnHandler } from '../provider-selection/model-command-turn-handler';
import type { ProviderCatalog } from '../provider-selection/provider-catalog';
import { ProviderSelectionService } from '../provider-selection/provider-selection-service';
import type { ProviderSelectionStore } from '../provider-selection/selection-store';

/**
 * The owner's runtime model switch (ADR-0092 amendment and ADR-0111 amendment, runtime switching) — feature
 * composition (ADR-0096 D7):
 *
 * - `ProviderSelectionService` — the effective selection (session → persisted operations-UI default → env → derived
 *   default) and the Core `ProviderSelectionPolicy` the `CapabilityRouter` consults; it also resolves the Core image
 *   locality policy per request. Sessions are read at call time (repositories exist after `storage.init()`), and a
 *   session override is written field-scoped through `SessionManager.updateMetadataEntry` (shared session write lock).
 * - `MODEL_SELECTION_TURN_HANDLERS` — the `pre-classify` order-70 owner command handler (`모델 상태`, `모델 목록`,
 *   `모델 변경: …`, `/model …`); `turn-handlers.providers.ts` concatenates it.
 */

export const MODEL_SELECTION_TURN_HANDLERS = Symbol('ModelSelectionTurnHandlers');

export interface ProviderSelectionComposition {
  readonly config: Pick<QuokyConfig, 'ai' | 'imageUnderstanding' | 'imageUnderstandingOptions'> & {
    readonly discord: Pick<QuokyConfig['discord'], 'ownerIds'>;
  };
  readonly catalog: ProviderCatalog;
  readonly store: ProviderSelectionStore;
}

export function createProviderSelectionProviders(input: ProviderSelectionComposition): Provider[] {
  const { config, catalog, store } = input;
  return [
    {
      provide: ProviderSelectionService,
      useFactory: (storage: StorageProvider, manager: AiProviderManager, sessions: SessionManager) =>
        new ProviderSelectionService({
          catalog,
          envChat: {
            choice: { provider: config.ai.chat.provider },
            source: config.ai.chat.source === 'QUOKY_CHAT_PROVIDER' ? 'env' : 'default',
          },
          envImage: envImageSelectionOf(config),
          store,
          sessions: () => storage.sessions,
          updateSessionEntry: (sessionId, key, update, onCommitted) =>
            sessions.updateMetadataEntry({ id: sessionId }, key, update, { onCommitted }),
          readiness: (provider) => manager.isReady(provider),
          ollamaModels: () => listLocalOllamaModels(config.ai.ollamaBin),
          logger: new ConsoleLogger('provider-selection'),
        }),
      inject: [STORAGE_PROVIDER, AiProviderManager, SessionManager],
    },
    {
      provide: MODEL_SELECTION_TURN_HANDLERS,
      useFactory: (service: ProviderSelectionService): readonly ConversationTurnHandler[] => [
        new ModelSelectionTurnHandler({
          service,
          ownerIds: config.discord.ownerIds,
          logger: new ConsoleLogger('model-selection'),
        }),
      ],
      inject: [ProviderSelectionService],
    },
  ];
}
