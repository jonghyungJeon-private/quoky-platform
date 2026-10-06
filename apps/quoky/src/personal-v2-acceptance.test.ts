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
  CODE_CHAIN_STATUS_DOMAINS,
  Capability,
  CONVERSATION_TURN_HANDLERS,
  ConversationRuntime,
  FeedbackSignalKind,
  IntentClassifier,
  IntentType,
  LearningItemKind,
  MAX_CONTRIBUTED_HELP_LINES,
  MAX_CONTRIBUTED_HELP_LINE_CHARS,
  ResponseComposer,
  STORAGE_PROVIDER,
  RiskLevel,
  StatelessApplyPreviewFlow,
  TURN_HANDLER_STAGES,
  TaskStatus,
  VECTOR_PROVIDER,
  WorkChatService,
  generalChatReplyPolicy,
  guardInternalActionClaims,
  renderInternalActionNotDone,
  type AiProvider,
  type ApplyPreviewAnchor,
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
 * It pins: the dispatch-boundary deps baseline, the seven handlers in their fixed stages/orders (the five v2 handlers
 * plus the ADR-0104 D4 help-intent handler, registered at wave-1 integration, and the ADR-0107 D3 learning-command
 * handler, LRN-1), the contributed help
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
  // ADR-0107 D3 (amends ADR-0096 D5): owner learning commands, after memory commands (50), before to-dos (100).
  ['feedback.learning', 'pre-classify', 60],
  ['work-chat.todo', 'pre-classify', 100],
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

/** Build a v11 database, then step it to 12 and 13 with the production migration list (ADR-0096 D10). */
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
    migrationSteps.push(runMigrations(raw, MIGRATIONS));
    expect(tableNames(db)).toContain('learning_items');
  } finally {
    db.close();
  }
}

let contextSeq = 0;

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
        ...(route === 'runtime' ? { reply: runtimeReplyLabel(composer, context, replyText) } : {}),
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
  if (text.startsWith('Quoky로 할 수 있는 일이에요.')) return 'help';
  // ADR-0104 D3 (DET-1): the code-chain not-done reply for a status question / completion statement.
  for (const domain of CODE_CHAIN_STATUS_DOMAINS) {
    for (const language of ['ko', 'en'] as const) {
      if (text === renderInternalActionNotDone(domain, language)) return `internal-action-not-done:${domain}`;
    }
  }
  return 'other';
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
  it('the migration list is exactly 1..14, contiguous, and LATEST_SCHEMA_VERSION is 14 (v14: ADR-0107 learning)', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(14);
  });

  it('a temp DB was migrated 0 → 11, then 11 → 12 (feedback), 12 → 13 (reminders) and 13 → 14 (learning), one version per step', () => {
    expect(migrationSteps).toEqual([
      { from: 0, to: 11, applied: Array.from({ length: 11 }, (_, i) => i + 1) },
      { from: 11, to: 12, applied: [12] },
      { from: 12, to: 13, applied: [13] },
      { from: 13, to: 14, applied: [14] },
    ]);
  });

  it('the production storage opened that DB without re-migrating, and it stays at 14 with every v12/v13/v14 table', () => {
    const db = openRawDb(dbPath);
    try {
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(14);
      expect(tableNames(db)).toEqual(expect.arrayContaining([
        'conversation_turns', 'feedback_signals', 'reminders', 'learning_items',
      ]));
      // A build that knows only up to 13 refuses the v14 DB (fail closed, never a downgrade).
      type Db = Parameters<typeof runMigrations>[0];
      expect(() => runMigrations(db as unknown as Db, MIGRATIONS.slice(0, 13))).toThrow('SCHEMA_VERSION_AHEAD');
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(14);
    } finally {
      db.close();
    }
  });
});

