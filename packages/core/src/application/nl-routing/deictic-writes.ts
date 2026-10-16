import { normalizeWorkItemTitle, type Actor, type Id, type IsoTimestamp, type MessageBody, type Session } from '../../domain';
import type { LogFields } from '../../ports/logger.port';
import { newId } from '../../util/id';
import { containsCredentialMaterial } from '../credential-guard';
import { plainTextOf } from '../message-rendering';
import { parseReminderWhen } from '../reminders/reminder-grammar';
import { reminderWhenPreviewLabel } from '../reminders/reminder-reply-composer';
import { toZonedDateTime } from '../reminders/zoned-time';
import type { SessionManager } from '../session-manager';
import { SESSION_WRITE_LOCK, type SessionLockHold, type SessionWriteLock } from '../session-write-lock';
import {
  containsNlTimeExpression,
  isNlDeicticOnlyPayload,
  isNlSpanGrounded,
  nlActionInputRefusal,
  nlActionWordGrounded,
  nlActionEntry,
  nlHasInvisibleCharacters,
  nlNamedItemSources,
  nlNumeralsIn,
  nlOrdinalsIn,
  normalizeNlSpan,
  withoutNlOriginPhrases,
  withoutSpan,
  withoutStructures,
  NL_SPAN_MAX_CHARS,
  NL_WHEN_MAX_CHARS,
} from './action-entries';
import type { NlArgs, NlSelectedCommand } from './catalog';
import {
  DEICTIC_DRAFT_METADATA_KEY,
  deicticPayloadHash,
  isDeicticDraftLive,
  readDeicticDraft,
  referentKey,
  withDeicticDraft,
  withDeicticPreviewReplies,
  type DeicticDraft,
  type DeicticEntryId,
  type DeicticReferentRef,
  type DeicticWhen,
} from './deictic-draft';
import { interpretDeicticDraftReply } from './deictic-draft-reply';
import { resolveDeicticReferent, type DeicticResolution } from './deictic-referent';
import {
  DEICTIC_PREVIEW_HISTORY_NOTE,
  DEICTIC_QUESTION_HISTORY_NOTE,
  renderDeicticAnswer,
  renderDeicticChoose,
  renderDeicticDropped,
  renderDeicticPreview,
  renderDeicticRefusal,
  renderDeicticTimeQuestion,
  type DeicticAnswerCopy,
  type DeicticCandidateLine,
  type DeicticOriginLine,
  type DeicticRefusalCopy,
} from './deictic-render';
import type { NlReferenceState } from './item-reference';
import { normalizeForMatch } from './selection-input';
import {
  LAST_TURN_METADATA_KEY,
  nlOwnerMessageEligibility,
  ownerMessageHash,
  readLastTurn,
  withLastTurn,
  withLastTurnReplies,
  type LastTurnRecord,
  type LastTurnReplyKind,
} from './last-turn';
import {
  NL_ACTION_LOG_EVENT,
  NlActionCaps,
  nlActionLogFields,
  renderActionStopped,
  renderCapped,
  renderQuestionOpen,
  renderTimeInTitle,
  resolveLabelChoice,
  type NlActionAudit,
  type NlDeicticRefKind,
} from './nl-action-policy';

/**
 * ADR-0120 amendment A6 R5a — deictic writes ("그거 할 일로 추가해줘"), as ratified by the owner on 2026-10-16 (decisions
 * 1a and 2–9; 1b, Quoky answers, deferred). Only the owner's verbatim earlier text may become the payload of `todo.add` /
 * `reminder.create`: a to-do title or a TEXT reminder body the owner typed (event-linked and BRIEF reminders excluded), or
 * the owner's previous plain message that was eligible when it was received. Everything else is refused with a fixed
 * reply and nothing written.
 *
 * Flow: one selector call as today; where Core would refuse with `deictic-payload` the referent is resolved in code
 * (`resolveDeicticReferent`), re-read from its own store and previewed. Only the owner's NEXT turn in the same session,
 * within 5 minutes, approves it through the narrow whole-message matcher (`interpretDeicticDraftReply`); a platform reply
 * must name the preview. The consume step — read the draft, re-read and re-hash the payload, clear the draft, execute
 * through the existing handler path — holds ONE `SESSION_WRITE_LOCK` (ADR-0113 D7), so it runs at most once. Approval and
 * deny turns make no selector call. The `lastTurn` write runs under the same lock.
 *
 * `QUOKY_NL_DEICTIC_WRITES`: `off` (default) writes and changes nothing; `shadow` resolves and logs and replies as today;
 * `on` previews. Any level but `off` requires `QUOKY_NL_ACTIONS=local`; DM only.
 */

export type NlDeicticWritesMode = 'off' | 'shadow' | 'on';
export const NL_DEICTIC_WRITES_MODES: readonly NlDeicticWritesMode[] = ['off', 'shadow', 'on'];

/** §4 caps per actor: at most 10 previews an hour and 30 a day (executions count toward LOCAL_WRITE). */
export const NL_DEICTIC_PREVIEW_CAPS = Object.freeze({ localWritePerHour: 10, localWritePerDay: 30, itemReadPerHour: 0, externalPerHour: 0, externalPerDay: 0 });

/**
 * The read-only view of the stores a referent's text lives in (wired by the composition root over the existing
 * repositories; no new port). Every method answers `null` for an absent record or one of another actor.
 */
