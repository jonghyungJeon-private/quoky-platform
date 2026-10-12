import { Capability, type Actor, type InboundQuotedRange, type IsoTimestamp, type Session } from '../../domain';
import type { AiProvider } from '../../ports/ai-provider.port';
import type { LogFields, Logger } from '../../ports/logger.port';
import type { ProviderSelectionContext } from '../../ports/provider-selection-policy.port';
import { containsCredentialMaterial } from '../credential-guard';
import type { SessionManager } from '../session-manager';
import type { NlAmbiguityKey, NlArgs, NlCatalogEntry, NlGrammarSelection, NlSelectedCommand, NlText } from './catalog';
import { normalizeForMatch, prepareSelectionInput, type PreparedSelectionInput } from './selection-input';
import { parseSelectionOutput, type NlSelectionCandidate, type NlSelectionOutput } from './selection-output';
import { buildSelectionPrompt } from './selection-prompt';
import {
  INTERPRETATION_PREFERENCES_METADATA_KEY,
  LAST_SELECTION_METADATA_KEY,
  NL_PENDING_METADATA_KEY,
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
 * (the owner's chat-tier choice does not apply, D2); a 4 s bound and no retry (D3). Before any call the complete request
 * — the prepared text and the previous selection's args — passes the credential guard; a credential-shaped value skips
 * selection with no call (D3 pre-egress guard). The cache is in memory only: per actor, 10 minutes, 256 entries.
 */

export type NlIntentMode = 'off' | 'shadow' | 'active';
export const NL_INTENT_MODES: readonly NlIntentMode[] = ['off', 'shadow', 'active'];

export const NL_SELECTION_TIMEOUT_MS = 4_000;
export const NL_SELECTION_CACHE_TTL_MS = 10 * 60_000;
export const NL_SELECTION_CACHE_MAX_ENTRIES = 256;

/** Which earlier route the turn was on when selection ran (the shadow log's "grammar id"). */
export type NlSelectionRoute = 'chat' | 'personal-data';

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
   * The open question as taken at the start of the turn (`takePending`), `null` when there was none. Absent: read from
   * `session.metadata` (direct callers).
   */
  readonly pending?: PendingQuestion | null;
}

export type NlSelectionSkipReason =
  | 'off'
  | 'shadow'
  | 'no-catalog'
  | 'too-long'
  | 'empty'
  | 'credential'
  | 'chat-provider-differs'
  | 'chat-provider-unknown';

export type NlSelectionDecision =
  /** Continue the turn exactly as without selection. */
  | { readonly kind: 'skip'; readonly reason: NlSelectionSkipReason }
  /** The selector found no entry: honest chat (D9). */
  | { readonly kind: 'none' }
  /** No provider, a timeout, a failure or malformed output: the existing path, then honest chat (D3, R5). */
  | { readonly kind: 'unavailable' }
  /** A validated read for the owning handler's `handleSelected`; `basis` is the first reply line (D7). */
  | { readonly kind: 'execute'; readonly command: NlSelectedCommand; readonly basis?: string }
  /** One numbered question (D7), never chat; the pending choice is already saved. */
  | { readonly kind: 'ask'; readonly text: string };

export interface NlSelectionServiceDeps {
  readonly mode: NlIntentMode;
  readonly router: { select(capability: Capability, context?: ProviderSelectionContext): Promise<AiProvider> };
  /** Field-scoped `Session.metadata` writes (`lastSelection`, the pending question). */
  /** ADR-0120 amendment A2 (`QUOKY_NL_GRAMMAR_YIELD=on`): Class B listing grammars may yield to selection. Default off. */
  readonly grammarYield?: boolean;
  readonly sessions: Pick<SessionManager, 'updateMetadataEntry'>;
  /** The Actor repository (`StorageProvider.actors`), for the D7 preferences: re-read, replace one key, save. */
  readonly actors: { get(id: string): Promise<Actor | null>; save(actor: Actor): Promise<Actor> };
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  readonly logger: Logger;
  /** Tests only; production uses {@link NL_SELECTION_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Tests only: monotonic milliseconds for latency (default `Date.now`). */
  readonly elapsed?: () => number;
}

interface CacheEntry {
  readonly at: number;
  readonly output: NlSelectionOutput;
}

type SelectOutcome =
  | { readonly kind: 'output'; readonly output: NlSelectionOutput; readonly latencyMs: number; readonly cached: boolean }
  /** D6/D8: the selector is not the provider this turn's chat would reach; nothing was sent. */
  | { readonly kind: 'egress-refused'; readonly reason: 'chat-provider-differs' | 'chat-provider-unknown' }
  | { readonly kind: 'unavailable'; readonly cause: 'no-provider' | 'timeout' | 'failed' | 'malformed'; readonly latencyMs: number };

class SelectionTimeout extends Error {
  constructor() {
    super('intent selection timed out');
    this.name = 'SelectionTimeout';
  }
}

export class NlSelectionService {
  readonly mode: NlIntentMode;
  private readonly cache = new Map<string, CacheEntry>();
  /** The last shadow run (tests await it; production never does). */
  lastShadowRun: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NlSelectionServiceDeps) {
    this.mode = deps.mode;
  }

  /** The decision for one Phase A turn. Never throws: an internal error is `unavailable`. */
  async decide(turn: NlSelectionTurn): Promise<NlSelectionDecision> {
    if (this.mode === 'off') return { kind: 'skip', reason: 'off' };
    if (turn.entries.length === 0) return { kind: 'skip', reason: 'no-catalog' };
    if (this.mode === 'shadow') {
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
   * ADR-0120 amendment A2: whether a Class B listing grammar may decline a message it cannot express in full — only with
   * the yield flag on, in `active`, and when selection would run for this turn (the selector is the provider this turn's
   * chat would reach, D6/D8). Never throws.
   */
  /** Cheap pre-check (no router call): the flag is on and the mode is `active`. */
  grammarYieldEnabled(): boolean {
    return this.mode === 'active' && this.deps.grammarYield === true;
  }

  async yieldsToSelection(chatProviderId: string | undefined): Promise<boolean> {
    if (this.mode !== 'active' || this.deps.grammarYield !== true || chatProviderId === undefined) return false;
    try {
      const provider = await this.deps.router.select(Capability.INTENT_SELECTION);
      return (provider.family ?? provider.id) === chatProviderId;
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
        const answered = await this.answerPending(pending, turn, answerInput.groundingText, /\p{L}/u.test(answerInput.groundingText) ? language : pending.language);
        if (answered !== undefined) return answered;
      }
    }
    const last = readLastSelection(turn.session, turn.actor.id, turn.now);
    const prepared = this.prepare(turn, last);
    if ('skip' in prepared) {
      this.log('info', 'nl_selection.skipped', { reason: prepared.skip, route: turn.route });
      return { kind: 'skip', reason: prepared.skip };
    }
    const selected = await this.select(turn, prepared, last);
    if (selected.kind === 'egress-refused') {
      this.log('info', 'nl_selection.skipped', { reason: selected.reason, route: turn.route });
      return { kind: 'skip', reason: selected.reason };
    }
    if (selected.kind === 'unavailable') {
      this.log('info', 'nl_selection.decided', { outcome: 'unavailable', cause: selected.cause, route: turn.route, latencyMs: selected.latencyMs });
      return { kind: 'unavailable' };
    }
    const decision = await this.fromOutput(selected.output, turn, prepared, last, language);
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
  ): Promise<NlSelectionDecision> {
    if (output.entryId === null) return { kind: 'none' };
    const ctx = this.validationContext(turn, prepared.groundingText, last?.args);
    const main = validateSelection({ entryId: output.entryId, args: output.args }, ctx);
    if (main.ok && output.ambiguity === 'CLEAR') return this.complete(main.value, turn, last, language, prepared.groundingText);
    // D7: two candidates or a failed validation ask one numbered question, never chat and never a guess.
    const options: NlValidatedSelection[] = [];
    for (const candidate of [{ entryId: output.entryId, args: output.args }, ...output.alternatives]) {
      const repaired = validateWithRepair(candidate, ctx);
      if (repaired.ok && !options.some((option) => option.entry.id === repaired.value.entry.id)) options.push(repaired.value);
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
    const stored = options.map((option): StoredSelection => ({ entryId: option.entry.id, args: option.args }));
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
          selection: { entryId: entry.id, args },
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
    await this.writeSession(turn, LAST_SELECTION_METADATA_KEY, () => lastSelectionRecord(turn.actor.id, { entryId: entry.id, args }, turn.now));
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

  // ── shadow ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async shadow(turn: NlSelectionTurn): Promise<void> {
    const last = readLastSelection(turn.session, turn.actor.id, turn.now);
    const prepared = this.prepare(turn, last);
    if ('skip' in prepared) {
      this.log('info', 'nl_selection.shadow', { outcome: 'skipped', reason: prepared.skip, grammarId: turn.route });
      return;
    }
    const selected = await this.select(turn, prepared, last);
    if (selected.kind === 'egress-refused') {
      this.log('info', 'nl_selection.shadow', { outcome: 'skipped', reason: selected.reason, grammarId: turn.route });
      return;
    }
    if (selected.kind === 'unavailable') {
      this.log('info', 'nl_selection.shadow', { outcome: 'unavailable', cause: selected.cause, grammarId: turn.route, latencyMs: selected.latencyMs });
      return;
    }
    const output = selected.output;
    let outcome = output.entryId === null ? 'none' : output.ambiguity;
    if (output.entryId !== null) {
      const validated = validateSelection({ entryId: output.entryId, args: output.args }, this.validationContext(turn, prepared.groundingText, last?.args));
      if (!validated.ok) outcome = 'INVALID';
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

  private async select(turn: NlSelectionTurn, prepared: PreparedSelectionInput, last: LastSelection | undefined): Promise<SelectOutcome> {
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
    if ((provider.family ?? provider.id) !== turn.chatProviderId) return { kind: 'egress-refused', reason: 'chat-provider-differs' };
    const cacheKey = JSON.stringify([
      turn.actor.id,
      normalizeForMatch(prepared.text),
      previous ?? null,
      turn.entries.map((entry) => entry.id),
    ]);
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined && clock() - hit.at < NL_SELECTION_CACHE_TTL_MS) {
      return { kind: 'output', output: hit.output, latencyMs: Math.max(0, clock() - started), cached: true };
    }
    if (hit !== undefined) this.cache.delete(cacheKey);
    const timeoutMs = this.deps.timeoutMs ?? NL_SELECTION_TIMEOUT_MS;
    const prompt = buildSelectionPrompt({ entries: turn.entries, text: prepared.text, ...(previous !== undefined ? { previous } : {}) });
    let rawText: string;
    try {
      const result = await withTimeout(
        provider.execute({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs }),
        timeoutMs,
      );
      rawText = result.text;
    } catch (error) {
      return { kind: 'unavailable', cause: error instanceof SelectionTimeout ? 'timeout' : 'failed', latencyMs: Math.max(0, clock() - started) };
    }
    const latencyMs = Math.max(0, clock() - started);
    const output = parseSelectionOutput(rawText);
    if (output === null) return { kind: 'unavailable', cause: 'malformed', latencyMs };
    this.cache.set(cacheKey, { at: clock(), output });
    while (this.cache.size > NL_SELECTION_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return { kind: 'output', output, latencyMs, cached: false };
  }

  // ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private validationContext(turn: NlSelectionTurn, groundingText: string, previousArgs: NlArgs | undefined): NlValidationContext {
    return {
      offered: offeredMap(turn.entries),
      groundingText,
      ...(previousArgs !== undefined ? { previousArgs } : {}),
      now: turn.now,
      timeZone: this.deps.timeZone,
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

  private log(level: 'info' | 'warn', event: string, fields: LogFields): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
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

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SelectionTimeout()), timeoutMs);
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
