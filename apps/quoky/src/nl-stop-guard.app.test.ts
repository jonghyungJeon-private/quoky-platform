import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, AiProvider, AiRequest, CalendarEvent, CalendarEventWriter, CalendarReader, InboundMessage, PlatformAdapter, StorageProvider } from '@quoky/core';

/**
 * ADR-0120 A6-D3 amendment (2026-11-03): `에이전트 중지` closes the owner's open undo approvals and lists them; the exact
 * execution phrase re-reads the switch; `에이전트 재개` does not reopen; a write already started finishes. Real `AppModule`,
 * real SQLite file, recording calendar stubs, closed network, no model calls (the selector answers `none`).
 */
const OWNER = '111111111111111118';
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
const NONE = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
const STOP_REPLY = '자연어 실행을 멈췄어요. 정확한 명령(예: "할 일 추가: …")은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.';

describe('kill switch closes open approvals and is re-checked at execution', () => {
  let tempDir = '';
  let savedEnv: NodeJS.ProcessEnv = {};
  let closeApp: (() => Promise<void>) | undefined;
  let core: typeof import('@quoky/core');
  let runtime: { handle(message: InboundMessage): Promise<{ status?: string; reply: { text: string } }> };
  let storage: StorageProvider;
  let owner: Actor;
  const writerCalls: string[] = [];
  const live: { events: CalendarEvent[] } = { events: [] };
  let deleteGate: Promise<void> | undefined;
  let deleteStarted: (() => void) | undefined;
  let eventSeq = 0;
  let createSeq = 0;
  let seq = 0;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), 'quoky-stop-guard-'));
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new Error('stop guard test: network is not available');
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
      QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'sg-calendar-client',
      QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'sg-calendar-client-placeholder',
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'sg-calendar-refresh-placeholder',
      QUOKY_CALENDAR_WRITE_ENABLED: 'true',
      QUOKY_NL_INTENT_MODE: 'active',
      QUOKY_NL_ACTIONS: 'local',
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
          return { text: request.capability === 'INTENT_SELECTION' ? NONE : '대화 응답입니다.', artifacts: [] };
        },
      });
    };
    for (const provider of app.get<AiProvider[]>(core.AI_PROVIDERS)) stub(provider);
    stubProviderSelection(app, stub);
    const writer = app.get<CalendarEventWriter>(core.CALENDAR_EVENT_WRITER);
    Object.assign(writer, {
      async createEvent(request: { draft: { title: string; time: { start?: string; end?: string } } }) {
        writerCalls.push('createEvent');
        eventSeq += 1;
        const id = `evt${String(eventSeq).padStart(5, '0')}`;
        live.events.push({ id, title: request.draft.title, start: request.draft.time.start as string, end: request.draft.time.end as string, allDay: false, status: 'confirmed', calendarName: 'primary', version: `"v-made-${eventSeq}"` });
        return core.connectorWriteSent(id, undefined, `"v-made-${eventSeq}"`);
      },
      async updateEvent(request: { eventId: string }) {
        writerCalls.push('updateEvent');
        return core.connectorWriteSent(request.eventId);
      },
      async deleteEvent(request: { eventId: string }) {
        writerCalls.push('deleteEvent');
        deleteStarted?.();
        if (deleteGate !== undefined) await deleteGate;
        live.events = live.events.filter((candidate) => candidate.id !== request.eventId);
        return core.connectorWriteSent(request.eventId);
      },
    });
    const readerStub = {
      async listEvents(): Promise<CalendarEvent[]> {
        return live.events;
      },
      async getEvent(_calendarId: string, eventId: string): Promise<CalendarEvent | undefined> {
        return live.events.find((candidate) => candidate.id === eventId);
      },
    };
    Object.assign(app.get<CalendarReader>(core.CALENDAR_READER) as object, readerStub);
    await app.get(ActorIdentityProvisioner).provision();
    Object.assign(app.get<PlatformAdapter>(core.PLATFORM_ADAPTER) as object, { start: async () => undefined, stop: async () => undefined, sendTyping: async () => undefined, sendMessage: async () => undefined });
    runtime = app.get(core.ConversationRuntime) as typeof runtime;
    const deps = (runtime as unknown as { deps: { connectorWriteFlow: { deps: { calendarReader: object } } | null } }).deps;
    if (deps.connectorWriteFlow === null) throw new Error('the connector-write flow is not bound');
    Object.assign(deps.connectorWriteFlow.deps.calendarReader, readerStub);
    await runtime.handle({ id: 'sg-hello', context: { platform: 'discord', channelId: '777000000000000001', userId: OWNER, direct: true }, text: '안녕', receivedAt: new Date().toISOString() });
    const actor = await storage.actors.findByExternalIdentity('discord', OWNER);
    if (actor === null) throw new Error('owner actor missing');
    owner = actor;
  }, 120_000);

  afterAll(async () => {
    await closeApp?.();
    process.env = savedEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    writerCalls.length = 0;
    deleteGate = undefined;
    deleteStarted = undefined;
    live.events = [];
    for (const task of await storage.tasks.list()) {
      const anchor = (task.metadata as { connectorWriteAnchor?: { status?: string } } | undefined)?.connectorWriteAnchor;
      if (anchor?.status !== undefined && ['AWAITING_CHOICE', 'APPROVAL_PENDING', 'APPROVED', 'EXECUTING'].includes(anchor.status)) {
        await storage.tasks.save({ ...task, metadata: { ...(task.metadata ?? {}), connectorWriteAnchor: { ...anchor, status: 'CLOSED', closedReason: 'cancelled' } } });
      }
    }
    await setSwitch(undefined);
  });

  const dm = () => ({ platform: 'discord', channelId: `88${String((seq += 1)).padStart(16, '0')}`, userId: OWNER, direct: true });
  const send = async (context: ReturnType<typeof dm>, text: string) => {
    seq += 1;
    return runtime.handle({ id: `sg-${seq}`, context, text, receivedAt: new Date().toISOString() });
  };
  async function setSwitch(state: 'stopped' | undefined): Promise<void> {
    const actor = (await storage.actors.get(owner.id)) as Actor;
    const { ['quoky.actionSwitch']: _old, ...metadata } = actor.metadata ?? {};
    await storage.actors.save({ ...actor, metadata: state === undefined ? metadata : { ...metadata, 'quoky.actionSwitch': { state, at: new Date().toISOString() } } });
  }
  const stoppedCount = async (): Promise<number> => (await anchors()).filter((anchor) => anchor?.closedReason === 'stopped').length;
  const anchors = async () =>
    (await storage.tasks.list()).map((task) => (task.metadata as { connectorWriteAnchor?: { status: string; closedReason?: string; undoOf?: unknown } } | undefined)?.connectorWriteAnchor).filter((anchor) => anchor !== undefined);

  /** A real approved create, then "되돌려줘" (the delete preview) and optionally the approval: the undo anchor is open. */
  async function openUndo(approve: boolean): Promise<{ context: ReturnType<typeof dm>; title: string }> {
    const context = dm();
    createSeq += 1;
    const title = `주간 회의 ${createSeq}`;
    const created = await send(context, `내일 오후 3시에 회의 잡아줘 제목 ${title}`);
    expect(created.status, created.reply.text).toBe('AWAITING_APPROVAL');
    await send(context, '승인');
    await send(context, '일정 추가 실행');
    const preview = await send(context, '되돌려줘');
    expect(preview.status, preview.reply.text).toBe('AWAITING_APPROVAL');
    if (approve) {
      const approved = await send(context, '승인');
      expect(approved.reply.text).toContain('일정 삭제 실행');
    }
    writerCalls.length = 0;
    return { context, title };
  }

  it('stops: lists the open undo approval, closes it, and the exact phrase then executes nothing', async () => {
    const { context, title } = await openUndo(true);
    const before = await stoppedCount();
    const stop = await send(dm(), '에이전트 중지');
    expect(stop.reply.text).toContain(STOP_REPLY);
    expect(stop.reply.text).toContain('1건');
    expect(stop.reply.text).toContain(`캘린더 일정 삭제 — ${title}`);
    const run = await send(context, '일정 삭제 실행');
    expect(writerCalls).not.toContain('deleteEvent');
    expect(run.reply.text).toContain('에이전트 중지');
    expect((await stoppedCount()) - before).toBe(1);
  });

  it('stops: an undo preview still waiting for its approval is closed and listed too, and cannot be approved', async () => {
    const { context, title } = await openUndo(false);
    const stop = await send(dm(), '에이전트 중지');
    expect(stop.reply.text).toContain(`캘린더 일정 삭제 — ${title}`);
    const late = await send(context, '승인');
    const run = await send(context, '일정 삭제 실행');
    expect(writerCalls).not.toContain('deleteEvent');
    expect(late.reply.text).not.toContain('일정 삭제 실행으로');
    expect(run.reply.text).not.toContain('되돌렸어요');
  });

  it('execution-time check alone: a switch flipped straight in the actor record (no stop turn) blocks the exact phrase and closes the anchor', async () => {
    const { context } = await openUndo(true);
    const before = await stoppedCount();
    await setSwitch('stopped');
    const run = await send(context, '일정 삭제 실행');
    expect(writerCalls).not.toContain('deleteEvent');
    expect(run.reply.text).toContain('자연어 실행이 멈춰 있어서 아무것도 하지 않았어요');
    expect((await stoppedCount()) - before).toBe(1);
    await setSwitch(undefined);
    const again = await send(context, '일정 삭제 실행');
    expect(writerCalls).not.toContain('deleteEvent');
    expect(again.reply.text).not.toContain('되돌렸어요');
  });

  it('stop with nothing open: the reply is exactly the plain stop reply', async () => {
    const stop = await send(dm(), '에이전트 중지');
    expect(stop.reply.text).toBe(STOP_REPLY);
  });

  it('resume does not reopen a closed approval: the old phrase still executes nothing', async () => {
    const { context } = await openUndo(true);
    await send(dm(), '에이전트 중지');
    const resumed = await send(dm(), '에이전트 재개');
    expect(resumed.reply.text).toContain('다시 켰어요');
    const run = await send(context, '일정 삭제 실행');
    expect(writerCalls).not.toContain('deleteEvent');
    expect(run.reply.text).not.toContain('되돌렸어요');
  });

  it('in flight: a write that already started is not aborted by a stop that arrives meanwhile; it finishes and reports', async () => {
    const { context } = await openUndo(true);
    let release: () => void = () => undefined;
    deleteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    const running = send(context, '일정 삭제 실행');
    await started;
    // Turns are not serialized per conversation: the stop is handled while the delete is awaiting the provider.
    const stop = await send(dm(), '에이전트 중지');
    expect(stop.reply.text).toContain(STOP_REPLY);
    expect(stop.reply.text).toContain('이미 실행이 시작된 요청 1건');
    expect(stop.reply.text).not.toContain('닫았어요');
    release();
    const done = await running;
    expect(done.reply.text).toContain('되돌렸어요');
    expect(writerCalls.filter((call) => call === 'deleteEvent')).toHaveLength(1);
    expect((await anchors()).filter((anchor) => anchor?.status === 'SENT' && anchor.undoOf !== undefined)).toHaveLength(1);
  });
});
