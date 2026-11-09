/**
 * ADR-0124 section 7 CH3 (whole-item summary, S3) and CH5 (latency and resources): the slice 3 harness (DECISIONS ADR-0124
 * section 17). Arm L only (owner decision 5: arms H and R2 only if L fails CH3), against today's path as the baseline.
 *
 * - **Arm L.** `runS3ItemSummary` with the item exactly as a handler attaches it (`s3InputOf`), the selector and gate of
 *   the real slice-2 composition (`local-arm.ts`), mode `on`. One map call per window and one reduce call, all LOCAL.
 * - **Today.** The bounded readout today's handler builds (`todayReadoutOf`), the document-summary prompt
 *   (`composeDocumentSummaryPrompt`, byte-identical to today's composer for a readout) on the chat-tier provider, then
 *   today's delivered-text check (`checkDocumentSummaryClaims`). The SAME synthetic text; no owner content anywhere.
 * - **Scoring** is deterministic (`ch3-score.ts`); no model judge, so the plan has no judge calls. The preference test is
 *   the owner's blind sheet (`blind-sheet.ts`), the gate.
 * - **Verdict** (bars ratified 2026-11-09): coverage >= 80 % and 0 invented points in >= 95 % of items from the run; S3
 *   preferred over today (one-sided binomial p < 0.05 over >= 25 non-tie pairs) from the owner's sheet. A run never prints
 *   PASSED by itself: it is FAILED, INVALID, or NON-GATING until the sheet is scored.
 * - **Content-free report.** The report holds counts, scores and timings only; the answer texts go to the blind sheet.
 */
import { createHash } from 'node:crypto';
import {
  Capability,
  DOCUMENT_MAP_PROMPT_VERSION,
  PromptRenderer,
  S3_LIMITS,
  UNTRUSTED_DOCUMENT_READOUT_KIND,
  buildDocumentMapRequest,
  checkDocumentSummaryClaims,
  composeDocumentSummaryPrompt,
  documentSummaryReply,
  generalChatReplyPolicy,
  isFixedDocumentSummaryNotice,
  renderDocumentSummaryTooLong,
  runS3ItemSummary,
  type AiProvider,
  type ProviderSelector,
  type UntrustedDocumentReadout,
} from '@quoky/core';
import { implementationHashes, type ImplementationHashes } from './implementation';
import { CANARY_CLAUSE, providerFailureReason, type ProviderOutageReport } from '../eval-provider-guard';
import { CH3_CORPUS_SEED, CH3_CORPUS_VERSION, type Ch3Case } from './ch3-corpus';
import { CH3_SCORER_VERSION, aggregate, scoreSummary, valueAtoms, type ArmAggregate, type ItemScore } from './ch3-score';
import { itemSourceText, replyLanguageOf, s3InputOf, sourceOf, todayReadoutOf } from './items';
import type { RssReport } from './local-arm';

export const CH3_PLAN_VERSION = 'chunk-s3-ch3-plan.v1';
/** CH3 bars, ratified 2026-11-09 (DECISIONS ADR-0124 section 17 decision 4). */
export const CH3_BARS = Object.freeze({ coverage: 0.8, inventedFreeShare: 0.95 });
/** Today's chat-tier call bound in the eval (the live path has the provider's own default). */
export const TODAY_TIMEOUT_MS = 120_000;
/**
 * Minutes estimate per local call: typical = the A2 G3 warm median bound (<= 5 s per call on this Mac, section 3.7), upper =
 * the S3 per-call bound (20 s). Planning numbers only; CH5 measures the real ones.
 */
