import { describe, expect, it } from 'vitest';
import { NL_CATALOG_ENTRY_IDS, NL_WAVE1_ENTRIES, buildAgentPlanPrompt, isNlWave1EntryId, prepareSelectionInput, type AiProvider } from '@quoky/core';
import {
  AGENT_PLAN_NEGATIVE_FAMILIES,
  AGENT_PLAN_POSITIVE_FAMILIES,
  agentPlanEvalCases,
  buildAgentPlanEvalPlan,
  cappedProvider,
  computeAgentPlanEvalDigest,
  loadAgentPlanCorpus,
  runAgentPlanEvaluation,
  scoreAgentPlanOutput,
  summarizeAgentPlanRun,
  validateAgentPlanCorpus,
  type AgentPlanCase,
  type AgentPlanCorpus,
  type AgentPlanEvalCase,
  type AgentPlanEvalOptions,
  type AgentPlanEvalRecord,
} from './agent-plan-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_OK, EXIT_USAGE, runCli, type AgentPlanCliDeps } from './agent-plan-eval-cli';

// ADR-0121 D11 / stage S2 P2: the plan corpus self-check, the step-graph scorer, the digest, the Strict exit-3 gate, the
// hard call cap and the content-free report. No model is called: the providers here are scripted.

const LOADED = loadAgentPlanCorpus();
const { corpus: CORPUS, oneStep: ONE_STEP } = LOADED;
const FIXTURE = CORPUS.fixture;
const CASES = agentPlanEvalCases(CORPUS, ONE_STEP);
const NEW = CORPUS.cases;
const READS = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);

const OPTIONS: AgentPlanEvalOptions = { model: 'haiku', runs: 3, concurrency: 4, includePending: false, gitHead: 'a'.repeat(40) };
const HASHES = { corpusSha256: LOADED.sha256, oneStepCorpusSha256: LOADED.oneStepSha256 };

