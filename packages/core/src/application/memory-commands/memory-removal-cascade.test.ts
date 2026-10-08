import { describe, expect, it } from 'vitest';
import { MemoryType, SessionStatus, type Actor, type MemoryRecord, type Session } from '../../domain';
import { MEMORY_CONFIRM_PREVIEW_MAX_CHARS, memoryBody, memoryPreview, renderForgetConfirmation } from './memory-command-renderer';
import { plainTextOf } from '../message-rendering';
import {
  createLearningItemsRemovalCascade,
  createSessionHistoryClearer,
  createShortTermHistoryRemovalCascade,
  historyTurnCarriesMemory,
  memoryHistoryNeedles,
  type MemoryRemovalEvent,
} from './memory-removal-cascade';

describe('createLearningItemsRemovalCascade (ADR-0106 D5, ADR-0107 D7)', () => {
  const recording = () => {
    const calls: Array<readonly [string, string]> = [];
    return {
      calls,
      learning: {
        async deleteBySourceMemory(actorId: string, memoryId: string): Promise<number> {
          calls.push([actorId, memoryId]);
          return 0;
        },
      },
    };
  };

  it('deletes the learning items derived from every removed memory id, scoped to the event actor', async () => {
    const { calls, learning } = recording();
    const cascade = createLearningItemsRemovalCascade(learning);
    expect(cascade.id).toBe('learning-items');
    await cascade.onMemoriesRemoved({ actorId: 'actor-1', reason: 'forget', memoryIds: ['m1', 'm0', 'm1'], vectorIds: ['v9'], contents: [] });
    // Each memory id once (deduplicated); vector ids are not memory ids and are never used as a learning source.
    expect(calls).toEqual([
      ['actor-1', 'm1'],
      ['actor-1', 'm0'],
    ]);
  });

  it('also runs for an edit (the superseded record leaves recall) and is a no-op for an empty event', async () => {
    const { calls, learning } = recording();
    const cascade = createLearningItemsRemovalCascade(learning);
    await cascade.onMemoriesRemoved({ actorId: 'actor-2', reason: 'edit', memoryIds: ['old'], vectorIds: [], contents: [] });
    await cascade.onMemoriesRemoved({ actorId: 'actor-2', reason: 'forget', memoryIds: [], vectorIds: [], contents: [] });
    expect(calls).toEqual([['actor-2', 'old']]);
  });

  it('propagates a store failure so the forget aborts before the memory is deleted', async () => {
    const cascade = createLearningItemsRemovalCascade({
      deleteBySourceMemory: async () => {
        throw new Error('disk');
      },
    });
    await expect(
      cascade.onMemoriesRemoved({ actorId: 'a', reason: 'forget', memoryIds: ['m'], vectorIds: [], contents: [] }),
    ).rejects.toThrow('disk');
  });
});

