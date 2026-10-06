import {
  InvalidReminderError,
  REMINDER_LIMITS,
  createReminderDraft,
  type ConversationContext,
  type Id,
  type IsoTimestamp,
  type OutboundMessage,
} from '../../domain';
import type { Logger } from '../../ports/logger.port';
import type { ReminderRepository } from '../../ports/reminder-repository.port';
import { newId } from '../../util/id';
import { containsCredentialMaterial } from '../credential-guard';
import { parseReminderMessage, type ReminderClarifyReason, type ReminderCommand } from './reminder-grammar';
import type { ReminderReplyComposer } from './reminder-reply-composer';

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

  constructor(private readonly deps: ReminderConversationDeps) {
    this.newReminderId = deps.idGenerator ?? newId;
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

  private async execute(command: Exclude<ReminderCommand, { kind: 'NOT_REMINDER' }>, input: ReminderTurnInput): Promise<string> {
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
    }
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

  private reply(input: ReminderTurnInput, text: string): OutboundMessage {
    return { context: input.context, text, replyToMessageId: input.messageId };
  }
}
