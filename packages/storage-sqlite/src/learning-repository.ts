import Database from 'better-sqlite3';
import { LEARNING_EGRESS_LOCAL_ONLY, LEARNING_TEXT_MAX_CHARS, LearningItemKind } from '@quoky/core';
import type {
  Id, IntentType, IsoTimestamp, LearningEgress, LearningInsertResult, LearningItem, LearningItemData,
  LearningItemListQuery, LearningLanguage, LearningRepository, LearningSourceRating,
} from '@quoky/core';
import { LATEST_SCHEMA_VERSION } from './migrations';

type Db = Database.Database;

type LearningRow = {
  id: string; actor_id: string; kind: string; capability: string; language: string; source_turn_id: string | null;
  source_memory_id: string | null; egress: string; created_at: string; expires_at: string; data: string;
};

/** The schema version that introduced `learning_items` (ADR-0107 D2). */
export const LEARNING_SCHEMA_VERSION = 14;

const KINDS: readonly string[] = Object.values(LearningItemKind);

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && [...value].length <= LEARNING_TEXT_MAX_CHARS ? value : undefined;
}

/**
 * The JSON `data` column: an explicit whitelist so no other field can ever be persisted by spreading. A text field
 * over the ADR-0107 D2 bound is a programming error and is refused, never truncated.
 */
function learningData(data: LearningItemData): LearningItemData {
  const requestText = boundedText(data.requestText);
  if (requestText === undefined) throw new Error('LEARNING_TEXT_INVALID');
  const out: LearningItemData = { requestText, sourceRating: data.sourceRating };
  for (const key of ['idealAnswer', 'note', 'expectedBehavior'] as const) {
    if (data[key] === undefined) continue;
    const text = boundedText(data[key]);
    if (text === undefined) throw new Error('LEARNING_TEXT_INVALID');
    out[key] = text;
  }
  if (data.intentType !== undefined) out.intentType = data.intentType;
  return out;
}

function itemOf(row: LearningRow): LearningItem {
  const raw = JSON.parse(row.data) as Partial<LearningItemData> & Record<string, unknown>;
  const data: LearningItemData = {
    requestText: typeof raw.requestText === 'string' ? raw.requestText : '',
    sourceRating: raw.sourceRating as LearningSourceRating,
  };
  for (const key of ['idealAnswer', 'note', 'expectedBehavior'] as const) {
    if (typeof raw[key] === 'string') data[key] = raw[key] as string;
  }
  if (typeof raw.intentType === 'string') data.intentType = raw.intentType as IntentType;
  const item: LearningItem = {
    id: row.id,
    actorId: row.actor_id,
    kind: row.kind as LearningItemKind,
    capability: row.capability,
    language: row.language as LearningLanguage,
    egress: row.egress as LearningEgress,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    data,
  };
  if (row.source_turn_id !== null) item.sourceTurnId = row.source_turn_id;
  if (row.source_memory_id !== null) item.sourceMemoryId = row.source_memory_id;
  return item;
}

/**
 * SQLite learning store (ADR-0107 D2, migration v14). Not part of `StorageProvider`. Every read and delete is scoped
 * to one actor (except the expiry prune); reads never return an expired row; only `LOCAL_ONLY` rows are written.
 */
export class SqliteLearningRepository implements LearningRepository {
  constructor(private readonly db: Db) {}

