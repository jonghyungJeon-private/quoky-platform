import { describe, expect, it } from 'vitest';
import { AiFailureKind, AiProviderError, Capability, type AiProvider, type AiRequest } from '@quoky/core';
import { CANARY_CLAUSE, CANARY_PLAN_LINE, TOTAL_CANARY_CALLS, EXIT_INVALID_PROVIDER, MAX_CANARY_CALLS, ProviderOutageAbort, formatProviderOutcomes, guardEvalProvider, providerCanary, providerFailureReason, resolveThresholds } from './eval-provider-guard';
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
  it('trips after 5 + 2 x concurrency consecutive provider failures and stops reaching the provider', async () => {
    const inner = scripted(outageFrom(11));
    const trips: string[] = [];
    const guard = guardEvalProvider(inner, { onTrip: (trip) => trips.push(`${trip.trigger}:${trip.reason}@${trip.atCall}`) });
    await drive(guard.provider, 100);
    expect(inner.calls).toBe(17);
    expect(trips).toEqual(['consecutive-failures:provider-execution_failed@17']);
    expect(guard.report()).toMatchObject({ calls: 17, ok: 10, failures: 7, notIssued: 83, invalidReason: 'provider-execution_failed', failureReasons: { 'provider-execution_failed': 7 } });
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

  it('sporadic timeouts are scored as before; 10 + 2 x concurrency timeouts in a row are provider-wide', async () => {
    const timeout = new AiProviderError(AiFailureKind.TIMEOUT, 't');
    const sporadic = guardEvalProvider(scripted((call) => (call % 4 === 0 ? timeout : undefined)));
    await expect(Promise.all([1, 2, 3, 4].map(() => sporadic.provider.execute(request)))).rejects.toBe(timeout);
    await drive(sporadic.provider, 96);
    expect(sporadic.report()).toMatchObject({ calls: 100, timeouts: 25, failures: 0 });
    expect(sporadic.report().invalidReason).toBeUndefined();
    const streak = scripted((call) => (call > 3 ? timeout : undefined));
    const guarded = guardEvalProvider(streak);
    await drive(guarded.provider, 50);
    expect(streak.calls).toBe(15);
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
      canary: async () => false,
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
    expect(provider.calls).toBe(14);
    expect(verdictLines(d.out)).toEqual([]);
    expect(d.out).toContain('intent gate: INVALID (provider unavailable: provider-execution_failed); the scores of this run are not reported (re-run after the provider recovers)');
    expect(d.out.filter((line) => line.startsWith('run ')).every((line) => line.includes('INVALID (provider unavailable: provider-execution_failed)'))).toBe(true);
    expect(d.out.join('\n')).toContain('provider outcomes: calls 14, ok 7, timeouts 0, provider failures 7');
    expect(d.out.join('\n')).toContain('not issued after abort 66');
    expect(d.err.some((line) => line.startsWith('ABORT: provider unavailable (provider-execution_failed'))).toBe(true);
    expect(JSON.parse(d.written[0] as string)).toMatchObject({ verdict: 'INVALID (provider unavailable: provider-execution_failed)', providerOutcomes: { failures: 7 } });
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
      canary: async () => false,
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
      expect(provider.calls).toBeLessThanOrEqual(12);
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
      canary: async () => false,
    };
  }

  it('INVALID, exit 5, early stop; a sporadic failure is still scored', async () => {
    const planned = deps(scripted(() => undefined));
    await runAgentPlanCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], planned);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.out.join('\n'))?.[1] as string;
    const provider = scripted(outageFrom(6));
    const d = deps(provider);
    expect(await runAgentPlanCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], d)).toBe(EXIT_INVALID_PLAN);
    expect(provider.calls).toBe(12);
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
      canary: async () => false,
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
    expect(provider.calls).toBeGreaterThanOrEqual(9);
    expect(provider.calls).toBeLessThanOrEqual(11);
    expect(cases.length).toBeGreaterThan(7);
    expect(verdictLines(d.out)).toEqual([]);
    expect(d.out.some((line) => line.startsWith('red-team gate: INVALID (provider unavailable: provider-execution_failed)'))).toBe(true);
  });
});

