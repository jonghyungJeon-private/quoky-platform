import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import {
  AiProviderManager,
  MemoryCommandService,
  NOTIFICATION_SINK,
  QuokyCore,
  PLATFORM_ADAPTER,
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  QUEUE_PROVIDER,
} from '@quoky/core';
import type {
  NotificationSink,
  PlatformAdapter,
  QueueProvider,
  StorageProvider,
  VectorProvider,
} from '@quoky/core';

import { DISCORD_NOTIFICATION_PLATFORM } from '@quoky/adapter-discord';

import { ConsoleLogger } from './console-logger';
import { loadLocalEnvironment } from './env-loader';
import { serializeError } from './error-diagnostics';
import { ActorIdentityProvisioner } from './actor-identity-provisioner';
import {
  STARTUP_BANNER,
  assertDiscordTokenConfigured,
  describeStartupFailure,
  logResolvedDatabasePath,
  reportProviderReadiness,
} from './bootstrap-preflight';
import { loadConfig, resolveEnvFilePath } from './config';
import { ReminderTickDriver } from './reminders/reminder-tick-driver';
import { assertPrivateEnvFile } from './ops/env-file-guard';
import { startupExitCode } from './ops/exit-codes';
import { acquireInstanceLock, instanceLockPath } from './ops/instance-lock';
import { createOpsRuntime } from './ops/ops-runtime';
import { startupIdentityExpectation, verifyStartupIdentity } from './ops/startup-identity-check';

const log = new ConsoleLogger('quoky');

/**
 * Boots Quoky as a standalone Nest application context (no HTTP server —
 * Discord is the interface). Resolves providers/services from DI, wires the
 * inbound handler, and starts infrastructure.
 *
 * The inbound handler is `QuokyCore.handleInboundMessage`, which runs the real
 * pipeline: resolve Actor → open Session → classify → create Task → plan →
 * ContextBuilder → PromptComposer → route → provider → Artifact → reply.
 * Startup preflight (token, provider readiness, resolved DB path) lives in
 * `bootstrap-preflight.ts`.
 *
 * ADR-0102 (always-on runtime, SUB-1): under `ops/launchd/quoky-launch.sh` the environment comes from one private
 * env file (`QUOKY_ENV_FILE`, checked owner-only here too); a single-instance lock beside the database is taken
 * before the composition root is evaluated; the connected Discord identity is verified before the reminder tick
 * starts; and a startup refusal exits with the configuration code the launcher counts.
 *
 * ADR-0102 D6/D7 (SUB-2, `ops/ops-runtime.ts`): a verified pre-migration backup is taken before `storage.init()`
 * when this build migrates an existing database (a failure refuses the start); the daily backup chain and the
 * crash-loop `OPS_NOTICE` start between the identity check and the reminder start; the backup chain stops right
 * after the reminder tick on shutdown.
 */
