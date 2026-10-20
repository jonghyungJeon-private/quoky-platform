import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeGmailTokenFile } from '@quoky/connector-gmail';
import { writeGDriveTokenFile } from '@quoky/connector-gdrive';
import type { AgentRunService, AiProvider, AiRequest, ConnectorProvider, ConversationContext, InboundMessage, LogFields, Logger, StorageProvider, TurnResult } from '@quoky/core';

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
            return { text: request.prompt.startsWith('You are the request planner') ? PLAN : selectorAnswer, artifacts: [] };
          }
          return { text: CHAT_REPLY, artifacts: [] };
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

  /**
   * Each case runs twice on a fresh DM: once with the agent in `off` behind a proxy that refuses every member but `mode`,
   * once with no `agentRuns` dep at all (the selection cache cleared before each run). Returns the touched members.
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
    // The selection output cache would answer the second run without a call.
    const selectionCache = (deps.nlSelection as { cache: Map<string, unknown> }).cache;
    const trace = (): string[] => [
      ...requests.map((request) => `${request.capability}:${request.capability === 'INTENT_SELECTION' ? request.prompt : request.prompt.slice(0, 40)}`),
      ...reads,
    ];
    const run = async (text: string, withAgent: boolean): Promise<string[]> => {
      requests.length = 0;
      reads.length = 0;
      selectionCache.clear();
      if (withAgent) deps.agentRuns = guarded;
      else delete deps.agentRuns;
      const reply = (await send(text)).reply.text;
      return [reply, ...trace()];
    };
    const mismatches: string[] = [];
    const stateful: string[] = [];
    try {
      for (const c of cases) {
        selectorAnswer = c.answer;
        // Baseline: a case whose own reply changes between two runs without the agent is state-dependent (a reminder's
        // display number, a cancel of a reminder the previous run created): it cannot be compared and is listed.
        const baseline = await run(c.text, false);
        const without = await run(c.text, false);
        if (JSON.stringify(baseline) !== JSON.stringify(without)) {
          stateful.push(c.text);
          continue;
        }
        const withOff = await run(c.text, true);
        if (JSON.stringify(withOff) !== JSON.stringify(without)) mismatches.push(c.text);
      }
    } finally {
      deps.agentRuns = live;
      selectorAnswer = NONE;
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

  it('off is byte-identical over the nl-intent corpus (every golden selector answer, 874 cases)', async () => {
    const corpus = JSON.parse(readFileSync(join(__dirname, '../../../../packages/core/src/application/golden/nl-intent.v1.json'), 'utf8')) as {
      cases: Array<{ text: string; expect: 'none' | { entryId: string; args: Record<string, unknown> } }>;
    };
    expect(corpus.cases.length).toBeGreaterThan(800);
    const cases = corpus.cases.map((c) => ({
      text: c.text,
      answer: c.expect === 'none' ? NONE : JSON.stringify({ entryId: c.expect.entryId, args: c.expect.args, ambiguity: 'CLEAR', alternatives: [] }),
    }));
    const { touched, mismatches, stateful } = await compareOff(cases);
    // Only the state-changing reminder phrases (a new display number, a cancel of the reminder just created) are
    // incomparable; everything else is compared.
    expect(stateful.length).toBeLessThanOrEqual(10);
    for (const text of stateful) expect(text, text).toMatch(/알려줘|알림|remind/i);
    expect(mismatches).toEqual([]);
    expect([...touched]).toEqual(['mode']);
    expect(plannerCalls()).toHaveLength(0);
  }, 240_000);
});
