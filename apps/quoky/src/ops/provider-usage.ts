import { localDateOf, readRunUsage, zonedToUtc } from '@quoky/core';
import type { IsoTimestamp, TaskRunRepository } from '@quoky/core';

/**
 * ADR-0115 D8 (PRV-3): the provider usage ledger, READ side. There is no ledger table and no migration: each finished
 * run already carries its normalised usage in `TaskRun.metadata.usage` (core `runUsageRecord`), and the monthly totals
 * are computed here by reading those runs back through the additive read-only `listWithUsageFinishedBetween` query.
 *
 * Boundaries are calendar months in `QUOKY_TIMEZONE`. Totals are counts only (tokens and runs per selection label);
 * a run whose provider reported no count is counted as `unknownRuns` and adds nothing to any token sum (never
 * estimated). This module holds a read-only view of one repository method: it has no way to touch a provider
 * selection, a provider registration or its ranking.
 */

export type MonthKey = string; // `YYYY-MM`

export interface LabelUsage {
  readonly label: string;
  readonly runs: number;
  /** Runs whose provider reported no token count. */
  readonly unknownRuns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Sum of the per-run totals (provider total, else input + output); unknown runs add nothing. */
  readonly totalTokens: number;
}

export interface MonthlyUsage {
  readonly month: MonthKey;
  /** Labels in descending total tokens, then label order. */
  readonly labels: readonly LabelUsage[];
  readonly totalTokens: number;
  readonly runs: number;
}

/** The only repository seam the ledger reads. */
export type ProviderUsageSource = Pick<TaskRunRepository, 'listWithUsageFinishedBetween'>;

export function monthKeyOf(instant: IsoTimestamp | number, timeZone: string): MonthKey {
  const { year, month } = localDateOf(instant, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function previousMonthKey(key: MonthKey): MonthKey {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return month === 1 ? `${String(year - 1).padStart(4, '0')}-12` : `${String(year).padStart(4, '0')}-${String(month - 1).padStart(2, '0')}`;
}

function nextMonthKey(key: MonthKey): MonthKey {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return month === 12 ? `${String(year + 1).padStart(4, '0')}-01` : `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
}

/** The first instant of `key` in `timeZone` (local midnight of day 1). */
export function monthStartIso(key: MonthKey, timeZone: string): IsoTimestamp {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return new Date(zonedToUtc({ year, month, day: 1, hour: 0, minute: 0 }, timeZone).epochMs).toISOString();
}

export class ProviderUsageLedger {
  constructor(
    private readonly source: ProviderUsageSource,
    private readonly timeZone: string,
  ) {}

  monthOf(instant: IsoTimestamp | number): MonthKey {
    return monthKeyOf(instant, this.timeZone);
  }

  async monthly(month: MonthKey): Promise<MonthlyUsage> {
    const runs = await this.source.listWithUsageFinishedBetween(
      monthStartIso(month, this.timeZone),
      monthStartIso(nextMonthKey(month), this.timeZone),
    );
    const byLabel = new Map<string, { -readonly [K in keyof LabelUsage]: LabelUsage[K] }>();
    for (const run of runs) {
      const usage = readRunUsage(run.metadata);
      if (usage === undefined) continue;
      let row = byLabel.get(usage.label);
      if (row === undefined) {
        row = { label: usage.label, runs: 0, unknownRuns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
        byLabel.set(usage.label, row);
      }
      row.runs += 1;
      if (!usage.reported) row.unknownRuns += 1;
      row.inputTokens += usage.inputTokens ?? 0;
      row.cachedInputTokens += usage.cachedInputTokens ?? 0;
      row.outputTokens += usage.outputTokens ?? 0;
      row.reasoningTokens += usage.reasoningTokens ?? 0;
      row.totalTokens += usage.totalTokens ?? 0;
    }
    const labels = [...byLabel.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label));
    return {
      month,
      labels,
      totalTokens: labels.reduce((sum, l) => sum + l.totalTokens, 0),
      runs: labels.reduce((sum, l) => sum + l.runs, 0),
    };
  }
}

const NUMBER = new Intl.NumberFormat('en-US');
export function formatTokens(value: number): string {
  return NUMBER.format(value);
}
