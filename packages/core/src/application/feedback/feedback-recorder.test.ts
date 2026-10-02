import { describe, expect, it, vi } from 'vitest';
import { Capability, FeedbackSignalKind, IntentType } from '../../domain';
import type { ConversationTurnRecord, FeedbackSignal, FeedbackSummary, InboundMessage } from '../../domain';
import type { FeedbackRepository, FeedbackSummaryQuery, FeedbackTurnLocation, Logger, SaveTurnResult } from '../../ports';
import {
  FEEDBACK_PRUNE_MAX_ROWS, FEEDBACK_PREVIOUS_TURN_LOOKBACK_MS, FEEDBACK_RETENTION_MS, FEEDBACK_SUMMARY_RECENT_NEGATIVE_LIMIT,
  FEEDBACK_SUMMARY_WINDOW_MS, FeedbackRecorder,
} from './feedback-recorder';
import type { RecordTurnInput } from './feedback-recorder';

const SECRET_TEXT = '비밀 프로젝트 codename-zebra 요청';

/** Minimal in-memory fake honouring the port contract (idempotent turns, upsert by (turnId, source, sourceKey)). */
class FakeFeedbackRepository implements FeedbackRepository {
  readonly turns: ConversationTurnRecord[] = [];
  readonly signals: FeedbackSignal[] = [];
  readonly pruneCalls: Array<{ cutoff: string; maxRows: number }> = [];
  readonly summaryQueries: FeedbackSummaryQuery[] = [];
  readonly previousQueries: Array<{ location: FeedbackTurnLocation; before: string; withinMs: number }> = [];

  async saveTurn(turn: ConversationTurnRecord): Promise<SaveTurnResult> {
    const existing = this.turns.find((t) => t.platform === turn.platform && t.inboundMessageId === turn.inboundMessageId);
    if (existing) return { turn: existing, created: false };
    this.turns.push(structuredClone(turn));
    return { turn, created: true };
  }
  async findTurnByPlatformMessage(platform: string, id: string): Promise<ConversationTurnRecord | null> {
    return this.turns.find((t) => t.platform === platform && t.platformMessageIds.includes(id)) ?? null;
  }
  async findPreviousTurn(location: FeedbackTurnLocation, before: string, withinMs: number): Promise<ConversationTurnRecord | null> {
    this.previousQueries.push({ location, before, withinMs });
    const after = Date.parse(before) - withinMs;
    const candidates = this.turns.filter((t) => t.platform === location.platform && t.channelId === location.channelId
      && t.threadId === location.threadId && t.createdAt < before && Date.parse(t.createdAt) >= after);
    return candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
  }
  async upsertSignal(signal: FeedbackSignal): Promise<FeedbackSignal> {
    const index = this.signals.findIndex((s) => s.turnId === signal.turnId && s.source === signal.source
      && s.sourceKey === signal.sourceKey);
    if (index < 0) {
      this.signals.push(signal);
      return signal;
    }
    const merged = { ...this.signals[index]!, kind: signal.kind, value: signal.value, updatedAt: signal.updatedAt };
    this.signals[index] = merged;
    return merged;
  }
  async summarize(query: FeedbackSummaryQuery): Promise<FeedbackSummary> {
    this.summaryQueries.push(query);
    return { since: query.since, turnCount: 0, signals: [], byCapability: [], byIntent: [], recentNegative: [] };
  }
  async pruneOlderThan(cutoff: string, maxRows: number): Promise<number> {
    this.pruneCalls.push({ cutoff, maxRows });
    return 0;
  }
}

const NOW = '2026-10-02T12:00:00.000Z';

function setup(repository: FeedbackRepository = new FakeFeedbackRepository()) {
  let seq = 0;
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sessions = { get: vi.fn(async (id: string) => (id === 's1' ? { actorId: 'actor-1' } : null)) };
  const recorder = new FeedbackRecorder(repository, sessions, {
    clock: () => NOW, idGenerator: () => `id-${++seq}`, logger,
  });
  return { recorder, logger, sessions };
}

