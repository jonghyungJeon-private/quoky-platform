import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SessionStatus } from '../../domain';
import type { Actor, ApprovalRequest, Session, Task } from '../../domain';
import {
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  type ChannelMessageDeleteRequest,
  type ChannelMessageDeleteWriter,
  type ChannelMessageRequest,
  type ChannelMessageWriter,
  type ConnectorWriteOutcome,
} from '../../ports/connector-write.port';
import type { ConnectorWriteMatch, ConnectorWritePrepareResult, ConnectorWriteReceipt, ConnectorWriteReceiptRepository } from '../../ports/connector-write-receipt.port';
import { isAcceptedExecutionPhrase } from '../execution-command-guard';
import { LAST_ACTION_METADATA_KEY, externalUndoFamilyOf, isExternalUndoOpen, setExternalUndoCapabilitiesForTest, withLastAction, type LastActionRecord } from '../nl-routing/last-action';
import { plainTextOf } from '../message-rendering';
import { CONNECTOR_UNDO_RECEIPT_BANNER, renderConnectorWriteStep } from './connector-write-copy';
import type { ExternalUndoDraftKind } from './connector-write-draft';
import { StatelessConnectorWriteFlow, isActionSwitchGoverned, type ConnectorWriteStep } from './connector-write-flow';

// ADR-0112 amendment 1 (S-1..S-6, ratified 2026-10-15) under amendment 3: the delete of the Slack message Quoky posted, as
// that post's undo, through the real flow. Storage, approvals, receipts and the two Slack writers are in-memory fakes; the
// runtime's `externalLastActionOf` is emulated by writing the same `slack.post` lastAction record.

const T0 = '2026-11-16T01:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
const OTHER: Actor = { id: 'other', displayName: 'Other', identities: [], createdAt: T0 };
const CHANNEL = 'C0123ABCD9';
const OTHER_CHANNEL = 'C0999ZZZZ1';
const TEXT = '배포 끝났어요';

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
    const data = outcome.status === 'SENT' ? { externalRef: outcome.externalRef, ...(outcome.url !== undefined ? { url: outcome.url } : {}) } : { reason: outcome.reason };
    const next = { ...row, status: outcome.status, updatedAt: now, data: { ...data, ...(row.data.undoes !== undefined ? { undoes: row.data.undoes } : {}) } };
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
  async findSentUndoOf(actorId: string, undoneReceiptId: string): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].filter((row) => row.status === 'SENT' && row.actorId === actorId && row.data.undoes === undoneReceiptId).pop() ?? null;
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

interface HarnessOptions {
  /** No delete writer is bound (an older build): the undo is writes-off. */
  readonly noDeleteWriter?: boolean;
  /** What Slack answers to the delete (default: deletes it). */
  readonly deleteAnswer?: ConnectorWriteOutcome;
  readonly postUrlHost?: string;
}

