import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  ApprovalStatus,
  Capability,
  ContextBuilder,
  ExecutionOutcomeStatus,
  ExecutionStage,
  IntentClassifier,
  IntentResolver,
  MemoryManager,
  PLATFORM_ADAPTER,
  PromptComposer,
  PromptRenderer,
  ReminderStatus,
  ResponseComposer,
  RiskLevel,
  STORAGE_PROVIDER,
  SessionManager,
  SessionStatus,
  TaskRunStatus,
  TaskStatus,
  type AiRequest,
  type ApprovalRequest,
  type ConversationContext,
  type ConversationTurnHandler,
  type InboundMessage,
  type LogFields,
  type Logger,
  type MemoryRecord,
  type MemoryRepository,
  type NotificationSinkOutcome,
  type OwnerNotification,
  type Session,
  type StorageProvider,
  type Task,
  type TaskRun,
  type VectorProvider,
} from '@quoky/core';
import { DiscordPlatformAdapter, deliverOwnerNotification, type DiscordConfig } from '@quoky/adapter-discord';
import { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { loadConfig } from '../config';
import { createProductionContextBuilder } from '../context-builder-provider';
import {
  createProductionConversationRuntime,
  type ProductionConversationRuntimeDeps,
} from '../conversation-runtime-provider';
import { REMINDER_TURN_HANDLERS } from '../features/feature-tokens';
import { createRemindersProviders, withReminderChannelDelivery } from '../features/reminders.providers';
import type { ReminderConfig } from './reminder-config';
import { ReminderTickDriver, type ReminderTickTimers } from './reminder-tick-driver';

/**
 * Owner reminders — OFFLINE end-to-end acceptance (ADR-0101, PRO-5). The production feature composition
 * (`features/reminders.providers.ts`) is resolved through Nest with a REAL `SqliteStorageProvider` on a temp file
 * (migrated to the latest schema), a fake owner NotificationSink on a fake platform, a controllable clock and
 * manual timers. Conversation turns go through a real `ConversationRuntime` with the composed reminder handler.
 * No Discord, provider CLI, network or runtime. Live verification is the separate attended packet
 * `docs/uat/reminders-uat-packet.md`.
 */

const OWNER_ID = '111111111111111111';
const DM_CHANNEL = '777777777777777777';
const ACTOR_ID = `actor-${OWNER_ID}`;
const dmContext: ConversationContext = { platform: 'discord', channelId: DM_CHANNEL, userId: OWNER_ID };
// 2026-10-02 12:00 KST (Friday).
const T0 = Date.parse('2026-10-02T03:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const openApps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-reminder-acceptance-'));
  dirs.push(dir);
  return join(dir, 'chunsik.db');
}

class TestClock {
  ms = T0;
  now = (): string => new Date(this.ms).toISOString();
  advance(ms: number): void { this.ms += ms; }
}

