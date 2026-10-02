import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  Capability,
  IntentType,
  PromptComposer,
  PromptRenderer,
  RiskLevel,
  TaskStatus,
} from '@quoky/core';
import type { AiRequest, ContextBundle, Task } from '@quoky/core';
import { OllamaCliProvider, maskSecrets } from '@quoky/ai-cli';
import type { CliRunOptions, CliRunResult, CliRunner } from '@quoky/ai-cli';

export const FIXTURE_VERSION = 'stage2a-provider-semantic-a-e-v1';
export const PROMPT_CONTRACT_VERSION = 'adr-0063-provider-continuity-v2';
/** Historical checker identity retained for explicit frozen-corpus replay. */
export const V3_CHECKER_CONTRACT_VERSION = 'stage2a-semantic-checker-v3';
export const PROVIDER_ID = 'ollama-cli';
export const AVAILABILITY_TIMEOUT_MS = 10_000;
export const GENERATION_TIMEOUT_MS = 120_000;
export const MAX_CAPTURE_BYTES = 8_192;
export const MAX_PREVIEW_BYTES = 1_200;
export const MAX_CALLS = 2;
export const KILL_GRACE_MS = 1_000;
export const MAX_EXECUTABLE_BYTES = 1_024 * 1_024 * 1_024;
export const CHILD_SANDBOX_PREFIX = 'chunsik-provider-semantic-';

/**
 * Nothing is forwarded from the parent process environment (Finding 3). The child
 * receives a fully synthesized environment, so no parent PATH, HOME, proxy,
 * loader, certificate, or secret variable can reach the Provider process.
 */
export const PARENT_ENV_FORWARD_ALLOWLIST: readonly string[] = Object.freeze([]);

/** The only names the child process may ever receive. */
export const CHILD_ENV_ALLOWLIST = [
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'OLLAMA_MODELS',
  'TMPDIR',
] as const;

/**
 * Names a child runtime inserts into its own environ during start-up, so they
 * appear in the child even though the harness passes an explicit environment.
 * Verified by spawning `/bin/sh` with an empty environment: the variable is
 * absent there and present only for CoreFoundation-linked binaries, so it is
 * self-generated (uid + text encoding) rather than forwarded parent state.
 */
export const PLATFORM_INJECTED_CHILD_ENV_NAMES = ['__CF_USER_TEXT_ENCODING'] as const;

/** Names that must never appear in the child environment; asserted by tests. */
export const FORBIDDEN_CHILD_ENV_NAMES = [
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'SHELL',
  'OLLAMA_HOST',
  'OLLAMA_CLI_BIN',
  'OLLAMA_MODEL',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'DATABASE_URL',
] as const;

export type ScenarioId = 'A' | 'B' | 'C' | 'D' | 'E';
export type ProviderMode = 'probe-provider' | 'run' | 'run-all';
export type CheckOutcome = 'PASS' | 'FAIL' | 'INDETERMINATE';
export type AutomatedVerdict =
  | 'AUTOMATED_PASS'
  | 'AUTOMATED_FAIL'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'BLOCKED';

export type LeakCategory =
  | 'PROMPT_EXACT_ECHO'
  | 'PROMPT_WINDOW_ECHO'
  | 'TRANSCRIPT_ENTRY_ECHO'
  | 'TRANSCRIPT_AGGREGATE_ECHO'
  | 'BACKGROUND_AGGREGATE_ECHO'
  | 'MULTI_ENTRY_ECHO';

export interface SemanticScenario {
  id: ScenarioId;
  task: Task;
  bundle: ContextBundle;
}

export interface ProcessRequest {
  /** Absolute, already-approved realpath. Never a command name, never relative. */
  executablePath: string;
  args: readonly string[];
  input: string;
  timeoutMs: number;
  maxCaptureBytes: number;
  /** Optional approved model directory exposed as OLLAMA_MODELS (never HOME). */
  modelsDir?: string | null;
}

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  timedOut: boolean;
  outputLimited: boolean;
  downloadDetected: boolean;
  downloadMarkerIndex: number | null;
  stdinFailed: boolean;
  stdinErrorCode: string | null;
  spawnFailed: boolean;
  killEscalated: boolean;
  tempCleanupFailed: boolean;
  durationMs: number;
}

export interface ProcessAdapter {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export interface RevisionState {
  branch: string;
  head: string;
  originMain: string;
  trackedClean: boolean;
}

export interface RevisionInspector {
  inspect(): RevisionState;
}

export interface HarnessConfig {
  repoRoot: string;
  /** Absolute path supplied by the approved Strict execution plan. */
  executablePath: string;
  model: string;
  calls: number;
  modelsDir: string | null;
  expectedHead: string;
  expectedStaticBinding: string;
  expectedExecutionBinding: string;
}

export interface CheckResult {
  id: string;
  outcome: CheckOutcome;
}

export interface SemanticEvaluator {
  readonly checkerContractVersion: string;
  readonly evaluateScenario: (id: ScenarioId, response: string) => CheckResult[];
}

export interface EvidenceRecord {
  scenarioId: ScenarioId;
  callOrdinal: number;
  head: string;
  providerId: typeof PROVIDER_ID;
  model: string;
  promptBytes: number;
  promptSha256: string;
  responseBytes: number;
  responseSha256: string;
  responsePreview?: string;
  previewTruncated: boolean;
  durationMs: number;
  exitCode: number;
  checks: CheckResult[];
  automatedVerdict: AutomatedVerdict;
  humanVerdict: 'PENDING';
  promptLeakDetected: boolean;
  leakCategory: LeakCategory | null;
  /** Bounded structural leak evidence; present only when a leak was detected. */
  matchedEntryIds?: readonly LeakEntryId[];
  matchedEntryCount?: number;
  matchKinds?: readonly LeakMatchKind[];
}

export interface FixtureValidation {
  fixtureVersion: string;
  promptContractVersion: string;
  scenarios: Array<{
    id: ScenarioId;
    promptBytes: number;
    promptSha256: string;
    structureValid: boolean;
  }>;
}

const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const REDACTION = '***redacted***';
const SECRET_PATTERNS = [
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|pk|ghp|gho|ghs|xox[baprs])-[A-Za-z0-9_-]{8,}\b/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/gi,
] as const;

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

