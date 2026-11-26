import type { Logger } from '../../ports/logger.port';
import { nlLimitArg, type NlArgs, type NlWave1EntryId } from '../nl-routing/catalog';
import { AGENT_READ_SOURCES, summaryReadModeOf } from './flow-policy';
import { SUMMARY_CONSENT_SOURCE_NAMES, type SummaryConsentSourceName } from './summary-consent-question';
import { projectWorkSummaryDocuments, workSummaryParticipants } from './work-summary-projection';
import { AGENT_PLAN_MAX_REF_VALUES, type ValidatedAgentPlan, type ValidatedAgentStep } from './plan-validator';
import { AGENT_RUN_BOUNDS, AgentRunBudget, type AgentBoundKind, type AgentRunBoundValues, type AgentRunUsage } from './run-bounds';
import {
  AGENT_M2_MAX_ITEMS,
  newSummaryRunToken,
  quarantinedSummarize,
  summaryGrantFor,
  summaryReadinessDetailed,
  validateSourceDocuments,
  type AgentSourceDocument,
  type AgentSummarySchemaId,
  type AgentSummarySource,
  type QuarantinedCallAudit,
  type QuarantinedListingOnlyReason,
  type QuarantinedSummarizerRoute,
  type QuarantinedSummaryOutcome,
  type SummaryReadinessInput,
  type SummaryConsentToken,
  type SummaryReadinessReason,
  type QuarantinedSummary,
  type SummaryRunToken,
} from './quarantined-summary';
import { projectStructure, type AgentRawItem, type StructureProjection } from './structure-projector';
import type { SummaryGrantBasis } from './summary-grant';

/**
 * ADR-0121 D1/D2/D5/D7 (stage S2 P3-3a): the deterministic executor of a VALIDATED read plan. Only `AgentRunService` in
 * `active` builds it (the S2 wiring slice); nothing runs it while `QUOKY_AGENT_MODE` is `off` or `shadow`, and `active` is
 * still refused at startup in `agent-config.ts` (the release gate).
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
 * - **Summaries (D3/D4, P3-3b; D12; the remote batch).** With a {@link AgentSummarizerDeps} (the existing provider selector) a
 *   `summarize` step makes its M2 calls through `quarantined-summary.ts`: one per source, split when a source's items do not fit
 *   one, planned up front within the run's remaining M2 calls, model calls and input tokens and run in parallel; each is charged
 *   on those bounds right before it is made (owner 2026-11-16: split calls count; a breach is `not-run` and a partial result).
 *   They read the raw documents the covered read ports handed over. A read is asked for documents
 *   (`withDocuments`) only when a summarize step covers it AND a provider can already be selected under the locality its label,
 *   grant and asked-for count allow (a `REMOTE_ON_SUMMARY_REQUEST`
 *   read needs a summary grant: Core derives it from the owner's own words (`summary-grant.ts`, passed as
 *   {@link AgentExecuteOptions.grants}); without it mail and Drive stay listing-only and no body is fetched).
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
   * The read is covered by a summarize step and a provider can be selected under its derived locality: the port may hand over the items'
   * content as `documents`. Absent: it must not fetch any body (a port that returns documents anyway has them ignored).
   */
  readonly withDocuments?: true;
  /**
   * ADR-0121 A5.2 (ADR-0110 D1 amendment): set ONLY on a `calendar.events` read a summarize step covers. The same single
   * `events.list` request with the separate agent-summary field mask (adds `description`), nothing else: never a body fetch,
   * never documents, no further request. The items answer is typed {@link AgentCalendarSummaryItem}. A port for any other
   * entry must ignore it (the executor never sets it for another entry).
   */
  readonly agentSummaryFieldMask?: true;
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

/**
 * M2's route (ADR-0121 D12, amended 2026-11-16): the existing {@link QuarantinedSummarizerRoute} — the provider selector and the
 * base selection context. No model list and no new port: Core derives the locality constraint and the selector picks under it.
 */
export type AgentSummarizerDeps = QuarantinedSummarizerRoute;

export type AgentStepNotRunReason = 'bound' | 'stopped' | 'source-failed' | 'no-reader' | 'ref-cross-source' | 'ref-field' | 'ref-forward' | 'ref-empty' | 'ref-unusable' | 'ref-too-many' | 'continuation';

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
  /** No summariser was injected (`deferred`). */
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'deferred'; readonly from: readonly number[]; readonly schema: string }
  /**
   * A bound stopped the step; `audits` lists every model call that had already been sent (the call was made, even if its answer
   * was cut off), in source order.
   */
  | {
      readonly step: number;
      readonly kind: 'summarize';
      readonly status: 'not-run';
      readonly from: readonly number[];
      readonly schema: string;
      /**
       * `stopped`: the kill switch or shutdown cut it (review round 2 item 4); `continuation`: a rule-① continuation re-runs one
       * summarize step and this step is not part of it (CS-1b); absent: a bound.
       */
      readonly reason?: 'stopped' | 'continuation';
      readonly audits?: readonly QuarantinedCallAudit[];
    }
  | {
      readonly step: number;
      readonly kind: 'summarize';
      readonly status: 'ok';
      readonly from: readonly number[];
      readonly schema: string;
      readonly summary: QuarantinedSummary;
      /** Items not in the summary (over the planned calls or the fit, withheld, dropped on validation, in a failed call, or left out by the model or a guard). */
      readonly omitted: number;
      /** One audit per sent call, in source order (at least one: the call that answered). */
      readonly audits: readonly QuarantinedCallAudit[];
      /** A call of this step was refused because its prompt held credential-shaped text; its items are omitted (CA P3). */
      readonly credentialWithheld?: true;
    }
  /**
   * Rule ① (CS-1a, `QUOKY_SUMMARY_CONSENT=on`): the step would send the covered items to a `REMOTE` model, so it asks first: no
   * body was fetched and no M2 call was made. `sources` are the sources of the covered reads that need the owner's yes, grouped
   * by source in plan order (two reads of one source share one entry), each with the ids of exactly the items the question counts
   * (the first `asked` usable listing slots of each of its reads, merged, distinct, at most {@link AGENT_M2_MAX_ITEMS}) and the
   * `reads` they came from; a read that is switched off or listing-only is not in it and stays listing-only (W5). Ids only, never content.
   */
  | {
      readonly step: number;
      readonly kind: 'summarize';
      readonly status: 'consent-needed';
      readonly from: readonly number[];
      readonly schema: string;
      /** The recipient's display name (`QuarantinedSummarizerRoute.recipientLabel`). */
      readonly recipient: string;
      readonly sources: readonly {
        readonly source: SummaryConsentSourceName;
        readonly itemIds: readonly string[];
        /** The covered reads of this source, in plan order, each with the ids it contributed (what a consent token is scoped by). */
        readonly reads: readonly { readonly step: number; readonly entryId: NlWave1EntryId; readonly itemIds: readonly string[] }[];
      }[];
    }
  /** D4: no model satisfied the inputs' egress label (or the content has no readout shape, or no budget was left): no call was sent. */
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'listing-only'; readonly from: readonly number[]; readonly schema: string; readonly reason: QuarantinedListingOnlyReason }
  | { readonly step: number; readonly kind: 'summarize'; readonly status: 'failed'; readonly from: readonly number[]; readonly schema: string; readonly errorCode: 'SCHEMA' | 'CREDENTIAL' | 'MODEL'; readonly audits?: readonly QuarantinedCallAudit[] };

