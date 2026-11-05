/**
 * ADR-0124 slice C2: the CH1 "needle in the middle" retrieval harness, Phase 0 (lexical arm only; no model, no embedder,
 * no Ollama call, no network).
 *
 *   pnpm eval:chunk -- --mode run [--out <dir>]     verify the corpus hash, run baseline + EL, write data/eval/chunk-eval-*.json
 *   pnpm eval:chunk -- --mode verify                check the generated corpus against the recorded hash (no run)
 *   pnpm eval:chunk -- --mode regenerate-freeze     SEPARATE command: record the current corpus hash (after a deliberate corpus change)
 *   pnpm eval:chunk -- --set drive-format --mode run|verify|regenerate-freeze
 *                                                   the SEPARATE Drive plain-text vs Markdown variant set (ADR-0124 open question 10),
 *                                                   with its own freeze record; the v1 corpus and its record are never touched by it
 *   pnpm eval:chunk -- --set v2 --mode run|verify|regenerate-freeze
 *                                                   the SEPARATE harder synthetic set v2 (ADR-0124 section 16: paraphrased questions, long
 *                                                   paragraphs, section-name questions, near-duplicates, dense decoys), own freeze record
 *
 *   pnpm eval:chunk -- --mode plan [--arms E0,E1,E2,E3] [--scope phase1|all] [--shapes a,b]
 *                                                   ADR-0124 phase 1: ZERO model calls. Reads the pins from the loopback daemon (version and tags),
 *                                                   counts what each embedder arm would embed after cache hits, prints the plan digest
 *   pnpm eval:chunk -- --mode probe --plan-digest <digest> [--arms ...]
 *                                                   stage B: per available arm, one fixed 200-passage sample + 1 query, cold and warm
 *   pnpm eval:chunk -- --set v1|v2|memory --arms E0,E1,E2,E3 --plan-digest <digest> --mode run
 *                                                   the embedder arms E0-E3 and the hybrid EH(x) on a set (memory = CH7); needs the matching plan digest
 *   pnpm eval:chunk -- --set memory --mode run|verify|regenerate-freeze
 *                                                   the hash-frozen synthetic CH7 memory set (own freeze record); without --arms: the EL baseline only
 *
 * Exit codes (as the other eval tools): 0 PASSED, 1 FAILED, 2 USAGE, 3 BLOCKED (corpus differs from the recorded hash, or
 * no record), 4 NON-GATING (a completed run: CH1 thresholds are proposals, so a run never reports PASSED), 5 INVALID
 * (the run itself is not trustworthy: a needle missing from its item, or the baseline refused an item). Exit 0 is
 * returned by `verify` and `regenerate-freeze` only. Exit 1 is not produced in this slice (no ratified gate exists).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { corpusDigest, CORPUS_SEED, CORPUS_VERSION, generateCorpus, type ChunkEvalCase } from './chunk-eval/corpus';
import { runChunkEval, summaryLines } from './chunk-eval/chunk-eval';
import { CORPUS_V2_SEED, CORPUS_V2_VERSION, corpusV2Digest, generateCorpusV2, type ChunkEvalCaseV2 } from './chunk-eval/corpus-v2';
import { runChunkEvalV2, summaryLinesV2 } from './chunk-eval/chunk-eval-v2';
import type { FetchLike } from './selector-rag/embed';
import { ARM_IDS, ArmEmbedder, EmbeddingCache, bundleOf, cachePath, latencySample, resolveArms, type ArmId, type Scope } from './chunk-eval/embed-arms';
import { PARAMETERS, runArmOnSet, summaryLinesEmbed, type ChunkEmbedReport, type EmbedderRun } from './chunk-eval/embed-eval';
import { buildPlanReport, planDigest, planLines, probeLines, runProbeArm, sampleDigest, type PlanInputs, type ProbeReport } from './chunk-eval/embed-plan';
import { buildMemoryReport, runMemoryArm, summaryLinesMemory, type MemoryArmRun } from './chunk-eval/memory-eval';
import { generateMemorySet, memoryDigest, MEMORY_SEED, MEMORY_VERSION, type MemorySet } from './chunk-eval/memory-set';
import { SHAPES } from './chunk-eval/corpus';
import { DRIVE_FORMAT_VERSION, driveFormatDigest, driveFormatSummaryLines, generateDriveFormatSet, runDriveFormat, type DriveFormatCase } from './chunk-eval/drive-format';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_NON_GATING = 4;
export const EXIT_INVALID = 5;

const repoRoot = resolve(__dirname, '../../../..');
export const FREEZE_PATH = resolve(repoRoot, 'apps/quoky/src/tools/chunk-eval/chunk-eval-corpus.freeze.v1.json');
export const DRIVE_FORMAT_FREEZE_PATH = resolve(repoRoot, 'apps/quoky/src/tools/chunk-eval/chunk-eval-drive-format.freeze.v1.json');
export const V2_FREEZE_PATH = resolve(repoRoot, 'apps/quoky/src/tools/chunk-eval/chunk-eval-corpus.freeze.v2.json');
export const MEMORY_FREEZE_PATH = resolve(repoRoot, 'apps/quoky/src/tools/chunk-eval/chunk-eval-memory.freeze.v1.json');
const DEFAULT_CACHE_DIR = resolve(repoRoot, 'data/eval/embed-cache');
const DEFAULT_OUT_DIR = resolve(repoRoot, 'data/eval');

const HELP = [
  'usage: pnpm eval:chunk -- [--set v1|drive-format|v2|memory] --mode run|verify|regenerate-freeze [--out <dir>]',
  '       pnpm eval:chunk -- --mode plan|probe [--arms E0,E1,E2,E3] [--scope phase1|all] [--shapes <shape,...>] [--plan-digest <sha256>]',
  '       pnpm eval:chunk -- --set v1|v2|memory --arms E0,E1,E2,E3 --plan-digest <sha256> --mode run   (embedder arms; needs the digest printed by plan)',
  '  run                 verify the corpus hash (exit 3 if it differs), run baseline and lexical arms, write the report (exit 4 NON-GATING)',
  '  verify              check the generated corpus against the recorded hash (exit 0 or 3)',
  '  regenerate-freeze   record the current corpus hash (a deliberate, separate step; exit 0)',
  '  --set drive-format  the Drive text-vs-Markdown variant set instead of the v1 corpus (own freeze record, same exit codes)',
  '  --set v2            the harder synthetic set v2 (feature-tagged cases; own freeze record, same exit codes)',
  '  --set memory        the synthetic CH7 memory set (own freeze record); with --arms also the embedder arms and the section 6 verdict',
  '  plan                zero model calls: pins, counts after cache hits, plan digest (exit 0)',
  '  probe               stage B: 200-passage sample + 1 query per available arm, cold and warm (needs --plan-digest; exit 4)',
  '  --scope phase1|all  phase1 (default): the v1 adr-file shape runs on E0 only; all: every shape on every arm',
  '  --cache-dir <dir>   embedding cache (default data/eval/embed-cache, gitignored); --ollama-url must be loopback',
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
  readonly writeReport: (dir: string, name: string, report: object) => string;
  /** The Drive-format variant set; defaults to the real generator and its own freeze record. */
  readonly variant?: {
    readonly corpus: () => DriveFormatCase[];
    readonly readFreeze: () => FreezeRecord | undefined;
    readonly writeFreeze: (record: FreezeRecord) => void;
  };
  /** The CH7 memory set; defaults to the real generator and its own freeze record. */
  readonly memory?: {
    readonly corpus: () => MemorySet;
    readonly readFreeze: () => FreezeRecord | undefined;
    readonly writeFreeze: (record: FreezeRecord) => void;
  };
  /** The loopback embedder transport (tests inject a fake fetch and a clock). `cacheDir: null` keeps the cache in memory only. */
  readonly embed?: { readonly baseUrl?: string; readonly fetch?: FetchLike; readonly cacheDir?: string | null; readonly clock?: () => number };
  /** The harder synthetic set v2; defaults to the real generator and its own freeze record. */
  readonly v2?: {
    readonly corpus: () => ChunkEvalCaseV2[];
    readonly readFreeze: () => FreezeRecord | undefined;
    readonly writeFreeze: (record: FreezeRecord) => void;
  };
}

