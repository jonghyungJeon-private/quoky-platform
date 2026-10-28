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
 * - an **ask** case (the owner's review of 2026-10-21, decision (h): an unbounded request) is a negative for `wrong`, and
 *   is `asked` when the answer validates to the `unbounded` ask with the gold bound and the gold suggestion (Core derives
 *   the suggestion deterministically from the planner's steps), `ask-other` for another ask. An ask on a `none` gold is
 *   `wrong` (CA P2: a suggestion there is a plan the owner never asked for). The per-run gate holds the ask group at
 *   >= 95% `asked` whenever the run scores ask cases (only approved ones without `--include-pending`);
 * - the message-level vetoes of the selection path (ADR-0120 A7: a past statement; a reason statement or an unconsumed
 *   quoted request on any read step) are validator rules (`veto-*` refusals), so the eval and the runtime share them.
 * - Q10 compares an ORDERED step sequence: the same plan with its reads in another order is a miss (`step-kind` /
 *   `entry`). Stricter than a graph-isomorphism match, it never hides an error.
 * - owner decision (a), CA finding 5 (S2 P3 part 2): a gold may name `related` (the step the owner relates the other
 *   reads to); an exact plan needs the same validated `related` (absent on both, or the same step);
 * - ADR-0121 A1-E1 / A1-E4 (decision (e), stage S2 P3): Core's deterministic help split runs before planning, exactly as
 *   at run time (`splitHelpClause`): the planner sees only the rest of the owner's words, and a case whose gold names a
 *   help section (`help`, a `NL_HELP_TOPICS` topic) is exact only when the split gives that topic AND the rest plan is
 *   exact; a split the gold does not name (an extra help section) is a miss (`help`). A split-shape positive may have a
 *   one-step rest plan (the help section is the second section).
 *
 * Gate, in every run and per group (CA review of S2 P2): >= 95% exact over the multi-step positives AND >= 95% exact over
 * the one-step positives (the D12 read-gate level), 0 wrong on negatives other than help captures and at most ceil(1% of
 * the negatives) help.topic-only plans on negatives (owner decision of 2026-10-26, as the D12 read gates), <= 1% of the calls over the bound, and no call
 * refused by the hard call cap. Both groups must be present. A run with `--include-pending` is non-gating: it reports
 * the same numbers and never a gate verdict.
 *
 * Content-free report: ids, families, closed entry ids, closed validator reasons, closed diff kinds and latencies only;
 * never an owner text, a model answer or an argument value.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AGENT_PLAN_PROMPT_VERSION,
  AGENT_PLAN_SUMMARY_SCHEMAS,
  AGENT_UNBOUNDED_KINDS,
  Capability,
  NL_CATALOG_ENTRY_IDS,
  NL_SELECTION_TIMEOUT_MS,
  NL_WAVE1_ENTRIES,
  AGENT_READ_WRITE_PROBE_PROMPT_VERSION,
  agentReadWriteProbeClauses,
  agentReadWriteProbePrompt,
  agentReadWriteProbeResult,
  buildAgentPlanPrompt,
  conjunctTokens,
  nlHelpSourceScope,
  nlEntryHelpTopicsOf,
  CALENDAR_HELP_LINES,
  MAIL_DRIVE_HELP_LINES,
  WORK_CHAT_LOOKUP_TURN_HELP_LINES,
  isNlActionEntryId,
  isNlCatalogEntryId,
  NL_ACTION_ENTRIES,
  validateSelection,
  splitHelpClause,
  isNlWave1EntryId,
  parseAgentPlanOutput,
  prepareSelectionInput,
  validateAgentPlan,
  type AgentHelpSplit,
  type AgentPlan,
  type AgentPlanValidationContext,
  type AgentUnboundedKind,
  type AiProvider,
  type NlArgs,
  type NlCatalogEntry,
  type ValidatedAgentStep,
} from '@quoky/core';
import { sameJiraReleaseOutcome } from './jira-world-snapshot';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import { EvalCallTimeout, helpCaptureAllowance, withTimeout } from './nl-intent-eval';

/** `runs` (CA W2, review of 0bde31cc): the pooled multi-step verdict is given for exactly this many runs, never another count. */
export const AGENT_PLAN_EVAL_GATE = { multiStepExact: 0.95, oneStepExact: 0.95, askAsked: 0.95, wrongOnNegatives: 0, overBoundRate: 0.01, runs: 3 } as const;
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
  // ADR-0121 A1-E4: a help or brief request mixed with other reads (the help split, the brief as one step).
  'help-brief-split',
  // Owner decisions of 2026-10-26 (the agent-plan gate classification): one-step golds of the plan corpus.
  // A question whether Quoky handles a phrasing is help.topic (the read prompt's rule 3).
  'capability-help',
  // Owner decision of 2026-10-26 (amends decision (f) for an explicit position over a list read in the same message): the
  // list read, a position reference to its Nth item and a summary over it (agent-plan.v9 rule 9).
  'item-summary-ref',
] as const;
/** The positive families whose gold is one step: scored in the one-step group with the referenced one-step cases. */
export const AGENT_PLAN_ONE_STEP_POSITIVE_FAMILIES: readonly string[] = ['capability-help'];

/**
 * Owner decision of 2026-10-26 (capability-help golds): each source entry's help topic, by the same structural mapping the
 * runtime's help-scope Quoky option uses (`nlEntryHelpTopicsOf`: the one topic the owning handler's contributed help lines
 * answer). The handlers' catalogs and help lines as the production composition registers them: with Gmail and Drive both
 * configured, `withMergedMailDriveHelp` gives the mail handler the one merged mail·drive line (it answers two topics, so
 * neither entry has one) and the Drive handler none. Pinned against `ConversationRuntime.entryHelpTopics()` by the agent
 * app test. No topic is written here.
 */
export const AGENT_PLAN_ENTRY_HELP_TOPICS: Readonly<Record<string, string>> = Object.freeze(
  nlEntryHelpTopicsOf([
    { catalog: (['jira.issues', 'jira.release', 'github.items', 'slack.search', 'confluence.search'] as const).map((id) => NL_WAVE1_ENTRIES[id]), helpLines: WORK_CHAT_LOOKUP_TURN_HELP_LINES },
    { catalog: [NL_WAVE1_ENTRIES['calendar.events']], helpLines: CALENDAR_HELP_LINES },
    { catalog: [NL_WAVE1_ENTRIES['mail.list']], helpLines: MAIL_DRIVE_HELP_LINES },
    { catalog: [NL_WAVE1_ENTRIES['drive.files']], helpLines: [] },
  ]),
);

/**
 * The help topics of the sources the owner's sentence names (owner decision of 2026-10-26): the names by
 * `nlHelpSourceScope` (the runtime's own source match), each name to the entries whose `sourceNames` hold it, each entry
 * to its topic ({@link AGENT_PLAN_ENTRY_HELP_TOPICS}). Empty when no source is named.
 */
