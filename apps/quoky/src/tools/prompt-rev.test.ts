import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NL_CANDIDATE_PROMPT_VERSIONS, NL_CATALOG_ENTRY_IDS, NL_SELECTION_PROMPT_VERSION, NL_WAVE1_ENTRIES, buildSelectionPrompt, type AiProvider } from '@quoky/core';
import { AGENT_PLAN_EVAL_REVS, NL_EVAL_PROMPT_REVS, parseAgentPlanRev, parseCaseIds, parseNlPromptRev } from './prompt-rev';
import { actionPromptSha256, buildActionPlan, computeActionPlanDigest, decideActionCase } from './nl-action-eval';
import { buildPlan, computePlanDigest, loadCorpus, loadScoredCorpus, loadScoredCorpusWithFixture, nlEvalFixturePath, scoreOutput } from './nl-intent-eval';
import { EXIT_BLOCKED, EXIT_OK, EXIT_USAGE, defaultDeps, parseArguments, planOptions, runCli, type CliDeps } from './nl-intent-eval-cli';
import { agentPlanEvalCases, agentPlanPromptSha256, buildAgentPlanEvalPlan, computeAgentPlanEvalDigest, loadAgentPlanCorpus, loadAgentPlanFixtureCases } from './agent-plan-eval';
import { EXIT_BLOCKED as PLAN_BLOCKED, EXIT_OK as PLAN_OK, EXIT_USAGE as PLAN_USAGE, defaultDeps as planDefaultDeps, runCli as runPlanCli, type AgentPlanCliDeps } from './agent-plan-eval-cli';

const NOW = '2026-10-20T03:00:00.000Z';
const SCREEN = ['hm-n01', 'hm-n02', 'hm-n03', 'hm-n04', 'hm-n05', 'hm-n06', 'hm-n07', 'hm-n08', 'hm-n09', 'hm-n10', 'hm-p01', 'hm-p02', 'hm-p03', 'hm-p04', 'hm-p05', 'hm-p06', 'neg-033', 'neg-037', 'a7s-11', 'a7s-12', 'a7s-15'];
const BASE = { model: 'haiku', effort: 'low', entries: [], includeNegatives: true, perEntry: 0, runs: 3, concurrency: 4 } as const;

const noProvider = (): AiProvider => {
  throw new Error('a provider must not be constructed');
};

function nlDeps(): CliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { ...defaultDeps(), out, err, stdout: (line) => void out.push(line), stderr: (line) => void err.push(line), now: () => NOW, writeReport: () => '/dev/null', createProvider: noProvider };
}

function planDeps(): AgentPlanCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { ...planDefaultDeps(), out, err, stdout: (line) => void out.push(line), stderr: (line) => void err.push(line), now: () => NOW, gitHead: () => 'a'.repeat(40), writeReport: () => '/dev/null', createProvider: noProvider };
}

const digestOf = (out: readonly string[]): string => /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] as string;

