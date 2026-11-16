import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SessionStatus } from '../../domain';
import type { Actor, ApprovalRequest, Session, Task } from '../../domain';
import {
  connectorWriteNotSent,
  connectorWriteSent,
  type ConnectorWriteOutcome,
  type IssueCommentDeleteRequest,
  type IssueCommentState,
  type IssueCommentWriter,
  type IssueTransitionOption,
  type IssueTransitionRequest,
  type IssueTransitionWriter,
} from '../../ports/connector-write.port';
import type { ConnectorWriteMatch, ConnectorWritePrepareResult, ConnectorWriteReceipt, ConnectorWriteReceiptRepository } from '../../ports/connector-write-receipt.port';
import { ConnectorQueryError } from '../../ports/connector-query';
import { isAcceptedExecutionPhrase } from '../execution-command-guard';
import { LAST_ACTION_METADATA_KEY, externalUndoFamilyOf, isExternalUndoOpen, setExternalUndoCapabilitiesForTest, withLastAction, type LastActionRecord } from '../nl-routing/last-action';
import { plainTextOf } from '../message-rendering';
import { CONNECTOR_UNDO_RECEIPT_BANNER, renderConnectorWriteStep } from './connector-write-copy';
import type { ExternalUndoDraftKind } from './connector-write-draft';
import { StatelessConnectorWriteFlow, isActionSwitchGoverned, type ConnectorWriteStep } from './connector-write-flow';

// ADR-0112 amendment 3 (O4, O5, O7): the delete of the Jira comment Quoky added and the revert of Quoky's own Jira transition,
// through the real flow. Storage, approvals, receipts and the two Jira writers are in-memory fakes (compare-and-set like the
// adapter); the runtime's `recordExternalWrite` is emulated by writing the same `lastAction` record.

const T0 = '2026-11-16T01:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
const OTHER: Actor = { id: 'other', displayName: 'Other', identities: [], createdAt: T0 };
const KEY = 'RT-7';
const STATUS: Readonly<Record<string, string>> = { '1': '할 일', '3': '진행 중', '5': '완료', '7': '보류' };
const option = (id: string, name: string, to: string): IssueTransitionOption => ({ id, name, toStatus: STATUS[to] as string, toStatusId: to });

