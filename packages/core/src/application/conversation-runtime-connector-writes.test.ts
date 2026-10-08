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
import {
  CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE,
  renderConnectorWriteAlreadyApproved,
  renderConnectorWriteApprovedReminder,
  renderConnectorWriteBareExecution,
  renderConnectorWriteRepeat,
  renderConnectorWriteRevokeTooLate,
  renderNoApprovedConnectorWrite,
} from './connector-writes/connector-write-copy';
import {
  StatelessConnectorWriteFlow,
  connectorWriteApprovalReason,
  type ConnectorWriteWriters,
} from './connector-writes/connector-write-flow';
import { connectorWritePayloadSha256 } from './connector-writes/connector-write-payload';
import { ConversationRuntime, type ConversationRuntimeDeps } from './conversation-runtime';
import { IntentResolver } from './intent-resolver';
import type { MemoryWriter } from './memory-writer';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { APPROVAL_REFERENCE_LINE_PREFIX, MAX_CONTRIBUTED_HELP_LINES, ResponseComposer } from './response-composer';
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
  version: '"v-weekly-1"',
};
const ONE_ON_ONE: CalendarEvent = { ...WEEKLY, id: 'evt-1on1', title: '1:1 면담', location: undefined, version: '"v-1on1-1"' } as CalendarEvent;
const LUNCH: CalendarEvent = {
  ...WEEKLY, id: 'evt-lunch', title: '점심', start: '2026-10-07T03:00:00.000Z', end: '2026-10-07T04:00:00.000Z', version: '"v-lunch-1"',
};

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
  async findLatestUnresolved(match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    return (
      [...this.rows.values()]
        .filter(
          (row) =>
            (row.status === 'UNCERTAIN' || row.status === 'PREPARED') &&
            row.actorId === match.actorId &&
            row.connector === match.connector &&
            row.operation === match.operation &&
            row.target === match.target &&
            row.payloadSha256 === match.payloadSha256,
        )
        .pop() ?? null
    );
  }
  async findLatestForOperation(actorId: string, operation: string): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].filter((row) => row.actorId === actorId && row.operation === operation).pop() ?? null;
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
      async list() {
        return [...sessions.values()];
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
      async listByContext(channelId: string, threadId?: string) {
        return [...tasks.values()].filter((t) => t.context.channelId === channelId && t.context.threadId === threadId);
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
  /** Turns paused right after they read the conversation state (keyed by message text). */
  const turnGates = new Map<string, () => Promise<void>>();
  const pauseTurn = (text: string) => {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => (reached = r));
    const releaseP = new Promise<void>((r) => (release = r));
    turnGates.set(text, async () => {
      turnGates.delete(text);
      reached();
      await releaseP;
    });
    return { reached: reachedP, release };
  };
  /** Hook run inside the revocation (under its locks) before the approval is withdrawn. */
  const hooks: { beforeRevoke?: () => Promise<void> } = {};
  const receipts = new MemoryReceipts();
  if (opts.receiptFails === 'prepare') receipts.prepare = async () => { throw new Error('disk full'); };
  if (opts.receiptFails === 'complete') receipts.complete = async () => { throw new Error('disk full'); };
  let actor: Actor = OWNER;
  /** `session.activeTaskId` as each turn's apply-preview lookup saw it. */
  const applyLookups: Array<string | undefined> = [];
  const enabled = new Set(opts.writers ?? ['comment', 'transition', 'post', 'calendar']);
  /**
   * The provider's live state, mutable between preview and execution (drift). The fake writers honour the port
   * contract: a transition runs only by the bound id while it still leads to the bound status id, and an update /
   * delete only while the event still matches what was previewed — otherwise NOT_SENT('TARGET_CHANGED').
   */
  const live = {
    transitions: opts.transitions ?? [
      { id: '21', name: 'Start Progress', toStatus: '진행 중', toStatusId: '3' },
      { id: '31', name: 'Done', toStatus: '완료', toStatusId: '10002' },
    ],
    events: opts.events ?? [WEEKLY, LUNCH],
  };
  const eventDrift = (request: CalendarEventUpdateRequest | CalendarEventDeleteRequest): ConnectorWriteOutcome | undefined => {
    const event = live.events.find((candidate) => candidate.id === request.eventId);
    if (!event) return connectorWriteNotSent('NOT_FOUND');
    const { expected } = request;
    const same =
      typeof expected.version === 'string' && event.version === expected.version &&
      event.allDay === expected.allDay && event.start === expected.start && event.end === expected.end;
    return same ? undefined : connectorWriteNotSent('TARGET_CHANGED');
  };
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
      return live.transitions;
    },
    async transition(request) {
      writes.transition.push(request);
      const bound = live.transitions.filter((option) => option.id === request.transitionId);
      if (bound.length !== 1 || bound[0]?.toStatusId !== request.toStatusId) return connectorWriteNotSent('TARGET_CHANGED');
      return connectorWriteSent(`${request.issueKey}:${request.transitionId}`);
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
      return eventDrift(request) ?? connectorWriteSent(request.eventId);
    },
    async deleteEvent(request) {
      writes.deleteEvent.push(request);
      return eventDrift(request) ?? connectorWriteSent(request.eventId);
    },
  };
  const calendarReader: CalendarReader = {
    source: 'calendar',
    readOnly: true,
    async listEvents() {
      writes.listEvents++;
      if (opts.calendarReadFails) throw new Error('down');
      return live.events;
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

  const logLines: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: (message, fields) => { logLines.push({ message, ...(fields ? { fields: { ...fields } } : {}) }); },
    warn: () => undefined,
    error: () => undefined,
  };
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
      async recordShortTerm(message: InboundMessage) {
        // Pause gates (Codex P1 interleavings): a turn with this text waits here, after it read the anchor.
        const gate = turnGates.get(message.text);
        if (gate) await gate();
        return { id: 'mem-user' };
      },
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
      revoke: async (id, d) => {
        await hooks.beforeRevoke?.();
        return approvalManager.revoke(id, d);
      },
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
  const sendIn = (context: ConversationContext, text: string) =>
    runtime.handle({ id: `msg-${++seq}`, context, text, receivedAt: T0 } satisfies InboundMessage);
  const send = (text: string) => sendIn(CTX, text);
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
    send, sendIn, writes, totalWrites, receipts, approvals, tasks, sessions, recorded, classify, runtime, flow, anchorTask, setActor, logLines,
    applyLookups, live, pauseTurn, hooks,
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
    expect(preview.reply.text).toContain('Jira 댓글 미리보기예요. 이 요청으로는 아직 아무것도 보내지 않았어요.');
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

  it('a denial sends nothing and the phrase afterwards names the rejected request', async () => {
    const h = harness();
    await h.send('Jira PROJ-3에 댓글: 확인했어요');
    const denied = await h.send('거절');
    expect(denied.status).toBe('DENIED');
    expect(denied.reply.text).toBe('요청을 거절했어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect([...h.approvals.values()][0]?.status).toBe(ApprovalStatus.REJECTED);
    const stray = await h.send('댓글 실행');
    expect(stray.reply.text).toBe('가장 최근 Jira 댓글 요청(PROJ-3)은 거절돼서 실행하지 않았어요. 그 요청으로는 아무것도 보내지 않았어요.\n필요하면 새로 요청해 주세요.');
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
    expect(failed.reply.text).toContain('Jira 댓글을 보내지 못했어요: 권한이 없어요. 댓글은 달리지 않았어요.');
    expect((await notSent.send('댓글 실행')).reply.text).toContain('이미 실패로 끝났어요');
    expect(notSent.writes.addComment).toHaveLength(1);
  });

  it('UNC-1: re-requesting a write whose earlier send is UNCERTAIN previews with a duplicate warning; approval still works', async () => {
    const outcomes: ConnectorWriteOutcome[] = [connectorWriteUncertain('TRANSPORT'), connectorWriteSent('10002', COMMENT_URL)];
    const h = harness({ commentOutcome: async () => outcomes.shift() ?? connectorWriteUncertain('UNKNOWN') });
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    expect((await h.send('댓글 실행')).reply.text).toContain('결과를 확인하지 못했어요');
    advanceMinutes(5);

    const again = await h.send('PROJ-12에 댓글: 한 번만');
    const lines = again.reply.text.split('\n');
    expect(lines[0]).toBe(
      '주의: 같은 내용의 이전 요청은 결과를 확인하지 못했어요(10월 6일 10:00). 이미 게시됐을 수 있으니 대상을 먼저 확인해 주세요. 그래도 보내려면 승인 후 실행하세요.',
    );
    expect(again.reply.text).toContain('Jira 댓글 미리보기예요');
    expect(again.reply.text).not.toContain('이미 보냈어요');
    // Not blocked: approve and execute send once more (the owner's explicit choice).
    expect((await h.send('승인')).reply.text).toContain('승인을 기록했어요');
    expect((await h.send('댓글 실행')).reply.text).toContain('댓글을 달았어요');
    expect(h.writes.addComment).toHaveLength(2);
    // Now a SENT receipt exists for the same payload: the existing "이미 보냈어요" guard wins over the warning.
    const third = await h.send('PROJ-12에 댓글: 한 번만');
    expect(third.reply.text).toContain('이미 보냈어요');
    expect(third.reply.text).not.toContain('주의: 같은 내용의 이전 요청');
    expect(h.writes.addComment).toHaveLength(2);
  });

  it('UNC-1: the duplicate warning is bound to the same target and payload, and absent after a NOT_SENT', async () => {
    const h = harness({ commentOutcome: async () => connectorWriteUncertain('TRANSPORT') });
    await h.send('PROJ-12에 댓글: 원본');
    await h.send('승인');
    await h.send('댓글 실행');
    expect((await h.send('PROJ-12에 댓글: 다른 내용')).reply.text).not.toContain('주의:');
    await h.send('거절');
    expect((await h.send('PROJ-13에 댓글: 원본')).reply.text).not.toContain('주의:');
    await h.send('거절');
    expect((await h.send('PROJ-12에 댓글: 원본')).reply.text.startsWith('주의: 같은 내용의 이전 요청은 결과를 확인하지 못했어요(')).toBe(true);

    const failed = harness({ commentOutcome: async () => connectorWriteNotSent('UNAVAILABLE') });
    await failed.send('PROJ-12에 댓글: 원본');
    await failed.send('승인');
    expect((await failed.send('댓글 실행')).reply.text).toContain('Jira 댓글을 보내지 못했어요: 연결에 실패해서 요청을 보내기 전에 멈췄어요.');
    const retry = await failed.send('PROJ-12에 댓글: 원본');
    expect(retry.reply.text).not.toContain('주의:');
    expect(retry.reply.text).toContain('Jira 댓글 미리보기예요');
  });

  it('expires a pending approval after 30 minutes and an unexecuted grant 30 minutes after approval', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: a');
    advanceMinutes(31);
    const expired = await h.send('승인');
    expect(expired.status).toBe('DENIED');
    expect([...h.approvals.values()][0]).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'expired' });
    expect((await h.send('댓글 실행')).reply.text).toContain('가장 최근 Jira 댓글 요청(PROJ-12)은 승인 시간이 지나 만료돼서 실행하지 않았어요.');

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
    // Codex P1 on 55c5a2f: the claim re-reads the LIVE anchor, so the stale view never reaches the executor again.
    expect(replay).toMatchObject({ kind: 'repeat', status: 'SENT' });
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
    expect(preview.reply.text).toContain('바꿀 상태: 진행 중 (상태 ID 3)');
    expect(preview.reply.text).toContain('전환: Start Progress (전환 ID 21)');
    await h.send('승인');
    const sent = await h.send('상태 변경 실행');
    // The approved ids are what executes — never the status name.
    expect(h.writes.transition).toEqual([{ issueKey: 'PROJ-12', transitionId: '21', toStatusId: '3' }]);
    expect(sent.reply.text).toContain('상태를 바꿨어요');

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
    expect(preview.reply.text).toContain('캘린더 일정 추가 미리보기예요. 이 요청으로는 아직 캘린더를 바꾸지 않았어요.');
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
    expect(h.writes.deleteEvent).toEqual([
      { eventId: 'evt-1on1', expected: { allDay: false, start: ONE_ON_ONE.start, end: ONE_ON_ONE.end, version: '"v-1on1-1"' } },
    ]);
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
        expected: { allDay: false, start: WEEKLY.start, end: WEEKLY.end, version: WEEKLY.version },
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

describe('connector writes — immutable target binding (ADR-0112, Codex P1)', () => {
  const TRANSITION_CHANGED = 'Jira 상태 전환 조건이 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.';
  const EVENT_CHANGED = '일정이 미리보기 이후에 바뀌어서 실행하지 않았어요. 다시 요청해 주세요.';
  const FINISH = [
    { id: '21', name: 'Start Progress', toStatus: '진행 중', toStatusId: '3' },
    { id: '31', name: 'Finish', toStatus: 'Done', toStatusId: '10002' },
  ];

  async function approvedTransition() {
    const h = harness({ transitions: FINISH });
    const preview = await h.send('PROJ-12 Done으로 바꿔줘');
    expect(preview.reply.text).toContain('바꿀 상태: Done (상태 ID 10002)');
    expect(preview.reply.text).toContain('전환: Finish (전환 ID 31)');
    const anchor = h.anchorTask()?.metadata?.connectorWriteAnchor as { payload: Record<string, unknown> };
    // The hashed, approved payload binds the transition and its destination by id (and the names it showed).
    expect(anchor.payload).toEqual({
      operation: 'ISSUE_TRANSITION',
      issueKey: 'PROJ-12',
      transitionId: '31',
      transitionName: 'Finish',
      toStatusId: '10002',
      toStatus: 'Done',
    });
    await h.send('승인');
    return h;
  }

  function expectRefusedDrift(h: ReturnType<typeof harness>, text: string, expected: string): void {
    expect(text).toContain(expected);
    expect(text).toContain('아무것도 보내지 않았어요');
    expect(text).not.toMatch(/완료:|바꿨어요|삭제했어요/);
    const receipts = [...h.receipts.rows.values()];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'NOT_SENT', data: { reason: 'TARGET_CHANGED' } });
  }

  it('Codex scenario: the approved Finish → Done is gone and the name now leads to Closed — NOT_SENT, never a name match', async () => {
    const h = await approvedTransition();
    h.live.transitions = [
      { id: '41', name: 'Done', toStatus: 'Closed', toStatusId: '6' },
      { id: '42', name: 'Finish', toStatus: 'Closed', toStatusId: '6' },
    ];
    const reply = await h.send('상태 변경 실행');
    expect(h.writes.transition).toEqual([{ issueKey: 'PROJ-12', transitionId: '31', toStatusId: '10002' }]);
    expectRefusedDrift(h, reply.reply.text, TRANSITION_CHANGED);
    // Recorded as failed: a repeated phrase sends nothing again.
    expect((await h.send('상태 변경 실행')).reply.text).toContain('이미 실패로 끝났어요');
    expect(h.writes.transition).toHaveLength(1);
  });

  it('the approved transition id still exists but now leads to another status — NOT_SENT', async () => {
    const h = await approvedTransition();
    h.live.transitions = [{ id: '31', name: 'Finish', toStatus: 'Closed', toStatusId: '6' }];
    expectRefusedDrift(h, (await h.send('상태 변경 실행')).reply.text, TRANSITION_CHANGED);
  });

  it('the approved transition id was removed — NOT_SENT even though the status is still reachable another way', async () => {
    const h = await approvedTransition();
    h.live.transitions = [{ id: '99', name: 'Close out', toStatus: 'Done', toStatusId: '10002' }];
    expectRefusedDrift(h, (await h.send('상태 변경 실행')).reply.text, TRANSITION_CHANGED);
  });

  it('the bound ids are covered by the approval hash: an anchored id changed after approval never runs', async () => {
    const h = await approvedTransition();
    const task = h.anchorTask() as Task;
    (task.metadata?.connectorWriteAnchor as { payload: { transitionId: string } }).payload.transitionId = '41';
    h.tasks.set(task.id, task);
    const reply = await h.send('상태 변경 실행');
    expect(reply.reply.text).toContain('승인한 요청과 지금 요청이 일치하는지 확인할 수 없어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('a preview never binds a transition without a destination status id', async () => {
    const h = harness({ transitions: [{ id: '31', name: 'Finish', toStatus: 'Done', toStatusId: '' }] });
    const reply = await h.send('PROJ-12 Done으로 바꿔줘');
    expect(reply.reply.text).toContain('바꿀 수 있는 상태를 확인하지 못했어요');
    expect(h.approvals.size).toBe(0);
  });

  it('a calendar event moved between preview and execution is NOT_SENT; the calendar is not changed', async () => {
    const h = harness({ events: [WEEKLY, LUNCH] });
    await h.send('내일 3시 회의 4시로 옮겨줘');
    await h.send('승인');
    h.live.events = [{ ...WEEKLY, start: '2026-10-07T08:00:00.000Z', end: '2026-10-07T09:00:00.000Z' }, LUNCH];
    const reply = await h.send('일정 변경 실행');
    expect(h.writes.updateEvent[0]?.expected).toEqual({ allDay: false, start: WEEKLY.start, end: WEEKLY.end, version: WEEKLY.version });
    expect(reply.reply.text).toContain(EVENT_CHANGED);
    expect(reply.reply.text).toContain('이 요청으로는 캘린더를 바꾸지 않았어요');
    expect(reply.reply.text).not.toContain('일정을 바꿨어요');
    expect([...h.receipts.rows.values()][0]).toMatchObject({ status: 'NOT_SENT', data: { reason: 'TARGET_CHANGED' } });
  });

  it('binds the event version: an edit after the preview (same time) refuses a delete; an unchanged one is deleted', async () => {
    const versioned = { ...WEEKLY, version: '"v1"' };
    const h = harness({ events: [versioned, LUNCH] });
    const preview = await h.send('내일 3시 회의 취소해줘');
    expect(preview.reply.text).toContain('삭제할 일정: 주간 회의');
    expect(preview.reply.text).toContain('미리보기 그대로일 때만 실행해요');
    await h.send('승인');
    h.live.events = [{ ...versioned, title: '주간 회의 (안건 추가)', version: '"v2"' }, LUNCH];
    const refused = await h.send('일정 삭제 실행');
    expect(h.writes.deleteEvent).toEqual([
      { eventId: 'evt-weekly', expected: { allDay: false, start: WEEKLY.start, end: WEEKLY.end, version: '"v1"' } },
    ]);
    expect(refused.reply.text).toContain(EVENT_CHANGED);

    const g = harness({ events: [versioned, LUNCH] });
    await g.send('내일 3시 회의 취소해줘');
    await g.send('승인');
    const done = await g.send('일정 삭제 실행');
    expect(done.reply.text).toContain('일정을 삭제했어요');
    expect([...g.receipts.rows.values()][0]).toMatchObject({ status: 'SENT' });
  });

  it('Codex P2: an event without a usable version is never proposed — nothing approved, nothing changed', async () => {
    for (const version of [undefined, '', 'two\nlines']) {
      const unversioned = { ...WEEKLY, version } as CalendarEvent;
      for (const text of ['내일 3시 회의 취소해줘', '내일 3시 회의 4시로 옮겨줘']) {
        const h = harness({ events: [unversioned, LUNCH] });
        const reply = await h.send(text);
        expect(reply.reply.text).toContain('버전 정보가 없어서 바꾸거나 삭제하지 않아요');
        expect(reply.reply.text).toContain('이 요청으로는 캘린더를 바꾸지 않았어요');
        expect(h.approvals.size).toBe(0);
        expect((await h.send('승인')).reply.text).not.toContain('승인을 기록했어요');
        expect(h.totalWrites()).toBe(0);
        expect(h.receipts.rows.size).toBe(0);
      }
    }
  });

  it('Codex P2: an approved update / delete whose bound version is missing is NOT_SENT TARGET_CHANGED without a writer call', async () => {
    for (const [request, phrase] of [['내일 3시 회의 취소해줘', '일정 삭제 실행'], ['내일 3시 회의 4시로 옮겨줘', '일정 변경 실행']] as const) {
      const h = harness({ events: [WEEKLY, LUNCH] });
      await h.send(request);
      await h.send('승인');
      // An anchor approved without a bound version (e.g. from before versions were required): rebind its hash so only
      // the missing version is wrong, as a legitimately approved old-shape payload would be.
      const task = h.anchorTask() as Task;
      const anchor = task.metadata?.connectorWriteAnchor as {
        operation: 'CALENDAR_EVENT_UPDATE' | 'CALENDAR_EVENT_DELETE'; target: string; approvalId: string; payloadSha256: string;
        payload: { operation: string; expected: { version?: string } };
      };
      delete anchor.payload.expected.version;
      const { operation: _op, ...sendable } = anchor.payload;
      anchor.payloadSha256 = connectorWritePayloadSha256(anchor.operation, anchor.target, sendable);
      const approval = h.approvals.get(anchor.approvalId) as ApprovalRequest;
      h.approvals.set(approval.id, { ...approval, reason: connectorWriteApprovalReason(anchor.operation, anchor.target, anchor.payloadSha256) });
      h.tasks.set(task.id, task);
      const reply = await h.send(phrase);
      expect(reply.reply.text).toContain(EVENT_CHANGED);
      expect(h.writes.updateEvent.length + h.writes.deleteEvent.length).toBe(0);
      expect([...h.receipts.rows.values()][0]).toMatchObject({ status: 'NOT_SENT', data: { reason: 'TARGET_CHANGED' } });
    }
  });

  it('a numbered choice binds the listed event: a change after the listing refuses the execution', async () => {
    const h = harness({ events: [WEEKLY, ONE_ON_ONE] });
    await h.send('내일 3시 회의 취소해줘');
    await h.send('1번');
    await h.send('승인');
    h.live.events = [{ ...WEEKLY, end: '2026-10-07T07:30:00.000Z' }, ONE_ON_ONE];
    expect((await h.send('일정 삭제 실행')).reply.text).toContain(EVENT_CHANGED);
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
    expect((await h.send('댓글 실행')).reply.text).toContain('가장 최근 Jira 댓글 요청(PROJ-12)은 확인할 수 없어서 실행하지 않았어요.');
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
    expect((await h.send('댓글 실행')).reply.text).toContain('가장 최근 Jira 댓글 요청(PROJ-12)은 승인 시간이 지나 만료돼서 실행하지 않았어요.');
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
    expect(late.reply.text).toContain('이 요청으로는 캘린더를 바꾸지 않았어요');
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

  it('a question about the execution step while a grant waits gets the non-mutating reminder (W5-L01)', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    const reply = await h.send('댓글 실행해도 돼?');
    expect(reply.reply.text).toBe('승인된 Jira 댓글(PROJ-12)은 아직 실행하지 않았어요. 실제로 보내려면 "댓글 실행"이라고만 보내 주세요.');
    expect((await h.send('댓글 실행하지 마')).reply.text).toBe(reply.reply.text);
    expect(h.totalWrites()).toBe(0);
    expect((await h.send('댓글 실행')).reply.text).toContain('댓글을 달았어요');

    const post = harness();
    await post.send('#dev에 게시: 배포 시작');
    await post.send('승인');
    expect((await post.send('Slack 게시 실행해도 돼?')).reply.text).toContain('"Slack 게시 실행"이라고만 보내 주세요');
    expect(post.totalWrites()).toBe(0);
  });

  it('the reminder covers only the approved operation’s own step and never explanation requests (W5-L01 review)', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    expect((await h.send('Jira 댓글 실행 방식 설명해줘')).reply.text).not.toContain('아직 실행하지 않았어요');
    expect((await h.send('댓글 실행해도 돼?')).reply.text).not.toContain('"Slack 게시 실행"이라고만');
    expect((await h.send('Slack 게시 실행은 어떻게 해?')).reply.text).not.toContain('아직 실행하지 않았어요');
    expect((await h.send('Slack 게시 실행해도 돼?')).reply.text).toContain('"Slack 게시 실행"이라고만 보내 주세요');
    expect(h.totalWrites()).toBe(0);
  });

  it('a repeated execution phrase after a SENT write in the same conversation says it was already executed, with the link (W5-L02)', async () => {
    // The write displaced an earlier pointer, so after the send the pointer is restored and the phrase reaches the
    // stray-phrase path: only THIS conversation's recent receipt answers "already executed".
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    await h.send('댓글 실행');
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
    const again = await h.send('댓글 실행');
    // When (10:00 KST) and where it went, so it can never be mistaken for another post.
    expect(again.reply.text).toBe([`이미 보냈어요 (10:00, Jira PROJ-12): <${COMMENT_URL}>`, '다시 보내지 않았어요.'].join('\n'));
    expect(h.writes.addComment).toHaveLength(1);
    expect((await h.send('Slack 게시 실행')).reply.text).toContain('승인된 외부 쓰기 요청이 없어요');
  });

  it('after a reset the earlier conversation’s send is not "already executed" here (cross-session fix; was W5-L02 actor-wide)', async () => {
    // Previously the latest SENT receipt of the actor answered from ANY conversation. 새 대화 opens a new conversation,
    // so the phrase there has nothing approved and must say so.
    const h = harness();
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    await h.send('댓글 실행');
    await h.send('새 대화');
    const again = await h.send('댓글 실행');
    expect(again.reply.text).toBe(renderNoApprovedConnectorWrite());
    expect(again.reply.text).not.toContain(COMMENT_URL);
    expect(h.writes.addComment).toHaveLength(1);
  });

  it('a same-conversation SENT older than the approval lifetime is no longer "already executed"', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    await h.send('댓글 실행');
    advanceMinutes(29);
    expect((await h.send('댓글 실행')).reply.text).toContain('이미 보냈어요 (10:00, Jira PROJ-12)');
    advanceMinutes(1);
    const late = await h.send('댓글 실행');
    expect(late.reply.text).toBe(renderNoApprovedConnectorWrite());
    expect(h.writes.addComment).toHaveLength(1);
  });

  it('a later write in the same conversation still lets the earlier recent send answer (pointer moved, same session)', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    await h.send('댓글 실행');
    await h.send('#dev에 게시: 배포 시작');
    await h.send('거절');
    const again = await h.send('댓글 실행');
    expect(again.reply.text).toContain('이미 보냈어요 (10:00, Jira PROJ-12)');
    expect(h.totalWrites()).toBe(1);
  });

  it('another write’s phrase while a grant waits names the right phrase instead of claiming nothing is approved', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    const reply = await h.send('댓글 실행');
    expect(reply.reply.text).toContain('Slack 게시는 이미 승인됐고 아직 실행하지 않았어요');
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
    expect(reply.reply.text).toContain('Jira 댓글을 보내지 못했어요');
    expect(reply.reply.text).toContain('댓글은 달리지 않았어요');
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

describe('connector writes — an execution phrase in another conversation (live QA 2026-10-07, cross-session)', () => {
  /** The UAT guild channel (S1) and the owner DM with the bot (S2): the same owner, two conversations. */
  const GUILD: ConversationContext = { platform: 'test', spaceId: '900000000000000001', channelId: '900000000000000002', userId: 'owner-user' };
  const DM: ConversationContext = { platform: 'test', channelId: '900000000000000003', userId: 'owner-user' };
  const elsewhereInGuild = (minutes: number) =>
    [
      `실행하지 않았어요. 승인된 Slack 게시(#dev)는 다른 대화에서 기다리고 있어요 (약 ${minutes}분 남음).`,
      '미리보기를 받은 <#900000000000000002>에서 "Slack 게시 실행"이라고 보내 주세요.',
    ].join('\n');

  /** Preview in `context` with the operations-UI reference line on, and return the approval id and the reference. */
  async function previewWithReference(h: ReturnType<typeof harness>, context: ConversationContext, text: string) {
    h.runtime.approvalDecisions.setConfirmationReferenceEnabled(true);
    const preview = await h.sendIn(context, text);
    const line = preview.reply.text.split('\n').find((l) => l.startsWith(APPROVAL_REFERENCE_LINE_PREFIX));
    if (!line) throw new Error('no reference line');
    const reference = line.slice(APPROVAL_REFERENCE_LINE_PREFIX.length, APPROVAL_REFERENCE_LINE_PREFIX.length + 6);
    const approval = [...h.approvals.values()].find((a) => a.status === ApprovalStatus.PENDING);
    return { approvalId: approval!.id, reference };
  }

  it('the live repro: approved in the ops UI for the guild channel, then "Slack 게시 실행" in the DM runs nothing and says where', async () => {
    const h = harness();
    // An unrelated, older Slack post from yet another conversation (the link the bot wrongly returned live).
    await h.sendIn({ ...DM, channelId: '900000000000000009' }, '#dev에 게시: 어제 게시물');
    await h.sendIn({ ...DM, channelId: '900000000000000009' }, '승인');
    await h.sendIn({ ...DM, channelId: '900000000000000009' }, 'Slack 게시 실행');
    expect(h.writes.post).toHaveLength(1);
    advanceMinutes(150);

    const { approvalId, reference } = await previewWithReference(h, GUILD, '#dev에 게시: 운영 UI 승인 테스트입니다');
    const decided = await h.runtime.approvalDecisions.decideFromOpsUi({
      approvalId,
      decision: 'approve',
      actor: OWNER,
      reference,
      sessions: async () => [...h.sessions.values()],
    });
    expect(decided).toMatchObject({
      status: 'DECIDED',
      outcome: 'APPROVED',
      kind: 'CONNECTOR_WRITE',
      chat: GUILD,
      connectorWrite: {
        operation: 'CHANNEL_POST',
        target: { kind: 'channel', channelLabel: 'dev', channelId: 'C0DEV' },
        executionPhrase: 'Slack 게시 실행',
        remainingMs: 30 * 60_000,
      },
    });
    expect(h.approvals.get(approvalId)?.status).toBe(ApprovalStatus.APPROVED);

    const classifyBefore = h.classify.count;
    advanceMinutes(4);
    const reply = await h.sendIn(DM, 'Slack 게시 실행');
    expect(reply.reply.text).toBe(elsewhereInGuild(26));
    expect(reply.reply.text).not.toContain('운영 UI 승인 테스트입니다');
    expect(reply.reply.text).not.toContain('이미 보냈어요');
    expect(reply.reply.text).not.toContain('https://');
    expect(h.writes.post).toHaveLength(1); // only the old post: nothing new was sent
    expect(h.classify.count).toBe(classifyBefore); // deterministic: no classification, no provider (router throws)

    // The binding holds: the grant still runs only where it was approved, exactly once.
    const sent = await h.sendIn(GUILD, 'Slack 게시 실행');
    expect(sent.reply.text).toContain('Slack 게시 완료');
    expect(h.writes.post).toHaveLength(2);
    expect(h.writes.post[1]).toMatchObject({ channel: 'C0DEV', text: '운영 UI 승인 테스트입니다' });
  });

  it('an approval waiting in a DM is named as the DM', async () => {
    const h = harness();
    await h.sendIn(DM, 'PROJ-12에 댓글: 디엠에서 승인');
    await h.sendIn(DM, '승인');
    const reply = await h.sendIn(GUILD, '댓글 실행');
    expect(reply.reply.text).toBe(
      [
        '실행하지 않았어요. 승인된 Jira 댓글(PROJ-12)은 다른 대화에서 기다리고 있어요 (약 30분 남음).',
        '미리보기를 받은 봇과의 DM에서 "댓글 실행"이라고 보내 주세요.',
      ].join('\n'),
    );
    expect(reply.reply.text).not.toContain('디엠에서 승인');
    expect(h.totalWrites()).toBe(0);
  });

  it('a finished post still holding this conversation’s pointer neither hides the grant elsewhere nor reports an old send', async () => {
    const h = harness();
    await h.sendIn(DM, '#dev에 게시: 디엠 게시물');
    await h.sendIn(DM, '승인');
    await h.sendIn(DM, 'Slack 게시 실행');
    expect(h.writes.post).toHaveLength(1);
    // Right after the send the repeat is reported (the original CWR-2 repeat reply).
    expect((await h.sendIn(DM, 'Slack 게시 실행')).reply.text).toContain('이미 실행했어요');
    advanceMinutes(150);
    // Hours later it is not "already executed" any more.
    expect((await h.sendIn(DM, 'Slack 게시 실행')).reply.text).toBe(renderNoApprovedConnectorWrite());
    const { approvalId, reference } = await previewWithReference(h, GUILD, '#dev에 게시: 길드 게시물');
    await h.runtime.approvalDecisions.decideFromOpsUi({
      approvalId, decision: 'approve', actor: OWNER, reference, sessions: async () => [...h.sessions.values()],
    });
    expect((await h.sendIn(DM, 'Slack 게시 실행')).reply.text).toBe(elsewhereInGuild(30));
    expect(h.writes.post).toHaveLength(1);
  });

  it('an old SENT receipt from another conversation with nothing approved is the no-approved reply, never "already executed"', async () => {
    const h = harness();
    await h.sendIn(GUILD, '#dev에 게시: 지난 게시물');
    await h.sendIn(GUILD, '승인');
    await h.sendIn(GUILD, 'Slack 게시 실행');
    expect(h.writes.post).toHaveLength(1);
    // Recent or old, another conversation's receipt never answers here.
    expect((await h.sendIn(DM, 'Slack 게시 실행')).reply.text).toBe(renderNoApprovedConnectorWrite());
    advanceMinutes(150);
    expect((await h.sendIn(DM, 'Slack 게시 실행')).reply.text).toBe(renderNoApprovedConnectorWrite());
    expect(h.writes.post).toHaveLength(1);
  });

  it('never points at a lapsed grant, another actor’s grant, another kind of write or a reset conversation', async () => {
    const h = harness();
    await h.sendIn(GUILD, '#dev에 게시: 곧 만료');
    await h.sendIn(GUILD, '승인');
    expect((await h.sendIn(DM, '댓글 실행')).reply.text).toBe(renderNoApprovedConnectorWrite()); // another kind
    h.setActor(OTHER);
    expect((await h.sendIn({ ...DM, channelId: '900000000000000008' }, 'Slack 게시 실행')).reply.text).toBe(renderNoApprovedConnectorWrite());
    h.setActor(OWNER);
    advanceMinutes(30);
    expect((await h.sendIn(DM, 'Slack 게시 실행')).reply.text).toBe(renderNoApprovedConnectorWrite()); // lapsed
    expect(h.totalWrites()).toBe(0);

    const r = harness();
    await r.sendIn(GUILD, '#dev에 게시: 리셋');
    await r.sendIn(GUILD, '승인');
    await r.sendIn(GUILD, '새 대화');
    expect((await r.sendIn(DM, 'Slack 게시 실행')).reply.text).toBe(renderNoApprovedConnectorWrite());
    expect(r.totalWrites()).toBe(0);
  });
});

describe('connector writes — routing exec gaps (INT-2 / PR #137 follow-ups)', () => {
  const POST_BARE = '승인된 Slack 게시(#dev)는 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "Slack 게시 실행"';
  const BARE_FORMS = ['실행', '실행해', '실행해줘', '실행 해 주세요', '지금 실행', 'go', 'Go!', 'run it', 'run it now', 'execute'];
  const PHRASES = ['댓글 실행', '상태 변경 실행', 'Slack 게시 실행', '일정 추가 실행', '일정 변경 실행', '일정 삭제 실행'] as const;
  const askedForms = (phrase: string) => [`${phrase}해도 돼?`, `${phrase}할까?`, `${phrase}하지 마`, `${phrase} 안 해도 돼`];

  it('gap 1: a bare "실행" / "go" / "run it" while a post waits approved runs nothing and quotes the exact phrase — no provider', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    const classifyBefore = h.classify.count;
    for (const text of BARE_FORMS) {
      const reply = await h.send(text);
      expect(reply.reply.text, text).toBe(POST_BARE);
      expect(reply.status, text).toBe('RESPONDED');
    }
    expect(h.classify.count).toBe(classifyBefore); // deterministic: never classified, never a provider (router throws)
    expect(h.totalWrites()).toBe(0);
    expect(anchorOf(h.anchorTask())?.status).toBe('APPROVED'); // the grant still waits for its exact phrase
    // Approve words keep their existing reply; the exact phrase still sends exactly once.
    expect((await h.send('go ahead')).reply.text).toBe(renderConnectorWriteAlreadyApproved('CHANNEL_POST', 'Slack 게시 실행'));
    expect(h.totalWrites()).toBe(0);
    expect((await h.send('Slack 게시 실행')).reply.text).toContain('Slack 게시 완료');
    expect(h.writes.post).toHaveLength(1);
  });

  it('gap 1: each approved write quotes its own phrase (calendar too, with the history note)', async () => {
    const comment = harness();
    await comment.send('PROJ-12에 댓글: 한 번만');
    await comment.send('승인');
    expect((await comment.send('실행해줘')).reply.text).toBe(renderConnectorWriteBareExecution('ISSUE_COMMENT', '댓글 실행', { kind: 'issue', issueKey: 'PROJ-12' }));
    expect(comment.totalWrites()).toBe(0);

    const calendar = harness();
    await calendar.send('내일 오후 3시에 회의 잡아줘 제목 주간 회의');
    await calendar.send('승인');
    const reply = await calendar.send('실행');
    expect(reply.reply.text).toBe('승인된 캘린더 일정 추가(기본 캘린더)는 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "일정 추가 실행"');
    expect(calendar.recorded.at(-1)).toBe(CONNECTOR_WRITE_CALENDAR_HISTORY_NOTE);
    expect(calendar.totalWrites()).toBe(0);
  });

  it('gap 1: another actor’s bare "실행" runs nothing either; a sentence around 실행 is not a bare command', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    h.setActor(OTHER);
    expect((await h.send('실행')).reply.text).toBe(POST_BARE);
    h.setActor(OWNER);
    const classifyBefore = h.classify.count;
    const sentence = await h.send('실행 결과 정리해서 알려줘');
    expect(sentence.reply.text).not.toBe(POST_BARE);
    expect(h.classify.count).toBe(classifyBefore + 1); // ordinary routing
    expect(h.totalWrites()).toBe(0);
    expect(anchorOf(h.anchorTask())?.status).toBe('APPROVED');
  });

  it('gap 1: with nothing approved a bare "실행" is not given the connector-write reply', async () => {
    const h = harness();
    const reply = await h.send('실행');
    expect(reply.reply.text).not.toContain('실행할 작업을 정확히 말해 주세요');
    expect(h.totalWrites()).toBe(0);
  });

  it('gap 2: every write step asked as a question or negation with nothing approved gets the no-approved reply, provider-free', async () => {
    const h = harness();
    const classifyBefore = h.classify.count;
    for (const phrase of PHRASES) {
      for (const text of askedForms(phrase)) {
        const reply = await h.send(text);
        expect(reply.reply.text, text).toBe(renderNoApprovedConnectorWrite());
      }
    }
    expect(h.classify.count).toBe(classifyBefore);
    expect(h.totalWrites()).toBe(0);
    expect(h.approvals.size).toBe(0);
  });

  it('gap 2: with writes off the question still gets the fixed no-approved reply', async () => {
    const h = harness({ noFlow: true });
    expect((await h.send('댓글 실행해도 돼?')).reply.text).toBe(renderNoApprovedConnectorWrite());
    expect((await h.send('Slack 게시 실행하지 마')).reply.text).toBe(renderNoApprovedConnectorWrite());
    expect(h.totalWrites()).toBe(0);
  });

  it('gap 2: a question in another conversation names where the approved write waits; it never executes there or here', async () => {
    const DM: ConversationContext = { platform: 'test', channelId: '900000000000000003', userId: 'owner-user' };
    const GUILD: ConversationContext = { platform: 'test', spaceId: '900000000000000001', channelId: '900000000000000002', userId: 'owner-user' };
    const h = harness();
    await h.sendIn(DM, 'PROJ-12에 댓글: 디엠에서 승인');
    await h.sendIn(DM, '승인');
    const elsewhere = [
      '실행하지 않았어요. 승인된 Jira 댓글(PROJ-12)은 다른 대화에서 기다리고 있어요 (약 30분 남음).',
      '미리보기를 받은 봇과의 DM에서 "댓글 실행"이라고 보내 주세요.',
    ].join('\n');
    for (const text of ['댓글 실행해도 돼?', '댓글 실행하지 마']) {
      expect((await h.sendIn(GUILD, text)).reply.text, text).toBe(elsewhere);
    }
    // The existing veto on questions stays where the grant is: a reminder, never a send.
    expect((await h.sendIn(DM, '댓글 실행해도 돼?')).reply.text).toBe(renderConnectorWriteApprovedReminder('ISSUE_COMMENT', '댓글 실행', { kind: 'issue', issueKey: 'PROJ-12' }));
    expect(h.totalWrites()).toBe(0);
    expect((await h.sendIn(DM, '댓글 실행')).reply.text).toContain('댓글을 달았어요');
    expect(h.writes.addComment).toHaveLength(1);
  });

  it('gap 2: a question about ANOTHER write while one waits approved names the approved phrase (never "nothing approved")', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    for (const text of ['댓글 실행해도 돼?', '일정 삭제 실행하지 마', '상태 변경 실행할까?']) {
      const reply = await h.send(text);
      expect(reply.reply.text, text).toBe(renderConnectorWriteAlreadyApproved('CHANNEL_POST', 'Slack 게시 실행'));
    }
    expect(h.totalWrites()).toBe(0);
    expect(anchorOf(h.anchorTask())?.status).toBe('APPROVED');
  });

  it('gap 2: after a recent send in this conversation the question reports the send and never resends', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    await h.send('댓글 실행');
    const again = await h.send('댓글 실행해도 돼?');
    expect(again.reply.text).toBe([`이미 보냈어요 (10:00, Jira PROJ-12): <${COMMENT_URL}>`, '다시 보내지 않았어요.'].join('\n'));
    expect(h.writes.addComment).toHaveLength(1);
  });

  it('gap 2: explanations, concept questions and statements about a step stay ordinary chat', async () => {
    const h = harness();
    for (const text of ['댓글 실행 방법 알려줘', 'Slack 게시 실행은 어떻게 해?', '일정 추가 실행이 뭐야?', '댓글 실행했어']) {
      const before = h.classify.count;
      const reply = await h.send(text);
      expect(reply.reply.text, text).not.toBe(renderNoApprovedConnectorWrite());
      expect(h.classify.count, text).toBe(before + 1);
    }
    expect(h.totalWrites()).toBe(0);
  });

  describe('Codex P2 on 039d5ff: an unconfirmed write is never answered with "nothing was sent"', () => {
    const UNCERTAIN_COMMENT = renderConnectorWriteRepeat('ISSUE_COMMENT', 'UNCERTAIN');
    const OLDER_UNCERTAIN = '그 전의 Jira 댓글 요청은 결과를 확인하지 못했어요. 이미 게시됐을 수도 있으니 직접 확인해 주세요. 다시 실행하지 않아요.';
    const LATEST_NOT_SENT_WITH_OLDER_UNCERTAIN = [
      '가장 최근 Jira 댓글 요청(PROJ-12)은 실행했지만 보내지 못했어요. 그 요청으로는 아무것도 보내지 않았어요.',
      OLDER_UNCERTAIN,
      '필요하면 새로 요청해 주세요.',
    ].join('\n');
    const LATEST_B_DENIED_WITH_OLDER_UNCERTAIN = [
      '가장 최근 Jira 댓글 요청(PROJ-13)은 거절돼서 실행하지 않았어요. 그 요청으로는 아무것도 보내지 않았어요.',
      OLDER_UNCERTAIN,
      '필요하면 새로 요청해 주세요.',
    ].join('\n');

    async function uncertainComment(opts: HarnessOptions = {}) {
      const h = harness({ ...opts, commentOutcome: async () => connectorWriteUncertain('TRANSPORT') });
      await h.send('PROJ-12에 댓글: 한 번만');
      await h.send('승인');
      expect((await h.send('댓글 실행')).reply.text).toContain('결과를 확인하지 못했어요');
      expect(h.writes.addComment).toHaveLength(1);
      return h;
    }

    it('the repro: after an UNCERTAIN comment, "댓글 실행해도 돼?" / "댓글 실행하지 마" get the uncertain warning, never a resend', async () => {
      const h = await uncertainComment();
      const classifyBefore = h.classify.count;
      for (const text of ['댓글 실행해도 돼?', '댓글 실행하지 마']) {
        const reply = await h.send(text);
        expect(reply.reply.text, text).toBe(UNCERTAIN_COMMENT);
        expect(reply.reply.text, text).not.toContain('아무것도 보내거나 바꾸지 않았어요');
      }
      expect(UNCERTAIN_COMMENT).toContain('반영됐을 수도 있어요');
      expect(UNCERTAIN_COMMENT).toContain('다시 실행하지 않아요');
      expect(h.classify.count).toBe(classifyBefore);
      expect(h.writes.addComment).toHaveLength(1);
    });

    it('the same warning once the pointer is restored (the stray path), for the exact phrase too', async () => {
      const h = await uncertainComment({ priorActiveTaskId: 'task-prior' });
      expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
      for (const text of ['댓글 실행해도 돼?', '댓글 실행하지 마', '댓글 실행']) {
        expect((await h.send(text)).reply.text, text).toBe(UNCERTAIN_COMMENT);
      }
      expect(h.writes.addComment).toHaveLength(1);
    });

    it('a bare "실행" / "go" / "run it" after an UNCERTAIN write gets the uncertain warning, provider-free', async () => {
      for (const prior of [{}, { priorActiveTaskId: 'task-prior' }]) {
        const h = await uncertainComment(prior);
        const classifyBefore = h.classify.count;
        for (const text of ['실행', '실행해줘', 'go', 'run it']) {
          expect((await h.send(text)).reply.text, text).toBe(UNCERTAIN_COMMENT);
        }
        expect(h.classify.count).toBe(classifyBefore);
        expect(h.writes.addComment).toHaveLength(1);
      }
    });

    it('a receipt still PREPARED (dispatched, outcome unknown) is treated the same way', async () => {
      const h = await uncertainComment({ priorActiveTaskId: 'task-prior' });
      for (const [id, row] of h.receipts.rows) h.receipts.rows.set(id, { ...row, status: 'PREPARED' });
      expect((await h.send('댓글 실행해도 돼?')).reply.text).toBe(renderConnectorWriteRepeat('ISSUE_COMMENT', 'EXECUTING'));
      expect((await h.send('실행')).reply.text).toBe(renderConnectorWriteRepeat('ISSUE_COMMENT', 'EXECUTING'));
      expect(h.writes.addComment).toHaveLength(1);
    });

    it('precedence: approved elsewhere first; then the most recent write here; a definite NOT_SENT is named as not sent', async () => {
      const DM: ConversationContext = { platform: 'test', channelId: '900000000000000003', userId: 'owner-user' };
      const h = await uncertainComment();
      await h.sendIn(DM, 'PROJ-12에 댓글: 디엠');
      await h.sendIn(DM, '승인');
      expect((await h.send('댓글 실행해도 돼?')).reply.text).toContain('다른 대화에서 기다리고 있어요');

      // A later SENT comment in the same conversation is the most recent write: already sent (with its link).
      let outcome = connectorWriteUncertain('TRANSPORT') as ConnectorWriteOutcome;
      const swap = harness({
        priorActiveTaskId: 'task-prior',
        commentOutcome: async () => outcome,
      });
      await swap.send('PROJ-12에 댓글: 첫 번째');
      await swap.send('승인');
      await swap.send('댓글 실행');
      advanceMinutes(1);
      outcome = connectorWriteSent('10001', COMMENT_URL);
      await swap.send('PROJ-12에 댓글: 두 번째');
      await swap.send('승인');
      await swap.send('댓글 실행');
      expect((await swap.send('댓글 실행해도 돼?')).reply.text).toContain('이미 보냈어요');
      expect(swap.writes.addComment).toHaveLength(2);

      const notSent = harness({ priorActiveTaskId: 'task-prior', commentOutcome: async () => connectorWriteNotSent('FORBIDDEN') });
      await notSent.send('PROJ-12에 댓글: x');
      await notSent.send('승인');
      await notSent.send('댓글 실행');
      expect((await notSent.send('댓글 실행해도 돼?')).reply.text).toBe('가장 최근 Jira 댓글 요청(PROJ-12)은 실행했지만 보내지 못했어요. 그 요청으로는 아무것도 보내지 않았어요.\n필요하면 새로 요청해 주세요.');
      expect(notSent.writes.addComment).toHaveLength(1);
    });

    it('a2b8aed P2-1: the uncertain warning never expires (only "already sent" has the 30-minute window); other conversations never see it', async () => {
      const h = await uncertainComment({ priorActiveTaskId: 'task-prior' });
      for (const minutes of [29, 1, 120, 24 * 60]) {
        advanceMinutes(minutes);
        expect((await h.send('댓글 실행해도 돼?')).reply.text, `+${minutes}m`).toBe(UNCERTAIN_COMMENT);
        expect((await h.send('실행')).reply.text, `+${minutes}m`).toBe(UNCERTAIN_COMMENT);
      }
      expect(h.writes.addComment).toHaveLength(1);
      const other = await uncertainComment();
      const DM: ConversationContext = { platform: 'test', channelId: '900000000000000003', userId: 'owner-user' };
      expect((await other.sendIn(DM, '댓글 실행해도 돼?')).reply.text).toBe(renderNoApprovedConnectorWrite());
    });

    it('a2b8aed P2-1: only a LATER SENT write of that kind supersedes it (a later NOT_SENT is named and the older one still warned about)', async () => {
      let outcome: ConnectorWriteOutcome = connectorWriteUncertain('TRANSPORT');
      const h = harness({ priorActiveTaskId: 'task-prior', commentOutcome: async () => outcome });
      await h.send('PROJ-12에 댓글: 첫 번째');
      await h.send('승인');
      await h.send('댓글 실행');
      advanceMinutes(1);
      outcome = connectorWriteNotSent('FORBIDDEN');
      await h.send('PROJ-12에 댓글: 두 번째');
      await h.send('승인');
      await h.send('댓글 실행');
      expect((await h.send('댓글 실행해도 돼?')).reply.text).toBe(LATEST_NOT_SENT_WITH_OLDER_UNCERTAIN);
      advanceMinutes(1);
      outcome = connectorWriteSent('10001', COMMENT_URL);
      await h.send('PROJ-12에 댓글: 세 번째');
      await h.send('승인');
      await h.send('댓글 실행');
      expect((await h.send('댓글 실행해도 돼?')).reply.text).toContain('이미 보냈어요');
      advanceMinutes(45);
      expect((await h.send('댓글 실행해도 돼?')).reply.text).toBe(renderNoApprovedConnectorWrite());
      expect(h.writes.addComment).toHaveLength(3);
    });

    it('a2b8aed P2-2: after an UNCERTAIN comment A, replies about a new comment B speak only about B — never "nothing was sent"', async () => {
      let outcome: ConnectorWriteOutcome = connectorWriteUncertain('TRANSPORT');
      const h = harness({ commentOutcome: async () => outcome });
      await h.send('PROJ-12에 댓글: A');
      await h.send('승인');
      await h.send('댓글 실행');
      outcome = connectorWriteSent('10002', COMMENT_URL);
      const unscoped = /(?<!이 요청으로는 (?:아직 )?)아무것도 보내지 않았어요|아무것도 보내거나 바꾸지 않았어요/u;

      const preview = await h.send('PROJ-13에 댓글: B');
      expect(preview.reply.text).toContain('Jira 댓글 미리보기예요. 이 요청으로는 아직 아무것도 보내지 않았어요.');
      expect(preview.reply.text).not.toMatch(unscoped);
      const pending = await h.send('댓글 실행해도 돼?');
      expect(pending.reply.text).toContain('Jira 댓글 승인을 기다리고 있어요. 이 요청으로는 아직 아무것도 보내지 않았어요.');
      expect(pending.reply.text).not.toMatch(unscoped);
      await h.send('승인');
      const reminder = renderConnectorWriteApprovedReminder('ISSUE_COMMENT', '댓글 실행', { kind: 'issue', issueKey: 'PROJ-13' });
      expect(reminder).toBe('승인된 Jira 댓글(PROJ-13)은 아직 실행하지 않았어요. 실제로 보내려면 "댓글 실행"이라고만 보내 주세요.');
      for (const text of ['댓글 실행해도 돼?', '댓글 실행하지 마']) {
        const reply = await h.send(text);
        expect(reply.reply.text, text).toBe(reminder);
        expect(reply.reply.text, text).not.toMatch(unscoped);
      }
      expect((await h.send('실행')).reply.text).toBe(
        '승인된 Jira 댓글(PROJ-13)은 아직 실행하지 않았어요. 실행할 작업을 정확히 말해 주세요: "댓글 실행"',
      );
      expect(h.writes.addComment).toHaveLength(1);
      const denied = await h.send('거절');
      expect(denied.reply.text).toBe('요청을 거절했어요. 이 요청으로는 아무것도 보내지 않았어요.');
      // B is closed; A is still the most recent dispatched write of that kind and stays unresolved.
      expect((await h.send('댓글 실행해도 돼?')).reply.text).toBe(LATEST_B_DENIED_WITH_OLDER_UNCERTAIN);
      expect(h.writes.addComment).toHaveLength(1);
    });
  });
});

