import type { IsoTimestamp } from '../../domain';
import { OWNER_TEXT_FLOW_LABEL, type FlowLabel } from '../../domain/flow-label';
import { isNlActionEntryId, isNlWave1EntryId, type NlArgs, type NlCatalogEntry, type NlCatalogEntryId, type NlWave1EntryId } from '../nl-routing/catalog';
import { isNlTimeWord, nlRangeSymbolWords, nlWeekdayMentionRanges, nlWeekdayMentions, normalizeNlRangeSymbol, resolveNlRange, type NlResolvedRange } from '../nl-routing/symbolic-time';
import { nlReadNotRequest } from '../nl-routing/read-statement';
import { normalizeForMatch } from '../nl-routing/selection-input';
import { groundingWordIn, validateSelection, type NlValidationFailureReason } from '../nl-routing/selection-validator';
import { nlIsPastStatement } from '../nl-routing/statement-guard';
import { aliasStarts, conjunctTokens } from './conjuncts';
import { AGENT_READ_SOURCES } from './flow-policy';
import { AGENT_PLAN_MAX_STEPS, type AgentPlan, type AgentPlanStep } from './plan-schema';

/**
 * ADR-0121 D2 / D5 / D7 (stage S2 P1): the deterministic `PlanValidator`. Every rule is static: it reads the plan, the
 * offered catalog and the owner's own non-quoted words, and nothing else (no read, no model, no state). A refusal names
 * one closed reason (and the failing step number), never a value.
 *
 * Rules, in order:
 * 1. **DM only** (D5): an agent plan is valid only in the owner's direct conversation.
 * 1a. **Not a request** (ADR-0120 A7, the selection path's message-level vetoes, shared so the eval and the runtime apply
 *    one rule; CA review of S2 P2): a past statement (`veto-past-statement`), or a read step whose own sentence only
 *    quotes or reports a request (`veto-quoted-request`) or gives a reason for a feeling (`veto-reason-statement`).
 * 2. **Step mix** (D7, Q6 as amended by ADR-0121 A1 decision (e), A6-D4): 1–6 steps, at most 3 summaries, at least one
 *    read. A plan of more than one step never names `help.topic` (help is split off before planning, A1-E1) or any A6
 *    action entry. `brief.today` may be ONE step of a plan (A1-E2): at most one brief step (B4: it counts as one read),
 *    no summary over it (B2, `summary-covers-brief`), no reference from or to it (B3: it has no id field).
 * 2a. **Unbounded → a bounded-suggestion ask** (the owner's review of 2026-10-21, decision (h)): a plan over a bound — more
 *    than 4 reads, one entry read for 3 or more different periods (a read per day, week or month), more than 10
 *    referenced values, or (rule 6) more than 10 connector queries — never runs and is never a silent none: it is `ask` with reason `unbounded` and ONE deterministic
 *    narrower plan Core derives from the planner's own steps (the period → this week, or this month; the first 4 reads;
 *    the first 10 referenced values; then the first reads that fit the query charge). The suggestion passes this validator itself (the period as Core's own value);
 *    when it does not, the plan is refused (fail closed). The ask runs nothing: an owner reply that takes the suggestion
 *    is a new turn.
 * 3. **Per read step**: a closed READ entry (never ITEM_READ, LOCAL_WRITE, EXTERNAL_WRITE or an A6 id), offered this turn,
 *    whose arguments pass ADR-0120 D4 unchanged (`validateSelection`: closed ids, bounds, symbolic time, grounding,
 *    the credential guard). **Dates only symbolic**: an absolute date is valid only when the owner's own words (or the
 *    previous selection) carry it — never a date taken from content.
 * 4. **References** (D2): to an EARLIER READ step only; source-bound (the same source and destination origin, so a mail,
 *    calendar or Drive id never feeds Jira); the closed id field that source projects (never a date field); at most 10
 *    values per reference and 10 per run (ADR-0121 D2, kept by the owner on 2026-10-21). The cap bounds per-item DETAIL
 *    reads only: a listing (a release's issue list, a Jira list) is one read and is not capped here.
 * 5. **Summaries**: a closed output schema over earlier read steps only, never over the brief (A1-E2 B2).
 * 6. **Connector calls** (D7; A1-E2 B4; the S2 P3 "same-source detail reads" note; CA finding 3 of P3 part 1): the plan's
 *    static charge is at most 10 connector calls, ONE unit being one connector query (a named port call). Each read is its
 *    entry's worst case (`AGENT_READ_SOURCES[…].connectorQueries`: a listing 1, `jira.release` 8, `todo.list` 2, the
 *    brief 4 or its configured worst case, reminders and help 0); a reference step is ONE bulk `items-by-key` query.
 *    Over it, the plan is answered like decision (h): an ask (bound `calls`) suggesting its first reads that fit; only a
 *    plan whose first read alone does not fit is refused `over-bound` (CA re-check W2). The HTTP requests behind the queries (pages, per-item metadata, token refreshes) are not this
 *    unit: the record (S2 P3 part 2 note) lists them, and choosing HTTP requests as the D7 unit is an open owner / CA
 *    decision (most single reads exceed 10 requests at their worst).
 *
 * `NEEDS_CLARIFICATION` with every rule met is `clarify` (one numbered question), not a refusal.
 */