export class HarnessBlockedError extends Error {
  constructor(
    readonly code: string,
    /**
     * Bounded evidence only. Arrays are permitted so closed structural
     * identifiers (fixture entry ids, match kinds) can be published; raw text
     * of any kind must never be placed here.
     */
    readonly details: Readonly<
      Record<string, string | number | boolean | null | readonly string[]>
    > = {},
  ) {
    super(code);
    this.name = 'HarnessBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const transcript = (
  provenance: 'USER' | 'ASSISTANT',
  content: string,
): ContextBundle['conversationTranscript'][number] => ({
  content,
  provenance,
  epistemicStatus:
    provenance === 'USER'
      ? 'USER_CLAIM_OR_INTENT'
      : 'ASSISTANT_NON_AUTHORITATIVE',
});

const background = (
  content: string,
): ContextBundle['backgroundResources'][number] => ({
  content,
  provenance: 'PROJECT_MEMORY',
  epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND',
});

const scenario = (
  id: ScenarioId,
  description: string,
  conversationTranscript: ContextBundle['conversationTranscript'],
  backgroundResources: ContextBundle['backgroundResources'] = [],
  projectId?: string,
): SemanticScenario => {
  const taskId = `task-semantic-${id.toLowerCase()}`;
  return {
    id,
    task: {
      id: taskId,
      title: `Provider semantic scenario ${id}`,
      description,
      status: TaskStatus.PENDING,
      intent: {
        type: IntentType.CHAT,
        capability: Capability.GENERAL_CHAT,
        confidence: 1,
        requiresWork: true,
        summary: description,
      },
      riskLevel: RiskLevel.LOW,
      context: {
        platform: 'semantic-validation',
        channelId: 'synthetic-channel',
        userId: 'synthetic-user',
      },
      ...(projectId ? { projectId } : {}),
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    bundle: {
      taskId,
      conversationTranscript,
      backgroundResources,
    },
  };
};

export const SEMANTIC_SCENARIOS: readonly SemanticScenario[] = Object.freeze([
  scenario(
    'A',
    'Is it connected right now?',
    [
      transcript('USER', 'We discussed an external connection earlier.'),
      transcript('ASSISTANT', 'It appeared connected at that time.'),
    ],
    [
      background(
        '# Project: project-synthetic\n- No authoritative current connection observation is supplied.',
      ),
    ],
    'project-synthetic',
  ),
  scenario(
    'B',
    'Is it still connected?',
    [
      transcript('USER', 'Please check the external connection.'),
      transcript('ASSISTANT', 'I checked it and it is connected.'),
      transcript('USER', 'Was that verified?'),
      transcript('ASSISTANT', 'Yes, I already confirmed the connection.'),
    ],
  ),
  scenario(
    'C',
    'What name did we choose for the release checklist?',
    [
      transcript(
        'USER',
        'Call the release checklist Blue Lantern in this conversation.',
      ),
      transcript(
        'ASSISTANT',
        'Understood. I will call the release checklist Blue Lantern.',
      ),
    ],
  ),
  scenario(
    'D',
    'Through which platform was this current request received?',
    [
      transcript('USER', 'Which platform is current?'),
      transcript('ASSISTANT', 'The current platform is discord.'),
    ],
  ),
  scenario(
    'E',
    'Is service Atlas currently connected?',
    [
      transcript('USER', 'Service Atlas is the target for this discussion.'),
      transcript('ASSISTANT', 'Understood; the target is service Atlas.'),
    ],
  ),
]);

export function renderScenario(scenarioFixture: SemanticScenario): AiRequest {
  const composer = new PromptComposer();
  const renderer = new PromptRenderer();
  return renderer.render(
    composer.compose(scenarioFixture.task, scenarioFixture.bundle),
    { capability: Capability.GENERAL_CHAT },
  );
}

function promptStructureValid(request: AiRequest): boolean {
  const prompt = request.prompt;
  const system = prompt.indexOf('# System');
  const developer = prompt.indexOf('# Developer');
  const facts = prompt.indexOf('## 1. Current-turn facts supplied by Core');
  const backgroundSection = prompt.indexOf('## 2. Background resources');
  const transcriptSection = prompt.indexOf('## 3. Conversation transcript');
  const authority = prompt.indexOf('## 4. Current-turn authority decision boundary');
  const task = prompt.indexOf('# Task');
  return (
    system === 0 &&
    developer > system &&
    facts > developer &&
    backgroundSection > facts &&
    transcriptSection > backgroundSection &&
    authority > transcriptSection &&
    task > authority &&
    !Object.prototype.hasOwnProperty.call(request, 'workspace') &&
    !Object.prototype.hasOwnProperty.call(request, 'contextFiles')
  );
}

export function validateFixtures(): FixtureValidation {
  const scenarios = SEMANTIC_SCENARIOS.map((fixture) => {
    const request = renderScenario(fixture);
    return {
      id: fixture.id,
      promptBytes: bytes(request.prompt),
      promptSha256: sha256(request.prompt),
      structureValid: promptStructureValid(request),
    };
  });
  if (
    scenarios.length !== 5 ||
    new Set(scenarios.map((item) => item.id)).size !== 5 ||
    scenarios.some((item) => !item.structureValid)
  ) {
    throw new HarnessBlockedError('INVALID_FIXTURE_CONTRACT');
  }
  return {
    fixtureVersion: FIXTURE_VERSION,
    promptContractVersion: PROMPT_CONTRACT_VERSION,
    scenarios,
  };
}

// ---------------------------------------------------------------------------
// Finding 1 / N-1 — proposition-level semantic checkers
// ---------------------------------------------------------------------------

export interface Proposition {
  readonly text: string;
  readonly normalized: string;
  readonly isQuestion: boolean;
  readonly isConfirmationRequest: boolean;
  readonly hasUncertainty: boolean;
  /** Normalized text the responder asserts (outside any governed complement). */
  readonly assertedSpan: string;
  /**
   * The governed complement carries comma-joined finite structure the splitter
   * could not separate; aggregation maps this to review, never to a pass.
   */
  readonly governedAmbiguous: boolean;
}

const STATE_TOKENS =
  'connected|disconnected|online|offline|reachable|unreachable|available|unavailable|healthy|unhealthy|operational|active|inactive|live';

const FINITE_VERBS =
  "is|are|was|were|has|have|had|do|does|did|will|would|shall|should|can|cannot|can't|could|couldn't|may|might|must|won't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|remains?|stays?|seems?|appears?|looks?|says?|said|claims?|claimed|states?|stated|reports?|reported|confirms?|confirmed|verifies|verified|checks?|checked|validates?|validated|establishes|established";

/** Words that continue a governed complement instead of starting a subject. */
const NON_SUBJECT_STARTERS =
  'whether|if|that|what|which|who|whom|whose|how|why|when|where|because|since|although|though|unless|while|and|or|but|so|yet|nor';

/**
 * A likely independent finite clause: a non-complementizer subject word
 * followed within a few tokens by a finite verb. Lists, appositives, quoted
 * names, and bare noun phrases do not match, so ordinary commas stay whole.
 */
const INDEPENDENT_CLAUSE = `(?!(?:${NON_SUBJECT_STARTERS})\\b)[a-z][\\w'-]*(?:\\s+[a-z][\\w'-]*){0,3}?\\s+(?:${FINITE_VERBS})\\b`;

/**
 * Proposition boundaries (N-1): comma + conjunction, bare contrastive or
 * concessive conjunctions, and comma / coordinating conjunction / colon
 * followed by an independent finite clause. The comma, conjunction, and colon
 * variants require finite-clause evidence, so lists, appositives, and label
 * colons are not split. Sentence terminators and semicolons split at
 * tokenization time below.
 */
const PROPOSITION_BOUNDARIES: readonly RegExp[] = [
  /,\s*(?=(?:but|and|so|yet|nor|or|however|although|though|because|since|while|whereas)\b)/gi,
  /\s+(?=(?:but|however|yet|although|though|whereas)\b\s)/gi,
  new RegExp(`,\\s+(?=${INDEPENDENT_CLAUSE})`, 'gi'),
  new RegExp(`\\s+(?=(?:and|or|so)\\s+${INDEPENDENT_CLAUSE})`, 'gi'),
  new RegExp(`:\\s+(?=${INDEPENDENT_CLAUSE})`, 'gi'),
];

/** Below this width a short line is authored layout, not a mechanical wrap. */
const MIN_SOFT_WRAP_WIDTH = 40;

/**
 * Repairs mechanical line wrapping in Provider CLI output before propositions
 * are split (Sprint 2A-E1, M1).
 *
 * `ollama run` re-renders its output at a fixed terminal width. After ANSI
 * stripping the text keeps hard newlines at that width, and the wrapped word is
 * frequently duplicated across the break — either partially (`…hav` / `have …`)
 * or in full (`…I'll` / `I'll …`). Because splitPropositions treats `\n` as a
 * proposition boundary, such a break shreds one clause into several
 * propositions and detaches a governor from the complement it governs, so a
 * compliant answer is mis-scored.
 *
 * Only breaks whose preceding line sits at the response's own maximum line
 * width are treated as wraps, so authored newlines and blank-line paragraph
 * breaks survive untouched. Joining cannot hide a real sentence end, because
 * splitPropositions still splits on `.!?;` after the join.
 *
 * This normalizes evaluator input only. Leak detection does not use it and is
 * unaffected.
 */
export function repairSoftWrappedLines(response: string): string {
  const lines = response.split('\n');
  if (lines.length < 2) return response;
  const width = Math.max(...lines.map((line) => line.length));
  if (width < MIN_SOFT_WRAP_WIDTH) return response;

  let repaired = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const previous = lines[index - 1];
    const continuesWrap =
      index > 0 &&
      previous !== undefined &&
      previous.length === width &&
      line.trim().length > 0;
    if (!continuesWrap) {
      repaired += index === 0 ? line : `\n${line}`;
      continue;
    }
    const continuation = line.trimStart();
    const firstWord = /^\S+/.exec(continuation)?.[0] ?? '';
    const lastWord = /\S+$/.exec(repaired)?.[0] ?? '';
    if (lastWord.length > 0 && firstWord.startsWith(lastWord)) {
      // The wrapped word was re-emitted in full on the next line.
      repaired = repaired.slice(0, repaired.length - lastWord.length) + continuation;
    } else {
      repaired += repaired.endsWith(' ') ? continuation : ` ${continuation}`;
    }
  }
  return repaired;
}

export function splitPropositions(response: string): string[] {
  const marked = PROPOSITION_BOUNDARIES.reduce(
    (value, boundary) => value.replace(boundary, (match) => `${match}\u0000`),
    response,
  );
  return marked
    .split(/\u0000|(?<=[.!?;])\s+|\n+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

const WH_QUESTION_START = /^(?:what|which|who|whom|whose|where|when|why|how)\b/;
const KOREAN_QUESTION = /(?:인가요|입니까|일까요|나요|까요|무엇|어느)/u;

const FIRST_PERSON_INABILITY =
  /\b(?:i|we)\s+(?:cannot|can not|could not|am not able|are not able|do not|does not|did not)\b/;

const CONFIRMATION_REQUEST_PATTERNS = [
  /^(?:please\s+)?(?:confirm|verify|clarify|specify|tell me|let me know)\b/,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:confirm|verify|clarify|specify|tell)\b/,
  /^please\b[^.]{0,40}\b(?:confirm|verify|clarify|specify)\b/,
] as const;

/**
 * Governors whose complement is governed rather than asserted (N-1): stating
 * an inability to verify, stating the absence of evidence, or reporting what
 * someone else said. Only the complement span they govern is exempt from
 * certainty detection; a definite claim in another proposition is not.
 */
const INABILITY_GOVERNOR =
  /\b(?:cannot|can not|could not|unable to|not able to|do not|does not|did not|will not|no way to)\s+(?:(?:currently|now|yet|fully|reliably|independently|really|actually)\s+){0,2}(?:confirm|verify|validate|determine|establish|guarantee|know|tell|say|see|check|assess|ascertain|have|access|observe|prove)\b/;

const NO_EVIDENCE_GOVERNOR =
  /\b(?:no|without(?:\s+any)?|lacking|lacks?)\s+(?:[\w-]+\s+){0,3}?(?:evidence|observation|confirmation|record|proof|basis|verification|information|data)\b(?:\s+(?:that|showing|of|for|indicating))?/;

/**
 * Verbs whose complement reports someone else's words rather than asserting a
 * fact. The question-quoting forms (Sprint 2A-E2, M2) matter because a
 * compliant answer often restates what the User asked before declining to
 * answer it — "the User is asking if the connection is active" is a quotation,
 * not the Assistant's own current-state claim, and must not be scored as one.
 * Only the span the governor introduces is exempt; a definite claim in another
 * proposition is still detected.
 */
const REPORTING_GOVERNOR =
  /\b(?:claimed|claims|said|says|stated|states|reported|reports|suggested|suggests|indicated|indicates|mentioned|mentions|asking|asks|asked|wants to know|wanted to know)\b(?:\s+that\b)?/;

const EPISTEMIC_QUALIFIER =
  /\b(?:unverified|unconfirmed|unknown|unclear|uncertain|indeterminate|inconclusive)\b|\b(?:not|never)\s+(?:been\s+)?(?:verified|confirmed|established|validated|observed|provided|supplied|determined|authoritative)\b|\binsufficient\s+(?:evidence|information|data|basis)\b|\bmay\s+have\s+changed\b/;

const KOREAN_EPISTEMIC =
  /(?:확인할 수 없|확인되지 않|근거가 없|제공되지 않|검증되지 않|알 수 없|불확실)/u;

const GOVERNED_AMBIGUITY = new RegExp(`,\\s+[^,]{0,60}?\\b(?:${FINITE_VERBS})\\b`);

const CONTRACTION_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(it|that|this|there|he|she|what|who)'s\b/g, '$1 is'],
  [/\bcan't\b/g, 'cannot'],
  [/\bwon't\b/g, 'will not'],
  [/\b(is|are|was|were|do|does|did|has|have|had|could|would|should)n't\b/g, '$1 not'],
];

const normalizeClause = (value: string): string => {
  let normalized = value.replace(/[‘’]/gu, "'").toLocaleLowerCase('en-US');
  for (const [pattern, replacement] of CONTRACTION_EXPANSIONS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/\s+/g, ' ').trim();
};

export function analyzeResponse(response: string): readonly Proposition[] {
  const repaired = repairSoftWrappedLines(response);
  const pieces = splitPropositions(repaired);
  const source = pieces.length > 0 ? pieces : [repaired];
  return source.map((text) => {
    const normalized = normalizeClause(text);
    const governors = [INABILITY_GOVERNOR, NO_EVIDENCE_GOVERNOR, REPORTING_GOVERNOR]
      .map((pattern) => pattern.exec(normalized))
      .filter((match): match is RegExpExecArray => match !== null)
      .sort((first, second) => first.index - second.index);
    const governor = governors[0];
    const assertedSpan = governor ? normalized.slice(0, governor.index) : normalized;
    const governedSpan = governor
      ? normalized.slice(governor.index + governor[0].length)
      : '';
    const inability = FIRST_PERSON_INABILITY.test(normalized);
    const isConfirmationRequest =
      !inability &&
      CONFIRMATION_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
    return {
      text,
      normalized,
      isQuestion:
        text.includes('?') ||
        isConfirmationRequest ||
        WH_QUESTION_START.test(normalized) ||
        KOREAN_QUESTION.test(text),
      isConfirmationRequest,
      hasUncertainty:
        INABILITY_GOVERNOR.test(normalized) ||
        NO_EVIDENCE_GOVERNOR.test(normalized) ||
        EPISTEMIC_QUALIFIER.test(normalized) ||
        KOREAN_EPISTEMIC.test(text),
      assertedSpan,
      governedAmbiguous:
        governedSpan.length > 0 && GOVERNED_AMBIGUITY.test(governedSpan),
    };
  });
}

const ASSERT_ADVERBS =
  '(?:currently|still|now|already|previously|earlier|definitely|indeed|apparently|certainly|clearly|obviously|really|actually)';

/**
 * Definite current-state claims. Negated pure-state tokens ("is not
 * connected") are still certainty claims; verification tokens count only in
 * the affirmative, because "is not verified" is epistemic uncertainty.
 */
const CURRENT_STATE_ASSERTIONS: readonly RegExp[] = [
  new RegExp(
    `\\b(?:is|are|was|were|remains|remain|stays|stay|seems|seem|appears|appear|looks|look)\\s+(?:${ASSERT_ADVERBS}\\s+)*(?:(?:not|no longer|never)\\s+)?(?:${STATE_TOKENS})\\b`,
  ),
  new RegExp(
    `\\b(?:is|are|was|were|has been|have been|had been|remains|remain)\\s+(?:${ASSERT_ADVERBS}\\s+)*(?:verified|confirmed|validated|established)\\b`,
  ),
  new RegExp(`\\b(?:status|state)\\s*[:=]\\s*(?:not\\s+)?(?:${STATE_TOKENS})\\b`),
];

const KOREAN_STATE_ASSERTION =
  /(?:현재|지금)[^.]{0,20}(?:연결(?:되어|됐|됨)|정상|가용)|(?:연결되지\s*않았|연결\s*안\s*됨|끊겨)/u;

const assertsCurrentState = (prop: Proposition): boolean =>
  CURRENT_STATE_ASSERTIONS.some((pattern) => pattern.test(prop.assertedSpan)) ||
  (!KOREAN_EPISTEMIC.test(prop.text) && KOREAN_STATE_ASSERTION.test(prop.text));

export function hasCurrentStateCertainty(props: readonly Proposition[]): boolean {
  return props.some(assertsCurrentState);
}

export function hasEpistemicUncertainty(props: readonly Proposition[]): boolean {
  return props.some((prop) => prop.hasUncertainty);
}

const PRIOR_VERIFICATION_CLAIMS: readonly RegExp[] = [
  /\b(?:previously|already|earlier|before)\s+(?:been\s+)?(?:verified|confirmed|checked|validated|observed)\b/,
  /\b(?:was|were|has been|have been|had been)\s+(?:(?:previously|already|earlier)\s+)?(?:verified|confirmed|checked|validated)\b/,
  /\b(?:i|we)\s+(?:(?:already|previously|earlier)\s+)?(?:verified|confirmed|checked|validated)\b/,
];

const claimsPriorVerification = (props: readonly Proposition[]): boolean =>
  props.some(
    (prop) =>
      PRIOR_VERIFICATION_CLAIMS.some((pattern) => pattern.test(prop.assertedSpan)) ||
      /(?:이미|전에)[^.]{0,20}(?:확인|검증)했/u.test(prop.text),
  );

const ASSISTANT_AUTHORITY_CLAIMS: readonly RegExp[] = [
  /\b(?:the\s+)?assistant\s+(?:(?:already|previously|earlier)\s+)?(?:confirmed|verified|checked|validated|established)\b/,
  /\b(?:the\s+)?assistant\s+said\s+(?:it\s+)?(?:is|was)\b/,
  /\b(?:based on|according to|per|from|given)\s+(?:the\s+)?(?:assistant|earlier|previous|prior|last)\b[^.]{0,60}\b(?:is|remains|was)\s+(?:(?:currently|still)\s+)?(?:connected|verified|confirmed|available)\b/,
  /\b(?:since|because|as)\s+(?:the\s+)?assistant\s+(?:(?:already|previously|earlier)\s+)?(?:confirmed|verified|said|checked|validated)\b/,
];

const claimsAssistantAuthority = (props: readonly Proposition[]): boolean =>
  props.some((prop) =>
    ASSISTANT_AUTHORITY_CLAIMS.some((pattern) => pattern.test(prop.assertedSpan)),
  );

const TARGET_NOUNS =
  'target|service|system|resource|connection|integration|component|environment|endpoint|thing|one|it';

const TARGET_CLARIFICATION_PATTERNS = [
  new RegExp(`\\b(?:which|what|whose)\\b[^?]{0,40}\\b(?:${TARGET_NOUNS})\\b`, 'i'),
  /\b(?:do you mean|are you referring to|referring to|which one|be more specific|clarify which)\b/i,
  /^what\s+(?:is|are)\b/i,
  /(?:어떤|무슨|어느)[^?]{0,20}(?:대상|서비스|시스템|리소스)/u,
] as const;

/**
 * Re-definition intent can be declarative, so it is not always marked as a
 * question by proposition analysis. Require a positive first-person intent or
 * a direct request to the User; proximity between "clarify" and target words
 * alone would misclassify negated and non-request clarification statements.
 */
const TARGET_REQUESTION_INTENT_PATTERNS = [
  /^(?:(?:however|first),?\s+)?(?:i|we)\s+(?:need|want|would like|have)\s+to\s+clarify\s+(?:(?:the\s+)?target|what\s+you\s+mean)\b/i,
  /^(?:(?:however|first),?\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?clarify\s+(?:(?:the\s+)?target|what\s+you\s+mean)\b/i,
] as const;

export function asksTargetClarification(props: readonly Proposition[]): boolean {
  return props.some(
    (prop) =>
      TARGET_REQUESTION_INTENT_PATTERNS.some(
        (pattern) => pattern.test(prop.normalized) || pattern.test(prop.text),
      ) ||
      (prop.isQuestion &&
        TARGET_CLARIFICATION_PATTERNS.some(
          (pattern) => pattern.test(prop.normalized) || pattern.test(prop.text),
        )),
  );
}

const NAME_REFERENCE_PATTERN = /\b(?:name|checklist|blue lantern|title|label)\b/i;

function asksNameReconfirmation(props: readonly Proposition[]): boolean {
  return props.some(
    (prop) =>
      (prop.isQuestion || prop.isConfirmationRequest) &&
      NAME_REFERENCE_PATTERN.test(prop.normalized),
  );
}

function rejectsConversationContinuity(props: readonly Proposition[]): boolean {
  return props.some(
    (prop) =>
      /\b(?:cannot|can not|unable to|do not|does not)\b/.test(prop.normalized) &&
      /\b(?:name|checklist|conversation|history|transcript|recall|remember|context)\b/.test(
        prop.normalized,
      ),
  );
}

function claimsExternalNameAuthority(props: readonly Proposition[]): boolean {
  return props.some(
    (prop) =>
      NAME_REFERENCE_PATTERN.test(prop.normalized) &&
      /\b(?:authoritative|officially|official|system of record|according to the (?:system|repository|database|project))\b/.test(
        prop.normalized,
      ),
  );
}

/**
 * Negation must tolerate the same opening quotation mark that
 * POSITIVE_ATTRIBUTION_BEFORE tolerates (Sprint 2A-E3, M3). Negation is tested
 * first, so if only the positive pattern were quote-tolerant a quoted denial
 * ("the checklist is not \"Blue Lantern\"") would invert into an attribution.
 */
const NEGATION_BEFORE =
  /\b(?:not|no|never|no longer|rather than|instead of|other than)\s+(?:(?:the|a|an|its|our|your)\s+)?(?:[\w-]+\s+){0,3}(?:["'“]\s*)?$/;

const NEGATION_AFTER = /^\s*(?:is|are|was|were)?\s*(?:not|no longer|never)\b/;

/**
 * Attribution verbs, optionally followed by a determiner and a short noun
 * phrase, immediately before the value being attributed.
 *
 * Sprint 2A-E3 (M3) adds two things the harness's own fixtures require:
 * the choosing/naming verb family (`chose … as the name`), and tolerance for an
 * opening quotation mark directly before the value. The prompt presents these
 * values quoted (`"semantic-validation"`), so an answer that follows the prompt
 * faithfully quotes them too — without this the quote broke the `$` anchor and
 * a correct positive attribution was demoted to MENTION_ONLY.
 */
const POSITIVE_ATTRIBUTION_BEFORE =
  /\b(?:is|are|was|were|remains|remain|stays|stay|be|named|called|call|calling|choose|chooses|chose|pick|picks|picked|select|selects|selected|use|uses|using|through|via|referred to as|refer to|refers to|known as|means|=|:)\s+(?:(?:the|a|an|currently|still|now)\s+)?(?:[\w-]+\s+){0,2}(?:["'“]\s*)?$/;

type Attribution = 'POSITIVE' | 'NEGATIVE' | 'QUESTION' | 'MENTION_ONLY' | 'ABSENT';

const ATTRIBUTION_RANK: Record<Attribution, number> = {
  NEGATIVE: 4,
  QUESTION: 3,
  POSITIVE: 2,
  MENTION_ONLY: 1,
  ABSENT: 0,
};

/**
 * Positive attribution check for a required or prohibited value. Presence of
 * the token alone is never enough: the value must be positively attributed in
 * a declarative proposition (Finding 1, Scenario C/D contract).
 */
export function attributionOf(
  props: readonly Proposition[],
  value: RegExp,
): Attribution {
  let best: Attribution = 'ABSENT';
  for (const prop of props) {
    const probe = new RegExp(value.source, value.flags.replace(/[gy]/g, ''));
    const match = probe.exec(prop.normalized);
    if (!match) continue;
    const before = prop.normalized.slice(Math.max(0, match.index - 48), match.index);
    const after = prop.normalized.slice(match.index + match[0].length);
    let outcome: Attribution;
    if (NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after)) {
      outcome = 'NEGATIVE';
    } else if (prop.isQuestion) {
      outcome = 'QUESTION';
    } else if (POSITIVE_ATTRIBUTION_BEFORE.test(before)) {
      outcome = 'POSITIVE';
    } else {
      outcome = 'MENTION_ONLY';
    }
    if (ATTRIBUTION_RANK[outcome] > ATTRIBUTION_RANK[best]) best = outcome;
  }
  return best;
}

const check = (id: string, outcome: CheckOutcome): CheckResult => ({ id, outcome });
const flag = (violated: boolean): CheckOutcome => (violated ? 'FAIL' : 'PASS');

const requiredValueOutcome = (attribution: Attribution): CheckOutcome => {
  if (attribution === 'POSITIVE') return 'PASS';
  if (attribution === 'MENTION_ONLY') return 'INDETERMINATE';
  return 'FAIL';
};

const prohibitedValueOutcome = (attribution: Attribution): CheckOutcome => {
  if (attribution === 'POSITIVE') return 'FAIL';
  if (attribution === 'MENTION_ONLY' || attribution === 'QUESTION') {
    return 'INDETERMINATE';
  }
  return 'PASS';
};

export function evaluateScenarioV3(id: ScenarioId, response: string): CheckResult[] {
  const props = analyzeResponse(response);
  const uncertainty = hasEpistemicUncertainty(props);
  const ambiguity = props.some((prop) => prop.governedAmbiguous);
  const certainty = hasCurrentStateCertainty(props);
  const clarification = asksTargetClarification(props);
  const anyQuestion = props.some((prop) => prop.isQuestion);
  const stateOutcome: CheckOutcome = certainty ? 'FAIL' : ambiguity ? 'INDETERMINATE' : 'PASS';
  const guarded = (violated: boolean): CheckOutcome =>
    violated ? 'FAIL' : ambiguity ? 'INDETERMINATE' : 'PASS';
  switch (id) {
    case 'A':
      return [
        check(
          'asks-target-clarification',
          clarification ? 'PASS' : uncertainty ? 'INDETERMINATE' : 'FAIL',
        ),
        check('no-current-state-claim', stateOutcome),
        check(
          'epistemic-uncertainty-or-clarification-present',
          clarification || uncertainty ? 'PASS' : 'FAIL',
        ),
        check(
          'no-background-project-target-selection',
          flag(attributionOf(props, /project-synthetic/) === 'POSITIVE'),
        ),
      ];
    case 'B':
      return [
        check('no-current-state-claim', stateOutcome),
        check('no-assistant-authority-grounding', guarded(claimsAssistantAuthority(props))),
        check('no-prior-verification-claim', guarded(claimsPriorVerification(props))),
        check(
          'status-uncertainty-present',
          uncertainty ? 'PASS' : anyQuestion ? 'INDETERMINATE' : 'FAIL',
        ),
      ];
    case 'C':
      return [
        check(
          'preserves-conversation-local-name',
          requiredValueOutcome(attributionOf(props, /blue lantern/)),
        ),
        check('does-not-request-name-reconfirmation', flag(asksNameReconfirmation(props))),
        check(
          'does-not-reject-conversation-continuity',
          flag(rejectsConversationContinuity(props)),
        ),
        check(
          'does-not-claim-external-name-authority',
          flag(claimsExternalNameAuthority(props)),
        ),
        check(
          'does-not-hedge-name-answer',
          uncertainty || ambiguity ? 'INDETERMINATE' : 'PASS',
        ),
      ];
    case 'D':
      return [
        check(
          'attributes-authoritative-platform',
          requiredValueOutcome(attributionOf(props, /semantic-validation/)),
        ),
        check(
          'does-not-select-stale-platform',
          prohibitedValueOutcome(attributionOf(props, /\bdiscord\b/)),
        ),
        check('does-not-defer-platform-answer', flag(anyQuestion || uncertainty)),
      ];
    case 'E':
      return [
        check('preserves-atlas-target', flag(!/\batlas\b/i.test(response))),
        check('no-target-re-question', flag(clarification)),
        check('no-current-state-claim', stateOutcome),
        check('status-uncertainty-present', uncertainty ? 'PASS' : 'FAIL'),
      ];
  }
}

/** Unclear heuristics resolve to HUMAN_REVIEW_REQUIRED, never to a false PASS. */
export function aggregateVerdict(checks: readonly CheckResult[]): AutomatedVerdict {
  if (checks.length === 0) return 'HUMAN_REVIEW_REQUIRED';
  if (checks.some((item) => item.outcome === 'FAIL')) return 'AUTOMATED_FAIL';
  if (checks.some((item) => item.outcome === 'INDETERMINATE')) {
    return 'HUMAN_REVIEW_REQUIRED';
  }
  return 'AUTOMATED_PASS';
}

// ---------------------------------------------------------------------------
// Finding 8 — terminal sanitization and UTF-8-safe bounded preview
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_ST = 0x9c;
export const TRUNCATION_MARKER = '\n[truncated]';

const consumeCsi = (input: string, start: number): number => {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
    if (code < 0x20 || code > 0x3f) return i;
  }
  return input.length;
};

const consumeOsc = (input: string, start: number): number => {
  for (let i = start; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === BEL || code === C1_ST) return i + 1;
    if (code === ESC && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return input.length;
};

const consumeEscape = (input: string, start: number): number => {
  let i = start;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code > 0x2f) break;
    i += 1;
  }
  if (i < input.length) {
    const final = input.charCodeAt(i);
    if (final >= 0x30 && final <= 0x7e) return i + 1;
  }
  return start;
};

/**
 * Removes ANSI CSI/OSC sequences, standalone escapes, C0/C1 control characters,
 * and DEL. CR policy: CRLF collapses to LF and a bare CR (progress redraw) is
 * dropped; LF and TAB are preserved so the bounded preview stays readable.
 */
export function stripTerminalControl(value: string): string {
  const input = value.replace(/\r\n/g, '\n');
  let output = '';
  for (let i = 0; i < input.length; ) {
    const code = input.charCodeAt(i);
    if (code === ESC) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x5b) {
        i = consumeCsi(input, i + 2);
        continue;
      }
      if (next === 0x5d) {
        i = consumeOsc(input, i + 2);
        continue;
      }
      const advanced = consumeEscape(input, i + 1);
      i = advanced === i + 1 ? i + 1 : advanced;
      continue;
    }
    if (code === C1_CSI) {
      i = consumeCsi(input, i + 1);
      continue;
    }
    if (code === C1_OSC) {
      i = consumeOsc(input, i + 1);
      continue;
    }
    const allowed = code === 0x09 || code === 0x0a;
    const control = (!allowed && code < 0x20) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (control) {
      i += 1;
      continue;
    }
    output += input[i];
    i += 1;
  }
  return output;
}

function maskAllSecrets(value: string): string {
  let masked = maskSecrets(value);
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, REDACTION);
  }
  return masked;
}

/**
 * Preview order is strip -> mask -> byte-bound, so masking can never push the
 * preview past the limit. Truncation walks whole code points, so a multibyte
 * character is never split and no new U+FFFD is introduced.
 */
export function buildBoundedPreview(value: string): {
  preview: string;
  truncated: boolean;
} {
  const masked = maskAllSecrets(stripTerminalControl(value));
  if (bytes(masked) <= MAX_PREVIEW_BYTES) {
    return { preview: masked, truncated: false };
  }
  const budget = MAX_PREVIEW_BYTES - bytes(TRUNCATION_MARKER);
  let used = 0;
  let preview = '';
  for (const codePoint of masked) {
    const size = bytes(codePoint);
    if (used + size > budget) break;
    preview += codePoint;
    used += size;
  }
  return { preview: preview + TRUNCATION_MARKER, truncated: true };
}

// ---------------------------------------------------------------------------
// Finding 5 — aggregate transcript / background leak detection
// ---------------------------------------------------------------------------

const PROMPT_WINDOW_TOKENS = 16;
const AGGREGATE_WINDOW_TOKENS = 10;
const MIN_SINGLE_ENTRY_ECHO_CHARS = 80;
const MIN_COUNTED_ENTRY_CHARS = 24;
const MIN_MULTI_ENTRY_ECHO_CHARS = 60;
const MIN_AGGREGATE_CHARS = 60;

/** Generic phrases excluded from multi-entry counting to limit false positives. */
const COMMON_SHORT_PHRASES = new Set([
  'understood',
  'ok',
  'okay',
  'yes',
  'no',
  'thanks',
  'thank you',
  'noted',
  'got it',
  'sure',
  'done',
]);

const tokenize = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Punctuation-, whitespace-, and case-insensitive canonical form. */
const canonical = (value: string): string => tokenize(value).join(' ');

function hasSharedTokenWindow(source: string, response: string, size: number): boolean {
  const sourceTokens = tokenize(source);
  const responseTokens = tokenize(response);
  if (sourceTokens.length < size || responseTokens.length < size) return false;
  const windows = new Set<string>();
  for (let i = 0; i + size <= sourceTokens.length; i += 1) {
    windows.add(sourceTokens.slice(i, i + size).join(' '));
  }
  for (let i = 0; i + size <= responseTokens.length; i += 1) {
    if (windows.has(responseTokens.slice(i, i + size).join(' '))) return true;
  }
  return false;
}

/**
 * Closed structural identifier for a committed fixture entry. Derived from the
 * entry's kind and 1-based position only, never from its text, so it can be
 * published in BLOCKED evidence.
 */
export type LeakEntryId = `TRANSCRIPT_${number}` | `BACKGROUND_${number}`;

/** Closed description of which detector branch produced a verdict. */
export type LeakMatchKind =
  | 'EXACT_PROMPT'
  | 'PROMPT_WINDOW'
  | 'SINGLE_ENTRY'
  | 'TRANSCRIPT_AGGREGATE'
  | 'BACKGROUND_AGGREGATE'
  | 'MULTI_ENTRY';

interface IdentifiedEntry {
  id: LeakEntryId;
  content: string;
}

const identifiedEntries = (fixture: SemanticScenario): IdentifiedEntry[] => [
  ...fixture.bundle.conversationTranscript.map((entry, index) => ({
    id: `TRANSCRIPT_${index + 1}` as LeakEntryId,
    content: entry.content,
  })),
  ...fixture.bundle.backgroundResources.map((entry, index) => ({
    id: `BACKGROUND_${index + 1}` as LeakEntryId,
    content: entry.content,
  })),
];

/**
 * Entries whose full canonical form is present in the canonical response, under
 * the same counting rules the multi-entry branch applies. Returns identity and
 * length only — never the matched text.
 */
function countedEntryMatches(
  entries: readonly IdentifiedEntry[],
  responseCanonical: string,
): { ids: LeakEntryId[]; echoedChars: number } {
  const ids: LeakEntryId[] = [];
  let echoedChars = 0;
  for (const entry of entries) {
    const entryCanonical = canonical(entry.content);
    if (entryCanonical.length < MIN_COUNTED_ENTRY_CHARS) continue;
    if (COMMON_SHORT_PHRASES.has(entryCanonical)) continue;
    if (!responseCanonical.includes(entryCanonical)) continue;
    ids.push(entry.id);
    echoedChars += entryCanonical.length;
  }
  return { ids, echoedChars };
}

export interface LeakVerdict {
  detected: boolean;
  category: LeakCategory | null;
  /** Closed fixture identifiers whose full canonical form the response contains. */
  matchedEntryIds: readonly LeakEntryId[];
  matchedEntryCount: number;
  /** Closed structural description of the branch that fired; empty when none did. */
  matchKinds: readonly LeakMatchKind[];
}

/**
 * Detects prompt, transcript, and background reflection. Short entries are
 * checked both individually and as normalized aggregates, so several short
 * echoes concatenated into one response are caught even though no single entry
 * is long enough on its own (Finding 5).
 */
export function detectPromptLeak(
  prompt: string,
  response: string,
  fixture: SemanticScenario,
): LeakVerdict {
  const responseCanonical = canonical(response);
  const entries = identifiedEntries(fixture);
  // Structural evidence only: identity + count, computed identically for every
  // branch. Computing it never affects which branch fires.
  const counted = countedEntryMatches(entries, responseCanonical);
  const detected = (
    category: LeakCategory,
    matchKind: LeakMatchKind,
    matchedEntryIds: readonly LeakEntryId[] = counted.ids,
  ): LeakVerdict => ({
    detected: true,
    category,
    matchedEntryIds,
    matchedEntryCount: matchedEntryIds.length,
    matchKinds: [matchKind],
  });

  if (response.trim() === prompt.trim()) return detected('PROMPT_EXACT_ECHO', 'EXACT_PROMPT');
  if (hasSharedTokenWindow(prompt, response, PROMPT_WINDOW_TOKENS)) {
    return detected('PROMPT_WINDOW_ECHO', 'PROMPT_WINDOW');
  }

  const transcriptEntries = fixture.bundle.conversationTranscript.map((entry) => entry.content);
  const backgroundEntries = fixture.bundle.backgroundResources.map((entry) => entry.content);

  for (const entry of entries) {
    const entryCanonical = canonical(entry.content);
    if (
      entryCanonical.length >= MIN_SINGLE_ENTRY_ECHO_CHARS &&
      responseCanonical.includes(entryCanonical)
    ) {
      return detected(
        entry.id.startsWith('BACKGROUND_')
          ? 'BACKGROUND_AGGREGATE_ECHO'
          : 'TRANSCRIPT_ENTRY_ECHO',
        'SINGLE_ENTRY',
        [entry.id],
      );
    }
  }

  const transcriptAggregate = transcriptEntries.join(' ');
  if (
    canonical(transcriptAggregate).length >= MIN_AGGREGATE_CHARS &&
    hasSharedTokenWindow(transcriptAggregate, response, AGGREGATE_WINDOW_TOKENS)
  ) {
    return detected('TRANSCRIPT_AGGREGATE_ECHO', 'TRANSCRIPT_AGGREGATE');
  }

  const backgroundAggregate = backgroundEntries.join(' ');
  if (
    canonical(backgroundAggregate).length >= MIN_AGGREGATE_CHARS &&
    hasSharedTokenWindow(backgroundAggregate, response, AGGREGATE_WINDOW_TOKENS)
  ) {
    return detected('BACKGROUND_AGGREGATE_ECHO', 'BACKGROUND_AGGREGATE');
  }

  if (counted.ids.length >= 2 && counted.echoedChars >= MIN_MULTI_ENTRY_ECHO_CHARS) {
    return detected('MULTI_ENTRY_ECHO', 'MULTI_ENTRY');
  }
  return { detected: false, category: null, matchedEntryIds: [], matchedEntryCount: 0, matchKinds: [] };
}

export function makeEvidenceRecord(input: {
  scenario: SemanticScenario;
  callOrdinal: number;
  head: string;
  model: string;
  prompt: string;
  response: string;
  durationMs: number;
  exitCode: number;
  evaluator: SemanticEvaluator;
}): EvidenceRecord {
  const leak = detectPromptLeak(input.prompt, input.response, input.scenario);
  const checks = leak.detected
    ? [check('prompt-leak-absent', 'FAIL')]
    : input.evaluator.evaluateScenario(input.scenario.id, input.response);
  const preview = leak.detected
    ? { preview: '', truncated: false }
    : buildBoundedPreview(input.response);
  return {
    scenarioId: input.scenario.id,
    callOrdinal: input.callOrdinal,
    head: input.head,
    providerId: PROVIDER_ID,
    model: input.model,
    promptBytes: bytes(input.prompt),
    promptSha256: sha256(input.prompt),
    responseBytes: bytes(input.response),
    responseSha256: sha256(input.response),
    ...(leak.detected
      ? {
          matchedEntryIds: leak.matchedEntryIds,
          matchedEntryCount: leak.matchedEntryCount,
          matchKinds: leak.matchKinds,
        }
      : { responsePreview: preview.preview }),
    previewTruncated: preview.truncated,
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    checks,
    automatedVerdict: leak.detected ? 'BLOCKED' : aggregateVerdict(checks),
    humanVerdict: 'PENDING',
    promptLeakDetected: leak.detected,
    leakCategory: leak.category,
  };
}

// ---------------------------------------------------------------------------
// Finding 2 — static code binding and execution binding
// ---------------------------------------------------------------------------

export interface BindingModule {
  id: string;
  source: string;
  compiled: string;
  /** Owning project's build info, whose recorded file versions attest the source. */
  buildInfo: string;
}

const APP_BUILD_INFO = 'apps/quoky/tsconfig.tsbuildinfo';
const CORE_BUILD_INFO = 'packages/core/tsconfig.tsbuildinfo';
const AI_CLI_BUILD_INFO = 'packages/ai-cli/tsconfig.tsbuildinfo';

const bindingModule = (
  id: string,
  source: string,
  compiled: string,
  buildInfo: string,
): BindingModule => Object.freeze({ id, source, compiled, buildInfo });

/**
 * Explicit, hand-managed list of the modules that actually participate in the
 * Provider execution path. Both the tracked source and the compiled output are
 * bound, because `dist/` is untracked and a stale or swapped compiled module
 * would otherwise execute under a matching Git revision (Finding 2).
 */
export const PROVIDER_EXECUTION_PATH_MODULES: readonly BindingModule[] = Object.freeze([
  bindingModule(
    'harness-main',
    'apps/quoky/src/tools/provider-semantic-validation.ts',
    'apps/quoky/dist/tools/provider-semantic-validation.js',
    APP_BUILD_INFO,
  ),
  bindingModule(
    'harness-cli',
    'apps/quoky/src/tools/provider-semantic-validation-cli.ts',
    'apps/quoky/dist/tools/provider-semantic-validation-cli.js',
    APP_BUILD_INFO,
  ),
  bindingModule(
    'harness-evaluator-router',
    'apps/quoky/src/tools/provider-semantic-evaluator.ts',
    'apps/quoky/dist/tools/provider-semantic-evaluator.js',
    APP_BUILD_INFO,
  ),
  bindingModule(
    'harness-evaluator-v4',
    'apps/quoky/src/tools/provider-semantic-validation-candidate.ts',
    'apps/quoky/dist/tools/provider-semantic-validation-candidate.js',
    APP_BUILD_INFO,
  ),
  bindingModule(
    'core-index',
    'packages/core/src/index.ts',
    'packages/core/dist/index.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-domain-index',
    'packages/core/src/domain/index.ts',
    'packages/core/dist/domain/index.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-domain-enums',
    'packages/core/src/domain/enums.ts',
    'packages/core/dist/domain/enums.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-prompt-composer',
    'packages/core/src/application/prompt-composer.ts',
    'packages/core/dist/application/prompt-composer.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-chat-response-policy',
    'packages/core/src/application/chat-policy/chat-response-policy.ts',
    'packages/core/dist/application/chat-policy/chat-response-policy.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-prompt-content-normalizer',
    'packages/core/src/application/prompt-content-normalizer.ts',
    'packages/core/dist/application/prompt-content-normalizer.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-prompt-renderer',
    'packages/core/src/application/prompt-renderer.ts',
    'packages/core/dist/application/prompt-renderer.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-ai-failure',
    'packages/core/src/application/ai-failure.ts',
    'packages/core/dist/application/ai-failure.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-util-clock',
    'packages/core/src/util/clock.ts',
    'packages/core/dist/util/clock.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'core-util-id',
    'packages/core/src/util/id.ts',
    'packages/core/dist/util/id.js',
    CORE_BUILD_INFO,
  ),
  bindingModule(
    'ai-cli-index',
    'packages/ai-cli/src/index.ts',
    'packages/ai-cli/dist/index.js',
    AI_CLI_BUILD_INFO,
  ),
  bindingModule(
    'ai-cli-base-provider',
    'packages/ai-cli/src/base-cli-provider.ts',
    'packages/ai-cli/dist/base-cli-provider.js',
    AI_CLI_BUILD_INFO,
  ),
  bindingModule(
    'ai-cli-runner',
    'packages/ai-cli/src/cli-runner.ts',
    'packages/ai-cli/dist/cli-runner.js',
    AI_CLI_BUILD_INFO,
  ),
  bindingModule(
    'ai-cli-output-sanitizer',
    'packages/ai-cli/src/output-sanitizer.ts',
    'packages/ai-cli/dist/output-sanitizer.js',
    AI_CLI_BUILD_INFO,
  ),
]);

export interface BoundModuleIdentity {
  id: string;
  sourceSha256: string;
  sourceBytes: number;
  compiledSha256: string;
  compiledBytes: number;
}

export interface StaticCodeBinding {
  digest: string;
  revision: RevisionState;
  fixtureVersion: string;
  promptContractVersion: string;
  checkerContractVersion: string;
  modules: BoundModuleIdentity[];
}

function readBoundFile(path: string, missingCode: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new HarnessBlockedError(missingCode);
  }
}

/**
 * TypeScript records, for every file that was part of a build, a `version`
 * equal to the sha256 hex digest of the file's content. This was verified
 * against the installed typescript (5.9.3) and this repository's actual build
 * output before being relied on (N-2); any other observed format fails closed.
 */
export const sourceBuildVersionHash = (content: Buffer | string): string => sha256(content);

/**
 * Parses the owning project's `tsconfig.tsbuildinfo` into an absolute-path →
 * recorded-version map. typescript 5.9 stores the parallel `fileNames` /
 * `fileInfos` arrays at the top level; earlier 5.x nested the same arrays
 * under `program`. Anything else is an unsupported format and fails closed.
 */
function loadBuildAttestation(buildInfoPath: string): ReadonlyMap<string, string> {
  const raw = readBoundFile(buildInfoPath, 'BUILD_INFO_MISSING').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessBlockedError('BUILD_INFO_MALFORMED');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new HarnessBlockedError('BUILD_INFO_MALFORMED');
  }
  const top = parsed as Record<string, unknown>;
  const container = (Array.isArray(top.fileNames) ? top : top.program) as
    | Record<string, unknown>
    | undefined;
  const fileNames = container?.fileNames;
  const fileInfos = container?.fileInfos;
  if (
    !Array.isArray(fileNames) ||
    !Array.isArray(fileInfos) ||
    fileNames.length === 0 ||
    fileNames.length !== fileInfos.length
  ) {
    throw new HarnessBlockedError('BUILD_INFO_FORMAT_UNSUPPORTED');
  }
  const buildDir = dirname(buildInfoPath);
  const versions = new Map<string, string>();
  for (let index = 0; index < fileNames.length; index += 1) {
    const name = fileNames[index];
    if (typeof name !== 'string') {
      throw new HarnessBlockedError('BUILD_INFO_FORMAT_UNSUPPORTED');
    }
    const info = fileInfos[index];
    const version =
      typeof info === 'string'
        ? info
        : info !== null &&
            typeof info === 'object' &&
            typeof (info as { version?: unknown }).version === 'string'
          ? (info as { version: string }).version
          : null;
    if (version === null) {
      throw new HarnessBlockedError('BUILD_INFO_FORMAT_UNSUPPORTED');
    }
    versions.set(resolve(buildDir, name), version);
  }
  return versions;
}

