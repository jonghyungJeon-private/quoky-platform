import path from 'node:path';
import type { IsoTimestamp } from '@quoky/core';
import { parseReminderConfig } from '../reminders/reminder-config';
import { readPrivateFile, writePrivateFileAtomic } from './ops-notice';

/**
 * The service's effective, non-secret backup configuration, published for the on-demand backup
 * (`quokyctl.sh backup` → `tools/backup-now.ts`) so that it never reads `.env.local` at all.
 *
 * The running service writes it at start to `<database directory>/ops/backup-config.json` through the private-file
 * writer (real 700 directory, random `O_CREAT | O_EXCL | O_NOFOLLOW` 600 temp file, fsync, atomic rename). The backup
 * tool reads it with the private-file reader (a symlinked directory or file, or a directory that is not 700, is
 * refused) and validates every field. It holds paths, a boolean and a zone name only: nothing from `.env.local` that
 * the service does not already resolve into these values, and never a secret.
 */

export const BACKUP_CONFIG_FILE = 'backup-config.json';
export const BACKUP_CONFIG_SCHEMA = 'quoky.backup-config/1';

export interface BackupConfigFile {
  readonly schema: typeof BACKUP_CONFIG_SCHEMA;
  readonly writtenAt: IsoTimestamp;
  /** Absolute database path. */
  readonly dbPath: string;
  /** Absolute vector store directory, or `null` (DB-only backups). */
  readonly vectorPath: string | null;
  /** Absolute backup directory (`QUOKY_BACKUP_DIR` or its default). */
  readonly backupDir: string;
  /** Scheduled backups on/off (`QUOKY_BACKUP_ENABLED` or its default). */
  readonly enabled: boolean;
  /** `QUOKY_TIMEZONE` (retention days/weeks). */
  readonly timeZone: string;
}

/** `<database directory>/ops/backup-config.json`, beside the `OPS_NOTICE` ledger. */
export function backupConfigPath(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'ops', BACKUP_CONFIG_FILE);
}

export function writeBackupConfig(file: string, config: Omit<BackupConfigFile, 'schema'>): void {
  const body: BackupConfigFile = { schema: BACKUP_CONFIG_SCHEMA, ...config };
  writePrivateFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !/[\0\n\r]/.test(value) && value.trim() === value;
}

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return parseReminderConfig({ QUOKY_TIMEZONE: value }).timeZone === value;
  } catch {
    return false;
  }
}

export type BackupConfigRead =
  | { readonly ok: true; readonly config: BackupConfigFile }
  | { readonly ok: false; readonly reason: 'MISSING' | 'REFUSED' | 'INVALID' };

/** Read and validate the published config. Never throws. */
export function readBackupConfig(file: string): BackupConfigRead {
  let raw: string | undefined;
  try {
    raw = readPrivateFile(file);
  } catch {
    return { ok: false, reason: 'REFUSED' };
  }
  if (raw === undefined) return { ok: false, reason: 'MISSING' };
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'INVALID' };
  }
  if (typeof value !== 'object' || value === null || value.schema !== BACKUP_CONFIG_SCHEMA) return { ok: false, reason: 'INVALID' };
  const { writtenAt, dbPath, vectorPath, backupDir, enabled, timeZone } = value;
  if (typeof writtenAt !== 'string' || !isSafeAbsolutePath(dbPath) || !isSafeAbsolutePath(backupDir)) {
    return { ok: false, reason: 'INVALID' };
  }
  if (vectorPath !== null && !isSafeAbsolutePath(vectorPath)) return { ok: false, reason: 'INVALID' };
  if (typeof enabled !== 'boolean' || !isValidTimeZone(timeZone)) return { ok: false, reason: 'INVALID' };
  return {
    ok: true,
    config: { schema: BACKUP_CONFIG_SCHEMA, writtenAt, dbPath, vectorPath, backupDir, enabled, timeZone },
  };
}
