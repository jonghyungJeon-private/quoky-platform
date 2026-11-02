import type { Logger } from '../../ports/logger.port';
import type { NlArgs, NlWave1EntryId } from '../nl-routing/catalog';
import { AGENT_READ_SOURCES } from './flow-policy';
import { AGENT_PLAN_MAX_REF_VALUES, type ValidatedAgentPlan, type ValidatedAgentStep } from './plan-validator';
import { AGENT_RUN_BOUNDS, AgentRunBudget, type AgentBoundKind, type AgentRunBoundValues, type AgentRunUsage } from './run-bounds';
import { projectStructure, type AgentRawItem, type StructureProjection } from './structure-projector';

/**
 * ADR-0121 D1/D2/D5/D7 (stage S2 P3-3a): the deterministic executor of a VALIDATED read plan. Core, offline, and not wired:
 * no composition root builds it and no runtime dispatches to it while `QUOKY_AGENT_MODE` is `off` or `shadow` (`active` is
 * still refused in `agent-config.ts` and the `AgentRunService` constructor).
 *
 * - **Narrow injected read ports only.** The executor's dependency type is {@link AgentPlanExecutorDeps}: a map of
 *   {@link AgentReadPort}s (one `read` function each), a logger and run-bound overrides. It names no writer, repository,
 *   runner, fetch, MCP tool or other collaborator (pinned by `agent-boundary.test.ts`); an adapter-side port maps a request
 *   to the existing read-only query and returns items.
 * - **Structure only.** Every result goes through the {@link projectStructure} projector: closed-format ids, counts and the
 *   source binding. A reference step's keys come from that projection and nowhere else; no free text reaches control flow.
 * - **References are source-bound at run time too (D2/D4).** A reference step runs only when its source step is a read of the
 *   same source entry family and the same destination origin and the field is that source's projected id field. Mail,
 *   calendar and Drive ids are never offered to another connector (the validator already refuses such a plan; this is the
 *   second, run-time check). Same-source Jira to Jira is the allowed case (`items-by-key` behind the port).
 * - **Bounds (D7)** via {@link AgentRunBudget}: a breach never throws; the run stops starting work and returns a
 *   deterministic `partial` result, with no retry. Summaries (M2) are not executed here: they are `deferred` for the
 *   quarantined summariser slice.
 * - **Value-free.** One content-free log line per run (closed values and counts). A port error is mapped to a closed code;
 *   its message is never read or logged.
 */

export const AGENT_EXEC_LOG_EVENT = 'agent_run.exec';

export const AGENT_READ_ERROR_CODES = ['NOT_FOUND', 'UNAUTHORIZED', 'UNAVAILABLE', 'UNSUPPORTED', 'INVALID_RESPONSE', 'TOO_LARGE', 'RATE_LIMITED', 'UNKNOWN'] as const;
export type AgentReadErrorCode = (typeof AGENT_READ_ERROR_CODES)[number];

/** What the executor asks a read port for: one catalog read, or the detail of keys a projector took from an earlier read. */
export interface AgentReadRequest {
  readonly entryId: NlWave1EntryId;
  /** The validated, grounded args (literals only). */
  readonly args: NlArgs;
  /** A reference step only: closed-format ids of the SAME source and origin, in the order projected (1..10). */
  readonly keys?: readonly string[];
  /** Wall time left for the run, in ms; a port should give up by then. */
  readonly remainingMs: number;
}

export interface AgentReadUsage {
  /** Named port queries really made. */
  readonly connectorQueries: number;
  /** HTTP requests really made (the egress ledger's count for this call). */
  readonly httpRequests: number;
}

export type AgentReadResponse =
  | { readonly ok: true; readonly items: readonly AgentRawItem[]; readonly hasMore?: boolean; readonly truncated?: boolean; readonly usage: AgentReadUsage }
  | { readonly ok: false; readonly code: string; readonly usage: AgentReadUsage };

/** One narrow, read-only port. */
export interface AgentReadPort {
  read(request: AgentReadRequest): Promise<AgentReadResponse>;
}

/** The ports by catalog read entry; an entry with no port is `unavailable` for the run. */
export type AgentReadPorts = Readonly<Partial<Record<NlWave1EntryId, AgentReadPort>>>;