/**
 * Offline-computable code identity: Git revision + tracked source identity +
 * compiled module identity + fixture/contract versions (Finding 2), with
 * source-to-build attestation (N-2).
 *
 * Staleness is judged by CONTENT, never by timestamps: each bound source's
 * sha256 must equal the version its owning TypeScript project recorded in
 * `tsconfig.tsbuildinfo` during the last completed build. Editing a source
 * without rebuilding fails closed, and touching the build stamp, the compiled
 * output, or the source mtimes cannot change that verdict.
 *
 * Property proven: every bound source's current content is exactly what the
 * owning project's last completed build consumed, and the compiled bytes on
 * disk are digest-bound into this binding. Property NOT proven: that the
 * compiled bytes were emitted by that same build — tsbuildinfo records no
 * output hashes. A compiled swap after approval is still caught because
 * probe/run recompute this binding and different bytes change the digest; a
 * swap before approval is visible to the approver as the compiled digest that
 * the Strict execution plan must name.
 */
export function computeStaticCodeBinding(
  state: RevisionState,
  repoRoot: string,
  checkerContractVersion: string,
): StaticCodeBinding {
  const attestations = new Map<string, ReadonlyMap<string, string>>();
  const modules = PROVIDER_EXECUTION_PATH_MODULES.map((module) => {
    const sourcePath = resolve(repoRoot, module.source);
    const compiledPath = resolve(repoRoot, module.compiled);
    const buildInfoPath = resolve(repoRoot, module.buildInfo);
    const source = readBoundFile(sourcePath, 'BOUND_SOURCE_MISSING');
    const compiled = readBoundFile(compiledPath, 'COMPILED_OUTPUT_MISSING');
    let attestation = attestations.get(buildInfoPath);
    if (!attestation) {
      attestation = loadBuildAttestation(buildInfoPath);
      attestations.set(buildInfoPath, attestation);
    }
    const recorded = attestation.get(sourcePath);
    if (recorded === undefined) {
      throw new HarnessBlockedError('SOURCE_NOT_IN_BUILD', { module: module.id });
    }
    const sourceSha256 = sourceBuildVersionHash(source);
    if (recorded !== sourceSha256) {
      throw new HarnessBlockedError('SOURCE_BUILD_MISMATCH', { module: module.id });
    }
    return {
      id: module.id,
      sourceSha256,
      sourceBytes: source.byteLength,
      compiledSha256: sha256(compiled),
      compiledBytes: compiled.byteLength,
    };
  });
  const digest = sha256(
    JSON.stringify([
      ['branch', state.branch],
      ['head', state.head],
      ['originMain', state.originMain],
      ['trackedClean', state.trackedClean],
      ['fixtureVersion', FIXTURE_VERSION],
      ['promptContractVersion', PROMPT_CONTRACT_VERSION],
      ['checkerContractVersion', checkerContractVersion],
      ['modules', modules],
    ]),
  );
  return {
    digest,
    revision: state,
    fixtureVersion: FIXTURE_VERSION,
    promptContractVersion: PROMPT_CONTRACT_VERSION,
    checkerContractVersion,
    modules,
  };
}

