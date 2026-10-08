import { describe, expect, it, vi } from 'vitest';
import {
  Capability, IntentType, LEARNING_CAPABILITY_UNKNOWN, LEARNING_EGRESS_LOCAL_ONLY, LEARNING_MAX_ITEMS_PER_ACTOR,
  LEARNING_PRUNE_MAX_ROWS, LEARNING_RETENTION_MS, LEARNING_TEXT_MAX_CHARS, LearningItemKind,
} from '../../domain';
import type { FeedbackRatedTurn, Id, IsoTimestamp, LearningItem, LearningItemData } from '../../domain';
import type { FeedbackRatedTurnQuery, LearningInsertResult, LearningItemListQuery, LearningRepository } from '../../ports';
import { parseLearningCommand } from './learning-commands';
import {
  LEARNING_FAILURE_TEXT, LEARNING_LISTING_LIMIT, LEARNING_REMOTE_DISCLOSURE, LEARNING_LISTING_TTL_MS, LearningService, learningItemUsable,
  learningTextRefusal,
} from './learning-service';
import type { LearningCommandScope, LearningReplyLookup } from './learning-service';

const NOW = '2026-10-06T12:00:00.000Z';
const SCOPE: LearningCommandScope = { actorId: 'actor-1', platform: 'discord', channelId: 'c1' };
const OTHER_SCOPE: LearningCommandScope = { actorId: 'actor-2', platform: 'discord', channelId: 'c1' };
const CREDENTIAL = '비밀번호는 hunter2-secret 이야';

function at(offsetMs: number): IsoTimestamp {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

/** In-memory learning store honouring the port contract (actor scoping, expiry on read, cap, LOCAL_ONLY). */
class FakeLearningRepository implements LearningRepository {
  items: LearningItem[] = [];
  readonly pruneCalls: Array<{ now: string; maxRows: number }> = [];

  async insertWithinCap(item: LearningItem, maxPerActor: number, now: IsoTimestamp): Promise<LearningInsertResult> {
    if (item.egress !== LEARNING_EGRESS_LOCAL_ONLY) throw new Error('LEARNING_EGRESS_INVALID');
    if (this.items.filter((i) => i.actorId === item.actorId && i.expiresAt > now).length >= maxPerActor) return 'CAP_REACHED';
    this.items.push(structuredClone(item));
    return 'INSERTED';
  }
  async findBySourceTurn(actorId: Id, kind: LearningItemKind, turnId: Id, now: IsoTimestamp): Promise<LearningItem | null> {
    return this.items.find((i) => i.actorId === actorId && i.kind === kind && i.sourceTurnId === turnId && i.expiresAt > now) ?? null;
  }
  async get(actorId: Id, id: Id, now: IsoTimestamp): Promise<LearningItem | null> {
    return this.items.find((i) => i.id === id && i.actorId === actorId && i.expiresAt > now) ?? null;
  }
  async list(query: LearningItemListQuery): Promise<LearningItem[]> {
    return this.items
      .filter((i) => i.actorId === query.actorId && i.kind === query.kind && i.expiresAt > query.now)
      .reverse()
      .slice(0, query.limit);
  }
  async updateData(actorId: Id, id: Id, data: LearningItemData, now: IsoTimestamp): Promise<boolean> {
    const item = this.items.find((i) => i.id === id && i.actorId === actorId && i.expiresAt > now);
    if (!item) return false;
    item.data = structuredClone(data);
    return true;
  }
  async delete(actorId: Id, id: Id): Promise<boolean> {
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.id === id && i.actorId === actorId));
    return this.items.length < before;
  }
  async deleteBySourceMemory(actorId: Id, memoryId: Id): Promise<number> {
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.actorId === actorId && i.sourceMemoryId === memoryId));
    return before - this.items.length;
  }
  async pruneExpired(now: IsoTimestamp, maxRows: number): Promise<number> {
    this.pruneCalls.push({ now, maxRows });
    const expired = this.items.filter((i) => i.expiresAt <= now).slice(0, maxRows).map((i) => i.id);
    this.items = this.items.filter((i) => !expired.includes(i.id));
    return expired.length;
  }
}

function rated(over: Partial<FeedbackRatedTurn> & { turnId: string }): FeedbackRatedTurn & { actorId: string } {
  return {
    actorId: 'actor-1',
    createdAt: '2026-10-05T09:00:00.000Z',
    taskId: `task-${over.turnId}`,
    intentType: IntentType.CHAT,
    capability: Capability.GENERAL_CHAT,
    positive: 0,
    negative: 0,
    ...over,
  };
}

