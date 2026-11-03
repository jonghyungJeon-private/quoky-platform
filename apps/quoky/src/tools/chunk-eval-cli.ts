/**
 * ADR-0124 slice C2: the CH1 "needle in the middle" retrieval harness, Phase 0 (lexical arm only; no model, no embedder,
 * no Ollama call, no network).
 *
 *   pnpm eval:chunk -- --mode run [--out <dir>]     verify the corpus hash, run baseline + EL, write data/eval/chunk-eval-*.json
 *   pnpm eval:chunk -- --mode verify                check the generated corpus against the recorded hash (no run)
 *   pnpm eval:chunk -- --mode regenerate-freeze     SEPARATE command: record the current corpus hash (after a deliberate corpus change)
 *
 * Exit codes (as the other eval tools): 0 PASSED, 1 FAILED, 2 USAGE, 3 BLOCKED (corpus differs from the recorded hash, or
 * no record), 4 NON-GATING (a completed run: CH1 thresholds are proposals, so a run never reports PASSED), 5 INVALID
 * (the run itself is not trustworthy: a needle missing from its item, or the baseline refused an item). Exit 0 is
 * returned by `verify` and `regenerate-freeze` only. Exit 1 is not produced in this slice (no ratified gate exists).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { corpusDigest, CORPUS_SEED, CORPUS_VERSION, generateCorpus, type ChunkEvalCase } from './chunk-eval/corpus';
import { runChunkEval, summaryLines, type ChunkEvalReport } from './chunk-eval/chunk-eval';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_NON_GATING = 4;
export const EXIT_INVALID = 5;

const repoRoot = resolve(__dirname, '../../../..');
export const FREEZE_PATH = resolve(repoRoot, 'apps/quoky/src/tools/chunk-eval/chunk-eval-corpus.freeze.v1.json');
const DEFAULT_OUT_DIR = resolve(repoRoot, 'data/eval');

const HELP = [
  'usage: pnpm eval:chunk -- --mode run|verify|regenerate-freeze [--out <dir>]',
  '  run                 verify the corpus hash (exit 3 if it differs), run baseline and lexical arms, write the report (exit 4 NON-GATING)',
  '  verify              check the generated corpus against the recorded hash (exit 0 or 3)',
  '  regenerate-freeze   record the current corpus hash (a deliberate, separate step; exit 0)',
].join('\n');

export interface FreezeRecord {
  readonly version: string;
  readonly seed: string;
  readonly cases: number;
  readonly sha256: string;
}

export interface CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  readonly corpus: () => ChunkEvalCase[];
  readonly readFreeze: () => FreezeRecord | undefined;
  readonly writeFreeze: (record: FreezeRecord) => void;
  readonly writeReport: (dir: string, name: string, report: ChunkEvalReport) => string;
}

export function defaultDeps(): CliDeps {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    corpus: generateCorpus,
    readFreeze: () => {
      try {
        return JSON.parse(readFileSync(FREEZE_PATH, 'utf8')) as FreezeRecord;
      } catch {
        return undefined;
      }
    },
    writeFreeze: (record) => writeFileSync(FREEZE_PATH, `${JSON.stringify(record, null, 2)}\n`),
    writeReport: (dir, name, report) => {
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, name);
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
      return path;
    },
  };
}

type Parsed = { mode: 'run' | 'verify' | 'regenerate-freeze' | 'help'; out?: string };
class UsageError extends Error {}

export function parseArguments(argv: readonly string[]): Parsed {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return { mode: 'help' };
  let mode: string | undefined;
  let out: string | undefined;
  for (let at = 0; at < tokens.length; at += 2) {
    const name = tokens[at] as string;
    const value = tokens[at + 1];
    if (name !== '--mode' && name !== '--out') throw new UsageError(`unknown option ${name}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    if (name === '--mode') mode = value;
    else out = value;
  }
  if (mode !== 'run' && mode !== 'verify' && mode !== 'regenerate-freeze') throw new UsageError('--mode must be run, verify or regenerate-freeze');
  if (out !== undefined && mode !== 'run') throw new UsageError('--out applies to --mode run only');
  return { mode, ...(out === undefined ? {} : { out }) };
}

export async function runCli(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let parsed: Parsed;
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
  const cases = deps.corpus();
  const digest = corpusDigest(cases);
  if (parsed.mode === 'regenerate-freeze') {
    deps.writeFreeze({ version: CORPUS_VERSION, seed: CORPUS_SEED, cases: cases.length, sha256: digest });
    deps.stdout(`recorded corpus ${digest} (${cases.length} cases)`);
    return EXIT_OK;
  }
  const record = deps.readFreeze();
  if (record === undefined) {
    deps.stderr('BLOCKED: no recorded corpus hash; run --mode regenerate-freeze once, review, and commit the record');
    return EXIT_BLOCKED;
  }
  if (record.sha256 !== digest || record.version !== CORPUS_VERSION || record.seed !== CORPUS_SEED || record.cases !== cases.length) {
    deps.stderr(`BLOCKED: the corpus differs from the recorded hash (recorded ${record.sha256}, generated ${digest}); nothing was run`);
    return EXIT_BLOCKED;
  }
  if (parsed.mode === 'verify') {
    deps.stdout(`corpus matches the record: ${digest} (${cases.length} cases)`);
    return EXIT_OK;
  }
  const report = runChunkEval(cases, digest);
  const invalid = report.arms.baseline.refusedOrEmpty > 0 || cases.some((item) => !item.prepared.includes(item.needle.text));
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const name = `chunk-eval-${digest.slice(0, 12)}-${stamp}.json`;
  const path = deps.writeReport(parsed.out === undefined ? DEFAULT_OUT_DIR : resolve(parsed.out), name, report);
  for (const line of summaryLines(report)) deps.stdout(line);
  deps.stdout(`report: ${path}`);
  if (invalid) {
    deps.stderr('INVALID: the baseline refused an item or a needle is missing from its item; the numbers are not trustworthy');
    return EXIT_INVALID;
  }
  return EXIT_NON_GATING;
}


if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'unexpected error'}\n`);
      process.exit(EXIT_FAILED);
    },
  );
}
