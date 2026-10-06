import { describe, expect, it } from 'vitest';
import { MAX_SESSION_SHORT_TERM, MemoryManager } from './memory-manager';
import { MemoryType } from '../domain';
import type { MemoryRecord, MemoryScope } from '../domain';
import type { StorageProvider, VectorProvider } from '../ports';

function fakeStorage() {
  const mem: MemoryRecord[] = [];
  const memories = {
    async save(r: MemoryRecord) {
      const i = mem.findIndex((m) => m.id === r.id);
      if (i >= 0) mem[i] = r;
      else mem.push(r);
      return r;
    },
    async findByScope(scope: MemoryScope, type?: MemoryType) {
      return mem.filter(
        (r) =>
          (type === undefined || r.type === type) &&
          (scope.sessionId === undefined || r.scope.sessionId === scope.sessionId) &&
          (scope.projectId === undefined || r.scope.projectId === scope.projectId) &&
          (scope.channelId === undefined || r.scope.channelId === scope.channelId),
      );
    },
    async get(id: string) {
      return mem.find((record) => record.id === id) ?? null;
    },
    async delete(id: string) {
      const i = mem.findIndex((m) => m.id === id);
      if (i >= 0) mem.splice(i, 1);
    },
    async list() {
      return mem;
    },
  };
  return { storage: { memories } as unknown as StorageProvider, mem };
}

const ctx = { platform: 'discord', channelId: 'c', userId: 'u' };
const msg = (id: string, text: string) => ({ id, context: ctx, text, receivedAt: '' });

describe('MemoryManager short-term memory (ADR-0017)', () => {
  it('records user + assistant turns scoped by session, with role metadata', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    await mm.recordShortTerm(msg('m1', '안녕'), 'S1');
    await mm.recordAssistant('저는 춘식이', ctx, 'S1');
    expect(mem).toHaveLength(2);
    expect(mem[0]).toMatchObject({ content: '안녕', scope: { sessionId: 'S1' }, metadata: { role: 'user' } });
    expect(mem[1]).toMatchObject({ content: '저는 춘식이', metadata: { role: 'assistant' } });
  });

  it('recentShortTerm isolates sessions and orders oldest→newest', async () => {
    const { storage } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    await mm.recordShortTerm(msg('a', 'first'), 'S1');
    await mm.recordAssistant('reply', ctx, 'S1');
    await mm.recordShortTerm(msg('b', 'other'), 'S2');
    expect((await mm.recentShortTerm({ sessionId: 'S1' }, 10)).map((r) => r.content)).toEqual(['first', 'reply']);
    expect((await mm.recentShortTerm({ sessionId: 'S2' }, 10)).map((r) => r.content)).toEqual(['other']);
  });

  it('selects the newest records by creation time before restoring oldest→newest context order', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    for (let i = 0; i < 12; i += 1) {
      mem.push({
        id: `m-${i}`,
        type: MemoryType.SHORT_TERM,
        scope: { sessionId: 'S1' },
        content: `turn-${i}`,
        metadata: { role: 'user' },
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    mem.reverse();

    expect((await mm.recentShortTerm({ sessionId: 'S1' }, 3)).map((r) => r.content)).toEqual([
      'turn-9',
      'turn-10',
      'turn-11',
    ]);
  });

  it('uses repository persistence order as the stable tie-break for legacy equal timestamps', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    for (let i = 0; i < 12; i += 1) {
      mem.push({
        id: `legacy-${i}`,
        type: MemoryType.SHORT_TERM,
        scope: { sessionId: 'S1' },
        content: `legacy-turn-${i}`,
        metadata: { role: i % 2 === 0 ? 'user' : 'assistant' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    expect((await mm.recentShortTerm({ sessionId: 'S1' }, 3)).map((r) => r.content)).toEqual([
      'legacy-turn-9',
      'legacy-turn-10',
      'legacy-turn-11',
    ]);
  });

  it('assigns strictly increasing creation times to immediately persisted turns', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    await mm.recordShortTerm(msg('a', 'immediately previous'), 'S1');
    await mm.recordShortTerm(msg('b', 'current'), 'S1');

    expect(mem[1]!.createdAt > mem[0]!.createdAt).toBe(true);
    expect((await mm.recentShortTerm({ sessionId: 'S1' }, 1))[0]?.content).toBe('current');
  });

  it(`prunes a session to the newest ${MAX_SESSION_SHORT_TERM} SHORT_TERM memories`, async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    for (let i = 0; i < MAX_SESSION_SHORT_TERM + 5; i += 1) {
      await mm.recordShortTerm(msg(`m${i}`, `msg-${i}`), 'S1');
    }
    expect(mem).toHaveLength(MAX_SESSION_SHORT_TERM);
    // Oldest 5 pruned; newest retained.
    expect(mem.some((r) => r.content === 'msg-0')).toBe(false);
    expect(mem.some((r) => r.content === `msg-${MAX_SESSION_SHORT_TERM + 4}`)).toBe(true);
  });

  it('never stores a provider id in memory', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    await mm.recordAssistant('x', ctx, 'S1');
    expect(JSON.stringify(mem[0])).not.toContain('providerId');
  });
});

describe('MemoryManager project memory (ADR-0018)', () => {
  it('records and reads back PROJECT memory scoped by projectId', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    await mm.recordProjectMemory('# Project: demo', { projectId: 'P1', sessionId: 'S1' });
    expect(mem[0]).toMatchObject({ type: MemoryType.PROJECT, scope: { projectId: 'P1', sessionId: 'S1' } });
    const latest = await mm.projectMemory('P1');
    expect(latest?.content).toBe('# Project: demo');
    expect(await mm.projectMemory('P2')).toBeUndefined();
  });
});

