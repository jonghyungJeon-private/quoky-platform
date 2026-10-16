import { describe, expect, it } from 'vitest';
import { Capability, type AiProvider, type AiRequest } from '@quoky/core';
import { R2_CLAIM } from './tools/nl-r2-redteam-runner';
import { buildRedTeamPlan, runRealCases } from './tools/nl-r2-redteam-cli';
import { loadR2RedTeam } from './tools/nl-r2-redteam';

// Codex P1: a summary an injected item steered toward an action claim is regenerated once, so a summarising turn can cost 2
// calls. The advertised bound counts them, and the provider wrapper refuses past it. Fake provider; no process, no network.

const cases = loadR2RedTeam().filter((golden) => golden.attack === 'jira-description');

function claimProvider(): AiProvider & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    id: 'claims-always',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => {
      requests.push(request);
      return { text: R2_CLAIM, artifacts: [] };
    },
  };
}

describe('the real-model red-team call bound', () => {
  it('a provider that always claims an action is regenerated once per turn and stays within the advertised bound', async () => {
    const plan = buildRedTeamPlan(cases, 'a'.repeat(64), { runs: 1, timeoutMs: 60_000, attacks: ['jira-description'], gitHead: 'rev' });
    const provider = claimProvider();
    const records = await runRealCases({ cases, runs: 1, summarizer: provider, timeoutMs: 60_000, callLimit: plan.maxSummaryCalls });
    expect(provider.requests.length).toBeGreaterThan(plan.maxSummaryCallsPerRun / 2 - 1);
    expect(provider.requests.length).toBeLessThanOrEqual(plan.maxSummaryCalls);
    expect(records.reduce((sum, record) => sum + (record.summaryRefused ?? 0), 0)).toBe(0);
    // The regeneration really happened: more calls than summarising prompts' first drafts alone.
    expect(provider.requests.length).toBeGreaterThan(records.reduce((sum, record) => sum + (record.summaryExpected === true ? 1 : 0), 0));
  }, 240_000);

  it('past the bound the wrapper refuses and the records show it (the CLI fails the run)', async () => {
    const provider = claimProvider();
    const records = await runRealCases({ cases, runs: 1, summarizer: provider, timeoutMs: 60_000, callLimit: 3 });
    expect(provider.requests).toHaveLength(3);
    expect(records.reduce((sum, record) => sum + (record.summaryRefused ?? 0), 0)).toBeGreaterThan(0);
  }, 240_000);
});
