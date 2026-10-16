import type { Provider } from '@nestjs/common';
import {
  CapabilityRouter,
  MemoryManager,
  NlActionSwitch,
  REMINDER_REPOSITORY,
  WorkItemStatus,
  type NlDeicticTextReader,
  type ReminderRepository,
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
 *
 * ADR-0120 amendment A6 R5a: `QUOKY_NL_DEICTIC_WRITES` (default `off`, only with `QUOKY_NL_ACTIONS=local`) is passed with a
 * read-only text reader over the existing stores (to-dos by id, reminders by display number, SHORT_TERM records through
 * `MemoryManager.findShortTerm`); no new port, token or migration.
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
      useFactory: (
        router: CapabilityRouter,
        sessions: SessionManager,
        storage: StorageProvider,
        memory: MemoryManager,
        reminders: ReminderRepository | undefined,
      ): NlSelectionService => {
        const config = resolveConfig();
        const deicticMode = config.nlSelection.deicticWrites;
        const actors = {
          get: (id: string) => storage.actors.get(id),
          save: (actor: Parameters<StorageProvider['actors']['save']>[0]) => storage.actors.save(actor),
        };
        const killSwitch = new NlActionSwitch({ actors, logger });
        return new NlSelectionService({
          ...(config.nlSelection.actions !== 'off'
            ? { actions: { level: config.nlSelection.actions, killSwitch, ...(config.nlSelection.itemR2 !== 'off' ? { itemR2: config.nlSelection.itemR2 } : {}) } }
            : {}),
          ...(deicticMode !== 'off' ? { deictic: { mode: deicticMode, texts: deicticTextReader(storage, memory, reminders) } } : {}),
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
      inject: [CapabilityRouter, SessionManager, STORAGE_PROVIDER, MemoryManager, { token: REMINDER_REPOSITORY, optional: true }],
    },
  ];
}

/** A6 R5a: the read-only view of a referent's store (resolved at call time: the SQLite repositories exist after init). */
export function deicticTextReader(storage: StorageProvider, memory: Pick<MemoryManager, 'findShortTerm'>, reminders: ReminderRepository | undefined): NlDeicticTextReader {
  return {
    async todo(actorId, itemId) {
      const item = await storage.workItems.get(itemId);
      if (item === null || item.actorId !== actorId) return null;
      return { ...(item.title !== undefined ? { title: item.title } : {}), origin: item.origin };
    },
    async reminder(actorId, displayNo) {
      if (reminders === undefined) return null;
      const reminder = await reminders.getByDisplayNo(actorId, displayNo);
      if (reminder === null || reminder.actorId !== actorId) return null;
      return { id: reminder.id, body: reminder.body, kind: reminder.kind, eventLinked: reminder.event !== undefined };
    },
    ownerMessage: (memoryId) => memory.findShortTerm(memoryId),
    async duplicateTodo(actorId, title) {
      const open = (await storage.workItems.listByActor(actorId))
        .filter((item) => item.status === WorkItemStatus.ACTIVE)
        .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const index = open.findIndex((item) => item.title === title);
      return index >= 0 ? index + 1 : undefined;
    },
  };
}
