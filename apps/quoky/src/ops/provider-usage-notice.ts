import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger, NotificationSinkOutcome } from '@quoky/core';
import type { BackupJobTimers } from './backup-job';
import { formatTokenField, formatTokens, previousMonthKey } from './provider-usage';
import type { MonthKey, MonthlyUsage, ProviderUsageLedger } from './provider-usage';
import type { OpsNoticeLedgerStore } from './ops-notice';

/**
 * ADR-0115 D8 (PRV-3): the two owner notices of the usage ledger, each settled at most once per calendar month
 * (`QUOKY_TIMEZONE`).
 *
 * - `MONTHLY`: once, the PREVIOUS month's totals per selection label. Nothing is sent when that month has no usage.
 * - `THRESHOLD`: once in a month, when the month's known total tokens (all labels together) first reach
 *   `QUOKY_PROVIDER_USAGE_MONTHLY_THRESHOLD` (units: TOTAL TOKENS per calendar month). Unset = never.
 *
 * Both go through the owner-only OPS notice path (`deliver`, the primary platform's DM) and carry token totals and run
 * counts only. Delivery follows the sink contract (ADR-0101 D4): `SENT` and `UNCERTAIN` (it may have been delivered)
 * settle the month and are never resent; a non-retryable `NOT_SENT` settles it as given up; only a retryable `NOT_SENT`
 * and `NO_OWNER` are tried again at the next evaluation. Each kind has at most {@link USAGE_NOTICE_MAX_ATTEMPTS}
 * attempts per month, counted in a private JSON file beside the ops notice ledger **before** the send (a crash mid-send
 * still counts), so the bound holds across restarts. If that attempt record cannot be written, nothing is sent (fail
 * closed, like the ADR-0102 D7 ledger). The job reads usage and sends a notice; it has no handle on provider selection
 * and never switches, disables or re-orders a provider.
 */

export type UsageNoticeKind = 'PROVIDER_USAGE_MONTHLY' | 'PROVIDER_USAGE_THRESHOLD';

/** The sink's outcome, or `NO_OWNER` when no owner is configured (nothing was handed to the sink). */
export type UsageNoticeDelivery = NotificationSinkOutcome | { readonly status: 'NO_OWNER' };

/** Delivers one fixed-shape owner notice; resolves with the delivery outcome (never rejects). */
export type UsageNoticeDeliver = (kind: UsageNoticeKind, text: string) => Promise<UsageNoticeDelivery>;

/** Delivery attempts per kind per calendar month (retryable `NOT_SENT` and `NO_OWNER` only reach the second and third). */
export const USAGE_NOTICE_MAX_ATTEMPTS = 3;

export interface UsageNoticeAttempts {
  readonly month: MonthKey;
  readonly count: number;
}

export interface UsageNoticeState {
  /** The month whose monthly DM is settled (`YYYY-MM`): SENT, UNCERTAIN, or given up. */
  readonly monthlyReportedFor?: MonthKey;
  /** Monthly DM attempts made for one month (recorded before each send). */
  readonly monthlyAttempts?: UsageNoticeAttempts;
  /** The month whose threshold DM is settled: SENT, UNCERTAIN, or given up. */
  readonly thresholdSentIn?: MonthKey;
  /** Threshold DM attempts made in one month (recorded before each send). */
  readonly thresholdAttempts?: UsageNoticeAttempts;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function attemptsOf(value: unknown): UsageNoticeAttempts | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { month, count } = value as Record<string, unknown>;
  return typeof month === 'string' && MONTH.test(month) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0
    ? { month, count }
    : undefined;
}

export function parseUsageNoticeState(content: string | undefined): UsageNoticeState {
  if (content === undefined) return {};
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return {};
    const monthlyAttempts = attemptsOf(parsed.monthlyAttempts);
    const thresholdAttempts = attemptsOf(parsed.thresholdAttempts);
    return {
      ...(typeof parsed.monthlyReportedFor === 'string' && MONTH.test(parsed.monthlyReportedFor) ? { monthlyReportedFor: parsed.monthlyReportedFor } : {}),
      ...(monthlyAttempts ? { monthlyAttempts } : {}),
      ...(typeof parsed.thresholdSentIn === 'string' && MONTH.test(parsed.thresholdSentIn) ? { thresholdSentIn: parsed.thresholdSentIn } : {}),
      ...(thresholdAttempts ? { thresholdAttempts } : {}),
    };
  } catch {
    return {};
  }
}

