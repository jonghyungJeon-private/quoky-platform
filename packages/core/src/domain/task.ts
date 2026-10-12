import type { Id, IsoTimestamp, Metadata } from './common';
import type { Capability, ProviderDispatchState, RiskLevel, TaskRunStatus, TaskStatus } from './enums';
import type { Intent } from './planning';
import type { ConversationContext } from './messaging';

/**
 * A unit of work. Every request that requires work becomes a Task.
 * A Task is always anchored to a conversation context and MAY belong to a
 * Project and a resolved workspace.
 */
export interface Task {
  id: Id;
  title: string;
  description: string;
  status: TaskStatus;
  intent: Intent;
  /** Task-level risk = the Plan's overallRisk once planned. */
  riskLevel: RiskLevel;

  /** Where the request came from (channel/thread/user). Always present. */
  context: ConversationContext;
  /** The acting principal (ADR-0009). */
  actorId?: Id;
  /** The conversation session this task belongs to (ADR-0001). */
  sessionId?: Id;
  /** Optional link to a known Project. */
  projectId?: Id;
  /** The resolved working directory reference, once a workspace is prepared. */
  workspaceRefId?: Id;
  /** The current Plan, once planned. */
  planId?: Id;

  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  metadata?: Metadata;
}

/**
 * A single execution attempt of a Task. A Task may have many runs (retries,
 * re-plans, approval re-runs). The provider that served the run is recorded
 * for audit but is NOT surfaced to the user by default.
 */
export interface TaskRun {
  id: Id;
  taskId: Id;
  attempt: number;
  status: TaskRunStatus;
  dispatchState: ProviderDispatchState;
  capability: Capability;
  /** Internal audit only — e.g. "claude-cli". Never shown to the user. */
  providerId?: string;
  /** Ids of artifacts produced by this run. */
  artifactIds: Id[];
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  /** Wall-clock duration of the run in ms (minimal usage tracking, ADR-0015). */
  durationMs?: number;
  /** Failure summary (classified kind + masked technical detail) when FAILED. */
  error?: string;
  /** Optional provider-owned audit facts. Core stores but does not interpret them. */
  metadata?: Metadata;
  /**
   * The `Usage` value object (ADR-0010; ADR-0115 D8, PRV-3): the token counts the provider reported for this run, kept
   * in the run's JSON `data` (no column, no migration). Absent when the provider supplied no usage object.
   */
  usage?: RunUsageRecord;
}

/**
 * The normalised per-run usage record (ADR-0115 D8). Counts only: no prompt, reply, key or provider text.
 *
 * - `label` groups the run (`openai:gpt-5`, `claude:sonnet`, `codex`); it is what the provider reported. Core never
 *   branches on it.
 * - `reported: false` means the provider exposed no count at all ("unknown"). Counts are never estimated; a count the
 *   provider did not report is absent, never 0.
 * - `totalTokens` is the provider's own total, else `inputTokens + outputTokens` when both were reported (arithmetic on
 *   reported counts, not an estimate); otherwise absent.
 */
export interface RunUsageRecord {
  readonly label: string;
  readonly reported: boolean;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}
