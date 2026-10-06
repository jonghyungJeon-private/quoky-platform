import { FeedbackSignalKind } from '../../domain';
import type {
  ConversationTurnRecord, FeedbackBreakdownRow, FeedbackSignalValue, FeedbackSummary, FeedbackTurnStatus, Id,
  InboundMessage, IsoTimestamp, Session, TurnWorkFacts,
} from '../../domain';
import type { FeedbackRepository, Logger } from '../../ports';
import { now } from '../../util/clock';
import { newId } from '../../util/id';
import { PENDING_APPROVAL_TTL_MS } from '../conversation-commands';
import { detectFeedbackTurnControl, detectImplicitSignals, requestFingerprint } from './implicit-feedback';

/** Turns (and their signals) older than this are pruned lazily (ADR-0098 D4). */
export const FEEDBACK_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** Upper bound on turns pruned by one `recordTurn` call. */
export const FEEDBACK_PRUNE_MAX_ROWS = 100;
/** `피드백 요약` window (ADR-0098 D6). */
export const FEEDBACK_SUMMARY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const FEEDBACK_SUMMARY_RECENT_NEGATIVE_LIMIT = 5;
/**
 * How far back the previous turn is looked up. Covers the longest pending-approval lifetime, so an approval
 * re-prompt (judged by status only) is still linked; the reply-relative windows are enforced by the detector.
 */
export const FEEDBACK_PREVIOUS_TURN_LOOKBACK_MS = PENDING_APPROVAL_TTL_MS;

/**
 * ADR-0107 D3 trend: 👎 rate per capability, the last {@link FEEDBACK_SUMMARY_WINDOW_MS} against the window before it.
 * Rows are the per-capability breakdowns of the two windows (counts only, no text, no provider id).
 */
export interface FeedbackCapabilityTrend {
  current: FeedbackBreakdownRow[];
  previous: FeedbackBreakdownRow[];
}

/** Session lookup used only to resolve the turn's actor. */
export interface FeedbackSessionLookup {
  get(id: Id): Promise<Pick<Session, 'actorId'> | null>;
}

/** The parts of a runtime `TurnResult` the recorder reads; the reply text is measured, never stored. */
export interface FeedbackTurnResult {
  status: FeedbackTurnStatus;
  sessionId?: Id;
  reply?: { text: string };
  workFacts?: TurnWorkFacts;
}

export interface RecordTurnInput {
  message: InboundMessage;
  result: FeedbackTurnResult;
  receipt?: { platformMessageIds: readonly string[] };
  startedAt: IsoTimestamp;
  deliveredAt: IsoTimestamp;
}

export interface FeedbackReactionInput {
  platform: string;
  platformUserId: string;
  targetPlatformMessageId: string;
  rating: 'POSITIVE' | 'NEGATIVE';
  action: 'ADDED' | 'REMOVED';
}

export interface FeedbackRecorderOptions {
  clock?: () => IsoTimestamp;
  idGenerator?: () => string;
  logger?: Logger;
}

function msBetween(from: IsoTimestamp, to: IsoTimestamp): number {
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) ? Math.max(0, span) : 0;
}

