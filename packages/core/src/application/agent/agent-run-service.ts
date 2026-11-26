import { Capability, type Actor, type Id, type InboundQuotedRange, type IsoTimestamp } from '../../domain';
import { CATALOG_FLOW_LABEL, OWNER_TEXT_FLOW_LABEL, PREVIOUS_SELECTION_FLOW_LABEL } from '../../domain/flow-label';
import type { AiExecutionLocality, AiProvider } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { AgentWriteProposalPort } from '../../ports/agent-write-proposal.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import { newId } from '../../util/id';
import { callUsageLogFields, type CallUsageLogFields } from '../call-usage-log-fields';
import { containsCredentialMaterial } from '../credential-guard';
import { summaryConsentPending, type BoundConsent, type ConsentPendingStore } from '../consent-answer/consent-pending';
import { NlActionSwitch, parseActionSwitchPhrase, readActionSwitch, type NlActionSwitchState } from '../nl-routing/action-switch';
import { isNlCatalogEntryId, isNlWave1EntryId, type NlArgs, type NlCatalogEntry, type NlCatalogEntryId, type NlWave1EntryId } from '../nl-routing/catalog';
import { nlSameEgress } from '../nl-routing/selection-egress';
import { nlSelectionMeaning } from '../nl-routing/selection-meaning';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { a7GrantPlan, runA7ProposeStep, A7_DESTINATION_GONE_LINE, A7_NOT_MADE_LINE, AGENT_A7_AUDIT_EVENT, type A7ProposeOutcome } from './a7-propose';
import { A7_PICK_EXPIRED, A7_PICK_OUT_OF_RANGE, parsePendingA7Pick, resolveA7Pick, type PickedA7Destination } from './a7-pick';
import { rebuildA7SourceRead, runA7DestinationListing, type A7ListingOutcome, type A7PickTemplate } from './a7-destination';
import { readA7State, withA7State, type A7ActorState, type A7CardRecord, type A7StateGuard } from './held-receipt-store';
import { HELD_RECEIPT_MAX_ITEMS, bindHeldReceipt, buildHeldReceipt, carryOverReceipt, parseHeldReceipt, type HeldCardClosure, type HeldReceipt, type HeldReceiptHasher } from './held-receipt';
import { AGENT_A7_TARGETS, checkCrossWriteDestination, type AgentCrossWriteContext, type CrossWriteDestinationPort } from './cross-write';
import type { ValidatedCrossWritePlan } from './cross-write-validator';
import { checkPlannerInputs, plannerPromptCanaryHit, untrustedCanariesOf, type AgentWorkSummarySource } from './flow-policy';
import { splitHelpClause, type AgentHelpSplit } from './help-split';
import { AGENT_PLAN_PROMPT_VERSION, buildAgentPlanPrompt } from './plan-prompt';
import { AgentPlanExecutor, type AgentReadPorts, type AgentRunResult } from './plan-executor';
import { agentPlanParseFailure, parseAgentPlanOutput, type AgentPlan } from './plan-schema';
import { AGENT_PLAN_SUMMARY_SCHEMAS, validateAgentPlan, type AgentPlanValidation, type AgentPlanValidationContext, type ValidatedAgentStep } from './plan-validator';
import { agentReadWriteProbeClauses } from './read-write-probe';
import { ownerSummaryRequests } from './summary-grant';
import { assembleAgentReply, type AssembledAgentReply } from './reply-assembler';
import { a6InPlanGuidance, type AgentStepsPlan } from './reply-notes';
import { AGENT_RUN_BOUNDS, AgentRunBudget, type AgentBoundKind, type AgentRunBoundValues } from './run-bounds';
import { summaryGrantBasis, type SummaryGrantBasis } from './summary-grant';
import { mintSummaryConsentToken, newSummaryRunToken } from './quarantined-summary';
import { isOwnerYes } from '../consent-answer/consent-yes';
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
  /**
   * ADR-0121 A7 (A7-S4b, dormant): the A7 facts of this owner turn, set by the runtime only when it wants A7 state used (it needs
   * `conversationKey`). Absent: no receipt is bound and no pick is pending, exactly as before.
   */
  readonly a7?: A7TurnFacts;
}

/**
 * A7-S4b: what the runtime tells the agent about the A7 state of one owner DM turn. The state is `Session.metadata['quoky.heldReceipt']`
 * as stored (`held-receipt-store.ts`); the agent returns the next value and never saves it (no new `ConversationRuntimeDeps` key, no migration).
 */
export interface A7TurnFacts {
  /** The stored value of `Session.metadata['quoky.heldReceipt']`, as is (or absent). */
  readonly state?: unknown;
  /** This owner message's id. */
  readonly turnId: string;
  /** The owner turn immediately before this one in this conversation (a7-05: the immediately previous turn only). */
  readonly previousTurnId?: string;
  /** The A6 `yes-and-more` re-run facts of this message (A7.4c item 1); `isYesAndMoreRerun` decides. */
  readonly rerun?: { readonly messageId: string; readonly marker: boolean };
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
  | { readonly kind: 'reply'; readonly reply: AssembledAgentReply; readonly outcome: 'complete' | 'partial'; readonly breach?: AgentBoundKind; readonly stopped?: true; readonly a7State?: unknown }
  | { readonly kind: 'one-step'; readonly plan: AgentStepsPlan; readonly a7State?: unknown }
  /** ADR-0121 A7 (A7-S4a, dormant): a cross-source write proposal came to a card, a question, a wait line or a fixed refusal. */
  | {
      readonly kind: 'proposal';
      readonly outcome: A7ProposeOutcome | A7ListingOutcome;
      /** A7-S4b: the next `Session.metadata['quoky.heldReceipt']` value, present only when this turn changed the A7 state. */
      readonly a7State?: unknown;
    }
  /** `a7State`: A7-S4b, present when a carry-over bound on this turn (the closed card is consumed whatever the outcome, P2-2). */
  | { readonly kind: 'declined'; readonly reason: string; readonly a7State?: unknown };

/** P2-2: where a bound carry-over leaves the next A7 state (the closed card consumed) for the caller to return on every outcome. */
interface A7CarryBox {
  voided?: unknown;
}

/**
 * A7-S4b: the receipt bound to a turn. `fromCard`: it is the closed-card carry-over; the card is then consumed from the A7 state whatever
 * the turn comes to (P2-2). No owner text travels with it (P1-2, and the cross-turn grant ruling: a carried draft is never granted by an earlier request).
 */
interface A7BoundReceipt {
  readonly receipt: HeldReceipt;
  readonly fromCard?: true;
}

/** A7-S4b (dormant): one owner turn that may be the reply to a pending destination pick (`AgentRunService.continueA7Pick`). */
export interface AgentA7PickTurn {
  readonly text: string;
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** The offered catalog entries of this turn (the frozen source read must still be one of the READ entries). */
  readonly entries: readonly NlCatalogEntry[];
  readonly direct: boolean;
  readonly sessionId?: Id;
  /** The conversation the pick was asked in (`platform|spaceId|channelId|threadId`). */
  readonly conversationKey: string;
  readonly ownerStepPending?: boolean;
  readonly a7: A7TurnFacts;
}

/**
 * What a reply to a pending pick came to (closed values): `not-pending` (route the turn as usual); `cancelled` (single use: nothing was
 * read; `text` is the fixed line to show for a number off the list or an expiry, none for any other reply, which the caller routes as an
 * ordinary turn); `proposal` (the next listing, a card, a rule-① question or a fixed refusal); `declined` (nothing ran). Every kind but
 * `not-pending` carries the next A7 state: the pending pick, and a frozen receipt with it, is gone.
 */
export type AgentA7PickOutcome =
  | { readonly kind: 'not-pending' }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly text?: string; readonly a7State: unknown }
  | { readonly kind: 'proposal'; readonly outcome: A7ProposeOutcome | A7ListingOutcome; readonly a7State: unknown }
  | { readonly kind: 'declined'; readonly reason: string; readonly a7State: unknown };

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
   * A6 classifier wiring: the consent-answer classifier switch is on (`QUOKY_CONSENT_ANSWER_CLASSIFIER`; `on` stays refused at startup until
   * A6-S4). A consent step is then opened only when 1 (the continuation) + 2 (the classifier, one re-ask included) model calls are left.
   */
  readonly consentClassifierOn?: boolean;
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
   * ADR-0121 A7 (A7-S4a, DORMANT): the proposal port and the destinations switched on (`QUOKY_AGENT_PROPOSE_TARGETS`). Built by the
   * composition root only for agent mode `active` and `QUOKY_AGENT_WRITE_PROPOSALS=active` (both refused at startup) with the
   * connector writes enabled. Absent (the default): a validated A7 plan stays `cross-write-off`, exactly as before. `askConsent`
   * lets a draft that would go to a `REMOTE` model ask its rule-① question; the pending-step continuation of an A7 draft is A7-S4b,
   * so without it a `REMOTE` draft is never allowed (LOCAL only).
   * The composition root must NEVER set `askConsent` until that S4b continuation exists (a question with no way to answer it would leave
   * a dead pending step); a test pins that it is absent.
   */
  readonly writeProposal?: {
    readonly port: AgentWriteProposalPort;
    readonly targets: readonly 'jira-comment'[];
    readonly askConsent?: boolean;
    /**
     * A7-S4b: SHA-256 hex of a UTF-8 string, injected by the composition root (the agent module imports no `node:*`). Form b, the frozen
     * receipt of a destination pick and the closed-card carry-over need it; without it none of them runs (fail closed).
     */
    readonly sha256Hex?: HeldReceiptHasher;
    /**
     * P1-1: the id of THIS boot, injected by the composition root (like `sha256Hex`). Every A7 record is stamped with it and a record of
     * another boot is void (a restart voids a pending pick, a held receipt and a card). Without it no A7 state is read or written.
     */
    readonly bootId?: string;
    /**
     * P2-5 (A7.5 step 2): the fresh destination-existence check run at the pick, before any source read or draft. REQUIRED by the pick
     * continuation: absent, the pick refuses (nothing read, nothing drafted).
     */
    readonly destinationCheck?: CrossWriteDestinationPort;
  };
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
  /** The covered reads of the asked step, each with the ids the owner was asked about (CS-1b: what the token and the W3 filter are scoped by). Ids only. */
  readonly reads: readonly { readonly step: number; readonly entryId: NlWave1EntryId; readonly itemIds: readonly string[] }[];
  readonly sessionId?: Id;
  readonly actorId: Id;
  readonly createdAtMs: number;
}