function message(id: string, text: string, overrides: Partial<InboundMessage['context']> = {}): InboundMessage {
  return {
    id, text, receivedAt: NOW,
    context: { platform: 'discord', channelId: 'c1', userId: 'u1', ...overrides },
  };
}

function turnInput(id: string, text: string, startedAt: string, overrides: Partial<RecordTurnInput> = {}): RecordTurnInput {
  return {
    message: message(id, text),
    result: {
      status: 'RESPONDED', sessionId: 's1', reply: { text: 'reply text that must never be stored' },
      workFacts: { intentType: IntentType.CHAT, capability: Capability.GENERAL_CHAT, taskId: 't1', runId: 'r1', providerId: 'p' },
    },
    receipt: { platformMessageIds: [`reply-${id}`, `reply-${id}`] },
    startedAt,
    deliveredAt: new Date(Date.parse(startedAt) + 2_000).toISOString(),
    ...overrides,
  };
}

describe('FeedbackRecorder.recordTurn (ADR-0098 D5)', () => {
  it('saves a content-free turn with actor, facts, sizes and a hashed fingerprint', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    await recorder.recordTurn(turnInput('m1', SECRET_TEXT, '2026-10-02T11:00:00.000Z'));
    expect(repository.turns).toHaveLength(1);
    const turn = repository.turns[0]!;
    expect(turn).toMatchObject({
      id: 'id-1', sessionId: 's1', actorId: 'actor-1', platform: 'discord', channelId: 'c1', inboundMessageId: 'm1',
      platformUserId: 'u1', status: 'RESPONDED', createdAt: '2026-10-02T11:00:00.000Z', latencyMs: 2_000,
      replyChars: 'reply text that must never be stored'.length, intentType: IntentType.CHAT,
      capability: Capability.GENERAL_CHAT, taskId: 't1', runId: 'r1', providerId: 'p', platformMessageIds: ['reply-m1'],
    });
    expect(turn.control).toBeUndefined();
    expect(turn.requestFingerprint).toHaveLength(5); // 비밀, 프로젝트, codename, zebra, 요청
    const serialized = JSON.stringify(turn);
    for (const fragment of ['비밀', '프로젝트', 'codename', 'zebra', 'reply text']) expect(serialized).not.toContain(fragment);
  });

  it('marks control turns, skips their fingerprint, and records them without work facts', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    await recorder.recordTurn(turnInput('m1', '피드백 요약', NOW, { result: { status: 'RESPONDED', sessionId: 's1' } }));
    expect(repository.turns[0]).toMatchObject({ control: 'feedback-summary', requestFingerprint: [], replyChars: 0 });
    expect(repository.turns[0]!.capability).toBeUndefined();
  });

  it('is idempotent for a duplicate inbound id (no second row, no second signal pass)', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    await recorder.recordTurn(turnInput('m1', 'alpha beta', '2026-10-02T11:00:00.000Z'));
    await recorder.recordTurn(turnInput('m2', 'alpha beta', '2026-10-02T11:00:30.000Z'));
    await recorder.recordTurn(turnInput('m2', 'alpha beta', '2026-10-02T11:00:30.000Z'));
    expect(repository.turns.map((t) => t.inboundMessageId)).toEqual(['m1', 'm2']);
    expect(repository.previousQueries).toHaveLength(2);
    expect(repository.signals).toHaveLength(1);
  });

  it('attaches implicit signals to the previous turn, measured from its reply delivery', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    await recorder.recordTurn(turnInput('m1', 'alpha beta gamma', '2026-10-02T11:00:00.000Z'));
    // Reply delivered at 11:00:02; the reset at 11:02:01 is 119 s later (but 121 s after the turn started).
    await recorder.recordTurn(turnInput('m2', '새 대화', '2026-10-02T11:02:01.000Z', {
      result: { status: 'RESPONDED', sessionId: 's1' },
    }));
    expect(repository.previousQueries[1]).toEqual({
      location: { platform: 'discord', channelId: 'c1', threadId: undefined },
      before: '2026-10-02T11:02:01.000Z',
      withinMs: FEEDBACK_PREVIOUS_TURN_LOOKBACK_MS,
    });
    expect(repository.signals).toEqual([{
      id: 'id-3', turnId: 'id-1', kind: FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY, source: 'IMPLICIT',
      sourceKey: FeedbackSignalKind.IMPLICIT_RESET_AFTER_REPLY, value: 'OBSERVED', createdAt: NOW, updatedAt: NOW,
    }]);
  });

  it('records an approval re-prompt and ignores a previous turn by another user', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    const awaiting = { status: 'AWAITING_APPROVAL' as const, sessionId: 's1' };
    await recorder.recordTurn(turnInput('m1', 'deploy it', '2026-10-02T11:00:00.000Z', { result: awaiting }));
    await recorder.recordTurn(turnInput('m2', '응', '2026-10-02T11:10:00.000Z', { result: awaiting }));
    expect(repository.signals.map((s) => [s.turnId, s.kind])).toEqual([['id-1', FeedbackSignalKind.IMPLICIT_APPROVAL_REPROMPT]]);

    const other = turnInput('m3', '틀렸어', '2026-10-02T11:10:30.000Z');
    other.message.context.userId = 'u2';
    await recorder.recordTurn(other);
    expect(repository.signals).toHaveLength(1);
  });

  it('prunes turns older than 365 days, bounded to 100 per call', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    await recorder.recordTurn(turnInput('m1', 'alpha', NOW));
    expect(FEEDBACK_RETENTION_MS).toBe(365 * 86_400_000);
    expect(repository.pruneCalls).toEqual([{
      cutoff: new Date(Date.parse(NOW) - FEEDBACK_RETENTION_MS).toISOString(), maxRows: FEEDBACK_PRUNE_MAX_ROWS,
    }]);
    expect(FEEDBACK_PRUNE_MAX_ROWS).toBe(100);
  });

  it('records without an actor when the session lookup fails, and logs without content', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder, logger, sessions } = setup(repository);
    sessions.get.mockRejectedValueOnce(new Error(SECRET_TEXT));
    await recorder.recordTurn(turnInput('m1', SECRET_TEXT, NOW));
    expect(repository.turns[0]!.actorId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('feedback capture failed', { stage: 'resolveActor', errorName: 'Error' });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('codename');
  });
});

