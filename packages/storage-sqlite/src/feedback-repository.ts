import type Database from 'better-sqlite3';
import { FEEDBACK_FINGERPRINT_MAX_ENTRIES, FeedbackSignalKind } from '@quoky/core';
import type {
  Capability, ConversationTurnRecord, FeedbackBreakdownRow, FeedbackRatedTurn, FeedbackRatedTurnQuery,
  FeedbackRepository, FeedbackSignal, FeedbackSignalCount, FeedbackSignalSource, FeedbackSignalValue, FeedbackSummary,
  FeedbackSummaryQuery, FeedbackTurnControl, FeedbackTurnLocation, FeedbackTurnStatus, IntentType, IsoTimestamp,
  SaveTurnResult,
} from '@quoky/core';

type Db = Database.Database;

type TurnRow = {
  id: string; session_id: string | null; actor_id: string | null; platform: string; channel_id: string;
  thread_id: string | null; inbound_message_id: string; status: string; created_at: string; data: string;
};
type SignalRow = {
  id: string; turn_id: string; kind: string; source: string; source_key: string; value: string;
  created_at: string; updated_at: string;
};
type BreakdownSqlRow = { key: string | null; turns: number; positive: number | null; negative: number | null; implicit: number | null };

/** The JSON `data` column: an explicit whitelist so no text field can ever be persisted by spreading. */
interface TurnData {
  platformUserId: string;
  intentType?: IntentType;
  capability?: Capability;
  taskId?: string;
  runId?: string;
  providerId?: string;
  latencyMs: number;
  replyChars: number;
  control?: FeedbackTurnControl;
  requestFingerprint: string[];
}

function turnData(turn: ConversationTurnRecord): TurnData {
  const data: TurnData = {
    platformUserId: turn.platformUserId,
    latencyMs: turn.latencyMs,
    replyChars: turn.replyChars,
    requestFingerprint: turn.requestFingerprint.slice(0, FEEDBACK_FINGERPRINT_MAX_ENTRIES),
  };
  if (turn.intentType !== undefined) data.intentType = turn.intentType;
  if (turn.capability !== undefined) data.capability = turn.capability;
  if (turn.taskId !== undefined) data.taskId = turn.taskId;
  if (turn.runId !== undefined) data.runId = turn.runId;
  if (turn.providerId !== undefined) data.providerId = turn.providerId;
  if (turn.control !== undefined) data.control = turn.control;
  return data;
}