export interface AgentPlanExecutorDeps {
  readonly readers: AgentReadPorts;
  readonly logger?: Logger;
  /** Tests only: monotonic milliseconds (default `Date.now`). */
  readonly elapsed?: () => number;
  /** Tests only: other bound values. */
  readonly bounds?: Partial<AgentRunBoundValues>;
}

export type AgentStepNotRunReason = 'bound' | 'source-failed' | 'no-reader' | 'ref-cross-source' | 'ref-field' | 'ref-forward' | 'ref-empty' | 'ref-too-many';

export type AgentStepResult =
  | {
      readonly step: number;
      readonly kind: 'read';
      readonly entryId: NlWave1EntryId;
      readonly status: 'ok';
      readonly projection: StructureProjection;
      readonly hasMore: boolean;
      readonly truncated: boolean;
      /** The referenced values this step used (0 for a literal read). */
      readonly refValues: number;
    }
  | { readonly step: number; readonly kind: 'read'; readonly entryId: NlWave1EntryId; readonly status: 'failed'; readonly errorCode: AgentReadErrorCode }
  | { readonly step: number; readonly kind: 'read'; readonly entryId: NlWave1EntryId; readonly status: 'not-run'; readonly reason: AgentStepNotRunReason }
  /** M2 is not run here: the quarantined summariser slice consumes `from` and `schema`. */
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'deferred' | 'not-run'; readonly from: readonly number[]; readonly schema: string };

export interface AgentRunResult {
  /** `complete`: every read answered and no bound breached. Anything else is `partial`: the reply shows what exists. */
  readonly outcome: 'complete' | 'partial';
  /** The first breached bound, if any (a deterministic partial result, never an error). */
  readonly breach?: AgentBoundKind;
  readonly steps: readonly AgentStepResult[];
  readonly usage: AgentRunUsage;
}

type ReadStep = Extract<ValidatedAgentStep, { kind: 'read' }>;
type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;

export class AgentPlanExecutor {
  constructor(private readonly deps: AgentPlanExecutorDeps) {}

  /** Execute a validated `run` plan. Total: never throws; a bound or a port failure ends in a partial result. */
  async execute(plan: RunPlan): Promise<AgentRunResult> {
    const budget = new AgentRunBudget(this.deps.elapsed ?? Date.now, this.deps.bounds);
    const results: AgentStepResult[] = [];
    const projections = new Map<number, StructureProjection>();
    // The static charge is the validator's; a plan over the bound is never started (zero reads).
    const staticOver = plan.connectorCalls > (this.deps.bounds?.maxConnectorQueries ?? AGENT_RUN_BOUNDS.maxConnectorQueries);
    if (staticOver) budget.markBreach('connector-queries');
    // Only a `run` plan executes: a `clarify` plan is the owner's question, never a read.
    const blocked = staticOver || plan.kind !== 'run';
    for (const [index, step] of plan.steps.entries()) {
      const number = index + 1;
      if (blocked || !budget.reserveStep()) {
        results.push(notRun(step, number, 'bound'));
        continue;
      }
      if (step.kind === 'summarize') {
        results.push({ step: number, kind: 'summarize', status: 'deferred', from: step.from, schema: step.schema });
        continue;
      }
      results.push(await this.runRead(step, number, budget, results, projections));
    }
    const usage = budget.snapshot();
    const breach = budget.breach;
    const allOk = results.every((result) => result.status === 'ok' || result.status === 'deferred');
    const outcome = breach === undefined && allOk ? 'complete' : 'partial';
    this.deps.logger?.info(AGENT_EXEC_LOG_EVENT, {
      outcome,
      ...(breach !== undefined ? { breach } : {}),
      steps: results.length,
      ok: results.filter((result) => result.status === 'ok').length,
      connectorQueries: usage.connectorQueries,
      httpRequests: usage.httpRequests,
      refValues: usage.refValues,
      elapsedMs: usage.elapsedMs,
    });
    return { outcome, ...(breach !== undefined ? { breach } : {}), steps: results, usage };
  }

  private async runRead(
    step: ReadStep,
    number: number,
    budget: AgentRunBudget,
    results: readonly AgentStepResult[],
    projections: Map<number, StructureProjection>,
  ): Promise<AgentStepResult> {
    const entryId = step.entry.id as NlWave1EntryId;
    const reader = this.deps.readers[entryId];
    if (reader === undefined || !(entryId in AGENT_READ_SOURCES)) return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'no-reader' };

