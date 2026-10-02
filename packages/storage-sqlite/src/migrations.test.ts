import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, assertContiguousMigrations, runMigrations } from './migrations';
import type { Migration } from './migrations';
import { SqliteStorageProvider } from './index';

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}
function userVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

describe('runMigrations (ADR-0020 — versioned schema)', () => {
  it('migrates a fresh database to the latest version and creates all tables', () => {
    const db = new Database(':memory:');
    const res = runMigrations(db);
    expect(res.from).toBe(0);
    expect(res.to).toBe(LATEST_SCHEMA_VERSION);
    expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    for (const t of ['actors', 'actor_identities', 'sessions', 'tasks', 'task_runs', 'artifacts', 'projects', 'memories', 'approvals', 'patches', 'workspace_changes', 'command_executions', 'code_generations', 'code_proposals', 'work_items', 'execution_receipts', 'work_handoffs', 'conversation_turns', 'turn_platform_messages', 'feedback_signals']) {
      expect(tableNames(db)).toContain(t);
    }
    db.close();
  });

  it('migration v7 preserves the CAP-011 work_items schema', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(12);
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.pragma('table_info(work_items)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'actor_id', 'project_id', 'status', 'origin', 'data']);
    db.close();
  });

  it('migration v9 adds only the bounded CAP-014 handoff columns and indexes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const columns = (db.pragma('table_info(work_handoffs)') as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'work_item_id',
      'from_agent_profile_id',
      'to_agent_profile_id',
      'created_at',
      'data',
    ]);
    const indexes = (db.pragma('index_list(work_handoffs)') as Array<{ name: string }>)
      .map((index) => index.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'work_handoffs_work_item_id',
      'work_handoffs_from_agent_profile_id',
      'work_handoffs_to_agent_profile_id',
    ]));
    db.close();
  });

  it('migrations v2-v6 add approvals, patches, workspace_changes, command_executions, code_generations/proposals (CAP-004…008)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    for (const t of ['approvals', 'patches']) {
      expect(tableNames(db)).toContain(t);
      const cols = (db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['id', 'execution_plan_id', 'status', 'data']));
    }
    expect(tableNames(db)).toContain('workspace_changes');
    const wcCols = (db.pragma('table_info(workspace_changes)') as Array<{ name: string }>).map((c) => c.name);
    expect(wcCols).toEqual(expect.arrayContaining(['id', 'patch_id', 'status', 'data']));

    expect(tableNames(db)).toContain('command_executions');
    const ceCols = (db.pragma('table_info(command_executions)') as Array<{ name: string }>).map((c) => c.name);
    expect(ceCols).toEqual(
      expect.arrayContaining(['id', 'execution_plan_id', 'workspace_change_id', 'status', 'data']),
    );

    expect(tableNames(db)).toContain('code_generations');
    const cgCols = (db.pragma('table_info(code_generations)') as Array<{ name: string }>).map((c) => c.name);
    expect(cgCols).toEqual(expect.arrayContaining(['id', 'execution_plan_id', 'status', 'data']));
    expect(tableNames(db)).toContain('code_proposals');
    const cpCols = (db.pragma('table_info(code_proposals)') as Array<{ name: string }>).map((c) => c.name);
    expect(cpCols).toEqual(expect.arrayContaining(['id', 'code_generation_id', 'data']));
    db.close();
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.from).toBe(LATEST_SCHEMA_VERSION);
    expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('upgrades a legacy DB (no version, old memories schema) without data loss', () => {
    const db = new Database(':memory:');
    // Simulate a pre-versioning DB: memories created BEFORE session_id/project_id.
    db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, channel_id TEXT, thread_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL);`);
    db.prepare(`INSERT INTO memories (id, type, data) VALUES (?, ?, ?)`).run('m1', 'SHORT_TERM', '{"x":1}');
    expect(userVersion(db)).toBe(0);

    const res = runMigrations(db);
    expect(res.from).toBe(0);
    expect(res.to).toBe(LATEST_SCHEMA_VERSION);
    // New columns added, existing row preserved.
    const cols = (db.pragma('table_info(memories)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('session_id');
    expect(cols).toContain('project_id');
    const row = db.prepare(`SELECT data FROM memories WHERE id = ?`).get('m1') as { data: string };
    expect(row.data).toBe('{"x":1}');
    db.close();
  });

  it('migration versions are contiguous starting at 1', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
    expect(() => assertContiguousMigrations(MIGRATIONS)).not.toThrow();
  });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}
function indexes(db: Database.Database, table: string): Array<{ name: string; unique: number }> {
  return db.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>;
}
function indexColumns(db: Database.Database, index: string): string[] {
  return (db.pragma(`index_info(${index})`) as Array<{ name: string }>).map((c) => c.name);
}

describe('migration v12 — feedback capture tables (ADR-0098 D4, ADR-0096 D10)', () => {
  it('upgrades a v11 database to 12 additively, and a second run is a no-op', () => {
    const db = new Database(':memory:');
    expect(runMigrations(db, MIGRATIONS.slice(0, 11))).toMatchObject({ from: 0, to: 11 });
    db.prepare(`INSERT INTO sessions (id, channel_id, status, data) VALUES ('s1', 'c1', 'ACTIVE', '{}')`).run();
    const before = tableNames(db);
    expect(before).not.toContain('conversation_turns');

    expect(runMigrations(db)).toEqual({ from: 11, to: 12, applied: [12] });
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      ...before, 'conversation_turns', 'turn_platform_messages', 'feedback_signals',
    ]));
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 's1' }]);
    expect(runMigrations(db)).toEqual({ from: 12, to: 12, applied: [] });
    // Re-running the v12 DDL itself is idempotent (IF NOT EXISTS throughout).
    expect(() => MIGRATIONS[11]!.up(db)).not.toThrow();
    db.close();
  });

  it('creates the designed columns, with no message or reply text column', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(columns(db, 'conversation_turns')).toEqual([
      'id', 'session_id', 'actor_id', 'platform', 'channel_id', 'thread_id', 'inbound_message_id', 'status',
      'created_at', 'data',
    ]);
    expect(columns(db, 'turn_platform_messages')).toEqual(['platform', 'platform_message_id', 'turn_id']);
    expect(columns(db, 'feedback_signals')).toEqual([
      'id', 'turn_id', 'kind', 'source', 'source_key', 'value', 'created_at', 'updated_at',
    ]);
    for (const table of ['conversation_turns', 'turn_platform_messages', 'feedback_signals']) {
      expect(columns(db, table).filter((c) => /text|content|body|reply|message$/i.test(c))).toEqual([]);
    }
    db.close();
  });

  it('creates the unique and lookup indexes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const turnIndexes = indexes(db, 'conversation_turns');
    expect(turnIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'conversation_turns_inbound', unique: 1 }),
      expect.objectContaining({ name: 'conversation_turns_location', unique: 0 }),
      expect.objectContaining({ name: 'conversation_turns_actor', unique: 0 }),
    ]));
    expect(indexColumns(db, 'conversation_turns_inbound')).toEqual(['platform', 'inbound_message_id']);
    expect(indexColumns(db, 'conversation_turns_location')).toEqual(['platform', 'channel_id', 'thread_id', 'created_at']);
    expect(indexColumns(db, 'conversation_turns_actor')).toEqual(['actor_id', 'created_at']);
    const pk = (db.pragma('table_info(turn_platform_messages)') as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(['platform', 'platform_message_id']);
    expect(indexes(db, 'feedback_signals')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'feedback_signals_turn_source', unique: 1 }),
    ]));
    expect(indexColumns(db, 'feedback_signals_turn_source')).toEqual(['turn_id', 'source', 'source_key']);
    db.close();
  });
});

describe('migration runner startup checks (ADR-0096 D10)', () => {
  const noop = (version: number): Migration => ({ version, name: `v${version}`, up() {} });

  it('rejects a non-contiguous migration list with SCHEMA_MIGRATION_SEQUENCE_INVALID before touching the DB', () => {
    for (const versions of [[1, 2, 4], [2, 3], [1, 1, 2], [2, 1], [0, 1], [1, 1.5]]) {
      const list = versions.map(noop);
      expect(() => assertContiguousMigrations(list), versions.join(',')).toThrow('SCHEMA_MIGRATION_SEQUENCE_INVALID');
      const db = new Database(':memory:');
      expect(() => runMigrations(db, list)).toThrow('SCHEMA_MIGRATION_SEQUENCE_INVALID');
      expect(userVersion(db)).toBe(0);
      db.close();
    }
    expect(() => assertContiguousMigrations([1, 2, 3].map(noop))).not.toThrow();
  });

  it('rejects a database ahead of this build with SCHEMA_VERSION_AHEAD and applies nothing', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    expect(() => runMigrations(db)).toThrow('SCHEMA_VERSION_AHEAD');
    expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION + 1);
    expect(tableNames(db)).toEqual([]);
    db.close();
  });

  it('fails SqliteStorageProvider startup on a disposable DB ahead of this build, leaving its version and schema unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoky-schema-ahead-'));
    try {
      const dbPath = join(dir, 'chunsik.db');
      const seed = new Database(dbPath);
      seed.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
      seed.close();
      const store = new SqliteStorageProvider({ dbPath });
      await expect(store.init()).rejects.toThrow('SCHEMA_VERSION_AHEAD');
      const check = new Database(dbPath, { readonly: true });
      expect(userVersion(check)).toBe(LATEST_SCHEMA_VERSION + 1);
      expect(tableNames(check)).toEqual([]);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
