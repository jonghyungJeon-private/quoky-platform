import type { Logger } from '../../ports/logger.port';
import type { NlArgs, NlWave1EntryId } from '../nl-routing/catalog';
import { AGENT_READ_SOURCES } from './flow-policy';
import { AGENT_PLAN_MAX_REF_VALUES, type ValidatedAgentPlan, type ValidatedAgentStep } from './plan-validator';
import { AGENT_RUN_BOUNDS, AgentRunBudget, type AgentBoundKind, type AgentRunBoundValues, type AgentRunUsage } from './run-bounds';
import {
  quarantinedSummarize,
  summaryGrantFor,
  summaryReadiness,
  validateSourceDocuments,
  type AgentSourceDocument,
  type AgentSummarySchemaId,
  type AgentSummarySource,
  type QuarantinedCallAudit,
  type QuarantinedListingOnlyReason,
  type QuarantinedSummarizerModel,
  type QuarantinedSummary,
} from './quarantined-summary';
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
 *   deterministic `partial` result, with no retry.
 * - **Summaries (D3/D4, P3-3b).** With a {@link AgentSummarizerDeps} a `summarize` step makes at most one M2 call through
 *   `quarantined-summary.ts` (charged on the run's M2 / model-call / token bounds; a breach is `not-run` and a partial
 *   result), over the raw documents the covered read ports handed over. A read is asked for documents (`withDocuments`) only
 *   when a summarize step covers it AND a model can already be selected for that read's label (a `REMOTE_ON_SUMMARY_REQUEST`
 *   read needs a summary grant, which nothing produces in this slice: mail and Drive stay listing-only, body never fetched).
 *   Every document is validated against the projection (shape, an integer unique in-range position, the projector's id at
 *   that position); a bad one is dropped and counted as omitted. Those documents live only inside one `execute` call:
 *   they are not in the result, the projection or the log, and the M2 output is a labelled {@link QuarantinedSummary} that only
 *   the reply assembler reads. Without the deps the step stays `deferred` (the earlier behaviour).
 * - **Value-free.** One content-free log line per run (closed values and counts). A port error is mapped to a closed code;
 *   its message is never read or logged.
 */

export const AGENT_EXEC_LOG_EVENT = 'agent_run.exec';

export const AGENT_READ_ERROR_CODES = ['NOT_FOUND', 'UNAUTHORIZED', 'UNAVAILABLE', 'UNSUPPORTED', 'INVALID_RESPONSE', 'TOO_LARGE', 'RATE_LIMITED', 'BOUND', 'UNKNOWN'] as const;
export type AgentReadErrorCode = (typeof AGENT_READ_ERROR_CODES)[number];

/** What the executor asks a read port for: one catalog read, or the detail of keys a projector took from an earlier read. */
export interface AgentReadRequest {
  readonly entryId: NlWave1EntryId;
  /** The validated, grounded args (literals only). */
  readonly args: NlArgs;
  /** A reference step only: closed-format ids of the SAME source and origin, in the order projected (1..10). */
  readonly keys?: readonly string[];
  /**
   * The read is covered by a summarize step and a model can be selected for its label: the port may hand over the items'
   * content as `documents`. Absent: it must not fetch any body (a port that returns documents anyway has them ignored).
   */
  readonly withDocuments?: true;
  /** Wall time left for the run, in ms; a port should give up by then. */
  readonly remainingMs: number;
  /**
   * Aborted on any bound breach or the wall: the port must stop at once (no further page, retry or request). A port that
   * ignores it is still cut off, because every request is reserved first.
   */
  readonly signal: AbortSignal;
  /** The run's budget for this call (D7): each query and each HTTP request is reserved BEFORE it is made. */
  readonly budget: AgentReadBudget;
}

/** The per-call handle on the run's budget. A `false` means: do not make it, and stop. Counted when granted. */
export interface AgentReadBudget {
  /** One named connector query (`ConnectorQuery`). */
  reserveQuery(): boolean;
  /** One HTTP request (the egress ledger's unit): refuses the 51st of a run. */
  reserveHttp(): boolean;
}

