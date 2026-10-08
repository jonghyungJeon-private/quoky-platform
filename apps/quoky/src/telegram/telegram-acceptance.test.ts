import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  ActorManager,
  ConversationRuntime,
  NOTIFICATION_SINK,
  PLATFORM_ADAPTER,
  QuokyCore,
  REMINDER_REPOSITORY,
  ReminderDispatchService,
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  type AiProvider,
  type ConversationContext,
  type InboundMessage,
  type OutboundMessage,
  type PlatformAdapter,
  type ReminderRepository,
  type StorageProvider,
  type VectorProvider,
} from '@quoky/core';
import { renderOutboundForTelegram, TELEGRAM_API_ORIGIN, TelegramPlatformAdapter } from '@quoky/adapter-telegram';
import { ActorIdentityProvisioner } from '../actor-identity-provisioner';
import { CompositePlatformAdapter } from '../platform/composite-platform-adapter';
import { stubProviderSelection } from '../provider-selection/test-support';

/**
 * TG-1 integration acceptance (ADR-0114 D3/D6/D11/D13). OFFLINE and in-process: the REAL `AppModule` is booted through
 * Nest over a REAL SQLite file with Telegram enabled, and the REAL composite platform is started the way `main.ts` starts
 * it. Only the edges are replaced: no `.env.local`, the token is assembled at runtime, the Discord child's gateway
 * methods (start/stop/send) are recorded instead of connecting, every `AiProvider` is a counting stub, and the global
 * `fetch` is a scripted Bot API server for `api.telegram.org` that refuses every other host (counted), so the real
 * Telegram adapter runs end to end — getMe, the probe, long polling, sendMessage — against it.
 */

/** A scripted Bot API: Telegram's confirm-by-offset getUpdates semantics, a long poll that waits for pushed updates. */
class FakeBotApi {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private pending: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];
  private seq = 500;

  push(update: Record<string, unknown>): void {
    this.pending.push(update);
    for (const wake of this.waiters.splice(0)) wake();
  }

  sends(): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === 'sendMessage').map((call) => call.params);
  }

  async handle(url: string, init: RequestInit): Promise<Response> {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const params = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method, params });
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === 'getMe') return ok({ id: Number(BOT_ID), is_bot: true, first_name: 'Quoky' });
    if (method === 'sendMessage') return ok({ message_id: (this.seq += 1) });
    if (method === 'sendChatAction') return ok(true);
    if (method !== 'getUpdates') return new Response(JSON.stringify({ ok: false }), { status: 400 });
    const offset = params.offset as number | undefined;
    if (offset !== undefined) this.pending = this.pending.filter((update) => (update.update_id as number) >= offset);
    if (this.pending.length === 0 && params.timeout !== 0) {
      await new Promise<void>((resolve, reject) => {
        this.waiters.push(resolve);
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return ok(this.pending.slice(0, (params.limit as number | undefined) ?? 100));
  }
}

function telegramUpdate(updateId: number, text: string, from: number = Number(TELEGRAM_OWNER)): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from, type: 'private' },
      from: { id: from, is_bot: false, first_name: 'Owner' },
      text,
    },
  };
}

async function until(predicate: () => boolean, turns = 2000): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}

const DISCORD_OWNER = '111111111111111111';
const TELEGRAM_OWNER = '5550001';
const BOT_ID = ['70', '01', '23', '4'].join('');
const SECRET = ['AAH', 'acc', '_', 'p'.repeat(15), '-', 'r'.repeat(14)].join('');
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;

const discordDm: ConversationContext = { platform: 'discord', channelId: '888888888888888801', userId: DISCORD_OWNER, direct: true };
const telegramChat: ConversationContext = { platform: 'telegram', channelId: TELEGRAM_OWNER, userId: TELEGRAM_OWNER, direct: true };

let savedEnv: NodeJS.ProcessEnv = {};
let tempDir = '';
let networkAttempts = 0;
let providerCalls = 0;
const botApi = new FakeBotApi();
const discordSent: OutboundMessage[] = [];
let platform: CompositePlatformAdapter;
let updateSeq = 1000;
let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
let storage: StorageProvider;
let runtime: ConversationRuntime;
let seq = 0;

