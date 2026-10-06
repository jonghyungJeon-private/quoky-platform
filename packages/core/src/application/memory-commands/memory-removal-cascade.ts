import type { Actor, Id, MemoryRecord } from '../../domain';
import { MemoryType } from '../../domain';
import type { LearningMemoryForgetCascade, MemoryRepository, VectorProvider } from '../../ports';
import { DURABLE_MEMORY_VECTOR_COLLECTION } from '../recall/semantic-recall-scorer';
import {
  MEMORY_CONFIRM_PREVIEW_MAX_CHARS,
  MEMORY_PREVIEW_MAX_CHARS,
  MEMORY_VIEW_MAX_CHARS,
  memoryBody,
  memoryPreview,
} from './memory-command-renderer';

/**
 * What a memory command removed from the owner's durable recall (ADR-0106 D5):
 *  - `forget`: the record and its earlier (superseded) versions are about to be deleted;
 *  - `edit`: the record was superseded by a new one and no longer takes part in recall.
 */
export interface MemoryRemovalEvent {
  readonly actorId: Id;
  readonly reason: 'forget' | 'edit';
  /** Memory record ids. */
  readonly memoryIds: readonly Id[];
  /** Vector ids the records carried besides their own ids (`MemoryRecord.vectorId`), if any. */
  readonly vectorIds: readonly Id[];
  /** The removed records' texts (W2-L01: the conversation-history purge matches on them). Never logged. */
  readonly contents: readonly string[];
}

/**
 * The forget/edit cascade seam (ADR-0106 D5, ADR-0107 D7): data derived from a durable memory that must go when the
 * memory goes. This is an application-level hook, not a port — it adds no DI token (ADR-0106 D6); the composition
 * root passes the list it has. Implementations are idempotent: removing what is already absent succeeds.
 *
 * Wired at the composition root: the `VectorProvider` cache entry ({@link createVectorRemovalCascade}), LRN-1's v14
 * `learning_items` store ({@link createLearningItemsRemovalCascade}): every row whose `source_memory_id` is one of
 * `memoryIds`, scoped to `actorId`, and the actor's own SHORT_TERM conversation history
 * ({@link createShortTermHistoryRemovalCascade}, W2-L01).
 */
export interface MemoryRemovalCascade {
  /** A short, content-free name for logs. */
  readonly id: string;
  onMemoriesRemoved(event: MemoryRemovalEvent): Promise<void>;
}

/**
 * Removes the durable-memory vectors (ADR-0098 D8 cache: vector ids equal memory ids) through the existing
 * `VectorProvider.delete`. The cache is rebuildable; this keeps a forgotten memory's embedding off the disk.
 */
export function createVectorRemovalCascade(
  vectors: Pick<VectorProvider, 'delete'>,
  collection: string = DURABLE_MEMORY_VECTOR_COLLECTION,
): MemoryRemovalCascade {
  return {
    id: 'vector',
    async onMemoriesRemoved(event) {
      const ids = [...new Set([...event.memoryIds, ...event.vectorIds])];
      if (ids.length === 0) return;
      await vectors.delete(collection, ids);
    },
  };
}

/**
 * ADR-0106 D5 / ADR-0107 D7: deletes every learning item the actor derived from a removed memory record (forget: the
 * record and its superseded history; edit: the superseded record) through the narrow
 * {@link LearningMemoryForgetCascade} seam of the `LearningRepository` port. Actor-scoped; deleting an already
 * absent row deletes nothing and succeeds, so the cascade is idempotent.
 */
export function createLearningItemsRemovalCascade(learning: LearningMemoryForgetCascade): MemoryRemovalCascade {
  return {
    id: 'learning-items',
    async onMemoriesRemoved(event) {
      for (const memoryId of new Set(event.memoryIds)) {
        await learning.deleteBySourceMemory(event.actorId, memoryId);
      }
    },
  };
}

