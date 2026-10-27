import { describe, expect, it } from 'vitest';
import { NL_CATALOG_ENTRY_IDS, NL_WAVE1_ENTRIES, buildAgentPlanPrompt, isNlWave1EntryId, parseAgentPlanOutput, prepareSelectionInput, type AiProvider } from '@quoky/core';
import {
  AGENT_PLAN_NEGATIVE_FAMILIES,
  AGENT_PLAN_POSITIVE_FAMILIES,
  agentPlanEvalCases,
  applyReadWriteProbe,
  buildAgentPlanEvalPlan,
  cappedProvider,
  caseContext,
  closedEntries,
  closedErrorName,
  computeAgentPlanEvalDigest,
  isAgentPlanAskExpect,
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
  AGENT_PLAN_ENTRY_HELP_TOPICS,
  agentPlanPooledGate,
  namedSourceHelpTopics,
  summaryDiffOf,
} from './agent-plan-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, formatAgentPlanSummary, runCli, type AgentPlanCliDeps } from './agent-plan-eval-cli';

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
  // Decision (h): a perfect planner writes the unbounded plan as asked (the corpus trap); Core turns it into the ask.
  if (isAgentPlanAskExpect(golden.gold)) return JSON.stringify(NEW.find((candidate) => candidate.id === golden.id)?.trap);
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
    // The planner sees what Core sends it: the rest of the owner's words after the help split (A1-E1).
    const prepared = caseContext(golden, FIXTURE);
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

  it('has >= 150 multi-step positives and >= 120 negatives in KO and EN, every family covered, the owner review applied', () => {
    const positives = NEW.filter((golden) => golden.expect !== 'none' && !isAgentPlanAskExpect(golden.expect));
    const negatives = NEW.filter((golden) => golden.expect === 'none' || isAgentPlanAskExpect(golden.expect));
    expect(positives.length).toBeGreaterThanOrEqual(150);
    expect(negatives.length).toBeGreaterThanOrEqual(120);
    for (const family of AGENT_PLAN_POSITIVE_FAMILIES) expect(positives.some((golden) => golden.family === family), family).toBe(true);
    for (const family of AGENT_PLAN_NEGATIVE_FAMILIES) expect(negatives.some((golden) => golden.family === family), family).toBe(true);
    for (const lang of ['ko', 'en'] as const) {
      expect(positives.some((golden) => golden.lang === lang)).toBe(true);
      expect(negatives.some((golden) => golden.lang === lang)).toBe(true);
    }
    // The owner's review of 2026-10-21: 258 approved; 15 fixed or unreviewed and 45 held (decisions (d) and (e)) pending.
    // + ap-p180 (was ap-n121) and ap-p177 (was ap-n120), approved by the owner's decisions of 2026-10-23.
    expect(NEW.filter((golden) => golden.status === 'approved')).toHaveLength(260);
    // + ap-n145..ap-n148 (position-write, reviews of 0bde31cc and f3e59814, agent-drafted): pending the owner.
    expect(NEW.filter((golden) => golden.status === 'pending-owner-approval')).toHaveLength(62);
    expect(NEW.filter((golden) => golden.note?.startsWith('HOLD') === true || golden.note?.includes(' HOLD ') === true).every((golden) => golden.status === 'pending-owner-approval')).toBe(true);
    // ap-n085's suggestion is shrunk to fit the 10-query charge (CA re-check W2): still 12 asks.
    expect(NEW.filter((golden) => isAgentPlanAskExpect(golden.expect)).map((golden) => golden.family)).toEqual(Array.from({ length: 12 }, () => 'unbounded'));
    const batches = new Map<string, number>();
    for (const golden of NEW) batches.set(golden.batch, (batches.get(golden.batch) ?? 0) + 1);
    expect([...batches.values()].every((size) => size <= 60)).toBe(true);
  });

  it('covers the required shapes: the owner example, refs, summaries, step-scoped periods, A6 traps', () => {
    expect(ownerExample().family).toBe('owner-example');
    const plans = NEW.flatMap((golden) => (golden.expect === 'none' || isAgentPlanAskExpect(golden.expect) ? [] : [golden.expect]));
    expect(plans.filter((plan) => plan.steps.some((step) => 'ref' in step && step.ref !== undefined)).length).toBeGreaterThanOrEqual(10);
    expect(plans.filter((plan) => plan.steps.some((step) => 'summarize' in step)).length).toBeGreaterThanOrEqual(30);
    expect(NEW.filter((golden) => golden.family === 'period-per-step').length).toBeGreaterThanOrEqual(15);
    expect(NEW.filter((golden) => golden.family === 'en-prenominal').length).toBeGreaterThanOrEqual(10);
    expect(NEW.filter((golden) => golden.trapRefusal === 'a6-in-plan').length).toBeGreaterThanOrEqual(10);
    expect(NEW.filter((golden) => golden.trapRefusal === 'ref-cross-source').length).toBeGreaterThanOrEqual(10);
  });

  it('references every nl-intent.v1.json case as one-step gold by id (Q11), never a copy', () => {
    expect(CORPUS.oneStep.count).toBe(873);
    expect(CORPUS.oneStep.ids).toEqual(ONE_STEP.map((golden) => golden.id));
    const oneStepTexts = new Set(ONE_STEP.map((golden) => golden.text));
    expect(NEW.filter((golden) => oneStepTexts.has(golden.text)).map((golden) => golden.id)).toEqual([]);
    expect(CASES.filter((golden) => golden.family === 'one-step')).toHaveLength(873);
  });

  it('a perfect planner scores 100% in both groups (the widened date rule grounds calendar-019 and calendar-038)', async () => {
    const plan = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, runs: 1, includePending: true });
    const records = await runAgentPlanEvaluation({ cases: CASES, plan, provider: goldProvider(CASES) });
    const summary = summarizeAgentPlanRun(records, plan.callTimeoutMs);
    const notExact = records.filter((record) => record.expected === 'plan' && record.outcome !== 'exact');
    expect(notExact.map((record) => `${record.id}:${record.outcome}:${record.reason ?? ''}`)).toEqual([]);
    // 174 + the six help-brief-split positives (ap-p175..ap-p180, formerly ap-n118..ap-n123) + the five item-summary-ref
    // positives (ap-p185..ap-p189; owner decision of 2026-10-26, the one-shot list + item summary).
    expect(summary.groups.multiStep).toEqual({ total: 185, exact: 185, rate: 1 });
    // + the four capability-help one-step plan golds of the owner's decisions of 2026-10-26 (ap-p181..ap-p184).
    expect(summary.groups.oneStep).toEqual({ total: 678, exact: 678, rate: 1 });
    expect(summary.groups.ask).toEqual({ total: 12, exact: 12, rate: 1 });
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
    ['a one-step positive', { ...positive, expect: { steps: [{ entryId: 'jira.issues', args: {} }], ambiguity: 'CLEAR' } }, /at least two sections/],
    ['a non-canonical gold (the calendar default written out)', { ...positive, text: '오늘 회의 정리하고 관련 jira 이슈도 같이 봐줘', expect: { steps: [{ entryId: 'calendar.events', args: { range: 'today', timedOnly: true } }, { summarize: [1], schema: 'meeting-digest.v1' }, { entryId: 'jira.issues', args: {} }], ambiguity: 'CLEAR' } }, /not canonical/],
    ['a gold the validator refuses (a cross-source ref)', { ...positive, expect: { steps: [{ entryId: 'mail.list', args: {} }, { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'messageIds', take: 3 } }], ambiguity: 'CLEAR' } }, /refused \(ref-cross-source/],
    ['a trap the validator accepts', { ...trapCase, trap: { steps: [{ entryId: 'jira.issues', args: {} }, { entryId: 'todo.list', args: {} }], ambiguity: 'CLEAR' }, trapRefusal: undefined as never }, /trap validates to an executable plan/],
    ['a trap refused for another reason', { ...trapCase, trapRefusal: 'ref-cross-source' }, /refused as a6-in-plan, not ref-cross-source/],
  ])('%s', (_label, bad, problem) => {
    expect(check([bad]).join('\n')).toMatch(problem);
  });

  it('A1-E4: a help section must be the one Core\'s split gives, and only a positive names one', () => {
    const split = NEW.find((golden) => golden.id === 'ap-p175') as AgentPlanCase;
    expect(check([split])).toEqual([]);
    expect(check([{ ...split, help: 'todo' }]).join('\n')).toMatch(/the help split gives all, not todo/);
    const { help: _help, ...noHelp } = split;
    expect(check([noHelp]).join('\n')).toMatch(/the help split gives all, not no help section/);
    expect(check([{ ...positive, help: 'all' }]).join('\n')).toMatch(/the help split gives no help section, not all/);
    expect(check([{ ...trapCase, help: 'all' }]).join('\n')).toMatch(/only a positive names a help section/);
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
    // The owner example's gold names the related step (CA finding 5 of S2 P3 part 1).
    const related = (value: unknown[]): string => JSON.stringify({ steps: value, ambiguity: 'CLEAR', related: 1 });
    expect(score(owner, related(gold)).outcome).toBe('exact');
    expect(score(owner, '```json\n' + related([{ entryId: 'calendar.events', args: { timedOnly: true, range: 'this-week' } }, gold[1], { entryId: 'jira.issues', args: { status: 'open' } }]) + '\n```').outcome).toBe('exact');
  });

  it.each<[string, unknown[], string]>([
    ['another arg', [gold[0], gold[1], { entryId: 'jira.issues', args: { status: 'all' } }], 'args'],
    ['another entry', [gold[0], gold[1], { entryId: 'github.items', args: {} }], 'entry'],
    ['another schema', [gold[0], { summarize: [1], schema: 'digest.v1' }, gold[2]], 'summary'],
    ['a missing summary', [gold[0], gold[2]], 'step-count'],
  ])('%s is a miss with a closed diff kind', (_label, answer, diff) => {
    expect(score(owner, steps(answer))).toMatchObject({ outcome: 'miss', diff });
  });

  it('owner decision of 2026-10-26: Core places each summary right after the last read it covers, so another order is exact', () => {
    const related = (value: unknown[]): string => JSON.stringify({ steps: value, ambiguity: 'CLEAR', related: 1 });
    expect(score(owner, related([gold[0], gold[2], { summarize: [1], schema: 'meeting-digest.v1' }])).outcome).toBe('exact');
    // Order only: another scope stays a miss.
    expect(score(owner, related([gold[0], gold[2], { summarize: [1, 2], schema: 'digest.v1' }])).outcome).toBe('miss');
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

  it('decision (h): an unbounded answer is asked with the gold suggestion; another suggestion is ask-other; a run is wrong', () => {
    const golden = byId('ap-n075');
    const trap = NEW.find((candidate) => candidate.id === 'ap-n075')?.trap;
    expect(score(golden, JSON.stringify(trap))).toMatchObject({ outcome: 'asked', reason: 'unbounded:per-period' });
    // Days inside this week narrow to this-week: another suggestion than the gold's this-month.
    expect(score(golden, steps(['this-mon', 'this-tue', 'this-wed'].map((range) => ({ entryId: 'calendar.events', args: { range } }))))).toMatchObject({ outcome: 'ask-other' });
    expect(score(golden, steps([{ entryId: 'calendar.events', args: {} }, { entryId: 'todo.list', args: {} }])).outcome).toBe('wrong');
    expect(score(golden, none).outcome).toBe('none');
    // CA P2: on a `none` gold (a negative of any other family) an ask is wrong.
    const venting = byId((NEW.find((candidate) => candidate.family === 'venting') as AgentPlanCase).id);
    expect(score(venting, steps(['this-mon', 'this-tue', 'this-wed'].map((range) => ({ entryId: 'calendar.events', args: { range } }))))).toMatchObject({ outcome: 'wrong' });
    // On a positive an ask is never exact.
    expect(score(owner, steps(['this-mon', 'this-tue', 'this-wed'].map((range) => ({ entryId: 'calendar.events', args: { range } })))).outcome).toBe('ask-other');
  });

  it('a one-step gold is scored in the selection form and in the steps form alike', () => {
    const golden = byId('jira-003');
    const want = golden.gold as { steps: Array<{ entryId: string; args?: Record<string, unknown> }> };
    const step = want.steps[0] as { entryId: string; args?: Record<string, unknown> };
    expect(score(golden, JSON.stringify({ entryId: step.entryId, args: step.args, ambiguity: 'CLEAR', alternatives: [] })).outcome).toBe('exact');
    expect(score(golden, steps([step])).outcome).toBe('exact');
  });

  it('the selection path vetoes are validator rules: a past statement is refused as veto-past-statement', () => {
    const past = byId((NEW.find((golden) => golden.text === '아침에 일정이랑 할 일 정리 끝났다') as AgentPlanCase).id);
    expect(score(past, steps([{ entryId: 'calendar.events', args: {} }, { entryId: 'todo.list', args: {} }, { summarize: [1, 2], schema: 'digest.v1' }]))).toMatchObject({ outcome: 'refused', reason: 'veto-past-statement' });
  });

  const record = (id: string, outcome: AgentPlanEvalRecord['outcome'], expected: 'plan' | 'none', latencyMs: number, goldEntries: string[] = [], family = expected === 'plan' ? 'compound' : 'venting'): AgentPlanEvalRecord => ({ run: 1, id, family, expected, goldEntries, outcome, latencyMs });
  const oneStep = (count: number, outcome: AgentPlanEvalRecord['outcome'] = 'exact', latencyMs = 1000): AgentPlanEvalRecord[] =>
    Array.from({ length: count }, (_, i) => record(`o${i}-${outcome}`, outcome, 'plan', latencyMs, ['calendar.events'], 'one-step'));

  it('summarizes per group, per family and per entry, counts wrong on negatives and the share over the bound', () => {
    const records = [
      ...Array.from({ length: 97 }, (_, i) => record(`p${i}`, 'exact', 'plan', 1000, ['jira.issues', 'summarize'])),
      record('p97', 'miss', 'plan', 1000, ['jira.issues']),
      record('p98', 'timeout', 'plan', 6001, ['mail.list']),
      ...oneStep(100),
      record('n1', 'none', 'none', 900),
    ];
    const summary = summarizeAgentPlanRun(records, 6000);
    expect(summary).toMatchObject({ positives: 199, exact: 197, negatives: 1, wrongOnNegatives: 0, calls: 200, capped: 0, gating: true });
    expect(summary.groups).toEqual({ multiStep: { total: 99, exact: 97, rate: 97 / 99 }, oneStep: { total: 100, exact: 100, rate: 1 }, ask: { total: 0, exact: 0, rate: 0 } });
    expect(summary.perEntry['jira.issues']).toEqual({ total: 98, exact: 97, rate: 97 / 98 });
    expect(summary.perEntry['mail.list']).toEqual({ total: 1, exact: 0, rate: 0 });
    expect(summary.perFamily['compound']).toMatchObject({ positives: 99, exact: 97 });
    expect(summary.overBoundRate).toBe(0.005);
    expect(summary.gatePassed).toBe(true);
    expect(summarizeAgentPlanRun([...records, ...oneStep(2, 'timeout', 6001)], 6000).gatePassed).toBe(false);
    expect(summarizeAgentPlanRun([...records, record('n2', 'wrong', 'none', 800)], 6000).gatePassed).toBe(false);
    expect(summarizeAgentPlanRun([...records, record('p99', 'capped', 'plan', 0)], 6000).gatePassed).toBe(false);
    // CA P2: the ask group is gated when present: 19 of 20 asked passes, 18 of 20 fails.
    const asks = (asked: number) => Array.from({ length: 20 }, (_, i) => ({ ...record(`a${i}`, i < asked ? 'asked' : 'ask-other', 'none', 900), expected: 'ask' as const, family: 'unbounded' }));
    expect(summarizeAgentPlanRun([...records, ...asks(19)], 6000).gatePassed).toBe(true);
    expect(summarizeAgentPlanRun([...records, ...asks(18)], 6000).gatePassed).toBe(false);
  });

  it('gates each group on its own (CA P1): a 75% multi-step group fails even when the overall rate is above 95%', () => {
    const records = [
      ...Array.from({ length: 30 }, (_, i) => record(`p${i}`, 'exact', 'plan', 1000)),
      ...Array.from({ length: 10 }, (_, i) => record(`m${i}`, 'miss', 'plan', 1000)),
      ...oneStep(800),
    ];
    const summary = summarizeAgentPlanRun(records, 6000);
    expect(summary.exactRate).toBeGreaterThan(0.95);
    expect(summary.groups.multiStep.rate).toBe(0.75);
    // Owner decision of 2026-10-26: the run's own checks pass; the multi-step rate is judged pooled, and fails there.
    expect(summary.gatePassed).toBe(true);
    expect(agentPlanPooledGate([summary])).toMatchObject({ multiStepPassed: false, runsPassed: 1, passed: false });
    // And the other way round: a weak one-step group fails too.
    const weakOneStep = summarizeAgentPlanRun([...Array.from({ length: 200 }, (_, i) => record(`p${i}`, 'exact', 'plan', 1000)), ...oneStep(18), ...oneStep(2, 'miss')], 6000);
    expect(weakOneStep.groups.oneStep.rate).toBe(0.9);
    expect(weakOneStep.gatePassed).toBe(false);
    // Both groups must be present.
    expect(summarizeAgentPlanRun(oneStep(100), 6000).gatePassed).toBe(false);
    expect(summarizeAgentPlanRun(Array.from({ length: 100 }, (_, i) => record(`p${i}`, 'exact', 'plan', 1000)), 6000).gatePassed).toBe(false);
  });

  it('a non-gating summary (--include-pending) never passes', () => {
    const records = [...Array.from({ length: 100 }, (_, i) => record(`p${i}`, 'exact', 'plan', 1000)), ...oneStep(100)];
    expect(summarizeAgentPlanRun(records, 6000).gatePassed).toBe(true);
    expect(summarizeAgentPlanRun(records, 6000, { gating: false })).toMatchObject({ gating: false, gatePassed: false });
  });
});

