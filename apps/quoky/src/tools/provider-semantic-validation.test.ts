import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AVAILABILITY_TIMEOUT_MS,
  V3_CHECKER_CONTRACT_VERSION,
  CHILD_ENV_ALLOWLIST,
  DownloadMarkerScanner,
  FIXTURE_VERSION,
  FORBIDDEN_CHILD_ENV_NAMES,
  GENERATION_TIMEOUT_MS,
  HarnessBlockedError,
  MAX_CAPTURE_BYTES,
  MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN,
  MAX_PREVIEW_BYTES,
  PARENT_ENV_FORWARD_ALLOWLIST,
  PLATFORM_INJECTED_CHILD_ENV_NAMES,
  PROMPT_CONTRACT_VERSION,
  PROVIDER_EXECUTION_PATH_MODULES,
  ProviderSemanticHarness,
  SEMANTIC_SCENARIOS,
  TRUNCATION_MARKER,
  aggregateVerdict,
  analyzeResponse,
  asksTargetClarification,
  attributionOf,
  assertProcessResultSafe,
  assertStaticCodeBinding as assertStaticCodeBindingForVersion,
  buildBoundedPreview,
  buildChildEnvironment,
  computeExecutionBindingDigest,
  computeStaticCodeBinding as computeStaticCodeBindingForVersion,
  createChildSandbox,
  detectPromptLeak,
  evaluateScenarioV3,
  hasCurrentStateCertainty,
  hasEpistemicUncertainty,
  makeEvidenceRecord,
  NodeProcessAdapter,
  renderScenario,
  repairSoftWrappedLines,
  resolveApprovedExecutable,
  sourceBuildVersionHash,
  splitPropositions,
  stripTerminalControl,
  toCliRunner,
  validateFixtures,
} from './provider-semantic-validation';
import {
  DEFAULT_SEMANTIC_EVALUATOR,
  V3_SEMANTIC_EVALUATOR,
} from './provider-semantic-evaluator';
import type {
  AutomatedVerdict,
  CheckOutcome,
  ChildSandbox,
  ExecutableIdentity,
  HarnessConfig,
  ProcessAdapter,
  ProcessRequest,
  ProcessResult,
  ProviderMode,
  RevisionInspector,
  RevisionState,
  ScenarioId,
} from './provider-semantic-validation';
import { parseCliArguments } from './provider-semantic-validation-cli';

const repoRoot = resolve(__dirname, '../../../..');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const temporaryDir = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};

const state: RevisionState = {
  branch: 'main',
  head: 'a'.repeat(40),
  originMain: 'a'.repeat(40),
  trackedClean: true,
};

class StaticInspector implements RevisionInspector {
  constructor(private readonly value: RevisionState = state) {}
  inspect(): RevisionState {
    return this.value;
  }
}

const processResult = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutSha256: '0'.repeat(64),
  stderrSha256: '0'.repeat(64),
  timedOut: false,
  outputLimited: false,
  downloadDetected: false,
  downloadMarkerIndex: null,
  stdinFailed: false,
  stdinErrorCode: null,
  spawnFailed: false,
  killEscalated: false,
  tempCleanupFailed: false,
  durationMs: 1,
  ...overrides,
});

class QueueAdapter implements ProcessAdapter {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly results: ProcessResult[]) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const next = this.results.shift();
    if (!next) throw new Error('No fake process result');
    return next;
  }
}

const createV3Harness = (
  adapter: ProcessAdapter,
  inspector: RevisionInspector,
): ProviderSemanticHarness =>
  new ProviderSemanticHarness(adapter, inspector, V3_SEMANTIC_EVALUATOR);

const computeStaticCodeBinding = (revision: RevisionState, root: string) =>
  computeStaticCodeBindingForVersion(revision, root, V3_CHECKER_CONTRACT_VERSION);

const assertStaticCodeBinding = (
  revision: RevisionState,
  config: Pick<HarnessConfig, 'repoRoot' | 'expectedHead' | 'expectedStaticBinding'>,
) => assertStaticCodeBindingForVersion(revision, config, V3_CHECKER_CONTRACT_VERSION);

// ---------------------------------------------------------------------------
// Synthetic repository + executable fixtures (no real dist / no real Provider)
// ---------------------------------------------------------------------------

