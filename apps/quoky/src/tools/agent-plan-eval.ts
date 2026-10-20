/**
 * ADR-0121 D11 plan exactness (stage S2 P2): the model-in-the-loop scoring of the planner prompt (`agent-plan.vN`) over
 * `golden/agent-plan.v1.json` (multi-step positives and negatives) plus every `nl-intent.v1.json` case as one-step gold
 * (Q11). No LLM judge: Core's own parse (`parseAgentPlanOutput`) and validator (`validateAgentPlan`) decide what the
 * planner's answer means, and the scorer compares step graphs. Pure except for the injected provider: the plan, the
 * digest, the corpus self-check and the scoring are deterministic and tested offline; only the CLI's `run` calls a
 * provider, and only after the Strict digest check.
 *
 * Scoring (Q10, an exact plan is the same step graph):
 * - a positive is **exact** when the answer validates to a `run` plan whose steps equal the gold steps in order: the same
 *   entries, the same canonical args (Core's validated, canonical args against the canonical gold), the same refs
 *   (`{step, field, take}`) and the same summaries (the same covered steps and schema). A clarification, a refusal, a
 *   malformed answer, a timeout, `none` or another executable plan is not exact;
 * - a negative is **wrong** when the answer validates to an executable (`run`) plan, whatever it is. `none`, a refusal,
 *   a clarification or a malformed answer is not wrong;
 * - before validation the message-level vetoes of the selection path apply (ADR-0120 A7: a past statement; a reason
 *   statement or an unconsumed quoted request on any read step): the runtime answers such a message as chat, so the plan
 *   counts as `none`.
 *
 * Gate, in every run: >= 95% exact over all positives, 0 wrong on negatives, <= 1% of the calls over the bound, and no
 * call refused by the hard call cap.
 *
 * Content-free report: ids, families, closed entry ids, closed validator reasons, closed diff kinds and latencies only;
 * never an owner text, a model answer or an argument value.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_PLAN_PROMPT_VERSION,
  Capability,
  NL_CATALOG_ENTRY_IDS,
  NL_SELECTION_TIMEOUT_MS,
  NL_WAVE1_ENTRIES,
  buildAgentPlanPrompt,
  isNlWave1EntryId,
  nlIsPastStatement,
  nlReadNotRequest,
  parseAgentPlanOutput,
  prepareSelectionInput,
  validateAgentPlan,
  type AgentPlan,
  type AgentPlanValidationContext,
  type AiProvider,
  type NlArgs,
  type NlCatalogEntry,
  type ValidatedAgentStep,
} from '@quoky/core';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import { EvalCallTimeout, withTimeout } from './nl-intent-eval';

export const AGENT_PLAN_EVAL_GATE = { exact: 0.95, wrongOnNegatives: 0, overBoundRate: 0.01 } as const;
/** The per-call bound: the runtime's selection bound (the shadow job runs inside it, ADR-0121 S2 P1). */
export const AGENT_PLAN_EVAL_DEFAULT_TIMEOUT_MS = NL_SELECTION_TIMEOUT_MS;

const GOLDEN_DIR = resolve(__dirname, '../../../../packages/core/src/application/golden');
export const AGENT_PLAN_CORPUS_PATH = resolve(GOLDEN_DIR, 'agent-plan.v1.json');
export const AGENT_PLAN_ONE_STEP_CORPUS_PATH = resolve(GOLDEN_DIR, 'nl-intent.v1.json');

/** The closed case families of the corpus (the schema doc lists what each one holds). */
export const AGENT_PLAN_POSITIVE_FAMILIES = [
  'owner-example',
  'compound',
  'read-summary',
  'same-source-ref',
  'period-per-step',
  'en-prenominal',
  'multi-read',
  'same-entry',
] as const;
export const AGENT_PLAN_NEGATIVE_FAMILIES = [
  'write-read',
  'content-borne',
  'pasted',
  'quoted-request',
  'cross-source-join',
  'unbounded',
  'capability-chit-chat',
  'venting',
  'help-style',
  'a6-in-plan',
  'past-or-negated',
] as const;
/** The family of the referenced `nl-intent.v1.json` cases (positives and negatives alike). */
export const AGENT_PLAN_ONE_STEP_FAMILY = 'one-step';
export const AGENT_PLAN_CASE_STATUSES = ['approved', 'pending-owner-approval'] as const;
export type AgentPlanCaseStatus = (typeof AGENT_PLAN_CASE_STATUSES)[number];

