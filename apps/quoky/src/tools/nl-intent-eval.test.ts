import { describe, expect, it } from 'vitest';
import { Capability, NL_SELECTION_TIMEOUT_MS, type AiProvider, type AiRequest } from '@quoky/core';
import { buildPlan, computePlanDigest, loadCorpus, runEvaluation, scoreGrammarSide, scoreOutput, scoreSelectorSide, summarize, userVisibleMeaning, type NlEvalCase, type NlEvalCorpus } from './nl-intent-eval';
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
      { run: 1, id: 'c', expected: 'none', outcome: 'none' as const, latencyMs: 6500 },
    ];
    const passed = summarize(records);
    expect(passed).toMatchObject({ overall: 1, wrongCaptures: 0, gatePassed: true, latency: { p50: 300, p95: 6500, overRuntimeBound: 1 } });
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
    expect(buildPlan(CORPUS, 'sha', { ...base, timeoutMs: 8000 }).callTimeoutMs).toBe(8000);
    expect(buildPlan(CORPUS, 'sha', base).callTimeoutMs).toBe(NL_SELECTION_TIMEOUT_MS);
  });

  it('rejects a timeout outside 2000..8000 or not an integer', () => {
    for (const timeoutMs of [1999, 8001, 5.5, Number.NaN]) {
      expect(() => buildPlan(CORPUS, 'sha', { ...base, timeoutMs }), String(timeoutMs)).toThrow('timeoutMs must be an integer 2000..8000');
    }
  });

  it('counts over-bound calls against the plan value, not the constant', () => {
    const records = [
      { run: 1, id: 'a', expected: 'jira.issues', outcome: 'hit' as const, latencyMs: 3000 },
      { run: 1, id: 'b', expected: 'none', outcome: 'none' as const, latencyMs: 7000 },
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

describe('nl-intent evaluation CLI timeout flag (ADR-0120 A3)', () => {
  it('--timeout-ms sets the plan bound; an invalid flag is a usage error', () => {
    expect(planOptions({ '--timeout-ms': '5000' }, {}).timeoutMs).toBe(5000);
    expect(() => planOptions({ '--timeout-ms': '1999' }, {})).toThrow(/--timeout-ms/);
    expect(() => planOptions({ '--timeout-ms': 'abc' }, {})).toThrow(/--timeout-ms/);
  });

  it('falls back to a valid QUOKY_NL_INTENT_TIMEOUT_MS, ignores an invalid one, and the flag wins', () => {
    expect(planOptions({}, { QUOKY_NL_INTENT_TIMEOUT_MS: '3000' }).timeoutMs).toBe(3000);
    expect(planOptions({}, { QUOKY_NL_INTENT_TIMEOUT_MS: '8001' }).timeoutMs).toBeUndefined();
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
