import { describe, expect, it } from 'vitest';
import {
  BREAKER_BASE_MS,
  BREAKER_MAX_MS,
  EGRESS_BUDGETS,
  EgressBudgets,
  GLOBAL_BUDGET,
  LABEL_BYTES_PER_HOUR,
  parseRetryAfterSeconds,
} from './egress-budget';

function clock(start = Date.parse('2026-10-13T00:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('per-label budgets (design §5.3)', () => {
  it('uses the design numbers', () => {
    expect(EGRESS_BUDGETS.telegram).toMatchObject({ perMinute: 30 });
    expect(EGRESS_BUDGETS.discord).toMatchObject({ perMinute: 30 });
    expect(EGRESS_BUDGETS['google-calendar']).toMatchObject({ perMinute: 20, perHour: 300, breaker: true });
    expect(EGRESS_BUDGETS.jira).toMatchObject({ perMinute: 20, perHour: 300, breaker: true });
    expect(EGRESS_BUDGETS['slack-search']).toMatchObject({ perMinute: 10, perHour: 300 });
    expect(EGRESS_BUDGETS['discord-attachments']).toMatchObject({ perHour: 20, bytesDownPerDay: 100_000_000 });
    expect(GLOBAL_BUDGET).toMatchObject({ bytesDownPerDay: 200_000_000, bytesUpPerDay: 20_000_000, alertRatio: 0.8 });
    for (const [label, budget] of Object.entries(EGRESS_BUDGETS)) {
      expect(budget.bytesPerHour, label).toBeGreaterThanOrEqual(LABEL_BYTES_PER_HOUR);
    }
  });

  it('refuses the 21st request in a minute for a connector, and frees the window after it slides', () => {
    const c = clock();
    const budgets = new EgressBudgets(c.now);
    for (let i = 0; i < 20; i += 1) expect(budgets.admit('jira', 'owner-turn').verdict.ok).toBe(true);
    expect(budgets.admit('jira', 'owner-turn').verdict).toEqual({ ok: false, reason: 'rate-minute' });
    // Another label is independent.
    expect(budgets.admit('slack', 'owner-turn').verdict.ok).toBe(true);
    c.advance(60_001);
    expect(budgets.admit('jira', 'owner-turn').verdict.ok).toBe(true);
  });

  it('enforces the hourly request cap and the hourly byte cap', () => {
    const c = clock();
    const budgets = new EgressBudgets(c.now, { x: { perHour: 3 }, y: { bytesPerHour: 1000 } });
    for (let i = 0; i < 3; i += 1) {
      budgets.admit('x', 'reminder');
      c.advance(1000);
    }
    expect(budgets.admit('x', 'reminder').verdict).toEqual({ ok: false, reason: 'rate-hour' });
    budgets.admit('y', 'reminder').ticket.addBytes(400, 700);
    expect(budgets.admit('y', 'reminder').verdict).toEqual({ ok: false, reason: 'volume-hour' });
    c.advance(3_600_001);
    expect(budgets.admit('y', 'reminder').verdict.ok).toBe(true);
  });

  it('the global daily volume refuses background traffic but never an owner turn, and alerts once at 80%', () => {
    const c = clock();
    const budgets = new EgressBudgets(c.now, { big: {} });
    budgets.admit('big', 'owner-turn').ticket.addBytes(0, 0.8 * GLOBAL_BUDGET.bytesDownPerDay);
    expect(budgets.recordOutcome('big', 200)).toEqual([{ kind: 'volume-alert', direction: 'down' }]);
    expect(budgets.recordOutcome('big', 200)).toEqual([]);
    budgets.admit('big', 'owner-turn').ticket.addBytes(0, 0.2 * GLOBAL_BUDGET.bytesDownPerDay);
    expect(budgets.admit('big', 'background').verdict).toEqual({ ok: false, reason: 'global-volume-down' });
    expect(budgets.admit('big', 'owner-turn').verdict.ok).toBe(true);
  });
});

describe('backoff on 429 / 5xx (circuit breaker, exponential)', () => {
  it('opens after 3 consecutive failures for 5 min, doubles on re-open, caps at 60 min, and resets on success', () => {
    const c = clock();
    const budgets = new EgressBudgets(c.now);
    expect(budgets.recordOutcome('github', 503)).toEqual([]);
    expect(budgets.recordOutcome('github', 429)).toEqual([]);
    expect(budgets.recordOutcome('github', 500)).toEqual([{ kind: 'backoff-open', label: 'github', openMs: BREAKER_BASE_MS }]);
    expect(budgets.admit('github', 'owner-turn').verdict).toEqual({ ok: false, reason: 'backoff' });
    c.advance(BREAKER_BASE_MS + 1);
    expect(budgets.admit('github', 'owner-turn').verdict.ok).toBe(true);
    // Still failing: the next opening doubles.
    budgets.recordOutcome('github', 502);
    budgets.recordOutcome('github', 502);
    expect(budgets.recordOutcome('github', 502)).toEqual([{ kind: 'backoff-open', label: 'github', openMs: 2 * BREAKER_BASE_MS }]);
    for (let i = 0; i < 6; i += 1) {
      c.advance(BREAKER_MAX_MS + 1);
      budgets.recordOutcome('github', 500);
      budgets.recordOutcome('github', 500);
      budgets.recordOutcome('github', 500);
    }
    c.advance(BREAKER_MAX_MS + 1);
    budgets.recordOutcome('github', 500);
    budgets.recordOutcome('github', 500);
    expect(budgets.recordOutcome('github', 500)).toEqual([{ kind: 'backoff-open', label: 'github', openMs: BREAKER_MAX_MS }]);
    // A success closes it and resets the exponent.
    c.advance(BREAKER_MAX_MS + 1);
    budgets.recordOutcome('github', 200);
    budgets.recordOutcome('github', 500);
    budgets.recordOutcome('github', 500);
    expect(budgets.recordOutcome('github', 500)).toEqual([{ kind: 'backoff-open', label: 'github', openMs: BREAKER_BASE_MS }]);
  });

  it('honours a longer Retry-After up to the cap', () => {
    const budgets = new EgressBudgets(clock().now);
    budgets.recordOutcome('slack', 429);
    budgets.recordOutcome('slack', 429);
    expect(budgets.recordOutcome('slack', 429, 900)).toEqual([{ kind: 'backoff-open', label: 'slack', openMs: 900_000 }]);
    expect(parseRetryAfterSeconds(' 120 ')).toBe(120);
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
  });

  it('a 4xx other than 429 neither opens nor resets the breaker; labels with their own backoff are untouched', () => {
    const budgets = new EgressBudgets(clock().now);
    budgets.recordOutcome('jira', 500);
    budgets.recordOutcome('jira', 404);
    budgets.recordOutcome('jira', 500);
    expect(budgets.recordOutcome('jira', 500)).toEqual([{ kind: 'backoff-open', label: 'jira', openMs: BREAKER_BASE_MS }]);
    for (let i = 0; i < 5; i += 1) expect(budgets.recordOutcome('telegram', 500)).toEqual([]);
    expect(budgets.admit('telegram', 'owner-turn').verdict.ok).toBe(true);
  });
});
