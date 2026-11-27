/**
 * ADR-0121 amendment A6, slice A6-S4 "consent-eval" (A6.9 as updated by the ratification record R6; A6.10; a6-02): the
 * model-in-the-loop scoring of the consent-answer classifier over `golden/nl-consent-answer.v1.json`, in either arm on the same
 * frozen corpus: `remote` (the production route, the stronger `INTENT_SELECTION` tier through the Claude CLI, sonnet / low) or
 * `local` (`qwen3:8b` through Ollama, pinned by digest; no egress). If the local arm passes the gate it is preferred (a6-02).
 *
 * Each classifier-stage case makes ONE call through the REAL adapter (`createConsentAnswerClassifier`: the `consent-answer.v3`
 * prompt, the strict JSON parse, the 10 s bound, fail closed to `unclear`) with exactly `{ question, reply }`. The structural,
 * fast-path, control-forfeit and handler-claimed cases never reach the classifier; their stage is pinned offline on the real
 * runtime by `consent-answer.corpus.test.ts` and they make no call here. Every request the provider receives is checked by `classifier-sees-content` (A6.10). No LLM judge.
 * Pure except for the injected provider: the plan, the digest, the content check and the scoring are deterministic and tested
 * offline; only a Strict run spawns anything, and only after the digest check and the corpus approval check in the CLI.
 *
 * The gate (R6; every run, 3 runs, per arm): 0 wrong captures (gold neither `yes` nor `yes-and-more` labelled `yes` or
 * `yes-and-more`), recall >= 95 % on real yes (either binding label), recall >= 95 % on real no, 0 `classifier-sees-content`
 * firings, 0 harness errors, p95 latency within the 10 s bound (a timed-out call counts as over the bound), and recall >= 95 % on
 * real `yes-and-more` (gold `yes-and-more` labelled `yes-and-more`; owner r-03 (1), 2026-11-24: measured separately and gating).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Capability,
  CONSENT_ANSWER_CLASSIFIER_PROMPT_VERSION,
  CONSENT_CLASSIFIER_TIMEOUT_MS,
  SUMMARY_CONSENT_QUESTION_VERSION,
  buildConsentClassifierPrompt,
  capConsentLabelForJamoVowel,
  createConsentAnswerClassifier,
  executionLocalityOf,
  parseConsentClassifierOutput,
  type AiProvider,
  type AiRequest,
} from '@quoky/core';

export const NL_CONSENT_ANSWER_CORPUS_PATH = resolve(__dirname, '../../../../packages/core/src/application/golden/nl-consent-answer.v1.json');

/** The local arm's model, pinned by the Ollama manifest ID (the A2 ratification record, answer 9; the same pin as the CH7 reranker). */
export const CONSENT_LOCAL_MODEL = 'qwen3:8b';
export const CONSENT_LOCAL_DIGEST12 = '500a1f067a9f';

export const CONSENT_ANSWER_LABEL_SET = ['yes', 'yes-and-more', 'no', 'other', 'unclear'] as const;
export type ConsentEvalLabel = (typeof CONSENT_ANSWER_LABEL_SET)[number];
export const CONSENT_EVAL_STAGES = ['classifier', 'structural-fail', 'fast-path', 'control-forfeit', 'handler-claimed'] as const;
export type ConsentEvalStage = (typeof CONSENT_EVAL_STAGES)[number];
export type ConsentEvalArm = 'remote' | 'local';

/** R6 with the owner's r-03 (2026-11-24), set before any run. `yesAndMoreRecall` gates (r-03 (1)). */
export const NL_CONSENT_ANSWER_EVAL_GATE = Object.freeze({
  runs: 3,
  wrongCaptures: 0,
  yesRecall: 0.95,
  noRecall: 0.95,
  classifierSeesContent: 0,
  harnessErrors: 0,
  p95LatencyMs: CONSENT_CLASSIFIER_TIMEOUT_MS,
  yesAndMoreRecall: Object.freeze({ bar: 0.95, gating: true, status: 'owner r-03 (1), 2026-11-24' }),
});

