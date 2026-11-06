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

describe('SqliteMemoryRepository archive exclusion (ADR-0106 amendment)', () => {
  const archived = (id: string, archivedAt: string, archiveExpiresAt: string, scope: MemoryScope = { userId: 'actor-1' }) =>
    memory(id, scope, {
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        archivedAt,
        archiveExpiresAt,
      },
    });

  it('findByScope and the default durable query never return an archived record; get still does', async () => {
    const store = await freshStore();
    await store.memories.save(memory('live', { userId: 'actor-1' }));
    await store.memories.save(archived('gone', '2026-10-06T03:00:00.000Z', '2026-10-13T03:00:00.000Z'));

    expect((await store.memories.findByScope({ userId: 'actor-1' })).map(({ id }) => id)).toEqual(['live']);
    expect((await store.memories.findByScope({}, MemoryType.LONG_TERM)).map(({ id }) => id)).toEqual(['live']);
    const durable = (query: Partial<Parameters<typeof store.memories.findDurableCandidates>[0]> = {}) =>
      store.memories
        .findDurableCandidates({ scope: { userId: 'actor-1' }, limit: 10, ...query })
        .then((rows) => rows.map(({ id }) => id).sort());
    expect(await durable()).toEqual(['live']);
    expect(await durable({ archived: 'exclude', excludeExpired: true, excludeSuperseded: true })).toEqual(['live']);
    expect(await durable({ archived: 'only' })).toEqual(['gone']);
    expect(await durable({ archived: 'include' })).toEqual(['gone', 'live']);
    expect((await store.memories.get('gone'))?.metadata?.['archivedAt']).toBe('2026-10-06T03:00:00.000Z');
    await store.close();
  });

  it('archiveExpiredBy selects the archived records due at or before the instant, across actors', async () => {
    const store = await freshStore();
    await store.memories.save(archived('due-earlier', '2026-09-01T00:00:00.000Z', '2026-09-08T00:00:00.000Z'));
    await store.memories.save(archived('due-exactly', '2026-09-03T00:00:00.000Z', '2026-09-10T00:00:00.000Z', { userId: 'actor-2' }));
    await store.memories.save(archived('not-yet', '2026-09-05T00:00:00.000Z', '2026-09-12T00:00:00.000Z'));
    await store.memories.save(memory('live', { userId: 'actor-1' }));
    const due = await store.memories.findDurableCandidates({
      scope: {},
      limit: 10,
      archived: 'only',
      archiveExpiredBy: '2026-09-10T00:00:00.000Z',
    });
    expect(due.map(({ id }) => id).sort()).toEqual(['due-earlier', 'due-exactly']);
    await store.close();
  });

  it('a restored record (archive keys removed) is a live record again', async () => {
    const store = await freshStore();
    const record = archived('back', '2026-10-06T03:00:00.000Z', '2026-10-13T03:00:00.000Z');
    await store.memories.save(record);
    const metadata = { ...record.metadata };
    delete metadata['archivedAt'];
    delete metadata['archiveExpiresAt'];
    await store.memories.save({ ...record, metadata });
    expect((await store.memories.findByScope({ userId: 'actor-1' })).map(({ id }) => id)).toEqual(['back']);
    expect(await store.memories.findDurableCandidates({ scope: {}, limit: 10, archived: 'only' })).toEqual([]);
    await store.close();
  });
});

describe('SqliteMemoryRepository findDurableCandidatesByIds (ADR-0124 P2-2 candidate widening)', () => {
  const live = (id: string, scope: MemoryScope = { userId: 'actor-1' }, extra: Record<string, unknown> = {}) =>
    memory(id, scope, { metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT', ...extra } });

  it('applies exactly the filters of findDurableCandidates plus the id list', async () => {
    const store = await freshStore();
    for (const record of [
      live('ok'),
      live('archived', { userId: 'actor-1' }, { archivedAt: '2026-10-01T00:00:00.000Z' }),
      live('expired', { userId: 'actor-1' }, { expiresAt: '2000-01-01T00:00:00.000Z' }),
      live('superseded', { userId: 'actor-1' }, { supersededBy: 'next' }),
      live('foreign', { userId: 'actor-2' }),
      live('other-session', { userId: 'actor-1', sessionId: 'other' }),
      live('not-asked'),
      memory('short-term', { userId: 'actor-1' }, { type: MemoryType.SHORT_TERM }),
    ]) {
      await store.memories.save(record);
    }
    const asked = ['ok', 'archived', 'expired', 'superseded', 'foreign', 'short-term', 'ghost'];
    const filter = { scope: { userId: 'actor-1' }, excludeExpired: true, excludeSuperseded: true, archived: 'exclude' as const };
    const byIds = await store.memories.findDurableCandidatesByIds!({ ...filter, ids: asked });
    expect(byIds.map(({ id }) => id)).toEqual(['ok']);
    // the same answer as the recent-pool read narrowed to those ids: one filter implementation, two entry points
    const pool = await store.memories.findDurableCandidates({ ...filter, limit: 50 });
    expect(pool.map(({ id }) => id).filter((id) => asked.includes(id))).toEqual(['ok']);
    // session scope narrows exactly as in the pool read
    const scoped = await store.memories.findDurableCandidatesByIds!({ ...filter, scope: { userId: 'actor-1', sessionId: 'other' }, ids: ['ok', 'other-session'] });
    expect(scoped.map(({ id }) => id)).toEqual(['other-session']);
    expect(await store.memories.findDurableCandidatesByIds!({ ...filter, ids: [] })).toEqual([]);
    await store.close();
  });

  it('honours excludeIds and returns an old record that the recent pool cap would miss', async () => {
    const store = await freshStore();
    await store.memories.save(live('old', { userId: 'actor-1' }));
    for (let at = 0; at < 5; at += 1) {
      await store.memories.save(memory(`new-${at}`, { userId: 'actor-1' }, { updatedAt: `2026-10-0${at + 1}T00:00:00.000Z` }));
    }
    const filter = { scope: { userId: 'actor-1' }, excludeExpired: true, excludeSuperseded: true, archived: 'exclude' as const };
    expect((await store.memories.findDurableCandidates({ ...filter, limit: 3 })).map(({ id }) => id)).not.toContain('old');
    expect((await store.memories.findDurableCandidatesByIds!({ ...filter, ids: ['old'] })).map(({ id }) => id)).toEqual(['old']);
    expect(await store.memories.findDurableCandidatesByIds!({ ...filter, excludeIds: ['old'], ids: ['old'] })).toEqual([]);
    await store.close();
  });
});