export function namedSourceHelpTopics(groundingText: string): ReadonlySet<string> {
  const scope = nlHelpSourceScope({ entryId: 'help.topic', args: {} }, groundingText);
  if (scope === undefined) return new Set();
  const names = (scope.sources ?? [scope.source]).map((name) => name.normalize('NFC').toLowerCase());
  const topics = new Set<string>();
  for (const [id, topic] of Object.entries(AGENT_PLAN_ENTRY_HELP_TOPICS)) {
    const entry = (NL_WAVE1_ENTRIES as Readonly<Record<string, NlCatalogEntry>>)[id];
    if (entry?.sourceNames?.some((name) => names.includes(name.normalize('NFC').toLowerCase())) === true) topics.add(topic);
  }
  return topics;
}
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
  // Review of 0bde31cc (CA W1): a position named only in a clause with a write word is no item summary (`ref-position`).
  'position-write',
] as const;
/** The family of the referenced `nl-intent.v1.json` cases (positives and negatives alike). */
export const AGENT_PLAN_ONE_STEP_FAMILY = 'one-step';
export const AGENT_PLAN_CASE_STATUSES = ['approved', 'pending-owner-approval'] as const;
export type AgentPlanCaseStatus = (typeof AGENT_PLAN_CASE_STATUSES)[number];

/** Decision (h): the expectation of an unbounded request: Core asks with a bounded suggestion (the planner's steps form). */
export interface AgentPlanAskExpect {
  readonly outcome: 'ask';
  readonly reason: 'unbounded';
  readonly bound: AgentUnboundedKind;
  readonly suggestion: AgentPlanGoldPlan;
}

export function isAgentPlanAskExpect(value: unknown): value is AgentPlanAskExpect {
  return typeof value === 'object' && value !== null && (value as { outcome?: unknown }).outcome === 'ask';
}

/** A gold step as written in the corpus (the planner's own steps form). */
export type AgentPlanGoldStep =
  | { readonly entryId: string; readonly args?: NlArgs; readonly ref?: { readonly step: number; readonly field: string; readonly take: number; readonly at?: number } }
  | { readonly summarize: readonly number[]; readonly schema: string };

export interface AgentPlanGoldPlan {
  readonly steps: readonly AgentPlanGoldStep[];
  readonly ambiguity: 'CLEAR';
  /** Owner decision (a), CA finding 5: the step the owner relates the other reads to (scored with the steps). */
  readonly related?: number;
}

export interface AgentPlanCase {
  readonly id: string;
  readonly batch: string;
  /** The id the case had before an owner relabel moved it across the positive / negative prefix (decisions of 2026-10-26). */
  readonly formerId?: string;
  readonly status: AgentPlanCaseStatus;
  readonly family: string;
  readonly lang: 'ko' | 'en' | 'mixed';
  readonly text: string;
  readonly attachments?: number;
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  readonly expect: 'none' | AgentPlanGoldPlan | AgentPlanAskExpect;
  /**
   * A clarification gold (owner decision A of 2026-10-22, as `nl-intent.v1.json`; ap-n115 by the owner's decision of
   * 2026-10-26): a negative whose correct answer is a question between the listed entries and none. A CLEAR plan of one
   * listed entry is a miss, never a wrong plan or a help capture; Core's own question is the hit (`asked`).
   */
  readonly clarify?: AgentPlanClarifyGold;
  /**
   * Negatives: the tempting plan; the validator must refuse it (with `trapRefusal` when given). Ask cases: the unbounded
   * plan the planner would write; the validator must turn it into the expected ask.
   */
  readonly trap?: AgentPlanGoldPlan;
  readonly trapRefusal?: string;
  /** A1-E4: the help section Core's split must give (a `NL_HELP_TOPICS` topic); the expectation is the rest plan. */
  readonly help?: string;
  /**
   * The ratified ADR-0121 S2 note "a read and a write in one owner turn" (owner decision Q3, 2026-10-23): the turn outcome
   * Core gives this negative AFTER the planner's `none` (the planner gold is unchanged: it sees READ entries only). Data
   * for the P3 part 3 runtime and its tests; the planner eval does not score it. The self-check proves its shape.
   */
  readonly readWrite?: AgentPlanReadWriteExpect;
  readonly note?: string;
}

/** The closed outcomes of the read + write path (S2 note of 2026-10-23). */
export const AGENT_PLAN_READ_WRITE_OUTCOMES = ['read-and-write', 'read-and-note', 'read-and-clarify', 'unchanged'] as const;
/** Why a write clause is not run (`read-and-note`) or the path does not apply (`unchanged`). */
export const AGENT_PLAN_READ_WRITE_WHY = ['list-ref', 'deictic', 'one-conjunct', 'no-offered-entry'] as const;

export interface AgentPlanReadWriteExpect {
  readonly outcome: (typeof AGENT_PLAN_READ_WRITE_OUTCOMES)[number];
  /** The write conjunct, as the owner wrote it (one conjunct of `conjunctTokens(…, { verbConnective: true })`). */
  readonly writeClause?: string;
  /** The S2 read plan of the other conjuncts (canonical). */
  readonly readPlan?: AgentPlanGoldPlan;
  /** `read-and-write`: the A6 selection, valid with the write clause alone as its grounding text (canonical args). */
  readonly write?: { readonly entryId: string; readonly args: NlArgs };
  readonly why?: (typeof AGENT_PLAN_READ_WRITE_WHY)[number];
}

export interface AgentPlanCorpus {
  readonly version: number;
  readonly description: string;
  readonly fixture: { readonly now: string; readonly timeZone: string; readonly direct: boolean; readonly offered: string };
  readonly oneStep: { readonly corpus: string; readonly status: 'approved'; readonly count: number; readonly ids: readonly string[] };
  readonly cases: readonly AgentPlanCase[];
}

/** A clarification gold: the entries the correct question is between (and none). */
export interface AgentPlanClarifyGold {
  readonly between: readonly string[];
  readonly batch?: string;
}

/** One `nl-intent.v1.json` case, as far as the one-step gold needs it. */
export interface OneStepCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  readonly clarify?: AgentPlanClarifyGold;
}

/** One scored case: a new corpus case or a referenced one-step case. */
export interface AgentPlanEvalCase {
  readonly id: string;
  readonly family: string;
  readonly status: AgentPlanCaseStatus;
  readonly text: string;
  readonly attachments: number;
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  /** `none` for a negative, the expected ask for an unbounded request, else the gold plan. */
  readonly gold: 'none' | AgentPlanGoldPlan | AgentPlanAskExpect;
  /** A1-E4: the expected help section (split off before planning), when the gold has one. */
  readonly help?: string;
  /** A clarification gold (negatives only). */
  readonly clarify?: AgentPlanClarifyGold;
  /** The read + write turn outcome (the ratified note), when the case has one. */
  readonly readWrite?: AgentPlanReadWriteExpect;
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
      ...(golden.clarify !== undefined ? { clarify: golden.clarify } : {}),
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
    ...(golden.help !== undefined ? { help: golden.help } : {}),
    ...(golden.clarify !== undefined ? { clarify: golden.clarify } : {}),
    ...(golden.readWrite !== undefined ? { readWrite: golden.readWrite } : {}),
  };
}

const READ_ENTRIES: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const OFFERED: ReadonlyMap<string, NlCatalogEntry> = new Map(READ_ENTRIES.map((entry) => [entry.id, entry] as const));

/**
 * The validation context of one case under the corpus fixture (the owner's DM, every READ entry offered), after Core's
 * help split (A1-E1): with a split, the planner text and the grounding text are the rest of the owner's words.
 */
