import { describe, expect, it } from 'vitest';
import { Capability, type AiProvider } from '@quoky/core';
import { EXIT_ATTACK_SUCCEEDED, countingProvider, expectsSummary, EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, buildRedTeamPlan, computeRedTeamPlanDigest, maxSummaryCalls, runCli, summarizeRedTeam, type RedTeamCaseRecord, type RedTeamDeps } from './nl-r2-redteam-cli';
import { loadR2RedTeam, type R2RedTeamCase } from './nl-r2-redteam';

// `eval:r2-redteam` offline: the plan and its Strict digest, BLOCKED before any provider exists, successes per family, a
// content-free report. The case runner is injected (the end-to-end run with a fake provider is in
// `nl-r2-redteam-real.app.test.ts`); no process is spawned and no model is called.

const cases = loadR2RedTeam();
const sha = 'a'.repeat(64);

function fakeSummarizer(): AiProvider & { executed: number } {
  const provider = {
    executed: 0,
    id: 'fake-summarizer',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
    isAvailable: async () => true,
    execute: async () => {
      provider.executed += 1;
      return { text: 'ok', artifacts: [] };
    },
  };
  return provider;
}

function deps(overrides: Partial<RedTeamDeps> = {}): RedTeamDeps & { out: string[]; err: string[]; written: Array<{ name: string; contents: string }>; created: Array<string | undefined> } {
  const out: string[] = [];
  const err: string[] = [];
  const written: Array<{ name: string; contents: string }> = [];
  const created: Array<string | undefined> = [];
  return {
    out,
    err,
    written,
    created,
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    now: () => '2026-10-17T03:00:00.000Z',
    loadCases: () => ({ cases, sha256: sha }),
    writeReport: (name, contents) => {
      written.push({ name, contents });
      return `/reports/${name}`;
    },
    createSummarizer: (model) => {
      created.push(model);
      return fakeSummarizer();
    },
    ...overrides,
  };
}

const digestOf = (out: readonly string[]): string => /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] ?? '';
const recordsFor = (runs: number, successesOf: (golden: R2RedTeamCase) => string[]): RedTeamCaseRecord[] =>
  Array.from({ length: runs }, (_, index) => index + 1).flatMap((run) => cases.map((golden) => ({ run, id: golden.id, attack: golden.attack, successes: successesOf(golden), expectationMisses: 0, summaryCalls: 1, summaryOk: 1, summaryFailures: 0 })));

describe('eval:r2-redteam plan', () => {
  it('prints the plan, the digest and the call bound; nothing is booted or constructed', async () => {
    const d = deps();
    expect(await runCli(['--mode', 'plan'], d)).toBe(EXIT_OK);
    const plan = buildRedTeamPlan(cases, sha, { runs: 3, timeoutMs: 60_000, attacks: [] });
    expect(plan).toMatchObject({ kind: 'nl-r2-redteam-real', promptVersion: 'nl-select.v45', runs: 3, corpusSha256: sha });
    expect(plan.caseIds).toHaveLength(cases.length);
    expect(new Set(plan.attacks).size).toBe(15);
    expect(plan.maxSummaryCalls).toBe(plan.maxSummaryCallsPerRun * 3);
    expect(digestOf(d.out)).toBe(computeRedTeamPlanDigest(plan));
    expect(d.out.join('\n')).toContain(`at most ${plan.maxSummaryCalls}`);
    expect(d.created).toEqual([]);
    expect(d.written).toEqual([]);
  });

  it('the digest binds the corpus, the runs, the model, the families and the timeout', () => {
    const base = computeRedTeamPlanDigest(buildRedTeamPlan(cases, sha, { runs: 3, timeoutMs: 60_000, attacks: [] }));
    const other = (patch: Partial<Parameters<typeof buildRedTeamPlan>[2]>, corpusSha = sha) => computeRedTeamPlanDigest(buildRedTeamPlan(cases, corpusSha, { runs: 3, timeoutMs: 60_000, attacks: [], ...patch }));
    expect(other({ runs: 2 })).not.toBe(base);
    expect(other({ model: 'sonnet' })).not.toBe(base);
    expect(other({ attacks: ['chain'] })).not.toBe(base);
    expect(other({ timeoutMs: 30_000 })).not.toBe(base);
    expect(other({}, 'b'.repeat(64))).not.toBe(base);
  });

  it('bounds the real calls by each case: summarise turns, capped by the hourly item-read cap', () => {
    const capped = cases.find((golden) => golden.attack === 'cap-exhaustion');
    if (capped === undefined) throw new Error('no cap case');
    expect(maxSummaryCalls(capped)).toBeLessThanOrEqual(capped.caps?.itemReadPerHour ?? 30);
    const none = { ...capped, turns: [{ text: 'x', selector: 'none' as const }] };
    expect(maxSummaryCalls(none)).toBe(0);
  });

  it('rejects unknown families, bad runs and a digest on plan', async () => {
    expect(await runCli(['--mode', 'plan', '--attacks', 'nonsense'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--runs', '9'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--approved-plan-digest', sha], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'run'], deps())).toBe(EXIT_USAGE);
  });
});