export const LOCAL_CALL_ESTIMATE_MS = Object.freeze({ typical: 5_000, upper: S3_LIMITS.callTimeoutMs });

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 of the rendered map prompt and of the document-summary prompt for one fixed synthetic readout (a prompt change moves the plan digest). */
export function promptFingerprints(): { readonly mapVersion: string; readonly mapSha256: string; readonly documentSummarySha256: string } {
  const readout: UntrustedDocumentReadout = {
    kind: UNTRUSTED_DOCUMENT_READOUT_KIND,
    source: 'mail',
    title: 'Fingerprint item',
    author: 'Fingerprint author',
    date: '2026-11-02T01:00:00.000Z',
    body: 'A fixed synthetic body used only to fingerprint the prompts.',
    truncated: false,
  };
  const map = buildDocumentMapRequest(readout, { index: 1, count: 2 }, 'Summarize this email', S3_LIMITS.callTimeoutMs);
  const summary = new PromptRenderer().render(composeDocumentSummaryPrompt('Summarize this email', readout), { capability: Capability.SUMMARIZATION, timeoutMs: TODAY_TIMEOUT_MS });
  return { mapVersion: DOCUMENT_MAP_PROMPT_VERSION, mapSha256: sha(map.prompt), documentSummarySha256: sha(summary.prompt) };
}

export interface Ch3PlanInputs {
  readonly cases: readonly Ch3Case[];
  readonly corpusDigest: string;
  readonly local: { readonly model: string; readonly digest: string };
  /** The chat-tier provider of the baseline (the Claude CLI) and its model flag, `null` = the CLI default. */
  readonly today: { readonly provider: 'claude-cli'; readonly model: string | null };
  /** sha256 per implementation file (default: read from the repo); tests pass an edited map. */
  readonly implementation?: ImplementationHashes;
}

export interface Ch3Plan {
  readonly kind: 'chunk-s3-ch3-plan';
  readonly version: string;
  readonly corpus: { readonly version: string; readonly seed: string; readonly sha256: string; readonly items: number; readonly aboveCap: number; readonly keyPoints: number };
  readonly armL: {
    readonly provider: 'ollama-cli-long-item';
    readonly model: string;
    readonly pinnedDigest: string;
    readonly locality: 'LOCAL';
    readonly calls: number;
    readonly mapCalls: number;
    readonly reduceCalls: number;
    readonly maxCallsPerItem: number;
    readonly estimatedMinutes: { readonly typical: number; readonly upper: number };
  };
  readonly today: { readonly provider: 'claude-cli'; readonly model: string | null; readonly calls: number; readonly timeoutMs: number };
  readonly judge: { readonly calls: 0; readonly note: string };
  readonly canaries: string;
  readonly limits: typeof S3_LIMITS;
  readonly prompts: ReturnType<typeof promptFingerprints>;
  readonly scorer: string;
  readonly bars: typeof CH3_BARS;
  readonly ownerLabels: { readonly pairs: number; readonly labels: number; readonly preferences: number };
  readonly implementation: ImplementationHashes;
  readonly digest: string;
}

export function buildCh3Plan(inputs: Ch3PlanInputs): Ch3Plan {
  const calls = inputs.cases.reduce((sum, c) => sum + c.plannedCalls, 0);
  const reduceCalls = inputs.cases.filter((c) => c.plannedCalls > 0).length;
  const body = {
    kind: 'chunk-s3-ch3-plan' as const,
    version: CH3_PLAN_VERSION,
    corpus: {
      version: CH3_CORPUS_VERSION,
      seed: CH3_CORPUS_SEED,
      sha256: inputs.corpusDigest,
      items: inputs.cases.length,
      aboveCap: inputs.cases.filter((c) => c.aboveCap).length,
      keyPoints: inputs.cases.reduce((sum, c) => sum + c.keyPoints.length, 0),
    },
    armL: {
      provider: 'ollama-cli-long-item' as const,
      model: inputs.local.model,
      pinnedDigest: inputs.local.digest,
      locality: 'LOCAL' as const,
      calls,
      mapCalls: calls - reduceCalls,
      reduceCalls,
      maxCallsPerItem: Math.max(0, ...inputs.cases.map((c) => c.plannedCalls)),
      estimatedMinutes: { typical: Math.ceil((calls * LOCAL_CALL_ESTIMATE_MS.typical) / 60_000), upper: Math.ceil((calls * LOCAL_CALL_ESTIMATE_MS.upper) / 60_000) },
    },
    today: { provider: inputs.today.provider, model: inputs.today.model, calls: inputs.cases.length, timeoutMs: TODAY_TIMEOUT_MS },
    judge: { calls: 0 as const, note: 'no model judge: the scorer is deterministic and the preference is the owner blind sheet' },
    canaries: CANARY_CLAUSE,
    limits: S3_LIMITS,
    prompts: promptFingerprints(),
    scorer: CH3_SCORER_VERSION,
    bars: CH3_BARS,
    ownerLabels: { pairs: inputs.cases.length, labels: inputs.cases.length * 2, preferences: inputs.cases.length },
    implementation: inputs.implementation ?? implementationHashes(),
  };
  return { ...body, digest: sha(JSON.stringify(body)).slice(0, 16) };
}

