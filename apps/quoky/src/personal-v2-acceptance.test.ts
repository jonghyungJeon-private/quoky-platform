import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  CALENDAR_READER,
  CODE_CHAIN_STATUS_DOMAINS,
  Capability,
  CONVERSATION_TURN_HANDLERS,
  ContextBuilder,
  ConversationRuntime,
  DURABLE_MEMORY_VECTOR_COLLECTION,
  DefaultMemoryRetriever,
  FeedbackSignalKind,
  createMemoryRetrievalRequest,
  IntentClassifier,
  IntentType,
  LearningItemKind,
  MAX_CONTRIBUTED_HELP_LINES,
  MemoryCommandService,
  MemoryManager,
  MemoryType,
  MAX_CONTRIBUTED_HELP_LINE_CHARS,
  DefaultMemoryWriter,
  isArchivedMemory,
  parseMemoryCommand,
  ResponseComposer,
  STORAGE_PROVIDER,
  RiskLevel,
  StatelessApplyPreviewFlow,
  TURN_HANDLER_STAGES,
  TaskStatus,
  VECTOR_PROVIDER,
  WorkChatService,
  detectCapabilityQuestion,
  generalChatReplyPolicy,
  guardInternalActionClaims,
  renderInternalActionNotDone,
  renderOwnMemoryNotFound,
  type AiProvider,
  type ApplyPreviewAnchor,
  type CalendarEvent,
  type CalendarEventQuery,
  type CalendarReader,
  type ConversationContext,
  type ConversationRuntimeDeps,
  type ConversationTurnHandler,
  type InboundMessage,
  type Task,
  type TurnHandlerStage,
  type VectorProvider,
} from '@quoky/core';
import type { SqliteStorageProvider } from '@quoky/storage-sqlite';
// Test-only, cross-package source imports (precedent: continuation-offline-acceptance.test.ts). The migration list
// and the golden scorer are not part of either package's public surface; `migrations.ts` imports better-sqlite3 as a
// type only, and the driver itself is resolved from the storage package (apps/quoky does not depend on it).
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from '../../../packages/storage-sqlite/src/migrations';
import baselineFile from '../../../packages/core/src/application/golden/baseline.v1.json';
import {
  evaluateGoldenSuiteAsync,
  formatGoldenSummary,
  mustPassFailures,
  ratchetViolations,
  validateGoldenCases,
} from '../../../packages/core/src/application/golden/golden-eval';
import type {
  GoldenBaselineFile,
  GoldenCase,
  GoldenSuiteFile,
} from '../../../packages/core/src/application/golden/golden-eval';
import { stubProviderSelection } from './provider-selection/test-support';
import precedenceCorpus from '../../../packages/core/src/application/golden/reminder-todo-precedence.v1.json';
import routingCorpus from '../../../packages/core/src/application/golden/turn-handler-routing.v1.json';
import actionShapedCorpus from '../../../packages/core/src/application/golden/action-shaped-fallthrough.v1.json';

/**
 * Personal v2 — integration acceptance (INT-1, plan wave 8; ADR-0096..ADR-0101). OFFLINE and in-process: the REAL
 * `AppModule` (every production provider, the four feature compositions and the turn-handler aggregator) is booted
 * through Nest over a REAL SQLite file that was migrated 11 → 12 → 13 first. Only the edges are replaced: the
 * environment is a sanitized temp config (no `.env.local`, no token, no connector, Ollama off), the Discord adapter
 * is never started, and every registered `AiProvider` instance has its `isAvailable`/`execute` replaced by a counting
 * stub, so no CLI is ever spawned and every provider touch is visible. Turns go through the production
 * `ConversationRuntime` exactly as `QuokyCore` would call it.
 *
 * It pins: the dispatch-boundary deps baseline, the nine handlers in their fixed stages/orders (the five v2 handlers
 * plus the ADR-0104 D4 help-intent handler, registered at wave-1 integration, the ADR-0106 memory-command handler,
 * registered by MEM-1, the ADR-0107 D3 learning-command handler, LRN-1, and the ADR-0110 calendar handler, CAL-2 —
 * the harness configures a calendar whose adapter's `listEvents` is replaced by an offline fixture), the contributed help
 * lines and their bounds, zero provider calls on deterministic turns, the ADR-0100 D1 anchored-prefix precedence and
 * the turn-handler routing golden ratchet (including the wave-7 live-QA fixes), and the migration contiguity.
 */

const OWNER_ID = '111111111111111111';
const baseline = baselineFile as unknown as GoldenBaselineFile;

interface RoutingCtx {
  /** To-do titles added (through the to-do handler) before the case's text is sent. */
  readonly openTodos?: readonly string[];
  /** A post-push apply-preview anchor status seeded on the session before the case's text is sent. */
  readonly applyAnchor?: ApplyPreviewAnchor['status'];
  /** Register a real sandbox git repository as the session's project first (live QA W1-L01: the dev bot had one). */
  readonly registeredProject?: boolean;
  /** Turns sent (after the project registration) before the case's text, e.g. a code change that leaves a clarification. */
  readonly priorTurns?: readonly string[];
}
interface RoutingExpected {
  readonly route: string;
  readonly kind?: string;
  readonly reply?: string;
  readonly providerCalls?: number;
}
interface RoutingCase extends GoldenCase<RoutingExpected> {
  readonly ctx?: RoutingCtx;
}
interface PrecedenceCase extends GoldenCase<{ handler: string }> {
  readonly pending?: boolean;
  readonly blockedBy?: string;
}

const routing = routingCorpus as unknown as GoldenSuiteFile<RoutingCase>;
/** ADR-0104 D6 (DET-1): `guard` cases replay a chat reply through the claim guard; `turn` cases route like `RoutingCase`. */
type ActionShapedCase =
  | (GoldenCase<{ guarded: boolean; domain?: string }> & { readonly kind: 'guard'; readonly userText: string })
  | (RoutingCase & { readonly kind: 'turn' });
const actionShaped = actionShapedCorpus as unknown as GoldenSuiteFile<ActionShapedCase>;
const precedence = precedenceCorpus as unknown as GoldenSuiteFile<PrecedenceCase>;

/** ADR-0100 D1: the closed list of anchored to-do heads (literal mirror; the precedence corpus pins one case each). */
const ANCHORED_TODO_HEADS = [
  '할 일 추가', '할일 추가', '할 일 등록', '할일 등록', 'todo add', 'add todo', 'to-do add',
  '완료 처리', '할 일 완료', '할일 완료', 'todo done',
  '할 일 취소', '할일 취소', 'todo cancel',
  '할 일 연결', '할일 연결', 'todo link',
] as const;

/** The fixed registry (ADR-0096 D2/D5): `(stage, order, id)` in dispatch order. */
const EXPECTED_REGISTRY: ReadonlyArray<readonly [string, TurnHandlerStage, number]> = [
  ['feedback.summary', 'control', 100],
  ['git-branch', 'post-anchor', 100],
  // ADR-0106 D2 (amends ADR-0096 D5): memory commands after the runtime's `기억해:` block, before anchored to-dos.
  ['memory-commands', 'pre-classify', 50],
  // ADR-0107 D3 (amends ADR-0096 D5): owner learning commands, after memory commands (50), before to-dos (100).
  ['feedback.learning', 'pre-classify', 60],
  // ADR-0092 amendment (runtime switching): the owner's model command (`모델 변경: …`, `/model`), after learning (60),
  // before to-dos (100). Always registered: it is owner-only and changes only the conversation's own override.
  ['model-selection', 'pre-classify', 70],
  ['work-chat.todo', 'pre-classify', 100],
  // ADR-0110 D3 (amends ADR-0096 D5): schedule questions from the configured calendar, after to-dos, before reminders.
  ['calendar', 'pre-classify', 150],
  ['reminders', 'pre-classify', 200],
  ['work-chat.lookup', 'pre-classify', 300],
  // ADR-0104 D4 (amends ADR-0096 D5): how-to questions about Quoky's own commands, after work lookups, before the classifier.
  ['help-intent', 'pre-classify', 400],
];

/** Precedence-suite labels for the registered handler ids (the corpus predates the final ids). */
const PRECEDENCE_LABEL: Readonly<Record<string, string>> = {
  'work-chat.todo': 'work-chat.mutation',
  reminders: 'reminder',
  'work-chat.lookup': 'work-chat.lookup',
};

const STUB_REPLY = 'INT-1 stub provider reply';
/** What the counting provider stub answers; DET-1 swaps it to replay a claiming chat reply end-to-end. */
let stubReply: string = STUB_REPLY;

interface TurnObservation {
  readonly route: string;
  readonly handler: string;
  readonly kind?: string;
  readonly reply?: string;
  readonly providerCalls: number;
  readonly availabilityProbes: number;
  readonly text: string;
}

interface Harness {
  readonly runtime: ConversationRuntime;
  readonly storage: SqliteStorageProvider;
  readonly handlers: readonly ConversationTurnHandler[];
  readonly composer: ResponseComposer;
  /** The production vector cache (ADR-0098 D8), for the MEM-1 forget cascade check. */
  readonly vectors: VectorProvider;
  /** The production context assembly (W2-L01: what a provider would see of the conversation history). */
  readonly contextBuilder: ContextBuilder;
  readonly memory: MemoryManager;
  /** ADR-0106 amendment: the production memory-command service (the daily maintenance calls its expiry purge). */
  readonly memoryCommands: MemoryCommandService;
  /** ADR-0110 (CAL-2): every window the calendar handler read through the production `CALENDAR_READER`. */
  readonly calendarReads: readonly CalendarEventQuery[];
  providerCalls(): number;
  availabilityProbes(): number;
  /** Send one turn in `context` and report which layer answered it. */
  turn(context: ConversationContext, text: string): Promise<TurnObservation>;
  /** A fresh owner-shaped context (own actor, own session, own to-dos/reminders). */
  freshContext(): ConversationContext;
}

const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
let savedEnv: NodeJS.ProcessEnv = {};
let tempDir = '';
let dbPath = '';
let closeApp: (() => Promise<void>) | undefined;
let harness: Harness;
/** The 11 → 12 → 13 transitions recorded while preparing the temp DB, before AppModule ever opened it. */
const migrationSteps: Array<{ from: number; to: number; applied: number[] }> = [];

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
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

