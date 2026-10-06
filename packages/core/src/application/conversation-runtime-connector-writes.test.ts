import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStatus, Capability, IntentType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type {
  Actor,
  ApprovalRequest,
  ConversationContext,
  InboundMessage,
  Intent,
  Session,
  Task,
  TaskRun,
  WorkItem,
} from '../domain';
import {
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  type CalendarEvent,
  type CalendarEventCreateRequest,
  type CalendarEventDeleteRequest,
  type CalendarEventUpdateRequest,
  type CalendarEventWriter,
  type CalendarReader,
  type ChannelMessageRequest,
  type ChannelMessageWriter,
  type ConnectorWriteMatch,
  type ConnectorWriteOutcome,
  type ConnectorWritePrepareResult,
  type ConnectorWriteReceipt,
  type ConnectorWriteReceiptRepository,
  type IssueCommentRequest,
  type IssueCommentWriter,
  type IssueTransitionOption,
  type IssueTransitionRequest,
  type IssueTransitionWriter,
  type Logger,
  type StorageProvider,
} from '../ports';
import { ApprovalManager } from './approval-manager';
import type { ApprovalPolicy } from './approval-policy';
import { createCalendarTurnHandler } from './calendar/calendar-turn-handler';
import { CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE } from './connector-writes/connector-write-copy';
import { StatelessConnectorWriteFlow, type ConnectorWriteWriters } from './connector-writes/connector-write-flow';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import type { MemoryWriter } from './memory-writer';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { MAX_CONTRIBUTED_HELP_LINES, ResponseComposer } from './response-composer';
import { SessionManager } from './session-manager';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { WorkManager } from './work-manager';
import { WorkChatService } from './work-chat/work-chat-service';
import { createWorkChatTurnHandlers } from './work-chat/work-chat-turn-handler';

// CWR-2 (ADR-0112 D5/D6, ADR-0110 amendment D3–D5): the connector-write chat approval flow end to end on a real
// ConversationRuntime with the real work-chat and calendar handlers, the real StatelessConnectorWriteFlow, the real
// ApprovalManager and ResponseComposer. Only storage, receipts, writers and the calendar reader are in-memory fakes; no
// network of any kind.

const CTX: ConversationContext = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
/** Tuesday 2026-10-06 10:00 Asia/Seoul. */
const T0 = '2026-10-06T01:00:00.000Z';
const SEOUL = 'Asia/Seoul';
const COMMENT_URL = 'https://example.atlassian.net/browse/PROJ-12?focusedCommentId=10001';
const WRITES_OFF = 'Jira에 만들기·수정·댓글·전송 같은 쓰기 작업은 아직 할 수 없어요.';
const CALENDAR_READ_ONLY = '지금은 캘린더를 읽기만 할 수 있어요. 일정 추가·변경·삭제는 아직 지원하지 않아서 아무것도 바꾸지 않았어요.';

const bad = (name: string) => () => {
  throw new Error(`${name} must not be called`);
};

/** Tomorrow (2026-10-07) events on the primary calendar. 15:00 KST = 06:00Z. */
const WEEKLY: CalendarEvent = {
  id: 'evt-weekly',
  title: '주간 회의',
  start: '2026-10-07T06:00:00.000Z',
  end: '2026-10-07T07:00:00.000Z',
  allDay: false,
  location: '3층',
  status: 'confirmed',
  calendarName: 'primary',
};
const ONE_ON_ONE: CalendarEvent = { ...WEEKLY, id: 'evt-1on1', title: '1:1 면담', location: undefined } as CalendarEvent;
const LUNCH: CalendarEvent = { ...WEEKLY, id: 'evt-lunch', title: '점심', start: '2026-10-07T03:00:00.000Z', end: '2026-10-07T04:00:00.000Z' };

class MemoryReceipts implements ConnectorWriteReceiptRepository {
  readonly rows = new Map<string, ConnectorWriteReceipt>();
  reconciled = 0;
  async prepare(receipt: ConnectorWriteReceipt): Promise<ConnectorWritePrepareResult> {
    const existing = [...this.rows.values()].find((row) => row.idempotencyKey === receipt.idempotencyKey);
    if (existing) return { created: false, receipt: existing };
    this.rows.set(receipt.id, { ...receipt });
    return { created: true, receipt };
  }
  async complete(id: string, outcome: ConnectorWriteOutcome, now: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'PREPARED') return null;
    const data =
      outcome.status === 'SENT'
        ? { externalRef: outcome.externalRef, ...(outcome.url ? { url: outcome.url } : {}) }
        : { reason: outcome.reason };
    const next = { ...row, status: outcome.status, updatedAt: now, data };
    this.rows.set(id, next);
    return next;
  }
  async findByIdempotencyKey(key: string): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].find((row) => row.idempotencyKey === key) ?? null;
  }
  async findLatestSent(match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    return (
      [...this.rows.values()]
        .filter(
          (row) =>
            row.status === 'SENT' &&
            row.actorId === match.actorId &&
            row.connector === match.connector &&
            row.operation === match.operation &&
            row.target === match.target &&
            row.payloadSha256 === match.payloadSha256,
        )
        .pop() ?? null
    );
  }
  async markInterruptedPreparedUncertain(): Promise<number> {
    this.reconciled++;
    return 0;
  }
}