async function turn(context: ConversationContext, text: string) {
  seq += 1;
  const message: InboundMessage = { id: `tg1-${seq}`, context, text, receivedAt: new Date().toISOString() };
  return runtime.handle(message);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(`${TELEGRAM_API_ORIGIN}/`)) return botApi.handle(url, init);
    networkAttempts += 1;
    throw new Error('TG-1 acceptance: network is not available in this test');
  });
  for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'quoky-tg1-'));
  Object.assign(process.env, {
    QUOKY_DISCORD_OWNER_IDS: DISCORD_OWNER,
    QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
    QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
    QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
    QUOKY_OLLAMA_ENABLED: 'false',
    CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
    QUOKY_TELEGRAM_ENABLED: 'true',
    QUOKY_TELEGRAM_BOT_TOKEN: [BOT_ID, SECRET].join(':'),
    QUOKY_TELEGRAM_EXPECTED_BOT_ID: BOT_ID,
    QUOKY_TELEGRAM_OWNER_IDS: TELEGRAM_OWNER,
    QUOKY_TELEGRAM_OWNER_ACTOR_MAP: `${TELEGRAM_OWNER}=${DISCORD_OWNER}`,
  });
  const { AppModule } = await import('../app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  storage = app.get<StorageProvider>(STORAGE_PROVIDER);
  await storage.init();
  await app.get<VectorProvider>(VECTOR_PROVIDER).init();
  const stub = (provider: AiProvider): void => {
    Object.assign(provider, {
      async isAvailable() {
        return true;
      },
      async execute() {
        providerCalls += 1;
        return { text: 'TG-1 stub reply', artifacts: [] };
      },
    });
  };
  for (const provider of app.get<AiProvider[]>(AI_PROVIDERS)) stub(provider);
  stubProviderSelection(app, stub, { status: 'OK', models: [] });
  // main.ts order: storage, then the identity links, then the inbound handler, then the platform.
  await app.get(ActorIdentityProvisioner).provision();
  runtime = app.get(ConversationRuntime);
  platform = app.get<CompositePlatformAdapter>(PLATFORM_ADAPTER);
  // The Discord child never connects: its gateway methods are recorded (its sink and identity reader are not used here).
  Object.assign(platform.adapterFor('discord') as PlatformAdapter, {
    start: async () => undefined,
    stop: async () => undefined,
    sendTyping: async () => undefined,
    sendMessage: async (message: OutboundMessage) => void discordSent.push(message),
  });
  const core = app.get(QuokyCore);
  platform.onMessage((message) => core.handleInboundMessage(message));
  await platform.start();
  await until(() => (platform.adapterFor('telegram') as TelegramPlatformAdapter).status().polling);
}, 60_000);

/** Push an update to the fake Bot API and wait until the adapter has polled past it. */
async function deliverUpdate(text: string, from?: number): Promise<void> {
  updateSeq += 1;
  const id = updateSeq;
  botApi.push(telegramUpdate(id, text, from));
  await until(() => botApi.calls.some((call) => call.method === 'getUpdates' && call.params.offset === id + 1));
}