/** Build a v11 database, then step it to 12, 13, 14 and 15 with the production migration list (ADR-0096 D10). */
function prepareMigratedDatabase(path: string): void {
  const db = openRawDb(path);
  try {
    type Db = Parameters<typeof runMigrations>[0];
    const raw = db as unknown as Db;
    migrationSteps.push(runMigrations(raw, MIGRATIONS.slice(0, 11)));
    expect(tableNames(db)).not.toContain('feedback_signals');
    expect(tableNames(db)).not.toContain('reminders');
    migrationSteps.push(runMigrations(raw, MIGRATIONS.slice(0, 12)));
    expect(tableNames(db)).toContain('feedback_signals');
    expect(tableNames(db)).not.toContain('reminders');
    migrationSteps.push(runMigrations(raw, MIGRATIONS.slice(0, 13)));
    expect(tableNames(db)).toContain('reminders');
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

let contextSeq = 0;

/** The offline calendar fixture's one event title (it must never reach a provider or the conversation history). */
const CALENDAR_FIXTURE_TITLE = 'INT calendar fixture standup';

/**
 * One timed event inside whatever window is read (deterministic relative to the window, any wall clock): an hour in,
 * or a quarter of the way in when the window is shorter, so a "remaining today" window read late in the evening (it
 * starts at now and ends at midnight) still contains the whole event.
 */
function calendarFixture(query: CalendarEventQuery): readonly CalendarEvent[] {
  const from = Date.parse(query.from);
  const quarter = Math.floor((Date.parse(query.to) - from) / 4);
  const start = from + Math.min(60 * 60_000, quarter);
  return [
    {
      id: 'int-calendar-1',
      title: CALENDAR_FIXTURE_TITLE,
      start: new Date(start).toISOString(),
      end: new Date(start + Math.min(30 * 60_000, quarter)).toISOString(),
      allDay: false,
      status: 'confirmed',
      calendarName: 'primary',
    },
  ];
}

async function boot(): Promise<Harness> {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const storage = app.get<SqliteStorageProvider>(STORAGE_PROVIDER);
  closeApp = async () => {
    await storage.close().catch(() => undefined);
    await app.close();
  };
  // main.ts order: storage, then vector (the queue, platform and reminder tick driver are never started here).
  await storage.init();
  await app.get<VectorProvider>(VECTOR_PROVIDER).init();

  let providerCalls = 0;
  let availabilityProbes = 0;
  for (const provider of app.get<AiProvider[]>(AI_PROVIDERS)) {
    // Replace on the INSTANCE the router and classifier hold: no CLI can spawn and every touch is counted.
    Object.assign(provider, {
      async isAvailable() {
        availabilityProbes += 1;
        return true;
      },
      async execute() {
        providerCalls += 1;
        return { text: stubReply, artifacts: [] };
      },
    });
  }

  // ADR-0092 amendment (runtime switching): the model command's two host touches are replaced the same way — the local
  // Ollama inventory (`ollama list`) answers from a fixture, and an on-demand model instance the catalog adds later is
  // stubbed as it is added — so no command can spawn a CLI here.
  stubProviderSelection(app, (provider) =>
    Object.assign(provider, {
      async isAvailable() {
        availabilityProbes += 1;
        return true;
      },
      async execute() {
        providerCalls += 1;
        return { text: stubReply, artifacts: [] };
      },
    }),
  );

  // ADR-0110 (CAL-2): the configured Google adapter is the production instance; only its read is replaced (on the
  // INSTANCE the handler holds), so no network call is possible and every read is recorded.
  const calendarReads: CalendarEventQuery[] = [];
  Object.assign(app.get<CalendarReader>(CALENDAR_READER), {
    async listEvents(query: CalendarEventQuery): Promise<readonly CalendarEvent[]> {
      calendarReads.push(query);
      return calendarFixture(query);
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
  const desk = app.get(WorkChatService);
  const deskKinds: string[] = [];
  const deskHandle = desk.handle.bind(desk);
  vi.spyOn(desk, 'handle').mockImplementation(async (command, actor) => {
    deskKinds.push(command.kind);
    return deskHandle(command, actor);
  });
  const classifier = app.get(IntentClassifier);
  let classifyCalls = 0;
  const classify = classifier.classify.bind(classifier);
  vi.spyOn(classifier, 'classify').mockImplementation(async (message, ctx) => {
    classifyCalls += 1;
    return classify(message, ctx);
  });

  const runtime = app.get(ConversationRuntime);
  const composer = new ResponseComposer();
  let messageSeq = 0;

  return {
    runtime,
    storage,
    handlers,
    composer,
    vectors: app.get<VectorProvider>(VECTOR_PROVIDER),
    contextBuilder: app.get(ContextBuilder),
    memory: app.get(MemoryManager),
    memoryCommands: app.get(MemoryCommandService),
    calendarReads,
    providerCalls: () => providerCalls,
    availabilityProbes: () => availabilityProbes,
    freshContext() {
      contextSeq += 1;
      const n = String(contextSeq).padStart(4, '0');
      return { platform: 'discord', channelId: `77777777777777${n}`, userId: n === '0001' ? OWNER_ID : `11111111111111${n}` };
    },
    async turn(context, text) {
      const claimsBefore = claims.length;
      const kindsBefore = deskKinds.length;
      const classifyBefore = classifyCalls;
      const providerBefore = providerCalls;
      const probesBefore = availabilityProbes;
      messageSeq += 1;
      const message: InboundMessage = {
        id: `int1-message-${messageSeq}`,
        context,
        text,
        receivedAt: new Date().toISOString(),
      };
      const result = await runtime.handle(message);
      const claimed = claims.slice(claimsBefore);
      const kind = deskKinds.slice(kindsBefore).at(-1);
      const route = claimed[0] ?? (classifyCalls > classifyBefore ? 'classifier' : 'runtime');
      const replyText = result.reply.text;
      return {
        route,
        handler: claimed[0] !== undefined ? (PRECEDENCE_LABEL[claimed[0]] ?? claimed[0]) : 'none',
        ...(claimed[0] === 'work-chat.todo' || claimed[0] === 'work-chat.lookup' ? { kind } : {}),
        ...(route === 'runtime'
          ? { reply: runtimeReplyLabel(composer, context, replyText) }
          : route === 'classifier' && isOwnMemoryNotFound(replyText)
            ? { reply: 'own-memory-not-found' }
            : {}),
        providerCalls: providerCalls - providerBefore,
        availabilityProbes: availabilityProbes - probesBefore,
        text: replyText,
      };
    },
  };
}

/** Pushed-state fields every post-push anchor carries (only these reach the deterministic reply). */
const PUSHED = { commitHash: '0123456789abcdef0123456789abcdef01234567', remote: 'origin', branch: 'feature/int-1' };

function runtimeReplyLabel(composer: ResponseComposer, context: ConversationContext, text: string): string {
  if (text === composer.composePushAlreadyPushed(context, PUSHED).text) return 'push-already-pushed';
  if (text === composer.composePushUnsupportedCompanion(context).text) return 'push-unsupported';
  if (text === composer.composeNoPushTarget(context).text) return 'push-no-target';
  if (text === composer.composePushAlreadyApproved(context).text) return 'push-already-approved';
  if (text === composer.composeMergeAlreadyApproved(context).text) return 'merge-already-approved';
  // ADR-0099 D5 (merge off by default): the fixed merge-disabled reply to a real merge request at PR_CREATED.
  if (text === composer.composeMergeDisabled(context).text) return 'merge-disabled';
  // Live QA session 3 (D11): a merge request with merge on but no PR, and a bare "실행" with nothing approved.
  if (text === composer.composeNoMergeTarget(context).text) return 'merge-no-target';
  if (text === composer.composeNoApprovedExecution(context).text) return 'no-approved-execution';
  if (text === composer.composeRemoteBranchCleanupAlreadyApproved(context).text) return 'remote-cleanup-already-approved';
  for (const step of ['main-sync', 'local-cleanup', 'validation'] as const) {
    if (text === composer.composeExecutionPhraseHint(context, step).text) return `execution-phrase-hint:${step}`;
  }
  if (text === composer.composePushPrDeployUnsupported(context).text) return 'push-pr-deploy-unsupported';
  if (text === composer.composePrApprovedDeployUnsupported(context).text) return 'pr-approved-deploy-unsupported';
  if (text === composer.composePrCreatedCompanionUnsupported(context).text) return 'pr-created-companion-unsupported';
  if (text === composer.composeMergeApprovedCompanionUnsupported(context).text) return 'merge-approved-companion-unsupported';
  if (text === composer.composeMergeExecutionUnsupportedCompanion(context).text) return 'merge-execution-companion-unsupported';
  if (text === composer.composeCodePreviewDiscarded(context).text) return 'preview-discarded';
  if (text === composer.composeNoPendingDecision(context).text) return 'no-pending-decision';
  // ADR-0112 (CWR-2): a connector-write execution phrase with no approved write.
  if (text === composer.composeNoApprovedConnectorWrite(context).text) return 'no-approved-connector-write';
  if (text.startsWith('Quoky로 할 수 있는 일이에요.')) return 'help';
  // ADR-0106 D1: the runtime's explicit `기억해:` save (it runs before the pre-classify memory commands).
  if (text === composer.composeMemoryStored(context).text) return 'memory-stored';
  // ADR-0104 D3 (DET-1): the code-chain not-done reply for a status question / completion statement.
  for (const domain of CODE_CHAIN_STATUS_DOMAINS) {
    for (const language of ['ko', 'en'] as const) {
      if (text === renderInternalActionNotDone(domain, language)) return `internal-action-not-done:${domain}`;
    }
  }
  return 'other';
}

/** W3-L01: the deterministic own-memory "not in memory" reply (sent after classification, on the chat path). */
function isOwnMemoryNotFound(text: string): boolean {
  return text === renderOwnMemoryNotFound('ko') || text === renderOwnMemoryNotFound('en');
}

/** Finer labels for the action-shaped corpus' state-aware replies (existing replies the routing corpus labels `other`). */
function actionShapedReplyLabel(reply: string | undefined, text: string): string | undefined {
  if (reply !== 'other') return reply;
  if (text.startsWith('이미 커밋했어요')) return 'commit-already-committed';
  if (text.startsWith('이미 PR을 만들었어요')) return 'pr-already-created';
  if (text.startsWith('로컬 브랜치') && text.includes('이미 없어요')) return 'branch-already-cleaned';
  if (text.startsWith('원격 브랜치') && text.includes('이미 정리됐어요')) return 'remote-branch-already-cleaned';
  return reply;
}

/** Seed a post-push apply-preview anchor (ADR-0040 inert anchor Task) on the context's session. */
async function seedPostPushAnchor(h: Harness, context: ConversationContext, status: ApplyPreviewAnchor['status']) {
  // Open the session deterministically first (the help reply never reaches a provider).
  await h.turn(context, '도움말');
  const session = await h.storage.sessions.findActiveByContext(context.channelId, context.threadId);
  if (!session) throw new Error('session was not opened');
  const projectId = `int1-project-${context.channelId}`;
  const withProject = await h.storage.sessions.save({ ...session, activeProjectId: projectId });
  const anchor = {
    kind: 'code-preview-apply',
    status,
    projectId,
    instruction: 'apply the approved change',
    // The preview's generation — the identity the QA-V2-CL-03 conditional preview discard matches on.
    codeGenerationRef: { id: 'int1-generation', status: 'SUCCEEDED' },
    pushedCommitHash: PUSHED.commitHash,
    pushedRemote: PUSHED.remote,
    pushedBranch: PUSHED.branch,
    pushedUpstreamRef: `origin/${PUSHED.branch}`,
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
  } as unknown as ApplyPreviewAnchor;
  await new StatelessApplyPreviewFlow(h.storage).anchor(withProject, anchor);
}

interface CaseObservation extends TurnObservation {
  readonly context: ConversationContext;
  /** Provider touches made by the case's setup turns (to-do adds, the session-opening help turn). */
  readonly setupProviderTouches: number;
}

let sandboxRepoPath = '';
/** One real, empty sandbox git repository (created once) for `registeredProject` cases. */
function sandboxRepo(): string {
  if (sandboxRepoPath !== '') return sandboxRepoPath;
  const path = join(tempDir, 'sandbox-repo');
  mkdirSync(path, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'int', GIT_AUTHOR_EMAIL: 'int@example.invalid', GIT_COMMITTER_NAME: 'int', GIT_COMMITTER_EMAIL: 'int@example.invalid' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path, env });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: path, env });
  sandboxRepoPath = path;
  return path;
}

/** Run one case in its own fresh context (its own actor, session, to-dos and reminders), applying `ctx` first. */
async function observeCase(golden: { text: string; ctx?: RoutingCtx }): Promise<CaseObservation> {
  const context = harness.freshContext();
  const before = harness.providerCalls() + harness.availabilityProbes();
  for (const title of golden.ctx?.openTodos ?? []) {
    const added = await harness.turn(context, `할 일 추가: ${title}`);
    if (added.route !== 'work-chat.todo') throw new Error(`setup to-do was not added: ${title}`);
  }
  if (golden.ctx?.registeredProject) {
    await harness.turn(context, `이 프로젝트 등록해줘: ${sandboxRepo()}`);
    const session = await harness.storage.sessions.findActiveByContext(context.channelId, context.threadId);
    if (!session?.activeProjectId) throw new Error('setup project was not registered');
  }
  for (const text of golden.ctx?.priorTurns ?? []) await harness.turn(context, text);
  if (golden.ctx?.applyAnchor) await seedPostPushAnchor(harness, context, golden.ctx.applyAnchor);
  const setupProviderTouches = harness.providerCalls() + harness.availabilityProbes() - before;
  return { ...(await harness.turn(context, golden.text)), context, setupProviderTouches };
}

/** Each corpus is sent through the app exactly once; every assertion below reads the same observations. */
const observations = new Map<string, Promise<Map<string, CaseObservation>>>();
function observeSuite(file: GoldenSuiteFile<GoldenCase & { ctx?: RoutingCtx }>): Promise<Map<string, CaseObservation>> {
  let pending = observations.get(file.suite);
  if (!pending) {
    pending = (async () => {
      const byId = new Map<string, CaseObservation>();
      for (const golden of file.cases) byId.set(golden.id, await observeCase(golden));
      return byId;
    })();
    observations.set(file.suite, pending);
  }
  return pending;
}

async function actorIdOf(context: ConversationContext): Promise<string> {
  const actor = await harness.storage.actors.findByExternalIdentity(context.platform, context.userId);
  if (!actor) throw new Error('actor was not resolved');
  return actor.id;
}

/** Everything the composition's console loggers wrote (captured, not printed). */
const logLines: string[] = [];

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
  }
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'quoky-int1-'));
  dbPath = join(tempDir, 'quoky.db');
  prepareMigratedDatabase(dbPath);
  Object.assign(process.env, {
    QUOKY_DISCORD_OWNER_IDS: OWNER_ID,
    QUOKY_DB_PATH: dbPath,
    QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
    QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
    QUOKY_OLLAMA_ENABLED: 'false',
    QUOKY_REMINDERS_ENABLED: 'true',
    QUOKY_TIMEZONE: 'Asia/Seoul',
    // ADR-0110 (CAL-2): a configured calendar (placeholder client and inline refresh token, never sent anywhere: the
    // adapter's read is replaced right after boot and construction makes no network call).
    QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'int-calendar-client',
    QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'int-calendar-client-placeholder',
    QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'int-calendar-refresh-placeholder',
  });
  harness = await boot();
}, 60_000);

