/**
 * Answer-quality evaluation harness (ADR-0098 D7, QUAL-2).
 *
 * Offline by default: fixture validation, prompt construction (the real `PromptComposer` and `PromptRenderer`),
 * output checking and plan/digest computation spawn nothing and touch no network. The only function that talks to a
 * provider is `runProviderEvaluation`, and it takes the already-constructed `AiProvider` from its caller, so this
 * module never constructs a concrete provider. The CLI owns that composition and refuses it without a matching
 * `--approved-plan-digest` (Strict: separate Product Owner approval per run and per target).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Capability,
  IntentType,
  PromptComposer,
  PromptRenderer,
  RiskLevel,
  TaskStatus,
  generalChatReplyPolicyMetadata,
  renderGeneralChatPolicyRules,
} from '@quoky/core';
import type { AiProvider, AiRequest, ContextBundle, ReplyLanguage, Task } from '@quoky/core';
import { maskSecrets } from '@quoky/ai-cli';
import {
  ANSWER_QUALITY_CHECKER_VERSION,
  CHECK_NAMES,
  isCheckName,
  runChecks,
} from './answer-quality-checkers';
import type { CheckContext, CheckName, CheckResult, LengthLimits } from './answer-quality-checkers';

export const FIXTURE_FILE_VERSION = 'answer-quality-fixtures-v1';
export const PLAN_VERSION = 'answer-quality-plan-v1';
export const MAX_CALLS_PER_CASE = 3;
export const MAX_STORED_OUTPUT_CHARS = 4_000;
export const GENERATION_TIMEOUT_MS = 120_000;

export type EvalTarget = 'ollama' | 'claude';
export const EVAL_TARGETS: readonly EvalTarget[] = ['ollama', 'claude'];

export class AnswerQualityBlockedError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'AnswerQualityBlockedError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

export interface FixtureTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AnswerQualityCase {
  readonly id: string;
  readonly locale: 'ko' | 'en';
  readonly kind: string;
  readonly userMessage: string;
  readonly transcript?: readonly FixtureTurn[];
  readonly expectedLanguage?: ReplyLanguage;
  readonly checks: readonly CheckName[];
  readonly limits?: LengthLimits;
  /** For `containsRelevantTokens`: each inner list is an any-of group; every group must match. */
  readonly requiredTokenGroups?: readonly (readonly string[])[];
  readonly source?: string;
}

export interface KnownBadOutput {
  readonly id: string;
  readonly caseId: string;
  readonly text: string;
  readonly mustFail: readonly CheckName[];
  readonly source: string;
}

export interface KnownGoodOutput {
  readonly id: string;
  readonly caseId: string;
  readonly text: string;
}

export interface AnswerQualityFixtures {
  readonly fixtureVersion: string;
  readonly description?: string;
  readonly cases: readonly AnswerQualityCase[];
  readonly knownBadOutputs: readonly KnownBadOutput[];
  readonly knownGoodOutputs: readonly KnownGoodOutput[];
}

export const DEFAULT_FIXTURE_PATH = resolve(__dirname, '../../src/tools/answer-quality-fixtures/v1.json');

export function loadFixtures(path: string = DEFAULT_FIXTURE_PATH): AnswerQualityFixtures {
  return JSON.parse(readFileSync(path, 'utf8')) as AnswerQualityFixtures;
}

const LANGUAGES: readonly string[] = ['ko', 'en', 'unknown'];

