import { describe, expect, it } from 'vitest';
import { Capability, type AiProvider, type AiRequest } from '@quoky/core';
import { buildPlan, computePlanDigest, runEvaluation, scoreOutput, summarize, type NlEvalCase, type NlEvalCorpus } from './nl-intent-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from './nl-intent-eval-cli';

// ADR-0120 D12 evaluation harness, offline: plan and digest, exact-match scoring after Core validation, the gate, and the
// Strict digest check that refuses a run before any provider is constructed. No process is spawned here.

const NOW = '2026-10-12T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}, ambiguity = 'CLEAR') =>
  JSON.stringify({ entryId, args, ambiguity, alternatives: [] });

const CASES: NlEvalCase[] = [
  { id: 'jira-1', text: '오늘 jira 이슈 등록된거 브리핑해줘', expect: { entryId: 'jira.issues', args: { window: 'created', range: 'today' } } },
  { id: 'jira-2', text: '그 중에 위클리카만', prior: { entryId: 'jira.issues', args: { window: 'created', range: 'today' } }, expect: { entryId: 'jira.issues', args: { window: 'created', range: 'today', keyword: '위클리카' } } },
  { id: 'cal-1', text: '내일 일정', expect: { entryId: 'calendar.events', args: { range: 'tomorrow' } } },
  { id: 'neg-1', text: '안녕', expect: 'none' },
  { id: 'neg-2', text: '지라 티켓 만들어줘', expect: 'none' },
];
const CORPUS: NlEvalCorpus = { version: 1, cases: CASES };

describe('nl-intent evaluation scoring (exact match after validation)', () => {
  it('scores hits, misses, clarifications, wrong captures and malformed output', () => {
    expect(scoreOutput(CASES[0]!, answer('jira.issues', { window: 'created', range: 'today' }), NOW).outcome).toBe('hit');
    expect(scoreOutput(CASES[0]!, answer('jira.issues', { window: 'created', range: 'yesterday' }), NOW).outcome).toBe('miss');
    expect(scoreOutput(CASES[1]!, answer('jira.issues', { window: 'created', range: 'today', keyword: '위클리카' }), NOW).outcome).toBe('hit');
    // A keyword the owner did not write is a clarification (validation fails), never a hit and never wrong.
    expect(scoreOutput(CASES[0]!, answer('jira.issues', { window: 'created', range: 'today', keyword: '결제' }), NOW).outcome).toBe('clarify');
    expect(scoreOutput(CASES[2]!, answer('calendar.events', { range: 'tomorrow' }, 'NEEDS_CLARIFICATION'), NOW).outcome).toBe('clarify');
    expect(scoreOutput(CASES[3]!, answer('none'), NOW).outcome).toBe('none');
    expect(scoreOutput(CASES[4]!, answer('jira.issues'), NOW).outcome).toBe('wrong-capture');
    expect(scoreOutput(CASES[4]!, 'I would create it', NOW).outcome).toBe('error');
  });

  it('summarizes per entry and applies the gate (95% overall, 90% per entry, 0 wrong captures)', () => {
    const records = [
      { run: 1, id: 'a', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 100 },
      { run: 1, id: 'b', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 300 },
      { run: 1, id: 'c', expected: 'none', outcome: 'none' as const, latencyMs: 4500 },
    ];
    const passed = summarize(records);
    expect(passed).toMatchObject({ overall: 1, wrongCaptures: 0, gatePassed: true, latency: { p50: 300, p95: 4500, overRuntimeBound: 1 } });
    expect(summarize([...records, { run: 1, id: 'd', expected: 'none', outcome: 'wrong-capture', latencyMs: 1 }]).gatePassed).toBe(false);
    expect(summarize([...records, { run: 1, id: 'e', expected: 'jira.issues', outcome: 'miss', latencyMs: 1 }]).gatePassed).toBe(false);
  });

  it('runs the real prompt through the injected provider, one INTENT_SELECTION call per case and run', async () => {
    const seen: AiRequest[] = [];
    const provider = {
      id: 'scripted',
      capabilities: [],
      isAvailable: async () => true,
      execute: async (request: AiRequest) => {
        seen.push(request);
        const owner = request.prompt.slice(request.prompt.lastIndexOf('<<<'));
        if (owner.includes('등록된거')) return { text: answer('jira.issues', { window: 'created', range: 'today' }) };
        if (owner.includes('위클리카')) return { text: answer('jira.issues', { window: 'created', range: 'today', keyword: '위클리카' }) };
        if (owner.includes('내일')) return { text: answer('calendar.events', { range: 'tomorrow' }) };
        return { text: answer('none') };
      },
    } as unknown as AiProvider;
    const plan = buildPlan(CORPUS, 'sha', { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 2, concurrency: 2 });
    const records = await runEvaluation({ corpus: CORPUS, plan, provider, now: () => NOW });
    expect(seen).toHaveLength(10);
    expect(seen.every((request) => request.capability === Capability.INTENT_SELECTION)).toBe(true);
    expect(seen.some((request) => request.prompt.includes('Previous selection: {"entryId":"jira.issues"'))).toBe(true);
    expect(summarize(records.filter((record) => record.run === 1))).toMatchObject({ hits: 3, positives: 3, wrongCaptures: 0, gatePassed: true });
  });
});