describe('MemoryManager durable persistence boundary (ADR-0073)', () => {
  it('owns exact durable save, scoped read, lookup, and forget operations', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    const record: MemoryRecord = {
      id: 'durable-1',
      type: MemoryType.LONG_TERM,
      scope: { userId: 'actor-1' },
      content: 'Prefer concise updates.',
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
      },
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };

    await expect(mm.saveDurable(record)).resolves.toBe(record);
    await expect(mm.durableMemories({ userId: 'actor-1' })).resolves.toEqual([record]);
    await expect(mm.durableMemory(record.id)).resolves.toBe(record);
    await mm.forgetDurable(record.id);
    expect(mem).toEqual([]);
  });

  it('refuses non-durable writes on the durable persistence path', async () => {
    const { storage } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    const shortTerm: MemoryRecord = {
      id: 'short-1',
      type: MemoryType.SHORT_TERM,
      scope: { sessionId: 'session-1' },
      content: 'transcript',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };

    await expect(mm.saveDurable(shortTerm)).rejects.toThrow(
      'saveDurable accepts LONG_TERM memory only',
    );
  });
});

describe('MemoryManager short-term turn ownership and fail-closed removal (ADR-0106 D5)', () => {
  it('records the platform with each turn, and deleteShortTerm removes only a SHORT_TERM turn', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    const user = await mm.recordShortTerm(msg('m1', '기억 1 수정: 비밀'), 'S1');
    await mm.recordAssistant('답', ctx, 'S1');
    expect(mem.map((record) => record.metadata?.['platform'])).toEqual(['discord', 'discord']);
    const durable = await mm.saveDurable({
      id: 'durable-1',
      type: MemoryType.LONG_TERM,
      scope: { userId: 'u' },
      content: '장기 기억',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    });
    await mm.deleteShortTerm(user.id);
    await mm.deleteShortTerm(durable.id); // not a conversation turn: left alone
    await mm.deleteShortTerm('absent');
    expect(mem.map((record) => record.content)).toEqual(['답', '장기 기억']);
  });
});

describe('MemoryManager write-time history redaction (ADR-0106 D5, fix loop 2)', () => {
  it('stores a memory-edit request with its text withheld at write time; other turns verbatim', async () => {
    const { storage, mem } = fakeStorage();
    const mm = new MemoryManager(storage, {} as VectorProvider);
    await mm.recordShortTerm(msg('m1', '기억 1 수정: const dbPassword = "synthetic-value"'), 'S1');
    await mm.recordShortTerm(msg('m2', 'edit memory 2: my new secret text'), 'S1');
    await mm.recordShortTerm(msg('m3', '기억 목록'), 'S1');
    await mm.recordShortTerm(msg('m4', '오늘 날씨 어때?'), 'S1');
    expect(mem.map((record) => record.content)).toEqual([
      '기억 1 수정: (내용은 대화 기록에 남기지 않아요)',
      'edit memory 2: (text not kept in the conversation history)',
      '기억 목록',
      '오늘 날씨 어때?',
    ]);
  });
});
