/**
 * D4 help-scope classifier evaluation (owner decisions of 2026-10-27 and 2026-11-02): the model-in-the-loop scoring of the
 * dedicated classifier (`help-scope-classifier.ts`) over `golden/nl-help-scope.v1.json`, the 67 owner-approved cases
 * (38 worded answers, 29 non-answers). Each case builds the real prompt from the question's rendered option texts
 * (`renderHelpScopeOptions`) and the case text, makes ONE `INTENT_SELECTION` call and parses it strictly. No LLM judge.
 * Pure except for the injected provider: the plan, the digest and the scoring are deterministic and tested offline; only a
 * Strict run spawns anything, and only after the digest check in the CLI.
 *
 * Scoring per case:
 *  - an answer (`expectAnswer` 1 or 2) is a **hit** when the classifier returns that number; any other result is a miss
 *    (the other number, neither, malformed, timeout, error);
 *  - a non-answer is a **hit** when the classifier returns `neither`; returning 1 or 2 is a **wrong capture**; malformed
 *    or timeout is a miss, never a wrong capture (the runtime treats both as neither).
 * Gate per run (owner decision of 2026-11-02, set before any run): 0 wrong captures on the non-answers AND answer accuracy
 * of at least 95% AND 0 harness errors. The multi-run gate passes only when every run passes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Capability, NL_HELP_SCOPE_CLASSIFIER_PROMPT_VERSION, NL_SELECTION_TIMEOUT_MS, buildHelpScopeClassifierPrompt, parseHelpScopeClassifierOutput, renderHelpScopeOptions, type AiProvider } from '@quoky/core';
import { parseNlIntentTimeoutMs } from '../nl-selection/nl-selection-config';
import { EvalCallTimeout, withTimeout } from './nl-intent-eval';

export const NL_HELP_SCOPE_EVAL_GATE = Object.freeze({ wrongCaptures: 0, answerAccuracy: 0.95, harnessErrors: 0 });

export const NL_HELP_SCOPE_CORPUS_PATH = resolve(__dirname, '../../../../packages/core/src/application/golden/nl-help-scope.v1.json');

export interface NlHelpScopeCase {
  readonly id: string;
  readonly text: string;
  /** The help-scope question shown: the source name(s) and the language it was displayed in. */
  readonly openQuestion: { readonly sources: string | readonly string[]; readonly language: 'ko' | 'en' };
  /** The option a worded reply means; absent: the reply is not an answer. */
  readonly expectAnswer?: 1 | 2;
  readonly expect?: unknown;
  readonly note?: string;
}

export interface NlHelpScopeCorpus {
  readonly version: number;
  readonly description?: string;
  readonly cases: readonly NlHelpScopeCase[];
}

export function loadHelpScopeCorpus(path: string = NL_HELP_SCOPE_CORPUS_PATH): { corpus: NlHelpScopeCorpus; sha256: string } {
  const text = readFileSync(path, 'utf8');
  return { corpus: JSON.parse(text) as NlHelpScopeCorpus, sha256: createHash('sha256').update(text).digest('hex') };
}

/** Schema problems of a corpus (an empty list is valid). */
export function validateHelpScopeCorpus(corpus: NlHelpScopeCorpus): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, golden] of corpus.cases.entries()) {
    const at = `case ${golden.id ?? `#${index}`}`;
    if (typeof golden.id !== 'string' || golden.id === '') problems.push(`${at}: missing id`);
    else if (seen.has(golden.id)) problems.push(`${at}: duplicate id`);
    else seen.add(golden.id);
    if (typeof golden.text !== 'string' || golden.text.trim() === '') problems.push(`${at}: missing text`);
    const sources = golden.openQuestion?.sources;
    const named = typeof sources === 'string' ? [sources] : Array.isArray(sources) ? sources : [];
    if (named.length === 0 || named.some((name) => typeof name !== 'string' || name.trim() === '')) problems.push(`${at}: openQuestion.sources must name one or more sources`);
    if (golden.openQuestion?.language !== 'ko' && golden.openQuestion?.language !== 'en') problems.push(`${at}: openQuestion.language must be ko or en`);
    if (golden.expectAnswer !== undefined && golden.expectAnswer !== 1 && golden.expectAnswer !== 2) problems.push(`${at}: expectAnswer must be 1 or 2 when present`);
    const known = new Set(['id', 'text', 'openQuestion', 'expectAnswer', 'expect', 'note']);
    for (const key of Object.keys(golden)) if (!known.has(key)) problems.push(`${at}: unknown key ${key}`);
  }
  return problems;
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NlHelpScopePlan {
  readonly kind: 'nl-help-scope-eval';
  readonly promptVersion: string;
  /** The prompt text with fixed options and no reply: any wording edit changes the digest. */
  readonly promptSha256: string;
  readonly corpusSha256: string;
  readonly model: string;
  readonly effort?: string;
  readonly runs: number;
  readonly concurrency: number;
  readonly callTimeoutMs: number;
  readonly caseIds: readonly string[];
  /** The model-call count this plan authorises (cases x runs; one classifier call per case). */
  readonly calls: number;
  /** The gate (owner decision of 2026-11-02), bound into the digest. */
  readonly gate: typeof NL_HELP_SCOPE_EVAL_GATE;
}

