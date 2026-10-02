import { newId } from '../util/id';
import { now } from '../util/clock';
import {
  WorkItemStatus,
  assertResourceRefCapacity,
  correlateWorkItem,
  normalizeWorkItemTitle,
  transitionWorkItem,
  uniqueResourceRefs,
} from '../domain';
import type { Id, ResourceRef, WorkItem, WorkItemOrigin } from '../domain';
import type { StorageProvider } from '../ports';

export interface CreateWorkItemInput {
  actorId: Id;
  projectId?: Id;
  /**
   * Normalized (trimmed, collapsed, 1..200 chars) when present. ADR-0100 D4 requires
   * a title for conversation-origin items; WORK-T3 todo.add enforces that.
   */
  title?: string;
  resourceRefs?: readonly ResourceRef[];
  origin: WorkItemOrigin;
}

/** CAP-011 application owner for durable WorkItem creation, reads and lifecycle. */
export class WorkManager {
  /** Per-WorkItem mutation tail so read-modify-write cycles never interleave. */
  private readonly mutations = new Map<Id, Promise<unknown>>();

  constructor(private readonly storage: StorageProvider) {}

  private serialize<T>(id: Id, mutate: () => Promise<T>): Promise<T> {
    const run = (this.mutations.get(id) ?? Promise.resolve()).then(mutate);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(id, tail);
    void tail.then(() => {
      if (this.mutations.get(id) === tail) this.mutations.delete(id);
    });
    return run;
  }

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const timestamp = now();
    const resourceRefs = uniqueResourceRefs(input.resourceRefs ?? []);
    assertResourceRefCapacity(resourceRefs);
    const workItem: WorkItem = {
      id: newId(),
      actorId: input.actorId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.title !== undefined ? { title: normalizeWorkItemTitle(input.title) } : {}),
      resourceRefs,
      status: WorkItemStatus.ACTIVE,
      origin: input.origin,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.storage.workItems.save(workItem);
  }

  async get(id: Id): Promise<WorkItem | null> {
    return this.storage.workItems.get(id);
  }

  async listByActor(actorId: Id): Promise<WorkItem[]> {
    return this.storage.workItems.listByActor(actorId);
  }

  /** ACTIVE work only, in repository order (createdAt, id). */
  async listActiveByActor(actorId: Id): Promise<WorkItem[]> {
    return (await this.storage.workItems.listByActor(actorId)).filter(
      (item) => item.status === WorkItemStatus.ACTIVE,
    );
  }

  async listByResource(resource: ResourceRef): Promise<WorkItem[]> {
    return this.storage.workItems.listByResource(resource);
  }

  async transition(id: Id, status: WorkItemStatus): Promise<WorkItem> {
    return this.serialize(id, async () => {
      const canonical = await this.storage.workItems.get(id);
      if (!canonical) throw new Error(`WorkItem not found: ${id}`);
      return this.storage.workItems.save(transitionWorkItem(canonical, status, now()));
    });
  }

  /** Add ResourceRef correlations to the canonical ACTIVE WorkItem (ADR-0100 D4). */
  async correlate(id: Id, refs: readonly ResourceRef[]): Promise<WorkItem> {
    return this.serialize(id, async () => {
      const canonical = await this.storage.workItems.get(id);
      if (!canonical) throw new Error(`WorkItem not found: ${id}`);
      return this.storage.workItems.save(correlateWorkItem(canonical, refs, now()));
    });
  }
}