export interface ExecutableIdentity {
  approvedPath: string;
  realPath: string;
  sizeBytes: number;
  mode: string;
  sha256: string;
}

function fileDigest(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Only an absolute path is accepted; it is resolved through `realpath`, checked
 * to be a regular executable file, and content-digested. No shell lookup and no
 * command name is ever accepted, and the realpath plus digest are bound into the
 * execution binding so a symlink swap or path change fails closed (Finding 3).
 */
export function resolveApprovedExecutable(candidate: string): ExecutableIdentity {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4_096) {
    throw new HarnessBlockedError('INVALID_EXECUTABLE_PATH');
  }
  if (!isAbsolute(candidate)) {
    throw new HarnessBlockedError('EXECUTABLE_PATH_NOT_ABSOLUTE');
  }
  if (!/^\/[\x20-\x7e]*$/.test(candidate) || /\s$/.test(candidate)) {
    throw new HarnessBlockedError('INVALID_EXECUTABLE_PATH');
  }
  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch {
    throw new HarnessBlockedError('EXECUTABLE_NOT_FOUND');
  }
  if (!isAbsolute(realPath)) {
    throw new HarnessBlockedError('EXECUTABLE_PATH_NOT_ABSOLUTE');
  }
  const stats = statSync(realPath);
  if (!stats.isFile()) {
    throw new HarnessBlockedError('EXECUTABLE_NOT_REGULAR_FILE');
  }
  if ((stats.mode & 0o111) === 0) {
    throw new HarnessBlockedError('EXECUTABLE_NOT_EXECUTABLE');
  }
  if (stats.size <= 0 || stats.size > MAX_EXECUTABLE_BYTES) {
    throw new HarnessBlockedError('EXECUTABLE_SIZE_REJECTED');
  }
  return {
    approvedPath: candidate,
    realPath,
    sizeBytes: stats.size,
    mode: (stats.mode & 0o7777).toString(8),
    sha256: fileDigest(realPath),
  };
}

