import type { ConversationTurnRecord, FeedbackRatedTurn, FeedbackSignal, FeedbackSummary, Id, IsoTimestamp } from '../domain';

/**
 * PORT: feedback capture persistence (ADR-0098 D4; DI token `FEEDBACK_REPOSITORY`).
 *
 * Deliberately NOT part of `StorageProvider`. Implementations store no message or reply text: only the
 * fields of {@link ConversationTurnRecord} and {@link FeedbackSignal}.
 */

/** Where a conversation lives; `threadId` absent means the channel itself. */
export interface FeedbackTurnLocation {
  platform: string;
  channelId: string;
  threadId?: string;
}

export interface FeedbackSummaryQuery {
  actorId: Id;
  /** Inclusive lower bound on turn `createdAt`. */
  since: IsoTimestamp;
  /** Exclusive upper bound on turn `createdAt` (ADR-0107 D3 trend: the previous window); absent means no bound. */
  until?: IsoTimestamp;
  recentNegativeLimit: number;
}

/** ADR-0107 D3 `피드백 후보`: the actor's rated, non-control turns that have a Task, newest first. */
export interface FeedbackRatedTurnQuery {
  actorId: Id;
  /** Inclusive lower bound on turn `createdAt`. */
  since: IsoTimestamp;
  limit: number;
  /** Restrict to this one turn (re-checking a listed candidate before a save). */
  turnId?: Id;
}

export interface SaveTurnResult {
  /** The stored turn (the pre-existing one when `created` is false). */
  turn: ConversationTurnRecord;
  /** False when a turn with the same `(platform, inboundMessageId)` already existed (nothing written). */
  created: boolean;
}

export interface FeedbackRepository {
  /** Idempotent on `(platform, inboundMessageId)`; also maps each reply platform message id to the turn. */
  saveTurn(turn: ConversationTurnRecord): Promise<SaveTurnResult>;
  /** The turn whose delivered reply had this platform message id, or null. */
  findTurnByPlatformMessage(platform: string, platformMessageId: string): Promise<ConversationTurnRecord | null>;
  /**
   * The latest turn at `location` created strictly before `before` and no earlier than `before - withinMs`
   * (`threadId` matched exactly, absent matching only absent), or null.
   */
  findPreviousTurn(location: FeedbackTurnLocation, before: IsoTimestamp, withinMs: number): Promise<ConversationTurnRecord | null>;
  /** Insert, or update `kind`/`value`/`updatedAt` of the row with the same `(turnId, source, sourceKey)`. */
  upsertSignal(signal: FeedbackSignal): Promise<FeedbackSignal>;
  /** Counts over the actor's non-control turns since `query.since`; never returns text or provider ids. */
  summarize(query: FeedbackSummaryQuery): Promise<FeedbackSummary>;
  /**
   * The actor's non-control turns since `query.since` that have a Task and a current 👍 or 👎 rating (a retracted
   * reaction does not count), newest first; ids, routing facts and rating counts only (ADR-0107 D3).
   */
  listRatedTurns(query: FeedbackRatedTurnQuery): Promise<FeedbackRatedTurn[]>;
  /** Delete at most `maxRows` turns created before `cutoff` (oldest first) with their messages and signals. */
  pruneOlderThan(cutoff: IsoTimestamp, maxRows: number): Promise<number>;
}