function setup(over: {
  turns?: Array<FeedbackRatedTurn & { actorId: string }>;
  tasks?: Record<string, string>;
  replies?: LearningReplyLookup;
  remoteExamplesDisclosure?: boolean;
} = {}) {
  const turns = over.turns ?? [
    rated({ turnId: 't-neg', negative: 1, createdAt: '2026-10-05T10:00:00.000Z' }),
    rated({ turnId: 't-pos', positive: 1, createdAt: '2026-10-05T09:00:00.000Z', capability: undefined }),
  ];
  const tasks: Record<string, string> = over.tasks ?? { 'task-t-neg': '내일 회의 몇 시야?', 'task-t-pos': 'Summarize the release notes' };
  const feedbackQueries: FeedbackRatedTurnQuery[] = [];
  const feedback = {
    listRatedTurns: vi.fn(async (query: FeedbackRatedTurnQuery) => {
      feedbackQueries.push(query);
      return turns
        .filter((t) => t.actorId === query.actorId && t.createdAt >= query.since && (query.turnId === undefined || t.turnId === query.turnId))
        .slice(0, query.limit)
        .map(({ actorId: _actorId, ...turn }) => turn);
    }),
  };
  const learning = new FakeLearningRepository();
  let seq = 0;
  const service = new LearningService({
    feedback,
    learning,
    tasks: { get: async (id) => (tasks[id] === undefined ? null : { description: tasks[id] as string }) },
    ...(over.replies ? { replies: over.replies } : {}),
    idGenerator: () => `item-${++seq}`,
    ...(over.remoteExamplesDisclosure === undefined ? {} : { remoteExamplesDisclosure: over.remoteExamplesDisclosure }),
  });
  const run = (text: string, scope: LearningCommandScope = SCOPE, now: IsoTimestamp = NOW) => {
    const command = parseLearningCommand(text);
    if (!command) throw new Error(`not a learning command: ${text}`);
    return service.execute(command, scope, now);
  };
  return { service, learning, feedback, feedbackQueries, run, turns, tasks };
}

describe('LearningService — 피드백 후보 listing (ADR-0107 D3)', () => {
  it('lists the actor\'s recent rated turns, numbered newest first, with guarded excerpts and no provider id', async () => {
    const { run, feedbackQueries } = setup();
    const result = await run('피드백 후보');
    expect(result.status).toBe('RESPONDED');
    expect(result.text).toContain('1. 2026-10-05 · 👎 · 일반 대화 · "내일 회의 몇 시야?"');
    expect(result.text).toContain('2. 2026-10-05 · 👍 · 기타 · "Summarize the release notes"');
    expect(result.text).toContain('"후보 N 메모: 무엇이 잘못됐는지"');
    expect(result.text).toContain('이 기기에만 보관하고 1년 뒤 자동으로 지워져요');
    expect(feedbackQueries[0]).toEqual({ actorId: 'actor-1', since: at(-30 * 24 * 60 * 60 * 1000), limit: LEARNING_LISTING_LIMIT });
  });

  it('suppresses a credential-shaped request in the listing (guard at use)', async () => {
    const { run } = setup({ tasks: { 'task-t-neg': CREDENTIAL, 'task-t-pos': '평범한 요청' } });
    const result = await run('피드백 후보');
    expect(result.text).not.toContain('hunter2');
    expect(result.text).toContain('(민감한 내용일 수 있어 표시하지 않아요)');
  });

  it('hides a request only the strict (file-content) guard catches, in the candidate and the example listings', async () => {
    const strictOnly = 'const dbPassword = "SYNTHETIC_ONLY"';
    expect(learningTextRefusal(strictOnly)).toBe('CREDENTIAL');
    const { run, learning } = setup({ tasks: { 'task-t-neg': strictOnly, 'task-t-pos': '평범한 요청' } });
    const candidates = await run('피드백 후보');
    expect(candidates.text).not.toContain('SYNTHETIC_ONLY');
    expect(candidates.text).not.toContain('dbPassword');
    expect(candidates.text).toContain('1. 2026-10-05 · 👎 · 일반 대화 · (민감한 내용일 수 있어 표시하지 않아요)');
    expect(candidates.text).toContain('2. 2026-10-05 · 👍 · 기타 · "평범한 요청"');

    // A stored example whose request only the strict guard catches is never shown verbatim either.
    learning.items.push({
      id: 'legacy', actorId: SCOPE.actorId, kind: LearningItemKind.EXAMPLE, capability: Capability.GENERAL_CHAT,
      language: 'en', sourceTurnId: 't-old', egress: LEARNING_EGRESS_LOCAL_ONLY, createdAt: NOW,
      expiresAt: at(LEARNING_RETENTION_MS), data: { requestText: strictOnly, sourceRating: 'POSITIVE' },
    });
    const examples = await run('예시 목록');
    expect(examples.text).not.toContain('SYNTHETIC_ONLY');
    expect(examples.text).toContain('(민감한 내용이 감지돼 사용하지 않아요. 삭제를 권해요)');
  });

  it('answers a fixed empty copy when nothing is rated', async () => {
    const { run } = setup({ turns: [] });
    expect((await run('피드백 후보')).text).toContain('👍/👎를 남긴 답변이 없어요');
  });
});

