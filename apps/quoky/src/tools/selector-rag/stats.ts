// ADR-0123 D6 (RAG-2): the paired analysis of the experiment. Pure functions, seeded, no I/O.

/** mulberry32: a small seeded PRNG so every resample is reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from any string (FNV-1a). */
export function seedFromString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface BootstrapResult {
  readonly cases: number;
  readonly runs: number;
  /** Mean error rate of arm X and arm Y (errors / (cases x runs)). */
  readonly rateX: number;
  readonly rateY: number;
  /** rateX - rateY: negative means X has fewer errors than Y. */
  readonly diff: number;
  readonly ci95: readonly [number, number];
  readonly excludesZero: boolean;
  readonly resamples: number;
}

export const BOOTSTRAP_RESAMPLES = 10_000;

/**
 * Paired bootstrap over cases (case-level resampling, errors summed over the runs): `errorsX[i]` and `errorsY[i]` are the
 * error counts (0..runs) of case i under the two arms. The 95% interval is the 2.5th..97.5th percentile of the resampled
 * error-rate difference.
 */
export function pairedBootstrap(errorsX: readonly number[], errorsY: readonly number[], runs: number, seed: number, resamples = BOOTSTRAP_RESAMPLES): BootstrapResult {
  if (errorsX.length !== errorsY.length) throw new Error('paired arrays must have the same length');
  const n = errorsX.length;
  if (n === 0) throw new Error('no cases');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a positive integer');
  const diffs = errorsX.map((value, index) => value - (errorsY[index] as number));
  const denominator = n * runs;
  const total = diffs.reduce((sum, value) => sum + value, 0);
  const random = seededRandom(seed);
  const samples = new Float64Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(random() * n)] as number;
    samples[r] = sum / denominator;
  }
  samples.sort();
  const lo = samples[Math.floor(0.025 * (resamples - 1))] as number;
  const hi = samples[Math.ceil(0.975 * (resamples - 1))] as number;
  const sumX = errorsX.reduce((sum, value) => sum + value, 0);
  const sumY = errorsY.reduce((sum, value) => sum + value, 0);
  return {
    cases: n,
    runs,
    rateX: sumX / denominator,
    rateY: sumY / denominator,
    diff: total / denominator,
    ci95: [lo, hi],
    excludesZero: lo > 0 || hi < 0,
    resamples,
  };
}

export interface McNemarResult {
  /** X correct, Y wrong. */
  readonly b: number;
  /** X wrong, Y correct. */
  readonly c: number;
  readonly concordant: number;
  /** Exact two-sided binomial p on the discordant pairs (1 when there are none). */
  readonly pExact: number;
}

/** A case is correct under the per-case majority rule when strictly more than half of its runs were correct. */
export function majorityCorrect(errors: number, runs: number): boolean {
  return (runs - errors) * 2 > runs;
}

function binomialTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  // P(X <= min(k, n-k)) doubled, X ~ Bin(n, 0.5), computed in log space for stability.
  const logChoose = (nn: number, kk: number): number => {
    let sum = 0;
    for (let i = 1; i <= kk; i += 1) sum += Math.log((nn - kk + i) / i);
    return sum;
  };
  const m = Math.min(k, n - k);
  let tail = 0;
  for (let i = 0; i <= m; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.log(2));
  return Math.min(1, 2 * tail);
}

/** McNemar on the per-case majority correctness of two arms (secondary check). */
export function mcnemar(errorsX: readonly number[], errorsY: readonly number[], runs: number): McNemarResult {
  if (errorsX.length !== errorsY.length) throw new Error('paired arrays must have the same length');
  let b = 0;
  let c = 0;
  let concordant = 0;
  errorsX.forEach((value, index) => {
    const x = majorityCorrect(value, runs);
    const y = majorityCorrect(errorsY[index] as number, runs);
    if (x && !y) b += 1;
    else if (!x && y) c += 1;
    else concordant += 1;
  });
  return { b, c, concordant, pExact: binomialTwoSided(b, b + c) };
}

/**
 * `m_X(e) = min over runs of accuracy(e, r)` and the floor `S_X = min over entries of m_X(e)`.
 * `correct[entry][run]` is the per-run accuracy of the entry (0..1).
 */
export function entryFloors(accuracyByEntryRun: Readonly<Record<string, readonly number[]>>): { readonly perEntry: Readonly<Record<string, number>>; readonly floor: number } {
  const perEntry: Record<string, number> = {};
  let floor = Number.POSITIVE_INFINITY;
  for (const [entry, runs] of Object.entries(accuracyByEntryRun)) {
    if (runs.length === 0) continue;
    const minimum = Math.min(...runs);
    perEntry[entry] = minimum;
    floor = Math.min(floor, minimum);
  }
  return { perEntry, floor: Number.isFinite(floor) ? floor : 0 };
}
