import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS,
  ACTION_SWITCH_METADATA_KEY,
  ActorMetadataStore,
  CALENDAR_READER,
  CONVERSATION_TURN_HANDLERS,
  ConversationRuntime,
  FeedbackRecorder,
  GitManager,
  NOTIFICATION_SINK,
  QuokyCore,
  SURFACE_GRANTS_METADATA_KEY,
  STORAGE_PROVIDER,
  StatelessApplyPreviewFlow,
  SurfaceGate,
  VECTOR_PROVIDER,
  WorkChatService,
  grantedSurfaceGroups,
  readSurfaceGrants,
  renderSurfaceDenied,
  surfaceChannelKey,
  surfaceGroupsOfSelection,
  type AiProvider,
  type ApplyPreviewAnchor,
  type CalendarEvent,
  type CalendarEventQuery,
  type CalendarReader,
  type ConversationContext,
  type ConversationTurnHandler,
  type InboundMessage,
  type NotificationSink,
  type SurfaceGroupId,
  type VectorProvider,
} from '@quoky/core';
import type { SqliteStorageProvider } from '@quoky/storage-sqlite';
import { stubProviderSelection } from './provider-selection/test-support';
import { SURFACE_GRANTS, type SurfaceGrantsComposition } from './features/surface-grants.providers';
import routingCorpus from '../../../packages/core/src/application/golden/turn-handler-routing.v1.json';
import actionShapedCorpus from '../../../packages/core/src/application/golden/action-shaped-fallthrough.v1.json';
import precedenceCorpus from '../../../packages/core/src/application/golden/reminder-todo-precedence.v1.json';

/**
 * ADR-0122 (A9 P1) acceptance, OFFLINE over the production `AppModule` (the INT-1 harness shape: a temp SQLite file,
 * sanitized env, counting provider stubs, an offline calendar fixture; the Discord adapter is never started).
 *
 * Over the routing corpora (turn-handler routing, action-shaped turns, reminder/to-do precedence, plus extra capability
 * phrases), each case is sent in a fresh actor and conversation under one surface mode:
 *  - `absent` (no `surfaceGrants` dep) vs `off`: byte-identical in a DM and in a channel (the P1 default);
 *  - `enforce` in a DM: byte-identical to `off`;
 *  - `enforce` in a channel holding the QA seed groups: byte-identical to `off` except the `writes` cases (not seeded);
 *  - `enforce` in a channel with no grant: identical to `off` (chat, help, control) or the fixed denial — and then zero
 *    provider calls, zero calendar reads, the work desk never called.
 * Plus the owner flows: the seed from the environment, list / revoke, the kill switch, the state-bound section after a
 * revoke, `기억해:`, the reaction gate and the registry claim check.
 */

const OWNER_ID = '222222222222222222';
const GUILD_ID = '1520835639103324181';
const QA_CHANNEL_ID = '1520835639904309350';
const SEED_GROUPS: readonly SurfaceGroupId[] = ['jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code'];
const SEED_ENV = `discord:${GUILD_ID}:${QA_CHANNEL_ID}=${SEED_GROUPS.join(',')}`;
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;

type Mode = 'absent' | 'off' | 'enforce';
type Surface = 'dm' | 'channel' | 'seeded' | 'ungranted';

interface Observation {
  readonly text: string;
  readonly status: string;
  readonly providerCalls: number;
  readonly calendarReads: number;
  readonly deskCalls: number;
}

interface Case {
  readonly id: string;
  readonly text: string;
  readonly ctx?: { readonly openTodos?: readonly string[]; readonly applyAnchor?: ApplyPreviewAnchor['status']; readonly priorTurns?: readonly string[]; readonly registeredProject?: boolean };
}

let savedEnv: NodeJS.ProcessEnv = {};
let tempDir = '';
let closeApp: (() => Promise<void>) | undefined;
let runtime: ConversationRuntime;
let storage: SqliteStorageProvider;
let composition: SurfaceGrantsComposition;
let handlers: readonly ConversationTurnHandler[];
let providerCalls = 0;
const calendarReads: CalendarEventQuery[] = [];
let deskCalls = 0;
const sinkDeliveries: Array<{ kind: string; text: string }> = [];
let gitCalls: string[] = [];
let reactionsRecorded = 0;
let core: QuokyCore;