interface HarnessOptions {
  /** No flow at all (writes off). */
  noFlow?: boolean;
  /** Which writers the flow has (default: all). */
  writers?: Array<'comment' | 'transition' | 'post' | 'calendar'>;
  commentOutcome?: () => Promise<ConnectorWriteOutcome>;
  transitions?: IssueTransitionOption[];
  events?: CalendarEvent[];
  calendarReadFails?: boolean;
  /** A pre-existing session pointer (e.g. an open code-change anchor) the write must restore. */
  priorActiveTaskId?: string;
  /** The comment writer's receipt label (an invalid one makes the executor refuse the request). */
  commentSource?: string;
  /** Which receipt step throws (storage failure). */
  receiptFails?: 'prepare' | 'complete';
}

function harness(opts: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const approvals = new Map<string, ApprovalRequest>();
  const tasks = new Map<string, Task>();
  const workItems = new Map<string, WorkItem>();
  const recorded: string[] = [];
  const classify = { count: 0 };
  const writes = {
    addComment: [] as IssueCommentRequest[],
    listTransitions: [] as string[],
    transition: [] as IssueTransitionRequest[],
    post: [] as ChannelMessageRequest[],
    createEvent: [] as CalendarEventCreateRequest[],
    updateEvent: [] as CalendarEventUpdateRequest[],
    deleteEvent: [] as CalendarEventDeleteRequest[],
    listEvents: 0,
  };
  const storage = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, { ...s });
        return s;
      },
      async get(id: string) {
        return sessions.get(id) ?? null;
      },
      async findActiveByContext(channelId: string) {
        return [...sessions.values()].find((s) => s.status === SessionStatus.ACTIVE && s.context.channelId === channelId) ?? null;
      },
    },
    approvals: {
      async save(a: ApprovalRequest) {
        approvals.set(a.id, { ...a });
        return a;
      },
      async get(id: string) {
        return approvals.get(id) ?? null;
      },
      async findByExecutionPlan(planId: string) {
        return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId);
      },
    },
    tasks: {
      async get(id: string) {
        return tasks.get(id) ?? null;
      },
      async save(t: Task) {
        tasks.set(t.id, structuredClone(t));
        return t;
      },
    },
    workItems: {
      async get(id: string) {
        return workItems.get(id) ?? null;
      },
      async save(item: WorkItem) {
        workItems.set(item.id, item);
        return item;
      },
      async delete() {
        throw new Error('never');
      },
      async list() {
        return [...workItems.values()];
      },
      async listByActor() {
        return [];
      },
      async listByResource() {
        return [];
      },
    },
  };
  const seeded: Session = {
    id: 'sess-1',
    actorId: OWNER.id,
    context: CTX,
    status: SessionStatus.ACTIVE,
    createdAt: T0,
    lastActivityAt: T0,
    ...(opts.priorActiveTaskId ? { activeTaskId: opts.priorActiveTaskId } : {}),
  };
  sessions.set(seeded.id, seeded);
  if (opts.priorActiveTaskId) {
    tasks.set(opts.priorActiveTaskId, {
      id: opts.priorActiveTaskId,
      title: 'unrelated anchor',
      description: 'x',
      status: TaskStatus.PENDING,
      intent: { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'x' },
      riskLevel: RiskLevel.LOW,
      context: CTX,
      createdAt: T0,
      updatedAt: T0,
      metadata: { someOtherAnchor: { kind: 'other' } },
    });
  }

  const approvalManager = new ApprovalManager(storage as unknown as StorageProvider, {} as ApprovalPolicy);
  const receipts = new MemoryReceipts();
  if (opts.receiptFails === 'prepare') receipts.prepare = async () => { throw new Error('disk full'); };
  if (opts.receiptFails === 'complete') receipts.complete = async () => { throw new Error('disk full'); };
  let actor: Actor = OWNER;
  /** `session.activeTaskId` as each turn's apply-preview lookup saw it. */
  const applyLookups: Array<string | undefined> = [];
  const enabled = new Set(opts.writers ?? ['comment', 'transition', 'post', 'calendar']);
  const issueComments: IssueCommentWriter = {
    source: opts.commentSource ?? 'jira',
    allowsIssue: (key) => /^PROJ-\d+$/.test(key),
    async addComment(request) {
      writes.addComment.push(request);
      return opts.commentOutcome ? opts.commentOutcome() : connectorWriteSent('10001', COMMENT_URL);
    },
  };
  const issueTransitions: IssueTransitionWriter = {
    source: 'jira',
    allowsIssue: (key) => /^PROJ-\d+$/.test(key),
    async listTransitions(key) {
      writes.listTransitions.push(key);
      return opts.transitions ?? [
        { id: '21', name: 'Start Progress', toStatus: '진행 중' },
        { id: '31', name: 'Done', toStatus: '완료' },
      ];
    },
    async transition(request) {
      writes.transition.push(request);
      return connectorWriteSent(`${request.issueKey}:${request.toStatus}`);
    },
  };
  const channelMessages: ChannelMessageWriter = {
    source: 'slack',
    resolveChannel: (channel) => {
      const name = channel.startsWith('#') ? channel.slice(1) : channel;
      return name === 'dev' || name === 'C0DEV' ? 'C0DEV' : undefined;
    },
    async post(request) {
      writes.post.push(request);
      return connectorWriteSent('1700000000.000100');
    },
  };
  const calendarEvents: CalendarEventWriter = {
    source: 'calendar',
    target: 'primary',
    async createEvent(request) {
      writes.createEvent.push(request);
      return connectorWriteSent('evt-new');
    },
    async updateEvent(request) {
      writes.updateEvent.push(request);
      return connectorWriteSent(request.eventId);
    },
    async deleteEvent(request) {
      writes.deleteEvent.push(request);
      return connectorWriteSent(request.eventId);
    },
  };
  const calendarReader: CalendarReader = {
    source: 'calendar',
    readOnly: true,
    async listEvents() {
      writes.listEvents++;
      if (opts.calendarReadFails) throw new Error('down');
      return opts.events ?? [WEEKLY, LUNCH];
    },
  };
  const writers: ConnectorWriteWriters = {
    ...(enabled.has('comment') ? { issueComments } : {}),
    ...(enabled.has('transition') ? { issueTransitions } : {}),
    ...(enabled.has('post') ? { channelMessages } : {}),
    ...(enabled.has('calendar') ? { calendarEvents } : {}),
  };
  let idSeq = 0;
  const flow = opts.noFlow
    ? undefined
    : new StatelessConnectorWriteFlow({
        writers,
        calendarReader,
        receipts,
        approvals: approvalManager,
        store: storage,
        timeZone: SEOUL,
        newId: () => `id-${String(++idSeq).padStart(4, '0')}-cwr`,
      });

  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const surface = { status: 'COMPLETE' as const, items: [], sources: [] };
  const desk = new WorkChatService(
    { workSurface: { forActor: async () => surface }, connectors: { list: () => [] }, work: new WorkManager(storage as unknown as StorageProvider) },
    { summaryEnabled: false },
  );
  const turnHandlers = [
    ...createWorkChatTurnHandlers({ desk, summaryEnabled: false, logger }),
    createCalendarTurnHandler({ reader: calendarReader, timeZone: SEOUL, writesEnabled: enabled.has('calendar') && !opts.noFlow }),
  ];

  const deps: ConversationRuntimeDeps = {
    dispatchCommit: { async commit() { return {} as TaskRun; } } as unknown as ConversationRuntimeDeps['dispatchCommit'],
    actors: { async resolveFromContext() { return actor; } },
    sessions: new SessionManager(storage as unknown as StorageProvider),
    memory: {
      async recordShortTerm() { return { id: 'mem-user' }; },
      async recordAssistant(text: string) {
        recorded.push(text);
        return undefined;
      },
      async recordToolMemory() { return undefined; },
    },
    memoryWriter: { createCandidate: bad('memoryWriter'), promote: bad('memoryWriter') } as unknown as MemoryWriter,
    classifier: {
      async classify(): Promise<Intent> {
        classify.count++;
        return { type: IntentType.CHAT, capability: Capability.GENERAL_CHAT, confidence: 1, requiresWork: false, summary: 'chat' };
      },
    },
    projects: { register: bad('projects.register'), get: async () => null } as unknown as ConversationRuntimeDeps['projects'],
    analyzer: { prepare: bad('analyzer.prepare') },
    tasks: {
      createTask: bad('tasks.createTask'),
      transition: bad('tasks.transition'),
      startRun: bad('tasks.startRun'),
      completeRun: bad('tasks.completeRun'),
      failRun: bad('tasks.failRun'),
    } as unknown as ConversationRuntimeDeps['tasks'],
    workspace: { prepare: async () => undefined, open: bad('workspace.open'), list: bad('l'), diff: bad('d'), read: bad('r') },
    commandExecutions: { get: bad('commandExecutions.get') },
    command: { run: bad('command.run') },
    contextBuilder: { build: bad('contextBuilder.build') },
    promptComposer: new PromptComposer(),
    promptRenderer: new PromptRenderer(),
    router: { select: bad('router.select') },
    artifacts: { async persistAll() { return []; } },
    composer: new ResponseComposer(),
    workSurface: { forActor: bad('workSurface.forActor') },
    intentResolver: new IntentResolver(),
    orchestrator: { run: bad('orchestrator.run'), resume: bad('orchestrator.resume') },
    approvals: {
      decide: (id, d) => approvalManager.decide(id, d),
      get: (id) => approvalManager.get(id),
      requestForRisk: bad('runtime approvals.requestForRisk'),
    },
    approvalFlow: new StatelessApprovalFlow(storage),
    scopeClarificationFlow: { findPending: async () => null, anchor: bad('scope.anchor'), clear: async () => undefined },
    applyPreviewFlow: {
      findAnchor: async (s: Session) => {
        applyLookups.push(s.activeTaskId);
        return null;
      },
      anchor: bad('applyPreview.anchor'),
      clear: async () => undefined,
    },
    codeGeneration: { generate: bad('codeGeneration.generate'), getProposal: bad('codeGeneration.getProposal') },
    patch: { generate: bad('patch.generate'), get: bad('patch.get') },
    codeProposals: { get: bad('codeProposals.get') },
    workspaceWrite: { apply: bad('workspaceWrite.apply') },
    git: {
      status: bad('git'), diff: bad('git'), commitFiles: bad('git'), info: bad('git'), pushApprovedCommit: bad('git'),
      syncMain: bad('git'), deleteMergedLocalBranch: bad('git'),
    },
    turnHandlers,
    credentialOverrideFlow: undefined,
    connectorWriteFlow: flow,
    logger,
  };
  const runtime = new ConversationRuntime(deps, { clock: () => new Date().toISOString() });
  let seq = 0;
  const send = (text: string) => runtime.handle({ id: `msg-${++seq}`, context: CTX, text, receivedAt: T0 } satisfies InboundMessage);
  const totalWrites = () =>
    writes.addComment.length + writes.transition.length + writes.post.length + writes.createEvent.length +
    writes.updateEvent.length + writes.deleteEvent.length;
  const anchorTask = () => {
    const pointer = sessions.get('sess-1')?.activeTaskId;
    return pointer ? tasks.get(pointer) : undefined;
  };
  const setActor = (next: Actor) => {
    actor = next;
  };
  return {
    send, writes, totalWrites, receipts, approvals, tasks, sessions, recorded, classify, runtime, flow, anchorTask, setActor,
    applyLookups,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
});
afterEach(() => {
  vi.useRealTimers();
});

