import type { Provider } from '@nestjs/common';
import {
  CapabilityRouter,
  NlSelectionService,
  STORAGE_PROVIDER,
  SessionManager,
  type Logger,
  type StorageProvider,
} from '@quoky/core';
import { ConsoleLogger } from '../console-logger';
import type { NlSelectionConfig } from '../nl-selection/nl-selection-config';

/**
 * Natural-language capability selection (ADR-0120) — feature composition. Binds `NL_SELECTION` to the Core
 * `NlSelectionService` over collaborators the app already registers: the `CapabilityRouter` (the selector is whichever
 * provider advertises `INTENT_SELECTION` — the Claude CLI only, D2), the `SessionManager` (field-scoped
 * `Session.metadata` writes) and the live `storage.actors` repository (the D7 preferences in `Actor.metadata`, resolved
 * at call time because the SQLite repositories exist only after `storage.init()`, QA-001).
 *
 * `QUOKY_NL_INTENT_MODE=off` (the default) builds the service in `off` mode: the runtime then never calls it and every
 * turn is byte-identical. The runtime receives it as its optional `nlSelection` dep (D14, baseline 36).
 */

export const NL_SELECTION = Symbol('NlSelection');

export interface NlSelectionFeatureConfig {
  readonly nlSelection: NlSelectionConfig;
  /** `QUOKY_TIMEZONE`: symbolic periods are placed in this zone. */
  readonly timeZone: string;
}

export interface NlSelectionCompositionOptions {
  readonly logger?: Logger;
}

export function createNlSelectionProviders(
  resolveConfig: () => NlSelectionFeatureConfig,
  options: NlSelectionCompositionOptions = {},
): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('nl-selection');
  return [
    {
      provide: NL_SELECTION,
      useFactory: (router: CapabilityRouter, sessions: SessionManager, storage: StorageProvider): NlSelectionService => {
        const config = resolveConfig();
        return new NlSelectionService({
          mode: config.nlSelection.mode,
          router,
          sessions,
          actors: {
            get: (id) => storage.actors.get(id),
            save: (actor) => storage.actors.save(actor),
          },
          timeZone: config.timeZone,
          logger,
        });
      },
      inject: [CapabilityRouter, SessionManager, STORAGE_PROVIDER],
    },
  ];
}
