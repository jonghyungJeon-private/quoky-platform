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
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudeCliProvider, DEFAULT_CLAUDE_INTENT_SELECTION_MODEL } from '@quoky/ai-cli';
import type { AiProvider } from '@quoky/core';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import {
  NL_EVAL_GATE,
  NL_EVAL_RUNTIME_TIMEOUT_MS,
  buildPlan,
  computePlanDigest,
  loadCorpus,
  runEvaluation,
  summarize,
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

const HELP = `Natural-language selection evaluation (ADR-0120 D12)

Offline:  pnpm eval:nl -- --mode plan [options]
Strict:   pnpm eval:nl -- --mode run [options] --approved-plan-digest <sha256 from plan>

Options: --model <claude model alias, default ${DEFAULT_CLAUDE_INTENT_SELECTION_MODEL}>  --entries <id,id,...>  --negatives true|false (default true)
         --per-entry <N, 0 = all>  --runs <1-5, default 1>  --concurrency <1-8, default 4>
         --timeout-ms <2000-8000, default QUOKY_NL_INTENT_TIMEOUT_MS if valid, else ${NL_EVAL_RUNTIME_TIMEOUT_MS}>
Gate: >= ${NL_EVAL_GATE.overall * 100}% overall, >= ${NL_EVAL_GATE.perEntry * 100}% per entry, ${NL_EVAL_GATE.wrongCaptures} wrong captures.
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

export function parseArguments(argv: readonly string[]): { mode: 'plan' | 'run' | 'help'; options: Record<string, string> } {
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
  if (mode !== 'plan' && mode !== 'run') throw new UsageError('--mode must be plan or run');
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
  readonly loadCorpus: () => { corpus: NlEvalCorpus; sha256: string };
  readonly writeReport: (fileName: string, contents: string) => string;
  /** Constructed only by `run`, only after the digest matched. */
  readonly createProvider: (model: string) => AiProvider;
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
    `overall: ${summary.hits}/${summary.positives} (${pct(summary.overall)})  wrong captures: ${summary.wrongCaptures}/${summary.negatives}` +
      `  clarifications: ${summary.clarifications}  timeouts (> ${summary.latency.boundMs / 1000} s, counted as misses): ${summary.timeouts}  errors: ${summary.errors}`,
    ...Object.entries(summary.perEntry)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([entry, slot]) => `  ${entry.padEnd(20)} ${slot.hits}/${slot.total} (${pct(slot.rate)})`),
    `latency: p50 ${summary.latency.p50} ms, p95 ${summary.latency.p95} ms, max ${summary.latency.max} ms, over ${summary.latency.boundMs / 1000} s: ${summary.latency.overRuntimeBound}`,
    `gate (>= 95% overall, >= 90% per entry, 0 wrong captures): ${summary.gatePassed ? 'PASSED' : 'FAILED'}`,
  ];
}

function describeMiss(record: NlEvalRecord): string {
  const raw = record.outcome === 'clarify' || record.outcome === 'error' ? ` raw=${(record.raw ?? '').replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `  ${record.outcome.padEnd(13)} ${record.id} want ${record.expected} got ${record.got ?? '-'} ${record.gotArgs ? JSON.stringify(record.gotArgs) : ''}${record.error ? ` (${record.error})` : ''}${raw}`;
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
  const startedAt = deps.now();
  let done = 0;
  const total = plan.caseIds.length * plan.runs;
  const records = await runEvaluation({
    corpus,
    plan,
    provider,
    now: deps.now,
    onRecord: () => {
      done += 1;
      if (done % 50 === 0) deps.stderr(`… ${done}/${total}`);
    },
  });
  const summaries = Array.from({ length: plan.runs }, (_, index) => summarize(records.filter((record) => record.run === index + 1), plan.callTimeoutMs));
  for (const [index, summary] of summaries.entries()) {
    deps.stdout(`run ${index + 1}/${plan.runs} (${plan.model}, ${plan.promptVersion}):`);
    for (const line of formatSummary(summary)) deps.stdout(line);
  }
  const misses = records.filter((record) => record.outcome !== 'hit' && record.outcome !== 'none');
  if (misses.length > 0) {
    deps.stdout(`not hit (${misses.length}):`);
    for (const record of misses) deps.stdout(describeMiss(record));
  }
  const path = deps.writeReport(
    `nl-intent-${startedAt.replace(/[:.]/g, '-')}-${plan.model.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
    `${JSON.stringify({ plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), summaries, records }, null, 2)}\n`,
  );
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