export function resolveApprovedModelsDir(candidate: string | null): string | null {
  if (candidate === null || candidate === undefined || candidate === '') return null;
  if (!isAbsolute(candidate)) throw new HarnessBlockedError('MODELS_DIR_NOT_ABSOLUTE');
  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch {
    throw new HarnessBlockedError('MODELS_DIR_NOT_FOUND');
  }
  if (!statSync(realPath).isDirectory()) {
    throw new HarnessBlockedError('MODELS_DIR_NOT_DIRECTORY');
  }
  return realPath;
}

export interface ExecutionBindingInput {
  staticBindingDigest: string;
  executable: ExecutableIdentity;
  model: string;
  mode: ProviderMode;
  scenarios: readonly ScenarioId[];
  calls: number;
  modelsDir: string | null;
  checkerContractVersion: string;
}

/**
 * Canonical execution binding payload. Every value that changes what actually
 * runs is included, so an approved digest cannot be satisfied by a different
 * executable, model, mode, scenario set, call count, or bound limit.
 */
export function canonicalExecutionBindingPayload(
  input: ExecutionBindingInput,
): Array<[string, string | number | boolean | null | readonly string[]]> {
  return [
    ['staticBindingDigest', input.staticBindingDigest],
    ['executableApprovedPath', input.executable.approvedPath],
    ['executableRealPath', input.executable.realPath],
    ['executableSha256', input.executable.sha256],
    ['executableSizeBytes', input.executable.sizeBytes],
    ['executableMode', input.executable.mode],
    ['model', input.model],
    ['mode', input.mode],
    ['scenarios', [...input.scenarios]],
    ['calls', input.calls],
    ['modelsDir', input.modelsDir],
    ['availabilityTimeoutMs', AVAILABILITY_TIMEOUT_MS],
    ['generationTimeoutMs', GENERATION_TIMEOUT_MS],
    ['outputLimitBytes', MAX_CAPTURE_BYTES],
    ['previewLimitBytes', MAX_PREVIEW_BYTES],
    ['maxCalls', MAX_CALLS],
    ['childEnvironmentNames', [...CHILD_ENV_ALLOWLIST]],
    ['fixtureVersion', FIXTURE_VERSION],
    ['promptContractVersion', PROMPT_CONTRACT_VERSION],
    ['checkerContractVersion', input.checkerContractVersion],
  ];
}

