import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Capability, buildHelpScopeClassifierPrompt, renderHelpScopeOptions, type AiProvider, type AiRequest } from '@quoky/core';
import { NL_HELP_SCOPE_EVAL_GATE, buildHelpScopePlan, computeHelpScopePlanDigest, helpScopeCasePrompt, helpScopeExpected, loadHelpScopeCorpus, runHelpScopeEvaluation, scoreHelpScopeAnswer, summarizeHelpScope, validateHelpScopeCorpus, type NlHelpScopeCase, type NlHelpScopeRecord } from './nl-help-scope-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from './nl-intent-eval-cli';

// D4 `eval:nl --mode help-scope` offline: the corpus, the plan and its Strict digest, the scoring and the per-run /
// multi-run gate (owner decision of 2026-11-02: 0 wrong captures on non-answers, answer accuracy >= 95%, 0 harness
// errors, every run). Fake providers only; nothing is spawned.

const NOW = '2026-11-02T03:00:00.000Z';
const { corpus, sha256 } = loadHelpScopeCorpus();
const ids = corpus.cases.map((golden) => golden.id);
const answers = corpus.cases.filter((golden) => golden.expectAnswer !== undefined);
const nonAnswers = corpus.cases.filter((golden) => golden.expectAnswer === undefined);

type Reading = '{"answer":1}' | '{"answer":2}' | '{"answer":null}' | string;

/** A classifier that reads each case by its gold unless `override` says otherwise. */
function scriptedProvider(override: (golden: NlHelpScopeCase) => Reading | Error | undefined = () => undefined): AiProvider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    id: 'scripted-help-scope',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => {
      calls.push(request);
      const golden = corpus.cases.find((candidate) => request.prompt === helpScopeCasePrompt(candidate)) as NlHelpScopeCase;
      const forced = override(golden);
      if (forced instanceof Error) throw forced;
      const text = forced ?? (golden.expectAnswer === undefined ? '{"answer":null}' : `{"answer":${golden.expectAnswer}}`);
      return { text, artifacts: [] };
    },
  };
}

function deps(provider: () => AiProvider = () => scriptedProvider()): CliDeps & { out: string[]; err: string[]; written: Array<{ name: string; contents: string }>; created: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const written: Array<{ name: string; contents: string }> = [];
  const created: string[] = [];
  return {
    out,
    err,
    written,
    created,
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    now: () => NOW,
    loadCorpus: () => {
      throw new Error('not used');
    },
    writeReport: (name, contents) => {
      written.push({ name, contents });
      return `/reports/${name}`;
    },
    createProvider: (model) => {
      created.push(model);
      return provider();
    },
  };
}

const digestOf = (out: readonly string[]): string => /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] ?? '';

async function strictRun(provider: () => AiProvider, runs = 1): Promise<{ code: number; d: ReturnType<typeof deps> }> {
  const planned = deps();
  await runCli(['--mode', 'help-scope', '--runs', String(runs)], planned);
  const d = deps(provider);
  const code = await runCli(['--mode', 'help-scope', '--runs', String(runs), '--approved-plan-digest', digestOf(planned.out)], d);
  return { code, d };
}

describe('the help-scope corpus', () => {
  it('is the 55 owner-approved cases: 26 answers (13 -> 1, 13 -> 2) and 29 non-answers, schema-valid', () => {
    expect(corpus.cases).toHaveLength(55);
    expect(answers.filter((golden) => golden.expectAnswer === 1)).toHaveLength(13);
    expect(answers.filter((golden) => golden.expectAnswer === 2)).toHaveLength(13);
    expect(nonAnswers).toHaveLength(29);
    expect(validateHelpScopeCorpus(corpus)).toEqual([]);
    expect(corpus.cases.every((golden) => /^(ctx-d4|hs-na)-0\d\d$/.test(golden.id) && golden.note?.includes('owner-approved') === true)).toBe(true);
    // Owner decision of 2026-11-02 ("18번 빼고 21건 승인"): the 21 drafted non-answers joined, hs-na-018 did not.
    expect(corpus.cases.filter((golden) => golden.id.startsWith('hs-na-'))).toHaveLength(21);
    expect(corpus.cases.some((golden) => golden.id === 'hs-na-018')).toBe(false);
  });

  it('the validator names a malformed case', () => {
    const bad = { version: 1, cases: [{ id: 'a', text: '', openQuestion: { sources: [], language: 'fr' }, expectAnswer: 3 }, { id: 'a', text: 'x', openQuestion: { sources: 'Slack', language: 'en' }, extra: 1 }] } as unknown as typeof corpus;
    const problems = validateHelpScopeCorpus(bad);
    expect(problems.join('\n')).toMatch(/missing text/);
    expect(problems.join('\n')).toMatch(/openQuestion.sources/);
    expect(problems.join('\n')).toMatch(/language/);
    expect(problems.join('\n')).toMatch(/expectAnswer/);
    expect(problems.join('\n')).toMatch(/duplicate id/);
    expect(problems.join('\n')).toMatch(/unknown key extra/);
  });

  it('builds the real prompt from the rendered options and the case text', () => {
    const golden = corpus.cases.find((candidate) => candidate.id === 'ctx-d4-004') as NlHelpScopeCase;
    expect(helpScopeCasePrompt(golden)).toBe(buildHelpScopeClassifierPrompt({ options: renderHelpScopeOptions(['구글 캘린더', '지메일'], 'ko'), reply: golden.text, language: 'ko' }));
    expect(helpScopeCasePrompt(golden)).toContain('Quoky로 구글 캘린더·지메일 조회·연결하는 방법');
  });
});