/** ADR-0121 A7 (A7-S4a): what {@link AgentPlanExecutor.readDraftSource} may be given. All optional. */
export interface AgentDraftReadOptions {
  readonly budget?: AgentRunBudget;
  readonly signal?: AbortSignal;
  /** The persisted kill switch, re-read before the read. */
  readonly stillRunning?: () => Promise<boolean>;
  /** The run token a rule-① consent token was minted for (a re-run after the owner's yes). Absent: a fresh one. */
  readonly run?: SummaryRunToken;
  /** The owner's bound yes for this draft (rule ①). Absent: `REMOTE` is never allowed. */
  readonly consent?: SummaryConsentToken;
  /** The ids the owner was asked about: after the re-read, only these remain (W3). */
  readonly recorded?: readonly string[];
  /**
   * The owner's own summary request for the synthetic read + draft plan ({@link summaryGrantBasis} of exactly `plan`, derived from the
   * owner's own words only). A source that needs a summary grant (A5: Slack and Jira too) has none without it: listing-only.
   */
  readonly grants?: { readonly basis: SummaryGrantBasis | undefined; readonly plan: object };
}

export type AgentDraftSourceOutcome =
  | {
      readonly kind: 'ok';
      readonly source: AgentSummarySource;
      readonly run: SummaryRunToken;
      /** Items the read's projection listed. */
      readonly listed: number;
      /** Review round 2: the ids the listing itself named (its projection slots), validated or not: the a7-06 drift is measured against these. */
      readonly listedIds?: readonly string[];
      /** The host-only pseudonym map (a7-08) of this listing: never sent to a model, logged or audited. */
      readonly participants: readonly { readonly label: string; readonly name: string }[];
    }
  /** The draft would go to a `REMOTE` model: the question comes first, and no body was fetched. Ids only. */
  | { readonly kind: 'consent-needed'; readonly recipient: string; readonly source: SummaryConsentSourceName; readonly itemIds: readonly string[]; readonly run: SummaryRunToken }
  | { readonly kind: 'listing-only'; readonly reason: QuarantinedListingOnlyReason }
  | { readonly kind: 'not-run'; readonly reason: AgentStepNotRunReason }
  | { readonly kind: 'failed'; readonly errorCode: AgentReadErrorCode };

const WORK_SOURCE_NAME: Readonly<Partial<Record<NlWave1EntryId, SummaryConsentSourceName>>> = Object.freeze({
  'jira.issues': 'jira',
  'jira.release': 'jira',
  'slack.search': 'slack',
});
function workSummarySourceName(entryId: NlWave1EntryId): SummaryConsentSourceName | undefined {
  return WORK_SOURCE_NAME[entryId];
}

export interface AgentRunResult {
  /** `complete`: every read answered and no bound breached. Anything else is `partial`: the reply shows what exists. */
  readonly outcome: 'complete' | 'partial';
  /** The first breached bound, if any (a deterministic partial result, never an error). */
  readonly breach?: AgentBoundKind;
  /** The owner's kill switch stopped the run before a step (ADR-0121 D7; the A6-D3 amendment: started work finishes). */
  readonly stopped?: true;
  readonly steps: readonly AgentStepResult[];
  readonly usage: AgentRunUsage;
}

/**
 * ADR-0121 S2 wiring slice: what the bounded runtime hands one `execute` call. All optional; `execute(plan)` alone is the
 * offline behaviour (a fresh budget, no grant, no switch).
 */
export interface AgentExecuteOptions {
  /**
   * The run's budget, already charged by the caller with the planner call (M1) and its input, and the explicit re-plan
   * reservation (M1'), so the summaries plan within what the run has left (the D3/D7 amendment's wiring requirement). Absent:
   * a fresh budget from the deps' clock and bounds.
   */
  readonly budget?: AgentRunBudget;
  /**
   * The owner's summary requests for THIS plan (`summary-grant.ts`). Grants are minted from it per summarize step and source,
   * keyed to this call's run token; a basis of another plan grants nothing. Absent: no grant (listing-only for mail and Drive).
   */
  readonly grants?: SummaryGrantBasis;
  /**
   * The persisted kill switch, re-read before every step (never a snapshot). `false`, a throw or a rejection stops the run: that
   * step and every later one are `not-run` (`stopped`). Work already started finishes (the A6-D3 amendment of 2026-11-03).
   */
  readonly stillRunning?: () => Promise<boolean>;
  /**
   * The service's shutdown signal (review round 1 item 5). Aborted: no later step starts (`not-run`, `stopped`) and the port or
   * M2 call in flight is aborted and not waited for.
   */
  readonly signal?: AbortSignal;
  /**
   * Rule ① (CS-1b): re-run exactly ONE asked summarize step after the owner's bound yes, and nothing else of the plan. Built only by
   * `AgentRunService.continueSummaryConsent` from the continuation record and a token minted from the bound consent:
   * - `steps`: the step numbers that run (the summarize step, the reads it covers and their reference ancestors); every other
   *   step is `not-run` with the reason `continuation`;
   * - `summaryStep`: the one summarize step; `run`: the run token the consent token was minted for (this run's token, so the
   *   grants and the consent match);
   * - `consent`: the owner's yes for that step, passed to readiness and to the M2 request only (never anywhere else);
   * - `reads`: what the owner was asked about, per covered read: after the re-read, a document whose id is not one of that read's
   *   recorded ids is dropped (W3: an item that left is not replaced, a new item is not added), in listing order.
   * Absent: an ordinary run.
   */
  readonly continuation?: {
    readonly steps: readonly number[];
    readonly summaryStep: number;
    readonly run: SummaryRunToken;
    readonly consent: SummaryConsentToken;
    readonly reads: readonly { readonly step: number; readonly entryId: NlWave1EntryId; readonly itemIds: readonly string[] }[];
  };
}