const advanceMinutes = (minutes: number) => vi.setSystemTime(new Date(Date.now() + minutes * 60_000));

describe('connector writes — Jira comment (ADR-0112 D5/D6)', () => {
  it('previews the exact payload, binds a CRITICAL approval to its hash, and sends once only on the exact phrase', async () => {
    const h = harness();
    const preview = await h.send('PROJ-12에 댓글 달아줘: 배포 **완료**했습니다 @here');
    expect(preview.status).toBe('AWAITING_APPROVAL');
    expect(preview.reply.text).toContain('Jira 댓글 미리보기예요. 아직 아무것도 보내지 않았어요.');
    expect(preview.reply.text).toContain('대상: Jira PROJ-12');
    // The owner's text verbatim inside a fence: no markdown or mention expansion.
    expect(preview.reply.text).toContain('```\n배포 **완료**했습니다 @here\n```');
    expect(preview.reply.text).toContain('"댓글 실행"');
    expect(preview.reply.text).toContain('CRITICAL');
    const [approval] = [...h.approvals.values()];
    expect(approval).toMatchObject({ status: ApprovalStatus.PENDING, riskLevel: RiskLevel.CRITICAL });
    expect(approval?.reason).toMatch(/^connector-write: ISSUE_COMMENT target=PROJ-12 sha256=[0-9a-f]{64};/);
    expect(approval?.reason).not.toContain('배포');
    expect(h.totalWrites()).toBe(0);

    // The execution phrase while the approval is pending only re-prompts.
    const early = await h.send('댓글 실행');
    expect(early.status).toBe('AWAITING_APPROVAL');
    expect(early.reply.text).toContain('승인을 기다리고 있어요');
    expect(h.totalWrites()).toBe(0);

    const approved = await h.send('승인');
    expect(approved.reply.text).toContain('승인을 기록했어요. 아직 실행하지 않았어요.');
    expect(approved.reply.text).toContain('"댓글 실행"');
    expect(h.totalWrites()).toBe(0);

    // Not the exact phrase: nothing runs (questions, near-misses, other gates).
    for (const text of ['댓글 실행해도 돼?', '댓글 실행하지 마', '댓글 달아', 'Slack 게시 실행', '실행']) {
      await h.send(text);
      expect(h.totalWrites(), text).toBe(0);
    }
    const bare = await h.send('승인');
    expect(bare.reply.text).toContain('이미 승인됐고 아직 실행하지 않았어요');

    const sent = await h.send('댓글 실행');
    expect(h.writes.addComment).toEqual([{ issueKey: 'PROJ-12', text: '배포 **완료**했습니다 @here' }]);
    expect(sent.reply.text).toContain('Jira 댓글 완료: 댓글을 달았어요.');
    expect(sent.reply.text).toContain(`<${COMMENT_URL}>`);
    const receipts = [...h.receipts.rows.values()];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'SENT', operation: 'ISSUE_COMMENT', target: 'PROJ-12', connector: 'jira' });
    expect(receipts[0]?.idempotencyKey).toBe(`cwr:${approval?.id}`);
    expect(JSON.stringify(receipts)).not.toContain('배포');
    expect(h.receipts.reconciled).toBe(1);

    // A repeated phrase after SENT says it is already done and sends nothing.
    const again = await h.send('댓글 실행');
    expect(again.reply.text).toContain('이미 실행했어요. 다시 실행하지 않았어요.');
    expect(h.writes.addComment).toHaveLength(1);

    // The same request again matches the SENT receipt: "이미 보냈어요", no new approval.
    const repeatRequest = await h.send('PROJ-12에 댓글 달아줘: 배포 **완료**했습니다 @here');
    expect(repeatRequest.reply.text).toContain('이미 보냈어요');
    expect(h.approvals.size).toBe(1);
    expect(h.writes.addComment).toHaveLength(1);
  });

  it('a denial sends nothing and the phrase afterwards says there is nothing approved', async () => {
    const h = harness();
    await h.send('Jira PROJ-3에 댓글: 확인했어요');
    const denied = await h.send('거절');
    expect(denied.status).toBe('DENIED');
    expect(denied.reply.text).toBe('요청을 거절했어요. 아무것도 보내지 않았어요.');
    expect([...h.approvals.values()][0]?.status).toBe(ApprovalStatus.REJECTED);
    const stray = await h.send('댓글 실행');
    expect(stray.reply.text).toContain('지금 실행할 승인된 외부 쓰기 요청이 없어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('refuses a non-allowlisted project, credential text and an empty comment before any network call or approval', async () => {
    const h = harness();
    const other = await h.send('OPS-1에 댓글: hello');
    expect(other.reply.text).toContain('쓰기가 허용된 대상이 아니에요');
    expect(other.reply.text).toContain('아무것도 보내지 않았어요');
    const secret = await h.send(`PROJ-1에 댓글: token=${'ghp_'}${'a'.repeat(36)}`);
    expect(secret.reply.text).toContain('비밀 값처럼 보이는 내용');
    const empty = await h.send('PROJ-1에 댓글 달아줘');
    expect(empty.reply.text).toContain('"KEY-1에 댓글: 내용"');
    expect(h.approvals.size).toBe(0);
    expect(h.totalWrites()).toBe(0);
  });

  it('UNCERTAIN is reported truthfully and never retried; NOT_SENT is reported and needs a new request', async () => {
    const uncertain = harness({ commentOutcome: async () => connectorWriteUncertain('TRANSPORT') });
    await uncertain.send('PROJ-12에 댓글: 한 번만');
    await uncertain.send('승인');
    const reply = await uncertain.send('댓글 실행');
    expect(reply.reply.text).toContain('결과를 확인하지 못했어요');
    expect(reply.reply.text).toContain('게시됐을 수도 있어요');
    expect(reply.reply.text).toContain('자동으로 다시 시도하지 않아요');
    expect(reply.reply.text).not.toMatch(/댓글을 달았어요/);
    const again = await uncertain.send('댓글 실행');
    expect(again.reply.text).toContain('다시 실행하지 않아요');
    expect(uncertain.writes.addComment).toHaveLength(1);

    const thrown = harness({ commentOutcome: async () => { throw new Error('socket hang up'); } });
    await thrown.send('PROJ-12에 댓글: x');
    await thrown.send('승인');
    expect((await thrown.send('댓글 실행')).reply.text).toContain('결과를 확인하지 못했어요');
    expect([...thrown.receipts.rows.values()][0]?.status).toBe('UNCERTAIN');

    const notSent = harness({ commentOutcome: async () => connectorWriteNotSent('FORBIDDEN') });
    await notSent.send('PROJ-12에 댓글: x');
    await notSent.send('승인');
    const failed = await notSent.send('댓글 실행');
    expect(failed.reply.text).toContain('Jira 댓글을(를) 하지 못했어요: 권한이 없어요. 아무것도 보내지 않았어요.');
    expect((await notSent.send('댓글 실행')).reply.text).toContain('이미 실패로 끝났어요');
    expect(notSent.writes.addComment).toHaveLength(1);
  });

  it('expires a pending approval after 30 minutes and an unexecuted grant 30 minutes after approval', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: a');
    advanceMinutes(31);
    const expired = await h.send('승인');
    expect(expired.status).toBe('DENIED');
    expect([...h.approvals.values()][0]).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'expired' });
    expect((await h.send('댓글 실행')).reply.text).toContain('지금 실행할 승인된 외부 쓰기 요청이 없어요');

    const g = harness();
    await g.send('PROJ-12에 댓글: b');
    await g.send('승인');
    advanceMinutes(31);
    const late = await g.send('댓글 실행');
    expect(late.reply.text).toContain('승인이 만료됐어요');
    expect(g.totalWrites()).toBe(0);
  });

  it('refuses a payload changed after approval (hash binding) and never sends', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: original');
    await h.send('승인');
    const task = h.anchorTask() as Task;
    const anchor = task.metadata?.connectorWriteAnchor as { payload: { text: string } };
    anchor.payload.text = 'tampered';
    h.tasks.set(task.id, task);
    const reply = await h.send('댓글 실행');
    expect(reply.reply.text).toContain('승인한 요청과 지금 요청이 일치하는지 확인할 수 없어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('a consumed grant replayed through the flow sends nothing (one receipt per approval)', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: once');
    await h.send('승인');
    const session = h.sessions.get('sess-1') as Session;
    const view = await h.flow!.find(session);
    await h.send('댓글 실행');
    // Replay the stale APPROVED view (as a racing second turn would hold it).
    const replay = await h.flow!.execute({ session, actor: OWNER, view: view!, now: new Date().toISOString() });
    expect(replay.kind).toBe('outcome');
    expect(h.writes.addComment).toHaveLength(1);
  });

  it('restores the session pointer the write displaced', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: x');
    expect(h.sessions.get('sess-1')?.activeTaskId).not.toBe('task-prior');
    await h.send('승인');
    await h.send('댓글 실행');
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
  });

  it('with writes off the handler’s fixed refusal is the reply, and the phrase still runs nothing', async () => {
    const h = harness({ noFlow: true });
    const reply = await h.send('PROJ-12에 댓글 달아줘: hello');
    expect(reply.reply.text).toContain(WRITES_OFF);
    expect((await h.send('댓글 실행')).reply.text).toContain('지금 실행할 승인된 외부 쓰기 요청이 없어요');
    expect(h.classify.count).toBe(0);
    const partial = harness({ writers: ['post'] });
    expect((await partial.send('PROJ-12에 댓글: hello')).reply.text).toContain(WRITES_OFF);
    expect(partial.approvals.size).toBe(0);
  });
});

