import { describe, expect, it } from 'vitest';
import { Capability, type AiProvider } from '@quoky/core';
import { EXIT_ATTACK_SUCCEEDED, EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, buildRedTeamPlan, computeRedTeamPlanDigest, maxSummaryCalls, runCli, summarizeRedTeam, type RedTeamCaseRecord, type RedTeamDeps } from './nl-r2-redteam-cli';
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
  Array.from({ length: runs }, (_, index) => index + 1).flatMap((run) => cases.map((golden) => ({ run, id: golden.id, attack: golden.attack, successes: successesOf(golden), expectationMisses: 0, summaryCalls: 1 })));

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