export function planLinesCh3(plan: Ch3Plan): string[] {
  return [
    `CH3 plan ${plan.digest} (corpus ${plan.corpus.sha256.slice(0, 12)}, ${plan.corpus.items} items, ${plan.corpus.aboveCap} above the ${plan.limits.maxWindows}-window cap, ${plan.corpus.keyPoints} key points)`,
    `  arm L: ${plan.armL.calls} LOCAL calls (${plan.armL.mapCalls} map + ${plan.armL.reduceCalls} reduce, <= ${plan.armL.maxCallsPerItem} per item) on ${plan.armL.model}@${plan.armL.pinnedDigest}; about ${plan.armL.estimatedMinutes.typical}-${plan.armL.estimatedMinutes.upper} min (5 s typical, 20 s bound per call)`,
    `  today: ${plan.today.calls} REMOTE calls on ${plan.today.provider}${plan.today.model === null ? '' : ` (${plan.today.model})`}, synthetic text only`,
    `  judge: ${plan.judge.calls} calls (${plan.judge.note})`,
    `  ${plan.canaries} per guarded provider`,
    `  owner blind labels: ${plan.ownerLabels.pairs} pairs = ${plan.ownerLabels.labels} labels + ${plan.ownerLabels.preferences} preferences`,
    `  prompts: ${plan.prompts.mapVersion} ${plan.prompts.mapSha256.slice(0, 12)}, document summary ${plan.prompts.documentSummarySha256.slice(0, 12)}; scorer ${plan.scorer}`,
    `  implementation: ${Object.keys(plan.implementation).length} source files hashed into the digest`,
    `  run: --mode run --digest ${plan.digest} (Strict: needs the owner's yes on this digest)`,
  ];
}

// ---------------------------------------------------------------- the run

export interface S3ItemRun {
  readonly kind: 'summary' | 'partial' | 'today' | 'S1' | 'refused';
  readonly reason?: string;
  /** The model-derived body (or Core's partial copy); never written to the report. */
  readonly body: string;
  readonly wallMs: number;
  readonly calls: number;
  readonly windows: number;
  readonly stratified: boolean;
  readonly read: number;
  readonly total: number;
  readonly withheld?: 'claim' | 'too-long';
}

export interface TodayItemRun {
  readonly outcome: 'ok' | 'withheld' | 'failed' | 'refused';
  readonly reason?: string;
  readonly body: string;
  readonly wallMs: number;
}

export interface Ch3ItemRun {
  readonly id: string;
  readonly s3: S3ItemRun;
  readonly today: TodayItemRun;
}

export interface Ch3RunDeps {
  readonly selector: ProviderSelector;
  readonly exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly today: AiProvider;
  readonly progress?: (line: string) => void;
  /** Called once between the local pass and the remote pass (CH5 stops its RSS sampler here). */
  readonly afterLocal?: () => Promise<void> | void;
}

/**
 * Today's delivered-text step, applied to BOTH arms as the runtime applies it (`handleDocumentSummary`,
 * `respondLongItemSummary`): the body as shown (`documentSummaryReply(...).shown`: links neutralized, emphasis stripped,
 * long lines capped), then `checkDocumentSummaryClaims` on it; a claim or an over-long text becomes today's fixed notice
 * (no regeneration). A fixed notice passes as written.
 */