function calendarFixture(query: CalendarEventQuery): readonly CalendarEvent[] {
  const from = Date.parse(query.from);
  const start = from + Math.min(60 * 60_000, Math.floor((Date.parse(query.to) - from) / 4));
  return [{ id: 'sg-cal-1', title: 'SG fixture standup', start: new Date(start).toISOString(), end: new Date(start + 60_000).toISOString(), allDay: false, status: 'confirmed', calendarName: 'primary' }];
}

beforeAll(async () => {
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'quoky-a9-'));
  Object.assign(process.env, {
    QUOKY_DISCORD_OWNER_IDS: OWNER_ID,
    DISCORD_GUILD_ID: GUILD_ID,
    QUOKY_DISCORD_CHANNEL_IDS: QA_CHANNEL_ID,
    QUOKY_CHANNEL_GRANTS: 'enforce',
    QUOKY_CHANNEL_GRANTS_SEED: SEED_ENV,
    QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
    QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
    QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
    QUOKY_OLLAMA_ENABLED: 'false',
    QUOKY_REMINDERS_ENABLED: 'true',
    QUOKY_TIMEZONE: 'Asia/Seoul',
    QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'sg-calendar-client',
    QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'sg-calendar-client-placeholder',
    QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'sg-calendar-refresh-placeholder',
  });
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  storage = app.get<SqliteStorageProvider>(STORAGE_PROVIDER);
  closeApp = async () => {
    await storage.close().catch(() => undefined);
    await app.close();
  };
  await storage.init();
  await app.get<VectorProvider>(VECTOR_PROVIDER).init();
  const stub = (provider: AiProvider) =>
    Object.assign(provider, {
      async isAvailable() {
        return true;
      },
      async execute() {
        providerCalls += 1;
        return { text: 'A9 stub provider reply', artifacts: [] };
      },
    });
  for (const provider of app.get<AiProvider[]>(AI_PROVIDERS)) stub(provider);
  stubProviderSelection(app, stub);
  Object.assign(app.get<CalendarReader>(CALENDAR_READER), {
    async listEvents(query: CalendarEventQuery) {
      calendarReads.push(query);
      return calendarFixture(query);
    },
  });
  const desk = app.get(WorkChatService);
  const deskHandle = desk.handle.bind(desk);
  vi.spyOn(desk, 'handle').mockImplementation(async (command, actor) => {
    deskCalls += 1;
    return deskHandle(command, actor);
  });
  const git = app.get(GitManager) as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(git))) {
    if (name === 'constructor' || typeof git[name] !== 'function') continue;
    const original = (git[name] as (...args: unknown[]) => unknown).bind(git);
    git[name] = (...args: unknown[]) => {
      gitCalls.push(name);
      return original(...args);
    };
  }
  const sink = app.get<NotificationSink>(NOTIFICATION_SINK);
  vi.spyOn(sink, 'deliver').mockImplementation(async (notification) => {
    sinkDeliveries.push({ kind: notification.kind, text: notification.text });
    return { status: 'SENT', via: 'DM' } as never;
  });
  const recorder = app.get(FeedbackRecorder);
  vi.spyOn(recorder, 'recordReaction').mockImplementation(async () => {
    reactionsRecorded += 1;
  });
  runtime = app.get(ConversationRuntime);
  composition = app.get<SurfaceGrantsComposition>(SURFACE_GRANTS);
  handlers = app.get<readonly ConversationTurnHandler[]>(CONVERSATION_TURN_HANDLERS);
  core = app.get(QuokyCore);
}, 60_000);

