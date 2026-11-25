import { Capability, type Actor, type Id, type InboundQuotedRange, type IsoTimestamp } from '../../domain';
import { CATALOG_FLOW_LABEL, OWNER_TEXT_FLOW_LABEL, PREVIOUS_SELECTION_FLOW_LABEL } from '../../domain/flow-label';
import type { AiExecutionLocality, AiProvider } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import { newId } from '../../util/id';
import { callUsageLogFields, type CallUsageLogFields } from '../call-usage-log-fields';
import { containsCredentialMaterial } from '../credential-guard';
import { summaryConsentPending, type ConsentPendingStore } from '../consent-answer/consent-pending';
import { NlActionSwitch, parseActionSwitchPhrase, readActionSwitch, type NlActionSwitchState } from '../nl-routing/action-switch';
import { isNlCatalogEntryId, isNlWave1EntryId, type NlArgs, type NlCatalogEntry, type NlCatalogEntryId, type NlWave1EntryId } from '../nl-routing/catalog';
import { nlSameEgress } from '../nl-routing/selection-egress';
import { nlSelectionMeaning } from '../nl-routing/selection-meaning';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import type { AgentCrossWriteContext } from './cross-write';
import { checkPlannerInputs, plannerPromptCanaryHit, untrustedCanariesOf, type AgentWorkSummarySource } from './flow-policy';
import { splitHelpClause, type AgentHelpSplit } from './help-split';
import { AGENT_PLAN_PROMPT_VERSION, buildAgentPlanPrompt } from './plan-prompt';
import { AgentPlanExecutor, type AgentReadPorts, type AgentRunResult } from './plan-executor';
import { agentPlanParseFailure, parseAgentPlanOutput, type AgentPlan } from './plan-schema';
import { AGENT_PLAN_SUMMARY_SCHEMAS, validateAgentPlan, type AgentPlanValidation, type AgentPlanValidationContext } from './plan-validator';
import { agentReadWriteProbeClauses } from './read-write-probe';
import { assembleAgentReply, type AssembledAgentReply } from './reply-assembler';
import { a6InPlanGuidance, type AgentStepsPlan } from './reply-notes';
import { AGENT_RUN_BOUNDS, AgentRunBudget, type AgentBoundKind, type AgentRunBoundValues } from './run-bounds';
import { summaryGrantBasis, type SummaryGrantBasis } from './summary-grant';
import { renderSummaryConsentQuestion } from './summary-consent-question';

/**
 * ADR-0121 D1 / D7 (stage S2 P1): `AgentRunService`, the bounded read agent behind the `AgentProfile` id
 * {@link AGENT_PROFILE_ID}. This phase has two modes only:
 *
 * - `off` (the default): nothing runs. The runtime reads `mode` and nothing else, so every turn is byte-identical.
 * - `shadow`: after the reply of an owner DM turn that reached selection, or (`c-shadow`) whose read a Class B grammar
 *   answered (`liveSource: grammar`), ONE background planner call (M1,
 *   after Core's deterministic help split (ADR-0121 A1-E1; logged as `split`, never changing the live reply, A1-E5),
 *   `INTENT_SELECTION`, prompt `agent-plan.vN`) plans the same message; the plan is parsed and validated and one
 *   content-free `agent_run.shadow` line is logged. **Zero connector reads and zero M2 calls**: this service has no
 *   connector, reader, writer, command runner, tool provider, memory or fetch dependency at all (its deps type below; an
 *   import-scan test pins it). It writes nothing but the owner's kill switch.
 * - `active` (the S2 wiring slice, {@link AgentRunService.runActive}): one bounded run of a validated multi-step read plan —
 *   the planner (M1) charged on the run budget before step 1, the re-plan (M1') reserved explicitly, the executor over the
 *   injected read ports, the summary grants derived from the owner's own words (`summary-grant.ts`), and the deterministic
 *   reply assembler. A failure or a bound breach after planning ends in the assembler's deterministic partial reply, never a
 *   retry. The release gate stays at startup (`agent-config.ts`, `AGENT_MODE_ACTIVE_NOT_RELEASED`) until the ADR-0121 D11
 *   gates pass (stage S2 P5); the constructor refuses `active` without its read ports and M2 selector
 *   (`AGENT_MODE_ACTIVE_UNWIRED`). No runtime dispatch calls it yet (P5: the single-M1 unification of S2 plan Q2).
 *
 * Shadow bounds: at most one job in flight (others are dropped), at most 30 started per rolling hour and 150 per rolling
 * day per actor (ADR-0121 D7), the whole job (provider resolution included) inside the selection bound, an AbortSignal
 * that `stopBackground()` (shutdown) and the bound abort, the D3 input preparation, the pre-egress credential guard, the
 * ADR-0120 D6/D8 provider family and locality rule (the planner goes only where this turn's chat would go) and the D4
 * canary check (no untrusted byte in the planner prompt).
 *
 * Kill switch (D7, reused by note): the owner's `에이전트 중지` / `에이전트 재개` flip the existing
 * `Actor.metadata['quoky.actionSwitch']` (A6-D3; one switch stops A6 actions and the agent). It is checked before a job
 * is scheduled (the turn's actor snapshot) and again when the job starts (the live actor), so a stop takes effect
 * without a restart and a resume restores shadow runs.
 */

export type AgentMode = 'off' | 'shadow' | 'active';
export const AGENT_MODES: readonly AgentMode[] = ['off', 'shadow', 'active'];
/** ADR-0121 D1: the one `AgentProfile` id that selects the bounded runtime. */
export const AGENT_PROFILE_ID = 'quoky.read-agent';
/** ADR-0121 D7 per-actor run caps (a shadow plan counts as a run). */
export const AGENT_SHADOW_MAX_PER_HOUR = 30;
export const AGENT_SHADOW_MAX_PER_DAY = 150;
/**
 * S2 plan Q7 (owner-approved defaults of 2026-10-20, recorded in the P1 note): at most 60 agent model calls per rolling hour per
 * actor in `active` (M1, M1' and every M2 call; a run's budget gets only what the hour has left).
 */
export const AGENT_ACTIVE_MAX_MODEL_CALLS_PER_HOUR = 60;
/** Review round 1 item 2: the fewest model calls an admitted run needs, the planner (M1) and the re-plan slot (M1'). */
export const AGENT_ACTIVE_MIN_MODEL_CALLS = 2;
/**
 * The bound of a shadow job when none is configured: the ADR-0120 A3 selection bound, 10 s since the owner decision of
 * 2026-10-28 (the planner shares the selector's capability at high effort). The app passes the configured selection bound.
 */
export const AGENT_SHADOW_DEFAULT_TIMEOUT_MS = 10_000;
export const AGENT_SHADOW_LOG_EVENT = 'agent_run.shadow';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const AGENT_ACTIVE_LOG_EVENT = 'agent_run.active';

export class AgentModeError extends Error {
  constructor(readonly code: 'AGENT_MODE_ACTIVE_NOT_RELEASED' | 'AGENT_MODE_ACTIVE_UNWIRED') {
    super(code);
    this.name = 'AgentModeError';
  }
}

/**
 * Which route answered the turn live (closed): the ADR-0120 selection routes, or `grammar` when a frozen Class B grammar
 * answered a read under `c-shadow` and selection never ran (live DM test 2026-10-20).
 */
export type AgentShadowLiveSource = 'chat' | 'personal-data' | 'class-b' | 'work-surface' | 'grammar';

