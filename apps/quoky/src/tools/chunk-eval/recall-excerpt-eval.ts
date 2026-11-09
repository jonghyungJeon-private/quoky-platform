/**
 * ADR-0124 phase 2 P2-6: offline measurement of matched-passage excerpts for long recalled memories (stage R, CH7).
 *
 * For every query the REAL retriever results (top 10) are turned into what the context builder would deliver under each
 * rendering variant by running them through the real `ContextBuilder` (constructed with the variant), so selection, the
 * credential filter, dedup, limits and ordering are production's (no token budget: the harness configures none).
 *
 * Metrics per variant: fact delivered (long-memory queries: gold delivered AND the asked fact sentence fully contained in
 * the delivered text, the added ellipses ignored), gold delivered (all queries), delivered characters per query.
 * The verdict is pre-declared (it is part of the plan digest) and printed with the summary.
 */
import { Capability, ContextBuilder, IntentType, RiskLevel, TaskStatus, type MemoryManager, type MemoryRetriever, type RecallExcerptVariant, type RetrievedMemory, type Task } from '@quoky/core';
import type { MemoryItem, MemoryQuery } from './memory-set';

export const EXCERPT_VARIANTS: readonly RecallExcerptVariant[] = ['V0', 'V1', 'V2'];
/** Same limit as `DURABLE_RECALL_LIMIT` in context-builder.ts (pinned by a test). */
export const DELIVERED_ENTRY_LIMIT = 10;

export const EXCERPT_VERDICT_RULE = {
  adoptV1: 'fact-delivered(V1) > fact-delivered(V0) AND gold-delivered(V1) == gold-delivered(V0)',
  adoptV2: 'V1 qualifies AND fact-delivered(V2) >= fact-delivered(V1) + 0.10 AND gold-delivered(V2) == gold-delivered(V0) AND p95 delivered chars(V2) <= 2 x p95(V0)',
  otherwise: 'the best qualifying of V1 / V0 (V0 when none qualifies)',
  text: 'adopt V1 iff fact-delivered(V1) > fact-delivered(V0) and gold-delivered(V1) == gold-delivered(V0); adopt V2 instead iff additionally fact-delivered(V2) >= fact-delivered(V1) + 0.10 and p95 delivered chars(V2) <= 2 x p95(V0); else the best qualifying of V1 / V0',
  factSentence: 'the asked fact sentence: from factOffsets[factIndex] up to and including the first sentence terminator (. ! ? or the CJK full stop) that is followed by whitespace or the end of the block; the filler paragraph after it is not part of the fact',
  factDelivered: 'targetLong query AND a gold memory delivered AND the fact sentence (trimmed) occurs in the delivered text of that memory with the added ellipses removed',
} as const;

export interface DeliveredEntry {
  readonly id: string;
  readonly text: string;
}

const HARNESS_TASK: Task = {
  id: 'excerpt-eval-task',
  title: 'excerpt eval',
  description: 'excerpt eval',
  status: TaskStatus.PENDING,
  intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary: 'excerpt eval' },
  riskLevel: RiskLevel.LOW,
  context: { platform: 'eval', channelId: 'eval', userId: 'eval', direct: true },
  actorId: 'ch7-runtime-actor',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
};
const NO_MEMORY = { recentShortTerm: async () => [], projectMemory: async () => undefined } as unknown as MemoryManager;

/**
 * What the REAL `ContextBuilder` delivers for the retriever results under `variant`: selection, credential filter, dedup,
 * limits, excerpting and final ordering are production's (the builder is constructed with the variant). Entries come back
 * in the builder's order.
 */
export async function deliveredFor(results: readonly RetrievedMemory[], variant: RecallExcerptVariant): Promise<DeliveredEntry[]> {
  const retriever: MemoryRetriever = { retrieve: async () => [...results] };
  const bundle = await new ContextBuilder(NO_MEMORY, {}, retriever, undefined, variant).build(HARNESS_TASK);
  return (bundle.durableRecall ?? []).map((entry) => ({ id: entry.source.memoryId, text: entry.content }));
}

/** The asked fact sentence of a long memory (see `EXCERPT_VERDICT_RULE.factSentence`). */
export function factSentenceOf(memory: Pick<MemoryItem, 'text' | 'factOffsets'>, factIndex: number): string | undefined {
  const start = memory.factOffsets[factIndex];
  if (start === undefined) return undefined;
  const end = memory.factOffsets[factIndex + 1] ?? memory.text.length;
  const block = memory.text.slice(start, end);
  const match = /[.!?。][\s]|[.!?。]$/u.exec(block);
  const sentence = (match === null ? block : block.slice(0, match.index + 1)).trim();
  return sentence.length === 0 ? undefined : sentence;
}

const stripEllipsis = (text: string): string => text.replace(/…/g, '');

export interface ExcerptQueryOutcome {
  readonly targetLong: boolean;
  readonly beyondCut: boolean;
  readonly goldDelivered: boolean;
  readonly factDelivered: boolean;
  readonly chars: number;
}

