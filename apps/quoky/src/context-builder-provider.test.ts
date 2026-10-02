import { describe, expect, it, vi } from 'vitest';
import {
  Capability,
  IntentType,
  MemoryManager,
  MemoryType,
  RiskLevel,
  TaskStatus,
  type MemoryRecord,
  type MemoryRepository,
  type StorageProvider,
  type Task,
  type VectorProvider,
} from '@quoky/core';
import { createProductionContextBuilder } from './context-builder-provider';

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

function composedBuilder(findDurableCandidates: MemoryRepository['findDurableCandidates']) {
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
  const builder = createProductionContextBuilder(memory, storage, {});
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
