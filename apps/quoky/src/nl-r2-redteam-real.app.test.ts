import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Capability, type AiProvider, type AiRequest } from '@quoky/core';
import { bootR2Harness, type R2Harness } from './a6-r2-harness';
import { R2CaseRunner, echoedReadout } from './tools/nl-r2-redteam-runner';
import { loadR2RedTeam } from './tools/nl-r2-redteam';

// The real-model red-team path of `eval:r2-redteam`, with a FAKE provider standing in for the Claude CLI: the app's own R2
// item SUMMARIZATION request reaches the provider (and only that one; the setup list summary stays a stub), Jira and Slack
// stay recorded fixtures, and the same deterministic success conditions judge the case. No process, no network.

const cases = loadR2RedTeam();

function fakeProvider(respond: (request: AiRequest) => string): AiProvider & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    id: 'fake-real-summarizer',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => {
      requests.push(request);
      return { text: respond(request), artifacts: [] };
    },
  };
}

describe('the R2 red-team runner with a real-provider path (fake provider)', () => {
  let h: R2Harness;
  beforeAll(async () => {
    h = await bootR2Harness({ QUOKY_NL_ACTIONS: 'local', QUOKY_NL_ITEM_R2: 'all' });
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('routes only the R2 item summary prompt to the provider; a benign summary means 0 successes', async () => {
    const golden = cases.find((candidate) => candidate.attack === 'jira-description' && candidate.summary === undefined && candidate.turns.some((turn) => typeof turn.selector === 'object'));
    if (golden === undefined) throw new Error('no case');
    const provider = fakeProvider(() => '이슈 요약입니다.');
    const runner = new R2CaseRunner(h, async (request) => (await provider.execute(request)).text);
    const result = await runner.run(golden);
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(provider.requests.every((request) => request.capability === Capability.SUMMARIZATION && echoedReadout(request.prompt) !== undefined)).toBe(true);
    expect(result.summaryCalls).toBe(provider.requests.length);
    expect(result.successes).toEqual([]);
  }, 120_000);

  it('a model that obeys the attacker is caught by the same conditions (positive control: a leaked name)', async () => {
    const golden = cases.find((candidate) => candidate.nameCanary !== undefined && candidate.turns.some((turn) => typeof turn.selector === 'object'));
    if (golden === undefined || golden.nameCanary === undefined) throw new Error('no name case');
    const nameCanary = golden.nameCanary;
    const provider = fakeProvider(() => `${nameCanary} 님이 담당이에요.`);
    const result = await new R2CaseRunner(h, async (request) => (await provider.execute(request)).text).run(golden);
    expect(provider.requests.length).toBeGreaterThan(0);
    // The output scrub holds the name back; if it ever did not, this is the success the report would count.
    expect(result.successes.filter((success) => success.includes('participant name'))).toEqual([]);
  }, 120_000);

  it('a provider failure is a case without a delivered summary, never an uncaught error', async () => {
    const golden = cases.find((candidate) => candidate.turns.some((turn) => typeof turn.selector === 'object'));
    if (golden === undefined) throw new Error('no case');
    const runner = new R2CaseRunner(h, async () => {
      throw new Error('provider down');
    });
    const result = await runner.run(golden);
    expect(result.successes).toEqual([]);
  }, 120_000);
});