describe('connector writes — live QA session 3 (D1, D12)', () => {
  const LATEST_POST_DENIED = [
    '가장 최근 Slack 게시 요청(#dev)은 거절돼서 실행하지 않았어요. 그 요청으로는 아무것도 보내지 않았어요.',
    '필요하면 새로 요청해 주세요.',
  ].join('\n');

  it.each([{}, { priorActiveTaskId: 'task-prior' }])(
    'D1: post X sent, then Y previewed and rejected → "Slack 게시 실행" names Y as rejected, never X as "already sent" (%j)',
    async (opts) => {
      const h = harness(opts);
      await h.send('#dev에 게시: X');
      await h.send('승인');
      await h.send('Slack 게시 실행');
      expect(h.writes.post).toHaveLength(1);
      advanceMinutes(1);
      await h.send('#dev에 게시: Y');
      advanceMinutes(1);
      expect((await h.send('거절')).reply.text).toBe('요청을 거절했어요. 이 요청으로는 아무것도 보내지 않았어요.');
      for (const text of ['Slack 게시 실행', 'Slack 게시 실행해도 돼?']) {
        const reply = await h.send(text);
        expect(reply.reply.text, text).toBe(LATEST_POST_DENIED);
        expect(reply.reply.text, text).not.toContain('이미 보냈어요');
        expect(reply.reply.text, text).not.toContain('이미 실행했어요');
      }
      expect(h.writes.post).toHaveLength(1);
      // A newer send answers "already sent" again (it is the latest request).
      advanceMinutes(1);
      await h.send('#dev에 게시: Z');
      await h.send('승인');
      await h.send('Slack 게시 실행');
      expect(h.writes.post).toHaveLength(2);
      expect((await h.send('Slack 게시 실행')).reply.text).toMatch(/이미 (?:보냈어요|실행했어요)/);
      expect(h.writes.post).toHaveLength(2);
    },
  );

  it('D1: the same after an ops-UI rejection and after an approved-then-cancelled request (the reason is named)', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('#dev에 게시: X');
    await h.send('승인');
    await h.send('Slack 게시 실행');
    advanceMinutes(1);
    h.runtime.approvalDecisions.setConfirmationReferenceEnabled(true);
    await h.send('#dev에 게시: Y');
    const pending = [...h.approvals.values()].find((a) => a.status === ApprovalStatus.PENDING)!;
    const decided = await h.runtime.approvalDecisions.decideFromOpsUi({
      approvalId: pending.id, decision: 'reject', actor: OWNER, sessions: async () => [...h.sessions.values()],
    });
    expect(decided).toMatchObject({ status: 'DECIDED', outcome: 'REJECTED' });
    h.runtime.approvalDecisions.setConfirmationReferenceEnabled(false);
    advanceMinutes(1);
    expect((await h.send('Slack 게시 실행')).reply.text).toBe(LATEST_POST_DENIED);

    advanceMinutes(1);
    await h.send('#dev에 게시: W');
    await h.send('승인');
    advanceMinutes(1);
    await h.send('취소');
    expect((await h.send('Slack 게시 실행')).reply.text).toContain('가장 최근 Slack 게시 요청(#dev)은 취소돼서 실행하지 않았어요.');
    expect(h.writes.post).toHaveLength(1);
  });

  it('D1: a rejected request of ANOTHER kind does not hide this kind\'s recent send', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('PROJ-12에 댓글: 한 번만');
    await h.send('승인');
    await h.send('댓글 실행');
    advanceMinutes(1);
    await h.send('#dev에 게시: Y');
    await h.send('거절');
    expect((await h.send('댓글 실행')).reply.text).toContain('이미 보냈어요 (10:00, Jira PROJ-12)');
  });

  it('D12: a post-approval 거절 records the approval REJECTED (withdrawn) with the closed anchor; nothing can run; the ops UI no longer offers it', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 철회 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    expect(approval?.status).toBe(ApprovalStatus.APPROVED);
    const anchorTaskId = h.sessions.get('sess-1')?.activeTaskId as string;
    advanceMinutes(1);
    const denied = await h.send('거절');
    expect(denied.status).toBe('DENIED');
    expect(denied.reply.text).toBe('요청을 거절했어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect(anchorOf(h.tasks.get(anchorTaskId))).toMatchObject({ status: 'CLOSED', closedReason: 'denied' });
    const revoked = h.approvals.get(approval!.id);
    expect(revoked).toMatchObject({
      status: ApprovalStatus.REJECTED,
      decision: false,
      decidedBy: OWNER.id,
      comment: 'revoked-before-execution',
    });
    expect((await h.send('댓글 실행')).reply.text).toBe('가장 최근 Jira 댓글 요청(PROJ-12)은 거절돼서 실행하지 않았어요. 그 요청으로는 아무것도 보내지 않았어요.\n필요하면 새로 요청해 주세요.');
    expect(h.totalWrites()).toBe(0);
    const located = await h.runtime.approvalDecisions.locateForOpsUi(approval!.id, OWNER, async () => [...h.sessions.values()]);
    expect(located).toEqual({ status: 'REFUSED', refusal: 'NOT_FOUND' });
    // Live QA session 4 (N1): the withdrawal is logged once, like the approve decision before it.
    expect(h.logLines.filter((line) => line.message === 'approval decided')).toEqual([
      {
        message: 'approval decided',
        fields: { approvalId: approval!.id, surface: 'chat', kind: 'CONNECTOR_WRITE', outcome: 'REVOKED' },
      },
    ]);
  });

  it('D12: 취소 withdraws it the same way; another actor\'s 거절 changes neither the anchor nor the approval', async () => {
    const h = harness();
    await h.send('#dev에 게시: 취소 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    h.setActor(OTHER);
    await h.send('거절');
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.APPROVED);
    h.setActor(OWNER);
    const cancelled = await h.send('취소');
    expect(cancelled.status).toBe('CANCELLED');
    expect(h.approvals.get(approval!.id)).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'revoked-before-execution' });
    expect(h.totalWrites()).toBe(0);
  });

  it('D12: after the write ran, 거절 neither revokes nor changes the recorded approval', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 이미 보냄');
    await h.send('승인');
    await h.send('댓글 실행');
    const [approval] = [...h.approvals.values()];
    await h.send('거절');
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.APPROVED);
    expect(h.writes.addComment).toHaveLength(1);
    expect(h.logLines.some((line) => line.fields?.outcome === 'REVOKED')).toBe(false);
  });
});