afterAll(async () => {
  await closeApp?.();
  process.env = savedEnv;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});


describe('Personal v2 acceptance — migration lane (ADR-0096 D10)', () => {
  it('the migration list is exactly 1..15, contiguous, and LATEST_SCHEMA_VERSION is 15 (v15: ADR-0112 write receipts)', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(15);
  });

  it('a temp DB was migrated 0 → 11, then 12 (feedback), 13 (reminders), 14 (learning) and 15 (write receipts), one version per step', () => {
    expect(migrationSteps).toEqual([
      { from: 0, to: 11, applied: Array.from({ length: 11 }, (_, i) => i + 1) },
      { from: 11, to: 12, applied: [12] },
      { from: 12, to: 13, applied: [13] },
      { from: 13, to: 14, applied: [14] },
      { from: 14, to: 15, applied: [15] },
    ]);
  });

  it('the production storage opened that DB without re-migrating, and it stays at 15 with every v12..v15 table', () => {
    const db = openRawDb(dbPath);
    try {
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(15);
      expect(tableNames(db)).toEqual(expect.arrayContaining([
        'conversation_turns', 'feedback_signals', 'reminders', 'learning_items', 'connector_write_receipts',
      ]));
      // A build that knows only up to 14 refuses the v15 DB (fail closed, never a downgrade).
      type Db = Parameters<typeof runMigrations>[0];
      expect(() => runMigrations(db as unknown as Db, MIGRATIONS.slice(0, 14))).toThrow('SCHEMA_VERSION_AHEAD');
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(15);
    } finally {
      db.close();
    }
  });
});

describe('Personal v2 acceptance — composition (ADR-0096 D2/D5/D7, ADR-0097)', () => {
  it('ConversationRuntimeDeps: the production runtime receives every key of the deps type; the dispatch-boundary baseline is 35', () => {
    // Compile-time exhaustive list of the deps TYPE's keys (adding or removing a key breaks this literal).
    const typeKeys: Record<keyof ConversationRuntimeDeps, true> = {
      dispatchCommit: true, actors: true, sessions: true, memory: true, memoryWriter: true, classifier: true,
      projects: true, analyzer: true, tasks: true, workspace: true, commandExecutions: true, command: true,
      contextBuilder: true, promptComposer: true, promptRenderer: true, router: true, runtimeProviderRouting: true,
      artifacts: true, composer: true, workSurface: true, intentResolver: true, orchestrator: true, approvals: true,
      approvalFlow: true, scopeClarificationFlow: true, applyPreviewFlow: true, codeGeneration: true, patch: true,
      codeProposals: true, workspaceWrite: true, git: true, repositoryHosting: true, turnHandlers: true,
      credentialOverrideFlow: true, connectorWriteFlow: true, logger: true,
    };
    const composed = Object.keys((harness.runtime as unknown as { deps: ConversationRuntimeDeps }).deps).sort();
    expect(composed).toEqual(Object.keys(typeKeys).sort());
    expect(composed).toHaveLength(36);
    // The accepted ADR-0032 M3 / ADR-0096 / ADR-0097 / ADR-0112 baseline (32 → 33 → 34 → 35) counts the
    // dispatch-boundary deps. `runtimeProviderRouting` is the optional offline Stage 2A routing seam (added before the
    // 32 baseline was taken) that the baseline has never counted (conversation-runtime.test.ts asserts 35 without it).
    expect(composed.filter((key) => key !== 'runtimeProviderRouting')).toHaveLength(35);
    expect(composed).toEqual(expect.arrayContaining(['turnHandlers', 'credentialOverrideFlow', 'connectorWriteFlow']));
    // No feature smuggled a dependency in beside `turnHandlers` (ADR-0096 D2: no reminders/feedback/work deps).
    expect(composed.some((key) => /remind|feedback|work(?:Chat|Desk|Summary)|branch/i.test(key))).toBe(false);
  });

  // Ratchet 9 → 10: the runtime model switch adds the `model-selection` handler (ADR-0092 amendment, runtime switching).
  it('registers exactly ten turn handlers in their fixed stage/order (control → post-anchor → pre-classify)', () => {
    expect(harness.handlers).toHaveLength(10);
    expect(new Set(harness.handlers.map((handler) => handler.id)).size).toBe(10);
    const byStage = (harness.runtime as unknown as {
      turnHandlersByStage: Readonly<Record<TurnHandlerStage, readonly ConversationTurnHandler[]>>;
    }).turnHandlersByStage;
    expect(Object.keys(byStage)).toEqual([...TURN_HANDLER_STAGES]);
    const dispatchOrder = TURN_HANDLER_STAGES.flatMap((stage) =>
      byStage[stage].map((handler) => [handler.id, handler.stage, handler.order] as const),
    );
    expect(dispatchOrder).toEqual(EXPECTED_REGISTRY);
  });

  it('help lists every contributed line verbatim, in registry order, within 14 lines × 120 characters (CWR-2 raised 12 → 14)', async () => {
    const contributed = (harness.runtime as unknown as { contributedHelpLines: readonly string[] }).contributedHelpLines;
    const registered = EXPECTED_REGISTRY.flatMap(([id]) => harness.handlers.find((h) => h.id === id)?.helpLines ?? []);
    expect(contributed).toEqual(registered);
    // Every handler contributes at least one line (reminders are enabled here, so their two "on" lines).
    for (const handler of harness.handlers) expect(handler.helpLines?.length ?? 0, handler.id).toBeGreaterThan(0);
    expect(contributed.length).toBeGreaterThan(0);
    expect(contributed.length).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINES);
    for (const line of contributed) {
      expect(Array.from(line).length, line).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINE_CHARS);
      expect(line, line).not.toMatch(/\n/);
    }

    const help = await harness.turn(harness.freshContext(), '도움말');
    expect(help.route).toBe('runtime');
    expect(help.providerCalls + help.availabilityProbes).toBe(0);
    const lines = help.text.split('\n');
    // Nothing was truncated or dropped: each line appears whole, contiguous and in order, and no line ends in "…".
    const first = lines.indexOf(contributed[0] as string);
    expect(first).toBeGreaterThan(0);
    expect(lines.slice(first, first + contributed.length)).toEqual([...contributed]);
    expect(help.text).not.toContain('…');
    expect(help.text.length).toBeLessThanOrEqual(2000);
  });

  it('truncation check: the composer cuts an over-long contributed line to 120 chars and keeps at most 12 lines', () => {
    const context = harness.freshContext();
    const contributed = (harness.runtime as unknown as { contributedHelpLines: readonly string[] }).contributedHelpLines;
    const overLong = `- ${'가'.repeat(200)}`;
    const extras = Array.from({ length: 13 }, (_, i) => `- extra help line ${i + 1}`);
    const text = harness.composer.composeHelp(context, [overLong, ...contributed, ...extras]).text;
    const lines = text.split('\n');
    const cut = lines.find((line) => line.startsWith('- 가'));
    expect(cut).toBeDefined();
    expect(Array.from(cut as string)).toHaveLength(MAX_CONTRIBUTED_HELP_LINE_CHARS);
    expect(cut?.endsWith('…')).toBe(true);
    // Registry order is kept and only the first 12 bounded lines survive: the cut line, the real lines, then
    // extras up to the cap; the rest are dropped (never wrapped onto the next line, never reordered).
    // CAL-2: the real lines now fill the 12-line budget exactly, so the cut line pushes the last real line out too.
    const offered = [cut as string, ...contributed, ...extras];
    const shown = offered.slice(0, MAX_CONTRIBUTED_HELP_LINES);
    const first = lines.indexOf(cut as string);
    expect(lines.slice(first, first + MAX_CONTRIBUTED_HELP_LINES)).toEqual(shown);
    for (const dropped of offered.slice(MAX_CONTRIBUTED_HELP_LINES)) expect(lines).not.toContain(dropped);
  });
});