export function deliveredText(text: string, item: Ch3Case['item']): { readonly text: string; readonly withheld?: 'claim' | 'too-long' } {
  const source = sourceOf(item.shape);
  if (isFixedDocumentSummaryNotice(text, source)) return { text };
  const language = replyLanguageOf(item.language);
  const shown = documentSummaryReply(text, '').shown;
  const verdict = checkDocumentSummaryClaims(shown, item.requestText, source, language, generalChatReplyPolicy(item.requestText));
  if (verdict.kind === 'clean') return { text: shown };
  return verdict.kind === 'claim' ? { text: verdict.notice, withheld: 'claim' } : { text: renderDocumentSummaryTooLong(language), withheld: 'too-long' };
}

const FAILED_TODAY = { ko: '(요약을 만들지 못했어요)', en: '(No summary: the call failed)' } as const;

export async function runS3Item(c: Ch3Case, deps: Pick<Ch3RunDeps, 'selector' | 'exclusive' | 'now'>): Promise<S3ItemRun> {
  const input = s3InputOf(c.item);
  if (input === undefined) return { kind: 'refused', reason: 'builder', body: '', wallMs: 0, calls: 0, windows: 0, stratified: false, read: 0, total: 0 };
  const started = deps.now();
  const outcome = await runS3ItemSummary(input, { selector: deps.selector, now: deps.now, ...(deps.exclusive !== undefined ? { exclusive: deps.exclusive } : {}) });
  const wallMs = Math.round(deps.now() - started);
  if (outcome.kind === 'summary' || outcome.kind === 'partial') {
    const shown = outcome.withheld !== undefined ? { text: outcome.body, withheld: outcome.withheld } : deliveredText(outcome.body, c.item);
    return {
      kind: outcome.kind,
      ...(outcome.kind === 'partial' ? { reason: outcome.reason } : {}),
      body: shown.text,
      wallMs,
      calls: outcome.audit.mapCalls + outcome.audit.reduceCalls,
      windows: outcome.audit.windows,
      stratified: outcome.audit.stratified,
      read: outcome.coverage.read,
      total: outcome.coverage.total,
      ...(shown.withheld !== undefined ? { withheld: shown.withheld } : {}),
    };
  }
  return { kind: outcome.kind, ...('reason' in outcome ? { reason: outcome.reason } : {}), body: '', wallMs, calls: 0, windows: 0, stratified: false, read: 0, total: 0 };
}

export async function runTodayItem(c: Ch3Case, provider: AiProvider, now: () => number): Promise<TodayItemRun> {
  const language = replyLanguageOf(c.item.language);
  const built = todayReadoutOf(c.item);
  if (!built.ok) return { outcome: 'refused', reason: built.refusal, body: '', wallMs: 0 };
  const request = new PromptRenderer().render(composeDocumentSummaryPrompt(c.item.requestText, built.readout), { capability: Capability.SUMMARIZATION, timeoutMs: TODAY_TIMEOUT_MS });
  const started = now();
  let text: string;
  try {
    const result = await provider.execute(request);
    text = typeof result?.text === 'string' ? result.text.trim() : '';
  } catch (error) {
    return { outcome: 'failed', reason: providerFailureReason(error), body: FAILED_TODAY[language], wallMs: Math.round(now() - started) };
  }
  const wallMs = Math.round(now() - started);
  const shown = deliveredText(text, c.item);
  return shown.withheld === undefined ? { outcome: 'ok', body: shown.text, wallMs } : { outcome: 'withheld', reason: shown.withheld, body: shown.text, wallMs };
}

/** Arm L over every item (strictly one at a time), then today over every item. */
export async function runCh3(cases: readonly Ch3Case[], deps: Ch3RunDeps): Promise<Ch3ItemRun[]> {
  const s3: S3ItemRun[] = [];
  for (const [index, c] of cases.entries()) {
    const run = await runS3Item(c, deps);
    s3.push(run);
    deps.progress?.(`  S3 ${index + 1}/${cases.length} ${c.item.id}: ${run.kind}${run.reason !== undefined ? ` (${run.reason})` : ''}, ${run.calls} calls, ${run.wallMs} ms`);
  }
  await deps.afterLocal?.();
  const out: Ch3ItemRun[] = [];
  for (const [index, c] of cases.entries()) {
    const today = await runTodayItem(c, deps.today, deps.now);
    deps.progress?.(`  today ${index + 1}/${cases.length} ${c.item.id}: ${today.outcome}, ${today.wallMs} ms`);
    out.push({ id: c.item.id, s3: s3[index] as S3ItemRun, today });
  }
  return out;
}

