import type { AiUsage } from '../ports';

/**
 * ADR-0115 D8 note (2026-11-03): content-free size and usage fields for one model call's structured log line, so input
 * token estimates can be calibrated against what the provider reported. Counts and sizes only, never prompt or reply
 * text. A count the provider did not report is omitted (never 0). `inTok` is the provider's TOTAL input
 * (`inputTokens`, cache reads and writes included); provider-neutral, no provider branches.
 */
export interface CallUsageLogFields {
  readonly promptChars: number;
  readonly promptBytes: number;
  readonly inTok?: number;
  readonly cacheRead?: number;
  /** Part of `inTok` the provider reported as written to its prompt cache (`cacheCreationInputTokens`); omitted when unreported. */
  readonly cacheWrite?: number;
  readonly outTok?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function callUsageLogFields(prompt: string, usage: AiUsage | undefined): CallUsageLogFields {
  const inTok = count(usage?.inputTokens);
  const cacheRead = count(usage?.cachedInputTokens);
  const cacheWrite = count(usage?.cacheCreationInputTokens);
  const outTok = count(usage?.outputTokens);
  return {
    promptChars: prompt.length,
    promptBytes: new TextEncoder().encode(prompt).length,
    ...(inTok !== undefined ? { inTok } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(outTok !== undefined ? { outTok } : {}),
  };
}
