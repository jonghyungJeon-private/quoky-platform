import { describe, expect, it, vi } from 'vitest';
import type { AiRequest } from '../../ports/ai-provider.port';

// ADR-0121 D3 (P3-3b): both credential detectors run on the FINAL rendered prompt, before the bound is charged. The readout
// already withholds a credential-shaped item, so the prompt-level check is defence in depth; here the detectors are made to
// fire on the assembled prompt only (it alone holds the span marker), to prove the check exists and runs before `reserve`.
vi.mock('../credential-guard', async (importActual) => {
  const actual = await importActual<typeof import('../credential-guard')>();
  return {
    ...actual,
    containsCredentialMaterial: (text: string): boolean => text.includes('<<<UNTRUSTED_SPAN') || actual.containsCredentialMaterial(text),
  };
});

import { mintSummaryEgressGrantForTest, newSummaryRunToken, quarantinedSummarize, type QuarantinedSummarizerModel } from './quarantined-summary';

describe('quarantined summariser: the final prompt credential check', () => {
  it('a hit on the rendered prompt is listing-only, with no reservation and no call', async () => {
    const requests: AiRequest[] = [];
    const fake: QuarantinedSummarizerModel = { executionLocality: 'LOCAL', auditId: 'a', run: async (request) => (requests.push(request), { text: '{"items":[{"n":1,"summary":"s"}]}' }) };
    const reserved: number[] = [];
    const run = newSummaryRunToken();
    const outcome = await quarantinedSummarize({
      schema: 'digest.v1',
      summaryStep: 1,
      sources: [{ entryId: 'mail.list', documents: [{ id: 'm1', position: 1, title: 't', author: 'a', date: '', body: 'hello' }], grant: mintSummaryEgressGrantForTest(1, 'mail.list', run) }],
      run,
      models: [fake],
      reserve: (tokens) => (reserved.push(tokens), true),
    });
    expect(outcome).toEqual({ kind: 'listing-only', reason: 'credential-in-prompt' });
    expect(reserved).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