/** What the live turn decided (closed values only), for the one-step agreement. */
export interface AgentShadowLive {
  readonly kind: 'execute' | 'ask' | 'none';
  /**
   * The route of the fresh read / none / question decision (logged as `liveSource`). With `grammar` the decision is the
   * grammar's own catalog equivalent (`execute`), and `entryId` is absent when the grammar maps to no catalog entry.
   */
  readonly source?: AgentShadowLiveSource;
  readonly entryId?: NlCatalogEntryId;
  readonly args?: NlArgs;
}

export interface AgentShadowTurn {
  readonly text: string;
  readonly attachmentCount: number;
  readonly quotedRanges?: readonly InboundQuotedRange[];
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** The entries offered this turn; the planner sees the READ ones only. */
  readonly entries: readonly NlCatalogEntry[];
  /** The previous selection as structure only (the turn's snapshot). */
  readonly previous?: { readonly entryId: NlWave1EntryId; readonly args: NlArgs };
  readonly direct: boolean;
  readonly live: AgentShadowLive;
}

/** One owner turn for an `active` run (the same snapshot a shadow job takes, plus the session for M2's owner policy). */
export interface AgentActiveTurn {
  readonly text: string;
  readonly attachmentCount: number;
  readonly quotedRanges?: readonly InboundQuotedRange[];
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** The entries offered this turn; the planner sees the READ ones only. */
  readonly entries: readonly NlCatalogEntry[];
  /** The previous selection as structure only (the turn's snapshot). */
  readonly previous?: { readonly entryId: NlWave1EntryId; readonly args: NlArgs };
  readonly direct: boolean;
  /** The conversation session: M2's base selection context (the owner's session-scoped policy), data only. */
  readonly sessionId?: Id;
  /**
   * Rule ① (CS-1a): the conversation the question is asked in (`platform|spaceId|channelId|threadId`), the second half of the
   * pending step's scope. Absent: no question can be opened, so a step that would ask stays listing-only.
   */
  readonly conversationKey?: string;
  /**
   * Rule ① (CS-1a, W2): an approval, scope clarification, override, connector-write step or channel grant is pending for this
   * owner. Set by the runtime. `true`: a step that would ask stays listing-only (`consent-owner-step-open`).
   */
  readonly ownerStepPending?: boolean;
}

/**
 * What an `active` turn came to (closed values only):
 * - `reply`: a validated multi-step `run` plan was executed; the reply is the assembler's (complete or partial);
 * - `one-step`: a validated one-step read plan. S2 plan Q2 gives it to the existing selection path unchanged; that dispatch is
 *   stage P5 and is not wired here;
 * - `declined`: nothing ran (not admitted, the kill switch, a cap, the egress or canary rule, the planner failed or timed out,
 *   or the plan is `none`, a question, a refusal, a help split or leaves a write clause). The reason is a closed value.
 */
export type AgentActiveOutcome =
  | { readonly kind: 'reply'; readonly reply: AssembledAgentReply; readonly outcome: 'complete' | 'partial'; readonly breach?: AgentBoundKind; readonly stopped?: true }
  | { readonly kind: 'one-step'; readonly plan: AgentStepsPlan }
  | { readonly kind: 'declined'; readonly reason: string };

export interface AgentRunServiceDeps {
  readonly mode: AgentMode;
  /** The capability router; the service asks it for `INTENT_SELECTION` only. */
  readonly router: { select(capability: Capability): Promise<AiProvider> };
  /** The live Actor repository: the kill switch is read at a job's start and written by the owner's phrase. */
  readonly actors: { get(id: Id): Promise<Actor | null>; save(actor: Actor): Promise<Actor> };
  readonly logger: Logger;
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  /** The selection bound (`QUOKY_NL_INTENT_TIMEOUT_MS`); the whole shadow job runs inside it. */
  readonly timeoutMs?: number;
  /** Tests only: monotonic milliseconds (default `Date.now`). */
  readonly elapsed?: () => number;
  /** Tests only: other per-actor caps. */
  readonly caps?: { readonly perHour?: number; readonly perDay?: number };
  /**
   * `active` only (S2 wiring slice): the narrow read ports by catalog read entry, built by the composition root. An entry with
   * no port is `not-run` (`no-reader`) for the run.
   */
  readonly readers?: AgentReadPorts;
  /** `active` only: M2's route, the existing provider selector (ADR-0121 D12; no model list, no new port). */
  readonly summarizer?: ProviderSelector;
  /**
   * `active` only (ADR-0121 A5-S1): the work sources whose agent summary readout the owner switched on, one switch each
   * (`QUOKY_AGENT_SUMMARY_*`, default off, independent of `QUOKY_WORK_SUMMARY_ENABLED`). Absent or empty: the summarize step
   * is exactly as before A5 (every work source `listing-only`).
   */
  readonly workSummarySources?: readonly AgentWorkSummarySource[];
  /**
   * Tests only: tighter run-bound values. Each is clamped to the ratified {@link AGENT_RUN_BOUNDS} value (`min`), so a
   * caller can only lower a bound, never raise one (review round 1 item 5).
   */
  readonly bounds?: Partial<AgentRunBoundValues>;
  /**
   * `active` only: the stage S2 P5 release, set by the composition root only once the D11 gates passed. Absent or `false`, the
   * constructor refuses `active` (`AGENT_MODE_ACTIVE_UNWIRED`): the second layer behind the startup release gate
   * (`agent-config.ts`), so a config change alone can never build an `active` service (review round 1 item 5).
   */
  readonly released?: boolean;
  /**
   * ADR-0121 A7 (A7-S1): the closed deployment context of the cross-source write plan, passed to the plan validator only. Absent
   * (the default): A7 is off and an A7 plan is refused. Even when set, a validated A7 plan is not runnable (A7-S4 builds the card).
   */
  readonly crossWrite?: AgentCrossWriteContext;
  /**
   * `active` only, rule ① (CS-1a, `QUOKY_SUMMARY_CONSENT=on`): the one process-wide store of pending consent steps. Present: a
   * summarize step that would send items to a `REMOTE` model asks first (the question, then a pending step in this store).
   * Absent (the default): no question and no step, and `REMOTE` is never allowed (the unconditional guard in `quarantined-summary.ts`).
   */
  readonly consentStore?: ConsentPendingStore;
  /**
   * `active` only, rule ① (CS-1a): the recipient's display name of a `REMOTE` provider (`QuarantinedSummarizerRoute.recipientLabel`),
   * a closed map over the provider family built in `apps/quoky`. Absent: no `REMOTE` provider has a name, so none can be asked about.
   */
  readonly recipientLabel?: (provider: AiProvider) => string | undefined;
}

/** CS-1a: the continuation records are in memory only, at most this many, each for W2's 600 s. */
export const AGENT_SUMMARY_CONTINUATION_MAX_RECORDS = 64;
export const AGENT_SUMMARY_CONTINUATION_TTL_MS = 600_000;

/**
 * What the continuation (CS-1b) needs to re-run one asked summary step after the owner's yes: the same validated plan object
 * (so the grant basis still matches it), the gated reads and their reference ancestors plus the summarize step, and the run's
 * owner and session. Structure and owner-grounded literals only: no item content and no document.
 */
export interface AgentSummaryContinuation {
  readonly plan: ValidatedRunPlan;
  readonly basis: SummaryGrantBasis;
  readonly summaryStep: number;
  /** Step numbers, ascending: the summarize step, the reads it covers and their reference ancestors. */
  readonly steps: readonly number[];
  readonly sessionId?: Id;
  readonly actorId: Id;
  readonly createdAtMs: number;
}

type ValidatedRunPlan = Parameters<AgentPlanExecutor['execute']>[0];

type ShadowOutcome = 'planned' | 'handoff' | 'cross-write' | 'clarify' | 'ask' | 'none' | 'refused' | 'malformed' | 'skipped' | 'unavailable' | 'dropped' | 'stopped' | 'timeout';

