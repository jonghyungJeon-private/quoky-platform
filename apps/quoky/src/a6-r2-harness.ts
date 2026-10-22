import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { Actor, AiProvider, AiRequest, ConversationContext, InboundMessage, PlatformAdapter, StorageProvider, TurnResult } from '@quoky/core';

/**
 * ADR-0120 amendment A6 R2 offline harness (test support only): the REAL `AppModule` over a REAL SQLite file, the REAL
 * Jira and Slack connector adapters behind one scripted `fetch` (a Jira Cloud site and slack.com that return the planted
 * fixtures; every other URL throws), and stub AI providers: the `INTENT_SELECTION` answer is scripted per turn (the
 * worst-case selector) and `SUMMARIZATION` is a scripted stub (by default it echoes the whole prompt back: the worst case
 * of a model that obeys every instruction it reads). No token, key or secret here is real.
 */

export const R2_OWNER = '111111111111111117';
export const R2_JIRA_HOST = 'r2-example.atlassian.net';
export const R2_SLACK_CHANNEL = 'C0R2TEST01';
export const SELECTION = 'INTENT_SELECTION';
export const SUMMARIZATION = 'SUMMARIZATION';
export const R2_CHAT_REPLY = 'R2 stub chat reply';
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;

export const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
export const pick = (entryId: string, args: Record<string, unknown> = {}): string => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });

export interface JiraFixtureIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  readonly description: string;
  readonly comments?: ReadonlyArray<{ readonly author: string; readonly text: string }>;
  /** The key the issue answers with now (a moved issue keeps its numeric id). */
  readonly currentKey?: string;
  /** What the single-issue GET answers instead of the issue. */
  readonly answer?: 'redirect' | 'other-id' | 'not-found' | 'oversize' | 'forbidden';
  readonly commentTotal?: number;
  /** Text hidden in a collapsed ADF `expand` node of the description (an injection's favourite place). */
  readonly hidden?: string;
  /** A person @-mentioned (an ADF `mention` node) in the first comment. */
  readonly mention?: string;
  /** The display names of the issue's assignee and reporter (participants named only in the item fields). */
  readonly assignee?: string;
  readonly reporter?: string;
}

export interface SlackFixtureMessage {
  readonly ts: string;
  readonly user: string;
  readonly text: string;
  /** The parent ts when this message is a thread reply. */
  readonly threadTs?: string;
  readonly replyCount?: number;
}

/** A plain ADF document of one paragraph per line. */
export function adf(text: string, extra: { readonly hidden?: string; readonly mention?: string } = {}): unknown {
  const content: unknown[] = text.split('\n').map((line) => ({ type: 'paragraph', content: line.length > 0 ? [{ type: 'text', text: line }] : [] }));
  if (extra.mention !== undefined) content.push({ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'acc-1', text: `@${extra.mention}` } }, { type: 'text', text: ' 확인 부탁해요.' }] });
  if (extra.hidden !== undefined) content.push({ type: 'expand', attrs: { title: '' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: extra.hidden }] }] });
  return { type: 'doc', version: 1, content };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface R2Harness {
  readonly core: typeof import('@quoky/core');
  readonly storage: StorageProvider;
  readonly owner: Actor;
  readonly requests: AiRequest[];
  /** Every fetched URL (method and URL), in order. */
  readonly fetched: string[];
  /** The Jira single-issue and Slack replies URLs only. */
  itemFetches(): string[];
  jira: JiraFixtureIssue[];
  /** ADR-0120 A8: the visible Jira projects (`project/search`) and each project's versions (`project/{key}/version`). */
  jiraProjects: Array<{ readonly key: string; readonly name: string }>;
  jiraVersions: Record<string, Array<{ readonly id: string; readonly name: string; readonly released?: boolean }>>;
  slack: SlackFixtureMessage[];
  selector: string;
  /** The stub summariser: gets the SUMMARIZATION prompt, returns the summary text. Default: echo the prompt. */
  summarizer: (prompt: string) => string;
  /**
   * When set, it answers every SUMMARIZATION request instead of `summarizer` (the real-model red-team runner routes the R2
   * item prompts to the real provider and everything else to a stub). Its text is the summary; a throw is a provider failure.
   */
  summarizeRequest: ((request: AiRequest) => Promise<string>) | undefined;
  /** The stub chat answer (`GENERAL_CHAT` and every other capability). */
  chat: string;
  /** How the Slack fixture answers a single thread-reply read (`normal`, the parent alone, or the parent and a neighbour). */
  slackReplyMode: 'normal' | 'parent-only' | 'neighbour';
  /** Extra generated replies of a thread (a 1,000-reply thread). */
  extraReplies: (ts: string) => SlackFixtureMessage[];
  /** Every console line the app logged (the ConsoleLogger writes through console). */
  logLines(): string[];
  turn(text: string, selector?: string, context?: ConversationContext, extra?: Partial<InboundMessage>): Promise<{ result: TurnResult; text: string; selects: AiRequest[]; summaries: AiRequest[]; chats: AiRequest[]; items: string[] }>;
  dm: ConversationContext;
  channel: ConversationContext;
  history(): Promise<string[]>;
  sessionMetadata(): Promise<Record<string, unknown>>;
  service(): { actionLevel(): string; itemR2Level(): string; cache: Map<string, unknown>; actionCaps: unknown };
  close(): Promise<void>;
}

