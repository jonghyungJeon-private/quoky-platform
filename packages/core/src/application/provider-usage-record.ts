import type { RunUsageRecord } from '../domain';
import type { AiUsage } from '../ports';

/**
 * ADR-0115 D8 (PRV-3): normalising the per-run `Usage` value object (`TaskRun.usage`, ADR-0010; the type lives in the
 * domain). Stored in the run's existing JSON `data`: no schema change, no migration. Counts are non-negative safe
 * integers; anything else is dropped, never estimated.
 */
const COUNT_KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function countsOf(source: Readonly<Record<string, unknown>>): Partial<Record<(typeof COUNT_KEYS)[number], number>> {
  const counts: Partial<Record<(typeof COUNT_KEYS)[number], number>> = {};
  for (const key of COUNT_KEYS) {
    const value = countOf(source[key]);
    if (value !== undefined) counts[key] = value;
  }
  return counts;
}

/**
 * The record to store for a finished run, or undefined when the provider supplied no usage object or no usable label
 * (nothing is recorded: the run has no `usage`).
 */
export function runUsageRecord(usage: AiUsage | undefined): RunUsageRecord | undefined {
  if (usage === undefined || typeof usage.label !== 'string' || !LABEL.test(usage.label)) return undefined;
  const counts = countsOf(usage as unknown as Record<string, unknown>);
  if (counts.totalTokens === undefined && counts.inputTokens !== undefined && counts.outputTokens !== undefined) {
    counts.totalTokens = counts.inputTokens + counts.outputTokens;
  }
  return { label: usage.label, reported: Object.keys(counts).length > 0, ...counts };
}

/** Read a stored `TaskRun.usage` value back (defensive: anything malformed reads as absent, a bad count is dropped). */
export function readRunUsage(raw: unknown): RunUsageRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.label !== 'string' || !LABEL.test(record.label)) return undefined;
  const counts = countsOf(record);
  return { label: record.label, reported: Object.keys(counts).length > 0, ...counts };
}