/** Manual timers: the tick driver's chain only advances when the test fires it. */
class ManualTimers implements ReminderTickTimers {
  private nextId = 1;
  readonly pending = new Map<number, () => void>();
  setTimeout(callback: () => void, _ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return { id };
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete((handle as { id: number }).id);
  }
  fireNext(): boolean {
    const next = [...this.pending.entries()][0];
    if (next === undefined) return false;
    this.pending.delete(next[0]);
    next[1]();
    return true;
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  warn(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
  error(message: string, fields?: LogFields): void { this.lines.push(`${message} ${JSON.stringify(fields ?? {})}`); }
}

/** A fake platform that is also the owner NotificationSink (as the Discord adapter is, PRO-4). */
class FakePlatform {
  readonly platform = 'discord';
  readonly deliveries: OwnerNotification[] = [];
  readonly sent: unknown[] = [];
  outcomes: NotificationSinkOutcome[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(): void {}
  onApprovalDecision(): void {}
  async sendMessage(message: unknown): Promise<void> { this.sent.push(message); }
  async sendTyping(): Promise<void> {}
  async requestApproval(): Promise<void> {}
  async deliver(notification: OwnerNotification): Promise<NotificationSinkOutcome> {
    this.deliveries.push(notification);
    return this.outcomes.shift() ?? { status: 'SENT', via: 'dm' };
  }
}

function memoryRepository(): MemoryRepository {
  const records = new Map<string, MemoryRecord>();
  const matches = (record: MemoryRecord, scope: MemoryRecord['scope']) =>
    Object.entries(scope).every(([key, value]) => record.scope[key as keyof MemoryRecord['scope']] === value);
  return {
    async get(id) { return records.get(id) ?? null; },
    async save(record) { records.set(record.id, record); return record; },
    async delete(id) { records.delete(id); },
    async list() { return [...records.values()]; },
    async findByScope(scope, type) {
      return [...records.values()].filter((r) => matches(r, scope) && (type === undefined || r.type === type));
    },
    async findDurableCandidates() { return []; },
    async findShortTermByUser(userId) {
      return [...records.values()].filter((r) => String(r.type) === 'SHORT_TERM' && r.scope.userId === userId);
    },
  };
}

function sessionRepository() {
  const sessions = new Map<string, Session>();
  return {
    async get(id: string) { return sessions.get(id) ?? null; },
    async save(session: Session) { sessions.set(session.id, session); return session; },
    async delete(id: string) { sessions.delete(id); },
    async list() { return [...sessions.values()]; },
    async findActiveByContext(channelId: string, threadId?: string) {
      return [...sessions.values()]
        .filter((s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId && s.context.threadId === threadId)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0] ?? null;
    },
  };
}

function pendingApproval(at: string): ApprovalRequest {
  return {
    id: 'approval-1',
    executionPlanRef: { id: 'plan-1', goal: 'change code' },
    status: ApprovalStatus.PENDING,
    riskLevel: RiskLevel.HIGH,
    reason: '코드 변경 계획 승인',
    requestedBy: ACTOR_ID,
    createdAt: at,
    updatedAt: at,
  } as ApprovalRequest;
}

/** A real ConversationRuntime whose only registered turn handlers are the composed reminder handlers. */
function conversationRuntime(
  turnHandlers: readonly ConversationTurnHandler[],
  clock: TestClock,
  options: { withPendingApproval?: boolean } = {},
) {
  const storage = { memories: memoryRepository(), sessions: sessionRepository() } as unknown as StorageProvider;
  const memory = new MemoryManager(storage, {} as VectorProvider);
  let providerCalls = 0;
  let tasksCreated = 0;
  const provider = {
    id: 'acceptance-fake-provider',
    capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }],
    async isAvailable() { return true; },
    async execute(_request: AiRequest) {
      providerCalls += 1;
      return { text: '알려드릴게요!', artifacts: [] };
    },
  };
  const pending = options.withPendingApproval ? pendingApproval(clock.now()) : null;
  const deps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } },
    actors: {
      async resolveFromContext(context: ConversationContext) {
        return { id: `actor-${context.userId}`, displayName: 'Owner', identities: [], createdAt: clock.now() };
      },
    },
    sessions: new SessionManager(storage),
    memory,
    classifier: new IntentClassifier({ select: async () => provider } as never),
    projects: { async register() { return { ok: true, message: 'registered' }; }, async get() { return null; } },
    analyzer: { async prepare() { return { ready: true }; } },
    tasks: {
      async createTask(intent: Task['intent'], taskContext: Task['context'], anchor: { requestText: string; actorId: string; sessionId: string }) {
        tasksCreated += 1;
        const at = clock.now();
        return {
          id: `task-${tasksCreated}`, title: intent.summary, description: anchor.requestText,
          status: TaskStatus.PENDING, intent, riskLevel: RiskLevel.LOW, context: taskContext,
          actorId: anchor.actorId, sessionId: anchor.sessionId, createdAt: at, updatedAt: at,
        } satisfies Task;
      },
      async transition(task: Task, status: TaskStatus) { return { ...task, status, updatedAt: clock.now() }; },
      async startRun(task: Task, capability: Capability) {
        return { id: `run-${task.id}`, taskId: task.id, attempt: 1, status: TaskRunStatus.STARTED, capability, artifactIds: [], startedAt: clock.now() } satisfies TaskRun;
      },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: {
      async prepare() { return undefined; },
      async open() { throw new Error('workspace must not open'); },
      async list() { return []; },
      async diff() { throw new Error('diff must not run'); },
      async read() { throw new Error('read must not run'); },
    },
    commandExecutions: { async get() { return null; } },
    command: { async run() { throw new Error('command must not run'); } },
    contextBuilder: createProductionContextBuilder(memory, storage, {}) as ContextBuilder,
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router: { async select() { return provider; } },
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    intentResolver: new IntentResolver(),
    orchestrator: {
      async run() {
        return { status: ExecutionOutcomeStatus.AWAITING_APPROVAL, lastStage: ExecutionStage.APPROVAL, selectedStages: [], refs: {} };
      },
      async resume() { throw new Error('resume must not run'); },
    },
    approvals: {
      async decide() { throw new Error('no decision expected'); },
      async get() { return null; },
      async requestForRisk() { throw new Error('requestForRisk must not run'); },
    },
    approvalFlow: {
      async findPending() { return pending; },
      async anchor() { return undefined; },
      async reconstructResume() { return null; },
    },
    scopeClarificationFlow: { async findPending() { return null; }, async anchor() { return undefined; }, async clear() { return undefined; } },
    applyPreviewFlow: { async findAnchor() { return null; }, async anchor() { return undefined; }, async clear() { return undefined; } },
    codeGeneration: { async generate() { throw new Error('generation must not run'); }, async getProposal() { return null; } },
    patch: { async generate() { throw new Error('patch must not run'); }, async get() { return null; } },
    codeProposals: { async get() { return null; } },
    workspaceWrite: { async apply() { throw new Error('workspace mutation must not run'); } },
    git: {},
    turnHandlers,
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as ProductionConversationRuntimeDeps;
  const runtime = createProductionConversationRuntime(memory, deps, { clock: clock.now });
  let sequence = 0;
  return {
    providerCalls: () => providerCalls,
    tasksCreated: () => tasksCreated,
    async say(text: string, context: ConversationContext = dmContext) {
      sequence += 1;
      const message: InboundMessage = { id: `message-${sequence}`, context, text, receivedAt: clock.now() };
      return runtime.handle(message);
    },
  };
}