describe('connector writes — Jira transition and Slack post', () => {
  it('checks the transition against the issue’s available transitions before the preview', async () => {
    const h = harness();
    const preview = await h.send('PROJ-12 진행 중으로 바꿔줘');
    expect(h.writes.listTransitions).toEqual(['PROJ-12']);
    expect(preview.reply.text).toContain('바꿀 상태: 진행 중 (전환: Start Progress)');
    await h.send('승인');
    await h.send('상태 변경 실행');
    expect(h.writes.transition).toEqual([{ issueKey: 'PROJ-12', toStatus: '진행 중' }]);

    const g = harness();
    const unavailable = await g.send('PROJ-12 상태를 리뷰 중으로 변경해줘');
    expect(unavailable.reply.text).toContain('이 이슈는 지금 그 상태로 바꿀 수 없어요');
    expect(unavailable.reply.text).toContain('지금 바꿀 수 있는 상태: 진행 중, 완료');
    expect(g.approvals.size).toBe(0);
    expect(g.totalWrites()).toBe(0);
  });

  it('posts verbatim to an allowlisted channel only', async () => {
    const h = harness();
    const preview = await h.send('#dev에 "오늘 배포는 18시"라고 올려줘');
    expect(preview.reply.text).toContain('대상: Slack #dev (C0DEV)');
    expect(preview.reply.text).toContain('```\n오늘 배포는 18시\n```');
    await h.send('승인');
    const sent = await h.send('Slack 게시 실행');
    expect(h.writes.post).toEqual([{ channel: 'C0DEV', text: '오늘 배포는 18시' }]);
    expect(sent.reply.text).toContain('메시지를 게시했어요');

    const g = harness();
    const refused = await g.send('Slack #random에 게시: hi');
    expect(refused.reply.text).toContain('쓰기가 허용된 대상이 아니에요');
    expect(g.approvals.size).toBe(0);
    expect(g.totalWrites()).toBe(0);
  });
});

