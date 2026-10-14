import { newId } from '../util/id';
import { now } from '../util/clock';
import {
  ActionWriteStoppedError,
  WorkItemStatus,
  isActionSwitchRunning,
  assertResourceRefCapacity,
  correlateWorkItem,
  normalizeWorkItemTitle,
  reopenWorkItem,
  transitionWorkItem,
  uniqueResourceRefs,
} from '../domain';
import type { ActionWriteCondition, Id, ResourceRef, WorkItem, WorkItemOrigin } from '../domain';
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

  /**
   * ADR-0120 amendment A6-D3: the one write path of every A6 to-do mutation. With a `condition`, the store evaluates it
   * atomically with the write (`saveIf`, the same transaction) and nothing is written while the actor's switch is
   * stopped (`ActionWriteStoppedError`). A store without `saveIf` falls back to a re-read right before the save.
   */
  private async write(item: WorkItem, condition?: ActionWriteCondition): Promise<WorkItem> {
    if (condition === undefined) return this.storage.workItems.save(item);
    if (this.storage.workItems.saveIf !== undefined) {
      const saved = await this.storage.workItems.saveIf(item, condition);
      if (saved === null) throw new ActionWriteStoppedError();
      return saved;
    }
    const actor = await this.storage.actors.get(condition.actionSwitchOf);
    if (actor === null || !isActionSwitchRunning(actor.metadata)) throw new ActionWriteStoppedError();
    return this.storage.workItems.save(item);
  }

  async create(input: CreateWorkItemInput, condition?: ActionWriteCondition): Promise<WorkItem> {
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
    return this.write(workItem, condition);
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

  async transition(id: Id, status: WorkItemStatus, condition?: ActionWriteCondition): Promise<WorkItem> {
    return this.serialize(id, async () => {
      const canonical = await this.storage.workItems.get(id);
      if (!canonical) throw new Error(`WorkItem not found: ${id}`);
      return this.write(transitionWorkItem(canonical, status, now()), condition);
    });
  }

  /**
   * ADR-0120 amendment A6 (record B), the A6 undo path ONLY: reopen the SAME completed or canceled item, provided it is
   * unchanged since the action being undone (`expectedUpdatedAt`). Throws `WorkItemReopenError` otherwise. Serialized
   * with every other mutation of the item.
   */
  async reopen(id: Id, expectedUpdatedAt: string, condition?: ActionWriteCondition): Promise<WorkItem> {
    return this.serialize(id, async () => {
      const canonical = await this.storage.workItems.get(id);
      if (!canonical) throw new Error(`WorkItem not found: ${id}`);
      return this.write(reopenWorkItem(canonical, now(), expectedUpdatedAt), condition);
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