describe('guard robustness (CA review W5 / W6)', () => {
  it('scales the streak limits with the concurrency and the share floor with the plan size', () => {
    expect(resolveThresholds({ concurrency: 1 })).toMatchObject({ maxConsecutiveFailures: 7, maxConsecutiveTimeouts: 12, minCallsForEarlyTrip: 40 });
    expect(resolveThresholds({ concurrency: 4, maxCalls: 1000 })).toMatchObject({ maxConsecutiveFailures: 13, maxConsecutiveTimeouts: 18, minCallsForEarlyTrip: 100 });
    expect(resolveThresholds({ concurrency: 4, maxCalls: 100 })).toMatchObject({ minCallsForEarlyTrip: 40 });
  });

  it('a canary that answers means "not an outage": no trip, no INVALID, calls keep going and are scored', async () => {
    const inner = scripted(outageFrom(11));
    const trips: string[] = [];
    let canaryCalls = 0;
    const guard = guardEvalProvider(inner, {
      canary: async () => {
        canaryCalls += 1;
        return true;
      },
      onTrip: (trip) => trips.push(trip.reason),
    });
    await drive(guard.provider, 100);
    await guard.settle();
    expect(trips).toEqual([]);
    expect(inner.calls).toBe(100);
    expect(guard.report()).toMatchObject({ calls: 100, failures: 90, notIssued: 0, canaryAnswered: canaryCalls });
    expect(canaryCalls).toBeGreaterThan(0);
    expect(canaryCalls).toBeLessThanOrEqual(4); // 3 mid-run + the reserved final one (the run ends on a streak)
    expect(guard.report().invalidReason).toBeUndefined();
    expect(guard.report().tripped).toBeUndefined();
  });

  it('a canary that fails (or throws) trips the guard as before; settle() judges the final share with one canary', async () => {
    const failing = guardEvalProvider(scripted(outageFrom(1)), { canary: async () => false });
    await drive(failing.provider, 20);
    await failing.settle();
    expect(failing.report()).toMatchObject({ canaryCalls: 1, canaryAnswered: 0, invalidReason: 'provider-execution_failed' });
    const throwing = guardEvalProvider(scripted(outageFrom(1)), {
      canary: async () => {
        throw new Error('boom');
      },
    });
    await drive(throwing.provider, 20);
    await throwing.settle();
    expect(throwing.report().invalidReason).toBe('provider-execution_failed');

    const answered = guardEvalProvider(scripted(onlyAt(3, 17)), { canary: async () => true });
    await drive(answered.provider, 30);
    await answered.settle();
    expect(answered.report().invalidReason).toBeUndefined();
    const down = guardEvalProvider(scripted(onlyAt(3, 17)), { canary: async () => false });
    await drive(down.provider, 30);
    await down.settle();
    expect(down.report()).toMatchObject({ invalidReason: 'provider-execution_failed', tripped: { trigger: 'failure-share' } });
  });

  it('providerCanary makes one tiny call through the same provider and resolves false on a throw', async () => {
    const seen: AiRequest[] = [];
    const ok: AiProvider = { ...scripted(() => undefined), execute: async (req) => (seen.push(req), { text: 'ok' }) };
    expect(await providerCanary(ok, 1234)()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ timeoutMs: 1234 });
    expect(seen[0]?.prompt.length).toBeLessThan(80);
    expect(await providerCanary(scripted(outageFrom(1)))()).toBe('provider-execution_failed');
  });

  it('providerCanary probes the capability the run evaluates', async () => {
    const seen: AiRequest[] = [];
    const both: AiProvider = {
      ...scripted(() => undefined),
      capabilities: [
        { capability: Capability.SUMMARIZATION, priority: 1 },
        { capability: Capability.INTENT_SELECTION, priority: 1 },
      ],
      execute: async (req) => (seen.push(req), { text: 'ok' }),
    };
    await providerCanary(both, undefined, Capability.INTENT_SELECTION)();
    await providerCanary(both)();
    expect(seen.map((req) => req.capability)).toEqual([Capability.INTENT_SELECTION, Capability.SUMMARIZATION]);
  });
});

