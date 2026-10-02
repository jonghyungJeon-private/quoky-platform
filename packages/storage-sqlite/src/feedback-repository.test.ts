import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Capability, FeedbackRecorder, FeedbackSignalKind, IntentType } from '@quoky/core';
import type { ConversationTurnRecord, FeedbackSignal } from '@quoky/core';
import { SqliteFeedbackRepository } from './feedback-repository';
import { runMigrations } from './migrations';
import { SqliteStorageProvider } from './index';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(): { db: Database.Database; repository: SqliteFeedbackRepository } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, repository: new SqliteFeedbackRepository(db) };
}

function turn(overrides: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    id: 'turn-1',
    sessionId: 's1',
    actorId: 'actor-1',
    platform: 'discord',
    channelId: 'c1',
    inboundMessageId: 'in-1',
    platformUserId: 'u1',
    status: 'RESPONDED',
    createdAt: '2026-10-02T10:00:00.000Z',
    latencyMs: 1500,
    replyChars: 120,
    intentType: IntentType.CHAT,
    capability: Capability.GENERAL_CHAT,
    taskId: 'task-1',
    runId: 'run-1',
    providerId: 'provider-x',
    requestFingerprint: ['0011aabb', 'ccdd2233'],
    platformMessageIds: ['out-1', 'out-2'],
    ...overrides,
  };
}

