import 'reflect-metadata';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type {
  Actor,
  AiProvider,
  AiRequest,
  CalendarEventWriter,
  ConversationContext,
  ConversationTurnHandler,
  InboundMessage,
  NlSelectedCommand,
  PlatformAdapter,
  StorageProvider,
  TurnResult,
} from '@quoky/core';

/**
 * The multi-turn context eval's world (test and eval support only, never production): the REAL `AppModule` over a REAL
 * SQLite file, booted with the deployed NL profile, the REAL Jira, Slack, Gmail, Drive and Google Calendar READ adapters
 * behind one scripted `fetch` that answers from synthetic fixtures (every other URL throws and is recorded), a recording
 * calendar WRITER (no network) and AI providers whose answers come from the runner: the `INTENT_SELECTION` router prompt
 * goes to the runner's selection source (a real model in a Strict run, a stub in dry mode), chat and summarisation to the
 * runner's chat source (a fixed stub unless a Strict run routes chat to a real model too).
 *
 * One world serves one run. Every scenario gets its own owner identity (a fresh Actor: its own to-dos, reminders, sessions
 * and metadata), its own DM and channel ids and its own fixtures, so nothing leaks between scenarios. No token, key or
 * secret here is real: every credential is a placeholder.
 */

export const CONTEXT_EVAL_JIRA_HOST = 'context-eval.atlassian.net';
export const CONTEXT_EVAL_SLACK_CHANNEL = 'C0CTXEVAL1';
/** The Jira identity prefix of every scenario owner; the fixture treats any identity with it as "me". */
export const CONTEXT_EVAL_JIRA_IDENTITY = 'context-eval-jira-owner';
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
const GMAIL_REFRESH = 'context-eval-gmail-refresh-placeholder';
const DRIVE_REFRESH = 'context-eval-drive-refresh-placeholder';
const CALENDAR_REFRESH = 'context-eval-calendar-refresh-placeholder';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const CALENDAR_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
/** The base of the scenario owners' Discord ids (18 digits; the scenario index fills the tail). */
const OWNER_BASE = '1100000000000000';
const SPACE_ID = '990000000000000017';
export const CONTEXT_EVAL_MAX_OWNERS = 60;

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CalendarFixtureEvent {
  readonly id: string;
  readonly title: string;
  /** Days from today in the owner's time zone (0 = today, 1 = tomorrow). */
  readonly day: number;
  /** `HH:MM` local; absent for an all-day event. */
  readonly start?: string;
  readonly end?: string;
  readonly location?: string;
}

export interface JiraFixtureWorld {
  readonly projects: ReadonlyArray<{ readonly key: string; readonly name: string }>;
  readonly versions: Readonly<Record<string, ReadonlyArray<{ readonly id: string; readonly name: string; readonly released?: boolean; readonly releaseDate?: string }>>>;
  readonly issues: ReadonlyArray<{
    readonly id: string;
    readonly key: string;
    readonly summary: string;
    readonly status?: 'open' | 'in-progress' | 'done';
    /** Assigned to the scenario owner. */
    readonly mine?: boolean;
    /** Reported by the scenario owner. */
    readonly reportedByMe?: boolean;
    readonly fixVersions?: readonly string[];
    readonly description?: string;
  }>;
}

export interface MailFixture {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly snippet: string;
  readonly body: string;
  readonly unread?: boolean;
}

export interface DriveFixture {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface SlackFixture {
  readonly ts: string;
  readonly user: string;
  readonly text: string;
}

export interface ContextEvalFixtures {
  readonly calendar?: readonly CalendarFixtureEvent[];
  readonly jira?: JiraFixtureWorld;
  readonly mail?: readonly MailFixture[];
  readonly drive?: readonly DriveFixture[];
  readonly slack?: readonly SlackFixture[];
}

// ── Observation ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServedCommand {
  readonly handlerId: string;
  readonly entryId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly target?: { readonly source: string; readonly id?: string; readonly label?: number };
}

export interface StateSnapshot {
  /** `id → title|status` of the owner's to-dos. */
  readonly todos: Readonly<Record<string, { readonly title: string; readonly status: string }>>;
  /** `id → text|status` of the owner's reminders (every status). */
  readonly reminders: Readonly<Record<string, { readonly text: string; readonly status: string }>>;
  /** Approval ids and statuses of the whole store (the scenario's own owner is the only actor writing). */
  readonly approvals: Readonly<Record<string, string>>;
  /** Connector-write anchors (`taskId → status`). */
  readonly anchors: Readonly<Record<string, string>>;
}

export interface SessionView {
  /** The pending question this context holds after the turn (`kind` plus its confirm / app-source shape). */
  readonly pending?: { readonly kind: string; readonly confirm?: boolean; readonly appSource?: boolean; readonly entryId?: string };
  readonly lastSelection?: { readonly entryId: string; readonly args: Readonly<Record<string, unknown>>; readonly at?: string };
  readonly lastListingSources: readonly string[];
  /** The listing slots this very message wrote (their request id is the message's id). */
  readonly listedNow: readonly string[];
  readonly lastAction?: { readonly entryId: string; readonly undone: boolean };
}