describe('connector writes — calendar on the primary calendar (ADR-0110 amendment)', () => {
  it('creates an event from an exact preview with time zone, no attendees and sendUpdates=none', async () => {
    const h = harness();
    const preview = await h.send('내일 오후 3시에 회의 잡아줘 제목 주간 회의 장소 3층 회의실');
    expect(preview.status).toBe('AWAITING_APPROVAL');
    expect(preview.reply.text).toContain('캘린더 일정 추가 미리보기예요. 아직 캘린더를 바꾸지 않았어요.');
    expect(preview.reply.text).toContain('캘린더: 내 기본 캘린더(primary)');
    expect(preview.reply.text).toContain('제목: 주간 회의');
    expect(preview.reply.text).toContain('시간: 2026-10-07(수) 15:00–16:00 (Asia/Seoul)');
    expect(preview.reply.text).toContain('장소: 3층 회의실');
    expect(preview.reply.text).toContain('참석자: 없음');
    expect(preview.reply.text).toContain('sendUpdates=none');
    expect(preview.reply.text).toContain('"일정 추가 실행"');
    // Calendar text never reaches the conversation history.
    expect(h.recorded.at(-1)).toBe(CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE);
    await h.send('승인');
    const done = await h.send('일정 추가 실행');
    const [approval] = [...h.approvals.values()];
    expect(h.writes.createEvent).toEqual([
      {
        draft: {
          title: '주간 회의',
          time: { allDay: false, start: '2026-10-07T06:00:00.000Z', end: '2026-10-07T07:00:00.000Z', timeZone: SEOUL },
          location: '3층 회의실',
        },
        idempotencyKey: `cwr:${approval?.id}`,
      },
    ]);
    expect(done.reply.text).toContain('일정을 추가했어요. 초대 메일은 보내지 않았어요.');
    expect(h.recorded.at(-1)).toBe(CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE);
  });

  it('asks which event when the reference is ambiguous, never guesses, and deletes exactly the chosen one', async () => {
    const h = harness({ events: [WEEKLY, ONE_ON_ONE, LUNCH] });
    const choice = await h.send('내일 3시 회의 취소해줘');
    expect(choice.reply.text).toContain('조건에 맞는 일정이 2개예요');
    expect(choice.reply.text).toContain('1. 2026-10-07(수) 15:00–16:00 (Asia/Seoul) 주간 회의');
    expect(choice.reply.text).toContain('2. 2026-10-07(수) 15:00–16:00 (Asia/Seoul) 1:1 면담');
    expect(h.approvals.size).toBe(0);
    const preview = await h.send('2번');
    expect(preview.reply.text).toContain('삭제할 일정: 1:1 면담');
    await h.send('승인');
    await h.send('일정 삭제 실행');
    expect(h.writes.deleteEvent).toEqual([{ eventId: 'evt-1on1' }]);
    expect(h.writes.updateEvent).toHaveLength(0);
  });

  it('an unrelated message abandons the choice (next turn only); nothing is written', async () => {
    const h = harness({ events: [WEEKLY, ONE_ON_ONE] });
    await h.send('내일 3시 회의 취소해줘');
    await h.send('안녕');
    expect(h.classify.count).toBe(1);
    expect((await h.send('1번')).reply.text).not.toContain('삭제할 일정');
    expect(h.totalWrites()).toBe(0);
  });

  it('moves a single matching event and keeps its duration', async () => {
    const h = harness({ events: [WEEKLY, LUNCH] });
    const preview = await h.send('내일 3시 회의 4시로 옮겨줘');
    expect(preview.reply.text).toContain('바꿀 일정: 주간 회의 · 2026-10-07(수) 15:00–16:00 (Asia/Seoul)');
    expect(preview.reply.text).toContain('- 시간: 2026-10-07(수) 16:00–17:00 (Asia/Seoul)');
    await h.send('승인');
    await h.send('일정 변경 실행');
    expect(h.writes.updateEvent).toEqual([
      {
        eventId: 'evt-weekly',
        changes: { time: { allDay: false, start: '2026-10-07T07:00:00.000Z', end: '2026-10-07T08:00:00.000Z', timeZone: SEOUL } },
      },
    ]);
  });

  it('reports a missing event and a failed read truthfully and writes nothing', async () => {
    const none = harness({ events: [LUNCH] });
    expect((await none.send('내일 3시 회의 취소해줘')).reply.text).toContain('맞는 일정을 기본 캘린더에서 찾지 못했어요');
    const down = harness({ calendarReadFails: true });
    expect((await down.send('내일 3시 회의 취소해줘')).reply.text).toContain('캘린더를 읽지 못해서');
    expect(none.totalWrites() + down.totalWrites()).toBe(0);
    expect(none.approvals.size + down.approvals.size).toBe(0);
  });

  it('with calendar writes off the read-only refusal stays the reply', async () => {
    const h = harness({ writers: ['comment'] });
    expect((await h.send('내일 오후 3시에 회의 잡아줘')).reply.text).toBe(CALENDAR_READ_ONLY);
    expect(h.approvals.size).toBe(0);
  });
});

