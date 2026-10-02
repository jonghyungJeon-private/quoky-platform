import type { Provider } from '@nestjs/common';
import {
  ConnectorManager,
  WorkChatService,
  WorkManager,
  WorkSurfaceQuery,
  createWorkChatTurnHandlers,
  type ConversationTurnHandler,
  type Logger,
} from '@quoky/core';
import { loadConfig, type QuokyConfig } from '../config';
import { ConsoleLogger } from '../console-logger';
import { WORK_CHAT_TURN_HANDLERS } from './feature-tokens';

/**
 * Chat-usable work integrations (ADR-0100) — feature composition (ADR-0096 D7, WORK-T5). Every work-chat binding
 * lives here and only here (no `app.module.ts`, `config.ts` or runtime edit):
 *
 * - `WORK_CHAT_FEATURE_CONFIG` — the parsed `config.work` (`QUOKY_WORK_SUMMARY_ENABLED`, SEAM-2);
 * - `WorkChatService` — the `WorkDesk` over the already-registered `WorkSurfaceQuery`, `ConnectorManager` and
 *   `WorkManager`. `WorkManager` holds the LIVE storage object and resolves repositories at call time, so nothing
 *   is captured before `storage.init()` (QA-001). Connectors come from the existing read-only connector providers;
 *   a connector that is not configured makes the handler answer with the existing not-configured copy;
 * - `WORK_CHAT_TURN_HANDLERS` — the order-100 to-do mutation handler and the order-300 lookup handler. The
 *   lookup handler returns a `summarize` outcome only with summaries enabled; the runtime alone decides whether a
 *   SUMMARIZATION provider runs, and this feature never touches a provider.
 */

type WorkChatFeatureConfig = QuokyConfig['work'];

/** App-local token for this feature's parsed config (SEAM-2 `config.work`). */
export const WORK_CHAT_FEATURE_CONFIG = Symbol('WorkChatFeatureConfig');

/** Composition seam for offline acceptance only; production passes none (console logger). */
export interface WorkChatCompositionOptions {
  readonly logger?: Logger;
}

export function createWorkChatProviders(
  resolveConfig: () => WorkChatFeatureConfig,
  options: WorkChatCompositionOptions = {},
): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('work-chat');
  return [
    { provide: WORK_CHAT_FEATURE_CONFIG, useFactory: resolveConfig },
    {
      provide: WorkChatService,
      useFactory: (
        config: WorkChatFeatureConfig,
        workSurface: WorkSurfaceQuery,
        connectors: ConnectorManager,
        work: WorkManager,
      ) => new WorkChatService({ workSurface, connectors, work }, { summaryEnabled: config.summaryEnabled }),
      inject: [WORK_CHAT_FEATURE_CONFIG, WorkSurfaceQuery, ConnectorManager, WorkManager],
    },
    {
      provide: WORK_CHAT_TURN_HANDLERS,
      useFactory: (config: WorkChatFeatureConfig, desk: WorkChatService): readonly ConversationTurnHandler[] =>
        createWorkChatTurnHandlers({ desk, summaryEnabled: config.summaryEnabled, logger }),
      inject: [WORK_CHAT_FEATURE_CONFIG, WorkChatService],
    },
  ];
}

export const workChatProviders: Provider[] = createWorkChatProviders(() => loadConfig().work);
