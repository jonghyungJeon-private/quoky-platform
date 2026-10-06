import { describe, expect, it, vi } from 'vitest';
import { Capability, MemoryType, createMemoryRetrievalRequest, isArchivedMemory } from '../../domain';
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
import {
  createVectorRemovalCascade,
  type MemoryRemovalCascade,
  type MemoryRemovalEvent,
  type SessionHistoryClearer,
} from './memory-removal-cascade';

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

/** The SQLite `archived` / `archiveExpiredBy` semantics of `findDurableCandidates`. */
function archiveFilter(record: MemoryRecord, query: DurableMemoryQuery): boolean {
  const archived = query.archived ?? 'exclude';
  if (archived === 'include') return true;
  if (archived === 'exclude') return !isArchivedMemory(record);
  if (!isArchivedMemory(record)) return false;
  if (query.archiveExpiredBy === undefined) return true;
  const expires = record.metadata?.['archiveExpiresAt'];
  return typeof expires === 'string' && Date.parse(expires) <= Date.parse(query.archiveExpiredBy);
}

function scopeMatches(record: MemoryRecord, scope: MemoryScope): boolean {
  return (Object.keys(scope) as Array<keyof MemoryScope>).every(
    (key) => scope[key] === undefined || record.scope[key] === scope[key],
  );
}

/** An in-memory memory repository with the SQLite query's filter semantics, shared by the writer and the service. */
/**
 * `archiveDays` defaults to 0 here: the suites below written before the ADR-0106 amendment pin the permanent-delete
 * path (`QUOKY_MEMORY_ARCHIVE_DAYS=0`); the archive suites pass a positive value.
 */