describe('LearningService — consent: text is stored only by an explicit command on one listed item', () => {
  it('a listing alone stores nothing', async () => {
    const { run, learning } = setup();
    await run('피드백 후보');
    await run('예시 목록');
    expect(learning.items).toEqual([]);
  });

  it('후보 N 메모 on a 👎 turn saves one LOCAL_ONLY GOLDEN_CANDIDATE with the request, note and routing facts', async () => {
    const { run, learning } = setup();
    await run('피드백 후보');
    const result = await run('후보 1 메모: 회의 시간이 아니라 날씨를 답했어');
    expect(result.text).toContain('1번 답변의 메모를 학습 후보로 저장했어요');
    expect(learning.items).toHaveLength(1);
    expect(learning.items[0]).toEqual({
      id: 'item-1',
      actorId: 'actor-1',
      kind: LearningItemKind.GOLDEN_CANDIDATE,
      capability: Capability.GENERAL_CHAT,
      language: 'ko',
      sourceTurnId: 't-neg',
      egress: LEARNING_EGRESS_LOCAL_ONLY,
      createdAt: NOW,
      expiresAt: at(LEARNING_RETENTION_MS),
      data: {
        requestText: '내일 회의 몇 시야?',
        note: '회의 시간이 아니라 날씨를 답했어',
        sourceRating: 'NEGATIVE',
        intentType: IntentType.CHAT,
      },
    });
    expect(learning.pruneCalls).toEqual([{ now: NOW, maxRows: LEARNING_PRUNE_MAX_ROWS }]);
  });

  it('a second note on the same turn replaces the note instead of adding a row', async () => {
    const { run, learning } = setup();
    await run('피드백 후보');
    await run('후보 1 메모: 첫 메모');
    const result = await run('후보 1 메모: 고친 메모');
    expect(result.text).toContain('새 내용으로 바꿨어요');
    expect(learning.items).toHaveLength(1);
    expect(learning.items[0]?.data.note).toBe('고친 메모');
  });

  it('후보 N 예시로 저장 on a 👍 turn saves an EXAMPLE without an answer (no reply text is stored locally)', async () => {
    const { run, learning } = setup();
    await run('피드백 후보');
    const result = await run('후보 2 예시로 저장');
    expect(result.text).toContain('2번 답변을 예시로 저장했어요');
    expect(result.text).toContain('"예시 N 수정: 좋은 답변"');
    expect(learning.items).toHaveLength(1);
    expect(learning.items[0]).toMatchObject({
      kind: LearningItemKind.EXAMPLE, capability: LEARNING_CAPABILITY_UNKNOWN, language: 'en', sourceTurnId: 't-pos',
      data: { requestText: 'Summarize the release notes', sourceRating: 'POSITIVE' },
    });
    expect(learning.items[0]?.data.idealAnswer).toBeUndefined();
    expect((await run('후보 2 예시로 저장')).text).toContain('이미 예시로 저장돼 있어요');
    expect(learning.items).toHaveLength(1);
  });

  it('uses a locally stored reply as the ideal answer only when it passes the guard', async () => {
    const good = setup({ replies: { replyTextOf: async () => '릴리스 노트 요약입니다.' } });
    await good.run('피드백 후보');
    expect((await good.run('후보 2 예시로 저장')).text).toContain('답변도 함께 저장했어요');
    expect(good.learning.items[0]?.data.idealAnswer).toBe('릴리스 노트 요약입니다.');

    const leaky = setup({ replies: { replyTextOf: async () => `요약: ${CREDENTIAL}` } });
    await leaky.run('피드백 후보');
    await leaky.run('후보 2 예시로 저장');
    expect(leaky.learning.items[0]?.data.idealAnswer).toBeUndefined();
    expect(JSON.stringify(leaky.learning.items)).not.toContain('hunter2');
  });

  it('refuses a note on a 👍 turn and an example from a 👎 turn (a turn with both counts as 👎)', async () => {
    const { run, learning } = setup({
      turns: [
        rated({ turnId: 't-pos', positive: 1 }),
        rated({ turnId: 't-both', positive: 1, negative: 1, createdAt: '2026-10-05T08:00:00.000Z' }),
      ],
      tasks: { 'task-t-pos': '좋은 요청', 'task-t-both': '애매한 요청' },
    });
    await run('피드백 후보');
    expect((await run('후보 1 메모: 메모')).text).toContain('1번은 👍 답변이에요');
    expect((await run('후보 2 예시로 저장')).text).toContain('2번은 👎 답변이라 예시로 저장하지 않아요');
    expect(learning.items).toEqual([]);
    expect((await run('후보 2 메모: 둘 다 눌렀어')).text).toContain('학습 후보로 저장했어요');
  });

  it('re-checks the turn at save time: a retracted rating saves nothing', async () => {
    const { run, learning, turns } = setup();
    await run('피드백 후보');
    turns.splice(0, turns.length);
    expect((await run('후보 1 메모: 늦은 메모')).text).toContain('평가가 바뀌었거나 기간이 지났어요');
    expect(learning.items).toEqual([]);
  });
});