export function helpScopePromptSha256(): string {
  return createHash('sha256').update(buildHelpScopeClassifierPrompt({ options: renderHelpScopeOptions('Source', 'en'), reply: '', language: 'en' })).digest('hex');
}

export function buildHelpScopePlan(
  caseIds: readonly string[],
  corpusSha256: string,
  options: { readonly model: string; readonly effort?: string; readonly runs: number; readonly concurrency: number; readonly timeoutMs?: number },
): NlHelpScopePlan {
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) throw new Error('runs must be 1..5');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(options.model)) throw new Error('invalid model');
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || parseNlIntentTimeoutMs(String(options.timeoutMs)) === undefined)) throw new Error('timeoutMs must be an integer 2000..10000');
  return {
    kind: 'nl-help-scope-eval',
    promptVersion: NL_HELP_SCOPE_CLASSIFIER_PROMPT_VERSION,
    promptSha256: helpScopePromptSha256(),
    corpusSha256,
    model: options.model,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    runs: options.runs,
    concurrency: options.concurrency,
    callTimeoutMs: options.timeoutMs ?? NL_SELECTION_TIMEOUT_MS,
    caseIds: [...caseIds],
    calls: caseIds.length * options.runs,
    gate: NL_HELP_SCOPE_EVAL_GATE,
  };
}

