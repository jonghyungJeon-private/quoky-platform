/**
 * ADR-0123 phase 1 (RAG-1 / RAG-2): the offline selector-example retrieval experiment harness.
 *
 *   pnpm eval:rag -- --mode lint                                  offline: pool schema, identifier rule, n-gram lint, coverage
 *   pnpm eval:rag -- --mode dry-run [--models a,b] [--write-audit] embeds pool and gold (local Ollama, loopback), calibrates tau,
 *                                                                  buckets, simulates retrieval; makes NO selector call
 *   pnpm eval:rag -- --mode plan  --split dev|heldout [--selector-model haiku]        offline: prints the pre-registered plan and its digest
 *   pnpm eval:rag -- --mode run --split dev|heldout --approved-plan-digest <sha256>   Strict: the same digest rule as eval:nl; the digest binds the split. Renders every arm through
 *                                                                  Core's `retrievedExamples` slot and walks the interleaved schedule
 *                                                                  with an injected selector transport
 *
 * RAG-2 is experiment-only: nothing here is read by the running service and `QUOKY_NL_EXAMPLE_RETRIEVAL` (RAG-3, ADR-0123 D10)
 * is not wired. `run` recomputes the plan digest and exits 3 unless `--approved-plan-digest` equals it; even then it stops
 * before any embedding or provider unless the caller injects a selector transport (`CliDeps.selector`); this CLI never
 * constructs one, so it makes no selector call. The traffic ledger and the rate gate (`ledger.ts`) are what the transport
 * must call before every selector call.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DEFAULT_CLAUDE_INTENT_SELECTION_MODEL } from '@quoky/ai-cli';
import { runEmbedAudit, type ModelAudit } from './selector-rag/audit';
import { DEFAULT_OLLAMA_URL, OllamaHttpEmbedder, readPin } from './selector-rag/embed';
import { contaminatedGoldIds, loadCalibrationPositives, loadGold, loadKnownFindings } from './selector-rag/gold';
import { buildRagPlan, ragPlanDigest } from './selector-rag/plan';
import { approvedEntries, checkPool, loadPoolFile, poolDigest, type PoolEntry } from './selector-rag/pool';
import { splitCases } from './selector-rag/split';
import { A6_ENTRY_IDS, READ_ENTRY_IDS, staticExamples } from './selector-rag/audit';
import { buildSchedule } from './selector-rag/arms';
import { outputEntryId, type PoolVector } from './selector-rag/retrieve';
import { runExperiment, type ExperimentCase, type PromptContext, type RetrievalRecord } from './selector-rag/selector-rag-eval';
import { NL_ACTION_PROMPT_VERSION, NL_SELECTION_PROMPT_VERSION } from '@quoky/core';
import type { GoldCase } from './selector-rag/gold';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;

// ADR-0123 (owner decision 2026-10-16): nomic-embed-text-v2-moe (digest ff9c2f10ef5e) is the sole retrieval embedding model.
// nomic-embed-text (v1.5) failed its audit and is not a retrieval candidate; the plan binds only this model.
export const RETRIEVAL_EMBEDDING_MODEL = 'nomic-embed-text-v2-moe';
export const DEFAULT_EMBEDDING_MODELS = [RETRIEVAL_EMBEDDING_MODEL] as const;
const repoRoot = resolve(__dirname, '../../../..');
const EVAL_DIR = resolve(repoRoot, 'data/eval/selector-rag');
export const AUDIT_RECORD_PATH = resolve(__dirname, '../../../../apps/quoky/src/tools/selector-rag/selector-pool.audit.v1.json');

const OPTIONS = new Set(['--mode', '--models', '--pool', '--write-audit', '--selector-model', '--runs', '--sessions', '--approved-plan-digest', '--ollama-url', '--latency-sample', '--audit', '--split']);
export class UsageError extends Error {}

export function parseArguments(argv: readonly string[]): { mode: 'lint' | 'dry-run' | 'plan' | 'run' | 'help'; options: Record<string, string> } {
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
  if (mode !== 'lint' && mode !== 'dry-run' && mode !== 'plan' && mode !== 'run') throw new UsageError('--mode must be lint, dry-run, plan or run');
  if ((mode === 'plan' || mode === 'run') && options['--split'] !== 'dev' && options['--split'] !== 'heldout') throw new UsageError(`${mode} requires --split dev|heldout (each split has its own approval)`);
  if (mode !== 'plan' && mode !== 'run' && options['--split'] !== undefined) throw new UsageError('--split is only for plan and run');
  if (mode === 'run' && options['--approved-plan-digest'] === undefined) throw new UsageError('run requires --approved-plan-digest');
  if (mode !== 'run' && options['--approved-plan-digest'] !== undefined) throw new UsageError('--approved-plan-digest is only for run');
  return { mode, options };
}

const HELP = `ADR-0123 selector example retrieval harness (phase 1, offline)
  pnpm eval:rag -- --mode lint [--pool <file>]
  pnpm eval:rag -- --mode dry-run [--models nomic-embed-text-v2-moe] [--write-audit true] [--latency-sample 50]
  pnpm eval:rag -- --mode plan --split dev|heldout [--selector-model ${DEFAULT_CLAUDE_INTENT_SELECTION_MODEL}] [--runs 5] [--sessions 3]
  pnpm eval:rag -- --mode run --split dev|heldout --approved-plan-digest <sha256 from plan>   (Strict; needs an injected selector transport, none is built in)
No mode makes a selector call. dry-run embeds through the local Ollama on loopback only.
`;

export interface CliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => string;
  /** The selector transport and per-case prompt context for `run`. Never set by the CLI entry point (no call is possible). */
  readonly selector?: SelectorTransport;
}

