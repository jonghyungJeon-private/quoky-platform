import { describe, expect, it, vi } from 'vitest';
import { MemoryType } from '../domain';
import type { MemoryCandidateInput, MemoryRecord, MemoryScope } from '../domain';
import { DefaultMemoryWriter } from './memory-writer';

const candidateInput = (
  overrides: Partial<MemoryCandidateInput> = {},
): MemoryCandidateInput => ({
  content: 'Prefer concise project updates.',
  sourceContent: 'Remember that I prefer concise project updates.',
  trigger: 'EXPLICIT_USER_INSTRUCTION',
  kind: 'SEMANTIC',
  provenance: 'USER_PROVIDED',
  authorityLevel: 'USER_CLAIM_OR_INTENT',
  scope: { actorId: 'actor-1' },
  ...overrides,
});

const durableRecord = (
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord => ({
  id: 'memory-existing',
  type: MemoryType.LONG_TERM,
  scope: { userId: 'actor-1' },
  content: 'Prefer concise project updates.',
  metadata: {
    kind: 'SEMANTIC',
    provenance: 'USER_PROVIDED',
    authorityLevel: 'USER_CLAIM_OR_INTENT',
    sourceContent: 'Remember that I prefer concise project updates.',
    trigger: 'EXPLICIT_USER_INSTRUCTION',
  },
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  ...overrides,
});

function persistence(records: MemoryRecord[] = []) {
  const durableMemory = vi.fn(
    async (id: string) => records.find((record) => record.id === id) ?? null,
  );
  const durableMemories = vi.fn(async (scope: MemoryScope) =>
    records.filter(
      (record) =>
        record.type === MemoryType.LONG_TERM &&
        Object.entries(scope).every(
          ([key, value]) => record.scope[key as keyof MemoryScope] === value,
        ),
    ),
  );
  const saveDurable = vi.fn(async (record: MemoryRecord) => {
    const index = records.findIndex((existing) => existing.id === record.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    return record;
  });
  const forgetDurable = vi.fn(async (id: string) => {
    const index = records.findIndex((record) => record.id === id);
    if (index >= 0) records.splice(index, 1);
  });
  return { durableMemory, durableMemories, saveDurable, forgetDurable };
}

describe('DefaultMemoryWriter lifecycle', () => {
  it('promotes only after policy and preserves provenance, authority, source, and scope mapping', async () => {
    const store = persistence();
    const writer = new DefaultMemoryWriter(store);

    const result = await writer.promote(
      writer.createCandidate(
        candidateInput({
          scope: { sessionId: 'session-1', projectId: 'project-1', actorId: 'actor-1' },
          metadata: { sourceReferences: ['turn-1'], importance: 0.8 },
        }),
      ),
    );

    expect(result.outcome).toBe('PROMOTED');
    if (result.outcome !== 'PROMOTED') throw new Error('expected promotion');
    expect(result.memory).toMatchObject({
      memoryType: MemoryType.LONG_TERM,
      kind: 'SEMANTIC',
      provenance: 'USER_PROVIDED',
      authorityLevel: 'USER_CLAIM_OR_INTENT',
      scope: { sessionId: 'session-1', projectId: 'project-1', actorId: 'actor-1' },
      metadata: {
        sourceContent: 'Remember that I prefer concise project updates.',
        sourceReferences: ['turn-1'],
        importance: 0.8,
      },
    });
    expect(store.saveDurable).toHaveBeenCalledOnce();
    expect(store.saveDurable.mock.calls[0]?.[0]).toMatchObject({
      type: MemoryType.LONG_TERM,
      scope: { sessionId: 'session-1', projectId: 'project-1', userId: 'actor-1' },
      metadata: {
        kind: 'SEMANTIC',
        provenance: 'USER_PROVIDED',
        authorityLevel: 'USER_CLAIM_OR_INTENT',
        sourceReferences: ['turn-1'],
      },
    });
  });

  it('rejects forbidden material before any persistence call', async () => {
    const store = persistence();
    const writer = new DefaultMemoryWriter(store);

    await expect(
      writer.promote(
        writer.createCandidate(
          candidateInput({ content: 'api_key = do-not-store-this', sourceContent: 'remember it' }),
        ),
      ),
    ).resolves.toMatchObject({ outcome: 'REJECTED', policyReason: expect.any(String) });
    expect(store.durableMemories).not.toHaveBeenCalled();
    expect(store.saveDurable).not.toHaveBeenCalled();
  });

  it.each(['내 비밀번호는 hunter2야', 'my pin is 1234'])(
    'rejects Korean/English credential declaration %s before persistence',
    async (content) => {
      const store = persistence();
      const writer = new DefaultMemoryWriter(store);

      await expect(
        writer.promote(writer.createCandidate(candidateInput({ content, sourceContent: content }))),
      ).resolves.toMatchObject({ outcome: 'REJECTED' });
      expect(store.saveDurable).not.toHaveBeenCalled();
    },
  );

  it.each(['expiresAt', 'supersededBy'] as const)(
    'rejects candidate-owned %s lifecycle metadata before persistence',
    async (reservedField) => {
      const store = persistence();
      const writer = new DefaultMemoryWriter(store);

      await expect(
        writer.promote(
          writer.createCandidate(
            candidateInput({ metadata: { [reservedField]: 'candidate-forged-value' } }),
          ),
        ),
      ).resolves.toEqual({
        outcome: 'REJECTED',
        policyReason: `candidate metadata cannot set writer-owned lifecycle field: ${reservedField}`,
      });
      expect(store.durableMemories).not.toHaveBeenCalled();
      expect(store.durableMemory).not.toHaveBeenCalled();
      expect(store.saveDurable).not.toHaveBeenCalled();
      expect(store.forgetDurable).not.toHaveBeenCalled();
    },
  );

  it('returns an explicit duplicate relation without persisting', async () => {
    const store = persistence([durableRecord()]);
    const writer = new DefaultMemoryWriter(store);

    await expect(
      writer.promote(
        writer.createCandidate(candidateInput({ content: '  PREFER  CONCISE PROJECT UPDATES. ' })),
      ),
    ).resolves.toMatchObject({
      outcome: 'DUPLICATE',
      existingMemoryId: 'memory-existing',
      policyReason: expect.any(String),
    });
    expect(store.saveDurable).not.toHaveBeenCalled();
  });

  it('links both sides of a validated supersession and rejects another replacement', async () => {
    const prior = durableRecord();
    const store = persistence([prior]);
    const writer = new DefaultMemoryWriter(store);

    const result = await writer.promote(
      writer.createCandidate(
        candidateInput({
          content: 'Prefer a one-paragraph project update.',
          metadata: { supersedesMemoryId: prior.id, sourceReferences: ['turn-2'] },
        }),
      ),
    );

    expect(result).toMatchObject({
      outcome: 'SUPERSEDING',
      supersededMemoryId: prior.id,
      policyReason: expect.any(String),
      memory: { metadata: { supersedesMemoryId: prior.id, sourceReferences: ['turn-2'] } },
    });
    const newMemoryId = result.outcome === 'SUPERSEDING' ? result.memory.id : undefined;
    expect(store.saveDurable).toHaveBeenCalledTimes(2);
    expect(store.saveDurable.mock.calls[1]?.[0]).toMatchObject({
      id: prior.id,
      metadata: { supersededBy: newMemoryId },
    });
    await expect(
      writer.promote(
        writer.createCandidate(
          candidateInput({
            content: 'Prefer a two-sentence project update.',
            metadata: { supersedesMemoryId: prior.id },
          }),
        ),
      ),
    ).resolves.toMatchObject({
      outcome: 'REJECTED',
      policyReason: 'superseded memory is already superseded',
    });
    expect(store.saveDurable).toHaveBeenCalledTimes(2);
  });

  it('rolls back the new version when marking the superseded record fails', async () => {
    const prior = durableRecord();
    const store = persistence([prior]);
    const defaultSave = store.saveDurable.getMockImplementation();
    if (defaultSave === undefined) throw new Error('expected persistence implementation');
    store.saveDurable
      .mockImplementationOnce(defaultSave)
      .mockRejectedValueOnce(new Error('superseded marker failed'));
    const writer = new DefaultMemoryWriter(store);

    await expect(
      writer.promote(
        writer.createCandidate(
          candidateInput({
            content: 'Prefer a one-paragraph project update.',
            metadata: { supersedesMemoryId: prior.id },
          }),
        ),
      ),
    ).rejects.toMatchObject({
      name: 'MemoryWriterPersistenceError',
      code: 'PERSISTENCE_FAILURE',
      operation: 'PROMOTE',
    });
    expect(store.forgetDurable).toHaveBeenCalledOnce();
    expect(await store.durableMemories({ userId: 'actor-1' })).toEqual([prior]);
  });

  it('owns exact-scope forget policy and invokes deletion only after approval', async () => {
    const record = durableRecord();
    const store = persistence([record]);
    const writer = new DefaultMemoryWriter(store);

    await expect(
      writer.forget({ memoryId: record.id, scope: { projectId: 'wrong-project' } }),
    ).resolves.toMatchObject({ outcome: 'REJECTED', memoryId: record.id });
    expect(store.forgetDurable).not.toHaveBeenCalled();

    await expect(
      writer.forget({ memoryId: record.id, scope: { actorId: 'actor-1' } }),
    ).resolves.toMatchObject({ outcome: 'FORGOTTEN', memoryId: record.id });
    expect(store.forgetDurable).toHaveBeenCalledWith(record.id);
    await expect(
      writer.forget({ memoryId: 'missing', scope: { actorId: 'actor-1' } }),
    ).resolves.toMatchObject({ outcome: 'NOT_FOUND', memoryId: 'missing' });
  });

  it('bounds and classifies repository failures without a Provider or model path', async () => {
    const cause = new Error('adapter detail');
    const store = persistence();
    store.saveDurable.mockRejectedValueOnce(cause);
    const writer = new DefaultMemoryWriter(store);

    await expect(writer.promote(writer.createCandidate(candidateInput()))).rejects.toMatchObject({
      name: 'MemoryWriterPersistenceError',
      code: 'PERSISTENCE_FAILURE',
      operation: 'PROMOTE',
      cause,
    });
  });
});
