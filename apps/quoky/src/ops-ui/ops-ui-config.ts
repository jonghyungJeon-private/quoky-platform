import path from 'node:path';

import { OPS_UI_DEFAULT_PORT, OPS_UI_MAX_PORT, OPS_UI_MIN_PORT, OpsUiConfigErrorCode, parseOpsUiFlags } from '../config';
import type { OpsUiFlags } from '../config';
import { OPS_UI_TOKEN_FILE_NAME } from './http/token-file';

/**
 * Operations UI configuration (ADR-0113 D1–D3). The flags themselves are parsed in `config.ts` (folded there by OPS-2b
 * in W6 with the meaning OPS-1 gave them; see `parseOpsUiFlags`); this module only adds the token file location.
 *
 * - `QUOKY_OPS_UI_ENABLED`: exactly `true` or `false`; default `false` (no port is opened).
 * - `QUOKY_OPS_UI_PORT`: an integer 1024–65535; default `47613`.
 *
 * There is deliberately no bind-address key: the listener binds `127.0.0.1` only (D2).
 *
 * An invalid value **disables only the UI** (fail closed) with a code the wiring logs; it never stops Quoky, the same
 * way a taken port disables only the UI (D2). Errors carry the code only, never the configured value.
 *
 * The token file `ops-ui.token` lives in the ADR-0102 D3 host data directory, which is the database's directory
 * (`~/Library/Application Support/Quoky/` under the launchd service; `./data` for the delegated dev DB).
 */

export { OPS_UI_DEFAULT_PORT, OPS_UI_MAX_PORT, OPS_UI_MIN_PORT, OpsUiConfigErrorCode };

export type OpsUiConfig =
  | { readonly enabled: false; readonly invalid?: OpsUiConfigErrorCode }
  | { readonly enabled: true; readonly port: number; readonly tokenFilePath: string };

/** Host data directory: the database's directory (relative paths resolve from `cwd`, like the storage adapter). */
export function opsUiDataDir(dbPath: string, cwd: string = process.cwd()): string {
  const fileBacked = dbPath !== '' && dbPath !== ':memory:';
  return fileBacked ? path.dirname(path.resolve(cwd, dbPath)) : path.resolve(cwd, 'data');
}

/** The parsed flags (from `QuokyConfig.opsUi`) plus the token file path. */
export function resolveOpsUiConfig(flags: OpsUiFlags, dbPath: string, cwd: string = process.cwd()): OpsUiConfig {
  if (!flags.enabled) return flags.invalid === undefined ? { enabled: false } : { enabled: false, invalid: flags.invalid };
  return { enabled: true, port: flags.port, tokenFilePath: path.join(opsUiDataDir(dbPath, cwd), OPS_UI_TOKEN_FILE_NAME) };
}

/** Parse straight from an environment (offline tests and the wiring's `env` seam). */
export function loadOpsUiConfig(env: NodeJS.ProcessEnv, dbPath: string, cwd: string = process.cwd()): OpsUiConfig {
  return resolveOpsUiConfig(parseOpsUiFlags(env), dbPath, cwd);
}
