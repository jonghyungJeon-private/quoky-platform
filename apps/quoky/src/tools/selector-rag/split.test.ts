import { describe, expect, it } from 'vitest';
import { BUCKET_FLOOR, bucketOf, splitCases, tauLowFor, validity, type SplitCase } from './split';

const cases = (entry: string, n: number): SplitCase[] => Array.from({ length: n }, (_, i) => ({ id: `${entry}-${i}`, entry }));

describe('ADR-0123 D6 split', () => {
  const all = [...cases('a', 100), ...cases('b', 20), ...cases('c', 3), ...cases('d', 1)];

  it('is deterministic, disjoint and covers every case', () => {
    const first = splitCases(all);
    const second = splitCases([...all].reverse());
    expect(second).toEqual(first);
    expect(new Set([...first.dev, ...first.heldOut]).size).toBe(all.length);
    expect(first.dev.filter((id) => first.heldOut.includes(id))).toEqual([]);
  });

  it('stratifies 30/70 per entry and keeps both parts non-empty for entries of 2 or more', () => {
    const { dev } = splitCases(all);
    const count = (entry: string) => dev.filter((id) => id.startsWith(`${entry}-`)).length;
    expect(count('a')).toBe(30);
    expect(count('b')).toBe(6);
    expect(count('c')).toBe(1);
    expect(count('d')).toBe(0);
  });

  it('a different seed gives a different split; the same seed the same one', () => {
    expect(splitCases(all, 'other')).not.toEqual(splitCases(all));
    expect(splitCases(all, 'other')).toEqual(splitCases(all, 'other'));
  });
});

describe('ADR-0123 D6 leakage buckets', () => {
  it('tau_low = min(0.80, tau - 0.05) and aborts below 0.70', () => {
    expect(tauLowFor(0.95)).toEqual({ abort: false, tauLow: 0.8 });
    const mid = tauLowFor(0.79);
    expect(mid.abort).toBe(false);
    expect(mid.abort ? 0 : mid.tauLow).toBeCloseTo(0.74, 10);
    expect(tauLowFor(0.7).abort).toBe(true);
    expect(tauLowFor(0.75).abort).toBe(false);
    expect(BUCKET_FLOOR).toBe(0.7);
  });

  it('assigns the four buckets at their boundaries (the upper edge belongs to the next bucket)', () => {
    expect(bucketOf(0.69, 0.9, 0.8)).toBe('lt-0.70');
    expect(bucketOf(0.7, 0.9, 0.8)).toBe('0.70-tauLow');
    expect(bucketOf(0.8, 0.9, 0.8)).toBe('tauLow-tau');
    expect(bucketOf(0.9, 0.9, 0.8)).toBe('flagged');
  });

  it('validity needs >= 50% low-similarity cases and >= 10 per entry', () => {
    const make = (entry: string, low: number, high: number) => [
      ...Array.from({ length: low }, (_, i) => ({ id: `${entry}-l${i}`, entry, maxCosine: 0.5 })),
      ...Array.from({ length: high }, (_, i) => ({ id: `${entry}-h${i}`, entry, maxCosine: 0.85 })),
    ];
    const good = validity([...make('x', 12, 5), ...make('y', 10, 10)], 0.9, 0.8);
    expect(good.valid).toBe(true);
    expect(good.lowStratum).toBe(22);
    expect(good.byBucket['tauLow-tau']).toBe(15);
    const smallEntry = validity([...make('x', 40, 0), ...make('y', 9, 1)], 0.9, 0.8);
    expect(smallEntry.shareOk).toBe(true);
    expect(smallEntry.entriesBelowMin).toEqual(['y']);
    expect(smallEntry.valid).toBe(false);
    const lowShare = validity([...make('x', 10, 30), ...make('y', 10, 30)], 0.9, 0.8);
    expect(lowShare.lowShare).toBe(0.25);
    expect(lowShare.valid).toBe(false);
  });
});