/** A gold step as written in the corpus (the planner's own steps form). */
export type AgentPlanGoldStep =
  | { readonly entryId: string; readonly args?: NlArgs; readonly ref?: { readonly step: number; readonly field: string; readonly take: number } }
  | { readonly summarize: readonly number[]; readonly schema: string };

export interface AgentPlanGoldPlan {
  readonly steps: readonly AgentPlanGoldStep[];
  readonly ambiguity: 'CLEAR';
}

export interface AgentPlanCase {
  readonly id: string;
  readonly batch: string;
  readonly status: AgentPlanCaseStatus;
  readonly family: string;
  readonly lang: 'ko' | 'en' | 'mixed';
  readonly text: string;
  readonly attachments?: number;
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  readonly expect: 'none' | AgentPlanGoldPlan;
  /** Negatives: the tempting plan; the validator must refuse it (with `trapRefusal` when given). */
  readonly trap?: AgentPlanGoldPlan;
  readonly trapRefusal?: string;
  readonly note?: string;
}

export interface AgentPlanCorpus {
  readonly version: number;
  readonly description: string;
  readonly fixture: { readonly now: string; readonly timeZone: string; readonly direct: boolean; readonly offered: string };
  readonly oneStep: { readonly corpus: string; readonly status: 'approved'; readonly count: number; readonly ids: readonly string[] };
  readonly cases: readonly AgentPlanCase[];
}

/** One `nl-intent.v1.json` case, as far as the one-step gold needs it. */
export interface OneStepCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
}

/** One scored case: a new corpus case or a referenced one-step case. */
export interface AgentPlanEvalCase {
  readonly id: string;
  readonly family: string;
  readonly status: AgentPlanCaseStatus;
  readonly text: string;
  readonly attachments: number;
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  /** `none` for a negative, else the gold plan. */
  readonly gold: 'none' | AgentPlanGoldPlan;
}

export function loadAgentPlanCorpus(
  path: string = AGENT_PLAN_CORPUS_PATH,
  oneStepPath: string = AGENT_PLAN_ONE_STEP_CORPUS_PATH,
): { corpus: AgentPlanCorpus; sha256: string; oneStep: readonly OneStepCase[]; oneStepSha256: string } {
  const text = readFileSync(path, 'utf8');
  const oneStepText = readFileSync(oneStepPath, 'utf8');
  return {
    corpus: JSON.parse(text) as AgentPlanCorpus,
    sha256: sha256(text),
    oneStep: (JSON.parse(oneStepText) as { cases: OneStepCase[] }).cases,
    oneStepSha256: sha256(oneStepText),
  };
}

/** Every case the eval scores: the referenced one-step cases (in the corpus' id order), then the new cases. */
export function agentPlanEvalCases(corpus: AgentPlanCorpus, oneStep: readonly OneStepCase[]): AgentPlanEvalCase[] {
  const byId = new Map(oneStep.map((golden) => [golden.id, golden] as const));
  const out: AgentPlanEvalCase[] = [];
  for (const id of corpus.oneStep.ids) {
    const golden = byId.get(id);
    if (golden === undefined) throw new Error(`one-step case ${id} is not in ${corpus.oneStep.corpus}`);
    out.push({
      id,
      family: AGENT_PLAN_ONE_STEP_FAMILY,
      status: corpus.oneStep.status,
      text: golden.text,
      attachments: 0,
      ...(golden.prior !== undefined ? { prior: golden.prior } : {}),
      gold: golden.expect === 'none' ? 'none' : { steps: [{ entryId: golden.expect.entryId, args: golden.expect.args }], ambiguity: 'CLEAR' },
    });
  }
  for (const golden of corpus.cases) out.push(evalCaseOf(golden));
  return out;
}

