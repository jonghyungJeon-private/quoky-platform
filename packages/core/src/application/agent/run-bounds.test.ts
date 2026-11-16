import { describe, expect, it } from 'vitest';
import { AGENT_RUN_BOUNDS, AgentRunBudget } from './run-bounds';
import { AGENT_RUN_MAX_CONNECTOR_CALLS, AGENT_PLAN_MAX_RUN_REF_VALUES, AGENT_PLAN_MAX_READS, AGENT_PLAN_MAX_SUMMARIES } from './plan-validator';
import { AGENT_PLAN_MAX_STEPS } from './plan-schema';

// ADR-0121 D7 (+ D2, D3 and the D7 interpretation note of 2026-10-23): the run bounds, exactly as ratified, with the owner's
// 2026-11-16 D3/D7 amendment (split M2 calls count; M2 6, model calls 8, input 120k bytes, wall 60 s; everything else unchanged).

function clockOf(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('AGENT_RUN_BOUNDS (ratified values)', () => {
  it('is 6 steps, 1 re-plan, 10 connector queries, 50 HTTP requests, 8 model calls, 6 M2 calls, 60 s, 120k tokens, 10 ref values', () => {
    expect(AGENT_RUN_BOUNDS).toEqual({
      maxSteps: 6,
      maxReplans: 1,
      maxConnectorQueries: 10,
      maxHttpRequests: 50,
      maxModelCalls: 8,
      maxM2Calls: 6,
      wallMs: 60_000,
      maxInputTokens: 120_000,
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

  it('connector queries: 10 are granted, the 11th is refused before it is made', () => {
    const budget = new AgentRunBudget(clockOf().now);
    for (let i = 0; i < 10; i += 1) expect(budget.reserveQuery()).toBe(true);
    expect(budget.breach).toBeUndefined();
    expect(budget.reserveQuery()).toBe(false);
    expect(budget.breach).toBe('connector-queries');
    expect(budget.snapshot().connectorQueries).toBe(10);
    expect(budget.mayReadConnector()).toBe(false);
  });

  it('http requests: 50 are granted, the 51st is refused before it is sent', () => {
    const budget = new AgentRunBudget(clockOf().now);
    for (let i = 0; i < 50; i += 1) expect(budget.reserveHttp()).toBe(true);
    expect(budget.breach).toBeUndefined();
    expect(budget.reserveHttp()).toBe(false);
    expect(budget.reserveHttp()).toBe(false);
    expect(budget.breach).toBe('http-requests');
    expect(budget.snapshot().httpRequests).toBe(50);
  });

  it('model calls: 8, with at most 1 re-plan and 6 M2 calls', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveModelCall('planner')).toBe(true);
    expect(budget.reserveModelCall('replan')).toBe(true);
    for (let i = 0; i < 6; i += 1) expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.breach).toBeUndefined();
    expect(budget.reserveModelCall('planner')).toBe(false);
    expect(budget.breach).toBe('model-calls');
    expect(budget.snapshot()).toMatchObject({ modelCalls: 8, replans: 1, m2Calls: 6 });
  });

  it('the model-call cap binds M2 too: planner + re-plan + 6 M2 is the 8th; a lower model cap stops M2 first', () => {
    const budget = new AgentRunBudget(clockOf().now, { maxModelCalls: 4 });
    expect(budget.reserveModelCall('planner')).toBe(true);
    for (let i = 0; i < 3; i += 1) expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.reserveModelCall('m2')).toBe(false);
    expect(budget.breach).toBe('model-calls');
  });

  it('remainingM2Calls is the smaller of the M2 and model calls left, and 0 after any breach', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.remainingM2Calls()).toBe(6);
    expect(budget.reserveModelCall('planner')).toBe(true);
    expect(budget.reserveModelCall('replan')).toBe(true);
    expect(budget.remainingM2Calls()).toBe(6);
    expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.remainingM2Calls()).toBe(5);
    const tight = new AgentRunBudget(clockOf().now, { maxModelCalls: 3 });
    expect(tight.reserveModelCall('planner')).toBe(true);
    expect(tight.remainingM2Calls()).toBe(2);
    expect(tight.reserveInputTokens(AGENT_RUN_BOUNDS.maxInputTokens + 1)).toBe(false);
    expect(tight.remainingM2Calls()).toBe(0);
  });

  it('re-plan: the second re-plan is refused', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveModelCall('replan')).toBe(true);
    expect(budget.reserveModelCall('replan')).toBe(false);
    expect(budget.breach).toBe('replans');
  });

  it('M2 calls: the 7th is refused even with model calls left', () => {
    const budget = new AgentRunBudget(clockOf().now);
    for (let i = 0; i < 6; i += 1) expect(budget.reserveModelCall('m2')).toBe(true);
    expect(budget.reserveModelCall('m2')).toBe(false);
    expect(budget.breach).toBe('m2-calls');
    expect(budget.snapshot().modelCalls).toBe(6);
  });

  it('input tokens: 120,000 are allowed, one more is a breach', () => {
    const budget = new AgentRunBudget(clockOf().now);
    expect(budget.reserveInputTokens(120_000)).toBe(true);
    expect(budget.reserveInputTokens(1)).toBe(false);
    expect(budget.breach).toBe('input-tokens');
  });

  it('wall time: 60 s; at the wall the run may start nothing', () => {
    const clock = clockOf();
    const budget = new AgentRunBudget(clock.now);
    clock.advance(59_999);
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
});
