import type { EgressMode } from './egress-policy';
import { DEFAULT_LEDGER_MAX_FILE_BYTES, DEFAULT_LEDGER_RETENTION_DAYS } from './traffic-ledger';

/**
 * Egress guard configuration (ADR-0121 S0, design §5.2/§5.4). Parsed here and folded into `QuokyConfig.egress` by
 * `config.ts` (like the NL selection configuration). Typed value-free errors: the message is the code only.
 *
 * - `QUOKY_EGRESS_GUARD`: exactly `off`, `observe` or `enforce`; default `observe` (design Q4: observe first, enforce
 *   after a clean ledger). `observe` logs findings and never blocks; `off` installs nothing (no guard, no ledger, no
 *   budgets) and is byte-identical to the pre-S0 runtime.
 * - `QUOKY_EGRESS_LEDGER_MAX_FILE_MB`: the size cap of one daily ledger file part, an integer from 1 to 256; default 16.
 * - `QUOKY_EGRESS_LEDGER_RETENTION_DAYS`: how long ledger files are kept, an integer from 1 to 365; default 90.
 */
export interface EgressGuardConfig {
  readonly mode: EgressMode;
  readonly ledgerMaxFileBytes: number;
  readonly ledgerRetentionDays: number;
}

export const EgressConfigErrorCode = {
  EGRESS_GUARD_INVALID: 'EGRESS_GUARD_INVALID',
  EGRESS_LEDGER_MAX_FILE_MB_INVALID: 'EGRESS_LEDGER_MAX_FILE_MB_INVALID',
  EGRESS_LEDGER_RETENTION_DAYS_INVALID: 'EGRESS_LEDGER_RETENTION_DAYS_INVALID',
} as const;
export type EgressConfigErrorCode = (typeof EgressConfigErrorCode)[keyof typeof EgressConfigErrorCode];

export class EgressConfigError extends Error {
  constructor(readonly code: EgressConfigErrorCode) {
    super(code);
    this.name = 'EgressConfigError';
  }
}

const MODES: readonly EgressMode[] = ['off', 'observe', 'enforce'];
const MB = 1024 * 1024;

function boundedInteger(raw: string | undefined, min: number, max: number, code: EgressConfigErrorCode): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,4}$/.test(raw)) throw new EgressConfigError(code);
  const value = Number(raw);
  if (value < min || value > max) throw new EgressConfigError(code);
  return value;
}

export function parseEgressConfig(env: NodeJS.ProcessEnv): EgressGuardConfig {
  const rawMode = env.QUOKY_EGRESS_GUARD;
  if (rawMode !== undefined && !(MODES as readonly string[]).includes(rawMode)) {
    throw new EgressConfigError(EgressConfigErrorCode.EGRESS_GUARD_INVALID);
  }
  const maxFileMb = boundedInteger(
    env.QUOKY_EGRESS_LEDGER_MAX_FILE_MB,
    1,
    256,
    EgressConfigErrorCode.EGRESS_LEDGER_MAX_FILE_MB_INVALID,
  );
  const retentionDays = boundedInteger(
    env.QUOKY_EGRESS_LEDGER_RETENTION_DAYS,
    1,
    365,
    EgressConfigErrorCode.EGRESS_LEDGER_RETENTION_DAYS_INVALID,
  );
  return {
    mode: (rawMode as EgressMode | undefined) ?? 'observe',
    ledgerMaxFileBytes: maxFileMb !== undefined ? maxFileMb * MB : DEFAULT_LEDGER_MAX_FILE_BYTES,
    ledgerRetentionDays: retentionDays ?? DEFAULT_LEDGER_RETENTION_DAYS,
  };
}
