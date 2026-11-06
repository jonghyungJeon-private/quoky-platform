import { describe, expect, it } from 'vitest';
import { RecallActivityGauge } from './recall-activity';

describe('RecallActivityGauge', () => {
  it('is busy while any of several overlapping turns is open, then for the grace period after the last ends', () => {
    let now = 0;
    const gauge = new RecallActivityGauge(() => now);
    expect(gauge.isBusy(2_000)).toBe(false);
    const a = gauge.begin(3_000);
    now = 500;
    const b = gauge.begin(3_000);
    gauge.end(a);
    now = 1_000;
    expect(gauge.isBusy(0)).toBe(true);
    gauge.end(b);
    expect(gauge.isBusy(0)).toBe(false);
    expect(gauge.isBusy(2_000)).toBe(true);
    now = 3_001;
    expect(gauge.isBusy(2_000)).toBe(false);
  });

  it('a turn that never ends stops counting after its own budget and then only keeps the grace', () => {
    let now = 0;
    const gauge = new RecallActivityGauge(() => now);
    gauge.begin(3_000);
    now = 2_999;
    expect(gauge.isBusy(0)).toBe(true);
    now = 3_500;
    expect(gauge.isBusy(2_000)).toBe(true); // within the grace of its expiry
    now = 5_001;
    expect(gauge.isBusy(2_000)).toBe(false);
  });

  it('ending a token twice, or an unknown token, changes nothing', () => {
    let now = 0;
    const gauge = new RecallActivityGauge(() => now);
    const token = gauge.begin(10_000);
    gauge.end(token);
    now = 100;
    gauge.end(token);
    gauge.end(999);
    now = 200;
    // the grace counts from the first end (t=0); the repeated end at t=100 did not move it
    expect(gauge.isBusy(250)).toBe(true);
    expect(gauge.isBusy(150)).toBe(false);
  });
});
