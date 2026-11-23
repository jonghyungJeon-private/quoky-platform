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
 *   D11 gates pass and stage S2 P5 removes the gate. Before that gate, `active` without the process egress guard in
 *   `enforce` (`QUOKY_EGRESS_GUARD=enforce`) is refused with `AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE`: the owner decided on
 *   2026-11-02 (S2-to-active plan, decision 5) that the guard switches `observe` → `enforce` before `active`, so this refusal
 *   stays when P5 removes the release gate.
 *
 * `active` is part of the type because the composition root can build the wired `active` service (S2 wiring slice); the parser
 * never returns it while the release gate stands.
 */
import { AGENT_WORK_SUMMARY_SOURCES, type AgentWorkSummarySource } from '@quoky/core';

export type AgentModeConfig = 'off' | 'shadow' | 'active';

export interface AgentConfig {
  readonly mode: AgentModeConfig;
  /**
   * ADR-0121 A5-S1: the work sources whose agent summary readout the owner switched on, in catalog order. Empty by default
   * (every source off, calendar included). Only the composition root of an `active` agent reads it.
   */
  readonly summarySources: readonly AgentWorkSummarySource[];
}

/**
 * ADR-0121 A5-S1, the per-source enable switches of the agent summary readout (A5.4, ratified 2026-11-23 R1 item 4): exact
 * `true` or `false`, default `false` for every source, independent of `QUOKY_WORK_SUMMARY_ENABLED` (which keeps governing the
 * ADR-0100 D8 work lookup). A source is turned on only after its part of the WS-1 red-team lot and the SR-1 floor pass.
 */
export const AGENT_SUMMARY_SWITCHES: Readonly<Record<AgentWorkSummarySource, string>> = Object.freeze({
  calendar: 'QUOKY_AGENT_SUMMARY_CALENDAR',
  jira: 'QUOKY_AGENT_SUMMARY_JIRA',
  slack: 'QUOKY_AGENT_SUMMARY_SLACK',
  confluence: 'QUOKY_AGENT_SUMMARY_CONFLUENCE',
  github: 'QUOKY_AGENT_SUMMARY_GITHUB',
});

export const AgentConfigErrorCode = {
  AGENT_MODE_INVALID: 'AGENT_MODE_INVALID',
  AGENT_MODE_ACTIVE_NOT_RELEASED: 'AGENT_MODE_ACTIVE_NOT_RELEASED',
  AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE: 'AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE',
  AGENT_MODE_REQUIRES_NL_ACTIVE: 'AGENT_MODE_REQUIRES_NL_ACTIVE',
  AGENT_SUMMARY_SWITCH_INVALID: 'AGENT_SUMMARY_SWITCH_INVALID',
} as const;
export type AgentConfigErrorCode = (typeof AgentConfigErrorCode)[keyof typeof AgentConfigErrorCode];

export class AgentConfigError extends Error {
  constructor(readonly code: AgentConfigErrorCode) {
    super(code);
    this.name = 'AgentConfigError';
  }
}

function parseSummarySwitches(env: NodeJS.ProcessEnv): readonly AgentWorkSummarySource[] {
  const on: AgentWorkSummarySource[] = [];
  for (const source of AGENT_WORK_SUMMARY_SOURCES) {
    const raw = env[AGENT_SUMMARY_SWITCHES[source]];
    if (raw === undefined || raw === 'false') continue;
    if (raw !== 'true') throw new AgentConfigError(AgentConfigErrorCode.AGENT_SUMMARY_SWITCH_INVALID);
    on.push(source);
  }
  return Object.freeze(on);
}

export function parseAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const summarySources = parseSummarySwitches(env);
  const raw = env.QUOKY_AGENT_MODE;
  if (raw === undefined || raw === 'off') return { mode: 'off', summarySources };
  if (raw === 'active') {
    // Decision 5 of 2026-11-02: the egress guard is in `enforce` before `active` (checked first, so it outlives the release gate).
    if (env.QUOKY_EGRESS_GUARD !== 'enforce') throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE);
    throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_ACTIVE_NOT_RELEASED);
  }
  if (raw !== 'shadow') throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_INVALID);
  if (env.QUOKY_NL_INTENT_MODE !== 'active') throw new AgentConfigError(AgentConfigErrorCode.AGENT_MODE_REQUIRES_NL_ACTIVE);
  return { mode: 'shadow', summarySources };
}
