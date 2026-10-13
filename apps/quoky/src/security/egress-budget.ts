import type { TrafficInitiator } from '../correlation-context';

/**
 * Per-destination budgets and backoff (ADR-0121 D8, design §5.3, MSIT ②-4 "per-account/token limits: calls, period,
 * results, download volume").
 *
 * Each budget label (see `egress-policy.ts` `labelFor`) has request caps per minute and per hour and a byte cap per
 * hour (up + down, wire bytes); some labels add a daily download cap. The whole process has a daily download and upload
 * budget with an 80% alert. Counting uses exact sliding windows over the requests admitted in the last 24 h (a stricter
 * equivalent of the design's token buckets: a burst can never exceed the cap inside any window). On the owner's
 * delivery channels (`telegram`, `discord` and their typing labels) and the calendar re-check reads (`google-calendar`)
 * the request-rate caps never refuse an owner turn (its replies, approvals and acks); sends and calendar reads of a
 * reminder tick are exempt there too. On every other connector an owner turn gets {@link OWNER_TURN_RATE_FACTOR} × the
 * cap instead of no cap, so work started inside a turn stays bounded. A request enforce refuses is not counted.
 *
 * Backoff: for the connector and API labels that had no retry policy of their own (Google, Atlassian, Slack, GitHub,
 * OpenAI, Gemini) a circuit breaker opens after 3 consecutive 429 or 5xx answers, for 5 minutes, doubling on each
 * re-open without an intervening success, capped at 60 minutes; a `Retry-After` longer than that is honoured up to the
 * cap. Telegram (1 → 60 s backoff) and Discord (discord.js rate-limit handling) keep their own.
 *
 * What a breach does is the guard's decision: `observe` logs it and lets the request go; `enforce` refuses it with a
 * deterministic error. This module only counts and answers.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MB = 1_000_000;

export interface LabelBudget {
  readonly perMinute?: number;
  readonly perHour?: number;
  /** Up + down wire bytes per rolling hour. */
  readonly bytesPerHour?: number;
  /** Download bytes per rolling day (attachments). */
  readonly bytesDownPerDay?: number;
  /** Whether 429/5xx answers open the circuit breaker for this label. */
  readonly breaker?: boolean;
  /**
   * Initiators the REQUEST-RATE caps (`perMinute`, `perHour`) do not apply to; they are still counted and recorded.
   * Default: none. Only the owner's delivery channels and `google-calendar` list any (see the table).
   */
  readonly rateExempt?: readonly TrafficInitiator[];
}

/**
 * On a label where an owner turn is NOT rate-exempt, its request-rate caps are this many times the label's caps (e.g.
 * Jira 60/min and 900/h instead of 20/min and 300/h). The window counts every initiator's requests.
 */
export const OWNER_TURN_RATE_FACTOR = 3;
/**
 * The owner's delivery channels and the reminder re-check reads: owner turns AND reminder ticks are exempt, so replies,
 * approvals, acks and a reminder catch-up (design §5.1 worst case: 10 sends and 20 calendar reads per 15 s tick, ≤ 40
 * sends/min) are never locked out. Their volume is bounded upstream (the owner's own messages,
 * `REMINDER_LIMITS.maxDeliveriesPerTick`).
 */
const OWNER_DELIVERY_EXEMPT: readonly TrafficInitiator[] = ['owner-turn', 'reminder'];
/** Typing indicators: an owner turn is exempt, background typing keeps the cap. */
const OWNER_TURN_EXEMPT: readonly TrafficInitiator[] = ['owner-turn'];

/**
 * Per-hour byte budget for every connector and platform label. The design gives the all-egress daily budget (200 MB
 * down, 20 MB up); a single destination may use at most a quarter of the daily download budget in one hour.
 */
export const LABEL_BYTES_PER_HOUR = 50 * MB;

const CONNECTOR: LabelBudget = { perMinute: 20, perHour: 300, bytesPerHour: LABEL_BYTES_PER_HOUR, breaker: true };

