import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogFields, Logger } from '@quoky/core';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from './migrations';
import type { AppliedMigration, Migration } from './migrations';
import { ACTIVE_SESSION_IN_THREAD_SQL, ACTIVE_SESSION_WITHOUT_THREAD_SQL, USAGE_FINISHED_BETWEEN_SQL } from './queries';
import { SqliteStorageProvider } from './index';

/**
 * ADR-0119 (STO-1): migration v16, verified on a copy of a realistic v15 fixture database, exactly as the Strict apply
 * runbook does it (a `VACUUM INTO` copy, migrated, compared with the untouched original).
 */

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-v16-'));
  dirs.push(dir);
  return dir;
}

const V15 = MIGRATIONS.slice(0, 15);
const V16 = MIGRATIONS[15] as Migration;

// Discord snowflakes (17-20 digits) and Telegram private-chat ids, as the live adapters record them.
const DISCORD_DM = '1290000000000000001';
const DISCORD_CHANNEL = '1290000000000000002';
const DISCORD_THREAD = '1290000000000000003';
const TELEGRAM_CHAT = '7012345678';
const SHARED_ID = '424242424242';

interface FixtureSession {
  readonly id: string;
  readonly platform?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly status: 'ACTIVE' | 'CLOSED';
  readonly lastActivityAt: string;
}

const SESSIONS: readonly FixtureSession[] = [
  { id: 'sess-discord-dm', platform: 'discord', channelId: DISCORD_DM, status: 'ACTIVE', lastActivityAt: '2026-10-12T09:00:00.000Z' },
  { id: 'sess-discord-dm-old', platform: 'discord', channelId: DISCORD_DM, status: 'CLOSED', lastActivityAt: '2026-10-01T09:00:00.000Z' },
  { id: 'sess-discord-channel', platform: 'discord', channelId: DISCORD_CHANNEL, status: 'ACTIVE', lastActivityAt: '2026-10-11T09:00:00.000Z' },
  { id: 'sess-discord-thread', platform: 'discord', channelId: DISCORD_CHANNEL, threadId: DISCORD_THREAD, status: 'ACTIVE', lastActivityAt: '2026-10-11T10:00:00.000Z' },
  { id: 'sess-telegram-dm', platform: 'telegram', channelId: TELEGRAM_CHAT, status: 'ACTIVE', lastActivityAt: '2026-10-12T08:00:00.000Z' },
  // The ADR-0114 TG-1 residual: equal channel ids on the two platforms (disjoint in practice, never enforced before v16).
  { id: 'sess-shared-discord', platform: 'discord', channelId: SHARED_ID, status: 'ACTIVE', lastActivityAt: '2026-10-10T09:00:00.000Z' },
  { id: 'sess-shared-telegram', platform: 'telegram', channelId: SHARED_ID, status: 'ACTIVE', lastActivityAt: '2026-10-10T10:00:00.000Z' },
  // A session recorded with no platform in its JSON: it keeps NULL and is never matched (nothing is guessed).
  { id: 'sess-no-platform', channelId: '1290000000000000009', status: 'ACTIVE', lastActivityAt: '2026-09-01T09:00:00.000Z' },
];

function sessionJson(s: FixtureSession): string {
  return JSON.stringify({
    id: s.id,
    actorId: 'actor-owner',
    context: {
      ...(s.platform !== undefined ? { platform: s.platform } : {}),
      channelId: s.channelId,
      ...(s.threadId !== undefined ? { threadId: s.threadId } : {}),
      userId: 'owner',
      direct: s.threadId === undefined,
    },
    status: s.status,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: s.lastActivityAt,
    ...(s.status === 'ACTIVE' ? { metadata: { 'quoky.lastListing': { kind: 'mail', ids: ['m-1', 'm-2'] } } } : {}),
  });
}

interface FixtureRun {
  readonly id: string;
  readonly finishedAt: string;
  readonly usage?: Record<string, unknown>;
}

// Runs across three months, with and without usage, plus a provider-owned `metadata.usage` that is not the usage record.
const RUNS: readonly FixtureRun[] = [
  { id: 'run-1', finishedAt: '2026-08-31T14:59:59.999Z', usage: { label: 'claude-cli', reported: false } },
  { id: 'run-2', finishedAt: '2026-08-31T15:00:00.000Z', usage: { label: 'openai:gpt-5', reported: true, inputTokens: 120, outputTokens: 40, totalTokens: 160 } },
  { id: 'run-3', finishedAt: '2026-09-15T03:00:00.000Z', usage: { label: 'openai:gpt-5', reported: true, inputTokens: 80, outputTokens: 20 } },
  { id: 'run-4', finishedAt: '2026-09-20T03:00:00.000Z' },
  { id: 'run-5', finishedAt: '2026-09-30T14:59:59.999Z', usage: { label: 'gemini:flash', reported: true, inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 } },
  { id: 'run-6', finishedAt: '2026-09-30T15:00:00.000Z', usage: { label: 'claude-cli', reported: false } },
  { id: 'run-7', finishedAt: '2026-10-05T00:00:00.000Z', usage: { label: 'openai:gpt-5', reported: true, totalTokens: 9 } },
];