function evalCaseOf(golden: AgentPlanCase): AgentPlanEvalCase {
  return {
    id: golden.id,
    family: golden.family,
    status: golden.status,
    text: golden.text,
    attachments: golden.attachments ?? 0,
    ...(golden.prior !== undefined ? { prior: golden.prior } : {}),
    gold: golden.expect,
  };
}

const READ_ENTRIES: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const OFFERED: ReadonlyMap<string, NlCatalogEntry> = new Map(READ_ENTRIES.map((entry) => [entry.id, entry] as const));

/** The validation context of one case under the corpus fixture (the owner's DM, every READ entry offered). */
export function caseContext(golden: Pick<AgentPlanEvalCase, 'text' | 'attachments' | 'prior'>, fixture: AgentPlanCorpus['fixture']): { ctx: AgentPlanValidationContext; text: string } | { skip: string } {
  const prepared = prepareSelectionInput(golden.text, golden.attachments);
  if ('skip' in prepared) return { skip: prepared.skip };
  return {
    text: prepared.text,
    ctx: {
      offered: OFFERED,
      groundingText: prepared.groundingText,
      ...(golden.prior !== undefined ? { previousArgs: golden.prior.args } : {}),
      now: fixture.now as AgentPlanValidationContext['now'],
      timeZone: fixture.timeZone,
      direct: fixture.direct,
    },
  };
}

// ── step graphs (Q10) ───────────────────────────────────────────────────────────────────────────────────────────

/** A canonical, comparable step graph: entries in order, sorted args, refs and summaries. */
export type StepGraph = ReadonlyArray<
  | { readonly kind: 'read'; readonly entryId: string; readonly args: string; readonly ref?: string }
  | { readonly kind: 'summarize'; readonly from: string; readonly schema: string }
>;