/** What one `execute` call keeps in memory: never in the result. */
interface RunState {
  /** Validated raw content of the reads a summary covers. */
  readonly documents: Map<number, AgentSummarySource>;
  /** `<summarize step>:<read step>` to why that summary needs no body from that read. */
  readonly denials: Map<string, QuarantinedListingOnlyReason>;
  /** Read step number to the later summarize steps that cover it. */
  readonly coverage: Map<number, { readonly step: number; readonly schema: AgentSummarySchemaId; readonly from: readonly number[] }[]>;
  /** Read step number to the items it asked for (its limit, an unstated one counts as the item cap). */
  readonly requested: Map<number, number>;
  /** Read step number to the items its projection listed (a denied read's items are omitted from a summary over it). */
  readonly listed: Map<number, number>;
  /** This run's token: a summary grant of another run never matches. */
  readonly run: SummaryRunToken;
  /** The owner's summary requests and the plan they were derived for (absent: no grant). */
  readonly owner?: { readonly basis: SummaryGrantBasis | undefined; readonly plan: object };
  /** The shutdown signal (absent: none). */
  readonly shutdown?: AbortSignal;
  /** Rule ① (CS-1a): `<summarize step>:<read step>` to the covered read that needs the owner's yes, and its recipient. */
  readonly consentNeeded: Map<string, { readonly entryId: NlWave1EntryId; readonly recipient: string }>;
  /** Rule ① (CS-1a): the entry of each read step of the plan, so readiness can be decided for every covered read up front. */
  readonly readEntries: Map<number, NlWave1EntryId>;
  /** Rule ① (CS-1a): the readiness verdict of each (summarize step, covered read), decided once and shared by every read of that step. */
  readonly verdicts: Map<string, Verdict | 'wall'>;
  /** Rule ① (CS-1a): the same keys to the ids the question counts (the first `asked` usable slots of that read's projection). */
  readonly askedIds: Map<string, readonly string[]>;
  /** Rule ① (CS-1a): the one summarize step of this run that asks (W2: one pending step at a time). */
  asking?: number;
  /** Rule ① (CS-1b): the continuation this run is (one summarize step after the owner's yes), or absent. */
  readonly continuation?: AgentExecuteOptions['continuation'];
  /**
   * ADR-0121 A7 (A7-S4a): this state serves {@link AgentPlanExecutor.readDraftSource}: the one read is covered by a synthetic
   * `payload-draft.v1` draft (readiness judged by the stricter draft label), `consent` is the owner's bound yes for the draft, and
   * `recorded` the ids the owner was asked about (a later item is not added, W3).
   */
  readonly draft?: { readonly consent?: SummaryConsentToken; readonly recorded?: readonly string[]; participants?: readonly { readonly label: string; readonly name: string }[] };
}

type Verdict = Awaited<ReturnType<typeof summaryReadinessDetailed>>;

type ReadStep = Extract<ValidatedAgentStep, { kind: 'read' }>;
type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;

export class AgentPlanExecutor {
  constructor(private readonly deps: AgentPlanExecutorDeps) {}

