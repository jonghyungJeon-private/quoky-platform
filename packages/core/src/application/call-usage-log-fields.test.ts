import { describe, expect, it } from 'vitest';
import { callUsageLogFields } from './call-usage-log-fields';

describe('callUsageLogFields (ADR-0115 D8 note)', () => {
  it('reports prompt size in chars and UTF-8 bytes and the reported counts', () => {
    expect(callUsageLogFields('가a', { label: 'x', inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }))
      .toEqual({ promptChars: 2, promptBytes: 4, inTok: 10, cacheRead: 4, outTok: 2 });
  });
  it('omits unreported or invalid counts, never 0', () => {
    expect(callUsageLogFields('ab', { label: 'x', inputTokens: -1 })).toEqual({ promptChars: 2, promptBytes: 2 });
    expect(callUsageLogFields('ab', undefined)).toEqual({ promptChars: 2, promptBytes: 2 });
  });
});