/** Design §5.3, per label. A label missing here (including `unlisted`) gets {@link DEFAULT_BUDGET}. */
export const EGRESS_BUDGETS: Readonly<Record<string, LabelBudget>> = Object.freeze({
  // Telegram: one open poll (≈72/h idle at 50 s); sends ≤ 30/min outside owner turns and reminders; typing has its own
  // label, capped outside owner turns; attachments ≤ 20 files/h, ≤ 100 MB/day (an owner turn: 3×).
  'telegram-poll': { perMinute: 60, bytesPerHour: LABEL_BYTES_PER_HOUR },
  telegram: { perMinute: 30, bytesPerHour: LABEL_BYTES_PER_HOUR, rateExempt: OWNER_DELIVERY_EXEMPT },
  'telegram-typing': { perMinute: 30, bytesPerHour: LABEL_BYTES_PER_HOUR, rateExempt: OWNER_TURN_EXEMPT },
  'telegram-file': { perHour: 20, bytesPerHour: LABEL_BYTES_PER_HOUR, bytesDownPerDay: 100 * MB },
  // Discord: REST ≤ 30/min outside owner turns and reminders (discord.js handles 429); typing and attachments as Telegram.
  discord: { perMinute: 30, bytesPerHour: LABEL_BYTES_PER_HOUR, rateExempt: OWNER_DELIVERY_EXEMPT },
  'discord-typing': { perMinute: 20, bytesPerHour: LABEL_BYTES_PER_HOUR, rateExempt: OWNER_TURN_EXEMPT },
  'discord-attachments': { perHour: 20, bytesPerHour: LABEL_BYTES_PER_HOUR, bytesDownPerDay: 100 * MB },
  // Google APIs (each): ≤ 20/min, ≤ 300/h (an owner turn: ≤ 60/min, ≤ 900/h); breaker on 429/5xx. Calendar reads of an
  // owner turn or a reminder tick are exempt (above).
  google: CONNECTOR,
  'google-calendar': { ...CONNECTOR, rateExempt: OWNER_DELIVERY_EXEMPT },
  'google-drive': CONNECTOR,
  // DRV-2b: at most two reads per spreadsheet summary (the sheet list, one values read).
  'google-sheets': CONNECTOR,
  gmail: CONNECTOR,
  'google-oauth': CONNECTOR,
  // Atlassian, Slack, GitHub (each): ≤ 20/min, ≤ 300/h; Slack search ≤ 10/min (an owner turn: 3× each).
  jira: CONNECTOR,
  confluence: CONNECTOR,
  slack: CONNECTOR,
  'slack-search': { ...CONNECTOR, perMinute: 10 },
  github: CONNECTOR,
  // Opt-in HTTP API providers (ADR-0115): the connector caps.
  openai: CONNECTOR,
  gemini: CONNECTOR,
  // The local Ollama daemon: no network egress, volume only.
  'ollama-local': { bytesPerHour: 10 * LABEL_BYTES_PER_HOUR },
});

/** A destination the inventory does not know gets the strictest connector caps. */
export const DEFAULT_BUDGET: LabelBudget = { perMinute: 20, perHour: 300, bytesPerHour: LABEL_BYTES_PER_HOUR };

/** All egress (design §5.3): ≤ 200 MB/day down, ≤ 20 MB/day up; an alert at 80%. */
export const GLOBAL_BUDGET = Object.freeze({ bytesDownPerDay: 200 * MB, bytesUpPerDay: 20 * MB, alertRatio: 0.8 });

export const BREAKER_THRESHOLD = 3;
export const BREAKER_BASE_MS = 5 * MINUTE_MS;
export const BREAKER_MAX_MS = HOUR_MS;

export type BudgetRefusal =
  | 'rate-minute'
  | 'rate-hour'
  | 'volume-hour'
  | 'volume-day'
  | 'global-volume-down'
  | 'global-volume-up'
  | 'backoff';

export type BudgetVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: BudgetRefusal };

/** Events the budgets report to the guard (each content-free). */
export type BudgetEvent =
  | { readonly kind: 'backoff-open'; readonly label: string; readonly openMs: number }
  | { readonly kind: 'volume-alert'; readonly direction: 'down' | 'up' };

interface Sample {
  readonly at: number;
  up: number;
  down: number;
}

interface BreakerState {
  consecutiveFailures: number;
  opens: number;
  openUntil: number;
}

/** Handle of one admitted request: its bytes are added when known. */
export interface BudgetTicket {
  addBytes(up: number, down: number): void;
}

export class EgressBudgets {
  private readonly samples = new Map<string, Sample[]>();
  private readonly global: Sample[] = [];
  private readonly breakers = new Map<string, BreakerState>();
  private alertedDay: { down?: number; up?: number } = {};

  constructor(
    private readonly nowMs: () => number,
    private readonly table: Readonly<Record<string, LabelBudget>> = EGRESS_BUDGETS,
  ) {}

  budgetOf(label: string): LabelBudget {
    return this.table[label] ?? DEFAULT_BUDGET;
  }

  /**
   * Checks the caps for one more request of `label` and counts it when it goes out. A refused request is counted only
   * with `countRefused` (observe: the request is really sent); in enforce it is not, so retries of a refused request
   * can never keep a window full. Request-rate caps skip the label's `rateExempt` initiators; volume caps and the
   * backoff apply to everyone, except that owner turns are never refused for the GLOBAL volume (design §5.3: "refuse
   * non-owner-initiated calls").
   */
  admit(
    label: string,
    initiator: TrafficInitiator,
    options: { readonly countRefused: boolean } = { countRefused: true },
  ): { verdict: BudgetVerdict; ticket: BudgetTicket } {
    const now = this.nowMs();
    const verdict = this.check(label, initiator, now);
    if (!verdict.ok && !options.countRefused) return { verdict, ticket: { addBytes: () => undefined } };
    const sample: Sample = { at: now, up: 0, down: 0 };
    this.samplesOf(label).push(sample);
    this.global.push(sample);
    return {
      verdict,
      ticket: {
        addBytes: (up, down) => {
          sample.up += Math.max(0, up);
          sample.down += Math.max(0, down);
        },
      },
    };
  }