function harness(options: HarnessOptions = {}) {
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const approvals = new Map<string, ApprovalRequest>();
  const receipts = new MemoryReceipts();
  const context = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
  for (const id of ['sess-1', 'sess-2']) sessions.set(id, { id, actorId: OWNER.id, context, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0 });
  const slack = { allow: new Set([CHANNEL, OTHER_CHANNEL]), messages: [] as Array<{ channel: string; ts: string; text: string }> };
  const writes = { post: [] as ChannelMessageRequest[], delete: [] as ChannelMessageDeleteRequest[] };
  let tsSeq = 100;

  const posts: ChannelMessageWriter = {
    source: 'slack',
    resolveChannel(channel) {
      const name = channel.startsWith('#') ? channel.slice(1) : channel;
      if (name === 'dev-test' || name === CHANNEL) return slack.allow.has(CHANNEL) ? CHANNEL : undefined;
      if (name === 'ops' || name === OTHER_CHANNEL) return slack.allow.has(OTHER_CHANNEL) ? OTHER_CHANNEL : undefined;
      return undefined;
    },
    async post(request) {
      writes.post.push(structuredClone(request));
      const channelId = posts.resolveChannel(request.channel);
      if (channelId === undefined) return connectorWriteNotSent('TARGET_NOT_ALLOWED');
      const ts = `1700000000.000${String((tsSeq += 1))}`;
      slack.messages.push({ channel: channelId, ts, text: request.text });
      return connectorWriteSent(`${channelId}:${ts}`, `https://${options.postUrlHost ?? 'example.slack.com'}/archives/${channelId}/p${ts.replace('.', '')}`);
    },
  };
  const deletes: ChannelMessageDeleteWriter = {
    source: 'slack',
    allowsChannelId: (channelId) => slack.allow.has(channelId),
    async deleteMessage(request) {
      writes.delete.push(structuredClone(request));
      if (options.deleteAnswer !== undefined) return options.deleteAnswer;
      const message = slack.messages.find((candidate) => candidate.channel === request.channelId && candidate.ts === request.ts);
      if (message === undefined) return connectorWriteNotSent('NOT_FOUND');
      slack.messages = slack.messages.filter((candidate) => candidate !== message);
      return connectorWriteSent(`${request.channelId}:${request.ts}`);
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
    writers: { channelMessages: posts, ...(options.noDeleteWriter === true ? {} : { channelMessageDeletes: deletes }) },
    receipts,
    approvals: {
      async requestForRisk(input) {
        const approval: ApprovalRequest = { id: `appr-${++seq}`, executionPlanRef: input.executionPlanRef, status: ApprovalStatus.PENDING, riskLevel: input.riskLevel, reason: input.reason, requestedBy: input.requestedBy, createdAt: T0, updatedAt: T0 };
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

  function recordLastAction(input: { receiptId: string; anchorTaskId?: string; operation?: LastActionRecord['operation']; actorId?: string; at?: string; entryId?: LastActionRecord['entryId'] }): void {
    const entryId = input.entryId ?? 'slack.post';
    const record: LastActionRecord = {
      entryId,
      source: 'slack',
      itemId: input.receiptId,
      at: input.at ?? at(1),
      undoable: entryId !== 'action.undo' && isExternalUndoOpen(externalUndoFamilyOf(entryId, input.operation)),
      undone: false,
      outcome: 'SENT',
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      ...(input.anchorTaskId !== undefined ? { anchorTaskId: input.anchorTaskId } : {}),
      echoReplyIds: [],
    };
    const current = session();
    sessions.set('sess-1', { ...current, metadata: { ...current.metadata, [LAST_ACTION_METADATA_KEY]: withLastAction(current.metadata?.[LAST_ACTION_METADATA_KEY], input.actorId ?? OWNER.id, record, record.at) } });
  }

  /** "Slack #dev-test에 게시: 배포 끝났어요" (or the given channel / text), approved with "Slack 게시 실행". */
  async function post(channel = '#dev-test', body = TEXT, now = at(0)) {
    const preview = await flow.prepare({ session: session(), actor: OWNER, now, draft: { kind: 'channel-post', channel, text: body } });
    if (preview.kind !== 'preview') throw new Error(`the post did not preview (${preview.kind})`);
    const anchorTaskId = (await flow.find(session()))?.taskId as string;
    const step = await approveAndExecute(now);
    if (step.kind !== 'outcome' || step.receiptId === undefined || step.outcome.status !== 'SENT') throw new Error('the post did not run');
    recordLastAction({ receiptId: step.receiptId, anchorTaskId, operation: 'CHANNEL_POST', at: now });
    return { preview, receiptId: step.receiptId, anchorTaskId, step };
  }

  const undo = (kind: ExternalUndoDraftKind, receiptId: string, now: string, actor: Actor = OWNER, sessionId = 'sess-1', extra: { ownerText?: string } = {}) =>
    flow.prepare({ session: session(sessionId), actor, now, draft: { kind, receiptId }, ...extra });

  return { flow, session, slack, writes, receipts, tasks, approveAndExecute, recordLastAction, post, undo };
}

const reason = (step: ConnectorWriteStep): string | undefined => (step.kind === 'refused' ? step.reason : undefined);
const text = (step: ConnectorWriteStep): string => (step.kind === 'writes-off' ? '' : plainTextOf(renderConnectorWriteStep(step)));
const OPEN = ['calendar-create', 'calendar-update', 'calendar-delete', 'jira-comment', 'jira-transition', 'slack-post'] as const;

describe('ADR-0112 amendment 1 under amendment 3: the delete of the Slack message Quoky posted', () => {
  beforeEach(() => setExternalUndoCapabilitiesForTest(OPEN));
  afterEach(() => setExternalUndoCapabilitiesForTest());

  it('the post record maps to the slack-post family; any other Slack operation and every undo record has none', () => {
    expect(externalUndoFamilyOf('slack.post', 'CHANNEL_POST')).toBe('slack-post');
    expect(externalUndoFamilyOf('slack.post', 'CHANNEL_MESSAGE_DELETE')).toBeUndefined();
    expect(externalUndoFamilyOf('slack.post', undefined)).toBeUndefined();
    expect(externalUndoFamilyOf('external.write', 'CHANNEL_POST')).toBeUndefined();
    expect(externalUndoFamilyOf('action.undo', 'CHANNEL_MESSAGE_DELETE')).toBeUndefined();
  });

  it('previews a receipt-sourced CRITICAL delete of exactly the posted message with its own phrase, then deletes it once', async () => {
    const h = harness();
    const { receiptId } = await h.post();
    const [posted] = h.slack.messages;
    const step = await h.undo('slack-post-undo', receiptId, at(3), OWNER, 'sess-1', { ownerText: '방금 슬랙에 올린 거 지워줘' });
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.approval.riskLevel).toBe('CRITICAL');
    expect(step.executionPhrase).toBe('Slack 삭제 실행');
    expect(step.preview).toMatchObject({ operation: 'CHANNEL_MESSAGE_DELETE', channelLabel: 'dev-test', channelId: CHANNEL, ts: posted?.ts, text: TEXT, receiptSourced: true });
    const card = text(step);
    expect(card.indexOf(CONNECTOR_UNDO_RECEIPT_BANNER)).toBeGreaterThanOrEqual(0);
    expect(card.indexOf(CONNECTOR_UNDO_RECEIPT_BANNER)).toBeLessThan(card.indexOf('요청하신 문장: '));
    expect(card).toContain('"Slack 삭제 실행"');
    expect(card).toContain(TEXT);
    expect(card).toContain('#dev-test');
    // S-4: the honest limit of the pre-delete check is on the card.
    expect(card).toContain('수정됐는지는 확인할 수 없어요');
    expect(step.preview).toMatchObject({ url: expect.stringMatching(/^https:\/\/example\.slack\.com\/archives\//u) });
    const view = await h.flow.find(h.session());
    expect(view?.anchor).toMatchObject({
      target: `${CHANNEL}:${posted?.ts}`,
      payload: { operation: 'CHANNEL_MESSAGE_DELETE', channel: CHANNEL, ts: posted?.ts, undoes: receiptId },
      undoOf: { entryId: 'slack.post', receiptId, family: 'slack-post' },
    });
    expect(isActionSwitchGoverned(view?.anchor as NonNullable<typeof view>['anchor'])).toBe(true);
    expect(h.writes.delete).toHaveLength(0);

    const done = await h.approveAndExecute(at(4));
    expect(done).toMatchObject({ kind: 'outcome', operation: 'CHANNEL_MESSAGE_DELETE', outcome: { status: 'SENT' } });
    expect(h.writes.delete).toEqual([{ channelId: CHANNEL, ts: posted?.ts }]);
    expect(h.slack.messages).toEqual([]);
    expect(text(done)).toBe('방금 게시한 Slack 메시지를 지워서 되돌렸어요.');
    // The same approval replayed never deletes twice.
    const view2 = await h.flow.find(h.session());
    expect(await h.flow.execute({ session: h.session(), actor: OWNER, now: at(5), view: view2 as NonNullable<typeof view2> })).toMatchObject({ kind: 'repeat', status: 'SENT' });
    expect(h.writes.delete).toHaveLength(1);
  });

  it('security review (LOW): a receipt link that is not a Slack permalink never reaches the CRITICAL card', async () => {
    const h = harness({ postUrlHost: 'slack.com.example.test' });
    const { receiptId } = await h.post();
    const step = await h.undo('slack-post-undo', receiptId, at(3), OWNER, 'sess-1', { ownerText: '방금 슬랙에 올린 거 지워줘' });
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.preview).not.toHaveProperty('url');
    expect(text(step)).not.toContain('slack.com.example.test');
  });

  it("only this actor's own fresh lastAction reaches it: another actor, another session, a stale record, another receipt or family is undo-nothing", async () => {
    const h = harness();
    const { receiptId } = await h.post();
    expect(reason(await h.undo('slack-post-undo', receiptId, at(3), OTHER))).toBe('undo-nothing');
    expect(reason(await h.undo('slack-post-undo', receiptId, at(3), OWNER, 'sess-2'))).toBe('undo-nothing');
    expect(reason(await h.undo('slack-post-undo', receiptId, at(12)))).toBe('undo-nothing');
    // Another family's draft on this receipt never previews (here no Jira writer is bound at all).
    expect((await h.undo('jira-comment-undo', receiptId, at(3))).kind).not.toBe('preview');
    expect(reason(await h.undo('slack-post-undo', 'another-receipt', at(3)))).toBe('undo-nothing');
    expect(h.writes.delete).toEqual([]);
  });

  it('only the latest post: an earlier post is not reachable once another write is the lastAction', async () => {
    const h = harness();
    const first = await h.post('#dev-test', '첫 번째 글', at(0));
    await h.post('#ops', '두 번째 글', at(1));
    expect(reason(await h.undo('slack-post-undo', first.receiptId, at(2)))).toBe('undo-nothing');
    expect(h.writes.delete).toEqual([]);
  });

  it('a channel taken off the allowlist refuses at the preview, and again at execution (nothing deleted)', async () => {
    const atPreview = harness();
    const p = await atPreview.post();
    atPreview.slack.allow.delete(CHANNEL);
    const step = await atPreview.undo('slack-post-undo', p.receiptId, at(3));
    expect(reason(step)).toBe('target-not-allowed');
    expect(text(step)).toContain('Slack에서 직접 지워 주세요');

    const atRun = harness();
    const r = await atRun.post();
    expect((await atRun.undo('slack-post-undo', r.receiptId, at(3))).kind).toBe('preview');
    atRun.slack.allow.delete(CHANNEL);
    const done = await atRun.approveAndExecute(at(4));
    expect(done.kind === 'outcome' && done.outcome.status === 'SENT').toBe(false);
    expect(atRun.writes.delete).toEqual([]);
    expect(atRun.slack.messages).toHaveLength(1);
  });

  it('the post anchor must still prove the receipt: an edited anchor text, a foreign ref or a NOT_SENT post is undo-nothing', async () => {
    for (const tamper of ['anchor-text', 'preview-text', 'receipt-ref', 'receipt-hash'] as const) {
      const h = harness();
      const { receiptId, anchorTaskId } = await h.post();
      if (tamper === 'anchor-text' || tamper === 'preview-text') {
        const task = h.tasks.get(anchorTaskId) as Task;
        const anchor = task.metadata?.connectorWriteAnchor as Record<string, Record<string, unknown>>;
        const key = tamper === 'anchor-text' ? 'payload' : 'preview';
        h.tasks.set(task.id, { ...task, metadata: { ...task.metadata, connectorWriteAnchor: { ...anchor, [key]: { ...anchor[key], text: '다른 글' } } } });
      } else {
        const row = h.receipts.rows.get(receiptId) as ConnectorWriteReceipt;
        h.receipts.rows.set(row.id, tamper === 'receipt-ref' ? { ...row, data: { ...row.data, externalRef: `${OTHER_CHANNEL}:1700000000.000101` } } : { ...row, payloadSha256: '0'.repeat(64) });
      }
      expect(reason(await h.undo('slack-post-undo', receiptId, at(3))), tamper).toBe('undo-nothing');
      expect(h.writes.delete).toEqual([]);
    }
  });

  it("execution re-derives the delete from the post's own anchor and receipt: a card whose source link is gone, points elsewhere or names another message deletes nothing", async () => {
    for (const tamper of ['drop-source', 'self-source', 'other-ts'] as const) {
      const h = harness();
      const { receiptId } = await h.post();
      expect((await h.undo('slack-post-undo', receiptId, at(3))).kind).toBe('preview');
      const view = await h.flow.find(h.session());
      const task = h.tasks.get(view?.taskId as string) as Task;
      const anchor = task.metadata?.connectorWriteAnchor as { undoOf: Record<string, unknown>; payload: Record<string, unknown> } & Record<string, unknown>;
      const next =
        tamper === 'drop-source'
          ? { ...anchor, undoOf: { entryId: 'slack.post', receiptId, family: 'slack-post' } }
          : tamper === 'self-source'
            ? { ...anchor, undoOf: { ...anchor.undoOf, sourceTaskId: view?.taskId } }
            : { ...anchor, payload: { ...anchor.payload, ts: '1700000000.000999' } };
      h.tasks.set(task.id, { ...task, metadata: { ...task.metadata, connectorWriteAnchor: next } });
      const step = await h.approveAndExecute(at(4));
      expect(step.kind === 'outcome' && step.outcome.status === 'SENT', tamper).toBe(false);
      expect(h.writes.delete, tamper).toEqual([]);
      if (tamper !== 'other-ts') expect(reason(step), tamper).toBe('undo-unavailable');
    }
  });

  it('S6: every Slack refusal is a fail-closed reply that says nothing was deleted, and nothing is retried', async () => {
    const cases: Array<[ConnectorWriteOutcome, string]> = [
      [connectorWriteNotSent('NOT_FOUND'), '이미 지워진 메시지예요'],
      [connectorWriteNotSent('FORBIDDEN'), '이 메시지는 Quoky가 지울 수 없어요'],
      [connectorWriteNotSent('RATE_LIMITED'), 'Slack 요청 한도를 넘었어요'],
      [connectorWriteUncertain('TRANSPORT'), '지워졌는지 확실하지 않아요'],
    ];
    for (const [answer, copy] of cases) {
      const h = harness({ deleteAnswer: answer });
      const { receiptId } = await h.post();
      await h.undo('slack-post-undo', receiptId, at(3));
      const done = await h.approveAndExecute(at(4));
      expect(done).toMatchObject({ kind: 'outcome', outcome: answer });
      expect(text(done)).toContain(copy);
      if (answer.status === 'NOT_SENT') expect(text(done)).toContain('지운 것은 없어요');
      expect(text(done)).toContain('자동으로 다시 시도하지 않아요');
      expect(h.writes.delete).toHaveLength(1);
    }
  });

  it('the delete is never undone again, and the same post asked again after the undo is a new post (not "already sent")', async () => {
    const h = harness();
    const { receiptId } = await h.post();
    await h.undo('slack-post-undo', receiptId, at(3));
    const view = await h.flow.find(h.session());
    const done = await h.approveAndExecute(at(4));
    if (done.kind !== 'outcome' || done.receiptId === undefined) throw new Error('delete did not run');
    expect(h.receipts.rows.get(done.receiptId)?.data.undoes).toBe(receiptId);
    h.recordLastAction({ receiptId: done.receiptId, anchorTaskId: view?.taskId, entryId: 'action.undo', operation: 'CHANNEL_MESSAGE_DELETE', at: at(4) });
    expect(reason(await h.undo('slack-post-undo', done.receiptId, at(5)))).toBe('undo-nothing');
    expect(reason(await h.undo('slack-post-undo', receiptId, at(5)))).toBe('undo-nothing');

    const again = await h.post('#dev-test', TEXT, at(6));
    expect(again.preview.kind).toBe('preview');
    expect(h.writes.post).toHaveLength(2);
    expect(h.slack.messages).toHaveLength(1);
  });

  it('only the exact Slack delete phrase runs it; a bare or other-service phrase never does', () => {
    expect(isAcceptedExecutionPhrase('channelMessageDelete', 'Slack 삭제 실행')).toBe(true);
    expect(isAcceptedExecutionPhrase('channelMessageDelete', '슬랙 삭제 실행')).toBe(true);
    for (const phrase of ['삭제 실행', '메시지 삭제 실행', 'Slack 게시 실행', '게시 실행', '일정 삭제 실행', 'Jira 댓글 삭제 실행', '실행']) {
      expect(isAcceptedExecutionPhrase('channelMessageDelete', phrase), phrase).toBe(false);
    }
  });

  it('with the family closed the record is not undoable and nothing resolves; without the delete writer it is writes-off', async () => {
    setExternalUndoCapabilitiesForTest(['calendar-create', 'calendar-update', 'calendar-delete', 'jira-comment', 'jira-transition']);
    const closed = harness();
    const c = await closed.post();
    expect(reason(await closed.undo('slack-post-undo', c.receiptId, at(3)))).toBe('undo-nothing');
    setExternalUndoCapabilitiesForTest(OPEN);
    const older = harness({ noDeleteWriter: true });
    const o = await older.post();
    expect((await older.undo('slack-post-undo', o.receiptId, at(3))).kind).toBe('writes-off');
  });
});