describe('LearningService — credential exclusion and bounds at capture', () => {
  it('refuses a credential-shaped note and never stores a redacted copy', async () => {
    const { run, learning } = setup();
    await run('피드백 후보');
    const result = await run(`후보 1 메모: ${CREDENTIAL}`);
    expect(result.text).toContain('민감한 정보가 들어 있어 저장하지 않았어요');
    expect(learning.items).toEqual([]);
  });

  it('refuses when the stored request itself is credential-shaped', async () => {
    const { run, learning } = setup({ tasks: { 'task-t-neg': `토큰: ghp_${'a'.repeat(36)}`, 'task-t-pos': 'x' } });
    await run('피드백 후보');
    expect((await run('후보 1 메모: 메모')).text).toContain('요청에 민감한 정보가 들어 있을 수 있어');
    expect(learning.items).toEqual([]);
  });

  it('refuses a note over 2,000 characters and a request over 2,000 characters (never truncated)', async () => {
    const long = setup({ tasks: { 'task-t-neg': '가'.repeat(LEARNING_TEXT_MAX_CHARS + 1), 'task-t-pos': 'x' } });
    await long.run('피드백 후보');
    expect((await long.run('후보 1 메모: 짧은 메모')).text).toContain('2,000자를 넘어');
    const { run, learning } = setup();
    await run('피드백 후보');
    expect((await run(`후보 1 메모: ${'나'.repeat(LEARNING_TEXT_MAX_CHARS + 1)}`)).text).toContain('2,000자 이하로');
    expect(learning.items).toEqual([]);
    expect(long.learning.items).toEqual([]);
  });

  it('refuses when the Task (request text) is no longer stored', async () => {
    const { run, learning } = setup({ tasks: {} });
    await run('피드백 후보');
    expect((await run('후보 1 메모: 메모')).text).toContain('요청 내용이 이 기기에 남아 있지 않아');
    expect(learning.items).toEqual([]);
  });

  it('refuses a save beyond the per-actor cap without evicting anything', async () => {
    const { run, learning } = setup();
    for (let i = 0; i < LEARNING_MAX_ITEMS_PER_ACTOR; i += 1) {
      learning.items.push({
        id: `old-${i}`, actorId: 'actor-1', kind: LearningItemKind.EXAMPLE, capability: 'GENERAL_CHAT', language: 'ko',
        egress: LEARNING_EGRESS_LOCAL_ONLY, createdAt: NOW, expiresAt: at(1000), data: { requestText: 'r', sourceRating: 'POSITIVE' },
      });
    }
    await run('피드백 후보');
    expect((await run('후보 1 메모: 메모')).text).toContain('최대 1,000개에 도달해');
    expect(learning.items).toHaveLength(LEARNING_MAX_ITEMS_PER_ACTOR);
  });
});

