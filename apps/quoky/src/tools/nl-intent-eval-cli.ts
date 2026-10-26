/**
 * Natural-language selection evaluation CLI (ADR-0120 D12).
 *
 *   pnpm eval:nl -- --mode plan [--model haiku] [--entries jira.issues,help.topic] [--negatives true|false] [--per-entry N] [--runs N] [--concurrency N]
 *   pnpm eval:nl -- --mode run  <the same options> --approved-plan-digest <sha256 from plan>
 *   (or: pnpm --filter @quoky/app nl-eval -- …)
 *
 * `plan` is offline: it reads the corpus and prints the plan and its digest; nothing is constructed or spawned. `run` is
 * Strict (each run needs the owner's approval of the plan digest): it recomputes the digest and exits 3 BEFORE any
 * provider is constructed unless `--approved-plan-digest` equals it. It then runs the real selection prompt through the
 * local Claude CLI (`claude -p` with the selection model, low effort, no tools) over the planned cases, scores exact
 * `{ entry, args }` matches after Core's validation, prints the hit rate per entry, the wrong captures and p50/p95
 * latency, writes `data/eval/nl-intent-<ts>.json`, and exits 0 only when the gate passes (≥95% overall, ≥90% per
 * entry, 0 wrong captures).
 *
 * ADR-0120 amendment A6 (NLA-6):
 *
 *   pnpm eval:nl -- --mode action [--model haiku] [--runs N] [--concurrency N] [--approved-plan-digest <sha256>]
 *   pnpm eval:nl -- --mode read-regression [same options]
 *
 * Without `--approved-plan-digest` both are offline: they check the corpus schema, print the plan, its digest and (for
 * `action`) the grammar-side baseline; nothing is constructed or spawned. With it they are Strict runs under the same
 * digest rule: `action` scores `golden/nl-action.v1.json` (+ the R0 seed) through Core's own decision path (exact
 * `{entry, args, target}`, spans, wrong targets, negatives, questions); `read-regression` re-runs `nl-intent.v1.json` with
 * the A6 entries offered and fails on any read case captured by an action or ITEM_READ entry.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudeCliProvider, DEFAULT_CLAUDE_INTENT_SELECTION_MODEL } from '@quoky/ai-cli';
import { Capability, type AiProvider } from '@quoky/core';
import { gitHead as defaultGitHead } from './nl-r2-prompt-binding';
import {
  EXIT_INVALID_PROVIDER,
  formatProviderOutcomes,
  formatTrip,
  guardEvalProvider,
  hardFailureTotal,
  invalidVerdict,
  outageAlsoSeenNote,
  printInvalidRun,
  providerCanary,
  CANARY_PLAN_LINE,
  type CanaryResult,
  type GuardedProvider,
  type HardFailureCounts,
} from './eval-provider-guard';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import {
  NL_ACTION_EVAL_GATE,
  NL_ACTION_R2_EVAL_GATE,
  buildActionPlan,
  computeActionPlanDigest,
  loadActionCorpus,
  loadR2ActionCorpus,
  loadReadRegressionCorpus,
  runActionEvaluation,
  runReadRegression,
  scoreActionGrammarSide,
  summarizeAction,
  summarizeActionR2,
  summarizeReadRegression,
  validateActionCorpus,
  NL_ACTION_R2_EVAL_ENTRIES,
} from './nl-action-eval';
import {
  NL_EVAL_GATE,
  NL_EVAL_OPEN_QUESTION_LABEL,
  NL_EVAL_RUNTIME_TIMEOUT_MS,
  buildPlan,
  computePlanDigest,
  loadCorpus,
  runEvaluation,
  summarize,
  clarifyCaseIdsOf,
  formatSideScore,
  scoreGrammarSide,
  scoreSelectorSide,
  type NlEvalCorpus,
  type NlEvalPlanOptions,
  type NlEvalRecord,
  type NlEvalSummary,
} from './nl-intent-eval';

export const EXIT_OK = 0;
/** The gate failed (or an offline problem). */
export const EXIT_GATE_FAILED = 1;
export const EXIT_USAGE = 2;
/** Strict gate refused (digest missing or mismatched, CLI unavailable); nothing was spawned. */
export const EXIT_BLOCKED = 3;
/** The provider was unavailable for too many calls (usage/session limit, outage): the run is INVALID, not scored. */
export const EXIT_INVALID = EXIT_INVALID_PROVIDER;

