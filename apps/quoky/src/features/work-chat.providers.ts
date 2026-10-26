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
  /** ADR-0120 amendment A6: content-free action receipts on to-do replies (`QUOKY_NL_ACTIONS` not `off`). */
  readonly actionReceipts?: () => boolean;
  /**
   * ADR-0120 amendment A8: the configured Jira site host, so a Jira release link in the owner's words is used only when
   * it points at that site (any other link is ignored and never fetched).
   */
  readonly jiraSiteHost?: () => string | undefined;
  /** ADR-0120 amendment A6 R2: `QUOKY_NL_ITEM_R2` (numbered Jira / Slack lists and `item.summarize` over them). */
  readonly itemR2?: () => 'off' | 'shadow' | 'jira' | 'all';
  /** `QUOKY_TIMEZONE`: the release list orders by the owner's local date (owner decision Q4, 2026-10-23). */
  readonly timeZone?: () => string;
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
      ) => {
        const jiraSiteHost = options.jiraSiteHost?.();
        return new WorkChatService(
          { workSurface, connectors, work },
          {
            summaryEnabled: config.summaryEnabled,
            ...(options.actionReceipts?.() === true ? { actionReceipts: true } : {}),
            ...(jiraSiteHost !== undefined ? { linkHosts: { jira: jiraSiteHost } } : {}),
            ...((options.itemR2?.() ?? 'off') !== 'off' ? { numberedLists: true } : {}),
            ...(options.timeZone !== undefined ? { timeZone: options.timeZone() } : {}),
          },
        );
      },
      inject: [WORK_CHAT_FEATURE_CONFIG, WorkSurfaceQuery, ConnectorManager, WorkManager],
    },
    {
      provide: WORK_CHAT_TURN_HANDLERS,
      useFactory: (config: WorkChatFeatureConfig, desk: WorkChatService): readonly ConversationTurnHandler[] =>
        createWorkChatTurnHandlers({ desk, summaryEnabled: config.summaryEnabled, logger, itemR2: options.itemR2?.() ?? 'off' }),
      inject: [WORK_CHAT_FEATURE_CONFIG, WorkChatService],
    },
  ];
}

export const workChatProviders: Provider[] = createWorkChatProviders(() => loadConfig().work, {
  actionReceipts: () => loadConfig().nlSelection.actions !== 'off',
  jiraSiteHost: () => loadConfig().connectors.jira?.host,
  itemR2: () => loadConfig().nlSelection.itemR2,
  timeZone: () => loadConfig().reminders.timeZone,
});