async function bootstrap(): Promise<void> {
  const envFilePath = resolveEnvFilePath(process.env);
  if (envFilePath !== undefined) assertPrivateEnvFile(envFilePath);
  loadLocalEnvironment(envFilePath !== undefined ? { envFilePath } : {});
  assertDiscordTokenConfigured(process.env);
  const config = loadConfig();
  // ADR-0102 D4: one process per database, decided before anything can open it (and before storage.init()).
  const lockPath = instanceLockPath(config.storage.dbPath);
  if (lockPath !== undefined) {
    const lock = acquireInstanceLock(lockPath);
    process.once('exit', () => lock.release());
  }
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
  const vector = app.get<VectorProvider>(VECTOR_PROVIDER);
  const queue = app.get<QueueProvider>(QUEUE_PROVIDER);
  const platform = app.get<PlatformAdapter>(PLATFORM_ADAPTER);
  const core = app.get(QuokyCore);
  const actorIdentityProvisioner = app.get(ActorIdentityProvisioner);
  const aiProviders = app.get(AiProviderManager);
  // ADR-0101 D6: composition-root reminder tick (bound in features/reminders.providers.ts). It starts only after
  // storage and the platform are up, never when QUOKY_REMINDERS_ENABLED=false, and stops first on shutdown.
  const reminderDriver = app.get(ReminderTickDriver);
  const memoryCommands = app.get(MemoryCommandService);
  // ADR-0102 D6/D7: backup + owner-DM health notice through the unchanged NotificationSink (bound with reminders).
  const ops = createOpsRuntime({
    env: process.env,
    config,
    sink: app.get<NotificationSink>(NOTIFICATION_SINK),
    platform: DISCORD_NOTIFICATION_PLATFORM,
    logger: new ConsoleLogger('ops'),
    // ADR-0106 amendment D2: expired memory-archive entries are deleted at start and daily, independent of backups.
    memoryArchivePurge: (now) => memoryCommands.purgeExpiredArchive(now),
  });

  logResolvedDatabasePath(config.storage.dbPath, log);
  await reportProviderReadiness(aiProviders, log);

  // ADR-0102 D5: with the identity check on, inbound turns and approval decisions wait until the connected identity
  // is verified, and are never handled for a mismatched one. Off (no QUOKY_DISCORD_EXPECTED_BOT_ID) = no waiting.
  const identity = startupIdentityExpectation(config);
  let openInbound: (verified: boolean) => void = () => undefined;
  const inboundGate: Promise<boolean> =
    identity === undefined ? Promise.resolve(true) : new Promise<boolean>((resolve) => (openInbound = resolve));

  // Track B (Sprint 4c-Follow-up-2): secret-free structured diagnostics — name/message/redacted stack/cause plus
  // non-secret correlation context (stage + message/channel/user ids). The raw message text is deliberately NOT
  // logged (a user could paste a secret into chat); only non-secret identifiers are.
  platform.onMessage((message) =>
    inboundGate.then((verified) => (verified ? core.handleInboundMessage(message) : undefined)).catch((err) =>
      log.error(
        'inbound handling failed',
        serializeError(err, {
          stage: 'inbound',
          messageId: message.id,
          platform: message.context.platform,
          channelId: message.context.channelId,
          userId: message.context.userId,
        }),
      ),
    ),
  );
  platform.onApprovalDecision((decision) =>
    inboundGate.then((verified) => (verified ? core.handleApprovalDecision(decision) : undefined)).catch((err) =>
      log.error(
        'approval handling failed',
        serializeError(err, {
          stage: 'approval-decision',
          approvalId: decision.approvalId,
          approved: decision.approved,
        }),
      ),
    ),
  );

  // ADR-0102 D3/D6: a schema migration on an existing database needs a fresh verified backup first; nothing has
  // opened the database yet, so the copy can never overlap a migration.
  await ops.ensurePreMigrationBackup();
  await storage.init();
  await actorIdentityProvisioner.provision();
  await vector.init();
  await queue.start();
  await platform.start();
  // ADR-0102 D5: verify the connected bot/guild/channels against .env.local before anything is delivered. On a
  // mismatch (or an unreadable identity) close what was started and fail; the catch below picks the exit code.
  if (identity !== undefined) {
    try {
      await verifyStartupIdentity(platform, identity, log);
      openInbound(true);
    } catch (err) {
      openInbound(false);
      await platform.stop().catch(() => undefined);
      await queue.stop().catch(() => undefined);
      await storage.close().catch(() => undefined);
      await app.close().catch(() => undefined);
      throw err;
    }
  }
  // ADR-0102 D6/D7: the daily backup chain, and the crash-loop OPS_NOTICE when the launcher counted >=3 starts in 10
  // minutes (owner DM only, fixed text, at most 3 per day; sent without delaying the start).
  ops.start();
  // Startup recovery (FIRING → DELIVERY_UNCERTAIN, never resent) runs inside start(); the first tick then delivers
  // a missed one-time reminder late once and catches a recurring one up only within 60 minutes.
  await reminderDriver.start();

  // ADR-0102 D8: launchd sends SIGTERM and allows ExitTimeOut (90 s) before SIGKILL, above the reminder stop bound
  // (REMINDER_TICK_STOP_TIMEOUT_MS, 65 s). A repeated signal while stopping is ignored.
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // First: no reminder claim/complete may run while the platform and storage are closing. stop() waits for the
    // in-flight delivery + outcome write up to its hard bound; if that elapses, the reminder stays FIRING and the
    // next startup turns it into DELIVERY_UNCERTAIN (never resent).
    const cleanStop = await reminderDriver.stop().catch(() => false);
    if (!cleanStop) log.warn('reminder tick stop was forced; an in-flight reminder may be left FIRING');
    // An in-flight backup copy is aborted (its worker terminated, its partial file removed); it uses its own
    // read-only connection, so it never holds the storage connection open.
    await ops.stop().catch(() => undefined);
    await platform.stop().catch(() => undefined);
    await queue.stop().catch(() => undefined);
    await storage.close().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(STARTUP_BANNER);
}

bootstrap().catch((err) => {
  const failure = describeStartupFailure(err);
  log.error('failed to start', { error: failure.message });
  if (failure.hint) log.error('how to fix', { hint: failure.hint });
  // ADR-0102 D5: configuration refusals exit 78 (the launcher stops relaunching after 3 in a row); others exit 1.
  process.exit(startupExitCode(failure));
});
