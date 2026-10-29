/**
 * Natural-language selection evaluation (ADR-0120 D12): the model-in-the-loop scoring of the real selection prompt over
 * `golden/nl-intent.v1.json`. Exact `{ entry, args }` matching after Core's own validation — no LLM judge. Pure except
 * for the injected provider: the plan, the digest and the scoring are deterministic and tested offline; only `run`
 * spawns anything, and only after the Strict digest check in the CLI.
 *
 * Scoring per case (Core's FINAL outcome, owner rule of 2026-10-19):
 *  - a positive is a **hit** when the output is CLEAR, validates, and its entry and canonical args equal the golden ones
 *    (`jira.release`: or give the owner the same final outcome in the snapshot Jira world, owner answer 1 of 2026-10-22,
 *    `scoreOutputInWorld`);
 *    a clarification (NEEDS_CLARIFICATION, a failed validation, or Core's own help-scope question `nlHelpSourceScope`,
 *    owner decision A of 2026-10-22) is not a hit and not wrong;
 *  - a negative is a **wrong capture** when the output is CLEAR and validates to an executable entry (the read would run);
 *  - a clarification gold (`clarify`, owner decision A: a negative whose correct answer is a question between the listed
 *    entries and `none`) is **asked** on a clarification; a CLEAR capture of a listed entry is a `miss`, never a wrong
 *    capture (it is one of the readings the question offers), any other capture is still wrong. Reported apart
 *    (`clarifyGolds`); the gate is unchanged.
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
  isNlWave1EntryId,
  nlHelpSourceScope,
  isJiraReleaseLinkOnly,
  nlInheritHeldRange,
  nlOneStepClauseGroundedFlags,
  nlOwnerStatedRange,
  nlIsPastStatement,
  nlReadNotRequest,
  nlSelectionMeaning,
  parseSelectionOutput,
  prepareSelectionInput,
  validateSelection,
  type AiProvider,
  type NlArgs,
  type NlCatalogEntry,
  type NlPreviousSelectionInput,
} from '@quoky/core';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import { sameJiraReleaseOutcome } from './jira-world-snapshot';

export const NL_EVAL_GATE = { overall: 0.95, perEntry: 0.9, wrongCaptures: 0, helpCaptureRate: 0.01 } as const;

/** The entry whose captures on a negative show usage guidance only (no data read, no action): counted apart. */
export const NL_EVAL_HELP_ENTRY = 'help.topic';

/**
 * Owner decision of 2026-10-22 ("도움말 오포착은 별도 기준으로", amending the ratified ADR-0120 D12 gate): a run may have at
 * most ceil(1% of its negative golds) captures into `help.topic` (199 negatives → 2). Every other wrong capture stays at 0.
 */
export function helpCaptureAllowance(negatives: number): number {
  return Math.ceil(NL_EVAL_GATE.helpCaptureRate * negatives);
}
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
  /**
   * The previous selection. `turns` (owner decision D1: chat turns since its listing) and `earlier` (P7: the latest
   * selection of each other source) are rendered exactly as the runtime renders them; absent, the prompt is unchanged.
   */
  readonly prior?: {
    readonly entryId: string;
    readonly args: NlArgs;
    readonly turns?: number;
    readonly earlier?: readonly { readonly entryId: string; readonly args: NlArgs; readonly turns: number }[];
  };
  readonly channel?: boolean;
  readonly note?: string;
  /** S1: the frozen Class B grammar that answers this case in Phase A (the grammar-handled subset of the report). */
  readonly grammar?: string;
  /** S1: that grammar's own catalog equivalent (`null`: it has none), checked against the probes by the dispatch test. */
  readonly grammarAnswer?: { readonly entryId: string; readonly args: NlArgs } | null;
  /**
   * Owner decision A (2026-10-22): `expect` stays `none` (the safe reading), and the correct answer is Core asking between
   * these entries and `none`. See the scoring notes above.
   */
  readonly clarify?: NlEvalClarifyGold;
}

/** a8-25: Core's own reading of a link-only message (`isJiraReleaseLinkOnly`), as a selector output. */
export const NL_EVAL_RELEASE_LINK_OUTPUT = { entryId: 'jira.release', args: {}, ambiguity: 'CLEAR', alternatives: [] } as const;

/** A case's expected label: its entry, or `none`. */
export function nlEvalExpectedLabel(golden: Pick<NlEvalCase, 'expect'>): string {
  return golden.expect === 'none' ? 'none' : golden.expect.entryId;
}

