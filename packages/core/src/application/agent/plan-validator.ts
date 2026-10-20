import type { IsoTimestamp } from '../../domain';
import { OWNER_TEXT_FLOW_LABEL, type FlowLabel } from '../../domain/flow-label';
import { isNlActionEntryId, isNlWave1EntryId, type NlArgs, type NlCatalogEntry, type NlWave1EntryId } from '../nl-routing/catalog';
import type { NlResolvedRange } from '../nl-routing/symbolic-time';
import { validateSelection, type NlValidationFailureReason } from '../nl-routing/selection-validator';
import { AGENT_READ_SOURCES } from './flow-policy';
import { AGENT_PLAN_MAX_STEPS, type AgentPlan, type AgentPlanStep } from './plan-schema';

/**
 * ADR-0121 D2 / D5 / D7 (stage S2 P1): the deterministic `PlanValidator`. Every rule is static: it reads the plan, the
 * offered catalog and the owner's own non-quoted words, and nothing else (no read, no model, no state). A refusal names
 * one closed reason (and the failing step number), never a value.
 *
 * Rules, in order:
 * 1. **DM only** (D5): an agent plan is valid only in the owner's direct conversation.
 * 2. **Step mix** (D7, Q6, A6-D4): 1–6 steps, at most 4 reads and 3 summaries, at least one read. A plan of more than one
 *    step never names `help.topic`, `brief.today` or any A6 action entry.
 * 3. **Per read step**: a closed READ entry (never ITEM_READ, LOCAL_WRITE, EXTERNAL_WRITE or an A6 id), offered this turn,
 *    whose arguments pass ADR-0120 D4 unchanged (`validateSelection`: closed ids, bounds, symbolic time, grounding,
 *    the credential guard). **Dates only symbolic**: an absolute date is valid only when the owner's own words (or the
 *    previous selection) carry it — never a date taken from content.
 * 4. **References** (D2): to an EARLIER READ step only; source-bound (the same source and destination origin, so a mail,
 *    calendar or Drive id never feeds Jira); the closed id field that source projects (never a date field); at most 10
 *    values per reference and 10 per run.
 * 5. **Summaries**: a closed output schema over earlier read steps only.
 *
 * `NEEDS_CLARIFICATION` with every rule met is `clarify` (one numbered question), not a refusal.
 */

/** ADR-0121 D7 per-run step bounds. */
export const AGENT_PLAN_MAX_READS = 4;
export const AGENT_PLAN_MAX_SUMMARIES = 3;
/** ADR-0121 D2: at most 10 referenced values per reference and per run. */
export const AGENT_PLAN_MAX_REF_VALUES = 10;
export const AGENT_PLAN_MAX_RUN_REF_VALUES = 10;
/** The closed quarantined-summary output schemas (stage S2 P3 binds each to its bounded shape). */
export const AGENT_PLAN_SUMMARY_SCHEMAS = ['digest.v1', 'meeting-digest.v1'] as const;
/** Q6: entries that may only ever be a one-step plan. */
export const AGENT_SINGLE_STEP_ONLY: readonly NlWave1EntryId[] = ['help.topic', 'brief.today'];

export type AgentPlanRefusal =
  | 'not-dm'
  | 'too-many-steps'
  | 'too-many-reads'
  | 'too-many-summaries'
  | 'no-read'
  | 'single-step-only'
  | 'a6-in-plan'
  | 'unknown-entry'
  | 'not-offered'
  | 'not-read'
  | 'date-ungrounded'
  | 'step-invalid'
  | 'ref-forward'
  | 'ref-not-read'
  | 'ref-date'
  | 'ref-cross-source'
  | 'ref-field'
  | 'ref-too-many'
  | 'run-refs-too-many'
  | 'summary-schema'
  | 'summary-source';

export interface AgentPlanValidationContext {
  /** The entries offered this turn (registered and configured). */
  readonly offered: ReadonlyMap<string, NlCatalogEntry>;
  /** The owner's non-quoted text (`prepareSelectionInput().groundingText`). */
  readonly groundingText: string;
  /** The previous selection's args (structure only). */
  readonly previousArgs?: NlArgs;
  readonly now: IsoTimestamp;
  readonly timeZone: string;
  /** The turn is the owner's direct conversation. Absent or false: refused (fail closed). */
  readonly direct?: boolean;
}

/** Where an argument value came from (ADR-0121 D2): the owner's words, or an earlier step's projected ids. */
export type AgentArgProvenance =
  | { readonly kind: 'literal'; readonly label: FlowLabel }
  | { readonly kind: 'reference'; readonly step: number; readonly entryId: NlWave1EntryId; readonly origin: string };

