import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Capability, FeedbackSignalKind, IntentType, LEARNING_EGRESS_LOCAL_ONLY, LearningItemKind } from '@quoky/core';
import type { ConversationTurnRecord, FeedbackSignal } from '@quoky/core';
import { openLearningReportReader } from './learning-report-reader';
import { LATEST_SCHEMA_VERSION } from './migrations';
import { SqliteStorageProvider } from './index';

const NOW = '2026-10-06T12:00:00.000Z';
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-learning-report-reader-'));
  dirs.push(dir);
  return join(dir, 'quoky.db');
}

function turn(id: string, at: string, over: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    id, sessionId: 's1', actorId: 'actor-1', platform: 'discord', channelId: 'c1', inboundMessageId: `in-${id}`,
    platformUserId: 'u1', status: 'RESPONDED', createdAt: at, latencyMs: 1, replyChars: 2, intentType: IntentType.CHAT,
    capability: Capability.GENERAL_CHAT, taskId: `task-${id}`, runId: `run-${id}`,
    requestFingerprint: ['0a0b0c0d', 'NOT-A-HASH'], platformMessageIds: [], ...over,
  };
}

function signal(turnId: string, value: FeedbackSignal['value'], over: Partial<FeedbackSignal> = {}): FeedbackSignal {
  return {
    id: `sig-${turnId}-${value}-${over.sourceKey ?? 'k'}`, turnId, kind: FeedbackSignalKind.EXPLICIT_RATING, source: 'REACTION',
    sourceKey: 'u1:x', value, createdAt: NOW, updatedAt: NOW, ...over,
  };
}

describe('openLearningReportReader (ADR-0107 D8, read-only)', () => {
  it('reads turn facts, current ratings, implicit signals and the curated-example run metadata', async () => {
    const dbPath = tempDb();
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    await storage.feedback.saveTurn(turn('t1', '2026-10-05T10:00:00.000Z'));
    await storage.feedback.saveTurn(turn('t2', '2026-10-05T11:00:00.000Z'));
    await storage.feedback.saveTurn(turn('t3', '2026-10-05T12:00:00.000Z', { runId: 'run-missing' }));
    await storage.feedback.saveTurn(turn('ctl', '2026-10-05T13:00:00.000Z', { control: 'help' }));
    await storage.feedback.saveTurn(turn('late', '2026-10-06T12:00:00.000Z'));
    await storage.feedback.upsertSignal(signal('t1', 'NEGATIVE', { sourceKey: 'u1:down' }));
    await storage.feedback.upsertSignal(signal('t1', 'RETRACTED', { sourceKey: 'u1:down' }));
    await storage.feedback.upsertSignal(signal('t2', 'NEGATIVE', { sourceKey: 'u1:down' }));
    await storage.feedback.upsertSignal(signal('t2', 'POSITIVE', { sourceKey: 'u1:up' }));
    await storage.feedback.upsertSignal(signal('t2', 'OBSERVED', {
      kind: FeedbackSignalKind.IMPLICIT_CORRECTION, source: 'IMPLICIT', sourceKey: 'c',
    }));
    await storage.feedback.upsertSignal(signal('t2', 'OBSERVED', {
      kind: FeedbackSignalKind.IMPLICIT_REPHRASE, source: 'IMPLICIT', sourceKey: 'r',
    }));
    const base = {
      taskId: 'task', attempt: 1, status: 'COMPLETED', dispatchState: 'DISPATCH_COMMITTED', capability: Capability.GENERAL_CHAT,
      artifactIds: [], startedAt: NOW,
    } as never;
    await storage.taskRuns.save({ ...(base as object), id: 'run-t1', taskId: 'task-t1' } as never);
    await storage.taskRuns.save({ ...(base as object), id: 'run-t2', taskId: 'task-t2', metadata: { curatedExampleCount: 2 } } as never);
    await storage.close();

    const reader = openLearningReportReader(dbPath);
    try {
      const { turns, truncated } = reader.listTurns({ since: '2026-10-01T00:00:00.000Z', until: NOW, limit: 100 });
      expect(truncated).toBe(false);
      expect(turns.map((t) => t.turnId)).toEqual(['t1', 't2', 't3']);
      expect(turns[0]).toMatchObject({
        actorId: 'actor-1', capability: 'GENERAL_CHAT', intentType: 'CHAT', runId: 'run-t1', fingerprint: ['0a0b0c0d'],
        positive: 0, negative: 0, runFound: true, curatedExampleCount: null,
      });
      expect(turns[1]).toMatchObject({
        positive: 1, negative: 1, implicitCorrection: 1, implicitOther: 1, runFound: true, curatedExampleCount: 2,
      });
      expect(turns[2]).toMatchObject({ runFound: false, curatedExampleCount: null });
      expect(reader.listTurns({ since: '2026-10-01T00:00:00.000Z', until: NOW, limit: 100, actorId: 'nobody' }).turns).toEqual([]);
      const capped = reader.listTurns({ since: '2026-10-01T00:00:00.000Z', until: NOW, limit: 2 });
      expect(capped.turns).toHaveLength(2);
      expect(capped.truncated).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('lists every learning row with expiry resolved against the clock, actor-scoped on request', async () => {
    const dbPath = tempDb();
    const storage = new SqliteStorageProvider({ dbPath });
    await storage.init();
    const base = {
      kind: LearningItemKind.GOLDEN_CANDIDATE, capability: 'GENERAL_CHAT', language: 'ko' as const, egress: LEARNING_EGRESS_LOCAL_ONLY,
      createdAt: '2026-01-01T00:00:00.000Z', data: { requestText: 'q', note: 'n', sourceRating: 'NEGATIVE' as const },
    };
    await storage.learning.insertWithinCap({ ...base, id: 'live', actorId: 'a1', expiresAt: '2027-01-01T00:00:00.000Z' }, 10, NOW);
    await storage.learning.insertWithinCap({ ...base, id: 'dead', actorId: 'a2', expiresAt: '2026-06-01T00:00:00.000Z' }, 10, '2026-02-01T00:00:00.000Z');
    await storage.close();
    const reader = openLearningReportReader(dbPath);
    try {
      expect(reader.listLearningItems(NOW).map((r) => [r.item.id, r.expired])).toEqual([['live', false], ['dead', true]]);
      expect(reader.listLearningItems(NOW, 'a2').map((r) => r.item.id)).toEqual(['dead']);
    } finally {
      reader.close();
    }
  });

  it('refuses a missing file, a pre-v14 schema and a schema ahead of this build, creating nothing', () => {
    const missing = tempDb();
    expect(() => openLearningReportReader(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);

    const old = tempDb();
    const db = new Database(old);
    db.pragma('user_version = 13');
    db.close();
    expect(() => openLearningReportReader(old)).toThrow('LEARNING_SCHEMA_MISSING');

    const ahead = tempDb();
    const aheadDb = new Database(ahead);
    aheadDb.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    aheadDb.close();
    expect(() => openLearningReportReader(ahead)).toThrow('SCHEMA_VERSION_AHEAD');
  });
});
