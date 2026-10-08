import 'reflect-metadata';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  APPROVAL_REFERENCE_LINE_PREFIX,
  ApprovalStatus,
  CALENDAR_EVENT_WRITER,
  CALENDAR_READER,
  CHANNEL_MESSAGE_WRITER,
  CONVERSATION_TURN_HANDLERS,
  ConversationRuntime,
  ISSUE_COMMENT_WRITER,
  ISSUE_TRANSITION_WRITER,
  MAX_CONTRIBUTED_HELP_LINES,
  MAX_CONTRIBUTED_HELP_LINE_CHARS,
  IntentClassifier,
  STORAGE_PROVIDER,
  TURN_HANDLER_STAGES,
  VECTOR_PROVIDER,
  connectorWriteNotSent,
  connectorWriteSent,
  isArchivedMemory,
  renderConnectorWriteApprovedReminder,
  renderConnectorWriteOutcome,
  renderNoApprovedConnectorWrite,
  type AiProvider,
  type CalendarEvent,
  type CalendarEventCreateRequest,
  type CalendarEventDeleteRequest,
  type CalendarEventQuery,
  type CalendarEventUpdateRequest,
  type CalendarReader,
  type ChannelMessageRequest,
  type ConnectorWriteFlow,
  type ConnectorWriteOutcome,
  type ConversationContext,
  type ConversationRuntimeDeps,
  type ConversationTurnHandler,
  type InboundAttachment,
  type InboundMessage,
  type IssueCommentRequest,
  type IssueTransitionOption,
  type IssueTransitionRequest,
  type TurnHandlerStage,
  type VectorProvider,
} from '@quoky/core';
import type { SqliteStorageProvider } from '@quoky/storage-sqlite';
// Test-only, cross-package source imports (precedent: personal-v2-acceptance.test.ts). The execution allow-list and the
// migration list are not part of either package's public surface.
import {
  EXECUTION_PHRASES,
  documentedExecutionPhrase,
  isAcceptedExecutionPhrase,
  type ExecutionGate,
} from '../../../packages/core/src/application/execution-command-guard';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from '../../../packages/storage-sqlite/src/migrations';
import { ClaudeCliVisionProvider } from '@quoky/ai-cli';
import { renderAttachmentReplyWithheld } from '../../../packages/core/src/application/attachment-context';
import { renderImageUnderstandingUnavailable } from '../../../packages/core/src/application/image-understanding';
import { loadConfig } from './config';
import { CONNECTOR_WRITE_FLOW } from './features/connector-writes.providers';
import { OPS_UI_BIND_HOST } from './ops-ui/http/server';
import { OPS_UI_TOKEN_FILE_NAME } from './ops-ui/http/token-file';
import { startOpsUi, type OpsUiWiringInput } from './ops-ui/ops-ui-wiring';
import { stubProviderSelection } from './provider-selection/test-support';

/**
 * Personal v3 — integration acceptance (INT-2, plan wave 6; ADR-0102..ADR-0113). OFFLINE and in-process, modelled on
 * the v2 ratchet (`personal-v2-acceptance.test.ts`, which keeps scoring the golden routing corpora with every write
 * off): the REAL `AppModule` is booted through Nest over a REAL SQLite file migrated 0 → 13 → 14 → 15, here in the
 * v3 maximum configuration — reminders on, a calendar configured with calendar writes on, and Jira + Slack connector
 * writes on behind allowlists. Only the edges are replaced: no `.env.local`, every credential is a placeholder, the
 * Discord adapter is never started, every `AiProvider` instance has `isAvailable`/`execute` replaced by a counting stub,
 * the calendar readers and the four write adapters have only their I/O methods replaced by offline fakes (their
 * allowlist checks stay real), and the global `fetch` is a counting stub that refuses, so any network attempt is visible.
 *
 * It pins the v3 composition: the dispatch-boundary deps baseline (35) with the connector-write flow composed, the nine
 * handlers in their fixed stage/order, the help budget (ADR-0096 D6 as amended: 14 lines × 120 chars) with every write
 * line, zero provider calls on every deterministic v3 turn (memory archive, connector-write preview → approve →
 * execute gating, calendar read and write replies, OPS-UI-independent chat approvals) plus a fall-through positive
 * control, the migration lane through v15, the connector-write execution allow-list, and the operations UI default
 * (off) and its loopback bind. ADR-0111 amendment A1/A2 (2026-10-07): the maximum configuration also selects the Claude
 * image provider (`QUOKY_IMAGE_UNDERSTANDING_PROVIDER=claude`, the owner's setup), so an image turn is scored end to end
 * through the real composition against the stubbed Claude vision instance.
 */

const OWNER_ID = '111111111111111111';
const SEOUL = 'Asia/Seoul';
const STUB_REPLY = 'INT-2 stub provider reply';
/** Allowlisted write targets (placeholders; nothing is ever sent). */
const JIRA_PROJECT = 'PROJ';
const SLACK_CHANNEL_NAME = 'dev';
const SLACK_CHANNEL_ID = 'C0DEVCHAN1';
const COMMENT_URL = 'https://example.invalid/browse/PROJ-12?focusedCommentId=10001';
/** The offline calendar fixtures' event titles (they must never reach a provider or the conversation history). */
const READ_FIXTURE_TITLE = 'INT-2 calendar fixture standup';
const WRITE_FIXTURE_TITLE = '주간 회의';
const HOUR_MS = 60 * 60_000;

/** The fixed registry (ADR-0096 D2/D5 and its v3 amendments): `(id, stage, order)` in dispatch order. */
const EXPECTED_REGISTRY: ReadonlyArray<readonly [string, TurnHandlerStage, number]> = [
  ['feedback.summary', 'control', 100],
  ['git-branch', 'post-anchor', 100],
  ['memory-commands', 'pre-classify', 50], // ADR-0106 D2 (MEM-1)
  ['feedback.learning', 'pre-classify', 60], // ADR-0107 D3 (LRN-1)
  ['model-selection', 'pre-classify', 70], // ADR-0092 amendment (runtime model switch)
  ['work-chat.todo', 'pre-classify', 100],
  ['calendar', 'pre-classify', 150], // ADR-0110 D3 (CAL-2)
  ['reminders', 'pre-classify', 200],
  ['work-chat.lookup', 'pre-classify', 300],
  ['help-intent', 'pre-classify', 400], // ADR-0104 D4 (LLM-1, registered by DET-1)
];

/** ADR-0112 D5 / ADR-0110 amendment D4: the connector-write gates and their documented execution phrases. */
const CONNECTOR_WRITE_GATES: ReadonlyArray<readonly [ExecutionGate, string]> = [
  ['issueComment', '댓글 실행'],
  ['issueTransition', '상태 변경 실행'],
  ['channelPost', 'Slack 게시 실행'],
  ['calendarCreate', '일정 추가 실행'],
  ['calendarUpdate', '일정 변경 실행'],
  ['calendarDelete', '일정 삭제 실행'],
];