describe('C1: an outage never hides a hard failure already observed (FAILED, exit 1)', () => {
  const FAILED_NOTE = '(provider outage also seen: provider-execution_failed)';
  const capture = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'CLEAR', alternatives: [] });
  /** The first `answered` calls answer with `text`, every later call fails: a hard failure followed by an outage. */
  function wrongThenOutage(answered: number, text: string) {
    return scripted((call) => (call > answered ? new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'limit') : undefined), text);
  }

  it('eval:nl intent: a wrong capture then an outage is FAILED with the note', async () => {
    const corpus: NlEvalCorpus = { version: 1, cases: Array.from({ length: 40 }, (_, index) => ({ id: `neg-${index}`, text: `안녕 ${index}번째 인사`, expect: 'none' as const })) };
    const out: string[] = [];
    const base: CliDeps = { stdout: (l) => void out.push(l), stderr: () => undefined, now: () => NOW, loadCorpus: () => ({ corpus, sha256: 'corpus-sha' }), writeReport: (n) => `/tmp/${n}`, createProvider: () => wrongThenOutage(3, capture), canary: async () => false };
    const planned: string[] = [];
    await runNlCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], { ...base, stdout: (l) => void planned.push(l) });
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.join('\n'))?.[1] as string;
    expect(await runNlCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], base)).toBe(1);
    expect(out.some((line) => line.startsWith('intent gate: FAILED') && line.endsWith(FAILED_NOTE))).toBe(true);
    expect(out.join('\n')).not.toContain('INVALID');
  });

  // --mode r2 shares the action summary fields (wrongTargets, negativeCaptures); the R2 corpus offers no cheap scripted
  // hard failure, so it is not exercised end to end here.
  for (const mode of ['action', 'read-regression'] as const) {
    it(`eval:nl --mode ${mode}: a captured/wrong answer then an outage is FAILED with the note`, async () => {
      const out: string[] = [];
      const make = (provider: AiProvider): CliDeps => ({
        stdout: (l) => void out.push(l),
        stderr: () => undefined,
        now: () => NOW,
        gitHead: () => 'rev-1',
        loadCorpus: () => {
          throw new Error('not used');
        },
        writeReport: (n) => `/tmp/${n}`,
        createProvider: () => provider,
        canary: async () => false,
      });
      await runNlCli(['--mode', mode, '--concurrency', '1', '--runs', '1'], make(scripted(() => undefined)));
      const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;
      out.length = 0;
      const todo = JSON.stringify({ entryId: 'todo.add', args: { title: '보고서' }, ambiguity: 'CLEAR', alternatives: [] });
      expect(await runNlCli(['--mode', mode, '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], make(wrongThenOutage(400, todo)))).toBe(1);
      expect(out.some((line) => line.includes('gate') && line.includes(': FAILED') && line.endsWith(FAILED_NOTE))).toBe(true);
      expect(out.join('\n')).not.toContain('INVALID');
    }, 60_000);
  }

  it('eval:agent-plan: a wrong plan on a negative then an outage is FAILED with the note', async () => {
    const out: string[] = [];
    const make = (provider: AiProvider): AgentPlanCliDeps => ({ stdout: (l) => void out.push(l), stderr: () => undefined, now: () => NOW, gitHead: () => 'a'.repeat(40), load: () => loadAgentPlanCorpus(), writeReport: (n) => `/tmp/${n}`, createProvider: () => provider, canary: async () => false });
    await runAgentPlanCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], make(scripted(() => undefined)));
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;
    out.length = 0;
    const mail = JSON.stringify({ entryId: 'mail.list', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    expect(await runAgentPlanCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], make(wrongThenOutage(400, mail)))).toBe(1);
    expect(out.some((line) => line.startsWith('agent-plan gate') && line.includes(': FAILED') && line.endsWith(FAILED_NOTE))).toBe(true);
    expect(out.join('\n')).not.toContain('INVALID');
  }, 60_000);

  it('eval:r2-redteam: a successful attack then an outage is FAILED with the note', async () => {
    const cases = loadR2RedTeam();
    const out: string[] = [];
    const provider = scripted(() => undefined);
    const d: RedTeamDeps = {
      stdout: (l) => void out.push(l),
      stderr: () => undefined,
      now: () => NOW,
      gitHead: () => 'rev-1',
      loadCases: () => ({ cases, sha256: 'a'.repeat(64) }),
      writeReport: (n) => `/reports/${n}`,
      createSummarizer: () => provider,
      canary: async () => false,
      runCases: async ({ cases: selected, runs, summarizer }) => {
        const records: RedTeamCaseRecord[] = [];
        let index = 0;
        for (let run = 1; run <= runs; run += 1) {
          for (const golden of selected) {
            index += 1;
            let ok = 0;
            let failed = 0;
            try {
              if (index > 1) throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'limit');
              await summarizer.execute({ capability: Capability.SUMMARIZATION, prompt: 'p' });
              ok = 1;
            } catch {
              failed = 1;
              // Route the failure through the guard so it is counted.
              await summarizer.execute({ capability: Capability.SUMMARIZATION, prompt: 'p' }).catch(() => undefined);
            }
            records.push({ run, id: golden.id, attack: golden.attack, successes: index === 1 ? ['leak'] : [], expectationMisses: 0, summaryCalls: 1, summaryOk: ok, summaryFailures: failed });
          }
        }
        return records;
      },
    };
    const failing = scripted((call) => (call > 1 ? new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'limit') : undefined));
    const withProvider: RedTeamDeps = { ...d, createSummarizer: () => failing };
    await runRedTeamCli(['--mode', 'plan', '--runs', '1'], withProvider);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;
    out.length = 0;
    expect(await runRedTeamCli(['--mode', 'run', '--runs', '1', '--approved-plan-digest', digest], withProvider)).toBe(1);
    expect(out.some((line) => line.startsWith('red-team gate') && line.includes('FAILED') && line.endsWith(FAILED_NOTE))).toBe(true);
    expect(out.join('\n')).not.toContain('INVALID');
  });

  it('an INVALID run still prints the hard-failure counts (zeros)', async () => {
    const corpus: NlEvalCorpus = { version: 1, cases: Array.from({ length: 40 }, (_, index) => ({ id: `neg-${index}`, text: `안녕 ${index}번째 인사`, expect: 'none' as const })) };
    const out: string[] = [];
    const base: CliDeps = { stdout: (l) => void out.push(l), stderr: () => undefined, now: () => NOW, loadCorpus: () => ({ corpus, sha256: 'corpus-sha' }), writeReport: (n) => `/tmp/${n}`, createProvider: () => scripted(outageFrom(8)), canary: async () => false };
    await runNlCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], base);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;
    out.length = 0;
    expect(await runNlCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], base)).toBe(5);
    expect(out).toContain('hard failures among the answered calls: wrongCaptures 0');
  });

  it('a canary that answers lets the CLI score the failures (FAILED/PASSED, never INVALID)', async () => {
    const corpus: NlEvalCorpus = { version: 1, cases: Array.from({ length: 40 }, (_, index) => ({ id: `neg-${index}`, text: `안녕 ${index}번째 인사`, expect: 'none' as const })) };
    const out: string[] = [];
    const provider = scripted(outageFrom(8));
    const base: CliDeps = { stdout: (l) => void out.push(l), stderr: () => undefined, now: () => NOW, loadCorpus: () => ({ corpus, sha256: 'corpus-sha' }), writeReport: (n) => `/tmp/${n}`, createProvider: () => provider, canary: async () => true };
    await runNlCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], base);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;
    out.length = 0;
    expect([0, 1]).toContain(await runNlCli(['--mode', 'run', '--concurrency', '1', '--runs', '1', '--approved-plan-digest', digest], base));
    expect(provider.calls).toBe(40);
    expect(out.join('\n')).not.toContain('INVALID');
    expect(out.some((line) => line.includes('canary') && line.includes('not an outage'))).toBe(true);
    expect(out.some((line) => /^intent gate: (PASSED|FAILED)/.test(line))).toBe(true);
  });
});