afterAll(async () => {
  await closeApp?.();
  process.env = savedEnv;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const depsOf = () => (runtime as unknown as { deps: Record<string, unknown> }).deps;
let enforcedDep: unknown;
function setMode(mode: Mode): void {
  const deps = depsOf();
  if (enforcedDep === undefined) enforcedDep = deps.surfaceGrants;
  if (mode === 'absent') delete deps.surfaceGrants;
  else if (mode === 'off') deps.surfaceGrants = { gate: new SurfaceGate('off'), service: composition.service };
  else deps.surfaceGrants = enforcedDep;
}

let seq = 0;
function freshContext(surface: Surface): ConversationContext {
  seq += 1;
  const n = String(seq).padStart(6, '0');
  const userId = `3333333333333${n}`;
  if (surface === 'dm') return { platform: 'discord', channelId: `4444444444444${n}`, userId, direct: true };
  return { platform: 'discord', spaceId: GUILD_ID, channelId: `5555555555555${n}`, userId, direct: false };
}

let messageSeq = 0;
async function send(context: ConversationContext, text: string): Promise<Observation> {
  messageSeq += 1;
  const before = { providerCalls, calendar: calendarReads.length, desk: deskCalls };
  const message: InboundMessage = { id: `a9-${messageSeq}`, context, text, receivedAt: new Date().toISOString() };
  const result = await runtime.handle(message);
  return {
    text: result.reply.text,
    status: result.status,
    providerCalls: providerCalls - before.providerCalls,
    calendarReads: calendarReads.length - before.calendar,
    deskCalls: deskCalls - before.desk,
  };
}

async function ensureActor(context: ConversationContext): Promise<string> {
  const existing = await storage.actors.findByExternalIdentity(context.platform, context.userId);
  if (existing) return existing.id;
  const saved = await storage.actors.save({ id: `actor-${context.userId}`, displayName: context.userId, identities: [{ platform: context.platform, externalId: context.userId }], createdAt: new Date().toISOString() });
  return saved.id;
}

async function grant(context: ConversationContext, groups: readonly SurfaceGroupId[]): Promise<void> {
  const actorId = await ensureActor(context);
  const key = surfaceChannelKey(context);
  await new ActorMetadataStore({ get: (id) => storage.actors.get(id), save: (actor) => storage.actors.save(actor) }).updateMetadataEntry(actorId, SURFACE_GRANTS_METADATA_KEY, () => ({
    v: 1,
    channels: { [key]: { groups: Object.fromEntries(groups.map((group) => [group, { at: '2026-10-15T00:00:00.000Z', source: 'seed' }])) } },
    seeds: [],
  }));
}

const PUSHED = { commitHash: '0123456789abcdef0123456789abcdef01234567', remote: 'origin', branch: 'feature/a9' };
async function seedAnchor(context: ConversationContext, status: ApplyPreviewAnchor['status']): Promise<void> {
  await send(context, '도움말');
  const session = await storage.sessions.findActiveByContext(context.platform, context.channelId, context.threadId);
  if (!session) throw new Error('no session');
  const projectId = `a9-project-${context.channelId}`;
  const withProject = await storage.sessions.save({ ...session, activeProjectId: projectId });
  await new StatelessApplyPreviewFlow(storage).anchor(withProject, {
    kind: 'code-preview-apply',
    status,
    projectId,
    instruction: 'apply the approved change',
    codeGenerationRef: { id: 'a9-generation', status: 'SUCCEEDED' },
    pushedCommitHash: PUSHED.commitHash,
    pushedRemote: PUSHED.remote,
    pushedBranch: PUSHED.branch,
    pushedUpstreamRef: `origin/${PUSHED.branch}`,
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
  } as unknown as ApplyPreviewAnchor);
}

async function anchorStatus(context: ConversationContext): Promise<string | undefined> {
  const session = await storage.sessions.findActiveByContext(context.platform, context.channelId, context.threadId);
  if (!session) return undefined;
  return (await new StatelessApplyPreviewFlow(storage).findAnchor(session))?.status;
}

/** One case in a fresh actor and conversation; setup turns always run with the gate off (same state on every surface). */
/** Every case starts at the same instant (relative times such as "in 30 minutes" must not drift between modes). */
const CASE_START = Date.parse('2026-10-15T01:00:00.000Z');

async function runCase(mode: Mode, surface: Surface, golden: Case): Promise<Observation & { readonly context: ConversationContext }> {
  vi.setSystemTime(CASE_START);
  const context = freshContext(surface);
  if (surface === 'seeded') await grant(context, SEED_GROUPS);
  setMode(mode === 'absent' ? 'absent' : 'off');
  for (const title of golden.ctx?.openTodos ?? []) {
    await send(context, `할 일 추가: ${title}`);
    // Distinct creation instants, so the numbered list order never depends on a millisecond tie.
    vi.setSystemTime(Date.now() + 1000);
  }
  for (const text of golden.ctx?.priorTurns ?? []) await send(context, text);
  if (golden.ctx?.applyAnchor) await seedAnchor(context, golden.ctx.applyAnchor);
  setMode(mode);
  try {
    return { ...(await send(context, golden.text)), context };
  } finally {
    setMode('enforce');
  }
}

const EXTRA_CASES: readonly Case[] = [
  { id: 'x-jira', text: '내 Jira 이슈 보여줘' },
  { id: 'x-github', text: 'GitHub 리뷰 요청 보여줘' },
  { id: 'x-slack', text: 'Slack에서 배포 검색' },
  { id: 'x-confluence', text: 'Confluence에서 배포 검색' },
  { id: 'x-calendar', text: '오늘 일정 알려줘' },
  { id: 'x-todo-add', text: '할 일 추가: A9 보고서' },
  { id: 'x-todo-list', text: '내 할 일 보여줘' },
  { id: 'x-reminder', text: '내일 9시에 회의 알려줘' },
  { id: 'x-reminder-list', text: '알림 목록' },
  { id: 'x-memory', text: '기억해: 나는 아메리카노를 좋아해' },
  { id: 'x-memory-list', text: '기억 목록' },
  { id: 'x-learning', text: '예시 목록' },
  { id: 'x-feedback', text: '피드백 요약' },
  { id: 'x-jira-comment', text: 'PROJ-1에 댓글: 확인했어요' },
  { id: 'x-slack-post', text: '#general에 게시: 배포 끝' },
  { id: 'x-calendar-create', text: '내일 오후 3시에 팀 회의 일정 추가해줘' },
  { id: 'x-mail', text: '안 읽은 메일 보여줘' },
  { id: 'x-model', text: '모델 상태' },
  { id: 'x-help', text: '도움말' },
  { id: 'x-chat', text: '오늘 기분이 좋아' },
  { id: 'x-branch', text: '브랜치 만들어줘 feature/a9' },
  { id: 'x-code', text: 'src/a.ts 버그 고쳐줘' },
];

const CORPUS: readonly Case[] = [
  ...(routingCorpus as unknown as { cases: Case[] }).cases.filter((golden) => golden.ctx?.registeredProject !== true),
  ...(actionShapedCorpus as unknown as { cases: Array<Case & { kind: string }> }).cases.filter((golden) => golden.kind === 'turn' && golden.ctx?.registeredProject !== true),
  ...(precedenceCorpus as unknown as { cases: Case[] }).cases,
  ...EXTRA_CASES,
];

const DENIALS: ReadonlySet<string> = new Set(
  (['not-granted', 'dm-only', 'suspended', 'unclassified'] as const).flatMap((reason) =>
    (['ko', 'en'] as const).flatMap((language) =>
      ['chat', 'help', 'control', 'jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code', 'writes', 'mail', 'drive', 'brief', 'nl-actions', 'agent'].map((group) =>
        renderSurfaceDenied({ allow: false, reason, group: group as SurfaceGroupId }, language),
      ),
    ),
  ),
);
const writesDenial = (text: string) => text === renderSurfaceDenied({ allow: false, reason: 'not-granted', group: 'writes' }, 'ko') || text === renderSurfaceDenied({ allow: false, reason: 'not-granted', group: 'writes' }, 'en');

/** Random one-time codes (a memory forget confirmation) are the only per-run text; everything else is compared byte for byte. */
const normalize = (text: string) => text.replace(/기억 확인 [A-Z0-9]{4}/g, '기억 확인 <code>').replace(/confirm memory [A-Z0-9]{4}/g, 'confirm memory <code>');
const strip = (o: Observation) => ({ text: normalize(o.text), status: o.status, providerCalls: o.providerCalls, calendarReads: o.calendarReads, deskCalls: o.deskCalls });
function diffs(left: Map<string, Observation>, right: Map<string, Observation>, skip: (id: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const golden of CORPUS) {
    if (skip(golden.id)) continue;
    const a = strip(left.get(golden.id)!);
    const b = strip(right.get(golden.id)!);
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${golden.id}: ${JSON.stringify(a).slice(0, 300)} <> ${JSON.stringify(b).slice(0, 300)}`);
  }
  return out;
}

/** Every case observed once per (mode, surface); the assertions below read the same observations. */
const observed = new Map<string, Promise<Map<string, Observation & { context: ConversationContext }>>>();
function observe(mode: Mode, surface: Surface): Promise<Map<string, Observation & { context: ConversationContext }>> {
  const key = `${mode}:${surface}`;
  let pending = observed.get(key);
  if (!pending) {
    pending = (async () => {
      const byId = new Map<string, Observation & { context: ConversationContext }>();
      for (const golden of CORPUS) byId.set(golden.id, await runCase(mode, surface, golden));
      return byId;
    })();
    observed.set(key, pending);
  }
  return pending;
}

// ── byte-identity over the corpora ───────────────────────────────────────────────────────────────────────────────

describe(`surface grants over the routing corpora (${CORPUS.length} cases)`, () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('`off` is byte-identical to no surface dep at all, in a DM and in a channel', async () => {
    for (const surface of ['dm', 'channel'] as const) {
      const absent = await observe('absent', surface);
      const off = await observe('off', surface);
      expect(diffs(off, absent), surface).toEqual([]);
    }
  }, 240_000);

  it('`enforce` in a DM is byte-identical to `off`', async () => {
    const off = await observe('off', 'dm');
    const enforce = await observe('enforce', 'dm');
    expect(diffs(enforce, off)).toEqual([]);
  }, 240_000);

  it('`enforce` in a channel holding the QA seed groups is byte-identical to `off`, except the `writes` requests (not seeded)', async () => {
    const off = await observe('off', 'channel');
    const seeded = await observe('enforce', 'seeded');
    const writes: string[] = [];
    for (const golden of CORPUS) {
      const got = seeded.get(golden.id)!;
      if (!writesDenial(got.text)) continue;
      writes.push(golden.id);
      expect(got.providerCalls + got.calendarReads + got.deskCalls, golden.id).toBe(0);
    }
    expect(diffs(seeded, off, (id) => writes.includes(id))).toEqual([]);
    expect(writes).toEqual(expect.arrayContaining(['x-jira-comment', 'x-slack-post', 'x-calendar-create']));
  }, 240_000);

  it('`enforce` in a channel with no grant: chat, help and control as before; everything else the fixed denial with nothing read', async () => {
    const off = await observe('off', 'channel');
    const ungranted = await observe('enforce', 'ungranted');
    const denied: string[] = [];
    for (const golden of CORPUS) {
      const got = ungranted.get(golden.id)!;
      if (!DENIALS.has(got.text)) continue;
      denied.push(golden.id);
      expect({ providerCalls: got.providerCalls, calendarReads: got.calendarReads, deskCalls: got.deskCalls }, golden.id).toEqual({ providerCalls: 0, calendarReads: 0, deskCalls: 0 });
    }
    // A hint-only claim (`todo.hint`, `todo.status`) is `skip`: denied, the turn simply falls through to chat (always
    // allowed), which read nothing either.
    const fellThrough = CORPUS.filter((golden) => {
      const got = ungranted.get(golden.id)!;
      return !denied.includes(golden.id) && got.text === 'A9 stub provider reply' && got.deskCalls === 0 && got.calendarReads === 0 && off.get(golden.id)!.deskCalls === 1;
    }).map((golden) => golden.id);
    expect(diffs(ungranted, off, (id) => denied.includes(id) || fellThrough.includes(id))).toEqual([]);
    for (const id of fellThrough) expect(off.get(id)!.deskCalls, id).toBe(1);
    const extra = (id: string) => ungranted.get(id)!.text;
    for (const id of ['x-jira', 'x-github', 'x-slack', 'x-confluence', 'x-calendar', 'x-todo-add', 'x-todo-list', 'x-reminder', 'x-reminder-list', 'x-memory', 'x-memory-list', 'x-learning', 'x-feedback', 'x-jira-comment', 'x-slack-post', 'x-calendar-create', 'x-branch', 'x-code']) {
      expect(DENIALS.has(extra(id)), id).toBe(true);
    }
    expect(extra('x-calendar')).toBe("이 채널에서는 '캘린더 조회' 권한이 없어요. 아무것도 읽지 않았어요. DM으로 물어보시면 돼요.");
    for (const id of ['x-help', 'x-model', 'x-chat']) expect(DENIALS.has(extra(id)), id).toBe(false);
    expect(denied.length).toBeGreaterThan(100);
    // The state-bound section (every post-push anchor case): denied or as before, and the anchor never moves.
    for (const golden of CORPUS.filter((c) => c.ctx?.applyAnchor !== undefined)) {
      expect(await anchorStatus(ungranted.get(golden.id)!.context), golden.id).toBe(golden.ctx!.applyAnchor);
    }
  }, 240_000);
});

// ── owner flows ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('owner flows in the production composition', () => {
  const OWNER_DM: ConversationContext = { platform: 'discord', channelId: '600000000000000001', userId: OWNER_ID, direct: true };
  const QA: ConversationContext = { platform: 'discord', spaceId: GUILD_ID, channelId: QA_CHANNEL_ID, userId: OWNER_ID, direct: false };
  const QA_THREAD: ConversationContext = { ...QA, threadId: '1520835639904309399' };
  const ownerGroups = async () => {
    const actor = await storage.actors.findByExternalIdentity('discord', OWNER_ID);
    return grantedSurfaceGroups(readSurfaceGrants(actor?.metadata?.[SURFACE_GRANTS_METADATA_KEY]), surfaceChannelKey(QA));
  };

  it('the env seed is applied once (after the owner Actor exists), logged and DM-noted; a second start changes nothing', async () => {
    setMode('enforce');
    expect(await composition.applySeed(new Date().toISOString())).toEqual([]); // no owner Actor yet: skipped
    await send(OWNER_DM, '도움말');
    const [first] = await composition.applySeed(new Date().toISOString());
    expect(first?.applied).toBe(true);
    expect(await ownerGroups()).toEqual([...SEED_GROUPS]);
    await composition.deliverSeedReceipts();
    expect(sinkDeliveries).toEqual([{ kind: 'SURFACE_GRANT', text: `배포 시 사전 허용: ${QA_CHANNEL_ID}에 Jira 내 담당 조회, Jira 프로젝트·릴리스 조회(전체 담당), GitHub 조회, Slack 검색, Confluence 검색, 캘린더 조회, 할 일, 알림, 기억, 코드 작업. 해제: 그 채널에서 "이 채널 권한 모두 해제".` }]);
    const [second] = await composition.applySeed(new Date().toISOString());
    expect(second?.applied).toBe(false);
  });

  it('use → revoke → denied (a thread inherits); DM unaffected; list shows the rest', async () => {
    setMode('enforce');
    const before = await send(QA, '오늘 일정 알려줘');
    expect(before.calendarReads).toBe(1);
    expect((await send(QA_THREAD, '오늘 일정 알려줘')).calendarReads).toBe(1);
    expect((await send(QA, '이 채널에 캘린더 허용 해제')).text).toBe('이 채널에서 해제했어요: 캘린더 조회.');
    expect(sinkDeliveries.at(-1)).toEqual({ kind: 'SURFACE_GRANT', text: `채널 권한 해제: ${QA_CHANNEL_ID} — 캘린더 조회.` });
    for (const context of [QA, QA_THREAD]) {
      const after = await send(context, '오늘 일정 알려줘');
      expect(after.text).toBe("이 채널에서는 '캘린더 조회' 권한이 없어요. 아무것도 읽지 않았어요. DM으로 물어보시면 돼요.");
      expect(after.calendarReads + after.providerCalls).toBe(0);
    }
    expect((await send(OWNER_DM, '오늘 일정 알려줘')).calendarReads).toBe(1);
    expect((await send(QA, '이 채널 권한 보여줘')).text).not.toContain('캘린더');
    expect(await ownerGroups()).not.toContain('calendar');
  });

  it('the kill switch (owner DM) suspends every channel grant and restores them', async () => {
    setMode('enforce');
    expect((await send(OWNER_DM, '에이전트 중지')).text).toBe('채널 권한을 모두 멈췄어요(지우지 않고 보관해요). 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
    const actor = await storage.actors.findByExternalIdentity('discord', OWNER_ID);
    expect(actor?.metadata?.[ACTION_SWITCH_METADATA_KEY]).toMatchObject({ state: 'stopped' });
    const suspended = await send(QA, '내 할 일 보여줘');
    expect(suspended.text).toBe('채널 권한이 지금 모두 멈춰 있어요(에이전트 중지). 아무것도 읽지 않았어요.');
    expect(suspended.deskCalls).toBe(0);
    expect((await send(OWNER_DM, '내 할 일 보여줘')).deskCalls).toBe(1); // a DM is unchanged
    expect((await send(OWNER_DM, '에이전트 재개')).text).toBe('채널 권한을 다시 켰어요.');
    expect((await send(QA, '내 할 일 보여줘')).deskCalls).toBe(1);
  });

  it('`기억해:` and every memory command need `memory`; the P0 DM-only rule stays the second layer', async () => {
    setMode('enforce');
    const context = freshContext('ungranted');
    expect((await send(context, '기억해: A9 비밀 아님')).text).toBe("이 채널에서는 '기억' 권한이 없어요. 아무것도 읽지 않았어요. DM으로 물어보시면 돼요.");
    const seeded = freshContext('seeded');
    await grant(seeded, SEED_GROUPS);
    expect((await send(seeded, '기억 목록')).text).toBe('이 기능은 DM에서만 쓸 수 있어요');
  });

  it('state-bound section: a revoke between the approval and the exact execution phrase runs nothing; PR status needs `github`', async () => {
    setMode('enforce');
    const context = freshContext('seeded');
    await grant(context, ['code']);
    await seedAnchor(context, 'PUSH_APPROVED');
    gitCalls = [];
    await grant(context, []); // revoked
    const run = await send(context, '푸시 실행해줘');
    expect(run.text).toBe("이 채널에서는 '코드 작업' 권한이 없어요. 아무것도 읽지 않았어요. DM으로 물어보시면 돼요.");
    expect(gitCalls).toEqual([]);
    expect(await anchorStatus(context)).toBe('PUSH_APPROVED');
    const pr = freshContext('seeded');
    await grant(pr, ['code']);
    await seedAnchor(pr, 'PR_CREATED');
    expect((await send(pr, 'PR 상태 확인해줘')).text).toBe("이 채널에서는 'GitHub 조회' 권한이 없어요. 아무것도 읽지 않았어요. DM으로 물어보시면 돼요.");
    expect(await anchorStatus(pr)).toBe('PR_CREATED');
  });

  it('a 👍 reaction in a channel without `memory` is dropped before anything is stored; with it, or in a DM, it is recorded', async () => {
    setMode('enforce');
    const signal = (context: ConversationContext) => ({ platform: 'discord', context, targetPlatformMessageId: '1', rating: 'POSITIVE' as const, action: 'ADDED' as const });
    const ungranted = freshContext('ungranted');
    await ensureActor(ungranted);
    const before = reactionsRecorded;
    await core.handleFeedbackSignal(signal(ungranted));
    expect(reactionsRecorded).toBe(before);
    const seeded = freshContext('seeded');
    await grant(seeded, ['memory']);
    await core.handleFeedbackSignal(signal(seeded));
    await core.handleFeedbackSignal(signal({ ...ungranted, direct: true }));
    expect(reactionsRecorded).toBe(before + 2);
  });
});

describe('registry (D2.1): every registered handler claims, and its claims map to the closed groups', () => {
  it('each production handler implements surfaceClaim', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(10);
    for (const handler of handlers) expect(typeof handler.surfaceClaim, handler.id).toBe('function');
  });

  it('conformance over the corpora: handle() non-null ⇒ a claim; a reply claim ⇒ handle() answered; a listing maps into the claim', async () => {
    const mismatches: string[] = [];
    for (const golden of CORPUS) {
      if (golden.ctx !== undefined) continue; // state-dependent cases are covered by the runtime suites above
      const context = freshContext('dm');
      const actorId = await ensureActor(context);
      const actor = (await storage.actors.get(actorId))!;
      const session = await storage.sessions.save({ id: `conf-${context.channelId}`, actorId, context, status: 'ACTIVE', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() } as never);
      const now = new Date().toISOString();
      const message: InboundMessage = { id: `conf-${golden.id}`, context, text: golden.text, receivedAt: now };
      const ordered = (runtime as unknown as { turnHandlerRegistry: readonly ConversationTurnHandler[] }).turnHandlerRegistry;
      for (const handler of ordered) {
        const claim = handler.surfaceClaim?.({ message, now }) ?? null;
        const outcome = await handler.handle({ message, session, actor, now, applyAnchor: null, resolveActiveWorkspace: async () => null } as never);
        if (outcome !== null && claim === null) mismatches.push(`${golden.id}: ${handler.id} answered without a claim`);
        if (outcome === null && claim !== null && claim.onDeny === 'reply') mismatches.push(`${golden.id}: ${handler.id} claimed (reply) but declined`);
        const selection = outcome !== null && outcome.kind !== 'write-draft' ? outcome.nlSelection : undefined;
        if (selection !== undefined && claim !== null && surfaceGroupsOfSelection(selection).some((group) => !(claim.groups as readonly string[]).includes(group))) {
          mismatches.push(`${golden.id}: ${handler.id} listed ${selection.entryId} outside its claim`);
        }
        if (outcome !== null) break;
      }
    }
    expect(mismatches).toEqual([]);
  }, 240_000);
});