/** ADR-0121 D7 per-run step bounds. */
export const AGENT_PLAN_MAX_READS = 4;
export const AGENT_PLAN_MAX_SUMMARIES = 3;
/**
 * ADR-0121 D2: at most 10 referenced values (per-item detail reads) per reference and per run. The owner kept 10 on
 * 2026-10-21 (decision (c)); with more issues the reply says "N개 중 10개" plus a fixed hint for the next 10 (P3 TODO).
 */
export const AGENT_PLAN_MAX_REF_VALUES = 10;
export const AGENT_PLAN_MAX_RUN_REF_VALUES = 10;
/** Decision (h): one entry read for this many different periods or more is a read per day, week or month (unbounded). */
export const AGENT_PLAN_PER_PERIOD_STEPS = 3;
/** The closed bounds an `unbounded` ask names. */
export const AGENT_UNBOUNDED_KINDS = ['per-period', 'reads', 'refs', 'calls'] as const;
export type AgentUnboundedKind = (typeof AGENT_UNBOUNDED_KINDS)[number];
/** The closed quarantined-summary output schemas (stage S2 P3 binds each to its bounded shape). */
export const AGENT_PLAN_SUMMARY_SCHEMAS = ['digest.v1', 'meeting-digest.v1'] as const;
/**
 * Q6 as amended by ADR-0121 A1 decision (e) (A1-E1 / A1-E2): `help.topic` may only ever be a one-step plan (help is split
 * off before planning); `brief.today` left this list and may be one step of a plan under B1–B6.
 */
export const AGENT_SINGLE_STEP_ONLY: readonly NlWave1EntryId[] = ['help.topic'];
/** ADR-0121 D7: at most this many connector (external) calls per run. */
export const AGENT_RUN_MAX_CONNECTOR_CALLS = 10;
/**
 * A1-E2 B4: the brief's worst case of connector queries with every section on (calendar 1, assigned work 2, mail 1; the
 * mail query's ≤ 3 metadata GETs are HTTP requests, not queries). A caller may pass the configured worst case
 * (`briefConnectorCalls`); the shadow job charges this one (every section on).
 */
export const AGENT_BRIEF_MAX_CONNECTOR_CALLS = AGENT_READ_SOURCES['brief.today'].connectorQueries;

export type AgentPlanRefusal =
  | 'not-dm'
  | 'veto-past-statement'
  | 'veto-quoted-request'
  | 'veto-reason-statement'
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
  | 'range-unnamed'
  | 'range-ambiguous'
  | 'step-invalid'
  | 'ref-forward'
  | 'ref-not-read'
  | 'ref-date'
  | 'ref-cross-source'
  | 'ref-field'
  | 'ref-too-many'
  | 'run-refs-too-many'
  | 'summary-schema'
  | 'summary-source'
  /** A1-E2: more than one `brief.today` step. */
  | 'brief-repeated'
  /** A1-E2 B2: a summary step covering the brief. */
  | 'summary-covers-brief'
  /** D7 / A1-E2 B4: the plan's static connector-call charge is over {@link AGENT_RUN_MAX_CONNECTOR_CALLS}. */
  | 'over-bound';