class ShadowTimeout extends Error {
  constructor() {
    super('agent shadow timed out');
    this.name = 'ShadowTimeout';
  }
}

export class AgentRunService {
  readonly mode: AgentMode;
  /** The last shadow job (tests await it; production never does). */
  lastShadowRun: Promise<void> = Promise.resolve();
  private readonly background = new AbortController();
  private inFlight = false;
  private readonly starts = new Map<Id, number[]>();
  /** CA P3 6: drop times per live origin (grammar vs selection), for the content-free `originDropsLastHour` count. */
  private readonly drops: Record<'grammar' | 'selection', number[]> = { grammar: [], selection: [] };
  private readonly killSwitch: NlActionSwitch;
  /** `active`: model calls charged per actor, as (time, count), for the rolling-hour cap of S2 plan Q7. */
  private readonly modelCalls = new Map<Id, Array<{ readonly at: number; count: number }>>();
  /** `active`: the actors with a run in flight (one at a time per actor, as shadow keeps one job in flight). */
  private readonly activeInFlight = new Set<Id>();
  /** Rule ① (CS-1a): `runRef` to the continuation record of an asked step. In memory only; dropped on use, expiry and `voidAllSummaryConsents`. */
  private readonly continuations = new Map<string, AgentSummaryContinuation>();

  constructor(private readonly deps: AgentRunServiceDeps) {
    // The release gate is at startup (`agent-config.ts`, until the D11 gates and stage S2 P5). Here, the second layer: `active`
    // needs the explicit P5 release and its wiring, the read ports and M2's selector (fail closed: never an `active` service
    // that is not released or cannot read or route M2).
    if (deps.mode === 'active' && (deps.released !== true || deps.readers === undefined || deps.summarizer === undefined)) {
      throw new AgentModeError('AGENT_MODE_ACTIVE_UNWIRED');
    }
    this.mode = deps.mode;
    this.killSwitch = new NlActionSwitch({ actors: deps.actors, logger: deps.logger });
  }

  /** The switch as this actor snapshot holds it (`running` by default). */
  switchState(actor: Pick<Actor, 'metadata'> | undefined): NlActionSwitchState {
    return actor === undefined ? 'running' : readActionSwitch(actor).state;
  }

  /**
   * Whether a shadow job may be scheduled for this turn (checked before scheduling, on the turn's actor snapshot): mode
   * `shadow`, the owner's DM, the kill switch running and no shutdown. A stopped switch logs one content-free line.
   */
  shadowAdmits(actor: Actor, direct: boolean): boolean {
    if (this.mode !== 'shadow' || !direct || this.background.signal.aborted) return false;
    if (this.switchState(actor) === 'stopped') {
      this.logShadow({ outcome: 'stopped', reason: 'kill-switch', at: 'schedule' });
      return false;
    }
    return true;
  }

  /**
   * The shadow job. Never throws; the caller starts it only after the reply was handed back. One planner call at most,
   * zero connector reads, zero M2 calls; the only output is one {@link AGENT_SHADOW_LOG_EVENT} line.
   */
  runShadow(
    turn: AgentShadowTurn,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
  ): Promise<void> {
    if (this.mode !== 'shadow' || !turn.direct || this.background.signal.aborted) return Promise.resolve();
    const clock = this.deps.elapsed ?? Date.now;
    const nowMs = clock();
    const starts = (this.starts.get(turn.actor.id) ?? []).filter((at) => nowMs - at < DAY_MS);
    this.starts.set(turn.actor.id, starts);
    const perHour = this.deps.caps?.perHour ?? AGENT_SHADOW_MAX_PER_HOUR;
    const perDay = this.deps.caps?.perDay ?? AGENT_SHADOW_MAX_PER_DAY;
    const lastHour = starts.filter((at) => nowMs - at < HOUR_MS).length;
    if (this.inFlight || lastHour >= perHour || starts.length >= perDay) {
      // CA P3 6: which origin was dropped and how often in the rolling hour, so grammar turns crowding out selection-turn
      // shadows under the cap is visible (closed values and a count only).
      const origin = turn.live.source === 'grammar' ? 'grammar' : 'selection';
      const recent = this.drops[origin].filter((at) => nowMs - at < HOUR_MS);
      recent.push(nowMs);
      this.drops[origin] = recent;
      this.logShadow({
        outcome: 'dropped',
        reason: this.inFlight ? 'in-flight' : lastHour >= perHour ? 'hourly-cap' : 'daily-cap',
        ...liveFields(turn.live),
        origin,
        originDropsLastHour: recent.length,
      });
      return Promise.resolve();
    }
    this.inFlight = true;
    starts.push(nowMs);
    const job = new AbortController();
    const stop = (): void => job.abort();
    this.background.signal.addEventListener('abort', stop, { once: true });
    const timeoutMs = this.deps.timeoutMs ?? AGENT_SHADOW_DEFAULT_TIMEOUT_MS;
    const work = this.shadow(turn, resolveChat, job.signal, nowMs);
    this.lastShadowRun = withTimeout(work, timeoutMs, job.signal)
      .catch((error: unknown) => {
        job.abort();
        if (error instanceof ShadowTimeout) {
          if (!this.background.signal.aborted) this.logShadow({ outcome: 'timeout', latencyMs: Math.max(0, clock() - nowMs) });
        } else {
          this.log('warn', 'agent_run.shadow_failed', { errorName: error instanceof Error ? error.name : typeof error });
        }
      })
      .finally(() => {
        this.inFlight = false;
        this.background.signal.removeEventListener('abort', stop);
      });
    return this.lastShadowRun;
  }

