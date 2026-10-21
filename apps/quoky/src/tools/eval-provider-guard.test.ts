import { describe, expect, it } from 'vitest';
import { AiFailureKind, AiProviderError, Capability, type AiProvider, type AiRequest } from '@quoky/core';
import { EXIT_INVALID_PROVIDER, ProviderOutageAbort, guardEvalProvider, providerFailureReason } from './eval-provider-guard';
import { EXIT_INVALID as EXIT_INVALID_NL, runCli as runNlCli, type CliDeps } from './nl-intent-eval-cli';
import { EXIT_INVALID as EXIT_INVALID_PLAN, runCli as runAgentPlanCli, type AgentPlanCliDeps } from './agent-plan-eval-cli';
import { loadAgentPlanCorpus } from './agent-plan-eval';
import { EXIT_INVALID as EXIT_INVALID_REDTEAM, runCli as runRedTeamCli, type RedTeamCaseRecord, type RedTeamDeps } from './nl-r2-redteam-cli';
import { loadR2RedTeam } from './nl-r2-redteam';
import type { NlEvalCase, NlEvalCorpus } from './nl-intent-eval';

// The provider-outage guard of the model-in-the-loop eval CLIs (2026-10-21 harness hardening): a provider that starts
// failing mid-run (a usage/session limit) makes the run INVALID with exit 5, stops issuing calls early and never prints
// PASSED or FAILED; sporadic failures below the threshold are still scored. Fake providers only; nothing is spawned.

const NOW = '2026-10-21T03:00:00.000Z';
const NONE = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
const request: AiRequest = { capability: Capability.INTENT_SELECTION, prompt: 'p' };

/** A scripted provider: `fails(n)` (1-based call number) decides whether call n throws. */
function scripted(fails: (call: number) => AiProviderError | undefined, text = NONE): AiProvider & { calls: number } {
  const provider = {
    calls: 0,
    id: 'scripted',
    capabilities: [
      { capability: Capability.INTENT_SELECTION, priority: 1 },
      { capability: Capability.SUMMARIZATION, priority: 1 },
    ],
    isAvailable: async () => true,
    execute: async () => {
      provider.calls += 1;
      const error = fails(provider.calls);
      if (error !== undefined) throw error;
      return { text };
    },
  };
  return provider;
}
const outageFrom = (first: number) => (call: number) => (call >= first ? new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'limit') : undefined);
const onlyAt = (...calls: number[]) => (call: number) => (calls.includes(call) ? new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'blip') : undefined);
const verdictLines = (out: readonly string[]) => out.filter((line) => /\b(PASSED|FAILED)\b/.test(line));

async function drive(provider: AiProvider, count: number): Promise<number> {
  let thrown = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      await provider.execute(request);
    } catch {
      thrown += 1;
    }
  }
  return thrown;
}

describe('guardEvalProvider (unit)', () => {
  it('trips after 5 consecutive provider failures and stops reaching the provider', async () => {
    const inner = scripted(outageFrom(11));
    const trips: string[] = [];
    const guard = guardEvalProvider(inner, { onTrip: (trip) => trips.push(`${trip.trigger}:${trip.reason}@${trip.atCall}`) });
    await drive(guard.provider, 100);
    expect(inner.calls).toBe(15);
    expect(trips).toEqual(['consecutive-failures:provider-execution_failed@15']);
    expect(guard.report()).toMatchObject({ calls: 15, ok: 10, failures: 5, notIssued: 85, invalidReason: 'provider-execution_failed', failureReasons: { 'provider-execution_failed': 5 } });
    await expect(guard.provider.execute(request)).rejects.toBeInstanceOf(ProviderOutageAbort);
  });

  it('trips on the failure share (> 5%) once 40 calls and 3 failures were seen, even without a streak', async () => {
    const inner = scripted((call) => (call % 5 === 0 ? new AiProviderError(AiFailureKind.UNAVAILABLE, 'flaky') : undefined));
    const guard = guardEvalProvider(inner);
    await drive(guard.provider, 200);
    expect(inner.calls).toBe(40);
    expect(guard.report().tripped).toMatchObject({ trigger: 'failure-share', reason: 'provider-unavailable', atCall: 40 });
  });

  it('a run that ends above 5% with 2+ failures is invalid without tripping; a 2% run is valid', async () => {
    const high = guardEvalProvider(scripted(onlyAt(3, 17)));
    await drive(high.provider, 30);
    expect(high.report()).toMatchObject({ calls: 30, failures: 2, invalidReason: 'provider-execution_failed' });
    expect(high.report().tripped).toBeUndefined();
    const low = guardEvalProvider(scripted(onlyAt(3, 60)));
    await drive(low.provider, 100);
    expect(low.report()).toMatchObject({ calls: 100, failures: 2, notIssued: 0 });
    expect(low.report().invalidReason).toBeUndefined();
  });

  it('sporadic timeouts are scored as before; 10 timeouts in a row are provider-wide', async () => {
    const timeout = new AiProviderError(AiFailureKind.TIMEOUT, 't');
    const sporadic = guardEvalProvider(scripted((call) => (call % 4 === 0 ? timeout : undefined)));
    await expect(Promise.all([1, 2, 3, 4].map(() => sporadic.provider.execute(request)))).rejects.toBe(timeout);
    await drive(sporadic.provider, 96);
    expect(sporadic.report()).toMatchObject({ calls: 100, timeouts: 25, failures: 0 });
    expect(sporadic.report().invalidReason).toBeUndefined();
    const streak = scripted((call) => (call > 3 ? timeout : undefined));
    const guarded = guardEvalProvider(streak);
    await drive(guarded.provider, 50);
    expect(streak.calls).toBe(13);
    expect(guarded.report()).toMatchObject({ invalidReason: 'timeout-streak', tripped: { trigger: 'timeout-streak' } });
  });

  it('records content-free reasons only', () => {
    expect(providerFailureReason(new AiProviderError(AiFailureKind.AUTH_REQUIRED, 'secret text'))).toBe('provider-auth_required');
    expect(providerFailureReason({ kind: 'TIMEOUT' })).toBe('timeout');
    expect(providerFailureReason(new Error('anything'))).toBe('error');
    expect(EXIT_INVALID_PROVIDER).toBe(5);
  });
});

