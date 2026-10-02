import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceRef, WorkItemStatus, WorkManager } from '@quoky/core';
import type { Actor, Project, WorkItem } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function storeAt(path?: string): Promise<SqliteStorageProvider> {
  const dir = path ?? mkdtempSync(join(tmpdir(), 'quoky-work-items-'));
  if (!path) dirs.push(dir);
  const store = new SqliteStorageProvider({ dbPath: join(dir, 'chunsik.db') });
  await store.init();
  return store;
}

const actor: Actor = {
  id: 'actor-1',
  displayName: 'Quoky',
  identities: [{ platform: 'discord', externalId: 'user-1' }],
  createdAt: '2026-09-01T00:00:00.000Z',
};

const project: Project = {
  id: 'project-1',
  name: 'Quoky',
  rootPath: '/work/quoky',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('SqliteWorkItemRepository (CAP-011) — migration v7', () => {
  it('creates and reads a persisted WorkItem through the application boundary', async () => {
    const store = await storeAt();
    await store.actors.save(actor);
    const manager = new WorkManager(store);
    const created = await manager.create({ actorId: actor.id, origin: 'conversation' });
    expect(await manager.get(created.id)).toEqual(created);
    await store.close();
  });

  it('survives repository close/reload and rehydrates ResourceRef behavior', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-work-items-reload-'));
    dirs.push(dir);
    const first = await storeAt(dir);
    const created = await new WorkManager(first).create({
      actorId: actor.id,
      projectId: project.id,
      origin: 'connector',
      resourceRefs: [new ResourceRef({ source: 'jira', externalId: 'CAP-11' })],
    });
    await first.close();

    const reloaded = await storeAt(dir);
    const found = await new WorkManager(reloaded).get(created.id);
    expect(found).toEqual(created);
    expect(found?.resourceRefs[0]?.identity).toBe('jira:CAP-11');
    await reloaded.close();
  });

  it('supports many WorkItems per canonical Actor.id and keeps actors isolated', async () => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    const first = await manager.create({ actorId: actor.id, origin: 'conversation' });
    const second = await manager.create({ actorId: actor.id, origin: 'connector' });
    await manager.create({ actorId: 'actor-2', origin: 'conversation' });
    expect((await manager.listByActor(actor.id)).map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    await store.close();
  });

  it('correlates multiple ResourceRefs without storing connector DTOs', async () => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    const jira = new ResourceRef({ source: 'jira', externalId: 'CAP-11' });
    const github = new ResourceRef({ source: 'github', externalId: '42' });
    const created = await manager.create({
      actorId: actor.id,
      origin: 'connector',
      resourceRefs: [jira, github, jira],
    });
    expect(created.resourceRefs.map((ref) => ref.identity)).toEqual(['jira:CAP-11', 'github:42']);
    expect((await manager.listByResource(github)).map((item) => item.id)).toEqual([created.id]);
    expect(created).not.toHaveProperty('connector');
    expect(created).not.toHaveProperty('metadata');
    await store.close();
  });

  it('round-trips an optional Project reference without making Project owned', async () => {
    const store = await storeAt();
    await store.projects.save(project);
    const manager = new WorkManager(store);
    const withProject = await manager.create({ actorId: actor.id, projectId: project.id, origin: 'conversation' });
    const withoutProject = await manager.create({ actorId: actor.id, origin: 'conversation' });
    expect((await manager.get(withProject.id))?.projectId).toBe(project.id);
    expect(await store.projects.get(project.id)).toEqual(project);
    expect(await manager.get(withoutProject.id)).not.toHaveProperty('projectId');
    await store.close();
  });

  it.each(['conversation', 'connector'] as const)('round-trips typed %s origin', async (origin) => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    const created = await manager.create({ actorId: actor.id, origin });
    expect((await manager.get(created.id))?.origin).toBe(origin);
    await store.close();
  });

  it.each([WorkItemStatus.COMPLETED, WorkItemStatus.CANCELED])(
    'persists terminal lifecycle %s',
    async (status) => {
      const store = await storeAt();
      const manager = new WorkManager(store);
      const created = await manager.create({ actorId: actor.id, origin: 'conversation' });
      const transitioned = await manager.transition(created.id, status);
      expect((await manager.get(created.id))?.status).toBe(status);
      expect(transitioned.status).toBe(status);
      await expect(manager.transition(created.id, WorkItemStatus.ACTIVE)).rejects.toThrow(
        'Invalid WorkItem transition',
      );
      await store.close();
    },
  );

  it('transitions the canonical persisted WorkItem and changes only status and updatedAt', async () => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    const stale = await manager.create({
      actorId: actor.id,
      origin: 'conversation',
      resourceRefs: [new ResourceRef({ source: 'jira', externalId: 'STALE' })],
    });
    const canonical = {
      ...stale,
      actorId: 'actor-canonical',
      projectId: project.id,
      resourceRefs: [new ResourceRef({ source: 'github', externalId: 'canonical' })],
      origin: 'connector' as const,
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T01:00:00.000Z',
    };
    await store.workItems.save(canonical);

    const transitioned = await manager.transition(stale.id, WorkItemStatus.COMPLETED);

    expect(transitioned).toMatchObject({
      id: canonical.id,
      actorId: canonical.actorId,
      projectId: canonical.projectId,
      origin: canonical.origin,
      createdAt: canonical.createdAt,
      status: WorkItemStatus.COMPLETED,
    });
    expect(transitioned.resourceRefs.map((ref) => ref.identity)).toEqual(['github:canonical']);
    expect(transitioned.updatedAt).not.toBe(canonical.updatedAt);
    expect(await manager.get(stale.id)).toEqual(transitioned);
    await store.close();
  });

  it('returns null and empty results when no WorkItem matches', async () => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    expect(await manager.get('missing')).toBeNull();
    expect(await manager.listByActor('missing-actor')).toEqual([]);
    expect(await manager.listByResource(new ResourceRef({ source: 'jira', externalId: 'missing' }))).toEqual([]);
    await store.close();
  });

  it('round-trips the title through the existing data JSON across reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-work-items-title-'));
    dirs.push(dir);
    const first = await storeAt(dir);
    const created = await new WorkManager(first).create({
      actorId: actor.id,
      origin: 'conversation',
      title: '  주간   보고서  ',
    });
    expect(created.title).toBe('주간 보고서');
    await first.close();

    const reloaded = await storeAt(dir);
    const found = await new WorkManager(reloaded).get(created.id);
    expect(found).toEqual(created);
    expect(found?.title).toBe('주간 보고서');
    await reloaded.close();
  });

  it('hydrates a legacy row whose data JSON has no title', async () => {
    const store = await storeAt();
    const legacy = {
      id: 'legacy-1',
      actorId: actor.id,
      resourceRefs: [{ source: 'jira', externalId: 'OLD-1' }],
      status: WorkItemStatus.ACTIVE,
      origin: 'connector',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    await store.workItems.save(legacy as unknown as WorkItem);
    const manager = new WorkManager(store);
    const found = await manager.get('legacy-1');
    expect(found).not.toHaveProperty('title');
    expect(found?.resourceRefs[0]?.identity).toBe('jira:OLD-1');
    expect((await manager.listActiveByActor(actor.id)).map((item) => item.id)).toEqual(['legacy-1']);
    await store.close();
  });

  it('persists correlate refs that listByResource can find, keeping the title', async () => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    const created = await manager.create({ actorId: actor.id, origin: 'conversation', title: 'link me' });
    const github = new ResourceRef({ source: 'github', externalId: 'owner/repo#7' });
    const correlated = await manager.correlate(created.id, [github, github]);
    expect(correlated.resourceRefs.map((ref) => ref.identity)).toEqual(['github:owner/repo#7']);
    expect((await manager.get(created.id))?.title).toBe('link me');
    expect((await manager.listByResource(github)).map((item) => item.id)).toEqual([created.id]);
    await store.close();
  });

  it('refuses correlate on a terminal item and keeps it uncorrelated', async () => {
    const store = await storeAt();
    const manager = new WorkManager(store);
    const created = await manager.create({ actorId: actor.id, origin: 'conversation', title: 'done' });
    await manager.transition(created.id, WorkItemStatus.COMPLETED);
    const github = new ResourceRef({ source: 'github', externalId: '9' });
    await expect(manager.correlate(created.id, [github])).rejects.toThrow('ACTIVE');
    expect(await manager.listByResource(github)).toEqual([]);
    expect(await manager.listActiveByActor(actor.id)).toEqual([]);
    await store.close();
  });
});