export interface CalendarWriteRecord {
  readonly op: 'create' | 'update' | 'delete';
  readonly title?: string;
  readonly eventId?: string;
}

export interface TurnObservation {
  readonly reply: string;
  readonly status: string;
  readonly served: readonly ServedCommand[];
  readonly claims: readonly string[];
  /** The one catalog entry of each claiming handler that owns exactly one (a grammar answer of an unambiguous owner). */
  readonly claimedEntries: readonly string[];
  /** Router-prompt selection calls (the ones a Strict run sends to the real model). */
  readonly selectionCalls: number;
  /** Other INTENT_SELECTION calls (e.g. a planner); never sent to the real selector. */
  readonly otherSelectionCalls: number;
  /**
   * The conversation context the router prompt carried this turn (diagnosis of context loss): the previous selection's
   * entry id (`none` when the prompt said none) and the A6 reference context line, as rendered. Absent without selection.
   */
  readonly selectorSaw?: { readonly previousEntry: string; readonly referenceContext?: string };
  readonly chatPrompts: readonly string[];
  readonly summaryPrompts: readonly string[];
  /** Every prompt (and context file) a REMOTE-locality provider received this turn, by kind. */
  readonly remotePrompts: ReadonlyArray<{ readonly kind: 'selection' | 'chat' | 'summary' | 'other'; readonly text: string }>;
  readonly before: StateSnapshot;
  readonly after: StateSnapshot;
  /** The conversation's state before and after the turn. */
  readonly sessionBefore: SessionView;
  readonly session: SessionView;
  readonly calendarWrites: readonly CalendarWriteRecord[];
  /** The capability of every provider call this turn, in order (content-free). */
  readonly capabilities: readonly string[];
  /** Non-GET requests the fetch stub saw (must stay empty: reads only). */
  readonly nonGetFetches: readonly string[];
  /** URLs the fetch stub did not serve (a harness gap, reported). */
  readonly blockedFetches: readonly string[];
}

/** What answers the provider calls of a turn. */
export interface ContextEvalProviders {
  /** The router prompt of natural-language selection: the raw selector output text, or a throw (a provider failure). */
  select(request: AiRequest): Promise<string>;
  /** Chat (GENERAL_CHAT / POLICY_SENSITIVE_CHAT and anything else that is not selection or summarisation). */
  chat(request: AiRequest): Promise<string>;
  /** Summarisation (document / item summaries). */
  summarize(request: AiRequest): Promise<string>;
}

export interface ScenarioOwner {
  readonly index: number;
  readonly discordId: string;
  readonly actor: Actor;
  readonly dm: ConversationContext;
  readonly channel: ConversationContext;
}

export interface ContextEvalWorld {
  readonly core: typeof import('@quoky/core');
  readonly storage: StorageProvider;
  /** The router prompt's first line (how a selection request is told apart from any other INTENT_SELECTION call). */
  readonly routerHead: string;
  providers: ContextEvalProviders;
  /** Start a scenario: a fresh owner, fresh fixtures, cleared selection cache and caps. */
  beginScenario(index: number, fixtures: ContextEvalFixtures): Promise<ScenarioOwner>;
  /** A fresh DM context of the current owner (a new session; the suggestion probes use it). */
  freshDm(): ConversationContext;
  turn(owner: ScenarioOwner, text: string, context: ConversationContext): Promise<TurnObservation>;
  /** The app's console lines so far (bounded; diagnostics only, never printed by the CLI). */
  logLines(): readonly string[];
  close(): Promise<void>;
}

/**
 * The NL profile of the owner's live service (read 2026-10-26 from the service `.env.local`, values only, no secret), as the
 * world boots it. Two reply-neutral background jobs are off in the eval: the S1 `c-shadow` agreement selection (it "acts on
 * nothing and writes no session or actor state", nl-selection-service.ts) and the S2 shadow planner (no read, no reply
 * change); both would spend model calls the eval does not score.
 */
export const CONTEXT_EVAL_PROFILES = {
  deployed: {
    QUOKY_NL_INTENT_MODE: 'active',
    QUOKY_NL_INTENT_MODEL: 'haiku',
    QUOKY_NL_GRAMMAR_YIELD: 'on',
    QUOKY_NL_PHASE: 'a',
    QUOKY_NL_ACTIONS: 'shadow',
    QUOKY_AGENT_MODE: 'off',
    QUOKY_REMINDERS_ENABLED: 'true',
    QUOKY_CALENDAR_WRITE_ENABLED: 'true',
    QUOKY_WORK_SUMMARY_ENABLED: 'false',
    QUOKY_OLLAMA_ENABLED: 'false',
    QUOKY_BRIEF_MAIL_ENABLED: 'true',
  },
  /** The promotion candidate: the deployed profile with A6 actions acting locally and R2 item summaries on. */
  'actions-local': {
    QUOKY_NL_INTENT_MODE: 'active',
    QUOKY_NL_INTENT_MODEL: 'haiku',
    QUOKY_NL_GRAMMAR_YIELD: 'on',
    QUOKY_NL_PHASE: 'a',
    QUOKY_NL_ACTIONS: 'local',
    QUOKY_NL_ITEM_R2: 'all',
    QUOKY_AGENT_MODE: 'off',
    QUOKY_REMINDERS_ENABLED: 'true',
    QUOKY_CALENDAR_WRITE_ENABLED: 'true',
    QUOKY_WORK_SUMMARY_ENABLED: 'false',
    QUOKY_OLLAMA_ENABLED: 'false',
    QUOKY_BRIEF_MAIL_ENABLED: 'true',
  },
} as const;
export type ContextEvalProfile = keyof typeof CONTEXT_EVAL_PROFILES;
export const CONTEXT_EVAL_PROFILE_NAMES = Object.keys(CONTEXT_EVAL_PROFILES) as ContextEvalProfile[];