describe('connector writes — help lines', () => {
  it('the flow contributes its lines after the registry’s, within the raised 14-line bound', async () => {
    const h = harness();
    const lines = (h.runtime as unknown as { contributedHelpLines: readonly string[] }).contributedHelpLines;
    expect(lines.length).toBeLessThanOrEqual(MAX_CONTRIBUTED_HELP_LINES);
    expect(lines.some((line) => line.includes('"댓글 실행"'))).toBe(true);
    expect(lines.some((line) => line.includes('"Slack 게시 실행"'))).toBe(true);
    for (const line of lines) expect(Array.from(line).length, line).toBeLessThanOrEqual(120);
    const help = await h.send('도움말');
    expect(help.reply.text).toContain('Jira 쓰기');
    expect(help.reply.text).not.toContain('…');
  });
});

describe('connector writes — vague calendar references', () => {
  it('a reference with neither a time nor a title is confirmed by number even with a single match', async () => {
    const h = harness({ events: [LUNCH] });
    const choice = await h.send('내일 회의 삭제해줘');
    expect(choice.reply.text).toContain('조건에 맞는 일정이 1개예요');
    expect(h.approvals.size).toBe(0);
    expect((await h.send('1번')).reply.text).toContain('삭제할 일정: 점심');
    expect(h.totalWrites()).toBe(0);
  });
});

