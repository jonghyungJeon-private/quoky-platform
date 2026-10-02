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
        return this.cancel(command.displayNo, input);
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

  private async cancel(displayNo: number, input: ReminderTurnInput): Promise<string> {
    const { composer, repository } = this.deps;
    const result = await repository.cancel(input.actorId, displayNo, input.now);
    switch (result.status) {
      case 'CANCELED':
        return composer.canceled(result.reminder);
      case 'NOT_FOUND':
        return composer.cancelNotFound(displayNo);
      case 'ALREADY_FINAL':
        return composer.cancelAlreadyFinal(result.reminder);
      case 'IN_FLIGHT':
        return composer.cancelInFlight(displayNo);
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
