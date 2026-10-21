import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeGmailTokenFile } from '@quoky/connector-gmail';
import { writeGDriveTokenFile } from '@quoky/connector-gdrive';
import type { Actor, AgentRunService, AiProvider, AiRequest, ConnectorProvider, ConversationContext, InboundMessage, LogFields, Logger, Session, StorageProvider, TurnResult } from '@quoky/core';

/**
 * ADR-0121 stage S2 (P1) end to end, offline: the REAL `AppModule` (real `AgentRunService`, real `NlSelectionService` in
 * `active`, the real turn handlers) over a real SQLite file, with `QUOKY_AGENT_MODE=shadow`. Only the edges are stubbed:
 * the AI providers (the selection call and the planner call answer from a script; nothing is spawned), and the work
 * connectors and the calendar, mail and Drive readers, which RECORD and THROW (a shadow read would be visible here).
 *
 * - shadow: a DM turn that reached selection gets one background planner call after its reply; 0 connector reads and
 *   0 M2 (SUMMARIZATION) calls; the reply is the same as without the agent; one content-free `agent_run.shadow` line.
 * - the kill switch: `에이전트 중지` stops shadow without a restart (NL actions are off, so the agent answers the phrase),
 *   `에이전트 재개` restores it.
 * - off: byte-identical — with the agent in `off` the runtime reads `mode` and nothing else (a proxy refuses any other
 *   member), and every reply equals the reply of the same runtime without the `agentRuns` dep.
 */

const OWNER = '111111111111111111';
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
const CHAT_REPLY = 'S2 stub chat reply';
const PLAN = JSON.stringify({
  steps: [
    { entryId: 'calendar.events', args: { range: 'this-week' } },
    { entryId: 'mail.list', args: { unread: true } },
    { entryId: 'jira.issues', args: {} },
    { summarize: [1, 2, 3], schema: 'digest.v1' },
  ],
  ambiguity: 'CLEAR',
});
const NONE = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
const MULTI_ASK = '이번 주 일정이랑 안 읽은 메일이랑 내 지라 이슈 한번에 정리해줘';