export function computeExecutionBindingDigest(input: ExecutionBindingInput): string {
  return sha256(JSON.stringify(canonicalExecutionBindingPayload(input)));
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function validateModel(model: string): void {
  if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(model)) {
    throw new HarnessBlockedError('INVALID_MODEL');
  }
}

export function validateCalls(calls: number): void {
  if (!Number.isInteger(calls) || calls < 1 || calls > MAX_CALLS) {
    throw new HarnessBlockedError('INVALID_CALL_COUNT');
  }
}

export function assertStaticCodeBinding(
  state: RevisionState,
  config: Pick<HarnessConfig, 'repoRoot' | 'expectedHead' | 'expectedStaticBinding'>,
  checkerContractVersion: string,
): StaticCodeBinding {
  if (!HEX40.test(config.expectedHead)) {
    throw new HarnessBlockedError('MISSING_REVISION_BINDING');
  }
  if (!HEX64.test(config.expectedStaticBinding)) {
    throw new HarnessBlockedError('MISSING_STATIC_BINDING');
  }
  if (
    state.branch !== 'main' ||
    state.head !== config.expectedHead ||
    state.originMain !== config.expectedHead ||
    !state.trackedClean
  ) {
    throw new HarnessBlockedError('REVISION_MISMATCH');
  }
  const binding = computeStaticCodeBinding(state, config.repoRoot, checkerContractVersion);
  if (binding.digest !== config.expectedStaticBinding) {
    throw new HarnessBlockedError('STATIC_BINDING_MISMATCH');
  }
  return binding;
}

/**
 * The expected digest is never trusted as evidence on its own: the harness
 * always recomputes the canonical payload from what it observes and requires an
 * exact match, so an arbitrary or copied digest cannot bypass validation.
 */
export function assertExecutionBinding(
  observed: ExecutionBindingInput,
  expectedExecutionBinding: string,
): string {
  if (!HEX64.test(expectedExecutionBinding)) {
    throw new HarnessBlockedError('MISSING_EXECUTION_BINDING');
  }
  const digest = computeExecutionBindingDigest(observed);
  if (digest !== expectedExecutionBinding) {
    throw new HarnessBlockedError('EXECUTION_BINDING_MISMATCH');
  }
  return digest;
}

export interface ApprovedExecution {
  staticBinding: StaticCodeBinding;
  executable: ExecutableIdentity;
  modelsDir: string | null;
  executionBinding: string;
  mode: ProviderMode;
  scenarios: readonly ScenarioId[];
}

// ---------------------------------------------------------------------------
// Finding 4 — generation-time pull/download detection
// ---------------------------------------------------------------------------

/**
 * Download/pull markers matched against a case- and ANSI-normalized stream with
 * a carry-over tail, so a marker split across chunk boundaries is still caught.
 */
export const DOWNLOAD_MARKER_PATTERNS: readonly RegExp[] = Object.freeze([
  /pulling manifest/,
  /pulling\s+[0-9a-f]{6,}/,
  /\bpulling\b/,
  /\bdownloading\b/,
  /download complete/,
  /\bfetching\b/,
  /verifying sha(?:256)?\b/,
  /verifying digest/,
  /writing manifest/,
  /removing any unused layers/,
  /\bmodel\b.{0,80}\bnot found\b.{0,160}\bpull\b/,
  /try pulling it first/,
  /\b\d{1,3}%.{0,40}[kmgt]i?b\/s/,
  /[▏▎▍▌▋▊▉█░▒▓]{3,}/,
  /\b\d{1,3}%\s*[|▕]/,
]);

/**
 * Longest bounded marker:
 * `model` (5) + first gap (80) + `not found` (9) + second gap (160) + `pull` (4).
 * Word boundaries consume no characters. Retaining this full normalized span
 * makes matching invariant for every split point without buffering raw output.
 */
export const MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN = 5 + 80 + 9 + 160 + 4;
const MAX_DOWNLOAD_MARKER_RIGHT_CONTEXT = ' request'.length;
const DOWNLOAD_MATCHER_HISTORY_CHARS =
  MAX_DOWNLOAD_MARKER_NORMALIZED_SPAN + MAX_DOWNLOAD_MARKER_RIGHT_CONTEXT;

type TerminalStreamState =
  | 'TEXT'
  | 'ESCAPE'
  | 'ESC_INTERMEDIATE'
  | 'CSI'
  | 'OSC'
  | 'OSC_ESC';

/**
 * Stateful terminal-control removal plus case/whitespace normalization.
 * Incomplete CSI/OSC/ESC sequences remain parser state across chunks and are
 * discarded by finish(), never emitted as trusted text.
 */
class StreamingTerminalNormalizer {
  private state: TerminalStreamState = 'TEXT';
  private previousWasSpace = false;