// ---------------------------------------------------------------- CH5

export interface LatencyStats {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** Nearest-rank percentiles. */
export function latencyStats(values: readonly number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number));
  return { n: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? 0 };
}

export interface Ch5Report {
  readonly bounds: { readonly wallMs: number; readonly callTimeoutMs: number; readonly maxLocalCalls: number; readonly maxWindows: number; readonly concurrency: 1 };
  readonly modes: Readonly<Record<'today' | 's3' | 's3-packed' | 's3-stratified', LatencyStats>>;
  readonly localCalls: LatencyStats & { readonly overCallBound: number };
  readonly callsPerItemMax: number;
  readonly windowsMax: number;
  readonly embeddings: number;
  readonly maxConcurrentLocalCalls: number;
  readonly breaches: { readonly wall: number; readonly callTimeout: number; readonly callBound: number };
  readonly peakRss: RssReport;
  readonly verdict: 'PASSED' | 'FAILED';
  readonly reasons: readonly string[];
}

export function buildCh5(
  cases: readonly Ch3Case[],
  runs: readonly Ch3ItemRun[],
  local: { readonly callMs: readonly number[]; readonly embeddings: number; readonly maxInFlight: number },
  rss: RssReport,
): Ch5Report {
  const byId = new Map(cases.map((c) => [c.item.id, c] as const));
  const s3 = runs.map((run) => run.s3);
  const stratifiedOf = (run: Ch3ItemRun): boolean => byId.get(run.id)?.stratified === true;
  const breaches = {
    wall: s3.filter((r) => r.kind === 'partial' && r.reason === 'wall').length,
    callTimeout: s3.filter((r) => r.kind === 'partial' && r.reason === 'call-timeout').length,
    callBound: s3.filter((r) => r.kind === 'partial' && r.reason === 'call-bound').length,
  };
  const modes = {
    today: latencyStats(runs.map((r) => r.today.wallMs)),
    s3: latencyStats(s3.map((r) => r.wallMs)),
    's3-packed': latencyStats(runs.filter((r) => !stratifiedOf(r)).map((r) => r.s3.wallMs)),
    's3-stratified': latencyStats(runs.filter(stratifiedOf).map((r) => r.s3.wallMs)),
  };
  const calls = latencyStats(local.callMs);
  const overCallBound = local.callMs.filter((ms) => ms > S3_LIMITS.callTimeoutMs).length;
  const callsPerItemMax = Math.max(0, ...s3.map((r) => r.calls));
  const windowsMax = Math.max(0, ...s3.map((r) => r.windows));
  const reasons: string[] = [];
  if (modes.s3.max > S3_LIMITS.wallMs) reasons.push(`an S3 run took ${modes.s3.max} ms > ${S3_LIMITS.wallMs} ms`);
  if (breaches.wall + breaches.callTimeout + breaches.callBound > 0) reasons.push(`bound breaches: wall ${breaches.wall}, call timeout ${breaches.callTimeout}, call bound ${breaches.callBound}`);
  if (overCallBound > 0) reasons.push(`${overCallBound} local calls over ${S3_LIMITS.callTimeoutMs} ms`);
  if (callsPerItemMax > S3_LIMITS.maxLocalCalls) reasons.push(`${callsPerItemMax} calls in one item > ${S3_LIMITS.maxLocalCalls}`);
  if (windowsMax > S3_LIMITS.maxWindows) reasons.push(`${windowsMax} windows > ${S3_LIMITS.maxWindows}`);
  if (local.maxInFlight > 1) reasons.push(`${local.maxInFlight} local calls in flight at once`);
  if (local.embeddings > 0) reasons.push(`${local.embeddings} embedding calls (S3 makes none)`);
  return {
    bounds: { wallMs: S3_LIMITS.wallMs, callTimeoutMs: S3_LIMITS.callTimeoutMs, maxLocalCalls: S3_LIMITS.maxLocalCalls, maxWindows: S3_LIMITS.maxWindows, concurrency: 1 },
    modes,
    localCalls: { ...calls, overCallBound },
    callsPerItemMax,
    windowsMax,
    embeddings: local.embeddings,
    maxConcurrentLocalCalls: local.maxInFlight,
    breaches,
    peakRss: rss,
    verdict: reasons.length === 0 ? 'PASSED' : 'FAILED',
    reasons,
  };
}