describe('hostile planner output never reaches the report (Codex P2)', () => {
  const owner = byId(ownerExample().id);
  const negative = byId((NEW.find((golden) => golden.family === 'cross-source-join') as AgentPlanCase).id);
  const SECRET_SCHEMA = 'private-project-name.v1';
  const SECRET_ENTRY = 'secret-proj.lookup';
  const hostile = [
    steps([{ entryId: 'jira.issues', args: {} }, { summarize: [1], schema: SECRET_SCHEMA }]),
    steps([{ entryId: 'jira.issues', args: {} }, { entryId: SECRET_ENTRY, args: { keyword: 'zebra-canary' } }]),
    steps([{ entryId: 'calendar.events', args: { timedOnly: true } }, { summarize: [1], schema: 'meeting-digest.v9' }, { entryId: SECRET_ENTRY, args: {} }]),
    JSON.stringify({ entryId: SECRET_ENTRY, args: { keyword: 'zebra-canary' }, ambiguity: 'CLEAR', alternatives: [] }),
  ];

  it('a model-made summary schema or entry id is summarize:unknown / unknown in every score field', () => {
    for (const raw of hostile) {
      for (const golden of [owner, negative]) {
        const scored = scoreAgentPlanOutput(golden, raw, FIXTURE);
        const text = JSON.stringify(scored);
        expect(text, raw).not.toContain('private-project-name');
        expect(text, raw).not.toContain('secret-proj');
        expect(text, raw).not.toContain('zebra-canary');
        expect(text, raw).not.toContain('meeting-digest.v9');
        for (const entry of scored.gotEntries ?? []) {
          expect(['none', 'unknown', 'summarize:unknown', 'summarize:digest.v1', 'summarize:meeting-digest.v1', ...NL_CATALOG_ENTRY_IDS], entry).toContain(entry);
        }
      }
    }
    const parsed = parseAgentPlanOutput(hostile[0] as string);
    expect(parsed === null ? [] : closedEntries(parsed)).toEqual(['jira.issues', 'summarize:unknown']);
  });

  it('a provider-made error name is reported as other; closed names pass', () => {
    const named = (name: string): Error => Object.assign(new Error('private detail'), { name });
    expect(closedErrorName(named('PrivateProjectName'))).toBe('other');
    expect(closedErrorName('a string')).toBe('other');
    expect(closedErrorName(named('TypeError'))).toBe('TypeError');
  });

  it('a full run with hostile answers and hostile errors writes only closed values', async () => {
    const cases = CASES.filter((golden) => golden.family !== 'one-step');
    const plan = buildAgentPlanEvalPlan(cases, HASHES, FIXTURE, { ...OPTIONS, runs: 1, includePending: true });
    let call = 0;
    const provider = {
      id: 'scripted',
      capabilities: [],
      isAvailable: async () => true,
      execute: async () => {
        call += 1;
        if (call % 5 === 0) throw Object.assign(new Error('zebra-canary'), { name: 'PrivateProjectName' });
        return { text: hostile[call % hostile.length] as string };
      },
    } as unknown as AiProvider;
    const records = await runAgentPlanEvaluation({ cases, plan, provider });
    const report = JSON.stringify({ records, summary: summarizeAgentPlanRun(records, plan.callTimeoutMs) });
    for (const secret of ['private-project-name', 'secret-proj', 'zebra-canary', 'meeting-digest.v9', 'PrivateProjectName']) expect(report).not.toContain(secret);
    expect(records.some((record) => record.error === 'other')).toBe(true);
    expect(records.some((record) => record.gotEntries?.includes('summarize:unknown'))).toBe(true);
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

  it('approved-only scores the 873 one-step cases and the approved new cases; --include-pending adds every pending case; the bound is cases x runs', () => {
    const approved = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, OPTIONS);
    const pending = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, includePending: true });
    const approvedCount = 873 + NEW.filter((golden) => golden.status === 'approved').length;
    expect(approvedCount).toBe(873 + 260);
    expect(approved.caseIds).toHaveLength(approvedCount);
    expect(pending.caseIds).toHaveLength(873 + NEW.length);
    // The read + write probe bound (owner-ratified 2026-10-26): one more call for each case of two or more conjuncts.
    expect(approved.readWriteProbe).toMatchObject({ promptVersion: 'nl-select.v68', maxCallsPerRun: expect.any(Number) });
    expect(approved.readWriteProbe.maxCallsPerRun).toBeGreaterThan(0);
    expect(approved.readWriteProbe.maxCallsPerRun).toBeLessThan(approvedCount);
    expect(approved.maxCalls).toBe((approvedCount + approved.readWriteProbe.maxCallsPerRun) * 3);
    expect(pending.maxCalls).toBe((873 + NEW.length + pending.readWriteProbe.maxCallsPerRun) * 3);
    // The probe prompt is bound into the digest.
    expect(computeAgentPlanEvalDigest({ ...approved, readWriteProbe: { ...approved.readWriteProbe, promptSha256: '0'.repeat(64) } })).not.toBe(computeAgentPlanEvalDigest(approved));
    expect(approved).toMatchObject({ kind: 'agent-plan-eval', promptVersion: 'agent-plan.v9', callTimeoutMs: 6000, fixture: FIXTURE });
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
    expect(text).toContain('"promptVersion": "agent-plan.v9"');
    expect(text).toContain(`"corpusSha256": "${LOADED.sha256}"`);
    expect(text).toContain(`"gitHead": "${'a'.repeat(40)}"`);
    const approvedCount = 873 + NEW.filter((golden) => golden.status === 'approved').length;
    const bound = /at most (\d+) \(\((\d+) planner calls \+ up to (\d+) read \+ write probe calls, nl-select\.v68\) x 3 run\(s\)/.exec(text);
    expect(bound).not.toBeNull();
    const [, total, planner, probes] = (bound as RegExpExecArray).map(Number);
    expect(planner).toBe(approvedCount);
    expect(total).toBe(((planner as number) + (probes as number)) * 3);
    expect(created).toEqual([]);
    const withPending = deps(created);
    expect(await runCli(['--mode', 'plan', '--runs', '3', '--include-pending'], withPending)).toBe(EXIT_OK);
    expect(digestOf(withPending.out)).not.toBe(digestOf(planned.out));
    const pendingPlan = buildAgentPlanEvalPlan(CASES, HASHES, FIXTURE, { ...OPTIONS, includePending: true });
    expect(withPending.out.join('\n')).toContain(`at most ${(873 + NEW.length + pendingPlan.readWriteProbe.maxCallsPerRun) * 3}`);
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
    expect(await runCli(['--mode', 'run', '--include-pending', '--approved-plan-digest', digest], ran)).toBe(EXIT_NON_GATING);
    expect(ran.out.join('\n')).not.toContain('PASSED');
    expect(ran.out.join('\n')).toContain('NON-GATING');
    expect(created).toEqual(['haiku']);
    const skipped = CASES.filter((golden) => 'skip' in prepareSelectionInput(golden.text, golden.attachments)).length;
    expect(skipped).toBeLessThanOrEqual(2);
    expect(calls).toBe(873 + NEW.length - skipped);
    const everything = [...ran.reports, ...ran.out, ...ran.err].join('\n');
    expect(everything).not.toContain(canary);
    const texts = CASES.map((golden) => golden.text).filter((text) => Array.from(text).length >= 12);
    expect(texts.filter((text) => everything.includes(text))).toEqual([]);
    for (const value of ['인사발령', '마이그레이션 가이드', '김부장님', 'security policy']) expect(everything).not.toContain(value);
    const report = JSON.parse(ran.reports[0] as string) as { plan: { digest: string }; records: AgentPlanEvalRecord[] };
    expect(report.plan.digest).toBe(digest);
    expect(report.records).toHaveLength(873 + NEW.length);
    expect(Object.keys(report.records[0] as object).sort()).toEqual(expect.arrayContaining(['id', 'family', 'outcome', 'latencyMs', 'run']));
  });

  it('a perfect planner passes the gate end to end once the batches are approved; approved-only without them cannot pass', async () => {
    const approved = { ...LOADED, corpus: { ...CORPUS, cases: NEW.map((golden) => ({ ...golden, status: 'approved' as const })) } };
    const created: string[] = [];
    const planned = { ...deps(created), load: () => approved };
    await runCli(['--mode', 'plan', '--runs', '3'], planned);
    const ran = { ...deps(created), load: () => approved };
    expect(await runCli(['--mode', 'run', '--runs', '3', '--approved-plan-digest', digestOf(planned.out)], ran)).toBe(EXIT_OK);
    expect(ran.out.join('\n')).toContain('multi-step exact: 185/185 (100.0%)  one-step exact: 678/678 (100.0%)  ask: 12/12');
    expect(ran.out.join('\n')).toContain('agent-plan gate (agent-plan.v9): PASSED (multi-step pooled 555/555 (100.0%) >= 95%; run checks passed in 3 of 3 run(s))');
    // With every new case pending, an approved-only run has no multi-step group, so it cannot pass.
    const unapproved = { ...LOADED, corpus: { ...CORPUS, cases: NEW.map((golden) => ({ ...golden, status: 'pending-owner-approval' as const })) } };
    const today = { ...deps(created), load: () => unapproved };
    await runCli(['--mode', 'plan', '--runs', '3'], today);
    const ranToday = { ...deps(created), load: () => unapproved };
    expect(await runCli(['--mode', 'run', '--runs', '3', '--approved-plan-digest', digestOf(today.out)], ranToday)).toBe(EXIT_GATE_FAILED);
    // CA W2 (review of 0bde31cc): a gating verdict needs exactly 3 runs; one run is NON-GATING (exit 4, no verdict).
    const one = { ...deps(created), load: () => approved };
    await runCli(['--mode', 'plan', '--runs', '1'], one);
    const ranOne = { ...deps(created), load: () => approved };
    expect(await runCli(['--mode', 'run', '--runs', '1', '--approved-plan-digest', digestOf(one.out)], ranOne)).toBe(EXIT_NON_GATING);
    expect(ranOne.out.join('\n')).toContain('NON-GATING (the gate needs exactly 3 runs; this plan has 1; no verdict)');
  });
});