function signalOf(row: SignalRow): FeedbackSignal {
  return {
    id: row.id,
    turnId: row.turn_id,
    kind: row.kind as FeedbackSignalKind,
    source: row.source as FeedbackSignalSource,
    sourceKey: row.source_key,
    value: row.value as FeedbackSignalValue,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function breakdown(rows: BreakdownSqlRow[]): FeedbackBreakdownRow[] {
  return rows.map((row) => ({
    key: row.key,
    turns: row.turns,
    positive: row.positive ?? 0,
    negative: row.negative ?? 0,
    implicit: row.implicit ?? 0,
  }));
}

// Turn filter shared by every summary query: the actor's non-control turns in the window (`@until` exclusive, or
// NULL for no upper bound — ADR-0107 D3 trend).
const SUMMARY_TURNS = `t.actor_id = @actorId AND t.created_at >= @since AND (@until IS NULL OR t.created_at < @until)
  AND json_extract(t.data, '$.control') IS NULL`;
const RATING = `s.kind = '${FeedbackSignalKind.EXPLICIT_RATING}' AND s.source = 'REACTION'`;
const BREAKDOWN_SELECT = `COUNT(DISTINCT t.id) AS turns,
  SUM(CASE WHEN ${RATING} AND s.value = 'POSITIVE' THEN 1 ELSE 0 END) AS positive,
  SUM(CASE WHEN ${RATING} AND s.value = 'NEGATIVE' THEN 1 ELSE 0 END) AS negative,
  SUM(CASE WHEN s.source = 'IMPLICIT' THEN 1 ELSE 0 END) AS implicit
  FROM conversation_turns t LEFT JOIN feedback_signals s ON s.turn_id = t.id
  WHERE ${SUMMARY_TURNS}`;

/**
 * SQLite feedback store (ADR-0098 D4, migration v12). Persists ids, routing facts, sizes and keyword hashes
 * only — no message or reply text. Not part of `StorageProvider`.
 */
export class SqliteFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: Db) {}

  async saveTurn(turn: ConversationTurnRecord): Promise<SaveTurnResult> {
    return this.db.transaction((): SaveTurnResult => {
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO conversation_turns
           (id, session_id, actor_id, platform, channel_id, thread_id, inbound_message_id, status, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        turn.id, turn.sessionId ?? null, turn.actorId ?? null, turn.platform, turn.channelId, turn.threadId ?? null,
        turn.inboundMessageId, turn.status, turn.createdAt, JSON.stringify(turnData(turn)),
      );
      if (inserted.changes === 0) {
        const existing = this.db.prepare(
          'SELECT * FROM conversation_turns WHERE platform = ? AND inbound_message_id = ?',
        ).get(turn.platform, turn.inboundMessageId) as TurnRow | undefined;
        if (!existing) throw new Error('FEEDBACK_TURN_ID_CONFLICT');
        return { turn: this.toTurn(existing), created: false };
      }
      const mapMessage = this.db.prepare(
        'INSERT OR IGNORE INTO turn_platform_messages (platform, platform_message_id, turn_id) VALUES (?, ?, ?)',
      );
      for (const messageId of new Set(turn.platformMessageIds)) mapMessage.run(turn.platform, messageId, turn.id);
      const stored = this.db.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(turn.id) as TurnRow;
      return { turn: this.toTurn(stored), created: true };
    })();
  }

  async findTurnByPlatformMessage(platform: string, platformMessageId: string): Promise<ConversationTurnRecord | null> {
    const row = this.db.prepare(
      `SELECT t.* FROM turn_platform_messages m JOIN conversation_turns t ON t.id = m.turn_id
       WHERE m.platform = ? AND m.platform_message_id = ?`,
    ).get(platform, platformMessageId) as TurnRow | undefined;
    return row ? this.toTurn(row) : null;
  }

  async findPreviousTurn(
    location: FeedbackTurnLocation, before: IsoTimestamp, withinMs: number,
  ): Promise<ConversationTurnRecord | null> {
    const beforeMs = Date.parse(before);
    if (!Number.isFinite(beforeMs) || !Number.isFinite(withinMs) || withinMs < 0) return null;
    const after = new Date(beforeMs - withinMs).toISOString();
    const row = this.db.prepare(
      `SELECT * FROM conversation_turns
       WHERE platform = ? AND channel_id = ? AND thread_id IS ? AND created_at < ? AND created_at >= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(location.platform, location.channelId, location.threadId ?? null, before, after) as TurnRow | undefined;
    return row ? this.toTurn(row) : null;
  }

  async upsertSignal(signal: FeedbackSignal): Promise<FeedbackSignal> {
    return this.db.transaction((): FeedbackSignal => {
      this.db.prepare(
        `INSERT INTO feedback_signals (id, turn_id, kind, source, source_key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (turn_id, source, source_key)
         DO UPDATE SET kind = excluded.kind, value = excluded.value, updated_at = excluded.updated_at`,
      ).run(
        signal.id, signal.turnId, signal.kind, signal.source, signal.sourceKey, signal.value, signal.createdAt,
        signal.updatedAt,
      );
      const row = this.db.prepare(
        'SELECT * FROM feedback_signals WHERE turn_id = ? AND source = ? AND source_key = ?',
      ).get(signal.turnId, signal.source, signal.sourceKey) as SignalRow;
      return signalOf(row);
    })();
  }

  async summarize(query: FeedbackSummaryQuery): Promise<FeedbackSummary> {
    const params = { actorId: query.actorId, since: query.since, until: query.until ?? null };
    const limit = Math.max(0, Math.trunc(query.recentNegativeLimit));
    return this.db.transaction((): FeedbackSummary => {
      const turnCount = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM conversation_turns t WHERE ${SUMMARY_TURNS}`,
      ).get(params) as { n: number }).n;
      const signals = (this.db.prepare(
        `SELECT s.kind AS kind, s.value AS value, COUNT(*) AS count
         FROM feedback_signals s JOIN conversation_turns t ON t.id = s.turn_id
         WHERE ${SUMMARY_TURNS} GROUP BY s.kind, s.value ORDER BY s.kind, s.value`,
      ).all(params) as Array<{ kind: string; value: string; count: number }>).map((row): FeedbackSignalCount => ({
        kind: row.kind as FeedbackSignalKind, value: row.value as FeedbackSignalValue, count: row.count,
      }));
      const byCapability = breakdown(this.db.prepare(
        `SELECT json_extract(t.data, '$.capability') AS key, ${BREAKDOWN_SELECT} GROUP BY key ORDER BY key`,
      ).all(params) as BreakdownSqlRow[]);
      const byIntent = breakdown(this.db.prepare(
        `SELECT json_extract(t.data, '$.intentType') AS key, ${BREAKDOWN_SELECT} GROUP BY key ORDER BY key`,
      ).all(params) as BreakdownSqlRow[]);
      const recentNegative = (this.db.prepare(
        `SELECT t.id AS turnId, t.created_at AS createdAt,
           json_extract(t.data, '$.intentType') AS intentType, json_extract(t.data, '$.taskId') AS taskId
         FROM conversation_turns t
         WHERE ${SUMMARY_TURNS} AND EXISTS (
           SELECT 1 FROM feedback_signals s WHERE s.turn_id = t.id AND ${RATING} AND s.value = 'NEGATIVE')
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT @limit`,
      ).all({ ...params, limit }) as Array<{ turnId: string; createdAt: string; intentType: string | null; taskId: string | null }>)
        .map((row) => ({
          turnId: row.turnId,
          createdAt: row.createdAt,
          ...(row.intentType !== null ? { intentType: row.intentType as IntentType } : {}),
          ...(row.taskId !== null ? { taskId: row.taskId } : {}),
        }));
      return { since: query.since, turnCount, signals, byCapability, byIntent, recentNegative };
    })();
  }

  async listRatedTurns(query: FeedbackRatedTurnQuery): Promise<FeedbackRatedTurn[]> {
    const limit = Math.max(0, Math.trunc(query.limit));
    if (limit === 0) return [];
    const rows = this.db.prepare(
      `SELECT t.id AS turnId, t.created_at AS createdAt, json_extract(t.data, '$.taskId') AS taskId,
         json_extract(t.data, '$.intentType') AS intentType, json_extract(t.data, '$.capability') AS capability,
         SUM(CASE WHEN s.value = 'POSITIVE' THEN 1 ELSE 0 END) AS positive,
         SUM(CASE WHEN s.value = 'NEGATIVE' THEN 1 ELSE 0 END) AS negative
       FROM conversation_turns t JOIN feedback_signals s ON s.turn_id = t.id AND ${RATING}
       WHERE t.actor_id = @actorId AND t.created_at >= @since AND json_extract(t.data, '$.control') IS NULL
         AND json_extract(t.data, '$.taskId') IS NOT NULL AND (@turnId IS NULL OR t.id = @turnId)
       GROUP BY t.id HAVING positive > 0 OR negative > 0
       ORDER BY t.created_at DESC, t.rowid DESC LIMIT @limit`,
    ).all({ actorId: query.actorId, since: query.since, turnId: query.turnId ?? null, limit }) as Array<{
      turnId: string; createdAt: string; taskId: string; intentType: string | null; capability: string | null;
      positive: number; negative: number;
    }>;
    return rows.map((row) => ({
      turnId: row.turnId,
      createdAt: row.createdAt,
      taskId: row.taskId,
      ...(row.intentType !== null ? { intentType: row.intentType as IntentType } : {}),
      ...(row.capability !== null ? { capability: row.capability as Capability } : {}),
      positive: row.positive,
      negative: row.negative,
    }));
  }

  async pruneOlderThan(cutoff: IsoTimestamp, maxRows: number): Promise<number> {
    const limit = Math.max(0, Math.trunc(maxRows));
    if (limit === 0) return 0;
    return this.db.transaction((): number => {
      const ids = (this.db.prepare(
        'SELECT id FROM conversation_turns WHERE created_at < ? ORDER BY created_at, rowid LIMIT ?',
      ).all(cutoff, limit) as Array<{ id: string }>).map((row) => row.id);
      const deleteSignals = this.db.prepare('DELETE FROM feedback_signals WHERE turn_id = ?');
      const deleteMessages = this.db.prepare('DELETE FROM turn_platform_messages WHERE turn_id = ?');
      const deleteTurn = this.db.prepare('DELETE FROM conversation_turns WHERE id = ?');
      for (const id of ids) {
        deleteSignals.run(id);
        deleteMessages.run(id);
        deleteTurn.run(id);
      }
      return ids.length;
    })();
  }

  private toTurn(row: TurnRow): ConversationTurnRecord {
    const data = JSON.parse(row.data) as TurnData;
    const platformMessageIds = (this.db.prepare(
      'SELECT platform_message_id FROM turn_platform_messages WHERE turn_id = ? ORDER BY rowid',
    ).all(row.id) as Array<{ platform_message_id: string }>).map((m) => m.platform_message_id);
    const turn: ConversationTurnRecord = {
      id: row.id,
      platform: row.platform,
      channelId: row.channel_id,
      inboundMessageId: row.inbound_message_id,
      platformUserId: data.platformUserId,
      status: row.status as FeedbackTurnStatus,
      createdAt: row.created_at,
      latencyMs: data.latencyMs,
      replyChars: data.replyChars,
      requestFingerprint: data.requestFingerprint,
      platformMessageIds,
    };
    if (row.session_id !== null) turn.sessionId = row.session_id;
    if (row.actor_id !== null) turn.actorId = row.actor_id;
    if (row.thread_id !== null) turn.threadId = row.thread_id;
    if (data.intentType !== undefined) turn.intentType = data.intentType;
    if (data.capability !== undefined) turn.capability = data.capability;
    if (data.taskId !== undefined) turn.taskId = data.taskId;
    if (data.runId !== undefined) turn.runId = data.runId;
    if (data.providerId !== undefined) turn.providerId = data.providerId;
    if (data.control !== undefined) turn.control = data.control;
    return turn;
  }
}