/** Whether A6 actions act (and so whether `requires: actions` scenarios are scored in full) under a profile. */
export function profileActs(profile: ContextEvalProfile): { readonly actions: boolean; readonly itemR2: boolean } {
  const env = CONTEXT_EVAL_PROFILES[profile] as Readonly<Record<string, string>>;
  return { actions: env.QUOKY_NL_ACTIONS === 'local', itemR2: env.QUOKY_NL_ACTIONS === 'local' && env.QUOKY_NL_ITEM_R2 === 'all' };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local (Asia/Seoul, no DST) calendar date `offset` days from now, as `YYYY-MM-DD`. */
export function seoulDate(offset: number, nowMs: number = Date.now()): string {
  const local = new Date(nowMs + 9 * 3_600_000 + offset * 86_400_000);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
}

/** A fixture event as the Google Calendar API returns it. */
export function googleEventOf(event: CalendarFixtureEvent, nowMs: number = Date.now()): Record<string, unknown> {
  const date = seoulDate(event.day, nowMs);
  const base = { id: event.id, summary: event.title, status: 'confirmed', etag: `"etag-${event.id}"`, ...(event.location !== undefined ? { location: event.location } : {}) };
  if (event.start === undefined) return { ...base, start: { date }, end: { date: seoulDate(event.day + 1, nowMs) } };
  return { ...base, start: { dateTime: `${date}T${event.start}:00+09:00` }, end: { dateTime: `${date}T${event.end ?? event.start}:00+09:00` } };
}

function eventWindowMs(event: Record<string, unknown>): [number, number] {
  const start = event.start as { date?: string; dateTime?: string };
  const end = event.end as { date?: string; dateTime?: string };
  const startMs = Date.parse(start.dateTime ?? `${start.date}T00:00:00+09:00`);
  const endMs = Date.parse(end.dateTime ?? `${end.date}T00:00:00+09:00`);
  return [startMs, endMs === startMs ? endMs + 1 : endMs];
}

type VitestVi = typeof import('vitest').vi;

/**
 * Module isolation between runs: vitest resets its registry; plain node drops the workspace's own modules from the
 * require cache so `app.module` re-reads the environment (node_modules stay cached).
 */
async function resetModules(): Promise<VitestVi | undefined> {
  if (process.env.VITEST !== undefined) {
    const { vi } = await import('vitest');
    vi.resetModules();
    return vi;
  }
  const root = resolve(__dirname, '../../../..');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root) && !key.includes(`${'/'}node_modules${'/'}`)) delete require.cache[key];
  }
  return undefined;
}

