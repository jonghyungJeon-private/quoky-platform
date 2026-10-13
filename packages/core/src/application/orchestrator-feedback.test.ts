import { describe, expect, it, vi } from 'vitest';
import { Capability, IntentType } from '../domain';
import type { ConversationContext, InboundMessage, IsoTimestamp, OutboundMessage } from '../domain';
import type {
  Logger,
  LogFields,
  OutboundDeliveryReceipt,
  PlatformAdapter,
  PlatformFeedbackSignal,
} from '../ports';
import type { ConversationRuntime, TurnResult } from './conversation-runtime';
import type { FeedbackReactionInput, RecordTurnInput } from './feedback/feedback-recorder';
import { QuokyCore } from './orchestrator';
import type { QuokyCoreFeedback } from './orchestrator';

// ADR-0098 D3/D5 (QUAL-4): QuokyCore records each delivered turn best-effort AFTER delivery and relays admitted
// platform reactions to the recorder; neither path ever changes, delays or adds a reply.

const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };
const messageOf = (text: string): InboundMessage => ({ id: 'in-1', context: CTX, text, receivedAt: '2026-10-02T00:00:00.000Z' });

function clockFrom(...stamps: IsoTimestamp[]): () => IsoTimestamp {
  let i = 0;
  return () => stamps[Math.min(i++, stamps.length - 1)]!;
}

interface Events { order: string[]; logs: Array<{ level: string; message: string; fields?: LogFields }> }

function platformReturning(
  events: Events,
  result: () => Promise<void | OutboundDeliveryReceipt>,
): PlatformAdapter & { sends: OutboundMessage[] } {
  const sends: OutboundMessage[] = [];
  return {
    platform: 'test',
    sends,
    async start() {},
    async stop() {},
    onMessage() {},
    onApprovalDecision() {},
    async sendMessage(message: OutboundMessage) {
      events.order.push('send');
      sends.push(message);
      return result();
    },
    async sendTyping() {},
    async requestApproval() {},
  };
}

function loggerOf(events: Events): Logger {
  return {
    info: (message, fields) => events.logs.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => events.logs.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => events.logs.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
  };
}

function recorderOf(events: Events, opts: { throws?: boolean } = {}) {
  const turns: RecordTurnInput[] = [];
  const reactions: FeedbackReactionInput[] = [];
  const feedback: QuokyCoreFeedback = {
    async recordTurn(input) {
      events.order.push('record');
      turns.push(input);
      if (opts.throws) throw new Error('store down: secret message text');
    },
    async recordReaction(signal) {
      reactions.push(signal);
      if (opts.throws) throw new Error('store down');
    },
  };
  return { feedback, turns, reactions };
}

const runtimeOf = (handle: (m: InboundMessage) => Promise<TurnResult>) => ({ handle }) as unknown as ConversationRuntime;

const workResult = (): TurnResult => ({
  status: 'RESPONDED',
  reply: { context: CTX, text: '답변이에요' },
  sessionId: 'sess-1',
  workFacts: { intentType: IntentType.CHAT, capability: Capability.GENERAL_CHAT, taskId: 'task-1', runId: 'run-1', providerId: 'prov-x' },
});

describe('QuokyCore feedback capture (ADR-0098 D5)', () => {
  it('records the turn after delivery with the receipt ids, work facts and the clock readings', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-1', 'out-2'] }));
    const { feedback, turns } = recorderOf(events);
    const core = new QuokyCore({
      runtime: runtimeOf(async () => { events.order.push('handle'); return workResult(); }),
      platform,
      logger: loggerOf(events),
      feedback,
      clock: clockFrom('2026-10-02T10:00:00.000Z', '2026-10-02T10:00:03.000Z'),
    });

    await core.handleInboundMessage(messageOf('질문'));

    expect(events.order).toEqual(['handle', 'send', 'record']);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      message: messageOf('질문'),
      result: {
        status: 'RESPONDED',
        sessionId: 'sess-1',
        reply: { text: '답변이에요' },
        workFacts: workResult().workFacts,
      },
      receipt: { platformMessageIds: ['out-1', 'out-2'] },
      startedAt: '2026-10-02T10:00:00.000Z',
      deliveredAt: '2026-10-02T10:00:03.000Z',
    });
  });

  it('an adapter whose sendMessage returns void still works; the turn is recorded without a receipt', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => undefined);
    const { feedback, turns } = recorderOf(events);
    const core = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events), feedback });

    await core.handleInboundMessage(messageOf('질문'));

    expect(platform.sends).toHaveLength(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.receipt).toBeUndefined();
  });

  it('a recorder exception never alters delivery and is logged without content', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-1'] }));
    const { feedback } = recorderOf(events, { throws: true });
    const result = workResult();
    const core = new QuokyCore({ runtime: runtimeOf(async () => result), platform, logger: loggerOf(events), feedback });

    await expect(core.handleInboundMessage(messageOf('질문 원문'))).resolves.toBeUndefined();

    expect(platform.sends).toEqual([result.reply]);
    const serialized = JSON.stringify(events.logs);
    expect(events.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(serialized).not.toContain('질문 원문');
    expect(serialized).not.toContain('답변이에요');
    expect(serialized).not.toContain('secret message text');
    expect(serialized).not.toContain('out-1');
  });

  it('without a recorder, delivery is exactly as before', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-1'] }));
    const core = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events) });
    await core.handleInboundMessage(messageOf('질문'));
    expect(platform.sends).toHaveLength(1);
    expect(events.logs).toEqual([]);
  });

  it('a delivery failure propagates as before and records nothing', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => { throw new Error('send failed'); });
    const { feedback, turns } = recorderOf(events);
    const core = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events), feedback });
    await expect(core.handleInboundMessage(messageOf('질문'))).rejects.toThrow('send failed');
    expect(turns).toHaveLength(0);
  });

  it('the backstop path records status FAILED with no receipt and no session', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-err'] }));
    const { feedback, turns } = recorderOf(events);
    const core = new QuokyCore({
      runtime: runtimeOf(async () => { throw new Error('boom'); }),
      platform,
      logger: loggerOf(events),
      feedback,
      clock: clockFrom('2026-10-02T10:00:00.000Z', '2026-10-02T10:00:01.000Z'),
    });

    await core.handleInboundMessage(messageOf('질문'));

    expect(platform.sends).toHaveLength(1);
    expect(turns).toEqual([{
      message: messageOf('질문'),
      result: { status: 'FAILED' },
      startedAt: '2026-10-02T10:00:00.000Z',
      deliveredAt: '2026-10-02T10:00:01.000Z',
    }]);
  });
});

