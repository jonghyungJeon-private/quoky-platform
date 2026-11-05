import { describe, expect, it } from 'vitest';
import { callUsageLogFields } from './call-usage-log-fields';

describe('callUsageLogFields (ADR-0115 D8 note)', () => {
  it('reports prompt size in chars and UTF-8 bytes and the reported counts', () => {
    expect(callUsageLogFields('가a', { label: 'x', inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }))
      .toEqual({ promptChars: 2, promptBytes: 4, inTok: 10, cacheRead: 4, outTok: 2 });
  });
  it('adds cacheWrite next to cacheRead when the provider reported cache creation tokens', () => {
    expect(callUsageLogFields('ab', { label: 'x', inputTokens: 20, cachedInputTokens: 12, cacheCreationInputTokens: 6, outputTokens: 2 }))
      .toEqual({ promptChars: 2, promptBytes: 2, inTok: 20, cacheRead: 12, cacheWrite: 6, outTok: 2 });
    expect(callUsageLogFields('ab', { label: 'x', cacheCreationInputTokens: -3 })).toEqual({ promptChars: 2, promptBytes: 2 });
  });
  it('omits unreported or invalid counts, never 0', () => {
    expect(callUsageLogFields('ab', { label: 'x', inputTokens: -1 })).toEqual({ promptChars: 2, promptBytes: 2 });
    expect(callUsageLogFields('ab', undefined)).toEqual({ promptChars: 2, promptBytes: 2 });
  });
});