  /**
   * ADR-0121 S2 wiring slice: one bounded `active` run for an owner DM turn. Total: never throws or rejects.
   *
   * 1. Admission: mode `active`, the owner's DM, no shutdown, one run in flight per actor, the per-actor caps (D7: 30 an hour,
   *    150 a day; shared with shadow) and S2 plan Q7 (60 agent model calls per rolling hour: at least 2 left, M1 and M1'; the
   *    run's model-call bound is what the hour has left, charged in full at admission and trued down when the run ends).
   * 2. The kill switch on the LIVE actor (fail closed: an unreadable switch declines).
   * 3. The planner exactly as the shadow job prepares it: the D3 input preparation, the pre-egress credential guard, the
   *    ADR-0120 D6/D8 provider family and locality rule, the D4 label rule and the canary check. The kill switch is read again
   *    right before the planner is dispatched (nothing awaits in between). Its call and its prompt bytes
   *    are charged on the run's budget BEFORE it is sent (D3/D7 amendment wiring requirement), inside the selection bound and
   *    the run's wall.
   * 4. A validated multi-step `run` plan only. The re-plan (M1', built but off, S2 plan Q12) is reserved explicitly before step
   *    1, so the summaries plan within what the run has left (8 model calls = M1 + M1' + 6 M2).
   * 5. The executor (the kill switch re-read before every step within the wall; shutdown cuts the run; the summary grants from
   *    the owner's own words), then the
   *    deterministic assembler. Any failure or bound breach is the assembler's partial reply; nothing is retried.
   *
   * One content-free {@link AGENT_ACTIVE_LOG_EVENT} line per call.
   */
  async runActive(
    turn: AgentActiveTurn,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
  ): Promise<AgentActiveOutcome> {
    const clock = this.deps.elapsed ?? Date.now;
    const startedMs = safeClock(clock);
    const latency = (): number => Math.max(0, safeClock(clock) - startedMs);
    const declined = (reason: string, fields: LogFields = {}): AgentActiveOutcome => {
      this.log('info', AGENT_ACTIVE_LOG_EVENT, { mode: 'active', outcome: 'declined', reason, ...fields, latencyMs: latency() });
      return { kind: 'declined', reason };
    };
    try {
      if (this.mode !== 'active') return { kind: 'declined', reason: 'not-active' };
      if (!turn.direct) return declined('not-dm');
      if (this.background.signal.aborted) return declined('shutdown');
      const readers = this.deps.readers;
      const selector = this.deps.summarizer;
      if (readers === undefined || selector === undefined) return declined('unwired');
      // One run in flight per actor (review round 1 item 3): a concurrent turn never adds a second run's model calls.
      if (this.activeInFlight.has(turn.actor.id)) return declined('in-flight');
      // D7 per-actor caps (a run counts when it is admitted; the same rolling windows as shadow).
      const starts = (this.starts.get(turn.actor.id) ?? []).filter((at) => startedMs - at < DAY_MS);
      this.starts.set(turn.actor.id, starts);
      const perHour = this.deps.caps?.perHour ?? AGENT_SHADOW_MAX_PER_HOUR;
      const perDay = this.deps.caps?.perDay ?? AGENT_SHADOW_MAX_PER_DAY;
      if (starts.filter((at) => startedMs - at < HOUR_MS).length >= perHour) return declined('hourly-cap');
      if (starts.length >= perDay) return declined('daily-cap');
      // S2 plan Q7: what the rolling hour has left of 60 agent model calls. A run needs its planner call AND the re-plan slot
      // reserved before step 1 (review round 1 item 2): with fewer than 2 left it is declined here, never started.
      const calls = (this.modelCalls.get(turn.actor.id) ?? []).filter((entry) => startedMs - entry.at < HOUR_MS);
      this.modelCalls.set(turn.actor.id, calls);
      const hourLeft = AGENT_ACTIVE_MAX_MODEL_CALLS_PER_HOUR - calls.reduce((sum, entry) => sum + entry.count, 0);
      if (hourLeft < AGENT_ACTIVE_MIN_MODEL_CALLS) return declined('model-hourly-cap');
      const bounds = clampedBounds(this.deps.bounds);
      const maxModelCalls = Math.min(bounds.maxModelCalls, hourLeft);
      // Admission charges the run's whole model-call bound at once, synchronously with the checks above (review round 1 item
      // 3); `finally` trues it down to the calls the run actually reserved.
      starts.push(startedMs);
      const charged = { at: startedMs, count: maxModelCalls };
      calls.push(charged);
      this.activeInFlight.add(turn.actor.id);
      let budget: AgentRunBudget | undefined;
      try {
        budget = new AgentRunBudget(clock, { ...bounds, maxModelCalls });
        return await this.admitted(turn, resolveChat, budget, readers, selector, declined, latency);
      } finally {
        this.activeInFlight.delete(turn.actor.id);
        charged.count = budget === undefined ? 0 : safeModelCalls(budget);
      }
    } catch (error) {
      this.log('warn', 'agent_run.active_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return { kind: 'declined', reason: 'failed' };
    }
  }

  /** {@link runActive} once admitted (the run is charged and in flight; the caller trues the charge down). */
  private async admitted(
    turn: AgentActiveTurn,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
    budget: AgentRunBudget,
    readers: AgentReadPorts,
    selector: ProviderSelector,
    declined: (reason: string, fields?: LogFields) => AgentActiveOutcome,
    latency: () => number,
  ): Promise<AgentActiveOutcome> {
    // Review round 2 item 2: every await before the planner dispatch is raced against the run's wall and shutdown, so a hung
    // switch read, chat resolution or router never holds the actor's slot or the hour's charge.
    const cut = (ended: 'wall' | 'shutdown' | 'failed'): AgentActiveOutcome =>
      ended === 'wall' ? declined('bound', { breach: budget.breach ?? 'wall-time' }) : declined(ended);
    // The kill switch on the live actor (never the turn's snapshot); unreadable = declined (fail closed).
    const running = await withinRun(() => this.liveSwitchRunning(turn.actor.id), budget, this.background.signal);
    if (running.kind !== 'ok') return cut(running.kind);
    if (!running.value) return declined('kill-switch');

    const prepared = prepareSelectionInput(turn.text, turn.attachmentCount, turn.quotedRanges ?? []);
    if ('skip' in prepared) return declined(prepared.skip);
    const previousStrings = turn.previous === undefined ? [] : Object.values(turn.previous.args).filter((value): value is string => typeof value === 'string');
    if ([prepared.text, ...previousStrings].some((value) => containsCredentialMaterial(value))) return declined('credential');
    const resolved = await withinRun(resolveChat, budget, this.background.signal);
    if (resolved.kind !== 'ok') return cut(resolved.kind);
    const chat = resolved.value;
    if (chat === undefined) return declined('chat-provider-unknown');
    const selected = await withinRun(
      () => this.deps.router.select(Capability.INTENT_SELECTION).then((value): AiProvider | undefined => value, () => undefined),
      budget,
      this.background.signal,
    );
    if (selected.kind !== 'ok') return cut(selected.kind);
    if (selected.value === undefined) return declined('no-provider');
    const provider = selected.value;
    const egress = nlSameEgress(provider, chat.id, chat.locality);
    if (egress !== 'same') return declined(egress);
    const flow = checkPlannerInputs([
      { label: OWNER_TEXT_FLOW_LABEL },
      { label: CATALOG_FLOW_LABEL },
      ...(turn.previous !== undefined ? [{ label: PREVIOUS_SELECTION_FLOW_LABEL }] : []),
    ]);
    // A1-E1: a help clause asked with other reads is answered as its own section; that composition is stage P5.
    const split = splitHelpClause(prepared, turn.entries);
    if (split !== undefined) return declined('help-split');
    const prompt = buildAgentPlanPrompt({ entries: turn.entries, text: prepared.text, ...(turn.previous !== undefined ? { previous: turn.previous } : {}) });
    if (flow !== undefined || plannerPromptCanaryHit(prompt, untrustedCanariesOf(turn.text, turn.quotedRanges ?? []), prepared.groundingText)) return declined(flow ?? 'canary');
    return await this.runPlanned(turn, prompt, provider, budget, readers, selector, prepared, declined, latency);
  }

  /** {@link runActive} from the planner charge on (the budget is this run's; the caller records its model calls). */
  private async runPlanned(
    turn: AgentActiveTurn,
    prompt: string,
    provider: AiProvider,
    budget: AgentRunBudget,
    readers: AgentReadPorts,
    selector: ProviderSelector,
    prepared: { readonly text: string; readonly groundingText: string },
    declined: (reason: string, fields?: LogFields) => AgentActiveOutcome,
    latency: () => number,
  ): Promise<AgentActiveOutcome> {
    // Review round 1 item 4: the kill switch re-read right before the planner is dispatched. From its answer to the dispatch
    // below nothing awaits, so a stop that the read sees is never followed by a planner call. The read is raced against the
    // wall and shutdown (review round 2 item 2).
    const running = await withinRun(() => this.liveSwitchRunning(turn.actor.id), budget, this.background.signal);
    if (running.kind === 'wall') return declined('bound', { breach: budget.breach ?? 'wall-time' });
    if (running.kind !== 'ok') return declined(running.kind);
    if (!running.value) return declined('kill-switch');
    if (this.background.signal.aborted) return declined('shutdown');
    // D3/D7 amendment (wiring requirement): the planner call and its input are charged on THIS run's budget before step 1.
    if (!budget.reserveModelCall('planner') || !budget.reserveInputTokens(utf8Bytes(prompt))) return declined('bound', { breach: budget.breach ?? 'unknown' });
    const timeoutMs = Math.max(1, Math.min(this.deps.timeoutMs ?? AGENT_SHADOW_DEFAULT_TIMEOUT_MS, budget.remainingMs()));
    const planned = await callWithin(provider, prompt, timeoutMs, this.background.signal);
    const callFields: LogFields = { ...callUsageLogFields(prompt, planned.kind === 'ok' ? planned.usage : undefined) };
    if (planned.kind === 'timeout') return declined('timeout', callFields);
    if (planned.kind === 'failed') return declined('failed', callFields);
    if (!budget.checkWall()) return declined('bound', { breach: budget.breach ?? 'wall-time', ...callFields });
    const plan = parseAgentPlanOutput(planned.text);
    if (plan === null) return declined('malformed', { parse: agentPlanParseFailure(planned.text) ?? 'unknown', ...callFields });
    const offered = new Map(turn.entries.filter((entry) => entry.risk === 'READ').map((entry) => [entry.id, entry] as const));
    const validation = validateAgentPlan(plan, {
      offered,
      groundingText: prepared.groundingText,
      ...(turn.previous !== undefined ? { previousArgs: turn.previous.args, previousEntryId: turn.previous.entryId } : {}),
      now: turn.now,
      timeZone: this.deps.timeZone,
      direct: turn.direct,
      ...(this.deps.crossWrite !== undefined ? { crossWrite: this.deps.crossWrite } : {}),
    });
    if (!validation.ok) return declined('refused', { validator: validation.reason, ...callFields });
    const validated = validation.plan;
    if (validated.kind === 'none') return declined(validated.reason ?? 'none', callFields);
    if (validated.kind === 'ask' || validated.kind === 'clarify') return declined(validated.kind, callFields);
    // ADR-0121 A4 (A4-S1): a validated handoff is not runnable until A4-S2 and its flag `QUOKY_AGENT_HANDOFF` (off): fail closed.
    if (validated.kind === 'handoff') return declined('handoff-off', callFields);
    // ADR-0121 A7 (A7-S1): a validated cross-source write plan is not runnable (no read, draft, card or send is built): fail closed.
    if (validated.kind === 'cross-write') return declined('cross-write-off', callFields);
    // The read + write trigger amendment (2026-10-26): a clause the read plan leaves is a write the owner asked for; the
    // read + write composition is stage P5, so the run never drops it silently.
    if (agentReadWriteProbeClauses(validated, prepared.groundingText).length > 0) return declined('write-clause', callFields);
    if (validated.steps.length === 1) {
      this.log('info', AGENT_ACTIVE_LOG_EVENT, { mode: 'active', outcome: 'one-step', entries: activeEntries(validated), ...callFields, latencyMs: latency() });
      return { kind: 'one-step', plan: validated };
    }

    // M1' (built but off, S2 plan Q12): its one slot is reserved explicitly before step 1, never taken from M2's share later.
    // Admission keeps at least 2 calls for the run, so a refusal here is a breach (the wall): declined, no step runs.
    if (!budget.reserveModelCall('replan')) return declined('bound', { breach: budget.breach ?? 'unknown', ...callFields });
    const executor = new AgentPlanExecutor({
      readers,
      logger: this.deps.logger,
      summarizer: {
        selector,
        selectionContext: { ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}), actorId: turn.actor.id },
        ...(this.deps.workSummarySources !== undefined && this.deps.workSummarySources.length > 0 ? { workSummarySources: this.deps.workSummarySources } : {}),
        ...(this.deps.recipientLabel !== undefined ? { recipientLabel: this.deps.recipientLabel } : {}),
        ...(this.deps.consentStore !== undefined ? { askSummaryConsent: true } : {}),
      },
    });
    // Core's producer: the owner's own words (quoted and pasted text excluded) decide each summary step's grant per source.
    const basis = summaryGrantBasis(validated, prepared);
    const executed = await executor.execute(validated, {
      budget,
      grants: basis,
      stillRunning: () => this.liveSwitchRunning(turn.actor.id),
      // Shutdown cuts the run: no later step starts and the calls in flight are aborted (review round 1 item 5).
      signal: this.background.signal,
    });
    const language = languageOf(turn.text);
    // Rule ① (CS-1a): a step that asks opens its pending step first (or is downgraded to the listing, with the reason).
    const result = this.openSummaryConsent(turn, validated, basis, executed, language);
    const reply = assembleAgentReply({ plan: validated, result, language, destinationIsOwnerDm: turn.direct, logger: this.deps.logger });
    this.log('info', AGENT_ACTIVE_LOG_EVENT, {
      mode: 'active',
      outcome: 'reply',
      run: result.outcome,
      ...(result.breach !== undefined ? { breach: result.breach } : {}),
      ...(result.stopped === true ? { stopped: true } : {}),
      steps: result.steps.length,
      entries: activeEntries(validated),
      modelCalls: result.usage.modelCalls,
      m2Calls: result.usage.m2Calls,
      connectorQueries: result.usage.connectorQueries,
      inputTokens: result.usage.inputTokens,
      ...callFields,
      latencyMs: latency(),
    });
    return {
      kind: 'reply',
      reply,
      outcome: result.outcome,
      ...(result.breach !== undefined ? { breach: result.breach } : {}),
      ...(result.stopped === true ? { stopped: true as const } : {}),
    };
  }

  /**
   * Rule ① (CS-1a, W2): opens the pending summary consent of the one step that asks, and keeps its continuation record. Only with
   * a `consentStore`, in the owner's DM, with a conversation key and no other owner step pending; otherwise (or when the step
   * cannot be minted or the question cannot be rendered) the step is downgraded to `listing-only` (`consent-owner-step-open`) and
   * no question is shown. The step holds ids only, never content. Total: never throws.
   */
  private openSummaryConsent(turn: AgentActiveTurn, plan: ValidatedRunPlan, basis: SummaryGrantBasis, result: AgentRunResult, language: 'ko' | 'en'): AgentRunResult {
    const asked = result.steps.find((step) => step.kind === 'summarize' && step.status === 'consent-needed');
    if (asked === undefined || asked.kind !== 'summarize' || asked.status !== 'consent-needed') return result;
    const downgrade = (reason: string): AgentRunResult => {
      this.log('info', 'agent_run.consent', { outcome: 'declined', reason, sources: asked.sources.length });
      return {
        ...result,
        steps: result.steps.map((step) =>
          step === asked ? { step: asked.step, kind: 'summarize' as const, status: 'listing-only' as const, from: asked.from, schema: asked.schema, reason: 'consent-owner-step-open' as const } : step,
        ),
      };
    };
    try {
      const store = this.deps.consentStore;
      if (store === undefined) return downgrade('no-store');
      if (!turn.direct) return downgrade('not-dm');
      if (turn.ownerStepPending === true) return downgrade('owner-step-open');
      const conversationKey = turn.conversationKey;
      if (typeof conversationKey !== 'string' || conversationKey.trim().length === 0) return downgrade('no-conversation');
      const sources = asked.sources.map(({ source, itemIds }) => ({ source, itemIds }));
      if (renderSummaryConsentQuestion({ language, recipient: asked.recipient, sources: sources.map((entry) => ({ source: entry.source, count: entry.itemIds.length })) }) === '') return downgrade('question');
      const clock = this.deps.elapsed ?? Date.now;
      const createdAtMs = safeClock(clock);
      const runRef = newId();
      const pending = summaryConsentPending({
        scope: { actorId: turn.actor.id, conversationKey },
        language,
        createdAtMs,
        recipient: asked.recipient,
        sources,
        runRef,
      });
      this.rememberContinuation(runRef, {
        plan,
        basis,
        summaryStep: asked.step,
        steps: continuationSteps(plan, asked.step, asked.from),
        ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
        actorId: turn.actor.id,
        createdAtMs,
      });
      store.open(pending);
      this.log('info', 'agent_run.consent', {
        outcome: 'asked',
        sources: sources.length,
        items: sources.reduce((sum, entry) => sum + entry.itemIds.length, 0),
      });
      return result;
    } catch {
      return downgrade('failed');
    }
  }

  private rememberContinuation(runRef: string, record: AgentSummaryContinuation): void {
    for (const [key, held] of this.continuations) if (record.createdAtMs - held.createdAtMs >= AGENT_SUMMARY_CONTINUATION_TTL_MS) this.continuations.delete(key);
    while (this.continuations.size >= AGENT_SUMMARY_CONTINUATION_MAX_RECORDS) {
      const oldest = this.continuations.keys().next();
      if (oldest.done === true) break;
      this.continuations.delete(oldest.value);
    }
    this.continuations.set(runRef, Object.freeze(record));
  }

  /**
   * The continuation record of an asked step, taken once (single use): `undefined` when it is unknown, already taken, dropped or
   * older than W2's 600 s. CS-1b's continuation calls it with the bound consent's `runRef`; nothing calls it in CS-1a.
   */
  takeSummaryContinuation(runRef: string, atMs: number): AgentSummaryContinuation | undefined {
    const record = this.continuations.get(runRef);
    this.continuations.delete(runRef);
    return record !== undefined && Number.isFinite(atMs) && atMs >= record.createdAtMs && atMs - record.createdAtMs < AGENT_SUMMARY_CONTINUATION_TTL_MS ? record : undefined;
  }

  /** The kill switch (CS-2 calls it on every save of `stopped`): every pending summary consent is voided and every continuation record dropped. */
  voidAllSummaryConsents(): void {
    this.continuations.clear();
    this.deps.consentStore?.voidAll();
  }

  /** The persisted kill switch on the live actor: `true` only when it reads `running` (a throw or no actor is a stop). */
  private async liveSwitchRunning(actorId: Id): Promise<boolean> {
    try {
      const live = await this.deps.actors.get(actorId);
      return live !== null && this.switchState(live) === 'running';
    } catch {
      return false;
    }
  }

  /** Shutdown: abort a shadow job in flight (its provider call gets the signal) and refuse later ones. Idempotent. */
  stopBackground(): void {
    this.background.abort();
  }

  /**
   * ADR-0121 D7: the owner's kill-switch phrase while the agent mode is not `off` (owner DM; the caller checks the DM).
   * Persists the same `quoky.actionSwitch` record as A6-D3. `undefined` when the mode is `off` or the text is not the phrase.
   */
  async handleSwitchPhrase(actor: Actor, text: string, now: IsoTimestamp): Promise<string | undefined> {
    if (this.mode === 'off') return undefined;
    const wanted = parseActionSwitchPhrase(text);
    if (wanted === undefined) return undefined;
    const saved = await this.killSwitch.set(actor.id, actor, wanted, now);
    this.log('info', 'agent_run.switch', { state: saved ?? 'unchanged', mode: this.mode });
    return renderAgentSwitchReply(saved, languageOf(text));
  }

  /**
   * The line added to another handler's switch reply (A6 actions or the channel grants answered the phrase and saved the
   * same record) while the agent mode is not `off`; `undefined` otherwise.
   */
  switchSuffix(text: string): string | undefined {
    if (this.mode === 'off') return undefined;
    const wanted = parseActionSwitchPhrase(text);
    return wanted === undefined ? undefined : renderAgentSwitchSuffix(wanted, languageOf(text));
  }

  // ── the job ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async shadow(
    turn: AgentShadowTurn,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
    signal: AbortSignal,
    startedMs: number,
  ): Promise<void> {
    const clock = this.deps.elapsed ?? Date.now;
    const latency = (): number => Math.max(0, clock() - startedMs);
    // The kill switch again, on the live actor: a stop between the reply and the job start wins.
    // Fail closed (Codex P2): a live switch state that cannot be read (the lookup threw, or no actor) skips the job; the
    // turn's snapshot is never trusted here.
    let live: Actor | null;
    try {
      live = await this.deps.actors.get(turn.actor.id);
    } catch {
      live = null;
    }
    if (live === null) {
      this.logShadow({ outcome: 'skipped', reason: 'switch-unknown', at: 'start' });
      return;
    }
    if (this.switchState(live) === 'stopped') {
      this.logShadow({ outcome: 'stopped', reason: 'kill-switch', at: 'start' });
      return;
    }
    if (signal.aborted) return;
    const prepared = prepareSelectionInput(turn.text, turn.attachmentCount, turn.quotedRanges ?? []);
    if ('skip' in prepared) {
      this.logShadow({ outcome: 'skipped', reason: prepared.skip });
      return;
    }
    // ADR-0120 D3 pre-egress credential guard over the complete outgoing request (text and previous args).
    const previousStrings = turn.previous === undefined ? [] : Object.values(turn.previous.args).filter((value): value is string => typeof value === 'string');
    if ([prepared.text, ...previousStrings].some((value) => containsCredentialMaterial(value))) {
      this.logShadow({ outcome: 'skipped', reason: 'credential' });
      return;
    }
    const chat = await resolveChat();
    if (signal.aborted) return;
    if (chat === undefined) {
      this.logShadow({ outcome: 'skipped', reason: 'chat-provider-unknown' });
      return;
    }
    let provider: AiProvider;
    try {
      provider = await this.deps.router.select(Capability.INTENT_SELECTION);
    } catch {
      this.logShadow({ outcome: 'unavailable', reason: 'no-provider', latencyMs: latency() });
      return;
    }
    const egress = nlSameEgress(provider, chat.id, chat.locality);
    if (egress !== 'same') {
      this.logShadow({ outcome: 'skipped', reason: egress });
      return;
    }
    // D4: the planner input is the owner's prepared text, the catalog and the previous selection as structure only.
    const flow = checkPlannerInputs([
      { label: OWNER_TEXT_FLOW_LABEL },
      { label: CATALOG_FLOW_LABEL },
      ...(turn.previous !== undefined ? [{ label: PREVIOUS_SELECTION_FLOW_LABEL }] : []),
    ]);
    // A1-E1: a help clause asked with other reads is split off before planning; only the rest reaches the planner.
    const split = splitHelpClause(prepared, turn.entries);
    const planText = split?.rest ?? prepared.text;
    const groundingText = split?.rest ?? prepared.groundingText;
    const prompt = buildAgentPlanPrompt({ entries: turn.entries, text: planText, ...(turn.previous !== undefined ? { previous: turn.previous } : {}) });
    if (flow !== undefined || plannerPromptCanaryHit(prompt, untrustedCanariesOf(turn.text, turn.quotedRanges ?? []), groundingText)) {
      this.logShadow({ outcome: 'refused', reason: flow ?? 'canary' });
      return;
    }
    if (signal.aborted) return;
    const timeoutMs = this.deps.timeoutMs ?? AGENT_SHADOW_DEFAULT_TIMEOUT_MS;
    let raw: string;
    let callFields: CallUsageLogFields = callUsageLogFields(prompt, undefined);
    try {
      const planned = await provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs, signal });
      raw = planned.text;
      callFields = callUsageLogFields(prompt, planned.usage);
    } catch {
      if (!signal.aborted) this.logShadow({ outcome: 'unavailable', reason: 'failed', latencyMs: latency() });
      return;
    }
    if (signal.aborted) return;
    const plan = parseAgentPlanOutput(raw);
    if (plan === null) {
      this.logShadow({ outcome: 'malformed', reason: agentPlanParseFailure(raw) ?? 'unknown', ...callFields, latencyMs: latency() });
      return;
    }
    const offered = new Map(turn.entries.filter((entry) => entry.risk === 'READ').map((entry) => [entry.id, entry] as const));
    const ctx: AgentPlanValidationContext = {
      offered,
      groundingText,
      ...(turn.previous !== undefined ? { previousArgs: turn.previous.args, previousEntryId: turn.previous.entryId } : {}),
      now: turn.now,
      timeZone: this.deps.timeZone,
      direct: turn.direct,
      ...(this.deps.crossWrite !== undefined ? { crossWrite: this.deps.crossWrite } : {}),
    };
    const validation = validateAgentPlan(plan, ctx);
    // With a help split the live path answered the whole message: the rest plan has no one-step equivalent to agree with.
    const agreement = split !== undefined ? {} : this.agreement(plan, validation, turn);
    // The read + write trigger amendment (2026-10-26): an uncovered clause would get the note's one A6 selection when
    // `active`; shadow makes no second model call (Q1: one planner call) and logs the count only.
    const uncovered = validation.ok ? agentReadWriteProbeClauses(validation.plan, groundingText).length : 0;
    this.logShadow({
      ...planFields(plan, validation),
      ...splitFields(split, validation),
      ...a6Fields(plan, validation, ctx),
      ...(uncovered > 0 ? { uncoveredClauses: uncovered } : {}),
      ...agreement,
      ...liveFields(turn.live),
      ...callFields,
      latencyMs: latency(),
    });
  }

  /** One-step plans only: whether the plan agrees with the live selection (entry, and meaning as S1 W3 defines it). */
  private agreement(plan: AgentPlan, validation: AgentPlanValidation, turn: AgentShadowTurn): LogFields {
    // A grammar answer with no catalog equivalent has nothing to agree with: no agreement fields.
    if (turn.live.source === 'grammar' && turn.live.entryId === undefined) return {};
    if (plan.kind === 'none') {
      const agree = turn.live.kind === 'none';
      return { agree, agreeEntry: agree };
    }
    if (plan.steps.length !== 1 || plan.form === 'steps' && plan.handoff !== undefined) return {};
    // A `veto-*` refusal (ADR-0120 A7, not a request) is answered as chat, exactly as the live path's vetoed `none`
    // (CA P2 on S2 P2): it agrees with a live none.
    if (!validation.ok && validation.reason.startsWith('veto-')) {
      const agree = turn.live.kind === 'none';
      return { agree, agreeEntry: agree };
    }
    if (!validation.ok) return { agree: false, agreeEntry: false };
    if (validation.plan.kind === 'clarify') {
      const agree = turn.live.kind === 'ask';
      return { agree, agreeEntry: agree };
    }
    const step = validation.plan.kind === 'run' ? validation.plan.steps[0] : undefined;
    if (step === undefined || step.kind !== 'read' || turn.live.kind !== 'execute' || turn.live.entryId === undefined) return { agree: false, agreeEntry: false };
    const id = step.entry.id;
    const agreeEntry = id === turn.live.entryId;
    const agree =
      agreeEntry &&
      isNlWave1EntryId(id) &&
      nlSelectionMeaning({ entryId: id, args: step.args }, step.entry, turn.now, this.deps.timeZone) ===
        nlSelectionMeaning({ entryId: id, args: turn.live.args ?? {} }, step.entry, turn.now, this.deps.timeZone);
    return { agree, agreeEntry };
  }

  private logShadow(fields: LogFields & { readonly outcome: ShadowOutcome }): void {
    this.log('info', AGENT_SHADOW_LOG_EVENT, { mode: 'shadow', promptVersion: AGENT_PLAN_PROMPT_VERSION, ...fields });
  }

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