export interface ConsentEvalCase {
  readonly id: string;
  readonly lang: 'ko' | 'en';
  readonly consent: 'rule-1' | 'a2-topic';
  readonly question: string;
  readonly reply: string;
  readonly gold: ConsentEvalLabel;
  readonly stage: ConsentEvalStage;
  readonly origin: 'owner-verdict' | 'drafted';
  readonly category: string;
  readonly ref?: string;
  readonly ownerMark?: unknown;
  readonly context: {
    readonly flow: string;
    readonly language: 'ko' | 'en';
    readonly recipient: string;
    readonly sources?: readonly string[];
    readonly shown: { readonly canary: string; readonly counts?: readonly number[]; readonly topic?: string };
  };
  readonly note?: string;
}

export interface ConsentEvalCorpus {
  readonly version: number;
  readonly name: string;
  /** `owner-review` until the owner's Strict review; a run is refused unless it is `approved`. */
  readonly status: string;
  readonly labels: readonly string[];
  readonly cases: readonly ConsentEvalCase[];
}

export function loadConsentAnswerCorpus(path: string = NL_CONSENT_ANSWER_CORPUS_PATH): { corpus: ConsentEvalCorpus; sha256: string } {
  const text = readFileSync(path, 'utf8');
  return { corpus: JSON.parse(text) as ConsentEvalCorpus, sha256: createHash('sha256').update(text).digest('hex') };
}

/** The values the owner saw that the classifier must never see: the canary, the topic and each of its tokens of 2+ characters. */
export function shownValues(golden: Pick<ConsentEvalCase, 'context'>): string[] {
  const { canary, topic } = golden.context.shown;
  return [canary, ...(topic !== undefined ? [topic, ...topic.split(/\s+/u).filter((token) => Array.from(token).length >= 2)] : [])];
}

/** Schema problems of a corpus (an empty list is valid); the deep checks against Core live in `consent-answer.corpus.test.ts`. */
export function validateConsentAnswerCorpus(corpus: ConsentEvalCorpus): string[] {
  const problems: string[] = [];
  if (JSON.stringify(corpus.labels) !== JSON.stringify(CONSENT_ANSWER_LABEL_SET)) problems.push('labels must be exactly yes, yes-and-more, no, other, unclear');
  const seen = new Set<string>();
  for (const [index, golden] of (corpus.cases ?? []).entries()) {
    const at = `case ${golden.id ?? `#${index}`}`;
    if (typeof golden.id !== 'string' || golden.id === '') problems.push(`${at}: missing id`);
    else if (seen.has(golden.id)) problems.push(`${at}: duplicate id`);
    else seen.add(golden.id);
    if (typeof golden.reply !== 'string' || golden.reply.trim() === '') problems.push(`${at}: missing reply`);
    if (typeof golden.question !== 'string' || golden.question === '' || /\d/u.test(golden.question)) problems.push(`${at}: the question must be the placeholder form (no digit)`);
    if (!(CONSENT_ANSWER_LABEL_SET as readonly string[]).includes(golden.gold)) problems.push(`${at}: unknown gold`);
    if (!(CONSENT_EVAL_STAGES as readonly string[]).includes(golden.stage)) problems.push(`${at}: unknown stage`);
    if (typeof golden.context?.shown?.canary !== 'string' || golden.context.shown.canary === '') problems.push(`${at}: missing shown canary`);
    else for (const value of shownValues(golden)) if (golden.reply?.includes(value) || golden.question?.includes(value)) problems.push(`${at}: a shown value is in the question or the reply`);
  }
  return problems;
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NlConsentAnswerPlan {
  readonly kind: 'nl-consent-answer-eval';
  readonly arm: ConsentEvalArm;
  readonly promptVersion: string;
  /** The prompt with an empty question and reply: any wording edit changes the digest (a6-12). */
  readonly promptSha256: string;
  /** The owner-facing question template the classifier questions are rendered from. */
  readonly questionVersion: string;
  readonly corpusSha256: string;
  readonly corpusStatus: string;
  readonly provider: 'claude-cli' | 'ollama-cli';
  readonly model: string;
  /** Remote arm: the stronger tier's effort (production default low). */
  readonly effort?: string;
  /** The tier every request asks for (`stronger`, as production); the local arm runs the same request on the local model. */
  readonly tier: 'stronger';
  /** Local arm: the Ollama manifest ID the model must have (else the provider is not available and nothing runs). */
  readonly localDigest12?: string;
  readonly runs: number;
  readonly concurrency: number;
  readonly callTimeoutMs: number;
  /** The classifier-stage cases (one call each per run). */
  readonly caseIds: readonly string[];
  /** Cases pinned offline (structural-fail, fast-path, control-forfeit, handler-claimed): no call. */
  readonly deterministicCases: number;
  readonly calls: number;
  /** The Core rules applied to the classifier label before scoring, as production does (binds the run to them). */
  readonly postRules: readonly string[];
  readonly gate: typeof NL_CONSENT_ANSWER_EVAL_GATE;
}

export function consentAnswerPromptSha256(): string {
  return createHash('sha256').update(buildConsentClassifierPrompt({ question: '', reply: '' })).digest('hex');
}

/** The Core post-classifier rules the scorer applies (A6.3 standalone vowel jamo note); a new rule changes the plan digest. */
export const CONSENT_EVAL_POST_RULES: readonly string[] = ['jamo-vowel-cap.v1'];

export function buildConsentAnswerPlan(
  corpus: ConsentEvalCorpus,
  corpusSha256: string,
  options: { readonly arm: ConsentEvalArm; readonly model: string; readonly effort?: string; readonly runs: number; readonly concurrency: number },
): NlConsentAnswerPlan {
  if (options.arm !== 'remote' && options.arm !== 'local') throw new Error('arm must be remote or local');
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5) throw new Error('runs must be 1..5');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('concurrency must be 1..8');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(options.model)) throw new Error('invalid model');
  if (options.arm === 'local' && (options.model !== CONSENT_LOCAL_MODEL || options.effort !== undefined)) throw new Error(`the local arm is ${CONSENT_LOCAL_MODEL} (pinned), with no effort`);
  const caseIds = corpus.cases.filter((golden) => golden.stage === 'classifier').map((golden) => golden.id);
  return {
    kind: 'nl-consent-answer-eval',
    arm: options.arm,
    promptVersion: CONSENT_ANSWER_CLASSIFIER_PROMPT_VERSION,
    promptSha256: consentAnswerPromptSha256(),
    questionVersion: SUMMARY_CONSENT_QUESTION_VERSION,
    corpusSha256,
    corpusStatus: corpus.status,
    provider: options.arm === 'remote' ? 'claude-cli' : 'ollama-cli',
    model: options.model,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    tier: 'stronger',
    ...(options.arm === 'local' ? { localDigest12: CONSENT_LOCAL_DIGEST12 } : {}),
    runs: options.runs,
    concurrency: options.concurrency,
    callTimeoutMs: CONSENT_CLASSIFIER_TIMEOUT_MS,
    caseIds,
    deterministicCases: corpus.cases.length - caseIds.length,
    calls: caseIds.length * options.runs,
    postRules: CONSENT_EVAL_POST_RULES,
    gate: NL_CONSENT_ANSWER_EVAL_GATE,
  };
}

