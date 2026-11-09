/**
 * ADR-0124 Part L C5a slice 3 (DECISIONS ADR-0124 section 17): the CH3 (S3 whole-item summary) and CH5 (latency and
 * resources) harness, arm L against today's path.
 *
 *   pnpm eval:chunk-s3 -- --mode verify                 check the generated CH3 corpus against its freeze record (no run)
 *   pnpm eval:chunk-s3 -- --mode regenerate-freeze      SEPARATE command: record the corpus digest (after a deliberate change)
 *   pnpm eval:chunk-s3 -- --mode plan --local-model <name[:tag]> --local-digest <12 hex> [--today-model <id>]
 *                                                       ZERO model calls: call counts, minutes, owner labels, the plan digest,
 *                                                       and the local model's read-only readiness probe
 *   pnpm eval:chunk-s3 -- --mode run --digest <plan digest> --local-model ... --local-digest ... [--today-model <id>] [--out <dir>]
 *                                                       Strict (owner yes on the digest): arm L on the local model, today's path
 *                                                       on the chat tier, the content-free report, the blind sheet and its key
 *   pnpm eval:chunk-s3 -- --mode score-labels --sheet <path> --key <path> --report <path>
 *                                                       the owner's filled blind sheet: the one-sided binomial test and the
 *                                                       final CH3 verdict
 *
 * Exit codes (as the other eval tools): 0 PASSED (score-labels) or OK (verify, regenerate-freeze, plan), 1 FAILED, 2 USAGE,
 * 3 BLOCKED (corpus differs from its record, no or a stale --digest, an unpinned, cloud or unready local model, an incomplete
 * or edited sheet), 4 NON-GATING (a completed run: the preference gate needs the owner's labels), 5 INVALID (a provider
 * outage or a run that never reached the local model).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ClaudeCliProvider } from '@quoky/ai-cli';
import type { AiProvider } from '@quoky/core';
import { ChunkItemsConfigError } from '../item-summary/chunk-items-config';
import { CH3_CORPUS_SEED, CH3_CORPUS_VERSION, ch3CorpusDigest, generateCh3Corpus, type Ch3Case } from './chunk-s3-eval/ch3-corpus';
import { CH3_BARS, buildCh3Plan, buildCh3Report, buildCh5, planLinesCh3, runCh3, summaryLinesCh3, type Ch3Report } from './chunk-s3-eval/ch3-eval';
import { buildBlindSheet, loadRubricWording, renderSheetMarkdown, scoreFilledSheet, type BlindKey, type BlindSheet, type RubricWording } from './chunk-s3-eval/blind-sheet';
import { composeLocalArm, sampleOllamaRss, startRssSampler, type LocalArm, type LocalArmOptions, type RssSample } from './chunk-s3-eval/local-arm';
import { guardEvalProvider, providerCanary, type ProviderOutageReport } from './eval-provider-guard';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_NON_GATING = 4;
export const EXIT_INVALID = 5;

const repoRoot = resolve(__dirname, '../../../..');
export const CH3_FREEZE_PATH = resolve(repoRoot, 'apps/quoky/src/tools/chunk-s3-eval/chunk-s3-ch3-corpus.freeze.v1.json');
const DEFAULT_OUT_DIR = resolve(repoRoot, 'data/eval');

export interface FreezeRecord {
  readonly version: string;
  readonly seed: string;
  readonly cases: number;
  readonly sha256: string;
}

export interface S3CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  /** Monotonic milliseconds. */
  readonly clock: () => number;
  readonly corpus: () => Ch3Case[];
  readonly readFreeze: () => FreezeRecord | undefined;
  readonly writeFreeze: (record: FreezeRecord) => void;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, text: string) => void;
  readonly localArm: (options: LocalArmOptions) => LocalArm;
  readonly todayProvider: (model: string | null) => AiProvider;
  readonly rss: () => Promise<RssSample | undefined>;
  readonly rubric: () => RubricWording;
  /** Tests only: the blind sheet seed (default: fresh random per run). */
  readonly seed?: string;
}

export function defaultDeps(): S3CliDeps {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    clock: () => performance.now(),
    corpus: generateCh3Corpus,
    readFreeze: () => {
      try {
        return JSON.parse(readFileSync(CH3_FREEZE_PATH, 'utf8')) as FreezeRecord;
      } catch {
        return undefined;
      }
    },
    writeFreeze: (record) => writeFileSync(CH3_FREEZE_PATH, `${JSON.stringify(record, null, 2)}\n`),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    localArm: composeLocalArm,
    todayProvider: (model) => new ClaudeCliProvider('claude', model !== null ? { model } : {}),
    rss: sampleOllamaRss,
    rubric: () => loadRubricWording(),
  };
}

