import Database from 'better-sqlite3';
import { FeedbackSignalKind } from '@quoky/core';
import type { Id, IsoTimestamp, LearningItem } from '@quoky/core';
import { LEARNING_SCHEMA_VERSION } from './learning-repository';
import { LATEST_SCHEMA_VERSION } from './migrations';

/**
 * One handled turn for the offline learning report (ADR-0107 D8, LRN-3): ids, routing facts, signal counts and the
 * LRN-2 measurement count. No message or reply text exists in the schema these facts come from.
 */
export interface LearningReportTurn {
  readonly turnId: Id;
  readonly actorId: Id | null;
  readonly createdAt: IsoTimestamp;
  readonly capability: string | null;
  readonly intentType: string | null;
  /** The TaskRun id the turn executed (when it was a work turn). */
  readonly runId: string | null;
  /** First 8 hex of sha256 per request keyword (ADR-0098 D4); never a keyword. */
  readonly fingerprint: readonly string[];
  /** Current (non-retracted) 👍 / 👎 reactions. */
  readonly positive: number;
  readonly negative: number;
  /** Implicit signals: corrections and every implicit kind. */
  readonly implicitCorrection: number;
  readonly implicitOther: number;
  /** True when the turn's TaskRun row exists. */
  readonly runFound: boolean;
  /** `curatedExampleCount` from the run metadata (LRN-2); null when the run recorded none (flag off or no example). */
  readonly curatedExampleCount: number | null;
}

/** One `learning_items` row, expiry resolved against the report clock. `item.data` is owner-approved text. */
export interface LearningReportItem {
  readonly item: LearningItem;
  readonly expired: boolean;
}

export interface LearningReportTurnQuery {
  readonly since: IsoTimestamp;
  /** Exclusive upper bound. */
  readonly until: IsoTimestamp;
  readonly actorId?: Id;
  /** Hard cap on returned rows; `truncated` is set when more existed. */
  readonly limit: number;
}

/** A read-only view for the offline learning report. Nothing is created, migrated, pruned or deleted. */
export interface LearningReportReader {
  listTurns(query: LearningReportTurnQuery): { turns: LearningReportTurn[]; truncated: boolean };
  /** Every row (expired ones included, so the report can count them), oldest first. */
  listLearningItems(now: IsoTimestamp, actorId?: Id): LearningReportItem[];
  close(): void;
}

type TurnSqlRow = {
  turnId: string; actorId: string | null; createdAt: string; capability: string | null; intentType: string | null;
  runId: string | null; fingerprint: string | null; positive: number | null; negative: number | null;
  implicitCorrection: number | null; implicitOther: number | null; runFound: number; curated: number | string | null;
};
type ItemSqlRow = {
  id: string; actor_id: string; kind: string; capability: string; language: string; source_turn_id: string | null;
  source_memory_id: string | null; egress: string; created_at: string; expires_at: string; data: string;
};

const HASH8 = /^[0-9a-f]{8}$/;

function fingerprintOf(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && HASH8.test(v)) : [];
  } catch {
    return [];
  }
}