  private check(label: string, initiator: TrafficInitiator, now: number): BudgetVerdict {
    const budget = this.budgetOf(label);
    const breaker = this.breakers.get(label);
    if (breaker !== undefined && breaker.openUntil > now) return { ok: false, reason: 'backoff' };
    const samples = this.prune(this.samplesOf(label), now);
    const rateApplies = !(budget.rateExempt ?? []).includes(initiator);
    const factor = initiator === 'owner-turn' ? OWNER_TURN_RATE_FACTOR : 1;
    if (rateApplies && budget.perMinute !== undefined && count(samples, now - MINUTE_MS) >= budget.perMinute * factor) {
      return { ok: false, reason: 'rate-minute' };
    }
    if (rateApplies && budget.perHour !== undefined && count(samples, now - HOUR_MS) >= budget.perHour * factor) {
      return { ok: false, reason: 'rate-hour' };
    }
    if (budget.bytesPerHour !== undefined && bytes(samples, now - HOUR_MS, 'both') >= budget.bytesPerHour) {
      return { ok: false, reason: 'volume-hour' };
    }
    if (budget.bytesDownPerDay !== undefined && bytes(samples, now - DAY_MS, 'down') >= budget.bytesDownPerDay) {
      return { ok: false, reason: 'volume-day' };
    }
    if (initiator !== 'owner-turn') {
      const global = this.prune(this.global, now);
      if (bytes(global, now - DAY_MS, 'down') >= GLOBAL_BUDGET.bytesDownPerDay) return { ok: false, reason: 'global-volume-down' };
      if (bytes(global, now - DAY_MS, 'up') >= GLOBAL_BUDGET.bytesUpPerDay) return { ok: false, reason: 'global-volume-up' };
    }
    return { ok: true };
  }

  /**
   * Records an answer for the breaker (labels with `breaker: true` only) and the global 80% alert. `retryAfterSeconds`
   * is the parsed `Retry-After` of a 429/503, if any. Returns the events to report.
   */
  recordOutcome(label: string, status: number | undefined, retryAfterSeconds?: number): BudgetEvent[] {
    const events: BudgetEvent[] = [];
    const now = this.nowMs();
    if (this.budgetOf(label).breaker === true && status !== undefined) {
      const state = this.breakers.get(label) ?? { consecutiveFailures: 0, opens: 0, openUntil: 0 };
      if (status === 429 || status >= 500) {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
          state.opens += 1;
          const backoff = Math.min(BREAKER_MAX_MS, BREAKER_BASE_MS * 2 ** (state.opens - 1));
          const retryAfter = retryAfterSeconds !== undefined ? Math.min(BREAKER_MAX_MS, retryAfterSeconds * 1000) : 0;
          const openMs = Math.max(backoff, retryAfter);
          state.openUntil = now + openMs;
          state.consecutiveFailures = 0;
          events.push({ kind: 'backoff-open', label, openMs });
        }
      } else if (status < 400) {
        state.consecutiveFailures = 0;
        state.opens = 0;
        state.openUntil = 0;
      }
      this.breakers.set(label, state);
    }
    const global = this.prune(this.global, now);
    const day = Math.floor(now / DAY_MS);
    for (const direction of ['down', 'up'] as const) {
      const limit = direction === 'down' ? GLOBAL_BUDGET.bytesDownPerDay : GLOBAL_BUDGET.bytesUpPerDay;
      if (this.alertedDay[direction] !== day && bytes(global, now - DAY_MS, direction) >= limit * GLOBAL_BUDGET.alertRatio) {
        this.alertedDay = { ...this.alertedDay, [direction]: day };
        events.push({ kind: 'volume-alert', direction });
      }
    }
    return events;
  }

  private samplesOf(label: string): Sample[] {
    let samples = this.samples.get(label);
    if (samples === undefined) {
      samples = [];
      this.samples.set(label, samples);
    }
    return samples;
  }

  /** Drops samples older than a day (in place) and returns the array. */
  private prune(samples: Sample[], now: number): Sample[] {
    let drop = 0;
    while (drop < samples.length && (samples[drop]?.at ?? now) <= now - DAY_MS) drop += 1;
    if (drop > 0) samples.splice(0, drop);
    return samples;
  }
}

function count(samples: readonly Sample[], since: number): number {
  let n = 0;
  for (let i = samples.length - 1; i >= 0 && (samples[i]?.at ?? 0) > since; i -= 1) n += 1;
  return n;
}

function bytes(samples: readonly Sample[], since: number, direction: 'up' | 'down' | 'both'): number {
  let total = 0;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const sample = samples[i];
    if (sample === undefined || sample.at <= since) break;
    total += direction === 'up' ? sample.up : direction === 'down' ? sample.down : sample.up + sample.down;
  }
  return total;
}

/** Parses a `Retry-After` header value given in seconds (the HTTP-date form is ignored). */
export function parseRetryAfterSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}