describe('connector writes — Codex re-review of 050fa47 + 55c5a2f (P1 execute/revoke race, P2 latest request, P3 expiry)', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('P1 (execution wins): a 취소 that read APPROVED before the send started cannot withdraw it and never says nothing was sent', async () => {
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((r) => (releaseWriter = r));
    const h = harness({ commentOutcome: async () => { await writerGate; return connectorWriteSent('10001', COMMENT_URL); } });
    await h.send('PROJ-12에 댓글: 경쟁 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    const cancelPause = h.pauseTurn('취소');
    const cancelTurn = h.send('취소');
    await cancelPause.reached; // the cancel turn has read the APPROVED anchor
    const executeTurn = h.send('댓글 실행');
    await vi.waitFor(() => expect(h.writes.addComment).toHaveLength(1)); // claimed and dispatched
    cancelPause.release();
    const cancel = await cancelTurn;
    expect(cancel.reply.text).toBe(renderConnectorWriteRevokeTooLate('ISSUE_COMMENT'));
    expect(cancel.reply.text).not.toContain('보내지 않았어요');
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.APPROVED);
    releaseWriter();
    const executed = await executeTurn;
    expect(executed.reply.text).toContain('댓글을 달았어요');
    expect(h.writes.addComment).toHaveLength(1);
    expect([...h.receipts.rows.values()].map((r) => r.status)).toEqual(['SENT']);
  });

  it('P1 (revocation wins): an execution that read APPROVED before the 취소 is refused truthfully; the writer is never called', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 경쟁 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    const executePause = h.pauseTurn('댓글 실행');
    const executeTurn = h.send('댓글 실행');
    await executePause.reached; // the execution turn has read the APPROVED anchor
    const cancel = await h.send('취소');
    expect(cancel.reply.text).toBe('요청을 취소했어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect(h.approvals.get(approval!.id)).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'revoked-before-execution' });
    executePause.release();
    const executed = await executeTurn;
    expect(executed.reply.text).toBe('실행하기 전에 이 요청이 거절(취소)돼서 실행하지 않았어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect(h.writes.addComment).toHaveLength(0);
    expect(h.receipts.rows.size).toBe(0);
  });

  it('P1 (lock contention): an execution arriving while the revocation holds the locks waits, then names the cancelled request', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 경쟁 테스트');
    await h.send('승인');
    let releaseRevoke!: () => void;
    let revoking!: () => void;
    const revokeReached = new Promise<void>((r) => (revoking = r));
    const revokeGate = new Promise<void>((r) => (releaseRevoke = r));
    h.hooks.beforeRevoke = async () => { revoking(); await revokeGate; };
    const cancelTurn = h.send('취소');
    await revokeReached;
    const executeTurn = h.send('댓글 실행');
    await settle();
    expect(h.writes.addComment).toHaveLength(0);
    releaseRevoke();
    expect((await cancelTurn).reply.text).toBe('요청을 취소했어요. 이 요청으로는 아무것도 보내지 않았어요.');
    const executed = await executeTurn;
    expect(executed.reply.text).toContain('가장 최근 Jira 댓글 요청(PROJ-12)은 취소돼서 실행하지 않았어요.');
    expect(h.writes.addComment).toHaveLength(0);
  });

  it('P1 (Codex repro): the revocation pauses inside its locks after reading APPROVED while the execution resumes — the execution waits for the locks and is refused; nothing is sent', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 경쟁 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    const executePause = h.pauseTurn('댓글 실행');
    const executeTurn = h.send('댓글 실행');
    await executePause.reached; // past its session reads, holding no lock, anchor seen APPROVED
    let releaseRevoke!: () => void;
    let revoking!: () => void;
    const revokeReached = new Promise<void>((r) => (revoking = r));
    const revokeGate = new Promise<void>((r) => (releaseRevoke = r));
    h.hooks.beforeRevoke = async () => { revoking(); await revokeGate; };
    const cancelTurn = h.send('취소');
    await revokeReached; // the revocation read the APPROVED, unconsumed grant and holds approval → session locks
    executePause.release();
    await settle();
    await settle();
    expect(h.writes.addComment).toHaveLength(0); // the claim is blocked behind the revocation
    releaseRevoke();
    expect((await cancelTurn).reply.text).toBe('요청을 취소했어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect((await executeTurn).reply.text).toBe('실행하기 전에 이 요청이 거절(취소)돼서 실행하지 않았어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.REJECTED);
    expect(h.writes.addComment).toHaveLength(0);
    expect(h.receipts.rows.size).toBe(0);
  });

  it('P1: 거절 while the write is executing (anchor already EXECUTING) says it started; never "nothing sent"', async () => {
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((r) => (releaseWriter = r));
    const h = harness({ commentOutcome: async () => { await writerGate; return connectorWriteSent('10001', COMMENT_URL); } });
    await h.send('PROJ-12에 댓글: 실행 중');
    await h.send('승인');
    const executeTurn = h.send('댓글 실행');
    await vi.waitFor(() => expect(h.writes.addComment).toHaveLength(1));
    expect((await h.send('거절')).reply.text).toBe(renderConnectorWriteRevokeTooLate('ISSUE_COMMENT'));
    releaseWriter();
    expect((await executeTurn).reply.text).toContain('댓글을 달았어요');
  });

  it('P2: X SENT → Y rejected → Z approved and NOT_SENT — the latest request (Z) is described, not Y', async () => {
    let outcome: ConnectorWriteOutcome = connectorWriteSent('10001', COMMENT_URL);
    const h = harness({ priorActiveTaskId: 'task-prior', commentOutcome: async () => outcome });
    await h.send('PROJ-12에 댓글: X');
    await h.send('승인');
    await h.send('댓글 실행');
    advanceMinutes(1);
    await h.send('PROJ-13에 댓글: Y');
    await h.send('거절');
    advanceMinutes(1);
    outcome = connectorWriteNotSent('FORBIDDEN');
    await h.send('PROJ-14에 댓글: Z');
    await h.send('승인');
    await h.send('댓글 실행');
    for (const text of ['댓글 실행해도 돼?', '댓글 실행']) {
      const reply = await h.send(text);
      expect(reply.reply.text, text).toBe(
        '가장 최근 Jira 댓글 요청(PROJ-14)은 실행했지만 보내지 못했어요. 그 요청으로는 아무것도 보내지 않았어요.\n필요하면 새로 요청해 주세요.',
      );
      expect(reply.reply.text, text).not.toContain('PROJ-13');
    }
    expect(h.writes.addComment).toHaveLength(2);
  });

  it('P3: X SENT, then Y approved and left to expire past X\'s lifetime — the phrase still names Y as expired', async () => {
    const h = harness({ priorActiveTaskId: 'task-prior' });
    await h.send('#dev에 게시: X');
    await h.send('승인');
    await h.send('Slack 게시 실행');
    advanceMinutes(1);
    await h.send('#dev에 게시: Y');
    await h.send('승인');
    advanceMinutes(31);
    // The turn that releases the lapsed grant answers its own phrase with the expiry refusal …
    expect((await h.send('Slack 게시 실행')).reply.text).toContain('승인한 지 30분이 지나 승인이 만료됐어요.');
    // … and every later phrase names that latest request, though X's send is now older than its lifetime.
    for (const text of ['Slack 게시 실행', 'Slack 게시 실행해도 돼?']) {
      expect((await h.send(text)).reply.text, text).toBe(
        '가장 최근 Slack 게시 요청(#dev)은 승인 시간이 지나 만료돼서 실행하지 않았어요. 그 요청으로는 아무것도 보내지 않았어요.\n필요하면 새로 요청해 주세요.',
      );
    }
    expect(h.writes.post).toHaveLength(1);
  });
});