export interface SelectorTransport {
  readonly select: (prompt: string, record: RetrievalRecord) => Promise<string>;
  readonly parseEntry: (raw: string) => string;
  readonly contextFor: (golden: GoldCase) => PromptContext;
}
export const defaultDeps = (): CliDeps => ({
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  now: () => new Date().toISOString(),
});

export interface AuditRecord {
  readonly version: 1;
  readonly description: string;
  readonly poolDigest: string;
  readonly goldDigest: string;
  readonly splitSha256: string;
  readonly prefixPolicy: string;
  readonly models: ReadonlyArray<{
    readonly model: string;
    readonly spaceId: string;
    readonly tau: number;
    readonly tauLow: number | null;
    readonly minPositive: number;
    readonly positives: number;
    readonly negatives: number;
    readonly falsePositiveRate: number;
    readonly flaggedPairs: ReadonlyArray<{ readonly poolId: string; readonly goldId: string; readonly cosine: number }>;
    readonly heldOutLowShare: number | null;
    readonly lowStratumValid: boolean | null;
  }>;
}

const r4 = (n: number): number => Math.round(n * 10000) / 10000;

export function toAuditRecord(audits: readonly ModelAudit[], splitSha256: string): AuditRecord {
  const first = audits[0];
  if (first === undefined) throw new Error('no audit');
  return {
    version: 1,
    description: 'ADR-0123 D5 embedding audit record. Regenerate with `pnpm eval:rag -- --mode dry-run --write-audit true`; a stale record (pool or gold digest) fails the suite.',
    poolDigest: first.poolDigest,
    goldDigest: first.goldDigest,
    splitSha256,
    prefixPolicy: 'search_query: on both sides (pool and gold)',
    models: audits.map((audit) => ({
      model: audit.model,
      spaceId: audit.spaceId,
      tau: r4(audit.calibration.tau),
      tauLow: audit.tauLow === null ? null : r4(audit.tauLow),
      minPositive: r4(audit.calibration.minPositive),
      positives: audit.calibration.positives,
      negatives: audit.calibration.negatives,
      falsePositiveRate: r4(audit.calibration.falsePositiveRate),
      flaggedPairs: audit.flaggedPairs.map((pair) => ({ ...pair, cosine: r4(pair.cosine) })),
      heldOutLowShare: audit.buckets.heldOut === null ? null : r4(audit.buckets.heldOut.lowShare),
      lowStratumValid: audit.buckets.heldOut === null ? null : audit.buckets.heldOut.valid,
    })),
  };
}

function splitOf(gold: ReturnType<typeof loadGold>): { split: ReturnType<typeof splitCases>; sha256: string } {
  const split = splitCases(gold.cases.map((golden) => ({ id: golden.id, entry: golden.entry })));
  return { split, sha256: createHash('sha256').update(JSON.stringify(split)).digest('hex') };
}