describe('eval:nl intent mode under a provider outage', () => {
  const cases: NlEvalCase[] = Array.from({ length: 40 }, (_, index) => ({ id: `neg-${index}`, text: `안녕 ${index}번째 인사`, expect: 'none' as const }));
  const corpus: NlEvalCorpus = { version: 1, cases };
  function deps(provider: AiProvider): CliDeps & { out: string[]; err: string[]; written: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const written: string[] = [];
    return {
      out,
      err,
      written,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => NOW,
      loadCorpus: () => ({ corpus, sha256: 'corpus-sha' }),
      writeReport: (name, contents) => {
        written.push(contents);
        return `/tmp/${name}`;
      },
      createProvider: () => provider,
    };
  }
  async function digest(): Promise<string> {
    const planned = deps(scripted(() => undefined));
    await runNlCli(['--mode', 'plan', '--concurrency', '1', '--runs', '2'], planned);
    return /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.out.join('\n'))?.[1] as string;
  }

  it('a provider that starts failing mid-run gives INVALID, exit 5, and stops early', async () => {
    const provider = scripted(outageFrom(8));
    const d = deps(provider);
    expect(await runNlCli(['--mode', 'run', '--concurrency', '1', '--runs', '2', '--approved-plan-digest', await digest()], d)).toBe(EXIT_INVALID_NL);
    expect(EXIT_INVALID_NL).toBe(5);
    expect(provider.calls).toBe(12);
    expect(verdictLines(d.out)).toEqual([]);
    expect(d.out).toContain('intent gate: INVALID (provider unavailable: provider-execution_failed); the scores of this run are not reported (re-run after the provider recovers)');
    expect(d.out.filter((line) => line.startsWith('run ')).every((line) => line.includes('INVALID (provider unavailable: provider-execution_failed)'))).toBe(true);
    expect(d.out.join('\n')).toContain('provider outcomes: calls 12, ok 7, timeouts 0, provider failures 5');
    expect(d.out.join('\n')).toContain('not issued after abort 68');
    expect(d.err.some((line) => line.startsWith('ABORT: provider unavailable (provider-execution_failed'))).toBe(true);
    expect(JSON.parse(d.written[0] as string)).toMatchObject({ verdict: 'INVALID (provider unavailable: provider-execution_failed)', providerOutcomes: { failures: 5 } });
  });

  it('a sporadic failure is still scored (PASSED/FAILED as before) and counted', async () => {
    const provider = scripted(onlyAt(9));
    const d = deps(provider);
    const code = await runNlCli(['--mode', 'run', '--concurrency', '1', '--runs', '2', '--approved-plan-digest', await digest()], d);
    expect(code).not.toBe(EXIT_INVALID_NL);
    expect(provider.calls).toBe(80);
    expect(d.out.join('\n')).toContain('provider outcomes: calls 80, ok 79, timeouts 0, provider failures 1 (1.3%: provider-execution_failed 1), not issued after abort 0');
    expect(d.out.some((line) => /^intent gate: (PASSED|FAILED)/.test(line))).toBe(true);
    expect(d.out.join('\n')).not.toContain('INVALID');
  });
});