export type ValidatedAgentStep =
  | {
      readonly kind: 'read';
      readonly entry: NlCatalogEntry;
      /** Canonical (ADR-0120 D4), every value a literal grounded in the owner's words. */
      readonly args: NlArgs;
      readonly range?: NlResolvedRange;
      readonly ref?: { readonly step: number; readonly field: string; readonly take: number; readonly provenance: Extract<AgentArgProvenance, { kind: 'reference' }> };
      readonly provenance: Readonly<Record<string, AgentArgProvenance>>;
    }
  | { readonly kind: 'summarize'; readonly from: readonly number[]; readonly schema: (typeof AGENT_PLAN_SUMMARY_SCHEMAS)[number] };

export type ValidatedAgentPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'run' | 'clarify'; readonly steps: readonly ValidatedAgentStep[] };

export type AgentPlanValidation =
  | { readonly ok: true; readonly plan: ValidatedAgentPlan }
  | {
      readonly ok: false;
      readonly reason: AgentPlanRefusal;
      /** 1-based number of the failing step. */
      readonly step?: number;
      /** `step-invalid`: the ADR-0120 D4 reason (a closed value). */
      readonly stepReason?: NlValidationFailureReason;
    };

/** Validate a parsed plan. Pure and total. */
export function validateAgentPlan(plan: AgentPlan, ctx: AgentPlanValidationContext): AgentPlanValidation {
  if (ctx.direct !== true) return refuse('not-dm');
  if (plan.kind === 'none') return { ok: true, plan: { kind: 'none' } };
  const steps = plan.steps;
  if (steps.length === 0 || steps.length > AGENT_PLAN_MAX_STEPS) return refuse('too-many-steps');
  const reads = steps.filter((step) => step.kind === 'read');
  const summaries = steps.filter((step) => step.kind === 'summarize');
  if (reads.length === 0) return refuse('no-read');
  if (reads.length > AGENT_PLAN_MAX_READS) return refuse('too-many-reads');
  if (summaries.length > AGENT_PLAN_MAX_SUMMARIES) return refuse('too-many-summaries');
  if (steps.length > 1) {
    for (const [index, step] of steps.entries()) {
      if (step.kind !== 'read') continue;
      if (isNlActionEntryId(step.entryId)) return refuse('a6-in-plan', index + 1);
      if ((AGENT_SINGLE_STEP_ONLY as readonly string[]).includes(step.entryId)) return refuse('single-step-only', index + 1);
    }
  }
  const validated: ValidatedAgentStep[] = [];
  let refValues = 0;
  for (const [index, step] of steps.entries()) {
    const number = index + 1;
    if (step.kind === 'summarize') {
      const checked = checkSummary(step, number, steps);
      if (!checked.ok) return checked;
      validated.push(checked.step);
      continue;
    }
    const checked = checkRead(step, number, steps, ctx);
    if (!checked.ok) return checked;
    if (checked.step.kind === 'read' && checked.step.ref !== undefined) {
      refValues += checked.step.ref.take;
      if (refValues > AGENT_PLAN_MAX_RUN_REF_VALUES) return refuse('run-refs-too-many', number);
    }
    validated.push(checked.step);
  }
  return { ok: true, plan: { kind: plan.ambiguity === 'NEEDS_CLARIFICATION' ? 'clarify' : 'run', steps: validated } };
}

type StepCheck = { readonly ok: true; readonly step: ValidatedAgentStep } | Extract<AgentPlanValidation, { ok: false }>;

function refuse(reason: AgentPlanRefusal, step?: number, stepReason?: NlValidationFailureReason): Extract<AgentPlanValidation, { ok: false }> {
  return { ok: false, reason, ...(step !== undefined ? { step } : {}), ...(stepReason !== undefined ? { stepReason } : {}) };
}

