import { describe, expect, it } from 'vitest';
import { ApprovalStatus, SessionStatus } from '../../domain';
import type { Actor, ApprovalRequest, Session, Task } from '../../domain';
import type { CalendarEvent, CalendarReader } from '../../ports/calendar-reader.port';
import {
  connectorWriteNotSent,
  connectorWriteSent,
  type CalendarEventDeleteRequest,
  type CalendarEventWriter,
  type ConnectorWriteOutcome,
} from '../../ports/connector-write.port';
import type {
  ConnectorWriteMatch,
  ConnectorWritePrepareResult,
  ConnectorWriteReceipt,
  ConnectorWriteReceiptRepository,
} from '../../ports/connector-write-receipt.port';
import { LAST_ACTION_METADATA_KEY, externalUndoFamilyOf, withLastAction, type LastActionRecord } from '../nl-routing/last-action';
import { plainTextOf } from '../message-rendering';
import { CONNECTOR_UNDO_RECEIPT_BANNER, renderConnectorWriteStep } from './connector-write-copy';
import { StatelessConnectorWriteFlow, type ConnectorWriteStep } from './connector-write-flow';

// ADR-0112 amendment 1 S9 / amendment 3, slice 3: the undo of an NL-created calendar event through the real flow. Storage,
// approvals, receipts, the writer and the reader are in-memory fakes; the runtime's `recordExternalWrite` is emulated by
// writing the same `lastAction` record (receipt id + anchor task id) the runtime writes.

const SEOUL = 'Asia/Seoul';
const T0 = '2026-11-02T01:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
const OTHER: Actor = { id: 'other', displayName: 'Other', identities: [], createdAt: T0 };
const EVENT_ID = 'abcde12345';
const VERSION = '"v-created"';

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
    const data =
      outcome.status === 'SENT'
        ? { externalRef: outcome.externalRef, ...(outcome.version !== undefined ? { version: outcome.version } : {}) }
        : { reason: outcome.reason };
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

interface HarnessOptions {
  /** What the writer answers to the delete. */
  deleteOutcome?: ConnectorWriteOutcome;
  /** The version the writer reports for the create (absent = the writer reports none). */
  createVersion?: string | undefined;
}