class MemoryReceipts implements ConnectorWriteReceiptRepository {
  readonly rows = new Map<string, ConnectorWriteReceipt>();
  async prepare(receipt: ConnectorWriteReceipt): Promise<ConnectorWritePrepareResult> {
    const existing = [...this.rows.values()].find((row) => row.idempotencyKey === receipt.idempotencyKey);
    if (existing) return { created: false, receipt: existing };
    this.rows.set(receipt.id, { ...receipt });
    return { created: true, receipt };
  }
  async complete(id: string, outcome: ConnectorWriteOutcome, now: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'PREPARED') return null;
    const data = outcome.status === 'SENT' ? { externalRef: outcome.externalRef, ...(outcome.version !== undefined ? { version: outcome.version } : {}) } : { reason: outcome.reason };
    const next = { ...row, status: outcome.status, updatedAt: now, data };
    this.rows.set(id, next);
    return next;
  }
  async findByIdempotencyKey(key: string): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].find((row) => row.idempotencyKey === key) ?? null;
  }
  async findById(id: string, actorId: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.rows.get(id);
    return row !== undefined && row.actorId === actorId ? row : null;
  }
  async findLatestSent(match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].filter((row) => row.status === 'SENT' && row.actorId === match.actorId && row.operation === match.operation && row.target === match.target && row.payloadSha256 === match.payloadSha256).pop() ?? null;
  }
  async findLatestUnresolved(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async findLatestForOperation(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async markInterruptedPreparedUncertain(): Promise<number> {
    return 0;
  }
}

interface JiraComment {
  id: string;
  issueKey: string;
  created: string;
  updated: string;
}

interface HarnessOptions {
  /** The comment writer reports no version for a new comment (a legacy receipt, or a provider that gives none). */
  readonly noCommentVersion?: boolean;
  /** The credentials may not delete the comment (read-only permission answer). */
  readonly noDeletePermission?: boolean;
  /** The comment writer has no inspect / delete (an older adapter). */
  readonly noCommentDelete?: boolean;
  /** The transition writer cannot read the status (a transition then records no `fromStatusId`). */
  readonly noStatusRead?: boolean;
  /** The transitions available per status (the workflow). */
  readonly workflow?: Readonly<Record<string, readonly IssueTransitionOption[]>>;
}

const DEFAULT_WORKFLOW: Readonly<Record<string, readonly IssueTransitionOption[]>> = {
  '1': [option('11', '시작', '3'), option('51', '바로 완료', '5')],
  '3': [option('21', '멈춤', '1'), option('31', '끝내기', '5')],
  '5': [option('41', '다시 열기', '1')],
};

function harness(options: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const approvals = new Map<string, ApprovalRequest>();
  const receipts = new MemoryReceipts();
  const context = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
  for (const id of ['sess-1', 'sess-2']) sessions.set(id, { id, actorId: OWNER.id, context, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0 });
  const jira = { status: '1', comments: [] as JiraComment[], workflow: options.workflow ?? DEFAULT_WORKFLOW, moved: false, failReads: false };
  const writes = { add: 0, delete: [] as IssueCommentDeleteRequest[], transition: [] as IssueTransitionRequest[] };
  const reads = { inspect: [] as string[], status: 0, list: 0 };
  let commentSeq = 10000;
  let stamp = 0;
  const nextStamp = (): string => `2026-11-16T10:00:${String((stamp += 1)).padStart(2, '0')}.000+0900`;

  const comments: IssueCommentWriter = {
    source: 'jira',
    allowsIssue: (key) => /^RT-\d+$/.test(key),
    async addComment(request) {
      writes.add += 1;
      const created = nextStamp();
      const comment = { id: String((commentSeq += 1)), issueKey: request.issueKey, created, updated: created };
      jira.comments.push(comment);
      return connectorWriteSent(comment.id, undefined, options.noCommentVersion === true ? undefined : comment.updated);
    },
    ...(options.noCommentDelete === true
      ? {}
      : {
          async inspectComment(issueKey: string, commentId: string): Promise<IssueCommentState> {
            reads.inspect.push(commentId);
            if (jira.failReads) throw new ConnectorQueryError('UNAVAILABLE', 'test read failure');
            if (jira.moved) return { kind: 'moved' };
            const comment = jira.comments.find((candidate) => candidate.id === commentId && candidate.issueKey === issueKey);
            if (comment === undefined) return { kind: 'absent' };
            return { kind: 'present', commentId, version: comment.updated, unedited: comment.updated === comment.created, deletable: options.noDeletePermission !== true };
          },
          async deleteComment(request: IssueCommentDeleteRequest): Promise<ConnectorWriteOutcome> {
            writes.delete.push(structuredClone(request));
            const comment = jira.comments.find((candidate) => candidate.id === request.commentId && candidate.issueKey === request.issueKey);
            if (comment === undefined) return connectorWriteNotSent('NOT_FOUND');
            if (comment.updated !== comment.created || comment.updated !== request.expected.version) return connectorWriteNotSent('TARGET_CHANGED');
            if (options.noDeletePermission === true) return connectorWriteNotSent('FORBIDDEN');
            jira.comments = jira.comments.filter((candidate) => candidate !== comment);
            return connectorWriteSent(request.commentId);
          },
        }),
  };
  const transitions: IssueTransitionWriter = {
    source: 'jira',
    allowsIssue: (key) => /^RT-\d+$/.test(key),
    async listTransitions() {
      reads.list += 1;
      if (jira.failReads) throw new ConnectorQueryError('UNAVAILABLE', 'test read failure');
      return jira.workflow[jira.status] ?? [];
    },
    ...(options.noStatusRead === true
      ? {}
      : {
          async readIssueStatus(issueKey: string) {
            reads.status += 1;
            if (jira.failReads) throw new ConnectorQueryError('UNAVAILABLE', 'test read failure');
            return { issueKey: jira.moved ? 'RT-99' : issueKey, statusId: jira.status, statusName: STATUS[jira.status] as string };
          },
        }),
    async transition(request) {
      writes.transition.push(structuredClone(request));
      if (request.fromStatusId !== undefined && request.fromStatusId !== jira.status) return connectorWriteNotSent('TARGET_CHANGED');
      const chosen = (jira.workflow[jira.status] ?? []).find((candidate) => candidate.id === request.transitionId);
      if (chosen === undefined || chosen.toStatusId !== request.toStatusId) return connectorWriteNotSent('TARGET_CHANGED');
      jira.status = chosen.toStatusId;
      return connectorWriteSent(`${request.issueKey}:${chosen.id}`);
    },
  };

  const store = {
    sessions: {
      get: async (id: string) => sessions.get(id) ?? null,
      save: async (session: Session) => {
        sessions.set(session.id, { ...session });
        return session;
      },
      list: async () => [...sessions.values()],
    },
    tasks: {
      get: async (id: string) => tasks.get(id) ?? null,
      save: async (task: Task) => {
        tasks.set(task.id, structuredClone(task));
        return task;
      },
      listByContext: async () => [...tasks.values()],
    },
  };
  let seq = 0;
  const flow = new StatelessConnectorWriteFlow({
    writers: { issueComments: comments, issueTransitions: transitions },
    receipts,
    approvals: {
      async requestForRisk(input) {
        const approval: ApprovalRequest = { id: `appr-${++seq}`, executionPlanRef: input.executionPlanRef, status: ApprovalStatus.PENDING, riskLevel: input.riskLevel, reason: input.reason, requestedBy: input.requestedBy, createdAt: T0 };
        approvals.set(approval.id, approval);
        return approval;
      },
      get: async (id) => approvals.get(id) ?? null,
      async decide(id, decision) {
        const approval = { ...(approvals.get(id) as ApprovalRequest), status: decision.approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED };
        approvals.set(id, approval);
        return approval;
      },
    },
    store,
    timeZone: 'Asia/Seoul',
    newId: () => `id-${++seq}`,
  });
  const session = (id = 'sess-1'): Session => sessions.get(id) as Session;

  async function approveAndExecute(now: string, actor: Actor = OWNER): Promise<ConnectorWriteStep> {
    const pending = await flow.find(session());
    if (!pending?.approval) throw new Error('no pending approval');
    approvals.set(pending.approval.id, { ...pending.approval, status: ApprovalStatus.APPROVED });
    await flow.recordApproval({ session: session(), actor, now, view: pending });
    const view = await flow.find(session());
    return flow.execute({ session: session(), actor, now, view: view as NonNullable<typeof view> });
  }

  function recordLastAction(input: { receiptId: string; anchorTaskId?: string; operation?: LastActionRecord['operation']; actorId?: string; at?: string; entryId?: LastActionRecord['entryId']; outcome?: LastActionRecord['outcome'] }): void {
    const entryId = input.entryId ?? 'external.write';
    const record: LastActionRecord = {
      entryId,
      source: 'jira',
      itemId: input.receiptId,
      at: input.at ?? at(1),
      undoable: entryId !== 'action.undo' && isExternalUndoOpen(externalUndoFamilyOf(entryId, input.operation)),
      undone: false,
      outcome: input.outcome ?? 'SENT',
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      ...(input.anchorTaskId !== undefined ? { anchorTaskId: input.anchorTaskId } : {}),
      echoReplyIds: [],
    };
    const current = session();
    sessions.set('sess-1', { ...current, metadata: { ...current.metadata, [LAST_ACTION_METADATA_KEY]: withLastAction(current.metadata?.[LAST_ACTION_METADATA_KEY], input.actorId ?? OWNER.id, record, record.at) } });
  }

  async function runWrite(draft: Parameters<typeof flow.prepare>[0]['draft'], operation: 'ISSUE_COMMENT' | 'ISSUE_TRANSITION') {
    const preview = await flow.prepare({ session: session(), actor: OWNER, now: at(0), draft });
    expect(preview.kind).toBe('preview');
    const anchorTaskId = (await flow.find(session()))?.taskId as string;
    const step = await approveAndExecute(at(1));
    if (step.kind !== 'outcome' || step.receiptId === undefined || step.outcome.status !== 'SENT') throw new Error('the write did not run');
    recordLastAction({ receiptId: step.receiptId, anchorTaskId, operation });
    return { receiptId: step.receiptId, anchorTaskId, step };
  }

  /** "RT-7에 댓글: 배포 확인했어요", approved and executed. */
  const addComment = () => runWrite({ kind: 'issue-comment', issueKey: KEY, text: '배포 확인했어요' }, 'ISSUE_COMMENT');
  /** "RT-7 진행 중으로 바꿔줘" (or the given status), approved and executed. */
  const transition = (toStatus = '진행 중') => runWrite({ kind: 'issue-transition', issueKey: KEY, toStatus }, 'ISSUE_TRANSITION');
  const undo = (kind: ExternalUndoDraftKind, receiptId: string, now: string, actor: Actor = OWNER, sessionId = 'sess-1', extra: { ownerText?: string } = {}) =>
    flow.prepare({ session: session(sessionId), actor, now, draft: { kind, receiptId }, ...extra });

  return { flow, session, jira, writes, reads, receipts, tasks, approveAndExecute, recordLastAction, addComment, transition, undo };
}

const reason = (step: ConnectorWriteStep): string | undefined => (step.kind === 'refused' ? step.reason : undefined);
const text = (step: ConnectorWriteStep): string => (step.kind === 'writes-off' ? '' : plainTextOf(renderConnectorWriteStep(step)));
const OPEN = ['calendar-create', 'calendar-update', 'calendar-delete', 'jira-comment', 'jira-transition'] as const;

describe('ADR-0112 amendment 3 (O4): the delete of the Jira comment Quoky added', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(OPEN));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('the comment receipt keeps the version the writer returned at SENT', async () => {
    const h = harness();
    const { receiptId } = await h.addComment();
    expect(h.receipts.rows.get(receiptId)).toMatchObject({ operation: 'ISSUE_COMMENT', target: KEY, data: { externalRef: '10001', version: '2026-11-16T10:00:01.000+0900' } });
  });

  it('previews a receipt-sourced delete with its own exact phrase, then deletes exactly that comment once, compare-and-set on its version', async () => {
    const h = harness();
    const { receiptId } = await h.addComment();
    const step = await h.undo('jira-comment-undo', receiptId, at(3), OWNER, 'sess-1', { ownerText: '방금 단 댓글 지워줘' });
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.approval.riskLevel).toBe('CRITICAL');
    expect(step.executionPhrase).toBe('Jira 댓글 삭제 실행');
    expect(step.preview).toMatchObject({ operation: 'ISSUE_COMMENT_DELETE', issueKey: KEY, commentId: '10001', text: '배포 확인했어요', receiptSourced: true });
    const card = text(step);
    expect(card.indexOf(CONNECTOR_UNDO_RECEIPT_BANNER)).toBeGreaterThanOrEqual(0);
    expect(card.indexOf(CONNECTOR_UNDO_RECEIPT_BANNER)).toBeLessThan(card.indexOf('요청하신 문장: '));
    expect(card).toContain('"Jira 댓글 삭제 실행"');
    const view = await h.flow.find(h.session());
    expect(view?.anchor).toMatchObject({
      target: `${KEY}/10001`,
      payload: { operation: 'ISSUE_COMMENT_DELETE', issueKey: KEY, commentId: '10001', expected: { version: '2026-11-16T10:00:01.000+0900' }, undoes: receiptId },
      undoOf: { entryId: 'external.write', receiptId, family: 'jira-comment' },
    });
    expect(isActionSwitchGoverned(view?.anchor as NonNullable<typeof view>['anchor'])).toBe(true);
    expect(h.writes.delete).toHaveLength(0);

    const done = await h.approveAndExecute(at(4));
    expect(done).toMatchObject({ kind: 'outcome', operation: 'ISSUE_COMMENT_DELETE', outcome: { status: 'SENT', externalRef: '10001' } });
    expect(h.writes.delete).toEqual([{ issueKey: KEY, commentId: '10001', expected: { version: '2026-11-16T10:00:01.000+0900' } }]);
    expect(h.jira.comments).toEqual([]);
    expect(text(done)).toBe('방금 단 Jira 댓글을 지워서 되돌렸어요.');
    // The same approval replayed never deletes twice.
    const view2 = await h.flow.find(h.session());
    expect(await h.flow.execute({ session: h.session(), actor: OWNER, now: at(5), view: view2 as NonNullable<typeof view2> })).toMatchObject({ kind: 'repeat', status: 'SENT' });
    expect(h.writes.delete).toHaveLength(1);
  });

  it('only when unedited: an edited comment, another version or a moved issue is undo-target-changed (no preview, no write)', async () => {
    const h = harness();
    const { receiptId } = await h.addComment();
    const comment = h.jira.comments[0] as JiraComment;
    comment.updated = '2026-11-16T10:05:00.000+0900';
    const edited = await h.undo('jira-comment-undo', receiptId, at(3));
    expect(reason(edited)).toBe('undo-target-changed');
    expect(text(edited)).toContain('수정됐거나');
    comment.updated = comment.created;
    h.jira.moved = true;
    expect(reason(await h.undo('jira-comment-undo', receiptId, at(3)))).toBe('undo-target-changed');
    expect(h.writes.delete).toHaveLength(0);
    expect((await h.flow.find(h.session()))?.anchor.status).not.toBe('APPROVAL_PENDING');
  });

  it('a comment edited between the preview and the phrase is TARGET_CHANGED at the writer: nothing deleted, said plainly', async () => {
    const h = harness();
    const { receiptId } = await h.addComment();
    expect((await h.undo('jira-comment-undo', receiptId, at(3))).kind).toBe('preview');
    (h.jira.comments[0] as JiraComment).updated = '2026-11-16T10:09:00.000+0900';
    const done = await h.approveAndExecute(at(4));
    expect(done).toMatchObject({ kind: 'outcome', outcome: { status: 'NOT_SENT', reason: 'TARGET_CHANGED' } });
    expect(text(done)).toContain('지우지 못했어요');
    expect(h.jira.comments).toHaveLength(1);
  });

  it('gone is undo-target-gone; no delete permission is undo-not-permitted (read-only, nothing requested); a failed read proposes nothing', async () => {
    const gone = harness();
    const g = await gone.addComment();
    gone.jira.comments = [];
    expect(reason(await gone.undo('jira-comment-undo', g.receiptId, at(3)))).toBe('undo-target-gone');

    const denied = harness({ noDeletePermission: true });
    const d = await denied.addComment();
    const step = await denied.undo('jira-comment-undo', d.receiptId, at(3));
    expect(reason(step)).toBe('undo-not-permitted');
    expect(text(step)).toContain('새 권한은 요청하지 않았어요');
    expect(denied.writes.delete).toHaveLength(0);

    const failing = harness();
    const f = await failing.addComment();
    failing.jira.failReads = true;
    expect(reason(await failing.undo('jira-comment-undo', f.receiptId, at(3)))).toBe('undo-read-failed');
    expect(failing.writes.delete).toHaveLength(0);
  });

  it('fails closed without the proof: no version at SENT (legacy) or a writer without inspect/delete is undo-unavailable', async () => {
    const legacy = harness({ noCommentVersion: true });
    const l = await legacy.addComment();
    expect(reason(await legacy.undo('jira-comment-undo', l.receiptId, at(3)))).toBe('undo-unavailable');
    expect(legacy.reads.inspect).toEqual([]);
    const older = harness({ noCommentDelete: true });
    const o = await older.addComment();
    const step = await older.undo('jira-comment-undo', o.receiptId, at(3));
    expect(reason(step)).toBe('undo-unavailable');
    expect(text(step)).toContain('Jira에서 직접 지워 주세요');
  });

  it("only this actor's own fresh lastAction reaches it: another actor, another session, a stale record or the other family's draft is undo-nothing", async () => {
    const h = harness();
    const { receiptId } = await h.addComment();
    expect(reason(await h.undo('jira-comment-undo', receiptId, at(3), OTHER))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-comment-undo', receiptId, at(3), OWNER, 'sess-2'))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-comment-undo', receiptId, at(12)))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-transition-undo', receiptId, at(3)))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-comment-undo', 'another-receipt', at(3)))).toBe('undo-nothing');
    expect(h.reads.inspect).toEqual([]);
  });

  it('with the family closed the record is not undoable and nothing resolves', async () => {
    setExternalUndoCapabilitiesForTest(['calendar-create', 'calendar-update', 'calendar-delete']);
    const h = harness();
    const { receiptId } = await h.addComment();
    expect(reason(await h.undo('jira-comment-undo', receiptId, at(3)))).toBe('undo-nothing');
  });

  it('execution re-derives the delete from the comment\'s own anchor and receipt: a card whose source link is gone or points elsewhere deletes nothing', async () => {
    for (const tamper of ['drop-source', 'other-source'] as const) {
      const h = harness();
      const { receiptId } = await h.addComment();
      expect((await h.undo('jira-comment-undo', receiptId, at(3))).kind).toBe('preview');
      const view = await h.flow.find(h.session());
      const task = h.tasks.get(view?.taskId as string) as Task;
      const anchor = task.metadata?.connectorWriteAnchor as { undoOf: Record<string, unknown> } & Record<string, unknown>;
      const undoOf = tamper === 'drop-source' ? { entryId: 'external.write', receiptId, family: 'jira-comment' } : { ...anchor.undoOf, sourceTaskId: view?.taskId };
      h.tasks.set(task.id, { ...task, metadata: { ...task.metadata, connectorWriteAnchor: { ...anchor, undoOf } } });
      const step = await h.approveAndExecute(at(4));
      expect(reason(step), tamper).toBe('undo-unavailable');
      expect(h.writes.delete).toHaveLength(0);
    }
  });

  it('the delete is never undone again (an undo has no family), and only its exact phrase runs it', async () => {
    const h = harness();
    const { receiptId } = await h.addComment();
    await h.undo('jira-comment-undo', receiptId, at(3));
    const view = await h.flow.find(h.session());
    const done = await h.approveAndExecute(at(4));
    if (done.kind !== 'outcome' || done.receiptId === undefined) throw new Error('delete did not run');
    h.recordLastAction({ receiptId: done.receiptId, anchorTaskId: view?.taskId, entryId: 'action.undo', operation: 'ISSUE_COMMENT_DELETE', at: at(4) });
    expect(reason(await h.undo('jira-comment-undo', done.receiptId, at(5)))).toBe('undo-nothing');
    expect(externalUndoFamilyOf('external.write', 'ISSUE_COMMENT_DELETE')).toBeUndefined();
    expect(isAcceptedExecutionPhrase('issueCommentDelete', 'Jira 댓글 삭제 실행')).toBe(true);
    for (const phrase of ['삭제 실행', '댓글 삭제 실행', '댓글 실행', '일정 삭제 실행']) expect(isAcceptedExecutionPhrase('issueCommentDelete', phrase), phrase).toBe(false);
  });
});

