/**
 * Answer-quality evaluation CLI (ADR-0098 D7, QUAL-2).
 *
 *   pnpm eval:answers -- --mode validate-fixtures
 *   pnpm eval:answers -- --mode check-outputs --input <file>
 *   pnpm eval:answers -- --mode plan --target ollama|claude --model <tag> --calls N
 *   pnpm eval:answers -- --mode run  --target ollama|claude --model <tag> --calls N --approved-plan-digest <sha256>
 *
 * The first three modes are offline: they read local files, print, and construct no provider and spawn no process.
 * `run` is Strict and needs a separate Product Owner approval per run and per target: it recomputes the plan digest
 * and exits non-zero BEFORE any provider is constructed unless `--approved-plan-digest` equals it. The concrete CLI
 * provider (app-layer composition, named by `--target` only) is built by `deps.createProvider` after that check.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudeCliProvider, OllamaCliProvider } from '@quoky/ai-cli';
import type { AiProvider } from '@quoky/core';
import {
  AnswerQualityBlockedError,
  EVAL_TARGETS,
  buildPlan,
  checkSavedOutputs,
  computePlanDigest,
  loadFixtures,
  parseSavedOutputs,
  runProviderEvaluation,
  summarizePassRates,
  validateFixtures,
} from './answer-quality-eval';
import type { AnswerQualityFixtures, EvalTarget, RunReport } from './answer-quality-eval';

export type CliMode = 'validate-fixtures' | 'check-outputs' | 'plan' | 'run';
const MODES: readonly CliMode[] = ['validate-fixtures', 'check-outputs', 'plan', 'run'];

export const EXIT_OK = 0;
/** An offline check found a problem (invalid fixtures, a failed check on saved outputs). */
export const EXIT_CHECK_FAILED = 1;
/** Bad arguments. */
export const EXIT_USAGE = 2;
/** Strict gate refused: digest missing/mismatched, provider unavailable, invalid plan input. Nothing was spawned. */
export const EXIT_BLOCKED = 3;

const HELP = `Answer-quality harness (ADR-0098 D7)

Offline modes (no provider constructed, no process spawned):
  pnpm eval:answers -- --mode validate-fixtures
  pnpm eval:answers -- --mode check-outputs --input <outputs.json>
  pnpm eval:answers -- --mode plan --target ollama|claude --model <tag> --calls N

Strict mode (separate Product Owner approval per run and per target):
  pnpm eval:answers -- --mode run --target ollama|claude --model <tag> --calls N --approved-plan-digest <sha256 from plan>

Outputs file: [{"caseId": "...", "text": "..."}] or {"outputs": [...]}.
Run results are written to data/eval/answer-quality-<timestamp>.json.
`;

const MODE_SCHEMA: Readonly<Record<CliMode, { required: readonly string[]; optional: readonly string[] }>> = {
  'validate-fixtures': { required: [], optional: [] },
  'check-outputs': { required: ['--input'], optional: [] },
  plan: { required: ['--target', '--model', '--calls'], optional: [] },
  run: { required: ['--target', '--model', '--calls', '--approved-plan-digest'], optional: [] },
};
const KNOWN_OPTIONS = new Set(['--mode', '--input', '--target', '--model', '--calls', '--approved-plan-digest']);

export interface ParsedArguments {
  readonly mode: CliMode | 'help';
  readonly options: Readonly<Record<string, string>>;
}

export class UsageError extends Error {}

/** Fail-closed parser: unknown options, repeated options, missing values and per-mode extras are all rejected. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return { mode: 'help', options: {} };
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index] as string;
    const value = tokens[index + 1];
    if (!KNOWN_OPTIONS.has(name)) throw new UsageError(`unknown option ${name}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    if (name in options) throw new UsageError(`${name} given more than once`);
    options[name] = value;
  }
  const mode = options['--mode'];
  if (mode === undefined || !(MODES as readonly string[]).includes(mode)) throw new UsageError('--mode must be one of ' + MODES.join(', '));
  const schema = MODE_SCHEMA[mode as CliMode];
  const allowed = new Set(['--mode', ...schema.required, ...schema.optional]);
  for (const name of schema.required) if (!(name in options)) throw new UsageError(`${mode} requires ${name}`);
  for (const name of Object.keys(options)) if (!allowed.has(name)) throw new UsageError(`${name} is not valid for ${mode}`);
  return { mode: mode as CliMode, options };
}

export interface CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => string;
  readonly loadFixtures: () => AnswerQualityFixtures;
  readonly readTextFile: (path: string) => string;
  /** Receives the run report; the default writes `data/eval/answer-quality-<ts>.json`. */
  readonly writeReport: (fileName: string, contents: string) => string;
  /**
   * Constructs the single concrete CLI provider named by `--target`. Called only by `run`, only after the approved
   * digest matched, and never by an offline mode.
   */
  readonly createProvider: (target: EvalTarget, model: string) => AiProvider;
}

