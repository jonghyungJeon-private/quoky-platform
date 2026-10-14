import type { Provider } from '@nestjs/common';
import {
  CapabilityRouter,
  NlActionSwitch,
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
 *
 * ADR-0120 amendment A6: `QUOKY_NL_ACTIONS` (default `off`) is passed through with the persisted kill switch, which is
 * always built here over the same live `storage.actors` repository (`Actor.metadata['quoky.actionSwitch']`, no new port,
 * no migration). The service refuses to start with a level other than `off` unless the mode is `active` and the switch
 * exists. The service is also a delivery observer (`NL_DELIVERY_OBSERVERS`): it binds an action's echo ids.
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
        const actors = {
          get: (id: string) => storage.actors.get(id),
          save: (actor: Parameters<StorageProvider['actors']['save']>[0]) => storage.actors.save(actor),
        };
        const killSwitch = new NlActionSwitch({ actors, logger });
        return new NlSelectionService({
          ...(config.nlSelection.actions !== 'off' ? { actions: { level: config.nlSelection.actions, killSwitch } } : {}),
          mode: config.nlSelection.mode,
          grammarYield: config.nlSelection.grammarYield,
          phase: config.nlSelection.phase,
          timeoutMs: config.nlSelection.timeoutMs,
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
