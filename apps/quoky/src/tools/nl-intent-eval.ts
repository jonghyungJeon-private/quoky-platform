/**
 * Natural-language selection evaluation (ADR-0120 D12): the model-in-the-loop scoring of the real selection prompt over
 * `golden/nl-intent.v1.json`. Exact `{ entry, args }` matching after Core's own validation — no LLM judge. Pure except
 * for the injected provider: the plan, the digest and the scoring are deterministic and tested offline; only `run`
 * spawns anything, and only after the Strict digest check in the CLI.
 *
 * Scoring per case:
 *  - a positive is a **hit** when the output is CLEAR, validates, and its entry and canonical args equal the golden ones;
 *    a clarification (NEEDS_CLARIFICATION or a failed validation) is not a hit and not wrong;
 *  - a negative is a **wrong capture** when the output is CLEAR and validates to an executable entry (the read would run).
 * Gate: at least 95% overall, at least 90% per entry, 0 wrong captures.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Capability,
  NL_CATALOG_ENTRY_IDS,
  NL_SELECTION_PROMPT_VERSION,
  NL_SELECTION_TIMEOUT_MS,
  NL_WAVE1_ENTRIES,
  buildSelectionPrompt,
  isNlCatalogEntryId,
  parseSelectionOutput,
  prepareSelectionInput,
  validateSelection,
  type AiProvider,
  type NlArgs,
  type NlCatalogEntry,
} from '@quoky/core';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';

export const NL_EVAL_GATE = { overall: 0.95, perEntry: 0.9, wrongCaptures: 0 } as const;
/** ADR-0121 S1 (design §6): at most 1% of the calls may go over the configured selection bound. */
export const NL_EVAL_S1_MAX_OVER_BOUND_RATE = 0.01;
/**
 * The runtime's selection bound (ADR-0120 D3, `NL_SELECTION_TIMEOUT_MS`). The evaluation calls with the same bound: a
 * call that does not answer within it is a `timeout` — not a hit and not wrong, exactly what the runtime would do.
 */
export const NL_EVAL_RUNTIME_TIMEOUT_MS = NL_SELECTION_TIMEOUT_MS;

export interface NlEvalCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  readonly channel?: boolean;
  readonly note?: string;
  /** S1: the frozen Class B grammar that answers this case in Phase A (the grammar-handled subset of the report). */
  readonly grammar?: string;
}

export interface NlEvalCorpus {
  readonly version: number;
  readonly cases: readonly NlEvalCase[];
}

export const NL_EVAL_CORPUS_PATH = resolve(__dirname, '../../../../packages/core/src/application/golden/nl-intent.v1.json');

export function loadCorpus(path: string = NL_EVAL_CORPUS_PATH): { corpus: NlEvalCorpus; sha256: string } {
  const text = readFileSync(path, 'utf8');
  return { corpus: JSON.parse(text) as NlEvalCorpus, sha256: createHash('sha256').update(text).digest('hex') };
}

export interface NlEvalPlanOptions {
  readonly model: string;
  /** Restrict to these entries (and, with `includeNegatives`, the negatives). Empty = all. */
  readonly entries: readonly string[];
  readonly includeNegatives: boolean;
  /** At most this many cases per entry (and of the negatives); 0 = all. */
  readonly perEntry: number;
  readonly runs: number;
  readonly concurrency: number;
  /** The per-call bound (`QUOKY_NL_INTENT_TIMEOUT_MS` rule: 2000..8000). Default {@link NL_EVAL_RUNTIME_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export interface NlEvalPlan {
  readonly kind: 'nl-intent-eval';
  readonly promptVersion: string;
  /** The SHA-256 of the instruction text (the prompt with an empty owner message): any prompt edit changes the digest. */
  readonly promptSha256: string;
  readonly corpusSha256: string;
  readonly model: string;
  readonly runs: number;
  readonly concurrency: number;
  /** The per-call bound (the runtime's selection bound). */
  readonly callTimeoutMs: number;
  readonly caseIds: readonly string[];
}

