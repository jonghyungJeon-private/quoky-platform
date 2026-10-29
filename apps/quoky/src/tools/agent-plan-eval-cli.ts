/**
 * ADR-0121 D11 plan-exactness evaluation CLI (stage S2 P2):
 *
 *   pnpm eval:agent-plan -- --mode plan [--model haiku] [--effort high] [--runs N] [--concurrency N] [--timeout-ms N] [--include-pending]
 *   pnpm eval:agent-plan -- --mode run  <the same options> --approved-plan-digest <sha256 from plan>
 *
 * `plan` is offline: it checks the corpus (`golden/agent-plan.v1.json` with every `nl-intent.v1.json` case as one-step
 * gold), prints the plan, its digest (the corpus and one-step corpus sha256, the prompt version and sha256, git HEAD,
 * model, runs, concurrency, timeout, the case list) and the call bound; nothing is constructed or spawned. `run` is
 * Strict (each run needs the owner's approval of the digest): it exits 3 BEFORE any provider is constructed unless
 * `--approved-plan-digest` is given and equals the recomputed digest. It then runs the planner prompt through the local
 * Claude CLI (`INTENT_SELECTION`, the selection model, no tools) behind a hard call cap equal to the bound it printed,
 * scores every answer with Core's parse and validator (`agent-plan-eval.ts`), prints the report and writes a
 * content-free `data/eval/agent-plan-<ts>.json`. Exit 0 only when the gate passes in every run.
 *
 * Only owner-approved cases are scored unless `--include-pending` is given (the flag is part of the digest). Such a run
 * is NON-GATING: it prints the numbers and never a gate verdict, and exits 4.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLAUDE_EFFORT_LEVEL_NAMES, ClaudeCliProvider, DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY, DEFAULT_CLAUDE_INTENT_SELECTION_MODEL, type ClaudeEffortLevel } from '@quoky/ai-cli';
import { Capability, type AiProvider } from '@quoky/core';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import {
  AGENT_PLAN_EVAL_DEFAULT_TIMEOUT_MS,
  AGENT_PLAN_EVAL_GATE,
  agentPlanEvalCases,
  agentPlanPooledGate,
  buildAgentPlanEvalPlan,
  computeAgentPlanEvalDigest,
  loadAgentPlanCorpus,
  runAgentPlanEvaluation,
  summarizeAgentPlanRun,
  validateAgentPlanCorpus,
  type AgentPlanEvalCase,
  type AgentPlanEvalPlan,
  type AgentPlanEvalRecord,
  type AgentPlanEvalSummary,
  type AgentPlanPooledGate,
} from './agent-plan-eval';
import { guardRunProvider, sumHardFailures } from './nl-intent-eval-cli';
import { CANARY_CLAUSE, type CanaryResult, EXIT_INVALID_PROVIDER, formatProviderOutcomes, hardFailureTotal, invalidVerdict, outageAlsoSeenNote, printInvalidRun } from './eval-provider-guard';
import { gitHead as defaultGitHead } from './nl-r2-prompt-binding';

export const EXIT_OK = 0;
/** The gate failed (or the corpus check found a problem). */
export const EXIT_GATE_FAILED = 1;
export const EXIT_USAGE = 2;
/** Strict gate refused (digest missing or mismatched, provider unavailable); nothing was spawned. */
export const EXIT_BLOCKED = 3;
/** An `--include-pending` run completed: numbers only, never a gate verdict. */
export const EXIT_NON_GATING = 4;
/** The provider was unavailable for too many calls (usage/session limit, outage): INVALID, never PASSED or FAILED. */
export const EXIT_INVALID = EXIT_INVALID_PROVIDER;

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const HELP = `Agent plan exactness evaluation (ADR-0121 D11, stage S2 P2)

Offline:  pnpm eval:agent-plan -- --mode plan [options]
Strict:   pnpm eval:agent-plan -- --mode run [options] --approved-plan-digest <sha256 from plan>

Options: --model <claude model alias, default ${DEFAULT_CLAUDE_INTENT_SELECTION_MODEL}>  --effort <${CLAUDE_EFFORT_LEVEL_NAMES.join('|')}, default the adapter's selection effort ${DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY[Capability.INTENT_SELECTION] ?? 'low'}; bound into the digest>
         --runs <1-5, default 1>  --concurrency <1-8, default 4>
         --timeout-ms <2000-10000, default ${AGENT_PLAN_EVAL_DEFAULT_TIMEOUT_MS}: the per-call bound>
         --include-pending  also score the cases pending the owner's approval (changes the digest)
Gate:            >= ${AGENT_PLAN_EVAL_GATE.multiStepExact * 100}% exact over the multi-step positives POOLED over all runs (owner decision 2026-10-26), AND in every run:
                 >= ${AGENT_PLAN_EVAL_GATE.oneStepExact * 100}% over the one-step positives
                 (same ordered step sequence), ${AGENT_PLAN_EVAL_GATE.wrongOnNegatives} wrong on negatives other than help.topic-only plans,
                 help.topic-only plans on negatives <= ceil(1% of the negatives) (owner decision 2026-10-26), <= ${AGENT_PLAN_EVAL_GATE.overBoundRate * 100}% of calls over the bound,
                 no call refused by the hard cap. --include-pending runs, and runs with --runs other than ${AGENT_PLAN_EVAL_GATE.runs}, are NON-GATING (exit 4, no verdict).
Provider outage: 5 provider failures in a row, 10 timeouts in a row, or provider failures above 5% of the calls stop
                 further calls; the run is INVALID (provider unavailable: <reason>), exit 5, never PASSED or FAILED.
`;