function harness(
  initial: MemoryRecord[],
  options: { cascades?: MemoryRemovalCascade[]; archiveDays?: number; sessionHistory?: SessionHistoryClearer } = {},
) {
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
      records.filter(
        (record) => (type === undefined || record.type === type) && scopeMatches(record, scope) && !isArchivedMemory(record),
      ),
    findDurableCandidates: async (query: DurableMemoryQuery) =>
      records
        .filter(
          (record) =>
            record.type === MemoryType.LONG_TERM &&
            scopeMatches(record, query.scope) &&
            !(query.excludeIds ?? []).includes(record.id) &&
            !(query.excludeSuperseded && record.metadata?.['supersededBy'] !== undefined) &&
            archiveFilter(record, query),
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
    archiveDays: options.archiveDays ?? 0,
    ...(options.sessionHistory === undefined ? {} : { sessionHistory: options.sessionHistory }),
    logger,
  });
  const run = async (text: string, now = NOW, actorId = OWNER, sessionId?: string): Promise<MemoryCommandResult> => {
    const command = parseMemoryCommand(text);
    if (command === null) throw new Error(`not a memory command: ${text}`);
    return service.execute(command, { actorId, now, sourceText: text, ...(sessionId === undefined ? {} : { sessionId }) });
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

describe('MemoryCommandService — archive with restore (ADR-0106 amendment)', () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const clearer = () => {
    const calls: Array<[string, string]> = [];
    const sessionHistory: SessionHistoryClearer = {
      clearSession: vi.fn(async (actorId: string, sessionId: string) => {
        calls.push([actorId, sessionId]);
        return 3;
      }),
    };
    return { calls, sessionHistory };
  };
  const confirm = async (h: ReturnType<typeof harness>, ask: MemoryCommandResult, now = NOW, actorId = OWNER, sessionId?: string) =>
    h.run(`기억 확인 ${codeOf(ask)}`, now, actorId, sessionId);

  it('forget archives the record in place: out of the list and recall, listed in the archive with days left', async () => {
    const coffee = memory('커피는 아메리카노', { vectorId: 'vector-legacy' });
    const { calls, sessionHistory } = clearer();
    const h = harness([coffee, memory('홍차도 좋아')], { archiveDays: 7, sessionHistory });
    const done = await confirm(h, await h.run('기억 1 잊어줘', NOW, OWNER, 'session-now'), NOW, OWNER, 'session-now');
    expect(done).toEqual({
      outcome: 'forgotten',
      status: 'RESPONDED',
      text:
        '이 기억을 잊었어요:\n> 커피는 아메리카노\n' +
        '이제 대화에 쓰지 않아요. 보관함에 7일 동안 두었다가 완전히 지워요. ' +
        '되돌리려면 "보관함"에서 번호를 확인한 뒤 "기억 복원 N"이라고 보내 주세요.\n' +
        '이번 대화 기록도 비웠어요.',
      history: { assistant: '(요청한 기억을 잊었어요. 그 내용은 더 이상 쓰지 않아요.)' },
    });
    const stored = h.records.find((record) => record.id === coffee.id);
    expect(stored?.content).toBe('커피는 아메리카노');
    expect(stored?.metadata).toMatchObject({ archivedAt: NOW, archiveExpiresAt: at(7 * DAY) });
    // Derived data goes at archive time; the current conversation's history is cleared for the actor.
    expect(h.vectors.delete).toHaveBeenCalledWith('durable-memory-v1', [coffee.id, 'vector-legacy']);
    expect(calls).toEqual([[OWNER, 'session-now']]);
    expect(await lexicalRecall(h.repository, '커피 아메리카노')).not.toContain('커피는 아메리카노');
    expect((await h.run('기억 목록')).text).not.toContain('커피');

    const archive = await h.run('보관함', at(DAY + 60_000));
    expect(archive.outcome).toBe('archive-listed');
    expect(archive.text).toBe(
      [
        '보관함에 잊은 기억 1개가 있어요 (1/1쪽). 보관함 번호는 "기억 목록" 번호와 따로 매겨져요.',
        '1. 커피는 아메리카노 (6일 남음)',
        '"기억 복원 N"으로 되돌리거나 "기억 완전 삭제 N"으로 바로 지울 수 있어요 (확인 코드로 한 번 더 확인해요).',
      ].join('\n'),
    );
    // Archived text never re-enters the conversation history through the archive view.
    expect(archive.history).toEqual({ assistant: '(보관함을 보여줬어요. 보관된 기억 내용은 대화 기록에 남기지 않아요.)' });
    expect((await h.run('memory archive')).text).toContain('Archive numbers are separate from the "list memories" numbers.');
  });

  it('restore (confirmed) clears the archive keys of the record and its versions; it is listed and recalled again', async () => {
    const h = harness([memory('버전 1')], { archiveDays: 7 });
    await confirm(h, await h.run('기억 1 수정: 버전 2'));
    expect((await confirm(h, await h.run('기억 1 잊어줘'))).text).toContain(
      '이전에 고쳐 쓰기 전 버전 1개도 함께 보관함으로 옮겼어요.',
    );
    expect(h.records.every((record) => isArchivedMemory(record))).toBe(true);
    expect((await h.run('보관함')).text).toContain('1. 버전 2 (7일 남음)');
    expect((await h.run('보관함')).text).not.toContain('버전 1');

    const ask = await h.run('기억 복원 1', at(60_000));
    expect(ask).toMatchObject({ outcome: 'restore-confirmation' });
    expect(ask.text).toBe(
      `보관함 1번 기억을 복원할까요?\n> 버전 2\n맞으면 30분 안에 "기억 확인 ${codeOf(ask)}"라고 보내 주세요. 다른 말을 하면 아무것도 바꾸지 않아요.`,
    );
    expect(ask.history).toEqual({
      assistant: '(보관함의 기억을 복원하기 전에 확인 코드를 보냈어요. 기억 내용은 대화 기록에 남기지 않아요.)',
    });
    expect(h.records.every((record) => isArchivedMemory(record))).toBe(true); // nothing before the confirmation
    const restored = await confirm(h, ask, at(120_000));
    expect(restored).toMatchObject({ outcome: 'restored', status: 'RESPONDED' });
    expect(restored.text).toBe('기억을 복원했어요:\n> 버전 2\n다시 대화에 쓰여요. "기억 목록"에서 확인할 수 있어요.');
    expect(h.records.some((record) => isArchivedMemory(record))).toBe(false);
    expect(await lexicalRecall(h.repository, '버전')).toEqual(['버전 2']); // the superseded version stays history
    expect((await h.run('기억 목록')).text).toContain('1. 버전 2');
    expect((await h.run('보관함')).outcome).toBe('archive-empty');
  });

  it('permanent delete (confirmed) removes the archived record and its versions at once', async () => {
    const h = harness([memory('버전 1'), memory('남는 기억')], { archiveDays: 7 });
    await confirm(h, await h.run('기억 1 수정: 버전 2'));
    await confirm(h, await h.run('기억 2 잊어줘')); // "버전 2" moved to the end of the list
    expect(h.records.filter((record) => isArchivedMemory(record))).toHaveLength(2);
    const ask = await h.run('기억 완전 삭제 1');
    expect(ask.outcome).toBe('purge-confirmation');
    expect(ask.text).toContain('보관함 1번 기억을 완전히 지울까요? 지우면 되돌릴 수 없어요.');
    const purged = await confirm(h, ask);
    expect(purged).toMatchObject({ outcome: 'purged', status: 'RESPONDED' });
    expect(purged.text).toBe(
      '보관함의 기억을 완전히 지웠어요:\n> 버전 2\n이전에 고쳐 쓰기 전 버전 1개도 함께 지웠어요.\n이제 되돌릴 수 없어요.',
    );
    expect(h.records.map((record) => record.content)).toEqual(['남는 기억']);
  });

  it('archive codes are action- and record-bound: a stale archive record, a forget code or another actor changes nothing', async () => {
    const h = harness([memory('하나'), memory('둘')], { archiveDays: 7 });
    await confirm(h, await h.run('기억 1 잊어줘'));
    const restoreAsk = await h.run('기억 복원 1');
    // Another actor cannot use the owner's code, nor see the owner's archive.
    expect((await confirm(h, restoreAsk, NOW, OTHER)).outcome).toBe('confirm-unknown');
    expect((await h.run('보관함', NOW, OTHER)).outcome).toBe('archive-empty');
    expect((await h.run('기억 복원 1', NOW, OTHER)).outcome).toBe('archive-empty');
    // The record leaves the archive (permanently deleted) before the restore code is used: stale, nothing happens.
    const purgeAsk = await h.run('기억 완전 삭제 1');
    expect((await confirm(h, purgeAsk)).outcome).toBe('purged');
    const stale = await confirm(h, restoreAsk);
    expect(stale.outcome).toBe('confirm-stale');
    expect(stale.text).toContain('"보관함"으로 다시 확인해 주세요');
    expect((await h.run('기억 복원 3')).outcome).toBe('archive-empty');
    expect(h.records.map((record) => record.content)).toEqual(['둘']);
  });

  it('a listed number past the archive answers with the archive count (archive numbers are separate)', async () => {
    const h = harness([memory('하나'), memory('둘'), memory('셋')], { archiveDays: 7 });
    await confirm(h, await h.run('기억 2 잊어줘'));
    const missing = await h.run('기억 복원 2');
    expect(missing.outcome).toBe('archive-not-found');
    expect(missing.text).toBe(
      '보관함에 2번 기억은 없어요. 지금 보관함에는 1개가 있어요. "보관함"으로 번호를 확인해 주세요 (기억 목록 번호와 달라요).',
    );
  });

  it('credential-like record text is never archived: forget deletes it permanently and says so', async () => {
    // A legacy record (the writer refuses such text today) — the strict guard decides, not the writer.
    const secret = memory('배포 서버 password = hunter2hunter2');
    const h = harness([secret, memory('일반 기억')], { archiveDays: 7 });
    const ask = await h.run('기억 1 잊어줘');
    expect(ask.text).not.toContain('hunter2');
    const done = await confirm(h, ask);
    expect(done.outcome).toBe('forgotten');
    expect(done.text).toBe(
      '이 기억을 잊었어요:\n> (비밀번호·토큰처럼 보여서 내용을 표시하지 않아요)\n비밀번호·토큰처럼 보이는 내용이라 보관함에 두지 않고 바로 완전히 지웠어요.',
    );
    expect(h.records.map((record) => record.id)).not.toContain(secret.id);
    expect((await h.run('보관함')).outcome).toBe('archive-empty');
  });

  it('archiveDays 0 deletes at once and the archive view says no archive is kept', async () => {
    const h = harness([memory('바로 지울 기억')], { archiveDays: 0 });
    const done = await confirm(h, await h.run('기억 1 잊어줘'));
    expect(done.text).toBe('이 기억을 잊었어요:\n> 바로 지울 기억');
    expect(h.records).toEqual([]);
    expect((await h.run('보관함')).text).toBe('보관함이 비어 있어요. 지금 설정에서는 잊은 기억을 보관하지 않고 바로 완전히 지워요.');
    expect((await h.run('memory archive')).text).toContain('deleted for good at once');
  });

  it('a failing session-history clear fails the forget closed: nothing archived, the memory stays listed', async () => {
    const sessionHistory: SessionHistoryClearer = {
      clearSession: vi.fn(async () => Promise.reject(new Error('disk'))),
    };
    const h = harness([memory('남아야 하는 기억')], { archiveDays: 7, sessionHistory });
    const done = await confirm(h, await h.run('기억 1 잊어줘', NOW, OWNER, 's1'), NOW, OWNER, 's1');
    expect(done).toMatchObject({ outcome: 'forget-incomplete', status: 'FAILED' });
    expect(h.records.some((record) => isArchivedMemory(record))).toBe(false);
    expect((await h.run('기억 목록')).text).toContain('1. 남아야 하는 기억');
  });

  it('edit clears the session history too and says so', async () => {
    const { calls, sessionHistory } = clearer();
    const h = harness([memory('옛 내용')], { archiveDays: 7, sessionHistory });
    const done = await confirm(h, await h.run('기억 1 수정: 새 내용', NOW, OWNER, 's9'), NOW, OWNER, 's9');
    expect(done.outcome).toBe('edited');
    expect(done.text.split('\n').at(-1)).toBe('이번 대화 기록도 비웠어요.');
    expect(calls).toEqual([[OWNER, 's9']]);
  });

  it('purgeExpiredArchive deletes only the entries whose expiry has passed, for every actor, and logs counts only', async () => {
    const h = harness([memory('오래된 기억'), memory('다른 사람 기억', { scope: { userId: OTHER } }), memory('최근 기억')], {
      archiveDays: 7,
    });
    await confirm(h, await h.run('기억 1 잊어줘'));
    await confirm(h, await h.run('기억 1 잊어줘', NOW, OTHER), NOW, OTHER);
    await confirm(h, await h.run('기억 1 잊어줘', at(2 * DAY)), at(2 * DAY));
    expect(await h.service.purgeExpiredArchive(at(7 * DAY - 1))).toEqual({ purged: 0, failed: 0 });
    expect(h.records).toHaveLength(3);
    expect(await h.service.purgeExpiredArchive(at(7 * DAY))).toEqual({ purged: 2, failed: 0 });
    expect(h.records.map((record) => record.content)).toEqual(['최근 기억']);
    // Expired-but-not-yet-purged entries are never listed or restorable (here: the remaining one after its expiry).
    expect((await h.run('보관함', at(9 * DAY))).outcome).toBe('archive-empty');
    expect(await h.service.purgeExpiredArchive(at(9 * DAY))).toEqual({ purged: 1, failed: 0 });
    expect(h.records).toEqual([]);
    expect(h.logs.join('\n')).not.toMatch(/기억/u);
    expect(h.logs).toContain('memory_archive.purge.done {"purged":1,"failed":0}');
  });

  it('a forgotten text saved again is a new memory, not a duplicate of the archived one', async () => {
    const h = harness([memory('다시 저장할 기억')], { archiveDays: 7 });
    await confirm(h, await h.run('기억 1 잊어줘'));
    const writer = new DefaultMemoryWriter({
      durableMemory: (id) => h.repository.get(id),
      durableMemories: (scope) => h.repository.findByScope(scope, MemoryType.LONG_TERM),
      saveDurable: (record) => h.repository.save(record),
      forgetDurable: (id) => h.repository.delete(id),
    });
    const decision = await writer.promote(
      writer.createCandidate({
        content: '다시 저장할 기억',
        sourceContent: '기억해: 다시 저장할 기억',
        trigger: 'EXPLICIT_USER_INSTRUCTION',
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        scope: { actorId: OWNER, sessionId: 'session-1' },
        metadata: {},
      }),
    );
    expect(decision.outcome).toBe('PROMOTED');
    // A candidate can never carry the archive keys itself (writer-owned lifecycle metadata).
    const forged = await writer.promote(
      writer.createCandidate({
        content: '보관된 척하는 기억',
        sourceContent: '기억해: 보관된 척하는 기억',
        trigger: 'EXPLICIT_USER_INSTRUCTION',
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        scope: { actorId: OWNER },
        metadata: { archivedAt: NOW },
      }),
    );
    expect(forged).toMatchObject({ outcome: 'REJECTED' });
  });

  it('the retriever skips an archived record even when a repository returns it', async () => {
    const archived = memory('보관된 커피 기억', { metadata: { ...memory('x').metadata, archivedAt: NOW, archiveExpiresAt: at(DAY) } });
    const leaky: MemoryRepository = {
      ...harness([]).repository,
      findDurableCandidates: async () => [archived],
    };
    expect(await lexicalRecall(leaky, '커피 기억')).toEqual([]);
  });

  it('rejects an archiveDays outside 0–365 or not an integer', () => {
    for (const archiveDays of [-1, 366, 1.5, Number.NaN]) {
      expect(() => harness([], { archiveDays }), String(archiveDays)).toThrow(RangeError);
    }
    expect(harness([], { archiveDays: 365 }).service.archiveDays).toBe(365);
  });
});