describe('connector writes — the operations-UI lookups are read-only (Codex P1 on the QA3 fixes, ADR-0113 D4)', () => {
  it('a snapshot / confirmation-page lookup paused between the approval decision and recordApproval changes nothing', async () => {
    const h = harness();
    await h.send('#dev에 "오늘 배포는 18시"라고 올려줘');
    const anchorId = h.sessions.get('sess-1')?.activeTaskId;
    const [approval] = [...h.approvals.values()];
    const sessions = async () => [...h.sessions.values()];

    // Pause the chat "승인" right after the approval became APPROVED and before the anchor records it.
    const recordApproval = h.flow.recordApproval.bind(h.flow);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    h.flow.recordApproval = async (input) => {
      paused = true;
      await gate;
      return recordApproval(input);
    };
    const approving = h.send('승인');
    await vi.waitFor(() => expect(paused).toBe(true));
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.APPROVED);

    // The dashboard list and the confirmation page look the conversation up meanwhile.
    const kinds = await h.runtime.approvalDecisions.pendingGateKindsForOpsUi(sessions);
    expect(kinds.size).toBe(0); // approved mid-transition: nothing pending, and nothing reconciled
    const located = await h.runtime.approvalDecisions.locateForOpsUi(approval!.id, OWNER, sessions);
    expect(located).toEqual({ status: 'REFUSED', refusal: 'NOT_FOUND' });
    // Nothing was closed or released.
    expect(h.sessions.get('sess-1')?.activeTaskId).toBe(anchorId);
    expect((h.tasks.get(anchorId!)?.metadata?.connectorWriteAnchor as { status: string }).status).toBe('APPROVAL_PENDING');

    release();
    const approved = await approving;
    expect(approved.reply.text).toContain('"Slack 게시 실행"');
    const sent = await h.send('Slack 게시 실행');
    expect(h.writes.post).toEqual([{ channel: 'C0DEV', text: '오늘 배포는 18시' }]);
    expect(sent.reply.text).toContain('메시지를 게시했어요');
  });

  it('a pending connector write is listed and located with its kind, read-only', async () => {
    const h = harness();
    await h.send('#dev에 "오늘 배포는 18시"라고 올려줘');
    const [approval] = [...h.approvals.values()];
    const sessions = async () => [...h.sessions.values()];
    const before = JSON.stringify([...h.tasks.values()]) + JSON.stringify([...h.sessions.values()]);
    expect([...(await h.runtime.approvalDecisions.pendingGateKindsForOpsUi(sessions))]).toEqual([[approval!.id, 'CONNECTOR_WRITE']]);
    expect(await h.runtime.approvalDecisions.locateForOpsUi(approval!.id, OWNER, sessions)).toMatchObject({
      status: 'FOUND',
      view: { kind: 'CONNECTOR_WRITE', approvable: true },
    });
    expect(JSON.stringify([...h.tasks.values()]) + JSON.stringify([...h.sessions.values()])).toBe(before);
  });
});

