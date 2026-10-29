import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY } from '@quoky/ai-cli';
import { Capability, NL_SELECTION_TIMEOUT_MS, type AiProvider, type AiRequest } from '@quoky/core';
import { loadReadRegressionCorpus, loadScoredReadRegressionCorpus, readRegressionPrompt, scoreReadRegression } from './nl-action-eval';
import { NL_EVAL_CONTEXT_CORPUS_PATH, buildPlan, computePlanDigest, loadCorpus, loadScoredCorpus, runEvaluation, scoreGrammarSide, scoreOutput, scoreSelectorSide, summarize, userVisibleMeaning, type NlEvalCase, type NlEvalCorpus } from './nl-intent-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_OK, EXIT_USAGE, formatSummary, planOptions, runCli, type CliDeps } from './nl-intent-eval-cli';

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

  it('the shown listing repeated for a pointed content request scores as the runtime answers it, `none` (uat5r6-07)', () => {
    const pointed: NlEvalCase = { id: 'uat5r6-07', text: '그거 요약해줘', prior: { entryId: 'mail.list', args: {} }, expect: 'none' };
    expect(scoreOutput(pointed, answer('mail.list'), NOW)).toMatchObject({ outcome: 'none', got: 'none' });
    const refresh: NlEvalCase = { id: 'refresh', text: '메일 다시 보여줘', prior: { entryId: 'mail.list', args: {} }, expect: { entryId: 'mail.list', args: {} } };
    expect(scoreOutput(refresh, answer('mail.list'), NOW).outcome).toBe('hit');
  });

  it('A7: a capture of a clear past-tense statement scores as the runtime answers it, `none`', () => {
    const statement: NlEvalCase = { id: 'neg-s', text: '어제 일정 있었는데 까먹었어 ㅠ', expect: 'none' };
    expect(scoreOutput(statement, answer('calendar.events', { range: 'yesterday' }), NOW)).toMatchObject({ outcome: 'none', got: 'none' });
    const positive: NlEvalCase = { id: 'pos-s', text: '회의 끝났다', expect: { entryId: 'calendar.events', args: {} } };
    expect(scoreOutput(positive, answer('calendar.events'), NOW)).toMatchObject({ outcome: 'miss', got: 'none' });
    // Message-level: an ambiguous output on a statement is chat too, not a clarification.
    expect(scoreOutput(statement, answer('calendar.events', { range: 'yesterday' }, 'NEEDS_CLARIFICATION'), NOW)).toMatchObject({ outcome: 'none' });
  });

  it("owner decision A (2026-10-22): Core's help-scope question is a clarification; a clarification gold asks, never captures", () => {
    // A general help about a named source is Core's question (its final outcome), on any case.
    const negative: NlEvalCase = { id: 'neg-q', text: 'what is Confluence?', expect: 'none' };
    expect(scoreOutput(negative, answer('help.topic'), NOW)).toMatchObject({ outcome: 'clarify', got: 'help.topic' });
    expect(scoreOutput(negative, answer('help.topic', { topic: 'work-lookup' }), NOW)).toMatchObject({ outcome: 'wrong-capture' });
    // A positive help gold with a feature topic is untouched.
    const positive: NlEvalCase = { id: 'help-q', text: '너 jira 볼 수 있어?', expect: { entryId: 'help.topic', args: { topic: 'work-lookup' } } };
    expect(scoreOutput(positive, answer('help.topic', { topic: 'work-lookup' }), NOW).outcome).toBe('hit');
    // The clarification gold: asked = clarify; CLEAR help.topic = miss (a reading the question offers), CLEAR none = none,
    // any other capture is still wrong.
    const gold: NlEvalCase = { id: 'neg-c', text: '슬랙에서 검색하는 방법 알려줘', expect: 'none', clarify: { between: ['help.topic'], batch: 'test' } };
    expect(scoreOutput(gold, answer('help.topic'), NOW).outcome).toBe('clarify');
    expect(scoreOutput(gold, answer('help.topic', { topic: 'work-lookup' }), NOW).outcome).toBe('miss');
    expect(scoreOutput(gold, answer('help.topic', { topic: 'work-lookup' }, 'NEEDS_CLARIFICATION'), NOW).outcome).toBe('clarify');
    expect(scoreOutput(gold, answer('none'), NOW).outcome).toBe('none');
    expect(scoreOutput(gold, answer('slack.search', { keyword: '검색하는 방법' }), NOW).outcome).not.toBe('miss');
    const records = [
      { run: 1, id: 'neg-c', expected: 'none', outcome: 'clarify' as const, latencyMs: 1 },
      { run: 1, id: 'neg-1', expected: 'none', outcome: 'none' as const, latencyMs: 1 },
    ];
    expect(summarize(records, undefined, undefined, new Set(['neg-c']))).toMatchObject({ clarifyGolds: { total: 1, asked: 1 }, wrongCaptures: 0, gatePassed: true });
    expect(summarize([{ ...records[0]!, outcome: 'miss' as const }], undefined, undefined, new Set(['neg-c']))).toMatchObject({ clarifyGolds: { total: 1, asked: 0 }, wrongCaptures: 0, gatePassed: true });
  });

  it('owner decision 2026-10-22: help.topic captures are counted apart, within ceil(1% of the negatives); others stay at 0', () => {
    const negatives = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ run: 1, id: `n${from + index}`, expected: 'none', outcome: 'none' as const, latencyMs: 1 }));
    const help = (id: string) => ({ run: 1, id, expected: 'none', outcome: 'wrong-capture' as const, got: 'help.topic', latencyMs: 1 });
    const positive = { run: 1, id: 'p', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 1 };
    // 199 negatives allow 2 (ceil(1.99)); 2 help captures pass, 3 fail.
    const within = summarize([positive, ...negatives(197), help('h1'), help('h2')]);
    expect(within).toMatchObject({ negatives: 199, helpCaptures: 2, helpAllowance: 2, wrongCaptures: 0, gatePassed: true });
    expect(formatSummary(within).join('\n')).toContain('help captures: 2 (allowed 2 = ceil(1% of 199))');
    expect(summarize([positive, ...negatives(196), help('h1'), help('h2'), help('h3')])).toMatchObject({ helpCaptures: 3, helpAllowance: 2, gatePassed: false });
    // A data-read wrong capture still fails with no help capture at all.
    const data = summarize([positive, ...negatives(198), { run: 1, id: 'w', expected: 'none', outcome: 'wrong-capture' as const, got: 'jira.issues', latencyMs: 1 }]);
    expect(data).toMatchObject({ helpCaptures: 0, wrongCaptures: 1, gatePassed: false });
  });

  it('counts the records whose ungrounded value Core set back (names only), reported and not gated', () => {
    const records = [
      { run: 1, id: 'a8-10', expected: 'jira.release', outcome: 'hit' as const, latencyMs: 1, defaulted: ['scope'] },
      { run: 1, id: 'a8-03', expected: 'jira.release', outcome: 'hit' as const, latencyMs: 1 },
    ];
    const summary = summarize(records);
    expect(summary).toMatchObject({ defaulted: 1, gatePassed: true });
    expect(formatSummary(summary)).toContain('ungrounded values set back to the previous value or default: 1 (reported, not gated)');
    expect(formatSummary(summarize([records[1]!])).join('\n')).not.toContain('set back to the previous value');
    // The scorer reports the names on the record.
    const a810: NlEvalCase = { id: 'a8-10', text: '이번 1.4.0 릴리즈에 포함된 지라 티켓 다 보여줘', expect: { entryId: 'jira.release', args: { release: '1.4.0' } } };
    expect(scoreOutput(a810, answer('jira.release', { release: '1.4.0', scope: 'all' }), NOW)).toMatchObject({ outcome: 'hit', defaulted: ['scope'] });
  });

  it('the corpus marks neg-010 as the clarification gold between help.topic and none', () => {
    const golden = loadCorpus().corpus.cases.find((candidate) => candidate.id === 'neg-010');
    expect(golden).toMatchObject({ text: '슬랙에서 검색하는 방법 알려줘', expect: 'none', clarify: { between: ['help.topic'] } });
  });

  it('summarizes per entry and applies the gate (95% overall, 90% per entry, 0 wrong captures)', () => {
    const records = [
      { run: 1, id: 'a', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 100 },
      { run: 1, id: 'b', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 300 },
      { run: 1, id: 'c', expected: 'none', outcome: 'none' as const, latencyMs: 10500 },
    ];
    const passed = summarize(records);
    expect(passed).toMatchObject({ overall: 1, wrongCaptures: 0, gatePassed: true, latency: { p50: 300, p95: 10500, overRuntimeBound: 1 } });
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
  it('calls with the runtime selection bound and counts a slower answer as a timeout (a miss, never wrong)', async () => {
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
    expect(buildPlan(CORPUS, 'sha', { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 1, concurrency: 1 }).callTimeoutMs).toBe(NL_SELECTION_TIMEOUT_MS);
  });
});