/** P7: the stored selection an output for `entryId` refines (the runtime's `lastSelectionFor`, over a case's prior). */
export function nlEvalPriorFor(prior: NlEvalCase['prior'], entryId: string): { readonly entryId: string; readonly args: NlArgs } | undefined {
  if (prior === undefined || prior.entryId === entryId) return prior;
  return prior.earlier?.find((item) => item.entryId === entryId) ?? prior;
}

/** A clarification gold: the entries the question is between (besides `none`) and the owner batch that set it. */
export interface NlEvalClarifyGold {
  readonly between: readonly string[];
  readonly batch: string;
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

/**
 * Owner decision (가) option 1 (2026-10-27): the selector-only SUPPLEMENTAL scored corpus of the D1 / P7 / D4 context cases.
 * Not part of the ADR-0121 Q11 one-step planner gold (Q11 auto-includes `nl-intent.v1.json` only).
 */
export const NL_EVAL_CONTEXT_CORPUS_PATH = resolve(__dirname, '../../../../packages/core/src/application/golden/nl-intent.context.v1.json');

/**
 * The scored read corpus of the D12 gate: `nl-intent.v1.json` then the supplemental context corpus, every case once (a
 * duplicate id is an error). `sha256` binds both files: sha256 over `nl-intent.v1.json:<sha>\n` and
 * `nl-intent.context.v1.json:<sha>\n`.
 */
export function loadScoredCorpus(mainPath: string = NL_EVAL_CORPUS_PATH, contextPath: string = NL_EVAL_CONTEXT_CORPUS_PATH): { corpus: NlEvalCorpus; sha256: string } {
  const main = loadCorpus(mainPath);
  const context = loadCorpus(contextPath);
  const ids = new Set(main.corpus.cases.map((golden) => golden.id));
  const clash = context.corpus.cases.find((golden) => ids.has(golden.id));
  if (clash !== undefined) throw new Error(`case ${clash.id} is in both scored corpora`);
  const sha256 = createHash('sha256').update(`nl-intent.v1.json:${main.sha256}\nnl-intent.context.v1.json:${context.sha256}\n`).digest('hex');
  return { corpus: { version: main.corpus.version, cases: [...main.corpus.cases, ...context.corpus.cases] }, sha256 };
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
  /** The per-call bound (`QUOKY_NL_INTENT_TIMEOUT_MS` rule: 2000..10000). Default {@link NL_EVAL_RUNTIME_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Owner decision of 2026-10-28 (cost study P0): the selector's reasoning effort, bound into the digest when given. */
  readonly effort?: string;
}

export interface NlEvalPlan {
  readonly kind: 'nl-intent-eval';
  readonly promptVersion: string;
  /** The SHA-256 of the instruction text (the prompt with an empty owner message): any prompt edit changes the digest. */
  readonly promptSha256: string;
  readonly corpusSha256: string;
  readonly model: string;
  /** The selector's reasoning effort (`--effort`), when the CLI set it (owner decision of 2026-10-28). */
  readonly effort?: string;
  readonly runs: number;
  readonly concurrency: number;
  /** The per-call bound (the runtime's selection bound). */
  readonly callTimeoutMs: number;
  readonly caseIds: readonly string[];
}

export function buildPlan(corpus: NlEvalCorpus, corpusSha256: string, options: NlEvalPlanOptions): NlEvalPlan {
  for (const entry of options.entries) {
    if (!isNlWave1EntryId(entry)) throw new Error(`unknown entry ${entry}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) throw new Error('runs must be 1..5');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(options.model)) throw new Error('invalid model');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || parseNlIntentTimeoutMs(String(options.timeoutMs)) === undefined)) {
    throw new Error('timeoutMs must be an integer 2000..10000');
  }
  const counts = new Map<string, number>();
  const caseIds: string[] = [];
  for (const golden of corpus.cases) {
    const group = nlEvalExpectedLabel(golden);
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
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
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
  /** A `jira.release` hit by the same final outcome in the snapshot Jira world, not by identical args (owner answer 1). */
  readonly equivalent?: true;
  /** The arg names Core set back to the previous value or default (`ungroundedFallsBackToDefault`); names only. */
  readonly defaulted?: readonly string[];
}

const ALL_ENTRIES: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);

/** Score one raw selector output for one case (exported for the offline tests). */
export function scoreOutput(golden: NlEvalCase, raw: string, now: string, timeZone = 'Asia/Seoul'): Omit<NlEvalRecord, 'run' | 'latencyMs'> {
  const expected = nlEvalExpectedLabel(golden);
  const prepared = prepareSelectionInput(golden.text);
  if ('skip' in prepared) return { id: golden.id, expected, outcome: 'skipped' };
  // a8-25 (2026-10-27): a link-only message is `jira.release` with no args in Core, with no model call (the runtime's rule).
  const output = isJiraReleaseLinkOnly(prepared.groundingText) ? NL_EVAL_RELEASE_LINK_OUTPUT : parseSelectionOutput(raw);
  if (output === null) return { id: golden.id, expected, outcome: 'error', error: 'malformed' };
  if (output.entryId === null) return { id: golden.id, expected, outcome: golden.expect === 'none' ? 'none' : 'miss', got: 'none' };
  // A7: the runtime answers a clear past-tense statement as `none` (chat), message-level, before validation.
  if (nlIsPastStatement(prepared.groundingText) || nlReadNotRequest(prepared.groundingText, output.args) !== undefined) return { id: golden.id, expected, outcome: golden.expect === 'none' ? 'none' : 'miss', got: 'none' };
  const offered = new Map(ALL_ENTRIES.map((entry) => [entry.id, entry] as const));
  // P7: an output for an earlier selection's entry refines that one, as in the runtime (`lastSelectionFor`).
  const base = nlEvalPriorFor(golden.prior, output.entryId);
  const ctx = { offered, groundingText: prepared.groundingText, ...(base ? { previousArgs: base.args, ...(isNlCatalogEntryId(base.entryId) ? { previousEntryId: base.entryId } : {}) } : {}), now, timeZone };
  const validated = validateSelection({ entryId: output.entryId, args: output.args }, ctx);
  // Fix of 2026-10-29 (uat5r6-07): the runtime answers the listing just shown, repeated for a content request, as `none`.
  if (!validated.ok && validated.reason === 'repeats-listing') return { id: golden.id, expected, outcome: golden.expect === 'none' ? 'none' : 'miss', got: 'none' };
  if (!validated.ok || output.ambiguity !== 'CLEAR') {
    return { id: golden.id, expected, outcome: 'clarify', got: output.entryId };
  }
  // Owner decision P-time (ii): Core's final read keeps the held listing's period when the owner names none.
  const inherited = base !== undefined ? nlInheritHeldRange(validated.value, base, prepared.groundingText, ctx) : validated.value;
  // Owner decision of 2026-10-27: the one-step clause-grounded flag (calendar `timedOnly`), as the runtime applies it.
  // Owner decision of 2026-10-27 (range grounding): the one label-table period the owner states wins.
  const final = nlOneStepClauseGroundedFlags(nlOwnerStatedRange(inherited, prepared.groundingText, ctx), prepared.groundingText, ctx);
  const got = final.entry.id;
  const gotArgs = final.args;
  const defaulted = final.defaulted !== undefined ? { defaulted: final.defaulted } : {};
  // Owner decision A (2026-10-22): Core asks the help-scope question instead of running this read (its final outcome).
  if (nlHelpSourceScope({ entryId: got, args: gotArgs }, prepared.groundingText) !== undefined) return { id: golden.id, expected, outcome: 'clarify', got };
  if (golden.expect === 'none' && golden.clarify !== undefined && golden.clarify.between.includes(got)) return { id: golden.id, expected, outcome: 'miss', got, gotArgs, ...defaulted };
  if (golden.expect === 'none') return { id: golden.id, expected, outcome: 'wrong-capture', got, gotArgs, ...defaulted };
  const same = got === golden.expect.entryId && canonical(gotArgs) === canonical(golden.expect.args);
  return { id: golden.id, expected, outcome: same ? 'hit' : 'miss', got, gotArgs, ...defaulted };
}

/**
 * Owner answer 1 of 2026-10-22: {@link scoreOutput}, then a `jira.release` miss whose args give the owner the same final
 * outcome as the gold's in the snapshot Jira world (`sameJiraReleaseOutcome`, Core's own lookup) is a hit (`equivalent`).
 * Every other entry and outcome is exactly {@link scoreOutput}'s.
 */
export async function scoreOutputInWorld(golden: NlEvalCase, raw: string, now: string, timeZone = 'Asia/Seoul'): Promise<Omit<NlEvalRecord, 'run' | 'latencyMs'>> {
  const scored = scoreOutput(golden, raw, now, timeZone);
  if (scored.outcome !== 'miss' || golden.expect === 'none' || golden.expect.entryId !== 'jira.release' || scored.got !== 'jira.release' || scored.gotArgs === undefined) return scored;
  return (await sameJiraReleaseOutcome(golden.text, scored.gotArgs, golden.expect.args, { channel: golden.channel === true })) ? { ...scored, outcome: 'hit', equivalent: true } : scored;
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
  /** Wrong captures into a data read (every entry except help.topic): zero-tolerance. */
  readonly wrongCaptures: number;
  /** Wrong captures into help.topic (owner decision of 2026-10-22): at most `helpAllowance` per run. */
  readonly helpCaptures: number;
  /** ceil(1% of the run's negative golds). */
  readonly helpAllowance: number;
  /** Help captures beyond the allowance (a hard failure, like a data-read wrong capture). */
  readonly helpOverAllowance: number;
  readonly negatives: number;
  readonly clarifications: number;
  /** Owner decision A (2026-10-22): the clarification golds (`clarify`) and how many of them Core asked. */
  readonly clarifyGolds: { readonly total: number; readonly asked: number };
  /** Records whose selection had an ungrounded value set back to the previous value or default (CA review, 2026-10-22). */
  readonly defaulted: number;
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

export function summarize(
  records: readonly NlEvalRecord[],
  boundMs: number = NL_EVAL_RUNTIME_TIMEOUT_MS,
  grammarCaseIds?: ReadonlySet<string>,
  clarifyCaseIds: ReadonlySet<string> = new Set(),
): NlEvalSummary {
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
  // Owner decision of 2026-10-22: a capture into help.topic is counted apart (allowance), every other one is zero-tolerance.
  const wrongCaptures = records.filter((record) => record.outcome === 'wrong-capture' && record.got !== NL_EVAL_HELP_ENTRY).length;
  const helpCaptures = records.filter((record) => record.outcome === 'wrong-capture' && record.got === NL_EVAL_HELP_ENTRY).length;
  const helpAllowance = helpCaptureAllowance(records.length - positives.length);
  const overRuntimeBound = latencies.filter((ms) => ms > boundMs).length;
  const overBoundRate = records.length === 0 ? 0 : overRuntimeBound / records.length;
  const gatePassed =
    overall >= NL_EVAL_GATE.overall &&
    Object.values(perEntry).every((slot) => slot.rate >= NL_EVAL_GATE.perEntry) &&
    wrongCaptures <= NL_EVAL_GATE.wrongCaptures &&
    helpCaptures <= helpAllowance;
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
    helpCaptures,
    helpAllowance,
    helpOverAllowance: Math.max(0, helpCaptures - helpAllowance),
    negatives: records.length - positives.length,
    clarifications: records.filter((record) => record.outcome === 'clarify').length,
    defaulted: records.filter((record) => (record.defaulted?.length ?? 0) > 0).length,
    clarifyGolds: {
      total: records.filter((record) => clarifyCaseIds.has(record.id)).length,
      asked: records.filter((record) => clarifyCaseIds.has(record.id) && record.outcome === 'clarify').length,
    },
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

export class EvalCallTimeout extends Error {}

/** The runtime's bound around one call (the provider also gets `timeoutMs`; this guards a provider that ignores it). */
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
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
        const expected = nlEvalExpectedLabel(golden);
        if ('skip' in prepared) {
          const record: NlEvalRecord = { run, id: golden.id, expected, outcome: 'skipped', latencyMs: 0 };
          records.push(record);
          input.onRecord?.(record);
          continue;
        }
        const prompt = buildSelectionPrompt({
          entries: ALL_ENTRIES,
          text: prepared.text,
          ...(golden.prior !== undefined && isNlWave1EntryId(golden.prior.entryId)
            ? { previous: priorPromptInput(golden.prior) }
            : {}),
        });
        const started = clock();
        let record: NlEvalRecord;
        try {
          const result = await withTimeout(
            input.provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs: input.plan.callTimeoutMs }),
            input.plan.callTimeoutMs,
          );
          const scored = await scoreOutputInWorld(golden, result.text, input.now());
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

// ── S1 fair evidence: the grammar side and the selector side on the same grammar-handled cases ─────────────────────

/** One side's score on the grammar-handled cases: exact `{entry, args}`, entry only, and what the owner would see. */
export interface NlSideScore {
  readonly positives: number;
  readonly exact: number;
  readonly entry: number;
  readonly userVisible: number;
  /** Grammar-handled negatives the side captured (a read the owner did not ask for). */
  readonly wrongCaptures: number;
}

/** Search-word noise that changes nothing the owner sees (the prompt's generic words, English articles, the 님 suffix). */
const KEYWORD_NOISE = /(?:^|\s)(?:문서|자료|페이지|파일|관련|얘기|내용|메시지|건|거|the|an?)(?=\s|$)/giu;
const KEYWORD_ARGS = ['keyword', 'name', 'from'];

/**
 * User-visible meaning: `nlSelectionMeaning` (dates resolved by Core's clock, catalog defaults, count and the unread
 * default normalized) with keyword-like args stripped of noise words. Two selections with the same user-visible meaning
 * show the owner the same listing.
 */
export function userVisibleMeaning(selection: { readonly entryId: string; readonly args: NlArgs }, now: string, timeZone = 'Asia/Seoul'): string {
  const args: Record<string, NlArgs[string]> = { ...selection.args };
  for (const name of KEYWORD_ARGS) {
    const value = args[name];
    if (typeof value !== 'string') continue;
    const cleaned = value.replace(KEYWORD_NOISE, ' ').replace(/님$/u, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0) args[name] = cleaned;
  }
  const entry = isNlWave1EntryId(selection.entryId) ? NL_WAVE1_ENTRIES[selection.entryId] : undefined;
  return nlSelectionMeaning({ entryId: selection.entryId as never, args }, entry, now as never, timeZone);
}

function sideScore(
  cases: readonly NlEvalCase[],
  answerOf: (golden: NlEvalCase) => { readonly entryId: string; readonly args: NlArgs } | null | undefined,
  now: string,
): NlSideScore {
  let positives = 0;
  let exact = 0;
  let entry = 0;
  let userVisible = 0;
  let wrongCaptures = 0;
  for (const golden of cases) {
    const got = answerOf(golden);
    if (golden.expect === 'none') {
      if (got !== null && got !== undefined) wrongCaptures += 1;
      continue;
    }
    positives += 1;
    if (got === null || got === undefined || got.entryId !== golden.expect.entryId) continue;
    entry += 1;
    if (canonical(got.args) === canonical(golden.expect.args)) exact += 1;
    if (userVisibleMeaning(got, now) === userVisibleMeaning(golden.expect, now)) userVisible += 1;
  }
  return { positives, exact, entry, userVisible, wrongCaptures };
}

/** The grammars on their own hits (offline, deterministic: the corpus `grammarAnswer`, recorded from the probes). */
export function scoreGrammarSide(corpus: NlEvalCorpus, now: string): NlSideScore {
  return sideScore(corpus.cases.filter((golden) => golden.grammar !== undefined), (golden) => golden.grammarAnswer ?? null, now);
}

/** The selector on the same cases, from one run's records (a clarification, timeout or error answers nothing). */
export function scoreSelectorSide(corpus: NlEvalCorpus, records: readonly NlEvalRecord[], now: string): NlSideScore {
  const byId = new Map(records.map((record) => [record.id, record] as const));
  return sideScore(
    corpus.cases.filter((golden) => golden.grammar !== undefined && byId.has(golden.id)),
    (golden) => {
      const record = byId.get(golden.id);
      return record !== undefined && (record.outcome === 'hit' || record.outcome === 'miss' || record.outcome === 'wrong-capture') && record.got !== undefined && record.got !== 'none'
        ? { entryId: record.got, args: record.gotArgs ?? (record.outcome === 'hit' && golden.expect !== 'none' ? golden.expect.args : {}) }
        : null;
    },
    now,
  );
}

export function formatSideScore(label: string, score: NlSideScore): string {
  const pct = (count: number) => (score.positives === 0 ? '-' : `${((count / score.positives) * 100).toFixed(1)}%`);
  return `${label}: exact ${score.exact}/${score.positives} (${pct(score.exact)}), entry ${score.entry} (${pct(score.entry)}), user-visible ${score.userVisible} (${pct(score.userVisible)}), wrong captures ${score.wrongCaptures}`;
}

/** Owner decision A (2026-10-22): the ids of the clarification golds of a corpus (for `summarize`). */
export function clarifyCaseIdsOf(corpus: NlEvalCorpus): ReadonlySet<string> {
  return new Set(corpus.cases.filter((golden) => golden.clarify !== undefined).map((golden) => golden.id));
}

/** The prior as the selection prompt takes it (D1 `turns` and P7 `earlier` only when present, wave-1 entries only). */
export function priorPromptInput(prior: NonNullable<NlEvalCase['prior']>): NlPreviousSelectionInput {
  const earlier = (prior.earlier ?? []).filter((item) => isNlWave1EntryId(item.entryId));
  return {
    entryId: prior.entryId as NlPreviousSelectionInput['entryId'],
    args: prior.args,
    ...(prior.turns !== undefined && prior.turns > 0 ? { turns: prior.turns } : {}),
    ...(earlier.length > 0 ? { earlier: earlier.map((item) => ({ entryId: item.entryId as NlPreviousSelectionInput['entryId'], args: item.args, turns: item.turns })) } : {}),
  };
}