function rating(turnId: string, value: FeedbackSignal['value'], key = 'u1:NEGATIVE', at = '2026-10-02T10:05:00.000Z'): FeedbackSignal {
  return {
    id: `sig-${turnId}-${key}-${value}`, turnId, kind: FeedbackSignalKind.EXPLICIT_RATING, source: 'REACTION',
    sourceKey: key, value, createdAt: at, updatedAt: at,
  };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('SqliteFeedbackRepository (ADR-0098 D4, migration v12)', () => {
  it('round-trips a turn and finds it by any reply platform message id', async () => {
    const { repository } = repo();
    const saved = await repository.saveTurn(turn({ threadId: 'th-1' }));
    expect(saved).toEqual({ turn: turn({ threadId: 'th-1' }), created: true });
    expect(await repository.findTurnByPlatformMessage('discord', 'out-2')).toEqual(turn({ threadId: 'th-1' }));
    expect(await repository.findTurnByPlatformMessage('discord', 'missing')).toBeNull();
    expect(await repository.findTurnByPlatformMessage('telegram', 'out-1')).toBeNull();
  });

  it('is idempotent for a duplicate (platform, inbound message id)', async () => {
    const { db, repository } = repo();
    await repository.saveTurn(turn());
    const again = await repository.saveTurn(turn({ id: 'turn-dup', status: 'FAILED', platformMessageIds: ['out-9'] }));
    expect(again).toEqual({ turn: turn(), created: false });
    expect(count(db, 'conversation_turns')).toBe(1);
    expect(count(db, 'turn_platform_messages')).toBe(2);
    expect(await repository.findTurnByPlatformMessage('discord', 'out-9')).toBeNull();
    // The same inbound id on another platform is a different turn.
    expect((await repository.saveTurn(turn({ id: 'turn-tg', platform: 'telegram' }))).created).toBe(true);
  });

  it('finds the previous turn at the same location within the window, strictly before', async () => {
    const { repository } = repo();
    await repository.saveTurn(turn({ id: 'a', inboundMessageId: 'a', createdAt: '2026-10-02T10:00:00.000Z', platformMessageIds: [] }));
    await repository.saveTurn(turn({ id: 'b', inboundMessageId: 'b', createdAt: '2026-10-02T10:01:00.000Z', platformMessageIds: [] }));
    await repository.saveTurn(turn({ id: 't', inboundMessageId: 't', threadId: 'th', createdAt: '2026-10-02T10:01:30.000Z', platformMessageIds: [] }));
    await repository.saveTurn(turn({ id: 'c', inboundMessageId: 'c', createdAt: '2026-10-02T10:02:00.000Z', platformMessageIds: [] }));
    const location = { platform: 'discord', channelId: 'c1' };
    expect((await repository.findPreviousTurn(location, '2026-10-02T10:02:00.000Z', 300_000))?.id).toBe('b');
    expect((await repository.findPreviousTurn(location, '2026-10-02T10:01:00.000Z', 60_000))?.id).toBe('a');
    expect(await repository.findPreviousTurn(location, '2026-10-02T10:01:00.000Z', 59_999)).toBeNull();
    expect((await repository.findPreviousTurn({ ...location, threadId: 'th' }, '2026-10-02T10:05:00.000Z', 600_000))?.id).toBe('t');
    expect(await repository.findPreviousTurn({ ...location, channelId: 'other' }, '2026-10-02T10:05:00.000Z', 600_000)).toBeNull();
    expect(await repository.findPreviousTurn(location, 'not-a-date', 600_000)).toBeNull();
  });

  it('upsert, retract, re-add leaves one row (id and createdAt kept)', async () => {
    const { db, repository } = repo();
    await repository.saveTurn(turn());
    await repository.upsertSignal(rating('turn-1', 'NEGATIVE', 'u1:NEGATIVE', '2026-10-02T10:05:00.000Z'));
    await repository.upsertSignal(rating('turn-1', 'RETRACTED', 'u1:NEGATIVE', '2026-10-02T10:06:00.000Z'));
    const final = await repository.upsertSignal(rating('turn-1', 'NEGATIVE', 'u1:NEGATIVE', '2026-10-02T10:07:00.000Z'));
    expect(count(db, 'feedback_signals')).toBe(1);
    expect(final).toEqual({
      id: 'sig-turn-1-u1:NEGATIVE-NEGATIVE', turnId: 'turn-1', kind: FeedbackSignalKind.EXPLICIT_RATING, source: 'REACTION',
      sourceKey: 'u1:NEGATIVE', value: 'NEGATIVE', createdAt: '2026-10-02T10:05:00.000Z', updatedAt: '2026-10-02T10:07:00.000Z',
    });
  });

  it('summarizes non-control turns of the actor in the window, with no text and no provider id', async () => {
    const { repository } = repo();
    const since = '2026-10-01T00:00:00.000Z';
    await repository.saveTurn(turn({ id: 'old', inboundMessageId: 'old', createdAt: '2026-09-01T00:00:00.000Z', platformMessageIds: [] }));
    await repository.upsertSignal(rating('old', 'NEGATIVE'));
    await repository.saveTurn(turn({ id: 'n1', inboundMessageId: 'n1', createdAt: '2026-10-02T10:00:00.000Z', platformMessageIds: [] }));
    await repository.upsertSignal(rating('n1', 'NEGATIVE'));
    await repository.saveTurn(turn({
      id: 'n2', inboundMessageId: 'n2', createdAt: '2026-10-02T11:00:00.000Z', intentType: IntentType.IMPLEMENT_CODE,
      capability: Capability.CODE_IMPLEMENTATION, taskId: 'task-2', platformMessageIds: [],
    }));
    await repository.upsertSignal(rating('n2', 'NEGATIVE'));
    await repository.upsertSignal(rating('n2', 'POSITIVE', 'u1:POSITIVE'));
    await repository.saveTurn(turn({ id: 'p1', inboundMessageId: 'p1', createdAt: '2026-10-02T12:00:00.000Z', platformMessageIds: [] }));
    await repository.upsertSignal(rating('p1', 'POSITIVE', 'u1:POSITIVE'));
    await repository.upsertSignal({ ...rating('p1', 'OBSERVED', FeedbackSignalKind.IMPLICIT_CORRECTION), kind: FeedbackSignalKind.IMPLICIT_CORRECTION, source: 'IMPLICIT' });
    await repository.saveTurn(turn({ id: 'r1', inboundMessageId: 'r1', createdAt: '2026-10-02T12:30:00.000Z', platformMessageIds: [] }));
    await repository.upsertSignal(rating('r1', 'RETRACTED'));
    await repository.saveTurn(turn({
      id: 'ctl', inboundMessageId: 'ctl', createdAt: '2026-10-02T13:00:00.000Z', control: 'feedback-summary', platformMessageIds: [],
      intentType: undefined, capability: undefined, taskId: undefined,
    }));
    await repository.upsertSignal(rating('ctl', 'NEGATIVE'));
    await repository.saveTurn(turn({ id: 'x', inboundMessageId: 'x', actorId: 'actor-2', createdAt: '2026-10-02T13:00:00.000Z', platformMessageIds: [] }));
    await repository.upsertSignal(rating('x', 'NEGATIVE'));

    const summary = await repository.summarize({ actorId: 'actor-1', since, recentNegativeLimit: 5 });
    expect(summary).toEqual({
      since,
      turnCount: 4,
      signals: [
        { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'NEGATIVE', count: 2 },
        { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'POSITIVE', count: 2 },
        { kind: FeedbackSignalKind.EXPLICIT_RATING, value: 'RETRACTED', count: 1 },
        { kind: FeedbackSignalKind.IMPLICIT_CORRECTION, value: 'OBSERVED', count: 1 },
      ],
      byCapability: [
        { key: Capability.CODE_IMPLEMENTATION, turns: 1, positive: 1, negative: 1, implicit: 0 },
        { key: Capability.GENERAL_CHAT, turns: 3, positive: 1, negative: 1, implicit: 1 },
      ],
      byIntent: [
        { key: IntentType.CHAT, turns: 3, positive: 1, negative: 1, implicit: 1 },
        { key: IntentType.IMPLEMENT_CODE, turns: 1, positive: 1, negative: 1, implicit: 0 },
      ],
      recentNegative: [
        { turnId: 'n2', createdAt: '2026-10-02T11:00:00.000Z', intentType: IntentType.IMPLEMENT_CODE, taskId: 'task-2' },
        { turnId: 'n1', createdAt: '2026-10-02T10:00:00.000Z', intentType: IntentType.CHAT, taskId: 'task-1' },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('provider-x');
    expect((await repository.summarize({ actorId: 'actor-1', since, recentNegativeLimit: 1 })).recentNegative.map((t) => t.turnId))
      .toEqual(['n2']);
  });

  it('prunes old turns with their messages and signals, bounded per call', async () => {
    const { db, repository } = repo();
    for (let i = 0; i < 5; i += 1) {
      await repository.saveTurn(turn({
        id: `old-${i}`, inboundMessageId: `old-${i}`, createdAt: `2025-01-0${i + 1}T00:00:00.000Z`, platformMessageIds: [`o-${i}`],
      }));
      await repository.upsertSignal(rating(`old-${i}`, 'NEGATIVE'));
    }
    await repository.saveTurn(turn({ id: 'new', inboundMessageId: 'new', createdAt: '2026-10-02T00:00:00.000Z', platformMessageIds: ['n'] }));
    await repository.upsertSignal(rating('new', 'POSITIVE'));
    const cutoff = '2025-10-02T00:00:00.000Z';
    expect(await repository.pruneOlderThan(cutoff, 3)).toBe(3);
    expect((db.prepare('SELECT id FROM conversation_turns ORDER BY created_at').all() as Array<{ id: string }>).map((r) => r.id))
      .toEqual(['old-3', 'old-4', 'new']);
    expect(count(db, 'turn_platform_messages')).toBe(3);
    expect(count(db, 'feedback_signals')).toBe(3);
    expect(await repository.pruneOlderThan(cutoff, 3)).toBe(2);
    expect(await repository.pruneOlderThan(cutoff, 3)).toBe(0);
    expect(await repository.pruneOlderThan('2030-01-01T00:00:00.000Z', 0)).toBe(0);
    expect(count(db, 'conversation_turns')).toBe(1);
  });
});

describe('FeedbackRecorder over SQLite (QUAL-3 end to end, disposable DB)', () => {
  it('persists no message or reply text anywhere in the feedback tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-feedback-'));
    dirs.push(dir);
    const dbPath = join(dir, 'chunsik.db');
    const store = new SqliteStorageProvider({ dbPath });
    await store.init();
    const text = 'zebra-codename 비밀요청 alpha';
    const replyText = 'reply-body-unique-marker';
    const recorder = new FeedbackRecorder(store.feedback, { get: async () => ({ actorId: 'actor-1' }) });
    const context = { platform: 'discord', channelId: 'c1', userId: 'u1' };
    await recorder.recordTurn({
      message: { id: 'in-1', text, receivedAt: '2026-10-02T10:00:00.000Z', context },
      result: { status: 'RESPONDED', sessionId: 's1', reply: { text: replyText } },
      receipt: { platformMessageIds: ['out-1'] },
      startedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
    });
    await recorder.recordTurn({
      message: { id: 'in-2', text: `틀렸어 ${text}`, receivedAt: '2026-10-02T10:00:00.000Z', context },
      result: { status: 'RESPONDED', sessionId: 's1', reply: { text: replyText }, workFacts: { capability: Capability.GENERAL_CHAT } },
      startedAt: new Date(Date.now() + 1000).toISOString(),
      deliveredAt: new Date(Date.now() + 2000).toISOString(),
    });
    await recorder.recordReaction({
      platform: 'discord', platformUserId: 'u1', targetPlatformMessageId: 'out-1', rating: 'NEGATIVE', action: 'ADDED',
    });
    await store.close();

    const db = new Database(dbPath, { readonly: true });
    const dump = JSON.stringify(['conversation_turns', 'turn_platform_messages', 'feedback_signals']
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
    db.close();
    expect(dump).toContain('out-1');
    expect(dump).toContain(FeedbackSignalKind.IMPLICIT_CORRECTION);
    expect(dump).toContain(FeedbackSignalKind.EXPLICIT_RATING);
    for (const fragment of ['zebra', 'codename', '비밀', 'alpha', '틀렸어', replyText]) expect(dump).not.toContain(fragment);
  });
});