describe('canary is non-blocking and capped (CA re-review 1 / 2)', () => {
  it('a slow canary never holds up a failing call: recorded latencies are unchanged', async () => {
    const inner = scripted(outageFrom(1));
    const guard = guardEvalProvider(inner, {
      canary: () => new Promise((resolve) => setTimeout(() => resolve(true), 400)),
    });
    const durations: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const started = Date.now();
      await guard.provider.execute(request).catch(() => undefined);
      durations.push(Date.now() - started);
    }
    expect(Math.max(...durations)).toBeLessThan(100);
    expect(guard.report().tripped).toBeUndefined();
    await guard.settle();
    expect(guard.report()).toMatchObject({ canaryCalls: 1, canaryAnswered: 1 });
    expect(guard.report().invalidReason).toBeUndefined();
  });

  it('settle waits for a pending canary; a failed canary trips and records the failure reason', async () => {
    const guard = guardEvalProvider(scripted(outageFrom(1)), { canary: () => new Promise((resolve) => setTimeout(() => resolve('provider-auth_required'), 150)) });
    await drive(guard.provider, 9);
    expect(guard.report().tripped).toBeUndefined();
    await guard.settle();
    expect(guard.report()).toMatchObject({ canaryCalls: 1, canaryFailure: 'provider-auth_required', invalidReason: 'provider-execution_failed' });
    expect(formatProviderOutcomes(guard.report())).toContain('canary failed: provider-auth_required');
  });

  it('at most 3 mid-run canary calls (+1 final); afterwards the run is scored as it is', async () => {
    let canaryCalls = 0;
    const guard = guardEvalProvider(scripted(outageFrom(1)), {
      canary: async () => {
        canaryCalls += 1;
        return true;
      },
    });
    for (let index = 0; index < 200; index += 1) {
      await guard.provider.execute(request).catch(() => undefined);
      if (index % 5 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await guard.settle();
    // 3 mid-run canaries (the cap) + the reserved final one, because the run ends on a failure streak (answered here)
    expect(canaryCalls).toBe(MAX_CANARY_CALLS + 1);
    expect(guard.report()).toMatchObject({ canaryCalls: 4, canaryAnswered: 4, notIssued: 0 });
    expect(guard.report().tripped).toBeUndefined();
    expect(guard.report().invalidReason).toBeUndefined();
  });

  it('every plan output carries the canary line', async () => {
    expect(CANARY_PLAN_LINE).toBe('+ up to 4 canary calls (not counted)');
    expect(TOTAL_CANARY_CALLS).toBe(4);
    const out: string[] = [];
    const corpus: NlEvalCorpus = { version: 1, cases: [{ id: 'n', text: '안녕', expect: 'none' as const }] };
    await runNlCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], { stdout: (l) => void out.push(l), stderr: () => undefined, now: () => NOW, loadCorpus: () => ({ corpus, sha256: 'x' }), writeReport: (n) => n, createProvider: () => scripted(() => undefined) });
    expect(out).toContain(CANARY_PLAN_LINE);
    const plan: string[] = [];
    await runAgentPlanCli(['--mode', 'plan', '--concurrency', '1', '--runs', '1'], { stdout: (l) => void plan.push(l), stderr: () => undefined, now: () => NOW, gitHead: () => 'a'.repeat(40), load: () => loadAgentPlanCorpus(), writeReport: (n) => n, createProvider: () => scripted(() => undefined) });
    expect(plan.some((line) => line.includes(CANARY_CLAUSE) && line.includes('hard cap on the counted calls'))).toBe(true);
    const red: string[] = [];
    await runRedTeamCli(['--mode', 'plan', '--runs', '1'], { stdout: (l) => void red.push(l), stderr: () => undefined, now: () => NOW, gitHead: () => 'rev', loadCases: () => ({ cases: loadR2RedTeam(), sha256: 'a'.repeat(64) }), writeReport: (n) => n, createSummarizer: () => scripted(() => undefined) });
    expect(red.some((line) => line.includes('at most') && line.includes(CANARY_CLAUSE) && !line.includes('no other model call'))).toBe(true);
  });
});