function runJson(run: FixtureRun, index: number): string {
  return JSON.stringify({
    id: run.id,
    taskId: `task-${index + 1}`,
    attempt: 1,
    status: 'SUCCEEDED',
    capability: 'GENERAL_CHAT',
    artifactIds: [],
    startedAt: run.finishedAt,
    finishedAt: run.finishedAt,
    metadata: run.usage === undefined ? { model: 'm', usage: { totalTokens: 999 } } : { model: 'm' },
    ...(run.usage !== undefined ? { usage: run.usage } : {}),
  });
}

/** Writes a realistic schema-v15 database at `path` (journal mode DELETE, closed: a plain file, as a backup copy is). */
function writeV15Fixture(path: string): void {
  const db = new Database(path);
  try {
    expect(runMigrations(db, V15)).toMatchObject({ to: 15 });
    db.prepare(`INSERT INTO actors (id, data) VALUES (?, ?)`).run('actor-owner', JSON.stringify({ id: 'actor-owner', displayName: 'owner' }));
    db.prepare(`INSERT INTO actor_identities (platform, external_id, actor_id) VALUES (?, ?, ?)`).run('discord', '1290000000000000100', 'actor-owner');
    db.prepare(`INSERT INTO actor_identities (platform, external_id, actor_id) VALUES (?, ?, ?)`).run('telegram', '7012345678', 'actor-owner');
    const insertSession = db.prepare(`INSERT INTO sessions (id, channel_id, thread_id, status, data) VALUES (?, ?, ?, ?, ?)`);
    for (const s of SESSIONS) insertSession.run(s.id, s.channelId, s.threadId ?? null, s.status, sessionJson(s));
    const insertTask = db.prepare(`INSERT INTO tasks (id, channel_id, thread_id, data) VALUES (?, ?, ?, ?)`);
    const insertRun = db.prepare(`INSERT INTO task_runs (id, task_id, data) VALUES (?, ?, ?)`);
    RUNS.forEach((run, index) => {
      insertTask.run(`task-${index + 1}`, DISCORD_DM, null, JSON.stringify({ id: `task-${index + 1}`, status: 'COMPLETED' }));
      insertRun.run(run.id, `task-${index + 1}`, runJson(run, index));
    });
    db.prepare(`INSERT INTO memories (id, session_id, channel_id, type, data) VALUES (?, ?, ?, ?, ?)`)
      .run('mem-1', 'sess-discord-dm', DISCORD_DM, 'LONG_TERM', JSON.stringify({ id: 'mem-1', content: '라떼를 좋아함' }));
    db.prepare(`INSERT INTO conversation_turns (id, session_id, actor_id, platform, channel_id, inbound_message_id, status, created_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('turn-1', 'sess-telegram-dm', 'actor-owner', 'telegram', TELEGRAM_CHAT, '501', 'RESPONDED', '2026-10-12T08:00:00.000Z', '{}');
    db.prepare(`INSERT INTO reminders (id, actor_id, display_no, status, next_fire_at, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('rem-1', 'actor-owner', 1, 'SCHEDULED', '2026-10-14T00:00:00.000Z', '{}');
    db.prepare(`INSERT INTO learning_items (id, actor_id, kind, capability, language, egress, created_at, expires_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('learn-1', 'actor-owner', 'NOTE', 'GENERAL_CHAT', 'ko', 'LOCAL_ONLY', '2026-10-03T00:00:00.000Z', '2027-10-03T00:00:00.000Z', '{}');
    db.prepare(`INSERT INTO connector_write_receipts
      (id, actor_id, idempotency_key, connector, operation, target, payload_sha256, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('cwr-1', 'actor-owner', 'idem-1', 'calendar', 'create', 'primary', 'f'.repeat(64), 'SENT', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:01.000Z', '{}');
  } finally {
    db.close();
  }
}

/** The scratch copy of the runbook: `VACUUM INTO`, as the backup tool takes it. */
function copyOf(source: string, target: string): void {
  const db = new Database(source, { readonly: true });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
}

function userVersion(db: Database.Database): number {
  return Number(db.pragma('user_version', { simple: true }));
}

/** Every row of every table except `sessions`, ordered, as one comparable value. */
function dumpExceptSessions(db: Database.Database): Record<string, unknown[]> {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((name) => name !== 'sessions');
  return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}

function sessionRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM sessions ORDER BY rowid`).all() as Array<Record<string, unknown>>;
}

function schema(db: Database.Database): unknown[] {
  return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all();
}

/** The pre-v16 lookup (no platform), to show which session the old code found. */
function legacyActive(db: Database.Database, channelId: string, threadId?: string): string | undefined {
  const row = (threadId === undefined
    ? db.prepare(`SELECT id FROM sessions WHERE channel_id = ? AND thread_id IS NULL AND status = 'ACTIVE'
        ORDER BY json_extract(data, '$.lastActivityAt') DESC LIMIT 1`).get(channelId)
    : db.prepare(`SELECT id FROM sessions WHERE channel_id = ? AND thread_id = ? AND status = 'ACTIVE'
        ORDER BY json_extract(data, '$.lastActivityAt') DESC LIMIT 1`).get(channelId, threadId)) as { id: string } | undefined;
  return row?.id;
}

function usageVisits(db: Database.Database, from: string, to: string): Array<[string, string]> {
  return (db.prepare(USAGE_FINISHED_BETWEEN_SQL).all(from, to) as Array<{ usage: string; finishedAt: string }>)
    .map((r): [string, string] => [r.finishedAt, r.usage])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

class RecordingLogger implements Logger {
  readonly lines: Array<{ message: string; fields?: LogFields }> = [];
  info(message: string, fields?: LogFields): void { this.lines.push({ message, fields }); }
  warn(message: string, fields?: LogFields): void { this.lines.push({ message, fields }); }
  error(message: string, fields?: LogFields): void { this.lines.push({ message, fields }); }
}

function fixturePair(): { original: string; copy: string; dir: string } {
  const dir = scratchDir();
  const original = join(dir, 'v15-original.db');
  const copy = join(dir, 'v15-copy.db');
  writeV15Fixture(original);
  copyOf(original, copy);
  return { original, copy, dir };
}

describe('migration v16 — session platform key and usage ledger index (ADR-0119)', () => {
  it('is the fixed version 16 appended after v15, and the latest version', () => {
    expect(MIGRATIONS[14]).toMatchObject({ version: 15 });
    expect(V16).toMatchObject({ version: 16 });
    expect(MIGRATIONS).toHaveLength(16);
    expect(LATEST_SCHEMA_VERSION).toBe(16);
  });

  it('migrates a copy of a realistic v15 database to 16: only sessions gain the backfilled column, every other row is unchanged', () => {
    const { original, copy } = fixturePair();
    const db = new Database(copy);
    const applied: AppliedMigration[] = [];
    expect(userVersion(db)).toBe(15);
    expect(runMigrations(db, MIGRATIONS, (m) => applied.push(m))).toEqual({ from: 15, to: 16, applied: [16] });
    expect(applied).toEqual([{ version: 16, name: V16.name, facts: { sessionsWithoutPlatform: 1 } }]);

    const before = new Database(original, { readonly: true });
    try {
      expect(userVersion(before)).toBe(15);
      // No data loss: every non-session table is row-for-row identical to the untouched original.
      expect(dumpExceptSessions(db)).toEqual(dumpExceptSessions(before));
      // Sessions: the same rows, byte-identical columns, plus the platform read from each row's own JSON.
      const old = sessionRows(before);
      const migrated = sessionRows(db);
      expect(migrated).toHaveLength(SESSIONS.length);
      expect(migrated).toEqual(old.map((row) => {
        const platform = (JSON.parse(row.data as string) as { context: { platform?: string } }).context.platform;
        return { ...row, platform: platform ?? null };
      }));
      expect(Object.fromEntries(migrated.map((r) => [r.id, r.platform]))).toEqual(
        Object.fromEntries(SESSIONS.map((s) => [s.id, s.platform ?? null])),
      );
    } finally {
      before.close();
      db.close();
    }
  });

  it('every active session is found again after the migration, and equal channel ids on two platforms are two sessions', async () => {
    const { original, copy } = fixturePair();
    const before = new Database(original, { readonly: true });
    const logger = new RecordingLogger();
    // The service path: the storage adapter migrates at startup.
    const store = new SqliteStorageProvider({ dbPath: copy, logger });
    await store.init();
    try {
      expect(logger.lines).toEqual([
        { message: 'storage.migration.applied', fields: { version: 16, name: V16.name, sessionsWithoutPlatform: 1 } },
      ]);
      for (const s of SESSIONS.filter((x) => x.status === 'ACTIVE' && x.platform !== undefined && x.channelId !== SHARED_ID)) {
        const found = await store.sessions.findActiveByContext(s.platform as string, s.channelId, s.threadId);
        expect(found?.id, s.id).toBe(s.id);
        // The same session the pre-v16 lookup found.
        expect(legacyActive(before, s.channelId, s.threadId), s.id).toBe(s.id);
      }
      // Before v16 the shared id resolved to whichever was more recent; now each platform keeps its own.
      expect(legacyActive(before, SHARED_ID)).toBe('sess-shared-telegram');
      expect((await store.sessions.findActiveByContext('discord', SHARED_ID))?.id).toBe('sess-shared-discord');
      expect((await store.sessions.findActiveByContext('telegram', SHARED_ID))?.id).toBe('sess-shared-telegram');
      // The CLOSED session stays closed; the platform-less session is never matched.
      expect((await store.sessions.findActiveByContext('discord', DISCORD_DM))?.id).toBe('sess-discord-dm');
      expect(await store.sessions.findActiveByContext('discord', '1290000000000000009')).toBeNull();
      expect(await store.sessions.findActiveByContext('telegram', '1290000000000000009')).toBeNull();
      // The full session JSON (metadata included) is what it was.
      expect(await store.sessions.get('sess-telegram-dm')).toEqual(JSON.parse(sessionJson(SESSIONS[4] as FixtureSession)));
    } finally {
      await store.close();
      before.close();
    }
  });

  it('usage ledger reads are identical before and after the migration', async () => {
    const { original, copy } = fixturePair();
    const before = new Database(original, { readonly: true });
    const store = new SqliteStorageProvider({ dbPath: copy });
    await store.init();
    try {
      for (const [from, to] of [
        ['2026-08-31T15:00:00.000Z', '2026-09-30T15:00:00.000Z'],
        ['2026-09-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z'],
        ['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
      ] as const) {
        const after: Array<[string, string]> = [];
        await store.taskRuns.forEachUsageFinishedBetween(from, to, (usage, finishedAt) => after.push([finishedAt, JSON.stringify(usage)]));
        after.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        const legacy = usageVisits(before, from, to).map(([at, usage]): [string, string] => [at, JSON.stringify(JSON.parse(usage))]);
        expect(after).toEqual(legacy);
      }
    } finally {
      await store.close();
      before.close();
    }
  });

  it('is idempotent: a second run applies nothing, and re-running the v16 step itself changes nothing', () => {
    const { copy } = fixturePair();
    const db = new Database(copy);
    try {
      runMigrations(db);
      const snapshot = { schema: schema(db), sessions: sessionRows(db), rest: dumpExceptSessions(db) };
      expect(runMigrations(db)).toEqual({ from: 16, to: 16, applied: [] });
      expect(V16.up(db)).toEqual({ sessionsWithoutPlatform: 1 });
      expect(V16.up(db)).toEqual({ sessionsWithoutPlatform: 1 });
      expect({ schema: schema(db), sessions: sessionRows(db), rest: dumpExceptSessions(db) }).toEqual(snapshot);
      expect(userVersion(db)).toBe(16);
    } finally {
      db.close();
    }
  });

  it('a v15 database whose platform column already exists (a partial manual step) still migrates cleanly', () => {
    const db = new Database(':memory:');
    runMigrations(db, V15);
    db.exec(`ALTER TABLE sessions ADD COLUMN platform TEXT;`);
    db.prepare(`INSERT INTO sessions (id, channel_id, status, data) VALUES (?, ?, ?, ?)`)
      .run('s1', 'c1', 'ACTIVE', JSON.stringify({ context: { platform: 'discord', channelId: 'c1' } }));
    expect(runMigrations(db)).toEqual({ from: 15, to: 16, applied: [16] });
    expect(db.prepare(`SELECT platform FROM sessions`).all()).toEqual([{ platform: 'discord' }]);
    db.close();
  });

  it('nothing is guessed: unreadable or non-text platforms stay NULL and never abort the migration', () => {
    const db = new Database(':memory:');
    runMigrations(db, V15);
    const insert = db.prepare(`INSERT INTO sessions (id, channel_id, status, data) VALUES (?, ?, ?, ?)`);
    insert.run('broken-json', 'c1', 'ACTIVE', 'not json');
    insert.run('numeric', 'c2', 'ACTIVE', JSON.stringify({ context: { platform: 7, channelId: 'c2' } }));
    insert.run('no-context', 'c3', 'ACTIVE', JSON.stringify({ id: 'no-context' }));
    insert.run('ok', 'c4', 'ACTIVE', JSON.stringify({ context: { platform: 'telegram', channelId: 'c4' } }));
    const applied: AppliedMigration[] = [];
    expect(runMigrations(db, MIGRATIONS, (m) => applied.push(m))).toMatchObject({ to: 16 });
    expect(applied[0]?.facts).toEqual({ sessionsWithoutPlatform: 3 });
    expect(db.prepare(`SELECT id, platform, data FROM sessions ORDER BY rowid`).all()).toEqual([
      { id: 'broken-json', platform: null, data: 'not json' },
      { id: 'numeric', platform: null, data: JSON.stringify({ context: { platform: 7, channelId: 'c2' } }) },
      { id: 'no-context', platform: null, data: JSON.stringify({ id: 'no-context' }) },
      { id: 'ok', platform: 'telegram', data: JSON.stringify({ context: { platform: 'telegram', channelId: 'c4' } }) },
    ]);
    db.close();
  });

  it('is transactional: a failure inside v16 rolls back the column, the backfill and the indexes, and leaves user_version at 15', () => {
    const { original, copy } = fixturePair();
    const db = new Database(copy);
    const failing: Migration[] = [...V15, { ...V16, up(d) { V16.up(d); throw new Error('injected v16 failure'); } }];
    try {
      expect(() => runMigrations(db, failing)).toThrow('injected v16 failure');
      expect(userVersion(db)).toBe(15);
      const before = new Database(original, { readonly: true });
      try {
        expect(schema(db)).toEqual(schema(before));
        expect(sessionRows(db)).toEqual(sessionRows(before));
        expect(dumpExceptSessions(db)).toEqual(dumpExceptSessions(before));
      } finally {
        before.close();
      }
      // And the real migration still applies afterwards.
      expect(runMigrations(db)).toEqual({ from: 15, to: 16, applied: [16] });
    } finally {
      db.close();
    }
  });

  it('a v15 build refuses the v16 database with SCHEMA_VERSION_AHEAD and touches nothing', () => {
    const { copy } = fixturePair();
    const db = new Database(copy);
    try {
      runMigrations(db);
      const snapshot = { schema: schema(db), sessions: sessionRows(db), rest: dumpExceptSessions(db) };
      expect(() => runMigrations(db, V15)).toThrow('SCHEMA_VERSION_AHEAD');
      expect(userVersion(db)).toBe(16);
      expect({ schema: schema(db), sessions: sessionRows(db), rest: dumpExceptSessions(db) }).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it('creates the designed column and both indexes', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const info = db.pragma('table_info(sessions)') as Array<{ name: string; type: string; notnull: number }>;
    expect(info.map((c) => c.name)).toEqual(['id', 'channel_id', 'thread_id', 'status', 'data', 'platform']);
    expect(info.find((c) => c.name === 'platform')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect((db.pragma('index_info(idx_sessions_platform_context)') as Array<{ name: string }>).map((c) => c.name))
      .toEqual(['platform', 'channel_id', 'thread_id', 'status']);
    const usageIndex = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_runs_usage_finished'`)
      .get() as { sql: string };
    expect(usageIndex.sql.replace(/\s+/g, ' ')).toContain(
      `ON task_runs(json_extract(data, '$.finishedAt')) WHERE json_extract(data, '$.usage') IS NOT NULL`,
    );
    db.close();
  });

  it('EXPLAIN QUERY PLAN: the session lookup and the usage query are served by their v16 indexes', () => {
    const { copy } = fixturePair();
    const db = new Database(copy);
    try {
      runMigrations(db);
      const plan = (sql: string, ...params: unknown[]): string =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
      expect(plan(ACTIVE_SESSION_WITHOUT_THREAD_SQL, 'discord', DISCORD_DM)).toContain('USING INDEX idx_sessions_platform_context');
      expect(plan(ACTIVE_SESSION_IN_THREAD_SQL, 'discord', DISCORD_CHANNEL, DISCORD_THREAD))
        .toContain('USING INDEX idx_sessions_platform_context');
      const usagePlan = plan(USAGE_FINISHED_BETWEEN_SQL, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      expect(usagePlan).toContain('USING INDEX idx_task_runs_usage_finished');
      expect(usagePlan).not.toMatch(/SCAN task_runs(?! USING)/);
    } finally {
      db.close();
    }
  });
});
