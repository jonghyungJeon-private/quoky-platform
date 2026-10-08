import { TelegramStartupErrorCode } from '@quoky/adapter-telegram';
import { TELEGRAM_IDENTITY_CONFLICT, type StartupFailureReport } from '../bootstrap-preflight';
import { QuokyConfigErrorCode } from '../config';
import { ContinuationReceiverActivationErrorCode } from '../continuation/continuation-receiver-activation';
import { ProviderRoutingActivationErrorCode } from '../provider-routing/provider-routing-activation';
import { BackupErrorCode } from './backup-job';
import { EnvFileErrorCode } from './env-file-guard';
import { InstanceLockErrorCode } from './instance-lock';
import { OpsConfigErrorCode } from './ops-config';
import { StartupIdentityErrorCode } from './startup-identity-check';

/**
 * ADR-0102 D5 process exit codes. `CONFIGURATION` (78, sysexits `EX_CONFIG`) means "retrying will not help until the
 * owner changes something": `ops/launchd/quoky-launch.sh` counts consecutive configuration exits and stops relaunching
 * after 3. Every other failure exits `FAILURE` and launchd relaunches it (KeepAlive on abnormal exit).
 * The launcher script hard-codes 78; `launchd-scripts.test.ts` keeps the two in sync.
 */
export const QuokyExitCode = {
  OK: 0,
  FAILURE: 1,
  CONFIGURATION: 78,
} as const;

/** Startup failure codes that are configuration problems (see `describeStartupFailure`). */
const CONFIGURATION_FAILURES: ReadonlySet<string> = new Set<string>([
  ...Object.values(QuokyConfigErrorCode),
  ...Object.values(EnvFileErrorCode),
  ...Object.values(OpsConfigErrorCode),
  // ADR-0102 D3: relaunching cannot help until the owner frees disk space / fixes the backup directory; the launcher
  // stops after 3 in a row instead of retrying a full-database copy every 10 seconds.
  BackupErrorCode.BACKUP_PRE_MIGRATION_FAILED,
  InstanceLockErrorCode.INSTANCE_ALREADY_RUNNING,
  StartupIdentityErrorCode.DISCORD_IDENTITY_MISMATCH,
  // ADR-0102 D5 / ADR-0114 D4/D5: a definitive Telegram answer at startup (another bot, a rejected token, a webhook
  // 409) is a typed startup error and exits CONFIGURATION. Found later while serving, the same answers halt the
  // Telegram side only (one OPS_NOTICE) and never reach this path. TELEGRAM_IDENTITY_UNVERIFIABLE (an outage) never
  // stops the start: it is retried in the background.
  TelegramStartupErrorCode.TELEGRAM_IDENTITY_MISMATCH,
  TelegramStartupErrorCode.TELEGRAM_AUTH_REJECTED,
  TelegramStartupErrorCode.TELEGRAM_POLL_CONFLICT,
  // ADR-0114 D3 (CA P3-2): the Telegram owner id is linked to another Actor; the owner must fix the map or unlink it.
  TELEGRAM_IDENTITY_CONFLICT,
  ProviderRoutingActivationErrorCode.INVALID_MODE,
  ContinuationReceiverActivationErrorCode.INVALID_MODE,
  ContinuationReceiverActivationErrorCode.CONTAINMENT_UNAVAILABLE,
  'DISCORD_BOT_TOKEN_MISSING',
  'DISCORD_TOKEN_INVALID',
  'DISCORD_DISALLOWED_INTENTS',
]);

export function startupExitCode(report: StartupFailureReport): number {
  return CONFIGURATION_FAILURES.has(report.message) ? QuokyExitCode.CONFIGURATION : QuokyExitCode.FAILURE;
}