describe('QuokyCore.handleFeedbackSignal (ADR-0098 D3)', () => {
  const signal: PlatformFeedbackSignal = {
    platform: 'discord',
    context: { platform: 'discord', channelId: 'c1', userId: 'owner-1' },
    targetPlatformMessageId: 'out-7',
    rating: 'NEGATIVE',
    action: 'REMOVED',
    occurredAt: '2026-10-02T10:00:00.000Z',
  };

  it('delegates to recordReaction and never sends a message or typing indicator', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => undefined);
    const typing = vi.spyOn(platform, 'sendTyping');
    const { feedback, reactions } = recorderOf(events);
    const core = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events), feedback });

    await core.handleFeedbackSignal(signal);

    expect(reactions).toEqual([{
      platform: 'discord', platformUserId: 'owner-1', targetPlatformMessageId: 'out-7', rating: 'NEGATIVE', action: 'REMOVED',
    }]);
    expect(platform.sends).toHaveLength(0);
    expect(typing).not.toHaveBeenCalled();
  });

  it('swallows a recorder failure (content-free log) and is a no-op without a recorder', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => undefined);
    const failing = new QuokyCore({
      runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events), feedback: recorderOf(events, { throws: true }).feedback,
    });
    await expect(failing.handleFeedbackSignal(signal)).resolves.toBeUndefined();
    expect(JSON.stringify(events.logs)).not.toContain('out-7');

    const none = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events) });
    await expect(none.handleFeedbackSignal(signal)).resolves.toBeUndefined();
    expect(platform.sends).toHaveLength(0);
  });
});

describe('QuokyCore delivery observers (ADR-0118 amendment, GML-2)', () => {
  it('tells each observer after delivery, before the feedback record, with the inbound message and the receipt ids', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-1', 'out-2'] }));
    const { feedback } = recorderOf(events);
    const seen: unknown[] = [];
    const core = new QuokyCore({
      runtime: runtimeOf(async () => workResult()),
      platform,
      logger: loggerOf(events),
      feedback,
      deliveryObservers: [{ observeDelivery: async (turn) => { events.order.push('observe'); seen.push(turn); } }],
    });
    await core.handleInboundMessage(messageOf('안 읽은 메일'));
    expect(events.order).toEqual(['send', 'observe', 'record']);
    // Only what an observer needs: the inbound id and context, never its text.
    expect(seen).toEqual([{ messageId: 'in-1', context: CTX, sessionId: 'sess-1', status: 'RESPONDED', platformMessageIds: ['out-1', 'out-2'] }]);
    expect(JSON.stringify(seen)).not.toContain('안 읽은 메일');
  });

  it('CA review P3: deliveredAt is read right after the send, before a slow observer runs', async () => {
    const events: Events = { order: [], logs: [] };
    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-1'] }));
    const { feedback, turns } = recorderOf(events);
    const core = new QuokyCore({
      runtime: runtimeOf(async () => workResult()),
      platform,
      logger: loggerOf(events),
      feedback,
      clock: clockFrom('2026-10-02T10:00:00.000Z', '2026-10-02T10:00:01.000Z', '2026-10-02T10:00:09.000Z'),
      deliveryObservers: [{ observeDelivery: async () => { events.order.push('observe'); } }],
    });
    await core.handleInboundMessage(messageOf('x'));
    expect(turns[0]?.deliveredAt).toBe('2026-10-02T10:00:01.000Z');
  });

  it('is not called without a receipt; a throwing observer never alters delivery, the next observer or the record', async () => {
    const events: Events = { order: [], logs: [] };
    const silent = platformReturning(events, async () => undefined);
    const calls: string[] = [];
    const observers = [
      { observeDelivery: async () => { calls.push('first'); throw new Error('secret listing text'); } },
      { observeDelivery: async () => { calls.push('second'); } },
    ];
    const quiet = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform: silent, logger: loggerOf(events), deliveryObservers: observers });
    await quiet.handleInboundMessage(messageOf('x'));
    expect(calls).toEqual([]);

    const platform = platformReturning(events, async () => ({ platformMessageIds: ['out-1'] }));
    const { feedback, turns } = recorderOf(events);
    const core = new QuokyCore({ runtime: runtimeOf(async () => workResult()), platform, logger: loggerOf(events), feedback, deliveryObservers: observers });
    await expect(core.handleInboundMessage(messageOf('x'))).resolves.toBeUndefined();
    expect(calls).toEqual(['first', 'second']);
    expect(turns).toHaveLength(1);
    expect(events.logs).toContainEqual({ level: 'warn', message: 'delivery observer failed', fields: { errorName: 'Error' } });
    expect(JSON.stringify(events.logs)).not.toContain('secret listing text');
  });
});