/** Boot one world (one run). `profile` picks the NL flags; nothing here reads a `.env` file. */
export async function bootContextEvalWorld(profile: ContextEvalProfile, initial: ContextEvalProviders): Promise<ContextEvalWorld> {
  const vi = await resetModules();
  const consoleLines: string[] = [];
  const savedConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const method of ['log', 'warn', 'error', 'info'] as const) console[method] = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' ').slice(0, 400));
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  const tempDir = mkdtempSync(join(tmpdir(), 'quoky-context-eval-'));
  const gmailToken = join(tempDir, 'gmail.json');
  const driveToken = join(tempDir, 'drive.json');
  writeFileSync(gmailToken, JSON.stringify({ version: 1, scope: GMAIL_SCOPE, refresh_token: GMAIL_REFRESH }), { mode: 0o600 });
  writeFileSync(driveToken, JSON.stringify({ version: 1, scope: DRIVE_SCOPE, refresh_token: DRIVE_REFRESH }), { mode: 0o600 });
  chmodSync(gmailToken, 0o600);
  chmodSync(driveToken, 0o600);

  const state = {
    fixtures: {} as ContextEvalFixtures,
    calendar: [] as Record<string, unknown>[],
    calendarWrites: [] as CalendarWriteRecord[],
    nonGet: [] as string[],
    blocked: [] as string[],
    providers: initial,
  };

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      const scope = body.includes(DRIVE_REFRESH) ? DRIVE_SCOPE : body.includes(GMAIL_REFRESH) ? GMAIL_SCOPE : CALENDAR_SCOPES;
      return json({ access_token: 'context-eval-access-placeholder', expires_in: 3600, token_type: 'Bearer', scope });
    }
    if (method !== 'GET') {
      state.nonGet.push(`${method} ${url.origin}${url.pathname}`);
      throw new Error('context eval: only reads reach the network stub');
    }
    const served = route(url, state.fixtures, state.calendar);
    if (served !== undefined) return served;
    state.blocked.push(`${url.origin}${url.pathname}`);
    throw new Error('context eval: network is not available');
  }) as typeof fetch;

  const ownerIds = Array.from({ length: CONTEXT_EVAL_MAX_OWNERS }, (_, index) => ownerId(index));
  Object.assign(process.env, {
    QUOKY_DISCORD_OWNER_IDS: ownerIds.join(','),
    QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
    QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
    QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
    CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
    QUOKY_TIMEZONE: 'Asia/Seoul',
    QUOKY_JIRA_BASE_URL: CONTEXT_EVAL_JIRA_HOST,
    QUOKY_JIRA_EMAIL: 'context-eval@example.invalid',
    QUOKY_JIRA_TOKEN: 'context-eval-jira-token-placeholder',
    QUOKY_SLACK_TOKEN: 'context-eval-slack-token-placeholder',
    QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'context-eval-calendar-client',
    QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'context-eval-calendar-client-placeholder',
    QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: CALENDAR_REFRESH,
    QUOKY_GMAIL_TOKEN_FILE: gmailToken,
    QUOKY_DRIVE_TOKEN_FILE: driveToken,
    ...CONTEXT_EVAL_PROFILES[profile],
  });

  const core = await import('@quoky/core');
  const { AppModule } = await import('../app.module');
  const { stubProviderSelection } = await import('../provider-selection/test-support');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const storage = app.get<StorageProvider>(core.STORAGE_PROVIDER);
  await storage.init();
  await app.get<{ init(): Promise<void> }>(core.VECTOR_PROVIDER).init();

  // The router prompt's opening words: the common prefix of the read prompt's and the action prompt's first lines (the
  // action variant rewrites the tail of that line); a planner prompt opens differently.
  const readHead = core.buildSelectionPrompt({ entries: [], text: 'x' }).split('\n')[0] as string;
  const actionHead = core.buildSelectionPrompt({ entries: [], text: 'x', actions: { referenceContext: 'none' } }).split('\n')[0] as string;
  let shared = 0;
  while (shared < readHead.length && readHead[shared] === actionHead[shared]) shared += 1;
  const routerHead = readHead.slice(0, shared);
  if (routerHead.length < 20) throw new Error('context eval: the router prompt head could not be derived');
  const requests: Array<AiRequest & { readonly locality: 'LOCAL' | 'REMOTE' }> = [];
  const stub = (provider: AiProvider): void => {
    const locality = core.executionLocalityOf(provider);
    Object.assign(provider, {
      async isAvailable() {
        return true;
      },
      async execute(request: AiRequest) {
        requests.push({ ...request, locality });
        if (request.capability === core.Capability.INTENT_SELECTION) {
          // Only the router prompt is natural-language selection; any other INTENT_SELECTION call (a planner) gets none.
          if (!request.prompt.startsWith(routerHead)) return { text: JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] }), artifacts: [] };
          return { text: await state.providers.select(request), artifacts: [] };
        }
        if (request.capability === core.Capability.SUMMARIZATION) return { text: await state.providers.summarize(request), artifacts: [] };
        return { text: await state.providers.chat(request), artifacts: [] };
      },
    });
  };
  for (const provider of app.get<AiProvider[]>(core.AI_PROVIDERS)) stub(provider);
  stubProviderSelection(app, stub);

  // The calendar writer records instead of writing; a created event joins the fixture so a later read sees it.
  let created = 0;
  try {
    const writer = app.get<CalendarEventWriter>(core.CALENDAR_EVENT_WRITER);
    Object.assign(writer as object, {
      async createEvent(request: { draft: { title?: string; summary?: string; start?: unknown; end?: unknown } }) {
        created += 1;
        const id = `created-${created}`;
        const title = String(request.draft.title ?? request.draft.summary ?? '');
        state.calendarWrites.push({ op: 'create', title, eventId: id });
        state.calendar.push({ id, summary: title, status: 'confirmed', etag: `"etag-${id}"`, start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() } });
        return { status: 'SENT', externalRef: id };
      },
      async updateEvent(request: { eventId: string }) {
        state.calendarWrites.push({ op: 'update', eventId: request.eventId });
        return { status: 'SENT', externalRef: request.eventId };
      },
      async deleteEvent(request: { eventId: string }) {
        state.calendarWrites.push({ op: 'delete', eventId: request.eventId });
        state.calendar = state.calendar.filter((event) => event.id !== request.eventId);
        return { status: 'SENT', externalRef: request.eventId };
      },
    });
  } catch {
    // No calendar writer under this profile: calendar writes stay refused, as configured.
  }

  Object.assign(app.get<PlatformAdapter>(core.PLATFORM_ADAPTER) as object, {
    start: async () => undefined,
    stop: async () => undefined,
    sendTyping: async () => undefined,
    sendMessage: async () => undefined,
    deliver: async () => ({ status: 'SENT', via: 'dm' }),
  });

  // Every handler's selected command and claim, as the acceptance tests observe them.
  const served: ServedCommand[] = [];
  const claims: string[] = [];
  const claimedEntries: string[] = [];
  for (const handler of app.get<readonly ConversationTurnHandler[]>(core.CONVERSATION_TURN_HANDLERS)) {
    const handle = handler.handle.bind(handler);
    (handler as { handle: ConversationTurnHandler['handle'] }).handle = async (ctx) => {
      const outcome = await handle(ctx);
      if (outcome !== null) {
        claims.push(handler.id);
        const owned = handler.catalog ?? [];
        if (owned.length === 1) claimedEntries.push((owned[0] as { id: string }).id);
      }
      return outcome;
    };
    const serve = handler.handleSelected?.bind(handler);
    if (serve !== undefined) {
      (handler as { handleSelected?: ConversationTurnHandler['handleSelected'] }).handleSelected = async (command: NlSelectedCommand, ctx) => {
        served.push({
          handlerId: handler.id,
          entryId: command.entryId,
          args: { ...command.args },
          ...(command.target !== undefined ? { target: { source: command.target.source, ...(command.target.id !== undefined ? { id: command.target.id } : {}), ...(command.target.label !== undefined ? { label: command.target.label } : {}) } } : {}),
        });
        return serve(command, ctx);
      };
    }
  }
  const runtime = app.get(core.ConversationRuntime) as { handle(message: InboundMessage): Promise<TurnResult> };
  const nlService = (runtime as unknown as { deps: { nlSelection?: { cache?: Map<string, unknown>; actionCaps?: unknown } } }).deps.nlSelection;
  let messageSeq = 0;
  let freshSeq = 0;
  let current: ScenarioOwner | undefined;

  const snapshot = async (actorId: string): Promise<StateSnapshot> => {
    const todos: Record<string, { title: string; status: string }> = {};
    for (const item of await storage.workItems.listByActor(actorId)) todos[item.id] = { title: String(item.title ?? ''), status: String(item.status) };
    const reminders: Record<string, { text: string; status: string }> = {};
    const reminderStore = (storage as unknown as { reminders?: { listByActorStatuses(actorId: string, statuses: readonly string[]): Promise<ReadonlyArray<{ id: string; body: string; status: string }>> } }).reminders;
    for (const reminder of (await reminderStore?.listByActorStatuses(actorId, Object.values(core.ReminderStatus))) ?? []) {
      reminders[reminder.id] = { text: reminder.body, status: reminder.status };
    }
    // One world runs the whole corpus: only this owner's tasks and approvals, so another scenario's pending card never
    // reads as this owner's state.
    const tasks = (await storage.tasks.list()).filter((task) => task.actorId === actorId);
    const taskIds = new Set(tasks.map((task) => task.id));
    const approvals: Record<string, string> = {};
    for (const approval of await storage.approvals.list()) {
      if (approval.requestedBy === actorId || (approval.taskId !== undefined && taskIds.has(approval.taskId))) approvals[approval.id] = String(approval.status);
    }
    const anchors: Record<string, string> = {};
    for (const task of tasks) {
      const anchor = (task.metadata as Record<string, unknown> | undefined)?.connectorWriteAnchor as { status?: unknown } | undefined;
      if (anchor !== undefined) anchors[task.id] = String(anchor.status ?? 'unknown');
    }
    return { todos, reminders, approvals, anchors };
  };

  const sessionView = async (context: ConversationContext, actorId: string, messageId?: string): Promise<SessionView> => {
    const session = (await storage.sessions.list()).find((candidate) => candidate.context.channelId === context.channelId && candidate.context.platform === context.platform);
    const metadata = (session?.metadata ?? {}) as Record<string, unknown>;
    const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
    const pendingRaw = record(metadata[core.NL_PENDING_METADATA_KEY]);
    const pending =
      typeof pendingRaw.kind === 'string' && pendingRaw.actorId === actorId
        ? {
            kind: pendingRaw.kind,
            ...(pendingRaw.confirm === true ? { confirm: true } : {}),
            ...(typeof pendingRaw.appSource === 'string' ? { appSource: true } : {}),
            ...(typeof pendingRaw.entryId === 'string' ? { entryId: pendingRaw.entryId } : {}),
          }
        : undefined;
    const lastSelectionRaw = record(metadata[core.LAST_SELECTION_METADATA_KEY]);
    const lastSelection =
      typeof lastSelectionRaw.entryId === 'string' && lastSelectionRaw.actorId === actorId
        ? { entryId: lastSelectionRaw.entryId, args: record(lastSelectionRaw.args), ...(typeof lastSelectionRaw.at === 'string' ? { at: lastSelectionRaw.at } : {}) }
        : undefined;
    const listing = record(record(record(metadata[core.LAST_LISTING_METADATA_KEY]).byActor)[actorId]);
    const actionRaw = record(record(record(metadata[core.LAST_ACTION_METADATA_KEY]).byActor)[actorId]);
    return {
      ...(pending !== undefined ? { pending } : {}),
      ...(lastSelection !== undefined ? { lastSelection } : {}),
      lastListingSources: Object.keys(listing).sort(),
      listedNow: Object.entries(listing)
        .filter(([, slot]) => messageId !== undefined && record(slot).requestId === messageId)
        .map(([source]) => source)
        .sort(),
      ...(typeof actionRaw.entryId === 'string' ? { lastAction: { entryId: actionRaw.entryId, undone: actionRaw.undone === true } } : {}),
    };
  };

  const world: ContextEvalWorld = {
    core,
    storage,
    routerHead,
    get providers() {
      return state.providers;
    },
    set providers(value) {
      state.providers = value;
    },
    async beginScenario(index, fixtures) {
      if (!Number.isInteger(index) || index < 0 || index >= CONTEXT_EVAL_MAX_OWNERS) throw new Error('context eval: scenario index out of range');
      state.fixtures = fixtures;
      state.calendar = (fixtures.calendar ?? []).map((event) => googleEventOf(event));
      state.calendarWrites = [];
      nlService?.cache?.clear();
      if (nlService !== undefined && 'actionCaps' in nlService) nlService.actionCaps = new core.NlActionCaps({ ...core.NL_ACTION_CAPS });
      const discordId = ownerId(index);
      const dm: ConversationContext = { platform: 'discord', channelId: `88${String(index).padStart(4, '0')}000000000017`, userId: discordId, direct: true };
      const channel: ConversationContext = { platform: 'discord', spaceId: SPACE_ID, channelId: `77${String(index).padStart(4, '0')}000000000017`, userId: discordId, direct: false };
      // First contact creates the Actor (a fixed greeting through a fresh, discarded DM; the selector is not asked).
      const saved = state.providers;
      state.providers = { ...saved, select: async () => JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] }), chat: async () => '안녕하세요.' };
      try {
        messageSeq += 1;
        await runtime.handle({ id: `ctx-hello-${messageSeq}`, context: { platform: 'discord', channelId: `66${String(index).padStart(4, '0')}000000000017`, userId: discordId, direct: true }, text: '안녕', receivedAt: new Date().toISOString() });
      } finally {
        state.providers = saved;
      }
      const found = await storage.actors.findByExternalIdentity('discord', discordId);
      if (found === null) throw new Error('context eval: owner actor missing');
      const actor = await storage.actors.save({ ...found, identities: [...found.identities, { platform: 'jira', externalId: `${CONTEXT_EVAL_JIRA_IDENTITY}-${index}` }] });
      current = { index, discordId, actor, dm, channel };
      return current;
    },
    freshDm() {
      if (current === undefined) throw new Error('context eval: no scenario');
      freshSeq += 1;
      return { platform: 'discord', channelId: `55${String(current.index).padStart(4, '0')}${String(freshSeq).padStart(9, '0')}17`, userId: current.discordId, direct: true };
    },
    async turn(owner, text, context) {
      const before = await snapshot(owner.actor.id);
      const sessionBefore = await sessionView(context, owner.actor.id);
      const start = requests.length;
      const servedStart = served.length;
      const claimStart = claims.length;
      const claimedStart = claimedEntries.length;
      const writeStart = state.calendarWrites.length;
      const nonGetStart = state.nonGet.length;
      const blockedStart = state.blocked.length;
      // Owner messages are never in the same millisecond: items are numbered in createdAt order, so equal stamps would
      // let the shown order differ from the order of the setup messages.
      await new Promise((resolve) => setTimeout(resolve, 3));
      messageSeq += 1;
      const messageId = `ctx-${messageSeq}`;
      const result = await runtime.handle({ id: messageId, context, text, receivedAt: new Date().toISOString() });
      const made = requests.slice(start);
      const selection = made.filter((request) => request.capability === core.Capability.INTENT_SELECTION);
      return {
        reply: result.reply.text,
        status: String(result.status),
        capabilities: made.map((request) => String(request.capability)),
        ...selectorSawOf(selection.filter((request) => request.prompt.startsWith(routerHead)).at(-1)?.prompt),
        served: served.slice(servedStart),
        claims: claims.slice(claimStart),
        claimedEntries: claimedEntries.slice(claimedStart),
        selectionCalls: selection.filter((request) => request.prompt.startsWith(routerHead)).length,
        otherSelectionCalls: selection.filter((request) => !request.prompt.startsWith(routerHead)).length,
        chatPrompts: made.filter((request) => request.capability === core.Capability.GENERAL_CHAT || request.capability === core.Capability.POLICY_SENSITIVE_CHAT).map((request) => request.prompt),
        summaryPrompts: made.filter((request) => request.capability === core.Capability.SUMMARIZATION).map((request) => request.prompt),
        remotePrompts: made
          .filter((request) => request.locality === 'REMOTE')
          .map((request) => ({
            kind:
              request.capability === core.Capability.INTENT_SELECTION
                ? ('selection' as const)
                : request.capability === core.Capability.SUMMARIZATION
                  ? ('summary' as const)
                  : request.capability === core.Capability.GENERAL_CHAT || request.capability === core.Capability.POLICY_SENSITIVE_CHAT
                    ? ('chat' as const)
                    : ('other' as const),
            text: [request.prompt, ...(request.contextFiles ?? []).map((file) => String((file as { content?: unknown }).content ?? ''))].join('\n'),
          })),
        before,
        after: await snapshot(owner.actor.id),
        sessionBefore,
        session: await sessionView(context, owner.actor.id, messageId),
        calendarWrites: state.calendarWrites.slice(writeStart),
        nonGetFetches: state.nonGet.slice(nonGetStart),
        blockedFetches: state.blocked.slice(blockedStart),
      };
    },
    logLines() {
      return [...consoleLines];
    },
    async close() {
      await storage.close().catch(() => undefined);
      await app.close().catch(() => undefined);
      process.env = savedEnv;
      globalThis.fetch = savedFetch;
      Object.assign(console, savedConsole);
      vi?.restoreAllMocks();
      rmSync(tempDir, { recursive: true, force: true });
      void consoleLines;
    },
  };
  return world;
}

