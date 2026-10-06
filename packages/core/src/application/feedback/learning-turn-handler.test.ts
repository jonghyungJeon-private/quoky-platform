import { describe, expect, it, vi } from 'vitest';
import type { Actor, InboundMessage, Session } from '../../domain';
import type { Logger, TurnHandlerContext } from '../../ports';
import { LEARNING_FAILURE_TEXT } from './learning-service';
import {
  LEARNING_HELP_LINES, LEARNING_TURN_HANDLER_ID, LEARNING_TURN_HANDLER_ORDER, LearningTurnHandler,
} from './learning-turn-handler';

const NOW = '2026-10-06T00:00:00.000Z';

function ctxOf(text: string, threadId?: string): TurnHandlerContext {
  const message: InboundMessage = {
    id: 'm1', text, receivedAt: NOW,
    context: { platform: 'discord', channelId: 'c1', userId: 'u1', ...(threadId ? { threadId } : {}) },
  };
  return {
    message, session: { id: 's1' } as Session, actor: { id: 'actor-1' } as Actor, now: NOW, applyAnchor: null,
    async resolveActiveWorkspace() { return null; },
  };
}

describe('LearningTurnHandler (ADR-0107 D3)', () => {
  it('is a pre-classify handler at order 60 with one bounded help line naming every command', () => {
    const handler = new LearningTurnHandler({ service: { execute: vi.fn() } });
    expect(handler.id).toBe(LEARNING_TURN_HANDLER_ID);
    expect(handler.stage).toBe('pre-classify');
    expect(handler.order).toBe(LEARNING_TURN_HANDLER_ORDER);
    expect(handler.order).toBe(60);
    expect(handler.helpLines).toHaveLength(1);
    for (const line of handler.helpLines) {
      expect([...line].length).toBeLessThanOrEqual(120);
      for (const phrase of ['피드백 후보', '후보 N 메모', '예시로 저장', '예시 목록', '예시 N 수정', '예시 N 삭제']) {
        expect(line).toContain(phrase);
      }
    }
    expect(LEARNING_HELP_LINES).toBe(handler.helpLines);
  });

  it('falls through for anything that is not a learning command, without touching the service', async () => {
    const execute = vi.fn();
    const handler = new LearningTurnHandler({ service: { execute } });
    for (const text of ['피드백 요약', '예시 좀 들어줘', '할 일 추가: 예시 목록 정리', '안녕']) {
      expect(await handler.handle(ctxOf(text))).toBeNull();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes the parsed command, the actor/location scope and the turn clock to the service', async () => {
    const execute = vi.fn(async () => ({ text: '저장했어요', status: 'RESPONDED' as const }));
    const handler = new LearningTurnHandler({ service: { execute } });
    const reply = await handler.handle(ctxOf('후보 2 메모: 틀렸어', 'th-1'));
    expect(execute).toHaveBeenCalledWith(
      { kind: 'candidate-note', index: 2, note: '틀렸어' },
      { actorId: 'actor-1', platform: 'discord', channelId: 'c1', threadId: 'th-1' },
      NOW,
    );
    expect(reply).toEqual({
      reply: { context: { platform: 'discord', channelId: 'c1', userId: 'u1', threadId: 'th-1' }, text: '저장했어요' },
      status: 'RESPONDED',
    });
  });

  it('answers fixed failure copy when the service throws, logging the command kind only (never the text)', async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handler = new LearningTurnHandler({
      service: { execute: vi.fn(async () => { throw new TypeError('db down'); }) },
      logger,
    });
    const reply = await handler.handle(ctxOf('후보 1 메모: 비밀 메모 내용'));
    expect(reply).toMatchObject({ reply: { text: LEARNING_FAILURE_TEXT }, status: 'FAILED' });
    expect(logger.warn).toHaveBeenCalledWith('learning command failed', { command: 'candidate-note', errorName: 'TypeError' });
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('비밀 메모');
  });
});