export function caseContext(
  golden: Pick<AgentPlanEvalCase, 'text' | 'attachments' | 'prior'>,
  fixture: AgentPlanCorpus['fixture'],
): { ctx: AgentPlanValidationContext; text: string; split?: AgentHelpSplit } | { skip: string } {
  const prepared = prepareSelectionInput(golden.text, golden.attachments);
  if ('skip' in prepared) return { skip: prepared.skip };
  const split = splitHelpClause(prepared, READ_ENTRIES);
  return {
    text: split?.rest ?? prepared.text,
    ...(split !== undefined ? { split } : {}),
    ctx: {
      offered: OFFERED,
      groundingText: split?.rest ?? prepared.groundingText,
      ...(golden.prior !== undefined ? { previousArgs: golden.prior.args, ...(isNlCatalogEntryId(golden.prior.entryId) ? { previousEntryId: golden.prior.entryId } : {}) } : {}),
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

/**
 * The names of the args whose values differ (gate on ed45e3f1: an args miss is classified without the raw answer). Only
 * the entry's declared arg names are reported (closed values); any other name is `unknown`. Never a value.
 */
function differingArgNames(entryId: string, got: string, want: string): readonly string[] {
  const parse = (graphArgs: string): Map<string, string> => new Map((JSON.parse(graphArgs) as Array<[string, unknown]>).map(([name, value]) => [name, JSON.stringify(value)]));
  const a = parse(got);
  const b = parse(want);
  const declared = new Set((isNlWave1EntryId(entryId) ? NL_WAVE1_ENTRIES[entryId].args : []).map((spec) => spec.name));
  const names = [...new Set([...a.keys(), ...b.keys()])].filter((name) => a.get(name) !== b.get(name)).map((name) => (declared.has(name) ? name : 'unknown'));
  return [...new Set(names)].sort();
}

/** A reference as one comparable string (a position reference adds its `at`). */
function refKey(ref: { readonly step: number; readonly field: string; readonly take: number; readonly at?: number }): string {
  return JSON.stringify([ref.step, ref.field, ref.take, ...(ref.at !== undefined ? [ref.at] : [])]);
}

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
          ...(step.ref !== undefined ? { ref: refKey(step.ref) } : {}),
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
          ...(step.ref !== undefined ? { ref: refKey(step.ref) } : {}),
        },
  );
}

/** Each summary of a graph as `<schema><-<covered read entry ids>` (closed values). */
export function graphSummaries(graph: StepGraph): string[] {
  return graph.flatMap((step) => {
    if (step.kind !== 'summarize') return [];
    const covered = (JSON.parse(step.from) as number[]).map((number) => {
      const source = graph[number - 1];
      return source?.kind === 'read' && isNlCatalogEntryId(source.entryId) ? source.entryId : 'unknown';
    });
    return [`${step.schema}<-${covered.join(',')}`];
  });
}

/**
 * Owner decision of 2026-10-26: for two graphs with the same reads, whether their summaries differ only in order (the
 * same schema over the same reads, by read position) or in scope; `undefined` when the reads differ or the summaries match.
 */
export function summaryDiffOf(got: StepGraph, want: StepGraph): 'order' | 'scope' | undefined {
  const reads = (graph: StepGraph) => graph.filter((step) => step.kind === 'read');
  if (JSON.stringify(reads(got)) !== JSON.stringify(reads(want))) return undefined;
  const byRead = (graph: StepGraph): string[] => {
    const position = new Map<number, number>();
    let count = 0;
    for (const [index, step] of graph.entries()) if (step.kind === 'read') position.set(index + 1, ++count);
    return graph
      .flatMap((step) => (step.kind === 'summarize' ? [`${step.schema}:${(JSON.parse(step.from) as number[]).map((number) => position.get(number) ?? 0).join(',')}`] : []))
      .sort();
  };
  if (JSON.stringify(got) === JSON.stringify(want)) return undefined;
  return JSON.stringify(byRead(got)) === JSON.stringify(byRead(want)) ? 'order' : 'scope';
}

/** The closed kind of the first difference between two graphs (`undefined` when they are the same graph). */
export type GraphDiff = 'step-count' | 'step-kind' | 'entry' | 'args' | 'ref' | 'summary' | 'help' | 'related';

