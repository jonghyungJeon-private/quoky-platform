import { describe, expect, it } from 'vitest';
import { entryFloors, majorityCorrect, mcnemar, pairedBootstrap, seededRandom } from './stats';

describe('ADR-0123 D6 statistics', () => {
  it('the seeded generator is reproducible', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('paired bootstrap: a clear reduction has a CI below zero and is reproducible', () => {
    // 200 cases, 5 runs: arm X errs on 10 cases (once each), arm Y on 40 cases (once each)
    const x = Array.from({ length: 200 }, (_, i) => (i < 10 ? 1 : 0));
    const y = Array.from({ length: 200 }, (_, i) => (i < 40 ? 1 : 0));
    const result = pairedBootstrap(x, y, 5, 42, 2000);
    expect(result.rateX).toBeCloseTo(10 / 1000, 10);
    expect(result.rateY).toBeCloseTo(40 / 1000, 10);
    expect(result.diff).toBeCloseTo(-0.03, 10);
    expect(result.ci95[1]).toBeLessThan(0);
    expect(result.excludesZero).toBe(true);
    expect(pairedBootstrap(x, y, 5, 42, 2000)).toEqual(result);
  });

  it('paired bootstrap: identical arms straddle zero', () => {
    const x = Array.from({ length: 100 }, (_, i) => (i % 7 === 0 ? 1 : 0));
    const result = pairedBootstrap(x, x, 5, 1, 1000);
    expect(result.diff).toBe(0);
    expect(result.ci95).toEqual([0, 0]);
    expect(result.excludesZero).toBe(false);
  });

  it('paired bootstrap rejects unpaired input', () => {
    expect(() => pairedBootstrap([1], [1, 2], 5, 1)).toThrow();
    expect(() => pairedBootstrap([], [], 5, 1)).toThrow();
  });

  it('majority correctness needs more than half of the runs', () => {
    expect(majorityCorrect(2, 5)).toBe(true);
    expect(majorityCorrect(3, 5)).toBe(false);
    expect(majorityCorrect(1, 2)).toBe(false);
  });

  it('McNemar counts discordant pairs and gives the exact binomial p', () => {
    // X correct / Y wrong on 8 cases, X wrong / Y correct on 2, 10 concordant
    const x = [...Array(8).fill(0), ...Array(2).fill(5), ...Array(10).fill(0)];
    const y = [...Array(8).fill(5), ...Array(2).fill(0), ...Array(10).fill(0)];
    const result = mcnemar(x, y, 5);
    expect(result).toMatchObject({ b: 8, c: 2, concordant: 10 });
    expect(result.pExact).toBeCloseTo(0.109375, 6);
    expect(mcnemar([0, 0], [0, 0], 5).pExact).toBe(1);
  });

  it('floors: the per-entry minimum across runs and the minimum of those', () => {
    const { perEntry, floor } = entryFloors({ 'jira.issues': [0.97, 0.94, 0.96], 'todo.add': [0.92, 0.95, 0.9], none: [] });
    expect(perEntry).toEqual({ 'jira.issues': 0.94, 'todo.add': 0.9 });
    expect(floor).toBe(0.9);
  });
});
