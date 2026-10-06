import type { Id, IsoTimestamp, LearningItem, LearningItemData, LearningItemKind } from '../domain';

/**
 * PORT: the owner-curated learning store (ADR-0107 D2, schema v14; DI token `LEARNING_REPOSITORY`).
 *
 * Deliberately NOT part of `StorageProvider`. Every read and write is scoped to one actor. Reads never return an
 * expired item (`expiresAt <= now`). Deletes are the only destructive path (ADR-0107 D7): one item by the owner,
 * every item derived from a forgotten memory record, and expiry. Implementations store only the whitelisted
 * {@link LearningItemData} fields and refuse any `egress` other than `LOCAL_ONLY`.
 */

export interface LearningItemListQuery {
  actorId: Id;
  kind: LearningItemKind;
  /** Items with `expiresAt <= now` are excluded. */
  now: IsoTimestamp;
  limit: number;
}

/** Result of {@link LearningRepository.insertWithinCap}. */
export type LearningInsertResult = 'INSERTED' | 'CAP_REACHED';

/**
 * The narrow seam the ADR-0106 memory forget/edit path calls (ADR-0107 D7, MEM-1): delete every learning item the
 * actor derived from that memory record. Returns the number of rows deleted (0 when none).
 */
export interface LearningMemoryForgetCascade {
  deleteBySourceMemory(actorId: Id, memoryId: Id): Promise<number>;
}

export interface LearningRepository extends LearningMemoryForgetCascade {
  /**
   * Insert `item` unless the actor already holds `maxPerActor` unexpired items (checked in the same transaction).
   * Never evicts an existing item.
   */
  insertWithinCap(item: LearningItem, maxPerActor: number, now: IsoTimestamp): Promise<LearningInsertResult>;
  /** The actor's unexpired item of `kind` captured from `sourceTurnId` (the newest), or null. */
  findBySourceTurn(actorId: Id, kind: LearningItemKind, sourceTurnId: Id, now: IsoTimestamp): Promise<LearningItem | null>;
  /** The actor's unexpired item `id`, or null (another actor's item is never returned). */
  get(actorId: Id, id: Id, now: IsoTimestamp): Promise<LearningItem | null>;
  /** The actor's unexpired items of one kind, newest first, at most `limit`. */
  list(query: LearningItemListQuery): Promise<LearningItem[]>;
  /** Replace the `data` of the actor's unexpired item `id`; false when there is no such item. */
  updateData(actorId: Id, id: Id, data: LearningItemData, now: IsoTimestamp): Promise<boolean>;
  /** Delete the actor's item `id`; false when there is no such item. */
  delete(actorId: Id, id: Id): Promise<boolean>;
  /** Delete at most `maxRows` items (any actor) with `expiresAt <= now`, oldest expiry first. */
  pruneExpired(now: IsoTimestamp, maxRows: number): Promise<number>;
}