export interface NlDeicticTextReader {
  /** A to-do by id: its stored (normalised) title and how it was created (`conversation` = the owner's words). */
  todo(actorId: Id, itemId: Id): Promise<{ readonly title?: string; readonly origin: string } | null>;
  /** A reminder by its stable display number: its id, body, body kind and whether it is linked to a calendar event. */
  reminder(actorId: Id, displayNo: number): Promise<{ readonly id: Id; readonly body: string; readonly kind: string; readonly eventLinked: boolean } | null>;
  /** A SHORT_TERM conversation record by id: its text, session and role. */
  ownerMessage(memoryId: Id): Promise<{ readonly content: string; readonly sessionId?: Id; readonly role?: string } | null>;
  /** The open to-do number of an ACTIVE to-do with exactly this title (the duplicate note), if any. */
  duplicateTodo?(actorId: Id, title: string): Promise<number | undefined>;
}

export interface NlDeicticWritesDeps {
  readonly mode: NlDeicticWritesMode;
  readonly texts: NlDeicticTextReader;
  readonly sessions: Pick<SessionManager, 'updateMetadataEntry'>;
  readonly timeZone: string;
  readonly log: (level: 'info' | 'warn', event: string, fields: LogFields) => void;
  /** The A6 LOCAL_WRITE caps (an approved write counts there). */
  readonly actionCaps: NlActionCaps;
  /** The A6-D3 kill switch, re-read from the persisted Actor (the last check before a write). */
  readonly stillActing: (actor: Pick<Actor, 'id' | 'metadata'>) => Promise<boolean>;
  readonly sessionLock?: SessionWriteLock;
  /** Tests only: other preview caps. */
  readonly previewCaps?: NlActionCaps;
}

/** A fixed question / refusal / preview reply of a deictic write (the runtime presents it like any A6 question). */
export interface DeicticReply {
  readonly text: string;
  readonly body: MessageBody;
  /** The SHORT_TERM assistant record instead of the text (a fixed note whenever the reply shows the owner's items). */
  readonly history?: string;
  readonly replyKind: Extract<LastTurnReplyKind, 'preview' | 'question' | 'refusal'>;
}

/** The answer to a pending draft: a fixed reply, an executed write, or the draft dropped and the turn routed normally. */
export type DeicticAnswer<T> =
  | ({ readonly kind: 'reply' } & DeicticReply)
  | { readonly kind: 'executed'; readonly value: T; readonly audit: NlActionAudit; readonly command: NlSelectedCommand }
  | { readonly kind: 'dropped'; readonly prefix?: string };

export interface DeicticTurn {
  readonly session: Pick<Session, 'id' | 'metadata'>;
  readonly actor: Actor;
  readonly now: IsoTimestamp;
  readonly text: string;
  /** The owner's own words (quoted text removed). */
  readonly groundingText: string;
  readonly language: 'ko' | 'en';
  readonly replyToMessageId?: string;
  readonly turnId?: string;
  /** The platform marked part of the text as quoted or as code. */
  readonly marked: boolean;
}

/** What the referent's store holds now, ready for a preview (or why not). */
type PayloadRead =
  | { readonly ok: true; readonly payload: string; readonly origin: DeicticOriginLine; readonly raw: string }
  | { readonly ok: false; readonly reason: DeicticRefusalCopy | 'time-in-title' };

interface PendingDelivery {
  readonly actorId: string;
  readonly at: IsoTimestamp;
  readonly lastTurn: boolean;
  readonly draftId?: string;
}

/** Closed request fillers that carry no content: what an action stem leaves ("어줘", "해요") and polite words. */
const REQUEST_FILLER = /^(?:(?:해|하)?(?:어|아|여)?(?:줘|줘요|주세요|주라|줄래|줄래요|둬|둬요|두라|라|요|봐)?|꼭|말고|제발|부탁(?:해|해요|드려요|드립니다)?|좀|항목[은을이가]?|아이템|please|pls|me)$/u;

const DELIVERIES_MAX = 64;
const DELIVERY_TTL_MS = 5 * 60_000;

export class NlDeicticWrites {
  readonly mode: NlDeicticWritesMode;
  private readonly lock: SessionWriteLock;
  private readonly previewCaps: NlActionCaps;
  private readonly deliveries = new Map<string, PendingDelivery>();

  constructor(private readonly deps: NlDeicticWritesDeps) {
    this.mode = deps.mode;
    this.lock = deps.sessionLock ?? SESSION_WRITE_LOCK;
    this.previewCaps = deps.previewCaps ?? new NlActionCaps(NL_DEICTIC_PREVIEW_CAPS);
  }