const repoRoot = resolve(__dirname, '../../../..');

export function defaultDeps(): CliDeps {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date().toISOString(),
    loadFixtures: () => loadFixtures(),
    readTextFile: (path) => readFileSync(path, 'utf8'),
    writeReport: (fileName, contents) => {
      const dir = resolve(repoRoot, 'data/eval');
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, fileName);
      writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
      return path;
    },
    createProvider: (target, model) =>
      target === 'ollama' ? new OllamaCliProvider({ model }) : new ClaudeCliProvider('claude', { model }),
  };
}

function formatRates(report: Pick<RunReport, 'passRates'>): string[] {
  return Object.entries(report.passRates).map(
    ([name, rate]) => `  ${name.padEnd(26)} ${rate.passed}/${rate.total} (${(rate.rate * 100).toFixed(1)}%)`,
  );
}

function reportFileName(now: string, target: EvalTarget): string {
  return `answer-quality-${now.replace(/[:.]/g, '-')}-${target}.json`;
}

export async function runCli(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    deps.stderr(error instanceof UsageError ? error.message : 'invalid arguments');
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  if (parsed.mode === 'help') {
    deps.stdout(HELP);
    return EXIT_OK;
  }
  const { options } = parsed;
  try {
    const fixtures = deps.loadFixtures();
    switch (parsed.mode) {
      case 'validate-fixtures': {
        const problems = validateFixtures(fixtures);
        if (problems.length > 0) {
          for (const problem of problems) deps.stderr(`fixture problem: ${problem}`);
          return EXIT_CHECK_FAILED;
        }
        deps.stdout(
          `fixtures ok: ${fixtures.cases.length} cases, ${fixtures.knownBadOutputs.length} known-bad and ` +
            `${fixtures.knownGoodOutputs.length} known-good outputs (${fixtures.fixtureVersion})`,
        );
        return EXIT_OK;
      }
      case 'check-outputs': {
        const rows = checkSavedOutputs(fixtures, parseSavedOutputs(JSON.parse(deps.readTextFile(options['--input'] as string))));
        let failed = 0;
        for (const row of rows) {
          for (const result of row.results) {
            if (!result.passed) {
              failed += 1;
              deps.stdout(`FAIL ${row.caseId} ${result.name}${result.detail === undefined ? '' : `: ${result.detail}`}`);
            }
          }
        }
        deps.stdout(`checked ${rows.length} outputs, ${failed} failed checks`);
        for (const line of formatRates({ passRates: summarizePassRates(rows) })) deps.stdout(line);
        return failed === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
      }
      case 'plan': {
        const plan = buildPlan(fixtures, planOptions(options));
        deps.stdout(JSON.stringify(plan, null, 2));
        deps.stdout(`plan digest (sha256): ${computePlanDigest(plan)}`);
        deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
        return EXIT_OK;
      }
      case 'run': {
        const plan = buildPlan(fixtures, planOptions(options));
        const digest = computePlanDigest(plan);
        if (options['--approved-plan-digest'] !== digest) {
          deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
          return EXIT_BLOCKED;
        }
        const provider = deps.createProvider(plan.target, plan.model);
        // A probe that throws (including an indeterminate, timed-out one) counts as not available here.
        if (!(await provider.isAvailable().catch(() => false))) {
          deps.stderr(`BLOCKED: ${plan.providerKind} is not available; nothing was executed`);
          return EXIT_BLOCKED;
        }
        const report = await runProviderEvaluation({ fixtures, plan, provider, now: deps.now });
        const path = deps.writeReport(reportFileName(report.finishedAt, plan.target), `${JSON.stringify(report, null, 2)}\n`);
        deps.stdout(`answer-quality run: ${report.calls.length} calls, ${report.errorCount} errors (${plan.providerKind}, ${plan.model})`);
        for (const line of formatRates(report)) deps.stdout(line);
        deps.stdout(`results written to ${path}`);
        return EXIT_OK;
      }
    }
  } catch (error) {
    if (error instanceof AnswerQualityBlockedError) {
      deps.stderr(`BLOCKED: ${error.message}`);
      return EXIT_BLOCKED;
    }
    deps.stderr(`error: ${error instanceof Error ? error.name : 'unknown'}`);
    return EXIT_CHECK_FAILED;
  }
}

function planOptions(options: Readonly<Record<string, string>>): { target: EvalTarget; model: string; calls: number } {
  const target = options['--target'];
  if (!(EVAL_TARGETS as readonly string[]).includes(target ?? '')) {
    throw new AnswerQualityBlockedError('INVALID_TARGET', `target must be one of ${EVAL_TARGETS.join(', ')}`);
  }
  const calls = options['--calls'] ?? '';
  return {
    target: target as EvalTarget,
    model: options['--model'] as string,
    calls: /^\d+$/.test(calls) ? Number(calls) : Number.NaN,
  };
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_CHECK_FAILED;
    },
  );
}
