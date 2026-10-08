import type { Provider } from '@nestjs/common';
import type { DiscordConfig } from '@quoky/adapter-discord';
import {
  CALENDAR_READER,
  CONNECTOR_PROVIDERS,
  NOTIFICATION_SINK,
  PLATFORM_ADAPTER,
  REMINDER_REPOSITORY,
  STORAGE_PROVIDER,
  ReminderConversationService,
  ReminderDispatchService,
  ReminderReplyComposer,
  ReminderTurnHandler,
  type CalendarReader,
  type ConnectorProvider,
  type ConversationTurnHandler,
  type IsoTimestamp,
  type Logger,
  type NotificationSink,
  type PlatformAdapter,
  type ReminderRepository,
  type StorageProvider,
  type WorkItem,
} from '@quoky/core';
import { loadConfig } from '../config';
import { ConsoleLogger } from '../console-logger';
import { createBriefSources, type BriefActorStorageSeam } from '../reminders/brief-sources';
import type { ReminderConfig } from '../reminders/reminder-config';
import { ReminderTickDriver, type ReminderTickTimers } from '../reminders/reminder-tick-driver';
import { REMINDER_TURN_HANDLERS } from './feature-tokens';

/**
 * Proactive owner reminders (ADR-0101) — feature composition (ADR-0096 D7, PRO-5). Every reminder binding lives
 * here and only here (no `app.module.ts`, `config.ts` or runtime edit):
 *
 * - `REMINDER_REPOSITORY` — a CALL-TIME delegate over `storage.reminders` (QA-001: the SQLite repositories exist
 *   only after `storage.init()`, which runs after DI construction, so nothing is captured here);
 * - `NOTIFICATION_SINK` — the platform adapter itself (the Discord adapter implements the owner-only sink, PRO-4);
 * - the reply composer, the conversation and dispatch services (Core), the tick driver (composition root);
 * - `withReminderChannelDelivery` — the one reminder value the composition root reads: it applies the
 *   `QUOKY_REMINDERS_CHANNEL_DELIVERY` opt-in to the Discord adapter config behind `PLATFORM_ADAPTER`;
 * - `REMINDER_TURN_HANDLERS` — the always-registered order-200 `pre-classify` handler. With
 *   `QUOKY_REMINDERS_ENABLED=false` it still answers a reminder phrase with the fixed disabled reply and the tick
 *   driver never starts.
 *
 * The dispatch service's whole surface is repository + sink + composer + a read-only WorkItem lister + logger, and
 * — for the brief only (ADR-0117, BRF-1) — the read-only `CALENDAR_READER` when the calendar is configured and the
 * read-only Jira connector only with `QUOKY_BRIEF_JIRA_ENABLED=true` (`reminders/brief-sources.ts`). Both are
 * optional injections of existing bindings; no new token. No provider or tool reaches reminders.
 */

/**
 * The Discord adapter config with the reminder channel-delivery opt-in applied (ADR-0101 D8). The adapter owns
 * channel admission, so `QUOKY_REMINDERS_CHANNEL_DELIVERY` must reach it through its config; the composition root
 * builds `PLATFORM_ADAPTER` from this. Inert while reminders are off: `channelDelivery` is true only when
 * `QUOKY_REMINDERS_ENABLED=true` AND `QUOKY_REMINDERS_CHANNEL_DELIVERY=true`.
 */
export function withReminderChannelDelivery(
  discord: Omit<DiscordConfig, 'channelDelivery'>,
  reminders: Pick<ReminderConfig, 'enabled' | 'channelDelivery'>,
): DiscordConfig {
  return { ...discord, channelDelivery: reminders.enabled && reminders.channelDelivery };
}

/** App-local token for this feature's parsed config (SEAM-2 `config.reminders`). */
export const REMINDER_FEATURE_CONFIG = Symbol('ReminderFeatureConfig');

/** The storage members reminders read, resolved at call time (absent before `init()` or on other storage). */
interface ReminderStorageSeam {
  readonly reminders?: ReminderRepository;
  readonly workItems?: { listByActor(actorId: string): Promise<WorkItem[]> };
}

export class ReminderStorageUnavailableError extends Error {
  constructor() {
    super('reminder storage is not initialized');
    this.name = 'ReminderStorageUnavailableError';
  }
}

function liveReminders(storage: ReminderStorageSeam): ReminderRepository {
  const repository = storage.reminders;
  if (repository === undefined) throw new ReminderStorageUnavailableError();
  return repository;
}

/** Delegates every call to the storage's CURRENT `reminders` repository (never a pre-init snapshot). */
export function lazyReminderRepository(storage: ReminderStorageSeam): ReminderRepository {
  return {
    createWithinLimit: (draft, maxActive) => liveReminders(storage).createWithinLimit(draft, maxActive),
    listActiveByActor: (actorId) => liveReminders(storage).listActiveByActor(actorId),
    getByDisplayNo: (actorId, displayNo) => liveReminders(storage).getByDisplayNo(actorId, displayNo),
    cancel: (actorId, displayNo, at) => liveReminders(storage).cancel(actorId, displayNo, at),
    claimDue: (now, limit, attemptId) => liveReminders(storage).claimDue(now, limit, attemptId),
    completeFiring: (id, attemptId, completion) => liveReminders(storage).completeFiring(id, attemptId, completion),
    listFiring: () => liveReminders(storage).listFiring(),
  };
}