export interface AgentPlanValidationContext {
  /** The entries offered this turn (registered and configured). */
  readonly offered: ReadonlyMap<string, NlCatalogEntry>;
  /** The owner's non-quoted text (`prepareSelectionInput().groundingText`). */
  readonly groundingText: string;
  /** The previous selection's args (structure only). */
  readonly previousArgs?: NlArgs;
  /** The previous selection's entry: a fallback restores a previous value only for the same entry (Codex P2). */
  readonly previousEntryId?: NlCatalogEntryId;
  readonly now: IsoTimestamp;
  readonly timeZone: string;
  /** The turn is the owner's direct conversation. Absent or false: refused (fail closed). */
  readonly direct?: boolean;
  /**
   * A1-E2 B4: the brief's configured worst case of connector queries (by the brief flags); absent:
   * {@link AGENT_BRIEF_MAX_CONNECTOR_CALLS} (every section on).
   */
  readonly briefConnectorCalls?: number;
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
  | {
      readonly kind: 'run' | 'clarify';
      readonly steps: readonly ValidatedAgentStep[];
      /** The static connector-call charge (rule 6); the executor's run budget starts from it. */
      readonly connectorCalls: number;
      /**
       * Owner decision (a), CA finding 5: the read step the owner related the other reads to (1-based); kept only when it
       * names a read step and another read of a different source exists. The reply adds the fixed "not checked" note
       * naming that step's source; no step depends on it.
       */
      readonly related?: number;
    }
  /**
   * Decision (h): the planner's plan is over a bound. Nothing runs; the reply asks whether to read `suggestion` instead (a
   * validated, bounded plan Core derived; its narrowed period has no owner provenance, so it never runs from the ask).
   */
  | { readonly kind: 'ask'; readonly reason: 'unbounded'; readonly bound: AgentUnboundedKind; readonly suggestion: readonly ValidatedAgentStep[] };

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
  if (nlIsPastStatement(ctx.groundingText)) return refuse('veto-past-statement');
  // A quoted span consumed as ANY step's search keyword is the owner's search term for the whole plan (Codex P2): each
  // step's quoted-request check sees its own args plus every step's keyword-kind values. An unconsumed quote still vetoes.
  const planKeywords: Record<string, string> = {};
  for (const step of steps) {
    if (step.kind !== 'read') continue;
    const entry = ctx.offered.get(step.entryId);
    for (const spec of entry?.args ?? []) {
      const value = step.args[spec.name];
      if (spec.kind === 'keyword' && typeof value === 'string') planKeywords[`plan${Object.keys(planKeywords).length}`] = value;
    }
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'read') continue;
    const veto = nlReadNotRequest(ctx.groundingText, { ...step.args, ...planKeywords });
    if (veto !== undefined) return refuse(veto === 'quoted-request' ? 'veto-quoted-request' : 'veto-reason-statement', index + 1);
  }
  if (steps.length === 0 || steps.length > AGENT_PLAN_MAX_STEPS) return refuse('too-many-steps');
  const reads = steps.filter((step) => step.kind === 'read');
  const summaries = steps.filter((step) => step.kind === 'summarize');
  if (reads.length === 0) return refuse('no-read');
  if (summaries.length > AGENT_PLAN_MAX_SUMMARIES) return refuse('too-many-summaries');
  // A6 and single-step-only entries refuse before any bound is considered: an unbounded plan holding one is never an ask.
  if (steps.length > 1) {
    let briefs = 0;
    for (const [index, step] of steps.entries()) {
      if (step.kind !== 'read') continue;
      if (isNlActionEntryId(step.entryId)) return refuse('a6-in-plan', index + 1);
      if ((AGENT_SINGLE_STEP_ONLY as readonly string[]).includes(step.entryId)) return refuse('single-step-only', index + 1);
      // A1-E2: at most one brief step in a plan.
      if (step.entryId === 'brief.today' && ++briefs > 1) return refuse('brief-repeated', index + 1);
    }
  }
  const unbounded = unboundedOf(steps, ctx);
  if (unbounded !== undefined) return askUnbounded(steps, unbounded, ctx);
  const temporal = steps.length > 1 ? stepTemporalTexts(steps, ctx) : undefined;
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
    const checked = checkRead(step, number, steps, ctx, temporal);
    if (!checked.ok) return checked;
    if (checked.step.kind === 'read' && checked.step.ref !== undefined) {
      refValues += checked.step.ref.take;
      if (refValues > AGENT_PLAN_MAX_RUN_REF_VALUES) return refuse('run-refs-too-many', number);
    }
    validated.push(checked.step);
  }
  const connectorCalls = agentPlanConnectorCharge(validated, ctx);
  if (connectorCalls > AGENT_RUN_MAX_CONNECTOR_CALLS) {
    // CA re-check W2 (decision (h): never a silent none): over the query charge, ask with the first reads that fit.
    const reads = steps.filter((step) => step.kind === 'read').length;
    const fitted = fitToCharge(steps, reads - 1, ctx);
    return fitted === undefined ? refuse('over-bound') : { ok: true, plan: { kind: 'ask', reason: 'unbounded', bound: 'calls', suggestion: fitted } };
  }
  const related = plan.form === 'steps' && plan.related !== undefined ? relatedStep(validated, plan.related) : undefined;
  return {
    ok: true,
    plan: { kind: plan.ambiguity === 'NEEDS_CLARIFICATION' ? 'clarify' : 'run', steps: validated, connectorCalls, ...(related !== undefined ? { related } : {}) },
  };
}

/** The related step when it is a read and another read of a different source exists; else none (the flag is dropped). */
function relatedStep(steps: readonly ValidatedAgentStep[], related: number): number | undefined {
  const target = steps[related - 1];
  if (target?.kind !== 'read' || !isNlWave1EntryId(target.entry.id)) return undefined;
  const source = AGENT_READ_SOURCES[target.entry.id].source;
  return steps.some((step) => step.kind === 'read' && isNlWave1EntryId(step.entry.id) && AGENT_READ_SOURCES[step.entry.id].source !== source) ? related : undefined;
}

/**
 * Rule 6 (D7; A1-E2 B4; the S2 P3 "same-source detail reads" note; CA finding 3): the static charge of validated steps in
 * connector queries. Each read is its entry's worst case; a reference step is ONE bulk detail query (whatever its
 * `take`); the brief is its configured worst case. Summaries call no connector. Pure.
 */
export function agentPlanConnectorCharge(steps: readonly ValidatedAgentStep[], ctx: Pick<AgentPlanValidationContext, 'briefConnectorCalls'>): number {
  let calls = 0;
  for (const step of steps) {
    if (step.kind !== 'read' || !isNlWave1EntryId(step.entry.id)) continue;
    if (step.ref !== undefined) calls += 1;
    else if (step.entry.id === 'brief.today') calls += ctx.briefConnectorCalls ?? AGENT_BRIEF_MAX_CONNECTOR_CALLS;
    else calls += AGENT_READ_SOURCES[step.entry.id].connectorQueries;
  }
  return calls;
}

type StepCheck = { readonly ok: true; readonly step: ValidatedAgentStep } | Extract<AgentPlanValidation, { ok: false }>;

type ReadStep = Extract<AgentPlanStep, { kind: 'read' }>;

