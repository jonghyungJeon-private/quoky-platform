import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  IntentType,
  LEARNING_CAPABILITY_UNKNOWN,
  LearningItemKind,
  RiskLevel,
  TaskStatus,
} from '../../domain';
import type { LearningItem, LearningItemData, Task } from '../../domain';
import { NoProviderAvailableError } from '../../errors';
import type { AiProvider, LearningItemListQuery, Logger } from '../../ports';
import type { SemanticRecallScoring } from '../recall/semantic-recall-scorer';
import {
  CURATED_EXAMPLE_BUDGET_CHARS,
  CURATED_EXAMPLE_CANDIDATE_LIMIT,
  CURATED_EXAMPLE_MAX_PER_TURN,
  CuratedExampleSelector,
  curatedExampleChars,
  localOnlyProviderSelector,
} from './curated-example-selector';

const NOW = '2026-10-06T12:00:00.000Z';
const OWNER = 'owner-actor';
const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const taskOf = (description: string, over: Partial<Task> = {}, capability = Capability.GENERAL_CHAT): Task => ({
  id: 'task-1',
  title: description,
  description,
  status: TaskStatus.RUNNING,
  intent: { type: IntentType.CHAT, capability, confidence: 1, requiresWork: true, summary: description },
  riskLevel: RiskLevel.LOW,
  context: { platform: 'discord', channelId: 'c', userId: 'u' },
  actorId: OWNER,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

let seq = 0;
const itemOf = (
  requestText: string,
  idealAnswer: string | undefined,
  over: Partial<LearningItem> = {},
  data: Partial<LearningItemData> = {},
): LearningItem => {
  seq += 1;
  const createdAt = `2026-10-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`;
  return {
    id: `item-${seq}`,
    actorId: OWNER,
    kind: LearningItemKind.EXAMPLE,
    capability: Capability.GENERAL_CHAT,
    language: 'ko',
    sourceTurnId: `turn-${seq}`,
    egress: 'LOCAL_ONLY',
    createdAt,
    expiresAt: '2027-10-01T00:00:00.000Z',
    data: {
      requestText,
      ...(idealAnswer === undefined ? {} : { idealAnswer }),
      sourceRating: 'POSITIVE',
      ...data,
    },
    ...over,
  };
};

function selectorWith(items: LearningItem[], opts: { scorer?: SemanticRecallScoring; logger?: Logger } = {}) {
  const queries: LearningItemListQuery[] = [];
  const selector = new CuratedExampleSelector({
    learning: {
      async list(query) {
        queries.push(query);
        return items;
      },
    },
    ...(opts.scorer ? { semanticScorer: opts.scorer } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    clock: () => NOW,
  });
  return { selector, queries };
}

describe('CuratedExampleSelector (ADR-0107 D5, LRN-2)', () => {
  it('reads only the acting owner\'s unexpired EXAMPLE items, bounded', async () => {
    const { selector, queries } = selectorWith([]);
    await selector.select(taskOf('회의록 요약해줘'));
    expect(queries).toEqual([
      { actorId: OWNER, kind: LearningItemKind.EXAMPLE, now: NOW, limit: CURATED_EXAMPLE_CANDIDATE_LIMIT },
    ]);
  });

  it('selects nothing (and reads nothing) for a non-GENERAL_CHAT turn or a turn without an actor', async () => {
    const items = [itemOf('회의록 요약해줘', '세 줄 요약')];
    for (const capability of [Capability.POLICY_SENSITIVE_CHAT, Capability.SUMMARIZATION, Capability.CODE_IMPLEMENTATION]) {
      const { selector, queries } = selectorWith(items);
      expect(await selector.select(taskOf('회의록 요약해줘', {}, capability))).toEqual([]);
      expect(queries).toHaveLength(0);
    }
    const { selector, queries } = selectorWith(items);
    const anonymous = taskOf('회의록 요약해줘');
    delete anonymous.actorId;
    expect(await selector.select(anonymous)).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('ranks lexically, keeps at most two relevant examples, and maps them as LOCAL_ONLY non-authoritative entries', async () => {
    const strong = itemOf('회의록 요약 형식 알려줘', '세 줄로 요약하세요');
    const medium = itemOf('회의록 정리', '표로 정리하세요');
    const weak = itemOf('회의록 공유', '링크로 공유하세요');
    const unrelated = itemOf('날씨 어때', '맑아요');
    const { selector } = selectorWith([unrelated, weak, medium, strong]);
    const selected = await selector.select(taskOf('회의록 요약 형식'));
    expect(selected).toHaveLength(CURATED_EXAMPLE_MAX_PER_TURN);
    expect(selected[0]).toEqual({
      requestText: strong.data.requestText,
      idealAnswer: strong.data.idealAnswer,
      egress: 'LOCAL_ONLY',
      provenance: 'OWNER_CURATED_EXAMPLE',
      epistemicStatus: 'NON_AUTHORITATIVE_EXAMPLE',
      learningItemId: strong.id,
    });
    expect(selected.map((e) => e.learningItemId)).not.toContain(unrelated.id);
  });

  it('never selects an irrelevant example', async () => {
    const { selector } = selectorWith([itemOf('날씨 어때', '맑아요')]);
    expect(await selector.select(taskOf('회의록 요약해줘'))).toEqual([]);
  });

  it('drops items that may not be used: no ideal answer, credential (strict guard at use), wrong egress, kind, actor, capability, rating, expiry', async () => {
    const usable = itemOf('회의록 요약해줘', '세 줄 요약');
    const items = [
      itemOf('회의록 요약해줘', undefined),
      itemOf(`회의록 요약해줘 ${GITHUB_TOKEN}`, '세 줄 요약'),
      itemOf('회의록 요약해줘', 'const dbPassword = "Sup3rS3cretValue!";'),
      itemOf('회의록 요약해줘', '세 줄 요약', { egress: 'ANYWHERE' as unknown as 'LOCAL_ONLY' }),
      itemOf('회의록 요약해줘', '세 줄 요약', { kind: LearningItemKind.GOLDEN_CANDIDATE }),
      itemOf('회의록 요약해줘', '세 줄 요약', { actorId: 'someone-else' }),
      itemOf('회의록 요약해줘', '세 줄 요약', { capability: Capability.CODE_IMPLEMENTATION }),
      itemOf('회의록 요약해줘', '세 줄 요약', { capability: LEARNING_CAPABILITY_UNKNOWN }),
      itemOf('회의록 요약해줘', '세 줄 요약', {}, { sourceRating: 'NEGATIVE' }),
      itemOf('회의록 요약해줘', '세 줄 요약', { expiresAt: NOW }),
      itemOf('회의록 요약해줘', 'x'.repeat(2001)),
      usable,
    ];
    const { selector } = selectorWith(items);
    const selected = await selector.select(taskOf('회의록 요약해줘'));
    expect(selected.map((e) => e.learningItemId)).toEqual([usable.id]);
    expect(JSON.stringify(selected)).not.toContain('ghp_');
    expect(JSON.stringify(selected)).not.toContain('Sup3rS3cret');
  });

  it('keeps the selection inside the fixed budget, skipping (never truncating) an example that does not fit', async () => {
    const big = itemOf('회의록 요약해줘 자세히', '가'.repeat(2000 - 20));
    const second = itemOf('회의록 요약해줘 길게', '나'.repeat(1000));
    const small = itemOf('회의록 요약해줘 짧게', '다'.repeat(50));
    const { selector } = selectorWith([big, second, small]);
    const selected = await selector.select(taskOf('회의록 요약해줘'));
    const total = selected.reduce((sum, e) => sum + curatedExampleChars(e), 0);
    expect(total).toBeLessThanOrEqual(CURATED_EXAMPLE_BUDGET_CHARS);
    expect(selected.map((e) => e.idealAnswer)).toEqual(
      expect.arrayContaining([small.data.idealAnswer]),
    );
    for (const e of selected) {
      const source = [big, second, small].find((i) => i.id === e.learningItemId);
      expect(e.idealAnswer).toBe(source?.data.idealAnswer);
    }
  });

  it('blends the local semantic score when the scorer returns one, and offers it only request text', async () => {
    const lexicalOnly = itemOf('회의록 요약', '렉시컬 답');
    const semanticOnly = itemOf('미팅 노트 정리 부탁', '시맨틱 답');
    const seen: Array<{ query: string; ids: string[]; contents: string[] }> = [];
    const scorer: SemanticRecallScoring = {
      async score(query, candidates) {
        seen.push({ query, ids: candidates.map((c) => c.id), contents: candidates.map((c) => c.content) });
        return new Map([
          [semanticOnly.id, 0.95],
          [lexicalOnly.id, 0.1],
        ]);
      },
    };
    const { selector } = selectorWith([lexicalOnly, semanticOnly], { scorer });
    const selected = await selector.select(taskOf('회의록 요약해줘'));
    expect(selected.map((e) => e.learningItemId)).toEqual([semanticOnly.id, lexicalOnly.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.query).toBe('회의록 요약해줘');
    expect(seen[0]?.contents).toEqual(expect.arrayContaining(['회의록 요약', '미팅 노트 정리 부탁']));
    expect(seen[0]?.contents.join(' ')).not.toContain('답');
  });

  it('falls back to lexical ranking when the scorer returns null or throws', async () => {
    const item = itemOf('회의록 요약', '렉시컬 답');
    for (const scorer of [
      { score: async () => null },
      { score: async () => { throw new Error('embedding down'); } },
    ] satisfies SemanticRecallScoring[]) {
      const { selector } = selectorWith([item, itemOf('미팅 노트', '무관')], { scorer });
      expect((await selector.select(taskOf('회의록 요약해줘'))).map((e) => e.learningItemId)).toEqual([item.id]);
    }
  });

  it('degrades to no examples when the store fails, and logs counts only', async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const failing = new CuratedExampleSelector({
      learning: { list: async () => { throw new Error('db locked'); } },
      logger: { info, warn, error: vi.fn() },
      clock: () => NOW,
    });
    expect(await failing.select(taskOf('회의록 요약해줘'))).toEqual([]);
    expect(warn).toHaveBeenCalledWith('curated examples unavailable; none used', { reason: 'LIST_FAILED' });

    const { selector } = selectorWith([itemOf('회의록 요약', '비밀스러운 답')], { logger: { info, warn, error: vi.fn() } });
    await selector.select(taskOf('회의록 요약해줘'));
    expect(info).toHaveBeenCalledWith('curated examples selected', {
      candidates: 1,
      eligible: 1,
      relevant: 1,
      selected: 1,
      scorer: 'lexical',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('비밀스러운');
  });
});

describe('localOnlyProviderSelector (ADR-0107 D6)', () => {
  const providerOf = (executionLocality?: 'LOCAL' | 'REMOTE'): AiProvider => ({
    id: 'embedder',
    capabilities: [{ capability: Capability.EMBEDDING, priority: 1 }],
    ...(executionLocality === undefined ? {} : { executionLocality }),
    isAvailable: async () => true,
    execute: async () => ({ text: '' }),
  });

  it('passes a LOCAL provider through and treats REMOTE or an absent declaration as no provider', async () => {
    const local = providerOf('LOCAL');
    expect(await localOnlyProviderSelector({ select: async () => local }).select(Capability.EMBEDDING)).toBe(local);
    for (const provider of [providerOf('REMOTE'), providerOf()]) {
      await expect(
        localOnlyProviderSelector({ select: async () => provider }).select(Capability.EMBEDDING),
      ).rejects.toBeInstanceOf(NoProviderAvailableError);
    }
  });
});