export type AgentReadResponse =
  | {
      readonly ok: true;
      readonly items: readonly AgentRawItem[];
      readonly hasMore?: boolean;
      readonly truncated?: boolean;
      /**
       * The items' raw content, only for a summary to read (D3). Never projected, never part of a result or a log; the executor
       * keeps it for the run and only for a read a `summarize` step covers.
       */
      readonly documents?: readonly AgentSourceDocument[];
    }
  /** `BOUND`: the port stopped because a reservation was refused or the signal aborted (the run is partial). */
  | { readonly ok: false; readonly code: string };

/** One narrow, read-only port. */
export interface AgentReadPort {
  read(request: AgentReadRequest): Promise<AgentReadResponse>;
}

/** The ports by catalog read entry; an entry with no port is `unavailable` for the run. */
export type AgentReadPorts = Readonly<Partial<Record<NlWave1EntryId, AgentReadPort>>>;

export interface AgentPlanExecutorDeps {
  readonly readers: AgentReadPorts;
  readonly logger?: Logger;
  /** The quarantined summariser (M2). Absent: `summarize` steps are `deferred`. */
  readonly summarizer?: AgentSummarizerDeps;
  /** Tests only: monotonic milliseconds (default `Date.now`). */
  readonly elapsed?: () => number;
  /** Tests only: other bound values. */
  readonly bounds?: Partial<AgentRunBoundValues>;
}

export interface AgentSummarizerDeps {
  /** The models M2 may use, in priority order. Each declares its locality; an absent one counts as `REMOTE`. */
  readonly models: readonly QuarantinedSummarizerModel[];
}

export type AgentStepNotRunReason = 'bound' | 'source-failed' | 'no-reader' | 'ref-cross-source' | 'ref-field' | 'ref-forward' | 'ref-empty' | 'ref-unusable' | 'ref-too-many';

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
  /** No summariser was injected (`deferred`), or a bound stopped the step (`not-run`). */
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'deferred' | 'not-run'; readonly from: readonly number[]; readonly schema: string }
  | {
      readonly step: number;
      readonly kind: 'summarize';
      readonly status: 'ok';
      readonly from: readonly number[];
      readonly schema: string;
      readonly summary: QuarantinedSummary;
      /** Items not in the summary (over the item cap, withheld, dropped on validation, or left out by the model or a guard). */
      readonly omitted: number;
      readonly audit: QuarantinedCallAudit;
    }
  /** D4: no model satisfied the inputs' egress label (or the content has no readout shape): no call was made. */
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'listing-only'; readonly from: readonly number[]; readonly schema: string; readonly reason: QuarantinedListingOnlyReason }
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'failed'; readonly from: readonly number[]; readonly schema: string; readonly errorCode: 'SCHEMA' | 'CREDENTIAL' | 'MODEL'; readonly audit?: QuarantinedCallAudit };

export interface AgentRunResult {
  /** `complete`: every read answered and no bound breached. Anything else is `partial`: the reply shows what exists. */
  readonly outcome: 'complete' | 'partial';
  /** The first breached bound, if any (a deterministic partial result, never an error). */
  readonly breach?: AgentBoundKind;
  readonly steps: readonly AgentStepResult[];
  readonly usage: AgentRunUsage;
}

/** What one `execute` call keeps in memory: never in the result. */
interface RunState {
  /** Validated raw content of the reads a summary covers. */
  readonly documents: Map<number, AgentSummarySource>;
  /** `<summarize step>:<read step>` to why that summary needs no body from that read. */
  readonly denials: Map<string, QuarantinedListingOnlyReason>;
  /** Read step number to the later summarize steps that cover it. */
  readonly coverage: Map<number, { readonly step: number; readonly schema: AgentSummarySchemaId }[]>;
}

type ReadStep = Extract<ValidatedAgentStep, { kind: 'read' }>;
type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;

export class AgentPlanExecutor {
  constructor(private readonly deps: AgentPlanExecutorDeps) {}