interface Unbounded {
  readonly bound: AgentUnboundedKind;
  /** The refusal when no valid suggestion exists (the reason the bound had before decision (h)). */
  readonly refusal: AgentPlanRefusal;
  /** `per-period`: the repeated entry and its range arg. */
  readonly entryId?: string;
  readonly rangeArg?: string;
}

/** Decision (h): which bound the plan is over, in a fixed order (a period repetition, then reads, then references). */
function unboundedOf(steps: readonly AgentPlanStep[], ctx: AgentPlanValidationContext): Unbounded | undefined {
  const reads = steps.filter((step): step is ReadStep => step.kind === 'read');
  const periods = new Map<string, { readonly rangeArg: string; readonly values: Set<string> }>();
  for (const step of reads) {
    const spec = ctx.offered.get(step.entryId)?.args.find((candidate) => candidate.kind === 'range');
    const value = spec !== undefined ? step.args[spec.name] : undefined;
    if (spec === undefined || typeof value !== 'string') continue;
    const slot = periods.get(step.entryId) ?? { rangeArg: spec.name, values: new Set<string>() };
    slot.values.add(value);
    periods.set(step.entryId, slot);
  }
  for (const [entryId, slot] of periods) {
    if (slot.values.size >= AGENT_PLAN_PER_PERIOD_STEPS) {
      return { bound: 'per-period', refusal: reads.length > AGENT_PLAN_MAX_READS ? 'too-many-reads' : 'range-ambiguous', entryId, rangeArg: slot.rangeArg };
    }
  }
  if (reads.length > AGENT_PLAN_MAX_READS) return { bound: 'reads', refusal: 'too-many-reads' };
  const takes = reads.map((step) => step.ref?.take ?? 0);
  if (takes.some((take) => take > AGENT_PLAN_MAX_REF_VALUES)) return { bound: 'refs', refusal: 'ref-too-many' };
  if (takes.reduce((sum, take) => sum + take, 0) > AGENT_PLAN_MAX_RUN_REF_VALUES) return { bound: 'refs', refusal: 'run-refs-too-many' };
  return undefined;
}

/**
 * Decision (h): the ask for an unbounded plan, with ONE deterministic narrower plan derived from the planner's own steps:
 * - `per-period`: the repeated entry once, with its other args from its first step and the period narrowed to `this-week`
 *   when every period it named lies inside this week, else `this-month`; plus one summary when the plan summarized it;
 * - `reads`: the first 4 reads in the owner's order, with the summaries and references among them renumbered;
 * - `refs` (also after `reads`): the referenced values clamped in step order to 10 per reference and per run; a reference
 *   left with none is dropped.
 * The suggestion is validated by this validator (the narrowed period is passed as a carried value: it is Core's, not the
 * model's); a suggestion that is not a valid `run` plan refuses the original plan with the bound's own reason.
 */
function askUnbounded(steps: readonly AgentPlanStep[], unbounded: Unbounded, ctx: AgentPlanValidationContext): AgentPlanValidation {
  const failed = refuse(unbounded.refusal);
  // CA P2: an ask only for a plan that breaks nothing but a bound. Every step is checked by the ordinary rules with the
  // bound itself lifted (the repeated entry's period, which the suggestion replaces; a reference's take, clamped to the
  // cap); the first other failure refuses the plan, so a write, an ungrounded value or a content-borne key never gets a
  // suggestion.
  const otherwise = otherwiseValid(steps, unbounded);
  // Codex P2: the other steps keep their own step-scoped period grounding, exactly as in the ordinary path.
  const temporal = otherwise.length > 1 ? stepTemporalTexts(otherwise, ctx) : undefined;
  for (const [index, step] of otherwise.entries()) {
    const number = index + 1;
    const checked = step.kind === 'summarize' ? checkSummary(step, number, otherwise) : checkRead(step, number, otherwise, ctx, temporal);
    if (!checked.ok) return checked;
  }
  let suggestion: AgentPlanStep[];
  let check = ctx;
  if (unbounded.bound === 'per-period') {
    const entryId = unbounded.entryId as string;
    const rangeArg = unbounded.rangeArg as string;
    const repeated = steps.flatMap((step, index) => (step.kind === 'read' && step.entryId === entryId ? [index + 1] : []));
    const first = steps[(repeated[0] as number) - 1] as ReadStep;
    const period = narrowedPeriod(repeated.map((number) => (steps[number - 1] as ReadStep).args[rangeArg]), ctx);
    const summarized = steps.some((step) => step.kind === 'summarize' && step.from.some((from) => repeated.includes(from)));
    suggestion = [
      { kind: 'read', entryId, args: { ...first.args, [rangeArg]: period } },
      ...(summarized ? [{ kind: 'summarize' as const, from: [1], schema: entryId === 'calendar.events' ? 'meeting-digest.v1' : 'digest.v1' }] : []),
    ];
    check = { ...ctx, previousArgs: { ...(ctx.previousArgs ?? {}), [rangeArg]: period } };
  } else {
    const clamped = clampRefs(unbounded.bound === 'reads' ? firstReads(steps, AGENT_PLAN_MAX_READS) : steps);
    if (clamped === undefined) return failed;
    suggestion = clamped;
  }
  if (unboundedOf(suggestion, check) !== undefined) return failed;
  // CA re-check W2: a suggestion over the query charge is shrunk to its first reads until it fits (ap-n085: the first
  // release and its 10 details), never dropped to a silent none.
  const fitted = fitToCharge(suggestion, suggestion.filter((step) => step.kind === 'read').length, check);
  if (fitted === undefined) return failed;
  return { ok: true, plan: { kind: 'ask', reason: 'unbounded', bound: unbounded.bound, suggestion: fitted } };
}