  async insertWithinCap(item: LearningItem, maxPerActor: number, now: IsoTimestamp): Promise<LearningInsertResult> {
    if (item.egress !== LEARNING_EGRESS_LOCAL_ONLY) throw new Error('LEARNING_EGRESS_INVALID');
    if (!KINDS.includes(item.kind)) throw new Error('LEARNING_KIND_INVALID');
    const data = JSON.stringify(learningData(item.data));
    return this.db.transaction((): LearningInsertResult => {
      const { n } = this.db.prepare(
        'SELECT COUNT(*) AS n FROM learning_items WHERE actor_id = ? AND expires_at > ?',
      ).get(item.actorId, now) as { n: number };
      if (n >= maxPerActor) return 'CAP_REACHED';
      this.db.prepare(
        `INSERT INTO learning_items
           (id, actor_id, kind, capability, language, source_turn_id, source_memory_id, egress, created_at, expires_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.id, item.actorId, item.kind, item.capability, item.language, item.sourceTurnId ?? null,
        item.sourceMemoryId ?? null, item.egress, item.createdAt, item.expiresAt, data,
      );
      return 'INSERTED';
    })();
  }

  async findBySourceTurn(actorId: Id, kind: LearningItemKind, sourceTurnId: Id, now: IsoTimestamp): Promise<LearningItem | null> {
    const row = this.db.prepare(
      `SELECT * FROM learning_items
       WHERE actor_id = ? AND kind = ? AND source_turn_id = ? AND expires_at > ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(actorId, kind, sourceTurnId, now) as LearningRow | undefined;
    return row ? itemOf(row) : null;
  }

  async get(actorId: Id, id: Id, now: IsoTimestamp): Promise<LearningItem | null> {
    const row = this.db.prepare(
      'SELECT * FROM learning_items WHERE id = ? AND actor_id = ? AND expires_at > ?',
    ).get(id, actorId, now) as LearningRow | undefined;
    return row ? itemOf(row) : null;
  }

  async list(query: LearningItemListQuery): Promise<LearningItem[]> {
    const limit = Math.max(0, Math.trunc(query.limit));
    if (limit === 0) return [];
    return (this.db.prepare(
      `SELECT * FROM learning_items WHERE actor_id = ? AND kind = ? AND expires_at > ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(query.actorId, query.kind, query.now, limit) as LearningRow[]).map(itemOf);
  }

  async updateData(actorId: Id, id: Id, data: LearningItemData, now: IsoTimestamp): Promise<boolean> {
    const result = this.db.prepare(
      'UPDATE learning_items SET data = ? WHERE id = ? AND actor_id = ? AND expires_at > ?',
    ).run(JSON.stringify(learningData(data)), id, actorId, now);
    return result.changes > 0;
  }

  async delete(actorId: Id, id: Id): Promise<boolean> {
    return this.db.prepare('DELETE FROM learning_items WHERE id = ? AND actor_id = ?').run(id, actorId).changes > 0;
  }

  async deleteBySourceMemory(actorId: Id, memoryId: Id): Promise<number> {
    return this.db.prepare(
      'DELETE FROM learning_items WHERE actor_id = ? AND source_memory_id = ?',
    ).run(actorId, memoryId).changes;
  }

  async pruneExpired(now: IsoTimestamp, maxRows: number): Promise<number> {
    const limit = Math.max(0, Math.trunc(maxRows));
    if (limit === 0) return 0;
    return this.db.prepare(
      `DELETE FROM learning_items WHERE id IN (
         SELECT id FROM learning_items WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT ?)`,
    ).run(now, limit).changes;
  }
}

/** A read-only view of the learning store for the offline export tool (ADR-0107 D4). */
export interface LearningExportReader {
  /** Every actor's unexpired items of `kind`, oldest first (a stable export order). Nothing is deleted. */
  listForExport(kind: LearningItemKind, now: IsoTimestamp): LearningItem[];
  close(): void;
}

/**
 * Open `dbPath` READ-ONLY for the offline export (ADR-0107 D4). Never creates, migrates or prunes: a missing file,
 * a schema below v14 (`LEARNING_SCHEMA_MISSING`) or above this build (`SCHEMA_VERSION_AHEAD`) is refused, so the
 * tool never applies a migration to a database (Strict outside the delegated dev DB).
 */
export function openLearningExportReader(dbPath: string): LearningExportReader {
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
    listForExport(kind, now) {
      return (db.prepare(
        `SELECT * FROM learning_items WHERE kind = ? AND expires_at > ? ORDER BY created_at, rowid`,
      ).all(kind, now) as LearningRow[]).map(itemOf);
    },
    close() {
      db.close();
    },
  };
}