interface Composition {
  readonly storage: SqliteStorageProvider;
  readonly platform: FakePlatform;
  readonly driver: ReminderTickDriver;
  readonly handlers: readonly ConversationTurnHandler[];
  readonly timers: ManualTimers;
  close(): Promise<void>;
}

/** Resolve the PRODUCTION reminder composition over a real SQLite file (init() runs AFTER DI, as in main.ts). */
async function compose(
  dbPath: string,
  clock: TestClock,
  logger: RecordingLogger,
  config: Partial<ReminderConfig> = {},
  platform: FakePlatform = new FakePlatform(),
): Promise<Composition> {
  const storage = new SqliteStorageProvider({ dbPath });
  const timers = new ManualTimers();
  const reminderConfig: ReminderConfig = { enabled: true, channelDelivery: false, timeZone: 'Asia/Seoul', ...config };
  @Module({
    providers: [
      { provide: STORAGE_PROVIDER, useValue: storage },
      { provide: PLATFORM_ADAPTER, useValue: platform },
      ...createRemindersProviders(() => reminderConfig, { clock: clock.now, timers, logger }),
    ],
  })
  class ReminderComposition {}
  const app = await NestFactory.createApplicationContext(ReminderComposition, { logger: false });
  // QA-001: the repository bindings were constructed before init(); they must resolve the live repos now.
  await storage.init();
  let closed = false;
  const composition: Composition = {
    storage,
    platform,
    timers,
    driver: app.get(ReminderTickDriver),
    handlers: app.get<readonly ConversationTurnHandler[]>(REMINDER_TURN_HANDLERS),
    async close() {
      if (closed) return;
      closed = true;
      await composition.driver.stop();
      await storage.close();
      await app.close();
    },
  };
  openApps.push(composition);
  return composition;
}

/** Fire the driver's armed tick timer and wait for that tick (and its re-arm) to finish. */
async function tick(c: Composition): Promise<void> {
  expect(c.timers.fireNext()).toBe(true);
  await c.driver.idle();
  await Promise.resolve();
}

