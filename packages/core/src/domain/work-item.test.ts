import { describe, expect, it } from 'vitest';
import { ResourceRef } from './resource-ref';
import {
  WORK_ITEM_MAX_RESOURCE_REFS,
  WorkItemCorrelationError,
  WorkItemStatus,
  WorkItemTitleError,
  canTransitionWorkItem,
  correlateWorkItem,
  normalizeWorkItemTitle,
  transitionWorkItem,
  uniqueResourceRefs,
} from './work-item';
import type { WorkItem } from './work-item';

const createdAt = '2026-09-01T00:00:00.000Z';

function activeWorkItem(): WorkItem {
  return {
    id: 'work-1',
    actorId: 'actor-1',
    projectId: 'project-1',
    resourceRefs: [new ResourceRef({ source: 'jira', externalId: 'CAP-11' })],
    status: WorkItemStatus.ACTIVE,
    origin: 'conversation',
    createdAt,
    updatedAt: createdAt,
  };
}

describe('WorkItem (CAP-011)', () => {
  it('contains only ADR-0075 durable-work ownership fields', () => {
    expect(Object.keys(activeWorkItem()).sort()).toEqual([
      'actorId',
      'createdAt',
      'id',
      'origin',
      'projectId',
      'resourceRefs',
      'status',
      'updatedAt',
    ]);
  });

  it.each([WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED])(
    'transitions ACTIVE to %s without mutating the persisted value',
    (status) => {
      const item = activeWorkItem();
      const updated = transitionWorkItem(item, status, '2026-09-01T01:00:00.000Z');
      expect(updated).toMatchObject({ status, updatedAt: '2026-09-01T01:00:00.000Z' });
      expect(item.status).toBe(WorkItemStatus.ACTIVE);
    },
  );

  it.each([WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED])(
    'keeps %s terminal',
    (status) => {
      expect(canTransitionWorkItem(status, WorkItemStatus.ACTIVE)).toBe(false);
      expect(() =>
        transitionWorkItem(
          { ...activeWorkItem(), status },
          WorkItemStatus.ACTIVE,
          createdAt,
        ),
      ).toThrow('Invalid WorkItem transition');
    },
  );

  it('deduplicates ResourceRef correlations by provider-independent identity', () => {
    const refs = uniqueResourceRefs([
      new ResourceRef({ source: 'jira', externalId: 'CAP-11' }),
      new ResourceRef({ source: 'jira', externalId: 'CAP-11' }),
      new ResourceRef({ source: 'github', externalId: '42' }),
    ]);
    expect(refs.map((ref) => ref.identity)).toEqual(['jira:CAP-11', 'github:42']);
  });

  it('allows an optional normalized title alongside the ownership fields', () => {
    expect(Object.keys({ ...activeWorkItem(), title: 'todo' }).sort()).toEqual([
      'actorId',
      'createdAt',
      'id',
      'origin',
      'projectId',
      'resourceRefs',
      'status',
      'title',
      'updatedAt',
    ]);
  });
});

describe('normalizeWorkItemTitle (ADR-0100 D4)', () => {
  it('trims and collapses whitespace runs', () => {
    expect(normalizeWorkItemTitle('  a \t b\n\n c  ')).toBe('a b c');
  });

  it('accepts 1 and 200 characters', () => {
    expect(normalizeWorkItemTitle('x')).toBe('x');
    expect(normalizeWorkItemTitle('가'.repeat(200))).toHaveLength(200);
  });

  it('counts a surrogate pair as one character', () => {
    expect(Array.from(normalizeWorkItemTitle('😀'.repeat(200)))).toHaveLength(200);
  });

  it.each([
    ['', 'EMPTY'],
    [' \n\t ', 'EMPTY'],
    ['\u200B', 'EMPTY'],
    ['\u200B \u0000\u202E\uFEFF', 'EMPTY'],
    ['x'.repeat(201), 'TOO_LONG'],
    [`  ${'x'.repeat(201)}  `, 'TOO_LONG'],
  ])('rejects %j with %s', (raw, code) => {
    try {
      normalizeWorkItemTitle(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkItemTitleError);
      expect((error as WorkItemTitleError).code).toBe(code);
    }
  });

  it('strips control, zero-width and bidi-override characters', () => {
    expect(normalizeWorkItemTitle('a\u0000b\u0007c')).toBe('abc');
    expect(normalizeWorkItemTitle('abc\u202Eevil\u200B')).toBe('abcevil');
    expect(normalizeWorkItemTitle('a \u200B b')).toBe('a b');
  });

  it('normalizes before measuring length', () => {
    expect(normalizeWorkItemTitle(`${'x'.repeat(200)}      `)).toHaveLength(200);
  });
});

describe('correlateWorkItem (ADR-0100 D4)', () => {
  const later = '2026-09-02T00:00:00.000Z';

  it('merges refs by identity and returns a new value', () => {
    const item = activeWorkItem();
    const updated = correlateWorkItem(
      item,
      [
        new ResourceRef({ source: 'jira', externalId: 'CAP-11' }),
        new ResourceRef({ source: 'github', externalId: '42' }),
        new ResourceRef({ source: 'github', externalId: '42' }),
      ],
      later,
    );
    expect(updated.resourceRefs.map((ref) => ref.identity)).toEqual(['jira:CAP-11', 'github:42']);
    expect(updated.updatedAt).toBe(later);
    expect(item.resourceRefs).toHaveLength(1);
  });

  it('returns the item unchanged when nothing new is added', () => {
    const item = activeWorkItem();
    expect(correlateWorkItem(item, [], later)).toBe(item);
    expect(
      correlateWorkItem(item, [new ResourceRef({ source: 'jira', externalId: 'CAP-11' })], later),
    ).toBe(item);
  });

  it('returns an over-cap legacy item unchanged when nothing new is added', () => {
    const refs = Array.from(
      { length: WORK_ITEM_MAX_RESOURCE_REFS + 2 },
      (_, i) => new ResourceRef({ source: 'github', externalId: `r${i}` }),
    );
    const item = { ...activeWorkItem(), resourceRefs: refs };
    expect(correlateWorkItem(item, [], later)).toBe(item);
    expect(correlateWorkItem(item, [refs[0]!], later)).toBe(item);
  });

  it.each([WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED])('refuses a %s item', (status) => {
    expect(() =>
      correlateWorkItem(
        { ...activeWorkItem(), status },
        [new ResourceRef({ source: 'github', externalId: '1' })],
        later,
      ),
    ).toThrow(WorkItemCorrelationError);
  });

  it('allows exactly the maximum and refuses one more', () => {
    const refs = (n: number) =>
      Array.from({ length: n }, (_, i) => new ResourceRef({ source: 'github', externalId: `r${i}` }));
    const item = { ...activeWorkItem(), resourceRefs: [] };
    expect(correlateWorkItem(item, refs(WORK_ITEM_MAX_RESOURCE_REFS), later).resourceRefs).toHaveLength(
      WORK_ITEM_MAX_RESOURCE_REFS,
    );
    try {
      correlateWorkItem(item, refs(WORK_ITEM_MAX_RESOURCE_REFS + 1), later);
      expect.unreachable();
    } catch (error) {
      expect((error as WorkItemCorrelationError).code).toBe('TOO_MANY_REFS');
    }
  });
});
