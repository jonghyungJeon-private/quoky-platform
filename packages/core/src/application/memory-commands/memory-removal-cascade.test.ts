import { describe, expect, it } from 'vitest';
import { createLearningItemsRemovalCascade } from './memory-removal-cascade';

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
    await cascade.onMemoriesRemoved({ actorId: 'actor-1', reason: 'forget', memoryIds: ['m1', 'm0', 'm1'], vectorIds: ['v9'] });
    // Each memory id once (deduplicated); vector ids are not memory ids and are never used as a learning source.
    expect(calls).toEqual([
      ['actor-1', 'm1'],
      ['actor-1', 'm0'],
    ]);
  });

  it('also runs for an edit (the superseded record leaves recall) and is a no-op for an empty event', async () => {
    const { calls, learning } = recording();
    const cascade = createLearningItemsRemovalCascade(learning);
    await cascade.onMemoriesRemoved({ actorId: 'actor-2', reason: 'edit', memoryIds: ['old'], vectorIds: [] });
    await cascade.onMemoriesRemoved({ actorId: 'actor-2', reason: 'forget', memoryIds: [], vectorIds: [] });
    expect(calls).toEqual([['actor-2', 'old']]);
  });

  it('propagates a store failure so the forget aborts before the memory is deleted', async () => {
    const cascade = createLearningItemsRemovalCascade({
      deleteBySourceMemory: async () => {
        throw new Error('disk');
      },
    });
    await expect(
      cascade.onMemoriesRemoved({ actorId: 'a', reason: 'forget', memoryIds: ['m'], vectorIds: [] }),
    ).rejects.toThrow('disk');
  });
});