describe('scoring and the gate (owner decision of 2026-11-02)', () => {
  it('scores an answer by the number, a non-answer by neither; a non-answer read as 1 or 2 is a wrong capture; malformed is a miss, never a wrong capture', () => {
    expect(scoreHelpScopeAnswer('1', 1)).toEqual({ outcome: 'hit', got: '1' });
    expect(scoreHelpScopeAnswer('2', 1)).toEqual({ outcome: 'miss', got: '1' });
    expect(scoreHelpScopeAnswer('2', 'neither')).toEqual({ outcome: 'miss', got: 'neither' });
    expect(scoreHelpScopeAnswer('neither', 'neither')).toEqual({ outcome: 'hit', got: 'neither' });
    expect(scoreHelpScopeAnswer('neither', 1)).toEqual({ outcome: 'wrong-capture', got: '1' });
    expect(scoreHelpScopeAnswer('neither', 2)).toEqual({ outcome: 'wrong-capture', got: '2' });
    expect(scoreHelpScopeAnswer('neither', undefined)).toEqual({ outcome: 'malformed' });
    expect(scoreHelpScopeAnswer('1', undefined)).toEqual({ outcome: 'malformed' });
    expect(helpScopeExpected({})).toBe('neither');
    expect(helpScopeExpected({ expectAnswer: 2 })).toBe('2');
  });

  const run = (change: (record: NlHelpScopeRecord, golden: NlHelpScopeCase) => Partial<NlHelpScopeRecord> | undefined = () => undefined): NlHelpScopeRecord[] =>
    corpus.cases.map((golden) => {
      const expected = helpScopeExpected(golden);
      return { run: 1, id: golden.id, expected, outcome: 'hit' as const, got: expected, latencyMs: 100, ...change({ run: 1, id: golden.id, expected, outcome: 'hit', latencyMs: 100 }, golden) };
    });

  it('a perfect run passes', () => {
    expect(summarizeHelpScope(run())).toMatchObject({ answers: { hits: 26, total: 26, rate: 1 }, nonAnswers: { hits: 29, total: 29 }, wrongCaptures: 0, errors: 0, gatePassed: true });
  });

  it('one wrong capture on a non-answer fails the run even with every answer right', () => {
    const records = run((_record, golden) => (golden.id === nonAnswers[0]?.id ? { outcome: 'wrong-capture', got: '1' } : undefined));
    expect(summarizeHelpScope(records)).toMatchObject({ wrongCaptures: 1, answers: { hits: 26, total: 26 }, gatePassed: false });
  });

  it('one miss in 26 answers passes (96.2%), two fail (92.3%)', () => {
    const miss = (count: number) => run((_record, golden) => (answers.slice(0, count).some((candidate) => candidate.id === golden.id) ? { outcome: 'miss', got: 'neither' } : undefined));
    expect(summarizeHelpScope(miss(1))).toMatchObject({ answers: { hits: 25, total: 26 }, gatePassed: true });
    expect(summarizeHelpScope(miss(2))).toMatchObject({ answers: { hits: 24, total: 26 }, gatePassed: false });
  });

  it('malformed and timeout on answers count as misses (not wrong captures); on non-answers they are neither a hit nor a wrong capture', () => {
    const summary = summarizeHelpScope(
      run((_record, golden) => {
        if (golden.id === answers[0]?.id) return { outcome: 'malformed' };
        if (golden.id === answers[1]?.id) return { outcome: 'timeout' };
        if (golden.id === nonAnswers[0]?.id) return { outcome: 'malformed' };
        if (golden.id === nonAnswers[1]?.id) return { outcome: 'timeout' };
        return undefined;
      }),
    );
    expect(summary).toMatchObject({ answers: { hits: 24, total: 26 }, nonAnswers: { hits: 27, total: 29 }, wrongCaptures: 0, malformed: 2, timeouts: 2, gatePassed: false });
    // One malformed non-answer and one timeout answer alone stay inside the bar.
    expect(summarizeHelpScope(run((_r, golden) => (golden.id === nonAnswers[0]?.id ? { outcome: 'malformed' } : golden.id === answers[0]?.id ? { outcome: 'timeout' } : undefined))).gatePassed).toBe(true);
  });

  it('a harness error fails the run; an answer read as the other option is a reported miss', () => {
    expect(summarizeHelpScope(run((_record, golden) => (golden.id === nonAnswers[2]?.id ? { outcome: 'error', error: 'Error' } : undefined)))).toMatchObject({ errors: 1, gatePassed: false });
    expect(summarizeHelpScope(run((_record, golden) => (golden.id === answers[0]?.id ? { outcome: 'miss', got: '2' } : undefined)))).toMatchObject({ wrongOptions: 1, gatePassed: true });
  });

  it('the gate constants are the owner decision of 2026-11-02', () => {
    expect(NL_HELP_SCOPE_EVAL_GATE).toEqual({ wrongCaptures: 0, answerAccuracy: 0.95, harnessErrors: 0 });
  });
});

