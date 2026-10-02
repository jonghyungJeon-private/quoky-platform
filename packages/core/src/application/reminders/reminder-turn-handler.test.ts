import { describe, expect, it } from 'vitest';
import type { ConversationContext, InboundMessage, OutboundMessage, Session } from '../../domain';
import { SessionStatus } from '../../domain';
import type { TurnHandlerContext } from '../../ports/conversation-turn-handler.port';
import type { Logger, LogFields } from '../../ports/logger.port';
import type { ReminderRepository } from '../../ports/reminder-repository.port';
import { ReminderConversationService, type ReminderTurnInput } from './reminder-conversation-service';
import { ReminderReplyComposer } from './reminder-reply-composer';
import {
  REMINDER_DISABLED_HELP_LINES,
  REMINDER_HELP_LINES,
  REMINDER_TURN_HANDLER_ID,
  REMINDER_TURN_HANDLER_ORDER,
  ReminderTurnHandler,
} from './reminder-turn-handler';

const ZONE = 'Asia/Seoul';
// 2026-10-02 12:00 KST (Friday).
const NOW = '2026-10-02T03:00:00.000Z';
const CONTEXT: ConversationContext = { platform: 'discord', channelId: 'dm-1', userId: 'owner' };

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.entries.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.entries.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.entries.push({ level: 'error', message, fields }); }
}

function context(text: string): TurnHandlerContext {
  const message: InboundMessage = { id: 'm-1', context: CONTEXT, text, receivedAt: NOW };
  const session: Session = {
    id: 's-1', actorId: 'actor-owner', context: CONTEXT, status: SessionStatus.ACTIVE,
    createdAt: NOW, lastActivityAt: NOW,
  } as Session;
  return Object.freeze({
    message: Object.freeze({ ...message, context: Object.freeze({ ...CONTEXT }) }),
    session,
    actor: Object.freeze({ id: 'actor-owner', displayName: 'Owner', identities: [], createdAt: NOW }),
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  });
}

/** Every repository call throws: proves a code path never touched storage. */
function untouchableRepository(): ReminderRepository & { calls: number } {
  const state = { calls: 0 };
  const fail = async (): Promise<never> => {
    state.calls += 1;
    throw new Error('repository must not be called');
  };
  return Object.assign(state, {
    createWithinLimit: fail, listActiveByActor: fail, getByDisplayNo: fail, cancel: fail,
    claimDue: fail, completeFiring: fail, listFiring: fail,
  });
}

function handlerWith(conversation: { handleTurn(input: ReminderTurnInput): Promise<OutboundMessage | null> }, enabled = true) {
  const logger = new RecordingLogger();
  const handler = new ReminderTurnHandler({ conversation, composer: new ReminderReplyComposer(), enabled, logger });
  return { handler, logger };
}

describe('ReminderTurnHandler registration', () => {
  it('is the order-200 pre-classify handler with a stable id', () => {
    const { handler } = handlerWith({ handleTurn: async () => null });
    expect(handler.id).toBe(REMINDER_TURN_HANDLER_ID);
    expect(handler.id).toBe('reminders');
    expect(handler.stage).toBe('pre-classify');
    expect(handler.order).toBe(REMINDER_TURN_HANDLER_ORDER);
    expect(handler.order).toBe(200);
  });

  it('contributes bounded, emoji-free help lines; a disabled handler says the feature is off', () => {
    const enabled = handlerWith({ handleTurn: async () => null }, true).handler;
    const disabled = handlerWith({ handleTurn: async () => null }, false).handler;
    expect(enabled.helpLines).toEqual(REMINDER_HELP_LINES);
    expect(enabled.helpLines.join('\n')).toContain('"알림 목록"');
    expect(enabled.helpLines.join('\n')).toContain('"알림 N 취소"');
    expect(disabled.helpLines).toEqual(REMINDER_DISABLED_HELP_LINES);
    expect(disabled.helpLines.join('\n')).toContain('꺼져 있어요');
    for (const line of [...REMINDER_HELP_LINES, ...REMINDER_DISABLED_HELP_LINES]) {
      expect(Array.from(line).length).toBeLessThanOrEqual(120);
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(line).not.toContain('\n');
    }
  });
});

describe('ReminderTurnHandler dispatch', () => {
  it('maps the frozen turn context onto the service input and returns its reply', async () => {
    const inputs: ReminderTurnInput[] = [];
    const reply: OutboundMessage = { context: CONTEXT, text: '알림 답장', replyToMessageId: 'm-1' };
    const { handler } = handlerWith({ handleTurn: async (input) => { inputs.push(input); return reply; } });

    const handled = await handler.handle(context('30분 뒤에 스트레칭 알려줘'));

    expect(handled).toEqual({ reply });
    expect(inputs).toEqual([
      { text: '30분 뒤에 스트레칭 알려줘', context: CONTEXT, actorId: 'actor-owner', messageId: 'm-1', now: NOW },
    ]);
  });

  it('falls through (null) when the service does not recognize the message', async () => {
    const { handler } = handlerWith({ handleTurn: async () => null });
    expect(await handler.handle(context('오늘 날씨 어때?'))).toBeNull();
  });

  it('answers with the fixed failure copy (FAILED) if the service throws, logging no message text', async () => {
    const { handler, logger } = handlerWith({
      handleTurn: async () => { throw new TypeError('boom 비밀본문'); },
    });

    const handled = await handler.handle(context('내일 9시에 비밀본문 알려줘'));

    expect(handled?.status).toBe('FAILED');
    expect(handled?.reply.text).toBe(new ReminderReplyComposer().storageFailure());
    expect(handled?.reply.replyToMessageId).toBe('m-1');
    expect(logger.entries).toEqual([
      { level: 'error', message: 'reminder.turn_handler.failed', fields: { errorName: 'TypeError' } },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain('비밀본문');
  });
});

describe('ReminderTurnHandler over the real conversation service', () => {
  function realHandler(enabled: boolean) {
    const repository = untouchableRepository();
    const composer = new ReminderReplyComposer();
    const logger = new RecordingLogger();
    const conversation = new ReminderConversationService({ repository, composer, timeZone: ZONE, enabled, logger });
    const handler = new ReminderTurnHandler({ conversation, composer, enabled, logger });
    return { handler, repository, composer };
  }

  it('with reminders disabled a reminder phrase gets the fixed disabled reply and touches no storage', async () => {
    const { handler, repository, composer } = realHandler(false);
    for (const text of ['30분 뒤에 스트레칭 알려줘', '알림 목록', '알림 2 취소', 'remind me in 10 minutes to stretch']) {
      const handled = await handler.handle(context(text));
      expect(handled?.reply.text).toBe(composer.disabled());
      expect(handled?.reply.text).toContain('알림 기능이 꺼져 있어요');
      expect(handled?.status ?? 'RESPONDED').toBe('RESPONDED');
    }
    expect(repository.calls).toBe(0);
  });

  it('with reminders disabled an ordinary message still falls through to the rest of the turn', async () => {
    const { handler, repository } = realHandler(false);
    expect(await handler.handle(context('타입스크립트 제네릭 설명해줘'))).toBeNull();
    expect(repository.calls).toBe(0);
  });

  it('leaves an anchored to-do prefix to the work grammar even with a time phrase', async () => {
    const { handler, repository } = realHandler(true);
    expect(await handler.handle(context('할 일 추가: 내일 9시에 회의 알려줘'))).toBeNull();
    expect(repository.calls).toBe(0);
  });
});