interface TurnObservation {
  /** The handler id that claimed the turn, `classifier` (fell through to classification) or `runtime`. */
  readonly route: string;
  readonly providerCalls: number;
  readonly availabilityProbes: number;
  readonly text: string;
}

interface WriteLog {
  readonly addComment: IssueCommentRequest[];
  readonly listTransitions: string[];
  readonly transition: IssueTransitionRequest[];
  readonly post: ChannelMessageRequest[];
  readonly createEvent: CalendarEventCreateRequest[];
  readonly updateEvent: CalendarEventUpdateRequest[];
  readonly deleteEvent: CalendarEventDeleteRequest[];
}

interface Harness {
  readonly app: { get<T = unknown>(token: unknown): T; close(): Promise<void> };
  readonly runtime: ConversationRuntime;
  readonly storage: SqliteStorageProvider;
  readonly handlers: readonly ConversationTurnHandler[];
  readonly flow: ConnectorWriteFlow | null;
  readonly writes: WriteLog;
  /** Windows the calendar handler read through `CALENDAR_READER`, and the write flow through its primary reader. */
  readonly calendarReads: CalendarEventQuery[];
  readonly primaryReads: CalendarEventQuery[];
  providerCalls(): number;
  availabilityProbes(): number;
  /** Every stubbed `execute`: which provider instance, for which capability, with how many images. */
  readonly executions: Array<{ readonly provider: AiProvider; readonly capability: string; readonly imageCount: number }>;
  turn(context: ConversationContext, text: string, attachments?: readonly InboundAttachment[]): Promise<TurnObservation>;
  /** A fresh context: its own channel (session) and its own user (actor), so receipts and memories never mix. */
  freshContext(userId?: string): ConversationContext;
}

const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
let savedEnv: NodeJS.ProcessEnv = {};
let tempDir = '';
let dbPath = '';
let harness: Harness;
const migrationSteps: Array<{ from: number; to: number; applied: number[] }> = [];
/** Every global `fetch` attempt (the stub refuses them all). */
let networkAttempts = 0;
const logLines: string[] = [];
let stubReply = STUB_REPLY;
/** The Slack fake's next outcome (W5-L03 particle check uses a NOT_SENT). */
let slackOutcome: () => ConnectorWriteOutcome = () => connectorWriteSent('1700000000.000100');

interface BetterSqliteDb {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
type BetterSqliteCtor = new (path: string) => BetterSqliteDb;

function openRawDb(path: string): BetterSqliteDb {
  const requireFromStorage = createRequire(new URL('../../../packages/storage-sqlite/package.json', import.meta.url));
  const Database = requireFromStorage('better-sqlite3') as BetterSqliteCtor;
  return new Database(path);
}

function tableNames(db: BetterSqliteDb): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name);
}

function columnNames(db: BetterSqliteDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

/** Build a v13 database (the v2 release schema), then step it to 14 and 15 with the production list (ADR-0096 D10). */
function prepareMigratedDatabase(path: string): void {
  const db = openRawDb(path);
  try {
    type Db = Parameters<typeof runMigrations>[0];
    const raw = db as unknown as Db;
    migrationSteps.push(runMigrations(raw, MIGRATIONS.slice(0, 13)));
    expect(tableNames(db)).not.toContain('learning_items');
    migrationSteps.push(runMigrations(raw, MIGRATIONS.slice(0, 14)));
    expect(tableNames(db)).toContain('learning_items');
    expect(tableNames(db)).not.toContain('connector_write_receipts');
    migrationSteps.push(runMigrations(raw, MIGRATIONS));
    expect(tableNames(db)).toContain('connector_write_receipts');
  } finally {
    db.close();
  }
}

/** One timed event an hour into whatever window is read (the read-only answer path). */
function readFixture(query: CalendarEventQuery): readonly CalendarEvent[] {
  const start = Date.parse(query.from) + HOUR_MS;
  return [
    {
      id: 'int2-read-1',
      title: READ_FIXTURE_TITLE,
      start: new Date(start).toISOString(),
      end: new Date(start + 30 * 60_000).toISOString(),
      allDay: false,
      status: 'confirmed',
      calendarName: 'primary',
    },
  ];
}

/** The primary calendar the write flow reads to bind an update/delete: "주간 회의" at 15:00 Seoul on the read day. */
function primaryFixture(query: CalendarEventQuery): readonly CalendarEvent[] {
  // Day windows start at a Seoul midnight; 15:00 Seoul is 15 hours later.
  const start = Date.parse(query.from) + 15 * HOUR_MS;
  return [
    {
      id: 'int2-weekly',
      title: WRITE_FIXTURE_TITLE,
      start: new Date(start).toISOString(),
      end: new Date(start + HOUR_MS).toISOString(),
      allDay: false,
      status: 'confirmed',
      calendarName: 'primary',
      version: '"int2-v1"',
    },
  ];
}

const TRANSITIONS: readonly IssueTransitionOption[] = [
  { id: '21', name: 'Start Progress', toStatus: '진행 중', toStatusId: '3' },
  { id: '31', name: 'Done', toStatus: '완료', toStatusId: '10002' },
];

let contextSeq = 0;

async function boot(): Promise<Harness> {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const storage = app.get<SqliteStorageProvider>(STORAGE_PROVIDER);
  await storage.init();
  await app.get<VectorProvider>(VECTOR_PROVIDER).init();

  let providerCalls = 0;
  let availabilityProbes = 0;
  const executions: Harness['executions'] = [];
  const stubProvider = (provider: AiProvider): void => {
    Object.assign(provider, {
      async isAvailable() {
        availabilityProbes += 1;
        return true;
      },
      async execute(request: { capability: string; images?: readonly unknown[] }) {
        providerCalls += 1;
        executions.push({ provider, capability: request.capability, imageCount: request.images?.length ?? 0 });
        return { text: stubReply, artifacts: [] };
      },
    });
  };
  for (const provider of app.get<AiProvider[]>(AI_PROVIDERS)) stubProvider(provider);
  // ADR-0092 amendment (runtime switching): on-demand model instances are stubbed as they are added, and the local
  // Ollama inventory answers from a fixture, so no model command can spawn a CLI.
  stubProviderSelection(app, stubProvider, { status: 'OK', models: [] });

  const calendarReads: CalendarEventQuery[] = [];
  Object.assign(app.get<CalendarReader>(CALENDAR_READER), {
    async listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]> {
      calendarReads.push(query);
      return readFixture(query);
    },
  });

  // The write adapters are the production instances the flow holds; only their I/O is replaced (allowlists stay real).
  const writes: WriteLog = {
    addComment: [], listTransitions: [], transition: [], post: [], createEvent: [], updateEvent: [], deleteEvent: [],
  };
  Object.assign(app.get(ISSUE_COMMENT_WRITER), {
    async addComment(request: IssueCommentRequest) {
      writes.addComment.push(request);
      return connectorWriteSent('10001', COMMENT_URL);
    },
  });
  Object.assign(app.get(ISSUE_TRANSITION_WRITER), {
    async listTransitions(key: string) {
      writes.listTransitions.push(key);
      return TRANSITIONS;
    },
    async transition(request: IssueTransitionRequest) {
      writes.transition.push(request);
      return connectorWriteSent(`${request.issueKey}:${request.transitionId}`);
    },
  });
  Object.assign(app.get(CHANNEL_MESSAGE_WRITER), {
    async post(request: ChannelMessageRequest) {
      writes.post.push(request);
      return slackOutcome();
    },
  });
  Object.assign(app.get(CALENDAR_EVENT_WRITER), {
    async createEvent(request: CalendarEventCreateRequest) {
      writes.createEvent.push(request);
      return connectorWriteSent('int2-new-event');
    },
    async updateEvent(request: CalendarEventUpdateRequest) {
      writes.updateEvent.push(request);
      return connectorWriteSent(request.eventId);
    },
    async deleteEvent(request: CalendarEventDeleteRequest) {
      writes.deleteEvent.push(request);
      return connectorWriteSent(request.eventId);
    },
  });
  // The flow's PRIMARY-only reader (ADR-0110 amendment D2) is its own instance; replace its read the same way.
  const flow = app.get<ConnectorWriteFlow | null>(CONNECTOR_WRITE_FLOW);
  const primaryReads: CalendarEventQuery[] = [];
  const primaryReader = (flow as unknown as { deps?: { calendarReader?: CalendarReader } } | null)?.deps?.calendarReader;
  if (primaryReader === undefined) throw new Error('the write flow has no primary calendar reader');
  Object.assign(primaryReader, {
    async listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]> {
      primaryReads.push(query);
      return primaryFixture(query);
    },
  });

  const handlers = app.get<readonly ConversationTurnHandler[]>(CONVERSATION_TURN_HANDLERS);
  const claims: string[] = [];
  for (const handler of handlers) {
    const original = handler.handle.bind(handler);
    vi.spyOn(handler, 'handle').mockImplementation(async (ctx) => {
      const outcome = await original(ctx);
      if (outcome !== null) claims.push(handler.id);
      return outcome;
    });
  }
  const classifier = app.get(IntentClassifier);
  let classifyCalls = 0;
  const classify = classifier.classify.bind(classifier);
  vi.spyOn(classifier, 'classify').mockImplementation(async (message, ctx) => {
    classifyCalls += 1;
    return classify(message, ctx);
  });

  const runtime = app.get(ConversationRuntime);
  let messageSeq = 0;
  return {
    app: app as unknown as Harness['app'],
    runtime,
    storage,
    handlers,
    flow,
    writes,
    calendarReads,
    primaryReads,
    providerCalls: () => providerCalls,
    availabilityProbes: () => availabilityProbes,
    executions,
    freshContext(userId?: string) {
      contextSeq += 1;
      const n = String(contextSeq).padStart(4, '0');
      return { platform: 'discord', channelId: `88888888888888${n}`, userId: userId ?? `22222222222222${n}` };
    },
    async turn(context, text, attachments) {
      const claimsBefore = claims.length;
      const classifyBefore = classifyCalls;
      const providerBefore = providerCalls;
      const probesBefore = availabilityProbes;
      messageSeq += 1;
      const message: InboundMessage = {
        id: `int2-message-${messageSeq}`,
        context,
        text,
        receivedAt: new Date().toISOString(),
        ...(attachments ? { attachments } : {}),
      };
      const result = await runtime.handle(message);
      const claimed = claims.slice(claimsBefore)[0];
      return {
        route: claimed ?? (classifyCalls > classifyBefore ? 'classifier' : 'runtime'),
        providerCalls: providerCalls - providerBefore,
        availabilityProbes: availabilityProbes - probesBefore,
        text: result.reply.text,
      };
    },
  };
}