/**
 * The first `maxReads` (then fewer) reads of `steps`, with their summaries and references renumbered (`firstReads`), that
 * validate to a `run` plan within the query charge; `undefined` when none does. Each candidate is validated by this
 * validator, so the result is a plan Core could run.
 */
function fitToCharge(steps: readonly AgentPlanStep[], maxReads: number, ctx: AgentPlanValidationContext): readonly ValidatedAgentStep[] | undefined {
  for (let reads = maxReads; reads >= 1; reads -= 1) {
    const candidate = firstReads(steps, reads);
    if (!candidate.some((step) => step.kind === 'read')) continue;
    const validated = validateAgentPlan({ kind: 'steps', form: 'steps', steps: candidate, ambiguity: 'CLEAR', alternatives: [] }, ctx);
    if (validated.ok && validated.plan.kind === 'run') return validated.plan.steps;
  }
  return undefined;
}

/** The plan with only its bound lifted: the repeated entry's period removed (`per-period`), references clamped to the cap. */
function otherwiseValid(steps: readonly AgentPlanStep[], unbounded: Unbounded): AgentPlanStep[] {
  return steps.map((step) => {
    if (step.kind !== 'read') return step;
    let args = step.args;
    if (unbounded.bound === 'per-period' && step.entryId === unbounded.entryId && unbounded.rangeArg !== undefined) {
      const { [unbounded.rangeArg]: _period, ...rest } = args;
      args = rest;
    }
    const ref = step.ref !== undefined ? { ...step.ref, take: Math.min(step.ref.take, AGENT_PLAN_MAX_REF_VALUES) } : undefined;
    return { ...step, args, ...(ref !== undefined ? { ref } : {}) };
  });
}

/** `this-week` when every named period resolves inside this week, else `this-month` (an unresolvable one counts as outside). */
function narrowedPeriod(values: readonly (string | number | boolean | undefined)[], ctx: AgentPlanValidationContext): string {
  const week = resolveNlRange('this-week', ctx.now, ctx.timeZone);
  const inside =
    week !== undefined &&
    values.every((value) => {
      const range = typeof value === 'string' ? resolveNlRange(normalizeNlRangeSymbol(value), ctx.now, ctx.timeZone) : undefined;
      return range !== undefined && Date.parse(range.from) >= Date.parse(week.from) && Date.parse(range.to) <= Date.parse(week.to);
    });
  return inside ? 'this-week' : 'this-month';
}

/** The first `max` reads in order, with the summaries over them and the references among them renumbered. */
function firstReads(steps: readonly AgentPlanStep[], max: number): AgentPlanStep[] {
  const kept = new Map<number, number>();
  const out: AgentPlanStep[] = [];
  let reads = 0;
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'read') {
      if (reads >= max) continue;
      reads += 1;
      if (step.ref !== undefined && !kept.has(step.ref.step)) continue;
      out.push(step.ref !== undefined ? { ...step, ref: { ...step.ref, step: kept.get(step.ref.step) as number } } : step);
      kept.set(index + 1, out.length);
    } else if (step.from.every((from) => kept.has(from))) {
      out.push({ ...step, from: step.from.map((from) => kept.get(from) as number) });
    }
  }
  return out;
}

/** References clamped in step order to the per-reference and per-run caps; a reference left with none is dropped. */
function clampRefs(steps: readonly AgentPlanStep[]): AgentPlanStep[] | undefined {
  let left = AGENT_PLAN_MAX_RUN_REF_VALUES;
  const renumber = new Map<number, number>();
  const out: AgentPlanStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'read') {
      if (step.ref === undefined) {
        out.push(step);
      } else {
        const take = Math.min(step.ref.take, AGENT_PLAN_MAX_REF_VALUES, left);
        const source = renumber.get(step.ref.step);
        if (take < 1 || source === undefined) continue;
        left -= take;
        out.push({ ...step, ref: { ...step.ref, step: source, take } });
      }
      renumber.set(index + 1, out.length);
    } else {
      const from = step.from.filter((n) => renumber.has(n)).map((n) => renumber.get(n) as number);
      if (from.length > 0) out.push({ ...step, from });
    }
  }
  return out.some((step) => step.kind === 'read') ? out : undefined;
}

function refuse(reason: AgentPlanRefusal, step?: number, stepReason?: NlValidationFailureReason): Extract<AgentPlanValidation, { ok: false }> {
  return { ok: false, reason, ...(step !== undefined ? { step } : {}), ...(stepReason !== undefined ? { stepReason } : {}) };
}