describe('the help split in scoring (ADR-0121 A1-E1 / A1-E4, S2 P3)', () => {
  it('the planner is scored on the rest: the exact rest plan with the gold help section is exact', () => {
    const golden = byId('ap-p175');
    expect(golden.help).toBe('all');
    const one = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    expect(scoreAgentPlanOutput(golden, one, FIXTURE)).toMatchObject({ outcome: 'exact' });
    // The same answer for a gold with no help section: the split's extra section is a miss.
    const { help: _help, ...noHelp } = golden;
    expect(scoreAgentPlanOutput(noHelp, one, FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'help' });
  });

  it('the brief as a plan step is exact; a summary over the brief is refused (summary-covers-brief)', () => {
    const golden = byId('ap-p178');
    expect(scoreAgentPlanOutput(golden, steps([{ entryId: 'brief.today' }, { entryId: 'jira.issues' }, { summarize: [2], schema: 'digest.v1' }]), FIXTURE)).toMatchObject({ outcome: 'exact' });
    expect(scoreAgentPlanOutput(golden, steps([{ entryId: 'brief.today' }, { entryId: 'jira.issues' }, { summarize: [1, 2], schema: 'digest.v1' }]), FIXTURE)).toMatchObject({ outcome: 'refused', reason: 'summary-covers-brief' });
  });

  it('owner Q2 and the English decision: ap-p180 (was ap-n121) splits at -고; ap-p177 (was ap-n120) splits too', () => {
    const split = byId('ap-p180');
    expect(caseContext(split, FIXTURE)).toMatchObject({ split: { topic: 'all', rest: '안 읽은 메일도 보여줘' } });
    expect(scoreAgentPlanOutput(split, JSON.stringify({ entryId: 'mail.list', args: { unread: true }, ambiguity: 'CLEAR', alternatives: [] }), FIXTURE)).toMatchObject({ outcome: 'exact' });
    const english = byId('ap-p177');
    expect(caseContext(english, FIXTURE)).toMatchObject({ split: { topic: 'all', rest: 'show my github PRs' } });
    expect(scoreAgentPlanOutput(english, JSON.stringify({ entryId: 'github.items', args: { kind: 'pr' }, ambiguity: 'CLEAR', alternatives: [] }), FIXTURE)).toMatchObject({ outcome: 'exact' });
  });

  it('CA finding 5: the related step is scored (missing or another step is a miss)', () => {
    const golden = byId('ap-p001');
    const gold = golden.gold as { steps: unknown[]; related?: number };
    expect(gold.related).toBe(1);
    const answer = (related?: number): string => JSON.stringify({ steps: gold.steps, ambiguity: 'CLEAR', ...(related !== undefined ? { related } : {}) });
    expect(scoreAgentPlanOutput(golden, answer(1), FIXTURE)).toMatchObject({ outcome: 'exact' });
    expect(scoreAgentPlanOutput(golden, answer(), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'related' });
    expect(scoreAgentPlanOutput(golden, answer(3), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'related' });
  });
});