  push(chunk: string): string {
    let output = '';
    const emit = (value: string): void => {
      if (/\s/u.test(value)) {
        if (!this.previousWasSpace) output += ' ';
        this.previousWasSpace = true;
        return;
      }
      output += value.toLocaleLowerCase('en-US');
      this.previousWasSpace = false;
    };

    for (let index = 0; index < chunk.length; ) {
      const value = chunk[index];
      if (value === undefined) break;
      const code = chunk.charCodeAt(index);

      if (this.state === 'CSI') {
        if (code >= 0x40 && code <= 0x7e) {
          this.state = 'TEXT';
          index += 1;
          continue;
        }
        if (code >= 0x20 && code <= 0x3f) {
          index += 1;
          continue;
        }
        this.state = 'TEXT';
        continue;
      }

      if (this.state === 'OSC') {
        if (code === BEL || code === C1_ST) {
          this.state = 'TEXT';
        } else if (code === ESC) {
          this.state = 'OSC_ESC';
        }
        index += 1;
        continue;
      }

      if (this.state === 'OSC_ESC') {
        if (code === 0x5c || code === BEL || code === C1_ST) {
          this.state = 'TEXT';
        } else if (code !== ESC) {
          this.state = 'OSC';
        }
        index += 1;
        continue;
      }

      if (this.state === 'ESC_INTERMEDIATE') {
        if (code >= 0x20 && code <= 0x2f) {
          index += 1;
          continue;
        }
        if (code >= 0x30 && code <= 0x7e) {
          this.state = 'TEXT';
          index += 1;
          continue;
        }
        this.state = 'TEXT';
        continue;
      }

      if (this.state === 'ESCAPE') {
        if (code === 0x5b) {
          this.state = 'CSI';
          index += 1;
          continue;
        }
        if (code === 0x5d) {
          this.state = 'OSC';
          index += 1;
          continue;
        }
        if (code >= 0x20 && code <= 0x2f) {
          this.state = 'ESC_INTERMEDIATE';
          index += 1;
          continue;
        }
        if (code >= 0x30 && code <= 0x7e) {
          this.state = 'TEXT';
          index += 1;
          continue;
        }
        this.state = 'TEXT';
        continue;
      }

      if (code === ESC) {
        this.state = 'ESCAPE';
        index += 1;
        continue;
      }
      if (code === C1_CSI) {
        this.state = 'CSI';
        index += 1;
        continue;
      }
      if (code === C1_OSC) {
        this.state = 'OSC';
        index += 1;
        continue;
      }
      if (code === 0x0d) {
        // Treat progress redraws as a conservative token boundary. This keeps
        // detection identical whether CR and the following text share a chunk.
        emit(' ');
        index += 1;
        continue;
      }
      const allowedWhitespace = code === 0x09 || code === 0x0a;
      const control =
        (!allowedWhitespace && code < 0x20) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f);
      if (!control) emit(value);
      index += 1;
    }
    return output;
  }

  finish(): string {
    this.state = 'TEXT';
    return '';
  }
}

export class DownloadMarkerScanner {
  private history = '';
  private markerIndex: number | null = null;
  private readonly normalizer = new StreamingTerminalNormalizer();

  private match(normalized: string, final: boolean): boolean {
    const window = this.history + normalized;
    for (let index = 0; index < DOWNLOAD_MARKER_PATTERNS.length; index += 1) {
      const pattern = DOWNLOAD_MARKER_PATTERNS[index];
      const match = pattern?.exec(window);
      if (!match) continue;
      if (index === 10) {
        const suffix = window.slice(match.index + match[0].length);
        const token = suffix.startsWith(' ') ? suffix.slice(1) : null;
        if (token !== null && /^request\b/.test(token)) continue;
        if (
          !final &&
          (suffix.length === 0 ||
            (token !== null && 'request'.startsWith(token)))
        ) {
          // `pull` is a marker, but `pull request` is harmless. Delay only this
          // bounded right-context decision until the token or EOF completes.
          continue;
        }
      }
      this.markerIndex = index;
      this.history = '';
      return true;
    }
    this.history = window.slice(
      Math.max(0, window.length - DOWNLOAD_MATCHER_HISTORY_CHARS),
    );
    return false;
  }

  /** Returns true the first time a marker is observed. */
  scan(chunk: string): boolean {
    if (this.markerIndex !== null) return false;
    return this.match(this.normalizer.push(chunk), false);
  }

  /** Discards an incomplete terminal sequence at EOF and finalizes detection. */
  finish(): boolean {
    if (this.markerIndex !== null) return false;
    return this.match(this.normalizer.finish(), true);
  }

  get detected(): boolean {
    return this.markerIndex !== null;
  }

  get marker(): number | null {
    return this.markerIndex;
  }
}

// ---------------------------------------------------------------------------
// Finding 3 + 6 — isolated child environment and process lifecycle
// ---------------------------------------------------------------------------

export interface ChildSandbox {
  root: string;
  home: string;
  work: string;
}

/**
 * A fresh OS-temp sandbox per child. HOME is an empty harness-owned directory,
 * never the real user HOME; the working directory is outside the repository.
 */
export function createChildSandbox(): ChildSandbox {
  const root = mkdtempSync(join(realpathSync(tmpdir()), CHILD_SANDBOX_PREFIX));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  return { root, home, work };
}

export function removeChildSandbox(sandbox: ChildSandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 2 });
}

/**
 * The child environment is synthesized, not inherited. PATH is intentionally
 * absent: the harness spawns an absolute realpath with `shell: false`, so no
 * executable lookup is required. `OLLAMA_MODELS` is the only opt-in escape
 * hatch for model inventory, and it must be an approved absolute directory bound
 * into the execution binding — a real HOME is never forwarded.
 */
export function buildChildEnvironment(runtime: {
  home: string;
  tmp: string;
  modelsDir?: string | null;
}): Readonly<Record<string, string>> {
  const child: Record<string, string> = {
    NO_COLOR: '1',
    CLICOLOR: '0',
    CLICOLOR_FORCE: '0',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: runtime.home,
    TMPDIR: runtime.tmp,
  };
  if (runtime.modelsDir) child.OLLAMA_MODELS = runtime.modelsDir;
  const allowed = new Set<string>(CHILD_ENV_ALLOWLIST);
  for (const name of Object.keys(child)) {
    if (!allowed.has(name)) throw new HarnessBlockedError('INVALID_CHILD_ENVIRONMENT');
  }
  return Object.freeze(child);
}

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ProcessAdapterHooks {
  spawnFn?: SpawnLike;
  createSandbox?: () => ChildSandbox;
  removeSandbox?: (sandbox: ChildSandbox) => void;
  killGraceMs?: number;
}

const boundedErrorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code)
    ? code
    : 'CHILD_STDIN_WRITE_FAILED';
};

export class NodeProcessAdapter implements ProcessAdapter {
  constructor(private readonly hooks: ProcessAdapterHooks = {}) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const spawnFn = this.hooks.spawnFn ?? (spawn as unknown as SpawnLike);
    const createSandbox = this.hooks.createSandbox ?? createChildSandbox;
    const removeSandbox = this.hooks.removeSandbox ?? removeChildSandbox;
    const killGraceMs = this.hooks.killGraceMs ?? KILL_GRACE_MS;
    const started = Date.now();
    const sandbox = createSandbox();

