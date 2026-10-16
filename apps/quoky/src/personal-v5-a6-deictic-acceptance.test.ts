import 'reflect-metadata';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GMAIL_READONLY_SCOPE } from '@quoky/connector-gmail';
import type {
  Actor,
  AiProvider,
  AiRequest,
  CalendarEvent,
  CalendarReader,
  ConversationContext,
  InboundMessage,
  NlArgs,
  PlatformAdapter,
  StorageProvider,
  TurnResult,
} from '@quoky/core';

/**
 * ADR-0120 amendment A6 R5a (deictic writes) — end to end over the REAL recording path (§6.2, the NLA-8 pattern). The
 * production `AppModule` boots over a REAL SQLite file with `QUOKY_NL_INTENT_MODE=active`, `QUOKY_NL_ACTIONS=local` and
 * `QUOKY_NL_DEICTIC_WRITES=on`; every turn goes through the production `ConversationRuntime`, so `quoky.lastTurn`, the
 * SHORT_TERM history, the listings and `lastAction` are written by real turns, never by fixtures. Only the edges are
 * replaced: one scripted `fetch` (Google OAuth and Gmail), a calendar reader fixture, and stub AI providers whose
 * `INTENT_SELECTION` answer the test scripts. No model call, no network.
 */

const OWNER = '111111111111111113';
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
const SELECTION = 'INTENT_SELECTION';
const SUMMARIZATION = 'SUMMARIZATION';
const CHAT_REPLY = 'R5a stub chat reply';
const SUMMARY = 'R5a stub summary';
const GMAIL_REFRESH = 'r5a-gmail-refresh-placeholder';
const CANARY = 'CANARY-R5A-3311';

const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
const answer = (entryId: string, args: NlArgs = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });
const todoAdd = (title: string) => answer('todo.add', { title });
const reminderCreate = (body: string, when?: string) => answer('reminder.create', { body, ...(when !== undefined ? { when } : {}) });