describe('the ratified read + write note (owner decision Q3, 2026-10-23): readWrite expectations on the write-read negatives', () => {
  const annotated = NEW.filter((golden) => golden.readWrite !== undefined);
  const check = (cases: AgentPlanCase[]): string[] => validateAgentPlanCorpus({ ...CORPUS, cases }, ONE_STEP);

  it('every write-read and a6-in-plan negative carries one; the planner gold stays none', () => {
    const families = NEW.filter((golden) => golden.family === 'write-read' || golden.family === 'a6-in-plan').map((golden) => golden.id).sort();
    expect(annotated.map((golden) => golden.id).sort()).toEqual(families);
    // The planner gold stays none (the one-shot item summaries of 2026-10-26 left these families: item-summary-ref).
    expect(annotated.filter((golden) => golden.expect !== 'none').map((golden) => golden.id)).toEqual([]);
    const count = (outcome: string): number => annotated.filter((golden) => golden.readWrite?.outcome === outcome).length;
    expect({ write: count('read-and-write'), note: count('read-and-note'), unchanged: count('unchanged') }).toEqual({ write: 8, note: 7, unchanged: 12 });
  });

  it('the self-check catches a write that takes read words, a clause that is no conjunct, and a wrong conjunct count', () => {
    const base = NEW.find((golden) => golden.id === 'ap-n001') as AgentPlanCase;
    const rw = base.readWrite as NonNullable<AgentPlanCase['readWrite']>;
    expect(check([{ ...base, readWrite: { ...rw, write: { entryId: 'todo.add', args: { title: '지라 이슈' } } } }]).join('\n')).toMatch(/does not validate on the write clause alone/);
    expect(check([{ ...base, readWrite: { ...rw, writeClause: '코드 리뷰 추가해줘' } }]).join('\n')).toMatch(/not one conjunct/);
    expect(check([{ ...base, readWrite: { outcome: 'unchanged', why: 'one-conjunct' } }]).join('\n')).toMatch(/one-conjunct but 2 conjuncts/);
    // A read arg grounded only in the write clause ("리뷰") never validates on the read conjuncts.
    expect(check([{ ...base, readWrite: { ...rw, readPlan: { steps: [{ entryId: 'jira.issues', args: { keyword: '리뷰' } }], ambiguity: 'CLEAR' } } }]).join('\n')).toMatch(/read plan does not validate/);
  });
});

