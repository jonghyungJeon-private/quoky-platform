import path from 'node:path';

import { OPS_UI_TOKEN_FILE_NAME } from './http/token-file';

/**
 * OPS-1 configuration (ADR-0113 D1–D3), parsed here from the process environment and not in `config.ts` (owned by
 * CAL-1 in wave 3; OPS-2b folds these keys into `config.ts`/`.env.example` in W6 without changing their meaning).
 * New `QUOKY_*` keys with no `CHUNSIK_*` alias.
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

export const OPS_UI_DEFAULT_PORT = 47613;
export const OPS_UI_MIN_PORT = 1024;
export const OPS_UI_MAX_PORT = 65535;

export const OpsUiConfigErrorCode = {
  OPS_UI_ENABLED_INVALID: 'OPS_UI_ENABLED_INVALID',
  OPS_UI_PORT_INVALID: 'OPS_UI_PORT_INVALID',
} as const;
export type OpsUiConfigErrorCode = (typeof OpsUiConfigErrorCode)[keyof typeof OpsUiConfigErrorCode];

export type OpsUiConfig =
  | { readonly enabled: false; readonly invalid?: OpsUiConfigErrorCode }
  | { readonly enabled: true; readonly port: number; readonly tokenFilePath: string };

/** Host data directory: the database's directory (relative paths resolve from `cwd`, like the storage adapter). */
export function opsUiDataDir(dbPath: string, cwd: string = process.cwd()): string {
  const fileBacked = dbPath !== '' && dbPath !== ':memory:';
  return fileBacked ? path.dirname(path.resolve(cwd, dbPath)) : path.resolve(cwd, 'data');
}

export function loadOpsUiConfig(env: NodeJS.ProcessEnv, dbPath: string, cwd: string = process.cwd()): OpsUiConfig {
  const rawEnabled = env.QUOKY_OPS_UI_ENABLED;
  if (rawEnabled === undefined || rawEnabled === '' || rawEnabled === 'false') return { enabled: false };
  if (rawEnabled !== 'true') return { enabled: false, invalid: OpsUiConfigErrorCode.OPS_UI_ENABLED_INVALID };

  const rawPort = env.QUOKY_OPS_UI_PORT;
  let port = OPS_UI_DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^[0-9]{1,5}$/.test(rawPort)) return { enabled: false, invalid: OpsUiConfigErrorCode.OPS_UI_PORT_INVALID };
    port = Number(rawPort);
    if (port < OPS_UI_MIN_PORT || port > OPS_UI_MAX_PORT) {
      return { enabled: false, invalid: OpsUiConfigErrorCode.OPS_UI_PORT_INVALID };
    }
  }
  return { enabled: true, port, tokenFilePath: path.join(opsUiDataDir(dbPath, cwd), OPS_UI_TOKEN_FILE_NAME) };
}