describe('runHelpScopeEvaluation', () => {
  const plan = buildHelpScopePlan(ids, sha256, { model: 'haiku', runs: 2, concurrency: 3 });

  it('makes one INTENT_SELECTION call per case and run, with the real prompt', async () => {
    const provider = scriptedProvider();
    const records = await runHelpScopeEvaluation({ cases: corpus.cases, plan, provider });
    expect(provider.calls).toHaveLength(110);
    expect(provider.calls.every((call) => call.capability === Capability.INTENT_SELECTION && call.timeoutMs === plan.callTimeoutMs)).toBe(true);
    expect(records).toHaveLength(110);
    expect(records.every((record) => record.outcome === 'hit')).toBe(true);
    expect([1, 2].map((n) => summarizeHelpScope(records.filter((record) => record.run === n)).gatePassed)).toEqual([true, true]);
  });

  it('classifies provider failures: a TIMEOUT kind is a timeout, any other error a harness error; a malformed answer keeps its bounded text', async () => {
    const provider = scriptedProvider((golden) =>
      golden.id === 'ctx-d4-001' ? Object.assign(new Error('slow'), { kind: 'TIMEOUT' }) : golden.id === 'ctx-d4-002' ? new Error('boom') : golden.id === 'ctx-d4-003' ? `no ${'x'.repeat(500)}` : undefined,
    );
    const records = await runHelpScopeEvaluation({ cases: corpus.cases, plan: buildHelpScopePlan(ids, sha256, { model: 'haiku', runs: 1, concurrency: 2 }), provider });
    const by = (id: string) => records.find((record) => record.id === id) as NlHelpScopeRecord;
    expect(by('ctx-d4-001').outcome).toBe('timeout');
    expect(by('ctx-d4-002')).toMatchObject({ outcome: 'error', error: 'Error' });
    expect(by('ctx-d4-003').outcome).toBe('malformed');
    expect(by('ctx-d4-003').raw?.length).toBe(200);
  });
});