/** Every deterministic v3 turn sent through `det` (asserted provider-free one by one, and listed for the final check). */
const deterministicTurns: Array<{ text: string; route: string }> = [];
async function det(context: ConversationContext, text: string): Promise<TurnObservation> {
  const seen = await harness.turn(context, text);
  deterministicTurns.push({ text, route: seen.route });
  expect(seen.providerCalls + seen.availabilityProbes, `provider touched by "${text}" (${seen.route})`).toBe(0);
  expect(seen.text, text).not.toBe(STUB_REPLY);
  return seen;
}

const totalWrites = () => Object.values(harness.writes).reduce((sum, list: unknown[]) => sum + list.length, 0);

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
  }
  vi.stubGlobal('fetch', async () => {
    networkAttempts += 1;
    throw new Error('INT-2: network is not available in this test');
  });
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'quoky-int2-'));
  dbPath = join(tempDir, 'quoky.db');
  prepareMigratedDatabase(dbPath);
  Object.assign(process.env, {
    QUOKY_DISCORD_OWNER_IDS: OWNER_ID,
    QUOKY_DB_PATH: dbPath,
    QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
    QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
    QUOKY_OLLAMA_ENABLED: 'false',
    // Host-independent registration: a Codex CLI installed on the test machine would otherwise register the Codex chat
    // and image options (ADR-0111 amendment of 2026-10-08) next to the configured ones.
    CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
    QUOKY_REMINDERS_ENABLED: 'true',
    QUOKY_TIMEZONE: SEOUL,
    // ADR-0110 + amendment: a configured calendar with writes on (placeholder client and inline refresh token; the
    // adapters' reads and writes are replaced right after boot and construction makes no network call).
    QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'int2-calendar-client',
    QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'int2-calendar-client-placeholder',
    QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'int2-calendar-refresh-placeholder',
    QUOKY_CALENDAR_WRITE_ENABLED: 'true',
    // ADR-0112 D4: Jira + Slack writes on, behind allowlists (placeholder credentials; the Slack write token is built by
    // concatenation so no token-shaped literal appears in the source).
    QUOKY_JIRA_BASE_URL: 'https://example.invalid',
    QUOKY_JIRA_EMAIL: 'int2@example.invalid',
    QUOKY_JIRA_TOKEN: 'int2-jira-placeholder',
    QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
    QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: JIRA_PROJECT,
    QUOKY_CONNECTOR_WRITE_SLACK_TOKEN: `${'xox'}${'b-'}int2-placeholder`,
    QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS: `${SLACK_CHANNEL_NAME}:${SLACK_CHANNEL_ID}`,
    // QUOKY_OPS_UI_ENABLED is deliberately unset: the operations UI default is off (ADR-0113 D1).
    // ADR-0111 amendment A1: the owner's image setup — Claude reads images (cloud, explicit opt-in).
    QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude',
  });
  harness = await boot();
}, 60_000);