  /** Execute a validated `run` plan. Total: never throws or rejects; a bound or a port failure ends in a partial result. */
  async execute(plan: RunPlan): Promise<AgentRunResult> {
    const budget = new AgentRunBudget(this.deps.elapsed ?? Date.now, this.deps.bounds);
    const results: AgentStepResult[] = [];
    const projections = new Map<number, StructureProjection>();
    // Raw content of the reads a summary covers: per run, in memory only, never in the result.
    const state: RunState = { documents: new Map(), denials: new Map(), coverage: new Map() };
    // Which later summarize steps cover which read.
    for (const [index, step] of plan.steps.entries()) {
      if (step.kind !== 'summarize') continue;
      for (const from of step.from) {
        if (from < index + 1) state.coverage.set(from, [...(state.coverage.get(from) ?? []), { step: index + 1, schema: step.schema }]);
      }
    }
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
      try {
        results.push(
          step.kind === 'summarize'
            ? await this.runSummary(step, number, budget, state)
            : await this.runRead(step, number, budget, results, projections, state),
        );
      } catch {
        // Total: nothing a step does can reject `execute`; the closed failure is all the result says.
        results.push(
          step.kind === 'summarize'
            ? { step: number, kind: 'summarize', status: 'failed', from: step.from, schema: step.schema, errorCode: 'MODEL' }
            : { step: number, kind: 'read', entryId: step.entry.id as NlWave1EntryId, status: 'failed', errorCode: 'UNKNOWN' },
        );
      }
    }
    const usage = budget.snapshot();
    const breach = budget.breach;
    // A summary that left items out is a partial answer, whatever the reason.
    const allOk = results.every((result) => (result.status === 'ok' && !(result.kind === 'summarize' && result.omitted > 0)) || result.status === 'deferred');
    const summaries = results.filter((result) => result.kind === 'summarize');
    const outcome = breach === undefined && allOk ? 'complete' : 'partial';
    this.deps.logger?.info(AGENT_EXEC_LOG_EVENT, {
      outcome,
      ...(breach !== undefined ? { breach } : {}),
      steps: results.length,
      ok: results.filter((result) => result.status === 'ok').length,
      summaries: summaries.filter((result) => result.status === 'ok').length,
      listingOnly: summaries.filter((result) => result.status === 'listing-only').length,
      m2Calls: usage.m2Calls,
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
    state: RunState,
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

    // Documents are asked for only when a covering summarize step could run: its source has a readout shape and work-text
    // controls, and a model can be selected for this read's label (optimistically for one item: the count is not known yet).
    const models = this.deps.summarizer?.models;
    let withDocuments = false;
    if (models !== undefined) {
      for (const cover of state.coverage.get(number) ?? []) {
        const refusal = summaryReadiness(entryId, cover.schema, summaryGrantFor(cover.step, entryId), 1, models);
        if (refusal === undefined) withDocuments = true;
        else state.denials.set(`${cover.step}:${number}`, refusal);
      }
    }
    const response = await this.callPort(reader, { entryId, args: step.args, ...(keys !== undefined ? { keys } : {}), ...(withDocuments ? { withDocuments: true as const } : {}) }, budget);
    if (response === 'wall') return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };
    budget.checkWall();
    // Any breach or refusal during the call (a spent wall, a refused reservation) ends the step `not-run` (bound) and the run
    // partial, whatever the port returned: a port that exhausted its reservations and then reports success is still cut off.
    if (budget.breach !== undefined) return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };
    if (!response.ok) {
      if (response.code === 'BOUND') return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };
      return { step: number, kind: 'read', entryId, status: 'failed', errorCode: closedCode(response.code) };
    }
    const projection = projectStructure(entryId, response.items);
    projections.set(number, projection);
    if (withDocuments && response.documents !== undefined) {
      const checked = validateSourceDocuments(response.documents, projection.slots);
      state.documents.set(number, { entryId, documents: checked.documents, dropped: checked.dropped });
    }
    return { step: number, kind: 'read', entryId, status: 'ok', projection, hasMore: response.hasMore === true, truncated: response.truncated === true, refValues };
  }

  /**
   * One `summarize` step (D3/D4): at most one M2 call, reserved on the run's budget right before it is made. Total: a refusal,
   * a model error or a bad output is a closed status, never a throw and never a retry.
   */
  private async runSummary(
    step: Extract<ValidatedAgentStep, { kind: 'summarize' }>,
    number: number,
    budget: AgentRunBudget,
    state: RunState,
  ): Promise<AgentStepResult> {
    const base = { step: number, kind: 'summarize' as const, from: step.from, schema: step.schema };
    const summarizer = this.deps.summarizer;
    if (summarizer === undefined) return { ...base, status: 'deferred' };
    // Source entries come from the executed read steps (a failed or skipped read has no documents).
    const sources: AgentSummarySource[] = [];
    for (const from of step.from) {
      const covered = state.documents.get(from);
      if (covered === undefined) continue;
      const grant = summaryGrantFor(number, covered.entryId);
      sources.push(grant !== undefined ? { ...covered, grant } : covered);
    }
    if (sources.length === 0) {
      // Why no body was fetched, if the read decided so (no readout shape, no grant, no model); else nothing came back.
      const denied = step.from.map((from) => state.denials.get(`${number}:${from}`)).find((reason) => reason !== undefined);
      return { ...base, status: 'listing-only', reason: denied ?? 'no-documents' };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wall = new Promise<'wall'>((resolve) => {
      timer = setTimeout(() => {
        budget.markBreach('wall-time');
        controller.abort();
        resolve('wall');
      }, Math.max(1, budget.remainingMs()));
    });
    try {
      // A throw or a rejection is the closed `model` failure; a call the wall wins is still handled (never unhandled).
      const call = quarantinedSummarize({
        schema: step.schema,
        summaryStep: number,
        sources,
        models: summarizer.models,
        signal: controller.signal,
        reserve: (tokens) => budget.reserveModelCall('m2') && budget.reserveInputTokens(tokens),
      }).catch((): { readonly kind: 'failed'; readonly reason: 'model' } => ({ kind: 'failed', reason: 'model' }));
      const outcome = await Promise.race([call, wall]);
      budget.checkWall();
      if (outcome === 'wall' || budget.breach !== undefined) return { ...base, status: 'not-run' };
      if (outcome.kind === 'summary') return { ...base, status: 'ok', summary: outcome.summary, omitted: outcome.omitted, audit: outcome.audit };
      if (outcome.kind === 'listing-only') return { ...base, status: 'listing-only', reason: outcome.reason };
      if (outcome.kind === 'failed') {
        const errorCode = outcome.reason === 'schema' ? 'SCHEMA' : outcome.reason === 'credential' ? 'CREDENTIAL' : 'MODEL';
        return { ...base, status: 'failed', errorCode, ...('audit' in outcome && outcome.audit !== undefined ? { audit: outcome.audit } : {}) };
      }
      return { ...base, status: 'not-run' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * A port call that cannot outlive the wall. The signal is aborted on the wall and on any refused reservation, and every
   * request the port makes is reserved on the run's budget first, so usage is counted up to the abort and nothing is made
   * after it. A throw is an `UNKNOWN` failure whose message is never read.
   */
  private async callPort(reader: AgentReadPort, request: Pick<AgentReadRequest, 'entryId' | 'args' | 'keys' | 'withDocuments'>, budget: AgentRunBudget): Promise<AgentReadResponse | 'wall'> {
    const controller = new AbortController();
    const reserve = (take: () => boolean): boolean => {
      if (controller.signal.aborted) return false;
      if (take()) return true;
      controller.abort();
      return false;
    };
    const handle: AgentReadBudget = { reserveQuery: () => reserve(() => budget.reserveQuery()), reserveHttp: () => reserve(() => budget.reserveHttp()) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wall = new Promise<'wall'>((resolve) => {
      timer = setTimeout(() => {
        budget.markBreach('wall-time');
        controller.abort();
        resolve('wall');
      }, Math.max(1, budget.remainingMs()));
    });
    try {
      const call = Promise.resolve()
        .then(() => reader.read({ ...request, remainingMs: budget.remainingMs(), signal: controller.signal, budget: handle }))
        .then(
          (value) => value,
          (): AgentReadResponse => ({ ok: false, code: 'UNKNOWN' }),
        );
      return await Promise.race([call, wall]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
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
  if (ref.at !== undefined) {
    // A position is a row of the listing, not of the usable ids: an unusable row refuses the reference, never shifts it.
    if (ref.at > projection.slots.length) return { ok: false, reason: 'ref-empty' };
    const id = projection.slots[ref.at - 1];
    return id === undefined ? { ok: false, reason: 'ref-unusable' } : { ok: true, keys: [id] };
  }
  const keys = projection.ids.slice(0, ref.take);
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