describe('ADR-0121 S2 P1 — the agent in shadow through the production AppModule (offline)', () => {
  let tempDir = '';
  let savedEnv: NodeJS.ProcessEnv = {};
  let closeApp: (() => Promise<void>) | undefined;
  let core: typeof import('@quoky/core');
  let runtime: { handle(message: InboundMessage): Promise<TurnResult>; lastAgentAfterReplyRun: Promise<void> };
  let agent: AgentRunService;
  let storage: StorageProvider;
  const requests: AiRequest[] = [];
  const reads: string[] = [];
  const agentLogs: Array<{ event: string; fields?: LogFields }> = [];
  let seq = 0;
  let selectorAnswer = NONE;
  let planAnswer = PLAN;
  let chatReply = CHAT_REPLY;

  beforeAll(async () => {
    for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), 'quoky-s2p1-'));
    const gmailToken = join(tempDir, 'gmail.json');
    const driveToken = join(tempDir, 'drive.json');
    writeGmailTokenFile(gmailToken, 's2-gmail-refresh-placeholder');
    writeGDriveTokenFile(driveToken, 's2-drive-refresh-placeholder');
    Object.assign(process.env, {
      QUOKY_DISCORD_OWNER_IDS: OWNER,
      QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
      QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
      QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
      QUOKY_OLLAMA_ENABLED: 'false',
      CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
      QUOKY_TIMEZONE: 'Asia/Seoul',
      QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 's2-calendar-client',
      QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 's2-calendar-client-placeholder',
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 's2-calendar-refresh-placeholder',
      QUOKY_GMAIL_TOKEN_FILE: gmailToken,
      QUOKY_DRIVE_TOKEN_FILE: driveToken,
      QUOKY_NL_INTENT_MODE: 'active',
      QUOKY_AGENT_MODE: 'shadow',
    });
    vi.resetModules();
    core = await import('@quoky/core');
    const { AppModule } = await import('../app.module');
    const { AGENT_RUNS } = await import('../features/agent.providers');
    const { stubProviderSelection } = await import('../provider-selection/test-support');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    storage = app.get<StorageProvider>(core.STORAGE_PROVIDER);
    await storage.init();
    await app.get<{ init(): Promise<void> }>(core.VECTOR_PROVIDER).init();
    closeApp = async () => {
      await storage.close().catch(() => undefined);
      await app.close();
    };

    const stub = (provider: AiProvider): void => {
      Object.assign(provider, {
        async isAvailable() {
          return true;
        },
        async execute(request: AiRequest) {
          requests.push(request);
          if (request.capability === 'INTENT_SELECTION') {
            return { text: request.prompt.startsWith('You are the request planner') ? planAnswer : selectorAnswer, artifacts: [] };
          }
          return { text: chatReply, artifacts: [] };
        },
      });
    };
    for (const provider of app.get<AiProvider[]>(core.AI_PROVIDERS)) stub(provider);
    stubProviderSelection(app, stub);

    // Every external read records itself and throws: a shadow read would be visible (and could never succeed).
    const connectors = app.get<ConnectorProvider[]>(core.CONNECTOR_PROVIDERS);
    for (const source of ['jira', 'github', 'slack', 'confluence']) {
      connectors.push({
        source,
        readOnly: true,
        async isAvailable() {
          return true;
        },
        async query() {
          reads.push(`connector:${source}`);
          throw new Error('S2 P1: no connector read');
        },
      });
    }
    const throwing = (name: string) => async () => {
      reads.push(name);
      throw new Error('S2 P1: no reader call');
    };
    Object.assign(app.get(core.CALENDAR_READER) as object, { listEvents: throwing('calendar:listEvents') });
    Object.assign(app.get(core.MAIL_READER) as object, { search: throwing('mail:search'), getMessage: throwing('mail:getMessage') });
    Object.assign(app.get(core.DRIVE_READER) as object, { searchByName: throwing('drive:searchByName'), recentFiles: throwing('drive:recentFiles'), exportText: throwing('drive:exportText') });

    runtime = app.get(core.ConversationRuntime);
    agent = app.get<AgentRunService>(AGENT_RUNS);
    const capture: Logger = {
      info: (event, fields) => void agentLogs.push({ event, ...(fields ? { fields } : {}) }),
      warn: (event, fields) => void agentLogs.push({ event, ...(fields ? { fields } : {}) }),
      error: (event, fields) => void agentLogs.push({ event, ...(fields ? { fields } : {}) }),
    };
    (agent as unknown as { deps: { logger: Logger } }).deps.logger = capture;
    await send('안녕');
  }, 120_000);

  afterAll(async () => {
    await closeApp?.();
    process.env = savedEnv;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    requests.length = 0;
    reads.length = 0;
    agentLogs.length = 0;
  });

  function dm(): ConversationContext {
    seq += 1;
    return { platform: 'discord', channelId: `8800000000${String(seq).padStart(8, '0')}`, userId: OWNER, direct: true };
  }

  async function send(text: string, ctx: ConversationContext = dm(), target: { handle(message: InboundMessage): Promise<TurnResult>; lastAgentAfterReplyRun: Promise<void> } = runtime): Promise<TurnResult> {
    seq += 1;
    const result = await target.handle({ id: `s2-${seq}`, context: ctx, text, receivedAt: new Date().toISOString() });
    // Let the after-reply job start and finish (production never awaits it).
    await new Promise((resolve) => setImmediate(resolve));
    await target.lastAgentAfterReplyRun;
    await agent.lastShadowRun;
    await (target as { lastAfterReplyRun?: Promise<void> }).lastAfterReplyRun;
    return result;
  }

  const plannerCalls = () => requests.filter((request) => request.capability === 'INTENT_SELECTION' && request.prompt.startsWith('You are the request planner'));
  const shadowLines = () => agentLogs.filter((log) => log.event === 'agent_run.shadow').map((log) => log.fields ?? {});

  it('is composed in shadow from QUOKY_AGENT_MODE', () => {
    expect(agent.mode).toBe('shadow');
  });

  it('a DM turn that reached selection gets one planner call after its reply: 0 connector reads, 0 M2 calls, one content-free line', async () => {
    const result = await send(MULTI_ASK);
    expect(result.reply.text).toContain(CHAT_REPLY);
    expect(plannerCalls()).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(requests.some((request) => request.capability === 'SUMMARIZATION')).toBe(false);
    expect(shadowLines()).toEqual([
      expect.objectContaining({ outcome: 'planned', steps: 4, entries: 'calendar.events,mail.list,jira.issues,summarize:digest.v1', validator: 'ok' }),
    ]);
    expect(JSON.stringify(agentLogs)).not.toContain('지라');
    expect(JSON.stringify(agentLogs)).not.toContain('정리');
  });

  it('never runs in a channel (DM only), and never on a turn that did not reach selection', async () => {
    await send(MULTI_ASK, { platform: 'discord', spaceId: '999999999999999901', channelId: '770000000000000001', userId: OWNER, direct: false });
    await send('도움말');
    expect(plannerCalls()).toHaveLength(0);
    expect(reads).toEqual([]);
  });

  it('에이전트 중지 stops shadow without a restart; 에이전트 재개 restores it', async () => {
    const stopped = await send('에이전트 중지');
    expect(stopped.reply.text).toBe('다단계 에이전트를 멈췄어요. 정확한 명령은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
    await send(MULTI_ASK);
    expect(plannerCalls()).toHaveLength(0);
    expect(shadowLines()).toEqual([expect.objectContaining({ outcome: 'stopped', reason: 'kill-switch' })]);
    const resumed = await send('에이전트 재개');
    expect(resumed.reply.text).toBe('다단계 에이전트를 다시 켰어요.');
    await send(MULTI_ASK);
    expect(plannerCalls()).toHaveLength(1);
    expect(reads).toEqual([]);
  });


  it('shadows only fresh read selections: an A6 action decision and a turn with an open question are skipped; liveSource is logged', async () => {
    const internals = runtime as unknown as {
      queueAgentShadow(...args: unknown[]): void;
      agentAfterReply: WeakMap<InboundMessage, unknown>;
    };
    const owner = (await storage.actors.findByExternalIdentity('discord', OWNER)) as Actor;
    const session = { id: 'shadow-filter', actorId: owner.id, metadata: {} } as unknown as Session;
    const chat = { id: 'claude', locality: 'REMOTE' };
    const read = { entryId: 'jira.issues', args: {}, language: 'ko' };
    const pendingQuestion = { kind: 'entry', at: new Date().toISOString(), language: 'ko', options: [] };
    const cases: Array<[string, unknown, unknown, boolean]> = [
      ['fresh read execute', { kind: 'execute', command: read }, null, true],
      ['fresh none', { kind: 'none' }, null, true],
      ['fresh read question', { kind: 'ask', text: 'q' }, undefined, true],
      ['A6 action execute', { kind: 'execute', command: { entryId: 'todo.add', args: { title: 'x' }, language: 'ko' } }, null, false],
      ['A6 audit on a decision', { kind: 'execute', command: read, action: { entryId: 'item.summarize' } }, null, false],
      ['A6 question', { kind: 'ask', text: 'q', entryId: 'todo.complete' }, null, false],
      ['answer to an open question', { kind: 'execute', command: read }, pendingQuestion, false],
      ['skipped selection', { kind: 'skip', reason: 'too-long' }, null, false],
      ['unavailable selection', { kind: 'unavailable' }, null, false],
    ];
    for (const [label, decision, pending, queued] of cases) {
      seq += 1;
      const message: InboundMessage = { id: `filter-${seq}`, context: dm(), text: MULTI_ASK, receivedAt: new Date().toISOString() };
      internals.queueAgentShadow(message, session, owner, [], decision, chat, 'chat', pending);
      expect(internals.agentAfterReply.has(message), label).toBe(queued);
      internals.agentAfterReply.delete(message);
    }
    await send(MULTI_ASK);
    expect(shadowLines()).toEqual([expect.objectContaining({ outcome: 'planned', liveKind: 'none', liveSource: 'chat' })]);
  });

  it('kill-switch reply composition: (a) A6 on + agent shadow, (b) A6 off + grants enforced, (c) A6 on + agent off is byte-identical', async () => {
    const deps = (runtime as unknown as { deps: Record<string, unknown> }).deps;
    const nl = deps.nlSelection as { actionLevelValue: string; deps: Record<string, unknown> };
    const saved = { level: nl.actionLevelValue, nlDeps: nl.deps, grants: deps.surfaceGrants as Record<string, unknown>, agent: deps.agentRuns };
    const a6 = (state: 'stopped' | 'running') => core.renderActionSwitchReply(state, 'ko');
    const quiet: Logger = { info() {}, warn() {}, error() {} };
    const enableA6 = (): void => {
      nl.actionLevelValue = 'shadow';
      nl.deps = {
        ...saved.nlDeps,
        actions: { level: 'shadow', killSwitch: new core.NlActionSwitch({ actors: { get: (id) => storage.actors.get(id), save: (actor) => storage.actors.save(actor) }, logger: quiet }) },
      };
    };
    const off = new core.AgentRunService({ mode: 'off', router: { select: async () => { throw new Error('never'); } }, actors: { get: async () => null, save: async (actor) => actor }, logger: quiet, timeZone: 'Asia/Seoul' });
    try {
      // (a) A6 answers and saves; the agent (shadow) adds its line.
      enableA6();
      expect((await send('에이전트 중지')).reply.text).toBe(`${a6('stopped')}\n다단계 에이전트도 함께 멈췄어요.`);
      expect((await send('에이전트 재개')).reply.text).toBe(`${a6('running')}\n다단계 에이전트도 함께 다시 켰어요.`);
      // (c) A6 on, agent off: exactly the A6 reply, and the same as with no agent dep at all.
      deps.agentRuns = off;
      const withOff = (await send('에이전트 중지')).reply.text;
      delete deps.agentRuns;
      const without = (await send('에이전트 중지')).reply.text;
      expect(withOff).toBe(a6('stopped'));
      expect(without).toBe(withOff);
      expect((await send('에이전트 재개')).reply.text).toBe(a6('running'));
      deps.agentRuns = saved.agent;
      // (b) A6 off, channel grants enforced: the agent answers, then the D4.6 channel-grants suffix.
      nl.actionLevelValue = saved.level;
      nl.deps = saved.nlDeps;
      deps.surfaceGrants = { ...saved.grants, gate: new core.SurfaceGate('enforce') };
      expect((await send('에이전트 중지')).reply.text).toBe(`다단계 에이전트를 멈췄어요. 정확한 명령은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.\n${core.renderSurfaceSwitchSuffix('stopped', 'ko')}`);
      expect((await send('에이전트 재개')).reply.text).toBe(`다단계 에이전트를 다시 켰어요.\n${core.renderSurfaceSwitchSuffix('running', 'ko')}`);
    } finally {
      nl.actionLevelValue = saved.level;
      nl.deps = saved.nlDeps;
      deps.surfaceGrants = saved.grants;
      deps.agentRuns = saved.agent;
    }
    const owner = (await storage.actors.findByExternalIdentity('discord', OWNER)) as Actor;
    expect(agent.switchState(owner)).toBe('running');
  });

  it('a near miss of the switch phrase gets the exact phrase and never switches (live DM 2026-10-20; owner decision: exact only)', async () => {
    const owner = async (): Promise<Actor> => (await storage.actors.findByExternalIdentity('discord', OWNER)) as Actor;
    const resumeHint = '에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
    const stopHint = '에이전트를 멈추려면 "에이전트 중지"라고 보내 주세요.';
    // The live turns: a typo and a truncation of 재개 are answered with the exact phrase, never by chat; nothing changes.
    for (const text of ['에이ㄴ트 재개', '에이전트 재', '에이전트 재개해줘']) {
      const result = await send(text);
      expect(result.reply.text, text).toBe(resumeHint);
    }
    expect(agent.switchState(await owner())).toBe('running');
    expect(requests).toEqual([]);
    // A near miss of 중지 (truncation, request form or typo) only hints: the switch acts only on the exact phrase.
    for (const text of ['에이전트 중', '에이전트 중지해줘', '에이전트 중자', '에이전트 주지', '에이전트 정지']) {
      expect((await send(text)).reply.text, text).toBe(stopHint);
      expect(agent.switchState(await owner()), text).toBe('running');
    }
    // The exact phrases switch exactly as before; a near miss of 재개 never resumes.
    expect((await send('에이전트 중지')).reply.text).toBe('다단계 에이전트를 멈췄어요. 정확한 명령은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
    expect(agent.switchState(await owner())).toBe('stopped');
    for (const text of ['에이전트 재게', '에이전트 재고']) {
      expect((await send(text)).reply.text, text).toBe(resumeHint);
      expect(agent.switchState(await owner()), text).toBe('stopped');
    }
    expect((await send('에이전트 재개')).reply.text).toBe('다단계 에이전트를 다시 켰어요.');
    expect(agent.switchState(await owner())).toBe('running');
    // A normal sentence that mentions 에이전트 is chat as before.
    for (const text of ['에이전트 좋지', '에이전트가 뭐야']) expect((await send(text)).reply.text, text).toContain(CHAT_REPLY);
    // The log line is content-free.
    expect(JSON.stringify(agentLogs)).not.toContain('에이ㄴ트');
  });

  it('honest chat names the control commands and replaces a reply that denies one (live DM 2026-10-20)', async () => {
    chatReply = '죄송해요. 에이전트를 재개하는 별도의 명령어는 없어요. 다른 도움이 필요하면 말씀해 주세요.';
    try {
      const result = await send('에이전트 다시 켜는 명령 있어?');
      expect(result.reply.text).toBe('죄송해요. 다른 도움이 필요하면 말씀해 주세요. 에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
      const chat = requests.find((request) => request.capability === 'GENERAL_CHAT' || request.capability === 'POLICY_SENSITIVE_CHAT');
      // The fact rides in the prompt's JSON current facts (quotes escaped there).
      // NL actions are off in this module, the agent is in shadow: the fact names the agent only.
      expect(chat?.prompt).toContain(JSON.stringify(core.renderControlCommandsFact({ actions: false, agent: true, grants: false })).slice(1, -1));
    } finally {
      chatReply = CHAT_REPLY;
    }
  });

  it('Codex P2: the control fact and the denial guard apply to every owner DM chat while the switch is recognized, with no selection or catalog', async () => {
    const deps = (runtime as unknown as { deps: Record<string, unknown> }).deps;
    const saved = { nl: deps.nlSelection, agent: deps.agentRuns };
    const denial = '에이전트를 재개하는 명령어는 없어요.';
    const fact = JSON.stringify(core.renderControlCommandsFact({ actions: false, agent: true, grants: false })).slice(1, -1);
    const chatPrompt = () => requests.find((request) => request.capability === 'GENERAL_CHAT' || request.capability === 'POLICY_SENSITIVE_CHAT')?.prompt ?? '';
    chatReply = denial;
    try {
      // No selection service at all (so no read catalog fact): the agent in shadow still recognizes the switch.
      delete deps.nlSelection;
      const result = await send('오늘 기분 어때');
      expect(result.reply.text).toBe('에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
      expect(chatPrompt()).toContain(fact);
      // With nothing recognizing the switch, the prompt and the reply are unchanged.
      deps.agentRuns = new core.AgentRunService({ mode: 'off', router: { select: async () => { throw new Error('never'); } }, actors: { get: async () => null, save: async (actor) => actor }, logger: { info() {}, warn() {}, error() {} }, timeZone: 'Asia/Seoul' });
      requests.length = 0;
      const off = await send('오늘 기분 어때');
      expect(off.reply.text).toBe(denial);
      expect(chatPrompt()).not.toContain('control commands');
    } finally {
      deps.nlSelection = saved.nl;
      deps.agentRuns = saved.agent;
      chatReply = CHAT_REPLY;
    }
  });

  /** Reminder rows are reset before every run, so a reminder phrase gets the same display number in each run. */
  const resetReminders = (): void => {
    (storage as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db.prepare('DELETE FROM reminders').run();
  };

  /**
   * Each case runs three times on a fresh DM, reminders reset before each run: without the `agentRuns` dep, with the agent
   * in `off` behind a proxy that refuses every member but `mode`, and without the dep again. The two runs without the dep
   * must agree (else the case is listed as `stateful`), and the `off` run must equal them (else `mismatches`).
   */
  async function compareOff(cases: ReadonlyArray<{ readonly text: string; readonly answer: string }>): Promise<{ touched: Set<string>; mismatches: string[]; stateful: string[] }> {
    const deps = (runtime as unknown as { deps: Record<string, unknown> }).deps;
    const live = deps.agentRuns;
    const touched = new Set<string>();
    const off = new core.AgentRunService({ mode: 'off', router: { select: async () => { throw new Error('never'); } }, actors: { get: async () => null, save: async (actor) => actor }, logger: { info() {}, warn() {}, error() {} }, timeZone: 'Asia/Seoul' });
    const guarded = new Proxy(off, {
      get(target, property, receiver) {
        touched.add(String(property));
        if (property !== 'mode') throw new Error(`agentRuns.${String(property)} read while off`);
        return Reflect.get(target, property, receiver);
      },
    });
    // The selection output cache would answer a later run without a call.
    const selectionCache = (deps.nlSelection as { cache: Map<string, unknown> }).cache;
    const trace = (): string[] => [
      ...requests.map((request) => `${request.capability}:${request.capability === 'INTENT_SELECTION' ? request.prompt : request.prompt.slice(0, 40)}`),
      ...reads,
    ];
    const run = async (text: string, withAgent: boolean): Promise<string> => {
      requests.length = 0;
      reads.length = 0;
      selectionCache.clear();
      resetReminders();
      if (withAgent) deps.agentRuns = guarded;
      else delete deps.agentRuns;
      const reply = (await send(text)).reply.text;
      return JSON.stringify([reply, ...trace()]);
    };
    const mismatches: string[] = [];
    const stateful: string[] = [];
    try {
      for (const c of cases) {
        selectorAnswer = c.answer;
        const before = await run(c.text, false);
        const withOff = await run(c.text, true);
        const after = await run(c.text, false);
        if (before !== after) stateful.push(c.text);
        if (withOff !== before && withOff !== after) mismatches.push(c.text);
      }
    } finally {
      deps.agentRuns = live;
      selectorAnswer = NONE;
      resetReminders();
    }
    return { touched, mismatches, stateful };
  }

  it('off is byte-identical: the runtime reads only `mode`, and every reply, provider request and read equals the run without the agent dep', async () => {
    const texts = [MULTI_ASK, '에이전트 중지', '에이전트 재개', '오늘 기분 어때?'];
    const { touched, mismatches, stateful } = await compareOff(texts.map((text) => ({ text, answer: NONE })));
    expect(stateful).toEqual([]);
    expect(mismatches).toEqual([]);
    expect([...touched]).toEqual(['mode']);
    expect(plannerCalls()).toHaveLength(0);
  });

  it('off is byte-identical over the nl-intent corpus (every golden selector answer, 873 cases, reminder phrases included)', async () => {
    const corpus = JSON.parse(readFileSync(join(__dirname, '../../../../packages/core/src/application/golden/nl-intent.v1.json'), 'utf8')) as {
      cases: Array<{ text: string; expect: 'none' | { entryId: string; args: Record<string, unknown> } }>;
    };
    expect(corpus.cases.length).toBeGreaterThan(800);
    const cases = corpus.cases.map((c) => ({
      text: c.text,
      answer: c.expect === 'none' ? NONE : JSON.stringify({ entryId: c.expect.entryId, args: c.expect.args, ambiguity: 'CLEAR', alternatives: [] }),
    }));
    const { touched, mismatches, stateful } = await compareOff(cases);
    // With the reminder rows reset before every run, no case is state-dependent: every case is compared strictly.
    expect(stateful).toEqual([]);
    expect(mismatches).toEqual([]);
    expect([...touched]).toEqual(['mode']);
    expect(plannerCalls()).toHaveLength(0);
  }, 240_000);

  // Last: its write turn adds a to-do, which the off-identity corpus above must not see.
  it('c-shadow: a read the grammar answered is planned too (liveSource grammar); a write or control turn is not; the kill switch holds', async () => {
    const nl = (runtime as unknown as { deps: { nlSelection: { deps: Record<string, unknown> } } }).deps.nlSelection;
    const savedDeps = nl.deps;
    nl.deps = { ...savedDeps, phase: 'c-shadow' };
    planAnswer = JSON.stringify({ entryId: 'calendar.events', args: { range: 'today' }, ambiguity: 'CLEAR', alternatives: [] });
    try {
      await send('오늘 일정 보여줘');
      // The grammar's own read (the stub reader records it); the shadow read nothing.
      expect(reads).toEqual(['calendar:listEvents']);
      expect(plannerCalls()).toHaveLength(1);
      expect(requests.some((request) => request.capability === 'SUMMARIZATION')).toBe(false);
      expect(shadowLines()).toEqual([
        expect.objectContaining({ outcome: 'planned', steps: 1, entries: 'calendar.events', liveKind: 'execute', liveSource: 'grammar', agreeEntry: true }),
      ]);
      expect(JSON.stringify(agentLogs)).not.toContain('일정');
      // Write, control and switch turns are never planned.
      for (const text of ['할 일 추가: 우유 사기', '도움말', '에이전트 중지', '에이전트 재개']) {
        requests.length = 0;
        agentLogs.length = 0;
        await send(text);
        expect(plannerCalls(), text).toHaveLength(0);
        expect(shadowLines(), text).toEqual([]);
      }
      // The kill switch: stopped, a grammar read is not planned; resumed, it is again.
      await send('에이전트 중지');
      requests.length = 0;
      agentLogs.length = 0;
      await send('오늘 일정 보여줘');
      expect(plannerCalls()).toHaveLength(0);
      expect(shadowLines()).toEqual([expect.objectContaining({ outcome: 'stopped', reason: 'kill-switch' })]);
      await send('에이전트 재개');
      requests.length = 0;
      await send('오늘 일정 보여줘');
      expect(plannerCalls()).toHaveLength(1);
    } finally {
      nl.deps = savedDeps;
      planAnswer = PLAN;
    }
  });
});
