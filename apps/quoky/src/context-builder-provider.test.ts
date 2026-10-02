import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  IntentType,
  MemoryManager,
  MemoryType,
  NoProviderAvailableError,
  RiskLevel,
  TaskStatus,
  cosineSimilarity,
  formatEmbeddingEnvelope,
  type AiProvider,
  type AiRequest,
  type MemoryRecord,
  type MemoryRepository,
  type StorageProvider,
  type Task,
  type VectorProvider,
  type VectorRecord,
} from '@quoky/core';
import { createProductionContextBuilder } from './context-builder-provider';
import type { ProductionSemanticRecallOptions } from './context-builder-provider';

const createdAt = '2026-08-24T00:00:00.000Z';

const task: Task = {
  id: 'task-1',
  title: 'Recall project preference',
  description: 'Which formatter does this project prefer?',
  status: TaskStatus.PENDING,
  intent: {
    type: IntentType.CHAT,
    capability: Capability.GENERAL_CHAT,
    confidence: 1,
    requiresWork: true,
    summary: 'project formatter preference',
  },
  riskLevel: RiskLevel.LOW,
  context: { platform: 'discord', channelId: 'channel-1', userId: 'user-1' },
  sessionId: 'session-1',
  projectId: 'project-1',
  actorId: 'actor-1',
  createdAt,
  updatedAt: createdAt,
};

const shortTerm: MemoryRecord = {
  id: 'short-1',
  type: MemoryType.SHORT_TERM,
  scope: { sessionId: 'session-1', userId: 'user-1', channelId: 'channel-1' },
  content: 'Use the exact previous conversation turn.',
  metadata: { role: 'user' },
  createdAt,
  updatedAt: createdAt,
};

const project: MemoryRecord = {
  id: 'project-memory-1',
  type: MemoryType.PROJECT,
  scope: { projectId: 'project-1' },
  content: 'The active project background remains available.',
  createdAt,
  updatedAt: createdAt,
};

const durable: MemoryRecord = {
  id: 'durable-1',
  type: MemoryType.LONG_TERM,
  scope: { sessionId: 'session-1', projectId: 'project-1', userId: 'actor-1' },
  content: 'This project prefers the Prettier formatter.',
  metadata: {
    kind: 'SEMANTIC',
    provenance: 'USER_PROVIDED',
    authorityLevel: 'USER_CLAIM_OR_INTENT',
  },
  createdAt,
  updatedAt: createdAt,
};

function composedBuilder(
  findDurableCandidates: MemoryRepository['findDurableCandidates'],
  semanticRecall?: ProductionSemanticRecallOptions,
) {
  const repository: MemoryRepository = {
    get: async () => null,
    save: async (record) => record,
    delete: async () => undefined,
    list: async () => [],
    findByScope: async (scope, type) => {
      if (type === MemoryType.SHORT_TERM && scope.sessionId === task.sessionId) return [shortTerm];
      if (type === MemoryType.PROJECT && scope.projectId === task.projectId) return [project];
      return [];
    },
    findDurableCandidates,
  };
  const storageState = {} as { memories: MemoryRepository };
  const storage = storageState as StorageProvider;
  const memory = new MemoryManager(storage, {} as VectorProvider);
  const builder = createProductionContextBuilder(memory, storage, {}, semanticRecall);
  // Mirrors production init order: Nest constructs services before SQLite assigns repositories.
  storageState.memories = repository;
  return builder;
}

describe('production ContextBuilder composition', () => {
  it('retrieves durable memory through the storage-owned repository without mixing transcript surfaces', async () => {
    const findDurableCandidates = vi.fn(async () => [durable]);

    const bundle = await composedBuilder(findDurableCandidates).build(task);

    expect(findDurableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: 'actor-1' },
        excludeExpired: true,
        excludeSuperseded: true,
      }),
    );
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      shortTerm.content,
    ]);
    expect(bundle.backgroundResources.map((entry) => entry.content)).toEqual([project.content]);
    expect(bundle.durableRecall?.map((entry) => entry.content)).toEqual([durable.content]);
    expect(bundle.conversationTranscript.some((entry) => entry.content === durable.content)).toBe(
      false,
    );
  });

  it('degrades repository failure to empty durable recall without disrupting exact context', async () => {
    const bundle = await composedBuilder(async () => {
      throw new Error('repository unavailable');
    }).build(task);

    expect(bundle.durableRecall).toBeUndefined();
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      shortTerm.content,
    ]);
    expect(bundle.backgroundResources.map((entry) => entry.content)).toEqual([project.content]);
  });
});

