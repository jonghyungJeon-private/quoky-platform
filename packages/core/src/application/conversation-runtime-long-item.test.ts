import { describe, expect, it } from 'vitest';
import { Capability, IntentType, MemoryType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { Actor, ConversationContext, InboundMessage, Intent, MemoryRecord, OutboundMessage, Session, Task, TaskRun } from '../domain';
import type {
  AiProvider,
  AiRequest,
  ConversationTurnHandler,
  DriveDocument,
  DriveDocumentSection,
  DriveReader,
  LogFields,
  Logger,
  MailMessage,
  MailReader,
  StorageProvider,
} from '../ports';
import { ContextBuilder } from './context-builder';
import { ConversationRuntime, type ConversationRuntimeDeps, type LongItemSummaryOptions } from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import type { MemoryManager } from './memory-manager';
import type { MemoryRetriever } from './memory-retriever';
import type { MemoryWriter } from './memory-writer';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { renderUntrustedDocumentHistoryNote } from './untrusted-document-readout';
import { createMailTurnHandler } from './mail/mail-turn-handler';
import { createDriveTurnHandler } from './drive/drive-turn-handler';
import { renderMailSummaryLocalFooter, renderMailSummaryRefused, renderMailThreadSummaryLocalFooter } from './mail/mail-reply-renderer';
import { renderDriveSummaryLocalFooter } from './drive/drive-reply-renderer';
import { renderLongItemProgressNotice, preparedLongItemBody, type LongItemSummaryInput } from './item-summary/long-item';
import type { ChunkItemsMode } from './item-summary/s3-item-summary';

/**
 * ADR-0124 Part L C5a-2: the S3 long-item summary wired through the REAL ConversationRuntime, the real mail and Drive
 * handlers, PromptComposer and PromptRenderer. Only storage, the readers, the providers and Task bookkeeping are fakes. A
 * remote fake (the chat tier) and a LOCAL fake (the long-item model) are both registered behind one router: the router
 * answers the local one ONLY under `requiredLocality: 'LOCAL'`, as the composition root's policy does.
 */

const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
const CHANNEL: ConversationContext = { platform: 'test', spaceId: 'g-1', channelId: 'chan-1', userId: 'owner-user', direct: false };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const T0 = '2026-11-09T01:00:00.000Z';
/** A canary in every item: it must never reach a log line or the history. */
const CANARY = ['zq', 'canary', 'vxw'].join('');
const SECRET = ['gh', 'p_', 'C'.repeat(36)].join('');
const REMOTE_SUMMARY = '원격 요약이에요.';
const LOCAL_NOTE = '- 계획 항목과 날짜가 적혀 있어요.';
const LOCAL_SUMMARY = '이 기기에서 만든 요약이에요.';

/** About 700 code points of plain Korean-and-Latin text per paragraph, with a position marker and the canary. */
function paragraph(index: number): string {
  return [`문단${index} ${CANARY}.`, ...Array.from({ length: 14 }, (_, at) => `항목 ${index}-${at} 은 일정과 담당을 적은 줄이에요 plain words ${at}.`)].join(' ');
}
const LONG_BODY = Array.from({ length: 12 }, (_, index) => paragraph(index)).join('\n\n');
const SHORT_BODY = `짧은 메일이에요 ${CANARY}.`;

/** Core's coverage line (N5), either form. */
const COVERAGE = /^전체 \d+개 구간(?: 중 \d+개를|을 모두) 읽고 답했어요/mu;
/** The comparable part of a turn result (session ids are fresh per harness). */
const view = (result: { readonly status: string; readonly reply: OutboundMessage }) => ({ status: result.status, reply: result.reply });

type LocalMode = 'ok' | 'throws-second' | 'not-ready' | 'blocked' | 'claim';

interface HarnessOptions {
  readonly mode?: ChunkItemsMode | 'absent';
  /** The handlers attach the whole item (the composition root sets it for shadow / on). */
  readonly longItems?: boolean;
  readonly body?: string;
  readonly threadBodies?: readonly string[];
  readonly driveText?: string;
  readonly driveSections?: readonly DriveDocumentSection[];
  readonly local?: LocalMode;
  readonly extraHandler?: ConversationTurnHandler;
}

function harness(opts: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const remoteCalls: AiRequest[] = [];
  const localCalls: AiRequest[] = [];
  const recordAssistant: string[] = [];
  const logs: { level: string; message: string; fields?: LogFields }[] = [];
  const notices: OutboundMessage[] = [];
  const timers: { ms: number; fire: () => void }[] = [];
  let releaseLocal: () => void = () => undefined;
  const localGate = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  let localStarted: () => void = () => undefined;
  const localStartedPromise = new Promise<void>((resolve) => {
    localStarted = resolve;
  });

  const storage = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, { ...s });
        return s;
      },
      async get(id: string) {
        return sessions.get(id) ?? null;
      },
      async findActiveByContext(platform: string, channelId: string, threadId?: string) {
        return (
          [...sessions.values()].find(
            (s) => s.status === SessionStatus.ACTIVE && s.context.platform === platform && s.context.channelId === channelId && s.context.threadId === threadId,
          ) ?? null
        );
      },
    },
  };
  const sessionManager = new SessionManager(storage as unknown as StorageProvider);

  const mailSummary = { id: 'msg-long', sender: { name: 'Planner', address: 'planner@example.com' }, subject: '분기 계획', receivedAt: '2026-11-08T00:30:00.000Z', snippet: '', unread: true };
  const mailReader: MailReader = {
    source: 'mail',
    readOnly: true,
    async search() {
      return { messages: [mailSummary], matched: 1, matchedIsLowerBound: false };
    },
    async getMessage(): Promise<MailMessage> {
      return { ...mailSummary, bodyText: opts.body ?? LONG_BODY, bodyTruncated: false };
    },
    async getThread() {
      const bodies = opts.threadBodies ?? [LONG_BODY, LONG_BODY];
      return {
        messages: bodies.map((bodyText, index) => ({ ...mailSummary, id: `msg-${index}`, sender: { name: `보낸이${index}`, address: `p${index}@example.com` }, bodyText, bodyTruncated: false })),
        totalMessages: bodies.length,
      };
    },
  };
  const file = { id: 'file-long', name: '분기 계획 문서', kind: 'document' as const, modifiedAt: '2026-11-08T00:30:00.000Z' };
  const driveReader: DriveReader = {
    source: 'drive',
    readOnly: true,
    async searchByName() {
      return { files: [file], matched: 1, matchedIsLowerBound: false };
    },
    async recentFiles() {
      return { files: [file], matched: 1, matchedIsLowerBound: false };
    },
    async exportText(): Promise<DriveDocument> {
      return {
        ...file,
        ownerName: 'Planner',
        text: opts.driveText ?? LONG_BODY,
        textTruncated: false,
        ...(opts.driveSections !== undefined ? { sections: opts.driveSections } : {}),
      };
    },
  };

  const remote: AiProvider = {
    id: 'fake-remote',
    capabilities: [
      { capability: Capability.SUMMARIZATION, priority: 50 },
      { capability: Capability.GENERAL_CHAT, priority: 50 },
    ],
    executionLocality: 'REMOTE',
    async isAvailable() {
      return true;
    },
    async execute(request: AiRequest) {
      remoteCalls.push(request);
      return { text: request.capability === Capability.SUMMARIZATION ? REMOTE_SUMMARY : '천만에요!', artifacts: [] };
    },
  };
  const local: AiProvider = {
    id: 'fake-long-item',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    executionLocality: 'LOCAL',
    async isAvailable() {
      return opts.local !== 'not-ready';
    },
    async execute(request: AiRequest) {
      localCalls.push(request);
      localStarted();
      if (opts.local === 'blocked') await localGate;
      if (opts.local === 'throws-second' && localCalls.length === 2) throw new Error('local model failed');
      const reduce = request.prompt.includes('[Part ');
      if (reduce && opts.local === 'claim') return { text: '할 일 "송금하기"를 추가했어요.' };
      return { text: reduce ? LOCAL_SUMMARY : LOCAL_NOTE };
    },
  };

  const shortTerm: MemoryRecord[] = [];
  const contextBuilder = new ContextBuilder(
    {
      async recentShortTerm(scope: { sessionId?: string }, limit: number) {
        return shortTerm.filter((r) => r.scope.sessionId === scope.sessionId).slice(-limit);
      },
      async projectMemory() {
        return undefined;
      },
    } as unknown as MemoryManager,
    {},
    { async retrieve() { return []; } } as unknown as MemoryRetriever,
  );
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, ...(fields !== undefined ? { fields } : {}) }),
    warn: (message, fields) => logs.push({ level: 'warn', message, ...(fields !== undefined ? { fields } : {}) }),
    error: (message, fields) => logs.push({ level: 'error', message, ...(fields !== undefined ? { fields } : {}) }),
  };
  const longItems = opts.longItems ?? (opts.mode !== undefined && opts.mode !== 'absent' && opts.mode !== 'off');
  const handlers: ConversationTurnHandler[] = [
    createMailTurnHandler({ reader: mailReader, timeZone: 'Asia/Seoul', logger, ...(longItems ? { longItems: true } : {}) }),
    createDriveTurnHandler({ reader: driveReader, timeZone: 'Asia/Seoul', logger, ...(longItems ? { longItems: true } : {}) }),
    ...(opts.extraHandler !== undefined ? [opts.extraHandler] : []),
  ];
  const bad = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  let taskSeq = 0;
  const deps: ConversationRuntimeDeps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: sessionManager,
    memory: {
      async recordShortTerm(message: InboundMessage, sessionId?: string) {
        const n = shortTerm.length + 1;
        shortTerm.push({ id: `mem-${n}`, type: MemoryType.SHORT_TERM, scope: sessionId ? { sessionId } : {}, content: message.text, metadata: { role: 'user' }, createdAt: T0, updatedAt: T0 });
        return { id: `mem-${n}` };
      },
      async recordAssistant(text: string) {
        recordAssistant.push(text);
        return undefined;
      },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('createCandidate'), promote: bad('promote'), forget: bad('forget') } as unknown as MemoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' };
      },
    },
    projects: { register: bad('projects.register'), get: async () => null } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      async createTask(intent, context, anchor) {
        return { id: `task-${++taskSeq}`, title: intent.summary, description: anchor.requestText, status: TaskStatus.PENDING, intent, riskLevel: RiskLevel.LOW, context, actorId: anchor.actorId, sessionId: anchor.sessionId, createdAt: T0, updatedAt: T0 } as Task;
      },
      async transition(task, to) { return { ...task, status: to }; },
      async startRun(task, capability) { return { id: `run-${task.id}`, taskId: task.id, capability } as TaskRun; },
      async completeRun() { return undefined; },
      async failRun() { return undefined; },
    },
    workspace: { prepare: async () => undefined, open: bad('workspace.open'), list: bad('list'), diff: bad('diff'), read: bad('read') },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: (task, exclude) => contextBuilder.build(task, exclude) },
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router: {
      // The composition root's policy: the long-item key only under `requiredLocality`, never otherwise.
      async select(_capability, context) {
        if (context?.requiredLocality === 'LOCAL') {
          if (!(await local.isAvailable())) throw new Error('no local provider ready');
          return local;
        }
        return remote;
      },
      isStillEligible: (_capability, context, provider) => (context.requiredLocality === 'LOCAL' ? provider === local : provider !== local),
    },
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: { decide: bad('approvals.decide'), get: bad('approvals.get'), requestForRisk: bad('approvals.requestForRisk') } as unknown as ConversationRuntimeDeps['approvals'],
    approvalFlow: new StatelessApprovalFlow(storage as never),
    scopeClarificationFlow: { findPending: async () => null, anchor: bad('scope.anchor'), clear: async () => undefined },
    applyPreviewFlow: { findAnchor: async () => null, anchor: bad('applyPreview.anchor'), clear: async () => undefined },
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('getProposal') },
    patch: { generate: bad('patch.generate'), get: bad('patch.get') },
    codeProposals: { get: bad('codeProposals.get') },
    workspaceWrite: { apply: bad('workspaceWrite.apply') },
    git: {
      status: bad('git.status'),
      diff: bad('git.diff'),
      commitFiles: bad('git.commitFiles'),
      info: bad('git.info'),
      pushApprovedCommit: bad('git.pushApprovedCommit'),
      syncMain: bad('git.syncMain'),
      deleteMergedLocalBranch: bad('git.deleteMergedLocalBranch'),
    },
    turnHandlers: handlers,
    logger,
  };

  const exclusiveCalls = { count: 0 };
  const longItemSummary: LongItemSummaryOptions | undefined =
    opts.mode === undefined || opts.mode === 'absent'
      ? undefined
      : {
          mode: opts.mode,
          exclusive: async (work) => {
            exclusiveCalls.count += 1;
            return work();
          },
          notify: async (message) => {
            notices.push(message);
          },
          now: () => 0,
          // The fake clock: S3's bounds never fire on their own; the 8 s notice timer fires when the test says so.
          wait: (ms, signal) =>
            new Promise<void>((resolve) => {
              timers.push({ ms, fire: resolve });
              signal.addEventListener('abort', () => resolve(), { once: true });
            }),
        };
  const runtime = new ConversationRuntime(deps, { clock: () => T0, ...(longItemSummary !== undefined ? { longItemSummary } : {}) });
  let seq = 0;
  const send = (text: string, context: ConversationContext = DM) => runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0 } satisfies InboundMessage);
  const fireNoticeTimer = () => {
    for (const timer of timers) if (timer.ms === 8_000) timer.fire();
  };
  return { send, remoteCalls, localCalls, recordAssistant, logs, notices, timers, fireNoticeTimer, releaseLocal, localStartedPromise, exclusiveCalls };
}