const MAILS = [{ id: 'mail-1', from: '김철수 <kim@example.com>', subject: '분기 보고서', body: `분기 보고서를 금요일까지 검토해 주세요. ${CANARY}` }];

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('Personal v5 - A6 R5a deictic writes over the production AppModule (§6.2)', () => {
  let tempDir = '';
  let savedEnv: NodeJS.ProcessEnv = {};
  let closeApp: (() => Promise<void>) | undefined;
  let core: typeof import('@quoky/core');
  let runtime: { handle(message: InboundMessage): Promise<TurnResult> };
  let storage: StorageProvider;
  let ownerActor: Actor;
  let service: {
    observeDelivery(turn: { messageId: string; context: ConversationContext; sessionId: string; status: string; platformMessageIds: readonly string[] }): Promise<void>;
    actionCaps: { windows: Map<string, number[]> };
    deictic: { previewCaps: { windows: Map<string, number[]> } };
  };
  let selectorAnswer = none;
  const requests: AiRequest[] = [];
  let seq = 0;
  let channelSeq = 0;
  let events: CalendarEvent[] = [];

  beforeAll(async () => {
    for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), 'quoky-r5a-'));
    const gmailToken = join(tempDir, 'gmail.json');
    writeFileSync(gmailToken, JSON.stringify({ version: 1, scope: GMAIL_READONLY_SCOPE, refresh_token: GMAIL_REFRESH }), { mode: 0o600 });
    chmodSync(gmailToken, 0o600);
    vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
      const parsed = new URL(String(input));
      if (parsed.origin === 'https://oauth2.googleapis.com' && parsed.pathname === '/token') {
        return json({ access_token: 'r5a-access-placeholder', expires_in: 3600, token_type: 'Bearer', scope: GMAIL_READONLY_SCOPE });
      }
      if (parsed.origin === 'https://gmail.googleapis.com') {
        if (parsed.pathname === '/gmail/v1/users/me/messages') return json({ messages: MAILS.map((mail) => ({ id: mail.id })) });
        if (parsed.pathname.startsWith('/gmail/v1/users/me/threads/')) return json({ id: parsed.pathname.split('/').pop(), messages: MAILS.map((mail) => ({ id: mail.id })) });
        const mail = MAILS.find((entry) => entry.id === parsed.pathname.split('/').pop());
        if (mail === undefined) return json({}, 404);
        const headers = [{ name: 'From', value: mail.from }, { name: 'Subject', value: mail.subject }];
        const meta = { id: mail.id, threadId: `thread-${mail.id}`, labelIds: ['INBOX', 'UNREAD'], snippet: '', internalDate: String(Date.now() - 3_600_000), payload: { headers } };
        return parsed.searchParams.get('format') === 'full' ? json({ ...meta, payload: { mimeType: 'text/plain', headers, body: { data: b64(mail.body) } } }) : json(meta);
      }
      throw new Error('R5a acceptance: network is not available in this test');
    });
    Object.assign(process.env, {
      QUOKY_DISCORD_OWNER_IDS: OWNER,
      QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
      QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
      QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
      QUOKY_OLLAMA_ENABLED: 'false',
      CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
      QUOKY_REMINDERS_ENABLED: 'true',
      QUOKY_TIMEZONE: 'Asia/Seoul',
      QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'r5a-calendar-client',
      QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'r5a-calendar-client-placeholder',
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'r5a-calendar-refresh-placeholder',
      QUOKY_GMAIL_TOKEN_FILE: gmailToken,
      QUOKY_NL_INTENT_MODE: 'active',
      QUOKY_NL_ACTIONS: 'local',
      QUOKY_NL_DEICTIC_WRITES: 'on',
    });
    vi.resetModules();
    core = await import('@quoky/core');
    const { AppModule } = await import('./app.module');
    const { stubProviderSelection } = await import('./provider-selection/test-support');
    const { ActorIdentityProvisioner } = await import('./actor-identity-provisioner');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    storage = app.get<StorageProvider>(core.STORAGE_PROVIDER);
    await storage.init();
    await app.get<{ init(): Promise<void> }>(core.VECTOR_PROVIDER).init();
    closeApp = async () => {
      await storage.close().catch(() => undefined);
      await app.close().catch(() => undefined);
    };
    const stub = (provider: AiProvider): void => {
      Object.assign(provider, {
        async isAvailable() {
          return true;
        },
        async execute(request: AiRequest) {
          requests.push(request);
          if (request.capability === SELECTION) return { text: selectorAnswer, artifacts: [] };
          if (request.capability === SUMMARIZATION) return { text: SUMMARY, artifacts: [] };
          return { text: CHAT_REPLY, artifacts: [] };
        },
      });
    };
    for (const provider of app.get<AiProvider[]>(core.AI_PROVIDERS)) stub(provider);
    stubProviderSelection(app, stub);
    Object.assign(app.get<CalendarReader>(core.CALENDAR_READER) as object, { listEvents: async () => events });
    await app.get(ActorIdentityProvisioner).provision();
    Object.assign(app.get<PlatformAdapter>(core.PLATFORM_ADAPTER) as object, { start: async () => undefined, stop: async () => undefined, sendTyping: async () => undefined, sendMessage: async () => undefined });
    runtime = app.get(core.ConversationRuntime);
    service = (runtime as unknown as { deps: { nlSelection: typeof service } }).deps.nlSelection;
    await runtime.handle({ id: 'r5a-hello', context: dm(), text: '안녕', receivedAt: new Date().toISOString() });
    const actor = await storage.actors.findByExternalIdentity('discord', OWNER);
    if (actor === null) throw new Error('owner actor missing');
    ownerActor = actor;
  }, 120_000);

  afterAll(async () => {
    await closeApp?.();
    process.env = savedEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    selectorAnswer = none;
    service.actionCaps.windows.clear();
    service.deictic.previewCaps.windows.clear();
  });

  /** A fresh owner DM (its own session), so every scenario starts with no earlier turn. */
  function dm(): ConversationContext {
    channelSeq += 1;
    return { platform: 'discord', channelId: `9300000000000${String(channelSeq).padStart(5, '0')}`, userId: OWNER, direct: true };
  }

  async function turn(context: ConversationContext, text: string, selector = none, extra: Partial<InboundMessage> = {}) {
    selectorAnswer = selector;
    const start = requests.length;
    seq += 1;
    const id = `r5a-${seq}`;
    const result = await runtime.handle({ id, context, text, receivedAt: new Date().toISOString(), ...extra });
    const made = requests.slice(start);
    return { id, result, text: result.reply.text, selects: made.filter((request) => request.capability === SELECTION) };
  }

  const todos = async () => (await storage.workItems.listByActor(ownerActor.id)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const activeTitles = async () => (await todos()).filter((item) => item.status === 'ACTIVE').map((item) => item.title);
  const reminders = async () => storage.reminders?.listActiveByActor(ownerActor.id) ?? [];
  const session = async (context: ConversationContext) => {
    const found = await storage.sessions.findActiveByContext(context.platform, context.channelId, context.threadId);
    if (found === null) throw new Error('no session');
    return found;
  };
  const lastTurn = async (context: ConversationContext) => core.readLastTurn((await session(context)).metadata?.[core.LAST_TURN_METADATA_KEY], ownerActor.id, new Date().toISOString());
  const draft = async (context: ConversationContext) => core.readDeicticDraft((await session(context)).metadata?.[core.DEICTIC_DRAFT_METADATA_KEY], ownerActor.id);
  async function editMetadata(context: ConversationContext, edit: (metadata: Record<string, unknown>) => void): Promise<void> {
    const current = await session(context);
    const metadata = { ...(current.metadata ?? {}) };
    edit(metadata);
    await storage.sessions.save({ ...current, metadata });
  }

  /** "UAT 결과 정리" → Quoky asks (a payload with no request) → a deictic write previews the owner's own line. */
  async function previewOwnerLine(context: ConversationContext, line = 'UAT 결과 정리') {
    const asked = await turn(context, line, todoAdd(line));
    expect(asked.text).toBe('무엇을/어느 항목을 다시 말씀해 주세요.');
    return turn(context, '그걸로 할 일 만들어줘', todoAdd('그걸로'));
  }

  it('composes the service with QUOKY_NL_DEICTIC_WRITES=on over QUOKY_NL_ACTIONS=local', () => {
    const composed = service as unknown as { deicticWritesMode(): string; actionLevel(): string };
    expect(composed.deicticWritesMode()).toBe('on');
    expect(composed.actionLevel()).toBe('local');
  });

  // ── owner message → preview → "응" → the same text, undo by the per-action inverse ───────────────────────────────

  it('owner message: the preview shows the exact line, nothing is written, "응" adds it with no selector call, "되돌려줘" cancels that to-do', async () => {
    const context = dm();
    const before = (await todos()).length;
    const preview = await previewOwnerLine(context);
    expect(preview.text).toContain('할 일로 추가할까요?');
    expect(preview.text).toContain('> UAT 결과 정리');
    expect(preview.text).toMatch(/출처: 보내신 메시지 \(\d{2}:\d{2}\)/u);
    expect(preview.text).toContain('맞으면 "응", 아니면 "아니"라고 답해 주세요.');
    expect((await todos()).length).toBe(before);
    expect((await lastTurn(context))?.reply.kind).toBe('preview');
    const approved = await turn(context, '응', todoAdd('응'));
    expect(approved.selects).toHaveLength(0);
    expect(approved.text).toMatch(/^할 일 \d+번으로 추가했어요: "UAT 결과 정리" · 되돌리려면 "되돌려줘" \(10분 안\)$/u);
    const added = (await todos()).at(-1);
    expect(added?.title).toBe('UAT 결과 정리');
    expect(await draft(context)).toBeUndefined();
    const undo = await turn(context, '되돌려줘', answer('action.undo'));
    expect(undo.text).toContain('UAT 결과 정리');
    expect((await storage.workItems.get(added?.id ?? ''))?.status).toBe('CANCELED');
  });

  it('origin word: after a chat reply "내가 말한 거 할 일로 추가해줘" previews the owner line; "네가 말한 거" is model-drafted', async () => {
    const context = dm();
    await turn(context, '분기 보고 초안 쓰기');
    const mine = await turn(context, '내가 말한 거 할 일로 추가해줘', todoAdd('내가 말한 거'));
    expect(mine.text).toContain('> 분기 보고 초안 쓰기');
    await turn(context, '아니');
    await turn(context, '오늘 뭐 할까?');
    const yours = await turn(context, '네가 말한 거 할 일로 추가해줘', todoAdd('네가 말한 거'));
    expect(yours.text).toBe('제 답변 내용은 아직 바로 옮기지 않아요. 추가할 내용을 직접 적어 주세요.');
    expect(await draft(context)).toBeUndefined();
  });

  // ── lastAction echo → reminder with the owner's own time ─────────────────────────────────────────────────────────

  it('echo: after an added to-do, "방금 거 알림으로 걸어줘 내일 9시" previews a reminder; "어" creates it; "되돌려줘" cancels the same #N', async () => {
    const context = dm();
    await turn(context, '할 일 추가: 주간 보고 제출');
    const preview = await turn(context, '방금 거 알림으로 걸어줘 내일 9시', reminderCreate('방금 거', '내일 9시'));
    expect(preview.text).toContain('알림으로 만들까요?');
    expect(preview.text).toContain('> 주간 보고 제출');
    expect(preview.text).toMatch(/언제: \d+월 \d+일\(.\) 오전 9:00 · 한 번/u);
    expect(preview.text).toMatch(/출처: 할 일/u);
    const before = (await reminders()).length;
    const created = await turn(context, '어');
    expect(created.selects).toHaveLength(0);
    const made = (await reminders()).find((reminder) => reminder.body === '주간 보고 제출');
    expect(made).toBeDefined();
    expect((await reminders()).length).toBe(before + 1);
    const undo = await turn(context, '되돌려줘', answer('action.undo'));
    expect(undo.text).toContain(`#${made?.displayNo}`);
    expect(await reminders()).not.toContainEqual(expect.objectContaining({ id: made?.id }));
  });

  it('a reminder without a time asks "언제 알려 드릴까요?"; the owner\'s next words give it, into a preview, never an execution', async () => {
    const context = dm();
    await turn(context, '할 일 추가: 은행 서류 챙기기');
    const asked = await turn(context, '그거 알림으로 걸어줘', reminderCreate('그거'));
    expect(asked.text).toBe('언제 알려 드릴까요?');
    const before = (await reminders()).length;
    const preview = await turn(context, '내일 오전 10시', none);
    expect(preview.selects).toHaveLength(0);
    expect(preview.text).toContain('> 은행 서류 챙기기');
    expect(preview.text).toContain('오전 10:00');
    expect((await reminders()).length).toBe(before);
    await turn(context, '네');
    expect((await reminders()).some((reminder) => reminder.body === '은행 서류 챙기기')).toBe(true);
  });

  it('a listing of several to-dos asks which one (no pre-selection); "2번" resumes into a preview of the SHOWN 2', async () => {
    const context = dm();
    for (const title of ['리스트 가', '리스트 나']) await turn(context, `할 일 추가: ${title}`);
    const listed = await turn(context, '내 할 일 보여줘');
    expect(listed.text).toContain('리스트 나');
    const asked = await turn(context, '그거 알림으로 걸어줘 내일 9시', reminderCreate('그거', '내일 9시'));
    expect(asked.text).toContain('어느 걸 알림으로 만들까요?');
    expect(asked.text).toContain('리스트 가');
    expect(await draft(context)).toMatchObject({ stage: 'choose' });
    const open = (await todos()).filter((item) => item.status === 'ACTIVE');
    const label = open.findIndex((item) => item.title === '리스트 나') + 1;
    const preview = await turn(context, `${label}번`);
    expect(preview.selects).toHaveLength(0);
    expect(preview.text).toContain('> 리스트 나');
    expect(await draft(context)).toMatchObject({ stage: 'preview' });
  });

  // ── the draft lifecycle (§3.2) ───────────────────────────────────────────────────────────────────────────────────

  it.each([
    ['아니', '추가하지 않았어요.'],
    ['취소', '추가하지 않았어요.'],
    ['아니요.', '추가하지 않았어요.'],
    ['되돌려줘', '아직 추가하지 않았어요. 미리보기를 취소했어요.'],
  ])('deny "%s": no selector call, nothing written, the older lastAction is not undone', async (reply, expected) => {
    const context = dm();
    await turn(context, '할 일 추가: 남겨 둘 일');
    const kept = (await todos()).at(-1);
    await previewOwnerLine(context, '거부 시험 항목');
    const before = (await todos()).length;
    const denied = await turn(context, reply, answer('action.undo'));
    expect(denied.selects).toHaveLength(0);
    expect(denied.text).toBe(expected);
    expect((await todos()).length).toBe(before);
    expect((await storage.workItems.get(kept?.id ?? ''))?.status).toBe('ACTIVE');
    expect(await draft(context)).toBeUndefined();
  });

  it.each(['응 👍', '응 근데 내일 할게', '응?', '좋아 그거 말고'])('"%s" is not an approval: the preview is dropped with its prefix and the turn is handled normally', async (reply) => {
    const context = dm();
    await previewOwnerLine(context, '혼합 응답 항목');
    const before = (await todos()).length;
    const result = await turn(context, reply);
    expect(result.text.startsWith('미리보기는 취소했어요.\n')).toBe(true);
    expect(result.selects.length).toBeLessThanOrEqual(1);
    expect((await todos()).length).toBe(before);
    expect(await draft(context)).toBeUndefined();
  });

  it('expiry: an approval after 5 minutes gets "미리보기가 만료됐어요" and writes nothing', async () => {
    const context = dm();
    await previewOwnerLine(context, '만료 시험 항목');
    await editMetadata(context, (metadata) => {
      const pending = core.readDeicticDraft(metadata[core.DEICTIC_DRAFT_METADATA_KEY], ownerActor.id);
      if (pending === undefined) throw new Error('no draft');
      metadata[core.DEICTIC_DRAFT_METADATA_KEY] = core.withDeicticDraft(undefined, ownerActor.id, { ...pending, at: new Date(Date.now() - 6 * 60_000).toISOString() }, new Date(Date.now() - 6 * 60_000).toISOString());
    });
    const before = (await todos()).length;
    const late = await turn(context, '응');
    expect(late.text).toBe('미리보기가 만료됐어요. 아무것도 추가하지 않았어요.');
    expect((await todos()).length).toBe(before);
  });

  it('one next-turn question per session (A6-D3a amendment 1): an undo confirmation drops the draft; with both open, "응" answers the undo', async () => {
    const context = dm();
    await previewOwnerLine(context, '충돌 첫 항목');
    await turn(context, '응');
    const first = (await todos()).at(-1);
    expect(first?.title).toBe('충돌 첫 항목');
    const label = (await todos()).filter((entry) => entry.status === 'ACTIVE').findIndex((entry) => entry.id === first?.id) + 1;
    await previewOwnerLine(context, '충돌 둘째 항목');
    const pending = (await session(context)).metadata?.[core.DEICTIC_DRAFT_METADATA_KEY];
    expect(await draft(context)).toBeDefined();
    // The natural flow: the descriptive undo is no answer to the preview (dropped with its prefix), then asks the confirmation.
    const asked = await turn(context, '되돌려 주신 기능 설명해줘', answer('action.undo'));
    expect(asked.text).toBe(`미리보기는 취소했어요.\n방금 한 '할 일 ${label}번 추가'를 되돌릴까요? (응 / 아니)`);
    expect(await draft(context)).toBeUndefined();
    // A race the runtime never produces itself: the old draft is back next to the open confirmation.
    await editMetadata(context, (metadata) => {
      metadata[core.DEICTIC_DRAFT_METADATA_KEY] = pending;
    });
    const before = (await todos()).length;
    const confirmed = await turn(context, '응');
    expect(confirmed.selects).toHaveLength(0);
    expect(confirmed.text).toContain('충돌 첫 항목');
    expect((await storage.workItems.get(first?.id ?? ''))?.status).toBe('CANCELED');
    expect((await todos()).length).toBe(before);
    expect(await activeTitles()).not.toContain('충돌 둘째 항목');
    expect(await draft(context)).toBeUndefined();
  });

  it('next turn only: any other turn in between ends the preview, a later "응" adds nothing', async () => {
    const context = dm();
    await previewOwnerLine(context, '다음 턴 시험');
    await turn(context, '도움말');
    const before = (await todos()).length;
    await turn(context, '응');
    expect((await todos()).length).toBe(before);
  });

  it('a double "응" adds once; the second is an ordinary turn', async () => {
    const context = dm();
    await previewOwnerLine(context, '두 번 응 항목');
    const before = (await todos()).length;
    await turn(context, '응');
    await turn(context, '응');
    expect((await todos()).length).toBe(before + 1);
  });

  it('platform replies: "응" replying to an older preview is refused; replying to the current preview approves it', async () => {
    const context = dm();
    const first = await previewOwnerLine(context, '플랫폼 응답 가');
    const firstSession = await session(context);
    await service.observeDelivery({ messageId: first.id, context, sessionId: firstSession.id, status: 'RESPONDED', platformMessageIds: ['preview-old'] });
    await turn(context, '아니');
    const second = await previewOwnerLine(context, '플랫폼 응답 나');
    await service.observeDelivery({ messageId: second.id, context, sessionId: firstSession.id, status: 'RESPONDED', platformMessageIds: ['preview-new'] });
    expect((await draft(context)) as { previewReplyIds?: string[] }).toMatchObject({ previewReplyIds: ['preview-new'] });
    const before = (await todos()).length;
    const stale = await turn(context, '응', none, { replyTo: { messageId: 'preview-old' } });
    expect(stale.text).toBe('그 미리보기는 끝났어요. 아무것도 추가하지 않았어요.');
    expect((await todos()).length).toBe(before);
    await previewOwnerLine(context, '플랫폼 응답 셋');
    const third = (await lastTurn(context))?.requestId as string;
    await service.observeDelivery({ messageId: third, context, sessionId: firstSession.id, status: 'RESPONDED', platformMessageIds: ['preview-third'] });
    await turn(context, '응', none, { replyTo: { messageId: 'preview-third' } });
    expect(await activeTitles()).toContain('플랫폼 응답 셋');
  });

  it('concurrency: two parallel "응" on one draft write exactly once, under the session lock', async () => {
    const context = dm();
    await previewOwnerLine(context, '동시 승인 항목');
    const before = (await todos()).length;
    seq += 2;
    const [a, b] = await Promise.all([
      runtime.handle({ id: `r5a-par-${seq}a`, context, text: '응', receivedAt: new Date().toISOString() }),
      runtime.handle({ id: `r5a-par-${seq}b`, context, text: '응', receivedAt: new Date().toISOString() }),
    ]);
    expect((await todos()).length).toBe(before + 1);
    expect([a.reply.text, b.reply.text]).toContain('이미 처리했어요.');
  });

  // ── integrity (§3.3) ─────────────────────────────────────────────────────────────────────────────────────────────

  it('a hash change after the owner message was edited, or after it was forgotten, writes nothing', async () => {
    for (const edit of ['redact', 'delete'] as const) {
      const context = dm();
      await previewOwnerLine(context, `무결성 ${edit}`);
      const turnRecord = await lastTurn(context);
      const pending = await draft(context);
      expect(pending?.stage).toBe('preview');
      const memoryId = pending?.stage === 'preview' && pending.referent.kind === 'owner.message' ? pending.referent.memoryId : '';
      expect(turnRecord).toBeDefined();
      const record = await storage.memories.get(memoryId);
      if (record === null) throw new Error('no memory');
      if (edit === 'redact') await storage.memories.save({ ...record, content: '[편집됨]' });
      else await storage.memories.delete(memoryId);
      const before = (await todos()).length;
      const result = await turn(context, '응');
      expect(result.text).toBe('그 내용을 찾을 수 없어서 추가하지 않았어요.');
      expect((await todos()).length).toBe(before);
    }
  });

  it('another session (the same owner elsewhere) confirms nothing; a channel never previews', async () => {
    const context = dm();
    await previewOwnerLine(context, '다른 세션 항목');
    const before = (await todos()).length;
    await turn(dm(), '응');
    expect((await todos()).length).toBe(before);
    const channel: ConversationContext = { platform: 'discord', channelId: '930099999999999999', userId: OWNER, direct: false, spaceId: '930088888888888888' };
    await turn(channel, '할 일 추가: 채널 항목');
    const refused = await turn(channel, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(refused.text).not.toContain('할 일로 추가할까요?');
    expect(await storage.sessions.findActiveByContext(channel.platform, channel.channelId).then((found) => found?.metadata?.[core.DEICTIC_DRAFT_METADATA_KEY])).toBeUndefined();
  });

  // ── provenance (§6.2) ────────────────────────────────────────────────────────────────────────────────────────────

  it('an unmarked multi-line paste is recorded as ineligible; "그거 할 일로 추가해줘" then previews nothing', async () => {
    const context = dm();
    const pasted = await turn(context, 'UAT 결과\n정리하기', todoAdd('UAT 결과'));
    expect(pasted.text).toContain('아무것도 실행하지 않았어요');
    expect((await lastTurn(context))?.owner).toMatchObject({ eligible: false, reason: 'multiline' });
    const result = await turn(context, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(result.text).toBe('내용을 직접 적어 주세요.');
    expect(await draft(context)).toBeUndefined();
  });

  it.each([
    ['quoted', { quotedRanges: [{ start: 0, end: 4 }] }],
    ['attachment', { attachments: [{ kind: 'text', name: 'a.txt', mimeType: 'text/plain', text: 'x', sizeBytes: 1 }] }],
    ['fenced', { formatting: { code: true } }],
  ] as const)('a %s owner message is ineligible at receipt', async (reason, extra) => {
    const context = dm();
    await turn(context, '분기 결산 정리', todoAdd('분기 결산 정리'), extra as Partial<InboundMessage>);
    expect((await lastTurn(context))?.owner).toMatchObject({ eligible: false, reason });
    await turn(context, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(await draft(context)).toBeUndefined();
  });

  it('event-relative reminders (BRF-2), with and without owner words, are never referents', async () => {
    const start = new Date(Date.now() + 3 * 3_600_000).toISOString();
    events = [{ id: 'evt-1', title: `주간 회의 ${CANARY}`, start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), allDay: false, status: 'confirmed', calendarName: '기본' }];
    const context1 = dm();
    const plain = await turn(context1, '회의 10분 전에 알려줘');
    expect(plain.selects).toHaveLength(0);
    const linked = (await reminders()).find((reminder) => reminder.event !== undefined);
    expect(linked).toBeDefined();
    const refused = await turn(context1, '그 알림 할 일로 추가해줘', todoAdd('그 알림'));
    expect(refused.text).toBe('그 내용은 그대로 옮길 수 없어요. 추가할 내용을 직접 적어 주세요.');
    expect(await draft(context1)).toBeUndefined();
    const context2 = dm();
    const worded = await turn(context2, '회의 10분 전에 자료 출력 알려줘', reminderCreate('자료 출력', '회의 10분 전'));
    expect(worded.text).toContain('자료 출력');
    const refused2 = await turn(context2, '그 알림 할 일로 추가해줘', todoAdd('그 알림'));
    expect(refused2.text).toBe('그 내용은 그대로 옮길 수 없어요. 추가할 내용을 직접 적어 주세요.');
    expect((await todos()).some((item) => item.title?.includes('자료 출력') || item.title?.includes(CANARY))).toBe(false);
    events = [];
  });

  it('a mail summary is a note (external-origin); a chat answer right after it is model-drafted; no preview either way', async () => {
    const context = dm();
    await turn(context, '안 읽은 메일 보여줘');
    const summary = await turn(context, '1번 메일 요약해줘', answer('item.summarize', { source: 'mail', ref: '#1', mode: 'summary' }));
    expect(summary.text).toContain(SUMMARY);
    expect((await lastTurn(context))?.reply.kind).toBe('note');
    const external = await turn(context, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(external.text).toBe('메일·문서·일정 같은 외부 내용은 그대로 옮기지 않아요. 추가할 내용을 직접 적어 주세요.');
    await turn(context, '그 메일 어때?');
    expect((await lastTurn(context))?.reply.kind).toBe('chat');
    const drafted = await turn(context, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(drafted.text).toBe('제 답변 내용은 아직 바로 옮기지 않아요. 추가할 내용을 직접 적어 주세요.');
    expect((await todos()).some((item) => item.title?.includes(CANARY) || item.title === SUMMARY || item.title === CHAT_REPLY)).toBe(false);
  });

  it('a turn recorded before the flag was on (no lastTurn) is ineligible: today\'s reply', async () => {
    const context = dm();
    await turn(context, '예전 메시지 정리', todoAdd('예전 메시지 정리'));
    await editMetadata(context, (metadata) => delete metadata[core.LAST_TURN_METADATA_KEY]);
    const result = await turn(context, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(result.text).toBe('내용을 직접 적어 주세요.');
    expect(await draft(context)).toBeUndefined();
  });

  it('ASSISTANT_GENERATED and CANONICAL_PROJECT durable memories in a chat turn: its answer is never a referent (pins the R5b join)', async () => {
    const context = dm();
    const now = new Date().toISOString();
    for (const provenance of ['ASSISTANT_GENERATED', 'CANONICAL_PROJECT']) {
      await storage.memories.save({ id: `r5a-durable-${provenance}`, type: core.MemoryType.LONG_TERM, scope: { userId: OWNER }, content: `${CANARY} ${provenance}`, metadata: { provenance }, createdAt: now, updatedAt: now });
    }
    await turn(context, '요즘 할 만한 거 알려줄래?');
    const result = await turn(context, '네 답변 할 일로 추가해줘', todoAdd('네 답변'));
    expect(result.text).toBe('제 답변 내용은 아직 바로 옮기지 않아요. 추가할 내용을 직접 적어 주세요.');
    const plain = await turn(context, '그거 할 일로 추가해줘', todoAdd('그거'));
    expect(plain.text).not.toContain('할 일로 추가할까요?');
    expect((await todos()).some((item) => item.title?.includes(CANARY) || item.title === CHAT_REPLY)).toBe(false);
  });

  it('the kill switch: while stopped nothing previews; a preview approved after a stop writes nothing', async () => {
    const context = dm();
    await previewOwnerLine(context, '중지 시험 항목');
    const actor = (await storage.actors.get(ownerActor.id)) as Actor;
    await storage.actors.save({ ...actor, metadata: { ...(actor.metadata ?? {}), 'quoky.actionSwitch': { state: 'stopped', at: new Date().toISOString() } } });
    const before = (await todos()).length;
    await turn(context, '응');
    expect((await todos()).length).toBe(before);
    const fresh = (await storage.actors.get(ownerActor.id)) as Actor;
    const { ['quoky.actionSwitch']: _switch, ...metadata } = fresh.metadata ?? {};
    await storage.actors.save({ ...fresh, metadata });
  });

  // ── question / statement negatives and the vocabulary additions (D5) ────────────────────────────────────────────

  it.each([
    ['할 일 만들기 어떻게 해?', todoAdd('만들기')],
    ['알림으로 걸려면 어떻게 해?', reminderCreate('그거', '내일 9시')],
    ['알림으로 설정돼 있어?', reminderCreate('설정')],
    ['그 할 일 만들어진 거 맞지?', todoAdd('그 할 일')],
  ])('"%s" never previews or writes', async (text, selector) => {
    const context = dm();
    await turn(context, '할 일 추가: 부정 시험 기준');
    const before = { todos: (await todos()).length, reminders: (await reminders()).length };
    const result = await turn(context, text, selector);
    expect(result.text).not.toContain('추가할까요?');
    expect(result.text).not.toContain('만들까요?');
    expect(await draft(context)).toBeUndefined();
    expect((await todos()).length).toBe(before.todos);
    expect((await reminders()).length).toBe(before.reminders);
  });

  it('the vocabulary additions ground ordinary requests: "할일 만들어줘", "알림으로 걸어줘"', async () => {
    const context = dm();
    await turn(context, '보고서 검토 할일 만들어줘', todoAdd('보고서 검토'));
    expect(await activeTitles()).toContain('보고서 검토');
    const reminded = await turn(context, '내일 9시 물 마시기 알림으로 걸어줘', reminderCreate('물 마시기', '내일 9시'));
    expect(reminded.text).toContain('물 마시기');
  });
});