function sortedArgs(args: NlArgs | undefined): string {
  return JSON.stringify(Object.entries(args ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The graph of a gold plan as written (the corpus self-check proves each gold equals its own validated form). */
export function goldGraph(gold: AgentPlanGoldPlan): StepGraph {
  return gold.steps.map((step) =>
    'summarize' in step
      ? { kind: 'summarize' as const, from: JSON.stringify([...step.summarize].sort((a, b) => a - b)), schema: step.schema }
      : {
          kind: 'read' as const,
          entryId: step.entryId,
          args: sortedArgs(step.args),
          ...(step.ref !== undefined ? { ref: JSON.stringify([step.ref.step, step.ref.field, step.ref.take]) } : {}),
        },
  );
}

/** The graph of a validated plan (Core's canonical args). */
export function validatedGraph(steps: readonly ValidatedAgentStep[]): StepGraph {
  return steps.map((step) =>
    step.kind === 'summarize'
      ? { kind: 'summarize' as const, from: JSON.stringify([...step.from].sort((a, b) => a - b)), schema: step.schema }
      : {
          kind: 'read' as const,
          entryId: step.entry.id,
          args: sortedArgs(step.args),
          ...(step.ref !== undefined ? { ref: JSON.stringify([step.ref.step, step.ref.field, step.ref.take]) } : {}),
        },
  );
}

/** The closed kind of the first difference between two graphs (`undefined` when they are the same graph). */
export type GraphDiff = 'step-count' | 'step-kind' | 'entry' | 'args' | 'ref' | 'summary';

export function graphDiff(got: StepGraph, want: StepGraph): { kind: GraphDiff; step?: number } | undefined {
  if (got.length !== want.length) return { kind: 'step-count' };
  for (const [index, a] of got.entries()) {
    const b = want[index];
    const step = index + 1;
    if (b === undefined || a.kind !== b.kind) return { kind: 'step-kind', step };
    if (a.kind === 'read' && b.kind === 'read') {
      if (a.entryId !== b.entryId) return { kind: 'entry', step };
      if (a.args !== b.args) return { kind: 'args', step };
      if (a.ref !== b.ref) return { kind: 'ref', step };
    } else if (a.kind === 'summarize' && b.kind === 'summarize') {
      if (a.from !== b.from || a.schema !== b.schema) return { kind: 'summary', step };
    }
  }
  return undefined;
}

// ── scoring one answer ──────────────────────────────────────────────────────────────────────────────────────────

export type AgentPlanOutcome =
  /** positive: the same step graph. */
  | 'exact'
  /** positive: another executable plan. */
  | 'miss'
  /** positive answered `none` (or vetoed to it). */
  | 'miss-none'
  /** negative: `none` (correct). */
  | 'none'
  /** negative: an executable plan. */
  | 'wrong'
  | 'clarify'
  | 'refused'
  | 'malformed'
  | 'timeout'
  | 'error'
  /** the hard call cap refused the call (the run fails). */
  | 'capped'
  | 'skipped';

export interface AgentPlanScore {
  readonly outcome: AgentPlanOutcome;
  /** Closed entry ids of the answer (`summarize:<schema>`; a model-made id is `unknown`). */
  readonly gotEntries?: readonly string[];
  /** Closed validator reason (refusals) or `veto:<reason>`. */
  readonly reason?: string;
  readonly failedStep?: number;
  readonly diff?: GraphDiff;
  readonly diffStep?: number;
}

const SUMMARY_SCHEMA = /^[a-z][a-z0-9-]*\.v[1-9][0-9]?$/;

function closedEntries(plan: AgentPlan): string[] {
  if (plan.kind === 'none') return ['none'];
  return plan.steps.map((step) => (step.kind === 'summarize' ? (SUMMARY_SCHEMA.test(step.schema) ? `summarize:${step.schema}` : 'summarize:unknown') : isNlWave1EntryId(step.entryId) ? step.entryId : 'unknown'));
}

/** Score one raw planner answer for one case. Pure. */
export function scoreAgentPlanOutput(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): AgentPlanScore {
  const negative = golden.gold === 'none';
  const prepared = caseContext(golden, fixture);
  if ('skip' in prepared) return { outcome: 'skipped', reason: `skip:${prepared.skip}` };
  const plan = parseAgentPlanOutput(raw);
  if (plan === null) return { outcome: 'malformed' };
  const gotEntries = closedEntries(plan);
  const asNone = (reason?: string): AgentPlanScore => ({ outcome: negative ? 'none' : 'miss-none', gotEntries, ...(reason !== undefined ? { reason } : {}) });
  if (plan.kind === 'none') return asNone();
  // ADR-0120 A7: the selection path answers a past statement, a reason statement or an unconsumed quoted request as chat.
  if (nlIsPastStatement(prepared.ctx.groundingText)) return asNone('veto:past-statement');
  for (const step of plan.steps) {
    if (step.kind !== 'read') continue;
    const veto = nlReadNotRequest(prepared.ctx.groundingText, step.args);
    if (veto !== undefined) return asNone(`veto:${veto}`);
  }
  const validation = validateAgentPlan(plan, prepared.ctx);
  if (!validation.ok) {
    return { outcome: 'refused', gotEntries, reason: validation.reason, ...(validation.step !== undefined ? { failedStep: validation.step } : {}) };
  }
  if (validation.plan.kind === 'none') return asNone();
  if (validation.plan.kind === 'clarify') return { outcome: 'clarify', gotEntries };
  if (golden.gold === 'none') return { outcome: 'wrong', gotEntries };
  const diff = graphDiff(validatedGraph(validation.plan.steps), goldGraph(golden.gold));
  if (diff === undefined) return { outcome: 'exact', gotEntries };
  return { outcome: 'miss', gotEntries, diff: diff.kind, ...(diff.step !== undefined ? { diffStep: diff.step } : {}) };
}

// ── the corpus self-check ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The corpus self-check (schema and meaning): every problem as a content-free line. Every positive must parse, validate
 * to a `run` plan of at least two steps under the fixture, and equal its own validated graph (the gold is canonical);
 * every negative is `none`, and its trap (when given) is refused by the validator (with `trapRefusal` when given). The
 * one-step reference lists exactly the ids of `nl-intent.v1.json`.
 */
export function validateAgentPlanCorpus(corpus: AgentPlanCorpus, oneStep: readonly OneStepCase[]): string[] {
  const problems: string[] = [];
  if (corpus.version !== 1) problems.push('version must be 1');
  if (typeof corpus.fixture?.now !== 'string' || Number.isNaN(Date.parse(corpus.fixture.now)) || typeof corpus.fixture.timeZone !== 'string' || corpus.fixture.direct !== true) {
    problems.push('fixture must hold an ISO now, a time zone and direct: true');
  }
  const oneStepIds = oneStep.map((golden) => golden.id);
  if (corpus.oneStep?.corpus !== 'nl-intent.v1.json') problems.push('oneStep.corpus must be nl-intent.v1.json');
  if (corpus.oneStep?.status !== 'approved') problems.push('oneStep.status must be approved');
  if (corpus.oneStep?.count !== oneStepIds.length || JSON.stringify(corpus.oneStep?.ids) !== JSON.stringify(oneStepIds)) {
    problems.push(`oneStep.ids must list every ${corpus.oneStep?.corpus} id in order (${oneStepIds.length})`);
  }
  const seen = new Set<string>(oneStepIds);
  const families = new Set<string>([...AGENT_PLAN_POSITIVE_FAMILIES, ...AGENT_PLAN_NEGATIVE_FAMILIES]);
  for (const golden of corpus.cases) {
    const at = golden.id;
    if (!/^ap-[pn]\d{3}$/.test(golden.id)) problems.push(`${at}: id must be ap-pNNN or ap-nNNN`);
    if (seen.has(golden.id)) problems.push(`${at}: duplicate id`);
    seen.add(golden.id);
    if (!/^AP-\d+$/.test(golden.batch ?? '')) problems.push(`${at}: batch must be AP-<n>`);
    if (!(AGENT_PLAN_CASE_STATUSES as readonly string[]).includes(golden.status)) problems.push(`${at}: unknown status`);
    if (!families.has(golden.family)) problems.push(`${at}: unknown family`);
    if (golden.lang !== 'ko' && golden.lang !== 'en' && golden.lang !== 'mixed') problems.push(`${at}: lang must be ko, en or mixed`);
    if (typeof golden.text !== 'string' || golden.text.trim().length === 0) problems.push(`${at}: empty text`);
    if (golden.attachments !== undefined && (!Number.isInteger(golden.attachments) || golden.attachments < 1)) problems.push(`${at}: attachments must be a positive integer`);
    const positive = golden.expect !== 'none';
    if (positive !== golden.id.startsWith('ap-p')) problems.push(`${at}: ap-p ids are positives, ap-n ids negatives`);
    if (positive !== (AGENT_PLAN_POSITIVE_FAMILIES as readonly string[]).includes(golden.family)) problems.push(`${at}: family does not match the expectation`);
    const prepared = caseContext(evalCaseOf(golden), corpus.fixture);
    if (golden.expect !== 'none') {
      if (golden.trap !== undefined || golden.trapRefusal !== undefined) problems.push(`${at}: a positive has no trap`);
      if ('skip' in prepared) {
        problems.push(`${at}: the input is skipped (${prepared.skip})`);
        continue;
      }
      const plan = parseAgentPlanOutput(JSON.stringify(golden.expect));
      if (plan === null || plan.kind !== 'steps' || plan.form !== 'steps') {
        problems.push(`${at}: the gold does not parse as a steps-form plan`);
        continue;
      }
      if (plan.steps.length < 2) problems.push(`${at}: a multi-step positive needs at least two steps`);
      const validation = validateAgentPlan(plan, prepared.ctx);
      if (!validation.ok) {
        problems.push(`${at}: the gold is refused (${validation.reason}${validation.step !== undefined ? ` at step ${validation.step}` : ''}${validation.stepReason !== undefined ? `: ${validation.stepReason}` : ''})`);
        continue;
      }
      if (validation.plan.kind !== 'run') {
        problems.push(`${at}: the gold validates to ${validation.plan.kind}, not run`);
        continue;
      }
      const diff = graphDiff(validatedGraph(validation.plan.steps), goldGraph(golden.expect));
      if (diff !== undefined) problems.push(`${at}: the gold is not canonical (${diff.kind}${diff.step !== undefined ? ` at step ${diff.step}` : ''})`);
      if (nlIsPastStatement(prepared.ctx.groundingText)) problems.push(`${at}: the text is a past statement (vetoed to none)`);
      for (const step of plan.steps) {
        if (step.kind === 'read' && nlReadNotRequest(prepared.ctx.groundingText, step.args) !== undefined) problems.push(`${at}: a read step is vetoed as not a request`);
      }
      continue;
    }
    if (golden.trapRefusal !== undefined && golden.trap === undefined) problems.push(`${at}: trapRefusal without a trap`);
    if (golden.trap === undefined || 'skip' in prepared) continue;
    const trap = parseAgentPlanOutput(JSON.stringify(golden.trap));
    if (trap === null) {
      problems.push(`${at}: the trap does not parse`);
      continue;
    }
    const refused = validateAgentPlan(trap, prepared.ctx);
    if (refused.ok && refused.plan.kind === 'run') problems.push(`${at}: the trap validates to an executable plan`);
    else if (!refused.ok && golden.trapRefusal !== undefined && refused.reason !== golden.trapRefusal) problems.push(`${at}: the trap is refused as ${refused.reason}, not ${golden.trapRefusal}`);
  }
  return problems;
}

// ── the plan and its digest ─────────────────────────────────────────────────────────────────────────────────────

export interface AgentPlanEvalOptions {
  readonly model: string;
  readonly runs: number;
  readonly concurrency: number;
  readonly timeoutMs?: number;
  /** Also score the cases still pending the owner's approval (changes the case list and so the digest). */
  readonly includePending: boolean;
  readonly gitHead: string;
}

export interface AgentPlanEvalPlan {
  readonly kind: 'agent-plan-eval';
  readonly promptVersion: string;
  /** sha256 of the planner instruction text (every READ entry offered, an empty owner message). */
  readonly promptSha256: string;
  /** sha256 of `agent-plan.v1.json`. */
  readonly corpusSha256: string;
  /** sha256 of `nl-intent.v1.json` (the one-step gold, Q11). */
  readonly oneStepCorpusSha256: string;
  readonly gitHead: string;
  readonly model: string;
  readonly runs: number;
  readonly concurrency: number;
  /** The per-call bound (the runtime's selection bound); a call over it is a timeout and counts as over the bound. */
  readonly callTimeoutMs: number;
  readonly includePending: boolean;
  readonly fixture: AgentPlanCorpus['fixture'];
  readonly caseIds: readonly string[];
  /** The hard call cap: one planner call per case per run (a skipped input makes none). */
  readonly maxCallsPerRun: number;
  readonly maxCalls: number;
  readonly gate: typeof AGENT_PLAN_EVAL_GATE;
}

export function agentPlanPromptSha256(): string {
  return sha256(buildAgentPlanPrompt({ entries: READ_ENTRIES, text: '' }));
}

export function buildAgentPlanEvalPlan(
  cases: readonly AgentPlanEvalCase[],
  hashes: { readonly corpusSha256: string; readonly oneStepCorpusSha256: string },
  fixture: AgentPlanCorpus['fixture'],
  options: AgentPlanEvalOptions,
): AgentPlanEvalPlan {
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) throw new Error('runs must be 1..5');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(options.model)) throw new Error('invalid model');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || parseNlIntentTimeoutMs(String(options.timeoutMs)) === undefined)) {
    throw new Error('timeoutMs must be an integer 2000..8000');
  }
  const selected = cases.filter((golden) => golden.status === 'approved' || options.includePending);
  if (selected.length === 0) throw new Error('no case selected');
  return {
    kind: 'agent-plan-eval',
    promptVersion: AGENT_PLAN_PROMPT_VERSION,
    promptSha256: agentPlanPromptSha256(),
    corpusSha256: hashes.corpusSha256,
    oneStepCorpusSha256: hashes.oneStepCorpusSha256,
    gitHead: options.gitHead,
    model: options.model,
    runs: options.runs,
    concurrency: options.concurrency,
    callTimeoutMs: options.timeoutMs ?? AGENT_PLAN_EVAL_DEFAULT_TIMEOUT_MS,
    includePending: options.includePending,
    fixture,
    caseIds: selected.map((golden) => golden.id),
    maxCallsPerRun: selected.length,
    maxCalls: selected.length * options.runs,
    gate: AGENT_PLAN_EVAL_GATE,
  };
}

