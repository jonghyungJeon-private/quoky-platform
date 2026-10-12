import { localDateOf, readRunUsage, zonedToUtc } from '@quoky/core';
import type { IsoTimestamp, RunUsageRecord, TaskRunRepository } from '@quoky/core';

/**
 * ADR-0115 D8 (PRV-3): the provider usage ledger, READ side. There is no ledger table and no migration: each finished
 * run already carries its normalised `Usage` value object in `TaskRun.usage` (core `runUsageRecord`), and the monthly totals
 * are computed here by reading those runs back through the additive read-only `listWithUsageFinishedBetween` query.
 *
 * Boundaries are calendar months in `QUOKY_TIMEZONE`. Totals are counts only (tokens and runs per selection label).
 * Every count is tracked per field as the sum of what was reported plus how many runs reported it: a field no run
 * reported renders as "미보고", never 0, and a partly reported field says how many runs it covers. A run whose total
 * cannot be known (no provider total, and not both input and output) is an `unknownRuns` run. Nothing is estimated.
 * This module holds a read-only view of one repository method: it has no way to touch a provider selection, a
 * provider registration or its order.
 */

export type MonthKey = string; // `YYYY-MM`

/** One count field: the sum of the reported values and how many runs reported it (0 = nobody reported it). */
export interface TokenField {
  readonly sum: number;
  readonly reportedRuns: number;
}

export interface LabelUsage {
  readonly label: string;
  readonly runs: number;
  /** Runs whose total cannot be known (no provider total, and not both input and output reported). */
  readonly unknownRuns: number;
  readonly inputTokens: TokenField;
  readonly cachedInputTokens: TokenField;
  readonly outputTokens: TokenField;
  readonly reasoningTokens: TokenField;
  /** Per-run totals (provider total, else input + output); a run with an unknown total adds nothing. */
  readonly totalTokens: TokenField;
}

export interface MonthlyUsage {
  readonly month: MonthKey;
  /** Labels in descending known total tokens, then label order. */
  readonly labels: readonly LabelUsage[];
  readonly totalTokens: TokenField;
  readonly runs: number;
  readonly unknownRuns: number;
}

const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const;

type MutableField = { sum: number; reportedRuns: number };
type MutableLabel = { label: string; runs: number; unknownRuns: number } & Record<(typeof FIELDS)[number] | 'totalTokens', MutableField>;

const field = (): MutableField => ({ sum: 0, reportedRuns: 0 });

function addTo(target: MutableField, value: number | undefined): void {
  if (value === undefined) return;
  target.sum += value;
  target.reportedRuns += 1;
}

/** The run's total when it can be known: the provider's total, else input + output when both were reported. */
function knownTotal(usage: RunUsageRecord): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  return usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined;
}

/** Folds run usage records into per-label totals one record at a time (memory grows with labels, not runs). */
export class UsageFold {
  private readonly byLabel = new Map<string, MutableLabel>();

  add(usage: RunUsageRecord): void {
    let row = this.byLabel.get(usage.label);
    if (row === undefined) {
      row = {
        label: usage.label,
        runs: 0,
        unknownRuns: 0,
        inputTokens: field(),
        cachedInputTokens: field(),
        outputTokens: field(),
        reasoningTokens: field(),
        totalTokens: field(),
      };
      this.byLabel.set(usage.label, row);
    }
    row.runs += 1;
    for (const key of FIELDS) addTo(row[key], usage[key]);
    const total = knownTotal(usage);
    if (total === undefined) row.unknownRuns += 1;
    addTo(row.totalTokens, total);
  }

  result(month: MonthKey): MonthlyUsage {
    const labels = [...this.byLabel.values()].sort((a, b) => b.totalTokens.sum - a.totalTokens.sum || a.label.localeCompare(b.label));
    return {
      month,
      labels,
      totalTokens: {
        sum: labels.reduce((sum, l) => sum + l.totalTokens.sum, 0),
        reportedRuns: labels.reduce((sum, l) => sum + l.totalTokens.reportedRuns, 0),
      },
      runs: labels.reduce((sum, l) => sum + l.runs, 0),
      unknownRuns: labels.reduce((sum, l) => sum + l.unknownRuns, 0),
    };
  }
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
    const fold = new UsageFold();
    for (const run of runs) {
      const usage = readRunUsage(run.usage);
      if (usage !== undefined) fold.add(usage);
    }
    return fold.result(month);
  }
}

const NUMBER = new Intl.NumberFormat('en-US');
export function formatTokens(value: number): string {
  return NUMBER.format(value);
}

/** What a count no run reported reads as (never 0). */
export const NOT_REPORTED = '미보고';

/**
 * One count for the owner: "미보고" when no run reported it; the formatted sum (with `unit`) when every run did; and,
 * when only some did, the sum with how many of the runs it covers, e.g. `1,000 토큰 (2/3회 보고)`.
 */
export function formatTokenField(value: TokenField, runs: number, unit = ''): string {
  if (value.reportedRuns === 0) return NOT_REPORTED;
  const text = `${formatTokens(value.sum)}${unit}`;
  return value.reportedRuns < runs ? `${text} (${value.reportedRuns}/${runs}회 보고)` : text;
}