type VitestVi = typeof import('vitest').vi;

/**
 * The harness runs under vitest (CI) and under the plain-node `eval:r2-redteam` CLI: it needs no test runner (console
 * capture and the fetch stub are plain assignments); only the module-registry reset is vitest's, and only when vitest runs.
 */
export async function bootR2Harness(env: Record<string, string>): Promise<R2Harness> {
  const vi: VitestVi | undefined = process.env.VITEST !== undefined ? (await import('vitest')).vi : undefined;
  const consoleLines: string[] = [];
  const savedConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const method of ['log', 'warn', 'error', 'info'] as const) console[method] = (...args: unknown[]) => void consoleLines.push(args.map(String).join(' '));
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
  const tempDir = mkdtempSync(join(tmpdir(), 'quoky-a6-r2-'));
  const requests: AiRequest[] = [];
  const fetched: string[] = [];
  const state = {
    jira: [] as JiraFixtureIssue[],
    jiraProjects: [] as Array<{ readonly key: string; readonly name: string }>,
    jiraVersions: {} as Record<string, Array<{ readonly id: string; readonly name: string; readonly released?: boolean }>>,
    slack: [] as SlackFixtureMessage[],
    selector: none,
    summarizer: (prompt: string) => prompt,
    summarizeRequest: undefined as ((request: AiRequest) => Promise<string>) | undefined,
    chat: R2_CHAT_REPLY,
    slackReplyMode: 'normal' as 'normal' | 'parent-only' | 'neighbour',
    extraReplies: (_ts: string): SlackFixtureMessage[] => [],
  };

  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    fetched.push(`${method} ${url.toString()}`);
    if (method !== 'GET') throw new Error('A6 R2 harness: only GET is allowed');
    if (url.origin === `https://${R2_JIRA_HOST}`) {
      if (url.pathname === '/rest/api/3/search/jql') {
        return json({
          issues: state.jira.map((issue) => ({ id: issue.id, key: issue.key, fields: { summary: issue.summary, status: { name: 'Open' }, updated: '2026-10-16T00:00:00.000+0000', description: adf(issue.description) } })),
        });
      }
      if (url.pathname === '/rest/api/3/project/search') return json({ values: state.jiraProjects, isLast: true });
      const versions = /^\/rest\/api\/3\/project\/([A-Z][A-Z0-9]+)\/version$/.exec(url.pathname);
      if (versions !== null) return json({ values: state.jiraVersions[versions[1] as string] ?? [], isLast: true });
      const match = /^\/rest\/api\/3\/issue\/(\d+)$/.exec(url.pathname);
      if (match !== null) {
        const issue = state.jira.find((candidate) => candidate.id === match[1]);
        if (issue === undefined || issue.answer === 'not-found') return json({ errorMessages: ['Issue does not exist'] }, 404);
        if (issue.answer === 'forbidden') return json({}, 403);
        if (issue.answer === 'redirect') return new Response(null, { status: 301, headers: { Location: `https://${R2_JIRA_HOST}/rest/api/3/issue/99999` } });
        if (issue.answer === 'oversize') return new Response('x'.repeat(1_048_577), { status: 200, headers: { 'Content-Type': 'application/json' } });
        const comments = (issue.comments ?? []).map((comment, index) => ({
          id: String(index + 1),
          author: { displayName: comment.author },
          created: new Date(Date.parse('2026-10-15T00:00:00.000Z') + index * 60_000).toISOString(),
          body: adf(comment.text, index === 0 && issue.mention !== undefined ? { mention: issue.mention } : {}),
        }));
        return json({
          id: issue.answer === 'other-id' ? '77777' : issue.id,
          key: issue.currentKey ?? issue.key,
          fields: {
            summary: issue.summary,
            status: { name: 'Open' },
            issuetype: { name: 'Task' },
            updated: '2026-10-15T00:00:00.000+0000',
            description: adf(issue.description, issue.hidden !== undefined ? { hidden: issue.hidden } : {}),
            comment: { comments, startAt: 0, maxResults: 50, total: issue.commentTotal ?? comments.length },
            ...(issue.assignee !== undefined ? { assignee: { displayName: issue.assignee } } : {}),
            ...(issue.reporter !== undefined ? { reporter: { displayName: issue.reporter } } : {}),
          },
        });
      }
    }
    if (url.origin === 'https://slack.com') {
      if (url.pathname === '/api/search.messages') {
        return json({
          ok: true,
          messages: {
            matches: state.slack.map((message) => ({
              ts: message.ts,
              text: message.text,
              user: message.user,
              channel: { id: R2_SLACK_CHANNEL, name: 'general', is_im: false, is_mpim: false },
              permalink: `https://r2-example.slack.com/archives/${R2_SLACK_CHANNEL}/p${message.ts.replace('.', '')}${message.threadTs !== undefined ? `?thread_ts=${message.threadTs}&cid=${R2_SLACK_CHANNEL}` : ''}`,
            })),
          },
        });
      }
      if (url.pathname === '/api/conversations.replies') {
        const ts = url.searchParams.get('ts') as string;
        const oldest = url.searchParams.get('oldest');
        const parent = state.slack.find((message) => message.ts === ts) ?? { ts, user: 'U0PARENT01', text: '원글', replyCount: 1 };
        const replies = [...state.slack.filter((message) => message.threadTs === ts), ...state.extraReplies(ts)];
        let messages: SlackFixtureMessage[] = [parent, ...replies];
        if (oldest !== null) {
          // A hostile or broken answer for a reply read: the parent alone, or the parent and a neighbour.
          const neighbour: SlackFixtureMessage = { ts: '1700009999.000100', user: 'U0NEIGH001', text: 'NEIGHBOUR-CANARY 다른 메시지', threadTs: ts };
          messages =
            state.slackReplyMode === 'parent-only'
              ? [parent]
              : state.slackReplyMode === 'neighbour'
                ? [parent, neighbour]
                : [parent, ...replies.filter((message) => message.ts === oldest)];
        } else if (url.searchParams.get('limit') === '1') messages = [parent];
        return json({
          ok: true,
          messages: messages.map((message) => ({ ts: message.ts, user: message.user, text: message.text, ...(message.replyCount !== undefined ? { reply_count: message.replyCount } : {}), ...(message.threadTs !== undefined ? { thread_ts: message.threadTs } : {}) })),
          has_more: false,
        });
      }
    }
    throw new Error('A6 R2 harness: network is not available in this test');
  }) as typeof fetch;

  Object.assign(process.env, {
    QUOKY_DISCORD_OWNER_IDS: R2_OWNER,
    QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
    QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
    QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
    QUOKY_OLLAMA_ENABLED: 'false',
    CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
    QUOKY_TIMEZONE: 'Asia/Seoul',
    QUOKY_JIRA_BASE_URL: R2_JIRA_HOST,
    QUOKY_JIRA_EMAIL: 'r2-owner@example.invalid',
    QUOKY_JIRA_TOKEN: 'r2-jira-token-placeholder',
    QUOKY_SLACK_TOKEN: 'r2-slack-token-placeholder',
    QUOKY_NL_INTENT_MODE: 'active',
    ...env,
  });

  vi?.resetModules();
  const core = await import('@quoky/core');
  const { AppModule } = await import('./app.module');
  const { stubProviderSelection } = await import('./provider-selection/test-support');
  const { ActorIdentityProvisioner } = await import('./actor-identity-provisioner');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const storage = app.get<StorageProvider>(core.STORAGE_PROVIDER);
  await storage.init();
  await app.get<{ init(): Promise<void> }>(core.VECTOR_PROVIDER).init();
  const stub = (provider: AiProvider): void => {
    Object.assign(provider, {
      async isAvailable() {
        return true;
      },
      async execute(request: AiRequest) {
        requests.push(request);
        if (request.capability === SELECTION) return { text: state.selector, artifacts: [] };
        if (request.capability === SUMMARIZATION) return { text: state.summarizeRequest !== undefined ? await state.summarizeRequest(request) : state.summarizer(request.prompt), artifacts: [] };
        return { text: state.chat, artifacts: [] };
      },
    });
  };
  for (const provider of app.get<AiProvider[]>(core.AI_PROVIDERS)) stub(provider);
  stubProviderSelection(app, stub);
  await app.get(ActorIdentityProvisioner).provision();
  Object.assign(app.get<PlatformAdapter>(core.PLATFORM_ADAPTER) as object, { start: async () => undefined, stop: async () => undefined, sendTyping: async () => undefined, sendMessage: async () => undefined });
  const runtime = app.get(core.ConversationRuntime) as { handle(message: InboundMessage): Promise<TurnResult> };
  const dm: ConversationContext = { platform: 'discord', channelId: '888888888888888817', userId: R2_OWNER, direct: true };
  const channel: ConversationContext = { platform: 'discord', spaceId: '999999999999999917', channelId: '770000000000000017', userId: R2_OWNER, direct: false };
  let seq = 0;
  await runtime.handle({ id: 'r2-hello', context: dm, text: '안녕', receivedAt: new Date().toISOString() });
  const found = await storage.actors.findByExternalIdentity('discord', R2_OWNER);
  if (found === null) throw new Error('owner actor missing');
  const owner = await storage.actors.save({ ...found, identities: [...found.identities, { platform: 'jira', externalId: 'r2-jira-owner' }] });
  const isItemFetch = (entry: string): boolean => /\/rest\/api\/3\/issue\/\d+/.test(entry) || entry.includes('/api/conversations.replies');

  const harness: R2Harness = {
    core,
    storage,
    owner,
    requests,
    fetched,
    itemFetches: () => fetched.filter(isItemFetch),
    get jira() {
      return state.jira;
    },
    set jira(value) {
      state.jira = value;
    },
    get jiraProjects() {
      return state.jiraProjects;
    },
    set jiraProjects(value) {
      state.jiraProjects = value;
    },
    get jiraVersions() {
      return state.jiraVersions;
    },
    set jiraVersions(value) {
      state.jiraVersions = value;
    },
    get slack() {
      return state.slack;
    },
    set slack(value) {
      state.slack = value;
    },
    get selector() {
      return state.selector;
    },
    set selector(value) {
      state.selector = value;
    },
    get summarizer() {
      return state.summarizer;
    },
    set summarizer(value) {
      state.summarizer = value;
    },
    get summarizeRequest() {
      return state.summarizeRequest;
    },
    set summarizeRequest(value) {
      state.summarizeRequest = value;
    },
    get chat() {
      return state.chat;
    },
    set chat(value) {
      state.chat = value;
    },
    get slackReplyMode() {
      return state.slackReplyMode;
    },
    set slackReplyMode(value) {
      state.slackReplyMode = value;
    },
    get extraReplies() {
      return state.extraReplies;
    },
    set extraReplies(value) {
      state.extraReplies = value;
    },
    logLines() {
      return [...consoleLines];
    },
    dm,
    channel,
    async turn(text, selector = none, context = dm, extra = {}) {
      state.selector = selector;
      const start = requests.length;
      const fetchStart = fetched.length;
      seq += 1;
      const result = await runtime.handle({ id: `r2-${seq}`, context, text, receivedAt: new Date().toISOString(), ...extra });
      const made = requests.slice(start);
      return {
        result,
        text: result.reply.text,
        selects: made.filter((request) => request.capability === SELECTION),
        summaries: made.filter((request) => request.capability === SUMMARIZATION),
        chats: made.filter((request) => request.capability !== SELECTION && request.capability !== SUMMARIZATION),
        items: fetched.slice(fetchStart).filter(isItemFetch),
      };
    },
    async history() {
      return (await storage.memories.findShortTermByUser(R2_OWNER)).map((record) => record.content);
    },
    async sessionMetadata() {
      const sessions = await storage.sessions.list();
      const session = sessions.find((candidate) => candidate.context.channelId === dm.channelId);
      return (session?.metadata ?? {}) as Record<string, unknown>;
    },
    service() {
      return (runtime as unknown as { deps: { nlSelection: ReturnType<R2Harness['service']> } }).deps.nlSelection;
    },
    async close() {
      await storage.close().catch(() => undefined);
      await app.close().catch(() => undefined);
      process.env = savedEnv;
      globalThis.fetch = savedFetch;
      Object.assign(console, savedConsole);
      vi?.restoreAllMocks();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
  return harness;
}