function checkRead(
  step: Extract<AgentPlanStep, { kind: 'read' }>,
  number: number,
  steps: readonly AgentPlanStep[],
  ctx: AgentPlanValidationContext,
  temporal: StepTemporal | undefined,
): StepCheck {
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
  if (temporal?.refusal !== undefined && temporal.refusal.step === number) return refuse(temporal.refusal.reason, number);
  const result = validateSelection(
    { entryId: step.entryId, args: step.args },
    {
      offered: ctx.offered,
      // Multi-step plans: the owner's prose minus the period expressions other steps' ranges claim (step-scoped).
      groundingText: temporal?.texts.get(number) ?? ctx.groundingText,
      ...(ctx.previousArgs !== undefined ? { previousArgs: ctx.previousArgs } : {}),
      ...(ctx.previousEntryId !== undefined ? { previousEntryId: ctx.previousEntryId } : {}),
      now: ctx.now,
      timeZone: ctx.timeZone,
    },
  );
  if (!result.ok) return refuse('step-invalid', number, result.reason);
  if (steps.length > 1 && !clauseGrounded(result.value.entry, result.value.args, ctx)) return refuse('step-invalid', number, 'ungrounded');
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
    const source = steps[from - 1];
    if (from >= number || source?.kind !== 'read') return refuse('summary-source', number);
    // A1-E2 B2: no model over the brief; its section is the deterministic on-demand brief.
    if (source.entryId === 'brief.today') return refuse('summary-covers-brief', number);
  }
  return { ok: true, step: { kind: 'summarize', from: [...step.from], schema: step.schema as (typeof AGENT_PLAN_SUMMARY_SCHEMAS)[number] } };
}

/**
 * CA P3: a `clauseBound` enum value of a multi-step plan's read step is grounded only by its own words in a clause that
 * names the step's entry (the conjuncts of `periodExpressions`: "and", "그리고", a comma, a glued "-랑" / "-하고"). With no
 * clause naming the entry, the message-level grounding `validateSelection` already applied stands. A value carried from
 * the previous selection needs no words. Pure.
 */
function clauseGrounded(entry: NlCatalogEntry, args: NlArgs, ctx: AgentPlanValidationContext): boolean {
  const bound = entry.args.filter((spec) => spec.clauseBound === true && spec.kind === 'enum');
  if (bound.length === 0) return true;
  const clauses = entryClauses(ctx.groundingText, entry);
  if (clauses.length === 0) return true;
  return bound.every((spec) => {
    const value = args[spec.name];
    const words = typeof value === 'string' ? spec.valueGrounding?.[value] : undefined;
    if (words === undefined || value === ctx.previousArgs?.[spec.name]) return true;
    return clauses.some((clause) => words.some((word) => groundingWordIn(clause, normalizeForMatch(word))));
  });
}

/** The conjuncts of the owner's prose that name `entry` by one of its aliases or source names (normalized). */
function entryClauses(groundingText: string, entry: NlCatalogEntry): string[] {
  const names = [...entry.aliases, ...(entry.sourceNames ?? [])].map((alias) => normalizeForMatch(alias)).filter((name) => name.length > 0 && !name.includes(' '));
  const conjuncts = new Map<number, string[]>();
  for (const token of conjunctTokens(groundingText)) {
    if (token.boundary) continue;
    conjuncts.set(token.conjunct, [...(conjuncts.get(token.conjunct) ?? []), token.word]);
  }
  return [...conjuncts.values()].filter((words) => words.some((word) => names.some((name) => aliasStarts(word, name)))).map((words) => words.join(' '));
}

/** A reference field that would carry a date or time (dates come only from the planner's symbolic time, D2). */
const DATE_FIELD = /date|day|time|when|due|start|end|range|period|deadline|week|month|year/i;

/** An absolute date (`MM-DD`, `YYYY-MM-DD`, or a span of them) in a range value. */
const ABSOLUTE_DATE = /(?:(\d{4})-)?(\d{1,2})-(\d{1,2})/g;

/**
 * Dates only symbolic (ADR-0121 D2): every absolute date in a range value must be named by a DATE EXPRESSION in the
 * owner's own words, and a written year must appear too. Two numbers elsewhere in the text never ground a date ("10시
 * 20분" is no 10-20; CA review). A purely symbolic value (`this-week`, `fri`) has no absolute date and passes. Pure.
 *
 * Date expressions (the owner's own digits are always required):
 * - `M월 D일`, `M/D` or `M-D` (leading zeros optional; `YYYY-M-D` and `YYYY/M/D` included);
 * - an English month name or its abbreviation with the day (CA review of S2 P2): `October 25`, `Oct 25th`, `25 Oct`,
 *   `25th of October`;
 * - the END of a span `MM-DD..MM-DD` within one month may inherit the start's month (CA review of S2 P2): the start's
 *   date expression, a span connector, then the end day (`10월 1일부터 7일까지`, `10/1~7`, `10월 1-7일`, `Oct 1 to 7`).
 */
