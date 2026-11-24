import { NL_SPAN_MAX_CHARS, NL_WHEN_MAX_CHARS, isNlSpanGrounded, normalizeNlSpan } from '../nl-routing/action-entries';
import { nlWriteClausePointsBack } from '../nl-routing/write-clause';
import { containsCredentialMaterial } from '../credential-guard';
import {
  AGENT_A7_DRAFT_SCHEMA,
  AGENT_A7_SOURCES,
  AGENT_A7_TARGETS,
  AGENT_A7_TARGET_ARGS,
  analyseCrossWriteLiterals,
  crossWriteNamedSources,
  crossWriteNouns,
  crossWriteTextOutsideSpan,
  isAgentA7Target,
  type AgentA7Kind,
  type AgentA7Operation,
  type AgentA7Target,
  type CrossWriteLiteral,
} from './cross-write';
import type { AgentPlan, AgentPlanStep } from './plan-schema';
import type { AgentPlanRefusal, AgentPlanValidation, AgentPlanValidationContext, ValidatedAgentStep } from './plan-validator';

/**
 * ADR-0121 amendment A7, slice A7-S1 (plan-form): rule 9 of the plan validator, the cross-source write plan. Static like every
 * rule of the validator: it reads the plan, the offered catalog, the owner's own non-quoted words and the closed deployment
 * context, never a read, a model or any state. A refusal names one closed reason, never a value.
 *
 * An A7 plan is exactly:
 * - form a: `[read, summarize(payload-draft.v1 over [1]), propose]`, or form b: `[summarize(payload-draft.v1, no sources),
 *   propose]` (the held receipt of the previous turn is the input; A7.4);
 * - ONE propose step, last, from the closed set (`jira.comment.propose`, `slack.post.propose`, `calendar.create.propose`)
 *   with destination args only. The closed arg set has no payload argument, so the planner can never write payload text.
 *
 * The destination is never taken from the planner's word: it is the literal the A7.4a rule marks in the owner's own words,
 * and the planner's role must equal the rule's role, otherwise the plan is refused (never corrected silently, A7.4a rule 5).
 * The destination must be on the allowlist; when the owner names only a kind, Core asks (a7-09: the project first only
 * when two or more are allowlisted, then the ticket; a channel from the allowlist); when two literals leave the roles
 * ambiguous, Core asks with the readings (A7.4a rule 4). Calendar: the title and the time are verbatim spans of the owner's
 * words (A7.3), and a missing one is the existing clarification.
 *
 * The validated plan is NOT runnable: `runActive` declines it `cross-write-off` and the shadow job only logs it, exactly as
 * the A4-S1 handoff. The pre-read destination check (one GET) is the async port of `cross-write.ts`.
 */

export const AGENT_A7_MAX_ITEMS = 10;

/** What the validated plan says about the destination: a grounded literal, a pick to ask for, or an ask. Never a value from content. */
export type AgentCrossWriteDestination =
  | { readonly state: 'named'; readonly kind: 'jira'; readonly issueKey: string; readonly project: string }
  | { readonly state: 'named'; readonly kind: 'slack'; readonly channel: string }
  /** a7-09: two or more projects are allowlisted and the owner named none: ask the project first. */
  | { readonly state: 'pick-project'; readonly kind: 'jira'; readonly projects: readonly string[] }
  /** a7-09: the project is named or the only one: list that project's tickets and the owner picks by number. */
  | { readonly state: 'pick-ticket'; readonly kind: 'jira'; readonly project: string }
  | { readonly state: 'pick-channel'; readonly kind: 'slack'; readonly channels: readonly string[] }
  /** The owner's words name no destination at all: ask where. */
  | { readonly state: 'missing'; readonly kind: AgentA7Kind }
  /** A7.4a rule 4: two eligible literals, none marked: ask with at most 2 readings (source and destination literal each). */
  | { readonly state: 'ask-readings'; readonly readings: readonly { readonly source: string; readonly destination: string }[] }
  /** A7.4a rule 4: one unmarked literal: ask the owner to say it again with the destination marked. Nothing is held. */
  | { readonly state: 'ask-restate' }
  /** The owner's primary calendar (A7.3). */
  | { readonly state: 'primary-calendar' };

