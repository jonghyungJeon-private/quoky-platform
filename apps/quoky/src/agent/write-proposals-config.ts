/**
 * ADR-0121 amendment A7 (slice A7-S2): the cross-source write proposal switch `QUOKY_AGENT_WRITE_PROPOSALS`, parsed and
 * validated only here (composition root) and folded into `QuokyConfig.writeProposals` by `config.ts`. Typed value-free
 * errors: the message is the code only.
 *
 * - Unset or exactly `off` (the default): nothing changes.
 * - Exactly `shadow`: the held receipt is recorded to the log only (closed codes and counts, never content); nothing is read,
 *   drafted or carded. It needs `QUOKY_AGENT_MODE=shadow` (A7.10: the flag works only under the agent mode; fail closed).
 * - Exactly `active` is refused at startup with `AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED` (the drafter A7-S3 and the card
 *   A7-S4 do not exist; promotion follows A7.10).
 * - Anything else is `AGENT_WRITE_PROPOSALS_INVALID`.
 */

export type WriteProposalsMode = 'off' | 'shadow';

export interface WriteProposalsConfig {
  readonly mode: WriteProposalsMode;
}

export const WriteProposalsConfigErrorCode = {
  AGENT_WRITE_PROPOSALS_INVALID: 'AGENT_WRITE_PROPOSALS_INVALID',
  AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED: 'AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED',
  AGENT_WRITE_PROPOSALS_REQUIRES_AGENT_MODE: 'AGENT_WRITE_PROPOSALS_REQUIRES_AGENT_MODE',
} as const;
export type WriteProposalsConfigErrorCode = (typeof WriteProposalsConfigErrorCode)[keyof typeof WriteProposalsConfigErrorCode];

export class WriteProposalsConfigError extends Error {
  constructor(readonly code: WriteProposalsConfigErrorCode) {
    super(code);
    this.name = 'WriteProposalsConfigError';
  }
}

export function parseWriteProposalsConfig(env: NodeJS.ProcessEnv): WriteProposalsConfig {
  const raw = env.QUOKY_AGENT_WRITE_PROPOSALS;
  if (raw === undefined || raw === 'off') return { mode: 'off' };
  if (raw === 'active') throw new WriteProposalsConfigError(WriteProposalsConfigErrorCode.AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED);
  if (raw !== 'shadow') throw new WriteProposalsConfigError(WriteProposalsConfigErrorCode.AGENT_WRITE_PROPOSALS_INVALID);
  if (env.QUOKY_AGENT_MODE !== 'shadow') throw new WriteProposalsConfigError(WriteProposalsConfigErrorCode.AGENT_WRITE_PROPOSALS_REQUIRES_AGENT_MODE);
  return { mode: 'shadow' };
}
