import { describe, expect, it } from 'vitest';
import {
  OWNER_TURN_RATE_FACTOR,
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
    for (let i = 0; i < 20; i += 1) expect(budgets.admit('jira', 'background').verdict.ok).toBe(true);
    expect(budgets.admit('jira', 'background').verdict).toEqual({ ok: false, reason: 'rate-minute' });
    // Another label is independent.
    expect(budgets.admit('slack', 'background').verdict.ok).toBe(true);
    c.advance(60_001);
    expect(budgets.admit('jira', 'background').verdict.ok).toBe(true);
  });

  it('an owner turn is never refused on its delivery channels and typing; background typing stays capped', () => {
    const budgets = new EgressBudgets(clock().now);
    for (const label of ['telegram', 'discord', 'telegram-typing', 'discord-typing', 'google-calendar']) {
      for (let i = 0; i < 200; i += 1) expect(budgets.admit(label, 'owner-turn').verdict.ok, label).toBe(true);
    }
    // The owner's traffic is counted: background traffic of the same label is over the cap.
    expect(budgets.admit('telegram', 'background').verdict).toEqual({ ok: false, reason: 'rate-minute' });
    expect(budgets.admit('telegram-typing', 'background').verdict).toEqual({ ok: false, reason: 'rate-minute' });
  });

  it('on the other connectors an owner turn gets 3x the cap, not no cap', () => {
    const c = clock();
    const budgets = new EgressBudgets(c.now);
    expect(OWNER_TURN_RATE_FACTOR).toBe(3);
    for (const [label, perMinute] of [['jira', 20], ['slack', 20], ['google-drive', 20], ['gmail', 20], ['github', 20], ['slack-search', 10]] as const) {
      for (let i = 0; i < perMinute * 3; i += 1) expect(budgets.admit(label, 'owner-turn').verdict.ok, label).toBe(true);
      expect(budgets.admit(label, 'owner-turn').verdict, label).toEqual({ ok: false, reason: 'rate-minute' });
      expect(budgets.admit(label, 'background').verdict, label).toEqual({ ok: false, reason: 'rate-minute' });
    }
    // The hourly cap scales too: 900 Jira requests in an hour, spread under the minute cap.
    const hourly = new EgressBudgets(c.now);
    for (let i = 0; i < 900; i += 1) {
      expect(hourly.admit('jira', 'owner-turn').verdict.ok).toBe(true);
      c.advance(3_000);
    }
    expect(hourly.admit('jira', 'owner-turn').verdict).toEqual({ ok: false, reason: 'rate-hour' });
  });

  it('§5.1 worst case: a reminder catch-up (40 sends/min, 80 calendar re-check reads/min) is never locked out', () => {
    const c = clock();
    const budgets = new EgressBudgets(c.now);
    // Four 15 s ticks, each with REMINDER_LIMITS.maxDeliveriesPerTick = 10 sends and 20 calendar reads.
    for (let tick = 0; tick < 4; tick += 1) {
      for (let i = 0; i < 20; i += 1) expect(budgets.admit('google-calendar', 'reminder').verdict.ok).toBe(true);
      for (let i = 0; i < 10; i += 1) {
        expect(budgets.admit('telegram', 'reminder').verdict.ok).toBe(true);
        expect(budgets.admit('discord', 'reminder').verdict.ok).toBe(true);
      }
      c.advance(15_000);
    }
    // An owner reply and an approval ack in the same minute still go out.
    expect(budgets.admit('telegram', 'owner-turn').verdict.ok).toBe(true);
    expect(budgets.admit('discord', 'owner-turn').verdict.ok).toBe(true);
    // Background sends on those channels (ops notices) stay capped at 30/min.
    expect(budgets.admit('telegram', 'background').verdict).toEqual({ ok: false, reason: 'rate-minute' });
  });

  it('enforce does not count refused attempts, so retries cannot keep the window full; observe counts what it sends', () => {
    const c = clock();
    const enforce = new EgressBudgets(c.now);
    for (let i = 0; i < 20; i += 1) enforce.admit('slack', 'background', { countRefused: false });
    c.advance(30_000);
    for (let i = 0; i < 50; i += 1) {
      expect(enforce.admit('slack', 'background', { countRefused: false }).verdict.ok).toBe(false);
    }
    c.advance(30_001);
    expect(enforce.admit('slack', 'background', { countRefused: false }).verdict.ok).toBe(true);

    const d = clock();
    const observe = new EgressBudgets(d.now);
    for (let i = 0; i < 20; i += 1) observe.admit('slack', 'background');
    d.advance(30_000);
    for (let i = 0; i < 50; i += 1) observe.admit('slack', 'background');
    d.advance(30_001);
    // The over-cap requests observe let through are really sent, so they are still in the window.
    expect(observe.admit('slack', 'background').verdict.ok).toBe(false);
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