describe('Personal v2 acceptance — deterministic turns never reach a provider', () => {
  it('every deterministic routing case made zero provider calls and zero availability probes (setup included)', async () => {
    const byId = await observeSuite(routing);
    // W3-L01: a `classifier` case pinned to `providerCalls: 0` is a deterministic chat-path reply (own-memory no hit).
    const deterministic = routing.cases.filter(
      (golden) => golden.expected.route !== 'classifier' || golden.expected.providerCalls === 0,
    );
    expect(deterministic.length).toBeGreaterThan(30);
    for (const golden of deterministic) {
      const seen = byId.get(golden.id) as CaseObservation;
      expect(seen.providerCalls + seen.availabilityProbes, `${golden.id} ${golden.text}`).toBe(0);
      expect(seen.setupProviderTouches, `${golden.id} setup`).toBe(0);
      expect(seen.text, golden.id).not.toBe(STUB_REPLY);
    }
  });

  it('positive control: a fall-through turn does reach the (stubbed) provider, so the counter is live', async () => {
    const byId = await observeSuite(routing);
    const fallThrough = routing.cases.filter(
      (golden) => golden.expected.route === 'classifier' && golden.expected.providerCalls !== 0,
    );
    expect(fallThrough.length).toBeGreaterThan(0);
    for (const golden of fallThrough) {
      const seen = byId.get(golden.id) as CaseObservation;
      expect(seen.providerCalls, `${golden.id} ${golden.text}`).toBeGreaterThan(0);
      expect(seen.text, golden.id).toBe(STUB_REPLY);
    }
  });

  it('every precedence case except ordinary chat stays provider-free', async () => {
    const byId = await observeSuite(precedence);
    for (const golden of precedence.cases.filter((c) => c.expected.handler !== 'none')) {
      const seen = byId.get(golden.id) as CaseObservation;
      expect(seen.providerCalls + seen.availabilityProbes, `${golden.id} ${golden.text}`).toBe(0);
    }
  });
});

describe('Personal v2 acceptance — ADR-0100 D1 anchored-prefix precedence (to-do beats reminder)', () => {
  it('"할 일 추가: 내일 9시에 회의 알려줘" adds a to-do titled with the whole body and creates no reminder', async () => {
    const context = harness.freshContext();
    const seen = await harness.turn(context, '할 일 추가: 내일 9시에 회의 알려줘');
    expect(seen).toMatchObject({ route: 'work-chat.todo', kind: 'todo.add', providerCalls: 0 });
    expect(seen.text).toContain('할 일을 추가했어요: "내일 9시에 회의 알려줘"');
    const actorId = await actorIdOf(context);
    expect((await harness.storage.workItems.listByActor(actorId)).map((item) => item.title)).toEqual([
      '내일 9시에 회의 알려줘',
    ]);
    expect(await harness.storage.reminders.listActiveByActor(actorId)).toEqual([]);
  });

  it.each(ANCHORED_TODO_HEADS)('"%s: 내일 9시에 회의 알려줘" is claimed by the to-do handler, never by reminders', async (head) => {
    const golden = precedence.cases.find((c) => c.text === `${head}: 내일 9시에 회의 알려줘`);
    expect(golden, `precedence corpus pins head ${head}`).toBeDefined();
    const seen = (await observeSuite(precedence)).get((golden as PrecedenceCase).id) as CaseObservation;
    expect(seen.route).toBe('work-chat.todo');
    expect(seen.handler).toBe('work-chat.mutation');
    expect(seen.providerCalls).toBe(0);
    expect(await harness.storage.reminders.listActiveByActor(await actorIdOf(seen.context))).toEqual([]);
  });

  it('the same body without an anchored head is a reminder (and stores no to-do)', async () => {
    const context = harness.freshContext();
    const seen = await harness.turn(context, '내일 9시에 회의 알려줘');
    expect(seen).toMatchObject({ route: 'reminders', providerCalls: 0 });
    const actorId = await actorIdOf(context);
    expect(await harness.storage.reminders.listActiveByActor(actorId)).toHaveLength(1);
    expect(await harness.storage.workItems.listByActor(actorId)).toEqual([]);
  });
});

describe('Personal v2 acceptance — golden turn-handler routing ratchet (ADR-0098 D7)', () => {
  it.each([
    ['turn-handler-routing', routing],
    ['reminder-todo-precedence', precedence],
  ] as const)('%s: well formed, every case mustPass, scored against the production composition', async (name, file) => {
    expect(file.suite).toBe(name);
    expect(file.version).toBe(1);
    expect(validateGoldenCases(file.cases)).toEqual([]);
    expect(file.cases.every((golden) => golden.mustPass)).toBe(true);
    expect(file.cases.some((golden) => 'pending' in golden || 'blockedBy' in golden)).toBe(false);

    const byId = await observeSuite(file as GoldenSuiteFile<GoldenCase & { ctx?: RoutingCtx }>);
    const result = await evaluateGoldenSuiteAsync(
      file.cases as readonly GoldenCase[],
      async (golden) => {
        const { context: _context, text: _text, setupProviderTouches: _setup, ...observed } = byId.get(golden.id) as CaseObservation;
        return observed;
      },
      file.suite,
    );
    console.info(formatGoldenSummary(result));
    expect(mustPassFailures(result), `${name} mustPass failures`).toEqual([]);
    expect(ratchetViolations(result, baseline.suites[name]), name).toEqual([]);
  });

  it('the composition logs stay content-free: no to-do title, reminder body or stub reply in any log line', async () => {
    await observeSuite(routing);
    await observeSuite(precedence);
    expect(logLines.length).toBeGreaterThan(0);
    const logs = logLines.join('\n');
    for (const content of ['주간 보고서 쓰기', '스트레칭', '내일 9시에 회의', STUB_REPLY]) expect(logs).not.toContain(content);
  });

  it('pins the wave-7 live-QA fixes so they cannot regress', () => {
    const route = (text: string, ctx?: RoutingCtx) =>
      routing.cases.find((c) => c.text === text && JSON.stringify(c.ctx ?? null) === JSON.stringify(ctx ?? null))?.expected;
    const todo = { openTodos: ['주간 보고서 쓰기'] };
    for (const status of ['PR_APPROVED', 'PR_CREATED', 'PR_MERGED', 'MAIN_SYNCED'] as const) {
      expect(route('푸시 실행', { applyAnchor: status }), status).toEqual({ route: 'runtime', reply: 'push-already-pushed', providerCalls: 0 });
      expect(route('강제 푸시해줘', { applyAnchor: status }), status).toEqual({ route: 'runtime', reply: 'push-unsupported', providerCalls: 0 });
    }
    expect(route('주간 보고서 쓰기 완료', todo)).toMatchObject({ route: 'work-chat.todo', kind: 'todo.hint', providerCalls: 0 });
    expect(route('주간 보고서 쓰기 완료했나?', todo)).toMatchObject({ route: 'work-chat.todo', kind: 'todo.status', providerCalls: 0 });
    // ADR-0104 D4: the W7-06 how-to question is now answered by the help-intent handler (it fell through to chat in v2).
    expect(route('완료 처리 어떻게 해?')).toEqual({ route: 'help-intent', providerCalls: 0 });
    expect(route('완료 처리 어떻게 해?', todo)).toEqual({ route: 'help-intent', providerCalls: 0 });
  });
});

describe('Personal v3 DET-1 — action-shaped fall-through corpus (ADR-0104 D6)', () => {
  const turnCases = () => actionShaped.cases.filter((c): c is Extract<ActionShapedCase, { kind: 'turn' }> => c.kind === 'turn');

  it('scores every case against the production composition and the baseline ratchet', async () => {
    expect(actionShaped.suite).toBe('action-shaped-fallthrough');
    expect(validateGoldenCases(actionShaped.cases)).toEqual([]);
    expect(actionShaped.cases.every((golden) => golden.mustPass)).toBe(true);
    const byId = await observeSuite(
      { ...actionShaped, cases: turnCases() } as unknown as GoldenSuiteFile<GoldenCase & { ctx?: RoutingCtx }>,
    );
    const result = await evaluateGoldenSuiteAsync(
      actionShaped.cases as readonly GoldenCase[],
      async (golden) => {
        const c = golden as ActionShapedCase;
        if (c.kind === 'guard') {
          const guarded = guardInternalActionClaims(c.text, c.userText, generalChatReplyPolicy(c.userText));
          return guarded.guarded ? { guarded: true, domain: guarded.domain } : { guarded: false };
        }
        const { context: _context, text, setupProviderTouches: _setup, reply, ...observed } = byId.get(c.id) as CaseObservation;
        const label = actionShapedReplyLabel(reply, text);
        return { ...observed, ...(label === undefined ? {} : { reply: label }) };
      },
      actionShaped.suite,
    );
    console.info(formatGoldenSummary(result));
    expect(mustPassFailures(result), 'action-shaped-fallthrough mustPass failures').toEqual([]);
    expect(ratchetViolations(result, baseline.suites[actionShaped.suite]), actionShaped.suite).toEqual([]);
  });

  it('every deterministic turn case made zero provider calls and probes; chat cases still reach the provider', async () => {
    const byId = await observeSuite(
      { ...actionShaped, cases: turnCases() } as unknown as GoldenSuiteFile<GoldenCase & { ctx?: RoutingCtx }>,
    );
    for (const golden of turnCases()) {
      const seen = byId.get(golden.id) as CaseObservation;
      if (golden.expected.route === 'classifier' && golden.expected.providerCalls !== 0) {
        expect(seen.providerCalls, `${golden.id} ${golden.text}`).toBeGreaterThan(0);
        continue;
      }
      expect(seen.providerCalls + seen.availabilityProbes, `${golden.id} ${golden.text}`).toBe(0);
      expect(seen.setupProviderTouches, `${golden.id} setup`).toBe(0);
    }
  });

  it('the guard replaces a chat reply that claims a Quoky action end-to-end, whichever provider answered', async () => {
    const cases = [
      ['그 브랜치 어떻게 됐어', '네, 브랜치가 삭제된 상태가 맞습니다.', '이 답변으로 실행된 작업은 없어요. Quoky는 브랜치를'],
      ['나 고양이 키워. 이름은 나비야', '말씀하신 내용을 기억해 둘게요.', '이 답변으로 실행된 작업은 없어요. Quoky는 기억을'],
      ['tell me about my cat Nabi', "Got it, I'll save that to my memory.", 'Nothing was done by this reply'],
    ] as const;
    try {
      for (const [user, claim, notice] of cases) {
        stubReply = claim;
        const seen = await harness.turn(harness.freshContext(), user);
        expect(seen.route, user).toBe('classifier');
        expect(seen.providerCalls, user).toBe(1);
        expect(seen.text.startsWith(notice), `${user} → ${seen.text}`).toBe(true);
        expect(seen.text).not.toContain(claim);
      }
      // A claim-free reply passes through unchanged.
      stubReply = STUB_REPLY;
      expect((await harness.turn(harness.freshContext(), '안녕')).text).toBe(STUB_REPLY);
    } finally {
      stubReply = STUB_REPLY;
    }
  });
});