function lintReport(deps: CliDeps, entries: readonly PoolEntry[], gold: ReturnType<typeof loadGold>): boolean {
  const report = checkPool(entries, gold.cases);
  deps.stdout(`pool: ${report.entries} entries, digest ${report.digest}`);
  deps.stdout(`schema/identifier/credential problems: ${report.schemaProblems.length}; duplicates: ${report.duplicates.length}; n-gram findings vs gold: ${report.findings.length}`);
  for (const problem of report.schemaProblems.slice(0, 40)) deps.stdout(`  ${problem.id}: ${problem.problems.join('; ')}`);
  for (const duplicate of report.duplicates.slice(0, 20)) deps.stdout(`  duplicate: ${duplicate}`);
  for (const finding of report.findings.slice(0, 40)) deps.stdout(`  finding ${finding.poolId} ~ ${finding.goldId} ${finding.kind} tokenJ ${finding.tokenJ} charJ ${finding.charJ} contain ${finding.contain}`);
  const c = report.coverage;
  deps.stdout(`coverage: ${c.total} entries (target >= 150), negatives ${c.negatives} (${(c.negativeShare * 100).toFixed(0)}%, target >= 20%); below ${5} per entry: ${c.entriesBelowTarget.join(', ') || 'none'}; target met: ${c.targetMet}`);
  deps.stdout(`lint: ${report.ok ? 'PASSED' : 'FAILED'}`);
  return report.ok;
}

