import { performance } from 'node:perf_hooks';
import {
  ClaudeCliProvider,
  OllamaCliProvider,
  defaultCliRunner,
} from '@quoky/ai-cli';
import type { CliRunner } from '@quoky/ai-cli';
import {
  Capability,
  IntentType,
  PromptComposer,
  PromptRenderer,
  RiskLevel,
  TaskStatus,
} from '@quoky/core';
import type { AiProvider, AiRequest, ContextBundle, Task } from '@quoky/core';

export const CANONICAL_RECALL_SCENARIO = Object.freeze({
  previousUserMessage: '안녕?',
  previousAssistantMessage: '네, 안녕하세요!',
  currentUserMessage: '내가 방금 뭐라 질문했어?',
  contextTruncationOccurred: false,
} as const);

export const RECALL_COMPARISON_TARGETS = Object.freeze([
  Object.freeze({ providerId: 'ollama-cli:llama3.1:8b', modelIdentity: 'llama3.1:8b' }),
  Object.freeze({ providerId: 'ollama-cli:granite3.3:8b', modelIdentity: 'granite3.3:8b' }),
  Object.freeze({
    providerId: 'claude-cli',
    // ClaudeCliProvider intentionally does not pin --model. This is the exact configured identity.
    modelIdentity: 'claude-cli configured default (not pinned)',
  }),
] as const);

export type RecallDiagnosticStatus = 'PASS' | 'FAIL';
export type RecallOutputFormatStatus = 'CLEAN' | 'CONTAMINATED' | 'NOT_EVALUATED';
export type RecallComparisonCategory = 'PRODUCTION_PATH' | 'NORMALIZED_INPUT_CONTROL';
export type RecallDiagnosticConclusion =
  | 'MODEL_EFFECT'
  | 'OLLAMA_SERIALIZATION_EFFECT'
  | 'QUIRKYBOT_CONTEXT_EFFECT';

export interface ProviderRecallComparisonResult {
  readonly category: RecallComparisonCategory;
  readonly providerId: string;
  readonly modelIdentity: string;
  readonly previousTurnPresentAtProviderBoundary: boolean;
  readonly serializedInputCharacterCount: number;
  readonly contextTruncationOccurred: boolean;
  readonly generationLatencyMs: number;
  readonly semanticRecallResult: RecallDiagnosticStatus;
  readonly outputFormatResult: RecallOutputFormatStatus;
  readonly responseText: string;
  readonly error: string | null;
}

export interface RecallConclusionAssessment {
  readonly conclusion: RecallDiagnosticConclusion;
  readonly status: 'SUPPORTED' | 'INCONCLUSIVE';
  readonly rationale: string;
}

export interface ProviderRecallDiagnosticReport {
  readonly productionPath: readonly ProviderRecallComparisonResult[];
  readonly normalizedInputControl: readonly ProviderRecallComparisonResult[];
  readonly conclusions: readonly RecallConclusionAssessment[];
}

export interface ProviderRecallDiagnosticOptions {
  readonly runner?: CliRunner;
  readonly ollamaBin?: string;
  readonly claudeBin?: string;
  readonly timeoutMs?: number;
  /** Monotonic millisecond clock; injectable for deterministic tests. */
  readonly now?: () => number;
}

export interface RecallStochasticRunResult {
  readonly run: number;
  readonly semanticRecallResult: RecallDiagnosticStatus;
  readonly outputFormatResult: RecallOutputFormatStatus;
  readonly responseText: string;
  readonly error: string | null;
}

export interface RecallStochasticReport {
  readonly providerId: 'ollama-cli:llama3.1:8b';
  readonly modelIdentity: 'llama3.1:8b';
  readonly iterationCount: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly reliabilityRatio: number;
  readonly formatPassCount: number;
  readonly formatFailCount: number;
  readonly formatCorrectnessRatio: number;
  readonly runs: readonly RecallStochasticRunResult[];
}

export interface RecallStochasticOptions {
  readonly runner?: CliRunner;
  readonly ollamaBin?: string;
  readonly timeoutMs?: number;
  /** Defaults to five and is deliberately capped for an explicitly authorized run. */
  readonly iterations?: number;
}