describe('prompt revision options (owner decision 2026-11-04)', () => {
  it('knows the revisions and rejects an unknown one', () => {
    expect(NL_EVAL_PROMPT_REVS).toEqual(['v73', 'v74']);
    expect(AGENT_PLAN_EVAL_REVS).toEqual(['v10', 'v11']);
    expect(parseNlPromptRev(undefined)).toBeUndefined();
    expect(parseNlPromptRev('v74')).toBe('v74');
    expect(() => parseNlPromptRev('v75')).toThrow(/--prompt-rev must be one of/);
    expect(parseAgentPlanRev('v11')).toBe('v11');
    expect(() => parseAgentPlanRev('v12')).toThrow(/--plan-rev must be one of/);
    expect(() => parseCaseIds('')).toThrow();
    expect(() => parseCaseIds('a,a')).toThrow(/twice/);
    expect(parseCaseIds(' a1 , b2 ')).toEqual(['a1', 'b2']);
  });

  it('eval:nl plan: the default is the active read v74 with no new plan key; explicit v73 (the previous prompt) stores its rev and changes the version, the prompt hash and the digest', () => {
    const { corpus, sha256 } = loadScoredCorpus();
    const base = buildPlan(corpus, sha256, BASE);
    expect(base.promptVersion).toBe(NL_SELECTION_PROMPT_VERSION);
    expect(base.promptVersion).toBe('nl-select.v74');
    expect(base.promptSha256).toBe(createHash('sha256').update(buildSelectionPrompt({ entries: NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]), text: '' })).digest('hex'));
    expect(Object.keys(base)).not.toContain('promptRev');
    expect(Object.keys(base)).not.toContain('fixture');
    expect(Object.keys(base)).not.toContain('selectedCases');
    expect(computePlanDigest(buildPlan(corpus, sha256, { ...BASE, promptRev: 'v74' }))).toBe(computePlanDigest(base));
    const candidate = buildPlan(corpus, sha256, { ...BASE, promptRev: 'v73' });
    expect(candidate).toMatchObject({ promptVersion: 'nl-select.v73', promptRev: 'v73' });
    expect(candidate.promptSha256).not.toBe(base.promptSha256);
    expect(computePlanDigest(candidate)).not.toBe(computePlanDigest(base));
    expect(() => buildPlan(corpus, sha256, { ...BASE, promptRev: 'v99' as never })).toThrow(/--prompt-rev/);
  });

  it('eval:nl CLI: an unknown rev is a usage error, and a default-rev digest is refused for v73 before any provider exists', async () => {
    expect(() => planOptions({ '--prompt-rev': 'v75' })).toThrow(/--prompt-rev must be one of/);
    const bad = nlDeps();
    expect(await runCli(['--mode', 'plan', '--per-entry', '1', '--prompt-rev', 'v75'], bad)).toBe(EXIT_USAGE);
    const planned = nlDeps();
    expect(await runCli(['--mode', 'plan', '--per-entry', '1'], planned)).toBe(EXIT_OK);
    const candidate = nlDeps();
    expect(await runCli(['--mode', 'plan', '--per-entry', '1', '--prompt-rev', 'v73'], candidate)).toBe(EXIT_OK);
    expect(digestOf(candidate.out)).not.toBe(digestOf(planned.out));
    expect(candidate.out.join('\n')).toContain('"promptRev": "v73"');
    const explicitActive = nlDeps();
    expect(await runCli(['--mode', 'plan', '--per-entry', '1', '--prompt-rev', 'v74'], explicitActive)).toBe(EXIT_OK);
    expect(digestOf(explicitActive.out)).toBe(digestOf(planned.out));
    const crossed = nlDeps();
    expect(await runCli(['--mode', 'run', '--per-entry', '1', '--prompt-rev', 'v73', '--approved-plan-digest', digestOf(planned.out)], crossed)).toBe(EXIT_BLOCKED);
    expect(await runCli(['--mode', 'run', '--per-entry', '1', '--approved-plan-digest', digestOf(candidate.out)], nlDeps())).toBe(EXIT_BLOCKED);
  });

  it('eval:nl: --prompt-rev reaches the A6 modes, not help-scope; --fixture / --cases are plan/run only', () => {
    for (const mode of ['action', 'read-regression', 'r2']) expect(parseArguments(['--mode', mode, '--prompt-rev', 'v74']).options['--prompt-rev']).toBe('v74');
    expect(() => parseArguments(['--mode', 'help-scope', '--prompt-rev', 'v74'])).toThrow(/help-scope/);
    for (const mode of ['action', 'read-regression', 'r2', 'help-scope']) {
      expect(() => parseArguments(['--mode', mode, '--fixture', 'homonym-heldout'])).toThrow(/not an option/);
      expect(() => parseArguments(['--mode', mode, '--cases', 'neg-033'])).toThrow(/not an option/);
    }
  });

  it('A6 plans: the default is nl-select.v71 (action) / v72 (R2) and stores no rev; explicit v74 is v75 / v76 with its own prompt hash and digest', () => {
    const options = { model: 'haiku', runs: 3, concurrency: 4 };
    const base = buildActionPlan('nl-action-eval', ['x'], 'sha', options);
    const candidate = buildActionPlan('nl-action-eval', ['x'], 'sha', { ...options, promptRev: 'v74' });
    expect(Object.keys(base)).not.toContain('promptRev');
    expect(base.promptVersion).toBe('nl-select.v71');
    expect(buildActionPlan('nl-action-r2-eval', ['x'], 'sha', options).promptVersion).toBe('nl-select.v72');
    expect(computeActionPlanDigest(buildActionPlan('nl-action-eval', ['x'], 'sha', { ...options, promptRev: 'v73' }))).toBe(computeActionPlanDigest(base));
    expect(candidate).toMatchObject({ promptVersion: NL_CANDIDATE_PROMPT_VERSIONS.action, promptRev: 'v74' });
    expect(computeActionPlanDigest(candidate)).not.toBe(computeActionPlanDigest(base));
    expect(actionPromptSha256(undefined, 'v74')).not.toBe(actionPromptSha256());
    expect(buildActionPlan('nl-action-r2-eval', ['x'], 'sha', { ...options, promptRev: 'v74' }).promptVersion).toBe(NL_CANDIDATE_PROMPT_VERSIONS.r2);
    expect(buildActionPlan('nl-read-regression', ['x'], 'sha', { ...options, promptRev: 'v74' }).promptRev).toBe('v74');
    expect(() => buildActionPlan('nl-action-eval', ['x'], 'sha', { ...options, promptRev: 'v1' as never })).toThrow(/--prompt-rev/);
  });
});

