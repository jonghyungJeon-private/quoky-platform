import { describe, expect, it, vi } from 'vitest';
import { Capability, MemoryType, createMemoryRetrievalRequest } from '../../domain';
import type { MemoryRecord, MemoryScope } from '../../domain';
import type { DurableMemoryQuery, MemoryRepository } from '../../ports';
import { DefaultMemoryRetriever } from '../memory-retriever';
import { DefaultMemoryWriter } from '../memory-writer';
import { parseMemoryCommand } from './memory-command-grammar';
import {
  MEMORY_CONFIRMATION_WINDOW_MS,
  MemoryCommandService,
  deriveMemoryConfirmationCode,
  isListableMemory,
  memoryConfirmationWindow,
  type MemoryCommandResult,
} from './memory-command-service';
import { createVectorRemovalCascade, type MemoryRemovalCascade, type MemoryRemovalEvent } from './memory-removal-cascade';

const OWNER = 'actor-owner';
const OTHER = 'actor-other';
const NOW = '2026-10-06T03:00:00.000Z';

function at(offsetMs: number): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

let seq = 0;
function memory(content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1;
  const createdAt = new Date(Date.parse('2026-09-01T00:00:00.000Z') + seq * 60_000).toISOString();
  return {
    id: `memory-${String(seq).padStart(3, '0')}`,
    type: MemoryType.LONG_TERM,
    scope: { userId: OWNER, sessionId: 'session-1' },
    content,
    metadata: {
      kind: 'SEMANTIC',
      provenance: 'USER_PROVIDED',
      authorityLevel: 'USER_CLAIM_OR_INTENT',
      sourceContent: `기억해: ${content}`,
      trigger: 'EXPLICIT_USER_INSTRUCTION',
    },
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function scopeMatches(record: MemoryRecord, scope: MemoryScope): boolean {
  return (Object.keys(scope) as Array<keyof MemoryScope>).every(
    (key) => scope[key] === undefined || record.scope[key] === scope[key],
  );
}

/** An in-memory memory repository with the SQLite query's filter semantics, shared by the writer and the service. */
function harness(initial: MemoryRecord[], options: { cascades?: MemoryRemovalCascade[] } = {}) {
  const records = [...initial];
  const repository: MemoryRepository = {
    get: async (id) => records.find((record) => record.id === id) ?? null,
    save: async (record) => {
      const index = records.findIndex((existing) => existing.id === record.id);
      if (index >= 0) records[index] = record;
      else records.push(record);
      return record;
    },
    delete: async (id) => {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) records.splice(index, 1);
    },
    list: async () => [...records],
    findByScope: async (scope, type) =>
      records.filter((record) => (type === undefined || record.type === type) && scopeMatches(record, scope)),
    findDurableCandidates: async (query: DurableMemoryQuery) =>
      records
        .filter(
          (record) =>
            record.type === MemoryType.LONG_TERM &&
            scopeMatches(record, query.scope) &&
            !(query.excludeIds ?? []).includes(record.id) &&
            !(query.excludeSuperseded && record.metadata?.['supersededBy'] !== undefined),
        )
        .slice(0, query.limit),
    findShortTermByUser: async (userId) =>
      records.filter((record) => record.type === MemoryType.SHORT_TERM && record.scope.userId === userId),
  };
  const writer = new DefaultMemoryWriter({
    durableMemory: (id) => repository.get(id),
    durableMemories: (scope) => repository.findByScope(scope, MemoryType.LONG_TERM),
    saveDurable: (record) => repository.save(record),
    forgetDurable: (id) => repository.delete(id),
  });
  const deleted: string[][] = [];
  const vectors = { delete: vi.fn(async (_collection: string, ids: string[]) => void deleted.push(ids)) };
  const logs: string[] = [];
  const logger = {
    info: (message: string, fields?: object) => void logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    warn: (message: string, fields?: object) => void logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    error: (message: string, fields?: object) => void logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  };
  const service = new MemoryCommandService({
    records: repository,
    writer,
    cascades: options.cascades ?? [createVectorRemovalCascade(vectors)],
    logger,
  });
  const run = async (text: string, now = NOW, actorId = OWNER): Promise<MemoryCommandResult> => {
    const command = parseMemoryCommand(text);
    if (command === null) throw new Error(`not a memory command: ${text}`);
    return service.execute(command, { actorId, now, sourceText: text });
  };
  return { records, repository, service, run, vectors, deleted, logs };
}

function codeOf(result: MemoryCommandResult): string {
  const match = /(?:기억 확인|confirm memory) ([A-Z0-9]{4})/.exec(result.text);
  if (!match?.[1]) throw new Error(`no code in: ${result.text}`);
  return match[1];
}

/** Any code that differs from `code` (same alphabet). */
function wrongCode(code: string): string {
  return code === 'AAAA' ? 'BBBB' : 'AAAA';
}

async function lexicalRecall(repository: MemoryRepository, query: string): Promise<string[]> {
  const retriever = new DefaultMemoryRetriever(repository, { clock: () => NOW });
  const results = await retriever.retrieve(
    createMemoryRetrievalRequest({
      query,
      capability: Capability.GENERAL_CHAT,
      scope: { actorId: OWNER },
      authorityFitness: ['USER_CLAIM_OR_INTENT'],
      maxResults: 10,
    }),
  );
  return results.map((result) => result.memory.content);
}

describe('MemoryCommandService — list and view (ADR-0106 D3)', () => {
  it('lists only the owner\'s eligible durable memories, numbered by creation time, with an empty-state reply', async () => {
    // Created first, inserted later: numbering follows `createdAt`, never repository order.
    const coffee = memory('커피는 아메리카노');
    const birthday = memory('생일은 5월 3일');
    const h = harness([
      birthday,
      memory('다른 사람의 비밀 메모', { scope: { userId: OTHER, sessionId: 'session-x' } }),
      memory('채널 범위 기억', { scope: { userId: OWNER, channelId: 'c1' } }),
      memory('만료된 기억', { metadata: { ...coffee.metadata, expiresAt: '2026-10-01T00:00:00.000Z' } }),
      memory('대체된 기억', { metadata: { ...coffee.metadata, supersededBy: 'memory-x' } }),
      memory('짧은 대화', { type: MemoryType.SHORT_TERM }),
      coffee,
      memory('다른 세션에서 저장한 기억', { scope: { userId: OWNER, sessionId: 'session-2', projectId: 'p1' } }),
    ]);
    const listed = await h.run('기억 목록');
    expect(listed.outcome).toBe('listed');
    expect(listed.text.split('\n')).toEqual([
      '저장된 기억 3개 중 1–3번이에요 (1/1쪽).',
      '1. 커피는 아메리카노',
      '2. 생일은 5월 3일',
      '3. 다른 세션에서 저장한 기억',
      '"기억 N 보여줘", "기억 N 수정: 내용", "기억 N 잊어줘"로 하나씩 관리할 수 있어요.',
    ]);
    for (const hidden of ['다른 사람', '채널 범위', '만료된', '대체된', '짧은 대화']) expect(listed.text).not.toContain(hidden);

    const other = await h.run('기억 목록', NOW, OTHER);
    expect(other.text).toContain('저장된 기억 1개 중');
    expect(other.text).not.toContain('커피');
    expect((await h.run('기억 목록', NOW, 'actor-nobody')).outcome).toBe('list-empty');
    expect((await h.run('list memories', NOW, 'actor-nobody')).text).toContain('No memories are saved yet');
  });

  it('pages at 10 and refuses a page past the end', async () => {
    const h = harness(Array.from({ length: 23 }, (_, i) => memory(`항목 ${i + 1}`)));
    const second = await h.run('기억 목록 2');
    expect(second.text).toContain('저장된 기억 23개 중 11–20번이에요 (2/3쪽).');
    expect(second.text).toContain('11. 항목 11');
    expect(second.text).toContain('다음 쪽: "기억 목록 3"');
    expect(second.text).not.toContain('10. 항목 10');
    const third = await h.run('기억 목록 3');
    expect(third.text).toContain('23. 항목 23');
    expect(third.text).not.toContain('다음 쪽');
    expect((await h.run('기억 목록 4')).outcome).toBe('page-out-of-range');
  });

  it('bounds previews to 120 characters, escapes mentions and never shows credential-like text', async () => {
    const h = harness([
      memory(`긴 내용 ${'가'.repeat(300)}`),
      memory('@everyone 회의는 <@123> 담당'),
      memory('내 GitHub 토큰은 ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
    ]);
    const listed = await h.run('기억 목록');
    const first = listed.text.split('\n').find((line) => line.startsWith('1. ')) ?? '';
    expect(Array.from(first.slice(3))).toHaveLength(120);
    expect(first.endsWith('…')).toBe(true);
    expect(listed.text).toContain('2. @​everyone 회의는 <​@​123\\> 담당');
    expect(listed.text).toContain('3. (비밀번호·토큰처럼 보여서 내용을 표시하지 않아요)');
    expect(listed.text).not.toContain('ghp_');
    const view = await h.run('기억 3 보여줘');
    expect(view.text).toBe('기억 3번:\n(비밀번호·토큰처럼 보여서 내용을 표시하지 않아요)');
    const forget = await h.run('기억 3 잊어줘');
    expect(forget.outcome).toBe('forget-confirmation');
    expect(forget.text).not.toContain('ghp_');
  });

  it('views one memory in full (line breaks kept) and answers a missing number', async () => {
    const h = harness([memory('첫 줄\n둘째 줄')]);
    expect((await h.run('기억 1 보여줘')).text).toBe('기억 1번:\n첫 줄\n둘째 줄');
    expect((await h.run('show memory 1')).text).toBe('Memory 1:\n첫 줄\n둘째 줄');
    const missing = await h.run('기억 5 보여줘');
    expect(missing.outcome).toBe('not-found');
    expect(missing.text).toBe('기억 5번은 없어요. 지금 저장된 기억은 1개예요. "기억 목록"으로 번호를 확인해 주세요.');
  });

  it('isListableMemory: expired-at-now and malformed expiry are excluded', () => {
    const base = memory('x');
    expect(isListableMemory(base, OWNER, Date.parse(NOW))).toBe(true);
    expect(isListableMemory(base, OTHER, Date.parse(NOW))).toBe(false);
    expect(isListableMemory({ ...base, metadata: { ...base.metadata, expiresAt: at(1) } }, OWNER, Date.parse(NOW))).toBe(true);
    expect(isListableMemory({ ...base, metadata: { ...base.metadata, expiresAt: at(-1) } }, OWNER, Date.parse(NOW))).toBe(false);
    expect(isListableMemory({ ...base, metadata: { ...base.metadata, expiresAt: 'nope' } }, OWNER, Date.parse(NOW))).toBe(false);
    expect(isListableMemory({ ...base, scope: { userId: OWNER, taskId: 't' } }, OWNER, Date.parse(NOW))).toBe(false);
  });
});

describe('MemoryCommandService — content-bound confirmation (ADR-0106 D4)', () => {
  it('derives a 4-character code bound to record, content, action and window', () => {
    const base = { recordId: 'm1', content: '커피', action: 'forget' as const, window: 100 };
    const code = deriveMemoryConfirmationCode(base);
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
    expect(deriveMemoryConfirmationCode(base)).toBe(code);
    const variants = [
      { ...base, recordId: 'm2' },
      { ...base, content: '홍차' },
      { ...base, action: { edit: '홍차' } },
      { ...base, window: 101 },
    ].map(deriveMemoryConfirmationCode);
    // Distinct inputs give distinct codes here (20 bits; a collision would only make this fixture flaky, not unsafe).
    expect(new Set([code, ...variants]).size).toBe(5);
    expect(memoryConfirmationWindow(NOW)).toBe(Math.floor(Date.parse(NOW) / MEMORY_CONFIRMATION_WINDOW_MS));
  });

  it('a wrong, unknown or malformed code changes nothing', async () => {
    const h = harness([memory('커피는 아메리카노')]);
    const request = await h.run('기억 1 잊어줘');
    const code = codeOf(request);
    for (const text of [`기억 확인 ${wrongCode(code)}`, '기억 확인 ABCDE', '기억 확인 AB']) {
      const result = await h.run(text);
      expect(result.outcome, text).toBe('confirm-unknown');
      expect(result.text).toContain('아무것도 바뀌지 않았어요');
    }
    expect(h.records).toHaveLength(1);
    expect(h.vectors.delete).not.toHaveBeenCalled();
    // The real code still works after wrong attempts.
    expect((await h.run(`기억 확인 ${code}`)).outcome).toBe('forgotten');
  });

  it('a code is one-time, actor-bound and expires after the next window', async () => {
    const h = harness([memory('하나'), memory('둘'), memory('셋')]);
    const code = codeOf(await h.run('기억 1 잊어줘'));
    expect((await h.run(`기억 확인 ${code}`, NOW, OTHER)).outcome).toBe('confirm-unknown');
    expect((await h.run(`기억 확인 ${code}`)).outcome).toBe('forgotten');
    expect((await h.run(`기억 확인 ${code}`)).outcome).toBe('confirm-unknown');

    const windowStart = Math.floor(Date.parse(NOW) / MEMORY_CONFIRMATION_WINDOW_MS) * MEMORY_CONFIRMATION_WINDOW_MS;
    const lateInWindow = new Date(windowStart + MEMORY_CONFIRMATION_WINDOW_MS - 1).toISOString();
    const nextWindow = new Date(windowStart + MEMORY_CONFIRMATION_WINDOW_MS + 60_000).toISOString();
    const twoLater = new Date(windowStart + 2 * MEMORY_CONFIRMATION_WINDOW_MS).toISOString();
    const accepted = codeOf(await h.run('기억 1 잊어줘', lateInWindow));
    expect((await h.run(`기억 확인 ${accepted}`, nextWindow)).outcome).toBe('forgotten');
    const expired = codeOf(await h.run('기억 1 잊어줘', lateInWindow));
    expect((await h.run(`기억 확인 ${expired}`, twoLater)).outcome).toBe('confirm-unknown');
    expect(h.records.map((record) => record.content)).toEqual(['셋']);
  });

  it('a record that changed or vanished after the request is never confirmed by mistake', async () => {
    const h = harness([memory('원래 내용'), memory('다른 기억')]);
    const code = codeOf(await h.run('기억 1 잊어줘'));
    const target = h.records[0] as MemoryRecord;
    h.records[0] = { ...target, content: '그 사이 바뀐 내용' };
    const result = await h.run(`기억 확인 ${code}`);
    expect(result.outcome).toBe('confirm-stale');
    expect(h.records).toHaveLength(2);
    expect(h.vectors.delete).not.toHaveBeenCalled();

    const again = codeOf(await h.run('기억 2 잊어줘'));
    h.records.splice(1, 1);
    expect((await h.run(`기억 확인 ${again}`)).outcome).toBe('confirm-stale');
  });

  it('a shifted number cannot redirect a code: it stays bound to the record it was issued for', async () => {
    const h = harness([memory('첫째'), memory('둘째'), memory('셋째')]);
    const forSecond = codeOf(await h.run('기억 2 잊어줘'));
    // Forget #1 first; "둘째" is now #1, but the earlier code still names "둘째" only.
    expect((await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`)).outcome).toBe('forgotten');
    const confirmed = await h.run(`기억 확인 ${forSecond}`);
    expect(confirmed.outcome).toBe('forgotten');
    expect(confirmed.text).toContain('둘째');
    expect(h.records.map((record) => record.content)).toEqual(['셋째']);
  });
});

describe('MemoryCommandService — forget (ADR-0106 D5)', () => {
  it('forgets through the writer, removes the vector, and recall no longer returns it', async () => {
    const coffee = memory('커피는 아메리카노', { vectorId: 'vector-legacy' });
    const h = harness([coffee, memory('홍차도 좋아')]);
    expect(await lexicalRecall(h.repository, '커피 아메리카노')).toContain('커피는 아메리카노');
    const request = await h.run('기억 1 잊어줘');
    expect(request.text).toBe(
      `기억 1번을 잊을까요?\n> 커피는 아메리카노\n맞으면 30분 안에 "기억 확인 ${codeOf(request)}"라고 보내 주세요. 다른 말을 하면 아무것도 지우지 않아요.`,
    );
    expect(h.records).toHaveLength(2);
    const done = await h.run(`기억 확인 ${codeOf(request)}`);
    expect(done).toEqual({
      outcome: 'forgotten',
      status: 'RESPONDED',
      text: '이 기억을 잊었어요:\n> 커피는 아메리카노',
      // W2-L01: the conversation history keeps a content-free note instead of the reply's preview.
      history: { assistant: '(요청한 기억을 잊었어요. 그 내용은 더 이상 쓰지 않아요.)' },
    });
    expect(h.records.map((record) => record.id)).not.toContain(coffee.id);
    expect(h.vectors.delete).toHaveBeenCalledWith('durable-memory-v1', [coffee.id, 'vector-legacy']);
    expect(await lexicalRecall(h.repository, '커피 아메리카노')).not.toContain('커피는 아메리카노');
    expect((await h.run('기억 목록')).text).toContain('1. 홍차도 좋아');
  });

  it('also removes the earlier versions an edited memory superseded', async () => {
    const h = harness([memory('버전 1')]);
    expect((await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 2'))}`)).outcome).toBe('edited');
    expect((await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 3'))}`)).outcome).toBe('edited');
    expect(h.records).toHaveLength(3);
    const done = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(done.outcome).toBe('forgotten');
    expect(done.text).toContain('이전에 고쳐 쓰기 전 버전 2개도 함께 지웠어요.');
    expect(h.records).toEqual([]);
  });

  it('runs every cascade before deleting; a failing cascade deletes nothing (fail closed)', async () => {
    const events: MemoryRemovalEvent[] = [];
    const learning: MemoryRemovalCascade = { id: 'learning', onMemoriesRemoved: async (event) => void events.push(event) };
    const h = harness([memory('지울 기억')], { cascades: [learning] });
    const target = h.records[0] as MemoryRecord;
    await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(events).toEqual([{ actorId: OWNER, reason: 'forget', memoryIds: [target.id], vectorIds: [], contents: ['지울 기억'] }]);
    expect(h.records).toEqual([]);

    const failing: MemoryRemovalCascade = {
      id: 'learning',
      onMemoriesRemoved: async () => {
        throw new Error('store locked');
      },
    };
    const f = harness([memory('남을 기억')], { cascades: [failing] });
    const result = await f.run(`기억 확인 ${codeOf(await f.run('기억 1 잊어줘'))}`);
    expect(result).toMatchObject({ outcome: 'forget-incomplete', status: 'FAILED' });
    expect(result.text).toBe(
      '기억을 끝까지 지우지 못했어요. 관련 데이터는 일부 지워졌을 수 있어요.\n이 기억은 아직 목록에 남아 있어요. "기억 목록"에서 번호를 확인한 뒤 "기억 N 잊어줘"로 다시 시도해 주세요.',
    );
    expect(f.records).toHaveLength(1);
    expect((await f.run('기억 목록')).text).toContain('1. 남을 기억');
    expect(f.logs.join('\n')).toContain('memory_commands.cascade.failed');
  });

  it('a failed history delete leaves the current memory listable and a retry removes the whole chain', async () => {
    const h = harness([memory('버전 1')]);
    expect((await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 2'))}`)).outcome).toBe('edited');
    expect((await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 3'))}`)).outcome).toBe('edited');
    const [v1, v2, v3] = h.records as [MemoryRecord, MemoryRecord, MemoryRecord];
    expect(v3.metadata?.['supersedesMemoryId']).toBe(v2.id);
    const order: string[] = [];
    const realDelete = h.repository.delete;
    let failOnce = true;
    h.repository.delete = async (id) => {
      order.push(id);
      if (id === v2.id && failOnce) {
        failOnce = false;
        throw new Error('SQLITE_BUSY 버전 2');
      }
      return realDelete(id);
    };

    const partial = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(partial).toMatchObject({ outcome: 'forget-incomplete', status: 'FAILED' });
    expect(partial.text).toContain('일부만 지웠어요');
    expect(partial.text).toContain('다시');
    expect(partial.text).not.toContain('바뀐 것은 없어요');
    expect(partial.text).toBe(
      '기억을 일부만 지웠어요: 이전 버전 1개는 지웠지만 끝까지 마치지 못했어요.\n이 기억은 아직 목록에 남아 있어요. "기억 목록"에서 번호를 확인한 뒤 "기억 N 잊어줘"로 다시 시도해 주세요.',
    );
    // Oldest first: the current record is never deleted while its history remains.
    expect(order).toEqual([v1.id, v2.id]);
    expect(h.records.map((record) => record.id)).toEqual([v2.id, v3.id]);
    expect((await h.run('기억 목록')).text).toContain('1. 버전 3');
    expect(h.logs.join('\n')).not.toMatch(/SQLITE_BUSY|버전 [123]/u);

    const retried = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(retried.outcome).toBe('forgotten');
    expect(retried.text).toContain('이전에 고쳐 쓰기 전 버전 1개도 함께 지웠어요.');
    expect(h.records).toEqual([]);
  });

  it('a failed delete of the current memory itself is reported as incomplete, never as unchanged', async () => {
    const h = harness([memory('지울 기억')]);
    const target = h.records[0] as MemoryRecord;
    h.repository.delete = async () => {
      throw new Error('SQLITE_IOERR');
    };
    const result = await h.run(`confirm memory ${codeOf(await h.run('forget memory 1'))}`);
    expect(result).toMatchObject({ outcome: 'forget-incomplete', status: 'FAILED' });
    expect(result.text).toContain('try again');
    expect(result.text).not.toContain('Nothing was changed');
    expect(h.records.map((record) => record.id)).toEqual([target.id]);
  });

  it('refuses bulk forget with the one-by-one instruction and deletes nothing', async () => {
    const h = harness([memory('하나')]);
    const result = await h.run('내 기억 다 지워줘');
    expect(result.outcome).toBe('bulk-refused');
    expect(result.text).toContain('"기억 N 잊어줘"로 하나씩');
    expect(h.records).toHaveLength(1);
  });
});

describe('MemoryCommandService — edit (ADR-0106 D5)', () => {
  it('confirms, writes a superseding record in the original scope and removes the old vector', async () => {
    const h = harness([memory('커피는 아메리카노', { scope: { userId: OWNER, sessionId: 'session-9', projectId: 'p9' } })]);
    const old = h.records[0] as MemoryRecord;
    const request = await h.run('기억 1 수정: 커피는 라떼');
    expect(request.outcome).toBe('edit-confirmation');
    expect(request.text).toContain('지금: 커피는 아메리카노');
    expect(request.text).toContain('새 내용: 커피는 라떼');
    expect(h.records).toHaveLength(1);
    const done = await h.run(`기억 확인 ${codeOf(request)}`);
    expect(done.outcome).toBe('edited');
    expect(done.text).toContain('> 커피는 라떼');
    const replacement = h.records.find((record) => record.id !== old.id) as MemoryRecord;
    expect(replacement.scope).toEqual({ userId: OWNER, sessionId: 'session-9', projectId: 'p9' });
    expect(replacement.metadata).toMatchObject({ supersedesMemoryId: old.id, provenance: 'USER_PROVIDED' });
    expect(h.records.find((record) => record.id === old.id)?.metadata?.['supersededBy']).toBe(replacement.id);
    expect(h.vectors.delete).toHaveBeenCalledWith('durable-memory-v1', [old.id]);
    expect((await h.run('기억 목록')).text).toContain('1. 커피는 라떼');
    const recalled = await lexicalRecall(h.repository, '커피');
    expect(recalled).toEqual(['커피는 라떼']);
  });

  it('retries a failed edit cascade once and notes a cleanup that still failed, without undoing the edit', async () => {
    let failures = 1;
    const flaky: MemoryRemovalCascade = {
      id: 'learning',
      onMemoriesRemoved: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('store locked');
        }
      },
    };
    const h = harness([memory('하나')], { cascades: [flaky] });
    const retried = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 둘'))}`);
    expect(retried.outcome).toBe('edited');
    expect(retried.text).toBe('기억을 바꿨어요:\n> 둘\n바꾼 기억은 목록 맨 뒤로 옮겨져요.');
    expect(h.logs.join('\n')).toContain('memory_commands.edit.cascade_failed {"attempt":1');

    failures = 2;
    const pending = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 셋'))}`);
    expect(pending).toMatchObject({ outcome: 'edited', status: 'RESPONDED' });
    expect(pending.text).toBe(
      '기억을 바꿨어요:\n> 셋\n바꾼 기억은 목록 맨 뒤로 옮겨져요.\n다만 이전 내용에서 파생된 데이터 일부는 아직 정리하지 못했어요.',
    );
    expect(h.logs.join('\n')).toContain('memory_commands.edit.cascade_failed {"attempt":2');
    expect((await h.run('기억 목록')).text).toContain('1. 셋');
  });

  it('refuses a credential-shaped edit before issuing any code', async () => {
    const h = harness([memory('서버 주소 메모')]);
    for (const text of ['기억 1 수정: password = hunter2hunter2', '기억 1 수정: 토큰 ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
      const result = await h.run(text);
      expect(result.outcome, text).toBe('edit-sensitive');
      expect(result.text).not.toMatch(/기억 확인 [A-Z0-9]{4}/);
      expect(result.text).not.toContain('hunter2');
    }
    expect(h.records).toHaveLength(1);
  });

  it('answers unchanged, too-long and duplicate edits without changing anything', async () => {
    const h = harness([memory('하나'), memory('둘')]);
    expect((await h.run('기억 1 수정:  하나 ')).outcome).toBe('edit-unchanged');
    expect((await h.run(`기억 1 수정: ${'가'.repeat(4_001)}`)).outcome).toBe('edit-too-long');
    const duplicate = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 둘'))}`);
    expect(duplicate.outcome).toBe('edit-duplicate');
    expect(h.records.map((record) => record.content)).toEqual(['하나', '둘']);
    expect(h.records.every((record) => record.metadata?.['supersededBy'] === undefined)).toBe(true);
    expect((await h.run('기억 9 수정: 셋')).outcome).toBe('not-found');
  });

  it('an edit code is bound to the proposed text', async () => {
    const h = harness([memory('하나')]);
    const first = codeOf(await h.run('기억 1 수정: 둘'));
    const second = codeOf(await h.run('기억 1 수정: 셋'));
    expect(first).not.toBe(second);
    // The newer request for the same record replaces the older one.
    expect((await h.run(`기억 확인 ${first}`)).outcome).toBe('confirm-unknown');
    expect((await h.run(`기억 확인 ${second}`)).outcome).toBe('edited');
    expect((await h.run('기억 목록')).text).toContain('1. 셋');
  });
});

describe('MemoryCommandService — status, usage and failures', () => {
  it('answers "기억했어?" from the store, never by claiming', async () => {
    const h = harness([memory('오래된 기억'), memory('최근 기억')]);
    const status = await h.run('기억했어?');
    expect(status.text).toBe(
      '가장 최근에 저장된 기억이에요 (모두 2개):\n> 최근 기억\n전체는 "기억 목록"으로 볼 수 있고, 새로 저장하려면 "기억해: 내용"이라고 보내 주세요.',
    );
    expect((await harness([]).run('기억했어?')).text).toBe(
      '아직 저장된 기억이 없어요. 기억해 두려면 "기억해: 내용"이라고 보내 주세요.',
    );
  });

  it('usage replies for an edit without text and a confirmation without a code', async () => {
    const h = harness([memory('하나')]);
    expect((await h.run('기억 2 수정')).text).toBe('바꿀 내용을 콜론 뒤에 함께 보내 주세요. 예: "기억 2 수정: 새 내용"');
    expect((await h.run('기억 확인')).text).toContain('확인 메시지에 있던 코드');
  });

  it('a store failure becomes a fixed FAILED reply with a content-free log line', async () => {
    const service = new MemoryCommandService({
      records: {
        get: async () => null,
        findDurableCandidates: async () => {
          throw new Error('SQLITE_BUSY 커피는 아메리카노');
        },
      },
      writer: new DefaultMemoryWriter({
        durableMemory: async () => null,
        durableMemories: async () => [],
        saveDurable: async (record) => record,
        forgetDurable: async () => undefined,
      }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const result = await service.execute({ kind: 'list', page: 1, language: 'ko' }, { actorId: OWNER, now: NOW });
    expect(result).toMatchObject({ outcome: 'failed', status: 'FAILED' });
    expect(result.text).toContain('바뀐 것은 없어요');
  });

  it('logs carry no memory content', async () => {
    const h = harness([memory('비밀스러운 커피 취향')]);
    await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join('\n')).not.toContain('커피');
  });
});

describe('MemoryCommandService — conversation-history form of edit/forget turns (W2-L01)', () => {
  it('withholds the edit request text and replaces the replies that echo memory text with content-free notes', async () => {
    const h = harness([memory('커피는 라떼'), memory('홍차도 좋아')]);
    const listed = await h.run('기억 목록');
    expect(listed.history).toBeUndefined(); // no edit/forget turn: recorded verbatim (a later forget purges it)
    expect((await h.run('기억 1 보여줘')).history).toBeUndefined();

    const editAsk = await h.run('기억 1 수정: 커피는 아이스 아메리카노');
    expect(editAsk.text).toContain('새 내용: 커피는 아이스 아메리카노'); // the reply itself is unchanged
    expect(editAsk.history).toEqual({
      user: '기억 1 수정: (내용은 대화 기록에 남기지 않아요)',
      assistant: '(기억을 바꾸기 전에 확인 코드를 보냈어요. 기억 내용은 대화 기록에 남기지 않아요.)',
    });
    const edited = await h.run(`기억 확인 ${codeOf(editAsk)}`);
    expect(edited.history).toEqual({ assistant: '(요청한 기억을 바꿨어요. 기억 내용은 대화 기록에 남기지 않아요.)' });

    // A refused (credential-shaped) edit request is withheld too; its reply echoes nothing.
    const secret = await h.run('기억 1 수정: password = hunter2hunter2');
    expect(secret.outcome).toBe('edit-sensitive');
    expect(secret.history).toEqual({ user: '기억 1 수정: (내용은 대화 기록에 남기지 않아요)' });

    const forgetAsk = await h.run('forget memory 1');
    expect(forgetAsk.history).toEqual({
      assistant: '(Asked for a confirmation code before forgetting a memory; its text is not kept in the conversation history.)',
    });
    expect((await h.run(`confirm memory ${codeOf(forgetAsk)}`)).history).toEqual({
      assistant: '(Forgot the requested memory; its content is no longer used.)',
    });
    expect((await h.run('기억 확인 AAAA')).history).toBeUndefined();
  });

  it('hands every removed text to the cascades: the record and its earlier versions on forget, the old text on edit', async () => {
    const events: MemoryRemovalEvent[] = [];
    const h = harness([memory('버전 1')], {
      cascades: [{ id: 'recording', onMemoriesRemoved: async (event) => void events.push(event) }],
    });
    await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 2'))}`);
    await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(events.map((event) => [event.reason, event.contents])).toEqual([
      ['edit', ['버전 1']],
      ['forget', ['버전 2', '버전 1']],
    ]);
  });
});