describe('eval:nl action / read-regression / r2 modes under a provider outage', () => {
  function deps(provider: AiProvider): CliDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => NOW,
      gitHead: () => 'rev-1',
      loadCorpus: () => {
        throw new Error('not used');
      },
      writeReport: (name) => `/tmp/${name}`,
      createProvider: () => provider,
    };
  }

  for (const mode of ['action', 'read-regression', 'r2'] as const) {
    it(`--mode ${mode}: INVALID, exit 5, early stop, no PASSED/FAILED`, async () => {
      const planned = deps(scripted(() => undefined));
      await runNlCli(['--mode', mode, '--concurrency', '1', '--runs', '1'], planned);
      const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.out.join('\n'))?.[1] as string;
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      const provider = scripted(outageFrom(4));
      const d = deps(provider);
      expect(await runNlCli(['--mode', mode, '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], d)).toBe(5);
      expect(provider.calls).toBeLessThanOrEqual(8);
      expect(verdictLines(d.out)).toEqual([]);
      expect(d.out.some((line) => line.includes('gate') && line.includes('INVALID (provider unavailable: provider-execution_failed)'))).toBe(true);
    }, 60_000);
  }
});

describe('eval:agent-plan under a provider outage', () => {
  function deps(provider: AiProvider): AgentPlanCliDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => NOW,
      gitHead: () => 'a'.repeat(40),
      load: () => loadAgentPlanCorpus(),
      writeReport: (name) => `/tmp/${name}`,
      createProvider: () => provider,
    };
  }

  it('INVALID, exit 5, early stop; a sporadic failure is still scored', async () => {
    const planned = deps(scripted(() => undefined));
    await runAgentPlanCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], planned);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.out.join('\n'))?.[1] as string;
    const provider = scripted(outageFrom(6));
    const d = deps(provider);
    expect(await runAgentPlanCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], d)).toBe(EXIT_INVALID_PLAN);
    expect(provider.calls).toBe(10);
    expect(verdictLines(d.out)).toEqual([]);
    expect(d.out.some((line) => line.startsWith('agent-plan gate') && line.includes('INVALID (provider unavailable: provider-execution_failed)'))).toBe(true);

    const blip = scripted(onlyAt(2));
    const scored = deps(blip);
    expect(await runAgentPlanCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], scored)).not.toBe(EXIT_INVALID_PLAN);
    expect(scored.out.some((line) => /^agent-plan gate .*: (PASSED|FAILED)/.test(line))).toBe(true);
  }, 60_000);
});

describe('eval:r2-redteam under a summariser outage', () => {
  const cases = loadR2RedTeam();
  function deps(provider: AiProvider): RedTeamDeps & { out: string[]; err: string[]; reached: number[] } {
    const out: string[] = [];
    const err: string[] = [];
    const reached: number[] = [];
    return {
      out,
      err,
      reached,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => NOW,
      gitHead: () => 'rev-1',
      loadCases: () => ({ cases, sha256: 'a'.repeat(64) }),
      writeReport: (name) => `/reports/${name}`,
      createSummarizer: () => provider,
      // One summarisation per case (the app handles a failed call; the record counts it).
      runCases: async ({ cases: selected, runs, summarizer }) => {
        const records: RedTeamCaseRecord[] = [];
        for (let run = 1; run <= runs; run += 1) {
          for (const golden of selected) {
            let ok = 0;
            let failed = 0;
            try {
              await summarizer.execute({ capability: Capability.SUMMARIZATION, prompt: 'p' });
              ok = 1;
            } catch {
              failed = 1;
            }
            records.push({ run, id: golden.id, attack: golden.attack, successes: [], expectationMisses: 0, summaryCalls: 1, summaryOk: ok, summaryFailures: failed });
          }
        }
        return records;
      },
    };
  }

  it('INVALID, exit 5, early stop', async () => {
    const planned = deps(scripted(() => undefined));
    await runRedTeamCli(['--mode', 'plan', '--runs', '1'], planned);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.out.join('\n'))?.[1] as string;
    const provider = scripted(outageFrom(3), 'summary');
    const d = deps(provider);
    expect(await runRedTeamCli(['--mode', 'run', '--runs', '1', '--approved-plan-digest', digest], d)).toBe(EXIT_INVALID_REDTEAM);
    expect(provider.calls).toBe(7);
    expect(cases.length).toBeGreaterThan(7);
    expect(verdictLines(d.out)).toEqual([]);
    expect(d.out.some((line) => line.startsWith('red-team gate: INVALID (provider unavailable: provider-execution_failed)'))).toBe(true);
  });
});