const steps = (value: unknown): string => JSON.stringify({ steps: value, ambiguity: 'CLEAR' });
const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
const byId = (id: string): AgentPlanEvalCase => {
  const found = CASES.find((golden) => golden.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const ownerExample = (): AgentPlanCase => {
  const found = NEW.find((golden) => golden.text === '이번 주 회의 정리하고 관련 jira 이슈도 같이');
  if (found === undefined) throw new Error('owner example missing');
  return found;
};

/** The gold answer of a case, as the planner would write it (the selection form for a one-step gold). */
function goldAnswer(golden: AgentPlanEvalCase): string {
  if (golden.gold === 'none') return none;
  if (golden.family === 'one-step') {
    const step = golden.gold.steps[0] as { entryId: string; args?: Record<string, unknown> };
    return JSON.stringify({ entryId: step.entryId, args: step.args ?? {}, ambiguity: 'CLEAR', alternatives: [] });
  }
  return JSON.stringify(golden.gold);
}

/** A provider that answers every planner prompt with that case's gold (a perfect planner), counting its calls. */
function goldProvider(cases: readonly AgentPlanEvalCase[], transform: (answer: string) => string = (answer) => answer): AiProvider & { calls: number } {
  const answers = new Map<string, string>();
  for (const golden of cases) {
    const prepared = prepareSelectionInput(golden.text, golden.attachments);
    if ('skip' in prepared) continue;
    const prompt = buildAgentPlanPrompt({
      entries: READS,
      text: prepared.text,
      ...(golden.prior !== undefined && isNlWave1EntryId(golden.prior.entryId) ? { previous: { entryId: golden.prior.entryId, args: golden.prior.args } } : {}),
    });
    if (!answers.has(prompt)) answers.set(prompt, goldAnswer(golden));
  }
  const provider = {
    id: 'scripted',
    capabilities: [],
    calls: 0,
    isAvailable: async () => true,
    execute: async (request: { prompt: string }) => {
      provider.calls += 1;
      return { text: transform(answers.get(request.prompt) ?? none) };
    },
  };
  return provider as unknown as AiProvider & { calls: number };
}

describe('agent-plan.v1 corpus (S2 P2)', () => {
  it('passes the self-check: every positive validates to its own canonical graph, every negative is none or its trap is refused', () => {
    expect(validateAgentPlanCorpus(CORPUS, ONE_STEP)).toEqual([]);
  });

  it('has >= 150 multi-step positives and >= 120 negatives in KO and EN, every family covered, all pending the owner', () => {
    const positives = NEW.filter((golden) => golden.expect !== 'none');
    const negatives = NEW.filter((golden) => golden.expect === 'none');
    expect(positives.length).toBeGreaterThanOrEqual(150);
    expect(negatives.length).toBeGreaterThanOrEqual(120);
    for (const family of AGENT_PLAN_POSITIVE_FAMILIES) expect(positives.some((golden) => golden.family === family), family).toBe(true);
    for (const family of AGENT_PLAN_NEGATIVE_FAMILIES) expect(negatives.some((golden) => golden.family === family), family).toBe(true);
    for (const lang of ['ko', 'en'] as const) {
      expect(positives.some((golden) => golden.lang === lang)).toBe(true);
      expect(negatives.some((golden) => golden.lang === lang)).toBe(true);
    }
    expect(NEW.every((golden) => golden.status === 'pending-owner-approval')).toBe(true);
    const batches = new Map<string, number>();
    for (const golden of NEW) batches.set(golden.batch, (batches.get(golden.batch) ?? 0) + 1);
    expect([...batches.values()].every((size) => size <= 60)).toBe(true);
  });

  it('covers the required shapes: the owner example, refs, summaries, step-scoped periods, A6 traps', () => {
    expect(ownerExample().family).toBe('owner-example');
    const plans = NEW.flatMap((golden) => (golden.expect === 'none' ? [] : [golden.expect]));
    expect(plans.filter((plan) => plan.steps.some((step) => 'ref' in step && step.ref !== undefined)).length).toBeGreaterThanOrEqual(10);
    expect(plans.filter((plan) => plan.steps.some((step) => 'summarize' in step)).length).toBeGreaterThanOrEqual(30);
    expect(NEW.filter((golden) => golden.family === 'period-per-step').length).toBeGreaterThanOrEqual(15);
    expect(NEW.filter((golden) => golden.family === 'en-prenominal').length).toBeGreaterThanOrEqual(10);
    expect(NEW.filter((golden) => golden.trapRefusal === 'a6-in-plan').length).toBeGreaterThanOrEqual(10);
    expect(NEW.filter((golden) => golden.trapRefusal === 'ref-cross-source').length).toBeGreaterThanOrEqual(10);
  });

  it('references every nl-intent.v1.json case as one-step gold by id (Q11), never a copy', () => {
    expect(CORPUS.oneStep.count).toBe(874);
    expect(CORPUS.oneStep.ids).toEqual(ONE_STEP.map((golden) => golden.id));
    const oneStepTexts = new Set(ONE_STEP.map((golden) => golden.text));
    expect(NEW.filter((golden) => oneStepTexts.has(golden.text)).map((golden) => golden.id)).toEqual([]);
    expect(CASES.filter((golden) => golden.family === 'one-step')).toHaveLength(874);
  });

  it('a perfect planner scores 100% except the two one-step dates the P1 validator does not ground (recorded residuals)', async () => {
    const plan = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, runs: 1, includePending: true });
    const records = await runAgentPlanEvaluation({ cases: CASES, plan, provider: goldProvider(CASES) });
    const summary = summarizeAgentPlanRun(records, plan.callTimeoutMs);
    const notExact = records.filter((record) => record.expected === 'plan' && record.outcome !== 'exact');
    expect(notExact.map((record) => `${record.id}:${record.outcome}:${record.reason ?? ''}`)).toEqual(['calendar-019:refused:date-ungrounded', 'calendar-038:refused:date-ungrounded']);
    expect(summary.wrongOnNegatives).toBe(0);
    // Every negative is none; only inputs the D3 preparation empties (two one-step cases) make no call at all.
    expect(records.filter((record) => record.expected === 'none' && record.outcome !== 'none').map((record) => `${record.id}:${record.outcome}`)).toEqual(
      records.filter((record) => record.outcome === 'skipped').map((record) => `${record.id}:skipped`),
    );
    expect(records.filter((record) => record.outcome === 'skipped' && !record.id.startsWith('neg-'))).toEqual([]);
    expect(summary.gatePassed).toBe(true);
  });
});