  /** Execute a validated `run` plan. Total: never throws or rejects; a bound or a port failure ends in a partial result. */
  async execute(plan: RunPlan, options: AgentExecuteOptions = {}): Promise<AgentRunResult> {
    let budget: AgentRunBudget;
    try {
      budget = options.budget ?? new AgentRunBudget(this.deps.elapsed ?? Date.now, this.deps.bounds);
    } catch {
      // A clock or bounds that throws while the budget is built: the closed result, nothing ran (total: never rejects).
      return { outcome: 'partial', steps: plan.steps.map((step, index) => notRun(step, index + 1, 'bound')), usage: ZERO_USAGE };
    }
    const results: AgentStepResult[] = [];
    const projections = new Map<number, StructureProjection>();
    // Raw content of the reads a summary covers: per run, in memory only, never in the result.
    const state: RunState = {
      documents: new Map(),
      denials: new Map(),
      coverage: new Map(),
      listed: new Map(),
      requested: new Map(),
      consentNeeded: new Map(),
      readEntries: new Map(),
      verdicts: new Map(),
      askedIds: new Map(),
      run: options.continuation?.run ?? newSummaryRunToken(),
      ...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
      ...(options.grants !== undefined ? { owner: { basis: options.grants, plan } } : {}),
      ...(options.signal !== undefined ? { shutdown: options.signal } : {}),
    };
    // Which later summarize steps cover which read.
    for (const [index, step] of plan.steps.entries()) {
      if (step.kind === 'read') state.readEntries.set(index + 1, step.entry.id as NlWave1EntryId);
      if (step.kind === 'read') state.requested.set(index + 1, Math.min(AGENT_M2_MAX_ITEMS, Math.max(1, nlLimitArg(step.args) ?? AGENT_M2_MAX_ITEMS)));
      if (step.kind !== 'summarize') continue;
      for (const from of step.from) {
        if (from < index + 1) state.coverage.set(from, [...(state.coverage.get(from) ?? []), { step: index + 1, schema: step.schema, from: step.from }]);
      }
    }
    // The static charge is the validator's; a plan over the bound is never started (zero reads).
    const staticOver = plan.connectorCalls > (this.deps.bounds?.maxConnectorQueries ?? AGENT_RUN_BOUNDS.maxConnectorQueries);
    if (staticOver) budget.markBreach('connector-queries');
    // Only a `run` plan executes: a `clarify` plan is the owner's question, never a read.
    const blocked = staticOver || plan.kind !== 'run';
    let stopped = false;
    for (const [index, step] of plan.steps.entries()) {
      const number = index + 1;
      // Rule ① (CS-1b): a continuation runs only its own steps; the rest of the plan is not re-run (no switch probe either).
      if (state.continuation !== undefined && !state.continuation.steps.includes(number)) {
        results.push(notRun(step, number, 'continuation'));
        continue;
      }
      // Shutdown, then the kill switch re-read before each step: a stop blocks the next step at once (D7; A6-D3 amendment). The
      // switch read cannot outlive the wall (review round 1 item 4): a read the wall wins is a wall breach, and the step and
      // every later one are `not-run` (`bound`).
      if (!blocked && !stopped && state.shutdown?.aborted === true) stopped = true;
      if (!blocked && !stopped && options.stillRunning !== undefined && !safely(() => budget.breach !== undefined, true)) {
        const probe = await stillRunningWithinWall(options.stillRunning, budget);
        if (probe === 'stopped' || state.shutdown?.aborted === true) stopped = true;
      }
      if (stopped) {
        results.push(notRun(step, number, 'stopped'));
        continue;
      }
      if (blocked || !safely(() => budget.reserveStep(), false)) {
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
    // Review round 2 item 4: a shutdown that cut the last step stops the run too (no later step was left to notice it).
    if (!stopped && results.some((result) => result.status === 'not-run' && result.reason === 'stopped')) stopped = true;
    const usage = safely(() => budget.snapshot(), ZERO_USAGE);
    const breach = safely(() => budget.breach, undefined);
    // A summary that left items out is a partial answer, whatever the reason.
    const allOk = results.every((result) => (result.status === 'ok' && !(result.kind === 'summarize' && result.omitted > 0)) || result.status === 'deferred');
    const summaries = results.filter((result) => result.kind === 'summarize');
    const outcome = breach === undefined && !stopped && allOk ? 'complete' : 'partial';
    // A logger that throws never rejects `execute` (total).
    safely(
      () =>
        this.deps.logger?.info(AGENT_EXEC_LOG_EVENT, {
          outcome,
          ...(breach !== undefined ? { breach } : {}),
          ...(stopped ? { stopped: true } : {}),
          steps: results.length,
          ok: results.filter((result) => result.status === 'ok').length,
          summaries: summaries.filter((result) => result.status === 'ok').length,
          listingOnly: summaries.filter((result) => result.status === 'listing-only').length,
          m2Calls: usage.m2Calls,
          connectorQueries: usage.connectorQueries,
          httpRequests: usage.httpRequests,
          refValues: usage.refValues,
          elapsedMs: usage.elapsedMs,
        }),
      undefined,
    );
    return { outcome, ...(breach !== undefined ? { breach } : {}), ...(stopped ? { stopped: true as const } : {}), steps: results, usage };
  }

  /**
   * ADR-0121 amendment A7 (A7-S4a), form a: the ONE source read of a cross-source write, executed exactly as a read step a summary
   * covers (the same read port, the same budget, the same projection and the same readiness check), but covered by a synthetic
   * `payload-draft.v1` draft, so the readiness is judged by the stricter DRAFT label (A7.5 step 4). It returns the validated documents
   * for {@link quarantinedDraft}, or why there are none: the rule-① question must be asked first (`consent-needed`, nothing fetched),
   * or no model may see them (`listing-only`). Total: never throws. No model call is made here.
   */
  async readDraftSource(step: ReadStep, options: AgentDraftReadOptions = {}): Promise<AgentDraftSourceOutcome> {
    try {
      const budget = options.budget ?? new AgentRunBudget(this.deps.elapsed ?? Date.now, this.deps.bounds);
      const entryId = step.entry.id as NlWave1EntryId;
      const aborted = (): boolean => options.signal?.aborted === true;
      if (aborted()) return { kind: 'not-run', reason: 'stopped' };
      if (options.stillRunning !== undefined && !budget.checkWall()) return { kind: 'not-run', reason: 'bound' };
      if (options.stillRunning !== undefined) {
        const probe = await stillRunningWithinWall(options.stillRunning, budget);
        if (probe === 'wall') return { kind: 'not-run', reason: 'bound' };
        if (probe === 'stopped' || aborted()) return { kind: 'not-run', reason: 'stopped' };
      }
      if (step.ref !== undefined || !budget.reserveStep()) return { kind: 'not-run', reason: 'bound' };
      const asked = Math.min(AGENT_M2_MAX_ITEMS, Math.max(1, nlLimitArg(step.args) ?? AGENT_M2_MAX_ITEMS));
      const state: RunState = {
        documents: new Map(),
        denials: new Map(),
        coverage: new Map([[1, [{ step: 2, schema: 'digest.v1' as const, from: [1] }]]]),
        listed: new Map(),
        requested: new Map([[1, asked]]),
        consentNeeded: new Map(),
        readEntries: new Map([[1, entryId]]),
        verdicts: new Map(),
        askedIds: new Map(),
        run: options.run ?? newSummaryRunToken(),
        ...(options.grants !== undefined ? { owner: options.grants } : {}),
        draft: { ...(options.consent !== undefined ? { consent: options.consent } : {}), ...(options.recorded !== undefined ? { recorded: options.recorded } : {}) },
        ...(options.signal !== undefined ? { shutdown: options.signal } : {}),
      };
      const result = await this.runRead(step, 1, budget, [], new Map(), state);
      if (result.kind !== 'read') return { kind: 'not-run', reason: 'bound' };
      if (result.status === 'failed') return { kind: 'failed', errorCode: result.errorCode };
      if (result.status === 'not-run') return { kind: 'not-run', reason: result.reason };
      const asking = state.consentNeeded.get('2:1');
      if (asking !== undefined) {
        const source = workSummarySourceName(entryId);
        if (source === undefined) return { kind: 'listing-only', reason: 'no-model' };
        return { kind: 'consent-needed', recipient: asking.recipient, source, itemIds: Object.freeze([...(state.askedIds.get('2:1') ?? [])]), run: state.run };
      }
      const denial = state.denials.get('2:1');
      if (denial !== undefined) return { kind: 'listing-only', reason: denial };
      const source = state.documents.get(1);
      if (source === undefined || source.documents.length === 0) return { kind: 'listing-only', reason: 'no-documents' };
      // The draft step (step 2 of the synthetic plan) holds the owner's grant for this source, bound to this run, or none.
      const grant = summaryGrantFor(2, entryId, state.run, state.owner);
      return { kind: 'ok', source: { ...source, asked, ...(grant !== undefined ? { grant } : {}) }, run: state.run, listed: result.projection.itemCount, listedIds: result.projection.slots.filter((id): id is string => id !== undefined), participants: state.draft?.participants ?? [] };
    } catch {
      return { kind: 'failed', errorCode: 'UNKNOWN' };
    }
  }

  /**
   * ADR-0121 amendment A7 (A7-S4b, A7.4b): the ONE owner-scoped READ behind a destination listing (e.g. the owner's open issues). It is a
   * plain listing read: the same read port, the same budget and bounds and the same structure projection as any read, covered by NO summary
   * and NO draft, so it fetches no body and makes no model call. It returns the rows' closed-format ids (the projection's slots) with each
   * row's raw `title` member as untrusted text for the caller to render inert. The args are the entry's own (never a destination or a
   * value from content). Total: never throws.
   */
  async listDestinationRows(
    entryId: NlWave1EntryId,
    args: NlArgs,
    options: { readonly budget?: AgentRunBudget; readonly signal?: AbortSignal; readonly stillRunning?: () => Promise<boolean> } = {},
  ): Promise<{ readonly kind: 'ok'; readonly rows: readonly { readonly id: string; readonly title?: unknown }[] } | { readonly kind: 'not-run'; readonly reason: AgentStepNotRunReason } | { readonly kind: 'failed' }> {
    try {
      const budget = options.budget ?? new AgentRunBudget(this.deps.elapsed ?? Date.now, this.deps.bounds);
      const reader = this.deps.readers[entryId];
      if (reader === undefined || !(entryId in AGENT_READ_SOURCES)) return { kind: 'not-run', reason: 'no-reader' };
      const aborted = (): boolean => options.signal?.aborted === true;
      if (aborted()) return { kind: 'not-run', reason: 'stopped' };
      if (options.stillRunning !== undefined) {
        if (!budget.checkWall()) return { kind: 'not-run', reason: 'bound' };
        const probe = await stillRunningWithinWall(options.stillRunning, budget);
        if (probe === 'wall') return { kind: 'not-run', reason: 'bound' };
        if (probe === 'stopped' || aborted()) return { kind: 'not-run', reason: 'stopped' };
      }
      if (!budget.reserveStep() || !budget.mayReadConnector()) return { kind: 'not-run', reason: 'bound' };
      const response = await this.callPort(reader, { entryId, args }, budget, options.signal);
      if (response === 'wall') return { kind: 'not-run', reason: aborted() ? 'stopped' : 'bound' };
      budget.checkWall();
      if (budget.breach !== undefined) return { kind: 'not-run', reason: 'bound' };
      if (!response.ok) return response.code === 'BOUND' ? { kind: 'not-run', reason: 'bound' } : { kind: 'failed' };
      const projection = projectStructure(entryId, response.items);
      const rows: { id: string; title?: unknown }[] = [];
      projection.slots.forEach((id, index) => {
        if (id === undefined) return;
        const item = response.items[index] as { readonly title?: unknown } | undefined;
        rows.push({ id, ...(item !== undefined && item !== null && typeof item === 'object' && 'title' in item ? { title: item.title } : {}) });
      });
      return { kind: 'ok', rows };
    } catch {
      return { kind: 'failed' };
    }
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
    // controls, its label, grant and asked-for count admit a locality, and the selector names an allowed provider (D12).
    // A read counts its requested limit (an unstated limit counts as the item cap). With a grant `LOCAL` and `REMOTE` are
    // allowed for one item and for a batch alike (owner 2026-11-03 answer 3); the summary sends at most the asked-for items of
    // each source (CA review round 1, P1).
    const route = this.deps.summarizer;
    let withDocuments = false;
    let readyToSummarize = false;
    let fieldMask = false;
    // Rule ① (CS-1a): the covering steps that must ask before a `REMOTE` model may see this read's items.
    const asking: string[] = [];
    if (route !== undefined) {
      for (const cover of state.coverage.get(number) ?? []) {
        // Rule ① (CS-1b, review round 1): in a continuation the summary inputs are ONLY the reads recorded with the question. Any
        // other covered read (a sibling that listed nothing when asked, an unasked Drive read) is listing-only: no readiness probe,
        // no `withDocuments`, no mask, nothing added to `state.documents`.
        if (state.continuation !== undefined && !(cover.step === state.continuation.summaryStep && state.continuation.reads.some((entry) => entry.step === number))) continue;
        // Rule ① (CS-1a): the readiness of EVERY covered read of the step is decided before any of them fetches a body. If any
        // one of them would ask, the whole step asks, so no read of it requests `withDocuments` (a LOCAL-ready read that ran
        // first would otherwise fetch bodies the question then drops). The verdicts are cached per (step, read): no extra probe.
        let stepAsks = false;
        let own: Verdict | 'wall' | undefined;
        for (const from of [...new Set([...cover.from, number])].sort((x, y) => x - y)) {
          if (state.readEntries.get(from) === undefined) continue;
          // A continuation judges only the recorded reads (review round 1): an unrecorded sibling must not make the step ask.
          if (state.continuation !== undefined && !state.continuation.reads.some((entry) => entry.step === from)) continue;
          const verdict = await this.readinessOf(state, budget, route, cover, from);
          if (verdict === 'wall') return { step: number, kind: 'read', entryId, status: 'not-run', reason: 'bound' };
          if (verdict.reason === 'consent-needed' && verdict.recipient !== undefined) stepAsks = true;
          if (from === number) own = verdict;
        }
        if (own === undefined || own === 'wall') continue;
        const refusal: SummaryReadinessReason | undefined = own.reason;
        if (refusal === 'consent-needed' && own.recipient !== undefined) {
          // No `withDocuments` and no field mask: no body is fetched. The read itself runs, so the owner sees the listing.
          state.consentNeeded.set(`${cover.step}:${number}`, { entryId, recipient: own.recipient });
          asking.push(`${cover.step}:${number}`);
        } else if (refusal === undefined && !stepAsks) {
          readyToSummarize = true;
          // A5.2: the five work sources are summarised from the listing response itself and NEVER get `withDocuments` (no body
          // fetch, no further request). Jira, Slack, Confluence and GitHub send the request exactly as without a summary; the
          // calendar alone sets `agentSummaryFieldMask` (the same single `events.list`, mask only). Mail and Drive keep documents.
          const mode = summaryReadModeOf(entryId);
          if (mode === 'documents') withDocuments = true;
          else if (mode === 'listing-mask') fieldMask = true;
        } else if (refusal !== undefined) state.denials.set(`${cover.step}:${number}`, refusal === 'consent-needed' ? 'no-model' : refusal);
      }
    }
    const response = await this.callPort(reader, { entryId, args: step.args, ...(keys !== undefined ? { keys } : {}), ...(withDocuments ? { withDocuments: true as const } : {}), ...(fieldMask ? { agentSummaryFieldMask: true as const } : {}) }, budget, state.shutdown);
    if (response === 'wall') return { step: number, kind: 'read', entryId, status: 'not-run', reason: state.shutdown?.aborted === true ? 'stopped' : 'bound' };
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
    // Rule ① (CS-1b): what the owner was asked about is the recorded ids of this read, not what the listing holds now.
    const recorded = recordedIds(state, number);
    state.listed.set(number, recorded === undefined ? projection.itemCount : recorded.size);
    if (asking.length > 0) {
      // The ids the question counts: positions 1..asked of the listing; an unusable slot is skipped and never shifts the others.
      const asked = state.requested.get(number) ?? AGENT_M2_MAX_ITEMS;
      const ids = projection.slots.slice(0, asked).filter((id): id is string => id !== undefined);
      for (const key of asking) state.askedIds.set(key, Object.freeze(ids));
    }
    if (readyToSummarize && summaryReadModeOf(entryId) !== 'documents') {
      // The listing's own items, through the closed A5.2 field table; whatever `documents` a port returned is ignored.
      const projected = projectWorkSummaryDocuments(entryId, response.items);
      if (state.draft !== undefined) state.draft.participants = workSummaryParticipants(response.items);
      const checked = validateSourceDocuments(projected.documents, projection.slots);
      state.documents.set(number, { entryId, documents: keepRecorded(checked.documents, recorded), dropped: checked.dropped + projected.withheld });
    } else if (withDocuments && response.documents !== undefined) {
      const checked = validateSourceDocuments(response.documents, projection.slots);
      state.documents.set(number, { entryId, documents: keepRecorded(checked.documents, recorded), dropped: checked.dropped });
    }
    return { step: number, kind: 'read', entryId, status: 'ok', projection, hasMore: response.hasMore === true, truncated: response.truncated === true, refValues };
  }

  /** The cached readiness verdict of one covered read of one summarize step (bounded by the run's wall, like a port call). */
  private async readinessOf(
    state: RunState,
    budget: AgentRunBudget,
    route: QuarantinedSummarizerRoute,
    cover: { readonly step: number; readonly schema: AgentSummarySchemaId; readonly from: readonly number[] },
    read: number,
  ): Promise<Verdict | 'wall'> {
    const key = `${cover.step}:${read}`;
    const held = state.verdicts.get(key);
    if (held !== undefined) return held;
    const entryId = state.readEntries.get(read) as NlWave1EntryId;
    // The readiness `select` awaits the router's readiness probe: it is bounded by the run's wall like a port call, and a
    // spent wall (or any breach) after it ends the step `not-run` (bound) before the port is called (CA review round 1).
    if (!budget.checkWall()) return 'wall';
    const verdict = await readinessWithinWall(
      {
        entryId,
        schema: cover.schema,
        summaryStep: cover.step,
        grant: summaryGrantFor(cover.step, entryId, state.run, state.owner),
        run: state.run,
        askedItems: askedAcross(state, cover.from),
        route,
        ...(state.continuation !== undefined && cover.step === state.continuation.summaryStep ? { consent: state.continuation.consent } : {}),
        ...(state.draft !== undefined ? { strictLabel: true as const, ...(state.draft.consent !== undefined ? { consent: state.draft.consent } : {}) } : {}),
      },
      budget,
    );
    const settled = verdict === 'wall' || !budget.checkWall() ? 'wall' : verdict;
    state.verdicts.set(key, settled);
    return settled;
  }

  /**
   * One `summarize` step (D3/D4): its M2 calls (planned within what the run has left, run in parallel), each reserved on the run's
   * budget right before it is made. Total: a refusal, a model error or a bad output is a closed status, never a throw and never a
   * retry; every call that was sent is in the step's `audits`.
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
    // Rule ① (CS-1a): a covered read that needs the owner's yes makes the whole step ask: no M2 call, no body. A read that is
    // switched off or listing-only never joins the question (W5: it keeps its own reason and stays listing-only).
    const groups = new Map<SummaryConsentSourceName, { ids: string[]; reads: { step: number; entryId: NlWave1EntryId; itemIds: readonly string[] }[] }>();
    const recipients = new Set<string>();
    for (const from of [...step.from].sort((x, y) => x - y)) {
      const need = state.consentNeeded.get(`${number}:${from}`);
      const ids = state.askedIds.get(`${number}:${from}`) ?? [];
      const source = need === undefined ? undefined : AGENT_READ_SOURCES[need.entryId]?.source;
      if (need === undefined || ids.length === 0 || !(SUMMARY_CONSENT_SOURCE_NAMES as readonly string[]).includes(source as string)) continue;
      recipients.add(need.recipient);
      const group = groups.get(source as SummaryConsentSourceName) ?? { ids: [], reads: [] };
      for (const id of ids) if (!group.ids.includes(id)) group.ids.push(id);
      group.reads.push({ step: from, entryId: need.entryId, itemIds: ids });
      groups.set(source as SummaryConsentSourceName, group);
    }
    if (groups.size > 0) {
      if (state.asking !== undefined) return { ...base, status: 'listing-only', reason: 'consent-one-pending' };
      if (recipients.size > 1) return { ...base, status: 'listing-only', reason: 'consent-recipient-split' };
      if ([...groups.values()].some((group) => group.ids.length > AGENT_M2_MAX_ITEMS)) return { ...base, status: 'listing-only', reason: 'consent-too-many-items' };
      state.asking = number;
      return {
        ...base,
        status: 'consent-needed',
        recipient: [...recipients][0] as string,
        sources: [...groups].map(([source, group]) => ({ source, itemIds: Object.freeze(group.ids), reads: Object.freeze(group.reads) })),
      };
    }
    // Source entries come from the executed read steps (a failed or skipped read has no documents).
    const sources: AgentSummarySource[] = [];
    for (const from of step.from) {
      const covered = state.documents.get(from);
      if (covered === undefined) continue;
      const grant = summaryGrantFor(number, covered.entryId, state.run, state.owner);
      // The source's asked-for count bounds what reaches a model, whatever the port returned (CA review round 1, P1).
      const asked = state.requested.get(from) ?? AGENT_M2_MAX_ITEMS;
      sources.push({ ...covered, asked, ...(grant !== undefined ? { grant } : {}) });
    }
    if (sources.length === 0) {
      // Why no body was fetched, if the read decided so (no readout shape, no grant, no model); else nothing came back.
      const denied = step.from.map((from) => state.denials.get(`${number}:${from}`)).find((reason) => reason !== undefined);
      return { ...base, status: 'listing-only', reason: denied ?? 'no-documents' };
    }

    // Rule ① (CS-1b, W3): after the yes, a step whose asked items are all gone, changed or withheld sends nothing.
    if (state.continuation !== undefined && sources.every((source) => source.documents.length === 0)) return { ...base, status: 'listing-only', reason: 'consent-nothing-left' };

    // Omitted is everything listed over the covered reads that the summary does not carry: a missing document, a denied read, a
    // dropped one, one cut by the cap or the fit, or left out by the model.
    const listedItems = step.from.reduce((sum, from) => sum + (state.listed.get(from) ?? 0), 0);

    const controller = new AbortController();
    // One reader per call that started, in start order (= source order: the calls start in one synchronous loop).
    const started: (() => QuarantinedCallAudit | undefined)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlink = linkShutdown(state.shutdown, controller);
    const wall = new Promise<'wall'>((resolve) => {
      timer = setTimeout(() => {
        budget.markBreach('wall-time');
        controller.abort();
        resolve('wall');
      }, Math.max(1, budget.remainingMs()));
      // Shutdown aborts the call and is not waited for (no wall breach: the run is `stopped`).
      controller.signal.addEventListener('abort', () => resolve('wall'), { once: true });
    });
    try {
      // A throw or a rejection is the closed `model` failure; a call the wall wins is still handled (never unhandled).
      const call = quarantinedSummarize({
        schema: step.schema,
        summaryStep: number,
        sources,
        route: summarizer,
        signal: controller.signal,
        run: state.run,
        askedItems: askedAcross(state, step.from),
        ...(state.continuation !== undefined ? { consent: state.continuation.consent } : {}),
        remainingInputTokens: budget.remainingInputTokens(),
        remainingCalls: budget.remainingM2Calls(),
        reserve: (tokens) => budget.reserveModelCall('m2') && budget.reserveInputTokens(tokens),
        onCallStart: (audit) => {
          started.push(audit);
        },
      }).catch((): QuarantinedSummaryOutcome => ({ kind: 'failed', reason: 'model' }));
      const outcome = await Promise.race([call, wall]);
      // A clock that throws after the call started is a wall breach, never an escape that would drop the call's audit (Codex).
      try {
        budget.checkWall();
      } catch {
        safely(() => budget.markBreach('wall-time'), undefined);
      }
      // Every status reached after a model call was sent carries that call's audit (the call was made, whatever became of the
      // answer): the outcome's own list when the step answered, else every started call's reader (a call the final dispatch
      // check refused reads `undefined`: nothing was sent).
      const callAudits = (known?: readonly QuarantinedCallAudit[]): { readonly audits?: readonly QuarantinedCallAudit[] } => {
        const audits = known ?? started.flatMap((read) => {
          const audit = safely(read, undefined);
          return audit !== undefined ? [audit] : [];
        });
        return audits.length > 0 ? { audits } : {};
      };
      if (outcome === 'wall') return { ...base, status: 'not-run', ...(state.shutdown?.aborted === true ? { reason: 'stopped' as const } : {}), ...callAudits() };
      if (budget.breach !== undefined) return { ...base, status: 'not-run', ...callAudits('audits' in outcome ? outcome.audits : undefined) };
      if (outcome.kind === 'summary') {
        return {
          ...base,
          status: 'ok',
          summary: outcome.summary,
          omitted: Math.max(0, listedItems - outcome.summary.count),
          audits: outcome.audits,
          ...(outcome.credentialWithheld === true ? { credentialWithheld: true as const } : {}),
        };
      }
      // `listing-only` means nothing was sent (a sent call that failed makes the step `failed`, CA P2-a).
      if (outcome.kind === 'listing-only') return { ...base, status: 'listing-only', reason: outcome.reason };
      if (outcome.kind === 'failed') {
        const errorCode = outcome.reason === 'schema' ? 'SCHEMA' : outcome.reason === 'credential' ? 'CREDENTIAL' : 'MODEL';
        return { ...base, status: 'failed', errorCode, ...callAudits(outcome.audits) };
      }
      return { ...base, status: 'not-run', ...callAudits() };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unlink();
      controller.abort();
    }
  }

  /**
   * A port call that cannot outlive the wall. The signal is aborted on the wall and on any refused reservation, and every
   * request the port makes is reserved on the run's budget first, so usage is counted up to the abort and nothing is made
   * after it. A throw is an `UNKNOWN` failure whose message is never read.
   */
  private async callPort(
    reader: AgentReadPort,
    request: Pick<AgentReadRequest, 'entryId' | 'args' | 'keys' | 'withDocuments' | 'agentSummaryFieldMask'>,
    budget: AgentRunBudget,
    shutdown?: AbortSignal,
  ): Promise<AgentReadResponse | 'wall'> {
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
    // Shutdown aborts the port call and is not waited for (`'wall'` without a wall breach: the caller reads the signal).
    const unlink = linkShutdown(shutdown, controller);
    // Review round 2 item 3: the listener on the service-lifetime signal is removed when the call ends (no growth per call).
    let stopCut: (() => void) | undefined;
    const cut = new Promise<'wall'>((resolve) => {
      if (shutdown?.aborted === true) resolve('wall');
      stopCut = () => resolve('wall');
      shutdown?.addEventListener('abort', stopCut, { once: true });
    });
    try {
      const call = Promise.resolve()
        .then(() => reader.read({ ...request, remainingMs: budget.remainingMs(), signal: controller.signal, budget: handle }))
        .then(
          (value) => value,
          (): AgentReadResponse => ({ ok: false, code: 'UNKNOWN' }),
        );
      return await Promise.race([call, wall, cut]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (stopCut !== undefined) shutdown?.removeEventListener('abort', stopCut);
      unlink();
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
  if (step.kind === 'summarize') return { step: number, kind: 'summarize', status: 'not-run', from: step.from, schema: step.schema, ...(reason === 'stopped' || reason === 'continuation' ? { reason } : {}) };
  return { step: number, kind: 'read', entryId: step.entry.id as NlWave1EntryId, status: 'not-run', reason };
}

function closedCode(code: string): AgentReadErrorCode {
  return (AGENT_READ_ERROR_CODES as readonly string[]).includes(code) ? (code as AgentReadErrorCode) : 'UNKNOWN';
}

/** Summary readiness that cannot outlive the run's wall: `'wall'` (and a wall breach) when the wall ends first. Never rejects. */
async function readinessWithinWall(input: SummaryReadinessInput, budget: AgentRunBudget): Promise<Awaited<ReturnType<typeof summaryReadinessDetailed>> | 'wall'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<'wall'>((resolve) => {
    timer = setTimeout(() => {
      safely(() => budget.markBreach('wall-time'), undefined);
      resolve('wall');
    }, Math.max(1, safely(() => budget.remainingMs(), 0)));
  });
  try {
    return await Promise.race([summaryReadinessDetailed(input).catch((): { readonly reason: 'no-model' } => ({ reason: 'no-model' })), wall]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The kill-switch probe raced against the run's wall (review round 1 item 4): `running` only for an exact `true`; anything
 * else (a throw, a rejection, another value) is `stopped` (fail closed); a probe still pending when the wall ends is `wall`,
 * with the wall breach marked. Never rejects.
 */
async function stillRunningWithinWall(probe: () => Promise<boolean>, budget: AgentRunBudget): Promise<'running' | 'stopped' | 'wall'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<'wall'>((resolve) => {
    timer = setTimeout(() => {
      safely(() => budget.markBreach('wall-time'), undefined);
      resolve('wall');
    }, Math.max(1, safely(() => budget.remainingMs(), 0)));
  });
  try {
    const read = Promise.resolve()
      .then(probe)
      .then(
        (value): 'running' | 'stopped' => (value === true ? 'running' : 'stopped'),
        (): 'stopped' => 'stopped',
      );
    return await Promise.race([read, wall]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Rule ① (CS-1b): the ids the owner was asked about for this read (a continuation only), or `undefined` (an ordinary run, or an uncovered read). */
function recordedIds(state: RunState, read: number): ReadonlySet<string> | undefined {
  if (state.draft?.recorded !== undefined) return state.draft.recorded.length === 0 ? undefined : new Set(state.draft.recorded);
  const ids = state.continuation?.reads.filter((entry) => entry.step === read).flatMap((entry) => entry.itemIds);
  return ids === undefined || ids.length === 0 ? undefined : new Set(ids);
}

/** W3: only the documents of the recorded ids, in listing order (removed items are not replaced, new ones are not added). `recorded` absent: all. */
function keepRecorded(documents: readonly AgentSourceDocument[], recorded: ReadonlySet<string> | undefined): readonly AgentSourceDocument[] {
  return recorded === undefined ? documents : documents.filter((document) => recorded.has(document.id)).sort((a, b) => a.position - b.position);
}

/** Abort `controller` when `shutdown` aborts (at once when it already has); returns the unlink. */
function linkShutdown(shutdown: AbortSignal | undefined, controller: AbortController): () => void {
  if (shutdown === undefined) return () => undefined;
  const stop = (): void => controller.abort();
  if (shutdown.aborted) {
    stop();
    return () => undefined;
  }
  shutdown.addEventListener('abort', stop, { once: true });
  return () => shutdown.removeEventListener('abort', stop);
}

/** The items a summary asks for over its covered reads: the sum of their requested counts (the count readiness and the model choice share). */
function askedAcross(state: RunState, from: readonly number[]): number {
  return from.reduce((sum, read) => sum + (state.requested.get(read) ?? 0), 0);
}

const ZERO_USAGE: AgentRunUsage = Object.freeze({ steps: 0, replans: 0, connectorQueries: 0, httpRequests: 0, modelCalls: 0, m2Calls: 0, inputTokens: 0, refValues: 0, elapsedMs: 0 });

/** Run `action`; if it throws (a logger, a budget read), the fallback stands. Nothing in `execute` may reject. */
function safely<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}