/** The last `Previous selection:` and `Reference context:` lines of a router prompt (the owner message follows them). */
function selectorSawOf(prompt: string | undefined): { selectorSaw?: { previousEntry: string; referenceContext?: string } } {
  if (prompt === undefined) return {};
  const lines = prompt.split('\n');
  const previous = [...lines].reverse().find((line) => line.startsWith('Previous selection: '));
  const reference = [...lines].reverse().find((line) => line.startsWith('Reference context: '));
  let previousEntry = 'none';
  try {
    const raw = previous?.slice('Previous selection: '.length) ?? 'none';
    previousEntry = raw === 'none' ? 'none' : String((JSON.parse(raw) as { entryId?: unknown }).entryId ?? 'none');
  } catch {
    previousEntry = 'unparsed';
  }
  return { selectorSaw: { previousEntry, ...(reference !== undefined ? { referenceContext: reference.slice('Reference context: '.length).slice(0, 300) } : {}) } };
}

function ownerId(index: number): string {
  return `${OWNER_BASE}${String(index).padStart(2, '0')}`;
}

/** The scripted network: synthetic fixtures for the read APIs the deployed profile configures. */
function route(url: URL, fixtures: ContextEvalFixtures, calendar: readonly Record<string, unknown>[]): Response | undefined {
  if (url.origin === `https://${CONTEXT_EVAL_JIRA_HOST}`) return jiraRoute(url, fixtures.jira);
  if (url.origin === 'https://slack.com') return slackRoute(url, fixtures.slack ?? []);
  if (url.origin === 'https://gmail.googleapis.com') return gmailRoute(url, fixtures.mail ?? []);
  if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) return driveRoute(url, fixtures.drive ?? []);
  if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/calendar/v3/calendars/')) {
    const from = Date.parse(url.searchParams.get('timeMin') ?? '');
    const to = Date.parse(url.searchParams.get('timeMax') ?? '');
    const items = calendar.filter((event) => {
      const [start, end] = eventWindowMs(event);
      return (!Number.isFinite(to) || start < to) && (!Number.isFinite(from) || end > from);
    });
    items.sort((a, b) => eventWindowMs(a)[0] - eventWindowMs(b)[0]);
    return json({ summary: '내 캘린더', items });
  }
  return undefined;
}

