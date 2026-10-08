import { describe, expect, it } from 'vitest';
import type { ConversationContext, InboundMessage, Session } from '../../domain';
import { SessionStatus } from '../../domain';
import type { TurnHandlerContext } from '../../ports/conversation-turn-handler.port';
import type { Logger, LogFields } from '../../ports/logger.port';
import { REMINDER_HELP_LINES } from '../reminders/reminder-turn-handler';
import { ResponseComposer, renderHelpText } from '../response-composer';
import { WORK_CHAT_TODO_TURN_HELP_LINES } from '../work-chat/work-chat-turn-handler';
import {
  HELP_INTENT_HELP_LINES,
  HELP_INTENT_TURN_HANDLER_ID,
  HELP_INTENT_TURN_HANDLER_ORDER,
  HelpIntentTurnHandler,
  createHelpIntentTurnHandler,
} from './help-intent-turn-handler';
import * as coreBarrel from '../../index';

const NOW = '2026-10-06T03:00:00.000Z';
const CONTEXT: ConversationContext = { platform: 'discord', channelId: 'dm-1', userId: 'owner' };

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.entries.push({ level: 'info', message, fields }); }
  warn(message: string, fields?: LogFields): void { this.entries.push({ level: 'warn', message, fields }); }
  error(message: string, fields?: LogFields): void { this.entries.push({ level: 'error', message, fields }); }
}

function context(text: string): TurnHandlerContext {
  const message: InboundMessage = { id: 'm-1', context: CONTEXT, text, receivedAt: NOW };
  const session = {
    id: 's-1', actorId: 'actor-owner', context: CONTEXT, status: SessionStatus.ACTIVE,
    createdAt: NOW, lastActivityAt: NOW,
  } as Session;
  return Object.freeze({
    message: Object.freeze({ ...message, context: Object.freeze({ ...CONTEXT }) }),
    session,
    actor: Object.freeze({ id: 'actor-owner', displayName: 'Owner', identities: [], createdAt: NOW }),
    now: NOW,
    applyAnchor: null,
    resolveActiveWorkspace: async () => {
      throw new Error('the help intent never opens a workspace');
    },
  });
}

const LINES: readonly string[] = [...WORK_CHAT_TODO_TURN_HELP_LINES, ...REMINDER_HELP_LINES, ...HELP_INTENT_HELP_LINES];

describe('HelpIntentTurnHandler registration (ADR-0104 D4)', () => {
  it('is the order-400 pre-classify handler with a stable id and one bounded help line', () => {
    const handler = createHelpIntentTurnHandler({ helpLines: LINES });
    expect(handler).toBeInstanceOf(HelpIntentTurnHandler);
    expect(handler.id).toBe(HELP_INTENT_TURN_HANDLER_ID);
    expect(handler.id).toBe('help-intent');
    expect(handler.stage).toBe('pre-classify');
    expect(handler.order).toBe(HELP_INTENT_TURN_HANDLER_ORDER);
    expect(handler.order).toBe(400);
    expect(handler.helpLines).toEqual(HELP_INTENT_HELP_LINES);
    for (const line of handler.helpLines) expect(Array.from(line).length).toBeLessThanOrEqual(120);
  });

  it('is exported from the @quoky/core barrel', () => {
    expect(coreBarrel.createHelpIntentTurnHandler).toBe(createHelpIntentTurnHandler);
    expect(coreBarrel.HELP_INTENT_TURN_HANDLER_ORDER).toBe(400);
    expect(typeof coreBarrel.detectHelpIntent).toBe('function');
  });
});

describe('HelpIntentTurnHandler.handle', () => {
  it('answers the live W7-06 question with the to-do line, provider-free, replying to the message', async () => {
    const handler = createHelpIntentTurnHandler({ helpLines: LINES });
    const outcome = await handler.handle(context('완료 처리 어떻게 해?'));
    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBeUndefined();
    expect(outcome?.reply.context).toEqual(CONTEXT);
    expect(outcome?.reply.replyToMessageId).toBe('m-1');
    const text = outcome?.reply.text ?? '';
    expect(text).toContain('"완료 처리: 번호"');
    expect(text).toContain('"도움말"');
    expect(text).not.toContain('알림');
    expect(text).not.toContain('사용법 질문');
  });

  it('answers a reminder how-to with the reminder lines', async () => {
    const outcome = await createHelpIntentTurnHandler({ helpLines: LINES }).handle(context('알림 어떻게 지워?'));
    expect(outcome?.reply.text).toContain('"알림 N 취소"');
  });

  it('falls through for ordinary chat, commands and uncovered topics', async () => {
    const handler = createHelpIntentTurnHandler({ helpLines: LINES });
    for (const text of ['안녕', '알림 목록', '파이썬 리스트 정렬 어떻게 해?', '브랜치 어떻게 만들어?', '도움말']) {
      expect(await handler.handle(context(text)), text).toBeNull();
    }
  });

  it('reads a getter source on every turn (lines registered after construction are seen)', async () => {
    const lines: string[] = [];
    const handler = createHelpIntentTurnHandler({ helpLines: () => lines });
    expect(await handler.handle(context('알림 어떻게 지워?'))).toBeNull();
    lines.push(...REMINDER_HELP_LINES);
    expect((await handler.handle(context('알림 어떻게 지워?')))?.reply.text).toContain('"알림 목록"');
  });

  it('falls through and logs the error class only when the line source throws', async () => {
    const logger = new RecordingLogger();
    const handler = createHelpIntentTurnHandler({
      helpLines: () => {
        throw new TypeError('boom 완료 처리');
      },
      logger,
    });
    expect(await handler.handle(context('완료 처리 어떻게 해?'))).toBeNull();
    expect(logger.entries).toEqual([
      { level: 'warn', message: 'help_intent.turn_handler.failed', fields: { errorName: 'TypeError' } },
    ]);
  });

  it('answers in English for an English how-to', async () => {
    const outcome = await createHelpIntentTurnHandler({ helpLines: LINES }).handle(context('How do I set a reminder?'));
    expect(outcome?.reply.text.split('\n')[0]).toContain('Quoky');
    expect(outcome?.reply.text).toContain('"/help"');
  });
});

describe('HelpIntentTurnHandler — capability questions (DET-2, live QA session 3 D11)', () => {
  it('answers "뭐 할 수 있어?" with exactly the "도움말" text built from the same lines (its own line included)', async () => {
    const handler = createHelpIntentTurnHandler({ helpLines: () => LINES });
    for (const text of ['뭐 할 수 있어?', '할 수 있는 게 뭐야?', '명령어 알려줘', 'what can you do?']) {
      const reply = await handler.handle(context(text));
      expect(reply, text).toEqual({ reply: { context: CONTEXT, text: renderHelpText(LINES), replyToMessageId: 'm-1' } });
    }
    expect(renderHelpText(LINES)).toBe(new ResponseComposer().composeHelp(CONTEXT, LINES).text);
    expect(renderHelpText(LINES)).toContain('Quoky로 할 수 있는 일이에요.');
    expect(renderHelpText(LINES)).toContain(HELP_INTENT_HELP_LINES[0] as string);
  });

  it('falls through for a scoped question and keeps topic answers unchanged', async () => {
    const handler = createHelpIntentTurnHandler({ helpLines: LINES });
    expect(await handler.handle(context('파이썬으로 뭐 할 수 있어?'))).toBeNull();
    const topic = await handler.handle(context('완료 처리 어떻게 해?'));
    expect((topic as { reply: { text: string } }).reply.text.startsWith('Quoky에서는 이렇게 하면 돼요.')).toBe(true);
  });
});