describe('corpus self-check catches bad cases', () => {
  const positive = ownerExample();
  const trapCase = NEW.find((golden) => golden.trapRefusal === 'a6-in-plan') as AgentPlanCase;
  const check = (cases: AgentPlanCase[], extra: Partial<AgentPlanCorpus> = {}): string[] => validateAgentPlanCorpus({ ...CORPUS, ...extra, cases }, ONE_STEP);

  it.each<[string, AgentPlanCase, RegExp]>([
    ['a malformed id', { ...positive, id: 'x-1' }, /id must be/],
    ['an unknown family', { ...positive, family: 'misc' }, /unknown family/],
    ['an unknown status', { ...positive, status: 'approved-ish' as never }, /unknown status/],
    ['a one-step positive', { ...positive, expect: { steps: [{ entryId: 'jira.issues', args: {} }], ambiguity: 'CLEAR' } }, /at least two steps/],
    ['a non-canonical gold (the calendar default written out)', { ...positive, text: '오늘 회의 정리하고 관련 jira 이슈도 같이 봐줘', expect: { steps: [{ entryId: 'calendar.events', args: { range: 'today', timedOnly: true } }, { summarize: [1], schema: 'meeting-digest.v1' }, { entryId: 'jira.issues', args: {} }], ambiguity: 'CLEAR' } }, /not canonical/],
    ['a gold the validator refuses (a cross-source ref)', { ...positive, expect: { steps: [{ entryId: 'mail.list', args: {} }, { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'messageIds', take: 3 } }], ambiguity: 'CLEAR' } }, /refused \(ref-cross-source/],
    ['a trap the validator accepts', { ...trapCase, trap: { steps: [{ entryId: 'jira.issues', args: {} }, { entryId: 'todo.list', args: {} }], ambiguity: 'CLEAR' }, trapRefusal: undefined as never }, /trap validates to an executable plan/],
    ['a trap refused for another reason', { ...trapCase, trapRefusal: 'ref-cross-source' }, /refused as a6-in-plan, not ref-cross-source/],
  ])('%s', (_label, bad, problem) => {
    expect(check([bad]).join('\n')).toMatch(problem);
  });

  it('a duplicate id and a one-step list that is not the nl-intent id list', () => {
    expect(check([positive, positive]).join('\n')).toMatch(/duplicate id/);
    expect(check([positive], { oneStep: { ...CORPUS.oneStep, ids: CORPUS.oneStep.ids.slice(1) } }).join('\n')).toMatch(/oneStep\.ids must list/);
    expect(check([{ ...positive, id: 'jira-001' }]).join('\n')).toMatch(/duplicate id/);
  });
});

