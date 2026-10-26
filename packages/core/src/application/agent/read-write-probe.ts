import type { NlCatalogEntry } from '../nl-routing/catalog';
import { isNlActionEntryId } from '../nl-routing/catalog';
import { NL_ACTION_PROMPT_VERSION, buildSelectionPrompt } from '../nl-routing/selection-prompt';
import { parseSelectionOutput } from '../nl-routing/selection-output';
import { normalizeForMatch } from '../nl-routing/selection-input';
import { validateSelection } from '../nl-routing/selection-validator';
import { nlClauseClaimsWrite, nlWriteClausePointsBack } from '../nl-routing/write-clause';
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
 * The probe's one A6 selection prompt over the UNCOVERED clauses only (CA review of P3, W2: the read clauses' words are
 * never in the prompt, so they cannot be borrowed as a payload), the read and A6 entries offered this turn, and the
 * structural Reference context from BEFORE this turn (executor contract: the probe never sees this turn's read output).
 */
export function agentReadWriteProbePrompt(input: { readonly clauses: readonly string[]; readonly entries: readonly NlCatalogEntry[]; readonly referenceContext?: string }): string {
  return buildSelectionPrompt({ entries: input.entries, text: input.clauses.join('\n'), actions: { referenceContext: input.referenceContext ?? 'none' } });
}

export type AgentReadWriteProbeResult =
  /** The selector picked an A6 write lying in one uncovered clause: the read + write path proceeds. */
  | { readonly kind: 'write'; readonly entryId: string; readonly clause: string }
  /**
   * The write clause points at a list position, at something already shown or at the read part (a `ref` arg, a
   * `deictic-payload`, the determiner grammar): not run; the read sections and the decision (f) note.
   */
  | { readonly kind: 'note'; readonly entryId: string; readonly clause: string }
  /**
   * A write the owner asked for whose details are missing or not in the clause (the selector's NEEDS_CLARIFICATION, a
   * missing or ungrounded arg), in a clause that names the entry by its catalog alias or that a write grammar claims: the
   * existing A6 clarification, with the clause as its grounding (CA W2; owner Q3 example 1).
   */
  | { readonly kind: 'clarify'; readonly entryId: string; readonly clause: string }
  /** Nothing to hand over: the read plan stands. */
  | { readonly kind: 'stands' };

/** The validation failures a clarification answers (the request is there; a detail is missing or not the owner's). */
const CLARIFY_REASONS: ReadonlySet<string> = new Set(['missing-arg', 'ungrounded']);

/** Whether the clause names the entry by one of its catalog aliases (normalized; a multi-word alias as a phrase). */
function namesEntry(clause: string, entry: NlCatalogEntry): boolean {
  const text = normalizeForMatch(clause);
  return entry.aliases.some((alias) => {
    const name = normalizeForMatch(alias);
    return name.length > 0 && text.includes(name);
  });
}

/** Judge the probe's raw A6 selection answer against the uncovered clauses. Pure and total. */
export function agentReadWriteProbeResult(
  raw: string,
  clauses: readonly string[],
  offered: ReadonlyMap<string, NlCatalogEntry>,
  ctx: Pick<AgentPlanValidationContext, 'now' | 'timeZone'>,
): AgentReadWriteProbeResult {
  const output = parseSelectionOutput(raw);
  if (output === null || output.entryId === null || !isNlActionEntryId(output.entryId)) return { kind: 'stands' };
  const entry = offered.get(output.entryId);
  // Codex P2: only a write by the catalog's own risk (LOCAL_WRITE / EXTERNAL_WRITE); `item.summarize` (ITEM_READ) is no
  // write, so a summary of one listed item never re-scores or re-routes a plan.
  if (entry === undefined || (entry.risk !== 'LOCAL_WRITE' && entry.risk !== 'EXTERNAL_WRITE')) return { kind: 'stands' };
  // The payload spans (a time span such as a reminder's `when` is no payload, as in the validator's deictic check).
  const spans = entry.args.flatMap((spec) => (spec.kind === 'span' && spec.allowsTimeWords !== true && typeof output.args[spec.name] === 'string' ? [output.args[spec.name] as string] : []));
  // A list or deictic reference in the raw output (any non-empty `ref`, quoted or not) points back whatever validation says.
  const hasRef = entry.args.some((spec) => spec.kind === 'ref' && typeof output.args[spec.name] === 'string' && (output.args[spec.name] as string).trim().length > 0);
  let clarify: string | undefined;
  for (const clause of clauses) {
    const validated = validateSelection({ entryId: output.entryId, args: output.args }, { offered, groundingText: clause, now: ctx.now, timeZone: ctx.timeZone, actions: true });
    const requested = namesEntry(clause, entry) || nlClauseClaimsWrite(clause, { now: ctx.now, timeZone: ctx.timeZone });
    // The write belongs to this clause when it validates there, when its only failures are a pointing-back payload, a
    // missing or ungrounded detail, or a reference the validator cannot read (a quoted `ref`), in a clause that asks for it.
    const forThisClause = validated.ok || validated.reason === 'deictic-payload' || ((CLARIFY_REASONS.has(validated.reason) || hasRef) && requested);
    if (!forThisClause) continue;
    // CA W1 / Codex P2: references first, before any clarification — a payload that points back (a `ref`, a deictic-only
    // or determiner-led canonical span, the determiner grammar on the clause) is never written and never asked about.
    if (hasRef || nlWriteClausePointsBack(clause, spans) || (!validated.ok && validated.reason === 'deictic-payload')) {
      return { kind: 'note', entryId: output.entryId, clause };
    }
    if (validated.ok && output.ambiguity === 'CLEAR') return { kind: 'write', entryId: output.entryId, clause };
    if (requested) clarify ??= clause;
  }
  return clarify !== undefined ? { kind: 'clarify', entryId: output.entryId, clause: clarify } : { kind: 'stands' };
}