describe('reminders offline acceptance — composition', () => {
  it('main.ts starts the tick after platform.start() and stops it first on shutdown', () => {
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    const platformStart = main.indexOf('await platform.start();');
    const driverStart = main.indexOf('await reminderDriver.start();');
    expect(platformStart).toBeGreaterThan(0);
    expect(driverStart).toBeGreaterThan(platformStart);
    const shutdown = main.slice(main.indexOf('const shutdown = async'));
    expect(shutdown.indexOf('reminderDriver.stop()')).toBeGreaterThan(0);
    expect(shutdown.indexOf('reminderDriver.stop()')).toBeLessThan(shutdown.indexOf('platform.stop()'));
    expect(shutdown.indexOf('reminderDriver.stop()')).toBeLessThan(shutdown.indexOf('storage.close()'));
  });

  it('registers exactly one pre-classify handler (order 200) and wires dispatch without provider/connector/tool deps', async () => {
    const c = await compose(tempDbPath(), new TestClock(), new RecordingLogger());
    expect(c.handlers.map((h) => [h.id, h.stage, h.order])).toEqual([['reminders', 'pre-classify', 200]]);
    const source = readFileSync(new URL('../features/reminders.providers.ts', import.meta.url), 'utf8');
    for (const forbidden of ['AI_PROVIDERS', 'CONNECTOR_PROVIDERS', 'TOOL_PROVIDERS', 'AiProviderManager', 'ConnectorManager', 'ConversationRuntime']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('reminders offline acceptance — channel delivery wiring (ADR-0101 D8, live QA)', () => {
  const GUILD_ID = '222222222222222222';
  const REMINDER_CHANNEL = '333333333333333333';
  const baseEnv = {
    QUOKY_DISCORD_OWNER_IDS: OWNER_ID,
    QUOKY_DISCORD_CHANNEL_IDS: REMINDER_CHANNEL,
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_BOT_TOKEN: 'fixture-not-a-token',
  };
  /** The Discord adapter keeps its config private; the composition test reads it only to prove the wiring. */
  const adapterConfigOf = (env: NodeJS.ProcessEnv): DiscordConfig => {
    const config = loadConfig(env);
    const adapter = new DiscordPlatformAdapter(withReminderChannelDelivery(config.discord, config.reminders), new RecordingLogger());
    return (adapter as unknown as { config: DiscordConfig }).config;
  };

  it('the PLATFORM_ADAPTER receives channelDelivery=true when reminders and QUOKY_REMINDERS_CHANNEL_DELIVERY are on', () => {
    const config = adapterConfigOf({ ...baseEnv, QUOKY_REMINDERS_ENABLED: 'true', QUOKY_REMINDERS_CHANNEL_DELIVERY: 'true' });
    expect(config.channelDelivery).toBe(true);
    expect(config).toMatchObject({ guildId: GUILD_ID, ownerIds: [OWNER_ID], channelIds: [REMINDER_CHANNEL] });
  });

  it('channelDelivery is false by default and stays inert while reminders are off', () => {
    expect(adapterConfigOf({ ...baseEnv }).channelDelivery).toBe(false);
    expect(adapterConfigOf({ ...baseEnv, QUOKY_REMINDERS_ENABLED: 'true' }).channelDelivery).toBe(false);
    expect(
      adapterConfigOf({ ...baseEnv, QUOKY_REMINDERS_ENABLED: 'false', QUOKY_REMINDERS_CHANNEL_DELIVERY: 'true' }).channelDelivery,
    ).toBe(false);
  });

  it('with reminders on by default (ADR-0102 D9), the channel opt-in alone enables channel delivery', () => {
    expect(adapterConfigOf({ ...baseEnv, QUOKY_REMINDERS_CHANNEL_DELIVERY: 'true' }).channelDelivery).toBe(true);
  });

  it('app.module builds the Discord adapter from the reminder-aware config (not the bare discord config)', () => {
    const appModule = readFileSync(new URL('../app.module.ts', import.meta.url), 'utf8');
    expect(appModule).toContain('withReminderChannelDelivery(config.discord, config.reminders)');
    expect(appModule).not.toMatch(/new DiscordPlatformAdapter\(config\.discord\b/);
  });

  it('a reminder created in an allowlisted guild channel targets that guild (spaceId) and is delivered to the channel', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger(), { channelDelivery: true });
    const chat = conversationRuntime(c.handlers, clock);
    await c.driver.start();
    // The Discord adapter maps a guild message to this context (spaceId = message.guildId; see adapter tests).
    const guildContext: ConversationContext = { platform: 'discord', channelId: REMINDER_CHANNEL, userId: OWNER_ID, spaceId: GUILD_ID };

    expect((await chat.say('30분 뒤에 스트레칭 알려줘', guildContext)).reply.text).toContain('#1');
    clock.advance(31 * MINUTE);
    await tick(c);

    expect(c.platform.deliveries).toHaveLength(1);
    const notification = c.platform.deliveries[0]!;
    expect(notification.target).toEqual(guildContext);

    // The persisted target passes the adapter's guild-target admission (spaceId === configured guild) → channel.
    const posted: string[] = [];
    const dmPosts: string[] = [];
    const deps = {
      ownerIds: [OWNER_ID],
      channelIds: [REMINDER_CHANNEL],
      guildId: GUILD_ID,
      fetchChannel: async (id: string) => ({ send: async () => { posted.push(id); return {}; } }),
      fetchOwnerDm: async () => ({ send: async () => { dmPosts.push('dm'); return {}; } }),
      logger: new RecordingLogger(),
    };
    await expect(deliverOwnerNotification(notification, { ...deps, channelDelivery: true })).resolves.toEqual({ status: 'SENT', via: 'channel' });
    expect(posted).toEqual([REMINDER_CHANNEL]);
    expect(dmPosts).toHaveLength(0);
    // Default (flag off) the same target goes to the owner DM.
    await expect(deliverOwnerNotification(notification, { ...deps, channelDelivery: false })).resolves.toEqual({ status: 'SENT', via: 'dm' });
    expect(dmPosts).toHaveLength(1);
  });
});

describe('reminders offline acceptance — conversation to delivery', () => {
  it('create → tick before due sends nothing → tick after due sends once → list is empty', async () => {
    const clock = new TestClock();
    const logger = new RecordingLogger();
    const c = await compose(tempDbPath(), clock, logger);
    const chat = conversationRuntime(c.handlers, clock);
    expect(await c.driver.start()).toBe(true);

    const created = await chat.say('30분 뒤에 스트레칭 알려줘');
    expect(created.status).toBe('RESPONDED');
    expect(created.reply.text).toContain('10월 2일(금) 오후 12:30');
    expect(created.reply.text).toContain('#1');
    expect(created.reply.text).toContain("'스트레칭'");
    expect(chat.providerCalls()).toBe(0);
    expect(chat.tasksCreated()).toBe(0);

    clock.advance(10 * MINUTE);
    await tick(c);
    expect(c.platform.deliveries).toHaveLength(0);

    clock.advance(21 * MINUTE);
    await tick(c);
    expect(c.platform.deliveries).toHaveLength(1);
    expect(c.platform.deliveries[0]).toMatchObject({ kind: 'TEXT', text: '알림 #1: 스트레칭', target: dmContext });
    expect(c.platform.deliveries[0]?.text).not.toContain('⏰');

    await tick(c);
    expect(c.platform.deliveries).toHaveLength(1);
    expect((await c.storage.reminders.getByDisplayNo(ACTOR_ID, 1))?.status).toBe(ReminderStatus.COMPLETED);
    expect((await chat.say('알림 목록')).reply.text).toContain('예정된 알림이 없어요');

    // Logs carry counts and classes only — never a reminder body.
    expect(logger.lines.join('\n')).not.toContain('스트레칭');
    // Reminder replies never go through the platform's reply path here (the runtime returns them).
    expect(c.platform.sent).toHaveLength(0);
  });

  it('a daily reminder is delivered on each day and stays scheduled for the next occurrence', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger());
    const chat = conversationRuntime(c.handlers, clock);
    await c.driver.start();

    const created = await chat.say('매일 오후 1시에 물 마시기 알려줘');
    expect(created.reply.text).toContain('매일');
    expect(created.reply.text).toContain('#1');

    clock.advance(1 * HOUR); // 13:00 KST
    await tick(c);
    clock.advance(24 * HOUR); // next day 13:00 KST
    await tick(c);
    await tick(c);

    expect(c.platform.deliveries.map((d) => d.text)).toEqual(['알림 #1: 물 마시기', '알림 #1: 물 마시기']);
    const reminder = await c.storage.reminders.getByDisplayNo(ACTOR_ID, 1);
    expect(reminder?.status).toBe(ReminderStatus.SCHEDULED);
    expect(reminder?.nextFireAt).toBe('2026-10-04T04:00:00.000Z');
    expect((await chat.say('알림 목록')).reply.text).toContain('지난 알림: 전달됨');
  });

  it('the daily brief reads only local data and is delivered as a BRIEF (DM-only at the adapter)', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger());
    const chat = conversationRuntime(c.handlers, clock);
    await c.driver.start();

    await chat.say('매일 오후 1시에 오늘 할 일 알려줘');
    clock.advance(1 * HOUR);
    await tick(c);

    expect(c.platform.deliveries).toHaveLength(1);
    expect(c.platform.deliveries[0]?.kind).toBe('BRIEF');
    expect(chat.providerCalls()).toBe(0);
  });

  it('cancel prevents delivery', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger());
    const chat = conversationRuntime(c.handlers, clock);
    await c.driver.start();

    await chat.say('30분 뒤에 빨래 알려줘');
    expect((await chat.say('알림 1 취소')).reply.text).toContain('알림 #1 취소했어요');
    clock.advance(1 * HOUR);
    await tick(c);

    expect(c.platform.deliveries).toHaveLength(0);
    expect((await c.storage.reminders.getByDisplayNo(ACTOR_ID, 1))?.status).toBe(ReminderStatus.CANCELED);
  });

  it('delivers at most 10 reminders per tick', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger());
    const chat = conversationRuntime(c.handlers, clock);
    await c.driver.start();
    for (let i = 1; i <= 12; i += 1) await chat.say(`${10 + i}분 뒤에 할 일 ${i} 알려줘`);

    clock.advance(1 * HOUR);
    await tick(c);
    expect(c.platform.deliveries).toHaveLength(10);
    await tick(c);
    expect(c.platform.deliveries).toHaveLength(12);
    expect(new Set(c.platform.deliveries.map((d) => d.text)).size).toBe(12);
  });

  it('an UNCERTAIN send is terminal: never retried or resent', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger());
    const chat = conversationRuntime(c.handlers, clock);
    await c.driver.start();
    await chat.say('5분 뒤에 전화하기 알려줘');
    c.platform.outcomes = [{ status: 'UNCERTAIN', reason: 'TIMEOUT' }];

    clock.advance(6 * MINUTE);
    await tick(c);
    clock.advance(1 * HOUR);
    await tick(c);

    expect(c.platform.deliveries).toHaveLength(1);
    expect((await c.storage.reminders.getByDisplayNo(ACTOR_ID, 1))?.status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
  });

  it('while an approval is pending a reminder phrase gets the approval reminder and no reminder is stored', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger());
    const chat = conversationRuntime(c.handlers, clock, { withPendingApproval: true });

    const result = await chat.say('내일 9시에 회의 준비 알려줘');

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.reply.text).toContain('"승인"');
    expect(await c.storage.reminders.listActiveByActor(ACTOR_ID)).toEqual([]);
    expect(chat.providerCalls()).toBe(0);
  });

  it('help shows the reminder lines contributed by the handler', async () => {
    const c = await compose(tempDbPath(), new TestClock(), new RecordingLogger());
    const help = await conversationRuntime(c.handlers, new TestClock()).say('도움말');
    expect(help.reply.text).toContain('"알림 목록", "알림 N 취소"');
  });
});

