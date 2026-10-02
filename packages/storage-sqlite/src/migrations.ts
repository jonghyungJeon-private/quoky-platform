import type Database from 'better-sqlite3';

type Db = Database.Database;

/**
 * A single forward-only schema migration (ADR-0020). Each `up` MUST be
 * idempotent so a legacy database created before version tracking existed
 * (`user_version = 0`) upgrades cleanly: the baseline is expressed with
 * `IF NOT EXISTS` + guarded `ADD COLUMN`, making it a no-op on a populated DB.
 */
export interface Migration {
  /** Sequential version this migration brings the schema TO (1-based, contiguous). */
  readonly version: number;
  /** Short description for audit/logging. */
  readonly name: string;
  /** Idempotent DDL that upgrades the schema to `version`. */
  up(db: Db): void;
}

/** True if `table` already has a column named `column`. */
function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Ordered, forward-only migrations. Version 1 is the current baseline schema —
 * identical DDL to the pre-RC inline `init()`, so existing databases are
 * unaffected (backward compatible). New schema changes append a new entry.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline schema',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS actor_identities (
           platform TEXT NOT NULL, external_id TEXT NOT NULL, actor_id TEXT NOT NULL,
           PRIMARY KEY (platform, external_id));`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_id TEXT,
           status TEXT NOT NULL, data TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS tasks (
           id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_id TEXT, data TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS task_runs (
           id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS artifacts (
           id TEXT PRIMARY KEY, task_id TEXT, data TEXT NOT NULL);`,
      );
      db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS memories (
           id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, channel_id TEXT, thread_id TEXT,
           type TEXT NOT NULL, data TEXT NOT NULL);`,
      );
      // Columns added after the original release (ADR-0017/0018). Guarded so a
      // legacy `memories` table (created before these columns) is upgraded, and a
      // current table is left untouched.
      for (const col of ['session_id', 'project_id']) {
        if (!hasColumn(db, 'memories', col)) {
          db.exec(`ALTER TABLE memories ADD COLUMN ${col} TEXT;`);
        }
      }
    },
  },
  {
    version: 2,
    name: 'approvals table (CAP-004)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS approvals (
           id TEXT PRIMARY KEY, execution_plan_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);`,
      );
    },
  },
  {
    version: 3,
    name: 'patches table (CAP-005)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS patches (
           id TEXT PRIMARY KEY, execution_plan_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);`,
      );
    },
  },
  {
    version: 4,
    name: 'workspace_changes table (CAP-006)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS workspace_changes (
           id TEXT PRIMARY KEY, patch_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);`,
      );
    },
  },
  {
    version: 5,
    name: 'command_executions table (CAP-007)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS command_executions (
           id TEXT PRIMARY KEY, execution_plan_id TEXT, workspace_change_id TEXT,
           status TEXT NOT NULL, data TEXT NOT NULL);`,
      );
    },
  },
  {
    version: 6,
    name: 'code_generations + code_proposals tables (CAP-008)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS code_generations (
           id TEXT PRIMARY KEY, execution_plan_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS code_proposals (
           id TEXT PRIMARY KEY, code_generation_id TEXT, data TEXT NOT NULL);`,
      );
    },
  },
  {
    version: 7,
    name: 'work_items table (CAP-011)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS work_items (
           id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT,
           status TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL);`,
      );
      db.exec(`CREATE INDEX IF NOT EXISTS work_items_actor_id ON work_items (actor_id);`);
    },
  },
  {
    version: 8,
    name: 'execution receipts table (CAP-013)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS execution_receipts (
           id TEXT PRIMARY KEY,
           execution_kind TEXT NOT NULL,
           source_id TEXT NOT NULL,
           execution_plan_id TEXT NOT NULL,
           authorization_kind TEXT NOT NULL,
           approval_id TEXT NULL,
           outcome TEXT NOT NULL,
           failure_class TEXT NULL,
           recorded_at TEXT NOT NULL,
           UNIQUE(execution_kind, source_id));`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS execution_receipts_execution_plan_id
         ON execution_receipts(execution_plan_id);`,
      );
    },
  },
  {
    version: 9,
    name: 'work handoffs table (CAP-014)',
    up(db) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS work_handoffs (
           id TEXT PRIMARY KEY,
           work_item_id TEXT NOT NULL,
           from_agent_profile_id TEXT NOT NULL,
           to_agent_profile_id TEXT NOT NULL,
           created_at TEXT NOT NULL,
           data TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS work_handoffs_work_item_id
         ON work_handoffs(work_item_id);`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS work_handoffs_from_agent_profile_id
         ON work_handoffs(from_agent_profile_id);`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS work_handoffs_to_agent_profile_id
         ON work_handoffs(to_agent_profile_id);`,
      );
    },
  },
  {
    version: 10,
    name: 'immutable handoff continuation bindings (M3E-4)',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS continuation_bindings (
        handoff_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        recorded_at TEXT NOT NULL);`);
    },
  },
  {
    version: 11,
    name: 'TaskRun atomic attempt identity enforcement',
    up(db) {
      const rows = db.prepare('SELECT id, task_id, data FROM task_runs').all() as
        Array<{ id: string; task_id: string; data: string }>;
      for (const row of rows) {
        const run = JSON.parse(row.data) as { id?: unknown; taskId?: unknown; attempt?: unknown } | null;
        if (!run || !row.id || !row.task_id || run.id !== row.id || run.taskId !== row.task_id
          || !Number.isSafeInteger(run.attempt) || (run.attempt as number) < 1) {
          throw new Error('TASK_RUN_MIGRATION_INVALID_HISTORY');
        }
      }
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS task_runs_task_attempt
        ON task_runs(task_id, json_extract(data, '$.attempt'));`);
      for (const operation of ['INSERT', 'UPDATE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS task_runs_validate_${operation.toLowerCase()}
          BEFORE ${operation} ON task_runs BEGIN
          SELECT CASE WHEN json_valid(NEW.data) = 0 THEN RAISE(ABORT, 'INVALID_TASK_RUN_JSON') END;
          SELECT CASE WHEN NEW.id IS NULL OR NEW.id = '' OR NEW.task_id IS NULL OR NEW.task_id = ''
            OR json_extract(NEW.data, '$.id') IS NOT NEW.id
            OR json_extract(NEW.data, '$.taskId') IS NOT NEW.task_id
            OR json_type(NEW.data, '$.attempt') IS NOT 'integer'
            OR json_extract(NEW.data, '$.attempt') < 1
            OR json_extract(NEW.data, '$.attempt') > 9007199254740991
            THEN RAISE(ABORT, 'INVALID_TASK_RUN_IDENTITY') END;
          END;`);
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS task_runs_immutable_start
        BEFORE UPDATE ON task_runs BEGIN
        SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id
          OR json_extract(NEW.data, '$.attempt') IS NOT json_extract(OLD.data, '$.attempt')
          OR json_extract(NEW.data, '$.startedAt') IS NOT json_extract(OLD.data, '$.startedAt')
          OR json_extract(NEW.data, '$.capability') IS NOT json_extract(OLD.data, '$.capability')
          THEN RAISE(ABORT, 'TASK_RUN_START_IDENTITY_IMMUTABLE') END;
        END;`);
    },
  },
  {
    version: 12,
    name: 'feedback capture tables (ADR-0098)',
    up(db) {
      // Purely additive, no backfill. No message or reply text column (ADR-0098 D4): `data` holds only ids,
      // routing facts, sizes and a bounded keyword-hash fingerprint.
      db.exec(`CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        actor_id TEXT,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        inbound_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL);`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_inbound
        ON conversation_turns(platform, inbound_message_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS conversation_turns_location
        ON conversation_turns(platform, channel_id, thread_id, created_at);`);
      db.exec(`CREATE INDEX IF NOT EXISTS conversation_turns_actor
        ON conversation_turns(actor_id, created_at);`);
      db.exec(`CREATE TABLE IF NOT EXISTS turn_platform_messages (
        platform TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY (platform, platform_message_id));`);
      db.exec(`CREATE INDEX IF NOT EXISTS turn_platform_messages_turn_id
        ON turn_platform_messages(turn_id);`);
      db.exec(`CREATE TABLE IF NOT EXISTS feedback_signals (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        source_key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL);`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS feedback_signals_turn_source
        ON feedback_signals(turn_id, source, source_key);`);
    },
  },
];

