import {
  InvalidReminderError,
  REMINDER_LIMITS,
  ReminderStatus,
  createReminderDraft,
  reactivateReminder,
  type Reminder,
  type ReminderSchedule,
  type ConversationContext,
  type Id,
  type IsoTimestamp,
  type MessageBody,
  type OutboundMessage,
} from '../../domain';
import type { CalendarReader } from '../../ports/calendar-reader.port';
import { outboundMessage } from '../message-rendering';
import { EventReminderCalendar, resolveEventReminderTarget } from './event-reminder-calendar';
import type { EventReminderTarget } from './event-reminder-grammar';
import type { Logger } from '../../ports/logger.port';
import type { ReminderRepository } from '../../ports/reminder-repository.port';
import { newId } from '../../util/id';
import { containsCredentialMaterial } from '../credential-guard';
import { parseReminderMessage, parseReminderWhen, type ReminderClarifyReason, type ReminderCommand } from './reminder-grammar';
import { nextOccurrenceAfter } from './reminder-schedule';
import type { NlActionReceipt, NlListingReceipt, NlSelectedCommand } from '../nl-routing/catalog';
import { eventReminderStoredTitle, type ReminderReplyComposer } from './reminder-reply-composer';

/**
 * Owner reminder conversation (ADR-0101 D5): create, list and cancel through the deterministic grammar. Pure Core
 * over ports: the repository, the reply composer and a logger. No Task, provider, tool, connector, memory writer
 * or runtime re-entry — a reminder turn ends in one deterministic reply (or `null` when the message is not about
 * reminders, so the runtime continues normally).
 */

export interface ReminderConversationDeps {
  readonly repository: ReminderRepository;
  readonly composer: ReminderReplyComposer;
  /** The owner's IANA zone (`QUOKY_TIMEZONE`). */
  readonly timeZone: string;
  /** `QUOKY_REMINDERS_ENABLED`; when false every recognized phrase gets the fixed disabled reply. */
  readonly enabled: boolean;
  readonly logger: Logger;
  /** Reminder id source; defaults to the shared `newId`. */
  readonly idGenerator?: () => Id;
  /**
   * ADR-0117 D5 (BRF-2): the configured read-only calendar, to resolve the event an event-relative reminder names.
   * Absent: no calendar is configured and such a request gets the fixed "not connected" reply.
   */
  readonly calendar?: Pick<CalendarReader, 'listEvents'>;
  /** Injectable for tests; production uses the schedule handler's read bound. */
  readonly calendarTimeoutMs?: number;
  /**
   * ADR-0120 amendment A6: attach content-free action and listing receipts to reminder replies (`QUOKY_NL_ACTIONS` not
   * `off`). False (the default): every reply and write is exactly as before A6.
   */
  readonly actionReceipts?: boolean;
}

/** A reminder turn's reply plus the A6 receipts (present only with `actionReceipts`). */
export interface ReminderTurnResult {
  readonly reply: OutboundMessage;
  readonly action?: NlActionReceipt;
  readonly listing?: NlListingReceipt;
}

/** What one executed reminder command produced: the body, and the reminder written or listed (for receipts). */
interface Executed {
  readonly body: MessageBody;
  readonly action?: NlActionReceipt;
  readonly listing?: NlListingReceipt;
}

export interface ReminderTurnInput {
  readonly text: string;
  readonly context: ConversationContext;
  /** The canonical owner Actor.id. */
  readonly actorId: Id;
  /** The inbound message id; the reply is addressed to it. */
  readonly messageId: Id;
  readonly now: IsoTimestamp;
}

/** OPS-2 (ADR-0113 D7): the typed cancel entry's input — the owner Actor, the `알림 N` number and the shared clock. */
export interface ReminderCancelInput {
  /** The canonical owner Actor.id. */
  readonly actorId: Id;
  readonly displayNo: number;
  readonly now: IsoTimestamp;
}