describe('LearningService — numbering is bound to the last listing', () => {
  it('asks for a listing first, refuses an out-of-range number and an expired listing', async () => {
    const { run, learning } = setup();
    expect((await run('후보 1 메모: 메모')).text).toContain('먼저 "피드백 후보"로 목록을 확인한 뒤');
    await run('피드백 후보');
    expect((await run('후보 3 메모: 메모')).text).toContain('목록에 3번이 없어요');
    expect((await run('후보 1 메모: 메모', SCOPE, at(LEARNING_LISTING_TTL_MS + 1))).text).toContain('먼저 "피드백 후보"');
    expect((await run('예시 1 삭제')).text).toContain('먼저 "예시 목록"');
    expect(learning.items).toEqual([]);
  });

  it('a listing in one scope never binds numbers for another actor or location', async () => {
    const { run, learning } = setup();
    await run('피드백 후보');
    expect((await run('후보 1 메모: 메모', OTHER_SCOPE)).text).toContain('먼저 "피드백 후보"');
    expect((await run('후보 1 메모: 메모', { ...SCOPE, threadId: 'th-1' })).text).toContain('먼저 "피드백 후보"');
    expect(learning.items).toEqual([]);
  });

  it('another actor\'s listing never shows this actor\'s turns', async () => {
    const { run, feedbackQueries } = setup();
    const result = await run('피드백 후보', OTHER_SCOPE);
    expect(result.text).toContain('👍/👎를 남긴 답변이 없어요');
    expect(feedbackQueries[0]?.actorId).toBe('actor-2');
  });
});

describe('LearningService — 예시 목록 / 수정 / 삭제', () => {
  async function withExample() {
    const ctx = setup();
    await ctx.run('피드백 후보');
    await ctx.run('후보 2 예시로 저장');
    return ctx;
  }

  it('lists examples, sets the ideal answer, and deletes exactly one row', async () => {
    const { run, learning } = await withExample();
    const listing = await run('예시 목록');
    expect(listing.text).toContain('1. 2026-10-06 · 요청 "Summarize the release notes" · 답변 없음');
    expect((await run('예시 1 수정: Here is a short summary.')).text).toContain('예시 1번의 답변을 바꿨어요');
    expect(learning.items[0]?.data.idealAnswer).toBe('Here is a short summary.');
    expect((await run('예시 목록')).text).toContain('답변 있음');
    expect((await run('예시 1 삭제')).text).toContain('예시 1번을 지웠어요');
    expect(learning.items).toEqual([]);
    expect((await run('예시 1 삭제')).text).toContain('이미 지워졌거나 기간이 지났어요');
  });

  it('refuses a credential-shaped or over-long ideal answer', async () => {
    const { run, learning } = await withExample();
    await run('예시 목록');
    expect((await run(`예시 1 수정: ${CREDENTIAL}`)).text).toContain('민감한 정보가 들어 있어 저장하지 않았어요');
    expect((await run(`예시 1 수정: ${'a'.repeat(LEARNING_TEXT_MAX_CHARS + 1)}`)).text).toContain('2,000자 이하로');
    expect(learning.items[0]?.data.idealAnswer).toBeUndefined();
  });

  it('guards again at use: a stored item that now matches the guard is hidden in the listing and cannot be edited', async () => {
    const { run, learning } = await withExample();
    (learning.items[0] as LearningItem).data.requestText = CREDENTIAL;
    const listing = await run('예시 목록');
    expect(listing.text).not.toContain('hunter2');
    expect(listing.text).toContain('민감한 내용이 감지돼 사용하지 않아요');
    expect((await run('예시 1 수정: 답변')).text).toContain('고칠 수 없어요');
    expect(learning.items[0]?.data.idealAnswer).toBeUndefined();
    expect((await run('예시 1 삭제')).text).toContain('지웠어요');
  });

  it('an expired example is not listed and is pruned on the next write', async () => {
    const { run, learning } = await withExample();
    expect((await run('예시 목록', SCOPE, at(LEARNING_RETENTION_MS))).text).toContain('저장된 예시가 없어요');
    (learning.items[0] as LearningItem).expiresAt = at(-1);
    expect((await run('예시 목록')).text).toContain('저장된 예시가 없어요');
    expect(learning.items).toHaveLength(1);
    await run('피드백 후보');
    await run('후보 1 메모: 새 메모');
    expect(learning.items.map((item) => item.kind)).toEqual([LearningItemKind.GOLDEN_CANDIDATE]);
  });

  it('the forget cascade deletes only the actor\'s items derived from that memory record', async () => {
    const { learning } = setup();
    const base = { kind: LearningItemKind.EXAMPLE, capability: 'GENERAL_CHAT', language: 'ko' as const,
      egress: LEARNING_EGRESS_LOCAL_ONLY, createdAt: NOW, expiresAt: at(1000),
      data: { requestText: 'r', sourceRating: 'POSITIVE' as const } };
    learning.items.push(
      { ...base, id: 'a', actorId: 'actor-1', sourceMemoryId: 'mem-1' },
      { ...base, id: 'b', actorId: 'actor-1', sourceMemoryId: 'mem-2' },
      { ...base, id: 'c', actorId: 'actor-2', sourceMemoryId: 'mem-1' },
    );
    expect(await learning.deleteBySourceMemory('actor-1', 'mem-1')).toBe(1);
    expect(learning.items.map((i) => i.id)).toEqual(['b', 'c']);
  });
});

