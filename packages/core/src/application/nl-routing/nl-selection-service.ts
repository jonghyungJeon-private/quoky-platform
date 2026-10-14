import { Capability, type Actor, type ConversationContext, type InboundQuotedRange, type IsoTimestamp, type Session } from '../../domain';
import { executionLocalityOf, type AiExecutionLocality, type AiProvider } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelectionContext } from '../../ports/provider-selection-policy.port';
import { containsCredentialMaterial } from '../credential-guard';
import type { SessionManager } from '../session-manager';
import {
  LAST_LISTING_METADATA_KEY,
  findAnyListingByReply,
  readListingRecord,
  withLabelledListing,
  withListingReplies,
  type ListingItem,
  type ListingSource,
} from '../last-listing';
import type { DeliveredTurn, TurnDeliveryObserver } from '../turn-delivery';
import {
  isNlActionEntryId,
  isNlWave1EntryId,
  type NlActionEntryId,
  type NlActionReceipt,
  type NlAmbiguityKey,
  type NlArgs,
  type NlCatalogEntry,
  type NlCatalogRisk,
  type NlClassBProbe,
  type NlGrammarSelection,
  type NlItemSource,
  type NlItemTarget,
  type NlListingReceipt,
  type NlSelectedCommand,
  type NlText,
} from './catalog';
import { ITEM_CONTENT_MODE, containsNlTimeExpression, isNlActionEntry, isNlBulkRequest, nlActionInputRefusal, nlActionSourceOf, normalizeNlSpan, parseNlRef } from './action-entries';
import { NlActionSwitch, parseActionSwitchPhrase, renderActionSwitchReply, type NlActionSwitchState } from './action-switch';
import {
  hasReferenceRecord,
  renderReferenceContext,
  resolveItemReference,
  resolveUndo,
  type NlReferenceState,
  type NlResolutionOutcome,
} from './item-reference';
import { LAST_ACTION_METADATA_KEY, readLastAction, withLastAction, withLastActionEcho, type LastActionRecord } from './last-action';
import {
  NL_ACTION_LOG_EVENT,
  NlActionCaps,
  actionLevelActs,
  nlActionLogFields,
  renderBulk,
  renderCapped,
  renderDeicticPayload,
  renderInputRefusal,
  renderReferenceQuestion,
  renderRestate,
  renderTimeInTitle,
  renderTimeOutsideWhen,
  renderUndoUnresolved,
  resolveLabelChoice,
  type NlActionAudit,
  type NlActionLevel,
} from './nl-action-policy';
import { normalizeForMatch, prepareSelectionInput, type PreparedSelectionInput } from './selection-input';
import { parseSelectionOutput, type NlSelectionCandidate, type NlSelectionOutput } from './selection-output';
import { nlSelectionMeaning } from './selection-meaning';
import { buildSelectionPrompt } from './selection-prompt';
import {
  INTERPRETATION_PREFERENCES_METADATA_KEY,
  LAST_SELECTION_METADATA_KEY,
  NL_PENDING_METADATA_KEY,
  isActionPendingQuestion,
  lastSelectionRecord,
  pendingQuestionRecord,
  readInterpretationPreference,
  readLastSelection,
  readPendingQuestion,
  sanitizeStoredSelection,
  withInterpretationPreference,
  type LastSelection,
  type PendingQuestion,
  type StoredSelection,
} from './selection-state';
import { validateSelection, type NlValidatedSelection, type NlValidationContext, type NlValidationResult } from './selection-validator';

/**
 * Natural-language capability selection (ADR-0120): the one owner of the catalog call, its validation, the clarification
 * state, `lastSelection` and the interpretation preferences (D14 moves all of it out of the runtime, which only
 * dispatches and presents).
 *
 * Phase A (D6, ratified for NL-1): the runtime asks for a decision only on a turn every earlier route left for chat
 * (after `IntentClassifier.classify`, for `GENERAL_CHAT` or the personal-data reason of `POLICY_SENSITIVE_CHAT`).
 *
 * - `off`: never called (byte-identical behaviour).
 * - `shadow` (D11): the selection runs beside the chat turn, acts on nothing and writes nothing; one content-free log
 *   line per turn (entry id or `none`, the route taken, the agree flag, the outcome, the latency).
 * - `active`: the decision is acted on — an executable read, one numbered question, or honest chat.
 *
 * One call per message at most, through the `CapabilityRouter` for `Capability.INTENT_SELECTION` with no session context
 * (the owner's chat-tier choice does not apply, D2); a 6 s default bound (ADR-0120 amendment A3, configurable via
 * `QUOKY_NL_INTENT_TIMEOUT_MS`) and no retry (D3). Before any call the complete request
 * — the prepared text and the previous selection's args — passes the credential guard; a credential-shaped value skips
 * selection with no call (D3 pre-egress guard). The cache is in memory only: per actor, 10 minutes, 256 entries.
 */

export type NlIntentMode = 'off' | 'shadow' | 'active';
export const NL_INTENT_MODES: readonly NlIntentMode[] = ['off', 'shadow', 'active'];

/**
 * ADR-0120 D6 phase (S1, `QUOKY_NL_PHASE`). `a` (the default): selection runs only on turns every earlier route left for
 * chat. `c`: selection also runs first where a frozen Class B grammar would answer, and the grammar is the fallback when
 * the selector is unavailable. Phase C acts only in `active` (the app refuses `c` with `shadow`). `c-shadow` (only with `active`): Phase A stays fully live, and
 * after a Class B grammar has answered, one background selection runs and only its agreement is logged.
 */
export type NlPhase = 'a' | 'c' | 'c-shadow';
export const NL_PHASES: readonly NlPhase[] = ['a', 'c', 'c-shadow'];

export const NL_SELECTION_TIMEOUT_MS = 6_000;

/** S1 `c-shadow` (W2): at most this many background selections start per rolling hour; further hits are dropped. */
export const NL_SHADOW_MAX_PER_HOUR = 60;

/** ADR-0120 A3 follow-up: the startup warm-up bound. It applies to the warm-up call only, never to an owner turn. */
export const NL_WARMUP_TIMEOUT_MS = 20_000;
/** The one fixed warm-up probe text. No owner, session or connector content ever enters a warm-up. */
export const NL_WARMUP_PROBE_TEXT = 'warmup';

export type NlWarmupOutcome = 'ok' | 'timeout' | 'error' | 'skipped';
export const NL_SELECTION_CACHE_TTL_MS = 10 * 60_000;
export const NL_SELECTION_CACHE_MAX_ENTRIES = 256;

/**
 * Which earlier route the turn was on when selection ran (the shadow log's "grammar id"): Phase A's chat routes, or, in
 * Phase C, a frozen Class B grammar hit (`class-b`, the grammar in `NlSelectionTurn.grammar`) or the classifier's
 * personal-work surface (`work-surface`).
 */
export type NlSelectionRoute = 'chat' | 'personal-data' | 'class-b' | 'work-surface';

export interface NlSelectionTurn {
  readonly text: string;
  readonly attachmentCount: number;
  /** Ranges of `text` the platform marked as quoted (removed before the call, never grounding). */
  readonly quotedRanges?: readonly InboundQuotedRange[];
  readonly session: Pick<Session, 'id' | 'metadata'>;
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  /** The entries the registered handlers contribute this turn (configured sources only). */
  readonly entries: readonly NlCatalogEntry[];
  readonly route: NlSelectionRoute;
  /**
   * ADR-0120 D6/D8 (no new egress): the id (or, when it has one, the family — `AiProvider.family`) of the provider the router resolves for this turn's chat capability and
   * session — the provider the message would reach anyway. Selection runs only when the router resolves
   * `INTENT_SELECTION` to that same provider id or family; otherwise (a local or another remote chat provider, or unknown) it is
   * skipped with no call. Compared as opaque data, never as a name.
   */
  readonly chatProviderId?: string;
  /**
   * S1 hardening (NL-1 residual): the declared execution locality (`executionLocalityOf`) of that chat provider. Selection
   * also requires the selector's locality to equal it, so an equal free-form family can never mix a local and a remote
   * provider. Absent: `REMOTE` (the `executionLocalityOf` default).
   */
  readonly chatProviderLocality?: AiExecutionLocality;
  /**
   * Phase C (route `class-b` or `work-surface`): what the frozen Class B grammar would have answered. Used only for the
   * content-free D10/D11 agreement log (grammar id, entry ids, agree flags); it never changes the decision.
   */
  readonly grammar?: NlClassBProbe;
  /**
   * The open question as taken at the start of the turn (`takePending`), `null` when there was none. Absent: read from
   * `session.metadata` (direct callers).
   */
  readonly pending?: PendingQuestion | null;
  /**
   * ADR-0120 amendment A6-D2: the opaque platform id the owner's message replies to (reply-to-pick names its listing; a
   * reply to an echo names its action). Absent: not a reply.
   */
  readonly replyToMessageId?: string;
  /**
   * A6-D3: the turn's correlation id (the inbound message id), carried on every `nl_action.decided` line with the session
   * id so a line joins its turn (the app's logger also appends the per-turn `cid`). Opaque; never content.
   */
  readonly turnId?: string;
  /** ADR-0120 A6: the platform marked part of the text as code (`InboundMessage.formatting.code`); never an action. */
  readonly codeFormatted?: boolean;
}

export type NlSelectionSkipReason =
  | 'off'
  | 'shadow'
  | 'no-catalog'
  | 'too-long'
  | 'empty'
  | 'credential'
  | 'chat-provider-differs'
  | 'chat-locality-differs'
  | 'chat-provider-unknown';

export type NlSelectionDecision =
  /** Continue the turn exactly as without selection. */
  | { readonly kind: 'skip'; readonly reason: NlSelectionSkipReason }
  /** The selector found no entry: honest chat (D9). */
  | { readonly kind: 'none' }
  /** No provider, a timeout, a failure or malformed output: the existing path, then honest chat (D3, R5). */
  | { readonly kind: 'unavailable' }
  /**
   * A validated read (or, with A6, an action) for the owning handler's `handleSelected`; `basis` is the first reply line
   * (D7). `action` is present only for an A6 entry: the content-free audit facts the runtime completes after dispatch.
   */
  | { readonly kind: 'execute'; readonly command: NlSelectedCommand; readonly basis?: string; readonly action?: NlActionAudit }
  /** One numbered question (D7), never chat; the pending choice is already saved. */
  | { readonly kind: 'ask'; readonly text: string };

export interface NlSelectionServiceDeps {
  readonly mode: NlIntentMode;
  readonly router: { select(capability: Capability, context?: ProviderSelectionContext): Promise<AiProvider> };
  /** ADR-0120 amendment A2 (`QUOKY_NL_GRAMMAR_YIELD=on`): Class B listing grammars may yield to selection. Default off. */
  readonly grammarYield?: boolean;
  /** ADR-0120 D6 phase (S1, `QUOKY_NL_PHASE`); default `a`. */
  readonly phase?: NlPhase;
  /** Field-scoped `Session.metadata` writes (`lastSelection`, the pending question). */
  readonly sessions: Pick<SessionManager, 'updateMetadataEntry'>;
  /** The Actor repository (`StorageProvider.actors`), for the D7 preferences: re-read, replace one key, save. */
  readonly actors: { get(id: string): Promise<Actor | null>; save(actor: Actor): Promise<Actor> };
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  readonly logger: Logger;
  /** Set from config (`QUOKY_NL_INTENT_TIMEOUT_MS`, default {@link NL_SELECTION_TIMEOUT_MS}); tests also override it. */
  readonly timeoutMs?: number;
  /** Tests only: monotonic milliseconds for latency (default `Date.now`). */
  readonly elapsed?: () => number;
  /**
   * ADR-0120 amendment A6 (`QUOKY_NL_ACTIONS`, default `off`). Absent or `off`: no action entry is ever offered, no A6
   * record is written and every prompt and reply is byte-identical to `nl-select.v18`. Any other level requires mode
   * `active`; `local` and `external` require the kill switch (the constructor throws otherwise).
   */
  readonly actions?: {
    readonly level: NlActionLevel;
    readonly killSwitch?: NlActionSwitch;
    /** Tests only: other caps. */
    readonly caps?: NlActionCaps;
  };
}