describe('eval:nl --mode help-scope plan', () => {
  it('prints the plan: prompt version, corpus digest, runs, the call count, the gate; nothing is constructed or written', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'help-scope', '--runs', '3'], d)).toBe(EXIT_OK);
    const plan = buildHelpScopePlan(ids, sha256, { model: 'haiku', effort: 'low', runs: 3, concurrency: 4 });
    expect(plan).toMatchObject({ kind: 'nl-help-scope-eval', promptVersion: 'help-scope.v1', corpusSha256: sha256, runs: 3, calls: 165, gate: NL_HELP_SCOPE_EVAL_GATE });
    expect(d.out.join('\n')).toContain('55 cases (26 answers, 29 non-answers)');
    expect(d.out.join('\n')).toContain('at most 165');
    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
    expect(digestOf(d.out)).toBe(computeHelpScopePlanDigest({ ...plan, effort: /"effort": "([a-z]+)"/.exec(d.out.join('\n'))?.[1] as string }));
  });

  it('the digest binds the prompt bytes, the runs, the model, the effort, the corpus and the gate', () => {
    const base = computeHelpScopePlanDigest(buildHelpScopePlan(ids, sha256, { model: 'haiku', runs: 3, concurrency: 4 }));
    expect(computeHelpScopePlanDigest(buildHelpScopePlan(ids, sha256, { model: 'haiku', runs: 2, concurrency: 4 }))).not.toBe(base);
    expect(computeHelpScopePlanDigest(buildHelpScopePlan(ids, sha256, { model: 'sonnet', runs: 3, concurrency: 4 }))).not.toBe(base);
    expect(computeHelpScopePlanDigest(buildHelpScopePlan(ids, sha256, { model: 'haiku', effort: 'high', runs: 3, concurrency: 4 }))).not.toBe(base);
    expect(computeHelpScopePlanDigest(buildHelpScopePlan(ids, `${sha256.slice(1)}0`, { model: 'haiku', runs: 3, concurrency: 4 }))).not.toBe(base);
    expect(computeHelpScopePlanDigest({ ...buildHelpScopePlan(ids, sha256, { model: 'haiku', runs: 3, concurrency: 4 }), promptSha256: '0'.repeat(64) })).not.toBe(base);
    expect(computeHelpScopePlanDigest({ ...buildHelpScopePlan(ids, sha256, { model: 'haiku', runs: 3, concurrency: 4 }), gate: { ...NL_HELP_SCOPE_EVAL_GATE, answerAccuracy: 0.9 } })).not.toBe(base);
  });

  it('rejects options that belong to other modes', async () => {
    expect(await runCli(['--mode', 'help-scope', '--entries', 'jira.issues'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'help-scope', '--runs', '9'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'help-scope', '--effort', 'huge'], deps())).toBe(EXIT_USAGE);
  });
});

describe('eval:nl --mode help-scope run (Strict)', () => {
  it('is BLOCKED before any provider is constructed unless the digest matches', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'help-scope', '--runs', '1', '--approved-plan-digest', '0'.repeat(64)], d)).toBe(EXIT_BLOCKED);
    expect(d.created).toEqual([]);
    expect(d.err.join('\n')).toContain('BLOCKED');
  });

  it('a gold classifier passes in every run; the multi-run gate line and a content-free report', async () => {
    const { code, d } = await strictRun(() => scriptedProvider(), 3);
    expect(code).toBe(EXIT_OK);
    expect(d.created).toEqual(['haiku']);
    expect(d.out.join('\n')).toContain('help-scope gate (help-scope.v1): PASSED in all 3 run(s)');
    expect(d.out.filter((line) => /^run \d\/3: /.test(line))).toHaveLength(3);
    expect(d.written).toHaveLength(1);
    expect(d.written[0]?.name).toMatch(/^nl-help-scope-/);
    const report = JSON.parse(d.written[0]?.contents ?? '{}') as { summaries: unknown[]; records: Array<Record<string, unknown>> };
    expect(report.summaries).toHaveLength(3);
    expect(report.records).toHaveLength(165);
    // Ids, outcomes and answer classes only: no owner text.
    for (const golden of corpus.cases) expect(d.written[0]?.contents).not.toContain(golden.text);
  });

  it('one wrong capture in one of three runs fails the multi-run gate', async () => {
    let calls = 0;
    const target = nonAnswers[0] as NlHelpScopeCase;
    const { code, d } = await strictRun(
      () =>
        scriptedProvider((golden) => {
          if (golden.id === target.id) {
            calls += 1;
            return calls === 2 ? '{"answer":1}' : undefined;
          }
          return undefined;
        }),
      3,
    );
    expect(code).toBe(EXIT_GATE_FAILED);
    expect(d.out.join('\n')).toContain('help-scope gate (help-scope.v1): FAILED, passed 2 of 3 run(s)');
  });

  it('one miss in 26 answers passes every run; two misses in one run fail', async () => {
    const one = await strictRun(() => scriptedProvider((golden) => (golden.id === answers[0]?.id ? '{"answer":null}' : undefined)), 2);
    expect(one.code).toBe(EXIT_OK);
    const two = await strictRun(() => scriptedProvider((golden) => (golden.id === answers[0]?.id || golden.id === answers[1]?.id ? '{"answer":null}' : undefined)), 1);
    expect(two.code).toBe(EXIT_GATE_FAILED);
    expect(two.d.out.join('\n')).toContain('FAILED, passed 0 of 1 run(s)');
  });
});