/**
 * The content-free plan fields: the step count, the closed entry ids (or `summarize:<schema>`), the argument kinds per
 * step (catalog arg kinds and `ref`, never a value), and the validator outcome. A model-made id is never copied: an id
 * that is not a closed catalog id is logged as `unknown`.
 */
function planFields(plan: AgentPlan, validation: AgentPlanValidation): LogFields & { readonly outcome: ShadowOutcome } {
  if (plan.kind === 'none') return { outcome: validation.ok ? 'none' : 'refused', steps: 0, form: plan.form, validator: validation.ok ? 'ok' : validation.reason };
  const entries = plan.steps.map((step) => (step.kind === 'summarize' ? `summarize:${closedSchema(step.schema)}` : closedEntryId(step.entryId)));
  const fields: LogFields = {
    steps: plan.steps.length,
    form: plan.form,
    entries: entries.join(','),
    ambiguity: plan.ambiguity,
    validator: validation.ok ? 'ok' : validation.reason,
  };
  if (!validation.ok) {
    return { outcome: 'refused', ...fields, ...(validation.step !== undefined ? { failedStep: validation.step } : {}), ...(validation.stepReason !== undefined ? { stepReason: validation.stepReason } : {}) };
  }
  // Rule 7: the read plan left a write clause; the turn goes to the read + write path (logged as a closed reason).
  if (validation.plan.kind === 'none') return { outcome: 'none', ...fields, ...(validation.plan.reason !== undefined ? { noneReason: validation.plan.reason } : {}) };
  // Decision (h): an unbounded plan is an ask with a bounded suggestion (closed bound, closed entry ids only).
  if (validation.plan.kind === 'ask') {
    const suggestion = validation.plan.suggestion.map((step) => (step.kind === 'summarize' ? `summarize:${step.schema}` : step.entry.id)).join(',');
    return { outcome: 'ask', ...fields, bound: validation.plan.bound, suggestion };
  }
  if (validation.plan.kind === 'cross-write') {
    const cross = validation.plan;
    return { outcome: 'cross-write', ...fields, connectorCalls: cross.connectorCalls, crossForm: cross.form, crossTarget: cross.target, crossDestination: cross.destination.state };
  }
  if (validation.plan.kind === 'handoff') {
    const { handoff } = validation.plan;
    return { outcome: 'handoff', ...fields, connectorCalls: validation.plan.connectorCalls, handoffKind: handoff.kind, handoffScope: handoff.scope, handoffSlot: `${handoff.to.entry.id}.${handoff.to.slot}` };
  }
  const extra: LogFields = { connectorCalls: validation.plan.connectorCalls, ...(validation.plan.related !== undefined ? { related: validation.plan.related } : {}) };
  const argKinds = validation.plan.steps
    .map((step) => {
      if (step.kind === 'summarize') return 'summary';
      const kinds = Object.keys(step.args).map((name) => step.entry.args.find((spec) => spec.name === name)?.kind ?? 'unknown');
      if (step.ref !== undefined) kinds.push('ref');
      return [...new Set(kinds)].sort().join('+') || 'none';
    })
    .join(';');
  return { outcome: validation.plan.kind === 'clarify' ? 'clarify' : 'planned', ...fields, argKinds, ...extra };
}