  // ── detection ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Whether a selector output for `todo.add` / `reminder.create` is a deictic write: its payload span is only deictic,
   * ordinal or time words once origin phrases ("내가 말한", "네가 추천한") are removed, and the owner's words (origin
   * phrases removed) request the entry's action. Pure. Never true with the flag `off`.
   */
  isDeicticRequest(entryId: string, args: NlArgs, groundingText: string): entryId is DeicticEntryId {
    if (this.mode === 'off' || (entryId !== 'todo.add' && entryId !== 'reminder.create')) return false;
    const span = entryId === 'todo.add' ? args.title : args.body;
    if (typeof span !== 'string' || span.trim().length === 0) return false;
    if (!isNlDeicticOnlyPayload(withoutNlOriginPhrases(span)) && !isNlDeicticOnlyPayload(span)) return false;
    // A6 R5a review: the deictic span must stand in the owner's own words (a selector-invented "그거" is not a request).
    const bare = normalizeNlSpan(span);
    const stripped = withoutNlOriginPhrases(bare);
    const stood = isNlSpanGrounded(bare, groundingText) ? bare : stripped.length > 0 && isNlSpanGrounded(stripped, groundingText) ? stripped : undefined;
    if (stood === undefined) return false;
    const prose = withoutNlOriginPhrases(withoutStructures(groundingText));
    const actionWords = nlActionEntry(entryId).actionGrounding ?? [];
    // The request-shape vetoes (A6-D3a amendment 1) on the frame without origin phrases; the time span is the time. The
    // service also requires the stripped validation to carry no `not-request` veto (DEICTIC_BLOCKING_FAILURES).
    const when = entryId === 'reminder.create' && typeof args.when === 'string' ? args.when : undefined;
    if (!nlActionWordGrounded(prose, actionWords, when !== undefined ? { when } : {})) return false;
    // A message with its own explicit content ("보고서 정리 할 일로 추가해줘") is not deictic: nothing but the span, the
    // action words, the time words and request endings may be left.
    let rest = withoutSpan(normalizeForMatch(prose), normalizeForMatch(stood));
    if (entryId === 'reminder.create' && typeof args.when === 'string') rest = withoutSpan(rest, normalizeForMatch(normalizeNlSpan(args.when)));
    for (const word of [...actionWords].sort((a, b) => b.length - a.length)) rest = rest.split(normalizeForMatch(word)).join(' ');
    rest = rest.split(/\s+/u).filter((token) => !REQUEST_FILLER.test(token.replace(/[\p{P}\p{S}]+/gu, ''))).join(' ');
    return isNlDeicticOnlyPayload(rest);
  }

  // ── the request turn: resolve, read, preview ───────────────────────────────────────────────────────────────────

  /**
   * §1.4 → §2 / §3.1. `undefined` means "today's reply" (the flag is `shadow`, nothing is referable, or the turn is not a
   * DM): the caller answers with the unchanged `deictic-payload` refusal. Never throws for a store failure (it refuses).
   */
  async decide(input: {
    readonly entryId: DeicticEntryId;
    readonly args: NlArgs;
    readonly turn: DeicticTurn;
    readonly reference: NlReferenceState;
    readonly direct: boolean;
    readonly questionOpen: boolean;
    readonly latencyMs: number;
  }): Promise<DeicticReply | undefined> {
    const { entryId, turn } = input;
    if (this.mode === 'off' || !input.direct) return undefined;
    const whenSpan = entryId === 'reminder.create' ? groundedWhen(input.args.when, turn.groundingText) : undefined;
    const lastTurn = readLastTurn(turn.session.metadata?.[LAST_TURN_METADATA_KEY], turn.actor.id, turn.now);
    const resolution = resolveDeicticReferent({ entryId, groundingText: turn.groundingText, ...(whenSpan !== undefined ? { whenSpan } : {}), state: input.reference, ...(lastTurn !== undefined ? { lastTurn } : {}) });
    const audit = this.baseAudit(entryId, turn, resolution, input.latencyMs);
    if (this.mode === 'shadow') {
      this.audit({ ...audit, result: 'shadow', ...(resolution.kind === 'refuse' ? { reason: resolution.reason } : {}) });
      return undefined;
    }
    if (resolution.kind === 'nothing') return undefined;
    if (input.questionOpen) return this.refusalReply({ ...audit, result: 'refused', reason: 'pending-question' }, renderQuestionOpen(turn.language));
    if (resolution.kind === 'refuse') return this.refusalReply({ ...audit, result: 'refused', reason: resolution.reason }, renderDeicticRefusal(resolution.reason, entryId, turn.language));
    if (!this.previewCaps.allows(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now))) {
      return this.refusalReply({ ...audit, result: 'capped', reason: 'capped' }, renderDeicticRefusal('capped', entryId, turn.language));
    }
    try {
      if (resolution.kind === 'ask') return await this.askCandidates(entryId, turn, resolution.candidates, whenSpan, audit);
      return await this.previewOrAskTime(entryId, turn, resolution.referent, whenSpan, audit);
    } catch (error) {
      this.deps.log('warn', 'nl_action.deictic_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return this.refusalReply({ ...audit, result: 'refused', reason: 'failed' }, renderDeicticRefusal('gone', entryId, turn.language));
    }
  }

  /** A preview (when the time is known or not needed) or the time question for a reminder. */
  private async previewOrAskTime(
    entryId: DeicticEntryId,
    turn: DeicticTurn,
    referent: DeicticReferentRef,
    whenSpan: string | undefined,
    audit: DeicticAuditBase,
    held?: SessionLockHold,
  ): Promise<DeicticReply> {
    const read = await this.readPayload(entryId, turn, referent);
    if (!read.ok) return this.payloadRefusal(read.reason, entryId, turn, audit);
    let when: DeicticWhen | undefined;
    if (entryId === 'reminder.create') {
      when = whenSpan === undefined ? undefined : this.parseWhen(whenSpan, turn.now);
      if (when === undefined) {
        await this.saveDraft(turn, { stage: 'time', draftId: newId(), entryId, referent, at: turn.now, requestId: turn.turnId ?? newId(), language: turn.language }, held);
        this.audit({ ...audit, result: 'asked', reason: 'no-time', referentLabel: labelOf(referent) });
        const text = renderDeicticTimeQuestion(turn.language);
        return { text, body: text, replyKind: 'question' };
      }
    }
    // The hourly and daily preview budget is rechecked where the preview is created (answer paths resume here too).
    if (!this.previewCaps.allows(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now))) {
      return this.refusalReply({ ...audit, result: 'capped', reason: 'capped' }, renderDeicticRefusal('capped', entryId, turn.language));
    }
    const payloadHash = deicticPayloadHash({ actorId: turn.actor.id, sessionId: turn.session.id, entryId, payload: read.payload, ...(when !== undefined ? { when } : {}), referent });
    const draftId = newId();
    const draft: DeicticDraft = {
      stage: 'preview',
      draftId,
      entryId,
      referent,
      payloadHash,
      ...(when !== undefined ? { when } : {}),
      at: turn.now,
      requestId: turn.turnId ?? draftId,
      language: turn.language,
      previewReplyIds: [],
    };
    await this.saveDraft(turn, draft, held);
    this.previewCaps.note(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now));
    if (turn.turnId !== undefined) this.awaitDelivery(turn.session.id, turn.turnId, { actorId: turn.actor.id, at: turn.now, lastTurn: false, draftId });
    const duplicateOf = entryId === 'todo.add' ? await this.deps.texts.duplicateTodo?.(turn.actor.id, read.payload).catch(() => undefined) : undefined;
    const whenLabel = when !== undefined ? this.whenLabel(when, turn.now) : undefined;
    const body = renderDeicticPreview({
      entryId,
      payload: read.payload,
      origin: read.origin,
      language: turn.language,
      ...(whenLabel !== undefined ? { whenLabel } : {}),
      ...(duplicateOf !== undefined ? { duplicateOf } : {}),
      ...(entryId === 'reminder.create' && containsNlTimeExpression(read.raw) ? { textHasTime: true } : {}),
    });
    this.audit({ ...audit, result: 'previewed', referentLabel: labelOf(referent), payloadOrigin: payloadOriginOf(referent) });
    return { text: plainTextOf(body), body, history: DEICTIC_PREVIEW_HISTORY_NOTE, replyKind: 'preview' };
  }

  /** §2: several referents: each candidate's own text (re-read, owner text only) under its label; nothing pre-selected. */
  private async askCandidates(
    entryId: DeicticEntryId,
    turn: DeicticTurn,
    candidates: readonly DeicticReferentRef[],
    whenSpan: string | undefined,
    audit: DeicticAuditBase,
    held?: SessionLockHold,
  ): Promise<DeicticReply> {
    const shown: Array<{ readonly ref: DeicticReferentRef; readonly line: DeicticCandidateLine }> = [];
    for (const candidate of candidates) {
      const read = await this.readPayload(entryId, turn, candidate, { forDisplay: true });
      if (read.ok) shown.push({ ref: candidate, line: { origin: read.origin, text: read.payload } });
    }
    if (shown.length === 0) return this.payloadRefusal('ineligible', entryId, turn, audit);
    const draft: DeicticDraft =
      shown.length >= 2
        ? { stage: 'choose', draftId: newId(), entryId, candidates: shown.map((entry) => entry.ref), ...(whenSpan !== undefined ? { whenSpan } : {}), at: turn.now, requestId: turn.turnId ?? newId(), language: turn.language }
        : // One remaining candidate is still asked (never pre-selected): a one-option question.
          { stage: 'choose', draftId: newId(), entryId, candidates: [shown[0]!.ref, shown[0]!.ref], ...(whenSpan !== undefined ? { whenSpan } : {}), at: turn.now, requestId: turn.turnId ?? newId(), language: turn.language };
    await this.saveDraft(turn, draft, held);
    this.audit({ ...audit, result: 'asked', reason: 'ambiguous' });
    const body = renderDeicticChoose(entryId, shown.map((entry) => entry.line), turn.language);
    return { text: plainTextOf(body), body, history: DEICTIC_QUESTION_HISTORY_NOTE, replyKind: 'question' };
  }

  // ── the answer turn: the consume step under SESSION_WRITE_LOCK ──────────────────────────────────────────────────

  /** Whether this session holds a deictic draft of `actorId` (a cheap snapshot check before taking the lock). */
  hasDraft(session: Pick<Session, 'metadata'>, actorId: Id): boolean {
    return this.mode === 'on' && readDeicticDraft(session.metadata?.[DEICTIC_DRAFT_METADATA_KEY], actorId) !== undefined;
  }

  /**
   * One next-turn question per session (R5a × A6-D3a amendment 1): opening the `action-undo-confirm` question, or finding
   * one open at the start of a turn, drops this actor's draft without answering it. Content-free; never throws.
   */
  async clearDraft(session: Pick<Session, 'id' | 'metadata'>, actorId: Id, now: IsoTimestamp, why: 'undo-confirm-asked' | 'undo-confirm-open'): Promise<void> {
    if (!this.hasDraft(session, actorId)) return;
    try {
      await this.deps.sessions.updateMetadataEntry({ id: session.id }, DEICTIC_DRAFT_METADATA_KEY, (current) => withDeicticDraft(current, actorId, undefined, now));
      this.deps.log('info', 'nl_deictic.draft_superseded', { sessionId: session.id, why });
    } catch (error) {
      this.deps.log('warn', 'nl_selection.session_write_failed', { key: DEICTIC_DRAFT_METADATA_KEY, errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  /**
   * §3.2 / §3.3: the owner's turn after a draft. Under ONE session lock: read and clear the draft, interpret the answer,
   * and for an approval re-read the referent, re-hash it, re-check the kill switch and the caps, then `execute` the
   * command (the existing handler path; `execute` must not write the session). `undefined`: no draft (route normally).
   */
  async answer<T>(turn: DeicticTurn, execute: (command: NlSelectedCommand) => Promise<T>): Promise<DeicticAnswer<T> | undefined> {
    if (!this.hasDraft(turn.session, turn.actor.id)) return undefined;
    return this.lock.run(turn.session.id, async (hold) => {
      let raw: unknown;
      let lastTurnRaw: unknown;
      await this.deps.sessions.updateMetadataEntry(
        { id: turn.session.id },
        DEICTIC_DRAFT_METADATA_KEY,
        (current) => {
          raw = current;
          return withDeicticDraft(current, turn.actor.id, undefined, turn.now);
        },
        { held: hold, onCommitted: (saved) => (lastTurnRaw = saved.metadata?.[LAST_TURN_METADATA_KEY]) },
      );
      const draft = readDeicticDraft(raw, turn.actor.id);
      const reply = nlActionInputRefusal(turn.text, turn.groundingText, turn.marked) === undefined ? interpretDeicticDraftReply(turn.text) : 'none';
      const language = draft?.language ?? turn.language;
      // Consumed by a concurrent turn (the lock serialised us behind it).
      if (draft === undefined) return reply === 'approve' ? this.answerReply('already', language) : { kind: 'dropped' };
      const base: DeicticAuditBase = { entryId: draft.entryId, risk: 'LOCAL_WRITE', refKind: 'none', resolution: 'resolved', ...correlation(turn) };
      // Next turn only: the draft must come from the turn right before this one, and be younger than 5 minutes.
      const lastTurn = readLastTurn(lastTurnRaw, turn.actor.id, turn.now);
      const adjacent = lastTurn !== undefined && lastTurn.requestId === draft.requestId;
      if (!adjacent || !isDeicticDraftLive(draft, turn.now)) {
        this.audit({ ...base, result: 'expired' });
        if (reply === 'approve') return this.answerReply('expired', language);
        if (reply === 'deny') return this.answerReply(normalizeNlSpan(turn.text).startsWith('되돌려') ? 'declined-undo' : 'declined', language);
        return { kind: 'dropped' };
      }
      if (reply === 'deny' || (draft.stage === 'choose' && resolveLabelChoice(turn.groundingText, []).kind === 'cancel')) {
        this.audit({ ...base, result: 'declined' });
        return this.answerReply(normalizeNlSpan(turn.text).startsWith('되돌려') ? 'declined-undo' : 'declined', language);
      }
      if (draft.stage === 'choose') return this.answerChoose(draft, turn, base, hold);
      if (draft.stage === 'time') return this.answerTime(draft, turn, base, hold);
      if (reply === 'none') {
        this.audit({ ...base, result: 'declined', reason: 'none' });
        return { kind: 'dropped', prefix: renderDeicticDropped(language) };
      }
      // approve
      if (turn.replyToMessageId !== undefined && !draft.previewReplyIds.includes(turn.replyToMessageId)) {
        this.audit({ ...base, result: 'stale-reply' });
        return this.answerReply('stale-reply', language);
      }
      const read = await this.readPayload(draft.entryId, turn, draft.referent);
      if (!read.ok) {
        this.audit({ ...base, result: 'changed', reason: read.reason });
        return this.answerReply(read.reason === 'gone' || read.reason === 'not-found' ? 'missing' : 'changed', language);
      }
      const hash = deicticPayloadHash({ actorId: turn.actor.id, sessionId: turn.session.id, entryId: draft.entryId, payload: read.payload, ...(draft.when !== undefined ? { when: draft.when } : {}), referent: draft.referent });
      if (hash !== draft.payloadHash) {
        this.audit({ ...base, result: 'changed' });
        return this.answerReply('changed', language);
      }
      if (draft.when !== undefined) {
        const again = this.parseWhen(draft.when.span, draft.when.at);
        if (again === undefined || again.nextFireAt !== draft.when.nextFireAt) {
          this.audit({ ...base, result: 'changed', reason: 'when' });
          return this.answerReply('changed', language);
        }
        if (Date.parse(draft.when.nextFireAt) <= Date.parse(turn.now)) {
          this.audit({ ...base, result: 'refused', reason: 'fire-passed' });
          return this.answerReply('fire-passed', language);
        }
      }
      if (!(await this.deps.stillActing(turn.actor))) {
        this.audit({ ...base, result: 'refused', reason: 'stopped' });
        const text = renderActionStopped(language);
        return { kind: 'reply', text, body: text, replyKind: 'refusal' };
      }
      if (!this.deps.actionCaps.allows(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now))) {
        this.audit({ ...base, result: 'capped', reason: 'capped' });
        const text = renderCapped(language);
        return { kind: 'reply', text, body: text, replyKind: 'refusal' };
      }
      this.deps.actionCaps.note(turn.actor.id, 'LOCAL_WRITE', Date.parse(turn.now));
      const args: NlArgs =
        draft.entryId === 'todo.add'
          ? { title: read.payload }
          : { body: read.payload, when: (draft.when as DeicticWhen).span, whenAt: (draft.when as DeicticWhen).at };
      const command: NlSelectedCommand = { entryId: draft.entryId, args, language };
      const audit: NlActionAudit = { ...base, refKind: refKindOf(draft.referent), result: 'executed' };
      this.audit({ ...base, refKind: refKindOf(draft.referent), result: 'confirmed', referentLabel: labelOf(draft.referent), payloadOrigin: payloadOriginOf(draft.referent) });
      const value = await execute(command);
      return { kind: 'executed', value, audit, command };
    });
  }

  /** A `choose` answer: a shown label (or position) resumes into a preview; a bare unlisted number asks again. */
  private async answerChoose<T>(draft: Extract<DeicticDraft, { stage: 'choose' }>, turn: DeicticTurn, base: DeicticAuditBase, hold: SessionLockHold): Promise<DeicticAnswer<T>> {
    const unique = draft.candidates.filter((candidate, index) => draft.candidates.findIndex((other) => referentKey(other) === referentKey(candidate)) === index);
    const labels = unique.map((candidate) => labelOf(candidate) ?? 0);
    const audit: DeicticAuditBase = { ...base, refKind: 'deictic:item.local' };
    // A reminder #1 and a to-do 1 can both be offered: a bare "1" is then ambiguous (ask again) and "할 일 1" / "알림 1"
    // names its source. The source nouns are removed only for the label match; whenever the answer names a source, the
    // chosen candidate must be of that source too (Codex P2: "알림 1" never picks to-do 1), else the question is asked again.
    const named = nlNamedItemSources(turn.groundingText);
    const ofNamedSource = (candidate: DeicticReferentRef): boolean => named.size === 0 || (named.size === 1 && candidate.kind === 'item.local' && named.has(candidate.source));
    const bareText = turn.groundingText.replace(/할\s*일|알림|리마인더|to-?do|reminder/giu, ' ');
    const numbers = [...new Set(nlNumeralsIn(bareText))];
    if (numbers.length === 1 && nlOrdinalsIn(bareText).length === 0) {
      const matches = unique.map((candidate, index) => ({ candidate, index })).filter(({ index }) => labels[index] === numbers[0]);
      if (matches.length > 1) {
        const bySource = named.size === 0 ? [] : matches.filter(({ candidate }) => ofNamedSource(candidate));
        if (bySource.length !== 1) return { kind: 'reply', ...(await this.askCandidates(draft.entryId, turn, unique, draft.whenSpan, audit, hold)) };
        return { kind: 'reply', ...(await this.previewOrAskTime(draft.entryId, { ...turn, language: draft.language }, bySource[0]!.candidate, draft.whenSpan, { ...audit, refKind: refKindOf(bySource[0]!.candidate) }, hold)) };
      }
    }
    const choice = resolveLabelChoice(bareText, labels);
    if (choice.kind === 'none') return { kind: 'dropped' };
    if (choice.kind === 'cancel') {
      this.audit({ ...base, result: 'declined' });
      return this.answerReply('declined', draft.language);
    }
    if (choice.kind === 'unlisted') return { kind: 'reply', ...(await this.askCandidates(draft.entryId, turn, unique, draft.whenSpan, audit, hold)) };
    const picked = unique[choice.index];
    if (picked === undefined) return { kind: 'dropped' };
    if (!ofNamedSource(picked)) return { kind: 'reply', ...(await this.askCandidates(draft.entryId, turn, unique, draft.whenSpan, audit, hold)) };
    return { kind: 'reply', ...(await this.previewOrAskTime(draft.entryId, { ...turn, language: draft.language }, picked, draft.whenSpan, { ...audit, refKind: refKindOf(picked) }, hold)) };
  }

  /** A `time` answer: the owner's own time words (the deterministic grammar) resume into a preview. */
  private async answerTime<T>(draft: Extract<DeicticDraft, { stage: 'time' }>, turn: DeicticTurn, base: DeicticAuditBase, hold: SessionLockHold): Promise<DeicticAnswer<T>> {
    if (!containsNlTimeExpression(turn.groundingText) || nlActionInputRefusal(turn.text, turn.groundingText, turn.marked) !== undefined) return { kind: 'dropped' };
    const span = normalizeNlSpan(turn.groundingText);
    if (Array.from(span).length > NL_WHEN_MAX_CHARS) return { kind: 'dropped' };
    return { kind: 'reply', ...(await this.previewOrAskTime('reminder.create', { ...turn, language: draft.language }, draft.referent, span, { ...base, refKind: refKindOf(draft.referent) }, hold)) };
  }

  // ── lastTurn (§1.2) ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Record the turn that was just answered (owner DM only, flag not `off`): the owner's SHORT_TERM record and whether it
   * was eligible at receipt, and what kind of reply Quoky gave. A turn a deterministic handler answered (an echo, a
   * listing, a note) was a command, never a referable message. Never throws.
   */
  async recordLastTurn(input: {
    readonly session: Pick<Session, 'id'>;
    readonly actorId: Id;
    readonly message: { readonly id: string; readonly text: string; readonly attachmentCount: number; readonly quoted: boolean; readonly codeFormatted: boolean };
    readonly memoryId?: Id;
    readonly replyKind: LastTurnReplyKind;
    readonly listingSource?: 'todo' | 'reminder';
    readonly now: IsoTimestamp;
  }): Promise<void> {
    if (this.mode === 'off') return;
    const { message } = input;
    let owner: LastTurnRecord['owner'];
    if (input.memoryId === undefined) owner = { eligible: false, reason: 'unrecorded' };
    else if (input.replyKind === 'echo' || input.replyKind === 'listing' || input.replyKind === 'note') owner = { memoryId: input.memoryId, eligible: false, reason: 'command' };
    else {
      const eligibility = nlOwnerMessageEligibility({ text: message.text, attachmentCount: message.attachmentCount, quoted: message.quoted, codeFormatted: message.codeFormatted });
      owner = eligibility.eligible
        ? { memoryId: input.memoryId, eligible: true, hash: ownerMessageHash(input.actorId, input.session.id, input.memoryId, message.text) }
        : { memoryId: input.memoryId, eligible: false, reason: eligibility.reason };
    }
    const record: LastTurnRecord = {
      at: input.now,
      requestId: message.id,
      owner,
      reply: { kind: input.replyKind, ...(input.listingSource !== undefined ? { listingSource: input.listingSource } : {}), replyIds: [] },
    };
    try {
      // `updateMetadataEntry` runs under SESSION_WRITE_LOCK (ADR-0113 D7).
      await this.deps.sessions.updateMetadataEntry({ id: input.session.id }, LAST_TURN_METADATA_KEY, (current) => withLastTurn(current, input.actorId, record, input.now));
      this.awaitDelivery(input.session.id, message.id, { actorId: input.actorId, at: input.now, lastTurn: true });
    } catch (error) {
      this.deps.log('warn', 'nl_selection.session_write_failed', { key: LAST_TURN_METADATA_KEY, errorName: error instanceof Error ? error.name : typeof error });
    }
  }

  /** Bind delivered platform ids: the last turn's reply ids and a preview's `previewReplyIds`. Never throws. */
  async observeDelivery(turn: { readonly sessionId: string; readonly messageId: string; readonly status: string; readonly platformMessageIds: readonly string[] }): Promise<void> {
    const key = deliveryKey(turn.sessionId, turn.messageId);
    const pending = this.deliveries.get(key);
    if (pending === undefined) return;
    this.deliveries.delete(key);
    if (turn.status !== 'RESPONDED' || turn.platformMessageIds.length === 0) {
      // An undelivered preview must not stay approvable: clear that draft (only while it is still this one).
      if (pending.draftId !== undefined) await this.dropUndelivered(turn.sessionId, pending);
      return;
    }
    try {
      if (pending.lastTurn) {
        await this.deps.sessions.updateMetadataEntry({ id: turn.sessionId }, LAST_TURN_METADATA_KEY, (current) => withLastTurnReplies(current, pending.actorId, turn.messageId, turn.platformMessageIds, pending.at));
      }
      const draftId = pending.draftId;
      if (draftId !== undefined) {
        await this.deps.sessions.updateMetadataEntry({ id: turn.sessionId }, DEICTIC_DRAFT_METADATA_KEY, (current) => withDeicticPreviewReplies(current, pending.actorId, draftId, turn.platformMessageIds, pending.at));
      }
    } catch {
      this.deps.log('warn', 'nl_action.receipt_persist_failed', {});
    }
  }

  private async dropUndelivered(sessionId: string, pending: PendingDelivery): Promise<void> {
    try {
      await this.deps.sessions.updateMetadataEntry({ id: sessionId }, DEICTIC_DRAFT_METADATA_KEY, (current) => {
        const draft = readDeicticDraft(current, pending.actorId);
        return draft !== undefined && draft.draftId === pending.draftId ? withDeicticDraft(current, pending.actorId, undefined, pending.at) : current;
      });
    } catch {
      this.deps.log('warn', 'nl_action.receipt_persist_failed', {});
    }
  }

  private awaitDelivery(sessionId: string, messageId: string, pending: PendingDelivery): void {
    const nowMs = Date.parse(pending.at);
    for (const [key, entry] of this.deliveries) {
      const age = nowMs - Date.parse(entry.at);
      if (!Number.isFinite(age) || age >= DELIVERY_TTL_MS) this.deliveries.delete(key);
    }
    const key = deliveryKey(sessionId, messageId);
    const existing = this.deliveries.get(key);
    this.deliveries.delete(key);
    this.deliveries.set(key, {
      actorId: pending.actorId,
      at: pending.at,
      lastTurn: pending.lastTurn || existing?.lastTurn === true,
      ...((pending.draftId ?? existing?.draftId) !== undefined ? { draftId: (pending.draftId ?? existing?.draftId) as string } : {}),
    });
    while (this.deliveries.size > DELIVERIES_MAX) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }
  }

  // ── reading a referent's text (§1.3) ───────────────────────────────────────────────────────────────────────────

  /**
   * Re-read the referent by id from its own store and apply §1.3: owner text only (a conversation-made to-do; a TEXT
   * reminder with no event link; an owner message of this session whose hash still matches), 1–200 code points, one
   * line, no invisible / bidi / control character (checked BEFORE normalisation), no credential, not only deictic words.
   * The payload is the domain-normalised text: what the preview shows is exactly what would be stored.
   */
  private async readPayload(entryId: DeicticEntryId, turn: DeicticTurn, referent: DeicticReferentRef, options: { readonly forDisplay?: boolean } = {}): Promise<PayloadRead> {
    let raw: string;
    let origin: DeicticOriginLine;
    if (referent.kind === 'owner.message') {
      const record = await this.deps.texts.ownerMessage(referent.memoryId);
      if (record === null || record.sessionId !== turn.session.id || record.role !== 'user') return { ok: false, reason: 'gone' };
      if (ownerMessageHash(turn.actor.id, turn.session.id, referent.memoryId, record.content) !== referent.hash) return { ok: false, reason: 'gone' };
      raw = record.content;
      origin = { kind: 'owner.message', clock: this.clockOf(referent.at) };
    } else if (referent.source === 'todo') {
      const item = await this.deps.texts.todo(turn.actor.id, referent.itemId);
      if (item === null || item.title === undefined) return { ok: false, reason: 'gone' };
      // Decision 2: only a to-do made from the owner's words; a future non-owner creator needs an origin marker first.
      if (item.origin !== 'conversation') return { ok: false, reason: 'ineligible' };
      raw = item.title;
      origin = { kind: 'todo', ...(referent.label !== undefined ? { label: referent.label } : {}) };
    } else {
      if (referent.label === undefined) return { ok: false, reason: 'gone' };
      const reminder = await this.deps.texts.reminder(turn.actor.id, referent.label);
      if (reminder === null || reminder.id !== referent.itemId) return { ok: false, reason: 'gone' };
      // Decision 2: a BRIEF reminder has no owner body; an event-linked one may hold the event title (whether or not).
      if (reminder.kind !== 'TEXT' || reminder.eventLinked) return { ok: false, reason: 'ineligible' };
      raw = reminder.body;
      origin = { kind: 'reminder', label: referent.label };
    }
    if (nlHasInvisibleCharacters(raw) || containsCredentialMaterial(raw)) return { ok: false, reason: 'ineligible' };
    if (Array.from(raw.trim()).length > NL_SPAN_MAX_CHARS) return { ok: false, reason: 'too-long' };
    let payload: string;
    if (entryId === 'todo.add') {
      try {
        payload = normalizeWorkItemTitle(raw);
      } catch {
        return { ok: false, reason: 'ineligible' };
      }
    } else {
      payload = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
    }
    if (payload.length === 0 || isNlDeicticOnlyPayload(payload)) return { ok: false, reason: 'ineligible' };
    // A6-D1: a to-do carries no time; the owner is asked to choose (as for a typed title).
    if (entryId === 'todo.add' && options.forDisplay !== true && containsNlTimeExpression(payload)) return { ok: false, reason: 'time-in-title' };
    return { ok: true, payload, origin, raw };
  }

  private parseWhen(span: string, at: IsoTimestamp): DeicticWhen | undefined {
    const parsed = parseReminderWhen(span, { now: at, timeZone: this.deps.timeZone, eventRelative: false });
    if (parsed.kind !== 'time') return undefined;
    return { span, at, nextFireAt: parsed.firstFireAt };
  }

  private whenLabel(when: DeicticWhen, now: IsoTimestamp): string | undefined {
    const parsed = parseReminderWhen(when.span, { now: when.at, timeZone: this.deps.timeZone, eventRelative: false });
    return parsed.kind === 'time' ? reminderWhenPreviewLabel(parsed.schedule, parsed.firstFireAt, parsed.timeZone, now) : undefined;
  }

  private clockOf(at: IsoTimestamp): string {
    try {
      const zoned = toZonedDateTime(at, this.deps.timeZone);
      return `${String(zoned.hour).padStart(2, '0')}:${String(zoned.minute).padStart(2, '0')}`;
    } catch {
      return '--:--';
    }
  }

  private async saveDraft(turn: DeicticTurn, draft: DeicticDraft, held?: SessionLockHold): Promise<void> {
    await this.deps.sessions.updateMetadataEntry({ id: turn.session.id }, DEICTIC_DRAFT_METADATA_KEY, (current) => withDeicticDraft(current, turn.actor.id, draft, turn.now), held !== undefined ? { held } : {});
  }

  // ── replies and audit ──────────────────────────────────────────────────────────────────────────────────────────

  private payloadRefusal(reason: DeicticRefusalCopy | 'time-in-title', entryId: DeicticEntryId, turn: DeicticTurn, audit: DeicticAuditBase): DeicticReply {
    const text = reason === 'time-in-title' ? renderTimeInTitle(turn.language) : renderDeicticRefusal(reason, entryId, turn.language);
    return this.refusalReply({ ...audit, result: reason === 'time-in-title' ? 'asked' : 'refused', reason }, text);
  }

  private refusalReply(audit: NlActionAudit, text: string): DeicticReply {
    this.audit(audit);
    return { text, body: text, replyKind: 'refusal' };
  }

  private answerReply<T>(copy: DeicticAnswerCopy, language: 'ko' | 'en'): DeicticAnswer<T> {
    const text = renderDeicticAnswer(copy, language);
    return { kind: 'reply', text, body: text, replyKind: 'refusal' };
  }

  private baseAudit(entryId: DeicticEntryId, turn: DeicticTurn, resolution: DeicticResolution, latencyMs: number): DeicticAuditBase {
    return {
      entryId,
      risk: 'LOCAL_WRITE',
      refKind: resolution.kind === 'resolved' ? refKindOf(resolution.referent) : 'deictic:none',
      resolution: resolution.kind === 'resolved' ? 'resolved' : resolution.kind === 'ask' ? 'ambiguous' : 'none',
      latencyMs,
      ...correlation(turn),
    };
  }

  private audit(audit: NlActionAudit): void {
    this.deps.log('info', NL_ACTION_LOG_EVENT, nlActionLogFields(audit));
  }
}

type DeicticAuditBase = Omit<NlActionAudit, 'result'>;

function correlation(turn: Pick<DeicticTurn, 'session' | 'turnId'>): { readonly sessionId: string; readonly turnId?: string } {
  return { sessionId: turn.session.id, ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}) };
}

function refKindOf(referent: DeicticReferentRef): NlDeicticRefKind {
  return referent.kind === 'item.local' ? 'deictic:item.local' : 'deictic:owner.message';
}

function labelOf(referent: DeicticReferentRef): number | undefined {
  return referent.kind === 'item.local' ? referent.label : undefined;
}

function payloadOriginOf(referent: DeicticReferentRef): 'owner-item' | 'owner-message' {
  return referent.kind === 'item.local' ? 'owner-item' : 'owner-message';
}

function deliveryKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId, messageId]);
}

/** The selector's `when` for a deictic reminder: a time expression in the owner's own words, else none (ask). */
function groundedWhen(value: unknown, groundingText: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const span = normalizeNlSpan(value).replace(/(?<=\S)\s*에$/u, '');
  if (span.length === 0 || Array.from(span).length > NL_WHEN_MAX_CHARS) return undefined;
  if (!isNlSpanGrounded(span, groundingText) || !containsNlTimeExpression(span)) return undefined;
  // A6-D1: no other time word outside `when` (the referenced text's own time is never read: it is not in these words).
  if (containsNlTimeExpression(withoutSpan(withoutNlOriginPhrases(groundingText), span))) return undefined;
  return span;
}
