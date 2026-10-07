import { describe, expect, it } from 'vitest';
import type { CliRunner } from '@quoky/ai-cli';
import { Capability } from '@quoky/core';
import {
  CANONICAL_RECALL_SCENARIO,
  compareRecallInputs,
  createCanonicalRecallRequest,
  evaluateOutputFormat,
  evaluateRecall,
  exportCanonicalRecallRequestSnapshot,
  runComparison,
  runStochasticRecallDiagnostic,
} from './provider-recall-diagnostic';

describe('provider recall diagnostic', () => {
  it('constructs the canonical GENERAL_CHAT scenario through PromptComposer and PromptRenderer', () => {
    const request = createCanonicalRecallRequest();

    expect(request.capability).toBe(Capability.GENERAL_CHAT);
    expect(request.prompt).toContain('# System\n');
    expect(request.prompt).toContain('# Developer\n');
    expect(request.prompt).toContain(CANONICAL_RECALL_SCENARIO.previousUserMessage);
    expect(request.prompt).toContain(CANONICAL_RECALL_SCENARIO.previousAssistantMessage);
    expect(request.prompt).toContain(CANONICAL_RECALL_SCENARIO.currentUserMessage);
    expect(request.prompt).toContain('[Turn 1] User:');
    expect(request.prompt).toContain('[Turn 1] Assistant:');
  });

  it('uses provider serialization, verifies prior-turn presence, and reports input size', async () => {
    const generationInputs: Array<{ args: readonly string[]; input: string }> = [];
    const runner: CliRunner = async (_bin, args, options) => {
      if (args[0] === '--version') {
        return { code: 0, stdout: 'available', stderr: '', timedOut: false };
      }
      generationInputs.push({ args, input: options.input });
      const output = args[0] === 'run' && args.at(-1) === 'granite3.3:8b'
        ? '직전 질문을 기억하지 못해요.'
        : '사용자가 직전에 안녕?이라고 질문했어요.';
      return { code: 0, stdout: output, stderr: '', timedOut: false };
    };
    let clock = 0;

    const report = await runComparison({ runner, now: () => (clock += 5) });
    const results = report.productionPath;

    expect(results).toHaveLength(3);
    expect(generationInputs).toHaveLength(5);
    expect(results.map((result) => result.providerId)).toEqual([
      'ollama-cli:llama3.1:8b',
      'ollama-cli:granite3.3:8b',
      'claude-cli',
    ]);
    for (const [index, result] of results.entries()) {
      const serializedInput = generationInputs[index]?.input ?? '';
      expect(serializedInput).toContain(CANONICAL_RECALL_SCENARIO.previousUserMessage);
      expect(serializedInput).toContain(CANONICAL_RECALL_SCENARIO.previousAssistantMessage);
      expect(result.previousTurnPresentAtProviderBoundary).toBe(true);
      expect(result.serializedInputCharacterCount).toBe(serializedInput.length);
      expect(result.serializedInputCharacterCount).toBeGreaterThan(0);
      expect(result.contextTruncationOccurred).toBe(false);
      expect(result.generationLatencyMs).toBe(5);
    }
    for (const serializedInput of generationInputs.slice(0, 2).map(({ input }) => input)) {
      expect(serializedInput).not.toContain('# Role-attributed conversation');
      expect(serializedInput).not.toContain('immediatelyPreviousUserTurn');
      expect(serializedInput).not.toContain(
        'Immediately previous User turn (exact continuity anchor)',
      );
      expect(serializedInput.indexOf(CANONICAL_RECALL_SCENARIO.previousUserMessage)).toBeLessThan(
        serializedInput.indexOf(
          `User (current active turn): ${JSON.stringify(CANONICAL_RECALL_SCENARIO.currentUserMessage)}`,
        ),
      );
    }
    expect(generationInputs[2]?.input).toBe(createCanonicalRecallRequest().prompt);
    expect(results.map((result) => result.semanticRecallResult)).toEqual(['PASS', 'FAIL', 'PASS']);
    expect(results.map((result) => result.outputFormatResult)).toEqual(['CLEAN', 'CLEAN', 'CLEAN']);

    expect(results.every(({ category }) => category === 'PRODUCTION_PATH')).toBe(true);
    expect(report.normalizedInputControl.map(({ modelIdentity }) => modelIdentity)).toEqual([
      'llama3.1:8b',
      'granite3.3:8b',
    ]);
    expect(report.normalizedInputControl.every(
      ({ category }) => category === 'NORMALIZED_INPUT_CONTROL',
    )).toBe(true);
    expect(generationInputs[3]?.input).toBe(createCanonicalRecallRequest().prompt);
    expect(generationInputs[4]?.input).toBe(createCanonicalRecallRequest().prompt);
    expect(report.conclusions).toEqual([
      expect.objectContaining({ conclusion: 'MODEL_EFFECT', status: 'SUPPORTED' }),
      expect.objectContaining({ conclusion: 'OLLAMA_SERIALIZATION_EFFECT', status: 'INCONCLUSIVE' }),
      expect.objectContaining({ conclusion: 'QUIRKYBOT_CONTEXT_EFFECT', status: 'INCONCLUSIVE' }),
    ]);
  });

  it('includes Claude only when ClaudeCliProvider reports availability', async () => {
    const runner: CliRunner = async (_bin, args) => {
      if (args[0] === '--version') {
        return { code: 1, stdout: '', stderr: 'unavailable', timedOut: false };
      }
      return { code: 0, stdout: '안녕이 직전 질문이었어요.', stderr: '', timedOut: false };
    };

    const results = (await runComparison({ runner })).productionPath;

    expect(results.map((result) => result.providerId)).toEqual([
      'ollama-cli:llama3.1:8b',
      'ollama-cli:granite3.3:8b',
    ]);
  });

  it('runs the default bounded stochastic sample and aggregates passing runs', async () => {
    let calls = 0;
    const runner: CliRunner = async () => {
      calls += 1;
      return {
        code: 0,
        stdout: '사용자가 직전에 "안녕?"이라고 질문했어요.',
        stderr: '',
        timedOut: false,
      };
    };

    const report = await runStochasticRecallDiagnostic({ runner });

    expect(calls).toBe(5);
    expect(report.iterationCount).toBe(5);
    expect(report.runs.map(({ run, semanticRecallResult }) => ({ run, semanticRecallResult }))).toEqual([
      { run: 1, semanticRecallResult: 'PASS' },
      { run: 2, semanticRecallResult: 'PASS' },
      { run: 3, semanticRecallResult: 'PASS' },
      { run: 4, semanticRecallResult: 'PASS' },
      { run: 5, semanticRecallResult: 'PASS' },
    ]);
    expect(report).toMatchObject({
      passCount: 5,
      failCount: 0,
      reliabilityRatio: 1,
      formatPassCount: 5,
      formatFailCount: 0,
      formatCorrectnessRatio: 1,
    });
  });

  it('reports mixed recall reliability after adapter metadata sanitization', async () => {
    const outputs = [
      '{"role":"assistant","provenance":"ASSISTANT","epistemicStatus":"ASSISTANT_NON_AUTHORITATIVE","content":"안녕?"}',
      '기억하지 못해요.',
      '직전 질문은 "안녕?" 입니다.',
      '무엇을 질문하셨나요?',
    ];
    const runner: CliRunner = async () => ({
      code: 0,
      stdout: outputs.shift() ?? '',
      stderr: '',
      timedOut: false,
    });

    const report = await runStochasticRecallDiagnostic({ runner, iterations: 4 });

    expect(report.runs.map(({ semanticRecallResult }) => semanticRecallResult)).toEqual([
      'PASS', 'FAIL', 'PASS', 'FAIL',
    ]);
    expect(report.runs.map(({ outputFormatResult }) => outputFormatResult)).toEqual([
      'CLEAN', 'CLEAN', 'CLEAN', 'CLEAN',
    ]);
    expect(report).toMatchObject({ passCount: 2, failCount: 2, reliabilityRatio: 0.5 });
    expect(report).toMatchObject({
      formatPassCount: 4,
      formatFailCount: 0,
      formatCorrectnessRatio: 1,
    });
  });

  it('detects prompt-layer and system-instruction differences with bounded excerpts', () => {
    const canonical = createCanonicalRecallRequest();
    const live = {
      ...canonical,
      prompt: canonical.prompt
        .replace('You are Quoky', 'You are Live Quoky')
        .replace('# Task', '# Additional\nLive-only layer\n\n# Task'),
    };

    const report = compareRecallInputs(canonical, live);

    expect(report.candidate).toBe('LIVE_RUNTIME_CONTEXT_DIFFERENCE');
    expect(report.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'SYSTEM_INSTRUCTIONS', path: 'prompt.System' }),
      expect.objectContaining({ category: 'PROMPT_LAYER', path: 'prompt.Additional' }),
    ]));
    expect(report.differences.every(({ canonical: value }) => value.length < 120)).toBe(true);
  });

  it('detects context-entry differences without exposing metadata values', () => {
    const canonical = {
      ...createCanonicalRecallRequest(),
      contextFiles: [{ path: '.chunsik/context.md', content: 'canonical context' }],
      metadata: { token: 'canonical-secret' },
    };
    const live = {
      ...canonical,
      contextFiles: [{ path: '.chunsik/context.md', content: 'live context' }],
      metadata: { token: 'live-secret', attempt: 1 },
    };

    const report = compareRecallInputs(canonical, live);

    expect(report.differences).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'CONTEXT_ENTRY', path: 'contextFiles..chunsik/context.md' }),
      expect.objectContaining({ category: 'METADATA', path: 'metadata.token' }),
      expect.objectContaining({ category: 'METADATA', path: 'metadata.attempt' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('canonical-secret');
    expect(JSON.stringify(report)).not.toContain('live-secret');
  });

  it('reports structurally identical inputs as a MODEL_STOCHASTICITY candidate', () => {
    const canonical = createCanonicalRecallRequest();

    expect(compareRecallInputs(canonical, structuredClone(canonical))).toEqual({
      candidate: 'MODEL_STOCHASTICITY',
      identical: true,
      differences: [],
    });
  });

  it('exports a stable deterministic canonical AiRequest snapshot', () => {
    const first = exportCanonicalRecallRequestSnapshot();
    const second = exportCanonicalRecallRequestSnapshot();

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toEqual(createCanonicalRecallRequest());
    expect(first.indexOf('"capability"')).toBeLessThan(first.indexOf('"prompt"'));
  });

  it.each([
    ['identifies the USER message', '사용자가 직전에 "안녕?"이라고 질문했어요.', 'PASS'],
    ['preserves English user attribution', 'The user said "안녕?".', 'PASS'],
    ['accepts an honorific question form', '방금 "안녕?"이라고 질문하셨습니다.', 'PASS'],
    ['accepts an honorific asking form', '"안녕?"이라고 물어보셨어요.', 'PASS'],
    ['accepts a previous-question label', '직전 질문은 "안녕?" 입니다.', 'PASS'],
    ['accepts a bare user-message label', '직전 사용자 메시지: "안녕?"', 'PASS'],
    ['accepts a user label with an honorific', '사용자님이 "안녕?"이라고 질문했어요.', 'PASS'],
    ['accepts a customer label with an honorific', '고객님께서 "안녕?"이라고 하셨습니다.', 'PASS'],
    [
      'identifies the specified ASSISTANT message instead',
      '직전 메시지는 Assistant가 답한 "네, 안녕하세요!"예요.',
      'FAIL',
    ],
    ['identifies the ASSISTANT message instead', 'Assistant가 직전에 "안녕?"이라고 말했어요.', 'FAIL'],
    ['says it cannot remember', '직전 질문은 기억하지 못해요.', 'FAIL'],
    ['gives a meta clarification response', '"안녕?"이라고 물어보신 게 맞나요?', 'FAIL'],
  ] as const)('%s', (_case, output, expected) => {
    expect(evaluateRecall(output)).toBe(expected);
  });

  it.each([
    [
      'accepts a correct answer that separately restates both turns',
      '직전 어시스턴트 답변은 "네, 안녕하세요!"였고, 사용자는 "안녕?"이라고 질문했어요.',
      'PASS',
    ],
    ['rejects assistant self-attribution', '제가 방금 "안녕?"이라고 말했어요.', 'FAIL'],
    ['rejects bot attribution', '봇이 직전에 "안녕?"이라고 말했어요.', 'FAIL'],
    ['rejects AI attribution', 'ai가 "안녕?"이라고 말했습니다.', 'FAIL'],
    ['rejects assistant attribution with an honorific verb', '봇이 "안녕?"이라고 하셨습니다.', 'FAIL'],
    [
      'rejects negated user attribution with assistant as the real subject',
      '사용자가 아니라 어시스턴트가 "안녕?"이라고 말했어요.',
      'FAIL',
    ],
    ['rejects a clarification question form', '혹시 "안녕?"이라고 질문하셨나요?', 'FAIL'],
    ['rejects the canonical text without previous-user attribution', '안녕? 반가워요.', 'FAIL'],
  ] as const)('%s', (_case, output, expected) => {
    expect(evaluateRecall(output)).toBe(expected);
  });

  it('scores semantic recall independently from role-envelope contamination', () => {
    const contaminated =
      '{"role":"assistant","provenance":"ASSISTANT",' +
      '"epistemicStatus":"ASSISTANT_NON_AUTHORITATIVE","content":"안녕?"}';

    expect(evaluateRecall(contaminated)).toBe('PASS');
    expect(evaluateOutputFormat(contaminated)).toBe('CONTAMINATED');
    expect(evaluateOutputFormat('사용자가 직전에 "안녕?"이라고 질문했어요.')).toBe('CLEAN');
  });

  it('detects escaped and malformed role/provenance envelope output', () => {
    expect(evaluateOutputFormat(
      String.raw`{\"role\":\"assistant\",\"provenance\":\"ASSISTANT\",broken}`,
    )).toBe('CONTAMINATED');
  });
});
