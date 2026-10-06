import type { Id, IsoTimestamp } from './common';
import type { Capability, IntentType } from './enums';

/**
 * Answer-feedback capture domain model (ADR-0098 D4/D5, QUAL-3).
 *
 * Content-free by construction: no type here carries message text, reply text, prompt or provider output.
 * A turn is described only by ids, routing facts, sizes and a bounded keyword fingerprint (first 8 hex of
 * sha256 per keyword). Feedback is evidence for the owner, never a learning signal: nothing reads it to
 * change prompts, routing, memory or approvals.
 */

/** Mirrors the Application-layer `RuntimeTurnStatus` as a plain domain string (domain never imports application). */
export type FeedbackTurnStatus = 'RESPONDED' | 'AWAITING_APPROVAL' | 'DENIED' | 'FAILED' | 'CANCELLED';

/** Control phrase a turn was (ADR-0093 help/reset; ADR-0098 D6 `피드백 요약`). Control turns are never rated. */
export type FeedbackTurnControl = 'help' | 'reset' | 'feedback-summary';

/** Upper bound on `ConversationTurnRecord.requestFingerprint` entries (ADR-0098 D4). */
export const FEEDBACK_FINGERPRINT_MAX_ENTRIES = 32;

/**
 * Transient routing facts of a work turn (ADR-0098 D5 `TurnResult.workFacts`). Never persisted on Session;
 * copied only into a {@link ConversationTurnRecord}. `providerId` is audit-only and never shown to a user.
 */
export interface TurnWorkFacts {
  intentType?: IntentType;
  capability?: Capability;
  taskId?: Id;
  runId?: Id;
  providerId?: string;
}

/** One handled inbound message, stored without any text (ADR-0098 D4). */
export interface ConversationTurnRecord extends TurnWorkFacts {
  id: Id;
  sessionId?: Id;
  actorId?: Id;
  platform: string;
  channelId: string;
  threadId?: string;
  /** Platform id of the inbound message; unique per platform (duplicate deliveries are idempotent). */
  inboundMessageId: string;
  platformUserId: string;
  status: FeedbackTurnStatus;
  createdAt: IsoTimestamp;
  latencyMs: number;
  /** Length of the delivered reply text — the text itself is never stored. */
  replyChars: number;
  control?: FeedbackTurnControl;
  /** At most {@link FEEDBACK_FINGERPRINT_MAX_ENTRIES} entries, each the first 8 hex of sha256(keyword). */
  requestFingerprint: string[];
  /** Platform ids of the delivered reply messages (from the outbound delivery receipt, when any). */
  platformMessageIds: string[];
}

export enum FeedbackSignalKind {
  EXPLICIT_RATING = 'EXPLICIT_RATING',
  IMPLICIT_RESET_AFTER_REPLY = 'IMPLICIT_RESET_AFTER_REPLY',
  IMPLICIT_CORRECTION = 'IMPLICIT_CORRECTION',
  IMPLICIT_REPHRASE = 'IMPLICIT_REPHRASE',
  IMPLICIT_APPROVAL_REPROMPT = 'IMPLICIT_APPROVAL_REPROMPT',
}

export type FeedbackSignalSource = 'REACTION' | 'IMPLICIT';

/** `RETRACTED` is a removed reaction; `OBSERVED` marks implicit evidence (never a rating). */
export type FeedbackSignalValue = 'POSITIVE' | 'NEGATIVE' | 'RETRACTED' | 'OBSERVED';

/** One signal about a turn; idempotent on `(turnId, source, sourceKey)`. */
export interface FeedbackSignal {
  id: Id;
  turnId: Id;
  kind: FeedbackSignalKind;
  source: FeedbackSignalSource;
  sourceKey: string;
  value: FeedbackSignalValue;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface FeedbackSignalCount {
  kind: FeedbackSignalKind;
  value: FeedbackSignalValue;
  count: number;
}

/** Per-capability or per-intent counts. `key` is the capability/intent value, or null when the turn had none. */
export interface FeedbackBreakdownRow {
  key: string | null;
  turns: number;
  positive: number;
  negative: number;
  /** Implicit evidence count (never counted as a rating). */
  implicit: number;
}

/** A recent 👎-rated turn: ids and routing facts only, no text and no provider id. */
export interface FeedbackRecentNegativeTurn {
  turnId: Id;
  createdAt: IsoTimestamp;
  intentType?: IntentType;
  taskId?: Id;
}

/**
 * A recent explicitly rated turn that has a locally stored Task (ADR-0107 D3 `피드백 후보`): ids, routing facts and
 * rating counts only, no text and no provider id. `negative`/`positive` count the current (non-retracted) 👎/👍 rows.
 */
export interface FeedbackRatedTurn {
  turnId: Id;
  createdAt: IsoTimestamp;
  taskId: Id;
  intentType?: IntentType;
  capability?: Capability;
  positive: number;
  negative: number;
}

/** Aggregate over one actor's non-control turns created at or after `since` (ADR-0098 D6). */
export interface FeedbackSummary {
  since: IsoTimestamp;
  turnCount: number;
  signals: FeedbackSignalCount[];
  byCapability: FeedbackBreakdownRow[];
  byIntent: FeedbackBreakdownRow[];
  recentNegative: FeedbackRecentNegativeTurn[];
}
