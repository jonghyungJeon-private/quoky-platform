import { describe, expect, it } from 'vitest';
import { MemoryType, type Actor, type MemoryRecord } from '../../domain';
import { MEMORY_CONFIRM_PREVIEW_MAX_CHARS, memoryBody, memoryPreview, renderForgetConfirmation } from './memory-command-renderer';
import {
  createLearningItemsRemovalCascade,
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
      metadata: { role },
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
      turn('discord-owner', renderForgetConfirmation(2, memoryPreview(text, MEMORY_CONFIRM_PREVIEW_MAX_CHARS), 'AB2C', 'ko'), 'assistant'),
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

  it('matches the Discord-escaped and clipped renderings a memory-command reply echoed', async () => {
    const markdown = '회의 링크는 *중요* @here <비공개> 채널';
    const long = `긴 기억 ${'가나다라마바사 '.repeat(60)}끝`;
    const rows = [
      turn('discord-owner', `기억 1번:\n${memoryBody(markdown)}`, 'assistant'),
      turn('discord-owner', `1. ${memoryPreview(long)}\n2. 다른 기억`, 'assistant'),
      turn('discord-owner', `지금: ${memoryPreview(long, MEMORY_CONFIRM_PREVIEW_MAX_CHARS)}`, 'assistant'),
    ];
    const h = store(rows);
    await createShortTermHistoryRemovalCascade(h.deps).onMemoriesRemoved(event([markdown, long]));
    expect(h.rows).toEqual([]);
    // A clipped rendering contributes its kept part, not the ellipsis.
    expect(memoryHistoryNeedles([long]).every((needle) => !needle.endsWith('…'))).toBe(true);
    expect(historyTurnCarriesMemory({ content: '긴 기억 가나다' }, memoryHistoryNeedles([long]))).toBe(false);
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