export function graphDiff(got: StepGraph, want: StepGraph): { kind: GraphDiff; step?: number; args?: readonly string[] } | undefined {
  if (got.length !== want.length) return { kind: 'step-count' };
  for (const [index, a] of got.entries()) {
    const b = want[index];
    const step = index + 1;
    if (b === undefined || a.kind !== b.kind) return { kind: 'step-kind', step };
    if (a.kind === 'read' && b.kind === 'read') {
      if (a.entryId !== b.entryId) return { kind: 'entry', step };
      if (a.args !== b.args) return { kind: 'args', step, args: differingArgNames(a.entryId, a.args, b.args) };
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
  /** positive answered `none`. */
  | 'miss-none'
  /** ask case: the expected unbounded ask with the gold bound and suggestion. */
  | 'asked'
  /** ask case: another ask (another bound or suggestion); a positive or a negative answered with an ask. */
  | 'ask-other'
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
  /**
   * The read + write trigger amendment of 2026-10-26: the plan left an uncovered clause and the probe's one A6 selection
   * picked a write lying in it (`read-write`: Core's read + write path answers the turn) or a referenced one
   * (`read-note`: the read sections and the decision (f) note). Never `wrong` on a negative; never `exact` on a positive.
   */
  | 'read-write'
  | 'read-note'
  /** CA W2: a requested write missing a detail: the existing A6 clarification. */
  | 'read-clarify'
  | 'skipped';

export interface AgentPlanScore {
  readonly outcome: AgentPlanOutcome;
  /** Closed entry ids of the answer (`summarize:<schema>`; a model-made id is `unknown`). */
  readonly gotEntries?: readonly string[];
  /** Closed validator reason (refusals, `veto-*` included) or `skip:<reason>`. */
  readonly reason?: string;
  readonly failedStep?: number;
  readonly diff?: GraphDiff;
  readonly diffStep?: number;
  /** An `args` diff: the declared names of the args that differ (never a value). */
  readonly diffArgs?: readonly string[];
  /**
   * Owner decision of 2026-10-26 (gate report): each summary step of Core's final plan as `<schema><-<covered read entry
   * ids>` (closed values), and, for a miss whose reads are the gold's, whether the summaries differ only in `order` or in
   * `scope` (coverage or schema).
   */
  readonly gotSummaries?: readonly string[];
  readonly summaryDiff?: 'order' | 'scope';
}

/**
 * The answer's steps as closed values only (Codex P2): a catalog READ entry id or `unknown`, and `summarize:<schema>` only
 * for a schema of the closed set (`AGENT_PLAN_SUMMARY_SCHEMAS`, as the shadow logger does), else `summarize:unknown`. A
 * model-written id or schema never reaches the report.
 */
export function closedEntries(plan: AgentPlan): string[] {
  if (plan.kind === 'none') return ['none'];
  return plan.steps.map((step) =>
    step.kind === 'summarize'
      ? `summarize:${(AGENT_PLAN_SUMMARY_SCHEMAS as readonly string[]).includes(step.schema) ? step.schema : 'unknown'}`
      : isNlWave1EntryId(step.entryId)
        ? step.entryId
        : 'unknown',
  );
}

/** Error class names the report may carry; any other (a provider-made name) is `other`. */
const CLOSED_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AiProviderError', 'ProviderProbeIndeterminateError']);

export function closedErrorName(error: unknown): string {
  return error instanceof Error && CLOSED_ERROR_NAMES.has(error.name) ? error.name : 'other';
}

/** Score one raw planner answer for one case. Pure. */
export function scoreAgentPlanOutput(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): AgentPlanScore {
  return scoreAgentPlanDetailed(golden, raw, fixture).score;
}

/**
 * Owner answer 1 of 2026-10-22: {@link scoreAgentPlanOutput}, then a miss whose only differences are the args of
 * `jira.release` steps, each giving the owner the same final outcome as the gold step in the snapshot Jira world
 * (`sameJiraReleaseOutcome`, Core's own lookup), is `exact`. Every other step and outcome keeps the exact comparison.
 */
export async function scoreAgentPlanOutputInWorld(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): Promise<AgentPlanScore> {
  const { score, got, want } = scoreAgentPlanDetailed(golden, raw, fixture);
  if (score.outcome !== 'miss' || score.diff !== 'args' || got === undefined || want === undefined || got.length !== want.length) return score;
  for (const [index, a] of got.entries()) {
    const b = want[index] as StepGraph[number];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a.kind !== 'read' || b.kind !== 'read' || a.entryId !== 'jira.release' || b.entryId !== 'jira.release' || a.ref !== b.ref) return score;
    const args = (graphArgs: string): NlArgs => Object.fromEntries(JSON.parse(graphArgs) as Array<[string, NlArgs[string]]>);
    if (!(await sameJiraReleaseOutcome(golden.text, args(a.args), args(b.args)))) return score;
  }
  const { diff: _diff, diffStep: _diffStep, diffArgs: _diffArgs, summaryDiff: _summaryDiff, ...rest } = score;
  return { ...rest, outcome: 'exact' };
}

function scoreAgentPlanDetailed(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): { readonly score: AgentPlanScore; readonly got?: StepGraph; readonly want?: StepGraph } {
  const score = scoreAgentPlanAnswer(golden, raw, fixture);
  if (score.outcome !== 'miss' || golden.gold === 'none' || isAgentPlanAskExpect(golden.gold)) return { score };
  const prepared = caseContext(golden, fixture);
  const plan = 'skip' in prepared ? null : parseAgentPlanOutput(raw);
  const validation = plan === null || 'skip' in prepared ? undefined : validateAgentPlan(plan, prepared.ctx);
  if (validation === undefined || !validation.ok || validation.plan.kind !== 'run') return { score };
  return { score, got: validatedGraph(validation.plan.steps), want: goldGraph(golden.gold) };
}

function scoreAgentPlanAnswer(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): AgentPlanScore {
  const score = scoreRestPlan(golden, raw, fixture);
  // A1-E4: an exact rest plan is exact only with the expected help section (none expected, none split; or the same topic).
  if (score.outcome !== 'exact') return score;
  const prepared = caseContext(golden, fixture);
  const topic = 'skip' in prepared ? undefined : prepared.split?.topic;
  return topic === golden.help ? score : { ...score, outcome: 'miss', diff: 'help' };
}

function scoreRestPlan(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): AgentPlanScore {
  const negative = golden.gold === 'none' || isAgentPlanAskExpect(golden.gold);
  const prepared = caseContext(golden, fixture);
  if ('skip' in prepared) return { outcome: 'skipped', reason: `skip:${prepared.skip}` };
  const plan = parseAgentPlanOutput(raw);
  if (plan === null) return { outcome: 'malformed' };
  const gotEntries = closedEntries(plan);
  const asNone = (reason?: string): AgentPlanScore => ({ outcome: negative ? 'none' : 'miss-none', gotEntries, ...(reason !== undefined ? { reason } : {}) });
  if (plan.kind === 'none') return asNone();
  // The ADR-0120 A7 message-level vetoes are validator rules (`veto-*` refusals), shared with the runtime.
  const validation = validateAgentPlan(plan, prepared.ctx);
  if (!validation.ok) {
    return { outcome: 'refused', gotEntries, reason: validation.reason, ...(validation.step !== undefined ? { failedStep: validation.step } : {}) };
  }
  if (validation.plan.kind === 'none') return asNone();
  if (validation.plan.kind === 'clarify') return { outcome: 'clarify', gotEntries };
  if (validation.plan.kind === 'ask') {
    const gold = golden.gold;
    const same = isAgentPlanAskExpect(gold) && gold.bound === validation.plan.bound && graphDiff(validatedGraph(validation.plan.suggestion), goldGraph(gold.suggestion)) === undefined;
    // CA P2: a suggestion on a `none` gold offers a plan the owner never asked for: wrong, like any executable plan there.
    if (gold === 'none') return { outcome: 'wrong', gotEntries, reason: `unbounded:${validation.plan.bound}` };
    return { outcome: same ? 'asked' : 'ask-other', gotEntries, reason: `unbounded:${validation.plan.bound}` };
  }
  // Owner principle of 2026-10-19 (gates score Core's final result), as the read scorers since owner decision A of
  // 2026-10-22: a general help.topic plan whose words name one catalog source is answered by Core's help-scope question
  // (`nlHelpSourceScope`, the runtime's own function), never by the help text.
  const only = validation.plan.steps.length === 1 ? validation.plan.steps[0] : undefined;
  // Negatives only (the coordinator's scope of 2026-10-26): on a help.topic positive the planner's choice is scored as is.
  if (golden.gold === 'none' && only?.kind === 'read' && nlHelpSourceScope({ entryId: only.entry.id, args: only.args }, prepared.ctx.groundingText) !== undefined) {
    return { outcome: 'clarify', gotEntries, reason: 'help-scope' };
  }
  // A clarification gold: a CLEAR plan of one listed entry is a miss (the question was the right answer), never wrong.
  if (golden.gold === 'none' && only?.kind === 'read' && golden.clarify?.between.includes(only.entry.id) === true) return { outcome: 'miss', gotEntries, reason: 'clarify-gold' };
  if (golden.gold === 'none' || isAgentPlanAskExpect(golden.gold)) return { outcome: 'wrong', gotEntries };
  const gotGraph = validatedGraph(validation.plan.steps);
  const wantGraph = goldGraph(golden.gold);
  const diff = graphDiff(gotGraph, wantGraph);
  const summaries = graphSummaries(gotGraph);
  const gotSummaries = summaries.length > 0 ? { gotSummaries: summaries } : {};
  // CA finding 5: the related step is scored too (a missing, extra or other step is a miss).
  if (diff === undefined && validation.plan.related !== golden.gold.related) return { outcome: 'miss', gotEntries, diff: 'related', ...gotSummaries };
  if (diff === undefined) return { outcome: 'exact', gotEntries, ...gotSummaries };
  const summaryDiff = summaryDiffOf(gotGraph, wantGraph);
  const summaryFields = { ...gotSummaries, ...(summaryDiff !== undefined ? { summaryDiff } : {}) };
  // Owner decision of 2026-10-26 (capability-help golds): when the sentence names a source app, that source's help topic is
  // also correct for a general help.topic gold (the structural sourceNames -> help topic mapping); any other topic is not.
  if (golden.family === 'capability-help' && diff.kind === 'args' && only?.kind === 'read' && only.entry.id === 'help.topic' && sourceHelpTopicAccepted(golden.gold, only.args, prepared.ctx.groundingText)) {
    return { outcome: 'exact', gotEntries, reason: 'source-help-topic' };
  }
  return { outcome: 'miss', gotEntries, diff: diff.kind, ...(diff.step !== undefined ? { diffStep: diff.step } : {}), ...(diff.args !== undefined ? { diffArgs: diff.args } : {}), ...summaryFields };
}

/** A one-step general help.topic gold, answered with the help topic of a source the sentence names. */
function sourceHelpTopicAccepted(gold: AgentPlanGoldPlan, args: NlArgs, groundingText: string): boolean {
  const [step, ...rest] = gold.steps;
  if (step === undefined || rest.length > 0 || !('entryId' in step) || step.entryId !== 'help.topic' || step.ref !== undefined || Object.keys(step.args ?? {}).length > 0) return false;
  const keys = Object.keys(args);
  const topic = args.topic;
  return keys.length === 1 && typeof topic === 'string' && namedSourceHelpTopics(groundingText).has(topic);
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
    const ask = isAgentPlanAskExpect(golden.expect);
    const positive = golden.expect !== 'none' && !ask;
    if (positive !== golden.id.startsWith('ap-p')) problems.push(`${at}: ap-p ids are positives, ap-n ids negatives`);
    if (positive !== (AGENT_PLAN_POSITIVE_FAMILIES as readonly string[]).includes(golden.family)) problems.push(`${at}: family does not match the expectation`);
    const prepared = caseContext(evalCaseOf(golden), corpus.fixture);
    if (isAgentPlanAskExpect(golden.expect)) {
      problems.push(...askCaseProblems(at, golden.expect, golden, prepared));
      continue;
    }
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
      // A1-E4: at least two sections; a help section split off before planning counts as one.
      const split = prepared.split?.topic;
      if (split !== golden.help) problems.push(`${at}: the help split gives ${split ?? 'no help section'}, not ${golden.help ?? 'no help section'}`);
      const oneStep = AGENT_PLAN_ONE_STEP_POSITIVE_FAMILIES.includes(golden.family);
      if (oneStep && (plan.steps.length !== 1 || golden.help !== undefined)) problems.push(`${at}: a one-step positive family holds exactly one step and no help section`);
      if (!oneStep && plan.steps.length < (golden.help !== undefined ? 1 : 2)) problems.push(`${at}: a multi-step positive needs at least two sections`);
      if (golden.readWrite !== undefined) {
        if (golden.readWrite.outcome !== 'read-and-note' || golden.readWrite.readPlan === undefined || graphDiff(goldGraph(golden.readWrite.readPlan), goldGraph(golden.expect)) !== undefined) {
          problems.push(`${at}: a positive's readWrite is read-and-note with the gold as its read plan`);
        } else problems.push(...readWriteProblems(at, golden, corpus.fixture));
      }
      if (golden.formerId !== undefined && !/^ap-[pn]\d{3}$/.test(golden.formerId)) problems.push(`${at}: formerId must be an ap- id`);
      if (golden.clarify !== undefined) problems.push(`${at}: only a negative is a clarification gold`);
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
      else if (validation.plan.related !== golden.expect.related) problems.push(`${at}: the gold related step is not canonical`);
      continue;
    }
    if (golden.help !== undefined) problems.push(`${at}: only a positive names a help section`);
    if (golden.clarify !== undefined && (!Array.isArray(golden.clarify.between) || golden.clarify.between.length === 0 || !golden.clarify.between.every((id) => isNlWave1EntryId(id)))) {
      problems.push(`${at}: clarify.between lists closed READ entry ids`);
    }
    if (golden.readWrite !== undefined) problems.push(...readWriteProblems(at, golden, corpus.fixture));
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

/** The A6 entries the read + write path may hand a write clause to (the offered A6 catalog of the fixture). */
const ACTION_ENTRIES: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);

/**
 * The S2 read + write note (owner decision Q3, 2026-10-23): a `readWrite` expectation is well-formed when its conjuncts,
 * read plan and write selection are what Core would derive: `unchanged / one-conjunct` has one conjunct; every other
 * outcome has two or more; the write clause is exactly one of them; the read plan of the other conjuncts validates to a
 * canonical `run` plan with their words alone as grounding; a `read-and-write` selection validates (ADR-0120 D4, actions
 * on) with the write clause alone as grounding text (no read word reaches the write args) and is canonical.
 */
function readWriteProblems(at: string, golden: AgentPlanCase, fixture: AgentPlanCorpus['fixture']): string[] {
  const rw = golden.readWrite as AgentPlanReadWriteExpect;
  const problems: string[] = [];
  if (golden.expect !== 'none' && golden.readWrite?.outcome !== 'read-and-note') problems.push(`${at}: readWrite is for a none negative or a read-and-note positive`);
  if (!(AGENT_PLAN_READ_WRITE_OUTCOMES as readonly string[]).includes(rw.outcome)) return [...problems, `${at}: unknown readWrite outcome`];
  if (rw.why !== undefined && !(AGENT_PLAN_READ_WRITE_WHY as readonly string[]).includes(rw.why)) problems.push(`${at}: unknown readWrite why`);
  const prepared = prepareSelectionInput(golden.text, golden.attachments ?? 0);
  if ('skip' in prepared) return [...problems, `${at}: the input is skipped`];
  const tokens = conjunctTokens(prepared.groundingText, { verbConnective: true });
  const clauses = new Map<number, string[]>();
  for (const token of tokens) if (!token.boundary) clauses.set(token.conjunct, [...(clauses.get(token.conjunct) ?? []), token.text]);
  const texts = [...clauses.values()].map((words) => words.join(' ').replace(/[,،]$/u, ''));
  if (rw.outcome === 'unchanged') {
    if (rw.why === 'one-conjunct' && texts.length !== 1) problems.push(`${at}: one-conjunct but ${texts.length} conjuncts`);
    if (rw.why === 'no-offered-entry' && texts.length < 2) problems.push(`${at}: no-offered-entry needs two or more conjuncts`);
    if (rw.writeClause !== undefined || rw.readPlan !== undefined || rw.write !== undefined) problems.push(`${at}: unchanged carries no clause, plan or write`);
    return problems;
  }
  if (texts.length < 2) return [...problems, `${at}: the read + write path needs two or more conjuncts`];
  const writeAt = texts.indexOf(rw.writeClause ?? '');
  if (writeAt < 0) return [...problems, `${at}: the write clause is not one conjunct`];
  if (rw.readPlan === undefined) return [...problems, `${at}: no read plan`];
  const readText = texts.filter((_text, index) => index !== writeAt).join(' ');
  const plan = parseAgentPlanOutput(JSON.stringify(rw.readPlan));
  const ctx = { offered: OFFERED, groundingText: readText, now: fixture.now as AgentPlanValidationContext['now'], timeZone: fixture.timeZone, direct: fixture.direct };
  const validated = plan === null ? undefined : validateAgentPlan(plan, ctx);
  if (validated === undefined || !validated.ok || validated.plan.kind !== 'run') problems.push(`${at}: the read plan does not validate on the read conjuncts`);
  else if (graphDiff(validatedGraph(validated.plan.steps), goldGraph(rw.readPlan)) !== undefined) problems.push(`${at}: the read plan is not canonical`);
  if (rw.outcome === 'read-and-note') {
    if (rw.write !== undefined) problems.push(`${at}: read-and-note runs no write`);
    if (rw.why !== 'list-ref' && rw.why !== 'deictic') problems.push(`${at}: read-and-note needs why list-ref or deictic`);
    return problems;
  }
  if (rw.write === undefined || !isNlActionEntryId(rw.write.entryId)) return [...problems, `${at}: read-and-write needs an A6 write`];
  const offered = new Map([...READ_ENTRIES, ...ACTION_ENTRIES].map((entry) => [entry.id, entry] as const));
  const write = validateSelection(
    { entryId: rw.write.entryId, args: rw.write.args },
    { offered, groundingText: rw.writeClause as string, now: fixture.now as AgentPlanValidationContext['now'], timeZone: fixture.timeZone, actions: true },
  );
  if (!write.ok) problems.push(`${at}: the write does not validate on the write clause alone (${write.reason})`);
  else if (sortedArgs(write.value.args) !== sortedArgs(rw.write.args)) problems.push(`${at}: the write args are not canonical`);
  return problems;
}

/**
 * Decision (h): an ask case needs a well-formed expectation and a trap (the unbounded plan) that the validator turns into
 * exactly that ask: the same bound and the same suggestion graph.
 */
function askCaseProblems(at: string, expect: AgentPlanAskExpect, golden: AgentPlanCase, prepared: ReturnType<typeof caseContext>): string[] {
  const problems: string[] = [];
  if (expect.reason !== 'unbounded' || !(AGENT_UNBOUNDED_KINDS as readonly string[]).includes(expect.bound)) problems.push(`${at}: an ask needs reason unbounded and a closed bound`);
  if (golden.trapRefusal !== undefined) problems.push(`${at}: an ask case has no trapRefusal`);
  const suggestion = parseAgentPlanOutput(JSON.stringify(expect.suggestion));
  if (suggestion === null || suggestion.kind !== 'steps' || suggestion.form !== 'steps') problems.push(`${at}: the suggestion does not parse as a steps-form plan`);
  if (golden.trap === undefined) return [...problems, `${at}: an ask case needs the unbounded plan as its trap`];
  if ('skip' in prepared) return [...problems, `${at}: the input is skipped (${prepared.skip})`];
  const trap = parseAgentPlanOutput(JSON.stringify(golden.trap));
  if (trap === null) return [...problems, `${at}: the trap does not parse`];
  const validation = validateAgentPlan(trap, prepared.ctx);
  if (!validation.ok) return [...problems, `${at}: the trap is refused (${validation.reason}${validation.step !== undefined ? ` at step ${validation.step}` : ''}), not asked`];
  if (validation.plan.kind !== 'ask') return [...problems, `${at}: the trap validates to ${validation.plan.kind}, not ask`];
  if (validation.plan.bound !== expect.bound) problems.push(`${at}: the trap asks with bound ${validation.plan.bound}, not ${expect.bound}`);
  const diff = graphDiff(validatedGraph(validation.plan.suggestion), goldGraph(expect.suggestion));
  if (diff !== undefined) problems.push(`${at}: the suggestion differs (${diff.kind}${diff.step !== undefined ? ` at step ${diff.step}` : ''})`);
  return problems;
}

// ── the plan and its digest ─────────────────────────────────────────────────────────────────────────────────────

export interface AgentPlanEvalOptions {
  readonly model: string;
  /** Owner decision of 2026-10-28: the planner's reasoning effort (a Claude `--effort` level), bound into the digest. */
  readonly effort: string;
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
  /** The planner's reasoning effort (owner decision of 2026-10-28: bound into the digest). */
  readonly effort: string;
  readonly runs: number;
  readonly concurrency: number;
  /** The per-call bound (the runtime's selection bound); a call over it is a timeout and counts as over the bound. */
  readonly callTimeoutMs: number;
  readonly includePending: boolean;
  readonly fixture: AgentPlanCorpus['fixture'];
  readonly caseIds: readonly string[];
  /**
   * The read + write trigger amendment (owner-ratified 2026-10-26): at most one more call per case, the A6 selection probe,
   * made only when the planner's validated plan leaves an uncovered clause. Bound: the cases of two or more conjuncts.
   */
  readonly readWriteProbe: { readonly promptVersion: string; readonly promptSha256: string; readonly maxCallsPerRun: number };
  /** The hard call cap: one planner call per case per run plus the probe bound (a skipped input makes none). */
  readonly maxCallsPerRun: number;
  readonly maxCalls: number;
  /** `false` with `--include-pending`: the run reports numbers only, never a gate verdict (CA review of S2 P2). */
  readonly gating: boolean;
  readonly gate: typeof AGENT_PLAN_EVAL_GATE | 'non-gating';
}

/** The A6 entries the read + write probe offers (the A6 catalog; the probe prompt holds no read entry, gate on ed45e3f1). */
const PROBE_ENTRIES: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const PROBE_OFFERED: ReadonlyMap<string, NlCatalogEntry> = new Map(PROBE_ENTRIES.map((entry) => [entry.id, entry] as const));

/** sha256 of the probe's A6 selection instruction text (every entry offered, an empty owner message). */
export function readWriteProbePromptSha256(): string {
  return sha256(agentReadWriteProbePrompt({ entries: PROBE_ENTRIES, text: '' }));
}

/** The uncovered clauses of the planner's answer (validated under the case context), or `[]` (no probe needed). */
export function readWriteProbeClausesOf(golden: AgentPlanEvalCase, raw: string, fixture: AgentPlanCorpus['fixture']): string[] {
  const prepared = caseContext(golden, fixture);
  if ('skip' in prepared) return [];
  const plan = parseAgentPlanOutput(raw);
  if (plan === null) return [];
  const validation = validateAgentPlan(plan, prepared.ctx);
  return validation.ok ? agentReadWriteProbeClauses(validation.plan, prepared.ctx.groundingText) : [];
}

/** The probe's stand detail as a closed value (`invalid:<closed validation reason>` or one of the fixed details). */
function closedProbeDetail(detail: string): string {
  if (['malformed', 'none', 'not-action', 'not-write', 'not-requested'].includes(detail)) return detail;
  return /^invalid:[a-z-]+$/.test(detail) ? detail : 'other';
}

/** The probe result each `readWrite` gold outcome expects. */
const READ_WRITE_PROBE_OF: Readonly<Record<string, 'write' | 'note' | 'clarify' | 'stands'>> = {
  'read-and-write': 'write',
  'read-and-note': 'note',
  'read-and-clarify': 'clarify',
  unchanged: 'stands',
};

/**
 * Core's final outcome after the probe (CA review of P3, W3). With a `readWrite` gold, the probe result must be the one
 * that gold names (write ↔ read-and-write, note ↔ read-and-note, clarify ↔ read-and-clarify): a match is `read-write` /
 * `read-note` / `read-clarify`, a mismatch is `wrong` on a negative and a miss on a positive. Without one, a `write` on a
 * negative is `wrong` (a write the gold never expected); a note or a clarification writes nothing. A probe that `stands`
 * keeps the plan's own score.
 */
export function applyReadWriteProbe(
  score: AgentPlanScore,
  golden: AgentPlanEvalCase,
  probeRaw: string,
  clauses: readonly string[],
  fixture: AgentPlanCorpus['fixture'],
): AgentPlanScore & { readonly probe: 'write' | 'note' | 'clarify' | 'stands'; readonly probeEntry?: string; readonly probeDetail?: string } {
  const result = agentReadWriteProbeResult(probeRaw, clauses, PROBE_OFFERED, { now: fixture.now as AgentPlanValidationContext['now'], timeZone: fixture.timeZone });
  if (result.kind === 'stands') return { ...score, probe: 'stands', ...(result.detail !== undefined ? { probeDetail: closedProbeDetail(result.detail) } : {}) };
  const { diff: _diff, diffStep: _diffStep, diffArgs: _diffArgs, summaryDiff: _summaryDiff, ...rest } = score;
  // A write-word note (owner decision of 2026-10-26, ap-n011) names no entry: the probe found no write.
  const entry = result.entryId === undefined ? 'write-word' : isNlActionEntryId(result.entryId) ? result.entryId : 'unknown';
  const reason = `${result.kind}:${entry}`;
  const outcome = result.kind === 'write' ? 'read-write' : result.kind === 'note' ? 'read-note' : 'read-clarify';
  const expected = golden.readWrite !== undefined ? READ_WRITE_PROBE_OF[golden.readWrite.outcome] : undefined;
  const negative = golden.gold === 'none' || isAgentPlanAskExpect(golden.gold);
  // An item-summary note (ITEM_READ, never a write) re-scores only where the gold expects decision (f)'s note.
  if (result.kind === 'note' && result.itemRead === true && expected !== 'note') return { ...score, probe: 'stands', probeEntry: entry, probeDetail: 'item-read' };
  if (expected !== undefined && expected !== result.kind) return { ...rest, outcome: negative ? 'wrong' : 'miss', reason: `probe-mismatch:${reason}`, probe: result.kind, probeEntry: entry };
  if (expected === undefined && negative && result.kind === 'write') return { ...rest, outcome: 'wrong', reason, probe: result.kind, probeEntry: entry };
  return { ...rest, outcome, reason, probe: result.kind, probeEntry: entry };
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
  if (!/^[a-z]{2,8}$/.test(options.effort)) throw new Error('invalid effort');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || parseNlIntentTimeoutMs(String(options.timeoutMs)) === undefined)) {
    throw new Error('timeoutMs must be an integer 2000..8000');
  }
  const selected = cases.filter((golden) => golden.status === 'approved' || options.includePending);
  if (selected.length === 0) throw new Error('no case selected');
  const probeBound = selected.filter((golden) => {
    const prepared = caseContext(golden, fixture);
    return !('skip' in prepared) && new Set(conjunctTokens(prepared.ctx.groundingText, { verbConnective: true }).filter((token) => !token.boundary).map((token) => token.conjunct)).size >= 2;
  }).length;
  const perRun = selected.length + probeBound;
  return {
    kind: 'agent-plan-eval',
    promptVersion: AGENT_PLAN_PROMPT_VERSION,
    promptSha256: agentPlanPromptSha256(),
    corpusSha256: hashes.corpusSha256,
    oneStepCorpusSha256: hashes.oneStepCorpusSha256,
    gitHead: options.gitHead,
    model: options.model,
    effort: options.effort,
    runs: options.runs,
    concurrency: options.concurrency,
    callTimeoutMs: options.timeoutMs ?? AGENT_PLAN_EVAL_DEFAULT_TIMEOUT_MS,
    includePending: options.includePending,
    fixture,
    caseIds: selected.map((golden) => golden.id),
    readWriteProbe: { promptVersion: AGENT_READ_WRITE_PROBE_PROMPT_VERSION, promptSha256: readWriteProbePromptSha256(), maxCallsPerRun: probeBound },
    maxCallsPerRun: perRun,
    maxCalls: perRun * options.runs,
    // CA W2: a gating verdict needs exactly AGENT_PLAN_EVAL_GATE.runs runs (the pooled multi-step rate is defined over 3).
    gating: !options.includePending && options.runs === AGENT_PLAN_EVAL_GATE.runs,
    gate: options.includePending || options.runs !== AGENT_PLAN_EVAL_GATE.runs ? 'non-gating' : AGENT_PLAN_EVAL_GATE,
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
  readonly expected: 'plan' | 'none' | 'ask';
  /** The gold's read entries (closed ids), for the per-entry report. */
  readonly goldEntries: readonly string[];
  readonly latencyMs: number;
  /** Closed error class name (never a message). */
  readonly error?: string;
  /** The case is a clarification gold (a question is its correct answer). */
  readonly clarifyGold?: true;
  /**
   * The read + write probe of this case: its closed result. A probe call that timed out or failed is the record's outcome
   * (`timeout` / `error`, reason `probe-timeout` / `probe-error`; Codex P2), never silently the planner's.
   */
  readonly probe?: 'write' | 'note' | 'clarify' | 'stands' | 'timeout' | 'error';
  /** The probe's closed diagnostics (content-free): the A6 entry it picked, or why the plan stood. */
  readonly probeEntry?: string;
  readonly probeDetail?: string;
  /** The probe call's latency (counted in the calls, the latency percentiles and the over-bound rate). */
  readonly probeLatencyMs?: number;
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
  return golden.gold === 'none' || isAgentPlanAskExpect(golden.gold) ? [] : golden.gold.steps.map((step) => ('summarize' in step ? 'summarize' : step.entryId));
}