/**
 * A1-E5: the closed `split` field — `help` (a help clause was split off; `helpTopic` is the help entry's own closed enum
 * value), `brief` (a validated plan of two or more steps holds the brief) or `none`. The `validator` field is the rest
 * plan's. Shadow only: the split never changes the live reply.
 */
function splitFields(split: AgentHelpSplit | undefined, validation: AgentPlanValidation): LogFields {
  if (split !== undefined) return { split: 'help', helpTopic: split.topic };
  const brief = validation.ok && validation.plan.kind !== 'none' && validation.plan.kind !== 'ask' && validation.plan.kind !== 'cross-write' && validation.plan.steps.length > 1 && validation.plan.steps.some((step) => step.kind === 'read' && step.entry.id === 'brief.today');
  return { split: brief ? 'brief' : 'none' };
}

/** Decision (f): for an `a6-in-plan` refusal, the closed action kind and whether a read remainder validates (no content). */
function a6Fields(plan: AgentPlan, validation: AgentPlanValidation, ctx: AgentPlanValidationContext): LogFields {
  if (validation.ok || validation.reason !== 'a6-in-plan') return {};
  // The refusal is structural (`isNlActionEntryId`, whatever is offered); the remainder validates against the same READ offer.
  const guidance = a6InPlanGuidance(plan, ctx, 'ko', validation);
  return guidance === undefined ? {} : { a6Kind: guidance.kind, a6Remainder: guidance.remainder !== undefined ? 'run' : 'none' };
}