describe('FeedbackRecorder.recordReaction', () => {
  async function seeded() {
    const repository = new FakeFeedbackRepository();
    const ctx = setup(repository);
    await ctx.recorder.recordTurn(turnInput('m1', 'alpha', '2026-10-02T11:00:00.000Z'));
    return { repository, ...ctx };
  }
  const reaction = { platform: 'discord', platformUserId: 'u1', targetPlatformMessageId: 'reply-m1', rating: 'NEGATIVE' } as const;

  it('upserts, retracts and re-adds into one row per rater and emoji', async () => {
    const { repository, recorder } = await seeded();
    await recorder.recordReaction({ ...reaction, action: 'ADDED' });
    await recorder.recordReaction({ ...reaction, action: 'REMOVED' });
    expect(repository.signals).toHaveLength(1);
    expect(repository.signals[0]).toMatchObject({ value: 'RETRACTED', kind: FeedbackSignalKind.EXPLICIT_RATING });
    await recorder.recordReaction({ ...reaction, action: 'ADDED' });
    expect(repository.signals).toEqual([expect.objectContaining({
      turnId: 'id-1', source: 'REACTION', sourceKey: 'u1:NEGATIVE', value: 'NEGATIVE',
    })]);
    await recorder.recordReaction({ ...reaction, rating: 'POSITIVE', action: 'ADDED' });
    await recorder.recordReaction({ ...reaction, rating: 'POSITIVE', action: 'REMOVED' });
    expect(repository.signals.map((s) => [s.sourceKey, s.value])).toEqual([['u1:NEGATIVE', 'NEGATIVE'], ['u1:POSITIVE', 'RETRACTED']]);
  });

  it('drops a rater mismatch, an unknown message, and a control turn', async () => {
    const { repository, recorder } = await seeded();
    await recorder.recordReaction({ ...reaction, platformUserId: 'u2', action: 'ADDED' });
    await recorder.recordReaction({ ...reaction, targetPlatformMessageId: 'unknown', action: 'ADDED' });
    await recorder.recordTurn(turnInput('m2', '도움말', '2026-10-02T11:05:00.000Z'));
    await recorder.recordReaction({ ...reaction, targetPlatformMessageId: 'reply-m2', action: 'ADDED' });
    expect(repository.signals).toEqual([]);
  });
});