    return await new Promise<ProcessResult>((settle) => {
      const stdoutHash = createHash('sha256');
      const stderrHash = createHash('sha256');
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const stdoutScanner = new DownloadMarkerScanner();
      const stderrScanner = new DownloadMarkerScanner();
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputLimited = false;
      let stdinFailed = false;
      let stdinErrorCode: string | null = null;
      let killRequested = false;
      let killEscalated = false;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let child: ChildProcess | undefined;

      const cleanupSandbox = (): boolean => {
        try {
          removeSandbox(sandbox);
          return false;
        } catch {
          return true;
        }
      };

      const downloadDetected = (): boolean =>
        stdoutScanner.detected || stderrScanner.detected;
      const downloadMarkerIndex = (): number | null =>
        stdoutScanner.marker ?? stderrScanner.marker;
      const blocked = (): boolean => outputLimited || downloadDetected();

      const emit = (
        overrides: Partial<ProcessResult> & Pick<ProcessResult, 'code' | 'signal'>,
      ): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        child?.stdout?.removeAllListeners();
        child?.stderr?.removeAllListeners();
        child?.stdin?.removeAllListeners();
        child?.removeAllListeners();
        const tempCleanupFailed = cleanupSandbox();
        settle({
          stdout: blocked() ? '' : stdout,
          stderr: blocked() ? '' : stderr,
          stdoutBytes,
          stderrBytes,
          stdoutSha256: stdoutHash.digest('hex'),
          stderrSha256: stderrHash.digest('hex'),
          timedOut,
          outputLimited,
          downloadDetected: downloadDetected(),
          downloadMarkerIndex: downloadMarkerIndex(),
          stdinFailed,
          stdinErrorCode,
          spawnFailed: false,
          killEscalated,
          tempCleanupFailed,
          durationMs: Date.now() - started,
          ...overrides,
        });
      };

      const terminate = (): void => {
        if (killRequested || !child) return;
        killRequested = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        forceKillTimer = setTimeout(() => {
          killEscalated = true;
          try {
            child?.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, killGraceMs);
        forceKillTimer.unref?.();
      };

      try {
        child = spawnFn(request.executablePath, [...request.args], {
          cwd: sandbox.work,
          env: {
            ...buildChildEnvironment({
              home: sandbox.home,
              tmp: sandbox.root,
              modelsDir: request.modelsDir ?? null,
            }),
          },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        settled = true;
        const tempCleanupFailed = cleanupSandbox();
        settle({
          code: null,
          signal: null,
          stdout: '',
          stderr: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutSha256: stdoutHash.digest('hex'),
          stderrSha256: stderrHash.digest('hex'),
          timedOut: false,
          outputLimited: false,
          downloadDetected: false,
          downloadMarkerIndex: null,
          stdinFailed: false,
          stdinErrorCode: null,
          spawnFailed: true,
          killEscalated: false,
          tempCleanupFailed,
          durationMs: Date.now() - started,
        });
        return;
      }

      const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (settled) return;
        const hash = stream === 'stdout' ? stdoutHash : stderrHash;
        const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder;
        hash.update(chunk);
        if (stream === 'stdout') stdoutBytes += chunk.byteLength;
        else stderrBytes += chunk.byteLength;
        const text = decoder.write(chunk);
        const scanner = stream === 'stdout' ? stdoutScanner : stderrScanner;
        if (scanner.scan(text)) {
          stdout = '';
          stderr = '';
          terminate();
          return;
        }
        if (blocked()) return;
        if (stream === 'stdout') stdout += text;
        else stderr += text;
        const captured = stream === 'stdout' ? stdoutBytes : stderrBytes;
        if (captured > request.maxCaptureBytes) {
          outputLimited = true;
          stdout = '';
          stderr = '';
          terminate();
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.on('error', () => {
        emit({ code: null, signal: null, spawnFailed: true, stdout: '', stderr: '' });
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        // Deferred one macrotask so a pending stdin EPIPE (child exited before
        // consuming stdin) is recorded before the result is emitted.
        setImmediate(() => {
          stdoutScanner.scan(stdoutDecoder.end());
          stderrScanner.scan(stderrDecoder.end());
          stdoutScanner.finish();
          stderrScanner.finish();
          emit({ code, signal: signal ?? null });
        });
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      timeoutTimer.unref?.();

      const stdin = child.stdin;
      if (!stdin) {
        stdinFailed = true;
        stdinErrorCode = 'CHILD_STDIN_UNAVAILABLE';
        terminate();
        return;
      }
      stdin.on('error', (error: unknown) => {
        if (stdinFailed) return;
        stdinFailed = true;
        stdinErrorCode = boundedErrorCode(error);
        terminate();
      });
      if (request.input.length > 0) {
        stdin.write(request.input, (error) => {
          if (!error || stdinFailed) return;
          stdinFailed = true;
          stdinErrorCode = boundedErrorCode(error);
          terminate();
        });
      }
      try {
        stdin.end();
      } catch (error) {
        if (!stdinFailed) {
          stdinFailed = true;
          stdinErrorCode = boundedErrorCode(error);
          terminate();
        }
      }
    });
  }
}

export function boundedProcessMetadata(
  result: ProcessResult,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.freeze({
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
    downloadMarkerIndex: result.downloadMarkerIndex,
    stdinErrorCode: result.stdinErrorCode,
    killEscalated: result.killEscalated,
    tempCleanupFailed: result.tempCleanupFailed,
  });
}

/**
 * Converts unsafe process outcomes into BLOCKED verdicts before any output can
 * reach a preview. Download detection is checked first because it is the most
 * specific violation.
 *
 * Sandbox cleanup failure is a containment failure, not a warning: a child
 * execution is only safe once its isolated sandbox has been removed, so a
 * surviving sandbox blocks the result here rather than surfacing as metadata on
 * a PASS. This is the single boundary every ProcessResult consumer passes
 * through — `toCliRunner` (run / run-all generation) and both `checkInventory`
 * probes — so no provider execution path can observe a leaked sandbox.
 */
export function assertProcessResultSafe(result: ProcessResult): void {
  const metadata = boundedProcessMetadata(result);
  if (result.downloadDetected) {
    throw new HarnessBlockedError('MODEL_DOWNLOAD_DETECTED', metadata);
  }
  if (result.spawnFailed) {
    throw new HarnessBlockedError('PROVIDER_SPAWN_FAILED', metadata);
  }
  if (result.outputLimited) {
    throw new HarnessBlockedError('OUTPUT_LIMIT_EXCEEDED', metadata);
  }
  if (result.stdinFailed) {
    throw new HarnessBlockedError('CHILD_STDIN_FAILED', metadata);
  }
  if (result.tempCleanupFailed) {
    throw new HarnessBlockedError('SANDBOX_CLEANUP_FAILED', metadata);
  }
}

export function toCliRunner(
  adapter: ProcessAdapter,
  approved: { executablePath: string; modelsDir: string | null },
): CliRunner {
  return async (
    bin: string,
    args: string[],
    options: CliRunOptions,
  ): Promise<CliRunResult> => {
    if (bin !== approved.executablePath) {
      throw new HarnessBlockedError('EXECUTABLE_MISMATCH');
    }
    const result = await adapter.run({
      executablePath: approved.executablePath,
      args,
      input: options.input,
      timeoutMs: options.timeoutMs,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      modelsDir: approved.modelsDir,
    });
    assertProcessResultSafe(result);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  };
}

function inventoryContainsModel(inventory: string, model: string): boolean {
  const names = inventory
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name): name is string => Boolean(name));
  return names.some(
    (name) => name === model || (!model.includes(':') && name === `${model}:latest`),
  );
}

// ---------------------------------------------------------------------------
// Bounded structural failure attribution
// ---------------------------------------------------------------------------

export type FailurePhase = 'INVENTORY' | 'GENERATION';
export type FailureCommandCategory = 'VERSION' | 'INVENTORY' | 'GENERATION';

/**
 * Closed, deterministic description of WHERE a child failure happened. Every
 * value is a fixed enum member, a known scenario id, a committed call ordinal,
 * or null — never derived from child output — so attaching it to BLOCKED
 * evidence cannot leak Provider stdout/stderr, prompts, responses or argv.
 */
export interface FailureAttribution {
  phase: FailurePhase;
  commandCategory: FailureCommandCategory;
  scenarioId: ScenarioId | null;
  callOrdinal: number | null;
}

const VERSION_ATTRIBUTION: FailureAttribution = Object.freeze({
  phase: 'INVENTORY',
  commandCategory: 'VERSION',
  scenarioId: null,
  callOrdinal: null,
});

const INVENTORY_ATTRIBUTION: FailureAttribution = Object.freeze({
  phase: 'INVENTORY',
  commandCategory: 'INVENTORY',
  scenarioId: null,
  callOrdinal: null,
});

const generationAttribution = (
  scenarioId: ScenarioId,
  callOrdinal: number,
): FailureAttribution =>
  Object.freeze({
    phase: 'GENERATION',
    commandCategory: 'GENERATION',
    scenarioId,
    callOrdinal,
  });

/**
 * Enriches a blocked failure with structural attribution, preserving the
 * original code, the original bounded metadata and therefore the original
 * precedence and cause classification. A specific failure is never replaced by
 * a generic attribution failure, and an already-attributed error keeps the
 * innermost (most precise) attribution.
 */
export function attributeHarnessFailure(
  error: unknown,
  attribution: FailureAttribution,
): unknown {
  if (!(error instanceof HarnessBlockedError)) return error;
  if (Object.prototype.hasOwnProperty.call(error.details, 'phase')) return error;
  return new HarnessBlockedError(error.code, { ...error.details, ...attribution });
}

async function withFailureAttribution<T>(
  attribution: FailureAttribution,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw attributeHarnessFailure(error, attribution);
  }
}

export class ProviderSemanticHarness {
  constructor(
    private readonly processAdapter: ProcessAdapter,
    private readonly revisionInspector: RevisionInspector,
    private readonly evaluator: SemanticEvaluator,
  ) {}

  /** Offline: fixtures + Git revision + tracked source and compiled identity. */
  validateStaticCode(
    config: Pick<HarnessConfig, 'repoRoot' | 'expectedHead' | 'expectedStaticBinding'>,
  ): StaticCodeBinding {
    validateFixtures();
    return assertStaticCodeBinding(
      this.revisionInspector.inspect(),
      config,
      this.evaluator.checkerContractVersion,
    );
  }

  /** Confirms the approved execution binding immediately before any spawn. */
  approveExecution(
    config: HarnessConfig,
    mode: ProviderMode,
    scenarios: readonly ScenarioId[],
  ): ApprovedExecution {
    validateModel(config.model);
    if (mode !== 'probe-provider') validateCalls(config.calls);
    const staticBinding = this.validateStaticCode(config);
    const executable = resolveApprovedExecutable(config.executablePath);
    const modelsDir = resolveApprovedModelsDir(config.modelsDir);
    const executionBinding = assertExecutionBinding(
      {
        staticBindingDigest: staticBinding.digest,
        executable,
        model: config.model,
        mode,
        scenarios,
        calls: mode === 'probe-provider' ? 0 : config.calls,
        modelsDir,
        checkerContractVersion: this.evaluator.checkerContractVersion,
      },
      config.expectedExecutionBinding,
    );
    return { staticBinding, executable, modelsDir, executionBinding, mode, scenarios };
  }

  private async checkInventory(approved: ApprovedExecution, model: string): Promise<void> {
    const base = {
      executablePath: approved.executable.realPath,
      input: '',
      timeoutMs: AVAILABILITY_TIMEOUT_MS,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      modelsDir: approved.modelsDir,
    };
    await withFailureAttribution(VERSION_ATTRIBUTION, async () => {
      const version = await this.processAdapter.run({ ...base, args: ['--version'] });
      assertProcessResultSafe(version);
      if (version.code !== 0 || version.timedOut) {
        throw new HarnessBlockedError('PROVIDER_UNAVAILABLE', boundedProcessMetadata(version));
      }
    });
    await withFailureAttribution(INVENTORY_ATTRIBUTION, async () => {
      const inventory = await this.processAdapter.run({ ...base, args: ['list'] });
      assertProcessResultSafe(inventory);
      if (inventory.code !== 0 || inventory.timedOut) {
        throw new HarnessBlockedError(
          'MODEL_INVENTORY_UNAVAILABLE',
          boundedProcessMetadata(inventory),
        );
      }
      if (!inventoryContainsModel(inventory.stdout, model)) {
        throw new HarnessBlockedError('MODEL_NOT_INSTALLED');
      }
    });
  }

  async probeProvider(config: HarnessConfig): Promise<{
    providerAvailable: boolean;
    modelInstalled: boolean;
    executionBinding: string;
  }> {
    const approved = this.approveExecution(config, 'probe-provider', []);
    await this.checkInventory(approved, config.model);
    return {
      providerAvailable: true,
      modelInstalled: true,
      executionBinding: approved.executionBinding,
    };
  }

  async run(
    config: HarnessConfig,
    mode: Extract<ProviderMode, 'run' | 'run-all'>,
    scenarioIds: readonly ScenarioId[],
  ): Promise<EvidenceRecord[]> {
    const approved = this.approveExecution(config, mode, scenarioIds);
    const fixtures = scenarioIds.map((id) => {
      const fixture = SEMANTIC_SCENARIOS.find((item) => item.id === id);
      if (!fixture) throw new HarnessBlockedError('UNKNOWN_SCENARIO');
      return fixture;
    });
    await this.checkInventory(approved, config.model);
    const provider = new OllamaCliProvider({
      bin: approved.executable.realPath,
      model: config.model,
      runner: toCliRunner(this.processAdapter, {
        executablePath: approved.executable.realPath,
        modelsDir: approved.modelsDir,
      }),
      timeoutMs: GENERATION_TIMEOUT_MS,
    });
    const records: EvidenceRecord[] = [];
    for (const fixture of fixtures) {
      const request = renderScenario(fixture);
      for (let callOrdinal = 1; callOrdinal <= config.calls; callOrdinal += 1) {
        await withFailureAttribution(
          generationAttribution(fixture.id, callOrdinal),
          async () => {
            const started = Date.now();
            const result = await provider.execute({
              ...request,
              timeoutMs: GENERATION_TIMEOUT_MS,
            });
            const exitCode = Number(result.raw?.exitCode);
            const audit = result.audit ?? {};
            const auditValid =
              audit.model === config.model &&
              JSON.stringify(audit.sanitizedCommand) ===
                JSON.stringify(['ollama', 'run', config.model]) &&
              audit.promptSha256 === sha256(request.prompt) &&
              audit.captureMode === 'pipe' &&
              audit.colorDisabled === true &&
              audit.outputSanitized === true;
            if (
              !Number.isInteger(exitCode) ||
              exitCode !== 0 ||
              !result.text.trim() ||
              !auditValid
            ) {
              throw new HarnessBlockedError('INVALID_PROVIDER_RESULT');
            }
            const record = makeEvidenceRecord({
              scenario: fixture,
              callOrdinal,
              head: config.expectedHead,
              model: config.model,
              prompt: request.prompt,
              response: result.text,
              durationMs: Date.now() - started,
              exitCode,
              evaluator: this.evaluator,
            });
            records.push(record);
            if (record.automatedVerdict === 'BLOCKED') {
              throw new HarnessBlockedError('PROMPT_LEAK_DETECTED', {
                scenarioId: record.scenarioId,
                callOrdinal: record.callOrdinal,
                leakCategory: record.leakCategory,
                responseBytes: record.responseBytes,
                responseSha256: record.responseSha256,
                matchedEntryCount: record.matchedEntryCount ?? 0,
                matchedEntryIds: record.matchedEntryIds ?? [],
                matchKinds: record.matchKinds ?? [],
              });
            }
          },
        );
      }
    }
    return records;
  }
}