/**
 * Wrap a run's provider in the outage guard (`eval-provider-guard.ts`); the trip is announced on stderr. The canary (one
 * tiny call through the same provider before the guard trips) is injectable so tests never call a real provider.
 */
export function guardRunProvider(
  provider: AiProvider,
  stderr: (line: string) => void,
  run: { readonly concurrency: number; readonly maxCalls: number; readonly canary?: (provider: AiProvider) => Promise<CanaryResult> },
): GuardedProvider {
  return guardEvalProvider(provider, {
    concurrency: run.concurrency,
    maxCalls: run.maxCalls,
    canary: run.canary !== undefined ? () => (run.canary as (provider: AiProvider) => Promise<CanaryResult>)(provider) : providerCanary(provider, undefined, Capability.INTENT_SELECTION),
    onTrip: (trip) => stderr(formatTrip(trip)),
  });
}

/** Sum a hard-failure metric over the runs' summaries. */
export function sumHardFailures(summaries: readonly object[], fields: readonly string[]): HardFailureCounts {
  return Object.fromEntries(fields.map((field) => [field, summaries.reduce((sum, summary) => sum + Number((summary as Record<string, unknown>)[field] ?? 0), 0)]));
}

const HELP = `Natural-language selection evaluation (ADR-0120 D12)

Offline:  pnpm eval:nl -- --mode plan [options]
Strict:   pnpm eval:nl -- --mode run [options] --approved-plan-digest <sha256 from plan>

Options: --model <claude model alias, default ${DEFAULT_CLAUDE_INTENT_SELECTION_MODEL}>  --entries <id,id,...>  --negatives true|false (default true)
         --per-entry <N, 0 = all>  --runs <1-5, default 1>  --concurrency <1-8, default 4>
         --timeout-ms <2000-8000, default QUOKY_NL_INTENT_TIMEOUT_MS if valid, else ${NL_EVAL_RUNTIME_TIMEOUT_MS}>
Gate: >= ${NL_EVAL_GATE.overall * 100}% overall, >= ${NL_EVAL_GATE.perEntry * 100}% per entry, ${NL_EVAL_GATE.wrongCaptures} data-read wrong captures, help.topic captures <= ceil(${NL_EVAL_GATE.helpCaptureRate * 100}% of the negatives) (owner decision 2026-10-22).

A6 (ADR-0120 amendment A6):
          pnpm eval:nl -- --mode action [--model M] [--runs N] [--concurrency N] [--approved-plan-digest <sha256>]
          pnpm eval:nl -- --mode read-regression [same options]
Without --approved-plan-digest these are offline (schema check, plan, digest, grammar-side baseline).
Action gate: >= ${NL_ACTION_EVAL_GATE.overall * 100}% exact {entry, args, target}, >= ${NL_ACTION_EVAL_GATE.perEntry * 100}% per entry, spans >= ${NL_ACTION_EVAL_GATE.spanExact * 100}%,
             ${NL_ACTION_EVAL_GATE.wrongTarget} wrong targets, ${NL_ACTION_EVAL_GATE.negativeCaptures} negative captures, questions on references <= ${NL_ACTION_EVAL_GATE.questionRateOnReferences * 100}%.
Read regression: the D12 gate on the read cases and 0 read cases captured by an action entry.

Every Strict run is guarded against provider outages: 5 provider failures in a row, 10 timeouts in a row, or provider
failures above 5% of the calls (judged mid-run from 40 calls and 3 failures, at the end from 2 failures) stop further
calls and mark the run INVALID (provider unavailable: <reason>), exit 5, never PASSED or FAILED.

A6 R2 (Jira / Slack item.summarize; the R2 prompt, R2 offered as with QUOKY_NL_ITEM_R2=all; the environment is never read):
          pnpm eval:nl -- --mode r2 [--model M] [--runs N] [--concurrency N] [--approved-plan-digest <sha256>]
Without --approved-plan-digest it is offline (schema check, plan, digest, call count). With it, a Strict run.
R2 gate: >= ${NL_ACTION_R2_EVAL_GATE.overall * 100}% exact {entry, args, target} overall and >= ${NL_ACTION_R2_EVAL_GATE.perSource * 100}% for each of the jira and slack slices, ${NL_ACTION_R2_EVAL_GATE.wrongTarget} wrong targets,
         ${NL_ACTION_R2_EVAL_GATE.negativeCaptures} negative captures, questions on positive references <= ${NL_ACTION_R2_EVAL_GATE.questionRateOnReferences * 100}%, calls over the bound <= ${NL_ACTION_R2_EVAL_GATE.overBoundRate * 100}%.

ADR-0121 S2 plan exactness (the agent planner prompt over agent-plan.v1.json plus every case above as one-step gold) has
its own CLI: pnpm eval:agent-plan -- --mode plan|run [...] (see agent-plan-eval-cli.ts).
`;