describe('connector writes — supersession and outside decisions', () => {
  it('a new request supersedes an approved, unexecuted grant: only the new payload can ever run', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: first');
    await h.send('승인');
    const firstTask = h.anchorTask() as Task;
    await h.send('PROJ-12에 댓글: second');
    expect((h.tasks.get(firstTask.id)?.metadata?.connectorWriteAnchor as { status: string }).status).toBe('CLOSED');
    await h.send('승인');
    await h.send('댓글 실행');
    expect(h.writes.addComment).toEqual([{ issueKey: 'PROJ-12', text: 'second' }]);
  });

  it('an approval decided outside the flow can no longer be approved here', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: x');
    const [approval] = [...h.approvals.values()];
    h.approvals.set(approval!.id, { ...approval!, status: ApprovalStatus.REJECTED });
    const reply = await h.send('승인');
    expect(reply.reply.text).toContain('지금 승인하거나 거절할 작업이 없어요');
    expect((await h.send('댓글 실행')).reply.text).toContain('지금 실행할 승인된 외부 쓰기 요청이 없어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('a reset while a write approval is pending denies it; nothing is sent', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: x');
    await h.send('새 대화');
    expect([...h.approvals.values()][0]).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'reset' });
    expect(h.totalWrites()).toBe(0);
  });
});

const OTHER: Actor = { id: 'other-actor', displayName: 'Other', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const anchorOf = (task: Task | undefined) => task?.metadata?.connectorWriteAnchor as { status: string; closedReason?: string } | undefined;

describe('connector writes — lazy expiry of grants and choices (review fixes)', () => {
  it('an approved grant left unexecuted past its lifetime is released on the next unrelated turn and the chain restored', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: later');
    await h.send('승인');
    const anchorTaskId = h.sessions.get('sess-1')?.activeTaskId as string;
    // Within the lifetime an unrelated message leaves the grant waiting (and the chain hidden).
    advanceMinutes(10);
    await h.send('안녕');
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe(anchorTaskId);
    advanceMinutes(21);
    h.applyLookups.length = 0;
    await h.send('안녕');
    expect(anchorOf(h.tasks.get(anchorTaskId))).toMatchObject({ status: 'CLOSED', closedReason: 'expired' });
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
    // The restored chain is looked up on the very turn that released the grant.
    expect(h.applyLookups).toEqual(['task-prior']);
    expect((await h.send('댓글 실행')).reply.text).toContain('지금 실행할 승인된 외부 쓰기 요청이 없어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('the exact phrase after the lifetime says the grant expired, restores the pointer and sends nothing', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: late');
    await h.send('승인');
    advanceMinutes(30);
    const late = await h.send('댓글 실행');
    expect(late.reply.text).toContain('승인이 만료됐어요');
    expect(late.reply.text).toContain('아무것도 보내지 않았어요');
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
    expect(h.totalWrites()).toBe(0);
    expect(h.receipts.rows.size).toBe(0);
  });

  it('a numbered choice answered after the lifetime is refused as expired; nothing is proposed or written', async () => {
    const h = harness({ events: [WEEKLY, ONE_ON_ONE], priorActiveTaskId: 'task-prior' });
    await h.send('내일 3시 회의 취소해줘');
    advanceMinutes(31);
    const late = await h.send('1번');
    expect(late.reply.text).toContain('선택이 만료됐어요');
    expect(late.reply.text).toContain('캘린더는 바꾸지 않았어요');
    expect(late.reply.text).not.toContain('삭제할 일정');
    expect(h.approvals.size).toBe(0);
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
    expect(h.recorded.at(-1)).toBe(CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE);
    expect(h.totalWrites()).toBe(0);
  });

  it('the flow itself refuses a lapsed choice (defence in depth behind the turn-start release)', async () => {
    const h = harness({ events: [WEEKLY, ONE_ON_ONE] });
    await h.send('내일 3시 회의 취소해줘');
    const session = h.sessions.get('sess-1') as Session;
    const view = await h.flow!.find(session);
    advanceMinutes(31);
    const step = await h.flow!.choose({ session, actor: OWNER, view: view!, index: 1, now: new Date().toISOString() });
    expect(step).toEqual({ kind: 'refused', reason: 'choice-expired', family: 'calendar' });
    expect(h.approvals.size).toBe(0);
    expect(h.sessions.get('sess-1')?.activeTaskId).toBeUndefined();
  });

  it('an abandoned choice hands the restored chain to the same turn', async () => {
    const h = harness({ events: [WEEKLY, ONE_ON_ONE], priorActiveTaskId: 'task-prior' });
    await h.send('내일 3시 회의 취소해줘');
    h.applyLookups.length = 0;
    await h.send('안녕');
    expect(h.applyLookups).toEqual(['task-prior']);
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
  });
});

