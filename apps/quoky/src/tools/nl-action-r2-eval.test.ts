import { afterEach, describe, expect, it } from 'vitest';
import { Capability, type AiProvider, type AiRequest, type NlSelectionDecision } from '@quoky/core';
import { NL_ACTION_R2_EVAL_ENTRIES, NL_ACTION_R2_EVAL_GATE, buildActionPlan, computeActionPlanDigest, loadR2ActionCorpus, r2DiagnosticArgs, recordArgs, scoreActionDecision, summarizeActionR2, type NlActionCase, type NlActionRecord } from './nl-action-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_OK, EXIT_USAGE, formatGateRuns, runCli, type CliDeps } from './nl-intent-eval-cli';

// `eval:nl --mode r2` offline: the plan and its Strict digest (prompt v56, corpus, runs, calls, gate), the digest rule
// (nothing constructed before it matches), the R2 gate (jira and slack slices, wrong targets, negatives) and the
// content-free report. Fake providers only; no process is spawned and QUOKY_NL_ITEM_R2 is never read.

const NOW = '2026-10-17T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}, ambiguity = 'CLEAR') => JSON.stringify({ entryId, args, ambiguity, alternatives: [] });
const { corpus, sha256 } = loadR2ActionCorpus();

function goldProvider(cases: readonly NlActionCase[]): AiProvider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    id: 'scripted-r2-eval',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    isAvailable: async () => true,
    execute: async (request) => {
      calls.push(request);
      const golden = cases.find((candidate) => request.prompt.endsWith(`<<<\n${candidate.text}\n>>>`));
      if (golden === undefined || golden.expect === 'none') return { text: answer('none'), artifacts: [] };
      const clarifies = golden.expect.outcome === 'ask' && golden.expect.acceptsAnyQuestion === true && golden.expect.reason === 'ambiguous';
      return { text: answer(golden.expect.entryId, golden.expect.args, clarifies ? 'NEEDS_CLARIFICATION' : 'CLEAR'), artifacts: [] };
    },
  };
}

function deps(overrides: Partial<CliDeps> = {}): CliDeps & { out: string[]; err: string[]; written: Array<{ name: string; contents: string }>; created: string[] } {
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
    gitHead: () => 'rev-1',
    loadCorpus: () => {
      throw new Error('not used');
    },
    writeReport: (name, contents) => {
      written.push({ name, contents });
      return `/reports/${name}`;
    },
    createProvider: (model) => {
      created.push(model);
      return goldProvider(corpus.cases);
    },
    ...overrides,
  };
}

const digestOf = (out: readonly string[]): string => /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] ?? '';

