import { describe, expect, it } from 'vitest';
import { RUN_USAGE_KEY, readRunUsage, runUsageRecord, withRunUsage } from './provider-usage-record';

describe('provider usage record (ADR-0115 D8)', () => {
  it('normalises reported counts and keeps the provider total', () => {
    expect(
      runUsageRecord({ label: 'openai:gpt-5', inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 125 }),
    ).toEqual({ label: 'openai:gpt-5', reported: true, inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 125 });
  });

  it('derives the total only from reported input and output (arithmetic, not an estimate)', () => {
    expect(runUsageRecord({ label: 'codex', inputTokens: 1200, outputTokens: 80 })?.totalTokens).toBe(1280);
    expect(runUsageRecord({ label: 'codex', inputTokens: 1200 })?.totalTokens).toBeUndefined();
  });

  it('a label with no counts is "unknown": reported=false and no count at all', () => {
    const record = runUsageRecord({ label: 'claude:sonnet' });
    expect(record).toEqual({ label: 'claude:sonnet', reported: false });
  });

  it('drops malformed counts and refuses an unusable label', () => {
    expect(runUsageRecord({ label: 'x', inputTokens: -1, outputTokens: 1.5, totalTokens: Number.NaN })).toEqual({ label: 'x', reported: false });
    expect(runUsageRecord({ label: 'has space and \u0000' })).toBeUndefined();
    expect(runUsageRecord(undefined)).toBeUndefined();
  });

  it('leaves metadata exactly as it was when the provider reported no usage object', () => {
    const metadata = { model: 'm' };
    expect(withRunUsage(metadata, undefined)).toBe(metadata);
    expect(withRunUsage(undefined, undefined)).toBeUndefined();
  });

  it('adds the record under metadata.usage and reads it back', () => {
    const stored = withRunUsage({ model: 'm' }, { label: 'gemini:g', inputTokens: 1, outputTokens: 2 });
    expect(stored).toEqual({ model: 'm', [RUN_USAGE_KEY]: { label: 'gemini:g', reported: true, inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
    expect(readRunUsage(stored)).toEqual({ label: 'gemini:g', reported: true, inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('reads malformed stored usage as absent', () => {
    expect(readRunUsage(undefined)).toBeUndefined();
    expect(readRunUsage({ usage: 'x' })).toBeUndefined();
    expect(readRunUsage({ usage: [] })).toBeUndefined();
    expect(readRunUsage({ usage: { label: 5 } })).toBeUndefined();
  });
});