/** CS-1b: the owner's turn that carries a bound yes: who it is and whether it came in the owner's DM (a continuation is DM-only, like a run). */
export interface AgentContinuationTurn {
  readonly actor: Actor;
  readonly direct: boolean;
}

/**
 * What the continuation of a bound yes came to (closed values only): `reply` is the assembler's continuation reply (the summary, the
 * omitted note and the REMOTE disclosure of that one step; no listing and no question); `declined` sends nothing and carries the
 * one fixed line to show (`expired` when the step's record is gone, otherwise the fixed "not sent" line). Never throws.
 */
export type AgentContinuationOutcome =
  | { readonly kind: 'reply'; readonly reply: AssembledAgentReply; readonly outcome: 'complete' | 'partial'; readonly breach?: AgentBoundKind; readonly stopped?: true }
  | { readonly kind: 'declined'; readonly reason: string; readonly text: string };

/** The fixed lines of a declined continuation (fixed reply text, no model). */
const CONTINUATION_LINE = {
  ko: { expired: '요약 확인 시간이 지났어요. 다시 요청해 주세요.', unavailable: '지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.' },
  en: { expired: 'The summary confirmation has expired. Please ask again.', unavailable: "I can't send the summary right now, so nothing was sent. Please ask again." },
} as const;

/** The bound yes consents a continuation already ran for (single use: a second run of the same bound yes is refused). */
const SPENT_CONSENTS = new WeakSet<object>();

type ValidatedRunPlan = Parameters<AgentPlanExecutor['execute']>[0];

type ShadowOutcome = 'planned' | 'handoff' | 'cross-write' | 'clarify' | 'ask' | 'none' | 'refused' | 'malformed' | 'skipped' | 'unavailable' | 'dropped' | 'stopped' | 'timeout';

class ShadowTimeout extends Error {
  constructor() {
    super('agent shadow timed out');
    this.name = 'ShadowTimeout';
  }
}