/** Deterministic concept embedding: [pet, other]. */
function petVector(text: string): number[] {
  return /반려동물|고양이/u.test(text) ? [1, 0] : [0, 1];
}

class FakeEmbedder implements AiProvider {
  readonly id = 'fake-embedder';
  readonly capabilities = [{ capability: Capability.EMBEDDING, priority: 100 }];
  readonly prompts: string[] = [];
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async execute(request: AiRequest) {
    this.prompts.push(request.prompt);
    return { text: formatEmbeddingEnvelope(petVector(request.prompt), 'fake-space') };
  }
}

function vectorStore(): VectorProvider & { records: Map<string, VectorRecord> } {
  const records = new Map<string, VectorRecord>();
  return {
    records,
    init: async () => undefined,
    upsert: async (_collection, entries) => {
      for (const entry of entries) records.set(entry.id, entry);
    },
    query: async (_collection, vector, topK) =>
      [...records.values()]
        .map((entry) => ({ id: entry.id, score: cosineSimilarity(vector, entry.vector), metadata: entry.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK),
    delete: async () => undefined,
  };
}

const petTask: Task = {
  ...task,
  id: 'task-pet',
  intent: { ...task.intent, summary: '반려동물 이름이 뭐였지' },
};

function durableRecord(id: string, content: string, updatedAt: string): MemoryRecord {
  return { ...durable, id, content, createdAt: updatedAt, updatedAt };
}

const petMemory = durableRecord('durable-pet', '우리 집 고양이 이름은 나비야', '2026-08-01T00:00:00.000Z');
const distractors = Array.from({ length: 12 }, (_unused, index) =>
  durableRecord(`durable-${index}`, `이름이 뭐였지 메모 ${index}`, '2026-08-20T00:00:00.000Z'),
);

describe('production ContextBuilder composition with opt-in semantic recall (ADR-0098 D8)', () => {
  it('without semantic options (embedding disabled), recall stays lexical and misses the disjoint memory', async () => {
    const bundle = await composedBuilder(async () => [...distractors, petMemory]).build(petTask);
    expect(bundle.durableRecall?.some((entry) => entry.content === petMemory.content) ?? false).toBe(false);
    expect(bundle.durableRecall?.every((entry) => !entry.retrievalReason.includes('semantic='))).toBe(true);
  });

  it('with semantic options, the lexically disjoint memory is recalled through the EMBEDDING capability', async () => {
    const embedder = new FakeEmbedder();
    const select = vi.fn(async (capability: Capability) => {
      expect(capability).toBe(Capability.EMBEDDING);
      return embedder;
    });
    const vectors = vectorStore();
    const semanticRecall: ProductionSemanticRecallOptions = {
      selector: { select },
      vectors,
      timeoutMs: 3000,
      maxNewPerTurn: 4,
    };
    const builder = composedBuilder(async () => [...distractors, petMemory], semanticRecall);

    let bundle = await builder.build(petTask);
    for (let turn = 0; turn < 5 && bundle.durableRecall?.[0]?.content !== petMemory.content; turn++) {
      bundle = await builder.build(petTask);
    }

    expect(bundle.durableRecall?.[0]?.content).toBe(petMemory.content);
    expect(select).toHaveBeenCalled();
    expect(vectors.records.has('durable-pet')).toBe(true);
    // The exact transcript surface is unaffected by recall.
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([shortTerm.content]);
  });

  it('with no EMBEDDING provider, durable recall equals lexical recall', async () => {
    const lexical = await composedBuilder(async () => [...distractors, petMemory]).build(petTask);
    const degraded = await composedBuilder(async () => [...distractors, petMemory], {
      selector: {
        select: async () => {
          throw new NoProviderAvailableError(Capability.EMBEDDING);
        },
      },
      vectors: vectorStore(),
      timeoutMs: 3000,
      maxNewPerTurn: 4,
    }).build(petTask);
    // The production clock is real time, so compare the ranking and reasons (byte-identity under a fixed clock is
    // asserted in memory-retriever.test.ts).
    const view = (entries: typeof lexical.durableRecall) =>
      entries?.map((entry) => [entry.source.memoryId, entry.retrievalReason]);
    expect(view(degraded.durableRecall)).toEqual(view(lexical.durableRecall));
    expect(degraded.durableRecall?.every((entry) => !entry.retrievalReason.includes('semantic='))).toBe(true);
  });
});
