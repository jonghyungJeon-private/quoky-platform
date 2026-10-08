import 'reflect-metadata';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  ActorManager,
  ConversationRuntime,
  ISSUE_COMMENT_WRITER,
  PLATFORM_ADAPTER,
  QuokyCore,
  STORAGE_PROVIDER,
  VECTOR_PROVIDER,
  connectorWriteSent,
  renderNoApprovedConnectorWrite,
  type AiProvider,
  type ConversationContext,
  type IssueCommentRequest,
  type OutboundMessage,
  type PlatformAdapter,
  type VectorProvider,
} from '@quoky/core';
import { canonicalizeImage, TELEGRAM_API_ORIGIN, TelegramPlatformAdapter } from '@quoky/adapter-telegram';
import type { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { ActorIdentityProvisioner } from '../actor-identity-provisioner';
import { CompositePlatformAdapter } from '../platform/composite-platform-adapter';
import { stubProviderSelection } from '../provider-selection/test-support';

/**
 * TG-2 integration acceptance (ADR-0114 D8/D9/D10). OFFLINE and in-process, following `telegram-acceptance.test.ts`: the
 * REAL `AppModule` over a REAL SQLite file with Telegram enabled, Jira comment writes on behind an allowlist, and the
 * Claude image instance selected; the REAL composite is started the way `main.ts` starts it. Only the edges are fakes:
 * the Discord child never connects, every `AiProvider` is a recording stub, the Jira comment writer's I/O is a recorder,
 * and the global `fetch` is a scripted Bot API for `api.telegram.org` (methods AND file downloads) that refuses every
 * other host (counted). The real Telegram adapter runs end to end: polling, admission, `getFile`, the guarded download,
 * the #143 canonical intake, sendMessage and `message_reaction` feedback.
 */

class FakeBotApi {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** file_id → { path, bytes }. */
  readonly files = new Map<string, { path: string; bytes: Buffer }>();
  private pending: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];
  private seq = 700;

  push(update: Record<string, unknown>): void {
    this.pending.push(update);
    for (const wake of this.waiters.splice(0)) wake();
  }

  sends(): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === 'sendMessage').map((call) => call.params);
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  async handle(url: string, init: RequestInit): Promise<Response> {
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (url.startsWith(`${TELEGRAM_API_ORIGIN}/file/bot`)) {
      const filePath = url.split('/').slice(5).join('/');
      this.calls.push({ method: 'downloadFile', params: { file_path: filePath } });
      const file = [...this.files.values()].find((entry) => entry.path === filePath);
      return file ? new Response(file.bytes, { status: 200 }) : new Response('', { status: 404 });
    }
    const method = url.slice(url.lastIndexOf('/') + 1);
    const params = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === 'getMe') return ok({ id: Number(BOT_ID), is_bot: true, first_name: 'Quoky' });
    if (method === 'sendMessage') return ok({ message_id: (this.seq += 1) });
    if (method === 'sendChatAction') return ok(true);
    if (method === 'getFile') {
      const file = this.files.get(String(params.file_id));
      return file
        ? ok({ file_id: params.file_id, file_unique_id: 'u', file_size: file.bytes.length, file_path: file.path })
        : new Response(JSON.stringify({ ok: false }), { status: 400 });
    }
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

async function until(predicate: () => boolean, turns = 3000): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}

const DISCORD_OWNER = '111111111111111111';
const TELEGRAM_OWNER = '5550001';
const BOT_ID = ['70', '01', '23', '4'].join('');
const SECRET = ['AAH', 'tg2', '_', 'q'.repeat(15), '-', 's'.repeat(14)].join('');
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
const STUB_REPLY = 'TG-2 stub reply';
const COMMENT_URL = 'https://example.invalid/browse/PROJ-12?focusedCommentId=20001';

const discordDm: ConversationContext = { platform: 'discord', channelId: '888888888888888802', userId: DISCORD_OWNER, direct: true };