// ---------------------------------------------------------------- report and verdict

export interface Ch3ItemReport {
  readonly id: string;
  readonly shape: string;
  readonly language: string;
  readonly aboveCap: boolean;
  readonly windows: number;
  readonly stratified: boolean;
  readonly s3: { readonly kind: string; readonly reason?: string; readonly withheld?: string; readonly calls: number; readonly read: number; readonly total: number; readonly wallMs: number; readonly covered: number; readonly valuePresent: number; readonly unanchored: number; readonly keyPoints: number; readonly invented: number };
  readonly today: { readonly outcome: string; readonly reason?: string; readonly wallMs: number; readonly covered: number; readonly valuePresent: number; readonly unanchored: number; readonly keyPoints: number; readonly invented: number };
}

export interface Ch3Report {
  readonly kind: 'chunk-s3-ch3-report';
  readonly status: 'NON-GATING' | 'FAILED' | 'INVALID';
  readonly planDigest: string;
  readonly corpus: Ch3Plan['corpus'];
  readonly arms: { readonly S3: ArmAggregate; readonly today: ArmAggregate };
  readonly verdict: {
    readonly coverage: { readonly value: number; readonly bar: number; readonly pass: boolean };
    readonly invented: { readonly inventedFreeShare: number; readonly bar: number; readonly pass: boolean };
    readonly preference: 'pending the owner blind sheet (score-labels)';
  };
  readonly ch5: Ch5Report;
  readonly invalid: readonly string[];
  readonly providers: { readonly local: ProviderOutageReport; readonly today: ProviderOutageReport };
  readonly items: readonly Ch3ItemReport[];
}