describe('owner decisions of 2026-10-26: relabels and the help-capture rule of the agent-plan gate', () => {
  it('the relabels: ap-p096 kind issue, ap-p066 both reads scoped by budget, four capability questions; the item-summary-ref plans', () => {
    const plan = (id: string): unknown => (NEW.find((golden) => golden.id === id) as AgentPlanCase).expect;
    expect(plan('ap-p096')).toMatchObject({ steps: [{ entryId: 'github.items', args: { kind: 'issue' } }, { entryId: 'jira.issues' }, { summarize: [1, 2] }] });
    expect(plan('ap-p066')).toMatchObject({ steps: [{ entryId: 'drive.files', args: { kind: 'spreadsheet', name: 'budget' } }, { entryId: 'confluence.search', args: { keyword: 'budget' } }] });
    const moved = NEW.filter((golden) => golden.formerId !== undefined && golden.family !== 'help-brief-split');
    expect(moved.map((golden) => `${golden.formerId}->${golden.id}:${golden.family}`)).toEqual([
      'ap-n051->ap-p181:capability-help',
      'ap-n054->ap-p182:capability-help',
      'ap-n055->ap-p183:capability-help',
      'ap-n057->ap-p184:capability-help',
      'ap-n125->ap-p185:item-summary-ref',
      'ap-n126->ap-p186:item-summary-ref',
      'ap-n129->ap-p187:item-summary-ref',
      'ap-n132->ap-p188:item-summary-ref',
      'ap-n136->ap-p189:item-summary-ref',
    ]);
    for (const id of ['ap-p181', 'ap-p182', 'ap-p183', 'ap-p184']) expect(plan(id)).toEqual({ steps: [{ entryId: 'help.topic', args: {} }], ambiguity: 'CLEAR' });
    // Owner decision of 2026-10-26 (one-shot list + item summary): the list read, the position reference, the summary.
    expect(plan('ap-p185')).toEqual({
      steps: [{ entryId: 'jira.issues', args: {} }, { entryId: 'jira.issues', args: {}, ref: { step: 1, field: 'issueKeys', take: 1, at: 1 } }, { summarize: [2], schema: 'digest.v1' }],
      ambiguity: 'CLEAR',
    });
    expect(plan('ap-p187')).toMatchObject({ steps: [{ entryId: 'jira.issues' }, { ref: { field: 'issueKeys', at: 2 } }, { summarize: [2] }] });
    expect(plan('ap-p188')).toMatchObject({ steps: [{ entryId: 'mail.list' }, { entryId: 'mail.list', ref: { field: 'messageIds', at: 3 } }, { summarize: [2] }] });
    for (const id of ['ap-p185', 'ap-p186', 'ap-p187', 'ap-p188', 'ap-p189']) expect(NEW.find((golden) => golden.id === id)?.readWrite).toBeUndefined();
  });

  const record = (id: string, expected: 'plan' | 'none', outcome: AgentPlanEvalRecord['outcome'], gotEntries: string[] = []): AgentPlanEvalRecord => ({
    run: 1, id, family: expected === 'none' ? 'quoted-request' : 'compound', expected, goldEntries: [], outcome, gotEntries, latencyMs: 100,
  });
  const base = (): AgentPlanEvalRecord[] => [
    ...Array.from({ length: 20 }, (_, i) => record(`ap-p${i}`, 'plan', 'exact')),
    ...Array.from({ length: 20 }, (_, i) => ({ ...record(`one-${i}`, 'plan', 'exact'), family: 'one-step' })),
    ...Array.from({ length: 250 }, (_, i) => record(`ap-n${i}`, 'none', 'none')),
  ];

  it('help.topic-only plans on negatives are help captures, allowed ceil(1% of negatives); every other wrong stays zero', () => {
    const records = base();
    records[40] = record('ap-n0', 'none', 'wrong', ['help.topic']);
    records[41] = record('ap-n1', 'none', 'wrong', ['help.topic']);
    records[42] = record('ap-n2', 'none', 'wrong', ['help.topic']);
    const within = summarizeAgentPlanRun(records, 6000);
    expect(within).toMatchObject({ helpCaptures: 3, helpAllowance: 3, helpOverAllowance: 0, wrongOnNegatives: 0, gatePassed: true });
    records[43] = record('ap-n3', 'none', 'wrong', ['help.topic']);
    expect(summarizeAgentPlanRun(records, 6000)).toMatchObject({ helpCaptures: 4, helpOverAllowance: 1, gatePassed: false });
    const data = base();
    data[40] = record('ap-n0', 'none', 'wrong', ['jira.issues']);
    expect(summarizeAgentPlanRun(data, 6000)).toMatchObject({ helpCaptures: 0, wrongOnNegatives: 1, gatePassed: false });
    // help.topic with another step is no help capture (zero-tolerance).
    data[40] = record('ap-n0', 'none', 'wrong', ['help.topic', 'jira.issues']);
    expect(summarizeAgentPlanRun(data, 6000)).toMatchObject({ helpCaptures: 0, wrongOnNegatives: 1 });
  });

  it('the gate line prints the help captures and their allowance', () => {
    const records = base();
    records[40] = record('ap-n0', 'none', 'wrong', ['help.topic']);
    const text = formatAgentPlanSummary(summarizeAgentPlanRun(records, 6000)).join('\n');
    expect(text).toContain('help captures: 1 (allowed 3 = ceil(1% of 250))');
    expect(text).toContain('help captures <= 3 = ceil(1% of 250 negatives)');
  });
});

