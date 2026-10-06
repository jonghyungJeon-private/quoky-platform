import { describe, expect, it } from 'vitest';
import { Capability, readGeneralChatReplyPolicy, renderGeneralChatPolicyRules } from '@quoky/core';
import type { AiProvider, AiRequest } from '@quoky/core';
import { ClaudeCliProvider, OllamaCliProvider } from '@quoky/ai-cli';
import {
  AnswerQualityBlockedError,
  MAX_CALLS_PER_CASE,
  buildCaseRequest,
  buildPlan,
  canonicalJson,
  checkOutputForCase,
  checkSavedOutputs,
  computePlanDigest,
  loadFixtures,
  parseSavedOutputs,
  runProviderEvaluation,
  summarizePassRates,
  validateFixtures,
} from './answer-quality-eval';
import type { AnswerQualityFixtures } from './answer-quality-eval';
import {
  EXIT_BLOCKED,
  EXIT_CHECK_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  defaultDeps,
  parseArguments,
  runCli,
} from './answer-quality-eval-cli';
import type { CliDeps } from './answer-quality-eval-cli';

const fixtures = loadFixtures();

function caseById(id: string) {
  const found = fixtures.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`missing fixture case ${id}`);
  return found;
}

describe('fixtures', () => {
  it('are valid offline (including every known-bad flagged and every known-good clean)', () => {
    expect(validateFixtures(fixtures)).toEqual([]);
  });

  it('cover the required synthetic chat shapes in Korean and English', () => {
    const kinds = new Set(fixtures.cases.map((c) => c.kind));
    for (const kind of [
      'greeting',
      'follow-up',
      'english-question',
      'injection',
      'capability-request',
      'bare-approval-as-chat',
      'literal-newline-bait',
      'helpfulness-recommendation',
      'helpfulness-howto-coding',
      'helpfulness-tips-list',
      'helpfulness-hedge',
      'helpfulness-small-talk',
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(new Set(fixtures.cases.map((c) => c.locale))).toEqual(new Set(['ko', 'en']));
    expect(caseById('ko-followup').transcript?.length).toBeGreaterThan(0);
  });

  it('record the UAT bad outputs as negative fixtures', () => {
    const texts = fixtures.knownBadOutputs.map((b) => b.text).join('\n');
    expect(texts).toContain('출력할 것입니다');
    expect(texts).toContain('만들어드릴게요');
    expect(texts).toContain('승인이 접수되었습니다.');
    expect(texts).toContain('(Translated from Korean)');
    expect(texts).toContain('\\n');
  });

  it('record the live gemma3:4b non-answers as known-bad and gate every helpfulness case on them', () => {
    const bad = fixtures.knownBadOutputs.map((b) => b.text);
    expect(bad).toContain('도움말을 확인해보세요.');
    expect(bad.some((text) => text.startsWith('도움말:') && text.includes('안내를 제공합니다.'))).toBe(true);
    const helpful = fixtures.cases.filter((c) => c.kind.startsWith('helpfulness-'));
    expect(helpful.length).toBeGreaterThanOrEqual(6);
    for (const testCase of helpful) {
      expect(testCase.checks, testCase.id).toContain('noHelpDeflection');
      expect(testCase.checks, testCase.id).toContain('languageMatches');
      expect(testCase.expectedLanguage, testCase.id).toBe('ko');
      expect(testCase.limits?.minChars, testCase.id).toBeGreaterThanOrEqual(15);
    }
    for (const testCase of helpful.filter((c) => c.kind === 'helpfulness-hedge')) {
      expect(testCase.checks).toEqual(expect.arrayContaining(['hedgesUncheckable', 'noInventedSpecifics']));
    }
    const sortCase = caseById('ko-helpful-python-sort');
    expect(sortCase.requiredTokenGroups?.flat()).toEqual(expect.arrayContaining(['sorted', 'reverse', '`']));
    const nonAnswer = checkOutputForCase(caseById('ko-helpful-recommendation'), '도움말을 확인해보세요.');
    expect(nonAnswer.filter((r) => !r.passed).map((r) => r.name)).toEqual(
      expect.arrayContaining(['noHelpDeflection', 'lengthWithin', 'containsRelevantTokens']),
    );
  });

  it('reject token-group and hedge-pairing mistakes in helpfulness cases', () => {
    const broken: AnswerQualityFixtures = {
      ...fixtures,
      cases: [
        { ...caseById('ko-helpful-python-sort'), id: 'no-groups', requiredTokenGroups: [] },
        { ...caseById('ko-helpful-hedge-weather'), id: 'unpaired', checks: ['languageMatches', 'noInventedSpecifics'] },
      ],
      knownBadOutputs: [],
      knownGoodOutputs: [],
    };
    const problems = validateFixtures(broken);
    expect(problems.some((p) => p.includes('no-groups') && p.includes('requiredTokenGroups'))).toBe(true);
    expect(problems.some((p) => p.includes('unpaired') && p.includes('hedgesUncheckable'))).toBe(true);
  });

  it('are rejected when malformed or when a known-bad output is not flagged', () => {
    const broken: AnswerQualityFixtures = {
      ...fixtures,
      cases: [{ ...caseById('ko-greeting'), checks: ['nope' as never] }, caseById('ko-greeting')],
      knownBadOutputs: [{ id: 'b', caseId: 'ko-greeting', text: '안녕하세요!', mustFail: ['noLiteralEscapes'], source: 's' }],
      knownGoodOutputs: [{ id: 'g', caseId: 'missing', text: 'x' }],
    };
    const problems = validateFixtures(broken);
    expect(problems.some((p) => p.includes('unknown check nope'))).toBe(true);
    expect(problems.some((p) => p.includes('duplicate id'))).toBe(true);
    expect(problems.some((p) => p.includes('did not flag the bad output'))).toBe(true);
    expect(problems.some((p) => p.includes('unknown caseId missing'))).toBe(true);
  });
});

describe('prompt construction uses the real PromptComposer and PromptRenderer', () => {
  it('builds a GENERAL_CHAT request with the policy rules, reply facts and the synthetic transcript', () => {
    const request = buildCaseRequest(caseById('ko-followup'));
    expect(request.capability).toBe(Capability.GENERAL_CHAT);
    expect(request.prompt).toContain(renderGeneralChatPolicyRules());
    expect(request.prompt).toContain('Reply language for this turn: Korean (ko)');
    expect(request.prompt).toContain('파이썬이랑 자바스크립트');
    expect(request.prompt).toContain('그럼 완전 초보자한테는 어느 쪽이 더 쉬워?');
    expect(readGeneralChatReplyPolicy(request.metadata)).toEqual({ replyLanguage: 'ko', explicitLanguageRequest: false });
  });

  it('names English for an English question and carries the explicit-translation flag', () => {
    expect(buildCaseRequest(caseById('en-question')).prompt).toContain('Reply language for this turn: English (en)');
    expect(readGeneralChatReplyPolicy(buildCaseRequest(caseById('ko-translation-requested')).metadata)).toMatchObject({
      explicitLanguageRequest: true,
    });
  });

  it('is deterministic', () => {
    expect(buildCaseRequest(caseById('ko-greeting')).prompt).toBe(buildCaseRequest(caseById('ko-greeting')).prompt);
  });
});

describe('check-outputs (offline)', () => {
  it('applies the case checks to saved outputs and flags the UAT bad outputs', () => {
    const bad = fixtures.knownBadOutputs.map((b) => ({ caseId: b.caseId, text: b.text }));
    const rows = checkSavedOutputs(fixtures, bad);
    expect(rows.every((row) => row.results.some((r) => !r.passed))).toBe(true);
    const good = fixtures.knownGoodOutputs.map((g) => ({ caseId: g.caseId, text: g.text }));
    expect(checkSavedOutputs(fixtures, good).every((row) => row.results.every((r) => r.passed))).toBe(true);
  });

  it('rejects an unknown case id and malformed files', () => {
    expect(() => checkSavedOutputs(fixtures, [{ caseId: 'nope', text: 'x' }])).toThrow(AnswerQualityBlockedError);
    expect(() => parseSavedOutputs({ outputs: [{ caseId: 'a' }] })).toThrow(AnswerQualityBlockedError);
    expect(() => parseSavedOutputs('x')).toThrow(AnswerQualityBlockedError);
    expect(parseSavedOutputs([{ caseId: 'a', text: 'b' }])).toEqual([{ caseId: 'a', text: 'b' }]);
  });

  it('summarizes pass rates per check', () => {
    const rates = summarizePassRates([
      { caseId: 'a', results: [{ name: 'noLiteralEscapes', passed: true }, { name: 'lengthWithin', passed: false }] },
      { caseId: 'b', results: [{ name: 'noLiteralEscapes', passed: false }] },
    ]);
    expect(rates['noLiteralEscapes']).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(rates['lengthWithin']).toEqual({ passed: 0, total: 1, rate: 0 });
  });
});

describe('plan and digest (offline)', () => {
  const options = { target: 'ollama', model: 'llama3.1:8b', calls: 2 } as const;

  it('is canonical and deterministic, and binds target, model, calls and fixtures', () => {
    const plan = buildPlan(fixtures, options);
    expect(plan).toMatchObject({ providerKind: 'ollama-cli', totalCalls: 2 * fixtures.cases.length, egress: 'local-process' });
    expect(Object.keys(plan.promptDigests).sort()).toEqual(fixtures.cases.map((c) => c.id).sort());
    const digest = computePlanDigest(plan);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computePlanDigest(buildPlan(fixtures, options))).toBe(digest);
    expect(computePlanDigest(buildPlan(fixtures, { ...options, model: 'llama3.2' }))).not.toBe(digest);
    expect(computePlanDigest(buildPlan(fixtures, { ...options, calls: 1 }))).not.toBe(digest);
    expect(computePlanDigest(buildPlan(fixtures, { ...options, target: 'claude' }))).not.toBe(digest);
    const changed = { ...fixtures, cases: [{ ...caseById('ko-greeting'), userMessage: '안녕' }, ...fixtures.cases.slice(1)] };
    expect(computePlanDigest(buildPlan(changed, options))).not.toBe(digest);
    expect(buildPlan(fixtures, { ...options, target: 'claude', model: 'sonnet' }).egress).toBe('cloud-provider-network');
  });

  it('refuses invalid models, cloud-tagged local models and out-of-range calls', () => {
    expect(() => buildPlan(fixtures, { ...options, model: 'bad model!' })).toThrow(AnswerQualityBlockedError);
    expect(() => buildPlan(fixtures, { ...options, model: 'llama3.1:cloud' })).toThrow(AnswerQualityBlockedError);
    expect(() => buildPlan(fixtures, { ...options, calls: 0 })).toThrow(AnswerQualityBlockedError);
    expect(() => buildPlan(fixtures, { ...options, calls: MAX_CALLS_PER_CASE + 1 })).toThrow(AnswerQualityBlockedError);
    expect(() => buildPlan(fixtures, { ...options, calls: Number.NaN })).toThrow(AnswerQualityBlockedError);
  });

  it('canonicalJson ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } })).toBe(canonicalJson({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  created: Array<{ target: string; model: string }>;
  executed: AiRequest[];
  written: Array<{ fileName: string; contents: string }>;
}

function harness(overrides: { available?: boolean; reply?: (request: AiRequest) => string; files?: Record<string, string> } = {}): Harness {
  const h: Harness = { deps: undefined as unknown as CliDeps, out: [], err: [], created: [], executed: [], written: [] };
  const provider: AiProvider = {
    id: 'fake-cli',
    capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }],
    isAvailable: async () => overrides.available ?? true,
    execute: async (request) => {
      h.executed.push(request);
      return { text: overrides.reply?.(request) ?? '안녕하세요! 만나서 반가워요. 궁금한 게 있으면 물어보세요.' };
    },
  };
  h.deps = {
    stdout: (line) => h.out.push(line),
    stderr: (line) => h.err.push(line),
    now: () => '2026-10-02T10:00:00.000Z',
    loadFixtures: () => fixtures,
    readTextFile: (path) => {
      const content = overrides.files?.[path];
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeReport: (fileName, contents) => {
      h.written.push({ fileName, contents });
      return `data/eval/${fileName}`;
    },
    createProvider: (target, model) => {
      h.created.push({ target, model });
      return provider;
    },
  };
  return h;
}

describe('CLI argument parsing (fail closed)', () => {
  it('accepts the documented forms, including a leading --', () => {
    expect(parseArguments(['--', '--mode', 'validate-fixtures'])).toEqual({ mode: 'validate-fixtures', options: { '--mode': 'validate-fixtures' } });
    expect(parseArguments([])).toMatchObject({ mode: 'help' });
  });

  it('rejects unknown, repeated, missing and out-of-mode options', () => {
    expect(() => parseArguments(['--mode', 'nope'])).toThrow();
    expect(() => parseArguments(['--mode', 'plan', '--target', 'ollama'])).toThrow(/requires/);
    expect(() => parseArguments(['--mode', 'validate-fixtures', '--model', 'x'])).toThrow(/not valid/);
    expect(() => parseArguments(['--mode', 'validate-fixtures', '--mode', 'plan'])).toThrow(/more than once/);
    expect(() => parseArguments(['--mode', 'plan', '--bogus', 'x'])).toThrow(/unknown option/);
    expect(() => parseArguments(['--mode'])).toThrow(/needs a value/);
    // run without the approval flag is a usage error, never an execution
    expect(() => parseArguments(['--mode', 'run', '--target', 'ollama', '--model', 'm', '--calls', '1'])).toThrow(/--approved-plan-digest/);
  });
});

describe('CLI offline modes construct no provider and execute nothing', () => {
  it('validate-fixtures', async () => {
    const h = harness();
    expect(await runCli(['--mode', 'validate-fixtures'], h.deps)).toBe(EXIT_OK);
    expect(h.out.join('\n')).toContain('fixtures ok');
    expect(h.created).toEqual([]);
    expect(h.executed).toEqual([]);
  });

  it('validate-fixtures reports invalid fixtures with a non-zero exit', async () => {
    const h = harness();
    h.deps = { ...h.deps, loadFixtures: () => ({ ...fixtures, fixtureVersion: 'wrong' }) };
    expect(await runCli(['--mode', 'validate-fixtures'], h.deps)).toBe(EXIT_CHECK_FAILED);
    expect(h.err.join('\n')).toContain('fixtureVersion');
    expect(h.created).toEqual([]);
  });

  it('check-outputs flags the UAT bad outputs and passes clean ones', async () => {
    const bad = JSON.stringify({ outputs: fixtures.knownBadOutputs.map((b) => ({ caseId: b.caseId, text: b.text })) });
    const good = JSON.stringify(fixtures.knownGoodOutputs.map((g) => ({ caseId: g.caseId, text: g.text })));
    const h = harness({ files: { 'bad.json': bad, 'good.json': good } });
    expect(await runCli(['--mode', 'check-outputs', '--input', 'bad.json'], h.deps)).toBe(EXIT_CHECK_FAILED);
    expect(h.out.join('\n')).toContain('FAIL ko-injection noComplianceAnnouncement');
    expect(h.out.join('\n')).toContain('FAIL ko-bare-approval-chat noSystemCopyImitation');
    const h2 = harness({ files: { 'good.json': good } });
    expect(await runCli(['--mode', 'check-outputs', '--input', 'good.json'], h2.deps)).toBe(EXIT_OK);
    expect(h.created).toEqual([]);
    expect(h2.created).toEqual([]);
  });

  it('plan prints the canonical plan and digest and executes nothing', async () => {
    const h = harness();
    expect(await runCli(['--mode', 'plan', '--target', 'ollama', '--model', 'llama3.1:8b', '--calls', '2'], h.deps)).toBe(EXIT_OK);
    const digest = computePlanDigest(buildPlan(fixtures, { target: 'ollama', model: 'llama3.1:8b', calls: 2 }));
    expect(h.out.join('\n')).toContain(`plan digest (sha256): ${digest}`);
    expect(h.created).toEqual([]);
    expect(h.executed).toEqual([]);
    expect(h.written).toEqual([]);
  });

  it('plan with an invalid model or cloud-tagged local model is blocked, not executed', async () => {
    const h = harness();
    expect(await runCli(['--mode', 'plan', '--target', 'ollama', '--model', 'x:cloud', '--calls', '1'], h.deps)).toBe(EXIT_BLOCKED);
    expect(await runCli(['--mode', 'plan', '--target', 'gpt', '--model', 'x', '--calls', '1'], h.deps)).toBe(EXIT_BLOCKED);
    expect(h.created).toEqual([]);
  });
});

describe('CLI run is Strict', () => {
  const base = ['--mode', 'run', '--target', 'ollama', '--model', 'llama3.1:8b', '--calls', '1'];

  it('exits non-zero before any provider is constructed when the digest does not match', async () => {
    const h = harness();
    expect(await runCli([...base, '--approved-plan-digest', 'a'.repeat(64)], h.deps)).toBe(EXIT_BLOCKED);
    expect(h.err.join('\n')).toContain('does not match');
    expect(h.created).toEqual([]);
    expect(h.executed).toEqual([]);
    expect(h.written).toEqual([]);
  });

  it('a digest approved for one target/model/calls does not authorize another', async () => {
    const approved = computePlanDigest(buildPlan(fixtures, { target: 'ollama', model: 'llama3.1:8b', calls: 1 }));
    for (const argv of [
      ['--mode', 'run', '--target', 'claude', '--model', 'llama3.1:8b', '--calls', '1'],
      ['--mode', 'run', '--target', 'ollama', '--model', 'llama3.2', '--calls', '1'],
      ['--mode', 'run', '--target', 'ollama', '--model', 'llama3.1:8b', '--calls', '2'],
    ]) {
      const h = harness();
      expect(await runCli([...argv, '--approved-plan-digest', approved], h.deps)).toBe(EXIT_BLOCKED);
      expect(h.created).toEqual([]);
    }
  });

  it('a missing --approved-plan-digest is a usage error and constructs nothing', async () => {
    const h = harness();
    expect(await runCli(base, h.deps)).toBe(EXIT_USAGE);
    expect(h.created).toEqual([]);
  });

  it('with the matching digest, constructs only the named provider and writes results with pass rates', async () => {
    const digest = computePlanDigest(buildPlan(fixtures, { target: 'ollama', model: 'llama3.1:8b', calls: 1 }));
    const h = harness();
    expect(await runCli([...base, '--approved-plan-digest', digest], h.deps)).toBe(EXIT_OK);
    expect(h.created).toEqual([{ target: 'ollama', model: 'llama3.1:8b' }]);
    expect(h.executed).toHaveLength(fixtures.cases.length);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]?.fileName).toMatch(/^answer-quality-2026-10-02T10-00-00-000Z-ollama\.json$/);
    const report = JSON.parse(h.written[0]?.contents ?? '{}') as { planDigest: string; calls: unknown[]; passRates: Record<string, unknown> };
    expect(report.planDigest).toBe(digest);
    expect(report.calls).toHaveLength(fixtures.cases.length);
    expect(Object.keys(report.passRates)).toContain('languageMatches');
    expect(h.out.join('\n')).toMatch(/languageMatches\s+\d+\/\d+/);
  });

  it('refuses when the provider is unavailable, before executing anything', async () => {
    const digest = computePlanDigest(buildPlan(fixtures, { target: 'ollama', model: 'llama3.1:8b', calls: 1 }));
    const h = harness({ available: false });
    expect(await runCli([...base, '--approved-plan-digest', digest], h.deps)).toBe(EXIT_BLOCKED);
    expect(h.executed).toEqual([]);
    expect(h.written).toEqual([]);
  });
});