export function buildPlan(corpus: NlEvalCorpus, corpusSha256: string, options: NlEvalPlanOptions): NlEvalPlan {
  for (const entry of options.entries) {
    if (!isNlCatalogEntryId(entry)) throw new Error(`unknown entry ${entry}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) throw new Error('runs must be 1..5');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(options.model)) throw new Error('invalid model');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || parseNlIntentTimeoutMs(String(options.timeoutMs)) === undefined)) {
    throw new Error('timeoutMs must be an integer 2000..8000');
  }
  const counts = new Map<string, number>();
  const caseIds: string[] = [];
  for (const golden of corpus.cases) {
    const group = golden.expect === 'none' ? 'none' : golden.expect.entryId;
    const wanted = group === 'none' ? options.includeNegatives : options.entries.length === 0 || options.entries.includes(group);
    if (!wanted) continue;
    const seen = counts.get(group) ?? 0;
    if (options.perEntry > 0 && seen >= options.perEntry) continue;
    counts.set(group, seen + 1);
    caseIds.push(golden.id);
  }
  return {
    kind: 'nl-intent-eval',
    promptVersion: NL_SELECTION_PROMPT_VERSION,
    promptSha256: createHash('sha256').update(buildSelectionPrompt({ entries: ALL_ENTRIES, text: '' })).digest('hex'),
    corpusSha256,
    model: options.model,
    runs: options.runs,
    concurrency: options.concurrency,
    callTimeoutMs: options.timeoutMs ?? NL_EVAL_RUNTIME_TIMEOUT_MS,
    caseIds,
  };
}

export function computePlanDigest(plan: NlEvalPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export type NlEvalOutcome = 'hit' | 'miss' | 'clarify' | 'none' | 'wrong-capture' | 'timeout' | 'error' | 'skipped';

export interface NlEvalRecord {
  readonly run: number;
  readonly id: string;
  readonly expected: string;
  readonly outcome: NlEvalOutcome;
  readonly got?: string;
  readonly gotArgs?: NlArgs;
  readonly latencyMs: number;
  readonly error?: string;
  /** The selector's raw output for a case that was not a hit (the local report only; corpus text, no owner data). */
  readonly raw?: string;
}

const ALL_ENTRIES: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);

/** Score one raw selector output for one case (exported for the offline tests). */
export function scoreOutput(golden: NlEvalCase, raw: string, now: string, timeZone = 'Asia/Seoul'): Omit<NlEvalRecord, 'run' | 'latencyMs'> {
  const expected = golden.expect === 'none' ? 'none' : golden.expect.entryId;
  const prepared = prepareSelectionInput(golden.text);
  if ('skip' in prepared) return { id: golden.id, expected, outcome: 'skipped' };
  const output = parseSelectionOutput(raw);
  if (output === null) return { id: golden.id, expected, outcome: 'error', error: 'malformed' };
  if (output.entryId === null) return { id: golden.id, expected, outcome: golden.expect === 'none' ? 'none' : 'miss', got: 'none' };
  const offered = new Map(ALL_ENTRIES.map((entry) => [entry.id, entry] as const));
  const validated = validateSelection(
    { entryId: output.entryId, args: output.args },
    { offered, groundingText: prepared.groundingText, ...(golden.prior ? { previousArgs: golden.prior.args } : {}), now, timeZone },
  );
  if (!validated.ok || output.ambiguity !== 'CLEAR') {
    return { id: golden.id, expected, outcome: 'clarify', got: output.entryId };
  }
  const got = validated.value.entry.id;
  const gotArgs = validated.value.args;
  if (golden.expect === 'none') return { id: golden.id, expected, outcome: 'wrong-capture', got, gotArgs };
  const same = got === golden.expect.entryId && canonical(gotArgs) === canonical(golden.expect.args);
  return { id: golden.id, expected, outcome: same ? 'hit' : 'miss', got, gotArgs };
}

function canonical(args: NlArgs): string {
  return JSON.stringify(Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface NlEvalSummary {
  readonly cases: number;
  readonly positives: number;
  readonly hits: number;
  readonly overall: number;
  readonly perEntry: Readonly<Record<string, { readonly hits: number; readonly total: number; readonly rate: number }>>;
  readonly wrongCaptures: number;
  readonly negatives: number;
  readonly clarifications: number;
  /** Calls that did not answer within the runtime's selection bound (each one a miss on a positive). */
  readonly timeouts: number;
  readonly errors: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly max: number; readonly boundMs: number; readonly overRuntimeBound: number };
  readonly gatePassed: boolean;
  /** ADR-0121 S1: the share of calls over the bound, and the S1 gate (the D12 gate plus at most 1% over the bound). */
  readonly overBoundRate: number;
  readonly s1GatePassed: boolean;
  /**
   * S1 Phase C: the cases a frozen Class B grammar answers today (`grammar` in the corpus). Their latency is the latency
   * Phase C adds to those messages (the grammar itself answers on the host in milliseconds).
   */
  readonly grammarSubset?: {
    readonly cases: number;
    readonly positives: number;
    readonly hits: number;
    readonly overall: number;
    readonly wrongCaptures: number;
    readonly clarifications: number;
    readonly timeouts: number;
    readonly latency: { readonly p50: number; readonly p95: number; readonly max: number };
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = values.filter((ms) => ms > 0).sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number);
}

export function summarize(records: readonly NlEvalRecord[], boundMs: number = NL_EVAL_RUNTIME_TIMEOUT_MS, grammarCaseIds?: ReadonlySet<string>): NlEvalSummary {
  const positives = records.filter((record) => record.expected !== 'none');
  const hits = positives.filter((record) => record.outcome === 'hit').length;
  const perEntry: Record<string, { hits: number; total: number; rate: number }> = {};
  for (const record of positives) {
    const slot = (perEntry[record.expected] ??= { hits: 0, total: 0, rate: 0 });
    slot.total += 1;
    if (record.outcome === 'hit') slot.hits += 1;
  }
  for (const slot of Object.values(perEntry)) slot.rate = slot.total === 0 ? 0 : slot.hits / slot.total;
  const latencies = records.map((record) => record.latencyMs).filter((ms) => ms > 0).sort((a, b) => a - b);
  const pct = (p: number) => (latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)] as number);
  const overall = positives.length === 0 ? 1 : hits / positives.length;
  const wrongCaptures = records.filter((record) => record.outcome === 'wrong-capture').length;
  const overRuntimeBound = latencies.filter((ms) => ms > boundMs).length;
  const overBoundRate = records.length === 0 ? 0 : overRuntimeBound / records.length;
  const gatePassed =
    overall >= NL_EVAL_GATE.overall &&
    Object.values(perEntry).every((slot) => slot.rate >= NL_EVAL_GATE.perEntry) &&
    wrongCaptures <= NL_EVAL_GATE.wrongCaptures;
  const grammarRecords = grammarCaseIds === undefined ? undefined : records.filter((record) => grammarCaseIds.has(record.id));
  const grammarPositives = grammarRecords?.filter((record) => record.expected !== 'none') ?? [];
  const grammarHits = grammarPositives.filter((record) => record.outcome === 'hit').length;
  return {
    cases: records.length,
    positives: positives.length,
    hits,
    overall,
    perEntry,
    wrongCaptures,
    negatives: records.length - positives.length,
    clarifications: records.filter((record) => record.outcome === 'clarify').length,
    timeouts: records.filter((record) => record.outcome === 'timeout').length,
    errors: records.filter((record) => record.outcome === 'error').length,
    latency: { p50: pct(50), p95: pct(95), max: latencies.at(-1) ?? 0, boundMs, overRuntimeBound },
    gatePassed,
    overBoundRate,
    s1GatePassed: gatePassed && overBoundRate <= NL_EVAL_S1_MAX_OVER_BOUND_RATE,
    ...(grammarRecords !== undefined
      ? {
          grammarSubset: {
            cases: grammarRecords.length,
            positives: grammarPositives.length,
            hits: grammarHits,
            overall: grammarPositives.length === 0 ? 1 : grammarHits / grammarPositives.length,
            wrongCaptures: grammarRecords.filter((record) => record.outcome === 'wrong-capture').length,
            clarifications: grammarRecords.filter((record) => record.outcome === 'clarify').length,
            timeouts: grammarRecords.filter((record) => record.outcome === 'timeout').length,
            latency: {
              p50: percentile(grammarRecords.map((record) => record.latencyMs), 50),
              p95: percentile(grammarRecords.map((record) => record.latencyMs), 95),
              max: Math.max(0, ...grammarRecords.map((record) => record.latencyMs)),
            },
          },
        }
      : {}),
  };
}

class EvalCallTimeout extends Error {}

/** The runtime's bound around one call (the provider also gets `timeoutMs`; this guards a provider that ignores it). */
async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EvalCallTimeout('timeout')), timeoutMs);
  });
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run the plan against one provider (Strict: the caller checked the approved digest). */
export async function runEvaluation(input: {
  readonly corpus: NlEvalCorpus;
  readonly plan: NlEvalPlan;
  readonly provider: AiProvider;
  readonly now: () => string;
  readonly elapsed?: () => number;
  readonly onRecord?: (record: NlEvalRecord) => void;
}): Promise<NlEvalRecord[]> {
  const byId = new Map(input.corpus.cases.map((golden) => [golden.id, golden] as const));
  const clock = input.elapsed ?? Date.now;
  const records: NlEvalRecord[] = [];
  for (let run = 1; run <= input.plan.runs; run += 1) {
    const queue = input.plan.caseIds.map((id) => byId.get(id)).filter((golden): golden is NlEvalCase => golden !== undefined);
    const worker = async (): Promise<void> => {
      for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) {
        const prepared = prepareSelectionInput(golden.text);
        const expected = golden.expect === 'none' ? 'none' : golden.expect.entryId;
        if ('skip' in prepared) {
          const record: NlEvalRecord = { run, id: golden.id, expected, outcome: 'skipped', latencyMs: 0 };
          records.push(record);
          input.onRecord?.(record);
          continue;
        }
        const prompt = buildSelectionPrompt({
          entries: ALL_ENTRIES,
          text: prepared.text,
          ...(golden.prior !== undefined && isNlCatalogEntryId(golden.prior.entryId)
            ? { previous: { entryId: golden.prior.entryId, args: golden.prior.args } }
            : {}),
        });
        const started = clock();
        let record: NlEvalRecord;
        try {
          const result = await withTimeout(
            input.provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs: input.plan.callTimeoutMs }),
            input.plan.callTimeoutMs,
          );
          const scored = scoreOutput(golden, result.text, input.now());
          record = {
            run,
            latencyMs: clock() - started,
            ...scored,
            ...(scored.outcome === 'hit' || scored.outcome === 'none' ? {} : { raw: result.text.slice(0, 2048) }),
          };
        } catch (error) {
          const timedOut = error instanceof EvalCallTimeout || (error as { kind?: unknown } | null)?.kind === 'TIMEOUT';
          record = {
            run,
            id: golden.id,
            expected,
            outcome: timedOut ? 'timeout' : 'error',
            latencyMs: clock() - started,
            ...(timedOut ? {} : { error: error instanceof Error ? error.name : 'unknown' }),
          };
        }
        records.push(record);
        input.onRecord?.(record);
      }
    };
    await Promise.all(Array.from({ length: input.plan.concurrency }, () => worker()));
  }
  return records;
}
