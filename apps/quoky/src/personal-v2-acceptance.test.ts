import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  CONVERSATION_TURN_HANDLERS,
  ConversationRuntime,
  IntentClassifier,
  MAX_CONTRIBUTED_HELP_LINES,
  MAX_CONTRIBUTED_HELP_LINE_CHARS,
  ResponseComposer,
  STORAGE_PROVIDER,
  StatelessApplyPreviewFlow,
  TURN_HANDLER_STAGES,
  VECTOR_PROVIDER,
  WorkChatService,
  type AiProvider,
  type ApplyPreviewAnchor,
  type ConversationContext,
  type ConversationRuntimeDeps,
  type ConversationTurnHandler,
  type InboundMessage,
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

/**
 * Personal v2 — integration acceptance (INT-1, plan wave 8; ADR-0096..ADR-0101). OFFLINE and in-process: the REAL
 * `AppModule` (every production provider, the four feature compositions and the turn-handler aggregator) is booted
 * through Nest over a REAL SQLite file that was migrated 11 → 12 → 13 first. Only the edges are replaced: the
 * environment is a sanitized temp config (no `.env.local`, no token, no connector, Ollama off), the Discord adapter
 * is never started, and every registered `AiProvider` instance has its `isAvailable`/`execute` replaced by a counting
 * stub, so no CLI is ever spawned and every provider touch is visible. Turns go through the production
 * `ConversationRuntime` exactly as `QuokyCore` would call it.
 *
 * It pins: the dispatch-boundary deps baseline, the five handlers in their fixed stages/orders, the contributed help
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
  ['work-chat.todo', 'pre-classify', 100],
  ['reminders', 'pre-classify', 200],
  ['work-chat.lookup', 'pre-classify', 300],
];

/** Precedence-suite labels for the registered handler ids (the corpus predates the final ids). */
const PRECEDENCE_LABEL: Readonly<Record<string, string>> = {
  'work-chat.todo': 'work-chat.mutation',
  reminders: 'reminder',
  'work-chat.lookup': 'work-chat.lookup',
};

const STUB_REPLY = 'INT-1 stub provider reply';

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
    migrationSteps.push(runMigrations(raw, MIGRATIONS));
    expect(tableNames(db)).toContain('reminders');
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
        return { text: STUB_REPLY, artifacts: [] };
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
  return 'other';
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

/** Run one case in its own fresh context (its own actor, session, to-dos and reminders), applying `ctx` first. */
async function observeCase(golden: { text: string; ctx?: RoutingCtx }): Promise<CaseObservation> {
  const context = harness.freshContext();
  const before = harness.providerCalls() + harness.availabilityProbes();
  for (const title of golden.ctx?.openTodos ?? []) {
    const added = await harness.turn(context, `할 일 추가: ${title}`);
    if (added.route !== 'work-chat.todo') throw new Error(`setup to-do was not added: ${title}`);
  }
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
  it('the migration list is exactly 1..13, contiguous, and LATEST_SCHEMA_VERSION is 13', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(13);
  });

  it('a temp DB was migrated 0 → 11, then 11 → 12 (feedback) and 12 → 13 (reminders), one version per step', () => {
    expect(migrationSteps).toEqual([
      { from: 0, to: 11, applied: Array.from({ length: 11 }, (_, i) => i + 1) },
      { from: 11, to: 12, applied: [12] },
      { from: 12, to: 13, applied: [13] },
    ]);
  });

  it('the production storage opened that DB without re-migrating, and it stays at 13 with every v12/v13 table', () => {
    const db = openRawDb(dbPath);
    try {
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(13);
      expect(tableNames(db)).toEqual(expect.arrayContaining(['conversation_turns', 'feedback_signals', 'reminders']));
      // A build that knows only up to 12 refuses the v13 DB (fail closed, never a downgrade).
      type Db = Parameters<typeof runMigrations>[0];
      expect(() => runMigrations(db as unknown as Db, MIGRATIONS.slice(0, 12))).toThrow('SCHEMA_VERSION_AHEAD');
      expect(Number(db.pragma('user_version', { simple: true }))).toBe(13);
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

  it('registers exactly five turn handlers in their fixed stage/order (control → post-anchor → pre-classify)', () => {
    expect(harness.handlers).toHaveLength(5);
    expect(new Set(harness.handlers.map((handler) => handler.id)).size).toBe(5);
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
    // Registry order is kept and only the first 12 bounded lines survive: the cut line, the 7 real lines, then
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
    expect(route('완료 처리 어떻게 해?')).toEqual({ route: 'classifier' });
    expect(route('완료 처리 어떻게 해?', todo)).toEqual({ route: 'classifier' });
  });
});
