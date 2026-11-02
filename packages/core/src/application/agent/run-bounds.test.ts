import { describe, expect, it } from 'vitest';
import { AGENT_RUN_BOUNDS, AgentRunBudget } from './run-bounds';
import { AGENT_RUN_MAX_CONNECTOR_CALLS, AGENT_PLAN_MAX_RUN_REF_VALUES, AGENT_PLAN_MAX_READS, AGENT_PLAN_MAX_SUMMARIES } from './plan-validator';
import { AGENT_PLAN_MAX_STEPS } from './plan-schema';

// ADR-0121 D7 (+ D2, D3 and the D7 interpretation note of 2026-10-23): the run bounds, exactly as ratified.

function clockOf(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('AGENT_RUN_BOUNDS (ratified values)', () => {
  it('is 6 steps, 1 re-plan, 10 connector queries, 50 HTTP requests, 5 model calls, 3 M2 calls, 45 s, 40k tokens, 10 ref values', () => {
    expect(AGENT_RUN_BOUNDS).toEqual({
      maxSteps: 6,
      maxReplans: 1,
      maxConnectorQueries: 10,
      maxHttpRequests: 50,
      maxModelCalls: 5,
      maxM2Calls: 3,
      wallMs: 45_000,
      maxInputTokens: 40_000,
      maxRefValues: 10,
    });
  });

  it('agrees with the validator and schema constants it shares', () => {
    expect(AGENT_PLAN_MAX_STEPS).toBe(AGENT_RUN_BOUNDS.maxSteps);
    expect(AGENT_RUN_MAX_CONNECTOR_CALLS).toBe(AGENT_RUN_BOUNDS.maxConnectorQueries);
    expect(AGENT_PLAN_MAX_RUN_REF_VALUES).toBe(AGENT_RUN_BOUNDS.maxRefValues);
    expect(AGENT_PLAN_MAX_READS + AGENT_PLAN_MAX_SUMMARIES).toBeGreaterThanOrEqual(AGENT_RUN_BOUNDS.maxSteps);
  });
});

describe('AgentRunBudget: every bound, and its breach', () => {
  it('steps: the 7th step is refused and the breach is "steps"', () => {
    const budget = new AgentRunBudget(clockOf().now);
    for (let i = 0; i < 6; i += 1) expect(budget.reserveStep()).toBe(true);
    expect(budget.breach).toBeUndefined();
    expect(budget.reserveStep()).toBe(false);
    expect(budget.breach).toBe('steps');
  });

  it('connector queries: 10 are allowed, going over is a breach, and nothing more starts', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.mayReadConnector()).toBe(true);
    expect(budget.recordConnector(10, 10)).toBe(true);
    expect(budget.breach).toBeUndefined();
    expect(budget.mayReadConnector()).toBe(false);
    expect(budget.breach).toBe('connector-queries');
    const over = new AgentRunBudget(clockOf().now);
    expect(over.recordConnector(11, 11)).toBe(false);
    expect(over.breach).toBe('connector-queries');
  });

  it('http requests: 50 are allowed, the 51st is a breach', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.recordConnector(1, 50)).toBe(true);
    expect(budget.mayReadConnector()).toBe(false);
    expect(budget.breach).toBe('http-requests');
    const over = new AgentRunBudget(clockOf().now);
    expect(over.recordConnector(1, 51)).toBe(false);
    expect(over.breach).toBe('http-requests');
  });

  it('model calls: 5, with at most 1 re-plan and 3 M2 calls', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveModelCall('planner')).toBe(true);
    expect(budget.reserveModelCall('replan')).toBe(true);
    expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.breach).toBeUndefined();
    expect(budget.reserveModelCall('m2')).toBe(false);
    expect(budget.breach).toBe('model-calls');
    expect(budget.snapshot()).toMatchObject({ modelCalls: 5, replans: 1, m2Calls: 3 });
  });

  it('re-plan: the second re-plan is refused', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveModelCall('replan')).toBe(true);
    expect(budget.reserveModelCall('replan')).toBe(false);
    expect(budget.breach).toBe('replans');
  });

  it('M2 calls: the 4th is refused even with model calls left', () => {
    const budget = new AgentRunBudget(clockOf().now);
    for (let i = 0; i < 3; i += 1) expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.reserveModelCall('m2')).toBe(false);
    expect(budget.breach).toBe('m2-calls');
    expect(budget.snapshot().modelCalls).toBe(3);
  });

  it('input tokens: 40,000 are allowed, one more is a breach', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveInputTokens(40_000)).toBe(true);
    expect(budget.reserveInputTokens(1)).toBe(false);
    expect(budget.breach).toBe('input-tokens');
  });

  it('wall time: 45 s; at the wall the run may start nothing', () => {
    const clock = clockOf();
    const budget = new AgentRunBudget(clock.now);
    clock.advance(44_999);
    expect(budget.reserveStep()).toBe(true);
    expect(budget.remainingMs()).toBe(1);
    clock.advance(1);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.reserveStep()).toBe(false);
    expect(budget.breach).toBe('wall-time');
  });

  it('ref values: 10 per run; the 11th value is refused, and a step takes all of its values or none', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveRefValues(10)).toBe(true);
    expect(budget.reserveRefValues(1)).toBe(false);
    expect(budget.breach).toBe('ref-values');
    const split = new AgentRunBudget(clockOf().now);
    expect(split.reserveRefValues(6)).toBe(true);
    expect(split.reserveRefValues(5)).toBe(false);
    expect(split.snapshot().refValues).toBe(6);
  });

  it('the first breach is sticky: a later breach does not replace it and later reservations fail', () => {
    const budget = new AgentRunBudget(clockOf().now);
    budget.markBreach('http-requests');
    budget.markBreach('steps');
    expect(budget.breach).toBe('http-requests');
    expect(budget.reserveStep()).toBe(false);
    expect(budget.reserveModelCall('planner')).toBe(false);
    expect(budget.reserveRefValues(1)).toBe(false);
  });

  it('ignores a negative, NaN or fractional usage report', () => {
    const budget = new AgentRunBudget(clockOf().now);
    budget.recordConnector(-5, Number.NaN);
    budget.recordConnector(1.9, 2.9);
    expect(budget.snapshot()).toMatchObject({ connectorQueries: 1, httpRequests: 2 });
  });
});
