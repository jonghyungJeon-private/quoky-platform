import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
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
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  type AiProvider,
  type ConversationContext,
  type InboundMessage,
  type PlatformAdapter,
  type StorageProvider,
  type VectorProvider,
} from '@quoky/core';
import { renderOutboundForTelegram } from '@quoky/adapter-telegram';
import { ActorIdentityProvisioner } from '../actor-identity-provisioner';
import { CompositePlatformAdapter } from '../platform/composite-platform-adapter';
import { stubProviderSelection } from '../provider-selection/test-support';

/**
 * TG-1 integration acceptance (ADR-0114 D3/D6/D13). OFFLINE and in-process: the REAL `AppModule` is booted through Nest
 * over a REAL SQLite file with Telegram enabled. Only the edges are replaced: no `.env.local`, the token is assembled at
 * runtime, neither platform adapter is started (no getMe, no poll), every `AiProvider` is a counting stub and the
 * global `fetch` refuses, so any network attempt is visible. It pins the composition (one composite behind the single
 * `PLATFORM_ADAPTER`) and the owner identity across platforms: what the owner saves on Discord is there on Telegram.
 */

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
  vi.stubGlobal('fetch', async () => {
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
  // main.ts order: storage, then the identity links, then the platform (never started here).
  await app.get(ActorIdentityProvisioner).provision();
  runtime = app.get(ConversationRuntime);
}, 60_000);

afterAll(async () => {
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