describe('Personal v3 wave 1 — help intent (ADR-0104 D4, LLM-1 module registered at order 400)', () => {
  const KO_HEAD = 'Quoky에서는 이렇게 하면 돼요.';
  const KO_FOOT = '전체 안내는 "도움말"이라고 보내 주세요.';
  const EN_HEAD = 'Here is how to do that in Quoky (the commands are in Korean):';
  const EN_FOOT = 'Send "/help" for the full guide.';
  /** Generic how-to questions and ordinary chat the help-intent handler must never hijack (pinned in the corpus). */
  const NOT_HIJACKED = [
    'git 브랜치 어떻게 만들어?',
    '파이썬 리스트 정렬 어떻게 해?',
    '아이폰 알림 어떻게 꺼?',
    '알림 소리 어떻게 바꿔?',
    '슬랙 어떻게 써?',
    '할 일 관리 잘하는 법',
    'how do I reverse a list in python?',
    '오늘 점심 뭐 먹을까?',
  ] as const;

  it('how-to questions are answered by the help-intent handler from the contributed lines, with zero provider calls', async () => {
    const byId = await observeSuite(routing);
    const helpCases = routing.cases.filter((golden) => golden.expected.route === 'help-intent');
    expect(helpCases.length).toBeGreaterThanOrEqual(10);
    const contributed = (harness.runtime as unknown as { contributedHelpLines: readonly string[] }).contributedHelpLines;
    const own = harness.handlers.find((handler) => handler.id === 'help-intent')?.helpLines ?? [];
    expect(own.length).toBeGreaterThan(0);
    // DET-2: a capability question ("뭐 할 수 있어?") is answered with exactly the "도움말" reply (quickstart).
    const fullHelp = (await harness.turn(harness.freshContext(), '도움말')).text;
    expect(helpCases.filter((golden) => detectCapabilityQuestion(golden.text) !== null).length).toBeGreaterThanOrEqual(5);
    for (const golden of helpCases) {
      const seen = byId.get(golden.id) as CaseObservation;
      const label = `${golden.id} ${golden.text}`;
      expect(seen.route, label).toBe('help-intent');
      expect(seen.providerCalls + seen.availabilityProbes, label).toBe(0);
      expect(seen.setupProviderTouches, `${label} setup`).toBe(0);
      if (detectCapabilityQuestion(golden.text) !== null) {
        expect(seen.text, label).toBe(fullHelp);
        continue;
      }
      const lines = seen.text.split('\n');
      const english = lines[0] === EN_HEAD;
      expect(lines[0], label).toBe(english ? EN_HEAD : KO_HEAD);
      expect(lines.at(-1), label).toBe(english ? EN_FOOT : KO_FOOT);
      const answered = lines.slice(1, -1);
      expect(answered.length, label).toBeGreaterThan(0);
      // A filtered subset of the full help reply (ADR-0093 note): every line verbatim, never the handler's own line.
      for (const line of answered) {
        expect(contributed, `${label}: ${line}`).toContain(line);
        expect(own, `${label}: ${line}`).not.toContain(line);
      }
    }
  });

  it('the W7-06 question names the completion command, with or without an open to-do, and mutates nothing', async () => {
    const byId = await observeSuite(routing);
    for (const id of ['route-021', 'route-022']) {
      const seen = byId.get(id) as CaseObservation;
      expect(seen.route, id).toBe('help-intent');
      expect(seen.text, id).toContain('"완료 처리: 번호"');
    }
    const withTodo = byId.get('route-022') as CaseObservation;
    const items = await harness.storage.workItems.listByActor(await actorIdOf(withTodo.context));
    expect(items.map((item) => [item.title, item.status])).toEqual([['주간 보고서 쓰기', 'ACTIVE']]);
  });

  it('ordinary chat and generic how-to questions are not hijacked: they reach the classifier and the provider', async () => {
    const byId = await observeSuite(routing);
    for (const text of NOT_HIJACKED) {
      const golden = routing.cases.find((c) => c.text === text && c.ctx === undefined);
      expect(golden, `routing corpus pins "${text}"`).toBeDefined();
      expect(golden?.expected).toEqual({ route: 'classifier' });
      const seen = byId.get((golden as RoutingCase).id) as CaseObservation;
      expect(seen.route, text).toBe('classifier');
      expect(seen.providerCalls, text).toBeGreaterThan(0);
      expect(seen.text, text).toBe(STUB_REPLY);
    }
  });

  it('the full help reply still lists every contributed line, including the help-intent line', async () => {
    const own = harness.handlers.find((handler) => handler.id === 'help-intent')?.helpLines ?? [];
    const help = await harness.turn(harness.freshContext(), '도움말');
    expect(help.route).toBe('runtime');
    for (const line of own) expect(help.text.split('\n')).toContain(line);
  });
});

describe('Personal v3 wave 1 — live QA W1-L01 / W1-L03 with a registered project', () => {
  const PROJECT = { registeredProject: true };
  const CLARIFYING = { registeredProject: true, priorTurns: ['로그인 버그 고쳐줘'] };
  const route = (text: string, ctx?: RoutingCtx) =>
    routing.cases.find((c) => c.text === text && JSON.stringify(c.ctx ?? null) === JSON.stringify(ctx ?? null));

  it('the corpus pins the registered-project cases', () => {
    expect(route('완료 처리 어떻게 해?', PROJECT)?.expected).toEqual({ route: 'help-intent', providerCalls: 0 });
    expect(route('완료 처리 어떻게 해?', CLARIFYING)?.expected).toEqual({ route: 'help-intent', providerCalls: 0 });
    expect(route('알림 어떻게 지워?', CLARIFYING)?.expected).toEqual({ route: 'help-intent', providerCalls: 0 });
    expect(route('git commit 은 어떻게 하는 거야?')?.expected).toEqual({ route: 'classifier' });
    expect(route('git commit 은 어떻게 하는 거야?', CLARIFYING)?.expected).toEqual({ route: 'classifier' });
  });

  it('W1-L01: a how-to question right after a code-change clarification reaches the help-intent handler', async () => {
    const byId = await observeSuite(routing);
    const golden = route('완료 처리 어떻게 해?', CLARIFYING) as RoutingCase;
    const seen = byId.get(golden.id) as CaseObservation;
    expect(seen.route).toBe('help-intent');
    expect(seen.text).toContain('"완료 처리: 번호"');
    expect(seen.text).not.toContain('수정할 파일 경로와 함께');
    // The registered project was really active for the case.
    const session = await harness.storage.sessions.findActiveByContext(seen.context.channelId, seen.context.threadId);
    expect(session?.activeProjectId).toBeTruthy();
  });

  it('W1-L03: a git-commit how-to question is ordinary chat, never the commit-unavailable reply or an internal state name', async () => {
    const byId = await observeSuite(routing);
    for (const ctx of [undefined, CLARIFYING]) {
      const golden = route('git commit 은 어떻게 하는 거야?', ctx) as RoutingCase;
      const seen = byId.get(golden.id) as CaseObservation;
      expect(seen.route, golden.id).toBe('classifier');
      expect(seen.text, golden.id).toBe(STUB_REPLY);
      expect(seen.text, golden.id).not.toMatch(/WORKSPACE_APPLIED|커밋 승인을 준비할 수 없어요|수정할 파일 경로와 함께/u);
    }
  });
});

describe('Personal v3 LRN-1 — owner learning commands end to end (ADR-0107 D1/D3, offline)', () => {
  const CREDENTIAL = '비밀번호는 hunter2-secret 이야';

  it('lists a 👎 turn, saves an owner note only on command, refuses a credential, and adds the 👎-rate trend', async () => {
    const context = harness.freshContext();
    const providerBefore = harness.providerCalls() + harness.availabilityProbes();
    const empty = await harness.turn(context, '피드백 후보');
    expect(empty.route).toBe('feedback.learning');
    expect(empty.text).toContain('👍/👎를 남긴 답변이 없어요');
    const actorId = await actorIdOf(context);

    // Seed one rated work turn the way capture stores it: a Task (the request text) and a content-free turn + 👎.
    const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await harness.storage.tasks.save({
      id: 'lrn-task-1', title: 'chat', description: '내일 회의 몇 시야?', status: TaskStatus.COMPLETED,
      intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' },
      riskLevel: RiskLevel.LOW, context, actorId, createdAt: at, updatedAt: at,
    } as Task);
    await harness.storage.feedback.saveTurn({
      id: 'lrn-turn-1', actorId, platform: context.platform, channelId: context.channelId, inboundMessageId: 'lrn-in-1',
      platformUserId: context.userId, status: 'RESPONDED', createdAt: at, latencyMs: 10, replyChars: 20,
      intentType: IntentType.CHAT, capability: Capability.GENERAL_CHAT, taskId: 'lrn-task-1', requestFingerprint: [],
      platformMessageIds: ['lrn-out-1'],
    });
    await harness.storage.feedback.upsertSignal({
      id: 'lrn-sig-1', turnId: 'lrn-turn-1', kind: FeedbackSignalKind.EXPLICIT_RATING, source: 'REACTION',
      sourceKey: `${context.userId}:NEGATIVE`, value: 'NEGATIVE', createdAt: at, updatedAt: at,
    });

    const listing = await harness.turn(context, '피드백 후보');
    expect(listing.route).toBe('feedback.learning');
    expect(listing.text).toContain('1. ');
    expect(listing.text).toContain('👎 · 일반 대화 · "내일 회의 몇 시야?"');
    const list = () => harness.storage.learning.list({
      actorId, kind: LearningItemKind.GOLDEN_CANDIDATE, now: new Date().toISOString(), limit: 10,
    });
    expect(await list()).toEqual([]);

    const refused = await harness.turn(context, `후보 1 메모: ${CREDENTIAL}`);
    expect(refused.route).toBe('feedback.learning');
    expect(refused.text).toContain('저장하지 않았어요');
    expect(await list()).toEqual([]);

    const saved = await harness.turn(context, '후보 1 메모: 회의 시간 대신 날씨를 답했어');
    expect(saved.route).toBe('feedback.learning');
    expect(saved.text).toContain('학습 후보로 저장했어요');
    const items = await list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actorId, sourceTurnId: 'lrn-turn-1', egress: 'LOCAL_ONLY', capability: Capability.GENERAL_CHAT,
      data: { requestText: '내일 회의 몇 시야?', note: '회의 시간 대신 날씨를 답했어', sourceRating: 'NEGATIVE' },
    });

    const summary = await harness.turn(context, '피드백 요약');
    expect(summary.route).toBe('feedback.summary');
    expect(summary.text).toContain('👎 비율 추이(최근 30일 · 이전 30일):');
    expect(summary.text).toContain('- 일반 대화: 100% (👎 1/1) · 이전 - · 비교 불가');

    // Every learning turn was deterministic: no provider call and no availability probe.
    expect(harness.providerCalls() + harness.availabilityProbes()).toBe(providerBefore);
  });

  it('example commands work only from a fresh listing, and 예시 N 삭제 removes exactly that row', async () => {
    const context = harness.freshContext();
    expect((await harness.turn(context, '예시 1 삭제')).text).toContain('먼저 "예시 목록"');
    const listing = await harness.turn(context, '예시 목록');
    expect(listing.route).toBe('feedback.learning');
    expect(listing.text).toContain('저장된 예시가 없어요');
  });
});