function jiraRoute(url: URL, world: JiraFixtureWorld | undefined): Response | undefined {
  const jira: JiraFixtureWorld = world ?? { projects: [], versions: {}, issues: [] };
  if (url.pathname === '/rest/api/3/project/search') return json({ values: jira.projects, isLast: true });
  const versions = /^\/rest\/api\/3\/project\/([A-Z][A-Z0-9]+)\/version$/.exec(url.pathname);
  if (versions !== null) {
    return json({
      values: (jira.versions[versions[1] as string] ?? []).map((version) => ({ id: version.id, name: version.name, released: version.released === true, archived: false, ...(version.releaseDate !== undefined ? { releaseDate: version.releaseDate } : {}) })),
      isLast: true,
    });
  }
  if (url.pathname === '/rest/api/3/search/jql') {
    const jql = url.searchParams.get('jql') ?? '';
    let fixVersion = /fixVersion = (\d+)/.exec(jql)?.[1];
    // A version named in JQL resolves like Jira: by the exact version name in the fixture's versions; an unknown name is
    // Jira's 400 naming the fix version (the connector maps it to NOT_FOUND).
    const named = /fixVersion = "((?:[^"\\]|\\.)*)"/.exec(jql)?.[1]?.replace(/\\(.)/gu, '$1');
    if (named !== undefined) {
      const version = Object.values(jira.versions).flat().find((candidate) => candidate.name === named);
      if (version === undefined) return json({ errorMessages: [`The value '${named}' does not exist for the field 'fixVersion'.`] }, 400);
      fixVersion = version.id;
    }
    const project = /project = "([A-Z][A-Z0-9]+)"/.exec(jql)?.[1];
    const assignee = /assignee = "/.test(jql);
    const reporter = /reporter = "/.test(jql);
    const openOnly = jql.includes('statusCategory != Done');
    const inProgress = jql.includes('statusCategory = indeterminate');
    const issues = jira.issues.filter((issue) => {
      const status = issue.status ?? 'open';
      if (fixVersion !== undefined && !(issue.fixVersions ?? []).includes(fixVersion)) return false;
      if (project !== undefined && !issue.key.startsWith(`${project}-`)) return false;
      if (jql.startsWith('(assignee')) {
        if (issue.mine !== true && issue.reportedByMe !== true) return false;
      } else if (reporter && !assignee) {
        if (issue.reportedByMe !== true) return false;
      } else if (assignee && issue.mine !== true) return false;
      if (openOnly && status === 'done') return false;
      if (inProgress && status !== 'in-progress') return false;
      return true;
    });
    const max = Number(url.searchParams.get('maxResults') ?? '50');
    return json({
      issues: issues.slice(0, max).map((issue) => ({
        id: issue.id,
        key: issue.key,
        fields: {
          summary: issue.summary,
          status: { name: issue.status === 'done' ? 'Done' : issue.status === 'in-progress' ? 'In Progress' : 'Open', statusCategory: { key: issue.status === 'done' ? 'done' : issue.status === 'in-progress' ? 'indeterminate' : 'new' } },
          updated: '2026-10-20T00:00:00.000+0000',
          created: '2026-10-10T00:00:00.000+0000',
          issuetype: { name: 'Task' },
          ...(issue.mine === true ? { assignee: { displayName: '나' } } : { assignee: { displayName: '다른 담당자' } }),
        },
      })),
      isLast: issues.length <= max,
    });
  }
  const single = /^\/rest\/api\/3\/issue\/(\d+)$/.exec(url.pathname);
  if (single !== null) {
    const issue = jira.issues.find((candidate) => candidate.id === single[1]);
    if (issue === undefined) return json({ errorMessages: ['Issue does not exist'] }, 404);
    return json({
      id: issue.id,
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: 'Open' },
        issuetype: { name: 'Task' },
        updated: '2026-10-20T00:00:00.000+0000',
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: issue.description ?? issue.summary }] }] },
        comment: { comments: [], startAt: 0, maxResults: 50, total: 0 },
      },
    });
  }
  return undefined;
}