type Scenario = { readonly name: string; readonly list: string; readonly ask: string; readonly opts?: HarnessOptions };
const SHEETS: DriveDocumentSection[] = [0, 1, 2].map((index) => ({
  title: `시트${index}`,
  text: ['항목,금액,메모', ...Array.from({ length: 60 }, (_, row) => `항목${index}-${row},${row * 10},${CANARY} 메모 ${row} plain words for a row`)].join('\n'),
}));
const SCENARIOS: readonly Scenario[] = [
  { name: 'mail', list: '안 읽은 메일', ask: '1번 메일 요약해줘' },
  { name: 'thread', list: '안 읽은 메일', ask: '1번 메일 스레드 요약해줘' },
  { name: 'drive document', list: '최근 문서', ask: '1번 문서 요약해줘' },
  { name: 'drive sheets', list: '최근 문서', ask: '1번 문서 요약해줘', opts: { driveSections: SHEETS } },
];

async function run(scenario: Scenario, opts: HarnessOptions) {
  const h = harness({ ...scenario.opts, ...opts });
  await h.send(scenario.list);
  const result = await h.send(scenario.ask);
  return { h, result };
}

describe('ADR-0124 Part L C5a-2: off and shadow keep every reply byte-identical', () => {
  it.each(SCENARIOS)('$name: off (handlers attaching the item, runtime off) is today, byte for byte', async (scenario) => {
    const today = await run(scenario, { mode: 'absent', longItems: false });
    const off = await run(scenario, { mode: 'off', longItems: true });
    expect(view(off.result)).toEqual(view(today.result));
    expect(off.h.remoteCalls.map((request) => request.prompt)).toEqual(today.h.remoteCalls.map((request) => request.prompt));
    expect(off.h.recordAssistant).toEqual(today.h.recordAssistant);
    expect(today.result.reply.text).toContain(REMOTE_SUMMARY);
    expect(off.h.localCalls).toEqual([]);
    expect(off.h.logs.some((line) => line.message.startsWith('item_summary'))).toBe(false);
  });

  it.each(SCENARIOS)('$name: shadow replies as today and logs counts only', async (scenario) => {
    const today = await run(scenario, { mode: 'absent', longItems: false });
    const shadow = await run(scenario, { mode: 'shadow' });
    expect(view(shadow.result)).toEqual(view(today.result));
    expect(shadow.h.remoteCalls.map((request) => request.prompt)).toEqual(today.h.remoteCalls.map((request) => request.prompt));
    expect(shadow.h.recordAssistant).toEqual(today.h.recordAssistant);
    expect(shadow.h.localCalls).toEqual([]);
    expect(shadow.h.exclusiveCalls.count).toBe(0);
    const line = shadow.h.logs.find((entry) => entry.message === 'item_summary.s3');
    expect(line?.fields).toMatchObject({ mode: 'shadow', outcome: 'shadow' });
    for (const [key, value] of Object.entries(line?.fields ?? {})) {
      if (!['mode', 'outcome', 'source'].includes(key)) expect(typeof value === 'number' || typeof value === 'boolean', key).toBe(true);
    }
    expect((line?.fields?.windows as number) > 1).toBe(true);
    expect(JSON.stringify(shadow.h.logs)).not.toContain(CANARY);
    expect(shadow.h.notices).toEqual([]);
  });
});