const VALUE_OPTIONS = new Set(['--mode', '--model', '--effort', '--runs', '--concurrency', '--timeout-ms', '--approved-plan-digest']);
const FLAG_OPTIONS = new Set(['--include-pending']);

export class UsageError extends Error {}

export function parseArguments(argv: readonly string[]): { mode: 'plan' | 'run' | 'help'; options: Record<string, string>; includePending: boolean } {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return { mode: 'help', options: {}, includePending: false };
  const options: Record<string, string> = {};
  let includePending = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index] as string;
    if (FLAG_OPTIONS.has(name)) {
      if (includePending) throw new UsageError(`${name} given more than once`);
      includePending = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option ${name}`);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    if (name in options) throw new UsageError(`${name} given more than once`);
    options[name] = value;
    index += 1;
  }
  const mode = options['--mode'];
  if (mode !== 'plan' && mode !== 'run') throw new UsageError('--mode must be plan or run');
  if (mode === 'plan' && options['--approved-plan-digest'] !== undefined) throw new UsageError('--approved-plan-digest is only for run');
  return { mode, options, includePending };
}

/** Owner decision of 2026-10-28: the planner's effort, `--effort`, default the adapter's selection effort; a usage error otherwise. */
function plannerEffort(value: string | undefined): string {
  const effort = value ?? DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY[Capability.INTENT_SELECTION] ?? 'low';
  if (!(CLAUDE_EFFORT_LEVEL_NAMES as readonly string[]).includes(effort)) throw new UsageError(`--effort must be one of ${CLAUDE_EFFORT_LEVEL_NAMES.join(', ')}`);
  return effort;
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError('a numeric option is not a non-negative integer');
  return Number(value);
}

export interface AgentPlanCliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => string;
  readonly gitHead: () => string;
  readonly load: typeof loadAgentPlanCorpus;
  readonly writeReport: (fileName: string, contents: string) => string;
  /** Constructed only by `run`, only after the digest matched. */
  readonly createProvider: (model: string, effort?: string) => AiProvider;
  /** The outage guard's canary (one tiny call through the same provider); tests inject it. */
  readonly canary?: (provider: AiProvider) => Promise<CanaryResult>;
  /** Tests only: monotonic milliseconds for the latency of each call. */
  readonly elapsed?: () => number;
}

const repoRoot = resolve(__dirname, '../../../..');

export function defaultDeps(): AgentPlanCliDeps {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date().toISOString(),
    gitHead: defaultGitHead,
    load: loadAgentPlanCorpus,
    writeReport: (fileName, contents) => {
      const dir = resolve(repoRoot, 'data/eval');
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, fileName);
      writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
      return path;
    },
    createProvider: (model, effort) =>
      new ClaudeCliProvider('claude', { intentSelectionModel: model, ...(effort !== undefined ? { effortByCapability: { [Capability.INTENT_SELECTION]: effort as ClaudeEffortLevel } } : {}) }),
  };
}

/** The report lines of one run (content-free: counts, rates, families and closed entry ids). */
export function formatAgentPlanSummary(summary: AgentPlanEvalSummary): string[] {
  const lines = [
    `multi-step exact: ${summary.groups.multiStep.exact}/${summary.groups.multiStep.total} (${pct(summary.groups.multiStep.rate)})  one-step exact: ${summary.groups.oneStep.exact}/${summary.groups.oneStep.total} (${pct(summary.groups.oneStep.rate)})  ask: ${summary.groups.ask.exact}/${summary.groups.ask.total}`,
    `exact plans: ${summary.exact}/${summary.positives} (${pct(summary.exactRate)})  wrong on negatives: ${summary.wrongOnNegatives}/${summary.negatives}  help captures: ${summary.helpCaptures} (allowed ${summary.helpAllowance} = ceil(1% of ${summary.negatives}))  clarification golds asked: ${summary.clarifyGolds.asked}/${summary.clarifyGolds.total}` +
      `  calls: ${summary.calls}  over the ${summary.latency.boundMs / 1000} s bound: ${summary.latency.overBound} (${pct(summary.overBoundRate)})  capped: ${summary.capped}`,
    `outcomes: ${Object.entries(summary.outcomes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([outcome, count]) => `${outcome} ${count}`).join(', ')}`,
    'per family (positives exact / negatives wrong):',
    ...Object.entries(summary.perFamily)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([family, slot]) => `  ${family.padEnd(22)} ${slot.positives > 0 ? `${slot.exact}/${slot.positives} (${pct(slot.rate)})` : '-'.padEnd(6)}  ${slot.negatives > 0 ? `wrong ${slot.wrong}/${slot.negatives}` : ''}`.trimEnd()),
    'per entry (positives holding it, exact):',
    ...Object.entries(summary.perEntry)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([entry, slot]) => `  ${entry.padEnd(22)} ${slot.exact}/${slot.total} (${pct(slot.rate)})`),
    `latency: p50 ${summary.latency.p50} ms, p95 ${summary.latency.p95} ms, max ${summary.latency.max} ms`,
    summary.gating
      ? `run checks (one-step >= ${AGENT_PLAN_EVAL_GATE.oneStepExact * 100}% exact, 0 wrong on negatives, help captures <= ${summary.helpAllowance} = ceil(1% of ${summary.negatives} negatives), <= ${AGENT_PLAN_EVAL_GATE.overBoundRate * 100}% over the bound, no capped call; multi-step is pooled): ${summary.gatePassed ? 'PASSED' : 'FAILED'}`
      : 'gate: NON-GATING (--include-pending, or not 3 runs)',
  ];
  return lines;
}

function describeMiss(record: AgentPlanEvalRecord): string {
  const detail = [
    record.gotEntries !== undefined ? `got ${record.gotEntries.join('+')}` : undefined,
    record.reason !== undefined ? `reason ${record.reason}${record.failedStep !== undefined ? `@${record.failedStep}` : ''}` : undefined,
    record.diff !== undefined ? `diff ${record.diff}${record.diffStep !== undefined ? `@${record.diffStep}` : ''}${record.diffArgs !== undefined ? `(${record.diffArgs.join(',')})` : ''}${record.summaryDiff !== undefined ? ` summary-${record.summaryDiff}` : ''}` : undefined,
    record.gotSummaries !== undefined && record.outcome !== 'exact' ? `summaries ${record.gotSummaries.join(' ')}` : undefined,
    record.error !== undefined ? `error ${record.error}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `  run ${record.run} ${record.outcome.padEnd(9)} ${record.id} (${record.family}) want ${record.expected === 'plan' ? record.goldEntries.join('+') : record.expected} ${detail.join(' ')}`.trimEnd();
}

