import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AiProviderManager,
  CONNECTOR_PROVIDERS,
  ConversationRuntime,
  FeedbackRecorder,
  MemoryCommandService,
  NOTIFICATION_SINK,
  PLATFORM_ADAPTER,
  REMINDER_REPOSITORY,
  ReminderConversationService,
  STORAGE_PROVIDER,
  SessionStatus,
} from '@quoky/core';
import type {
  ApprovalDecisionService,
  ConnectorProvider,
  DurableMemoryQuery,
  Id,
  Logger,
  NotificationSink,
  PlatformAdapter,
  ReminderRepository,
  Session,
  StorageProvider,
} from '@quoky/core';
import { DISCORD_NOTIFICATION_PLATFORM } from '@quoky/adapter-discord';
import { readSqliteUserVersion } from '@quoky/storage-sqlite';

import { ConsoleLogger } from '../console-logger';
import { describeImageUnderstandingSelection } from '../image-understanding-provider';
import type { QuokyConfig } from '../config';
import type { OpsRuntime } from '../ops/ops-runtime';
import { ReminderTickDriver } from '../reminders/reminder-tick-driver';
import { OpsUiActions } from './actions/ops-actions';
import { OpsProviderSelectionActions } from './actions/provider-selection-actions';
import { ProviderSelectionService } from '../provider-selection/provider-selection-service';
import type { SelectionSource } from '../provider-selection/selection-choices';
import { OPS_UI_BIND_HOST, OpsUiServer } from './http/server';
import type { OpsActions, OpsUiEventLog } from './http/view-model';
import { loadOpsUiConfig, resolveOpsUiConfig } from './ops-ui-config';
import { OpsSnapshotBuilder, cachedViewSource } from './snapshot/build-snapshot';
import type { OpsOwnerResolution, OpsSnapshotSources } from './snapshot/build-snapshot';
import { OpsErrorRing, errorRecordingLogger } from './snapshot/error-ring';

/**
 * OPS-1/OPS-2 wiring (ADR-0113 D7/D8): the one entry point `main.ts` calls. It reads its own flags (`ops-ui-config.ts`), looks
 * its dependencies up from the Nest container (so `app.module.ts` is untouched) and starts the loopback listener.
 *
 *   const log = recordOpsUiErrors(new ConsoleLogger('quoky'), 'quoky');   // feeds the "recent errors" ring
 *   ...after the reminder tick starts...
 *   const opsUi = await startOpsUi({ app, config, ops, instanceLockHeld, identityVerified });
 *   ...on shutdown...
 *   await opsUi.stop();
 *
 * OPS-2 adds owner handling (reminder cancel, memory forget) from the same container: the chat
 * `ReminderConversationService` and `MemoryCommandService` singletons (so a forget code issued in either surface is
 * the same pending code), acting as the owner Actor resolved read-only per request. A missing service disables only
 * its action.
 *
 * OPS-2b adds approve and reject through the running `ConversationRuntime`'s own `approvalDecisions` (the one decision
 * path chat uses, with its per-approval serialization), and the `OPS_DECISION_RESULT` owner DM through the container's
 * `NotificationSink`. While the listener is up it turns on the chat preview's confirmation reference line, and turns it
 * off again on stop, so chat replies are byte-identical whenever the UI is off. No `app.module.ts` provider is added.
 *
 * With `QUOKY_OPS_UI_ENABLED` unset or `false` nothing is opened. An invalid flag, a taken port or a token file that
 * cannot be created disables only the UI (logged by code); the rest of Quoky keeps running.
 */

/** ADR-0113 D6: the process-wide recent-error ring (last 100, in memory only). */
export const opsUiErrorRing = new OpsErrorRing();

/** Wrap a composition-root logger so its `error` calls also feed the recent-error ring (codes only). */
export function recordOpsUiErrors(logger: Logger, component: string): Logger {
  return errorRecordingLogger(logger, opsUiErrorRing, component);
}

