/**
 * ADR-0124 phase 2 P2-3: the pure CH8 validation (newer-first, verdict rule boundaries, fidelity, per-category metrics).
 */
import { describe, expect, it } from 'vitest';
import { rankIds, type BlendRow } from './blend-sweep';
import { VERDICT_RULE, buildBlendValidation, isNewerFirst, validationCandidates, verdictOf, type CandidateValidation, type ValidationQuery } from './blend-validation';

describe('newer-first', () => {
  it('counts gold above stale, stale absent with gold present, and not gold absent', () => {
    expect(isNewerFirst(['g', 'x', 's'], ['g'], 's')).toBe(true);
    expect(isNewerFirst(['s', 'g'], ['g'], 's')).toBe(false);
    expect(isNewerFirst(['x', 'g'], ['g'], 's')).toBe(true);
    expect(isNewerFirst(['x', 's'], ['g'], 's')).toBe(false);
    expect(isNewerFirst([], ['g'], 's')).toBe(false);
  });
});

const mk = (id: string, language: string, overall: number, ko: number, newer: number): CandidateValidation => ({
  id,
  label: id,
  overall: { n: 100, recallAt5: overall, mrrAt10: 0 },
  byLanguage: { ko: { n: 50, recallAt5: ko, mrrAt10: 0 } },
  byCategory: {},
  newerFirst: { n: 20, newerFirst: Math.round(newer * 20), rate: newer },
});

describe('verdict rule boundaries (pre-declared)', () => {
  it('B2 confirmed exactly at the thresholds, and one step below each threshold falls through', () => {
    const b1 = mk('B1', 'x', 0.9, 0.8, 0.5);
    expect(verdictOf([b1, mk('B2', 'x', 0.95, 0.9, 0.4)])).toBe('B2 confirmed');
    expect(verdictOf([b1, mk('B2', 'x', 0.9499, 0.9, 0.4)])).toBe('no change recommended');
    expect(verdictOf([b1, mk('B2', 'x', 0.95, 0.8999, 0.4)])).toBe('no change recommended');
    expect(verdictOf([b1, mk('B2', 'x', 0.95, 0.9, 0.3999)])).toBe('no change recommended');
    expect(verdictOf([b1, mk('B2', 'x', 1, 1, 0.9)])).toBe('B2 confirmed');
  });

  it('falls back to B1 recommended at its own boundaries, else no change', () => {
    const lowB2 = mk('B2', 'x', 0.5, 0.5, 0.5);
    expect(verdictOf([mk('B1', 'x', 0.93, 0.85, 0), lowB2])).toBe('B1 recommended');
    expect(verdictOf([mk('B1', 'x', 0.9299, 0.85, 0), lowB2])).toBe('no change recommended');
    expect(verdictOf([mk('B1', 'x', 0.93, 0.8499, 0), lowB2])).toBe('no change recommended');
    // B2 failing only the newer-first clause while B1 is good enough: B1 recommended
    expect(verdictOf([mk('B1', 'x', 0.96, 0.92, 0.9), mk('B2', 'x', 0.97, 0.95, 0.7)])).toBe('B1 recommended');
  });

  it('the thresholds are the declared numbers', () => {
    expect(VERDICT_RULE.b2Confirmed).toEqual({ overallRecallAt5: 0.95, koRecallAt5: 0.9, newerFirstMargin: 0.1 });
    expect(VERDICT_RULE.b1Recommended).toEqual({ overallRecallAt5: 0.93, koRecallAt5: 0.85 });
    expect(validationCandidates().map((c) => c.id)).toEqual(['B0', 'B1', 'B2']);
  });
});

// two memories, same topic: stale (old, high lexical+semantic), gold (new, slightly lower semantic): recency decides under B0 (0.25), not under B1 (production 0.10) or B2
const rows = (): BlendRow[] => [
  { id: 'stale', contentKey: 'a', updatedAt: '2026-05-01T00:00:00.000Z', lexical: 1, recency: 0.02, semantic: 0.8 },
  { id: 'gold', contentKey: 'b', updatedAt: '2026-11-05T00:00:00.000Z', lexical: 0.5, recency: 0.98, semantic: 0.75 },
];
const queryOf = (overrides: Partial<ValidationQuery> = {}): ValidationQuery => {
  const production = validationCandidates()[1];
  return { language: 'ko', gold: ['gold'], actual: rankIds(rows(), production as never, 10), rows: rows(), category: 'recency-wins', staleId: 'stale', ...overrides };
};

const PRODUCTION = { semanticWeight: 0.7, recencyWeight: 0.1 };

describe('buildBlendValidation', () => {
  it('reports per language, per category, newer-first, floor percentiles and the verdict; fidelity holds when the production-matching candidate (B1) matches the actual ids', () => {
    const plain = queryOf({ category: 'shared', staleId: null });
    const validation = buildBlendValidation([queryOf(), plain], ['ko', 'en'], ['recency-wins', 'shared'], PRODUCTION);
    expect(validation.invalid).toBeNull();
    expect(validation.fidelity).toEqual({ queries: 2, mismatches: 0 });
    expect(validation.results.map((r) => r.id)).toEqual(['B0', 'B1', 'B2']);
    const b0 = validation.results[0] as CandidateValidation;
    expect(b0.overall.n).toBe(2);
    expect(b0.byLanguage.en?.n).toBe(0);
    expect(b0.byCategory['recency-wins']?.n).toBe(1);
    expect(b0.byCategory.shared?.n).toBe(1);
    expect(b0.newerFirst.n).toBe(1);
    expect(validation.floor.goldSemantic?.n).toBe(2);
    expect(validation.verdict).not.toBeNull();
  });

  it('recency flips newer-first between B0 and B2 on a stale-lexical topic', () => {
    const validation = buildBlendValidation([queryOf()], ['ko'], ['recency-wins'], PRODUCTION);
    const [b0, , b2] = validation.results as [CandidateValidation, CandidateValidation, CandidateValidation];
    expect(b0.newerFirst.rate).toBe(1);
    expect(b2.newerFirst.rate).toBe(0);
  });

  it('a fidelity mismatch marks the validation INVALID and gives no verdict', () => {
    const validation = buildBlendValidation([queryOf({ actual: ['gold', 'stale'] })], ['ko'], ['recency-wins'], PRODUCTION);
    expect(validation.invalid?.reason).toMatch(/fidelity/u);
    expect(validation.verdict).toBeNull();
  });
});

describe('buildBlendValidation production match', () => {
  it('is INVALID with a clear reason when no frozen candidate equals the production weights', () => {
    const validation = buildBlendValidation([queryOf()], ['ko'], ['recency-wins'], { semanticWeight: 0.7, recencyWeight: 0.11 });
    expect(validation.invalid?.reason).toContain('no frozen linear candidate equals the production weights');
    expect(validation.verdict).toBeNull();
  });
});
