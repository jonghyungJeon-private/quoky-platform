import {
  InvalidReminderError,
  REMINDER_LIMITS,
  createReminderDraft,
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
import { parseReminderMessage, type ReminderClarifyReason, type ReminderCommand } from './reminder-grammar';
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
    let command: ReminderCommand;
    try {
      command = parseReminderMessage(input.text, { now: input.now, timeZone: this.deps.timeZone });
    } catch {
      this.deps.logger.warn('reminder.grammar.failed');
      return null;
    }
    if (command.kind === 'NOT_REMINDER') return null;
    if (!this.deps.enabled) return this.reply(input, this.deps.composer.disabled());

    try {
      return this.reply(input, await this.execute(command, input));
    } catch (error) {
      // Log the failure class only: never the body, the message text or the repository's own message.
      this.deps.logger.error('reminder.conversation.failed', {
        operation: command.kind,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return this.reply(input, this.deps.composer.storageFailure());
    }
  }

  private async execute(command: Exclude<ReminderCommand, { kind: 'NOT_REMINDER' }>, input: ReminderTurnInput): Promise<MessageBody> {
    const { composer, repository } = this.deps;
    switch (command.kind) {
      case 'CLARIFY':
        return composer.clarify(command.reason);
      case 'LIST':
        return composer.list(await repository.listActiveByActor(input.actorId), input.now);
      case 'CANCEL':
        // OPS-2: chat goes through the same typed entry as the operations UI (replies byte-identical).
        return (await this.cancelByDisplayNo({ actorId: input.actorId, displayNo: command.displayNo, now: input.now })).reply;
      case 'CREATE': {
        if (containsCredentialMaterial(command.body)) return composer.credentialRefused();
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
          if (error instanceof InvalidReminderError) return composer.clarify(this.clarifyReasonOf(error));
          throw error;
        }
        const created = await repository.createWithinLimit(draft, REMINDER_LIMITS.maxActivePerActor);
        return created.status === 'CREATED'
          ? composer.created(created.reminder, input.now)
          : composer.limitReached(created.activeCount);
      }
      case 'CREATE_EVENT_RELATIVE':
        return this.createEventRelative(command.offsetMinutes, command.target, input);
    }
  }

  /**
   * ADR-0117 D5: one reminder before ONE calendar event, resolved now through the read-only calendar. Nothing is
   * created when the event is ambiguous, missing, all-day or too soon, or when the calendar cannot be read.
   */
  private async createEventRelative(
    offsetMinutes: number,
    target: EventReminderTarget,
    input: ReminderTurnInput,
  ): Promise<MessageBody> {
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
        body: eventReminderStoredTitle(resolution.event.title),
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
      ? composer.eventCreated(created.reminder, new Date(resolution.startMs).toISOString(), input.now)
      : composer.limitReached(created.activeCount);
  }

  /**
   * OPS-2 (ADR-0113 D7): the typed cancel entry that both the chat `CANCEL` path and the operations UI call — the
   * same repository call and the same composer outcomes. Never throws: a storage failure is logged by class only (as
   * {@link handleTurn} does) and answered with the storage-failure copy.
   */
  async cancelByDisplayNo(input: ReminderCancelInput): Promise<ReminderCancelResult> {
    const { composer, repository } = this.deps;
    const { displayNo } = input;
    if (!this.deps.enabled) return { status: 'DISABLED', displayNo, reply: composer.disabled() };
    try {
      const result = await repository.cancel(input.actorId, displayNo, input.now);
      switch (result.status) {
        case 'CANCELED':
          return { status: 'CANCELED', displayNo, reply: composer.canceled(result.reminder) };
        case 'NOT_FOUND':
          return { status: 'NOT_FOUND', displayNo, reply: composer.cancelNotFound(displayNo) };
        case 'ALREADY_FINAL':
          return { status: 'ALREADY_FINAL', displayNo, reply: composer.cancelAlreadyFinal(result.reminder) };
        case 'IN_FLIGHT':
          return { status: 'IN_FLIGHT', displayNo, reply: composer.cancelInFlight(displayNo) };
      }
    } catch (error) {
      this.deps.logger.error('reminder.conversation.failed', {
        operation: 'CANCEL',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return { status: 'FAILED', displayNo, reply: composer.storageFailure() };
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

  private reply(input: ReminderTurnInput, body: MessageBody): OutboundMessage {
    return outboundMessage(input.context, body, { replyToMessageId: input.messageId });
  }
}
