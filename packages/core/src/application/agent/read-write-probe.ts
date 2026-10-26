import type { NlCatalogEntry } from '../nl-routing/catalog';
import { isNlActionEntryId } from '../nl-routing/catalog';
import { NL_ACTION_PROMPT_VERSION, buildSelectionPrompt } from '../nl-routing/selection-prompt';
import { parseSelectionOutput } from '../nl-routing/selection-output';
import { validateSelection } from '../nl-routing/selection-validator';
import { agentUncoveredClauses, type AgentPlanValidationContext, type ValidatedAgentPlan } from './plan-validator';

/**
 * ADR-0121 S2 — the owner-ratified amendment of 2026-10-26 to the TRIGGER of the read + write note of 2026-10-23: when a
 * validated read plan leaves a clause that mentions none of the planned reads (`agentUncoveredClauses`), Core runs the
 * note's one A6 selection over the message (the existing ADR-0120 A6 selection prompt, counted against D7's model-call cap
 * and Q7's hourly cap). If the selector picks an A6 write whose verbatim spans and grounded values lie in that clause (the
 * selection re-validates with that clause ALONE as its grounding text, so no read word or read result reaches it), the
 * read + write path proceeds; a write clause with a list or deictic reference (a `ref` arg) is not run (the decision (f)
 * fixed note); anything else leaves the read plan standing. DM only (the plan validator already is); the kill switch stops
 * it like every agent path; such a turn records no Q1 cursor. Pure: the caller makes the model call; this module builds
 * the prompt and judges the answer.
 */

/** The A6 selection prompt version the probe uses (the deployed A6 prompt). */
export const AGENT_READ_WRITE_PROBE_PROMPT_VERSION = NL_ACTION_PROMPT_VERSION;

/** The uncovered clauses of a validated plan, or `[]` (no probe needed). */
export function agentReadWriteProbeClauses(plan: ValidatedAgentPlan, groundingText: string): string[] {
  return plan.kind === 'run' ? agentUncoveredClauses(plan.steps, groundingText) : [];
}

/**
 * The probe's one A6 selection prompt over the owner's prepared text: the read and A6 entries offered this turn, the
 * structural Reference context (`none` when the caller has none).
 */
export function agentReadWriteProbePrompt(input: { readonly text: string; readonly entries: readonly NlCatalogEntry[]; readonly referenceContext?: string }): string {
  return buildSelectionPrompt({ entries: input.entries, text: input.text, actions: { referenceContext: input.referenceContext ?? 'none' } });
}

export type AgentReadWriteProbeResult =
  /** The selector picked an A6 write lying in one uncovered clause: the read + write path proceeds. */
  | { readonly kind: 'write'; readonly entryId: string; readonly clause: string }
  /** The write clause points at a list position or the read part: not run; the read sections and the fixed note. */
  | { readonly kind: 'note'; readonly entryId: string; readonly clause: string }
  /** Nothing to hand over: the read plan stands. */
  | { readonly kind: 'stands' };

/** Judge the probe's raw A6 selection answer against the uncovered clauses. Pure and total. */
export function agentReadWriteProbeResult(
  raw: string,
  clauses: readonly string[],
  offered: ReadonlyMap<string, NlCatalogEntry>,
  ctx: Pick<AgentPlanValidationContext, 'now' | 'timeZone'>,
): AgentReadWriteProbeResult {
  const output = parseSelectionOutput(raw);
  if (output === null || output.entryId === null || output.ambiguity !== 'CLEAR' || !isNlActionEntryId(output.entryId)) return { kind: 'stands' };
  const entry = offered.get(output.entryId);
  // Codex P2: only a write by the catalog's own risk (LOCAL_WRITE / EXTERNAL_WRITE); `item.summarize` (ITEM_READ) is no
  // write, so a summary of one listed item never re-scores or re-routes a plan.
  if (entry === undefined || (entry.risk !== 'LOCAL_WRITE' && entry.risk !== 'EXTERNAL_WRITE')) return { kind: 'stands' };
  for (const clause of clauses) {
    const validated = validateSelection({ entryId: output.entryId, args: output.args }, { offered, groundingText: clause, now: ctx.now, timeZone: ctx.timeZone, actions: true });
    if (!validated.ok) continue;
    const referenced = entry.args.some((spec) => spec.kind === 'ref' && validated.value.args[spec.name] !== undefined);
    return { kind: referenced ? 'note' : 'write', entryId: output.entryId, clause };
  }
  return { kind: 'stands' };
}