export type RecallInputDifferenceCategory =
  | 'PROMPT_LAYER'
  | 'SYSTEM_INSTRUCTIONS'
  | 'CONTEXT_ENTRY'
  | 'METADATA';

export interface RecallInputDifference {
  readonly category: RecallInputDifferenceCategory;
  readonly path: string;
  readonly canonical: string;
  readonly live: string;
}

export interface RecallInputComparisonReport {
  readonly candidate: 'MODEL_STOCHASTICITY' | 'LIVE_RUNTIME_CONTEXT_DIFFERENCE';
  readonly identical: boolean;
  readonly differences: readonly RecallInputDifference[];
}

interface ComparisonTarget {
  readonly providerId: string;
  readonly modelIdentity: string;
  readonly provider: AiProvider;
  readonly getSerializedInput: () => string;
  readonly resetSerializedInput: () => void;
  readonly includeWhenAvailable: boolean;
}

const CANONICAL_TIMESTAMP = '2026-08-20T00:00:00.000Z';
const CANONICAL_TASK_ID = 'provider-recall-diagnostic-task';
const DEFAULT_STOCHASTIC_ITERATIONS = 5;
const MAX_STOCHASTIC_ITERATIONS = 20;
const MAX_DIFF_EXCERPT_CHARACTERS = 80;

