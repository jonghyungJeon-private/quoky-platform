import { REMINDER_LIMITS, firstFit, messageContent, now as sharedClock, plainTextOf } from '@quoky/core';
import type { IsoTimestamp, Logger, NotificationSinkOutcome } from '@quoky/core';
import type { BackupJobTimers } from './backup-job';
import { formatTokenField, formatTokens, previousMonthKey } from './provider-usage';
import type { LabelUsage, MonthKey, MonthlyUsage, ProviderUsageLedger } from './provider-usage';
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
 * and `NO_OWNER` are tried again at the next evaluation, and only when that outcome was explicitly recorded.
 *
 * Each attempt is recorded **in flight** in a private JSON file beside the ops notice ledger before the send, and the
 * outcome write clears it. As with an ADR-0101 reminder that a restart finds mid-delivery, an attempt still in flight
 * on load (sent, maybe sent, or never handed over, with no recorded outcome) is taken as `UNCERTAIN`: that kind is
 * done for the month and never resent (at most once over at least once). If the in-flight record cannot be written,
 * nothing is sent (fail closed, like the ADR-0102 D7 ledger). Each kind also has at most
 * {@link USAGE_NOTICE_MAX_ATTEMPTS} attempts per month, as a second bound. The job reads usage and sends a notice; it
 * has no handle on provider selection and never switches, disables or re-orders a provider.
 */

export type UsageNoticeKind = 'PROVIDER_USAGE_MONTHLY' | 'PROVIDER_USAGE_THRESHOLD';

/** The sink's outcome, or `NO_OWNER` when no owner is configured (nothing was handed to the sink). */
export type UsageNoticeDelivery = NotificationSinkOutcome | { readonly status: 'NO_OWNER' };

/** Delivers one fixed-shape owner notice; resolves with the delivery outcome (never rejects). */
export type UsageNoticeDeliver = (kind: UsageNoticeKind, text: string) => Promise<UsageNoticeDelivery>;

/** Delivery attempts per kind per calendar month (retryable `NOT_SENT` and `NO_OWNER` only reach the second and third). */
export const USAGE_NOTICE_MAX_ATTEMPTS = 3;

/** The recorded outcome of the last finished attempt (absent while one is in flight). */
export type UsageNoticeRecordedOutcome = 'SENT' | 'UNCERTAIN' | 'NOT_SENT' | 'NO_OWNER';

export interface UsageNoticeAttempts {
  readonly month: MonthKey;
  readonly count: number;
  /** Set before the send, cleared by the outcome write; still set on load = taken as `UNCERTAIN`. */
  readonly inFlight?: true;
  readonly outcome?: UsageNoticeRecordedOutcome;
  /** For `NOT_SENT` only: the sink's `retryable` flag. */
  readonly retryable?: boolean;
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

const RECORDED: ReadonlySet<string> = new Set<UsageNoticeRecordedOutcome>(['SENT', 'UNCERTAIN', 'NOT_SENT', 'NO_OWNER']);

function attemptsOf(value: unknown): UsageNoticeAttempts | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { month, count, inFlight, outcome, retryable } = value as Record<string, unknown>;
  if (typeof month !== 'string' || !MONTH.test(month) || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
    return undefined;
  }
  return {
    month,
    count,
    ...(inFlight === true ? { inFlight: true as const } : {}),
    ...(typeof outcome === 'string' && RECORDED.has(outcome) ? { outcome: outcome as UsageNoticeRecordedOutcome } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  };
}

/** Whether the recorded attempts allow another one: only after an explicitly recorded retryable outcome. */
function mayRetry(attempts: UsageNoticeAttempts): boolean {
  if (attempts.inFlight === true) return false;
  return attempts.outcome === 'NO_OWNER' || (attempts.outcome === 'NOT_SENT' && attempts.retryable === true);
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

function labelLine(l: LabelUsage): string {
  return (
    `- ${l.label}: ${l.runs}회, 입력 ${formatTokenField(l.inputTokens, l.runs)} · 출력 ${formatTokenField(l.outputTokens, l.runs)} · ` +
    `합계 ${formatTokenField(l.totalTokens, l.runs, ' 토큰')}`
  );
}

const FOOTER = '토큰 수는 공급자가 알려준 것만 더하고, 알려주지 않은 값은 "미보고"로 표시해요. 공급자는 자동으로 바꾸지 않아요. 자세한 내용은 운영 화면에서 확인해 주세요.';

/**
 * The notice inside one delivered message (`REMINDER_LIMITS.maxDeliveredTextChars`, code points), as the daily brief
 * does it: every label when that fits, else the top labels by total tokens (the ledger's order) and `- 외 K개` for the
 * rest. The last candidate (no label line at all) is the header, one "외" line and the footer, which always fits.
 */
function boundedNotice(header: string, usage: MonthlyUsage): string {
  const lines = usage.labels.map(labelLine);
  const candidates: string[] = [];
  for (let shown = lines.length; shown >= 0; shown -= 1) {
    const hidden = lines.length - shown;
    candidates.push([header, ...lines.slice(0, shown), ...(hidden > 0 ? [`- 외 ${hidden}개`] : []), FOOTER].join('\n'));
  }
  return plainTextOf(messageContent(firstFit(candidates, REMINDER_LIMITS.maxDeliveredTextChars, 'code-points')));
}

export function monthlyUsageNoticeText(usage: MonthlyUsage): string {
  return boundedNotice(
    `[Quoky 사용량 알림] ${usage.month} 공급자별 사용량이에요. ${usage.runs}회 실행, 합계 ${formatTokenField(usage.totalTokens, usage.runs, ' 토큰')}.`,
    usage,
  );
}

export function thresholdUsageNoticeText(usage: MonthlyUsage, threshold: number): string {
  return boundedNotice(
    `[Quoky 사용량 알림] ${usage.month} 사용량이 설정한 월 기준(${formatTokens(threshold)} 토큰)에 도달했어요. ` +
      `지금까지 ${usage.runs}회 실행, 합계 ${formatTokenField(usage.totalTokens, usage.runs, ' 토큰')}.`,
    usage,
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
    const previous = state[keys.attempts]?.month === month ? state[keys.attempts] : undefined;
    if (previous !== undefined && (!mayRetry(previous) || previous.count >= USAGE_NOTICE_MAX_ATTEMPTS)) {
      // An attempt left in flight by a restart is UNCERTAIN (ADR-0101: never resent); a used-up budget is given up.
      const interrupted = previous.inFlight === true;
      const closed: UsageNoticeAttempts = interrupted ? { month, count: previous.count, outcome: 'UNCERTAIN' } : previous;
      this.writeState({ ...state, [keys.settled]: month, [keys.attempts]: closed });
      this.deps.logger.warn('provider_usage.notice', { kind, outcome: interrupted ? 'UNCERTAIN_INTERRUPTED' : 'GAVE_UP', attempt: previous.count });
      return;
    }
    const attempt = (previous?.count ?? 0) + 1;
    if (!this.recordAttempt({ ...state, [keys.attempts]: { month, count: attempt, inFlight: true } })) return;

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
    // One write records the outcome (clearing in-flight) and, unless a retry is allowed, settles the month. If it fails,
    // memory still holds it for this process and the file keeps the in-flight record, which a restart reads as UNCERTAIN.
    const recorded: UsageNoticeAttempts = {
      month,
      count: attempt,
      outcome: outcome.status,
      ...(outcome.status === 'NOT_SENT' ? { retryable: outcome.retryable } : {}),
    };
    this.writeState({ ...this.readState(), [keys.attempts]: recorded, ...(retry ? {} : { [keys.settled]: month }) });
  }
}
