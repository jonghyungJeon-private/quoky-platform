/**
 * Retrieval metrics for ADR-0124 section 7 / 6: Recall@k, MRR and nDCG@10 over ranked passages, with binary relevance.
 * A case may have more than one relevant passage (a needle can straddle two passages); Recall@k is then "any relevant
 * passage in the top k" (one needle, found or not).
 */

/** The 1-based rank of the first relevant item of `ranked`, or `null` when none of them is relevant. */
export function firstRelevantRank(ranked: readonly number[], relevant: ReadonlySet<number>): number | null {
  for (let at = 0; at < ranked.length; at += 1) if (relevant.has(ranked[at] as number)) return at + 1;
  return null;
}

export function recallAtK(rank: number | null, k: number): number {
  return rank !== null && rank <= k ? 1 : 0;
}

export function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

/** nDCG@k with binary gains: DCG = sum rel_i / log2(i + 1); the ideal ranking puts min(R, k) relevant items first. */
export function ndcgAtK(ranked: readonly number[], relevant: ReadonlySet<number>, k: number): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  for (let at = 0; at < Math.min(k, ranked.length); at += 1) if (relevant.has(ranked[at] as number)) dcg += 1 / Math.log2(at + 2);
  let ideal = 0;
  for (let at = 0; at < Math.min(k, relevant.size); at += 1) ideal += 1 / Math.log2(at + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

export const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

/** Rounds a metric to 4 decimals so a report is stable text. */
export const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