/** Minimum interval between two snapshot builds (ADR-0113 D6: bounded poll ≥ 10 s). */
export const OPS_UI_SNAPSHOT_MIN_INTERVAL_MS = 10_000;
/** Upper bound of the archived-memory count read. */
const ARCHIVE_COUNT_LIMIT = 500;

export interface OpsUiHandle {
  /** The listening port, or undefined when the UI is off or unavailable. */
  readonly port: number | undefined;
  stop(): Promise<void>;
}

export interface OpsUiContainer {
  get<T = unknown>(token: unknown): T;
}

export interface OpsUiWiringInput {
  readonly app: OpsUiContainer;
  readonly config: Pick<QuokyConfig, 'storage' | 'reminders' | 'host'> & {
    readonly discord: Pick<QuokyConfig['discord'], 'ownerIds'>;
    /** The OPS flags folded into `config.ts` (OPS-2b); absent → parsed from `env` (offline tests). */
    readonly opsUi?: QuokyConfig['opsUi'];
    /** ADR-0111 amendment A5: the image-understanding selection shown in the providers panel; absent → `unknown`. */
    readonly imageUnderstanding?: QuokyConfig['imageUnderstanding'];
    /** The chat-provider selection (ADR-0092 amendment) shown on the provider panel; absent in offline tests. */
    readonly ai?: { readonly chat: Pick<QuokyConfig['ai']['chat'], 'provider' | 'source'> };
  };
  readonly ops: Pick<OpsRuntime, 'backupStatus'>;
  /** ADR-0102 D4: whether `main.ts` took the single-instance lock (a file-backed database). */
  readonly instanceLockHeld: boolean;
  /** ADR-0102 D5: whether the startup identity check ran and passed (`false` = check off). */
  readonly identityVerified: boolean;
  /** Offline-test seams; production passes none. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly logger?: Logger;
  readonly errorRing?: OpsErrorRing;
  readonly host?: string;
  readonly portOverride?: number;
  readonly nowMs?: () => number;
}

const DISABLED: OpsUiHandle = { port: undefined, stop: async () => undefined };

function eventLog(logger: Logger): OpsUiEventLog {
  return {
    info: (event, fields) => logger.info(event, fields ? { ...fields } : undefined),
    warn: (event, fields) => logger.warn(event, fields ? { ...fields } : undefined),
  };
}

function buildVersion(): string {
  try {
    const raw = readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function optional<T>(app: OpsUiContainer, token: unknown): T | undefined {
  try {
    return app.get<T>(token);
  } catch {
    return undefined;
  }
}

/** Resolve the owner `Actor` through the ADR-0009 identity mapping, read-only (never creates an Actor). */
async function resolveOwner(storage: StorageProvider, ownerIds: readonly string[]): Promise<OpsOwnerResolution> {
  const actorIds = new Set<Id>();
  for (const ownerId of ownerIds) {
    const actor = await storage.actors.findByExternalIdentity(DISCORD_NOTIFICATION_PLATFORM, ownerId);
    if (actor) actorIds.add(actor.id);
  }
  if (actorIds.size === 1) return { status: 'RESOLVED', actorId: [...actorIds][0] as Id };
  return { status: actorIds.size === 0 ? 'NONE' : 'AMBIGUOUS' };
}

/** A structural, read-only probe of the platform connection (the Discord adapter's identity reader; sends nothing). */
async function platformConnected(platform: PlatformAdapter | undefined): Promise<boolean | undefined> {
  const reader = platform as
    | (PlatformAdapter & {
        readConnectedIdentity?: (channelIds: readonly string[], options: { readyTimeoutMs: number }) => Promise<unknown>;
      })
    | undefined;
  if (typeof reader?.readConnectedIdentity !== 'function') return undefined;
  try {
    await reader.readConnectedIdentity([], { readyTimeoutMs: 0 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner's archived memories (ADR-0106 amendment): records carrying `metadata.archivedAt`. The `archived` query
 * field is honoured by stores that know the archive; on a store that does not, the metadata filter still counts only
 * archived records. Content is never read beyond that flag.
 */
async function archivedMemoryCount(storage: StorageProvider, actorId: Id): Promise<{ count: number; capped: boolean }> {
  const query = {
    scope: { userId: actorId },
    limit: ARCHIVE_COUNT_LIMIT,
    excludeSuperseded: true,
    ...({ archived: 'only' } as Record<string, unknown>),
  } as DurableMemoryQuery;
  const records = await storage.memories.findDurableCandidates(query);
  const archived = records.filter((record) => {
    const value = record.metadata?.archivedAt;
    return value !== undefined && value !== null;
  });
  return { count: archived.length, capped: records.length >= ARCHIVE_COUNT_LIMIT };
}

const SELECTION_SOURCE_TEXT: Readonly<Record<SelectionSource, string>> = {
  session: '대화별 변경',
  persisted: '운영 화면 기본값',
  env: '설정',
  default: '기본값(설정에서 도출)',
};

/** Runtime model switch: the effective defaults for the providers panel (labels and sources only). */
function providerSelectionSummary(service: ProviderSelectionService): OpsSnapshotSources['providerSelection'] {
  return async () => {
    const status = await service.status();
    return {
      chat: { label: status.defaults.chat.label, source: SELECTION_SOURCE_TEXT[status.defaults.chat.source], ready: status.chat.ready },
      image: { choice: status.defaults.image.choice, source: SELECTION_SOURCE_TEXT[status.defaults.image.source] },
      sessionOverrides: await service.sessionOverrideCount().catch(() => undefined),
    };
  };
}

/** Assemble the snapshot sources from the container and composition-root facts. */
export function opsSnapshotSources(input: OpsUiWiringInput, errorRing: OpsErrorRing): OpsSnapshotSources {
  const { app, config } = input;
  const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
  const providers = app.get<AiProviderManager>(AiProviderManager);
  const reminderRepository = optional<ReminderRepository>(app, REMINDER_REPOSITORY);
  const tickDriver = optional<ReminderTickDriver>(app, ReminderTickDriver);
  const platform = optional<PlatformAdapter>(app, PLATFORM_ADAPTER);
  const connectors = optional<readonly ConnectorProvider[]>(app, CONNECTOR_PROVIDERS) ?? [];
  const feedback = app.get<FeedbackRecorder>(FeedbackRecorder);
  const selection = optional<ProviderSelectionService>(app, ProviderSelectionService);
  const cwd = input.cwd ?? process.cwd();
  const dbPath = config.storage.dbPath;
  const fileBacked = dbPath !== '' && dbPath !== ':memory:';
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const version = buildVersion();

  return {
    clock: () => new Date().toISOString(),
    timeZone: config.reminders.timeZone,
    runtime: {
      version,
      processStartedAt: startedAt,
      uptimeSeconds: () => process.uptime(),
      dbUserVersion: () => (fileBacked ? readSqliteUserVersion(path.resolve(cwd, dbPath)) : undefined),
      instanceLockHeld: input.instanceLockHeld,
      identityCheck: input.identityVerified ? 'PASSED' : 'OFF',
      platformConnected: () => platformConnected(platform),
      reminderTickState: () => tickDriver?.state,
      launcher: config.host.launcher,
      launcherRecentStarts: config.host.recentStarts,
    },
    providers: {
      all: () => providers.all(),
      available: () => providers.available(),
      ...(config.ai === undefined
        ? {}
        : { chatSelection: { provider: config.ai.chat.provider, source: config.ai.chat.source } }),
    },
    ...(config.imageUnderstanding !== undefined
      ? { imageUnderstanding: describeImageUnderstandingSelection(config.imageUnderstanding) }
      : {}),
    ...(selection !== undefined ? { providerSelection: providerSelectionSummary(selection) } : {}),
    owner: () => resolveOwner(storage, config.discord.ownerIds),
    reminders: {
      enabled: config.reminders.enabled,
      channelDelivery: config.reminders.channelDelivery,
      listActiveByActor: async (actorId) => {
        if (reminderRepository === undefined) {
          throw Object.assign(new Error('REMINDERS_UNAVAILABLE'), { code: 'REMINDERS_UNAVAILABLE' });
        }
        return reminderRepository.listActiveByActor(actorId);
      },
    },
    approvals: { list: () => storage.approvals.list() },
    connectors,
    errors: errorRing,
    feedback: { summarize: (actorId) => feedback.summarize(actorId), trend: (actorId) => feedback.trend(actorId) },
    backup: () => input.ops.backupStatus(),
    archivedMemoryCount: (actorId) => archivedMemoryCount(storage, actorId),
    handling: {
      reminderCancel: reminderRepository !== undefined && optional(app, ReminderConversationService) !== undefined,
      memoryForget: optional(app, MemoryCommandService) !== undefined,
      approvals: approvalHandling(app) !== undefined,
      providerSelection: selection !== undefined,
    },
  };
}

/** OPS-2b: the runtime's shared decision service and the owner sink, or undefined when either is not in the container. */
function approvalHandling(app: OpsUiContainer): { decisions: ApprovalDecisionService; sink: NotificationSink } | undefined {
  const runtime = optional<ConversationRuntime>(app, ConversationRuntime);
  const sink = optional<NotificationSink>(app, NOTIFICATION_SINK);
  const decisions = runtime?.approvalDecisions;
  if (decisions === undefined || sink === undefined || typeof sink.deliver !== 'function') return undefined;
  return { decisions, sink };
}

/** The conversations that can hold a pending approval: ACTIVE sessions with an in-focus task (read fresh per request). */
async function openSessionsWithFocus(storage: StorageProvider): Promise<readonly Session[]> {
  const sessions = await storage.sessions.list();
  return sessions.filter((session) => session.status === SessionStatus.ACTIVE && session.activeTaskId !== undefined);
}

/** OPS-2 handling over the chat services in the container (ADR-0113 D7); undefined when neither service is bound. */
export function opsUiActions(input: OpsUiWiringInput, logger: Logger): OpsUiActions | undefined {
  const { app, config } = input;
  const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
  const reminderRepository = optional<ReminderRepository>(app, REMINDER_REPOSITORY);
  const reminderService = optional<ReminderConversationService>(app, ReminderConversationService);
  const memory = optional<MemoryCommandService>(app, MemoryCommandService);
  const reminders =
    reminderRepository !== undefined && reminderService !== undefined
      ? { service: reminderService, repository: reminderRepository }
      : undefined;
  const handling = approvalHandling(app);
  const approvals =
    handling === undefined
      ? undefined
      : {
          decisions: handling.decisions,
          actor: (actorId: Id) => storage.actors.get(actorId),
          sessions: () => openSessionsWithFocus(storage),
          notify: (notification: Parameters<NotificationSink['deliver']>[0]) => handling.sink.deliver(notification),
        };
  if (reminders === undefined && memory === undefined && approvals === undefined) return undefined;
  return new OpsUiActions({
    owner: () => resolveOwner(storage, config.discord.ownerIds),
    clock: () => new Date(input.nowMs?.() ?? Date.now()).toISOString(),
    timeZone: config.reminders.timeZone,
    ...(reminders === undefined ? {} : { reminders }),
    ...(memory === undefined ? {} : { memory }),
    ...(approvals === undefined ? {} : { approvals }),
    logger,
  });
}

/**
 * Runtime model switch (ADR-0092 / ADR-0111 amendments): the defaults page and change over the container's
 * `ProviderSelectionService` (the same one the chat command and the router use), acting as the owner; the change notice
 * goes to the owner DM through the container's `NotificationSink`. Undefined when the service is not bound.
 */
export function opsProviderSelectionActions(input: OpsUiWiringInput, logger: Logger): OpsProviderSelectionActions | undefined {
  const { app, config } = input;
  const service = optional<ProviderSelectionService>(app, ProviderSelectionService);
  if (service === undefined) return undefined;
  const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
  const sink = optional<NotificationSink>(app, NOTIFICATION_SINK);
  const ownerId = config.discord.ownerIds[0];
  return new OpsProviderSelectionActions({
    service,
    owner: () => resolveOwner(storage, config.discord.ownerIds),
    ...(sink !== undefined && typeof sink.deliver === 'function' && ownerId !== undefined
      ? { notice: { platform: DISCORD_NOTIFICATION_PLATFORM, userId: ownerId, notify: (n) => sink.deliver(n) } }
      : {}),
    clock: () => new Date(input.nowMs?.() ?? Date.now()).toISOString(),
    logger,
  });
}

/** The UI's handling surface: the OPS-2/OPS-2b actions plus the model-default page, each optional. */
export function composeOpsActions(
  base: OpsUiActions | undefined,
  selection: OpsProviderSelectionActions | undefined,
): OpsActions | undefined {
  if (selection === undefined) return base;
  const refused = { code: 'ACTION_UNAVAILABLE', message: '이 처리는 지금 쓸 수 없어요.', ok: false } as const;
  return {
    reminderCancelPreview: (n) => (base ? base.reminderCancelPreview(n) : Promise.resolve({ status: 'REFUSED', outcome: refused })),
    cancelReminder: (n) => (base ? base.cancelReminder(n) : Promise.resolve(refused)),
    listMemories: () => (base ? base.listMemories() : Promise.resolve({ status: 'REFUSED', outcome: refused })),
    requestForget: (n) => (base ? base.requestForget(n) : Promise.resolve({ status: 'REFUSED', outcome: refused })),
    confirmForget: (code) => (base ? base.confirmForget(code) : Promise.resolve(refused)),
    ...(base?.approvalPreview !== undefined && base.decideApproval !== undefined
      ? {
          approvalPreview: (id: string) => base.approvalPreview(id),
          decideApproval: (id: string, decision: 'approve' | 'reject', reference: string) => base.decideApproval(id, decision, reference),
        }
      : {}),
    providerSelection: () => selection.page(),
    setProviderDefault: (subject) => selection.setDefault(subject),
  };
}

/** Start the operations UI when enabled; otherwise return a no-op handle without opening any port. */
export async function startOpsUi(input: OpsUiWiringInput): Promise<OpsUiHandle> {
  const logger = input.logger ?? new ConsoleLogger('ops-ui');
  const config =
    input.env === undefined && input.config.opsUi !== undefined
      ? resolveOpsUiConfig(input.config.opsUi, input.config.storage.dbPath, input.cwd)
      : loadOpsUiConfig(input.env ?? process.env, input.config.storage.dbPath, input.cwd);
  if (!config.enabled) {
    if (config.invalid !== undefined) logger.warn('ops-ui.disabled', { reason: config.invalid });
    return DISABLED;
  }

  const errorRing = input.errorRing ?? opsUiErrorRing;
  let builder: OpsSnapshotBuilder;
  let actions: OpsActions | undefined;
  try {
    builder = new OpsSnapshotBuilder(opsSnapshotSources(input, errorRing));
    actions = composeOpsActions(opsUiActions(input, logger), opsProviderSelectionActions(input, logger));
  } catch {
    // A missing container binding disables only the UI; the rest of Quoky keeps running.
    logger.warn('ops-ui.unavailable', { reason: 'WIRING_FAILED' });
    return DISABLED;
  }
  const nowMs = input.nowMs ?? Date.now;
  const server = new OpsUiServer({
    host: input.host ?? OPS_UI_BIND_HOST,
    port: input.portOverride ?? config.port,
    tokenFilePath: config.tokenFilePath,
    view: cachedViewSource(() => builder.build(), OPS_UI_SNAPSHOT_MIN_INTERVAL_MS, nowMs),
    log: eventLog(logger),
    nowMs,
    ...(actions === undefined ? {} : { actions }),
  });
  const started = await server.start();
  if (started.status !== 'LISTENING') return DISABLED;
  // ADR-0113 D7: the chat approval preview carries the confirmation reference line only while the UI is serving.
  const decisions = approvalHandling(input.app)?.decisions;
  decisions?.setConfirmationReferenceEnabled(true);
  return {
    port: started.port,
    stop: async () => {
      decisions?.setConfirmationReferenceEnabled(false);
      await server.stop();
    },
  };
}