afterAll(async () => {
  await harness?.storage.close().catch(() => undefined);
  await harness?.app.close();
  process.env = savedEnv;
  vi.unstubAllGlobals();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Personal v3 acceptance — migration lane through v15 (ADR-0096 D10, ADR-0107 D2, ADR-0112 D3)', () => {
  it('the migration list is exactly 1..15, contiguous, and LATEST_SCHEMA_VERSION is 15', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(15);
    expect(MIGRATIONS[13]?.name).toMatch(/learning items/);
    expect(MIGRATIONS[14]?.name).toMatch(/connector write receipts/);
  });

  it('a v13 (v2 release) DB stepped to 14 (learning_items) and 15 (connector_write_receipts), one version per step', () => {
    expect(migrationSteps).toEqual([
      { from: 0, to: 13, applied: Array.from({ length: 13 }, (_, i) => i + 1) },
      { from: 13, to: 14, applied: [14] },
      { from: 14, to: 15, applied: [15] },
    ]);
  });

  it('the production storage opened it without re-migrating; the receipts table has no payload text column', () => {
    const db = openRawDb(dbPath);
    try {
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(15);
      expect(columnNames(db, 'learning_items')).toEqual([
        'id', 'actor_id', 'kind', 'capability', 'language', 'source_turn_id', 'source_memory_id', 'egress', 'created_at',
        'expires_at', 'data',
      ]);
      expect(columnNames(db, 'connector_write_receipts')).toEqual([
        'id', 'actor_id', 'idempotency_key', 'connector', 'operation', 'target', 'payload_sha256', 'status', 'created_at',
        'updated_at', 'data',
      ]);
      type Db = Parameters<typeof runMigrations>[0];
      expect(() => runMigrations(db as unknown as Db, MIGRATIONS.slice(0, 14))).toThrow('SCHEMA_VERSION_AHEAD');
    } finally {
      db.close();
    }
  });
});

describe('Personal v3 acceptance — composition in the maximum v3 configuration', () => {
  it('ConversationRuntimeDeps: every key composed, the dispatch-boundary baseline is 35, and the write flow is the bound one', () => {
    const typeKeys: Record<keyof ConversationRuntimeDeps, true> = {
      dispatchCommit: true, actors: true, sessions: true, memory: true, memoryWriter: true, classifier: true,
      projects: true, analyzer: true, tasks: true, workspace: true, commandExecutions: true, command: true,
      contextBuilder: true, promptComposer: true, promptRenderer: true, router: true, runtimeProviderRouting: true,
      artifacts: true, composer: true, workSurface: true, intentResolver: true, orchestrator: true, approvals: true,
      approvalFlow: true, scopeClarificationFlow: true, applyPreviewFlow: true, codeGeneration: true, patch: true,
      codeProposals: true, workspaceWrite: true, git: true, repositoryHosting: true, turnHandlers: true,
      credentialOverrideFlow: true, connectorWriteFlow: true, logger: true,
    };
    const deps = (harness.runtime as unknown as { deps: ConversationRuntimeDeps }).deps;
    const composed = Object.keys(deps).sort();
    expect(composed).toEqual(Object.keys(typeKeys).sort());
    // ADR-0112 D5 moved the baseline 34 → 35 (CWR-2); SUB-3 and OPS-2b added none (ADR-0113 D8). The optional offline
    // Stage 2A routing seam `runtimeProviderRouting` has never been counted.
    expect(composed.filter((key) => key !== 'runtimeProviderRouting')).toHaveLength(35);
    expect(composed.some((key) => /remind|feedback|work(?:Chat|Desk|Summary)|branch|calendar|opsUi|approvalDecision/i.test(key))).toBe(false);
    expect(harness.flow).not.toBeNull();
    expect(deps.connectorWriteFlow).toBe(harness.flow);
  });

  // Ratchet 9 → 10: the runtime model switch adds the `model-selection` handler (ADR-0092 amendment).
  it('registers exactly ten turn handlers in their fixed stage/order', () => {
    expect(harness.handlers.map((handler) => handler.id).sort()).toEqual(EXPECTED_REGISTRY.map(([id]) => id).sort());
    const byStage = (harness.runtime as unknown as {
      turnHandlersByStage: Readonly<Record<TurnHandlerStage, readonly ConversationTurnHandler[]>>;
    }).turnHandlersByStage;
    expect(Object.keys(byStage)).toEqual([...TURN_HANDLER_STAGES]);
    const dispatchOrder = TURN_HANDLER_STAGES.flatMap((stage) =>
      byStage[stage].map((handler) => [handler.id, handler.stage, handler.order] as const),
    );
    expect(dispatchOrder).toEqual(EXPECTED_REGISTRY);
  });

  it('help: the registry lines then the write-flow lines, 14 lines × 120 chars at most (ADR-0096 D6 as amended), none cut', async () => {
    expect(MAX_CONTRIBUTED_HELP_LINES).toBe(14);
    expect(MAX_CONTRIBUTED_HELP_LINE_CHARS).toBe(120);
    const contributed = (harness.runtime as unknown as { contributedHelpLines: readonly string[] }).contributedHelpLines;
    const registered = EXPECTED_REGISTRY.flatMap(([id]) => harness.handlers.find((h) => h.id === id)?.helpLines ?? []);
    const flowLines = harness.flow?.helpLines ?? [];
    expect(flowLines).toHaveLength(2); // the Jira line and the Slack line (calendar writes change the calendar line)
    expect(contributed).toEqual([...registered, ...flowLines]);
    // The ratchet value: the maximum v3 configuration fills the amended budget exactly. The runtime model switch added
    // its one line and kept the total at 14 by merging the two feedback lines into one (ADR-0092 amendment).
    expect(contributed).toHaveLength(14);
    expect(contributed.length).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINES);
    for (const line of contributed) {
      expect(Array.from(line).length, line).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINE_CHARS);
      expect(line, line).not.toMatch(/\n/);
    }
    // With calendar writes bound the calendar handler names the write flow instead of "읽기 전용".
    const calendarLines = harness.handlers.find((h) => h.id === 'calendar')?.helpLines ?? [];
    expect(calendarLines.join('\n')).not.toContain('읽기 전용');

    const help = await det(harness.freshContext(), '도움말');
    expect(help.route).toBe('runtime');
    const lines = help.text.split('\n');
    const first = lines.indexOf(contributed[0] as string);
    expect(first).toBeGreaterThan(0);
    expect(lines.slice(first, first + contributed.length)).toEqual([...contributed]);
    expect(help.text).not.toContain('…');
    expect(help.text.length).toBeLessThanOrEqual(2000);
  });
});