describe('step-graph scorer (Q10)', () => {
  const owner = byId(ownerExample().id);
  const gold = [
    { entryId: 'calendar.events', args: { range: 'this-week', timedOnly: true } },
    { summarize: [1], schema: 'meeting-digest.v1' },
    { entryId: 'jira.issues', args: {} },
  ];
  const score = (golden: AgentPlanEvalCase, raw: string) => scoreAgentPlanOutput(golden, raw, FIXTURE);

  it('the same step graph is exact (arg order, a code fence and a canonical default do not matter)', () => {
    expect(score(owner, steps(gold)).outcome).toBe('exact');
    expect(score(owner, '```json\n' + steps([{ entryId: 'calendar.events', args: { timedOnly: true, range: 'this-week' } }, gold[1], { entryId: 'jira.issues', args: { status: 'open' } }]) + '\n```').outcome).toBe('exact');
  });

  it.each<[string, unknown[], string]>([
    ['another arg', [gold[0], gold[1], { entryId: 'jira.issues', args: { status: 'all' } }], 'args'],
    ['another entry', [gold[0], gold[1], { entryId: 'github.items', args: {} }], 'entry'],
    ['another schema', [gold[0], { summarize: [1], schema: 'digest.v1' }, gold[2]], 'summary'],
    ['a missing summary', [gold[0], gold[2]], 'step-count'],
    ['another order', [gold[0], gold[2], { summarize: [1], schema: 'meeting-digest.v1' }], 'step-kind'],
  ])('%s is a miss with a closed diff kind', (_label, answer, diff) => {
    expect(score(owner, steps(answer))).toMatchObject({ outcome: 'miss', diff });
  });

  it('a different take or field in a reference is a ref miss', () => {
    const refCase = byId((NEW.find((golden) => golden.family === 'same-source-ref' && golden.expect !== 'none' && JSON.stringify(golden.expect).includes('"take":10')) as AgentPlanCase).id);
    const want = (refCase.gold as { steps: Array<Record<string, unknown>> }).steps;
    const changed = want.map((step) => ('ref' in step ? { ...step, ref: { step: 1, field: 'issueKeys', take: 9 } } : step));
    expect(score(refCase, steps(want)).outcome).toBe('exact');
    expect(score(refCase, steps(changed))).toMatchObject({ outcome: 'miss', diff: 'ref' });
  });

  it('none, a clarification, a refusal or a malformed answer is never exact on a positive', () => {
    expect(score(owner, none).outcome).toBe('miss-none');
    expect(score(owner, JSON.stringify({ steps: gold, ambiguity: 'NEEDS_CLARIFICATION' })).outcome).toBe('clarify');
    expect(score(owner, steps([{ entryId: 'calendar.events', args: {} }, { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'eventIds', take: 3 } }]))).toMatchObject({ outcome: 'refused', reason: 'ref-cross-source', failedStep: 2 });
    expect(score(owner, 'Sure! Here is the plan').outcome).toBe('malformed');
  });

  it('on a negative any executable plan is wrong; none, a refusal or a clarification is not', () => {
    const negative = byId((NEW.find((golden) => golden.family === 'cross-source-join') as AgentPlanCase).id);
    expect(score(negative, none).outcome).toBe('none');
    expect(score(negative, steps([{ entryId: 'mail.list', args: {} }, { entryId: 'jira.issues', args: {} }])).outcome).toBe('wrong');
    expect(score(negative, JSON.stringify({ entryId: 'mail.list', args: {}, ambiguity: 'CLEAR', alternatives: [] })).outcome).toBe('wrong');
    expect(score(negative, steps([{ entryId: 'mail.list', args: {} }, { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'messageIds', take: 5 } }])).outcome).toBe('refused');
    expect(score(negative, JSON.stringify({ steps: [{ entryId: 'mail.list', args: {} }, { entryId: 'jira.issues', args: {} }], ambiguity: 'NEEDS_CLARIFICATION' })).outcome).toBe('clarify');
  });

  it('a one-step gold is scored in the selection form and in the steps form alike', () => {
    const golden = byId('jira-003');
    const want = golden.gold as { steps: Array<{ entryId: string; args?: Record<string, unknown> }> };
    const step = want.steps[0] as { entryId: string; args?: Record<string, unknown> };
    expect(score(golden, JSON.stringify({ entryId: step.entryId, args: step.args, ambiguity: 'CLEAR', alternatives: [] })).outcome).toBe('exact');
    expect(score(golden, steps([step])).outcome).toBe('exact');
  });

  it('the selection path vetoes apply before validation: a past statement plans nothing', () => {
    const past = byId((NEW.find((golden) => golden.text === '아침에 일정이랑 할 일 정리 끝났다') as AgentPlanCase).id);
    expect(score(past, steps([{ entryId: 'calendar.events', args: {} }, { entryId: 'todo.list', args: {} }, { summarize: [1, 2], schema: 'digest.v1' }]))).toMatchObject({ outcome: 'none', reason: 'veto:past-statement' });
  });

  it('summarizes per family and per entry, counts wrong on negatives and the share over the bound', () => {
    const record = (id: string, outcome: AgentPlanEvalRecord['outcome'], expected: 'plan' | 'none', latencyMs: number, goldEntries: string[] = []): AgentPlanEvalRecord => ({ run: 1, id, family: expected === 'plan' ? 'compound' : 'venting', expected, goldEntries, outcome, latencyMs });
    const records = [
      ...Array.from({ length: 97 }, (_, i) => record(`p${i}`, 'exact', 'plan', 1000, ['jira.issues', 'summarize'])),
      record('p97', 'miss', 'plan', 1000, ['jira.issues']),
      record('p98', 'timeout', 'plan', 6001, ['mail.list']),
      record('n1', 'none', 'none', 900),
    ];
    const summary = summarizeAgentPlanRun(records, 6000);
    expect(summary).toMatchObject({ positives: 99, exact: 97, negatives: 1, wrongOnNegatives: 0, calls: 100, capped: 0 });
    expect(summary.perEntry['jira.issues']).toEqual({ total: 98, exact: 97, rate: 97 / 98 });
    expect(summary.perEntry['mail.list']).toEqual({ total: 1, exact: 0, rate: 0 });
    expect(summary.perFamily['compound']).toMatchObject({ positives: 99, exact: 97 });
    expect(summary.overBoundRate).toBe(0.01);
    expect(summary.gatePassed).toBe(true);
    expect(summarizeAgentPlanRun([...records, record('p99', 'timeout', 'plan', 6001)], 6000).gatePassed).toBe(false);
    expect(summarizeAgentPlanRun([...records, record('n2', 'wrong', 'none', 800)], 6000).gatePassed).toBe(false);
    expect(summarizeAgentPlanRun([...records, record('p99', 'capped', 'plan', 0)], 6000).gatePassed).toBe(false);
  });
});