/** A small structurally valid RGB PNG with a `tEXt` chunk (metadata the canonical intake drops). */
function pngWithText(text: string): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of data) value = (crcTable[(value ^ byte) & 0xff] as number) ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\u0000${text}`, 'latin1')),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let savedEnv: NodeJS.ProcessEnv = {};
let tempDir = '';
let networkAttempts = 0;
const botApi = new FakeBotApi();
const discordSent: OutboundMessage[] = [];
const comments: IssueCommentRequest[] = [];
const executions: Array<{ capability: string; images: Array<{ path: string; mimeType: string; bytes: Buffer }>; prompt: string }> = [];
let platform: CompositePlatformAdapter;
let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
let storage: SqliteStorageProvider;
let runtime: ConversationRuntime;
let updateSeq = 3000;
let messageSeq = 9000;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(`${TELEGRAM_API_ORIGIN}/`)) return botApi.handle(url, init);
    networkAttempts += 1;
    throw new Error('TG-2 acceptance: network is not available in this test');
  });
  for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'quoky-tg2-'));
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
    // ADR-0112 D4: Jira comment writes on behind the allowlist (placeholder credentials; nothing is ever sent).
    QUOKY_JIRA_BASE_URL: 'https://example.invalid',
    QUOKY_JIRA_EMAIL: 'tg2@example.invalid',
    QUOKY_JIRA_TOKEN: 'tg2-jira-placeholder',
    QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
    QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS: 'PROJ',
    // ADR-0111 amendment A1: the owner's image setup (the stubbed Claude vision instance reads images).
    QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude',
  });
  const { AppModule } = await import('../app.module');
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  storage = app.get<SqliteStorageProvider>(STORAGE_PROVIDER);
  await storage.init();
  await app.get<VectorProvider>(VECTOR_PROVIDER).init();
  const stub = (provider: AiProvider): void => {
    Object.assign(provider, {
      async isAvailable() {
        return true;
      },
      async execute(request: { capability: string; images?: ReadonlyArray<{ path: string; mimeType: string }>; prompt?: unknown }) {
        executions.push({
          capability: request.capability,
          images: (request.images ?? []).map((image) => ({ ...image, bytes: readFileSync(image.path) })),
          prompt: JSON.stringify(request.prompt ?? request),
        });
        return { text: STUB_REPLY, artifacts: [] };
      },
    });
  };
  for (const provider of app.get<AiProvider[]>(AI_PROVIDERS)) stub(provider);
  stubProviderSelection(app, stub, { status: 'OK', models: [] });
  Object.assign(app.get(ISSUE_COMMENT_WRITER), {
    async addComment(request: IssueCommentRequest) {
      comments.push(request);
      return connectorWriteSent('20001', COMMENT_URL);
    },
  });
  await app.get(ActorIdentityProvisioner).provision();
  runtime = app.get(ConversationRuntime);
  platform = app.get<CompositePlatformAdapter>(PLATFORM_ADAPTER);
  Object.assign(platform.adapterFor('discord') as PlatformAdapter, {
    start: async () => undefined,
    stop: async () => undefined,
    sendTyping: async () => undefined,
    sendMessage: async (message: OutboundMessage) => void discordSent.push(message),
  });
  // main.ts order: the identity links, the inbound handler, then the platform (QuokyCore subscribed onFeedback).
  const core = app.get(QuokyCore);
  platform.onMessage((message) => core.handleInboundMessage(message));
  await platform.start();
  await until(() => (platform.adapterFor('telegram') as TelegramPlatformAdapter).status().polling);
}, 60_000);

afterAll(async () => {
  await platform?.stop().catch(() => undefined);
  await storage?.close().catch(() => undefined);
  await app?.close();
  process.env = savedEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** Push one owner message (`fields` replace `text`) and wait until the adapter polled past it. Returns its message id. */
async function push(fields: Record<string, unknown>): Promise<number> {
  updateSeq += 1;
  messageSeq += 1;
  const id = updateSeq;
  botApi.push({
    update_id: id,
    message: {
      message_id: messageSeq,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(TELEGRAM_OWNER), type: 'private' },
      from: { id: Number(TELEGRAM_OWNER), is_bot: false, first_name: 'Owner' },
      ...fields,
    },
  });
  await until(() => botApi.calls.some((call) => call.method === 'getUpdates' && call.params.offset === id + 1));
  return messageSeq;
}

/** Send `text` as the owner and wait for the next reply; returns its text. */
async function say(text: string): Promise<{ text: string }> {
  const before = botApi.sends().length;
  await push({ text });
  await until(() => botApi.sends().length > before);
  return { text: String((botApi.sends()[before] as Record<string, unknown>).text) };
}

describe('TG-2 acceptance — approvals are the existing text phrases on Telegram (ADR-0114 D10)', () => {
  it('preview → 승인 → "댓글 실행" executes the approved Jira comment exactly once, through the composite', async () => {
    const preview = await say('PROJ-12에 댓글 달아줘: TG-2 텔레그램 승인 확인');
    expect(preview.text).toContain('Jira 댓글 미리보기예요. 이 요청으로는 아직 아무것도 보내지 않았어요.');
    expect(preview.text).toContain('"댓글 실행"');
    expect((await say('댓글 실행')).text).toContain('승인을 기다리고 있어요');
    expect(comments).toEqual([]);
    expect((await say('승인')).text).toContain('승인을 기록했어요. 아직 실행하지 않았어요.');
    expect(comments).toEqual([]);

    // ADR-0114 D10 / #135: the approval is bound to the Telegram conversation; the same owner on Discord cannot run it.
    const fromDiscord = await runtime.handle({ id: 'tg2-discord-exec', context: discordDm, text: '댓글 실행', receivedAt: new Date().toISOString() });
    // The #135 cross-session guidance: nothing runs, and the owner is pointed back to the conversation that holds it.
    expect(fromDiscord.reply?.text).toContain('실행하지 않았어요. 승인된 Jira 댓글(PROJ-12)은 다른 대화에서 기다리고 있어요');
    expect(fromDiscord.reply?.text).not.toBe(renderNoApprovedConnectorWrite());
    expect(comments).toEqual([]);

    const sent = await say('댓글 실행');
    expect(sent.text).toContain('Jira 댓글 완료: 댓글을 달았어요.');
    expect(comments).toEqual([{ issueKey: 'PROJ-12', text: 'TG-2 텔레그램 승인 확인' }]);
    expect((await say('댓글 실행')).text).toContain('이미 실행했어요');
    expect(comments).toHaveLength(1);
    // Every reply went to the owner's Telegram chat as plain text; nothing reached Discord or the network.
    expect(botApi.sends().every((send) => send.chat_id === TELEGRAM_OWNER && send.parse_mode === undefined)).toBe(true);
    expect(discordSent).toEqual([]);
    expect(networkAttempts).toBe(0);
  });
});

describe('TG-2 acceptance — attachments through the real adapter (ADR-0114 D8, ADR-0111 D2/D3)', () => {
  it('a captioned photo is fetched after admission, canonicalized, and reaches only the image instance', async () => {
    const marker = 'TG2-METADATA-MARKER';
    const photo = pngWithText(marker);
    botApi.files.set('photo-large', { path: 'photos/file_1.jpg', bytes: photo });
    const before = executions.length;
    const sendsBefore = botApi.sends().length;
    await push({
      photo: [
        { file_id: 'photo-small', file_unique_id: 'us', width: 90, height: 90, file_size: 50 },
        { file_id: 'photo-large', file_unique_id: 'ul', width: 800, height: 600, file_size: photo.length },
      ],
      caption: '이 사진에 뭐가 보여?',
    });
    await until(() => botApi.sends().length > sendsBefore);
    const images = executions.slice(before).filter((execution) => execution.images.length > 0);
    expect(images).toHaveLength(1);
    expect(images[0]?.capability).toBe('IMAGE_UNDERSTANDING');
    const canonical = canonicalizeImage(photo, 'image/png');
    expect(canonical.ok && images[0]?.images[0]?.bytes.equals(canonical.bytes)).toBe(true);
    expect(images[0]?.images[0]?.bytes.includes(Buffer.from(marker))).toBe(false);
    expect(images[0]?.prompt).toContain('이 사진에 뭐가 보여?');
    // Only the largest size was fetched, once; the temp file lived only for the turn.
    expect(botApi.calls.filter((call) => call.method === 'getFile').map((call) => call.params.file_id)).toEqual(['photo-large']);
    expect(botApi.count('downloadFile')).toBe(1);
    await until(() => !existsSync(images[0]?.images[0]?.path as string));
    expect(botApi.sends().at(-1)).toMatchObject({ chat_id: TELEGRAM_OWNER });
    expect(String(botApi.sends().at(-1)?.text)).toContain(STUB_REPLY);
  });

  it('a credential-shaped text file is refused after download: one note, no provider call, nothing stored as content', async () => {
    const token = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    botApi.files.set('doc-secret', { path: 'documents/file_2.txt', bytes: Buffer.from(`deploy token ${token}\n`) });
    const before = executions.length;
    const sendsBefore = botApi.sends().length;
    await push({ document: { file_id: 'doc-secret', file_unique_id: 'ud', file_name: 'token.txt', mime_type: 'text/plain', file_size: 60 } });
    await until(() => botApi.sends().length >= sendsBefore + 2);
    const texts = botApi.sends().slice(sendsBefore).map((send) => String(send.text));
    expect(texts[0]).toContain('"token.txt" — 비밀번호·토큰 같은 자격 증명으로 보이는 내용이 있어 읽지 않고 버렸어요.');
    expect(texts.join('\n')).not.toContain(token);
    expect(executions.length).toBe(before);
  });

  it('a plain text file reaches the chat provider as untrusted readout next to the caption', async () => {
    botApi.files.set('doc-log', { path: 'documents/file_3.log', bytes: Buffer.from('2026-10-08 INFO TG2-LOG-LINE build ok\n') });
    const before = executions.length;
    const sendsBefore = botApi.sends().length;
    await push({ document: { file_id: 'doc-log', file_unique_id: 'ul2', file_name: 'build.log', mime_type: 'text/plain', file_size: 38 }, caption: '이 로그 요약해 줘' });
    await until(() => botApi.sends().length > sendsBefore);
    const run = executions.slice(before).find((execution) => execution.prompt.includes('TG2-LOG-LINE'));
    expect(run).toBeDefined();
    expect(run?.prompt).toContain('이 로그 요약해 줘');
  });

  it('oversized metadata is refused with no getFile and no download', async () => {
    const getFiles = botApi.count('getFile');
    const downloads = botApi.count('downloadFile');
    const sendsBefore = botApi.sends().length;
    await push({ document: { file_id: 'doc-huge', file_unique_id: 'uh', file_name: 'huge.png', mime_type: 'image/png', file_size: 9 * 1024 * 1024 } });
    await until(() => botApi.sends().length > sendsBefore);
    expect(String(botApi.sends()[sendsBefore]?.text)).toContain('"huge.png" — 너무 커서 받지 않았어요.');
    expect(botApi.count('getFile')).toBe(getFiles);
    expect(botApi.count('downloadFile')).toBe(downloads);
  });

  it('a stranger’s photo is never fetched and gets no reply', async () => {
    const getFiles = botApi.count('getFile');
    const sendsBefore = botApi.sends().length;
    updateSeq += 1;
    const id = updateSeq;
    botApi.files.set('stranger-photo', { path: 'photos/file_9.jpg', bytes: pngWithText('x') });
    botApi.push({
      update_id: id,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 5550999, type: 'private' }, from: { id: 5550999, is_bot: false, first_name: 'S' }, photo: [{ file_id: 'stranger-photo', file_unique_id: 'x', width: 1, height: 1, file_size: 10 }] },
    });
    await until(() => botApi.calls.some((call) => call.method === 'getUpdates' && call.params.offset === id + 1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(botApi.count('getFile')).toBe(getFiles);
    expect(botApi.sends()).toHaveLength(sendsBefore);
  });
});

describe('TG-2 acceptance — 👍/👎 feedback through message_reaction (ADR-0114 D9, ADR-0098 D3)', () => {
  const reaction = (messageId: number, emoji: string[], old: string[] = []) => {
    updateSeq += 1;
    const id = updateSeq;
    botApi.push({
      update_id: id,
      message_reaction: {
        chat: { id: Number(TELEGRAM_OWNER), type: 'private' },
        message_id: messageId,
        user: { id: Number(TELEGRAM_OWNER), is_bot: false, first_name: 'Owner' },
        date: Math.floor(Date.now() / 1000),
        old_reaction: old.map((value) => ({ type: 'emoji', emoji: value })),
        new_reaction: emoji.map((value) => ({ type: 'emoji', emoji: value })),
      },
    });
    return until(() => botApi.calls.some((call) => call.method === 'getUpdates' && call.params.offset === id + 1));
  };
  const summary = async () => {
    const actor = await app.get(ActorManager).resolveFromContext({ platform: 'telegram', channelId: TELEGRAM_OWNER, userId: TELEGRAM_OWNER, direct: true });
    return storage.feedback.summarize({ actorId: actor.id, since: '2026-01-01T00:00:00.000Z', recentNegativeLimit: 5 });
  };

  it('asks Telegram for message_reaction updates', () => {
    const poll = botApi.calls.filter((call) => call.method === 'getUpdates' && call.params.timeout !== 0).at(-1);
    expect(poll?.params.allowed_updates).toEqual(['message', 'message_reaction']);
  });

  it('the owner’s 👍 on a bot reply is recorded on that turn; on the owner’s own message nothing is recorded; no reply either way', async () => {
    const sendsBefore = botApi.sends().length;
    const ownMessage = await push({ text: '오늘 날씨 어때?' });
    await until(() => botApi.sends().length > sendsBefore);
    const replyId = 700 + botApi.count('sendMessage');
    const before = await summary();
    const positiveBefore = before.signals.find((signal) => signal.value === 'POSITIVE')?.count ?? 0;
    await reaction(ownMessage, ['\u{1F44D}']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await summary()).signals.find((signal) => signal.value === 'POSITIVE')?.count ?? 0).toBe(positiveBefore);
    await reaction(replyId, ['\u{1F44D}']);
    for (let i = 0; i < 200; i += 1) {
      const positive = (await summary()).signals.find((signal) => signal.value === 'POSITIVE')?.count ?? 0;
      if (positive === positiveBefore + 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await summary()).signals.find((signal) => signal.value === 'POSITIVE')?.count).toBe(positiveBefore + 1);
    expect(botApi.sends()).toHaveLength(sendsBefore + 1);
    expect(networkAttempts).toBe(0);
  });
});
