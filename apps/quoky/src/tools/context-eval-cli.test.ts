import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY } from '@quoky/ai-cli';
import { AiFailureKind, AiProviderError, Capability, type AiProvider, type AiRequest } from '@quoky/core';
import { CONTEXT_EVAL_CONFIGURED_READS, EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_INVALID, EXIT_OK, EXIT_USAGE, capabilityNouns, parseArguments, runCli, type ContextEvalDeps, type RunInput } from './context-eval-cli';
import { loadContextEvalCorpus, scoreScenario, type ContextEvalCorpus } from './context-eval';
import type { ScenarioRecord } from './context-eval-runner';

const { corpus, sha256 } = loadContextEvalCorpus();

function provider(execute: (request: AiRequest) => Promise<string>): AiProvider {
  return {
    id: 'fake',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }, { capability: Capability.GENERAL_CHAT, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request: AiRequest) => ({ text: await execute(request), artifacts: [] }),
  } as unknown as AiProvider;
}

/** A run that makes one selection call per scenario and scores every scenario as passed, or the given failures. */
function scriptedRun(options: { hardFailureIn?: string; failCalls?: boolean; softFailureIn?: { readonly id: string; readonly run: number } } = {}) {
  return async (input: RunInput): Promise<ScenarioRecord[]> => {
    const records: ScenarioRecord[] = [];
    for (let run = 1; run <= input.runs; run += 1) {
      for (const id of input.scenarioIds) {
        const scenario = input.corpus.scenarios.find((entry) => entry.id === id) as ContextEvalCorpus['scenarios'][number];
        if (input.selection.kind === 'real') await input.selection.provider.execute({ capability: Capability.INTENT_SELECTION, prompt: 'p' }).catch(() => undefined);
        const hard = id === options.hardFailureIn;
        const soft = options.softFailureIn !== undefined && options.softFailureIn.id === id && options.softFailureIn.run === run;
        const turns = scenario.turns.map((_, index) => ({ turn: index + 1, checks: [{ name: hard ? 'wrong-write' : 'chat', pass: !hard && !soft, hard }], pass: !hard && !soft }));
        records.push({ run, score: scoreScenario(scenario, turns, 'full'), turns: [] });
        input.onScenario?.(records.at(-1) as ScenarioRecord);
      }
    }
    return records;
  };
}

function deps(overrides: Partial<ContextEvalDeps> = {}): ContextEvalDeps & { out: string[]; err: string[]; reports: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const reports: string[] = [];
  return {
    out,
    err,
    reports,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => '2026-10-26T00:00:00.000Z',
    gitHead: () => 'test-head',
    loadCorpus: () => ({ corpus, sha256 }),
    writeReport: (name, contents) => {
      reports.push(contents);
      return `/tmp/${name}`;
    },
    createSelectionProvider: vi.fn(() => provider(async () => '{"entryId":"none","args":{},"ambiguity":"CLEAR","alternatives":[]}')),
    createChatProvider: vi.fn(() => provider(async () => 'chat')),
    canary: async () => true,
    runScenarios: scriptedRun(),
    ...overrides,
  };
}

const digestOf = (lines: readonly string[]): string => (lines.find((line) => line.startsWith('plan digest')) as string).split(': ')[1] as string;

describe('context eval CLI — arguments', () => {
  it('parses the three modes and refuses mixed options', () => {
    expect(parseArguments(['--mode', 'plan']).mode).toBe('plan');
    expect(parseArguments(['--', '--mode', 'dry', '--selector', 'none']).mode).toBe('dry');
    expect(parseArguments([]).mode).toBe('help');
    expect(() => parseArguments(['--mode', 'run'])).toThrow('run requires --approved-plan-digest');
    expect(() => parseArguments(['--mode', 'plan', '--approved-plan-digest', 'x'])).toThrow('--approved-plan-digest is only for run');
    expect(() => parseArguments(['--mode', 'plan', '--selector', 'oracle'])).toThrow('--selector is only for dry');
    expect(() => parseArguments(['--mode', 'dry', '--model', 'haiku'])).toThrow('--model is not an option of --mode dry');
    expect(() => parseArguments(['--mode', 'plan', '--profile', 'live'])).toThrow('--profile must be');
    expect(() => parseArguments(['--mode', 'plan', '--chat-model', 'sonnet'])).toThrow('--chat-model needs --chat real');
    expect(() => parseArguments(['--mode', 'plan', '--bogus', '1'])).toThrow('unknown option --bogus');
  });

  it('the incapability vocabulary comes from Core’s catalog of the configured reads (GitHub and Confluence are not configured)', () => {
    const nouns = capabilityNouns();
    expect(nouns.sources).toEqual(expect.arrayContaining(['jira', '캘린더', '메일', '드라이브', '슬랙']));
    expect(nouns.lists).toEqual(expect.arrayContaining(['할 일', '알림']));
    expect([...nouns.sources, ...nouns.lists]).not.toContain('github');
    expect(CONTEXT_EVAL_CONFIGURED_READS).not.toContain('github.items');
  });
});

