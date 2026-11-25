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
  AGENT_PROPOSE_TARGETS_INVALID: 'AGENT_PROPOSE_TARGETS_INVALID',
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

/**
 * ADR-0121 amendment A7 (A7.10, slice A7-S4a): `QUOKY_AGENT_PROPOSE_TARGETS`, the closed list of destinations a proposal may card.
 * Unset or empty (the default): none. Otherwise a comma-separated list of exactly `jira-comment`, `slack-post`,
 * `calendar-description` (lowercase, no repeats); anything else is `AGENT_PROPOSE_TARGETS_INVALID` (value-free). The list only
 * takes effect under agent mode `active` and `QUOKY_AGENT_WRITE_PROPOSALS=active` (both still refused at startup), and only
 * `jira-comment` has a card in A7-S4a, so today it changes nothing.
 */
export const PROPOSE_TARGETS = ['jira-comment', 'slack-post', 'calendar-description'] as const;
export type ProposeTarget = (typeof PROPOSE_TARGETS)[number];

export function parseProposeTargets(env: NodeJS.ProcessEnv): readonly ProposeTarget[] {
  const raw = env.QUOKY_AGENT_PROPOSE_TARGETS;
  if (raw === undefined || raw === '') return [];
  const seen: ProposeTarget[] = [];
  for (const part of raw.split(',')) {
    const target = (PROPOSE_TARGETS as readonly string[]).includes(part) ? (part as ProposeTarget) : undefined;
    if (target === undefined || seen.includes(target)) throw new WriteProposalsConfigError(WriteProposalsConfigErrorCode.AGENT_PROPOSE_TARGETS_INVALID);
    seen.push(target);
  }
  return Object.freeze(seen);
}