    let keys: readonly string[] | undefined;
    let refValues = 0;
    if (step.ref !== undefined) {
      const resolved = resolveReference(step, number, entryId, results, projections);
      if (!resolved.ok) return { step: number, kind: 'read', entryId, status: 'not-run', reason: resolved.reason };
      keys = resolved.keys;
      refValues = keys.length;
    }
    if (!budget.mayReadConnector()) return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };
    // A step takes all of its referenced values or none: the 11th value of a run is refused (a partial result).
    if (keys !== undefined && !budget.reserveRefValues(refValues)) return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };

    const response = await this.callPort(reader, { entryId, args: step.args, ...(keys !== undefined ? { keys } : {}), remainingMs: budget.remainingMs() });
    if (response === 'wall') {
      budget.markBreach('wall-time');
      return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };
    }
    budget.recordConnector(response.usage.connectorQueries, response.usage.httpRequests);
    // A call that ended after the wall is a breach, but its result is kept.
    budget.checkWall();
    if (!response.ok) return { step: number, kind: 'read', entryId, status: 'failed', errorCode: closedCode(response.code) };
    const projection = projectStructure(entryId, response.items);
    projections.set(number, projection);
    return { step: number, kind: 'read', entryId, status: 'ok', projection, hasMore: response.hasMore === true, truncated: response.truncated === true, refValues };
  }

  /** A port call that cannot outlive the wall; a throw is an `UNKNOWN` failure whose message is never read. */
  private async callPort(reader: AgentReadPort, request: AgentReadRequest): Promise<AgentReadResponse | 'wall'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wall = new Promise<'wall'>((resolve) => {
      timer = setTimeout(() => resolve('wall'), Math.max(1, request.remainingMs));
    });
    try {
      const call = Promise.resolve()
        .then(() => reader.read(request))
        .then(
          (value) => value,
          (): AgentReadResponse => ({ ok: false, code: 'UNKNOWN', usage: { connectorQueries: 1, httpRequests: 1 } }),
        );
      return await Promise.race([call, wall]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * The run-time source binding of a reference (D2/D4): a same-source, same-origin earlier read that answered, the source's own
 * projected id field, at most 10 values, the ids only from that read's projection. `at` picks the one id at that position.
 */
function resolveReference(
  step: ReadStep,
  number: number,
  entryId: NlWave1EntryId,
  results: readonly AgentStepResult[],
  projections: ReadonlyMap<number, StructureProjection>,
): { readonly ok: true; readonly keys: readonly string[] } | { readonly ok: false; readonly reason: AgentStepNotRunReason } {
  const ref = step.ref;
  if (ref === undefined) return { ok: false, reason: 'ref-field' };
  if (ref.step >= number || ref.step < 1) return { ok: false, reason: 'ref-forward' };
  const source = results[ref.step - 1];
  const projection = projections.get(ref.step);
  if (source === undefined || source.kind !== 'read' || source.status !== 'ok' || projection === undefined) return { ok: false, reason: 'source-failed' };
  const to = AGENT_READ_SOURCES[entryId];
  // Same source AND same destination origin as the projection (never another connector, never another origin).
  if (projection.source !== to.source || projection.origin !== to.origin || ref.provenance.origin !== projection.origin) return { ok: false, reason: 'ref-cross-source' };
  if (projection.field === undefined || ref.field !== projection.field) return { ok: false, reason: 'ref-field' };
  if (ref.take > AGENT_PLAN_MAX_REF_VALUES) return { ok: false, reason: 'ref-too-many' };
  const keys = ref.at !== undefined ? projection.ids.slice(ref.at - 1, ref.at) : projection.ids.slice(0, ref.take);
  if (keys.length === 0) return { ok: false, reason: 'ref-empty' };
  return { ok: true, keys };
}

function notRun(step: ValidatedAgentStep, number: number, reason: AgentStepNotRunReason): AgentStepResult {
  if (step.kind === 'summarize') return { step: number, kind: 'summarize', status: 'not-run', from: step.from, schema: step.schema };
  return { step: number, kind: 'read', entryId: step.entry.id as NlWave1EntryId, status: 'not-run', reason };
}

function closedCode(code: string): AgentReadErrorCode {
  return (AGENT_READ_ERROR_CODES as readonly string[]).includes(code) ? (code as AgentReadErrorCode) : 'UNKNOWN';
}