function curatedOf(value: number | string | null): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function itemOf(row: ItemSqlRow): LearningItem {
  const raw = JSON.parse(row.data) as Record<string, unknown>;
  const data: LearningItem['data'] = {
    requestText: typeof raw.requestText === 'string' ? raw.requestText : '',
    sourceRating: raw.sourceRating === 'POSITIVE' ? 'POSITIVE' : 'NEGATIVE',
  };
  for (const key of ['idealAnswer', 'note', 'expectedBehavior'] as const) {
    if (typeof raw[key] === 'string') data[key] = raw[key] as string;
  }
  if (typeof raw.intentType === 'string') data.intentType = raw.intentType as never;
  const item: LearningItem = {
    id: row.id,
    actorId: row.actor_id,
    kind: row.kind as LearningItem['kind'],
    capability: row.capability,
    language: row.language as LearningItem['language'],
    egress: row.egress as LearningItem['egress'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    data,
  };
  if (row.source_turn_id !== null) item.sourceTurnId = row.source_turn_id;
  if (row.source_memory_id !== null) item.sourceMemoryId = row.source_memory_id;
  return item;
}

const RATING = `s.kind = '${FeedbackSignalKind.EXPLICIT_RATING}' AND s.source = 'REACTION'`;

/**
 * Open `dbPath` READ-ONLY for the offline learning report (ADR-0107 D8). Never creates, migrates or prunes: a
 * missing file, a schema below v14 (`LEARNING_SCHEMA_MISSING`) or above this build (`SCHEMA_VERSION_AHEAD`) is refused.
 */
export function openLearningReportReader(dbPath: string): LearningReportReader {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = Number(db.pragma('user_version', { simple: true })) || 0;
    if (version > LATEST_SCHEMA_VERSION) throw new Error('SCHEMA_VERSION_AHEAD');
    if (version < LEARNING_SCHEMA_VERSION) throw new Error('LEARNING_SCHEMA_MISSING');
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    listTurns(query) {
      const limit = Math.max(0, Math.trunc(query.limit));
      const rows = db.prepare(
        `SELECT t.id AS turnId, t.actor_id AS actorId, t.created_at AS createdAt,
           json_extract(t.data, '$.capability') AS capability, json_extract(t.data, '$.intentType') AS intentType,
           json_extract(t.data, '$.runId') AS runId, json_extract(t.data, '$.requestFingerprint') AS fingerprint,
           SUM(CASE WHEN ${RATING} AND s.value = 'POSITIVE' THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN ${RATING} AND s.value = 'NEGATIVE' THEN 1 ELSE 0 END) AS negative,
           SUM(CASE WHEN s.source = 'IMPLICIT' AND s.kind = '${FeedbackSignalKind.IMPLICIT_CORRECTION}' THEN 1 ELSE 0 END)
             AS implicitCorrection,
           SUM(CASE WHEN s.source = 'IMPLICIT' AND s.kind != '${FeedbackSignalKind.IMPLICIT_CORRECTION}' THEN 1 ELSE 0 END)
             AS implicitOther,
           EXISTS (SELECT 1 FROM task_runs r WHERE r.id = json_extract(t.data, '$.runId')) AS runFound,
           (SELECT json_extract(r.data, '$.metadata.curatedExampleCount') FROM task_runs r
             WHERE r.id = json_extract(t.data, '$.runId')) AS curated
         FROM conversation_turns t LEFT JOIN feedback_signals s ON s.turn_id = t.id
         WHERE json_extract(t.data, '$.control') IS NULL AND t.created_at >= @since AND t.created_at < @until
           AND (@actorId IS NULL OR t.actor_id = @actorId)
         GROUP BY t.id ORDER BY t.created_at, t.rowid LIMIT @limit`,
      ).all({ since: query.since, until: query.until, actorId: query.actorId ?? null, limit: limit + 1 }) as TurnSqlRow[];
      const turns = rows.slice(0, limit).map((row): LearningReportTurn => ({
        turnId: row.turnId,
        actorId: row.actorId,
        createdAt: row.createdAt,
        capability: row.capability,
        intentType: row.intentType,
        runId: row.runId,
        fingerprint: fingerprintOf(row.fingerprint),
        positive: row.positive ?? 0,
        negative: row.negative ?? 0,
        implicitCorrection: row.implicitCorrection ?? 0,
        implicitOther: row.implicitOther ?? 0,
        runFound: row.runFound === 1,
        curatedExampleCount: curatedOf(row.curated),
      }));
      return { turns, truncated: rows.length > limit };
    },
    listLearningItems(now, actorId) {
      return (db.prepare(
        `SELECT * FROM learning_items WHERE (@actorId IS NULL OR actor_id = @actorId) ORDER BY created_at, rowid`,
      ).all({ actorId: actorId ?? null }) as ItemSqlRow[]).map((row) => ({
        item: itemOf(row),
        expired: row.expires_at <= now,
      }));
    },
    close() {
      db.close();
    },
  };
}
