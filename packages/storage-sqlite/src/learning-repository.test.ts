import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { LEARNING_EGRESS_LOCAL_ONLY, LearningItemKind } from '@quoky/core';
import type { LearningItem } from '@quoky/core';
import { LEARNING_SCHEMA_VERSION, SqliteLearningRepository, openLearningExportReader } from './learning-repository';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from './migrations';
import { SqliteStorageProvider } from './index';

const NOW = '2026-10-06T12:00:00.000Z';
const LATER = '2027-10-07T12:00:00.000Z';
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(): { db: Database.Database; repository: SqliteLearningRepository } {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, repository: new SqliteLearningRepository(db) };
}

function item(over: Partial<LearningItem> = {}): LearningItem {
  return {
    id: 'item-1',
    actorId: 'actor-1',
    kind: LearningItemKind.GOLDEN_CANDIDATE,
    capability: 'GENERAL_CHAT',
    language: 'ko',
    sourceTurnId: 'turn-1',
    egress: LEARNING_EGRESS_LOCAL_ONLY,
    createdAt: NOW,
    expiresAt: '2027-10-06T12:00:00.000Z',
    data: { requestText: '내일 회의 몇 시야?', note: '날씨를 답했어', sourceRating: 'NEGATIVE' },
    ...over,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-learning-'));
  dirs.push(dir);
  return dir;
}

describe('SqliteLearningRepository (ADR-0107 D2/D7, migration v14)', () => {
  it('round-trips an item, scoped to its actor, and never returns it after expiry', async () => {
    const { repository } = repo();
    expect(await repository.insertWithinCap(item(), 1000, NOW)).toBe('INSERTED');
    expect(await repository.get('actor-1', 'item-1', NOW)).toEqual(item());
    expect(await repository.get('actor-2', 'item-1', NOW)).toBeNull();
    expect(await repository.get('actor-1', 'item-1', LATER)).toBeNull();
    expect(await repository.findBySourceTurn('actor-1', LearningItemKind.GOLDEN_CANDIDATE, 'turn-1', NOW)).toEqual(item());
    expect(await repository.findBySourceTurn('actor-1', LearningItemKind.EXAMPLE, 'turn-1', NOW)).toBeNull();
    expect(await repository.findBySourceTurn('actor-2', LearningItemKind.GOLDEN_CANDIDATE, 'turn-1', NOW)).toBeNull();
  });

  it('stores only the whitelisted data fields', async () => {
    const { db, repository } = repo();
    const sneaky = item({ data: { ...item().data, idealAnswer: 'a', extra: 'leak' } as LearningItem['data'] });
    await repository.insertWithinCap(sneaky, 1000, NOW);
    const raw = JSON.parse((db.prepare('SELECT data FROM learning_items').get() as { data: string }).data) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['idealAnswer', 'note', 'requestText', 'sourceRating']);
  });

  it('refuses a non-LOCAL_ONLY egress, an unknown kind and an over-long text (nothing written)', async () => {
    const { db, repository } = repo();
    await expect(repository.insertWithinCap(item({ egress: 'ANYWHERE' as never }), 1000, NOW)).rejects.toThrow('LEARNING_EGRESS_INVALID');
    await expect(repository.insertWithinCap(item({ kind: 'OTHER' as never }), 1000, NOW)).rejects.toThrow('LEARNING_KIND_INVALID');
    await expect(repository.insertWithinCap(item({ data: { requestText: 'x'.repeat(2001), sourceRating: 'NEGATIVE' } }), 1000, NOW))
      .rejects.toThrow('LEARNING_TEXT_INVALID');
    expect((db.prepare('SELECT COUNT(*) AS n FROM learning_items').get() as { n: number }).n).toBe(0);
  });

  it('enforces the per-actor cap on unexpired items without evicting, per actor', async () => {
    const { repository } = repo();
    expect(await repository.insertWithinCap(item({ id: 'a' }), 2, NOW)).toBe('INSERTED');
    expect(await repository.insertWithinCap(item({ id: 'b' }), 2, NOW)).toBe('INSERTED');
    expect(await repository.insertWithinCap(item({ id: 'c' }), 2, NOW)).toBe('CAP_REACHED');
    expect(await repository.insertWithinCap(item({ id: 'd', actorId: 'actor-2' }), 2, NOW)).toBe('INSERTED');
    expect(await repository.insertWithinCap(item({ id: 'e', createdAt: LATER, expiresAt: '2028-10-07T12:00:00.000Z' }), 2, LATER))
      .toBe('INSERTED');
    expect((await repository.list({ actorId: 'actor-1', kind: LearningItemKind.GOLDEN_CANDIDATE, now: NOW, limit: 10 }))
      .map((i) => i.id)).toEqual(['e', 'b', 'a']);
  });

  it('lists one actor\'s unexpired items of one kind, newest first, bounded', async () => {
    const { repository } = repo();
    await repository.insertWithinCap(item({ id: 'old', createdAt: '2026-10-01T00:00:00.000Z' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'new', createdAt: '2026-10-05T00:00:00.000Z' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'ex', kind: LearningItemKind.EXAMPLE }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'other', actorId: 'actor-2' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'expired', expiresAt: '2026-10-06T00:00:00.000Z' }), 1000, '2026-10-01T00:00:00.000Z');
    const list = (query: { limit: number }) =>
      repository.list({ actorId: 'actor-1', kind: LearningItemKind.GOLDEN_CANDIDATE, now: NOW, ...query });
    expect((await list({ limit: 10 })).map((i) => i.id)).toEqual(['new', 'old']);
    expect((await list({ limit: 1 })).map((i) => i.id)).toEqual(['new']);
    expect(await list({ limit: 0 })).toEqual([]);
  });

  it('updates data only for the owning actor\'s unexpired item', async () => {
    const { repository } = repo();
    await repository.insertWithinCap(item(), 1000, NOW);
    const data = { ...item().data, note: '고친 메모' };
    expect(await repository.updateData('actor-2', 'item-1', data, NOW)).toBe(false);
    expect(await repository.updateData('actor-1', 'item-1', data, LATER)).toBe(false);
    expect(await repository.updateData('actor-1', 'item-1', data, NOW)).toBe(true);
    expect((await repository.get('actor-1', 'item-1', NOW))?.data.note).toBe('고친 메모');
  });

  it('deletes one item only for its actor', async () => {
    const { repository } = repo();
    await repository.insertWithinCap(item(), 1000, NOW);
    expect(await repository.delete('actor-2', 'item-1')).toBe(false);
    expect(await repository.delete('actor-1', 'item-1')).toBe(true);
    expect(await repository.delete('actor-1', 'item-1')).toBe(false);
  });

  it('forget cascade: deletes exactly the actor\'s items derived from the memory record (ADR-0107 D7)', async () => {
    const { repository } = repo();
    await repository.insertWithinCap(item({ id: 'a', sourceMemoryId: 'mem-1' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'b', sourceMemoryId: 'mem-1', kind: LearningItemKind.EXAMPLE }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'c', sourceMemoryId: 'mem-2' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'd', actorId: 'actor-2', sourceMemoryId: 'mem-1' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'e' }), 1000, NOW);
    expect(await repository.deleteBySourceMemory('actor-1', 'mem-1')).toBe(2);
    expect(await repository.deleteBySourceMemory('actor-1', 'mem-1')).toBe(0);
    expect(await repository.get('actor-1', 'c', NOW)).not.toBeNull();
    expect(await repository.get('actor-1', 'e', NOW)).not.toBeNull();
    expect(await repository.get('actor-2', 'd', NOW)).not.toBeNull();
    expect((await repository.get('actor-1', 'c', NOW))?.sourceMemoryId).toBe('mem-2');
  });

  it('prunes expired rows lazily, oldest expiry first, bounded per call', async () => {
    const { db, repository } = repo();
    for (const [id, expiresAt] of [['x1', '2026-10-03T00:00:00.000Z'], ['x2', '2026-10-01T00:00:00.000Z'], ['x3', '2026-10-02T00:00:00.000Z'], ['keep', '2027-01-01T00:00:00.000Z']] as const) {
      await repository.insertWithinCap(item({ id, expiresAt }), 1000, '2026-09-01T00:00:00.000Z');
    }
    expect(await repository.pruneExpired(NOW, 2)).toBe(2);
    expect((db.prepare('SELECT id FROM learning_items ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(['keep', 'x1']);
    expect(await repository.pruneExpired(NOW, 0)).toBe(0);
    expect(await repository.pruneExpired(NOW, 100)).toBe(1);
    expect(await repository.pruneExpired(NOW, 100)).toBe(0);
  });

  it('is exposed by SqliteStorageProvider after init (not part of StorageProvider)', async () => {
    const dir = tempDir();
    const storage = new SqliteStorageProvider({ dbPath: join(dir, 'quoky.db') });
    await storage.init();
    try {
      expect(await storage.learning.insertWithinCap(item(), 1000, NOW)).toBe('INSERTED');
      expect(await storage.learning.get('actor-1', 'item-1', NOW)).toEqual(item());
    } finally {
      await storage.close();
    }
  });
});

describe('openLearningExportReader (ADR-0107 D4: read-only, never migrates)', () => {
  it('lists every actor\'s unexpired items of one kind, oldest first, without writing', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'quoky.db');
    const db = new Database(dbPath);
    runMigrations(db);
    const repository = new SqliteLearningRepository(db);
    await repository.insertWithinCap(item({ id: 'b', createdAt: '2026-10-05T00:00:00.000Z' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'a', actorId: 'actor-2', createdAt: '2026-10-04T00:00:00.000Z' }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'ex', kind: LearningItemKind.EXAMPLE }), 1000, NOW);
    await repository.insertWithinCap(item({ id: 'gone', expiresAt: '2026-10-06T00:00:00.000Z' }), 1000, '2026-10-01T00:00:00.000Z');
    db.close();

    const reader = openLearningExportReader(dbPath);
    try {
      expect(reader.listForExport(LearningItemKind.GOLDEN_CANDIDATE, NOW).map((i) => i.id)).toEqual(['a', 'b']);
    } finally {
      reader.close();
    }
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare('SELECT COUNT(*) AS n FROM learning_items').get() as { n: number }).n).toBe(4);
    check.close();
  });

  it('refuses a v13 database (LEARNING_SCHEMA_MISSING) and leaves it at 13 without the table', () => {
    const dbPath = join(tempDir(), 'v13.db');
    const db = new Database(dbPath);
    runMigrations(db, MIGRATIONS.slice(0, 13));
    db.close();
    expect(LEARNING_SCHEMA_VERSION).toBe(14);
    expect(() => openLearningExportReader(dbPath)).toThrow('LEARNING_SCHEMA_MISSING');
    const check = new Database(dbPath, { readonly: true });
    expect(Number(check.pragma('user_version', { simple: true }))).toBe(13);
    expect(check.prepare(`SELECT name FROM sqlite_master WHERE name = 'learning_items'`).all()).toEqual([]);
    check.close();
  });

  it('refuses a database ahead of this build and a missing file (never creating one)', () => {
    const dir = tempDir();
    const ahead = join(dir, 'ahead.db');
    const db = new Database(ahead);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openLearningExportReader(ahead)).toThrow('SCHEMA_VERSION_AHEAD');
    const missing = join(dir, 'missing.db');
    expect(() => openLearningExportReader(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