describe('Personal v3 acceptance — connector-write execution allow-list (ADR-0112 D5, ADR-0110 amendment D4)', () => {
  it.each(CONNECTOR_WRITE_GATES)('%s: the documented phrase is "%s"; questions, negations and bare 실행 never execute', (gate, phrase) => {
    expect(documentedExecutionPhrase(gate)).toBe(phrase);
    expect(EXECUTION_PHRASES[gate]).toContain(phrase);
    expect(isAcceptedExecutionPhrase(gate, phrase)).toBe(true);
    expect(isAcceptedExecutionPhrase(gate, `${phrase}해줘`)).toBe(true);
    expect(isAcceptedExecutionPhrase(gate, `지금 ${phrase}`)).toBe(true);
    for (const near of [`${phrase}해도 돼?`, `${phrase}하지 마`, `${phrase}했어`, `${phrase} 방법 알려줘`, '실행', '실행해줘', '승인']) {
      expect(isAcceptedExecutionPhrase(gate, near), `${gate} accepted "${near}"`).toBe(false);
    }
  });

  it('no connector-write phrase executes another gate (each write names its own step; bare 실행 stays remote cleanup only)', () => {
    const gates = Object.keys(EXECUTION_PHRASES) as ExecutionGate[];
    for (const [gate] of CONNECTOR_WRITE_GATES) {
      expect(EXECUTION_PHRASES[gate]).not.toContain('실행');
      for (const phrase of EXECUTION_PHRASES[gate]) {
        const accepting = gates.filter((other) => isAcceptedExecutionPhrase(other, phrase));
        expect(accepting, `${gate}: "${phrase}"`).toEqual([gate]);
      }
    }
  });

  it('every execution phrase with nothing approved gets the fixed reply, provider-free, and writes nothing', async () => {
    for (const [, phrase] of CONNECTOR_WRITE_GATES) {
      const seen = await det(harness.freshContext(), phrase);
      expect(seen.route, phrase).toBe('runtime');
      expect(seen.text, phrase).toBe(renderNoApprovedConnectorWrite());
    }
    expect(totalWrites()).toBe(0);
  });
});