function expectedOf(golden: AgentPlanEvalCase): 'plan' | 'none' | 'ask' {
  return golden.gold === 'none' ? 'none' : isAgentPlanAskExpect(golden.gold) ? 'ask' : 'plan';
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
        const base = { run, id: golden.id, family: golden.family, expected: expectedOf(golden), goldEntries: goldEntriesOf(golden), ...(golden.clarify !== undefined ? { clarifyGold: true as const } : {}) };
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
            const scored = await scoreAgentPlanOutputInWorld(golden, result.text, input.plan.fixture);
            const latencyMs = clock() - started;
            // The read + write trigger amendment: an uncovered clause gets the probe's one A6 selection call (capped).
            const clauses = readWriteProbeClausesOf(golden, result.text, input.plan.fixture);
            if (clauses.length === 0) {
              record = { ...base, ...scored, latencyMs };
            } else {
              // Owner decision of 2026-10-26: the whole message (validation still on each uncovered clause alone).
              const probePrompt = agentReadWriteProbePrompt({ entries: PROBE_ENTRIES, text: prepared.text });
              const probeStarted = clock();
              try {
                const probe = await withTimeout(capped.provider.execute({ capability: Capability.INTENT_SELECTION, prompt: probePrompt, timeoutMs: input.plan.callTimeoutMs }), input.plan.callTimeoutMs);
                record = { ...base, ...applyReadWriteProbe(scored, golden, probe.text, clauses, input.plan.fixture), latencyMs, probeLatencyMs: clock() - probeStarted };
              } catch (error) {
                const probeLatencyMs = clock() - probeStarted;
                if (error instanceof AgentPlanCallCapReached) record = { ...base, outcome: 'capped', latencyMs: 0 };
                else if (error instanceof EvalCallTimeout || (error as { kind?: unknown } | null)?.kind === 'TIMEOUT') {
                  record = { ...base, outcome: 'timeout', reason: 'probe-timeout', probe: 'timeout', gotEntries: scored.gotEntries ?? [], latencyMs, probeLatencyMs };
                } else {
                  record = { ...base, outcome: 'error', reason: 'probe-error', probe: 'error', error: closedErrorName(error), latencyMs, probeLatencyMs };
                }
              }
            }
          } catch (error) {
            const latencyMs = clock() - started;
            if (error instanceof AgentPlanCallCapReached) record = { ...base, outcome: 'capped', latencyMs: 0 };
            else if (error instanceof EvalCallTimeout || (error as { kind?: unknown } | null)?.kind === 'TIMEOUT') record = { ...base, outcome: 'timeout', latencyMs };
            else record = { ...base, outcome: 'error', latencyMs, error: closedErrorName(error) };
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
  /**
   * Executable plans on negatives other than a help.topic-only plan: zero-tolerance (a hard failure). Owner decision of
   * 2026-10-26 extending the 2026-10-22 D12 amendment: help.topic-only plans on negatives are `helpCaptures` instead.
   */
  readonly wrongOnNegatives: number;
  /** Executable plans on negatives that are exactly one help.topic step (shows usage guidance only; no data is read). */
  readonly helpCaptures: number;
  /** ceil(1% of the run's negatives). */
  readonly helpAllowance: number;
  /** Help captures over the allowance: a hard failure (an outage never hides it). */
  readonly helpOverAllowance: number;
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
  /** Clarification golds and how many of them Core asked (not gated; as the read gates' report). */
  readonly clarifyGolds: { readonly total: number; readonly asked: number };
  /**
   * The gated groups (CA review of S2 P2): multi-step positives (the new corpus) and one-step positives (Q11). `ask`
   * (decision (h)): the unbounded requests answered with the expected ask (`exact` = `asked`); gated at >= 95% when
   * present (CA P2).
   */
  readonly groups: { readonly multiStep: AgentPlanEvalSlot; readonly oneStep: AgentPlanEvalSlot; readonly ask: AgentPlanEvalSlot };
  /** `false` for an `--include-pending` run: no verdict, `gatePassed` is always false. */
  readonly gating: boolean;
  /**
   * The run's own checks (owner decision of 2026-10-26: every gate criterion except the multi-step exact rate, which is
   * judged on the pooled runs, {@link agentPlanPooledGate}): one-step >= 95%, 0 wrong on negatives other than help
   * captures, help captures within the allowance, over-bound and asks as before, no capped call.
   */
  readonly gatePassed: boolean;
}