const LIVE_SOURCES: ReadonlySet<string> = new Set(['chat', 'personal-data', 'class-b', 'work-surface', 'grammar']);

/** The live decision's closed kind and route (never an argument). */
function liveFields(live: AgentShadowLive): LogFields {
  return { liveKind: live.kind, liveSource: live.source !== undefined && LIVE_SOURCES.has(live.source) ? live.source : 'unknown' };
}

/** Catalog ids are closed; anything else the model wrote is reported as `unknown`, never echoed. */
function closedEntryId(id: string): string {
  return isNlCatalogEntryId(id) ? id : 'unknown';
}

function closedSchema(schema: string): string {
  return (AGENT_PLAN_SUMMARY_SCHEMAS as readonly string[]).includes(schema) ? schema : 'unknown';
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShadowTimeout()), timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', () => reject(new ShadowTimeout()), { once: true });
  });
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The closed entry ids of a validated plan (`summarize:<schema>` for a summary): never an argument. */
function activeEntries(plan: AgentStepsPlan): string {
  return plan.steps.map((step) => (step.kind === 'summarize' ? `summarize:${step.schema}` : step.entry.id)).join(',');
}

/** The prompt's UTF-8 byte length: the run's input bound unit (D7 as amended 2026-11-16; a true upper bound of tokens). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function safeClock(clock: () => number): number {
  try {
    const now = clock();
    return Number.isFinite(now) ? now : 0;
  } catch {
    return 0;
  }
}

/**
 * One pre-dispatch await that cannot outlive the run's wall or the shutdown (review round 2 item 2; the executor's
 * `stillRunningWithinWall` pattern): `wall` (with the wall breach marked) when the wall ends first, `shutdown` when the
 * service stops first, `failed` on a throw or rejection. Never rejects; its timer and listener are always removed.
 */
