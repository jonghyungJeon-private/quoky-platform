import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import {
  AiProviderManager,
  QuokyCore,
  PLATFORM_ADAPTER,
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  QUEUE_PROVIDER,
} from '@quoky/core';
import type {
  PlatformAdapter,
  QueueProvider,
  StorageProvider,
  VectorProvider,
} from '@quoky/core';

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
import { loadConfig } from './config';

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
 */
async function bootstrap(): Promise<void> {
  loadLocalEnvironment();
  assertDiscordTokenConfigured(process.env);
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

  logResolvedDatabasePath(loadConfig().storage.dbPath, log);
  await reportProviderReadiness(aiProviders, log);

  // Track B (Sprint 4c-Follow-up-2): secret-free structured diagnostics — name/message/redacted stack/cause plus
  // non-secret correlation context (stage + message/channel/user ids). The raw message text is deliberately NOT
  // logged (a user could paste a secret into chat); only non-secret identifiers are.
  platform.onMessage((message) =>
    core.handleInboundMessage(message).catch((err) =>
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
    core.handleApprovalDecision(decision).catch((err) =>
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

  await storage.init();
  await actorIdentityProvisioner.provision();
  await vector.init();
  await queue.start();
  await platform.start();

  const shutdown = async (): Promise<void> => {
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
  process.exit(1);
});
