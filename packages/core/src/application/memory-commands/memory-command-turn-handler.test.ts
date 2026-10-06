import { describe, expect, it, vi } from 'vitest';
import type { TurnHandlerContext } from '../../ports';
import { MAX_CONTRIBUTED_HELP_LINE_CHARS } from '../response-composer';
import { createVectorRemovalCascade } from './memory-removal-cascade';
import {
  MEMORY_COMMAND_HELP_LINES,
  MEMORY_COMMAND_TURN_HANDLER_ID,
  MEMORY_COMMAND_TURN_HANDLER_ORDER,
  createMemoryCommandTurnHandler,
} from './memory-command-turn-handler';

function ctx(text: string): TurnHandlerContext {
  return {
    message: {
      id: 'message-1',
      text,
      context: { platform: 'discord', channelId: 'channel-1', userId: 'user-1' },
      receivedAt: '2026-10-06T03:00:00.000Z',
    },
    session: { id: 'session-1' },
    actor: { id: 'actor-1' },
    now: '2026-10-06T03:00:00.000Z',
    applyAnchor: null,
    resolveActiveWorkspace: async () => null,
  } as unknown as TurnHandlerContext;
}

describe('MemoryCommandTurnHandler (ADR-0106 D2)', () => {
  it('is the pre-classify handler at order 50 with one bounded help line', () => {
    const handler = createMemoryCommandTurnHandler({ service: { execute: vi.fn() } });
    expect([handler.id, handler.stage, handler.order]).toEqual([MEMORY_COMMAND_TURN_HANDLER_ID, 'pre-classify', 50]);
    expect(MEMORY_COMMAND_TURN_HANDLER_ORDER).toBe(50);
    expect(handler.helpLines).toEqual(MEMORY_COMMAND_HELP_LINES);
    expect(MEMORY_COMMAND_HELP_LINES).toHaveLength(1);
    for (const line of MEMORY_COMMAND_HELP_LINES) {
      expect(Array.from(line).length).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINE_CHARS);
      expect(line).toContain('기억 목록');
    }
  });

  it('falls through on anything that is not a memory command, without touching the service', async () => {
    const execute = vi.fn();
    const handler = createMemoryCommandTurnHandler({ service: { execute } });
    for (const text of ['기억해: 커피는 아메리카노', '할 일 추가: 기억 목록 정리', '기억 어떻게 지워?', '안녕']) {
      expect(await handler.handle(ctx(text)), text).toBeNull();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs a command for the turn\'s own actor and clock and replies to the message', async () => {
    const execute = vi.fn(async () => ({ outcome: 'listed' as const, text: '목록', status: 'RESPONDED' as const }));
    const handler = createMemoryCommandTurnHandler({ service: { execute } });
    const outcome = await handler.handle(ctx('기억 목록'));
    expect(execute).toHaveBeenCalledWith(
      { kind: 'list', page: 1, language: 'ko' },
      { actorId: 'actor-1', now: '2026-10-06T03:00:00.000Z', sourceText: '기억 목록' },
    );
    expect(outcome).toEqual({
      reply: { context: ctx('').message.context, text: '목록', replyToMessageId: 'message-1' },
      status: 'RESPONDED',
    });
  });

  it('a throwing service is answered with fixed copy (the turn is claimed, never sent to chat)', async () => {
    const warn = vi.fn();
    const handler = createMemoryCommandTurnHandler({
      service: {
        execute: async () => {
          throw new Error('boom 커피');
        },
      },
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const outcome = await handler.handle(ctx('forget memory 1'));
    expect(outcome?.status).toBe('FAILED');
    expect(outcome?.reply.text).toContain('Nothing was changed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('커피');
  });
});

describe('createVectorRemovalCascade', () => {
  it('deletes the memory ids and carried vector ids from the durable-memory collection, once each', async () => {
    const vectors = { delete: vi.fn(async () => undefined) };
    const cascade = createVectorRemovalCascade(vectors);
    await cascade.onMemoriesRemoved({ actorId: 'a', reason: 'forget', memoryIds: ['m1', 'm2'], vectorIds: ['m1', 'v9'], contents: [] });
    expect(vectors.delete).toHaveBeenCalledWith('durable-memory-v1', ['m1', 'm2', 'v9']);
    await cascade.onMemoriesRemoved({ actorId: 'a', reason: 'edit', memoryIds: [], vectorIds: [], contents: [] });
    expect(vectors.delete).toHaveBeenCalledTimes(1);
  });

  it('forwards the service\'s conversation-history form (W2-L01), and withholds a failed edit request text', async () => {
    const history = { user: '기억 1 수정: (내용은 대화 기록에 남기지 않아요)', assistant: '(note)' };
    const execute = vi.fn(async () => ({ outcome: 'edit-confirmation' as const, text: '확인', status: 'RESPONDED' as const, history }));
    const outcome = await createMemoryCommandTurnHandler({ service: { execute } }).handle(ctx('기억 1 수정: 새 내용'));
    expect(outcome).toMatchObject({ history });

    const throwing = createMemoryCommandTurnHandler({
      service: { execute: vi.fn(async () => Promise.reject(new Error('boom'))) },
    });
    expect(await throwing.handle(ctx('기억 1 수정: 새 내용'))).toMatchObject({
      status: 'FAILED',
      history: { user: '기억 1 수정: (내용은 대화 기록에 남기지 않아요)' },
    });
    expect(await throwing.handle(ctx('기억 목록'))).not.toHaveProperty('history');
  });
});