/** Scores both arms and builds the content-free report. `invalid` lists why the run is not trustworthy (empty when valid). */
export function buildCh3Report(
  plan: Ch3Plan,
  cases: readonly Ch3Case[],
  runs: readonly Ch3ItemRun[],
  ch5: Ch5Report,
  providers: { readonly local: ProviderOutageReport; readonly today: ProviderOutageReport },
): { readonly report: Ch3Report; readonly scores: { readonly S3: readonly ItemScore[]; readonly today: readonly ItemScore[] } } {
  const byId = new Map(cases.map((c) => [c.item.id, c] as const));
  const invalid: string[] = [];
  const s3Scores: ItemScore[] = [];
  const todayScores: ItemScore[] = [];
  const items: Ch3ItemReport[] = [];
  for (const run of runs) {
    const c = byId.get(run.id);
    if (c === undefined) {
      invalid.push(`${run.id}: not in the corpus`);
      continue;
    }
    if (run.s3.kind !== 'summary' && run.s3.kind !== 'partial') invalid.push(`${run.id}: S3 ended ${run.s3.kind}${run.s3.reason !== undefined ? ` (${run.s3.reason})` : ''}, no local run`);
    if (run.today.outcome === 'refused') invalid.push(`${run.id}: today's builder refused the item`);
    const source = valueAtoms(`${itemSourceText(c.item)}\n${c.item.requestText}`);
    const s3 = scoreSummary(c, run.s3.body, source);
    const today = scoreSummary(c, run.today.body, source);
    s3Scores.push(s3);
    todayScores.push(today);
    items.push({
      id: run.id,
      shape: c.item.shape,
      language: c.item.language,
      aboveCap: c.aboveCap,
      windows: c.windows,
      stratified: c.stratified,
      s3: {
        kind: run.s3.kind,
        ...(run.s3.reason !== undefined ? { reason: run.s3.reason } : {}),
        ...(run.s3.withheld !== undefined ? { withheld: run.s3.withheld } : {}),
        calls: run.s3.calls,
        read: run.s3.read,
        total: run.s3.total,
        wallMs: run.s3.wallMs,
        covered: s3.covered,
        valuePresent: s3.valuePresent,
        unanchored: s3.unanchored,
        keyPoints: s3.keyPoints,
        invented: s3.invented.length,
      },
      today: {
        outcome: run.today.outcome,
        ...(run.today.reason !== undefined ? { reason: run.today.reason } : {}),
        wallMs: run.today.wallMs,
        covered: today.covered,
        valuePresent: today.valuePresent,
        unanchored: today.unanchored,
        keyPoints: today.keyPoints,
        invented: today.invented.length,
      },
    });
  }
  if (runs.length !== cases.length) invalid.push(`ran ${runs.length} of ${cases.length} items`);
  if (providers.local.invalidReason !== undefined) invalid.push(`local provider unavailable: ${providers.local.invalidReason}`);
  if (providers.today.invalidReason !== undefined) invalid.push(`today provider unavailable: ${providers.today.invalidReason}`);
  const arms = { S3: aggregate(cases, s3Scores), today: aggregate(cases, todayScores) };
  const coverage = { value: arms.S3.coverage, bar: CH3_BARS.coverage, pass: arms.S3.coverage >= CH3_BARS.coverage };
  const invented = { inventedFreeShare: arms.S3.inventedFreeShare, bar: CH3_BARS.inventedFreeShare, pass: arms.S3.inventedFreeShare >= CH3_BARS.inventedFreeShare };
  const status = invalid.length > 0 ? 'INVALID' : coverage.pass && invented.pass ? 'NON-GATING' : 'FAILED';
  return {
    report: {
      kind: 'chunk-s3-ch3-report',
      status,
      planDigest: plan.digest,
      corpus: plan.corpus,
      arms,
      verdict: { coverage, invented, preference: 'pending the owner blind sheet (score-labels)' },
      ch5,
      invalid,
      providers,
      items,
    },
    scores: { S3: s3Scores, today: todayScores },
  };
}

export function summaryLinesCh3(report: Ch3Report): string[] {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const strata = (arm: ArmAggregate): string => Object.entries(arm.aboveCapPerStratum).map(([id, s]) => `${id} ${pct(s.coverage)}`).join(', ');
  return [
    `CH3 ${report.status} (plan ${report.planDigest})`,
    `  S3   coverage ${pct(report.arms.S3.coverage)} (bar ${pct(CH3_BARS.coverage)}), values present anywhere ${pct(report.arms.S3.valuePresentShare)}, items with unanchored values ${report.arms.S3.itemsWithUnanchored}, invented-free items ${pct(report.arms.S3.inventedFreeShare)} (bar ${pct(CH3_BARS.inventedFreeShare)})`,
    `  today coverage ${pct(report.arms.today.coverage)}, invented-free items ${pct(report.arms.today.inventedFreeShare)}`,
    `  above-cap per stratum: S3 ${strata(report.arms.S3)}; today ${strata(report.arms.today)}`,
    `  CH5 ${report.ch5.verdict}: S3 p50/p95 ${report.ch5.modes.s3.p50}/${report.ch5.modes.s3.p95} ms, today p50/p95 ${report.ch5.modes.today.p50}/${report.ch5.modes.today.p95} ms, local call p95 ${report.ch5.localCalls.p95} ms, peak RSS ${report.ch5.peakRss.measured ? `${report.ch5.peakRss.peakProcessKiB} KiB` : 'not measured'}`,
    ...report.ch5.reasons.map((reason) => `    ${reason}`),
    ...report.invalid.map((reason) => `  INVALID: ${reason}`),
    `  preference: ${report.verdict.preference}`,
  ];
}