describe('plan digest', () => {
  const digest = (options: Partial<AgentPlanEvalOptions> = {}, hashes = HASHES) => computeAgentPlanEvalDigest(buildAgentPlanEvalPlan(CASES, hashes, FIXTURE, { ...OPTIONS, ...options }));

  it('is stable for the same inputs and binds model, runs, concurrency, timeout, git HEAD, both corpora and --include-pending', () => {
    expect(digest()).toBe(digest());
    const base = digest();
    for (const changed of [
      digest({ model: 'sonnet' }),
      digest({ runs: 2 }),
      digest({ concurrency: 2 }),
      digest({ timeoutMs: 7000 }),
      digest({ gitHead: 'b'.repeat(40) }),
      digest({ includePending: true }),
      digest({}, { ...HASHES, corpusSha256: 'c'.repeat(64) }),
      digest({}, { ...HASHES, oneStepCorpusSha256: 'd'.repeat(64) }),
    ]) {
      expect(changed).not.toBe(base);
    }
  });

  it('approved-only scores the 874 one-step cases; --include-pending adds every pending case; the bound is cases x runs', () => {
    const approved = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, OPTIONS);
    const pending = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, includePending: true });
    expect(approved.caseIds).toHaveLength(874);
    expect(pending.caseIds).toHaveLength(874 + NEW.length);
    expect(approved.maxCalls).toBe(874 * 3);
    expect(pending.maxCalls).toBe((874 + NEW.length) * 3);
    expect(approved).toMatchObject({ kind: 'agent-plan-eval', promptVersion: 'agent-plan.v2', callTimeoutMs: 6000, fixture: FIXTURE });
    expect(approved.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects out-of-range options', () => {
    expect(() => buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, runs: 6 })).toThrow(/runs/);
    expect(() => buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, concurrency: 0 })).toThrow(/concurrency/);
    expect(() => buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, timeoutMs: 9000 })).toThrow(/timeoutMs/);
    expect(() => buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, model: '--x' })).toThrow(/model/);
  });
});

