import type { NlPromptRev } from '@quoky/core';

/**
 * Prompt-revision option of the eval CLIs (owner decision 2026-11-04, "평가 도구 연결 진행해": the tools must compare the
 * active prompt with the candidate). `v73` is the active rule text, `v74` the candidate (its read / A6 action / A6 R2
 * prompts are nl-select.v74 / .v75 / .v76); the planner's `v10` is active and `v11` the candidate. An absent value is the
 * active revision, so a plan made without the option keeps its digest.
 */
export const NL_EVAL_PROMPT_REVS = ['v73', 'v74'] as const;
export const NL_EVAL_DEFAULT_PROMPT_REV: NlPromptRev = 'v73';
export const AGENT_PLAN_EVAL_REVS = ['v10', 'v11'] as const;
export type AgentPlanEvalRev = (typeof AGENT_PLAN_EVAL_REVS)[number];
export const AGENT_PLAN_EVAL_DEFAULT_REV: AgentPlanEvalRev = 'v10';

/** Validate a `--prompt-rev` value; `undefined` stays `undefined` (the active revision). Throws on an unknown one. */
export function parseNlPromptRev(value: string | undefined): NlPromptRev | undefined {
  if (value === undefined) return undefined;
  if (!(NL_EVAL_PROMPT_REVS as readonly string[]).includes(value)) throw new Error(`--prompt-rev must be one of ${NL_EVAL_PROMPT_REVS.join(', ')} (got ${JSON.stringify(value)})`);
  return value as NlPromptRev;
}

/** Validate a `--plan-rev` value; `undefined` stays `undefined` (the active planner revision). Throws on an unknown one. */
export function parseAgentPlanRev(value: string | undefined): AgentPlanEvalRev | undefined {
  if (value === undefined) return undefined;
  if (!(AGENT_PLAN_EVAL_REVS as readonly string[]).includes(value)) throw new Error(`--plan-rev must be one of ${AGENT_PLAN_EVAL_REVS.join(', ')} (got ${JSON.stringify(value)})`);
  return value as AgentPlanEvalRev;
}

/** `--cases a,b,c`: a trimmed, de-duplicated id list; an empty or duplicated list is an error. Existence is checked against the corpus. */
export function parseCaseIds(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('--cases needs at least one case id');
  if (new Set(ids).size !== ids.length) throw new Error('--cases lists a case id twice');
  for (const id of ids) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`--cases: invalid case id ${JSON.stringify(id)}`);
  return ids;
}