/** Build the one finalized GENERAL_CHAT request shared by every comparison target. */
export function createCanonicalRecallRequest(): AiRequest {
  const task: Task = {
    id: CANONICAL_TASK_ID,
    title: 'Canonical conversational recall diagnostic',
    description: CANONICAL_RECALL_SCENARIO.currentUserMessage,
    status: TaskStatus.PENDING,
    intent: {
      type: IntentType.CHAT,
      capability: Capability.GENERAL_CHAT,
      confidence: 1,
      requiresWork: true,
      summary: CANONICAL_RECALL_SCENARIO.currentUserMessage,
    },
    riskLevel: RiskLevel.LOW,
    context: {
      platform: 'diagnostic',
      channelId: 'provider-recall-diagnostic-channel',
      userId: 'provider-recall-diagnostic-user',
    },
    createdAt: CANONICAL_TIMESTAMP,
    updatedAt: CANONICAL_TIMESTAMP,
  };
  const context: ContextBundle = {
    taskId: task.id,
    backgroundResources: [],
    conversationTranscript: [
      {
        turnNumber: 1,
        role: 'user',
        provenance: 'USER',
        epistemicStatus: 'USER_CLAIM_OR_INTENT',
        content: CANONICAL_RECALL_SCENARIO.previousUserMessage,
      },
      {
        turnNumber: 1,
        role: 'assistant',
        provenance: 'ASSISTANT',
        epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
        content: CANONICAL_RECALL_SCENARIO.previousAssistantMessage,
      },
    ],
  };

  const spec = new PromptComposer().compose(task, context);
  return new PromptRenderer().render(spec, { capability: Capability.GENERAL_CHAT });
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

/** Serialize the exact canonical AiRequest with recursively stable object-key ordering. */
export function exportCanonicalRecallRequestSnapshot(): string {
  return `${JSON.stringify(sortJsonValue(createCanonicalRecallRequest()), null, 2)}\n`;
}

interface PromptLayer {
  readonly name: string;
  readonly content: string;
}

function promptLayers(prompt: string): readonly PromptLayer[] {
  const matches = [...prompt.matchAll(/^# ([^\n]+)\n/gm)];
  if (matches.length === 0) return Object.freeze([{ name: 'Unlayered', content: prompt }]);
  return Object.freeze(matches.map((match, index) => {
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? prompt.length;
    return Object.freeze({
      name: match[1] ?? 'Unknown',
      content: prompt.slice(contentStart, contentEnd).trimEnd(),
    });
  }));
}

function boundedSafeExcerpt(value: string): string {
  const redacted = value
    .replace(/\b(?:bearer\s+)?[a-z0-9_-]*(?:token|secret|password|api[_-]?key)[a-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)_[a-z0-9_-]+\b/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length <= MAX_DIFF_EXCERPT_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_DIFF_EXCERPT_CHARACTERS - 1)}…`;
}

function contentSummary(value: string | undefined): string {
  if (value === undefined) return '<missing>';
  return `length=${value.length}; excerpt=${JSON.stringify(boundedSafeExcerpt(value))}`;
}

function metadataSummary(value: unknown): string {
  if (value === undefined) return '<missing>';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

function stableValue(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/**
 * Compare provider-boundary request structure without returning unbounded or raw values.
 * Metadata values are represented only by their types; prompt/context text is redacted and capped.
 */
export function compareRecallInputs(
  canonical: AiRequest,
  live: AiRequest,
): RecallInputComparisonReport {
  const differences: RecallInputDifference[] = [];
  const canonicalLayers = promptLayers(canonical.prompt);
  const liveLayers = promptLayers(live.prompt);
  const layerNames = [...new Set([
    ...canonicalLayers.map(({ name }) => name),
    ...liveLayers.map(({ name }) => name),
  ])].sort();

  for (const name of layerNames) {
    const canonicalLayer = canonicalLayers.find((layer) => layer.name === name);
    const liveLayer = liveLayers.find((layer) => layer.name === name);
    if (canonicalLayer?.content === liveLayer?.content) continue;
    differences.push(Object.freeze({
      category: name === 'System' ? 'SYSTEM_INSTRUCTIONS' : 'PROMPT_LAYER',
      path: `prompt.${name}`,
      canonical: contentSummary(canonicalLayer?.content),
      live: contentSummary(liveLayer?.content),
    }));
  }

  const canonicalContext = new Map((canonical.contextFiles ?? []).map((entry) => [entry.path, entry.content]));
  const liveContext = new Map((live.contextFiles ?? []).map((entry) => [entry.path, entry.content]));
  const contextPaths = [...new Set([...canonicalContext.keys(), ...liveContext.keys()])].sort();
  for (const path of contextPaths) {
    const canonicalContent = canonicalContext.get(path);
    const liveContent = liveContext.get(path);
    if (canonicalContent === liveContent) continue;
    differences.push(Object.freeze({
      category: 'CONTEXT_ENTRY',
      path: `contextFiles.${boundedSafeExcerpt(path)}`,
      canonical: contentSummary(canonicalContent),
      live: contentSummary(liveContent),
    }));
  }

  const canonicalMetadata = canonical.metadata ?? {};
  const liveMetadata = live.metadata ?? {};
  const metadataKeys = [...new Set([
    ...Object.keys(canonicalMetadata),
    ...Object.keys(liveMetadata),
  ])].sort();
  for (const key of metadataKeys) {
    const canonicalValue = canonicalMetadata[key];
    const liveValue = liveMetadata[key];
    if (stableValue(canonicalValue) === stableValue(liveValue)) continue;
    differences.push(Object.freeze({
      category: 'METADATA',
      path: `metadata.${boundedSafeExcerpt(key)}`,
      canonical: metadataSummary(canonicalValue),
      live: metadataSummary(liveValue),
    }));
  }

  return Object.freeze({
    candidate: differences.length === 0
      ? 'MODEL_STOCHASTICITY' as const
      : 'LIVE_RUNTIME_CONTEXT_DIFFERENCE' as const,
    identical: differences.length === 0,
    differences: Object.freeze(differences),
  });
}

/** Run only llama3.1's existing production serialization for a bounded sample. */
export async function runStochasticRecallDiagnostic(
  options: RecallStochasticOptions = {},
): Promise<RecallStochasticReport> {
  const iterations = options.iterations ?? DEFAULT_STOCHASTIC_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_STOCHASTIC_ITERATIONS) {
    throw new RangeError(`iterations must be an integer between 1 and ${MAX_STOCHASTIC_ITERATIONS}`);
  }

  const provider = new OllamaCliProvider({
    bin: options.ollamaBin ?? 'ollama',
    model: 'llama3.1:8b',
    providerId: 'ollama-cli:llama3.1:8b',
    runner: options.runner ?? defaultCliRunner,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  const request = createCanonicalRecallRequest();
  const runs: RecallStochasticRunResult[] = [];
  for (let index = 0; index < iterations; index += 1) {
    let responseText = '';
    let error: string | null = null;
    try {
      responseText = (await provider.execute(request)).text;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    runs.push(Object.freeze({
      run: index + 1,
      semanticRecallResult: error === null ? evaluateRecall(responseText) : 'FAIL',
      outputFormatResult: error === null ? evaluateOutputFormat(responseText) : 'NOT_EVALUATED',
      responseText,
      error,
    }));
  }
  const passCount = runs.filter(
    ({ semanticRecallResult }) => semanticRecallResult === 'PASS',
  ).length;
  const formatPassCount = runs.filter(
    ({ outputFormatResult }) => outputFormatResult === 'CLEAN',
  ).length;
  return Object.freeze({
    providerId: 'ollama-cli:llama3.1:8b',
    modelIdentity: 'llama3.1:8b',
    iterationCount: iterations,
    passCount,
    failCount: iterations - passCount,
    reliabilityRatio: passCount / iterations,
    formatPassCount,
    formatFailCount: iterations - formatPassCount,
    formatCorrectnessRatio: formatPassCount / iterations,
    runs: Object.freeze(runs),
  });
}

/** Detect internal role/provenance JSON envelopes without interpreting prose. */
export function evaluateOutputFormat(output: string): RecallOutputFormatStatus {
  const unescaped = output.replace(/\\"/g, '"');
  const objectLikeSegments = unescaped.match(/\{[^{}]{0,2000}\}/gs) ?? [];
  return objectLikeSegments.some((segment) =>
    /["']role["']\s*:\s*["'](?:assistant|user|system|unknown)["']/i.test(segment) &&
    /["']provenance["']\s*:/i.test(segment)
  ) ? 'CONTAMINATED' : 'CLEAN';
}

function envelopeContentCandidates(output: string): string[] {
  const candidates = [output];
  for (const segment of output.match(/\{[^{}]{0,2000}\}/gs) ?? []) {
    try {
      const parsed = JSON.parse(segment) as { content?: unknown };
      if (typeof parsed.content === 'string') candidates.push(parsed.content);
    } catch {
      // Malformed envelopes remain a format failure; semantic grading uses any
      // independently parseable content and otherwise falls back to raw output.
    }
  }
  return candidates;
}

function evaluateRecallCandidate(output: string): RecallDiagnosticStatus {
  const normalized = output.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const deniesRecall =
    /(?:기억하지\s*못|기억할\s*수\s*없|알\s*수\s*없|모르겠|확인할\s*수\s*없)/.test(normalized);
  const isMetaClarification =
    /(?:말씀하시는|질문하신|물어보신)\s*(?:게|건|것은|내용이)\s*(?:맞나요|맞습니까|건가요|인가요)|(?:질문하셨|물어보셨|말씀하셨)나요|(?:무엇|어떤)\s*질문|(?:구체적으로|다시)\s*말씀/.test(normalized);

  // Attribute the canonical text within its own clause. Passing requires positive
  // evidence that the user is the speaker; bare speech verbs must not imply that.
  const canonicalClauses = normalized
    .split(/[,，;；]|\.(?:\s|$)|(?:였|이었|했)고\s+/)
    .filter((clause) => /안녕\s*\?/.test(clause));
  const userLabel =
    /(?:사용자|질문자|고객)(?:님)?(?:께서|이|가|은|는)?(?:\s*(?:메시지|질문)(?:이|가|은|는)?)?/;
  const directUserAttribution =
    /(?:당신(?:이|은)|너가|네가|(?:the\s+)?user\s+(?:said|asked|wrote|sent)|you\s+(?:said|asked|wrote|sent))/;
  const attributesCanonicalToAssistant = canonicalClauses.some((clause) =>
    /(?:assistant|어시스턴트|봇|\bai\b)(?:가|는|이|은|께서)?.{0,40}안녕\s*\?/.test(clause) ||
    /안녕\s*\?.{0,40}(?:assistant|어시스턴트|봇|\bai\b)(?:가|는|이|은|께서)?/.test(clause));
  const negatedUserWithAssistantSubject = canonicalClauses.some((clause) =>
    /(?:사용자|질문자|고객)(?:님)?(?:이|가|은|는)?\s*(?:이\s*)?아니라|(?:사용자|질문자|고객)(?:님)?(?:이|가|은|는)?\s*이\s*아니고/.test(clause) &&
    /(?:assistant|어시스턴트|봇|\bai\b)(?:가|는|이|은|께서)?/.test(clause));
  const attributesMessageToUser = canonicalClauses.some((clause) => {
    const canonical = '안녕\\s*\\?';
    const nearbyUserAttribution = new RegExp(
      `(?:${userLabel.source}|${directUserAttribution.source}).{0,40}${canonical}|` +
      `${canonical}.{0,40}(?:${userLabel.source}|${directUserAttribution.source})`,
    ).test(clause);
    const previousUserTurnLabel = new RegExp(
      `(?:직전|방금)(?:\\s+(?:사용자(?:님)?\\s*)?(?:메시지|질문))(?:\\s*(?:이|가|은|는|:))?` +
      `.{0,20}${canonical}`,
    ).test(clause);
    const honorificUserSpeech = new RegExp(
      `${canonical}.{0,30}(?:질문하|물어보|말씀하|하)(?:셨습니다|셨어요|셨다|셨죠)`,
    ).test(clause);

    return nearbyUserAttribution || previousUserTurnLabel || honorificUserSpeech;
  });
  const directCanonicalAnswer = /^["'“”‘’\s]*안녕\s*\?["'“”‘’\s.!。]*$/.test(normalized);

  return (attributesMessageToUser || directCanonicalAnswer) && !attributesCanonicalToAssistant &&
    !negatedUserWithAssistantSubject && !deniesRecall && !isMetaClarification
    ? 'PASS'
    : 'FAIL';
}

export function evaluateRecall(output: string): RecallDiagnosticStatus {
  return envelopeContentCandidates(output).some(
    (candidate) => evaluateRecallCandidate(candidate) === 'PASS',
  ) ? 'PASS' : 'FAIL';
}

function targetWithCapturedInput(
  definition: (
    runner: CliRunner,
  ) => Omit<ComparisonTarget, 'getSerializedInput' | 'resetSerializedInput'>,
  delegatedRunner: CliRunner,
): ComparisonTarget {
  let serializedInput = '';
  const capturingRunner: CliRunner = async (bin, args, options) => {
    if (options.input.length > 0) serializedInput = options.input;
    return delegatedRunner(bin, args, options);
  };
  return {
    ...definition(capturingRunner),
    getSerializedInput: () => serializedInput,
    resetSerializedInput: () => {
      serializedInput = '';
    },
  };
}

function comparisonTargets(options: ProviderRecallDiagnosticOptions): readonly ComparisonTarget[] {
  const delegatedRunner = options.runner ?? defaultCliRunner;
  const ollamaBin = options.ollamaBin ?? 'ollama';
  const claudeBin = options.claudeBin ?? 'claude';
  const timeoutMs = options.timeoutMs ?? 120_000;

  return RECALL_COMPARISON_TARGETS.map((target) =>
    targetWithCapturedInput(
      (runner) => ({
        providerId: target.providerId,
        modelIdentity: target.modelIdentity,
        includeWhenAvailable: target.providerId === 'claude-cli',
        provider: target.providerId === 'claude-cli'
          ? new ClaudeCliProvider(claudeBin, { runner, timeoutMs })
          : new OllamaCliProvider({
              bin: ollamaBin,
              model: target.modelIdentity,
              providerId: target.providerId,
              runner,
              timeoutMs,
            }),
      }),
      delegatedRunner,
    ),
  );
}

function providerBoundaryContainsPreviousTurn(serializedInput: string): boolean {
  return serializedInput.includes(CANONICAL_RECALL_SCENARIO.previousUserMessage) &&
    serializedInput.includes(CANONICAL_RECALL_SCENARIO.previousAssistantMessage);
}

function resultFor(
  category: RecallComparisonCategory,
  target: ComparisonTarget,
  serializedInput: string,
  generationLatencyMs: number,
  responseText: string,
  error: string | null,
): ProviderRecallComparisonResult {
  return Object.freeze({
    category,
    providerId: target.providerId,
    modelIdentity: target.modelIdentity,
    previousTurnPresentAtProviderBoundary: providerBoundaryContainsPreviousTurn(serializedInput),
    serializedInputCharacterCount: serializedInput.length,
    contextTruncationOccurred: CANONICAL_RECALL_SCENARIO.contextTruncationOccurred,
    generationLatencyMs,
    semanticRecallResult: error === null ? evaluateRecall(responseText) : 'FAIL',
    outputFormatResult: error === null ? evaluateOutputFormat(responseText) : 'NOT_EVALUATED',
    responseText,
    error,
  });
}

function assessConclusions(
  productionPath: readonly ProviderRecallComparisonResult[],
  normalizedInputControl: readonly ProviderRecallComparisonResult[],
): readonly RecallConclusionAssessment[] {
  const normalizedLlama = normalizedInputControl.find(({ modelIdentity }) => modelIdentity === 'llama3.1:8b');
  const normalizedGranite = normalizedInputControl.find(({ modelIdentity }) => modelIdentity === 'granite3.3:8b');
  const productionLlama = productionPath.find(({ modelIdentity }) => modelIdentity === 'llama3.1:8b');
  const modelEffect = normalizedLlama?.error === null && normalizedGranite?.error === null &&
    normalizedLlama.semanticRecallResult !== normalizedGranite.semanticRecallResult;
  const serializationEffect = productionLlama?.error === null && normalizedLlama?.error === null &&
    productionLlama.semanticRecallResult !== normalizedLlama.semanticRecallResult;

  return Object.freeze([
    Object.freeze({
      conclusion: 'MODEL_EFFECT' as const,
      status: modelEffect ? 'SUPPORTED' as const : 'INCONCLUSIVE' as const,
      rationale: modelEffect
        ? 'llama3.1 and granite3.3 differ when given the same finalized plain prompt serialization.'
        : 'The normalized controls did not produce a successful difference in recall outcome.',
    }),
    Object.freeze({
      conclusion: 'OLLAMA_SERIALIZATION_EFFECT' as const,
      status: serializationEffect ? 'SUPPORTED' as const : 'INCONCLUSIVE' as const,
      rationale: serializationEffect
        ? 'llama3.1 differs between its production serialization and the normalized plain prompt.'
        : 'llama3.1 did not produce a successful recall-outcome difference between serializations.',
    }),
    Object.freeze({
      conclusion: 'QUIRKYBOT_CONTEXT_EFFECT' as const,
      status: 'INCONCLUSIVE' as const,
      rationale: 'Both categories contain the same QuirkyBot-built context; no context-free control is run.',
    }),
  ]);
}

/**
 * Execute the controlled comparison when an authorized caller explicitly invokes it.
 * Importing this module never probes or executes a provider.
 */
export async function runComparison(
  options: ProviderRecallDiagnosticOptions = {},
): Promise<ProviderRecallDiagnosticReport> {
  const request = createCanonicalRecallRequest();
  const now = options.now ?? (() => performance.now());
  const targets = comparisonTargets(options);
  const productionPath: ProviderRecallComparisonResult[] = [];
  const normalizedInputControl: ProviderRecallComparisonResult[] = [];

  for (const target of targets) {
    // A probe that throws (including an indeterminate, timed-out one) counts as not available here.
    if (target.includeWhenAvailable && !(await target.provider.isAvailable().catch(() => false))) continue;

    const startedAt = now();
    let responseText = '';
    let error: string | null = null;
    target.resetSerializedInput();
    try {
      responseText = (await target.provider.execute(request)).text;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const generationLatencyMs = Math.max(0, Math.round(now() - startedAt));
    const serializedInput = target.getSerializedInput();

    productionPath.push(resultFor(
      'PRODUCTION_PATH', target, serializedInput, generationLatencyMs, responseText, error,
    ));
  }

  for (const target of targets.filter(({ providerId }) => providerId.startsWith('ollama-cli:'))) {
    const startedAt = now();
    let responseText = '';
    let error: string | null = null;
    target.resetSerializedInput();
    try {
      responseText = (await target.provider.execute({
        ...request,
        // Non-chat capability bypasses only llama3.1's adapter-local role serialization.
        // Both Ollama models therefore receive request.prompt byte-for-byte.
        capability: Capability.SUMMARIZATION,
      })).text;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const generationLatencyMs = Math.max(0, Math.round(now() - startedAt));
    const serializedInput = target.getSerializedInput();
    normalizedInputControl.push(resultFor(
      'NORMALIZED_INPUT_CONTROL', target, serializedInput, generationLatencyMs, responseText, error,
    ));
  }

  return Object.freeze({
    productionPath: Object.freeze(productionPath),
    normalizedInputControl: Object.freeze(normalizedInputControl),
    conclusions: assessConclusions(productionPath, normalizedInputControl),
  });
}