/** The continuation of a bound summary yes runs one M2 call; the classifier takes at most two (the answer and one re-ask). */
const CONTINUATION_MODEL_CALLS = 1;
const CLASSIFIER_MODEL_CALLS_PER_STEP = 2;

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
  /** The model-call charge of each actor's run in flight (rule ① CS-2: the asking run's own calls are read from its budget, not its admission charge). */
  private readonly inFlightCharge = new Map<Id, { readonly at: number; count: number }>();
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
      const admission = this.admitRun(turn.actor.id, startedMs, AGENT_ACTIVE_MIN_MODEL_CALLS);
      if (!admission.ok) return declined(admission.reason);
      const { bounds, maxModelCalls, charged } = admission;
      let budget: AgentRunBudget | undefined;
      try {
        budget = new AgentRunBudget(clock, { ...bounds, maxModelCalls });
        const carry: A7CarryBox = {};
        const outcome = await this.admitted(turn, resolveChat, budget, readers, selector, declined, latency, carry);
        // P2-2: a carry-over that bound consumed the closed card, whatever this turn came to (a proposal outcome carries its own next state).
        return carry.voided !== undefined && outcome.kind !== 'proposal' ? { ...outcome, a7State: carry.voided } : outcome;
      } finally {
        this.activeInFlight.delete(turn.actor.id);
        this.inFlightCharge.delete(turn.actor.id);
        charged.count = budget === undefined ? 0 : safeModelCalls(budget);
      }
    } catch (error) {
      this.log('warn', 'agent_run.active_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return { kind: 'declined', reason: 'failed' };
    }
  }

  /**
   * The admission every `active` run shares (rule ① continuation included): one run in flight per actor (review round 1 item 3),
   * the D7 per-actor caps and S2 plan Q7 (what the rolling hour has left of 60 agent model calls, at least `minCalls`). On
   * success the run is charged in full and in flight, synchronously with the checks; the caller trues `charged` down and removes
   * the actor from `activeInFlight` when it ends.
   */
  private admitRun(
    actorId: Id,
    startedMs: number,
    minCalls: number,
  ):
    | { readonly ok: true; readonly bounds: AgentRunBoundValues; readonly maxModelCalls: number; readonly charged: { at: number; count: number } }
    | { readonly ok: false; readonly reason: string } {
    if (this.activeInFlight.has(actorId)) return { ok: false, reason: 'in-flight' };
    // D7 per-actor caps (a run counts when it is admitted; the same rolling windows as shadow).
    const starts = (this.starts.get(actorId) ?? []).filter((at) => startedMs - at < DAY_MS);
    this.starts.set(actorId, starts);
    const perHour = this.deps.caps?.perHour ?? AGENT_SHADOW_MAX_PER_HOUR;
    const perDay = this.deps.caps?.perDay ?? AGENT_SHADOW_MAX_PER_DAY;
    if (starts.filter((at) => startedMs - at < HOUR_MS).length >= perHour) return { ok: false, reason: 'hourly-cap' };
    if (starts.length >= perDay) return { ok: false, reason: 'daily-cap' };
    // S2 plan Q7: what the rolling hour has left of 60 agent model calls. A planned run needs its planner call AND the re-plan slot
    // reserved before step 1 (review round 1 item 2): with fewer than `minCalls` left it is declined here, never started.
    const calls = (this.modelCalls.get(actorId) ?? []).filter((entry) => startedMs - entry.at < HOUR_MS);
    this.modelCalls.set(actorId, calls);
    const hourLeft = AGENT_ACTIVE_MAX_MODEL_CALLS_PER_HOUR - calls.reduce((sum, entry) => sum + entry.count, 0);
    if (hourLeft < minCalls) return { ok: false, reason: 'model-hourly-cap' };
    const bounds = clampedBounds(this.deps.bounds);
    const maxModelCalls = Math.min(bounds.maxModelCalls, hourLeft);
    // Admission charges the run's whole model-call bound at once, synchronously with the checks above (review round 1 item
    // 3); the caller trues it down to the calls the run actually reserved.
    starts.push(startedMs);
    const charged = { at: startedMs, count: maxModelCalls };
    calls.push(charged);
    this.activeInFlight.add(actorId);
    this.inFlightCharge.set(actorId, charged);
    return { ok: true, bounds, maxModelCalls, charged };
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
    carry: A7CarryBox,
  ): Promise<AgentActiveOutcome> {
    // Review round 2 item 2: every await before the planner dispatch is raced against the run's wall and shutdown, so a hung
    // switch read, chat resolution or router never holds the actor's slot or the hour's charge.
    const cut = (ended: 'wall' | 'shutdown' | 'failed'): AgentActiveOutcome =>
      ended === 'wall' ? declined('bound', { breach: budget.breach ?? 'wall-time' }) : declined(ended);
    // Review round 4: the A7 epoch is captured ONCE, here, before ANY await of the turn (the read is started synchronously), and never again.
    // Review round 6: captured whenever the proposal dep is wired, with or without A7 facts (a form-a cross-write turn has none yet reaches the proposal port).
    const a7Capture = this.deps.writeProposal !== undefined ? this.a7Guard(turn.actor.id) : undefined;
    // The kill switch on the live actor (never the turn's snapshot); unreadable = declined (fail closed).
    const running = await withinRun(() => this.liveSwitchRunning(turn.actor.id), budget, this.background.signal);
    if (running.kind !== 'ok') return cut(running.kind);
    if (!running.value) return declined('kill-switch');
    let a7Epoch: A7StateGuard | undefined;
    if (a7Capture !== undefined) {
      const raced = await withinRun(() => a7Capture, budget, this.background.signal);
      if (raced.kind !== 'ok') return cut(raced.kind);
      a7Epoch = raced.value;
    }

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
    return await this.runPlanned(turn, prompt, provider, budget, readers, selector, prepared, declined, latency, carry, a7Epoch);
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
    carry: A7CarryBox,
    guard: A7StateGuard | undefined,
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
    // A7-S4b (dormant): the receipt bound to this owner turn, only with the proposal dep and the A7 facts; otherwise the static context, as before.
    // Review round 4: the A7 guard was captured at turn entry (`admitted`), before the planner; it is never re-read here. A stop then a resume
    // during the planner moved the switch `at`. Review round 5: that voids only the A7 binding (no receipt, no card state touched), never the
    // turn itself: a read plan or a one-step plan still runs as before, and an A7 cross-write is declined below.
    const alive = (): Promise<boolean> => this.epochRunning(turn.actor.id, guard);
    const bindA7 = turn.a7 !== undefined && this.deps.writeProposal !== undefined ? await alive() : true;
    const a7Receipt = bindA7 ? await this.boundA7Receipt(turn, turn.a7 !== undefined ? guard : undefined) : undefined;
    if (a7Receipt?.fromCard === true) carry.voided = await this.stateWithoutCard(turn, turn.a7 !== undefined ? guard : undefined);
    const crossWriteContext =
      this.deps.crossWrite !== undefined && a7Receipt !== undefined
        ? { ...this.deps.crossWrite, receipt: { fresh: true, sourceEntryId: a7Receipt.receipt.entryId, items: a7Receipt.receipt.itemIds.length, hostOnly: false, handoffBuilt: false } }
        : this.deps.crossWrite;
    const validation = validateAgentPlan(plan, {
      offered,
      groundingText: prepared.groundingText,
      ...(turn.previous !== undefined ? { previousArgs: turn.previous.args, previousEntryId: turn.previous.entryId } : {}),
      now: turn.now,
      timeZone: this.deps.timeZone,
      direct: turn.direct,
      ...(crossWriteContext !== undefined ? { crossWrite: crossWriteContext } : {}),
    });
    if (!validation.ok) return declined('refused', { validator: validation.reason, ...callFields });
    const validated = validation.plan;
    if (validated.kind === 'none') return declined(validated.reason ?? 'none', callFields);
    if (validated.kind === 'ask' || validated.kind === 'clarify') return declined(validated.kind, callFields);
    // ADR-0121 A4 (A4-S1): a validated handoff is not runnable until A4-S2 and its flag `QUOKY_AGENT_HANDOFF` (off): fail closed.
    if (validated.kind === 'handoff') return declined('handoff-off', callFields);
    // ADR-0121 A7 (A7-S1): a validated cross-source write plan is not runnable (no read, draft, card or send is built): fail closed.
    if (validated.kind === 'cross-write') {
      const proposal = this.deps.writeProposal;
      if (proposal === undefined || !proposal.targets.includes('jira-comment') || validated.target !== 'jira.comment.propose') return declined('cross-write-off', callFields);
      // Review round 4: the planner and the receipt binding are awaited above; the epoch is checked once more before the first A7 effect.
      // Review round 5/6: ANY cross-write turn (with or without A7 facts) whose epoch capture FAILED (a boot id is wired but the guard is missing: the actor read threw or the actor
      // is gone) fails closed here. No boot id at all (the composition root did not inject one) keeps the running-only check (A7-S5 gate row).
      const bootId = proposal.bootId;
      if (guard === undefined && typeof bootId === 'string' && bootId.length > 0) return declined('stopped', callFields);
      if (!bindA7 || !(await alive())) return declined('stopped', callFields);
      return await this.runCrossWrite(turn, validated, prepared, budget, readers, selector, proposal, callFields, latency, a7Receipt, guard);
    }
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
    const basis = summaryGrantBasis(validated, { ...prepared, rawText: turn.text });
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
   * ADR-0121 A7 (A7-S4a, dormant): the propose step of a validated cross-source write: READ, rule ①, the quarantined draft and the one
   * proposal-port call ({@link runA7ProposeStep}). It runs in the same admitted run, charged on the same budget (the planner call is already
   * counted; the draft is one M2 call within the D7 caps), under the kill switch and the shutdown signal. Nothing here holds a writer: the
   * card is made by the port's implementation outside the agent module.
   *
   * A7-S4b (dormant): a destination the owner named only by kind asks for a pick instead (the listing and the pending pick,
   * {@link runA7DestinationListing}); form b drafts from the receipt bound to this turn (`a7Receipt`); `turn.ownerStepPending` reaches the
   * propose step (W2); and a card that was made hands its frozen items to the A7 state for the closed-card carry-over (A7.4c item 4).
   */
  private async runCrossWrite(
    turn: AgentActiveTurn,
    plan: ValidatedCrossWritePlan,
    prepared: { readonly text: string; readonly groundingText: string },
    budget: AgentRunBudget,
    readers: AgentReadPorts,
    selector: ProviderSelector,
    proposal: NonNullable<AgentRunServiceDeps['writeProposal']>,
    callFields: LogFields,
    latency: () => number,
    a7Bound?: A7BoundReceipt,
    a7GuardOfTurn?: A7StateGuard,
  ): Promise<AgentActiveOutcome> {
    const a7Receipt = a7Bound?.receipt;
    if (turn.sessionId === undefined) {
      this.log('info', AGENT_ACTIVE_LOG_EVENT, { mode: 'active', outcome: 'declined', reason: 'no-session', ...callFields, latencyMs: latency() });
      return { kind: 'declined', reason: 'no-session' };
    }
    const route = {
      selector,
      selectionContext: { sessionId: turn.sessionId, actorId: turn.actor.id },
      ...(this.deps.workSummarySources !== undefined && this.deps.workSummarySources.length > 0 ? { workSummarySources: this.deps.workSummarySources } : {}),
      ...(this.deps.recipientLabel !== undefined ? { recipientLabel: this.deps.recipientLabel } : {}),
      ...(proposal.askConsent === true ? { askSummaryConsent: true } : {}),
    };
    const executor = new AgentPlanExecutor({ readers, logger: this.deps.logger, summarizer: route });
    const language = languageOf(turn.text);
    const hasher = proposal.sha256Hex;
    const conversation = typeof turn.conversationKey === 'string' && turn.conversationKey.length > 0 ? turn.conversationKey : undefined;
    const facts = turn.a7 !== undefined && conversation !== undefined ? turn.a7 : undefined;
    const destination = plan.destination;
    let outcome: A7ProposeOutcome | A7ListingOutcome;
    let next: A7ActorState | undefined;
    const guard = facts !== undefined ? a7GuardOfTurn : undefined;
    const read: A7ActorState = facts !== undefined && guard !== undefined ? readA7State(facts.state, turn.actor.id, guard) : {};
    // P2-2: a carry-over that bound this turn consumed the closed card, whatever this turn comes to.
    const state: A7ActorState = a7Bound?.fromCard === true ? { ...read, card: undefined } : read;
    if (state.card === undefined) delete (state as { card?: A7CardRecord }).card;

    if (destination.state === 'pick-project' || destination.state === 'pick-ticket') {
      // A7.4b: the owner named the kind and not the instance (a7-09: the board first when two or more are allowlisted, then the ticket).
      const template = this.pickTemplate(plan, a7Receipt, hasher);
      if (facts === undefined || guard === undefined || conversation === undefined || template === undefined) {
        outcome = { kind: 'refused', reason: 'unsupported', text: A7_NOT_MADE_LINE[language] };
      } else {
        // P1-2: only the closed list of source reads the owner's own words asked a summary of is frozen (never the words): form a, this turn's request.
        const listRead = plan.form === 'a' ? plan.source : undefined;
        const summaryAsked = listRead !== undefined ? [...new Set(ownerSummaryRequests(a7GrantPlan(listRead, plan.connectorCalls), prepared).map((request) => request.entryId as string))] : [];
        const listed = await runA7DestinationListing(
          { proposal: proposal.port, list: (entryId, args, options) => executor.listDestinationRows(entryId, args, options), logger: this.deps.logger },
          {
            template,
            stage: destination.state === 'pick-project' ? 'project' : 'ticket',
            ...(destination.state === 'pick-ticket' ? { project: destination.project } : {}),
            jiraProjects: (this.deps.crossWrite?.jiraProjects ?? []).map((key) => key.toUpperCase()),
            offeredReads: turn.entries.filter((entry) => entry.risk === 'READ'),
            actorId: turn.actor.id,
            conversation,
            turnId: facts.turnId,
            language,
            now: turn.now,
            budget,
            signal: this.background.signal,
            alive: () => this.epochRunning(turn.actor.id, a7GuardOfTurn),
            ...(turn.ownerStepPending !== undefined ? { ownerStepPending: turn.ownerStepPending } : {}),
            sessionId: turn.sessionId,
            summaryAsked,
          },
        );
        outcome = listed.outcome;
        if (listed.pending !== undefined) {
          // A pending pick that cannot be stored back strictly (an arg that is not a bounded scalar) is never made: fail closed.
          if (parsePendingA7Pick(listed.pending) === undefined) outcome = { kind: 'refused', reason: 'unsupported', text: A7_NOT_MADE_LINE[language] };
          else next = { ...state, pick: listed.pending };
        }
      }
    } else {
      const receipt = plan.form === 'b' && a7Receipt !== undefined ? this.receiptInput(turn.entries, a7Receipt) : undefined;
      if (plan.form === 'b' && receipt === undefined) {
        outcome = { kind: 'refused', reason: 'unsupported', text: A7_NOT_MADE_LINE[language] };
      } else {
        outcome = await runA7ProposeStep(
          { proposal: proposal.port, readSource: (step, options) => executor.readDraftSource(step, options), route, logger: this.deps.logger },
          {
            plan,
            actorId: turn.actor.id,
            sessionId: turn.sessionId,
            language,
            ownerText: { ...prepared, rawText: turn.text },
            // Cross-turn ruling: a follow-up over a receipt (carried or bare) is never granted by an earlier request; REMOTE asks again, LOCAL proceeds.
            ...(plan.form === 'b' ? { grantFrom: { kind: 'carried' as const } } : {}),
            now: turn.now,
            budget,
            signal: this.background.signal,
            alive: () => this.epochRunning(turn.actor.id, a7GuardOfTurn),
            ...(turn.ownerStepPending !== undefined ? { ownerStepPending: turn.ownerStepPending } : {}),
            ...(receipt !== undefined ? { receipt } : {}),
            ...(hasher !== undefined ? { hasher } : {}),
          },
        );
        if (outcome.kind === 'carded' && facts !== undefined && conversation !== undefined) {
          const card = this.cardRecord(turn, plan, outcome, a7Receipt, conversation, facts, hasher);
          next = { ...state, ...(card !== undefined ? { card } : {}) };
        }
      }
    }
    this.log('info', AGENT_ACTIVE_LOG_EVENT, { mode: 'active', outcome: 'proposal', result: outcome.kind, ...callFields, latencyMs: latency() });
    if (next === undefined && a7Bound?.fromCard === true) next = state;
    return { kind: 'proposal', outcome, ...(next !== undefined && facts !== undefined && guard !== undefined ? { a7State: withA7State(facts.state, turn.actor.id, next, turn.now, guard) } : {}) };
  }

  /** The structure a pending pick freezes from a validated plan (form a: its source read; form b: the receipt bound at this turn). `undefined`: no pick can be made. */
  private pickTemplate(plan: ValidatedCrossWritePlan, receipt: HeldReceipt | undefined, hasher: HeldReceiptHasher | undefined): A7PickTemplate | undefined {
    if (plan.target !== 'jira.comment.propose') return undefined;
    if (plan.form === 'a') {
      return plan.source === undefined ? undefined : { form: 'a', target: plan.target, connectorCalls: plan.connectorCalls, source: { entryId: plan.source.entry.id, args: plan.source.args } };
    }
    // Form b: the receipt is frozen inside the pick (A7.4b); the pick turn needs the hasher to recheck it, so none is made without one.
    return receipt === undefined || hasher === undefined ? undefined : { form: 'b', target: plan.target, connectorCalls: 0, frozen: receipt };
  }

  /** The receipt and the read step rebuilt from it (form b); `undefined` when the entry is not offered or a frozen arg no longer fits it. */
  private receiptInput(entries: readonly NlCatalogEntry[], receipt: HeldReceipt): { readonly receipt: HeldReceipt; readonly source: Extract<ValidatedAgentStep, { kind: 'read' }> } | undefined {
    const context = this.deps.crossWrite;
    if (context === undefined) return undefined;
    const source = rebuildA7SourceRead(entries, receipt.entryId, receipt.validatedArgs, context);
    return source === undefined ? undefined : { receipt, source };
  }

  /**
   * A7.4c item 4: the record a made card leaves in the A7 state (its frozen items and what the closure check needs). Form b keeps the receipt it
   * was built from with its ORIGINAL `at` (a carried one stays carried: the card hands nothing on); form a freezes the items it was drafted
   * from. `undefined` without a hasher, a task or a strict receipt: no carry-over then (fail closed).
   */
  private cardRecord(
    turn: Pick<AgentActiveTurn, 'actor' | 'sessionId' | 'now'>,
    plan: ValidatedCrossWritePlan,
    carded: Extract<A7ProposeOutcome, { kind: 'carded' }>,
    receipt: HeldReceipt | undefined,
    conversation: string,
    facts: A7TurnFacts,
    hasher: HeldReceiptHasher | undefined,
  ): A7CardRecord | undefined {
    if (carded.taskId === undefined || hasher === undefined || turn.sessionId === undefined) return undefined;
    let frozen: HeldReceipt | undefined;
    if (plan.form === 'b') {
      // P2-3: freeze only the items the card was drafted from (placed and digest-verified), never the receipt's whole list: an item dropped for
      // drift never comes back through a later carry-over. The original `at`, kind and carried status stay.
      if (receipt === undefined || carded.items === undefined || carded.items.length === 0) return undefined;
      const own = new Map(receipt.itemIds.map((id, index) => [id, receipt.itemDigests[index]] as const));
      if (carded.items.some((item) => own.get(item.id) !== item.digest)) return undefined;
      const rebuilt: HeldReceipt = { ...receipt, itemIds: carded.items.map((item) => item.id), itemDigests: carded.items.map((item) => item.digest) };
      frozen = parseHeldReceipt(rebuilt);
    }
    else if (plan.source !== undefined && carded.items !== undefined && carded.items.length <= HELD_RECEIPT_MAX_ITEMS) {
      const built = buildHeldReceipt({
        conversation,
        actorId: turn.actor.id,
        turnId: facts.turnId,
        entryId: plan.source.entry.id,
        validatedArgs: plan.source.args,
        items: carded.items,
        kind: 'answer',
        egress: carded.locality ?? 'LOCAL',
        at: turn.now,
        sourceOn: true,
      });
      frozen = 'receipt' in built ? built.receipt : undefined;
    }
    if (frozen === undefined) return undefined;
    return { cardId: carded.cardId, taskId: carded.taskId, sessionId: turn.sessionId, cardAt: turn.now, frozen, builtFromCarried: plan.form === 'b' && (receipt?.carried === true || receipt?.kind === 'card') };
  }

  /**
   * P1-1: what the A7 state reader needs: this boot's id (from the composition root) and the `at` of the kill switch's last change on the
   * live actor. `undefined` (no boot id, no actor, a throw): no A7 state at all (fail closed).
   */
  private async a7Guard(actorId: Id): Promise<A7StateGuard | undefined> {
    const bootId = this.deps.writeProposal?.bootId;
    if (typeof bootId !== 'string' || bootId.length === 0) return undefined;
    try {
      const live = await this.deps.actors.get(actorId);
      if (live === null) return undefined;
      const record = readActionSwitch(live);
      return { bootId, ...(record.at !== undefined ? { switchAt: record.at } : {}) };
    } catch {
      return undefined;
    }
  }

  /** P2-2: this owner's A7 state with the closed card removed (a carry-over bound; the next value the caller stores on any outcome). */
  private async stateWithoutCard(turn: AgentActiveTurn, guard: A7StateGuard | undefined): Promise<unknown> {
    const facts = turn.a7;
    if (facts === undefined) return undefined;
    if (guard === undefined) return undefined;
    const { card: _consumed, ...rest } = readA7State(facts.state, turn.actor.id, guard);
    return withA7State(facts.state, turn.actor.id, rest, turn.now, guard);
  }

  /**
   * A7.4 and A7.4c: the receipt bound to this owner turn, or `undefined`. The held receipt binds as A7.4 says (the same actor and DM conversation,
   * the immediately previous turn, within 10 minutes, source on). A closed card's frozen items become the receipt of the next owner turn when it
   * closed as `sent`, `declined`, `expired` or `owner-void` (never `kill-switch`, never unresolved), keeping the original `at` and expiring 20
   * minutes after it; one carry-over at most. Only with the proposal dep, the cross-write context and the runtime's A7 facts; total, never throws.
   */
  private async boundA7Receipt(turn: AgentActiveTurn, guard: A7StateGuard | undefined): Promise<A7BoundReceipt | undefined> {
    const wp = this.deps.writeProposal;
    const cw = this.deps.crossWrite;
    const facts = turn.a7;
    const conversation = turn.conversationKey;
    if (wp === undefined || cw === undefined || facts === undefined || typeof conversation !== 'string' || conversation.length === 0) return undefined;
    try {
      if (guard === undefined) return undefined;
      const state = readA7State(facts.state, turn.actor.id, guard);
      const bind = (receipt: HeldReceipt): boolean =>
        bindHeldReceipt(receipt, {
          actorId: turn.actor.id,
          conversation,
          now: turn.now,
          ...(facts.previousTurnId !== undefined ? { previousTurnId: facts.previousTurnId } : {}),
          sourceOn: cw.sources.includes(receipt.entryId),
          hostOnly: false,
          ...(facts.rerun !== undefined ? { rerun: facts.rerun } : {}),
        }).bound;
      if (state.held !== undefined && bind(state.held)) return { receipt: state.held };
      const card = state.card;
      if (card === undefined || wp.port.closureOf === undefined || facts.previousTurnId === undefined) return undefined;
      // P2-2: strictly the next owner turn after the one that closed the card (the closing turn is recorded on the card; none recorded: no carry-over).
      if (card.closingTurnId === undefined || card.closingTurnId !== facts.previousTurnId) return undefined;
      const closure = await wp.port.closureOf({ sessionId: card.sessionId as Id, taskId: card.taskId as Id, actorId: turn.actor.id, now: turn.now });
      if (closure !== 'sent' && closure !== 'declined' && closure !== 'expired' && closure !== 'owner-void') return undefined;
      const carried = carryOverReceipt(card.frozen, { by: closure satisfies HeldCardClosure, turnId: card.closingTurnId, cardBuiltFromCarried: card.builtFromCarried });
      return 'receipt' in carried && bind(carried.receipt) ? { receipt: carried.receipt, fromCard: true } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * ADR-0121 A7 (A7-S4b, dormant): the reply to a pending destination pick (A7.4b). The pick is the next owner turn: this turn is NOT planned
   * (no M1 call); the frozen validated plan of the turn that asked resumes, only its destination slot is filled with the picked value, and the
   * A7.5 step 2 checks run again before any read (the entry still offered and on, its frozen args still fitting it, the allowlist, the writer, the
   * switch). Single use: whatever the outcome, the pending pick (and a frozen receipt with it) is dropped from the state this returns.
   *
   * - no pending pick: `not-pending` (route the turn as usual);
   * - a reply that is not a number of the list, a late reply, a frozen receipt past its 20 minutes, the kill switch: `cancelled` (the fixed line for
   *   a number off the list and for an expiry; none otherwise, so the caller routes the turn as an ordinary one);
   * - a project picked (a7-09): the ticket listing, a new pending pick that keeps the frozen receipt and its original `at`;
   * - a destination picked: the propose step with `OWNER_PICKED_DESTINATION` (a card, a rule-① question, or a fixed refusal).
   *
   * Admission as the continuation of rule ①: no planner, at least one model call left, the live kill switch (fail closed). Total.
   */
  async continueA7Pick(turn: AgentA7PickTurn): Promise<AgentA7PickOutcome> {
    const clock = this.deps.elapsed ?? Date.now;
    const startedMs = safeClock(clock);
    const conversation = turn.conversationKey;
    const facts = turn.a7;
    // Review round 2 (P3): the one guard read of this turn is cut by the timeout and the shutdown like the other pre-dispatch awaits.
    const guard = await withTimeout(this.a7Guard(turn.actor.id), this.deps.timeoutMs ?? AGENT_SHADOW_DEFAULT_TIMEOUT_MS, this.background.signal).catch(() => undefined);
    if (guard === undefined) return { kind: 'not-pending' };
    const base = readA7State(facts.state, turn.actor.id, guard);
    const pending = base.pick;
    if (pending === undefined) return { kind: 'not-pending' };
    // A bare number has no language of its own: the asking turn froze it.
    const language = pending.language;
    // Single use. A pick turn is an owner turn between a card and any later request, so a closed card does not survive it either (P2-2): only the held receipt stays.
    const cleared: A7ActorState = { ...(base.held !== undefined ? { held: base.held } : {}) };
    const clearedState = (): unknown => withA7State(facts.state, turn.actor.id, cleared, turn.now, guard);
    const cancelled = (reason: string, text?: string): AgentA7PickOutcome => {
      this.log('info', AGENT_A7_AUDIT_EVENT, { planKind: 'cross-write', form: pending.form, stage: pending.stage, decision: 'pending', outcome: 'pick-cancelled', reason });
      return { kind: 'cancelled', reason, ...(text !== undefined ? { text } : {}), a7State: clearedState() };
    };
    const declined = (reason: string): AgentA7PickOutcome => {
      this.log('info', AGENT_A7_AUDIT_EVENT, { planKind: 'cross-write', form: pending.form, stage: pending.stage, decision: 'pending', outcome: 'pick-declined', reason });
      return { kind: 'declined', reason, a7State: clearedState() };
    };
    try {
      const wp = this.deps.writeProposal;
      const cw = this.deps.crossWrite;
      if (this.mode !== 'active' || !turn.direct || wp === undefined || cw === undefined || conversation.length === 0) return declined('unwired');
      if (this.background.signal.aborted) return declined('shutdown');
      const readers = this.deps.readers;
      const selector = this.deps.summarizer;
      if (readers === undefined || selector === undefined || turn.sessionId === undefined) return declined('unwired');
      const alive = (): Promise<boolean> => this.epochRunning(turn.actor.id, guard);
      // Review round 4: the guard was captured once at entry above; the running-only read is now the epoch check.
      const running = await alive();
      const resolution = resolveA7Pick(pending, turn.text, {
        actorId: turn.actor.id,
        conversation,
        now: turn.now,
        turnId: facts.turnId,
        sessionId: turn.sessionId,
        ...(facts.previousTurnId !== undefined ? { previousTurnId: facts.previousTurnId } : {}),
        jiraProjects: cw.jiraProjects,
        killSwitch: !running,
      });
      if (resolution.kind === 'cancel') {
        const line = resolution.reason === 'out-of-range' ? A7_PICK_OUT_OF_RANGE[language] : resolution.reason === 'expired' || resolution.reason === 'frozen-expired' ? A7_PICK_EXPIRED[language] : undefined;
        return cancelled(resolution.reason, line);
      }
      // Step 2 again, before any read: the A7 switch and the writer for Jira, the source entry (form a) still on, and the target still the plan's.
      if (!cw.active.jira || !cw.writers.jira || !wp.targets.includes('jira-comment') || pending.target !== 'jira.comment.propose') return declined('cross-write-off');
      const entries = turn.entries.filter((entry) => entry.risk === 'READ');
      const sourceRead = pending.form === 'a' && pending.source !== undefined ? rebuildA7SourceRead(entries, pending.source.entryId, pending.source.args, cw) : undefined;
      const frozenInput = pending.form === 'b' && pending.frozen !== undefined ? this.receiptInput(entries, pending.frozen) : undefined;
      if (resolution.kind === 'destination' && (pending.form === 'a' ? sourceRead === undefined : frozenInput === undefined)) return declined('source-changed');
      if (pending.form === 'b' && wp.sha256Hex === undefined) return declined('no-hasher');

      const admission = this.admitRun(turn.actor.id, startedMs, 1);
      if (!admission.ok) return declined(admission.reason);
      const { bounds, maxModelCalls, charged } = admission;
      let budget: AgentRunBudget | undefined;
      try {
        budget = new AgentRunBudget(clock, { ...bounds, maxModelCalls });
        const route = {
          selector,
          selectionContext: { sessionId: turn.sessionId, actorId: turn.actor.id },
          ...(this.deps.workSummarySources !== undefined && this.deps.workSummarySources.length > 0 ? { workSummarySources: this.deps.workSummarySources } : {}),
          ...(this.deps.recipientLabel !== undefined ? { recipientLabel: this.deps.recipientLabel } : {}),
          ...(wp.askConsent === true ? { askSummaryConsent: true } : {}),
        };
        const executor = new AgentPlanExecutor({ readers, logger: this.deps.logger, summarizer: route });
        const jiraProjects = cw.jiraProjects.map((key) => key.toUpperCase());

        if (resolution.kind === 'project') {
          // a7-09: the board is picked; the ticket listing follows as a new pending pick that keeps the frozen receipt (and its original `at`).
          const template: A7PickTemplate = { form: pending.form, target: pending.target, connectorCalls: pending.connectorCalls, ...(pending.source !== undefined ? { source: pending.source } : {}), ...(pending.frozen !== undefined ? { frozen: pending.frozen } : {}) };
          const listed = await runA7DestinationListing(
            { proposal: wp.port, list: (entryId, args, options) => executor.listDestinationRows(entryId, args, options), logger: this.deps.logger },
            {
              template,
              stage: 'ticket',
              project: resolution.project,
              jiraProjects,
              offeredReads: entries,
              actorId: turn.actor.id,
              conversation,
              turnId: facts.turnId,
              language,
              now: turn.now,
              budget,
              signal: this.background.signal,
              alive,
              ...(turn.ownerStepPending !== undefined ? { ownerStepPending: turn.ownerStepPending } : {}),
              sessionId: turn.sessionId,
              summaryAsked: pending.summaryAsked,
            },
          );
          if (listed.pending !== undefined && parsePendingA7Pick(listed.pending) !== undefined) {
            return { kind: 'proposal', outcome: listed.outcome, a7State: withA7State(facts.state, turn.actor.id, { ...cleared, pick: listed.pending }, turn.now, guard) };
          }
          return { kind: 'proposal', outcome: listed.pending === undefined ? listed.outcome : { kind: 'refused', reason: 'unsupported', text: A7_NOT_MADE_LINE[language] }, a7State: clearedState() };
        }

        // The destination is picked: the frozen plan resumes with ONLY its destination slot filled (the reply is never planned).
        const picked: PickedA7Destination = resolution.picked;
        // P2-5 (A7.5 step 2): a fresh existence check of the picked issue BEFORE any source read or draft. The port is required: absent, the issue
        // missing or inaccessible, or a failed check all refuse, with nothing read and nothing drafted.
        if (wp.destinationCheck === undefined) return declined('no-destination-check');
        // Review round 3 (P2-2): the destination GET RESERVES one connector query and one HTTP request BEFORE it is made (refused: fail closed, no
        // GET), so a run bounded to one connector read cannot make this GET and the source read both. It is raced against the wall and shutdown.
        const destinationPort = wp.destinationCheck;
        if (!budget.reserveQuery() || !budget.reserveHttp()) return declined('bound');
        // Review round 4: the epoch is checked immediately before the destination GET is dispatched.
        if (!(await alive().catch(() => false))) return declined('stopped');
        const checked = await withinRun(() => checkCrossWriteDestination({ kind: 'jira', issueKey: picked.issueKey, project: picked.project }, destinationPort), budget, this.background.signal);
        if (checked.kind === 'wall') return declined('bound');
        if (checked.kind !== 'ok') return declined(checked.kind === 'shutdown' ? 'shutdown' : 'destination-unchecked');
        // Round 3 (P2-1): the switch epoch is re-read after the awaited GET (stop then resume voids; nothing is read or drafted).
        if (!(await alive().catch(() => false))) return declined('stopped');
        const exists = checked.value;
        if (!exists.ok) {
          this.log('info', AGENT_A7_AUDIT_EVENT, { planKind: 'cross-write', form: pending.form, stage: pending.stage, decision: 'pending', outcome: 'destination-gone', reason: exists.reason });
          return { kind: 'proposal', outcome: { kind: 'refused', reason: 'destination-gone', text: A7_DESTINATION_GONE_LINE[language] }, a7State: clearedState() };
        }
        const resumed: ValidatedCrossWritePlan = {
          kind: 'cross-write',
          form: pending.form,
          target: 'jira.comment.propose',
          operation: AGENT_A7_TARGETS['jira.comment.propose'].operation,
          destinationKind: 'jira',
          ...(pending.form === 'a' && sourceRead !== undefined ? { source: sourceRead } : {}),
          connectorCalls: pending.connectorCalls,
          destination: { state: 'pick-ticket', kind: 'jira', project: picked.project },
        };
        const outcome = await runA7ProposeStep(
          { proposal: wp.port, readSource: (step, options) => executor.readDraftSource(step, options), route, logger: this.deps.logger },
          {
            plan: resumed,
            actorId: turn.actor.id,
            sessionId: turn.sessionId,
            language,
            // The reply "2" asks for nothing: no owner text is stored or reused (P1-2). Form a: the closed list the asking turn froze (the request
            // of the SAME flow, re-derived through `summaryGrantBasisFromFrozen`). Form b (a receipt follow-up): never an earlier grant; REMOTE asks
            // again, LOCAL proceeds (cross-turn ruling).
            grantFrom: pending.form === 'b' ? { kind: 'carried' as const } : { kind: 'frozen' as const, asked: pending.summaryAsked },
            turnId: facts.turnId,
            pickBinding: { conversation, listingTurnId: pending.askedTurnId },
            now: turn.now,
            budget,
            signal: this.background.signal,
            alive,
            picked,
            ...(turn.ownerStepPending !== undefined ? { ownerStepPending: turn.ownerStepPending } : {}),
            ...(frozenInput !== undefined ? { receipt: frozenInput } : {}),
            ...(wp.sha256Hex !== undefined ? { hasher: wp.sha256Hex } : {}),
          },
        );
        let next: A7ActorState = cleared;
        if (outcome.kind === 'carded') {
          const card = this.cardRecord(turn, resumed, outcome, pending.frozen, conversation, facts, wp.sha256Hex);
          next = { ...cleared, ...(card !== undefined ? { card } : {}) };
        }
        this.log('info', AGENT_ACTIVE_LOG_EVENT, { mode: 'active', outcome: 'proposal', result: outcome.kind, pick: true, latencyMs: Math.max(0, safeClock(clock) - startedMs) });
        return { kind: 'proposal', outcome, a7State: withA7State(facts.state, turn.actor.id, next, turn.now, guard) };
      } finally {
        this.activeInFlight.delete(turn.actor.id);
        this.inFlightCharge.delete(turn.actor.id);
        charged.count = budget === undefined ? 0 : safeModelCalls(budget);
      }
    } catch (error) {
      this.log('warn', 'agent_run.a7_pick_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return declined('failed');
    }
  }

  /**
   * Rule ① (CS-1a, W2): opens the pending summary consent of the one step that asks, and keeps its continuation record. Only with
   * a `consentStore`, in the owner's DM, with a conversation key and no other owner step pending; otherwise (or when the step
   * cannot be minted or the question cannot be rendered) the step is downgraded to `listing-only` and no question is shown:
   * `consent-owner-step-open` only when another owner step is pending (W2), `consent-unavailable` for every other cause. The step holds ids only, never content. Total: never throws.
   */
  private openSummaryConsent(turn: AgentActiveTurn, plan: ValidatedRunPlan, basis: SummaryGrantBasis, result: AgentRunResult, language: 'ko' | 'en'): AgentRunResult {
    const asked = result.steps.find((step) => step.kind === 'summarize' && step.status === 'consent-needed');
    if (asked === undefined || asked.kind !== 'summarize' || asked.status !== 'consent-needed') return result;
    const downgrade = (reason: string): AgentRunResult => {
      this.log('info', 'agent_run.consent', { outcome: 'declined', reason, sources: asked.sources.length });
      // The owner-facing line is the true one: "another step is waiting" only when one is (W2); every other cause is "cannot ask".
      const line = reason === 'owner-step-open' ? ('consent-owner-step-open' as const) : ('consent-unavailable' as const);
      return {
        ...result,
        steps: result.steps.map((step) =>
          step === asked ? { step: asked.step, kind: 'summarize' as const, status: 'listing-only' as const, from: asked.from, schema: asked.schema, reason: line } : step,
        ),
      };
    };
    let stored: string | undefined;
    try {
      const store = this.deps.consentStore;
      if (store === undefined) return downgrade('no-store');
      if (!turn.direct) return downgrade('not-dm');
      if (turn.ownerStepPending === true) return downgrade('owner-step-open');
      // CS-2 (CA advice, CS-1b review): a decline of the bound yes for a transient cause SPENDS it (no re-open), so a step is not opened
      // when the actor could not run its continuation: fewer than ONE model call (M2) left in the rolling hour after this run, or the
      // per-actor run caps already reached.
      if (!this.continuationAdmissible(turn.actor.id, safeClock(this.deps.elapsed ?? Date.now), result.usage.modelCalls)) return downgrade('no-call-left');
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
      const recordedReads = Object.freeze(asked.sources.flatMap((entry) => entry.reads.map((read) => Object.freeze({ step: read.step, entryId: read.entryId, itemIds: Object.freeze([...read.itemIds]) }))));
      this.rememberContinuation(runRef, {
        plan,
        basis,
        summaryStep: asked.step,
        // Review round 2: only the RECORDED reads (plus their reference ancestors) re-run; an unrecorded covered read makes no call.
        steps: continuationSteps(plan, asked.step, recordedReads.map((read) => read.step)),
        reads: recordedReads,
        ...(turn.sessionId !== undefined ? { sessionId: turn.sessionId } : {}),
        actorId: turn.actor.id,
        createdAtMs,
      });
      stored = runRef;
      store.open(pending);
      this.log('info', 'agent_run.consent', {
        outcome: 'asked',
        sources: sources.length,
        items: sources.reduce((sum, entry) => sum + entry.itemIds.length, 0),
      });
      return result;
    } catch {
      // A record is never left behind for a step that did not open (it could only be taken by a runRef nobody holds).
      if (stored !== undefined) this.continuations.delete(stored);
      return downgrade('failed');
    }
  }

  /**
   * A6 classifier wiring: charges ONE model call (the consent-answer classifier) to `actorId`'s rolling-hour cap of
   * {@link AGENT_ACTIVE_MAX_MODEL_CALLS_PER_HOUR}, the same ledger the active runs charge. `false` when charging would leave fewer than
   * one call for the continuation of a yes (the caller must not make the call) or the clock cannot be read. It counts no run and takes no in-flight slot. Synchronous and total.
   */
  chargeClassifierCall(actorId: Id, atMs: number): boolean {
    try {
      if (!Number.isFinite(atMs)) return false;
      const calls = (this.modelCalls.get(actorId) ?? []).filter((entry) => atMs - entry.at < HOUR_MS);
      const used = calls.reduce((sum, entry) => sum + entry.count, 0);
      // The classifier never takes the last call: the bound yes it may produce still needs ONE model call for its continuation.
      if (used + 1 + CONTINUATION_MODEL_CALLS > AGENT_ACTIVE_MAX_MODEL_CALLS_PER_HOUR) {
        this.modelCalls.set(actorId, calls);
        return false;
      }
      calls.push({ at: atMs, count: 1 });
      this.modelCalls.set(actorId, calls);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a continuation (one run, one model call, no planner) would still be admitted for `actorId` after the asking run that made `thisRunCalls` calls. */
  private continuationAdmissible(actorId: Id, nowMs: number, thisRunCalls: number): boolean {
    const own = this.inFlightCharge.get(actorId);
    const calls = (this.modelCalls.get(actorId) ?? []).filter((entry) => nowMs - entry.at < HOUR_MS);
    const used = calls.reduce((sum, entry) => sum + (entry === own ? thisRunCalls : entry.count), 0);
    // With the classifier switch on the step also needs its own calls (the answer and one re-ask), or a worded yes could spend the last one.
    const needed = CONTINUATION_MODEL_CALLS + (this.deps.consentClassifierOn === true ? CLASSIFIER_MODEL_CALLS_PER_STEP : 0);
    if (AGENT_ACTIVE_MAX_MODEL_CALLS_PER_HOUR - used < needed) return false;
    const starts = (this.starts.get(actorId) ?? []).filter((at) => nowMs - at < DAY_MS);
    const perHour = this.deps.caps?.perHour ?? AGENT_SHADOW_MAX_PER_HOUR;
    const perDay = this.deps.caps?.perDay ?? AGENT_SHADOW_MAX_PER_DAY;
    return starts.filter((at) => nowMs - at < HOUR_MS).length < perHour && starts.length < perDay;
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

  /**
   * Rule ① (CS-1b): the continuation of the owner's bound yes: re-runs the ONE asked summarize step and sends it (REMOTE only to the
   * recipient the owner was asked about). Total: never throws or rejects. No planner call (no M1, no M1': the ARCHITECTURE.md A2
   * continuation shape); no production caller until CS-2 wires the gate.
   *
   * 1. The record is taken once by the bound consent's `runRef`; a bound yes already used, or a missing, expired or foreign record,
   *    declines with the fixed expired line and sends nothing.
   * 2. Admission as {@link runActive} minus the planner: mode `active`, the owner's DM, no shutdown, one run in flight, the per-actor
   *    caps and at least one model call left; then the live kill switch (fail closed).
   * 3. The token is minted from the bound consent with the run token made here and the step and reads of the RECORD, never from a
   *    caller's parameters (CS-1a review round 2).
   * 4. The executor runs the record's plan with the `continuation` option: only the covered reads re-run, the W3 filter keeps the
   *    asked ids, and one M2 step runs under the token.
   * 5. The assembler's continuation mode renders the reply.
   *
   * One content-free `agent_run.consent` line (`continued` or `declined`, a closed reason, source and item counts).
   */
  async continueSummaryConsent(bound: BoundConsent, turn: AgentContinuationTurn): Promise<AgentContinuationOutcome> {
    const clock = this.deps.elapsed ?? Date.now;
    const startedMs = safeClock(clock);
    let language: 'ko' | 'en' = 'ko';
    let counts: { readonly sources: number; readonly items: number } = { sources: 0, items: 0 };
    const decline = (reason: string, line: 'expired' | 'unavailable' = 'unavailable'): AgentContinuationOutcome => {
      this.log('info', 'agent_run.consent', { outcome: 'declined', reason, ...counts });
      return { kind: 'declined', reason, text: CONTINUATION_LINE[language][line] };
    };
    try {
      const pending = (bound as { readonly pending?: BoundConsent['pending'] } | null | undefined)?.pending;
      if (pending === undefined || pending === null || pending.kind !== 'summary-consent') return decline('not-summary', 'expired');
      language = pending.language === 'en' ? 'en' : 'ko';
      counts = { sources: pending.sources.length, items: pending.sources.reduce((sum, entry) => sum + entry.itemIds.length, 0) };
      // Review round 1 (P3): the owner-yes brand is checked BEFORE the record is taken or a run is admitted, so a bound without
      // it that reuses a real `pending` destroys nothing and spends no admission.
      if (!isOwnerYes(bound)) return decline('no-consent', 'expired');
      // Single use twice over: a bound yes runs once, and the record is dropped by the take below.
      if (SPENT_CONSENTS.has(bound)) return decline('spent', 'expired');
      SPENT_CONSENTS.add(bound);
      const record = this.takeSummaryContinuation(pending.runRef, startedMs);
      if (record === undefined) return decline('expired', 'expired');
      if (record.actorId !== turn.actor.id) return decline('actor');
      // Only a `run` plan opens a pending step (CS-1a); anything else is not a continuation.
      const plan = record.plan;
      if (plan.kind !== 'run') return decline('plan');
      if (this.mode !== 'active') return decline('not-active');
      if (!turn.direct) return decline('not-dm');
      if (this.background.signal.aborted) return decline('shutdown');
      const readers = this.deps.readers;
      const selector = this.deps.summarizer;
      if (readers === undefined || selector === undefined) return decline('unwired');
      // No planner and no re-plan: at least one model call (M2) must be left.
      const admission = this.admitRun(turn.actor.id, startedMs, 1);
      if (!admission.ok) return decline(admission.reason);
      const { bounds, maxModelCalls, charged } = admission;
      let budget: AgentRunBudget | undefined;
      try {
        budget = new AgentRunBudget(clock, { ...bounds, maxModelCalls });
        const running = await withinRun(() => this.liveSwitchRunning(turn.actor.id), budget, this.background.signal);
        if (running.kind === 'wall') return decline('bound');
        if (running.kind !== 'ok') return decline(running.kind);
        if (!running.value) return decline('kill-switch');
        // The run token is made here and the token is keyed to the RECORD's step and reads (never a caller's).
        const run = newSummaryRunToken();
        const consent = mintSummaryConsentToken({ bound, runRef: pending.runRef, run, step: record.summaryStep, reads: record.reads });
        if (consent === undefined) return decline('no-consent');
        const executor = new AgentPlanExecutor({
          readers,
          logger: this.deps.logger,
          summarizer: {
            selector,
            selectionContext: { ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}), actorId: record.actorId },
            ...(this.deps.workSummarySources !== undefined && this.deps.workSummarySources.length > 0 ? { workSummarySources: this.deps.workSummarySources } : {}),
            ...(this.deps.recipientLabel !== undefined ? { recipientLabel: this.deps.recipientLabel } : {}),
            // A continuation never asks (review round 1, P2): the yes is spent and the token covers exactly the recorded reads.
          },
        });
        const result = await executor.execute(plan, {
          budget,
          grants: record.basis,
          stillRunning: () => this.liveSwitchRunning(turn.actor.id),
          signal: this.background.signal,
          continuation: { steps: record.steps, summaryStep: record.summaryStep, run, consent, reads: record.reads },
        });
        const reply = assembleAgentReply({ plan, result, language, destinationIsOwnerDm: turn.direct, mode: 'continuation', summaryStep: record.summaryStep, logger: this.deps.logger });
        const summary = result.steps.find((step) => step.kind === 'summarize' && step.step === record.summaryStep);
        this.log('info', 'agent_run.consent', { outcome: 'continued', reason: summary?.status ?? 'none', ...counts });
        return {
          kind: 'reply',
          reply,
          outcome: result.outcome,
          ...(result.breach !== undefined ? { breach: result.breach } : {}),
          ...(result.stopped === true ? { stopped: true as const } : {}),
        };
      } finally {
        this.activeInFlight.delete(turn.actor.id);
        this.inFlightCharge.delete(turn.actor.id);
        charged.count = budget === undefined ? 0 : safeModelCalls(budget);
      }
    } catch (error) {
      this.log('warn', 'agent_run.consent_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return decline('failed');
    }
  }

  /** The kill switch (CS-2 calls it on every save of `stopped`): every pending summary consent is voided and every continuation record dropped. */
  voidAllSummaryConsents(): void {
    this.continuations.clear();
    this.deps.consentStore?.voidAll();
  }

  /**
   * Round 3 (P2-1): running AND still the switch epoch this A7 turn started under (the record's `at` equals the guard's `switchAt`).
   * A stop then a resume moves `at`, so it voids the in-flight work (A7.4, A7.4b); a throw or a missing actor is false (fail closed).
   */
  private async epochRunning(actorId: Id, guard: A7StateGuard | undefined): Promise<boolean> {
    try {
      const live = await this.deps.actors.get(actorId);
      if (live === null || this.switchState(live) !== 'running') return false;
      return guard === undefined || readActionSwitch(live).at === guard.switchAt;
    } catch {
      return false;
    }
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