/**
 * The typed cancel outcome: the repository's result (`CANCELED`, `NOT_FOUND`, `ALREADY_FINAL`, `IN_FLIGHT`), or
 * `DISABLED` (`QUOKY_REMINDERS_ENABLED=false`) / `FAILED` (a storage failure). `reply` is exactly the text the chat
 * `알림 N 취소` turn answers with for that outcome.
 */
export type ReminderCancelStatus = 'CANCELED' | 'NOT_FOUND' | 'ALREADY_FINAL' | 'IN_FLIGHT' | 'DISABLED' | 'FAILED';

export interface ReminderCancelResult {
  readonly status: ReminderCancelStatus;
  readonly displayNo: number;
  readonly reply: string;
}

export class ReminderConversationService {
  private readonly newReminderId: () => Id;
  private readonly eventCalendar: EventReminderCalendar | undefined;

  constructor(private readonly deps: ReminderConversationDeps) {
    this.newReminderId = deps.idGenerator ?? newId;
    this.eventCalendar =
      deps.calendar === undefined
        ? undefined
        : new EventReminderCalendar({
            reader: deps.calendar,
            logger: deps.logger,
            ...(deps.calendarTimeoutMs !== undefined ? { createTimeoutMs: deps.calendarTimeoutMs } : {}),
          });
  }

  /** The reply for a reminder phrase, or `null` for any other message. Never throws. */
  async handleTurn(input: ReminderTurnInput): Promise<OutboundMessage | null> {
    return (await this.handleTurnDetailed(input))?.reply ?? null;
  }