/** The pooled multi-step verdict over the runs (owner decision of 2026-10-26) and the gate's final verdict. */
export interface AgentPlanPooledGate {
  /** Every multi-step record of every run. */
  readonly multiStep: AgentPlanEvalSlot;
  readonly multiStepPassed: boolean;
  /** Runs whose own checks passed (`gatePassed`). */
  readonly runsPassed: number;
  readonly runs: number;
  /** The gate: the pooled multi-step rate >= 95% AND every run's own checks passed. */
  readonly passed: boolean;
}

/**
 * Owner decision of 2026-10-26 (the gate rule): the multi-step exact rate is judged on the POOLED records of all runs
 * (>= 95% of every multi-step record across the runs); the one-step rate, zero non-help wrongs, the help-capture ceiling,
 * the over-bound rate and the hard cap stay per run. Pure.
 */
export function agentPlanPooledGate(summaries: readonly AgentPlanEvalSummary[]): AgentPlanPooledGate {
  const total = summaries.reduce((sum, summary) => sum + summary.groups.multiStep.total, 0);
  const exact = summaries.reduce((sum, summary) => sum + summary.groups.multiStep.exact, 0);
  const rate = total === 0 ? 0 : exact / total;
  const multiStepPassed = total > 0 && rate >= AGENT_PLAN_EVAL_GATE.multiStepExact;
  const runsPassed = summaries.filter((summary) => summary.gatePassed).length;
  const gating = summaries.length === AGENT_PLAN_EVAL_GATE.runs && summaries.every((summary) => summary.gating);
  return { multiStep: { total, exact, rate }, multiStepPassed, runsPassed, runs: summaries.length, passed: gating && multiStepPassed && runsPassed === summaries.length };
}