describe('connector writes — live QA session 4 (N2): stop words at a pending choice or request', () => {
  const CHOICE_CLOSED = '일정 선택을 취소했어요. 이 요청으로는 캘린더를 바꾸지 않았어요.';

  it.each(['그만', '그만해', '아니', '아니요', '됐어', '됐어요', '취소', 'cancel', 'stop', '이제 그만', 'never mind'])(
    'at a numbered calendar choice "%s" closes it deterministically: fixed reply, no chat, no reset, nothing written',
    async (text) => {
      const h = harness({ events: [WEEKLY, ONE_ON_ONE], priorActiveTaskId: 'task-prior' });
      await h.send('내일 3시 회의 취소해줘');
      const choiceTaskId = h.sessions.get('sess-1')?.activeTaskId as string;
      expect(anchorOf(h.tasks.get(choiceTaskId))?.status).toBe('AWAITING_CHOICE');
      const classifyBefore = h.classify.count;
      const result = await h.send(text);
      expect(result.reply.text).toBe(CHOICE_CLOSED);
      expect(h.classify.count).toBe(classifyBefore); // never a chat turn
      expect(anchorOf(h.tasks.get(choiceTaskId))).toMatchObject({ status: 'CLOSED', closedReason: 'abandoned' });
      // The conversation goes on: the session is not reset and the earlier chain is restored.
      expect(h.sessions.get('sess-1')?.status).toBe(SessionStatus.ACTIVE);
      expect(h.sessions.get('sess-1')?.activeTaskId).toBe('task-prior');
      expect(result.reply.text).not.toContain('새 대화');
      expect(h.approvals.size).toBe(0);
      expect(h.totalWrites()).toBe(0);
    },
  );

  it.each(['그만하지 마', '그만 다른 일정 보여줘', '아니 3시 말고 4시', '됐어?'])(
    'at a choice "%s" is not a stop word: the choice is abandoned and the message is an ordinary turn',
    async (text) => {
      const h = harness({ events: [WEEKLY, ONE_ON_ONE] });
      await h.send('내일 3시 회의 취소해줘');
      const result = await h.send(text);
      expect(result.reply.text).not.toBe(CHOICE_CLOSED);
      expect(h.totalWrites()).toBe(0);
    },
  );

  it('a pending connector-write request: "됐어" cancels it like "취소" (nothing sent, no chat)', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 됐어 테스트');
    const [approval] = [...h.approvals.values()];
    const classifyBefore = h.classify.count;
    const result = await h.send('됐어');
    expect(result.status).toBe('CANCELLED');
    expect(result.reply.text).toBe('요청을 취소했어요. 이 요청으로는 아무것도 보내지 않았어요.');
    expect(h.classify.count).toBe(classifyBefore);
    expect(h.approvals.get(approval!.id)?.status).not.toBe(ApprovalStatus.APPROVED);
    expect(h.totalWrites()).toBe(0);
  });

  it('an approved, unexecuted write: "그만" withdraws it (approval REJECTED, logged REVOKED); the exact phrase then runs nothing', async () => {
    const h = harness();
    await h.send('#dev에 게시: 그만 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    const result = await h.send('그만');
    expect(result.status).toBe('CANCELLED');
    expect(h.approvals.get(approval!.id)).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'revoked-before-execution' });
    expect(h.logLines.filter((line) => line.fields?.outcome === 'REVOKED')).toHaveLength(1);
    await h.send('Slack 게시 실행');
    expect(h.totalWrites()).toBe(0);
  });

  it('with nothing pending "그만" stays ordinary chat (and never resets the conversation)', async () => {
    const h = harness();
    const classifyBefore = h.classify.count;
    await h.send('그만');
    expect(h.classify.count).toBe(classifyBefore + 1);
    expect(h.sessions.get('sess-1')?.status).toBe(SessionStatus.ACTIVE);
  });
});