describe('MemoryCommandService — interrupted archive retry (ADR-0106 amendment)', () => {
  it('a retry after a failed archive of the current record finishes the chain, walking past already-archived versions', async () => {
    const h = harness([memory('버전 1')], { archiveDays: 7 });
    await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 2'))}`);
    await h.run(`기억 확인 ${codeOf(await h.run('기억 1 수정: 버전 3'))}`);
    const head = h.records.find((record) => record.content === '버전 3');
    if (head === undefined) throw new Error('missing head');
    // The store refuses to save the current record once: versions 1 and 2 are archived, the head is not.
    const save = h.repository.save.bind(h.repository);
    let refused = false;
    (h.service as unknown as { deps: { records: { save: typeof save } } }).deps.records.save = async (record) => {
      if (record.id === head.id && !refused) {
        refused = true;
        throw new Error('disk full');
      }
      return save(record);
    };
    const first = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(first).toMatchObject({ outcome: 'forget-incomplete', status: 'FAILED' });
    expect(first.text).toContain('이전 버전 2개는 보관함으로 옮겼지만');
    expect((await h.run('기억 목록')).text).toContain('1. 버전 3');
    const retry = await h.run(`기억 확인 ${codeOf(await h.run('기억 1 잊어줘'))}`);
    expect(retry.outcome).toBe('forgotten');
    expect(h.records.every((record) => isArchivedMemory(record))).toBe(true);
    // A restore then brings the whole chain back (the earlier versions stay superseded history).
    await h.run(`기억 확인 ${codeOf(await h.run('기억 복원 1'))}`);
    expect(h.records.some((record) => isArchivedMemory(record))).toBe(false);
    expect((await h.run('기억 목록')).text).toContain('1. 버전 3');
  });
});