describe('context eval CLI — plan and the Strict boundary', () => {
  it('plan is offline: counts, plan, digest, caps and a cost estimate; nothing is constructed', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'plan', '--chat', 'real'], d)).toBe(EXIT_OK);
    expect(d.createSelectionProvider).not.toHaveBeenCalled();
    expect(d.createChatProvider).not.toHaveBeenCalled();
    expect(d.out.join('\n')).toMatch(/context eval corpus: \d+ scenarios, \d+ turns/u);
    expect(digestOf(d.out)).toMatch(/^[0-9a-f]{64}$/u);
    expect(d.out.join('\n')).toMatch(/at most \d+ selection call\(s\) \(haiku; one per scored turn plus up to 3 probes of chat-suggested commands per turn, owner decision D2\) and \d+ chat call\(s\)/u);
    expect(d.out.join('\n')).toContain('estimated cost at most');
  });

  it('run refuses a missing or different digest before any provider is constructed', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', 'f'.repeat(64)], d)).toBe(EXIT_BLOCKED);
    expect(d.createSelectionProvider).not.toHaveBeenCalled();
    expect(await runCli(['--mode', 'run'], deps())).toBe(EXIT_USAGE);
  });

  it('run with the approved digest scores every run and passes the gate (3 runs by default, owner decision 2026-10-27)', async () => {
    const plan = deps();
    await runCli(['--mode', 'plan', '--scenarios', 'fr-jira-keyword-count,lc-interview-questions'], plan);
    expect(plan.out.join('\n')).toContain('"runs": 3');
    const d = deps();
    expect(await runCli(['--mode', 'run', '--scenarios', 'fr-jira-keyword-count,lc-interview-questions', '--approved-plan-digest', digestOf(plan.out)], d)).toBe(EXIT_OK);
    // Owner decision of 2026-10-28 (cost study P0): the effort reaches the provider and is bound into the digest.
    // The default is the adapter's selection effort (high since the owner decision of 2026-10-28).
    const selectionDefault = DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY[Capability.INTENT_SELECTION] ?? 'low';
    expect(d.createSelectionProvider).toHaveBeenCalledWith('haiku', selectionDefault);
    expect(plan.out.join('\n')).toContain(`"selectionEffort": "${selectionDefault}"`);
    const medium = deps();
    await runCli(['--mode', 'plan', '--scenarios', 'fr-jira-keyword-count,lc-interview-questions', '--effort', 'medium'], medium);
    expect(digestOf(medium.out)).not.toBe(digestOf(plan.out));
    expect(await runCli(['--mode', 'plan', '--effort', 'turbo'], deps())).toBe(EXIT_USAGE);
    expect(d.out.join('\n')).toContain('context gate (3 runs; EACH run >= 95% scenarios, 0 hard failures, 0 harness errors): PASSED');
    expect(d.out.join('\n')).toContain('selection: 6 answered, 0 failed, 0 refused');
    expect(JSON.parse(d.reports[0] as string).plan.digest).toBe(digestOf(plan.out));
  });

  it('owner decision of 2026-10-28: the report records each selection call latency (ms, content-free) and its p50 / p95', async () => {
    const plan = deps();
    await runCli(['--mode', 'plan', '--scenarios', 'fr-jira-keyword-count,lc-interview-questions'], plan);
    // A stub clock that moves 7 ms per read: every call reads it twice, so each call takes 7 ms.
    let clock = 0;
    const d = deps({ elapsed: () => (clock += 7) });
    expect(await runCli(['--mode', 'run', '--scenarios', 'fr-jira-keyword-count,lc-interview-questions', '--approved-plan-digest', digestOf(plan.out)], d)).toBe(EXIT_OK);
    const latency = JSON.parse(d.reports[0] as string).selectionLatency;
    expect(latency).toMatchObject({ calls: 6, boundMs: 10_000, overBound: 0, timeouts: 0 });
    expect(latency.callsMs).toHaveLength(6);
    expect(latency.callsMs.every((call: { ms: number; outcome: string }) => Number.isInteger(call.ms) && call.outcome === 'ok')).toBe(true);
    expect(latency).toMatchObject({ p50: 7, p95: 7, max: 7 });
    expect(d.out.join('\n')).toMatch(/selection latency: p50 \d+ ms, p95 \d+ ms, max \d+ ms over 6 calls; 0 over the 10000 ms bound, 0 timeouts/);
  });

  it('owner decision 2026-10-27: the gate is per run, never pooled, and needs 3 runs', async () => {
    const scenarios = 'fr-jira-keyword-count,lc-interview-questions';
    // One scenario failing in run 2 only: 5 of 6 pooled (83%) and runs 1 and 3 at 100% — the gate fails on run 2 alone.
    const plan = deps();
    await runCli(['--mode', 'plan', '--scenarios', scenarios], plan);
    const d = deps({ runScenarios: scriptedRun({ softFailureIn: { id: 'lc-interview-questions', run: 2 } }) });
    expect(await runCli(['--mode', 'run', '--scenarios', scenarios, '--approved-plan-digest', digestOf(plan.out)], d)).toBe(EXIT_GATE_FAILED);
    expect(d.out.join('\n')).toContain('run 2: misses the per-run bar');
    expect(d.out.join('\n')).toContain('run 1: meets the per-run bar');
    // Two passing runs are not a gate.
    const two = deps();
    await runCli(['--mode', 'plan', '--scenarios', scenarios, '--runs', '2'], two);
    const short = deps();
    expect(await runCli(['--mode', 'run', '--scenarios', scenarios, '--runs', '2', '--approved-plan-digest', digestOf(two.out)], short)).toBe(EXIT_GATE_FAILED);
    expect(short.out.join('\n')).toContain('(the gate needs 3 runs; this plan has 2)');
  });

  it('a hard failure fails the gate', async () => {
    const plan = deps();
    await runCli(['--mode', 'plan', '--scenarios', 'fr-jira-keyword-count'], plan);
    const d = deps({ runScenarios: scriptedRun({ hardFailureIn: 'fr-jira-keyword-count' }) });
    expect(await runCli(['--mode', 'run', '--scenarios', 'fr-jira-keyword-count', '--approved-plan-digest', digestOf(plan.out)], d)).toBe(EXIT_GATE_FAILED);
    expect(d.out.join('\n')).toContain('FAILED');
  });

  it('a provider outage with no hard failure is INVALID (exit 5), never PASSED or FAILED', async () => {
    const plan = deps();
    await runCli(['--mode', 'plan'], plan);
    const down = provider(async () => {
      throw new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'limit');
    });
    const d = deps({ createSelectionProvider: vi.fn(() => down), canary: async () => 'provider-execution_failed' });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(plan.out)], d)).toBe(EXIT_INVALID);
    expect(d.out.join('\n')).toContain('INVALID (provider unavailable');
    expect(d.out.join('\n')).not.toContain('PASSED');
  });

  it('dry mode never constructs a provider and hands the runner the oracle or none selector', async () => {
    const seen: string[] = [];
    const d = deps({
      runScenarios: async (input) => {
        seen.push(input.selection.kind, String(input.runs), input.profile);
        return scriptedRun()(input);
      },
    });
    expect(await runCli(['--mode', 'dry', '--profile', 'actions-local', '--selector', 'none', '--scenarios', 'cy-project-yes'], d)).toBe(EXIT_OK);
    expect(seen).toEqual(['none', '1', 'actions-local']);
    expect(d.createSelectionProvider).not.toHaveBeenCalled();
    expect(JSON.parse(d.reports[0] as string)).toMatchObject({ mode: 'dry', selector: 'none', profile: 'actions-local' });
  });
});