describe('Personal v3 acceptance — connector-write approvals end to end, provider-free (ADR-0112 D5/D6, live QA W5)', () => {
  it('Jira comment: exact preview → early phrase waits → 승인 → near-misses never send (W5-L01) → 댓글 실행 sends once → repeats never resend (W5-L02)', async () => {
    const owner = harness.freshContext();
    const request = 'PROJ-12에 댓글 달아줘: INT-2 배포 **완료**했습니다 @here';
    const preview = await det(owner, request);
    expect(preview.text).toContain('Jira 댓글 미리보기예요. 아직 아무것도 보내지 않았어요.');
    expect(preview.text).toContain('```\nINT-2 배포 **완료**했습니다 @here\n```');
    expect(preview.text).toContain('"댓글 실행"');
    expect(preview.text).toContain('CRITICAL');
    // OPS UI off (the default): no confirmation reference line (ADR-0113 D7).
    expect(preview.text).not.toContain(APPROVAL_REFERENCE_LINE_PREFIX);

    expect((await det(owner, '댓글 실행')).text).toContain('승인을 기다리고 있어요');
    expect((await det(owner, '승인')).text).toContain('승인을 기록했어요. 아직 실행하지 않았어요.');
    // W5-L01: a question or negation about the step gets the deterministic reminder, never chat and never a send.
    for (const text of ['댓글 실행해도 돼?', '댓글 실행하지 마']) {
      expect((await det(owner, text)).text, text).toBe(renderConnectorWriteApprovedReminder('ISSUE_COMMENT', '댓글 실행'));
    }
    for (const text of ['Slack 게시 실행', '일정 추가 실행', '승인']) await det(owner, text);
    // INT-2 finding (not a send, but not deterministic either): a bare "실행" — the remote-cleanup gate's phrase — while a
    // comment is approved names no write step, so it falls through to chat (W5-L01 covers only phrases naming the step).
    // The safety property holds: nothing is sent and the grant still waits for its exact phrase.
    await harness.turn(owner, '실행');
    expect(totalWrites()).toBe(0);

    const sent = await det(owner, '댓글 실행');
    expect(sent.text).toContain('Jira 댓글 완료: 댓글을 달았어요.');
    expect(sent.text).toContain(`<${COMMENT_URL}>`);
    expect(harness.writes.addComment).toEqual([{ issueKey: 'PROJ-12', text: 'INT-2 배포 **완료**했습니다 @here' }]);

    // W5-L02: the phrase again says it already ran (never "nothing approved"), and the same request matches the receipt.
    expect((await det(owner, '댓글 실행')).text).toContain('이미 실행했어요');
    expect((await det(owner, request)).text).toContain('이미 보냈어요');
    expect(harness.writes.addComment).toHaveLength(1);

    // The real v15 receipt holds no payload text.
    const db = openRawDb(dbPath);
    try {
      const rows = db.prepare(`SELECT * FROM connector_write_receipts WHERE operation = 'ISSUE_COMMENT'`).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'SENT', connector: 'jira', target: 'PROJ-12' });
      expect(JSON.stringify(rows)).not.toContain('INT-2 배포');
    } finally {
      db.close();
    }
  });

  it('refuses a non-allowlisted project and credential text before any approval or write (W5 T9)', async () => {
    const owner = harness.freshContext();
    const before = harness.writes.addComment.length;
    const other = await det(owner, 'OPS-1에 댓글: hello');
    expect(other.text).toContain('쓰기가 허용된 대상이 아니에요');
    const secret = await det(owner, `PROJ-1에 댓글: token=${'gh'}${'p_'}${'a'.repeat(36)}`);
    expect(secret.text).toContain('비밀 값처럼 보이는 내용');
    expect(secret.text).not.toContain('a'.repeat(36));
    expect(harness.writes.addComment).toHaveLength(before);
  });

  it('Jira transition: preview binds the transition → 승인 → 상태 변경 실행 transitions once (W5 T1–T3)', async () => {
    const owner = harness.freshContext();
    const preview = await det(owner, 'PROJ-12 진행 중으로 바꿔줘');
    expect(preview.text).toContain('"상태 변경 실행"');
    await det(owner, '승인');
    await det(owner, '상태 변경 실행');
    expect(harness.writes.transition).toEqual([
      expect.objectContaining({ issueKey: 'PROJ-12', transitionId: '21', toStatusId: '3' }),
    ]);
  });

  it('Jira transition: 거절 sends nothing and the phrase afterwards has nothing approved (W5 T4–T5)', async () => {
    const owner = harness.freshContext();
    await det(owner, 'PROJ-7 완료로 바꿔줘');
    expect((await det(owner, '거절')).text).toBe('요청을 거절했어요. 아무것도 보내지 않았어요.');
    expect((await det(owner, '상태 변경 실행')).text).toBe(renderNoApprovedConnectorWrite());
    expect(harness.writes.transition).toHaveLength(1);
  });

  it('Slack: a NOT_SENT outcome is reported truthfully with the right particle (W5-L03), then a post goes once (W5 S1–S7)', async () => {
    const owner = harness.freshContext();
    slackOutcome = () => connectorWriteNotSent('NOT_FOUND');
    try {
      await det(owner, `#${SLACK_CHANNEL_NAME}에 게시: INT-2 점심 먹으러 갑니다`);
      await det(owner, '승인');
      const failed = await det(owner, 'Slack 게시 실행');
      expect(failed.text).toBe(renderConnectorWriteOutcome('CHANNEL_POST', connectorWriteNotSent('NOT_FOUND')));
      expect(failed.text).toContain('Slack 게시를 하지 못했어요');
      expect(failed.text).not.toContain('을(를)');
    } finally {
      slackOutcome = () => connectorWriteSent('1700000000.000100');
    }
    const retry = harness.freshContext();
    await det(retry, `Slack #${SLACK_CHANNEL_NAME}에 게시: INT-2 다시 게시합니다`);
    await det(retry, '승인');
    await det(retry, '슬랙 게시 실행');
    expect(harness.writes.post).toHaveLength(2);
    expect(harness.writes.post[1]).toMatchObject({ channel: SLACK_CHANNEL_ID, text: 'INT-2 다시 게시합니다' });
    expect((await det(retry, `Slack #${SLACK_CHANNEL_NAME}에 게시: INT-2 다시 게시합니다`)).text).toContain('이미 보냈어요');
    expect(harness.writes.post).toHaveLength(2);
    // A channel outside the allowlist is refused before any approval.
    expect((await det(harness.freshContext(), '#random에 게시: hello')).text).toContain('쓰기가 허용된 대상이 아니에요');
    expect(harness.writes.post).toHaveLength(2);
  });

  it('live QA 2026-10-07: approved in the ops UI for a guild channel, "Slack 게시 실행" in the DM runs nothing and names the channel', async () => {
    const dm = harness.freshContext();
    const guild: ConversationContext = { ...harness.freshContext(dm.userId), spaceId: '777777777777777777' };
    // An earlier, unrelated post of the same owner in the DM (the link the bot wrongly returned live).
    await det(dm, `#${SLACK_CHANNEL_NAME}에 게시: INT-2 지난 게시물`);
    await det(dm, '승인');
    await det(dm, 'Slack 게시 실행');
    const posts = harness.writes.post.length;

    const decisions = harness.runtime.approvalDecisions;
    decisions.setConfirmationReferenceEnabled(true);
    try {
      const preview = await det(guild, `#${SLACK_CHANNEL_NAME}에 게시: 운영 UI 승인 테스트입니다`);
      const line = preview.text.split('\n').find((l) => l.startsWith(APPROVAL_REFERENCE_LINE_PREFIX));
      const reference = line!.slice(APPROVAL_REFERENCE_LINE_PREFIX.length, APPROVAL_REFERENCE_LINE_PREFIX.length + 6);
      const pending = (await harness.storage.approvals.list()).find((a) => a.status === ApprovalStatus.PENDING);
      const actor = await harness.storage.actors.findByExternalIdentity('discord', dm.userId);
      const decided = await decisions.decideFromOpsUi({
        approvalId: pending!.id,
        decision: 'approve',
        actor: actor!,
        reference,
        sessions: async () => harness.storage.sessions.list(),
      });
      expect(decided).toMatchObject({ status: 'DECIDED', outcome: 'APPROVED', connectorWrite: { executionPhrase: 'Slack 게시 실행' } });
    } finally {
      decisions.setConfirmationReferenceEnabled(false);
    }

    const elsewhere = await det(dm, 'Slack 게시 실행');
    expect(elsewhere.text).toBe(
      [
        `실행하지 않았어요. 승인된 Slack 게시(#${SLACK_CHANNEL_NAME})는 다른 대화에서 기다리고 있어요 (약 30분 남음).`,
        `미리보기를 받은 <#${guild.channelId}>에서 "Slack 게시 실행"이라고 보내 주세요.`,
      ].join('\n'),
    );
    expect(harness.writes.post).toHaveLength(posts);
    await det(guild, 'Slack 게시 실행');
    expect(harness.writes.post).toHaveLength(posts + 1);
    expect(harness.writes.post[posts]).toMatchObject({ channel: SLACK_CHANNEL_ID, text: '운영 UI 승인 테스트입니다' });
  });

  it('calendar create (W4-L01 phrasing): preview → 승인 → a question is only a reminder → 일정 추가 실행 creates once (W5 K1–K4)', async () => {
    const owner = harness.freshContext();
    const preview = await det(owner, '내일 오후 3시에 회의 잡아줘');
    expect(preview.route).toBe('calendar');
    expect(preview.text).toContain('아직 캘린더를 바꾸지 않았어요');
    expect(preview.text).toContain('"일정 추가 실행"');
    await det(owner, '승인');
    expect((await det(owner, '일정 추가 실행할까?')).text).toBe(
      renderConnectorWriteApprovedReminder('CALENDAR_EVENT_CREATE', '일정 추가 실행'),
    );
    expect(harness.writes.createEvent).toHaveLength(0);
    await det(owner, '일정 추가 실행');
    expect(harness.writes.createEvent).toHaveLength(1);
    // W5-L04: with calendar writes on, the schedule answer's footer no longer says "read-only".
    const listed = await det(owner, '내일 일정 뭐야?');
    expect(listed.route).toBe('calendar');
    expect(listed.text).toContain(READ_FIXTURE_TITLE);
    expect(listed.text).toContain(`(${SEOUL} 기준)`);
    expect(listed.text).not.toContain('읽기 전용');
  });

  it('calendar update binds the previewed event and version; delete is refused by 거절 (W5 K5–K11)', async () => {
    const owner = harness.freshContext();
    const update = await det(owner, '내일 3시 회의 4시로 옮겨줘');
    expect(update.text).toContain(WRITE_FIXTURE_TITLE);
    expect(update.text).toContain('"일정 변경 실행"');
    await det(owner, '승인');
    await det(owner, '일정 변경 실행');
    expect(harness.writes.updateEvent).toEqual([
      expect.objectContaining({ eventId: 'int2-weekly', expected: expect.objectContaining({ version: '"int2-v1"' }) }),
    ]);

    const other = harness.freshContext();
    const remove = await det(other, '내일 3시 회의 취소해줘');
    expect(remove.text).toContain('"일정 삭제 실행"');
    await det(other, '거절');
    expect((await det(other, '일정 삭제 실행')).text).toBe(renderNoApprovedConnectorWrite());
    expect(harness.writes.deleteEvent).toEqual([]);
    expect(harness.primaryReads.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Personal v3 acceptance — calendar reads and memory archive stay deterministic', () => {
  it('schedule questions incl. the subject-less availability fix (W4-L02) answer from the calendar; content requests are chat', async () => {
    for (const text of ['내일 바빠?', '오늘 오후 한가해?', '오늘 일정 뭐야?', '이번 주 일정 알려줘', '다음 회의는 언제야?']) {
      const seen = await det(harness.freshContext(), text);
      expect(seen.route, text).toBe('calendar');
      expect(seen.text, text).toContain(READ_FIXTURE_TITLE);
    }
    // Calendar text never reaches the conversation history (ADR-0110 D4).
    const owner = harness.freshContext();
    await det(owner, '오늘 일정');
    const history = (await harness.storage.memories.findShortTermByUser(owner.userId)).map((record) => record.content);
    expect(history.some((row) => row.includes(READ_FIXTURE_TITLE))).toBe(false);
  });

  it('memory: forget (particle form) → archive → restore → forget → permanent delete, every turn provider-free', async () => {
    const owner = harness.freshContext();
    const codeIn = (text: string): string => /기억 확인 ([A-Z0-9]{4})/u.exec(text)?.[1] ?? '';
    await det(owner, '기억해: INT-2 보관함 확인용 기억');
    const ask = await det(owner, '기억 1을 잊어줘');
    expect(ask.route).toBe('memory-commands');
    expect(ask.text).toContain('> INT-2 보관함 확인용 기억');
    expect((await det(owner, `기억 확인 ${codeIn(ask.text)}`)).text).toContain('이 기억을 잊었어요');

    const archive = await det(owner, '기억 보관함');
    expect(archive.route).toBe('memory-commands');
    expect(archive.text).toContain('1. INT-2 보관함 확인용 기억 (7일 남음)');
    const restoreAsk = await det(owner, '기억 복원 1');
    expect((await det(owner, `기억 확인 ${codeIn(restoreAsk.text)}`)).text).toContain('기억을 복원했어요');
    expect((await det(owner, '기억 목록')).text).toContain('1. INT-2 보관함 확인용 기억');

    const again = await det(owner, '기억 1번을 잊어줘');
    await det(owner, `기억 확인 ${codeIn(again.text)}`);
    const ownerActor = await harness.storage.actors.findByExternalIdentity(owner.platform, owner.userId);
    const [record] = await harness.storage.memories.findDurableCandidates({
      scope: { userId: ownerActor?.id ?? '' },
      limit: 5,
      archived: 'include',
    });
    expect(record && isArchivedMemory(record)).toBe(true);
    const purgeAsk = await det(owner, '기억 완전 삭제 1번 해줘');
    expect(purgeAsk.text).toContain('완전히 지울까요?');
    expect((await det(owner, `기억 확인 ${codeIn(purgeAsk.text)}`)).text).toContain('보관함의 기억을 완전히 지웠어요');
    expect(await harness.storage.memories.get(record?.id ?? '')).toBeNull();
    expect((await det(owner, '보관함')).text).toContain('보관함이 비어 있어요');
  });
});

describe('Personal v3 acceptance — operations UI (ADR-0113 D1/D2/D7)', () => {
  const opsInput = (overrides: Partial<OpsUiWiringInput> = {}): OpsUiWiringInput => {
    const config = loadConfig(process.env);
    return {
      app: harness.app,
      config,
      ops: { backupStatus: () => ({}) } as unknown as OpsUiWiringInput['ops'],
      instanceLockHeld: false,
      identityVerified: false,
      cwd: tempDir,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      ...overrides,
    };
  };
  const tokenFile = () => join(tempDir, OPS_UI_TOKEN_FILE_NAME);
  const previewText = 'PROJ-30에 댓글: INT-2 운영 화면 확인';

  it('is off by default: the folded flags parse to disabled and nothing is opened or written', async () => {
    expect(loadConfig(process.env).opsUi).toEqual({ enabled: false });
    const handle = await startOpsUi(opsInput());
    expect(handle.port).toBeUndefined();
    expect(existsSync(tokenFile())).toBe(false);
  });

  it('binds 127.0.0.1 only; while it listens the chat preview gains only the reference line, and is byte-identical again after stop', async () => {
    expect(OPS_UI_BIND_HOST).toBe('127.0.0.1');
    await expect(
      startOpsUi(opsInput({ env: { QUOKY_OPS_UI_ENABLED: 'true' }, portOverride: 0, host: '0.0.0.0' })),
    ).rejects.toMatchObject({ code: 'OPS_UI_BIND_NOT_LOOPBACK' });

    const off = await det(harness.freshContext(), previewText);
    const handle = await startOpsUi(opsInput({ env: { QUOKY_OPS_UI_ENABLED: 'true' }, portOverride: 0 }));
    try {
      const port = handle.port ?? 0;
      expect(port).toBeGreaterThan(0);
      expect(existsSync(tokenFile())).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      const on = await det(harness.freshContext(), previewText);
      const onLines = on.text.split('\n');
      expect(onLines.slice(0, -1).join('\n')).toBe(off.text);
      expect(onLines.at(-1)).toMatch(new RegExp(`^${APPROVAL_REFERENCE_LINE_PREFIX}[0-9A-Z]{6} `, 'u'));
    } finally {
      await handle.stop();
    }
    expect(existsSync(tokenFile())).toBe(false);
    // UI stopped: chat approvals still work and the preview is byte-identical to the UI-off one.
    const owner = harness.freshContext();
    const after = await det(owner, previewText);
    expect(after.text).toBe(off.text);
    await det(owner, '거절');
  });
});

describe('Personal v3 acceptance — runtime model switch from chat (ADR-0092 / ADR-0111 amendments, runtime switching)', () => {
  const IMAGE: InboundAttachment = {
    kind: 'image', name: 'chart.png', mimeType: 'image/png', sizeBytes: 2048,
    imageRef: '/tmp/quoky-attachments-int2/proc-Int2/intake-0b7f2c1e-1111-4222-8333-944445555777.png', trust: 'UNTRUSTED',
  };
  const lastProviderId = () => harness.executions.at(-1)?.provider.id;

  it('the owner switches this conversation to claude:opus; other conversations and code work stay on the default', async () => {
    const owner = harness.freshContext(OWNER_ID);
    const status = await harness.turn(owner, '모델 상태');
    expect(status.route).toBe('model-selection');
    expect(status.providerCalls).toBe(0);
    expect(status.text).toContain('- 대화: claude:sonnet · 출처: 기본값(설정에서 도출)');

    const set = await harness.turn(owner, '/model claude:opus');
    expect(set.route).toBe('model-selection');
    expect(set.providerCalls).toBe(0);
    expect(set.text).toContain('이 대화의 대화 모델을 claude:opus로 바꿨어요. 이 대화에서만 적용돼요 (기본값은 운영 화면에서).');

    const chat = await harness.turn(owner, 'INT-2 오늘 기분 어때?');
    expect(chat.route).toBe('classifier');
    expect(chat.providerCalls).toBe(1);
    expect(lastProviderId()).toBe('claude-cli:opus');

    // Another conversation of the same owner is unaffected.
    await harness.turn(harness.freshContext(OWNER_ID), 'INT-2 오늘 기분 어때?');
    expect(lastProviderId()).toBe('claude-cli');

    // 새 대화 opens a new Session: the override ends with the old one.
    await harness.turn(owner, '새 대화');
    await harness.turn(owner, 'INT-2 오늘 기분 어때?');
    expect(lastProviderId()).toBe('claude-cli');
  });

  it('switching the image model off stops the cloud image call at once; the reset restores it', async () => {
    const owner = harness.freshContext(OWNER_ID);
    const off = await harness.turn(owner, '이미지 모델 변경: off');
    expect(off.route).toBe('model-selection');
    const blocked = await harness.turn(owner, '이 그래프 설명해줘', [IMAGE]);
    expect(blocked.providerCalls).toBe(0);
    // Live QA follow-up: the notice says image analysis is OFF in this conversation and how to turn it back on.
    expect(blocked.text).toContain('이 대화에서는 이미지 분석을 꺼 두어서 첨부한 이미지를 분석하지 않았어요.');
    expect(blocked.text).toContain('이미지는 어디로도 보내지 않았어요.');
    expect(blocked.text).toContain('"이미지 모델 변경: claude"');
    expect(blocked.text).toContain('"모델 기본값으로"');
    expect(blocked.text).not.toContain('지원하지 않는');

    const reset = await harness.turn(owner, '모델 기본값으로');
    expect(reset.text).toContain('이 대화의 모델 선택을 지웠어요.');
    const allowed = await harness.turn(owner, '이 그래프 설명해줘', [IMAGE]);
    expect(allowed.providerCalls).toBe(1);
    expect(harness.executions.at(-1)?.provider).toBeInstanceOf(ClaudeCliVisionProvider);
  });

  it('a non-owner context changes nothing; near-miss phrasing is ordinary chat', async () => {
    const stranger = harness.freshContext();
    const refused = await harness.turn(stranger, '모델 변경: claude:haiku');
    expect(refused.route).toBe('model-selection');
    expect(refused.text).toBe('모델 변경은 소유자만 할 수 있어요.');
    await harness.turn(stranger, 'INT-2 안녕?');
    expect(lastProviderId()).toBe('claude-cli');
    const nearMiss = await harness.turn(harness.freshContext(OWNER_ID), '모델 변경해야 할까?');
    expect(nearMiss.route).toBe('classifier');
  });
});

describe('Personal v3 acceptance — image turn with the Claude image provider selected (ADR-0111 amendment A1/A2)', () => {
  // A runner-owned temp-file reference as the Discord adapter produces it; the stubbed provider never opens it.
  const IMAGE_REF = '/tmp/quoky-attachments-int2/proc-Int2/intake-0b7f2c1e-1111-4222-8333-944445555666.png';
  const image: InboundAttachment = {
    kind: 'image', name: 'chart.png', mimeType: 'image/png', sizeBytes: 2048, imageRef: IMAGE_REF, trust: 'UNTRUSTED',
  };

  it('registers exactly one IMAGE_UNDERSTANDING provider: the REMOTE Claude vision instance', async () => {
    const imageProviders = harness.app
      .get<AiProvider[]>(AI_PROVIDERS)
      .filter((provider) => provider.capabilities.some((c) => c.capability === 'IMAGE_UNDERSTANDING'));
    expect(imageProviders).toHaveLength(1);
    expect(imageProviders[0]).toBeInstanceOf(ClaudeCliVisionProvider);
    expect(imageProviders[0]?.executionLocality).toBe('REMOTE');
    expect(imageProviders[0]?.capabilities.map((c) => c.capability)).toEqual(['IMAGE_UNDERSTANDING']);
    // ADR-0111 amendment (runtime switching): the policy is resolved per image turn from the effective selection; with the
    // configured `claude` selection and no override it allows REMOTE.
    const resolve = (harness.runtime as unknown as {
      imagePolicy: (context: { sessionId?: string }) => Promise<readonly string[]>;
    }).imagePolicy;
    expect(typeof resolve).toBe('function');
    expect(await resolve({})).toEqual(['LOCAL', 'REMOTE']);
  });

  it('an image turn reaches the Claude vision instance with the image, skips the classifier, and is not "unavailable"', async () => {
    const before = harness.executions.length;
    const seen = await harness.turn(harness.freshContext(), '이 그래프 설명해줘', [image]);
    expect(seen.route).toBe('runtime');
    expect(seen.providerCalls).toBe(1);
    expect(seen.text).toBe(STUB_REPLY);
    expect(seen.text).not.toBe(renderImageUnderstandingUnavailable('ko'));
    const executed = harness.executions.slice(before);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.provider).toBeInstanceOf(ClaudeCliVisionProvider);
    expect(executed[0]?.capability).toBe('IMAGE_UNDERSTANDING');
    expect(executed[0]?.imageCount).toBe(1);
    expect(logLines.join('\n')).not.toContain(IMAGE_REF);
  });

  it('a credential-shaped reply on an image-only turn is withheld (amendment A3)', async () => {
    stubReply = '화면에 보이는 값은 pass' + 'word=int2-image-placeholder 입니다';
    try {
      const seen = await harness.turn(harness.freshContext(), '이 스크린샷에 뭐라고 써 있어?', [image]);
      expect(seen.providerCalls).toBe(1);
      expect(seen.text).toBe(renderAttachmentReplyWithheld('ko'));
    } finally {
      stubReply = STUB_REPLY;
    }
  });
});