describe('the A6 decision path builds the revision the plan names', () => {
  it('NlSelectionService (via decideActionCase) sends the v74 text only with promptRev v74', async () => {
    const seen: string[] = [];
    const provider = { id: 'capture', capabilities: [], isAvailable: async () => true, execute: async (request: { prompt: string }) => (seen.push(request.prompt), { text: '{"entryId":null,"args":{},"ambiguity":"CLEAR","alternatives":[]}' }) } as unknown as AiProvider;
    await decideActionCase({ text: '메일 오늘 온 것만 보여줘' }, provider, NOW as never);
    await decideActionCase({ text: '메일 오늘 온 것만 보여줘' }, provider, NOW as never, { promptRev: 'v74' });
    await decideActionCase({ text: '메일 오늘 온 것만 보여줘' }, provider, NOW as never);
    expect(seen).toHaveLength(3);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });
});

describe('homonym held-out fixture (owner-approved 2026-11-04)', () => {
  const { corpus: heldout } = loadCorpus(nlEvalFixturePath('homonym-heldout'));

  it('is a separate approved file in the eval format; the existing corpora do not contain it', () => {
    const raw = JSON.parse(JSON.stringify(heldout)) as { status?: string };
    expect(heldout.cases).toHaveLength(16);
    expect(heldout.cases.filter((golden) => golden.expect === 'none')).toHaveLength(10);
    expect(heldout.cases.map((golden) => golden.id)).toEqual([...Array.from({ length: 10 }, (_, i) => `hm-n${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 6 }, (_, i) => `hm-p0${i + 1}`)]);
    expect(loadScoredCorpus().corpus.cases.some((golden) => golden.id.startsWith('hm-'))).toBe(false);
    void raw;
    expect(() => nlEvalFixturePath('nope')).toThrow(/--fixture must be one of/);
  });

  it('loads with the scored corpus and binds into the corpus hash; every case is scored by Core as its own gold', () => {
    const base = loadScoredCorpus();
    const withFixture = loadScoredCorpusWithFixture('homonym-heldout');
    expect(withFixture.corpus.cases).toHaveLength(base.corpus.cases.length + 16);
    expect(withFixture.sha256).not.toBe(base.sha256);
    for (const golden of heldout.cases) {
      const raw = golden.expect === 'none' ? '{"entryId":null,"args":{},"ambiguity":"CLEAR","alternatives":[]}' : JSON.stringify({ entryId: golden.expect.entryId, args: golden.expect.args, ambiguity: 'CLEAR', alternatives: [] });
      expect(scoreOutput(golden, raw, NOW).outcome, golden.id).toBe(golden.expect === 'none' ? 'none' : 'hit');
    }
  });

  it('eval:nl: --cases selects exactly the screen, in corpus order, bound into the digest; an unknown id is refused', () => {
    const { corpus, sha256 } = loadScoredCorpusWithFixture('homonym-heldout');
    const plan = buildPlan(corpus, sha256, { ...BASE, fixture: 'homonym-heldout', cases: SCREEN });
    expect([...plan.caseIds].sort()).toEqual([...SCREEN].sort());
    expect(plan).toMatchObject({ fixture: 'homonym-heldout', selectedCases: SCREEN, runs: 3 });
    expect(computePlanDigest(buildPlan(corpus, sha256, { ...BASE, fixture: 'homonym-heldout', cases: SCREEN.slice(1) }))).not.toBe(computePlanDigest(plan));
    expect(() => buildPlan(corpus, sha256, { ...BASE, cases: ['hm-zz'] })).toThrow(/unknown case hm-zz/);
    // Another filter must not silently drop a requested id.
    expect(() => buildPlan(corpus, sha256, { ...BASE, fixture: 'homonym-heldout', cases: ['hm-n01', 'hm-n02'], perEntry: 1 })).toThrow(/dropped by other filters: hm-n02/);
  });

  it('eval:nl CLI: the screen plan authorises 21 cases x 3 runs = 63 calls under both revisions', async () => {
    for (const rev of ['v73', 'v74']) {
      const deps = nlDeps();
      expect(await runCli(['--mode', 'plan', '--model', 'haiku', '--runs', '3', '--fixture', 'homonym-heldout', '--cases', SCREEN.join(','), '--prompt-rev', rev], deps)).toBe(EXIT_OK);
      expect(deps.out.join('\n')).toContain('at most 63 (21 cases x 3 run(s)');
    }
    expect(await runCli(['--mode', 'plan', '--fixture', 'nope'], nlDeps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'plan', '--cases', 'hm-n01'], nlDeps())).toBe(EXIT_USAGE);
  });
});

describe('eval:agent-plan revision, fixture and subset', () => {
  const loaded = loadAgentPlanCorpus();
  const cases = agentPlanEvalCases(loaded.corpus, loaded.oneStep);
  const hashes = { corpusSha256: loaded.sha256, oneStepCorpusSha256: loaded.oneStepSha256 };
  const options = { model: 'haiku', effort: 'low', runs: 3, concurrency: 4, includePending: false, gitHead: 'a'.repeat(40) };

  it('the default is the active v11 with no new plan key; explicit v10 stores its rev and changes the version, the prompt hash and the digest', () => {
    const base = buildAgentPlanEvalPlan(cases, hashes, loaded.corpus.fixture, options);
    expect(base.promptVersion).toBe('agent-plan.v11');
    expect(base.promptSha256).toBe(agentPlanPromptSha256('v11'));
    for (const key of ['planRev', 'heldout', 'selectedCases']) expect(Object.keys(base)).not.toContain(key);
    expect(computeAgentPlanEvalDigest(buildAgentPlanEvalPlan(cases, hashes, loaded.corpus.fixture, { ...options, planRev: 'v11' }))).toBe(computeAgentPlanEvalDigest(base));
    const candidate = buildAgentPlanEvalPlan(cases, hashes, loaded.corpus.fixture, { ...options, planRev: 'v10' });
    expect(candidate).toMatchObject({ promptVersion: 'agent-plan.v10', planRev: 'v10' });
    expect(candidate.promptSha256).toBe(agentPlanPromptSha256('v10'));
    expect(candidate.promptSha256).not.toBe(base.promptSha256);
    expect(computeAgentPlanEvalDigest(candidate)).not.toBe(computeAgentPlanEvalDigest(base));
    expect(() => buildAgentPlanEvalPlan(cases, hashes, loaded.corpus.fixture, { ...options, planRev: 'v12' as never })).toThrow(/--plan-rev/);
  });

  it('the held-out fixture loads as approved one-step gold (a positive is the single-step plan) and --cases subsets it', () => {
    const fixture = loadAgentPlanFixtureCases('homonym-heldout');
    expect(fixture.cases).toHaveLength(16);
    expect(fixture.cases.every((golden) => golden.status === 'approved')).toBe(true);
    expect(fixture.cases.find((golden) => golden.id === 'hm-p03')?.gold).toEqual({ steps: [{ entryId: 'calendar.events', args: { range: 'fri' } }], ambiguity: 'CLEAR' });
    expect(fixture.cases.find((golden) => golden.id === 'hm-n01')?.gold).toBe('none');
    expect(() => loadAgentPlanFixtureCases('nope')).toThrow(/--fixture must be one of/);
    const pool = [...cases, ...fixture.cases];
    const plan = buildAgentPlanEvalPlan(pool, hashes, loaded.corpus.fixture, { ...options, heldout: { name: 'homonym-heldout', sha256: fixture.sha256 }, cases: SCREEN });
    expect([...plan.caseIds].sort()).toEqual([...SCREEN].sort());
    expect(plan.selectedCases).toEqual(SCREEN);
    expect(() => buildAgentPlanEvalPlan(pool, hashes, loaded.corpus.fixture, { ...options, cases: ['hm-zz'] })).toThrow(/unknown case hm-zz/);
    // A requested pending case is refused, never silently skipped.
    const pendingId = pool.find((golden) => golden.status !== 'approved')?.id;
    if (pendingId !== undefined) {
      expect(() => buildAgentPlanEvalPlan(pool, hashes, loaded.corpus.fixture, { ...options, includePending: false, cases: ['hm-n01', pendingId] })).toThrow(/pending/);
    }
  });

  it('CLI: unknown rev is a usage error; the screen plan is refused across revisions; a plan authorises at most 66 calls (21 planner + 1 probe) x 3', async () => {
    expect(await runPlanCli(['--mode', 'plan', '--plan-rev', 'v12'], planDeps())).toBe(PLAN_USAGE);
    expect(await runPlanCli(['--mode', 'plan', '--fixture', 'nope'], planDeps())).toBe(PLAN_USAGE);
    expect(await runPlanCli(['--mode', 'plan', '--cases', 'hm-zz'], planDeps())).toBe(PLAN_USAGE);
    const screen = ['--runs', '3', '--fixture', 'homonym-heldout', '--cases', SCREEN.join(',')];
    const v10 = planDeps();
    const v11 = planDeps();
    expect(await runPlanCli(['--mode', 'plan', ...screen], v10)).toBe(PLAN_OK);
    expect(await runPlanCli(['--mode', 'plan', ...screen, '--plan-rev', 'v10'], v11)).toBe(PLAN_OK);
    expect(digestOf(v10.out)).not.toBe(digestOf(v11.out));
    expect(v11.out.join('\n')).toContain('"planRev": "v10"');
    expect(v10.out.join('\n')).toMatch(/at most 66 \(\(21 planner calls/);
    expect(await runPlanCli(['--mode', 'run', ...screen, '--plan-rev', 'v10', '--approved-plan-digest', digestOf(v10.out)], planDeps())).toBe(PLAN_BLOCKED);
    expect(await runPlanCli(['--mode', 'run', ...screen, '--approved-plan-digest', digestOf(v11.out)], planDeps())).toBe(PLAN_BLOCKED);
  });
});