afterAll(async () => {
  await platform?.stop().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  await app?.close();
  process.env = savedEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('TG-1 acceptance — composition (ADR-0114 D6)', () => {
  it('binds one composite over Discord (primary) and Telegram behind PLATFORM_ADAPTER; the sink is the composite', () => {
    const platform = app.get<PlatformAdapter>(PLATFORM_ADAPTER);
    expect(platform).toBeInstanceOf(CompositePlatformAdapter);
    expect((platform as CompositePlatformAdapter).platforms).toEqual(['discord', 'telegram']);
    expect(app.get(NOTIFICATION_SINK)).toBe(platform);
  });

  it('constructing the composition made no network call and the token is not in the container', () => {
    expect(networkAttempts).toBe(0);
    expect(JSON.stringify(app.get<PlatformAdapter>(PLATFORM_ADAPTER))).not.toContain(SECRET);
  });
});

describe('TG-1 acceptance — the same owner Actor across platforms (ADR-0114 D3)', () => {
  it('the fresh install has exactly one owner Actor, reached from both platforms', async () => {
    const actors = app.get(ActorManager);
    const viaDiscord = await actors.resolveFromContext(discordDm);
    const viaTelegram = await actors.resolveFromContext(telegramChat);
    expect(viaTelegram.id).toBe(viaDiscord.id);
    expect(await storage.actors.list()).toHaveLength(1);
  });

  it('a memory saved on Discord is listed on Telegram, and a to-do added on Discord is listed on Telegram', async () => {
    const before = providerCalls;
    await turn(discordDm, '기억해: 내 배포 창은 화요일이야');
    await turn(discordDm, '할 일 추가: 보고서 초안 쓰기');
    const memories = await turn(telegramChat, '기억 목록');
    const todos = await turn(telegramChat, '할 일 목록');
    expect(renderOutboundForTelegram(memories.reply)).toContain('내 배포 창은 화요일이야');
    expect(renderOutboundForTelegram(todos.reply)).toContain('보고서 초안 쓰기');
    // Deterministic turns: no provider ran, and the reply is addressed to the Telegram conversation.
    expect(providerCalls - before).toBe(0);
    expect(memories.reply.context).toMatchObject({ platform: 'telegram', channelId: TELEGRAM_OWNER });
    expect(await storage.actors.list()).toHaveLength(1);
  });

  it('sessions stay per platform conversation', async () => {
    const onDiscord = await turn(discordDm, '할 일 목록');
    const onTelegram = await turn(telegramChat, '할 일 목록');
    expect(onTelegram.sessionId).not.toBe(onDiscord.sessionId);
    expect(networkAttempts).toBe(0);
  });

  it('negative control: an unlinked identity (never admitted by the adapter) is another Actor and sees none of it', async () => {
    const stranger: ConversationContext = { platform: 'telegram', channelId: '5550777', userId: '5550777', direct: true };
    const memories = await turn(stranger, '기억 목록');
    const todos = await turn(stranger, '할 일 목록');
    expect(renderOutboundForTelegram(memories.reply)).not.toContain('내 배포 창은 화요일이야');
    expect(renderOutboundForTelegram(todos.reply)).not.toContain('보고서 초안 쓰기');
  });
});

describe('TG-1 acceptance — end to end through the started composite (CA P2-4)', () => {
  it('the real adapter verified the bot and is polling; nothing else reached the network', () => {
    expect(botApi.calls.filter((call) => call.method === 'getMe')).toHaveLength(1);
    expect((platform.adapterFor('telegram') as TelegramPlatformAdapter).status()).toMatchObject({ identityVerified: true, polling: true });
    expect(networkAttempts).toBe(0);
  });

  it('a non-owner update causes zero sends and no turn', async () => {
    const sendsBefore = botApi.sends().length;
    const actionsBefore = botApi.calls.filter((call) => call.method === 'sendChatAction').length;
    await deliverUpdate('할 일 목록', 5_550_999);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(botApi.sends()).toHaveLength(sendsBefore);
    expect(botApi.calls.filter((call) => call.method === 'sendChatAction')).toHaveLength(actionsBefore);
  });

  it("an owner update is one turn answered by exactly one sendMessage to the owner's chat", async () => {
    await runtime.handle({ id: 'seed-todo', context: discordDm, text: '할 일 추가: 회의록 정리', receivedAt: new Date().toISOString() });
    const sendsBefore = botApi.sends().length;
    await deliverUpdate('할 일 목록');
    await until(() => botApi.sends().length > sendsBefore);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sends = botApi.sends().slice(sendsBefore);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chat_id: TELEGRAM_OWNER, link_preview_options: { is_disabled: true } });
    expect(sends[0]?.parse_mode).toBeUndefined();
    expect(String(sends[0]?.text)).toContain('회의록 정리');
    // The handed-over offset is persisted beside the database (private ops file; bot id and offset only).
    const stored = JSON.parse(readFileSync(join(tempDir, 'ops', 'telegram-offset.json'), 'utf8')) as Record<string, unknown>;
    expect(stored).toEqual({ version: 1, botId: BOT_ID, offset: updateSeq + 1 });
  });

  it('a reply for a Discord conversation goes to the Discord child and never reaches the Telegram fetch', async () => {
    const telegramCalls = botApi.calls.length;
    const discordBefore = discordSent.length;
    await platform.sendMessage({ context: discordDm, text: 'Discord only' });
    await platform.sendTyping(discordDm);
    expect(discordSent.slice(discordBefore).map((message) => message.text)).toEqual(['Discord only']);
    expect(botApi.calls.slice(telegramCalls).filter((call) => call.method !== 'getUpdates')).toEqual([]);
  });
});

describe('TG-1 acceptance — reminders and the brief return to Telegram (ADR-0114 D11; CA P1-1)', () => {
  const dispatch = () => app.get(ReminderDispatchService);
  const ownerActor = async () => (await app.get(ActorManager).resolveFromContext(telegramChat)).id;

  it('a reminder created in the Telegram chat fires as one sendMessage to the owner chat', async () => {
    const sendsBefore = botApi.sends().length;
    await deliverUpdate('1분 뒤에 스트레칭 알려줘');
    await until(() => botApi.sends().length === sendsBefore + 1);
    const created = await app.get<ReminderRepository>(REMINDER_REPOSITORY).listActiveByActor(await ownerActor());
    const reminder = created.find((entry) => entry.origin.platform === 'telegram' && entry.kind === 'TEXT');
    expect(reminder).toBeDefined();
    const fireAt = new Date(Date.parse(reminder?.nextFireAt as string) + 30_000).toISOString();
    await dispatch().dispatchDue(fireAt);
    const sends = botApi.sends().slice(sendsBefore);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ chat_id: TELEGRAM_OWNER });
    expect(String(sends[1]?.text)).toContain('스트레칭');
    expect(discordSent.filter((message) => String(message.text).includes('스트레칭'))).toHaveLength(0);
  });

  it('a daily brief created on Telegram is delivered on Telegram', async () => {
    const sendsBefore = botApi.sends().length;
    await deliverUpdate('매일 오후 1시에 오늘 할 일 알려줘');
    await until(() => botApi.sends().length === sendsBefore + 1);
    const active = await app.get<ReminderRepository>(REMINDER_REPOSITORY).listActiveByActor(await ownerActor());
    const brief = active.find((entry) => entry.origin.platform === 'telegram' && entry.kind === 'BRIEF');
    expect(brief).toBeDefined();
    await dispatch().dispatchDue(new Date(Date.parse(brief?.nextFireAt as string) + 30_000).toISOString());
    const sends = botApi.sends().slice(sendsBefore);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ chat_id: TELEGRAM_OWNER });
    expect(networkAttempts).toBe(0);
  });
});