const STATE_KEYS: Readonly<Record<UsageNoticeKind, { readonly settled: 'monthlyReportedFor' | 'thresholdSentIn'; readonly attempts: 'monthlyAttempts' | 'thresholdAttempts' }>> = {
  PROVIDER_USAGE_MONTHLY: { settled: 'monthlyReportedFor', attempts: 'monthlyAttempts' },
  PROVIDER_USAGE_THRESHOLD: { settled: 'thresholdSentIn', attempts: 'thresholdAttempts' },
};

/** Only these outcomes may be tried again (ADR-0101 D4: only `NOT_SENT{retryable: true}` is retried; no owner = nothing sent). */
function isRetryable(outcome: UsageNoticeDelivery): boolean {
  return outcome.status === 'NO_OWNER' || (outcome.status === 'NOT_SENT' && outcome.retryable);
}

function labelLines(usage: MonthlyUsage): string {
  return usage.labels
    .map(
      (l) =>
        `- ${l.label}: ${l.runs}회, 입력 ${formatTokenField(l.inputTokens, l.runs)} · 출력 ${formatTokenField(l.outputTokens, l.runs)} · ` +
        `합계 ${formatTokenField(l.totalTokens, l.runs, ' 토큰')}`,
    )
    .join('\n');
}

const FOOTER = '토큰 수는 공급자가 알려준 것만 더하고, 알려주지 않은 값은 "미보고"로 표시해요. 공급자는 자동으로 바꾸지 않아요. 자세한 내용은 운영 화면에서 확인해 주세요.';

export function monthlyUsageNoticeText(usage: MonthlyUsage): string {
  return (
    `[Quoky 사용량 알림] ${usage.month} 공급자별 사용량이에요. ${usage.runs}회 실행, 합계 ${formatTokenField(usage.totalTokens, usage.runs, ' 토큰')}.\n` +
    `${labelLines(usage)}\n${FOOTER}`
  );
}

export function thresholdUsageNoticeText(usage: MonthlyUsage, threshold: number): string {
  return (
    `[Quoky 사용량 알림] ${usage.month} 사용량이 설정한 월 기준(${formatTokens(threshold)} 토큰)에 도달했어요. ` +
    `지금까지 ${usage.runs}회 실행, 합계 ${formatTokenField(usage.totalTokens, usage.runs, ' 토큰')}.\n${labelLines(usage)}\n${FOOTER}`
  );
}

export interface ProviderUsageNoticeDeps {
  readonly ledger: ProviderUsageLedger;
  readonly deliver: UsageNoticeDeliver;
  /** The "already sent" record (`ops/provider-usage-notices.json`); absent = in memory. */
  readonly state?: OpsNoticeLedgerStore;
  /** Total tokens per calendar month; absent = no threshold notice. */
  readonly monthlyThreshold?: number;
  readonly logger: Logger;
  readonly clock?: () => IsoTimestamp;
  readonly timers?: BackupJobTimers;
  /** Poll period (default 1 hour; a sleeping Mac catches up on waking). */
  readonly pollMs?: number;
}

export const USAGE_NOTICE_POLL_MS = 60 * 60 * 1000;

