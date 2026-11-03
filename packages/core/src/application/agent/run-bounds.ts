/**
 * ADR-0121 D7 (stage S2 P3-3a): the run bounds of one bounded agent run, as one pure, deterministic budget.
 *
 * The numbers are ratified, not chosen here:
 * - D7 (DECISIONS.md, "7. D7 — Bounds and the kill switch"): per run, at most 6 steps, 1 re-plan, 10 connector calls, 5 model
 *   calls, 45 s of wall time and 40k input tokens; D3: at most 3 M2 (quarantined summariser) calls;
 * - the D7 interpretation note of 2026-10-23: a "connector call" is one named port query, and the runtime ceiling is 50 HTTP
 *   requests per run (counted through the egress ledger).
 *
 * A breached bound is never an error: the first breach is recorded as a closed {@link AgentBoundKind}, the run stops
 * starting new work and ends with a deterministic partial result, with no retry (D7). Nothing here holds content: counts and
 * closed kinds only.
 */

export interface AgentRunBoundValues {
  readonly maxSteps: number;
  readonly maxReplans: number;
  readonly maxConnectorQueries: number;
  readonly maxHttpRequests: number;
  readonly maxModelCalls: number;
  readonly maxM2Calls: number;
  readonly wallMs: number;
  readonly maxInputTokens: number;
  /** D2: referenced values per run (the per-reference cap of 10 is the validator's, and is checked again at run time). */
  readonly maxRefValues: number;
}

export const AGENT_RUN_BOUNDS: AgentRunBoundValues = Object.freeze({
  maxSteps: 6,
  maxReplans: 1,
  maxConnectorQueries: 10,
  maxHttpRequests: 50,
  maxModelCalls: 5,
  maxM2Calls: 3,
  wallMs: 45_000,
  maxInputTokens: 40_000,
  maxRefValues: 10,
});

export const AGENT_BOUND_KINDS = ['steps', 'replans', 'connector-queries', 'http-requests', 'model-calls', 'm2-calls', 'wall-time', 'input-tokens', 'ref-values'] as const;
export type AgentBoundKind = (typeof AGENT_BOUND_KINDS)[number];

export type AgentModelCallKind = 'planner' | 'replan' | 'm2';

export interface AgentRunUsage {
  readonly steps: number;
  readonly replans: number;
  readonly connectorQueries: number;
  readonly httpRequests: number;
  readonly modelCalls: number;
  readonly m2Calls: number;
  readonly inputTokens: number;
  readonly refValues: number;
  readonly elapsedMs: number;
}

/**
 * One run's counters. `reserve*` methods say whether new work of that kind may START (and count it when it may): every connector query and every
 * HTTP request is reserved BEFORE it is made, so the 11th query and the 51st request never happen. The first breach wins and is sticky: once breached, every later `reserve*` is refused.
 */
export class AgentRunBudget {
  private readonly bounds: AgentRunBoundValues;
  private readonly startedAt: number;
  private firstBreach: AgentBoundKind | undefined;
  private steps = 0;
  private replans = 0;
  private connectorQueries = 0;
  private httpRequests = 0;
  private modelCalls = 0;
  private m2Calls = 0;
  private inputTokens = 0;
  private refValues = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    bounds: Partial<AgentRunBoundValues> = {},
  ) {
    this.bounds = { ...AGENT_RUN_BOUNDS, ...bounds };
    this.startedAt = clock();
  }

  /** The first breached bound, if any. */
  get breach(): AgentBoundKind | undefined {
    return this.firstBreach;
  }

  elapsedMs(): number {
    return Math.max(0, this.clock() - this.startedAt);
  }

  /** Milliseconds left of the wall (0 when spent). */
  remainingMs(): number {
    return Math.max(0, this.bounds.wallMs - this.elapsedMs());
  }

  /** Whether the wall is spent; a spent wall is a breach. */
  checkWall(): boolean {
    if (this.elapsedMs() >= this.bounds.wallMs) return this.fail('wall-time');
    return this.firstBreach === undefined;
  }

  /** Input tokens the run may still reserve (0 when spent). */
  remainingInputTokens(): number {
    return Math.max(0, this.bounds.maxInputTokens - this.inputTokens);
  }

  /** A step may start: a free step number within `maxSteps` and the wall and every earlier bound intact. */
  reserveStep(): boolean {
    if (!this.checkWall()) return false;
    if (this.steps >= this.bounds.maxSteps) return this.fail('steps');
    this.steps += 1;
    return true;
  }

  /** A connector read may start: at least one query and one HTTP request left (the wall is checked too). */
  mayReadConnector(): boolean {
    if (!this.checkWall()) return false;
    if (this.connectorQueries >= this.bounds.maxConnectorQueries) return this.fail('connector-queries');
    if (this.httpRequests >= this.bounds.maxHttpRequests) return this.fail('http-requests');
    return true;
  }

  /**
   * One named connector query may be made. Reserved BEFORE it starts (a port asks through its per-call handle), so the 11th is
   * refused and never made.
   */
  reserveQuery(): boolean {
    if (!this.checkWall()) return false;
    if (this.connectorQueries >= this.bounds.maxConnectorQueries) return this.fail('connector-queries');
    this.connectorQueries += 1;
    return true;
  }

  /** One HTTP request may be made. Reserved BEFORE it is sent: the 51st is refused and never sent (D7 interpretation note). */
  reserveHttp(): boolean {
    if (!this.checkWall()) return false;
    if (this.httpRequests >= this.bounds.maxHttpRequests) return this.fail('http-requests');
    this.httpRequests += 1;
    return true;
  }

  /** `count` referenced values may be used (a step takes all of its values or none: the 11th value is refused). */
  reserveRefValues(count: number): boolean {
    if (this.firstBreach !== undefined) return false;
    if (this.refValues + count > this.bounds.maxRefValues) return this.fail('ref-values');
    this.refValues += count;
    return true;
  }

  /** A model call (M1 planner, the one M1' re-plan, or an M2 summariser call) may start. */
  reserveModelCall(kind: AgentModelCallKind): boolean {
    if (!this.checkWall()) return false;
    if (this.modelCalls >= this.bounds.maxModelCalls) return this.fail('model-calls');
    if (kind === 'replan' && this.replans >= this.bounds.maxReplans) return this.fail('replans');
    if (kind === 'm2' && this.m2Calls >= this.bounds.maxM2Calls) return this.fail('m2-calls');
    this.modelCalls += 1;
    if (kind === 'replan') this.replans += 1;
    if (kind === 'm2') this.m2Calls += 1;
    return true;
  }

  /** Input tokens a model call is about to send. Over the bound the call must not start. */
  reserveInputTokens(tokens: number): boolean {
    if (this.firstBreach !== undefined) return false;
    if (this.inputTokens + tokens > this.bounds.maxInputTokens) return this.fail('input-tokens');
    this.inputTokens += nonNegative(tokens);
    return true;
  }

  /** The caller observed a bound breach of its own (for example a call that hit the wall). */
  markBreach(kind: AgentBoundKind): void {
    this.fail(kind);
  }

  snapshot(): AgentRunUsage {
    return {
      steps: this.steps,
      replans: this.replans,
      connectorQueries: this.connectorQueries,
      httpRequests: this.httpRequests,
      modelCalls: this.modelCalls,
      m2Calls: this.m2Calls,
      inputTokens: this.inputTokens,
      refValues: this.refValues,
      elapsedMs: this.elapsedMs(),
    };
  }

  private fail(kind: AgentBoundKind): false {
    if (this.firstBreach === undefined) this.firstBreach = kind;
    return false;
  }
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
