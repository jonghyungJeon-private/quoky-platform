import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryType, type MemoryRecord, type MemoryScope } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function freshStore(): Promise<SqliteStorageProvider> {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-memory-repository-'));
  dirs.push(dir);
  const store = new SqliteStorageProvider({ dbPath: join(dir, 'chunsik.db') });
  await store.init();
  return store;
}

function memory(
  id: string,
  scope: MemoryScope,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    type: MemoryType.LONG_TERM,
    scope,
    content: id,
    metadata: {
      kind: 'SEMANTIC',
      provenance: 'USER_PROVIDED',
      authorityLevel: 'USER_CLAIM_OR_INTENT',
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteMemoryRepository durable candidates', () => {
  it('filters userId from persisted JSON and excludes other users', async () => {
    const store = await freshStore();
    await store.memories.save(memory('user-1', { userId: 'actor-1' }));
    await store.memories.save(memory('user-2', { userId: 'actor-2' }));

    const results = await store.memories.findDurableCandidates({
      scope: { userId: 'actor-1' },
      limit: 10,
    });
    expect(results.map(({ id }) => id)).toEqual(['user-1']);
    await store.close();
  });

  it('excludes expired and superseded rows when requested', async () => {
    const store = await freshStore();
    await store.memories.save(memory('active', { sessionId: 'session-1' }));
    await store.memories.save(
      memory('expired', { sessionId: 'session-1' }, {
        metadata: {
          kind: 'SEMANTIC',
          provenance: 'USER_PROVIDED',
          authorityLevel: 'USER_CLAIM_OR_INTENT',
          expiresAt: '2000-01-01T00:00:00.000Z',
        },
      }),
    );
    await store.memories.save(
      memory('superseded', { sessionId: 'session-1' }, {
        metadata: {
          kind: 'SEMANTIC',
          provenance: 'USER_PROVIDED',
          authorityLevel: 'USER_CLAIM_OR_INTENT',
          supersededBy: 'active',
        },
      }),
    );

    const results = await store.memories.findDurableCandidates({
      scope: { sessionId: 'session-1' },
      limit: 10,
      excludeExpired: true,
      excludeSuperseded: true,
    });
    expect(results.map(({ id }) => id)).toEqual(['active']);
    await store.close();
  });

  it('enforces limit and LONG_TERM type', async () => {
    const store = await freshStore();
    await store.memories.save(memory('long-1', { sessionId: 'session-1' }));
    await store.memories.save(memory('long-2', { sessionId: 'session-1' }));
    await store.memories.save(
      memory('short', { sessionId: 'session-1' }, { type: MemoryType.SHORT_TERM }),
    );

    const results = await store.memories.findDurableCandidates({
      scope: { sessionId: 'session-1' },
      limit: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe(MemoryType.LONG_TERM);
    await store.close();
  });

  it('requires every supplied session and project scope key', async () => {
    const store = await freshStore();
    await store.memories.save(
      memory('matching', { sessionId: 'session-1', projectId: 'project-1' }),
    );
    await store.memories.save(
      memory('wrong-project', { sessionId: 'session-1', projectId: 'project-2' }),
    );
    await store.memories.save(
      memory('wrong-session', { sessionId: 'session-2', projectId: 'project-1' }),
    );

    const results = await store.memories.findDurableCandidates({
      scope: { sessionId: 'session-1', projectId: 'project-1' },
      limit: 10,
    });
    expect(results.map(({ id }) => id)).toEqual(['matching']);
    await store.close();
  });

  it('preserves legacy findByScope semantics by ignoring userId and taskId', async () => {
    const store = await freshStore();
    await store.memories.save(memory('wanted', { userId: 'actor-1', taskId: 'task-1' }));
    await store.memories.save(memory('other-user', { userId: 'actor-2', taskId: 'task-1' }));
    await store.memories.save(memory('other-task', { userId: 'actor-1', taskId: 'task-2' }));

    const results = await store.memories.findByScope(
      { userId: 'actor-1', taskId: 'task-1' },
      MemoryType.LONG_TERM,
    );
    expect(results.map(({ id }) => id)).toEqual(['wanted', 'other-user', 'other-task']);
    await store.close();
  });
});

describe('SqliteMemoryRepository short-term history by user (W2-L01)', () => {
  it('returns only the user\'s SHORT_TERM turns, oldest first, across sessions', async () => {
    const store = await freshStore();
    const turn = (id: string, userId: string, sessionId: string, createdAt: string): MemoryRecord => ({
      id,
      type: MemoryType.SHORT_TERM,
      scope: { userId, channelId: 'channel-1', sessionId },
      content: id,
      metadata: { role: 'user' },
      createdAt,
      updatedAt: createdAt,
    });
    await store.memories.save(turn('later', 'user-1', 'session-2', '2026-08-02T00:00:00.000Z'));
    await store.memories.save(turn('earlier', 'user-1', 'session-1', '2026-08-01T00:00:00.000Z'));
    await store.memories.save(turn('foreign', 'user-2', 'session-1', '2026-08-01T00:00:01.000Z'));
    // A durable record scoped to the same id string is not conversation history.
    await store.memories.save(memory('durable', { userId: 'user-1' }));

    expect((await store.memories.findShortTermByUser('user-1')).map(({ id }) => id)).toEqual(['earlier', 'later']);
    expect((await store.memories.findShortTermByUser('user-2')).map(({ id }) => id)).toEqual(['foreign']);
    expect(await store.memories.findShortTermByUser('nobody')).toEqual([]);
    await store.close();
  });
});