export function absoluteDatesGrounded(value: string, groundingText: string): boolean {
  const span = /^(?:\d{4}-)?(\d{1,2})-(\d{1,2})\.\.(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/.exec(value);
  const endInherited = span !== null && Number(span[1]) === Number(span[3]) && spanEndInherits(Number(span[1]), Number(span[2]), Number(span[4]), groundingText);
  let position = 0;
  for (const match of value.matchAll(ABSOLUTE_DATE)) {
    position += 1;
    const [, year, month, day] = match;
    if (month === undefined || day === undefined) return false;
    if (!dateExpressionIn(Number(month), Number(day), groundingText) && !(position <= 2 && endInherited)) return false;
    if (year !== undefined && !new RegExp(`(?<![0-9])${Number(year)}(?![0-9])`, 'u').test(groundingText)) return false;
  }
  return true;
}

/** English month names, January first (the full name or the usual abbreviation). */
const MONTH_NAMES: readonly string[] = ['jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?', 'july?', 'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'];
const ORDINAL = '(?:st|nd|rd|th)?';

/** The date expressions naming month `month`, day `day` (see `absoluteDatesGrounded`), as one regex source. */
function dateExpressionSource(month: number, day: number, korean: 'with-day-suffix' | 'span-start' = 'with-day-suffix'): string {
  const m = `(?<![0-9])0?${month}`;
  const d = `0?${day}(?![0-9])`;
  const name = `(?<![a-z])(?:${MONTH_NAMES[month - 1] ?? '(?!)'})\\.?(?![a-z])`;
  return [
    korean === 'span-start' ? `${m}\\s*월\\s*${d}(?:\\s*일)?` : `${m}\\s*월\\s*${d}\\s*일`,
    `${m}\\s*/\\s*${d}`,
    `${m}-${d}`,
    `${name}\\s*,?\\s*${d}${ORDINAL}(?![a-z])`,
    `(?<![0-9])0?${day}${ORDINAL}\\s+(?:of\\s+)?${name}`,
  ].join('|');
}

function dateExpressionIn(month: number, day: number, text: string): boolean {
  return new RegExp(dateExpressionSource(month, day), 'iu').test(text);
}

/** A span's end day inheriting the start's month: the start's date expression, a span connector, the end day. */
function spanEndInherits(month: number, startDay: number, endDay: number, text: string): boolean {
  const start = `(?:${dateExpressionSource(month, startDay, 'span-start')})`;
  const end = `0?${endDay}(?![0-9])`;
  // Another month right after the end day ("to 7 November", "7th of Nov", "7월") makes it that month's day, not this one.
  const otherMonth = `\\s*(?:of\\s+)?(?:${MONTH_NAMES.join('|')})\\.?(?![a-z])|\\s*월`;
  const symbol = '\\s*(?:~|-|–|—)\\s*';
  const word = '\\s+(?:to|through|thru|until|till)\\s+';
  // (1) The end day carries a glued day marker (7일, never "7 일정"; 7th) after any span connector, 부터 included.
  const marked = `${start}(?:\\s*(?:부터|에서)\\s*(?:~|-|–|—)?\\s*|${symbol}|${word})${end}(?:일(?!정)|st|nd|rd|th)(?!${otherMonth})`;
  // (2) A bare end day directly after a span marker (~, -, to, until, …; or 부터 … 까지), with no unit or month attached:
  // a time (시, 분, pm, am), a count (개, 건, 명, 번, items) or a date separator never makes it a day.
  const unit = '\\s*(?:[시분개건명번월:./]|pm\\b|am\\b|items?\\b)';
  const bare = `${start}(?:(?:${symbol}|${word})${end}(?!${unit}|${otherMonth}|[a-z])|\\s*부터\\s*${end}(?=\\s*까지))`;
  return new RegExp(`${marked}|${bare}`, 'iu').test(text);
}

/**
 * Step-scoped temporal grounding (Codex P2 on S2 P1). In a plan of several steps, one step's period must not constrain
 * another step's ("금요일 일정이랑 오늘 받은 메일": the calendar's Friday is no weekday of the mail's today). Structural only:
 *
 * 1. The owner's period expressions are the maximal runs of time words in the prose (`isNlTimeWord`).
 * 2. Each expression is bound to the source it modifies: in Korean the nearest catalog alias of a plan entry AFTER it (a
 *    modifier precedes its noun), else before it; otherwise the nearest alias after it INSIDE ITS CONJUNCT (split on
 *    "and", "그리고", a comma, a glued "-랑" / "-하고": "Friday calendar and today mail"), else the nearest alias before it
 *    ("calendar for friday"), else after it; no alias → unbound. Further binding edge cases are fail-closed residuals.
 * 3. A ranged step CLAIMS an expression when the expression names the step's period (a weekday placement, a closed period
 *    label, or a date resolving to the same instants) and is bound to the step's entry or unbound.
 * 4. Every ranged step must claim an expression (`range-unnamed`) unless its range is the previous selection's; two steps
 *    of the same entry with different ranges are ambiguous (`range-ambiguous`).
 * 5. A step is validated against the prose minus the expressions claimed by OTHER steps only. An unclaimed expression
 *    stays in every step's text, so it still constrains (fail closed). The literal-grounding rules of ADR-0120 D4 still
 *    run on that text. Single-step plans never come here.
 */
interface StepTemporal {
  readonly texts: ReadonlyMap<number, string>;
  readonly refusal?: { readonly reason: 'range-unnamed' | 'range-ambiguous'; readonly step: number };
}

interface PeriodExpression {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly boundEntry?: string;
}

interface RangedStep {
  readonly number: number;
  readonly entry: NlCatalogEntry;
  readonly value: string;
  readonly carried: boolean;
  readonly range?: NlResolvedRange;
}

function stepTemporalTexts(steps: readonly AgentPlanStep[], ctx: AgentPlanValidationContext): StepTemporal | undefined {
  const ranged: RangedStep[] = [];
  const entries: Array<{ readonly number: number; readonly entry: NlCatalogEntry }> = [];
  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'read' || !isNlWave1EntryId(step.entryId)) continue;
    const entry = ctx.offered.get(step.entryId);
    if (entry === undefined) continue;
    entries.push({ number: index + 1, entry });
    const spec = entry.args.find((candidate) => candidate.kind === 'range');
    const value = spec !== undefined ? step.args[spec.name] : undefined;
    if (spec === undefined || typeof value !== 'string') continue;
    const range = resolveNlRange(normalizeNlRangeSymbol(value), ctx.now, ctx.timeZone);
    ranged.push({ number: index + 1, entry, value, carried: value === ctx.previousArgs?.[spec.name], ...(range !== undefined ? { range } : {}) });
  }
  if (ranged.length === 0) return undefined;
  for (const [i, a] of ranged.entries()) {
    for (const b of ranged.slice(i + 1)) {
      if (a.entry.id === b.entry.id && a.value !== b.value) return { texts: new Map(), refusal: { reason: 'range-ambiguous', step: b.number } };
    }
  }
  const tokens = ctx.groundingText.split(/\s+/u).filter((token) => token.length > 0);
  const expressions = periodExpressions(tokens, entries.map((item) => item.entry), /[가-힣]/u.test(ctx.groundingText));
  const claims = new Map<number, Set<number>>();
  for (const step of ranged) {
    const claimed = new Set<number>();
    expressions.forEach((expression, index) => {
      if (expression.boundEntry !== undefined && expression.boundEntry !== step.entry.id) return;
      if (step.range !== undefined && expressionNames(expression.text, step.range, ctx)) claimed.add(index);
    });
    if (claimed.size === 0 && !step.carried) return { texts: new Map(), refusal: { reason: 'range-unnamed', step: step.number } };
    claims.set(step.number, claimed);
  }
  const texts = new Map<number, string>();
  for (const { number } of entries) {
    const own = claims.get(number) ?? new Set<number>();
    const removed: PeriodExpression[] = [];
    for (const [other, claimed] of claims) {
      if (other === number) continue;
      for (const index of claimed) if (!own.has(index)) removed.push(expressions[index] as PeriodExpression);
    }
    texts.set(number, tokens.filter((_token, position) => !removed.some((expression) => position >= expression.start && position < expression.end)).join(' '));
  }
  return { texts };
}

