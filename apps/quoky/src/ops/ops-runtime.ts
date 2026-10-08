import { LATEST_SCHEMA_VERSION, readSqliteUserVersion, writeVerifiedSqliteCopy } from '@quoky/storage-sqlite';
import { writeVerifiedVectorSnapshot } from '@quoky/vector-local';
import type { IsoTimestamp, Logger, MemoryArchivePurgeResult, NotificationSink } from '@quoky/core';
import type { QuokyConfig } from '../config';
import { BackupJob, type BackupJobTimers, type BackupStatus } from './backup-job';
import { MemoryArchivePurgeJob } from './memory-archive-purge';
import { loadOpsConfig } from './ops-config';
import { OpsNoticeService, fileLedgerStore, isCrashLoopStart, type OpsNoticeLedgerStore } from './ops-notice';

/**
 * SUB-2 composition (ADR-0102 D6/D7): the one object `main.ts` drives.
 *
 *   const ops = createOpsRuntime({ env: process.env, config, sink, platform: 'discord', logger });
 *   await ops.ensurePreMigrationBackup();   // before storage.init()
 *   ...storage.init(), platform.start(), identity check...
 *   ops.start();                            // between the identity check and the reminder start
 *   ...
 *   await ops.stop();                       // on shutdown, right after the reminder tick stops
 *
 * `start()` sends the crash-loop `OPS_NOTICE` (fire and forget, never delaying the start) when the launcher counted
 * ≥3 starts in the last 10 minutes, and arms the daily backup chain, whose failures send the backup `OPS_NOTICE`.
 * ADR-0106 amendment: `start()` also starts the memory-archive expiry purge (`memory-archive-purge.ts`) — once at start,
 * then daily — independent of whether backups are enabled or succeed; `stop()` stops it with the backup chain.
 * `backupStatus()` is the in-process read for the OPS-1 screen (ADR-0113 D6); the same data is in
 * `<backup dir>/backup-status.json`.
 */
export interface OpsRuntime {
  ensurePreMigrationBackup(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  backupStatus(): BackupStatus;
}

export interface OpsRuntimeInput {
  readonly env: NodeJS.ProcessEnv;
  readonly config: Pick<QuokyConfig, 'storage' | 'host' | 'reminders'> & {
    readonly discord: Pick<QuokyConfig['discord'], 'ownerIds'>;
    /** The vector store snapshotted with each DB copy; absent or empty = DB-only backups. */
    readonly vector?: QuokyConfig['vector'];
  };
  readonly sink: NotificationSink;
  /** The sink's platform name (`DISCORD_NOTIFICATION_PLATFORM`). */
  readonly platform: string;
  readonly logger: Logger;
  /** ADR-0106 amendment: deletes the expired memory-archive entries (`MemoryCommandService.purgeExpiredArchive`). */
  readonly memoryArchivePurge?: (now: IsoTimestamp) => Promise<MemoryArchivePurgeResult>;
  /** Offline-test seams; production passes none. */
  readonly clock?: () => IsoTimestamp;
  readonly timers?: BackupJobTimers;
  readonly ledger?: OpsNoticeLedgerStore;
  readonly cwd?: string;
}

export function createOpsRuntime(input: OpsRuntimeInput): OpsRuntime {
  const { config, logger } = input;
  const ops = loadOpsConfig(
    input.env,
    {
      dbPath: config.storage.dbPath,
      ...(config.vector?.storePath ? { vectorPath: config.vector.storePath } : {}),
      ...(config.host.launcher ? { launcher: config.host.launcher } : {}),
    },
    input.cwd,
  );
  const notices = new OpsNoticeService({
    sink: input.sink,
    ownerId: config.discord.ownerIds[0],
    platform: input.platform,
    ledger: input.ledger ?? fileLedgerStore(ops.noticeLedgerPath),
    logger,
    ...(input.clock ? { clock: input.clock } : {}),
  });
  const backup = new BackupJob({
    enabled: ops.backup.enabled,
    dbPath: ops.backup.dbPath,
    dir: ops.backup.dir,
    timeZone: config.reminders.timeZone,
    copy: writeVerifiedSqliteCopy,
    readUserVersion: readSqliteUserVersion,
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    ...(ops.backup.vectorPath !== undefined
      ? { vectorPath: ops.backup.vectorPath, snapshotVectors: writeVerifiedVectorSnapshot }
      : {}),
    onFailure: () => void notices.notify('BACKUP_FAILED'),
    logger,
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.timers ? { timers: input.timers } : {}),
  });
  if (!ops.backup.enabled) logger.info('backup.disabled');
  const archivePurge =
    input.memoryArchivePurge === undefined
      ? undefined
      : new MemoryArchivePurgeJob({
          purge: input.memoryArchivePurge,
          timeZone: config.reminders.timeZone,
          logger,
          ...(input.clock ? { clock: input.clock } : {}),
          ...(input.timers ? { timers: input.timers } : {}),
        });

  return {
    async ensurePreMigrationBackup() {
      const outcome = await backup.ensurePreMigrationBackup();
      if (outcome === 'VERIFIED') logger.info('backup.pre_migration.verified');
    },
    start() {
      if (isCrashLoopStart(config.host)) void notices.notify('CRASH_LOOP');
      backup.start();
      archivePurge?.start();
    },
    async stop() {
      await Promise.all([backup.stop(), archivePurge?.stop()]);
    },
    backupStatus: () => backup.status(),
  };
}
