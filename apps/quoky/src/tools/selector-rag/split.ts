// ADR-0123 D6: the stratified 30% dev / 70% held-out split by a seeded hash of the case id, and the pool -> gold
// similarity strata (leakage control) with the validity check of the low-similarity stratum. Pure functions.
import { createHash } from 'node:crypto';

export const DEV_FRACTION = 0.3;
export const SPLIT_SEED = 'adr-0123-d6-split-v1';
/** The strata floor: cases below this cosine are always "low similarity". */
export const BUCKET_FLOOR = 0.7;
export const TAU_LOW_CAP = 0.8;
export const TAU_LOW_MARGIN = 0.05;
export const LOW_STRATUM_MIN_SHARE = 0.5;
export const LOW_STRATUM_MIN_PER_ENTRY = 10;

export interface SplitCase {
  readonly id: string;
  /** The gold entry id, or `none`. */
  readonly entry: string;
}

export interface SplitResult {
  readonly dev: readonly string[];
  readonly heldOut: readonly string[];
}

const hashOf = (seed: string, id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex');

/**
 * Stratified per entry: within each entry the cases are ordered by `sha256(seed:id)` and the first
 * `round(0.3 x n)` go to dev (an entry with at least 2 cases always has at least 1 in each part). Order-independent.
 */
export function splitCases(cases: readonly SplitCase[], seed: string = SPLIT_SEED, devFraction: number = DEV_FRACTION): SplitResult {
  const byEntry = new Map<string, SplitCase[]>();
  for (const golden of cases) byEntry.set(golden.entry, [...(byEntry.get(golden.entry) ?? []), golden]);
  const dev: string[] = [];
  const heldOut: string[] = [];
  for (const [, members] of [...byEntry.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ordered = [...members].sort((a, b) => {
      const ha = hashOf(seed, a.id);
      const hb = hashOf(seed, b.id);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    let devCount = Math.round(devFraction * ordered.length);
    if (ordered.length >= 2) devCount = Math.min(ordered.length - 1, Math.max(1, devCount));
    else devCount = 0;
    ordered.forEach((golden, index) => (index < devCount ? dev : heldOut).push(golden.id));
  }
  return { dev: dev.sort(), heldOut: heldOut.sort() };
}

export type Bucket = 'lt-0.70' | '0.70-tauLow' | 'tauLow-tau' | 'flagged';
export const BUCKETS: readonly Bucket[] = ['lt-0.70', '0.70-tauLow', 'tauLow-tau', 'flagged'];

export type TauLowResult = { readonly abort: false; readonly tauLow: number } | { readonly abort: true; readonly reason: string };

/** `tauLow = min(0.80, tau - 0.05)`; the experiment aborts before any run when `tau - 0.05 < 0.70`. */
export function tauLowFor(tau: number): TauLowResult {
  if (tau - TAU_LOW_MARGIN < BUCKET_FLOOR - 1e-9) return { abort: true, reason: `tau ${tau.toFixed(4)} - 0.05 is below ${BUCKET_FLOOR}: the strata cannot be formed` };
  return { abort: false, tauLow: Math.min(TAU_LOW_CAP, tau - TAU_LOW_MARGIN) };
}

export function bucketOf(maxCosine: number, tau: number, tauLow: number): Bucket {
  if (maxCosine >= tau) return 'flagged';
  if (maxCosine >= tauLow) return 'tauLow-tau';
  if (maxCosine >= BUCKET_FLOOR) return '0.70-tauLow';
  return 'lt-0.70';
}

export interface BucketCase extends SplitCase {
  readonly maxCosine: number;
}

export interface ValidityReport {
  readonly total: number;
  readonly byBucket: Readonly<Record<Bucket, number>>;
  /** Cases below tauLow: the primary stratum. */
  readonly lowStratum: number;
  readonly lowShare: number;
  readonly lowPerEntry: Readonly<Record<string, number>>;
  readonly entriesBelowMin: readonly string[];
  readonly shareOk: boolean;
  readonly perEntryOk: boolean;
  readonly valid: boolean;
}

/** Bucket sizes of a case set and the validity check of the low-similarity stratum (>= 50% and >= 10 per entry). */
export function validity(cases: readonly BucketCase[], tau: number, tauLow: number, minShare = LOW_STRATUM_MIN_SHARE, minPerEntry = LOW_STRATUM_MIN_PER_ENTRY): ValidityReport {
  const byBucket: Record<Bucket, number> = { 'lt-0.70': 0, '0.70-tauLow': 0, 'tauLow-tau': 0, flagged: 0 };
  const lowPerEntry: Record<string, number> = {};
  const allEntries = new Set<string>();
  for (const golden of cases) {
    allEntries.add(golden.entry);
    const bucket = bucketOf(golden.maxCosine, tau, tauLow);
    byBucket[bucket] += 1;
    if (bucket === 'lt-0.70' || bucket === '0.70-tauLow') lowPerEntry[golden.entry] = (lowPerEntry[golden.entry] ?? 0) + 1;
  }
  const lowStratum = byBucket['lt-0.70'] + byBucket['0.70-tauLow'];
  const lowShare = cases.length === 0 ? 0 : lowStratum / cases.length;
  const entriesBelowMin = [...allEntries].filter((entry) => (lowPerEntry[entry] ?? 0) < minPerEntry).sort();
  const shareOk = lowShare >= minShare;
  const perEntryOk = entriesBelowMin.length === 0;
  return { total: cases.length, byBucket, lowStratum, lowShare, lowPerEntry, entriesBelowMin, shareOk, perEntryOk, valid: shareOk && perEntryOk };
}