export interface ValidatedCrossWritePlan {
  readonly kind: 'cross-write';
  readonly form: 'a' | 'b';
  readonly target: AgentA7Target;
  readonly operation: AgentA7Operation;
  /** The destination kind of the propose step. */
  readonly destinationKind: AgentA7Kind;
  /** Form a: the one validated source read. Form b: absent (the held receipt). */
  readonly source?: Extract<ValidatedAgentStep, { kind: 'read' }>;
  /** The static connector-call charge of the source read (form b: 0). The drafter and the card are later slices. */
  readonly connectorCalls: number;
  readonly destination: AgentCrossWriteDestination;
  /** Calendar only: the verbatim title and time spans, and which of them the owner did not give (the A6 clarification). */
  readonly calendar?: { readonly title?: string; readonly when?: string; readonly missing: readonly ('title' | 'when')[] };
}

export interface CrossWriteDeps {
  /** The validator's own per-read check (ADR-0120 D4, the vetoes), so a source read is judged exactly as any read step. */
  readonly checkRead: (step: Extract<AgentPlanStep, { kind: 'read' }>) => { readonly ok: true; readonly step: ValidatedAgentStep } | Extract<AgentPlanValidation, { ok: false }>;
  readonly charge: (steps: readonly ValidatedAgentStep[]) => number;
}

type Result = { readonly ok: true; readonly plan: ValidatedCrossWritePlan } | Extract<AgentPlanValidation, { ok: false }>;

function refuse(reason: AgentPlanRefusal, step?: number): Extract<AgentPlanValidation, { ok: false }> {
  return { ok: false, reason, ...(step !== undefined ? { step } : {}) };
}

/** Whether a plan is an A7 plan at all (a propose step, or the `payload-draft.v1` summary): such a plan takes rule 9 and no other. */
export function isCrossWritePlan(plan: AgentPlan): boolean {
  return plan.kind === 'steps' && (plan.propose !== undefined || plan.steps.some((step) => step.kind === 'summarize' && step.schema === AGENT_A7_DRAFT_SCHEMA));
}