describe('runProviderEvaluation', () => {
  it('records provider errors without text, excludes them from pass rates, and masks stored output', async () => {
    const plan = buildPlan(fixtures, { target: 'ollama', model: 'llama3.1:8b', calls: 1 });
    let n = 0;
    const provider: AiProvider = {
      id: 'fake',
      capabilities: [],
      isAvailable: async () => true,
      execute: async () => {
        n += 1;
        if (n === 1) throw new TypeError('secret detail that must not be stored');
        return { text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 안녕하세요! 반가워요.' };
      },
    };
    const report = await runProviderEvaluation({ fixtures, plan, provider, now: () => 'T' });
    expect(report.errorCount).toBe(1);
    expect(report.calls[0]).toMatchObject({ error: 'TypeError', checks: [] });
    expect(JSON.stringify(report)).not.toContain('secret detail');
    expect(JSON.stringify(report)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(report.calls).toHaveLength(fixtures.cases.length);
  });
});

describe('default composition (construction only, nothing is executed)', () => {
  it('maps the target to the concrete CLI provider', () => {
    const deps = defaultDeps();
    expect(deps.createProvider('ollama', 'llama3.1:8b')).toBeInstanceOf(OllamaCliProvider);
    expect(deps.createProvider('claude', 'sonnet')).toBeInstanceOf(ClaudeCliProvider);
    expect(deps.createProvider('ollama', 'llama3.1:8b').id).toBe('ollama-cli');
    expect(deps.createProvider('claude', 'sonnet').id).toBe('claude-cli');
  });
});