describe('owner decision of 2026-10-26: the multi-step rate is pooled over the runs; every other check stays per run', () => {
  const rec = (run: number, id: string, outcome: AgentPlanEvalRecord['outcome'], expected: 'plan' | 'none' = 'plan', family = 'compound'): AgentPlanEvalRecord => ({
    run, id, family: expected === 'none' ? 'quoted-request' : family, expected, goldEntries: [], outcome, gotEntries: [], latencyMs: 100,
  });
  // One run: `misses` of 166 multi-step positives missed, 100 one-step positives exact, 288 negatives none.
  const run = (n: number, misses: number, extra: AgentPlanEvalRecord[] = []): AgentPlanEvalRecord[] => [
    ...Array.from({ length: 166 }, (_, i) => rec(n, `ap-p${i}`, i < misses ? 'miss' : 'exact')),
    ...Array.from({ length: 100 }, (_, i) => rec(n, `one-${i}`, 'exact', 'plan', 'one-step')),
    ...Array.from({ length: 288 }, (_, i) => rec(n, `ap-n${i}`, 'none', 'none')),
    ...extra,
  ];
  const gate = (runs: AgentPlanEvalRecord[][]) => agentPlanPooledGate(runs.map((records) => summarizeAgentPlanRun(records, 6000)));

  it('94.6 / 95.2 / 95.8% (the ed45e3f1 runs) pool to 95.2%: passed; 9 / 9 / 9 misses pool to 94.6%: failed', () => {
    expect(gate([run(1, 9), run(2, 8), run(3, 7)])).toMatchObject({ multiStep: { total: 498, exact: 474 }, multiStepPassed: true, runsPassed: 3, passed: true });
    expect(gate([run(1, 9), run(2, 9), run(3, 9)])).toMatchObject({ multiStepPassed: false, passed: false });
  });

  it('a wrong on a negative, help captures over the allowance or a weak one-step group in ONE run fail the gate', () => {
    const wrong = [rec(2, 'ap-n999', 'wrong', 'none')];
    expect(gate([run(1, 0), run(2, 0, wrong), run(3, 0)])).toMatchObject({ multiStepPassed: true, runsPassed: 2, passed: false });
    const help = Array.from({ length: 4 }, (_, i) => ({ ...rec(3, `ap-h${i}`, 'wrong', 'none'), gotEntries: ['help.topic'] }));
    expect(gate([run(1, 0), run(2, 0), run(3, 0, help)])).toMatchObject({ runsPassed: 2, passed: false });
    const weak = Array.from({ length: 10 }, (_, i) => rec(1, `one-x${i}`, 'miss', 'plan', 'one-step'));
    expect(gate([run(1, 0, weak), run(2, 0), run(3, 0)])).toMatchObject({ runsPassed: 2, passed: false });
  });

  it('a non-gating run never passes', () => {
    expect(agentPlanPooledGate([summarizeAgentPlanRun(run(1, 0), 6000, { gating: false })]).passed).toBe(false);
    expect(agentPlanPooledGate([]).passed).toBe(false);
  });
});