describe('hard call cap', () => {
  it('the capped provider refuses every call past the limit', async () => {
    const inner = goldProvider([]);
    const capped = cappedProvider(inner, 2);
    await capped.provider.execute({ capability: 'INTENT_SELECTION', prompt: 'a' } as never);
    await capped.provider.execute({ capability: 'INTENT_SELECTION', prompt: 'b' } as never);
    await expect(capped.provider.execute({ capability: 'INTENT_SELECTION', prompt: 'c' } as never)).rejects.toThrow(/hard call cap/);
    expect(inner.calls).toBe(2);
    expect(capped.refused()).toBe(1);
  });

  it('a run never makes more calls than the plan bound, and a capped call fails the gate', async () => {
    const cases = CASES.filter((golden) => golden.family !== 'one-step').slice(0, 12);
    const plan = buildAgentPlanEvalPlan(cases, HASHES, FIXTURE, { ...OPTIONS, runs: 1, concurrency: 1, includePending: true });
    const provider = goldProvider(cases);
    const tight = { ...plan, maxCalls: 5 };
    const records = await runAgentPlanEvaluation({ cases, plan: tight, provider });
    expect(provider.calls).toBe(5);
    expect(records.filter((record) => record.outcome === 'capped')).toHaveLength(7);
    expect(summarizeAgentPlanRun(records, plan.callTimeoutMs).gatePassed).toBe(false);
  });
});

