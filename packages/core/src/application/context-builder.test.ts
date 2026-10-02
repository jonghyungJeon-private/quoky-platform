import { describe, expect, it } from 'vitest';
import { ContextBuilder } from './context-builder';
import { PromptComposer } from './prompt-composer';
import {
  Capability,
  IntentType,
  MemoryType,
  RiskLevel,
  TaskStatus,
  createDurableMemory,
  createRetrievedMemory,
} from '../domain';
import type {
  DurableMemoryScope,
  MemoryRecord,
  MemoryRetrievalRequest,
  MemoryScope,
  Task,
} from '../domain';
import type { MemoryManager } from './memory-manager';
import type { MemoryRetriever } from './memory-retriever';
import { DefaultMemoryRetriever } from './memory-retriever';
import type { DurableMemoryQuery, MemoryRepository } from '../ports';

const taskWith = (
  opts: {
    sessionId?: string;
    projectId?: string;
    actorId?: string;
    platform?: string;
    requestText?: string;
    capability?: Capability;
  } = {},
): Task => ({
  id: 't1',
  title: 't',
  description: opts.requestText ?? 'hello',
  status: TaskStatus.PENDING,
  intent: {
    type: IntentType.CHAT,
    capability: opts.capability ?? Capability.GENERAL_CHAT,
    confidence: 1,
    requiresWork: true,
    summary: opts.requestText ?? 'hello',
  },
  riskLevel: RiskLevel.LOW,
  context: {
    platform: opts.platform ?? 'discord',
    channelId: 'c',
    userId: 'u',
  },
  ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  ...(opts.projectId ? { projectId: opts.projectId } : {}),
  ...((opts.actorId ?? 'A1') ? { actorId: opts.actorId ?? 'A1' } : {}),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const rec = (id: string, role: unknown, content: string): MemoryRecord => ({
  id,
  type: MemoryType.SHORT_TERM,
  scope: {},
  content,
  ...(role === undefined ? {} : { metadata: { role } }),
  createdAt: `2026-01-01T00:00:${id.padStart(2, '0')}.000Z`,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const durable = (
  id: string,
  content: string,
  opts: {
    provenance?: 'USER_PROVIDED' | 'ASSISTANT_GENERATED';
    authorityLevel?: 'USER_CLAIM_OR_INTENT' | 'ASSISTANT_NON_AUTHORITATIVE';
    relevanceScore?: number;
    scope?: DurableMemoryScope;
    createdAt?: string;
  } = {},
) =>
  createRetrievedMemory({
    memory: createDurableMemory({
      id,
      content,
      kind: 'SEMANTIC',
      provenance: opts.provenance ?? 'USER_PROVIDED',
      authorityLevel: opts.authorityLevel ?? 'USER_CLAIM_OR_INTENT',
      scope: opts.scope ?? { sessionId: 'S1' },
      createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
      updatedAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
      metadata: { sourceRecordId: `source-${id}` },
    }),
    relevanceScore: opts.relevanceScore ?? 0.9,
    retrievalReason: 'bounded task scope and semantic relevance matched',
  });

describe('ContextBuilder (ADR-0063 structured context)', () => {
  it('integrates bounded durable recall as separately attributed background', async () => {
    let request: MemoryRetrievalRequest | undefined;
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'exact transcript')],
      projectMemory: async () => undefined,
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async (value) => {
        request = value;
        return [
          durable('durable-1', 'Remember the purple preference', {
            scope: { sessionId: 'S1', projectId: 'P1' },
          }),
        ];
      },
    };

    const bundle = await new ContextBuilder(memory, {}, retriever).build(
      taskWith({
        sessionId: 'S1',
        projectId: 'P1',
        capability: Capability.SUMMARIZATION,
      }),
    );

    expect(request).toMatchObject({
      query: 'hello',
      capability: Capability.SUMMARIZATION,
      scope: { actorId: 'A1' },
      maxResults: 10,
    });
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'exact transcript',
    ]);
    expect(bundle.conversationTranscript).not.toContainEqual(
      expect.objectContaining({ content: 'Remember the purple preference' }),
    );
    expect(bundle.durableRecall).toEqual([
      expect.objectContaining({
        content: 'Remember the purple preference',
        provenance: 'USER_PROVIDED',
        epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND',
        source: expect.objectContaining({
          memoryId: 'durable-1',
          kind: 'SEMANTIC',
          authorityLevel: 'USER_CLAIM_OR_INTENT',
          scope: { sessionId: 'S1', projectId: 'P1' },
          metadata: { sourceRecordId: 'source-durable-1' },
        }),
      }),
    ]);
  });

  it('requests durable retrieval by actor only', async () => {
    let request: MemoryRetrievalRequest | undefined;
    const memory = {
      recentShortTerm: async () => [],
      projectMemory: async () => undefined,
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async (value) => {
        request = value;
        return [];
      },
    };

    await new ContextBuilder(memory, {}, retriever).build(
      taskWith({ sessionId: 'S1', projectId: 'P1', actorId: 'A1' }),
    );

    expect(request?.scope).toEqual({ actorId: 'A1' });
  });

  it('suppresses exact-content durable recall without displacing exact transcript continuity', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', '보라색 선호를 기억해 줘'),
        rec('2', 'assistant', '기억할게요'),
      ],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [durable('duplicate', '보라색 선호를 기억해 줘')],
    };
    const task = taskWith({ sessionId: 'S1', requestText: '내 선호가 뭐였지?' });

    const bundle = await new ContextBuilder(memory, {}, retriever).build(task);
    const prompt = new PromptComposer().compose(task, bundle);

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      '보라색 선호를 기억해 줘',
      '기억할게요',
    ]);
    expect(bundle.durableRecall).toBeUndefined();
    expect(prompt.context).not.toContain('immediatelyPreviousUserTurn');
    expect(prompt.context).toContain('보라색 선호를 기억해 줘');
  });

  it('excludes credential-like durable records from recall at read time', async () => {
    const memory = {
      recentShortTerm: async () => [],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [
        durable('secret', '내 비밀번호는 hunter2야'),
        durable('json-secret', '{"password":"demo-value"}'),
        durable('ko-no-space', '비밀번호는테스트값이야'),
        durable('ok', '내 배포 창은 화요일이야'),
        durable('ok-uat', '내 UAT 확인 단어는 파랑 고래야'),
        durable('ok-policy', '비밀번호 정책 문서는 Confluence에 있어'),
        durable('ok-crypto', '암호화 방식은 AES야'),
      ],
    };

    const bundle = await new ContextBuilder(memory, {}, retriever).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.durableRecall?.map((entry) => entry.content).sort()).toEqual(
      [
        '내 배포 창은 화요일이야',
        '내 UAT 확인 단어는 파랑 고래야',
        '비밀번호 정책 문서는 Confluence에 있어',
        '암호화 방식은 AES야',
      ].sort(),
    );
  });

  it('keeps non-identical durable content because transcript deduplication is identity-based', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', '보라색 선호를 기억해 줘')],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [durable('similar', '보라색, 선호를 기억해 줘!')],
    };

    const bundle = await new ContextBuilder(memory, {}, retriever).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      '보라색 선호를 기억해 줘',
    ]);
    expect(bundle.durableRecall?.map((entry) => entry.content)).toEqual([
      '보라색, 선호를 기억해 줘!',
    ]);
  });

  it('applies the final shared budget after preserving selected transcript', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', '12345')],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [durable('budgeted', 'abcdefghij')],
    };

    const bundle = await new ContextBuilder(
      memory,
      { maxCharacters: 8, roleWeights: { user: 10 }, recencyWeight: 0 },
      retriever,
    ).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript[0]?.content).toBe('12345');
    expect(bundle.durableRecall?.[0]?.content).toBe('ab…');
    expect(
      bundle.conversationTranscript.reduce((sum, entry) => sum + entry.content.length, 0) +
        (bundle.durableRecall ?? []).reduce((sum, entry) => sum + entry.content.length, 0),
    ).toBeLessThanOrEqual(8);
  });

  it('protects required transcript continuity before allocating any durable remainder', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'assistant', 'low-ranked transcript')],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [durable('relevant', 'durable wins', { relevanceScore: 1 })],
    };

    const bundle = await new ContextBuilder(
      memory,
      {
        maxCharacters: 12,
        roleWeights: { assistant: 0 },
        recencyWeight: 0,
      },
      retriever,
    ).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'low-ranked …',
    ]);
    expect(bundle.durableRecall).toBeUndefined();
  });

  it('preserves the newest User turn as transcript continuity under durable pressure', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'assistant', 'latest assistant continuity'),
        rec('2', 'user', 'exact newest user turn'),
      ],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [
        durable('high-score', 'high scoring durable background', { relevanceScore: 1 }),
      ],
    };
    const task = taskWith({ sessionId: 'S1', requestText: 'current request' });

    const bundle = await new ContextBuilder(
      memory,
      {
        maxCharacters: 52,
        roleWeights: { user: 0, assistant: 0 },
        recencyWeight: 0,
      },
      retriever,
    ).build(task);
    const prompt = new PromptComposer().compose(task, bundle);

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'latest assistant continuity',
      'exact newest user turn',
    ]);
    expect(bundle.durableRecall?.map((entry) => entry.content)).toEqual(['hi…']);
    expect(prompt.context).not.toContain('immediatelyPreviousUserTurn');
    expect(prompt.context).toContain('exact newest user turn');
  });

  it('applies configured transcript compression when durable recall candidates are present', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'assistant', 'abcdefghijkl'),
        rec('2', 'user', 'mnopqrstuvwx'),
      ],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [durable('compression-pressure', 'durable background')],
    };

    const bundle = await new ContextBuilder(
      memory,
      {
        maxTokens: 4,
        recencyWeight: 0,
        roleWeights: { assistant: 0, user: 10 },
        compressionConfig: { minimumCharactersPerEntry: 4 },
      },
      retriever,
    ).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'abc…',
      'mnopqrstuvwx',
    ]);
    expect(bundle.durableRecall).toBeUndefined();
  });

  it('admits zero durable entries when higher-scored transcript consumes the budget', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', '12345')],
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [durable('not-admitted', 'durable')],
    };

    const bundle = await new ContextBuilder(
      memory,
      { maxCharacters: 5, roleWeights: { user: 10 }, recencyWeight: 0 },
      retriever,
    ).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['12345']);
    expect(bundle.durableRecall).toBeUndefined();
  });

  it('orders selected durable recall chronologically after ranked budget admission', async () => {
    const memory = { recentShortTerm: async () => [] } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () => [
        durable('newer', 'newer durable', {
          relevanceScore: 0.8,
          createdAt: '2026-01-03T00:00:00.000Z',
        }),
        durable('older', 'older durable', {
          relevanceScore: 0.9,
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
      ],
    };

    const bundle = await new ContextBuilder(
      memory,
      { maxCharacters: 100, recencyWeight: 0 },
      retriever,
    ).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.durableRecall?.map((entry) => entry.content)).toEqual([
      'older durable',
      'newer durable',
    ]);
  });

  it('preserves legacy behavior for absent, empty, failed, and actor-less retrieval', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'legacy transcript')],
    } as unknown as MemoryManager;
    let failedCalls = 0;
    const emptyRetriever: MemoryRetriever = { retrieve: async () => [] };
    const failedRetriever: MemoryRetriever = {
      retrieve: async () => {
        failedCalls += 1;
        throw new Error('degraded recall');
      },
    };
    const unscopedRetriever: MemoryRetriever = {
      retrieve: async () => {
        throw new Error('must not broaden to channel scope');
      },
    };
    const scopedTask = taskWith({ sessionId: 'S1' });

    const baseline = await new ContextBuilder(memory).build(scopedTask);
    const empty = await new ContextBuilder(memory, {}, emptyRetriever).build(scopedTask);
    const failed = await new ContextBuilder(memory, {}, failedRetriever).build(scopedTask);
    const unscoped = await new ContextBuilder(memory, {}, unscopedRetriever).build(taskWith({ actorId: '' }));

    expect(empty).toEqual(baseline);
    expect(failed).toEqual(baseline);
    expect(failedCalls).toBe(1);
    expect(unscoped.durableRecall).toBeUndefined();
  });

  it('degrades repository failure through ContextBuilder without retry or context substitution', async () => {
    const transcript = [
      rec('1', 'user', 'exact short-term user turn'),
      rec('2', 'assistant', 'exact short-term assistant turn'),
    ];
    const project = {
      ...rec('3', undefined, 'exact active-project background'),
      type: MemoryType.PROJECT,
      scope: { projectId: 'P1' },
    };
    const memory = {
      recentShortTerm: async () => transcript,
      projectMemory: async (projectId: string) => (projectId === 'P1' ? project : undefined),
    } as unknown as MemoryManager;
    const queries: DurableMemoryQuery[] = [];
    const failingRepository: MemoryRepository = {
      async get() {
        return null;
      },
      async save(entity) {
        return entity;
      },
      async delete() {},
      async list() {
        return [];
      },
      async findByScope() {
        return [];
      },
      async findDurableCandidates(query) {
        queries.push(query);
        throw new Error('repository unavailable');
      },
    };
    const retriever = new DefaultMemoryRetriever(failingRepository, {
      clock: () => '2026-01-04T00:00:00.000Z',
    });

    const bundle = await new ContextBuilder(memory, {}, retriever).build(
      taskWith({ sessionId: 'S1', projectId: 'P1' }),
    );

    expect(queries).toEqual([
      expect.objectContaining({
        scope: { userId: 'A1' },
        limit: 50,
      }),
    ]);
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'exact short-term user turn',
      'exact short-term assistant turn',
    ]);
    expect(bundle.backgroundResources.map((entry) => entry.content)).toEqual([
      'exact active-project background',
    ]);
    expect(bundle.durableRecall).toBeUndefined();
  });

  it('discards malformed resolved durable candidates while retaining valid recall and transcript', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'exact short-term context')],
    } as unknown as MemoryManager;
    const valid = durable('valid', 'valid durable context');
    const retriever: MemoryRetriever = {
      retrieve: async () =>
        [
          valid,
          { ...valid, relevanceScore: Number.NaN },
          { ...valid, memory: { ...valid.memory, content: '   ' } },
          { memory: null },
        ] as unknown as Awaited<ReturnType<MemoryRetriever['retrieve']>>,
    };

    const bundle = await new ContextBuilder(memory, {}, retriever).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'exact short-term context',
    ]);
    expect(bundle.durableRecall?.map((entry) => entry.content)).toEqual([
      'valid durable context',
    ]);
  });

  it('degrades all-malformed resolved durable recall to empty without losing existing context', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'exact short-term context')],
      projectMemory: async () => rec('2', 'project', 'project background'),
    } as unknown as MemoryManager;
    const retriever: MemoryRetriever = {
      retrieve: async () =>
        [null, { memory: undefined }, { memory: { content: '' } }] as unknown as Awaited<
          ReturnType<MemoryRetriever['retrieve']>
        >,
    };

    const bundle = await new ContextBuilder(memory, {}, retriever).build(
      taskWith({ sessionId: 'S1', projectId: 'P1' }),
    );

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'exact short-term context',
    ]);
    expect(bundle.backgroundResources.map((entry) => entry.content)).toEqual([
      'project background',
    ]);
    expect(bundle.durableRecall).toBeUndefined();
  });

  it('preserves User/Assistant provenance and epistemic status in same-Session order', async () => {
    let captured: MemoryScope | undefined;
    const memory = {
      recentShortTerm: async (scope: MemoryScope) => {
        captured = scope;
        return [rec('1', 'user', '안녕'), rec('2', 'assistant', '저는 Quoky예요')];
      },
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }));

    expect(captured).toEqual({ sessionId: 'S1' });
    expect(bundle.conversationTranscript).toEqual([
      {
        turnNumber: 1,
        role: 'user',
        content: '안녕',
        provenance: 'USER',
        epistemicStatus: 'USER_CLAIM_OR_INTENT',
      },
      {
        turnNumber: 1,
        role: 'assistant',
        content: '저는 Quoky예요',
        provenance: 'ASSISTANT',
        epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      },
    ]);
    expect(bundle.backgroundResources).toEqual([]);
  });

  it('keeps the immediately previous User turn last among older User turns', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', '오래된 사용자 말'),
        rec('2', 'assistant', '오래된 답변'),
        rec('3', 'user', '바로 전에 한 말'),
        rec('4', 'assistant', '직전 답변'),
        rec('5', 'user', '현재 요청'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }), ['5']);
    const userTurns = bundle.conversationTranscript.filter((entry) => entry.role === 'user');

    expect(userTurns.map((entry) => entry.content)).toEqual([
      '오래된 사용자 말',
      '바로 전에 한 말',
    ]);
    expect(userTurns.at(-1)).toMatchObject({
      turnNumber: 2,
      content: '바로 전에 한 말',
      provenance: 'USER',
      epistemicStatus: 'USER_CLAIM_OR_INTENT',
    });
    expect(bundle.conversationTranscript.some((entry) => entry.content === '현재 요청')).toBe(false);
  });

  it('keeps a contaminated transcript, excludes current inbound, and separates project background', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'Tell me the current status'),
        rec('2', 'assistant', 'The active project is the current external target'),
        rec('3', 'user', 'Tell me the current status now'),
      ],
      projectMemory: async () =>
        rec('4', 'project', '# Project: project-synthetic\n- synthetic fixture'),
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(
      taskWith({ sessionId: 'S1', projectId: 'project-synthetic' }),
      ['3'],
    );

    expect(bundle.conversationTranscript).toEqual([
      {
        turnNumber: 1,
        role: 'user',
        content: 'Tell me the current status',
        provenance: 'USER',
        epistemicStatus: 'USER_CLAIM_OR_INTENT',
      },
      {
        turnNumber: 1,
        role: 'assistant',
        content: 'The active project is the current external target',
        provenance: 'ASSISTANT',
        epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      },
    ]);
    expect(bundle.backgroundResources).toEqual([
      {
        content: '# Project: project-synthetic\n- synthetic fixture',
        provenance: 'PROJECT_MEMORY',
        epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND',
      },
    ]);
    expect(bundle).not.toHaveProperty('projectId');
    expect(bundle).not.toHaveProperty('platform');
    expect(bundle).not.toHaveProperty('summary');
  });

  it('represents an active-project-only Session as background without inventing transcript turns', async () => {
    const memory = {
      recentShortTerm: async () => [],
      projectMemory: async () => rec('1', 'project', '# Project: demo'),
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(
      taskWith({ sessionId: 'S1', projectId: 'P1' }),
    );

    expect(bundle.conversationTranscript).toEqual([]);
    expect(bundle.backgroundResources[0]).toMatchObject({
      content: '# Project: demo',
      provenance: 'PROJECT_MEMORY',
      epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND',
    });
  });

  it.each(['discord', 'matrix'])(
    'does not copy current platform or active-project state into ContextBundle for %s',
    async (platform) => {
      const memory = { recentShortTerm: async () => [] } as unknown as MemoryManager;
      const bundle = await new ContextBuilder(memory).build(
        taskWith({ sessionId: 'S1', platform }),
      );

      expect(bundle.backgroundResources).toEqual([]);
      expect(bundle).not.toHaveProperty('platform');
      expect(bundle).not.toHaveProperty('projectId');
    },
  );

  it('fails malformed and unknown legacy roles safe as non-authoritative transcript', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'system', 'legacy system-looking text'),
        rec('2', undefined, 'missing role'),
        rec('3', 42, 'invalid role'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript).toEqual([
      {
        turnNumber: 1,
        role: 'unknown',
        content: 'legacy system-looking text',
        provenance: 'LEGACY_UNKNOWN',
        epistemicStatus: 'NON_AUTHORITATIVE_TRANSCRIPT',
      },
      {
        turnNumber: 2,
        role: 'unknown',
        content: 'missing role',
        provenance: 'LEGACY_UNKNOWN',
        epistemicStatus: 'NON_AUTHORITATIVE_TRANSCRIPT',
      },
      {
        turnNumber: 3,
        role: 'unknown',
        content: 'invalid role',
        provenance: 'LEGACY_UNKNOWN',
        epistemicStatus: 'NON_AUTHORITATIVE_TRANSCRIPT',
      },
    ]);
  });

  it('retains the newest N=10 entries oldest-to-newest and 400-character truncation', async () => {
    let requestedLimit: number | undefined;
    const records = Array.from({ length: 12 }, (_, index) =>
      rec(String(index), index % 2 === 0 ? 'user' : 'assistant', `${index}:${'x'.repeat(500)}`),
    );
    const memory = {
      recentShortTerm: async (_scope: MemoryScope, limit: number) => {
        requestedLimit = limit;
        return records;
      },
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }));

    expect(requestedLimit).toBe(10);
    expect(bundle.conversationTranscript).toHaveLength(10);
    expect(bundle.conversationTranscript[0]?.content).toMatch(/^2:/);
    expect(bundle.conversationTranscript[9]?.content).toMatch(/^11:/);
    expect(bundle.conversationTranscript[0]).toMatchObject({ turnNumber: 1, role: 'user' });
    expect(bundle.conversationTranscript[1]).toMatchObject({ turnNumber: 1, role: 'assistant' });
    expect(bundle.conversationTranscript[9]).toMatchObject({ turnNumber: 5, role: 'assistant' });
    expect(bundle.conversationTranscript.every((entry) => entry.content.length === 401)).toBe(true);
    expect(bundle.conversationTranscript.every((entry) => entry.content.endsWith('…'))).toBe(true);
    expect(
      bundle.conversationTranscript
        .filter((entry) => entry.provenance === 'ASSISTANT')
        .every((entry) => entry.epistemicStatus === 'ASSISTANT_NON_AUTHORITATIVE'),
    ).toBe(true);
    expect(
      bundle.conversationTranscript
        .filter((entry) => entry.provenance === 'USER')
        .every((entry) => entry.epistemicStatus === 'USER_CLAIM_OR_INTENT'),
    ).toBe(true);
  });

  it('orders an unordered retrieval by creation time before applying the N=10 cap', async () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      rec(String(index), 'user', `turn-${index}`),
    );
    const memory = {
      recentShortTerm: async () => [
        records[11]!,
        records[1]!,
        records[8]!,
        records[0]!,
        records[10]!,
        records[3]!,
        records[7]!,
        records[2]!,
        records[9]!,
        records[4]!,
        records[6]!,
        records[5]!,
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `turn-${index + 2}`),
    );
  });

  it('requests enough records to preserve N=10 after current-inbound exclusion', async () => {
    let requestedLimit: number | undefined;
    const memory = {
      recentShortTerm: async (_scope: MemoryScope, limit: number) => {
        requestedLimit = limit;
        return [rec('1', 'user', 'previous'), rec('2', 'user', 'current')];
      },
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }), ['2']);

    expect(requestedLimit).toBe(11);
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['previous']);
  });

  it('keeps the immediately previous User turn when excluding an explicit recall request', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', '안녕?'),
        rec('2', 'assistant', '안녕하세요!'),
        rec('3', 'user', '내가 방금 뭐라고 했지?'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }), ['3']);

    expect(bundle.conversationTranscript).toEqual([
      {
        turnNumber: 1,
        role: 'user',
        content: '안녕?',
        provenance: 'USER',
        epistemicStatus: 'USER_CLAIM_OR_INTENT',
      },
      {
        turnNumber: 1,
        role: 'assistant',
        content: '안녕하세요!',
        provenance: 'ASSISTANT',
        epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      },
    ]);
    expect(bundle.conversationTranscript.at(-2)?.content).toBe('안녕?');
    expect(
      bundle.conversationTranscript.some((entry) => entry.content === '내가 방금 뭐라고 했지?'),
    ).toBe(false);
  });

  it('keeps multiple prior User turns chronological while excluding the current inbound turn', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', '오래된 사용자 말'),
        rec('2', 'assistant', '오래된 답변'),
        rec('3', 'user', '바로 이전 사용자 말'),
        rec('4', 'assistant', '바로 이전 답변'),
        rec('5', 'user', '현재 사용자 요청'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory).build(taskWith({ sessionId: 'S1' }), ['5']);
    const userTurns = bundle.conversationTranscript.filter((entry) => entry.role === 'user');

    expect(userTurns.map((entry) => entry.content)).toEqual([
      '오래된 사용자 말',
      '바로 이전 사용자 말',
    ]);
    expect(userTurns.at(-1)?.content).toBe('바로 이전 사용자 말');
    expect(
      bundle.conversationTranscript.some((entry) => entry.content === '현재 사용자 요청'),
    ).toBe(false);
  });

  it('selects the most recent conversation entry first when the ranking budget is bounded', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'older'),
        rec('2', 'user', 'newest'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxCharacters: 6,
      roleWeights: { user: 0 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['newest']);
  });

  it('protects newest User and Assistant continuity when relevanceWeight is omitted', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'hello but older'),
        rec('2', 'assistant', 'newest unrelated'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxCharacters: 16,
      roleWeights: { user: 0, assistant: 0 },
      recencyWeight: 2,
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'hello but older',
      '…',
    ]);
  });

  it('uses role relevance to prefer User history over Assistant history', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'user-fact'),
        rec('2', 'assistant', 'assistant-answer'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxCharacters: 9,
      recencyWeight: 0,
      roleWeights: { user: 10, assistant: 0 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['user-fact']);
  });

  it('uses semantic relevance with normalized recency when the blend is configured', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'hello context ranking'),
        rec('2', 'user', 'weather tomorrow forecast'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxCharacters: 21,
      roleWeights: { user: 0 },
      recencyWeight: 0.25,
      relevanceWeight: 0.75,
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'weather tomorrow for…',
    ]);
  });

  it('retains an earlier explicit User fact through unrelated turns into the provider prompt', async () => {
    const fact = '코드 이름은 은하수-731, 선호 색은 보라색, 확인 번호는 4829야.';
    const records = [rec('1', 'user', fact)];
    for (let turn = 1; turn <= 5; turn += 1) {
      records.push(
        rec(String(turn * 2), 'assistant', `무관한 답변 ${turn}`),
        rec(String(turn * 2 + 1), 'user', `무관한 질문 ${turn}`),
      );
    }
    records.push(rec('12', 'user', '내가 말한 세 가지 값을 기억해?'));

    let requestedLimit: number | undefined;
    const memory = {
      recentShortTerm: async (_scope: MemoryScope, limit: number) => {
        requestedLimit = limit;
        return records.slice(-limit);
      },
    } as unknown as MemoryManager;
    const task = taskWith({
      sessionId: 'S1',
      requestText: '내가 말한 세 가지 값을 기억해?',
    });
    const bundle = await new ContextBuilder(memory, {
      rankingEnabled: true,
      compressionEnabled: true,
      maxTokens: 1024,
      recencyWeight: 0.4,
      relevanceWeight: 0.6,
      compressionConfig: { minimumCharactersPerEntry: 80 },
    }).build(task, ['12']);
    const prompt = new PromptComposer().compose(task, bundle);

    expect(requestedLimit).toBe(21);
    expect(bundle.conversationTranscript).toHaveLength(10);
    expect(bundle.conversationTranscript.some((entry) => entry.content === fact)).toBe(true);
    expect(bundle.conversationTranscript.some((entry) => entry.content === task.description)).toBe(
      false,
    );
    expect(prompt.context).toContain(fact);
    expect(prompt.context).not.toContain('immediatelyPreviousUserTurn');
    expect(prompt.context).toContain('무관한 질문 5');
    expect(prompt.task).toContain(task.description);
  });

  it('keeps immediate turn continuity when explicit User values saturate the ranking window', async () => {
    const records = Array.from({ length: 12 }, (_, index) =>
      rec(
        String(index + 1),
        'user',
        `작업 ${index} 완료했고 예산은 ${1000 + index}원이야`,
      ),
    );
    for (let turn = 1; turn <= 4; turn += 1) {
      records.push(
        rec(String(11 + turn * 2), 'assistant', `최근 안내 ${turn}`),
        rec(
          String(12 + turn * 2),
          'user',
          turn === 4 ? '그러면 다음은 어떻게 하면 좋을까' : `최근 사용자 요청 ${turn}`,
        ),
      );
    }
    records.push(rec('21', 'user', '현재 요청'));

    const memory = {
      recentShortTerm: async (_scope: MemoryScope, limit: number) => records.slice(-limit),
    } as unknown as MemoryManager;
    const task = taskWith({ sessionId: 'S1', requestText: '현재 요청' });
    const bundle = await new ContextBuilder(memory, {
      rankingEnabled: true,
      compressionEnabled: true,
      maxTokens: 1024,
      recencyWeight: 0.4,
      relevanceWeight: 0.6,
      compressionConfig: { minimumCharactersPerEntry: 80 },
    }).build(task, ['21']);
    const prompt = new PromptComposer().compose(task, bundle);

    expect(bundle.conversationTranscript).toHaveLength(10);
    expect(bundle.conversationTranscript.at(-1)?.content).toBe(
      '그러면 다음은 어떻게 하면 좋을까',
    );
    expect(bundle.conversationTranscript.some((entry) => entry.role === 'assistant')).toBe(true);
    expect(prompt.context).not.toContain('immediatelyPreviousUserTurn');
    expect(prompt.context).toContain('그러면 다음은 어떻게 하면 좋을까');
  });

  it('keeps the legacy ten-entry retrieval window for non-blended ranking', async () => {
    let requestedLimit: number | undefined;
    const records = Array.from({ length: 20 }, (_, index) =>
      rec(String(index + 1), index % 2 === 0 ? 'user' : 'assistant', `turn ${index + 1}`),
    );
    const memory = {
      recentShortTerm: async (_scope: MemoryScope, limit: number) => {
        requestedLimit = limit;
        return records.slice(-limit);
      },
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxCharacters: 1024,
      recencyWeight: 1,
    }).build(taskWith({ sessionId: 'S1' }));

    expect(requestedLimit).toBe(10);
    expect(bundle.conversationTranscript).toHaveLength(10);
    expect(bundle.conversationTranscript[0]?.content).toBe('turn 11');
  });

  it('defaults the recency side of the blend to one minus relevance weight', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'hello historical context'),
        rec('2', 'user', 'newest unrelated item'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxCharacters: 24,
      roleWeights: { user: 0 },
      relevanceWeight: 0.75,
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'he…',
      'newest unrelated item',
    ]);
  });

  it('rejects semantic blend weights that do not sum to one', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'history')],
    } as unknown as MemoryManager;

    expect(
      () =>
        new ContextBuilder(memory, {
          maxCharacters: 10,
          recencyWeight: 0.5,
          relevanceWeight: 0.75,
        }),
    ).toThrow('recencyWeight and relevanceWeight must sum to 1');
  });

  it('truncates the highest-ranked entry to the exact remaining character budget', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'abcdefgh')],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { maxCharacters: 5 }).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.conversationTranscript[0]?.content).toBe('abcd…');
    expect(
      bundle.conversationTranscript.reduce((total, entry) => total + entry.content.length, 0),
    ).toBe(5);
  });

  it('preserves ADR-0063 provenance and epistemic status through ranked selection', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'assistant', 'generated'),
        rec('2', 'user', 'claimed'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { maxCharacters: 16 }).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.conversationTranscript).toEqual([
      {
        turnNumber: 1,
        role: 'assistant',
        content: 'generated',
        provenance: 'ASSISTANT',
        epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      },
      {
        turnNumber: 2,
        role: 'user',
        content: 'claimed',
        provenance: 'USER',
        epistemicStatus: 'USER_CLAIM_OR_INTENT',
      },
    ]);
  });

  it('prioritizes active-project memory within the shared ranking budget', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'conversation')],
      projectMemory: async () => rec('2', 'project', 'active-project'),
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { maxCharacters: 14 }).build(
      taskWith({ sessionId: 'S1', projectId: 'P1' }),
    );

    expect(bundle.backgroundResources).toEqual([
      {
        content: 'active-project',
        provenance: 'PROJECT_MEMORY',
        epistemicStatus: 'NON_AUTHORITATIVE_BACKGROUND',
      },
    ]);
    expect(bundle.conversationTranscript).toEqual([]);
  });

  it('keeps existing flat retrieval unchanged when ranking is not configured', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('2', 'assistant', 'second'),
        rec('1', 'user', 'first'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {}).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('activates ranking, semantic relevance, token budgeting, and compression together', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'hello context ranking details'),
        rec('2', 'user', 'newest unrelated weather item'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      rankingEnabled: true,
      compressionEnabled: true,
      maxTokens: 8,
      roleWeights: { user: 0 },
      recencyWeight: 0.25,
      relevanceWeight: 0.75,
      compressionConfig: { minimumCharactersPerEntry: 4 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript[0]?.content).toMatch(/^hello context ranking/);
    expect(bundle.conversationTranscript[1]?.content.length).toBeLessThan(
      'newest unrelated weather item'.length,
    );
  });

  it('rejects invalid runtime feature switches and option combinations at construction', () => {
    const memory = { recentShortTerm: async () => [] } as unknown as MemoryManager;

    expect(() => new ContextBuilder(memory, { rankingEnabled: false, maxTokens: 10 })).toThrow(
      'ranking options require rankingEnabled',
    );
    expect(
      () =>
        new ContextBuilder(memory, {
          rankingEnabled: true,
          compressionEnabled: true,
          maxCharacters: 10,
        }),
    ).toThrow('compressionConfig requires maxTokens');
    expect(
      () =>
        new ContextBuilder(memory, {
          rankingEnabled: 'yes',
        } as unknown as ConstructorParameters<typeof ContextBuilder>[1]),
    ).toThrow('rankingEnabled must be a boolean');
  });

  it('uses estimated tokens while preserving recency and relevance ranking', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'older-user'),
        rec('2', 'assistant', 'newer-assistant'),
        rec('3', 'user', 'newest-user'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxTokens: 3,
      roleWeights: { user: 10, assistant: 0 },
      recencyWeight: 1,
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['newest-user']);
  });

  it('truncates a single entry that exceeds the estimated token budget', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'abcdefghij')],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { maxTokens: 1 }).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['abc…']);
  });

  it('returns no selected context for a zero token budget', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'history')],
      projectMemory: async () => rec('2', 'project', 'project background'),
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { maxTokens: 0 }).build(
      taskWith({ sessionId: 'S1', projectId: 'P1' }),
    );

    expect(bundle.conversationTranscript).toEqual([]);
    expect(bundle.backgroundResources).toEqual([]);
  });

  it('handles empty history with a token budget', async () => {
    const memory = {
      recentShortTerm: async () => [],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { maxTokens: 5 }).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(bundle.conversationTranscript).toEqual([]);
    expect(bundle.backgroundResources).toEqual([]);
  });

  it('compresses the lowest-scored entry first when ranked entries exceed the token budget', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'abcdefghijkl'),
        rec('2', 'user', 'mnopqrstuvwx'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxTokens: 4,
      roleWeights: { user: 0 },
      compressionConfig: { minimumCharactersPerEntry: 4 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'abc…',
      'mnopqrstuvwx',
    ]);
  });

  it('leaves compressed context unchanged when it is under budget', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'short'), rec('2', 'assistant', 'reply')],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxTokens: 4,
      compressionConfig: { minimumCharactersPerEntry: 2 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'short',
      'reply',
    ]);
  });

  it('respects the configured compression floor when the budget cannot be reached', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'abcdefghijkl'),
        rec('2', 'assistant', 'mnopqrstuvwx'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxTokens: 1,
      compressionConfig: { minimumCharactersPerEntry: 6 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      'abcdefg…',
      'mnopqrs…',
    ]);
    expect(bundle.conversationTranscript.every((entry) => entry.content.length >= 6)).toBe(true);
  });

  it('preserves chronological order, roles, and ADR-0063 labels through compression', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'assistant', 'abcdefghijkl'),
        rec('2', 'user', 'mnopqrstuvwx'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxTokens: 4,
      recencyWeight: 0,
      roleWeights: { assistant: 0, user: 10 },
      compressionConfig: { minimumCharactersPerEntry: 4 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript).toEqual([
      {
        turnNumber: 1,
        role: 'assistant',
        content: 'abc…',
        provenance: 'ASSISTANT',
        epistemicStatus: 'ASSISTANT_NON_AUTHORITATIVE',
      },
      {
        turnNumber: 2,
        role: 'user',
        content: 'mnopqrstuvwx',
        provenance: 'USER',
        epistemicStatus: 'USER_CLAIM_OR_INTENT',
      },
    ]);
  });

  it('handles empty and single-entry compression inputs', async () => {
    const emptyMemory = {
      recentShortTerm: async () => [],
    } as unknown as MemoryManager;
    const singleMemory = {
      recentShortTerm: async () => [rec('1', 'user', 'abcdefghijkl')],
    } as unknown as MemoryManager;
    const config = {
      maxTokens: 2,
      compressionConfig: { minimumCharactersPerEntry: 4 },
    } as const;

    const emptyBundle = await new ContextBuilder(emptyMemory, config).build(
      taskWith({ sessionId: 'S1' }),
    );
    const singleBundle = await new ContextBuilder(singleMemory, config).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(emptyBundle.conversationTranscript).toEqual([]);
    expect(singleBundle.conversationTranscript.map((entry) => entry.content)).toEqual(['abcdefg…']);
  });

  it('keeps token-budget selection unchanged when compressionConfig is omitted', async () => {
    const memory = {
      recentShortTerm: async () => [
        rec('1', 'user', 'abcdefghijkl'),
        rec('2', 'user', 'mnopqrstuvwx'),
      ],
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, {
      maxTokens: 2,
      roleWeights: { user: 0 },
    }).build(taskWith({ sessionId: 'S1' }));

    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(['mnopqrs…']);
  });

  it('rejects compression without a token budget and invalid minimum floors', async () => {
    const memory = {
      recentShortTerm: async () => [rec('1', 'user', 'history')],
    } as unknown as MemoryManager;

    expect(() => new ContextBuilder(memory, { compressionConfig: {} })).toThrow(
      'compressionConfig requires maxTokens',
    );
    expect(
      () =>
        new ContextBuilder(memory, {
          maxTokens: 2,
          compressionConfig: { minimumCharactersPerEntry: -1 },
        }),
    ).toThrow(
      'compressionConfig.minimumCharactersPerEntry must be a non-negative safe integer',
    );
  });

  it('preserves flat N=10 retrieval when ranking has no configured budget', async () => {
    let requestedLimit: number | undefined;
    const records = Array.from({ length: 12 }, (_, index) =>
      rec(String(index), 'user', `turn-${index}`),
    );
    const memory = {
      recentShortTerm: async (_scope: MemoryScope, limit: number) => {
        requestedLimit = limit;
        return records;
      },
    } as unknown as MemoryManager;

    const bundle = await new ContextBuilder(memory, { roleWeights: { user: 100 } }).build(
      taskWith({ sessionId: 'S1' }),
    );

    expect(requestedLimit).toBe(10);
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `turn-${index + 2}`),
    );
  });

  it('falls back to channel scope when the task has no session', async () => {
    let captured: MemoryScope | undefined;
    const memory = {
      recentShortTerm: async (scope: MemoryScope) => {
        captured = scope;
        return [];
      },
    } as unknown as MemoryManager;

    await new ContextBuilder(memory).build(taskWith({ actorId: '' }));

    expect(captured).toEqual({ channelId: 'c' });
  });
});