describe('gate on ed45e3f1: an args miss names the differing declared args (no value)', () => {
  it('reports the arg names only', () => {
    const golden = byId('ap-p127');
    const raw = JSON.stringify({ steps: [{ entryId: 'calendar.events', args: { range: 'next-week', timedOnly: true } }, { entryId: 'jira.issues', args: { range: 'last-week' } }], ambiguity: 'CLEAR' });
    expect(scoreAgentPlanOutput(golden, raw, FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args', diffStep: 2, diffArgs: expect.arrayContaining(['window']) });
  });
});

describe('capability-help golds: a named source\'s help topic is also correct (owner decision of 2026-10-26)', () => {
  const topicPlan = (topic?: string): string => JSON.stringify({ entryId: 'help.topic', args: topic === undefined ? {} : { topic }, ambiguity: 'CLEAR', alternatives: [] });

  it('the entry -> help topic table is the structural mapping (every source entry, from the handlers\' own help lines)', () => {
    expect(AGENT_PLAN_ENTRY_HELP_TOPICS).toEqual({
      'jira.issues': 'work-lookup',
      'jira.release': 'work-lookup',
      'github.items': 'work-lookup',
      'slack.search': 'work-lookup',
      'confluence.search': 'work-lookup',
      'calendar.events': 'calendar',
    });
    // Gmail and Drive share one merged help line in the production composition (it answers two topics): no topic, so a
    // help.topic plan naming mail or drive is scored as the general gold only, exactly as the help-scope option answers.
    expect(AGENT_PLAN_ENTRY_HELP_TOPICS['mail.list']).toBeUndefined();
    expect(AGENT_PLAN_ENTRY_HELP_TOPICS['drive.files']).toBeUndefined();
  });

  it('the named sources of each capability-help gold, by the runtime\'s own source match', () => {
    const named = (id: string): string[] => [...namedSourceHelpTopics(byId(id).text)].sort();
    expect(named('ap-p181')).toEqual([]);
    expect(named('ap-p182')).toEqual(['work-lookup']);
    expect(named('ap-p183')).toEqual([]);
    expect(named('ap-p184')).toEqual([]);
  });

  it('the general topic is exact; a named source\'s topic is exact; any other topic, or no named source, is a miss', () => {
    for (const id of ['ap-p181', 'ap-p182', 'ap-p183', 'ap-p184']) expect(scoreAgentPlanOutput(byId(id), topicPlan(), FIXTURE)).toMatchObject({ outcome: 'exact' });
    expect(scoreAgentPlanOutput(byId('ap-p182'), topicPlan('work-lookup'), FIXTURE)).toMatchObject({ outcome: 'exact', reason: 'source-help-topic' });
    expect(scoreAgentPlanOutput(byId('ap-p183'), topicPlan('drive'), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args' });
    expect(scoreAgentPlanOutput(byId('ap-p183'), topicPlan('calendar'), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args' });
    expect(scoreAgentPlanOutput(byId('ap-p182'), topicPlan('drive'), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args' });
    // No source named: only the general topic.
    expect(scoreAgentPlanOutput(byId('ap-p181'), topicPlan('calendar'), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args' });
    expect(scoreAgentPlanOutput(byId('ap-p184'), topicPlan('work-lookup'), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args' });
  });

  it('the acceptance is the capability-help family only (a help.topic gold elsewhere is scored as written)', () => {
    const other = { ...byId('ap-p182'), family: 'compound' };
    expect(scoreAgentPlanOutput(other, topicPlan('work-lookup'), FIXTURE)).toMatchObject({ outcome: 'miss', diff: 'args' });
  });
});

describe('Core\'s final outcome for help.topic plans on negatives (owner decisions of 2026-10-26)', () => {
  const help = JSON.stringify({ entryId: 'help.topic', args: {}, ambiguity: 'CLEAR', alternatives: [] });

  it('a general help.topic plan naming one source is Core\'s help-scope question: clarify, asked on a clarification gold', () => {
    const neg010 = byId('neg-010');
    expect(neg010.clarify).toMatchObject({ between: ['help.topic'] });
    expect(scoreAgentPlanOutput(neg010, help, FIXTURE)).toMatchObject({ outcome: 'clarify', reason: 'help-scope' });
    // A feature topic is the selector's own reading (the shared rule's topic gate): still a help capture there.
    const topic = JSON.stringify({ entryId: 'help.topic', args: { topic: 'work-lookup' }, ambiguity: 'CLEAR', alternatives: [] });
    expect(scoreAgentPlanOutput(neg010, topic, FIXTURE)).toMatchObject({ outcome: 'miss', reason: 'clarify-gold' });
  });

  it('ap-n115 is a clarification gold; Core now asks for it (two sources, owner decision 2026-10-26): asked', () => {
    const golden = byId('ap-n115');
    expect(golden.clarify).toMatchObject({ between: ['help.topic'] });
    expect(scoreAgentPlanOutput(golden, help, FIXTURE)).toMatchObject({ outcome: 'clarify', reason: 'help-scope' });
    const topic = JSON.stringify({ entryId: 'help.topic', args: { topic: 'calendar' }, ambiguity: 'CLEAR', alternatives: [] });
    expect(scoreAgentPlanOutput(golden, topic, FIXTURE)).toMatchObject({ outcome: 'miss', reason: 'clarify-gold' });
    const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    expect(scoreAgentPlanOutput(golden, none, FIXTURE)).toMatchObject({ outcome: 'none' });
  });

  it('a help.topic plan on an ordinary negative naming no source stays a help capture (wrong, help.topic only)', () => {
    expect(scoreAgentPlanOutput(byId('neg-012'), help, FIXTURE)).toMatchObject({ outcome: 'wrong', gotEntries: ['help.topic'] });
  });

  it('the summary counts clarification golds and how many Core asked', () => {
    const record = (id: string, outcome: AgentPlanEvalRecord['outcome'], clarifyGold: boolean): AgentPlanEvalRecord => ({
      run: 1, id, family: 'one-step', expected: 'none', goldEntries: [], outcome, gotEntries: ['help.topic'], latencyMs: 1, ...(clarifyGold ? { clarifyGold: true as const } : {}),
    });
    const summary = summarizeAgentPlanRun([record('neg-010', 'clarify', true), record('ap-n115', 'miss', true), record('neg-012', 'none', false)], 6000);
    expect(summary.clarifyGolds).toEqual({ total: 2, asked: 1 });
    expect(summary.helpCaptures).toBe(0);
    expect(formatAgentPlanSummary(summary).join('\n')).toContain('clarification golds asked: 1/2');
  });
});

describe('rule 7 in scoring: Core\'s final outcome of a read plan that leaves a write clause', () => {
  it('scores none on a none gold (the read + write path answers the turn), a miss-none on a positive', () => {
    const golden: AgentPlanEvalCase = { id: 'ap-n999', family: 'write-read', status: 'approved', text: '내일 일정 보여주고 내일 9시에 출발 리마인드 해줘', attachments: 0, gold: 'none' };
    const calendarOnly = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
    expect(scoreAgentPlanOutput(golden, calendarOnly, FIXTURE)).toMatchObject({ outcome: 'none' });
    const positive: AgentPlanEvalCase = { ...golden, id: 'ap-p999', family: 'compound', gold: { steps: [{ entryId: 'calendar.events', args: { range: 'tomorrow' } }], ambiguity: 'CLEAR' } };
    expect(scoreAgentPlanOutput(positive, calendarOnly, FIXTURE)).toMatchObject({ outcome: 'miss-none' });
  });
});

describe('the read + write probe in the eval (owner-ratified trigger amendment, 2026-10-26)', () => {
  const golden = byId('ap-n131');
  const calendarOnly = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
  const scripted = (probeAnswer: string): AiProvider & { prompts: string[] } => {
    const provider = {
      id: 'scripted',
      capabilities: [],
      prompts: [] as string[],
      isAvailable: async () => true,
      execute: async (request: { prompt: string }) => {
        provider.prompts.push(request.prompt);
        return { text: request.prompt.startsWith('You are the request planner of Quoky') ? calendarOnly : probeAnswer };
      },
    };
    return provider as unknown as AiProvider & { prompts: string[] };
  };

  it('a planner answer leaving the write clause gets one probe call; a write in that clause scores read-write (not wrong)', async () => {
    const plan = buildAgentPlanEvalPlan([golden], HASHES, FIXTURE, { ...OPTIONS, runs: 1 });
    expect(plan.readWriteProbe.maxCallsPerRun).toBe(1);
    const provider = scripted(JSON.stringify({ entryId: 'reminder.create', args: { when: '내일 9시', body: '출발' }, ambiguity: 'CLEAR', alternatives: [] }));
    const [record] = await runAgentPlanEvaluation({ cases: [golden], plan, provider });
    expect(provider.prompts).toHaveLength(2);
    expect(record).toMatchObject({ outcome: 'read-write', reason: 'write:reminder.create', probe: 'write' });
    expect(summarizeAgentPlanRun([record as AgentPlanEvalRecord], plan.callTimeoutMs).wrongOnNegatives).toBe(0);
  });

  it('a probe that picks nothing leaves the read plan standing (wrong on this negative), and the hard cap covers the probe', async () => {
    const plan = buildAgentPlanEvalPlan([golden], HASHES, FIXTURE, { ...OPTIONS, runs: 1 });
    const [standing] = await runAgentPlanEvaluation({ cases: [golden], plan, provider: scripted(JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] })) });
    expect(standing).toMatchObject({ outcome: 'wrong', probe: 'stands' });
    const [capped] = await runAgentPlanEvaluation({ cases: [golden], plan: { ...plan, maxCalls: 1 }, provider: scripted('{}') });
    expect(capped).toMatchObject({ outcome: 'capped' });
  });
});

describe('Codex P2: the probe call is measured like every call', () => {
  const golden = byId('ap-n131');
  const calendarOnly = JSON.stringify({ entryId: 'calendar.events', args: { range: 'tomorrow' }, ambiguity: 'CLEAR', alternatives: [] });
  const provider = (probe: () => Promise<{ text: string }>): AiProvider =>
    ({
      id: 'scripted',
      capabilities: [],
      isAvailable: async () => true,
      execute: async (request: { prompt: string }) => (request.prompt.startsWith('You are the request planner of Quoky') ? { text: calendarOnly } : probe()),
    }) as unknown as AiProvider;

  it('a probe timeout is the record\'s outcome (probe-timeout), counted as a call over the bound', async () => {
    const plan = { ...buildAgentPlanEvalPlan([golden], HASHES, FIXTURE, { ...OPTIONS, runs: 1 }), callTimeoutMs: 50 };
    const [record] = await runAgentPlanEvaluation({ cases: [golden], plan, provider: provider(() => new Promise(() => undefined)) });
    expect(record).toMatchObject({ outcome: 'timeout', reason: 'probe-timeout', probe: 'timeout' });
    const summary = summarizeAgentPlanRun([record as AgentPlanEvalRecord], 50);
    expect(summary.calls).toBe(2);
    expect(summary.latency.overBound).toBe(1);
  });

  it('a slow probe counts in the latency percentiles and the over-bound rate', () => {
    const record: AgentPlanEvalRecord = { run: 1, id: 'ap-n131', family: 'a6-in-plan', expected: 'none', goldEntries: [], outcome: 'read-write', gotEntries: ['calendar.events'], latencyMs: 100, probe: 'write', probeLatencyMs: 9000 };
    const summary = summarizeAgentPlanRun([record], 6000);
    expect(summary).toMatchObject({ calls: 2, latency: { max: 9000, overBound: 1 }, overBoundRate: 0.5 });
  });
});

describe('CA review of P3: the probe against the readWrite gold (W3) and help-scope asks on plain negatives (W4)', () => {
  const golden = byId('ap-n131');
  const clauses = ['내일 9시에 출발 알림 만들어줘'];
  const base = { outcome: 'wrong' as const, gotEntries: ['calendar.events'] };
  const write = JSON.stringify({ entryId: 'reminder.create', args: { when: '내일 9시', body: '출발' }, ambiguity: 'CLEAR', alternatives: [] });
  const ask = JSON.stringify({ entryId: 'reminder.create', args: { when: '내일 9시' }, ambiguity: 'CLEAR', alternatives: [] });

  it('the probe result must be the one the readWrite gold names; a mismatch is wrong on a negative', () => {
    expect(golden.readWrite?.outcome).toBe('read-and-write');
    expect(applyReadWriteProbe(base, golden, write, clauses, FIXTURE)).toMatchObject({ outcome: 'read-write', probe: 'write' });
    expect(applyReadWriteProbe(base, golden, ask, clauses, FIXTURE)).toMatchObject({ outcome: 'wrong', reason: 'probe-mismatch:clarify:reminder.create' });
  });

  it('without a readWrite gold a write on a negative is wrong; a clarification is not', () => {
    const { readWrite: _rw, ...plain } = golden;
    expect(applyReadWriteProbe(base, plain, write, clauses, FIXTURE)).toMatchObject({ outcome: 'wrong', reason: 'write:reminder.create' });
    expect(applyReadWriteProbe(base, plain, ask, clauses, FIXTURE)).toMatchObject({ outcome: 'read-clarify' });
  });

  it('W4: a help-scope question on a negative without a clarification gold counts as a help capture; on a clarification gold it is asked', () => {
    const record = (id: string, clarifyGold: boolean): AgentPlanEvalRecord => ({
      run: 1, id, family: 'capability-chit-chat', expected: 'none', goldEntries: [], outcome: 'clarify', reason: 'help-scope', gotEntries: ['help.topic'], latencyMs: 1, ...(clarifyGold ? { clarifyGold: true as const } : {}),
    });
    const summary = summarizeAgentPlanRun([record('ap-n093', false), record('neg-010', true)], 6000);
    expect(summary).toMatchObject({ helpCaptures: 1, clarifyGolds: { total: 1, asked: 1 } });
  });
});

describe('gate on 5c09fee4: the item-summary note and the probe diagnostics', () => {
  const base = { outcome: 'wrong' as const, gotEntries: ['jira.issues'] };
  const summarize = JSON.stringify({ entryId: 'item.summarize', args: { source: 'jira', ref: '#2' }, ambiguity: 'CLEAR', alternatives: [] });

  // ap-n129 became the item-summary-ref positive ap-p187 (2026-10-26); the note path is kept for a read-and-note gold.
  const noteGold = (): AgentPlanEvalCase => ({
    ...byId('ap-n006'),
    text: 'list my jira issues and summarize the second one',
    readWrite: { outcome: 'read-and-note', writeClause: 'summarize the second one', readPlan: { steps: [{ entryId: 'jira.issues', args: {} }], ambiguity: 'CLEAR' }, why: 'list-ref' },
  });

  it('an item-summary note matches a read-and-note gold (read-note, not wrong)', () => {
    const golden = noteGold();
    expect(golden.readWrite?.outcome).toBe('read-and-note');
    expect(applyReadWriteProbe(base, golden, summarize, ['summarize the second one'], FIXTURE)).toMatchObject({ outcome: 'read-note', probe: 'note', probeEntry: 'item.summarize' });
  });

  it('an item-summary note never excuses a plan where the gold expects no note (Codex P2 of 39a10ddb)', () => {
    const { readWrite: _rw, ...plain } = noteGold();
    expect(applyReadWriteProbe(base, plain, summarize, ['summarize the second one'], FIXTURE)).toMatchObject({ outcome: 'wrong', probe: 'stands', probeDetail: 'item-read' });
  });

  it('a standing probe records its closed detail', () => {
    const golden = byId('ap-n004');
    const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    expect(applyReadWriteProbe({ outcome: 'wrong', gotEntries: ['todo.list'] }, golden, none, ['장보기 추가해줘'], FIXTURE)).toMatchObject({ outcome: 'wrong', probe: 'stands', probeDetail: 'none' });
  });
});

describe('owner decision of 2026-10-26 (ap-n011): a change word in an uncovered clause is the decision (f) note, never a silent drop', () => {
  it('ap-n011 ("알림 목록 보여주고 내일 거는 꺼줘"): a probe that finds no write scores read-note against the read-and-note gold', () => {
    const golden = byId('ap-n011');
    expect(golden.readWrite?.outcome).toBe('read-and-note');
    const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
    expect(applyReadWriteProbe({ outcome: 'wrong', gotEntries: ['reminder.list', 'reminder.list'] }, golden, none, ['내일 거는 꺼줘'], FIXTURE)).toMatchObject({
      outcome: 'read-note',
      probe: 'note',
      probeEntry: 'write-word',
    });
  });
});

describe('owner decision of 2026-10-26: the gate report records summary sources and splits order from scope', () => {
  it('ap-p093 with one summary over both reads is a scope miss; the reported summaries name the covered reads', () => {
    const golden = byId('ap-p093');
    const raw = JSON.stringify({ steps: [{ entryId: 'jira.issues', args: {} }, { entryId: 'slack.search', args: { keyword: '장애 대응' } }, { summarize: [1, 2], schema: 'digest.v1' }], ambiguity: 'CLEAR' });
    expect(scoreAgentPlanOutput(golden, raw, FIXTURE)).toMatchObject({ outcome: 'miss', summaryDiff: 'scope', gotSummaries: ['digest.v1<-jira.issues,slack.search'] });
    // The planner's other order of the right summaries is Core's normalized plan: exact.
    const reordered = JSON.stringify({ steps: [{ entryId: 'jira.issues', args: {} }, { entryId: 'slack.search', args: { keyword: '장애 대응' } }, { summarize: [1], schema: 'digest.v1' }, { summarize: [2], schema: 'digest.v1' }], ambiguity: 'CLEAR' });
    expect(scoreAgentPlanOutput(golden, reordered, FIXTURE)).toMatchObject({ outcome: 'exact', gotSummaries: ['digest.v1<-jira.issues', 'digest.v1<-slack.search'] });
  });

  it('summaryDiffOf: order when the same schemas cover the same reads, scope otherwise, undefined when the reads differ', () => {
    const r = (entryId: string) => ({ kind: 'read' as const, entryId, args: '[]' });
    const sum = (from: number[]) => ({ kind: 'summarize' as const, from: JSON.stringify(from), schema: 'digest.v1' });
    expect(summaryDiffOf([r('mail.list'), r('jira.issues'), sum([1])], [r('mail.list'), sum([1]), r('jira.issues')])).toBe('order');
    expect(summaryDiffOf([r('mail.list'), r('jira.issues'), sum([1, 2])], [r('mail.list'), sum([1]), r('jira.issues')])).toBe('scope');
    expect(summaryDiffOf([r('mail.list'), sum([1])], [r('jira.issues'), sum([1])])).toBeUndefined();
  });
});