/** Stable JSON: object keys sorted, so a digest does not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function checkContextFor(testCase: AnswerQualityCase): CheckContext {
  return {
    userMessage: testCase.userMessage,
    ...(testCase.expectedLanguage === undefined ? {} : { expectedLanguage: testCase.expectedLanguage }),
    ...(testCase.limits === undefined ? {} : { limits: testCase.limits }),
    ...(testCase.requiredTokenGroups === undefined ? {} : { requiredTokenGroups: testCase.requiredTokenGroups }),
  };
}

/** Run the checks a case declares against one reply. */
export function checkOutputForCase(testCase: AnswerQualityCase, output: string): CheckResult[] {
  return runChecks(output, testCase.checks, checkContextFor(testCase));
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic Task / ContextBundle -> real PromptComposer + PromptRenderer
// ---------------------------------------------------------------------------------------------------------------

const SYNTHETIC_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export function buildSyntheticTask(testCase: AnswerQualityCase): Task {
  return {
    id: `aq-task-${testCase.id}`,
    title: testCase.userMessage.slice(0, 80),
    description: testCase.userMessage,
    status: TaskStatus.PENDING,
    intent: {
      type: IntentType.CHAT,
      capability: Capability.GENERAL_CHAT,
      confidence: 1,
      requiresWork: true,
      summary: testCase.userMessage.slice(0, 200),
    },
    riskLevel: RiskLevel.LOW,
    context: { platform: 'answer-quality-eval', channelId: 'synthetic-channel', userId: 'synthetic-user' },
    createdAt: SYNTHETIC_TIMESTAMP,
    updatedAt: SYNTHETIC_TIMESTAMP,
  };
}

export function buildSyntheticContext(testCase: AnswerQualityCase): ContextBundle {
  let turnNumber = 0;
  const conversationTranscript: ContextBundle['conversationTranscript'] = (testCase.transcript ?? []).map((turn) => {
    if (turn.role === 'user') turnNumber += 1;
    return turn.role === 'user'
      ? {
          turnNumber,
          role: 'user' as const,
          content: turn.content,
          provenance: 'USER' as const,
          epistemicStatus: 'USER_CLAIM_OR_INTENT' as const,
        }
      : {
          turnNumber,
          role: 'assistant' as const,
          content: turn.content,
          provenance: 'ASSISTANT' as const,
          epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE' as const,
        };
  });
  return { taskId: `aq-task-${testCase.id}`, conversationTranscript, backgroundResources: [] };
}

const composer = new PromptComposer();
const renderer = new PromptRenderer();

/** The exact `AiRequest` the production GENERAL_CHAT path would send for this case (same metadata as the runtime). */
export function buildCaseRequest(testCase: AnswerQualityCase): AiRequest {
  const spec = composer.compose(buildSyntheticTask(testCase), buildSyntheticContext(testCase));
  return renderer.render(spec, {
    capability: Capability.GENERAL_CHAT,
    timeoutMs: GENERATION_TIMEOUT_MS,
    metadata: generalChatReplyPolicyMetadata(testCase.userMessage),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Offline validation
// ---------------------------------------------------------------------------------------------------------------

/** Structural and behavioural problems of a fixture file; an empty array means it is valid. Offline and pure. */
export function validateFixtures(fixtures: AnswerQualityFixtures): string[] {
  const problems: string[] = [];
  if (fixtures.fixtureVersion !== FIXTURE_FILE_VERSION) {
    problems.push(`fixtureVersion must be ${FIXTURE_FILE_VERSION}`);
  }
  const byId = new Map<string, AnswerQualityCase>();
  for (const testCase of fixtures.cases) {
    const where = `case ${testCase.id}`;
    if (typeof testCase.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(testCase.id)) {
      problems.push(`${where}: id must be kebab-case`);
      continue;
    }
    if (byId.has(testCase.id)) problems.push(`${where}: duplicate id`);
    byId.set(testCase.id, testCase);
    if (testCase.locale !== 'ko' && testCase.locale !== 'en') problems.push(`${where}: locale must be ko or en`);
    if (typeof testCase.userMessage !== 'string' || testCase.userMessage.trim().length === 0) {
      problems.push(`${where}: userMessage must be non-empty`);
    }
    if (testCase.expectedLanguage !== undefined && !LANGUAGES.includes(testCase.expectedLanguage)) {
      problems.push(`${where}: unknown expectedLanguage`);
    }
    if (!Array.isArray(testCase.checks) || testCase.checks.length === 0) {
      problems.push(`${where}: checks must be a non-empty list`);
    } else {
      for (const check of testCase.checks) {
        if (!isCheckName(check)) problems.push(`${where}: unknown check ${String(check)}`);
      }
    }
    if (testCase.checks?.includes('lengthWithin')) {
      const limits = testCase.limits;
      if (limits === undefined || !(limits.minChars >= 0) || !(limits.maxChars >= limits.minChars)) {
        problems.push(`${where}: lengthWithin needs limits with 0 <= minChars <= maxChars`);
      }
    }
    if (testCase.checks?.includes('containsRelevantTokens')) {
      const groups = testCase.requiredTokenGroups;
      const wellFormed =
        Array.isArray(groups) &&
        groups.length > 0 &&
        groups.every(
          (group) =>
            Array.isArray(group) &&
            group.length > 0 &&
            group.every((token) => typeof token === 'string' && token.length > 0),
        );
      if (!wellFormed) problems.push(`${where}: containsRelevantTokens needs non-empty requiredTokenGroups`);
    }
    if (testCase.checks?.includes('noInventedSpecifics') && !testCase.checks.includes('hedgesUncheckable')) {
      problems.push(`${where}: noInventedSpecifics must be paired with hedgesUncheckable`);
    }
    for (const turn of testCase.transcript ?? []) {
      if ((turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') {
        problems.push(`${where}: malformed transcript turn`);
      }
    }
    if (problems.some((p) => p.startsWith(where))) continue;
    // Behavioural: the real composer and renderer must build a GENERAL_CHAT request that carries the message and
    // the ADR-0098 policy rules, with the same reply-policy metadata the runtime passes.
    try {
      const request = buildCaseRequest(testCase);
      const escapedMessage = JSON.stringify(testCase.userMessage).slice(1, -1);
      if (!request.prompt.includes(escapedMessage)) problems.push(`${where}: rendered prompt lacks the user message`);
      if (!request.prompt.includes(renderGeneralChatPolicyRules())) {
        problems.push(`${where}: rendered prompt lacks the GENERAL_CHAT policy rules`);
      }
      if (request.capability !== Capability.GENERAL_CHAT) problems.push(`${where}: capability is not GENERAL_CHAT`);
    } catch (error) {
      problems.push(`${where}: prompt construction failed (${error instanceof Error ? error.name : 'error'})`);
    }
  }
  const outputIds = new Set<string>();
  for (const bad of fixtures.knownBadOutputs) {
    const where = `knownBadOutput ${bad.id}`;
    if (outputIds.has(bad.id)) problems.push(`${where}: duplicate id`);
    outputIds.add(bad.id);
    const testCase = byId.get(bad.caseId);
    if (testCase === undefined) {
      problems.push(`${where}: unknown caseId ${bad.caseId}`);
      continue;
    }
    if (!Array.isArray(bad.mustFail) || bad.mustFail.length === 0) problems.push(`${where}: mustFail is empty`);
    const results = new Map(checkOutputForCase(testCase, bad.text).map((r) => [r.name, r]));
    for (const name of bad.mustFail) {
      if (!testCase.checks.includes(name)) problems.push(`${where}: case ${bad.caseId} does not declare ${name}`);
      else if (results.get(name)?.passed !== false) problems.push(`${where}: ${name} did not flag the bad output`);
    }
  }
  for (const good of fixtures.knownGoodOutputs) {
    const where = `knownGoodOutput ${good.id}`;
    if (outputIds.has(good.id)) problems.push(`${where}: duplicate id`);
    outputIds.add(good.id);
    const testCase = byId.get(good.caseId);
    if (testCase === undefined) {
      problems.push(`${where}: unknown caseId ${good.caseId}`);
      continue;
    }
    for (const result of checkOutputForCase(testCase, good.text)) {
      if (!result.passed) problems.push(`${where}: ${result.name} flagged a clean output (${result.detail ?? ''})`);
    }
  }
  const covered = new Set(fixtures.cases.flatMap((c) => c.checks));
  for (const name of CHECK_NAMES) {
    if (!covered.has(name)) problems.push(`no case exercises ${name}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Saved-output checking (offline)
// ---------------------------------------------------------------------------------------------------------------

export interface SavedOutput {
  readonly caseId: string;
  readonly text: string;
}

export interface OutputCheckRow {
  readonly caseId: string;
  readonly results: readonly CheckResult[];
}

export interface PassRate {
  readonly passed: number;
  readonly total: number;
  readonly rate: number;
}

/** Pass counts per check over a set of rows. */
export function summarizePassRates(rows: readonly OutputCheckRow[]): Readonly<Record<string, PassRate>> {
  const counts = new Map<string, { passed: number; total: number }>();
  for (const row of rows) {
    for (const result of row.results) {
      const entry = counts.get(result.name) ?? { passed: 0, total: 0 };
      entry.total += 1;
      if (result.passed) entry.passed += 1;
      counts.set(result.name, entry);
    }
  }
  const summary: Record<string, PassRate> = {};
  for (const name of CHECK_NAMES) {
    const entry = counts.get(name);
    if (entry !== undefined) summary[name] = { ...entry, rate: entry.total === 0 ? 1 : entry.passed / entry.total };
  }
  return summary;
}

/** Apply each case's declared checks to saved outputs. An unknown caseId is a typed error, not a silent skip. */
export function checkSavedOutputs(fixtures: AnswerQualityFixtures, outputs: readonly SavedOutput[]): OutputCheckRow[] {
  const byId = new Map(fixtures.cases.map((c) => [c.id, c]));
  return outputs.map((output) => {
    const testCase = byId.get(output.caseId);
    if (testCase === undefined) throw new AnswerQualityBlockedError('UNKNOWN_CASE_ID', output.caseId);
    return { caseId: output.caseId, results: checkOutputForCase(testCase, output.text) };
  });
}

/** Parse a saved-output file: `[{caseId,text}]` or `{outputs:[...]}`. Anything else is rejected. */
export function parseSavedOutputs(raw: unknown): SavedOutput[] {
  const list: unknown = Array.isArray(raw) ? raw : (raw as { outputs?: unknown } | null)?.outputs;
  if (!Array.isArray(list)) throw new AnswerQualityBlockedError('INVALID_OUTPUT_FILE', 'expected an array of outputs');
  return list.map((item, index) => {
    const entry = item as { caseId?: unknown; text?: unknown } | null;
    if (typeof entry?.caseId !== 'string' || typeof entry.text !== 'string') {
      throw new AnswerQualityBlockedError('INVALID_OUTPUT_FILE', `entry ${index} needs string caseId and text`);
    }
    return { caseId: entry.caseId, text: entry.text };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Plan and digest (offline, spawns nothing)
// ---------------------------------------------------------------------------------------------------------------

export interface EvalPlan {
  readonly planVersion: string;
  readonly target: EvalTarget;
  readonly providerKind: 'ollama-cli' | 'claude-cli';
  readonly model: string;
  readonly callsPerCase: number;
  readonly totalCalls: number;
  readonly fixtureVersion: string;
  readonly fixtureDigest: string;
  readonly checkerVersion: string;
  readonly caseIds: readonly string[];
  /** sha256 of the exact rendered prompt of each case (changing the composer or the rules changes the plan). */
  readonly promptDigests: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** What a run of this plan would touch. Shown to the Product Owner before approving. */
  readonly egress: 'local-process' | 'cloud-provider-network';
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function validateTargetModel(target: EvalTarget, model: string): string {
  if (!MODEL_PATTERN.test(model)) throw new AnswerQualityBlockedError('INVALID_MODEL', 'model name has unsupported characters');
  // Local plans never name a cloud-routed model (the same closed-egress rule as ADR-0098 D8).
  if (target === 'ollama' && /cloud/i.test(model)) throw new AnswerQualityBlockedError('CLOUD_MODEL_REFUSED');
  return model;
}

export function validateCalls(calls: number): number {
  if (!Number.isInteger(calls) || calls < 1 || calls > MAX_CALLS_PER_CASE) {
    throw new AnswerQualityBlockedError('INVALID_CALLS', `calls must be an integer 1..${MAX_CALLS_PER_CASE}`);
  }
  return calls;
}

export function buildPlan(
  fixtures: AnswerQualityFixtures,
  options: { target: EvalTarget; model: string; calls: number },
): EvalPlan {
  const model = validateTargetModel(options.target, options.model);
  const calls = validateCalls(options.calls);
  const promptDigests: Record<string, string> = {};
  for (const testCase of fixtures.cases) promptDigests[testCase.id] = sha256Hex(buildCaseRequest(testCase).prompt);
  return {
    planVersion: PLAN_VERSION,
    target: options.target,
    providerKind: options.target === 'ollama' ? 'ollama-cli' : 'claude-cli',
    model,
    callsPerCase: calls,
    totalCalls: calls * fixtures.cases.length,
    fixtureVersion: fixtures.fixtureVersion,
    fixtureDigest: sha256Hex(canonicalJson(fixtures)),
    checkerVersion: ANSWER_QUALITY_CHECKER_VERSION,
    caseIds: fixtures.cases.map((c) => c.id),
    promptDigests,
    timeoutMs: GENERATION_TIMEOUT_MS,
    egress: options.target === 'ollama' ? 'local-process' : 'cloud-provider-network',
  };
}

export function computePlanDigest(plan: EvalPlan): string {
  return sha256Hex(canonicalJson(plan));
}

// ---------------------------------------------------------------------------------------------------------------
// Provider run (Strict; the caller constructs the provider after the digest check)
// ---------------------------------------------------------------------------------------------------------------

export interface RunCallRecord {
  readonly caseId: string;
  readonly callIndex: number;
  readonly outputText?: string;
  readonly error?: string;
  readonly checks: readonly CheckResult[];
}

export interface RunReport {
  readonly plan: EvalPlan;
  readonly planDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly calls: readonly RunCallRecord[];
  readonly passRates: Readonly<Record<string, PassRate>>;
  readonly errorCount: number;
}

/**
 * Execute the plan against an already-constructed provider, strictly sequentially, and apply each case's checks to
 * every reply. A provider error is recorded (error name only) and excluded from the pass rates. Output text is
 * secret-masked and truncated before it is stored.
 */
export async function runProviderEvaluation(options: {
  readonly fixtures: AnswerQualityFixtures;
  readonly plan: EvalPlan;
  readonly provider: AiProvider;
  readonly now: () => string;
}): Promise<RunReport> {
  const { fixtures, plan, provider, now } = options;
  const startedAt = now();
  const calls: RunCallRecord[] = [];
  for (const testCase of fixtures.cases) {
    for (let callIndex = 1; callIndex <= plan.callsPerCase; callIndex += 1) {
      try {
        const result = await provider.execute(buildCaseRequest(testCase));
        calls.push({
          caseId: testCase.id,
          callIndex,
          outputText: maskSecrets(result.text).slice(0, MAX_STORED_OUTPUT_CHARS),
          checks: checkOutputForCase(testCase, result.text),
        });
      } catch (error) {
        calls.push({
          caseId: testCase.id,
          callIndex,
          error: error instanceof Error ? error.name : 'UnknownError',
          checks: [],
        });
      }
    }
  }
  const rows = calls.filter((call) => call.error === undefined).map((call) => ({ caseId: call.caseId, results: call.checks }));
  return {
    plan,
    planDigest: computePlanDigest(plan),
    startedAt,
    finishedAt: now(),
    calls,
    passRates: summarizePassRates(rows),
    errorCount: calls.filter((call) => call.error !== undefined).length,
  };
}