export function computeAgentPlanEvalDigest(plan: AgentPlanEvalPlan): string {
  return sha256(JSON.stringify(plan));
}

// ── running ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentPlanEvalRecord extends AgentPlanScore {
  readonly run: number;
  readonly id: string;
  readonly family: string;
  readonly expected: 'plan' | 'none';
  /** The gold's read entries (closed ids), for the per-entry report. */
  readonly goldEntries: readonly string[];
  readonly latencyMs: number;
  /** Closed error class name (never a message). */
  readonly error?: string;
}

export class AgentPlanCallCapReached extends Error {
  constructor() {
    super('agent-plan eval: the hard call cap was reached');
    this.name = 'AgentPlanCallCapReached';
  }
}

/** The hard call cap at the provider boundary: once `limit` calls were made, every further call throws. */
export function cappedProvider(provider: AiProvider, limit: number): { provider: AiProvider; calls: () => number; refused: () => number } {
  let calls = 0;
  let refused = 0;
  const wrapped: AiProvider = {
    ...provider,
    id: provider.id,
    capabilities: provider.capabilities,
    isAvailable: () => provider.isAvailable(),
    execute: async (request) => {
      if (calls >= limit) {
        refused += 1;
        throw new AgentPlanCallCapReached();
      }
      calls += 1;
      return provider.execute(request);
    },
  };
  return { provider: wrapped, calls: () => calls, refused: () => refused };
}