export function computeHelpScopePlanDigest(plan: NlHelpScopePlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type NlHelpScopeOutcome = 'hit' | 'miss' | 'wrong-capture' | 'malformed' | 'timeout' | 'error';

export interface NlHelpScopeRecord {
  readonly run: number;
  readonly id: string;
  /** The gold reading: `1`, `2`, or `neither` (a non-answer). */
  readonly expected: '1' | '2' | 'neither';
  readonly outcome: NlHelpScopeOutcome;
  readonly got?: '1' | '2' | 'neither';
  readonly latencyMs: number;
  readonly error?: string;
  /** A malformed answer keeps its (bounded) text; a classifier answer is a JSON object, never an owner text. */
  readonly raw?: string;
}

export function helpScopeExpected(golden: Pick<NlHelpScopeCase, 'expectAnswer'>): '1' | '2' | 'neither' {
  return golden.expectAnswer === undefined ? 'neither' : (String(golden.expectAnswer) as '1' | '2');
}

/** The real prompt of one case: the question's rendered options and the case text as the reply. */
export function helpScopeCasePrompt(golden: NlHelpScopeCase): string {
  return buildHelpScopeClassifierPrompt({ options: renderHelpScopeOptions(golden.openQuestion.sources, golden.openQuestion.language), reply: golden.text, language: golden.openQuestion.language });
}

/** The outcome of one parsed classifier answer against the gold reading. */
export function scoreHelpScopeAnswer(expected: '1' | '2' | 'neither', answer: 1 | 2 | 'neither' | undefined): { outcome: NlHelpScopeOutcome; got?: '1' | '2' | 'neither' } {
  if (answer === undefined) return { outcome: 'malformed' };
  const got = String(answer) as '1' | '2' | 'neither';
  if (got === expected) return { outcome: 'hit', got };
  return { outcome: expected === 'neither' ? 'wrong-capture' : 'miss', got };
}

export async function runHelpScopeEvaluation(input: {
  readonly cases: readonly NlHelpScopeCase[];
  readonly plan: NlHelpScopePlan;
  readonly provider: AiProvider;
  readonly elapsed?: () => number;
}): Promise<NlHelpScopeRecord[]> {
  const byId = new Map(input.cases.map((golden) => [golden.id, golden] as const));
  const clock = input.elapsed ?? Date.now;
  const records: NlHelpScopeRecord[] = [];
  for (let run = 1; run <= input.plan.runs; run += 1) {
    const queue = input.plan.caseIds.map((id) => byId.get(id)).filter((golden): golden is NlHelpScopeCase => golden !== undefined);
    const worker = async (): Promise<void> => {
      for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) {
        const expected = helpScopeExpected(golden);
        const started = clock();
        try {
          const result = await withTimeout(
            input.provider.execute({ capability: Capability.INTENT_SELECTION, prompt: helpScopeCasePrompt(golden), timeoutMs: input.plan.callTimeoutMs }),
            input.plan.callTimeoutMs,
          );
          const scored = scoreHelpScopeAnswer(expected, parseHelpScopeClassifierOutput(result.text));
          records.push({
            run,
            id: golden.id,
            expected,
            latencyMs: clock() - started,
            ...scored,
            ...(scored.outcome === 'malformed' ? { raw: result.text.slice(0, 200) } : {}),
          });
        } catch (error) {
          const timedOut = error instanceof EvalCallTimeout || (error as { kind?: unknown } | null)?.kind === 'TIMEOUT';
          records.push({
            run,
            id: golden.id,
            expected,
            outcome: timedOut ? 'timeout' : 'error',
            latencyMs: clock() - started,
            ...(timedOut ? {} : { error: error instanceof Error ? error.name : 'unknown' }),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: input.plan.concurrency }, () => worker()));
  }
  return records;
}

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NlHelpScopeSummary {
  readonly answers: { readonly hits: number; readonly total: number; readonly rate: number };
  readonly nonAnswers: { readonly hits: number; readonly total: number };
  /** Non-answers the classifier read as option 1 or 2 (hard failure, gate 0). */
  readonly wrongCaptures: number;
  /** Answers read as the OTHER option (a miss; reported apart). */
  readonly wrongOptions: number;
  readonly malformed: number;
  readonly timeouts: number;
  /** Provider failures that are not timeouts (hard failure, gate 0). */
  readonly errors: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly gatePassed: boolean;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

/** One run's records: 0 wrong captures AND answer accuracy >= 95% AND 0 harness errors. */
export function summarizeHelpScope(records: readonly NlHelpScopeRecord[]): NlHelpScopeSummary {
  const answers = records.filter((record) => record.expected !== 'neither');
  const nonAnswers = records.filter((record) => record.expected === 'neither');
  const answerHits = answers.filter((record) => record.outcome === 'hit').length;
  const rate = answers.length === 0 ? 1 : answerHits / answers.length;
  const wrongCaptures = nonAnswers.filter((record) => record.outcome === 'wrong-capture').length;
  const errors = records.filter((record) => record.outcome === 'error').length;
  const latencies = records.map((record) => record.latencyMs);
  return {
    answers: { hits: answerHits, total: answers.length, rate },
    nonAnswers: { hits: nonAnswers.filter((record) => record.outcome === 'hit').length, total: nonAnswers.length },
    wrongCaptures,
    wrongOptions: answers.filter((record) => record.outcome === 'miss' && record.got !== 'neither').length,
    malformed: records.filter((record) => record.outcome === 'malformed').length,
    timeouts: records.filter((record) => record.outcome === 'timeout').length,
    errors,
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.reduce((max, ms) => Math.max(max, ms), 0) },
    gatePassed: wrongCaptures <= NL_HELP_SCOPE_EVAL_GATE.wrongCaptures && rate >= NL_HELP_SCOPE_EVAL_GATE.answerAccuracy && errors <= NL_HELP_SCOPE_EVAL_GATE.harnessErrors,
  };
}