const defaultMemory = (): NonNullable<CliDeps['memory']> => ({
  corpus: generateMemorySet,
  readFreeze: () => {
    try {
      return JSON.parse(readFileSync(MEMORY_FREEZE_PATH, 'utf8')) as FreezeRecord;
    } catch {
      return undefined;
    }
  },
  writeFreeze: (record) => writeFileSync(MEMORY_FREEZE_PATH, `${JSON.stringify(record, null, 2)}\n`),
});

const defaultV2 = (): NonNullable<CliDeps['v2']> => ({
  corpus: generateCorpusV2,
  readFreeze: () => {
    try {
      return JSON.parse(readFileSync(V2_FREEZE_PATH, 'utf8')) as FreezeRecord;
    } catch {
      return undefined;
    }
  },
  writeFreeze: (record) => writeFileSync(V2_FREEZE_PATH, `${JSON.stringify(record, null, 2)}\n`),
});

const defaultVariant = (): NonNullable<CliDeps['variant']> => ({
  corpus: generateDriveFormatSet,
  readFreeze: () => {
    try {
      return JSON.parse(readFileSync(DRIVE_FORMAT_FREEZE_PATH, 'utf8')) as FreezeRecord;
    } catch {
      return undefined;
    }
  },
  writeFreeze: (record) => writeFileSync(DRIVE_FORMAT_FREEZE_PATH, `${JSON.stringify(record, null, 2)}\n`),
});

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