function goldEntriesOf(golden: AgentPlanEvalCase): string[] {
  return golden.gold === 'none' ? [] : golden.gold.steps.map((step) => ('summarize' in step ? 'summarize' : step.entryId));
}

/** Run the plan against one provider (Strict: the CLI checked the approved digest). The provider is capped here too. */
export async function runAgentPlanEvaluation(input: {
  readonly cases: readonly AgentPlanEvalCase[];
  readonly plan: AgentPlanEvalPlan;
  readonly provider: AiProvider;
  readonly elapsed?: () => number;
  readonly onRecord?: (record: AgentPlanEvalRecord) => void;
}): Promise<AgentPlanEvalRecord[]> {
  const byId = new Map(input.cases.map((golden) => [golden.id, golden] as const));
  const clock = input.elapsed ?? Date.now;
  const capped = cappedProvider(input.provider, input.plan.maxCalls);
  const records: AgentPlanEvalRecord[] = [];
  for (let run = 1; run <= input.plan.runs; run += 1) {
    const queue = input.plan.caseIds.map((id) => byId.get(id)).filter((golden): golden is AgentPlanEvalCase => golden !== undefined);
    const worker = async (): Promise<void> => {
      for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) {
        const base = { run, id: golden.id, family: golden.family, expected: golden.gold === 'none' ? ('none' as const) : ('plan' as const), goldEntries: goldEntriesOf(golden) };
        const prepared = caseContext(golden, input.plan.fixture);
        let record: AgentPlanEvalRecord;
        if ('skip' in prepared) {
          record = { ...base, outcome: 'skipped', reason: `skip:${prepared.skip}`, latencyMs: 0 };
        } else {
          const prompt = buildAgentPlanPrompt({
            entries: READ_ENTRIES,
            text: prepared.text,
            ...(golden.prior !== undefined && isNlWave1EntryId(golden.prior.entryId) ? { previous: { entryId: golden.prior.entryId, args: golden.prior.args } } : {}),
          });
          const started = clock();
          try {
            const result = await withTimeout(
              capped.provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs: input.plan.callTimeoutMs }),
              input.plan.callTimeoutMs,
            );
            record = { ...base, ...scoreAgentPlanOutput(golden, result.text, input.plan.fixture), latencyMs: clock() - started };
          } catch (error) {
            const latencyMs = clock() - started;
            if (error instanceof AgentPlanCallCapReached) record = { ...base, outcome: 'capped', latencyMs: 0 };
            else if (error instanceof EvalCallTimeout || (error as { kind?: unknown } | null)?.kind === 'TIMEOUT') record = { ...base, outcome: 'timeout', latencyMs };
            else record = { ...base, outcome: 'error', latencyMs, error: error instanceof Error ? error.name : 'unknown' };
          }
        }
        records.push(record);
        input.onRecord?.(record);
      }
    };
    await Promise.all(Array.from({ length: input.plan.concurrency }, () => worker()));
  }
  return records;
}