export function validateCrossWritePlan(plan: Extract<AgentPlan, { kind: 'steps' }>, ctx: AgentPlanValidationContext, deps: CrossWriteDeps): Result {
  const cw = ctx.crossWrite;
  if (cw === undefined) return refuse('cross-write-off');
  // Shape: the steps form, CLEAR, no handoff, no related; [read?, summarize(payload-draft.v1), propose].
  if (plan.form !== 'steps' || plan.ambiguity !== 'CLEAR' || plan.handoff !== undefined || plan.related !== undefined) return refuse('cross-write-invalid');
  // The steps are what precede the propose step (`plan.propose`, held beside them by the parser): [read?, summarize].
  const steps = plan.steps;
  const propose = plan.propose;
  const draft = steps[steps.length - 1];
  const stepNo = steps.length + 1;
  if (propose === undefined || draft?.kind !== 'summarize' || draft.schema !== AGENT_A7_DRAFT_SCHEMA) return refuse('cross-write-invalid', stepNo);
  const form: 'a' | 'b' | undefined = steps.length === 2 ? 'a' : steps.length === 1 ? 'b' : undefined;
  if (form === undefined) return refuse('cross-write-invalid');
  if (form === 'a' ? draft.from.length !== 1 || draft.from[0] !== 1 : draft.from.length !== 0) return refuse('cross-write-invalid', steps.length);
  if (!isAgentA7Target(propose.target)) return refuse('cross-write-target', stepNo);
  const spec = AGENT_A7_TARGETS[propose.target];
  if (!cw.active[spec.kind]) return refuse('cross-write-off', stepNo);
  if (!cw.writers[spec.kind]) return refuse('cross-write-writer', stepNo);
  // The propose step has destination args only: a closed name set, no payload argument.
  const argNames = AGENT_A7_TARGET_ARGS[propose.target];
  if (!Object.keys(propose.args).every((name) => argNames.includes(name))) return refuse('cross-write-invalid', stepNo);

  let source: Extract<ValidatedAgentStep, { kind: 'read' }> | undefined;
  let connectorCalls = 0;
  if (form === 'a') {
    const read = steps[0];
    if (read?.kind !== 'read' || read.ref !== undefined) return refuse('cross-write-invalid', 1);
    if (!(AGENT_A7_SOURCES as readonly string[]).includes(read.entryId) || !cw.sources.includes(read.entryId)) return refuse('cross-write-source', 1);
    const checked = deps.checkRead(read);
    if (!checked.ok) return checked;
    if (checked.step.kind !== 'read') return refuse('cross-write-invalid', 1);
    source = checked.step;
    connectorCalls = deps.charge([checked.step]);
  } else {
    const receipt = cw.receipt;
    if (
      receipt === undefined ||
      !receipt.fresh ||
      receipt.items < 1 ||
      receipt.items > AGENT_A7_MAX_ITEMS ||
      receipt.hostOnly ||
      receipt.handoffBuilt ||
      !(AGENT_A7_SOURCES as readonly string[]).includes(receipt.sourceEntryId) ||
      !cw.sources.includes(receipt.sourceEntryId)
    ) {
      return refuse('cross-write-receipt');
    }
  }

  const nouns = crossWriteNouns(ctx.offered);
  const base = { kind: 'cross-write' as const, form, target: propose.target, operation: spec.operation, destinationKind: spec.kind, ...(source !== undefined ? { source } : {}), connectorCalls };

  // Calendar: the primary calendar is the destination; the title and the time are the owner's own spans (A7.3).
  if (spec.kind === 'calendar') {
    const analysis = analyseCrossWriteLiterals(ctx.groundingText, cw, nouns, undefined);
    if (analysis.marked.length > 0 || analysis.kindMarked.jira || analysis.kindMarked.slack) return refuse('cross-write-role', stepNo);
    const spans = calendarSpans(propose.args, ctx.groundingText);
    if (spans === undefined) return refuse('cross-write-span', stepNo);
    if (form === 'b') return finishB(base, { state: 'primary-calendar' }, ctx, nouns, analysis, undefined, spans);
    return { ok: true, plan: { ...base, destination: { state: 'primary-calendar' }, calendar: spans } };
  }

  const analysis = analyseCrossWriteLiterals(ctx.groundingText, cw, nouns, spec.kind);
  // More than one write in one request is never covered (A7.3).
  if (analysis.writeUnits > 1) return refuse('cross-write-writes', stepNo);
  const eligible = analysis.literals.filter((literal) => literal.allowed);
  const plannerKey = spec.kind === 'jira' ? stringArg(propose.args.issueKey)?.toUpperCase() : undefined;
  const plannerChannel = spec.kind === 'slack' ? stringArg(propose.args.channel)?.replace(/^#/u, '').toLowerCase() : undefined;
  const plannerLiteral = plannerKey ?? plannerChannel;
  const plannerProject = spec.kind === 'jira' ? stringArg(propose.args.project) : undefined;
  // A literal the planner wrote that is not in the owner's own words at all is never grounded.
  if (plannerLiteral !== undefined && !analysis.literals.some((literal) => literal.value === plannerLiteral)) return refuse('cross-write-ungrounded', stepNo);

  let destination: AgentCrossWriteDestination;
  let named: CrossWriteLiteral | undefined;
  if (analysis.marked.length === 1) {
    named = analysis.marked[0] as CrossWriteLiteral;
    if (!named.allowed) return refuse('cross-write-not-allowed', stepNo);
    // Rule 5: the planner's role equals the rule's role; a project beside a named key is not a role of this plan.
    if (plannerLiteral !== named.value || plannerProject !== undefined) return refuse('cross-write-role', stepNo);
    destination = named.kind === 'jira' ? { state: 'named', kind: 'jira', issueKey: named.value, project: named.project as string } : { state: 'named', kind: 'slack', channel: named.value };
  } else if (analysis.marked.length > 1 || eligible.length > 0) {
    // A7.4a rule 4: no literal marked, or several. Two literals: the readings (at most 2 per pair); one: restate. Nothing is read.
    const readings =
      eligible.length === 2
        ? [
            { source: (eligible[0] as CrossWriteLiteral).value, destination: (eligible[1] as CrossWriteLiteral).value, kind: (eligible[1] as CrossWriteLiteral).kind },
            { source: (eligible[1] as CrossWriteLiteral).value, destination: (eligible[0] as CrossWriteLiteral).value, kind: (eligible[0] as CrossWriteLiteral).kind },
          ]
            .filter((reading) => reading.kind === spec.kind)
            .map(({ source: from, destination: to }) => ({ source: from, destination: to }))
        : [];
    destination = readings.length > 0 ? { state: 'ask-readings', readings } : { state: 'ask-restate' };
  } else {
    // No eligible literal: a literal off the allowlist that is marked as the destination was refused above; here the kind is
    // named with no instance (a7-09), or nothing is named at all.
    if (spec.kind === 'jira') {
      const project = analysis.namedProject;
      if (plannerProject !== undefined && plannerProject !== project) return refuse('cross-write-ungrounded', stepNo);
      if (!analysis.kindMarked.jira) destination = { state: 'missing', kind: 'jira' };
      else if (project !== undefined) destination = { state: 'pick-ticket', kind: 'jira', project };
      else if (cw.jiraProjects.length === 1) destination = { state: 'pick-ticket', kind: 'jira', project: (cw.jiraProjects[0] as string).toUpperCase() };
      else if (cw.jiraProjects.length > 1) destination = { state: 'pick-project', kind: 'jira', projects: cw.jiraProjects.map((key) => key.toUpperCase()) };
      else return refuse('cross-write-not-allowed', stepNo);
    } else {
      if (plannerChannel !== undefined) return refuse('cross-write-ungrounded', stepNo);
      if (!analysis.kindMarked.slack) destination = { state: 'missing', kind: 'slack' };
      else if (cw.slackChannels.length > 0) destination = { state: 'pick-channel', kind: 'slack', channels: cw.slackChannels.map((name) => name.toLowerCase()) };
      else return refuse('cross-write-not-allowed', stepNo);
    }
  }
  if (form === 'b') return finishB(base, destination, ctx, nouns, analysis, named);
  return { ok: true, plan: { ...base, destination } };
}

/**
 * Form b (A7.4): the turn names no new source. The source-name check runs on the owner's words OUTSIDE the destination span
 * (the destination literal plus the catalog names that touch it), so "해당 내용 요약해서 지라 BE-123에 달아줘" names no source.
 * A remaining name of the held entry's own source still binds; any other source name is form (a) over that source, so this
 * plan (which has no read step) is refused.
 */
function finishB(
  base: Omit<ValidatedCrossWritePlan, 'destination' | 'calendar'>,
  destination: AgentCrossWriteDestination,
  ctx: AgentPlanValidationContext,
  _nouns: ReturnType<typeof crossWriteNouns>,
  analysis: ReturnType<typeof analyseCrossWriteLiterals>,
  named: CrossWriteLiteral | undefined,
  calendar?: ValidatedCrossWritePlan['calendar'],
): Result {
  const held = ctx.offered.get(ctx.crossWrite?.receipt?.sourceEntryId ?? '');
  const heldNames = new Set((held?.sourceNames ?? []).map((name) => name.toLowerCase()));
  const outside = crossWriteTextOutsideSpan(analysis, named);
  // A named entry is a NEW source unless it shares a source name with the held entry (jira.issues and jira.release are both Jira).
  const sources = crossWriteNamedSources(outside, ctx.offered).filter((id) => !(ctx.offered.get(id)?.sourceNames ?? []).some((name) => heldNames.has(name.toLowerCase())));
  if (sources.length > 0) return refuse('cross-write-new-source');
  return { ok: true, plan: { ...base, destination, ...(calendar !== undefined ? { calendar } : {}) } };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The calendar title and time: verbatim spans of the owner's own non-quoted words (the A6 span rule: NFC, whitespace
 * collapsed, one pair of enclosing quotes removed, never repaired), bounded, not a deictic point-back, credential-guarded.
 * `undefined` for an ungrounded span; a missing one is listed for the existing clarification.
 */
function calendarSpans(args: Readonly<Record<string, unknown>>, groundingText: string): { title?: string; when?: string; missing: ('title' | 'when')[] } | undefined {
  const out: { title?: string; when?: string; missing: ('title' | 'when')[] } = { missing: [] };
  for (const [name, max] of [['title', NL_SPAN_MAX_CHARS], ['when', NL_WHEN_MAX_CHARS]] as const) {
    const raw = args[name];
    if (raw === undefined) {
      out.missing.push(name);
      continue;
    }
    if (typeof raw !== 'string') return undefined;
    const span = normalizeNlSpan(raw);
    if (span.length === 0 || Array.from(span).length > max || !isNlSpanGrounded(span, groundingText) || containsCredentialMaterial(span)) return undefined;
    if (name === 'title' && nlWriteClausePointsBack('', [span])) return undefined;
    out[name] = span;
  }
  return out;
}