describe('eval:nl --mode r2 plan', () => {
  const saved = process.env.QUOKY_NL_ITEM_R2;
  afterEach(() => {
    if (saved === undefined) delete process.env.QUOKY_NL_ITEM_R2;
    else process.env.QUOKY_NL_ITEM_R2 = saved;
  });

  it('prints the plan: the R2 prompt v56, the corpus digest, runs, the call count, the gate; nothing is constructed', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'r2', '--runs', '3'], d)).toBe(EXIT_OK);
    const plan = buildActionPlan('nl-action-r2-eval', corpus.cases.map((golden) => golden.id), sha256, { model: 'haiku', runs: 3, concurrency: 4, gitHead: 'rev-1' });
    expect(plan.promptVersion).toBe('nl-select.v63');
    expect(plan).toMatchObject({ corpusSha256: sha256, runs: 3, itemR2: 'all', calls: corpus.cases.length * 3, gate: NL_ACTION_R2_EVAL_GATE });
    expect(digestOf(d.out)).toBe(computeActionPlanDigest(plan));
    expect(d.out.join('\n')).toContain(`at most ${corpus.cases.length * 3}`);
    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
  });

  it('the digest binds the runs, the model, the corpus and the prompt (a change is a different digest)', () => {
    const ids = corpus.cases.map((golden) => golden.id);
    const base = computeActionPlanDigest(buildActionPlan('nl-action-r2-eval', ids, sha256, { model: 'haiku', runs: 3, concurrency: 4, gitHead: 'rev-1' }));
    expect(computeActionPlanDigest(buildActionPlan('nl-action-r2-eval', ids, sha256, { model: 'haiku', runs: 2, concurrency: 4, gitHead: 'rev-1' }))).not.toBe(base);
    expect(computeActionPlanDigest(buildActionPlan('nl-action-r2-eval', ids, sha256, { model: 'sonnet', runs: 3, concurrency: 4, gitHead: 'rev-1' }))).not.toBe(base);
    expect(computeActionPlanDigest(buildActionPlan('nl-action-r2-eval', ids, `${sha256.slice(1)}0`, { model: 'haiku', runs: 3, concurrency: 4, gitHead: 'rev-1' }))).not.toBe(base);
    // The git revision is bound too.
    expect(computeActionPlanDigest(buildActionPlan('nl-action-r2-eval', ids, sha256, { model: 'haiku', runs: 3, concurrency: 4, gitHead: 'rev-2' }))).not.toBe(base);
    // The action plan of the same corpus is another plan (other prompt bytes, no R2 offer).
    expect(computeActionPlanDigest(buildActionPlan('nl-action-eval', ids, sha256, { model: 'haiku', runs: 3, concurrency: 4, gitHead: 'rev-1' }))).not.toBe(base);
  });

  it('never reads QUOKY_NL_ITEM_R2: R2 is offered whatever the environment says', async () => {
    process.env.QUOKY_NL_ITEM_R2 = 'off';
    const off = deps();
    await runCli(['--mode', 'r2', '--runs', '3'], off);
    delete process.env.QUOKY_NL_ITEM_R2;
    const unset = deps();
    await runCli(['--mode', 'r2', '--runs', '3'], unset);
    expect(digestOf(off.out)).toBe(digestOf(unset.out));
    expect(off.out.join('\n')).toContain('"itemR2": "all"');
  });

  it('rejects options that belong to other modes', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'r2', '--entries', 'jira.issues'], d)).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'r2', '--runs', '9'], deps())).toBe(EXIT_USAGE);
  });
});