// ── summary and gate ────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentPlanEvalSlot {
  readonly total: number;
  readonly exact: number;
  readonly rate: number;
}

export interface AgentPlanEvalSummary {
  readonly cases: number;
  readonly positives: number;
  readonly exact: number;
  readonly exactRate: number;
  readonly negatives: number;
  readonly wrongOnNegatives: number;
  /** Positives per family (exact rate) and negatives per family (wrong count). */
  readonly perFamily: Readonly<Record<string, { readonly positives: number; readonly exact: number; readonly rate: number; readonly negatives: number; readonly wrong: number }>>;
  /** Positives per gold entry (a plan counts once for each distinct entry it holds; `summarize` for summary steps). */
  readonly perEntry: Readonly<Record<string, AgentPlanEvalSlot>>;
  readonly outcomes: Readonly<Record<string, number>>;
  /** Calls made (skipped and capped cases make none). */
  readonly calls: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly max: number; readonly boundMs: number; readonly overBound: number };
  readonly overBoundRate: number;
  readonly capped: number;
  readonly gatePassed: boolean;
}

export function summarizeAgentPlanRun(records: readonly AgentPlanEvalRecord[], boundMs: number): AgentPlanEvalSummary {
  const positives = records.filter((record) => record.expected === 'plan');
  const negatives = records.filter((record) => record.expected === 'none');
  const exact = positives.filter((record) => record.outcome === 'exact').length;
  const wrongOnNegatives = negatives.filter((record) => record.outcome === 'wrong').length;
  const perFamily: Record<string, { positives: number; exact: number; rate: number; negatives: number; wrong: number }> = {};
  const perEntry: Record<string, { total: number; exact: number; rate: number }> = {};
  const outcomes: Record<string, number> = {};
  for (const record of records) {
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    const family = (perFamily[record.family] ??= { positives: 0, exact: 0, rate: 0, negatives: 0, wrong: 0 });
    if (record.expected === 'plan') {
      family.positives += 1;
      if (record.outcome === 'exact') family.exact += 1;
      for (const entry of new Set(record.goldEntries)) {
        const slot = (perEntry[entry] ??= { total: 0, exact: 0, rate: 0 });
        slot.total += 1;
        if (record.outcome === 'exact') slot.exact += 1;
      }
    } else {
      family.negatives += 1;
      if (record.outcome === 'wrong') family.wrong += 1;
    }
  }
  for (const family of Object.values(perFamily)) family.rate = family.positives === 0 ? 1 : family.exact / family.positives;
  for (const slot of Object.values(perEntry)) slot.rate = slot.total === 0 ? 1 : slot.exact / slot.total;
  const called = records.filter((record) => record.outcome !== 'skipped' && record.outcome !== 'capped');
  const latencies = called.map((record) => record.latencyMs).sort((a, b) => a - b);
  const pct = (p: number): number => (latencies.length === 0 ? 0 : (latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))] as number));
  const overBound = called.filter((record) => record.outcome === 'timeout' || record.latencyMs > boundMs).length;
  const overBoundRate = called.length === 0 ? 0 : overBound / called.length;
  const exactRate = positives.length === 0 ? 1 : exact / positives.length;
  const capped = records.filter((record) => record.outcome === 'capped').length;
  return {
    cases: records.length,
    positives: positives.length,
    exact,
    exactRate,
    negatives: negatives.length,
    wrongOnNegatives,
    perFamily,
    perEntry,
    outcomes,
    calls: called.length,
    latency: { p50: pct(50), p95: pct(95), max: latencies.at(-1) ?? 0, boundMs, overBound },
    overBoundRate,
    capped,
    gatePassed:
      exactRate >= AGENT_PLAN_EVAL_GATE.exact &&
      wrongOnNegatives <= AGENT_PLAN_EVAL_GATE.wrongOnNegatives &&
      overBoundRate <= AGENT_PLAN_EVAL_GATE.overBoundRate &&
      capped === 0,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