function checkRead(step: Extract<AgentPlanStep, { kind: 'read' }>, number: number, steps: readonly AgentPlanStep[], ctx: AgentPlanValidationContext): StepCheck {
  if (isNlActionEntryId(step.entryId)) return refuse('not-read', number);
  if (!isNlWave1EntryId(step.entryId)) return refuse('unknown-entry', number);
  const entry = ctx.offered.get(step.entryId);
  if (entry === undefined) return refuse('not-offered', number);
  if (entry.risk !== 'READ') return refuse('not-read', number);
  const ungroundedDate = entry.args.some((spec) => {
    const value = step.args[spec.name];
    return spec.kind === 'range' && typeof value === 'string' && value !== ctx.previousArgs?.[spec.name] && !absoluteDatesGrounded(value, ctx.groundingText);
  });
  if (ungroundedDate) return refuse('date-ungrounded', number);
  const result = validateSelection(
    { entryId: step.entryId, args: step.args },
    {
      offered: ctx.offered,
      groundingText: ctx.groundingText,
      ...(ctx.previousArgs !== undefined ? { previousArgs: ctx.previousArgs } : {}),
      now: ctx.now,
      timeZone: ctx.timeZone,
    },
  );
  if (!result.ok) return refuse('step-invalid', number, result.reason);
  const provenance: Record<string, AgentArgProvenance> = {};
  for (const name of Object.keys(result.value.args)) provenance[name] = { kind: 'literal', label: OWNER_TEXT_FLOW_LABEL };
  const base = {
    kind: 'read' as const,
    entry: result.value.entry,
    args: result.value.args,
    ...(result.value.range !== undefined ? { range: result.value.range } : {}),
    provenance,
  };
  if (step.ref === undefined) return { ok: true, step: base };
  const ref = step.ref;
  if (ref.step >= number) return refuse('ref-forward', number);
  const source = steps[ref.step - 1];
  if (source === undefined || source.kind !== 'read' || !isNlWave1EntryId(source.entryId)) return refuse('ref-not-read', number);
  if (DATE_FIELD.test(ref.field)) return refuse('ref-date', number);
  const from = AGENT_READ_SOURCES[source.entryId];
  const to = AGENT_READ_SOURCES[step.entryId];
  if (from.source !== to.source || from.origin !== to.origin) return refuse('ref-cross-source', number);
  if (from.refField === undefined || ref.field !== from.refField) return refuse('ref-field', number);
  if (ref.take > AGENT_PLAN_MAX_REF_VALUES) return refuse('ref-too-many', number);
  const refProvenance = { kind: 'reference' as const, step: ref.step, entryId: source.entryId, origin: from.origin };
  return { ok: true, step: { ...base, ref: { step: ref.step, field: ref.field, take: ref.take, provenance: refProvenance } } };
}

function checkSummary(step: Extract<AgentPlanStep, { kind: 'summarize' }>, number: number, steps: readonly AgentPlanStep[]): StepCheck {
  if (!(AGENT_PLAN_SUMMARY_SCHEMAS as readonly string[]).includes(step.schema)) return refuse('summary-schema', number);
  if (new Set(step.from).size !== step.from.length) return refuse('summary-source', number);
  for (const from of step.from) {
    if (from >= number || steps[from - 1]?.kind !== 'read') return refuse('summary-source', number);
  }
  return { ok: true, step: { kind: 'summarize', from: [...step.from], schema: step.schema as (typeof AGENT_PLAN_SUMMARY_SCHEMAS)[number] } };
}

/** A reference field that would carry a date or time (dates come only from the planner's symbolic time, D2). */
const DATE_FIELD = /date|day|time|when|due|start|end|range|period|deadline|week|month|year/i;

/** An absolute date (`MM-DD`, `YYYY-MM-DD`, or a span of them) in a range value. */
const ABSOLUTE_DATE = /(?:(\d{4})-)?(\d{1,2})-(\d{1,2})/g;

/**
 * Dates only symbolic (ADR-0121 D2): every absolute date in a range value must be named by a DATE EXPRESSION in the
 * owner's own words — `M월 D일`, `M/D` or `M-D` (leading zeros optional; `YYYY-M-D` and `YYYY/M/D` included) — and a
 * written year must appear too. Two numbers elsewhere in the text never ground a date ("10시 20분" is no 10-20; CA
 * review). A purely symbolic value (`this-week`, `fri`) has no absolute date and passes. Pure.
 */
export function absoluteDatesGrounded(value: string, groundingText: string): boolean {
  for (const match of value.matchAll(ABSOLUTE_DATE)) {
    const [, year, month, day] = match;
    if (month === undefined || day === undefined || !dateExpressionIn(Number(month), Number(day), groundingText)) return false;
    if (year !== undefined && !new RegExp(`(?<![0-9])${Number(year)}(?![0-9])`, 'u').test(groundingText)) return false;
  }
  return true;
}

function dateExpressionIn(month: number, day: number, text: string): boolean {
  const m = `(?<![0-9])0?${month}`;
  const d = `0?${day}(?![0-9])`;
  return new RegExp(`${m}\\s*월\\s*${d}\\s*일|${m}\\s*/\\s*${d}|${m}-${d}`, 'u').test(text);
}