describe('Personal v3 MEM-1 — memory management commands end to end (ADR-0106)', () => {
  const codeIn = (text: string): string => /기억 확인 ([A-Z0-9]{4})/u.exec(text)?.[1] ?? '';
  // Listing numbers follow `createdAt` (ms) with an id tie-break; a pause keeps consecutive saves in save order.
  const nextMs = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const recall = async (actorId: string, query: string): Promise<string[]> => {
    const retriever = new DefaultMemoryRetriever(harness.storage.memories);
    const results = await retriever.retrieve(
      createMemoryRetrievalRequest({
        query,
        capability: Capability.GENERAL_CHAT,
        scope: { actorId },
        authorityFitness: ['USER_CLAIM_OR_INTENT'],
        maxResults: 10,
      }),
    );
    return results.map((result) => result.memory.content);
  };
  const recallTask = (context: ConversationContext, actorId: string, sessionId: string, summary: string): Task => ({
    id: `recall-task-${sessionId}`,
    title: 'recall check',
    description: '',
    status: TaskStatus.PENDING,
    intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: true, summary },
    riskLevel: RiskLevel.LOW,
    context,
    actorId,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Every piece of the provider's context that carries `fragment`: transcript turns, durable recall, context-file lines.
  const providerViewOf = async (task: Task, fragment: string): Promise<string[]> => {
    const bundle = await harness.contextBuilder.build(task);
    const files = await harness.memory.buildContextFiles(task);
    return [
      ...bundle.conversationTranscript.map((entry) => entry.content),
      ...(bundle.durableRecall ?? []).map((entry) => entry.content),
      ...files.flatMap((file) => file.content.split('\n')),
    ].filter((piece) => piece.includes(fragment));
  };

  it('list → forget (stale and foreign codes change nothing) → recall check → edit → recall check, provider-free', async () => {
    const owner = harness.freshContext();
    const other = harness.freshContext();
    const providerBefore = harness.providerCalls() + harness.availabilityProbes();
    expect((await harness.turn(owner, '기억해: 커피는 아메리카노')).reply).toBe('memory-stored');
    await nextMs();
    expect((await harness.turn(owner, '기억해: 주간 회의는 화요일')).reply).toBe('memory-stored');
    expect((await harness.turn(other, '기억해: 다른 사람의 메모')).reply).toBe('memory-stored');
    const ownerId = await actorIdOf(owner);
    const otherId = await actorIdOf(other);

    const listed = await harness.turn(owner, '기억 목록');
    expect(listed.route).toBe('memory-commands');
    expect(listed.text).toContain('1. 커피는 아메리카노');
    expect(listed.text).toContain('2. 주간 회의는 화요일');
    expect(listed.text).not.toContain('다른 사람');
    expect(listed.text).toContain('저장된 기억 2개 중');

    // Forget #1: a wrong code and another actor's use of the right code change nothing.
    const ask = await harness.turn(owner, '기억 1 잊어줘');
    expect(ask.text).toContain('> 커피는 아메리카노');
    const code = codeIn(ask.text);
    expect(code).toMatch(/^[A-Z0-9]{4}$/u);
    const wrong = await harness.turn(owner, `기억 확인 ${code === 'AAAA' ? 'BBBB' : 'AAAA'}`);
    expect(wrong.text).toContain('아무것도 바뀌지 않았어요');
    expect((await harness.turn(other, `기억 확인 ${code}`)).text).toContain('아무것도 바뀌지 않았어요');
    expect(await recall(ownerId, '커피 아메리카노')).toContain('커피는 아메리카노');

    const forgotten = await harness.turn(owner, `기억 확인 ${code}`);
    expect(forgotten).toMatchObject({ route: 'memory-commands', providerCalls: 0 });
    expect(forgotten.text).toContain('이 기억을 잊었어요');
    expect(await recall(ownerId, '커피 아메리카노')).not.toContain('커피는 아메리카노');
    const remaining = await harness.storage.memories.findDurableCandidates({ scope: { userId: ownerId }, limit: 50 });
    expect(remaining.map((record) => record.content)).toEqual(['주간 회의는 화요일']);
    // The code was one-time.
    expect((await harness.turn(owner, `기억 확인 ${code}`)).text).toContain('아무것도 바뀌지 않았어요');

    // Edit #1 ("주간 회의는 화요일" after the shift): a credential-shaped edit is refused, then a real edit supersedes.
    const secret = await harness.turn(owner, '기억 1 수정: password = hunter2hunter2');
    expect(secret.text).toContain('민감한 정보');
    expect(secret.text).not.toMatch(/기억 확인 [A-Z0-9]{4}/u);
    const editAsk = await harness.turn(owner, '기억 1 수정: 주간 회의는 수요일');
    expect(editAsk.text).toContain('지금: 주간 회의는 화요일');
    const edited = await harness.turn(owner, `기억 확인 ${codeIn(editAsk.text)}`);
    expect(edited.text).toContain('기억을 바꿨어요');
    expect(await recall(ownerId, '주간 회의')).toEqual(['주간 회의는 수요일']);
    expect((await harness.turn(owner, '기억 목록')).text).toContain('1. 주간 회의는 수요일');

    // The other actor's memory was never listed, counted or changed.
    expect(await recall(otherId, '다른 사람 메모')).toEqual(['다른 사람의 메모']);
    expect((await harness.turn(other, '기억 목록')).text).toContain('1. 다른 사람의 메모');
    expect(harness.providerCalls() + harness.availabilityProbes() - providerBefore).toBe(0);
  });

  it('forget also removes the memory\'s cached vector (ADR-0098 D8 cache, ADR-0106 D5)', async () => {
    const owner = harness.freshContext();
    await harness.turn(owner, '기억해: 벡터로도 저장된 기억');
    const [record] = await harness.storage.memories.findDurableCandidates({
      scope: { userId: await actorIdOf(owner) },
      limit: 5,
    });
    if (!record) throw new Error('memory was not saved');
    await harness.vectors.upsert(DURABLE_MEMORY_VECTOR_COLLECTION, [{ id: record.id, vector: [1, 0, 0] }]);
    const ids = async () => (await harness.vectors.query(DURABLE_MEMORY_VECTOR_COLLECTION, [1, 0, 0], 100)).map((r) => r.id);
    expect(await ids()).toContain(record.id);
    const ask = await harness.turn(owner, '기억 1 잊어줘');
    await harness.turn(owner, `기억 확인 ${codeIn(ask.text)}`);
    expect(await ids()).not.toContain(record.id);
    // ADR-0106 amendment: the record itself is archived (restorable), its vector is gone at archive time.
    expect(isArchivedMemory((await harness.storage.memories.get(record.id)) ?? {})).toBe(true);
  });

  it('forget and edit remove the learning items derived from the memory, actor-scoped (ADR-0106 D5, ADR-0107 D7)', async () => {
    const owner = harness.freshContext();
    const other = harness.freshContext();
    const providerBefore = harness.providerCalls() + harness.availabilityProbes();
    await harness.turn(owner, '기억해: 학습 연쇄 삭제용 기억');
    await nextMs();
    await harness.turn(owner, '기억해: 학습 연쇄 수정용 기억');
    await harness.turn(other, '기억 목록'); // resolves the other actor (no memory of its own)
    const ownerId = await actorIdOf(owner);
    const otherId = await actorIdOf(other);
    const records = await harness.storage.memories.findDurableCandidates({ scope: { userId: ownerId }, limit: 10 });
    const byContent = (content: string) => {
      const found = records.find((record) => record.content === content);
      if (!found) throw new Error(`memory was not saved: ${content}`);
      return found;
    };
    const forgetMe = byContent('학습 연쇄 삭제용 기억');
    const editMe = byContent('학습 연쇄 수정용 기억');

    const now = new Date();
    const learningItem = (id: string, actorId: string, sourceMemoryId: string | undefined) => ({
      id, actorId, kind: LearningItemKind.EXAMPLE, capability: Capability.GENERAL_CHAT, language: 'ko' as const,
      ...(sourceMemoryId === undefined ? {} : { sourceMemoryId }),
      egress: 'LOCAL_ONLY' as const, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      data: { requestText: '학습 예시 요청', idealAnswer: '학습 예시 답변', sourceRating: 'POSITIVE' as const },
    });
    for (const item of [
      learningItem('lrn-cascade-forget', ownerId, forgetMe.id),
      learningItem('lrn-cascade-edit', ownerId, editMe.id),
      learningItem('lrn-cascade-unrelated', ownerId, undefined),
      // Another actor's row naming the same memory id is never touched (deletes are owner-scoped).
      learningItem('lrn-cascade-foreign', otherId, forgetMe.id),
    ]) {
      expect(await harness.storage.learning.insertWithinCap(item, 1000, now.toISOString())).toBe('INSERTED');
    }
    const ids = async (actorId: string) =>
      (await harness.storage.learning.list({ actorId, kind: LearningItemKind.EXAMPLE, now: new Date().toISOString(), limit: 50 }))
        .map((item) => item.id)
        .sort();
    expect(await ids(ownerId)).toEqual(['lrn-cascade-edit', 'lrn-cascade-forget', 'lrn-cascade-unrelated']);

    // Saved order: 1 = the forget target, 2 = the edit target (which becomes 1 after the forget shifts the list).
    const listed = await harness.turn(owner, '기억 목록');
    expect(listed.text).toContain('1. 학습 연쇄 삭제용 기억');
    expect(listed.text).toContain('2. 학습 연쇄 수정용 기억');

    const forgetAsk = await harness.turn(owner, '기억 1 잊어줘');
    expect(forgetAsk.text).toContain('> 학습 연쇄 삭제용 기억');
    expect((await harness.turn(owner, `기억 확인 ${codeIn(forgetAsk.text)}`)).text).toContain('이 기억을 잊었어요');
    expect(isArchivedMemory((await harness.storage.memories.get(forgetMe.id)) ?? {})).toBe(true);
    expect(await ids(ownerId)).toEqual(['lrn-cascade-edit', 'lrn-cascade-unrelated']);
    expect(await ids(otherId)).toEqual(['lrn-cascade-foreign']);

    const editAsk = await harness.turn(owner, '기억 1 수정: 학습 연쇄 수정된 기억');
    expect(editAsk.text).toContain('지금: 학습 연쇄 수정용 기억');
    expect((await harness.turn(owner, `기억 확인 ${codeIn(editAsk.text)}`)).text).toContain('기억을 바꿨어요');
    expect(await ids(ownerId)).toEqual(['lrn-cascade-unrelated']);
    expect(await ids(otherId)).toEqual(['lrn-cascade-foreign']);
    expect(harness.providerCalls() + harness.availabilityProbes() - providerBefore).toBe(0);
  });

  it('W2-L01: edit and forget purge the actor\'s history copies in other sessions and clear the current session; another user\'s turns stay', async () => {
    const owner = harness.freshContext();
    // The owner's second conversation (another channel = another session) quotes the text in ordinary chat.
    const ownerElsewhere: ConversationContext = { ...harness.freshContext(), userId: owner.userId };
    // Another user in the SAME channel shares the owner's session: actor isolation inside one conversation.
    const other: ConversationContext = { ...harness.freshContext(), channelId: owner.channelId };
    const oldText = '내가 제일 좋아하는 커피는 따뜻한 라떼야';
    const newText = '내가 제일 좋아하는 커피는 아이스 아메리카노야';
    const ownerHistory = async () =>
      (await harness.storage.memories.findShortTermByUser(owner.userId)).map((record) => record.content);
    const carries = (rows: readonly string[], fragment: string) => rows.filter((row) => row.includes(fragment));

    await harness.turn(owner, `기억해: ${oldText}`);
    await harness.turn(ownerElsewhere, `참고로 ${newText}`); // ordinary chat in another session quotes the text
    await harness.turn(other, `${newText} 나도 그래`); // the other user's turn in the owner's session
    const session = await harness.storage.sessions.findActiveByContext(owner.channelId);
    if (!session) throw new Error('session was not opened');
    const ownerId = await actorIdOf(owner);
    const task = recallTask(owner, ownerId, session.id, '내가 좋아하는 커피가 뭐였지?');
    const providerView = (fragment: string) => providerViewOf(task, fragment);
    // The live precondition: the conversation history carries both texts.
    expect(carries(await ownerHistory(), '라떼')).not.toEqual([]);
    expect(carries(await ownerHistory(), '아이스 아메리카노')).toEqual([`참고로 ${newText}`]);

    // Edit: the superseded text leaves the owner's history; the current session's owner turns are cleared.
    const editAsk = await harness.turn(owner, `기억 1 수정: ${newText}`);
    expect(editAsk.text).toContain('지금: 내가 제일 좋아하는 커피는 따뜻한 라떼야'); // the reply copy is unchanged
    const edited = await harness.turn(owner, `기억 확인 ${codeIn(editAsk.text)}`);
    expect(edited.text).toContain('기억을 바꿨어요');
    expect(edited.text.split('\n').at(-1)).toBe('이번 대화 기록도 비웠어요.');
    let history = await ownerHistory();
    expect(carries(history, '라떼')).toEqual([]);
    // Left: the other session's turns (its quote of the CURRENT memory and the stub answer to it), and the
    // content-free note of the edit result; every other owner turn of the current session was cleared.
    expect(history).toEqual([
      `참고로 ${newText}`,
      STUB_REPLY,
      '(요청한 기억을 바꿨어요. 기억 내용은 대화 기록에 남기지 않아요.)',
    ]);

    // Forget the edited memory: its text leaves the owner's history in every session (the other session's quote too).
    const forgetAsk = await harness.turn(owner, '기억 1 잊어줘');
    expect(forgetAsk.text).toContain(`> ${newText}`);
    const forgotten = await harness.turn(owner, `기억 확인 ${codeIn(forgetAsk.text)}`);
    expect(forgotten.text).toBe(
      [
        '이 기억을 잊었어요:',
        `> ${newText}`,
        '이전에 고쳐 쓰기 전 버전 1개도 함께 보관함으로 옮겼어요.',
        '이제 대화에 쓰지 않아요. 보관함에 7일 동안 두었다가 완전히 지워요. 되돌리려면 "보관함"에서 번호를 확인한 뒤 "기억 복원 N"이라고 보내 주세요.',
        '이번 대화 기록도 비웠어요.',
      ].join('\n'),
    );
    history = await ownerHistory();
    expect(carries(history, '아이스 아메리카노')).toEqual([]);
    expect(carries(history, '라떼')).toEqual([]);
    expect(history).toEqual([STUB_REPLY, '(요청한 기억을 잊었어요. 그 내용은 더 이상 쓰지 않아요.)']);
    expect(await harness.storage.memories.findDurableCandidates({ scope: { userId: ownerId }, limit: 10 })).toEqual([]);

    // Neither the context builder nor the generated context files bring the owner's copies back for the recall
    // question: what remains is only the other user's own turn in the shared session (never touched, below).
    const otherTurn = `${newText} 나도 그래`;
    expect(await providerView('아이스 아메리카노')).toEqual([otherTurn, `- ${otherTurn}`]);
    expect(await providerView('라떼')).toEqual([]);
    expect(await recall(ownerId, '좋아하는 커피')).toEqual([]);

    // The other user's turn in the same session was never touched (its rows are recorded under its own user id).
    const otherRows = await harness.storage.memories.findShortTermByUser(other.userId);
    expect(otherRows.map((record) => record.content)).toContain(otherTurn);
    expect(otherRows.every((record) => record.type === MemoryType.SHORT_TERM)).toBe(true);
  });

  it('live case: memory → paraphrased answer → forget → next context has neither; archive listed; restore brings recall back; expiry purge', async () => {
    const owner = harness.freshContext();
    const other = harness.freshContext();
    const fact = '내 차는 파란색 아반떼야';
    const paraphrase = '파란 아반떼를 타고 다니시는군요! 색이 예쁘겠어요.';
    expect((await harness.turn(owner, `기억해: ${fact}`)).reply).toBe('memory-stored');
    stubReply = paraphrase; // the provider answers with a paraphrase that never contains the memory text verbatim
    try {
      const chat = await harness.turn(owner, '내 차 기억나?');
      expect(chat.text).toContain('파란 아반떼');
    } finally {
      stubReply = STUB_REPLY;
    }
    const ownerId = await actorIdOf(owner);
    const session = await harness.storage.sessions.findActiveByContext(owner.channelId);
    if (!session) throw new Error('session was not opened');
    const task = recallTask(owner, ownerId, session.id, '내 차 무슨 색이었지?');
    // Precondition: the next context carries both the record (durable recall) and the paraphrase (transcript).
    expect(await providerViewOf(task, '아반떼')).toEqual(expect.arrayContaining([fact, paraphrase]));

    const ask = await harness.turn(owner, '기억 1 잊어줘');
    const done = await harness.turn(owner, `기억 확인 ${codeIn(ask.text)}`);
    expect(done).toMatchObject({ route: 'memory-commands', providerCalls: 0 });
    expect(done.text).toContain('보관함에 7일 동안 두었다가 완전히 지워요');
    expect(done.text).toContain('이번 대화 기록도 비웠어요.');
    // The next context contains neither the record nor the paraphrase.
    expect(await providerViewOf(task, '아반떼')).toEqual([]);
    expect(await recall(ownerId, '차 아반떼')).toEqual([]);

    // The archive lists it (with its own numbering); the listing itself is not kept verbatim in history.
    const archive = await harness.turn(owner, '보관함');
    expect(archive).toMatchObject({ route: 'memory-commands', providerCalls: 0 });
    expect(archive.text).toContain(`1. ${fact} (7일 남음)`);
    expect(archive.text).toContain('보관함 번호는 "기억 목록" 번호와 따로 매겨져요');
    expect(await providerViewOf(task, '아반떼')).toEqual([]);
    // Actor isolation: another actor sees an empty archive and cannot restore the owner's record.
    expect((await harness.turn(other, '보관함')).text).toContain('보관함이 비어 있어요');
    expect((await harness.turn(other, '기억 복원 1')).text).toContain('보관함이 비어 있어요');

    // Restore (confirmed) → recall works again.
    const restoreAsk = await harness.turn(owner, '기억 복원 1');
    expect(restoreAsk.text).toContain('보관함 1번 기억을 복원할까요?');
    expect((await harness.turn(other, `기억 확인 ${codeIn(restoreAsk.text)}`)).text).toContain('아무것도 바뀌지 않았어요');
    expect((await harness.turn(owner, `기억 확인 ${codeIn(restoreAsk.text)}`)).text).toContain('기억을 복원했어요');
    expect(await recall(ownerId, '차 아반떼')).toEqual([fact]);
    expect((await harness.turn(owner, '기억 목록')).text).toContain(`1. ${fact}`);

    // Forget again, then the expiry purge (injected clock): nothing at 6 days, gone for good at 7 days.
    const [record] = await harness.storage.memories.findDurableCandidates({ scope: { userId: ownerId }, limit: 5 });
    if (!record) throw new Error('restored memory missing');
    const again = await harness.turn(owner, '기억 1 잊어줘');
    await harness.turn(owner, `기억 확인 ${codeIn(again.text)}`);
    const archivedAt = Date.parse(String((await harness.storage.memories.get(record.id))?.metadata?.['archivedAt']));
    const DAY = 24 * 60 * 60 * 1000;
    await harness.memoryCommands.purgeExpiredArchive(new Date(archivedAt + 6 * DAY).toISOString());
    expect(isArchivedMemory((await harness.storage.memories.get(record.id)) ?? {})).toBe(true);
    const purge = await harness.memoryCommands.purgeExpiredArchive(new Date(archivedAt + 7 * DAY).toISOString());
    expect(purge.purged).toBeGreaterThanOrEqual(1);
    expect(await harness.storage.memories.get(record.id)).toBeNull();
    expect((await harness.turn(owner, '보관함')).text).toContain('보관함이 비어 있어요');
  });

  it('W3-L01 live case: own-memory question → provider with the memory; archived → truthful not-in-memory reply, zero provider calls; restored → provider again', async () => {
    const owner = harness.freshContext();
    const question = '내가 좋아하는 과일이 뭐였지?';
    const notFound = renderOwnMemoryNotFound('ko');
    expect((await harness.turn(owner, '기억해: 내가 좋아하는 과일은 귤이야')).reply).toBe('memory-stored');
    const withMemory = await harness.turn(owner, question);
    expect(withMemory).toMatchObject({ route: 'classifier', text: STUB_REPLY });
    expect(withMemory.providerCalls).toBe(1);

    const ask = await harness.turn(owner, '기억 1 잊어줘');
    expect((await harness.turn(owner, `기억 확인 ${codeIn(ask.text)}`)).text).toContain('이 기억을 잊었어요');
    const before = harness.providerCalls() + harness.availabilityProbes();
    const archived = await harness.turn(owner, question);
    expect(archived).toMatchObject({ route: 'classifier', reply: 'own-memory-not-found', providerCalls: 0, text: notFound });
    expect(harness.providerCalls() + harness.availabilityProbes() - before).toBe(0);
    // Asking again is still no hit (the earlier question in history is not evidence).
    expect((await harness.turn(owner, question)).text).toBe(notFound);

    const restoreAsk = await harness.turn(owner, '기억 복원 1');
    expect((await harness.turn(owner, `기억 확인 ${codeIn(restoreAsk.text)}`)).text).toContain('기억을 복원했어요');
    const restored = await harness.turn(owner, question);
    expect(restored).toMatchObject({ route: 'classifier', text: STUB_REPLY });
    expect(restored.providerCalls).toBe(1);
  });

  it('credential-like record text is never archived (deleted at once), and QUOKY_MEMORY_ARCHIVE_DAYS=0 deletes at once (real SQLite)', async () => {
    const owner = harness.freshContext();
    await harness.turn(owner, '보관함'); // resolves the owner's actor
    const ownerId = await actorIdOf(owner);
    // A legacy record the writer would refuse today: inserted directly into the real store.
    const at = new Date().toISOString();
    await harness.storage.memories.save({
      id: 'legacy-credential-memory',
      type: MemoryType.LONG_TERM,
      scope: { userId: ownerId },
      content: '운영 DB password = hunter2hunter2',
      metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT' },
      createdAt: at,
      updatedAt: at,
    });
    const ask = await harness.turn(owner, '기억 1 잊어줘');
    expect(ask.text).not.toContain('hunter2');
    const done = await harness.turn(owner, `기억 확인 ${codeIn(ask.text)}`);
    expect(done.text).toContain('보관함에 두지 않고 바로 완전히 지웠어요');
    expect(await harness.storage.memories.get('legacy-credential-memory')).toBeNull();
    expect((await harness.turn(owner, '보관함')).text).toContain('보관함이 비어 있어요');
    // Fix loop 1 (P1): text only the strict file-content guard flags is never archived either.
    await harness.storage.memories.save({
      id: 'legacy-file-content-credential',
      type: MemoryType.LONG_TERM,
      scope: { userId: ownerId },
      content: 'const dbPassword = "synthetic-value"',
      metadata: { kind: 'SEMANTIC', provenance: 'USER_PROVIDED', authorityLevel: 'USER_CLAIM_OR_INTENT' },
      createdAt: at,
      updatedAt: at,
    });
    const strictAsk = await harness.turn(owner, '기억 1 잊어줘');
    expect(strictAsk.text).not.toContain('synthetic-value');
    expect((await harness.turn(owner, `기억 확인 ${codeIn(strictAsk.text)}`)).text).toContain('바로 완전히 지웠어요');
    expect(await harness.storage.memories.get('legacy-file-content-credential')).toBeNull();

    // The ARCHIVE_DAYS=0 composition over the same real SQLite store: forget deletes permanently at once.
    const immediate = new MemoryCommandService({
      records: {
        get: (id) => harness.storage.memories.get(id),
        findDurableCandidates: (query) => harness.storage.memories.findDurableCandidates(query),
        save: (record) => harness.storage.memories.save(record),
      },
      writer: new DefaultMemoryWriter(harness.memory),
      archiveDays: 0,
    });
    expect((await harness.turn(owner, '기억해: 바로 지워질 기억')).reply).toBe('memory-stored');
    const run = async (text: string) => {
      const command = parseMemoryCommand(text);
      if (command === null) throw new Error(text);
      return immediate.execute(command, { actorId: ownerId, now: new Date().toISOString(), sourceText: text });
    };
    const zeroAsk = await run('기억 1 잊어줘');
    const zeroDone = await run(`기억 확인 ${codeIn(zeroAsk.text)}`);
    expect(zeroDone.text).toBe('이 기억을 잊었어요:\n> 바로 지워질 기억');
    expect(await harness.storage.memories.findDurableCandidates({ scope: { userId: ownerId }, limit: 5, archived: 'include' })).toEqual([]);
    expect((await run('보관함')).text).toBe('보관함이 비어 있어요. 지금 설정에서는 잊은 기억을 보관하지 않고 바로 완전히 지워요.');
  });

  it('fix loop 2: an edit request never reaches history verbatim, even when the rewrite AND the removal both fail', async () => {
    const owner = harness.freshContext();
    expect((await harness.turn(owner, '기억해: 평범한 기억이야')).reply).toBe('memory-stored');
    const redact = vi.spyOn(harness.memory, 'redactShortTerm').mockRejectedValue(new Error('disk full'));
    const remove = vi.spyOn(harness.memory, 'deleteShortTerm').mockRejectedValue(new Error('disk full'));
    try {
      const strict = await harness.turn(owner, '기억 1 수정: const dbPassword = "synthetic-value"');
      expect(strict.text).toContain('민감한 정보');
      expect(strict.text).not.toContain('synthetic-value');
      const ask = await harness.turn(owner, '기억 1 수정: 아주 새로운 비공개 문장');
      expect(ask.text).toContain('새 내용: 아주 새로운 비공개 문장'); // the reply itself is unchanged
      expect(redact).toHaveBeenCalled();
      expect(remove).toHaveBeenCalled();
    } finally {
      redact.mockRestore();
      remove.mockRestore();
    }
    const history = (await harness.storage.memories.findShortTermByUser(owner.userId)).map((record) => record.content);
    expect(history.filter((row) => row.includes('synthetic-value') || row.includes('아주 새로운 비공개 문장'))).toEqual([]);
    expect(history.filter((row) => row === '기억 1 수정: (내용은 대화 기록에 남기지 않아요)')).toHaveLength(2);
  });

  it('pins the golden memory-command routing (기억해: still saves; to-do and reminder phrases keep their handlers)', () => {
    const route = (text: string) => routing.cases.find((c) => c.text === text)?.expected;
    expect(route('기억해: 커피는 아메리카노')).toEqual({ route: 'runtime', reply: 'memory-stored', providerCalls: 0 });
    expect(route('기억해: 기억 목록')).toEqual({ route: 'runtime', reply: 'memory-stored', providerCalls: 0 });
    for (const text of ['기억 목록', '기억 1 보여줘', '기억 1 잊어줘', '기억 1 수정: 커피는 라떼', '기억 확인 AAAA', '내 기억 다 지워줘']) {
      expect(route(text), text).toEqual({ route: 'memory-commands', providerCalls: 0 });
    }
    expect(route('할 일 추가: 기억 목록 정리')).toMatchObject({ route: 'work-chat.todo' });
    expect(route('30분 뒤에 기억 목록 정리 알려줘')).toMatchObject({ route: 'reminders' });
    expect(route('기억 어떻게 지워?')).toMatchObject({ route: 'help-intent' });
    // ADR-0106 amendment: the archive commands are the same handler (order 50), never a to-do or chat.
    for (const text of ['보관함', '기억 복원 1', '기억 완전 삭제 1', 'memory archive', 'restore memory 1']) {
      expect(route(text), text).toEqual({ route: 'memory-commands', providerCalls: 0 });
    }
    expect(route('할 일 추가: 보관함 정리')).toMatchObject({ route: 'work-chat.todo' });
    expect(route('기억 복원 1 하지 마')).toMatchObject({ route: 'classifier' });
  });
});

describe('Personal v3 CAL-2 — schedule questions from the configured calendar (ADR-0110 D3–D6)', () => {
  const DAY_MS = 86_400_000;
  const calendarCases = () => routing.cases.filter((golden) => golden.expected.route === 'calendar');

  it('pins the golden calendar routing: the task phrases, the QUAL-7 switch, write refusals and the reminder pair', () => {
    const route = (text: string) => routing.cases.find((c) => c.text === text)?.expected;
    for (const text of ['오늘 일정', '내일 일정 뭐야?', '이번 주 일정', '다음 회의 언제야?', "What's my next meeting?", '나 내일 바빠?']) {
      expect(route(text), text).toEqual({ route: 'calendar', providerCalls: 0 });
    }
    expect(route('내일 3시 회의 일정 추가해줘')).toEqual({ route: 'calendar', providerCalls: 0 });
    expect(route('내일 9시에 회의 알려줘')).toEqual({ route: 'reminders', providerCalls: 0 });
    expect(route('할 일 추가: 내일 일정 정리')).toMatchObject({ route: 'work-chat.todo' });
    expect(route('일정 관리 팁 알려줘')).toEqual({ route: 'classifier' });
    expect(calendarCases().length).toBeGreaterThanOrEqual(12);
  });

  it('every claimed schedule question read the calendar once with a local-day window and answered from it', async () => {
    const byId = await observeSuite(routing);
    // CWR-2 added the write-draft cases (route-193..195); with writes off in this composition they all get the refusal.
    const writes = new Set([
      '내일 3시 회의 일정 추가해줘',
      'cancel my 3pm meeting',
      '내일 3시 회의 4시로 옮겨줘',
      '내일 3시 회의 취소해줘',
      '내일 오후 3시에 회의 잡아줘 제목 주간 회의',
      // INT-2: the v3 live-QA W4-L01 booking phrasings (route-205/206).
      '내일 오후 3시에 회의 잡아줘',
      '금요일 10시에 팀 미팅 넣어줘',
      // v3 live QA session 3 (route-301..303): an undated delete (D2) and a multi-word booking title (D10).
      '일정 취소해줘',
      '일정 삭제해줘',
      '금요일 오후 3시에 QA 스윕 회의 잡아줘',
    ]);
    for (const golden of calendarCases()) {
      const seen = byId.get(golden.id) as CaseObservation;
      expect(seen.route, golden.id).toBe('calendar');
      expect(seen.providerCalls + seen.availabilityProbes, golden.id).toBe(0);
      if (writes.has(golden.text)) {
        expect(seen.text, golden.id).toMatch(/아무것도 바꾸지 않았어요|nothing was changed/);
      } else {
        expect(seen.text, golden.id).toContain(CALENDAR_FIXTURE_TITLE);
        expect(seen.text, golden.id).toMatch(/Asia\/Seoul/);
      }
    }
    // Write refusals make no read; each answered question made exactly one, inside the port's 31-day bound.
    const answered = calendarCases().filter((golden) => !writes.has(golden.text)).length;
    expect(harness.calendarReads).toHaveLength(answered);
    for (const read of harness.calendarReads) {
      const span = Date.parse(read.to) - Date.parse(read.from);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(31 * DAY_MS);
      expect(read.limit).toBe(50);
    }
    // Day and week windows start at a Seoul midnight (15:00 UTC).
    expect(harness.calendarReads.filter((read) => read.from.endsWith('T15:00:00.000Z')).length).toBeGreaterThan(5);
  });

  it('calendar text never reaches a provider or the conversation history (ADR-0110 D4)', async () => {
    const owner = harness.freshContext();
    const providerBefore = harness.providerCalls();
    const answer = await harness.turn(owner, '오늘 일정');
    expect(answer.route).toBe('calendar');
    expect(answer.text).toContain(CALENDAR_FIXTURE_TITLE);
    // A chat turn afterwards: the provider prompt is built from the history, which carries the fixed note only.
    await harness.turn(owner, '고마워');
    expect(harness.providerCalls()).toBeGreaterThan(providerBefore);
    const history = (await harness.storage.memories.findShortTermByUser(owner.userId)).map((record) => record.content);
    expect(history.some((row) => row.includes(CALENDAR_FIXTURE_TITLE))).toBe(false);
    expect(history).toContain('[캘린더 조회 응답 — 일정 내용은 대화 기록에 남기지 않아요.]');
  });

  it('the calendar help line is listed in the full help reply', async () => {
    const help = await harness.turn(harness.freshContext(), '도움말');
    expect(help.text).toContain('- 캘린더(읽기 전용): "오늘 일정", "내일 일정 뭐야?", "이번 주 일정", "다음 회의 언제야?"');
  });
});
