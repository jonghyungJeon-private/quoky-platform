/**
 * ADR-0125 D1/D5: the local-client settings, parsed at startup.
 *
 * `QUOKY_LOCAL_CLIENT_ENABLED` (exact `true`/`false`, default `false`) is the only switch: with it off no other
 * variable is read and nothing local-client related is constructed (no socket, no token file). With it on,
 * `QUOKY_LOCAL_CLIENT_OWNER_ACTOR` names the one configured Discord owner id the surface maps to (D5). A missing value,
 * or one that is not in `QUOKY_DISCORD_OWNER_IDS` or does not resolve to exactly one Actor, disables only this adapter at
 * start (fail closed, with a reason code in the log); the rest of Quoky starts. Errors carry codes only.
 */
export const LocalClientConfigErrorCode = {
  LOCAL_CLIENT_ENABLED_INVALID: 'LOCAL_CLIENT_ENABLED_INVALID',
} as const;
export type LocalClientConfigErrorCode = (typeof LocalClientConfigErrorCode)[keyof typeof LocalClientConfigErrorCode];

export class LocalClientConfigError extends Error {
  constructor(readonly code: LocalClientConfigErrorCode) {
    super(code);
    this.name = 'LocalClientConfigError';
  }
}

/** Present on `QuokyConfig` only when `QUOKY_LOCAL_CLIENT_ENABLED=true`. */
export interface LocalClientConfig {
  /** The configured Discord owner id the surface maps to; undefined = not configured (the adapter then disables itself). */
  readonly ownerActor?: string;
}

/** `undefined` when the surface is off (unset or `false`); the settings when on; a mistyped flag is a startup error. */
export function parseLocalClientConfig(env: NodeJS.ProcessEnv): LocalClientConfig | undefined {
  const flag = env.QUOKY_LOCAL_CLIENT_ENABLED;
  if (flag === undefined || flag === 'false') return undefined;
  if (flag !== 'true') throw new LocalClientConfigError(LocalClientConfigErrorCode.LOCAL_CLIENT_ENABLED_INVALID);
  const owner = env.QUOKY_LOCAL_CLIENT_OWNER_ACTOR?.trim();
  return owner === undefined || owner.length === 0 ? {} : { ownerActor: owner };
}