class UsageError extends Error {}

type Mode = 'verify' | 'regenerate-freeze' | 'plan' | 'run' | 'score-labels';
interface Parsed {
  readonly mode: Mode;
  readonly digest?: string;
  readonly localModel?: string;
  readonly localDigest?: string;
  readonly todayModel: string | null;
  readonly out?: string;
  readonly sheet?: string;
  readonly key?: string;
  readonly report?: string;
}

const USAGE = [
  'usage: pnpm eval:chunk-s3 -- --mode verify|regenerate-freeze|plan|run|score-labels [options]',
  '  plan|run        --local-model <name[:tag]> --local-digest <12 hex, the ollama list ID> [--today-model <id>]',
  '  run             --digest <plan digest from --mode plan> [--out <dir>, default data/eval]',
  '  score-labels    --sheet <filled sheet.json> --key <key.json> --report <report.json>',
].join('\n');

const VALUE_FLAGS = new Set(['--mode', '--digest', '--local-model', '--local-digest', '--today-model', '--out', '--sheet', '--key', '--report']);

export function parseArguments(argv: readonly string[]): Parsed | 'help' {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at] as string;
    if (flag === '--') continue;
    if (flag === '--help' || flag === '-h') return 'help';
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown argument ${flag}`);
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    if (values.has(flag)) throw new UsageError(`${flag} given twice`);
    values.set(flag, value);
    at += 1;
  }
  const mode = values.get('--mode');
  if (mode !== 'verify' && mode !== 'regenerate-freeze' && mode !== 'plan' && mode !== 'run' && mode !== 'score-labels') throw new UsageError('--mode must be verify, regenerate-freeze, plan, run or score-labels');
  const only = (flags: readonly string[], modes: readonly Mode[]): void => {
    for (const flag of flags) if (values.has(flag) && !modes.includes(mode)) throw new UsageError(`${flag} applies to --mode ${modes.join(', ')} only`);
  };
  only(['--local-model', '--local-digest', '--today-model'], ['plan', 'run']);
  only(['--digest', '--out'], ['run']);
  only(['--sheet', '--key', '--report'], ['score-labels']);
  if (mode === 'score-labels' && (!values.has('--sheet') || !values.has('--key') || !values.has('--report'))) throw new UsageError('score-labels needs --sheet, --key and --report');
  const get = (flag: string): string | undefined => values.get(flag);
  return {
    mode,
    todayModel: get('--today-model') ?? null,
    ...(get('--digest') !== undefined ? { digest: get('--digest') as string } : {}),
    ...(get('--local-model') !== undefined ? { localModel: get('--local-model') as string } : {}),
    ...(get('--local-digest') !== undefined ? { localDigest: get('--local-digest') as string } : {}),
    ...(get('--out') !== undefined ? { out: get('--out') as string } : {}),
    ...(get('--sheet') !== undefined ? { sheet: get('--sheet') as string } : {}),
    ...(get('--key') !== undefined ? { key: get('--key') as string } : {}),
    ...(get('--report') !== undefined ? { report: get('--report') as string } : {}),
  };
}

function freezeProblem(record: FreezeRecord | undefined, digest: string, cases: number): string | undefined {
  if (record === undefined) return 'BLOCKED: no recorded CH3 corpus hash; run --mode regenerate-freeze once, review, and commit the record';
  if (record.sha256 !== digest || record.version !== CH3_CORPUS_VERSION || record.seed !== CH3_CORPUS_SEED || record.cases !== cases) {
    return `BLOCKED: the CH3 corpus differs from the recorded hash (recorded ${record.sha256}, generated ${digest}); nothing was run`;
  }
  return undefined;
}

const stampOf = (deps: S3CliDeps): string => deps.now().toISOString().replace(/[:.]/g, '-');

export async function runCli(argv: readonly string[], deps: S3CliDeps = defaultDeps()): Promise<number> {
  let parsed: Parsed | 'help';
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : 'usage error'}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed === 'help') {
    deps.stdout(USAGE);
    return EXIT_OK;
  }
  if (parsed.mode === 'score-labels') return scoreLabels(parsed, deps);

  const cases = deps.corpus();
  const corpusDigest = ch3CorpusDigest(cases);
  if (parsed.mode === 'regenerate-freeze') {
    deps.writeFreeze({ version: CH3_CORPUS_VERSION, seed: CH3_CORPUS_SEED, cases: cases.length, sha256: corpusDigest });
    deps.stdout(`recorded CH3 corpus ${corpusDigest} (${cases.length} items)`);
    return EXIT_OK;
  }
  const problem = freezeProblem(deps.readFreeze(), corpusDigest, cases.length);
  if (problem !== undefined) {
    deps.stderr(problem);
    return EXIT_BLOCKED;
  }
  if (parsed.mode === 'verify') {
    deps.stdout(`CH3 corpus matches its record: ${corpusDigest} (${cases.length} items)`);
    return EXIT_OK;
  }
  // An unpinned local model is refused before anything else (plan and run).
  if (parsed.localModel === undefined || parsed.localDigest === undefined) {
    deps.stderr('BLOCKED: arm L needs --local-model and --local-digest (the 12-hex ID `ollama list` prints); an unpinned local model is refused; nothing was called');
    return EXIT_BLOCKED;
  }
  const plan = buildCh3Plan({ cases, corpusDigest, local: { model: parsed.localModel, digest: parsed.localDigest }, today: { provider: 'claude-cli', model: parsed.todayModel } });
  let arm: LocalArm;
  try {
    arm = deps.localArm({ model: parsed.localModel, digest: parsed.localDigest, clock: deps.clock, maxCalls: plan.armL.calls });
  } catch (error) {
    deps.stderr(`BLOCKED: the local model is refused (${error instanceof ChunkItemsConfigError ? error.code : 'invalid model or pin'}); nothing was called`);
    return EXIT_BLOCKED;
  }
  if (parsed.mode === 'plan') {
    for (const line of planLinesCh3(plan)) deps.stdout(line);
    const ready = await arm.ready();
    deps.stdout(`  local model ready (read-only local-weights and pin probe): ${ready ? 'yes' : 'NO: run would be refused'}`);
    return EXIT_OK;
  }
  if (parsed.digest === undefined) {
    deps.stderr(`BLOCKED: a model-in-the-loop run needs --digest from --mode plan (current plan digest ${plan.digest}); nothing was called`);
    return EXIT_BLOCKED;
  }
  if (parsed.digest !== plan.digest) {
    deps.stderr(`BLOCKED: --digest ${parsed.digest} does not match the current plan digest ${plan.digest} (corpus, model, pin, prompts or parameters changed); nothing was called`);
    return EXIT_BLOCKED;
  }
  if (!(await arm.ready())) {
    deps.stderr(`BLOCKED: the local model ${parsed.localModel}@${parsed.localDigest} is not ready (not installed, the pin differs, or no positive local-weights evidence); nothing was called`);
    return EXIT_BLOCKED;
  }

  for (const line of planLinesCh3(plan)) deps.stdout(line);
  const rawToday = deps.todayProvider(parsed.todayModel);
  const today = guardEvalProvider(rawToday, { maxCalls: plan.today.calls, canary: providerCanary(rawToday) });
  const sampler = startRssSampler(deps.rss);
  let rss: Awaited<ReturnType<typeof sampler.stop>> | undefined;
  const runs = await runCh3(cases, {
    selector: arm.selector,
    exclusive: arm.exclusive,
    now: deps.clock,
    today: today.provider,
    progress: deps.stdout,
    afterLocal: async () => {
      rss = await sampler.stop();
    },
  });
  rss ??= await sampler.stop();
  await arm.guard.settle();
  await today.settle();
  const providers: { local: ProviderOutageReport; today: ProviderOutageReport } = { local: arm.guard.report(), today: today.report() };
  const ch5 = buildCh5(cases, runs, { callMs: arm.meter.calls().map((call) => call.ms), embeddings: arm.meter.embeddings(), maxInFlight: arm.meter.maxInFlight() }, rss);
  const { report } = buildCh3Report(plan, cases, runs, ch5, providers);

  const outDir = parsed.out === undefined ? DEFAULT_OUT_DIR : resolve(parsed.out);
  const stamp = stampOf(deps);
  const base = resolve(outDir, `chunk-s3-ch3-${stamp}`);
  deps.writeFile(`${base}.report.json`, `${JSON.stringify(report, null, 2)}\n`);
  const byId = new Map(runs.map((run) => [run.id, run] as const));
  const { sheet, key } = buildBlindSheet(
    cases.map((c) => ({
      caseId: c.item.id,
      request: c.item.requestText,
      item: { shape: c.item.shape, language: c.item.language, title: c.item.title, codePoints: c.preparedCodePoints },
      keyPoints: c.keyPoints.map((k) => k.text),
      answers: { S3: byId.get(c.item.id)?.s3.body ?? '', today: byId.get(c.item.id)?.today.body ?? '' },
    })),
    { planDigest: plan.digest, rubric: deps.rubric(), ...(deps.seed !== undefined ? { seed: deps.seed } : {}) },
  );
  deps.writeFile(`${base}.sheet.json`, `${JSON.stringify(sheet, null, 2)}\n`);
  deps.writeFile(`${base}.sheet.md`, renderSheetMarkdown(sheet));
  deps.writeFile(`${base}.key.json`, `${JSON.stringify(key, null, 2)}\n`);
  deps.writeFile(`${base}.items.md`, itemsMarkdown(cases));
  for (const line of summaryLinesCh3(report)) deps.stdout(line);
  deps.stdout(`  report ${base}.report.json`);
  deps.stdout(`  blind sheet ${base}.sheet.json (read ${base}.sheet.md, items ${base}.items.md); key ${base}.key.json (do not open before labelling)`);
  if (report.status === 'INVALID') return EXIT_INVALID;
  if (report.status === 'FAILED') return EXIT_FAILED;
  return EXIT_NON_GATING;
}

function itemsMarkdown(cases: readonly Ch3Case[]): string {
  const lines = ['# CH3 synthetic items (fictional; for the blind labelling)', ''];
  for (const c of cases) {
    const item = c.item;
    lines.push(`## ${item.id}`, '', `- ${item.shape}, ${item.language}, "${item.title}", ${c.preparedCodePoints} code points`, '', '```text');
    if (item.body !== undefined) lines.push(item.body);
    for (const message of item.messages ?? []) lines.push(`--- ${message.senderName} <${message.senderAddress}> ${message.receivedAt} | ${message.subject}`, message.body);
    for (const sheet of item.sheets ?? []) lines.push(`--- [${sheet.title}]`, sheet.body);
    lines.push('```', '');
  }
  return `${lines.join('\n')}\n`;
}