describe('eval:nl --mode r2 run (Strict)', () => {
  it('is BLOCKED before any provider is constructed unless the digest matches', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'r2', '--runs', '1', '--approved-plan-digest', '0'.repeat(64)], d)).toBe(EXIT_BLOCKED);
    expect(d.created).toEqual([]);
    expect(d.err.join('\n')).toContain('BLOCKED');
  });

  it('with the approved digest, a gold selector passes the R2 gate; the report is content-free', async () => {
    const planned = deps();
    await runCli(['--mode', 'r2', '--runs', '1'], planned);
    const d = deps();
    const code = await runCli(['--mode', 'r2', '--runs', '1', '--approved-plan-digest', digestOf(planned.out)], d);
    expect(d.created).toEqual(['haiku']);
    expect(d.out.join('\n')).toContain('R2 gate (nl-select.v63): PASSED in all 1 run(s)');
    expect(code).toBe(EXIT_OK);
    expect(d.written).toHaveLength(1);
    const report = d.written[0]?.contents ?? '';
    for (const golden of corpus.cases) expect(report).not.toContain(golden.text);
    expect(JSON.parse(report).records).toHaveLength(corpus.cases.length);
    // Diagnosis (v47 gate): every R2 record carries the selector's args; a hit carries no expectedArgs.
    const records = JSON.parse(report).records as Array<{ outcome: string; gotArgs?: Record<string, unknown>; expectedArgs?: Record<string, unknown> }>;
    expect(records.every((record) => record.gotArgs !== undefined)).toBe(true);
    expect(records.filter((record) => record.outcome === 'hit').every((record) => record.expectedArgs === undefined)).toBe(true);
  });

  it('a selector that captures negatives fails the gate (exit 1)', async () => {
    const planned = deps();
    await runCli(['--mode', 'r2', '--runs', '1'], planned);
    const hostile: AiProvider = {
      id: 'hostile',
      capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
      isAvailable: async () => true,
      execute: async () => ({ text: answer('item.summarize', { source: 'jira', ref: '#1', mode: 'summary' }), artifacts: [] }),
    };
    const d = deps({ createProvider: () => hostile });
    expect(await runCli(['--mode', 'r2', '--runs', '1', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_GATE_FAILED);
    expect(d.out.join('\n')).toContain('FAILED');
  });

  it('a BLOCKED provider (unavailable) executes nothing', async () => {
    const planned = deps();
    await runCli(['--mode', 'r2', '--runs', '1'], planned);
    const unavailable = { ...goldProvider(corpus.cases), isAvailable: async () => false };
    const d = deps({ createProvider: () => unavailable });
    expect(await runCli(['--mode', 'r2', '--runs', '1', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_BLOCKED);
    expect(unavailable.calls).toEqual([]);
  });
});

describe('the R2 gate (proposal §6.4)', () => {
  const sourceOf = (id: string): string | undefined => {
    const golden = corpus.cases.find((candidate) => candidate.id === id);
    return golden !== undefined && golden.expect !== 'none' && typeof golden.expect.args.source === 'string' ? golden.expect.args.source : undefined;
  };
  const perfect = (): NlActionRecord[] => corpus.cases.map((golden) => ({ run: 1, id: golden.id, family: golden.family, expected: golden.expect === 'none' ? 'none' : golden.expect.entryId, outcome: golden.expect === 'none' ? 'none' : 'hit', latencyMs: 100 }));

  it('passes a perfect run and reports the jira and slack slices', () => {
    const summary = summarizeActionR2(perfect(), corpus);
    expect(summary.gatePassed).toBe(true);
    expect(summary.perSource.jira.total).toBeGreaterThanOrEqual(30);
    expect(summary.perSource.slack.total).toBeGreaterThanOrEqual(30);
  });

  it('fails when one slice is under 90% even though the overall rate is >= 95%', () => {
    const records = perfect();
    const slack = records.filter((record) => sourceOf(record.id) === 'slack' && record.outcome === 'hit');
    const drop = Math.floor(slack.length * 0.1) + 1;
    const missed = new Set(slack.slice(0, drop).map((record) => record.id));
    const degraded = records.map((record) => (missed.has(record.id) ? { ...record, outcome: 'miss' as const } : record));
    const summary = summarizeActionR2(degraded, corpus);
    expect(summary.overall).toBeGreaterThanOrEqual(0.95);
    expect(summary.perSource.slack.rate).toBeLessThan(0.9);
    expect(summary.gatePassed).toBe(false);
  });

  it('fails on one wrong target, one captured negative, or too many questions on references', () => {
    const records = perfect();
    const positive = records.findIndex((record) => record.expected !== 'none');
    const negative = records.findIndex((record) => record.expected === 'none');
    expect(summarizeActionR2(records.map((record, index) => (index === positive ? { ...record, outcome: 'wrong-target' as const } : record)), corpus).gatePassed).toBe(false);
    expect(summarizeActionR2(records.map((record, index) => (index === negative ? { ...record, outcome: 'negative-capture' as const } : record)), corpus).gatePassed).toBe(false);
    const asked = records.map((record) => (record.family === 'reference' && record.outcome === 'hit' ? { ...record, outcome: 'question' as const } : record));
    expect(summarizeActionR2(asked, corpus).gatePassed).toBe(false);
  });

  it('fails an empty run', () => {
    expect(summarizeActionR2([], corpus).gatePassed).toBe(false);
  });

  it('the gold-ask rule holds: naming the gold entry while the turn ends as none is a miss, a real ask is a hit', () => {
    const golden = corpus.cases.find((candidate) => candidate.expect !== 'none' && candidate.expect.outcome === 'ask' && candidate.expect.acceptsAnyQuestion !== true && Object.keys(candidate.expect.args).length > 0);
    if (golden === undefined || golden.expect === 'none') throw new Error('no ask gold with args');
    const raw = answer(golden.expect.entryId, golden.expect.args);
    const r2 = { entries: NL_ACTION_R2_EVAL_ENTRIES };
    expect(scoreActionDecision(golden, raw, { kind: 'none' } as NlSelectionDecision, undefined, r2).outcome).toBe('miss');
    expect(scoreActionDecision(golden, answer(golden.expect.entryId, golden.expect.args, 'NEEDS_CLARIFICATION'), { kind: 'none' } as NlSelectionDecision, undefined, r2).outcome).toBe('hit');
  });

  it('a gold ask is scored on Core final args, not the selector raw args (owner decision 2026-10-19)', () => {
    const r2 = { entries: NL_ACTION_R2_EVAL_ENTRIES };
    const ask = { kind: 'ask', text: '?' } as NlSelectionDecision;
    const find = (id: string) => {
      const golden = corpus.cases.find((candidate) => candidate.id === id);
      if (golden === undefined) throw new Error(id);
      return golden;
    };
    // 019 "2번 메일 요약해줘" over a Slack list: the selector's slack is grounded to mail, then Core asks other-source.
    expect(scoreActionDecision(find('a6r2-reference-019'), answer('item.summarize', { source: 'slack', ref: '#2', mode: 'summary' }), ask, { reason: 'other-source' }, r2).outcome).toBe('hit');
    // 063 "방금 본 거 요약해줘": the selector's `this` is grounded to `recent` before Core asks.
    expect(scoreActionDecision(find('a6r2-reference-063'), answer('item.summarize', { source: 'jira', ref: 'this', mode: 'summary' }), ask, { reason: 'ambiguous' }, r2).outcome).toBe('hit');
    // 065 "그거 원문 보여줘" (relabelled): no source is knowable, so Core asks for it; a guessed source is a miss.
    expect(scoreActionDecision(find('a6r2-reference-065'), answer('item.summarize', { ref: 'this', mode: 'full' }), ask, { reason: 'missing-arg' }, r2).outcome).toBe('hit');
    expect(scoreActionDecision(find('a6r2-reference-065'), answer('item.summarize', { source: 'mail', ref: 'this', mode: 'full' }), ask, { reason: 'ambiguous' }, r2).outcome).toBe('miss');
    // 062 stays strict: the ask must hold the source the owner just read (jira); a slack guess Core asks about is a miss.
    expect(scoreActionDecision(find('a6r2-reference-062'), answer('item.summarize', { source: 'slack', ref: 'this', mode: 'summary' }), ask, { reason: 'ambiguous' }, r2).outcome).toBe('miss');
  });
});

describe('eval:nl --mode r2 diagnosis args', () => {
  it('records the selector args and, for a non-hit, the gold args; never a span value', () => {
    const golden = corpus.cases.find((candidate) => candidate.expect !== 'none') as NlActionCase;
    const raw = answer('item.summarize', { source: 'jira', ref: '#9', mode: 'full' });
    expect(r2DiagnosticArgs(golden, raw, 'miss')).toEqual({ gotArgs: { source: 'jira', ref: '#9', mode: 'full' }, expectedArgs: golden.expect !== 'none' ? golden.expect.args : {} });
    expect(r2DiagnosticArgs(golden, raw, 'hit')).toEqual({ gotArgs: { source: 'jira', ref: '#9', mode: 'full' } });
    expect(r2DiagnosticArgs(golden, answer('todo.add', { title: '비밀 메모' }), 'miss').gotArgs).toEqual({});
    expect(r2DiagnosticArgs(golden, 'not json', 'error')).toEqual({ expectedArgs: golden.expect !== 'none' ? golden.expect.args : {} });
  });

  it('records only the closed diagnostic fields; free text becomes "<invalid>" (Codex P2)', () => {
    expect(recordArgs({ source: 'private text', ref: 'private text', mode: 'whole thing', scope: 'thread', query: 'private text', title: 'private text' })).toEqual({
      source: '<invalid>',
      ref: '<invalid>',
      mode: '<invalid>',
      scope: 'thread',
    });
    expect(recordArgs({ source: 'jira', ref: 'PROJ-12', mode: 'summary' })).toEqual({ source: 'jira', ref: 'PROJ-12', mode: 'summary' });
    expect(recordArgs({ source: 'slack', ref: '#3' })).toEqual({ source: 'slack', ref: '#3' });
    expect(JSON.stringify(recordArgs({ source: 'private text', query: 'private text' }))).not.toContain('private');
  });
});

describe('the multi-run gate line (every eval:nl mode)', () => {
  it('says how many runs passed instead of "FAILED in every one"', () => {
    const run = (gatePassed: boolean) => ({ gatePassed });
    expect(formatGateRuns('R2 gate (v)', [run(true), run(true), run(true)])).toBe('R2 gate (v): PASSED in all 3 run(s)');
    expect(formatGateRuns('R2 gate (v)', [run(true), run(true), run(false)])).toBe('R2 gate (v): FAILED, passed 2 of 3 run(s) (the gate needs every run)');
    expect(formatGateRuns('intent gate', [run(false), run(false), run(false)])).toBe('intent gate: FAILED, passed 0 of 3 run(s) (the gate needs every run)');
  });
});