describe('reminders offline acceptance — restart and recovery', () => {
  it('after 3 h of downtime: a missed ONCE is delivered late once, a DAILY within 60 min catches up, one beyond is skipped', async () => {
    const dbPath = tempDbPath();
    const clock = new TestClock();
    const first = await compose(dbPath, clock, new RecordingLogger());
    const chat = conversationRuntime(first.handlers, clock);
    await first.driver.start();
    await chat.say('30분 뒤에 서류 제출 알려줘'); // #1 ONCE 12:30
    await chat.say('매일 오후 1시에 물 마시기 알려줘'); // #2 DAILY 13:00 (missed by 2h30 at restart)
    await chat.say('매일 오후 3시에 스트레칭 알려줘'); // #3 DAILY 15:00 (missed by 30 min at restart)
    await first.close();

    clock.advance(3 * HOUR + 30 * MINUTE); // 15:30 KST
    const platform = new FakePlatform();
    const second = await compose(dbPath, clock, new RecordingLogger(), {}, platform);
    expect(await second.driver.start()).toBe(true);
    await tick(second);
    await tick(second);

    const texts = platform.deliveries.map((d) => d.text).sort();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/^알림 #1: 서류 제출 \(원래 .*12:30.*늦게 전달됐어요\)$/u);
    expect(texts[1]).toMatch(/^알림 #3: 스트레칭 \(원래 .*늦게 전달됐어요\)$/u);
    expect((await second.storage.reminders.getByDisplayNo(ACTOR_ID, 1))?.status).toBe(ReminderStatus.COMPLETED);
    const skipped = await second.storage.reminders.getByDisplayNo(ACTOR_ID, 2);
    expect(skipped?.status).toBe(ReminderStatus.SCHEDULED);
    expect(skipped?.lastOutcome?.outcome).toBe('SKIPPED_MISSED');
    expect(skipped?.nextFireAt).toBe('2026-10-03T04:00:00.000Z');
    const list = await conversationRuntime(second.handlers, clock).say('알림 목록');
    expect(list.reply.text).toContain('지난 알림: 시간이 지나 건너뜀');
  });

  it('a FIRING row left by a crash becomes DELIVERY_UNCERTAIN at startup and is never resent', async () => {
    const dbPath = tempDbPath();
    const clock = new TestClock();
    const first = await compose(dbPath, clock, new RecordingLogger());
    const chat = conversationRuntime(first.handlers, clock);
    await chat.say('10분 뒤에 약 먹기 알려줘');
    clock.advance(11 * MINUTE);
    // Simulate a crash between claim and completion: the row is FIRING, nothing was recorded as sent.
    const claimed = await first.storage.reminders.claimDue(clock.now(), 10, 'crashed-attempt');
    expect(claimed).toHaveLength(1);
    await first.close();

    clock.advance(5 * MINUTE);
    const platform = new FakePlatform();
    const second = await compose(dbPath, clock, new RecordingLogger(), {}, platform);
    await second.driver.start();
    await tick(second);
    clock.advance(1 * HOUR);
    await tick(second);

    expect(platform.deliveries).toHaveLength(0);
    const recovered = await second.storage.reminders.getByDisplayNo(ACTOR_ID, 1);
    expect(recovered?.status).toBe(ReminderStatus.DELIVERY_UNCERTAIN);
    const cancel = await conversationRuntime(second.handlers, clock).say('알림 1 취소');
    expect(cancel.reply.text).toContain('다시 보내지 않아요');
  });
});

describe('reminders offline acceptance — disabled flag', () => {
  it('with QUOKY_REMINDERS_ENABLED=false a reminder phrase gets the fixed reply, nothing is stored and the driver never starts', async () => {
    const clock = new TestClock();
    const c = await compose(tempDbPath(), clock, new RecordingLogger(), { enabled: false });
    const chat = conversationRuntime(c.handlers, clock);

    expect(await c.driver.start()).toBe(false);
    expect(c.driver.state).toBe('DISABLED');
    expect(c.timers.pending.size).toBe(0);

    const reply = await chat.say('30분 뒤에 스트레칭 알려줘');
    expect(reply.status).toBe('RESPONDED');
    expect(reply.reply.text).toContain('알림 기능이 꺼져 있어요');
    expect(chat.providerCalls()).toBe(0);
    expect(chat.tasksCreated()).toBe(0);
    expect(await c.storage.reminders.listActiveByActor(ACTOR_ID)).toEqual([]);

    // A non-reminder message still reaches chat.
    await chat.say('타입스크립트 제네릭 설명해줘');
    expect(chat.providerCalls()).toBeGreaterThan(0);
    expect(c.platform.deliveries).toHaveLength(0);
  });
});