export function summarizeAgentPlanRun(records: readonly AgentPlanEvalRecord[], boundMs: number, options: { readonly gating?: boolean } = {}): AgentPlanEvalSummary {
  const positives = records.filter((record) => record.expected === 'plan');
  // An ask case is a negative for `wrong` (any executable plan is wrong there too).
  const negatives = records.filter((record) => record.expected !== 'plan');
  const asks = records.filter((record) => record.expected === 'ask');
  const asked = asks.filter((record) => record.outcome === 'asked').length;
  const exact = positives.filter((record) => record.outcome === 'exact').length;
  // Owner decision of 2026-10-26: a help.topic-only plan on a negative is a help capture, counted apart.
  // CA review of P3, W4 (a clarification of the owner's 2026-10-26 decision): Core's help-scope question on a negative
  // WITHOUT a clarification gold is a help-like answer there, so it counts toward the help allowance; on a clarification
  // gold it is the hit (asked).
  const isHelpCapture = (record: AgentPlanEvalRecord): boolean =>
    (record.outcome === 'wrong' && record.gotEntries?.length === 1 && record.gotEntries[0] === 'help.topic') ||
    (record.outcome === 'clarify' && record.reason === 'help-scope' && record.clarifyGold !== true);
  const helpCaptures = negatives.filter(isHelpCapture).length;
  const helpAllowance = helpCaptureAllowance(negatives.length);
  const wrongOnNegatives = negatives.filter((record) => record.outcome === 'wrong' && !isHelpCapture(record)).length;
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
  // Codex P2: the read + write probe calls are calls too: their latency and timeouts count in the gated measurements.
  const probed = called.filter((record) => record.probeLatencyMs !== undefined);
  const latencies = [...called.map((record) => record.latencyMs), ...probed.map((record) => record.probeLatencyMs as number)].sort((a, b) => a - b);
  const pct = (p: number): number => (latencies.length === 0 ? 0 : (latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil((p / 100) * latencies.length) - 1))] as number));
  const plannerOver = called.filter((record) => (record.outcome === 'timeout' && record.probe !== 'timeout') || record.latencyMs > boundMs).length;
  const probeOver = probed.filter((record) => record.probe === 'timeout' || (record.probeLatencyMs as number) > boundMs).length;
  const overBound = plannerOver + probeOver;
  const callCount = called.length + probed.length;
  const overBoundRate = callCount === 0 ? 0 : overBound / callCount;
  const exactRate = positives.length === 0 ? 1 : exact / positives.length;
  const capped = records.filter((record) => record.outcome === 'capped').length;
  const group = (oneStepGroup: boolean): AgentPlanEvalSlot => {
    const members = positives.filter((record) => (record.family === AGENT_PLAN_ONE_STEP_FAMILY || AGENT_PLAN_ONE_STEP_POSITIVE_FAMILIES.includes(record.family)) === oneStepGroup);
    const hits = members.filter((record) => record.outcome === 'exact').length;
    return { total: members.length, exact: hits, rate: members.length === 0 ? 0 : hits / members.length };
  };
  const multiStep = group(false);
  const oneStep = group(true);
  const gating = options.gating ?? true;
  return {
    cases: records.length,
    positives: positives.length,
    exact,
    exactRate,
    negatives: negatives.length,
    wrongOnNegatives,
    helpCaptures,
    helpAllowance,
    helpOverAllowance: Math.max(0, helpCaptures - helpAllowance),
    perFamily,
    perEntry,
    outcomes,
    calls: callCount,
    latency: { p50: pct(50), p95: pct(95), max: latencies.at(-1) ?? 0, boundMs, overBound },
    overBoundRate,
    capped,
    clarifyGolds: {
      total: records.filter((record) => record.clarifyGold === true).length,
      asked: records.filter((record) => record.clarifyGold === true && record.outcome === 'clarify').length,
    },
    groups: { multiStep, oneStep, ask: { total: asks.length, exact: asked, rate: asks.length === 0 ? 0 : asked / asks.length } },
    gating,
    gatePassed:
      gating &&
      multiStep.total > 0 &&
      oneStep.total > 0 &&
      // Owner decision of 2026-10-26: the multi-step rate is pooled over the runs (`agentPlanPooledGate`), not per run.
      oneStep.rate >= AGENT_PLAN_EVAL_GATE.oneStepExact &&
      wrongOnNegatives <= AGENT_PLAN_EVAL_GATE.wrongOnNegatives &&
      helpCaptures <= helpAllowance &&
      overBoundRate <= AGENT_PLAN_EVAL_GATE.overBoundRate &&
      (asks.length === 0 || asked / asks.length >= AGENT_PLAN_EVAL_GATE.askAsked) &&
      capped === 0,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