describe('nl-intent evaluation under the runtime bound', () => {
  it('calls with the 4 s bound and counts a slower answer as a timeout (a miss, never wrong)', async () => {
    const seen: number[] = [];
    const provider = {
      id: 'slow',
      capabilities: [],
      isAvailable: async () => true,
      execute: async (request: AiRequest) => {
        seen.push(request.timeoutMs ?? -1);
        return new Promise<{ text: string }>(() => undefined); // never answers
      },
    } as unknown as AiProvider;
    const corpus: NlEvalCorpus = { version: 1, cases: [CASES[2]!, CASES[3]!] };
    const plan = { ...buildPlan(corpus, 'sha', { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 1, concurrency: 2 }), callTimeoutMs: 20 };
    const records = await runEvaluation({ corpus, plan, provider, now: () => NOW });
    expect(seen).toEqual([20, 20]);
    expect(records.map((record) => record.outcome)).toEqual(['timeout', 'timeout']);
    expect(summarize(records)).toMatchObject({ timeouts: 2, hits: 0, wrongCaptures: 0, gatePassed: false });
    expect(buildPlan(CORPUS, 'sha', { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 1, concurrency: 1 }).callTimeoutMs).toBe(4000);
  });
});

describe('nl-intent evaluation CLI (Strict digest gate)', () => {
  function deps(created: string[]): CliDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => NOW,
      loadCorpus: () => ({ corpus: CORPUS, sha256: 'corpus-sha' }),
      writeReport: (name) => `/tmp/${name}`,
      createProvider: (model) => {
        created.push(model);
        return {
          id: 'scripted',
          capabilities: [],
          isAvailable: async () => true,
          execute: async () => ({ text: answer('none') }),
        } as unknown as AiProvider;
      },
    };
  }

  it('plan is offline and prints the digest; run refuses a missing or wrong digest before constructing a provider', async () => {
    const created: string[] = [];
    const planned = deps(created);
    expect(await runCli(['--mode', 'plan', '--per-entry', '1'], planned)).toBe(EXIT_OK);
    const digest = /plan digest \(sha256\): ([0-9a-f]{64})/.exec(planned.out.join('\n'))?.[1];
    expect(digest).toBe(computePlanDigest(buildPlan(CORPUS, 'corpus-sha', { model: 'haiku', entries: [], includeNegatives: true, perEntry: 1, runs: 1, concurrency: 4 })));
    expect(await runCli(['--mode', 'run', '--per-entry', '1'], deps(created))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'run', '--per-entry', '1', '--approved-plan-digest', 'f'.repeat(64)], deps(created))).toBe(EXIT_BLOCKED);
    expect(await runCli(['--mode', 'run', '--per-entry', '2', '--approved-plan-digest', digest as string], deps(created))).toBe(EXIT_BLOCKED);
    expect(created).toEqual([]);
    // The matching digest runs (here every answer is `none`, so the positives miss and the gate fails).
    expect(await runCli(['--mode', 'run', '--per-entry', '1', '--approved-plan-digest', digest as string], deps(created))).toBe(EXIT_GATE_FAILED);
    expect(created).toEqual(['haiku']);
  });

  it('rejects unknown options, entries and out-of-range numbers', async () => {
    expect(await runCli(['--mode', 'plan', '--jql', 'x'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--entries', 'notion.pages'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--runs', '9'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--model', '--x'], deps([]))).toBe(EXIT_USAGE);
  });
});
