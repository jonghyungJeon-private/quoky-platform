import { statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { BootstrapPreflightError } from '../bootstrap-preflight';

/**
 * ADR-0102 D2: the launchd service reads its configuration from exactly one file, the host's `.env.local`, which must
 * be private to the owner. The launcher checks this before it starts the app; the app checks it again when it is
 * given an explicit env file (`QUOKY_ENV_FILE`), so a hand-run `QUOKY_ENV_FILE=… node main.js` is held to the same
 * rule. Errors carry the code and a hint only; neither the path nor any file content is logged.
 */
export const EnvFileErrorCode = {
  ENV_FILE_NOT_ABSOLUTE: 'ENV_FILE_NOT_ABSOLUTE',
  ENV_FILE_MISSING: 'ENV_FILE_MISSING',
  ENV_FILE_INSECURE: 'ENV_FILE_INSECURE',
} as const;
export type EnvFileErrorCode = (typeof EnvFileErrorCode)[keyof typeof EnvFileErrorCode];

const HINTS: Readonly<Record<EnvFileErrorCode, string>> = {
  ENV_FILE_NOT_ABSOLUTE: 'QUOKY_ENV_FILE must be an absolute path to the host .env.local (set by ops/launchd/quoky-launch.sh).',
  ENV_FILE_MISSING: 'The env file named by QUOKY_ENV_FILE does not exist or is not a regular file. Create the host .env.local, then restart.',
  ENV_FILE_INSECURE:
    'The env file must be owned by you and readable only by you: run `chmod 600 .env.local` (no group/other bits), then restart.',
};

export interface EnvFileGuardDeps {
  readonly stat?: (filePath: string) => Pick<Stats, 'isFile' | 'mode' | 'uid'>;
  /** Current user id; `undefined` (non-POSIX) skips the owner comparison. */
  readonly uid?: number | undefined;
}

/** Throws a `BootstrapPreflightError` unless `filePath` is an absolute, regular, owner-only (600/400) file. */
export function assertPrivateEnvFile(filePath: string, deps: EnvFileGuardDeps = {}): void {
  if (!path.isAbsolute(filePath)) throw envFileError(EnvFileErrorCode.ENV_FILE_NOT_ABSOLUTE);
  const stat = deps.stat ?? statSync;
  let info: Pick<Stats, 'isFile' | 'mode' | 'uid'>;
  try {
    info = stat(filePath);
  } catch {
    throw envFileError(EnvFileErrorCode.ENV_FILE_MISSING);
  }
  if (!info.isFile()) throw envFileError(EnvFileErrorCode.ENV_FILE_MISSING);
  const uid = 'uid' in deps ? deps.uid : process.getuid?.();
  const permissions = info.mode & 0o777;
  const ownerOnly = (permissions & 0o077) === 0 && (permissions & 0o400) !== 0;
  if (!ownerOnly || (uid !== undefined && info.uid !== uid)) throw envFileError(EnvFileErrorCode.ENV_FILE_INSECURE);
}

function envFileError(code: EnvFileErrorCode): BootstrapPreflightError {
  return new BootstrapPreflightError(code, HINTS[code]);
}