describe('FeedbackRecorder failure isolation and summary', () => {
  it('swallows every repository error and logs only the stage and error name', async () => {
    const failing: FeedbackRepository = {
      saveTurn: vi.fn().mockRejectedValue(new Error(SECRET_TEXT)),
      findTurnByPlatformMessage: vi.fn().mockRejectedValue(new Error(SECRET_TEXT)),
      findPreviousTurn: vi.fn().mockRejectedValue(new Error(SECRET_TEXT)),
      upsertSignal: vi.fn().mockRejectedValue(new Error(SECRET_TEXT)),
      summarize: vi.fn().mockRejectedValue(new TypeError(SECRET_TEXT)),
      pruneOlderThan: vi.fn().mockRejectedValue(new Error(SECRET_TEXT)),
    };
    const { recorder, logger } = setup(failing);
    await expect(recorder.recordTurn(turnInput('m1', SECRET_TEXT, NOW))).resolves.toBeUndefined();
    await expect(recorder.recordReaction({ ...{ platform: 'discord', platformUserId: 'u1' },
      targetPlatformMessageId: 'x', rating: 'POSITIVE', action: 'ADDED' })).resolves.toBeUndefined();
    await expect(recorder.summarize('actor-1')).resolves.toBeNull();
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      ['feedback capture failed', { stage: 'recordTurn', errorName: 'Error' }],
      ['feedback capture failed', { stage: 'recordReaction', errorName: 'Error' }],
      ['feedback capture failed', { stage: 'summarize', errorName: 'TypeError' }],
    ]);
  });

  it('swallows a throwing logger too', async () => {
    const failing = new FakeFeedbackRepository();
    failing.saveTurn = vi.fn().mockRejectedValue(new Error('boom'));
    const recorder = new FeedbackRecorder(failing, { get: async () => null }, {
      logger: { info: vi.fn(), warn: () => { throw new Error('logger down'); }, error: vi.fn() },
    });
    await expect(recorder.recordTurn(turnInput('m1', 'alpha', NOW))).resolves.toBeUndefined();
  });

  it('summarizes a 30-day window with the five latest negatives', async () => {
    const repository = new FakeFeedbackRepository();
    const { recorder } = setup(repository);
    await expect(recorder.summarize('actor-1')).resolves.toMatchObject({ turnCount: 0 });
    expect(FEEDBACK_SUMMARY_WINDOW_MS).toBe(30 * 86_400_000);
    expect(repository.summaryQueries).toEqual([{
      actorId: 'actor-1', since: new Date(Date.parse(NOW) - FEEDBACK_SUMMARY_WINDOW_MS).toISOString(),
      recentNegativeLimit: FEEDBACK_SUMMARY_RECENT_NEGATIVE_LIMIT,
    }]);
    expect(FEEDBACK_SUMMARY_RECENT_NEGATIVE_LIMIT).toBe(5);
  });
});