describe('createShortTermHistoryRemovalCascade (ADR-0106 D5, W2-L01)', () => {
  const OWNER: Actor = {
    id: 'actor-1',
    displayName: 'owner',
    identities: [{ platform: 'discord', externalId: 'discord-owner' }],
    createdAt: '2026-10-06T00:00:00.000Z',
  };
  let seq = 0;
  const turn = (userId: string, content: string, role: 'user' | 'assistant' = 'user'): MemoryRecord => {
    seq += 1;
    const at = new Date(Date.UTC(2026, 9, 6, 0, 0, seq)).toISOString();
    return {
      id: `turn-${seq}`,
      type: MemoryType.SHORT_TERM,
      scope: { userId, channelId: 'channel-1', sessionId: 'session-1' },
      content,
      metadata: { role, platform: userId.startsWith('tg-') ? 'telegram' : 'discord' },
      createdAt: at,
      updatedAt: at,
    };
  };
  const store = (initial: MemoryRecord[], actors: Actor[] = [OWNER]) => {
    const rows = [...initial];
    const reads: string[] = [];
    return {
      rows,
      reads,
      deps: {
        actors: { get: async (id: string) => actors.find((actor) => actor.id === id) ?? null },
        sessions: { get: async () => null },
        history: {
          findShortTermByUser: async (userId: string) => {
            reads.push(userId);
            return rows.filter((row) => row.type === MemoryType.SHORT_TERM && row.scope.userId === userId);
          },
          delete: async (id: string) => {
            const index = rows.findIndex((row) => row.id === id);
            if (index >= 0) rows.splice(index, 1);
          },
        },
      },
    };
  };
  const event = (contents: string[], reason: 'forget' | 'edit' = 'forget'): MemoryRemovalEvent => ({
    actorId: OWNER.id,
    reason,
    memoryIds: contents.map((_, index) => `m${index}`),
    vectorIds: [],
    contents,
  });

  it('deletes only the owner\'s turns that carry the text (normalized), keeping the rest of the session', async () => {
    const text = '내가 제일 좋아하는 커피는 아이스 아메리카노야';
    const kept = [
      turn('discord-owner', '내가 좋아하는 커피가 뭐였지?'),
      turn('discord-owner', '오늘 회의 몇 시야?'),
      turn('discord-owner', '기억 2 잊어줘'),
      // Another user in the same session saying the same thing: never read through the owner, never touched.
      turn('discord-other', `${text} 나도`),
    ];
    const carrying = [
      turn('discord-owner', `기억해: ${text}`),
      // NFD and a line break: the same text after NFC + whitespace collapsing.
      turn('discord-owner', `참고로 내가 제일 좋아하는\n  커피는 아이스 아메리카노야`.normalize('NFD')),
      turn('discord-owner', plainTextOf(renderForgetConfirmation(2, memoryPreview(text, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'AB2C', 'ko')), 'assistant'),
    ];
    const h = store([...kept, ...carrying]);
    const cascade = createShortTermHistoryRemovalCascade(h.deps);
    expect(cascade.id).toBe('short-term-history');
    await cascade.onMemoriesRemoved(event([text]));
    expect(h.rows.map((row) => row.id)).toEqual(kept.map((row) => row.id));
    expect(h.reads).toEqual(['discord-owner']);
    // Idempotent: a retry finds nothing more to delete.
    await cascade.onMemoriesRemoved(event([text]));
    expect(h.rows).toHaveLength(kept.length);
  });

  it('matches the plain and clipped renderings a memory-command reply echoed', async () => {
    const markdown = '회의 링크는 *중요* @here <비공개> 채널';
    const long = `긴 기억 ${'가나다라마바사 '.repeat(60)}끝`;
    const rows = [
      turn('discord-owner', `기억 1번:\n${plainTextOf(memoryBody(markdown))}`, 'assistant'),
      turn('discord-owner', `1. ${plainTextOf(memoryPreview(long))}\n2. 다른 기억`, 'assistant'),
      turn('discord-owner', `지금: ${plainTextOf(memoryPreview(long, MEMORY_CONFIRM_PREVIEW_MAX_CHARS))}`, 'assistant'),
    ];
    const h = store(rows);
    await createShortTermHistoryRemovalCascade(h.deps).onMemoriesRemoved(event([markdown, long]));
    expect(h.rows).toEqual([]);
    // A clipped rendering contributes its kept part, not the ellipsis.
    expect(memoryHistoryNeedles([long]).every((needle) => !needle.endsWith('…'))).toBe(true);
    expect(historyTurnCarriesMemory({ content: '긴 기억 가나다' }, memoryHistoryNeedles([long]))).toBe(false);
  });

  it('still matches a turn recorded before PLT-0, which kept the reply as delivered (backslash escapes, zero-width spaces)', async () => {
    const markdown = '회의 링크는 *중요* @here <비공개> \\채널_1';
    const rows = [
      // Exactly what the history kept before platform-neutral rendering: the Discord-escaped body.
      turn('discord-owner', '기억 1번:\n회의 링크는 \\*중요\\* @\u200bhere <\u200b비공개\\> \\\\채널\\_1', 'assistant'),
      turn('discord-owner', '이 기억을 잊었어요:\n> 회의 링크는 \\*중요\\* @\u200bhere <\u200b비공개\\> \\\\채널\\_1', 'assistant'),
      turn('discord-owner', '다른 이야기: 회의 링크는 중요해요'),
    ];
    const h = store(rows);
    await createShortTermHistoryRemovalCascade(h.deps).onMemoriesRemoved(event([markdown]));
    expect(h.rows.map((row) => row.content)).toEqual(['다른 이야기: 회의 링크는 중요해요']);
  });

  it('covers every identity of the actor and nobody else; an unknown actor or empty event reads nothing', async () => {
    const twoIdentities: Actor = { ...OWNER, identities: [...OWNER.identities, { platform: 'telegram', externalId: 'tg-owner' }] };
    const h = store(
      [turn('discord-owner', '비밀 메모'), turn('tg-owner', '비밀 메모 맞지?'), turn('discord-other', '비밀 메모')],
      [twoIdentities],
    );
    const cascade = createShortTermHistoryRemovalCascade(h.deps);
    await cascade.onMemoriesRemoved(event([]));
    await cascade.onMemoriesRemoved({ ...event(['비밀 메모']), actorId: 'actor-unknown' });
    expect(h.reads).toEqual([]);
    await cascade.onMemoriesRemoved(event(['비밀 메모'], 'edit'));
    expect(h.reads).toEqual(['discord-owner', 'tg-owner']);
    expect(h.rows.map((row) => row.scope.userId)).toEqual(['discord-other']);
  });

  it('propagates a store failure so the forget stops before the memory is deleted (retryable)', async () => {
    const h = store([turn('discord-owner', '지울 내용')]);
    const cascade = createShortTermHistoryRemovalCascade({
      ...h.deps,
      history: { ...h.deps.history, delete: async () => Promise.reject(new Error('disk')) },
    });
    await expect(cascade.onMemoriesRemoved(event(['지울 내용']))).rejects.toThrow('disk');
  });
});

describe('createSessionHistoryClearer (ADR-0106 amendment D5)', () => {
  const OWNER: Actor = {
    id: 'actor-1',
    displayName: 'owner',
    identities: [
      { platform: 'discord', externalId: 'discord-owner' },
      { platform: 'slack', externalId: 'slack-owner' },
    ],
    createdAt: '2026-10-06T00:00:00.000Z',
  };
  const turn = (
    id: string,
    userId: string,
    sessionId: string,
    type = MemoryType.SHORT_TERM,
    platform?: string,
  ): MemoryRecord => ({
    id,
    type,
    scope: { userId, channelId: 'channel-1', sessionId },
    content: `${id} 내용`,
    // No platform = a turn recorded before turns carried it: derived from its session record.
    metadata: { role: 'assistant', ...(platform === undefined ? {} : { platform }) },
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  });

  const session = (id: string, platform: string): Session => ({
    id,
    actorId: 'whoever',
    context: { platform, channelId: 'channel-1', userId: 'whoever' },
    status: SessionStatus.ACTIVE,
    createdAt: '2026-10-06T00:00:00.000Z',
    lastActivityAt: '2026-10-06T00:00:00.000Z',
  });

  it("deletes only the actor's own short-term turns of that session (both roles), never another user's or session's", async () => {
    const rows: MemoryRecord[] = [
      turn('mine-1', 'discord-owner', 'session-1'),
      turn('mine-2', 'slack-owner', 'session-1', MemoryType.SHORT_TERM, 'slack'),
      turn('other-user', 'discord-other', 'session-1'),
      turn('other-session', 'discord-owner', 'session-2'),
      turn('durable', 'discord-owner', 'session-1', MemoryType.LONG_TERM),
    ];
    const clearer = createSessionHistoryClearer({
      actors: { get: async (id) => (id === OWNER.id ? OWNER : null) },
      sessions: { get: async (id) => session(id, 'discord') },
      history: {
        findByScope: async (scope, type) =>
          rows.filter((row) => row.scope.sessionId === scope.sessionId && (type === undefined || row.type === type)),
        delete: async (id) => {
          const index = rows.findIndex((row) => row.id === id);
          if (index >= 0) rows.splice(index, 1);
        },
      },
    });
    expect(await clearer.clearSession('actor-1', 'session-1')).toBe(2);
    expect(rows.map((row) => row.id)).toEqual(['other-user', 'other-session', 'durable']);
    // Idempotent; an unknown actor touches nothing.
    expect(await clearer.clearSession('actor-1', 'session-1')).toBe(0);
    expect(await clearer.clearSession('actor-x', 'session-2')).toBe(0);
    expect(rows).toHaveLength(3);
  });
});

describe('history ownership is (platform, user id) — fix loop 1 (ADR-0106 D5)', () => {
  // Two actors that share the numeric user id 123 on two platforms.
  const A: Actor = { id: 'actor-a', displayName: 'a', identities: [{ platform: 'discord', externalId: '123' }], createdAt: '2026-10-06T00:00:00.000Z' };
  const B: Actor = { id: 'actor-b', displayName: 'b', identities: [{ platform: 'telegram', externalId: '123' }], createdAt: '2026-10-06T00:00:00.000Z' };
  const session = (id: string, platform: string): Session => ({
    id,
    actorId: 'whoever',
    context: { platform, channelId: `channel-${id}`, userId: '123' },
    status: SessionStatus.ACTIVE,
    createdAt: '2026-10-06T00:00:00.000Z',
    lastActivityAt: '2026-10-06T00:00:00.000Z',
  });
  const SESSIONS: Record<string, Session> = { 's-discord': session('s-discord', 'discord'), 's-telegram': session('s-telegram', 'telegram') };
  const turn = (id: string, sessionId: string | undefined, platform?: string): MemoryRecord => ({
    id,
    type: MemoryType.SHORT_TERM,
    scope: { userId: '123', channelId: 'c', ...(sessionId === undefined ? {} : { sessionId }) },
    content: '공유 비밀 메모',
    metadata: { role: 'user', ...(platform === undefined ? {} : { platform }) },
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  });
  const fixture = () => {
    const rows: MemoryRecord[] = [
      turn('a-new', 's-discord', 'discord'),
      turn('b-new', 's-telegram', 'telegram'),
      turn('a-legacy', 's-discord'), // platform derived from the session record
      turn('b-legacy', 's-telegram'),
      turn('orphan-legacy', undefined), // no platform, no session: nobody's (left alone)
    ];
    const history = {
      findShortTermByUser: async (userId: string) => rows.filter((row) => row.scope.userId === userId),
      findByScope: async (scope: { sessionId?: string }) => rows.filter((row) => row.scope.sessionId === scope.sessionId),
      delete: async (id: string) => {
        const index = rows.findIndex((row) => row.id === id);
        if (index >= 0) rows.splice(index, 1);
      },
    };
    const deps = {
      actors: { get: async (id: string) => [A, B].find((actor) => actor.id === id) ?? null },
      sessions: { get: async (id: string) => SESSIONS[id] ?? null },
      history,
    };
    return { rows, deps };
  };

  it("A's forget never deletes B's history even though both are user 123", async () => {
    const { rows, deps } = fixture();
    await createShortTermHistoryRemovalCascade(deps).onMemoriesRemoved({
      actorId: 'actor-a',
      reason: 'forget',
      memoryIds: ['m'],
      vectorIds: [],
      contents: ['공유 비밀 메모'],
    });
    expect(rows.map((row) => row.id)).toEqual(['b-new', 'b-legacy', 'orphan-legacy']);
  });

  it("clearing A's session leaves B's turns, and B clearing a Discord session touches nothing", async () => {
    const { rows, deps } = fixture();
    const clearer = createSessionHistoryClearer(deps);
    expect(await clearer.clearSession('actor-b', 's-discord')).toBe(0);
    expect(await clearer.clearSession('actor-a', 's-discord')).toBe(2);
    expect(rows.map((row) => row.id)).toEqual(['b-new', 'b-legacy', 'orphan-legacy']);
  });
});
