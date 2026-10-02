import { describe, expect, it, vi } from 'vitest';
import { FeedbackSignalKind, IntentType } from '../../domain';
import type { Actor, FeedbackSummary, InboundMessage, Session } from '../../domain';
import type { TurnHandlerContext } from '../../ports';
import { FEEDBACK_SUMMARY_UNAVAILABLE_TEXT } from './feedback-summary-composer';
import {
  FEEDBACK_HELP_LINES,
  FEEDBACK_SUMMARY_TURN_HANDLER_ORDER,
  FeedbackSummaryTurnHandler,
} from './feedback-summary-turn-handler';

const CTX = { platform: 'test', channelId: 'c1', userId: 'u1' };
const ACTOR = { id: 'actor-1' } as Actor;

function ctxOf(text: string): TurnHandlerContext {
  const message: InboundMessage = { id: 'm1', context: CTX, text, receivedAt: '2026-10-02T00:00:00.000Z' };
  return {
    message,
    session: { id: 's1' } as Session,
    actor: ACTOR,
    now: '2026-10-02T00:00:00.000Z',
    applyAnchor: null,
    async resolveActiveWorkspace() { return null; },
  };
}

const SUMMARY: FeedbackSummary = {
  since: '2026-09-02T00:00:00.000Z',
  turnCount: 2,
  signals: [{ kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'NEGATIVE', count: 1 }],
  byCapability: [],
  byIntent: [],
  recentNegative: [
    { turnId: 't2', createdAt: '2026-10-01T00:00:00.000Z', intentType: IntentType.CHAT, taskId: 'task-2' },
    { turnId: 't1', createdAt: '2026-09-30T00:00:00.000Z', intentType: IntentType.CHAT, taskId: 'task-2' },
  ],
};

function handlerWith(over: { summarize?: () => Promise<FeedbackSummary | null>; get?: (id: string) => Promise<{ description: string } | null> } = {}) {
  const summarize = vi.fn(over.summarize ?? (async () => SUMMARY));
  const get = vi.fn(over.get ?? (async () => ({ description: '테스트 요청' })));
  const handler = new FeedbackSummaryTurnHandler({ feedback: { summarize }, tasks: { get } });
  return { handler, summarize, get };
}

describe('FeedbackSummaryTurnHandler (ADR-0098 D6)', () => {
  it('is a control-stage handler at order 100 contributing the 👍/👎 and 피드백 요약 help lines', () => {
    const { handler } = handlerWith();
    expect(handler.stage).toBe('control');
    expect(handler.order).toBe(FEEDBACK_SUMMARY_TURN_HANDLER_ORDER);
    expect(handler.order).toBe(100);
    expect(handler.helpLines).toBe(FEEDBACK_HELP_LINES);
    expect(handler.helpLines.join('\n')).toContain('👍/👎');
    expect(handler.helpLines.join('\n')).toContain('"피드백 요약"');
    for (const line of handler.helpLines) expect([...line].length).toBeLessThanOrEqual(120);
  });

  it.each(['피드백 요약', '  피드백 요약  ', '피드백 요약\n'])('answers the exact whole message %j', async (text) => {
    const { handler, summarize } = handlerWith();
    const reply = await handler.handle(ctxOf(text));
    expect(reply?.reply.text).toContain('최근 30일 피드백 요약이에요.');
    expect(reply?.reply.context).toEqual(CTX);
    expect(reply?.status).toBeUndefined();
    expect(summarize).toHaveBeenCalledWith('actor-1');
  });

  it.each(['피드백 요약해줘', '피드백 요약 기능 만들어줘', '/피드백 요약', '피드백요약', '피드백 요약?', '도움말'])(
    'falls through for %j without reading anything',
    async (text) => {
      const { handler, summarize, get } = handlerWith();
      expect(await handler.handle(ctxOf(text))).toBeNull();
      expect(summarize).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('looks each recent 👎 Task up once and uses its request text', async () => {
    const { handler, get } = handlerWith();
    const reply = await handler.handle(ctxOf('피드백 요약'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('task-2');
    expect(reply?.reply.text).toContain('"테스트 요청"');
  });

  it('a failing Task lookup only drops that excerpt', async () => {
    const { handler } = handlerWith({ get: async () => { throw new Error('db'); } });
    const reply = await handler.handle(ctxOf('피드백 요약'));
    expect(reply?.reply.text).toContain('(요청 내용을 찾을 수 없어요)');
    expect(reply?.status).toBeUndefined();
  });

  it('an unreadable store answers with fixed copy and FAILED, never throwing', async () => {
    const nullStore = handlerWith({ summarize: async () => null });
    expect(await nullStore.handler.handle(ctxOf('피드백 요약'))).toEqual({
      reply: { context: CTX, text: FEEDBACK_SUMMARY_UNAVAILABLE_TEXT }, status: 'FAILED',
    });
    const throwing = handlerWith({ summarize: async () => { throw new Error('boom'); } });
    expect(await throwing.handler.handle(ctxOf('피드백 요약'))).toEqual({
      reply: { context: CTX, text: FEEDBACK_SUMMARY_UNAVAILABLE_TEXT }, status: 'FAILED',
    });
  });
});