/** The maximal runs of time words, each bound to the plan entry whose alias it modifies (see `stepTemporalTexts`). */
function periodExpressions(tokens: readonly string[], entries: readonly NlCatalogEntry[], korean: boolean): PeriodExpression[] {
  const sourceAt = tokens.map((token) => {
    const word = normalizeForMatch(token);
    const hit = entries.find((entry) =>
      [...entry.aliases, ...(entry.sourceNames ?? [])].some((alias) => {
        const name = normalizeForMatch(alias);
        return name.length > 0 && !name.includes(' ') && aliasStarts(word, name);
      }),
    );
    return hit?.id;
  });
  // Conjuncts (Codex P2): "and", "그리고" and a comma or a glued "-랑" / "-하고" end one; an English period word binds to the
  // next source noun inside its own conjunct ("Friday calendar and today mail"), else to the preceding source.
  const conjunct = conjunctTokens(tokens.join(' ')).map((token) => token.conjunct);
  const out: PeriodExpression[] = [];
  let index = 0;
  while (index < tokens.length) {
    if (!isNlTimeWord(tokens[index] as string)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < tokens.length && isNlTimeWord(tokens[end] as string)) end += 1;
    const after = sourceAt.slice(end).find((id) => id !== undefined);
    const before = sourceAt.slice(0, index).reverse().find((id) => id !== undefined);
    const own = conjunct[index];
    const afterInConjunct = sourceAt.slice(end).find((id, offset) => id !== undefined && conjunct[end + offset] === own);
    const boundEntry = korean ? (after ?? before) : (afterInConjunct ?? before ?? after);
    out.push({ start: index, end, text: tokens.slice(index, end).join(' '), ...(boundEntry !== undefined ? { boundEntry } : {}) });
    index = end;
  }
  return out;
}

/** Whether a period expression names `range`: a weekday placement, a closed period label or a date, by the same clock. */
function expressionNames(text: string, range: NlResolvedRange, ctx: AgentPlanValidationContext): boolean {
  const same = (candidate: NlResolvedRange | undefined): boolean => candidate !== undefined && candidate.from === range.from && candidate.to === range.to;
  for (const mention of nlWeekdayMentions(text)) {
    if (nlWeekdayMentionRanges(mention, ctx.now, ctx.timeZone).some(same)) return true;
  }
  const compact = normalizeForMatch(text).replace(/\s+/gu, '');
  for (const [symbol, ko, en] of nlRangeSymbolWords()) {
    const named = [ko, en].some((label) => {
      const word = normalizeForMatch(label).replace(/\s+/gu, '');
      return word.length > 0 && compact.includes(word);
    });
    if (named && same(resolveNlRange(symbol, ctx.now, ctx.timeZone))) return true;
  }
  for (const match of text.matchAll(/(?<![0-9])(\d{1,2})\s*(?:월\s*|[/-])(\d{1,2})(?![0-9])/gu)) {
    const symbol = `${String(Number(match[1])).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
    if (same(resolveNlRange(symbol, ctx.now, ctx.timeZone))) return true;
  }
  return false;
}