describe('Personal v3 acceptance — provider boundary', () => {
  it('positive control: a fall-through content request reaches the (stubbed) provider, so the counter is live', async () => {
    for (const text of ['내일 회의록 만들어줘', '오늘 점심 뭐 먹을까?']) {
      const seen = await harness.turn(harness.freshContext(), text);
      expect(seen.route, text).toBe('classifier');
      expect(seen.providerCalls, text).toBeGreaterThan(0);
      expect(seen.text, text).toBe(STUB_REPLY);
    }
  });

  it('every deterministic v3 turn above was provider-free, and nothing ever touched the network', () => {
    expect(deterministicTurns.length).toBeGreaterThan(60);
    const routes = new Set(deterministicTurns.map((turn) => turn.route));
    for (const route of ['runtime', 'calendar', 'memory-commands', 'work-chat.todo']) expect(routes, route).toContain(route);
    expect(networkAttempts).toBe(0);
  });

  it('the composition logs stay content-free: no comment, post, memory, calendar or stub text in any log line', () => {
    const logs = logLines.join('\n');
    for (const content of ['INT-2 배포', 'INT-2 다시 게시합니다', 'INT-2 보관함 확인용 기억', READ_FIXTURE_TITLE, STUB_REPLY, 'int2-jira-placeholder']) {
      expect(logs).not.toContain(content);
    }
  });
});