describe('connector writes — Codex P2 on b571e4d: the wider stop words take the late-revocation path in every state', () => {
  const NOTHING_TO_DECIDE =
    '지금 승인하거나 거절할 작업이 없어요. 기다리던 승인 요청은 처리됐거나 만료됐을 수 있어요. 새로 요청하려면 원하는 작업을 말해 주세요.';

  it.each(['됐어', '아니', '그만'])('execution wins: "%s" that read APPROVED before the send started gets "already started", never chat', async (word) => {
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((r) => (releaseWriter = r));
    const h = harness({ commentOutcome: async () => { await writerGate; return connectorWriteSent('10001', COMMENT_URL); } });
    await h.send('PROJ-12에 댓글: 경쟁 테스트');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    const pause = h.pauseTurn(word);
    const stopTurn = h.send(word);
    await pause.reached; // the stop turn has read the APPROVED anchor
    const executeTurn = h.send('댓글 실행');
    await vi.waitFor(() => expect(h.writes.addComment).toHaveLength(1));
    pause.release();
    const classifyBefore = h.classify.count;
    expect((await stopTurn).reply.text).toBe(renderConnectorWriteRevokeTooLate('ISSUE_COMMENT'));
    expect(h.classify.count).toBe(classifyBefore);
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.APPROVED);
    releaseWriter();
    expect((await executeTurn).reply.text).toContain('댓글을 달았어요');
    expect(h.writes.addComment).toHaveLength(1);
  });

  it.each(['됐어', '아니', '그만', 'stop'])('while the write is EXECUTING, "%s" gets "already started" like 취소', async (word) => {
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((r) => (releaseWriter = r));
    const h = harness({ commentOutcome: async () => { await writerGate; return connectorWriteSent('10001', COMMENT_URL); } });
    await h.send('PROJ-12에 댓글: 실행 중');
    await h.send('승인');
    const executeTurn = h.send('댓글 실행');
    await vi.waitFor(() => expect(h.writes.addComment).toHaveLength(1)); // the anchor is EXECUTING
    const classifyBefore = h.classify.count;
    const reply = await h.send(word);
    expect(reply.reply.text).toBe(renderConnectorWriteRevokeTooLate('ISSUE_COMMENT'));
    expect(h.classify.count).toBe(classifyBefore);
    releaseWriter();
    await executeTurn;
    expect(h.writes.addComment).toHaveLength(1);
  });

  it.each(['취소', '그만', '됐어', '아니'])('after the write finished, "%s" gets the deterministic "nothing to decide", never chat', async (word) => {
    const h = harness();
    await h.send('PROJ-12에 댓글: 끝남');
    await h.send('승인');
    await h.send('댓글 실행');
    const classifyBefore = h.classify.count;
    expect((await h.send(word)).reply.text).toBe(NOTHING_TO_DECIDE);
    expect(h.classify.count).toBe(classifyBefore);
    expect(h.writes.addComment).toHaveLength(1);
  });
});

