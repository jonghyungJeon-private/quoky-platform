import type { Actor, ExternalIdentity, Id, MemoryRecord, Session } from '../../domain';
import { MemoryType } from '../../domain';
import type { LearningMemoryForgetCascade, MemoryRepository, VectorProvider } from '../../ports';
import { plainTextOf } from '../message-rendering';
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
 * and the forms a memory-command reply echoed it in — the body (`기억 N 보여줘`) and previews (list, confirmation,
 * result), as the history records them (plain text). A clipped rendering contributes its kept part (the trailing `…`
 * dropped).
 */
export function memoryHistoryNeedles(contents: readonly string[]): string[] {
  const needles = new Set<string>();
  const add = (rendered: string) => {
    const needle = normalizeForHistoryMatch(rendered.endsWith('…') ? rendered.slice(0, -1) : rendered);
    if (needle.length > 0) needles.add(needle);
  };
  for (const content of contents) {
    add(content);
    add(plainTextOf(memoryBody(content, MEMORY_VIEW_MAX_CHARS)));
    add(plainTextOf(memoryPreview(content, MEMORY_PREVIEW_MAX_CHARS)));
    add(plainTextOf(memoryPreview(content, MEMORY_CONFIRM_PREVIEW_MAX_CHARS)));
  }
  return [...needles];
}

/** Invisible format characters (zero-width spaces, joiners, marks): never content of a match. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** A backslash escape of ASCII punctuation (CommonMark); a backslash before any other character is kept. */
const PUNCTUATION_ESCAPE = /\\([!-/:-@[-`{-~])/gu;

/**
 * PLT-0: turns recorded before platform-neutral rendering kept a reply as it was delivered, so echoed memory text in
 * them carries backslash escapes before punctuation and invisible format characters. Undoing exactly those (and
 * ignoring format characters on both sides) lets such an older turn still match the plain text.
 */
function historyMatchWithoutDeliveryEscapes(text: string): string {
  return normalizeForHistoryMatch(text.replace(PUNCTUATION_ESCAPE, '$1').replace(FORMAT_CHARACTERS, ''));
}

/** Whether one SHORT_TERM turn carries any of `needles` (from {@link memoryHistoryNeedles}). */
export function historyTurnCarriesMemory(record: Pick<MemoryRecord, 'content'>, needles: readonly string[]): boolean {
  const haystack = normalizeForHistoryMatch(record.content);
  if (needles.some((needle) => haystack.includes(needle))) return true;
  const delivered = historyMatchWithoutDeliveryEscapes(record.content);
  return needles.some((needle) => {
    const plain = needle.replace(FORMAT_CHARACTERS, '');
    return plain.length > 0 && delivered.includes(plain);
  });
}

/** Session lookup for a history turn recorded before turns carried their platform (`metadata.platform`). */
export interface HistorySessionLookup {
  get(id: Id): Promise<Session | null>;
}

/**
 * Whether a SHORT_TERM turn belongs to one of `identities`, matched on (platform, platform user id) — never on the
 * user id alone, so actors that share a numeric id on two platforms never touch each other's history. The turn's
 * platform is its `metadata.platform` (recorded since this fix); for an older turn it is derived from the turn's own
 * session record. A turn whose platform cannot be established is not the actor's (conservative: left alone).
 */
export async function historyTurnBelongsTo(
  turn: MemoryRecord,
  identities: readonly ExternalIdentity[],
  sessions: HistorySessionLookup,
  sessionPlatforms: Map<Id, string | null> = new Map(),
): Promise<boolean> {
  if (turn.type !== MemoryType.SHORT_TERM || turn.scope.userId === undefined) return false;
  let platform: string | undefined =
    typeof turn.metadata?.['platform'] === 'string' ? (turn.metadata['platform'] as string) : undefined;
  if (platform === undefined && turn.scope.sessionId !== undefined) {
    const sessionId = turn.scope.sessionId;
    if (!sessionPlatforms.has(sessionId)) {
      const session = await sessions.get(sessionId);
      sessionPlatforms.set(sessionId, session === null || session.id !== sessionId ? null : session.context.platform);
    }
    platform = sessionPlatforms.get(sessionId) ?? undefined;
  }
  if (platform === undefined) return false;
  return identities.some((identity) => identity.platform === platform && identity.externalId === turn.scope.userId);
}

export interface ShortTermHistoryRemovalDeps {
  /** Resolves the actor's platform identities: SHORT_TERM turns are recorded under the platform user id. */
  readonly actors: { get(id: Id): Promise<Actor | null> };
  readonly history: Pick<MemoryRepository, 'findShortTermByUser' | 'delete'>;
  /** Establishes the platform of a turn recorded without `metadata.platform` (see {@link historyTurnBelongsTo}). */
  readonly sessions: HistorySessionLookup;
}

/**
 * ADR-0106 D5 (forget means Quoky no longer uses that content), live finding W2-L01: deletes the actor's own
 * SHORT_TERM conversation-history turns (any session, either role) that carry a removed record's text — including
 * the memory-command request/confirmation/result turns that echoed it — so neither the chat transcript nor the
 * generated context files bring it back. Only the matching turns go, never the whole session; a turn is the actor's
 * only when its (platform, user id) is one of the actor's identities, so another actor's turns are never touched. Deleting an already absent turn succeeds, so the cascade is idempotent
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
      const sessionPlatforms = new Map<Id, string | null>();
      for (const userId of userIds) {
        for (const turn of await deps.history.findShortTermByUser(userId)) {
          if (turn.type !== MemoryType.SHORT_TERM || turn.scope.userId !== userId) continue;
          if (!historyTurnCarriesMemory(turn, needles)) continue;
          if (await historyTurnBelongsTo(turn, actor.identities, deps.sessions, sessionPlatforms)) {
            await deps.history.delete(turn.id);
          }
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
  /** Establishes the platform of a turn recorded without `metadata.platform` (see {@link historyTurnBelongsTo}). */
  readonly sessions: HistorySessionLookup;
}

export function createSessionHistoryClearer(deps: SessionHistoryClearerDeps): SessionHistoryClearer {
  return {
    async clearSession(actorId, sessionId) {
      const actor = await deps.actors.get(actorId);
      if (actor === null || actor.id !== actorId) return 0;
      const sessionPlatforms = new Map<Id, string | null>();
      let deleted = 0;
      for (const turn of await deps.history.findByScope({ sessionId }, MemoryType.SHORT_TERM)) {
        if (turn.type !== MemoryType.SHORT_TERM || turn.scope.sessionId !== sessionId) continue;
        if (!(await historyTurnBelongsTo(turn, actor.identities, deps.sessions, sessionPlatforms))) continue;
        await deps.history.delete(turn.id);
        deleted += 1;
      }
      return deleted;
    },
  };
}