function harness(options: HarnessOptions = {}) {
  const live: { events: CalendarEvent[] } = { events: [] };
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const approvals = new Map<string, ApprovalRequest>();
  const writes = { delete: [] as CalendarEventDeleteRequest[], create: 0 };
  const receipts = new MemoryReceipts();
  const context = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
  for (const id of ['sess-1', 'sess-2']) {
    sessions.set(id, { id, actorId: OWNER.id, context, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0 });
  }
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
  const reader: CalendarReader = {
    source: 'calendar',
    readOnly: true,
    async listEvents(query) {
      const from = Date.parse(query.from);
      const to = Date.parse(query.to);
      return live.events.filter((event) => Date.parse(event.end) > from && Date.parse(event.start) < to);
    },
  };
  const writer: CalendarEventWriter = {
    source: 'calendar',
    target: 'primary',
    async createEvent(request) {
      writes.create += 1;
      const time = request.draft.time;
      if (time.allDay) return connectorWriteSent(EVENT_ID);
      live.events.push({ id: EVENT_ID, title: request.draft.title, start: time.start, end: time.end, allDay: false, status: 'confirmed', calendarName: 'primary', version: VERSION });
      return connectorWriteSent(EVENT_ID, undefined, 'createVersion' in options ? options.createVersion : VERSION);
    },
    async updateEvent(request) {
      return connectorWriteSent(request.eventId);
    },
    async deleteEvent(request) {
      writes.delete.push(request);
      live.events = live.events.filter((event) => event.id !== request.eventId);
      return options.deleteOutcome ?? connectorWriteSent(request.eventId);
    },
  };
  let seq = 0;
  const flow = new StatelessConnectorWriteFlow({
    writers: { calendarEvents: writer },
    calendarReader: reader,
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
    timeZone: SEOUL,
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

  /** The owner's "내일 오후 5시에 QA 일정 잡아줘" approved and executed, and the runtime's lastAction record for it. */
  async function createEvent(): Promise<{ receiptId: string; anchorTaskId: string; step: ConnectorWriteStep }> {
    const preview = await flow.prepare({
      session: session(),
      actor: OWNER,
      now: at(0),
      draft: { kind: 'calendar-create', event: { title: 'QA 세션', time: { allDay: false, start: '2026-11-03T17:00:00+09:00', end: '2026-11-03T18:00:00+09:00', timeZone: SEOUL } } },
    });
    expect(preview.kind).toBe('preview');
    const view = await flow.find(session());
    const anchorTaskId = (view as NonNullable<typeof view>).taskId;
    const step = await approveAndExecute(at(1));
    if (step.kind !== 'outcome' || step.receiptId === undefined) throw new Error('create did not run');
    recordLastAction({ receiptId: step.receiptId, anchorTaskId });
    return { receiptId: step.receiptId, anchorTaskId, step };
  }

  /** What the runtime's recordExternalWrite stores (the capability is open for calendar.create). */
  function recordLastAction(input: { receiptId: string; anchorTaskId?: string; sessionId?: string; actorId?: string; at?: string; entryId?: LastActionRecord['entryId']; outcome?: LastActionRecord['outcome'] }): void {
    const sessionId = input.sessionId ?? 'sess-1';
    const entryId = input.entryId ?? 'calendar.create';
    const record: LastActionRecord = {
      entryId,
      source: 'calendar',
      itemId: input.receiptId,
      at: input.at ?? at(1),
      undoable: entryId !== 'action.undo' && externalUndoFamilyOf(entryId) !== undefined,
      undone: false,
      outcome: input.outcome ?? 'SENT',
      ...(input.anchorTaskId !== undefined ? { anchorTaskId: input.anchorTaskId } : {}),
      echoReplyIds: [],
    };
    const current = session(sessionId);
    sessions.set(sessionId, { ...current, metadata: { ...current.metadata, [LAST_ACTION_METADATA_KEY]: withLastAction(current.metadata?.[LAST_ACTION_METADATA_KEY], input.actorId ?? OWNER.id, record, record.at) } });
  }

  const undo = (receiptId: string, now: string, actor: Actor = OWNER, sessionId = 'sess-1') =>
    flow.prepare({ session: session(sessionId), actor, now, draft: { kind: 'calendar-create-undo', receiptId } });

  return { flow, session, writes, live, receipts, approveAndExecute, createEvent, recordLastAction, undo };
}

const reason = (step: ConnectorWriteStep): string | undefined => (step.kind === 'refused' ? step.reason : undefined);

describe('undo of an NL-created calendar event (amendment 1 S9, slice 3)', () => {
  it('stores the post-create version on the receipt', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    expect(h.receipts.rows.get(receiptId)?.data).toEqual({ externalRef: EVENT_ID, version: VERSION });
  });

  it('previews the delete with the receipt banner, then deletes exactly that event with If-Match on the post-create version', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    const step = await h.undo(receiptId, at(3));
    expect(step.kind).toBe('preview');
    if (step.kind !== 'preview') return;
    expect(step.preview).toMatchObject({ operation: 'CALENDAR_EVENT_DELETE', receiptSourced: true, before: { id: EVENT_ID, title: 'QA 세션' } });
    expect(step.approval.riskLevel).toBe('CRITICAL');
    expect(step.executionPhrase).toBe('일정 삭제 실행');
    const text = plainTextOf(renderConnectorWriteStep(step));
    expect(text).toContain(CONNECTOR_UNDO_RECEIPT_BANNER);
    expect(text).toContain('방금 Quoky가 추가한 이 일정을 지워서 되돌려요.');
    expect(h.writes.delete).toHaveLength(0);

    const outcome = await h.approveAndExecute(at(4));
    expect(outcome).toMatchObject({ kind: 'outcome', operation: 'CALENDAR_EVENT_DELETE', outcome: { status: 'SENT' } });
    expect(plainTextOf(renderConnectorWriteStep(outcome))).toBe('방금 추가한 일정을 지워서 되돌렸어요. 취소 메일은 보내지 않았어요.');
    expect(h.writes.delete).toEqual([
      { eventId: EVENT_ID, expected: { allDay: false, start: '2026-11-03T17:00:00+09:00', end: '2026-11-03T18:00:00+09:00', version: VERSION } },
    ]);
    expect(h.live.events).toHaveLength(0);
  });

  it('marks the undo anchor so the runtime records an action.undo (undo of an undo is refused)', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    await h.undo(receiptId, at(3));
    const view = await h.flow.find(h.session());
    expect(view?.anchor.undoOf).toEqual({ entryId: 'calendar.create', receiptId });
    await h.approveAndExecute(at(4));
    // After the undo the runtime's record is an action.undo; asking again finds nothing to undo.
    h.recordLastAction({ receiptId: 'delete-receipt', anchorTaskId: view?.taskId, entryId: 'action.undo', at: at(4) });
    expect(reason(await h.undo(receiptId, at(5)))).toBe('undo-nothing');
  });

  it('refuses when the event was edited since it was created (TARGET_CHANGED at preview), and deletes nothing', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    h.live.events = h.live.events.map((event) => ({ ...event, version: '"v-edited"' }));
    expect(reason(await h.undo(receiptId, at(3)))).toBe('undo-event-changed');
    h.live.events = h.live.events.map((event) => ({ ...event, version: VERSION, title: 'QA 세션 (수정)' }));
    expect(reason(await h.undo(receiptId, at(3)))).toBe('undo-event-changed');
    h.live.events = h.live.events.map((event) => ({ ...event, title: 'QA 세션', start: '2026-11-03T10:00:00.000Z', end: '2026-11-03T11:00:00.000Z' }));
    expect(reason(await h.undo(receiptId, at(3)))).toBe('undo-event-changed');
    expect(h.writes.delete).toHaveLength(0);
  });

  it('an edit between the preview and the execution is the writer\'s NOT_SENT TARGET_CHANGED, recorded and never retried', async () => {
    const h = harness({ deleteOutcome: connectorWriteNotSent('TARGET_CHANGED') });
    const { receiptId } = await h.createEvent();
    expect((await h.undo(receiptId, at(3))).kind).toBe('preview');
    const outcome = await h.approveAndExecute(at(4));
    expect(outcome).toMatchObject({ kind: 'outcome', outcome: { status: 'NOT_SENT', reason: 'TARGET_CHANGED' } });
    expect(h.writes.delete).toHaveLength(1);
  });

  it('says the event is already gone when it was deleted elsewhere', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    h.live.events = [];
    expect(reason(await h.undo(receiptId, at(3)))).toBe('undo-event-gone');
    expect(h.writes.delete).toHaveLength(0);
  });

  it('refuses an undo older than 10 minutes, and an undo of an undo', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    expect(reason(await h.undo(receiptId, at(12)))).toBe('undo-nothing');
    h.recordLastAction({ receiptId, entryId: 'action.undo', anchorTaskId: 'x', at: at(2) });
    expect(reason(await h.undo(receiptId, at(3)))).toBe('undo-nothing');
  });

  it('refuses another session, another actor, and a receipt id the lastAction does not name', async () => {
    const h = harness();
    const { receiptId } = await h.createEvent();
    expect(reason(await h.undo(receiptId, at(3), OWNER, 'sess-2'))).toBe('undo-nothing');
    expect(reason(await h.undo(receiptId, at(3), OTHER))).toBe('undo-nothing');
    expect(reason(await h.undo('some-other-receipt', at(3)))).toBe('undo-nothing');
    expect(reason(await h.undo('', at(3)))).toBe('undo-nothing');
    expect(h.writes.delete).toHaveLength(0);
  });

  it('refuses when the write was uncertain, left no receipt (task id fallback) or the receipt has no version', async () => {
    const uncertain = harness();
    const created = await uncertain.createEvent();
    uncertain.recordLastAction({ receiptId: created.receiptId, anchorTaskId: created.anchorTaskId, outcome: 'UNCERTAIN' });
    expect(reason(await uncertain.undo(created.receiptId, at(3)))).toBe('undo-nothing');

    const fallback = harness();
    const second = await fallback.createEvent();
    fallback.recordLastAction({ receiptId: second.anchorTaskId, anchorTaskId: second.anchorTaskId });
    expect(reason(await fallback.undo(second.anchorTaskId, at(3)))).toBe('undo-nothing');

    const unversioned = harness({ createVersion: undefined });
    const third = await unversioned.createEvent();
    expect(unversioned.receipts.rows.get(third.receiptId)?.data.version).toBeUndefined();
    expect(reason(await unversioned.undo(third.receiptId, at(3)))).toBe('undo-nothing');
  });

  it('is off (writes-off) when no calendar writer is bound', async () => {
    const flow = new StatelessConnectorWriteFlow({
      writers: {},
      receipts: new MemoryReceipts(),
      approvals: {} as never,
      store: {} as never,
      timeZone: SEOUL,
      newId: () => 'id',
    });
    const draft = { kind: 'calendar-create-undo', receiptId: 'r1' } as const;
    expect(flow.supports(draft)).toBe(false);
    expect(await flow.prepare({ session: {} as Session, actor: OWNER, now: at(3), draft })).toEqual({ kind: 'writes-off' });
  });
});