describe('ADR-0112 amendment 3 (O5): the revert of Quoky\'s own Jira transition', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(OPEN));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('the forward transition records fromStatusId at preview and is sent compare-and-set on it', async () => {
    const h = harness();
    await h.transition();
    const anchor = [...h.tasks.values()].map((task) => task.metadata?.connectorWriteAnchor as { payload?: Record<string, unknown> }).find((candidate) => candidate.payload?.operation === 'ISSUE_TRANSITION');
    expect(anchor?.payload).toMatchObject({ transitionId: '11', toStatusId: '3', fromStatusId: '1', fromStatus: '할 일' });
    expect(h.writes.transition).toEqual([{ issueKey: KEY, transitionId: '11', toStatusId: '3', fromStatusId: '1' }]);
    expect(h.jira.status).toBe('3');
  });

  it('exactly one transition leads back: a receipt-sourced preview with its own exact phrase, then that transition, compare-and-set on Quoky\'s status', async () => {
    const h = harness();
    const { receiptId } = await h.transition();
    const step = await h.undo('jira-transition-undo', receiptId, at(3), OWNER, 'sess-1', { ownerText: '되돌려줘' });
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.executionPhrase).toBe('Jira 상태 되돌리기 실행');
    expect(step.preview).toMatchObject({ operation: 'ISSUE_TRANSITION_REVERT', issueKey: KEY, currentStatusId: '3', toStatusId: '1', transitionId: '21', receiptSourced: true });
    const card = text(step);
    expect(card.startsWith('Jira 상태 되돌리기 미리보기예요.')).toBe(true);
    expect(card.indexOf(CONNECTOR_UNDO_RECEIPT_BANNER)).toBeLessThan(card.indexOf('요청하신 문장: '));
    expect(card).toContain('"Jira 상태 되돌리기 실행"');
    const done = await h.approveAndExecute(at(4));
    expect(done).toMatchObject({ kind: 'outcome', operation: 'ISSUE_TRANSITION_REVERT', outcome: { status: 'SENT' } });
    expect(h.writes.transition.at(-1)).toEqual({ issueKey: KEY, transitionId: '21', toStatusId: '1', fromStatusId: '3' });
    expect(h.jira.status).toBe('1');
    expect(text(done)).toBe('방금 바꾼 Jira 이슈 상태를 바꾸기 전 상태로 되돌렸어요.');
  });

  it('several lead back: a numbered choice of exactly the Core-listed transitions; the number picks one; a number outside the list previews nothing', async () => {
    const workflow = { ...DEFAULT_WORKFLOW, '3': [option('21', '멈춤', '1'), option('22', '처음으로', '1'), option('31', '끝내기', '5')] };
    const h = harness({ workflow });
    const { receiptId } = await h.transition();
    const step = await h.undo('jira-transition-undo', receiptId, at(3), OWNER, 'sess-1', { ownerText: '되돌려줘' });
    expect(step.kind).toBe('revert-choice');
    if (step.kind !== 'revert-choice') return;
    expect(step.transitions.map((candidate) => candidate.id)).toEqual(['21', '22']);
    const card = text(step);
    expect(card.startsWith(CONNECTOR_UNDO_RECEIPT_BANNER)).toBe(true);
    expect(card).toContain('1. 멈춤 → 할 일');
    expect(card).not.toContain('끝내기');
    const choice = await h.flow.find(h.session());
    expect(choice?.anchor).toMatchObject({ status: 'AWAITING_CHOICE', family: 'issue-transition', undoOf: { family: 'jira-transition', receiptId } });
    expect(isActionSwitchGoverned(choice?.anchor as NonNullable<typeof choice>['anchor'])).toBe(true);
    const outside = await h.flow.choose({ session: h.session(), actor: OWNER, now: at(4), view: choice as NonNullable<typeof choice>, index: 3 });
    expect(reason(outside)).toBe('invalid-choice');
    expect(text(outside)).toContain('목록에 없는 전환은 쓰지 않아요');
    const picked = await h.flow.choose({ session: h.session(), actor: OWNER, now: at(4), view: choice as NonNullable<typeof choice>, index: 2 });
    expect(picked.kind).toBe('preview');
    expect(picked.kind === 'preview' && picked.preview).toMatchObject({ operation: 'ISSUE_TRANSITION_REVERT', transitionId: '22', toStatusId: '1', ownerSentence: '되돌려줘' });
    await h.approveAndExecute(at(5));
    expect(h.writes.transition.at(-1)).toEqual({ issueKey: KEY, transitionId: '22', toStatusId: '1', fromStatusId: '3' });
  });

  it('a pick no longer listed (or now leading elsewhere) when the preview is built proposes nothing', async () => {
    const workflow = { ...DEFAULT_WORKFLOW, '3': [option('21', '멈춤', '1'), option('22', '처음으로', '1')] };
    const h = harness({ workflow });
    const { receiptId } = await h.transition();
    await h.undo('jira-transition-undo', receiptId, at(3));
    const choice = await h.flow.find(h.session());
    h.jira.workflow = { ...workflow, '3': [option('21', '멈춤', '1'), option('22', '처음으로', '7')] };
    expect(reason(await h.flow.choose({ session: h.session(), actor: OWNER, now: at(4), view: choice as NonNullable<typeof choice>, index: 2 }))).toBe('undo-target-changed');
    expect(h.writes.transition).toHaveLength(1);
  });

  it('none leads back: said plainly, nothing proposed', async () => {
    const workflow = { ...DEFAULT_WORKFLOW, '3': [option('31', '끝내기', '5')] };
    const h = harness({ workflow });
    const { receiptId } = await h.transition();
    const step = await h.undo('jira-transition-undo', receiptId, at(3));
    expect(reason(step)).toBe('undo-no-path');
    expect(text(step)).toContain('바꾸기 전 상태로 돌리는 전환이 지금 Jira에 없어요');
    expect(h.writes.transition).toHaveLength(1);
  });

  it('the issue moved on (another status, or a moved key) is undo-target-changed; a move between preview and phrase is TARGET_CHANGED at the writer', async () => {
    const h = harness();
    const { receiptId } = await h.transition();
    h.jira.status = '5';
    expect(reason(await h.undo('jira-transition-undo', receiptId, at(3)))).toBe('undo-target-changed');
    h.jira.status = '3';
    h.jira.moved = true;
    expect(reason(await h.undo('jira-transition-undo', receiptId, at(3)))).toBe('undo-target-changed');
    h.jira.moved = false;
    expect((await h.undo('jira-transition-undo', receiptId, at(3))).kind).toBe('preview');
    h.jira.status = '5';
    const done = await h.approveAndExecute(at(4));
    expect(done).toMatchObject({ kind: 'outcome', outcome: { status: 'NOT_SENT', reason: 'TARGET_CHANGED' } });
    expect(h.jira.status).toBe('5');
    expect(text(done)).toContain('되돌리지 못했어요');
  });

  it('a legacy transition (no fromStatusId recorded) is not undoable; a failed read proposes nothing', async () => {
    const legacy = harness({ noStatusRead: true });
    const l = await legacy.transition();
    const step = await legacy.undo('jira-transition-undo', l.receiptId, at(3));
    expect(reason(step)).toBe('undo-unavailable');
    expect(text(step)).toContain('바꾸기 전 상태가 기록되지 않았어요');
    const failing = harness();
    const f = await failing.transition();
    failing.jira.failReads = true;
    expect(reason(await failing.undo('jira-transition-undo', f.receiptId, at(3)))).toBe('undo-read-failed');
    expect(failing.writes.transition).toHaveLength(1);
  });

  it("only this actor's own fresh lastAction reaches it", async () => {
    const h = harness();
    const { receiptId } = await h.transition();
    expect(reason(await h.undo('jira-transition-undo', receiptId, at(3), OTHER))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-transition-undo', receiptId, at(3), OWNER, 'sess-2'))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-transition-undo', receiptId, at(12)))).toBe('undo-nothing');
    expect(reason(await h.undo('jira-comment-undo', receiptId, at(3)))).toBe('undo-nothing');
    expect(h.reads.status).toBe(1);
  });

  it('execution re-derives the revert from the transition\'s own anchor: a card whose source anchor is gone deletes nothing; the revert is never undone again', async () => {
    const h = harness();
    const { receiptId, anchorTaskId } = await h.transition();
    expect((await h.undo('jira-transition-undo', receiptId, at(3))).kind).toBe('preview');
    const source = h.tasks.get(anchorTaskId) as Task;
    const sourceAnchor = source.metadata?.connectorWriteAnchor as { payload: Record<string, unknown> } & Record<string, unknown>;
    // The undone transition's recorded fromStatusId is rewritten: the persisted card no longer equals the re-derived inverse.
    h.tasks.set(anchorTaskId, { ...source, metadata: { ...source.metadata, connectorWriteAnchor: { ...sourceAnchor, payload: { ...sourceAnchor.payload, fromStatusId: '7' } } } });
    const step = await h.approveAndExecute(at(4));
    expect(reason(step)).toBe('undo-unavailable');
    expect(h.writes.transition).toHaveLength(1);
    expect(externalUndoFamilyOf('external.write', 'ISSUE_TRANSITION_REVERT')).toBeUndefined();
    for (const phrase of ['되돌리기 실행', '상태 되돌리기 실행', 'Jira 상태 변경 실행']) expect(isAcceptedExecutionPhrase('issueTransitionRevert', phrase), phrase).toBe(false);
  });
});