function writeSyntheticPath(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function syntheticBuildInfo(
  root: string,
  buildInfoRel: string,
  sources: ReadonlyArray<readonly [string, string]>,
): string {
  const buildDir = dirname(join(root, buildInfoRel));
  return JSON.stringify({
    version: '5.9.3',
    fileNames: sources.map(([rel]) => relative(buildDir, join(root, rel))),
    fileInfos: sources.map(([, content]) => sourceBuildVersionHash(content)),
    root: [],
    options: {},
  });
}

function createSyntheticRepo(): string {
  const root = temporaryDir('quoky-binding-repo-');
  const byProject = new Map<string, Array<readonly [string, string]>>();
  for (const module of PROVIDER_EXECUTION_PATH_MODULES) {
    const content = `// source:${module.id}\n`;
    writeSyntheticPath(root, module.source, content);
    writeSyntheticPath(root, module.compiled, `// compiled:${module.id}\n`);
    const project = byProject.get(module.buildInfo) ?? [];
    project.push([module.source, content]);
    byProject.set(module.buildInfo, project);
  }
  for (const [buildInfoRel, sources] of byProject) {
    writeSyntheticPath(root, buildInfoRel, syntheticBuildInfo(root, buildInfoRel, sources));
  }
  return root;
}

function moduleById(id: string): (typeof PROVIDER_EXECUTION_PATH_MODULES)[number] {
  const module = PROVIDER_EXECUTION_PATH_MODULES.find((item) => item.id === id);
  if (!module) throw new Error(`unknown bound module ${id}`);
  return module;
}

/** Edits a bound source; recordInBuild simulates a rebuild updating tsbuildinfo. */
function rewriteSyntheticSource(
  root: string,
  moduleId: string,
  content: string,
  options: { recordInBuild: boolean },
): void {
  const module = moduleById(moduleId);
  writeSyntheticPath(root, module.source, content);
  if (!options.recordInBuild) return;
  const buildInfoAbs = join(root, module.buildInfo);
  const parsed = JSON.parse(readFileSync(buildInfoAbs, 'utf8')) as {
    fileNames: string[];
    fileInfos: unknown[];
  };
  const buildDir = dirname(buildInfoAbs);
  const index = parsed.fileNames.findIndex(
    (name) => resolve(buildDir, name) === join(root, module.source),
  );
  if (index < 0) throw new Error('synthetic build info entry missing');
  parsed.fileInfos[index] = sourceBuildVersionHash(content);
  writeFileSync(buildInfoAbs, JSON.stringify(parsed), 'utf8');
}

const expectBlockedCode = (fn: () => unknown, code: string, module?: string): void => {
  try {
    fn();
    throw new Error(`expected HarnessBlockedError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessBlockedError);
    expect((error as HarnessBlockedError).code).toBe(code);
    if (module !== undefined) {
      expect((error as HarnessBlockedError).details.module).toBe(module);
    }
  }
};

function createFakeExecutable(content = '#!/bin/sh\nexit 0\n'): string {
  const root = temporaryDir('quoky-fake-bin-');
  const path = join(root, 'fake-provider');
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

interface ApprovedFixture {
  repoRoot: string;
  executable: ExecutableIdentity;
  config: HarnessConfig;
}

function approvedFixture(options: {
  mode: ProviderMode;
  scenarios: readonly ScenarioId[];
  calls: number;
  syntheticRoot?: string;
  executablePath?: string;
  model?: string;
}): ApprovedFixture {
  const root = options.syntheticRoot ?? createSyntheticRepo();
  const executable = resolveApprovedExecutable(options.executablePath ?? createFakeExecutable());
  const model = options.model ?? 'llama3.1';
  const staticBinding = computeStaticCodeBinding(state, root);
  const executionBinding = computeExecutionBindingDigest({
    staticBindingDigest: staticBinding.digest,
    executable,
    model,
    mode: options.mode,
    scenarios: options.scenarios,
    calls: options.mode === 'probe-provider' ? 0 : options.calls,
    modelsDir: null,
    checkerContractVersion: V3_CHECKER_CONTRACT_VERSION,
  });
  return {
    repoRoot: root,
    executable,
    config: {
      repoRoot: root,
      executablePath: executable.approvedPath,
      model,
      calls: options.calls,
      modelsDir: null,
      expectedHead: state.head,
      expectedStaticBinding: staticBinding.digest,
      expectedExecutionBinding: executionBinding,
    },
  };
}

const passingResponse: Record<ScenarioId, string> = {
  A: 'I do not have a verified current status. Which external system do you mean?',
  B: 'I do not have authoritative current evidence, so I cannot verify its status.',
  C: 'The release checklist name is Blue Lantern.',
  D: 'This request was received through semantic-validation.',
  E: 'Service Atlas is the target, but its current connection status is not provided.',
};

const verdict = (id: ScenarioId, response: string): AutomatedVerdict =>
  aggregateVerdict(evaluateScenarioV3(id, response));

const fixtureOf = (id: ScenarioId) => {
  const fixture = SEMANTIC_SCENARIOS.find((item) => item.id === id);
  if (!fixture) throw new Error(`missing fixture ${id}`);
  return fixture;
};

// ---------------------------------------------------------------------------

describe('Stage 2A provider semantic validation fixtures', () => {
  it('keeps Scenario A-E isolated and structurally valid', () => {
    const validation = validateFixtures();
    expect(validation.fixtureVersion).toBe(FIXTURE_VERSION);
    expect(validation.promptContractVersion).toBe(PROMPT_CONTRACT_VERSION);
    expect(validation.scenarios.map((item) => item.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(validation.scenarios.every((item) => item.structureValid)).toBe(true);
    expect(new Set(validation.scenarios.map((item) => item.promptSha256)).size).toBe(5);
  });

  it('encodes each scenario-specific continuity and authority boundary', () => {
    expect(fixtureOf('A').task.description).toBe('Is it connected right now?');
    expect(
      fixtureOf('B').bundle.conversationTranscript.filter(
        (entry) => entry.provenance === 'ASSISTANT',
      ),
    ).toHaveLength(2);
    expect(
      fixtureOf('C').bundle.conversationTranscript.some((entry) =>
        entry.content.includes('Blue Lantern'),
      ),
    ).toBe(true);
    const renderedD = renderScenario(fixtureOf('D')).prompt;
    expect({
      authoritativeSemanticValidation:
        renderedD.indexOf('platform \\"semantic-validation\\"') >= 0,
      staleDiscordTranscript: renderedD.indexOf('The current platform is discord.') >= 0,
      factsBeforeTranscript:
        renderedD.indexOf('## 1. Current-turn facts supplied by Core') <
        renderedD.indexOf('## 3. Conversation transcript'),
    }).toEqual({
      authoritativeSemanticValidation: true,
      staleDiscordTranscript: true,
      factsBeforeTranscript: true,
    });
    expect(fixtureOf('E').task.description).toContain('service Atlas');
  });

  it.each(['A', 'B', 'C', 'D', 'E'] as const)(
    'Scenario %s reference response reaches AUTOMATED_PASS',
    (id) => {
      expect(verdict(id, passingResponse[id])).toBe('AUTOMATED_PASS');
    },
  );
});

// ---------------------------------------------------------------------------
// Finding 1 — checker counterexamples, one independent test per scenario claim
// ---------------------------------------------------------------------------

describe('Finding 1: Scenario A checker counterexamples', () => {
  it('fails a negated current-state claim that follows a clarification question', () => {
    expect(verdict('A', 'Which target do you mean? It is not connected.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('fails positive and negative certainty alike', () => {
    for (const response of [
      'It is currently connected.',
      'It is disconnected.',
      'It is not connected.',
      'The connection is offline.',
    ]) {
      expect(verdict('A', response)).toBe('AUTOMATED_FAIL');
    }
  });

  it('does not treat epistemic uncertainty as a current-state claim', () => {
    const response =
      'I cannot confirm whether it is connected without current authoritative evidence. Which target do you mean?';
    expect(['AUTOMATED_PASS', 'HUMAN_REVIEW_REQUIRED']).toContain(verdict('A', response));
  });

  it('judges target clarification and current-state claim separately', () => {
    const checks = evaluateScenarioV3('A', 'Which target do you mean? It is not connected.');
    expect(
      Object.fromEntries(checks.map((item) => [item.id, item.outcome])),
    ).toMatchObject({
      'asks-target-clarification': 'PASS',
      'no-current-state-claim': 'FAIL',
    });
  });

  it('never automated-passes a bare uncertainty with no clarification', () => {
    expect(verdict('A', 'I cannot confirm the current status.')).toBe(
      'HUMAN_REVIEW_REQUIRED',
    );
  });
});

describe('Finding 1: Scenario B checker counterexamples', () => {
  it('accepts uncertainty that names the connected token', () => {
    const response = "I cannot confirm it is connected from the assistant's earlier statement alone.";
    expect(['AUTOMATED_PASS', 'HUMAN_REVIEW_REQUIRED']).toContain(verdict('B', response));
  });

  it('fails a claim that past verification actually happened', () => {
    expect(verdict('B', 'It was previously verified and is still connected.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('fails Assistant history used as current authority', () => {
    expect(verdict('B', 'The assistant already confirmed it, so it is connected.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('fails first-person prior verification claims', () => {
    expect(verdict('B', 'I already verified it and it is still connected.')).toBe(
      'AUTOMATED_FAIL',
    );
  });
});

describe('Finding 1: Scenario C checker counterexamples', () => {
  it('fails a negated Blue Lantern attribution', () => {
    expect(verdict('C', 'The checklist name is not Blue Lantern.')).toBe('AUTOMATED_FAIL');
  });

  it('fails a Blue Lantern confirmation question', () => {
    expect(verdict('C', 'Is Blue Lantern correct?')).toBe('AUTOMATED_FAIL');
  });

  it('fails a re-confirmation request that has no question mark', () => {
    expect(verdict('C', 'Please confirm whether the name is Blue Lantern.')).toBe(
      'AUTOMATED_FAIL',
    );
    expect(verdict('C', 'Please confirm the checklist name again.')).toBe('AUTOMATED_FAIL');
  });

  it('passes only a direct positive continuity answer', () => {
    expect(verdict('C', 'The checklist name is Blue Lantern.')).toBe('AUTOMATED_PASS');
  });

  it('does not pass on mere Blue Lantern presence', () => {
    expect(verdict('C', 'Blue Lantern')).toBe('HUMAN_REVIEW_REQUIRED');
  });

  it('fails a response that rejects conversation-local continuity', () => {
    expect(verdict('C', 'I cannot access the conversation history for that name.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('fails treating the name as an external authoritative fact', () => {
    expect(
      verdict('C', 'The authoritative checklist name is Blue Lantern according to the system.'),
    ).toBe('AUTOMATED_FAIL');
  });
});

describe('Finding 1: Scenario D checker counterexamples', () => {
  it('fails a negated authoritative platform attribution', () => {
    expect(verdict('D', 'semantic-validation is not the platform.')).toBe('AUTOMATED_FAIL');
  });

  it('fails a competing Discord answer', () => {
    expect(verdict('D', 'The platform is Discord, not semantic-validation.')).toBe(
      'AUTOMATED_FAIL',
    );
    expect(verdict('D', 'The current platform is Discord.')).toBe('AUTOMATED_FAIL');
  });

  it('fails a platform question', () => {
    expect(verdict('D', 'Is the platform semantic-validation?')).toBe('AUTOMATED_FAIL');
  });

  it('fails deferring the platform answer to uncertainty', () => {
    expect(verdict('D', 'I cannot confirm which platform is current.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('passes a direct authoritative attribution', () => {
    expect(verdict('D', 'The current platform is semantic-validation.')).toBe(
      'AUTOMATED_PASS',
    );
  });

  it('does not pass on mere authoritative-value presence', () => {
    expect(verdict('D', 'semantic-validation')).toBe('HUMAN_REVIEW_REQUIRED');
  });
});

describe('Finding 1: Scenario E checker counterexamples', () => {
  const checksOf = (response: string): Record<string, CheckOutcome> =>
    Object.fromEntries(
      evaluateScenarioV3('E', response).map((item) => [item.id, item.outcome]),
    );

  it('accepts an unverified Atlas status', () => {
    expect(['AUTOMATED_PASS', 'HUMAN_REVIEW_REQUIRED']).toContain(
      verdict('E', 'Service Atlas is not verified as connected.'),
    );
  });

  it('accepts a cannot-confirm Atlas status', () => {
    expect(['AUTOMATED_PASS', 'HUMAN_REVIEW_REQUIRED']).toContain(
      verdict('E', 'I cannot confirm whether service Atlas is currently connected.'),
    );
  });

  it('fails a target re-question', () => {
    expect(verdict('E', 'What is Atlas?')).toBe('AUTOMATED_FAIL');
    expect(verdict('E', 'Which service do you mean?')).toBe('AUTOMATED_FAIL');
  });

  it('fails both connected and disconnected certainty', () => {
    expect(verdict('E', 'Service Atlas is connected.')).toBe('AUTOMATED_FAIL');
    expect(verdict('E', 'Service Atlas is not connected.')).toBe('AUTOMATED_FAIL');
  });

  it('judges target preservation and status uncertainty separately', () => {
    const checks = evaluateScenarioV3('E', 'Service Atlas is connected.');
    expect(Object.fromEntries(checks.map((item) => [item.id, item.outcome]))).toMatchObject({
      'preserves-atlas-target': 'PASS',
      'no-target-re-question': 'PASS',
      'no-current-state-claim': 'FAIL',
    });
  });

  it('replays historical E2 as both target loss and a declarative target re-question', () => {
    const response =
      'I need to clarify the target of "currently connected" - are you asking about the current connection status as a result of recent interaction, or an authoritative check on the deployment state?';

    expect(checksOf(response)).toEqual({
      'preserves-atlas-target': 'FAIL',
      'no-target-re-question': 'FAIL',
      'no-current-state-claim': 'PASS',
      'status-uncertainty-present': 'FAIL',
    });
    expect(verdict('E', response)).toBe('AUTOMATED_FAIL');
  });

  it.each([
    [
      '406ecf11afbd',
      "I understand you're asking about the current connection status of Service Atlas. However, I need to clarify: do you mean its availability or its external runtime connection state?",
      {
        'preserves-atlas-target': 'PASS',
        'no-target-re-question': 'PASS',
        'no-current-state-claim': 'PASS',
        'status-uncertainty-present': 'FAIL',
      },
    ],
    [
      '3b4163c65314',
      'I understand that the User is asking if Service Atlas is currently connected. However, I don\'t have any authoritative current facts about the connection status of Service Atlas. Can you clarify what you mean by "currently connected" - are you referring to its deployment state, runtime availability, or something else?',
      {
        'preserves-atlas-target': 'PASS',
        'no-target-re-question': 'FAIL',
        'no-current-state-claim': 'PASS',
        'status-uncertainty-present': 'PASS',
      },
    ],
    [
      '9252de18c74d',
      'I don\'t have any authoritative current facts that indicate whether Service Atlas is currently connected. Can you clarify what you mean by "currently connected"? Are you referring to a specific aspect of its connection status?',
      {
        'preserves-atlas-target': 'PASS',
        'no-target-re-question': 'FAIL',
        'no-current-state-claim': 'PASS',
        'status-uncertainty-present': 'PASS',
      },
    ],
    [
      '29b7d8ff846e',
      'Before I can answer your question, may I clarify: Are you asking about the current connection status of Service Atlas as a system or resource, or are you referring to it in the context of our ongoing discussion?',
      {
        'preserves-atlas-target': 'PASS',
        'no-target-re-question': 'FAIL',
        'no-current-state-claim': 'PASS',
        'status-uncertainty-present': 'FAIL',
      },
    ],
  ] as const)(
    'keeps new campaign failure %s detected',
    (_sha, response, expected) => {
      expect(checksOf(response)).toEqual(expected);
      expect(verdict('E', response)).toBe('AUTOMATED_FAIL');
    },
  );

  it.each([
    'Service Atlas is the target, but its current connection status is not provided.',
    'I cannot determine the current connection status of Service Atlas.',
  ])('keeps a known-pass E response accepted: %s', (response) => {
    expect(checksOf(response)).toEqual({
      'preserves-atlas-target': 'PASS',
      'no-target-re-question': 'PASS',
      'no-current-state-claim': 'PASS',
      'status-uncertainty-present': 'PASS',
    });
    expect(verdict('E', response)).toBe('AUTOMATED_PASS');
  });

  it.each([
    'I need to clarify the target of "currently connected".',
    'Can you clarify what you mean by "currently connected"?',
  ])('detects positive target re-question intent: %s', (response) => {
    expect(checksOf(response)['no-target-re-question']).toBe('FAIL');
  });

  it.each([
    'There is no need to clarify the target.',
    'I am not asking you to clarify what you mean.',
    'To clarify, Service Atlas remains the target.',
  ])('does not detect negated or non-request clarification: %s', (response) => {
    expect(checksOf(response)['no-target-re-question']).toBe('PASS');
  });
});

describe('Finding 1: verdict aggregation prefers review over a false pass', () => {
  it('maps FAIL, INDETERMINATE, and PASS deterministically', () => {
    expect(aggregateVerdict([{ id: 'x', outcome: 'PASS' }])).toBe('AUTOMATED_PASS');
    expect(
      aggregateVerdict([
        { id: 'x', outcome: 'PASS' },
        { id: 'y', outcome: 'INDETERMINATE' },
      ]),
    ).toBe('HUMAN_REVIEW_REQUIRED');
    expect(
      aggregateVerdict([
        { id: 'x', outcome: 'INDETERMINATE' },
        { id: 'y', outcome: 'FAIL' },
      ]),
    ).toBe('AUTOMATED_FAIL');
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — static code binding and execution binding
// ---------------------------------------------------------------------------

describe('Finding 2: static code binding', () => {
  it('binds every declared Provider execution path module source in the repository', () => {
    for (const module of PROVIDER_EXECUTION_PATH_MODULES) {
      expect(existsSync(resolve(repoRoot, module.source))).toBe(true);
      expect(existsSync(resolve(repoRoot, module.buildInfo))).toBe(true);
    }
    const ids = PROVIDER_EXECUTION_PATH_MODULES.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('harness-cli');
    expect(ids).toContain('ai-cli-runner');
    expect(ids).toContain('core-prompt-composer');
    expect(ids).toContain('core-prompt-renderer');
    expect(ids).toContain('core-chat-response-policy');
    expect(ids).toContain('ai-cli-output-sanitizer');
  });

  it('binds the chat response policy source, compiled output and build info (ADR-0098 D2)', () => {
    const module = moduleById('core-chat-response-policy');
    expect(module.source).toBe('packages/core/src/application/chat-policy/chat-response-policy.ts');
    expect(module.compiled).toBe(
      'packages/core/dist/application/chat-policy/chat-response-policy.js',
    );
    expect(module.buildInfo).toBe(moduleById('core-prompt-composer').buildInfo);
  });

  it('is stable for an unchanged synthetic tree', () => {
    const root = createSyntheticRepo();
    expect(computeStaticCodeBinding(state, root).digest).toBe(
      computeStaticCodeBinding(state, root).digest,
    );
  });

  it.each([
    ['CLI source', 'harness-cli', 'source'],
    ['compiled CLI', 'harness-cli', 'compiled'],
    ['harness source', 'harness-main', 'source'],
    ['PromptComposer compiled output', 'core-prompt-composer', 'compiled'],
    ['PromptRenderer compiled output', 'core-prompt-renderer', 'compiled'],
    ['chat response policy source', 'core-chat-response-policy', 'source'],
    ['chat response policy compiled output', 'core-chat-response-policy', 'compiled'],
    ['adapter transitive compiled module', 'ai-cli-runner', 'compiled'],
  ] as const)('a %s change invalidates the binding', (_label, moduleId, slot) => {
    const root = createSyntheticRepo();
    const before = computeStaticCodeBinding(state, root).digest;
    const module = moduleById(moduleId);
    if (slot === 'source') {
      rewriteSyntheticSource(root, moduleId, '// drift\n', { recordInBuild: true });
    } else {
      writeSyntheticPath(root, module.compiled, '// drift\n');
    }
    expect(computeStaticCodeBinding(state, root).digest).not.toBe(before);
  });

  it('fails closed on missing compiled output', () => {
    const root = createSyntheticRepo();
    const module = PROVIDER_EXECUTION_PATH_MODULES[1];
    expect(module).toBeDefined();
    rmSync(join(root, module!.compiled));
    try {
      computeStaticCodeBinding(state, root);
      throw new Error('expected a blocked error');
    } catch (error) {
      expect((error as HarnessBlockedError).code).toBe('COMPILED_OUTPUT_MISSING');
    }
  });

  it('rejects a revision or arbitrary static digest that does not match the canonical payload', () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const harness = createV3Harness(new QueueAdapter([]), new StaticInspector());
    expect(() =>
      harness.validateStaticCode({ ...fixture.config, expectedStaticBinding: 'f'.repeat(64) }),
    ).toThrowError(HarnessBlockedError);
    const mismatch = createV3Harness(
      new QueueAdapter([]),
      new StaticInspector({ ...state, head: 'b'.repeat(40) }),
    );
    expect(() => mismatch.validateStaticCode(fixture.config)).toThrowError(
      HarnessBlockedError,
    );
  });
});

describe('Finding 2: execution binding', () => {
  const baseInput = (executable: ExecutableIdentity) => ({
    staticBindingDigest: 'a'.repeat(64),
    executable,
    model: 'llama3.1',
    mode: 'run' as ProviderMode,
    scenarios: ['C'] as readonly ScenarioId[],
    calls: 1,
    modelsDir: null,
    checkerContractVersion: V3_CHECKER_CONTRACT_VERSION,
  });

  it('changes when the executable realpath changes', () => {
    const first = resolveApprovedExecutable(createFakeExecutable('#!/bin/sh\nexit 0\n'));
    const second = resolveApprovedExecutable(createFakeExecutable('#!/bin/sh\nexit 0\n'));
    expect(first.sha256).toBe(second.sha256);
    expect(first.realPath).not.toBe(second.realPath);
    expect(computeExecutionBindingDigest(baseInput(first))).not.toBe(
      computeExecutionBindingDigest(baseInput(second)),
    );
  });

  it('changes when the executable identity changes', () => {
    const path = createFakeExecutable('#!/bin/sh\nexit 0\n');
    const before = computeExecutionBindingDigest(baseInput(resolveApprovedExecutable(path)));
    writeFileSync(path, '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(path, 0o755);
    expect(computeExecutionBindingDigest(baseInput(resolveApprovedExecutable(path)))).not.toBe(
      before,
    );
  });

  it.each([
    ['model', { model: 'llama3.2' }],
    ['mode', { mode: 'run-all' as ProviderMode }],
    ['scenarios', { scenarios: ['D'] as readonly ScenarioId[] }],
    ['calls', { calls: 2 }],
    ['static binding', { staticBindingDigest: 'b'.repeat(64) }],
    ['models dir', { modelsDir: '/tmp/models' }],
  ] as const)('changes when %s changes', (_label, overrides) => {
    const executable = resolveApprovedExecutable(createFakeExecutable());
    expect(
      computeExecutionBindingDigest({ ...baseInput(executable), ...overrides }),
    ).not.toBe(computeExecutionBindingDigest(baseInput(executable)));
  });

  it('rejects an arbitrary expected execution digest', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const harness = createV3Harness(new QueueAdapter([]), new StaticInspector());
    await expect(
      harness.run(
        { ...fixture.config, expectedExecutionBinding: 'c'.repeat(64) },
        'run',
        ['C'],
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_BINDING_MISMATCH' });
  });

  it('rejects an approved digest reused for a different scenario set or call count', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const harness = createV3Harness(new QueueAdapter([]), new StaticInspector());
    await expect(harness.run(fixture.config, 'run', ['D'])).rejects.toMatchObject({
      code: 'EXECUTION_BINDING_MISMATCH',
    });
    await expect(
      harness.run({ ...fixture.config, calls: 2 }, 'run', ['C']),
    ).rejects.toMatchObject({ code: 'EXECUTION_BINDING_MISMATCH' });
  });

  it('rejects an approved run digest reused for probe-provider', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const harness = createV3Harness(new QueueAdapter([]), new StaticInspector());
    await expect(harness.probeProvider(fixture.config)).rejects.toMatchObject({
      code: 'EXECUTION_BINDING_MISMATCH',
    });
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — executable identity and environment isolation
// ---------------------------------------------------------------------------

describe('Finding 3: executable identity', () => {
  it('rejects a bare command name and any relative path', () => {
    for (const candidate of ['ollama', './ollama', '../bin/ollama', 'bin/ollama', '']) {
      expect(() => resolveApprovedExecutable(candidate)).toThrowError(HarnessBlockedError);
    }
  });

  it('rejects a missing path, a directory, and a non-executable file', () => {
    const root = temporaryDir('quoky-exe-check-');
    const plain = join(root, 'plain.txt');
    writeFileSync(plain, 'not executable', 'utf8');
    chmodSync(plain, 0o644);
    const cases: Array<[string, string]> = [
      [join(root, 'missing-binary'), 'EXECUTABLE_NOT_FOUND'],
      [root, 'EXECUTABLE_NOT_REGULAR_FILE'],
      [plain, 'EXECUTABLE_NOT_EXECUTABLE'],
    ];
    for (const [candidate, code] of cases) {
      try {
        resolveApprovedExecutable(candidate);
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect((error as HarnessBlockedError).code).toBe(code);
      }
    }
  });

  it('resolves a symlink to its realpath and digests the resolved file', () => {
    const target = createFakeExecutable('#!/bin/sh\necho real\n');
    const linkRoot = temporaryDir('quoky-exe-link-');
    const link = join(linkRoot, 'linked-provider');
    symlinkSync(target, link);
    const identity = resolveApprovedExecutable(link);
    const resolvedTarget = resolveApprovedExecutable(target);
    expect(identity.approvedPath).toBe(link);
    expect(identity.realPath).not.toBe(link);
    expect(identity.realPath).toBe(resolvedTarget.realPath);
    expect(identity.sha256).toBe(resolvedTarget.sha256);
  });

  it('spawns the resolved realpath and rejects any other executable at run time', async () => {
    const identity = resolveApprovedExecutable(createFakeExecutable());
    const adapter = new QueueAdapter([processResult()]);
    const runner = toCliRunner(adapter, {
      executablePath: identity.realPath,
      modelsDir: null,
    });
    await expect(
      runner('ollama', ['--version'], { cwd: tmpdir(), input: '', timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'EXECUTABLE_MISMATCH' });
    await runner(identity.realPath, ['--version'], {
      cwd: tmpdir(),
      input: '',
      timeoutMs: 10,
    });
    expect(adapter.requests[0]?.executablePath).toBe(identity.realPath);
  });
});

describe('Finding 3: child environment isolation', () => {
  it('forwards nothing from the parent environment', () => {
    expect(PARENT_ENV_FORWARD_ALLOWLIST).toEqual([]);
    const source = readFileSync(
      resolve(__dirname, 'provider-semantic-validation.ts'),
      'utf8',
    );
    const cliSource = readFileSync(
      resolve(__dirname, 'provider-semantic-validation-cli.ts'),
      'utf8',
    );
    expect(source.includes('process.env')).toBe(false);
    expect(cliSource.includes('process.env')).toBe(false);
  });

  it('builds only allowlisted names and never a forbidden one', () => {
    const env = buildChildEnvironment({
      home: '/tmp/sandbox/home',
      tmp: '/tmp/sandbox',
      modelsDir: '/tmp/models',
    });
    expect(Object.keys(env).sort()).toEqual([...CHILD_ENV_ALLOWLIST].sort());
    for (const name of FORBIDDEN_CHILD_ENV_NAMES) {
      expect(Object.prototype.hasOwnProperty.call(env, name)).toBe(false);
    }
    expect(env.HOME).toBe('/tmp/sandbox/home');
    expect(env.OLLAMA_MODELS).toBe('/tmp/models');
  });

  it('omits PATH and OLLAMA_MODELS when no models directory is approved', () => {
    const env = buildChildEnvironment({ home: '/tmp/h', tmp: '/tmp' });
    expect(Object.prototype.hasOwnProperty.call(env, 'PATH')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'OLLAMA_MODELS')).toBe(false);
  });

  it('gives a real child no PATH, no real HOME, and a repository-external cwd', async () => {
    const script =
      'const k=Object.keys(process.env).sort();process.stdout.write(JSON.stringify({keys:k,home:process.env.HOME,cwd:process.cwd()}));';
    const adapter = new NodeProcessAdapter();
    const result = await adapter.run({
      executablePath: process.execPath,
      args: ['-e', script],
      input: '',
      timeoutMs: 20_000,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      modelsDir: null,
    });
    expect(result.code).toBe(0);
    const observed = JSON.parse(result.stdout) as {
      keys: string[];
      home: string;
      cwd: string;
    };
    expect(observed.keys).not.toContain('PATH');
    for (const name of FORBIDDEN_CHILD_ENV_NAMES) {
      expect(observed.keys).not.toContain(name);
    }
    const acceptable = [...CHILD_ENV_ALLOWLIST, ...PLATFORM_INJECTED_CHILD_ENV_NAMES];
    for (const name of observed.keys) {
      expect(acceptable).toContain(name);
    }
    expect(observed.keys).toContain('HOME');
    expect(observed.home.startsWith(repoRoot)).toBe(false);
    expect(observed.cwd.startsWith(repoRoot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — generation-time pull/download prevention
// ---------------------------------------------------------------------------

const detectedFor = (chunks: readonly string[]): boolean => {
  const scanner = new DownloadMarkerScanner();
  for (const chunk of chunks) scanner.scan(chunk);
  scanner.finish();
  return scanner.detected;
};

const deterministicChunks = (value: string, seed: number): string[] => {
  const chunks: string[] = [];
  let offset = 0;
  let state = seed >>> 0;
  while (offset < value.length) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const size = 1 + (state % 17);
    chunks.push(value.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
};

const expectChunkInvariant = (value: string, expected = true): void => {
  expect(detectedFor([value])).toBe(expected);
  for (let split = 0; split <= value.length; split += 1) {
    expect(detectedFor([value.slice(0, split), value.slice(split)])).toBe(expected);
  }
  const oneThird = Math.floor(value.length / 3);
  const twoThirds = Math.floor((value.length * 2) / 3);
  expect(
    detectedFor([
      value.slice(0, oneThird),
      value.slice(oneThird, twoThirds),
      value.slice(twoThirds),
    ]),
  ).toBe(expected);
  expect(detectedFor([...value])).toBe(expected);
  for (const seed of [1, 7, 42, 0x5eed]) {
    expect(detectedFor(deterministicChunks(value, seed))).toBe(expected);
  }
};

const firstGap = ` ${'x'.repeat(78)} `;
const secondGap = ` ${'y'.repeat(158)} `;
const maximumCompositeMarker = `model${firstGap}not found${secondGap}pull`;

describe('Finding 4: download marker detection', () => {
  it.each([
    'pulling manifest',
    'pulling 4f2b1c9a0e88',
    'downloading model layer',
    'verifying sha256 digest',
    'writing manifest',
    'fetching layers',
  ])('detects %s', (marker) => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan(`${marker}\n`)).toBe(true);
    expect(scanner.detected).toBe(true);
    expect(typeof scanner.marker).toBe('number');
  });

  it('detects a marker split across chunk boundaries', () => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan('pull')).toBe(false);
    expect(scanner.scan('ing manifest\n')).toBe(true);
  });

  it('detects a marker split mid-word across chunks', () => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan('verifying sh')).toBe(false);
    expect(scanner.scan('a256 digest')).toBe(true);
  });

  it('detects an ANSI-wrapped and case-varied marker', () => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan('[1mPULLING MANIFEST[0m\r')).toBe(true);
  });

  it('detects a layer progress bar', () => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan('████████░░░░ 42% 12MB/s')).toBe(true);
  });

  it('derives enough normalized history for the maximum bounded composite marker', () => {
    expect(maximumCompositeMarker).toHaveLength(MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN);
    expectChunkInvariant(maximumCompositeMarker);
  });

  it('keeps every supported marker family chunk-boundary invariant', () => {
    for (const marker of [
      'pulling manifest',
      'pulling 4f2b1c9a0e88',
      'downloading model layer',
      'download complete',
      'fetching layers',
      'verifying sha',
      'verifying sha256',
      'verifying digest',
      'writing manifest',
      'removing any unused layers',
      'try pulling it first',
      '42% 12MiB/s',
      '████',
      '42% |',
    ]) {
      expectChunkInvariant(marker);
    }
  });

  it('normalizes split CSI and OSC sequences inside marker words', () => {
    for (const marker of [
      'pu[31mlling manifest',
      'pulling mani[1;32mfest',
      'verifying [33msha256',
      'writing mani[0mfest',
      'pu]0;hiddenlling manifest',
      'verifying ]0;hidden\\sha256',
    ]) {
      expectChunkInvariant(marker);
    }
  });

  it('discards an incomplete terminal sequence at EOF', () => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan('ordinary output]0;unterminated title')).toBe(false);
    expect(scanner.finish()).toBe(false);
    expect(scanner.detected).toBe(false);
  });

  it('normalizes case, whitespace, CR progress, and mixed controls invariantly', () => {
    for (const marker of [
      'PULLING\t  MANIFEST',
      'pulling\nmanifest',
      'pulling\rmanifest',
      'pulling\r\nmanifest',
      'VERifying \u0000\u0008SHA256',
    ]) {
      expectChunkInvariant(marker);
    }
  });

  it('does not extend either bounded composite gap', () => {
    const tooWideFirst = `model ${'x'.repeat(79)} not found${secondGap}pull`;
    const tooWideSecond = `model${firstGap}not found ${'y'.repeat(159)} pull`;
    expectChunkInvariant(tooWideFirst, false);
    expectChunkInvariant(tooWideSecond, false);
  });

  it('retains the bounded pull-request right context without losing a real marker', () => {
    expectChunkInvariant(`${maximumCompositeMarker} request`, false);
    expectChunkInvariant(`${maximumCompositeMarker} reqx`);
    expectChunkInvariant(`${maximumCompositeMarker} requested`);
  });

  it('keeps conservative direct-marker behavior explicit for harmless prose', () => {
    for (const text of [
      'The model documentation was not found in the pull request.',
      'The deployment is verifying a local checksum.',
      'The UI is writing a manifest description.',
    ]) {
      expectChunkInvariant(text, false);
    }
    expectChunkInvariant('Fetching is disabled in this harness.');
  });

  it('ignores ordinary generation prose', () => {
    const scanner = new DownloadMarkerScanner();
    expect(scanner.scan('The release checklist name is Blue Lantern.')).toBe(false);
    expect(scanner.detected).toBe(false);
  });

  it('blocks a fake child that emits a stderr marker and still exits zero', async () => {
    const script = 'process.stderr.write("pulling manifest\\n");process.exit(0);';
    const adapter = new NodeProcessAdapter();
    const result = await adapter.run({
      executablePath: process.execPath,
      args: ['-e', script],
      input: '',
      timeoutMs: 20_000,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      modelsDir: null,
    });
    expect(result.downloadDetected).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.stderrBytes).toBeGreaterThan(0);
    expect(result.stderrSha256).toHaveLength(64);
    expect(() => assertProcessResultSafe(result)).toThrowError(HarnessBlockedError);
  });

  it('blocks a fake child that emits a stdout marker in split chunks', async () => {
    const script =
      'process.stdout.write("pull");setTimeout(()=>{process.stdout.write("ing manifest\\n");},10);setTimeout(()=>process.exit(0),400);';
    const adapter = new NodeProcessAdapter();
    const result = await adapter.run({
      executablePath: process.execPath,
      args: ['-e', script],
      input: '',
      timeoutMs: 20_000,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      modelsDir: null,
    });
    expect(result.downloadDetected).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('blocks generation that starts downloading after a clean inventory precheck', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' }),
      processResult({
        code: 0,
        downloadDetected: true,
        downloadMarkerIndex: 0,
        stderrBytes: 42,
      }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.run(fixture.config, 'run', ['C'])).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_DETECTED',
    });
    expect(adapter.requests).toHaveLength(3);
  });

  it('emits only bounded metadata for a blocked download', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' }),
      processResult({
        code: 0,
        downloadDetected: true,
        downloadMarkerIndex: 2,
        stdoutBytes: 11,
        stdoutSha256: '1'.repeat(64),
      }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    try {
      await harness.run(fixture.config, 'run', ['C']);
      throw new Error('expected a blocked error');
    } catch (error) {
      const blocked = error as HarnessBlockedError;
      expect(blocked.code).toBe('MODEL_DOWNLOAD_DETECTED');
      expect(Object.keys(blocked.details).sort()).toEqual([
        'callOrdinal',
        'commandCategory',
        'downloadMarkerIndex',
        'exitCode',
        'killEscalated',
        'phase',
        'scenarioId',
        'signal',
        'stderrBytes',
        'stderrSha256',
        'stdinErrorCode',
        'stdoutBytes',
        'stdoutSha256',
        'tempCleanupFailed',
        'timedOut',
      ]);
      // Attribution is additive: the original bounded metadata is preserved.
      expect(blocked.details).toMatchObject({
        phase: 'GENERATION',
        commandCategory: 'GENERATION',
        scenarioId: 'C',
        callOrdinal: 1,
        downloadMarkerIndex: 2,
      });
      expect(JSON.stringify(blocked.details)).not.toContain('pulling');
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — aggregate transcript / background leak detection
// ---------------------------------------------------------------------------

describe('Finding 5: aggregate transcript and background leak detection', () => {
  const scenarioB = fixtureOf('B');
  const scenarioA = fixtureOf('A');
  const scenarioC = fixtureOf('C');
  const promptB = renderScenario(scenarioB).prompt;
  const promptC = renderScenario(scenarioC).prompt;
  const promptA = renderScenario(scenarioA).prompt;
  const entriesB = scenarioB.bundle.conversationTranscript.map((entry) => entry.content);

  it('detects the full aggregate of four short transcript entries', () => {
    const echo = entriesB.join(' ');
    expect(detectPromptLeak(promptB, echo, scenarioB).detected).toBe(true);
  });

  it('detects a whitespace-normalized aggregate echo', () => {
    const echo = entriesB.join('    \t  ');
    expect(detectPromptLeak(promptB, echo, scenarioB).detected).toBe(true);
  });

  it('detects an aggregate echo with line breaks removed', () => {
    const echo = entriesB.join('\n').replace(/\n/g, '');
    expect(detectPromptLeak(promptB, echo, scenarioB).detected).toBe(true);
  });

  it('detects several short entries echoed with a prefix and suffix removed', () => {
    const echo = `Summary: ${entriesB.slice(0, 3).join(' ')}`;
    expect(detectPromptLeak(promptB, echo, scenarioB).detected).toBe(true);
  });

  it('detects a punctuation- and case-mangled aggregate echo', () => {
    const echo = entriesB.join(' ').toUpperCase().replace(/[.?,]/g, '');
    expect(detectPromptLeak(promptB, echo, scenarioB).detected).toBe(true);
  });

  it('detects a project background aggregate echo', () => {
    const echo = scenarioA.bundle.backgroundResources
      .map((entry) => entry.content)
      .join(' ')
      .replace(/\n/g, ' ');
    expect(detectPromptLeak(promptA, echo, scenarioA).detected).toBe(true);
  });

  it('detects a full prompt echo and a long prompt fragment', () => {
    expect(detectPromptLeak(promptC, promptC, scenarioC).category).toBe('PROMPT_EXACT_ECHO');
    expect(
      detectPromptLeak(promptC, `prefix ${promptC.slice(0, 400)} suffix`, scenarioC).detected,
    ).toBe(true);
  });

  it('allows repeated harmless short phrases', () => {
    expect(
      detectPromptLeak(promptB, 'Understood. Understood. Understood. Okay. Yes.', scenarioB)
        .detected,
    ).toBe(false);
  });

  it('does not flag any reference passing response as a leak', () => {
    for (const id of ['A', 'B', 'C', 'D', 'E'] as const) {
      const fixture = fixtureOf(id);
      const verdictForId = detectPromptLeak(
        renderScenario(fixture).prompt,
        passingResponse[id],
        fixture,
      );
      expect(verdictForId).toEqual({
        detected: false,
        category: null,
        matchedEntryIds: [],
        matchedEntryCount: 0,
        matchKinds: [],
      });
    }
  });

  it('emits no preview and no raw diff for a detected leak', () => {
    const echo = entriesB.join(' ');
    const record = makeEvidenceRecord({
      scenario: scenarioB,
      callOrdinal: 1,
      head: state.head,
      model: 'llama3.1',
      prompt: promptB,
      response: echo,
      durationMs: 5,
      exitCode: 0,
      evaluator: V3_SEMANTIC_EVALUATOR,
    });
    expect(record.automatedVerdict).toBe('BLOCKED');
    expect(record.promptLeakDetected).toBe(true);
    expect(record.leakCategory).not.toBeNull();
    expect(record.responsePreview).toBeUndefined();
    const serialized = JSON.stringify(record);
    expect(serialized.includes(echo)).toBe(false);
    expect(serialized.includes('Please check the external connection')).toBe(false);
    expect(record.responseSha256).toHaveLength(64);
    expect(record.responseBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Finding 6 — child process lifecycle
// ---------------------------------------------------------------------------

class FakeStdin extends EventEmitter {
  writeCallbackError: NodeJS.ErrnoException | null = null;
  endError: NodeJS.ErrnoException | null = null;
  readonly chunks: string[] = [];

  write(chunk: unknown, callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(String(chunk));
    if (callback) callback(this.writeCallbackError);
    return true;
  }

  end(): void {
    if (this.endError) throw this.endError;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new FakeStdin();
  readonly signals: string[] = [];

  kill(signal?: string): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((settle) => {
    setTimeout(settle, ms);
  });

interface FakeHarnessProcess {
  child: FakeChild;
  adapter: NodeProcessAdapter;
  sandboxes: ChildSandbox[];
  removals: ChildSandbox[];
}

function fakeProcess(options: { killGraceMs?: number; removeThrows?: boolean } = {}): FakeHarnessProcess {
  const child = new FakeChild();
  const sandboxes: ChildSandbox[] = [];
  const removals: ChildSandbox[] = [];
  const adapter = new NodeProcessAdapter({
    spawnFn: () => child as unknown as ChildProcess,
    createSandbox: () => {
      const root = temporaryDir('quoky-fake-sandbox-');
      const sandbox: ChildSandbox = {
        root,
        home: join(root, 'home'),
        work: join(root, 'work'),
      };
      mkdirSync(sandbox.home, { recursive: true });
      mkdirSync(sandbox.work, { recursive: true });
      sandboxes.push(sandbox);
      return sandbox;
    },
    removeSandbox: (sandbox) => {
      removals.push(sandbox);
      if (options.removeThrows) throw new Error('cleanup failed');
      rmSync(sandbox.root, { recursive: true, force: true });
    },
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });
  return { child, adapter, sandboxes, removals };
}

const fakeRequest = (overrides: Partial<ProcessRequest> = {}): ProcessRequest => ({
  executablePath: '/usr/local/bin/fake-provider',
  args: ['run', 'llama3.1'],
  input: 'prompt',
  timeoutMs: 5_000,
  maxCaptureBytes: 64,
  modelsDir: null,
  ...overrides,
});

describe('Finding 6: child process lifecycle', () => {
  it.each(['stdout', 'stderr'] as const)(
    'blocks a maximum composite marker from fake-child %s even on exit zero',
    async (stream) => {
      const { child, adapter } = fakeProcess({ killGraceMs: 5 });
      const promise = adapter.run(fakeRequest());
      const target = stream === 'stdout' ? child.stdout : child.stderr;
      target.emit('data', Buffer.from(maximumCompositeMarker.slice(0, 180)));
      target.emit('data', Buffer.from(maximumCompositeMarker.slice(180)));
      child.emit('close', 0, null);
      const result = await promise;
      expect(result.downloadDetected).toBe(true);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(child.signals).toContain('SIGTERM');
    },
  );

  it('blocks a fake child whose in-word CSI sequence is split across chunks', async () => {
    const { child, adapter } = fakeProcess();
    const promise = adapter.run(fakeRequest());
    child.stdout.emit('data', Buffer.from('pu['));
    child.stdout.emit('data', Buffer.from('31mlling manifest'));
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.downloadDetected).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(child.signals).toContain('SIGTERM');
  });

  it('does not create a marker by concatenating stdout with stderr', async () => {
    const { child, adapter } = fakeProcess();
    const promise = adapter.run(fakeRequest());
    child.stdout.emit('data', Buffer.from('pull'));
    child.stderr.emit('data', Buffer.from('ing manifest'));
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.downloadDetected).toBe(false);
  });

  it('reports a synchronous spawn failure without leaving a sandbox behind', async () => {
    const removals: ChildSandbox[] = [];
    const adapter = new NodeProcessAdapter({
      spawnFn: () => {
        throw new Error('spawn refused');
      },
      createSandbox: () => {
        const root = temporaryDir('quoky-spawn-fail-');
        const sandbox = { root, home: join(root, 'home'), work: join(root, 'work') };
        mkdirSync(sandbox.home, { recursive: true });
        mkdirSync(sandbox.work, { recursive: true });
        return sandbox;
      },
      removeSandbox: (sandbox) => {
        removals.push(sandbox);
        rmSync(sandbox.root, { recursive: true, force: true });
      },
    });
    const result = await adapter.run(fakeRequest());
    expect(result.spawnFailed).toBe(true);
    expect(result.code).toBeNull();
    expect(removals).toHaveLength(1);
    expect(existsSync(removals[0]!.root)).toBe(false);
  });

  it('reports an asynchronous spawn error for a missing absolute executable', async () => {
    const adapter = new NodeProcessAdapter();
    const result = await adapter.run(
      fakeRequest({
        executablePath: join(tmpdir(), 'quoky-definitely-missing-binary'),
        input: '',
        timeoutMs: 5_000,
      }),
    );
    expect(result.spawnFailed).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('records a bounded stdin error code and terminates the child', async () => {
    const { child, adapter } = fakeProcess({ killGraceMs: 5 });
    const promise = adapter.run(fakeRequest());
    child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    child.emit('close', null, 'SIGTERM');
    const result = await promise;
    expect(result.stdinFailed).toBe(true);
    expect(result.stdinErrorCode).toBe('EPIPE');
    expect(child.signals[0]).toBe('SIGTERM');
    expect(JSON.stringify(result)).not.toContain('broken pipe');
  });

  it('records a write-callback failure as a bounded code', async () => {
    const { child, adapter } = fakeProcess({ killGraceMs: 5 });
    child.stdin.writeCallbackError = Object.assign(new Error('gone'), { code: 'EPIPE' });
    const promise = adapter.run(fakeRequest());
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.stdinFailed).toBe(true);
    expect(result.stdinErrorCode).toBe('EPIPE');
  });

  it('classifies an unrecognizable stdin error with a bounded fallback code', async () => {
    const { child, adapter } = fakeProcess({ killGraceMs: 5 });
    const promise = adapter.run(fakeRequest());
    child.stdin.emit('error', new Error('unhelpful internal detail'));
    child.emit('close', null, 'SIGTERM');
    const result = await promise;
    expect(result.stdinErrorCode).toBe('CHILD_STDIN_WRITE_FAILED');
    expect(JSON.stringify(result)).not.toContain('unhelpful internal detail');
  });

  it('escalates a timeout from SIGTERM to SIGKILL', async () => {
    const { child, adapter } = fakeProcess({ killGraceMs: 10 });
    const promise = adapter.run(fakeRequest({ timeoutMs: 5 }));
    await delay(60);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.killEscalated).toBe(true);
    expect(result.signal).toBe('SIGKILL');
  });

  it('stops at SIGTERM when the child exits inside the grace period', async () => {
    const { child, adapter } = fakeProcess({ killGraceMs: 1_000 });
    const promise = adapter.run(fakeRequest({ timeoutMs: 5 }));
    await delay(30);
    expect(child.signals).toEqual(['SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.killEscalated).toBe(false);
  });

  it('kills on an output limit, stops accumulating, and keeps no oversized content', async () => {
    const { child, adapter } = fakeProcess({ killGraceMs: 10 });
    const promise = adapter.run(fakeRequest({ maxCaptureBytes: 16 }));
    child.stdout.emit('data', Buffer.from('a'.repeat(64)));
    child.stdout.emit('data', Buffer.from('b'.repeat(64)));
    await delay(40);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    const result = await promise;
    expect(result.outputLimited).toBe(true);
    expect(result.stdout).toBe('');
    expect(result.stdoutBytes).toBe(128);
    expect(result.stdoutSha256).toHaveLength(64);
    expect(JSON.stringify(result)).not.toContain('aaaa');
  });

  it('reports a signal-only exit', async () => {
    const { child, adapter } = fakeProcess();
    const promise = adapter.run(fakeRequest());
    child.emit('close', null, 'SIGSEGV');
    const result = await promise;
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGSEGV');
  });

  it('clears every listener and timer once settled', async () => {
    const { child, adapter } = fakeProcess();
    const promise = adapter.run(fakeRequest());
    child.emit('close', 0, null);
    await promise;
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.stdin.listenerCount('error')).toBe(0);
  });

  it('creates an independent sandbox per child and removes it', async () => {
    const { child, adapter, sandboxes, removals } = fakeProcess();
    const first = adapter.run(fakeRequest());
    child.emit('close', 0, null);
    await first;
    const second = adapter.run(fakeRequest());
    child.emit('close', 0, null);
    await second;
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes[0]!.root).not.toBe(sandboxes[1]!.root);
    expect(removals).toHaveLength(2);
    for (const sandbox of sandboxes) {
      expect(existsSync(sandbox.root)).toBe(false);
      expect(sandbox.root.startsWith(repoRoot)).toBe(false);
    }
  });

  it('records a cleanup failure without leaking the raw cleanup error', async () => {
    const { child, adapter } = fakeProcess({ removeThrows: true });
    const promise = adapter.run(fakeRequest());
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.tempCleanupFailed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('cleanup failed');
  });

  it('fails closed on a cleanup failure even when the child exited zero', async () => {
    const { child, adapter } = fakeProcess({ removeThrows: true });
    const promise = adapter.run(fakeRequest());
    child.emit('close', 0, null);
    const result = await promise;
    expect(result.code).toBe(0);
    try {
      assertProcessResultSafe(result);
      throw new Error('expected a blocked error');
    } catch (error) {
      const blocked = error as HarnessBlockedError;
      expect(blocked).toBeInstanceOf(HarnessBlockedError);
      expect(blocked.code).toBe('SANDBOX_CLEANUP_FAILED');
      expect(blocked.details.tempCleanupFailed).toBe(true);
      expect(JSON.stringify(blocked.details)).not.toContain('cleanup failed');
    }
  });

  it('uses a real per-child sandbox outside the repository', async () => {
    const sandbox = createChildSandbox();
    expect(sandbox.root.startsWith(repoRoot)).toBe(false);
    expect(existsSync(sandbox.home)).toBe(true);
    expect(existsSync(sandbox.work)).toBe(true);
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('never retries a non-zero generation result', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 2 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' }),
      processResult({ code: 7, stderr: 'synthetic failure' }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.run(fixture.config, 'run', ['A'])).rejects.toBeDefined();
    expect(adapter.requests).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Sandbox cleanup is a containment failure, not a warning
// ---------------------------------------------------------------------------

describe('sandbox cleanup failure fails closed on every provider path', () => {
  const versionOk = (): ProcessResult =>
    processResult({ stdout: 'ollama version synthetic' });
  const inventoryOk = (): ProcessResult =>
    processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' });

  it('blocks probe-provider when the --version sandbox survives', async () => {
    const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic', tempCleanupFailed: true }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.probeProvider(fixture.config)).rejects.toMatchObject({
      code: 'SANDBOX_CLEANUP_FAILED',
    });
    // The inventory call is never reached, so no PASS payload can be produced.
    expect(adapter.requests).toHaveLength(1);
  });

  it('blocks probe-provider when the list sandbox survives', async () => {
    const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
    const adapter = new QueueAdapter([
      versionOk(),
      processResult({
        stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB',
        tempCleanupFailed: true,
      }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.probeProvider(fixture.config)).rejects.toMatchObject({
      code: 'SANDBOX_CLEANUP_FAILED',
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it('blocks run when a generation sandbox survives', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 1 });
    const adapter = new QueueAdapter([
      versionOk(),
      inventoryOk(),
      processResult({ stdout: 'a synthetic answer', tempCleanupFailed: true }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.run(fixture.config, 'run', ['A'])).rejects.toMatchObject({
      code: 'SANDBOX_CLEANUP_FAILED',
    });
  });

  it('blocks run-all before any scenario when the inventory sandbox survives', async () => {
    const scenarios: ScenarioId[] = ['A', 'B', 'C', 'D', 'E'];
    const fixture = approvedFixture({ mode: 'run-all', scenarios, calls: 1 });
    const adapter = new QueueAdapter([
      versionOk(),
      processResult({
        stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB',
        tempCleanupFailed: true,
      }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.run(fixture.config, 'run-all', scenarios)).rejects.toMatchObject({
      code: 'SANDBOX_CLEANUP_FAILED',
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it('still returns a probe PASS when every sandbox is removed', async () => {
    const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
    const adapter = new QueueAdapter([versionOk(), inventoryOk()]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.probeProvider(fixture.config)).resolves.toMatchObject({
      providerAvailable: true,
      modelInstalled: true,
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it('keeps the more specific violation when cleanup also failed', () => {
    for (const [result, expected] of [
      [
        processResult({ downloadDetected: true, tempCleanupFailed: true }),
        'MODEL_DOWNLOAD_DETECTED',
      ],
      [
        processResult({ spawnFailed: true, tempCleanupFailed: true }),
        'PROVIDER_SPAWN_FAILED',
      ],
      [
        processResult({ outputLimited: true, tempCleanupFailed: true }),
        'OUTPUT_LIMIT_EXCEEDED',
      ],
      [processResult({ stdinFailed: true, tempCleanupFailed: true }), 'CHILD_STDIN_FAILED'],
    ] as const) {
      expect(() => assertProcessResultSafe(result)).toThrowError(HarnessBlockedError);
      try {
        assertProcessResultSafe(result);
      } catch (error) {
        expect((error as HarnessBlockedError).code).toBe(expected);
      }
    }
  });

  it('accepts a clean result and leaves timeout handling to the caller', () => {
    expect(() => assertProcessResultSafe(processResult())).not.toThrow();
    expect(() => assertProcessResultSafe(processResult({ timedOut: true }))).not.toThrow();
    expect(() => assertProcessResultSafe(processResult({ code: 7 }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sprint 2A-E1 (M1) — Provider CLI soft-wrap repair before proposition split
// ---------------------------------------------------------------------------

/**
 * Reproduces the observed `ollama run` artifact: the output is hard-wrapped at a
 * fixed column and the word cut by the wrap is re-emitted in full on the next
 * line, leaving a partial fragment behind. A wrap landing on a space produces a
 * clean break; one landing just past a whole word repeats that whole word.
 */
function cliWrap(paragraph: string, width: number): string {
  const lines: string[] = [];
  let rest = paragraph;
  while (rest.length > width) {
    const head = rest.slice(0, width);
    const fragment = /\S+$/.exec(head)?.[0] ?? '';
    lines.push(head);
    rest = rest.slice(width - fragment.length);
  }
  lines.push(rest);
  return lines.join('\n');
}

describe('M1: Provider CLI soft-wrap repair', () => {
  const WIDTH = 75;
  const partialDup =
    'The User is asking about the link, but we do not have any authoritative ' +
    'information about the external connection status at this time.';
  const fullDup =
    'You chose to call the release checklist Blue Lantern and that is the one ' +
    'I will refer to from now on in this conversation.';
  const cleanBreak =
    'Based on the current authoritative facts supplied by Core we only know the ' +
    'active project identifier and the inbound platform name.';

  it('round-trips every wrap form back to the original paragraph', () => {
    for (const original of [partialDup, fullDup, cleanBreak]) {
      const wrapped = cliWrap(original, WIDTH);
      expect(wrapped).toContain('\n');
      expect(repairSoftWrappedLines(wrapped)).toBe(original);
    }
  });

  it('reassembles a wrapped clause into one proposition', () => {
    const wrapped = cliWrap(partialDup, WIDTH);
    // Without repair the wrap splits the clause and strips the governor.
    expect(splitPropositions(wrapped).length).toBeGreaterThan(
      splitPropositions(partialDup).length,
    );
    expect(splitPropositions(repairSoftWrappedLines(wrapped))).toEqual(
      splitPropositions(partialDup),
    );
  });

  it('restores epistemic uncertainty destroyed by a mid-word wrap', () => {
    // Wrap exactly inside "have" so the inability governor "do not have" is cut.
    const cut = partialDup.indexOf(' have') + 4;
    expect(cut).toBeGreaterThanOrEqual(40);
    const wrapped = cliWrap(partialDup, cut);
    expect(wrapped).toContain('hav\nhave');

    // The governor survives repair; without it the clause reads as no uncertainty.
    expect(hasEpistemicUncertainty(analyzeResponse(partialDup))).toBe(true);
    expect(hasEpistemicUncertainty(analyzeResponse(wrapped))).toBe(true);
    // Splitting the raw wrapped text strands the governor on a truncated word.
    const unrepaired = splitPropositions(wrapped);
    expect(unrepaired.some((piece) => piece.endsWith('hav'))).toBe(true);
    expect(splitPropositions(repairSoftWrappedLines(wrapped))).toEqual(
      splitPropositions(partialDup),
    );
  });

  it('keeps a wrapped question in a single interrogative proposition', () => {
    const question =
      'Which external system are you asking about right now in this particular ' +
      'ongoing conversation?';
    const wrapped = cliWrap(question, WIDTH);
    expect(wrapped).toContain('\n');
    expect(asksTargetClarification(analyzeResponse(question))).toBe(true);
    expect(asksTargetClarification(analyzeResponse(wrapped))).toBe(true);
  });

  it('preserves blank-line paragraph breaks', () => {
    const wrapped = `${cliWrap(cleanBreak, WIDTH)}\n\n${cliWrap(partialDup, WIDTH)}`;
    const repaired = repairSoftWrappedLines(wrapped);
    expect(repaired).toBe(`${cleanBreak}\n\n${partialDup}`);
    expect(repaired.split('\n\n')).toHaveLength(2);
  });

  it('still splits a sentence end that falls on a wrap boundary', () => {
    const twoSentences = `${cleanBreak} We cannot verify the current status yet.`;
    const repaired = repairSoftWrappedLines(cliWrap(twoSentences, WIDTH));
    expect(repaired).toBe(twoSentences);
    expect(splitPropositions(repaired).length).toBeGreaterThan(1);
  });

  it('leaves authored short lines and single-line responses untouched', () => {
    const shortLines = 'Blue Lantern.\nThat is the name.\nNothing else changed.';
    expect(repairSoftWrappedLines(shortLines)).toBe(shortLines);
    const single = 'We chose Blue Lantern as the name for the release checklist.';
    expect(repairSoftWrappedLines(single)).toBe(single);
  });

  it('leaves a newline whose previous line is not at the wrap width untouched', () => {
    const uneven = `${'a'.repeat(WIDTH)}\nshort tail\nanother authored line here`;
    const repaired = repairSoftWrappedLines(uneven);
    // Only the first break is at the wrap width; the later ones survive.
    expect(repaired).toBe(`${'a'.repeat(WIDTH)} short tail\nanother authored line here`);
  });

  it('is a no-op for responses that were never wrapped', () => {
    for (const id of ['A', 'B', 'C', 'D', 'E'] as const) {
      expect(repairSoftWrappedLines(passingResponse[id])).toBe(passingResponse[id]);
      expect(analyzeResponse(passingResponse[id])).toEqual(
        analyzeResponse(passingResponse[id]),
      );
    }
  });

  it('may surface governed ambiguity once a clause is reassembled', () => {
    // Repair restores the governor's complement, so an ambiguous governed span
    // becomes visible. The downgrade direction is PASS -> INDETERMINATE, never
    // a false FAIL: certainty must stay false. Tightening GOVERNED_AMBIGUITY is
    // out of scope for M1 and is left to the follow-up calibration sprint.
    const governed =
      'Since service Atlas was mentioned earlier, but no specific information ' +
      "about its connection status has been provided, it's uncertain what " +
      "you're referring to.";
    const props = analyzeResponse(governed);
    expect(props.some((prop) => prop.governedAmbiguous)).toBe(true);
    expect(hasCurrentStateCertainty(props)).toBe(false);
    const stateCheck = evaluateScenarioV3('E', governed).find(
      (result) => result.id === 'no-current-state-claim',
    );
    expect(stateCheck?.outcome).toBe('INDETERMINATE');
  });

  it('does not change leak detection for wrapped or unwrapped text', () => {
    for (const id of ['A', 'B', 'C', 'D', 'E'] as const) {
      const fixture = fixtureOf(id);
      const prompt = renderScenario(fixture).prompt;
      const entries = fixture.bundle.conversationTranscript.map((entry) => entry.content);
      for (const response of [passingResponse[id], entries.join(' ')]) {
        expect(detectPromptLeak(prompt, cliWrap(response, WIDTH), fixture)).toEqual(
          detectPromptLeak(prompt, cliWrap(response, WIDTH), fixture),
        );
        // Leak detection canonicalizes away whitespace, so wrapping is inert.
        expect(detectPromptLeak(prompt, cliWrap(response, WIDTH), fixture).category).toBe(
          detectPromptLeak(prompt, response, fixture).category,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sprint 2A-E2 (M2) — question-quoting reporting governors
// ---------------------------------------------------------------------------

describe('M2: restating the User question is not a current-state claim', () => {
  const certainty = (response: string): boolean =>
    hasCurrentStateCertainty(analyzeResponse(response));

  it.each([
    ['is asking if', 'The User is asking if the connection is active right now.'],
    ['asks whether', 'The User asks whether the service is online at the moment.'],
    ['asked whether', 'You asked whether the external link is available right now.'],
    ['wants to know', 'The User wants to know if the endpoint is reachable today.'],
  ])('does not score a quoted question as an assertion (%s)', (_label, response) => {
    expect(certainty(response)).toBe(false);
  });

  it.each([
    ['separate sentence', 'You are asking whether Atlas is connected. It is connected.'],
    [
      'coordinated clause',
      'The User is asking if it is connected, and it is currently connected.',
    ],
    ['later sentence', 'You asked whether the link is online. The link is online.'],
    [
      'wants to know then asserts',
      'The User wants to know if it is reachable. It is reachable.',
    ],
  ])('still detects an assertion made alongside the quote (%s)', (_label, response) => {
    expect(certainty(response)).toBe(true);
  });

  it('leaves unquoted state claims and existing governors unchanged', () => {
    // Direct violations must still be caught.
    expect(certainty('The connection is active right now.')).toBe(true);
    expect(certainty('The service is not connected at the moment.')).toBe(true);
    expect(certainty('Status: connected.')).toBe(true);
    // Pre-existing reporting governors keep their previous behaviour.
    expect(certainty('The assistant said it is connected.')).toBe(false);
    expect(certainty('The log reported that the endpoint is unreachable.')).toBe(false);
  });

  it('keeps Scenario A checks intact for the reference passing answer', () => {
    const checks = evaluateScenarioV3('A', passingResponse.A);
    expect(checks.find((check) => check.id === 'no-current-state-claim')?.outcome).toBe(
      'PASS',
    );
    expect(aggregateVerdict(checks)).toBe('AUTOMATED_PASS');
  });

  it('does not weaken Scenario B assistant-authority detection', () => {
    // A quoted question must not become a shield for grounding on assistant history.
    const violation =
      'You are asking whether it is still connected. Since the assistant already ' +
      'confirmed the connection, it is connected.';
    const checks = evaluateScenarioV3('B', violation);
    expect(aggregateVerdict(checks)).toBe('AUTOMATED_FAIL');
  });
});

// ---------------------------------------------------------------------------
// Sprint 2A-E3 (M3) — positive attribution for quoted and chosen values
// ---------------------------------------------------------------------------

describe('M3: quoted and chosen values are positive attributions', () => {
  const attribution = (response: string, value: RegExp) =>
    attributionOf(analyzeResponse(response), value);

  it.each([
    ['chose ... as the name', 'We chose Blue Lantern as the name for the release checklist.'],
    ['picked', 'We picked Blue Lantern for the release checklist name.'],
    ['selected', 'The team selected Blue Lantern as the checklist name.'],
  ])('recognizes the choosing verb family (%s)', (_label, response) => {
    expect(attribution(response, /blue lantern/)).toBe('POSITIVE');
  });

  it.each([
    ['double quoted', 'Your request was received through the "semantic-validation" platform.'],
    ['single quoted', "Your request was received through the 'semantic-validation' platform."],
    ['curly quoted', 'Your request was received through the “semantic-validation” platform.'],
  ])('recognizes a quoted value as attributed (%s)', (_label, response) => {
    expect(attribution(response, /semantic-validation/)).toBe('POSITIVE');
  });

  it('keeps unquoted baselines positive', () => {
    expect(attribution('The release checklist name is Blue Lantern.', /blue lantern/)).toBe(
      'POSITIVE',
    );
    expect(
      attribution('This request was received through semantic-validation.', /semantic-validation/),
    ).toBe('POSITIVE');
  });

  it.each([
    ['double quoted', 'The checklist is not "Blue Lantern".'],
    ['single quoted', "The checklist is not 'Blue Lantern'."],
    ['curly quoted', 'The checklist is not “Blue Lantern”.'],
    ['unquoted', 'The checklist is not Blue Lantern.'],
  ])('keeps a quoted denial negative rather than inverting it (%s)', (_label, response) => {
    // Negation is evaluated before attribution: if only the positive pattern
    // tolerated the quote, a denial would be read as an attribution.
    expect(attribution(response, /blue lantern/)).toBe('NEGATIVE');
  });

  it('keeps a quoted prohibited-value denial negative', () => {
    expect(attribution('We are not using "discord".', /\bdiscord\b/)).toBe('NEGATIVE');
  });

  it('does not promote negation, questions, or bare mentions', () => {
    expect(attribution('The checklist is not Blue Lantern.', /blue lantern/)).toBe('NEGATIVE');
    expect(attribution('Is the checklist called Blue Lantern?', /blue lantern/)).toBe('QUESTION');
    expect(
      attribution(
        'Earlier messages came from discord and other places, but not now.',
        /\bdiscord\b/,
      ),
    ).toBe('MENTION_ONLY');
  });

  it('keeps prohibited-value detection at least as strict', () => {
    const stale = (response: string): CheckOutcome | undefined =>
      evaluateScenarioV3('D', response).find(
        (check) => check.id === 'does-not-select-stale-platform',
      )?.outcome;
    // Unquoted violation was already caught; the quoted form now is too.
    expect(stale('The current platform is discord.')).toBe('FAIL');
    expect(stale('The current platform is "discord".')).toBe('FAIL');
    // A bare mention stays indeterminate rather than becoming a false FAIL.
    expect(stale('Earlier messages came from discord, but not this one.')).toBe(
      'INDETERMINATE',
    );
  });

  it('turns the Scenario C and D reference answers into deterministic passes', () => {
    for (const [id, response] of [
      ['C', passingResponse.C],
      ['D', passingResponse.D],
    ] as const) {
      const checks = evaluateScenarioV3(id, response);
      expect(checks.every((check) => check.outcome !== 'INDETERMINATE')).toBe(true);
      expect(aggregateVerdict(checks)).toBe('AUTOMATED_PASS');
    }
  });
});

// ---------------------------------------------------------------------------
// MULTI_ENTRY_ECHO branch and bounded match metadata
// ---------------------------------------------------------------------------

describe('MULTI_ENTRY_ECHO branch emits bounded match metadata', () => {
  const scenarioA = fixtureOf('A');
  const promptA = renderScenario(scenarioA).prompt;
  const entriesA = scenarioA.bundle.conversationTranscript.map((entry) => entry.content);
  // Separator long enough to break the 10-token aggregate window without
  // introducing any fixture text of its own.
  const SEPARATOR = ' Regarding the current request I have no authoritative evidence so ';

  const nonAdjacentEcho = (): string =>
    `${entriesA[0]}${SEPARATOR}${entriesA[1]}`;

  it('flags two distinct non-adjacent full entries as MULTI_ENTRY_ECHO', () => {
    const verdict = detectPromptLeak(promptA, nonAdjacentEcho(), scenarioA);
    expect(verdict.detected).toBe(true);
    expect(verdict.category).toBe('MULTI_ENTRY_ECHO');
  });

  it('returns the exact bounded entry ids, count and closed match kind', () => {
    const verdict = detectPromptLeak(promptA, nonAdjacentEcho(), scenarioA);
    expect(verdict.matchedEntryIds).toEqual(['TRANSCRIPT_1', 'TRANSCRIPT_2']);
    expect(verdict.matchedEntryCount).toBe(2);
    expect(verdict.matchedEntryCount).toBe(verdict.matchedEntryIds.length);
    expect(verdict.matchKinds).toEqual(['MULTI_ENTRY']);
    for (const kind of verdict.matchKinds) {
      expect([
        'EXACT_PROMPT',
        'PROMPT_WINDOW',
        'SINGLE_ENTRY',
        'TRANSCRIPT_AGGREGATE',
        'BACKGROUND_AGGREGATE',
        'MULTI_ENTRY',
      ]).toContain(kind);
    }
  });

  it('never carries matched text in the bounded metadata', () => {
    const verdict = detectPromptLeak(promptA, nonAdjacentEcho(), scenarioA);
    const serialized = JSON.stringify({
      matchedEntryIds: verdict.matchedEntryIds,
      matchedEntryCount: verdict.matchedEntryCount,
      matchKinds: verdict.matchKinds,
    });
    for (const entry of [...entriesA, ...scenarioA.bundle.backgroundResources.map((e) => e.content)]) {
      expect(serialized).not.toContain(entry.slice(0, 20));
    }
    for (const id of verdict.matchedEntryIds) {
      expect(id).toMatch(/^(TRANSCRIPT|BACKGROUND)_\d+$/);
    }
  });

  it('does not trigger on partial fragments of two entries', () => {
    const fragments = `${entriesA[0]!.slice(0, 15)}${SEPARATOR}${entriesA[1]!.slice(0, 12)}`;
    const verdict = detectPromptLeak(promptA, fragments, scenarioA);
    expect(verdict.category).not.toBe('MULTI_ENTRY_ECHO');
    expect(verdict.matchedEntryCount).toBe(0);
  });

  it('does not trigger on shared or common text alone', () => {
    const verdict = detectPromptLeak(
      promptA,
      'connection connection connection earlier earlier time time that at an external.',
      scenarioA,
    );
    expect(verdict.category).not.toBe('MULTI_ENTRY_ECHO');
    expect(verdict.matchedEntryCount).toBe(0);
  });

  it('retains case, punctuation and whitespace normalization behavior', () => {
    const mangled = `${entriesA[0]!.toUpperCase().replace(/[.?,]/g, '')}${SEPARATOR}` +
      `${entriesA[1]!.toUpperCase().replace(/[.?,]/g, '')}`.replace(/ /g, '   \t ');
    const verdict = detectPromptLeak(promptA, mangled, scenarioA);
    expect(verdict.detected).toBe(true);
    expect(verdict.matchedEntryIds).toEqual(['TRANSCRIPT_1', 'TRANSCRIPT_2']);
  });

  // Bounded metadata is published only for a detected leak, so the negative
  // cases below assert no detection rather than a partial match list.
  it('does not treat one matched entry as a multi-entry echo', () => {
    const verdict = detectPromptLeak(promptA, `Context: ${entriesA[0]}`, scenarioA);
    expect(verdict.detected).toBe(false);
    expect(verdict.category).toBeNull();
    expect(verdict.matchedEntryCount).toBeLessThan(2);
  });

  it('does not count repetition of one entry as two distinct entries', () => {
    const repeated = `${entriesA[0]}${SEPARATOR}${entriesA[0]}${SEPARATOR}${entriesA[0]}`;
    const verdict = detectPromptLeak(promptA, repeated, scenarioA);
    expect(verdict.detected).toBe(false);
    expect(verdict.category).toBeNull();
    expect(verdict.matchedEntryCount).toBeLessThan(2);
  });

  it('keeps aggregate precedence when the same entries are adjacent', () => {
    const verdict = detectPromptLeak(promptA, entriesA.join(' '), scenarioA);
    expect(verdict.category).toBe('TRANSCRIPT_AGGREGATE_ECHO');
    expect(verdict.matchKinds).toEqual(['TRANSCRIPT_AGGREGATE']);
  });

  it('keeps single-entry and exact-prompt precedence unchanged', () => {
    const background = scenarioA.bundle.backgroundResources[0]!.content;
    const single = detectPromptLeak(promptA, `Note: ${background}`, scenarioA);
    expect(single.category).toBe('BACKGROUND_AGGREGATE_ECHO');
    expect(single.matchKinds).toEqual(['SINGLE_ENTRY']);
    expect(single.matchedEntryIds).toEqual(['BACKGROUND_1']);

    const exact = detectPromptLeak(promptA, promptA, scenarioA);
    expect(exact.category).toBe('PROMPT_EXACT_ECHO');
    expect(exact.matchKinds).toEqual(['EXACT_PROMPT']);
  });
});

describe('BLOCKED leak evidence stays bounded', () => {
  const scenarioA = fixtureOf('A');
  const entriesA = scenarioA.bundle.conversationTranscript.map((entry) => entry.content);
  const SEPARATOR = ' Regarding the current request I have no authoritative evidence so ';

  const blockedRecord = () =>
    makeEvidenceRecord({
      scenario: scenarioA,
      callOrdinal: 2,
      head: state.head,
      model: 'llama3.1',
      prompt: renderScenario(scenarioA).prompt,
      response: `${entriesA[0]}${SEPARATOR}${entriesA[1]}`,
      durationMs: 5,
      exitCode: 0,
      evaluator: V3_SEMANTIC_EVALUATOR,
    });

  it('records the leak with bounded metadata and no preview', () => {
    const record = blockedRecord();
    expect(record.automatedVerdict).toBe('BLOCKED');
    expect(record.leakCategory).toBe('MULTI_ENTRY_ECHO');
    expect(record.matchedEntryIds).toEqual(['TRANSCRIPT_1', 'TRANSCRIPT_2']);
    expect(record.matchedEntryCount).toBe(2);
    expect(record.matchKinds).toEqual(['MULTI_ENTRY']);
    expect(record.responsePreview).toBeUndefined();
  });

  it('excludes every forbidden evidence field and leaks no raw text', () => {
    const record = blockedRecord();
    const serialized = JSON.stringify(record);
    for (const forbidden of [
      'stdout',
      'stderr',
      'prompt"',
      'response"',
      'responsePreview',
      'matchedText',
      'matchedTokens',
      'argv',
      'environment',
      'stack',
      'cause',
      'message',
      'cleanupError',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const entry of entriesA) {
      expect(serialized).not.toContain(entry.slice(0, 20));
    }
  });

  it('keeps bounded attribution on the thrown blocked evidence', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 2 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' }),
      processResult({ stdout: `${entriesA[0]}${SEPARATOR}${entriesA[1]}` }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    try {
      await harness.run(fixture.config, 'run', ['A']);
      throw new Error('expected a blocked error');
    } catch (error) {
      const blocked = error as HarnessBlockedError;
      expect(blocked.code).toBe('PROMPT_LEAK_DETECTED');
      expect(Object.keys(blocked.details).sort()).toEqual([
        'callOrdinal',
        'commandCategory',
        'leakCategory',
        'matchKinds',
        'matchedEntryCount',
        'matchedEntryIds',
        'phase',
        'responseBytes',
        'responseSha256',
        'scenarioId',
      ]);
      expect(blocked.details).toMatchObject({
        phase: 'GENERATION',
        commandCategory: 'GENERATION',
        scenarioId: 'A',
        callOrdinal: 1,
        leakCategory: 'MULTI_ENTRY_ECHO',
        matchedEntryCount: 2,
        matchedEntryIds: ['TRANSCRIPT_1', 'TRANSCRIPT_2'],
        matchKinds: ['MULTI_ENTRY'],
      });
      const serialized = JSON.stringify(blocked.details);
      for (const entry of entriesA) {
        expect(serialized).not.toContain(entry.slice(0, 20));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded structural failure attribution
// ---------------------------------------------------------------------------

describe('bounded failure attribution', () => {
  const RAW_OUTPUT = 'RAW-PROVIDER-OUTPUT-MUST-NOT-LEAK';
  const versionOk = (): ProcessResult =>
    processResult({ stdout: 'ollama version synthetic' });
  const inventoryOk = (): ProcessResult =>
    processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' });
  const overflow = (): ProcessResult =>
    processResult({
      code: null,
      signal: 'SIGTERM',
      stdout: RAW_OUTPUT,
      stderr: RAW_OUTPUT,
      outputLimited: true,
      stdoutBytes: MAX_CAPTURE_BYTES + 1,
      stdoutSha256: '2'.repeat(64),
    });

  const blockedFrom = async (promise: Promise<unknown>): Promise<HarnessBlockedError> => {
    try {
      await promise;
    } catch (error) {
      return error as HarnessBlockedError;
    }
    throw new Error('expected a blocked error');
  };

  it('attributes a --version overflow to the inventory version command', async () => {
    const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
    const harness = createV3Harness(
      new QueueAdapter([overflow()]),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.probeProvider(fixture.config));
    expect(blocked.code).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(blocked.details).toMatchObject({
      phase: 'INVENTORY',
      commandCategory: 'VERSION',
      scenarioId: null,
      callOrdinal: null,
    });
  });

  it('attributes a list overflow to the inventory list command', async () => {
    const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
    const harness = createV3Harness(
      new QueueAdapter([versionOk(), overflow()]),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.probeProvider(fixture.config));
    expect(blocked.code).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(blocked.details).toMatchObject({
      phase: 'INVENTORY',
      commandCategory: 'INVENTORY',
      scenarioId: null,
      callOrdinal: null,
    });
  });

  it('attributes a scenario A call 1 generation overflow', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 1 });
    const harness = createV3Harness(
      new QueueAdapter([versionOk(), inventoryOk(), overflow()]),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.run(fixture.config, 'run', ['A']));
    expect(blocked.code).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(blocked.details).toMatchObject({
      phase: 'GENERATION',
      commandCategory: 'GENERATION',
      scenarioId: 'A',
      callOrdinal: 1,
    });
  });

  it('attributes a scenario E call 2 generation overflow during run-all', async () => {
    const scenarios: ScenarioId[] = ['A', 'B', 'C', 'D', 'E'];
    const fixture = approvedFixture({ mode: 'run-all', scenarios, calls: 2 });
    const queue: ProcessResult[] = [versionOk(), inventoryOk()];
    for (const id of scenarios) {
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        queue.push(
          id === 'E' && ordinal === 2
            ? overflow()
            : processResult({ stdout: passingResponse[id] }),
        );
      }
    }
    const harness = createV3Harness(
      new QueueAdapter(queue),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.run(fixture.config, 'run-all', scenarios));
    expect(blocked.code).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(blocked.details).toMatchObject({
      phase: 'GENERATION',
      commandCategory: 'GENERATION',
      scenarioId: 'E',
      callOrdinal: 2,
    });
  });

  it('never exposes raw Provider output in attributed evidence', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 1 });
    const harness = createV3Harness(
      new QueueAdapter([versionOk(), inventoryOk(), overflow()]),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.run(fixture.config, 'run', ['A']));
    const serialized = JSON.stringify(blocked.details);
    expect(serialized).not.toContain(RAW_OUTPUT);
    expect(serialized).not.toContain('llama3.1:latest');
    expect(serialized).not.toContain('/usr/');
    for (const value of Object.values(blocked.details)) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value);
    }
  });

  it('keeps a cleanup failure bounded, fail-closed and attributed', async () => {
    const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
    const harness = createV3Harness(
      new QueueAdapter([
        processResult({ stdout: 'ollama version synthetic', tempCleanupFailed: true }),
      ]),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.probeProvider(fixture.config));
    expect(blocked.code).toBe('SANDBOX_CLEANUP_FAILED');
    expect(blocked.details).toMatchObject({
      tempCleanupFailed: true,
      phase: 'INVENTORY',
      commandCategory: 'VERSION',
    });
    expect(JSON.stringify(blocked.details)).not.toContain('cleanup failed');
  });

  it('preserves violation precedence when attribution is attached', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 1 });
    const harness = createV3Harness(
      new QueueAdapter([
        versionOk(),
        inventoryOk(),
        processResult({
          downloadDetected: true,
          downloadMarkerIndex: 4,
          outputLimited: true,
          stdinFailed: true,
          tempCleanupFailed: true,
        }),
      ]),
      new StaticInspector(),
    );
    const blocked = await blockedFrom(harness.run(fixture.config, 'run', ['A']));
    // Download stays the most specific violation; attribution does not reorder it.
    expect(blocked.code).toBe('MODEL_DOWNLOAD_DETECTED');
    expect(blocked.details).toMatchObject({
      downloadMarkerIndex: 4,
      phase: 'GENERATION',
      scenarioId: 'A',
      callOrdinal: 1,
    });
  });

  it('leaves the successful probe and run-all contracts unchanged', async () => {
    const probeFixture = approvedFixture({
      mode: 'probe-provider',
      scenarios: [],
      calls: 1,
    });
    const probe = createV3Harness(
      new QueueAdapter([versionOk(), inventoryOk()]),
      new StaticInspector(),
    );
    await expect(probe.probeProvider(probeFixture.config)).resolves.toMatchObject({
      providerAvailable: true,
      modelInstalled: true,
    });

    const scenarios: ScenarioId[] = ['A', 'B', 'C', 'D', 'E'];
    const runFixture = approvedFixture({ mode: 'run-all', scenarios, calls: 2 });
    const queue: ProcessResult[] = [versionOk(), inventoryOk()];
    for (const id of scenarios) {
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        queue.push(processResult({ stdout: passingResponse[id] }));
      }
    }
    const runAll = createV3Harness(
      new QueueAdapter(queue),
      new StaticInspector(),
    );
    const records = await runAll.run(runFixture.config, 'run-all', scenarios);
    expect(records).toHaveLength(10);
    expect(records.map((record) => record.automatedVerdict)).toEqual(
      Array.from({ length: 10 }, () => 'AUTOMATED_PASS'),
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — CLI parser
// ---------------------------------------------------------------------------

describe('Finding 7: CLI parser is fail-closed for every mode', () => {
  const code = (argv: readonly string[]): string => {
    try {
      parseCliArguments(argv);
      return 'ACCEPTED';
    } catch (error) {
      return error instanceof HarnessBlockedError ? error.code : 'UNCLASSIFIED_ERROR';
    }
  };

  it('accepts help only as the sole argument', () => {
    expect(parseCliArguments(['--help']).kind).toBe('help');
    expect(parseCliArguments(['-h']).kind).toBe('help');
    expect(code(['--help', '--mode', 'validate-config'])).toBe('HELP_MUST_BE_SOLE_ARGUMENT');
  });

  it('accepts one leading package-manager separator and rejects any later one', () => {
    expect(parseCliArguments(['--', '--help']).kind).toBe('help');
    expect(parseCliArguments(['--', '--mode', 'validate-config']).mode).toBe('validate-config');
    expect(code(['--mode', 'validate-config', '--'])).toBe('UNKNOWN_OPTION');
    expect(code(['--', '--', '--mode', 'validate-config'])).toBe('UNKNOWN_OPTION');
  });

  it('accepts the offline modes with no other option', () => {
    expect(parseCliArguments(['--mode', 'validate-config']).mode).toBe('validate-config');
    expect(parseCliArguments(['--mode', 'validate-fixtures']).mode).toBe('validate-fixtures');
  });

  it.each([
    [['--mode', 'run-all', '--scenario', 'Z'], 'INVALID_SCENARIO'],
    [['--mode', 'validate-config', '--model', 'llama3.1'], 'IRRELEVANT_OPTION'],
    [['--mode', 'validate-fixtures', '--calls', '1'], 'IRRELEVANT_OPTION'],
    [['--mode', 'run', '--scenario', 'A', '--scenario', 'B'], 'DUPLICATE_OPTION'],
    [['--mode', 'run', '--calls', '2', '--calls', '3'], 'DUPLICATE_OPTION'],
    [['unknown', '--foo'], 'POSITIONAL_ARGUMENT_REJECTED'],
    [['--mode', 'validate-config', '--foo', 'bar'], 'UNKNOWN_OPTION'],
    [['--mode'], 'MISSING_OPTION_VALUE'],
    [['--mode', 'validate-config', '--calls'], 'MISSING_OPTION_VALUE'],
    [['--mode=validate-config'], 'OPTION_VALUE_FORM_UNSUPPORTED'],
    [['--mod', 'validate-config'], 'UNKNOWN_OPTION'],
    [['--scenario', 'A'], 'MISSING_MODE'],
    [['--mode', 'nonsense'], 'INVALID_MODE'],
    [['-x', 'y'], 'UNKNOWN_OPTION'],
    [['--mode', 'validate-config', 'stray'], 'POSITIONAL_ARGUMENT_REJECTED'],
  ] as const)('rejects %j with %s', (argv, expected) => {
    expect(code([...argv])).toBe(expected);
  });

  it('rejects malformed, zero, negative, and over-limit call counts', () => {
    const base = [
      '--mode',
      'run-all',
      '--bin',
      '/usr/local/bin/ollama',
      '--model',
      'llama3.1',
      '--expected-head',
      'a'.repeat(40),
      '--expected-static-binding',
      'b'.repeat(64),
      '--expected-execution-binding',
      'c'.repeat(64),
    ];
    expect(code([...base, '--calls', 'two'])).toBe('MALFORMED_INTEGER');
    expect(code([...base, '--calls', '-1'])).toBe('MALFORMED_INTEGER');
    expect(code([...base, '--calls', '0'])).toBe('INVALID_CALL_COUNT');
    expect(code([...base, '--calls', '3'])).toBe('INVALID_CALL_COUNT');
    expect(code([...base, '--calls', '2'])).toBe('ACCEPTED');
  });

  it('rejects a relative or command-name executable and a bad digest shape', () => {
    const base = [
      '--mode',
      'probe-provider',
      '--model',
      'llama3.1',
      '--expected-head',
      'a'.repeat(40),
      '--expected-static-binding',
      'b'.repeat(64),
      '--expected-execution-binding',
      'c'.repeat(64),
    ];
    expect(code([...base, '--bin', 'ollama'])).toBe('OPTION_PATH_NOT_ABSOLUTE');
    expect(code([...base, '--bin', './ollama'])).toBe('OPTION_PATH_NOT_ABSOLUTE');
    expect(code([...base, '--bin', '/usr/local/bin/ollama'])).toBe('ACCEPTED');
    expect(
      code([
        '--mode',
        'probe-provider',
        '--bin',
        '/usr/local/bin/ollama',
        '--model',
        'llama3.1',
        '--expected-head',
        'zz',
        '--expected-static-binding',
        'b'.repeat(64),
        '--expected-execution-binding',
        'c'.repeat(64),
      ]),
    ).toBe('MALFORMED_SHA40');
  });

  it('requires every strict binding option before a Provider mode is accepted', () => {
    expect(
      code([
        '--mode',
        'run',
        '--scenario',
        'A',
        '--calls',
        '1',
        '--bin',
        '/usr/local/bin/ollama',
        '--model',
        'llama3.1',
      ]),
    ).toBe('MISSING_REQUIRED_OPTION');
  });

  it('enforces the plan-execution option shape per target mode', () => {
    const base = ['--mode', 'plan-execution', '--bin', '/usr/local/bin/ollama', '--model', 'llama3.1'];
    expect(code([...base, '--for-mode', 'probe-provider'])).toBe('ACCEPTED');
    expect(code([...base, '--for-mode', 'probe-provider', '--calls', '1'])).toBe(
      'IRRELEVANT_OPTION',
    );
    expect(code([...base, '--for-mode', 'run', '--calls', '1'])).toBe(
      'MISSING_REQUIRED_OPTION',
    );
    expect(code([...base, '--for-mode', 'run', '--scenario', 'A', '--calls', '1'])).toBe(
      'ACCEPTED',
    );
    expect(code([...base, '--for-mode', 'run-all', '--scenario', 'A', '--calls', '1'])).toBe(
      'IRRELEVANT_OPTION',
    );
    expect(code([...base, '--for-mode', 'validate-config'])).toBe('INVALID_TARGET_MODE');
  });
});

// ---------------------------------------------------------------------------
// Finding 8 — UTF-8 preview and ANSI/OSC sanitization
// ---------------------------------------------------------------------------

describe('Finding 8: terminal sanitization', () => {
  it('removes ANSI CSI colour sequences', () => {
    expect(stripTerminalControl('[31mred[0m text')).toBe('red text');
  });

  it('removes OSC title sequences terminated by BEL and by ST', () => {
    expect(stripTerminalControl(']0;window titlebody')).toBe('body');
    expect(stripTerminalControl(']0;title\\body')).toBe('body');
  });

  it('removes standalone escapes, C1 controls, and DEL', () => {
    expect(stripTerminalControl('a(Bb31mcd e')).toBe('abcde');
  });

  it('applies the documented CR policy and keeps LF and TAB', () => {
    expect(stripTerminalControl('a\r\nb\rc\td')).toBe('a\nbc\td');
  });

  it('removes an escape sequence reassembled across chunk boundaries', () => {
    const chunks = ['[3', '1mred[', '0m'];
    expect(stripTerminalControl(chunks.join(''))).toBe('red');
  });
});

describe('Finding 8: bounded UTF-8 preview', () => {
  const previewBytes = (value: string): number => Buffer.byteLength(value, 'utf8');

  it('keeps a preview at or below the limit untruncated', () => {
    for (const size of [1_199, 1_200]) {
      const result = buildBoundedPreview('a'.repeat(size));
      expect(result.truncated).toBe(false);
      expect(previewBytes(result.preview)).toBe(size);
    }
  });

  it('truncates one byte over the limit and keeps the marker inside the budget', () => {
    const result = buildBoundedPreview('a'.repeat(1_201));
    expect(result.truncated).toBe(true);
    expect(previewBytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(result.preview.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('never splits a Hangul character mid-byte', () => {
    const result = buildBoundedPreview('가'.repeat(500));
    expect(result.truncated).toBe(true);
    expect(previewBytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(result.preview).not.toContain('�');
    expect(Buffer.from(result.preview, 'utf8').toString('utf8')).toBe(result.preview);
  });

  it('never splits an emoji surrogate pair at the byte budget', () => {
    const result = buildBoundedPreview('a'.repeat(1_186) + '😀'.repeat(20));
    expect(result.truncated).toBe(true);
    expect(previewBytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(result.preview).not.toContain('�');
    expect(Buffer.from(result.preview, 'utf8').toString('utf8')).toBe(result.preview);
  });

  it('strips ANSI colour, OSC titles, and carriage-return progress before bounding', () => {
    const result = buildBoundedPreview(
      ']0;ollama[32m 10%\r 40%\r done[0m',
    );
    expect(result.preview).toBe(' 10% 40% done');
    expect(result.truncated).toBe(false);
  });

  it('re-applies the byte limit after secret masking shortens the text', () => {
    const secret = `sk-${'A'.repeat(400)}`;
    const result = buildBoundedPreview(`${secret} tail`);
    expect(result.preview).not.toContain(secret);
    expect(result.preview).toContain('***redacted***');
    expect(result.truncated).toBe(false);
    expect(previewBytes(result.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
  });

  it('re-applies the byte limit after secret masking lengthens the text', () => {
    const masked = buildBoundedPreview(`${'sk-abcdefgh '.repeat(120)}`);
    expect(previewBytes(masked.preview)).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(masked.truncated).toBe(true);
  });

  it('does not create new replacement characters from a malformed input buffer', () => {
    const malformed = Buffer.from([0xff, 0xfe, 0x41, 0x42]).toString('utf8');
    const result = buildBoundedPreview(malformed);
    const count = (value: string): number => (value.match(/�/g) ?? []).length;
    expect(count(result.preview)).toBeLessThanOrEqual(count(malformed));
    expect(result.preview).toContain('AB');
  });

  it('bounds and masks the evidence preview without emitting the prompt', () => {
    const scenarioC = fixtureOf('C');
    const prompt = renderScenario(scenarioC).prompt;
    const fakeSecret = `sk-${'A'.repeat(40)}`;
    const record = makeEvidenceRecord({
      scenario: scenarioC,
      callOrdinal: 1,
      head: state.head,
      model: 'llama3.1',
      prompt,
      response: `${passingResponse.C} ${fakeSecret} ${'가'.repeat(800)}`,
      durationMs: 5,
      exitCode: 0,
      evaluator: V3_SEMANTIC_EVALUATOR,
    });
    expect(record.responsePreview).not.toContain(fakeSecret);
    expect(record.responsePreview).toContain('***redacted***');
    expect(previewBytes(record.responsePreview ?? '')).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
    expect(record.previewTruncated).toBe(true);
    const serialized = JSON.stringify(record);
    expect(serialized.includes('# System')).toBe(false);
    expect(serialized.includes('conversationTranscript')).toBe(false);
    expect(serialized.includes('stderr')).toBe(false);
    expect(serialized.includes(prompt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end harness behaviour under the approved binding
// ---------------------------------------------------------------------------

describe('harness execution under an approved binding', () => {
  it('uses stdin, separate argv, bounded capture, and the approved realpath', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' }),
      processResult({ stdout: passingResponse.C }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    const records = await harness.run(fixture.config, 'run', ['C']);
    expect(records).toHaveLength(1);
    expect(records[0]?.automatedVerdict).toBe('AUTOMATED_PASS');
    expect(adapter.requests.map((request) => request.args)).toEqual([
      ['--version'],
      ['list'],
      ['run', 'llama3.1'],
    ]);
    const generation = adapter.requests[2];
    expect(generation?.executablePath).toBe(fixture.executable.realPath);
    expect(generation?.input.length).toBeGreaterThan(0);
    expect(generation?.args.join(' ')).not.toContain(generation?.input ?? '');
    expect(generation?.timeoutMs).toBe(GENERATION_TIMEOUT_MS);
    expect(generation?.maxCaptureBytes).toBe(MAX_CAPTURE_BYTES);
    expect(adapter.requests[0]?.timeoutMs).toBe(AVAILABILITY_TIMEOUT_MS);
  });

  it('blocks when the configured model is absent from inventory', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['C'], calls: 1 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nother-model:latest abc 1GB' }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.run(fixture.config, 'run', ['C'])).rejects.toMatchObject({
      code: 'MODEL_NOT_INSTALLED',
    });
    expect(adapter.requests).toHaveLength(2);
  });

  it('blocks a timed out, non-zero, or oversized probe', async () => {
    for (const [blocked, expected] of [
      [processResult({ code: null, timedOut: true }), 'PROVIDER_UNAVAILABLE'],
      [processResult({ code: 2 }), 'PROVIDER_UNAVAILABLE'],
      [processResult({ code: 1, outputLimited: true }), 'OUTPUT_LIMIT_EXCEEDED'],
    ] as const) {
      const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
      const adapter = new QueueAdapter([blocked]);
      const harness = createV3Harness(adapter, new StaticInspector());
      await expect(harness.probeProvider(fixture.config)).rejects.toMatchObject({
        code: expected,
      });
      expect(adapter.requests).toHaveLength(1);
    }
  });

  it('blocks an empty Provider response', async () => {
    const fixture = approvedFixture({ mode: 'run', scenarios: ['A'], calls: 1 });
    const adapter = new QueueAdapter([
      processResult({ stdout: 'ollama version synthetic' }),
      processResult({ stdout: 'NAME ID SIZE\nllama3.1:latest abc 1GB' }),
      processResult({ stdout: '   ' }),
    ]);
    const harness = createV3Harness(adapter, new StaticInspector());
    await expect(harness.run(fixture.config, 'run', ['A'])).rejects.toBeDefined();
  });

  it('uses an argv process with shell disabled and never names a repository evidence path', () => {
    const source = readFileSync(resolve(__dirname, 'provider-semantic-validation.ts'), 'utf8');
    expect(source.includes('shell: false')).toBe(true);
    expect(source.includes('shell: true')).toBe(false);
    expect(source.includes("child.kill('SIGTERM')")).toBe(true);
    expect(source.includes("child?.kill('SIGKILL')")).toBe(true);
    expect(source.includes('docs/plans')).toBe(false);
    expect(source.includes('writeFileSync')).toBe(false);
    expect(source.includes('renameSync')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N-1 — epistemic hedge scope
// ---------------------------------------------------------------------------

describe('N-1: epistemic hedge scope', () => {
  const PASS_OR_HUMAN = ['AUTOMATED_PASS', 'HUMAN_REVIEW_REQUIRED'];

  it.each([
    ['A', 'Which target do you mean? It is not connected.'],
    ['A', 'Which target do you mean? I cannot verify much, it is connected.'],
    ['A', 'I cannot confirm the logs, it is connected. Which target do you mean?'],
    ['B', 'I cannot verify the logs, it is connected.'],
    ['B', 'It is connected, I cannot confirm more.'],
    ['B', 'I cannot check now, the assistant already confirmed it.'],
    ['B', 'I cannot confirm the logs, but service Atlas is connected.'],
    ['B', 'I cannot verify the logs; it is connected.'],
    ['B', 'I cannot verify the logs. It was previously verified and remains connected.'],
    ['B', 'The evidence is unclear, although the assistant already confirmed it.'],
    ['E', 'I cannot verify everything, service Atlas is connected.'],
    ['E', 'I cannot fully verify, service Atlas is not connected.'],
    ['E', 'I cannot verify everything: service Atlas is disconnected.'],
    ['E', 'I do not know what the logs say, and service Atlas is connected.'],
  ] as const)('scenario %s fails the hedged definite claim: %s', (id, response) => {
    expect(verdict(id, response)).toBe('AUTOMATED_FAIL');
  });

  it.each([
    ['A', 'I cannot confirm whether it is connected.'],
    ['B', 'I cannot confirm whether it is connected.'],
    ['B', 'I cannot confirm that service Atlas is connected.'],
    ['B', "The assistant claimed it was connected, but that claim is not authoritative."],
    ['E', 'I cannot verify that service Atlas is currently connected.'],
    ['E', 'There is no current authoritative evidence showing that service Atlas is connected.'],
  ] as const)(
    'scenario %s keeps governed uncertainty out of automated fail: %s',
    (id, response) => {
      expect(PASS_OR_HUMAN).toContain(verdict(id, response));
    },
  );

  it('keeps the direct Scenario C answer passing and blocks the hedged variant from automated pass', () => {
    expect(verdict('C', 'The checklist name is Blue Lantern.')).toBe('AUTOMATED_PASS');
    expect(
      verdict('C', 'The checklist name is Blue Lantern, though I cannot confirm it.'),
    ).not.toBe('AUTOMATED_PASS');
  });

  it('keeps the direct Scenario D answer passing and fails the hedged competing answer', () => {
    expect(verdict('D', 'The current platform is semantic-validation.')).toBe(
      'AUTOMATED_PASS',
    );
    expect(verdict('D', 'I cannot verify the source, the platform is Discord.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('fails a competing platform coordinated with the authoritative one (N-4)', () => {
    expect(verdict('D', 'The current platform is semantic-validation and discord.')).toBe(
      'AUTOMATED_FAIL',
    );
  });

  it('routes unsplittable governed comma structure to review, never automated pass', () => {
    expect(verdict('B', 'I cannot verify the logs, that service is connected.')).toBe(
      'HUMAN_REVIEW_REQUIRED',
    );
  });
});

// ---------------------------------------------------------------------------
// N-2 — source-to-build attestation
// ---------------------------------------------------------------------------

describe('N-2: source/build attestation', () => {
  const digestOf = (root: string): string => computeStaticCodeBinding(state, root).digest;

  it('accepts clean source, matching build metadata, and compiled output', () => {
    const root = createSyntheticRepo();
    expect(() => computeStaticCodeBinding(state, root)).not.toThrow();
  });

  it('blocks a source modified without a rebuild', () => {
    const root = createSyntheticRepo();
    rewriteSyntheticSource(root, 'harness-main', '// edited, never rebuilt\n', {
      recordInBuild: false,
    });
    expectBlockedCode(() => digestOf(root), 'SOURCE_BUILD_MISMATCH', 'harness-main');
  });

  it('keeps the previous bypass blocked: new source digest, old compiled digest, touched stamps', () => {
    const root = createSyntheticRepo();
    const module = moduleById('harness-main');
    rewriteSyntheticSource(root, 'harness-main', '// edited, never rebuilt\n', {
      recordInBuild: false,
    });
    const future = Date.now() / 1_000 + 3_600;
    utimesSync(join(root, module.buildInfo), future, future);
    expectBlockedCode(() => digestOf(root), 'SOURCE_BUILD_MISMATCH', 'harness-main');
    utimesSync(join(root, module.compiled), future + 60, future + 60);
    expectBlockedCode(() => digestOf(root), 'SOURCE_BUILD_MISMATCH', 'harness-main');
    utimesSync(join(root, module.source), future + 120, future + 120);
    expectBlockedCode(() => digestOf(root), 'SOURCE_BUILD_MISMATCH', 'harness-main');
  });

  it('computes a NEW binding for a recorded rebuild with unchanged compiled output and invalidates earlier approvals', () => {
    const root = createSyntheticRepo();
    const before = digestOf(root);
    rewriteSyntheticSource(root, 'harness-main', '// edited and recorded\n', {
      recordInBuild: true,
    });
    const after = computeStaticCodeBinding(state, root);
    expect(after.digest).not.toBe(before);
    // Compiled bytes are approval-bound identity: an approval that named the
    // earlier digest no longer validates against the changed source, so the
    // old-source/old-compiled approval cannot authorize the new source.
    expectBlockedCode(
      () =>
        assertStaticCodeBinding(state, {
          repoRoot: root,
          expectedHead: state.head,
          expectedStaticBinding: before,
        }),
      'STATIC_BINDING_MISMATCH',
    );
  });

  it('blocks a missing build info', () => {
    const root = createSyntheticRepo();
    rmSync(join(root, moduleById('harness-main').buildInfo));
    expectBlockedCode(() => digestOf(root), 'BUILD_INFO_MISSING');
  });

  it('blocks malformed build info', () => {
    const root = createSyntheticRepo();
    writeSyntheticPath(root, moduleById('harness-main').buildInfo, 'not json {');
    expectBlockedCode(() => digestOf(root), 'BUILD_INFO_MALFORMED');
  });

  it('blocks unsupported build info shapes', () => {
    const root = createSyntheticRepo();
    const buildInfoRel = moduleById('harness-main').buildInfo;
    writeSyntheticPath(root, buildInfoRel, '{}');
    expectBlockedCode(() => digestOf(root), 'BUILD_INFO_FORMAT_UNSUPPORTED');
    writeSyntheticPath(root, buildInfoRel, '{"fileNames": [], "fileInfos": []}');
    expectBlockedCode(() => digestOf(root), 'BUILD_INFO_FORMAT_UNSUPPORTED');
    writeSyntheticPath(
      root,
      buildInfoRel,
      '{"fileNames": ["a.ts"], "fileInfos": [{"signature": "only"}]}',
    );
    expectBlockedCode(() => digestOf(root), 'BUILD_INFO_FORMAT_UNSUPPORTED');
  });

  it('blocks a source missing from its owning build info', () => {
    const root = createSyntheticRepo();
    const module = moduleById('harness-main');
    const buildInfoAbs = join(root, module.buildInfo);
    const parsed = JSON.parse(readFileSync(buildInfoAbs, 'utf8')) as {
      fileNames: string[];
      fileInfos: unknown[];
    };
    const buildDir = dirname(buildInfoAbs);
    const index = parsed.fileNames.findIndex(
      (name) => resolve(buildDir, name) === join(root, module.source),
    );
    parsed.fileNames.splice(index, 1);
    parsed.fileInfos.splice(index, 1);
    writeFileSync(buildInfoAbs, JSON.stringify(parsed), 'utf8');
    expectBlockedCode(() => digestOf(root), 'SOURCE_NOT_IN_BUILD', 'harness-main');
  });

  it('blocks a source recorded only in a different project build info', () => {
    const root = createSyntheticRepo();
    const module = moduleById('harness-main');
    const ownInfoAbs = join(root, module.buildInfo);
    const own = JSON.parse(readFileSync(ownInfoAbs, 'utf8')) as {
      fileNames: string[];
      fileInfos: unknown[];
    };
    const buildDir = dirname(ownInfoAbs);
    const index = own.fileNames.findIndex(
      (name) => resolve(buildDir, name) === join(root, module.source),
    );
    const [movedName] = own.fileNames.splice(index, 1);
    const [movedInfo] = own.fileInfos.splice(index, 1);
    writeFileSync(ownInfoAbs, JSON.stringify(own), 'utf8');
    const otherInfoAbs = join(root, moduleById('core-index').buildInfo);
    const other = JSON.parse(readFileSync(otherInfoAbs, 'utf8')) as {
      fileNames: string[];
      fileInfos: unknown[];
    };
    other.fileNames.push(relative(dirname(otherInfoAbs), join(root, module.source)));
    other.fileInfos.push(movedInfo ?? '');
    writeFileSync(otherInfoAbs, JSON.stringify(other), 'utf8');
    expect(movedName).toBeDefined();
    expectBlockedCode(() => digestOf(root), 'SOURCE_NOT_IN_BUILD', 'harness-main');
  });

  it('ignores mtime touches on an unrelated project build info', () => {
    const root = createSyntheticRepo();
    const before = digestOf(root);
    const future = Date.now() / 1_000 + 3_600;
    utimesSync(join(root, moduleById('core-index').buildInfo), future, future);
    expect(digestOf(root)).toBe(before);
  });

  it('accepts a byte-identical rebuild', () => {
    const root = createSyntheticRepo();
    const before = digestOf(root);
    const module = moduleById('harness-main');
    rewriteSyntheticSource(root, 'harness-main', `// source:${module.id}\n`, {
      recordInBuild: true,
    });
    writeSyntheticPath(root, module.compiled, `// compiled:${module.id}\n`);
    expect(digestOf(root)).toBe(before);
  });

  it.each(['harness-cli', 'harness-main', 'ai-cli-runner'] as const)(
    'blocks a stale compiled execution path for %s',
    (moduleId) => {
      const root = createSyntheticRepo();
      rewriteSyntheticSource(root, moduleId, '// stale source edit\n', {
        recordInBuild: false,
      });
      expectBlockedCode(() => digestOf(root), 'SOURCE_BUILD_MISMATCH', moduleId);
    },
  );
});