/** The schema version this build targets (the highest migration version). */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * ADR-0096 D10: the migration list must be exactly the contiguous sequence 1..N, in order. A gap, duplicate,
 * reordering or non-integer version is a startup error, never silently skipped.
 */
export function assertContiguousMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) throw new Error('SCHEMA_MIGRATION_SEQUENCE_INVALID');
  });
}

/**
 * Apply every migration whose version exceeds the database's current
 * `user_version`, each inside its own transaction, advancing `user_version` as
 * it goes. Idempotent and backward compatible: an untracked legacy DB
 * (`user_version = 0`) re-runs the idempotent baseline and is stamped forward.
 *
 * Fails closed before touching the database (ADR-0096 D10): a non-contiguous
 * list is `SCHEMA_MIGRATION_SEQUENCE_INVALID`; a database whose `user_version`
 * is above the latest known version (written by a newer build) is
 * `SCHEMA_VERSION_AHEAD` — nothing is applied and nothing is downgraded.
 *
 * Returns the version transition for logging/auditing.
 */
export function runMigrations(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): { from: number; to: number; applied: number[] } {
  assertContiguousMigrations(migrations);
  const latest = migrations.length;
  const from = Number(db.pragma('user_version', { simple: true })) || 0;
  if (from > latest) throw new Error('SCHEMA_VERSION_AHEAD');
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= from) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
    applied.push(m.version);
  }
  const to = Number(db.pragma('user_version', { simple: true })) || 0;
  return { from, to, applied };
}