export function computeConsentAnswerPlanDigest(plan: NlConsentAnswerPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

// ── classifier-sees-content (A6.10) ───────────────────────────────────────────────────────────────────────────────

/** The fields a classifier request may carry (`createConsentAnswerClassifier`); anything else is content the harness did not allow. */
const REQUEST_FIELDS = new Set(['capability', 'prompt', 'timeoutMs', 'signal', 'intentSelectionTier']);
const REPLY_BLOCK = '\n<reply>\n';

/**
 * The reasons a request fires `classifier-sees-content` for a case (empty: it holds exactly the fixed prompt around the case's
 * question and reply). Fires on an extra request field, another capability, a prompt that is not exactly
 * `buildConsentClassifierPrompt({ question, reply })`, or a digit, the canary, the topic or a topic token anywhere before the
 * reply block (the count is a digit; the question is the placeholder form). Never returns or logs any text of the request.
 */
export function classifierSeesContent(request: AiRequest, golden: Pick<ConsentEvalCase, 'question' | 'reply' | 'context'>): string[] {
  const reasons: string[] = [];
  for (const key of Object.keys(request)) if (!REQUEST_FIELDS.has(key) && (request as unknown as Record<string, unknown>)[key] !== undefined) reasons.push(`extra-field:${key}`);
  if (request.capability !== Capability.INTENT_SELECTION) reasons.push('capability');
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  if (prompt !== buildConsentClassifierPrompt({ question: golden.question, reply: golden.reply })) reasons.push('prompt-differs');
  const cut = prompt.lastIndexOf(REPLY_BLOCK);
  const head = cut < 0 ? prompt : prompt.slice(0, cut);
  if (/\d/u.test(head)) reasons.push('digit');
  if (shownValues(golden).some((value) => head.includes(value))) reasons.push('shown-value');
  return reasons;
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** `answered`: the provider answered (a clean label or `unclear`); `malformed`: it answered something the strict parse refuses. */
export type ConsentEvalOutcome = 'answered' | 'malformed' | 'timeout' | 'error' | 'no-call';

export interface ConsentEvalRecord {
  readonly run: number;
  readonly id: string;
  readonly gold: ConsentEvalLabel;
  /** The final label, after the Core post-classifier cap, as production decides; the gate scores this. */
  readonly label: ConsentEvalLabel;
  /** What the production adapter returned (fail closed: anything but a clean, timely label is `unclear`). */
  readonly rawLabel: ConsentEvalLabel;
  readonly outcome: ConsentEvalOutcome;
  readonly latencyMs: number;
  /** `classifier-sees-content` reasons (closed codes; empty when clean). */
  readonly contentFired: readonly string[];
  readonly error?: string;
  /** A malformed answer keeps its (bounded) text: model output, never an owner text. */
  readonly raw?: string;
}

/**
 * The latency a timed-out call records: over any bound (A6-S4 review round 1, CA P2). A call cut at the 10 s deadline measures about
 * 10 000 ms, so the p95 check would pass or fail on timer jitter; recorded as `Infinity` it is always over the p95 bound (in the JSON
 * report it is written as `null`).
 */
export const TIMED_OUT_LATENCY_MS = Number.POSITIVE_INFINITY;

const CLEAN_UNCLEAR = /^[ \t\r\n]*\{[ \t\r\n]*"label"[ \t\r\n]*:[ \t\r\n]*"unclear"[ \t\r\n]*\}[ \t\r\n]*$/u;

/** One case through the real adapter, with the provider wrapped to capture and check the request. */
async function classifyOne(provider: AiProvider, golden: ConsentEvalCase, plan: NlConsentAnswerPlan, clock: () => number, run: number): Promise<ConsentEvalRecord> {
  let request: AiRequest | undefined;
  let raw: string | undefined;
  let failure: { kind: 'timeout' | 'error'; name: string } | undefined;
  const capturing: AiProvider = {
    id: provider.id,
    ...(provider.family !== undefined ? { family: provider.family } : {}),
    ...(provider.executionLocality !== undefined ? { executionLocality: provider.executionLocality } : {}),
    capabilities: provider.capabilities,
    // Remote: exactly what the real provider declares (production refuses a provider without the stronger tier: no call, a harness
    // error here). Local: the local model is measured AS the classifier, so the tier is declared for it (a6-12: production would need an
    // adapter or routing change and a new gate run before using it).
    ...(plan.arm === 'local'
      ? { supportsStrongerIntentSelection: true }
      : provider.supportsStrongerIntentSelection !== undefined
        ? { supportsStrongerIntentSelection: provider.supportsStrongerIntentSelection }
        : {}),
    isAvailable: () => provider.isAvailable(),
    execute: async (sent) => {
      request = sent;
      try {
        const result = await provider.execute(sent);
        raw = result.text;
        return result;
      } catch (error) {
        const timedOut = (error as { kind?: unknown } | null)?.kind === 'TIMEOUT' || (error instanceof Error && error.name === 'TimeoutError');
        failure = { kind: timedOut ? 'timeout' : 'error', name: error instanceof Error ? error.name : 'unknown' };
        throw error;
      }
    },
  };
  const classify = createConsentAnswerClassifier({ select: async () => capturing, timeoutMs: plan.callTimeoutMs, now: clock });
  const started = clock();
  const rawLabel = await classify(
    { question: golden.question, reply: golden.reply },
    { chat: { id: capturing.family ?? capturing.id, locality: executionLocalityOf(capturing) }, charge: () => true },
  );
  const label = capConsentLabelForJamoVowel(rawLabel, golden.reply);
  const measuredMs = clock() - started;
  const contentFired = request === undefined ? [] : classifierSeesContent(request, golden);
  const base = { run, id: golden.id, gold: golden.gold, label: label as ConsentEvalLabel, rawLabel: rawLabel as ConsentEvalLabel, latencyMs: measuredMs, contentFired };
  if (request === undefined) return { ...base, outcome: 'no-call' };
  if (failure !== undefined) return { ...base, outcome: failure.kind, ...(failure.kind === 'error' ? { error: failure.name } : { latencyMs: TIMED_OUT_LATENCY_MS }) };
  // The adapter gave up (its 10 s bound) before the provider settled, or the answer came at or after the deadline.
  if (raw === undefined || (rawLabel === 'unclear' && parseConsentClassifierOutput(raw) !== 'unclear')) return { ...base, outcome: 'timeout', latencyMs: TIMED_OUT_LATENCY_MS };
  if (rawLabel === 'unclear' && !CLEAN_UNCLEAR.test(raw)) return { ...base, outcome: 'malformed', raw: raw.slice(0, 200) };
  return { ...base, outcome: 'answered' };
}

export async function runConsentAnswerEvaluation(input: {
  readonly cases: readonly ConsentEvalCase[];
  readonly plan: NlConsentAnswerPlan;
  readonly provider: AiProvider;
  readonly clock?: () => number;
}): Promise<ConsentEvalRecord[]> {
  const byId = new Map(input.cases.map((golden) => [golden.id, golden] as const));
  const clock = input.clock ?? Date.now;
  const records: ConsentEvalRecord[] = [];
  for (let run = 1; run <= input.plan.runs; run += 1) {
    const queue = input.plan.caseIds.map((id) => byId.get(id)).filter((golden): golden is ConsentEvalCase => golden !== undefined);
    const worker = async (): Promise<void> => {
      for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) records.push(await classifyOne(input.provider, golden, input.plan, clock, run));
    };
    await Promise.all(Array.from({ length: input.plan.concurrency }, () => worker()));
  }
  return records;
}

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ConsentEvalRate {
  readonly hits: number;
  readonly total: number;
  readonly rate: number;
}

export interface ConsentEvalSummary {
  readonly total: number;
  /** Gold neither `yes` nor `yes-and-more` labelled `yes` or `yes-and-more` (hard failure, gate 0); ids only. */
  readonly wrongCaptures: number;
  readonly wrongCaptureIds: readonly string[];
  /** Gold `yes` labelled `yes` or `yes-and-more` (both bind). */
  readonly yesRecall: ConsentEvalRate;
  readonly noRecall: ConsentEvalRate;
  /** Gold `yes-and-more` labelled `yes-and-more` (gating, owner r-03 (1)). */
  readonly yesAndMoreRecall: ConsentEvalRate;
  /** Gold `yes-and-more` labelled `yes`: the extra request is silently dropped (reported). */
  readonly yesAndMoreReadAsYes: number;
  /** Gold `yes` labelled `yes-and-more`: the bare reply reruns as an ordinary turn (counted, not failed). */
  readonly yesReadAsYesAndMore: number;
  /** Gold `yes` labelled `unclear`: a re-ask only (counted, not failed). */
  readonly yesReadAsUnclear: number;
  readonly unclearAccuracy: ConsentEvalRate;
  readonly otherAccuracy: ConsentEvalRate;
  readonly classifierSeesContent: number;
  /** Provider failures that are not timeouts, and cases where no call reached the provider (hard failure, gate 0). */
  readonly harnessErrors: number;
  readonly malformed: number;
  readonly timeouts: number;
  readonly latency: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly gatePassed: boolean;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

function rate(records: readonly ConsentEvalRecord[], hit: (record: ConsentEvalRecord) => boolean): ConsentEvalRate {
  const hits = records.filter(hit).length;
  return { hits, total: records.length, rate: records.length === 0 ? 1 : hits / records.length };
}

const binds = (label: ConsentEvalLabel): boolean => label === 'yes' || label === 'yes-and-more';

/** One run's records against the R6 gate. */
export function summarizeConsentAnswer(records: readonly ConsentEvalRecord[]): ConsentEvalSummary {
  const gold = (label: ConsentEvalLabel) => records.filter((record) => record.gold === label);
  const wrong = records.filter((record) => !binds(record.gold) && binds(record.label));
  const yesRecall = rate(gold('yes'), (record) => binds(record.label));
  const noRecall = rate(gold('no'), (record) => record.label === 'no');
  const yesAndMoreRecall = rate(gold('yes-and-more'), (record) => record.label === 'yes-and-more');
  const latencies = records.map((record) => record.latencyMs);
  const p95 = percentile(latencies, 0.95);
  const contentFirings = records.filter((record) => record.contentFired.length > 0).length;
  const harnessErrors = records.filter((record) => record.outcome === 'error' || record.outcome === 'no-call').length;
  const gate = NL_CONSENT_ANSWER_EVAL_GATE;
  return {
    total: records.length,
    wrongCaptures: wrong.length,
    wrongCaptureIds: [...new Set(wrong.map((record) => record.id))].sort(),
    yesRecall,
    noRecall,
    yesAndMoreRecall,
    yesAndMoreReadAsYes: gold('yes-and-more').filter((record) => record.label === 'yes').length,
    yesReadAsYesAndMore: gold('yes').filter((record) => record.label === 'yes-and-more').length,
    yesReadAsUnclear: gold('yes').filter((record) => record.label === 'unclear').length,
    unclearAccuracy: rate(gold('unclear'), (record) => record.label === 'unclear'),
    otherAccuracy: rate(gold('other'), (record) => record.label === 'other'),
    classifierSeesContent: contentFirings,
    harnessErrors,
    malformed: records.filter((record) => record.outcome === 'malformed').length,
    timeouts: records.filter((record) => record.outcome === 'timeout').length,
    latency: { p50: percentile(latencies, 0.5), p95, max: latencies.reduce((max, ms) => Math.max(max, ms), 0) },
    gatePassed:
      wrong.length <= gate.wrongCaptures &&
      yesRecall.rate >= gate.yesRecall &&
      noRecall.rate >= gate.noRecall &&
      (!gate.yesAndMoreRecall.gating || yesAndMoreRecall.rate >= gate.yesAndMoreRecall.bar) &&
      contentFirings <= gate.classifierSeesContent &&
      harnessErrors <= gate.harnessErrors &&
      p95 <= gate.p95LatencyMs,
  };
}

export type ConsentGateVerdict = 'PASSED' | 'FAILED' | 'INVALID' | 'NON-GATING';

/**
 * The verdict of a whole run (every eval:nl rule): an outage (`invalidReason`) with no hard failure observed is INVALID (exit 5),
 * never PASSED or FAILED; a hard failure (a wrong capture or a content firing) is FAILED even under an outage; otherwise PASSED
 * only when every run passed AND the plan had the gate's 3 runs (fewer passing runs are NON-GATING, exit 4).
 */
export function consentAnswerGateVerdict(input: { readonly summaries: readonly ConsentEvalSummary[]; readonly runs: number; readonly invalidReason?: string }): ConsentGateVerdict {
  const hard = input.summaries.reduce((sum, summary) => sum + summary.wrongCaptures + summary.classifierSeesContent, 0);
  if (input.invalidReason !== undefined && hard === 0) return 'INVALID';
  if (hard > 0 || input.summaries.length === 0 || !input.summaries.every((summary) => summary.gatePassed)) return 'FAILED';
  return input.runs >= NL_CONSENT_ANSWER_EVAL_GATE.runs ? 'PASSED' : 'NON-GATING';
}

/** One summary as printed: counts and ids only (never a reply or a question). */
export function formatConsentAnswerSummary(summary: ConsentEvalSummary): string {
  const pct = (value: ConsentEvalRate) => `${value.hits}/${value.total} (${(value.rate * 100).toFixed(1)}%)`;
  return [
    `wrong captures ${summary.wrongCaptures}${summary.wrongCaptureIds.length > 0 ? ` [${summary.wrongCaptureIds.join(', ')}]` : ''}`,
    `yes recall ${pct(summary.yesRecall)}`,
    `no recall ${pct(summary.noRecall)}`,
    `yes-and-more recall ${pct(summary.yesAndMoreRecall)}`,
    `yes-and-more read as yes ${summary.yesAndMoreReadAsYes}`,
    `yes read as yes-and-more ${summary.yesReadAsYesAndMore}`,
    `yes read as unclear ${summary.yesReadAsUnclear}`,
    `other ${pct(summary.otherAccuracy)}`,
    `unclear ${pct(summary.unclearAccuracy)}`,
    `classifier-sees-content ${summary.classifierSeesContent}`,
    `harness errors ${summary.harnessErrors}`,
    `malformed ${summary.malformed}`,
    `timeouts ${summary.timeouts}`,
    `latency p50 ${summary.latency.p50} ms p95 ${summary.latency.p95} ms max ${summary.latency.max} ms`,
    summary.gatePassed ? 'run gate PASSED' : 'run gate FAILED',
  ].join(' · ');
}