const OPTIONS = new Set([
  '--mode',
  '--model',
  '--entries',
  '--negatives',
  '--per-entry',
  '--runs',
  '--concurrency',
  '--timeout-ms',
  '--approved-plan-digest',
]);

export class UsageError extends Error {}

export type NlEvalMode = 'plan' | 'run' | 'action' | 'read-regression' | 'r2' | 'help';

export function parseArguments(argv: readonly string[]): { mode: NlEvalMode; options: Record<string, string> } {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return { mode: 'help', options: {} };
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index] as string;
    const value = tokens[index + 1];
    if (!OPTIONS.has(name)) throw new UsageError(`unknown option ${name}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    if (name in options) throw new UsageError(`${name} given more than once`);
    options[name] = value;
  }
  const mode = options['--mode'];
  if (mode === 'action' || mode === 'read-regression' || mode === 'r2') {
    for (const name of ['--entries', '--negatives', '--per-entry']) if (name in options) throw new UsageError(`${name} is not an option of --mode ${mode}`);
    return { mode, options };
  }
  if (mode !== 'plan' && mode !== 'run') throw new UsageError('--mode must be plan, run, action, read-regression or r2');
  if (mode === 'run' && options['--approved-plan-digest'] === undefined) throw new UsageError('run requires --approved-plan-digest');
  if (mode === 'plan' && options['--approved-plan-digest'] !== undefined) throw new UsageError('--approved-plan-digest is only for run');
  return { mode, options };
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError('a numeric option is not a non-negative integer');
  return Number(value);
}

export function planOptions(
  options: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): NlEvalPlanOptions {
  const negatives = options['--negatives'] ?? 'true';
  if (negatives !== 'true' && negatives !== 'false') throw new UsageError('--negatives must be true or false');
  const flag = options['--timeout-ms'];
  let timeoutMs: number | undefined;
  if (flag !== undefined) {
    timeoutMs = parseNlIntentTimeoutMs(flag);
    if (timeoutMs === undefined) throw new UsageError('--timeout-ms must be a whole number of milliseconds from 2000 to 8000');
  } else if (env.QUOKY_NL_INTENT_TIMEOUT_MS !== undefined) {
    timeoutMs = parseNlIntentTimeoutMs(env.QUOKY_NL_INTENT_TIMEOUT_MS);
  }
  return {
    timeoutMs,
    model: options['--model'] ?? DEFAULT_CLAUDE_INTENT_SELECTION_MODEL,
    entries: (options['--entries'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    includeNegatives: negatives === 'true',
    perEntry: integer(options['--per-entry'], 0),
    runs: integer(options['--runs'], 1),
    concurrency: integer(options['--concurrency'], 4),
  };
}

export interface CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => string;
  /** The git revision bound into the R2 digest (default: `git rev-parse HEAD`). */
  readonly gitHead?: () => string;
  readonly loadCorpus: () => { corpus: NlEvalCorpus; sha256: string };
  readonly writeReport: (fileName: string, contents: string) => string;
  /** Constructed only by `run`, only after the digest matched. */
  readonly createProvider: (model: string) => AiProvider;
  /** The outage guard's canary (one tiny call through the same provider); tests inject it, production calls the provider. */
  readonly canary?: (provider: AiProvider) => Promise<CanaryResult>;
}

const repoRoot = resolve(__dirname, '../../../..');

export function defaultDeps(): CliDeps {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date().toISOString(),
    loadCorpus: () => loadCorpus(),
    writeReport: (fileName, contents) => {
      const dir = resolve(repoRoot, 'data/eval');
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, fileName);
      writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
      return path;
    },
    createProvider: (model) => new ClaudeCliProvider('claude', { intentSelectionModel: model }),
  };
}

export function formatSummary(summary: NlEvalSummary): string[] {
  const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
  return [
    `overall: ${summary.hits}/${summary.positives} (${pct(summary.overall)})  wrong captures: ${summary.wrongCaptures}/${summary.negatives}  help captures: ${summary.helpCaptures} (allowed ${summary.helpAllowance} = ceil(1% of ${summary.negatives}))` +
      `  clarifications: ${summary.clarifications}  timeouts (> ${summary.latency.boundMs / 1000} s, counted as misses): ${summary.timeouts}  errors: ${summary.errors}`,
    ...(summary.clarifyGolds.total > 0 ? [`clarification golds asked: ${summary.clarifyGolds.asked}/${summary.clarifyGolds.total} (reported, not gated)`] : []),
    ...(summary.defaulted > 0 ? [`ungrounded values set back to the previous value or default: ${summary.defaulted} (reported, not gated)`] : []),
    ...Object.entries(summary.perEntry)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([entry, slot]) => `  ${entry.padEnd(20)} ${slot.hits}/${slot.total} (${pct(slot.rate)})`),
    `latency: p50 ${summary.latency.p50} ms, p95 ${summary.latency.p95} ms, max ${summary.latency.max} ms, over ${summary.latency.boundMs / 1000} s: ${summary.latency.overRuntimeBound}`,
    `gate (>= 95% overall, >= 90% per entry, 0 data-read wrong captures, help captures <= ${summary.helpAllowance} = ceil(1% of ${summary.negatives} negatives)): ${summary.gatePassed ? 'PASSED' : 'FAILED'}`,
    `S1 gate (the gate above and <= 1% of calls over the ${summary.latency.boundMs / 1000} s bound: ${pct(summary.overBoundRate)}): ${summary.s1GatePassed ? 'PASSED' : 'FAILED'}`,
    ...(summary.grammarSubset !== undefined
      ? [
          `grammar-handled subset (Phase C adds the selector here): ${summary.grammarSubset.hits}/${summary.grammarSubset.positives} (${pct(summary.grammarSubset.overall)})` +
            `  wrong: ${summary.grammarSubset.wrongCaptures}  clarifications: ${summary.grammarSubset.clarifications}  timeouts: ${summary.grammarSubset.timeouts}` +
            `  added latency p50 ${summary.grammarSubset.latency.p50} ms, p95 ${summary.grammarSubset.latency.p95} ms, max ${summary.grammarSubset.latency.max} ms`,
        ]
      : []),
  ];
}

function describeMiss(record: NlEvalRecord): string {
  const raw = record.outcome === 'clarify' || record.outcome === 'error' ? ` raw=${(record.raw ?? '').replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `  ${record.outcome.padEnd(13)} ${record.id} want ${record.expected} got ${record.got ?? '-'} ${record.gotArgs ? JSON.stringify(record.gotArgs) : ''}${record.error ? ` (${record.error})` : ''}${raw}`;
}

/**
 * The multi-run gate line of every eval:nl mode: PASSED only when every run passed, otherwise how many of the runs passed
 * (the v48 gate printed "FAILED in every one of 3 run(s)" with two runs passing).
 */
export function formatGateRuns(label: string, summaries: ReadonlyArray<{ readonly gatePassed: boolean }>, outageNote?: string): string {
  const passed = summaries.filter((summary) => summary.gatePassed).length;
  const total = summaries.length;
  return passed === total ? `${label}: PASSED in all ${total} run(s)` : `${label}: FAILED, passed ${passed} of ${total} run(s) (the gate needs every run)${outageNote !== undefined ? ` ${outageNote}` : ''}`;
}

/**
 * C1 of the CA review: an INVALID run never hides a hard failure already observed among the answered records. Returns the
 * note for the FAILED gate line when the outage was also seen, or undefined when the run is valid.
 */
function outageNoteOf(outage: ReturnType<GuardedProvider['report']>): string | undefined {
  return outage.invalidReason !== undefined ? outageAlsoSeenNote(outage.invalidReason) : undefined;
}

export async function runCli(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  let options: NlEvalPlanOptions;
  try {
    parsed = parseArguments(argv);
    if (parsed.mode === 'help') {
      deps.stdout(HELP);
      return EXIT_OK;
    }
    if (parsed.mode === 'action' || parsed.mode === 'read-regression' || parsed.mode === 'r2') return await runActionCli(parsed.mode, parsed.options, deps);
    options = planOptions(parsed.options);
  } catch (error) {
    deps.stderr(error instanceof UsageError ? error.message : 'invalid arguments');
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  const { corpus, sha256 } = deps.loadCorpus();
  let plan: ReturnType<typeof buildPlan>;
  try {
    plan = buildPlan(corpus, sha256, options);
  } catch (error) {
    deps.stderr(`invalid plan: ${error instanceof Error ? error.message : 'unknown'}`);
    return EXIT_USAGE;
  }
  const digest = computePlanDigest(plan);
  if (parsed.mode === 'plan') {
    deps.stdout(JSON.stringify({ ...plan, caseIds: `${plan.caseIds.length} cases` }, null, 2));
    deps.stdout(`plan digest (sha256): ${digest}`);
    deps.stdout(CANARY_PLAN_LINE);
    deps.stdout(formatSideScore('grammar side (offline, the Class B grammars on their own hits)', scoreGrammarSide(corpus, deps.now())));
    deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
    return EXIT_OK;
  }
  if (parsed.options['--approved-plan-digest'] !== digest) {
    deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
    return EXIT_BLOCKED;
  }
  const provider = deps.createProvider(plan.model);
  if (!(await provider.isAvailable().catch(() => false))) {
    deps.stderr('BLOCKED: the Claude CLI is not available; nothing was executed');
    return EXIT_BLOCKED;
  }
  const guard = guardRunProvider(provider, deps.stderr, { concurrency: plan.concurrency, maxCalls: plan.caseIds.length * plan.runs, ...(deps.canary !== undefined ? { canary: deps.canary } : {}) });
  const startedAt = deps.now();
  let done = 0;
  const total = plan.caseIds.length * plan.runs;
  const records = await runEvaluation({
    corpus,
    plan,
    provider: guard.provider,
    now: deps.now,
    onRecord: () => {
      done += 1;
      if (done % 50 === 0) deps.stderr(`… ${done}/${total}`);
    },
  });
  const grammarCaseIds = new Set(corpus.cases.filter((golden) => golden.grammar !== undefined).map((golden) => golden.id));
  await guard.settle();
  const outage = guard.report();
  const reportName = `nl-intent-${startedAt.replace(/[:.]/g, '-')}-${plan.model.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
  const clarifyCaseIds = clarifyCaseIdsOf(corpus);
  const summaries = Array.from({ length: plan.runs }, (_, index) => summarize(records.filter((record) => record.run === index + 1), plan.callTimeoutMs, grammarCaseIds, clarifyCaseIds));
  const hard = sumHardFailures(summaries, ['wrongCaptures', 'helpOverAllowance']);
  if (outage.invalidReason !== undefined && hardFailureTotal(hard) === 0) return finishInvalid(deps, 'intent gate', plan.runs, outage, reportName, { plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), records }, hard);
  for (const [index, summary] of summaries.entries()) {
    deps.stdout(`run ${index + 1}/${plan.runs} (${plan.model}, ${plan.promptVersion}):`);
    for (const line of formatSummary(summary)) deps.stdout(line);
  }
  deps.stdout(formatSideScore('grammar side (the Class B grammars on their own hits)', scoreGrammarSide(corpus, startedAt)));
  for (let run = 1; run <= plan.runs; run += 1) {
    deps.stdout(formatSideScore(`selector side, run ${run} (same cases)`, scoreSelectorSide(corpus, records.filter((record) => record.run === run), startedAt)));
  }
  // Owner answer 1 (2026-10-22): the jira.release hits by the same final outcome in the snapshot Jira world (ids only).
  const equivalent = records.filter((record) => record.equivalent === true);
  if (equivalent.length > 0) deps.stdout(`jira.release hits by equal Core outcome (snapshot world): ${equivalent.length} (${[...new Set(equivalent.map((record) => record.id))].join(', ')})`);
  const misses = records.filter((record) => record.outcome !== 'hit' && record.outcome !== 'none');
  if (misses.length > 0) {
    deps.stdout(`not hit (${misses.length}):`);
    for (const record of misses) deps.stdout(describeMiss(record));
  }
  deps.stdout(formatProviderOutcomes(outage));
  deps.stdout(formatGateRuns('intent gate', summaries, outageNoteOf(outage)));
  const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), summaries, providerOutcomes: outage, records }, null, 2)}\n`);
  deps.stdout(`results written to ${path}`);
  return summaries.every((summary) => summary.gatePassed) ? EXIT_OK : EXIT_GATE_FAILED;
}

/** Optional collaborators of the A6 modes (tests inject them; production reads the corpora from the repository). */
export interface ActionCliDeps {
  readonly loadActionCorpus?: typeof loadActionCorpus;
  readonly loadR2ActionCorpus?: typeof loadR2ActionCorpus;
  readonly loadReadRegressionCorpus?: typeof loadReadRegressionCorpus;
}

/** `--mode action` / `--mode read-regression` (ADR-0120 amendment A6-D7). */
export async function runActionCli(mode: 'action' | 'read-regression' | 'r2', options: Readonly<Record<string, string>>, deps: CliDeps & ActionCliDeps): Promise<number> {
  const flag = options['--timeout-ms'];
  const timeoutMs = flag === undefined ? undefined : parseNlIntentTimeoutMs(flag);
  if (flag !== undefined && timeoutMs === undefined) throw new UsageError('--timeout-ms must be a whole number of milliseconds from 2000 to 8000');
  const settings = {
    model: options['--model'] ?? DEFAULT_CLAUDE_INTENT_SELECTION_MODEL,
    runs: integer(options['--runs'], 1),
    concurrency: integer(options['--concurrency'], 4),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  const approved = options['--approved-plan-digest'];
  if (mode === 'r2') return await runR2Cli(settings, approved, deps);
  if (mode === 'action') {
    const { corpus, sha256, files } = (deps.loadActionCorpus ?? loadActionCorpus)();
    const problems = validateActionCorpus(corpus);
    deps.stdout(`action corpus: ${corpus.cases.length} cases from ${files.length} file(s); schema problems: ${problems.length}`);
    for (const problem of problems.slice(0, 50)) deps.stdout(`  ${problem}`);
    if (problems.length > 0) return EXIT_GATE_FAILED;
    let plan: ReturnType<typeof buildActionPlan>;
    try {
      plan = buildActionPlan('nl-action-eval', corpus.cases.map((golden) => golden.id), sha256, settings);
    } catch (error) {
      deps.stderr(`invalid plan: ${error instanceof Error ? error.message : 'unknown'}`);
      return EXIT_USAGE;
    }
    const digest = computeActionPlanDigest(plan);
    if (approved === undefined) {
      deps.stdout(JSON.stringify({ ...plan, caseIds: `${plan.caseIds.length} cases` }, null, 2));
      deps.stdout(`plan digest (sha256): ${digest}`);
      deps.stdout(CANARY_PLAN_LINE);
      for (const [entry, side] of Object.entries(scoreActionGrammarSide(corpus, deps.now()))) {
        deps.stdout(`  grammar side ${entry.padEnd(16)} ${entry === 'none' ? 'acted on' : 'claimed'} ${side.claimed}/${side.total}`);
      }
      deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
      return EXIT_OK;
    }
    if (approved !== digest) {
      deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
      return EXIT_BLOCKED;
    }
    const provider = deps.createProvider(plan.model);
    if (!(await provider.isAvailable().catch(() => false))) {
      deps.stderr('BLOCKED: the Claude CLI is not available; nothing was executed');
      return EXIT_BLOCKED;
    }
    const guard = guardRunProvider(provider, deps.stderr, { concurrency: plan.concurrency, maxCalls: corpus.cases.length * plan.runs, ...(deps.canary !== undefined ? { canary: deps.canary } : {}) });
    const startedAt = deps.now();
    const records = await runActionEvaluation({ corpus, plan, provider: guard.provider, now: deps.now });
    await guard.settle();
    const outage = guard.report();
    const reportName = `nl-action-${startedAt.replace(/[:.]/g, '-')}.json`;
    const summaries = Array.from({ length: plan.runs }, (_, index) => summarizeAction(records.filter((record) => record.run === index + 1), plan.callTimeoutMs));
    const hard = sumHardFailures(summaries, ['wrongTargets', 'negativeCaptures']);
    if (outage.invalidReason !== undefined && hardFailureTotal(hard) === 0) return finishInvalid(deps, `action gate (${plan.promptVersion})`, plan.runs, outage, reportName, { plan: { ...plan, digest }, startedAt, records }, hard);
    for (const [index, summary] of summaries.entries()) deps.stdout(`run ${index + 1}/${plan.runs}: ${JSON.stringify(summary)}`);
    deps.stdout(formatProviderOutcomes(outage));
    deps.stdout(formatGateRuns(`action gate (${plan.promptVersion})`, summaries, outageNoteOf(outage)));
    const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, summaries, providerOutcomes: outage, records }, null, 2)}\n`);
    deps.stdout(`results written to ${path}`);
    return summaries.every((summary) => summary.gatePassed) ? EXIT_OK : EXIT_GATE_FAILED;
  }
  const { cases, sha256 } = (deps.loadReadRegressionCorpus ?? loadReadRegressionCorpus)();
  let plan: ReturnType<typeof buildActionPlan>;
  try {
    plan = buildActionPlan('nl-read-regression', cases.map((golden) => golden.id), sha256, settings);
  } catch (error) {
    deps.stderr(`invalid plan: ${error instanceof Error ? error.message : 'unknown'}`);
    return EXIT_USAGE;
  }
  const digest = computeActionPlanDigest(plan);
  const relabeled = cases.filter((golden) => golden.a6Relabel !== undefined).length;
  if (approved === undefined) {
    deps.stdout(JSON.stringify({ ...plan, caseIds: `${plan.caseIds.length} cases (${relabeled} owner-relabelled)` }, null, 2));
    deps.stdout(`plan digest (sha256): ${digest}`);
    deps.stdout(CANARY_PLAN_LINE);
    deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
    return EXIT_OK;
  }
  if (approved !== digest) {
    deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
    return EXIT_BLOCKED;
  }
  const provider = deps.createProvider(plan.model);
  if (!(await provider.isAvailable().catch(() => false))) {
    deps.stderr('BLOCKED: the Claude CLI is not available; nothing was executed');
    return EXIT_BLOCKED;
  }
  const guard = guardRunProvider(provider, deps.stderr, { concurrency: plan.concurrency, maxCalls: cases.length * plan.runs, ...(deps.canary !== undefined ? { canary: deps.canary } : {}) });
  const startedAt = deps.now();
  const records = await runReadRegression({ cases, plan, provider: guard.provider, now: deps.now });
  await guard.settle();
  const outage = guard.report();
  const reportName = `nl-read-regression-${startedAt.replace(/[:.]/g, '-')}.json`;
  const goldOf = (id: string): string => {
    const golden = cases.find((candidate) => candidate.id === id);
    if (golden?.expectAnswer !== undefined && golden.a6Relabel === undefined) return NL_EVAL_OPEN_QUESTION_LABEL;
    const expect = golden?.a6Relabel ?? golden?.expect;
    return expect === undefined || expect === 'none' ? 'none' : expect.entryId;
  };
  const summaries = Array.from({ length: plan.runs }, (_, index) => summarizeReadRegression(records.filter((record) => record.run === index + 1), goldOf));
  const hard = sumHardFailures(summaries, ['wrongCaptures', 'helpOverAllowance', 'actionCaptures']);
  if (outage.invalidReason !== undefined && hardFailureTotal(hard) === 0) return finishInvalid(deps, `read-regression gate (${plan.promptVersion})`, plan.runs, outage, reportName, { plan: { ...plan, digest }, startedAt, records }, hard);
  for (const [index, summary] of summaries.entries()) deps.stdout(`run ${index + 1}/${plan.runs}: ${JSON.stringify(summary)}`);
  deps.stdout(formatProviderOutcomes(outage));
  deps.stdout(formatGateRuns(`read-regression gate (${plan.promptVersion})`, summaries, outageNoteOf(outage)));
  const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, summaries, providerOutcomes: outage, records }, null, 2)}\n`);
  deps.stdout(`results written to ${path}`);
  return summaries.every((summary) => summary.gatePassed) ? EXIT_OK : EXIT_GATE_FAILED;
}

