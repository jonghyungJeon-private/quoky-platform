import type { Metadata } from '../domain';
import type { AiUsage } from '../ports';

/**
 * ADR-0115 D8 (PRV-3): the normalised per-run usage record kept in the EXISTING `TaskRun.metadata.usage` JSON (ADR-0010
 * seam; no schema change, no migration). Counts only: no prompt, reply, key or provider text.
 *
 * - `label` groups the run (`openai:gpt-5`, `claude:sonnet`, `codex`); it is what the provider reported. Core never
 *   branches on it. A provider that reports no usage object leaves the run metadata untouched.
 * - `reported: false` means the provider exposed no count ("unknown"). Counts are never estimated, and an unknown run
 *   adds nothing to a total.
 * - `totalTokens` is the provider's own total, else `inputTokens + outputTokens` when both were reported (arithmetic on
 *   reported counts, not an estimate); otherwise absent.
 */
export const RUN_USAGE_KEY = 'usage';

export interface RunUsageRecord {
  readonly label: string;
  readonly reported: boolean;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

const COUNT_KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The record to store for a finished run, or undefined when the provider supplied no usage object or no usable label
 * (nothing is recorded, so such a run's metadata is exactly what it was before PRV-3).
 */
export function runUsageRecord(usage: AiUsage | undefined): RunUsageRecord | undefined {
  if (usage === undefined || typeof usage.label !== 'string' || !LABEL.test(usage.label)) return undefined;
  const candidate = usage.label;
  const counts: Partial<Record<(typeof COUNT_KEYS)[number], number>> = {};
  for (const key of COUNT_KEYS) {
    const value = countOf(usage?.[key]);
    if (value !== undefined) counts[key] = value;
  }
  if (counts.totalTokens === undefined && counts.inputTokens !== undefined && counts.outputTokens !== undefined) {
    counts.totalTokens = counts.inputTokens + counts.outputTokens;
  }
  const reported = Object.keys(counts).length > 0;
  return { label: candidate, reported, ...counts };
}

/** Run metadata with the usage record added (the metadata is returned unchanged when there is no record). */
export function withRunUsage(
  metadata: Metadata | undefined,
  usage: AiUsage | undefined,
): Metadata | undefined {
  const record = runUsageRecord(usage);
  if (record === undefined) return metadata;
  return { ...(metadata ?? {}), [RUN_USAGE_KEY]: record };
}

/** Read the usage record back from stored run metadata (defensive: anything malformed reads as absent). */
export function readRunUsage(metadata: Metadata | undefined): RunUsageRecord | undefined {
  const raw = metadata?.[RUN_USAGE_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.label !== 'string' || !LABEL.test(record.label)) return undefined;
  const counts: Partial<Record<(typeof COUNT_KEYS)[number], number>> = {};
  for (const key of COUNT_KEYS) {
    const value = countOf(record[key]);
    if (value !== undefined) counts[key] = value;
  }
  return { label: record.label, reported: Object.keys(counts).length > 0, ...counts };
}