async function scoreLabels(parsed: Parsed, deps: S3CliDeps): Promise<number> {
  let sheet: BlindSheet;
  let key: BlindKey;
  let report: Ch3Report;
  try {
    sheet = JSON.parse(deps.readFile(resolve(parsed.sheet as string))) as BlindSheet;
    key = JSON.parse(deps.readFile(resolve(parsed.key as string))) as BlindKey;
    report = JSON.parse(deps.readFile(resolve(parsed.report as string))) as Ch3Report;
  } catch (error) {
    deps.stderr(`BLOCKED: could not read the sheet, key or report (${error instanceof Error ? error.message : 'error'})`);
    return EXIT_BLOCKED;
  }
  if (report?.kind !== 'chunk-s3-ch3-report' || key?.planDigest !== report.planDigest) {
    deps.stderr('BLOCKED: the key and the report belong to different runs (plan digests differ)');
    return EXIT_BLOCKED;
  }
  if (report.status === 'INVALID') {
    deps.stderr('INVALID: the run itself was invalid; its sheet is not a gate input');
    return EXIT_INVALID;
  }
  const scored = scoreFilledSheet(sheet, key);
  if (!scored.ok) {
    for (const problem of scored.problems) deps.stderr(`BLOCKED: ${problem}`);
    return EXIT_BLOCKED;
  }
  const runPass = report.verdict.coverage.pass && report.verdict.invented.pass;
  const pass = runPass && scored.pass;
  deps.stdout(`CH3 ${pass ? 'PASSED' : 'FAILED'} (plan ${report.planDigest}, sheet ${sheet.sheetId})`);
  deps.stdout(`  coverage ${(report.verdict.coverage.value * 100).toFixed(1)}% (bar ${CH3_BARS.coverage * 100}%): ${report.verdict.coverage.pass ? 'pass' : 'FAIL'}`);
  deps.stdout(`  invented-free items ${(report.verdict.invented.inventedFreeShare * 100).toFixed(1)}% (bar ${CH3_BARS.inventedFreeShare * 100}%): ${report.verdict.invented.pass ? 'pass' : 'FAIL'}`);
  deps.stdout(`  preference: ${scored.reason} (${scored.ties} ties): ${scored.pass ? 'pass' : 'FAIL'}`);
  deps.stdout(`  owner labels S3 ${JSON.stringify(scored.labels.S3)}, today ${JSON.stringify(scored.labels.today)}; usable+ S3 ${scored.usablePlus.S3}, today ${scored.usablePlus.today}`);
  return pass ? EXIT_OK : EXIT_FAILED;
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