/**
 * An invalidated run (every eval:nl mode): the INVALID verdict and the counts, a content-free report carrying the verdict
 * and the records (no summaries, no gate), exit 5.
 */
function finishInvalid(
  deps: CliDeps,
  gateLabel: string,
  runs: number,
  outage: ReturnType<GuardedProvider['report']>,
  reportName: string,
  body: Record<string, unknown>,
  hardFailures: HardFailureCounts,
): number {
  printInvalidRun(deps.stdout, gateLabel, runs, outage, hardFailures);
  const path = deps.writeReport(reportName, `${JSON.stringify({ ...body, verdict: invalidVerdict(outage.invalidReason ?? 'error'), hardFailures, providerOutcomes: outage }, null, 2)}\n`);
  deps.stdout(`results written to ${path}`);
  return EXIT_INVALID;
}

/** `--mode r2` (A6 R2): the agent-drafted, owner-approved R2 corpus through the real selector with R2 offered. */
async function runR2Cli(settings: { model: string; runs: number; concurrency: number; timeoutMs?: number }, approved: string | undefined, deps: CliDeps & ActionCliDeps): Promise<number> {
  const { corpus, sha256, files } = (deps.loadR2ActionCorpus ?? loadR2ActionCorpus)();
  const problems = validateActionCorpus(corpus, NL_ACTION_R2_EVAL_ENTRIES);
  deps.stdout(`R2 corpus: ${corpus.cases.length} cases from ${files.length} file(s); schema problems: ${problems.length}`);
  for (const problem of problems.slice(0, 50)) deps.stdout(`  ${problem}`);
  if (problems.length > 0 || corpus.cases.length === 0) return EXIT_GATE_FAILED;
  let plan: ReturnType<typeof buildActionPlan>;
  try {
    plan = buildActionPlan('nl-action-r2-eval', corpus.cases.map((golden) => golden.id), sha256, { ...settings, gitHead: (deps.gitHead ?? defaultGitHead)() });
  } catch (error) {
    deps.stderr(`invalid plan: ${error instanceof Error ? error.message : 'unknown'}`);
    return EXIT_USAGE;
  }
  const digest = computeActionPlanDigest(plan);
  if (approved === undefined) {
    deps.stdout(JSON.stringify({ ...plan, caseIds: `${plan.caseIds.length} cases` }, null, 2));
    deps.stdout(`plan digest (sha256): ${digest}`);
    deps.stdout(CANARY_PLAN_LINE);
    deps.stdout(`model calls this plan authorises: at most ${plan.calls} (${plan.caseIds.length} cases x ${plan.runs} run(s), one selector call each; a case a deterministic veto settles makes none; no summarisation call)`);
    for (const [entry, side] of Object.entries(scoreActionGrammarSide(corpus, deps.now()))) {
      deps.stdout(`  grammar side ${entry.padEnd(16)} ${entry === 'none' ? 'acted on' : 'claimed'} ${side.claimed}/${side.total}`);
    }
    deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
    return EXIT_OK;
  }
  if (approved !== digest) {
    deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
    return EXIT_BLOCKED;
  }
  const provider = deps.createProvider(plan.model);
  if (!(await provider.isAvailable().catch(() => false))) {
    deps.stderr('BLOCKED: the Claude CLI is not available; nothing was executed');
    return EXIT_BLOCKED;
  }
  const guard = guardRunProvider(provider, deps.stderr, { concurrency: plan.concurrency, maxCalls: corpus.cases.length * plan.runs, ...(deps.canary !== undefined ? { canary: deps.canary } : {}) });
  const startedAt = deps.now();
  const records = await runActionEvaluation({ corpus, plan, provider: guard.provider, now: deps.now });
  await guard.settle();
  const outage = guard.report();
  const reportName = `nl-action-r2-${startedAt.replace(/[:.]/g, '-')}.json`;
  const summaries = Array.from({ length: plan.runs }, (_, index) => summarizeActionR2(records.filter((record) => record.run === index + 1), corpus, plan.callTimeoutMs));
  const hard = sumHardFailures(summaries, ['wrongTargets', 'negativeCaptures']);
  if (outage.invalidReason !== undefined && hardFailureTotal(hard) === 0) return finishInvalid(deps, `R2 gate (${plan.promptVersion})`, plan.runs, outage, reportName, { plan: { ...plan, digest }, startedAt, records }, hard);
  for (const [index, summary] of summaries.entries()) deps.stdout(`run ${index + 1}/${plan.runs}: ${JSON.stringify(summary)}`);
  deps.stdout(formatProviderOutcomes(outage));
  deps.stdout(formatGateRuns(`R2 gate (${plan.promptVersion})`, summaries, outageNoteOf(outage)));
  // Content-free: ids, outcomes, entries and reasons only (never an owner text or a raw model answer).
  const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, summaries, providerOutcomes: outage, records }, null, 2)}\n`);
  deps.stdout(`results written to ${path}`);
  return summaries.every((summary) => summary.gatePassed) ? EXIT_OK : EXIT_GATE_FAILED;
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_GATE_FAILED;
    },
  );
}