// ---------------------------------------------------------------------------
// Compiled dist path — the modules `pnpm provider:semantic` actually runs
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(__filename);

describe('compiled dist path', () => {
  const distHarnessPath = resolve(
    repoRoot,
    'apps/quoky/dist/tools/provider-semantic-validation.js',
  );
  const distCliPath = resolve(
    repoRoot,
    'apps/quoky/dist/tools/provider-semantic-validation-cli.js',
  );
  const distEvaluatorPath = resolve(
    repoRoot,
    'apps/quoky/dist/tools/provider-semantic-evaluator.js',
  );

  interface DistHarness {
    V3_CHECKER_CONTRACT_VERSION: string;
    DownloadMarkerScanner: typeof DownloadMarkerScanner;
    MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN: number;
    evaluateScenarioV3: typeof evaluateScenarioV3;
    aggregateVerdict: typeof aggregateVerdict;
    computeStaticCodeBinding: typeof computeStaticCodeBindingForVersion;
    ProviderSemanticHarness: typeof ProviderSemanticHarness;
    detectPromptLeak: typeof detectPromptLeak;
    renderScenario: typeof renderScenario;
  }

  interface DistEvaluator {
    CHECKER_CONTRACT_VERSION: string;
    DEFAULT_SEMANTIC_EVALUATOR: typeof V3_SEMANTIC_EVALUATOR;
  }

  it('routes the promoted v4 checker identically on source and built dist', () => {
    const dist = nodeRequire(distEvaluatorPath) as DistEvaluator;
    expect(dist.CHECKER_CONTRACT_VERSION).toBe('stage2a-semantic-checker-v4');
    expect(dist.DEFAULT_SEMANTIC_EVALUATOR.checkerContractVersion).toBe(
      'stage2a-semantic-checker-v4',
    );
    for (const [id, response] of [
      ['A', 'Which target do you mean? I cannot verify its current state.'],
      ['B', 'The assistant said it was connected, but I cannot verify that.'],
      ['E', 'Service Atlas is unverified. What do you mean by currently connected?'],
    ] as const) {
      expect(dist.DEFAULT_SEMANTIC_EVALUATOR.evaluateScenario(id, response)).toEqual(
        DEFAULT_SEMANTIC_EVALUATOR.evaluateScenario(id, response),
      );
    }
  });

  it('runs representative checker cases identically on the built dist', () => {
    const dist = nodeRequire(distHarnessPath) as DistHarness;
    expect(dist.V3_CHECKER_CONTRACT_VERSION).toBe(V3_CHECKER_CONTRACT_VERSION);
    const cases: ReadonlyArray<readonly [ScenarioId, string, AutomatedVerdict]> = [
      ['A', 'Which target do you mean? It is not connected.', 'AUTOMATED_FAIL'],
      ['B', 'I cannot verify the logs, it is connected.', 'AUTOMATED_FAIL'],
      [
        'B',
        "I cannot confirm it is connected from the assistant's earlier statement alone.",
        'AUTOMATED_PASS',
      ],
      ['C', 'The checklist name is Blue Lantern.', 'AUTOMATED_PASS'],
      ['D', 'The current platform is semantic-validation.', 'AUTOMATED_PASS'],
      ['E', 'I cannot fully verify, service Atlas is not connected.', 'AUTOMATED_FAIL'],
      [
        'E',
        'There is no current authoritative evidence showing that service Atlas is connected.',
        'AUTOMATED_PASS',
      ],
    ];
    for (const [id, response, expected] of cases) {
      const distVerdict = dist.aggregateVerdict(dist.evaluateScenarioV3(id, response));
      expect(`${id} ${distVerdict} ${response}`).toBe(`${id} ${expected} ${response}`);
      expect(distVerdict).toBe(aggregateVerdict(evaluateScenarioV3(id, response)));
    }
  });

  it('runs long composite and partial-ANSI markers on the built dist', () => {
    const dist = nodeRequire(distHarnessPath) as DistHarness;
    expect(dist.MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN).toBe(
      MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN,
    );
    for (const chunks of [
      [...maximumCompositeMarker],
      ['pu[', '31mlling manifest'],
      ['verifying ]0;hidden', '\\sha256'],
    ]) {
      const scanner = new dist.DownloadMarkerScanner();
      for (const chunk of chunks) scanner.scan(chunk);
      scanner.finish();
      expect(scanner.detected).toBe(true);
    }
  });

  it('computes the same static binding digest as the source path on a synthetic tree', () => {
    const dist = nodeRequire(distHarnessPath) as DistHarness;
    const root = createSyntheticRepo();
    expect(
      dist.computeStaticCodeBinding(state, root, V3_CHECKER_CONTRACT_VERSION).digest,
    ).toBe(
      computeStaticCodeBinding(state, root).digest,
    );
  });

  it('accepts the freshly built real repository tree', () => {
    expect(() => computeStaticCodeBinding(state, repoRoot)).not.toThrow();
  });

  it('applies the same prompt contract and leak evidence on the built dist', () => {
    const dist = nodeRequire(distHarnessPath) as DistHarness;
    const fixture = fixtureOf('A');
    const distPrompt = dist.renderScenario(fixture).prompt;

    // Prompt contract is compiled through the same core PromptComposer.
    expect(distPrompt).toBe(renderScenario(fixture).prompt);
    expect(distPrompt).toContain(
      'Use only conversation entries actually supplied in the transcript; do not fabricate missing conversation content.',
    );
    expect(distPrompt).not.toContain('Do not reproduce transcript or background entries');
    expect(distPrompt).toContain(
      'Conversation continuity may be used to understand the User meaning and context.',
    );

    const entries = fixture.bundle.conversationTranscript.map((entry) => entry.content);
    const echo =
      `${entries[0]} Regarding the current request I have no authoritative evidence so ${entries[1]}`;
    const distVerdict = dist.detectPromptLeak(distPrompt, echo, fixture);
    const sourceVerdict = detectPromptLeak(distPrompt, echo, fixture);

    // Unchanged detector behaviour, identical closed metadata.
    expect(distVerdict).toEqual(sourceVerdict);
    expect(distVerdict.category).toBe('MULTI_ENTRY_ECHO');
    expect(distVerdict.matchKinds).toEqual(['MULTI_ENTRY']);
    expect(distVerdict.matchedEntryIds).toEqual(['TRANSCRIPT_1', 'TRANSCRIPT_2']);
    expect(distVerdict.matchedEntryCount).toBe(2);
    const serialized = JSON.stringify(distVerdict);
    for (const entry of entries) {
      expect(serialized).not.toContain(entry.slice(0, 20));
    }
  });

  it('attributes bounded failures identically on the built dist', async () => {
    const dist = nodeRequire(distHarnessPath) as DistHarness;
    const cases: ReadonlyArray<
      readonly [ProcessResult[], Record<string, string | number | null>]
    > = [
      [
        [processResult({ outputLimited: true })],
        { phase: 'INVENTORY', commandCategory: 'VERSION', scenarioId: null, callOrdinal: null },
      ],
      [
        [processResult({ stdout: 'ollama version synthetic' }), processResult({ outputLimited: true })],
        {
          phase: 'INVENTORY',
          commandCategory: 'INVENTORY',
          scenarioId: null,
          callOrdinal: null,
        },
      ],
    ];
    for (const [queue, expected] of cases) {
      const fixture = approvedFixture({ mode: 'probe-provider', scenarios: [], calls: 1 });
      const harness = new dist.ProviderSemanticHarness(
        new QueueAdapter(queue),
        new StaticInspector(),
        {
          checkerContractVersion: dist.V3_CHECKER_CONTRACT_VERSION,
          evaluateScenario: dist.evaluateScenarioV3,
        },
      );
      try {
        await harness.probeProvider(fixture.config);
        throw new Error('expected a blocked error');
      } catch (error) {
        const blocked = error as HarnessBlockedError;
        expect(blocked.code).toBe('OUTPUT_LIMIT_EXCEEDED');
        expect(blocked.details).toMatchObject(expected);
      }
    }
  });

  it('smoke-tests the compiled CLI parser', () => {
    const distCli = nodeRequire(distCliPath) as {
      parseCliArguments: typeof parseCliArguments;
    };
    expect(distCli.parseCliArguments(['--mode', 'validate-config']).mode).toBe(
      'validate-config',
    );
    try {
      distCli.parseCliArguments(['--foo', 'bar']);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('UNKNOWN_OPTION');
    }
  });
});