export async function runCli(argv: readonly string[], deps: AgentPlanCliDeps = defaultDeps()): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  let plan: AgentPlanEvalPlan;
  let cases: AgentPlanEvalCase[];
  try {
    parsed = parseArguments(argv);
    if (parsed.mode === 'help') {
      deps.stdout(HELP);
      return EXIT_OK;
    }
    const flag = parsed.options['--timeout-ms'];
    const timeoutMs = flag === undefined ? undefined : parseNlIntentTimeoutMs(flag);
    if (flag !== undefined && timeoutMs === undefined) throw new UsageError('--timeout-ms must be a whole number of milliseconds from 2000 to 10000');
    const loaded = deps.load();
    const problems = validateAgentPlanCorpus(loaded.corpus, loaded.oneStep);
    cases = agentPlanEvalCases(loaded.corpus, loaded.oneStep);
    const pending = cases.filter((golden) => golden.status !== 'approved').length;
    deps.stdout(`agent-plan corpus: ${cases.length} cases (${loaded.corpus.oneStep.count} one-step from ${loaded.corpus.oneStep.corpus}, ${loaded.corpus.cases.length} new; ${pending} pending the owner's approval); schema problems: ${problems.length}`);
    for (const problem of problems.slice(0, 50)) deps.stdout(`  ${problem}`);
    if (problems.length > 0) return EXIT_GATE_FAILED;
    plan = buildAgentPlanEvalPlan(cases, { corpusSha256: loaded.sha256, oneStepCorpusSha256: loaded.oneStepSha256 }, loaded.corpus.fixture, {
      model: parsed.options['--model'] ?? DEFAULT_CLAUDE_INTENT_SELECTION_MODEL,
      effort: plannerEffort(parsed.options['--effort']),
      runs: integer(parsed.options['--runs'], 1),
      concurrency: integer(parsed.options['--concurrency'], 4),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      includePending: parsed.includePending,
      gitHead: deps.gitHead(),
    });
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : 'invalid arguments');
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  const digest = computeAgentPlanEvalDigest(plan);
  if (parsed.mode === 'plan') {
    deps.stdout(JSON.stringify({ ...plan, caseIds: `${plan.caseIds.length} cases` }, null, 2));
    deps.stdout(`plan digest (sha256): ${digest}`);
    deps.stdout(`model calls this plan authorises: at most ${plan.maxCalls} ((${plan.caseIds.length} planner calls + up to ${plan.readWriteProbe.maxCallsPerRun} read + write probe calls, ${plan.readWriteProbe.promptVersion}) x ${plan.runs} run(s); a skipped input makes none); the run enforces it as a hard cap on the counted calls, plus ${CANARY_CLAUSE}`);
    deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
    return EXIT_OK;
  }
  const approved = parsed.options['--approved-plan-digest'];
  if (approved === undefined) {
    deps.stderr('BLOCKED: run requires --approved-plan-digest (the owner-approved digest from plan); nothing was executed');
    return EXIT_BLOCKED;
  }
  if (approved !== digest) {
    deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
    return EXIT_BLOCKED;
  }
  const provider = deps.createProvider(plan.model, plan.effort);
  if (!(await provider.isAvailable().catch(() => false))) {
    deps.stderr('BLOCKED: the Claude CLI is not available; nothing was executed');
    return EXIT_BLOCKED;
  }
  const guard = guardRunProvider(provider, deps.stderr, { concurrency: plan.concurrency, maxCalls: plan.maxCalls, ...(deps.canary !== undefined ? { canary: deps.canary } : {}) });
  const startedAt = deps.now();
  let done = 0;
  const total = plan.maxCalls;
  const records = await runAgentPlanEvaluation({
    cases,
    plan,
    provider: guard.provider,
    ...(deps.elapsed !== undefined ? { elapsed: deps.elapsed } : {}),
    onRecord: () => {
      done += 1;
      if (done % 50 === 0) deps.stderr(`… ${done}/${total}`);
    },
  });
  await guard.settle();
  const outage = guard.report();
  const reportName = `agent-plan-${startedAt.replace(/[:.]/g, '-')}-${plan.model.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
  const summaries = Array.from({ length: plan.runs }, (_, index) => summarizeAgentPlanRun(records.filter((record) => record.run === index + 1), plan.callTimeoutMs, { gating: plan.gating }));
  // C1 (CA review): an outage never hides a hard failure already observed among the answered calls.
  const hard = sumHardFailures(summaries, ['wrongOnNegatives', 'helpOverAllowance']);
  const hardSeen = plan.gating && hardFailureTotal(hard) > 0;
  if (outage.invalidReason !== undefined && !hardSeen) {
    printInvalidRun(deps.stdout, `agent-plan gate (${plan.promptVersion})`, plan.runs, outage, hard);
    const invalidPath = deps.writeReport(
      reportName,
      `${JSON.stringify({ plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), verdict: invalidVerdict(outage.invalidReason), hardFailures: hard, providerOutcomes: outage, records }, null, 2)}\n`,
    );
    deps.stdout(`results written to ${invalidPath}`);
    return EXIT_INVALID;
  }
  for (const [index, summary] of summaries.entries()) {
    deps.stdout(`run ${index + 1}/${plan.runs} (${plan.model}, ${plan.promptVersion}):`);
    for (const line of formatAgentPlanSummary(summary)) deps.stdout(line);
  }
  const misses = records.filter((record) => record.outcome !== 'exact' && record.outcome !== 'none');
  if (misses.length > 0) {
    deps.stdout(`not exact / not none (${misses.length}):`);
    for (const record of misses) deps.stdout(describeMiss(record));
  }
  deps.stdout(formatProviderOutcomes(outage));
  const pooled = agentPlanPooledGate(summaries);
  if (plan.gating) deps.stdout(formatAgentPlanPooledGate(`agent-plan gate (${plan.promptVersion})`, pooled, outage.invalidReason !== undefined ? outageAlsoSeenNote(outage.invalidReason) : undefined));
  else if (plan.includePending) deps.stdout(`agent-plan gate (${plan.promptVersion}): NON-GATING (--include-pending scores cases the owner has not approved; no verdict)`);
  else deps.stdout(`agent-plan gate (${plan.promptVersion}): NON-GATING (the gate needs exactly ${AGENT_PLAN_EVAL_GATE.runs} runs; this plan has ${plan.runs}; no verdict)`);
  // Content-free: ids, families, closed entry ids and reasons, diff kinds, latencies (never a text, an answer or a value).
  const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), summaries, ...(plan.gating ? { pooled } : {}), providerOutcomes: outage, records }, null, 2)}\n`);
  deps.stdout(`results written to ${path}`);
  if (!plan.gating) return EXIT_NON_GATING;
  return pooled.passed ? EXIT_OK : EXIT_GATE_FAILED;
}

/**
 * The gate line (owner decision of 2026-10-26): the pooled multi-step rate and the runs whose own checks passed. Content
 * free.
 */
export function formatAgentPlanPooledGate(label: string, pooled: AgentPlanPooledGate, outageNote?: string): string {
  const multi = `multi-step pooled ${pooled.multiStep.exact}/${pooled.multiStep.total} (${pct(pooled.multiStep.rate)}) ${pooled.multiStepPassed ? '>=' : '<'} ${AGENT_PLAN_EVAL_GATE.multiStepExact * 100}%`;
  const runs = `run checks passed in ${pooled.runsPassed} of ${pooled.runs} run(s)`;
  return pooled.passed ? `${label}: PASSED (${multi}; ${runs})` : `${label}: FAILED (${multi}; ${runs}; the gate needs both)${outageNote !== undefined ? ` ${outageNote}` : ''}`;
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