/** NFC and whitespace-collapsed: both sides of a conversation-history match are compared in this form. */
export function normalizeForHistoryMatch(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * The fragments whose presence marks a history turn as carrying a removed memory's text (W2-L01): the text itself,
 * and the forms a memory-command reply echoed it in — the Discord-escaped body (`기억 N 보여줘`) and previews (list,
 * confirmation, result). A clipped rendering contributes its kept part (the trailing `…` dropped).
 */
export function memoryHistoryNeedles(contents: readonly string[]): string[] {
  const needles = new Set<string>();
  const add = (rendered: string) => {
    const needle = normalizeForHistoryMatch(rendered.endsWith('…') ? rendered.slice(0, -1) : rendered);
    if (needle.length > 0) needles.add(needle);
  };
  for (const content of contents) {
    add(content);
    add(memoryBody(content, MEMORY_VIEW_MAX_CHARS));
    add(memoryPreview(content, MEMORY_PREVIEW_MAX_CHARS));
    add(memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS));
  }
  return [...needles];
}

/** Whether one SHORT_TERM turn carries any of `needles` (from {@link memoryHistoryNeedles}). */
export function historyTurnCarriesMemory(record: Pick<MemoryRecord, 'content'>, needles: readonly string[]): boolean {
  const haystack = normalizeForHistoryMatch(record.content);
  return needles.some((needle) => haystack.includes(needle));
}

export interface ShortTermHistoryRemovalDeps {
  /** Resolves the actor's platform identities: SHORT_TERM turns are recorded under the platform user id. */
  readonly actors: { get(id: Id): Promise<Actor | null> };
  readonly history: Pick<MemoryRepository, 'findShortTermByUser' | 'delete'>;
}

/**
 * ADR-0106 D5 (forget means Quoky no longer uses that content), live finding W2-L01: deletes the actor's own
 * SHORT_TERM conversation-history turns (any session, either role) that carry a removed record's text — including
 * the memory-command request/confirmation/result turns that echoed it — so neither the chat transcript nor the
 * generated context files bring it back. Only the matching turns go, never the whole session; turns recorded under
 * another user id are never read or touched. Deleting an already absent turn succeeds, so the cascade is idempotent
 * and a failed forget is retried by asking again.
 */
export function createShortTermHistoryRemovalCascade(deps: ShortTermHistoryRemovalDeps): MemoryRemovalCascade {
  return {
    id: 'short-term-history',
    async onMemoriesRemoved(event) {
      const needles = memoryHistoryNeedles(event.contents);
      if (needles.length === 0) return;
      const actor = await deps.actors.get(event.actorId);
      if (actor === null || actor.id !== event.actorId) return;
      const userIds = new Set(actor.identities.map((identity) => identity.externalId));
      for (const userId of userIds) {
        for (const turn of await deps.history.findShortTermByUser(userId)) {
          if (turn.type !== MemoryType.SHORT_TERM || turn.scope.userId !== userId) continue;
          if (historyTurnCarriesMemory(turn, needles)) await deps.history.delete(turn.id);
        }
      }
    },
  };
}

/**
 * ADR-0106 amendment D5: clears the actor's own SHORT_TERM history of one session — the conversation the forget or
 * edit was confirmed in — so a paraphrase of the memory (which the exact-text purge above cannot recognise) is not
 * used again. Project binding and long-term memories are untouched; another user's turns in a shared session are
 * never read or deleted; purged history is not archived.
 */
export interface SessionHistoryClearer {
  /** Delete the actor's SHORT_TERM turns recorded in `sessionId`; resolves to the number deleted. Idempotent. */
  clearSession(actorId: Id, sessionId: Id): Promise<number>;
}

export interface SessionHistoryClearerDeps {
  /** Resolves the actor's platform identities: SHORT_TERM turns are recorded under the platform user id. */
  readonly actors: { get(id: Id): Promise<Actor | null> };
  readonly history: Pick<MemoryRepository, 'findByScope' | 'delete'>;
}

export function createSessionHistoryClearer(deps: SessionHistoryClearerDeps): SessionHistoryClearer {
  return {
    async clearSession(actorId, sessionId) {
      const actor = await deps.actors.get(actorId);
      if (actor === null || actor.id !== actorId) return 0;
      const userIds = new Set(actor.identities.map((identity) => identity.externalId));
      let deleted = 0;
      for (const turn of await deps.history.findByScope({ sessionId }, MemoryType.SHORT_TERM)) {
        if (turn.type !== MemoryType.SHORT_TERM || turn.scope.sessionId !== sessionId) continue;
        if (turn.scope.userId === undefined || !userIds.has(turn.scope.userId)) continue;
        await deps.history.delete(turn.id);
        deleted += 1;
      }
      return deleted;
    },
  };
}