function shiftIso(iso: IsoTimestamp, deltaMs: number): IsoTimestamp {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

/**
 * Best-effort feedback capture (ADR-0098 D5, QUAL-3). Called after delivery; it never changes a reply and
 * never throws: every failure is logged without content and swallowed. Stores no message or reply text.
 */
export class FeedbackRecorder {
  private readonly clock: () => IsoTimestamp;
  private readonly idGenerator: () => string;
  private readonly logger?: Logger;

  constructor(
    private readonly repository: FeedbackRepository,
    private readonly sessions: FeedbackSessionLookup,
    options: FeedbackRecorderOptions = {},
  ) {
    this.clock = options.clock ?? now;
    this.idGenerator = options.idGenerator ?? newId;
    this.logger = options.logger;
  }

  async recordTurn(input: RecordTurnInput): Promise<void> {
    try {
      const { message, result } = input;
      const control = detectFeedbackTurnControl(message.text);
      const turn: ConversationTurnRecord = {
        id: this.idGenerator(),
        sessionId: result.sessionId,
        actorId: await this.resolveActorId(result.sessionId),
        platform: message.context.platform,
        channelId: message.context.channelId,
        threadId: message.context.threadId,
        inboundMessageId: message.id,
        platformUserId: message.context.userId,
        status: result.status,
        createdAt: input.startedAt,
        latencyMs: msBetween(input.startedAt, input.deliveredAt),
        replyChars: result.reply?.text.length ?? 0,
        ...(control ? { control } : {}),
        ...pickWorkFacts(result.workFacts),
        requestFingerprint: control ? [] : requestFingerprint(message.text),
        platformMessageIds: [...new Set(input.receipt?.platformMessageIds ?? [])],
      };
      const saved = await this.repository.saveTurn(turn);
      if (saved.created) await this.recordImplicitSignals(saved.turn, message.text, result.workFacts !== undefined);
      await this.repository.pruneOlderThan(shiftIso(this.clock(), -FEEDBACK_RETENTION_MS), FEEDBACK_PRUNE_MAX_ROWS);
    } catch (err) {
      this.logFailure('recordTurn', err);
    }
  }

  async recordReaction(signal: FeedbackReactionInput): Promise<void> {
    try {
      const turn = await this.repository.findTurnByPlatformMessage(signal.platform, signal.targetPlatformMessageId);
      // Only the turn's own user rates it; an unknown message or another rater is dropped.
      if (!turn || turn.control || turn.platformUserId !== signal.platformUserId) return;
      const value: FeedbackSignalValue = signal.action === 'ADDED' ? signal.rating : 'RETRACTED';
      const at = this.clock();
      await this.repository.upsertSignal({
        id: this.idGenerator(),
        turnId: turn.id,
        kind: FeedbackSignalKind.EXPLICIT_RATING,
        source: 'REACTION',
        // One row per (rater, emoji): removing 👍 never retracts a 👎 that is still present.
        sourceKey: `${signal.platformUserId}:${signal.rating}`,
        value,
        createdAt: at,
        updatedAt: at,
      });
    } catch (err) {
      this.logFailure('recordReaction', err);
    }
  }

  /** The actor's 30-day summary, or null when it cannot be read. */
  async summarize(actorId: Id): Promise<FeedbackSummary | null> {
    try {
      return await this.repository.summarize({
        actorId,
        since: shiftIso(this.clock(), -FEEDBACK_SUMMARY_WINDOW_MS),
        recentNegativeLimit: FEEDBACK_SUMMARY_RECENT_NEGATIVE_LIMIT,
      });
    } catch (err) {
      this.logFailure('summarize', err);
      return null;
    }
  }

  /**
   * The actor's per-capability breakdown for this window and the previous one (ADR-0107 D3), from one clock reading,
   * or null when the store cannot be read.
   */
  async trend(actorId: Id): Promise<FeedbackCapabilityTrend | null> {
    try {
      const at = this.clock();
      const since = shiftIso(at, -FEEDBACK_SUMMARY_WINDOW_MS);
      const current = await this.repository.summarize({ actorId, since, recentNegativeLimit: 0 });
      const previous = await this.repository.summarize({
        actorId,
        since: shiftIso(at, -2 * FEEDBACK_SUMMARY_WINDOW_MS),
        until: since,
        recentNegativeLimit: 0,
      });
      return { current: current.byCapability, previous: previous.byCapability };
    } catch (err) {
      this.logFailure('trend', err);
      return null;
    }
  }

  private async resolveActorId(sessionId: Id | undefined): Promise<Id | undefined> {
    if (!sessionId) return undefined;
    try {
      return (await this.sessions.get(sessionId))?.actorId;
    } catch (err) {
      this.logFailure('resolveActor', err);
      return undefined;
    }
  }

  private async recordImplicitSignals(current: ConversationTurnRecord, text: string, hasWorkFacts: boolean): Promise<void> {
    const previous = await this.repository.findPreviousTurn(
      { platform: current.platform, channelId: current.channelId, threadId: current.threadId },
      current.createdAt,
      FEEDBACK_PREVIOUS_TURN_LOOKBACK_MS,
    );
    if (!previous || previous.platformUserId !== current.platformUserId) return;
    const kinds = detectImplicitSignals({
      previous,
      currentText: text,
      currentStatus: current.status,
      currentHasWorkFacts: hasWorkFacts,
      elapsedMs: msBetween(shiftIso(previous.createdAt, previous.latencyMs), current.createdAt),
    });
    const at = this.clock();
    for (const kind of kinds) {
      await this.repository.upsertSignal({
        id: this.idGenerator(),
        turnId: previous.id,
        kind,
        source: 'IMPLICIT',
        sourceKey: kind,
        value: 'OBSERVED',
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  private logFailure(stage: string, err: unknown): void {
    try {
      this.logger?.warn('feedback capture failed', {
        stage,
        errorName: err instanceof Error ? err.name : typeof err,
      });
    } catch {
      // Logging is best-effort as well; capture must never throw to callers.
    }
  }
}

function pickWorkFacts(facts: TurnWorkFacts | undefined): TurnWorkFacts {
  if (!facts) return {};
  const picked: TurnWorkFacts = {};
  if (facts.intentType !== undefined) picked.intentType = facts.intentType;
  if (facts.capability !== undefined) picked.capability = facts.capability;
  if (facts.taskId !== undefined) picked.taskId = facts.taskId;
  if (facts.runId !== undefined) picked.runId = facts.runId;
  if (facts.providerId !== undefined) picked.providerId = facts.providerId;
  return picked;
}