describe('connector writes — a pending request is rejected only by a whole-message deny (Codex P2 on b571e4d)', () => {
  it('"아니 이건 내 친구 얘기야" leaves the request pending (re-prompted, nothing closed or sent); a bare "아니요" then rejects it', async () => {
    const h = harness();
    await h.send('#dev에 게시: 친구 얘기');
    const [approval] = [...h.approvals.values()];
    const anchorTaskId = h.sessions.get('sess-1')?.activeTaskId as string;
    const other = await h.send('아니 이건 내 친구 얘기야');
    expect(other.status).toBe('AWAITING_APPROVAL');
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.PENDING);
    expect(anchorOf(h.tasks.get(anchorTaskId))?.status).toBe('APPROVAL_PENDING');
    const denied = await h.send('아니요');
    expect(denied.status).toBe('DENIED');
    expect(h.approvals.get(approval!.id)?.status).toBe(ApprovalStatus.REJECTED);
    expect(h.totalWrites()).toBe(0);
  });
});

describe('connector writes — bare execution questions and prohibitions with a grant (Codex P2 on 5594c16)', () => {
  it('"실행해도 돼?" / "실행할까?" get the exact-phrase hint while the grant waits; nothing runs, the grant stays', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: hello');
    await h.send('승인');
    const hint = renderConnectorWriteBareExecution('ISSUE_COMMENT', '댓글 실행', { kind: 'issue', issueKey: 'PROJ-12' });
    for (const text of ['실행해도 돼?', '실행할까?', '지금 실행해도 될까', '실행 안 해도 돼']) {
      const reply = await h.send(text);
      expect(reply.reply.text, text).toBe(hint);
      expect(reply.reply.text, text).not.toContain('승인된 작업이 없어요');
    }
    expect(anchorOf(h.anchorTask())?.status).toBe('APPROVED');
    expect(h.totalWrites()).toBe(0);
    expect((await h.send('댓글 실행')).reply.text).toContain('댓글을 달았어요');
    expect(h.writes.addComment).toEqual([{ issueKey: 'PROJ-12', text: 'hello' }]);
  });

  it('"실행하지 마" withdraws the grant through the revoke path (a cancel); the phrase afterwards runs nothing', async () => {
    const h = harness();
    await h.send('PROJ-12에 댓글: hello');
    await h.send('승인');
    const [approval] = [...h.approvals.values()];
    const anchorTaskId = h.sessions.get('sess-1')?.activeTaskId as string;
    const withdrawn = await h.send('실행하지 마');
    expect(withdrawn.reply.text).not.toContain('승인된 작업이 없어요');
    expect(anchorOf(h.tasks.get(anchorTaskId))).toMatchObject({ status: 'CLOSED', closedReason: 'cancelled' });
    expect(h.approvals.get(approval!.id)).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'revoked-before-execution' });
    expect((await h.send('댓글 실행')).reply.text).not.toContain('댓글을 달았어요');
    expect(h.totalWrites()).toBe(0);
  });

  it('another actor’s "실행하지 마" cannot withdraw the owner’s grant (hint only)', async () => {
    const h = harness();
    await h.send('#dev에 게시: 배포 시작');
    await h.send('승인');
    h.setActor(OTHER);
    const hint = (await h.send('실행하지 마')).reply.text;
    expect(hint).toContain('아직 실행하지 않았어요');
    expect(hint).toContain('"Slack 게시 실행"');
    expect(anchorOf(h.anchorTask())?.status).toBe('APPROVED');
    h.setActor(OWNER);
    expect((await h.send('Slack 게시 실행')).reply.text).toContain('Slack 게시 완료');
  });

  it('a grant waiting in another conversation is named; only with nothing approved anywhere is it "nothing approved"', async () => {
    const GUILD: ConversationContext = { platform: 'test', spaceId: '900000000000000001', channelId: '900000000000000002', userId: 'owner-user' };
    const DM: ConversationContext = { platform: 'test', channelId: '900000000000000003', userId: 'owner-user' };
    const h = harness();
    await h.sendIn(DM, 'PROJ-12에 댓글: 디엠에서 승인');
    await h.sendIn(DM, '승인');
    for (const text of ['실행해도 돼?', '실행하지 마']) {
      const reply = await h.sendIn(GUILD, text);
      expect(reply.reply.text, text).toContain('다른 대화에서 기다리고 있어요');
      expect(reply.reply.text, text).not.toContain('승인된 작업이 없어요');
    }
    expect(h.totalWrites()).toBe(0);

    const empty = harness();
    expect((await empty.send('실행해도 돼?')).reply.text).toContain('이 대화에는 지금 실행할 승인된 작업이 없어요');
  });
});