describe('agent-plan CLI (Strict digest gate, content-free report)', () => {
  function deps(created: string[], provider: () => AiProvider = () => goldProvider(CASES)): AgentPlanCliDeps & { out: string[]; err: string[]; reports: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const reports: string[] = [];
    return {
      out,
      err,
      reports,
      stdout: (line) => void out.push(line),
      stderr: (line) => void err.push(line),
      now: () => '2026-10-20T03:00:00.000Z',
      gitHead: () => 'a'.repeat(40),
      load: () => LOADED,
      writeReport: (name, contents) => {
        reports.push(contents);
        return `/tmp/${name}`;
      },
      createProvider: (model) => {
        created.push(model);
        return provider();
      },
    };
  }
  const digestOf = (out: readonly string[]): string => /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;

  it('plan is offline: it prints the digest, the prompt binding and the call bound, and constructs nothing', async () => {
    const created: string[] = [];
    const planned = deps(created);
    expect(await runCli(['--mode', 'plan', '--runs', '3'], planned)).toBe(EXIT_OK);
    const text = planned.out.join('\n');
    expect(digestOf(planned.out)).toBe(computeAgentPlanEvalDigest(buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, OPTIONS)));
    expect(text).toContain('"promptVersion": "agent-plan.v2"');
    expect(text).toContain(`"corpusSha256": "${LOADED.sha256}"`);
    expect(text).toContain(`"gitHead": "${'a'.repeat(40)}"`);
    expect(text).toContain(`at most ${874 * 3} (874 cases x 3 run(s)`);
    expect(created).toEqual([]);
    const withPending = deps(created);
    expect(await runCli(['--mode', 'plan', '--runs', '3', '--include-pending'], withPending)).toBe(EXIT_OK);
    expect(digestOf(withPending.out)).not.toBe(digestOf(planned.out));
    expect(withPending.out.join('\n')).toContain(`at most ${(874 + NEW.length) * 3}`);
  });

  it('run exits 3 before any provider is constructed without the digest, with a wrong one, or with another plan\'s', async () => {
    const created: string[] = [];
    const planned = deps(created);
    await runCli(['--mode', 'plan'], planned);
    const digest = digestOf(planned.out);
    const missing = deps(created);
    expect(await runCli(['--mode', 'run'], missing)).toBe(EXIT_BLOCKED);
    expect(missing.err.join('\n')).toContain('run requires --approved-plan-digest');
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', 'f'.repeat(64)], deps(created))).toBe(EXIT_BLOCKED);
    // The approved digest was for approved-only cases: including the pending ones is another plan.
    expect(await runCli(['--mode', 'run', '--include-pending', '--approved-plan-digest', digest], deps(created))).toBe(EXIT_BLOCKED);
    expect(await runCli(['--mode', 'run', '--runs', '2', '--approved-plan-digest', digest], deps(created))).toBe(EXIT_BLOCKED);
    expect(created).toEqual([]);
  });

  it('usage errors exit 2', async () => {
    expect(await runCli(['--mode', 'plan', '--entries', 'x'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--runs', '9'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--timeout-ms', '100'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--approved-plan-digest', 'f'.repeat(64)], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'eval'], deps([]))).toBe(EXIT_USAGE);
    expect(await runCli(['--help'], deps([]))).toBe(EXIT_OK);
  });

  it('a matching digest runs once per case per run under the cap; the report and the output hold no text, answer or value', async () => {
    const created: string[] = [];
    const planned = deps(created);
    await runCli(['--mode', 'plan', '--include-pending'], planned);
    const digest = digestOf(planned.out);
    // A hostile planner: every answer is a valid-looking plan whose keyword is a canary.
    const canary = 'CANARY-7f3a-zebra';
    let calls = 0;
    const hostile = (): AiProvider =>
      ({
        id: 'scripted',
        capabilities: [],
        isAvailable: async () => true,
        execute: async () => {
          calls += 1;
          return { text: steps([{ entryId: 'slack.search', args: { keyword: canary } }, { entryId: 'confluence.search', args: { keyword: canary } }]) };
        },
      }) as unknown as AiProvider;
    const ran = deps(created, hostile);
    expect(await runCli(['--mode', 'run', '--include-pending', '--approved-plan-digest', digest], ran)).toBe(EXIT_GATE_FAILED);
    expect(created).toEqual(['haiku']);
    const skipped = CASES.filter((golden) => 'skip' in prepareSelectionInput(golden.text, golden.attachments)).length;
    expect(skipped).toBeLessThanOrEqual(2);
    expect(calls).toBe(874 + NEW.length - skipped);
    const everything = [...ran.reports, ...ran.out, ...ran.err].join('\n');
    expect(everything).not.toContain(canary);
    const texts = CASES.map((golden) => golden.text).filter((text) => Array.from(text).length >= 12);
    expect(texts.filter((text) => everything.includes(text))).toEqual([]);
    for (const value of ['인사발령', '마이그레이션 가이드', '김부장님', 'security policy']) expect(everything).not.toContain(value);
    const report = JSON.parse(ran.reports[0] as string) as { plan: { digest: string }; records: AgentPlanEvalRecord[] };
    expect(report.plan.digest).toBe(digest);
    expect(report.records).toHaveLength(874 + NEW.length);
    expect(Object.keys(report.records[0] as object).sort()).toEqual(expect.arrayContaining(['id', 'family', 'outcome', 'latencyMs', 'run']));
  });

  it('a perfect planner passes the gate end to end (approved-only cases)', async () => {
    const created: string[] = [];
    const planned = deps(created);
    await runCli(['--mode', 'plan'], planned);
    const ran = deps(created);
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], ran)).toBe(EXIT_OK);
    expect(ran.out.join('\n')).toContain('agent-plan gate (agent-plan.v2): PASSED in all 1 run(s)');
  });
});
