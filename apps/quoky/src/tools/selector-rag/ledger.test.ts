import { describe, expect, it } from 'vitest';
import { BudgetExceededError, RateGate, TrafficLedger } from './ledger';

describe('ADR-0123 D6 traffic ledger', () => {
  it('counts calls and refuses to go over the budget without counting the refused call', () => {
    const ledger = new TrafficLedger(3);
    ledger.reserve();
    ledger.reserve(2);
    expect(ledger.calls).toBe(3);
    expect(ledger.remaining).toBe(0);
    expect(() => ledger.reserve()).toThrow(BudgetExceededError);
    expect(ledger.calls).toBe(3);
  });

  it('rejects an invalid budget', () => {
    expect(() => new TrafficLedger(-1)).toThrow();
    expect(() => new TrafficLedger(1.5)).toThrow();
  });
});

describe('ADR-0123 D6 rate gate', () => {
  it('cannot be configured above the cap (4 concurrent, 1 call/s)', () => {
    expect(() => new RateGate({ maxConcurrent: 5 })).toThrow();
    expect(() => new RateGate({ minIntervalMs: 500 })).toThrow();
  });

  it('starts calls at least one interval apart and never more than 4 in flight', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const gate = new RateGate({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const starts: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    for (let i = 0; i < 6; i += 1) {
      const pending = gate.acquire().then((release) => {
        starts.push(clock);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        releases.push(() => {
          inFlight -= 1;
          release();
        });
      });
      if (i < 4) await pending;
    }
    expect(starts).toEqual([0, 1000, 2000, 3000]);
    expect(peak).toBe(4);
    // the 5th and 6th wait for a release
    await Promise.resolve();
    expect(starts.length).toBe(4);
    releases[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(starts.length).toBe(5);
    expect(starts[4]).toBeGreaterThanOrEqual(4000);
    releases[1]?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(starts.length).toBe(6);
    expect(starts[5]! - starts[4]!).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(1000);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
