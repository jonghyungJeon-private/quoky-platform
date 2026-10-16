import { describe, expect, it } from 'vitest';
import { armsFor, budgetFor, buildSchedule, expectedCalls } from './arms';

describe('ADR-0123 D6 arms and schedule', () => {
  const arms = armsFor(['m1', 'm2']);

  it('adds A1 once per embedding model', () => {
    expect(arms.map((arm) => arm.id)).toEqual(['A0', 'A0-swap', 'A1@m1', 'A1@m2', 'A2']);
  });

  it('interleaves every arm for every case, in rotation, and gives every arm the same order', () => {
    const caseIds = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const schedule = buildSchedule({ caseIds, arms, runs: 2, sessions: 3, seed: 's' });
    expect(schedule).toHaveLength(24);
    for (const unit of schedule) expect([...unit.arms].sort()).toEqual(arms.map((arm) => arm.id).sort());
    expect(new Set(schedule.map((unit) => unit.arms[0])).size).toBe(arms.length);
    expect(new Set(schedule.map((unit) => unit.session))).toEqual(new Set([1, 2, 3]));
    for (const run of [1, 2]) expect(schedule.filter((unit) => unit.run === run).map((unit) => unit.caseId).sort()).toEqual([...caseIds].sort());
    expect(buildSchedule({ caseIds, arms, runs: 2, sessions: 3, seed: 's' })).toEqual(schedule);
  });

  it('counts calls as the ADR does and sizes the budget with a small reserve', () => {
    const calls = expectedCalls(993, 425, 4, 5);
    expect(calls).toEqual({ heldOut: 19860, devSmoke: 850, total: 20710 });
    expect(budgetFor(calls.total)).toBeGreaterThanOrEqual(21500);
    expect(budgetFor(calls.total)).toBeLessThan(21600);
  });
});