const nodeTimers: BackupJobTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ProviderUsageNoticeJob {
  private readonly clock: () => IsoTimestamp;
  private readonly timers: BackupJobTimers;
  private memory: string | undefined;
  private running = false;
  private timer: unknown = undefined;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: ProviderUsageNoticeDeps) {
    this.clock = deps.clock ?? sharedClock;
    this.timers = deps.timers ?? nodeTimers;
  }

  /** Check once now (not awaited) and keep polling. Idempotent; never throws. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.checkOnce().then(() => this.arm());
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.inFlight;
    if (pending !== null) await pending.catch(() => undefined);
  }

  private arm(): void {
    if (!this.running || this.timer !== undefined) return;
    const handle = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      void this.checkOnce().then(() => this.arm());
    }, this.deps.pollMs ?? USAGE_NOTICE_POLL_MS);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.timer = handle;
  }

  /**
   * The in-memory copy whenever this process has one (it is always the latest: a failed file write leaves stale
   * content on disk, which must never cause a second notice); the file only before the first write of this process.
   * A file that cannot be read throws, so the evaluation is skipped and logged (fail closed) rather than read as empty.
   */
  private readState(): UsageNoticeState {
    if (this.memory !== undefined || this.deps.state === undefined) return parseUsageNoticeState(this.memory);
    return parseUsageNoticeState(this.deps.state.read());
  }

  private writeState(state: UsageNoticeState): void {
    const content = JSON.stringify({ version: 1, ...state });
    // The in-memory copy always holds the latest, so a failing file never causes a second notice in this process.
    this.memory = content;
    try {
      this.deps.state?.write(content);
    } catch {
      this.deps.logger.warn('provider_usage.notice.state_write_failed');
    }
  }

  /**
   * Record an attempt before sending it. Fail closed: when the record cannot be persisted, the in-memory copy is
   * restored and nothing is sent, so the per-month attempt bound holds across restarts.
   */
  private recordAttempt(state: UsageNoticeState): boolean {
    const previous = this.memory;
    const content = JSON.stringify({ version: 1, ...state });
    this.memory = content;
    try {
      this.deps.state?.write(content);
      return true;
    } catch {
      this.memory = previous;
      this.deps.logger.warn('provider_usage.notice.state_write_failed');
      return false;
    }
  }

  /** One evaluation (single-flight, never rejects). Public for tests. */
  checkOnce(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const work = this.evaluate()
      .catch((error: unknown) => {
        this.deps.logger.warn('provider_usage.notice.failed', { errorName: error instanceof Error ? error.name : typeof error });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }

  private async evaluate(): Promise<void> {
    const month = this.deps.ledger.monthOf(this.clock());

    const previous = previousMonthKey(month);
    if (this.readState().monthlyReportedFor !== previous) {
      const usage = await this.deps.ledger.monthly(previous);
      // Nothing is sent (and nothing is recorded) for a month without usage.
      if (usage.runs > 0) await this.attempt('PROVIDER_USAGE_MONTHLY', previous, monthlyUsageNoticeText(usage));
    }

    const threshold = this.deps.monthlyThreshold;
    if (threshold !== undefined && this.readState().thresholdSentIn !== month) {
      const usage = await this.deps.ledger.monthly(month);
      if (usage.totalTokens.sum >= threshold) await this.attempt('PROVIDER_USAGE_THRESHOLD', month, thresholdUsageNoticeText(usage, threshold));
    }
  }

  /**
   * One bounded delivery attempt of `kind` for `month`: the attempt is counted first, then sent; SENT, UNCERTAIN and a
   * non-retryable NOT_SENT settle the month, and so does a retryable outcome on the last allowed attempt (given up).
   */
  private async attempt(kind: UsageNoticeKind, month: MonthKey, text: string): Promise<void> {
    const keys = STATE_KEYS[kind];
    const state = this.readState();
    if (state[keys.settled] === month) return;
    const made = state[keys.attempts]?.month === month ? (state[keys.attempts]?.count ?? 0) : 0;
    if (made >= USAGE_NOTICE_MAX_ATTEMPTS) {
      // Attempts were used up without a settling write (a crash after the last attempt): give up for the month.
      this.writeState({ ...state, [keys.settled]: month });
      this.deps.logger.warn('provider_usage.notice', { kind, outcome: 'GAVE_UP', attempt: made });
      return;
    }
    const attempt = made + 1;
    if (!this.recordAttempt({ ...state, [keys.attempts]: { month, count: attempt } })) return;

    let outcome: UsageNoticeDelivery;
    try {
      outcome = await this.deps.deliver(kind, text);
    } catch {
      outcome = { status: 'UNCERTAIN', reason: 'UNCLASSIFIED' };
    }
    const retry = isRetryable(outcome) && attempt < USAGE_NOTICE_MAX_ATTEMPTS;
    const fields = {
      kind,
      outcome: outcome.status,
      attempt,
      ...(outcome.status === 'NOT_SENT' || outcome.status === 'UNCERTAIN' ? { reason: outcome.reason } : {}),
      ...(!retry && (outcome.status === 'NOT_SENT' || outcome.status === 'NO_OWNER') ? { gaveUp: true } : {}),
    };
    if (outcome.status === 'SENT') this.deps.logger.info('provider_usage.notice', fields);
    else this.deps.logger.warn('provider_usage.notice', fields);
    if (!retry) this.writeState({ ...this.readState(), [keys.settled]: month });
  }
}