/** A6: the content-free record of a turn that will be completed by `recordActionReceipt` after dispatch. */
interface PendingEcho {
  readonly sessionId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly at: IsoTimestamp;
  readonly echo: boolean;
  readonly listing?: ListingSource;
}

/** A6: at most this many delivery receipts wait at once, each at most 5 minutes (like GML-2's listing receipts). */
const ECHO_RECEIPTS_MAX = 64;
const ECHO_RECEIPT_TTL_MS = 5 * 60_000;

/** A6 configuration errors (value-free codes; the app maps them to a startup refusal). */
export class NlActionsConfigError extends Error {
  constructor(readonly code: 'NL_ACTIONS_REQUIRES_ACTIVE' | 'NL_ACTIONS_REQUIRES_KILL_SWITCH' | 'NL_ACTIONS_EXTERNAL_NOT_AVAILABLE') {
    super(code);
    this.name = 'NlActionsConfigError';
  }
}

interface CacheEntry {
  readonly at: number;
  readonly output: NlSelectionOutput;
}

type SelectOutcome =
  | { readonly kind: 'output'; readonly output: NlSelectionOutput; readonly latencyMs: number; readonly cached: boolean }
  /** D6/D8: the selector is not the provider this turn's chat would reach; nothing was sent. */
  | { readonly kind: 'egress-refused'; readonly reason: 'chat-provider-differs' | 'chat-locality-differs' | 'chat-provider-unknown' }
  | { readonly kind: 'unavailable'; readonly cause: 'no-provider' | 'timeout' | 'failed' | 'malformed'; readonly latencyMs: number };

class SelectionTimeout extends Error {
  constructor() {
    super('intent selection timed out');
    this.name = 'SelectionTimeout';
  }
}

export class NlSelectionService implements TurnDeliveryObserver {
  readonly mode: NlIntentMode;
  private readonly cache = new Map<string, CacheEntry>();
  /** A6 (`QUOKY_NL_ACTIONS`). */
  private readonly actionLevelValue: NlActionLevel;
  private readonly actionCaps: NlActionCaps;
  /** A6: echoes and listings waiting for their delivery receipt (by inbound message). */
  private readonly echoReceipts = new Map<string, PendingEcho>();
  /** The last shadow run (tests await it; production never does). */
  lastShadowRun: Promise<void> = Promise.resolve();
  /** W1: aborts every background selection on shutdown (`stopBackground`). */
  private readonly background = new AbortController();
  /** W2: the `c-shadow` job in flight (at most one) and the start times of the last hour (at most 60). */
  private shadowInFlight = false;
  private readonly shadowStarts: number[] = [];

  constructor(private readonly deps: NlSelectionServiceDeps) {
    this.mode = deps.mode;
    this.actionLevelValue = deps.actions?.level ?? 'off';
    this.actionCaps = deps.actions?.caps ?? new NlActionCaps();
    // A6-D8: any level but `off` needs `active`; `local` / `external` are release-gated on the kill switch.
    if (this.actionLevelValue !== 'off' && deps.mode !== 'active') throw new NlActionsConfigError('NL_ACTIONS_REQUIRES_ACTIVE');
    if (this.actionLevelValue !== 'off' && deps.actions?.killSwitch === undefined) throw new NlActionsConfigError('NL_ACTIONS_REQUIRES_KILL_SWITCH');
    // R3 (external previews, the banner, the yield) is not built: `external` is refused, never silently treated as local.
    if (this.actionLevelValue === 'external') throw new NlActionsConfigError('NL_ACTIONS_EXTERNAL_NOT_AVAILABLE');
  }