describe('nl-intent evaluation timeout option (ADR-0120 A3)', () => {
  const base = { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 1, concurrency: 1 };

  it('the plan carries a custom callTimeoutMs and defaults to the runtime bound', () => {
    expect(buildPlan(CORPUS, 'sha', { ...base, timeoutMs: 5000 }).callTimeoutMs).toBe(5000);
    expect(buildPlan(CORPUS, 'sha', { ...base, timeoutMs: 10000 }).callTimeoutMs).toBe(10000);
    expect(buildPlan(CORPUS, 'sha', base).callTimeoutMs).toBe(NL_SELECTION_TIMEOUT_MS);
  });

  it('rejects a timeout outside 2000..10000 or not an integer (owner decision of 2026-10-28)', () => {
    for (const timeoutMs of [1999, 10001, 5.5, Number.NaN]) {
      expect(() => buildPlan(CORPUS, 'sha', { ...base, timeoutMs }), String(timeoutMs)).toThrow('timeoutMs must be an integer 2000..10000');
    }
  });

  it('counts over-bound calls against the plan value, not the constant', () => {
    const records = [
      { run: 1, id: 'a', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 3000 },
      { run: 1, id: 'b', expected: 'none', outcome: 'none' as const, latencyMs: 11000 },
    ];
    expect(summarize(records, 6000).latency).toMatchObject({ boundMs: 6000, overRuntimeBound: 1 });
    expect(summarize(records, 2000).latency).toMatchObject({ boundMs: 2000, overRuntimeBound: 2 });
    expect(summarize(records).latency).toMatchObject({ boundMs: NL_SELECTION_TIMEOUT_MS, overRuntimeBound: 1 });
  });

  it('S1: the over-bound share gates at 1%, and the grammar-handled subset reports its own hits and latency', () => {
    const records = Array.from({ length: 200 }, (_, index) => ({
      run: 1,
      id: `c${index}`,
      expected: 'jira.issues',
      outcome: index < 2 ? ('timeout' as const) : ('hit' as const),
      latencyMs: index < 2 ? 6001 : 1000 + index,
    }));
    const twoOver = summarize(records, 6000, new Set(['c0', 'c10', 'c20', 'c30']));
    expect(twoOver).toMatchObject({ overBoundRate: 0.01, gatePassed: true, s1GatePassed: true });
    expect(twoOver.grammarSubset).toEqual({
      cases: 4,
      positives: 4,
      hits: 3,
      overall: 0.75,
      wrongCaptures: 0,
      clarifications: 0,
      timeouts: 1,
      latency: { p50: 1020, p95: 6001, max: 6001 },
    });
    const threeOver = summarize([...records, { run: 1, id: 'x', expected: 'jira.issues', outcome: 'timeout' as const, latencyMs: 6002 }], 6000);
    expect(threeOver.overBoundRate).toBeGreaterThan(0.01);
    expect(threeOver).toMatchObject({ gatePassed: true, s1GatePassed: false });
    expect(threeOver.grammarSubset).toBeUndefined();
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
    // Owner decision of 2026-10-28: the default selector effort is the adapter's, now high.
    expect(digest).toBe(computePlanDigest(buildPlan(CORPUS, 'corpus-sha', { model: 'haiku', effort: DEFAULT_CLAUDE_EFFORT_BY_CAPABILITY[Capability.INTENT_SELECTION] ?? 'low', entries: [], includeNegatives: true, perEntry: 1, runs: 1, concurrency: 4 })));
    // Owner decision of 2026-10-28 (cost study P0): --effort is bound into the digest, and an unknown level is a usage error.
    const medium = deps(created);
    expect(await runCli(['--mode', 'plan', '--per-entry', '1', '--effort', 'medium'], medium)).toBe(EXIT_OK);
    expect(/plan digest \(sha256\): ([0-9a-f]{64})/.exec(medium.out.join('\n'))?.[1]).toBe(computePlanDigest(buildPlan(CORPUS, 'corpus-sha', { model: 'haiku', effort: 'medium', entries: [], includeNegatives: true, perEntry: 1, runs: 1, concurrency: 4 })));
    expect(await runCli(['--mode', 'plan', '--effort', 'turbo'], deps(created))).toBe(EXIT_USAGE);
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

describe('nl-intent evaluation CLI timeout flag (ADR-0120 A3)', () => {
  it('--timeout-ms sets the plan bound; an invalid flag is a usage error', () => {
    expect(planOptions({ '--timeout-ms': '5000' }, {}).timeoutMs).toBe(5000);
    expect(() => planOptions({ '--timeout-ms': '1999' }, {})).toThrow(/--timeout-ms/);
    expect(() => planOptions({ '--timeout-ms': 'abc' }, {})).toThrow(/--timeout-ms/);
  });

  it('falls back to a valid QUOKY_NL_INTENT_TIMEOUT_MS, ignores an invalid one, and the flag wins', () => {
    expect(planOptions({}, { QUOKY_NL_INTENT_TIMEOUT_MS: '3000' }).timeoutMs).toBe(3000);
    expect(planOptions({}, { QUOKY_NL_INTENT_TIMEOUT_MS: '10001' }).timeoutMs).toBeUndefined();
    expect(planOptions({ '--timeout-ms': '4000' }, { QUOKY_NL_INTENT_TIMEOUT_MS: '3000' }).timeoutMs).toBe(4000);
    expect(planOptions({}, {}).timeoutMs).toBeUndefined();
  });
});

describe('S1 fair evidence — grammar side vs selector side on the grammar-handled cases', () => {
  const NOW = '2026-10-13T06:00:00.000Z';
  const cases: NlEvalCase[] = [
    { id: 'g1', text: '금요일 일정 뭐야?', expect: { entryId: 'calendar.events', args: { range: 'fri' } }, grammar: 'calendar-question', grammarAnswer: { entryId: 'calendar.events', args: { range: '10-16' } } },
    { id: 'g2', text: '컨플루언스에서 온보딩 문서 검색해줘', expect: { entryId: 'confluence.search', args: { keyword: '온보딩' } }, grammar: 'work-lookup.search', grammarAnswer: { entryId: 'confluence.search', args: { keyword: '온보딩 문서' } } },
    { id: 'g3', text: '드라이브에서 엑셀 파일 보여줘', expect: { entryId: 'drive.files', args: { kind: 'spreadsheet' } }, grammar: 'drive-question.list', grammarAnswer: { entryId: 'drive.files', args: { name: '엑셀' } } },
    { id: 'g4', text: '할 일 관리하는 좋은 습관 알려줘', expect: 'none', grammar: 'work-lookup.todo-list', grammarAnswer: { entryId: 'todo.list', args: {} } },
    { id: 'n1', text: '오늘 날씨', expect: 'none' },
  ];
  const corpus: NlEvalCorpus = { version: 1, cases };

  it('scores exact, entry and user-visible correctness, and counts a grammar capture of a negative', () => {
    expect(scoreGrammarSide(corpus, NOW)).toEqual({ positives: 3, exact: 0, entry: 3, userVisible: 2, wrongCaptures: 1 });
    expect(userVisibleMeaning({ entryId: 'calendar.events', args: { range: '10-16' } }, NOW)).toBe(userVisibleMeaning({ entryId: 'calendar.events', args: { range: 'fri' } }, NOW));
  });

  it('scores the selector on the same cases from a run\'s records (a clarification answers nothing)', () => {
    const records = [
      { run: 1, id: 'g1', expected: 'calendar.events', outcome: 'hit' as const, got: 'calendar.events', gotArgs: { range: 'fri' }, latencyMs: 1 },
      { run: 1, id: 'g2', expected: 'confluence.search', outcome: 'clarify' as const, got: 'confluence.search', latencyMs: 1 },
      { run: 1, id: 'g3', expected: 'drive.files', outcome: 'hit' as const, got: 'drive.files', gotArgs: { kind: 'spreadsheet' }, latencyMs: 1 },
      { run: 1, id: 'g4', expected: 'none', outcome: 'none' as const, got: 'none', latencyMs: 1 },
    ];
    expect(scoreSelectorSide(corpus, records, NOW)).toEqual({ positives: 3, exact: 2, entry: 2, userVisible: 2, wrongCaptures: 0 });
  });

  it('the committed corpus: every grammar-tagged case records the grammar answer (249), and the grammar side is reproducible', () => {
    const { corpus: real } = loadCorpus();
    const tagged = real.cases.filter((golden) => golden.grammar !== undefined);
    // ADR-0120 A2 implementation note 2 (2026-10-14): 8 cases a grammar used to answer while dropping part of the message
    // (a part of day, a swallowed search clause) are no longer grammar hits; 4 to-do substring captures and one live
    // sentence are now the surface clause's (`work-surface`: selection first, the surface as the fallback); help-038 is the
    // help grammar's; 4 plain phrases were added. The rate changes come from cases leaving or joining the denominator.
    // A5 implementation note 3: uat5ca-01/02 are calendar-grammar hits (the grammar answers a date, the gold a weekday).
    expect(tagged).toHaveLength(249);
    expect(tagged.every((golden) => golden.grammarAnswer !== undefined)).toBe(true);
    // `work-surface` has no catalog equivalent (the Jira/GitHub surface is not the to-do list), so its answer is null.
    // The owner's D12 batch of 2026-10-15 relabelled calendar-008/-020/-025 (timedOnly), which the calendar grammar answers
    // without the flag: exact 209 → 208, user-visible 229 → 226. The T1 extension of the same day (calendar-005, -016,
    // -018, -029, -032, -034, -057 gain timedOnly; five are grammar-tagged) moves exact 208 → 204 (-016, -029, -032, -034;
    // -018 was already not exact) and user-visible 226 → 221. The owner's relabel of 2026-10-21 (the item type `kind` on 29
    // one-step cases) moves exact 204 → 193 and user-visible 221 → 210: eleven are grammar-tagged and the frozen my-items grammar answers both types.
    expect(scoreGrammarSide(real, NOW)).toEqual({ positives: 248, exact: 193, entry: 243, userVisible: 210, wrongCaptures: 0 });
  });
});

describe('D4 moves to the next merge (owner decision of 2026-10-27): its golds wait for the dedicated classifier', () => {
  it('the 34 ctx-d4 cases are pending with their owner approvals, none is scored, and no scored case carries an open question', () => {
    const pendingPath = new URL('../../../../packages/core/src/application/golden/nl-intent.context-d4-pending.v1.json', import.meta.url).pathname;
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as { cases: Array<{ id: string; note?: string; openQuestion?: unknown }> };
    expect(pending.cases).toHaveLength(34);
    expect(pending.cases.every((golden) => /^ctx-d4-0\d\d$/.test(golden.id) && golden.note?.includes('owner-approved') === true && golden.openQuestion !== undefined)).toBe(true);
    const scored = loadScoredCorpus().corpus.cases;
    expect(scored.filter((golden) => golden.id.startsWith('ctx-d4-'))).toEqual([]);
    expect(scored.filter((golden) => 'openQuestion' in golden || 'expectAnswer' in golden)).toEqual([]);
    expect(loadScoredReadRegressionCorpus().cases.filter((golden) => golden.id.startsWith('ctx-d4-'))).toEqual([]);
  });
});

describe('owner decision P-time (ii) in the scorers (Core\'s final outcome)', () => {
  it('a calendar output without a range after a held calendar listing scores with the held range; an explicit period wins', () => {
    const golden: NlEvalCase = { id: 'pt-1', text: '그 세미나 어디서 해?', prior: { entryId: 'todo.list', args: {}, earlier: [{ entryId: 'calendar.events', args: { range: 'next-week' }, turns: 1 }] }, expect: { entryId: 'calendar.events', args: { range: 'next-week', keyword: '세미나' } } };
    expect(scoreOutput(golden, answer('calendar.events', { keyword: '세미나' }), NOW).outcome).toBe('hit');
    const explicit: NlEvalCase = { id: 'pt-2', text: '오늘 세미나 어디서 해?', prior: { entryId: 'calendar.events', args: { range: 'next-week' } }, expect: { entryId: 'calendar.events', args: { keyword: '세미나' } } };
    expect(scoreOutput(explicit, answer('calendar.events', { keyword: '세미나' }), NOW).outcome).toBe('hit');
    const regression = { id: 'pt-3', text: golden.text, prior: golden.prior, expect: golden.expect } as never;
    expect(scoreReadRegression(regression, answer('calendar.events', { keyword: '세미나' }), NOW).outcome).toBe('hit');
  });
});

describe('a8-25 (2026-10-27): a link-only message is Core\'s jira.release in both scorers, whatever the selector said', () => {
  it('scores the link-only gold as a hit even when the selector answered none', () => {
    const golden: NlEvalCase = { id: 'link-1', text: 'https://example.atlassian.net/browse/OP26/fixforversion/16555', expect: { entryId: 'jira.release', args: {} } };
    expect(scoreOutput(golden, answer('none'), NOW).outcome).toBe('hit');
    expect(scoreReadRegression(golden as never, answer('none'), NOW).outcome).toBe('hit');
    expect(scoreOutput({ ...golden, text: `${golden.text} 이거 뭐야` }, answer('none'), NOW).outcome).toBe('miss');
  });
});

describe('owner decision of 2026-10-27: the one-step timedOnly rule in both scorers (Core\'s final outcome)', () => {
  it('a meeting question without the flag scores as the runtime completes it; "일정" keeps the whole calendar', () => {
    const meeting: NlEvalCase = { id: 'to-1', text: '지난주에 무슨 회의 있었지?', expect: { entryId: 'calendar.events', args: { range: 'last-week', timedOnly: true } } };
    expect(scoreOutput(meeting, answer('calendar.events', { range: 'last-week' }), NOW).outcome).toBe('hit');
    expect(scoreReadRegression(meeting as never, answer('calendar.events', { range: 'last-week' }), NOW).outcome).toBe('hit');
    const whole: NlEvalCase = { id: 'to-2', text: '이번 주 회의랑 연차 일정 보여줘', expect: { entryId: 'calendar.events', args: { range: 'this-week' } } };
    expect(scoreOutput(whole, answer('calendar.events', { range: 'this-week' }), NOW).outcome).toBe('hit');
  });
});

describe('the supplemental context corpus (nl-intent.context.v1.json; owner decision (가) option 1, 2026-10-27)', () => {
  it('is scored by eval:nl and read-regression with nl-intent.v1.json, never by Q11; both files are bound in the corpus digest', () => {
    const main = loadCorpus();
    const context = loadCorpus(NL_EVAL_CONTEXT_CORPUS_PATH);
    const scored = loadScoredCorpus();
    expect(scored.corpus.cases.map((golden) => golden.id)).toEqual([...main.corpus.cases, ...context.corpus.cases].map((golden) => golden.id));
    expect(scored.sha256).not.toBe(main.sha256);
    expect(loadScoredReadRegressionCorpus().cases.map((golden) => golden.id)).toEqual(scored.corpus.cases.map((golden) => golden.id));
    expect(loadScoredReadRegressionCorpus().sha256).toBe(scored.sha256);
    // The default plan covers the 46 context cases (the gate counts them).
    const plan = buildPlan(scored.corpus, scored.sha256, { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 3, concurrency: 2 });
    expect(context.corpus.cases.every((golden) => plan.caseIds.includes(golden.id))).toBe(true);
    // Q11 auto-includes nl-intent.v1.json only.
    expect(main.corpus.cases.some((golden) => golden.id.startsWith('ctx-'))).toBe(false);
  });

  it('render the chat-turn age and the earlier selections, never an open question, and every gold is reachable after Core validation (eval:nl and read-regression)', async () => {
    const { corpus } = loadCorpus(NL_EVAL_CONTEXT_CORPUS_PATH);
    expect(corpus.cases).toHaveLength(12);
    expect(corpus.cases.every((golden) => golden.note?.includes('owner-approved') === true)).toBe(true);
    expect(corpus.cases.find((golden) => golden.id === 'ctx-d1-005')).toMatchObject({ text: '주말에 뭐 하면 좋을까?', expect: 'none', prior: { entryId: 'calendar.events', args: { range: 'today' }, turns: 1 } });
    const byText = new Map(corpus.cases.map((golden) => [golden.text, golden] as const));
    const seen: string[] = [];
    const provider = {
      id: 'scripted',
      capabilities: [Capability.INTENT_SELECTION],
      isAvailable: async () => true,
      execute: async (request: AiRequest) => {
        seen.push(request.prompt);
        const message = /<<<\n([\s\S]*)\n>>>$/.exec(request.prompt)?.[1] ?? '';
        const golden = byText.get(message);
        return { text: golden === undefined || golden.expect === 'none' ? answer('none') : answer(golden.expect.entryId, golden.expect.args), artifacts: [] };
      },
    } as unknown as AiProvider;
    const plan = buildPlan(corpus, 'sha', { model: 'haiku', entries: [], includeNegatives: true, perEntry: 0, runs: 1, concurrency: 1 });
    const records = await runEvaluation({ corpus, plan, provider, now: () => NOW });
    expect(records.filter((record) => record.outcome !== 'hit' && record.outcome !== 'none')).toEqual([]);
    expect(seen.some((prompt) => prompt.includes('(shown 2 turns ago; only chat replies since)'))).toBe(true);
    expect(seen.some((prompt) => prompt.includes('\nEarlier selections (newest first): {"entryId":"calendar.events","args":{"range":"next-week"}} (shown 1 turn ago)\n'))).toBe(true);
    expect(seen.some((prompt) => prompt.includes('Open question'))).toBe(false);
    // The router's output contract has no `answer` any more: an output with one is malformed (D4 is the classifier's).
    const plain = corpus.cases.find((golden) => golden.expect === 'none') as NlEvalCase;
    expect(scoreOutput(plain, JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [], answer: 1 }), NOW).outcome).toBe('error');
    // read-regression (A6 entries offered) renders and scores the same cases the same way.
    const regression = loadReadRegressionCorpus(NL_EVAL_CONTEXT_CORPUS_PATH).cases;
    expect(regression).toHaveLength(12);
    for (const golden of regression) {
      const prompt = readRegressionPrompt(golden, NOW as never) ?? '';
      if (golden.prior?.turns !== undefined) expect(prompt, golden.id).toContain('only chat replies since)');
      if (golden.prior?.earlier !== undefined) expect(prompt, golden.id).toContain('\nEarlier selections (newest first): ');
      expect(prompt, golden.id).not.toContain('Open question');
      const raw = golden.expect === 'none' ? answer('none') : answer(golden.expect.entryId, golden.expect.args);
      expect(['hit', 'none'], golden.id).toContain(scoreReadRegression(golden, raw, NOW).outcome);
    }
  });
});