describe('ADR-0124 Part L C5a-2: on', () => {
  it.each(SCENARIOS)('$name: the local summary, Core coverage line and the local footer; no remote call; fixed history', async (scenario) => {
    const { h, result } = await run(scenario, { mode: 'on', local: 'ok' });
    expect(h.remoteCalls).toEqual([]);
    expect(h.localCalls.length).toBeGreaterThan(2);
    expect(h.exclusiveCalls.count).toBe(h.localCalls.length);
    const text = result.reply.text;
    expect(text.startsWith(LOCAL_SUMMARY)).toBe(true);
    expect(text).toMatch(COVERAGE);
    expect(text).toContain('이 기기 로컬 모델로 나눠 요약했어요');
    expect(text).not.toContain('대화 모델에 보내 요약했어요');
    const source = scenario.name === 'mail' ? 'mail' : scenario.name === 'thread' ? 'mail-thread' : 'drive';
    expect(h.recordAssistant.at(-1)).toBe(renderUntrustedDocumentHistoryNote(source, 'ko'));
    // Canary: never in a log line or in the history.
    expect(JSON.stringify(h.logs)).not.toContain(CANARY);
    expect(h.recordAssistant.join('\n')).not.toContain(CANARY);
    expect(h.recordAssistant.join('\n')).not.toContain(LOCAL_SUMMARY);
    const line = h.logs.find((entry) => entry.message === 'item_summary.s3');
    expect(line?.fields).toMatchObject({ mode: 'on', outcome: 'summary' });
  });

  it('the exact reply for one mail: body, blank line, coverage line, local footer', async () => {
    const { h, result } = await run(SCENARIOS[0] as Scenario, { mode: 'on', local: 'ok' });
    const lines = result.reply.text.split('\n');
    expect(lines[0]).toBe(LOCAL_SUMMARY);
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(COVERAGE);
    expect(lines[3]).toBe(renderMailSummaryLocalFooter('ko'));
    expect(h.notices).toEqual([]);
  });

  it('thread: the local thread footer and `[메시지 i/n]` frames in the map prompts, repeated quotes removed', async () => {
    const quoted = LONG_BODY.split('\n').map((line) => `> ${line}`).join('\n');
    const { h, result } = await run(SCENARIOS[1] as Scenario, { mode: 'on', local: 'ok', threadBodies: [LONG_BODY, `새 답장이에요 ${CANARY}.\n\n${quoted}`] });
    expect(result.reply.text).toContain(renderMailThreadSummaryLocalFooter(2, 2, 'ko'));
    const maps = h.localCalls.filter((request) => !request.prompt.includes('[Part '));
    expect(maps.some((request) => request.prompt.includes('[메시지 1/2]'))).toBe(true);
    // The quoted copy of message 1 is not read twice: no window carries a quote marker line.
    expect(maps.every((request) => !/\\n> 문단/u.test(request.prompt))).toBe(true);
  });

  it('drive sheets: `[Sheet i/n]` table sections and the local Drive footer', async () => {
    const { h, result } = await run(SCENARIOS[3] as Scenario, { mode: 'on', local: 'ok' });
    expect(result.reply.text).toContain(renderDriveSummaryLocalFooter('ko'));
    expect(h.localCalls.some((request) => request.prompt.includes('[Sheet 1/3]'))).toBe(true);
  });

  it('partial: a local failure after the first call is a partial reply from the notes read, never remote', async () => {
    const { h, result } = await run(SCENARIOS[0] as Scenario, { mode: 'on', local: 'throws-second' });
    expect(h.remoteCalls).toEqual([]);
    expect(h.localCalls).toHaveLength(2);
    expect(result.reply.text).toContain('긴 문서를 끝까지 요약하지 못해');
    expect(result.reply.text).toContain(LOCAL_NOTE.slice(2));
    expect(result.reply.text).toMatch(/전체 \d+개 구간 중 \d+개를 읽고 답했어요/u);
    expect(result.reply.text).toContain(renderMailSummaryLocalFooter('ko'));
    expect(h.recordAssistant.at(-1)).toBe(renderUntrustedDocumentHistoryNote('mail', 'ko'));
    expect(h.logs.find((entry) => entry.message === 'item_summary.s3')?.fields).toMatchObject({ outcome: 'partial', reason: 'model' });
  });

  it('no ready local model: today\'s path (no local call was made)', async () => {
    const today = await run(SCENARIOS[0] as Scenario, { mode: 'absent', longItems: false });
    const { h, result } = await run(SCENARIOS[0] as Scenario, { mode: 'on', local: 'not-ready' });
    expect(h.localCalls).toEqual([]);
    expect(view(result)).toEqual(view(today.result));
  });

  it('a short item (one window, S1) keeps today\'s remote path byte for byte', async () => {
    const today = await run(SCENARIOS[0] as Scenario, { mode: 'absent', longItems: false, body: SHORT_BODY });
    const { h, result } = await run(SCENARIOS[0] as Scenario, { mode: 'on', local: 'ok', body: SHORT_BODY });
    expect(h.localCalls).toEqual([]);
    expect(view(result)).toEqual(view(today.result));
    expect(h.logs.find((entry) => entry.message === 'item_summary.s3')?.fields).toMatchObject({ outcome: 'S1' });
  });

  it('a credential in the middle of the item: today\'s refusal, no call anywhere', async () => {
    const middle = LONG_BODY.split('\n\n');
    middle.splice(6, 0, `token: ${SECRET}`);
    const { h, result } = await run(SCENARIOS[0] as Scenario, { mode: 'on', local: 'ok', body: middle.join('\n\n') });
    expect(result.reply.text).toBe(renderMailSummaryRefused('CREDENTIAL_SHAPED', 'ko'));
    expect([h.localCalls.length, h.remoteCalls.length]).toEqual([0, 0]);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it('a local summary steered into an action claim is replaced by today\'s fixed notice (no regeneration, no remote)', async () => {
    const { h, result } = await run(SCENARIOS[0] as Scenario, { mode: 'on', local: 'claim' });
    expect(result.reply.text).not.toContain('추가했어요');
    expect(result.reply.text).toContain('이 답변으로 실행된 작업은 없어요');
    expect(result.reply.text).toContain(renderMailSummaryLocalFooter('ko'));
    expect(h.remoteCalls).toEqual([]);
    expect(h.localCalls.filter((request) => request.prompt.includes('[Part '))).toHaveLength(1);
  });
});

/** A handler that answers any message with a long-item summarize outcome (to test the notice in a DM and in a channel). */
function longItemHandler(): ConversationTurnHandler {
  return {
    id: 'test-long-item',
    stage: 'pre-classify',
    order: 1,
    async handle(ctx) {
      if (ctx.message.text !== '긴 문서 요약') return null;
      const long: LongItemSummaryInput = {
        source: 'drive',
        title: '긴 문서',
        author: 'Planner',
        date: T0,
        prepared: preparedLongItemBody(LONG_BODY),
        sourceTruncated: false,
        footer: renderDriveSummaryLocalFooter('ko'),
        refused: { reply: { context: ctx.message.context, text: 'refused' }, status: 'RESPONDED' },
      };
      return {
        kind: 'summarize',
        readout: { kind: 'untrusted-document', source: 'drive', title: '긴 문서', author: 'Planner', date: T0, body: '짧은 미리보기', truncated: true },
        fallbackText: 'fallback',
        footer: 'remote footer',
        longItem: long,
      };
    },
  };
}

describe('ADR-0124 Part L C5a-2: clause PN (fake clock)', () => {
  it('a run still going at 8 s sends ONE fixed notice in a DM, before the reply, with no history entry', async () => {
    const h = harness({ mode: 'on', local: 'blocked', extraHandler: longItemHandler() });
    const pending = h.send('긴 문서 요약');
    await h.localStartedPromise;
    expect(h.notices).toEqual([]);
    h.fireNoticeTimer();
    h.fireNoticeTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.notices).toHaveLength(1);
    const windows = h.logs.find((entry) => entry.message === 'item_summary.s3.progress_notice')?.fields?.windows as number;
    expect(h.notices[0]?.text).toBe(renderLongItemProgressNotice(windows, 'ko'));
    expect(h.notices[0]?.context).toEqual(DM);
    h.releaseLocal();
    const result = await pending;
    expect(result.reply.text.startsWith(LOCAL_SUMMARY)).toBe(true);
    expect(h.notices).toHaveLength(1);
    expect(h.recordAssistant.some((entry) => entry.includes('나눠 읽고 있어요'))).toBe(false);
    expect(h.remoteCalls).toEqual([]);
  });

  it('no notice before 8 s (the run finished first), and none in a group channel', async () => {
    const fast = harness({ mode: 'on', local: 'ok', extraHandler: longItemHandler() });
    await fast.send('긴 문서 요약');
    fast.fireNoticeTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fast.notices).toEqual([]);

    const channel = harness({ mode: 'on', local: 'blocked', extraHandler: longItemHandler() });
    const pending = channel.send('긴 문서 요약', CHANNEL);
    await channel.localStartedPromise;
    channel.fireNoticeTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    channel.releaseLocal();
    await pending;
    expect(channel.notices).toEqual([]);
    expect(channel.timers.some((timer) => timer.ms === 8_000)).toBe(false);
  });

  it('the S3 bounds come from the injected timer only: no other timeout cuts the run or falls back to remote', async () => {
    const h = harness({ mode: 'on', local: 'blocked', extraHandler: longItemHandler() });
    const pending = h.send('긴 문서 요약');
    await h.localStartedPromise;
    // The per-call bound (20 s) and the wall (90 s) are armed through the injected `wait`; firing the per-call bound ends
    // the run as a partial reply on the spot, with no remote call.
    for (const timer of h.timers) if (timer.ms === 20_000) timer.fire();
    const result = await pending;
    h.releaseLocal();
    expect(result.reply.text).toContain('긴 문서를 이 기기에서 요약하지 못했어요');
    expect(h.remoteCalls).toEqual([]);
  });
});