  /**
   * {@link handleTurn} plus the A6 receipts (ADR-0120 amendment A6-D2: an anchored create or cancel records
   * `lastAction`, a list records the reminder listing). The reply is byte-identical to `handleTurn`'s. Never throws.
   */
  async handleTurnDetailed(input: ReminderTurnInput): Promise<ReminderTurnResult | null> {
    let command: ReminderCommand;
    try {
      command = parseReminderMessage(input.text, { now: input.now, timeZone: this.deps.timeZone });
    } catch {
      this.deps.logger.warn('reminder.grammar.failed');
      return null;
    }
    if (command.kind === 'NOT_REMINDER') return null;
    if (!this.deps.enabled) return { reply: this.reply(input, this.deps.composer.disabled()) };

    try {
      const executed = await this.execute(command, input);
      const receipts = this.deps.actionReceipts === true;
      return {
        reply: this.reply(input, executed.body),
        ...(receipts && executed.action !== undefined ? { action: executed.action } : {}),
        ...(receipts && executed.listing !== undefined ? { listing: executed.listing } : {}),
      };
    } catch (error) {
      // Log the failure class only: never the body, the message text or the repository's own message.
      this.deps.logger.error('reminder.conversation.failed', {
        operation: command.kind,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return { reply: this.reply(input, this.deps.composer.storageFailure()) };
    }
  }

  private async execute(command: Exclude<ReminderCommand, { kind: 'NOT_REMINDER' }>, input: ReminderTurnInput): Promise<Executed> {
    const { composer, repository } = this.deps;
    switch (command.kind) {
      case 'CLARIFY':
        return { body: composer.clarify(command.reason) };
      case 'LIST': {
        const active = await repository.listActiveByActor(input.actorId);
        const rendered = composer.listRendered(active, input.now);
        return { body: rendered.body, ...listingOf(active.slice(0, rendered.shown)) };
      }
      case 'CANCEL': {
        // OPS-2: chat goes through the same typed entry as the operations UI (replies byte-identical).
        const canceled = await this.cancelDetailed({ actorId: input.actorId, displayNo: command.displayNo, now: input.now });
        return { body: canceled.result.reply, ...(canceled.reminder !== undefined ? { action: receiptOf('reminder.cancel', canceled.reminder) } : {}) };
      }
      case 'CREATE': {
        if (containsCredentialMaterial(command.body)) return { body: composer.credentialRefused() };
        let draft;
        try {
          draft = createReminderDraft({
            id: this.newReminderId(),
            actorId: input.actorId,
            kind: command.bodyKind,
            body: command.body,
            schedule: command.schedule,
            timeZone: command.timeZone,
            origin: input.context,
            firstFireAt: command.firstFireAt,
            createdAt: input.now,
          });
        } catch (error) {
          if (error instanceof InvalidReminderError) return { body: composer.clarify(this.clarifyReasonOf(error)) };
          throw error;
        }
        const created = await repository.createWithinLimit(draft, REMINDER_LIMITS.maxActivePerActor);
        return created.status === 'CREATED'
          ? { body: composer.created(created.reminder, input.now), action: receiptOf('reminder.create', created.reminder) }
          : { body: composer.limitReached(created.activeCount) };
      }
      case 'CREATE_EVENT_RELATIVE': {
        const event = await this.createEventRelativeDetailed(command.offsetMinutes, command.target, input);
        return { body: event.body, ...(event.reminder !== undefined ? { action: receiptOf('reminder.create', event.reminder) } : {}) };
      }
    }
  }

  /**
   * ADR-0117 D5: one reminder before ONE calendar event, resolved now through the read-only calendar. Nothing is
   * created when the event is ambiguous, missing, all-day or too soon, or when the calendar cannot be read.
   */
  private async createEventRelativeDetailed(
    offsetMinutes: number,
    target: EventReminderTarget,
    input: ReminderTurnInput,
    ownerBody?: string,
  ): Promise<{ readonly body: MessageBody; readonly reminder?: Reminder }> {
    const body = await this.createEventRelative(offsetMinutes, target, input, ownerBody);
    return typeof body === 'object' && body !== null && 'reminder' in body ? (body as { body: MessageBody; reminder: Reminder }) : { body: body as MessageBody };
  }

  private async createEventRelative(
    offsetMinutes: number,
    target: EventReminderTarget,
    input: ReminderTurnInput,
    ownerBody?: string,
  ): Promise<MessageBody | { readonly body: MessageBody; readonly reminder: Reminder }> {
    const { composer, repository } = this.deps;
    if (this.eventCalendar === undefined) return composer.eventCalendarUnavailable();
    const read = await this.eventCalendar.readForCreation(target, input.now, this.deps.timeZone);
    if (read === null) return composer.eventCalendarReadFailed();
    const resolution = resolveEventReminderTarget(read.events, target, {
      now: input.now,
      timeZone: this.deps.timeZone,
      offsetMinutes,
      partial: read.partial,
    });
    this.deps.logger.info('reminder.event.resolved', { outcome: resolution.kind, events: read.events.length });
    switch (resolution.kind) {
      case 'none':
        return composer.eventNotFound(target, resolution.partial);
      case 'all-day':
        return composer.eventAllDay(resolution.event);
      case 'ambiguous':
        return composer.eventAmbiguous(resolution.candidates, input.now, this.deps.timeZone);
      case 'too-soon':
        return composer.eventTooSoon(resolution.event, offsetMinutes, input.now, this.deps.timeZone);
      case 'found':
        break;
    }
    let draft;
    try {
      draft = createReminderDraft({
        id: this.newReminderId(),
        actorId: input.actorId,
        kind: 'TEXT',
        // The event's title, single-line, bounded and credential-guarded (a credential-shaped title is never stored).
        // ADR-0120 A6 (CA review P2): a natural-language request stores the owner's own words when it has them; the
        // anchored BRF-2 grammar never passes `ownerBody`, so its behaviour is unchanged.
        body: ownerBody !== undefined && ownerBody.trim().length > 0 ? ownerBody : eventReminderStoredTitle(resolution.event.title),
        schedule: { type: 'ONCE', at: resolution.fireAt },
        timeZone: this.deps.timeZone,
        origin: input.context,
        firstFireAt: resolution.fireAt,
        createdAt: input.now,
        // The calendar identity is stored with the id, so the re-check never takes another calendar's event for it.
        event: { eventId: resolution.event.id, offsetMinutes, calendarName: resolution.event.calendarName },
      });
    } catch (error) {
      // An event id outside the stored bound cannot be referenced: refused as unreadable, never truncated.
      if (error instanceof InvalidReminderError) return composer.eventCalendarReadFailed();
      throw error;
    }
    const created = await repository.createWithinLimit(draft, REMINDER_LIMITS.maxActivePerActor);
    return created.status === 'CREATED'
      ? { body: composer.eventCreated(created.reminder, new Date(resolution.startMs).toISOString(), input.now), reminder: created.reminder }
      : composer.limitReached(created.activeCount);
  }

  /**
   * OPS-2 (ADR-0113 D7): the typed cancel entry that both the chat `CANCEL` path and the operations UI call — the
   * same repository call and the same composer outcomes. Never throws: a storage failure is logged by class only (as
   * {@link handleTurn} does) and answered with the storage-failure copy.
   */
  async cancelByDisplayNo(input: ReminderCancelInput): Promise<ReminderCancelResult> {
    return (await this.cancelDetailed(input)).result;
  }

  /** {@link cancelByDisplayNo} plus the canceled reminder (A6 receipts). Same replies. Never throws. */
  private async cancelDetailed(input: ReminderCancelInput): Promise<{ readonly result: ReminderCancelResult; readonly reminder?: Reminder }> {
    const { composer, repository } = this.deps;
    const { displayNo } = input;
    if (!this.deps.enabled) return { result: { status: 'DISABLED', displayNo, reply: composer.disabled() } };
    try {
      const result = await repository.cancel(input.actorId, displayNo, input.now);
      switch (result.status) {
        case 'CANCELED':
          return { result: { status: 'CANCELED', displayNo, reply: composer.canceled(result.reminder) }, reminder: result.reminder };
        case 'NOT_FOUND':
          return { result: { status: 'NOT_FOUND', displayNo, reply: composer.cancelNotFound(displayNo) } };
        case 'ALREADY_FINAL':
          return { result: { status: 'ALREADY_FINAL', displayNo, reply: composer.cancelAlreadyFinal(result.reminder) } };
        case 'IN_FLIGHT':
          return { result: { status: 'IN_FLIGHT', displayNo, reply: composer.cancelInFlight(displayNo) } };
      }
    } catch (error) {
      this.deps.logger.error('reminder.conversation.failed', {
        operation: 'CANCEL',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return { result: { status: 'FAILED', displayNo, reply: composer.storageFailure() } };
    }
  }

  /** Whether the event an event-relative reminder names is still there at the start it was scheduled for. */
  private async recheckEvent(reminder: Reminder, now: string): Promise<'same' | 'event-gone' | 'event-moved' | 'event-unreadable'> {
    const ref = reminder.event;
    if (ref === undefined || reminder.schedule.type !== 'ONCE') return 'event-unreadable';
    if (this.eventCalendar === undefined) return 'event-unreadable';
    const expectedStart = new Date(Date.parse(reminder.schedule.at) + ref.offsetMinutes * 60_000).toISOString();
    const verdict = await this.eventCalendar.recheck(ref, expectedStart, now);
    if (verdict.kind === 'gone') return 'event-gone';
    if (verdict.kind === 'unreadable') return 'event-unreadable';
    if (verdict.event.allDay) return 'event-gone';
    return Date.parse(verdict.event.start) === Date.parse(expectedStart) ? 'same' : 'event-moved';
  }

  // -- ADR-0120 amendment A6: natural-language reminder actions ---------------------------------------------------

  /**
   * One validated reminder action (`reminder.create`, `reminder.cancel`, or `action.undo` of a reminder action), its
   * target resolved by Core. Time parsing stays deterministic (`parseReminderWhen`); the target is re-read and checked at
   * execution. Never throws.
   */
  async handleAction(command: NlSelectedCommand, input: Omit<ReminderTurnInput, 'text'>): Promise<ReminderTurnResult> {
    const turn: ReminderTurnInput = { ...input, text: '' };
    if (!this.deps.enabled) return { reply: this.reply(turn, this.deps.composer.disabled()), action: refusedReceipt(command, 'disabled') };
    try {
      switch (command.entryId) {
        case 'reminder.create':
          return await this.actionCreate(command, turn);
        case 'reminder.cancel':
          return await this.actionCancel(command, turn);
        case 'action.undo':
          return await this.actionUndo(command, turn);
        default:
          return { reply: this.reply(turn, this.deps.composer.storageFailure()), action: refusedReceipt(command, 'unsupported') };
      }
    } catch (error) {
      this.deps.logger.error('reminder.conversation.failed', { operation: `A6:${command.entryId}`, errorName: error instanceof Error ? error.name : 'unknown' });
      return { reply: this.reply(turn, this.deps.composer.storageFailure()), action: refusedReceipt(command, 'failed') };
    }
  }

  private async actionCreate(command: NlSelectedCommand, input: ReminderTurnInput): Promise<ReminderTurnResult> {
    const { composer, repository } = this.deps;
    const body = typeof command.args.body === 'string' ? command.args.body : '';
    const whenText = typeof command.args.when === 'string' ? command.args.when : '';
    const refuse = (text: MessageBody, reason: string): ReminderTurnResult => ({ reply: this.reply(input, text), action: refusedReceipt(command, reason) });
    if (containsCredentialMaterial(body)) return refuse(composer.credentialRefused(), 'credential');
    const when = parseReminderWhen(whenText, { now: input.now, timeZone: this.deps.timeZone });
    if (when.kind === 'clarify') return refuse(composer.clarify(when.reason), 'when-unparsed');
    if (when.kind === 'event') {
      // BRF-2 resolves the event; the reminder keeps the owner's own words (the event title only when they are empty).
      const event = await this.createEventRelativeDetailed(when.offsetMinutes, when.target, input, body);
      if (event.reminder === undefined) return { reply: this.reply(input, event.body), action: refusedReceipt(command, 'event') };
      return { reply: this.reply(input, event.body), action: { ...receiptOf('reminder.create', event.reminder), result: 'executed' } };
    }
    let draft;
    try {
      draft = createReminderDraft({
        id: this.newReminderId(),
        actorId: input.actorId,
        kind: 'TEXT',
        body,
        schedule: when.schedule,
        timeZone: when.timeZone,
        origin: input.context,
        firstFireAt: when.firstFireAt,
        createdAt: input.now,
      });
    } catch (error) {
      if (error instanceof InvalidReminderError) return refuse(composer.clarify(this.clarifyReasonOf(error)), 'invalid');
      throw error;
    }
    const created = await repository.createWithinLimit(draft, REMINDER_LIMITS.maxActivePerActor);
    if (created.status !== 'CREATED') return refuse(composer.limitReached(created.activeCount), 'limit');
    return { reply: this.reply(input, composer.actionCreated(created.reminder, input.now)), action: receiptOf('reminder.create', created.reminder) };
  }

  /** The target by its stable display number, checked against the resolved id (A6-D2 step 5). */
  private async targetReminder(command: NlSelectedCommand, actorId: string): Promise<Reminder | null> {
    const label = command.target?.label;
    if (command.target?.source !== 'reminder' || label === undefined) return null;
    const reminder = await this.deps.repository.getByDisplayNo(actorId, label);
    if (reminder === null) return null;
    return command.target.id === undefined || command.target.id === reminder.id ? reminder : null;
  }

  private async actionCancel(command: NlSelectedCommand, input: ReminderTurnInput): Promise<ReminderTurnResult> {
    const reminder = await this.targetReminder(command, input.actorId);
    const displayNo = command.target?.label ?? 0;
    if (reminder === null) return { reply: this.reply(input, this.deps.composer.cancelNotFound(displayNo)), action: refusedReceipt(command, 'not-found') };
    const canceled = await this.cancelDetailed({ actorId: input.actorId, displayNo: reminder.displayNo, now: input.now });
    if (canceled.reminder === undefined) return { reply: this.reply(input, canceled.result.reply), action: refusedReceipt(command, canceled.result.status.toLowerCase()) };
    return { reply: this.reply(input, this.deps.composer.actionCanceled(canceled.reminder)), action: receiptOf('reminder.cancel', canceled.reminder) };
  }

  /** Record A: the per-action inverse of a reminder action. */
  private async actionUndo(command: NlSelectedCommand, input: ReminderTurnInput): Promise<ReminderTurnResult> {
    const { composer, repository } = this.deps;
    const refuse = (reason: Parameters<ReminderReplyComposer['undoRefused']>[0]): ReminderTurnResult => ({
      reply: this.reply(input, composer.undoRefused(reason)),
      action: { entryId: 'action.undo', result: 'refused', source: 'reminder', reason },
    });
    const reminder = await this.targetReminder(command, input.actorId);
    if (reminder === null) return refuse('not-found');
    const undone = command.undo?.entryId;
    if (undone === 'reminder.create') {
      if (reminder.status === ReminderStatus.FIRING) return refuse('in-flight');
      if (reminder.status !== ReminderStatus.SCHEDULED) return refuse(reminder.status === ReminderStatus.CANCELED ? 'changed' : 'fired');
      const canceled = await this.cancelDetailed({ actorId: input.actorId, displayNo: reminder.displayNo, now: input.now });
      if (canceled.reminder === undefined) return { reply: this.reply(input, canceled.result.reply), action: { entryId: 'action.undo', result: 'refused', source: 'reminder', reason: 'changed' } };
      return {
        reply: this.reply(input, composer.canceled(canceled.reminder)),
        action: { ...receiptOf('action.undo', canceled.reminder), result: 'undone', undoOf: 'reminder.create', undoable: false },
      };
    }
    if (undone !== 'reminder.cancel') return refuse('not-found');
    if (reminder.status !== ReminderStatus.CANCELED) return refuse('changed');
    // The version recorded at the cancel (kept in lastAction, and in the reschedule question) must still be the stored
    // one: the repository compares and sets against it, so a change in between is never overwritten.
    const expected = command.undo?.version;
    if (expected === undefined || expected !== reminder.updatedAt) return refuse('changed');
    let nextFireAt: string | null;
    let schedule: ReminderSchedule | undefined;
    const newTime = typeof command.args.when === 'string' ? command.args.when : undefined;
    if (newTime !== undefined) {
      const when = parseReminderWhen(newTime, { now: input.now, timeZone: this.deps.timeZone, eventRelative: false });
      if (when.kind !== 'time') return { reply: this.reply(input, when.kind === 'clarify' ? composer.clarify(when.reason) : composer.undoRefused('schedule')), action: { entryId: 'action.undo', result: 'refused', source: 'reminder', reason: 'when-unparsed' } };
      if (when.schedule.type !== reminder.schedule.type || reminder.event !== undefined) return refuse('schedule');
      schedule = when.schedule;
      nextFireAt = when.firstFireAt;
    } else if (reminder.schedule.type === 'ONCE') {
      const at = Date.parse(reminder.schedule.at);
      const future = Number.isFinite(at) && at - Date.parse(input.now) >= REMINDER_LIMITS.minLeadMs;
      if (!future) {
        if (reminder.event !== undefined) return refuse('event-gone');
        return {
          reply: this.reply(input, composer.undoAskTime(reminder.displayNo)),
          action: { entryId: 'action.undo', result: 'reschedule', source: 'reminder', itemId: reminder.id, label: reminder.displayNo, version: reminder.updatedAt, reason: 'past-time' },
        };
      }
      // ADR-0117 D6 / CA review P2: an event-relative reminder comes back only if its event is still there, at the same
      // start; a moved, deleted, cancelled or unreadable event is said plainly and nothing is reactivated.
      if (reminder.event !== undefined) {
        const verdict = await this.recheckEvent(reminder, input.now);
        if (verdict !== 'same') return refuse(verdict);
      }
      nextFireAt = new Date(at).toISOString();
    } else {
      // A recurring reminder resumes from its next occurrence after now; missed occurrences are never sent.
      nextFireAt = nextOccurrenceAfter(reminder.schedule, reminder.timeZone, input.now);
    }
    if (nextFireAt === null) return refuse('changed');
    let next: Reminder;
    try {
      next = reactivateReminder(reminder, input.now, nextFireAt, schedule);
    } catch {
      return refuse('changed');
    }
    const result = await repository.reactivate(input.actorId, next, expected, REMINDER_LIMITS.maxActivePerActor);
    switch (result.status) {
      case 'REACTIVATED':
        return {
          reply: this.reply(input, composer.actionReactivated(result.reminder, input.now)),
          action: { ...receiptOf('action.undo', result.reminder), result: 'undone', undoOf: 'reminder.cancel', undoable: false },
        };
      case 'LIMIT_REACHED':
        return { reply: this.reply(input, composer.limitReached(result.activeCount)), action: { entryId: 'action.undo', result: 'refused', source: 'reminder', reason: 'limit' } };
      case 'NOT_FOUND':
        return refuse('not-found');
      case 'CHANGED':
        return refuse('changed');
    }
  }

  private clarifyReasonOf(error: InvalidReminderError): ReminderClarifyReason {
    switch (error.code) {
      case 'BODY_EMPTY':
        return 'EMPTY_BODY';
      case 'BODY_TOO_LONG':
        return 'BODY_TOO_LONG';
      default:
        return 'MISSING_TIME';
    }
  }

  /**
   * The reminder list as a typed entry (ADR-0120: a `reminder.list` selection maps to the existing LIST, ADR-0101 D2
   * amended narrowly). Same copy as "알림 목록"; the disabled copy while reminders are off. Never throws.
   */
  async listReply(input: Omit<ReminderTurnInput, 'text'>): Promise<OutboundMessage> {
    return (await this.listReplyDetailed(input)).reply;
  }

  /**
   * {@link listReply} plus the A6 listing receipt (only with `actionReceipts`): the reminders exactly as rendered, so a
   * selector-chosen list refreshes the reminder slot like "알림 목록" does (CA review P1). Never throws.
   */
  async listReplyDetailed(input: Omit<ReminderTurnInput, 'text'>): Promise<ReminderTurnResult> {
    const turn: ReminderTurnInput = { ...input, text: '' };
    if (!this.deps.enabled) return { reply: this.reply(turn, this.deps.composer.disabled()) };
    try {
      const active = await this.deps.repository.listActiveByActor(input.actorId);
      const rendered = this.deps.composer.listRendered(active, input.now);
      const listing = this.deps.actionReceipts === true ? listingOf(active.slice(0, rendered.shown)).listing : undefined;
      return { reply: this.reply(turn, rendered.body), ...(listing !== undefined ? { listing } : {}) };
    } catch (error) {
      this.deps.logger.error('reminder.conversation.failed', {
        operation: 'LIST',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return { reply: this.reply(turn, this.deps.composer.storageFailure()) };
    }
  }

  private reply(input: ReminderTurnInput, body: MessageBody): OutboundMessage {
    return outboundMessage(input.context, body, { replyToMessageId: input.messageId });
  }
}

/** A6: the content-free receipt of a reminder write (its id, `#N` and version). */
function receiptOf(entryId: 'reminder.create' | 'reminder.cancel' | 'action.undo', reminder: Reminder): NlActionReceipt {
  return { entryId, result: 'executed', source: 'reminder', itemId: reminder.id, label: reminder.displayNo, version: reminder.updatedAt, undoable: true };
}

function refusedReceipt(command: NlSelectedCommand, reason: string): NlActionReceipt {
  const entryId = command.entryId === 'reminder.create' || command.entryId === 'reminder.cancel' || command.entryId === 'action.undo' ? command.entryId : 'reminder.cancel';
  return { entryId, result: 'refused', source: 'reminder', reason };
}

/** A6-D2: the reminder listing exactly as shown (display numbers in list order; an empty list clears the slot). */
function listingOf(shown: readonly Reminder[]): { readonly listing: NlListingReceipt } {
  return { listing: { source: 'reminder', items: shown.slice(0, 50).map((reminder) => ({ label: reminder.displayNo, id: reminder.id })) } };
}