type Parsed = {
  mode: 'run' | 'verify' | 'regenerate-freeze' | 'plan' | 'probe' | 'help';
  out?: string;
  set: 'v1' | 'drive-format' | 'v2' | 'memory';
  setGiven: boolean;
  arms?: ArmId[];
  planDigest?: string;
  scope: Scope;
  shapes?: string[];
  cacheDir?: string;
  ollamaUrl?: string;
};
class UsageError extends Error {}

const list = (value: string): string[] => value.split(',').map((item) => item.trim()).filter((item) => item !== '');

export function parseArguments(argv: readonly string[]): Parsed {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return { mode: 'help', set: 'v1', setGiven: false, scope: 'phase1' };
  const values = new Map<string, string>();
  const NAMES = ['--mode', '--out', '--set', '--arms', '--plan-digest', '--scope', '--shapes', '--cache-dir', '--ollama-url'];
  for (let at = 0; at < tokens.length; at += 2) {
    const name = tokens[at] as string;
    const value = tokens[at + 1];
    if (!NAMES.includes(name)) throw new UsageError(`unknown option ${name}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    values.set(name, value);
  }
  const mode = values.get('--mode');
  const set = values.get('--set') ?? 'v1';
  const out = values.get('--out');
  if (mode !== 'run' && mode !== 'verify' && mode !== 'regenerate-freeze' && mode !== 'plan' && mode !== 'probe') throw new UsageError('--mode must be run, verify, regenerate-freeze, plan or probe');
  if (set !== 'v1' && set !== 'drive-format' && set !== 'v2' && set !== 'memory') throw new UsageError('--set must be v1, drive-format, v2 or memory');
  if (out !== undefined && mode !== 'run' && mode !== 'plan' && mode !== 'probe') throw new UsageError('--out applies to --mode run, plan and probe only');
  let arms: ArmId[] | undefined;
  if (values.has('--arms')) {
    arms = list(values.get('--arms') as string) as ArmId[];
    if (arms.length === 0 || arms.some((arm) => !ARM_IDS.includes(arm)) || new Set(arms).size !== arms.length) throw new UsageError(`--arms must be a list of ${ARM_IDS.join(', ')} without repeats`);
    if (mode === 'verify' || mode === 'regenerate-freeze') throw new UsageError('--arms applies to --mode run, plan and probe only');
    if (set === 'drive-format') throw new UsageError('--arms does not apply to --set drive-format');
  }
  const planDigestValue = values.get('--plan-digest');
  if (planDigestValue !== undefined && !/^[0-9a-f]{64}$/u.test(planDigestValue)) throw new UsageError('--plan-digest must be the 64 hex characters printed by --mode plan');
  const scope = values.get('--scope') ?? 'phase1';
  if (scope !== 'phase1' && scope !== 'all') throw new UsageError('--scope must be phase1 or all');
  let shapes: string[] | undefined;
  if (values.has('--shapes')) {
    shapes = list(values.get('--shapes') as string);
    if (shapes.length === 0 || shapes.some((shape) => !(SHAPES as readonly string[]).includes(shape))) throw new UsageError(`--shapes must be a list of ${SHAPES.join(', ')}`);
  }
  if ((mode === 'plan' || mode === 'probe') && values.has('--set')) throw new UsageError('--mode plan and probe cover every set; do not pass --set');
  const embedderOnly = ['--plan-digest', '--scope', '--shapes', '--cache-dir', '--ollama-url'].filter((name) => values.has(name));
  if (embedderOnly.length > 0 && arms === undefined && mode !== 'plan' && mode !== 'probe') throw new UsageError(`${embedderOnly.join(', ')} apply to embedder runs (--arms), plan and probe only`);
  return {
    mode,
    set,
    setGiven: values.has('--set'),
    scope,
    ...(out === undefined ? {} : { out }),
    ...(arms === undefined ? {} : { arms }),
    ...(planDigestValue === undefined ? {} : { planDigest: planDigestValue }),
    ...(shapes === undefined ? {} : { shapes }),
    ...(values.has('--cache-dir') ? { cacheDir: values.get('--cache-dir') as string } : {}),
    ...(values.has('--ollama-url') ? { ollamaUrl: values.get('--ollama-url') as string } : {}),
  };
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
  if (parsed.mode === 'plan' || parsed.mode === 'probe') return runEmbedPlanOrProbe(parsed, deps);
  if (parsed.set === 'memory') return runMemory(parsed, deps);
  if (parsed.arms !== undefined && parsed.mode === 'run') return runEmbedSet(parsed, deps);
  if (parsed.set === 'drive-format') return runVariant(parsed, deps);
  if (parsed.set === 'v2') return runV2(parsed, deps);
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

async function runVariant(parsed: Parsed, deps: CliDeps): Promise<number> {
  const variant = deps.variant ?? defaultVariant();
  const cases = variant.corpus();
  const digest = driveFormatDigest(cases);
  if (parsed.mode === 'regenerate-freeze') {
    variant.writeFreeze({ version: DRIVE_FORMAT_VERSION, seed: CORPUS_SEED, cases: cases.length, sha256: digest });
    deps.stdout(`recorded drive-format set ${digest} (${cases.length} cases)`);
    return EXIT_OK;
  }
  const record = variant.readFreeze();
  if (record === undefined) {
    deps.stderr('BLOCKED: no recorded drive-format hash; run --set drive-format --mode regenerate-freeze once, review, and commit the record');
    return EXIT_BLOCKED;
  }
  if (record.sha256 !== digest || record.version !== DRIVE_FORMAT_VERSION || record.seed !== CORPUS_SEED || record.cases !== cases.length) {
    deps.stderr(`BLOCKED: the drive-format set differs from the recorded hash (recorded ${record.sha256}, generated ${digest}); nothing was run`);
    return EXIT_BLOCKED;
  }
  if (parsed.mode === 'verify') {
    deps.stdout(`drive-format set matches the record: ${digest} (${cases.length} cases)`);
    return EXIT_OK;
  }
  const report = runDriveFormat(cases, digest);
  const invalid =
    report.formats.text.baseline.refusedOrEmpty > 0 || report.formats.markdown.baseline.refusedOrEmpty > 0 || cases.some((item) => !item.prepared.includes(item.needle.text));
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const path = deps.writeReport(parsed.out === undefined ? DEFAULT_OUT_DIR : resolve(parsed.out), `chunk-eval-drive-format-${digest.slice(0, 12)}-${stamp}.json`, report);
  for (const line of driveFormatSummaryLines(report)) deps.stdout(line);
  deps.stdout(`report: ${path}`);
  if (invalid) {
    deps.stderr('INVALID: the baseline refused an item or a needle is missing from its item; the numbers are not trustworthy');
    return EXIT_INVALID;
  }
  return EXIT_NON_GATING;
}

async function runV2(parsed: Parsed, deps: CliDeps): Promise<number> {
  const v2 = deps.v2 ?? defaultV2();
  const cases = v2.corpus();
  const digest = corpusV2Digest(cases);
  if (parsed.mode === 'regenerate-freeze') {
    v2.writeFreeze({ version: CORPUS_V2_VERSION, seed: CORPUS_V2_SEED, cases: cases.length, sha256: digest });
    deps.stdout(`recorded v2 corpus ${digest} (${cases.length} cases)`);
    return EXIT_OK;
  }
  const record = v2.readFreeze();
  if (record === undefined) {
    deps.stderr('BLOCKED: no recorded v2 hash; run --set v2 --mode regenerate-freeze once, review, and commit the record');
    return EXIT_BLOCKED;
  }
  if (record.sha256 !== digest || record.version !== CORPUS_V2_VERSION || record.seed !== CORPUS_V2_SEED || record.cases !== cases.length) {
    deps.stderr(`BLOCKED: the v2 corpus differs from the recorded hash (recorded ${record.sha256}, generated ${digest}); nothing was run`);
    return EXIT_BLOCKED;
  }
  if (parsed.mode === 'verify') {
    deps.stdout(`v2 corpus matches the record: ${digest} (${cases.length} cases)`);
    return EXIT_OK;
  }
  const report = runChunkEvalV2(cases, digest);
  const invalid = report.arms.baseline.refusedOrEmpty > 0 || cases.some((item) => !item.prepared.includes(item.needle.text));
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const path = deps.writeReport(parsed.out === undefined ? DEFAULT_OUT_DIR : resolve(parsed.out), `chunk-eval-v2-${digest.slice(0, 12)}-${stamp}.json`, report);
  for (const line of summaryLinesV2(report)) deps.stdout(line);
  deps.stdout(`report: ${path}`);
  if (invalid) {
    deps.stderr('INVALID: the baseline refused an item or a needle is missing from its item; the numbers are not trustworthy');
    return EXIT_INVALID;
  }
  return EXIT_NON_GATING;
}

// ---------------------------------------------------------------- ADR-0124 phase 1: embedder arms (plan / probe / run)

function freezeProblem(label: string, flag: string, record: FreezeRecord | undefined, digest: string, version: string, seed: string, cases: number): string | undefined {
  if (record === undefined) return `BLOCKED: no recorded ${label} hash; run ${flag} --mode regenerate-freeze once, review, and commit the record`;
  if (record.sha256 !== digest || record.version !== version || record.seed !== seed || record.cases !== cases) {
    return `BLOCKED: the ${label} differs from the recorded hash (recorded ${record.sha256}, generated ${digest}); nothing was run`;
  }
  return undefined;
}

interface EmbedContext {
  readonly v1: ChunkEvalCase[];
  readonly v2: ChunkEvalCaseV2[];
  readonly memory: MemorySet;
  readonly inputs: PlanInputs;
  readonly digest: string;
  readonly embedders: ArmEmbedder[];
  readonly dropped: readonly { arm: string; reason: string }[];
  readonly planned: readonly ArmId[];
}

/**
 * Loads and freeze-verifies the three sets, reads the pins from the loopback daemon (version and tags only), builds the plan
 * digest and, for probe and run, requires `--plan-digest` to equal it. No embedding call happens here.
 */
async function embedContext(parsed: Parsed, deps: CliDeps): Promise<EmbedContext | number> {
  const v1 = deps.corpus();
  const v2 = (deps.v2 ?? defaultV2()).corpus();
  const memory = (deps.memory ?? defaultMemory()).corpus();
  const digests = { v1: corpusDigest(v1), v2: corpusV2Digest(v2), memory: memoryDigest(memory) };
  const problems = [
    freezeProblem('corpus', '--set v1', deps.readFreeze(), digests.v1, CORPUS_VERSION, CORPUS_SEED, v1.length),
    freezeProblem('v2 corpus', '--set v2', (deps.v2 ?? defaultV2()).readFreeze(), digests.v2, CORPUS_V2_VERSION, CORPUS_V2_SEED, v2.length),
    freezeProblem('memory set', '--set memory', (deps.memory ?? defaultMemory()).readFreeze(), digests.memory, MEMORY_VERSION, MEMORY_SEED, memory.memories.length + memory.queries.length),
  ].filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0) {
    for (const problem of problems) deps.stderr(problem);
    return EXIT_BLOCKED;
  }
  const planned = parsed.arms ?? [...ARM_IDS];
  let resolved;
  try {
    resolved = await resolveArms(planned, deps.embed?.baseUrl ?? parsed.ollamaUrl, deps.embed?.fetch);
  } catch (error) {
    deps.stderr(`INVALID: could not read the embedder pins from the loopback daemon: ${error instanceof Error ? error.message : 'error'}`);
    return EXIT_INVALID;
  }
  const inputs: PlanInputs = { sets: { v1: { digest: digests.v1 }, v2: { digest: digests.v2 }, memory: { digest: digests.memory } }, resolved, scope: parsed.scope, ...(parsed.shapes === undefined ? {} : { shapes: parsed.shapes }) };
  const digest = planDigest(inputs);
  if (parsed.mode !== 'plan') {
    if (parsed.planDigest === undefined) {
      deps.stderr(`BLOCKED: a model-in-the-loop ${parsed.mode} needs --plan-digest from --mode plan (current plan digest ${digest}); nothing was called`);
      return EXIT_BLOCKED;
    }
    if (parsed.planDigest !== digest) {
      deps.stderr(`BLOCKED: --plan-digest ${parsed.planDigest} does not match the current plan digest ${digest} (sets, arms, pins, scope or parameters changed); nothing was called`);
      return EXIT_BLOCKED;
    }
  }
  const cacheDir = deps.embed?.cacheDir === undefined ? (parsed.cacheDir === undefined ? DEFAULT_CACHE_DIR : resolve(parsed.cacheDir)) : deps.embed.cacheDir;
  const embedders = resolved.available.map(
    (pin) =>
      new ArmEmbedder(pin, {
        ...(deps.embed?.baseUrl === undefined && parsed.ollamaUrl === undefined ? {} : { baseUrl: deps.embed?.baseUrl ?? (parsed.ollamaUrl as string) }),
        ...(deps.embed?.fetch === undefined ? {} : { fetchImpl: deps.embed.fetch }),
        ...(deps.embed?.clock === undefined ? {} : { clock: deps.embed.clock }),
        cache: new EmbeddingCache(cacheDir === null ? undefined : cachePath(cacheDir, pin.spaceId)),
      }),
  );
  return { v1, v2, memory, inputs, digest, embedders, dropped: resolved.dropped, planned };
}

const stampOf = (deps: CliDeps): string => deps.now().toISOString().replace(/[:.]/g, '-');
const outDirOf = (parsed: Parsed): string => (parsed.out === undefined ? DEFAULT_OUT_DIR : resolve(parsed.out));
const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'error');

async function runEmbedPlanOrProbe(parsed: Parsed, deps: CliDeps): Promise<number> {
  const context = await embedContext(parsed, deps);
  if (typeof context === 'number') return context;
  const v1 = context.v1.map(bundleOf);
  const v2 = context.v2.map(bundleOf);
  const sample = latencySample(v2);
  if (parsed.mode === 'plan') {
    const plan = buildPlanReport(context.inputs, context.embedders, { v1, v2, memory: context.memory, sample });
    const path = deps.writeReport(outDirOf(parsed), `chunk-eval-embed-plan-${plan.digest.slice(0, 12)}-${stampOf(deps)}.json`, plan);
    for (const line of planLines(plan)) deps.stdout(line);
    deps.stdout(`report: ${path}`);
    return EXIT_OK;
  }
  if (context.embedders.length === 0 || v2.length === 0) {
    deps.stderr('INVALID: no embedder arm is available (every planned model is missing); nothing was called');
    return EXIT_INVALID;
  }
  const query = { text: (v2[0] as (typeof v2)[number]).item.question, language: (v2[0] as (typeof v2)[number]).item.language };
  const arms: ProbeReport['arms'] = {};
  try {
    for (const embedder of context.embedders) {
      (arms as Record<string, unknown>)[embedder.pin.arm] = await runProbeArm(embedder, sample, query);
      await embedder.unload();
    }
  } catch (error) {
    deps.stderr(`INVALID: the embedding provider failed during the probe: ${errorText(error)}`);
    return EXIT_INVALID;
  }
  const report: ProbeReport = { kind: 'chunk-eval-embed-probe', status: 'NON-GATING', plan: { digest: context.digest, planned: context.planned, dropped: context.dropped }, sample: { passages: sample.length, sha256: sampleDigest(sample) }, arms };
  const path = deps.writeReport(outDirOf(parsed), `chunk-eval-embed-probe-${context.digest.slice(0, 12)}-${stampOf(deps)}.json`, report);
  for (const line of probeLines(report)) deps.stdout(line);
  deps.stdout(`report: ${path}`);
  return EXIT_NON_GATING;
}

/** `--set v1|v2 --arms ... --mode run`: the CH1 embedder arms and EH(x) on one set. */
async function runEmbedSet(parsed: Parsed, deps: CliDeps): Promise<number> {
  if (parsed.set !== 'v1' && parsed.set !== 'v2') {
    deps.stderr('--arms with --mode run applies to --set v1, v2 or memory');
    return EXIT_USAGE;
  }
  const context = await embedContext(parsed, deps);
  if (typeof context === 'number') return context;
  if (context.embedders.length === 0) {
    deps.stderr('INVALID: no embedder arm is available (every planned model is missing); nothing was called');
    return EXIT_INVALID;
  }
  const cases: ChunkEvalCase[] = parsed.set === 'v1' ? context.v1 : context.v2;
  const bundles = cases.map(bundleOf);
  const arms: Record<string, EmbedderRun> = {};
  try {
    for (const embedder of context.embedders) {
      arms[embedder.pin.arm] = await runArmOnSet(embedder, { set: parsed.set, bundles, scope: parsed.scope, ...(parsed.shapes === undefined ? {} : { shapes: parsed.shapes }) });
      await embedder.unload();
    }
  } catch (error) {
    deps.stderr(`INVALID: the embedding provider failed: ${errorText(error)}`);
    return EXIT_INVALID;
  }
  const digest = parsed.set === 'v1' ? context.inputs.sets.v1.digest : context.inputs.sets.v2.digest;
  const report: ChunkEmbedReport = {
    kind: 'chunk-eval-embed',
    status: 'NON-GATING',
    set: parsed.set,
    corpus: { version: parsed.set === 'v1' ? CORPUS_VERSION : CORPUS_V2_VERSION, seed: parsed.set === 'v1' ? CORPUS_SEED : CORPUS_V2_SEED, sha256: digest, cases: cases.length },
    plan: { digest: context.digest, scope: parsed.scope, shapes: parsed.shapes ?? null, planned: context.planned, dropped: context.dropped },
    parameters: PARAMETERS,
    arms,
    note: 'CH1 thresholds are proposals; no gate is declared. EH(x) is reciprocal rank fusion (k = 60) of the arm ranking and the EL BM25 full ranking. EL is recomputed on exactly the cases each arm ran. Pins are read from the daemon at run start.',
  };
  const path = deps.writeReport(outDirOf(parsed), `chunk-eval-embed-${parsed.set}-${digest.slice(0, 12)}-${stampOf(deps)}.json`, report);
  for (const line of summaryLinesEmbed(report)) deps.stdout(line);
  deps.stdout(`report: ${path}`);
  if (cases.some((item) => !item.prepared.includes(item.needle.text))) {
    deps.stderr('INVALID: a needle is missing from its item; the numbers are not trustworthy');
    return EXIT_INVALID;
  }
  return EXIT_NON_GATING;
}

/** `--set memory`: verify / regenerate-freeze, the EL baseline, and (with `--arms`) the embedder arms and the section 6 verdict. */
async function runMemory(parsed: Parsed, deps: CliDeps): Promise<number> {
  const memoryDeps = deps.memory ?? defaultMemory();
  const set = memoryDeps.corpus();
  const digest = memoryDigest(set);
  const count = set.memories.length + set.queries.length;
  if (parsed.mode === 'regenerate-freeze') {
    memoryDeps.writeFreeze({ version: MEMORY_VERSION, seed: MEMORY_SEED, cases: count, sha256: digest });
    deps.stdout(`recorded memory set ${digest} (${set.memories.length} memories, ${set.queries.length} queries)`);
    return EXIT_OK;
  }
  const problem = freezeProblem('memory set', '--set memory', memoryDeps.readFreeze(), digest, MEMORY_VERSION, MEMORY_SEED, count);
  if (problem !== undefined) {
    deps.stderr(problem);
    return EXIT_BLOCKED;
  }
  if (parsed.mode === 'verify') {
    deps.stdout(`memory set matches the record: ${digest} (${set.memories.length} memories, ${set.queries.length} queries)`);
    return EXIT_OK;
  }
  const runs: Record<string, MemoryArmRun> = {};
  let plan = { digest: null as string | null, planned: [] as string[], dropped: [] as { arm: string; reason: string }[] };
  if (parsed.arms !== undefined) {
    const context = await embedContext(parsed, deps);
    if (typeof context === 'number') return context;
    if (context.embedders.length === 0) {
      deps.stderr('INVALID: no embedder arm is available (every planned model is missing); nothing was called');
      return EXIT_INVALID;
    }
    const v2 = context.v2.map(bundleOf);
    const sample = latencySample(v2);
    const first = v2[0] as (typeof v2)[number];
    try {
      for (const embedder of context.embedders) {
        runs[embedder.pin.arm] = await runMemoryArm(embedder, set, { sample, query: { text: first.item.question, language: first.item.language } });
        await embedder.unload();
      }
    } catch (error) {
      deps.stderr(`INVALID: the embedding provider failed: ${errorText(error)}`);
      return EXIT_INVALID;
    }
    plan = { digest: context.digest, planned: [...context.planned], dropped: [...context.dropped] };
  }
  const report = buildMemoryReport(set, digest, runs, plan, parsed.arms !== undefined);
  const path = deps.writeReport(outDirOf(parsed), `chunk-eval-memory-${digest.slice(0, 12)}-${stampOf(deps)}.json`, report);
  for (const line of summaryLinesMemory(report)) deps.stdout(line);
  deps.stdout(`report: ${path}`);
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