describe('Personal v2 acceptance — composition (ADR-0096 D2/D5/D7, ADR-0097)', () => {
  it('ConversationRuntimeDeps: the production runtime receives every key of the deps type; the dispatch-boundary baseline is 34', () => {
    // Compile-time exhaustive list of the deps TYPE's keys (adding or removing a key breaks this literal).
    const typeKeys: Record<keyof ConversationRuntimeDeps, true> = {
      dispatchCommit: true, actors: true, sessions: true, memory: true, memoryWriter: true, classifier: true,
      projects: true, analyzer: true, tasks: true, workspace: true, commandExecutions: true, command: true,
      contextBuilder: true, promptComposer: true, promptRenderer: true, router: true, runtimeProviderRouting: true,
      artifacts: true, composer: true, workSurface: true, intentResolver: true, orchestrator: true, approvals: true,
      approvalFlow: true, scopeClarificationFlow: true, applyPreviewFlow: true, codeGeneration: true, patch: true,
      codeProposals: true, workspaceWrite: true, git: true, repositoryHosting: true, turnHandlers: true,
      credentialOverrideFlow: true, logger: true,
    };
    const composed = Object.keys((harness.runtime as unknown as { deps: ConversationRuntimeDeps }).deps).sort();
    expect(composed).toEqual(Object.keys(typeKeys).sort());
    expect(composed).toHaveLength(35);
    // The accepted ADR-0032 M3 / ADR-0096 / ADR-0097 baseline (32 → 33 → 34) counts the dispatch-boundary deps.
    // `runtimeProviderRouting` is the optional offline Stage 2A routing seam (added before the 32 baseline was
    // taken) that the baseline has never counted (conversation-runtime.test.ts asserts 34 without it).
    expect(composed.filter((key) => key !== 'runtimeProviderRouting')).toHaveLength(34);
    expect(composed).toEqual(expect.arrayContaining(['turnHandlers', 'credentialOverrideFlow']));
    // No feature smuggled a dependency in beside `turnHandlers` (ADR-0096 D2: no reminders/feedback/work deps).
    expect(composed.some((key) => /remind|feedback|work(?:Chat|Desk|Summary)|branch/i.test(key))).toBe(false);
  });

  it('registers exactly seven turn handlers in their fixed stage/order (control → post-anchor → pre-classify)', () => {
    expect(harness.handlers).toHaveLength(7);
    expect(new Set(harness.handlers.map((handler) => handler.id)).size).toBe(7);
    const byStage = (harness.runtime as unknown as {
      turnHandlersByStage: Readonly<Record<TurnHandlerStage, readonly ConversationTurnHandler[]>>;
    }).turnHandlersByStage;
    expect(Object.keys(byStage)).toEqual([...TURN_HANDLER_STAGES]);
    const dispatchOrder = TURN_HANDLER_STAGES.flatMap((stage) =>
      byStage[stage].map((handler) => [handler.id, handler.stage, handler.order] as const),
    );
    expect(dispatchOrder).toEqual(EXPECTED_REGISTRY);
  });

  it('help lists every contributed line verbatim, in registry order, within 12 lines × 120 characters', async () => {
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
    const keptExtras = MAX_CONTRIBUTED_HELP_LINES - 1 - contributed.length;
    expect(keptExtras).toBeGreaterThanOrEqual(0);
    const shown = [cut as string, ...contributed, ...extras.slice(0, keptExtras)];
    const first = lines.indexOf(cut as string);
    expect(lines.slice(first, first + MAX_CONTRIBUTED_HELP_LINES)).toEqual(shown);
    for (const dropped of extras.slice(keptExtras)) expect(lines).not.toContain(dropped);
  });
});

describe('Personal v2 acceptance — deterministic turns never reach a provider', () => {
  it('every deterministic routing case made zero provider calls and zero availability probes (setup included)', async () => {
    const byId = await observeSuite(routing);
    const deterministic = routing.cases.filter((golden) => golden.expected.route !== 'classifier');
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
    const fallThrough = routing.cases.filter((golden) => golden.expected.route === 'classifier');
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
      if (golden.expected.route === 'classifier') {
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
    for (const golden of helpCases) {
      const seen = byId.get(golden.id) as CaseObservation;
      const label = `${golden.id} ${golden.text}`;
      expect(seen.route, label).toBe('help-intent');
      expect(seen.providerCalls + seen.availabilityProbes, label).toBe(0);
      expect(seen.setupProviderTouches, `${label} setup`).toBe(0);
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