async function withinRun<T>(
  work: () => Promise<T>,
  budget: AgentRunBudget,
  shutdown: AbortSignal,
): Promise<{ readonly kind: 'ok'; readonly value: T } | { readonly kind: 'wall' | 'shutdown' | 'failed' }> {
  if (shutdown.aborted) return { kind: 'shutdown' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const cut = new Promise<{ readonly kind: 'wall' | 'shutdown' }>((resolve) => {
    timer = setTimeout(() => {
      try {
        budget.markBreach('wall-time');
      } catch {
        // A budget that throws is still a wall.
      }
      resolve({ kind: 'wall' });
    }, Math.max(1, remainingOrZero(budget)));
    stop = () => resolve({ kind: 'shutdown' });
    shutdown.addEventListener('abort', stop, { once: true });
  });
  try {
    const done = Promise.resolve()
      .then(work)
      .then(
        (value) => ({ kind: 'ok' as const, value }),
        () => ({ kind: 'failed' as const }),
      );
    return await Promise.race([done, cut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop !== undefined) shutdown.removeEventListener('abort', stop);
  }
}

function remainingOrZero(budget: AgentRunBudget): number {
  try {
    return budget.remainingMs();
  } catch {
    return 0;
  }
}

/** One planner call that cannot outlive `timeoutMs` or the shutdown signal; never rejects. */
async function callWithin(
  provider: AiProvider,
  prompt: string,
  timeoutMs: number,
  shutdown: AbortSignal,
): Promise<{ readonly kind: 'ok'; readonly text: string; readonly usage: Parameters<typeof callUsageLogFields>[1] } | { readonly kind: 'timeout' } | { readonly kind: 'failed' }> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  shutdown.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => resolve({ kind: 'timeout' }), { once: true });
  });
  try {
    // Dispatched synchronously (a sync throw is a failure), so no await sits between the caller's switch read and the call.
    let started: Promise<Awaited<ReturnType<AiProvider['execute']>>>;
    try {
      started = Promise.resolve(provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs, signal: controller.signal }));
    } catch (error) {
      started = Promise.reject(error);
    }
    const call = started
      .then(
        (result) => ({ kind: 'ok' as const, text: result.text, usage: result.usage }),
        () => ({ kind: 'failed' as const }),
      );
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    shutdown.removeEventListener('abort', stop);
    controller.abort();
  }
}

/**
 * The run bounds for `active`: each injected value lowered to at most the ratified one (`min`); a missing or non-finite
 * value is the ratified one. Never raises a bound.
 */
function clampedBounds(bounds: Partial<AgentRunBoundValues> | undefined): AgentRunBoundValues {
  const out: Record<string, number> = { ...AGENT_RUN_BOUNDS };
  for (const key of Object.keys(AGENT_RUN_BOUNDS) as (keyof AgentRunBoundValues)[]) {
    const value = bounds?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.min(value, AGENT_RUN_BOUNDS[key]);
  }
  return out as unknown as AgentRunBoundValues;
}

/** The model calls a budget reserved (0 when its snapshot throws). */
function safeModelCalls(budget: AgentRunBudget): number {
  try {
    return budget.snapshot().modelCalls;
  } catch {
    return 0;
  }
}

/** The step numbers a continuation re-runs: the summarize step, the reads it covers and, transitively, the reads their references name. */
function continuationSteps(plan: ValidatedRunPlan, summaryStep: number, from: readonly number[]): readonly number[] {
  const keep = new Set<number>([summaryStep, ...from]);
  for (const number of [...keep].sort((a, b) => b - a)) {
    let current = plan.steps[number - 1];
    while (current !== undefined && current.kind === 'read' && current.ref !== undefined && !keep.has(current.ref.step)) {
      keep.add(current.ref.step);
      current = plan.steps[current.ref.step - 1];
    }
  }
  return Object.freeze([...keep].sort((a, b) => a - b));
}

function languageOf(text: string): 'ko' | 'en' {
  return /[ㄱ-ㆎ가-힣]/u.test(text) ? 'ko' : 'en';
}

/** The fixed replies of the kill-switch phrase when the agent answers it (A6 actions and channel grants off). */
export function renderAgentSwitchReply(state: NlActionSwitchState | undefined, language: 'ko' | 'en' = 'ko'): string {
  if (state === undefined) {
    return language === 'en'
      ? 'I could not save the switch. The multi-step agent keeps its previous state; please try again.'
      : '스위치를 저장하지 못했어요. 다단계 에이전트는 이전 상태 그대로예요. 다시 시도해 주세요.';
  }
  if (state === 'stopped') {
    return language === 'en'
      ? 'The multi-step agent is stopped. Exact commands still work. Send "에이전트 재개" to resume.'
      : '다단계 에이전트를 멈췄어요. 정확한 명령은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
  }
  return language === 'en' ? 'The multi-step agent is running again.' : '다단계 에이전트를 다시 켰어요.';
}

/** The line added when another handler saved the switch (the same record also stops or resumes the agent). */
export function renderAgentSwitchSuffix(state: NlActionSwitchState, language: 'ko' | 'en' = 'ko'): string {
  if (state === 'stopped') return language === 'en' ? 'The multi-step agent is stopped too.' : '다단계 에이전트도 함께 멈췄어요.';
  return language === 'en' ? 'The multi-step agent is running again too.' : '다단계 에이전트도 함께 다시 켰어요.';
}