export function excerptOutcome(
  query: Pick<MemoryQuery, 'gold' | 'targetLong' | 'factIndex' | 'beyondCut'>,
  memories: ReadonlyMap<string, Pick<MemoryItem, 'text' | 'factOffsets'>>,
  delivered: readonly DeliveredEntry[],
): ExcerptQueryOutcome {
  const goldEntries = delivered.filter((entry) => query.gold.includes(entry.id));
  let factDelivered = false;
  if (query.targetLong && query.factIndex !== null) {
    for (const entry of goldEntries) {
      const memory = memories.get(entry.id);
      const fact = memory === undefined ? undefined : factSentenceOf(memory, query.factIndex);
      if (fact !== undefined && stripEllipsis(entry.text).includes(fact)) factDelivered = true;
    }
  }
  return { targetLong: query.targetLong, beyondCut: query.beyondCut, goldDelivered: goldEntries.length > 0, factDelivered, chars: delivered.reduce((sum, entry) => sum + entry.text.length, 0) };
}

export interface Share {
  readonly n: number;
  readonly of: number;
  readonly share: number;
}
const shareOf = (n: number, of: number): Share => ({ n, of, share: of === 0 ? 0 : Math.round((n / of) * 10_000) / 10_000 });

export interface VariantMetrics {
  readonly variant: RecallExcerptVariant;
  readonly factDelivered: Share;
  readonly factDeliveredBeyondCut: Share;
  readonly factDeliveredWithinCut: Share;
  readonly goldDelivered: Share;
  readonly chars: { readonly p50: number; readonly p95: number; readonly max: number };
}

/** Nearest-rank percentile of a numeric sample (deterministic, no interpolation). */
export function nearestRank(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] as number;
}

export function variantMetrics(variant: RecallExcerptVariant, outcomes: readonly ExcerptQueryOutcome[]): VariantMetrics {
  const long = outcomes.filter((o) => o.targetLong);
  const beyond = long.filter((o) => o.beyondCut);
  const within = long.filter((o) => !o.beyondCut);
  const chars = outcomes.map((o) => o.chars);
  return {
    variant,
    factDelivered: shareOf(long.filter((o) => o.factDelivered).length, long.length),
    factDeliveredBeyondCut: shareOf(beyond.filter((o) => o.factDelivered).length, beyond.length),
    factDeliveredWithinCut: shareOf(within.filter((o) => o.factDelivered).length, within.length),
    goldDelivered: shareOf(outcomes.filter((o) => o.goldDelivered).length, outcomes.length),
    chars: { p50: nearestRank(chars, 0.5), p95: nearestRank(chars, 0.95), max: chars.length === 0 ? 0 : Math.max(...chars) },
  };
}

export type ExcerptVerdict = 'adopt V1' | 'adopt V2' | 'keep V0';

/** The pre-declared verdict (`EXCERPT_VERDICT_RULE`). Comparisons use the raw counts, never rounded shares. */
export function excerptVerdict(v0: VariantMetrics, v1: VariantMetrics, v2: VariantMetrics): ExcerptVerdict {
  const v1Qualifies = v1.factDelivered.n > v0.factDelivered.n && v1.goldDelivered.n === v0.goldDelivered.n;
  const v2Qualifies =
    v1Qualifies &&
    v2.goldDelivered.n === v0.goldDelivered.n &&
    v2.factDelivered.of > 0 &&
    v2.factDelivered.n / v2.factDelivered.of >= v1.factDelivered.n / v1.factDelivered.of + 0.1 - 1e-12 &&
    v2.chars.p95 <= 2 * v0.chars.p95;
  if (v2Qualifies) return 'adopt V2';
  if (v1Qualifies) return 'adopt V1';
  return 'keep V0';
}

export interface ExcerptComparison {
  readonly queries: number;
  readonly longQueries: number;
  readonly variants: readonly VariantMetrics[];
  readonly verdict: ExcerptVerdict;
  readonly rule: string;
}

export function buildExcerptComparison(outcomesByVariant: Readonly<Record<RecallExcerptVariant, readonly ExcerptQueryOutcome[]>>): ExcerptComparison {
  const [v0, v1, v2] = EXCERPT_VARIANTS.map((variant) => variantMetrics(variant, outcomesByVariant[variant])) as [VariantMetrics, VariantMetrics, VariantMetrics];
  return { queries: outcomesByVariant.V0.length, longQueries: outcomesByVariant.V0.filter((o) => o.targetLong).length, variants: [v0, v1, v2], verdict: excerptVerdict(v0, v1, v2), rule: EXCERPT_VERDICT_RULE.text };
}

const pct = (share: Share): string => `${(share.share * 100).toFixed(1)}% (${share.n}/${share.of})`;

export function excerptComparisonLines(comparison: ExcerptComparison): string[] {
  const out = [`recall excerpt variants (ADR-0124 P2-6, offline, NON-GATING; ${comparison.longQueries} long-memory queries of ${comparison.queries}):`];
  for (const m of comparison.variants) out.push(`  ${m.variant}: fact delivered ${pct(m.factDelivered)} (beyond 8,000-unit cut ${pct(m.factDeliveredBeyondCut)}; within ${pct(m.factDeliveredWithinCut)}); gold delivered ${pct(m.goldDelivered)}; delivered chars p50 ${m.chars.p50} / p95 ${m.chars.p95} / max ${m.chars.max}`);
  out.push(`  pre-declared verdict rule: ${comparison.rule}`);
  out.push(`  verdict: ${comparison.verdict} (production stays V0 until the owner adopts a variant)`);
  return out;
}
