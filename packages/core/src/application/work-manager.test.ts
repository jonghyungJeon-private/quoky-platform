import { describe, expect, it } from 'vitest';
import {
  ResourceRef,
  WORK_ITEM_MAX_RESOURCE_REFS,
  WorkItemCorrelationError,
  WorkItemStatus,
  WorkItemTitleError,
} from '../domain';
import type { Id, WorkItem } from '../domain';
import type { StorageProvider, WorkItemRepository } from '../ports';
import { WorkManager } from './work-manager';

/** In-memory repository mirroring the SQLite ordering contract (createdAt, id). */
class MemoryWorkItems implements WorkItemRepository {
  readonly items = new Map<Id, WorkItem>();

  async get(id: Id) {
    return this.items.get(id) ?? null;
  }
  async save(item: WorkItem) {
    this.items.set(item.id, item);
    return item;
  }
  async delete(id: Id) {
    this.items.delete(id);
  }
  async list() {
    return [...this.items.values()];
  }
  async listByActor(actorId: Id) {
    return [...this.items.values()]
      .filter((item) => item.actorId === actorId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async listByResource(resource: ResourceRef) {
    return [...this.items.values()].filter((item) =>
      item.resourceRefs.some((ref) => ref.equals(resource)),
    );
  }
}

function harness() {
  const workItems = new MemoryWorkItems();
  const manager = new WorkManager({ workItems } as unknown as StorageProvider);
  return { workItems, manager };
}

const ref = (externalId: string) => new ResourceRef({ source: 'jira', externalId });

describe('WorkManager (CAP-011, ADR-0100 D4)', () => {
  it('creates an item without a title (legacy shape stays valid)', async () => {
    const { manager } = harness();
    const created = await manager.create({ actorId: 'actor-1', origin: 'connector' });
    expect(created).not.toHaveProperty('title');
    expect(created.status).toBe(WorkItemStatus.ACTIVE);
  });

  it('normalizes the title on create', async () => {
    const { manager, workItems } = harness();
    const created = await manager.create({
      actorId: 'actor-1',
      origin: 'conversation',
      title: '  주간   보고서 \n 작성  ',
    });
    expect(created.title).toBe('주간 보고서 작성');
    expect(workItems.items.get(created.id)?.title).toBe('주간 보고서 작성');
  });

  it.each([
    ['', 'EMPTY'],
    ['   \n\t ', 'EMPTY'],
    ['x'.repeat(201), 'TOO_LONG'],
  ])('rejects an invalid title %#', async (title, code) => {
    const { manager, workItems } = harness();
    const error = await manager
      .create({ actorId: 'actor-1', origin: 'conversation', title })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkItemTitleError);
    expect((error as WorkItemTitleError).code).toBe(code);
    expect(workItems.items.size).toBe(0);
  });

  it('accepts a title of exactly 200 characters', async () => {
    const { manager } = harness();
    const created = await manager.create({
      actorId: 'actor-1',
      origin: 'conversation',
      title: 'x'.repeat(200),
    });
    expect(created.title).toHaveLength(200);
  });

  it('correlates refs on the canonical item, de-duplicated by identity', async () => {
    const { manager, workItems } = harness();
    const created = await manager.create({
      actorId: 'actor-1',
      origin: 'conversation',
      title: 'todo',
      resourceRefs: [ref('A-1')],
    });
    const correlated = await manager.correlate(created.id, [ref('A-1'), ref('A-2')]);
    expect(correlated.resourceRefs.map((r) => r.identity)).toEqual(['jira:A-1', 'jira:A-2']);
    expect(correlated.title).toBe('todo');
    expect(workItems.items.get(created.id)).toEqual(correlated);
    expect(await manager.listByResource(ref('A-2'))).toHaveLength(1);
  });

  it('leaves the item untouched when correlate adds nothing new', async () => {
    const { manager } = harness();
    const created = await manager.create({
      actorId: 'actor-1',
      origin: 'conversation',
      resourceRefs: [ref('A-1')],
    });
    expect(await manager.correlate(created.id, [ref('A-1')])).toEqual(created);
  });

  it('enforces the maximum number of correlated refs', async () => {
    const { manager, workItems } = harness();
    const refs = Array.from({ length: WORK_ITEM_MAX_RESOURCE_REFS }, (_, i) => ref(`A-${i}`));
    const created = await manager.create({ actorId: 'actor-1', origin: 'conversation', resourceRefs: refs });
    const error = await manager.correlate(created.id, [ref('EXTRA')]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkItemCorrelationError);
    expect((error as WorkItemCorrelationError).code).toBe('TOO_MANY_REFS');
    expect(workItems.items.get(created.id)?.resourceRefs).toHaveLength(WORK_ITEM_MAX_RESOURCE_REFS);
  });

  it.each([WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED])(
    'refuses to correlate a %s item and keeps it terminal',
    async (status) => {
      const { manager, workItems } = harness();
      const created = await manager.create({ actorId: 'actor-1', origin: 'conversation' });
      await manager.transition(created.id, status);
      const error = await manager.correlate(created.id, [ref('A-1')]).catch((e: unknown) => e);
      expect((error as WorkItemCorrelationError).code).toBe('NOT_ACTIVE');
      await expect(manager.transition(created.id, WorkItemStatus.ACTIVE)).rejects.toThrow(
        'Invalid WorkItem transition',
      );
      expect(workItems.items.get(created.id)?.resourceRefs).toEqual([]);
    },
  );

  it('fails correlate for a missing item', async () => {
    const { manager } = harness();
    await expect(manager.correlate('missing', [ref('A-1')])).rejects.toThrow('WorkItem not found');
  });

  it('lists only ACTIVE items of the actor in repository order', async () => {
    const { manager, workItems } = harness();
    const base = { actorId: 'actor-1', origin: 'conversation' as const };
    const first = await manager.create(base);
    const second = await manager.create(base);
    const third = await manager.create(base);
    await manager.create({ ...base, actorId: 'actor-2' });
    await manager.transition(second.id, WorkItemStatus.COMPLETED);
    // Force a deterministic createdAt order independent of clock resolution.
    for (const [i, item] of [first, second, third].entries()) {
      workItems.items.set(item.id, { ...workItems.items.get(item.id)!, createdAt: `2026-09-0${i + 1}T00:00:00.000Z` });
    }
    expect((await manager.listActiveByActor('actor-1')).map((i) => i.id)).toEqual([first.id, third.id]);
  });
});