export async function runCli(argv: readonly string[], deps: CliDeps = defaultDeps()): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
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
  const options = parsed.options;
  const pool = loadPoolFile(options['--pool']);
  const gold = loadGold();
  const { split, sha256: splitSha256 } = splitOf(gold);
  if (parsed.mode === 'lint') return lintReport(deps, pool.entries, gold) ? EXIT_OK : EXIT_FAILED;

  if (parsed.mode === 'dry-run') {
    if (!lintReport(deps, pool.entries, gold)) {
      deps.stderr('the pool failed the offline lint; nothing was embedded');
      return EXIT_FAILED;
    }
    const known = loadKnownFindings();
    const baseUrl = options['--ollama-url'] ?? DEFAULT_OLLAMA_URL;
    const models = (options['--models'] ?? DEFAULT_EMBEDDING_MODELS.join(',')).split(',').map((model) => model.trim()).filter(Boolean);
    const audits: ModelAudit[] = [];
    for (const model of models) {
      const embedder = new OllamaHttpEmbedder(await readPin(model, baseUrl), baseUrl);
      deps.stdout(`space ${embedder.pin.spaceId} (prefix "${embedder.pin.prefix}")`);
      audits.push(
        await runEmbedAudit({
          embedder,
          pool: pool.entries,
          gold: gold.cases,
          goldDigest: gold.sha256,
          split,
          known,
          positives: loadCalibrationPositives(),
          storeDirectory: resolve(EVAL_DIR, 'store'),
          latencySample: options['--latency-sample'] === undefined ? 50 : Number(options['--latency-sample']),
          log: deps.stderr,
        }),
      );
    }
    for (const audit of audits) printAudit(deps, audit, contaminatedGoldIds(known).size);
    mkdirSync(EVAL_DIR, { recursive: true });
    const path = resolve(EVAL_DIR, `dry-run-${deps.now().replace(/[:.]/g, '-')}.json`);
    writeFileSync(path, `${JSON.stringify({ at: deps.now(), poolDigest: poolDigest(pool.entries), goldDigest: gold.sha256, splitSha256, split: { dev: split.dev.length, heldOut: split.heldOut.length }, audits }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    deps.stdout(`dry-run record: ${path}`);
    if (options['--write-audit'] === 'true') {
      writeFileSync(AUDIT_RECORD_PATH, `${JSON.stringify(toAuditRecord(audits, splitSha256), null, 2)}\n`);
      deps.stdout(`audit record written: ${AUDIT_RECORD_PATH}`);
    }
    deps.stdout('no selector call was made');
    return audits.every((audit) => audit.flaggedPairs.length === 0 && audit.abort === null) ? EXIT_OK : EXIT_FAILED;
  }

  // plan / run: only owner-approved pool batches count, and the audit record must be fresh for exactly this pool and gold
  const entries = approvedEntries(pool);
  if (entries.length === 0 || entries.length !== pool.entries.length) {
    deps.stderr('BLOCKED: every pool entry must belong to an owner-approved batch (the drafter never approves); nothing was planned');
    return EXIT_BLOCKED;
  }
  let audit: AuditRecord;
  try {
    audit = JSON.parse(readFileSync(options['--audit'] ?? AUDIT_RECORD_PATH, 'utf8')) as AuditRecord;
  } catch {
    deps.stderr('BLOCKED: no embedding audit record; run --mode dry-run --write-audit true first');
    return EXIT_BLOCKED;
  }
  if (audit.poolDigest !== poolDigest(entries) || audit.goldDigest !== gold.sha256 || audit.splitSha256 !== splitSha256) {
    deps.stderr('BLOCKED: the audit record is stale (pool, gold or split changed); re-run the dry-run audit');
    return EXIT_BLOCKED;
  }
  // A model whose audit failed (flagged pool pairs, an aborted tau, an invalid low-similarity stratum) is dropped from the
  // plan, never bent to fit; the plan is blocked only when no model is left.
  const usable = audit.models.filter((model) => model.model === RETRIEVAL_EMBEDDING_MODEL && model.tauLow !== null && model.flaggedPairs.length === 0 && model.lowStratumValid === true);
  for (const dropped of audit.models.filter((model) => !usable.includes(model))) deps.stderr(`dropped from the plan: ${dropped.model} (not the pinned retrieval model, or its audit failed: flagged pairs, aborted tau or invalid low-similarity stratum)`);
  if (usable.length === 0) {
    deps.stderr('BLOCKED: no embedding model passed its audit; fix the pool, not the plan');
    return EXIT_BLOCKED;
  }
  const known = loadKnownFindings();
  const contaminated = contaminatedGoldIds(known);
  const plan = buildRagPlan({
    poolDigest: audit.poolDigest,
    goldDigest: gold.sha256,
    splitSha256,
    devCases: split.dev.length,
    heldOutCases: split.heldOut.filter((id) => !contaminated.has(id)).length,
    excludedContaminated: split.heldOut.filter((id) => contaminated.has(id)).length,
    models: usable.map((model) => ({ model: model.model, spaceId: model.spaceId, prefix: audit.prefixPolicy, tau: model.tau, tauLow: model.tauLow as number })),
    split: options['--split'] as 'dev' | 'heldout',
    selectorModel: options['--selector-model'] ?? DEFAULT_CLAUDE_INTENT_SELECTION_MODEL,
    ...(options['--runs'] !== undefined ? { runs: Number(options['--runs']) } : {}),
    ...(options['--sessions'] !== undefined ? { sessions: Number(options['--sessions']) } : {}),
  });
  const digest = ragPlanDigest(plan);
  if (parsed.mode === 'plan') {
    deps.stdout(JSON.stringify(plan, null, 2));
    deps.stdout(`plan digest (sha256): ${digest}`);
    deps.stdout('nothing was executed; a run needs --approved-plan-digest equal to this digest');
    return EXIT_OK;
  }
  if (options['--approved-plan-digest'] !== digest) {
    deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
    return EXIT_BLOCKED;
  }
  const transport = deps.selector;
  if (transport === undefined) {
    deps.stderr('BLOCKED: the digest matches, but no selector transport is injected; this harness build makes no selector call (nothing was embedded or executed)');
    return EXIT_BLOCKED;
  }
  const split_ = plan.split_scope;
  const modelPin = usable[0] as (typeof usable)[number];
  const embedder = new OllamaHttpEmbedder(await readPin(modelPin.model, options['--ollama-url'] ?? DEFAULT_OLLAMA_URL), options['--ollama-url'] ?? DEFAULT_OLLAMA_URL);
  if (embedder.pin.spaceId !== modelPin.spaceId) {
    deps.stderr('BLOCKED: the live embedding space differs from the approved plan; nothing was executed');
    return EXIT_BLOCKED;
  }
  const ids = new Set(split_ === 'dev' ? split.dev : split.heldOut.filter((id) => !contaminated.has(id)));
  const goldCases = gold.cases.filter((golden) => ids.has(golden.id));
  const poolEmbed = await embedder.embed(entries.map((entry) => entry.text));
  const poolVectors: PoolVector[] = entries.map((entry, index) => ({ entry, entryId: outputEntryId(entry), vector: poolEmbed[index] as number[] }));
  const queryEmbed = await embedder.embed(goldCases.map((golden) => golden.queryText));
  const cases = new Map<string, ExperimentCase>(
    goldCases.map((golden, index) => [golden.id, { id: golden.id, entry: golden.entry, context: transport.contextFor(golden), offered: golden.corpus === 'read' ? READ_ENTRY_IDS : A6_ENTRY_IDS, queryVector: queryEmbed[index] as number[] }] as const),
  );
  const statics = staticExamples();
  // arms and runs come from the approved plan (its split scope), never from a flag read after the digest check
  const arms = plan.arms;
  const schedule = buildSchedule({ caseIds: goldCases.map((golden) => golden.id), arms, runs: plan.runs, sessions: plan.sessions, seed: `${digest}:${split_}` });
  const results = await runExperiment({
    schedule,
    arms,
    cases,
    pool: poolVectors,
    poolDigest: plan.poolDigest,
    spaceId: modelPin.spaceId,
    staticTexts: statics.texts,
    baseVersion: (offered) => (offered === READ_ENTRY_IDS ? NL_SELECTION_PROMPT_VERSION : NL_ACTION_PROMPT_VERSION),
    select: transport.select,
    parseEntry: transport.parseEntry,
  });
  mkdirSync(EVAL_DIR, { recursive: true });
  const path = resolve(EVAL_DIR, `run-${split_}-${deps.now().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify({ at: deps.now(), planDigest: digest, split: split_, results }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  deps.stdout(`run record (content-free): ${path}`);
  return EXIT_OK;
}

function printAudit(deps: CliDeps, audit: ModelAudit, contaminatedKnown: number): void {
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const c = audit.calibration;
  deps.stdout(`== ${audit.model} (${audit.spaceId}) ==`);
  deps.stdout(`pool ${audit.poolSize}, gold ${audit.goldSize}; embed time pool ${s(audit.embedMs.pool)}, gold ${s(audit.embedMs.gold)}, total ${s(audit.embedMs.total)}`);
  deps.stdout(`tau ${c.tau.toFixed(4)} (min positive ${c.minPositive.toFixed(4)} - ${c.margin}; ${c.positives} positive, ${c.negatives} negative pairs; negative max ${c.negativeMax.toFixed(3)}, p99 ${c.negativeP99.toFixed(3)}, false-positive rate ${(c.falsePositiveRate * 100).toFixed(1)}%)`);
  deps.stdout(`tau_low ${audit.tauLow === null ? `ABORT: ${audit.abort}` : audit.tauLow.toFixed(4)}; pool entries flagged at tau: ${new Set(audit.flaggedPairs.map((pair) => pair.poolId)).size} (${audit.flaggedPairs.length} pairs)`);
  const held = audit.buckets.heldOut;
  if (held !== null) {
    deps.stdout(
      `held-out (${held.total} scored; ${audit.buckets.excludedContaminated} of ${contaminatedKnown} known-contaminated excluded): ` +
        Object.entries(held.byBucket).map(([bucket, n]) => `${bucket} ${n}`).join(', ') +
        `; low stratum ${held.lowStratum} = ${(held.lowShare * 100).toFixed(1)}% (>= 50%: ${held.shareOk}); entries below 10: ${held.entriesBelowMin.join(', ') || 'none'}; valid: ${held.valid}`,
    );
  }
  const r = audit.retrieval;
  deps.stdout(`retrieval sim (run 1, k=3): ${r.fullK}/${r.casesChecked} held-out cases got a full k, mean ${r.meanRetrieved.toFixed(2)}; query embed + store p50 ${r.queryEmbedMs.p50.toFixed(0)} ms, p95 ${r.queryEmbedMs.p95.toFixed(0)} ms (n=${r.queryEmbedMs.sample}); store-only p95 ${r.storeQueryMs.p95.toFixed(2)} ms`);
  deps.stdout(`A0-swap shortfall (pool smaller than the static per-entry count): ${JSON.stringify(r.swapShortfall)}`);
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