describe('LearningService — ADR-0116 R4 remote-example disclosure', () => {
  const count = (text: string) => text.split(LEARNING_REMOTE_DISCLOSURE).length - 1;
  const script = ['피드백 후보', '후보 2 예시로 저장', '예시 목록', '후보 1 메모: 틀렸어', '후보 1 메모: 다시 고침', '예시 1 수정: 답'];

  async function texts(over: { remoteExamplesDisclosure?: boolean }) {
    const { run } = setup(over);
    const out: string[] = [];
    for (const line of script) out.push((await run(line)).text);
    return out;
  }

  it('the line is exactly the owner-approved copy', () => {
    expect(LEARNING_REMOTE_DISCLOSURE).toBe('직접 고른 클라우드 모델을 쓸 때는 이 예시가 대화와 함께 전송될 수 있어요.');
  });

  it('flag off or absent: every surface is byte-identical to the undisclosed copy', async () => {
    const absent = await texts({});
    expect(await texts({ remoteExamplesDisclosure: false })).toEqual(absent);
    expect(absent.join('\n')).not.toContain('클라우드');
  });

  it('flag on: exactly one disclosure line on the candidate listing, example save and example list only', async () => {
    const on = await texts({ remoteExamplesDisclosure: true });
    const off = await texts({});
    expect(on.map(count)).toEqual([1, 1, 1, 0, 0, 0]);
    for (const i of [0, 1, 2]) expect(on[i]).toBe(i === 2 ? `${off[i]}\n${LEARNING_REMOTE_DISCLOSURE}` : off[i]!.replace(/(저장한 내용은[^\n]*)$/, `$1\n${LEARNING_REMOTE_DISCLOSURE}`));
    for (const i of [3, 4, 5]) expect(on[i]).toBe(off[i]);
  });
});

describe('learning text guard helpers', () => {
  it('refuses empty, credential-shaped and over-long text, and accepts ordinary text', () => {
    expect(learningTextRefusal(undefined)).toBe('EMPTY');
    expect(learningTextRefusal('   ')).toBe('EMPTY');
    expect(learningTextRefusal(CREDENTIAL)).toBe('CREDENTIAL');
    expect(learningTextRefusal('const apiKey = "sk-abcdefghijklmnopqrstuvwx";')).toBe('CREDENTIAL');
    expect(learningTextRefusal('가'.repeat(LEARNING_TEXT_MAX_CHARS + 1))).toBe('TOO_LONG');
    expect(learningTextRefusal('가'.repeat(LEARNING_TEXT_MAX_CHARS))).toBeNull();
    expect(learningTextRefusal('비밀번호 정책 문서를 요약해줘')).toBeNull();
  });

  it('an item is usable only when every stored field passes', () => {
    expect(learningItemUsable({ requestText: 'r', sourceRating: 'POSITIVE', idealAnswer: 'a' })).toBe(true);
    expect(learningItemUsable({ requestText: 'r', sourceRating: 'POSITIVE', idealAnswer: CREDENTIAL })).toBe(false);
    expect(learningItemUsable({ requestText: CREDENTIAL, sourceRating: 'NEGATIVE', note: 'n' })).toBe(false);
  });

  it('exports the fixed failure copy for the handler', () => {
    expect(LEARNING_FAILURE_TEXT).toContain('잠시 후 다시 시도해 주세요');
  });
});