describe('connector writes — actor binding, other phrases and pre-send failures (review fixes)', () => {
  it('a different actor can neither execute nor discard the owner’s grant', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: owner only');
    await h.send('승인');
    const anchorTaskId = h.sessions.get('sess-1')?.activeTaskId as string;
    h.setActor(OTHER);
    const refused = await h.send('댓글 실행');
    expect(refused.reply.text).toContain('승인한 요청과 지금 요청이 일치하는지 확인할 수 없어요');
    await h.send('취소');
    expect(anchorOf(h.tasks.get(anchorTaskId))?.status).toBe('APPROVED');
    expect(h.totalWrites()).toBe(0);
    h.setActor(OWNER);
    expect((await h.send('댓글 실행')).reply.text).toContain('댓글을 달았어요');
    expect(h.writes.addComment).toEqual([{ issueKey: 'PROJ-12', text: 'owner only' }]);
  });

  it('another write’s phrase while a grant waits names the right phrase instead of claiming nothing is approved', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    const reply = await h.send('댓글 실행');
    expect(reply.reply.text).toContain('Slack 게시은(는) 이미 승인됐고 아직 실행하지 않았어요');
    expect(reply.reply.text).toContain('"Slack 게시 실행"');
    expect(reply.reply.text).not.toContain('승인된 외부 쓰기 요청이 없어요');
    expect(h.totalWrites()).toBe(0);
    await h.send('Slack 게시 실행');
    expect(h.writes.post).toHaveLength(1);
  });

  it('a receipt that cannot be prepared is NOT_SENT (the writer was never called), and is never retried', async () => {
    const h = harness({ receiptFails: 'prepare' });
    await h.send('PROJ-12에 댓글: x');
    await h.send('승인');
    const reply = await h.send('댓글 실행');
    expect(reply.reply.text).toContain('요청을 보내기 전에 멈췄어요');
    expect(reply.reply.text).toContain('아무것도 보내지 않았어요');
    expect(reply.reply.text).not.toContain('게시됐을 수도');
    expect(h.totalWrites()).toBe(0);
    expect((await h.send('댓글 실행')).reply.text).toContain('이미 실패로 끝났어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('an invalid request is NOT_SENT INVALID_REQUEST before any receipt or send', async () => {
    const h = harness({ commentSource: 'Not A Label' });
    await h.send('PROJ-12에 댓글: x');
    await h.send('승인');
    const reply = await h.send('댓글 실행');
    expect(reply.reply.text).toContain('요청 형식이 올바르지 않아요');
    expect(h.receipts.rows.size).toBe(0);
    expect(h.totalWrites()).toBe(0);
  });

  it('a failure after the writer was called stays UNCERTAIN (it may have been sent)', async () => {
    const h = harness({ receiptFails: 'complete' });
    await h.send('PROJ-12에 댓글: x');
    await h.send('승인');
    const reply = await h.send('댓글 실행');
    expect(h.writes.addComment).toHaveLength(1);
    expect(reply.reply.text).toContain('결과를 확인하지 못했어요');
    expect((await h.send('댓글 실행')).reply.text).toContain('다시 실행하지 않아요');
    expect(h.writes.addComment).toHaveLength(1);
  });
});

describe('connector writes — long replies are never cut (review fix)', () => {
  it('the pending reminder keeps the whole payload and the decision instructions past one message', async () => {
    const h = harness();
    const text = '`'.repeat(1400);
    const preview = await h.send(`PROJ-12에 댓글: ${text}`);
    expect(preview.status).toBe('AWAITING_APPROVAL');
    const pending = await h.send('이거 뭐야?');
    expect(pending.reply.text.length).toBeGreaterThan(1900);
    expect(pending.reply.text).toContain(text);
    expect(pending.reply.text).toContain('"승인" 또는 "거절"로 답해 주세요.');
    expect(pending.reply.text.endsWith('"새 대화"라고 보내 주세요.')).toBe(true);
  });

  it('a ten-candidate choice lists every number it accepts', async () => {
    const long = 'x'.repeat(180);
    const events = Array.from({ length: 10 }, (_, i) => ({ ...WEEKLY, id: `evt-${i}`, title: `회의 ${long} ${i}`, location: '*'.repeat(150) }));
    const h = harness({ events });
    const choice = await h.send('내일 3시 회의 취소해줘');
    expect(choice.reply.text).toContain('조건에 맞는 일정이 10개예요');
    expect(choice.reply.text).toContain('\n10. ');
    expect(choice.reply.text.endsWith('다른 말을 보내면 선택은 취소돼요.')).toBe(true);
  });
});
