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

describe('ReminderTurnHandler selection entries (ADR-0120)', () => {
  const brief = { compose: async () => '오늘의 브리핑 · 테스트' };
  const conversation = { handleTurn: async () => null, listReply: async () => ({ context: context('x').message.context, text: '예정된 알림이 없어요.' }) };
  const make = (enabled: boolean) =>
    new ReminderTurnHandler({ conversation, composer: new ReminderReplyComposer(), enabled, logger: new RecordingLogger(), brief });

  it('offers reminder.list and brief.today only while reminders are on', async () => {
    expect(make(true).catalog.map((entry) => entry.id)).toEqual(['reminder.list', 'brief.today']);
    expect(make(false).catalog).toEqual([]);
    const selected = { entryId: 'brief.today' as const, args: {}, language: 'ko' as const };
    expect(await make(false).handleSelected(selected, context('오늘 브리핑'))).toBeNull();
  });
});

describe('the reminder status view is DM-only (owner: channels default-deny until ADR-0122 P1)', () => {
  it('a channel gets the fixed reply and nothing is read; a DM reads the view', async () => {
    const calls: Array<string | undefined> = [];
    const conversation = { handleTurn: async () => null, listReply: async (_input: unknown, status?: string) => { calls.push(status); return { context: CONTEXT, text: '취소된 알림이 없어요.' }; } };
    const handler = new ReminderTurnHandler({ conversation, composer: new ReminderReplyComposer(), enabled: true, logger: new RecordingLogger() });
    const selected = { entryId: 'reminder.list' as const, args: { status: 'canceled' }, language: 'ko' as const };
    const base = context('취소된 알림 보여줘');
    const channel = { ...base, message: { ...base.message, context: { ...CONTEXT, spaceId: 'guild-1', direct: false } } };
    const refused = await handler.handleSelected(selected, channel);
    expect(refused?.reply.text).toBe('취소·완료·지난 항목이나 전체 목록은 DM에서만 보여 드려요.');
    expect(calls).toEqual([]);
    const dm = { ...base, message: { ...base.message, context: { ...CONTEXT, spaceId: undefined, direct: true } } };
    await handler.handleSelected(selected, dm as never);
    expect(calls).toEqual(['canceled']);
  });
});

describe('ADR-0122 P2: the reminder status view follows `reminder` in a channel with the gate enforced', () => {
  it('a permit naming `reminder` reads the view; another permit, or none (the gate off), keeps the DM-only reply', async () => {
    const calls: Array<string | undefined> = [];
    const conversation = { handleTurn: async () => null, listReply: async (_input: unknown, status?: string) => { calls.push(status); return { context: CONTEXT, text: '취소된 알림이 없어요.' }; } };
    const handler = new ReminderTurnHandler({ conversation, composer: new ReminderReplyComposer(), enabled: true, logger: new RecordingLogger() });
    const selected = { entryId: 'reminder.list' as const, args: { status: 'canceled' }, language: 'ko' as const };
    const base = context('취소된 알림 보여줘');
    const channel = (allowed?: readonly string[]) =>
      ({ ...base, message: { ...base.message, context: { ...CONTEXT, spaceId: 'guild-1', direct: false } }, ...(allowed !== undefined ? { surfacePermit: { allowed } } : {}) }) as never;
    expect((await handler.handleSelected(selected, channel(['reminder'])))?.reply.text).toBe('취소된 알림이 없어요.');
    expect(calls).toEqual(['canceled']);
    for (const allowed of [['todo'], undefined]) {
      expect((await handler.handleSelected(selected, channel(allowed)))?.reply.text).toBe('취소·완료·지난 항목이나 전체 목록은 DM에서만 보여 드려요.');
    }
    expect(calls).toEqual(['canceled']);
  });
});

describe('Codex / CA P2 (2026-10-19): a period and a status apply together on reminder.list', () => {
  it('"all" with a period lists the scheduled ones in it; canceled or done with a period asks and reads nothing', async () => {
    const calls: Array<{ status?: string; range?: string }> = [];
    const conversation = {
      handleTurn: async () => null,
      listReply: async (_input: unknown, status?: string, range?: { symbol: string }) => {
        calls.push({ ...(status !== undefined ? { status } : {}), ...(range !== undefined ? { range: range.symbol } : {}) });
        return { context: CONTEXT, text: 'ok' };
      },
    };
    const handler = new ReminderTurnHandler({ conversation, composer: new ReminderReplyComposer(), enabled: true, logger: new RecordingLogger() });
    const range = { symbol: 'tomorrow' } as never;
    await handler.handleSelected({ entryId: 'reminder.list', args: { status: 'all', range: 'tomorrow' }, range, language: 'ko' }, context('내일 알림 전부 보여줘'));
    expect(calls).toEqual([{ range: 'tomorrow' }]);
    const refused = await handler.handleSelected({ entryId: 'reminder.list', args: { status: 'done', range: 'tomorrow' }, range, language: 'ko' }, context('내일 지난 알림'));
    expect(refused?.reply.text).toBe('무엇을/어느 항목을 다시 말씀해 주세요.');
    expect(calls).toHaveLength(1);
  });
});