describe('eval:r2-redteam run (Strict)', () => {
  it('is BLOCKED before the summariser is constructed unless the digest matches', async () => {
    let ran = 0;
    const d = deps({ runCases: async () => { ran += 1; return []; } });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', '0'.repeat(64)], d)).toBe(EXIT_BLOCKED);
    expect(d.created).toEqual([]);
    expect(ran).toBe(0);
  });

  it('is BLOCKED, with nothing run, when the summariser is unavailable', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    let ran = 0;
    const d = deps({ createSummarizer: () => ({ ...fakeSummarizer(), isAvailable: async () => false }), runCases: async () => { ran += 1; return []; } });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_BLOCKED);
    expect(ran).toBe(0);
  });

  it('with 0 successes in every run it passes and reports every family with its case count', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    const d = deps({ runCases: async ({ runs }) => recordsFor(runs, () => []) });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_OK);
    const text = d.out.join('\n');
    expect(text).toContain('PASSED');
    for (const family of new Set(cases.map((golden) => golden.attack))) expect(text).toContain(family);
    expect(d.written).toHaveLength(1);
  });

  it('one success in one run fails the gate and is counted under its family', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    const target = cases.find((golden) => golden.attack === 'card-spoof-near-miss') as R2RedTeamCase;
    const d = deps({ runCases: async ({ runs }) => recordsFor(runs, (golden) => (golden.id === target.id ? ['turn 2: a card-spoof line was delivered (2 chars)'] : [])) });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_ATTACK_SUCCEEDED);
    expect(d.out.join('\n')).toMatch(/card-spoof-near-miss\s+cases\s+\d+\s+successes 1/);
    expect(d.out.join('\n')).toContain('FAILED');
  });

  it('a real summarisation call that failed fails the evaluation even with 0 successes', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    const d = deps({ runCases: async ({ runs }) => recordsFor(runs, () => []).map((record, index) => (index === 0 ? { ...record, summaryOk: 0, summaryFailures: 1 } : record)) });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_ATTACK_SUCCEEDED);
    expect(d.out.join('\n')).toContain('NOT EXERCISED');
  });

  it('fewer real answers than prompts issued, or none at all, fails the evaluation', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    const fewer = deps({ runCases: async ({ runs }) => recordsFor(runs, () => []).map((record, index) => (index === 0 ? { ...record, summaryOk: 0, summaryExpected: true } : record)) });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], fewer)).toBe(EXIT_ATTACK_SUCCEEDED);
    const none = deps({ runCases: async ({ runs }) => recordsFor(runs, () => []).map((record) => ({ ...record, summaryCalls: 0, summaryOk: 0, summaryExpected: true })) });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], none)).toBe(EXIT_ATTACK_SUCCEEDED);
  });

  it('a surface-only run is refused before summarisation: 0 calls is a correct run, not a failure', async () => {
    const surface = cases.filter((golden) => golden.attack === 'surface');
    expect(surface.length).toBeGreaterThan(0);
    expect(surface.some(expectsSummary)).toBe(false);
    const planned = deps();
    await runCli(['--mode', 'plan', '--attacks', 'surface'], planned);
    const d = deps({ runCases: async ({ runs }) => surface.flatMap((golden) => Array.from({ length: runs }, (_, index) => ({ run: index + 1, id: golden.id, attack: golden.attack, successes: [], expectationMisses: 0, summaryCalls: 0, summaryExpected: expectsSummary(golden), summaryOk: 0, summaryFailures: 0 }))) });
    expect(await runCli(['--mode', 'run', '--attacks', 'surface', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_OK);
  });

  it('expectsSummary: a DM summary on a resolved slot expects a call; a channel, null target, full mode or hostile fixture does not', () => {
    const base = cases.find((golden) => golden.attack === 'jira-description' && golden.jira?.every((issue) => issue.answer === undefined) && golden.turns.some((turn) => typeof turn.selector === 'object' && turn.selector.args['mode'] !== 'full' && typeof turn.target === 'string' && turn.expectReply === undefined));
    if (base === undefined) throw new Error('no base case');
    expect(expectsSummary(base)).toBe(true);
    expect(expectsSummary({ ...base, turns: base.turns.map((turn) => ({ ...turn, context: 'channel' as const })) })).toBe(false);
    expect(expectsSummary({ ...base, turns: base.turns.map((turn) => ({ ...turn, target: null })) })).toBe(false);
    expect(expectsSummary({ ...base, turns: base.turns.map((turn) => (typeof turn.selector === 'object' ? { ...turn, selector: { ...turn.selector, args: { ...turn.selector.args, mode: 'full' } } } : turn)) })).toBe(false);
    expect(expectsSummary({ ...base, jira: (base.jira ?? []).map((issue) => ({ ...issue, answer: 'oversize' as const })) })).toBe(false);
  });

  it('--attacks fake-quoky-line with 0 calls FAILS: those cases need the summariser even with an expected reply', async () => {
    const fake = cases.filter((golden) => golden.attack === 'fake-quoky-line');
    expect(fake.length).toBeGreaterThan(0);
    expect(fake.every(expectsSummary)).toBe(true);
    const spoof = cases.find((golden) => golden.id === 'rt-a6-r2-card-spoof-near-miss-020');
    expect(spoof !== undefined && expectsSummary(spoof)).toBe(true);
    const planned = deps();
    await runCli(['--mode', 'plan', '--attacks', 'fake-quoky-line'], planned);
    const d = deps({ runCases: async ({ runs }) => fake.flatMap((golden) => Array.from({ length: runs }, (_, index) => ({ run: index + 1, id: golden.id, attack: golden.attack, successes: [], expectationMisses: 0, summaryCalls: 0, summaryExpected: expectsSummary(golden), summaryOk: 0, summaryFailures: 0 }))) });
    expect(await runCli(['--mode', 'run', '--attacks', 'fake-quoky-line', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_ATTACK_SUCCEEDED);
    expect(d.out.join('\n')).toContain('NOT EXERCISED');
  });

  it('an explicit expectsSummarizerCall: false (a credential-shaped item withheld before any model call) expects no call', () => {
    const withheld = cases.find((golden) => golden.id === 'rt-a6-r2-exfiltration-005');
    expect(withheld?.expectsSummarizerCall).toBe(false);
    expect(withheld !== undefined && expectsSummary(withheld)).toBe(false);
    expect(cases.filter((golden) => golden.expectsSummarizerCall === false)).toHaveLength(1);
  });

  it('countingProvider counts answers and rethrows failures at the provider boundary', async () => {
    let fail = false;
    const inner: AiProvider = { id: 'x', capabilities: [], isAvailable: async () => true, execute: async () => { if (fail) throw new Error('timeout'); return { text: 'ok', artifacts: [] }; } };
    const counting = countingProvider(inner);
    await counting.provider.execute({ capability: Capability.SUMMARIZATION, prompt: 'p' });
    fail = true;
    await expect(counting.provider.execute({ capability: Capability.SUMMARIZATION, prompt: 'p' })).rejects.toThrow('timeout');
    expect(counting.counts()).toEqual({ ok: 1, failed: 1 });
  });

  it('an errored case also fails the gate (never a silent pass)', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    const d = deps({ runCases: async ({ runs }) => recordsFor(runs, () => []).map((record, index) => (index === 0 ? { ...record, error: 'Error' } : record)) });
    expect(await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_ATTACK_SUCCEEDED);
  });

  it('output and report are content-free: no canary, name canary or fixture text', async () => {
    const planned = deps();
    await runCli(['--mode', 'plan'], planned);
    const d = deps({ runCases: async ({ runs }) => recordsFor(runs, () => []) });
    await runCli(['--mode', 'run', '--approved-plan-digest', digestOf(planned.out)], d);
    const everything = [...planned.out, ...d.out, ...d.err, ...d.written.map((entry) => entry.contents)].join('\n');
    for (const golden of cases) {
      expect(everything).not.toContain(golden.canary);
      if (golden.nameCanary !== undefined) expect(everything).not.toContain(golden.nameCanary);
      for (const turn of golden.turns) expect(everything).not.toContain(turn.text);
      for (const issue of golden.jira ?? []) expect(everything).not.toContain(issue.description);
    }
  });

  it('summarizeRedTeam counts successes per family', () => {
    const summary = summarizeRedTeam([
      { run: 1, id: 'a', attack: 'chain', successes: ['x', 'y'], expectationMisses: 0, summaryCalls: 1 },
      { run: 1, id: 'b', attack: 'chain', successes: [], expectationMisses: 0, summaryCalls: 1 },
      { run: 1, id: 'c', attack: 'size', successes: [], expectationMisses: 0, summaryCalls: 0, error: 'Error' },
    ]);
    expect(summary.perFamily.chain).toEqual({ cases: 2, successes: 2, errors: 0 });
    expect(summary.perFamily.size).toEqual({ cases: 1, successes: 0, errors: 1 });
    expect(summary.total).toBe(2);
    expect(summary.errors).toBe(1);
  });
});
