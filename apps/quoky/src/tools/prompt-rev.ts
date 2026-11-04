import { AGENT_PLAN_ACTIVE_REV, nlEffectivePromptRev, type NlPromptMode, type NlPromptRev } from '@quoky/core';

/**
 * Prompt-revision option of the eval CLIs (owner decision 2026-11-04, "평가 도구 연결 진행해": the tools must compare the
 * active prompt with the other revision). An ABSENT value is the ACTIVE revision of the plan's mode (owner decision
 * 2026-11-04, enablement): read modes v74 (nl-select.v74), action / read-regression / R2 modes v73 text (nl-select.v71 /
 * v72), planner v11. Explicit values keep working: `--prompt-rev v73` on a read mode = the previous read v73;
 * `--prompt-rev v74` on an action / R2 mode = the candidates v75 / v76; `--plan-rev v10` = the previous planner. A plan
 * stores a revision only when it differs from its mode's active one ({@link storedNlPromptRev}), so a plan made without
 * the option reproduces the production prompt of that mode.
 */
export const NL_EVAL_PROMPT_REVS = ['v73', 'v74', 'v77'] as const;
export const AGENT_PLAN_EVAL_REVS = ['v10', 'v11'] as const;
export type AgentPlanEvalRev = (typeof AGENT_PLAN_EVAL_REVS)[number];
export const AGENT_PLAN_EVAL_DEFAULT_REV: AgentPlanEvalRev = AGENT_PLAN_ACTIVE_REV;

/** The revision a plan of `mode` records: the explicit one when it differs from the mode's active revision, else none. */
export function storedNlPromptRev(mode: NlPromptMode, rev: NlPromptRev | undefined): NlPromptRev | undefined {
  return rev !== undefined && rev !== nlEffectivePromptRev(mode) ? rev : undefined;
}

/** The planner revision a plan records: only a non-active one (`v10`). */
export function storedAgentPlanRev(rev: AgentPlanEvalRev | undefined): AgentPlanEvalRev | undefined {
  return rev !== undefined && rev !== AGENT_PLAN_EVAL_DEFAULT_REV ? rev : undefined;
}

/**
 * Validate a `--prompt-rev` value; `undefined` stays `undefined` (the active revision). Throws on an unknown one.
 * `v77` (nl-select.v77 / v78) is an action / R2 text: it is rejected for the read modes (`read`).
 */
export function parseNlPromptRev(value: string | undefined, mode: 'read' | 'action' = 'read'): NlPromptRev | undefined {
  if (value === undefined) return undefined;
  if (!(NL_EVAL_PROMPT_REVS as readonly string[]).includes(value)) throw new Error(`--prompt-rev must be one of ${NL_EVAL_PROMPT_REVS.join(', ')} (got ${JSON.stringify(value)})`);
  if (value === 'v77' && mode === 'read') throw new Error('--prompt-rev v77 is an action / R2 prompt (nl-select.v77 / v78); it is not valid for the read modes');
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

/**
 * `--cases` over a corpus: the requested ids, exact. An unknown id is an error; the result is the corpus ids in corpus order
 * (the same list as the intent mode's plan). No other filter exists in these modes, so none can drop a requested id.
 */
export function selectCaseIds(all: readonly string[], requested: readonly string[]): string[] {
  const known = new Set(all);
  for (const id of requested) if (!known.has(id)) throw new Error(`unknown case ${id}`);
  const wanted = new Set(requested);
  return all.filter((id) => wanted.has(id));
}
