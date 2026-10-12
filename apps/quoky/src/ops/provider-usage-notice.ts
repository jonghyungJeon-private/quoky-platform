import { now as sharedClock } from '@quoky/core';
import type { IsoTimestamp, Logger } from '@quoky/core';
import type { BackupJobTimers } from './backup-job';
import { formatTokens, previousMonthKey } from './provider-usage';
import type { MonthKey, MonthlyUsage, ProviderUsageLedger } from './provider-usage';
import type { OpsNoticeLedgerStore } from './ops-notice';

/**
 * ADR-0115 D8 (PRV-3): the two owner notices of the usage ledger, each at most once per calendar month (`QUOKY_TIMEZONE`).
 *
 * - `MONTHLY`: once, the PREVIOUS month's totals per selection label. Nothing is sent when that month has no usage.
 * - `THRESHOLD`: once in a month, when the month's total tokens (all labels together) first reach
 *   `QUOKY_PROVIDER_USAGE_MONTHLY_THRESHOLD` (units: TOTAL TOKENS per calendar month). Unset = never.
 *
 * Both go through the owner-only OPS notice path (`deliver`, the primary platform's DM) and carry token totals and run
 * counts only. "Already sent" is recorded in a private JSON file beside the ops notice ledger and only after the
 * delivery outcome is `SENT` (an undelivered notice never suppresses the next attempt). The job reads usage and sends
 * a notice; it has no handle on provider selection and never switches, disables or re-ranks a provider.
 */

export type UsageNoticeKind = 'PROVIDER_USAGE_MONTHLY' | 'PROVIDER_USAGE_THRESHOLD';
export type UsageNoticeOutcome = 'SENT' | 'FAILED' | 'UNCERTAIN' | 'NO_OWNER' | 'NOT_SENT';

/** Delivers one fixed-shape owner notice; resolves with the delivery outcome (never rejects). */
export type UsageNoticeDeliver = (kind: UsageNoticeKind, text: string) => Promise<UsageNoticeOutcome | string>;

export interface UsageNoticeState {
  /** The month whose totals the monthly DM already reported (`YYYY-MM`). */
  readonly monthlyReportedFor?: MonthKey;
  /** The month in which the threshold DM was already sent. */
  readonly thresholdSentIn?: MonthKey;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseUsageNoticeState(content: string | undefined): UsageNoticeState {
  if (content === undefined) return {};
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return {};
    return {
      ...(typeof parsed.monthlyReportedFor === 'string' && MONTH.test(parsed.monthlyReportedFor) ? { monthlyReportedFor: parsed.monthlyReportedFor } : {}),
      ...(typeof parsed.thresholdSentIn === 'string' && MONTH.test(parsed.thresholdSentIn) ? { thresholdSentIn: parsed.thresholdSentIn } : {}),
    };
  } catch {
    return {};
  }
}

function labelLines(usage: MonthlyUsage): string {
  return usage.labels
    .map((l) => {
      const unknown = l.unknownRuns > 0 ? `, 토큰 미보고 ${l.unknownRuns}회` : '';
      return `- ${l.label}: ${l.runs}회, 입력 ${formatTokens(l.inputTokens)} · 출력 ${formatTokens(l.outputTokens)} · 합계 ${formatTokens(l.totalTokens)} 토큰${unknown}`;
    })
    .join('\n');
}

const FOOTER = '토큰 수만 보여드려요. 공급자는 자동으로 바꾸지 않아요. 자세한 내용은 운영 화면에서 확인해 주세요.';

export function monthlyUsageNoticeText(usage: MonthlyUsage): string {
  return (
    `[Quoky 사용량 알림] ${usage.month} 공급자별 사용량이에요. 합계 ${formatTokens(usage.totalTokens)} 토큰 (${usage.runs}회).\n` +
    `${labelLines(usage)}\n${FOOTER}`
  );
}

export function thresholdUsageNoticeText(usage: MonthlyUsage, threshold: number): string {
  return (
    `[Quoky 사용량 알림] ${usage.month} 사용량이 설정한 월 기준(${formatTokens(threshold)} 토큰)에 도달했어요. ` +
    `지금까지 합계 ${formatTokens(usage.totalTokens)} 토큰 (${usage.runs}회).\n${labelLines(usage)}\n${FOOTER}`
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

  private readState(): UsageNoticeState {
    try {
      return parseUsageNoticeState(this.deps.state ? this.deps.state.read() : this.memory);
    } catch {
      return parseUsageNoticeState(this.memory);
    }
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
    const state = this.readState();

    const previous = previousMonthKey(month);
    if (state.monthlyReportedFor !== previous) {
      const usage = await this.deps.ledger.monthly(previous);
      // Nothing is sent (and nothing is recorded) for a month without usage.
      if (usage.runs > 0 && (await this.send('PROVIDER_USAGE_MONTHLY', monthlyUsageNoticeText(usage)))) {
        this.writeState({ ...this.readState(), monthlyReportedFor: previous });
      }
    }

    const threshold = this.deps.monthlyThreshold;
    if (threshold !== undefined && this.readState().thresholdSentIn !== month) {
      const usage = await this.deps.ledger.monthly(month);
      if (usage.totalTokens >= threshold && (await this.send('PROVIDER_USAGE_THRESHOLD', thresholdUsageNoticeText(usage, threshold)))) {
        this.writeState({ ...this.readState(), thresholdSentIn: month });
      }
    }
  }

  /** True only when the delivery outcome is `SENT`. */
  private async send(kind: UsageNoticeKind, text: string): Promise<boolean> {
    let outcome: string;
    try {
      outcome = await this.deps.deliver(kind, text);
    } catch {
      outcome = 'UNCERTAIN';
    }
    this.deps.logger.info('provider_usage.notice', { kind, outcome });
    return outcome === 'SENT';
  }
}
