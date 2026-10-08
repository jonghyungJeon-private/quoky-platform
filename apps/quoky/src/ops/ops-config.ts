import path from 'node:path';
import { BootstrapPreflightError } from '../bootstrap-preflight';

/**
 * SUB-2 operations configuration (ADR-0102 D6/D7). Parsed here, from the process environment `main.ts` passes in,
 * and not in `config.ts` (owned by another track in wave 2; the variables can be folded into `config.ts` later
 * without changing their meaning). Exact `true`/`false` only; errors carry the code only, never a configured value.
 *
 * - `QUOKY_BACKUP_ENABLED`: default **on under the launchd launcher** (`QUOKY_LAUNCHER=launchd`, the owner's real
 *   data, ADR-0102 D3), off otherwise (the delegated dev DB). A database that is not a file (`:memory:`) never backs
 *   up.
 * - `QUOKY_BACKUP_DIR`: an absolute directory; default `<database directory>/backups` (on the host:
 *   `~/Library/Application Support/Quoky/backups`). The job creates it mode 700.
 * - The vector store (`QUOKY_VECTOR_PATH`, passed in as `vectorPath`) is snapshotted next to each DB copy.
 *
 * The `OPS_NOTICE` rate-limit ledger lives beside the database (`<database directory>/ops/notice-ledger.json`).
 */
export interface OpsConfig {
  readonly backup: {
    readonly enabled: boolean;
    /** Absolute database path (the backup source). */
    readonly dbPath: string;
    /** Absolute backup directory. */
    readonly dir: string;
    /** Absolute vector store directory snapshotted with each copy; absent = DB-only backups. */
    readonly vectorPath?: string;
  };
  /** Absolute path of the persisted `OPS_NOTICE` ledger (the 3-per-day bound survives restarts). */
  readonly noticeLedgerPath: string;
}

export const OpsConfigErrorCode = {
  BACKUP_ENABLED_INVALID: 'BACKUP_ENABLED_INVALID',
  BACKUP_DIR_INVALID: 'BACKUP_DIR_INVALID',
} as const;
export type OpsConfigErrorCode = (typeof OpsConfigErrorCode)[keyof typeof OpsConfigErrorCode];

const HINTS: Readonly<Record<OpsConfigErrorCode, string>> = {
  BACKUP_ENABLED_INVALID: 'QUOKY_BACKUP_ENABLED must be exactly "true" or "false" (or unset for the default).',
  BACKUP_DIR_INVALID: 'QUOKY_BACKUP_DIR must be an absolute directory path (or unset for <database directory>/backups).',
};

function opsConfigError(code: OpsConfigErrorCode): BootstrapPreflightError {
  return new BootstrapPreflightError(code, HINTS[code]);
}

export interface OpsConfigBase {
  /** `config.storage.dbPath` (relative paths resolve from `cwd`, like the storage adapter). */
  readonly dbPath: string;
  /** `config.host.launcher`. */
  readonly launcher?: 'launchd';
  /** `config.vector.storePath` (relative paths resolve from `cwd`, like `dbPath`). */
  readonly vectorPath?: string;
}

export function loadOpsConfig(env: NodeJS.ProcessEnv, base: OpsConfigBase, cwd: string = process.cwd()): OpsConfig {
  const fileBacked = base.dbPath !== '' && base.dbPath !== ':memory:';
  const dbPath = fileBacked ? path.resolve(cwd, base.dbPath) : base.dbPath;
  const dataDir = fileBacked ? path.dirname(dbPath) : path.resolve(cwd, 'data');

  const rawEnabled = env.QUOKY_BACKUP_ENABLED;
  let enabled: boolean;
  if (rawEnabled === undefined || rawEnabled === '') enabled = base.launcher === 'launchd';
  else if (rawEnabled === 'true') enabled = true;
  else if (rawEnabled === 'false') enabled = false;
  else throw opsConfigError(OpsConfigErrorCode.BACKUP_ENABLED_INVALID);

  const rawDir = env.QUOKY_BACKUP_DIR;
  let dir: string;
  if (rawDir === undefined || rawDir === '') dir = path.join(dataDir, 'backups');
  else if (!path.isAbsolute(rawDir) || /[\0\n\r]/.test(rawDir)) throw opsConfigError(OpsConfigErrorCode.BACKUP_DIR_INVALID);
  else dir = path.resolve(rawDir);

  const vectorPath =
    base.vectorPath === undefined || base.vectorPath === '' ? undefined : path.resolve(cwd, base.vectorPath);

  return {
    backup: { enabled: enabled && fileBacked, dbPath, dir, ...(vectorPath !== undefined ? { vectorPath } : {}) },
    noticeLedgerPath: path.join(dataDir, 'ops', 'notice-ledger.json'),
  };
}
