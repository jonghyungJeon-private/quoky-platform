/**
 * ADR-0121 D7 (stage S2 P1): the bounded read agent's configuration, parsed and validated only here (composition root)
 * and folded into `QuokyConfig.agent` by `config.ts`. Typed value-free errors: the message is the code only, a configured
 * value is never echoed.
 *
 * - `QUOKY_AGENT_MODE`: exactly `off`, `shadow` or `active`; default `off` (every turn byte-identical: the runtime reads
 *   the mode and nothing else). Anything else is `AGENT_MODE_INVALID`.
 * - `shadow` plans and validates in the background after an owner DM turn that reached selection, performs no read and no
 *   M2 call, and logs one content-free `agent_run.shadow` line. It needs Phase A selection live
 *   (`QUOKY_NL_INTENT_MODE=active`), else `AGENT_MODE_REQUIRES_NL_ACTIVE`.
 * - `active` is refused at startup with `AGENT_MODE_ACTIVE_NOT_RELEASED` (the code-level release gate) until the ADR-0121
 *   D11 gates pass and stage S2 P5 removes the gate.
 */
export type AgentModeConfig = 'off' | 'shadow';

export interface AgentConfig {
  readonly mode: AgentModeConfig;
}

export const AgentConfigErrorCode = {
  AGENT_MODE_INVALID: 'AGENT_MODE_INVALID',
  AGENT_MODE_ACTIVE_NOT_RELEASED: 'AGENT_MODE_ACTIVE_NOT_RELEASED',
  AGENT_MODE_REQUIRES_NL_ACTIVE: 'AGENT_MODE_REQUIRES_NL_ACTIVE',
} as const;
export type AgentConfigErrorCode = (typeof AgentConfigErrorCode)[keyof typeof AgentConfigErrorCode];

export class AgentConfigError extends Error {
  constructor(readonly code: AgentConfigErrorCode) {
    super(code);
    this.name = 'AgentConfigError';
  }
}

export function parseAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const raw = env.QUOKY_AGENT_MODE;
  if (raw === undefined || raw === 'off') return { mode: 'off' };
  if (raw === 'active') throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_ACTIVE_NOT_RELEASED);
  if (raw !== 'shadow') throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_INVALID);
  if (env.QUOKY_NL_INTENT_MODE !== 'active') throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_REQUIRES_NL_ACTIVE);
  return { mode: 'shadow' };
}