describe('final canary (CA final round W1)', () => {
  it('3 answered canaries, then an outage until the end: settle() runs the reserved final canary and the run is INVALID', async () => {
    let canaryCalls = 0;
    const guard = guardEvalProvider(scripted(outageFrom(1)), {
      canary: async () => {
        canaryCalls += 1;
        return canaryCalls <= 3 ? true : 'provider-execution_failed';
      },
    });
    for (let index = 0; index < 60; index += 1) {
      await guard.provider.execute(request).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(guard.report().canaryAnswered).toBe(3);
    expect(guard.report().tripped).toBeUndefined();
    await guard.settle();
    expect(canaryCalls).toBe(4);
    expect(guard.report()).toMatchObject({ canaryCalls: 4, canaryAnswered: 3, canaryFailure: 'provider-execution_failed', tripped: { trigger: 'consecutive-failures' } });
    expect(guard.report().invalidReason).toBe('provider-execution_failed');
  });

  it('a run that does not end on a streak makes no final canary; an answered final canary leaves the run valid', async () => {
    let canaryCalls = 0;
    const calm = guardEvalProvider(scripted(onlyAt(3)), { canary: async () => (canaryCalls += 1, true) });
    await drive(calm.provider, 50);
    await calm.settle();
    expect(canaryCalls).toBe(0);
    const tail = guardEvalProvider(scripted(outageFrom(1)), { canary: async () => (canaryCalls += 1, true) });
    for (let index = 0; index < 60; index += 1) {
      await tail.provider.execute(request).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await tail.settle();
    expect(tail.report().tripped).toBeUndefined();
    expect(tail.report().invalidReason).toBeUndefined();
  });
});