  /**
   * ADR-0120 A3 follow-up (startup warm-up): one content-free selection call so the first owner turn does not meet a cold
   * `claude -p` start. The prompt is the fixed catalog-less probe (`NL_WARMUP_PROBE_TEXT`); the reply is discarded. Only in
   * `shadow` or `active`; the same router path (`INTENT_SELECTION`) and, when `chatProviderId` is given, the same provider
   * family check as a turn (D6/D8). Never throws, logs `nl_selection.warmup` with no content, and callers must not await it
   * on a startup or turn path.
   */
  async warmUp(
    options: { readonly chatProviderId?: string; readonly chatProviderLocality?: AiExecutionLocality; readonly signal?: AbortSignal } = {},
  ): Promise<NlWarmupOutcome> {
    if (this.mode === 'off') return 'skipped';
    const clock = this.deps.elapsed ?? Date.now;
    const started = clock();
    let outcome: NlWarmupOutcome;
    const signal = options.signal;
    if (signal?.aborted) return 'skipped';
    try {
      const provider = await this.deps.router.select(Capability.INTENT_SELECTION);
      if (options.chatProviderId !== undefined && sameEgress(provider, options.chatProviderId, options.chatProviderLocality) !== 'same') return 'skipped';
      // Cancelled while resolving the provider (shutdown): no call is started.
      if (signal?.aborted) return 'skipped';
      // The warm-up's own timer is unref'd so it never keeps the process alive; owner turns keep the plain timer.
      await withTimeout(
        provider.execute({ capability: Capability.INTENT_SELECTION, prompt: nlWarmupPrompt(), timeoutMs: NL_WARMUP_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) }),
        NL_WARMUP_TIMEOUT_MS,
        true,
      );
      outcome = 'ok';
    } catch (error) {
      outcome = error instanceof SelectionTimeout ? 'timeout' : 'error';
    }
    this.log(outcome === 'ok' ? 'info' : 'warn', 'nl_selection.warmup', { outcome, latencyMs: Math.max(0, clock() - started) });
    return outcome;
  }

  /** The decision for one Phase A turn. Never throws: an internal error is `unavailable`. */
  async decide(turn: NlSelectionTurn): Promise<NlSelectionDecision> {
    if (this.mode === 'off') return { kind: 'skip', reason: 'off' };
    if (turn.entries.length === 0) return { kind: 'skip', reason: 'no-catalog' };
    if (this.mode === 'shadow') {
      // A grammar-hit turn is never shadowed here (unbounded): only the bounded `c-shadow` job shadows grammar hits.
      if (turn.grammar !== undefined) return { kind: 'skip', reason: 'shadow' };
      this.lastShadowRun = this.shadow(turn).catch((error: unknown) =>
        this.log('warn', 'nl_selection.shadow_failed', { errorName: error instanceof Error ? error.name : typeof error }),
      );
      return { kind: 'skip', reason: 'shadow' };
    }
    try {
      return await this.decideActive(turn);
    } catch (error) {
      this.log('warn', 'nl_selection.failed', { errorName: error instanceof Error ? error.name : typeof error });
      return { kind: 'unavailable' };
    }
  }

  /**
   * D7: take the open question at the start of an owner turn and clear it, whatever route the turn then takes, so a
   * question never survives a turn that did not answer it. The returned question is handed to `decide` when the turn
   * reaches selection. `null` when there is none (no write then). Only in `active` mode; never throws.
   */
  async takePending(session: Pick<Session, 'id' | 'metadata'>, actorId: string, now: IsoTimestamp): Promise<PendingQuestion | null> {
    if (this.mode !== 'active') return null;
    if (session.metadata?.[NL_PENDING_METADATA_KEY] === undefined) return null;
    const question = readPendingQuestion(session, actorId, now) ?? null;
    try {
      await this.deps.sessions.updateMetadataEntry({ id: session.id }, NL_PENDING_METADATA_KEY, () => undefined);
    } catch (error) {
      this.log('warn', 'nl_selection.session_write_failed', { key: NL_PENDING_METADATA_KEY, errorName: error instanceof Error ? error.name : typeof error });
    }
    return question;
  }

  /**
   * ADR-0120 D6 Phase C (S1): the runtime probes the Class B grammars and runs selection first on a hit. True only with
   * `QUOKY_NL_PHASE=c` in `active`. Grammar-hit shadowing exists only as the bounded `c-shadow` job.
   */
  phaseCEnabled(): boolean {
    return this.deps.phase === 'c' && this.mode === 'active';
  }

  /**
   * S1 `c-shadow`: Phase A stays live (grammars answer, selection acts on fall-through) and a grammar-hit turn gets one
   * background selection after its reply, for the agreement log only. Only with `active`.
   */
  phaseCShadowEnabled(): boolean {
    return this.deps.phase === 'c-shadow' && this.mode === 'active';
  }

  /**
   * S1 `c-shadow`: the background selection for a turn a Class B grammar already answered. Same bounds as any selection
   * (the D3 preparation, the credential guard, the family and locality rule, one call, the configured bound, no retry);
   * it acts on nothing and writes no session or actor state — its only output is one `nl_selection.agreement` line
   * (`mode: shadow`). Never throws; the caller must start it only after the reply was handed back.
   */
  shadowGrammarHit(
    turn: Omit<NlSelectionTurn, 'chatProviderId' | 'chatProviderLocality'>,
    resolveChat: () => Promise<{ readonly id: string; readonly locality: AiExecutionLocality } | undefined>,
  ): Promise<void> {
    if (!this.phaseCShadowEnabled() || turn.grammar === undefined || turn.entries.length === 0) return Promise.resolve();
    if (this.background.signal.aborted) return Promise.resolve();
    // W2: one job in flight at most, and at most NL_SHADOW_MAX_PER_HOUR started per rolling hour; the rest are dropped.
    const clock = this.deps.elapsed ?? Date.now;
    const nowMs = clock();
    while (this.shadowStarts.length > 0 && nowMs - (this.shadowStarts[0] as number) >= 3_600_000) this.shadowStarts.shift();
    if (this.shadowInFlight || this.shadowStarts.length >= NL_SHADOW_MAX_PER_HOUR) {
      this.logAgreement(turn, { outcome: 'dropped', reason: this.shadowInFlight ? 'in-flight' : 'hourly-cap', shadow: true });
      return Promise.resolve();
    }
    this.shadowInFlight = true;
    this.shadowStarts.push(nowMs);
    // W1: the job (provider resolution included) is abortable by `stopBackground()` and bounded as a whole by the
    // selection bound; on either, the in-flight call gets the abort signal (the CLI runner kills its child process).
    const job = new AbortController();
    const stop = (): void => job.abort();
    this.background.signal.addEventListener('abort', stop, { once: true });
    const timeoutMs = this.deps.timeoutMs ?? NL_SELECTION_TIMEOUT_MS;
    const work = (async () => {
      const chat = await resolveChat();
      if (job.signal.aborted) return;
      await this.shadow({ ...turn, ...(chat !== undefined ? { chatProviderId: chat.id, chatProviderLocality: chat.locality } : {}) }, job.signal);
    })();
    this.lastShadowRun = withTimeout(work, timeoutMs, true)
      .catch((error: unknown) => {
        job.abort();
        if (error instanceof SelectionTimeout) {
          if (!this.background.signal.aborted) this.logAgreement(turn, { outcome: 'fallback', reason: 'timeout', latencyMs: Math.max(0, clock() - nowMs), shadow: true });
        } else {
          this.log('warn', 'nl_selection.shadow_failed', { errorName: error instanceof Error ? error.name : typeof error });
        }
      })
      .finally(() => {
        this.shadowInFlight = false;
        this.background.signal.removeEventListener('abort', stop);
      });
    return this.lastShadowRun;
  }

  /**
   * W1 (shutdown): abort every background selection (the `c-shadow` job and anything started later is refused). The
   * in-flight provider call receives the abort signal, so the CLI runner terminates its child process. Idempotent.
   */
  stopBackground(): void {
    this.background.abort();
  }

  /** Cheap pre-check (no router call): the flag is on and the mode is `active`. */
  grammarYieldEnabled(): boolean {
    return this.mode === 'active' && this.deps.grammarYield === true;
  }

  /**
   * ADR-0120 amendment A2: whether a Class B listing grammar may decline a message it cannot express in full — only with
   * the yield flag on, in `active`, and when selection would run for this turn (the selector is the provider this turn's
   * chat would reach, D6/D8). Never throws.
   */
  async yieldsToSelection(chatProviderId: string | undefined, chatProviderLocality?: AiExecutionLocality): Promise<boolean> {
    if (this.mode !== 'active' || this.deps.grammarYield !== true || chatProviderId === undefined) return false;
    try {
      const provider = await this.deps.router.select(Capability.INTENT_SELECTION);
      return sameEgress(provider, chatProviderId, chatProviderLocality) === 'same';
    } catch {
      return false;
    }
  }

  /**
   * ADR-0120 follow-up: a handler answered a listing through its own deterministic grammar; keep its structural
   * equivalent as `lastSelection` (same record, same 30-minute TTL as a selection) so "그 중에 …" refines what the owner
   * saw. Only in `active`; a selection that is not a closed entry with bounded args is ignored. Never throws.
   */
  async recordGrammarSelection(session: Pick<Session, 'id'>, actorId: string, selection: NlGrammarSelection, now: IsoTimestamp): Promise<boolean> {
    if (this.mode !== 'active') return false;
    const stored = sanitizeStoredSelection(selection);
    if (stored === undefined) return false;
    try {
      await this.deps.sessions.updateMetadataEntry({ id: session.id }, LAST_SELECTION_METADATA_KEY, () => lastSelectionRecord(actorId, stored, now));
      return true;
    } catch (error) {
      this.log('warn', 'nl_selection.session_write_failed', { key: LAST_SELECTION_METADATA_KEY, errorName: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }

  /**
   * ADR-0120 follow-up: a turn answered by something with no catalog equivalent (chat, help, an approval, a write
   * preview) ends the previous listing's follow-up window, so a later "그 중에 …" never binds to an older, unrelated
   * listing. Only in `active`; never throws.
   */
  async clearLastSelection(session: Pick<Session, 'id'>): Promise<void> {
    if (this.mode !== 'active') return;
    try {
      await this.deps.sessions.updateMetadataEntry({ id: session.id }, LAST_SELECTION_METADATA_KEY, () => undefined);
    } catch (error) {
      this.log('warn', 'nl_selection.session_write_failed', { key: LAST_SELECTION_METADATA_KEY, errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  // ── A6: natural-language actions (ADR-0120 amendment A6) ─────────────────────────────────────────────────────────

  /** `QUOKY_NL_ACTIONS`; `off` unless configured. */
  actionLevel(): NlActionLevel {
    return this.actionLevelValue;
  }

  /**
   * A6-D8/D3: whether the A6 entries may be offered to the selector for this actor right now: mode `active`, a level other
   * than `off` and the kill switch running. False means the runtime drops every action entry from the catalog, so the
   * prompt is `nl-select.v18` byte for byte.
   */
  actionsOffered(actor: Pick<Actor, 'metadata'>): boolean {
    if (this.mode !== 'active' || this.actionLevelValue === 'off') return false;
    return this.deps.actions?.killSwitch?.state(actor) !== 'stopped';
  }

  /**
   * A6-D3 kill switch, the LAST check before an action runs (Codex review P1): the switch is re-read from the persisted
   * Actor, so a stop saved while the selector was running wins over the turn's snapshot. A failed read refuses.
   */
  async actionsStillActing(actor: Pick<Actor, 'id' | 'metadata'>): Promise<boolean> {
    if (this.mode !== 'active' || !actionLevelActs(this.actionLevelValue)) return false;
    try {
      const fresh = await this.deps.actors.get(actor.id);
      return fresh !== null && this.actionsActing(fresh);
    } catch {
      return false;
    }
  }

  /** Whether an A6 decision may act for this actor (`local` / `external` and running); `shadow` only logs. */
  actionsActing(actor: Pick<Actor, 'metadata'>): boolean {
    return this.actionsOffered(actor) && actionLevelActs(this.actionLevelValue);
  }

  /**
   * A6-D3: the owner's kill-switch phrase (`에이전트 중지` / `에이전트 재개`), recognized only while the level is not `off`
   * (with `off` the phrase is ordinary text, byte-identical). Returns the fixed reply, or `undefined` when the text is not
   * the phrase. Never throws.
   */
  async handleSwitchPhrase(actor: Actor, text: string, now: IsoTimestamp): Promise<string | undefined> {
    if (this.mode !== 'active' || this.actionLevelValue === 'off') return undefined;
    const wanted = parseActionSwitchPhrase(text);
    const killSwitch = this.deps.actions?.killSwitch;
    if (wanted === undefined || killSwitch === undefined) return undefined;
    const saved = await killSwitch.set(actor.id, actor, wanted, now);
    return renderActionSwitchReply(saved, languageOf(text));
  }

  /**
   * Owner decision 8: the anchored `되돌리기`, the provider-down twin of `action.undo`. The same resolution as a selected
   * undo, with no selector call. `undefined` when the text is not the phrase or actions are not acting.
   */
  async decideAnchoredUndo(
    turn: Pick<NlSelectionTurn, 'text' | 'session' | 'actor' | 'now' | 'entries' | 'replyToMessageId' | 'turnId' | 'quotedRanges' | 'codeFormatted'>,
  ): Promise<NlSelectionDecision | undefined> {
    // The anchored phrase is the whole message on one line and meets the same plain-line eligibility as any action.
    if (!/^되돌리기[.!]?$/u.test(turn.text.normalize('NFC').trim())) return undefined;
    if (nlActionInputRefusal(turn.text, turn.text, markedMaterial(turn)) !== undefined) return undefined;
    if (!this.actionsActing(turn.actor) || !turn.entries.some((entry) => entry.id === 'action.undo')) return undefined;
    const fullTurn: NlSelectionTurn = { ...turn, attachmentCount: 0, route: 'chat' };
    const decision = await this.decideUndo(fullTurn, 'ko', 0, 'none');
    return decision;
  }

  /**
   * A6-D2: answer an open A6 question at the start of a turn, before any grammar (its answer, "3" or "요약", must not be
   * read as anything else). `undefined` when the text is not an answer (the turn then routes normally; the question has
   * already ended, D7). Only while actions are acting.
   */
  async answerActionPending(turn: NlSelectionTurn): Promise<NlSelectionDecision | undefined> {
    const pending = turn.pending ?? undefined;
    if (!isActionPendingQuestion(pending) || !this.actionsActing(turn.actor)) return undefined;
    const answerInput = prepareSelectionInput(turn.text, 0, turn.quotedRanges ?? []);
    if ('skip' in answerInput) return undefined;
    const language = /\p{L}/u.test(answerInput.groundingText) ? languageOf(turn.text) : pending.language;
    if (this.answerRefused(pending, turn, answerInput.groundingText)) return undefined;
    try {
      return await this.answerActionQuestion(pending, turn, answerInput.groundingText, language);
    } catch (error) {
      this.log('warn', 'nl_action.answer_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return undefined;
    }
  }

  /**
   * A6-D2/D3: what a handler reported after a turn (an A6 dispatch or an anchored Class A command): the to-do / reminder
   * listing it showed, the action it executed (`quoky.lastAction`, the echo label merged into the listing), a question it
   * asked (candidate ids only) or a reschedule question. Writes nothing while the level is `off`. Logs `nl_action.decided`
   * for an A6 dispatch. Never throws.
   */
  async recordActionReceipt(input: {
    readonly session: Pick<Session, 'id'>;
    readonly actor: Pick<Actor, 'id' | 'metadata'>;
    readonly message: { readonly id: string; readonly context: ConversationContext };
    readonly now: IsoTimestamp;
    readonly action?: NlActionReceipt;
    readonly listing?: NlListingReceipt;
    /** The A6 decision this turn dispatched (absent for an anchored command). */
    readonly decided?: NlActionAudit;
    readonly language?: 'ko' | 'en';
  }): Promise<void> {
    if (this.mode !== 'active' || this.actionLevelValue === 'off') return;
    try {
      await this.recordReceipt(input);
    } catch (error) {
      this.log('warn', 'nl_action.record_failed', { errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  /** The audit line for an A6 dispatch that did not run: no handler served it, or the switch stopped it at dispatch. */
  logActionUnserved(decided: NlActionAudit, reason: 'unserved' | 'stopped' = 'unserved', correlationId?: string): void {
    this.log('info', NL_ACTION_LOG_EVENT, { ...nlActionLogFields({ ...decided, result: 'refused', reason }), ...(correlationId !== undefined ? { turnId: correlationId } : {}) });
  }

  /**
   * A6 (`TurnDeliveryObserver`): bind the delivered echo of an action to `lastAction.echoReplyIds`, and a to-do / reminder
   * listing to its reply ids (reply-to-pick). Best-effort; never throws.
   */
  async observeDelivery(turn: DeliveredTurn): Promise<void> {
    try {
      const key = echoKey(turn.messageId, turn.context);
      const pending = this.echoReceipts.get(key);
      if (pending === undefined) return;
      this.echoReceipts.delete(key);
      if (turn.status !== 'RESPONDED' || turn.sessionId !== pending.sessionId || turn.platformMessageIds.length === 0) return;
      const ids = turn.platformMessageIds;
      if (pending.echo) {
        await this.deps.sessions.updateMetadataEntry({ id: pending.sessionId }, LAST_ACTION_METADATA_KEY, (current) =>
          withLastActionEcho(current, pending.actorId, pending.requestId, ids, pending.at).next,
        );
      }
      if (pending.listing !== undefined) {
        const source = pending.listing;
        await this.deps.sessions.updateMetadataEntry({ id: pending.sessionId }, LAST_LISTING_METADATA_KEY, (current) =>
          withListingReplies(current, pending.actorId, source, pending.requestId, ids, pending.at).next,
        );
      }
    } catch {
      this.log('warn', 'nl_action.receipt_persist_failed', {});
    }
  }

  // ── active ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async decideActive(turn: NlSelectionTurn): Promise<NlSelectionDecision> {
    const language = languageOf(turn.text);
    const pending = turn.pending !== undefined ? turn.pending ?? undefined : readPendingQuestion(turn.session, turn.actor.id, turn.now);
    if (pending !== undefined) {
      // Any reply ends the question: an answer resolves it, anything else is a new request.
      if (turn.pending === undefined) await this.writeSession(turn, NL_PENDING_METADATA_KEY, () => undefined);
      // An answer is the owner's own words: quoted text (a range or a `>` line) is stripped first, and a turn with
      // nothing left is not an answer.
      const answerInput = prepareSelectionInput(turn.text, 0, turn.quotedRanges ?? []);
      if (!('skip' in answerInput)) {
        // A bare "1" has no language of its own: the answer keeps the question's.
        const answerLanguage = /\p{L}/u.test(answerInput.groundingText) ? language : pending.language;
        const answered = isActionPendingQuestion(pending)
          ? this.actionsActing(turn.actor)
            ? this.answerRefused(pending, turn, answerInput.groundingText)
              ? undefined
              : await this.answerActionQuestion(pending, turn, answerInput.groundingText, answerLanguage)
            : undefined
          : await this.answerPending(pending, turn, answerInput.groundingText, answerLanguage);
        if (answered !== undefined) return answered;
      }
    }
    // A6-D8/D3: action entries reach the selector only while the level allows and the kill switch is running; otherwise
    // they are dropped here too (the runtime already drops them), so the prompt is v18 byte for byte.
    const actionsOn = this.actionsOffered(turn.actor) && turn.entries.some(isNlActionEntry);
    const effective: NlSelectionTurn = actionsOn ? turn : { ...turn, entries: turn.entries.filter((entry) => !isNlActionEntry(entry)) };
    const reference = actionsOn ? this.referenceState(turn) : undefined;
    const last = readLastSelection(turn.session, turn.actor.id, turn.now);
    const prepared = this.prepare(effective, last);
    if ('skip' in prepared) {
      this.log('info', 'nl_selection.skipped', { reason: prepared.skip, route: turn.route });
      this.logAgreement(turn, { outcome: 'fallback', reason: prepared.skip });
      return { kind: 'skip', reason: prepared.skip };
    }
    const selected = await this.select(effective, prepared, last, undefined, reference);
    if (selected.kind === 'egress-refused') {
      this.log('info', 'nl_selection.skipped', { reason: selected.reason, route: turn.route });
      this.logAgreement(turn, { outcome: 'fallback', reason: selected.reason });
      return { kind: 'skip', reason: selected.reason };
    }
    if (selected.kind === 'unavailable') {
      this.log('info', 'nl_selection.decided', { outcome: 'unavailable', cause: selected.cause, route: turn.route, latencyMs: selected.latencyMs });
      this.logAgreement(turn, { outcome: 'fallback', reason: selected.cause, latencyMs: selected.latencyMs });
      return { kind: 'unavailable' };
    }
    const decision =
      reference !== undefined && selected.output.entryId !== null && isNlActionEntryId(selected.output.entryId)
        ? await this.decideAction(selected.output, effective, prepared, language, reference, selected.latencyMs)
        : await this.fromOutput(selected.output, effective, prepared, last, language, reference !== undefined);
    this.logAgreement(turn, {
      outcome: decision.kind,
      ...(decision.kind === 'execute' && isNlWave1EntryId(decision.command.entryId) ? { selection: { entryId: decision.command.entryId, args: decision.command.args } } : {}),
      latencyMs: selected.latencyMs,
      cached: selected.cached,
    });
    this.log('info', 'nl_selection.decided', {
      outcome: decision.kind,
      entryId: decision.kind === 'execute' ? decision.command.entryId : selected.output.entryId ?? 'none',
      ambiguity: selected.output.ambiguity,
      route: turn.route,
      latencyMs: selected.latencyMs,
      cached: selected.cached,
      ...(selected.output.confidence !== undefined ? { confidence: selected.output.confidence } : {}),
    });
    return decision;
  }

  private async fromOutput(
    output: NlSelectionOutput,
    turn: NlSelectionTurn,
    prepared: PreparedSelectionInput,
    last: LastSelection | undefined,
    language: 'ko' | 'en',
    actionsOn = false,
  ): Promise<NlSelectionDecision> {
    if (output.entryId === null) return { kind: 'none' };
    const ctx = this.validationContext(turn, prepared.groundingText, last?.args);
    const main = validateSelection({ entryId: output.entryId, args: output.args }, ctx);
    if (main.ok && output.ambiguity === 'CLEAR') return this.complete(main.value, turn, last, language, prepared.groundingText);
    // D7: two candidates or a failed validation ask one numbered question, never chat and never a guess. A6: an action
    // candidate is never a numbered option (only READ entries are stored as options).
    const options: NlValidatedSelection[] = [];
    for (const candidate of [{ entryId: output.entryId, args: output.args }, ...output.alternatives]) {
      if (actionsOn && isNlActionEntryId(candidate.entryId)) continue;
      const repaired = validateWithRepair(candidate, ctx);
      if (repaired.ok && repaired.value.entry.risk === 'READ' && !options.some((option) => option.entry.id === repaired.value.entry.id)) options.push(repaired.value);
    }
    if (options.length === 0) {
      // An entry that is not offered (an unconfigured source) or not in the catalog is honest chat's to explain.
      if (!main.ok && (main.reason === 'unknown-entry' || main.reason === 'not-offered' || main.reason === 'not-read')) {
        return { kind: 'none' };
      }
      const entry = main.ok ? main.value.entry : main.entryId !== undefined ? ctx.offered.get(main.entryId) : undefined;
      if (entry === undefined) return { kind: 'none' };
      this.log('info', 'nl_selection.validation_failed', { entryId: entry.id, reason: main.ok ? 'ambiguous' : main.reason, ...(main.ok || main.arg === undefined ? {} : { arg: main.arg }) });
      return { kind: 'ask', text: renderUsageQuestion(entry, language) };
    }
    const stored = options.map((option): StoredSelection => ({ entryId: option.entry.id as StoredSelection['entryId'], args: option.args }));
    await this.writeSession(turn, NL_PENDING_METADATA_KEY, () =>
      pendingQuestionRecord(turn.actor.id, { kind: 'entry', at: turn.now, language, options: stored, groundingText: prepared.groundingText }),
    );
    return { kind: 'ask', text: renderEntryQuestion(options, language) };
  }

  /** A validated selection: apply or ask the interpretation preference (D7), then execute. */
  private async complete(
    selection: NlValidatedSelection,
    turn: NlSelectionTurn,
    last: LastSelection | undefined,
    language: 'ko' | 'en',
    groundingText: string,
    note?: 'saved' | 'changed',
  ): Promise<NlSelectionDecision> {
    const { entry } = selection;
    // Only a wave-1 READ entry completes here (an A6 action entry has its own path and is never `lastSelection`).
    const entryId = entry.id;
    if (!isNlWave1EntryId(entryId)) return { kind: 'none' };
    let args = selection.args;
    let basisNote = note;
    let open = selection.openAmbiguity;
    // D7: an interpretation value counts only when the owner said it (a label or alias in their own words) or it carries
    // over from the previous selection. A value the selector guessed is dropped: the stored preference (or the question)
    // decides this answer, and the guess never overwrites the preference.
    let explicit: NlAmbiguityKey | undefined;
    if (note === undefined) {
      for (const key of entry.ambiguity ?? []) {
        const value = args[key.arg];
        if (!key.openWhen(args) || typeof value !== 'string') continue;
        if (isAmbiguityValueGrounded(key, value, groundingText)) {
          explicit = key;
          continue;
        }
        const carried = last !== undefined && last.entryId === entry.id && last.args[key.arg] === value;
        if (carried) continue;
        const { [key.arg]: _guessed, ...rest } = args;
        args = rest;
        open = key;
        this.log('info', 'nl_selection.ungrounded_interpretation', { key: key.key });
      }
    }
    if (open !== undefined) {
      const values = open.values.map((value) => value.value);
      const preferred = readInterpretationPreference(turn.actor, open.key, values, turn.now);
      if (preferred === undefined) {
        const question: PendingQuestion = {
          kind: 'preference',
          at: turn.now,
          language,
          key: open.key,
          values,
          selection: { entryId, args },
        };
        await this.writeSession(turn, NL_PENDING_METADATA_KEY, () => pendingQuestionRecord(turn.actor.id, question));
        this.log('info', 'nl_selection.preference_asked', { key: open.key });
        return { kind: 'ask', text: renderPreferenceQuestion(open, language) };
      }
      args = { ...args, [open.arg]: preferred };
    } else if (note === undefined && explicit !== undefined) {
      // D7 override: an explicit, grounded value that corrects the previous answer overwrites the stored preference.
      const corrected = [explicit].find(
        (key) =>
          last !== undefined &&
          last.entryId === entry.id &&
          key.openWhen(args) &&
          key.openWhen(last.args) &&
          typeof args[key.arg] === 'string' &&
          args[key.arg] !== last.args[key.arg],
      );
      if (corrected !== undefined && (await this.savePreference(turn, corrected.key, args[corrected.arg] as string))) basisNote = 'changed';
    }
    const command: NlSelectedCommand = {
      entryId: entry.id,
      args,
      ...(selection.range !== undefined ? { range: selection.range } : {}),
      language,
    };
    // A transient arg (a pick of one listed item) answers this turn only and never becomes the follow-up's base.
    const stored = Object.fromEntries(Object.entries(args).filter(([name]) => entry.args.find((spec) => spec.name === name)?.transient !== true));
    await this.writeSession(turn, LAST_SELECTION_METADATA_KEY, () => lastSelectionRecord(turn.actor.id, { entryId, args: stored }, turn.now));
    const described = entry.describe?.(args, selection.range, language);
    const basis = described === undefined ? undefined : renderBasis(described, language, basisNote);
    return { kind: 'execute', command, ...(basis !== undefined ? { basis } : {}) };
  }

  /** A reply to the open numbered question: `1`, `2.`, `지라`, `담당` … or `undefined` when it is not an answer. */
  /**
   * A reply to the open numbered question (D7), resolved strictly (`resolveChoice`): a pick completes it, a cancel closes
   * it with a fixed note, an unclear answer asks the same question again, anything else is `undefined` (routed normally).
   */
  private async answerPending(pending: PendingQuestion, turn: NlSelectionTurn, answerText: string, language: 'ko' | 'en'): Promise<NlSelectionDecision | undefined> {
    const offered = offeredMap(turn.entries);
    if (pending.kind === 'entry') {
      const labels = pending.options.map((option) => {
        const entry = offered.get(option.entryId);
        return entry === undefined ? [] : [entry.label.ko, entry.label.en, ...entry.aliases];
      });
      const resolved = resolveChoice(answerText, labels);
      if (resolved.kind === 'none') return undefined;
      if (resolved.kind === 'cancel') return { kind: 'ask', text: renderCancelled(language) };
      const validated = pending.options.map((option) => validateSelection(option, this.validationContext(turn, '', option.args)));
      if (resolved.kind === 'unclear') {
        const options = validated.flatMap((result) => (result.ok ? [result.value] : []));
        if (options.length === 0) return undefined;
        await this.writeSession(turn, NL_PENDING_METADATA_KEY, () => pendingQuestionRecord(turn.actor.id, { ...pending, at: turn.now }));
        return { kind: 'ask', text: renderEntryQuestion(options, language) };
      }
      const picked = validated[resolved.index];
      if (picked === undefined || !picked.ok) return undefined;
      return this.complete(picked.value, turn, readLastSelection(turn.session, turn.actor.id, turn.now), language, pending.groundingText ?? '');
    }
    if (pending.kind !== 'preference') return undefined;
    const entry = offered.get(pending.selection.entryId);
    const key = entry?.ambiguity?.find((candidate) => candidate.key === pending.key);
    if (entry === undefined || key === undefined) return undefined;
    const labels = pending.values.map((value) => {
      const known = key.values.find((candidate) => candidate.value === value);
      return known === undefined ? [] : [known.label.ko, known.label.en, ...known.aliases];
    });
    const resolved = resolveChoice(answerText, labels);
    if (resolved.kind === 'none') return undefined;
    if (resolved.kind === 'cancel') return { kind: 'ask', text: renderCancelled(language) };
    if (resolved.kind === 'unclear') {
      await this.writeSession(turn, NL_PENDING_METADATA_KEY, () => pendingQuestionRecord(turn.actor.id, { ...pending, at: turn.now }));
      return { kind: 'ask', text: renderPreferenceQuestion(key, language) };
    }
    const value = pending.values[resolved.index] as string;
    await this.savePreference(turn, key.key, value);
    const args = { ...pending.selection.args, [key.arg]: value };
    const validated = validateSelection({ entryId: entry.id, args }, this.validationContext(turn, '', args));
    if (!validated.ok) return undefined;
    return this.complete(validated.value, turn, undefined, language, '', 'saved');
  }

  // ── A6 decisions ───────────────────────────────────────────────────────────────────────────────────────────────

  /** A6-D2: the content-free reference state of this turn (fresh listings, the last action, the reply target). */
  private referenceState(turn: Pick<NlSelectionTurn, 'session' | 'actor' | 'now' | 'replyToMessageId'>): NlReferenceState {
    const listingValue = turn.session.metadata?.[LAST_LISTING_METADATA_KEY];
    const lastAction = readLastAction(turn.session.metadata?.[LAST_ACTION_METADATA_KEY], turn.actor.id, turn.now);
    const replyId = turn.replyToMessageId;
    const listing = replyId === undefined ? undefined : findAnyListingByReply(listingValue, turn.actor.id, replyId, turn.now);
    return {
      listings: readListingRecord(listingValue, turn.actor.id, turn.now),
      ...(lastAction !== undefined ? { lastAction } : {}),
      ...(replyId !== undefined ? { replyTo: { messageId: replyId, ...(listing !== undefined ? { listing } : {}) } } : {}),
      now: turn.now,
    };
  }

  /** One `nl_action.decided` line (content-free) and the question / refusal it answers with. */
  private actionAnswer(audit: NlActionAudit, text: string): NlSelectionDecision {
    this.log('info', NL_ACTION_LOG_EVENT, nlActionLogFields(audit));
    return { kind: 'ask', text };
  }

  /**
   * A6: a selector output naming an action entry. Validation (A6-D1/D3), `lastSelection` cleared (D3), shadow logging
   * (D8), caps (D3), reference resolution (D2), the content-mode key (record C); then the command for the handler.
   */
  private async decideAction(
    output: NlSelectionOutput,
    turn: NlSelectionTurn,
    prepared: PreparedSelectionInput,
    language: 'ko' | 'en',
    reference: NlReferenceState,
    latencyMs: number,
  ): Promise<NlSelectionDecision> {
    const entryId = output.entryId as NlActionEntryId;
    // A6-D3: a turn that executes, previews or asks for an A6 entry clears `lastSelection` (never refinable).
    await this.writeSession(turn, LAST_SELECTION_METADATA_KEY, () => undefined);
    const ctx = this.validationContext(turn, prepared.groundingText, undefined, true);
    const validated = validateSelection({ entryId, args: output.args }, ctx);
    const base = { entryId, risk: ctx.offered.get(entryId)?.risk ?? 'LOCAL_WRITE', refKind: refKindOf(output.args), latencyMs, ...correlationOf(turn) } as const;
    // The A6 input guard (red team): a long paste, hidden characters or an embedded command form never act.
    const inputRefusal = ctx.offered.has(entryId) ? nlActionInputRefusal(turn.text, prepared.groundingText, markedMaterial(turn)) : undefined;
    if (inputRefusal !== undefined) {
      const audit: NlActionAudit = { ...base, resolution: 'none', result: 'refused', reason: inputRefusal };
      if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
      return this.actionAnswer(audit, renderInputRefusal(language));
    }
    if (!validated.ok) {
      // An entry that is not offered (an external write before R3, an unconfigured source) is honest chat's to explain.
      if (validated.reason === 'not-offered' || validated.reason === 'unknown-entry' || validated.reason === 'not-read') return { kind: 'none' };
      // `item.summarize` without a content word: the owner did not ask for the content (record C) — nothing is read.
      if (entryId === 'item.summarize' && validated.reason === 'ungrounded' && validated.arg === 'mode') return { kind: 'none' };
      const audit: NlActionAudit = { ...base, resolution: 'none', result: 'refused', reason: validated.reason };
      if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
      return this.actionAnswer(audit, validationReply(validated.reason, language));
    }
    const { entry } = validated.value;
    let args = validated.value.args;
    if (output.ambiguity !== 'CLEAR') {
      const audit: NlActionAudit = { ...base, risk: entry.risk, resolution: 'ambiguous', result: 'asked', reason: 'ambiguous' };
      if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
      return this.actionAnswer(audit, isNlBulkRequest(prepared.groundingText) ? renderBulk(language) : renderRestate(language));
    }
    if (entryId === 'action.undo') return this.decideUndo(turn, language, latencyMs, 'none', reference);
    // A6-D2: resolve the target in code (most recent listing only, display numbers, lastAction).
    let target: NlItemTarget | undefined;
    let resolution: NlResolutionOutcome = 'none';
    const ref = parseNlRef(args.ref);
    const source = nlActionSourceOf(entryId, args);
    if (ref !== undefined && source !== undefined) {
      const resolved = resolveItemReference({ entryId, source, ref, groundingText: prepared.groundingText, state: reference });
      if (resolved.kind === 'unresolved') {
        const audit: NlActionAudit = { ...base, risk: entry.risk, resolution: resolved.outcome, result: 'asked', reason: resolved.outcome };
        if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
        if (resolved.candidates !== undefined && resolved.candidates.length > 0) {
          await this.askTarget(turn, language, entryId, source, resolved.candidates, args, resolved.listingAt);
        }
        return this.actionAnswer(
          audit,
          renderReferenceQuestion(resolved.outcome, source, language, {
            ...(resolved.found !== undefined ? { found: resolved.found as NlItemSource } : {}),
            ...(resolved.count !== undefined ? { count: resolved.count } : {}),
            ...(resolved.index !== undefined ? { index: resolved.index } : {}),
            ...(resolved.candidates !== undefined ? { labels: resolved.candidates.map((item) => item.label) } : {}),
          }),
        );
      }
      target = resolved.target;
      resolution = 'resolved';
    }
    const audit: NlActionAudit = { ...base, risk: entry.risk, resolution, ...(target !== undefined ? { target } : {}), result: 'executed' };
    if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
    if (!this.actionCaps.allows(turn.actor.id, entry.risk, Date.parse(turn.now))) {
      return this.actionAnswer({ ...audit, result: 'capped', reason: 'capped' }, renderCapped(language));
    }
    let basis: string | undefined;
    if (entryId === 'item.summarize' && target !== undefined) {
      const mode = await this.contentMode(turn, args, language);
      if (mode.kind === 'ask') {
        await this.writeSession(turn, NL_PENDING_METADATA_KEY, () =>
          pendingQuestionRecord(turn.actor.id, {
            kind: 'action-mode',
            at: turn.now,
            language,
            target,
            ...(args.scope === 'thread' ? { scope: 'thread' as const } : {}),
          }),
        );
        return this.actionAnswer({ ...audit, result: 'asked', reason: 'content-mode' }, renderPreferenceQuestion(ITEM_CONTENT_MODE, language));
      }
      args = { ...args, mode: mode.value };
      basis = mode.basis;
    }
    this.actionCaps.note(turn.actor.id, entry.risk, Date.parse(turn.now));
    const command: NlSelectedCommand = { entryId, args, language, ...(target !== undefined ? { target } : {}) };
    return { kind: 'execute', command, ...(basis !== undefined ? { basis } : {}), action: audit };
  }

  /** A6 (D8) `shadow`: the decision is logged and nothing acts; the turn continues as today (honest chat). */
  private shadowAction(audit: NlActionAudit): NlSelectionDecision {
    this.log('info', NL_ACTION_LOG_EVENT, nlActionLogFields(audit));
    return { kind: 'none' };
  }

  /** Ratification record A: which action "되돌려줘" (or the anchored `되돌리기`) undoes; never an undo of an undo. */
  private async decideUndo(
    turn: Pick<NlSelectionTurn, 'session' | 'actor' | 'now' | 'replyToMessageId' | 'turnId'>,
    language: 'ko' | 'en',
    latencyMs: number,
    _resolution: NlResolutionOutcome,
    reference: NlReferenceState = this.referenceState(turn),
  ): Promise<NlSelectionDecision> {
    const base = { entryId: 'action.undo', risk: 'LOCAL_WRITE' as NlCatalogRisk, refKind: 'none' as const, latencyMs, ...correlationOf(turn) };
    const resolved = resolveUndo(reference);
    if (resolved.kind === 'unresolved') {
      const audit: NlActionAudit = { ...base, resolution: resolved.outcome === 'stale' ? 'stale' : 'none', result: 'refused', reason: resolved.outcome };
      if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
      return this.actionAnswer(audit, renderUndoUnresolved(resolved.outcome, language));
    }
    const audit: NlActionAudit = { ...base, resolution: 'resolved', target: resolved.target, result: 'undone' };
    if (this.actionLevelValue === 'shadow') return this.shadowAction({ ...audit, result: 'shadow' });
    if (!this.actionCaps.allows(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now))) {
      return this.actionAnswer({ ...audit, result: 'capped', reason: 'capped' }, renderCapped(language));
    }
    this.actionCaps.note(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now));
    return { kind: 'execute', command: { entryId: 'action.undo', args: {}, language, target: resolved.target, undo: resolved.undo }, action: audit };
  }

  /** Record C: an explicit mode word wins (and overwrites the stored choice); else the stored choice; else ask once. */
  private async contentMode(
    turn: NlSelectionTurn,
    args: NlArgs,
    language: 'ko' | 'en',
  ): Promise<{ readonly kind: 'value'; readonly value: string; readonly basis?: string } | { readonly kind: 'ask' }> {
    const values = ITEM_CONTENT_MODE.values.map((value) => value.value);
    const stored = readInterpretationPreference(turn.actor, ITEM_CONTENT_MODE.key, values, turn.now);
    const explicit = typeof args.mode === 'string' ? args.mode : undefined;
    if (explicit !== undefined) {
      if (stored !== undefined && stored !== explicit && (await this.savePreference(turn, ITEM_CONTENT_MODE.key, explicit))) {
        return { kind: 'value', value: explicit, basis: renderBasis(modeLabel(explicit, language), language, 'changed') };
      }
      return { kind: 'value', value: explicit };
    }
    if (stored !== undefined) return { kind: 'value', value: stored, basis: renderBasis(modeLabel(stored, language), language, undefined) };
    return { kind: 'ask' };
  }

  /** A6-D2: a target question stores candidate ids only and is recorded as the most recent listing with its labels. */
  private async askTarget(
    turn: NlSelectionTurn,
    language: 'ko' | 'en',
    entryId: NlActionEntryId,
    source: NlItemSource,
    candidates: readonly ListingItem[],
    args: NlArgs,
    listingAt?: IsoTimestamp,
  ): Promise<void> {
    const enumArgs: Record<string, string> = {};
    for (const name of ['source', 'scope', 'mode']) if (typeof args[name] === 'string') enumArgs[name] = args[name] as string;
    await this.writeSession(turn, NL_PENDING_METADATA_KEY, () =>
      pendingQuestionRecord(turn.actor.id, {
        kind: 'action-target',
        at: turn.now,
        language,
        entryId,
        source,
        candidates: candidates.slice(0, 10),
        args: enumArgs,
        ...(listingAt !== undefined ? { listingAt } : {}),
      }),
    );
    await this.writeSession(turn, LAST_LISTING_METADATA_KEY, (current) =>
      withLabelledListing(current, turn.actor.id, source, candidates.slice(0, 10), turn.now, 'merge'),
    );
  }

  /**
   * The A6 input guard on an answer to an A6 question (Codex review P2): a long paste, hidden characters or an embedded
   * command form is never an answer, so it never acts through one; the turn then routes normally (where any action
   * decision meets the same guard). Logs the refusal.
   */
  private answerRefused(
    pending: Extract<PendingQuestion, { kind: 'action-target' | 'action-mode' | 'action-reschedule' }>,
    turn: NlSelectionTurn,
    groundingText: string,
  ): boolean {
    const refusal = nlActionInputRefusal(turn.text, groundingText, markedMaterial(turn));
    if (refusal === undefined) return false;
    const entryId = pending.kind === 'action-target' ? pending.entryId : pending.kind === 'action-mode' ? 'item.summarize' : 'action.undo';
    this.log('info', NL_ACTION_LOG_EVENT, nlActionLogFields({ entryId, risk: entryId === 'item.summarize' ? 'ITEM_READ' : 'LOCAL_WRITE', refKind: 'none', resolution: 'none', result: 'refused', reason: refusal, ...correlationOf(turn) }));
    return true;
  }

  /** A6: the owner's answer to an open A6 question; `undefined` when the text is not an answer. */
  private async answerActionQuestion(
    pending: Extract<PendingQuestion, { kind: 'action-target' | 'action-mode' | 'action-reschedule' }>,
    turn: NlSelectionTurn,
    answerText: string,
    language: 'ko' | 'en',
  ): Promise<NlSelectionDecision | undefined> {
    const offered = offeredMap(turn.entries);
    if (pending.kind === 'action-target') {
      const entry = offered.get(pending.entryId);
      if (entry === undefined) return undefined;
      const choice = resolveLabelChoice(answerText, pending.candidates.map((candidate) => candidate.label));
      if (choice.kind === 'none') return undefined;
      if (choice.kind === 'cancel') return { kind: 'ask', text: renderCancelled(language) };
      const picked = pending.candidates[choice.index];
      if (picked === undefined) return undefined;
      const target: NlItemTarget = {
        source: pending.source,
        id: picked.id,
        label: picked.label,
        ...(pending.listingAt !== undefined ? { listingAt: pending.listingAt } : {}),
      };
      const audit: NlActionAudit = { entryId: pending.entryId, risk: entry.risk, refKind: 'index', resolution: 'resolved', target, result: 'executed', ...correlationOf(turn) };
      if (!this.actionCaps.allows(turn.actor.id, entry.risk, Date.parse(turn.now))) return this.actionAnswer({ ...audit, result: 'capped', reason: 'capped' }, renderCapped(language));
      let args: NlArgs = pending.args;
      let basis: string | undefined;
      if (pending.entryId === 'item.summarize') {
        const mode = await this.contentMode(turn, args, language);
        if (mode.kind === 'ask') {
          await this.writeSession(turn, NL_PENDING_METADATA_KEY, () =>
            pendingQuestionRecord(turn.actor.id, { kind: 'action-mode', at: turn.now, language, target, ...(args.scope === 'thread' ? { scope: 'thread' as const } : {}) }),
          );
          return this.actionAnswer({ ...audit, result: 'asked', reason: 'content-mode' }, renderPreferenceQuestion(ITEM_CONTENT_MODE, language));
        }
        args = { ...args, mode: mode.value };
        basis = mode.basis;
      }
      this.actionCaps.note(turn.actor.id, entry.risk, Date.parse(turn.now));
      return { kind: 'execute', command: { entryId: pending.entryId, args, language, target }, ...(basis !== undefined ? { basis } : {}), action: audit };
    }
    if (pending.kind === 'action-mode') {
      if (!offered.has('item.summarize')) return undefined;
      const labels = ITEM_CONTENT_MODE.values.map((value) => [value.label.ko, value.label.en, ...value.aliases]);
      const resolved = resolveChoice(answerText, labels);
      if (resolved.kind === 'none') return undefined;
      if (resolved.kind === 'cancel') return { kind: 'ask', text: renderCancelled(language) };
      if (resolved.kind === 'unclear') {
        await this.writeSession(turn, NL_PENDING_METADATA_KEY, () => pendingQuestionRecord(turn.actor.id, { ...pending, at: turn.now }));
        return { kind: 'ask', text: renderPreferenceQuestion(ITEM_CONTENT_MODE, language) };
      }
      const mode = ITEM_CONTENT_MODE.values[resolved.index]?.value;
      if (mode === undefined) return undefined;
      const audit: NlActionAudit = { entryId: 'item.summarize', risk: 'ITEM_READ', refKind: 'index', resolution: 'resolved', target: pending.target, result: 'executed', ...correlationOf(turn) };
      if (!this.actionCaps.allows(turn.actor.id, 'ITEM_READ', Date.parse(turn.now))) return this.actionAnswer({ ...audit, result: 'capped', reason: 'capped' }, renderCapped(language));
      await this.savePreference(turn, ITEM_CONTENT_MODE.key, mode);
      this.actionCaps.note(turn.actor.id, 'ITEM_READ', Date.parse(turn.now));
      const args: NlArgs = { source: pending.target.source, mode, ...(pending.scope === 'thread' ? { scope: 'thread' } : {}) };
      return {
        kind: 'execute',
        command: { entryId: 'item.summarize', args, language, target: pending.target },
        basis: renderBasis(modeLabel(mode, language), language, 'saved'),
        action: audit,
      };
    }
    // action-reschedule: the owner's own words carry the new time (parsed by the deterministic grammar in the handler).
    if (!offered.has('action.undo') || !containsNlTimeExpression(answerText)) return undefined;
    const when = normalizeNlSpan(answerText);
    const audit: NlActionAudit = { entryId: 'action.undo', risk: 'LOCAL_WRITE', refKind: 'none', resolution: 'resolved', target: pending.target, result: 'undone', ...correlationOf(turn) };
    if (!this.actionCaps.allows(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now))) return this.actionAnswer({ ...audit, result: 'capped', reason: 'capped' }, renderCapped(language));
    this.actionCaps.note(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now));
    return {
      kind: 'execute',
      command: { entryId: 'action.undo', args: { when }, language, target: pending.target, undo: { entryId: 'reminder.cancel', version: pending.version } },
      action: audit,
    };
  }

  /** A6: write what a handler reported (listing, lastAction and echo label, question, reschedule) and log the dispatch. */
  private async recordReceipt(input: Parameters<NlSelectionService['recordActionReceipt']>[0]): Promise<void> {
    const { session, actor, message, now, action, listing, decided } = input;
    const language = input.language ?? 'ko';
    const turnRef = { session: { id: session.id } };
    const write = (key: string, update: (current: unknown) => unknown) => this.writeSession(turnRef as NlSelectionTurn, key, update);
    let echo = false;
    let listed: ListingSource | undefined;
    if (listing !== undefined) {
      // An empty listing removes the slot: an older list of that source is never picked from after it.
      await write(LAST_LISTING_METADATA_KEY, (current) => withLabelledListing(current, actor.id, listing.source, listing.items, now, 'listing', message.id));
      if (listing.items.length > 0) listed = listing.source;
    }
    if (action !== undefined && (action.source === 'todo' || action.source === 'reminder')) {
      const source = action.source;
      if ((action.result === 'executed' || action.result === 'undone') && action.itemId !== undefined) {
        const record: LastActionRecord = {
          entryId: action.result === 'undone' ? 'action.undo' : action.entryId,
          source,
          itemId: action.itemId,
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.version !== undefined ? { version: action.version } : {}),
          at: now,
          undoable: action.result === 'executed' && action.undoable !== false,
          undone: false,
          ...(action.result === 'undone' && action.undoOf !== undefined ? { undoOf: action.undoOf } : {}),
          requestId: message.id,
          echoReplyIds: [],
        };
        await write(LAST_ACTION_METADATA_KEY, (current) => withLastAction(current, actor.id, record, now));
        echo = true;
        // A6-D2: the echo label merges into a fresh listing of the same source (or becomes it).
        if (action.label !== undefined) {
          const label = action.label;
          const itemId = action.itemId;
          await write(LAST_LISTING_METADATA_KEY, (current) => withLabelledListing(current, actor.id, source, [{ label, id: itemId }], now, 'merge', message.id));
          listed ??= source;
        }
      } else if (action.result === 'asked' && action.candidates !== undefined && action.candidates.length > 0) {
        const candidates = action.candidates.slice(0, 10);
        await write(NL_PENDING_METADATA_KEY, () =>
          pendingQuestionRecord(actor.id, { kind: 'action-target', at: now, language, entryId: action.entryId, source, candidates, args: {} }),
        );
        await write(LAST_LISTING_METADATA_KEY, (current) => withLabelledListing(current, actor.id, source, candidates, now, 'merge', message.id));
        listed ??= source;
      } else if (action.result === 'reschedule' && action.itemId !== undefined && action.version !== undefined && source === 'reminder') {
        const target: NlItemTarget = { source, id: action.itemId, ...(action.label !== undefined ? { label: action.label } : {}) };
        const version = action.version;
        await write(NL_PENDING_METADATA_KEY, () => pendingQuestionRecord(actor.id, { kind: 'action-reschedule', at: now, language, target, version }));
      }
    }
    if (decided !== undefined) {
      const result = action === undefined ? decided.result : action.result === 'reschedule' ? 'asked' : action.result;
      this.log('info', NL_ACTION_LOG_EVENT, nlActionLogFields({ ...decided, result, ...(action?.reason !== undefined ? { reason: action.reason } : {}) }));
    }
    if (echo || listed !== undefined) this.awaitEcho(session.id, actor.id, message, now, echo, listed);
  }

  private awaitEcho(sessionId: string, actorId: string, message: { readonly id: string; readonly context: ConversationContext }, now: IsoTimestamp, echo: boolean, listing?: ListingSource): void {
    const nowMs = Date.parse(now);
    for (const [key, pending] of this.echoReceipts) {
      const age = nowMs - Date.parse(pending.at);
      if (!Number.isFinite(age) || age < 0 || age >= ECHO_RECEIPT_TTL_MS) this.echoReceipts.delete(key);
    }
    const key = echoKey(message.id, message.context);
    this.echoReceipts.delete(key);
    this.echoReceipts.set(key, { sessionId, actorId, requestId: message.id, at: now, echo, ...(listing !== undefined ? { listing } : {}) });
    while (this.echoReceipts.size > ECHO_RECEIPTS_MAX) {
      const oldest = this.echoReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.echoReceipts.delete(oldest);
    }
  }

  // ── shadow ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async shadow(turn: NlSelectionTurn, signal?: AbortSignal): Promise<void> {
    const last = readLastSelection(turn.session, turn.actor.id, turn.now);
    const prepared = this.prepare(turn, last);
    if ('skip' in prepared) {
      this.log('info', 'nl_selection.shadow', { outcome: 'skipped', reason: prepared.skip, grammarId: turn.route });
      this.logAgreement(turn, { outcome: 'fallback', reason: prepared.skip, shadow: true });
      return;
    }
    const selected = await this.select(turn, prepared, last, signal);
    // A job aborted on shutdown or at its bound logs nothing more (the caller logged the timeout).
    if (signal?.aborted === true) return;
    if (selected.kind === 'egress-refused') {
      this.log('info', 'nl_selection.shadow', { outcome: 'skipped', reason: selected.reason, grammarId: turn.route });
      this.logAgreement(turn, { outcome: 'fallback', reason: selected.reason, shadow: true });
      return;
    }
    if (selected.kind === 'unavailable') {
      this.log('info', 'nl_selection.shadow', { outcome: 'unavailable', cause: selected.cause, grammarId: turn.route, latencyMs: selected.latencyMs });
      this.logAgreement(turn, { outcome: 'fallback', reason: selected.cause, latencyMs: selected.latencyMs, shadow: true });
      return;
    }
    const output = selected.output;
    let outcome = output.entryId === null ? 'none' : output.ambiguity;
    let executable: NlGrammarSelection | undefined;
    if (output.entryId !== null) {
      const validated = validateSelection({ entryId: output.entryId, args: output.args }, this.validationContext(turn, prepared.groundingText, last?.args));
      if (!validated.ok) outcome = 'INVALID';
      else if (output.ambiguity === 'CLEAR' && isNlWave1EntryId(validated.value.entry.id)) executable = { entryId: validated.value.entry.id, args: validated.value.args };
    }
    if (turn.grammar !== undefined) {
      this.logAgreement(turn, {
        outcome: executable !== undefined ? 'execute' : output.entryId === null ? 'none' : 'ask',
        ...(executable !== undefined ? { selection: executable } : {}),
        latencyMs: selected.latencyMs,
        cached: selected.cached,
        shadow: true,
      });
      return;
    }
    // Content-free (D11): ids, flags and timings only — never the text or an argument value.
    this.log('info', 'nl_selection.shadow', {
      entryId: output.entryId ?? 'none',
      grammarId: turn.route,
      agree: output.entryId === null,
      outcome,
      latencyMs: selected.latencyMs,
      cached: selected.cached,
      ...(output.confidence !== undefined ? { confidence: output.confidence } : {}),
    });
  }

  // ── the call ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** D3 input preparation plus the pre-egress credential guard over the complete outgoing request. */
  private prepare(turn: NlSelectionTurn, last: LastSelection | undefined): PreparedSelectionInput | { readonly skip: NlSelectionSkipReason } {
    const prepared = prepareSelectionInput(turn.text, turn.attachmentCount, turn.quotedRanges ?? []);
    if ('skip' in prepared) return prepared;
    const previousStrings = last === undefined ? [] : Object.values(last.args).filter((value): value is string => typeof value === 'string');
    if ([prepared.text, ...previousStrings].some((value) => containsCredentialMaterial(value))) return { skip: 'credential' };
    return prepared;
  }

  private async select(
    turn: NlSelectionTurn,
    prepared: PreparedSelectionInput,
    last: LastSelection | undefined,
    signal?: AbortSignal,
    reference?: NlReferenceState,
  ): Promise<SelectOutcome> {
    const clock = this.deps.elapsed ?? Date.now;
    const started = clock();
    const previous = last === undefined ? undefined : { entryId: last.entryId, args: last.args };
    // D6/D8 first, before the cache: the request may only go where this turn's chat would have gone.
    if (turn.chatProviderId === undefined) return { kind: 'egress-refused', reason: 'chat-provider-unknown' };
    let provider: AiProvider;
    try {
      // No session context: the owner's chat-tier choice does not apply to this capability (D2).
      provider = await this.deps.router.select(Capability.INTENT_SELECTION);
    } catch {
      return { kind: 'unavailable', cause: 'no-provider', latencyMs: Math.max(0, clock() - started) };
    }
    const egress = sameEgress(provider, turn.chatProviderId, turn.chatProviderLocality);
    if (egress !== 'same') return { kind: 'egress-refused', reason: egress };
    // A6-D3: a turn with any fresh reference record bypasses the cache (no read, no write); an action, ITEM_READ or ref
    // output is never stored and never served, so a side-effecting choice always reflects this turn's state.
    const actionsOn = reference !== undefined;
    const bypass = actionsOn && hasReferenceRecord(reference);
    const cacheKey = JSON.stringify([
      turn.actor.id,
      normalizeForMatch(prepared.text),
      previous ?? null,
      turn.entries.map((entry) => entry.id),
    ]);
    const hit = bypass ? undefined : this.cache.get(cacheKey);
    if (hit !== undefined && clock() - hit.at < NL_SELECTION_CACHE_TTL_MS && !(actionsOn && !isCacheableOutput(hit.output))) {
      return { kind: 'output', output: hit.output, latencyMs: Math.max(0, clock() - started), cached: true };
    }
    if (hit !== undefined) this.cache.delete(cacheKey);
    const timeoutMs = this.deps.timeoutMs ?? NL_SELECTION_TIMEOUT_MS;
    const prompt = buildSelectionPrompt({
      entries: turn.entries,
      text: prepared.text,
      ...(previous !== undefined ? { previous } : {}),
      ...(reference !== undefined ? { actions: { referenceContext: renderReferenceContext(reference) } } : {}),
    });
    let rawText: string;
    try {
      const result = await withTimeout(
        provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
        timeoutMs,
      );
      rawText = result.text;
    } catch (error) {
      return { kind: 'unavailable', cause: error instanceof SelectionTimeout ? 'timeout' : 'failed', latencyMs: Math.max(0, clock() - started) };
    }
    const latencyMs = Math.max(0, clock() - started);
    const output = parseSelectionOutput(rawText);
    if (output === null) return { kind: 'unavailable', cause: 'malformed', latencyMs };
    if (!bypass && (!actionsOn || isCacheableOutput(output))) {
      this.cache.set(cacheKey, { at: clock(), output });
      while (this.cache.size > NL_SELECTION_CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return { kind: 'output', output, latencyMs, cached: false };
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private validationContext(turn: NlSelectionTurn, groundingText: string, previousArgs: NlArgs | undefined, actions = false): NlValidationContext {
    return {
      offered: offeredMap(turn.entries),
      groundingText,
      ...(previousArgs !== undefined ? { previousArgs } : {}),
      now: turn.now,
      timeZone: this.deps.timeZone,
      ...(actions ? { actions: true } : {}),
    };
  }

  private async writeSession(turn: NlSelectionTurn, key: string, update: (current: unknown) => unknown): Promise<void> {
    try {
      await this.deps.sessions.updateMetadataEntry({ id: turn.session.id }, key, update);
    } catch (error) {
      this.log('warn', 'nl_selection.session_write_failed', { key, errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  /** Re-read the Actor, replace only the preferences key, save (ADR-0120 D7 wave-1 storage). */
  private async savePreference(turn: NlSelectionTurn, key: string, value: string): Promise<boolean> {
    try {
      const actor = (await this.deps.actors.get(turn.actor.id)) ?? turn.actor;
      const metadata = { ...(actor.metadata ?? {}) };
      metadata[INTERPRETATION_PREFERENCES_METADATA_KEY] = withInterpretationPreference(
        metadata[INTERPRETATION_PREFERENCES_METADATA_KEY],
        key,
        value,
        turn.now,
      );
      await this.deps.actors.save({ ...actor, metadata });
      this.log('info', 'nl_selection.preference_saved', { key });
      return true;
    } catch (error) {
      this.log('warn', 'nl_selection.preference_write_failed', { key, errorName: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }

  /**
   * ADR-0120 D10/D11 (S1): one content-free line per Phase C grammar-hit turn — the grammar id, the grammar's entry id,
   * the selector's entry id (or none), the outcome and whether the two agree (entry, and entry plus args). Never the text
   * and never an argument value. Nothing is logged on a turn without a grammar probe.
   */
  private logAgreement(
    turn: NlSelectionTurn,
    result: {
      readonly outcome: 'execute' | 'ask' | 'none' | 'skip' | 'unavailable' | 'fallback' | 'dropped';
      readonly selection?: NlGrammarSelection;
      readonly reason?: string;
      readonly latencyMs?: number;
      readonly cached?: boolean;
      readonly shadow?: boolean;
    },
  ): void {
    const grammar = turn.grammar;
    if (grammar === undefined) return;
    const decided = result.outcome === 'execute' || result.outcome === 'ask' || result.outcome === 'none';
    const agreeEntry = result.selection !== undefined && grammar.selection !== undefined && result.selection.entryId === grammar.selection.entryId;
    this.log('info', 'nl_selection.agreement', {
      grammarId: grammar.grammarId,
      grammarEntryId: grammar.selection?.entryId ?? 'none',
      entryId: result.selection?.entryId ?? 'none',
      outcome: result.outcome,
      mode: result.shadow === true ? 'shadow' : 'active',
      // W3: `agree` compares MEANING (dates resolved by Core's clock, catalog defaults, count dropped; nothing that changes
      // the results is normalized, `nlSelectionMeaning`) and is what D10 reads; `agreeEntry` is the entry alone.
      ...(decided ? { agree: agreeEntry && this.sameMeaning(turn, result.selection, grammar.selection), agreeEntry } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.cached !== undefined ? { cached: result.cached } : {}),
    });
  }

  /** W3: both selections resolved to what the owner would see, with this turn's clock (values compared, never logged). */
  private sameMeaning(turn: Pick<NlSelectionTurn, 'entries' | 'now'>, a: NlGrammarSelection | undefined, b: NlGrammarSelection | undefined): boolean {
    if (a === undefined || b === undefined || a.entryId !== b.entryId) return false;
    const entry = turn.entries.find((candidate) => candidate.id === a.entryId);
    return nlSelectionMeaning(a, entry, turn.now, this.deps.timeZone) === nlSelectionMeaning(b, entry, turn.now, this.deps.timeZone);
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
 * ADR-0120 D6/D8 plus the S1 hardening: a selection request may go only where this turn's chat would go — the same
 * provider family (or id) AND the same declared execution locality. Compared as opaque data, never as a name.
 */
function sameEgress(
  selector: Pick<AiProvider, 'id' | 'family' | 'executionLocality'>,
  chatProviderId: string,
  chatProviderLocality: AiExecutionLocality | undefined,
): 'same' | 'chat-provider-differs' | 'chat-locality-differs' {
  if ((selector.family ?? selector.id) !== chatProviderId) return 'chat-provider-differs';
  if (executionLocalityOf(selector) !== (chatProviderLocality ?? 'REMOTE')) return 'chat-locality-differs';
  return 'same';
}


/** Whether the owner's own words name `value` of `key` (one of its grounding words, case- and spacing-insensitive). */
function isAmbiguityValueGrounded(key: NlAmbiguityKey, value: string, groundingText: string): boolean {
  const known = key.values.find((candidate) => candidate.value === value);
  if (known === undefined || groundingText.length === 0) return false;
  const text = normalizeForMatch(groundingText);
  return (known.grounding ?? []).some((word) => text.includes(normalizeForMatch(word)));
}

/** Validation, then up to three retries with the failing optional argument removed (a clarification option). */
function validateWithRepair(candidate: NlSelectionCandidate, ctx: NlValidationContext): NlValidationResult {
  let current = candidate;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = validateSelection(current, ctx);
    if (result.ok) return result;
    // A time word in a keyword, or a period that lost the owner's weekday, is never repaired by dropping it: the period it
    // names would be lost silently (A5 rule 6, A5 implementation note 2).
    if (result.reason === 'time-keyword' || result.reason === 'weekday') return result;
    const entry = result.entryId === undefined ? undefined : ctx.offered.get(result.entryId);
    const spec = entry?.args.find((arg) => arg.name === result.arg);
    if (spec === undefined || spec.required === true || !(spec.name in current.args)) return result;
    const { [spec.name]: _dropped, ...rest } = current.args;
    current = { entryId: current.entryId, args: rest };
  }
  return validateSelection(current, ctx);
}

function offeredMap(entries: readonly NlCatalogEntry[]): Map<string, NlCatalogEntry> {
  return new Map(entries.map((entry) => [entry.id, entry] as const));
}

/** The fixed, content-free warm-up prompt (a constant: the instruction text, no catalog entry, the probe word). */
export function nlWarmupPrompt(): string {
  return buildSelectionPrompt({ entries: [], text: NL_WARMUP_PROBE_TEXT });
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, unref = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SelectionTimeout()), timeoutMs);
    if (unref) timer.unref();
  });
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Korean when the text has Hangul, else English. */
export function languageOf(text: string): 'ko' | 'en' {
  return /[ㄱ-ㆎ가-힣]/u.test(text) ? 'ko' : 'en';
}

/** How a reply resolves an open numbered question (ADR-0120 D7). */
export type ChoiceResolution =
  | { readonly kind: 'pick'; readonly index: number }
  /** "둘 다 아니야", "취소": the question is closed and nothing runs. */
  | { readonly kind: 'cancel' }
  /** An answer that names options but not exactly one ("1이랑 2", "첫 번째 말고" of three): asked again. */
  | { readonly kind: 'unclear' }
  /** Not an answer (a new request, a longer sentence): the question ends and the message is routed normally. */
  | { readonly kind: 'none' };

const ORDINAL_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/(?:첫|1)\s*번\s*째|첫\s*째|\bfirst\b/gu, 0],
  [/(?:두|2)\s*번\s*째|둘\s*째|\bsecond\b/gu, 1],
  [/(?:세|3)\s*번\s*째|셋\s*째|\bthird\b/gu, 2],
  [/(?:네|4)\s*번\s*째|넷\s*째|\bfourth\b/gu, 3],
];
const NUMBER = /(?<![0-9])([1-9])(?:\s*번)?(?![0-9])/gu;
/** A negation or correction right after a mention ("1번 말고", "첫 번째 아니고") or right before it ("not 1"). */
const NEGATED_AFTER = /^\s*(?:은|는|이|가)?\s*(?:말고|아니고|아니라|빼고|제외하고|싫고|아니야|아냐)/u;
const NEGATED_BEFORE = /(?:\bnot|\bexcept|instead\s+of)\s*$/u;
const CANCEL =
  /^(?:(?:둘|셋|넷)\s*다|모두|전부|다|none|neither|both)\s*(?:아니(?:야|요|에요)?|아냐|싫어|별로|no|not)|^(?:취소|그만|됐어(?:요)?|아니(?:야|요)?|아뇨|no|nope|cancel|never\s*mind)$/u;
const LEADING_CORRECTION = /^(?:아니(?:요|야)?|아뇨|no|nope)[,\s]+/u;
/** Words an answer may carry besides the mention itself ("2번이요", "지라로 해줘", "담당만"). */
const FILLER =
  /(?:번|째|이요|에요|예요|요|으로|로|만|걸로|그걸로|거|것|할게|해\s*줘|해\s*주세요|해줘|선택|그럼|음|이랑|랑|하고|\band\b|\bor\b|please|the|one|option|it|,|\.)/gu;

/**
 * Resolve a reply to an open question strictly: a number or ordinal alone, or an exact option label/alias, plus at
 * most fillers and particles. A negated mention ("첫 번째 말고 두 번째", "not 1") picks the option that is not negated;
 * "아니 1" is a correction that picks 1; "둘 다 아니야" cancels. Nothing is prefix-matched inside a longer sentence: any
 * other word left over makes the reply not an answer.
 */
export function resolveChoice(reply: string, labels: readonly (readonly string[])[]): ChoiceResolution {
  let text = normalizeForMatch(reply).replace(/[!?。！？~…]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > 40) return { kind: 'none' };
  if (CANCEL.test(text)) return { kind: 'cancel' };
  text = text.replace(LEADING_CORRECTION, '');
  const mentions: Array<{ index: number; negated: boolean }> = [];
  let working = text;
  const consume = (pattern: RegExp, indexOf: (match: RegExpExecArray) => number): void => {
    for (const match of [...working.matchAll(pattern)]) {
      const at = match.index ?? 0;
      const end = at + match[0].length;
      const after = NEGATED_AFTER.exec(working.slice(end));
      const negated = after !== null || NEGATED_BEFORE.test(working.slice(0, at));
      mentions.push({ index: indexOf(match as RegExpExecArray), negated });
      const blankEnd = after !== null ? end + after[0].length : end;
      working = `${working.slice(0, at)}${' '.repeat(blankEnd - at)}${working.slice(blankEnd)}`;
    }
  };
  // Labels and aliases first, longest first, so "GitHub 이슈·PR 조회" is not read as the alias "이슈".
  const aliases = labels
    .flatMap((words, index) => words.map((word) => ({ word: normalizeForMatch(word), index })))
    .filter((alias) => alias.word.length > 0)
    .sort((a, b) => b.word.length - a.word.length);
  for (const alias of aliases) {
    consume(new RegExp(alias.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'), () => alias.index);
  }
  for (const [pattern, index] of ORDINAL_PATTERNS) consume(new RegExp(pattern.source, 'gu'), () => index);
  consume(new RegExp(NUMBER.source, 'gu'), (match) => Number(match[1]) - 1);
  if (mentions.length === 0) return { kind: 'none' };
  working = working.replace(/\b(?:not|except|instead\s+of)\b/gu, ' ');
  if (working.replace(FILLER, ' ').trim().length > 0) return { kind: 'none' };
  if (mentions.some((mention) => mention.index < 0 || mention.index >= labels.length)) return { kind: 'unclear' };
  const chosen = new Set(mentions.filter((mention) => !mention.negated).map((mention) => mention.index));
  const refused = new Set(mentions.filter((mention) => mention.negated).map((mention) => mention.index));
  if (chosen.size === 1) {
    const [index] = [...chosen] as [number];
    return refused.has(index) ? { kind: 'unclear' } : { kind: 'pick', index };
  }
  if (chosen.size === 0) {
    const remaining = labels.map((_words, index) => index).filter((index) => !refused.has(index));
    return remaining.length === 1 ? { kind: 'pick', index: remaining[0] as number } : remaining.length === 0 ? { kind: 'cancel' } : { kind: 'unclear' };
  }
  return { kind: 'unclear' };
}

/** The option a reply picks, or `undefined` (kept for callers that only need a pick). */
export function choiceIndex(reply: string, labels: readonly (readonly string[])[]): number | undefined {
  const resolved = resolveChoice(reply, labels);
  return resolved.kind === 'pick' ? resolved.index : undefined;
}

function pick(text: NlText, language: 'ko' | 'en'): string {
  return language === 'en' ? text.en : text.ko;
}

function renderBasis(described: string, language: 'ko' | 'en', note: 'saved' | 'changed' | undefined): string {
  const head = language === 'en' ? `Basis: ${described}` : `기준: ${described}`;
  if (note === 'saved') {
    return language === 'en'
      ? `${head} (saved for 30 days; say e.g. "only assigned to me" to change it)`
      : `${head} (30일 동안 이 기준을 써요. 바꾸려면 "아니 담당만"처럼 말해 주세요)`;
  }
  if (note === 'changed') return language === 'en' ? `${head} (basis updated)` : `${head} (기준을 바꿨어요)`;
  return head;
}

function renderEntryQuestion(options: readonly NlValidatedSelection[], language: 'ko' | 'en'): string {
  const lines = options.map((option, index) => {
    const described = option.entry.describe?.(option.args, option.range, language);
    const label = pick(option.entry.label, language);
    return `${index + 1}. ${described === undefined ? label : `${label} (${described})`}`;
  });
  return language === 'en'
    ? ['Which one do you mean?', ...lines, 'Reply with the number or the name.'].join('\n')
    : ['어떤 걸 찾으세요?', ...lines, '번호나 이름으로 답해 주세요.'].join('\n');
}

function renderPreferenceQuestion(key: NlAmbiguityKey, language: 'ko' | 'en'): string {
  const lines = key.values.map((value, index) => `${index + 1}. ${pick(value.label, language)}`);
  return [pick(key.question, language), ...lines, language === 'en' ? 'Reply with the number.' : '번호로 답해 주세요.'].join('\n');
}

function renderCancelled(language: 'ko' | 'en'): string {
  return language === 'en' ? 'OK, I cancelled that choice. Ask again whenever you like.' : '알겠어요, 선택을 취소했어요. 필요하면 다시 말씀해 주세요.';
}

function renderUsageQuestion(entry: NlCatalogEntry, language: 'ko' | 'en'): string {
  return language === 'en'
    ? `I could not tell exactly what to look up in ${pick(entry.label, language)}. Please say it like ${pick(entry.usage, language)}.`
    : `${pick(entry.label, language)}에서 무엇을 찾을지 정확히 모르겠어요. ${pick(entry.usage, language)}처럼 말씀해 주세요.`;
}

/** A6-D3: only `none` and READ outputs (main and alternatives) may be cached while actions are offered. */
function isCacheableOutput(output: NlSelectionOutput): boolean {
  if (output.entryId !== null && !isNlWave1EntryId(output.entryId)) return false;
  return output.alternatives.every((alternative) => isNlWave1EntryId(alternative.entryId));
}

/** The closed ref kind of a selector output, for the audit line. */
function refKindOf(args: NlArgs): NlActionAudit['refKind'] {
  if (typeof args.match === 'string') return 'match';
  const ref = parseNlRef(args.ref);
  return ref === undefined ? 'none' : ref.kind;
}

/** The fixed answer to an A6 validation failure (A6-D1/D3). */
function validationReply(reason: string, language: 'ko' | 'en'): string {
  switch (reason) {
    case 'deictic-payload':
      return renderDeicticPayload(language);
    case 'time-in-title':
      return renderTimeInTitle(language);
    case 'time-outside-when':
      return renderTimeOutsideWhen(language);
    case 'bulk':
      return renderBulk(language);
    case 'credential':
      return language === 'en'
        ? 'That looks like a password or token, so I will not store it. Nothing was changed.'
        : '비밀번호나 토큰처럼 보이는 내용은 저장하지 않아요. 아무것도 바꾸지 않았어요.';
    default:
      return renderRestate(language);
  }
}

function modeLabel(mode: string, language: 'ko' | 'en'): string {
  const value = ITEM_CONTENT_MODE.values.find((candidate) => candidate.value === mode);
  return value === undefined ? mode : language === 'en' ? value.label.en : value.label.ko;
}

/** A6: one inbound message (platform message ids are unique only per conversation). */
function echoKey(messageId: string, context: { readonly platform: string; readonly channelId: string }): string {
  return JSON.stringify([context.platform, context.channelId, messageId]);
}

/** A6-D3: the correlation fields of an audit line (session id and turn id), never content. */
function correlationOf(turn: Pick<NlSelectionTurn, 'session' | 'turnId'>): { readonly sessionId: string; readonly turnId?: string } {
  return { sessionId: turn.session.id, ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}) };
}

/** A6: the platform marked part of the message as quoted or as code: material, never one plain instruction. */
function markedMaterial(turn: Pick<NlSelectionTurn, 'quotedRanges' | 'codeFormatted'>): boolean {
  return (turn.quotedRanges ?? []).length > 0 || turn.codeFormatted === true;
}