function slackRoute(url: URL, messages: readonly SlackFixture[]): Response | undefined {
  if (url.pathname === '/api/search.messages') {
    const query = (url.searchParams.get('query') ?? '').toLowerCase().split(/\s+/u).filter((word) => word.length > 0 && !word.includes(':'));
    const matches = messages.filter((message) => query.length === 0 || query.some((word) => message.text.toLowerCase().includes(word)));
    return json({
      ok: true,
      messages: {
        matches: matches.map((message) => ({
          ts: message.ts,
          text: message.text,
          user: message.user,
          channel: { id: CONTEXT_EVAL_SLACK_CHANNEL, name: 'general', is_im: false, is_mpim: false },
          permalink: `https://context-eval.slack.com/archives/${CONTEXT_EVAL_SLACK_CHANNEL}/p${message.ts.replace('.', '')}`,
        })),
      },
    });
  }
  if (url.pathname === '/api/conversations.replies') {
    const ts = url.searchParams.get('ts') ?? '';
    const parent = messages.find((message) => message.ts === ts);
    return json({ ok: true, messages: parent === undefined ? [] : [{ ts: parent.ts, user: parent.user, text: parent.text }], has_more: false });
  }
  return undefined;
}

function gmailRoute(url: URL, mails: readonly MailFixture[]): Response | undefined {
  const metadata = (mail: MailFixture) => ({
    id: mail.id,
    threadId: `thread-${mail.id}`,
    labelIds: mail.unread === false ? ['INBOX'] : ['INBOX', 'UNREAD'],
    snippet: mail.snippet,
    internalDate: String(Date.now() - 60 * 60_000),
    payload: { headers: [{ name: 'From', value: mail.from }, { name: 'Subject', value: mail.subject }] },
  });
  if (url.pathname === '/gmail/v1/users/me/messages') {
    const q = url.searchParams.get('q') ?? '';
    const listed = mails.filter((mail) => !q.includes('is:unread') || mail.unread !== false);
    return json({ messages: listed.map((mail) => ({ id: mail.id })) });
  }
  const id = url.pathname.split('/').pop() as string;
  if (url.pathname.startsWith('/gmail/v1/users/me/threads/')) return json({ id, messages: [{ id: id.replace(/^thread-/, '') }] });
  const mail = mails.find((entry) => entry.id === id);
  if (mail === undefined) return json({}, 404);
  if (url.searchParams.get('format') === 'full') return json({ ...metadata(mail), payload: { mimeType: 'text/plain', headers: metadata(mail).payload.headers, body: { data: b64(mail.body) } } });
  return json(metadata(mail));
}

function driveRoute(url: URL, docs: readonly DriveFixture[]): Response | undefined {
  const parts = url.pathname.split('/');
  if (url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q') ?? '';
    const name = /name contains '([^']*)'/.exec(q)?.[1];
    const listed = docs.filter((doc) => name === undefined || doc.name.includes(name));
    return json({ files: listed.map((doc) => ({ id: doc.id, name: doc.name, mimeType: doc.mimeType, modifiedTime: '2026-10-20T00:00:00.000Z' })) });
  }
  const doc = docs.find((entry) => entry.id === parts[4]);
  if (doc === undefined) return json({}, 404);
  if (parts[5] === 'export') return new Response(doc.text, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return json({ id: doc.id, name: doc.name, mimeType: doc.mimeType, modifiedTime: '2026-10-20T00:00:00.000Z', owners: [{ displayName: '문서 소유자' }] });
}