function isNotificationSink(value: unknown): value is NotificationSink {
  return typeof (value as { deliver?: unknown } | null)?.deliver === 'function';
}

/**
 * The platform adapter as the owner sink. A platform without one gets a fail-closed sink: every delivery is a
 * confirmed, non-retryable `NOT_SENT` (nothing transmitted), so no reminder can reach an unvetted target.
 */
export function platformNotificationSink(platform: PlatformAdapter, logger: Logger): NotificationSink {
  if (isNotificationSink(platform)) return platform;
  logger.warn('reminder.sink.unavailable');
  return { deliver: async () => ({ status: 'NOT_SENT', reason: 'MISSING_ACCESS', retryable: false }) };
}

/**
 * Composition seams for offline acceptance only; production passes none (shared clock, Node timers, console
 * logger). The conversation side reads the runtime's per-turn clock, so only the tick driver takes `clock`.
 */
export interface RemindersCompositionOptions {
  readonly clock?: () => IsoTimestamp;
  readonly timers?: ReminderTickTimers;
  readonly logger?: Logger;
}

export function createRemindersProviders(
  resolveConfig: () => ReminderConfig,
  options: RemindersCompositionOptions = {},
): Provider[] {
  const logger = options.logger ?? new ConsoleLogger('reminders');
  return [
    { provide: REMINDER_FEATURE_CONFIG, useFactory: resolveConfig },
    {
      provide: REMINDER_REPOSITORY,
      useFactory: (storage: StorageProvider): ReminderRepository =>
        lazyReminderRepository(storage as StorageProvider & ReminderStorageSeam),
      inject: [STORAGE_PROVIDER],
    },
    {
      provide: NOTIFICATION_SINK,
      useFactory: (platform: PlatformAdapter): NotificationSink => platformNotificationSink(platform, logger),
      inject: [PLATFORM_ADAPTER],
    },
    { provide: ReminderReplyComposer, useFactory: () => new ReminderReplyComposer() },
    {
      provide: ReminderConversationService,
      useFactory: (config: ReminderConfig, repository: ReminderRepository, composer: ReminderReplyComposer) =>
        new ReminderConversationService({
          repository,
          composer,
          timeZone: config.timeZone,
          enabled: config.enabled,
          logger,
        }),
      inject: [REMINDER_FEATURE_CONFIG, REMINDER_REPOSITORY, ReminderReplyComposer],
    },
    {
      provide: ReminderDispatchService,
      useFactory: (
        config: ReminderConfig,
        storage: StorageProvider,
        repository: ReminderRepository,
        sink: NotificationSink,
        composer: ReminderReplyComposer,
        calendar: CalendarReader | undefined,
        connectors: readonly ConnectorProvider[] | undefined,
      ) => {
        const seam = storage as StorageProvider & ReminderStorageSeam;
        const briefSources = createBriefSources({
          calendar,
          connectors,
          briefJiraEnabled: config.briefJiraEnabled === true,
          // The live storage seam: `actors` is dereferenced at call time, after init() (QA-001).
          storage: storage as StorageProvider & BriefActorStorageSeam,
          logger,
        });
        return new ReminderDispatchService({
          repository,
          sink,
          composer,
          ...(briefSources !== undefined ? { briefSources } : {}),
          // Read-only, call-time WorkItem identities for the local daily brief (QA-001).
          workItems: {
            listByActor: (actorId) => {
              const workItems = seam.workItems;
              if (workItems === undefined) return Promise.reject(new ReminderStorageUnavailableError());
              return workItems.listByActor(actorId);
            },
          },
          logger,
        });
      },
      inject: [
        REMINDER_FEATURE_CONFIG,
        STORAGE_PROVIDER,
        REMINDER_REPOSITORY,
        NOTIFICATION_SINK,
        ReminderReplyComposer,
        // ADR-0117: bound only when the calendar is configured / always bound in the app, optional for test modules.
        { token: CALENDAR_READER, optional: true },
        { token: CONNECTOR_PROVIDERS, optional: true },
      ],
    },
    {
      provide: ReminderTickDriver,
      useFactory: (config: ReminderConfig, dispatch: ReminderDispatchService) =>
        new ReminderTickDriver({
          enabled: config.enabled,
          dispatch,
          logger,
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.timers ? { timers: options.timers } : {}),
        }),
      inject: [REMINDER_FEATURE_CONFIG, ReminderDispatchService],
    },
    {
      provide: REMINDER_TURN_HANDLERS,
      useFactory: (
        config: ReminderConfig,
        conversation: ReminderConversationService,
        composer: ReminderReplyComposer,
      ): readonly ConversationTurnHandler[] => [
        new ReminderTurnHandler({ conversation, composer, enabled: config.enabled, logger }),
      ],
      inject: [REMINDER_FEATURE_CONFIG, ReminderConversationService, ReminderReplyComposer],
    },
  ];
}

export const remindersProviders: Provider[] = createRemindersProviders(() => loadConfig().reminders);
